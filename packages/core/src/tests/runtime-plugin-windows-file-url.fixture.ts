import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-windows-file-url-fixture-"))
const entryPath = join(tempRoot, "entry.ts")

writeFileSync(entryPath, ['import { marker } from "@opentui/core"', "export const externalMarker = marker"].join("\n"))

registerPlugin.clearAll()

registerPlugin(
  createRuntimePlugin({
    core: {
      marker: "resolved-from-windows-file-url",
    },
  }),
)

try {
  const entryUrl = pathToFileURL(entryPath).href
  const externalModule = (await import(entryUrl)) as { externalMarker: string }
  console.log(`marker=${externalModule.externalMarker}`)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
