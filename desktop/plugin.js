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
const CONFIRM_MS = 8000
const FOCUS_SETTLE_MS = 1500
const CONFIRM_PREFIX_LENGTH = 40
const TITLE_LENGTH = 72
const LABEL_TITLE_LENGTH = 32
const KEYBIND_ID = 'note-stash.new-note'

// Images are one flat UTF-8 text file per image in the plugin data folder,
// holding exactly one data URL. `ctx.files.writeText` is UTF-8 only and capped
// at 4 MiB, so the cap is enforced on the data URL before the write.
const IMAGE_MAX_DATA_URL_BYTES = 4194304
const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']
const IMAGE_FILE_PREFIX = 'img-'
const IMAGE_FILE_SUFFIX = '.txt'
const IMAGE_FILE_RE = /^img-.+-(\d+)\.txt$/
const IMAGE_EXT_BY_MIME = {
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
}

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
  const images = normalizeImages(input?.images)
  const note = { body, createdAt: now, id, status: 'active', title, updatedAt: now }

  if (images.length) {
    note.images = images
  }

  return note
}

/** One persisted image record, validated. The file name is the only handle to
 *  the image data; notes.json never carries inline image data (it shares the
 *  4 MiB file cap with the data URLs). */
export function normalizeImage(raw) {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const file = typeof raw.file === 'string' ? raw.file.trim() : ''

  if (!file || !IMAGE_FILE_RE.test(file)) {
    return null
  }

  const mime = typeof raw.mime === 'string' ? raw.mime.trim().toLowerCase() : ''

  if (!IMAGE_MIME_TYPES.includes(mime)) {
    return null
  }

  const bytes = Number.isFinite(raw.bytes) && raw.bytes >= 0 ? raw.bytes : 0
  const w = Number.isFinite(raw.w) && raw.w >= 0 ? raw.w : 0
  const h = Number.isFinite(raw.h) && raw.h >= 0 ? raw.h : 0

  return { bytes, file, h, mime, w }
}

export function normalizeImages(raw) {
  if (!Array.isArray(raw)) {
    return []
  }

  const images = []
  const seen = new Set()

  for (const item of raw) {
    const image = normalizeImage(item)

    if (!image || seen.has(image.file)) {
      continue
    }

    seen.add(image.file)
    images.push(image)
  }

  return images
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
  const images = normalizeImages(raw.images)

  if (!id || (!body.trim() && !title.trim() && !images.length)) {
    return null
  }

  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
  const status = raw.status === 'sent' ? 'sent' : 'active'
  const note = { body, createdAt, id, status, title, updatedAt }

  if (images.length) {
    note.images = images
  }

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

    if (!note) {
      continue
    }

    // A duplicate id (the capture dialog reused its draft id before 1.2.0)
    // would make two rows share a status and a delete. The first occurrence
    // keeps its id; each later duplicate gets a fresh one in file order, so the
    // repair is deterministic and the image arrays are untouched.
    if (seen.has(note.id)) {
      let fresh = makeNoteId(now)

      while (seen.has(fresh)) {
        fresh = makeNoteId(now)
      }

      note.id = fresh
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

// ── Images ─────────────────────────────────────────────────────────────────

/** One flat file per image in the data root: `img-<noteId>-<n>.txt`. */
export function imageFileName(noteId, index) {
  return `${IMAGE_FILE_PREFIX}${noteId}-${index}${IMAGE_FILE_SUFFIX}`
}

/** The next free image index for a note, from its existing image file names. */
export function nextImageIndex(images) {
  let next = 0

  for (const image of Array.isArray(images) ? images : []) {
    const match = IMAGE_FILE_RE.exec(typeof image?.file === 'string' ? image.file : '')

    if (match) {
      next = Math.max(next, Number(match[1]) + 1)
    }
  }

  return next
}

/** `data:<mime>;base64,<payload>` → `{base64, mime}`, or null. */
export function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return null
  }

  const text = dataUrl.trim()
  const comma = text.indexOf(',')

  if (comma < 0) {
    return null
  }

  const head = text.slice(0, comma)
  const match = /^data:([^;,]+);base64$/i.exec(head)

  if (!match) {
    return null
  }

  const base64 = text.slice(comma + 1).trim()

  if (!base64) {
    return null
  }

  return { base64, mime: match[1].toLowerCase() }
}

/** Raw byte count of a base64 payload (padding included). */
export function base64Bytes(base64) {
  const clean = String(base64 || '').replace(/[^A-Za-z0-9+/=]/g, '')

  if (!clean) {
    return 0
  }

  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0

  return Math.floor((clean.length * 3) / 4) - padding
}

/** UTF-8 byte length of a string; data URLs are ASCII, so length is the same. */
export function utf8ByteLength(text) {
  const value = typeof text === 'string' ? text : ''

  if (typeof globalThis.TextEncoder === 'function') {
    return new globalThis.TextEncoder().encode(value).length
  }

  return value.length
}

/** Refuse an image BEFORE any write: unsupported mime, or a data URL over the
 *  `ctx.files.writeText` 4 MiB cap. `{ok:true, mime, bytes, dataUrl}`. */
