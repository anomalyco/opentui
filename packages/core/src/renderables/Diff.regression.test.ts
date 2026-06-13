import { test, expect, beforeEach, afterEach } from "bun:test"
import { DiffRenderable } from "./Diff.js"
import { SyntaxStyle } from "../syntax-style.js"
import { RGBA } from "../lib/RGBA.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"
import { ManualClock } from "../testing/manual-clock.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import type { SimpleHighlight } from "../lib/tree-sitter/types.js"
import { BoxRenderable } from "./Box.js"
import { settleDiffHighlighting } from "./__tests__/renderable-test-utils.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let captureFrame: () => string
let mockClient: MockTreeSitterClient
let clock: ManualClock

beforeEach(async () => {
  mockClient = new MockTreeSitterClient()
  clock = new ManualClock()

  const testRenderer = await createTestRenderer({
    width: 32,
    height: 10,
    gatherStats: true,
    clock,
  })
  currentRenderer = testRenderer.renderer
  renderOnce = testRenderer.renderOnce
  captureFrame = testRenderer.captureCharFrame
})

afterEach(async () => {
  if (currentRenderer) {
    currentRenderer.destroy()
  }
  if (mockClient) {
    mockClient.resolveAllHighlightOnce()
    await mockClient.destroy()
  }
})

