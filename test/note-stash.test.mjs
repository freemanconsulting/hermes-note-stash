/**
 * Note Stash tests — the behaviors that regress, not the getters.
 *
 * Contract per test:
 *  - send queue: a busy target is NEVER submitted into (steer-injection into a
 *    running turn is the whole point of the plugin); it submits exactly once
 *    after busy→idle plus the settle delay; two queued notes go FIFO, one per
 *    idle transition.
 *  - submit returning false on the queue path holds the note as `waiting` at
 *    the head of its session's FIFO (no failure event); a retry that succeeds
 *    sends it once, and the next note waits for the next idle transition.
 *  - the immediate (not-busy) manual Send path still reports failure and leaves
 *    the note active.
 *  - load reverts a persisted `queued`/`waiting` note to `active`; a malformed
 *    or missing notes.json is an empty store and never throws.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { installStubs } from './loader.mjs'

installStubs()

const {
  appendNote,
  createPersistence,
  createSendQueue,
  dataUrlToFile,
  parseNotesFile,
  previewFor,
  putInComposerWithImages,
  sessionInfoConfirms,
  setNoteStatus,
  titleFromRows,
  titleUpdateFromEvent,
  VERSION
} = await import('../desktop/plugin.js')
const plugin = (await import('../desktop/plugin.js')).default
const sdk = await import('@hermes/plugin-sdk')

describe('titleUpdateFromEvent', () => {
  // The live bug: the label stuck on the provisional first-prompt title because
  // the poll stopped at the first known title; the generated title arrives on a
  // later session.info event, so it must be parsed out of the event, not polled.
  it('reads title and stored_session_id from the payload', () => {
    const ev = {
      profile: 'sandbox',
      session_id: 'local-52700b',
      type: 'session.info',
      payload: { stored_session_id: 'local-52700b', revision: 2, title: 'Define skip list in one sentence' }
    }

    assert.deepEqual(titleUpdateFromEvent(ev, 'default'), {
      id: 'local-52700b',
      profile: 'sandbox',
      title: 'Define skip list in one sentence'
    })
  })

  it('falls back to top-level title/session_id and the passed profile', () => {
    assert.deepEqual(
      titleUpdateFromEvent({ title: 'Rate limiter', session_id: 'sess-9' }, 'work'),
      { id: 'sess-9', profile: 'work', title: 'Rate limiter' }
    )
    assert.equal(titleUpdateFromEvent({ title: 'X', session_id: 's' }, '').profile, 'default')
  })

  it('returns null when the title is missing, blank, or not a string', () => {
    assert.equal(titleUpdateFromEvent({ session_id: 's', payload: { title: '   ' } }, 'default'), null)
    assert.equal(titleUpdateFromEvent({ session_id: 's', payload: { title: null } }, 'default'), null)
    assert.equal(titleUpdateFromEvent({ session_id: 's', payload: { running: false } }, 'default'), null)
    assert.equal(titleUpdateFromEvent({ title: 'Title but no id' }, 'default'), null)
    assert.equal(titleUpdateFromEvent(null, 'default'), null)
  })
})

describe('titleFromRows', () => {
  it('takes the title of the row whose id is one of the ids', () => {
    const rows = [
      { id: 'other', title: 'Other chat' },
      { id: 'sess-1', title: 'Summarize token bucket rate limiter' }
    ]

    assert.equal(titleFromRows(rows, ['sess-1', 'runtime-9']), 'Summarize token bucket rate limiter')
  })

  it('matches the durable _lineage_root_id when the runtime id differs', () => {
    const rows = [{ id: 'runtime-9', _lineage_root_id: 'sess-1', title: 'Rate limiter' }]

    assert.equal(titleFromRows(rows, ['sess-1', '']), 'Rate limiter')
  })

  it('returns empty string when the matching row has no title', () => {
    const rows = [{ id: 'sess-1', title: '   ' }, { id: 'sess-2', title: 'unrelated' }]

    assert.equal(titleFromRows(rows, ['sess-1', null]), '')
    assert.equal(titleFromRows(rows, []), '')
    assert.equal(titleFromRows(null, ['sess-1']), '')
  })
})

describe('previewFor', () => {
  // The live bug: an untitled note printed its first body line twice — once as
  // the derived title, once as the start of the 2-line preview.
  it('shows the whole body for a titled note', () => {
    assert.equal(
      previewFor({ body: 'first line\nsecond line', title: 'Titled' }),
      'first line\nsecond line'
    )
  })

  it('starts at the second non-empty line for an untitled multi-line note', () => {
    assert.equal(
      previewFor({ body: 'first line\n\n  \nsecond line\nthird line', title: '' }),
      'second line\nthird line'
    )
  })

  it('returns an empty preview for an untitled single-line note', () => {
    assert.equal(previewFor({ body: 'only line', title: '' }), '')
    assert.equal(previewFor({ body: '\n  only line  \n\n', title: '   ' }), '')
  })
})

describe('sessionInfoConfirms', () => {
  // submit() returning true is not proof of delivery: this is the second proof.
  const body = 'Refactor the send queue so a note is only sent after the chat starts a turn'

  it('confirms when the event is for the session and the turn is running', () => {
    assert.equal(
      sessionInfoConfirms({ session_id: 's1', type: 'session.info', payload: { running: true } }, 's1', body),
      true
    )
    assert.equal(
      sessionInfoConfirms({ payload: { running: true, stored_session_id: 's1' } }, 's1', body),
      true
    )
  })

  it('confirms when a pending prompt starts with the first 40 chars of the body', () => {
    const prefix = body.slice(0, 40)

    assert.equal(
      sessionInfoConfirms({ session_id: 's1', payload: { pending: [{ text: `${prefix} and more` }] } }, 's1', body),
      true
    )
    assert.equal(
      sessionInfoConfirms({ session_id: 's1', payload: { pending: [`${prefix} and more`] } }, 's1', body),
      true
    )
  })

  it('does not confirm for another session, a false running flag, or an unrelated pending prompt', () => {
    assert.equal(sessionInfoConfirms({ session_id: 's2', payload: { running: true } }, 's1', body), false)
    assert.equal(sessionInfoConfirms({ session_id: 's1', payload: { running: false } }, 's1', body), false)
    assert.equal(
      sessionInfoConfirms({ session_id: 's1', payload: { pending: [{ text: 'something else' }] } }, 's1', body),
      false
    )
    assert.equal(sessionInfoConfirms({ session_id: 's1', payload: { pending: [{ text: 'x' }] } }, 's1', ''), false)
    assert.equal(sessionInfoConfirms(null, 's1', body), false)
  })
})

describe('dataUrlToFile', () => {
  it('decodes a stored data URL into a File with the bytes and mime intact', async () => {
    const file = dataUrlToFile('data:image/png;base64,iVBORw0KGgo=', 'note-image-0.png')

    assert.equal(file.name, 'note-image-0.png')
    assert.equal(file.type, 'image/png')
    assert.equal(file.size, 8)
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(dataUrlToFile('not-a-data-url', 'x.png'), null)
    assert.equal(dataUrlToFile('data:image/png,abc', 'x.png'), null)
  })
})

describe('putInComposerWithImages', () => {
  const IMAGES = [
    { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', file: 'img-note-0.txt', mime: 'image/png' },
    { dataUrl: 'data:image/jpeg;base64,iVBORw0KGgo=', file: 'img-note-1.txt', mime: 'image/jpeg' }
  ]

  it('inserts the text once, then dispatches one paste with one File per image and focuses', async () => {
    const inserts = []
    const pastes = []
    const focused = []
    const notices = []

    const ok = await putInComposerWithImages(
      { body: 'hello', images: IMAGES },
      {
        dispatchPaste: files => {
          pastes.push(files)

          return true
        },
        focus: sid => focused.push(sid),
        insertText: (sid, body, options) => {
          inserts.push([sid, body, options])

          return true
        },
        notify: message => notices.push(message),
        sid: 'sess-1'
      }
    )

    assert.equal(ok, true)
    assert.deepEqual(inserts, [['sess-1', 'hello', { mode: 'block' }]], 'the text goes in once as a block')
    assert.equal(pastes.length, 1, 'one paste carries every image')
    assert.deepEqual(
      pastes[0].map(file => [file.name, file.type]),
      [
        ['note-image-0.png', 'image/png'],
        ['note-image-1.jpg', 'image/jpeg']
      ]
    )
    assert.deepEqual(focused, ['sess-1'], 'the composer is focused after the paste')
    assert.deepEqual(notices, [])
  })

  it('retries a dropped paste and succeeds without an error', async () => {
    const inserts = []
    const pastes = []
    const focused = []
    const notices = []
    const delays = []
    let attempt = 0

    const ok = await putInComposerWithImages(
      { body: 'hello', images: IMAGES },
      {
        dispatchPaste: files => {
          pastes.push(files)
          attempt += 1

          return attempt >= 3
        },
        focus: sid => focused.push(sid),
        insertText: (sid, body, options) => {
          inserts.push([sid, body, options])

          return true
        },
        notify: message => notices.push(message),
        setTimeout: (fn, ms) => {
          delays.push(ms)
          fn()

          return () => {}
        },
        sid: 'sess-1'
      }
    )

    assert.equal(ok, true)
    assert.equal(pastes.length, 3, 'false, false, true is three paste attempts')
    assert.equal(inserts.length, 1, 'the text goes in once, never again on a retry')
    assert.deepEqual(delays, [250, 250], 'the attempts are 250 ms apart')
    assert.deepEqual(notices, [], 'no error when a retry lands')
    assert.deepEqual(focused, ['sess-1'], 'the composer is focused after the paste lands')
  })

  it('notifies and does not focus when the paste is not handled', async () => {
    const inserts = []
    const pastes = []
    const focused = []
    const notices = []

    const ok = await putInComposerWithImages(
      { body: 'hello', images: IMAGES },
      {
        dispatchPaste: files => {
          pastes.push(files)

          return false
        },
        focus: sid => focused.push(sid),
        insertText: (sid, body, options) => {
          inserts.push([sid, body, options])

          return true
        },
        notify: message => notices.push(message),
        setTimeout: fn => {
          fn()

          return () => {}
        },
        sid: 'sess-1'
      }
    )

    assert.equal(ok, false)
    assert.equal(pastes.length, 5, 'the first attempt plus four retries')
    assert.equal(inserts.length, 1, 'the text goes in once, never again on a retry')
    assert.deepEqual(notices, ['putInComposerImagesFailedWithText'], 'the text already went in, so the message says so')
    assert.deepEqual(focused, [], 'no focus when the images did not land')
  })

  it('does not insert text for an images-only note', async () => {
    const inserts = []
    const pastes = []

    const ok = await putInComposerWithImages(
      { body: '', images: IMAGES },
      {
        dispatchPaste: files => {
          pastes.push(files)

          return true
        },
        focus: () => {},
        insertText: (sid, body) => {
          inserts.push(body)

          return true
        },
        notify: () => {},
        sid: 'sess-1'
      }
    )

    assert.equal(ok, true)
    assert.deepEqual(inserts, [], 'there is no text to insert')
    assert.equal(pastes[0].length, 2)
  })

  it('notifies composerFailed and dispatches no paste when insertText returns false', async () => {
    const pastes = []
    const notices = []

    const ok = await putInComposerWithImages(
      { body: 'hello', images: IMAGES },
      {
        dispatchPaste: files => {
          pastes.push(files)

          return true
        },
        focus: () => {},
        insertText: () => false,
        notify: message => notices.push(message),
        sid: 'sess-1'
      }
    )

    assert.equal(ok, false)
    assert.deepEqual(notices, ['composerFailed'])
    assert.deepEqual(pastes, [], 'no paste is attempted after a failed insert')
  })
})

/** Deterministic timers: nothing fires until `run()` / `tick()`. */
function fakeTimers() {
  let nextId = 1
  const timers = new Map()
  const intervals = new Map()

  return {
    clearIntervalFn: id => intervals.delete(id),
    clearTimeoutFn: id => timers.delete(id),
    intervals: () => intervals.size,
    pending: () => timers.size,
    pendingMs: () => [...timers.values()].map(entry => entry.ms),
    run: () => {
      const armed = [...timers.values()]
      timers.clear()

      for (const entry of armed) {
        entry.fn()
      }
    },
    setIntervalFn: (fn, ms) => {
      const id = nextId
      nextId += 1
      intervals.set(id, { fn, ms })

      return id
    },
    setTimeoutFn: (fn, ms) => {
      const id = nextId
      nextId += 1
      timers.set(id, { fn, ms })

      return id
    },
    tick: () => {
      for (const entry of [...intervals.values()]) {
        entry.fn()
      }
    }
  }
}

