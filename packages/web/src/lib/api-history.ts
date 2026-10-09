// The API history of the published @opentui packages and the C ABI, read from the api/<version>.txt files at
// the repository root. Each file lists the API features that a release added (`+`) and removed (`-`)
// relative to the release on its `base` line. See api/README.md for the format.

export interface ApiFeature {
  line: string
  module: string
  modifiers: string[]
  kind: string
  name: string
  signature: string
}

export interface ApiRelease {
  version: string
  base: string | null
  added: string[]
  removed: string[]
}

export interface ApiChange {
  key: string
  module: string
  kind: string
  name: string
  /** The lines of this key that the release removed. */
  before: ApiFeature[]
  /** The lines of this key that the release added. */
  after: ApiFeature[]
  type: "added" | "removed" | "changed" | "deprecated"
}

export interface ApiKeyHistory {
  key: string
  since: string
  removedIn?: string
  changedIn: string[]
  deprecatedIn?: string
}

export const API_MODIFIERS = ["deprecated", "static", "protected", "abstract", "readonly"] as const

/** The module of the C ABI's features. */
export const C_MODULE = "opentui.h"

export const API_KINDS = [
  "class",
  "interface",
  "type",
  "function",
  "const",
  "let",
  "enum",
  "enum-member",
  "namespace",
  "constructor",
  "method",
  "property",
  "call",
  "construct",
  "index",
  "reexport",
  "struct",
  "field",
] as const

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
const NAME_CHAR = /[\p{L}\p{N}_$#]/u

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function isApiVersion(version: string): boolean {
  return VERSION.test(version)
}

export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a)
  const right = VERSION.exec(b)
  if (left === null || right === null) throw new Error(`Not an x.y.z version: ${left === null ? a : b}`)
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference !== 0) return difference
  }
  return 0
}

// Skips a quoted string or a bracketed computed name and returns the index after it.
function skipGroup(text: string, start: number): number {
  const close = text[start] === "[" ? "]" : text[start]!
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const char = text[index]!
    if (index > start && (char === '"' || char === "'") && close === "]") index = skipGroup(text, index) - 1
    else if (char === "\\") index++
    else if (close === "]" && char === "[") depth++
    else if (char === close && (close !== "]" || --depth === 0) && index > start) return index + 1
  }
  throw new Error(`Unterminated name in API feature: ${text}`)
}

// The end of a dotted name such as `Yoga.Node.create`, `OpenTUIComponents."qr-code"`, or
// `Foo.[Symbol.iterator]`. The signature starts after it.
function nameEnd(text: string): number {
  let index = 0
  while (true) {
    const char = text[index]
    if (char === '"' || char === "'" || (char === "[" && index > 0)) index = skipGroup(text, index)
    else if (char === "*") index++
    else {
      const start = index
      while (index < text.length && NAME_CHAR.test(text[index]!)) index++
      if (index === start) return start
    }
    const next = text[index + 1]
    if (text[index] !== "." || next === undefined) return index
    if (!(NAME_CHAR.test(next) || next === '"' || next === "'" || next === "[" || next === "*")) return index
    index++
  }
}

