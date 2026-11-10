import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as coreRuntime from "@opentui/core"
import * as solidJsRuntime from "solid-js"
import * as solidRuntime from "../index.js"

type FixtureState = typeof globalThis & {
  __solidRuntimeHost__?: {
    solid: Record<string, unknown>
    core: Record<string, unknown>
    coreTesting: Record<string, unknown>
    solidJs: Record<string, unknown>
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "solid-runtime-plugin-support-preload-fixture-"))
const entryPath = join(tempRoot, "entry.tsx")

const source = [
  'import * as solid from "@opentui/solid"',
  'import * as core from "@opentui/core"',
  'import * as coreTesting from "@opentui/core/testing"',
  'import { createSignal } from "solid-js"',
  "const state = globalThis as { __solidRuntimeHost__?: { solid: Record<string, unknown>; core: Record<string, unknown>; coreTesting: Record<string, unknown>; solidJs: Record<string, unknown> } }",
  "const [value] = createSignal('ok')",
  "const makeNode = () => <text>{value()}</text>",
  "const host = state.__solidRuntimeHost__",
  "const checks = [",
  "  `solid=${solid.extend === host?.solid.extend}`,",
  "  `core=${core.engine === host?.core.engine}`,",
  "  `coreTesting=${coreTesting.createTestRenderer === host?.coreTesting.createTestRenderer}`,",
  "  `solidJs=${createSignal === host?.solidJs.createSignal}`,",
  "  `jsx=${typeof makeNode === 'function'}`,",
  "]",
  "console.log(checks.join(';'))",
  "export const noop = 1",
].join("\n")

writeFileSync(entryPath, source)

const state = globalThis as FixtureState
state.__solidRuntimeHost__ = {
  solid: solidRuntime as Record<string, unknown>,
  core: coreRuntime as Record<string, unknown>,
  coreTesting: (await import("@opentui/core/testing")) as Record<string, unknown>,
  solidJs: solidJsRuntime as Record<string, unknown>,
}

try {
  await import("../scripts/runtime-plugin-support.js")
  await import(entryPath)
} finally {
  delete state.__solidRuntimeHost__
  rmSync(tempRoot, { recursive: true, force: true })
}
