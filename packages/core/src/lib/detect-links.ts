import type { TextChunk } from "../text-buffer.js"
import type { SimpleHighlight } from "./tree-sitter/types.js"

const URL_SCOPES = ["markup.link.url", "string.special.url"]
const HTTP_URL_PREFIX = /https?:\/\//i
const BARE_URL = /https?:\/\/[^\s<>"`]+/gi

export function normalizeMarkdownLinkTarget(destination: string): string {
  return destination.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1")
}

export function detectLinks(
  chunks: TextChunk[],
  context: { content: string; highlights: SimpleHighlight[]; sourceRanges?: Array<{ start: number; end: number }> },
): TextChunk[] {
  const content = context.content
  const highlights = context.highlights
  const hasBareUrl = HTTP_URL_PREFIX.test(content)
  if (!hasBareUrl && !highlights.some(([, , group]) => URL_SCOPES.includes(group))) return chunks

  const ranges: Array<{ start: number; end: number; url: string; label?: boolean }> = []
  const rawRanges: Array<{ start: number; end: number }> = []
  const labels = new Map<number, { start: number; end: number }>()
  const concealedDelimiters = new Map<number, number>()

  for (let i = 0; i < highlights.length; i++) {
    const [start, end, group, meta] = highlights[i]
    if (group === "conceal" && meta?.conceal === "" && /^[*_~]+$/.test(content.slice(start, end))) {
      concealedDelimiters.set(end, start)
    }
    if (group === "markup.raw" || group.startsWith("markup.raw.")) {
      rawRanges.push({ start, end })
    }
    if (group === "markup.link.label") {
      const existing = labels.get(end)
      if (!existing || start < existing.start) labels.set(end, { start, end })
    }
    if (!URL_SCOPES.includes(group)) continue

    const url = content.slice(start, end)
    if (!url) continue
    ranges.push({ start, end, url })
  }

  const highlightedCount = ranges.length
  for (let index = 0; index < highlightedCount; index++) {
    const range = ranges[index]
    let labelEnd = range.start
    if (content[labelEnd - 1] === "<") labelEnd--
    while (labelEnd > 0 && /\s/.test(content[labelEnd - 1])) labelEnd--
    if (content[labelEnd - 1] !== "(" || content[labelEnd - 2] !== "]") continue

    const label = labels.get(labelEnd - 2)
    if (!label) continue
    range.url = normalizeMarkdownLinkTarget(range.url)
    ranges.push({ ...label, url: range.url, label: true })
  }

  if (hasBareUrl) {
    rawRanges.sort((a, b) => a.start - b.start || b.end - a.end)
    ranges.sort((a, b) => a.start - b.start || b.end - a.end)
    let rawIndex = 0
    let highlightedIndex = 0

    for (const match of content.matchAll(BARE_URL)) {
      const start = match.index
      let url = match[0]
      let openParens = 0
      let closeParens = 0
      for (const character of url) {
        if (character === "(") openParens++
        if (character === ")") closeParens++
      }

      while (url.length > 0) {
        const delimiterStart = concealedDelimiters.get(start + url.length)
        if (delimiterStart !== undefined && delimiterStart >= start) {
          url = url.slice(0, delimiterStart - start)
          continue
        }
        const last = url[url.length - 1]
        if (last === ")" && closeParens > openParens) {
          closeParens--
        } else if (!".,!?;:]}'".includes(last)) {
          break
        }
        url = url.slice(0, -1)
      }

      const end = start + url.length
      if (!url) continue

      while (rawIndex < rawRanges.length && rawRanges[rawIndex].end <= start) rawIndex++
      if (rawIndex < rawRanges.length && rawRanges[rawIndex].start < end) continue

      while (highlightedIndex < ranges.length && ranges[highlightedIndex].end <= start) highlightedIndex++
      if (highlightedIndex < ranges.length && ranges[highlightedIndex].start < end) continue

      ranges.push({ start, end, url })
    }
  }

  if (ranges.length === 0) return chunks
  ranges.sort((a, b) => a.start - b.start || b.end - a.end || Number(b.label ?? false) - Number(a.label ?? false))

  const linkedChunks: TextChunk[] = []
  let contentPos = 0
  let rangeIndex = 0
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    if (!chunk.text || chunk.link) {
      linkedChunks.push(chunk)
      continue
    }

    const providedRange = context.sourceRanges?.[index]
    const start = providedRange?.start ?? content.indexOf(chunk.text, contentPos)
    if (start < 0) {
      linkedChunks.push(chunk)
      continue
    }
    const end = providedRange?.end ?? start + chunk.text.length
    contentPos = end
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= start) rangeIndex++

    if (content.slice(start, end) !== chunk.text) {
      const range = ranges[rangeIndex]
      if (range?.label && range.start < end) chunk.link = { url: range.url }
      linkedChunks.push(chunk)
      continue
    }

    let position = start
    for (; rangeIndex < ranges.length; rangeIndex++) {
      const range = ranges[rangeIndex]
      if (range.end <= position) continue
      if (range.start >= end) break

      const linkStart = Math.max(position, range.start)
      const linkEnd = Math.min(end, range.end)
      if (linkStart > position) {
        linkedChunks.push({ ...chunk, text: chunk.text.slice(position - start, linkStart - start) })
      }

      if (linkStart === start && linkEnd === end) {
        chunk.link = { url: range.url }
        linkedChunks.push(chunk)
      } else {
        linkedChunks.push({
          ...chunk,
          text: chunk.text.slice(linkStart - start, linkEnd - start),
          link: { url: range.url },
        })
      }
      position = linkEnd
      if (position === end) break
    }

    if (position === start) {
      linkedChunks.push(chunk)
    } else if (position < end) {
      linkedChunks.push({ ...chunk, text: chunk.text.slice(position - start) })
    }
  }

  return linkedChunks
}
