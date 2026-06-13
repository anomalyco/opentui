import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { requireNode26 } from "../../../scripts/node26.mjs"
import { createSolidTransformPlugin } from "./solid-plugin.js"
import { resolveNodeSolidRuntimeImport } from "./solid-transform.js"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, "..")
const workspaceRoot = resolve(packageRoot, "..", "..")
const corePackageRoot = resolve(packageRoot, "..", "core")
const coreDistRoot = resolve(corePackageRoot, "dist")
const outDir = resolve(packageRoot, ".node-test")
const nodeTestTimeoutMs = 30_000
const nodeProcessTimeoutMs = 5 * 60_000
const nodePath = requireNode26()
const emittedAllowlist = [".node-test/tests/box.test.js", ".node-test/tests/control-flow-updates.test.js"]
const testEntries = [
  { source: "tests/box.test.tsx", output: "tests/box.test.js" },
  { source: "tests/control-flow-updates.test.tsx", output: "tests/control-flow-updates.test.js" },
  { source: "src/testing/bun-test-node.ts", output: "src/testing/bun-test-node.js" },
]

let exitCode = 0

try {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  ensureCoreBuildArtifacts()
  writeCoreDistProxyPackage()

  for (const entry of testEntries) {
    await buildEntryPoint(entry.source, entry.output)
  }

  exitCode = run(
    nodePath,
    [
      "--disable-warning=SecurityWarning",
      "--disable-warning=ExperimentalWarning",
      "--permission",
      `--allow-fs-read=${workspaceRoot}`,
      `--allow-fs-write=${outDir}`,
      "--allow-child-process",
      "--allow-ffi",
      "--experimental-ffi",
      "--import",
      "./scripts/test-node-hook.mjs",
      "--test-concurrency=1",
      `--test-timeout=${nodeTestTimeoutMs}`,
      "--test",
      ...emittedAllowlist,
    ],
    { cwd: packageRoot, timeout: nodeProcessTimeoutMs },
  )
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

process.exit(exitCode)

async function buildEntryPoint(source: string, output: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(packageRoot, source)],
    outfile: join(outDir, output),
    target: "node",
    format: "esm",
    sourcemap: "external",
    external: [
      "bun:test",
      "@opentui/core",
      "@opentui/core/testing",
      "solid-js/dist/solid.js",
      "solid-js/store/dist/store.js",
    ],
    plugins: [
      createSolidTransformPlugin({
        resolvePath(specifier) {
          return resolveNodeSolidRuntimeImport(specifier)
        },
      }),
    ],
  })

  if (!result.success) {
    console.error(`Failed to build ${source}`)
    for (const log of result.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  const outputPath = join(outDir, output)
  for (const buildOutput of result.outputs) {
    if (buildOutput.kind === "entry-point") {
      await Bun.write(outputPath, buildOutput)
      continue
    }

    if (buildOutput.kind === "sourcemap") {
      await Bun.write(`${outputPath}.map`, buildOutput)
    }
  }
}

function ensureCoreBuildArtifacts(): void {
  const nativePackageName = `@opentui/core-${process.platform}-${process.arch}`
  const nativePackageDir = join(corePackageRoot, "node_modules", nativePackageName)
  const hasCoreDist = existsSync(join(coreDistRoot, "index.js")) && existsSync(join(coreDistRoot, "testing.js"))

  if (hasCoreDist && existsSync(nativePackageDir)) {
    return
  }

  const buildExitCode = run("bun", ["run", "build"], { cwd: corePackageRoot })
  if (buildExitCode !== 0) {
    process.exit(buildExitCode)
  }
}

function writeCoreDistProxyPackage(): void {
  const proxyDir = join(outDir, "node_modules", "@opentui", "core")
  mkdirSync(proxyDir, { recursive: true })

  const relativeCoreDistIndex = relative(proxyDir, join(coreDistRoot, "index.js")).replaceAll("\\", "/")
  const relativeCoreDistTesting = relative(proxyDir, join(coreDistRoot, "testing.js")).replaceAll("\\", "/")

  writeFileSync(join(proxyDir, "index.js"), `export * from ${JSON.stringify(relativeCoreDistIndex)}\n`)
  writeFileSync(join(proxyDir, "testing.js"), `export * from ${JSON.stringify(relativeCoreDistTesting)}\n`)

  writeFileSync(
    join(proxyDir, "package.json"),
    JSON.stringify(
      {
        name: "@opentui/core",
        private: true,
        type: "module",
        exports: {
          ".": "./index.js",
          "./testing": "./testing.js",
        },
      },
      null,
      2,
    ),
  )
}

function run(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): number {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
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
