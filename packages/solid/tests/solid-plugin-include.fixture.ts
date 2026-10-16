import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ensureRuntimePluginSupport } from "../scripts/runtime-plugin-support-configure.js"

// A host that installs plugin packages under node_modules in its own cache
// directory, the way package managers lay them out.
// Bun loads modules by real path (/private/var on macOS), so include the real path.
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "solid-plugin-include-fixture-")))
const cacheDir = join(tempRoot, "cache")
const viewPath = join(cacheDir, "example-0123", "node_modules", "example", "view.tsx")

mkdirSync(dirname(viewPath), { recursive: true })
writeFileSync(
  viewPath,
  [
    "/** @jsxImportSource @opentui/solid */",
    "export const View = (props: { label: () => string }) => <text>{props.label()}</text>",
  ].join("\n"),
)

ensureRuntimePluginSupport({ include: [cacheDir] })

try {
  const { createSignal } = await import("solid-js")
  const { testRender } = await import("../index.js")
  const { View } = await import(viewPath)
  const [label, setLabel] = createSignal("before")
  const app = await testRender(() => View({ label }), { width: 20, height: 1 })

  await app.renderOnce()
  const before = app.captureCharFrame().trim()
  setLabel("after")
  await app.renderOnce()
  const after = app.captureCharFrame().trim()
  app.renderer.destroy()

  console.log(`before=${before};after=${after}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
