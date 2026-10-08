import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import type { RuntimeModuleEntry } from "@opentui/core/runtime-plugin"
import * as keymapRuntime from "@opentui/keymap"
import * as keymapAddonsRuntime from "@opentui/keymap/addons"
import * as keymapExtrasRuntime from "@opentui/keymap/extras"
import * as keymapSolidRuntime from "@opentui/keymap/solid"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import * as threeRuntime from "../../three/src/index.js"
import { resetSolidTransformPluginState } from "../scripts/solid-plugin.js"

type FixtureState = typeof globalThis & {
  __solidRuntimeHost__?: {
    keymap: Record<string, unknown>
    keymapAddons: Record<string, unknown>
    keymapExtras: Record<string, unknown>
    keymapSolid: Record<string, unknown>
    three: Record<string, unknown>
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "solid-runtime-plugin-support-configure-fixture-"))
const foreignPreservedDir = join(tempRoot, "node_modules", "preserved-host-pkg")
const preservedTsEntryPath = join(tempRoot, "entry.ts")

mkdirSync(foreignPreservedDir, { recursive: true })
writeFileSync(
  join(foreignPreservedDir, "package.json"),
  JSON.stringify({
    name: "preserved-host-pkg",
    type: "module",
    exports: "./index.js",
  }),
)
writeFileSync(join(foreignPreservedDir, "index.js"), 'export const preserved = "foreign"\n')
writeFileSync(
  preservedTsEntryPath,
  [
    'import { stringifyKeyStroke } from "@opentui/keymap"',
    'import { preserved } from "preserved-host-pkg"',
    "const host = globalThis.__solidRuntimeHost__",
    "console.log(`preservedTs=${preserved === 'host' && stringifyKeyStroke === host?.keymap.stringifyKeyStroke}`)",
    "export const noop = 1",
  ].join("\n"),
)

const state = globalThis as FixtureState
state.__solidRuntimeHost__ = {
  keymap: keymapRuntime as Record<string, unknown>,
  keymapAddons: keymapAddonsRuntime as Record<string, unknown>,
  keymapExtras: keymapExtrasRuntime as Record<string, unknown>,
  keymapSolid: keymapSolidRuntime as Record<string, unknown>,
  three: threeRuntime as Record<string, unknown>,
}

registerPlugin.clearAll()
resetSolidTransformPluginState()

try {
  registerPlugin({
    name: "fixture-preserved-host-pkg",
    setup(build) {
      build.module("preserved-host-pkg", () => ({
        exports: { preserved: "host" },
        loader: "object",
      }))
    },
  })

  const additional = {
    "@opentui/keymap": keymapRuntime,
    "@opentui/keymap/addons": keymapAddonsRuntime,
    "@opentui/keymap/extras": keymapExtrasRuntime,
    "@opentui/keymap/solid": keymapSolidRuntime,
    "@opentui/three": threeRuntime,
  } satisfies Record<string, RuntimeModuleEntry>
  const preserve = (specifier: string) => specifier === "preserved-host-pkg"
  const first = ensureRuntimePluginSupport({ additional, preserve })
  const second = ensureRuntimePluginSupport({ additional, preserve })
  let mismatchError = ""
  try {
    ensureRuntimePluginSupport({ additional, preserve: ["other-pkg"] })
  } catch (error) {
    mismatchError = error instanceof Error ? error.message : String(error)
  }
  console.log(`first=${first};second=${second};mismatch=${mismatchError}`)
  await import("./runtime-plugin-support-configure-entry.fixture.tsx")
  await import(preservedTsEntryPath)
} finally {
  registerPlugin.clearAll()
  delete state.__solidRuntimeHost__
  rmSync(tempRoot, { recursive: true, force: true })
}
