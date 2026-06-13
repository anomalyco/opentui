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
  type?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  engines?: Record<string, string>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const projectRootDir = resolve(rootDir, "../..")
const packageJson: PackageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))

if (!packageJson.module) {
  console.error("Error: 'module' field not found in package.json")
  process.exit(1)
}

console.log("Building @opentui/ssh library...")

const distDir = join(rootDir, "dist")
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

const externalDeps = [
  packageJson.name,
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
]

const buildResult = await Bun.build({
  entrypoints: [join(rootDir, packageJson.module)],
  target: "bun",
  format: "esm",
  outdir: distDir,
  sourcemap: "linked",
  external: externalDeps,
  packages: "external",
  naming: {
    entry: "[dir]/[name].[ext]",
    chunk: "chunks/[name]-[hash].[ext]",
    asset: "assets/[name]-[hash].[ext]",
  },
})

if (!buildResult.success) {
  console.error("Build failed:", buildResult.logs)
  process.exit(1)
}

console.log("Generating TypeScript declarations...")
const tscResult: SpawnSyncReturns<Buffer> = spawnSync(
  "bunx",
  ["--no-install", "tsc", "-p", join(rootDir, "tsconfig.build.json")],
  {
    cwd: rootDir,
    stdio: "inherit",
  },
)

if (tscResult.status !== 0) {
  console.error("Error: TypeScript declaration generation failed")
  process.exit(1)
}

const processedPeerDependencies = { ...packageJson.peerDependencies }
if (processedPeerDependencies["@opentui/core"] === "workspace:*") {
  processedPeerDependencies["@opentui/core"] = packageJson.version
}

writeFileSync(
  join(distDir, "package.json"),
  JSON.stringify(
    {
      name: packageJson.name,
      module: "index.js",
      main: "index.js",
      types: "src/index.d.ts",
      type: packageJson.type,
      version: packageJson.version,
      description: packageJson.description,
      keywords: packageJson.keywords,
      license: packageJson.license,
      author: packageJson.author,
      homepage: packageJson.homepage,
      repository: packageJson.repository,
      bugs: packageJson.bugs,
      exports: {
        ".": {
          types: "./src/index.d.ts",
          import: "./index.js",
        },
      },
      dependencies: packageJson.dependencies,
      peerDependencies: processedPeerDependencies,
      engines: packageJson.engines,
    },
    null,
    2,
  ),
)

// Fail the build if the dist manifest points at entry files that weren't emitted.
const distPkg = JSON.parse(readFileSync(join(distDir, "package.json"), "utf8")) as {
  main?: string
  module?: string
  types?: string
  exports?: Record<string, { types?: string; import?: string }>
}
const referenced: Array<[string, string | undefined]> = [
  ["main", distPkg.main],
  ["module", distPkg.module],
  ["types", distPkg.types],
  ["exports['.'].types", distPkg.exports?.["."]?.types],
  ["exports['.'].import", distPkg.exports?.["."]?.import],
]
const unresolved = referenced.filter(([, target]) => !target || !existsSync(join(distDir, target)))
if (unresolved.length > 0) {
  console.error("Error: dist package.json points at files that do not exist:")
  for (const [field, target] of unresolved) console.error(`  ${field} -> ${target ?? "<missing>"}`)
  process.exit(1)
}

const readmePath = join(rootDir, "README.md")
if (existsSync(readmePath)) copyFileSync(readmePath, join(distDir, "README.md"))

const licensePath = join(projectRootDir, "LICENSE")
if (existsSync(licensePath)) copyFileSync(licensePath, join(distDir, "LICENSE"))

console.log("Library built at:", distDir)
