/**
 * Image storage: one flat UTF-8 file per image in the plugin data folder,
 * holding exactly one data URL. `ctx.files.writeText` is UTF-8 only and capped
 * at 4 MiB, so the cap is enforced on the data URL BEFORE the write, and
 * notes.json carries only `{file, mime, bytes, w, h}` metadata.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installStubs } from './loader.mjs'

installStubs()

const {
  attachFilename,
  base64Bytes,
  createImageSender,
  createImageStore,
  createNote,
  createSendQueue,
  imageFileName,
  nextImageIndex,
  normalizeNote,
  parseImageDataUrl,
  parseNotesFile,
  sendTextFor,
  serializeNotes,
  validateImageDataUrl
} = await import('../desktop/plugin.js')

const sdk = await import('@hermes/plugin-sdk')


const TINY_PNG = 'data:image/png;base64,iVBORw0KGgo='
const TINY_PNG_BYTES = 8

/** A `ctx.files` fake that records every call; defaults are a working store. */
function fakeFiles({ readText, trash, writeText } = {}) {
  const calls = { readText: [], trash: [], writeText: [] }

  const files = {
    dataFolder: 'data',
    readText: async (folder, path) => {
      calls.readText.push([folder, path])

      return readText ? readText(folder, path) : { error: 'not-found', ok: false }
    },
    trash: async (folder, path) => {
      calls.trash.push([folder, path])

      return trash ? trash(folder, path) : { ok: true }
    },
    writeText: async (folder, path, text, options) => {
      calls.writeText.push([folder, path, text, options])

      return writeText ? writeText(folder, path, text, options) : { ok: true, path, size: text.length }
    }
  }

  return { calls, files }
}

describe('image storage', () => {
  it('writes then reads one image file as its data URL', async () => {
    const { calls, files } = fakeFiles({
      readText: () => ({ ok: true, text: TINY_PNG })
    })
    const store = createImageStore({ files })

    assert.equal(store.enabled, true)

    const written = await store.write('note-abc', 0, TINY_PNG, { h: 2, w: 3 })

    assert.equal(written.ok, true)
    assert.deepEqual(written.image, {
      bytes: TINY_PNG_BYTES,
      file: 'img-note-abc-0.txt',
      h: 2,
      mime: 'image/png',
      w: 3
    })
    // One flat file in the data root, written exclusively, holding the data URL.
    assert.deepEqual(calls.writeText, [
      ['data', 'img-note-abc-0.txt', TINY_PNG, { exclusive: true }]
    ])

    const read = await store.read('img-note-abc-0.txt')

    assert.deepEqual(read, { dataUrl: TINY_PNG, ok: true })
    assert.deepEqual(calls.readText, [['data', 'img-note-abc-0.txt']])
  })

  it('refuses an oversize data URL before any write', async () => {
    const { calls, files } = fakeFiles()
    const store = createImageStore({ files })
    const oversize = `data:image/png;base64,${'A'.repeat(4194304)}`

    const result = await store.write('note-abc', 0, oversize)

    assert.equal(result.ok, false)
    assert.equal(result.error, 'too-large')
    assert.equal(result.message, 'Image too large for Note Stash (max ~3 MB)')
    assert.deepEqual(calls.writeText, [], 'nothing is written for an oversize image')
  })

  it('accepts only PNG, JPEG, GIF, WebP and BMP', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']) {
      assert.equal(validateImageDataUrl(`data:${mime};base64,AAAA`).ok, true, mime)
    }

    assert.equal(validateImageDataUrl('data:image/svg+xml;base64,AAAA').error, 'unsupported-image')
    assert.equal(validateImageDataUrl('data:text/plain;base64,AAAA').error, 'unsupported-image')
    assert.equal(validateImageDataUrl('not-a-data-url').error, 'invalid-image')
  })

  it('trashes every image file of a deleted note', async () => {
    const { calls, files } = fakeFiles()
    const store = createImageStore({ files })

    const trashed = await store.trash([
      { file: 'img-note-abc-0.txt', mime: 'image/png' },
      { file: 'img-note-abc-1.txt', mime: 'image/jpeg' }
    ])

    assert.equal(trashed, true)
    assert.deepEqual(calls.trash, [
      ['data', 'img-note-abc-0.txt'],
      ['data', 'img-note-abc-1.txt']
    ])
  })

  it('reads a missing image file as a placeholder state, never a crash', async () => {
    const { files } = fakeFiles()
    const store = createImageStore({ files })

    const data = await store.readAll([
      { images: [{ file: 'img-note-abc-0.txt', mime: 'image/png' }] },
      { body: 'no images' }
    ])

    assert.deepEqual(data, { 'img-note-abc-0.txt': null })
  })

  it('names files and indexes them from existing image metadata', () => {
    assert.equal(imageFileName('note-abc', 2), 'img-note-abc-2.txt')
    assert.equal(nextImageIndex([]), 0)
    assert.equal(nextImageIndex([{ file: 'img-note-abc-0.txt' }]), 1)
    // A removed middle image must not be overwritten by the next add.
    assert.equal(nextImageIndex([{ file: 'img-note-abc-0.txt' }, { file: 'img-note-abc-2.txt' }]), 3)
    assert.equal(attachFilename({ file: 'img-note-abc-2.txt', mime: 'image/jpeg' }), 'img-note-abc-2.jpg')
  })

  it('parses data URLs and counts raw bytes', () => {
    assert.deepEqual(parseImageDataUrl(TINY_PNG), {
      base64: 'iVBORw0KGgo=',
      mime: 'image/png'
    })
    assert.equal(base64Bytes('iVBORw0KGgo='), TINY_PNG_BYTES)
    assert.equal(parseImageDataUrl('data:image/png,abc'), null)
  })
})

