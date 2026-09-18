import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { requireNode26 } from "../../../scripts/node26.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, "..")
const workspaceRoot = resolve(packageRoot, "..", "..")
const outDir = resolve(packageRoot, ".node-test")
const treeSitterStyledTextDataPath = resolve(tmpdir(), "tree-sitter-styled-text-test")
const treeSitterCacheTestDataPath = resolve(tmpdir(), "tree-sitter-cache-test")
const treeSitterDefaultDataPath = resolve(tmpdir(), "tree-sitter-default-node-test")
const treeSitterMarkdownRenderableTestDataPath = resolve(tmpdir(), "tree-sitter-markdown-renderable-test-data")
const treeSitterLineNumberTestDataPath = resolve(tmpdir(), "tree-sitter-line-number-test-data")
const textBufferTestDataPath = resolve(tmpdir(), "text-buffer-node-test")
const runtimeAssetTestDataPath = resolve(tmpdir(), "opentui-runtime-asset-node-test")
const audioRecorderTestDataPath = resolve(tmpdir(), "opentui-audio-recorder-node-test")
const imageTestDataPath = resolve(tmpdir(), "opentui-image-node-test")
const treeSitterClientTestDataPaths = [
  "tree-sitter-shared-test-data",
  "tree-sitter-injections-test-data",
  "tree-sitter-conceal-test-data",
  "tree-sitter-edge-case-test-data",
  "tree-sitter-reactive-data-path-test",
  "tree-sitter-diff-resize-test-data",
].map((name) => resolve(tmpdir(), name))
const treeSitterTestDataPaths = [
  treeSitterStyledTextDataPath,
  treeSitterCacheTestDataPath,
  treeSitterDefaultDataPath,
  treeSitterMarkdownRenderableTestDataPath,
  treeSitterLineNumberTestDataPath,
  textBufferTestDataPath,
  runtimeAssetTestDataPath,
  audioRecorderTestDataPath,
  imageTestDataPath,
  ...treeSitterClientTestDataPaths,
]
const treeSitterAssetsDir = "src/lib/tree-sitter/assets"
const audioFixturesDir = "src/tests/fixtures/audio"
const imageFixturesDir = "src/tests/fixtures/images"
const iccFixturesDir = "../native/src/tests/fixtures"
const stagedNativeFixturesRoot = resolve(outDir, iccFixturesDir)
const stagedNativeRoot = resolve(packageRoot, "native")
let stagedNativeRootOwned = false
const nodeTestTimeoutMs = 30_000
const nodeProcessTimeoutMs = 10 * 60_000
const nodePath = requireNode26()
const { include } = JSON.parse(readFileSync(resolve(packageRoot, "tsconfig.node-test.json"), "utf8")) as {
  include: string[]
}
const emittedAllowlist = include
  .filter((path) => /\.(?:test|node-test)\.tsx?$/.test(path))
  .map((path) => `.node-test/${path.replace(/\.tsx?$/, ".js")}`)
let exitCode = 0

try {
  rmSync(outDir, { recursive: true, force: true })

  exitCode = run(process.execPath, ["x", "tsc", "-p", "tsconfig.node-test.json"])

  // node --test silently ignores nonexistent file arguments, so a missing
  // emitted test (e.g. not listed in tsconfig.node-test.json) would skip
  // coverage without failing. Fail loudly instead.
  if (exitCode === 0) {
    writeFileSync(
      resolve(outDir, "package.json"),
      JSON.stringify({
        type: "module",
        imports: {
          "#opentui/runtime-assets": "./src/platform/runtime-assets.node.js",
        },
      }),
    )
    const missing = emittedAllowlist.filter((path) => !existsSync(resolve(packageRoot, path)))
    if (missing.length > 0) {
      console.error(`Missing emitted node tests (add them to tsconfig.node-test.json?):\n${missing.join("\n")}`)
      exitCode = 1
    }
  }

  if (exitCode === 0) {
    if (existsSync(stagedNativeRoot)) {
      throw new Error(`Refusing to replace existing native fixture staging directory: ${stagedNativeRoot}`)
    }
    cpSync(resolve(packageRoot, treeSitterAssetsDir), resolve(outDir, treeSitterAssetsDir), { recursive: true })
    cpSync(resolve(packageRoot, audioFixturesDir), resolve(outDir, audioFixturesDir), { recursive: true })
    cpSync(resolve(packageRoot, imageFixturesDir), resolve(outDir, imageFixturesDir), { recursive: true })
    stagedNativeRootOwned = true
    cpSync(resolve(packageRoot, iccFixturesDir), stagedNativeFixturesRoot, { recursive: true })
    for (const dataPath of treeSitterTestDataPaths) {
      mkdirSync(dataPath, { recursive: true })
    }

    exitCode = run(
      nodePath,
      [
        "--disable-warning=SecurityWarning",
        "--disable-warning=ExperimentalWarning",
        "--permission",
        `--allow-fs-read=${workspaceRoot}`,
        ...treeSitterTestDataPaths.map((path) => `--allow-fs-read=${path}`),
        ...treeSitterTestDataPaths.map((path) => `--allow-fs-write=${path}`),
        "--allow-net=127.0.0.1",
        "--allow-child-process",
        "--allow-worker",
        "--allow-ffi",
        "--experimental-ffi",
        "--import",
        "./scripts/test-node-hook.mjs",
        "--test-concurrency=1",
        `--test-timeout=${nodeTestTimeoutMs}`,
        "--test",
        ...emittedAllowlist,
      ],
      {
        env: {
          ...process.env,
          OTUI_TEXT_BUFFER_TEST_TMPDIR: textBufferTestDataPath,
          OTUI_RUNTIME_ASSET_TEST_TMPDIR: runtimeAssetTestDataPath,
          OTUI_AUDIO_RECORDER_TEST_TMPDIR: audioRecorderTestDataPath,
          OTUI_IMAGE_TEST_TMPDIR: imageTestDataPath,
          XDG_DATA_HOME: treeSitterDefaultDataPath,
        },
        timeout: nodeProcessTimeoutMs,
      },
    )
  }
} finally {
  rmSync(outDir, { recursive: true, force: true })
  if (stagedNativeRootOwned) rmSync(stagedNativeRoot, { recursive: true, force: true })
}

process.exit(exitCode)

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): number {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
    timeout: options.timeout,
  })

  if (result.error) {
    if (result.error.name === "TimeoutError") {
      console.error(`Command timed out after ${options.timeout}ms: ${command} ${args.join(" ")}`)
    }

    throw result.error
  }

  return result.status ?? 1
}
