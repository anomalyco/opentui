import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import process from "process"
import path from "path"

interface Variant {
  platform: string
  arch: string
}

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
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const licensePath = path.resolve(__dirname, "../../../LICENSE")
const packageJson: PackageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))

const args = process.argv.slice(2)
const buildLib = args.find((arg) => arg === "--lib")
const buildNative = args.find((arg) => arg === "--native")
const isDev = args.includes("--dev")

const variants: Variant[] = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "win32", arch: "x64" },
  { platform: "win32", arch: "arm64" },
]

if (!buildLib && !buildNative) {
  console.error("Error: Please specify --lib, --native, or both")
  process.exit(1)
}

const getZigTarget = (platform: string, arch: string): string => {
  const platformMap: Record<string, string> = { darwin: "macos", win32: "windows", linux: "linux" }
  const archMap: Record<string, string> = { x64: "x86_64", arm64: "aarch64" }
  return `${archMap[arch] ?? arch}-${platformMap[platform] ?? platform}`
}

const replaceLinks = (text: string): string => {
  return packageJson.homepage
    ? text.replace(
        /(\[.*?\]\()(\.\/.*?\))/g,
        (_, p1: string, p2: string) => `${p1}${packageJson.homepage}/blob/HEAD/${p2.replace("./", "")}`,
      )
    : text
}

const requiredFields: (keyof PackageJson)[] = ["name", "version", "license", "repository", "description"]
const missingRequired = requiredFields.filter((field) => !packageJson[field])
if (missingRequired.length > 0) {
  console.error(`Error: Missing required fields in package.json: ${missingRequired.join(", ")}`)
  process.exit(1)
}

if (buildNative) {
  console.log(`Building native ${isDev ? "dev" : "prod"} binaries...`)

  const zigBuild: SpawnSyncReturns<Buffer> = spawnSync(
    "zig",
    ["build", `-Doptimize=${isDev ? "Debug" : "ReleaseFast"}`],
    {
      cwd: join(rootDir, "src", "zig"),
      stdio: "inherit",
    },
  )

  if (zigBuild.error) {
    console.error("Error: Zig is not installed or not in PATH")
    process.exit(1)
  }

  if (zigBuild.status !== 0) {
    console.error("Error: Zig build failed")
    process.exit(1)
  }

  for (const { platform, arch } of variants) {
    const nativeName = `${packageJson.name}-${platform}-${arch}`
    const nativeDir = join(rootDir, "node_modules", nativeName)
    const libDir = join(rootDir, "src", "zig", "lib", getZigTarget(platform, arch))

    rmSync(nativeDir, { recursive: true, force: true })
    mkdirSync(nativeDir, { recursive: true })

    let copiedFiles = 0
    let libraryFileName: string | null = null
    for (const name of ["libopentui", "opentui"]) {
      for (const ext of [".so", ".dll", ".dylib"]) {
        const src = join(libDir, `${name}${ext}`)
        if (existsSync(src)) {
          const fileName = `${name}${ext}`
          copyFileSync(src, join(nativeDir, fileName))
          copiedFiles++
          if (!libraryFileName) {
            libraryFileName = fileName
          }
        }
      }
    }

    if (copiedFiles === 0) {
      console.error(`Error: No dynamic libraries found for ${platform}-${arch} in ${libDir}`)
      console.error(`Expected to find files like: libopentui.so, libopentui.dylib, opentui.dll`)
      console.error(`Found files in ${libDir}:`)
      if (existsSync(libDir)) {
        const files = spawnSync("ls", ["-la", libDir], { stdio: "pipe" })
        if (files.stdout) console.error(files.stdout.toString())
      } else {
        console.error("Directory does not exist")
      }
      process.exit(1)
    }

    const indexTsContent = `const module = await import("./${libraryFileName}", { with: { type: "file" } })
const path = module.default
export default path;
`
    writeFileSync(join(nativeDir, "index.ts"), indexTsContent)

    writeFileSync(
      join(nativeDir, "package.json"),
      JSON.stringify(
        {
          name: nativeName,
          version: packageJson.version,
          description: `Prebuilt ${platform}-${arch} binaries for ${packageJson.name}`,
          main: "index.ts",
          types: "index.ts",
          license: packageJson.license,
          author: packageJson.author,
          homepage: packageJson.homepage,
          repository: packageJson.repository,
          bugs: packageJson.bugs,
          keywords: [...(packageJson.keywords ?? []), "prebuild", "prebuilt"],
          os: [platform],
          cpu: [arch],
        },
        null,
        2,
      ),
    )

    writeFileSync(
      join(nativeDir, "README.md"),
      replaceLinks(`## ${nativeName}\n\n> Prebuilt ${platform}-${arch} binaries for \`${packageJson.name}\`.`),
    )

    if (existsSync(licensePath)) copyFileSync(licensePath, join(nativeDir, "LICENSE"))
    console.log("Built:", nativeName)
  }
}

