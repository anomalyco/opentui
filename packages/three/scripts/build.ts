import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

interface PackageJson {
  name: string
  version: string
  license?: string
  repository?: unknown
  description?: string
  homepage?: string
  author?: string
  bugs?: unknown
  keywords?: string[]
  module?: string
  main?: string
  types?: string
  type?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const projectRootDir = resolve(rootDir, "../..")
const licensePath = join(projectRootDir, "LICENSE")
const packageJson: PackageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))

const requiredFields: (keyof PackageJson)[] = ["name", "version", "description"]
const missingRequired = requiredFields.filter((field) => !packageJson[field])
if (missingRequired.length > 0) {
  console.error(`Error: Missing required fields in package.json: ${missingRequired.join(", ")}`)
  process.exit(1)
}

if (!packageJson.module) {
  console.error("Error: 'module' field not found in package.json")
  process.exit(1)
}

console.log("Building @opentui/three library...")

const distDir = join(rootDir, "dist")
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

const externalDeps: string[] = [
  packageJson.name,
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.optionalDependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
]

const buildResult = await Bun.build({
  entrypoints: [join(rootDir, packageJson.module), join(rootDir, "src/runtime-modules.ts")],
  target: "bun",
  format: "esm",
  outdir: distDir,
  external: externalDeps,
  splitting: true,
})

if (!buildResult.success) {
  console.error("Build failed:", buildResult.logs)
  process.exit(1)
}

console.log("Generating TypeScript declarations...")

const coreRootDir = resolve(rootDir, "../core")
const corePackageJsonPath = join(coreRootDir, "package.json")

if (existsSync(corePackageJsonPath)) {
  console.log("Ensuring @opentui/core declarations are up to date...")

  const coreBuildResult: SpawnSyncReturns<Buffer> = spawnSync("bun", ["run", "build:lib"], {
    cwd: coreRootDir,
    stdio: "inherit",
  })

  if (coreBuildResult.status !== 0) {
    console.error("Error: Failed to build @opentui/core declarations required by @opentui/three")
    process.exit(1)
  }
}

const tscResult: SpawnSyncReturns<Buffer> = spawnSync("bunx", ["tsc", "-p", join(rootDir, "tsconfig.build.json")], {
  cwd: rootDir,
  stdio: "inherit",
})

if (tscResult.status !== 0) {
  console.error("Error: TypeScript declaration generation failed")
  process.exit(1)
}

const exports = {
  ".": {
    import: "./index.js",
    require: "./index.js",
    types: "./index.d.ts",
  },
  "./runtime-modules": {
    import: "./runtime-modules.js",
    require: "./runtime-modules.js",
    types: "./runtime-modules.d.ts",
  },
}

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
      engines: packageJson.engines,
      exports,
      dependencies: processedDependencies,
      optionalDependencies: packageJson.optionalDependencies,
      peerDependencies: packageJson.peerDependencies,
    },
    null,
    2,
  ),
)

if (existsSync(licensePath)) {
  copyFileSync(licensePath, join(distDir, "LICENSE"))
}

console.log("Library built at:", distDir)