describe('notes.json image metadata', () => {
  it('keeps valid image metadata and drops invalid entries', () => {
    const note = normalizeNote({
      body: '',
      id: 'note-abc',
      images: [
        { bytes: 8, file: 'img-note-abc-0.txt', h: 2, mime: 'image/png', w: 3 },
        { file: 'img-note-abc-1.txt', mime: 'image/svg+xml' },
        { file: 'notes.json', mime: 'image/png' },
        'not-an-object'
      ],
      title: ''
    })

    assert.deepEqual(note.images, [{ bytes: 8, file: 'img-note-abc-0.txt', h: 2, mime: 'image/png', w: 3 }])
  })

  it('allows an images-only note (no body, no title) and round-trips it', () => {
    const note = createNote({
      body: '',
      id: 'note-abc',
      images: [{ bytes: 8, file: 'img-note-abc-0.txt', h: 2, mime: 'image/png', w: 3 }],
      title: ''
    })

    assert.equal(note.body, '')
    assert.equal(note.images.length, 1)

    const parsed = parseNotesFile(serializeNotes([note]))

    assert.deepEqual(parsed, [note])
  })

  it('still refuses a note with no body, no title and no images', () => {
    assert.equal(normalizeNote({ body: '', id: 'note-abc', title: '' }), null)
  })

  it('sends the title, else (image), for an images-only note', () => {
    assert.equal(sendTextFor({ body: '', images: [{}], title: 'Sketch' }), 'Sketch')
    assert.equal(sendTextFor({ body: '', images: [{}], title: '' }), '(image)')
    assert.equal(sendTextFor({ body: 'text', images: [{}], title: 'Sketch' }), 'text')
  })
})

/** Flush pending microtasks (attach/detach/submit continuations). */
const flush = () => new Promise(resolve => setImmediate(resolve))

/** Timers the queue arms, run by delay so a test picks settle vs confirm. */
function fakeTimers() {
  const timeouts = []
  const intervals = []

  return {
    intervals,
    runMs: ms => {
      for (const timer of timeouts.filter(timer => timer.ms === ms && !timer.cancelled)) {
        timer.cancelled = true
        timer.fn()
      }
    },
    setIntervalFn: (fn, ms) => {
      const handle = { cancelled: false, fn, ms }
      intervals.push(handle)

      return handle
    },
    setTimeoutFn: (fn, ms) => {
      const handle = { cancelled: false, fn, ms }
      timeouts.push(handle)

      return handle
    },
    timeouts,
    clearIntervalFn: handle => {
      handle.cancelled = true
    },
    clearTimeoutFn: handle => {
      handle.cancelled = true
    }
  }
}

