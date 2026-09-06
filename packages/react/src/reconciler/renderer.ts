import { CliRenderer, CliRenderEvents } from "@opentui/core"
import React, { type ReactNode } from "react"
import type { OpaqueRoot } from "react-reconciler"
import { AppContext } from "../components/app.js"
import { ErrorBoundary } from "../components/error-boundary.js"
import { _render, reconciler } from "./reconciler.js"

// flushSync was renamed to flushSyncFromReconciler in react-reconciler 0.32.0
// the types for react-reconciler are not up to date with the library
const _r = reconciler as typeof reconciler & { flushSyncFromReconciler?: typeof reconciler.flushSync }
const flushSync = _r.flushSyncFromReconciler ?? _r.flushSync
const { createPortal } = reconciler

export type Root = {
  render: (node: ReactNode) => void
  unmount: () => void
}

/**
 * Creates a root for rendering a React tree with the given CLI renderer.
 * @param renderer The CLI renderer to use
 * @returns A root object with a `render` method
 * @example
 * ```tsx
 * const renderer = await createCliRenderer()
 * createRoot(renderer).render(<App />)
 * ```
 */
export function createRoot(renderer: CliRenderer): Root {
  let container: OpaqueRoot | null = null

  const cleanup = () => {
    if (container) {
      reconciler.updateContainer(null, container, null, () => {})
      reconciler.flushSyncWork()
      container = null
    }
  }

  renderer.once(CliRenderEvents.DESTROY, cleanup)

  return {
    render: (node: ReactNode) => {
      container = _render(
        React.createElement(
          AppContext.Provider,
          { value: { keyHandler: renderer.keyInput, renderer } },
          React.createElement(ErrorBoundary, null, node),
        ),
        renderer.root,
      )
    },

    unmount: cleanup,
  }
}

export { createPortal, flushSync }
