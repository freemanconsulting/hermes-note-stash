/**
 * Render smoke test — the class of bug `node --check` and the logic tests miss.
 *
 * A `ReferenceError` for an identifier referenced only at render time (the live
 * failure: `$sessionTitles`, never declared) passes `node --check` and every
 * pure-logic test, then breaks the pane in Desktop. So: register the real
 * plugin against a fake ctx, seed one active and one sent note through the
 * plugin's own actions, then render every contribution that provides `render()`
 * by walking the element tree and invoking function components with stub hooks.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installStubs } from './loader.mjs'

installStubs()

const plugin = (await import('../desktop/plugin.js')).default
const { VERSION } = await import('../desktop/plugin.js')
const sdk = await import('@hermes/plugin-sdk')
const react = await import('./stubs/react.mjs')

/** Whether a prop value is a rendered element: jsx()/jsxs() output is { type, props }. */
function looksLikeElement(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'type' in value && 'props' in value
}

/** Walk a rendered element tree, invoking function components with their props. */
function renderNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
    return
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      renderNode(child)
    }

    return
  }

  if (typeof node !== 'object') {
    return
  }

  if (node.type === undefined) {
    throw new Error('undefined element type (missing SDK export or icon)')
  }

  if (typeof node.type === 'function') {
    // SDK components are stubs returning null; the plugin's own components build trees.
    renderNode(node.type(node.props ?? {}))
  }

  // Walk every prop value that looks like an element or an array of them. This
  // covers `icon`, `trigger`, `content` and — crucially — `children` handed to
  // an SDK stub, which returns null and would otherwise hide its subtree.
  for (const value of Object.values(node.props ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (looksLikeElement(item)) {
          renderNode(item)
        }
      }
    } else if (looksLikeElement(value)) {
      renderNode(value)
    }
  }
}

