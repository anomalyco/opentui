import type { Renderable } from "../../Renderable.js"
import { test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test"
import { Edge } from "../../yoga.js"
import {
  createMarkdownCodeBlockRenderer,
  MarkdownRenderable,
  type MarkdownInlineContext,
  type MarkdownInlineHook,
  type MarkdownInlineSpan,
  type MarkdownOptions,
} from "../Markdown.js"
import { CodeRenderable } from "../Code.js"
import { BoxRenderable } from "../Box.js"
import { TextRenderable } from "../Text.js"
import { TextTableRenderable } from "../TextTable.js"
import { ScrollBoxRenderable } from "../ScrollBox.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { RGBA } from "../../lib/RGBA.js"
import { TreeSitterClient } from "../../lib/tree-sitter/index.js"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import {
  createTestRenderer,
  type MockMouse,
  type TestRenderer,
  MockTreeSitterClient,
  setRendererCapabilities,
  TestRecorder,
} from "../../testing.js"
import { ManualClock } from "../../testing/manual-clock.js"
import { createTestStdout } from "../../testing/test-streams.js"
import { NativeSession } from "../../NativeSession.js"
import { TextAttributes, type CapturedFrame } from "../../types.js"
import type { SimpleHighlight, TreeSitterWorkerRequest } from "../../lib/tree-sitter/types.js"
import { TextBuffer } from "../../text-buffer.js"
import { stringWidth } from "../../platform/runtime.js"
import { resolveRenderLib } from "../../zig.js"
import corpus from "../markdown.conformance.json" with { type: "json" }

let renderer: TestRenderer
let mockMouse: MockMouse
let renderOnce: () => Promise<void>
let captureFrame: () => string
let captureSpans: () => CapturedFrame
let resizeRenderer: (width: number, height: number) => void
let markdownTreeSitterClient: TreeSitterClient
let mockTreeSitterClients: MockTreeSitterClient[] = []
const HIGHLIGHT_TIMEOUT_MS = 5000

let syntaxStyle: SyntaxStyle
const ISSUE_TABLE_MARKDOWN = `| Rank | Issue | Size | Why It Is Ready | Likely Surface |
| --- | --- | --- | --- | --- |
| 1 | A moderately long linked issue title | XS | A longer prose explanation of why the issue is ready. | packages/tui/src/context/sdk.tsx |
| 2 | Another moderately long linked issue title | XS/S | Another longer prose explanation. | packages/core/src/tool/subagent.ts |`

beforeAll(async () => {
  const dataPath = join(tmpdir(), "tree-sitter-markdown-renderable-test-data")
  await mkdir(dataPath, { recursive: true })

  markdownTreeSitterClient = new TreeSitterClient({ dataPath })
  await markdownTreeSitterClient.initialize()
})

beforeEach(async () => {
  mockTreeSitterClients = []
  const testRenderer = await createTestRenderer({ width: 60, height: 40 })
  renderer = testRenderer.renderer
  syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } }, renderer.nativeScene!)
  mockMouse = testRenderer.mockMouse
  renderOnce = testRenderer.renderOnce
  captureFrame = testRenderer.captureCharFrame
  captureSpans = testRenderer.captureSpans
  resizeRenderer = testRenderer.resize
})

afterEach(async () => {
  if (renderer) {
    renderer.destroy()
    await renderer.closed
  }
  syntaxStyle?.destroy()

  for (const client of mockTreeSitterClients) {
    client.resolveAllHighlightOnce()
    await client.destroy()
  }
})

afterAll(async () => {
  await markdownTreeSitterClient.destroy()
})

function createMarkdownRenderable(options: MarkdownOptions): MarkdownRenderable {
  return new MarkdownRenderable(renderer, {
    treeSitterClient: markdownTreeSitterClient,
    ...options,
  })
}

function createMockTreeSitterClient(): MockTreeSitterClient {
  const client = new MockTreeSitterClient()
  mockTreeSitterClients.push(client)
  return client
}

test.each([
  ["content", "```\nnew\n```"],
  ["streaming", true],
  ["renderBlock", () => null],
] as const)("%s rejection preserves state and permits retry", (property, value) => {
  const markdown = createMarkdownRenderable({ content: "```\nold\n```", syntaxStyle })
  renderer.root.add(markdown)
  const before = markdown[property]
  const host = renderer.nativeScene.driver.renderLib.getYogaHost()
  host.invokeCallback(() => Object.assign(markdown, { [property]: value }))
  expect(() => host.throwCallbackError()).toThrow("Cannot mutate Yoga during a callback")
  expect(markdown[property]).toBe(before)
  Object.assign(markdown, { [property]: value })
  expect(markdown[property]).toBe(value)
})

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function waitForHighlight(codeRenderable: CodeRenderable): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      codeRenderable.highlightingDone,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Timed out waiting for CodeRenderable highlighting")),
          HIGHLIGHT_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }

  await flushAsync()
}

function getPendingMarkdownParagraphHighlights(md: MarkdownRenderable, fences = false): CodeRenderable[] {
  const children = [...md.getChildren()]
  const pending: CodeRenderable[] = []

  while (children.length > 0) {
    const child = children.pop()!
    if (child instanceof CodeRenderable && (fences || child.filetype === "markdown") && child.isHighlighting) {
      pending.push(child)
    }
    children.push(...child.getChildren())
  }

  return pending
}

async function renderMarkdownRenderable(md: MarkdownRenderable, fences = false): Promise<void> {
  await renderOnce()

  for (let attempt = 0; attempt < 20; attempt++) {
    const pendingHighlights = getPendingMarkdownParagraphHighlights(md, fences)
    if (pendingHighlights.length === 0) {
      await renderOnce()
      return
    }

    await Promise.all(pendingHighlights.map((codeBlock) => waitForHighlight(codeBlock)))
    await renderOnce()
  }

  throw new Error("Timed out waiting for markdown paragraph highlights")
}

async function renderMarkdown(markdown: string, conceal: boolean = true): Promise<string> {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: markdown,
    syntaxStyle,
    conceal,
    tableOptions: { widthMode: "content" },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  return "\n" + lines.join("\n").trimEnd()
}

function findSpanContaining(frame: CapturedFrame, text: string) {
  for (const line of frame.lines) {
    const span = line.spans.find((candidate) => candidate.text.includes(text))
    if (span) return span
  }

  return undefined
}

function findRenderedText(text: string): { x: number; y: number } {
  const lines = captureFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  return { x: stringWidth(lines[y]!.slice(0, lines[y]!.indexOf(text))), y }
}

/** The kinds of the top-level blocks, in order. */
function topKinds(md: MarkdownRenderable) {
  return md.getChildren().map((child) => md.blocks.find((block) => block.renderable === child)?.kind)
}

function getTableColumnWidths(headerY: number): number[] {
  const borderXs = renderer.currentRenderBuffer.withBuffers(({ char }) =>
    Array.from({ length: renderer.width }, (_, x) => x).filter(
      (x) => char[headerY * renderer.width + x] === "│".codePointAt(0),
    ),
  )
  return borderXs.slice(1).map((x, index) => x - borderXs[index]! - 1)
}

test("basic table alignment", async () => {
  const markdown = `| Name | Age |
|---|---|
| Alice | 30 |
| Bob | 5 |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌─────┬───┐
    │Name │Age│
    ├─────┼───┤
    │Alice│30 │
    ├─────┼───┤
    │Bob  │5  │
    └─────┴───┘"
  `)
})

test("tableOptions.widthMode configures markdown table layout", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-table-width-mode",
    content: "| Name | Age |\n|---|---|\n| Alice | 30 |",
    syntaxStyle,
    tableOptions: {
      widthMode: "full",
      columnFitter: "balanced",
    },
  })

  renderer.root.add(md)
  await renderer.idle()

  const table = md.getChildren()[0] as TextTableRenderable
  expect(table).toBeInstanceOf(TextTableRenderable)
  expect(table.columnWidthMode).toBe("full")
  expect(table.columnFitter).toBe("balanced")
})

test("wide five-column tables preserve short metadata columns", async () => {
  resizeRenderer(110, 40)
  const md = createMarkdownRenderable({
    id: "markdown-wide-metadata-table",
    content: ISSUE_TABLE_MARKDOWN,
    syntaxStyle,
    tableOptions: { style: "grid" },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const frame = captureFrame()
  const headerY = frame.split("\n").findIndex((line) => line.includes("Ran"))
  expect(headerY).toBeGreaterThanOrEqual(0)

  const columnWidths = getTableColumnWidths(headerY)

  expect(columnWidths).toEqual([4, 32, 4, 36, 28])
  expect(columnWidths.reduce((sum, width) => sum + width, 0)).toBe(104)
  expect(columnWidths[0]).toBeGreaterThanOrEqual(4)
  expect(columnWidths[2]).toBeGreaterThanOrEqual(4)
  expect(columnWidths[1]).toBeGreaterThanOrEqual("Issue".length)
  expect(columnWidths[3]).toBeGreaterThanOrEqual("Why It Is Ready".length)
  expect(columnWidths[4]).toBeGreaterThanOrEqual("Likely Surface".length)
  expect(frame).toContain("│Rank")
  expect(frame).toContain("│Size")
  expect(frame).toContain("XS/S")
})

test("five-column tables still shrink metadata columns when constrained", async () => {
  resizeRenderer(20, 120)
  const md = createMarkdownRenderable({
    id: "markdown-narrow-metadata-table",
    content: ISSUE_TABLE_MARKDOWN,
    syntaxStyle,
    tableOptions: { style: "grid" },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const frame = captureFrame()
  const headerY = frame.split("\n").findIndex((line) => line.includes("│"))
  expect(headerY).toBeGreaterThanOrEqual(0)

  const columnWidths = getTableColumnWidths(headerY)
  expect(columnWidths.reduce((sum, width) => sum + width, 0)).toBe(14)
  expect(columnWidths.every((width) => width >= 1)).toBe(true)
  expect(columnWidths[0]).toBeLessThan(4)
  expect(columnWidths[2]).toBeLessThan(4)
})

test("tableOptions updates existing markdown table renderable", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-table-updates",
    content: "| Name | Age |\n|---|---|\n| Alice | 30 |",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderer.idle()

  const table = md.getChildren()[0] as TextTableRenderable
  expect(table).toBeInstanceOf(TextTableRenderable)
  expect(table.columnWidthMode).toBe("full")

  md.tableOptions = {
    widthMode: "full",
    columnFitter: "balanced",
    wrapMode: "word",
    cellPadding: 1,
    cellPaddingX: 2,
    cellPaddingY: 0,
    borders: false,
    selectable: false,
  }

  await renderer.idle()

  const updatedTable = md.getChildren()[0] as TextTableRenderable
  expect(updatedTable).toBe(table)
  expect(updatedTable.columnWidthMode).toBe("full")
  expect(updatedTable.columnFitter).toBe("balanced")
  expect(updatedTable.wrapMode).toBe("word")
  expect(updatedTable.cellPadding).toBe(0)
  expect(updatedTable.cellPaddingX).toBe(2)
  expect(updatedTable.cellPaddingY).toBe(0)
  expect(updatedTable.border).toBe(false)
  expect(updatedTable.outerBorder).toBe(false)
  expect(updatedTable.showBorders).toBe(false)
  expect(updatedTable.selectable).toBe(false)
})

test("tableOptions.cellPaddingX pads cells horizontally without vertical padding", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-table-horizontal-padding",
    content: "| A | B |\n|---|---|\n| 1 | 2 |",
    syntaxStyle,
    tableOptions: { style: "grid", widthMode: "content", cellPaddingX: 1, cellPaddingY: 0 },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    ┌───┬───┐
    │ A │ B │
    ├───┼───┤
    │ 1 │ 2 │
    └───┴───┘"
  `)
})

test("tableOptions.style updates existing markdown table renderable content layout", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-table-style-updates",
    content: "| Name | Age |\n|---|---|\n| Alice | 30 |",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const table = md.getChildren()[0] as TextTableRenderable
  expect(table).toBeInstanceOf(TextTableRenderable)
  expect(table.border).toBe(true)

  md.tableOptions = { style: "columns" }

  await renderer.idle()

  const updatedTable = md.getChildren()[0] as TextTableRenderable
  expect(updatedTable).toBe(table)
  expect(updatedTable.columnWidthMode).toBe("content")
  expect(updatedTable.columnGap).toBe(2)
  expect(updatedTable.border).toBe(false)
  expect(updatedTable.outerBorder).toBe(false)
  expect(updatedTable.showBorders).toBe(false)

  const rendered = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(rendered).not.toContain("┌")
  expect(rendered).toMatch(/Name\s{2,}Age/)
  expect(rendered).toMatch(/Alice\s{2,}30/)
})

test("borderless column tables keep visual spacing out of copied text", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-table-selection",
    content: "| Name | Age |\n|---|---|\n| Alice | 30 |",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const table = md.getChildren()[0] as TextTableRenderable
  expect(table).toBeInstanceOf(TextTableRenderable)

  const lines = captureFrame().split("\n")
  const headerY = lines.findIndex((line) => line.includes("Name"))
  const rowY = lines.findIndex((line) => line.includes("Alice"))
  const startX = lines[headerY]!.indexOf("Name")
  const endX = table.x + table.width - 1

  await mockMouse.drag(startX, headerY, endX, rowY)
  await renderer.idle()

  expect(table.getSelectedText()).toBe("Name\tAge\nAlice\t30")
})

test("table with inline code (backticks)", async () => {
  const markdown = `| Command | Description |
|---|---|
| \`npm install\` | Install deps |
| \`npm run build\` | Build project |
| \`npm test\` | Run tests |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌─────────────┬─────────────┐
    │Command      │Description  │
    ├─────────────┼─────────────┤
    │npm install  │Install deps │
    ├─────────────┼─────────────┤
    │npm run build│Build project│
    ├─────────────┼─────────────┤
    │npm test     │Run tests    │
    └─────────────┴─────────────┘"
  `)
})

test("table with bold text", async () => {
  const markdown = `| Feature | Status |
|---|---|
| **Authentication** | Done |
| **API** | WIP |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌──────────────┬──────┐
    │Feature       │Status│
    ├──────────────┼──────┤
    │Authentication│Done  │
    ├──────────────┼──────┤
    │API           │WIP   │
    └──────────────┴──────┘"
  `)
})

test("table with italic text", async () => {
  const markdown = `| Item | Note |
|---|---|
| One | *important* |
| Two | *ok* |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌────┬─────────┐
    │Item│Note     │
    ├────┼─────────┤
    │One │important│
    ├────┼─────────┤
    │Two │ok       │
    └────┴─────────┘"
  `)
})

test("table with mixed formatting", async () => {
  const markdown = `| Type | Value | Notes |
|---|---|---|
| **Bold** | \`code\` | *italic* |
| Plain | **strong** | \`cmd\` |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌─────┬──────┬──────┐
    │Type │Value │Notes │
    ├─────┼──────┼──────┤
    │Bold │code  │italic│
    ├─────┼──────┼──────┤
    │Plain│strong│cmd   │
    └─────┴──────┴──────┘"
  `)
})

test("table with empty cells", async () => {
  const markdown = `| A | B |
|---|---|
| X |  |
|  | Y |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌─┬─┐
    │A│B│
    ├─┼─┤
    │X│ │
    ├─┼─┤
    │ │Y│
    └─┴─┘"
  `)
})

test("table with long header and short content", async () => {
  const markdown = `| Very Long Column Header | Short |
|---|---|
| A | B |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌───────────────────────┬─────┐
    │Very Long Column Header│Short│
    ├───────────────────────┼─────┤
    │A                      │B    │
    └───────────────────────┴─────┘"
  `)
})

test("table with short header and long content", async () => {
  const markdown = `| X | Y |
|---|---|
| This is very long content | Short |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌─────────────────────────┬─────┐
    │X                        │Y    │
    ├─────────────────────────┼─────┤
    │This is very long content│Short│
    └─────────────────────────┴─────┘"
  `)
})

test("table inside code block should NOT be formatted", async () => {
  const markdown = `\`\`\`
| Not | A | Table |
|---|---|---|
| Should | Stay | Raw |
\`\`\`

| Real | Table |
|---|---|
| Is | Formatted |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    | Not | A | Table |
    |---|---|---|
    | Should | Stay | Raw |

    ┌────┬─────────┐
    │Real│Table    │
    ├────┼─────────┤
    │Is  │Formatted│
    └────┴─────────┘"
  `)
})

test("paragraphs and fenced code blocks keep markdown block spacing", async () => {
  const markdown = `Before

\`\`\`ts
const value = 1
\`\`\`

After`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Before

    const value = 1

    After"
  `)
})

test("paragraphs keep spacing when a fenced code block is appended", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-append-code-spacing",
    content: "Before",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  md.content = `Before

\`\`\`ts
const value = 1
\`\`\``
  await renderMarkdownRenderable(md)

  expect(topKinds(md)).toEqual(["paragraph", "code"])

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    Before

    const value = 1"
  `)
})

test("paragraph margins update when a following fenced code block is removed", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-remove-code-spacing",
    content: `Before

\`\`\`ts
const value = 1
\`\`\``,
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  md.content = "Before"
  await renderMarkdownRenderable(md)

  expect(topKinds(md)).toEqual(["paragraph"])
})

test("code block margins update when a following paragraph is removed", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-remove-paragraph-after-code-spacing",
    content: `\`\`\`ts
const value = 1
\`\`\`

After`,
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  expect(topKinds(md)).toEqual(["code", "paragraph"])

  md.content = `\`\`\`ts
const value = 1
\`\`\``
  await renderMarkdownRenderable(md)

  expect(topKinds(md)).toEqual(["code"])
})

test("tight paragraphs and fenced code blocks keep exactly one separator row", async () => {
  const markdown = `Before
\`\`\`ts
const value = 1
\`\`\``

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Before

    const value = 1"
  `)
})

test("headings and fenced code blocks keep exactly one separator row", async () => {
  const markdown = `## Before

\`\`\`ts
const value = 1
\`\`\``

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Before

    const value = 1"
  `)
})

test("headings and tables keep exactly one separator row", async () => {
  const markdown = `## Before

| A | B |
|---|---|
| 1 | 2 |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Before

    ┌─┬─┐
    │A│B│
    ├─┼─┤
    │1│2│
    └─┴─┘"
  `)
})

test("headings and blockquotes keep exactly one separator row", async () => {
  const markdown = `## Before

> quoted text`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Before

    │ quoted text"
  `)
})

