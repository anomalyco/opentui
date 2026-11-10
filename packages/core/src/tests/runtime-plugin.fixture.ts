import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-fixture-"))
const entryPath = join(tempRoot, "entry.ts")

const source = [
  'import { marker as coreMarker } from "@opentui/core"',
  'import { createTestRenderer } from "@opentui/core/testing"',
  'import { value as syncValue } from "fixture-sync"',
  'import { value as asyncValue } from "@fixture/async-module"',
  "console.log(`core=${coreMarker};coreTesting=${typeof createTestRenderer === 'function'};sync=${syncValue};async=${asyncValue}`)",
  "export const noop = 1",
].join("\n")

writeFileSync(entryPath, source)

registerPlugin.clearAll()

registerPlugin(
  createRuntimePlugin({
    core: {
      marker: "core-value",
    },
    additional: {
      "fixture-sync": { value: "sync-value" },
      "@fixture/async-module": async () => ({ value: "async-value" }),
    },
  }),
)

try {
  await import(`${entryPath}?reload=1`)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
