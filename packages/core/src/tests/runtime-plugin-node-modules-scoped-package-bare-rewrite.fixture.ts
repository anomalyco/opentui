import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-node-modules-scoped-package-bare-rewrite-fixture-"))
const externalPluginDir = join(tempRoot, "external-plugin")
const externalNodeModulesDir = join(externalPluginDir, "node_modules")
const hostRuntimeDependencyDir = join(externalNodeModulesDir, "host-runtime-dependency")
const scopedPackageDir = join(externalNodeModulesDir, "@runtime-plugin", "scoped-fixture")
const externalPluginEntryPath = join(externalPluginDir, "index.ts")

mkdirSync(hostRuntimeDependencyDir, { recursive: true })
mkdirSync(scopedPackageDir, { recursive: true })

writeFileSync(
  join(hostRuntimeDependencyDir, "package.json"),
  JSON.stringify({
    name: "host-runtime-dependency",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(
  join(hostRuntimeDependencyDir, "index.js"),
  'export const marker = "resolved-from-scoped-package-parent"\n',
)

writeFileSync(
  join(scopedPackageDir, "package.json"),
  JSON.stringify({
    name: "@runtime-plugin/scoped-fixture",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(
  join(scopedPackageDir, "index.js"),
  [
    'import { marker as runtimeMarker } from "fixture-runtime"',
    'import { helperMarker } from "./helper.js"',
    "export const marker = `${runtimeMarker}:${helperMarker}`",
  ].join("\n"),
)

writeFileSync(
  join(scopedPackageDir, "helper.js"),
  ['import { marker } from "host-runtime-dependency"', "export const helperMarker = marker"].join("\n"),
)

writeFileSync(
  externalPluginEntryPath,
  [
    'import { marker as entryMarker } from "fixture-entry-runtime"',
    'import { marker as scopedMarker } from "@runtime-plugin/scoped-fixture"',
    "console.log(`entry=${entryMarker};scoped=${scopedMarker}`)",
    "export const noop = 1",
  ].join("\n"),
)

registerPlugin.clearAll()

registerPlugin(
  createRuntimePlugin({
    additional: {
      "fixture-entry-runtime": { marker: "entry-runtime-marker" },
      "fixture-runtime": { marker: "scoped-runtime-marker" },
    },
    rewrite: {
      nodeModulesBareSpecifiers: true,
    },
  }),
)

try {
  await import(`${externalPluginEntryPath}?reload=1`)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
