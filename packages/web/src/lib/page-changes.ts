import { getCollection } from "astro:content"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { channelApi, exportName, groupChanges, UNRELEASED } from "./api-docs"
import { compareVersions, type ApiChange } from "./api-history"
import { documentedSymbols } from "./api-index-symbols"
import type { DocsChannel } from "./docs-channel"
import type { ReleaseNotesData } from "./release-notes-loader"
import { releaseLine } from "./release-notes"
import { REPO_ROOT } from "./repo-root"

// The changes a documentation page lists, so a reader sees what changed in recent releases without comparing
// versions of the docs: release-note entries that link to the page, and API changes of the symbols that the API
// index documents on the page. Pages list the releases of the channel's line and the line before it, and the
// main-branch channel adds its unreleased API changes.

export interface PageChanges {
  /** A release version, or UNRELEASED. */
  version: string
  notes: string[]
  api: Array<{ type: ApiChange["type"]; names: string[] }>
}

const cache = new Map<string, Promise<Map<string, PageChanges[]>>>()

export async function pageChanges(channel: DocsChannel, page: string): Promise<PageChanges[]> {
  const key = `${channel.id} ${channel.release}`
  let index = cache.get(key)
  if (!index) cache.set(key, (index = buildIndex(channel)))
  return (await index).get(page) ?? []
}

async function buildIndex(channel: DocsChannel): Promise<Map<string, PageChanges[]>> {
  const [notes, api, apiIndex] = await Promise.all([
    getCollection("releases"),
    channelApi(channel),
    readFile(join(REPO_ROOT, "packages/web/src/content/docs/reference/api-index.mdx"), "utf8").catch(() => ""),
  ])
  const pages = new Map<string, Map<string, PageChanges>>()
  const entry = (page: string, version: string) => {
    let versions = pages.get(page)
    if (!versions) pages.set(page, (versions = new Map()))
    let changes = versions.get(version)
    if (!changes) versions.set(version, (changes = { version, notes: [], api: [] }))
    return changes
  }

  // The main-branch channel also lists a release that npm does not serve yet.
  const window = windowStart(channel.release)
  const inWindow = (version: string) =>
    compareVersions(version, window) >= 0 && (channel.id === "next" || compareVersions(version, channel.release) <= 0)

  for (const release of notes) {
    const data = release.data as unknown as ReleaseNotesData
    if (!inWindow(data.version)) continue
    for (const change of data.entries) {
      for (const page of change.docs) entry(page, data.version).notes.push(change.html)
    }
  }

  const symbolPages = new Map(
    documentedSymbols(apiIndex).map((symbol) => [`${symbol.module} ${symbol.name}`, symbol.page]),
  )
  const addApi = (version: string, changes: ApiChange[]) => {
    for (const group of groupChanges(changes)) {
      const byPage = new Map<string, string[]>()
      for (const change of group.changes) {
        const page = symbolPages.get(`${change.module} ${exportName(change.name)}`)
        if (!page) continue
        const names = byPage.get(page)
        if (names) names.push(change.name)
        else byPage.set(page, [change.name])
      }
      for (const [page, names] of byPage) {
        const api = entry(page, version).api
        const existing = api.find((item) => item.type === group.type)
        if (existing) existing.names.push(...names)
        else api.push({ type: group.type, names })
      }
    }
  }
  if (api) {
    if (api.unreleased) addApi(UNRELEASED, api.unreleased)
    for (const version of api.versions.filter(inWindow)) addApi(version, api.changes(version))
  }

  return new Map(
    [...pages].map(([page, versions]) => [
      page,
      [...versions.values()].sort((left, right) => compareRelease(right.version, left.version)),
    ]),
  )
}

/** The first release of the line before the release's line: 0.4.0 for 0.5.17. */
function windowStart(release: string): string {
  const [major, minor] = releaseLine(release).split(".").map(Number)
  return minor > 0 ? `${major}.${minor - 1}.0` : `${major}.0.0`
}

function compareRelease(left: string, right: string): number {
  if (left === right) return 0
  if (left === UNRELEASED) return 1
  if (right === UNRELEASED) return -1
  return compareVersions(left, right)
}