export function parseFeature(line: string): ApiFeature {
  const separator = line.indexOf(": ")
  if (separator <= 0) throw new Error(`Invalid API feature: ${line}`)
  const module = line.slice(0, separator)
  const words = line.slice(separator + 2)
  const modifiers: string[] = []
  let offset = 0
  let kind = ""
  while (true) {
    const space = words.indexOf(" ", offset)
    if (space < 0) throw new Error(`Invalid API feature: ${line}`)
    const word = words.slice(offset, space)
    offset = space + 1
    if (!(API_MODIFIERS as readonly string[]).includes(word)) {
      kind = word
      break
    }
    modifiers.push(word)
  }
  if (!(API_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown API kind "${kind}": ${line}`)
  const rest = words.slice(offset)
  const end = nameEnd(rest)
  if (end === 0) throw new Error(`Missing API name: ${line}`)
  return { line, module, modifiers, kind, name: rest.slice(0, end), signature: rest.slice(end) }
}

export function formatFeature(feature: Omit<ApiFeature, "line">): string {
  return `${feature.module}: ${[...feature.modifiers, feature.kind].join(" ")} ${feature.name}${feature.signature}`
}

export function featureKey(feature: ApiFeature): string {
  return `${feature.module}: ${feature.kind} ${feature.name}`
}

export function lineKey(line: string): string {
  return featureKey(parseFeature(line))
}

export function diffFeatures(base: Iterable<string>, next: Iterable<string>): { added: string[]; removed: string[] } {
  const before = new Set(base)
  const after = new Set(next)
  return {
    added: [...after].filter((line) => !before.has(line)).sort(compareText),
    removed: [...before].filter((line) => !after.has(line)).sort(compareText),
  }
}

export function parseApiFile(version: string, text: string): ApiRelease {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const header = /^base (none|\d+\.\d+\.\d+)$/.exec(lines[0] ?? "")
  if (header === null) throw new Error(`${version}: the first line must be "base <version>" or "base none"`)
  const release: ApiRelease = { version, base: header[1] === "none" ? null : header[1]!, added: [], removed: [] }
  for (const [index, line] of lines.slice(1).entries()) {
    const op = line.slice(0, 2)
    if (op !== "+ " && op !== "- ") throw new Error(`${version}:${index + 2}: expected "+ <feature>" or "- <feature>"`)
    const feature = line.slice(2)
    try {
      parseFeature(feature)
    } catch (error) {
      throw new Error(`${version}:${index + 2}: ${error instanceof Error ? error.message : error}`)
    }
    ;(op === "+ " ? release.added : release.removed).push(feature)
  }
  return release
}

// Lines are grouped by feature key, so that the removed and added lines of a changed signature are
// adjacent. Within a key, `-` lines come first, and lines of one sign sort by their text.
export function formatApiFile(release: ApiRelease): string {
  const entries = [
    ...release.removed.map((line) => ({ op: "-", rank: 0, line, key: lineKey(line) })),
    ...release.added.map((line) => ({ op: "+", rank: 1, line, key: lineKey(line) })),
  ]
  entries.sort(
    (left, right) => compareText(left.key, right.key) || left.rank - right.rank || compareText(left.line, right.line),
  )
  const body = entries.map((entry) => `${entry.op} ${entry.line}\n`).join("")
  return `base ${release.base ?? "none"}\n${body}`
}

type KeyState = Map<string, string[]>

function addDeprecated(line: string): string {
  const feature = parseFeature(line)
  return formatFeature({ ...feature, modifiers: ["deprecated", ...feature.modifiers] })
}

function isDeprecated(line: string): boolean {
  return parseFeature(line).modifiers[0] === "deprecated"
}

// True when the only change from `before` to `after` is that each line gained `deprecated`.
function isDeprecation(before: string[], after: string[]): boolean {
  if (before.length === 0 || before.length !== after.length || before.some(isDeprecated)) return false
  const added = new Set(after)
  return before.every((line) => added.has(addDeprecated(line)))
}

function groupByKey(lines: Iterable<string>): KeyState {
  const groups: KeyState = new Map()
  for (const line of lines) {
    const key = lineKey(line)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [line])
    else group.push(line)
  }
  return groups
}

function applyRelease(state: KeyState, release: ApiRelease): void {
  for (const line of release.removed) {
    const key = lineKey(line)
    const lines = state.get(key)
    const index = lines?.indexOf(line) ?? -1
    if (lines === undefined || index < 0) throw new Error(`${release.version}: removes a missing feature: ${line}`)
    lines.splice(index, 1)
    if (lines.length === 0) state.delete(key)
  }
  for (const line of release.added) {
    const key = lineKey(line)
    const lines = state.get(key)
    if (lines === undefined) state.set(key, [line])
    else if (lines.includes(line)) throw new Error(`${release.version}: adds a present feature: ${line}`)
    else lines.push(line)
  }
}

export class ApiHistory {
  /** The versions in ascending semver order. */
  readonly versions: string[]
  private readonly releases: Map<string, ApiRelease>

  private constructor(releases: ApiRelease[]) {
    this.releases = new Map()
    for (const release of releases) {
      if (!isApiVersion(release.version)) throw new Error(`Not an x.y.z version: ${release.version}`)
      if (this.releases.has(release.version)) throw new Error(`Duplicate API file for ${release.version}`)
      this.releases.set(release.version, release)
    }
    for (const release of releases) this.chain(release.version)
    this.versions = [...this.releases.keys()].sort(compareVersions)
  }

  static fromFiles(files: Array<{ version: string; text: string }>): ApiHistory {
    return new ApiHistory(files.map((file) => parseApiFile(file.version, file.text)))
  }

  static fromReleases(releases: ApiRelease[]): ApiHistory {
    return new ApiHistory(releases)
  }

  get latest(): string | undefined {
    return this.versions.at(-1)
  }

  release(version: string): ApiRelease {
    const release = this.releases.get(version)
    if (release === undefined) throw new Error(`No API file for ${version}`)
    return release
  }

  // The version and its bases, oldest first.
  private chain(version: string): ApiRelease[] {
    const chain: ApiRelease[] = []
    const seen = new Set<string>()
    for (let current: string | null = version; current !== null; current = this.release(current).base) {
      if (seen.has(current)) throw new Error(`API base chain of ${version} has a cycle at ${current}`)
      seen.add(current)
      chain.push(this.release(current))
    }
    return chain.reverse()
  }

  private state(version: string): KeyState {
    const state: KeyState = new Map()
    for (const release of this.chain(version)) applyRelease(state, release)
    return state
  }

  snapshot(version: string): Set<string> {
    return new Set([...this.state(version).values()].flat())
  }

  changes(version: string): ApiChange[] {
    const release = this.release(version)
    const base = release.base === null ? new Map<string, string[]>() : this.state(release.base)
    const removed = groupByKey(release.removed)
    const added = groupByKey(release.added)
    const keys = [...new Set([...removed.keys(), ...added.keys()])].sort(compareText)
    return keys.map((key) => {
      const before = removed.get(key) ?? []
      const after = added.get(key) ?? []
      const remaining = (base.get(key)?.length ?? 0) - before.length + after.length
      const type = !base.has(key)
        ? "added"
        : remaining === 0
          ? "removed"
          : isDeprecation(before, after)
            ? "deprecated"
            : "changed"
      const feature = parseFeature((before[0] ?? after[0])!)
      return {
        key,
        module: feature.module,
        kind: feature.kind,
        name: feature.name,
        before: before.map(parseFeature),
        after: after.map(parseFeature),
        type,
      }
    })
  }

  // Walks the versions in ascending order. Only the states that a later version still needs as its base
  // are kept, so a linear history holds one snapshot at a time.
  keyHistory(upTo?: string): Map<string, ApiKeyHistory> {
    const versions = upTo === undefined ? this.versions : this.versions.filter((v) => compareVersions(v, upTo) <= 0)
    const included = new Set(versions)
    const uses = new Map<string, number>()
    for (const version of versions) {
      const base = this.release(version).base
      if (base !== null && included.has(base)) uses.set(base, (uses.get(base) ?? 0) + 1)
    }
    const kept = new Map<string, KeyState>()
    const history = new Map<string, ApiKeyHistory>()
    let previous: { version: string; state: KeyState } | undefined

    const visit = (key: string, before: string[], after: string[], version: string): void => {
      if (before.length === 0 && after.length === 0) return
      let entry = history.get(key)
      if (after.length === 0) {
        if (entry !== undefined) entry.removedIn = version
        return
      }
      if (entry === undefined || before.length === 0) {
        if (entry === undefined) {
          entry = { key, since: version, changedIn: [] }
          history.set(key, entry)
        }
        entry.removedIn = undefined
        entry.deprecatedIn = after.every(isDeprecated) ? version : undefined
        return
      }
      const lost = before.filter((line) => !after.includes(line))
      const gained = after.filter((line) => !before.includes(line))
      if (lost.length === 0 && gained.length === 0) return
      const wasDeprecated = before.every(isDeprecated)
      const deprecated = after.every(isDeprecated)
      if (!wasDeprecated && deprecated) entry.deprecatedIn = version
      if (wasDeprecated && !deprecated) entry.deprecatedIn = undefined
      if (!isDeprecation(lost, gained)) entry.changedIn.push(version)
    }

    for (const version of versions) {
      const release = this.release(version)
      let state: KeyState
      const base = release.base
      const keptBase = base === null ? undefined : kept.get(base)
      if (base === null) state = new Map()
      else if (keptBase === undefined) state = this.state(base)
      else {
        const remaining = uses.get(base)! - 1
        uses.set(base, remaining)
        if (remaining === 0) kept.delete(base)
        state = remaining === 0 ? keptBase : new Map([...keptBase].map(([key, lines]) => [key, [...lines]]))
      }
      const linear = previous !== undefined && base === previous.version
      if (linear) {
        const touched = new Map<string, string[]>()
        for (const line of [...release.removed, ...release.added]) {
          const key = lineKey(line)
          if (!touched.has(key)) touched.set(key, [...(state.get(key) ?? [])])
        }
        applyRelease(state, release)
        for (const [key, before] of touched) visit(key, before, state.get(key) ?? [], version)
      } else {
        applyRelease(state, release)
        const before = previous?.state ?? new Map<string, string[]>()
        for (const key of new Set([...before.keys(), ...state.keys()])) {
          visit(key, before.get(key) ?? [], state.get(key) ?? [], version)
        }
      }
      if ((uses.get(version) ?? 0) > 0) kept.set(version, state)
      previous = { version, state }
    }
    return history
  }
}

// Every problem in a set of API files: parse errors, files that are not in canonical order, unknown or
// cyclic bases, and lines that add a present feature or remove a missing one.
export function checkApiFiles(files: Array<{ version: string; text: string }>): string[] {
  const problems: string[] = []
  const releases: ApiRelease[] = []
  for (const file of files) {
    if (!isApiVersion(file.version)) {
      problems.push(`${file.version}: the file name is not an x.y.z version`)
      continue
    }
    let release: ApiRelease
    try {
      release = parseApiFile(file.version, file.text)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
      continue
    }
    const lines = [...release.added, ...release.removed]
    if (new Set(lines).size !== lines.length) problems.push(`${file.version}: a feature is listed twice`)
    else if (formatApiFile(release) !== file.text) problems.push(`${file.version}: lines are not in canonical order`)
    if (release.base !== null && !files.some((other) => other.version === release.base)) {
      problems.push(`${file.version}: base ${release.base} has no API file`)
      continue
    }
    releases.push(release)
  }
  if (problems.length > 0) return problems
  let history: ApiHistory
  try {
    history = ApiHistory.fromReleases(releases)
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  try {
    history.keyHistory()
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  return problems
}

export async function loadApiHistory(dir: string): Promise<ApiHistory> {
  const { readdir, readFile } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const names = (await readdir(dir)).filter((name) => /^\d+\.\d+\.\d+\.txt$/.test(name))
  const files = await Promise.all(
    names.map(async (name) => ({ version: name.slice(0, -4), text: await readFile(join(dir, name), "utf8") })),
  )
  return ApiHistory.fromFiles(files)
}
