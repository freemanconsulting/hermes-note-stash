/**
 * i18n completeness — every `t('…')` key in plugin.js must exist in the English
 * locale table registered through `ctx.i18n.register`.
 *
 * The live bug this locks down: the capture dialog's placeholders rendered as
 * the raw keys `titlePlaceholder` / `bodyPlaceholder` because those strings were
 * never added to the table. `t()` falls back to the key itself, so a missing
 * entry is silent — it only shows up as raw keys on screen. This test reads the
 * table the plugin actually registers and compares it to the keys the source
 * actually asks for.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { installStubs } from './loader.mjs'

installStubs()

const plugin = (await import('../desktop/plugin.js')).default

/** Every literal `t('key')` / `ctx.i18n.t('key')` in the plugin source. */
function requestedKeys(source) {
  const keys = new Set()

  for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]\s*[,)]/g)) {
    keys.add(match[1])
  }

  return keys
}

/** The `en` table the plugin registers, captured from a fake ctx. */
function registeredEnglishTable() {
  let bundles = null

  const ctx = {
    files: undefined,
    i18n: {
      register: value => {
        bundles = value
      },
      t: key => String(key)
    },
    onDispose: () => {},
    // Gateway events (the plugin listens for `session.info` titles).
    onEvent: () => () => {},
    register: () => {},
    setTimeout: fn => {
      fn()

      return () => {}
    },
    storage: {
      get: (_key, fallback) => fallback,
      set: () => {}
    }
  }

  plugin.register(ctx)

  assert.ok(bundles?.en, 'the plugin registers an English locale bundle')

  return bundles.en
}

describe('i18n completeness', () => {
  it('every t() key in plugin.js exists in the registered English table', () => {
    const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
    const table = registeredEnglishTable()
    const requested = requestedKeys(source)

    assert.ok(requested.size > 0, 'the source asks for at least one key')

    const missing = [...requested].filter(key => !(key in table)).sort()

    assert.deepEqual(missing, [], `missing English strings for: ${missing.join(', ')}`)
  })
})