test("headings and horizontal rules keep exactly one separator row", async () => {
  const markdown = `## Before

---`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Before

    ────────────────────────────────────────────────────────────"
  `)
})

test("multiple tables in same document", async () => {
  const markdown = `| Table1 | A |
|---|---|
| X | Y |

Some text between.

| Table2 | BB |
|---|---|
| Long content | Z |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌──────┬─┐
    │Table1│A│
    ├──────┼─┤
    │X     │Y│
    └──────┴─┘

    Some text between.

    ┌────────────┬──┐
    │Table2      │BB│
    ├────────────┼──┤
    │Long content│Z │
    └────────────┴──┘"
  `)
})

test("table with escaped pipe character", async () => {
  const markdown = `| Command | Output |
|---|---|
| echo | Hello |
| ls \\| grep | Filtered |
| \\$rate | \\*x\\* |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌─────────┬────────┐
    │Command  │Output  │
    ├─────────┼────────┤
    │echo     │Hello   │
    ├─────────┼────────┤
    │ls | grep│Filtered│
    ├─────────┼────────┤
    │$rate    │*x*     │
    └─────────┴────────┘"
  `)
})

test("table with unicode characters", async () => {
  const markdown = `| Emoji | Name |
|---|---|
| 🎉 | Party |
| 🚀 | Rocket |
| 日本語 | Japanese |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌──────┬────────┐
    │Emoji │Name    │
    ├──────┼────────┤
    │🎉    │Party   │
    ├──────┼────────┤
    │🚀    │Rocket  │
    ├──────┼────────┤
    │日本語│Japanese│
    └──────┴────────┘"
  `)
})

test("table with links", async () => {
  const markdown = `| Name | Link |
|---|---|
| Google | [link](https://google.com) |
| GitHub | [gh](https://github.com) |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌──────┬─────────────────────────┐
    │Name  │Link                     │
    ├──────┼─────────────────────────┤
    │Google│link (https://google.com)│
    ├──────┼─────────────────────────┤
    │GitHub│gh (https://github.com)  │
    └──────┴─────────────────────────┘"
  `)
})

test("single row table (header + delimiter only)", async () => {
  const markdown = `| Only | Header |
|---|---|`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌────┬──────┐
    │Only│Header│
    └────┴──────┘"
  `)
})

test("table with many columns", async () => {
  const markdown = `| A | B | C | D | E |
|---|---|---|---|---|
| 1 | 2 | 3 | 4 | 5 |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌─┬─┬─┬─┬─┐
    │A│B│C│D│E│
    ├─┼─┼─┼─┼─┤
    │1│2│3│4│5│
    └─┴─┴─┴─┴─┘"
  `)
})

test("a table may hold more native objects than the renderer's initial object capacity", async () => {
  // Each cell holds a text buffer and a view, so 4 x 21 cells need more than 64 slots.
  const stdout = createTestStdout(20, 4)
  const nativeSession = new NativeSession(stdout, { context: { objectCapacity: 64, renderCellsMax: 1_000_000 } })
  const setup = await createTestRenderer({ width: 20, height: 4, stdout, nativeSession, bufferedOutput: "stdout" })
  try {
    const rows = Array.from({ length: 21 }, (_, r) => `|${r}|${r}|${r}|${r}|${r === 0 ? "\n|-|-|-|-|" : ""}`)
    const syntaxStyle = SyntaxStyle.create(setup.renderer.nativeScene)
    setup.renderer.root.add(new MarkdownRenderable(setup.renderer, { content: rows.join("\n"), syntaxStyle }))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("│0   │0   │0   │0  │")
  } finally {
    setup.renderer.destroy()
    await setup.renderer.closed
  }
})

test("no tables returns original content", async () => {
  const markdown = `# Just a heading

Some paragraph text.

- List item`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Just a heading

    Some paragraph text.

    - List item"
  `)
})

test("table with nested inline formatting", async () => {
  const markdown = `| Description |
|---|
| This has **bold and \`code\`** together |
| And *italic with **nested bold*** |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌───────────────────────────────┐
    │Description                    │
    ├───────────────────────────────┤
    │This has bold and code together│
    ├───────────────────────────────┤
    │And italic with nested bold    │
    └───────────────────────────────┘"
  `)
})

// Tests with conceal=false - formatting markers should be visible and columns sized accordingly

test("conceal=false: table with bold text", async () => {
  const markdown = `| Feature | Status |
|---|---|
| **Authentication** | Done |
| **API** | WIP |`

  expect(await renderMarkdown(markdown, false)).toMatchInlineSnapshot(`
    "
    ┌──────────────────┬──────┐
    │Feature           │Status│
    ├──────────────────┼──────┤
    │**Authentication**│Done  │
    ├──────────────────┼──────┤
    │**API**           │WIP   │
    └──────────────────┴──────┘"
  `)
})

test("conceal=false: table with inline code", async () => {
  const markdown = `| Command | Description |
|---|---|
| \`npm install\` | Install deps |
| \`npm run build\` | Build project |`

  expect(await renderMarkdown(markdown, false)).toMatchInlineSnapshot(`
    "
    ┌───────────────┬─────────────┐
    │Command        │Description  │
    ├───────────────┼─────────────┤
    │\`npm install\`  │Install deps │
    ├───────────────┼─────────────┤
    │\`npm run build\`│Build project│
    └───────────────┴─────────────┘"
  `)
})

test("conceal=false: table with italic text", async () => {
  const markdown = `| Item | Note |
|---|---|
| One | *important* |
| Two | *ok* |`

  expect(await renderMarkdown(markdown, false)).toMatchInlineSnapshot(`
    "
    ┌────┬───────────┐
    │Item│Note       │
    ├────┼───────────┤
    │One │*important*│
    ├────┼───────────┤
    │Two │*ok*       │
    └────┴───────────┘"
  `)
})

test("conceal=false: table with mixed formatting", async () => {
  const markdown = `| Type | Value | Notes |
|---|---|---|
| **Bold** | \`code\` | *italic* |
| Plain | **strong** | \`cmd\` |`

  expect(await renderMarkdown(markdown, false)).toMatchInlineSnapshot(`
    "
    ┌────────┬──────────┬────────┐
    │Type    │Value     │Notes   │
    ├────────┼──────────┼────────┤
    │**Bold**│\`code\`    │*italic*│
    ├────────┼──────────┼────────┤
    │Plain   │**strong**│\`cmd\`   │
    └────────┴──────────┴────────┘"
  `)
})

test("conceal=false: table with unicode characters", async () => {
  const markdown = `| Emoji | Name |
|---|---|
| 🎉 | Party |
| 🚀 | Rocket |
| 日本語 | Japanese |`

  expect(await renderMarkdown(markdown, false)).toMatchInlineSnapshot(`
    "
    ┌──────┬────────┐
    │Emoji │Name    │
    ├──────┼────────┤
    │🎉    │Party   │
    ├──────┼────────┤
    │🚀    │Rocket  │
    ├──────┼────────┤
    │日本語│Japanese│
    └──────┴────────┘"
  `)
})

test("conceal=false: basic table alignment", async () => {
  const markdown = `| Name | Age |
|---|---|
| Alice | 30 |
| Bob | 5 |`

  expect(await renderMarkdown(markdown, false)).toMatchInlineSnapshot(`
    "
    ┌─────┬───┐
    │Name │Age│
    ├─────┼───┤
    │Alice│30 │
    ├─────┼───┤
    │Bob  │5  │
    └─────┴───┘"
  `)
})

test("table with paragraphs before and after", async () => {
  const markdown = `This is a paragraph before the table.

| Name | Age |
|---|---|
| Alice | 30 |

This is a paragraph after the table.`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    This is a paragraph before the table.

    ┌─────┬───┐
    │Name │Age│
    ├─────┼───┤
    │Alice│30 │
    └─────┴───┘

    This is a paragraph after the table."
  `)
})

test("selection across markdown table includes table data", async () => {
  const markdown = `Intro line above table.

| Component | Status | Notes |
|---|---|---|
| Authentication | **Done** | OAuth2 + SSO |
| Payments API | *In Progress* | Retry + idempotency |
| Search Indexer | \`Done\` | Ranking + typo fix |

Outro line below table.`

  const md = createMarkdownRenderable({
    id: "markdown",
    content: markdown,
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const topBlock = md.getChildren()[0] as TextRenderable | undefined
  const tableBlock = md.getChildren()[1] as TextTableRenderable | undefined
  const bottomBlock = md.getChildren()[2] as TextRenderable | undefined

  expect(topBlock).toBeInstanceOf(TextRenderable)
  expect(tableBlock).toBeInstanceOf(TextTableRenderable)
  expect(bottomBlock).toBeInstanceOf(TextRenderable)

  const startX = topBlock!.x + 1
  const startY = topBlock!.y
  const endX = Math.max(bottomBlock!.x + bottomBlock!.width - 2, startX + 1)
  const endY = bottomBlock!.y

  await mockMouse.drag(startX, startY, endX, endY)
  await renderer.idle()

  const selectedText = renderer.getSelection()?.getSelectedText() ?? ""

  expect(selectedText).toContain("Authentication")
  expect(selectedText).toContain("Payments API")
  expect(selectedText).toContain("Retry + idempotency")
})

// Code block tests

test("code block with language", async () => {
  const markdown = `\`\`\`typescript
const x = 1;
console.log(x);
\`\`\``

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    const x = 1;
    console.log(x);"
  `)
})

test("code block without language", async () => {
  const markdown = `\`\`\`
plain code block
with multiple lines
\`\`\``

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    plain code block
    with multiple lines"
  `)
})

test("code block mixed with text", async () => {
  const markdown = `Here is some code:

\`\`\`js
function hello() {
  return "world";
}
\`\`\`

And here is more text after.`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Here is some code:

    function hello() {
      return "world";
    }

    And here is more text after."
  `)
})

test("multiple code blocks", async () => {
  const markdown = `First block:

\`\`\`python
print("hello")
\`\`\`

Second block:

\`\`\`rust
fn main() {}
\`\`\``

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    First block:

    print("hello")

    Second block:

    fn main() {}"
  `)
})

test("code block in conceal=false mode", async () => {
  const markdown = `\`\`\`js
const x = 1;
\`\`\``

  expect(await renderMarkdown(markdown, false)).toMatchInlineSnapshot(`
    "
    const x = 1;"
  `)
})

test("code block concealment is disabled by default", async () => {
  const mockTreeSitterClient = createMockTreeSitterClient()
  mockTreeSitterClient.setMockResult({
    highlights: [[0, 1, "conceal", { conceal: "" }]],
  })

  const md = createMarkdownRenderable({
    id: "markdown-code-default-conceal",
    content: "```markdown\n# Hidden heading\n```",
    syntaxStyle,
    conceal: true,
    treeSitterClient: mockTreeSitterClient,
  })

  renderer.root.add(md)
  await renderer.idle()
  expect(mockTreeSitterClient.isHighlighting()).toBe(true)

  const codeBlock = md.getChildren()[0] as CodeRenderable
  mockTreeSitterClient.resolveAllHighlightOnce()
  await waitForHighlight(codeBlock)
  await renderer.idle()

  const frame = captureFrame()
  expect(frame).toContain("# Hidden heading")
})

test("code block concealment can be enabled with concealCode", async () => {
  setRendererCapabilities(renderer, { hyperlinks: false })
  const mockTreeSitterClient = createMockTreeSitterClient()
  mockTreeSitterClient.setMockResult({
    highlights: [[0, 1, "conceal", { conceal: "" }]],
  })

  const md = createMarkdownRenderable({
    id: "markdown-code-conceal-enabled",
    content: "```markdown\n# Hidden heading\n```\n\nPlain **prose**\n\n| Name |\n|---|\n| Value |",
    syntaxStyle,
    conceal: true,
    concealCode: true,
    treeSitterClient: mockTreeSitterClient,
    tableOptions: { widthMode: "content" },
  })

  renderer.root.add(md)
  await renderer.idle()
  expect(mockTreeSitterClient.isHighlighting()).toBe(true)

  const codeBlock = md.getChildren()[0] as CodeRenderable
  const prose = md.getChildren()[1] as CodeRenderable
  const table = md.getChildren()[2] as TextTableRenderable
  mockTreeSitterClient.resolveAllHighlightOnce()
  await Promise.all([waitForHighlight(codeBlock), waitForHighlight(prose)])
  await renderer.idle()

  const onHighlight = prose.onHighlight
  const tableContent = table.content
  const frame = captureFrame()
  expect(frame).not.toContain("# Hidden heading")
  expect(frame).toContain("Hidden heading")

  for (const hyperlinks of [true, false]) {
    renderer.emit("capabilities", setRendererCapabilities(renderer, { hyperlinks }))
    await renderOnce()

    expect(codeBlock.onHighlight).toBeUndefined()
    expect(prose.onHighlight).toBe(onHighlight)
    expect(md.getChildren()[2]).toBe(table)
    expect(table.content).toBe(tableContent)
    expect(mockTreeSitterClient.isHighlighting()).toBe(false)
    expect(captureFrame()).toBe(frame)
  }
})

test("toggling concealCode updates existing code block renderables", async () => {
  const mockTreeSitterClient = createMockTreeSitterClient()
  mockTreeSitterClient.setMockResult({
    highlights: [[0, 1, "conceal", { conceal: "" }]],
  })

  const md = createMarkdownRenderable({
    id: "markdown-code-conceal-toggle",
    content: "```markdown\n# Hidden heading\n```",
    syntaxStyle,
    conceal: true,
    concealCode: false,
    treeSitterClient: mockTreeSitterClient,
  })

  renderer.root.add(md)
  await renderer.idle()
  expect(mockTreeSitterClient.isHighlighting()).toBe(true)

  const codeBlock = md.getChildren()[0] as CodeRenderable
  mockTreeSitterClient.resolveAllHighlightOnce()
  await waitForHighlight(codeBlock)
  await renderer.idle()

  const frameBefore = captureFrame()
  expect(frameBefore).toContain("# Hidden heading")

  md.concealCode = true
  renderer.requestRender()
  await renderer.idle()
  expect(mockTreeSitterClient.isHighlighting()).toBe(true)

  mockTreeSitterClient.resolveAllHighlightOnce()
  await waitForHighlight(codeBlock)
  await renderer.idle()

  const frameAfter = captureFrame()
  expect(frameAfter).not.toContain("# Hidden heading")
  expect(frameAfter).toContain("Hidden heading")
})

// Heading tests

test("headings h1 through h3", async () => {
  const markdown = `# Heading 1

## Heading 2

### Heading 3`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Heading 1

    Heading 2

    Heading 3"
  `)
})

test("headings with conceal=false show markers", async () => {
  const markdown = `# Heading 1

## Heading 2`

  expect(await renderMarkdown(markdown, false)).toMatchInlineSnapshot(`
    "
    # Heading 1

    ## Heading 2"
  `)
})

// List tests

test("unordered list", async () => {
  const markdown = `- Item one
- Item two
- Item three`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    - Item one
    - Item two
    - Item three"
  `)
})

test("ordered list", async () => {
  const markdown = `1. First item
2. Second item
3. Third item`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    1. First item
    2. Second item
    3. Third item"
  `)
})

test("list with inline formatting", async () => {
  const markdown = `- **Bold** item
- *Italic* item
- \`Code\` item`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    - Bold item
    - Italic item
    - Code item"
  `)
})

test("task lists render checkbox and text on the same line", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-structured-task-list",
    content: `- [x] Done
- [ ] Todo`,
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())

  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    - ☑ Done
    - ☐ Todo"
  `)
})

test("selection across top-level unordered list copies marker and text on same line", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-structured-list-selection",
    content: `- First item
- Second item`,
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const list = md.getChildren()[0]
  expect(list).toBeInstanceOf(BoxRenderable)

  await mockMouse.drag(list!.x, list!.y, list!.x + 20, list!.y + 1)
  await renderer.idle()

  expect(renderer.getSelection()?.getSelectedText()).toBe("- First item\n- Second item")
})

test("selection across top-level ordered list copies marker and text on same line", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-structured-ordered-list-selection",
    content: `9. Nine
10. Ten`,
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const list = md.getChildren()[0]
  expect(list).toBeInstanceOf(BoxRenderable)

  await mockMouse.drag(list!.x, list!.y, list!.x + 20, list!.y + 1)
  await renderer.idle()

  expect(renderer.getSelection()?.getSelectedText()).toBe(" 9. Nine\n10. Ten")
})

test("top-level structured lists align nested fenced code under nested content", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-structured-list-code",
    content: `1. First ordered item with \`inline code\`.
2. Second ordered item before a nested list:
   - Nested bullet before fenced code:

     \`\`\`ts
     const nested = true
     \`\`\`

3. Third ordered item after the nested fence.`,
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    1. First ordered item with inline code.

    2. Second ordered item before a nested list:

       - Nested bullet before fenced code:

         const nested = true

    3. Third ordered item after the nested fence."
  `)
})

test("top-level structured ordered lists align multi-digit markers", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-structured-list-numbering",
    content: `9. nine
10. ten
11. eleven`,
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
     9. nine
    10. ten
    11. eleven"
  `)
})

test("streaming structured lists reuse existing renderables while appending", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-streaming-structured-list-reuse",
    content: "- first",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const listBefore = md.getChildren()[0]
  const firstRowBefore = listBefore?.getChildren()[0]
  const firstTextBefore = firstRowBefore?.getChildren()[1]?.getChildren()[0]

  expect(listBefore).toBeInstanceOf(BoxRenderable)
  expect(firstRowBefore).toBeInstanceOf(BoxRenderable)
  expect(firstTextBefore).toBeInstanceOf(TextRenderable)

  md.content = "- first\n- second"
  await renderMarkdownRenderable(md)

  const listAfter = md.getChildren()[0]
  const firstRowAfter = listAfter?.getChildren()[0]
  const firstTextAfter = firstRowAfter?.getChildren()[1]?.getChildren()[0]

  expect(listAfter).toBe(listBefore)
  expect(firstRowAfter).toBe(firstRowBefore)
  expect(firstTextAfter).toBe(firstTextBefore)
})

