import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { fileURLToPath } from "url"
import process from "process"
import { createSolidTransformPlugin } from "./solid-plugin.js"
import { resolveNodeSolidRuntimeImport } from "./solid-transform.js"

// `packages/solid/package.json` is the workspace manifest used for repo development.
// This build writes `packages/solid/dist/package.json`, which is the actual published npm manifest.

interface PackageJson {
  name: string
  version: string
  license?: string
  repository?: any
  description?: string
  homepage?: string
  author?: string
  bugs?: any
  keywords?: string[]
  module?: string
  main?: string
  types?: string
  type?: string
  exports?: any
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const projectRootDir = resolve(rootDir, "../..")
const licensePath = join(projectRootDir, "LICENSE")
const packageJson: PackageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))

const args = process.argv.slice(2)
const isDev = args.includes("--dev")
const isCi = args.includes("--ci")

const replaceLinks = (text: string): string => {
  return packageJson.homepage
    ? text.replace(
        /(\[.*?\]\()(\.\/.*?\))/g,
        (_, p1: string, p2: string) => `${p1}${packageJson.homepage}/blob/HEAD/${p2.replace("./", "")}`,
      )
    : text
}

interface BunOnlyStubOptions {
  defaultExport?: boolean
}

interface MainBuildOptions {
  entryPoint?: string
  label: string
  outputFile: string
  resolvePath?: (specifier: string) => string | null
  target: "bun" | "node"
}

const transpileEntryPoint = (entryPoint: string, outputFile: string): void => {
  const sourcePath = join(rootDir, entryPoint)
  const outputPath = join(rootDir, "dist", outputFile)
  const sourceText = readFileSync(sourcePath, "utf8")
  const result = transpileModule(sourceText, {
    compilerOptions: {
      module: ModuleKind.ESNext,
      sourceMap: true,
      target: ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  })

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, result.outputText)
  if (result.sourceMapText) {
    writeFileSync(`${outputPath}.map`, result.sourceMapText)
  }
}

const buildMainEntryPoint = async (options: MainBuildOptions): Promise<void> => {
  console.log(`Building ${options.label} entry point...`)

  const external = new Set(externalDeps)

  for (const specifier of ["solid-js", "solid-js/store"]) {
    const rewritten = options.resolvePath?.(specifier)
    if (rewritten) {
      external.add(rewritten)
    }
  }

  const buildResult = await Bun.build({
    entrypoints: [join(rootDir, options.entryPoint ?? packageJson.module!)],
    external: [...external],
    outfile: join(rootDir, "dist", options.outputFile),
    plugins: [createSolidTransformPlugin({ resolvePath: options.resolvePath })],
    sourcemap: "external",
    target: options.target,
  })

  if (!buildResult.success) {
    console.error(`Build failed for ${options.label} entry point:`, buildResult.logs)
    process.exit(1)
  }

  const outputPath = join(rootDir, "dist", options.outputFile)
  for (const output of buildResult.outputs) {
    if (output.kind === "entry-point") {
      await Bun.write(outputPath, output)
      continue
    }

    if (output.kind === "sourcemap") {
      await Bun.write(`${outputPath}.map`, output)
    }
  }
}

const writeBunOnlyStub = (
  outputFile: string,
  specifier: string,
  exportNames: string[],
  options: BunOnlyStubOptions = {},
): void => {
  const errorMessage = `${specifier} is Bun-only and is not available in Node.js. Use Bun to import this entrypoint.`
  const namedExports = exportNames
    .map((exportName) => `export function ${exportName}() {\n  return unavailable()\n}`)
    .join("\n\n")
  const defaultExport = options.defaultExport ? "\n\nexport default unavailable()" : ""

  writeFileSync(
    join(rootDir, "dist", outputFile),
    `const errorMessage = ${JSON.stringify(errorMessage)}\n\nfunction unavailable() {\n  throw new Error(errorMessage)\n}\n\n${namedExports}${defaultExport}\n\nunavailable()\n`,
  )
}

const requiredFields: (keyof PackageJson)[] = ["name", "version", "description"]
const missingRequired = requiredFields.filter((field) => !packageJson[field])
if (missingRequired.length > 0) {
  console.error(`Error: Missing required fields in package.json: ${missingRequired.join(", ")}`)
  process.exit(1)
}

console.log(`Building @opentui/solid library${isDev ? " (dev mode)" : ""}...`)

const distDir = join(rootDir, "dist")
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

const externalDeps: string[] = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
]

if (!packageJson.module) {
  console.error("Error: 'module' field not found in package.json")
  process.exit(1)
}

await buildMainEntryPoint({
  label: "Node",
  outputFile: "index.js",
  resolvePath: resolveNodeSolidRuntimeImport,
  target: "node",
})

await buildMainEntryPoint({
  label: "Bun",
  outputFile: "index.bun.js",
  target: "bun",
})

await buildMainEntryPoint({
  entryPoint: "components.ts",
  label: "components",
  outputFile: "components.js",
  target: "node",
})

console.log("Generating TypeScript declarations...")

const tsconfigBuildPath = join(rootDir, "tsconfig.build.json")

const coreRootDir = resolve(rootDir, "../core")
const corePackageJsonPath = join(coreRootDir, "package.json")

if (existsSync(corePackageJsonPath)) {
  console.log("Ensuring @opentui/core declarations are up to date...")

  const coreBuildResult: SpawnSyncReturns<Buffer> = spawnSync("bun", ["run", "build:lib"], {
    cwd: coreRootDir,
    stdio: "inherit",
  })

  if (coreBuildResult.status !== 0) {
    console.error("Error: Failed to build @opentui/core declarations required by @opentui/solid")
    process.exit(1)
  }
}

