import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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
const distDir = join(rootDir, "dist")
const args = new Set(process.argv.slice(2))
const keepTemp = args.has("--keep-temp")
const skipBuild = args.has("--skip-build")
const nodePath = requireNode26()

const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as PackageJson
const nativePackageName = `${packageJson.name}-${process.platform}-${process.arch}`
const nativePackageDir = join(rootDir, "node_modules", nativePackageName)

const nativeSceneSmoke = `
const scene = await testing.createTestRenderer({
  width: 16, height: 6, useMouse: true,
  screenMode: "main-screen", externalOutputMode: "passthrough", consoleMode: "disabled",
})
try {
  const failures = []
  scene.renderer.on(core.CliRenderEvents.RENDER_ERROR, (event) => failures.push(event.error))
  const box = new core.BoxRenderable(scene.renderer, {
    width: 10, height: 3, border: true,
    renderAfter(buffer) {
      buffer.drawText("!", this.x + this.width - 2, this.y + 1, core.RGBA.fromHex("#ffffff"))
    },
  })
  scene.renderer.root.add(box)
  const text = new core.TextRenderable(scene.renderer, {
    selectable: false, content: "text", alignSelf: "flex-start",
  })
  box.add(text)
  let measureWidth = 6
  text.setMeasureProvider(() => {
    if (text.plainText.length === 0 || text.parent !== box) {
      throw new Error("Packed native measurement lost read-only reentry")
    }
    return { width: measureWidth, height: 1 }
  })
  const editor = new core.TextareaRenderable(scene.renderer, { width: 8, height: 2, initialValue: "edit" })
  scene.renderer.root.add(editor)
  await scene.renderOnce()
  if (text.width !== 6 || text.x !== 1 || text.y !== 1 || editor.y !== 3 ||
      scene.renderer.hitTest(0, 0) !== box.num || scene.renderer.hitTest(text.x, text.y) !== text.num ||
      !scene.captureCharFrame().includes("text") || !scene.captureCharFrame().includes("edit")) {
    throw new Error("Packed native scene lost rendering, layout, measurement, or hit testing")
  }
  scene.renderer.currentRenderBuffer.withBuffers(({ char }) => {
    if (char[0] !== 0x250c || char[scene.renderer.width + 8] !== 33) {
      throw new Error("Packed native scene lost built-in or custom paint")
    }
  })

  box.width = 12
  measureWidth = 5
  text.invalidateIntrinsicSize()
  text.content = "next"
  editor.gotoBufferEnd()
  editor.insertText("!")
  await scene.renderOnce()
  if (box.width !== 12 || text.width !== 5 || editor.plainText !== "edit!" ||
      !scene.captureCharFrame().includes("next") || !scene.captureCharFrame().includes("edit!")) {
    throw new Error("Packed native scene lost layout, text, or editor mutation")
  }

  const failure = new Error("packed measurement failure")
  const frames = scene.renderer.getNativeStats().nativeFrameCount
  text.setMeasureProvider(() => { throw failure })
  await scene.renderOnce()
  if (failures.length !== 1 || failures[0] !== failure || scene.renderer.getNativeStats().nativeFrameCount !== frames) {
    throw new Error("Packed native measurement failure escaped containment")
  }
  text.setMeasureProvider(() => ({ width: 4, height: 1 }))
  await scene.renderOnce()
  if (text.width !== 4 || failures.length !== 1 || !scene.captureCharFrame().includes("next") ||
      scene.renderer.getNativeStats().nativeFrameCount !== frames + 1) {
    throw new Error("Packed native measurement failed to recover")
  }
} finally {
  scene.renderer.destroy()
  await scene.renderer.closed
}
`

const declarationPaths = ["index.d.ts", "node-assets.d.ts", "testing.d.ts", "lib/tree-sitter/parser.worker.d.ts"]

