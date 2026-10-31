import { test, expect } from "bun:test"
import { Lexer } from "marked"
import { parseMarkdownIncremental, type ParseState } from "../markdown-parser.js"

test("first parse returns all tokens", () => {
  const state = parseMarkdownIncremental("# Hello\n\nParagraph", null)

  expect(state.content).toBe("# Hello\n\nParagraph")
  expect(state.tokens.length).toBeGreaterThan(0)
  expect(state.tokens[0].type).toBe("heading")
  expect(state.stableTokenCount).toBe(Math.max(0, state.tokens.length - 2))
})

test("an edit with trailingUnstable 0 parses like fresh content", () => {
  for (const [before, after] of [
    ["# Heading", "# Heading 2"],
    ["> one", "> one\n> two"],
    ["- a\n\n", "- a\n\n- b"],
    ["```js\nx", "```js\nx\ny\n```"],
    ["| A |\n|---|", "| A |\n|---|\n| 1 |"],
    ["Para", "Para\nlazy"],
    ["[r]\n\n", "[r]\n\n[r]: http://x"],
    ["[r]: http://x\n\nA\n\nB\n\nC\n\nSee [r", "[r]: http://x\n\nA\n\nB\n\nC\n\nSee [r] here"],
  ]) {
    const fresh = parseMarkdownIncremental(after, null, 0).tokens
    const edited = parseMarkdownIncremental(after, parseMarkdownIncremental(before, null, 0), 0)
    const streamed = parseMarkdownIncremental(after, parseMarkdownIncremental(before, null, 2), 2)
    expect(edited.tokens).toEqual(fresh)
    expect(edited.stableTokenCount).toBe(edited.tokens.length)
    expect(parseMarkdownIncremental(after, edited, 0)).toBe(edited)
    expect(parseMarkdownIncremental(after, edited, 2).stableTokenCount).toBeLessThan(edited.tokens.length)
    expect(parseMarkdownIncremental(after, streamed, 0).tokens).toEqual(fresh)
  }
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

test("code blocks are parsed correctly", () => {
  const state = parseMarkdownIncremental("```js\nconst x = 1;\n```", null)

  const codeToken = state.tokens.find((t) => t.type === "code")
  expect(codeToken).toBeDefined()
  expect((codeToken as any).lang).toBe("js")
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

  // Append content - with trailingUnstable=2, all but the last two tokens are reused
  const state2 = parseMarkdownIncremental("A\n\nB\n\nC\n\nD", state1, 2)

  state2.tokens.slice(0, 4).forEach((token, i) => expect(token).toBe(state1.tokens[i]))
  expect(state2.tokens[4]).not.toBe(state1.tokens[4])
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
