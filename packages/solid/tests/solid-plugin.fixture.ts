import { rmSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin, runtimeModuleIdForSpecifier, type RuntimeModuleEntry } from "@opentui/core/runtime-plugin"
import * as solidRuntime from "../index.js"
import { createSolidTransformPlugin } from "../scripts/solid-plugin.js"

const tempRoot = mkdtempSync(join(import.meta.dir, "solid-plugin-fixture-"))
const entryPath = join(tempRoot, "entry.tsx")

const additionalRuntimeModules: Record<string, RuntimeModuleEntry> = {
  "@opentui/solid": solidRuntime as Record<string, unknown>,
  "fixture-sync": { value: "sync-value" },
  "@fixture/async-module": async () => ({ value: "async-value" }),
}

const runtimeResolvedSpecifiers = new Set<string>(["@opentui/core", ...Object.keys(additionalRuntimeModules)])

const source = [
  'import { value as syncValue } from "fixture-sync"',
  'import { value as asyncValue } from "@fixture/async-module"',
  "const makeNode = () => <text>{`sync=${syncValue};async=${asyncValue}`}</text>",
  "console.log(`sync=${syncValue};async=${asyncValue};jsx=${typeof makeNode === 'function'}`)",
  "export const noop = 1",
].join("\n")

writeFileSync(entryPath, source)

registerPlugin.clearAll()

registerPlugin(
  createSolidTransformPlugin({
    moduleName: runtimeModuleIdForSpecifier("@opentui/solid"),
    resolvePath(specifier) {
      if (!runtimeResolvedSpecifiers.has(specifier)) {
        return null
      }

      return runtimeModuleIdForSpecifier(specifier)
    },
  }),
)

registerPlugin(
  createRuntimePlugin({
    additional: additionalRuntimeModules,
  }),
)

try {
  await import(entryPath)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