function runCommand(
  command: string,
  commandArgs: string[],
  cwd: string,
  errorMessage: string,
  options: { stdio?: "inherit" | "pipe"; timeout?: number } = {},
): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: options.stdio ?? "inherit",
    timeout: options.timeout,
  })

  if (result.error) {
    throw new Error(`${errorMessage}: ${result.error.message}`)
  }

  if (result.status !== 0) {
    throw new Error(errorMessage)
  }

  return result
}

function runCommandExpectFailure(
  command: string,
  commandArgs: string[],
  cwd: string,
  errorMessage: string,
): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "pipe",
  })

  if (result.error) {
    throw new Error(`${errorMessage}: ${result.error.message}`)
  }

  if (result.status === 0) {
    throw new Error(errorMessage)
  }

  return result
}

function ensureBuildArtifacts(): void {
  if (!skipBuild) {
    runCommand("bun", ["run", "build"], rootDir, "Dist test build failed")
  }

  if (!existsSync(distDir)) {
    throw new Error(`Missing dist directory at ${distDir}. Run bun run build first.`)
  }

  if (!existsSync(nativePackageDir)) {
    throw new Error(`Missing native package directory at ${nativePackageDir}. Run bun run build first.`)
  }
  if (!existsSync(join(nativePackageDir, "LICENSE-GHOSTTY"))) {
    throw new Error("Native package is missing the Ghostty and Unicode license notices")
  }
  const leakedGhosttyFiles = readdirSync(nativePackageDir).filter(
    (name) => name.includes("ghostty-vt") || name.endsWith(".a") || name.endsWith(".lib"),
  )
  if (leakedGhosttyFiles.length > 0) {
    throw new Error(`Native package contains unbundled Ghostty artifacts: ${leakedGhosttyFiles.join(", ")}`)
  }
  const leakedSymbols = readdirSync(nativePackageDir).filter((name) => /\.(debug|pdb|dSYM)$/.test(name))
  if (leakedSymbols.length)
    throw new Error(`Native package contains separate debug symbols: ${leakedSymbols.join(", ")}`)

  if (process.platform === "linux") {
    const nativeLibrary = join(nativePackageDir, "libopentui.so")
    const elf = runCommand(
      "readelf",
      ["--wide", "--section-headers", "--dyn-syms", nativeLibrary],
      rootDir,
      "Failed to inspect packaged native ELF",
      { stdio: "pipe" },
    ).stdout.toString("utf8")

    if (/\s\.(?:z)?debug(?:_|\s)|\s\.symtab\s/.test(elf)) {
      throw new Error("Packaged production native library is not stripped")
    }
    if (!/\bgetBuildOptions\b/.test(elf)) {
      throw new Error("Packaged production native library lost its dynamic FFI exports")
    }
    if (!elf.includes(".note.gnu.build-id") || !elf.includes(".gnu_debuglink")) {
      throw new Error("Packaged native ELF cannot be matched to its separate release symbols")
    }
  }
}

function assertPortableDeclarations(): void {
  for (const declarationPath of declarationPaths) {
    const fullPath = join(distDir, declarationPath)
    const contents = readFileSync(fullPath, "utf8")
    if (contents.includes("bun:ffi")) {
      throw new Error(`Portable declaration ${declarationPath} still references bun:ffi`)
    }
  }
}

