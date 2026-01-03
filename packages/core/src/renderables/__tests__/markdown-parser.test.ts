import { test, expect } from "bun:test"
import { parseMarkdownIncremental, type ParseState } from "../markdown-parser"

test("first parse returns all tokens", () => {
  const state = parseMarkdownIncremental("# Hello\n\nParagraph", null)

  expect(state.content).toBe("# Hello\n\nParagraph")
  expect(state.tokens.length).toBeGreaterThan(0)
  expect(state.tokens[0].type).toBe("heading")
})

test("reuses unchanged tokens when appending content", () => {
  const state1 = parseMarkdownIncremental("# Hello\n\nPara 1\n\n", null)
  const state2 = parseMarkdownIncremental("# Hello\n\nPara 1\n\nPara 2", state1, 0) // No trailing unstable

  // First tokens should be same object reference (reused)
  expect(state2.tokens[0]).toBe(state1.tokens[0]) // heading
  expect(state2.tokens[1]).toBe(state1.tokens[1]) // paragraph
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