describe('send queue', () => {
  it('never submits into a busy session, then submits once after idle + settle and marks sent only when the turn starts', () => {
    const submitted = []
    const events = []
    const timers = fakeTimers()
    let busy = { s1: true }

    const queue = createSendQueue({
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: sid => Boolean(busy[sid]),
      onEvent: event => events.push(event),
      setTimeoutFn: timers.setTimeoutFn,
      submit: (sid, body) => {
        submitted.push([sid, body])
        busy = { ...busy, [sid]: true }

        return true
      }
    })

    queue.enqueue({ body: 'first', id: 'n1' }, 's1')

    assert.deepEqual(submitted, [], 'a busy target must not receive the note')
    assert.equal(timers.pending(), 0, 'no settle timer is armed while busy')

    busy = { s1: false }
    queue.onBusyChange(busy)

    assert.deepEqual(submitted, [], 'the idle flip alone must not submit')
    assert.equal(timers.pending(), 1, 'the settle delay is armed')

    timers.run()

    assert.deepEqual(submitted, [['s1', 'first']])
    assert.deepEqual(events, [], 'submit returning true alone must not mark sent')
    assert.deepEqual(timers.pendingMs(), [8000], 'the delivery confirmation is armed for 8 s')

    // A fast turn still flips busy true momentarily: that flip is the proof.
    busy = { s1: true }
    queue.onBusyChange(busy)

    assert.deepEqual(events, [{ noteId: 'n1', profile: 'default', sid: 's1', type: 'sent' }])
    assert.equal(queue.pending('s1'), 0)
    assert.equal(timers.pending(), 0, 'confirming cancels its own timeout')

    queue.onBusyChange({ s1: true })

    assert.equal(events.length, 1, 'sent is emitted exactly once')
  })

  it('keeps FIFO order: the second note waits for the second idle transition, each confirmed by its turn', () => {
    const submitted = []
    const events = []
    const timers = fakeTimers()
    let busy = { s1: true }

    const queue = createSendQueue({
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: sid => Boolean(busy[sid]),
      onEvent: event => events.push(event),
      setTimeoutFn: timers.setTimeoutFn,
      submit: (sid, body) => {
        submitted.push(body)
        busy = { ...busy, [sid]: true }

        return true
      }
    })

    queue.enqueue({ body: 'one', id: 'n1' }, 's1')
    queue.enqueue({ body: 'two', id: 'n2' }, 's1')

    busy = { s1: false }
    queue.onBusyChange(busy)
    timers.run()

    assert.deepEqual(submitted, ['one'], 'only the head note goes on the first idle transition')

    busy = { s1: true }
    queue.onBusyChange(busy)

    assert.deepEqual(events.map(event => event.type), ['sent'], 'the first note is confirmed by its turn')

    timers.run()

    assert.deepEqual(submitted, ['one'], 'the second note must not ride the same transition')

    busy = { s1: false }
    queue.onBusyChange(busy)

    assert.deepEqual(submitted, ['one'], 'the settle delay still stands between transitions')

    timers.run()

    assert.deepEqual(submitted, ['one', 'two'])

    busy = { s1: true }
    queue.onBusyChange(busy)

    assert.deepEqual(events.map(event => event.type), ['sent', 'sent'])
    assert.equal(queue.pending('s1'), 0)
  })

  it('holds a note as waiting when submit returns false, with no failure event and one submit', () => {
    const submitted = []
    const events = []
    const timers = fakeTimers()

    const queue = createSendQueue({
      clearIntervalFn: timers.clearIntervalFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: () => false,
      onEvent: event => events.push(event),
      setIntervalFn: timers.setIntervalFn,
      setTimeoutFn: timers.setTimeoutFn,
      submit: (sid, body) => {
        submitted.push([sid, body])

        return false
      }
    })

    queue.enqueue({ body: 'x', id: 'n1' }, 's1', 'default')
    queue.enqueue({ body: 'y', id: 'n2' }, 's1', 'default')
    timers.run()

    assert.deepEqual(submitted, [['s1', 'x']], 'only the head note is attempted')
    assert.deepEqual(events, [{ noteId: 'n1', profile: 'default', sid: 's1', type: 'waiting' }])
    assert.equal(queue.pending('s1'), 2, 'the waiting head and the note behind it stay queued')
    assert.equal(timers.intervals(), 1, 'the retry interval runs while a note waits')
  })

  it('sends a waiting note once on a retry after the 1.5 s focus settle, then the next note waits for the next idle transition', () => {
    const submitted = []
    const events = []
    const timers = fakeTimers()
    let ok = false
    let busy = {}

    const queue = createSendQueue({
      clearIntervalFn: timers.clearIntervalFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: sid => Boolean(busy[sid]),
      onEvent: event => events.push(event),
      setIntervalFn: timers.setIntervalFn,
      setTimeoutFn: timers.setTimeoutFn,
      submit: (sid, body) => {
        submitted.push(body)

        return ok
      }
    })

    queue.enqueue({ body: 'one', id: 'n1' }, 's1', 'default')
    queue.enqueue({ body: 'two', id: 'n2' }, 's1', 'default')
    timers.run()

    assert.deepEqual(submitted, ['one'], 'the first attempt fails')
    assert.equal(queue.pending('s1'), 2)

    ok = true
    queue.onFocusChange(['s1'])

    assert.deepEqual(submitted, ['one'], 'a just-opened chat is not retried immediately')
    assert.deepEqual(timers.pendingMs(), [1500], 'the retry is scheduled 1.5 s out')

    timers.run()

    assert.deepEqual(submitted, ['one', 'one'], 'the retry submits the waiting head')
    assert.deepEqual(events, [
      { noteId: 'n1', profile: 'default', sid: 's1', type: 'waiting' }
    ], 'submit true alone does not mark sent')

    busy = { s1: true }
    queue.onBusyChange(busy)

    assert.deepEqual(events.at(-1), { noteId: 'n1', profile: 'default', sid: 's1', type: 'sent' })
    assert.equal(queue.pending('s1'), 1, 'the sent note leaves the queue exactly once')
    assert.equal(timers.intervals(), 0, 'the retry interval stops when nothing waits')

    queue.onFocusChange(['s1'])

    assert.deepEqual(submitted, ['one', 'one'], 'the second note must not ride the same retry')

    busy = { s1: false }
    queue.onBusyChange(busy)

    assert.deepEqual(submitted, ['one', 'one'], 'the next note waits for the next idle transition')

    timers.run()

    assert.deepEqual(submitted, ['one', 'one', 'two'], 'the next note waits for the next idle transition')

    busy = { s1: true }
    queue.onBusyChange(busy)

    assert.equal(queue.pending('s1'), 0)
  })

  it('leaves the entry waiting when submit returns true but the session never starts a turn within 8 s', () => {
    const events = []
    const timers = fakeTimers()

    const queue = createSendQueue({
      clearIntervalFn: timers.clearIntervalFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: () => false,
      onEvent: event => events.push(event),
      setIntervalFn: timers.setIntervalFn,
      setTimeoutFn: timers.setTimeoutFn,
      submit: () => true
    })

    queue.enqueue({ body: 'x', id: 'n1' }, 's1', 'default')
    timers.run()

    assert.deepEqual(events, [], 'submit true alone must not mark sent')
    assert.deepEqual(timers.pendingMs(), [8000])

    timers.run()

    assert.deepEqual(events, [{ noteId: 'n1', profile: 'default', sid: 's1', type: 'waiting' }])
    assert.equal(events.some(event => event.type === 'sent'), false, 'an unconfirmed submit is never sent')
    assert.equal(queue.pending('s1'), 1, 'the note stays at the head of the FIFO')
  })

  it('marks sent exactly once when the busy map flips true after a submit', () => {
    const events = []
    const timers = fakeTimers()

    const queue = createSendQueue({
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: () => false,
      onEvent: event => events.push(event),
      setTimeoutFn: timers.setTimeoutFn,
      submit: () => true
    })

    queue.enqueue({ body: 'x', id: 'n1' }, 's1', 'default')
    timers.run()

    queue.onBusyChange({ s1: true })
    queue.onBusyChange({ s1: true })
    queue.onBusyChange({})

    assert.deepEqual(events, [{ noteId: 'n1', profile: 'default', sid: 's1', type: 'sent' }])
    assert.equal(queue.pending('s1'), 0)
  })

  it('marks sent exactly once when session.info reports the turn running', () => {
    const events = []
    const timers = fakeTimers()

    const queue = createSendQueue({
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: () => false,
      onEvent: event => events.push(event),
      setTimeoutFn: timers.setTimeoutFn,
      submit: () => true
    })

    queue.enqueue({ body: 'x', id: 'n1' }, 's1', 'default')
    timers.run()

    queue.onSessionInfo({ session_id: 's1', type: 'session.info', payload: { running: true } })
    queue.onSessionInfo({ session_id: 's1', type: 'session.info', payload: { running: true } })

    assert.deepEqual(events, [{ noteId: 'n1', profile: 'default', sid: 's1', type: 'sent' }])
    assert.equal(queue.pending('s1'), 0)
  })

  it('does not submit again from any retry trigger while an entry is confirming', () => {
    const submitted = []
    const timers = fakeTimers()

    const queue = createSendQueue({
      clearIntervalFn: timers.clearIntervalFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: () => false,
      setIntervalFn: timers.setIntervalFn,
      setTimeoutFn: timers.setTimeoutFn,
      submit: (sid, body) => {
        submitted.push(body)

        return true
      }
    })

    queue.enqueue({ body: 'x', id: 'n1' }, 's1', 'default')
    timers.run()

    assert.deepEqual(submitted, ['x'])

    queue.onFocusChange(['s1'])
    queue.onBusyChange({})
    timers.tick()

    assert.deepEqual(submitted, ['x'], 'no retry may submit a confirming entry again')
    assert.equal(timers.pending(), 1, 'only the confirmation timeout is armed')

    // Unconfirmed after 8 s: back to waiting, and only then may a retry submit.
    timers.run()

    queue.onFocusChange(['s1'])
    timers.run()

    assert.deepEqual(submitted, ['x', 'x'], 'a retry after the timeout submits again')
  })

  it('schedules the retry 1.5 s after focus moves to the target, and cancels it when focus moves away', () => {
    const submitted = []
    const timers = fakeTimers()

    const queue = createSendQueue({
      clearIntervalFn: timers.clearIntervalFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: () => false,
      setIntervalFn: timers.setIntervalFn,
      setTimeoutFn: timers.setTimeoutFn,
      submit: (sid, body) => {
        submitted.push(body)

        return false
      }
    })

    queue.enqueue({ body: 'x', id: 'n1' }, 's1', 'default')
    timers.run()

    assert.deepEqual(submitted, ['x'])

    queue.onFocusChange(['s1'])

    assert.deepEqual(submitted, ['x'], 'focus alone must not retry immediately')
    assert.deepEqual(timers.pendingMs(), [1500])

    queue.onFocusChange(['other'])

    assert.deepEqual(timers.pendingMs(), [], 'focus moving away cancels the retry')
    assert.deepEqual(submitted, ['x'])

    queue.onFocusChange(['s1'])
    timers.run()

    assert.deepEqual(submitted, ['x', 'x'], 'the retry fires after the 1.5 s settle')
  })

  it('cancels a waiting note back to active and never submits it again', () => {
    const submitted = []
    const events = []
    const timers = fakeTimers()

    const queue = createSendQueue({
      clearIntervalFn: timers.clearIntervalFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: () => false,
      onEvent: event => events.push(event),
      setIntervalFn: timers.setIntervalFn,
      setTimeoutFn: timers.setTimeoutFn,
      submit: (sid, body) => {
        submitted.push(body)

        return false
      }
    })

    queue.enqueue({ body: 'x', id: 'n1' }, 's1', 'default')
    timers.run()

    assert.equal(queue.pending('s1'), 1)

    assert.equal(queue.cancel('n1'), true)
    assert.deepEqual(events, [
      { noteId: 'n1', profile: 'default', sid: 's1', type: 'waiting' },
      { noteId: 'n1', sid: 's1', type: 'cancelled' }
    ])
    assert.equal(queue.pending('s1'), 0)
    assert.equal(timers.intervals(), 0, 'cancelling the only waiting note stops the interval')

    queue.onFocusChange()
    queue.onBusyChange({})
    timers.tick()
    timers.run()

    assert.deepEqual(submitted, ['x'], 'no submit attempt after the cancel')
  })
})

