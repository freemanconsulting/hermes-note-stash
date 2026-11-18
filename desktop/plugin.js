/**
 * Note Stash — sticky notes and a code stash for Hermes Desktop.
 *
 * Capture a thought (prose or code) without touching the composer or the
 * session you are in, then send it to the focused session as the next prompt.
 * A note sent to a session that is mid-turn is QUEUED instead of injected: the
 * app's busy_input_mode is `steer`, so a submit while busy would land inside the
 * running turn. The queue waits for that session's busy flag to flip to idle
 * (plus a short settle delay), then submits one note per idle transition.
 *
 * Plain ESM, loaded uncompiled: UI is `jsx()` calls, not JSX syntax. Only
 * `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime` resolve.
 *
 * Pure logic (note reducers, the send-queue state machine, persistence
 * (de)serialization, title derivation) is exported as named functions taking
 * injected dependencies, so `test/` can exercise it without the app.
 */

import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Kbd,
  KEYBINDS_AREA,
  PALETTE_AREA,
  RowButton,
  SearchField,
  SegmentedControl,
  STATUSBAR_AREAS,
  Textarea,
  Tip,
  atom,
  cn,
  haptic,
  host,
  icons,
  relativeTime,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'note-stash'
const NOTES_FILE = 'notes.json'
const NOTES_VERSION = 1
const WRITE_DEBOUNCE_MS = 300
const SEND_SETTLE_MS = 750
const WAIT_RETRY_MS = 3000
const TITLE_LENGTH = 72
const LABEL_TITLE_LENGTH = 32
const KEYBIND_ID = 'note-stash.new-note'

/** `Send to "<title>"`, title truncated; no usable title → `Send to this chat`.
 *  The raw session id is never rendered. */
export function sendLabelFor(title) {
  const text = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''

  if (!text) {
    return 'Send to this chat'
  }

  const shown = text.length > LABEL_TITLE_LENGTH ? `${text.slice(0, LABEL_TITLE_LENGTH - 1)}…` : text

  return `Send to "${shown}"`
}

/** Title change from a gateway `session.info` event — the ONLY way a new chat's
 *  generated title reaches the Send label before the next poll: the gateway
 *  emits `session.info` with the title whenever it changes (provisional title
 *  from the first prompt, then the generated one a few seconds later).
 *  `{ profile, id, title }`, or null when the event carries no usable title/id.
 *  `fallbackProfile` is passed in so this stays pure (no `host` read). */
export function titleUpdateFromEvent(ev, fallbackProfile = '') {
  if (!ev || typeof ev !== 'object') {
    return null
  }

  const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {}
  const raw = payload.title ?? ev.title
  const title = typeof raw === 'string' ? raw.trim() : ''

  if (!title) {
    return null
  }

  const rawId = payload.stored_session_id ?? ev.session_id
  const id = typeof rawId === 'string' ? rawId.trim() : ''

  if (!id) {
    return null
  }

  const rawProfile = ev.profile ?? payload.profile ?? fallbackProfile
  const profile = String(rawProfile || '') || 'default'

  return { id, profile, title }
}

/** Title for the focused session from `listPersistedSessions` rows: the first
 *  row with a non-empty title whose id (or `_lineage_root_id`, the durable id
 *  that survives reloads) is one of `ids`. '' when no row matches — the caller
 *  then falls back to `Send to this chat`. */
export function titleFromRows(rows, ids) {
  if (!Array.isArray(rows) || !Array.isArray(ids)) {
    return ''
  }

  const wanted = new Set()

  for (const id of ids) {
    const trimmed = typeof id === 'string' ? id.trim() : ''

    if (trimmed) {
      wanted.add(trimmed)
    }
  }

  if (wanted.size === 0) {
    return ''
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue
    }

    const keys = [row.id, row._lineage_root_id].filter(
      key => typeof key === 'string' && key.trim()
    )

    if (!keys.some(key => wanted.has(key.trim()))) {
      continue
    }

    const title = typeof row.title === 'string' ? row.title.trim() : ''

    if (title) {
      return title
    }
  }

  return ''
}

/** The platform string for the save hint. `navigator` is absent in tests and
 *  SSR, so this never assumes a browser. */
export function detectPlatform() {
  const nav = globalThis.navigator

  if (!nav) {
    return ''
  }

  return nav.userAgentData?.platform || nav.platform || nav.userAgent || ''
}

/** Platform-aware save hint: ⌘↩ on macOS, Ctrl+Enter elsewhere. */
export function saveHintFor(platform) {
  return /mac|iphone|ipad|ipod/i.test(String(platform || '')) ? '⌘↩ to save' : 'Ctrl+Enter to save'
}

// ── Pure logic ──────────────────────────────────────────────────────────────

let noteSequence = 0

