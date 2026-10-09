import { readdir, readFile, stat } from "node:fs/promises"
import { join, posix, relative, sep } from "node:path"

// Checks the assembled site, after both documentation channels are merged. Source checks cannot see links that
// layouts, redirects, or the merge add. Every internal href and src must resolve to a file, every fragment on a
// documentation link must name an element, and documentation links stay in their channel unless they carry
// data-docs-channel (the version switch and the main-branch notice).

export interface SiteProblem {
  page: string
  message: string
}

export interface ValidateSiteOptions {
  /** Origin of absolute URLs that count as internal, such as https://opentui.com. */
  site: string
  /** URL prefix of the main-branch documentation channel. */
  nextBase: string
}

interface Page {
  path: string
  html: string
}

const URL_ATTRIBUTES = new Set(["href", "src"])

export async function validateSite(root: string, options: ValidateSiteOptions): Promise<SiteProblem[]> {
  const files = new Set((await listFiles(root)).map((file) => relative(root, file).split(sep).join("/")))
  const problems: SiteProblem[] = []
  const idCache = new Map<string, Set<string>>()

  const ids = async (file: string) => {
    let cached = idCache.get(file)
    if (!cached) {
      cached = collectIds(await readFile(join(root, file), "utf8"))
      idCache.set(file, cached)
    }
    return cached
  }

  for (const file of [...files].filter((file) => file.endsWith(".html")).sort()) {
    const page: Page = { path: urlPath(file), html: await readFile(join(root, file), "utf8") }
    const report = (message: string) => problems.push({ page: page.path, message })

    for (const element of elements(page.html)) {
      for (const [attribute, value] of element.attributes) {
        const url = attribute === "content" ? refreshTarget(element, value) : URL_ATTRIBUTES.has(attribute) && value
        if (!url) continue

        const target = internalUrl(url, page.path, options.site)
        if (!target) continue

        const resolved = resolveFile(target.pathname, files)
        if (!resolved) {
          report(`${element.name} ${attribute}="${url}" does not resolve to a file`)
          continue
        }

        if (target.hash && resolved.endsWith(".html") && isDocsPath(target.pathname)) {
          const id = decodeURIComponent(target.hash.slice(1))
          if (!(await ids(resolved)).has(id)) report(`${element.name} ${attribute}="${url}" names a missing fragment`)
        }

        if (element.name === "a" && !element.attributes.has("data-docs-channel")) {
          const crossing = channelCrossing(page.path, target.pathname, options.nextBase)
          if (crossing) report(`a href="${url}" ${crossing}`)
        }
      }
    }
  }

  return problems
}

function channelCrossing(from: string, to: string, nextBase: string): string | undefined {
  if (!isDocsPath(from) || !isDocsPath(to)) return undefined
  const fromNext = within(from, nextBase)
  const toNext = within(to, nextBase)
  if (fromNext && !toNext) return "leaves the main-branch documentation"
  if (!fromNext && toNext) return "leaves the release documentation"
  return undefined
}

function isDocsPath(path: string): boolean {
  return within(path, "/docs")
}

function within(path: string, base: string): boolean {
  return path === base || path === `${base}/` || path.startsWith(`${base}/`)
}

function internalUrl(url: string, pagePath: string, site: string): URL | undefined {
  if (url.startsWith("//") || url.startsWith("data:")) return undefined
  const base = new URL(pagePath, site)
  let target: URL
  try {
    target = new URL(url, base)
  } catch {
    return undefined
  }
  return target.origin === new URL(site).origin ? target : undefined
}

function resolveFile(pathname: string, files: Set<string>): string | undefined {
  const path = decodeURIComponent(pathname).replace(/^\/+/, "")
  const candidates =
    path === "" || path.endsWith("/") ? [`${path}index.html`] : [path, `${path}/index.html`, `${path}.html`]
  return candidates.find((candidate) => files.has(posix.normalize(candidate)))
}

function urlPath(file: string): string {
  if (file === "index.html") return "/"
  if (file.endsWith("/index.html")) return `/${file.slice(0, -"index.html".length)}`
  return `/${file}`
}

interface Element {
  name: string
  attributes: Map<string, string>
}

/** Start tags outside script and style content. Astro writes double-quoted attributes. */
export function elements(html: string): Element[] {
  const markup = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, "$1$3")
  const result: Element[] = []
  for (const match of markup.matchAll(
    /<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g,
  )) {
    const attributes = new Map<string, string>()
    for (const attribute of match[2].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attributes.set(attribute[1].toLowerCase(), decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""))
    }
    result.push({ name: match[1].toLowerCase(), attributes })
  }
  return result
}

function collectIds(html: string): Set<string> {
  const ids = new Set<string>()
  for (const element of elements(html)) {
    const id = element.attributes.get("id")
    if (id) ids.add(id)
  }
  return ids
}

function refreshTarget(element: Element, content: string): string | undefined {
  if (element.name !== "meta" || element.attributes.get("http-equiv")?.toLowerCase() !== "refresh") return undefined
  return content.match(/url=(.+)$/i)?.[1]?.trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

export async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return listFiles(path)
      if (entry.isFile()) return [path]
      if (entry.isSymbolicLink() && (await stat(path)).isFile()) return [path]
      return []
    }),
  )
  return files.flat()
}

if (import.meta.main) {
  const root = process.argv[2]
  if (!root) {
    console.error("Usage: bun scripts/site/validate-site.ts <site directory>")
    process.exit(2)
  }
  const problems = await validateSite(root, { site: "https://opentui.com", nextBase: "/docs/next" })
  for (const problem of problems) console.error(`${problem.page}: ${problem.message}`)
  console.log(problems.length === 0 ? "Site links are valid." : `${problems.length} site link problems.`)
  process.exit(problems.length === 0 ? 0 : 1)
}
