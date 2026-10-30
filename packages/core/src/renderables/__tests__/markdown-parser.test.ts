import { test, expect } from "bun:test"
import { Lexer, type Tokens } from "marked"
import { parseMarkdownIncremental, type ParseState } from "../markdown-parser.js"

test("first parse returns all tokens", () => {
  const state = parseMarkdownIncremental("# Hello\n\nParagraph", null)

  expect(state.content).toBe("# Hello\n\nParagraph")
  expect(state.tokens.length).toBeGreaterThan(0)
  expect(state.tokens[0].type).toBe("heading")
  expect(state.stableTokenCount).toBe(Math.max(0, state.tokens.length - 2))
})

test("reuses unchanged tokens when appending content", () => {
  const state1 = parseMarkdownIncremental("# Hello\n\nPara 1\n\n", null)
  const state2 = parseMarkdownIncremental("# Hello\n\nPara 1\n\nPara 2", state1, 0) // No trailing unstable

  // First tokens should be same object reference (reused)
  expect(state2.tokens[0]).toBe(state1.tokens[0]) // heading
  expect(state2.tokens[1]).toBe(state1.tokens[1]) // paragraph
  expect(state2.stableTokenCount).toBe(state2.tokens.length)
})

test("trailing unstable tokens are re-parsed", () => {
  const state1 = parseMarkdownIncremental("# Hello\n\nPara 1\n\n", null)
  const state2 = parseMarkdownIncremental("# Hello\n\nPara 1\n\nPara 2", state1, 2)

  // With trailingUnstable=2, last 2 tokens from state1 should be re-parsed
  // state1 has: heading, paragraph, space (3 tokens)
  // With trailing=2, only first token (heading) is stable
  // So heading token should NOT be reused (since we only have 3 tokens and skip last 2)
  // Actually with 3 tokens and trailingUnstable=2, we keep 1 token stable
  expect(state2.tokens.length).toBeGreaterThan(0)
  // The new tokens are re-parsed versions
  expect(state2.tokens[0].type).toBe("heading")
})

test("handles content that diverges from start", () => {
  const state1 = parseMarkdownIncremental("# Hello", null)
  const state2 = parseMarkdownIncremental("## World", state1)

  // Content changed from start, no tokens can be reused
  expect(state2.tokens[0]).not.toBe(state1.tokens[0])
  expect(state2.tokens[0].type).toBe("heading")
})

test("handles empty content", () => {
  const state = parseMarkdownIncremental("", null)

  expect(state.content).toBe("")
  expect(state.tokens).toEqual([])
})

test("handles empty previous state", () => {
  const prevState: ParseState = { content: "", tokens: [] }
  const state = parseMarkdownIncremental("# Hello", prevState)

  expect(state.tokens.length).toBeGreaterThan(0)
  expect(state.tokens[0].type).toBe("heading")
})

test("parseMarkdownIncremental reports stableTokenCount for the reused prefix", () => {
  const first = parseMarkdownIncremental("# Hello\n\nPara 1\n\n", null, 2)
  const second = parseMarkdownIncremental("# Hello\n\nPara 1\n\nPara 2", first, 2)

  expect(second.stableTokenCount).toBe(1)
  expect(second.tokens[0]).toBe(first.tokens[0])
})

test("stableTokenCount equals tokens.length when trailingUnstable is zero", () => {
  const state = parseMarkdownIncremental("# Hello\n\nPara 1", null, 0)

  expect(state.stableTokenCount).toBe(state.tokens.length)
})

test("initial parse keeps a conservative unstable tail", () => {
  const state = parseMarkdownIncremental("# Hello\n\nPara 1\n\nPara 2", null, 2)

  expect(state.stableTokenCount).toBe(Math.max(0, state.tokens.length - 2))
})

test("handles content truncation", () => {
  const state1 = parseMarkdownIncremental("# Hello\n\nPara 1\n\nPara 2", null)
  const state2 = parseMarkdownIncremental("# Hello", state1)

  expect(state2.tokens.length).toBe(1)
  expect(state2.tokens[0].type).toBe("heading")
})

test("handles partial token match", () => {
  const state1 = parseMarkdownIncremental("# Hello World", null)
  const state2 = parseMarkdownIncremental("# Hello", state1)

  // Token at start doesn't match exactly, so it's re-parsed
  expect(state2.tokens[0]).not.toBe(state1.tokens[0])
})

test("handles multiple stable tokens with explicit boundaries", () => {
  // Use content with clear token boundaries that won't change
  const content1 = "Para 1\n\nPara 2\n\nPara 3\n\n"
  const state1 = parseMarkdownIncremental(content1, null)

  const content2 = content1 + "Para 4"
  const state2 = parseMarkdownIncremental(content2, state1, 0)

  // All original tokens should be reused (same object reference)
  for (let i = 0; i < state1.tokens.length; i++) {
    expect(state2.tokens[i]).toBe(state1.tokens[i])
  }
  // And there should be a new token at the end
  expect(state2.tokens.length).toBe(state1.tokens.length + 1)
})

test("code blocks are parsed correctly", () => {
  const state = parseMarkdownIncremental("```js\nconst x = 1;\n```", null)

  const codeToken = state.tokens.find((t) => t.type === "code")
  expect(codeToken).toBeDefined()
  expect((codeToken as any).lang).toBe("js")
})

