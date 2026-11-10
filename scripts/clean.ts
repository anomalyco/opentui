import { existsSync, readdirSync, rmSync, statSync, type Dirent } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

interface Flags {
  help: boolean
  dryRun: boolean
  verbose: boolean
  lib: boolean
  native: boolean
  caches: boolean
  deps: boolean
  all: boolean
}

interface CleanTarget {
  path: string
  category: string
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const packagesDir = join(rootDir, "packages")

const HELP = `bun run clean [options]

Removes build artifacts from the OpenTUI workspace.

Scopes (combine freely; if none given, lib + native + caches are cleaned):
  --lib        Library outputs: packages/*/dist, *.tsbuildinfo, *.tgz, out/, packed/
  --native     Native (Zig) artifacts under packages/native,
               and prebuilt @opentui/core-<platform>-<arch> in node_modules
  --caches     Caches & coverage: .cache/, coverage/, *.lcov
  --deps       node_modules in the root and every package (full reset)
  --all        Same as --lib --native --caches --deps

Modifiers:
  -n, --dry-run   Print what would be removed without removing anything
  -v, --verbose   Print every path (default: collapse long lists)
  -h, --help      Show this help
`

function parseFlags(argv: string[]): Flags {
  const has = (...names: string[]) => names.some((n) => argv.includes(n))
  return {
    help: has("--help", "-h"),
    dryRun: has("--dry-run", "-n"),
    verbose: has("--verbose", "-v"),
    lib: has("--lib"),
    native: has("--native"),
    caches: has("--caches"),
    deps: has("--deps"),
    all: has("--all"),
  }
}

function safeReaddir(p: string): Dirent[] {
  try {
    return readdirSync(p, { withFileTypes: true })
  } catch {
    return []
  }
}

function findPackageDirs(): string[] {
  return safeReaddir(packagesDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
}

// Recursing into node_modules to sum file sizes is far too slow to be useful here.
// Returning -1 lets the formatter render "?" so the user still sees the path.
function getPathSize(path: string): number {
  if (basename(path) === "node_modules") return -1
  try {
    const stat = statSync(path)
    if (stat.isFile() || stat.isSymbolicLink()) return stat.size
    let size = 0
    for (const entry of safeReaddir(path)) {
      const sub = join(path, entry.name)
      try {
        const subStat = statSync(sub)
        if (subStat.isDirectory()) size += getPathSize(sub)
        else size += subStat.size
      } catch {
        // ignore broken symlinks etc.
      }
    }
    return size
  } catch {
    return 0
  }
}

function formatSize(bytes: number): string {
  if (bytes < 0) return "?"
  if (bytes === 0) return "0B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  const decimals = i > 0 && n < 100 ? 1 : 0
  return `${n.toFixed(decimals)}${units[i]}`
}

function collectTargets(flags: Flags): CleanTarget[] {
  const noScope = !flags.lib && !flags.native && !flags.caches && !flags.deps && !flags.all
  const wantLib = flags.lib || flags.all || noScope
  const wantNative = flags.native || flags.all || noScope
  const wantCaches = flags.caches || flags.all || noScope
  const wantDeps = flags.deps || flags.all

  const packageDirs = findPackageDirs()
  const allRoots = [rootDir, ...packageDirs]
  const targets: CleanTarget[] = []
  const add = (path: string, category: string) => {
    if (existsSync(path)) targets.push({ path, category })
  }

  if (wantLib) {
    for (const dir of allRoots) {
      add(join(dir, "dist"), "build output")
      add(join(dir, "out"), "build output")
      add(join(dir, "packed"), "packed output")

      for (const entry of safeReaddir(dir)) {
        if (!entry.isFile()) continue
        if (entry.name.endsWith(".tsbuildinfo")) add(join(dir, entry.name), "tsbuildinfo")
        else if (entry.name.endsWith(".tgz")) add(join(dir, entry.name), "packed archive")
      }
    }
  }

  if (wantNative) {
    const zigDir = join(packagesDir, "native")
    add(join(zigDir, ".zig-cache"), "zig cache")
    add(join(zigDir, "zig-out"), "zig build output")
    add(join(zigDir, "lib"), "zig prebuilt libs")
    add(join(zigDir, "zig-pkg"), "zig dependencies")
    add(join(zigDir, "examples", "hello", ".zig-cache"), "zig cache")
    add(join(zigDir, "examples", "hello", "zig-out"), "zig build output")
    add(join(zigDir, "examples", "hello", "zig-pkg"), "zig dependencies")

    const legacyZigDir = join(packagesDir, "core", "src", "zig")
    add(join(legacyZigDir, ".zig-cache"), "zig cache")
    add(join(legacyZigDir, "zig-out"), "zig build output")
    add(join(legacyZigDir, "lib"), "zig prebuilt libs")
    add(join(legacyZigDir, "zig-pkg"), "zig dependencies")

    const coreOpentui = join(packagesDir, "core", "node_modules", "@opentui")
    for (const entry of safeReaddir(coreOpentui)) {
      if (entry.isDirectory() && /^core-(darwin|linux|win32)-(x64|arm64)(?:-musl)?$/.test(entry.name)) {
        add(join(coreOpentui, entry.name), "prebuilt native package")
      }
    }
  }

  if (wantCaches) {
    for (const dir of allRoots) {
      add(join(dir, ".cache"), "cache")
      add(join(dir, "coverage"), "coverage")
      for (const entry of safeReaddir(dir)) {
        if (entry.isFile() && entry.name.endsWith(".lcov")) {
          add(join(dir, entry.name), "lcov coverage")
        }
      }
    }
  }

  if (wantDeps) {
    for (const dir of allRoots) {
      add(join(dir, "node_modules"), "node_modules")
    }
  }

  return targets
}

function printPlan(targets: CleanTarget[], flags: Flags): number {
  const grouped = new Map<string, CleanTarget[]>()
  for (const t of targets) {
    const list = grouped.get(t.category)
    if (list) list.push(t)
    else grouped.set(t.category, [t])
  }

  let totalSize = 0
  let hasUnknown = false
  console.log(flags.dryRun ? "Would remove:" : "Removing:")
  for (const [category, items] of grouped) {
    const sized = items.map((t) => ({ ...t, size: getPathSize(t.path) }))
    let groupSize = 0
    let groupHasUnknown = false
    for (const t of sized) {
      if (t.size < 0) groupHasUnknown = true
      else groupSize += t.size
    }
    totalSize += groupSize
    if (groupHasUnknown) hasUnknown = true

    const groupSizeLabel = groupHasUnknown
      ? groupSize === 0
        ? "?"
        : `${formatSize(groupSize)}+`
      : formatSize(groupSize)
    console.log(`\n  ${category}  (${items.length} item${items.length === 1 ? "" : "s"}, ${groupSizeLabel})`)

    const showAll = flags.verbose || sized.length <= 10
    const visible = showAll ? sized : sized.slice(0, 10)
    for (const t of visible) {
      const rel = relative(rootDir, t.path) || "."
      console.log(`    ${rel}  (${formatSize(t.size)})`)
    }
    if (!showAll) {
      console.log(`    ...and ${sized.length - 10} more (use --verbose to see all)`)
    }
  }

  const totalLabel = hasUnknown ? (totalSize === 0 ? "?" : `${formatSize(totalSize)}+`) : formatSize(totalSize)
  console.log(`\nTotal: ${targets.length} item(s), ${totalLabel}`)
  return totalSize
}

function removeAll(targets: CleanTarget[]): { removed: number; failed: { path: string; error: string }[] } {
  let removed = 0
  const failed: { path: string; error: string }[] = []
  for (const t of targets) {
    try {
      rmSync(t.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      removed++
    } catch (err) {
      failed.push({ path: t.path, error: (err as Error).message })
    }
  }
  return { removed, failed }
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2))

  if (flags.help) {
    console.log(HELP)
    process.exit(0)
  }

  const targets = collectTargets(flags)
  if (targets.length === 0) {
    console.log("Nothing to clean.")
    process.exit(0)
  }

  printPlan(targets, flags)

  if (flags.dryRun) {
    console.log("\n(dry run - nothing removed)")
    process.exit(0)
  }

  const { removed, failed } = removeAll(targets)

  if (failed.length > 0) {
    console.error(`\nFailed to remove ${failed.length} item(s):`)
    for (const f of failed) {
      console.error(`  ${relative(rootDir, f.path) || f.path}: ${f.error}`)
    }
    console.log(`\nRemoved ${removed}/${targets.length} item(s).`)
    process.exit(1)
  }

  console.log(`\nDone. Removed ${removed} item(s).`)
}

main()