export function validateImageDataUrl(dataUrl) {
  const parsed = parseImageDataUrl(dataUrl)

  if (!parsed) {
    return {
      error: 'invalid-image',
      message: 'That is not an image Note Stash can read.',
      ok: false
    }
  }

  if (!IMAGE_MIME_TYPES.includes(parsed.mime)) {
    return {
      error: 'unsupported-image',
      message: 'Only PNG, JPEG, GIF, WebP and BMP images are supported.',
      ok: false
    }
  }

  const text = dataUrl.trim()

  if (utf8ByteLength(text) > IMAGE_MAX_DATA_URL_BYTES) {
    return { error: 'too-large', message: 'Image too large for Note Stash (max ~3 MB)', ok: false }
  }

  return { bytes: base64Bytes(parsed.base64), dataUrl: text, mime: parsed.mime, ok: true }
}

/**
 * Image files in the plugin data folder. One flat file per image, holding one
 * data URL, written with `exclusive` and read back as text (never
 * `readDataUrl`: it sniffs by extension and would return the base64 as
 * `data:text/plain`). No subfolders — only the data root is auto-created.
 */
export function createImageStore(ctx) {
  const files = ctx.files
  const enabled = Boolean(
    files &&
      typeof files.writeText === 'function' &&
      typeof files.readText === 'function' &&
      typeof files.trash === 'function'
  )
  const folder = files?.dataFolder ?? 'data'

  const write = async (noteId, index, dataUrl, dimensions = {}) => {
    const valid = validateImageDataUrl(dataUrl)

    if (!valid.ok) {
      return valid
    }

    if (!enabled) {
      return {
        error: 'unavailable',
        message: 'Images are unavailable because Note Stash is saving notes in app storage.',
        ok: false
      }
    }

    const file = imageFileName(noteId, index)
    let result = null

    try {
      result = await files.writeText(folder, file, valid.dataUrl, { exclusive: true })
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error), ok: false }
    }

    if (!result || !result.ok) {
      return {
        error: typeof result?.error === 'string' ? result.error : 'write-failed',
        message: 'Note Stash could not save that image.',
        ok: false
      }
    }

    return {
      image: {
        bytes: valid.bytes,
        file,
        h: Number.isFinite(dimensions.h) && dimensions.h >= 0 ? dimensions.h : 0,
        mime: valid.mime,
        w: Number.isFinite(dimensions.w) && dimensions.w >= 0 ? dimensions.w : 0
      },
      ok: true
    }
  }

  /** One image file as its data URL. A missing file is `{ok:false}` — the row
   *  renders a placeholder, never a crash. */
  const read = async file => {
    if (!enabled) {
      return { error: 'unavailable', ok: false }
    }

    let result = null

    try {
      result = await files.readText(folder, file)
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error), ok: false }
    }

    if (!result || !result.ok) {
      return { error: typeof result?.error === 'string' ? result.error : 'read-failed', ok: false }
    }

    const parsed = parseImageDataUrl(result.text)

    if (!parsed) {
      return { error: 'invalid-image', ok: false }
    }

    return { dataUrl: result.text.trim(), ok: true }
  }

  /** `{file: dataUrl|null}` for every image of every note; null = missing file. */
  const readAll = async notes => {
    const data = {}

    for (const note of Array.isArray(notes) ? notes : []) {
      for (const image of Array.isArray(note?.images) ? note.images : []) {
        if (data[image.file] !== undefined) {
          continue
        }

        const result = await read(image.file)
        data[image.file] = result.ok ? result.dataUrl : null
      }
    }

    return data
  }

  /** Move every image file of a deleted note to the OS trash. */
  const trash = async images => {
    if (!enabled) {
      return false
    }

    let all = true

    for (const image of Array.isArray(images) ? images : []) {
      try {
        const result = await files.trash(folder, image.file)

        if (!result || !result.ok) {
          all = false
        }
      } catch {
        all = false
      }
    }

    return all
  }

  return { enabled, read, readAll, trash, write }
}

/** A stored image data URL as a File, decoded with atob — never `fetch()` (a
 *  data URL needs no network, and fetch would make this async for nothing). */
export function dataUrlToFile(dataUrl, name) {
  const parsed = parseImageDataUrl(dataUrl)

  if (!parsed) {
    return null
  }

  let bytes = null

  try {
    const binary = globalThis.atob(parsed.base64)

    bytes = new globalThis.Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
  } catch {
    return null
  }

  try {
    return new globalThis.File([bytes], name, { type: parsed.mime })
  } catch {
    return null
  }
}

/**
 * Put a note's text and images into the chat on screen. Text goes in first with
 * `insertText` (a block, never clobbering the draft); then the images go in as
 * real attachment chips through `dispatchPaste`, which dispatches a synthetic
 * paste carrying one File per image and returns whether Desktop's own paste
 * handler took it. Nothing is sent: the user presses Enter.
 *
 * Images carry their `dataUrl` (the app layer reads it from the image store).
 * An image whose file is missing cannot become a File and is left out; if no
 * image could be built, the paste is not dispatched and the error is shown.
 */
