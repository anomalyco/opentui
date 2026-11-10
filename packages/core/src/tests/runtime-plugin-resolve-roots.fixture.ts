import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-resolve-roots-fixture-"))
const hostModuleDir = join(tempRoot, "host")
const externalPluginDir = join(tempRoot, "external-plugin")
const externalNodeModules = join(externalPluginDir, "node_modules")
const externalDependencyDir = join(externalNodeModules, "runtime-root-dependency")
const hostModulePath = join(hostModuleDir, "host-runtime.ts")
const externalPluginEntryPath = join(externalPluginDir, "index.ts")

mkdirSync(hostModuleDir, { recursive: true })
mkdirSync(externalDependencyDir, { recursive: true })

writeFileSync(
  join(externalPluginDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-external-fixture",
    private: true,
    type: "module",
  }),
)

writeFileSync(
  join(externalDependencyDir, "package.json"),
  JSON.stringify({
    name: "runtime-root-dependency",
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(join(externalDependencyDir, "index.js"), 'export const marker = "resolved-from-external-root"\n')

writeFileSync(
  hostModulePath,
  ['import { marker } from "runtime-root-dependency"', "export const hostRuntimeMarker = marker"].join("\n"),
)

writeFileSync(
  externalPluginEntryPath,
  ['import { hostRuntimeMarker } from "fixture-host-runtime"', "export const marker = hostRuntimeMarker"].join("\n"),
)

registerPlugin.clearAll()

registerPlugin(
  createRuntimePlugin({
    additional: {
      "fixture-host-runtime": async () => (await import(hostModulePath)) as Record<string, unknown>,
    },
  }),
)

try {
  const externalPlugin = (await import(externalPluginEntryPath)) as { marker: string }
  console.log(`marker=${externalPlugin.marker}`)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