// When highlights conceal formatting characters (like **), line lengths change,
// potentially triggering wrapping changes, height changes, and onResize.
// This test ensures onResize doesn't cause content resets that create endless loops.
test("DiffRenderable - no endless loop when concealing markdown formatting", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const markdownDiff = `--- a/test.md
+++ b/test.md
@@ -1,2 +1,2 @@
-Some text **boldtext**
-Short
+Some text **boldtext**
+More text **formats**`

  const mockHighlights: SimpleHighlight[] = [
    [10, 11, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [11, 12, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [20, 21, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [21, 22, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [33, 34, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [34, 35, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [42, 43, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [43, 44, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
  ]

  mockClient.setMockResult({ highlights: mockHighlights })

  const box = new BoxRenderable(currentRenderer, {
    id: "background-box",
    border: true,
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: markdownDiff,
    syntaxStyle,
    filetype: "markdown",
    conceal: true,
    treeSitterClient: mockClient,
  })

  box.add(diffRenderable)
  currentRenderer.root.add(box)

  await renderOnce()
  diffRenderable.view = "split"

  await renderOnce()
  diffRenderable.wrapMode = "word"

  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  const stats = currentRenderer.getStats()
  expect(stats.frameCount).toBeLessThan(25)
})

// Tests that line numbers align correctly and gutter heights are properly sized
// when switching between view modes and wrap modes in split view
test("DiffRenderable - line number alignment and gutter heights in split view with wrapping", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const markdownDiff = `--- a/test.md
+++ b/test.md
@@ -1,2 +1,2 @@
-Some text **boldtext**
-Short
+Some text **boldtext**
+More text **formats**`

  const mockHighlights: SimpleHighlight[] = [
    [10, 11, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [11, 12, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [20, 21, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [21, 22, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [33, 34, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [34, 35, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [42, 43, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
    [43, 44, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }],
  ]

  mockClient.setMockResult({ highlights: mockHighlights })

  const box = new BoxRenderable(currentRenderer, {
    id: "background-box",
    border: true,
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: markdownDiff,
    syntaxStyle,
    filetype: "markdown",
    conceal: true,
    treeSitterClient: mockClient,
  })

  box.add(diffRenderable)
  currentRenderer.root.add(box)

  await renderOnce()
  const unifiedFrame = captureFrame()

  expect(unifiedFrame).toContain("1 - Some text")
  expect(unifiedFrame).toContain("2 - Short")
  expect(unifiedFrame).toContain("1 + Some text")
  expect(unifiedFrame).toContain("2 + More text")

  diffRenderable.view = "split"
  await renderOnce()
  const splitFrame = captureFrame()

  expect(splitFrame).toContain("1 - Some text")
  expect(splitFrame).toContain("1 + Some text")
  expect(splitFrame).toContain("2 - Short")
  expect(splitFrame).toContain("2 + More text")

  // First wrapMode toggle: none → word
  diffRenderable.wrapMode = "word"
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)
  const splitWrapFrame = captureFrame()

  const diffChildren = diffRenderable.getChildren()
  const lines = splitWrapFrame.split("\n")

  let leftLine2Row = -1
  let rightLine2Row = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes("2 - Short")) {
      leftLine2Row = i
    }
    if (line.includes("2 + More")) {
      rightLine2Row = i
    }
  }

  expect(leftLine2Row).toBeGreaterThan(-1)
  expect(rightLine2Row).toBeGreaterThan(-1)
  expect(leftLine2Row).toBe(rightLine2Row)
  const leftSide = diffChildren[0]
  const rightSide = diffChildren[1]
  const leftGutter = leftSide.getChildren()[0]
  const rightGutter = rightSide.getChildren()[0]
  const leftCode = leftSide.getChildren()[1]
  const rightCode = rightSide.getChildren()[1]

  const leftVisualLines = (leftCode as any).lineInfo?.lineSources?.length || 0
  const rightVisualLines = (rightCode as any).lineInfo?.lineSources?.length || 0

  expect(leftVisualLines).toBe(rightVisualLines)
  expect(leftGutter.height).toBe(leftVisualLines)
  expect(rightGutter.height).toBe(rightVisualLines)

  // Second wrapMode toggle: word → none → word
  diffRenderable.wrapMode = "none"
  await renderOnce()
  diffRenderable.wrapMode = "word"
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)
  const splitWrapFrame2 = captureFrame()
  const lines2 = splitWrapFrame2.split("\n")
  let leftLine2Row2 = -1
  let rightLine2Row2 = -1

  for (let i = 0; i < lines2.length; i++) {
    const line = lines2[i]
    if (line.includes("2 - Short")) {
      leftLine2Row2 = i
    }
    if (line.includes("2 + More")) {
      rightLine2Row2 = i
    }
  }

  expect(leftLine2Row2).toBeGreaterThan(-1)
  expect(rightLine2Row2).toBeGreaterThan(-1)
  expect(leftLine2Row2).toBe(rightLine2Row2)

  expect(splitWrapFrame2).toContain("1 - Some text")
  expect(splitWrapFrame2).toContain("boldtext")
  expect(splitWrapFrame2).toContain("2 - Short")
  expect(splitWrapFrame2).toContain("2 + More text")
  expect(splitWrapFrame2).toContain("formats")
})

test("DiffRenderable - hunk row offsets account for concealed markdown lines", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const markdownDiff = `--- a/test.md
+++ b/test.md
@@ -1,3 +1,3 @@
 \`\`\`ts
-const old = 1
+const new = 1
 \`\`\`
@@ -10,2 +10,2 @@
-second old
+second new
 tail`

  const content = "```ts\nconst old = 1\nconst new = 1\n```\nsecond old\nsecond new\ntail"
  const mockHighlights: SimpleHighlight[] = [
    [0, 5, "markup.raw.block", { conceal: "", concealLines: "" }],
    [content.indexOf("```", 5), content.indexOf("```", 5) + 3, "markup.raw.block", { conceal: "", concealLines: "" }],
  ]

  mockClient.setMockResult({ highlights: mockHighlights })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: markdownDiff,
    syntaxStyle,
    filetype: "markdown",
    conceal: true,
    treeSitterClient: mockClient,
  })

  currentRenderer.root.add(diffRenderable)
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 2])

  const splitContent = "```ts\nconst old = 1\n```\nsecond old\ntail"
  mockClient.setMockResult({
    highlights: [
      [0, 5, "markup.raw.block", { conceal: "", concealLines: "" }],
      [
        splitContent.indexOf("```", 5),
        splitContent.indexOf("```", 5) + 3,
        "markup.raw.block",
        {
          conceal: "",
          concealLines: "",
        },
      ],
    ],
  })
  diffRenderable.view = "split"
  diffRenderable.wrapMode = "none"
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 1])
})

test("DiffRenderable - hunk row offsets map concealed hunk starts to the next visible line", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })
  const fenceHighlights = (content: string): SimpleHighlight[] => {
    const highlights: SimpleHighlight[] = []
    let start = content.indexOf("```")

    while (start !== -1) {
      const end = content.startsWith("```ts", start) ? start + 5 : start + 3
      highlights.push([start, end, "markup.raw.block", { conceal: "", concealLines: "" }])
      start = content.indexOf("```", end)
    }

    return highlights
  }

  const markdownDiff = `--- a/test.md
+++ b/test.md
@@ -1,3 +1,3 @@
 \`\`\`ts
-first old
+first new
 \`\`\`
@@ -10,3 +10,3 @@
 \`\`\`ts
-second old
+second new
 \`\`\``

  const content = "```ts\nfirst old\nfirst new\n```\n```ts\nsecond old\nsecond new\n```"
  mockClient.setMockResult({ highlights: fenceHighlights(content) })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: markdownDiff,
    syntaxStyle,
    filetype: "markdown",
    conceal: true,
    treeSitterClient: mockClient,
  })

  currentRenderer.root.add(diffRenderable)
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 2])

  const splitContent = "```ts\nfirst old\n```\n```ts\nsecond old\n```"
  mockClient.setMockResult({ highlights: fenceHighlights(splitContent) })

  diffRenderable.view = "split"
  diffRenderable.wrapMode = "none"
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 1])
})

test("DiffRenderable - hunk row offsets account for multiline concealed ranges", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diff = `--- a/test.txt
+++ b/test.txt
@@ -1,2 +1,2 @@
 a
-b
+c
@@ -10,1 +10,1 @@
 d`

  mockClient.setMockResult({
    highlights: [[0, 3, "conceal", { conceal: "", concealLines: "" }]],
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff,
    syntaxStyle,
    filetype: "text",
    conceal: true,
    treeSitterClient: mockClient,
  })

  currentRenderer.root.add(diffRenderable)
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 1])
})
