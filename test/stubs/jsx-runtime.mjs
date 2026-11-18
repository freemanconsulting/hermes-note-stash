/** `react/jsx-runtime` stub: returns a plain element so tests can walk the tree. */

export const Fragment = Symbol('Fragment')

export const jsx = (type, props) => ({ props: props || null, type })

export const jsxs = (type, props) => ({ props: props || null, type })
