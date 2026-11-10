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
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const projectRootDir = resolve(rootDir, "../..")
const licensePath = join(projectRootDir, "LICENSE")
const packageJson: PackageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))

const isCi = process.argv.slice(2).includes("--ci")

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

if (!packageJson.module) {
  console.error("Error: 'module' field not found in package.json")
  process.exit(1)
}

console.log("Building @opentui/keymap library...")

const distDir = join(rootDir, "dist")
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

const externalDeps: string[] = [
  packageJson.name,
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
]

const keymapEntrypoints = [
  join(rootDir, packageJson.module),
  join(rootDir, "src/extras/index.ts"),
  join(rootDir, "src/extras/graph.ts"),
  join(rootDir, "src/addons/index.ts"),
  join(rootDir, "src/addons/opentui/index.ts"),
  join(rootDir, "src/testing/index.ts"),
  join(rootDir, "src/html.ts"),
  join(rootDir, "src/opentui.ts"),
  join(rootDir, "src/react/index.ts"),
  join(rootDir, "src/solid/index.ts"),
  join(rootDir, "src/runtime-modules.ts"),
]

function verifyHtmlBundleIsolation(bundlePath: string): void {
  if (!existsSync(bundlePath)) {
    console.warn("Warning: html.js bundle not found, skipping browser bundle isolation check")
    return
  }

  const htmlBundle = readFileSync(bundlePath, "utf8")
  const forbiddenMarkers = [
    "@opentui/core",
    "@opentui/react",
    "@opentui/solid",
    "createOpenTuiKeymapHost",
    "registerManagedTextareaLayer",
    "registerEditBufferCommands",
    "createTextareaBindings",
    "registerTextareaMappingSuspension",
    "registerBaseLayoutFallback",
  ]
  const foundMarkers = forbiddenMarkers.filter((marker) => htmlBundle.includes(marker))

  if (foundMarkers.length > 0) {
    console.error(
      `Error: dist/html.js must stay isolated from OpenTUI runtime entrypoints. Found: ${foundMarkers.join(", ")}`,
    )
    process.exit(1)
  }

  console.log("Verified html bundle stays isolated from OpenTUI runtime entrypoints")
}

const buildResult = await Bun.build({
  entrypoints: keymapEntrypoints,
  target: "bun",
  format: "esm",
  outdir: distDir,
  sourcemap: "linked",
  splitting: true,
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

verifyHtmlBundleIsolation(join(distDir, "src/html.js"))

console.log("Generating TypeScript declarations...")

const tsconfigBuildPath = join(rootDir, "tsconfig.build.json")
const tscResult: SpawnSyncReturns<Buffer> = spawnSync("bunx", ["--no-install", "tsc", "-p", tsconfigBuildPath], {
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

const exports = {
  ".": {
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.js",
  },
  "./extras": {
    types: "./src/extras/index.d.ts",
    import: "./src/extras/index.js",
    require: "./src/extras/index.js",
  },
  "./extras/graph": {
    types: "./src/extras/graph.d.ts",
    import: "./src/extras/graph.js",
    require: "./src/extras/graph.js",
  },
  "./addons": {
    types: "./src/addons/index.d.ts",
    import: "./src/addons/index.js",
    require: "./src/addons/index.js",
  },
  "./addons/opentui": {
    types: "./src/addons/opentui/index.d.ts",
    import: "./src/addons/opentui/index.js",
    require: "./src/addons/opentui/index.js",
  },
  "./testing": {
    types: "./src/testing/index.d.ts",
    import: "./src/testing/index.js",
    require: "./src/testing/index.js",
  },
  "./html": {
    types: "./src/html.d.ts",
    import: "./src/html.js",
    require: "./src/html.js",
  },
  "./opentui": {
    types: "./src/opentui.d.ts",
    import: "./src/opentui.js",
    require: "./src/opentui.js",
  },
  "./react": {
    types: "./src/react/index.d.ts",
    import: "./src/react/index.js",
    require: "./src/react/index.js",
  },
  "./solid": {
    types: "./src/solid/index.d.ts",
    import: "./src/solid/index.js",
    require: "./src/solid/index.js",
  },
  "./runtime-modules": {
    types: "./src/runtime-modules.d.ts",
    import: "./src/runtime-modules.js",
    require: "./src/runtime-modules.js",
  },
}

const processedDependencies = { ...packageJson.dependencies }
if (processedDependencies["@opentui/core"] === "workspace:*") {
  processedDependencies["@opentui/core"] = packageJson.version
}

const processedPeerDependencies = { ...packageJson.peerDependencies }
for (const dependencyName of ["@opentui/react", "@opentui/solid"]) {
  if (processedPeerDependencies[dependencyName] === "workspace:*") {
    processedPeerDependencies[dependencyName] = packageJson.version
  }
}

writeFileSync(
  join(distDir, "package.json"),
  JSON.stringify(
    {
      name: packageJson.name,
      module: "src/index.js",
      main: "src/index.js",
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
      exports,
      dependencies: processedDependencies,
      devDependencies: packageJson.devDependencies,
      peerDependencies: processedPeerDependencies,
      peerDependenciesMeta: packageJson.peerDependenciesMeta,
    },
    null,
    2,
  ),
)

const readmePath = join(rootDir, "README.md")
if (existsSync(readmePath)) {
  writeFileSync(join(distDir, "README.md"), replaceLinks(readFileSync(readmePath, "utf8")))
} else {
  console.warn("Warning: README.md not found in keymap package")
}

if (existsSync(licensePath)) {
  copyFileSync(licensePath, join(distDir, "LICENSE"))
} else {
  console.warn("Warning: LICENSE file not found in project root")
}

console.log("Library built at:", distDir)