/** A note id. Injectable in tests through `createNote({ id })`. */
export function makeNoteId(now = Date.now()) {
  noteSequence += 1
  const uuid = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${now.toString(36)}-${noteSequence}`

  return `note-${uuid}`
}

/** Title for display: the title, else the first non-empty body line, capped. */
export function deriveTitle(note, fallback = 'Untitled note') {
  const title = typeof note?.title === 'string' ? note.title.trim() : ''

  if (title) {
    return title
  }

  const body = typeof note?.body === 'string' ? note.body : ''
  const first = body.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? ''
  const flat = first.replace(/\s+/g, ' ').trim()

  if (!flat) {
    return fallback
  }

  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat
}

/**
 * Body text for the row's preview line. For a TITLED note that is the whole
 * body. For an UNTITLED note `deriveTitle()` already shows the first non-empty
 * line, so the preview starts at the SECOND non-empty line — otherwise the row
 * prints the same sentence twice. No further line → '' (render no preview).
 */
export function previewFor(note) {
  const body = typeof note?.body === 'string' ? note.body : ''
  const hasTitle = Boolean(typeof note?.title === 'string' && note.title.trim())
  const lines = body.split('\n').map(line => line.trim()).filter(line => line.length > 0)

  return (hasTitle ? lines : lines.slice(1)).join('\n')
}

/** A fresh active note. `now` is injected so tests own the clock. */
export function createNote(input, now = Date.now()) {
  const body = typeof input?.body === 'string' ? input.body : ''
  const title = typeof input?.title === 'string' ? input.title.trim() : ''
  const id = typeof input?.id === 'string' && input.id ? input.id : makeNoteId(now)

  return { body, createdAt: now, id, status: 'active', title, updatedAt: now }
}

/**
 * One persisted note, validated. A `queued` or `waiting` status is reverted to
 * `active`: the send queue is in-memory only, so a note queued or waiting before
 * a restart must not auto-send when the app comes back.
 */
export function normalizeNote(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : ''
  const body = typeof raw.body === 'string' ? raw.body : ''
  const title = typeof raw.title === 'string' ? raw.title : ''

  if (!id || (!body.trim() && !title.trim())) {
    return null
  }

  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
  const status = raw.status === 'sent' ? 'sent' : 'active'
  const note = { body, createdAt, id, status, title, updatedAt }

  if (status === 'sent') {
    if (Number.isFinite(raw.sentAt)) {
      note.sentAt = raw.sentAt
    }

    if (typeof raw.sentTo === 'string' && raw.sentTo) {
      note.sentTo = raw.sentTo
    }
  }

  return note
}

/** `{version, notes:[…]}`, a bare array, or a JSON string → a clean note list. */
export function parseNotesPayload(raw, now = Date.now()) {
  let payload = raw

  if (typeof payload === 'string') {
    if (!payload.trim()) {
      return []
    }

    try {
      payload = JSON.parse(payload)
    } catch {
      return []
    }
  }

  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.notes) ? payload.notes : null

  if (!list) {
    return []
  }

  const notes = []
  const seen = new Set()

  for (const item of list) {
    const note = normalizeNote(item, now)

    if (!note || seen.has(note.id)) {
      continue
    }

    seen.add(note.id)
    notes.push(note)
  }

  return notes
}

/** The load entry point: a missing, empty, or malformed file is an empty store. */
export function parseNotesFile(text, now = Date.now()) {
  return parseNotesPayload(text, now)
}

export function serializeNotes(notes) {
  return JSON.stringify({ notes: Array.isArray(notes) ? notes : [], version: NOTES_VERSION }, null, 2)
}

export function appendNote(notes, note) {
  return [note, ...notes]
}

export function updateNote(notes, id, patch, now = Date.now()) {
  return notes.map(note => (note.id === id ? { ...note, ...patch, updatedAt: now } : note))
}

export function removeNote(notes, id) {
  return notes.filter(note => note.id !== id)
}

/**
 * Status transition. `sent` stamps sentAt/sentTo; anything else clears them.
 * `queued` and `waiting` also record the target chat (`profile` + `sid`) so the
 * waiting row can name the chat it will send to; any other status clears them.
 */
export function setNoteStatus(notes, id, status, extra = {}, now = Date.now()) {
  return notes.map(note => {
    if (note.id !== id) {
      return note
    }

    const next = { ...note, status, updatedAt: now }

    if (status === 'sent') {
      next.sentAt = Number.isFinite(extra.sentAt) ? extra.sentAt : now

      if (typeof extra.sentTo === 'string' && extra.sentTo) {
        next.sentTo = extra.sentTo
      }
    } else {
      delete next.sentAt
      delete next.sentTo
    }

    if (status === 'queued' || status === 'waiting') {
      if (typeof extra.profile === 'string' && extra.profile) {
        next.profile = extra.profile
      }

      if (typeof extra.sid === 'string' && extra.sid) {
        next.sid = extra.sid
      }
    } else {
      delete next.profile
      delete next.sid
    }

    return next
  })
}

/** Active (including queued) or sent, narrowed by a case-insensitive search. */
export function filterNotes(notes, { filter = 'active', search = '' } = {}) {
  const query = typeof search === 'string' ? search.trim().toLowerCase() : ''

  return notes.filter(note => {
    if (filter === 'sent' ? note.status !== 'sent' : note.status === 'sent') {
      return false
    }

    if (!query) {
      return true
    }

    return `${note.title}\n${note.body}`.toLowerCase().includes(query)
  })
}

/**
 * The send-queue state machine. Per-session FIFO; one note per idle transition.
 *
 * Phases per session:
 *  - `idle`        nothing scheduled; `pump` may arm the settle timer.
 *  - `settling`    the ~750ms delay is armed; a busy flip cancels it.
 *  - `waitingBusy` the target is mid-turn; wait for busy → idle.
 *  - `awaitingTurn` a note was just submitted; the next one waits until this
 *                  turn has been observed busy AND then idle again.
 *  - `waiting`     the submit returned false because the chat was not on screen
 *                  (host.composer.submit is fail-closed); the head note stays
 *                  queued in place and is retried on a focus change, a busy
 *                  change, or a 3 s interval that only runs while one waits.
 *
 * Injected: `submit(sid, body) → boolean`, `isBusy(sid) → boolean`, timers,
 * clock, and `onEvent` (`sent` / `waiting` / `cancelled`). No globals, no host
 * access — the app layer wires those in.
 */
export function createSendQueue({
  submit,
  isBusy,
  setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutFn = handle => globalThis.clearTimeout(handle),
  setIntervalFn = (fn, ms) => globalThis.setInterval(fn, ms),
  clearIntervalFn = handle => globalThis.clearInterval(handle),
  settleMs = SEND_SETTLE_MS,
  waitRetryMs = WAIT_RETRY_MS,
  onEvent = () => {}
}) {
  const sessions = new Map()
  let waitTimer = null

  const record = sid => {
    let entry = sessions.get(sid)

    if (!entry) {
      entry = { items: [], phase: 'idle', sawBusy: false, timer: null }
      sessions.set(sid, entry)
    }

    return entry
  }

  const clearTimer = entry => {
    if (entry.timer !== null) {
      clearTimeoutFn(entry.timer)
      entry.timer = null
    }
  }

  /** One submit attempt. A throw is a false result, never a crash. */
  const submitItem = item => {
    try {
      return submit(item.sid, item.body) === true
    } catch {
      return false
    }
  }

  /**
   * Retry every waiting head whose session is idle. A success is the same
   * bookkeeping as a normal submit: shift the head, arm `awaitingTurn` so the
   * next queued note waits for the next idle transition, and emit `sent` once.
   * A failure stays waiting silently.
   */
  const retryWaiting = onlySid => {
    for (const [sid, entry] of sessions) {
      if (onlySid && sid !== onlySid) {
        continue
      }

      if (entry.phase !== 'waiting' || isBusy(sid)) {
        continue
      }

      const item = entry.items[0]

      if (!item) {
        entry.phase = 'idle'

        continue
      }

      if (!submitItem(item)) {
        continue
      }

      entry.items.shift()
      entry.phase = 'awaitingTurn'
      entry.sawBusy = false
      onEvent({ noteId: item.noteId, profile: item.profile, sid, type: 'sent' })
    }

    syncWaitTimer()
  }

  /** The 3 s retry interval runs ONLY while at least one entry is waiting. */
  const syncWaitTimer = () => {
    let waiting = false

    for (const entry of sessions.values()) {
      if (entry.phase === 'waiting') {
        waiting = true

        break
      }
    }

    if (waiting) {
      if (waitTimer === null) {
        waitTimer = setIntervalFn(() => retryWaiting(), waitRetryMs)
      }

      return
    }

    if (waitTimer !== null) {
      clearIntervalFn(waitTimer)
      waitTimer = null
    }
  }

  const pump = sid => {
    const entry = record(sid)

    if (!entry.items.length) {
      entry.phase = 'idle'

      return
    }

    if (entry.phase === 'settling' || entry.phase === 'awaitingTurn' || entry.phase === 'waiting') {
      return
    }

    if (isBusy(sid)) {
      entry.phase = 'waitingBusy'

      return
    }

    entry.phase = 'settling'
    entry.timer = setTimeoutFn(() => {
      entry.timer = null

      if (entry.phase !== 'settling') {
        return
      }

      entry.phase = 'idle'

      const item = entry.items[0]

      if (!item) {
        return
      }

      // Re-check: the turn may have started inside the settle window.
      if (isBusy(sid)) {
        entry.phase = 'waitingBusy'

        return
      }

      if (!submitItem(item)) {
        // The chat was not on screen: hold the head note in place (later notes
        // stay behind it) and retry when focus or busy changes, or on the tick.
        entry.phase = 'waiting'
        onEvent({ noteId: item.noteId, profile: item.profile, sid, type: 'waiting' })
        syncWaitTimer()

        return
      }

      entry.items.shift()
      entry.phase = 'awaitingTurn'
      entry.sawBusy = false
      onEvent({ noteId: item.noteId, profile: item.profile, sid, type: 'sent' })
    }, settleMs)
  }

  const enqueue = (note, sid, profile) => {
    if (!sid || !note || !note.id) {
      return false
    }

    const entry = record(sid)
    entry.items.push({
      body: typeof note.body === 'string' ? note.body : '',
      noteId: note.id,
      profile: typeof profile === 'string' && profile ? profile : 'default',
      sid
    })
    pump(sid)

    return true
  }

  /** Feed the whole `busyBySession` map on every change. */
  const onBusyChange = busy => {
    const bySession = busy && typeof busy === 'object' ? busy : {}

    for (const [sid, entry] of sessions) {
      if (bySession[sid]) {
        entry.sawBusy = true

        if (entry.phase === 'settling') {
          clearTimer(entry)
          entry.phase = 'waitingBusy'
        }

        continue
      }

      if (entry.phase === 'waiting') {
        // A busy change may be the turn ending: retry this session's head.
        retryWaiting(sid)

        continue
      }

      if (entry.phase === 'awaitingTurn') {
        if (!entry.sawBusy) {
          continue
        }

        entry.sawBusy = false
        entry.phase = 'idle'
        pump(sid)

        continue
      }

      if (entry.phase === 'waitingBusy') {
        entry.phase = 'idle'
        pump(sid)
      }
    }
  }

  /** Focus moved: the chat a waiting note targets may now be on screen. */
  const onFocusChange = () => retryWaiting()

  const cancel = noteId => {
    for (const [sid, entry] of sessions) {
      const index = entry.items.findIndex(item => item.noteId === noteId)

      if (index === -1) {
        continue
      }

      entry.items.splice(index, 1)

      if (!entry.items.length) {
        clearTimer(entry)
        entry.phase = 'idle'
      } else if (index === 0 && entry.phase === 'waiting') {
        // The waiting head is gone; the next note is an ordinary queued one.
        entry.phase = 'idle'
        entry.sawBusy = false
        pump(sid)
      }

      onEvent({ noteId, sid, type: 'cancelled' })
      syncWaitTimer()

      return true
    }

    return false
  }

  const pending = sid => sessions.get(sid)?.items.length ?? 0

  const dispose = () => {
    for (const entry of sessions.values()) {
      clearTimer(entry)
    }

    if (waitTimer !== null) {
      clearIntervalFn(waitTimer)
      waitTimer = null
    }

    sessions.clear()
  }

  return { cancel, dispose, enqueue, onBusyChange, onFocusChange, pending }
}

// ── Persistence (ctx.files, else ctx.storage) ──────────────────────────────

/** The pure fallback decision, injectable and testable. Given the last
 *  `ctx.files` result (or a thrown error), says whether persistence should
 *  switch to `ctx.storage` for the rest of the plugin lifetime. A missing file
 *  (`not-found`) is a normal empty store — never a fallback. */
export function decidePersistenceFallback(result) {
  if (!result || typeof result !== 'object') {
    return { fallback: true, error: 'invalid-result' }
  }

  if (result.ok === true) {
    return { fallback: false, error: '' }
  }

  const error = typeof result.error === 'string' && result.error ? result.error : 'io-error'

  if (error === 'not-found') {
    return { fallback: false, error: '' }
  }

  return { fallback: true, error }
}

export function createPersistence(ctx, t) {
  const files = ctx.files
  const hasFiles = Boolean(files && typeof files.readText === 'function' && typeof files.writeText === 'function')
  const folder = files?.dataFolder ?? 'data'
  let pending = null
  let timer = null
  let useFiles = hasFiles
  let warned = false

  const warnOnce = error => {
    if (warned) {
      return
    }

    warned = true
    host.notify({ kind: 'warning', message: t('storageFallback', error) })
  }

  /** Flip to ctx.storage for the rest of the plugin lifetime, once, with a toast. */
  const fallBackToStorage = error => {
    useFiles = false
    warnOnce(error)
  }

  const readStorage = () => parseNotesPayload(ctx.storage.get('notes', null))

  const read = async () => {
    if (useFiles) {
      let result = null

      try {
        result = await files.readText(folder, NOTES_FILE)
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }

      const decision = decidePersistenceFallback(result)

      if (decision.fallback) {
        fallBackToStorage(decision.error)

        return readStorage()
      }

      if (!result || !result.ok) {
        return []
      }

      return parseNotesFile(result.text)
    }

    return readStorage()
  }

  const writeStorage = notes => {
    ctx.storage.set('notes', notes)
    const back = ctx.storage.get('notes', null)

    return Array.isArray(back) && back.length === notes.length
  }

  const write = async notes => {
    if (!useFiles) {
      return writeStorage(notes)
    }

    const text = serializeNotes(notes)
    let result = null

    try {
      result = await files.writeText(folder, NOTES_FILE, text)
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    const decision = decidePersistenceFallback(result)

    if (decision.fallback) {
      fallBackToStorage(decision.error)

      return writeStorage(notes)
    }

    if (!result || !result.ok) {
      host.notify({ kind: 'error', message: t('saveFailed') })

      return false
    }

    // Write then verify: a silent short write must not look like a save.
    let verify = null

    try {
      verify = await files.readText(folder, NOTES_FILE)
    } catch {
      verify = null
    }

    if (!verify || !verify.ok || verify.text !== text) {
      host.notify({ kind: 'error', message: t('saveVerifyFailed') })

      return false
    }

    return true
  }

  const flush = () => {
    if (timer !== null) {
      timer()
      timer = null
    }

    const next = pending
    pending = null

    if (next) {
      void write(next)
    }
  }

  const schedule = notes => {
    pending = notes

    if (timer !== null) {
      return
    }

    timer = ctx.setTimeout(() => {
      timer = null

      const next = pending
      pending = null

      if (next) {
        void write(next)
      }
    }, WRITE_DEBOUNCE_MS)
  }

  return { flush, read, schedule }
}

// ── App layer: atoms + actions ─────────────────────────────────────────────

function createStash(ctx) {
  const t = ctx.i18n.t
  const $notes = atom([])
  const $filter = atom('active')
  const $search = atom('')
  const $capture = atom(false)
  const persistence = createPersistence(ctx, t)

  const queue = createSendQueue({
    submit: (sid, body) => host.composer.submit(sid, body),
    isBusy: sid => Boolean(host.state.busyBySession.get()[sid]),
    setTimeoutFn: (fn, ms) => ctx.setTimeout(fn, ms),
    clearTimeoutFn: handle => handle(),
    setIntervalFn: (fn, ms) => ctx.setInterval(fn, ms),
    clearIntervalFn: stop => stop(),
    onEvent: event => {
      if (event.type === 'sent') {
        $notes.set(setNoteStatus($notes.get(), event.noteId, 'sent', { sentAt: Date.now(), sentTo: event.sid }))
        persistence.schedule($notes.get())

        return
      }

      if (event.type === 'waiting') {
        // In-memory like `queued`: the chat was not on screen at turn end. No
        // error — the queue retries when the chat becomes visible and idle.
        $notes.set(
          setNoteStatus($notes.get(), event.noteId, 'waiting', {
            profile: event.profile,
            sid: event.sid
          })
        )
        persistence.schedule($notes.get())

        return
      }

      if (event.type === 'cancelled') {
        $notes.set(setNoteStatus($notes.get(), event.noteId, 'active'))
        persistence.schedule($notes.get())
      }
    }
  })

  ctx.onDispose(host.state.busyBySession.subscribe(map => queue.onBusyChange(map)))
  // Focus moving is the main way a waiting note's chat becomes on screen.
  ctx.onDispose(host.state.focusedSessionId.subscribe(() => queue.onFocusChange()))
  ctx.onDispose(host.state.focusedStoredSessionId.subscribe(() => queue.onFocusChange()))

  // The gateway emits `session.info` with `payload.title` whenever a chat's
  // title changes — the provisional first-prompt title, then the generated one
  // a few seconds later. Without this listener the label sticks on the
  // provisional title, since the 5 s poll stops as soon as ANY title is known.
  // The poll stays as the fallback for a title that arrives with no event.
  ctx.onEvent('session.info', event => {
    const update = titleUpdateFromEvent(event, host.state.profile.get())

    if (!update) {
      return
    }

    const next = { ...$sessionTitles.get() }

    for (const id of new Set([update.id, event?.payload?.session_id])) {
      const trimmed = typeof id === 'string' ? id.trim() : ''

      if (trimmed) {
        next[`${update.profile}:${trimmed}`] = update.title
      }
    }

    $sessionTitles.set(next)
  })

  const persist = () => persistence.schedule($notes.get())

  const load = async () => {
    let loaded = []

    try {
      loaded = await persistence.read()
    } catch {
      loaded = []
    }

    if (!loaded.length) {
      return
    }

    const current = $notes.get()

    if (!current.length) {
      $notes.set(loaded)

      return
    }

    const known = new Set(current.map(note => note.id))
    $notes.set([...current, ...loaded.filter(note => !known.has(note.id))])
  }

  const dispose = () => {
    queue.dispose()
    persistence.flush()
    // Module-scope render cache: a re-register in the same process must not
    // inherit stale titles.
    $sessionTitles.set({})
  }

  return {
    $capture,
    $filter,
    $notes,
    $search,
    addNote: input => {
      const note = createNote(input)

      if (!note.body.trim() && !note.title.trim()) {
        return null
      }

      $notes.set(appendNote($notes.get(), note))
      persist()

      return note
    },
    cancelQueued: noteId => queue.cancel(noteId),
    closeCapture: () => $capture.set(false),
    dispose,
    edit: (id, patch) => {
      $notes.set(updateNote($notes.get(), id, patch))
      persist()
    },
    load,
    openCapture: () => {
      haptic('tap')
      $capture.set(true)
    },
    // A 5 s title poll for a new chat whose title lands only after its first
    // turn. The interval IS the rate limit; the caller owns the cleanup.
    pollTitles: fn => ctx.setInterval(fn, 5000),
    putInComposer: note => {
      if (!note) {
        return
      }

      const sid = host.state.focusedSessionId.get()

      if (!sid) {
        host.notify({ kind: 'error', message: t('noSession') })

        return
      }

      Promise.resolve(host.composer.insertText(sid, note.body, { mode: 'block' }))
        .then(ok => {
          if (!ok) {
            host.notify({ kind: 'error', message: t('composerFailed') })

            return
          }

          host.composer.focus(sid)
        })
        .catch(() => host.notify({ kind: 'error', message: t('composerFailed') }))
    },
    remove: id => {
      $notes.set(removeNote($notes.get(), id))
      persist()
    },
    restore: id => {
      $notes.set(setNoteStatus($notes.get(), id, 'active'))
      persist()
    },
    send: note => {
      if (!note || note.status === 'sent' || note.status === 'queued' || note.status === 'waiting') {
        return
      }

      // Read the target imperatively at click time — never from a render closure.
      const sid = host.state.focusedSessionId.get()

      if (!sid) {
        host.notify({ kind: 'error', message: t('noSession') })

        return
      }

      // Record the target chat's profile with the queued entry so a waiting row
      // can name it (`${profile}:${sid}` title lookup).
      const targetProfile =
        String(host.state.focusedSessionProfile.get() ?? '') ||
        String(host.state.profile.get() ?? '') ||
        'default'

      if (Boolean(host.state.busyBySession.get()[sid])) {
        if (queue.enqueue(note, sid, targetProfile)) {
          $notes.set(setNoteStatus($notes.get(), note.id, 'queued', { profile: targetProfile, sid }))
          persist()
        }

        return
      }

      const ok = host.composer.submit(sid, note.body)

      if (!ok) {
        host.notify({ kind: 'error', message: t('sendFailed') })

        return
      }

      $notes.set(setNoteStatus($notes.get(), note.id, 'sent', { sentAt: Date.now(), sentTo: sid }))
      persist()
    }
  }
}

// ── Session titles for the Send label ──────────────────────────────────────

/** Focused-session titles keyed by `${profile}:${id}` (see below). */
const $sessionTitles = atom({})

/** Titles for `id` in `profile`, checked under both focused-session ids. */
function lookupSendTitle(titles, profile, storedId, focusedId) {
  for (const id of [storedId, focusedId]) {
    const trimmed = typeof id === 'string' ? id.trim() : ''

    if (trimmed && titles[`${profile}:${trimmed}`]) {
      return titles[`${profile}:${trimmed}`]
    }
  }

  return ''
}

/** Focused-session titles (profile:id → title), always fetched through the
 *  profile-scoped `listPersistedSessions` door. Failures are silent: an empty
 *  cache just means the label reads `Send to this chat`. */
async function fetchSessionTitles() {
  const focusedProfile =
    typeof host.state.focusedSessionProfile.get === 'function'
      ? String(host.state.focusedSessionProfile.get() ?? '')
      : ''
  const primaryProfile =
    typeof host.state.profile.get === 'function' ? String(host.state.profile.get() ?? '') : ''
  const profile = focusedProfile || primaryProfile || 'default'

  try {
    const routes = await host.profileRoutes()
    const route = Array.isArray(routes) ? routes.find(r => r && r.profile === profile) ?? null : null
    const result = await host.listPersistedSessions(route, { profile, limit: 50 })

    const rows = result && Array.isArray(result.sessions) ? result.sessions : []

    const next = { ...$sessionTitles.get() }
    const storedId = host.state.focusedStoredSessionId.get()
    const focusedId = host.state.focusedSessionId.get()
    const title = titleFromRows(rows, [storedId, focusedId])

    // Cache every titled row under the fetched profile, and adopt the focused
    // session's title from the response even if focus moved mid-flight.
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        continue
      }

      const rowTitle = typeof row.title === 'string' ? row.title.trim() : ''

      if (!rowTitle) {
        continue
      }

      for (const key of [row.id, row._lineage_root_id]) {
        if (typeof key === 'string' && key.trim()) {
          next[`${profile}:${key.trim()}`] = rowTitle
        }
      }
    }

    if (title) {
      for (const id of [storedId, focusedId]) {
        const trimmed = typeof id === 'string' ? id.trim() : ''

        if (trimmed) {
          next[`${profile}:${trimmed}`] = title
        }
      }
    }

    $sessionTitles.set(next)
  } catch {
    // The label falls back to `Send to this chat`; never surface the failure.
  }
}

// ── UI ─────────────────────────────────────────────────────────────────────

/** The mounted capture-dialog hosts (pane + chip); only the first renders. */
const $captureHosts = atom([])

function CaptureHost({ stash }) {
  const [token] = useState(() => ({ id: Symbol('note-stash-capture-host') }))

  useEffect(() => {
    $captureHosts.set([...$captureHosts.get(), token])

    return () => $captureHosts.set($captureHosts.get().filter(entry => entry !== token))
  }, [token])

  const hosts = useValue($captureHosts)

  if (hosts[0] !== token) {
    return null
  }

  return jsx(CaptureDialog, { stash })
}

/** Tab inserts two spaces in a code field instead of moving focus. */
function insertTwoSpaces(event) {
  if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
    return false
  }

  event.preventDefault()
  const field = event.currentTarget
  field.setRangeText('  ', field.selectionStart, field.selectionEnd, 'end')

  return true
}

const CODE_FONT = { fontFamily: 'var(--font-mono, monospace)' }

function CaptureDialog({ stash }) {
  const t = usePluginI18n(ID)
  const open = useValue(stash.$capture)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const bodyRef = useRef(null)
  const dirty = Boolean(title.trim() || body.trim())
  const canSave = Boolean(body.trim())

  const close = () => {
    stash.closeCapture()
    setTitle('')
    setBody('')
    setConfirmDiscard(false)
  }

  const requestClose = () => {
    if (dirty) {
      setConfirmDiscard(true)

      return
    }

    close()
  }

  const save = () => {
    if (!canSave) {
      return
    }

    stash.addNote({ body, title })
    haptic('tap')
    close()
  }

  return jsxs('div', {
    children: [
      jsx(Dialog, {
        onOpenChange: next => {
          if (!next) {
            requestClose()
          }
        },
        open,
        children: jsxs(DialogContent, {
          className: 'max-w-xl',
          // Autofocus the body, not the title: the dialog opens for a thought
          // dump and a title is optional. Radix focuses the first tabbable — the
          // title Input — during its own initial-focus pass, which lands before
          // (and overrides) an effect-based focus(), so the request has to go
          // through the Dialog's own hook. DialogContent forwards
          // onOpenAutoFocus to DialogPrimitive.Content (dialog.tsx:180, 234).
          onOpenAutoFocus: event => {
            event.preventDefault()
            bodyRef.current?.focus()
          },
          onKeyDown: event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              save()
            }
          },
          children: [
            jsxs(DialogHeader, {
              children: [
                jsx(DialogTitle, { children: t('captureTitle') }),
                jsx(DialogDescription, { children: t('captureDescription') })
              ]
            }),
            jsx(Input, {
              onChange: event => setTitle(event.target.value),
              placeholder: t('titlePlaceholder'),
              value: title
            }),
            jsx(Textarea, {
              className: 'min-h-[10rem] text-xs leading-relaxed',
              onChange: event => setBody(event.target.value),
              onKeyDown: event => {
                if (insertTwoSpaces(event)) {
                  setBody(event.currentTarget.value)
                }
              },
              placeholder: t('bodyPlaceholder'),
              ref: bodyRef,
              rows: 10,
              style: CODE_FONT,
              value: body
            }),
            jsxs(DialogFooter, {
              className: 'items-center gap-2',
              children: [
                jsx(Kbd, {
                  className: 'me-auto',
                  size: 'sm',
                  variant: 'ghost',
                  children: saveHintFor(detectPlatform())
                }),
                jsx(Button, {
                  onClick: requestClose,
                  type: 'button',
                  variant: 'ghost',
                  children: t('cancel')
                }),
                jsx(Button, { disabled: !canSave, onClick: save, type: 'button', children: t('save') })
              ]
            })
          ]
        })
      }),
      jsx(ConfirmDialog, {
        confirmLabel: t('discard'),
        description: t('discardDescription'),
        destructive: true,
        onClose: () => setConfirmDiscard(false),
        onConfirm: () => {
          setConfirmDiscard(false)
          close()
        },
        open: confirmDiscard,
        title: t('discardTitle')
      })
    ]
  })
}

function SmallAction({ disabled = false, icon: Icon, label, onClick }) {
  return jsx(Tip, {
    label,
    children: jsx(Button, {
      'aria-label': label,
      disabled,
      onClick,
      size: 'icon-xs',
      type: 'button',
      variant: 'ghost',
      children: jsx(Icon, { 'aria-hidden': true, className: 'size-3' })
    })
  })
}

function NoteEditor({ note, onCancel, onSave, t }) {
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)

  const save = () => {
    if (!title.trim() && !body.trim()) {
      onCancel()

      return
    }

    onSave({ body, title })
  }

  return jsxs('div', {
    className: 'grid gap-3',
    children: [
      jsx(Input, {
        onChange: event => setTitle(event.target.value),
        placeholder: t('titlePlaceholder'),
        value: title
      }),
      jsx(Textarea, {
        className: 'min-h-24 text-xs leading-relaxed',
        onChange: event => setBody(event.target.value),
        onKeyDown: event => {
          if (insertTwoSpaces(event)) {
            setBody(event.currentTarget.value)
          }
        },
        placeholder: t('bodyPlaceholder'),
        rows: 6,
        style: CODE_FONT,
        value: body
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Button, { onClick: save, size: 'xs', type: 'button', children: t('save') }),
          jsx(Button, {
            onClick: onCancel,
            size: 'xs',
            type: 'button',
            variant: 'ghost',
            children: t('cancel')
          })
        ]
      })
    ]
  })
}

function NoteRow({ editing, filter, note, onDelete, onToggleEdit, stash, t }) {
  const focused = useValue(host.state.focusedSessionId)
  const titles = useValue($sessionTitles)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const primaryProfile = useValue(host.state.profile)
  const sent = note.status === 'sent'
  const queued = note.status === 'queued'
  const waiting = note.status === 'waiting'
  const title = deriveTitle(note, t('untitled'))
  const preview = previewFor(note)
  const stamp = relativeTime(Number.isFinite(note.updatedAt) ? note.updatedAt : note.createdAt)
  // The Send label resolves against the focused session's owning profile —
  // the same profile fetchSessionTitles lists through listPersistedSessions.
  const titleProfile =
    String(focusedProfile || '') || String(primaryProfile || '') || 'default'
  const sendTitle = lookupSendTitle(titles, titleProfile, host.state.focusedStoredSessionId.get(), focused)
  const sendLabel = focused ? t('sendTo', sendTitle) : t('noSession')
  // A waiting note names the chat it will send to, from the title cache keyed
  // by the profile recorded when it was queued; no cached title → generic line.
  const waitingTitle = waiting ? titles[`${note.profile || titleProfile}:${note.sid}`] || '' : ''

  // Secondary actions stay in the flow (no layout shift) but fade in on row
  // hover or focus-within — tabbing into one reveals the whole cluster, so they
  // remain keyboard-reachable. Send is the one labeled action and stays visible.
  const secondaryClass =
    'flex items-center gap-0.5 opacity-0 transition-opacity group-hover/note:opacity-100 group-focus-within/note:opacity-100'

  return jsxs('div', {
    className: 'group/note row-hover rounded-md px-2 py-1.5',
    children: [
      jsx(RowButton, {
        'aria-expanded': editing,
        className: 'block w-full min-w-0 text-left',
        onClick: onToggleEdit,
        children: jsxs('div', {
          className: 'min-w-0',
          children: [
            jsxs('div', {
              className: 'flex items-baseline gap-2',
              children: [
                jsx('span', {
                  className:
                    'min-w-0 flex-1 truncate text-[0.8125rem] font-medium leading-[1.35] text-(--ui-text-primary)',
                  children: title
                }),
                jsx('span', {
                  className: 'shrink-0 tabular-nums text-[0.625rem] leading-none text-(--ui-text-tertiary)',
                  children: stamp
                })
              ]
            }),
            preview
              ? jsx('div', {
                  className:
                    'mt-1 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[0.625rem] leading-[1.45] text-(--ui-text-quaternary)',
                  children: preview
                })
              : null
          ]
        })
      }),
      queued
        ? jsxs('div', {
            className: 'mt-1 flex min-w-0 flex-wrap items-center gap-1.5',
            children: [
              jsx(Tip, {
                label: t('queuedLine'),
                children: jsx(Badge, { className: 'shrink-0', size: 'xs', variant: 'warn', children: t('statusQueued') })
              }),
              jsx(Button, {
                className: 'shrink-0',
                onClick: () => stash.cancelQueued(note.id),
                size: 'micro',
                type: 'button',
                variant: 'text',
                children: t('cancelQueued')
              })
            ]
          })
        : null,
      waiting
        ? jsxs('div', {
            className: 'mt-1 flex min-w-0 flex-wrap items-center gap-1.5',
            children: [
              jsx(Tip, {
                label: t('waitingTip'),
                children: jsx(Badge, {
                  className: 'shrink-0',
                  size: 'xs',
                  variant: 'outline',
                  children: t('statusWaiting')
                })
              }),
              jsx('span', {
                className: 'min-w-0 break-words text-[0.625rem] leading-[1.45] text-(--ui-text-tertiary)',
                children: t('waitingLine', waitingTitle)
              }),
              jsx(Button, {
                className: 'shrink-0',
                onClick: () => stash.cancelQueued(note.id),
                size: 'micro',
                type: 'button',
                variant: 'text',
                children: t('cancelQueued')
              })
            ]
          })
        : null,
      jsxs('div', {
        className: 'mt-1 flex min-w-0 flex-wrap items-center gap-1',
        children: [
          jsx(Tip, {
            label: sendLabel,
            children: jsx(Button, {
              'aria-label': sendLabel,
              disabled: sent || queued || waiting || !focused,
              onClick: () => stash.send(note),
              size: 'xs',
              type: 'button',
              variant: 'ghost',
              children: jsxs('span', {
                className: 'inline-flex items-center gap-1',
                children: [jsx(icons.Send, { className: 'size-3' }), t('send')]
              })
            })
          }),
          jsxs('div', {
            className: secondaryClass,
            children: [
              jsx(SmallAction, {
                disabled: !focused,
                icon: icons.PencilLine,
                label: t('putInComposer'),
                onClick: () => stash.putInComposer(note)
              }),
              jsx(CopyButton, {
                appearance: 'icon',
                buttonSize: 'icon-xs',
                label: t('copy'),
                text: note.body
              }),
              sent
                ? jsx(SmallAction, {
                    icon: icons.CornerDownLeft,
                    label: t('restore'),
                    onClick: () => stash.restore(note.id)
                  })
                : null,
              jsx(SmallAction, { icon: icons.Trash2, label: t('delete'), onClick: onDelete })
            ]
          }),
          jsxs('span', {
            className: 'ms-auto flex min-w-0 flex-wrap items-center justify-end gap-1',
            children: sent && filter === 'sent'
              ? [
                  jsx(Badge, {
                    className: 'shrink-0',
                    size: 'xs',
                    variant: 'muted',
                    children: t('sentAgo', relativeTime(note.sentAt))
                  })
                ]
              : []
          })
        ]
      }),
      editing
        ? jsx(NoteEditor, {
            note,
            onCancel: onToggleEdit,
            onSave: patch => {
              stash.edit(note.id, patch)
              onToggleEdit()
            },
            t
          })
        : null
    ]
  })
}

function NotePane({ stash }) {
  const t = usePluginI18n(ID)
  const notes = useValue(stash.$notes)
  const filter = useValue(stash.$filter)
  const search = useValue(stash.$search)
  const [editingId, setEditingId] = useState(null)
  const [confirmId, setConfirmId] = useState(null)
  const visible = filterNotes(notes, { filter, search })
  const searching = Boolean(search.trim())
  const activeCount = notes.filter(note => note.status !== 'sent').length
  const sentCount = notes.filter(note => note.status === 'sent').length
  const emptyTitle = searching ? t('emptySearch') : filter === 'sent' ? t('emptySent') : t('emptyActive')
  const emptyDescription = searching
    ? t('emptySearchDesc')
    : filter === 'sent'
      ? t('emptySentDesc')
      : t('emptyActiveDesc')
  const focused = useValue(host.state.focusedSessionId)
  const focusedStored = useValue(host.state.focusedStoredSessionId)
  const titles = useValue($sessionTitles)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const primaryProfile = useValue(host.state.profile)
  const titleProfile = String(focusedProfile || '') || String(primaryProfile || '') || 'default'
  const titleKnown = Boolean(lookupSendTitle(titles, titleProfile, focusedStored, focused))

  // Fetch session titles on mount and whenever the focused session changes.
  useEffect(() => {
    void fetchSessionTitles()
  }, [focused, focusedStored])

  // A NEW chat gets its title only after its first turn completes, with no
  // focus change to re-render the Send label. Until a title resolves, poll;
  // the cleanup stops the poll as soon as the title is known or focus moves.
  useEffect(() => {
    if (!focused || titleKnown) {
      return
    }

    void fetchSessionTitles()

    return stash.pollTitles(() => void fetchSessionTitles())
  }, [focused, titleKnown])

  return jsxs('div', {
    className: 'flex h-full min-w-0 flex-col text-(--ui-text-secondary)',
    children: [
      jsxs('div', {
        className: 'flex h-7 shrink-0 items-center gap-2 px-2.5',
        children: [
          jsx('div', {
            className: 'min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-(--ui-text-primary)',
            children: t('paneTitle')
          }),
          jsx(Tip, {
            label: t('newNote'),
            children: jsx(Button, {
              onClick: () => stash.openCapture(),
              size: 'xs',
              type: 'button',
              variant: 'secondary',
              children: jsxs('span', {
                className: 'inline-flex items-center gap-1',
                children: [jsx(icons.Plus, { className: 'size-3' }), t('new')]
              })
            })
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2 px-2.5 pb-1.5',
        children: [
          jsx(SegmentedControl, {
            onChange: value => stash.$filter.set(value),
            options: [
              { id: 'active', label: t('filterActive', activeCount) },
              { id: 'sent', label: t('filterSent', sentCount) }
            ],
            sizing: 'content',
            value: filter
          }),
          jsx(SearchField, {
            containerClassName: 'min-w-32 flex-1',
            onChange: value => stash.$search.set(value),
            placeholder: t('search'),
            value: search
          })
        ]
      }),
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto px-1 py-1',
        children: visible.length
          ? jsx('div', {
              className: 'grid gap-0.5',
              children: visible.map(note =>
                jsx(NoteRow, {
                  editing: editingId === note.id,
                  filter,
                  key: note.id,
                  note,
                  onDelete: () => setConfirmId(note.id),
                  onToggleEdit: () => setEditingId(editingId === note.id ? null : note.id),
                  stash,
                  t
                })
              )
            })
          : jsx(EmptyState, { className: 'min-h-48', description: emptyDescription, title: emptyTitle })
      }),
      jsx(ConfirmDialog, {
        confirmLabel: t('delete'),
        description: t('deleteDescription'),
        destructive: true,
        onClose: () => setConfirmId(null),
        onConfirm: () => {
          if (confirmId) {
            stash.remove(confirmId)
          }

          setConfirmId(null)
        },
        open: Boolean(confirmId),
        title: t('deleteTitle')
      }),
      jsx(CaptureHost, { stash })
    ]
  })
}

function StatusChip({ stash }) {
  const t = usePluginI18n(ID)
  const notes = useValue(stash.$notes)
  const count = notes.filter(note => note.status !== 'sent').length

  return jsxs('div', {
    className: 'inline-flex h-full items-center',
    children: [
      jsx(Tip, {
        label: t('chipTip', count),
        children: jsx('button', {
          // Icon-only button: without this the accessible name is null — a Tip
          // is a tooltip, not a label. Same string as the tooltip.
          'aria-label': t('chipTip', count),
          className: cn(
            'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
            'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          onClick: () => stash.openCapture(),
          type: 'button',
          children: jsx('span', {
            className: 'inline-flex items-center gap-1',
            children: [
              jsx(icons.NotebookTabs, { className: 'size-3' }),
              count > 0 ? jsx('span', { className: 'tabular-nums', children: count }) : null
            ]
          })
        })
      }),
      jsx(CaptureHost, { stash })
    ]
  })
}

// ── Plugin export ─────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Note Stash',
  register(ctx) {
    ctx.i18n.register({
      en: {
        bodyPlaceholder: 'What\'s on your mind? Paste code, notes, next steps…',
        captureDescription: 'Captured locally. Nothing is sent until you send it.',
        captureTitle: 'New note',
        cancel: 'Cancel',
        cancelQueued: 'Cancel',
        chipTip: count => `Note Stash — ${count} active ${count === 1 ? 'note' : 'notes'}`,
        composerFailed: 'Note Stash could not put this note in the composer.',
        copy: 'Copy note',
        delete: 'Delete',
        deleteDescription: 'It is removed from Note Stash for good.',
        deleteTitle: 'Delete this note?',
        discard: 'Discard',
        discardDescription: 'The text you typed will be lost.',
        discardTitle: 'Discard this note?',
        emptyActive: 'No notes yet',
        emptyActiveDesc: 'Use the Note Stash shortcut or click New to capture a thought without leaving your turn.',
        emptySearch: 'No matching notes',
        emptySearchDesc: 'Try a different word.',
        emptySent: 'Nothing sent yet',
        emptySentDesc: 'Notes you send to a session land here.',
        filterActive: count => `Active ${count}`,
        filterSent: count => `Sent ${count}`,
        new: 'New',
        newNote: 'New note',
        noSession: 'Open a session first — there is no focused session to send to.',
        paneTitle: 'Note Stash',
        putInComposer: 'Put in composer',
        queuedLine: 'Queued — sends when the turn ends',
        restore: 'Restore to active',
        save: 'Save',
        saveFailed: 'Note Stash could not save notes.json.',
        saveVerifyFailed: 'Note Stash could not verify notes.json after writing it.',
        search: 'Search notes',
        send: 'Send',
        sendFailed: 'Note Stash could not send this note. It is still active.',
        sendTo: title => sendLabelFor(title),
        sentAgo: when => `sent ${when}`,
        statusQueued: 'Queued',
        statusWaiting: 'Waiting',
        storageFallback: error =>
          `Note Stash is saving notes in app storage (file save unavailable: ${error}).`,
        titlePlaceholder: 'Title (optional)',
        untitled: 'Untitled note',
        waitingLine: title => title ? `Sends when you open “${title}”` : 'Sends when you open that chat',
        waitingTip: 'The chat was not on screen when its turn ended'
      }
    })

    const stash = createStash(ctx)
    ctx.onDispose(stash.dispose)

    ctx.register({
      id: 'new-note',
      area: PALETTE_AREA,
      data: {
        action: KEYBIND_ID,
        id: KEYBIND_ID,
        keywords: ['note', 'sticky', 'scratch', 'capture', 'stash', 'code'],
        label: 'Note Stash: New note',
        run: () => stash.openCapture()
      }
    })

    ctx.register({
      id: 'new-note-keybind',
      area: KEYBINDS_AREA,
      data: {
        category: 'view',
        defaults: ['mod+alt+s'],
        id: KEYBIND_ID,
        label: 'Note Stash: New note',
        run: () => stash.openCapture()
      }
    })

    ctx.register({
      id: 'pane',
      area: 'panes',
      data: { placement: 'right', width: '320px' },
      render: () => jsx(NotePane, { stash }),
      title: ctx.i18n.t('paneTitle')
    })

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 130,
      render: () => jsx(StatusChip, { stash })
    })

    void stash.load()
  }
}
