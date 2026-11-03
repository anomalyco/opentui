import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-preserve-specifiers-fixture-"))
const hostModuleDir = join(tempRoot, "host")
const externalPluginDir = join(tempRoot, "external-plugin")
const foreignEffectDir = join(externalPluginDir, "node_modules", "effect")
const pluginDependencyDir = join(externalPluginDir, "node_modules", "plugin-local-dependency")
const hostModulePath = join(hostModuleDir, "host-runtime.ts")
const externalPluginEntryPath = join(externalPluginDir, "index.ts")

mkdirSync(hostModuleDir, { recursive: true })
mkdirSync(foreignEffectDir, { recursive: true })
mkdirSync(pluginDependencyDir, { recursive: true })

writeFileSync(
  join(foreignEffectDir, "package.json"),
  JSON.stringify({
    name: "effect",
    type: "module",
    exports: { ".": "./index.js", "./Option": "./Option.js" },
  }),
)
writeFileSync(join(foreignEffectDir, "index.js"), 'export const Effect = "foreign-effect"\n')
writeFileSync(join(foreignEffectDir, "Option.js"), 'export const some = "foreign-option"\n')

writeFileSync(
  join(pluginDependencyDir, "package.json"),
  JSON.stringify({ name: "plugin-local-dependency", type: "module", exports: "./index.js" }),
)
writeFileSync(join(pluginDependencyDir, "index.js"), 'export const marker = "resolved-from-plugin-node-modules"\n')

writeFileSync(
  hostModulePath,
  ['import { marker } from "plugin-local-dependency"', "export const hostRuntimeMarker = marker"].join("\n"),
)

writeFileSync(
  externalPluginEntryPath,
  [
    'import { marker as coreMarker } from "@opentui/core"',
    'import { hostRuntimeMarker } from "fixture-host-runtime"',
    'import { Effect } from "effect"',
    'import { some } from "effect/Option"',
    "console.log(`core=${coreMarker};effect=${Effect};option=${some};hostDep=${hostRuntimeMarker}`)",
    "export const noop = 1",
  ].join("\n"),
)

registerPlugin.clearAll()

registerPlugin({
  name: "fixture-host-build-modules",
  setup(build) {
    build.module("effect", () => ({ exports: { Effect: "host-effect" }, loader: "object" }))
    build.module("effect/Option", () => ({ exports: { some: "host-option" }, loader: "object" }))
  },
})

registerPlugin(
  createRuntimePlugin({
    core: { marker: "host-core" },
    additional: {
      "fixture-host-runtime": async () => (await import(hostModulePath)) as Record<string, unknown>,
    },
    // Runtime modules still take precedence when a predicate also matches them.
    preserve: (specifier) =>
      specifier === "@opentui/core" ||
      specifier === "fixture-host-runtime" ||
      specifier === "effect" ||
      specifier.startsWith("effect/"),
  }),
)

try {
  await import(externalPluginEntryPath)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
