import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, normalize, resolve } from "node:path"
import process from "node:process"
import { gunzipSync } from "node:zlib"
import { RELEASE_PACKAGES } from "../../../../scripts/npm-publish"
import { compareVersions } from "../../src/lib/api-history"

// Reads published @opentui packages from the npm registry. Each tarball is reduced to its package.json
// and declaration files, which is all the extractor reads, and cached by name and version.

export const PACKAGES = RELEASE_PACKAGES.map((releasePackage) => releasePackage.name)

export const CACHE_DIR = resolve(import.meta.dirname, "../../node_modules/.cache/opentui-api")

const registry = (process.env.npm_config_registry ?? "https://registry.npmjs.org").replace(/\/+$/, "")
const STABLE = /^\d+\.\d+\.\d+$/

export interface PublishedVersion {
  version: string
  tarball: string
}

function packageUrl(name: string): string {
  return `${registry}/${name.replace("/", "%2f")}`
}

function cacheName(name: string): string {
  return name.replace("/", "+")
}

// The stable versions of a package. Snapshots (`0.0.0-…`) and prereleases are not releases.
export async function publishedVersions(name: string): Promise<PublishedVersion[]> {
  const path = join(CACHE_DIR, "registry", `${cacheName(name)}.json`)
  let metadata: { versions?: Record<string, { dist?: { tarball?: string } }> }
  try {
    const response = await fetch(packageUrl(name), { headers: { accept: "application/vnd.npm.install-v1+json" } })
    if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${name}`)
    metadata = (await response.json()) as typeof metadata
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(metadata))
  } catch (error) {
    if (!existsSync(path)) throw error
    console.error(`Using cached registry metadata for ${name}: ${error instanceof Error ? error.message : error}`)
    metadata = JSON.parse(await readFile(path, "utf8")) as typeof metadata
  }
  return Object.entries(metadata.versions ?? {})
    .filter(([version, manifest]) => STABLE.test(version) && manifest.dist?.tarball)
    .map(([version, manifest]) => ({ version, tarball: manifest.dist!.tarball! }))
}

// The version of a package that a lockstep release holds: the same version, or, when the package skipped
// it but was published before and after it, the previous version. Undefined when the package was not
// published yet, or no longer is.
export function packageVersionFor(published: string[], version: string): string | undefined {
  if (published.includes(version)) return version
  const earlier = published.filter((item) => compareVersions(item, version) < 0).sort(compareVersions)
  const later = published.some((item) => compareVersions(item, version) > 0)
  return later ? earlier.at(-1) : undefined
}

// The directory that holds package.json and the declaration files of one published version.
export async function packageDir(name: string, published: PublishedVersion): Promise<string> {
  const dir = join(CACHE_DIR, "packages", `${cacheName(name)}@${published.version}`)
  if (existsSync(join(dir, ".complete"))) return dir
  const response = await fetch(published.tarball)
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${published.tarball}`)
  const files = readTar(gunzipSync(new Uint8Array(await response.arrayBuffer())))
  const temporary = `${dir}.tmp-${process.pid}`
  await rm(temporary, { recursive: true, force: true })
  for (const [path, data] of files) {
    // npm tarballs put every file under one top-level directory, usually `package/`.
    const relativePath = normalize(path.slice(path.indexOf("/") + 1))
    if (relativePath.startsWith("..") || relativePath.startsWith("/")) continue
    if (relativePath !== "package.json" && !/\.d\.[cm]?ts$/.test(relativePath)) continue
    await mkdir(dirname(join(temporary, relativePath)), { recursive: true })
    await writeFile(join(temporary, relativePath), data)
  }
  if (!existsSync(join(temporary, "package.json"))) throw new Error(`${name}@${published.version} has no package.json`)
  await writeFile(join(temporary, ".complete"), "")
  await rm(dir, { recursive: true, force: true })
  await rename(temporary, dir)
  return dir
}

// A minimal ustar reader with the pax and GNU long-name extensions.
export function readTar(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const decoder = new TextDecoder()
  const text = (start: number, length: number): string => {
    const bytes = archive.subarray(start, start + length)
    const end = bytes.indexOf(0)
    return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end))
  }
  let offset = 0
  let longName: string | undefined
  while (offset + 512 <= archive.length) {
    if (archive.subarray(offset, offset + 512).every((byte) => byte === 0)) break
    const size = parseInt(text(offset + 124, 12).trim() || "0", 8)
    const type = String.fromCharCode(archive[offset + 156]!)
    const prefix = text(offset + 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${text(offset, 100)}` : text(offset, 100))
    longName = undefined
    const data = archive.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === "L") longName = text(offset - Math.ceil(size / 512) * 512, size)
    else if (type === "x") {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(data))
      if (path) longName = path[1]
    } else if (type === "0" || type === "\0" || type === "7") files.set(name, data)
  }
  return files
}
