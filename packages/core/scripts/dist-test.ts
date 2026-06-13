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
const distDir = join(rootDir, "dist")
const args = new Set(process.argv.slice(2))
const keepTemp = args.has("--keep-temp")
const skipBuild = args.has("--skip-build")
const nodePath = requireNode26()

const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as PackageJson
const nativePackageName = `${packageJson.name}-${process.platform}-${process.arch}`
const nativePackageDir = join(rootDir, "node_modules", nativePackageName)

const declarationPaths = ["index.d.ts", "testing.d.ts", "lib/tree-sitter/parser.worker.d.ts"]

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

const core = await import(${JSON.stringify(packageJson.name)})
const testing = await import(${JSON.stringify(`${packageJson.name}/testing`)})
const parserWorker = await import(${JSON.stringify(`${packageJson.name}/parser.worker`)})
const nativePackage = await import(nativePackageName)

assert.equal(typeof core.createCliRenderer, "function")
assert.equal(typeof testing.createTestRenderer, "function")
assert.equal(typeof parserWorker, "object")
assert.equal(typeof nativePackage.default, "string")

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

for (const specifier of [${JSON.stringify(packageJson.name)}, ${JSON.stringify(`${packageJson.name}/testing`)}, ${JSON.stringify(`${packageJson.name}/tree-sitter/update-assets`)}]) {
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
    const parserWorker = await import(${JSON.stringify(`${packageJson.name}/parser.worker`)})
    const runtimePlugin = await import(${JSON.stringify(`${packageJson.name}/runtime-plugin`)})
    const nativePackage = await import(${JSON.stringify(nativePackageName)})

    expect(typeof core.createCliRenderer).toBe("function")
    expect(typeof testing.createTestRenderer).toBe("function")
    expect(typeof parserWorker).toBe("object")
    expect(typeof runtimePlugin.createRuntimePlugin).toBe("function")
    expect(typeof nativePackage.default).toBe("string")
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
  runCommand("npm", ["install", "--ignore-scripts", "--no-package-lock"], nodeDir, "Node dist test install failed")
  runCommand(nodePath, ["-e", `import(${JSON.stringify(packageJson.name)})`], nodeDir, "Node import smoke check failed")
  runCommand(nodePath, ["index.mjs"], nodeDir, "Node dist smoke tests failed")
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
