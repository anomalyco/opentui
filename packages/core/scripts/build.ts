import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { fileURLToPath } from "url"
import process from "process"
import path from "path"

interface Variant {
  platform: string
  arch: string
  abi?: string
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

interface BunBuildOptions {
  entryPoints: string[]
  externalPatterns?: string[]
  splitting?: boolean
  target: "bun" | "node"
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
const buildAll = args.includes("--all") // Build for all platforms
const gpaSafeStats = args.includes("--gpa-safe-stats")

const variants: Variant[] = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "linux", arch: "x64", abi: "musl" },
  { platform: "linux", arch: "arm64", abi: "musl" },
  { platform: "win32", arch: "x64" },
  { platform: "win32", arch: "arm64" },
]

const getHostVariant = (): Variant => {
  const hostVariant = variants.find((variant) => variant.platform === process.platform && variant.arch === process.arch)
  if (!hostVariant) {
    console.error(`Error: Unsupported host platform for native builds: ${process.platform}-${process.arch}`)
    process.exit(1)
  }
  return hostVariant
}

if (!buildLib && !buildNative) {
  console.error("Error: Please specify --lib, --native, or both")
  process.exit(1)
}

const getZigTarget = (platform: string, arch: string, abi?: string): string => {
  const platformMap: Record<string, string> = { darwin: "macos", win32: "windows", linux: "linux" }
  const archMap: Record<string, string> = { x64: "x86_64", arm64: "aarch64" }
  const base = `${archMap[arch] ?? arch}-${platformMap[platform] ?? platform}`
  return abi ? `${base}-${abi}` : base
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

const runCommand = (command: string, commandArgs: string[], cwd: string, errorMessage: string): void => {
  const result: SpawnSyncReturns<Buffer> = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
  })

  if (result.error) {
    console.error(`${errorMessage}: ${result.error.message}`)
    process.exit(1)
  }

  if (result.status !== 0) {
    console.error(errorMessage)
    process.exit(1)
  }
}

const runBunBuild = ({ entryPoints, externalPatterns = [], splitting = false, target }: BunBuildOptions): void => {
  const buildArgs = [
    "build",
    `--target=${target}`,
    "--outdir=dist",
    "--sourcemap",
    ...(splitting ? ["--splitting"] : []),
    ...externalPatterns.flatMap((pattern) => ["--external", pattern]),
    ...entryPoints,
  ]

  runCommand("bun", buildArgs, rootDir, `Error: Bun ${target} build failed for ${entryPoints.join(", ")}`)
}