const IMAGE_NOTE = {
  body: '',
  id: 'note-img',
  images: [
    { bytes: 8, file: 'img-note-img-0.txt', h: 2, mime: 'image/png', w: 3 },
    { bytes: 8, file: 'img-note-img-1.txt', h: 2, mime: 'image/jpeg', w: 3 }
  ],
  title: 'Sketch'
}

describe('image send sequence', () => {
  it('attaches both images, submits once, then confirms -> sent once, no detach', async () => {
    const timers = fakeTimers()
    const attachCalls = []
    const detachCalls = []
    const events = []
    const submitted = []
    const queue = createSendQueue({
      attach: async item => {
        attachCalls.push(item)

        return { ok: true, paths: ['/tmp/upload-1.png', '/tmp/upload-2.jpg'] }
      },
      detach: async (item, paths) => detachCalls.push(paths),
      isBusy: () => false,
      onEvent: event => events.push(event),
      submit: (sid, text) => {
        submitted.push([sid, text])

        return true
      },
      ...timers
    })

    queue.enqueue(IMAGE_NOTE, 'sess-1', 'work')
    timers.runMs(750)
    await flush()

    assert.equal(attachCalls.length, 1)
    assert.equal(attachCalls[0].images.length, 2)
    assert.equal(attachCalls[0].profile, 'work')
    assert.deepEqual(submitted, [['sess-1', 'Sketch']])
    assert.deepEqual(detachCalls, [], 'nothing is detached while the submit is confirming')

    queue.onBusyChange({ 'sess-1': true })

    assert.deepEqual(
      events.map(event => event.type),
      ['sent'],
      'the busy flip confirms the submit exactly once'
    )
    assert.equal(queue.pending('sess-1'), 0)
  })

  it('detaches the staged paths and submits nothing when an attach fails', async () => {
    const timers = fakeTimers()
    const detachCalls = []
    const events = []
    const submitted = []
    const queue = createSendQueue({
      attach: async () => ({ error: 'attach-image', ok: false, paths: ['/tmp/upload-1.png'] }),
      detach: async (item, paths) => detachCalls.push(paths),
      isBusy: () => false,
      onEvent: event => events.push(event),
      submit: (sid, text) => {
        submitted.push([sid, text])

        return true
      },
      ...timers
    })

    queue.enqueue(IMAGE_NOTE, 'sess-1', 'work')
    timers.runMs(750)
    await flush()

    assert.deepEqual(submitted, [], 'an attach error submits nothing')
    assert.deepEqual(detachCalls, [['/tmp/upload-1.png']], 'the staged path is detached')
    assert.deepEqual(events.map(event => event.type), ['imageFailed'])
    assert.equal(queue.pending('sess-1'), 0, 'the send stops')
  })

  it('detaches every staged path and returns to waiting when the submit is not confirmed', async () => {
    const timers = fakeTimers()
    const detachCalls = []
    const events = []
    const queue = createSendQueue({
      attach: async () => ({ ok: true, paths: ['/tmp/upload-1.png', '/tmp/upload-2.jpg'] }),
      detach: async (item, paths) => detachCalls.push(paths),
      isBusy: () => false,
      onEvent: event => events.push(event),
      submit: () => true,
      ...timers
    })

    queue.enqueue(IMAGE_NOTE, 'sess-1', 'work')
    timers.runMs(750)
    await flush()

    assert.deepEqual(detachCalls, [])

    // 8 s pass with no busy flip / session.info: the submit never reached a turn.
    timers.runMs(8000)
    await flush()

    assert.deepEqual(detachCalls, [['/tmp/upload-1.png', '/tmp/upload-2.jpg']])
    assert.deepEqual(events.map(event => event.type), ['waiting'])
  })

  it('detaches on an unconfirmed immediate send and reports failure', async () => {
    const timers = fakeTimers()
    const detachCalls = []
    const events = []
    const queue = createSendQueue({
      attach: async () => ({ ok: true, paths: ['/tmp/upload-1.png'] }),
      detach: async (item, paths) => detachCalls.push(paths),
      isBusy: () => false,
      onEvent: event => events.push(event),
      submit: () => true,
      ...timers
    })

    const status = await queue.sendNow(IMAGE_NOTE, 'sess-1', 'work')

    assert.equal(status, 'confirming')

    timers.runMs(8000)
    await flush()

    assert.deepEqual(detachCalls, [['/tmp/upload-1.png']])
    assert.deepEqual(events.map(event => event.type), ['failed'])
  })
})

