import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as coreRuntime from "@opentui/core"
import * as solidJsRuntime from "solid-js"
import * as solidJsStoreRuntime from "solid-js/store"
import * as solidRuntime from "../index.js"

type FixtureState = typeof globalThis & {
  __solidRuntimeHost__?: {
    solid: Record<string, unknown>
    core: Record<string, unknown>
    coreTesting: Record<string, unknown>
    solidJs: Record<string, unknown>
    solidJsStore: Record<string, unknown>
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "solid-runtime-plugin-support-node-modules-fixture-"))
const commonJsDependencyDir = join(tempRoot, "node_modules", "runtime-plugin-support-cjs-dependency")
const esmPrimitivesDependencyDir = join(tempRoot, "node_modules", "runtime-plugin-support-esm-primitives")
const esmWrapperDependencyDir = join(tempRoot, "node_modules", "runtime-plugin-support-esm-wrapper")
const externalPackageDir = join(tempRoot, "node_modules", "runtime-plugin-support-node-modules-fixture")
const externalPackageEntryPath = join(externalPackageDir, "index.js")

mkdirSync(commonJsDependencyDir, { recursive: true })
mkdirSync(esmPrimitivesDependencyDir, { recursive: true })
mkdirSync(esmWrapperDependencyDir, { recursive: true })
mkdirSync(externalPackageDir, { recursive: true })

writeFileSync(
  join(commonJsDependencyDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-support-cjs-dependency",
    private: true,
    main: "./index.js",
  }),
)

writeFileSync(join(commonJsDependencyDir, "index.js"), "exports.parse = (input) => JSON.parse(input)\n")

writeFileSync(
  join(esmPrimitivesDependencyDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-support-esm-primitives",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(
  join(esmPrimitivesDependencyDir, "index.js"),
  [
    'import { engine } from "@opentui/core"',
    'import { extend } from "@opentui/solid"',
    'import { createSignal } from "solid-js"',
    "const host = globalThis.__solidRuntimeHost__",
    "export const checks = {",
    "  core: engine === host?.core.engine,",
    "  solid: extend === host?.solid.extend,",
    "  solidJs: createSignal === host?.solidJs.createSignal,",
    "}",
    "",
  ].join("\n"),
)

writeFileSync(
  join(esmWrapperDependencyDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-support-esm-wrapper",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(
  join(esmWrapperDependencyDir, "index.js"),
  'export { checks } from "runtime-plugin-support-esm-primitives"\n',
)

writeFileSync(
  join(externalPackageDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-support-node-modules-fixture",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

const source = [
  'import * as solid from "@opentui/solid"',
  'import * as core from "@opentui/core"',
  'import * as coreTesting from "@opentui/core/testing"',
  'import { createSignal } from "solid-js"',
  'import { parse } from "runtime-plugin-support-cjs-dependency"',
  'import { checks as esmChecks } from "runtime-plugin-support-esm-wrapper"',
  'import * as solidStore from "solid-js/store"',
  "const host = globalThis.__solidRuntimeHost__",
  "const checks = [",
  "  `solid=${solid.extend === host?.solid.extend}`,",
  "  `core=${core.engine === host?.core.engine}`,",
  "  `coreTesting=${coreTesting.createTestRenderer === host?.coreTesting.createTestRenderer}`,",
  "  `solidJs=${createSignal === host?.solidJs.createSignal}`,",
  "  `cjs=${parse('{\\\"value\\\":1}').value === 1}`,",
  "  `esmPackage=${esmChecks.core && esmChecks.solid && esmChecks.solidJs}`,",
  "  `solidStore=${solidStore.createStore === host?.solidJsStore.createStore}`,",
  "]",
  "console.log(checks.join(';'))",
  "export const noop = 1",
].join("\n")

writeFileSync(externalPackageEntryPath, source)

const state = globalThis as FixtureState
state.__solidRuntimeHost__ = {
  solid: solidRuntime as Record<string, unknown>,
  core: coreRuntime as Record<string, unknown>,
  coreTesting: (await import("@opentui/core/testing")) as Record<string, unknown>,
  solidJs: solidJsRuntime as Record<string, unknown>,
  solidJsStore: solidJsStoreRuntime as Record<string, unknown>,
}

try {
  await import("../scripts/runtime-plugin-support.js")
  await import(externalPackageEntryPath)
} finally {
  delete state.__solidRuntimeHost__
  rmSync(tempRoot, { recursive: true, force: true })
}
