# Changelog

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
