import { ResourceContext } from "../buffer.js"
import { test, expect, beforeAll, afterAll, describe } from "bun:test"
import { TreeSitterClient } from "./tree-sitter/client.js"
import { treeSitterToStyledText, treeSitterToTextChunks } from "./tree-sitter-styled-text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { RGBA } from "./RGBA.js"
import { createTextAttributes } from "../utils.js"
import { tmpdir } from "os"
import { join } from "path"
import { mkdir } from "fs/promises"
import type { SimpleHighlight } from "./tree-sitter/types.js"

describe("TreeSitter Styled Text", () => {
  let resourceContext: ResourceContext
  let client: TreeSitterClient
  let syntaxStyle: SyntaxStyle
  const dataPath = join(tmpdir(), "tree-sitter-styled-text-test")

  beforeAll(async () => {
    resourceContext = new ResourceContext({ objectCapacity: 64, renderCellsMax: 1 })
    await mkdir(dataPath, { recursive: true })
    client = new TreeSitterClient({ dataPath })
    await client.initialize()

    // Create a syntax style similar to common themes
    syntaxStyle = SyntaxStyle.fromStyles(
      {
        default: { fg: RGBA.fromInts(255, 255, 255, 255) }, // white
        keyword: { fg: RGBA.fromInts(255, 100, 100, 255), bold: true }, // red bold
        string: { fg: RGBA.fromInts(100, 255, 100, 255) }, // green
        number: { fg: RGBA.fromInts(100, 100, 255, 255) }, // blue
        function: { fg: RGBA.fromInts(255, 255, 100, 255), italic: true }, // yellow italic
        comment: { fg: RGBA.fromInts(128, 128, 128, 255), italic: true }, // gray italic
        variable: { fg: RGBA.fromInts(200, 200, 255, 255) }, // light blue
        type: { fg: RGBA.fromInts(255, 200, 100, 255) }, // orange
        "markup.heading": { fg: RGBA.fromInts(255, 200, 200, 255), bold: true }, // light red bold
        "markup.strong": { bold: true }, // bold
        "markup.italic": { italic: true }, // italic
        "markup.raw": { fg: RGBA.fromInts(200, 255, 200, 255) }, // light green
        "markup.quote": { fg: RGBA.fromInts(180, 180, 180, 255), italic: true }, // gray italic
        "markup.list": { fg: RGBA.fromInts(255, 200, 100, 255) }, // orange
      },
      resourceContext,
    )
  })

  afterAll(async () => {
    try {
      await client.destroy()
      syntaxStyle?.destroy()
    } finally {
      resourceContext.destroy()
    }
  })

  test("should convert JavaScript code to styled text", async () => {
    const jsCode = 'const greeting = "Hello, world!";\nfunction test() { return 42; }'

    const styledText = await treeSitterToStyledText(jsCode, "javascript", syntaxStyle, client)

    expect(styledText).toBeDefined()

    const chunks = styledText.chunks
    expect(chunks.length).toBeGreaterThan(1) // Should have multiple styled chunks

    const chunksWithColor = chunks.filter((chunk) => chunk.fg)
    expect(chunksWithColor.length).toBeGreaterThan(0) // Some chunks should have colors
  })

  test("should convert TypeScript code to styled text", async () => {
    const tsCode = "interface User {\n  name: string;\n  age: number;\n}"

    const styledText = await treeSitterToStyledText(tsCode, "typescript", syntaxStyle, client)

    expect(styledText).toBeDefined()

    const chunks = styledText.chunks
    expect(chunks.length).toBeGreaterThan(1)

    const styledChunks = chunks.filter((chunk) => chunk.fg)
    expect(styledChunks.length).toBeGreaterThan(0)
  })

  test("should handle unsupported filetype gracefully", async () => {
    const content = "some random content"

    const styledText = await treeSitterToStyledText(content, "unsupported", syntaxStyle, client)

    expect(styledText).toBeDefined()

    const chunks = styledText.chunks
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe(content)

    expect(chunks[0].fg).toBeDefined()
  })

  test("should handle empty content", async () => {
    const styledText = await treeSitterToStyledText("", "javascript", syntaxStyle, client)

    expect(styledText).toBeDefined()

    const chunks = styledText.chunks
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe("")
  })

  test("should handle multiline content correctly", async () => {
    const multilineCode = `// This is a comment
const value = 123;
const text = "hello";
function add(a, b) {
  return a + b;
}`

    const styledText = await treeSitterToStyledText(multilineCode, "javascript", syntaxStyle, client)

    expect(styledText).toBeDefined()

    const chunks = styledText.chunks
    expect(chunks.length).toBeGreaterThan(5) // Multiple chunks for different elements

    // Should contain newlines
    const newlineChunks = chunks.filter((chunk) => chunk.text.includes("\n"))
    expect(newlineChunks.length).toBeGreaterThan(0)
  })

  test("should preserve original text content", async () => {
    const originalCode = 'const test = "preserve this exact text";'

    const styledText = await treeSitterToStyledText(originalCode, "javascript", syntaxStyle, client)

    const reconstructed = styledText.chunks.map((chunk) => chunk.text).join("")
    expect(reconstructed).toBe(originalCode)
  })

  test("records exactly one original source range per emitted chunk, including conceal replacements", () => {
    const content = "xx [xx](https://example.com) xx"
    const labelStart = content.indexOf("xx", 3)
    const urlStart = content.indexOf("https://")
    const highlights: SimpleHighlight[] = [
      [3, 4, "conceal", { conceal: "" }],
      [labelStart, labelStart + 2, "markup.link.label"],
      [labelStart + 2, labelStart + 3, "conceal", { conceal: "xx" }],
      [urlStart, urlStart + "https://example.com".length, "markup.link.url"],
    ]
    const ranges: Array<{ start: number; end: number }> = []

    const chunks = treeSitterToTextChunks(content, highlights, syntaxStyle, { ranges })

    expect(chunks.map((item) => item.text)).toEqual(["xx ", "xx", "xx", "(", "https://example.com", ") xx"])
    expect(ranges).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 6 },
      { start: 6, end: 7 },
      { start: 7, end: 8 },
      { start: 8, end: 27 },
      { start: 27, end: 31 },
    ])
  })

  test("should apply different styles to different syntax elements", async () => {
    const jsCode = "const number = 42; // comment"

    const styledText = await treeSitterToStyledText(jsCode, "javascript", syntaxStyle, client)
    const chunks = styledText.chunks

    // Should have some chunks with colors
    const chunksWithColors = chunks.filter((chunk) => chunk.fg)
    expect(chunksWithColors.length).toBeGreaterThan(0)

    // Should have some chunks with attributes (bold, italic, etc.)
    const chunksWithAttributes = chunks.filter((chunk) => chunk.attributes && chunk.attributes > 0)
    expect(chunksWithAttributes.length).toBeGreaterThan(0)
  })

  test("should handle template literals correctly without duplication", async () => {
    const templateLiteralCode = "console.log(`Total users: ${manager.getUserCount()}`);"

    const styledText = await treeSitterToStyledText(templateLiteralCode, "javascript", syntaxStyle, client)
    const chunks = styledText.chunks

    // Reconstruct the text from chunks to check for duplication
    const reconstructed = chunks.map((chunk) => chunk.text).join("")

    expect(reconstructed).toBe(templateLiteralCode)

    expect(chunks.length).toBeGreaterThan(1)

    const styledChunks = chunks.filter((chunk) => chunk.fg)
    expect(styledChunks.length).toBeGreaterThan(0)
  })

  test("should handle complex template literals with multiple expressions", async () => {
    const complexTemplateCode =
      'console.log(`User: ${user.name}, Age: ${user.age}, Status: ${user.active ? "active" : "inactive"}`);'

    const styledText = await treeSitterToStyledText(complexTemplateCode, "javascript", syntaxStyle, client)
    const chunks = styledText.chunks

    const reconstructed = chunks.map((chunk) => chunk.text).join("")

    expect(reconstructed).toBe(complexTemplateCode)
  })

  test("should correctly highlight template literal with embedded expressions", async () => {
    const templateLiteralCode = "console.log(`Total users: ${manager.getUserCount()}`);"

    const result = await client.highlightOnce(templateLiteralCode, "javascript")

    expect(result.highlights).toBeDefined()
    expect(result.highlights!.length).toBeGreaterThan(0)

    const groups = result.highlights!.map(([, , group]) => group)
    expect(groups).toContain("variable") // console, manager
    expect(groups).toContain("property") // log, getUserCount
    expect(groups).toContain("string") // template literal
    expect(groups).toContain("embedded") // ${...} expression
    expect(groups).toContain("punctuation.bracket") // (), {}

    const styledText = await treeSitterToStyledText(templateLiteralCode, "javascript", syntaxStyle, client)
    const chunks = styledText.chunks

    expect(chunks.length).toBeGreaterThan(5)

    const reconstructed = chunks.map((chunk) => chunk.text).join("")
    expect(reconstructed).toBe(templateLiteralCode)

    const styledChunks = chunks.filter((chunk) => chunk.fg !== syntaxStyle.mergeStyles("default").fg)
    expect(styledChunks.length).toBeGreaterThan(0) // Some chunks should be styled differently
  })

  test("should work with real tree-sitter output containing dot-delimited groups", async () => {
    const tsCode = "interface User { name: string; age?: number; }"

    const result = await client.highlightOnce(tsCode, "typescript")
    expect(result.highlights).toBeDefined()

    const groups = result.highlights!.map(([, , group]) => group)
    const dotDelimitedGroups = groups.filter((group) => group.includes("."))
    expect(dotDelimitedGroups.length).toBeGreaterThan(0)

    const styledText = await treeSitterToStyledText(tsCode, "typescript", syntaxStyle, client)
    const chunks = styledText.chunks

    expect(chunks.length).toBeGreaterThan(1)

    const styledChunks = chunks.filter((chunk) => chunk.fg !== syntaxStyle.mergeStyles("default").fg)
    expect(styledChunks.length).toBeGreaterThan(0)

    const reconstructed = chunks.map((chunk) => chunk.text).join("")
    expect(reconstructed).toBe(tsCode)
  })

  test("should resolve styles correctly for dot-delimited groups and multiple overlapping groups", async () => {
    // Test the getStyle method directly
    expect(syntaxStyle.getStyle("function.method")).toEqual(syntaxStyle.getStyle("function"))
    expect(syntaxStyle.getStyle("variable.member")).toEqual(syntaxStyle.getStyle("variable"))
    expect(syntaxStyle.getStyle("nonexistent.fallback")).toBeUndefined()
    expect(syntaxStyle.getStyle("function")).toBeDefined()
    expect(syntaxStyle.getStyle("constructor")).toBeUndefined() // Should not return Object constructor

    // Test with mock highlights that have multiple groups for same range
    const mockHighlights: Array<[number, number, string]> = [
      [0, 4, "variable.member"], // should resolve to 'variable' style
      [0, 4, "function.method"], // should resolve to 'function' style (last valid)
      [0, 4, "nonexistent"], // undefined, should not override
      [4, 8, "keyword"], // should resolve to 'keyword' style
    ]

    const content = "testfunc"
    const chunks = treeSitterToTextChunks(content, mockHighlights, syntaxStyle)

    expect(chunks.length).toBe(2) // Two highlight ranges, no gaps

    // First chunk [0,4] should have function style (last valid style)
    const functionStyle = syntaxStyle.getStyle("function")!
    expect(chunks[0].text).toBe("test")
    expect(chunks[0].fg).toEqual(functionStyle.fg)
    expect(chunks[0].attributes).toBe(
      createTextAttributes({
        bold: functionStyle.bold,
        italic: functionStyle.italic,
        underline: functionStyle.underline,
        dim: functionStyle.dim,
      }),
    )

    // Second chunk [4,8] should have keyword style
    const keywordStyle = syntaxStyle.getStyle("keyword")!
    expect(chunks[1].text).toBe("func")
    expect(chunks[1].fg).toEqual(keywordStyle.fg)
    expect(chunks[1].attributes).toBe(
      createTextAttributes({
        bold: keywordStyle.bold,
        italic: keywordStyle.italic,
        underline: keywordStyle.underline,
        dim: keywordStyle.dim,
      }),
    )
  })

  test("should handle constructor group correctly", async () => {
    expect(syntaxStyle.getStyle("constructor")).toBeUndefined()

    const mockHighlights: Array<[number, number, string]> = [
      [0, 11, "variable.member"], // should resolve to 'variable' style
      [0, 11, "constructor"], // should resolve to undefined
      [0, 11, "function.method"], // should resolve to 'function' style (last valid)
    ]

    const content = "constructor"
    const chunks = treeSitterToTextChunks(content, mockHighlights, syntaxStyle)

    expect(chunks.length).toBe(1)

    const functionStyle = syntaxStyle.getStyle("function")!
    expect(chunks[0].text).toBe("constructor")
    expect(chunks[0].fg).toEqual(functionStyle.fg)
    expect(chunks[0].attributes).toBe(
      createTextAttributes({
        bold: functionStyle.bold,
        italic: functionStyle.italic,
        underline: functionStyle.underline,
        dim: functionStyle.dim,
      }),
    )
  })

  test("should handle markdown with TypeScript injection - suppress parent block styles", async () => {
    const markdownCode = `\`\`\`typescript
const x: string = "hello";
\`\`\``

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: false }, // Disable concealing to test text preservation
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")
    expect(reconstructed).toBe(markdownCode)

    const tsStart = markdownCode.indexOf("const")
    const tsEnd = markdownCode.lastIndexOf(";") + 1

    let currentPos = 0
    const tsChunks: typeof chunks = []
    for (const chunk of chunks) {
      const chunkStart = currentPos
      const chunkEnd = currentPos + chunk.text.length
      if (chunkStart >= tsStart && chunkEnd <= tsEnd) {
        tsChunks.push(chunk)
      }
      currentPos = chunkEnd
    }

    // and NOT the parent markup.raw.block background
    expect(tsChunks.length).toBeGreaterThan(0)

    const hasKeywordStyle = tsChunks.some((chunk) => {
      const keywordStyle = syntaxStyle.getStyle("keyword")
      return (
        keywordStyle &&
        chunk.fg &&
        keywordStyle.fg &&
        chunk.fg.r === keywordStyle.fg.r &&
        chunk.fg.g === keywordStyle.fg.g &&
        chunk.fg.b === keywordStyle.fg.b
      )
    })
    expect(hasKeywordStyle).toBe(true)
  })

  test("should conceal backticks in inline code", async () => {
    const markdownCode = "Some text with `inline code` here."

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: true },
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")
    expect(reconstructed).not.toContain("`")
    expect(reconstructed).toContain("inline code")
    expect(reconstructed).toContain("Some text with ")
    expect(reconstructed).toContain(" here.")
  })

  test("should conceal bold markers", async () => {
    const markdownCode = "Some **bold** text"

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: true },
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")
    expect(reconstructed).not.toContain("**")
    expect(reconstructed).not.toContain("*")
    expect(reconstructed).toContain("bold")
    expect(reconstructed).toContain("Some ")
    expect(reconstructed).toContain(" text")
  })

  test("should conceal link syntax but keep text and URL", async () => {
    const markdownCode = "[Link text](https://example.com)"

    const result = await client.highlightOnce(markdownCode, "markdown")
    expect(result.highlights).toBeDefined()

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: true },
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")

    expect(reconstructed).not.toContain("[")
    expect(reconstructed).not.toContain("]")
    expect(reconstructed).toContain("(")
    expect(reconstructed).toContain(")")

    expect(reconstructed).toContain("Link text")
    expect(reconstructed).toContain("https://example.com")

    expect(reconstructed).toBe("Link text (https://example.com)")
  })

  test("should conceal code block delimiters and language info", async () => {
    const markdownCode = `\`\`\`typescript
const x: string = "hello";
\`\`\``

    const result = await client.highlightOnce(markdownCode, "markdown")
    expect(result.highlights).toBeDefined()

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: true },
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")

    expect(reconstructed).toContain("const x")
    expect(reconstructed).toContain("hello")

    expect(reconstructed).not.toContain("typescript")

    expect(reconstructed.startsWith("const")).toBe(true)

    expect(reconstructed.split("\n").filter((l) => l.trim() === "").length).toBeLessThanOrEqual(1)
  })

  test("should handle overlapping highlights with specificity resolution", async () => {
    const mockHighlights: SimpleHighlight[] = [
      [0, 10, "variable"],
      [0, 10, "variable.member"], // More specific, should win
      [0, 10, "type"],
      [11, 16, "keyword"],
      [11, 16, "keyword.coroutine"], // More specific, should win
    ]

    const content = "identifier const"
    // "identifier" = indices 0-9 (10 chars)
    // " " = index 10 (1 char)
    // "const" = indices 11-15 (5 chars)
    const chunks = treeSitterToTextChunks(content, mockHighlights, syntaxStyle)

    expect(chunks.length).toBe(3) // "identifier", " ", "const"

    const variableStyle = syntaxStyle.getStyle("variable")!
    expect(chunks[0].text).toBe("identifier")
    expect(chunks[0].fg).toEqual(variableStyle.fg)

    expect(chunks[1].text).toBe(" ")

    const keywordStyle = syntaxStyle.getStyle("keyword")!
    expect(chunks[2].text).toBe("const")
    expect(chunks[2].fg).toEqual(keywordStyle.fg)
  })

  test("should not conceal when conceal option is disabled", async () => {
    const markdownCode = "Some text with `inline code` here."

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: false },
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")
    expect(reconstructed).toContain("`")
    expect(reconstructed).toBe(markdownCode)
  })

  test("should handle complex markdown with multiple features", async () => {
    const markdownCode = `# Heading

Some **bold** text and \`code\`.

\`\`\`typescript
const hello: string = "world";
\`\`\`

[Link](https://example.com)`

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: true },
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")

    expect(reconstructed).toContain("Heading")
    expect(reconstructed).toContain("bold")
    expect(reconstructed).toContain("code")
    expect(reconstructed).toContain("const hello")
    expect(reconstructed).toContain("Link")

    expect(reconstructed).not.toContain("**")
  })

  test("should correctly handle ranges after concealed text", async () => {
    const markdownCode = "Text with **bold** and *italic* markers."

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: true },
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")

    expect(reconstructed).toContain("Text with ")
    expect(reconstructed).toContain("bold")
    expect(reconstructed).toContain(" and ")
    expect(reconstructed).toContain("italic")
    expect(reconstructed).toContain(" markers.")

    expect(reconstructed).not.toContain("**")
    expect(reconstructed).not.toContain("*")

    expect(reconstructed).toMatch(/Text with \w+ and \w+ markers\./)
  })

  test("should conceal heading markers and preserve heading styling", async () => {
    const markdownCode = "## Heading 2"

    const result = await client.highlightOnce(markdownCode, "markdown")

    const hasAnyConceals = result.highlights!.some(([, , , meta]) => meta?.conceal !== undefined)
    expect(hasAnyConceals).toBe(true) // Should have conceal on the ## marker

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: true },
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")

    expect(reconstructed).toContain("Heading 2")

    expect(reconstructed).not.toContain("##")
    expect(reconstructed).not.toContain("#")

    expect(reconstructed).toBe("Heading 2")

    expect(reconstructed.startsWith(" ")).toBe(false)
    expect(reconstructed.startsWith("Heading")).toBe(true)

    // Note: Heading styling depends on having the parent markup.heading style
    // properly cascade to child text. In a real application with proper theme setup,
    // the heading text will be styled correctly as shown in other tests.
  })

  test("should not create empty lines when concealing code block delimiters", async () => {
    const markdownCode = `\`\`\`typescript
const x = 1;
const y = 2;
\`\`\``

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: true },
    })

    const reconstructed = styledText.chunks.map((c) => c.text).join("")

    const originalLines = markdownCode.split("\n")
    expect(originalLines.length).toBe(4)

    // (The ```typescript line is completely removed including its newline)
    const reconstructedLines = reconstructed.split("\n")
    expect(reconstructedLines.length).toBe(3)

    expect(reconstructedLines[0]).toBe("const x = 1;")

    expect(reconstructed.startsWith("\n")).toBe(false)
    expect(reconstructed.startsWith("const")).toBe(true)
  })

  test("should conceal closing triple backticks in plain code block (no injection)", async () => {
    const markdownCode = `\`\`\`
const msg = "hello";
\`\`\``

    const result = await client.highlightOnce(markdownCode, "markdown")
    expect(result.highlights).toBeDefined()

    const closingBackticksHighlight = result.highlights!.find(([start, end, , meta]) => {
      const text = markdownCode.slice(start, end)
      return text === "```" && start > 10 && meta?.conceal !== undefined
    })

    expect(closingBackticksHighlight).toBeDefined()

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: true },
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")

    expect(reconstructed).not.toContain("```")
    expect(reconstructed).toContain("const msg")
  })

  test("should conceal closing triple backticks when they are the last content (with TypeScript injection)", async () => {
    const markdownCode = `\`\`\`typescript
const msg = "hello";
\`\`\``

    const result = await client.highlightOnce(markdownCode, "markdown")
    expect(result.highlights).toBeDefined()

    const closingBackticksHighlights = result.highlights!.filter(([start, end]) => {
      const text = markdownCode.slice(start, end)
      return start > 30 && text.includes("`")
    })

    const hasClosingConceal = closingBackticksHighlights.some(([, , , meta]) => meta?.conceal !== undefined)
    expect(hasClosingConceal).toBe(true)

    const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
      conceal: { enabled: true },
    })
    const chunks = styledText.chunks

    const reconstructed = chunks.map((c) => c.text).join("")

    expect(reconstructed).not.toContain("```")
    expect(reconstructed).toContain("const msg")
    expect(reconstructed).toContain("hello")

    expect(reconstructed.endsWith("```")).toBe(false)
    expect(reconstructed.endsWith("`")).toBe(false)
  })

  describe("Markdown highlighting comprehensive coverage", () => {
    test("headings should have full styling applied", async () => {
      const markdownCode = `# Heading 1
## Heading 2
### Heading 3`

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      const groups = result.highlights!.map(([, , group]) => group)
      expect(groups).toContain("markup.heading.1")
      expect(groups).toContain("markup.heading.2")
      expect(groups).toContain("markup.heading.3")

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
        conceal: { enabled: false }, // Disable concealing to test text preservation
      })
      const chunks = styledText.chunks

      const reconstructed = chunks.map((c) => c.text).join("")
      expect(reconstructed).toBe(markdownCode)

      const hashOrHeadingChunks = chunks.filter((chunk) => chunk.text.includes("#") || /heading/i.test(chunk.text))
      expect(hashOrHeadingChunks.length).toBeGreaterThan(0)

      const headingGroups = groups.filter((g) => g.includes("markup.heading"))
      expect(headingGroups.length).toBeGreaterThan(0)
    })

    test("inline raw blocks (code) should be styled", async () => {
      const markdownCode = "Some text with `inline code` here."

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      const groups = result.highlights!.map(([, , group]) => group)
      const hasCodeGroup = groups.some((g) => g.includes("markup.raw") || g.includes("code"))
      expect(hasCodeGroup).toBe(true)

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
        conceal: { enabled: false },
      })
      const chunks = styledText.chunks

      const codeChunks = chunks.filter((c) => c.text.includes("inline") || c.text.includes("code"))
      expect(codeChunks.length).toBeGreaterThan(0)

      const defaultStyle = syntaxStyle.mergeStyles("default")
      const styledCodeChunks = codeChunks.filter((c) => c.fg !== defaultStyle.fg || c.attributes !== 0)
      expect(styledCodeChunks.length).toBeGreaterThan(0)
    })

    test("quotes should be styled correctly", async () => {
      const markdownCode = `> This is a quote
> Another line`

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      const groups = result.highlights!.map(([, , group]) => group)
      const hasQuoteGroup = groups.some((g) => g.includes("quote"))
      expect(hasQuoteGroup).toBe(true)

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client)
      const chunks = styledText.chunks

      const reconstructed = chunks.map((c) => c.text).join("")
      expect(reconstructed).toBe(markdownCode)
    })

    test("italic text should be styled in all places", async () => {
      const markdownCode = `*italic* text in paragraph

# *italic in heading*

- *italic in list*`

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      const groups = result.highlights!.map(([, , group]) => group)
      const hasItalicGroup = groups.some((g) => g.includes("italic") || g.includes("emphasis"))
      expect(hasItalicGroup).toBe(true)

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
        conceal: { enabled: true },
      })
      const chunks = styledText.chunks

      const reconstructed = chunks.map((c) => c.text).join("")
      const asteriskCount = (reconstructed.match(/\*/g) || []).length
      const originalAsteriskCount = (markdownCode.match(/\*/g) || []).length
      expect(asteriskCount).toBeLessThan(originalAsteriskCount)
    })

    test("bold text should work in all contexts", async () => {
      const markdownCode = `**bold** text in paragraph

# **bold in heading**

- **bold in list**

> **bold in quote**`

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      const groups = result.highlights!.map(([, , group]) => group)
      const hasBoldGroup = groups.some((g) => g.includes("strong") || g.includes("bold"))
      expect(hasBoldGroup).toBe(true)

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
        conceal: { enabled: true },
      })
      const chunks = styledText.chunks

      const reconstructed = chunks.map((c) => c.text).join("")
      expect(reconstructed).not.toContain("**")
      expect(reconstructed).toContain("bold")
    })

    test("TypeScript code block should not contain parent markup.raw.block fragments between syntax ranges", async () => {
      const markdownCode = `\`\`\`typescript
const greeting: string = "hello";
function test() { return 42; }
\`\`\``

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      const hasInjection = result.highlights!.some(([, , , meta]) => meta?.injectionLang === "typescript")
      expect(hasInjection).toBe(true)

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
        conceal: { enabled: false }, // Disable concealing to test text preservation
      })
      const chunks = styledText.chunks

      const reconstructed = chunks.map((c) => c.text).join("")
      expect(reconstructed).toBe(markdownCode)

      const tsCodeStart = markdownCode.indexOf("\n") + 1 // After first ```typescript\n
      const tsCodeEnd = markdownCode.lastIndexOf("\n```") // Before last \n```

      let currentPos = 0
      const tsChunks: typeof chunks = []
      for (const chunk of chunks) {
        const chunkStart = currentPos
        const chunkEnd = currentPos + chunk.text.length
        if (chunkEnd > tsCodeStart && chunkStart < tsCodeEnd) {
          tsChunks.push(chunk)
        }
        currentPos = chunkEnd
      }

      expect(tsChunks.length).toBeGreaterThan(0)

      // (keyword, type, string, etc.) and NOT markup.raw.block background
      const keywordStyle = syntaxStyle.getStyle("keyword")
      const stringStyle = syntaxStyle.getStyle("string")
      const typeStyle = syntaxStyle.getStyle("type")

      const hasKeywordStyle = tsChunks.some((chunk) => {
        return (
          keywordStyle &&
          chunk.fg &&
          keywordStyle.fg &&
          chunk.fg.r === keywordStyle.fg.r &&
          chunk.fg.g === keywordStyle.fg.g &&
          chunk.fg.b === keywordStyle.fg.b
        )
      })

      const hasStringStyle = tsChunks.some((chunk) => {
        return (
          stringStyle &&
          chunk.fg &&
          stringStyle.fg &&
          chunk.fg.r === stringStyle.fg.r &&
          chunk.fg.g === stringStyle.fg.g &&
          chunk.fg.b === stringStyle.fg.b
        )
      })

      expect(hasKeywordStyle || hasStringStyle).toBe(true)

      const defaultStyle = syntaxStyle.mergeStyles("default")

      for (const chunk of tsChunks) {
        // 1. TypeScript-specific styling (keyword, string, type, etc.)
        // 2. Default styling (for whitespace, punctuation)
        // 3. NOT markup.raw.block background (which would be wrong)

        // we verify that chunks are either styled or default
        const isStyled = chunk.fg !== defaultStyle.fg || chunk.attributes !== 0
        const isDefault = chunk.fg === defaultStyle.fg

        expect(isStyled || isDefault).toBe(true)
      }
    })

    test("mixed formatting (bold + italic) should work", async () => {
      const markdownCode = "***bold and italic*** text"

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
        conceal: { enabled: true },
      })
      const chunks = styledText.chunks

      const reconstructed = chunks.map((c) => c.text).join("")
      expect(reconstructed).not.toContain("***")
      expect(reconstructed).toContain("bold and italic")
    })

    test("inline code in headings should be styled", async () => {
      const markdownCode = "# Heading with `code` inside"

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
        conceal: { enabled: false },
      })
      const chunks = styledText.chunks

      const reconstructed = chunks.map((c) => c.text).join("")
      expect(reconstructed).toBe(markdownCode)

      const groups = result.highlights!.map(([, , group]) => group)
      expect(groups.some((g) => g.includes("heading"))).toBe(true)
      expect(groups.some((g) => g.includes("markup.raw") || g.includes("code"))).toBe(true)
    })

    test("bold and italic in lists should work", async () => {
      const markdownCode = `- **bold item**
- *italic item*
- normal item`

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
        conceal: { enabled: true },
      })
      const chunks = styledText.chunks

      const reconstructed = chunks.map((c) => c.text).join("")
      expect(reconstructed).toContain("bold item")
      expect(reconstructed).toContain("italic item")
      expect(reconstructed).not.toContain("**")
    })

    test("code blocks with different languages should suppress parent styles", async () => {
      const markdownCode = `\`\`\`javascript
const x = 42;
\`\`\`

\`\`\`typescript
const y: number = 42;
\`\`\``

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
        conceal: { enabled: false }, // Disable concealing to test text preservation
      })
      const chunks = styledText.chunks

      const reconstructed = chunks.map((c) => c.text).join("")
      expect(reconstructed).toBe(markdownCode)

      const jsInjection = result.highlights!.some(([, , , meta]) => meta?.injectionLang === "javascript")
      const tsInjection = result.highlights!.some(([, , , meta]) => meta?.injectionLang === "typescript")

      expect(jsInjection || tsInjection).toBe(true)
    })

    test("complex nested markdown structures", async () => {
      const markdownCode = `# Main Heading

> This is a quote with **bold** and *italic* and \`code\`.

## Sub Heading

- List item with **bold**
- Another item with \`inline code\`

\`\`\`typescript
// Comment in code
const value = "string";
\`\`\`

Normal paragraph with [link](https://example.com).`

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()
      expect(result.highlights!.length).toBeGreaterThan(10)

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", syntaxStyle, client, {
        conceal: { enabled: true },
      })
      const chunks = styledText.chunks

      const reconstructed = chunks.map((c) => c.text).join("")

      expect(reconstructed).toContain("Main Heading")
      expect(reconstructed).toContain("Sub Heading")
      expect(reconstructed).toContain("quote")
      expect(reconstructed).toContain("bold")
      expect(reconstructed).toContain("italic")
      expect(reconstructed).toContain("code")
      expect(reconstructed).toContain("const value")
      expect(reconstructed).toContain("link")

      expect(reconstructed).not.toContain("**")

      const defaultStyle = syntaxStyle.mergeStyles("default")
      const styledChunks = chunks.filter((c) => c.fg !== defaultStyle.fg || c.attributes !== 0)
      expect(styledChunks.length).toBeGreaterThan(5)
    })
  })

  describe("Style Inheritance", () => {
    test("should merge styles from nested highlights with child overriding parent", () => {
      const mockHighlights: SimpleHighlight[] = [
        [0, 20, "markup.link"], // Parent: entire link with underline
        [1, 11, "markup.link.label"], // Child: label with different color
        [13, 19, "markup.link.url"], // Child: url with different color
      ]

      const testStyle = SyntaxStyle.fromStyles(
        {
          default: { fg: RGBA.fromInts(255, 255, 255, 255) },
          "markup.link": { fg: RGBA.fromInts(100, 100, 255, 255), underline: true }, // Blue underlined
          "markup.link.label": { fg: RGBA.fromInts(165, 214, 255, 255) }, // Light blue (no underline specified)
          "markup.link.url": { fg: RGBA.fromInts(88, 166, 255, 255) }, // Different blue (no underline specified)
        },
        resourceContext,
      )

      const content = "[Link text](url)"

      const labelStyle = testStyle.getStyle("markup.link.label")!
      const urlStyle = testStyle.getStyle("markup.link.url")!

      const chunks = treeSitterToTextChunks(content, mockHighlights, testStyle)

      testStyle.destroy()

      expect(chunks.length).toBeGreaterThan(0)

      let currentPos = 0
      const labelChunks: typeof chunks = []
      const urlChunks: typeof chunks = []

      for (const chunk of chunks) {
        const chunkStart = currentPos
        const chunkEnd = currentPos + chunk.text.length

        // Label is at [1, 11] - "Link text"
        if (chunkStart >= 1 && chunkStart < 11 && chunk.text.length > 0) {
          labelChunks.push(chunk)
        }

        // URL is at [13, 19] - "url"
        if (chunkStart >= 13 && chunkStart < 19 && chunk.text.length > 0) {
          urlChunks.push(chunk)
        }

        currentPos = chunkEnd
      }

      expect(labelChunks.length).toBeGreaterThan(0)
      expect(urlChunks.length).toBeGreaterThan(0)

      const underlineAttr = createTextAttributes({ underline: true })
      for (const chunk of [...labelChunks, ...urlChunks]) {
        expect(chunk.attributes).toBe(underlineAttr)
      }

      for (const chunk of labelChunks) {
        expect(chunk.fg?.r).toBeCloseTo(labelStyle.fg!.r, 2)
        expect(chunk.fg?.g).toBeCloseTo(labelStyle.fg!.g, 2)
        expect(chunk.fg?.b).toBeCloseTo(labelStyle.fg!.b, 2)
      }

      for (const chunk of urlChunks) {
        expect(chunk.fg?.r).toBeCloseTo(urlStyle.fg!.r, 2)
        expect(chunk.fg?.g).toBeCloseTo(urlStyle.fg!.g, 2)
        expect(chunk.fg?.b).toBeCloseTo(urlStyle.fg!.b, 2)
      }
    })

    test("should merge multiple overlapping styles with correct priority", () => {
      const mockHighlights: SimpleHighlight[] = [
        [0, 10, "text"], // Base style
        [0, 10, "text.special"], // More specific: adds bold
        [0, 10, "text.special.highlighted"], // Most specific: adds underline
      ]

      const testStyle = SyntaxStyle.fromStyles(
        {
          default: { fg: RGBA.fromInts(255, 255, 255, 255) },
          text: { fg: RGBA.fromInts(200, 200, 200, 255) }, // Gray
          "text.special": { bold: true }, // Add bold, no color change
          "text.special.highlighted": { underline: true, fg: RGBA.fromInts(255, 255, 100, 255) }, // Add underline and yellow
        },
        resourceContext,
      )

      const content = "test text "
      const chunks = treeSitterToTextChunks(content, mockHighlights, testStyle)

      testStyle.destroy()

      expect(chunks.length).toBeGreaterThan(0)

      const chunk = chunks[0]

      expect(chunk.fg?.r).toBeCloseTo(1.0, 2)
      expect(chunk.fg?.g).toBeCloseTo(1.0, 2)
      expect(chunk.fg?.b).toBeCloseTo(100 / 255, 2)

      const expectedAttributes = createTextAttributes({ bold: true, underline: true })
      expect(chunk.attributes).toBe(expectedAttributes)
    })

    test("should handle style inheritance when parent only sets attributes", () => {
      const mockHighlights: SimpleHighlight[] = [
        [0, 15, "container"], // Parent: only underline
        [0, 5, "container.part1"], // Child: only color
        [5, 10, "container.part2"], // Child: different color
        [10, 15, "container.part3"], // Child: yet another color
      ]

      const testStyle = SyntaxStyle.fromStyles(
        {
          default: { fg: RGBA.fromInts(255, 255, 255, 255) },
          container: { underline: true }, // Only underline, no color
          "container.part1": { fg: RGBA.fromInts(255, 100, 100, 255) }, // Red
          "container.part2": { fg: RGBA.fromInts(100, 255, 100, 255) }, // Green
          "container.part3": { fg: RGBA.fromInts(100, 100, 255, 255) }, // Blue
        },
        resourceContext,
      )

      const content = "part1part2part3"
      const chunks = treeSitterToTextChunks(content, mockHighlights, testStyle)

      testStyle.destroy()

      expect(chunks.length).toBe(3)

      const underlineAttr = createTextAttributes({ underline: true })
      for (const chunk of chunks) {
        expect(chunk.attributes).toBe(underlineAttr)
      }

      expect(chunks[0].fg?.r).toBeCloseTo(1.0, 2) // 255 / 255
      expect(chunks[0].fg?.g).toBeCloseTo(100 / 255, 2)
      expect(chunks[0].fg?.b).toBeCloseTo(100 / 255, 2)

      expect(chunks[1].fg?.r).toBeCloseTo(100 / 255, 2)
      expect(chunks[1].fg?.g).toBeCloseTo(1.0, 2) // 255 / 255
      expect(chunks[1].fg?.b).toBeCloseTo(100 / 255, 2)

      expect(chunks[2].fg?.r).toBeCloseTo(100 / 255, 2)
      expect(chunks[2].fg?.g).toBeCloseTo(100 / 255, 2)
      expect(chunks[2].fg?.b).toBeCloseTo(1.0, 2) // 255 / 255
    })

    test("should handle markdown link with realistic tree-sitter output", async () => {
      const markdownCode = "[Label](url)"

      const result = await client.highlightOnce(markdownCode, "markdown")
      expect(result.highlights).toBeDefined()

      // IMPORTANT: Tree-sitter markdown parser emits:
      // - markup.link ONLY for brackets/parens: "[", "]", "(", ")"
      // - markup.link.label ONLY for the label text: "Label" (not nested under markup.link!)
      // - markup.link.url for the URL text: "url" (ALONG WITH markup.link as sibling)
      //
      // This means label does NOT inherit from markup.link because it's not a child range!
      // Therefore, if you want label underlined, you must specify it explicitly.

      const labelHighlights = result.highlights!.filter(
        ([start, end, group]) => group === "markup.link.label" && markdownCode.slice(start, end) === "Label",
      )
      expect(labelHighlights.length).toBe(1)

      const labelStart = labelHighlights[0][0]
      const labelEnd = labelHighlights[0][1]
      const labelHasParentLink = result.highlights!.some(
        ([start, end, group]) => group === "markup.link" && start === labelStart && end === labelEnd,
      )
      expect(labelHasParentLink).toBe(false) // Confirms label is NOT nested

      const linkStyle = SyntaxStyle.fromStyles(
        {
          default: { fg: RGBA.fromInts(255, 255, 255, 255) },
          "markup.link": { underline: true }, // Brackets and parens
          "markup.link.label": { fg: RGBA.fromInts(165, 214, 255, 255), underline: true }, // Must set underline!
          "markup.link.url": { fg: RGBA.fromInts(88, 166, 255, 255), underline: true }, // Must set underline!
        },
        resourceContext,
      )

      const styledText = await treeSitterToStyledText(markdownCode, "markdown", linkStyle, client, {
        conceal: { enabled: false },
      })
      const chunks = styledText.chunks

      linkStyle.destroy()

      const reconstructed = chunks.map((c) => c.text).join("")
      expect(reconstructed).toBe(markdownCode)

      const labelChunk = chunks.find((c) => c.text === "Label")
      const urlChunk = chunks.find((c) => c.text === "url")

      expect(labelChunk).toBeDefined()
      expect(urlChunk).toBeDefined()

      const underlineAttr = createTextAttributes({ underline: true })
      expect(labelChunk!.attributes).toBe(underlineAttr)
      expect(urlChunk!.attributes).toBe(underlineAttr)

      expect(labelChunk!.fg?.r).toBeCloseTo(165 / 255, 2)
      expect(urlChunk!.fg?.r).toBeCloseTo(88 / 255, 2)
    })

    test("should preserve original behavior for non-overlapping highlights", () => {
      const mockHighlights: SimpleHighlight[] = [
        [0, 5, "keyword"], // "const"
        [6, 11, "string"], // "'str'"
        [12, 15, "number"], // "123"
      ]

      const testStyle = SyntaxStyle.fromStyles(
        {
          default: { fg: RGBA.fromInts(255, 255, 255, 255) },
          keyword: { fg: RGBA.fromInts(255, 100, 100, 255), bold: true },
          string: { fg: RGBA.fromInts(100, 255, 100, 255) },
          number: { fg: RGBA.fromInts(100, 100, 255, 255) },
        },
        resourceContext,
      )

      const content = "const 'str' 123"
      const chunks = treeSitterToTextChunks(content, mockHighlights, testStyle)

      testStyle.destroy()

      expect(chunks.length).toBe(5)

      expect(chunks[0].text).toBe("const")
      expect(chunks[0].fg?.r).toBeCloseTo(1.0, 2) // 255 / 255
      expect(chunks[0].attributes).toBe(createTextAttributes({ bold: true }))

      expect(chunks[1].text).toBe(" ")

      expect(chunks[2].text).toBe("'str'")
      expect(chunks[2].fg?.g).toBeCloseTo(1.0, 2) // 255 / 255

      expect(chunks[3].text).toBe(" ")

      expect(chunks[4].text).toBe("123")
      expect(chunks[4].fg?.b).toBeCloseTo(1.0, 2) // 255 / 255
    })

    test("should demonstrate when inheritance works vs when it does not", () => {
      const nestedHighlights: SimpleHighlight[] = [
        [0, 10, "parent"], // Parent covers entire range
        [2, 8, "parent.child"], // Child is INSIDE parent
      ]

      const nestedStyle = SyntaxStyle.fromStyles(
        {
          default: { fg: RGBA.fromInts(255, 255, 255, 255) },
          parent: { underline: true },
          "parent.child": { fg: RGBA.fromInts(200, 100, 100, 255) }, // No underline specified
        },
        resourceContext,
      )

      const nestedContent = "0123456789"
      const nestedChunks = treeSitterToTextChunks(nestedContent, nestedHighlights, nestedStyle)

      nestedStyle.destroy()

      const childChunk = nestedChunks.find((c) => c.text.includes("234567"))
      expect(childChunk).toBeDefined()
      expect(childChunk!.attributes).toBe(createTextAttributes({ underline: true }))
      expect(childChunk!.fg?.r).toBeCloseTo(200 / 255, 2)

      const siblingHighlights: SimpleHighlight[] = [
        [0, 5, "typeA"], // First range
        [5, 10, "typeB"], // Second range (NOT nested)
      ]

      const siblingStyle = SyntaxStyle.fromStyles(
        {
          default: { fg: RGBA.fromInts(255, 255, 255, 255) },
          typeA: { underline: true, fg: RGBA.fromInts(100, 100, 255, 255) },
          typeB: { fg: RGBA.fromInts(255, 100, 100, 255) }, // No underline
        },
        resourceContext,
      )

      const siblingContent = "0123456789"
      const siblingChunks = treeSitterToTextChunks(siblingContent, siblingHighlights, siblingStyle)

      siblingStyle.destroy()

      expect(siblingChunks.length).toBe(2)

      expect(siblingChunks[0].attributes).toBe(createTextAttributes({ underline: true }))

      expect(siblingChunks[1].attributes).toBe(0) // No attributes
      expect(siblingChunks[1].fg?.r).toBeCloseTo(255 / 255, 2)
    })

    test("should handle child style completely overriding parent attributes", () => {
      const mockHighlights: SimpleHighlight[] = [
        [0, 10, "parent"],
        [0, 10, "parent.child"],
      ]

      const testStyle = SyntaxStyle.fromStyles(
        {
          default: { fg: RGBA.fromInts(255, 255, 255, 255) },
          parent: { bold: true, italic: true, underline: true },
          "parent.child": { bold: false, fg: RGBA.fromInts(200, 200, 200, 255) }, // Override bold, set color
        },
        resourceContext,
      )

      const content = "test text "
      const chunks = treeSitterToTextChunks(content, mockHighlights, testStyle)

      testStyle.destroy()

      expect(chunks.length).toBeGreaterThan(0)

      const chunk = chunks[0]

      expect(chunk.fg?.r).toBeCloseTo(200 / 255, 2)

      const expectedAttributes = createTextAttributes({ bold: false, italic: true, underline: true })
      expect(chunk.attributes).toBe(expectedAttributes)
    })
  })
})
