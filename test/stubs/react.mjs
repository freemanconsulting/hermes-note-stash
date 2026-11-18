/**
 * Minimal `react` stub: the hooks plugin.js calls, plus render-time refs.
 *
 * Effects EXECUTE once at render time, like React's commit phase, and their
 * returned cleanups are deferred to `runEffectCleanups()` at the end of the
 * render walk. Nothing is swallowed: a crash inside an effect must fail the
 * test, which is the class of bug a no-op stub hid (`stash.refreshTitles is
 * not a function` broke the pane live while the smoke test passed).
 */

const cleanups = []

export const useCallback = fn => fn

export const useEffect = fn => {
  const cleanup = fn()

  if (typeof cleanup === 'function') {
    cleanups.push(cleanup)
  }
}

export const useLayoutEffect = useEffect

/** Run every collected cleanup, newest first. */
export const runEffectCleanups = () => {
  while (cleanups.length) {
    cleanups.pop()()
  }
}

export const useMemo = fn => fn()

export const useRef = initial => ({ current: initial })

export const useState = initial => [typeof initial === 'function' ? initial() : initial, () => {}]
