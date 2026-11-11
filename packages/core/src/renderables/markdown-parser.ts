import { Lexer, type MarkedToken } from "marked"

export interface ParseState {
  content: string
  tokens: MarkedToken[]
  stableTokenCount?: number
}

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

  // Find how many tokens from start are unchanged
  const prevTokens = prevState?.tokens ?? []
  let offset = 0
  let reuseCount = 0

  for (const token of prevTokens) {
    if (!newContent.startsWith(token.raw, offset)) break
    reuseCount++
    offset += token.raw.length
  }

  // A streamed parse keeps its stable tokens while they match; a parse that did not stream has none. Tokens with N
  // after them (e.g. "# Hello" might become "# Hello World") become stable, but the last is lexed again with the tail,
  // which can still continue it (a list item after a blank line). It stays only if it comes back unchanged and the
  // last line is not digits that can still become an item's marker ("1. a\n\n10").
  const stable = prevState?.stableTokenCount ?? 0
  const keptCount =
    stable < prevTokens.length ? Math.max(0, reuseCount - trailingUnstable, stable <= reuseCount ? stable : 0) : 0
  reuseCount = keptCount > stable ? keptCount - 1 : keptCount
  const confirm = reuseCount < keptCount && !/(^|\n)[ \t]*\d{1,9}$/.test(newContent)

  const stableTokens = prevTokens.slice(0, reuseCount)
  const remainingContent = newContent.slice(stableTokens.reduce((length, token) => length + token.raw.length, 0))

  try {
    const newTokens = Lexer.lex(remainingContent, { gfm: true }) as MarkedToken[]
    if (confirm && newTokens[0]?.raw === prevTokens[reuseCount].raw) {
      newTokens.shift()
      stableTokens.push(prevTokens[reuseCount])
    }
    return {
      content: newContent,
      tokens: [...stableTokens, ...newTokens],
      stableTokenCount: stableTokens.length,
    }
  } catch {
    try {
      const fullTokens = Lexer.lex(newContent, { gfm: true }) as MarkedToken[]
      return { content: newContent, tokens: fullTokens, stableTokenCount: 0 }
    } catch {
      return { content: newContent, tokens: [], stableTokenCount: 0 }
    }
  }
}
