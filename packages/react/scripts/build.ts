import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { fileURLToPath } from "url"
import process from "process"

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

const writeBunOnlyStub = (outputFile: string, specifier: string, exportNames: string[]): void => {
  const errorMessage = `${specifier} is Bun-only and is not available in Node.js. Use Bun to import this entrypoint.`
  const namedExports = exportNames
    .map((exportName) => `export function ${exportName}() {\n  throw new Error(errorMessage)\n}`)
    .join("\n\n")

  writeFileSync(
    join(rootDir, "dist", outputFile),
    `const errorMessage = ${JSON.stringify(errorMessage)}\n\n${namedExports}\n\nthrow new Error(errorMessage)\n`,
  )
}

const requiredFields: (keyof PackageJson)[] = ["name", "version", "description"]
const missingRequired = requiredFields.filter((field) => !packageJson[field])
if (missingRequired.length > 0) {
  console.error(`Error: Missing required fields in package.json: ${missingRequired.join(", ")}`)
  process.exit(1)
}

console.log(`Building @opentui/react library${isDev ? " (dev mode)" : ""}...`)

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

console.log("Building all entry points...")
const buildResult = await Bun.build({
  entrypoints: [
    join(rootDir, packageJson.module), // src/index.ts
    join(rootDir, "src/test-utils.ts"), // test-utils
  ],
  target: "bun",
  format: "esm",
  outdir: join(rootDir, "dist"),
  external: externalDeps,
  splitting: true,
})

if (!buildResult.success) {
  console.error("Build failed:", buildResult.logs)
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

// Copy jsx runtime files
if (existsSync(join(rootDir, "jsx-runtime.d.ts"))) {
  copyFileSync(join(rootDir, "jsx-runtime.d.ts"), join(distDir, "jsx-runtime.d.ts"))
}

if (existsSync(join(rootDir, "jsx-dev-runtime.d.ts"))) {
  copyFileSync(join(rootDir, "jsx-dev-runtime.d.ts"), join(distDir, "jsx-dev-runtime.d.ts"))
}

if (existsSync(join(rootDir, "jsx-namespace.d.ts"))) {
  copyFileSync(join(rootDir, "jsx-namespace.d.ts"), join(distDir, "jsx-namespace.d.ts"))
}

if (existsSync(join(rootDir, "jsx-runtime.js"))) {
  copyFileSync(join(rootDir, "jsx-runtime.js"), join(distDir, "jsx-runtime.js"))
}

if (existsSync(join(rootDir, "jsx-dev-runtime.js"))) {
  copyFileSync(join(rootDir, "jsx-dev-runtime.js"), join(distDir, "jsx-dev-runtime.js"))
}

mkdirSync(join(distDir, "scripts"), { recursive: true })

transpileEntryPoint("scripts/runtime-plugin-support.ts", "scripts/runtime-plugin-support.js")
transpileEntryPoint("scripts/runtime-plugin-support-configure.ts", "scripts/runtime-plugin-support-configure.js")
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
    types: "./src/index.d.ts",
    import: "./index.js",
    require: "./index.js",
  },
  "./renderer": {
    types: "./src/reconciler/renderer.d.ts",
    import: "./index.js",
    require: "./index.js",
  },
  "./test-utils": {
    types: "./src/test-utils.d.ts",
    import: "./test-utils.js",
    require: "./test-utils.js",
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
  "./jsx-runtime": {
    types: "./jsx-runtime.d.ts",
    import: "./jsx-runtime.js",
    require: "./jsx-runtime.js",
  },
  "./jsx-dev-runtime": {
    types: "./jsx-dev-runtime.d.ts",
    import: "./jsx-dev-runtime.js",
    require: "./jsx-dev-runtime.js",
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
  console.warn("Warning: README.md not found in react package")
}

if (existsSync(licensePath)) {
  copyFileSync(licensePath, join(distDir, "LICENSE"))
} else {
  console.warn("Warning: LICENSE file not found in project root")
}

console.log("Library built at:", distDir)