export async function putInComposerWithImages(note, { insertText, dispatchPaste, focus, notify, sid }) {
  const body = typeof note?.body === 'string' ? note.body : ''
  const images = Array.isArray(note?.images) ? note.images : []
  const textAdded = Boolean(body.trim())

  if (textAdded) {
    let inserted = false

    try {
      inserted = Boolean(await insertText(sid, body, { mode: 'block' }))
    } catch {
      inserted = false
    }

    if (!inserted) {
      notify('composerFailed')

      return false
    }
  }

  const files = []

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]
    const file = dataUrlToFile(
      image?.dataUrl,
      `note-image-${index}.${IMAGE_EXT_BY_MIME[image?.mime] || 'png'}`
    )

    if (file) {
      files.push(file)
    }
  }

  if (!files.length) {
    notify(textAdded ? 'putInComposerImagesFailedWithText' : 'putInComposerImagesFailed')

    return false
  }

  let handled = false

  try {
    handled = dispatchPaste(files) === true
  } catch {
    handled = false
  }

  if (!handled) {
    notify(textAdded ? 'putInComposerImagesFailedWithText' : 'putInComposerImagesFailed')

    return false
  }

  focus(sid)

  return true
}

export function appendNote(notes, note) {
  const list = Array.isArray(notes) ? notes : []

  if (!note || typeof note !== 'object') {
    return list
  }

  const id = typeof note.id === 'string' ? note.id : ''
  const taken = Boolean(id) && list.some(existing => existing?.id === id)

  // Never store two notes under one id: a duplicate id makes one send mark both
  // sent and one delete remove both. Mint a fresh id only — the image `file`
  // names stay as they are, because image files are referenced by name.
  return [taken ? { ...note, id: makeNoteId() } : note, ...list]
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
 * Whether a `session.info` event proves the session actually started a turn for
 * this note. `host.composer.submit()` returning true only means a visible
 * composer surface existed — the composer's own listener silently drops the
 * event while the chat is still hydrating, so a submit's word is not proof.
 * Confirmed when the event is for `sid` and either `payload.running` is true or
 * a `payload.pending` entry's text starts with the first 40 chars of the body.
 */
export function sessionInfoConfirms(ev, sid, body) {
  if (!ev || typeof ev !== 'object' || typeof sid !== 'string' || !sid) {
    return false
  }

  const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {}
  const ids = [payload.stored_session_id, payload.session_id, ev.session_id, ev.stored_session_id]
    .filter(id => typeof id === 'string' && id.trim())
    .map(id => id.trim())

  if (!ids.includes(sid)) {
    return false
  }

  if (payload.running === true) {
    return true
  }

  const prefix = typeof body === 'string' ? body.slice(0, CONFIRM_PREFIX_LENGTH) : ''

  if (!prefix.trim()) {
    return false
  }

  const pending = Array.isArray(payload.pending) ? payload.pending : []

  for (const entry of pending) {
    const text =
      typeof entry === 'string'
        ? entry
        : typeof entry?.text === 'string'
          ? entry.text
          : typeof entry?.body === 'string'
            ? entry.body
            : ''

    if (text && text.startsWith(prefix)) {
      return true
    }
  }

  return false
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
 *  - `confirming`  submit returned true but that is not proof of delivery: the
 *                  head note stays in place until the session proves it started
 *                  a turn (busy flip or `session.info`), then it is sent; after
 *                  8 s unconfirmed it goes back to `waiting`. No retry submits
 *                  while an entry is confirming.
 *
 * Injected: `submit(sid, body) → boolean`, `isBusy(sid) → boolean`, timers,
 * clock, and `onEvent` (`sent` / `waiting` / `failed` / `cancelled`). No globals,
 * no host access — the app layer wires those in.
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
  confirmMs = CONFIRM_MS,
  focusSettleMs = FOCUS_SETTLE_MS,
  onEvent = () => {}
}) {
  const sessions = new Map()
  const manual = new Map()
  let waitTimer = null

  const record = sid => {
    let entry = sessions.get(sid)

    if (!entry) {
      entry = {
        confirmItem: null,
        confirmTimer: null,
        items: [],
        phase: 'idle',
        sawBusy: false,
        settleTimer: null,
        timer: null
      }
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

  /** The focus-settle timer: a just-opened chat gets 1.5 s before a retry. */
  const clearSettle = entry => {
    if (entry.settleTimer !== null) {
      clearTimeoutFn(entry.settleTimer)
      entry.settleTimer = null
    }
  }

  const clearConfirm = entry => {
    if (entry.confirmTimer !== null) {
      clearTimeoutFn(entry.confirmTimer)
      entry.confirmTimer = null
    }
  }

  const clearTimers = entry => {
    clearTimer(entry)
    clearSettle(entry)
    clearConfirm(entry)
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
   * The session proved it started the turn: mark sent exactly once. The busy
   * flip (or `running` session.info) IS the turn's start, so `sawBusy` is set —
   * the next queued note then waits for that turn to end.
   */
  const finishConfirm = (entry, sid) => {
    const item = entry.confirmItem

    if (!item) {
      return false
    }

    clearConfirm(entry)
    entry.confirmItem = null

    if (entry.items[0] === item) {
      entry.items.shift()
    }

    entry.phase = 'awaitingTurn'
    entry.sawBusy = true
    onEvent({ noteId: item.noteId, profile: item.profile, sid, type: 'sent' })

    return true
  }

  /**
   * submit() returned true, but that only means a visible composer surface
   * existed — the composer's own listener silently drops the event while the
   * chat is still hydrating. Hold the note at the head of the FIFO in
   * `confirming` (the row keeps showing Queued/Waiting) until the session proves
   * a turn started, or 8 s pass and it goes back to `waiting` silently.
   */
  const beginConfirm = (entry, item, sid) => {
    entry.phase = 'confirming'
    entry.confirmItem = item
    entry.confirmTimer = setTimeoutFn(() => {
      entry.confirmTimer = null

      if (entry.phase !== 'confirming' || entry.confirmItem !== item) {
        return
      }

      entry.confirmItem = null
      entry.phase = 'waiting'
      onEvent({ noteId: item.noteId, profile: item.profile, sid, type: 'waiting' })
      syncWaitTimer()
    }, confirmMs)
  }

  /** The manual path's confirmation: same proof, but a timeout is a real error. */
  const finishManual = (noteId, record) => {
    if (manual.get(noteId) !== record) {
      return false
    }

    if (record.timer !== null) {
      clearTimeoutFn(record.timer)
      record.timer = null
    }

    manual.delete(noteId)
    onEvent({ noteId, profile: record.item.profile, sid: record.item.sid, type: 'sent' })

    return true
  }

  /**
   * Retry every waiting head whose session is idle. A success only starts a
   * confirmation — the note is not sent until the session proves a turn started.
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

      // A retry supersedes any pending focus-settle timer for this session.
      clearSettle(entry)

      if (!submitItem(item)) {
        continue
      }

      beginConfirm(entry, item, sid)
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

    if (
      entry.phase === 'settling' ||
      entry.phase === 'awaitingTurn' ||
      entry.phase === 'waiting' ||
      entry.phase === 'confirming'
    ) {
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

      beginConfirm(entry, item, sid)
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

  /**
   * The immediate, not-busy Send path: submit once, then confirm the same way
   * the queue does. `true` is not proof of delivery, so the note stays Active
   * until the session proves a turn started; an unconfirmed submit after 8 s is
   * a real error (the user is looking at that chat) and reports `failed`.
   * Returns `'failed'` or `'confirming'`.
   */
  const sendNow = (note, sid, profile) => {
    if (!sid || !note || !note.id) {
      return 'failed'
    }

    const item = {
      body: typeof note.body === 'string' ? note.body : '',
      noteId: note.id,
      profile: typeof profile === 'string' && profile ? profile : 'default',
      sid
    }

    if (!submitItem(item)) {
      return 'failed'
    }

    const record = { item, sid, timer: null }
    manual.set(note.id, record)
    record.timer = setTimeoutFn(() => {
      record.timer = null

      if (manual.get(note.id) !== record) {
        return
      }

      manual.delete(note.id)
      onEvent({ noteId: note.id, profile: item.profile, sid, type: 'failed' })
    }, confirmMs)

    return 'confirming'
  }

  /** Whether a manual submit for this note is awaiting delivery confirmation. */
  const confirming = noteId => manual.has(noteId)

  /** Silently drop a manual confirmation (the note was deleted or cancelled). */
  const abandon = noteId => {
    const record = manual.get(noteId)

    if (!record) {
      return false
    }

    if (record.timer !== null) {
      clearTimeoutFn(record.timer)
      record.timer = null
    }

    manual.delete(noteId)

    return true
  }

  /** Feed the whole `busyBySession` map on every change. */
  const onBusyChange = busy => {
    const bySession = busy && typeof busy === 'object' ? busy : {}

    // A manual submit is confirmed by the same proof: the turn starting.
    for (const [noteId, record] of manual) {
      if (bySession[record.sid]) {
        finishManual(noteId, record)
      }
    }

    for (const [sid, entry] of sessions) {
      if (bySession[sid]) {
        entry.sawBusy = true

        if (entry.phase === 'confirming') {
          // The turn started: this submit did reach the session.
          finishConfirm(entry, sid)

          continue
        }

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

  /**
   * Gateway `session.info` events: the second proof of delivery. A confirming
   * entry is sent when the event is for its session and shows the turn running
   * (or a pending prompt that starts with the note body).
   */
  const onSessionInfo = event => {
    for (const [sid, entry] of sessions) {
      if (entry.phase !== 'confirming' || !entry.confirmItem) {
        continue
      }

      if (sessionInfoConfirms(event, sid, entry.confirmItem.body)) {
        finishConfirm(entry, sid)
      }
    }

    for (const [noteId, record] of manual) {
      if (sessionInfoConfirms(event, record.item.sid, record.item.body)) {
        finishManual(noteId, record)
      }
    }
  }

  /**
   * Focus moved. A waiting note whose chat just became focused is NOT retried
   * immediately: a just-opened chat is still hydrating and its composer silently
   * drops the submit, so the retry is scheduled 1.5 s out and cancelled if focus
   * moves away. The 3 s interval retry stays and naturally fires >=1.5 s later.
   */
  const onFocusChange = focusedIds => {
    const ids = new Set(
      (Array.isArray(focusedIds) ? focusedIds : [focusedIds]).filter(
        id => typeof id === 'string' && id
      )
    )

    for (const [sid, entry] of sessions) {
      if (entry.phase !== 'waiting' || !ids.has(sid)) {
        clearSettle(entry)

        continue
      }

      if (entry.settleTimer !== null) {
        continue
      }

      entry.settleTimer = setTimeoutFn(() => {
        entry.settleTimer = null

        if (entry.phase !== 'waiting') {
          return
        }

        retryWaiting(sid)
      }, focusSettleMs)
    }
  }

  const cancel = noteId => {
    // A manual confirmation in flight is silently dropped with the note.
    abandon(noteId)

    for (const [sid, entry] of sessions) {
      const index = entry.items.findIndex(item => item.noteId === noteId)

      if (index === -1) {
        continue
      }

      entry.items.splice(index, 1)

      if (!entry.items.length) {
        clearTimers(entry)
        entry.phase = 'idle'
      } else if (index === 0 && (entry.phase === 'waiting' || entry.phase === 'confirming')) {
        // The waiting/confirming head is gone; the next note is an ordinary
        // queued one.
        clearTimers(entry)
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
      clearTimers(entry)
    }

    for (const record of manual.values()) {
      if (record.timer !== null) {
        clearTimeoutFn(record.timer)
      }
    }

    manual.clear()

    if (waitTimer !== null) {
      clearIntervalFn(waitTimer)
      waitTimer = null
    }

    sessions.clear()
  }

  return {
    abandon,
    cancel,
    confirming,
    dispose,
    enqueue,
    onBusyChange,
    onFocusChange,
    onSessionInfo,
    pending,
    sendNow
  }
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

/**
 * Dispatch a synthetic paste carrying image Files on `window`. Desktop's own
 * window paste handler (the same path as a real Cmd+V) routes it into the
 * active composer as attachment chips. It skips an event whose target is
 * editable, so drop focus from the pane's search box or any text field first;
 * it calls `preventDefault()` when it handled the paste, which is the signal.
 */
function dispatchImagePaste(files) {
  const active = globalThis.document?.activeElement
  const tag = String(active?.tagName ?? '')

  if (active && (active.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
    active.blur()
  }

  const transfer = new globalThis.DataTransfer()

  for (const file of files) {
    transfer.items.add(file)
  }

  const event = new globalThis.ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: transfer
  })

  globalThis.window.dispatchEvent(event)

  return event.defaultPrevented === true
}

function createStash(ctx) {
  const t = ctx.i18n.t
  const $notes = atom([])
  const $filter = atom('active')
  const $search = atom('')
  const $capture = atom(false)
  // file → data URL, or null for a missing image file (a placeholder row).
  const $imageData = atom({})
  const persistence = createPersistence(ctx, t)
  const imageStore = createImageStore(ctx)
  let imagesDisabledNotified = false

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

        return
      }

      if (event.type === 'failed') {
        // The immediate path's submit returned true but the chat never started a
        // turn within 8 s: the user is looking at that chat, so say so.
        $notes.set(setNoteStatus($notes.get(), event.noteId, 'active'))
        persistence.schedule($notes.get())
        host.notify({ kind: 'error', message: t('sendFailed') })
      }
    }
  })

  ctx.onDispose(host.state.busyBySession.subscribe(map => queue.onBusyChange(map)))
  // Focus moving is the main way a waiting note's chat becomes on screen. Both
  // focused ids are passed: the runtime id and the durable stored id.
  const onFocusChange = () =>
    queue.onFocusChange([
      host.state.focusedSessionId.get(),
      host.state.focusedStoredSessionId.get()
    ])

  ctx.onDispose(host.state.focusedSessionId.subscribe(onFocusChange))
  ctx.onDispose(host.state.focusedStoredSessionId.subscribe(onFocusChange))

  // The gateway emits `session.info` with `payload.title` whenever a chat's
  // title changes — the provisional first-prompt title, then the generated one
  // a few seconds later. Without this listener the label sticks on the
  // provisional title, since the 5 s poll stops as soon as ANY title is known.
  // The poll stays as the fallback for a title that arrives with no event.
  ctx.onEvent('session.info', event => {
    // The same event is the second proof of delivery for a confirming submit:
    // `payload.running` true (or a pending prompt matching the note body).
    queue.onSessionInfo(event)

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

  /** Read every note's image files into the render cache. A missing file is
   *  null → the row renders a placeholder. */
  const loadImages = async notes => {
    if (!imageStore.enabled) {
      return
    }

    try {
      $imageData.set(await imageStore.readAll(notes))
    } catch {
      // The rows render placeholders; never crash the pane for a read failure.
    }
  }

  const load = async () => {
    let loaded = []

    try {
      loaded = await persistence.read()
    } catch {
      loaded = []
    }

    if (!loaded.length) {
      void loadImages($notes.get())

      return
    }

    const current = $notes.get()

    if (!current.length) {
      $notes.set(loaded)
      void loadImages(loaded)

      return
    }

    const known = new Set(current.map(note => note.id))
    $notes.set([...current, ...loaded.filter(note => !known.has(note.id))])
    void loadImages($notes.get())
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
    $imageData,
    $notes,
    $search,
    addImage: async (noteId, images, dataUrl, dimensions) => {
      if (!imageStore.enabled) {
        if (!imagesDisabledNotified) {
          imagesDisabledNotified = true
          host.notify({ kind: 'error', message: t('imagesDisabled') })
        }

        return null
      }

      const result = await imageStore.write(noteId, nextImageIndex(images), dataUrl, dimensions)

      if (!result.ok) {
        host.notify({ kind: 'error', message: result.message || t('imageFailed') })

        return null
      }

      return result.image
    },
    addNote: input => {
      const note = createNote(input)

      if (!note.body.trim() && !note.title.trim() && !note.images?.length) {
        return null
      }

      $notes.set(appendNote($notes.get(), note))
      persist()
      void loadImages($notes.get())

      return note
    },
    cancelQueued: noteId => queue.cancel(noteId),
    closeCapture: () => $capture.set(false),
    discardImages: images => {
      if (Array.isArray(images) && images.length) {
        void imageStore.trash(images)
      }
    },
    dispose,
    edit: (id, patch) => {
      const before = $notes.get().find(note => note.id === id)
      const next = updateNote($notes.get(), id, patch)

      // Images dropped by an edit are trashed; the note never keeps a dangling
      // file reference.
      if (before?.images?.length && Array.isArray(patch?.images)) {
        const kept = new Set(patch.images.map(image => image?.file))
        const removed = before.images.filter(image => !kept.has(image.file))

        if (removed.length) {
          void imageStore.trash(removed)
        }
      }

      $notes.set(next)
      persist()
      void loadImages(next)
    },
    load,
    loadImages,
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
    putInComposerImages: async note => {
      if (!note) {
        return
      }

      const sid = host.state.focusedSessionId.get()

      if (!sid) {
        host.notify({ kind: 'error', message: t('noSession') })

        return
      }

      // Desktop's paste handler ignores a paste while a dialog is open, and the
      // plugin's own capture dialog is the one that can be open over the pane.
      if ($capture.get()) {
        host.notify({ kind: 'error', message: t('composerFailed') })

        return
      }

      // Each image needs its data URL: the render cache first, else a read of
      // the stored file. A missing file stays null and is left out.
      const images = []

      for (const image of note.images ?? []) {
        let dataUrl = $imageData.get()[image.file]

        if (!dataUrl) {
          try {
            const read = await imageStore.read(image.file)

            dataUrl = read.ok ? read.dataUrl : null
          } catch {
            dataUrl = null
          }
        }

        images.push({ ...image, dataUrl })
      }

      await putInComposerWithImages(
        { ...note, images },
        {
          dispatchPaste: dispatchImagePaste,
          focus: id => host.composer.focus(id),
          insertText: (id, text, options) => host.composer.insertText(id, text, options),
          notify: key => host.notify({ kind: 'error', message: t(key) }),
          sid
        }
      )
    },
    remove: id => {
      const note = $notes.get().find(entry => entry.id === id)

      queue.abandon(id)

      if (note?.images?.length) {
        void imageStore.trash(note.images)
      }

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

      // Image notes are never sent from the pane: they go into the composer as
      // attachments and the user presses Enter.
      if (note.images?.length) {
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

      // A manual submit is still awaiting confirmation: submitting again would
      // deliver the note twice.
      if (queue.confirming(note.id)) {
        return
      }

      // submit() returning true is not proof of delivery — the note stays Active
      // until the session proves it started a turn (or reports `failed`).
      const result = queue.sendNow(note, sid, targetProfile)

      if (result === 'failed') {
        host.notify({ kind: 'error', message: t('sendFailed') })
      }
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

/** Image files from a paste's `clipboardData`: `items` kind 'file' + image/*,
 *  then `files` as the Chromium/Electron fallback (mirrors the composer's
 *  text-utils.ts:106-123). */
export function imageFilesFromClipboard(clipboard) {
  const files = []
  const seen = new Set()
  const push = file => {
    if (file && typeof file.type === 'string' && file.type.startsWith('image/') && !seen.has(file)) {
      seen.add(file)
      files.push(file)
    }
  }

  if (clipboard?.items?.length) {
    for (const item of clipboard.items) {
      if (item.kind === 'file' && typeof item.type === 'string' && item.type.startsWith('image/')) {
        push(item.getAsFile())
      }
    }
  }

  if (!files.length && clipboard?.files?.length) {
    for (let index = 0; index < clipboard.files.length; index += 1) {
      push(clipboard.files.item(index))
    }
  }

  return files
}

/** Image files from a drop's `dataTransfer`. */
export function imageFilesFromDataTransfer(transfer) {
  const files = []

  if (transfer?.files?.length) {
    for (let index = 0; index < transfer.files.length; index += 1) {
      const file = transfer.files.item(index)

      if (file && typeof file.type === 'string' && file.type.startsWith('image/')) {
        files.push(file)
      }
    }
  }

  return files
}

/** A File as its data URL. */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new globalThis.FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** Natural pixel size of a data URL; 0×0 when the image cannot be decoded. */
function loadImageSize(dataUrl) {
  return new Promise(resolve => {
    const image = new globalThis.Image()
    image.onload = () =>
      resolve({ h: image.naturalHeight || image.height || 0, w: image.naturalWidth || image.width || 0 })
    image.onerror = () => resolve({ h: 0, w: 0 })
    image.src = dataUrl
  })
}

/** The persisted image record, stripped of any editor-only `dataUrl`. */
export function imageMeta(image) {
  return {
    bytes: Number.isFinite(image?.bytes) ? image.bytes : 0,
    file: String(image?.file || ''),
    h: Number.isFinite(image?.h) ? image.h : 0,
    mime: String(image?.mime || ''),
    w: Number.isFinite(image?.w) ? image.w : 0
  }
}

/** One thumbnail: the data URL, or a placeholder for a missing file. */
function ImageThumb({ dataUrl, image, onRemove, size = 'h-14 w-14', t }) {
  return jsxs('div', {
    className: 'relative',
    children: [
      dataUrl
        ? jsx('img', {
            alt: '',
            className: cn(size, 'rounded border border-(--stroke-nous) object-cover'),
            src: dataUrl
          })
        : jsx('div', {
            className: cn(
              size,
              'flex items-center justify-center rounded border border-(--stroke-nous) text-(--ui-text-tertiary)'
            ),
            children: jsx(icons.ImageIcon, { 'aria-label': t('imageMissing'), className: 'size-4' })
          }),
      onRemove
        ? jsx('button', {
            'aria-label': t('imageRemove'),
            className:
              'absolute -right-1.5 -top-1.5 inline-flex size-4 items-center justify-center rounded-full bg-(--ui-chat-bubble-background) text-(--ui-text-secondary) shadow-nous hover:text-foreground',
            onClick: () => onRemove(image),
            type: 'button',
            children: jsx(icons.X, { className: 'size-2.5' })
          })
        : null
    ]
  })
}

/** The editor's thumbnail grid, each with a remove button. */
function ImageThumbnails({ images, onRemove, t }) {
  if (!images.length) {
    return null
  }

  return jsx('div', {
    className: 'flex flex-wrap gap-1.5',
    children: images.map(image =>
      jsx(ImageThumb, { dataUrl: image.dataUrl, image, key: image.file, onRemove, t })
    )
  })
}

/** A note row's thumbnail strip: max 3, then `+N`. */
function ImageStrip({ data, images, t }) {
  const shown = images.slice(0, 3)
  const more = images.length - shown.length

  return jsxs('div', {
    className: 'mt-1 flex items-center gap-1',
    children: [
      ...shown.map(image =>
        jsx(ImageThumb, { dataUrl: data[image.file] ?? null, image, key: image.file, size: 'h-8 w-8', t })
      ),
      more > 0
        ? jsx('span', {
            className: 'tabular-nums text-[0.625rem] leading-none text-(--ui-text-tertiary)',
            children: t('imageMore', more)
          })
        : null
    ]
  })
}

function CaptureDialog({ stash }) {
  const t = usePluginI18n(ID)
  const open = useValue(stash.$capture)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [images, setImages] = useState([])
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const bodyRef = useRef(null)
  const draftId = useRef('')
  // Every image file written for the current draft, and whether the draft was
  // saved. Both die with the dialog: a draft id must never outlive its dialog.
  const draftFiles = useRef([])
  const savedDraft = useRef(false)
  const dirty = Boolean(title.trim() || body.trim() || images.length)
  const canSave = Boolean(body.trim() || images.length)

  // Every close path — save, cancel, discard, Esc, overlay click — lands here,
  // because they all flip the open flag. Reusing a draft id across captures
  // wrote the next note under the previous note's id (duplicate ids in
  // notes.json); images added for a draft that was never saved are orphans and
  // are trashed here, the one place that sees every close.
  useEffect(() => {
    if (open) {
      return
    }

    if (!savedDraft.current && draftFiles.current.length) {
      stash.discardImages(draftFiles.current)
    }

    savedDraft.current = false
    draftFiles.current = []
    draftId.current = ''
  }, [open])

  /** Write each image file under the draft note id and hold it with its data
   *  URL for the thumbnail. */
  const addFiles = async files => {
    const list = Array.isArray(files) ? files : []

    if (!list.length) {
      return
    }

    if (!draftId.current) {
      draftId.current = makeNoteId()
    }

    let next = images

    for (const file of list) {
      let dataUrl = ''

      try {
        dataUrl = await readFileAsDataUrl(file)
      } catch {
        continue
      }

      const size = await loadImageSize(dataUrl)
      const image = await stash.addImage(draftId.current, next, dataUrl, size)

      if (image) {
        next = [...next, { ...image, dataUrl }]
        draftFiles.current = [...draftFiles.current, image]
        setImages(next)
      }
    }
  }

  const close = () => {
    // Image files are trashed by the open→closed effect, which also covers the
    // paths that never reach this function (Esc, overlay click).
    stash.closeCapture()
    setTitle('')
    setBody('')
    setImages([])
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

    // The note takes ownership of the image files; the close effect must not
    // trash them, so the draft is marked saved before the flag flips.
    savedDraft.current = true
    stash.addNote({
      body,
      id: draftId.current || undefined,
      images: images.map(imageMeta),
      title
    })
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
          // DialogContent spreads props onto Radix Content (dialog.tsx:176).
          // preventDefault on BOTH dragover and drop, else Electron opens the
          // file instead of the dialog taking it (electron/main.ts:12106-12113).
          onDragOver: event => {
            event.preventDefault()
          },
          onDrop: event => {
            event.preventDefault()
            void addFiles(imageFilesFromDataTransfer(event.dataTransfer))
          },
          onPaste: event => {
            const files = imageFilesFromClipboard(event.clipboardData)

            if (files.length) {
              event.preventDefault()
              void addFiles(files)
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
            jsx(ImageThumbnails, {
              images,
              onRemove: image => {
                setImages(images.filter(entry => entry.file !== image.file))
                draftFiles.current = draftFiles.current.filter(entry => entry.file !== image.file)
                stash.discardImages([image])
              },
              t
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

function NoteEditor({ note, onCancel, onSave, stash, t }) {
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const imageData = useValue(stash.$imageData)
  const [images, setImages] = useState(() =>
    (note.images ?? []).map(image => ({ ...image, dataUrl: imageData[image.file] ?? null }))
  )
  const initialFiles = useRef(new Set((note.images ?? []).map(image => image.file)))

  /** Write each image file under this note's id and hold it with its data URL. */
  const addFiles = async files => {
    const list = Array.isArray(files) ? files : []

    if (!list.length) {
      return
    }

    let next = images

    for (const file of list) {
      let dataUrl = ''

      try {
        dataUrl = await readFileAsDataUrl(file)
      } catch {
        continue
      }

      const size = await loadImageSize(dataUrl)
      const image = await stash.addImage(note.id, next, dataUrl, size)

      if (image) {
        next = [...next, { ...image, dataUrl }]
        setImages(next)
      }
    }
  }

  const cancel = () => {
    // Only images added in this edit session are discarded; the note's own
    // files stay.
    const added = images.filter(image => !initialFiles.current.has(image.file))

    if (added.length) {
      stash.discardImages(added)
    }

    onCancel()
  }

  const save = () => {
    if (!title.trim() && !body.trim() && !images.length) {
      cancel()

      return
    }

    onSave({ body, images: images.map(imageMeta), title })
  }

  return jsxs('div', {
    className: 'grid gap-3',
    // preventDefault on BOTH dragover and drop, else Electron opens the file
    // instead of the editor taking it (electron/main.ts:12106-12113).
    onDragOver: event => {
      event.preventDefault()
    },
    onDrop: event => {
      event.preventDefault()
      void addFiles(imageFilesFromDataTransfer(event.dataTransfer))
    },
    onPaste: event => {
      const files = imageFilesFromClipboard(event.clipboardData)

      if (files.length) {
        event.preventDefault()
        void addFiles(files)
      }
    },
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
      jsx(ImageThumbnails, {
        images,
        onRemove: image => {
          setImages(images.filter(entry => entry.file !== image.file))
          stash.discardImages([image])
        },
        t
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Button, { onClick: save, size: 'xs', type: 'button', children: t('save') }),
          jsx(Button, {
            onClick: cancel,
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
  const imageData = useValue(stash.$imageData)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const primaryProfile = useValue(host.state.profile)
  const sent = note.status === 'sent'
  const queued = note.status === 'queued'
  const waiting = note.status === 'waiting'
  const hasImages = Boolean(note.images?.length)
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
              : null,
            hasImages
              ? jsx(ImageStrip, { data: imageData, images: note.images, t })
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
          hasImages
            ? jsx(Tip, {
                label: t('putInComposerImagesTip'),
                children: jsx(Button, {
                  'aria-label': t('putInComposer'),
                  disabled: !focused,
                  onClick: () => stash.putInComposerImages(note),
                  size: 'xs',
                  type: 'button',
                  variant: 'ghost',
                  children: jsxs('span', {
                    className: 'inline-flex items-center gap-1',
                    children: [jsx(icons.PencilLine, { className: 'size-3' }), t('putInComposer')]
                  })
                })
              })
            : jsx(Tip, {
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
              hasImages
                ? null
                : jsx(SmallAction, {
                    disabled: !focused,
                    icon: icons.PencilLine,
                    label: t('putInComposer'),
                    onClick: () => stash.putInComposer(note)
                  }),
              jsx(CopyButton, {
                appearance: 'icon',
                buttonSize: 'icon-xs',
                label: hasImages ? t('copyImages') : t('copy'),
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
            stash,
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
        copyImages: 'Copy note (text only)',
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
        imageFailed: 'Note Stash could not add that image.',
        imageMissing: 'Missing image',
        imageMore: count => `+${count}`,
        imageRemove: 'Remove image',
        imagesDisabled: 'Images are unavailable because Note Stash is saving notes in app storage.',
        new: 'New',
        newNote: 'New note',
        noSession: 'Open a session first — there is no focused session to send to.',
        paneTitle: 'Note Stash',
        putInComposer: 'Put in composer',
        putInComposerImagesFailed:
          'Note Stash could not add the images. Close any open dialog, click into the chat, and try again.',
        putInComposerImagesFailedWithText:
          'Note Stash could not add the images. The text was added. Close any open dialog, click into the chat, and try again.',
        putInComposerImagesTip: 'Adds the text and images to the chat you are viewing — press Enter to send',
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
