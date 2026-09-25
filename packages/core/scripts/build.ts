import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "path"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { fileURLToPath } from "url"
import process from "process"
import path from "path"
import { variants, type Variant } from "./variants"
import { separateNativeSymbols } from "./native-symbols"

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
  chunkNaming?: string
  entryPoints: string[]
  entryNaming?: string
  externalPatterns?: string[]
  outputDirectory?: string
  outputFile?: string
  splitting?: boolean
  target: "bun" | "node"
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const nativeRoot = resolve(rootDir, "../native")
const licensePath = path.resolve(__dirname, "../../../LICENSE")
const ghosttyLicensePath = path.resolve(rootDir, "THIRD_PARTY_LICENSES/GHOSTTY")
const packageJson: PackageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))

const args = process.argv.slice(2)
const buildLib = args.find((arg) => arg === "--lib")
const buildNative = args.find((arg) => arg === "--native")
const isDev = args.includes("--dev")
const buildAll = args.includes("--all") // Build for all platforms
const gpaSafeStats = args.includes("--gpa-safe-stats")
const skipZig = args.includes("--skip-zig")
const skipSymbols = args.includes("--skip-symbols")

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

const runBunBuild = ({
  chunkNaming,
  entryPoints,
  entryNaming,
  externalPatterns = [],
  outputDirectory = "dist",
  outputFile,
  splitting = false,
  target,
}: BunBuildOptions): void => {
  if (outputFile && splitting) {
    throw new Error("Bun builds with an output file cannot use splitting")
  }

  const buildArgs = [
    "build",
    `--target=${target}`,
    outputFile ? `--outfile=${outputFile}` : `--outdir=${outputDirectory}`,
    "--sourcemap",
    ...(entryNaming ? [`--entry-naming=${entryNaming}`] : []),
    ...(chunkNaming ? [`--chunk-naming=${chunkNaming}`] : []),
    ...(splitting ? ["--splitting"] : []),
    ...externalPatterns.flatMap((pattern) => ["--external", pattern]),
    ...entryPoints,
  ]

  runCommand("bun", buildArgs, rootDir, `Error: Bun ${target} build failed for ${entryPoints.join(", ")}`)
}