/** Register the real plugin against a fake ctx and return the stash handle. */
function registerStash({ files, submit, setInterval: setIntervalOverride, setTimeout: setTimeoutOverride }) {
  const contributions = []
  const disposers = []
  const events = {}
  const storage = new Map()

  sdk.host.composer.submit = submit

  const ctx = {
    files: files ?? undefined, // default: force the ctx.storage persistence path
    i18n: {
      register: () => {},
      t: key => String(key)
    },
    onDispose: disposer => disposers.push(disposer),
    onEvent: (type, handler) => {
      events[type] = handler

      return () => {}
    },
    register: contribution => contributions.push(contribution),
    setInterval: setIntervalOverride ?? (() => () => {}),
    // Default: fire immediately, so the queue's settle delay runs synchronously.
    setTimeout:
      setTimeoutOverride ??
      (fn => {
        fn()

        return () => {}
      }),
    storage: {
      get: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
      set: (key, value) => storage.set(key, value)
    }
  }

  plugin.register(ctx)

  const pane = contributions.find(contribution => contribution.id === 'pane')

  return { disposers, events, pane, stash: pane.render().props.stash }
}

/** ctx.setTimeout/setInterval backed by the fake clock, as callable handles. */
function fakeCtxTimers(timers) {
  return {
    setInterval: (fn, ms) => {
      const id = timers.setIntervalFn(fn, ms)

      return () => timers.clearIntervalFn(id)
    },
    setTimeout: (fn, ms) => {
      const id = timers.setTimeoutFn(fn, ms)

      return () => timers.clearTimeoutFn(id)
    }
  }
}

