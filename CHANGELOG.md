# Changelog

## 1.2.3

- Fixed: removing an image in the editor no longer deletes its file until you
  save, and Cancel keeps it. Removing a thumbnail only drops it from the editor;
  the file is moved to the trash when Save persists the patch, and Cancel
  discards only images added in that edit session.
- Row actions (**Put in composer**, **Copy**, **Restore**, **Delete**) are always
  visible and muted, reaching full opacity on hover or focus, instead of hidden
  until hover — Delete is discoverable without hovering.
- Empty notes (no body text and no images) can't be sent: **Send** is disabled
  with a native title, and sending refuses silently. **Delete** always works.

## 1.2.2

- **Put in composer** + **Enter** now moves the note to **Sent**: a note put in
  the composer shows a muted **In composer** badge (tooltip: "Press Enter in the
  chat to send. Moves to Sent when it is sent.") and is marked sent when the chat
  starts a turn with that note's text (a matching pending prompt) — for an
  images-only note, when the chat's turn starts. The badge clears silently after
  ten minutes, on an edit or delete, on a send another way, or when another note
  is put in the composer for the same chat. Nothing is persisted: a restart
  leaves the note Active.
- The plugin version is shown in the pane header (`v1.2.2`).

## 1.2.1

- Fixed: Put in composer for image notes failed on a real mouse click because
  the button’s tooltip blocked Desktop’s paste handling; the paste now also
  retries briefly.

## 1.2.0

- Images in notes: paste or drop PNG, JPEG, GIF, WebP or BMP images into the
  capture dialog or a note editor. Each image is stored as one text file in the
  plugin's own data folder, up to ~3 MB per image. The editor shows thumbnails
  with a remove button; a row shows up to three with a `+N` count, and a missing
  file renders a placeholder instead of breaking the row.
- Notes with images have **Put in composer** as their labeled action instead of
  **Send**: it inserts the note's text and then dispatches a synthetic paste
  event that Desktop's own paste handling turns into real image attachments in
  the chat on screen. Nothing is sent until you press Enter. An images-only
  note adds just its images.
- **Copy** stays text-only; its tooltip says so when the note has images.
- Text-only notes keep the automatic **Send**, busy queue, waiting and delivery
  confirmation from 1.1.1, unchanged.
- Fixed: a note saved after an image note could reuse its id; duplicate ids are
  repaired on load.

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
