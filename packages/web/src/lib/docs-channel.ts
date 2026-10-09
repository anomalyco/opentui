import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REPO_ROOT } from "./repo-root"

// The site serves documentation in two channels, like go.dev and tip.golang.org. /docs documents the latest
// release and /docs/next documents the main branch. One Astro build renders one channel; scripts/build-site.ts
// builds both and merges them. Sources and the docs index use logical /docs URLs; pages map them to the channel
// with channelUrl().

export type DocsChannelId = "stable" | "next"

export interface DocsChannel {
  id: DocsChannelId
  /** URL prefix of the channel's documentation. */
  base: "/docs" | "/docs/next"
  /** The latest release, which /docs documents. */
  release: string
}

export const DOCS_CHANNEL_BASES = { stable: "/docs", next: "/docs/next" } as const

/** First path segments under /docs that documentation slugs cannot use. */
export const RESERVED_DOC_SEGMENTS = ["next", "releases", "api", "_astro", ".well-known", "search-index.json"]

/** Whether a logical URL names a generated page, such as a release page, rather than a documentation source. */
export function isGeneratedDocsUrl(url: string): boolean {
  return /^\/docs\/(releases|api)([/?#]|$)/.test(url)
}

/** Old documentation URLs and the pages that replaced them. Each channel redirects those whose target it has. */
const DOC_REDIRECTS: Record<string, string> = {
  "/docs/getting-started": "/docs",
  "/docs/core-concepts/constructs": "/docs/core-concepts/renderables",
  "/docs/core-concepts/renderables-vs-constructs": "/docs/core-concepts/renderables",
  "/docs/native/c-zig": "/docs/native/c",
}

const VERSION = /^\d+\.\d+\.\d+$/

/** Reads the channel from OPENTUI_DOCS_CHANNEL and the release from OPENTUI_DOCS_RELEASE. */
export function docsChannel(env: Record<string, string | undefined> = process.env): DocsChannel {
  const id = env.OPENTUI_DOCS_CHANNEL || "stable"
  if (id !== "stable" && id !== "next") {
    throw new Error(`OPENTUI_DOCS_CHANNEL must be "stable" or "next", not "${id}"`)
  }

  const release = env.OPENTUI_DOCS_RELEASE || coreVersion()
  if (!VERSION.test(release)) throw new Error(`OPENTUI_DOCS_RELEASE must be a version such as 0.5.17, not "${release}"`)

  return { id, base: DOCS_CHANNEL_BASES[id], release }
}

/**
 * Whether a channel has a documentation page at a logical URL. scripts/build-site.ts lists both channels' pages
 * in the file that OPENTUI_DOCS_PAGES names; without it, as in development, every page counts as present.
 */
export function channelHasPage(
  id: DocsChannelId,
  logicalUrl: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const pages = channelPages(env.OPENTUI_DOCS_PAGES)
  return pages ? pages[id].has(logicalUrl) : true
}

/**
 * The same page in another channel. When the other channel lacks it, such as a page added on the main branch
 * after the release, this is the nearest page above it that the other channel has, such as /docs/releases for a
 * release page, or the channel's home.
 */
export function channelCounterpart(
  channelPath: string,
  from: DocsChannel,
  to: DocsChannelId,
  env: Record<string, string | undefined> = process.env,
): { href: string; present: boolean } {
  const target = { base: DOCS_CHANNEL_BASES[to] }
  const url = logicalUrl(channelPath, from)
  if (!channelHasPage(from.id, url, env) || channelHasPage(to, url, env)) {
    return { href: channelUrl(url, target), present: true }
  }
  let parent = url
  while (parent !== "/docs") {
    parent = parent.slice(0, parent.lastIndexOf("/")) || "/docs"
    if (channelHasPage(to, parent, env)) break
  }
  return { href: channelUrl(parent, target), present: false }
}

/** Logical URL of a channel path: /docs/next/x becomes /docs/x. */
export function logicalUrl(channelPath: string, channel: Pick<DocsChannel, "base">): string {
  return switchChannelPath(channelPath, channel, { base: "/docs" })
}

/** The redirects for the channel, keyed by channel path. */
export function docsRedirects(channel: DocsChannel, hasPage: (logicalUrl: string) => boolean) {
  return Object.fromEntries(
    Object.entries(DOC_REDIRECTS)
      .filter(([from, to]) => hasPage(to) && !hasPage(from))
      .map(([from, to]) => [channelUrl(from, channel), channelUrl(to, channel)]),
  )
}

let pagesCache: { file: string; pages: Record<DocsChannelId, Set<string>> } | undefined

function channelPages(file: string | undefined): Record<DocsChannelId, Set<string>> | undefined {
  if (!file) return undefined
  if (pagesCache?.file !== file) {
    const lists = JSON.parse(readFileSync(file, "utf8")) as Record<DocsChannelId, string[]>
    pagesCache = { file, pages: { stable: new Set(lists.stable), next: new Set(lists.next) } }
  }
  return pagesCache.pages
}

/** Maps a logical /docs URL to the channel. Other URLs are unchanged. */
export function channelUrl(url: string, channel: Pick<DocsChannel, "base">): string {
  if (!isDocsUrl(url)) return url
  return `${channel.base}${url.slice("/docs".length)}`
}

/** The rest parameter of a route under src/pages/docs/ for a channel URL: "next/x" for /docs/next/x. */
export function docsRouteParam(channelPath: string): string | undefined {
  if (channelPath === "/docs") return undefined
  if (!channelPath.startsWith("/docs/")) throw new Error(`${channelPath} is not a documentation path`)
  return channelPath.slice("/docs/".length)
}

/** Maps a path in one channel to the same page in another channel. */
export function switchChannelPath(
  path: string,
  from: Pick<DocsChannel, "base">,
  to: Pick<DocsChannel, "base">,
): string {
  if (path !== from.base && !path.startsWith(`${from.base}/`)) return to.base
  return `${to.base}${path.slice(from.base.length)}`
}

function isDocsUrl(url: string): boolean {
  return url === "/docs" || /^\/docs[/?#]/.test(url)
}

function coreVersion(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "packages/core/package.json"), "utf8")) as {
    version: string
  }
  return manifest.version
}
