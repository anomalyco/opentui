import { promises as fs } from "node:fs"
import { basename, relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { ContentEntryType } from "astro"
import type { Loader, LoaderContext } from "astro/loaders"
import { channelUrl, docsChannel, type DocsChannel } from "./docs-channel"
import { parseReleaseNotes, splitFrontmatter, type ReleaseSection } from "./release-notes"

type ReleaseLoaderContext = LoaderContext & { entryTypes: Map<string, ContentEntryType> }

export interface ReleaseNotesData {
  version: string
  date: string
  summary: string
  entries: Array<{ section: ReleaseSection; html: string; docs: string[] }>
}

/**
 * Loads src/content/docs/releases/<version>.md. Each entry renders the whole file for its release page and
 * each change on its own for the Changes lists on documentation pages. Like the documentation's links, the
 * notes' /docs links stay in the build's channel.
 */
export function releaseNotesLoader(): Loader {
  return {
    name: "opentui-release-notes",
    async load(loaderContext) {
      const context = loaderContext as ReleaseLoaderContext
      const directory = new URL("content/docs/releases/", context.config.srcDir)
      const entryType = context.entryTypes.get(".md")
      if (!entryType) throw new Error("The release notes loader requires Markdown support")
      const channel = docsChannel()
      const render = async (markdown: string, fileURL: URL) => {
        const rendered = await context.renderMarkdown(markdown, { fileURL })
        return { ...rendered, html: channelLinks(rendered.html, channel) }
      }

      const loadAll = async () => {
        const names = (await fs.readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".md"))
        const entries = await Promise.all(
          names.toSorted().map(async (name) => {
            const fileUrl = new URL(name, directory)
            const contents = await fs.readFile(fileUrl, "utf8")
            const { data } = await entryType.getEntryInfo({ contents, fileUrl })
            const { body, bodyLine } = splitFrontmatter(contents)
            const notes = parseReleaseNotes(basename(name, ".md"), data, body, bodyLine)
            const changes = await Promise.all(
              notes.entries.map(async (entry) => ({
                section: entry.section,
                docs: entry.docs,
                html: unwrapParagraph((await render(entry.markdown, fileUrl)).html),
              })),
            )
            const releaseData: ReleaseNotesData = {
              version: notes.version,
              date: notes.date,
              summary: notes.summary,
              entries: changes,
            }
            return {
              id: notes.version,
              data: releaseData as unknown as Record<string, unknown>,
              body,
              filePath: relative(fileURLToPath(context.config.root), fileURLToPath(fileUrl)),
              digest: context.generateDigest(contents),
              rendered: await render(body, fileUrl),
            }
          }),
        )
        context.store.clear()
        for (const entry of entries) context.store.set(entry)
      }

      await loadAll()

      if (context.watcher) {
        context.watcher.add(fileURLToPath(directory))
        const reload = (file: string) => {
          if (!file.startsWith(fileURLToPath(directory)) || !file.endsWith(".md")) return
          void loadAll().catch((error) => context.logger.error(error instanceof Error ? error.message : String(error)))
        }
        context.watcher.on("add", reload)
        context.watcher.on("change", reload)
        context.watcher.on("unlink", reload)
      }
    },
  }
}

/** Maps the /docs links of rendered HTML to the channel. */
export function channelLinks(html: string, channel: Pick<DocsChannel, "base">): string {
  return html.replace(/(<a\s[^>]*?href=")(\/docs[^"]*)"/g, (_, start: string, href: string) => {
    return `${start}${channelUrl(href, channel)}"`
  })
}

function unwrapParagraph(html: string): string {
  const trimmed = html.trim()
  const match = trimmed.match(/^<p>([\s\S]*)<\/p>$/)
  return match && !match[1].includes("<p>") ? match[1] : trimmed
}
