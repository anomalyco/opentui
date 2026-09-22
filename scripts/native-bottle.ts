import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

// Linked libraries for CI, keyed by native inputs, Zig version, and the ReleaseFast target set.
// This is not a Zig cache. Only the cross-compile job saves the bottle. A host build must not.

const BOTTLE_VERSION = 1
const KEY_PREFIX = "native-bottle-v1"
const OPTIMIZE = "ReleaseFast"
const MANIFEST_NAME = "bottle-manifest.json"

// These paths are the inputs of `zig build -Doptimize=ReleaseFast`. Generated output is not an input.
const INPUTS = ["build.zig", "build.zig.zon", "scripts/prepare-zig-deps.sh", "src"] as const

// Output names match packages/native/build.zig. File names match packages/core/scripts/build.ts.
const BOTTLE_LIBRARIES: ReadonlyArray<{ dir: string; files: readonly string[] }> = [
  { dir: "x86_64-linux", files: ["libopentui.so"] },
  { dir: "aarch64-linux", files: ["libopentui.so"] },
  { dir: "x86_64-linux-musl", files: ["libopentui.so"] },
  { dir: "aarch64-linux-musl", files: ["libopentui.so"] },
  { dir: "x86_64-macos", files: ["libopentui.dylib"] },
  { dir: "aarch64-macos", files: ["libopentui.dylib"] },
  { dir: "x86_64-windows", files: ["opentui.dll", "opentui.pdb"] },
  { dir: "aarch64-windows", files: ["opentui.dll", "opentui.pdb"] },
]

interface BottleManifest {
  version: number
  hash: string
  zig: string
  optimize: string
  files: Record<string, string>
}

interface PackageOptions {
  hit: boolean
  all: boolean
  skipSymbols: boolean
  lib: boolean
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")
const nativeRoot = join(repoRoot, "packages", "native")
const coreDir = join(repoRoot, "packages", "core")
const libRoot = join(nativeRoot, "lib")

function absolute(root: string, relativePath: string): string {
  return join(root, ...relativePath.split("/"))
}

function assertZigVersion(version: string): void {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error(`Invalid Zig version: ${version}`)
}

function assertHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid native bottle hash")
}

function nativeInputFiles(root: string): string[] {
  const files: string[] = []
  const visit = (relativePath: string): void => {
    const path = absolute(root, relativePath)
    if (!existsSync(path)) throw new Error(`Missing native bottle input: ${relativePath}`)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`Native bottle input is a symlink: ${relativePath}`)
    if (stat.isFile()) {
      files.push(relativePath)
      return
    }
    if (!stat.isDirectory()) throw new Error(`Native bottle input is not a file or directory: ${relativePath}`)
    for (const entry of readdirSync(path).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
      visit(`${relativePath}/${entry}`)
    }
  }
  for (const input of INPUTS) visit(input)
  files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return files
}