test("assistant-style top-level markdown layout", async () => {
  const md = createMarkdownRenderable({
    id: "assistant-style-layout",
    content: `# OpenTUI Markdown Demo

Welcome to the **MarkdownRenderable** showcase! This demonstrates automatic table alignment.

## Features

- Automatic **table column alignment** based on content width
- Proper handling of \`inline code\`, **bold**, and *italic* in tables

## Renderer Stress Cases

### Interleaved Code

Start with a short conclusion before any code appears.

\`\`\`ts
export function parse(input: string) {
  return input.trim().split(/\\\\s+/)
}
\`\`\`

Then continue with prose immediately after the code block.

### Quote, Table, Diff

> Quoted note after the list. It should preserve quote styling.

| Feature | Stress |
| --- | --- |
| Markdown | prose/code/table interleave |
| Renderer | wrapping and spacing |

\`\`\`diff
- const renderer = oldMarkdown
+ const renderer = experimentalMarkdown
\`\`\`

---`,
    syntaxStyle,
    tableOptions: { style: "grid", widthMode: "content", cellPaddingX: 1 },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    OpenTUI Markdown Demo
    
    Welcome to the MarkdownRenderable showcase! This
    demonstrates automatic table alignment.
    
    Features
    
    - Automatic table column alignment based on content width
    - Proper handling of inline code, bold, and italic in tables
    
    Renderer Stress Cases
    
    Interleaved Code
    
    Start with a short conclusion before any code appears.
    
    export function parse(input: string) {
      return input.trim().split(/\\\\s+/)
    }
    
    Then continue with prose immediately after the code block.
    
    Quote, Table, Diff
    
    │ Quoted note after the list. It should preserve quote
    │ styling.

    ┌──────────┬─────────────────────────────┐
    │ Feature  │ Stress                      │
    ├──────────┼─────────────────────────────┤
    │ Markdown │ prose/code/table interleave │
    ├──────────┼─────────────────────────────┤
    │ Renderer │ wrapping and spacing        │
    └──────────┴─────────────────────────────┘
    
    - const renderer = oldMarkdown
    + const renderer = experimentalMarkdown
    
    ────────────────────────────────────────────────────────────"
  `)
})

test("top-level structural markdown blocks have exactly one blank row between them", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-structural-spacing",
    content: `Paragraph before quote.

- First bullet
- Second bullet

> Quote text.

1. First step
2. Second step

| A | B |
| --- | --- |
| 1 | 2 |

\`\`\`diff
- old
+ new
\`\`\`

Paragraph after diff.

---

## Next Section`,
    syntaxStyle,
    tableOptions: { style: "grid", widthMode: "content", cellPaddingX: 1 },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    Paragraph before quote.
    
    - First bullet
    - Second bullet
    
    │ Quote text.
    
    1. First step
    2. Second step
    
    ┌───┬───┐
    │ A │ B │
    ├───┼───┤
    │ 1 │ 2 │
    └───┴───┘
    
    - old
    + new
    
    Paragraph after diff.
    
    ────────────────────────────────────────────────────────────
    
    Next Section"
  `)
})

// Blockquote tests

test("simple blockquote", async () => {
  const markdown = `> This is a quote
> spanning multiple lines`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    │ This is a quote
    │ spanning multiple lines"
  `)
})

// A quote shows its blocks, one row apart as at the top level: prose stays prose, a fence is a code block.
test.each([
  ["> a\n>\n> b", "│ a\n│\n│ b"],
  [">", "│"],
  ["> # Title\n> text\n> ```\n> **raw**\n> ```", "│ Title\n│\n│ text\n│\n│ **raw**"],
  ["> - one\n> - two", "│ - one\n│ - two"],
  ["> outer\n>\n> > inner", "│ outer\n│\n│ │ inner"],
  ["> a\n>\n> b\n> ```\n> c\n> ```", "│ a\n│\n│ b\n│\n│ c"],
])("blockquote %j renders its child blocks", async (markdown, expected) => {
  expect(await renderMarkdown(markdown)).toBe("\n" + expected)
})

test("code-block renderers reach fences inside quotes and lists", async () => {
  const seen: string[] = []
  const md = createMarkdownRenderable({
    // The quoted fence names no renderer's language until the first update.
    content:
      "> quoted\n> ```mermai\n> in quote\n> ```\n> ```text\n> as code\n> ```\n\n- item\n\n  ```mermaid\n  in list\n  ```",
    syntaxStyle,
    renderBlock: createMarkdownCodeBlockRenderer({
      mermaid: (block) => {
        seen.push(block.text)
        return new TextRenderable(renderer, { content: `diagram ${block.text}` })
      },
      // A renderer may change the default code block it returns, as at the top level.
      text: (block, context) => {
        const code = context.defaultRender() as CodeRenderable
        code.content = `custom ${block.text}`
        return code
      },
    }),
  })
  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  expect(captureFrame()).toContain("│ custom as code")
  expect(captureFrame()).toContain("diagram in list")

  // A code block becomes the renderer's, and the renderer's result is replaced, as the fence changes. A replace
  // parses again from the first changed block, so the list's fence after it is asked again too.
  for (const [from, to, shown] of [
    ["mermai\n", "mermaid\n", "in quote"],
    ["in quote", "in quote 2", "in quote 2"],
  ]) {
    seen.length = 0
    md.content = md.content.replace(from, to)
    await renderMarkdownRenderable(md)
    expect(captureFrame()).toContain(`│ diagram ${shown}`)
    expect(seen).toEqual([shown, "in list"])
  }
})

test("streamed quote text shows in the quote style before it highlights", async () => {
  const quoteColor = RGBA.fromValues(0.25, 0.5, 0.75, 1)
  const style = SyntaxStyle.fromStyles(
    { default: { fg: RGBA.fromValues(1, 1, 1, 1) }, "markup.quote": { fg: quoteColor, italic: true } },
    renderer.nativeScene,
  )
  const contexts: MarkdownInlineContext[] = []
  // Solid sets props in JSX order, so the content can arrive before the style.
  const inlineHook: MarkdownInlineHook = (spans, context) => (contexts.push(context), spans)
  const options = { treeSitterClient: createMockTreeSitterClient(), inlineHook }
  const md = new MarkdownRenderable(renderer, options as Omit<MarkdownOptions, "syntaxStyle"> as MarkdownOptions)
  md.streaming = true
  md.content = "> quoted *text*"
  md.syntaxStyle = style
  renderer.root.add(md)
  await renderOnce()

  // The hook never sees a document without a style.
  expect(contexts.length).toBeGreaterThan(0)
  expect(contexts.every((context) => context.syntaxStyle === style)).toBe(true)
  const spans = captureSpans()
  expect(captureFrame()).toContain("│ quoted text")
  const span = findSpanContaining(spans, "quoted")
  expect(span?.fg?.toInts()).toEqual(quoteColor.toInts())
  expect((span?.attributes ?? 0) & TextAttributes.ITALIC).toBe(TextAttributes.ITALIC)
})

// Native calls each `content` assignment makes while the stream only grows one bound paragraph.
async function growCalls(): Promise<string[][]> {
  const symbols = (resolveRenderLib() as unknown as { opentui: { symbols: Record<string, (...args: any[]) => any> } })
    .opentui.symbols
  setRendererCapabilities(renderer, { hyperlinks: true })
  const md = createMarkdownRenderable({ content: "Intro.\n\nThe", syntaxStyle, streaming: true })
  renderer.root.add(md)
  await renderOnce()
  const calls: string[][] = []
  const originals = { ...symbols }
  for (const [name, original] of Object.entries(originals)) {
    if (typeof original === "function") symbols[name] = (...args) => (calls.at(-1)?.push(name), original(...args))
  }
  try {
    for (const word of [" renderer", " *writes*", " each", " **delta**", " natively."]) {
      calls.push([])
      md.content += word
    }
  } finally {
    Object.assign(symbols, originals)
  }
  await renderOnce()
  expect(frameText()).toBe("Intro.\n\nThe renderer writes each delta natively.")
  return calls
}

// Gate: JavaScript does no text work when a stream only grows bound prose. The engine lists the grown paragraph (its
// source range moved), so each delta costs the append and a read of that one record.
test("a delta that only grows bound prose costs the append and one record read", async () => {
  expect(await growCalls()).toEqual(Array(5).fill(["ot_markdown_append", "ot_markdown_read_changes"]))
})

// Gate: a delta's work does not grow with the document. Per K = 16..128 blocks before the growing one, counts the UTF-8
// bytes JavaScript encodes, the list gaps it writes and the list markers it reads while 8 deltas grow a fence and the
// last item of a list.
test("a delta's work does not grow with the blocks before it", async () => {
  const encode = TextEncoder.prototype.encode
  const rowGap = Object.getOwnPropertyDescriptor(BoxRenderable.prototype, "rowGap")!
  const chunks = Object.getOwnPropertyDescriptor(TextRenderable.prototype, "chunks")!
  const work: Record<string, number[][]> = {}
  let count = [0, 0, 0]
  TextEncoder.prototype.encode = function (input?: string) {
    const bytes = encode.call(this, input)
    count[0]! += bytes.length
    return bytes
  }
  Object.defineProperty(BoxRenderable.prototype, "rowGap", {
    configurable: true,
    set(value) {
      count[1]!++
      rowGap.set!.call(this, value)
    },
  })
  Object.defineProperty(TextRenderable.prototype, "chunks", {
    configurable: true,
    get() {
      count[2]!++
      return chunks.get!.call(this)
    },
  })
  try {
    for (const k of [16, 32, 64, 128]) {
      const rows = [
        ["fence", "Para.\n\n".repeat(k) + "```ts\n", "x = 1\n"],
        ["list", "- item\n".repeat(k) + "- last", " word"],
        ["loose list", "- item\n\n".repeat(k) + "- last", " word"],
        ["items", "- item\n".repeat(k), "- more\n"],
      ]
      for (const [name, prefix, delta] of rows) {
        const md = createMarkdownRenderable({ content: prefix!, syntaxStyle, streaming: true })
        renderer.root.add(md)
        await renderOnce()
        count = [0, 0, 0]
        for (let i = 0; i < 8; i++) md.content += delta
        ;(work[name!] ??= []).push([...count])
        md.destroyRecursively()
      }
    }
  } finally {
    TextEncoder.prototype.encode = encode
    Object.defineProperty(BoxRenderable.prototype, "rowGap", rowGap)
    Object.defineProperty(TextRenderable.prototype, "chunks", chunks)
  }
  // Equal for every K: the fence's and the growing paragraph's bytes (the host writes it: no hyperlinks; the amount
  // depends on what the highlighter and text buffers encode), and no gap written again except one per new item.
  for (const [name, counts] of Object.entries(work)) expect([name, counts]).toEqual([name, Array(4).fill(counts[0])])
  expect(Object.values(work).map((counts) => counts[0]!.slice(1))).toEqual([
    [0, 0],
    [0, 0],
    [0, 0],
    [8, 16],
  ])
})

test("a list lays out again when a shown item gains a block or a replace rebuilds items", async () => {
  const md = createMarkdownRenderable({ content: "- para 1\n\n", syntaxStyle, streaming: true })
  renderer.root.add(md)
  await renderOnce()
  md.content += "  para 2\n"
  await renderOnce()
  expect(frameText()).toBe("- para 1\n\n  para 2")
  // OpenCode's trim() parses again; the list stays and its second item is built again (model seed 1188).
  md.content = "1. \n1. `run x` "
  await renderOnce()
  md.content = "1. \n1. `run x`"
  await renderOnce()
  expect(frameText()).toBe("1.\n2. run x")
})

// New defect M3-e (engine): the design's fast path is one call (`changed_block_count = 0`), but M1 lists a grown pending
// paragraph so the host's ranges stay current.
test.todo("a delta that only grows bound prose is one native call", async () => {
  expect(await growCalls()).toEqual(Array(5).fill(["ot_markdown_append"]))
})

test("prose that waited for the style shows when the engine takes it over first", async () => {
  // Without hyperlinks the host writes prose, but not before the style arrives; links turning on hands it to the engine.
  const md = new MarkdownRenderable(renderer, { content: "Hello *there*" } as MarkdownOptions)
  renderer.root.add(md)
  await renderOnce()
  renderer.emit("capabilities", setRendererCapabilities(renderer, { hyperlinks: true }))
  md.syntaxStyle = syntaxStyle
  await renderOnce()
  expect(frameText()).toBe("Hello there")
})

test("blockquote uses markup.quote style for text and conceal style for bar", async () => {
  const quoteColor = RGBA.fromValues(0.25, 0.5, 0.75, 1)
  const concealColor = RGBA.fromValues(0.1, 0.2, 0.3, 1)
  const md = createMarkdownRenderable({
    id: "markdown-blockquote-style",
    content: "> Quote text",
    syntaxStyle: SyntaxStyle.fromStyles(
      {
        default: { fg: RGBA.fromValues(1, 1, 1, 1) },
        conceal: { fg: concealColor },
        "markup.quote": { fg: quoteColor, italic: true },
      },
      renderer.nativeScene,
    ),
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const spans = captureSpans()
  expect(findSpanContaining(spans, "│")?.fg?.toInts()).toEqual(concealColor.toInts())

  const textSpan = findSpanContaining(spans, "Quote text")
  expect(textSpan?.fg?.toInts()).toEqual(quoteColor.toInts())
  expect((textSpan?.attributes ?? 0) & TextAttributes.ITALIC).toBe(TextAttributes.ITALIC)
})

// Model seed 2258 of 10,000: a replace moves a quote's paragraph to the top level at the same index, and the text that
// showed it keeps showing it.
test("a paragraph that leaves a quote loses the quote style", async () => {
  const style = SyntaxStyle.fromStyles(
    { default: { fg: RGBA.fromValues(1, 1, 1, 1) }, "markup.quote": { italic: true } },
    renderer.nativeScene,
  )
  const md = createMarkdownRenderable({ content: "> aa\n\nbb\n", syntaxStyle: style, streaming: true })
  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  md.content = "x " + md.content
  await renderMarkdownRenderable(md)
  expect(frameText()).toBe("x > aa\n\nbb")
  expect((findSpanContaining(captureSpans(), "bb")?.attributes ?? 0) & TextAttributes.ITALIC).toBe(0)
  style.destroy()
})

test("blockquote updates quote text and bar colors when syntaxStyle changes", async () => {
  const quoteColor1 = RGBA.fromValues(0.25, 0.5, 0.75, 1)
  const quoteColor2 = RGBA.fromValues(0.75, 0.5, 0.25, 1)
  const concealColor1 = RGBA.fromValues(0.1, 0.2, 0.3, 1)
  const concealColor2 = RGBA.fromValues(0.3, 0.2, 0.1, 1)
  const theme1 = SyntaxStyle.fromStyles(
    {
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
      conceal: { fg: concealColor1 },
      "markup.quote": { fg: quoteColor1, italic: true },
    },
    renderer.nativeScene,
  )
  const theme2 = SyntaxStyle.fromStyles(
    {
      default: { fg: RGBA.fromValues(1, 1, 1, 1) },
      conceal: { fg: concealColor2 },
      "markup.quote": { fg: quoteColor2, italic: true },
    },
    renderer.nativeScene,
  )
  const md = createMarkdownRenderable({
    id: "markdown-blockquote-style-update",
    content: "> Quote text\n\n---",
    syntaxStyle: theme1,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  expect(findSpanContaining(captureSpans(), "│")?.fg?.toInts()).toEqual(concealColor1.toInts())
  expect(findSpanContaining(captureSpans(), "Quote text")?.fg?.toInts()).toEqual(quoteColor1.toInts())
  expect(findSpanContaining(captureSpans(), "─")?.fg?.toInts()).toEqual(concealColor1.toInts())

  md.syntaxStyle = theme2
  renderer.requestRender()
  await renderMarkdownRenderable(md)

  expect(findSpanContaining(captureSpans(), "│")?.fg?.toInts()).toEqual(concealColor2.toInts())
  expect(findSpanContaining(captureSpans(), "Quote text")?.fg?.toInts()).toEqual(quoteColor2.toInts())
  expect(findSpanContaining(captureSpans(), "─")?.fg?.toInts()).toEqual(concealColor2.toInts())
})

for (const [name, options] of [
  ["defaults", {}],
  ["renderBlock", { renderBlock: () => undefined }],
] as const) {
  test(`list items follow fg and syntax style changes with ${name}`, async () => {
    const fg1 = RGBA.fromValues(0.25, 0.5, 0.75, 1)
    const fg2 = RGBA.fromValues(0.75, 0.5, 0.25, 1)
    const theme = (fg: RGBA) =>
      SyntaxStyle.fromStyles({ "markup.raw": { fg }, "markup.list": { fg } }, renderer.nativeScene)
    const md = createMarkdownRenderable({
      id: `markdown-list-style-update-${name}`,
      content:
        "# Intro\n\n---\n\n- item with `code`\n- second item\n  - nested item\n- third\n  > quoted\n- fenced\n  ```ts\n  const a = 1\n  ```\n\n| H |\n| --- |\n| `cell` |\n\n| Only |\n| --- |\n",
      syntaxStyle: theme(fg2),
      fg: fg1,
      streaming: true,
      ...options,
    })
    const spans = [
      ["Intro", fg1, fg2],
      ["─", fg1, fg2],
      ["second item", fg1, fg2],
      ["nested item", fg1, fg2],
      ["code", fg2, fg1],
      ["- ", fg2, fg1],
      ["cell", fg2, fg1],
    ] as const
    const colors = () => spans.map(([text]) => findSpanContaining(captureSpans(), text)?.fg?.toInts())
    const codeBlocks = (node: Renderable): CodeRenderable[] =>
      node instanceof CodeRenderable && node.filetype === "typescript" ? [node] : node.getChildren().flatMap(codeBlocks)

    renderer.root.add(md)
    await renderMarkdownRenderable(md, true)
    expect(colors()).toEqual(spans.map(([, before]) => before.toInts()))
    const frame = captureFrame()

    md.streaming = false
    await renderOnce()
    expect(captureFrame()).toBe(frame)
    expect(codeBlocks(md).map((code) => code.streaming)).not.toContain(true)

    md.fg = fg2
    md.syntaxStyle = theme(fg1)
    await renderOnce()
    expect(captureFrame()).toBe(frame)
    await renderMarkdownRenderable(md)
    expect(colors()).toEqual(spans.map(([, , after]) => after.toInts()))
    expect(captureFrame()).toBe(frame)
  })
}

test("table cells use the markdown fg and follow fg changes", async () => {
  const fg1 = RGBA.fromValues(0.25, 0.5, 0.75, 1)
  const fg2 = RGBA.fromValues(0.75, 0.5, 0.25, 1)
  const md = createMarkdownRenderable({
    id: "markdown-table-fg",
    content: "[ref]: https://example.com\n\nIntro\n\n| Head |\n| --- |\n| Cell [OpenTUI][ref] |\n",
    syntaxStyle: SyntaxStyle.fromStyles({}, renderer.nativeScene),
    fg: fg1,
    streaming: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  expect(md.getChildren().at(-1)).toBeInstanceOf(TextTableRenderable)
  expect(findSpanContaining(captureSpans(), "Head")?.fg?.toInts()).toEqual(fg1.toInts())
  expect(findSpanContaining(captureSpans(), "Cell")?.fg?.toInts()).toEqual(fg1.toInts())

  md.fg = fg2
  renderer.requestRender()
  await renderMarkdownRenderable(md)

  expect(findSpanContaining(captureSpans(), "Head")?.fg?.toInts()).toEqual(fg2.toInts())
  expect(findSpanContaining(captureSpans(), "Cell")?.fg?.toInts()).toEqual(fg2.toInts())
  // A restyle must not re-lex the streaming tail without the earlier link definition.
  expect(captureFrame()).toContain("OpenTUI (https://example.com)")
})

test("fenced diff blocks color added and removed lines", async () => {
  const mockTreeSitterClient = createMockTreeSitterClient()
  mockTreeSitterClient.setMockResult({
    highlights: [
      [0, 5, "diff.minus"],
      [6, 11, "diff.plus"],
    ],
  })

  const md = createMarkdownRenderable({
    id: "markdown-diff-fence",
    content: "```diff\n- old\n+ new\n unchanged\n```",
    treeSitterClient: mockTreeSitterClient,
    syntaxStyle: SyntaxStyle.fromStyles(
      {
        default: { fg: RGBA.fromValues(1, 1, 1, 1) },
        "diff.minus": { fg: RGBA.fromValues(1, 0, 0, 1) },
        "diff.plus": { fg: RGBA.fromValues(0, 1, 0, 1) },
      },
      renderer.nativeScene,
    ),
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const codeBlock = md.getChildren()[0]
  expect(codeBlock).toBeInstanceOf(CodeRenderable)
  expect((codeBlock as CodeRenderable).filetype).toBe("diff")
  expect(mockTreeSitterClient.isHighlighting()).toBe(true)

  mockTreeSitterClient.resolveAllHighlightOnce()
  await waitForHighlight(codeBlock as CodeRenderable)
  await renderOnce()

  expect(findSpanContaining(captureSpans(), "- old")?.fg?.toInts()).toEqual(RGBA.fromValues(1, 0, 0, 1).toInts())
  expect(findSpanContaining(captureSpans(), "+ new")?.fg?.toInts()).toEqual(RGBA.fromValues(0, 1, 0, 1).toInts())
})

// Inline formatting tests

test("bold text", async () => {
  const markdown = `This has **bold** text in it.`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    This has bold text in it."
  `)
})

test("italic text", async () => {
  const markdown = `This has *italic* text in it.`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    This has italic text in it."
  `)
})

test("inline code", async () => {
  const markdown = `Use \`console.log()\` to debug.`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Use console.log() to debug."
  `)
})

test("mixed inline formatting", async () => {
  const markdown = `**Bold**, *italic*, and \`code\` together.`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Bold, italic, and code together."
  `)
})

test("inline formatting with conceal=false", async () => {
  const markdown = `**Bold**, *italic*, and \`code\` together.`

  expect(await renderMarkdown(markdown, false)).toMatchInlineSnapshot(`
    "
    **Bold**, *italic*, and \`code\` together."
  `)
})

// Link tests

for (const hyperlinks of [false, true]) {
  for (const named of [true, false]) {
    test(`${named ? "named" : "bare"} Unicode links after multibyte text preserve hyperlink metadata with hyperlinks=${hyperlinks}`, async () => {
      setRendererCapabilities(renderer, { hyperlinks })
      resizeRenderer(120, 10)
      const prefix = "caf\u00e9 \u4e2d\u6587 \u{1f680} e\u0301 "
      const url = "https://example.com/caf\u00e9"
      const label = named ? "R\u00e9f\u{1f680}" : url
      const md = createMarkdownRenderable({
        id: "markdown-unicode-links",
        content: `${prefix}${named ? `[${label}](${url})` : url} after`,
        syntaxStyle,
      })

      renderer.root.add(md)
      await renderMarkdownRenderable(md)

      const visibleLink = named && !hyperlinks ? `${label} (${url})` : label
      expect(captureFrame()).toContain(`${prefix}${visibleLink} after`)
      const position = findRenderedText(label)
      expect(position.x).toBe(stringWidth(prefix))
      for (let offset = 0; offset < stringWidth(label); offset++) {
        expect(renderer.getLinkAt(position.x + offset, position.y)).toBe(url)
      }
      expect(renderer.getLinkAt(position.x - 1, position.y)).toBeNull()
      expect(renderer.getLinkAt(position.x + stringWidth(visibleLink), position.y)).toBeNull()
    })
  }

  test(`named and bare prose and table links preserve hyperlink metadata with hyperlinks=${hyperlinks}`, async () => {
    setRendererCapabilities(renderer, { hyperlinks })
    resizeRenderer(260, 40)
    const md = createMarkdownRenderable({
      id: "markdown-link-capabilities",
      content:
        "Before [Prose](https://example.com/named-prose) after https://example.com/prose " +
        "and <https://example.com/auto-prose> **https://example.com/bold-prose** " +
        "https://example.com/it's-prose " +
        "[https://example.com/identical-prose](https://example.com/identical-prose)\n\n" +
        "| Named |\n|---|\n| [Table](https://example.com/named-table) |\n\n" +
        "| Link |\n|---|\n| https://example.com/table |\n| <https://example.com/auto-table> |\n" +
        "| https://example.com/it's-table |\n" +
        "| [https://example.com/identical-table](https://example.com/identical-table) |",
      syntaxStyle,
      tableOptions: { widthMode: "content" },
    })

    renderer.root.add(md)
    await renderMarkdownRenderable(md)

    const frame = captureFrame()
    expect(frame).toContain(hyperlinks ? "Before Prose after" : "Before Prose (https://example.com/named-prose) after")
    expect(frame).toContain(hyperlinks ? "│Table│" : "│Table (https://example.com/named-table)│")
    expect(frame).not.toContain("<https://")

    for (const [text, url] of [
      ["Prose", "https://example.com/named-prose"],
      ["Table", "https://example.com/named-table"],
    ] as const) {
      if (hyperlinks) expect(frame).not.toContain(url)
      const position = findRenderedText(text)
      for (let offset = 0; offset < text.length; offset++) {
        expect(renderer.getLinkAt(position.x + offset, position.y)).toBe(url)
      }
    }

    for (const url of [
      "https://example.com/prose",
      "https://example.com/table",
      "https://example.com/auto-prose",
      "https://example.com/auto-table",
      "https://example.com/bold-prose",
      "https://example.com/it's-prose",
      "https://example.com/it's-table",
      "https://example.com/identical-prose",
      "https://example.com/identical-table",
    ]) {
      expect(frame.split(url)).toHaveLength(2)
      const position = findRenderedText(url)
      expect(renderer.getLinkAt(position.x, position.y)).toBe(url)
      expect(renderer.getLinkAt(position.x + url.length - 1, position.y)).toBe(url)
    }
  })

  test(`streaming Markdown links are clickable in the first frame with hyperlinks=${hyperlinks}`, async () => {
    setRendererCapabilities(renderer, { hyperlinks })
    resizeRenderer(160, 10)
    const md = createMarkdownRenderable({
      id: "markdown-streaming-link-preview",
      content: "Read [**OpenTUI**](https://example.com/docs) and https://example.com/bare more",
      syntaxStyle,
      streaming: true,
    })

    renderer.root.add(md)
    await renderOnce()

    const frame = captureFrame()
    expect(frame).toContain(hyperlinks ? "Read OpenTUI and" : "Read OpenTUI (https://example.com/docs) and")
    expect(frame.match(/https:\/\/example\.com\/bare/g)).toHaveLength(1)

    const label = findRenderedText("OpenTUI")
    const bare = findRenderedText("https://example.com/bare")
    expect(renderer.getLinkAt(label.x, label.y)).toBe("https://example.com/docs")
    expect(renderer.getLinkAt(bare.x, bare.y)).toBe("https://example.com/bare")

    renderer.emit("capabilities", setRendererCapabilities(renderer, { hyperlinks: !hyperlinks }))
    await renderOnce()

    expect(captureFrame()).toContain(hyperlinks ? "Read OpenTUI (https://example.com/docs) and" : "Read OpenTUI and")
    const refreshedLabel = findRenderedText("OpenTUI")
    expect(renderer.getLinkAt(refreshedLabel.x, refreshedLabel.y)).toBe("https://example.com/docs")

    // A link that ends the stream's last line waits for the next line (new defect M3-d), so text follows it here.
    md.content = "See [Updated](custom://target) now\n"
    await renderOnce()
    expect(captureFrame()).toContain(hyperlinks ? "See Updated (custom://target) now" : "See Updated now")

    const updated = findRenderedText("Updated")
    expect(renderer.getLinkAt(updated.x, updated.y)).toBe("custom://target")
  })
}

test("one-character and formatted prose and table labels preserve hyperlinks", async () => {
  setRendererCapabilities(renderer, { hyperlinks: true })
  const md = createMarkdownRenderable({
    id: "markdown-formatted-links",
    content:
      "[x](https://example.com/one) and [**bold *nested*** *em* `code`](https://example.com/prose)\n\n" +
      "| Link |\n|---|\n| [y](https://example.com/two) |\n" +
      "| [**strong *inner*** *italic* `cell`](https://example.com/table) |\n" +
      "| [![Logo](https://example.com/image)](https://example.com/outer) |",
    syntaxStyle,
    tableOptions: { widthMode: "content" },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  for (const [text, url] of [
    ["x", "https://example.com/one"],
    ["bold", "https://example.com/prose"],
    ["nested", "https://example.com/prose"],
    ["em", "https://example.com/prose"],
    ["code", "https://example.com/prose"],
    ["y", "https://example.com/two"],
    ["strong", "https://example.com/table"],
    ["inner", "https://example.com/table"],
    ["italic", "https://example.com/table"],
    ["cell", "https://example.com/table"],
  ] as const) {
    const position = findRenderedText(text)
    for (let offset = 0; offset < text.length; offset++) {
      expect(renderer.getLinkAt(position.x + offset, position.y)).toBe(url)
    }
  }

  expect(captureFrame()).not.toContain("https://example.com/")
})

// M3-b, fixed in the engine (#2078): an image inside a link links its alt text to the outer link.
test("an image inside a link keeps the link's URL", async () => {
  setRendererCapabilities(renderer, { hyperlinks: true })
  const md = createMarkdownRenderable({
    content:
      "[![Logo](https://example.com/image)](https://example.com/outer)\n\n| L |\n|---|\n| [![Cell](https://example.com/i)](https://example.com/o) |",
    syntaxStyle,
  })
  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  for (const [text, url] of [
    ["Logo", "https://example.com/outer"],
    ["Cell", "https://example.com/o"],
  ] as const) {
    const position = findRenderedText(text)
    expect(renderer.getLinkAt(position.x, position.y)).toBe(url)
  }
})

// M3-d, fixed in the engine (#2078): while streaming, a link that ends the last complete line draws as a link.
test("a streamed link at the end of a line draws as a link", async () => {
  setRendererCapabilities(renderer, { hyperlinks: true })
  const md = createMarkdownRenderable({
    content: "See [docs](https://example.com/docs)\n",
    syntaxStyle,
    streaming: true,
  })
  renderer.root.add(md)
  await renderOnce()
  expect(frameText()).toBe("See docs")
})

test("compact prose links conceal titled, spaced, angle-bracketed, nested, and escaped destinations", async () => {
  setRendererCapabilities(renderer, { hyperlinks: true })
  const md = createMarkdownRenderable({
    id: "markdown-complex-link-destinations",
    content:
      '[Titled](https://example.com/title "tip")\n\n' +
      "[Angle](<https://example.com/angle>)\n\n" +
      '[Spaced]( https://example.com/spaced "spaced tip")\n\n' +
      '[Spaced angle]( <https://example.com/spaced-angle> "angle tip")\n\n' +
      "[Nested](https://example.com/a_(b))\n\n" +
      "[Escaped](https://example.com/a\\_b\\(c\\))",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  for (const [text, url] of [
    ["Titled", "https://example.com/title"],
    ["Angle", "https://example.com/angle"],
    ["Spaced", "https://example.com/spaced"],
    ["Spaced angle", "https://example.com/spaced-angle"],
    ["Nested", "https://example.com/a_(b)"],
    ["Escaped", "https://example.com/a_b(c)"],
  ] as const) {
    const position = findRenderedText(text)
    expect(renderer.getLinkAt(position.x, position.y)).toBe(url)
  }

  expect(captureFrame()).not.toContain("https://example.com/")
  expect(captureFrame()).not.toContain("tip")
})

for (const [label, ending, supported] of [
  ["maximum ASCII", "a", true],
  ["oversized ASCII", "aa", false],
  ["maximum UTF-8", "\u00e9", true],
  ["oversized UTF-8", "\u00e9a", false],
  ["maximum escaped ASCII", "\\_", true],
  ["maximum custom scheme", "a", true],
] as const) {
  // New defect M3-c (engine): a URL the link pool cannot hold shows only its label, where Core showed " (url)".
  ;(supported ? test : test.todo)(
    `${label} Markdown destinations respect the native link-pool UTF-8 capacity`,
    async () => {
      setRendererCapabilities(renderer, { hyperlinks: true })
      resizeRenderer(560, 12)

      const custom = label === "maximum custom scheme"
      const prefix = custom ? "custom+v1://example.test/" : "https://example.com/"
      const destination = prefix + "a".repeat(511 - prefix.length - (ending.startsWith("\u00e9") ? 1 : 0)) + ending
      const target = destination.replace("\\_", "_")
      const md = createMarkdownRenderable({
        id: "markdown-link-native-capacity",
        content: `[Prose](${destination})\n\n| Link |\n|---|\n| [Table](${destination}) |`,
        syntaxStyle,
        tableOptions: { widthMode: "content" },
      })

      renderer.root.add(md)
      await renderMarkdownRenderable(md)

      const frame = captureFrame()
      const prose = findRenderedText("Prose")
      const table = findRenderedText("Table")
      expect(new TextEncoder().encode(target)).toHaveLength(supported ? 512 : 513)
      if (ending === "\\_") expect(new TextEncoder().encode(destination)).toHaveLength(513)
      if (custom) expect(md.content).not.toContain("http")
      if (supported) {
        expect(frame).not.toContain(target)
        expect(renderer.getLinkAt(prose.x, prose.y)).toBe(target)
        expect(renderer.getLinkAt(table.x, table.y)).toBe(target)
      } else {
        expect(frame).toContain(`Prose (${destination})`)
        expect(frame).toContain(`Table (${destination})`)
        expect(renderer.getLinkAt(prose.x, prose.y)).toBeNull()
        expect(renderer.getLinkAt(table.x, table.y)).toBeNull()
      }
    },
  )
}

test("bare URLs inside inline and fenced code are not hyperlinks", async () => {
  setRendererCapabilities(renderer, { hyperlinks: true })
  const md = createMarkdownRenderable({
    id: "markdown-code-links",
    content:
      "Inline `https://example.com/inline`\n\n```text\nhttps://example.com/fenced\n```\n\n" +
      "| Link |\n|---|\n| `https://example.com/cell` |",
    syntaxStyle,
    tableOptions: { widthMode: "content" },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  for (const url of ["https://example.com/inline", "https://example.com/fenced", "https://example.com/cell"]) {
    const position = findRenderedText(url)
    expect(renderer.getLinkAt(position.x, position.y)).toBeNull()
  }
})

test("wrapped markdown link labels preserve hyperlink metadata on every row", async () => {
  setRendererCapabilities(renderer, { hyperlinks: true })
  resizeRenderer(18, 20)
  const md = createMarkdownRenderable({
    id: "markdown-wrapped-link",
    content: "Visit [first second third](https://example.com/wrapped)",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  for (const text of ["first", "second", "third"]) {
    const position = findRenderedText(text)
    expect(renderer.getLinkAt(position.x, position.y)).toBe("https://example.com/wrapped")
  }

  expect(captureFrame()).not.toContain("https://")
})

for (const wrapped of [false, true]) {
  test(`hyperlink capability changes refresh existing${wrapped ? " wrapped" : ""} prose and table renderables`, async () => {
    setRendererCapabilities(renderer, { hyperlinks: false })
    const md = createMarkdownRenderable({
      id: "markdown-capability-transition",
      content: "[Prose](https://example.com/prose)\n\n| Link |\n|---|\n| [Table](https://example.com/table) |",
      syntaxStyle,
      tableOptions: { widthMode: "content" },
      renderBlock: wrapped
        ? (_block, context) => {
            const child = context.defaultRender()
            if (!child) return undefined
            const wrapper = new BoxRenderable(renderer, { width: "100%", flexDirection: "column" })
            wrapper.add(child)
            return wrapper
          }
        : undefined,
    })

    renderer.root.add(md)
    await renderMarkdownRenderable(md)

    const prose = md.getChildren()[0]
    const table = md.getChildren()[1]
    expect(captureFrame()).toContain("Prose (https://example.com/prose)")
    expect(captureFrame()).toContain("Table (https://example.com/table)")

    const recorder = new TestRecorder(renderer)
    recorder.rec()
    renderer.emit("capabilities", setRendererCapabilities(renderer, { hyperlinks: true }))
    await renderMarkdownRenderable(md)
    recorder.stop()

    expect(md.getChildren()[0]).toBe(prose)
    expect(md.getChildren()[1]).toBe(table)
    expect(captureFrame()).toContain("Prose")
    expect(captureFrame()).toContain("Table")
    expect(captureFrame()).not.toContain("https://example.com/")
    for (const recorded of recorder.recordedFrames) {
      expect(recorded.frame).toContain("Prose")
      expect(recorded.frame).toContain("Table")
    }

    renderer.emit("capabilities", setRendererCapabilities(renderer, { hyperlinks: false }))
    await renderMarkdownRenderable(md)

    expect(md.getChildren()[0]).toBe(prose)
    expect(md.getChildren()[1]).toBe(table)
    expect(captureFrame()).toContain("Prose (https://example.com/prose)")
    expect(captureFrame()).toContain("Table (https://example.com/table)")
  })
}

test("hyperlink capability changes preserve custom table content", async () => {
  setRendererCapabilities(renderer, { hyperlinks: false })
  const md = createMarkdownRenderable({
    id: "markdown-capability-custom-table",
    content: "| Link |\n|---|\n| [Markdown](https://example.com/markdown) |",
    syntaxStyle,
    renderBlock: (block) =>
      block.kind === "table"
        ? new TextTableRenderable(renderer, {
            content: [[[{ __isChunk: true, text: "Application-owned content", attributes: 0 }]]],
            columnWidthMode: "content",
          })
        : undefined,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const table = md.getChildren()[0] as TextTableRenderable
  const content = table.content
  expect(captureFrame()).toContain("Application-owned content")

  for (const hyperlinks of [true, false]) {
    renderer.emit("capabilities", setRendererCapabilities(renderer, { hyperlinks }))
    await renderMarkdownRenderable(md)

    expect(md.getChildren()[0]).toBe(table)
    expect(table.content).toBe(content)
    expect(captureFrame()).toContain("Application-owned content")
    expect(captureFrame()).not.toContain("Markdown")
  }
})

for (const [container, wrapped] of [
  ["list", false],
  ["list", true],
  ["quote", false],
] as const) {
  test(`hyperlink capability changes refresh nested prose and tables in ${wrapped ? "wrapped " : ""}top-level ${container}s`, async () => {
    setRendererCapabilities(renderer, { hyperlinks: false })
    const prefix = container === "list" ? ["- ", "  "] : ["> ", "> "]
    const md = createMarkdownRenderable({
      id: "markdown-capability-nested-table",
      content: [
        "[Before](https://example.com/prose)",
        "",
        "| Link |",
        "|---|",
        "| [Nested](https://example.com/nested) |",
      ]
        .map((line, index) => (index === 0 ? prefix[0] : line ? prefix[1] : prefix[1].trimEnd()) + line)
        .join("\n"),
      syntaxStyle,
      tableOptions: { widthMode: "content" },
      renderBlock: wrapped
        ? (block, context) => {
            if (block.kind !== "list") return undefined
            const wrapper = new BoxRenderable(renderer, { width: "100%", flexDirection: "column" })
            wrapper.add(context.defaultRender()!)
            return wrapper
          }
        : undefined,
    })

    renderer.root.add(md)
    await renderMarkdownRenderable(md)

    const block = md.getChildren()[0]
    const list = wrapped ? block.getChildren()[0]! : block
    const content = container === "list" ? list.getChildren()[0]!.getChildren()[1]! : list
    const prose = content.getChildren()[0]!
    const table = content.getChildren()[1]!
    expect(prose).toBeInstanceOf(TextRenderable)
    expect(table).toBeInstanceOf(TextTableRenderable)
    expect(captureFrame()).toContain("Before (https://example.com/prose)")
    expect(captureFrame()).toContain("Nested (https://example.com/nested)")

    renderer.emit("capabilities", setRendererCapabilities(renderer, { hyperlinks: true }))
    await renderMarkdownRenderable(md)

    expect(md.getChildren()[0]).toBe(block)
    expect(wrapped ? block.getChildren()[0] : block).toBe(list)
    if (container === "list") expect(list.getChildren()[0]!.getChildren()[1]).toBe(content)
    expect(content.getChildren()[0]).toBe(prose)
    expect(content.getChildren()[1]).toBe(table)
    expect(captureFrame()).not.toContain("https://example.com/")
    for (const [text, url] of [
      ["Before", "https://example.com/prose"],
      ["Nested", "https://example.com/nested"],
    ] as const) {
      const compact = findRenderedText(text)
      expect(renderer.getLinkAt(compact.x, compact.y)).toBe(url)
    }

    renderer.emit("capabilities", setRendererCapabilities(renderer, { hyperlinks: false }))
    await renderMarkdownRenderable(md)

    expect(md.getChildren()[0]).toBe(block)
    expect(wrapped ? block.getChildren()[0] : block).toBe(list)
    if (container === "list") expect(list.getChildren()[0]!.getChildren()[1]).toBe(content)
    expect(content.getChildren()[0]).toBe(prose)
    expect(content.getChildren()[1]).toBe(table)
    expect(captureFrame()).toContain("Before (https://example.com/prose)")
    expect(captureFrame()).toContain("Nested (https://example.com/nested)")
  })
}

test("multiple markdown renderables share and clean up one renderer capability listener", () => {
  const listenersBefore = renderer.listenerCount("capabilities")
  const renderables = Array.from({ length: 12 }, (_, index) =>
    createMarkdownRenderable({
      id: `markdown-shared-capability-listener-${index}`,
      syntaxStyle,
    }),
  )

  expect(renderer.listenerCount("capabilities")).toBe(listenersBefore + 1)
  for (const renderable of renderables) renderable.destroyRecursively()
  expect(renderer.listenerCount("capabilities")).toBe(listenersBefore)
})

// The Rust crate's tests/markdown.rs renders the same rows: the first paint after each streamed chunk, and after the
// last chunk the settled frame once streaming has ended.
type CorpusRow = [name: string, chunks: string[], html: string, fails: string[], text?: string[]]
test("corpus text: frames match each row unless the row lists them", async () => {
  // Every listed check exists, and a frame check names one of the row's frames.
  const check = /^(engine-(?:html|stream)|(core|rust|engine|ts)-text:([1-9]\d*))$/
  const rows = corpus.rows as unknown as CorpusRow[]
  const unknown = rows.flatMap(([name, , , fails, text]) =>
    fails
      .filter((fail) => !check.test(fail) || Number(fail.match(check)![3] ?? 0) > (text?.length ?? 0))
      .map(() => name),
  )
  expect(unknown).toEqual([])
  const wrong: string[] = []
  for (const [name, chunks, , fails, text] of rows.filter((row) => row[4])) {
    const md = createMarkdownRenderable({
      syntaxStyle,
      streaming: chunks.length > 1,
      tableOptions: { widthMode: "content" },
    })
    renderer.root.add(md)
    for (const [index, chunk] of chunks.entries()) {
      md.content += chunk
      if (index === chunks.length - 1) {
        md.streaming = false
        await renderMarkdownRenderable(md, true)
      } else await renderOnce()
      const frame = captureFrame()
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd()
      const check = `core-text:${index + 1}`
      if ((frame === text![index]) === fails.includes(check)) wrong.push(`${name}|${check}`)
    }
    md.destroyRecursively()
    // OpenCode's reasoning still shows Markdown through Tree-sitter (N10): its drift from each frame is listed.
    const reasoning = new CodeRenderable(renderer, {
      filetype: "markdown",
      drawUnstyledText: false,
      streaming: true,
      conceal: true,
      syntaxStyle,
      treeSitterClient: markdownTreeSitterClient,
      width: "100%",
    })
    renderer.root.add(reasoning)
    for (const [index, chunk] of chunks.entries()) {
      reasoning.content += chunk
      await renderOnce()
      await waitForHighlight(reasoning)
      await renderOnce()
      const frame = captureFrame()
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd()
      const check = `ts-text:${index + 1}`
      if ((frame === text![index]) === fails.includes(check)) wrong.push(`${name}|${check}`)
    }
    reasoning.destroyRecursively()
  }
  expect(wrong).toEqual([])
})

test("links with conceal mode", async () => {
  const markdown = `Check out [OpenTUI](https://github.com/sst/opentui) for more.`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Check out OpenTUI (https://github.com/sst/opentui) for more."
  `)
})

test("links with conceal=false", async () => {
  const markdown = `Check out [OpenTUI](https://github.com/sst/opentui) for more.`

  expect(await renderMarkdown(markdown, false)).toMatchInlineSnapshot(`
    "
    Check out [OpenTUI](https://github.com/sst/opentui) for
    more."
  `)
})

// Horizontal rule

test("horizontal rule", async () => {
  const markdown = `Before

---

After`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Before

    ────────────────────────────────────────────────────────────

    After"
  `)
})

test("horizontal rule has one blank row before and after", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-hr-heading-spacing",
    content: "Before\n\n---\n\n## After",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    Before
    
    ────────────────────────────────────────────────────────────
    
    After"
  `)
})

// Complex document

test("complex markdown document", async () => {
  const markdown = `# Project Title

Welcome to **OpenTUI**, a terminal UI library.

## Features

- Automatic table alignment
- \`inline code\` support
- *Italic* and **bold** text

## Code Example

\`\`\`typescript
const md = new MarkdownRenderable(ctx, {
  content: "# Hello",
})
\`\`\`

## Links

Visit [GitHub](https://github.com) for more.

---

*Press \`?\` for help*`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Project Title

    Welcome to OpenTUI, a terminal UI library.

    Features

    - Automatic table alignment
    - inline code support
    - Italic and bold text

    Code Example

    const md = new MarkdownRenderable(ctx, {
      content: "# Hello",
    })

    Links

    Visit GitHub (https://github.com) for more.

    ────────────────────────────────────────────────────────────

    Press ? for help"
  `)
})

// Custom renderBlock tests

test("custom renderBlock can override heading rendering", async () => {
  const { TextRenderable } = await import("../Text.js")
  const { StyledText } = await import("../../lib/styled-text.js")

  // Helper to extract text from marked tokens
  const extractText = (node: any): string => {
    if (node.kind === "text") return node.text
    if (node.tokens) return node.tokens.map(extractText).join("")
    return ""
  }

  const md = createMarkdownRenderable({
    id: "custom-heading",
    content: `# Custom Heading

Regular paragraph.`,
    syntaxStyle,
    renderBlock: (node, ctx) => {
      if (node.kind === "heading") {
        const text = node.text
        return new TextRenderable(renderer, {
          id: "custom",
          content: new StyledText([{ __isChunk: true, text: `[CUSTOM] ${text}`, attributes: 0 }]),
          width: "100%",
        })
      }
      return ctx.defaultRender()
    },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    [CUSTOM] Custom Heading

    Regular paragraph."
  `)
})

test("custom renderBlock can override code block rendering", async () => {
  const { BoxRenderable } = await import("../Box.js")
  const { TextRenderable } = await import("../Text.js")

  const md = createMarkdownRenderable({
    id: "custom-code",
    content: `\`\`\`js
const x = 1;
\`\`\``,
    syntaxStyle,
    renderBlock: (node, ctx) => {
      if (node.kind === "code") {
        const box = new BoxRenderable(renderer, {
          id: "code-box",
          border: true,
          borderStyle: "single",
        })
        box.add(
          new TextRenderable(renderer, {
            id: "code-text",
            content: `CODE: ${(node as any).text}`,
          }),
        )
        return box
      }
      return ctx.defaultRender()
    },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    ┌──────────────────────────────────────────────────────────┐
    │CODE: const x = 1;                                        │
    └──────────────────────────────────────────────────────────┘"
  `)
})

test("custom code block renderable updates when fenced content changes", async () => {
  const md = createMarkdownRenderable({
    id: "custom-code-update",
    content: "```widget\nfirst\n```",
    syntaxStyle,
    renderBlock: (node, ctx) => {
      if (node.kind !== "code" || node.lang !== "widget") return ctx.defaultRender()

      return new TextRenderable(renderer, {
        id: "custom-widget",
        content: `WIDGET: ${node.text}`,
        width: "100%",
      })
    },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  expect(captureFrame()).toContain("WIDGET: first")

  md.content = "```widget\nsecond\n```"
  await renderMarkdownRenderable(md)

  const frame = captureFrame()
  expect(frame).toContain("WIDGET: second")
  expect(frame).not.toContain("WIDGET: first")
})

test("createMarkdownCodeBlockRenderer dispatches fenced code by language", async () => {
  const md = createMarkdownRenderable({
    id: "language-code-renderer",
    content: `Before


\`\`\`taskflow title=Deploy
step test done
step preview active
\`\`\`

\`\`\`tsx
<Button />
\`\`\`

After`,
    syntaxStyle,
    renderBlock: createMarkdownCodeBlockRenderer({
      taskflow: (node) =>
        new TextRenderable(renderer, {
          id: "taskflow-renderer",
          content: `TASKFLOW:\n${node.text.replaceAll("step ", "- ")}`,
          width: "100%",
        }),
      typescriptreact: (node) =>
        new TextRenderable(renderer, {
          id: "tsx-renderer",
          content: `TSX: ${node.text}`,
          width: "100%",
        }),
    }),
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const frame = captureFrame()
  expect(frame).toContain("Before")
  expect(frame).toContain("TASKFLOW:")
  expect(frame).toContain("- test done")
  expect(frame).toContain("- preview active")
  expect(frame).toContain("TSX: <Button />")
  expect(frame).toContain("After")
})

test("createMarkdownCodeBlockRenderer accepts renderer maps", async () => {
  const md = createMarkdownRenderable({
    id: "language-code-renderer-map",
    content: "```widget\nfrom map\n```",
    syntaxStyle,
    renderBlock: createMarkdownCodeBlockRenderer(
      new Map([
        [
          "widget",
          (node) =>
            new TextRenderable(renderer, {
              id: "widget-map-renderer",
              content: `MAP: ${node.text}`,
              width: "100%",
            }),
        ],
      ]),
    ),
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  expect(captureFrame()).toContain("MAP: from map")
})

test("code block renderer keeps prose spacing", async () => {
  const md = createMarkdownRenderable({
    id: "language-code-renderer-coalesced-prose",
    content: `First paragraph.

Second paragraph.

\`\`\`widget
custom
\`\`\`

Third paragraph.`,
    syntaxStyle,
    renderBlock: createMarkdownCodeBlockRenderer({
      widget: (node) => new TextRenderable(renderer, { content: `WIDGET: ${node.text}`, width: "100%" }),
    }),
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  expect(topKinds(md)).toEqual(["paragraph", "paragraph", "code", "paragraph"])

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    First paragraph.

    Second paragraph.

    WIDGET: custom

    Third paragraph."
  `)
})

test("default code blocks reuse their renderable when a custom renderer ignores them", async () => {
  const md = createMarkdownRenderable({
    id: "default-code-update-with-custom-renderer",
    content: "```ts\nconst first = true\n```",
    syntaxStyle,
    renderBlock: (node) => {
      if (node.kind !== "code" || node.lang !== "widget") return null
      return new TextRenderable(renderer, { content: `WIDGET: ${node.text}` })
    },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  const initial = md.getChildren()[0]

  md.content = "```ts\nconst second = true\n```"
  await renderMarkdownRenderable(md)

  expect(md.getChildren()[0]).toBe(initial)
  expect(captureFrame()).toContain("const second = true")
})

test("default-render delegation reuses renderable on same-type updates", async () => {
  const md = createMarkdownRenderable({
    id: "default-render-delegation-update",
    content: "```ts\nconst first = true\n```",
    syntaxStyle,
    renderBlock: (_node, ctx) => ctx.defaultRender(),
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  const initial = md.getChildren()[0]

  md.content = "```ts\nconst second = true\n```"
  await renderMarkdownRenderable(md)

  expect(md.getChildren()[0]).toBe(initial)
  expect(captureFrame()).toContain("const second = true")
})

// A renderer may ask for the default and still show something else, or switch between its own result, a wrapper and
// the default; the default it falls back to always shows its block (bigboi-1).
test("a renderer's switches between its own result, a wrapper and the default keep the block shown", async () => {
  // As OpenCode's LaTeX renderer: it asks for the default first, and shows it while the formula does not parse.
  const latex = createMarkdownRenderable({
    content: "```math\nx",
    syntaxStyle,
    streaming: true,
    renderBlock: (block, context) => {
      const fallback = context.defaultRender()
      const parses = block.text.includes("ok") && !block.text.includes("bad")
      return parses ? new TextRenderable(renderer, { content: "FORMULA" }) : fallback
    },
  })
  renderer.root.add(latex)
  const frames: string[] = []
  for (const more of ["", " ok\n", "bad\n```\n"]) {
    latex.content += more
    // A streamed fence shows once its highlight lands.
    await renderMarkdownRenderable(latex, true)
    frames.push(frameText())
  }
  latex.streaming = false
  await renderMarkdownRenderable(latex, true)
  expect([...frames, frameText()]).toEqual(["x", "FORMULA", "x ok\nbad", "x ok\nbad"])
  latex.destroyRecursively()

  // A wrapper around the default, then the default alone (on a style swap).
  let wrap = true
  const wrapped = createMarkdownRenderable({
    content: "plain",
    syntaxStyle,
    renderBlock: (_block, context) => {
      if (!wrap) return context.defaultRender()
      const box = new BoxRenderable(renderer, { flexDirection: "column" })
      box.add(context.defaultRender()!)
      return box
    },
  })
  renderer.root.add(wrapped)
  await renderMarkdownRenderable(wrapped)
  wrap = false
  wrapped.syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } }, renderer.nativeScene!)
  await renderMarkdownRenderable(wrapped)
  expect(frameText()).toBe("plain")
  // And back: the shown default moves into a new wrapper (bigboi-r2-1).
  wrap = true
  wrapped.refreshStyles()
  await renderMarkdownRenderable(wrapped)
  expect(frameText()).toBe("plain")
  const shownDefault = wrapped.blocks[0]!.renderable!.getChildren()[0]!
  wrapped.destroyRecursively()
  expect(shownDefault.isDestroyed).toBe(true)

  // A renderer that asks for the shown default but returns its own text: the default goes with the Markdown.
  let own = false
  const replaced = createMarkdownRenderable({
    content: "plain",
    syntaxStyle,
    renderBlock: (_block, context) => {
      const fallback = context.defaultRender()
      return own ? new TextRenderable(renderer, { content: "CUSTOM" }) : fallback
    },
  })
  renderer.root.add(replaced)
  await renderMarkdownRenderable(replaced)
  const first = replaced.blocks[0]!.renderable!
  own = true
  replaced.refreshStyles()
  await renderMarkdownRenderable(replaced)
  expect(frameText()).toBe("CUSTOM")
  replaced.destroyRecursively()
  expect(first.isDestroyed).toBe(true)

  // A quote shown by the renderer alone, then by the default, which shows its children.
  let custom = true
  const quote = createMarkdownRenderable({
    content: "> aa\n> bb",
    syntaxStyle,
    renderBlock: (block) =>
      custom && block.kind === "quote" ? new TextRenderable(renderer, { content: "CUSTOM" }) : null,
  })
  renderer.root.add(quote)
  await renderMarkdownRenderable(quote)
  expect(frameText()).toBe("CUSTOM")
  custom = false
  quote.syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } }, renderer.nativeScene!)
  await renderMarkdownRenderable(quote)
  expect(frameText()).toBe("│ aa\n│ bb")
})

test("a default code block becomes custom once its updated content is handled", async () => {
  const md = createMarkdownRenderable({
    id: "default-to-custom-code-update",
    content: "```widget\nincomplete\n```",
    syntaxStyle,
    renderBlock: (node) => {
      if (node.kind !== "code" || node.lang !== "widget" || !node.text.includes("ready")) return null
      return new TextRenderable(renderer, { content: `WIDGET: ${node.text}` })
    },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  expect(captureFrame()).toContain("incomplete")

  md.content = "```widget\nready\n```"
  await renderMarkdownRenderable(md)

  expect(captureFrame()).toContain("WIDGET: ready")
})

test("a top-level default code block becomes custom once updated content is handled", async () => {
  const md = createMarkdownRenderable({
    id: "top-level-default-to-custom-code-update",
    content: "```widget\nincomplete\n```",
    syntaxStyle,
    renderBlock: (node) => {
      if (node.kind !== "code" || node.lang !== "widget" || !node.text.includes("ready")) return null
      return new TextRenderable(renderer, { content: `WIDGET: ${node.text}` })
    },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  expect(captureFrame()).toContain("incomplete")

  md.content = "```widget\nready\n```"
  await renderMarkdownRenderable(md)

  expect(captureFrame()).toContain("WIDGET: ready")
})

test("custom renderBlock output survives top-level spacing updates", async () => {
  const md = createMarkdownRenderable({
    id: "custom-spacing-update",
    content: "Paragraph\n# Heading",
    syntaxStyle,
    renderBlock: (node, ctx) => {
      if (node.kind === "heading") {
        return new TextRenderable(renderer, {
          id: "custom-text-spacing",
          content: "CUSTOM",
          width: "100%",
        })
      }

      return ctx.defaultRender()
    },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  md.content = "Paragraph\n\n# Heading"
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())

  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    Paragraph

    CUSTOM"
  `)
})

test("renderBlock setter updates existing markdown renderable", async () => {
  const md = createMarkdownRenderable({
    id: "render-node-setter",
    content: "# Heading",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  md.renderBlock = (node, ctx) => {
    if (node.kind !== "heading") return ctx.defaultRender()
    return new TextRenderable(renderer, {
      content: "CUSTOM",
      width: "100%",
    })
  }
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    CUSTOM"
  `)
})

test("renderBlock setter rerenders same-type top-level blocks", async () => {
  const md = createMarkdownRenderable({
    id: "render-node-setter-top-level",
    content: "# Heading",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  md.renderBlock = (node, ctx) => {
    if (node.kind !== "heading") return ctx.defaultRender()
    return new TextRenderable(renderer, {
      content: "CUSTOM",
      width: "100%",
    })
  }
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    CUSTOM"
  `)
})

{
  test("style changes call renderBlock again for custom blocks before layout", async () => {
    let label = "old"
    const rendered: string[] = []
    const md = createMarkdownRenderable({
      content: "# Heading\n\n> quote\n\n---\n\nbody",
      syntaxStyle,
      streaming: true,
      renderBlock: (token, context) => {
        rendered.push(token.kind)
        if (token.kind === "heading") return new TextRenderable(renderer, { content: label, width: 3, height: 1 })
        if (token.kind === "quote" || token.kind === "rule") {
          return new BoxRenderable(renderer, { height: 3, border: true, borderColor: "#ff0000" })
        }
        return context.defaultRender()
      },
    })
    const shape = () =>
      md
        .getChildren()
        .map((child) => child.constructor.name + (child instanceof BoxRenderable ? child.borderColor : ""))
    renderer.root.add(md)
    await renderOnce()
    const expected = shape()
    expect(expected).toEqual([
      "TextRenderable",
      "BoxRenderable" + RGBA.fromHex("#ff0000"),
      "BoxRenderable" + RGBA.fromHex("#ff0000"),
      "TextRenderable",
    ])
    rendered.length = 0
    md.content += " more"
    await renderOnce()
    expect(rendered).toEqual(["paragraph"])
    const body = md.getChildren()[3]
    const order: string[] = []
    const add = md.add.bind(md)
    md.add = (child, index) => {
      order.push("add")
      return add(child, index)
    }
    md.renderBefore = () => order.push("before")

    for (const [deferred, change] of [
      [
        true,
        () => {
          md.syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromHex("#00ff00") } }, renderer.nativeScene)
          md.fg = "#0000ff"
        },
      ],
      [true, () => (md.conceal = false)],
      [false, () => md.refreshStyles()],
      [false, () => (md.streaming = false)],
    ] as const) {
      const heading = md.getChildren()[0]
      label = label === "old" ? "new" : "old"
      rendered.length = 0
      order.length = 0
      change()
      expect(heading.isDestroyed).toBe(!deferred)
      await renderOnce()

      // Once each; the end of a stream renders the block it changes first.
      expect(rendered.sort()).toEqual(["heading", "paragraph", "quote", "rule"])
      expect(order.slice(0, 4)).toEqual(["add", "add", "add", "before"])
      expect(shape()).toEqual(expected)
      expect(heading.isDestroyed).toBe(true)
      expect(md.getChildren()[3]).toBe(body)
      expect(captureFrame().split("\n")[0].trimEnd()).toBe(label)
    }
  })
}

test("custom top-level renderBlock can increase default block margins", async () => {
  const md = createMarkdownRenderable({
    id: "custom-top-level-margin",
    content: "Paragraph\n\n# Heading",
    syntaxStyle,
    renderBlock: (node, ctx) => {
      const renderable = ctx.defaultRender()
      if (node.kind === "heading" && renderable) renderable.marginTop = 2
      return renderable
    },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  expect(md.getChildren()[1]!.marginTop).toBe(2)
  md.fg = "#123456"
  await renderMarkdownRenderable(md)
  expect(md.getChildren()[1]!.marginTop).toBe(2)
})

test("custom renderBlock returning null uses default", async () => {
  const md = createMarkdownRenderable({
    id: "custom-null",
    content: `# Heading

Paragraph text.`,
    syntaxStyle,
    renderBlock: () => null,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    Heading

    Paragraph text."
  `)
})

for (const [name, options] of [
  ["defaults", {}],
  ["renderBlock", { renderBlock: (_block, context) => context.defaultRender() }],
] satisfies [string, Partial<MarkdownOptions>][]) {
  test(`non-streaming edit that extends the last block draws like fresh content with ${name}`, async () => {
    for (const [before, after] of [
      ["> one", "> one\n> two"],
      ["Paragraph\n\n# Heading", "Paragraph\n\n# Heading 2"],
    ]) {
      const fresh = createMarkdownRenderable({ content: after, syntaxStyle, ...options })
      renderer.root.add(fresh)
      await renderMarkdownRenderable(fresh)
      const expected = captureFrame()
      fresh.destroy()

      const md = createMarkdownRenderable({ content: before, syntaxStyle, ...options })
      renderer.root.add(md)
      await renderMarkdownRenderable(md)
      md.content = after
      await renderMarkdownRenderable(md)
      expect(captureFrame()).toBe(expected)
      md.destroy()
    }
  })
}

// Incomplete/invalid markdown tests

test("incomplete code block (no closing fence)", async () => {
  const markdown = `Here is some code:

\`\`\`javascript
const x = 1;
console.log(x);`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Here is some code:

    const x = 1;
    console.log(x);"
  `)
})

test("incomplete bold (no closing **)", async () => {
  const markdown = `This has **unclosed bold text`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    This has **unclosed bold text"
  `)
})

test("incomplete italic (no closing *)", async () => {
  const markdown = `This has *unclosed italic text`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    This has *unclosed italic text"
  `)
})

test("incomplete link (no closing paren)", async () => {
  const markdown = `Check out [this link](https://example.com`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Check out [this link](https://example.com"
  `)
})

test("incomplete table (only header)", async () => {
  const markdown = `| Header1 | Header2 |`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    | Header1 | Header2 |"
  `)
})

test("incomplete table (header + delimiter, no rows)", async () => {
  const markdown = `| Header1 | Header2 |
|---|---|`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌───────┬───────┐
    │Header1│Header2│
    └───────┴───────┘"
  `)
})

test("streaming-like content with partial code block", async () => {
  const markdown = `# Title

Some text before code.

\`\`\`py`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Title

    Some text before code."
  `)
})

test("malformed table with missing pipes", async () => {
  const markdown = `| A | B
|---|---
| 1 | 2`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌─┬─┐
    │A│B│
    ├─┼─┤
    │1│2│
    └─┴─┘"
  `)
})

test("trailing blank lines do not add spacing", async () => {
  const markdown = `# Heading

Paragraph text.


`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Heading

    Paragraph text."
  `)
})

test("multiple trailing blank lines do not add spacing", async () => {
  const markdown = `First paragraph.

Second paragraph.



`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    First paragraph.

    Second paragraph."
  `)
})

test("blank lines between blocks add spacing", async () => {
  const markdown = `First

Second

Third`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    First

    Second

    Third"
  `)
})

test("code block at end with trailing blank lines", async () => {
  const markdown = `Text before

\`\`\`js
const x = 1;
\`\`\`

`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    Text before

    const x = 1;"
  `)
})

test("table at end with trailing blank lines", async () => {
  const markdown = `| A | B |
|---|---|
| 1 | 2 |


`

  expect(await renderMarkdown(markdown)).toMatchInlineSnapshot(`
    "
    ┌─┬─┐
    │A│B│
    ├─┼─┤
    │1│2│
    └─┴─┘"
  `)
})

// Incremental parsing tests

test("preserves top-level block boundaries", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-blocks",
    content: "# Title\n\n```ts\nconst x = 1\n```\n\n| A |\n|---|\n| 1 |",
    syntaxStyle,
    streaming: false,
    tableOptions: { widthMode: "content" },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  expect(topKinds(md)).toEqual(["heading", "code", "table"])
  expect(md.getChildren()[1]).toBeInstanceOf(CodeRenderable)
  expect(md.getChildren()[2]).toBeInstanceOf(TextTableRenderable)
  expect(md.committedBlockCount).toBe(3)
})

test("reuses table renderable when rows stream in", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-table-reuse",
    content: "Intro\n\n| A | B |\n|---|---|",
    syntaxStyle,
    streaming: true,
    tableOptions: { style: "columns", widthMode: "content" },
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  md.content += "\n| 1 | 2 |"
  await renderMarkdownRenderable(md)

  const table = md.getChildren()[1]
  expect(table).toBeInstanceOf(TextTableRenderable)
  expect(findRenderedText("A").y).toBe(2)

  md.content += "\n| 3 | 4 |"
  await renderMarkdownRenderable(md)

  expect(md.getChildren()[1]).toBe(table)
})

test("updates code renderable filetype when fence changes to diff", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-code-kind-change",
    content: "```ts\nconst x = 1\n```",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const first = md.getChildren()[0]
  expect(first).toBeInstanceOf(CodeRenderable)

  md.content = "```diff\n- const x = 1\n+ const y = 2\n```"
  await renderMarkdownRenderable(md)

  expect(md.getChildren()[0]).toBe(first)
  expect((md.getChildren()[0] as CodeRenderable).filetype).toBe("diff")
})

test("preserves child order when replacing an earlier block", () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-replacement-order",
    content: "# A\n\n```ts\nconst a = 1\n```\n\nTail A",
    syntaxStyle,
  })

  renderer.root.add(md)
  const codeBlock = md.getChildren()[1]

  md.content = "Intro B\n\n```ts\nconst b = 2\n```\n\nTail B"

  expect(topKinds(md)).toEqual(["paragraph", "code", "paragraph"])
  expect(md.getChildren()[1]).toBe(codeBlock)
  // Ids are the blocks' preorder indices, as latex and merman key their last output on them.
  expect(md.getChildren().map((child) => child.id)).toEqual([0, 1, 2].map((index) => `${md.id}-block-${index}`))
})

test("normalizes one blank row between top-level blocks", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-spacing",
    content: "# Title\n\nParagraph\n\n```ts\nconst x = 1\n```",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())

  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    Title
    
    Paragraph

    const x = 1"
  `)
})

test("adds spacing before lists", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-tight-list-spacing",
    content: "Paragraph:\n- one\n- two",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())

  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    Paragraph:
    
    - one
    - two"
  `)
})

test("preserves source blank line before lists", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-list-spacing",
    content: "The table alignment uses:\n\n1. AST-based parsing\n2. Caching",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    The table alignment uses:
    
    1. AST-based parsing
    2. Caching"
  `)
})

test("adds spacing after unordered lists", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-unordered-list-after-spacing",
    content: "- one\n- two\n\nParagraph after list",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())

  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    - one
    - two
    
    Paragraph after list"
  `)
})

test("adds spacing after ordered lists", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-ordered-list-after-spacing",
    content: "1. one\n2. two\n\nParagraph after list",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())

  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    1. one
    2. two
    
    Paragraph after list"
  `)
})

test("treats lists as separated blocks", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-list-block-spacing",
    content: `Paragraph before unordered list.
- one
- two

Paragraph after unordered list.
1. one
2. two

Paragraph after ordered list.`,
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())

  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    Paragraph before unordered list.
    
    - one
    - two
    
    Paragraph after unordered list.
    
    1. one
    2. two
    
    Paragraph after ordered list."
  `)
})

test("preserves list spacing when a blank line is removed", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-tighten-spacing",
    content: "Paragraph\n\n- one\n- two",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  md.content = "Paragraph\n- one\n- two"
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())

  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    Paragraph
    
    - one
    - two"
  `)
})

test("preserves spacing after tight fenced code blocks", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-tight-code-spacing",
    content: "```ts\nconst x = 1\n```\nParagraph",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())

  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    const x = 1
    
    Paragraph"
  `)
})

test("incremental update reuses unchanged blocks when appending", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "# Hello\n\nParagraph 1",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderer.idle()

  // Get reference to first block
  const firstBlockBefore = md.getChildren()[0]

  // Append content
  md.content = "# Hello\n\nParagraph 1\n\nParagraph 2"
  await renderer.idle()

  // First block should be reused (same object reference)
  const firstBlockAfter = md.getChildren()[0]
  expect(firstBlockAfter).toBe(firstBlockBefore)
})

test("streaming mode keeps trailing tokens unstable", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "# Hello",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const frame1 = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
  expect(frame1).toContain("Hello")

  // Extend the heading
  md.content = "# Hello World"
  await renderMarkdownRenderable(md)

  const frame2 = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
  expect(frame2).toContain("Hello World")
})

test("streaming code blocks with concealCode=true do not flash unconcealed markdown", async () => {
  const mockTreeSitterClient = createMockTreeSitterClient()
  mockTreeSitterClient.setMockResult({
    highlights: [[0, 1, "conceal", { conceal: "" }]],
  })

  const recorder = new TestRecorder(renderer)
  recorder.rec()

  const md = createMarkdownRenderable({
    id: "markdown-streaming-conceal-flicker",
    content: "# Stream\n\n```markdown\n# Hidden heading\n```",
    syntaxStyle,
    conceal: true,
    concealCode: true,
    streaming: true,
    treeSitterClient: mockTreeSitterClient,
  })

  renderer.root.add(md)
  await renderer.idle()

  expect(mockTreeSitterClient.isHighlighting()).toBe(true)

  const codeBlock = md.getChildren()[1] as CodeRenderable
  mockTreeSitterClient.resolveAllHighlightOnce()
  await waitForHighlight(codeBlock)
  await renderer.idle()

  recorder.stop()

  const frames = recorder.recordedFrames.map((frame) => frame.frame)
  const unconcealedFrames = frames.filter((frame) => frame.includes("# Hidden heading"))
  expect(unconcealedFrames.length).toBe(0)
})

test("streaming demo-style fenced code block does not flicker unhighlighted", async () => {
  const keywordFg = RGBA.fromValues(1, 0, 0, 1)
  const defaultFg = RGBA.fromValues(1, 1, 1, 1)
  const mockTreeSitterClient = new MockTreeSitterClient()
  mockTreeSitterClient.setMockResult({
    highlights: [[0, 6, "keyword"]],
  })

  const contentBeforeFence = `# OpenTUI Markdown Demo

Welcome to the **MarkdownRenderable** showcase.

`
  const fencedCodeBlock = `\`\`\`ts
export function appendMarkdownChunk(buffer: string): string {
  return buffer
}
\`\`\``
  const contentAfterFence = `

The fenced block above appears near the top so streaming mode exercises a larger CodeRenderable before the rest of the document arrives.`
  const fullContent = contentBeforeFence + fencedCodeBlock + contentAfterFence

  const md = createMarkdownRenderable({
    id: "markdown-streaming-demo-fence-no-flicker",
    content: "",
    syntaxStyle: SyntaxStyle.fromStyles(
      {
        default: { fg: defaultFg },
        keyword: { fg: keywordFg },
        "markup.heading.1": { fg: RGBA.fromValues(0, 1, 0, 1) },
        "markup.strong": { fg: RGBA.fromValues(0, 1, 1, 1), bold: true },
      },
      renderer.nativeScene,
    ),
    fg: defaultFg,
    bg: RGBA.fromValues(0, 0, 0, 1),
    conceal: true,
    streaming: true,
    tableOptions: { style: "grid", widthMode: "content", cellPaddingX: 1 },
    treeSitterClient: mockTreeSitterClient,
    width: "100%",
  })

  renderer.root.add(md)

  const recorder = new TestRecorder(renderer, { recordBuffers: { fg: true } })
  recorder.rec()

  for (const streamedContent of [
    contentBeforeFence,
    contentBeforeFence + fencedCodeBlock.slice(0, fencedCodeBlock.indexOf("\n```")),
    contentBeforeFence + fencedCodeBlock,
    fullContent,
  ]) {
    md.content = streamedContent
    await renderer.idle()
  }

  const codeBlock = md.getChildren().find((child) => child instanceof CodeRenderable)
  expect(codeBlock).toBeInstanceOf(CodeRenderable)
  expect(mockTreeSitterClient.isHighlighting()).toBe(true)
  mockTreeSitterClient.resolveAllHighlightOnce()
  await (codeBlock as CodeRenderable).highlightingDone
  await renderer.idle()
  recorder.stop()

  const frameWidth = renderer.currentRenderBuffer.width
  const expectedKeywordFg = [...keywordFg.buffer]

  const findTextFg = (recordedFrame: (typeof recorder.recordedFrames)[number], text: string): number[] | undefined => {
    const fgBuffer = recordedFrame.buffers?.fg
    if (!fgBuffer) return undefined

    const lines = recordedFrame.frame.split("\n")
    for (let y = 0; y < lines.length; y += 1) {
      const x = lines[y].indexOf(text)
      if (x === -1) continue

      const offset = (y * frameWidth + x) * 4
      return [...fgBuffer.slice(offset, offset + 4)]
    }

    return undefined
  }

  const visibleCodeFrames = recorder.recordedFrames
    .map((recordedFrame) => ({
      frameNumber: recordedFrame.frameNumber,
      exportFg: findTextFg(recordedFrame, "export function appendMarkdownChunk"),
    }))
    .filter((frame) => frame.exportFg !== undefined)

  expect(visibleCodeFrames.length).toBeGreaterThan(0)
  expect(visibleCodeFrames.some((frame) => frame.exportFg!.join(",") === expectedKeywordFg.join(","))).toBe(true)
  expect(visibleCodeFrames.filter((frame) => frame.exportFg!.join(",") !== expectedKeywordFg.join(","))).toEqual([])
})

/** Counts the string units of every message a client posts, and the bytes and layers written to text buffers. */
function countStreamWork(client: TreeSitterClient) {
  const counts = { units: 0, bytes: 0, layers: [] as number[], oneshots: 0, disposes: 0, copies: new Set<number>() }
  const target = client as unknown as { sendWorkerMessage(message: TreeSitterWorkerRequest): void }
  const send = target.sendWorkerMessage
  target.sendWorkerMessage = function (message) {
    counts.units += "content" in message ? message.content.length : "text" in message ? message.text.length : 0
    counts.oneshots += Number(message.type === "ONESHOT_HIGHLIGHT")
    counts.disposes += Number(message.type === "DISPOSE_COPY")
    // The worker copies alive: the first append makes one, a dispose frees it.
    if (message.type === "APPEND_HIGHLIGHT" && message.offset === 0) counts.copies.add(message.copyId)
    if (message.type === "DISPOSE_COPY") counts.copies.delete(message.copyId)
    return send.call(this, message)
  }
  const { setText, append, setStyledText, _setLayer } = TextBuffer.prototype
  TextBuffer.prototype.setText = function (text) {
    counts.bytes += Buffer.byteLength(text)
    return setText.call(this, text)
  }
  TextBuffer.prototype.append = function (text) {
    counts.bytes += Buffer.byteLength(text)
    return append.call(this, text)
  }
  TextBuffer.prototype.setStyledText = function (text) {
    for (const chunk of text.chunks) counts.bytes += Buffer.byteLength(chunk.text)
    return setStyledText.call(this, text)
  }
  TextBuffer.prototype._setLayer = function (layer, start, end, runs) {
    counts.layers.push(end)
    return _setLayer.call(this, layer, start, end, runs)
  }
  const restore = () => {
    target.sendWorkerMessage = send
    Object.assign(TextBuffer.prototype, { setText, append, setStyledText, _setLayer })
  }
  return { counts, restore }
}

const fenceLine = (i: number) => `  const value${i} = compute(input.items[${i}], "é ${i % 7} 😀") // step ${i}\n`

// Record 312: each byte of a streamed fence reaches the worker and native about once, so the work grows with the fence,
// not its square (on the base, 4 KB sent 74x its size to the worker). Each reply queries the whole tree (C4 rule (b)).
// A theme from another renderer's Context, which Markdown supports through a copy, costs the same.
test.each([
  [1024, false],
  [4096, false],
  [1024, true],
])("a %i-byte streamed fence sends work linear in its size (theme from another Context: %p)", async (size, foreign) => {
  let body = ""
  for (let i = 0; body.length < size; i++) body += fenceLine(i)
  const doc = "```typescript\n" + body + "```\n"
  const other = foreign ? await createTestRenderer({ width: 20, height: 5 }) : undefined
  const style = other ? SyntaxStyle.fromStyles(syntaxStyle.getAllStyles(), other.renderer.nativeScene) : syntaxStyle
  const md = createMarkdownRenderable({ content: "", syntaxStyle: style, streaming: true })
  renderer.root.add(md)
  const { counts, restore } = countStreamWork(markdownTreeSitterClient)
  try {
    for (let end = 32; end < doc.length + 32; end += 32) {
      md.content = doc.slice(0, end)
      await renderMarkdownRenderable(md, true)
    }
    const streamed = { ...counts, layers: counts.layers.length, copies: counts.copies.size }
    md.streaming = false
    await renderMarkdownRenderable(md, true)
    const n = Buffer.byteLength(doc)
    // Streaming: about n each way; the stream end highlights the fence once more, as before.
    expect(streamed.units).toBeLessThanOrEqual(1.1 * n)
    expect(streamed.bytes).toBeLessThanOrEqual(1.1 * n)
    expect(streamed.layers).toBeGreaterThan(size / 64)
    // The closed fence sent its last text as an append and freed its copy before the stream ended (question 4).
    expect([streamed.oneshots, streamed.copies, streamed.disposes]).toEqual([0, 0, 1])
    // The stream end highlights the fence once on today's path (question 9).
    expect([counts.oneshots, counts.disposes]).toEqual([1, 1])
    expect(counts.units).toBeLessThanOrEqual(2.2 * n)
    expect(counts.bytes).toBeLessThanOrEqual(2.2 * n)
    // A fence destroyed while it streams frees its copy too.
    const open = createMarkdownRenderable({ content: doc.slice(0, 64), syntaxStyle, streaming: true })
    renderer.root.add(open)
    await renderMarkdownRenderable(open, true)
    open.destroyRecursively()
    expect(counts.disposes).toBe(2)
  } finally {
    restore()
    md.destroyRecursively()
    other?.renderer.destroy()
  }
})

// A Markdown without a theme (a JavaScript caller, as in OpenCode's tests) has no copy of one to give its fences.
test("a fence in Markdown without a theme shows its text", async () => {
  const md = createMarkdownRenderable({ content: "```js\nlet a = 1\n```\n", syntaxStyle: undefined! })
  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  expect(captureFrame()).toContain("let a = 1")
})

// Design question 4: a fence frees its worker copy when its block closes, so a streaming answer holds a copy for its open
// fence only. An open fence of a hidden answer, whose update hooks do not run, frees its copy when the stream ends.
test("a streaming answer holds a worker copy only for its open fence", async () => {
  const md = createMarkdownRenderable({ content: "", syntaxStyle, streaming: true })
  renderer.root.add(md)
  const { counts, restore } = countStreamWork(markdownTreeSitterClient)
  try {
    let doc = ""
    for (let i = 0; i < 4; i++) {
      for (const piece of ["```js\n", `let n${i} = ${i}\n`, `let m${i} = n${i}\n`, "```\n", `Text ${i}.\n\n`]) {
        md.content = doc += piece
        await renderMarkdownRenderable(md, true)
      }
    }
    expect(counts.copies.size).toBe(0)
    md.content = doc += "```js\nlet open = 1\n"
    await renderMarkdownRenderable(md, true)
    expect(counts.copies.size).toBe(1)
    md.visible = false
    await renderOnce()
    md.streaming = false
    await renderOnce()
    expect(counts.copies.size).toBe(0)
  } finally {
    restore()
  }
})

// One request in flight: appends made while it runs go to native at once and to the worker together in the next one;
// each reply writes the layer for the prefix it covers. A streaming fence has no syntax highlight records (C4 question 9).
test("a streamed fence sends the appends made during a reply as one delta", async () => {
  const client = createMockTreeSitterClient()
  const sent: string[] = []
  const highlightAppend = client.highlightAppend.bind(client)
  client.highlightAppend = (id, offset, text, filetype) => (
    sent.push(text), highlightAppend(id, offset, text, filetype)
  )
  const { counts, restore } = countStreamWork(client)
  try {
    const md = createMarkdownRenderable({
      content: "```js\nlet a",
      syntaxStyle,
      streaming: true,
      treeSitterClient: client,
    })
    renderer.root.add(md)
    await renderOnce()
    for (const content of ["```js\nlet a = 1", "```js\nlet a = 1 + 2"]) {
      md.content = content
      await renderOnce()
    }
    expect(sent).toEqual(["let a"])
    expect(counts.bytes).toBe("let a = 1 + 2".length)
    client.resolveAllHighlightOnce()
    await flushAsync()
    await renderOnce()
    expect(sent).toEqual(["let a", " = 1 + 2"])
    expect(counts.layers).toEqual([5])
    client.resolveAllHighlightOnce()
    await waitForHighlight(md.getChildren()[0] as CodeRenderable)
    expect(counts.layers).toEqual([5, 13])
    expect(counts.units).toBe(0)
    expect((md.getChildren()[0] as CodeRenderable).getLineHighlights(0)).toEqual([])
    // A change that is not an append drops the request in flight: its reply writes no layer, and the text goes whole.
    md.content = "```js\nlet a = 1 + 2;"
    await renderOnce()
    md.content = "```js\nlet b = 1 + 2;"
    await renderOnce()
    client.resolveHighlightOnce()
    await flushAsync()
    expect([sent.slice(2), counts.layers]).toEqual([[";"], [5, 13]])
    // A reply held while its fence stops being eligible (another language, or concealment) writes no layer.
    md.destroyRecursively()
    client.resolveAllHighlightOnce()
    await flushAsync()
    for (const change of [
      (held: MarkdownRenderable) => (held.content = "```ts\nlet c"),
      (held: MarkdownRenderable) => (held.concealCode = true),
    ]) {
      const held = createMarkdownRenderable({
        content: "```js\nlet c",
        syntaxStyle,
        streaming: true,
        treeSitterClient: client,
      })
      renderer.root.add(held)
      await renderOnce()
      change(held)
      await renderOnce()
      const layers = counts.layers.length
      client.resolveHighlightOnce()
      await flushAsync()
      expect(counts.layers.length).toBe(layers)
      held.destroyRecursively()
    }
  } finally {
    restore()
  }
})

// Oracle (D97): at each step, once its highlight lands, a streamed fence paints as a fresh Code highlighted whole, and
// after the stream as a fresh Markdown. Seeded pieces cover multibyte text, strings, comments and partial tokens; the
// fixed rows cover text with no captures, a fallback style and a nested fence's last backticks. The theme's default
// has its own look and leaves `punctuation` unstyled, so a chunk that merges no style shows which one it paints.
test("a streamed fence paints as a fresh highlight at every step", async () => {
  const pieces = ["const ", "x", " = ", '"é😀', '"', "// c", "\n", "{", "}", "(a, b) => ", "1", ";", "/*", "*/", "  "]
  const styles = {
    default: { fg: "#fefefe", italic: true },
    keyword: { fg: "#ff0000" },
    string: { fg: "#00ff00", bold: true },
    comment: { fg: "#0000ff", italic: true },
    number: { fg: "#ffff00" },
    variable: { fg: "#00ffff" },
    "variable.parameter": { fg: "#ff00ff" },
    operator: { fg: "#808080" },
    function: { fg: "#804000" },
    "markup.raw": { fg: "#00aa00" },
    "punctuation.delimiter": { fg: "#aa0000" },
  }
  const style = SyntaxStyle.fromStyles(styles, renderer.nativeScene)
  const twin = await createTestRenderer({ width: 60, height: 40 })
  const twinStyle = SyntaxStyle.fromStyles(styles, twin.renderer.nativeScene)
  const keyword = RGBA.fromHex("#ff0000")
  const rows: Array<[label: string, opener: string, filetype: string, pieces: string[]]> = []
  for (let seed = 1; seed <= 6; seed++) {
    let state = seed
    const random = (n: number) => ((state = (state * 1103515245 + 12345) % 2 ** 31), state % n)
    const steps = Array.from({ length: 24 }, () =>
      pieces[random(pieces.length)]!.concat(random(3) === 0 ? pieces[random(pieces.length)]! : ""),
    )
    // Each seed starts with a keyword, so a query that returns no captures fails the color check below.
    rows.push([`seed ${seed}`, "```javascript\n", "javascript", ["const ", ...steps]])
  }
  rows.push(["no captures", "```javascript\n", "javascript", ["@", " ", "#"]])
  rows.push(["strikethrough", "~~~~markdown\n", "markdown", ["~~strike~~", " and", "\n"]])
  rows.push(["nested fence", "~~~~markdown\n", "markdown", ["```js\n", "let n=1\n", "```"]])
  // A failed delta falls back to a whole highlight, which paints right too: the fence must never send one.
  const { counts, restore } = countStreamWork(markdownTreeSitterClient)
  try {
    for (const [label, opener, filetype, steps] of rows) {
      let doc = opener
      const md = createMarkdownRenderable({ content: doc, syntaxStyle: style, streaming: true })
      renderer.root.add(md)
      for (const [step, piece] of steps.entries()) {
        md.content = doc += piece
        const oneshots = counts.oneshots
        await renderMarkdownRenderable(md, true)
        expect({ label, step, oneshots: counts.oneshots }).toEqual({ label, step, oneshots })
        const fence = md.getChildren()[0] as CodeRenderable
        const fresh = new CodeRenderable(twin.renderer, {
          content: fence.content,
          filetype,
          syntaxStyle: twinStyle,
          treeSitterClient: markdownTreeSitterClient,
          conceal: false,
          width: "100%",
        })
        twin.renderer.root.add(fresh)
        await twin.renderOnce()
        await waitForHighlight(fresh)
        await twin.renderOnce()
        expect({ label, step, spans: captureSpans().lines }).toEqual({ label, step, spans: twin.captureSpans().lines })
        if (step === 0 && label.startsWith("seed")) {
          expect(captureSpans().lines[0]!.spans.some((span) => span.text === "const" && span.fg.equals(keyword))).toBe(
            true,
          )
        }
        fresh.destroy()
      }
      md.streaming = false
      await renderMarkdownRenderable(md, true)
      const streamed = captureSpans().lines
      md.destroyRecursively()
      const settled = createMarkdownRenderable({ content: doc, syntaxStyle: style })
      renderer.root.add(settled)
      await renderMarkdownRenderable(settled, true)
      expect({ label, spans: streamed }).toEqual({ label, spans: captureSpans().lines })
      settled.destroyRecursively()
    }
  } finally {
    restore()
    twin.renderer.destroy()
    style.destroy()
    twinStyle.destroy()
  }
})

test("non-streaming content commits every top-level block", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "# Hello\n\nPara 1\n\nPara 2",
    syntaxStyle,
    streaming: false,
  })

  renderer.root.add(md)
  await renderer.idle()
  expect(md.committedBlockCount).toBe(3)
})

test("streamed content commits the closed top-level blocks", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-top-level-stable-prefix",
    content: "# Title\n\nPara 1\n\n",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  md.content = "# Title\n\nPara 1\n\nPara 2"
  await renderMarkdownRenderable(md)

  expect(topKinds(md)).toEqual(["heading", "paragraph", "paragraph"])
  expect(md.committedBlockCount).toBe(2)
  md.streaming = false
  expect(md.committedBlockCount).toBe(3)
})

test("content update with same text does not rebuild", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "# Hello",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderer.idle()

  const blockBefore = md.getChildren()[0]

  // Set same content
  md.content = "# Hello"
  await renderer.idle()

  const blockAfter = md.getChildren()[0]
  expect(blockAfter).toBe(blockBefore)
})

