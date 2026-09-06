import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { requireNode26 } from "../../../scripts/node26.mjs"

interface PackageJson {
  name: string
  version: string
}

interface NodeAsset {
  readonly key: string
  readonly source: string
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(scriptDir, "..")
const distDir = join(rootDir, "dist")
const args = new Set(process.argv.slice(2))
const keepTemp = args.has("--keep-temp")
const skipBuild = args.has("--skip-build")
const nodePath = requireNode26()
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as PackageJson
const nativePackageName = `${packageJson.name}-${process.platform}-${process.arch}`
const nativePackageDir = join(rootDir, "node_modules", nativePackageName)

function run(
  command: string,
  commandArgs: string[],
  cwd: string,
  errorMessage: string,
  options: { env?: NodeJS.ProcessEnv; pipe?: boolean; timeout?: number } = {},
): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: options.env ?? process.env,
    stdio: options.pipe ? "pipe" : "inherit",
    timeout: options.timeout,
  })
  if (result.error) {
    throw new Error(`${errorMessage}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const output = options.pipe ? `\n${result.stdout.toString()}\n${result.stderr.toString()}` : ""
    throw new Error(`${errorMessage}${output}`)
  }
  return result
}

function packArtifact(packageDir: string, packDir: string): string {
  const result = run("npm", ["pack", "--pack-destination", packDir], packageDir, `Failed to pack ${packageDir}`, {
    pipe: true,
  })
  const name = result.stdout.toString("utf8").trim().split(/\r?\n/).at(-1)
  if (!name) throw new Error(`Failed to determine tarball name for ${packageDir}`)
  return join(packDir, name)
}

function writeConsumerPackage(consumerDir: string, coreTarball: string, nativeTarball: string): void {
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "opentui-core-sea-test",
        private: true,
        type: "module",
        dependencies: {
          [packageJson.name]: `file:${relative(consumerDir, coreTarball).replaceAll("\\", "/")}`,
          [nativePackageName]: `file:${relative(consumerDir, nativeTarball).replaceAll("\\", "/")}`,
        },
      },
      null,
      2,
    ),
  )
}

function collectManifest(consumerDir: string): NodeAsset[] {
  const manifestPath = join(consumerDir, "manifest.json")
  writeFileSync(
    join(consumerDir, "manifest.mjs"),
    `import { writeFileSync } from "node:fs"
import { getNodeAssets } from ${JSON.stringify(`${packageJson.name}/node-assets`)}

const assets = getNodeAssets({
  platform: process.platform,
  arch: process.arch,
  ...(process.platform === "linux" ? { libc: "glibc" } : {}),
})
writeFileSync(${JSON.stringify(manifestPath)}, JSON.stringify(assets))
`,
  )
  run(nodePath, ["manifest.mjs"], consumerDir, "Failed to collect OpenTUI Node assets")
  return JSON.parse(readFileSync(manifestPath, "utf8")) as NodeAsset[]
}

const rendererFixture = `
const scene = await createTestRenderer({ width: 8, height: 3, useMouse: true, remote: true, forwardEnvKeys: [] })
try {
  assert.ok(scene.renderer.nativeScene)
  const box = new BoxRenderable(scene.renderer, { width: 8, height: 3, border: true })
  const text = new TextRenderable(scene.renderer, { content: "native", width: 6, height: 1 })
  box.add(text)
  scene.renderer.root.add(box)
  await scene.renderOnce()
  assert.ok(scene.captureCharFrame().includes("native"))
  assert.deepEqual([text.x, text.y, text.width, text.height], [1, 1, 6, 1])
  assert.equal(scene.renderer.hitTest(1, 1), text.num)
  const frames = scene.renderer.getNativeStats().nativeFrameCount
  text.content = "update"
  await scene.renderOnce()
  assert.ok(scene.captureCharFrame().includes("update"))
  assert.equal(scene.renderer.getNativeStats().nativeFrameCount, frames + 1)
} finally {
  scene.renderer.destroy()
  await scene.renderer.closed
}

const owner = new ResourceContext({ objectCapacity: 16, renderCellsMax: 64 })
try {
  const buffer = OptimizedBuffer.create(4, 2, "unicode", { owner })
  assert.equal(buffer.width, 4)
  buffer.destroy()
} finally {
  owner.destroy()
}
`

function writeApplication(consumerDir: string): void {
  writeFileSync(
    join(consumerDir, "app.mjs"),
    `import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { isSea } from "node:sea"
import { BoxRenderable, OptimizedBuffer, ResourceContext, TextRenderable, TreeSitterClient } from ${JSON.stringify(packageJson.name)}
import { createTestRenderer } from ${JSON.stringify(`${packageJson.name}/testing`)}

assert.equal(isSea(), true)
assert.ok(process.env.OTUI_ASSET_ROOT)
assert.equal(isAbsolute(process.env.OTUI_ASSET_ROOT), true)
${rendererFixture}

const dataPath = mkdtempSync(join(tmpdir(), "opentui-sea-tree-sitter-"))
const client = new TreeSitterClient({ dataPath })
try {
  const result = await client.highlightOnce(${JSON.stringify("# SEA\n\n```js\nconst answer = 42\n```\n")}, "markdown")
  assert.equal(result.error, undefined)
  assert.ok(result.highlights?.length)
} finally {
  await client.destroy()
  rmSync(dataPath, { recursive: true, force: true })
}

console.log("OpenTUI Node SEA acceptance passed")
`,
  )
}

function writeBunApplication(consumerDir: string): void {
  writeFileSync(
    join(consumerDir, "bun-app.ts"),
    `import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from ${JSON.stringify(`${packageJson.name}/testing`)}
import * as Yoga from ${JSON.stringify(`${packageJson.name}/yoga`)}

import { BoxRenderable, OptimizedBuffer, ResourceContext, TextRenderable, TreeSitterClient, Yoga as CoreYoga } from ${JSON.stringify(packageJson.name)}

assert.equal(typeof createTestRenderer, "function")
assert.equal(CoreYoga.Node, Yoga.Node)
const yogaNode = Yoga.Node.create()
yogaNode.free()
${rendererFixture}

const dataPath = mkdtempSync(join(tmpdir(), "opentui-bun-tree-sitter-"))
const client = new TreeSitterClient({ dataPath })
try {
  const result = await client.highlightOnce(${JSON.stringify("# Bun\n\n```js\nconst answer = 42\n```\n")}, "markdown")
  assert.equal(result.error, undefined)
  assert.ok(result.highlights?.length)
} finally {
  await client.destroy()
  rmSync(dataPath, { recursive: true, force: true })
}

console.log("OpenTUI Bun executable acceptance passed")
`,
  )
}

function assetHash(assets: readonly NodeAsset[]): string {
  const hash = createHash("sha256")
  for (const asset of assets) {
    hash.update(asset.key)
    hash.update(readFileSync(asset.source))
  }
  return hash.digest("hex").slice(0, 16)
}

function seaPrelude(hash: string): string {
  return `import { existsSync as __otuiExists, mkdirSync as __otuiMkdir, writeFileSync as __otuiWrite } from "node:fs"
import { tmpdir as __otuiTmpdir } from "node:os"
import { isAbsolute as __otuiIsAbsolute, join as __otuiJoin, dirname as __otuiDirname } from "node:path"
import { getAssetKeys as __otuiAssetKeys, getRawAsset as __otuiRawAsset, isSea as __otuiIsSea } from "node:sea"
if (!__otuiIsSea()) throw new Error("Expected a Node SEA executable")
const __otuiRoot = __otuiJoin(__otuiTmpdir(), ${JSON.stringify(`opentui-core-sea-${hash}`)})
for (const __otuiKey of __otuiAssetKeys()) {
  if (__otuiIsAbsolute(__otuiKey) || __otuiKey.includes("\\\\") || __otuiKey.split("/").includes("..")) {
    throw new Error(\`Invalid SEA asset key: \${__otuiKey}\`)
  }
  const __otuiTarget = __otuiJoin(__otuiRoot, __otuiKey)
  if (__otuiExists(__otuiTarget)) continue
  __otuiMkdir(__otuiDirname(__otuiTarget), { recursive: true })
  __otuiWrite(__otuiTarget, new Uint8Array(__otuiRawAsset(__otuiKey)))
}
process.env.OTUI_ASSET_ROOT = __otuiRoot
`
}

let temporaryRoot: string | undefined

try {
  if (!skipBuild) {
    run("bun", ["run", "build"], rootDir, "Standalone test build failed", { timeout: 20 * 60_000 })
  }
  if (!existsSync(distDir) || !existsSync(nativePackageDir)) {
    throw new Error("Missing core or native build artifacts")
  }

  temporaryRoot = mkdtempSync(join(tmpdir(), "opentui-core-standalone-test-"))
  const buildDir = join(temporaryRoot, "build")
  const consumerDir = join(buildDir, "consumer")
  const packDir = join(buildDir, "packs")
  const deployDir = join(temporaryRoot, "deploy")
  const workDir = join(deployDir, "work")
  const dataDir = join(deployDir, "data")
  mkdirSync(consumerDir, { recursive: true })
  mkdirSync(packDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  const coreTarball = packArtifact(distDir, packDir)
  const nativeTarball = packArtifact(nativePackageDir, packDir)
  writeConsumerPackage(consumerDir, coreTarball, nativeTarball)
  run("npm", ["install", "--ignore-scripts", "--no-package-lock"], consumerDir, "SEA test install failed")
  const assets = collectManifest(consumerDir)
  writeApplication(consumerDir)
  writeBunApplication(consumerDir)
  const builtBunExecutable = join(buildDir, process.platform === "win32" ? "opentui-bun.exe" : "opentui-bun")
  const bunCompileArgs = ["build", "--compile", `--outfile=${builtBunExecutable}`, join(consumerDir, "bun-app.ts")]
  if (process.platform === "linux") {
    bunCompileArgs.push(`--define=process.env.OPENTUI_LIBC=${JSON.stringify("glibc")}`)
  }
  run("bun", bunCompileArgs, consumerDir, "Bun executable build failed", { timeout: 10 * 60_000 })
  const bundlePath = join(consumerDir, "bundle.mjs")
  run(
    "bun",
    ["build", "--target=node", `--outfile=${bundlePath}`, join(consumerDir, "app.mjs")],
    consumerDir,
    "SEA application bundle failed",
  )
  const bundle = readFileSync(bundlePath, "utf8")
  if (/with:\s*\{\s*type:\s*["'](?:file|wasm)["']/.test(bundle)) {
    throw new Error("SEA application bundle contains a Bun file import attribute")
  }
  if (/import\(["']@opentui\/core-(?:darwin|linux|win32)-/.test(bundle)) {
    throw new Error("SEA application bundle contains a static OpenTUI native package import")
  }

  const hash = assetHash(assets)
  const extractionRoot = join(dataDir, `opentui-core-sea-${hash}`)
  rmSync(extractionRoot, { recursive: true, force: true })
  const seaMain = join(consumerDir, "sea-main.mjs")
  writeFileSync(seaMain, seaPrelude(hash) + bundle)
  const builtExecutable = join(buildDir, process.platform === "win32" ? "opentui-sea.exe" : "opentui-sea")
  writeFileSync(
    join(consumerDir, "sea-config.json"),
    JSON.stringify(
      {
        main: seaMain,
        mainFormat: "module",
        executable: nodePath,
        output: builtExecutable,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        execArgv: ["--experimental-ffi", "--no-warnings"],
        execArgvExtension: "none",
        assets: Object.fromEntries(assets.map((asset) => [asset.key, asset.source])),
      },
      null,
      2,
    ),
  )
  run(nodePath, ["--build-sea", "sea-config.json"], consumerDir, "Node SEA build failed", { timeout: 10 * 60_000 })

  const deployedExecutable = join(deployDir, process.platform === "win32" ? "opentui-sea.exe" : "opentui-sea")
  const deployedBunExecutable = join(deployDir, process.platform === "win32" ? "opentui-bun.exe" : "opentui-bun")
  copyFileSync(builtExecutable, deployedExecutable)
  copyFileSync(builtBunExecutable, deployedBunExecutable)
  if (process.platform !== "win32") chmodSync(deployedExecutable, 0o755)
  if (process.platform !== "win32") chmodSync(deployedBunExecutable, 0o755)
  rmSync(buildDir, { recursive: true, force: true })

  const runtimeEnv = {
    ...process.env,
    HOME: dataDir,
    XDG_DATA_HOME: dataDir,
    TMPDIR: dataDir,
    TEMP: dataDir,
    TMP: dataDir,
  }
  delete runtimeEnv.OTUI_ASSET_ROOT
  delete runtimeEnv.OTUI_TREE_SITTER_WORKER_PATH
  for (let runIndex = 0; runIndex < 2; runIndex++) {
    const result = run(deployedExecutable, [], workDir, `Node SEA run ${runIndex + 1} failed`, {
      env: runtimeEnv,
      pipe: true,
      timeout: 60_000,
    })
    if (!result.stdout.toString("utf8").includes("OpenTUI Node SEA acceptance passed")) {
      throw new Error(`Node SEA run ${runIndex + 1} did not print the success marker`)
    }
  }

  const bunResult = run(deployedBunExecutable, [], workDir, "Bun executable run failed", {
    env: runtimeEnv,
    pipe: true,
    timeout: 60_000,
  })
  if (!bunResult.stdout.toString("utf8").includes("OpenTUI Bun executable acceptance passed")) {
    throw new Error("Bun executable did not print the success marker")
  }

  if (!keepTemp) {
    rmSync(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
  console.log("Standalone executable tests passed")
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  if (temporaryRoot) console.error(`Standalone test workspace kept at ${temporaryRoot}`)
  process.exit(1)
}
