import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { plugin as registerPlugin } from "bun"
import * as coreRuntime from "@opentui/core"
import * as solidJsRuntime from "solid-js"
import { createStore } from "solid-js/store"
import * as solidRuntime from "../index.js"
import { resetSolidTransformPluginState } from "../scripts/solid-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "solid-runtime-plugin-support-fixture-"))
const entryPath = join(tempRoot, "entry.tsx")

const source = [
  'export { probe as local } from "./local.ts"',
  'export { probe as linked, engine, extend, privateMarker } from "linked/owner"',
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
    import { unwrap } from "solid-js/store"
    export const probe = (read, store) => [getOwner() !== null, createMemo(read), unwrap(store)]`
  for (const file of ["local.ts", "lib/view.tsx"]) writeFileSync(join(tempRoot, file), probe)
  const privateDir = join(lib, "node_modules", "entities")
  mkdirSync(privateDir, { recursive: true })
  writeFileSync(join(privateDir, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }))
  writeFileSync(join(privateDir, "index.js"), 'export const decodeHTML = () => "linked"')
  writeFileSync(
    join(lib, "owner.ts"),
    `${probe}
    export { engine } from "@opentui/core"
    export { extend } from "@opentui/solid"
    import { decodeHTML } from "entities"
    export const privateMarker = decodeHTML("&amp;")`,
  )

  if (process.argv[2] === "preserve") {
    const { ensureRuntimePluginSupport } = await import("../scripts/runtime-plugin-support-configure.js")
    const preserve = ["@opentui/core", "@opentui/solid"]
    registerPlugin({
      name: "earlier-host",
      setup(build) {
        for (const name of preserve)
          build.module(name, () => ({ exports: { engine: "earlier", extend: "earlier" }, loader: "object" }))
      },
    })
    ensureRuntimePluginSupport({ core: coreRuntime, additional: { "@opentui/solid": solidRuntime }, preserve })
  } else {
    await import("../scripts/runtime-plugin-support.js")
  }
  const plugin = await import(entryPath)
  console.log(
    `linkedCore=${plugin.engine === coreRuntime.engine};linkedSolid=${plugin.extend === solidRuntime.extend};private=${plugin.privateMarker}`,
  )
  console.log(`solid=${plugin.solid.extend === solidRuntime.extend};core=${plugin.core.engine === coreRuntime.engine}`)
  console.log(`coreTesting=${plugin.coreTesting.createTestRenderer === coreTesting.createTestRenderer}`)
  console.log(
    `solidJs=${plugin.createSignal === solidJsRuntime.createSignal};jsx=${typeof plugin.makeNode === "function"}`,
  )
  solidJsRuntime.createRoot((dispose) => {
    const [read, set] = solidJsRuntime.createSignal(0)
    const raw = { value: 0 }
    const [store] = createStore(raw)
    const probes = ["local", "linked", "view"].map((name) => {
      const [owned, memo, unwrapped] = plugin[name](read, store)
      return () => `${name}=${owned}:${memo()}:${unwrapped === raw}`
    })
    set(1)
    console.log(probes.map((result) => result()).join(";"))
    dispose()
  })
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
