export interface SearchEntry {
  chapter: string
  title: string
  navTitle: string
  url: string
  text: string
  symbols: string[]
}

export interface SearchPattern {
  tokens: string[]
  first: RegExp
  words: RegExp
  anywhere: RegExp[]
}

export interface SearchMatch {
  entry: SearchEntry
  pattern: SearchPattern
  score: number
}

export interface HighlightPart {
  text: string
  mark: boolean
}

const PREVIEW_LENGTH = 160

// Identity bands. A lower band cannot outrank a higher one by repeating a
// term in the body. Prefix matches keep pages above headings, so "rea"
// prefers React bindings over a one-word React heading.
const KIND_EXACT_PAGE_TITLE = 9
const KIND_EXACT_PAGE_NAV = 8
const KIND_EXACT_HEADING_TITLE = 7
const KIND_EXACT_PAGE_SYMBOL = 6
const KIND_WHOLE_PAGE_TITLE = 5
const KIND_WHOLE_HEADING_TITLE = 4
const KIND_PREFIX_PAGE_TITLE = 3
const KIND_PREFIX_HEADING_TITLE = 2
const KIND_BODY = 1

export function lookup(entries: SearchEntry[], query: string): SearchMatch[] {
  const pattern = compile(query)
  if (!pattern) return []

  return entries
    .map((entry) => ({ entry, pattern, score: score(entry, pattern) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.url.localeCompare(b.entry.url))
}

export function compile(query: string): SearchPattern | null {
  const tokens = tokenize(query)
  const sources = tokens.map(quote)
  if (!sources.length) return null

  return {
    tokens,
    anywhere: sources.map((source) => matcher(source, "giu")),
    first: matcher(`(?:${sources.join("|")})`, "iu"),
    words: matcher(`(${sources.map((source) => `${source}[\\p{L}\\p{N}]*`).join("|")})`, "giu"),
  }
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#_-]+/u)
    .filter(Boolean)
}

export function preview(text: string, pattern: SearchPattern): string {
  const at = text.search(pattern.first)
  const start = Math.max(0, at - PREVIEW_LENGTH / 3)
  let snippet = text.slice(start, start + PREVIEW_LENGTH)

  if (start > 0) snippet = `…${snippet.replace(/^\S*\s/, "")}`
  if (start + PREVIEW_LENGTH < text.length) snippet = `${snippet.replace(/\s\S*$/, "")}…`

  return snippet
}

export function highlightParts(text: string, pattern: SearchPattern): HighlightPart[] {
  return text.split(pattern.words).map((part, index) => ({
    text: part,
    mark: index % 2 === 1,
  }))
}

export function score(entry: SearchEntry, pattern: SearchPattern): number {
  if (!covers(entry, pattern)) return 0

  const page = isPage(entry)
  const title = tokenize(entry.title)
  const nav = tokenize(entry.navTitle)
  const titleRemainder = prefixRemainder(pattern.tokens, title)
  const navRemainder = page ? prefixRemainder(pattern.tokens, nav) : undefined
  const kind = matchKind(entry, pattern, page, title, nav, titleRemainder, navRemainder)
  let tightness = 0
  if (titleRemainder !== undefined) tightness = 4000 - titleRemainder * 20 - title.length
  else if (navRemainder !== undefined) tightness = 3800 - navRemainder * 20 - nav.length
  else if (page && exactSymbol(pattern.tokens, entry.symbols)) {
    tightness = symbolAffinity(entry.title, entry.navTitle, pattern.tokens)
  }

  return kind * 1_000_000 + tightness * 1_000
}

function covers(entry: SearchEntry, pattern: SearchPattern): boolean {
  const page = isPage(entry)

  for (const term of pattern.anywhere) {
    if (hit(entry.title, term)) continue
    if (hit(entry.text, term)) continue
    if (page && hit(entry.navTitle, term)) continue
    if (page && entry.symbols.some((symbol) => hit(symbol, term))) continue
    return false
  }

  return true
}

function matchKind(
  entry: SearchEntry,
  pattern: SearchPattern,
  page: boolean,
  title: string[],
  nav: string[],
  titleRemainder: number | undefined,
  navRemainder: number | undefined,
): number {
  if (sameTokens(pattern.tokens, title)) {
    return page ? KIND_EXACT_PAGE_TITLE : KIND_EXACT_HEADING_TITLE
  }

  if (page && sameTokens(pattern.tokens, nav)) {
    return KIND_EXACT_PAGE_NAV
  }

  if (page && exactSymbol(pattern.tokens, entry.symbols)) {
    return KIND_EXACT_PAGE_SYMBOL
  }

  if (allWholeTokens(pattern.tokens, title) || (page && allWholeTokens(pattern.tokens, nav))) {
    return page ? KIND_WHOLE_PAGE_TITLE : KIND_WHOLE_HEADING_TITLE
  }

  if (titleRemainder !== undefined || navRemainder !== undefined) {
    return page ? KIND_PREFIX_PAGE_TITLE : KIND_PREFIX_HEADING_TITLE
  }

  return KIND_BODY
}

function symbolAffinity(title: string, navTitle: string, query: string[]): number {
  const foldedQuery = query.map(normalizeToken).join("")
  const titleFolded = tokenize(title).map(normalizeToken).join("")
  const navFolded = tokenize(navTitle).map(normalizeToken).join("")

  if (titleFolded && foldedQuery.includes(titleFolded)) return 800 - titleFolded.length
  if (navFolded && foldedQuery.includes(navFolded)) return 700 - navFolded.length
  return 0
}

function isPage(entry: SearchEntry): boolean {
  return !entry.url.includes("#")
}

function hit(text: string, term: RegExp): boolean {
  term.lastIndex = 0
  return term.test(text)
}

function sameTokens(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((token, index) => normalizeToken(token) === normalizeToken(right[index]))
  )
}

function allWholeTokens(query: string[], field: string[]): boolean {
  const haystack = new Set(field.map(normalizeToken))
  return query.every((token) => haystack.has(normalizeToken(token)))
}

function prefixRemainder(query: string[], field: string[]): number | undefined {
  const haystack = field.map(normalizeToken)
  let total = 0

  for (const token of query) {
    const needle = normalizeToken(token)
    let best: number | undefined

    for (const candidate of haystack) {
      if (!candidate.startsWith(needle)) continue
      const remainder = candidate.length - needle.length
      if (best === undefined || remainder < best) best = remainder
    }

    if (best === undefined) return undefined
    total += best
  }

  return total
}

function exactSymbol(query: string[], symbols: string[]): boolean {
  const foldedQuery = query.map(normalizeToken).join("")

  return symbols.some((symbol) => {
    return sameTokens(query, tokenize(symbol)) || normalizeToken(symbol) === foldedQuery
  })
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/-/g, "")
}

function matcher(source: string, flags: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${source}`, flags)
}

function quote(term: string): string {
  return [...term].map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("-?")
}
