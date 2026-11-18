/**
 * Note Stash tests — the behaviors that regress, not the getters.
 *
 * Contract per test:
 *  - send queue: a busy target is NEVER submitted into (steer-injection into a
 *    running turn is the whole point of the plugin); it submits exactly once
 *    after busy→idle plus the settle delay; two queued notes go FIFO, one per
 *    idle transition.
 *  - submit returning false reports failure and drops the note from the queue
 *    (the app layer reverts it to active).
 *  - load reverts a persisted `queued` note to `active`; a malformed or missing
 *    notes.json is an empty store and never throws.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installStubs } from './loader.mjs'

installStubs()

const {
  createPersistence,
  createSendQueue,
  parseNotesFile,
  previewFor,
  titleFromRows,
  titleUpdateFromEvent
} = await import('../desktop/plugin.js')

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

/** Deterministic timers: nothing fires until `run()`. */
function fakeTimers() {
  let nextId = 1
  const timers = new Map()

  return {
    clearTimeoutFn: id => timers.delete(id),
    pending: () => timers.size,
    run: () => {
      const armed = [...timers.values()]
      timers.clear()

      for (const entry of armed) {
        entry.fn()
      }
    },
    setTimeoutFn: (fn, ms) => {
      const id = nextId
      nextId += 1
      timers.set(id, { fn, ms })

      return id
    }
  }
}

describe('send queue', () => {
  it('never submits into a busy session, then submits once after idle + settle', () => {
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
    assert.deepEqual(events, [{ noteId: 'n1', sid: 's1', type: 'sent' }])
    assert.equal(queue.pending('s1'), 0)
  })

  it('keeps FIFO order: the second note waits for the second idle transition', () => {
    const submitted = []
    const timers = fakeTimers()
    let busy = { s1: true }

    const queue = createSendQueue({
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: sid => Boolean(busy[sid]),
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

    timers.run()

    assert.deepEqual(submitted, ['one'], 'the second note must not ride the same transition')

    busy = { s1: true }
    queue.onBusyChange(busy)
    busy = { s1: false }
    queue.onBusyChange(busy)

    assert.deepEqual(submitted, ['one'], 'the settle delay still stands between transitions')

    timers.run()

    assert.deepEqual(submitted, ['one', 'two'])
    assert.equal(queue.pending('s1'), 0)
  })

  it('reports failure and drops the note when submit returns false', () => {
    const events = []
    const timers = fakeTimers()

    const queue = createSendQueue({
      clearTimeoutFn: timers.clearTimeoutFn,
      isBusy: () => false,
      onEvent: event => events.push(event),
      setTimeoutFn: timers.setTimeoutFn,
      submit: () => false
    })

    queue.enqueue({ body: 'x', id: 'n1' }, 's1')
    queue.enqueue({ body: 'y', id: 'n2' }, 's1')
    timers.run()

    assert.deepEqual(events, [
      { noteId: 'n1', sid: 's1', type: 'failed' },
      { noteId: 'n2', sid: 's1', type: 'dropped' }
    ])
    assert.equal(queue.pending('s1'), 0, 'a failed submit must not retry in a loop')
  })
})

describe('persistence', () => {
  it('reverts a persisted queued note to active on load', () => {
    const text = JSON.stringify({
      notes: [
        { body: 'queued one', createdAt: 1, id: 'n1', status: 'queued', title: '', updatedAt: 2 },
        { body: 'sent one', createdAt: 3, id: 'n2', sentAt: 5, sentTo: 's1', status: 'sent', title: 'Sent', updatedAt: 4 }
      ],
      version: 1
    })

    const notes = parseNotesFile(text)

    assert.equal(notes.length, 2)
    assert.equal(notes[0].status, 'active', 'an in-memory queue cannot survive a restart')
    assert.equal(notes[1].status, 'sent')
    assert.equal(notes[1].sentTo, 's1')
    assert.equal(notes[1].sentAt, 5)
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
