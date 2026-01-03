import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import process from "process"
import solidTransformPlugin from "./solid-plugin"

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

if (!packageJson.module) {
  console.error("Error: 'module' field not found in package.json")
  process.exit(1)
}

console.log("Building main entry point...")
const mainBuildResult = await Bun.build({
  entrypoints: [join(rootDir, packageJson.module)],
  target: "bun",
  outdir: join(rootDir, "dist"),
  packages: "external",
  plugins: [solidTransformPlugin],
  splitting: true,
})

if (!mainBuildResult.success) {
  console.error("Build failed for main entry point:", mainBuildResult.logs)
  process.exit(1)
}

console.log("Generating TypeScript declarations...")

const tsconfigBuildPath = join(rootDir, "tsconfig.build.json")

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

mkdirSync(join(distDir, "scripts"), { recursive: true })

if (existsSync(join(rootDir, "scripts", "solid-plugin.ts"))) {
  copyFileSync(join(rootDir, "scripts", "solid-plugin.ts"), join(distDir, "scripts", "solid-plugin.ts"))
}

if (existsSync(join(rootDir, "scripts", "preload.ts"))) {
  copyFileSync(join(rootDir, "scripts", "preload.ts"), join(distDir, "scripts", "preload.ts"))
}

const exports = {
  ".": {
    types: "./index.d.ts",
    import: "./index.js",
    require: "./index.js",
  },
  "./preload": {
    import: "./scripts/preload.ts",
  },
  "./bun-plugin": {
    types: "./scripts/solid-plugin.d.ts",
    import: "./scripts/solid-plugin.ts",
  },
  "./jsx-runtime": "./jsx-runtime.d.ts",
  "./jsx-dev-runtime": "./jsx-runtime.d.ts",
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