test("a heading that becomes a paragraph keeps its renderable", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "# Hello",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderer.idle()

  const blockBefore = md.getChildren()[0]

  // Change from heading to paragraph
  md.content = "Hello"
  await renderer.idle()

  const blockAfter = md.getChildren()[0]
  // A heading that becomes a paragraph keeps its text renderable.
  expect(blockAfter).toBe(blockBefore)
})

test("streaming property can be toggled", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "# Hello",
    syntaxStyle,
    streaming: false,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  expect(md.streaming).toBe(false)
  const blockBefore = md.getChildren()[0]

  md.streaming = true
  expect(md.streaming).toBe(true)

  await renderMarkdownRenderable(md)

  const blockAfter = md.getChildren()[0]
  expect(blockAfter).toBe(blockBefore)

  const frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
  expect(frame).toContain("Hello")
})

test("completing a stream keeps rendered Markdown visible", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-stream-completion",
    content: "# Hello\n\nResponse remains visible",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const recorder = new TestRecorder(renderer)
  recorder.rec()

  md.streaming = false
  await renderMarkdownRenderable(md)
  recorder.stop()

  expect(recorder.recordedFrames.length).toBeGreaterThan(0)
  expect(recorder.recordedFrames.every((frame) => frame.frame.includes("Response remains visible"))).toBe(true)
})

