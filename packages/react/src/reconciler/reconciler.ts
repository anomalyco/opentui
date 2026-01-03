import type { RootRenderable } from "@opentui/core"
import React from "react"
import ReactReconciler from "react-reconciler"
import { ConcurrentRoot } from "react-reconciler/constants"
import { hostConfig } from "./host-config"

export const reconciler = ReactReconciler(hostConfig)

if (process.env["DEV"] === "true") {
  try {
    await import("./devtools")
  } catch (error: any) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      console.warn(
        `
The environment variable DEV is set to true, so opentui tried to import \`react-devtools-core\`,
but this failed as it was not installed. Debugging with React DevTools requires it.

To install use this command:

$ bun add react-devtools-core@7 -d
        `.trim() + "\n",
      )
    } else {
      throw error
    }
  }
}

// Inject into DevTools - this is safe to call even if devtools isn't connected
// @ts-expect-error the types for `react-reconciler` are not up to date with the library.
reconciler.injectIntoDevTools()

export function _render(element: React.ReactNode, root: RootRenderable) {
  const container = (reconciler as any).createContainer(
    root,
    ConcurrentRoot,
    null,
    false,
    null,
    "",
    console.error,
    console.error,
    console.error,
    console.error,
    null,
  )

  reconciler.updateContainer(element, container, null, () => {})

  return container
}
