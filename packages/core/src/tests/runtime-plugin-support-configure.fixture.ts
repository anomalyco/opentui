import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { ensureRuntimePluginSupport } from "../runtime-plugin-support-configure.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-support-configure-fixture-"))
const foreignPreservedDir = join(tempRoot, "node_modules", "preserved-host-pkg")
const entryPath = join(tempRoot, "entry.ts")

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

const source = [
  'import { marker } from "runtime-plugin-support-extra"',
  'import { preserved } from "preserved-host-pkg"',
  "console.log(`extra=${marker};preserved=${preserved}`)",
  "export const noop = 1",
].join("\n")

writeFileSync(entryPath, source)

registerPlugin.clearAll()

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
    "runtime-plugin-support-extra": { marker: "ok" },
  }
  const first = ensureRuntimePluginSupport({ additional, preserve: ["preserved-host-pkg"] })
  const second = ensureRuntimePluginSupport({ additional, preserve: new Set(["preserved-host-pkg"]) })
  let mismatchError = ""
  try {
    ensureRuntimePluginSupport({ additional, preserve: ["other-pkg"] })
  } catch (error) {
    mismatchError = error instanceof Error ? error.message : String(error)
  }
  console.log(`first=${first};second=${second};mismatch=${mismatchError}`)
  await import(entryPath)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
