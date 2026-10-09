import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  ApiHistory,
  compareVersions,
  diffFeatures,
  loadApiHistory,
  parseFeature,
  type ApiChange,
  type ApiFeature,
  type ApiKeyHistory,
} from "./api-history"
import type { DocsChannel } from "./docs-channel"
import { REPO_ROOT } from "./repo-root"

// The API data that documentation pages show, like pkg.go.dev's "added in" labels and its per-version changes:
// the release channel shows the API of its release; the main-branch channel shows the API of the source, which
// scripts/build-site.ts extracts into the file that OPENTUI_API_CURRENT names, with unreleased changes.

/** Version label of API features that no release has. */
export const UNRELEASED = "unreleased"

export interface ChannelApi {
  /** The released versions the channel documents, ascending. */
  versions: string[]
  /** The channel's API: its release, or the main-branch source. */
  features: ApiFeature[]
  /** The history of each feature key; keys that only the source has are since UNRELEASED. */
  keys: Map<string, ApiKeyHistory>
  /** The API changes of a released version. */
  changes(version: string): ApiChange[]
  /** The number of feature lines a released version added and removed. */
  size(version: string): { added: number; removed: number }
  /** The source's changes since the latest release, on the main-branch channel with a source snapshot. */
  unreleased?: ApiChange[]
  /**
   * The release that unreleased changes follow: the latest API file, which can be newer than the release npm
   * serves while a release is published.
   */
  unreleasedBase?: string
}

let cache: { key: string; api: Promise<ChannelApi | undefined> } | undefined

/** The API data of the channel, or undefined when the repository has no api/ history. */
export function channelApi(
  channel: DocsChannel,
  env: Record<string, string | undefined> = process.env,
): Promise<ChannelApi | undefined> {
  const key = `${channel.id} ${channel.release} ${env.OPENTUI_API_CURRENT ?? ""}`
  if (cache?.key !== key) cache = { key, api: loadChannelApi(channel, env.OPENTUI_API_CURRENT) }
  return cache.api
}

async function loadChannelApi(channel: DocsChannel, currentFile: string | undefined): Promise<ChannelApi | undefined> {
  const directory = join(REPO_ROOT, "api")
  if (!existsSync(directory)) return undefined
  const history = await loadApiHistory(directory)
  const released =
    channel.id === "stable"
      ? history.versions.filter((version) => compareVersions(version, channel.release) <= 0)
      : history.versions
  const latest = released.at(-1)
  if (!latest) return undefined
  const size = (version: string) => {
    const release = history.release(version)
    return { added: release.added.length, removed: release.removed.length }
  }

  if (channel.id === "next" && currentFile) {
    const current = (await readFile(currentFile, "utf8")).split("\n").filter(Boolean)
    // A release after the latest stands for the source, so the history records its changes like a release's.
    const source = nextPatch(latest)
    const draft = ApiHistory.fromReleases([
      ...history.versions.map((version) => history.release(version)),
      { version: source, base: latest, ...diffFeatures(history.snapshot(latest), current) },
    ])
    const keys = draft.keyHistory()
    for (const entry of keys.values()) {
      if (entry.since === source) entry.since = UNRELEASED
      if (entry.removedIn === source) entry.removedIn = UNRELEASED
      if (entry.deprecatedIn === source) entry.deprecatedIn = UNRELEASED
      entry.changedIn = entry.changedIn.map((version) => (version === source ? UNRELEASED : version))
    }
    return {
      versions: released,
      features: current.map(parseFeature),
      keys,
      changes: (version) => history.changes(version),
      size,
      unreleased: draft.changes(source),
      unreleasedBase: latest,
    }
  }

  return {
    versions: released,
    features: [...history.snapshot(latest)].map(parseFeature),
    keys: history.keyHistory(latest),
    changes: (version) => history.changes(version),
    size,
  }
}

/** The top-level export a feature belongs to: CliRenderer for CliRenderer.suspend. */
export function exportName(name: string): string {
  const dot = name.search(/\.(?=[\p{L}_$"'[*#])/u)
  return dot === -1 ? name : name.slice(0, dot)
}

export const CHANGE_TYPES = ["added", "changed", "deprecated", "removed"] as const

export interface ChangeGroup {
  module: string
  type: ApiChange["type"]
  changes: ApiChange[]
}

/**
 * Groups a release's changes by module and type. A member of an export that the same release added or removed
 * is left out: the export's own entry stands for it.
 */
export function groupChanges(changes: ApiChange[]): ChangeGroup[] {
  const whole = new Set(
    changes
      .filter(
        (change) => (change.type === "added" || change.type === "removed") && change.name === exportName(change.name),
      )
      .map((change) => `${change.type} ${change.module} ${change.name}`),
  )
  const groups = new Map<string, ChangeGroup>()
  for (const change of changes) {
    const parent = exportName(change.name)
    if (parent !== change.name && whole.has(`${change.type} ${change.module} ${parent}`)) continue
    const id = `${change.module} ${change.type}`
    let group = groups.get(id)
    if (!group) {
      group = { module: change.module, type: change.type, changes: [] }
      groups.set(id, group)
    }
    group.changes.push(change)
  }
  return [...groups.values()].sort(
    (left, right) =>
      compareModules(left.module, right.module) || CHANGE_TYPES.indexOf(left.type) - CHANGE_TYPES.indexOf(right.type),
  )
}

/** Modules in name order, so a package root comes before its subpaths. */
export function compareModules(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/** A feature without its module: "method CliRenderer.suspend(): Promise<void>". */
export function featureText(feature: ApiFeature): string {
  return feature.line.slice(feature.module.length + 2)
}

function nextPatch(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number)
  return `${major}.${minor}.${patch + 1}`
}