test("clearCache forces full rebuild", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "# Hello\n\nWorld",
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderer.idle()

  const before = md.getChildren()

  md.clearCache()
  await renderer.idle()

  expect(md.getChildren()).toHaveLength(before.length)
  md.getChildren().forEach((child, index) => expect(child).not.toBe(before[index]))
})

test("streaming->non-streaming transition keeps final table row visible", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "| Value |\n|---|\n| first |\n| second |",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderer.idle()

  const tableWhileStreaming = md.getChildren()[0]

  let frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(frame).toContain("first")
  expect(frame).toContain("second")

  md.streaming = false
  await renderer.idle()

  frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(frame).toContain("first")
  expect(frame).toContain("second")
  expect(md.getChildren()[0]).toBe(tableWhileStreaming)
})

test("streaming table remains visible when a new block starts", async () => {
  const tableMarkdown = "| Value |\n|---|\n| first |\n| second |"
  const md = createMarkdownRenderable({
    id: "markdown",
    content: tableMarkdown,
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderer.idle()

  const tableWhileTrailing = md.getChildren()[0]

  let frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(frame).toContain("first")
  expect(frame).toContain("second")

  md.content = `${tableMarkdown}\n\nAfter table block.`
  await renderer.idle()

  frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(md.streaming).toBe(true)
  expect(frame).toContain("first")
  expect(frame).toContain("second")
  expect(md.getChildren().length).toBeGreaterThan(1)
  expect(md.getChildren()[0]).toBe(tableWhileTrailing)
})

test("stream end mid-table finalizes full table snapshot", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)

  md.content = "| Name | Score |\n|---|---|\n"
  await renderer.idle()

  md.content = "| Name | Score |\n|---|---|\n| Alpha | 10 |\n"
  await renderer.idle()

  md.content = "| Name | Score |\n|---|---|\n| Alpha | 10 |\n| Bravo | 20 |\n"
  await renderer.idle()

  md.content = "| Name | Score |\n|---|---|\n| Alpha | 10 |\n| Bravo | 20 |\n| Charlie | 30 |"
  await renderer.idle()

  let frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(frame).toContain("Charlie")

  md.streaming = false
  await renderer.idle()

  frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()

  expect(frame).toMatchInlineSnapshot(`
"┌──────────────────────────────┬───────────────────────────┐
│Name                          │Score                      │
├──────────────────────────────┼───────────────────────────┤
│Alpha                         │10                         │
├──────────────────────────────┼───────────────────────────┤
│Bravo                         │20                         │
├──────────────────────────────┼───────────────────────────┤
│Charlie                       │30                         │
└──────────────────────────────┴───────────────────────────┘"
`)
})

