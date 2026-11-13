import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-node-modules-runtime-specifier-fixture-"))
const externalPackageDir = join(tempRoot, "node_modules", "consumer")
const externalPackageEntryPath = join(externalPackageDir, "index.js")

const privateCoreDir = join(externalPackageDir, "node_modules", "@opentui", "core")
mkdirSync(privateCoreDir, { recursive: true })
writeFileSync(join(privateCoreDir, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }))
writeFileSync(join(privateCoreDir, "index.js"), 'export const marker = "private"')

writeFileSync(join(externalPackageDir, "package.json"), JSON.stringify({ type: "module" }))
writeFileSync(externalPackageEntryPath, 'export { marker } from "@opentui/core"')

registerPlugin.clearAll()
const mode = process.argv[2] ?? "default"
registerPlugin(
  createRuntimePlugin({
    core: { marker: "host" },
    rewrite:
      mode === "default"
        ? undefined
        : { nodeModulesRuntimeSpecifiers: false, nodeModulesBareSpecifiers: mode === "bare-only" },
  }),
)

try {
  const { marker } = await import(externalPackageEntryPath)
  console.log(`marker=${marker}`)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
