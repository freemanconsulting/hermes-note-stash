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
  createImageStore,
  createNote,
  imageFileName,
  nextImageIndex,
  normalizeNote,
  parseImageDataUrl,
  parseNotesFile,
  sendTextFor,
  serializeNotes,
  validateImageDataUrl
} = await import('../desktop/plugin.js')

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