describe('app send paths', () => {
  it('reports failure and leaves the note active on the immediate manual path', () => {
    const notifications = []
    sdk.host.notify = notification => notifications.push(notification)
    sdk.host.state.focusedSessionId.set('sess-1')
    sdk.host.state.busyBySession.set({})

    const { disposers, stash } = registerStash({ submit: () => false })
    const note = stash.addNote({ body: 'manual', title: 'Manual' })

    stash.send(note)

    assert.equal(notifications.length, 1, 'the immediate path still reports the failure')
    assert.equal(notifications[0].message, 'sendFailed')
    assert.equal(stash.$notes.get()[0].status, 'active', 'the note stays active')

    for (const disposer of disposers) {
      disposer()
    }
  })

  it('marks a queued note waiting when its chat is off screen, then sends it once its chat starts a turn', () => {
    const notifications = []
    const submitted = []
    const timers = fakeTimers()
    let ok = false
    sdk.host.notify = notification => notifications.push(notification)
    sdk.host.state.focusedSessionId.set('sess-1')
    sdk.host.state.focusedStoredSessionId.set(null)
    sdk.host.state.busyBySession.set({})

    const { disposers, stash } = registerStash({
      submit: (sid, body) => {
        submitted.push(body)

        return ok
      },
      ...fakeCtxTimers(timers)
    })
    const note = stash.addNote({ body: 'later', title: 'Later' })

    sdk.host.state.busyBySession.set({ 'sess-1': true })
    stash.send(note)

    assert.equal(stash.$notes.get()[0].status, 'queued')

    // Turn ends while the user is on another chat: submit is fail-closed.
    sdk.host.state.busyBySession.set({})
    timers.run()

    assert.equal(stash.$notes.get()[0].status, 'waiting')
    assert.equal(stash.$notes.get()[0].sid, 'sess-1', 'the target chat is recorded')
    assert.equal(stash.$notes.get()[0].profile, 'default', 'the target profile is recorded')
    assert.deepEqual(notifications, [], 'waiting is silent')

    ok = true
    sdk.host.state.focusedSessionId.set('sess-1')

    assert.deepEqual(submitted, ['later'], 'a just-opened chat is not retried immediately')
    assert.deepEqual(timers.pendingMs().filter(ms => ms > 750), [1500], 'the retry is scheduled 1.5 s out')
    assert.equal(stash.$notes.get()[0].status, 'waiting', 'the row keeps showing Waiting')

    timers.run()

    assert.deepEqual(submitted, ['later', 'later'])
    assert.equal(stash.$notes.get()[0].status, 'waiting', 'submit true alone must not mark sent')
    assert.deepEqual(notifications, [], 'an unconfirmed submit is silent')

    // The chat starts its turn: that is the proof of delivery.
    sdk.host.state.busyBySession.set({ 'sess-1': true })

    assert.equal(stash.$notes.get()[0].status, 'sent', 'the retry sends it once')
    assert.equal(stash.$notes.get()[0].sentTo, 'sess-1')

    for (const disposer of disposers) {
      disposer()
    }
  })

  it('returns an unconfirmed queued submit to waiting after 8 s, with no error', () => {
    const notifications = []
    const timers = fakeTimers()
    sdk.host.notify = notification => notifications.push(notification)
    sdk.host.state.focusedSessionId.set('sess-1')
    sdk.host.state.busyBySession.set({})

    const { disposers, stash } = registerStash({
      submit: () => true,
      ...fakeCtxTimers(timers)
    })
    const note = stash.addNote({ body: 'later', title: 'Later' })

    sdk.host.state.busyBySession.set({ 'sess-1': true })
    stash.send(note)
    sdk.host.state.busyBySession.set({})
    timers.run()

    assert.equal(stash.$notes.get()[0].status, 'queued', 'the row keeps showing Queued while confirming')

    timers.run()

    assert.equal(stash.$notes.get()[0].status, 'waiting', 'the submit did not reach the session')
    assert.equal(stash.$notes.get()[0].status === 'sent', false)
    assert.deepEqual(notifications, [], 'a waiting note is silent')

    for (const disposer of disposers) {
      disposer()
    }
  })

  it('reports failure and leaves the note active when an immediate submit is never confirmed', () => {
    const notifications = []
    const timers = fakeTimers()
    sdk.host.notify = notification => notifications.push(notification)
    sdk.host.state.focusedSessionId.set('sess-1')
    sdk.host.state.busyBySession.set({})

    const { disposers, stash } = registerStash({
      submit: () => true,
      ...fakeCtxTimers(timers)
    })
    const note = stash.addNote({ body: 'manual', title: 'Manual' })

    stash.send(note)

    assert.equal(stash.$notes.get()[0].status, 'active', 'submit true alone must not mark sent')
    assert.deepEqual(timers.pendingMs().filter(ms => ms > 750), [8000])

    timers.run()

    assert.equal(stash.$notes.get()[0].status, 'active', 'the note returns to Active')
    assert.equal(notifications.length, 1, 'the silent drop is visible on the manual path')
    assert.equal(notifications[0].message, 'sendFailed')

    for (const disposer of disposers) {
      disposer()
    }
  })

  it('cancels a waiting note back to active and stops retrying it', () => {
    const submitted = []
    const timers = fakeTimers()
    sdk.host.notify = () => {}
    sdk.host.state.focusedSessionId.set('sess-1')
    sdk.host.state.busyBySession.set({})

    const { disposers, stash } = registerStash({
      submit: (sid, body) => {
        submitted.push(body)

        return false
      },
      ...fakeCtxTimers(timers)
    })
    const note = stash.addNote({ body: 'later', title: 'Later' })

    sdk.host.state.busyBySession.set({ 'sess-1': true })
    stash.send(note)
    sdk.host.state.busyBySession.set({})
    timers.run()

    assert.equal(stash.$notes.get()[0].status, 'waiting')

    stash.cancelQueued(note.id)

    assert.equal(stash.$notes.get()[0].status, 'active')
    assert.deepEqual(stash.$notes.get()[0].sid, undefined, 'the target chat is cleared')

    const attempts = submitted.length
    sdk.host.state.focusedSessionId.set('sess-2')
    sdk.host.state.busyBySession.set({})
    timers.run()

    assert.equal(submitted.length, attempts, 'no submit attempt after the cancel')

    for (const disposer of disposers) {
      disposer()
    }
  })
})

