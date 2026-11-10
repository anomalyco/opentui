import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-node-modules-runtime-specifier-fixture-"))
const externalPackageDir = join(tempRoot, "external", "node_modules", "runtime-plugin-node-modules-fixture")
const externalPackageEntryPath = join(externalPackageDir, "index.js")

mkdirSync(externalPackageDir, { recursive: true })

writeFileSync(
  join(externalPackageDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-node-modules-fixture",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(
  externalPackageEntryPath,
  ['import { marker } from "@opentui/core"', "export const externalMarker = marker"].join("\n"),
)

registerPlugin.clearAll()

registerPlugin(
  createRuntimePlugin({
    core: {
      marker: "resolved-from-node-modules-runtime-specifier",
    },
  }),
)

try {
  const externalModule = (await import(externalPackageEntryPath)) as { externalMarker: string }
  console.log(`marker=${externalModule.externalMarker}`)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