test("single tildes stay literal and double tildes still strike through", () => {
  const plain = parseMarkdownIncremental("按 3~5 倍放大，赢得 30~60%，约 ~5 分钟", null)
  const plainParagraph = plain.tokens.find((token) => token.type === "paragraph") as Tokens.Paragraph

  expect(plainParagraph.raw).toBe("按 3~5 倍放大，赢得 30~60%，约 ~5 分钟")
  expect(plainParagraph.tokens.some((token) => token.type === "del")).toBe(false)

  const struck = parseMarkdownIncremental("~~gone~~ text", null)
  const struckParagraph = struck.tokens.find((token) => token.type === "paragraph") as Tokens.Paragraph
  const del = struckParagraph.tokens.find((token) => token.type === "del") as Tokens.Del

  expect(del.text).toBe("gone")
})

test("streaming scenario with incremental typing", () => {
  let state: ParseState | null = null

  // Simulate typing character by character
  state = parseMarkdownIncremental("#", state, 2)
  expect(state.tokens.length).toBe(1)

  state = parseMarkdownIncremental("# ", state, 2)
  state = parseMarkdownIncremental("# H", state, 2)
  state = parseMarkdownIncremental("# He", state, 2)
  state = parseMarkdownIncremental("# Hel", state, 2)
  state = parseMarkdownIncremental("# Hell", state, 2)
  state = parseMarkdownIncremental("# Hello", state, 2)

  expect(state.tokens[0].type).toBe("heading")
  expect((state.tokens[0] as any).text).toBe("Hello")
})

test("token identity is preserved for stable tokens", () => {
  // Create initial state with multiple paragraphs
  const state1 = parseMarkdownIncremental("A\n\nB\n\nC\n\n", null)

  // Append content - with trailingUnstable=0, all tokens should be reused
  const state2 = parseMarkdownIncremental("A\n\nB\n\nC\n\nD", state1, 0)

  // Verify token identity (same object reference)
  expect(state2.tokens[0]).toBe(state1.tokens[0])
  expect(state2.tokens[1]).toBe(state1.tokens[1])
  expect(state2.tokens[2]).toBe(state1.tokens[2])
})

test("trailingUnstable re-parses trailing table when new rows are appended", () => {
  const content1 = "| A |\n|---|\n| 1 |"
  const state1 = parseMarkdownIncremental(content1, null, 2)
  const table1 = state1.tokens.find((token) => token.type === "table") as any

  expect(table1).toBeDefined()
  expect(table1.rows.length).toBe(1)

  const content2 = "| A |\n|---|\n| 1 |\n| 2 |"
  const state2 = parseMarkdownIncremental(content2, state1, 2)
  const table2 = state2.tokens.find((token) => token.type === "table") as any

  expect(table2).toBeDefined()
  expect(table2.rows.length).toBe(2)
  expect(table2).not.toBe(table1)
})

test("trailingUnstable updates trailing table rows in multi-table markdown", () => {
  const table1Markdown = "| T1 |\n|---|\n| a |\n| b |"
  const table2Markdown = "| T2 |\n|---|\n| 1 |\n| 2 |"

  const content1 = `${table1Markdown}\n\n${table2Markdown}`
  const state1 = parseMarkdownIncremental(content1, null, 2)
  const tables1 = state1.tokens.filter((token) => token.type === "table") as any[]

  expect(tables1.length).toBe(2)
  expect(tables1[0].rows.length).toBe(2)
  expect(tables1[1].rows.length).toBe(2)

  const content2 = `${table1Markdown}\n\n${table2Markdown}\n| 3 |`
  const state2 = parseMarkdownIncremental(content2, state1, 2)
  const tables2 = state2.tokens.filter((token) => token.type === "table") as any[]

  expect(tables2.length).toBe(2)
  expect(tables2[0].rows.length).toBe(2)
  expect(tables2[1]).not.toBe(tables1[1])
  expect(tables2[1].rows.length).toBe(3)
})

test("falls back to full re-parse when incremental tail parse fails", () => {
  const content1 = "| A |\n|---|\n| 1 |"
  const content2 = "| A |\n|---|\n| 1 |\n| 2 |"
  const state1 = parseMarkdownIncremental(content1, null, 2)

  const lexerRef = Lexer as unknown as { lex: typeof Lexer.lex }
  const originalLex = lexerRef.lex
  let lexCalls = 0

  lexerRef.lex = ((src, options) => {
    lexCalls += 1
    if (lexCalls === 1) {
      throw new Error("incremental tail parse failed")
    }
    return originalLex(src, options)
  }) as typeof Lexer.lex

  try {
    const state2 = parseMarkdownIncremental(content2, state1, 2)
    const table = state2.tokens.find((token) => token.type === "table") as any

    expect(lexCalls).toBeGreaterThanOrEqual(2)
    expect(state2.stableTokenCount).toBe(0)
    expect(table).toBeDefined()
    expect(table.rows.length).toBe(2)
  } finally {
    lexerRef.lex = originalLex
  }
})

test("returns empty token list when both incremental and full parse fail", () => {
  const content1 = "| A |\n|---|\n| 1 |"
  const content2 = "| A |\n|---|\n| 1 |\n| 2 |"
  const state1 = parseMarkdownIncremental(content1, null, 2)

  const lexerRef = Lexer as unknown as { lex: typeof Lexer.lex }
  const originalLex = lexerRef.lex

  lexerRef.lex = (() => {
    throw new Error("parse failed")
  }) as typeof Lexer.lex

  try {
    const state2 = parseMarkdownIncremental(content2, state1, 2)
    expect(state2.tokens).toEqual([])
    expect(state2.stableTokenCount).toBe(0)
  } finally {
    lexerRef.lex = originalLex
  }
})
