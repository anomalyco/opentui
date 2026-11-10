import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-node-modules-cycle-fixture-"))
const packageADir = join(tempRoot, "external", "node_modules", "runtime-plugin-cycle-a")
const packageBDir = join(tempRoot, "external", "node_modules", "runtime-plugin-cycle-b")
const packageAEntryPath = join(packageADir, "index.js")

mkdirSync(packageADir, { recursive: true })
mkdirSync(packageBDir, { recursive: true })

writeFileSync(
  join(packageADir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-cycle-a",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(
  join(packageBDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-cycle-b",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(
  packageAEntryPath,
  [
    'import { marker } from "fixture-runtime"',
    'import { getMarkerB } from "runtime-plugin-cycle-b"',
    "export function getMarkerABase() {",
    "  return `aBase=${marker}`",
    "}",
    "export function getMarkerA() {",
    "  return `a=${marker};${getMarkerB()}`",
    "}",
  ].join("\n"),
)

writeFileSync(
  join(packageBDir, "index.js"),
  [
    'import { marker } from "fixture-runtime"',
    'import { getMarkerABase } from "runtime-plugin-cycle-a"',
    "export function getMarkerB() {",
    "  return `b=${marker};${getMarkerABase()}`",
    "}",
  ].join("\n"),
)

registerPlugin.clearAll()

registerPlugin(
  createRuntimePlugin({
    additional: {
      "fixture-runtime": { marker: "resolved-from-node-modules-cycle" },
    },
  }),
)

try {
  const externalModule = (await import(`${packageAEntryPath}?reload=1`)) as { getMarkerA: () => string }
  console.log(externalModule.getMarkerA())
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
