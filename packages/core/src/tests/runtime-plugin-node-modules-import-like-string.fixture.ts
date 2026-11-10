import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-node-modules-import-like-string-fixture-"))
const externalPackageDir = join(tempRoot, "external", "node_modules", "runtime-plugin-import-like-string-fixture")
const externalPackageEntryPath = join(externalPackageDir, "index.js")

mkdirSync(externalPackageDir, { recursive: true })

writeFileSync(
  join(externalPackageDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-import-like-string-fixture",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(
  externalPackageEntryPath,
  [
    'import { marker } from "fixture-runtime"',
    'const fileContent = `import type { FiletypeParserOptions } from "./types.js"`',
    'export const externalMarker = `${marker}:${fileContent.includes("./types.js")}`',
  ].join("\n"),
)

registerPlugin.clearAll()

registerPlugin(
  createRuntimePlugin({
    additional: {
      "fixture-runtime": { marker: "resolved-with-import-like-string" },
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
