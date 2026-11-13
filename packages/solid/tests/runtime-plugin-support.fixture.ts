import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { plugin as registerPlugin } from "bun"
import * as coreRuntime from "@opentui/core"
import * as solidJsRuntime from "solid-js"
import * as solidRuntime from "../index.js"
import { resetSolidTransformPluginState } from "../scripts/solid-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "solid-runtime-plugin-support-fixture-"))
const entryPath = join(tempRoot, "entry.tsx")

const source = [
  'export { probe as local } from "./local.ts"',
  'export { probe as linked } from "linked/owner"',
  'export { probe as view } from "linked/view"',
  'import * as solid from "@opentui/solid"',
  'import * as core from "@opentui/core"',
  'import * as coreTesting from "@opentui/core/testing"',
  'import { createSignal } from "solid-js"',
  "const [value] = createSignal('ok')",
  "export const makeNode = () => <text>{value()}</text>",
  "export { solid, core, coreTesting, createSignal }",
].join("\n")

writeFileSync(entryPath, source)

const coreTesting = await import("@opentui/core/testing")

registerPlugin.clearAll()
resetSolidTransformPluginState()

try {
  const lib = join(tempRoot, "lib")
  const modules = join(tempRoot, "node_modules")
  mkdirSync(lib)
  mkdirSync(modules)
  symlinkSync(lib, join(modules, "linked"), "junction")
  cpSync(dirname(require.resolve("solid-js/package.json")), join(modules, "solid-js"), {
    recursive: true,
  })
  writeFileSync(
    join(lib, "package.json"),
    JSON.stringify({
      type: "module",
      exports: { "./owner": "./owner.ts", "./view": "./view.tsx" },
    }),
  )
  const probe = `import { getOwner, createMemo } from "solid-js"
    export const probe = (read) => [getOwner() !== null, createMemo(read)]`
  for (const file of ["local.ts", "lib/owner.ts", "lib/view.tsx"]) writeFileSync(join(tempRoot, file), probe)

  await import("../scripts/runtime-plugin-support.js")
  const plugin = await import(entryPath)
  console.log(`solid=${plugin.solid.extend === solidRuntime.extend};core=${plugin.core.engine === coreRuntime.engine}`)
  console.log(`coreTesting=${plugin.coreTesting.createTestRenderer === coreTesting.createTestRenderer}`)
  console.log(
    `solidJs=${plugin.createSignal === solidJsRuntime.createSignal};jsx=${typeof plugin.makeNode === "function"}`,
  )
  solidJsRuntime.createRoot((dispose) => {
    const [read, set] = solidJsRuntime.createSignal(0)
    const probes = ["local", "linked", "view"].map((name) => {
      const [owned, memo] = plugin[name](read)
      return () => `${name}=${owned}:${memo()}`
    })
    set(1)
    console.log(probes.map((result) => result()).join(";"))
    dispose()
  })
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