describe('put in composer', () => {
  /** A stash whose text insert succeeds and whose session.info handler is captured. */
  function composingStash(timers, extra = {}) {
    sdk.host.notify = () => {}
    sdk.host.state.focusedSessionId.set('sess-1')
    sdk.host.state.focusedStoredSessionId.set(null)
    sdk.host.state.busyBySession.set({})
    sdk.host.composer.insertText = async () => true

    return registerStash({ submit: () => true, ...fakeCtxTimers(timers), ...extra })
  }

  it('moves a prefixed note to Sent once when its own prompt is pending', async () => {
    const timers = fakeTimers()
    const { disposers, events, stash } = composingStash(timers)
    const body = 'Refactor the send queue so a note is only sent after the chat starts a turn'
    const note = stash.addNote({ body, title: 'Queue' })

    await stash.putInComposer(note)

    assert.equal(stash.$notes.get()[0].status, 'active', 'Put in composer alone does not send')
    assert.deepEqual(stash.$composing.get().map(record => record.noteId), [note.id])
    assert.equal(stash.$composing.get()[0].sid, 'sess-1')
    assert.equal(stash.$composing.get()[0].prefix, body.slice(0, 40))

    events['session.info']({
      session_id: 'sess-1',
      payload: { pending: [{ text: `${body} and more` }] }
    })

    assert.equal(stash.$notes.get()[0].status, 'sent')
    assert.equal(stash.$notes.get()[0].sentTo, 'sess-1')
    assert.deepEqual(stash.$composing.get(), [], 'the record is cleared')

    const sentAt = stash.$notes.get()[0].sentAt

    events['session.info']({
      session_id: 'sess-1',
      payload: { pending: [{ text: body }] }
    })

    assert.equal(stash.$notes.get()[0].sentAt, sentAt, 'a second matching event does not re-send')

    for (const disposer of disposers) {
      disposer()
    }
  })

  it('leaves a prefixed note active when the pending prompt or a busy flip does not match', async () => {
    const timers = fakeTimers()
    const { disposers, events, stash } = composingStash(timers)
    const note = stash.addNote({ body: 'the exact prompt text', title: 'Prompt' })

    await stash.putInComposer(note)

    events['session.info']({
      session_id: 'sess-1',
      payload: { pending: [{ text: 'a different prompt' }] }
    })

    assert.equal(stash.$notes.get()[0].status, 'active', 'a non-matching prompt is not proof')
    assert.equal(stash.$composing.get().length, 1)

    sdk.host.state.busyBySession.set({ 'sess-1': true })

    assert.equal(stash.$notes.get()[0].status, 'active', 'a busy flip alone does not confirm a prefixed note')
    assert.equal(stash.$composing.get().length, 1)

    for (const disposer of disposers) {
      disposer()
    }
  })

  it('moves an images-only note to Sent once when the chat starts a turn', async () => {
    const timers = fakeTimers()
    const files = {
      dataFolder: 'data',
      list: async () => ({ files: [], ok: true }),
      readText: async () => ({ ok: true, text: 'data:image/png;base64,iVBORw0KGgo=' }),
      stat: async () => ({ ok: true }),
      trash: async () => ({ ok: true }),
      writeText: async () => ({ ok: true })
    }
    const { disposers, stash } = composingStash(timers, { files })
    const note = stash.addNote({
      images: [{ bytes: 8, file: 'img-note-img-0.txt', h: 2, mime: 'image/png', w: 3 }],
      title: 'Images only'
    })

    // Desktop's paste path needs the browser globals dispatchImagePaste uses.
    const original = {
      ClipboardEvent: globalThis.ClipboardEvent,
      DataTransfer: globalThis.DataTransfer,
      window: globalThis.window
    }

    globalThis.DataTransfer = class {
      constructor() {
        this.items = { add: () => {} }
      }
    }
    globalThis.ClipboardEvent = class {
      constructor() {
        this.defaultPrevented = true
      }
    }
    globalThis.window = { dispatchEvent: () => {} }

    try {
      await stash.putInComposerImages(note)

      assert.equal(stash.$notes.get()[0].status, 'active')
      assert.equal(stash.$composing.get()[0].prefix, '', 'an images-only note has no text prefix')

      sdk.host.state.busyBySession.set({ 'sess-1': true })

      assert.equal(stash.$notes.get()[0].status, 'sent')
      assert.equal(stash.$notes.get()[0].sentTo, 'sess-1')
      assert.deepEqual(stash.$composing.get(), [])

      const sentAt = stash.$notes.get()[0].sentAt

      sdk.host.state.busyBySession.set({})
      sdk.host.state.busyBySession.set({ 'sess-1': true })

      assert.equal(stash.$notes.get()[0].sentAt, sentAt, 'a later turn does not re-send')
    } finally {
      globalThis.ClipboardEvent = original.ClipboardEvent
      globalThis.DataTransfer = original.DataTransfer
      globalThis.window = original.window
    }

    for (const disposer of disposers) {
      disposer()
    }
  })

  it('clears the composing record silently after ten minutes', async () => {
    const timers = fakeTimers()
    const notifications = []
    const { disposers, stash } = composingStash(timers)
    const note = stash.addNote({ body: 'timeout note', title: 'Timeout' })

    sdk.host.notify = notification => notifications.push(notification)

    await stash.putInComposer(note)

    assert.equal(stash.$composing.get().length, 1)
    assert.ok(timers.pendingMs().includes(600000), 'the ten-minute timer is armed')

    timers.run()

    assert.deepEqual(stash.$composing.get(), [])
    assert.equal(stash.$notes.get()[0].status, 'active', 'the note stays Active')
    assert.deepEqual(notifications, [], 'the timeout is silent')

    for (const disposer of disposers) {
      disposer()
    }
  })

  it('replaces the record when another note is put in the composer for the same chat', async () => {
    const timers = fakeTimers()
    const { disposers, stash } = composingStash(timers)
    const first = stash.addNote({ body: 'first note', title: 'First' })
    const second = stash.addNote({ body: 'second note', title: 'Second' })

    await stash.putInComposer(first)
    await stash.putInComposer(second)

    assert.deepEqual(stash.$composing.get().map(record => record.noteId), [second.id])
    assert.equal(stash.$notes.get().find(note => note.id === first.id).status, 'active')
    assert.equal(stash.$notes.get().find(note => note.id === second.id).status, 'active')

    for (const disposer of disposers) {
      disposer()
    }
  })
})

