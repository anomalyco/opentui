/**
 * Smoke-tests the packed npm consumer contract for `@opentui/solid`.
 *
 * This verifies the built tarballs install in a fresh project, the published
 * `exports` map resolves correctly in Node, a consumer TSX file typechecks, the
 * real JSX runtime files load, and Bun-only subpaths fail with the intended error
 * instead of ESM export errors.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { requireNode26 } from "../../../scripts/node26.mjs"

interface PackageJson {
  name: string
  peerDependencies?: Record<string, string>
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
const solidJsVersion = packageJson.peerDependencies?.["solid-js"] ?? "1.9.12"
const commandTimeoutMs = 5 * 60 * 1000

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
    timeout: commandTimeoutMs,
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
    timeout: commandTimeoutMs,
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
    runCommand("bun", ["run", "build"], coreRootDir, "Core build failed")
    runCommand("bun", ["run", "build"], rootDir, "Solid build failed")
  }

  if (!existsSync(coreDistDir)) {
    throw new Error(`Missing core dist directory at ${coreDistDir}. Run bun run build in packages/core first.`)
  }

  if (!existsSync(distDir)) {
    throw new Error(`Missing solid dist directory at ${distDir}. Run bun run build first.`)
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
  solidTarball: string,
  coreTarball: string,
  nativeTarball: string,
): void {
  const solidDependency = `file:${relative(consumerDir, solidTarball).replaceAll("\\", "/")}`
  const coreDependency = `file:${relative(consumerDir, coreTarball).replaceAll("\\", "/")}`
  const nativeDependency = `file:${relative(consumerDir, nativeTarball).replaceAll("\\", "/")}`

  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "opentui-solid-dist-test-node",
        private: true,
        type: "module",
        dependencies: {
          [packageJson.name]: solidDependency,
          [corePackageJson.name]: coreDependency,
          [nativePackageName]: nativeDependency,
          "solid-js": solidJsVersion,
          typescript: "^5",
        },
      },
      null,
      2,
    ),
  )
}

function writeTypecheckFixture(consumerDir: string): void {
  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          jsx: "preserve",
          jsxImportSource: packageJson.name,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(consumerDir, "fixture.tsx"),
    `import { For, Match, Show, Switch } from "solid-js"
import { Portal, testRender } from ${JSON.stringify(packageJson.name)}

export function render() {
  return testRender(() => (
    <box>
      <For each={["one"]}>{(item) => <text>{item}</text>}</For>
      <Show when={true}>
        <text>Shown</text>
      </Show>
      <Switch fallback={<text>Fallback</text>}>
        <Match when={true}>
          <Portal>
            <text>Portal</text>
          </Portal>
        </Match>
      </Switch>
    </box>
  ))
}
`,
  )
}

function writeNodeTest(nodeDir: string): void {
  writeFileSync(
    join(nodeDir, "index.mjs"),
    `import assert from "node:assert/strict"
import { rmSync, writeFileSync } from "node:fs"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { transformAsync } from "@babel/core"
import ts from "@babel/preset-typescript"
import moduleResolver from "babel-plugin-module-resolver"
import solid from "babel-preset-solid"

const solidRuntime = await import(${JSON.stringify(packageJson.name)})
const jsxRuntime = await import(${JSON.stringify(`${packageJson.name}/jsx-runtime`)})
const jsxDevRuntime = await import(${JSON.stringify(`${packageJson.name}/jsx-dev-runtime`)})

assert.equal(typeof solidRuntime.testRender, "function")
assert.equal(typeof jsxRuntime.jsx, "function")
assert.equal(typeof jsxRuntime.jsxs, "function")
assert.equal(typeof jsxRuntime.Fragment, "function")
assert.equal(typeof jsxDevRuntime.jsxDEV, "function")

const fixtureSource = [
  'import { createSignal, For, Match, Show, Switch } from "solid-js"',
  'import { testRender } from ${JSON.stringify(packageJson.name)}',
  '',
  'export async function run() {',
  '  const [items, setItems] = createSignal(["Hello"])',
  '  const [showTail, setShowTail] = createSignal(false)',
  '  const [mode, setMode] = createSignal(1)',
  '  const setup = await testRender(() => (',
  '    <box>',
  '      <For each={items()}>{(item) => <text>{item}</text>}</For>',
  '      <Show when={showTail()}>',
  '        <text>World</text>',
  '      </Show>',
  '      <Switch fallback={<text>Fallback</text>}>',
  '        <Match when={mode() === 1}><text>ModeOne</text></Match>',
  '        <Match when={mode() === 2}><text>ModeTwo</text></Match>',
  '      </Switch>',
  '    </box>',
  '  ), { width: 24, height: 8 })',
  '  await setup.renderOnce()',
  '  const first = setup.captureCharFrame()',
  '  setItems(["Hello", "Node"])',
  '  setShowTail(true)',
  '  setMode(2)',
  '  await setup.renderOnce()',
  '  const second = setup.captureCharFrame()',
  '  setup.renderer.destroy()',
  '  return { first, second }',
  '}',
].join("\\n")

const transformed = await transformAsync(fixtureSource, {
  filename: join(process.cwd(), "fixture.tsx"),
  configFile: false,
  babelrc: false,
  plugins: [
    [
      moduleResolver,
      {
        resolvePath(specifier) {
          if (specifier === "solid-js") return "solid-js/dist/solid.js"
          if (specifier === "solid-js/store") return "solid-js/store/dist/store.js"
          return specifier
        },
      },
    ],
  ],
  presets: [
    [solid, { moduleName: ${JSON.stringify(packageJson.name)}, generate: "universal" }],
    [ts],
  ],
})

if (!transformed?.code) {
  throw new Error("Failed to transform Solid fixture")
}

const runtimeDir = join(process.cwd(), ".dist-node-runtime")
const runtimePath = join(runtimeDir, "fixture.mjs")
mkdirSync(runtimeDir, { recursive: true })
writeFileSync(runtimePath, transformed.code)

try {
  const { run } = await import(pathToFileURL(runtimePath).href)
  const result = await run()
  assert.match(result.first, /Hello/)
  assert.match(result.first, /ModeOne/)
  assert.doesNotMatch(result.first, /World/)
  assert.match(result.second, /Hello/)
  assert.match(result.second, /Node/)
  assert.match(result.second, /World/)
  assert.match(result.second, /ModeTwo/)
} finally {
  rmSync(runtimeDir, { recursive: true, force: true })
}

const expectBunOnlyFailure = async (specifier, expectedMessage) => {
  await assert.rejects(import(specifier), (error) => {
    return error instanceof Error && error.message.includes(expectedMessage)
  })
}

await expectBunOnlyFailure(${JSON.stringify(`${packageJson.name}/preload`)}, ${JSON.stringify(`${packageJson.name}/preload is Bun-only`)})
await expectBunOnlyFailure(${JSON.stringify(`${packageJson.name}/bun-plugin`)}, ${JSON.stringify(`${packageJson.name}/bun-plugin is Bun-only`)})
await expectBunOnlyFailure(
  ${JSON.stringify(`${packageJson.name}/runtime-plugin-support`)},
  ${JSON.stringify(`${packageJson.name}/runtime-plugin-support is Bun-only`)},
)
await expectBunOnlyFailure(
  ${JSON.stringify(`${packageJson.name}/runtime-plugin-support/configure`)},
  ${JSON.stringify(`${packageJson.name}/runtime-plugin-support/configure is Bun-only`)},
)

console.log("Node solid dist smoke test passed")
`,
  )
}

function writeBunTest(bunDir: string): void {
  writeFileSync(
    join(bunDir, "fixture.bun.tsx"),
    `import { testRender } from ${JSON.stringify(packageJson.name)}

export async function run() {
  const setup = await testRender(() => <box />)
  setup.renderer.destroy()
}
`,
  )
  writeFileSync(
    join(bunDir, "index.bun.mjs"),
    `import { ensureRuntimePluginSupport } from ${JSON.stringify(`${packageJson.name}/runtime-plugin-support/configure`)}
import { testRender } from ${JSON.stringify(packageJson.name)}
import { jsx } from ${JSON.stringify(`${packageJson.name}/jsx-runtime`)}

const setup = await testRender(() => jsx("box", {}))
setup.renderer.destroy()

ensureRuntimePluginSupport()
await import("./fixture.bun.tsx").then((fixture) => fixture.run())

console.log("Bun solid dist smoke test passed")
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

function installAndTest(nodeDir: string): void {
  runCommand("npm", ["install", "--ignore-scripts", "--no-package-lock"], nodeDir, "Node dist test install failed")
  runCommand("npm", ["exec", "--", "tsc", "--noEmit"], nodeDir, "Node dist consumer typecheck failed")
  runCommand("bun", ["index.bun.mjs"], nodeDir, "Bun solid dist smoke tests failed")

  const nodeRealDir = realpathSync(nodeDir)
  const nodePermissionDirs = [...new Set([nodeDir, nodeRealDir])]
  const nodeFfiArgs = [
    "--disable-warning=SecurityWarning",
    "--disable-warning=ExperimentalWarning",
    "--permission",
    ...nodePermissionDirs.map((path) => `--allow-fs-read=${path}`),
    ...nodePermissionDirs.map((path) => `--allow-fs-write=${path}`),
    "--allow-ffi",
    "--experimental-ffi",
  ]
  runCommand(
    nodePath,
    [...nodeFfiArgs, "-e", `import(${JSON.stringify(packageJson.name)})`],
    nodeDir,
    "Node import smoke check failed",
  )
  runCommand(nodePath, [...nodeFfiArgs, "index.mjs"], nodeDir, "Node solid dist smoke tests failed")

  assertNodeStaticImportFailure(
    nodeDir,
    "createSolidTransformPlugin",
    `${packageJson.name}/bun-plugin`,
    `${packageJson.name}/bun-plugin is Bun-only`,
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
}

let tempRoot: string | undefined

try {
  ensureBuildArtifacts()

  tempRoot = mkdtempSync(join(tmpdir(), "opentui-solid-dist-test-"))
  const packDir = join(tempRoot, "packs")
  const nodeDir = join(tempRoot, "node")

  mkdirSync(packDir, { recursive: true })
  mkdirSync(nodeDir, { recursive: true })

  const coreTarball = packArtifact(coreDistDir, packDir)
  const nativeTarball = packArtifact(nativePackageDir, packDir)
  const solidTarball = packArtifact(distDir, packDir)

  writeConsumerPackage(nodeDir, solidTarball, coreTarball, nativeTarball)
  writeTypecheckFixture(nodeDir)
  writeNodeTest(nodeDir)
  writeBunTest(nodeDir)

  installAndTest(nodeDir)

  if (!keepTemp) {
    rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }

  console.log("Packed solid dist smoke tests passed")
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  if (tempRoot) {
    console.error(`Dist test workspace kept at ${tempRoot}`)
  }
  process.exit(1)
}
