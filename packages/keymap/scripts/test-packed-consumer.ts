/**
 * Smoke-tests the packed npm consumer contract for `@opentui/keymap`.
 *
 * This verifies the built tarballs install in a fresh Node project and that the
 * Node-safe keymap entrypoints import and run without Bun or FFI flags.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { requireNode26 } from "../../../scripts/node26.mjs"

interface PackageJson {
  name: string
  version: string
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const coreRootDir = resolve(rootDir, "..", "core")
const distDir = join(rootDir, "dist")
const coreDistDir = join(coreRootDir, "dist")
const args = new Set(process.argv.slice(2))
const keepTemp = args.has("--keep-temp")
const skipBuild = args.has("--skip-build")
const nodePath = requireNode26()

const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as PackageJson
const corePackageJson = JSON.parse(readFileSync(join(coreRootDir, "package.json"), "utf8")) as PackageJson
const nativePackageName = `${corePackageJson.name}-${process.platform}-${process.arch}`
const nativePackageDir = join(coreRootDir, "node_modules", nativePackageName)

function runCommand(
  command: string,
  commandArgs: string[],
  cwd: string,
  errorMessage: string,
  options: { stdio?: "inherit" | "pipe" } = {},
): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: options.stdio ?? "inherit",
  })

  if (result.error) {
    throw new Error(`${errorMessage}: ${result.error.message}`)
  }

  if (result.status !== 0) {
    throw new Error(errorMessage)
  }

  return result
}

function ensureBuildArtifacts(): void {
  if (!skipBuild) {
    runCommand("bun", ["run", "build"], coreRootDir, "Core build failed")
    runCommand("bun", ["run", "build"], rootDir, "Keymap build failed")
  }

  if (!existsSync(coreDistDir)) {
    throw new Error(`Missing core dist directory at ${coreDistDir}. Run bun run build in packages/core first.`)
  }

  if (!existsSync(distDir)) {
    throw new Error(`Missing keymap dist directory at ${distDir}. Run bun run build first.`)
  }

  if (!existsSync(nativePackageDir)) {
    throw new Error(
      `Missing native package directory at ${nativePackageDir}. Run bun run build in packages/core first.`,
    )
  }
}

function packArtifact(packageDir: string, packDir: string): string {
  const result = runCommand(
    "npm",
    ["pack", "--pack-destination", packDir],
    packageDir,
    `Failed to pack ${packageDir}`,
    {
      stdio: "pipe",
    },
  )

  const tarballName = result.stdout.toString("utf8").trim().split(/\r?\n/).at(-1)
  if (!tarballName) {
    throw new Error(`Failed to determine tarball name for ${packageDir}`)
  }

  return join(packDir, tarballName)
}

function writeConsumerPackage(
  consumerDir: string,
  keymapTarball: string,
  coreTarball: string,
  nativeTarball: string,
): void {
  const keymapDependency = `file:${relative(consumerDir, keymapTarball).replaceAll("\\", "/")}`
  const coreDependency = `file:${relative(consumerDir, coreTarball).replaceAll("\\", "/")}`
  const nativeDependency = `file:${relative(consumerDir, nativeTarball).replaceAll("\\", "/")}`

  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "opentui-keymap-dist-test-node",
        private: true,
        type: "module",
        dependencies: {
          [packageJson.name]: keymapDependency,
          [corePackageJson.name]: coreDependency,
          [nativePackageName]: nativeDependency,
        },
      },
      null,
      2,
    ),
  )
}

function writeNodeTest(nodeDir: string): void {
  writeFileSync(
    join(nodeDir, "index.mjs"),
    `import assert from "node:assert/strict"

const nativePackageName = ${JSON.stringify(nativePackageName)}

const keymap = await import(${JSON.stringify(packageJson.name)})
const addons = await import(${JSON.stringify(`${packageJson.name}/addons`)})
const opentuiAddons = await import(${JSON.stringify(`${packageJson.name}/addons/opentui`)})
const extras = await import(${JSON.stringify(`${packageJson.name}/extras`)})
const graph = await import(${JSON.stringify(`${packageJson.name}/extras/graph`)})
const html = await import(${JSON.stringify(`${packageJson.name}/html`)})
const opentui = await import(${JSON.stringify(`${packageJson.name}/opentui`)})
const runtimeModules = await import(${JSON.stringify(`${packageJson.name}/runtime-modules`)})
const testing = await import(${JSON.stringify(`${packageJson.name}/testing`)})
const nativePackage = await import(nativePackageName)

assert.equal(typeof keymap.Keymap, "function")
assert.equal(typeof keymap.stringifyKeyStroke, "function")
assert.equal(typeof addons.registerDefaultKeys, "function")
assert.equal(typeof opentuiAddons.registerBaseLayoutFallback, "function")
assert.equal(typeof opentuiAddons.createTextareaBindings, "function")
assert.equal(typeof extras.formatKeySequence, "function")
assert.equal(typeof graph.getGraphSnapshot, "function")
assert.equal(typeof html.createHtmlKeymapEvent, "function")
assert.equal(typeof opentui.createOpenTuiKeymap, "function")
assert.equal(typeof runtimeModules.runtimeModules[${JSON.stringify(packageJson.name)}], "object")
assert.equal(typeof runtimeModules.runtimeModules[${JSON.stringify(`${packageJson.name}/react`)}], "function")
assert.equal(typeof runtimeModules.runtimeModules[${JSON.stringify(`${packageJson.name}/solid`)}], "function")
assert.equal(typeof testing.createTestKeymap, "function")
assert.equal(typeof nativePackage.default, "string")

const htmlEvent = html.createHtmlKeymapEvent({
  key: "Enter",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  preventDefault() {},
  stopPropagation() {},
})
assert.equal(htmlEvent.name, "return")

const setup = testing.createTestKeymap({ defaultKeys: true })
let commandCalls = 0
setup.keymap.registerLayer({
  commands: [
    {
      name: "save-file",
      run() {
        commandCalls += 1
      },
    },
  ],
  bindings: [{ key: "ctrl+s", cmd: "save-file" }],
})

setup.host.press("s", { ctrl: true })
assert.equal(commandCalls, 1)
setup.cleanup()

console.log("Node keymap dist smoke test passed")
`,
  )
}

function installAndTest(nodeDir: string): void {
  runCommand("npm", ["install", "--ignore-scripts", "--no-package-lock"], nodeDir, "Node dist test install failed")
  runCommand(nodePath, ["-e", `import(${JSON.stringify(packageJson.name)})`], nodeDir, "Node import smoke check failed")
  runCommand(nodePath, ["index.mjs"], nodeDir, "Node keymap dist smoke tests failed")
}

let tempRoot: string | undefined

try {
  ensureBuildArtifacts()

  tempRoot = mkdtempSync(join(tmpdir(), "opentui-keymap-dist-test-"))
  const packDir = join(tempRoot, "packs")
  const nodeDir = join(tempRoot, "node")

  mkdirSync(packDir, { recursive: true })
  mkdirSync(nodeDir, { recursive: true })

  const coreTarball = packArtifact(coreDistDir, packDir)
  const nativeTarball = packArtifact(nativePackageDir, packDir)
  const keymapTarball = packArtifact(distDir, packDir)

  writeConsumerPackage(nodeDir, keymapTarball, coreTarball, nativeTarball)
  writeNodeTest(nodeDir)

  installAndTest(nodeDir)

  if (!keepTemp) {
    rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }

  console.log("Packed keymap dist smoke tests passed")
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  if (tempRoot) {
    console.error(`Dist test workspace kept at ${tempRoot}`)
  }
  process.exit(1)
}
