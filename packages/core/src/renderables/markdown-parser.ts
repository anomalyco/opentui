import { Lexer, type MarkedToken } from "marked"

export interface ParseState {
  content: string
  tokens: MarkedToken[]
  stableTokenCount?: number
}

// A definition still open at the end of the text (label, destination or title), which marked lexes as paragraphs until
// it closes; its label and title can span blank lines, so the tokens after its start are not final yet
const openDefinition =
  / {0,3}\[(?:\\[\s\S]|[^[\]\\])*\\?(?:\](?:: *\n?[ \t]*(?:\S+(?: +\n?| *\n)[ \t]*(?:"(?:\\[\s\S]|[^"\\])*|'[^']*|\([^()]*))?)?)?$/y

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

  for (const token of prevTokens) {
    if (!newContent.startsWith(token.raw, offset)) break
    openDefinition.lastIndex = offset
    if (reuseCount >= stable && openDefinition.test(prevState!.content)) break
    reuseCount++
    offset += token.raw.length
  }

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
  const remainingContent = newContent.slice(stableTokens.reduce((length, token) => length + token.raw.length, 0))

  try {
    // The tail knows the stable definitions, so it drops a repeated label as a lex of the whole text does
    const lexer = new Lexer({ gfm: true })
    addDefinitions(lexer.tokens.links, stableTokens)
    const newTokens = lexer.lex(remainingContent) as MarkedToken[]
    if (confirm && newTokens[0]?.raw === prevTokens[reuseCount].raw) newTokens[0] = prevTokens[reuseCount++]
    const tokens = [...stableTokens, ...newTokens]
    // Apps commit a stable block's rows up to the next block, so a block that dropped definitions left last waits
    if (tokens.slice(reuseCount).every((token) => token.type === "space")) reuseCount = Math.min(reuseCount, stable)
    return { content: newContent, tokens, stableTokenCount: reuseCount }
  } catch {
    try {
      const fullTokens = Lexer.lex(newContent, { gfm: true }) as MarkedToken[]
      return { content: newContent, tokens: fullTokens, stableTokenCount: 0 }
    } catch {
      return { content: newContent, tokens: [], stableTokenCount: 0 }
    }
  }
}

function addDefinitions(links: Lexer["tokens"]["links"], tokens: MarkedToken[]): void {
  for (const token of tokens) {
    if (token.type === "def") links[token.tag] ??= token
    if (token.type === "list") for (const item of token.items) addDefinitions(links, item.tokens as MarkedToken[])
    if (token.type === "blockquote") addDefinitions(links, token.tokens as MarkedToken[])
  }
}
