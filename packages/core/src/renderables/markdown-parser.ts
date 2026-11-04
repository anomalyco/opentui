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
  if (
    trailingUnstable === 0 &&
    prevState?.content === newContent &&
    prevState.stableTokenCount === prevState.tokens.length
  )
    return prevState
  if (!prevState || prevState.tokens.length === 0 || trailingUnstable === 0) {
    try {
      const tokens = Lexer.lex(newContent, { gfm: true }) as MarkedToken[]
      return {
        content: newContent,
        tokens,
        stableTokenCount: Math.max(0, tokens.length - trailingUnstable),
      }
    } catch {
      return { content: newContent, tokens: [], stableTokenCount: 0 }
    }
  }

  // Find how many tokens from start are unchanged
  let offset = 0
  let reuseCount = 0

  for (const token of prevState.tokens) {
    const tokenLength = token.raw.length
    if (offset + tokenLength <= newContent.length && newContent.startsWith(token.raw, offset)) {
      reuseCount++
      offset += tokenLength
    } else {
      break
    }
  }

  // Keep last N tokens unstable (e.g. "# Hello" might become "# Hello World")
  reuseCount = Math.max(0, reuseCount - trailingUnstable)

  offset = 0
  for (let i = 0; i < reuseCount; i++) {
    offset += prevState.tokens[i].raw.length
  }

  const stableTokens = prevState.tokens.slice(0, reuseCount)
  const remainingContent = newContent.slice(offset)

  try {
    const newTokens = Lexer.lex(remainingContent, { gfm: true }) as MarkedToken[]
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