test("ignores content updates after markdown renderable is destroyed during streaming", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)

  md.content = "| Name | Score |\n|---|---|\n| Alpha | 10 |\n"
  await renderer.idle()

  md.destroyRecursively()
  expect(md.isDestroyed).toBe(true)

  expect(() => {
    md.content = "| Name | Score |\n|---|---|\n| Alpha | 10 |\n| Bravo | 20 |\n"
    md.streaming = false
  }).not.toThrow()

  await renderer.idle()
})

test("non-streaming->streaming transition keeps final table row visible", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "| Value |\n|---|\n| first |\n| second |",
    syntaxStyle,
    streaming: false,
  })

  renderer.root.add(md)
  await renderer.idle()

  const tableWhileStable = md.getChildren()[0]

  let frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(frame).toContain("first")
  expect(frame).toContain("second")

  md.streaming = true
  await renderer.idle()

  frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(frame).toContain("first")
  expect(frame).toContain("second")
  expect(md.getChildren()[0]).toBe(tableWhileStable)
})

test("streaming table reuses renderable while updating row content", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "| A |\n|---|\n| 1 |",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderer.idle()

  const tableBefore = md.getChildren()[0]

  md.content = "| B |\n|---|\n| 2 |"
  await renderer.idle()

  const tableAfterSameRows = md.getChildren()[0]
  expect(tableAfterSameRows).toBe(tableBefore)

  md.content = "| B |\n|---|\n| 2 |\n| 3 |"
  await renderer.idle()

  const tableAfterNewRow = md.getChildren()[0]
  expect(tableAfterNewRow).toBe(tableBefore)
})

test("table shows all rows when streaming is false", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "| A |\n|---|\n| 1 |",
    syntaxStyle,
    streaming: false,
  })

  renderer.root.add(md)
  await renderer.idle()

  // Non-streaming should show all rows including the last
  const frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
  expect(frame).toContain("1")
})

test("table updates content when not streaming", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "| A |\n|---|\n| 1 |",
    syntaxStyle,
    streaming: false,
  })

  renderer.root.add(md)
  await renderer.idle()

  const frame1 = captureFrame()
  expect(frame1).toContain("1")

  // Change cell content - should update immediately when not streaming
  md.content = "| A |\n|---|\n| 2 |"
  await renderer.idle()

  const frame2 = captureFrame()
  expect(frame2).toContain("2")
  expect(frame2).not.toContain("1")
})

test("table keeps unchanged cell chunks stable across updates", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |",
    syntaxStyle,
    streaming: false,
  })

  renderer.root.add(md)
  await renderer.idle()

  const table = md.getChildren()[0] as TextTableRenderable
  expect(table).toBeInstanceOf(TextTableRenderable)

  const headerBefore = table.content[0]?.[0]
  const firstRowBefore = table.content[1]?.[0]
  const secondRowSecondCellBefore = table.content[2]?.[1]
  const changedCellBefore = table.content[2]?.[0]

  md.content = "| A | B |\n|---|---|\n| 1 | 2 |\n| 33 | 4 |"
  await renderer.idle()

  const tableAfter = md.getChildren()[0] as TextTableRenderable
  expect(tableAfter).toBe(table)
  expect(tableAfter.content[0]?.[0]).toBe(headerBefore)
  expect(tableAfter.content[1]?.[0]).toBe(firstRowBefore)
  expect(tableAfter.content[2]?.[1]).toBe(secondRowSecondCellBefore)
  expect(tableAfter.content[2]?.[0]).not.toBe(changedCellBefore)
})

test("streaming table updates trailing row content", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "| A |\n|---|\n| 1 |\n| 2 |",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderer.idle()

  const table = md.getChildren()[0] as TextTableRenderable
  const contentBefore = table.content

  md.content = "| A |\n|---|\n| 1 |\n| 200 |"
  await renderer.idle()

  const tableAfter = md.getChildren()[0] as TextTableRenderable
  const frame = captureFrame()
  expect(tableAfter).toBe(table)
  expect(tableAfter.content).not.toBe(contentBefore)
  expect(frame).toContain("200")
})

test("streaming complex tables keep final rows visible (issue #15244)", async () => {
  const vmHeader = "| VM | 状态 | Owner | Zone | CPU | Mem(GB) | Disk(GB) | Net | Uptime | Cost/月 | Notes |"
  const vmDelimiter = "|---|---|---|---|---|---|---|---|---|---|---|"
  const vmRows = [
    "| vm-api-01 | 🟢 运行中 | alice | us-east-1a | 8 | 32 | 500 | 1.2Gbps | 99.99% | 12,345 | 主节点 — steady |",
    "| vm-job-02 | 🟢 运行中 | bob | ap-south-1b | 16 | 64 | 1,024 | 950Mbps | 98.70% | 23,456 | 批处理 — spikes |",
    "| vm-batch-03 | 🟡 维护中 | carol | eu-west-1c | 32 | 128 | 2,048 | 2.4Gbps | 97.10% | 34,567 | 最后一行 — must stay |",
  ] as const

  const storageHeader = "| 存储池 | 状态 | 使用率 | 可用(GB) | 已用(GB) | 冗余 | 备注 |"
  const storageDelimiter = "|---|---|---|---|---|---|---|"
  const storageRows = [
    "| 热池A | 🟢 正常 | 72% | 12,500 | 32,500 | 3x | 混合负载 |",
    "| 温池B | 🟢 正常 | 81% | 8,250 | 35,750 | 2x | 历史数据 |",
    "| 冷池C | 🟡 告警 | 93% | 2,100 | 27,900 | 2x | 最后一行 — must stay |",
  ] as const

  const buildContent = (vmRowCount: number, storageRowCount: number): string =>
    `### VM details\n\n${vmHeader}\n${vmDelimiter}\n${vmRows.slice(0, vmRowCount).join("\n")}\n\n### Storage details\n\n${storageHeader}\n${storageDelimiter}\n${storageRows.slice(0, storageRowCount).join("\n")}`

  const md = createMarkdownRenderable({
    id: "markdown",
    content: "",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)

  for (const [vmRowCount, storageRowCount] of [
    [2, 2],
    [3, 2],
    [3, 3],
  ] as const) {
    md.content = buildContent(vmRowCount, storageRowCount)
    await renderMarkdownRenderable(md)
  }

  const tableBlocks = md
    .getChildren()
    .filter((renderable): renderable is TextTableRenderable => renderable instanceof TextTableRenderable)

  const cellText = (cell: { text: string }[] | null | undefined): string =>
    cell?.map((chunk) => chunk.text).join("") ?? ""

  expect(tableBlocks).toHaveLength(2)

  const vmTable = tableBlocks[0]
  const storageTable = tableBlocks[1]

  expect(vmTable.content.length).toBe(4)
  expect(storageTable.content.length).toBe(4)
  expect(cellText(vmTable.content[3]?.[0])).toContain("vm-batch-03")
  expect(cellText(storageTable.content[3]?.[0])).toContain("冷池C")
})

test("streaming table with incomplete first row is rendered with padded cells", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "| A |\n|---|\n|",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const frame1 = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(frame1).toMatch(/[┌│└]/)
  expect(frame1).toContain("A")

  md.content = "| A |\n|---|\n| 1"
  await renderMarkdownRenderable(md)

  const frame2 = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(frame2).toMatch(/[┌│└]/)
  expect(frame2).toContain("1")

  md.content = "| A |\n|---|\n| 1 |\n| 2 |"
  await renderMarkdownRenderable(md)

  const frame3 = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

  expect(frame3).toMatch(/[┌│└]/)
  expect(frame3).toContain("1")
  expect(frame3).toContain("2")
})

