import { Lexer, type Links, type MarkedToken } from "marked"

export interface ParseState {
  content: string
  tokens: MarkedToken[]
  stableTokenCount?: number
  /** The link definitions of the stable tokens. */
  links?: Links
}

// A definition still open at the end of the text (label, destination or title), which marked lexes as paragraphs until
// it closes; its label and title can span blank lines, so the tokens after its start are not final yet
const openDefinition =
  / {0,3}\[(?:\\[\s\S]|[^[\]\\])*\\?(?:\](?:: *\n?[ \t]*(?:<[^\n>]*|(?:<.*?>|[^<\s]\S*)(?: +\n?| *\n)[ \t]*(?:"(?:\\"?|[^"\\])*|'[^']*|\([^()]*))?)?)?$/y
// marked's definition rule, which drops a repeated label's text from the tokens
const definition = new RegExp(Lexer.rules.block.normal.def.source.slice(1), "y")

/**
 * Incrementally parse markdown, reusing unchanged tokens from previous parse.
 * Compares token.raw at each offset - matching tokens keep same object reference.
 * trailingUnstable 0 lexes it all unless nothing changed since a lex at 0: an edit can grow any block or add a link def.
 */
export function parseMarkdownIncremental(
  newContent: string,
  prevState: ParseState | null,
  trailingUnstable: number = 2,
): ParseState {
  if (trailingUnstable === 0) {
    if (prevState?.content === newContent && prevState.stableTokenCount === prevState.tokens.length) return prevState
    try {
      const tokens = Lexer.lex(newContent, { gfm: true }) as MarkedToken[]
      return { content: newContent, tokens, stableTokenCount: tokens.length }
    } catch {
      return { content: newContent, tokens: [], stableTokenCount: 0 }
    }
  }

  // Find how many tokens from start are unchanged by an append; any other edit parses afresh
  const prevTokens = prevState && newContent.startsWith(prevState.content) ? prevState.tokens : []
  const stable = prevState?.stableTokenCount ?? 0
  let offset = 0
  let reuseCount = 0
  const starts: number[] = []

  for (const token of prevTokens) {
    starts.push(offset)
    offset = locate(prevState!.content, token, offset, reuseCount >= stable)
    if (offset < 0) break
    reuseCount++
    offset += token.raw.length
  }
  starts[reuseCount] ??= offset

  // A streamed parse keeps its stable tokens; a parse that did not stream has none. Tokens with N after them (e.g.
  // "# Hello" might become "# Hello World") become stable, but the last is lexed again with the tail, which can still
  // continue it (a list item after a blank line). It stays only if it comes back unchanged and, for a list, the last
  // line cannot still become its item ("1. a\n\n10", "- a\n\n- - -").
  const keptCount = stable < prevTokens.length ? Math.max(reuseCount - trailingUnstable, stable) : 0
  reuseCount = keptCount > stable ? keptCount - 1 : keptCount
  const confirm =
    reuseCount < keptCount &&
    (prevTokens[reuseCount].type !== "list" || !/(^|\n)[ \t]*(\d{1,9}|[-*][-* \t]*)$/.test(newContent))

  const stableTokens = prevTokens.slice(0, reuseCount)
  const known = reuseCount >= stable ? (prevState?.links ?? {}) : {}

  try {
    // The tail knows the stable definitions, so it drops a repeated label as a lex of the whole text does
    const links = define({ ...known }, stableTokens.slice(stable))
    const lexer = new Lexer({ gfm: true })
    Object.assign(lexer.tokens.links, links)
    const newTokens = lexer.lex(newContent.slice(starts[reuseCount])) as MarkedToken[]
    if (confirm && newTokens[0]?.raw === prevTokens[reuseCount].raw) newTokens[0] = prevTokens[reuseCount++]
    const tokens = [...stableTokens, ...newTokens]
    const stableLinks = reuseCount > stable ? define(links, tokens.slice(stableTokens.length, reuseCount)) : known
    return { content: newContent, tokens, stableTokenCount: reuseCount, links: stableLinks }
  } catch {
    try {
      const fullTokens = Lexer.lex(newContent, { gfm: true }) as MarkedToken[]
      return { content: newContent, tokens: fullTokens, stableTokenCount: 0 }
    } catch {
      return { content: newContent, tokens: [], stableTokenCount: 0 }
    }
  }
}

// Where `token` starts in `text`, the text it was lexed from, at `offset` or after the repeated definitions there that
// marked dropped from the tokens; -1 if it does not, or if `hold` and a definition there is still open.
function locate(text: string, token: MarkedToken, offset: number, hold: boolean): number {
  for (;;) {
    openDefinition.lastIndex = offset
    if (hold && openDefinition.test(text)) return -1
    definition.lastIndex = offset
    const dropped = definition.exec(text)?.[0]
    if (dropped === undefined || dropped === token.raw) return text.startsWith(token.raw, offset) ? offset : -1
    offset += dropped.length
  }
}

// A token's own lex finds the definitions it registered, also those marked dropped from a quote's children
function define(links: Links, tokens: MarkedToken[]): Links {
  for (const token of tokens) {
    if (!token.raw.includes("]:")) continue
    for (const [tag, link] of Object.entries(Lexer.lex(token.raw, { gfm: true }).links)) links[tag] ??= link
  }
  return links
}
