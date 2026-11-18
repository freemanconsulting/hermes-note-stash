# Changelog

## 1.2.0

- Images in notes: paste or drop PNG, JPEG, GIF, WebP or BMP images into the
  capture dialog or a note editor. Each image is stored as one text file in the
  plugin's own data folder, up to ~3 MB per image. The editor shows thumbnails
  with a remove button; a row shows up to three with a `+N` count, and a missing
  file renders a placeholder instead of breaking the row.
- **Send** uploads a note's images to the target chat's own gateway (one
  `image.attach_bytes` per image) and then sends the text. If delivery is not
  confirmed, the staged images are withdrawn with `image.detach` so they do not
  leak into your next message. An images-only note sends its title, or
  `(image)` when untitled.
- **Put in composer** and **Copy** are text-only: their tooltips say so when the
  note has images, and images are sent only with **Send**.

## 1.1.1

- Queued notes whose chat is not on screen when the turn ends now wait and send
  when you open that chat, instead of failing. A waiting row shows a **Waiting**
  badge, a muted line naming the chat, and **Cancel**; it retries on a focus
  change, a busy change, or a 3 s interval that runs only while a note waits.
  The immediate, not-busy Send path still reports a real submit failure.
- A note is now marked sent only after its chat actually starts the turn (a
  submit that returns true but never reaches the session goes back to Waiting
  silently), and a just-opened chat gets ~1.5 s to settle before a waiting note
  is sent.

## 1.1.0 — first public release

- Capture dialog: optional title, monospace body, Tab inserts two spaces,
  ⌘/Ctrl+Enter saves, Esc cancels with a discard confirmation only when text
  would be lost.
- Right-side pane listing notes with title/first line, relative time and
  status; Active / Sent filters, search, inline editing, and per-note Send,
  Put in composer, Copy, Delete and Restore.
- Status bar chip showing the active note count; click to capture.
- Send to the focused session as the next prompt, with a busy queue: a note
  sent to a session that is mid-turn waits for the turn to end (settle delay,
  re-check, one note per idle transition, FIFO per session) instead of being
  injected into the running turn. Queued notes revert to Active after an app
  restart.
- Notes persisted as `notes.json` in the plugin's own app data folder via
  `ctx.files`, with a one-warning fallback to the plugin's namespaced app
  storage when the folder is unavailable.
- i18n completeness test and render smoke test.
