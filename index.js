/**
 * dsh-chat-delete — Host half.
 *
 * Owns the one operation that permanently removes a single chat: deleting the
 * Session's own log directory under the configured Session persistence root,
 * dropping its pin/archive membership, and telling connected browsers that the
 * Session is gone. The browser half (`client.js`) adds the hover button, the
 * "..." menu action and the confirmation dialog, and calls the endpoint
 * registered here.
 *
 * A Session with running work or any active schedule/background job is refused
 * (`session-running` / `session-active`): its next write would recreate the log.
 * A Session that is merely loaded in memory is safe to remove — its files are
 * complete on disk and the page drops it from the catalog on the removal event.
 *
 * @module dsh-chat-delete
 */

import { rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'

/** Browser-relative endpoint the client posts one deletion request to. */
const DELETE_PATH = '/chat-delete/delete'

/** Request bodies are one tiny JSON object; anything larger is hostile. */
const MAX_BODY_BYTES = 16 * 1024

/** Stop a client-visible failure with a stable code and HTTP status. */
export class ChatDeleteError extends Error {
  /**
   * @param {number} status HTTP status to answer with.
   * @param {string} code Stable machine code the client maps to copy.
   * @param {string} message Developer-facing detail.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'ChatDeleteError'
    this.status = status
    this.code = code
  }
}

/** @param {unknown} value Candidate request body. @returns {string} the validated Session id. */
export function sessionIdOf(value) {
  if (value === null || typeof value !== 'object') {
    throw new ChatDeleteError(400, 'invalid-request', 'Request body must be a JSON object.')
  }
  const sessionId = /** @type {{ sessionId?: unknown }} */ (value).sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) {
    throw new ChatDeleteError(400, 'invalid-session-id', 'Request must carry a non-empty sessionId string.')
  }
  return sessionId
}

/** @param {import('node:http').ServerResponse} res Response to finish. @param {number} status Status code. @param {unknown} payload JSON payload. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** @param {import('node:http').ServerResponse} res Response to finish. @param {string} allow Supported method. */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * Collect a bounded request body as UTF-8 text.
 * @param {import('node:http').IncomingMessage} req Incoming request.
 * @returns {Promise<string | null>} body text, or null past the ceiling.
 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Resolve the directory a Session owns, refusing any path outside the
 * persistence root (or a directory that is not named after the Session).
 * @param {object} persistence Session persistence service.
 * @param {object} snapshot Result of `persistence.stat()`.
 * @param {string} sessionId Target Session id.
 * @returns {string} Absolute Session directory to remove.
 */
export function sessionDirectoryOf(persistence, snapshot, sessionId) {
  let logPath = typeof snapshot.location?.path === 'string' ? snapshot.location.path : undefined
  if (logPath === undefined && typeof persistence.locate === 'function') {
    const located = persistence.locate(snapshot.header ?? { id: sessionId, cwd: undefined })
    if (typeof located?.path === 'string') logPath = located.path
  }
  if (logPath === undefined) {
    throw new ChatDeleteError(500, 'location-unavailable', 'Session persistence did not report a log path.')
  }

  const directory = dirname(logPath)
  const root = typeof persistence.root === 'string' ? persistence.root : undefined
  if (root !== undefined) {
    const inside = relative(root, directory)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) {
      throw new ChatDeleteError(500, 'location-rejected', `Refusing to delete outside the Session root: ${directory}`)
    }
  } else if (basename(directory) !== sessionId && !basename(directory).includes(sessionId)) {
    throw new ChatDeleteError(500, 'location-rejected', `Refusing to delete an unverified Session directory: ${directory}`)
  }
  return directory
}

/**
 * Delete one idle, persisted Session.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {string} sessionId Target Session.
 */
async function deleteSession(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new ChatDeleteError(503, 'unavailable', 'Session persistence is not mounted.')
  }

  const agent = ctx.get('agents')?.get(sessionId)
  if (agent?.status === 'running') {
    throw new ChatDeleteError(409, 'session-running', 'This chat is running. Stop it before deleting it.')
  }

  // The same activity check the shipped archive flow uses: a turn, subagents,
  // background jobs or scheduled reminders would keep writing to the log.
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  if (activity.length > 0) {
    throw new ChatDeleteError(409, 'session-active', 'This chat still has work in progress. Stop it before deleting it.')
  }

  let snapshot
  try {
    snapshot = await persistence.stat(sessionId)
  } catch (error) {
    throw new ChatDeleteError(500, 'stat-failed', `Could not inspect the chat: ${String(error)}`)
  }
  if (snapshot === undefined) throw new ChatDeleteError(404, 'session-not-found', 'This chat no longer exists.')

  const directory = sessionDirectoryOf(persistence, snapshot, sessionId)

  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 2 })
  } catch (error) {
    throw new ChatDeleteError(500, 'delete-failed', `Could not delete the chat files: ${String(error)}`)
  }

  // Membership cleanup is best-effort: removing an id cannot introduce an
  // unknown one, so both verbs resolve for a Session that is already gone.
  const registry = ctx.get('workspaceRegistry')
  try {
    await registry?.unpinSession(sessionId)
    await registry?.unarchiveSession(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`chat-delete: deleted '${sessionId}' but its workspace membership could not be cleaned: ${String(error)}`)
  }

  // The connected page drops the row from its catalog on this forwarded event.
  ctx.emit('api-session/removed', sessionId)

  ctx.logger?.info?.(`chat-delete: removed session '${sessionId}' (${directory})`)
}

/** @param {unknown} ctx Candidate Host context. @returns {object | undefined} the connection service. */
function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/**
 * Handle one authenticated deletion request.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {import('node:http').IncomingMessage} req Incoming request.
 * @param {import('node:http').ServerResponse} res Response to finish.
 */
async function handleRequest(ctx, req, res) {
  const rejection = connectionOf(ctx)?.requestRejection?.(req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return
  }
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
    return
  }

  let body
  try {
    const text = await readBoundedBody(req)
    if (text === null) throw new ChatDeleteError(413, 'body-too-large', 'Request body is too large.')
    body = JSON.parse(text)
  } catch (error) {
    if (error instanceof ChatDeleteError) {
      sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
      return
    }
    sendJson(res, 400, { ok: false, code: 'invalid-json', message: 'Request body is not valid JSON.' })
    return
  }

  try {
    await deleteSession(ctx, sessionIdOf(body))
    sendJson(res, 200, { ok: true })
  } catch (error) {
    if (error instanceof ChatDeleteError) {
      sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
      return
    }
    ctx.logger?.warn?.(`chat-delete: deletion failed: ${String(error)}`)
    sendJson(res, 500, { ok: false, code: 'internal', message: 'The chat could not be deleted.' })
  }
}

export const name = 'dsh-chat-delete'

export const inject = ['webServer', 'connection']

/**
 * Register the deletion endpoint.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DELETE_PATH,
        handler: async (req, res) => {
          try {
            await handleRequest(ctx, req, res)
          } catch (error) {
            ctx.logger?.warn?.(`chat-delete: request failed: ${String(error)}`)
            if (!res.headersSent) {
              try {
                sendJson(res, 500, { ok: false, code: 'internal', message: 'The request could not be completed.' })
              } catch {}
            } else res.destroy()
          }
        },
      }),
    `chat-delete: POST ${DELETE_PATH}`,
  )
}