// D93 B: a line that may still become a table's header or delimiter row is held until its line decides it, so the raw
// pipes never show and then turn into a table.
test("streaming table holds a possible header until the delimiter row decides it", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "| Header |",
    syntaxStyle,
    streaming: true,
    tableOptions: { widthMode: "content" },
  })
  renderer.root.add(md)
  // A row after the delimiter shows its cells as they arrive.
  const table = "┌──────┐\n│Header│\n├──────┤\n│D     │\n└──────┘"
  for (const [content, expected] of [
    ["| Header |", ""],
    ["| Header |\n|---|", ""],
    ["| Header |\n|---|\n| D", table],
    ["| Header |\n|---|\n| D |\n", table],
  ]) {
    md.content = content!
    await renderOnce()
    expect(frameText()).toBe(expected!)
  }
})

test("streaming table remains rendered when row count decreases", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "| A |\n|---|\n| 1 |\n| 2 |",
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  let frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
  expect(frame).toMatch(/[┌│└]/)
  expect(frame).toContain("1")
  expect(frame).toContain("2")

  md.content = "| A |\n|---|\n| 1 |"
  await renderMarkdownRenderable(md)

  frame = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
  expect(frame).toMatch(/[┌│└]/)
  expect(frame).toContain("1")
  expect(frame).not.toContain("|---|")
})

test("conceal change updates rendered content", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "# Hello **bold**",
    syntaxStyle,
    conceal: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const frame1 = captureFrame()
  expect(frame1).not.toContain("**")
  expect(frame1).not.toContain("#")

  md.conceal = false
  renderer.requestRender()
  await renderMarkdownRenderable(md)

  const frame2 = captureFrame()
  expect(frame2).toContain("**")
  expect(frame2).toContain("#")
})

test("theme switching (syntaxStyle change)", async () => {
  const theme1 = SyntaxStyle.fromStyles(
    {
      default: { fg: RGBA.fromValues(1, 0, 0, 1) }, // Red
      "markup.heading.1": { fg: RGBA.fromValues(0, 1, 0, 1), bold: true }, // Green
      "markup.strikethrough": { strikethrough: true },
      "markup.heading": { strikethrough: true },
      "markup.raw": { strikethrough: true },
    },
    renderer.nativeScene,
  )

  const theme2 = SyntaxStyle.fromStyles(
    {
      default: { fg: RGBA.fromValues(0, 0, 1, 1) }, // Blue
      "markup.heading.1": { fg: RGBA.fromValues(1, 1, 0, 1), bold: true }, // Yellow
      "markup.strikethrough": { strikethrough: false },
    },
    renderer.nativeScene,
  )

  // Use the EXACT content from markdown-demo.ts to reproduce the issue
  const content = `# OpenTUI Markdown Demo

Welcome to the **MarkdownRenderable** showcase! This demonstrates automatic table alignment and syntax highlighting.

## Features

- Automatic **table column alignment** based on content width
- Proper handling of \`inline code\`, **bold**, and *italic* in tables
- Multiple syntax themes to choose from
- Conceal mode hides formatting markers

## Comparison Table

| Feature | Status | Priority | Notes |
|---|---|---|---|
| Table alignment | **Done** | High | Uses \`marked\` parser |
| Conceal mode | *Working* | Medium | Hides \`**\`, \`\`\`, etc. |
| Theme switching | **Done** | Low | 3 themes available |
| Unicode support | 日本語 | High | CJK characters |

## Code Examples

Here's how to use it:

\`\`\`typescript
import { MarkdownRenderable } from "@opentui/core"

const md = createMarkdownRenderable({
  content: "# Hello World",
  syntaxStyle: mySyntaxStyle,
  conceal: true, // Hide formatting markers
})
\`\`\`

### API Reference

| Method | Parameters | Returns | Description |
|---|---|---|---|
| \`constructor\` | \`ctx, options\` | \`MarkdownRenderable\` | Create new instance |
| \`clearCache\` | none | \`void\` | Force re-render content |

## Inline Formatting Examples

| Style | Syntax | Rendered |
|---|---|---|
| Bold | \`**text**\` | **bold text** |
| Italic | \`*text*\` | *italic text* |
| Code | \`code\` | \`inline code\` |
| Link | \`[text](url)\` | [OpenTUI](https://github.com) |

## Mixed Content

> **Note**: This blockquote contains **bold** and \`code\` formatting.
> It should render correctly with proper styling.

### Emoji Support

| Emoji | Name | Category |
|---|---|---|
| 🚀 | Rocket | Transport |
| 🎨 | Palette | Art |
| ⚡ | Lightning | Nature |
| 🔥 | Fire | Nature |

---

## Alignment Examples

| Left | Center | Right |
|:---|:---:|---:|
| L1 | C1 | R1 |
| Left aligned | Centered text | Right aligned |
| Short | Medium length | Longer content here |

## Performance

The table alignment uses:
1. AST-based parsing with \`marked\`
2. Caching for repeated content
3. Smart width calculation accounting for concealed chars

---

*Press \`?\` for keybindings*
`

  const md = createMarkdownRenderable({
    id: "markdown",
    content,
    syntaxStyle: theme1,
    conceal: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const frame1 = captureSpans()
  const headingSpan1 = findSpanContaining(frame1, "OpenTUI Markdown Demo")
  expect(headingSpan1).toBeDefined()
  expect(headingSpan1!.fg.r).toBe(0)
  expect(headingSpan1!.fg.g).toBe(1)
  expect(headingSpan1!.fg.b).toBe(0)
  expect(headingSpan1!.attributes & TextAttributes.BOLD).toBeTruthy()

  // Switch theme
  md.syntaxStyle = theme2
  renderer.requestRender()
  await renderMarkdownRenderable(md)

  const frame2 = captureSpans()
  const headingSpan2 = findSpanContaining(frame2, "OpenTUI Markdown Demo")
  expect(headingSpan2).toBeDefined()
  expect(headingSpan2!.fg.r).toBe(1)
  expect(headingSpan2!.fg.g).toBe(1)
  expect(headingSpan2!.fg.b).toBe(0)
  expect(headingSpan2!.attributes & TextAttributes.BOLD).toBeTruthy()

  // `~~x~~` in prose (tree-sitter) and in table cells (marked). A header cell takes the heading's
  // strikethrough when it sets one and keeps the inline one otherwise; nested styles keep the strike.
  const theme3 = SyntaxStyle.fromStyles(
    { default: { fg: RGBA.fromValues(1, 1, 1, 1) }, "markup.strikethrough": { strikethrough: true } },
    renderer.nativeScene,
  )
  md.content = "~~gone~~ text\n\n| ~~head~~ | plain | more |\n|---|---|---|\n| ~~cell~~ | ~~**nested**~~ | `code` |\n"
  const texts = ["gone", "head", "plain", "cell", "nested", "code"]
  for (const [theme, struck] of [
    [theme1, texts],
    [theme2, []],
    [theme3, ["gone", "head", "cell", "nested"]],
    // No markup.strikethrough entry: struck by default, as in Rust.
    [syntaxStyle, ["gone", "head", "cell", "nested"]],
  ] as const) {
    md.syntaxStyle = theme
    await renderMarkdownRenderable(md)
    const frame = captureSpans()
    for (const text of texts) {
      const attributes = findSpanContaining(frame, text)!.attributes & TextAttributes.STRIKETHROUGH
      expect([text, attributes]).toEqual([
        text,
        (struck as readonly string[]).includes(text) ? TextAttributes.STRIKETHROUGH : 0,
      ])
    }
  }
})

// Paragraph rendering tests

test("paragraph links are rendered with markdown conceal behavior", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "Check [Google](https://google.com) out",
    syntaxStyle,
    conceal: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const paragraphChildren = md.getChildren()
  expect(paragraphChildren.length).toBe(1)
  expect(paragraphChildren[0]).toBeInstanceOf(TextRenderable)

  const frame = captureFrame()
  expect(frame).toContain("Google")
  expect(frame).toContain("https://google.com")
  expect(frame).not.toContain("[Google](https://google.com)")
})

test("paragraph initial render does not flash raw markdown markers", async () => {
  const recorder = new TestRecorder(renderer)
  recorder.rec()

  const md = createMarkdownRenderable({
    id: "markdown",
    content: "This has **bold** text.",
    syntaxStyle,
    conceal: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  recorder.stop()

  const paragraphChildren = md.getChildren()
  expect(paragraphChildren.length).toBe(1)
  expect(paragraphChildren[0]).toBeInstanceOf(TextRenderable)

  const rawMarkdownFrames = recorder.recordedFrames.filter((recorded) => recorded.frame.includes("**bold**"))
  expect(rawMarkdownFrames.length).toBe(0)

  const finalFrame = captureFrame()
  expect(finalFrame).toContain("This has bold text.")
})

test("paragraph updates do not flash raw markdown markers", async () => {
  const md = createMarkdownRenderable({
    id: "markdown",
    content: "**First** value",
    syntaxStyle,
    conceal: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const paragraphChildrenBefore = md.getChildren()
  expect(paragraphChildrenBefore.length).toBe(1)
  expect(paragraphChildrenBefore[0]).toBeInstanceOf(TextRenderable)

  const recorder = new TestRecorder(renderer)
  recorder.rec()

  md.content = "**Second** value"
  await renderMarkdownRenderable(md)
  recorder.stop()

  const paragraphChildrenAfter = md.getChildren()
  expect(paragraphChildrenAfter.length).toBe(1)
  expect(paragraphChildrenAfter[0]).toBeInstanceOf(TextRenderable)

  const rawMarkdownFrames = recorder.recordedFrames.filter((recorded) => recorded.frame.includes("**Second**"))
  expect(rawMarkdownFrames.length).toBe(0)

  const finalFrame = captureFrame()
  expect(finalFrame).toContain("Second value")
  expect(finalFrame).not.toContain("**Second**")
})

test("top-level list does not insert blank line before nested list when source has blank line", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-list-blank-before-nested",
    content: `- Added t topic edit mode in TUI:

  - t focuses input with current topic
  - enter saves via daemon /topic
  - esc cancels
- Topic is now shown prominently near the top of the TUI.`,
    syntaxStyle,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    - Added t topic edit mode in TUI:

      - t focuses input with current topic
      - enter saves via daemon /topic
      - esc cancels

    - Topic is now shown prominently near the top of the TUI."
  `)
})

test("top-level lists keep tight multi-level nesting compact", async () => {
  const md = createMarkdownRenderable({
    id: "markdown-tight-multi-level-nested-list",
    content: `- Main section:
  - Supporting point:
    - Third-level detail
    - Another detail with **emphasis**
  - Another supporting point:
    1. First numbered item
    2. Second numbered item:
       - Nested bullet beneath a numbered item
- Second section:
  - Short detail
  - Lead-in item:
    - Explanation below the lead-in`,
    syntaxStyle,
    streaming: true,
  })

  renderer.root.add(md)
  await renderMarkdownRenderable(md)

  const lines = captureFrame()
    .split("\n")
    .map((line) => line.trimEnd())
  expect("\n" + lines.join("\n").trimEnd()).toMatchInlineSnapshot(`
    "
    - Main section:
      - Supporting point:
        - Third-level detail
        - Another detail with emphasis
      - Another supporting point:
        1. First numbered item
        2. Second numbered item:
           - Nested bullet beneath a numbered item
    - Second section:
      - Short detail
      - Lead-in item:
        - Explanation below the lead-in"
  `)
})

// Inline hook

// Like OpenCode's session links: a known ID, alone or after `@session:`, shows as `@title`, or as written without
// conceal; a code span takes part only when it is exactly an ID. `calls` gets each context the hook sees.
function sessionLinks(titles: Map<string, string>, calls: MarkdownInlineContext[] = []): MarkdownInlineHook {
  return (spans, context) => {
    calls.push(context)
    return spans.flatMap((span) => {
      if (span.link || (span.code && !/^`*\s?ses_\w+\s?`*$/.test(span.text))) return [span]
      const out = []
      let last = 0
      for (const match of span.text.matchAll(/(?:@session:)?(ses_[a-z0-9]+)/g)) {
        const title = titles.get(match[1]!)
        if (!title) continue
        out.push({ ...span, text: span.text.slice(last, match.index) })
        out.push({ ...span, text: context.conceal ? `@${title}` : match[0], target: match[1] })
        last = match.index + match[0].length
      }
      out.push({ ...span, text: span.text.slice(last) })
      return out.filter((part) => part.text)
    })
  }
}

// Session links whose targets draw underlined, so a frame shows where `targetAt` should answer.
function underlinedLinks(titles: Map<string, string>): MarkdownInlineHook {
  const hook = sessionLinks(titles)
  return (spans, context) =>
    hook(spans, context).map((span) =>
      span.target ? { ...span, attributes: (span.attributes ?? 0) | TextAttributes.UNDERLINE } : span,
    )
}

// Checks `targetAt` at every cell: it answers exactly where the frame draws an underlined cell, with `id` of its row.
function expectTargets(md: MarkdownRenderable, id: (row: string) => string) {
  const frame = captureSpans()
  frame.lines.forEach((line, y) => {
    const row = line.spans.map((span) => span.text).join("")
    let x = 0
    for (const span of line.spans) {
      const linked = (span.attributes & TextAttributes.UNDERLINE) !== 0
      for (const char of span.text) {
        expect([x, y, md.targetAt(x, y)]).toEqual([x, y, linked ? id(row) : undefined])
        x += stringWidth(char) || 1
      }
    }
  })
}

test("targetAt answers exactly where the last frame drew a target", async () => {
  const titles = new Map([
    ["ses_a", "LongSessionTitle"],
    ["ses_b", "SecondLink"],
    ["ses_cjk", "中文タイトル"],
    ["ses_top", "TopLink"],
    ["ses_mid", "MidLink"],
    ["ses_bot", "BotLink"],
  ])
  const mount = (content: string) => {
    const md = createMarkdownRenderable({ content, syntaxStyle, inlineHook: underlinedLinks(titles) })
    renderer.root.add(md)
    return md
  }
  // Wrap padding before and after a wrapped title, and the gap a wide character leaves, have no target.
  resizeRenderer(12, 6)
  let md = mount("hi ses_a ses_b")
  await renderOnce()
  expect(frameText()).toBe("hi\n@LongSession\nTitle\n@SecondLink")
  expectTargets(md, (row) => (row.includes("Second") ? "ses_b" : "ses_a"))
  md.destroyRecursively()
  resizeRenderer(10, 4)
  md = mount("1234567:ses_cjk")
  await renderOnce()
  expect(frameText()).toBe("1234567:\n@中文タイ\nトル")
  expectTargets(md, () => "ses_cjk")
  md.destroyRecursively()

  // A renderer's wrapper around the default answers as the default does.
  const wrapped = createMarkdownRenderable({
    content: "ses_top",
    syntaxStyle,
    inlineHook: underlinedLinks(titles),
    renderBlock: (_block, context) => {
      const box = new BoxRenderable(renderer, { paddingLeft: 2 })
      box.add(context.defaultRender()!)
      return box
    },
  })
  renderer.root.add(wrapped)
  await renderOnce()
  expectTargets(wrapped, () => "ses_top")
  wrapped.destroyRecursively()

  // Rows a scroll box clips and cells an overlay covers answer as the screen shows.
  resizeRenderer(24, 8)
  const box = new ScrollBoxRenderable(renderer, { height: 4, marginTop: 2 })
  md = createMarkdownRenderable({
    content: "ses_top\n\nplain\n\nses_mid\n\nses_bot",
    syntaxStyle,
    inlineHook: underlinedLinks(titles),
  })
  box.add(md)
  renderer.root.add(box)
  box.scrollTo(1)
  await renderOnce()
  const row = (row: string) => ({ "@MidLink": "ses_mid", "@BotLink": "ses_bot" })[row.trim()] ?? "ses_top"
  expect(frameText()).toContain("@MidLink")
  expectTargets(md, row)
  const overlay = new BoxRenderable(renderer, {
    position: "absolute",
    width: 24,
    height: 8,
    backgroundColor: "#000000",
  })
  renderer.root.add(overlay)
  await renderOnce()
  expectTargets(md, () => "none")
  overlay.destroy()
  box.destroyRecursively()

  // Until a frame shows replaced text, its targets do not answer. Unlike Rust, Core answers nothing there even for equal
  // text with another target: the replace moves the text's node, which a frame must paint again (carbon-4.2's window).
  resizeRenderer(12, 2)
  md = mount("ses_top")
  await renderOnce()
  md.content = "ses_bot"
  expect(md.targetAt(0, 0)).toBeUndefined()
  await renderOnce()
  expectTargets(md, () => "ses_bot")
  titles.set("ses_mid", "BotLink")
  md.content = "ses_mid"
  expect(md.targetAt(0, 0)).toBeUndefined()
  await renderOnce()
  expectTargets(md, () => "ses_mid")
})

test("targetAt counts bytes as the hook returned them", async () => {
  // A hook's CRLF stays in the text, so the target after it lines up.
  resizeRenderer(20, 3)
  const md = createMarkdownRenderable({
    content: "anything",
    syntaxStyle,
    inlineHook: ([span]) => [
      { ...span!, text: "hi\r\n" },
      { ...span!, text: "@Known", target: "ses_a", attributes: TextAttributes.UNDERLINE },
      { ...span!, text: " plain" },
    ],
  })
  renderer.root.add(md)
  await renderOnce()
  expect(frameText()).toBe("hi\n@Known plain")
  expectTargets(md, () => "ses_a")
})

// OpenCode's split footer writes each committed block to scrollback once, so the rows of the committed blocks (with the
// gaps above them) must be those of a fresh render of the same text, and their count never goes down while the text
// grows. Generated answers repeat labels at top level and in quotes and lists, let quotes take lazy lines, and span
// labels and titles of each delimiter, with escapes, over blank lines (#2039). A definition that arrives after its use
// was committed re-inlines that block (N1 (a), next row), so the oracle is the same prefix, not the whole answer.
test("streamed, the rows of the committed blocks are those of a fresh render", async () => {
  resizeRenderer(60, 150)
  let seed = 1
  const random = (n: number) => ((seed = (Math.imul(seed, 48271) + 11) % 2147483647) >>> 0) % n
  const pick = <T>(items: T[]) => items[random(items.length)]!
  const rows = (end: number) =>
    captureFrame()
      .split("\n", end)
      .map((row) => row.trimEnd())
  const committedRows = (md: MarkdownRenderable) => {
    const last = md.getChildren()[md.committedBlockCount - 1]
    return rows(last ? last.y + last.height - md.y : 0)
  }
  const titles = [
    "",
    ' "t"',
    " (one\n\ntwo)",
    '\n"one\n\ntwo"',
    " 'one\n# two\nend'",
    ' "a\\\\" b\n\nc"',
    ' "a\\"\n\nb"',
  ]
  const generate = () => {
    const blocks = Array.from({ length: 3 + random(6) }, (_, i) => {
      const def = `[${pick(["x", "y", "one\n\ntwo", "m\\]n"])}]: ${pick(["/a", "<a b>"])}${pick(titles)}`
      const [quote, item] = [def.replaceAll("\n", "\n> "), def.replaceAll("\n", "\n  ")]
      return pick([def, def, `> ${quote}`, `- ${item}`, `> > ${quote}\nlazy`, `[z] in para ${i}`, `- [ ] task ${i}`])
    })
    return [...blocks, "END\n"].join("\n\n")
  }
  const failures: string[] = []
  // The first streams by characters: the lazy line hides the quote's definition among its children.
  const docs = ["> > [r]: /a\nlazy\n\nP\n\n> [r]: /b\n\nWorld\n\nEND\n"]
  for (let n = Number(process.env.MARKDOWN_TRANSCRIPT_DOCS ?? 24); n > 0; n--) docs.push(generate())
  for (const [index, doc] of docs.entries()) {
    for (const most of index ? [15, 15] : [1]) {
      const md = createMarkdownRenderable({ syntaxStyle, content: "", streaming: true })
      renderer.root.add(md)
      let committed = 0
      for (let at = 0; at < doc.length; ) {
        md.content = doc.slice(0, (at += 1 + random(most)))
        await renderOnce()
        const shown = committedRows(md)
        const lost = md.committedBlockCount < committed
        committed = md.committedBlockCount
        md.visible = false
        const fresh = createMarkdownRenderable({ syntaxStyle, content: md.content, streaming: true })
        renderer.root.add(fresh)
        await renderOnce()
        const expected = rows(shown.length)
        fresh.destroyRecursively()
        md.visible = true
        if (lost || JSON.stringify(shown) !== JSON.stringify(expected)) {
          failures.push(`${JSON.stringify(md.content)}\n${shown.join("|")}\n${expected.join("|")}`)
          break
        }
      }
      md.destroyRecursively()
    }
  }
  expect(failures).toEqual([])
})

test("a definition after a committed use re-inlines it; the committed count stays", async () => {
  const md = createMarkdownRenderable({ syntaxStyle, content: "See [y] here.\n\nNext\n\n", streaming: true })
  renderer.root.add(md)
  await renderOnce()
  expect(md.committedBlockCount).toBe(2)
  expect(frameText()).toBe("See [y] here.\n\nNext")
  md.content += "[y]: /a\n\nEnd\n"
  await renderOnce()
  expect(md.committedBlockCount).toBeGreaterThanOrEqual(2)
  expect(frameText()).toBe("See y (/a) here.\n\nNext\n\nEnd")
})

test("math extension: inline math reaches the hook and display math is a math code block", async () => {
  const seen: MarkdownInlineSpan[] = []
  const blocks: { lang?: string; text: string; closed: boolean }[] = []
  const md = createMarkdownRenderable({
    content: "Area $\\pi r^2$ and \\(a*b\\) cost $5.\n\n$$\nx^2\n$$\n",
    syntaxStyle,
    extensions: ["math"],
    inlineHook: (spans) => (seen.push(...spans), spans),
    renderBlock: createMarkdownCodeBlockRenderer({
      math: (block) => (blocks.push({ lang: block.lang, text: block.text, closed: block.closed }), null),
    }),
  })
  renderer.root.add(md)
  await renderOnce()
  expect(seen.filter((span) => span.math !== undefined).map((span) => span.math)).toEqual(["\\pi r^2", "a*b"])
  // A dollar with no closer stays text.
  expect(seen.some((span) => span.math === undefined && span.text.includes("$5."))).toBe(true)
  expect(blocks).toEqual([{ lang: "math", text: "x^2", closed: true }])
  // Display math without a renderer's result shows its TeX at once.
  expect(frameText()).toContain("x^2")

  // Without the extension, dollars are text and `$$` is a paragraph.
  seen.length = 0
  blocks.length = 0
  md.extensions = []
  await renderOnce()
  expect(seen.every((span) => span.math === undefined)).toBe(true)
  expect(blocks).toEqual([])
  expect(frameText()).toContain("$$")
})

test("math extension: an open display math block is not closed, even after the stream ends", async () => {
  const blocks: { text: string; closed: boolean }[] = []
  const md = createMarkdownRenderable({
    content: "$$\na+b\n",
    syntaxStyle,
    streaming: true,
    extensions: ["math"],
    renderBlock: createMarkdownCodeBlockRenderer({
      math: (block) => (blocks.push({ text: block.text, closed: block.closed }), null),
    }),
  })
  renderer.root.add(md)
  await renderOnce()
  md.content += "c\n"
  md.streaming = false
  await renderOnce()
  expect(blocks.at(-1)).toEqual({ text: "a+b\nc", closed: false })
  md.content = "$$\na+b\n$$\n"
  await renderOnce()
  expect(blocks.at(-1)).toEqual({ text: "a+b", closed: true })
})

const frameText = () =>
  captureFrame()
    .split("\n")
    .map((row) => row.trimEnd())
    .join("\n")
    .trimEnd()

test("inline hooks rewrite prose and table cells but not code or renderers", async () => {
  const calls: MarkdownInlineContext[] = []
  const md = createMarkdownRenderable({
    content: [
      "# Plan ses_known",
      "",
      "See ses_known, @session:ses_known and ses_other.",
      "",
      "- run `opencode -s ses_known` or `ses_known`",
      "",
      "> ses_known",
      "",
      "```",
      "ses_known",
      "```",
      "",
      "```mermaid",
      "ses_known",
      "```",
      "",
      "| `run ses_known` |",
      "| -- |",
      "| ses_known |",
    ].join("\n"),
    syntaxStyle,
    tableOptions: { style: "columns" },
    renderBlock: createMarkdownCodeBlockRenderer({
      mermaid: (block) => new TextRenderable(renderer, { content: `diagram ${block.text}` }),
    }),
    inlineHook: sessionLinks(new Map([["ses_known", "Known"]]), calls),
  })
  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  expect(frameText()).toBe(
    "Plan @Known\n\nSee @Known, @Known and ses_other.\n\n- run opencode -s ses_known or @Known\n\n│ @Known\n\n" +
      "ses_known\n\ndiagram ses_known\n\nrun ses_known\n@Known",
  )
  const prose = ["run `opencode -s ses_known` or `ses_known`", "ses_known"]
  // As in Rust: one call per block, and a heading's source is its text.
  const top = ["Plan ses_known", "See ses_known, @session:ses_known and ses_other."]
  expect(new Set(calls.map((call) => `${call.tableCell} ${call.source}`))).toEqual(
    new Set([...[...top, ...prose].map((source) => `false ${source}`), "true `run ses_known`", "true ses_known"]),
  )
})

test("rerunning the inline hook reaches only selected blocks and cells, and removing it restores them", async () => {
  const titles = new Map([
    ["ses_a", "A"],
    ["ses_b", "B"],
  ])
  const calls: MarkdownInlineContext[] = []
  const md = createMarkdownRenderable({
    content:
      "First ses_a\n\n## Head ses_a\n\nOther ses_b\n\n```\nses_a\n```\n\n- item ses_a\n\n| id |\n| -- |\n| ses_a |\n",
    syntaxStyle,
    streaming: true,
    tableOptions: { style: "columns" },
  })
  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  const plain = frameText()
  // Without a hook a rerun marks no block for a new highlight.
  const dirty = (node: Renderable): boolean => Reflect.get(node, "_highlightsDirty") || node.getChildren().some(dirty)
  md.rerunInlineHook(() => true)
  expect(dirty(md)).toBe(false)

  md.inlineHook = sessionLinks(titles, calls)
  await renderMarkdownRenderable(md)
  const shown = (a: string, b = "@B") => [`First ${a}`, `Head ${a}`, `Other ${b}`, "ses_a", `- item ${a}`, `id\n${a}`]
  expect(plain).toBe(shown("ses_a", "ses_b").join("\n\n"))
  expect(frameText()).toBe(shown("@A").join("\n\n"))
  // A streamed row's cells go through the hook as they arrive (its line ends, so it is not held).
  md.content += "| ses_a too |\n"
  await renderMarkdownRenderable(md)
  expect(frameText()).toBe(shown("@A").join("\n\n") + "\n@A too")

  titles.set("ses_a", "Z")
  calls.length = 0
  md.rerunInlineHook((source) => source.includes("ses_a"))
  await renderMarkdownRenderable(md)
  expect(frameText()).toBe(shown("@Z").join("\n\n") + "\n@Z too")
  expect(calls.map((call) => `${call.tableCell} ${call.source}`).sort()).toEqual([
    "false First ses_a",
    "false Head ses_a",
    "false item ses_a",
    "true id",
    "true ses_a",
    "true ses_a too",
  ])
  // The predicate sees a heading's text, as the hook does.
  calls.length = 0
  md.rerunInlineHook((source) => source === "Head ses_a")
  await renderMarkdownRenderable(md)
  expect(calls.map((call) => call.source)).toEqual(["Head ses_a"])

  // Another hook runs on the same blocks at once.
  md.inlineHook = sessionLinks(new Map([["ses_a", "Q"]]))
  await renderMarkdownRenderable(md)
  expect(frameText()).toContain("First @Q")

  md.inlineHook = undefined
  await renderMarkdownRenderable(md)
  expect(frameText()).toBe(plain + "\nses_a too")
})

test.each([true, false])("inline hooks keep the frames and see the mode with conceal %p", async (conceal) => {
  const content = [
    "# Head *em* `code` ses_known ##",
    "See [docs](https://e.x) and https://bare.example/x, **bold** \\*esc\\* `ses_known` ses_known.",
    "",
    "Second paragraph",
    "Setext ses_known",
    "---",
    "Tight after heading",
    "",
    "",
    "Two blank lines above",
    "",
    "> quote [l](https://q.x)",
    "",
    "- item `x`",
    "",
    "| a | b |",
    "| - | - |",
    "| `c` | [d](https://d.x) |",
  ].join("\n")
  const frames: string[] = []
  const calls: MarkdownInlineContext[] = []
  for (const inlineHook of [
    undefined,
    (spans: MarkdownInlineSpan[]) => spans,
    sessionLinks(new Map([["ses_known", "K"]]), calls),
  ]) {
    const md = createMarkdownRenderable({ content, syntaxStyle, conceal, inlineHook })
    renderer.root.add(md)
    await renderMarkdownRenderable(md)
    frames.push(frameText())
    md.destroyRecursively()
  }
  // An identity hook changes nothing; without conceal the session hook keeps the source text.
  expect(frames[1]).toBe(frames[0])
  expect(frames[2]).toBe(conceal ? frames[0].replaceAll("ses_known", "@K") : frames[0])
  expect(calls.every((call) => call.conceal === conceal && call.syntaxStyle === syntaxStyle)).toBe(true)
  // A heading's source is its text, without its markers or a setext underline.
  const sources = calls.map((call) => call.source)
  expect(sources).toContain("Head *em* `code` ses_known")
  expect(sources).toContain("Second paragraph\nSetext ses_known")
})

test("inlineHookFilter limits the hook to blocks and cells that hold one of its strings", async () => {
  // As OpenCode runs it: the terminal shows links, so the engine writes the leaves the hook does not rewrite.
  setRendererCapabilities(renderer, { hyperlinks: true })
  const calls: MarkdownInlineContext[] = []
  const md = createMarkdownRenderable({
    content: "plain\n\nsee ses_a\n\n| id | x |\n| -- | - |\n| ses_a | y |",
    syntaxStyle,
    inlineHook: sessionLinks(new Map([["ses_a", "A"]]), calls),
    inlineHookFilter: ["ses_"],
  })
  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  expect(calls.map((call) => call.source).sort()).toEqual(["see ses_a", "ses_a"])
  expect(frameText()).toContain("see @A")

  calls.length = 0
  md.inlineHookFilter = ["plain"]
  await renderMarkdownRenderable(md)
  expect(calls.map((call) => call.source)).toEqual(["plain"])
  expect(frameText()).toContain("see ses_a")

  // An empty filter selects no block; no filter selects every block.
  calls.length = 0
  md.inlineHookFilter = []
  await renderMarkdownRenderable(md)
  expect(calls).toEqual([])
  expect(frameText()).toContain("see ses_a")
})

// Model seed 1188 of 10,000: a pending line's code span is decided when its paragraph closes; only the span's flag
// changes, and the hook must see it.
test("the hook runs again when only a span's kind changes", async () => {
  const seen: [string, boolean][] = []
  const md = createMarkdownRenderable({
    // Trimmed, as OpenCode does: the pending and the closed paragraph hold the same characters.
    content: "> `ses_a`",
    syntaxStyle,
    streaming: true,
    conceal: false,
    inlineHook: (spans, context) => (seen.push([context.source, spans.some((span) => span.code)]), spans),
  })
  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  md.content += "\n\nafter"
  await renderMarkdownRenderable(md)
  expect(seen.filter(([source]) => source.startsWith("`"))).toEqual([
    ["`ses_a`", false],
    ["`ses_a`", true],
  ])
})

test("hooked and host-written text takes a new style, and header cells keep what the hook returns", async () => {
  setRendererCapabilities(renderer, { hyperlinks: true })
  const [red, green] = [RGBA.fromInts(255, 0, 0, 255), RGBA.fromInts(0, 255, 0, 255)]
  const theme = (link: RGBA) =>
    SyntaxStyle.fromStyles(
      { default: { fg: RGBA.fromValues(1, 1, 1, 1) }, "markup.link.url": { fg: link } },
      renderer.nativeScene!,
    )
  const [first, second] = [theme(red), theme(green)]
  // As OpenCode's session links: the target's color comes from the style the hook is given.
  const hook: MarkdownInlineHook = (spans, context) =>
    spans.map((span) =>
      span.text.includes("ses_a")
        ? { ...span, fg: context.syntaxStyle.getStyle("markup.link.url")?.fg, attributes: TextAttributes.UNDERLINE }
        : span,
    )
  const md = createMarkdownRenderable({
    content: "see ses_a now\n\n| ses_a |\n| - |\n| ses_a |",
    syntaxStyle: first,
    inlineHook: hook,
  })
  renderer.root.add(md)
  await renderMarkdownRenderable(md)
  const colors = () =>
    captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => span.text.includes("ses_a"))
      .map((span) => [span.fg.toInts(), span.attributes & TextAttributes.UNDERLINE])
  expect(colors()).toEqual(Array(3).fill([red.toInts(), TextAttributes.UNDERLINE]))
  md.syntaxStyle = second
  await renderMarkdownRenderable(md)
  expect(colors()).toEqual(Array(3).fill([green.toInts(), TextAttributes.UNDERLINE]))
  // Only the hook reads this definition, so refreshStyles() runs it again.
  second.registerStyle("markup.link.url", { fg: red })
  md.refreshStyles()
  await renderOnce()
  expect(colors()[0]).toEqual([red.toInts(), TextAttributes.UNDERLINE])

  // A definition registered on the same style shows after refreshStyles(), on text the host writes too.
  setRendererCapabilities(renderer, { hyperlinks: false })
  md.inlineHook = undefined
  md.content = "**bold**"
  await renderMarkdownRenderable(md)
  second.registerStyle("markup.strong", { fg: red, bold: true })
  md.refreshStyles()
  await renderOnce()
  expect(findSpanContaining(captureSpans(), "bold")?.fg?.toInts()).toEqual(red.toInts())
  md.destroyRecursively()
  first.destroy()
  second.destroy()
})

