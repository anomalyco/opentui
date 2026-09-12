import { readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { closesFence, getFenceMarker, slugifyHeading } from "./docs-headings"
import { buildDocsIndex, type DocPage } from "./docs-index"
import type { SearchEntry } from "./docs-search"

const WORKING_DIRECTORY = process.cwd()
const REPO_ROOT =
  basename(WORKING_DIRECTORY) === "web" && basename(dirname(WORKING_DIRECTORY)) === "packages"
    ? join(WORKING_DIRECTORY, "../..")
    : WORKING_DIRECTORY

let searchIndexPromise: Promise<SearchEntry[]> | undefined

export async function buildDocsSearchIndex(): Promise<SearchEntry[]> {
  if (import.meta.env.DEV) return loadDocsSearchIndex()

  searchIndexPromise ??= loadDocsSearchIndex()
  return searchIndexPromise
}

export function searchEntriesForPage(
  page: Pick<DocPage, "title" | "navTitle" | "url" | "description" | "searchSymbols">,
  content: string,
): SearchEntry[] {
  const sections = splitSections(page.title, content)
  const extra = extraSearchText(page)

  return sections.map((section, index) => ({
    chapter: page.title,
    title: section.title,
    navTitle: section.anchor ? "" : page.navTitle,
    url: section.anchor ? `${page.url}#${section.anchor}` : page.url,
    text: index === 0 && extra ? joinText(section.text, extra) : section.text,
    symbols: section.anchor ? [] : [...page.searchSymbols],
  }))
}

async function loadDocsSearchIndex(): Promise<SearchEntry[]> {
  const index = await buildDocsIndex()
  const entries: SearchEntry[] = []

  for (const page of index.pages) {
    const source = await readFile(join(REPO_ROOT, page.sourcePath), "utf8")
    entries.push(...searchEntriesForPage(page, stripFrontmatter(source)))
  }

  return entries
}

interface Section {
  title: string
  anchor: string
  text: string
}

function splitSections(pageTitle: string, content: string): Section[] {
  const sections: Section[] = []
  const anchorCounts = new Map<string, number>()
  let current: { title: string; anchor: string; lines: string[] } | undefined
  let fence: { marker: string; length: number } | undefined
  let jsx = 0

  const flush = () => {
    if (!current) return
    const text = toSearchText(current.lines.join("\n"))
    // Drop an empty preamble before the first heading. The page title
    // still gets an entry after the loop if none remains.
    if (text || current.anchor) {
      sections.push({ title: current.title, anchor: current.anchor, text })
    }
    current = undefined
  }

  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = rawLine.trim()
    if (!trimmed && !fence && jsx === 0) continue

    const fenceMarker = getFenceMarker(trimmed)

    if (!fence && fenceMarker) {
      fence = fenceMarker
      current?.lines.push(rawLine)
      continue
    }

    if (fence && closesFence(trimmed, fence)) {
      fence = undefined
      current?.lines.push(rawLine)
      continue
    }

    if (fence) {
      current?.lines.push(rawLine)
      continue
    }

    if (jsx > 0) {
      jsx += jsxDelta(rawLine)
      continue
    }

    if (isSkippedLine(trimmed)) {
      continue
    }

    if (/^<[A-Z]/.test(trimmed)) {
      jsx = Math.max(0, jsx + jsxDelta(rawLine))
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const depth = heading[1].length
      const title = headingText(heading[2])
      if (!title) continue

      flush()

      if (depth === 1) {
        current = { title: pageTitle, anchor: "", lines: [] }
        continue
      }

      const baseAnchor = slugifyHeading(heading[2])
      const duplicateIndex = anchorCounts.get(baseAnchor) ?? 0
      anchorCounts.set(baseAnchor, duplicateIndex + 1)

      current = {
        title,
        anchor: duplicateIndex === 0 ? baseAnchor : `${baseAnchor}-${duplicateIndex}`,
        lines: [],
      }
      continue
    }

    current ??= { title: pageTitle, anchor: "", lines: [] }
    current.lines.push(rawLine)
  }

  flush()
  if (sections.length === 0 || sections[0].anchor) {
    sections.unshift({ title: pageTitle, anchor: "", text: "" })
  }
  return sections
}

function toSearchText(source: string): string {
  const lines: string[] = []
  let fence: { marker: string; length: number } | undefined

  for (const rawLine of source.split("\n")) {
    const trimmed = rawLine.trim()
    const fenceMarker = getFenceMarker(trimmed)

    if (!fence && fenceMarker) {
      fence = fenceMarker
      continue
    }

    if (fence && closesFence(trimmed, fence)) {
      fence = undefined
      continue
    }

    if (fence) {
      if (trimmed) lines.push(trimmed)
      continue
    }

    if (!trimmed || isSkippedLine(trimmed) || isTableRule(trimmed)) {
      continue
    }

    const stripped = stripMarkup(trimmed)
    if (stripped) lines.push(stripped)
  }

  return joinText(...lines)
}

function stripMarkup(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .replace(/\|/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

function headingText(raw: string): string {
  return stripMarkup(raw.replace(/\s*\{#[^}]+\}\s*$/, ""))
}

function extraSearchText(page: Pick<DocPage, "description" | "searchSymbols">): string {
  return joinText(page.description ?? "", ...page.searchSymbols)
}

function joinText(...parts: string[]): string {
  return parts.join(" ").replace(/\s+/g, " ").trim()
}

function stripFrontmatter(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "")
}

function isSkippedLine(line: string): boolean {
  return /^import\s/.test(line) || /^export\s/.test(line) || /^\{[\s/*]/.test(line)
}

function isTableRule(line: string): boolean {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(line)
}

function jsxDelta(line: string): number {
  const open = line.match(/<[A-Z][A-Za-z0-9.]*/g)?.length ?? 0
  const selfClose = line.match(/\/>/g)?.length ?? 0
  const close = line.match(/<\/[A-Z][A-Za-z0-9.]*>/g)?.length ?? 0
  return open - selfClose - close
}