const finalizeBunBuildOutput = (temporaryPath: string, outputPath: string): void => {
  const temporaryAbsolute = resolve(rootDir, temporaryPath)
  const outputAbsolute = resolve(rootDir, outputPath)
  const temporaryMap = `${temporaryAbsolute}.map`
  const outputMap = `${outputAbsolute}.map`

  let source = readFileSync(temporaryAbsolute, "utf8")
  source = source.replace(`sourceMappingURL=${basename(temporaryMap)}`, `sourceMappingURL=${basename(outputMap)}`)
  writeFileSync(temporaryAbsolute, source)
  renameSync(temporaryAbsolute, outputAbsolute)
  if (existsSync(temporaryMap)) {
    const sourceMap = JSON.parse(readFileSync(temporaryMap, "utf8")) as { sources?: string[] }
    if (sourceMap.sources) {
      sourceMap.sources = sourceMap.sources.map((sourcePath) => {
        if (isAbsolute(sourcePath) || sourcePath.includes(":")) return sourcePath
        return relative(dirname(outputMap), resolve(dirname(temporaryMap), sourcePath)).replaceAll("\\", "/")
      })
      writeFileSync(temporaryMap, JSON.stringify(sourceMap, null, 2) + "\n")
    }
    renameSync(temporaryMap, outputMap)
  }
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

  if (!skipZig) runCommand("zig", zigArgs, nativeRoot, "Error: Zig build failed")

  const variantsToPackage = buildAll ? variants : [getHostVariant()]

  for (const { platform, arch, abi } of variantsToPackage) {
    const nativeName = `${packageJson.name}-${platform}-${arch}${abi ? `-${abi}` : ""}`
    const nativeDir = join(rootDir, "node_modules", nativeName)
    const libDir = join(nativeRoot, "lib", getZigTarget(platform, arch, abi))

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

    if (!isDev && !skipSymbols && libraryFileName) {
      separateNativeSymbols({
        binary: join(nativeDir, libraryFileName),
        symbolsDir: join(nativeRoot, "symbols", `${platform}-${arch}${abi ? `-${abi}` : ""}`),
        platform,
        target: getZigTarget(platform, arch, abi),
        version: packageJson.version,
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
        abi: abi ?? (platform === "linux" || platform === "win32" ? "gnu" : undefined),
        pdb: join(libDir, "opentui.pdb"),
        buildDir: nativeRoot,
      })
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
    for (const [source, destination] of [
      [ghosttyLicensePath, "LICENSE-GHOSTTY"],
      [join(nativeRoot, "src", "vendor", "wuffs", "LICENSE"), "LICENSE-WUFFS"],
      [join(nativeRoot, "src", "vendor", "stb", "LICENSE"), "LICENSE-STB"],
      [join(nativeRoot, "src", "vendor", "libwebp", "COPYING"), "LICENSE-LIBWEBP"],
      [join(nativeRoot, "src", "vendor", "libwebp", "PATENTS"), "PATENTS-LIBWEBP"],
      [join(nativeRoot, "src", "vendor", "libwebp", "AUTHORS"), "AUTHORS-LIBWEBP"],
      [join(nativeRoot, "src", "vendor", "lcms2", "LICENSE"), "LICENSE-LCMS2"],
    ] as const) {
      if (!existsSync(source)) throw new Error(`Required native license file is missing: ${source}`)
      copyFileSync(source, join(nativeDir, destination))
    }
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

  // Keep runtime assets external so Bun consumers can discover literal file imports
  // and Node consumers can resolve package-relative files.
  const externalPatterns = [...externalDeps, "@opentui/core/parser.worker", "*.wasm", "*.scm"]

  const portableEntryPoints = [packageJson.module, "src/testing.ts", "src/yoga.ts"]

  runBunBuild({
    chunkNaming: "chunk-node-[hash].[ext]",
    entryPoints: portableEntryPoints,
    externalPatterns,
    splitting: true,
    target: "node",
  })
  finalizeBunBuildOutput("dist/index.js", "dist/index.node.js")
  runBunBuild({
    chunkNaming: "chunk-bun-[hash].[ext]",
    entryNaming: "[name].bun.[ext]",
    entryPoints: portableEntryPoints,
    externalPatterns,
    splitting: true,
    target: "bun",
  })
  runBunBuild({
    entryPoints: ["src/node-assets.ts"],
    externalPatterns,
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

  // Post-process to fix Bun's duplicate export issue
  // See: https://github.com/oven-sh/bun/issues/5344
  // and: https://github.com/oven-sh/bun/issues/10631
  console.log("Post-processing bundled files to fix duplicate exports...")
  const bundledFiles = [
    "dist/index.node.js",
    "dist/node-assets.js",
    "dist/testing.js",
    "dist/runtime-plugin.js",
    "dist/runtime-plugin-support.js",
    "dist/runtime-plugin-support-configure.js",
    "dist/yoga.js",
    "dist/lib/tree-sitter/update-assets.js",
    "dist/index.bun.js",
    "dist/testing.bun.js",
    "dist/yoga.bun.js",
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

  // Bun derives dotted outfile paths from the entry name, so build in a temporary directory and move both outputs.
  // The tree-sitter WASM remains a separate manifest asset.
  runBunBuild({
    entryPoints: ["src/lib/tree-sitter/parser.worker.ts"],
    externalPatterns: ["*.wasm"],
    outputDirectory: "dist/worker",
    target: "node",
  })
  finalizeBunBuildOutput("dist/worker/parser.worker.js", "dist/parser.worker.js")
  rmSync(join(distDir, "worker"), { recursive: true, force: true })
  if (!existsSync(join(distDir, "parser.worker.js"))) {
    throw new Error("Parser worker build did not produce dist/parser.worker.js")
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
      types: "./index.d.ts",
      bun: "./index.bun.js",
      node: "./index.node.js",
      import: "./index.node.js",
    },
    "./testing": {
      bun: "./testing.bun.js",
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
      bun: "./yoga.bun.js",
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
      bun: "./parser.worker.js",
      node: "./parser.worker.js",
      import: "./parser.worker.js",
      require: "./parser.worker.js",
      types: "./lib/tree-sitter/parser.worker.d.ts",
    },
    "./node-assets": {
      types: "./node-assets.d.ts",
      import: "./node-assets.js",
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
        module: "index.node.js",
        main: "index.node.js",
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

  if (!existsSync(join(distDir, "parser.worker.js"))) {
    throw new Error("Parser worker was removed while assembling the distribution")
  }

  console.log("Library built at:", distDir)
}
