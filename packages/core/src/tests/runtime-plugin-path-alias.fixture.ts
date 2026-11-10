import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const realRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-path-alias-fixture-"))
const aliasRoot = join(dirname(realRoot), `core-runtime-plugin-path-alias-link-${Math.random().toString(36).slice(2)}`)
const realEntryPath = join(realRoot, "external.ts")
const aliasEntryPath = join(aliasRoot, "external.ts")

writeFileSync(
  realEntryPath,
  ['import { marker } from "@opentui/core"', "export const externalMarker = marker"].join("\n"),
)

symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir")

registerPlugin.clearAll()

registerPlugin(
  createRuntimePlugin({
    core: {
      marker: "resolved-from-path-alias",
    },
  }),
)

try {
  const aliasPathCanonicalized = aliasEntryPath !== realpathSync(aliasEntryPath)
  const externalModule = (await import(aliasEntryPath)) as { externalMarker: string }
  console.log(`aliasPathCanonicalized=${aliasPathCanonicalized};marker=${externalModule.externalMarker}`)
} finally {
  registerPlugin.clearAll()

  try {
    unlinkSync(aliasRoot)
  } catch {
    rmSync(aliasRoot, { recursive: true, force: true })
  }

  rmSync(realRoot, { recursive: true, force: true })
}
