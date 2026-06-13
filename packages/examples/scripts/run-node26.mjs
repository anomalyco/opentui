import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { requireNode26 } from "../../../scripts/node26.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, "..")
const repoRoot = resolve(packageRoot, "../..")
const coreRoot = resolve(repoRoot, "packages/core")
const coreDistDir = resolve(coreRoot, "dist")
const nodePath = requireNode26()
const bundleDir = resolve(packageRoot, ".node")
const bundleEntry = resolve(bundleDir, "index.js")
const workerEntry = resolve(bundleDir, "parser.worker.js")

prepareCorePackage()
buildNodeExamples()
copyCoreDistPackage()

const result = spawnSync(nodePath, ["--experimental-ffi", "--no-warnings", bundleEntry], {
  cwd: packageRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    OTUI_TREE_SITTER_WORKER_PATH: pathToFileURL(workerEntry).href,
  },
})

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 0)

function buildNodeExamples() {
  rmSync(bundleDir, { recursive: true, force: true })

  run(
    "bun",
    [
      "build",
      "src/index.ts",
      "../core/src/lib/tree-sitter/parser.worker.ts",
      "--target=node",
      "--format=esm",
      "--splitting",
      "--outdir",
      ".node",
      "--entry-naming",
      "[name].[ext]",
      "--define",
      "OPENTUI_BUN_ONLY_EXAMPLES=false",
      "--external",
      "@opentui/core",
    ],
    packageRoot,
  )
}

function prepareCorePackage() {
  const nativePackageName = `core-${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`
  const sourceNativeDir = resolve(coreRoot, "node_modules", "@opentui", nativePackageName)
  const targetNativeDir = resolve(packageRoot, "node_modules", "@opentui", nativePackageName)

  run("bun", ["run", "build"], coreRoot)

  mkdirSync(resolve(packageRoot, "node_modules", "@opentui"), { recursive: true })
  rmSync(targetNativeDir, { recursive: true, force: true })
  cpSync(sourceNativeDir, targetNativeDir, { recursive: true, dereference: true })
}

function copyCoreDistPackage() {
  const targetCoreDir = resolve(bundleDir, "node_modules", "@opentui", "core")

  mkdirSync(resolve(targetCoreDir, ".."), { recursive: true })
  cpSync(coreDistDir, targetCoreDir, { recursive: true })
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
