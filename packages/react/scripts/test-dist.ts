import assert from "node:assert/strict"
import { mkdtempDisposableSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createTestRenderer } from "@opentui/core/testing"
import { createElement } from "react"

// Unpack beside the workspace dependencies so the consumer uses the lockfile's React.
using temp = mkdtempDisposableSync(join(import.meta.dir, "../node_modules/.packed-react-"))
const tarball = await Bun.$`npm pack --silent --pack-destination ${temp.path}`
  .cwd(join(import.meta.dir, "../dist"))
  .text()
await Bun.$`tar -xzf ${tarball.trim()}`.cwd(temp.path)
const { createRoot, createSlot, createReactSlotRegistry, flushSync } = await import(
  pathToFileURL(join(temp.path, "package/index.js")).href
)

await using scene = await createTestRenderer({ width: 80, height: 10 })
const root = createRoot(scene.renderer)
const Slot = createSlot(createReactSlotRegistry(scene.renderer, {}))
function Broken(): never {
  throw new Error("packed render failed")
}
flushSync(() => root.render(createElement(Slot, { name: "body" }, createElement(Broken))))
await scene.renderOnce()
assert.match(scene.captureCharFrame(), /Error: packed render failed/)
