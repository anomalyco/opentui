#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"
import ts from "typescript"
import {
  C_MODULE,
  checkApiFiles,
  compareText,
  compareVersions,
  diffFeatures,
  formatApiFile,
  isApiVersion,
  loadApiHistory,
  parseApiFile,
} from "../src/lib/api-history"
import { extractPackage } from "./api/extract"
import { headerFeaturesAt, headerFeaturesIn } from "./api/header"
import { CACHE_DIR, PACKAGES, packageDir, packageVersionFor, publishedVersions, type PublishedVersion } from "./api/npm"
import { emitDeclarations } from "./api/source"

const repoRoot = resolve(import.meta.dirname, "../../..")
const USAGE = `Usage: bun packages/web/scripts/api.ts <command> [options]

  backfill [--from <version>] [--to <version>] [--dir <dir>]
      Write <dir>/<version>.txt for each published stable version from the npm tarballs and its v<version> tag.
  squash <version> [--dir <dir>]
      Start the history at a version: make its file a snapshot of its API and remove the files of older releases.
  current [--out <file>] [--root <dir>]
      Print the API features of the source tree.
  diff [--base <version>] [--out <file>] [--dir <dir>] [--root <dir>]
      Print the API file that a release of the source tree would add.
  release <version> [--base <version>] [--dir <dir>] [--root <dir>]
      Write <dir>/<version>.txt for the source tree, relative to the latest API file.
  verify <version> [--dir <dir>]
      Compare the API that the files record for a release with its packages on npm.
  check [--dir <dir>]
      Validate the API files.

<dir> defaults to api/ at the repository root.`

// Extraction results are cached per package version and extractor, so a rerun only extracts new versions.
const FINGERPRINT = createHash("sha256")
  .update(readFileSync(join(import.meta.dirname, "api", "extract.ts")))
  .update(readFileSync(join(import.meta.dirname, "..", "src", "lib", "api-history.ts")))
  .update(ts.version)
  .digest("hex")
  .slice(0, 16)

interface Options {
  positional: string[]
  values: Map<string, string>
}

function parseOptions(args: string[], allowed: string[]): Options {
  const options: Options = { positional: [], values: new Map() }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith("--")) {
      options.positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    const value = args[++index]
    if (!allowed.includes(name)) throw new Error(`Unknown option ${arg}\n\n${USAGE}`)
    if (value === undefined || value.startsWith("--")) throw new Error(`Option ${arg} needs a value`)
    options.values.set(name, value)
  }
  return options
}

function versionOption(options: Options, name: string): string | undefined {
  const value = options.values.get(name)
  if (value !== undefined && !isApiVersion(value)) throw new Error(`--${name} must be an x.y.z version: ${value}`)
  return value
}

function apiDir(options: Options): string {
  return resolve(options.values.get("dir") ?? join(repoRoot, "api"))
}

function textLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n")
}

async function output(text: string, file: string | undefined): Promise<void> {
  if (file === undefined) process.stdout.write(text)
  else await writeFile(resolve(file), text)
}

async function apiFiles(dir: string): Promise<Array<{ version: string; text: string }>> {
  const names = existsSync(dir) ? await readdir(dir) : []
  return Promise.all(
    names
      .filter((name) => name.endsWith(".txt"))
      .map(async (name) => ({ version: name.slice(0, -4), text: await readFile(join(dir, name), "utf8") })),
  )
}

async function publishedFeatures(name: string, published: PublishedVersion): Promise<string[]> {
  const file = join(CACHE_DIR, "features", FINGERPRINT, `${name.replace("/", "+")}@${published.version}.txt`)
  if (existsSync(file)) return textLines(await readFile(file, "utf8"))
  const { features, warnings } = extractPackage(await packageDir(name, published))
  for (const warning of warnings) console.error(`warning: ${name}@${published.version}: ${warning}`)
  await mkdir(join(file, ".."), { recursive: true })
  await writeFile(file, features.map((line) => `${line}\n`).join(""))
  return features
}

