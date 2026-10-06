import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-preserve-specifiers-fixture-"))
const hostModuleDir = join(tempRoot, "host")
const externalPluginDir = join(tempRoot, "external-plugin")
const externalNodeModulesDir = join(externalPluginDir, "node_modules")
const foreignEffectDir = join(externalNodeModulesDir, "effect")
const pluginDependencyDir = join(externalNodeModulesDir, "plugin-local-dependency")
const scopedPackageDir = join(externalNodeModulesDir, "@runtime-plugin", "scoped-preserve-fixture")
const hostModulePath = join(hostModuleDir, "host-runtime.ts")
const pluginHelperPath = join(externalPluginDir, "helper.ts")
const externalPluginEntryPath = join(externalPluginDir, "index.ts")

mkdirSync(hostModuleDir, { recursive: true })
mkdirSync(foreignEffectDir, { recursive: true })
mkdirSync(pluginDependencyDir, { recursive: true })
mkdirSync(scopedPackageDir, { recursive: true })

writeFileSync(
  join(externalPluginDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-preserve-external-fixture",
    private: true,
    type: "module",
  }),
)

writeFileSync(
  join(foreignEffectDir, "package.json"),
  JSON.stringify({
    name: "effect",
    version: "0.0.0-foreign",
    type: "module",
    exports: {
      ".": "./index.js",
      "./Option": "./Option.js",
    },
  }),
)

writeFileSync(join(foreignEffectDir, "index.js"), 'export const Effect = "foreign-effect"\n')
writeFileSync(join(foreignEffectDir, "Option.js"), 'export const some = "foreign-option"\n')

writeFileSync(
  join(pluginDependencyDir, "package.json"),
  JSON.stringify({
    name: "plugin-local-dependency",
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(join(pluginDependencyDir, "index.js"), 'export const marker = "resolved-from-plugin-node-modules"\n')

writeFileSync(
  join(scopedPackageDir, "package.json"),
  JSON.stringify({
    name: "@runtime-plugin/scoped-preserve-fixture",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(
  join(scopedPackageDir, "index.js"),
  [
    'import { marker as coreMarker } from "@opentui/core"',
    'import { siblingMarker } from "./sibling.js"',
    "export const scopedMarker = `${coreMarker}:${siblingMarker}`",
  ].join("\n"),
)

writeFileSync(
  join(scopedPackageDir, "sibling.js"),
  [
    'import { Effect } from "effect"',
    'import { marker } from "plugin-local-dependency"',
    "export const siblingMarker = `${Effect}:${marker}`",
  ].join("\n"),
)

writeFileSync(
  hostModulePath,
  ['import { marker } from "plugin-local-dependency"', "export const hostRuntimeMarker = marker"].join("\n"),
)

writeFileSync(
  pluginHelperPath,
  [
    'import { Effect } from "effect"',
    'import { marker } from "plugin-local-dependency"',
    'export { some as reexportedOption } from "effect/Option"',
    "export const helperMarker = `${Effect}:${marker}`",
  ].join("\n"),
)

writeFileSync(
  externalPluginEntryPath,
  [
    'import { marker as coreMarker } from "@opentui/core"',
    'import { hostRuntimeMarker } from "fixture-host-runtime"',
    'import { Effect } from "effect"',
    'import { some } from "effect/Option"',
    'import { scopedMarker } from "@runtime-plugin/scoped-preserve-fixture"',
    'import { helperMarker, reexportedOption } from "./helper.ts"',
    'const dynamicEffect = await import("effect")',
    'const requiredOption = require("effect/Option")',
    "console.log([",
    "  `core=${coreMarker}`,",
    "  `effect=${Effect}`,",
    "  `option=${some}`,",
    "  `reexportedOption=${reexportedOption}`,",
    "  `dynamicEffect=${dynamicEffect.Effect}`,",
    "  `requiredOption=${requiredOption.some}`,",
    "  `hostDep=${hostRuntimeMarker}`,",
    "  `helper=${helperMarker}`,",
    "  `scoped=${scopedMarker}`,",
    '].join(";"))',
    "export const noop = 1",
  ].join("\n"),
)

registerPlugin.clearAll()

registerPlugin({
  name: "fixture-host-build-modules",
  setup(build) {
    build.module("effect", () => ({
      exports: { Effect: "host-effect" },
      loader: "object",
    }))
    build.module("effect/Option", () => ({
      exports: { some: "host-option" },
      loader: "object",
    }))
  },
})

registerPlugin(
  createRuntimePlugin({
    core: {
      marker: "host-core",
    },
    additional: {
      "fixture-host-runtime": async () => (await import(hostModulePath)) as Record<string, unknown>,
    },
    preserve: (specifier: string) =>
      specifier === "@opentui/core" ||
      specifier === "fixture-host-runtime" ||
      specifier === "effect" ||
      specifier.startsWith("effect/"),
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