// A worker whose replies a test releases one by one, in any order. Its grammar conceals heading markers and the
// delimiters of `*x*` and code spans, as the Markdown grammar does, so previews and highlights draw the same text.
class FakeWorker extends TreeSitterClient {
  pending: { content: string; resolve: (result: { highlights: SimpleHighlight[] }) => void; reject: () => void }[] = []

  constructor() {
    super({ dataPath: join(tmpdir(), "markdown-fake-worker") }, { autoStartWorker: false })
  }

  override async highlightOnce(content: string) {
    const { promise, resolve, reject } = Promise.withResolvers<{ highlights: SimpleHighlight[] }>()
    this.pending.push({ content, resolve, reject: () => reject(new Error("worker failed")) })
    return promise
  }

  // A streamed fence appends to a copy the worker keeps; the reply covers the whole copy.
  private copies = new Map<number, string>()
  override async highlightAppend(id: number, offset: number, text: string) {
    this.copies.set(id, (this.copies.get(id) ?? "").slice(0, offset) + text)
    return this.highlightOnce(this.copies.get(id)!)
  }

  reply(index = 0) {
    const [item] = this.pending.splice(index, 1)
    if (!item) return
    const highlights: SimpleHighlight[] = []
    // Heading markers take their space with them; inline delimiters come from the injected inline grammar.
    for (const match of item.content.matchAll(/^#{1,6}(?= )|\*(?=\w+\*)|(?<=\*\w+)\*|`(?=[^`\n]+`)|(?<=`[^`\n]+)`/gm)) {
      const meta = { conceal: "", isInjection: match[0][0] !== "#" }
      highlights.push([match.index, match.index + match[0].length, "conceal", meta])
    }
    for (const match of item.content.matchAll(/`[^`\n]+`/g)) {
      highlights.push([match.index, match.index + match[0].length, "markup.raw", {}])
    }
    item.resolve({ highlights })
  }

  fail(index = 0) {
    this.pending.splice(index, 1)[0]?.reject()
  }
}

// A theme change on a finished fence (a CodeRenderable) keeps its painted highlight and height while the worker
// restyles it, never raw or blank, and the reply brings the new colors.
test("a theme change keeps a finished fence's highlight until the new one lands", async () => {
  const worker = new FakeWorker()
  const theme = (fg: RGBA) =>
    SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) }, "markup.raw": { fg } }, renderer.nativeScene)
  const [first, second] = [theme(RGBA.fromValues(1, 0, 0, 1)), theme(RGBA.fromValues(0, 0, 1, 1))]
  const md = createMarkdownRenderable({
    content: "```md\nrun `x` now\n```",
    syntaxStyle: first,
    streaming: true,
    treeSitterClient: worker,
  })
  renderer.root.add(md)
  const settle = async () => {
    for (let pass = 0; pass < 3; pass++) {
      await renderOnce()
      while (worker.pending.length > 0) worker.reply()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderOnce()
  }
  await settle()
  md.streaming = false
  await settle()
  const painted = () =>
    captureSpans().lines.map((line) => line.spans.map((span) => [span.text, span.fg.toInts()].join(" ")).join("|"))
  const before = painted()
  const height = md.height
  expect(findSpanContaining(captureSpans(), "x")?.fg?.toInts()).toEqual(RGBA.fromValues(1, 0, 0, 1).toInts())
  md.syntaxStyle = second
  await renderOnce()
  expect([painted(), md.height, worker.pending.length > 0]).toEqual([before, height, true])
  await settle()
  expect(findSpanContaining(captureSpans(), "x")?.fg?.toInts()).toEqual(RGBA.fromValues(0, 0, 1, 1).toInts())
  md.destroyRecursively()
  first.destroy()
  second.destroy()
})

// A finished block never falls back to unhooked text: the hook's output stays through the end of the stream and later
// appends (the engine writes no unhooked prose for a hooked leaf).
test("a finished block keeps the hooked text", async () => {
  const titles = new Map<string, string>()
  const md = createMarkdownRenderable({
    content: "see ses_alpha `ses_alpha` `run ses_alpha`",
    syntaxStyle,
    streaming: true,
    inlineHook: sessionLinks(titles),
  })
  renderer.root.add(md)
  await renderOnce()
  expect(frameText()).toBe("see ses_alpha ses_alpha run ses_alpha")
  // The title arrives later; an exact-ID code span links, a longer one does not.
  titles.set("ses_alpha", "Title")
  md.rerunInlineHook(() => true)
  await renderOnce()
  expect(frameText()).toBe("see @Title @Title run ses_alpha")
  md.streaming = false
  await renderOnce()
  expect(frameText()).toBe("see @Title @Title run ses_alpha")
  titles.set("ses_alpha", "Again")
  md.content += "!"
  await renderOnce()
  expect(frameText()).toBe("see @Again @Again run ses_alpha!")
})

test("list and quote children keep their text when their kind or the stream changes", async () => {
  const worker = new FakeWorker()
  const md = createMarkdownRenderable({
    content: "> # Title\n> - - -",
    syntaxStyle,
    streaming: true,
    treeSitterClient: worker,
  })
  renderer.root.add(md)
  const frames: string[] = []
  const settle = async () => {
    await renderOnce()
    while (worker.pending.length > 0) worker.reply()
    await flushAsync()
    await renderOnce()
    frames.push(frameText())
  }
  await settle()
  // The rule becomes a list; the heading above keeps its text.
  md.content += " x"
  await settle()
  md.streaming = false
  await renderOnce()
  frames.push(frameText())
  // The pending "- - -" may still be a rule or a list, so it waits for its line (D93 B).
  expect(frames).toEqual(["│ Title", "│ Title\n│\n│ - - - x", "│ Title\n│\n│ - - - x"])
})

// A streamed block draws in its first frame what it settles to, so every frame equals the settled one; the engine reads
// escapes and code span padding as CommonMark does (`\$` is `$`; one space is stripped from both ends of a code span).
const sameHook = { inlineHook: sessionLinks(new Map([["ses_known", "K"]])) }
test.each([
  ["Pay _now_$5X", 10],
  ["$x$_ok_ tail", 20],
  ["price $5 and *important* or [docs](https://e.x) for $6 today", 40],
  ["a *b*$5 and _c_ $6_d_ end", 20],
  ["see **$x$** here", 20],
  ["\\$5 and *x* and \\$6 and $7", 40],
  ["Costs $5; check `$PATH/$HOME` *now*", 40],
  ["a $1 b $2 *c* d $3 e", 40],
  ["Pay *\\$5 now*", 40],
  ["Pay \\$5 and \\*x\\*", 40, {}, "Pay $5 and *x*"],
  ["see `` ses_known `` and ` x ` tail", 40, sameHook, "see @K and x tail"],
  ["see `` ses_known `` and ` x ` tail", 40, { ...sameHook, conceal: false }, "see `` ses_known `` and ` x ` tail"],
  ["# Head *x*\n\ntext", 40, { conceal: false }],
  ["# Notes\n\ntext *x*", 40, {}, "Notes\n\ntext x"],
  ["# A ses_known\nB\n\nC\nD\n\n\nE", 40, sameHook, "A @K\n\nB\n\nC\nD\n\nE"],
  // An open item with a blank line between its blocks is loose before its list closes, as in Rust.
  ["- para 1\n\n  para 2\n", 40, {}, "- para 1\n\n  para 2"],
] as [string, number, Partial<MarkdownOptions>?, string?][])(
  "streamed %j draws its settled text in every frame",
  // A rest parameter: Bun passes a done callback to a callback with more parameters than a row has values.
  async (...[content, width, options, expected]) => {
    const recorder = new TestRecorder(renderer)
    recorder.rec()
    const md = createMarkdownRenderable({
      content,
      syntaxStyle,
      streaming: true,
      width,
      ...options,
    })
    renderer.root.add(md)
    await renderMarkdownRenderable(md)
    recorder.stop()
    const rows = (frame: string) =>
      frame
        .split("\n")
        .map((row) => row.trimEnd())
        .join("\n")
        .trimEnd()
    expect(new Set(recorder.recordedFrames.map((recorded) => rows(recorded.frame)))).toEqual(new Set([frameText()]))
    if (expected !== undefined) expect(frameText()).toBe(expected)
  },
)

test.each(["", "> "])(
  "with a hook, a header-only table is a table and its empty cells reach the hook (%j)",
  async (quote) => {
    const hook: MarkdownInlineHook = (spans, context) => {
      if (!context.tableCell) return spans
      if (context.source === "") return [{ text: "EMPTY", code: false }]
      return spans.map((span) => ({ ...span, text: span.text.toUpperCase() }))
    }
    const md = createMarkdownRenderable({
      content: `${quote}| key |  |\n`,
      syntaxStyle,
      streaming: true,
      tableOptions: { style: "columns" },
      inlineHook: hook,
    })
    renderer.root.add(md)
    await renderOnce()
    const bar = quote ? "│ " : ""
    md.content += `${quote}|--|--|\n`
    await renderOnce()
    expect(frameText()).toBe(`${bar}KEY  EMPTY`)
    md.content += `${quote}| x | |\n`
    await renderOnce()
    expect(frameText()).toBe(`${bar}KEY  EMPTY\n${bar}X    EMPTY`)
  },
)

// The setext heading becomes a paragraph and a list when the last text arrives with the end of the stream.
test.each([0])("a block that changes kind as the stream ends draws at once", async () => {
  const worker = new FakeWorker()
  const md = createMarkdownRenderable({
    content: "Intro.\n\nword word\nsee it\n-",
    syntaxStyle,
    streaming: true,
    treeSitterClient: worker,
  })
  renderer.root.add(md)
  const settle = async () => {
    for (let pass = 0; pass < 4; pass++) {
      await renderOnce()
      while (worker.pending.length > 0) worker.reply()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await renderOnce()
  }
  await settle()
  md.content += " word"
  md.streaming = false
  await renderOnce()
  const finished = frameText()
  await settle()
  expect(finished).toBe(frameText())
})