async function pool<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await run(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

async function backfill(options: Options): Promise<void> {
  const start = performance.now()
  const dir = apiDir(options)
  // The history starts at its oldest file, a snapshot (see squash). Older versions have no base to be written
  // from.
  const existing = await apiFiles(dir)
  const oldest = existing.map((file) => file.version).sort(compareVersions)[0]
  const from = versionOption(options, "from") ?? oldest
  const to = versionOption(options, "to")
  if (from !== undefined && oldest !== undefined && compareVersions(from, oldest) < 0) {
    throw new Error(`The history starts at ${oldest}; backfill cannot write ${from}`)
  }
  const published = new Map<string, PublishedVersion[]>()
  for (const name of PACKAGES) {
    published.set(
      name,
      (await publishedVersions(name)).sort((a, b) => compareVersions(a.version, b.version)),
    )
  }
  const versions = [...new Set([...published.values()].flat().map((item) => item.version))].sort(compareVersions)
  const selected = versions.filter(
    (version) =>
      (from === undefined || compareVersions(version, from) >= 0) &&
      (to === undefined || compareVersions(version, to) <= 0),
  )
  if (selected.length === 0) throw new Error("No published versions in the range")
  const first = versions.indexOf(selected[0]!)
  // The version before the range is the base of its first file, unless that file is the snapshot that starts
  // the history.
  const snapshot = existing.some(
    (file) => file.version === selected[0] && parseApiFile(file.version, file.text).base === null,
  )
  const needed = versions.slice(snapshot ? first : Math.max(0, first - 1), first + selected.length)

  // Each version holds every package at that version. A package that skipped the version but was
  // published before and after it keeps its previous features.
  const plan = new Map<string, Array<{ name: string; published: PublishedVersion }>>()
  const jobs = new Map<string, { name: string; published: PublishedVersion }>()
  for (const version of needed) {
    const parts = []
    for (const [name, list] of published) {
      const packageVersion = packageVersionFor(
        list.map((item) => item.version),
        version,
      )
      if (packageVersion === undefined) continue
      const job = { name, published: list.find((item) => item.version === packageVersion)! }
      jobs.set(`${name}@${packageVersion}`, job)
      parts.push(job)
    }
    plan.set(version, parts)
  }

  let done = 0
  await pool([...jobs.values()], 8, async (job) => {
    await publishedFeatures(job.name, job.published)
    if (++done % 50 === 0 || done === jobs.size) console.error(`extracted ${done}/${jobs.size} package versions`)
  })

  await mkdir(dir, { recursive: true })
  let previous: { version: string; features: string[] } | undefined
  let written = 0
  // Releases before the C header have no API there; some of the oldest have no tag either.
  const untagged: string[] = []
  for (const version of needed) {
    const features = new Set<string>()
    for (const job of plan.get(version)!) {
      for (const line of await publishedFeatures(job.name, job.published)) features.add(line)
    }
    const header = headerFeaturesAt(repoRoot, `v${version}`)
    if (header === undefined) untagged.push(version)
    for (const line of header ?? []) features.add(line)
    const sorted = [...features].sort(compareText)
    if (selected.includes(version)) {
      const diff = diffFeatures(previous?.features ?? [], sorted)
      const text = formatApiFile({ version, base: previous?.version ?? null, ...diff })
      const file = join(dir, `${version}.txt`)
      if (!existsSync(file) || (await readFile(file, "utf8")) !== text) {
        await writeFile(file, text)
        written++
      }
    }
    previous = { version, features: sorted }
  }
  if (untagged.length > 0) console.error(`warning: no tag, so no C API, for ${untagged.join(", ")}`)
  const seconds = ((performance.now() - start) / 1000).toFixed(1)
  console.error(`${selected.length} versions, ${written} files written to ${dir} in ${seconds}s`)
}

async function currentFeatures(options: Options): Promise<string[]> {
  const root = resolve(options.values.get("root") ?? repoRoot)
  mkdirSync(CACHE_DIR, { recursive: true })
  const out = mkdtempSync(join(CACHE_DIR, "source-"))
  try {
    const start = performance.now()
    const features = new Set<string>()
    for (const emitted of emitDeclarations(root, out)) {
      const { features: lines, warnings } = extractPackage(emitted.dir)
      for (const warning of warnings) console.error(`warning: ${emitted.name}: ${warning}`)
      for (const line of lines) features.add(line)
      console.error(`${emitted.name}: ${lines.length} features, emitted in ${emitted.milliseconds.toFixed(0)}ms`)
    }
    const header = headerFeaturesIn(root)
    for (const line of header) features.add(line)
    console.error(`opentui.h: ${header.length} features`)
    console.error(`source API extracted in ${((performance.now() - start) / 1000).toFixed(1)}s`)
    return [...features].sort(compareText)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

async function current(options: Options): Promise<void> {
  const features = await currentFeatures(options)
  await output(features.map((line) => `${line}\n`).join(""), options.values.get("out"))
}

async function sourceRelease(options: Options, version: string, exclude?: string): Promise<string> {
  const history = await loadApiHistory(apiDir(options))
  const base = versionOption(options, "base") ?? history.versions.filter((item) => item !== exclude).at(-1)
  if (base === undefined) throw new Error(`No API files in ${apiDir(options)}; run backfill first`)
  if (exclude !== undefined && options.values.get("base") === undefined && compareVersions(exclude, base) < 0) {
    throw new Error(`${exclude} is older than the latest API file ${base}; pass --base <version>`)
  }
  const diff = diffFeatures(history.snapshot(base), await currentFeatures(options))
  return formatApiFile({ version, base, ...diff })
}

async function diff(options: Options): Promise<void> {
  await output(await sourceRelease(options, "next"), options.values.get("out"))
}

async function release(options: Options): Promise<void> {
  const [version, ...extra] = options.positional
  if (version === undefined || extra.length > 0 || !isApiVersion(version)) throw new Error(USAGE)
  const file = join(apiDir(options), `${version}.txt`)
  const text = await sourceRelease(options, version, version)
  if (existsSync(file)) {
    if ((await readFile(file, "utf8")) === text) {
      console.error(`${file} is up to date`)
      return
    }
    throw new Error(`${file} exists with different contents; remove it to write it again`)
  }
  await writeFile(file, text)
  console.error(`wrote ${file} (${textLines(text).length - 1} changes)`)
}

// Compares the API that api/ records for a release with the API of its packages on npm. A release pull request
// records the API of the branch it was opened from; a change merged before the pull request makes it wrong. The
// C ABI is not on npm, so it is left out.
async function verify(options: Options): Promise<void> {
  const [version, ...extra] = options.positional
  if (version === undefined || extra.length > 0 || !isApiVersion(version)) throw new Error(USAGE)
  const snapshot = (await loadApiHistory(apiDir(options))).snapshot(version)
  const recorded = [...snapshot].filter((line) => !line.startsWith(`${C_MODULE}: `))
  const features = new Set<string>()
  for (const name of PACKAGES) {
    const list = await publishedVersions(name)
    const packageVersion = packageVersionFor(
      list.map((item) => item.version),
      version,
    )
    const published = list.find((item) => item.version === packageVersion)
    if (published) for (const line of await publishedFeatures(name, published)) features.add(line)
  }
  const { added, removed } = diffFeatures(recorded, features)
  for (const line of removed) console.error(`- ${line}`)
  for (const line of added) console.error(`+ ${line}`)
  if (added.length + removed.length > 0) {
    throw new Error(
      `api/ records a different API for ${version} than npm publishes (- recorded only, + published only). ` +
        `Write ${version}.txt again: remove it, then run backfill --from ${version} --to ${version}`,
    )
  }
  console.error(`api/ matches the published API of ${version}`)
}

// Starts the history at a release when its older lines stop mattering. The API that the files record for every
// kept release stays the same; the site stops listing the older releases and their "added in" versions.
async function squash(options: Options): Promise<void> {
  const [version, ...extra] = options.positional
  if (version === undefined || extra.length > 0 || !isApiVersion(version)) throw new Error(USAGE)
  const dir = apiDir(options)
  const history = await loadApiHistory(dir)
  const [snapshot] = history.squash(version)
  await writeFile(join(dir, `${version}.txt`), formatApiFile(snapshot!))
  const dropped = history.versions.filter((item) => compareVersions(item, version) < 0)
  for (const item of dropped) await rm(join(dir, `${item}.txt`))
  console.error(`${version}.txt is a snapshot of ${snapshot!.added.length} features; removed ${dropped.length} files`)
}

async function check(options: Options): Promise<void> {
  const dir = apiDir(options)
  const files = await apiFiles(dir)
  if (files.length === 0) throw new Error(`No API files in ${dir}`)
  const problems = checkApiFiles(files)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) throw new Error(`${problems.length} problems in ${dir}`)
  console.error(`${files.length} API files in ${dir} are valid`)
}

const commands: Record<string, { options: string[]; run: (options: Options) => Promise<void> }> = {
  backfill: { options: ["from", "to", "dir"], run: backfill },
  current: { options: ["out", "root"], run: current },
  diff: { options: ["base", "out", "dir", "root"], run: diff },
  release: { options: ["base", "dir", "root"], run: release },
  verify: { options: ["dir"], run: verify },
  squash: { options: ["dir"], run: squash },
  check: { options: ["dir"], run: check },
}

async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2)
  const command = name === undefined ? undefined : commands[name]
  if (command === undefined) throw new Error(USAGE)
  const options = parseOptions(args, command.options)
  if (!["release", "verify", "squash"].includes(name) && options.positional.length > 0) throw new Error(USAGE)
  await command.run(options)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
