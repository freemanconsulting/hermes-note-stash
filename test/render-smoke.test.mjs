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
const sdk = await import('@hermes/plugin-sdk')
const react = await import('./stubs/react.mjs')

/** Walk a rendered element tree, invoking function components with their props. */
function renderElement(node) {
  if (node === null || node === undefined || typeof node !== 'object') {
    return
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      renderElement(child)
    }

    return
  }

  // jsx()/jsxs() output is { type, props }.
  const { props, type } = node

  if (typeof type === 'function') {
    // SDK components are stubs returning null; the plugin's own components build trees.
    renderElement(type(props || {}))

    return
  }

  // String tags and Fragments both carry their children in props.
  if (props && props.children !== undefined) {
    renderElement(props.children)
  }
}

describe('render smoke', () => {
  it('registers and renders every contribution without throwing', () => {
    const contributions = []
    const disposers = []
    const storage = new Map()

    const ctx = {
      files: undefined, // force the ctx.storage persistence path
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

    // The walk below must cover the queued and waiting branches, not just the
    // active and sent ones: assert the seeds landed before rendering.
    const seeded = stash.$notes.get().map(note => note.status)

    assert.ok(seeded.includes('queued'), 'a queued row is seeded')
    assert.ok(seeded.includes('waiting'), 'a waiting row is seeded')
    assert.ok(seeded.includes('sent'), 'a sent row is seeded')

    for (const filter of ['active', 'sent']) {
      stash.$filter.set(filter)

      for (const contribution of renderables) {
        renderElement(contribution.render())
      }
    }

    for (const disposer of disposers) {
      disposer()
    }

    // Effects ran during the walk; run their cleanups now, so a cleanup that
    // throws also fails the test.
    react.runEffectCleanups()
  })
})
