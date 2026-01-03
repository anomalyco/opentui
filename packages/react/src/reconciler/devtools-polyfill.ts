// Polyfills required for react-devtools-core in Node.js/Bun environments
// This file MUST be imported before react-devtools-core

const g = globalThis as any

// Bun and Node.js 21+ should have native WebSocket support
if (typeof g.WebSocket === "undefined") {
  console.warn("WebSocket is not available; react-devtools-core requires a global WebSocket implementation.")
}

// react-devtools-core expects browser-like globals
g.window ||= globalThis
g.self ||= globalThis

// Filter out internal components from devtools for a cleaner view.
// Since `react-devtools-shared` package isn't published on npm, we can't
// use its types, that's why there are hard-coded values in `type` fields below.
// See https://github.com/facebook/react/blob/edf6eac8a181860fd8a2d076a43806f1237495a1/packages/react-devtools-shared/src/types.js#L24
g.window.__REACT_DEVTOOLS_COMPONENT_FILTERS__ = [
  {
    // ComponentFilterDisplayName
    type: 2,
    value: "ErrorBoundary",
    isEnabled: true,
    isValid: true,
  },
]