describe('render smoke', () => {
  /** Every element in the tree whose className names a note row. */
  function findRows(node, out = []) {
    if (node === null || typeof node !== 'object') {
      return out
    }

    if (Array.isArray(node)) {
      for (const child of node) {
        findRows(child, out)
      }

      return out
    }

    if (typeof node.type === 'function') {
      findRows(node.type(node.props ?? {}), out)
    }

    if (typeof node.props?.className === 'string' && node.props.className.includes('group/note')) {
      out.push(node)
    }

    for (const value of Object.values(node.props ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (looksLikeElement(item)) {
            findRows(item, out)
          }
        }
      } else if (looksLikeElement(value)) {
        findRows(value, out)
      }
    }

    return out
  }

  /** Every button's aria-label inside one row element. */
  function buttonLabels(node, out = []) {
    if (node === null || typeof node !== 'object') {
      return out
    }

    if (Array.isArray(node)) {
      for (const child of node) {
        buttonLabels(child, out)
      }

      return out
    }

    if (node.props?.type === 'button' && typeof node.props['aria-label'] === 'string') {
      out.push(node.props['aria-label'])
    }

    if (typeof node.type === 'function') {
      buttonLabels(node.type(node.props ?? {}), out)
    }

    for (const value of Object.values(node.props ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (looksLikeElement(item)) {
            buttonLabels(item, out)
          }
        }
      } else if (looksLikeElement(value)) {
        buttonLabels(value, out)
      }
    }

    return out
  }

  /** Every Badge element in the tree. */
  function findBadges(node, out = []) {
    if (node === null || typeof node !== 'object') {
      return out
    }

    if (Array.isArray(node)) {
      for (const child of node) {
        findBadges(child, out)
      }

      return out
    }

    if (node.type === sdk.Badge) {
      out.push(node)
    }

    if (typeof node.type === 'function') {
      findBadges(node.type(node.props ?? {}), out)
    }

    for (const value of Object.values(node.props ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (looksLikeElement(item)) {
            findBadges(item, out)
          }
        }
      } else if (looksLikeElement(value)) {
        findBadges(value, out)
      }
    }

    return out
  }

  /** Every string in the tree, including a stub component's children. */
  function collectText(node, out = []) {
    if (node === null || node === undefined || typeof node === 'boolean') {
      return out
    }

    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))

      return out
    }

    if (Array.isArray(node)) {
      for (const child of node) {
        collectText(child, out)
      }

      return out
    }

    if (typeof node !== 'object') {
      return out
    }

    if (typeof node.type === 'function') {
      collectText(node.type(node.props ?? {}), out)
    }

    for (const value of Object.values(node.props ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' || looksLikeElement(item)) {
            collectText(item, out)
          }
        }
      } else if (typeof value === 'string' || looksLikeElement(value)) {
        collectText(value, out)
      }
    }

    return out
  }

  it('registers and renders every contribution without throwing', async () => {
    const contributions = []
    const disposers = []
    const storage = new Map()

    // Image + notes files. readText serves the data URL for a present image,
    // not-found for one deliberately missing image, and the last text written
    // for notes.json so the persistence write-then-verify passes.
    const written = new Map()
    const missingImage = 'img-smoke-note-1.txt'

    const ctx = {
      files: {
        dataFolder: 'data',
        list: async () => ({ files: [], ok: true }),
        readText: async (folder, file) => {
          if (file === missingImage) {
            return { error: 'not-found', ok: false }
          }

          if (written.has(file)) {
            return { ok: true, text: written.get(file) }
          }

          if (file.startsWith('img-') && file.endsWith('.txt')) {
            return { ok: true, text: 'data:image/png;base64,iVBORw0KGgo=' }
          }

          return { error: 'not-found', ok: false }
        },
        stat: async () => ({ ok: true }),
        trash: async () => ({ ok: true }),
        writeText: async (folder, file, text) => {
          written.set(file, text)

          return { ok: true }
        }
      },
      i18n: {
        register: () => {},
        t: key => String(key)
      },
      onDispose: disposer => {
        if (typeof disposer === 'function') {
          disposers.push(disposer)
        }
      },
      register: contribution => {
        contributions.push(contribution)
      },
      // Fire the queue's settle delay immediately, but hold the delivery
      // confirmation timers (8 s / 1.5 s) so a busy flip can confirm a submit
      // instead of every submit timing out during the walk.
      setTimeout: (fn, ms) => {
        if (ms > 750) {
          return () => {}
        }

        fn()

        return () => {}
      },
      // The title poll's interval: return a disposer, never fire (an eager
      // interval would recurse through the render walk).
      setInterval: () => () => {},
      // Gateway events (the plugin listens for `session.info` titles).
      onEvent: () => () => {},
      storage: {
        get: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
        set: (key, value) => storage.set(key, value)
      }
    }

    // The stub module resolves to one shared instance (same module URL), so
    // these are the very atoms / host fns the plugin's render + send paths use.
    sdk.host.state.focusedSessionId.set('sess-1')
    sdk.host.composer.submit = () => true

    assert.doesNotThrow(() => plugin.register(ctx), 'register(fakeCtx) must not throw')

    const renderables = contributions.filter(contribution => typeof contribution.render === 'function')

    assert.ok(renderables.length >= 1, 'at least one contribution provides render()')

    // The stash is closure state; grab the handle the pane's render passes.
    const pane = contributions.find(contribution => contribution.id === 'pane')
    const stash = pane.render().props.stash

    // Seed through the plugin's own actions: one active note, one sent note,
    // one waiting note and one queued note, so every NoteRow branch — active,
    // sent, waiting, queued — renders.
    stash.addNote({ body: 'active one', title: 'Active one' })
    // Untitled, and a single-line untitled variant: both NoteRow preview
    // branches (preview line, and no preview line) must render.
    stash.addNote({ body: 'untitled multi\nsecond line', title: '' })
    stash.addNote({ body: 'untitled single line', title: '' })
    stash.addNote({ body: 'sent one', title: 'Sent one' })
    // Index 3: the sent note sits after the two untitled notes added above.
    // submit true alone is not proof of delivery: the busy flip confirms it.
    stash.send(stash.$notes.get()[3])
    sdk.host.state.busyBySession.set({ 'sess-1': true })
    sdk.host.state.busyBySession.set({})
    // A queued note whose chat is not on screen at turn end: submit returns
    // false, so the row renders the waiting branch.
    sdk.host.composer.submit = () => false
    sdk.host.state.busyBySession.set({ 'sess-1': true })
    stash.addNote({ body: 'waiting one', title: 'Waiting one' })
    stash.send(stash.$notes.get()[0])
    sdk.host.state.busyBySession.set({})
    // A queued note whose chat is on screen at turn end: submit returns true and
    // the confirmation timer is held, so the row renders the queued branch.
    sdk.host.composer.submit = () => true
    sdk.host.state.busyBySession.set({ 'sess-1': true })
    stash.addNote({ body: 'queued one', title: 'Queued one' })
    stash.send(stash.$notes.get()[0])
    sdk.host.state.busyBySession.set({})

    // An images-only note: two image files, one present and one missing, seeded
    // through the plugin's own add path (addImage writes, addNote owns them).
    const firstImage = await stash.addImage('smoke-note', [], 'data:image/png;base64,iVBORw0KGgo=', {
      h: 8,
      w: 8
    })
    const secondImage = await stash.addImage('smoke-note', [firstImage], 'data:image/png;base64,iVBORw0KGgo=', {
      h: 8,
      w: 8
    })

    assert.ok(firstImage && secondImage, 'both image files were written')

    stash.addNote({ id: 'smoke-note', images: [firstImage, secondImage], title: 'Images only' })

    // The row reads image files through loadImages; await it so the present
    // thumbnail and the missing-file placeholder both render.
    await stash.loadImages(stash.$notes.get())

    assert.equal(stash.$imageData.get()[firstImage.file], 'data:image/png;base64,iVBORw0KGgo=')
    assert.equal(stash.$imageData.get()[secondImage.file], null)

    // The walk below must cover the queued and waiting branches, not just the
    // active and sent ones: assert the seeds landed before rendering.
    const seeded = stash.$notes.get().map(note => note.status)

    assert.ok(seeded.includes('queued'), 'a queued row is seeded')
    assert.ok(seeded.includes('waiting'), 'a waiting row is seeded')
    assert.ok(seeded.includes('sent'), 'a sent row is seeded')

    // Every contribution that renders, under both filters. The image note is
    // active, so the active pass reaches its ImageStrip → ImageThumb → the
    // missing-file placeholder icon; a broken icon throws from the walk.
    for (const filter of ['active', 'sent']) {
      stash.$filter.set(filter)

      for (const contribution of renderables) {
        renderNode(contribution.render())
      }
    }

    for (const disposer of disposers) {
      disposer()
    }

    // Effects ran during the walk; run their cleanups now, so a cleanup that
    // throws also fails the test.
    react.runEffectCleanups()
  })

  it('renders the In composer badge and the version in the pane header', async () => {
    const contributions = []
    const ctx = {
      i18n: { register: () => {}, t: key => String(key) },
      onDispose: () => {},
      onEvent: () => () => {},
      register: contribution => contributions.push(contribution),
      setInterval: () => () => {},
      // Hold the ten-minute composing timer: the badge must render while live.
      setTimeout: () => () => {},
      storage: { get: (key, fallback) => fallback, set: () => {} }
    }

    sdk.host.state.focusedSessionId.set('sess-1')
    sdk.host.composer.insertText = async () => true

    plugin.register(ctx)

    const pane = contributions.find(contribution => contribution.id === 'pane')
    const stash = pane.render().props.stash
    const note = stash.addNote({ body: 'in composer note', title: 'Composer' })

    // Seed through the plugin's own Put in composer path with a successful insert.
    await stash.putInComposer(note)

    assert.deepEqual(stash.$composing.get().map(record => record.noteId), [note.id])

    const tree = pane.render()

    assert.ok(
      findBadges(tree).some(
        badge => badge.props.children === 'inComposer' && badge.props.variant === 'muted'
      ),
      'the row shows the muted In composer badge'
    )
    assert.ok(collectText(tree).includes(`v${VERSION}`), 'the pane header shows the version')
  })

  it('renders an image note with Put in composer as its labeled action and no Send', () => {
    const contributions = []
    const ctx = {
      i18n: { register: () => {}, t: key => String(key) },
      onDispose: () => {},
      onEvent: () => () => {},
      register: contribution => contributions.push(contribution),
      setInterval: () => () => {},
      setTimeout: () => () => {},
      storage: { get: (key, fallback) => fallback, set: () => {} }
    }

    sdk.host.state.focusedSessionId.set('sess-1')

    plugin.register(ctx)

    const pane = contributions.find(contribution => contribution.id === 'pane')
    const stash = pane.render().props.stash

    // addNote prepends, so rows[0] is the last added (text) and rows[1] the image note.
    stash.addNote({
      body: 'with images',
      images: [{ bytes: 8, file: 'img-note-img-0.txt', h: 2, mime: 'image/png', w: 3 }],
      title: 'Images only'
    })
    stash.addNote({ body: 'text only', title: 'Text only' })

    const rows = findRows(pane.render())

    assert.equal(rows.length, 2)

    const textLabels = buttonLabels(rows[0])
    const imageLabels = buttonLabels(rows[1])

    assert.ok(imageLabels.includes('putInComposer'), 'the image note has a labeled Put in composer button')
    assert.ok(!imageLabels.includes('sendTo'), 'the image note has no Send button')
    assert.ok(textLabels.includes('sendTo'), 'a text-only note keeps its Send button')
    assert.ok(textLabels.includes('putInComposer'), 'a text-only note keeps the secondary Put in composer action')
  })

  /** The first button with this aria-label, plus whether a Tip wraps it. */
  function findLabeledButton(node, label, inTip = false, found = null) {
    if (found || node === null || typeof node !== 'object') {
      return found
    }

    if (Array.isArray(node)) {
      for (const child of node) {
        found = findLabeledButton(child, label, inTip, found)

        if (found) {
          return found
        }
      }

      return found
    }

    const isTip = node.type === sdk.Tip

    if (node.props?.type === 'button' && node.props['aria-label'] === label) {
      return { element: node, inTip }
    }

    if (typeof node.type === 'function' && !isTip) {
      found = findLabeledButton(node.type(node.props ?? {}), label, inTip, found)

      if (found) {
        return found
      }
    }

    for (const value of Object.values(node.props ?? {})) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (looksLikeElement(item)) {
            found = findLabeledButton(item, label, inTip || isTip, found)

            if (found) {
              return found
            }
          }
        }
      } else if (looksLikeElement(value)) {
        found = findLabeledButton(value, label, inTip || isTip, found)

        if (found) {
          return found
        }
      }
    }

    return found
  }

  it('renders the image Put in composer button without a Tip overlay', () => {
    const contributions = []
    const ctx = {
      i18n: { register: () => {}, t: key => String(key) },
      onDispose: () => {},
      onEvent: () => () => {},
      register: contribution => contributions.push(contribution),
      setInterval: () => () => {},
      setTimeout: () => () => {},
      storage: { get: (key, fallback) => fallback, set: () => {} }
    }

    sdk.host.state.focusedSessionId.set('sess-1')

    plugin.register(ctx)

    const pane = contributions.find(contribution => contribution.id === 'pane')
    const stash = pane.render().props.stash

    stash.addNote({
      body: 'with images',
      images: [{ bytes: 8, file: 'img-note-img-0.txt', h: 2, mime: 'image/png', w: 3 }],
      title: 'Images only'
    })

    const rows = findRows(pane.render())
    const button = findLabeledButton(rows[0], 'putInComposer')

    assert.ok(button, 'the image note has a Put in composer button')
    assert.equal(button.inTip, false, 'no Tip ancestor: its popper layer would drop the paste on a real click')
    assert.equal(button.element.props.title, 'putInComposerImagesTip', 'the explanation stays as the native title')
  })

  it('renders Mark as sent on an active row and not on a sent one', () => {
    const contributions = []
    const ctx = {
      i18n: { register: () => {}, t: key => String(key) },
      onDispose: () => {},
      onEvent: () => () => {},
      register: contribution => contributions.push(contribution),
      setInterval: () => () => {},
      setTimeout: () => () => {},
      storage: { get: (key, fallback) => fallback, set: () => {} }
    }

    sdk.host.state.focusedSessionId.set('sess-1')

    plugin.register(ctx)

    const pane = contributions.find(contribution => contribution.id === 'pane')
    const stash = pane.render().props.stash
    const active = stash.addNote({ body: 'still active', title: 'Active' })
    const sent = stash.addNote({ body: 'already sent', title: 'Sent' })

    stash.markSent(sent.id)
    stash.$filter.set('active')

    const activeRow = findRows(pane.render()).find(row => collectText(row).includes('Active'))

    assert.ok(activeRow, 'the active row renders')
    assert.ok(collectText(activeRow).includes('markSent'), 'the active row shows Mark as sent')
    assert.ok(findLabeledButton(activeRow, 'markSent'), 'the action is a labeled button')

    stash.$filter.set('sent')

    const sentRow = findRows(pane.render()).find(row => collectText(row).includes('Sent'))

    assert.ok(sentRow, 'the sent row renders')
    assert.ok(!collectText(sentRow).includes('markSent'), 'a sent row has no Mark as sent')
  })
})
