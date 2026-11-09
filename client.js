/**
 * dsh-chat-delete — browser half.
 *
 * Adds a trash button to each Session row (the same hover strip that already
 * holds Pin and Archive), a "Delete chat" item in the row's "..." menu for
 * touch devices, and one frame-wide confirmation dialog. Confirming posts to
 * the Host endpoint registered by `index.js`.
 *
 * The blank draft row has nothing to delete and hides the action. A chat that
 * is open in a view or still running is refused with a specific reason, shown
 * inside the dialog instead of closing it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'chat-delete'
    const DELETE_ROUTE = 'chat-delete/delete'

    const EN = {
      'action.delete': 'Delete chat',
      'action.deleteFor': 'Delete chat “{title}”',
      'menu.delete': 'Delete chat',
      'confirm.title': 'Delete this chat?',
      'confirm.desc':
        '“{title}” and its messages will be permanently deleted from this computer. This cannot be undone.',
      'confirm.cancel': 'Cancel',
      'confirm.delete': 'Delete',
      'confirm.pending': 'Deleting…',
      'unnamed': 'Untitled',
      'error.open': 'This chat is open. Close it, then delete it.',
      'error.running': 'This chat is running. Stop it, then delete it.',
      'error.active': 'This chat still has work in progress. Stop it, then delete it.',
      'error.notFound': 'This chat no longer exists.',
      'error.generic': 'The chat could not be deleted. Try again.',
      'close': 'Close',
    }
    const ZH = {
      'action.delete': '删除对话',
      'action.deleteFor': '删除对话“{title}”',
      'menu.delete': '删除对话',
      'confirm.title': '删除此对话？',
      'confirm.desc': '“{title}”及其消息将从这台电脑上永久删除，且无法恢复。',
      'confirm.cancel': '取消',
      'confirm.delete': '删除',
      'confirm.pending': '正在删除…',
      'unnamed': '未命名',
      'error.open': '此对话正在打开。请先关闭它，再删除。',
      'error.running': '此对话正在运行。请先停止它，再删除。',
      'error.active': '此对话仍有进行中的任务。请先停止它，再删除。',
      'error.notFound': '此对话已不存在。',
      'error.generic': '无法删除此对话，请重试。',
      'close': '关闭',
    }

    const CSS = `
.chatDelete-iconButton {
  border-radius: var(--dsw-radius-xs, 4px);
  cursor: pointer;
  width: 24px;
  height: 24px;
  color: var(--dsw-alias-label-tertiary);
  background: none;
  border: none;
  flex: none;
  justify-content: center;
  align-items: center;
  margin: -4px;
  padding: 0;
  display: inline-flex;
}
.chatDelete-iconButton:focus-visible { outline-offset: -2px; outline: 2px solid var(--dsw-alias-brand-primary); }
@media (hover: hover) {
  .chatDelete-iconButton:hover { color: var(--dsw-alias-state-error-primary); }
}
.chatDelete-root {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.34);
  pointer-events: auto;
}
.chatDelete-card {
  box-sizing: border-box;
  width: min(420px, 100%);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.32);
  font-family: inherit;
}
.chatDelete-title {
  margin: 0;
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
}
.chatDelete-desc {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.chatDelete-error {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.chatDelete-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.chatDelete-button {
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.chatDelete-button:hover { background: var(--dsw-alias-bg-layer-2); }
.chatDelete-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.chatDelete-button[data-kind='danger'] {
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-primary);
  color: #fff;
}
.chatDelete-button[data-kind='danger']:hover { filter: brightness(1.08); }
.chatDelete-button:disabled { cursor: default; opacity: 0.6; }
`

    /** Owning Client context, installed by `apply` for read-only catalog checks. */
    let clientCtx = null

    /** Latest pending deletion request; null when the dialog is closed. */
    let dialog = null
    const listeners = new Set()

    /** @param {object|null} next Complete new dialog state. */
    function setDialog(next) {
      dialog = next
      for (const notify of listeners) notify()
    }

    /** @param {object} patch Fields to merge into the open dialog. */
    function updateDialog(patch) {
      if (dialog === null) return
      setDialog({ ...dialog, ...patch })
    }

    /** @param {{ sessionId: string, displayTitle?: string }} target Captured row. */
    function requestDelete(target) {
      setDialog({
        sessionId: target.sessionId,
        displayTitle: target.displayTitle ?? '',
        busy: false,
        error: null,
      })
    }

    /** Subscribe one component to the module-level dialog state. */
    function useDialog() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => listeners.delete(force)
      }, [])
      return dialog
    }

    /** @param {{ size?: number }} props Icon size. */
    function TrashIcon({ size = 14 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', pointerEvents: 'none' },
        },
        h('path', { d: 'M2.5 4.5h11' }),
        h('path', { d: 'M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3' }),
        h('path', { d: 'M4 4.5l.6 8.1c0 .5.4.9.9.9h5c.5 0 .9-.4.9-.9L12 4.5' }),
        h('path', { d: 'M6.5 7v4M9.5 7v4' }),
      )
    }

    /**
     * One hover button in the Session row's action strip.
     * @param {object} props Slot props (owner `sessionId`/`displayTitle`, locale `t`).
     */
    function DeleteRowAction({ sessionId, displayTitle, t, useSessions }) {
      const summary = useSessions((state) => state)?.byId?.[sessionId]
      // The blank New Session draft has no log yet, so there is nothing to delete.
      if (summary?.blank === true) return null
      const label = t('action.deleteFor', { title: displayTitle || t('unnamed') })
      return h(
        'button',
        {
          type: 'button',
          className: 'chatDelete-iconButton',
          title: label,
          'aria-label': label,
          onClick: () => requestDelete({ sessionId, displayTitle }),
        },
        h(TrashIcon, { size: 14 }),
      )
    }

    /**
     * The frame-wide confirmation dialog.
     * @param {object} props Slot props (locale `t`).
     */
    function DeleteDialog({ t }) {
      const current = useDialog()
      const confirmRef = React.useRef(null)
      const open = current !== null

      React.useEffect(() => {
        if (!open) return
        const timer = setTimeout(() => confirmRef.current?.focus(), 0)
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !dialog?.busy) {
            event.preventDefault()
            setDialog(null)
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      if (current === null) return null

      const title = current.displayTitle || t('unnamed')

      const confirm = async () => {
        if (current.busy) return
        const summary = clientCtx?.get?.('sessions')?.list?.getSnapshot?.().byId?.[current.sessionId]
        if (summary !== undefined && Object.keys(summary.retainedBy ?? {}).length > 0) {
          updateDialog({ error: t('error.open') })
          return
        }
        updateDialog({ busy: true, error: null })
        try {
          const response = await fetch(DELETE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: current.sessionId }),
          })
          let payload = null
          try {
            payload = await response.json()
          } catch {}
          if (response.ok && payload?.ok === true) {
            setDialog(null)
            return
          }
          const code = payload?.code
          updateDialog({
            busy: false,
            error:
              code === 'session-open'
                ? t('error.open')
                : code === 'session-running'
                  ? t('error.running')
                  : code === 'session-active'
                    ? t('error.active')
                    : code === 'session-not-found'
                    ? t('error.notFound')
                    : t('error.generic'),
          })
        } catch {
          updateDialog({ busy: false, error: t('error.generic') })
        }
      }

      return h(
        'div',
        {
          className: 'chatDelete-root',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !current.busy) setDialog(null)
          },
        },
        h(
          'div',
          {
            className: 'chatDelete-card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'chatDelete-title',
            'aria-describedby': 'chatDelete-desc',
          },
          h('h2', { className: 'chatDelete-title', id: 'chatDelete-title' }, t('confirm.title')),
          h('p', { className: 'chatDelete-desc', id: 'chatDelete-desc' }, t('confirm.desc', { title })),
          current.error !== null ? h('p', { className: 'chatDelete-error', role: 'alert' }, current.error) : null,
          h(
            'div',
            { className: 'chatDelete-footer' },
            h(
              'button',
              {
                type: 'button',
                className: 'chatDelete-button',
                disabled: current.busy,
                onClick: () => setDialog(null),
              },
              t('confirm.cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'chatDelete-button',
                'data-kind': 'danger',
                disabled: current.busy,
                ref: confirmRef,
                onClick: confirm,
              },
              t(current.busy ? 'confirm.pending' : 'confirm.delete'),
            ),
          ),
        ),
      )
    }

    /** @param {object} props Slot props for the menu icon key. */
    function MenuTrashIcon() {
      return h(TrashIcon, { size: 14 })
    }

    return {
      inject: ['slots', 'locale', 'contextMenus'],
      apply(ctx) {
        clientCtx = ctx
        ctx.effect(() => () => {
          if (clientCtx === ctx) clientCtx = null
        }, 'chat-delete:ctx')
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'chat-delete:dictionaries')

        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = NS
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'chat-delete:styles')

        ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.row.action',
              id: 'chat-delete.delete',
              order: 300,
              locale: NS,
            },
            DeleteRowAction,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'chat-delete.dialog',
              order: 900,
              locale: NS,
            },
            DeleteDialog,
          ),
        )

        ctx.slots.inject('contextMenu.icon', () =>
          ctx.slots.register(
            { name: 'contextMenu.icon', key: 'chat-delete.trash' },
            MenuTrashIcon,
          ),
        )

        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'chat-delete.delete',
              target: 'session',
              order: 700,
              observe: () => [ctx.locale],
              resolve: ({ sessionId, displayTitle }) => {
                const catalog = ctx.get('sessions')?.list?.getSnapshot?.().byId
                if (catalog?.[sessionId]?.blank === true) return []
                const t = ctx.locale.bind(NS)
                return [
                  {
                    id: 'delete',
                    label: t('menu.delete'),
                    icon: { key: 'chat-delete.trash' },
                    failureLabel: t('error.generic'),
                    run: () => requestDelete({ sessionId, displayTitle }),
                  },
                ]
              },
            }),
          'chat-delete:session-menu',
        )
      },
    }
  },
})
