import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

// Publishes release packages to npm, dependencies first: core's native packages, then core, then the
// packages that depend on it. An install then never sees core without its native packages.
//
// A rerun of a failed release skips each version that npm already has with identical contents, and
// fails if npm has different contents for it. Contents are compared by the integrity of the tarball
// that `npm pack` builds, which is the tarball that `npm publish` uploads.

export interface ReleasePackage {
  name: string
  rootDir: string
  distDir: string
  requiresCore?: boolean
}

interface PackageJson {
  name: string
  version: string
  optionalDependencies?: Record<string, string>
}

export type PublishedState = "missing" | "identical" | "different"

const SERVED_TIMEOUT_MS = 10 * 60_000
const SERVED_POLL_MS = 10_000

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const registry = (process.env.npm_config_registry ?? "https://registry.npmjs.org").replace(/\/+$/, "")

function releasePackage(directory: string, name: string, requiresCore?: boolean): ReleasePackage {
  const rootDir = join(repoRoot, "packages", directory)
  return { name, rootDir, distDir: join(rootDir, "dist"), requiresCore }
}

// Release order. React and Solid come before qrcode and keymap, which list them as peers.
export const RELEASE_PACKAGES: readonly ReleasePackage[] = [
  releasePackage("core", "@opentui/core"),
  releasePackage("react", "@opentui/react", true),
  releasePackage("solid", "@opentui/solid", true),
  releasePackage("three", "@opentui/three", true),
  releasePackage("qrcode", "@opentui/qrcode", true),
  releasePackage("keymap", "@opentui/keymap", true),
  releasePackage("ssh", "@opentui/ssh"),
]

export function readPackageJson(directory: string): PackageJson {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as PackageJson
}

export function coreNativeDirs(): string[] {
  const core = RELEASE_PACKAGES[0]!
  const optional = readPackageJson(core.distDir).optionalDependencies ?? {}
  return Object.keys(optional)
    .filter((name) => name.startsWith(`${core.name}-`))
    .map((name) => join(core.rootDir, "node_modules", name))
}

// The directories to publish, in order. Publishing core publishes its native packages first.
export function publishDirs(names: readonly string[] = []): string[] {
  const unknown = names.filter((name) => !RELEASE_PACKAGES.some((pkg) => pkg.name === name))
  if (unknown.length > 0) throw new Error(`Not a release package: ${unknown.join(", ")}`)
  return RELEASE_PACKAGES.filter((pkg) => names.length === 0 || names.includes(pkg.name)).flatMap((pkg) =>
    pkg === RELEASE_PACKAGES[0] ? [...coreNativeDirs(), pkg.distDir] : [pkg.distDir],
  )
}

function isSnapshotVersion(version: string): boolean {
  return version.includes("-snapshot") || /^0\.0\.0-\d{8}-[a-f0-9]{8}$/.test(version)
}

function packageUrl(name: string): string {
  return `${registry}/${name.replace("/", "%2f")}`
}

export function localIntegrity(directory: string): string {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: directory, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`npm pack failed in ${directory}:\n${result.stderr}`)
  const integrity = (JSON.parse(result.stdout) as Array<{ integrity?: string }>)[0]?.integrity
  if (!integrity) throw new Error(`npm pack reported no integrity for ${directory}`)
  return integrity
}

async function registryIntegrity(name: string, version: string): Promise<string | undefined> {
  const response = await fetch(`${packageUrl(name)}/${version}`, { headers: { accept: "application/json" } })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${name}@${version}`)
  const integrity = ((await response.json()) as { dist?: { integrity?: string } }).dist?.integrity
  if (!integrity) throw new Error(`npm registry has no integrity for ${name}@${version}`)
  return integrity
}

export async function publishedState(directory: string): Promise<PublishedState> {
  const { name, version } = readPackageJson(directory)
  const remote = await registryIntegrity(name, version)
  if (remote === undefined) return "missing"
  return remote === localIntegrity(directory) ? "identical" : "different"
}

export async function publishPackage(directory: string): Promise<void> {
  const { name, version } = readPackageJson(directory)
  const state = await publishedState(directory)
  if (state === "identical") {
    console.log(`${name}@${version} is already on npm with identical contents; skipping`)
    return
  }
  if (state === "different") throw new Error(`${name}@${version} is already on npm with different contents`)

  const args = ["publish", "--access=public", ...(isSnapshotVersion(version) ? ["--tag", "snapshot"] : [])]
  console.log(`\nPublishing ${name}@${version}${isSnapshotVersion(version) ? " (--tag snapshot)" : ""}...`)
  const result = spawnSync("npm", args, { cwd: directory, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`Failed to publish ${name}@${version}`)
  console.log(`Successfully published ${name}@${version}`)
}

// Installers read the abbreviated metadata. The registry can serve it without a new version for
// minutes after `npm publish` succeeds.
async function servedState(
  name: string,
  version: string,
  integrity: string,
): Promise<"served" | "pending" | "different"> {
  try {
    const response = await fetch(packageUrl(name), { headers: { accept: "application/vnd.npm.install-v1+json" } })
    if (!response.ok) return "pending"
    const metadata = (await response.json()) as {
      versions?: Record<string, { dist?: { integrity?: string; tarball?: string } }>
    }
    const dist = metadata.versions?.[version]?.dist
    if (!dist?.tarball) return "pending"
    if (dist.integrity !== integrity) return "different"
    return (await fetch(dist.tarball, { method: "HEAD" })).ok ? "served" : "pending"
  } catch (error) {
    console.error(`Checking ${name}@${version} failed: ${error instanceof Error ? error.message : error}`)
    return "pending"
  }
}

export async function waitUntilServed(directories: readonly string[]): Promise<void> {
  const pending = new Map(
    directories.map((directory) => {
      const { name, version } = readPackageJson(directory)
      return [`${name}@${version}`, { name, version, integrity: localIntegrity(directory) }] as const
    }),
  )
  console.log(`\nWaiting until npm serves ${pending.size} packages...`)
  const start = Date.now()
  while (true) {
    for (const [id, { name, version, integrity }] of pending) {
      const state = await servedState(name, version, integrity)
      if (state === "different") throw new Error(`npm serves ${id} with different contents`)
      if (state === "served") {
        pending.delete(id)
        console.log(`npm serves ${id} after ${Math.round((Date.now() - start) / 1000)}s`)
      }
    }
    if (pending.size === 0) return
    if (Date.now() - start > SERVED_TIMEOUT_MS) {
      throw new Error(`npm does not serve ${[...pending.keys()].join(", ")} after ${SERVED_TIMEOUT_MS / 1000}s`)
    }
    await sleep(SERVED_POLL_MS)
  }
}

async function main(): Promise<void> {
  const [command, ...names] = process.argv.slice(2)
  if (command === "publish") {
    for (const directory of publishDirs(names)) await publishPackage(directory)
    return
  }
  if (command === "wait") {
    await waitUntilServed(publishDirs(names))
    return
  }
  throw new Error("Usage: npm-publish.ts <publish|wait> [package...]")
}

const entry = process.argv[1]
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