if (buildLib) {
  console.log("Building library...")

  const distDir = join(rootDir, "dist")
  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(distDir, { recursive: true })

  // Build main entry point
  if (!packageJson.module) {
    console.error("Error: 'module' field not found in package.json")
    process.exit(1)
  }

  const entryPoints: string[] = [packageJson.module, "src/3d.ts", "src/testing.ts"]

  // External patterns to prevent bundling tree-sitter assets and default-parsers
  // to allow standalone executables to work
  const externalPatterns = [
    "*.wasm",
    "*.scm",
    "./lib/tree-sitter/assets/*",
    "./lib/tree-sitter/default-parsers",
    "./lib/tree-sitter/default-parsers.ts",
  ]

  // Build main entry points with code splitting
  // Use --packages=external to externalize all dependencies
  spawnSync(
    "bun",
    [
      "build",
      "--target=bun",
      "--splitting",
      "--outdir=dist",
      "--sourcemap",
      "--packages=external",
      ...externalPatterns.flatMap((dep) => ["--external", dep]),
      ...entryPoints,
    ],
    {
      cwd: rootDir,
      stdio: "inherit",
    },
  )

  // Build parser worker as standalone bundle (no splitting) so it can be loaded as a Worker
  // Use --packages=external to externalize all dependencies
  spawnSync(
    "bun",
    [
      "build",
      "--target=bun",
      "--outdir=dist",
      "--sourcemap",
      "--packages=external",
      "src/lib/tree-sitter/parser.worker.ts",
    ],
    {
      cwd: rootDir,
      stdio: "inherit",
    },
  )

  // Post-process to fix Bun's duplicate export issue
  // See: https://github.com/oven-sh/bun/issues/5344
  // and: https://github.com/oven-sh/bun/issues/10631
  console.log("Post-processing bundled files to fix duplicate exports...")
  const bundledFiles = ["dist/index.js", "dist/3d.js", "dist/testing.js", "dist/lib/tree-sitter/parser.worker.js"]
  for (const filePath of bundledFiles) {
    const fullPath = join(rootDir, filePath)
    if (existsSync(fullPath)) {
      let content = readFileSync(fullPath, "utf8")
      const helperExportPattern = /^export\s*\{([^}]*(?:__toESM|__commonJS|__export|__require)[^}]*)\};\s*$/gm

      let modified = false
      content = content.replace(helperExportPattern, (match, exports) => {
        const exportsList = exports.split(",").map((e: string) => e.trim())
        const helpers = ["__toESM", "__commonJS", "__export", "__require"]
        const nonHelpers = exportsList.filter((e: string) => !helpers.includes(e))

        if (nonHelpers.length > 0) {
          modified = true
          const helperExports = exportsList.filter((e: string) => helpers.includes(e))
          return `export { ${helperExports.join(", ")} };`
        }
        return match
      })

      if (modified) {
        writeFileSync(fullPath, content)
        console.log(`  Fixed duplicate exports in ${filePath}`)
      }
    }
  }

  console.log("Generating TypeScript declarations...")

  const tsconfigBuildPath = join(rootDir, "tsconfig.build.json")

  const tscResult: SpawnSyncReturns<Buffer> = spawnSync("bunx", ["tsc", "-p", tsconfigBuildPath], {
    cwd: rootDir,
    stdio: "inherit",
  })

  if (tscResult.status !== 0) {
    console.error("Error: TypeScript declaration generation failed")
    process.exit(1)
  } else {
    console.log("TypeScript declarations generated")
  }

  const treeSitterSrcDir = join(rootDir, "src", "lib", "tree-sitter")

  const copyAssets = (src: string, dest: string) => {
    mkdirSync(dest, { recursive: true })
    const entries = readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = join(src, entry.name)
      const destPath = join(dest, entry.name)
      if (entry.isDirectory()) {
        copyAssets(srcPath, destPath)
      } else if (entry.isFile() && (entry.name.endsWith(".wasm") || entry.name.endsWith(".scm"))) {
        copyFileSync(srcPath, destPath)
      }
    }
  }

  copyAssets(join(treeSitterSrcDir, "assets"), join(distDir, "assets"))
  console.log("  Copied tree-sitter assets (*.wasm, *.scm) to dist/assets/")

  // Configure exports for multiple entry points
  const exports = {
    ".": {
      import: "./index.js",
      require: "./index.js",
      types: "./index.d.ts",
    },
    "./3d": {
      import: "./3d.js",
      require: "./3d.js",
      types: "./3d.d.ts",
    },
    "./testing": {
      import: "./testing.js",
      require: "./testing.js",
      types: "./testing.d.ts",
    },
    "./parser.worker": {
      import: "./lib/tree-sitter/parser.worker.js",
      require: "./lib/tree-sitter/parser.worker.js",
      types: "./lib/tree-sitter/parser.worker.d.ts",
    },
  }

  const optionalDeps: Record<string, string> = Object.fromEntries(
    variants.map(({ platform, arch }) => [`${packageJson.name}-${platform}-${arch}`, packageJson.version]),
  )

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
        dependencies: packageJson.dependencies,
        devDependencies: packageJson.devDependencies,
        peerDependencies: packageJson.peerDependencies,
        optionalDependencies: {
          ...packageJson.optionalDependencies,
          ...optionalDeps,
        },
      },
      null,
      2,
    ),
  )

  writeFileSync(join(distDir, "README.md"), replaceLinks(readFileSync(join(rootDir, "README.md"), "utf8")))
  if (existsSync(licensePath)) copyFileSync(licensePath, join(distDir, "LICENSE"))

  console.log("Library built at:", distDir)
}