function hashNativeInputs(root: string): string {
  const hash = createHash("sha256")
  for (const relativePath of nativeInputFiles(root)) {
    hash.update(relativePath)
    hash.update("\0")
    hash.update(readFileSync(absolute(root, relativePath)))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function bottleKey(hash: string, zigVersion: string): string {
  assertHash(hash)
  assertZigVersion(zigVersion)
  return `${KEY_PREFIX}-${hash}-${zigVersion}-${OPTIMIZE}-all`
}

function bottleLibraryPaths(): string[] {
  return BOTTLE_LIBRARIES.flatMap((library) => library.files.map((file) => `${library.dir}/${file}`))
}

function listFiles(root: string, relativePath = ""): string[] {
  const path = absolute(root, relativePath || ".")
  if (!existsSync(path)) return []
  const files: string[] = []
  for (const entry of readdirSync(path).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    const child = relativePath ? `${relativePath}/${entry}` : entry
    if (lstatSync(absolute(root, child)).isDirectory()) files.push(...listFiles(root, child))
    else files.push(child)
  }
  return files
}

function readManifest(root: string): BottleManifest {
  const path = join(root, MANIFEST_NAME)
  if (!existsSync(path)) throw new Error("Native bottle manifest is missing")
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Partial<BottleManifest>
  if (!manifest || typeof manifest !== "object" || !manifest.files) throw new Error("Native bottle manifest is invalid")
  return manifest as BottleManifest
}

function verifyBottle(root: string, zigVersion: string, inputsRoot: string): void {
  assertZigVersion(zigVersion)
  const manifest = readManifest(root)
  const hash = hashNativeInputs(inputsRoot)
  if (manifest.version !== BOTTLE_VERSION) throw new Error(`Unsupported native bottle version: ${manifest.version}`)
  if (manifest.hash !== hash) throw new Error("Native bottle hash does not match native inputs")
  if (manifest.zig !== zigVersion)
    throw new Error(`Native bottle Zig version is ${manifest.zig}, expected ${zigVersion}`)
  if (manifest.optimize !== OPTIMIZE) throw new Error(`Native bottle optimize mode is ${manifest.optimize}`)

  const expected = bottleLibraryPaths().sort()
  const listed = Object.keys(manifest.files).sort()
  if (listed.join("\n") !== expected.join("\n"))
    throw new Error("Native bottle manifest does not list the required libraries")

  for (const relativePath of expected) {
    const path = absolute(root, relativePath)
    if (!existsSync(path)) throw new Error(`Missing bottled library: ${relativePath}`)
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex")
    if (actual !== manifest.files[relativePath]) throw new Error(`Bottled library hash mismatch: ${relativePath}`)
  }

  for (const file of listFiles(root)) {
    if (file === MANIFEST_NAME) continue
    if (!expected.includes(file)) throw new Error(`Unexpected native bottle file: ${file}`)
  }
}

function stageBottle(root: string, zigVersion: string, inputsRoot: string): void {
  assertZigVersion(zigVersion)
  const hash = hashNativeInputs(inputsRoot)
  const files: Record<string, string> = {}
  const staged = mkdtempSync(join(tmpdir(), "opentui-native-bottle-"))
  try {
    for (const relativePath of bottleLibraryPaths()) {
      const source = absolute(root, relativePath)
      if (!existsSync(source)) throw new Error(`Missing native library: ${relativePath}`)
      const bytes = readFileSync(source)
      files[relativePath] = createHash("sha256").update(bytes).digest("hex")
      const destination = absolute(staged, relativePath)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, bytes)
    }
    const manifest: BottleManifest = {
      version: BOTTLE_VERSION,
      hash,
      zig: zigVersion,
      optimize: OPTIMIZE,
      files,
    }
    writeFileSync(join(staged, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)
    verifyBottle(staged, zigVersion, inputsRoot)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    for (const relativePath of [MANIFEST_NAME, ...bottleLibraryPaths()]) {
      const destination = absolute(root, relativePath)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, readFileSync(absolute(staged, relativePath)))
    }
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
}

function packagePlan(options: PackageOptions): string[][] {
  if (options.all && options.skipSymbols) throw new Error("The cross-compile bottle still separates symbols")
  const native = options.hit
    ? [
        "bun",
        "scripts/build.ts",
        "--native",
        "--skip-zig",
        ...(options.all ? ["--all"] : []),
        ...(options.skipSymbols ? ["--skip-symbols"] : []),
      ]
    : [
        "bun",
        "run",
        "build:native",
        ...(options.all ? ["--all"] : []),
        ...(options.skipSymbols ? ["--skip-symbols"] : []),
      ]
  return options.lib ? [native, ["bun", "run", "build:lib"]] : [native]
}

function runPackage(options: PackageOptions): void {
  console.error(options.hit ? "Using native bottle; skipping the Zig build" : "Native bottle miss; building")
  if (options.hit) verifyBottle(libRoot, readRequiredFlag("--zig"), nativeRoot)
  for (const command of packagePlan(options)) {
    const result = spawnSync(command[0] ?? "bun", command.slice(1), { cwd: coreDir, stdio: "inherit" })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

function readRequiredFlag(name: string): string {
  const value = readFlag(name)
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function readBoolean(name: string, fallback = false): boolean {
  const value = readFlag(name)
  if (value === undefined) return fallback
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`${name} must be true or false`)
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function main(): void {
  const command = process.argv[2]
  if (command === "hash") {
    process.stdout.write(`${hashNativeInputs(nativeRoot)}\n`)
    return
  }
  if (command === "key") {
    process.stdout.write(`${bottleKey(hashNativeInputs(nativeRoot), readRequiredFlag("--zig"))}\n`)
    return
  }
  if (command === "verify") {
    verifyBottle(libRoot, readRequiredFlag("--zig"), nativeRoot)
    return
  }
  if (command === "stage") {
    stageBottle(libRoot, readRequiredFlag("--zig"), nativeRoot)
    return
  }
  if (command === "package") {
    runPackage({
      hit: readBoolean("--hit"),
      all: hasFlag("--all"),
      skipSymbols: hasFlag("--skip-symbols"),
      lib: hasFlag("--lib"),
    })
    return
  }
  throw new Error("Usage: native-bottle.ts <hash|key|verify|stage|package>")
}

const entry = process.argv[1]
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
