import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as solidJsRuntime from "solid-js"

type FixtureState = typeof globalThis & {
  __solidRuntimeHost__?: {
    solidJs: Record<string, unknown>
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "solid-runtime-plugin-support-node-modules-tsx-fixture-"))
const directPackageDir = join(tempRoot, "node_modules", "runtime-plugin-support-direct-tsx")
const nestedPackageDir = join(tempRoot, "node_modules", "runtime-plugin-support-nested-tsx")
const directEntryPath = join(directPackageDir, "index.tsx")
const nestedEntryPath = join(nestedPackageDir, "index.ts")

mkdirSync(directPackageDir, { recursive: true })
mkdirSync(nestedPackageDir, { recursive: true })

const packageJson = (name: string, entry: string) =>
  JSON.stringify({
    name,
    private: true,
    type: "module",
    exports: entry,
  })

const viewSource = [
  'import { createSignal } from "solid-js"',
  "const host = globalThis.__solidRuntimeHost__",
  "export const sameSolid = createSignal === host?.solidJs.createSignal",
  "export const view = () => <text>ok</text>",
].join("\n")

writeFileSync(join(directPackageDir, "package.json"), packageJson("runtime-plugin-support-direct-tsx", "./index.tsx"))
writeFileSync(directEntryPath, viewSource)
writeFileSync(join(nestedPackageDir, "package.json"), packageJson("runtime-plugin-support-nested-tsx", "./index.ts"))
writeFileSync(nestedEntryPath, 'export { sameSolid, view } from "./view.tsx"\n')
writeFileSync(join(nestedPackageDir, "view.tsx"), `/** @jsxImportSource @opentui/solid */\n${viewSource}`)

const state = globalThis as FixtureState
state.__solidRuntimeHost__ = {
  solidJs: solidJsRuntime as Record<string, unknown>,
}

try {
  await import("../scripts/runtime-plugin-support.js")
  const direct = await import(directEntryPath)
  const nested = await import(nestedEntryPath)
  console.log(
    [
      `directSolid=${direct.sameSolid}`,
      `directJsx=${typeof direct.view === "function"}`,
      `nestedSolid=${nested.sameSolid}`,
      `nestedJsx=${typeof nested.view === "function"}`,
    ].join(";"),
  )
} finally {
  delete state.__solidRuntimeHost__
  rmSync(tempRoot, { recursive: true, force: true })
}