/** Invoke one component element; a stub component returning null stays itself. */
function renderElement(element) {
  if (!element || typeof element !== 'object') {
    return element
  }

  if (typeof element.type === 'function') {
    const rendered = element.type(element.props)

    return rendered == null ? element : rendered
  }

  return element
}

/** Render every component in the tree, keeping stub components as their nodes. */
function renderDeep(element) {
  const rendered = renderElement(element)
  const children = rendered?.props?.children

  if (!children) {
    return rendered
  }

  const list = Array.isArray(children) ? children : [children]
  const next = list.map(child => (child && typeof child === 'object' ? renderDeep(child) : child))

  return {
    ...rendered,
    props: { ...rendered.props, children: Array.isArray(children) ? next : next[0] }
  }
}

/** Depth-first walk of a rendered element tree, visiting raw element nodes. */
function findElements(element, predicate) {
  const found = []

  const visit = node => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (predicate(node)) {
      found.push(node)
    }

    const children = node.props?.children

    for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
      visit(child)
    }
  }

  visit(element)

  return found
}

/** A files fake: notes.json and image files share one in-memory folder. */
function fakeFiles() {
  const written = new Map()
  const trashed = []

  return {
    files: {
      dataFolder: 'data',
      readText: async (folder, file) =>
        written.has(file) ? { ok: true, text: written.get(file) } : { ok: false, error: 'not-found' },
      trash: async (folder, file) => {
        trashed.push(file)

        return { ok: true }
      },
      writeText: async (folder, file, text) => {
        written.set(file, text)

        return { ok: true }
      }
    },
    trashed
  }
}

