import { Lexer, Marked, type MarkedOptions, type MarkedToken } from "marked"

export interface ParseState {
  content: string
  tokens: MarkedToken[]
  stableTokenCount?: number
}

// A lone `~` usually marks an approximation or a numeric range (3~5, ~30%), so only double
// tildes toggle strikethrough. Returning false keeps the default tokenizer for `~~text~~`,
// while undefined skips the del rule so single tildes stay literal.
export const markdownLexerOptions: MarkedOptions = new Marked({
  gfm: true,
  tokenizer: {
    del: (src) => (src.startsWith("~~") ? false : undefined),
  },
}).defaults

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
      const tokens = Lexer.lex(newContent, markdownLexerOptions) as MarkedToken[]
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

  if (!remainingContent) {
    return {
      content: newContent,
      tokens: stableTokens,
      stableTokenCount: stableTokens.length,
    }
  }

  try {
    const newTokens = Lexer.lex(remainingContent, markdownLexerOptions) as MarkedToken[]
    return {
      content: newContent,
      tokens: [...stableTokens, ...newTokens],
      stableTokenCount: trailingUnstable === 0 ? stableTokens.length + newTokens.length : stableTokens.length,
    }
  } catch {
    try {
      const fullTokens = Lexer.lex(newContent, markdownLexerOptions) as MarkedToken[]
      return { content: newContent, tokens: fullTokens, stableTokenCount: 0 }
    } catch {
      return { content: newContent, tokens: [], stableTokenCount: 0 }
    }
  }
}
