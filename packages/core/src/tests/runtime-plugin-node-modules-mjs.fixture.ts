import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-node-modules-mjs-fixture-"))
const externalPackageDir = join(tempRoot, "external", "node_modules", "runtime-plugin-node-modules-mjs-fixture")
const externalPackageEntryPath = join(externalPackageDir, "index.mjs")

mkdirSync(externalPackageDir, { recursive: true })

writeFileSync(
  join(externalPackageDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-node-modules-mjs-fixture",
    private: true,
    exports: "./index.mjs",
  }),
)

writeFileSync(
  externalPackageEntryPath,
  ['import { marker } from "fixture-runtime"', "export const externalMarker = marker"].join("\n"),
)

registerPlugin.clearAll()

registerPlugin(
  createRuntimePlugin({
    additional: {
      "fixture-runtime": { marker: "resolved-from-node-modules-mjs" },
    },
  }),
)

try {
  const externalModule = (await import(`${externalPackageEntryPath}?reload=1`)) as { externalMarker: string }
  console.log(`marker=${externalModule.externalMarker}`)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