/** Let the image store's voided trash/read promises settle. */
const flushAsync = () => new Promise(resolve => setImmediate(resolve))

describe('editor image removal', () => {
  const IMAGE = { bytes: 8, file: 'img-note-a-0.txt', h: 2, mime: 'image/png', w: 3 }

  it('removing a thumbnail only drops it locally; Cancel trashes nothing and leaves the note', async () => {
    const { files, trashed } = fakeFiles()
    const { pane, stash } = registerStash({ files, submit: () => false })
    const note = stash.addNote({ body: 'keep', images: [IMAGE], title: 'Image note' })
    const discards = []
    const original = stash.discardImages

    stash.discardImages = images => {
      discards.push(images)
      original(images)
    }

    // Render the row in its editing state, then the editor's thumbnail grid.
    const paneTree = renderElement(pane.render())
    const row = findElements(paneTree, node => node.props?.note?.id === note.id)[0]
    const editorTree = renderDeep({ type: row.type, props: { ...row.props, editing: true } })
    const remove = findElements(
      editorTree,
      node => node.type === 'button' && node.props['aria-label'] === 'imageRemoveFromNote'
    )

    assert.equal(remove.length, 1, 'the thumbnail remove button is labelled for the note')
    assert.equal(remove[0].props.title, 'imageRemoveFromNote', 'the native title carries the same label')

    remove[0].props.onClick(IMAGE)
    await flushAsync()

    assert.deepEqual(discards, [], 'removing a thumbnail does not trash the file')
    assert.deepEqual(trashed, [], 'no file is moved to the trash')

    const cancel = findElements(
      editorTree,
      node => node.type === sdk.Button && node.props.children === 'cancel'
    )[0]

    cancel.props.onClick()
    await flushAsync()

    assert.deepEqual(trashed, [], 'Cancel leaves the note’s original image file alone')
    assert.deepEqual(stash.$notes.get()[0].images, [IMAGE], 'Cancel leaves the note unchanged')
  })

  it('saving a patch without the image trashes it exactly once and updates the note', async () => {
    const { files, trashed } = fakeFiles()
    const { stash } = registerStash({ files, submit: () => false })
    const note = stash.addNote({ body: 'keep', images: [IMAGE], title: 'Image note' })

    await flushAsync()
    assert.deepEqual(trashed, [], 'adding a note does not trash its image')

    stash.edit(note.id, { body: 'keep', images: [], title: 'Image note' })
    await flushAsync()

    assert.deepEqual(trashed, [IMAGE.file], 'exactly one trash call for the dropped image')
    assert.deepEqual(stash.$notes.get()[0].images, [], 'the note no longer references the image')
  })

  it('saving an identical patch trashes nothing', async () => {
    const { files, trashed } = fakeFiles()
    const { stash } = registerStash({ files, submit: () => false })
    const note = stash.addNote({ body: 'keep', images: [IMAGE], title: 'Image note' })

    stash.edit(note.id, { body: 'keep', images: [IMAGE], title: 'Image note' })
    await flushAsync()

    assert.deepEqual(trashed, [], 'an image kept by the patch is not trashed')
    assert.deepEqual(stash.$notes.get()[0].images, [IMAGE])
  })
})

describe('empty notes', () => {
  it('send refuses silently: no submit and no notification', () => {
    const submitted = []
    const notifications = []

    sdk.host.notify = notification => notifications.push(notification)
    sdk.host.state.focusedSessionId.set('sess-1')

    const { stash } = registerStash({
      submit: (sid, body) => {
        submitted.push(body)

        return true
      }
    })

    stash.send({ body: '   ', createdAt: 1, id: 'empty', status: 'active', title: '', updatedAt: 1 })

    assert.deepEqual(submitted, [], 'nothing is submitted')
    assert.deepEqual(notifications, [], 'the refusal is silent')
  })
})

describe('row actions', () => {
  it('Delete is rendered for active, sent and empty rows without hover; empty Send is disabled', () => {
    const { pane, stash } = registerStash({ submit: () => false })
    const active = stash.addNote({ body: 'active note', title: 'Active' })
    const empty = { body: '', createdAt: 2, id: 'empty-note', status: 'active', title: '', updatedAt: 2 }
    const sent = {
      body: 'sent note',
      createdAt: 3,
      id: 'sent-note',
      sentAt: 4,
      sentTo: 's1',
      status: 'sent',
      title: 'Sent',
      updatedAt: 4
    }

    stash.$notes.set([active, empty, sent])

    const deleteCount = tree =>
      findElements(tree, node => typeof node.type === 'function' && node.props?.label === 'delete').length

    stash.$filter.set('active')
    const activeTree = renderElement(pane.render())

    for (const id of [active.id, empty.id]) {
      const row = findElements(activeTree, node => node.props?.note?.id === id)[0]
      const rendered = renderElement(row)

      assert.equal(deleteCount(rendered), 1, `Delete is present for ${id} without hover`)
      assert.ok(
        findElements(
          rendered,
          node => typeof node.props?.className === 'string' && node.props.className.includes('opacity-70')
        ).length > 0,
        'the secondary actions are muted, not hidden'
      )
    }

    const emptyRow = renderElement(findElements(activeTree, node => node.props?.note?.id === empty.id)[0])
    const emptySend = findElements(
      emptyRow,
      node => node.type === sdk.Button && node.props['aria-label'] === 'nothingToSend'
    )

    assert.equal(emptySend.length, 1, 'the empty row has a Send button')
    assert.equal(emptySend[0].props.disabled, true, 'the empty row’s Send is disabled')
    assert.equal(emptySend[0].props.title, 'nothingToSend', 'the native title explains why')
    assert.equal(
      findElements(emptyRow, node => node.type === sdk.Tip && node.props?.label === 'nothingToSend').length,
      0,
      'no Tip wrapper around the disabled Send'
    )

    stash.$filter.set('sent')
    const sentTree = renderElement(pane.render())
    const sentRow = renderElement(findElements(sentTree, node => node.props?.note?.id === sent.id)[0])

    assert.equal(deleteCount(sentRow), 1, 'Delete is present for a sent row without hover')
  })
})

describe('version', () => {
  it('matches plugin.yaml and package.json', async () => {
    const yaml = await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

    assert.equal(VERSION, pkg.version)
    assert.match(yaml, new RegExp(`^version: "${VERSION}"$`, 'm'))
  })
})

