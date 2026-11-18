/**
 * Installs the stub-resolution hook. Call it BEFORE importing `plugin.js`:
 * ESM resolves a whole graph before evaluating any of it, so a plain static
 * import of the plugin would resolve against the real (absent) specifiers.
 *
 * `registerHooks` is the synchronous, non-deprecated form of `module.register`
 * (which warns DEP0205 on Node 26); same resolve hook, same stub map.
 */

import { registerHooks } from 'node:module'

import { resolveStub } from './hooks.mjs'

let installed = false

export function installStubs() {
  if (installed) {
    return
  }

  installed = true
  registerHooks({ resolve: resolveStub })
}
