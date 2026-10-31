import { Lexer, type MarkedToken } from "marked"

export interface ParseState {
  content: string
  tokens: MarkedToken[]
  stableTokenCount?: number
}

/**
 * Incrementally parse markdown, reusing unchanged tokens from previous parse.
 * Compares token.raw at each offset - matching tokens keep same object reference.
 */
export function parseMarkdownIncremental(
  newContent: string,
  prevState: ParseState | null,
  trailingUnstable: number = 2,
): ParseState {
  if (!prevState || prevState.tokens.length === 0) {
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

  // Appended text can extend the last block, even when the caller treats every token as stable:
  // "> one" + "\n> two" is one blockquote, and a list followed by a space token ("- a", "\n\n")
  // plus "- b" is one loose list. Always re-lex the last two tokens; trailingUnstable can widen
  // the window (e.g. "# Hello" might become "# Hello World" while streaming).
  reuseCount = Math.max(0, reuseCount - Math.max(trailingUnstable, 2))

  offset = 0
  for (let i = 0; i < reuseCount; i++) {
    offset += prevState.tokens[i].raw.length
  }

  const stableTokens = prevState.tokens.slice(0, reuseCount)
  const remainingContent = newContent.slice(offset)

  if (!remainingContent) {
    return {
      content: newContent,
      tokens: stableTokens,
      stableTokenCount: stableTokens.length,
    }
  }

  try {
    const newTokens = Lexer.lex(remainingContent, { gfm: true }) as MarkedToken[]
    // Re-lexed tokens that come out unchanged keep their previous object
    for (let i = 0; i < newTokens.length; i++) {
      const prevToken = prevState.tokens[reuseCount + i]
      if (!prevToken || prevToken.type !== newTokens[i].type || prevToken.raw !== newTokens[i].raw) break
      newTokens[i] = prevToken
    }
    return {
      content: newContent,
      tokens: [...stableTokens, ...newTokens],
      stableTokenCount: trailingUnstable === 0 ? stableTokens.length + newTokens.length : stableTokens.length,
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
