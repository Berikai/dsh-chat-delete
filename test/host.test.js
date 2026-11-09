/**
 * Host-half tests: request validation, the auth fence, the safety refusals,
 * and one real deletion against a temporary Session root.
 */
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../index.js'

const SESSION_ID = 'session-test-0001'

/** Answer a path's existence without throwing. */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Build the minimal Host context the plugin touches. */
function makeContext({ root, logPath, agent, activity = [], unauthorized = false, removed = [] }) {
  let handler
  const calls = { unpinned: [], unarchived: [] }
  const persistence = {
    root,
    async stat(sessionId) {
      if (sessionId !== SESSION_ID) return undefined
      return {
        header: { id: SESSION_ID, cwd: '/project' },
        location: logPath === undefined ? undefined : { kind: 'jsonl', path: logPath },
      }
    },
    locate(header) {
      return { kind: 'jsonl', path: join(root, '--project--', header.id, 'session.v4.jsonl.zstd') }
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(callback) {
      return callback()
    },
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'agents') return { get: () => agent }
      if (name === 'workspaceRegistry') {
        return {
          async unpinSession(id) {
            calls.unpinned.push(id)
          },
          async unarchiveSession(id) {
            calls.unarchived.push(id)
          },
        }
      }
      return undefined
    },
    async waterfall() {
      return activity
    },
    emit(name, id) {
      if (name === 'api-session/removed') removed.push(id)
    },
    webServer: {
      register(route) {
        handler = route.handler
        return () => {}
      },
    },
    connection: {
      requestRejection() {
        return unauthorized ? 401 : undefined
      },
    },
  }
  apply(ctx)
  return { handler, calls }
}

/** One HTTP request whose body is JSON or raw text. */
function makeRequest(body, { method = 'POST', contentType = 'application/json' } = {}) {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  req.method = method
  req.headers = contentType === undefined ? {} : { 'content-type': contentType }
  req.resume = () => {}
  return req
}

/** One response recorder. */
function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      this.body += chunk ?? ''
      this.headersSent = true
    },
    destroy() {
      this.statusCode = -1
    },
  }
}

test('deletes an idle Session directory and announces the removal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chat-delete-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, '--project--', SESSION_ID)
  const logPath = join(directory, 'session.v4.jsonl.zstd')
  await mkdir(directory, { recursive: true })
  await writeFile(logPath, 'log')

  const removed = []
  const { handler, calls } = makeContext({ root, logPath, removed })
  const res = makeResponse()
  await handler(makeRequest({ sessionId: SESSION_ID }), res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true })
  assert.equal(await exists(directory), false)
  assert.deepEqual(removed, [SESSION_ID])
  assert.deepEqual(calls.unpinned, [SESSION_ID])
  assert.deepEqual(calls.unarchived, [SESSION_ID])
})

test('refuses a directory outside the persistence root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chat-delete-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'chat-delete-outside-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  const directory = join(outside, SESSION_ID)
  await mkdir(directory, { recursive: true })
  const logPath = join(directory, 'session.v4.jsonl.zstd')
  await writeFile(logPath, 'log')

  const { handler } = makeContext({ root, logPath })
  const res = makeResponse()
  await handler(makeRequest({ sessionId: SESSION_ID }), res)

  assert.equal(res.statusCode, 500)
  assert.equal(JSON.parse(res.body).code, 'location-rejected')
  assert.equal(await exists(logPath), true)
})

test('refuses a running Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-delete-root-'))
  const { handler } = makeContext({ root, logPath: join(root, 'x', SESSION_ID, 'log'), agent: { status: 'running' } })
  const res = makeResponse()
  try {
    await handler(makeRequest({ sessionId: SESSION_ID }), res)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  assert.equal(res.statusCode, 409)
  assert.equal(JSON.parse(res.body).code, 'session-running')
})

test('refuses a Session with active scheduled or background work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-delete-root-'))
  const { handler } = makeContext({
    root,
    logPath: join(root, 'x', SESSION_ID, 'log'),
    activity: [{ kind: 'schedule' }],
  })
  const res = makeResponse()
  try {
    await handler(makeRequest({ sessionId: SESSION_ID }), res)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  assert.equal(res.statusCode, 409)
  assert.equal(JSON.parse(res.body).code, 'session-active')
})

test('rejects an invalid session id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-delete-root-'))
  const { handler } = makeContext({ root, logPath: join(root, 'x', SESSION_ID, 'log') })
  const res = makeResponse()
  try {
    await handler(makeRequest({ sessionId: 5 }), res)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).code, 'invalid-session-id')
})

test('honors the connection auth fence and the method check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-delete-root-'))
  const { handler } = makeContext({ root, logPath: join(root, 'x', SESSION_ID, 'log'), unauthorized: true })
  try {
    const rejected = makeResponse()
    await handler(makeRequest({ sessionId: SESSION_ID }), rejected)
    assert.equal(rejected.statusCode, 401)
    assert.equal(rejected.body, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const { handler: authorized } = makeContext({ root, logPath: join(root, 'x', SESSION_ID, 'log') })
  const wrongMethod = makeResponse()
  await authorized(makeRequest({}, { method: 'GET' }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')
})

test('returns not-found for an unknown Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-delete-root-'))
  const { handler } = makeContext({ root, logPath: join(root, 'x', SESSION_ID, 'log') })
  const res = makeResponse()
  try {
    await handler(makeRequest({ sessionId: 'session-unknown' }), res)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  assert.equal(res.statusCode, 404)
  assert.equal(JSON.parse(res.body).code, 'session-not-found')
})
