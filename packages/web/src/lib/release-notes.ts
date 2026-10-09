// Release notes are documentation files, one per release: src/content/docs/releases/<version>.md. Like Go's
// go.dev/doc/go1.N, each describes what changed for users. The site also reads every entry's /docs links to list
// the changes on the documentation pages they name.
//
// A file has YAML frontmatter with `date` (YYYY-MM-DD) and `summary` (one sentence for the release history),
// optional introductory paragraphs, and then sections. Each section is one of RELEASE_SECTIONS, in that order,
// and holds a bullet list with one change per bullet. Notes are Markdown without HTML, and they link only to
// /docs pages and https URLs: drafts come from a model that reads contributors' pull request descriptions, and
// the notes reach the site, the GitHub release, and the agent skill.

import { compareVersions } from "./api-history"

export const RELEASE_SECTIONS = [
  "Breaking changes",
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
] as const

export type ReleaseSection = (typeof RELEASE_SECTIONS)[number]

export interface ReleaseEntry {
  section: ReleaseSection
  /** Markdown of the bullet without its marker. */
  markdown: string
  /** Logical documentation page URLs the entry links to, without fragments. */
  docs: string[]
}

export interface ReleaseNotes {
  version: string
  date: string
  summary: string
  body: string
  entries: ReleaseEntry[]
}

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

export class ReleaseNotesError extends Error {}

/** Splits a file into its YAML frontmatter and its body, with the body's first line number. */
export function splitFrontmatter(source: string): { yaml: string; body: string; bodyLine: number } {
  const text = source.replace(/\r\n/g, "\n")
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!frontmatter) throw new ReleaseNotesError("missing frontmatter")
  return {
    yaml: frontmatter[1],
    body: text.slice(frontmatter[0].length),
    bodyLine: frontmatter[0].split("\n").length,
  }
}

/** Checks a release notes file, given its parsed frontmatter. Throws ReleaseNotesError naming the line. */
export function parseReleaseNotes(
  version: string,
  frontmatter: Record<string, unknown>,
  body: string,
  bodyLine = 1,
): ReleaseNotes {
  if (!VERSION_PATTERN.test(version)) throw new ReleaseNotesError(`${version}: the file name must be a version`)

  const data = frontmatter
  const date = data.date instanceof Date ? data.date.toISOString().slice(0, 10) : data.date
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ReleaseNotesError(`${version}: frontmatter date must be YYYY-MM-DD`)
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    throw new ReleaseNotesError(`${version}: frontmatter summary must be one sentence`)
  }
  const unknown = Object.keys(data).filter((key) => key !== "date" && key !== "summary")
  if (unknown.length > 0) throw new ReleaseNotesError(`${version}: unknown frontmatter ${unknown.join(", ")}`)

  return { version, date, summary: data.summary.trim(), body, entries: parseEntries(version, body, bodyLine) }
}

function parseEntries(version: string, body: string, firstLine: number): ReleaseEntry[] {
  const entries: ReleaseEntry[] = []
  const lines = body.split("\n")
  let section: ReleaseSection | undefined
  let sectionIndex = -1
  let current: { section: ReleaseSection; lines: string[] } | undefined
  let fence = false

  const flush = () => {
    if (!current) return
    const markdown = current.lines.join("\n").trim()
    entries.push({ section: current.section, markdown, docs: docsLinks(markdown) })
    current = undefined
  }

  lines.forEach((line, index) => {
    const at = `${version}.md:${index + firstLine}`
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) {
      current?.lines.push(line)
      return
    }
    checkMarkup(line, at)

    const heading = line.match(/^(#{1,6})\s+(.*?)\s*$/)
    if (heading) {
      flush()
      if (heading[1] !== "##") throw new ReleaseNotesError(`${at}: use only ## section headings`)
      const next = RELEASE_SECTIONS.indexOf(heading[2] as ReleaseSection)
      if (next === -1) throw new ReleaseNotesError(`${at}: unknown section "${heading[2]}"`)
      if (next <= sectionIndex)
        throw new ReleaseNotesError(`${at}: sections must follow ${RELEASE_SECTIONS.join(", ")}`)
      section = RELEASE_SECTIONS[next]
      sectionIndex = next
      return
    }

    const bullet = line.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      if (!section) throw new ReleaseNotesError(`${at}: a change must be under a section heading`)
      flush()
      current = { section, lines: [bullet[1]] }
      return
    }

    if (!line.trim()) {
      current?.lines.push("")
      return
    }

    if (current && /^\s+/.test(line)) {
      current.lines.push(line.replace(/^ {1,2}/, ""))
      return
    }

    if (section) throw new ReleaseNotesError(`${at}: write each change as a bullet`)
  })
  flush()
  return entries
}

/** Rejects HTML and links other than /docs pages, https URLs, and fragments, outside code spans. */
function checkMarkup(line: string, at: string) {
  const text = line.replace(/(`+)[\s\S]*?\1/g, "")
  if (/<(?!https:\/\/[^\s>]+>)[a-zA-Z!/?]/.test(text)) {
    throw new ReleaseNotesError(`${at}: write Markdown, not HTML`)
  }
  const targets = [
    ...[...text.matchAll(/\]\(\s*<?([^)\s>]*)/g)].map((match) => match[1]),
    ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S*?)>?(\s|$)/g)].map((match) => match[1]),
  ]
  for (const target of targets) {
    if (!/^(\/docs([/?#]|$)|https:\/\/|#)/.test(target)) {
      throw new ReleaseNotesError(`${at}: link to /docs pages or https URLs, not "${target}"`)
    }
  }
}

/** Logical /docs page URLs in markdown links, without fragments or queries, in order of first use. */
export function docsLinks(markdown: string): string[] {
  const urls = new Set<string>()
  for (const match of markdown.matchAll(/\]\((\/docs(?:[/?#][^)\s]*)?)(?:\s+"[^"]*")?\)/g)) {
    const url = match[1].replace(/[?#].*$/, "").replace(/\/+$/, "")
    urls.add(url || "/docs")
  }
  return [...urls]
}

/**
 * The releases a channel lists, newest first: each version with release notes or an API history file. The
 * release channel stops at its release; the main-branch channel also lists newer ones, such as a release whose
 * notes are merged before npm serves it.
 */
export function channelVersions(channel: { id: "stable" | "next"; release: string }, ...sources: string[][]): string[] {
  return [...new Set(sources.flat())]
    .filter((version) => channel.id === "next" || compareVersions(version, channel.release) <= 0)
    .sort((left, right) => compareVersions(right, left))
}

/** The release line of a version: 0.5 for 0.5.17. */
export function releaseLine(version: string): string {
  return version.split(".").slice(0, 2).join(".")
}