function assertRuntimeOutputs(): void {
  const nodeSource = readRuntimeGraph(["index.node.js", "testing.js", "yoga.js"], "chunk-node-")
  const bunSource = readRuntimeGraph(["index.bun.js", "testing.bun.js", "yoga.bun.js"], "chunk-bun-")
  const workerSource = readFileSync(join(distDir, "parser.worker.js"), "utf8")
  const distPackage = JSON.parse(readFileSync(join(distDir, "package.json"), "utf8")) as {
    exports: Record<string, Record<string, string>>
  }

  for (const [name, source] of [
    ["Node root", nodeSource],
    ["Node parser worker", workerSource],
  ] as const) {
    if (/with:\s*\{\s*type:\s*["'](?:file|wasm)["']/.test(source)) {
      throw new Error(`${name} contains a Bun file import attribute`)
    }
  }
  if (/import\(["']@opentui\/core-(?:darwin|linux|win32)-/.test(nodeSource)) {
    throw new Error("Node root contains a statically resolved OpenTUI native package import")
  }
  if (!/with:\s*\{\s*type:\s*["']file["']/.test(bunSource)) {
    throw new Error("Bun root does not retain literal file imports")
  }
  if (/\b(?:from|import\()\s*["']web-tree-sitter["']/.test(workerSource)) {
    throw new Error("Node parser worker still imports web-tree-sitter at runtime")
  }
  if (!workerSource.includes('"web-tree-sitter/tree-sitter.wasm"')) {
    throw new Error("Node parser worker does not reference the stable tree-sitter WASM key")
  }

  const rootExport = distPackage.exports["."]
  if (
    rootExport?.bun !== "./index.bun.js" ||
    rootExport?.node !== "./index.node.js" ||
    rootExport?.import !== "./index.node.js"
  ) {
    throw new Error("Root package export does not select separate Bun and Node runtime outputs")
  }
  if (distPackage.exports["./node-assets"]?.import !== "./node-assets.js") {
    throw new Error("Missing @opentui/core/node-assets package export")
  }
  const workerExport = distPackage.exports["./parser.worker"]
  if (
    workerExport?.bun !== "./parser.worker.js" ||
    workerExport?.node !== "./parser.worker.js" ||
    workerExport?.import !== "./parser.worker.js"
  ) {
    throw new Error("Parser worker package export does not select the shared worker output")
  }

  for (const sourceMap of ["index.node.js.map", "index.bun.js.map", "parser.worker.js.map"]) {
    if (!existsSync(join(distDir, sourceMap))) {
      throw new Error(`Missing source map ${sourceMap}`)
    }
  }
  const workerSourceMap = JSON.parse(readFileSync(join(distDir, "parser.worker.js.map"), "utf8")) as {
    sources?: string[]
  }
  const workerSourcePath = workerSourceMap.sources?.find((source) => source.endsWith("/parser.worker.ts"))
  if (!workerSourcePath || !existsSync(resolve(distDir, workerSourcePath))) {
    throw new Error("Parser worker source map does not resolve to parser.worker.ts")
  }
  if (existsSync(join(distDir, "parser.worker.bun.js"))) {
    throw new Error("Found obsolete Bun-specific parser worker")
  }
}

function readRuntimeGraph(entryPaths: string[], chunkPrefix: string): string {
  const chunkPaths = readdirSync(distDir)
    .filter((name) => name.startsWith(chunkPrefix) && name.endsWith(".js"))
    .sort()
  return [...entryPaths, ...chunkPaths].map((path) => readFileSync(join(distDir, path), "utf8")).join("\n")
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

function writeConsumerPackage(consumerDir: string, coreTarball: string, nativeTarball: string, name: string): void {
  const coreDependency = `file:${relative(consumerDir, coreTarball).replaceAll("\\", "/")}`
  const nativeDependency = `file:${relative(consumerDir, nativeTarball).replaceAll("\\", "/")}`

  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        dependencies: {
          [packageJson.name]: coreDependency,
          [nativePackageName]: nativeDependency,
        },
        overrides: {
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
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const nativePackageName = ${JSON.stringify(nativePackageName)}

const core = await import(${JSON.stringify(packageJson.name)})
const nodeAssets = await import(${JSON.stringify(`${packageJson.name}/node-assets`)})
const testing = await import(${JSON.stringify(`${packageJson.name}/testing`)})
const yoga = await import(${JSON.stringify(`${packageJson.name}/yoga`)})
const parserWorker = await import(${JSON.stringify(`${packageJson.name}/parser.worker`)})
const nativePackage = await import(nativePackageName)

assert.equal(typeof core.createCliRenderer, "function")
assert.equal(typeof core.Audio, "function")
assert.equal(typeof core.AudioCaptureStream, "function")
assert.equal(typeof core.AudioCaptureStreamError, "function")
assert.equal(typeof core.AudioRecorder, "function")
assert.equal(typeof core.AudioRecorderError, "function")
assert.equal(typeof core.AudioStreamError, "function")
assert.equal(typeof core.NativeImage, "function")
assert.equal(typeof core.NativeImagePool, "function")
assert.equal(typeof core.ImageRenderable, "function")
assert.equal(typeof core.Audio.prototype.openCapture, "function")
assert.equal(typeof core.Audio.prototype.recordToFile, "function")
assert.equal(typeof core.createIcyStreamDemuxer, "function")
assert.equal(core.NativeAudioStreamCloseReason.TransportError, 1)
assert.equal(core.NativeAudioStreamFormat.Mp3, 1)
assert.equal(core.NativeAudioStreamFormat.Flac, 2)
assert.equal(typeof testing.createTestRenderer, "function")
assert.equal(core.Yoga.Node, yoga.Node)
assert.equal(Object.getPrototypeOf(testing.MockTreeSitterClient.prototype), core.TreeSitterClient.prototype)
assert.equal(typeof parserWorker, "object")
assert.equal(typeof nativePackage.default, "string")

const manifest = nodeAssets.getNodeAssets({
  platform: process.platform,
  arch: process.arch,
  ...(process.platform === "linux" ? { libc: "glibc" } : {}),
})
assert.equal(manifest.length, 14)
assert.deepEqual(
  manifest.map((asset) => asset.key),
  manifest.map((asset) => asset.key).toSorted(),
)

const owner = new core.ResourceContext({ objectCapacity: 16, renderCellsMax: 64 })
try {
  const buffer = core.OptimizedBuffer.create(2, 1, "unicode", { owner })
  assert.equal(buffer.width, 2)
  buffer.destroy()
} finally {
  owner.destroy()
}

${nativeSceneSmoke}

const image = core.NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
const raw = image.takeRaw()
try {
  assert.deepEqual([...raw.data], [1, 2, 3, 255])
  assert.throws(() => image.info(), /disposed/)
} finally {
  raw.dispose()
}

const imported = core.NativeImage.fromPixels(Uint8Array.of(99, 3, 2, 1, 0).subarray(1), 1, 1, {
  format: "bgra8", alpha: "opaque", stride: 256,
})
try {
  assert.deepEqual([...imported.raw().data], [1, 2, 3, 255])
  assert.equal(imported.info().hasAlpha, false)
} finally {
  imported.dispose()
}

const pool = new core.NativeImagePool({ width: 1, height: 1, capacity: 1 })
try {
  for (const red of [255, 128]) {
    const frame = pool.publishRgba(Uint8Array.of(red, 0, 0, 255))
    try {
      assert.deepEqual([...frame.raw().data], [red, 0, 0, 255])
    } finally {
      frame.dispose()
    }
  }
  const frame = pool.publishPixels(Uint8Array.of(3, 2, 1, 0), { format: "bgra8", alpha: "opaque", stride: 256 })
  try {
    assert.deepEqual([...frame.raw().data], [1, 2, 3, 255])
    assert.equal(frame.info().hasAlpha, false)
  } finally {
    frame.dispose()
  }
} finally {
  pool.dispose()
}

const dataPath = mkdtempSync(join(tmpdir(), "opentui-node-dist-tree-sitter-"))
const client = new core.TreeSitterClient({ dataPath })
try {
  const result = await client.highlightOnce(${JSON.stringify("# Title\n\n```js\nconst answer = 42\n```\n")}, "markdown")
  assert.equal(result.error, undefined)
  assert.ok(result.highlights?.length)
} finally {
  await client.destroy()
  rmSync(dataPath, { recursive: true, force: true })
}

const expectBunOnlyFailure = async (specifier, expectedMessage) => {
  await assert.rejects(import(specifier), (error) => {
    return error instanceof Error && error.message.includes(expectedMessage)
  })
}

await expectBunOnlyFailure(${JSON.stringify(`${packageJson.name}/runtime-plugin`)}, ${JSON.stringify(`${packageJson.name}/runtime-plugin is Bun-only`)})
await expectBunOnlyFailure(
  ${JSON.stringify(`${packageJson.name}/runtime-plugin-support`)},
  ${JSON.stringify(`${packageJson.name}/runtime-plugin-support is Bun-only`)},
)
await expectBunOnlyFailure(
  ${JSON.stringify(`${packageJson.name}/runtime-plugin-support/configure`)},
  ${JSON.stringify(`${packageJson.name}/runtime-plugin-support/configure is Bun-only`)},
)

console.log("Node dist smoke test passed")
`,
  )

  writeFileSync(
    join(nodeDir, "require.cjs"),
    `const assert = require("node:assert/strict")

assert.throws(
  () => require(${JSON.stringify(packageJson.name)}),
  (error) => error?.code === "ERR_REQUIRE_ASYNC_MODULE",
  ${JSON.stringify(`Expected ${packageJson.name} CommonJS require to reject its async ESM graph`)},
)

for (const specifier of [${JSON.stringify(`${packageJson.name}/testing`)}, ${JSON.stringify(`${packageJson.name}/tree-sitter/update-assets`)}]) {
  assert.throws(
    () => require(specifier),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
    \`Expected \${specifier} to remain import-only in Node\`,
  )
}

const workerPath = require.resolve(${JSON.stringify(`${packageJson.name}/parser.worker`)})
assert.match(workerPath, /parser\\.worker\\.js$/)

console.log("Node CommonJS export smoke test passed")
`,
  )
}

function writeBunTest(bunDir: string): void {
  writeFileSync(
    join(bunDir, "index.test.ts"),
    `import { describe, expect, test } from "bun:test"

describe("${packageJson.name} dist smoke test", () => {
  test("imports portable and Bun-only entrypoints", async () => {
    const core = await import(${JSON.stringify(packageJson.name)})
    const testing = await import(${JSON.stringify(`${packageJson.name}/testing`)})
    const yoga = await import(${JSON.stringify(`${packageJson.name}/yoga`)})
    const parserWorker = await import(${JSON.stringify(`${packageJson.name}/parser.worker`)})
    const runtimePlugin = await import(${JSON.stringify(`${packageJson.name}/runtime-plugin`)})
    const nativePackage = await import(${JSON.stringify(nativePackageName)})

    expect(typeof core.createCliRenderer).toBe("function")
    expect(typeof core.Audio).toBe("function")
    expect(typeof core.AudioCaptureStream).toBe("function")
    expect(typeof core.AudioCaptureStreamError).toBe("function")
    expect(typeof core.AudioRecorder).toBe("function")
    expect(typeof core.AudioRecorderError).toBe("function")
    expect(typeof core.AudioStreamError).toBe("function")
    expect(typeof core.NativeImage).toBe("function")
    expect(typeof core.NativeImagePool).toBe("function")
    expect(typeof core.ImageRenderable).toBe("function")
    expect(typeof core.Audio.prototype.openCapture).toBe("function")
    expect(typeof core.Audio.prototype.recordToFile).toBe("function")
    expect(core.NativeAudioStreamCloseReason.TransportError).toBe(1)
    expect(core.NativeAudioStreamFormat.Flac).toBe(2)
    expect(typeof testing.createTestRenderer).toBe("function")
    expect(core.Yoga.Node).toBe(yoga.Node)
    expect(Object.getPrototypeOf(testing.MockTreeSitterClient.prototype)).toBe(core.TreeSitterClient.prototype)
    expect(typeof parserWorker).toBe("object")
    expect(typeof runtimePlugin.createRuntimePlugin).toBe("function")
    expect(typeof nativePackage.default).toBe("string")
    const image = core.NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
    const raw = image.takeRaw()
    try {
      expect([...raw.data]).toEqual([1, 2, 3, 255])
      expect(() => image.info()).toThrow(/disposed/)
    } finally {
      raw.dispose()
    }
    const imported = core.NativeImage.fromPixels(Uint8Array.of(99, 3, 2, 1, 0).subarray(1), 1, 1, {
      format: "bgra8", alpha: "opaque", stride: 256,
    })
    try {
      expect([...imported.raw().data]).toEqual([1, 2, 3, 255])
      expect(imported.info().hasAlpha).toBe(false)
    } finally {
      imported.dispose()
    }
    ${nativeSceneSmoke}
  })
})
`,
  )
}

function assertNodeStaticImportFailure(
  nodeDir: string,
  importedName: string,
  specifier: string,
  expectedMessage: string,
): void {
  const result = runCommandExpectFailure(
    nodePath,
    ["--input-type=module", "-e", `import { ${importedName} } from ${JSON.stringify(specifier)}`],
    nodeDir,
    `Expected static Node import of ${specifier} to fail`,
  )

  const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`

  if (output.includes("does not provide an export named")) {
    throw new Error(`Static Node import of ${specifier} failed before the Bun-only stub could run`)
  }

  if (!output.includes(expectedMessage)) {
    throw new Error(`Static Node import of ${specifier} did not report the expected Bun-only error`)
  }
}

function installAndTest(nodeDir: string, bunDir: string): void {
  runCommand(
    "npm",
    ["install", "--engine-strict", "--ignore-scripts", "--no-package-lock"],
    nodeDir,
    "Node dist test install failed",
  )
  runCommand(nodePath, ["-e", `import(${JSON.stringify(packageJson.name)})`], nodeDir, "Node import smoke check failed")
  runCommand(nodePath, ["--experimental-ffi", "--no-warnings", "index.mjs"], nodeDir, "Node dist smoke tests failed", {
    timeout: 60_000,
  })
  runCommand(nodePath, ["require.cjs"], nodeDir, "Node CommonJS export smoke tests failed")

  assertNodeStaticImportFailure(
    nodeDir,
    "createRuntimePlugin",
    `${packageJson.name}/runtime-plugin`,
    `${packageJson.name}/runtime-plugin is Bun-only`,
  )
  assertNodeStaticImportFailure(
    nodeDir,
    "ensureRuntimePluginSupport",
    `${packageJson.name}/runtime-plugin-support`,
    `${packageJson.name}/runtime-plugin-support is Bun-only`,
  )
  assertNodeStaticImportFailure(
    nodeDir,
    "ensureRuntimePluginSupport",
    `${packageJson.name}/runtime-plugin-support/configure`,
    `${packageJson.name}/runtime-plugin-support/configure is Bun-only`,
  )

  runCommand("bun", ["install", "--ignore-scripts"], bunDir, "Bun dist test install failed")
  runCommand("bun", ["test", "index.test.ts"], bunDir, "Bun dist smoke tests failed")
}

let tempRoot: string | undefined

try {
  ensureBuildArtifacts()
  assertPortableDeclarations()
  assertRuntimeOutputs()

  tempRoot = mkdtempSync(join(tmpdir(), "opentui-core-dist-test-"))
  const packDir = join(tempRoot, "packs")
  const nodeDir = join(tempRoot, "node")
  const bunDir = join(tempRoot, "bun")

  mkdirSync(packDir, { recursive: true })
  mkdirSync(nodeDir, { recursive: true })
  mkdirSync(bunDir, { recursive: true })

  const coreTarball = packArtifact(distDir, packDir)
  const nativeTarball = packArtifact(nativePackageDir, packDir)

  writeConsumerPackage(nodeDir, coreTarball, nativeTarball, "opentui-core-dist-test-node")
  writeConsumerPackage(bunDir, coreTarball, nativeTarball, "opentui-core-dist-test-bun")
  writeNodeTest(nodeDir)
  writeBunTest(bunDir)

  installAndTest(nodeDir, bunDir)

  if (!keepTemp) {
    rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }

  console.log("Packed dist smoke tests passed")
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  if (tempRoot) {
    console.error(`Dist test workspace kept at ${tempRoot}`)
  }
  process.exit(1)
}