const transpileEntryPoint = (entryPoint: string, outputPath: string): void => {
  const sourcePath = join(rootDir, entryPoint)
  const sourceText = readFileSync(sourcePath, "utf8")
  const result = transpileModule(sourceText, {
    compilerOptions: {
      module: ModuleKind.ESNext,
      sourceMap: true,
      target: ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  })

  writeFileSync(outputPath, result.outputText)
  if (result.sourceMapText) {
    writeFileSync(`${outputPath}.map`, result.sourceMapText)
  }
}

if (buildNative) {
  console.log(`Building native ${isDev ? "dev" : "prod"} binaries${buildAll ? " for all platforms" : ""}...`)

  const zigArgs = ["build", `-Doptimize=${isDev ? "Debug" : "ReleaseFast"}`]
  if (buildAll) {
    zigArgs.push("-Dall")
  }
  if (gpaSafeStats) {
    zigArgs.push("-Dgpa-safe-stats=true")
  }

  runCommand("zig", zigArgs, join(rootDir, "src", "zig"), "Error: Zig build failed")

  const variantsToPackage = buildAll ? variants : [getHostVariant()]

  for (const { platform, arch, abi } of variantsToPackage) {
    const nativeName = `${packageJson.name}-${platform}-${arch}${abi ? `-${abi}` : ""}`
    const nativeDir = join(rootDir, "node_modules", nativeName)
    const libDir = join(rootDir, "src", "zig", "lib", getZigTarget(platform, arch, abi))

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
      // Skip platforms that weren't built
      console.log(`Skipping ${platform}-${arch}: no libraries found`)
      rmSync(nativeDir, { recursive: true, force: true })
      continue
    }

    const indexJsContent = `import { fileURLToPath } from "node:url"

export default fileURLToPath(new URL("./${libraryFileName}", import.meta.url))
`
    writeFileSync(join(nativeDir, "index.js"), indexJsContent)

    const indexBunJsContent = `const module = await import("./${libraryFileName}", { with: { type: "file" } })

export default module.default
`
    writeFileSync(join(nativeDir, "index.bun.js"), indexBunJsContent)

    writeFileSync(join(nativeDir, "index.d.ts"), "declare const path: string\nexport default path\n")

    writeFileSync(
      join(nativeDir, "package.json"),
      JSON.stringify(
        {
          name: nativeName,
          version: packageJson.version,
          description: `Prebuilt ${platform}-${arch}${abi ? `-${abi}` : ""} binaries for ${packageJson.name}`,
          type: "module",
          main: "index.js",
          module: "index.js",
          types: "index.d.ts",
          license: packageJson.license,
          author: packageJson.author,
          homepage: packageJson.homepage,
          repository: packageJson.repository,
          bugs: packageJson.bugs,
          keywords: [...(packageJson.keywords ?? []), "prebuild", "prebuilt"],
          exports: {
            ".": {
              bun: "./index.bun.js",
              import: "./index.js",
              types: "./index.d.ts",
            },
          },
          os: [platform],
          cpu: [arch],
          ...(abi ? { libc: [abi] } : {}),
        },
        null,
        2,
      ),
    )

    writeFileSync(
      join(nativeDir, "README.md"),
      replaceLinks(
        `## ${nativeName}\n\n> Prebuilt ${platform}-${arch}${abi ? `-${abi}` : ""} binaries for \`${packageJson.name}\`.`,
      ),
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

  const externalDeps: string[] = [
    ...Object.keys(packageJson.optionalDependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {}),
  ]

  // Build main entry point
  if (!packageJson.module) {
    console.error("Error: 'module' field not found in package.json")
    process.exit(1)
  }

  const portableEntryPoints: string[] = [packageJson.module, "src/testing.ts", "src/yoga.ts"]

  const bunOnlyEntryPoints = [
    {
      entryPoint: "src/runtime-plugin.ts",
      outputFile: "runtime-plugin.js",
    },
    {
      entryPoint: "src/runtime-plugin-support-configure.ts",
      outputFile: "runtime-plugin-support-configure.js",
    },
    {
      entryPoint: "src/runtime-plugin-support.ts",
      outputFile: "runtime-plugin-support.js",
    },
  ]

  // Build main entry points with code splitting
  // External patterns to prevent bundling tree-sitter assets and default-parsers
  // to allow standalone executables to work
  const externalPatterns = [
    ...externalDeps,
    "*.wasm",
    "*.scm",
    "./lib/tree-sitter/assets/*",
    "./lib/tree-sitter/default-parsers",
    "./lib/tree-sitter/default-parsers.ts",
  ]

  runBunBuild({
    entryPoints: portableEntryPoints,
    externalPatterns,
    splitting: true,
    target: "node",
  })

  for (const { entryPoint, outputFile } of bunOnlyEntryPoints) {
    transpileEntryPoint(entryPoint, join(distDir, outputFile))
  }

  // Build updater as a separate entry so generator code stays out of the core runtime bundle.
  runCommand(
    "bun",
    [
      "build",
      "--target=bun",
      "--outdir=dist/lib/tree-sitter",
      "--sourcemap",
      ...externalDeps.flatMap((dep) => ["--external", dep]),
      "src/lib/tree-sitter/update-assets.ts",
    ],
    rootDir,
    "Error: Bun build failed for src/lib/tree-sitter/update-assets.ts",
  )

  // Build parser worker as standalone bundle (no splitting) so it can be loaded as a Worker
  // Make web-tree-sitter external so it loads from node_modules with its WASM file
  runBunBuild({
    entryPoints: ["src/lib/tree-sitter/parser.worker.ts"],
    externalPatterns: [...externalDeps, "web-tree-sitter"],
    target: "node",
  })

  // Post-process to fix Bun's duplicate export issue
  // See: https://github.com/oven-sh/bun/issues/5344
  // and: https://github.com/oven-sh/bun/issues/10631
  console.log("Post-processing bundled files to fix duplicate exports...")
  const bundledFiles = [
    "dist/index.js",
    "dist/testing.js",
    "dist/runtime-plugin.js",
    "dist/runtime-plugin-support.js",
    "dist/runtime-plugin-support-configure.js",
    "dist/yoga.js",
    "dist/lib/tree-sitter/update-assets.js",
    "dist/parser.worker.js",
  ]
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

  runCommand("bunx", ["tsc", "-p", tsconfigBuildPath], rootDir, "Error: TypeScript declaration generation failed")
  console.log("TypeScript declarations generated")

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

  const writeBunOnlyStub = (fileName: string, specifier: string, exportNames: string[]): void => {
    const errorMessage = `${specifier} is Bun-only and is not available in Node.js. Use Bun to import this entrypoint.`
    const namedExports = exportNames
      .map((exportName) => `export function ${exportName}() {\n  throw new Error(${JSON.stringify(errorMessage)})\n}`)
      .join("\n\n")

    writeFileSync(
      join(distDir, fileName),
      `const errorMessage = ${JSON.stringify(errorMessage)}\n\n${namedExports}\n\nthrow new Error(errorMessage)\n`,
    )
  }

  writeBunOnlyStub("runtime-plugin.node.js", `${packageJson.name}/runtime-plugin`, [
    "createRuntimePlugin",
    "isCoreRuntimeModuleSpecifier",
    "runtimeModuleIdForSpecifier",
  ])
  writeBunOnlyStub("runtime-plugin-support.node.js", `${packageJson.name}/runtime-plugin-support`, [
    "ensureRuntimePluginSupport",
    "createRuntimePlugin",
    "runtimeModuleIdForSpecifier",
  ])
  writeBunOnlyStub("runtime-plugin-support-configure.node.js", `${packageJson.name}/runtime-plugin-support/configure`, [
    "ensureRuntimePluginSupport",
    "createRuntimePlugin",
    "runtimeModuleIdForSpecifier",
  ])

  // Configure exports for multiple entry points
  const exports = {
    ".": {
      import: "./index.js",
      types: "./index.d.ts",
    },
    "./testing": {
      import: "./testing.js",
      types: "./testing.d.ts",
    },
    "./runtime-plugin": {
      types: "./runtime-plugin.d.ts",
      bun: "./runtime-plugin.js",
      node: "./runtime-plugin.node.js",
      default: "./runtime-plugin.node.js",
    },
    "./runtime-plugin-support": {
      types: "./runtime-plugin-support.d.ts",
      bun: "./runtime-plugin-support.js",
      node: "./runtime-plugin-support.node.js",
      default: "./runtime-plugin-support.node.js",
    },
    "./runtime-plugin-support/configure": {
      types: "./runtime-plugin-support-configure.d.ts",
      bun: "./runtime-plugin-support-configure.js",
      node: "./runtime-plugin-support-configure.node.js",
      default: "./runtime-plugin-support-configure.node.js",
    },
    "./yoga": {
      types: "./yoga.d.ts",
      import: "./yoga.js",
    },
    // Conditional exports select the first matching key in declaration order. Bun
    // matches `bun` for both import and require, while Node ESM falls through to
    // `import`. There is deliberately no `require` or `default`: this module uses
    // top-level await, so directing Node CommonJS to it would fail during evaluation.
    "./tree-sitter/update-assets": {
      types: "./lib/tree-sitter/update-assets.d.ts",
      bun: "./lib/tree-sitter/update-assets.js",
      import: "./lib/tree-sitter/update-assets.js",
    },
    "./parser.worker": {
      import: "./parser.worker.js",
      require: "./parser.worker.js",
      types: "./lib/tree-sitter/parser.worker.d.ts",
    },
  }

  const optionalDeps: Record<string, string> = Object.fromEntries(
    variants.map(({ platform, arch, abi }) => [
      `${packageJson.name}-${platform}-${arch}${abi ? `-${abi}` : ""}`,
      packageJson.version,
    ]),
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
