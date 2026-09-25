import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, join, relative } from "node:path"

interface SymbolOptions {
  binary: string
  symbolsDir: string
  platform: string
  target: string
  abi?: string
  version: string
  commit: string
  pdb?: string
  buildDir?: string
}

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
}

// Cross-target ELF/COFF tools on macOS come from Homebrew LLVM. Native Linux
// builds use binutils, so local development needs no additional toolchain.
function tool(name: string): string {
  return process.env.LLVM_BIN
    ? join(process.env.LLVM_BIN, `llvm-${name}`)
    : process.platform === "win32"
      ? `llvm-${name}`
      : name
}

function requireMatch(text: string, pattern: RegExp, description: string): string {
  const value = pattern.exec(text)?.[1]
  if (!value) throw new Error(`Missing ${description}`)
  return value.toLowerCase()
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function symbolFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? symbolFiles(path) : [path]
    })
    .sort()
}

export function separateNativeSymbols(options: SymbolOptions) {
  const { binary, symbolsDir, platform, target, version, commit } = options
  rmSync(symbolsDir, { recursive: true, force: true })
  mkdirSync(symbolsDir, { recursive: true })
  let binaryIdentity: string
  let identityKind: string

  if (platform === "linux") {
    const elf = (...args: string[]) => run(tool("readelf"), args)
    const sections = elf("-SW", binary)
    if (!sections.includes(".debug_info")) throw new Error(`No release DWARF in ${binary}`)
    binaryIdentity = requireMatch(elf("-n", binary), /Build ID:\s*([a-f0-9]+)/i, "ELF build ID")
    identityKind = "elf-build-id"
    const exports = run(tool("nm"), ["-D", "--defined-only", binary])
    const debug = join(symbolsDir, `${basename(binary)}.debug`)
    run(tool("objcopy"), ["--only-keep-debug", binary, debug])
    run(tool("objcopy"), ["--strip-unneeded", binary])
    run(tool("objcopy"), [`--add-gnu-debuglink=${debug}`, binary])
    if (
      binaryIdentity !== requireMatch(elf("-n", debug), /Build ID:\s*([a-f0-9]+)/i, "debug build ID") ||
      binaryIdentity !== requireMatch(elf("-n", binary), /Build ID:\s*([a-f0-9]+)/i, "stripped build ID")
    ) {
      throw new Error("ELF symbol identity changed")
    }
    const stripped = elf("-SW", binary)
    if (/\s\.(?:z)?debug(?:_|\s)|\s\.symtab\s/.test(stripped) || !stripped.includes(".gnu_debuglink")) {
      throw new Error("ELF distribution copy was not stripped/debug-linked")
    }
    if (exports !== run(tool("nm"), ["-D", "--defined-only", binary])) throw new Error("ELF exports changed")
    if (sections.includes(".eh_frame") && !stripped.includes(".eh_frame")) throw new Error("ELF unwind data lost")
  } else if (platform === "darwin") {
    const uuid = (path: string) =>
      requireMatch(run("xcrun", ["dwarfdump", "--uuid", path]), /UUID:\s*([A-F0-9-]+)/i, "Mach-O UUID")
    binaryIdentity = uuid(binary)
    identityKind = "mach-o-uuid"
    const exports = run("xcrun", ["nm", "-g", "-U", "-j", binary])
    const dsym = join(symbolsDir, `${basename(binary)}.dSYM`)
    run("xcrun", ["dsymutil", binary, "-o", dsym], options.buildDir)
    const dwarf = join(dsym, "Contents", "Resources", "DWARF", basename(binary))
    if (!run("xcrun", ["dwarfdump", "--name=getBuildOptions", dwarf]).includes("DW_TAG_subprogram")) {
      throw new Error("dSYM cannot resolve the native getBuildOptions function")
    }
    run("xcrun", ["strip", "-S", "-x", binary])
    if (uuid(dwarf) !== binaryIdentity || uuid(binary) !== binaryIdentity)
      throw new Error("Mach-O symbol identity changed")
    if (exports !== run("xcrun", ["nm", "-g", "-U", "-j", binary])) throw new Error("Mach-O exports changed")
  } else if (platform === "win32") {
    if (!options.pdb) throw new Error("Missing release PDB path")
    const readobj = run(tool("readobj"), ["--coff-debug-directory", "--sections", "--file-headers", binary])
    const guid = requireMatch(readobj, /PDBGUID:\s*\{?([a-f0-9-]+)/i, "DLL PDB GUID")
    const age = requireMatch(readobj, /PDBAge:\s*(\d+)/, "DLL PDB age")
    const pdb = join(symbolsDir, basename(options.pdb))
    copyFileSync(options.pdb, pdb)
    const summary = run(tool("pdbutil"), ["dump", "-summary", pdb])
    if (
      guid !== requireMatch(summary, /GUID:\s*\{?([a-f0-9-]+)/i, "PDB GUID") ||
      age !== requireMatch(summary, /Age:\s*(\d+)/, "PDB age") ||
      !/Has Debug Info:\s*true/.test(summary)
    )
      throw new Error("PDB does not match the distributed DLL")
    // The linker already puts CodeView information in the PDB, not in the
    // DLL. Stripping the PE debug directory would destroy its matching key.
    if (/Name:\s*\.debug/.test(readobj) || !/SymbolCount:\s*0\b/.test(readobj)) {
      throw new Error("DLL still contains embedded debug/static symbols")
    }
    identityKind = "pdb-guid-age"
    binaryIdentity = `${guid}/${age}`
  } else {
    throw new Error(`Unsupported symbol platform: ${platform}`)
  }

  const manifest = {
    version,
    target,
    abi: options.abi ?? null,
    commit,
    optimization: "ReleaseFast",
    binary: basename(binary),
    identityKind,
    binaryIdentity,
    // Authenticode signing happens later. The PDB identity, unlike this hash,
    // identifies the same code both before and after signing.
    preSigningSha256: sha256(binary),
    symbols: symbolFiles(symbolsDir).map((path) => ({ path: relative(symbolsDir, path), sha256: sha256(path) })),
  }
  writeFileSync(join(symbolsDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  return manifest
}
