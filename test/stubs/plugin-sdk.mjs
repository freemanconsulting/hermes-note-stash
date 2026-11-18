/** Minimal `@hermes/plugin-sdk` stub: only what plugin.js touches at load. */

export const atom = initial => {
  let value = initial
  const listeners = new Set()

  return {
    get: () => value,
    listen: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    set: next => {
      value = next

      for (const listener of listeners) {
        listener(value)
      }
    },
    subscribe: listener => {
      listeners.add(listener)
      listener(value)

      return () => listeners.delete(listener)
    }
  }
}

export const computed = fn => {
  const store = atom(fn())

  return store
}

export const host = {
  composer: {
    focus: () => {},
    insertText: async () => false,
    submit: () => false
  },
  notify: () => {},
  profileRoutes: async () => [],
  retainProfile: async () => () => {},
  requestProfile: async () => ({ path: '' }),
  listPersistedSessions: async () => ({ sessions: [] }),
  state: {
    busyBySession: atom({}),
    focusedSessionId: atom(null),
    focusedSessionProfile: atom(''),
    focusedStoredSessionId: atom(null),
    profile: atom('default')
  },
  request: async () => ({ sessions: [] })
}

export const haptic = () => {}
export const cn = (...parts) => parts.filter(Boolean).join(' ')
export const relativeTime = () => 'now'
export const usePluginI18n = () => key => key
export const useValue = store => store.get()
// Only icons verified to exist in Hermes Desktop's lib/icons.ts at the
// requires_hermes floor; add a name here only after checking it exists there.
export const icons = {
  CornerDownLeft: () => null,
  FileImage: () => null,
  ImageIcon: () => null,
  NotebookTabs: () => null,
  PencilLine: () => null,
  Plus: () => null,
  Send: () => null,
  Trash2: () => null,
  X: () => null
}

export const KEYBINDS_AREA = 'keybinds'
export const PALETTE_AREA = 'palette'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }

export const Badge = () => null
export const Button = () => null
export const ConfirmDialog = () => null
export const CopyButton = () => null
export const Dialog = () => null
export const DialogContent = () => null
export const DialogDescription = () => null
export const DialogFooter = () => null
export const DialogHeader = () => null
export const DialogTitle = () => null
export const EmptyState = () => null
export const Input = () => null
export const Kbd = () => null
export const RowButton = () => null
export const SearchField = () => null
export const SegmentedControl = () => null
export const Textarea = () => null
export const Tip = () => null