describe('image sender', () => {
  const ROUTES = [
    { connectionId: 'c1', mode: 'local', profile: 'default', targetProfile: 'default' },
    { connectionId: 'c2', mode: 'remote', profile: 'work', targetProfile: 'work' }
  ]

  it('resolves the route from the entry profile and attaches each image', async () => {
    const calls = []
    const released = []
    const retained = []
    const requestCalls = []
    const originalRequest = sdk.host.request
    sdk.host.request = (...args) => {
      requestCalls.push(args)

      return { sessions: [] }
    }

    try {
      const sender = createImageSender({
        profileRoutes: async () => ROUTES,
        readText: async (folder, file) => {
          assert.equal(folder, 'data')
          assert.match(file, /^img-note-img-\d\.txt$/)

          return { ok: true, text: TINY_PNG }
        },
        requestProfile: async (route, method, params) => {
          calls.push([route.profile, method, params])

          return { path: `/tmp/${params.filename}` }
        },
        retainProfile: async route => {
          retained.push(route.profile)

          return () => released.push(route.profile)
        }
      })

      const result = await sender.attach({
        images: IMAGE_NOTE.images,
        profile: 'work',
        sid: 'sess-1'
      })

      assert.equal(result.ok, true)
      assert.deepEqual(result.paths, ['/tmp/img-note-img-0.png', '/tmp/img-note-img-1.jpg'])
      assert.deepEqual(
        calls.map(call => [call[0], call[1]]),
        [
          ['work', 'image.attach_bytes'],
          ['work', 'image.attach_bytes']
        ],
        'the route is the one whose profile matches the entry, not the primary'
      )
      assert.equal(calls[0][2].session_id, 'sess-1')
      assert.equal(calls[0][2].content_base64, 'iVBORw0KGgo=')
      assert.equal(calls[0][2].filename, 'img-note-img-0.png')
      assert.deepEqual(retained, ['work'])
      assert.deepEqual(released, ['work'], 'the retain is released in a finally')
      assert.deepEqual(requestCalls, [], 'host.request (primary gateway only) is never used')
    } finally {
      sdk.host.request = originalRequest
    }
  })

  it('detaches every staged path through the same route', async () => {
    const calls = []
    const released = []
    const sender = createImageSender({
      profileRoutes: async () => ROUTES,
      readText: async () => ({ ok: true, text: TINY_PNG }),
      requestProfile: async (route, method, params) => {
        calls.push([route.profile, method, params])

        return { detached: true }
      },
      retainProfile: async () => () => released.push('released')
    })

    await sender.detach({ profile: 'work', sid: 'sess-1' }, ['/tmp/a.png', '/tmp/b.jpg'])

    assert.deepEqual(
      calls.map(call => [call[0], call[1], call[2].path]),
      [
        ['work', 'image.detach', '/tmp/a.png'],
        ['work', 'image.detach', '/tmp/b.jpg']
      ]
    )
    assert.deepEqual(released, ['released'])
  })

  it('returns no paths and no attach call when the route is missing', async () => {
    let attached = false
    const sender = createImageSender({
      profileRoutes: async () => ROUTES,
      readText: async () => ({ ok: true, text: TINY_PNG }),
      requestProfile: async () => {
        attached = true

        return { path: '/tmp/x.png' }
      },
      retainProfile: async () => () => {}
    })

    const result = await sender.attach({ images: IMAGE_NOTE.images, profile: 'other', sid: 'sess-1' })

    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-route')
    assert.equal(attached, false)
  })
})
