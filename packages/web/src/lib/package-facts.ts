import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { variants, type Variant } from "../../../core/scripts/variants"

export interface PlatformFact {
  os: "linux" | "macos" | "windows"
  architecture: "x86_64" | "aarch64"
  abi?: "gnu" | "musl"
  minimumOsVersion?: string
}

export interface ZigFact {
  name: string
  version: string
  minimumZigVersion: string
}

export interface PackageFacts {
  id: string
  version: string
  license: string
  entrypoints: string[]
  platformPackages?: string[]
  platforms?: PlatformFact[]
  zig?: ZigFact
}

export interface PackageManifest {
  name?: unknown
  version?: unknown
  license?: unknown
  exports?: unknown
  optionalDependencies?: unknown
}

export function extractEntrypoints(exportsMap: unknown): string[] {
  if (typeof exportsMap === "string" || Array.isArray(exportsMap)) return ["."]
  if (!exportsMap || typeof exportsMap !== "object") return []

  const keys = Object.keys(exportsMap)
  const entrypoints = keys.filter((key) => key === "." || key.startsWith("./"))
  return entrypoints.length > 0 ? entrypoints : ["."]
}

export function matchPlatformPackages(
  packageName: string,
  optionalDependencies: unknown,
  nativeVariants: readonly Variant[],
): string[] {
  if (!optionalDependencies || typeof optionalDependencies !== "object") return []

  return nativeVariants
    .map(({ platform, arch, abi }) => `${packageName}-${platform}-${arch}${abi ? `-${abi}` : ""}`)
    .filter((name) => Object.hasOwn(optionalDependencies, name))
}

export function normalizePlatform({ platform, arch, abi }: Variant): PlatformFact {
  const osByPlatform: Record<string, PlatformFact["os"] | undefined> = {
    darwin: "macos",
    linux: "linux",
    win32: "windows",
  }
  const architectureByArch: Record<string, PlatformFact["architecture"] | undefined> = {
    x64: "x86_64",
    arm64: "aarch64",
  }
  const os = osByPlatform[platform]
  const architecture = architectureByArch[arch]

  if (!os || !architecture) throw new Error(`Unsupported native variant: ${platform}-${arch}`)
  if (abi && abi !== "musl") throw new Error(`Unsupported native ABI: ${abi}`)
  const normalizedAbi: PlatformFact["abi"] = abi === "musl" ? "musl" : "gnu"

  return {
    os,
    architecture,
    ...(platform === "linux" ? { abi: normalizedAbi } : {}),
  }
}

export function extractZigMetadata(source: string): ZigFact {
  const name = source.match(/^\s*\.name\s*=\s*\.(\w+)\s*,/m)?.[1]
  const version = source.match(/^\s*\.version\s*=\s*"([^"]+)"\s*,/m)?.[1]
  const minimumZigVersion = source.match(/^\s*\.minimum_zig_version\s*=\s*"([^"]+)"\s*,/m)?.[1]

  if (!name || !version || !minimumZigVersion) throw new Error("Invalid core build.zig.zon metadata")
  return { name, version, minimumZigVersion }
}

export async function loadFirstPartyPackageFacts(repoRoot = findRepoRoot()): Promise<PackageFacts[]> {
  const packagesRoot = join(repoRoot, "packages")
  const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const facts = await Promise.all(
    packageDirectories.map(async (directory): Promise<PackageFacts | undefined> => {
      let manifest: PackageManifest
      try {
        manifest = JSON.parse(await readFile(join(packagesRoot, directory, "package.json"), "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }

      if (
        typeof manifest.name !== "string" ||
        !manifest.name.startsWith("@opentui/") ||
        typeof manifest.version !== "string" ||
        typeof manifest.license !== "string"
      ) {
        return undefined
      }

      const packageFacts: PackageFacts = {
        id: `opentui-${manifest.name.slice("@opentui/".length)}`,
        version: manifest.version,
        license: manifest.license,
        entrypoints: extractEntrypoints(manifest.exports),
      }

      if (manifest.name === "@opentui/core") {
        packageFacts.platformPackages = matchPlatformPackages(manifest.name, manifest.optionalDependencies, variants)
        packageFacts.platforms = variants.map(normalizePlatform)
        packageFacts.zig = extractZigMetadata(await readFile(join(packagesRoot, "native", "build.zig.zon"), "utf8"))
      }

      return packageFacts
    }),
  )

  return facts.filter((fact): fact is PackageFacts => fact !== undefined)
}

function findRepoRoot(): string {
  const candidates = [resolve(process.cwd()), resolve(process.cwd(), "../..")]
  const root = candidates.find((candidate) => existsSync(join(candidate, "packages/core/package.json")))
  if (!root) throw new Error(`Could not find the OpenTUI repository from ${process.cwd()}`)
  return root
}