const tscResult: SpawnSyncReturns<Buffer> = spawnSync("bunx", ["tsc", "-p", tsconfigBuildPath], {
  cwd: rootDir,
  stdio: "inherit",
})

if (tscResult.status !== 0) {
  if (isCi) {
    console.error("Error: TypeScript declaration generation failed")
    process.exit(1)
  }
  console.warn("Warning: TypeScript declaration generation failed")
} else {
  console.log("TypeScript declarations generated")
}

if (existsSync(join(rootDir, "jsx-runtime.d.ts"))) {
  copyFileSync(join(rootDir, "jsx-runtime.d.ts"), join(distDir, "jsx-runtime.d.ts"))
}

if (existsSync(join(rootDir, "jsx-dev-runtime.d.ts"))) {
  copyFileSync(join(rootDir, "jsx-dev-runtime.d.ts"), join(distDir, "jsx-dev-runtime.d.ts"))
}

transpileEntryPoint("jsx-runtime.ts", "jsx-runtime.js")
transpileEntryPoint("jsx-dev-runtime.ts", "jsx-dev-runtime.js")

mkdirSync(join(distDir, "scripts"), { recursive: true })

transpileEntryPoint("scripts/solid-plugin.ts", "scripts/solid-plugin.js")
transpileEntryPoint("scripts/solid-transform.ts", "scripts/solid-transform.js")
transpileEntryPoint("scripts/preload.ts", "scripts/preload.js")
transpileEntryPoint("scripts/runtime-plugin-support.ts", "scripts/runtime-plugin-support.js")
transpileEntryPoint("scripts/runtime-plugin-support-configure.ts", "scripts/runtime-plugin-support-configure.js")
writeBunOnlyStub("scripts/preload.node.js", `${packageJson.name}/preload`, [])
writeBunOnlyStub(
  "scripts/solid-plugin.node.js",
  `${packageJson.name}/bun-plugin`,
  ["ensureSolidTransformPlugin", "resetSolidTransformPluginState", "createSolidTransformPlugin"],
  { defaultExport: true },
)
writeBunOnlyStub("scripts/runtime-plugin-support.node.js", `${packageJson.name}/runtime-plugin-support`, [
  "ensureRuntimePluginSupport",
])
writeBunOnlyStub(
  "scripts/runtime-plugin-support-configure.node.js",
  `${packageJson.name}/runtime-plugin-support/configure`,
  ["ensureRuntimePluginSupport"],
)

const exports = {
  ".": {
    types: "./index.d.ts",
    bun: "./index.bun.js",
    node: "./index.js",
    import: "./index.js",
    default: "./index.js",
  },
  "./preload": {
    bun: "./scripts/preload.js",
    node: "./scripts/preload.node.js",
    default: "./scripts/preload.node.js",
  },
  "./bun-plugin": {
    types: "./scripts/solid-plugin.d.ts",
    bun: "./scripts/solid-plugin.js",
    node: "./scripts/solid-plugin.node.js",
    default: "./scripts/solid-plugin.node.js",
  },
  "./runtime-plugin-support": {
    types: "./scripts/runtime-plugin-support.d.ts",
    bun: "./scripts/runtime-plugin-support.js",
    node: "./scripts/runtime-plugin-support.node.js",
    default: "./scripts/runtime-plugin-support.node.js",
  },
  "./runtime-plugin-support/configure": {
    types: "./scripts/runtime-plugin-support-configure.d.ts",
    bun: "./scripts/runtime-plugin-support-configure.js",
    node: "./scripts/runtime-plugin-support-configure.node.js",
    default: "./scripts/runtime-plugin-support-configure.node.js",
  },
  "./components": {
    types: "./components.d.ts",
    import: "./components.js",
    require: "./components.js",
  },
  "./jsx-runtime": {
    types: "./jsx-runtime.d.ts",
    import: "./jsx-runtime.js",
    default: "./jsx-runtime.js",
  },
  "./jsx-dev-runtime": {
    types: "./jsx-dev-runtime.d.ts",
    import: "./jsx-dev-runtime.js",
    default: "./jsx-dev-runtime.js",
  },
}

// Process dependencies to replace workspace references with actual versions
const processedDependencies = { ...packageJson.dependencies }
if (processedDependencies["@opentui/core"] === "workspace:*") {
  processedDependencies["@opentui/core"] = packageJson.version
}

writeFileSync(
  join(distDir, "package.json"),
  JSON.stringify(
    {
      name: packageJson.name,
      module: "index.js",
      main: "index.js",
      types: "index.d.ts",
      type: packageJson.type,
      version: packageJson.version,
      description: packageJson.description,
      keywords: packageJson.keywords,
      license: packageJson.license,
      author: packageJson.author,
      homepage: packageJson.homepage,
      repository: packageJson.repository,
      bugs: packageJson.bugs,
      exports,
      dependencies: processedDependencies,
      devDependencies: packageJson.devDependencies,
      peerDependencies: packageJson.peerDependencies,
    },
    null,
    2,
  ),
)

const readmePath = join(rootDir, "README.md")
if (existsSync(readmePath)) {
  writeFileSync(join(distDir, "README.md"), replaceLinks(readFileSync(readmePath, "utf8")))
} else {
  console.warn("Warning: README.md not found in solid package")
}

if (existsSync(licensePath)) {
  copyFileSync(licensePath, join(distDir, "LICENSE"))
} else {
  console.warn("Warning: LICENSE file not found in project root")
}

console.log("Library built at:", distDir)
