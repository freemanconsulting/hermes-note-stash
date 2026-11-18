/**
 * Module-resolution hook for the plugin's three host specifiers.
 *
 * `plugin.js` imports `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime`,
 * none of which exist on disk here. This hook maps each to a minimal stub so
 * `node --test` can import the REAL plugin file and exercise its pure exports.
 */

const STUBS = {
  '@hermes/plugin-sdk': new URL('./stubs/plugin-sdk.mjs', import.meta.url).href,
  react: new URL('./stubs/react.mjs', import.meta.url).href,
  'react/jsx-runtime': new URL('./stubs/jsx-runtime.mjs', import.meta.url).href
}

export function resolveStub(specifier, context, nextResolve) {
  const stub = STUBS[specifier]

  if (stub) {
    return { shortCircuit: true, url: stub }
  }

  return nextResolve(specifier, context)
}