describe('note ids', () => {
  // The live bug: the capture dialog reused its draft id, so a text note saved
  // after an image note landed on the image note's id. One send then marked
  // both sent and one delete removed both, trashing the image note's file.
  it('appendNote never stores a duplicate id and keeps both notes', () => {
    const image = { bytes: 8, file: 'img-note-a-0.txt', h: 2, mime: 'image/png', w: 3 }
    const first = { body: '', createdAt: 1, id: 'note-a', images: [image], status: 'active', title: 'image test', updatedAt: 1 }
    const second = { body: 'text test', createdAt: 2, id: 'note-a', status: 'active', title: 'text test', updatedAt: 2 }

    const notes = appendNote(appendNote([], first), second)

    assert.equal(notes.length, 2, 'both notes are kept')
    assert.notEqual(notes[0].id, notes[1].id)
    assert.equal(notes[1].id, 'note-a', 'the existing note keeps its id')
    assert.equal(notes[0].body, 'text test')
    assert.deepEqual(notes[1].images, [image], 'image file names survive the fresh id')
  })

  it('load repairs duplicate ids: the first keeps its id, images stay', () => {
    const image = { bytes: 8, file: 'img-note-dup-0.txt', h: 2, mime: 'image/png', w: 3 }
    const text = JSON.stringify({
      notes: [
        { body: '', createdAt: 1, id: 'note-dup', images: [image], status: 'active', title: 'image test', updatedAt: 1 },
        { body: 'text test', createdAt: 2, id: 'note-dup', status: 'active', title: 'text test', updatedAt: 2 }
      ],
      version: 1
    })

    const notes = parseNotesFile(text)

    assert.equal(notes.length, 2, 'both notes survive the repair')
    assert.equal(notes[0].id, 'note-dup', 'the first occurrence keeps its id')
    assert.notEqual(notes[1].id, notes[0].id)
    assert.deepEqual(notes[0].images, [image], 'the image array is untouched')
    assert.equal(notes[1].body, 'text test')
  })

  it('setNoteStatus on one deduped note changes only that one', () => {
    const text = JSON.stringify({
      notes: [
        { body: 'image test', createdAt: 1, id: 'note-dup', status: 'active', title: 'image test', updatedAt: 1 },
        { body: 'text test', createdAt: 2, id: 'note-dup', status: 'active', title: 'text test', updatedAt: 2 }
      ],
      version: 1
    })
    const notes = parseNotesFile(text)
    const next = setNoteStatus(notes, notes[1].id, 'sent', { sentAt: 9, sentTo: 's1' })

    assert.equal(next[1].status, 'sent')
    assert.equal(next[1].sentAt, 9)
    assert.equal(next[0].status, 'active', 'the other note is untouched')
    assert.equal(next[0].sentAt, undefined)
  })
})

describe('persistence', () => {
  it('reverts a persisted queued or waiting note to active on load', () => {
    const text = JSON.stringify({
      notes: [
        { body: 'queued one', createdAt: 1, id: 'n1', status: 'queued', title: '', updatedAt: 2 },
        { body: 'waiting one', createdAt: 1, id: 'n3', profile: 'default', sid: 's1', status: 'waiting', title: '', updatedAt: 2 },
        { body: 'sent one', createdAt: 3, id: 'n2', sentAt: 5, sentTo: 's1', status: 'sent', title: 'Sent', updatedAt: 4 }
      ],
      version: 1
    })

    const notes = parseNotesFile(text)

    assert.equal(notes.length, 3)
    assert.equal(notes[0].status, 'active', 'an in-memory queue cannot survive a restart')
    assert.equal(notes[1].status, 'active', 'a waiting note must not auto-send after a restart')
    assert.equal(notes[2].status, 'sent')
    assert.equal(notes[2].sentTo, 's1')
    assert.equal(notes[2].sentAt, 5)
  })

  it('yields an empty store for a malformed or missing notes.json', () => {
    assert.deepEqual(parseNotesFile('{ not json'), [])
    assert.deepEqual(parseNotesFile(''), [])
    assert.deepEqual(parseNotesFile(undefined), [])
    assert.deepEqual(parseNotesFile('null'), [])
    assert.deepEqual(parseNotesFile('{"notes":"nope"}'), [])

    const mixed = parseNotesFile('{"version":1,"notes":[{"id":""},{"body":"x","id":"ok"}]}')

    assert.equal(mixed.length, 1)
    assert.equal(mixed[0].id, 'ok')
  })

  it('falls back to ctx.storage when a protected write fails, and the notes read back', async () => {
    const notices = []
    const saved = new Map()
    const notes = [{ body: 'protected one', createdAt: 1, id: 'n1', status: 'active', title: '', updatedAt: 1 }]

    // host.notify goes through the sdk stub; capture it via the stub host.
    const { host } = await import('@hermes/plugin-sdk')
    const original = host.notify
    host.notify = notice => notices.push(notice)

    try {
      // The real t formats the error into the message; asserting on the
      // interpolated error exercises the injected translator path.
      const t = (key, error) =>
        key === 'storageFallback'
          ? `Note Stash is saving notes in app storage (file save unavailable: ${error}).`
          : key

      const persistence = createPersistence(
        {
          files: {
            dataFolder: 'data',
            readText: async () => ({ ok: false, error: 'not-found' }),
            // The regression seen live: the data folder resolves `protected`,
            // so every file write is refused.
            writeText: async () => ({ ok: false, error: 'protected' })
          },
          // Returns a cancel handle (as ctx.setTimeout does); the timer fires
          // synchronously, flush() only needs the handle for cancellation.
          setTimeout: fn => {
            fn()

            return () => {}
          },
          storage: {
            get: (key, fallback) => (saved.has(key) ? saved.get(key) : fallback),
            set: (key, value) => saved.set(key, value)
          }
        },
        t
      )

      // Drive the public surface: schedule, then flush drains the debounce
      // timer and awaits the write.
      persistence.schedule(notes)
      await persistence.flush()
      const back = await persistence.read()

      assert.equal(back.length, 1, 'the notes must read back from ctx.storage')
      assert.equal(back[0].body, 'protected one')
      assert.equal(notices.length, 1, 'exactly one warning toast')
      assert.equal(notices[0].kind, 'warning')
      assert.match(notices[0].message, /app storage/)
      assert.match(notices[0].message, /protected/)

      // A later write stays on storage and must not warn again.
      persistence.schedule([...notes, { ...notes[0], body: 'two', id: 'n2' }])
      await persistence.flush()

      assert.equal(notices.length, 1, 'the fallback toast fires once per plugin lifetime')
      assert.equal(saved.get('notes').length, 2, 'the second save also lands in ctx.storage')
    } finally {
      host.notify = original
    }
  })
})
