import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-node-modules-no-bare-rewrite-fixture-"))
const hostRuntimeDir = join(tempRoot, "host-runtime")
const hostRuntimePath = join(hostRuntimeDir, "index.ts")
const hostRuntimeDependencyDir = join(hostRuntimeDir, "node_modules", "node-modules-bare-dependency")
const isolatedPackageDir = join(tempRoot, "isolated", "node_modules", "runtime-plugin-no-bare-fixture")
const isolatedPackagePath = join(isolatedPackageDir, "index.js")

mkdirSync(hostRuntimeDependencyDir, { recursive: true })
mkdirSync(isolatedPackageDir, { recursive: true })

writeFileSync(
  join(hostRuntimeDependencyDir, "package.json"),
  JSON.stringify({
    name: "node-modules-bare-dependency",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(join(hostRuntimeDependencyDir, "index.js"), 'export const marker = "resolved-from-host-runtime-parent"\n')

writeFileSync(
  hostRuntimePath,
  ['import { marker } from "@opentui/core"', "export const hostRuntimeMarker = marker"].join("\n"),
)

writeFileSync(
  isolatedPackagePath,
  [
    'import { marker as coreMarker } from "@opentui/core"',
    'import { marker as dependencyMarker } from "node-modules-bare-dependency"',
    "export const marker = `${coreMarker}:${dependencyMarker}`",
  ].join("\n"),
)

registerPlugin.clearAll()

registerPlugin(
  createRuntimePlugin({
    core: {
      marker: "core-runtime-marker",
    },
  }),
)

try {
  await import(hostRuntimePath)

  try {
    await import(isolatedPackagePath)
    console.log("errorContainsMissingBareDependency=false")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const containsMissingBareDependency = message.includes("node-modules-bare-dependency")
    console.log(`errorContainsMissingBareDependency=${containsMissingBareDependency}`)
  }
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
