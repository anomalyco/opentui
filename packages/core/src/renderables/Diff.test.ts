import { test, expect, beforeEach, afterEach } from "bun:test"
import { DiffRenderable } from "./Diff.js"
import { SyntaxStyle } from "../syntax-style.js"
import { RGBA, parseColor } from "../lib/RGBA.js"
import { createMockMouse, createTestRenderer, type TestRenderer } from "../testing.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import type { SimpleHighlight } from "../lib/tree-sitter/types.js"
import { settleDiffHighlighting } from "./__tests__/renderable-test-utils.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let captureFrame: () => string

beforeEach(async () => {
  const testRenderer = await createTestRenderer({ width: 80, height: 20 })
  currentRenderer = testRenderer.renderer
  renderOnce = testRenderer.renderOnce
  captureFrame = testRenderer.captureCharFrame
})

afterEach(async () => {
  if (currentRenderer) {
    currentRenderer.destroy()
  }
})

const simpleDiff = `--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 function hello() {
-  console.log("Hello");
+  console.log("Hello, World!");
 }`

const multiLineDiff = `--- a/math.js
+++ b/math.js
@@ -1,7 +1,11 @@
 function add(a, b) {
   return a + b;
 }
 
+function subtract(a, b) {
+  return a - b;
+}
+
 function multiply(a, b) {
-  return a * b;
+  return a * b * 1;
 }`

const addOnlyDiff = `--- a/new.js
+++ b/new.js
@@ -0,0 +1,3 @@
+function newFunction() {
+  return true;
+}`

const removeOnlyDiff = `--- a/old.js
+++ b/old.js
@@ -1,3 +0,0 @@
-function oldFunction() {
-  return false;
-}`

const largeDiff = `--- a/large.js
+++ b/large.js
@@ -42,9 +42,10 @@
 const line42 = 'context';
 const line43 = 'context';
-const line44 = 'removed';
+const line44 = 'added';
 const line45 = 'context';
+const line46 = 'added';
 const line47 = 'context';
 const line48 = 'context';
-const line49 = 'removed';
+const line49 = 'changed';
 const line50 = 'context';
 const line51 = 'context';`

test("DiffRenderable - basic construction with unified view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
  })

  expect(diffRenderable.diff).toBe(simpleDiff)
  expect(diffRenderable.view).toBe("unified")
})

test("DiffRenderable - basic construction with split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
  })

  expect(diffRenderable.diff).toBe(simpleDiff)
  expect(diffRenderable.view).toBe("split")
})

test("DiffRenderable - defaults to unified view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    syntaxStyle,
  })

  expect(diffRenderable.view).toBe("unified")
})

test("DiffRenderable - unified view renders correctly", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("unified view simple diff")

  // Check that both removed and added lines are present
  expect(frame).toContain('console.log("Hello")')
  expect(frame).toContain('console.log("Hello, World!")')
})

test("DiffRenderable - split view renders correctly", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view simple diff")

  // In split view, both sides should be visible (may be wrapped)
  expect(frame).toContain("console.log")
  expect(frame).toContain("Hello")
  expect(frame).toContain("World")
})

test("DiffRenderable - multi-line diff unified view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: multiLineDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("unified view multi-line diff")

  // Check for additions
  expect(frame).toContain("function subtract")
  // Check for modifications
  expect(frame).toContain("a * b * 1")
})

test("DiffRenderable - multi-line diff split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: multiLineDiff,
    view: "split",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view multi-line diff")

  // Left side should have old code
  expect(frame).toContain("a * b")
  // Right side should have new code
  expect(frame).toContain("subtract")
})

test("DiffRenderable - add-only diff unified view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: addOnlyDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("unified view add-only diff")

  expect(frame).toContain("newFunction")
})

test("DiffRenderable - add-only diff split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: addOnlyDiff,
    view: "split",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view add-only diff")

  // Right side should have the new function
  expect(frame).toContain("newFunction")
})

test("DiffRenderable - remove-only diff unified view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: removeOnlyDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("unified view remove-only diff")

  expect(frame).toContain("oldFunction")
})

test("DiffRenderable - remove-only diff split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: removeOnlyDiff,
    view: "split",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view remove-only diff")

  // Left side should have the old function
  expect(frame).toContain("oldFunction")
})

test("DiffRenderable - large line numbers displayed correctly", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: largeDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("unified view large line numbers")

  // Check that line numbers in the 40s are displayed
  expect(frame).toMatch(/4[0-9]/)
})

test("DiffRenderable - can toggle view mode", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const unifiedFrame = captureFrame()
  expect(diffRenderable.view).toBe("unified")

  // Switch to split view
  diffRenderable.view = "split"
  await renderOnce()

  const splitFrame = captureFrame()
  expect(diffRenderable.view).toBe("split")

  // Frames should be different
  expect(unifiedFrame).not.toBe(splitFrame)
})

test("DiffRenderable - can update diff content", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame1 = captureFrame()
  expect(frame1).toContain("Hello")

  // Update diff
  diffRenderable.diff = multiLineDiff
  await renderOnce()

  const frame2 = captureFrame()
  expect(frame2).toContain("subtract")
  expect(frame2).not.toContain('console.log("Hello")')
})

test("DiffRenderable - can toggle line numbers", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  expect(diffRenderable.showLineNumbers).toBe(true)

  // Hide line numbers
  diffRenderable.showLineNumbers = false
  await renderOnce()

  expect(diffRenderable.showLineNumbers).toBe(false)
})

test("DiffRenderable - can update filetype", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
    keyword: { fg: RGBA.fromValues(1, 0, 0, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    filetype: "javascript",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  expect(diffRenderable.filetype).toBe("javascript")

  // Update filetype
  diffRenderable.filetype = "typescript"
  expect(diffRenderable.filetype).toBe("typescript")
})

test("DiffRenderable - handles empty diff", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: "",
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Should not crash with empty diff
  expect(diffRenderable.diff).toBe("")
})

test("DiffRenderable - handles diff with no changes", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const noChangeDiff = `--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 function hello() {
   console.log("Hello");
 }`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: noChangeDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toContain("function hello")
})

test("DiffRenderable - can update wrapMode", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    wrapMode: "word",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  expect(diffRenderable.wrapMode).toBe("word")

  diffRenderable.wrapMode = "char"
  expect(diffRenderable.wrapMode).toBe("char")
})

test("DiffRenderable - split view alignment with empty lines", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  // Diff with additions that should create empty lines on left
  const alignmentDiff = `--- a/test.js
+++ b/test.js
@@ -1,2 +1,5 @@
 line1
+line2_added
+line3_added
+line4_added
 line5`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: alignmentDiff,
    view: "split",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view alignment")

  // Both sides should have same number of lines (with empty lines for alignment)
  expect(frame).toContain("line1")
  expect(frame).toContain("line5")
  expect(frame).toContain("line2_added")
})

test("DiffRenderable - context lines shown on both sides in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: multiLineDiff,
    view: "split",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()

  // Context lines should appear on both sides
  expect(frame).toContain("function add")
  expect(frame).toContain("function multiply")
})

test("DiffRenderable - custom colors applied correctly", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    addedBg: "#00ff00",
    removedBg: "#ff0000",
    addedSignColor: "#00ff00",
    removedSignColor: "#ff0000",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Should not crash with custom colors
  const frame = captureFrame()
  expect(frame).toContain('console.log("Hello")')
})

test("DiffRenderable - line number fg/bg colors update after construction", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    lineNumberFg: "#445566",
    lineNumberBg: "#101820",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const findCharPosition = (char: string): { x: number; y: number } | null => {
    const buffer = currentRenderer.currentRenderBuffer
    const charBuffer = buffer.buffers.char
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined) return null

    for (let y = 0; y < buffer.height; y++) {
      for (let x = 0; x < buffer.width; x++) {
        if (charBuffer[y * buffer.width + x] === codePoint) {
          return { x, y }
        }
      }
    }

    return null
  }

  const getColorAt = (channel: "fg" | "bg", x: number, y: number) => {
    const buffer = currentRenderer.currentRenderBuffer
    const colorBuffer = channel === "fg" ? buffer.buffers.fg : buffer.buffers.bg
    const offset = (y * buffer.width + x) * 4

    return {
      r: (colorBuffer[offset] & 0xff) / 255,
      g: (colorBuffer[offset + 1] & 0xff) / 255,
      b: (colorBuffer[offset + 2] & 0xff) / 255,
      a: (colorBuffer[offset + 3] & 0xff) / 255,
    }
  }

  const expectColorClose = (
    actual: { r: number; g: number; b: number; a: number },
    expected: { r: number; g: number; b: number; a: number },
  ) => {
    expect(actual.r).toBeCloseTo(expected.r, 2)
    expect(actual.g).toBeCloseTo(expected.g, 2)
    expect(actual.b).toBeCloseTo(expected.b, 2)
    expect(actual.a).toBeCloseTo(expected.a, 2)
  }

  const initialPos = findCharPosition("1")
  expect(initialPos).not.toBeNull()
  expectColorClose(getColorAt("fg", initialPos!.x, initialPos!.y), parseColor("#445566"))
  expectColorClose(getColorAt("bg", initialPos!.x, initialPos!.y), parseColor("#101820"))

  diffRenderable.lineNumberFg = "#ff00ff"
  diffRenderable.lineNumberBg = "#2a2a2a"
  await renderOnce()

  const updatedPos = findCharPosition("1")
  expect(updatedPos).not.toBeNull()
  expectColorClose(getColorAt("fg", updatedPos!.x, updatedPos!.y), parseColor("#ff00ff"))
  expectColorClose(getColorAt("bg", updatedPos!.x, updatedPos!.y), parseColor("#2a2a2a"))
})

test("DiffRenderable - line numbers hidden for empty alignment lines in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: addOnlyDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view with hidden line numbers for empty lines")

  // Right side should have line numbers for new lines
  // Left side should have empty lines without line numbers
})

test("DiffRenderable - stable rendering across multiple frames (no visual glitches)", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: multiLineDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)

  // Render the initial frame
  await renderOnce()

  const frameAfterAutoRender = captureFrame()

  // Now call renderOnce explicitly (this would be the second render)
  await renderOnce()
  const firstFrame = captureFrame()

  // Render a third time
  await renderOnce()
  const secondFrame = captureFrame()

  // BEHAVIORAL EXPECTATION: All frames should be identical
  // If frames differ, it indicates a visual glitch (e.g., gutter width changing,
  // content shifting, or partial rendering)
  expect(frameAfterAutoRender).toBe(firstFrame)
  expect(firstFrame).toBe(secondFrame)

  // Verify all frames have complete content (not partial rendering)
  expect(frameAfterAutoRender).toContain("function add")
  expect(frameAfterAutoRender).toContain("function subtract")
  expect(frameAfterAutoRender).toContain("function multiply")

  // Verify line numbers are present and properly aligned
  // If gutter width is wrong, line numbers will be misaligned or cut off
  const frameLines = frameAfterAutoRender.split("\n")
  const linesWithLineNumbers = frameLines.filter((l) => l.match(/^\s*\d+\s+/))

  // Should have multiple lines with line numbers
  expect(linesWithLineNumbers.length).toBeGreaterThan(5)

  // All line number widths should be consistent (not change between renders)
  // Extract just the line number part (before the sign)
  const lineNumberWidths = linesWithLineNumbers
    .map((line) => {
      const match = line.match(/^(\s*\d+)\s/)
      return match ? match[1].length : -1
    })
    .filter((w) => w > 0)

  // All line numbers should have the same width (indicating stable gutter)
  const uniqueWidths = new Set(lineNumberWidths)
  expect(uniqueWidths.size).toBe(1) // Gutter width should be consistent
})

test("DiffRenderable - can be constructed without diff and set via setter", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  // Construct without diff
  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Should render empty
  let frame = captureFrame()
  expect(frame.trim()).toBe("")

  // Now set diff via setter
  diffRenderable.diff = simpleDiff
  await renderOnce()

  frame = captureFrame()
  expect(frame).toContain("function hello")
  expect(frame).toContain('console.log("Hello")')
  expect(frame).toContain('console.log("Hello, World!")')
})

test("DiffRenderable - consistent left padding for line numbers > 9", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  // Create a diff with line numbers that go into double digits
  const diffWith10PlusLines = `--- a/test.js
+++ b/test.js
@@ -8,7 +8,9 @@
 line8
 line9
-line10_old
+line10_new
 line11
+line12_added
+line13_added
 line14
 line15
-line16_old
+line16_new`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: diffWith10PlusLines,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("unified view with double-digit line numbers")

  const frameLines = frame.split("\n")

  // Find lines in the output
  // Line 8 (single digit) should have left padding (appears as " 8 line8")
  const line8 = frameLines.find((l) => l.includes("line8"))
  expect(line8).toBeTruthy()
  const line8Match = line8!.match(/^( +)8 /)
  expect(line8Match).toBeTruthy()
  expect(line8Match![1].length).toBeGreaterThanOrEqual(1) // At least 1 space of left padding

  // Line 10 (double digit) should have left padding (appears as " 10 line10" or " 11 line10")
  const line10 = frameLines.find((l) => l.includes("line10"))
  expect(line10).toBeTruthy()
  const line10Match = line10!.match(/^( +)1[01] /)
  expect(line10Match).toBeTruthy()
  expect(line10Match![1].length).toBeGreaterThanOrEqual(1) // At least 1 space of left padding

  // Line 16 (double digit) should have left padding
  // Note: With correct line numbers, the removed line shows as 14 - and added shows as 16 +
  const line16 = frameLines.find((l) => l.includes("line16"))
  expect(line16).toBeTruthy()
  // Match either 14 - or 16 + (the correct line numbers after the fix)
  const line16Match = line16!.match(/^( +)(14 -|16 \+) /)
  expect(line16Match).toBeTruthy()
  expect(line16Match![1].length).toBeGreaterThanOrEqual(1) // At least 1 space of left padding
})

test("DiffRenderable - line numbers are correct in unified view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  const frameLines = frame.split("\n")

  // Line 2 is removed (old file line 2)
  const removedLine = frameLines.find((l) => l.includes('console.log("Hello");'))
  expect(removedLine).toBeTruthy()
  expect(removedLine).toMatch(/^ *2 -/)

  // Line 2 is added (new file line 2) - NOT line 3!
  const addedLine = frameLines.find((l) => l.includes('console.log("Hello, World!")'))
  expect(addedLine).toBeTruthy()
  expect(addedLine).toMatch(/^ *2 \+/)
})

test("DiffRenderable - line numbers are correct in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  const frameLines = frame.split("\n")

  // In split view, both sides are on the same terminal line
  // Left side: line 2 is removed, Right side: line 2 is added
  const splitLine = frameLines.find((l) => l.includes('console.log("Hello, World!")'))
  expect(splitLine).toBeTruthy()
  // Should contain line 2 with - on left side
  expect(splitLine).toMatch(/^ *2 -/)
  // Should contain line 2 with + on right side (later in the same line)
  expect(splitLine).toMatch(/2 \+.*console\.log\("Hello, World!"\)/)
})

test("DiffRenderable - split view should not wrap lines prematurely", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  // Create a diff with long lines that should fit in split view
  const longLineDiff = `--- a/test.js
+++ b/test.js
@@ -1,4 +1,4 @@
 class Calculator {
-  subtract(a: number, b: number): number {
+  subtract(a: number, b: number, c: number = 0): number {
   return a - b;
 }`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: longLineDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    wrapMode: "word",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  const frameLines = frame.split("\n")

  // Find the line with "subtract" on the left side
  const leftSubtractLine = frameLines.find((l) => l.includes("subtract") && l.includes("b: number):"))
  expect(leftSubtractLine).toBeTruthy()

  // The line should NOT be wrapped - "subtract(a: number, b: number):" should be on one line
  // In an 80-char terminal with split view, each side gets ~40 chars (minus line numbers)
  // "subtract(a: number, b: number):" is 34 chars, so it should fit without wrapping
  expect(leftSubtractLine).toMatch(/subtract\(a: number, b: number\):/)

  // Find the line with "subtract" on the right side - it might be on the same line or next line
  // The signature is longer and might wrap
  const rightSubtractLines = frameLines.filter((l) => l.includes("subtract") || l.includes("c: number"))
  expect(rightSubtractLines.length).toBeGreaterThan(0)

  // The key assertion is that the left side doesn't wrap prematurely
  // We've already verified that above
})

test("DiffRenderable - split view alignment with calculator diff", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const calculatorDiff = `--- a/calculator.ts
+++ b/calculator.ts
@@ -1,13 +1,20 @@
 class Calculator {
   add(a: number, b: number): number {
     return a + b;
   }
 
-  subtract(a: number, b: number): number {
-    return a - b;
+  subtract(a: number, b: number, c: number = 0): number {
+    return a - b - c;
   }
 
   multiply(a: number, b: number): number {
     return a * b;
   }
+
+  divide(a: number, b: number): number {
+    if (b === 0) {
+      throw new Error("Division by zero");
+    }
+    return a / b;
+  }
 }`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: calculatorDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    wrapMode: "none",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  const frameLines = frame.split("\n")

  // Find the closing brace on the left (old line 13)
  const leftClosingBrace = frameLines.find((l) => l.match(/^\s*13\s+\}/))
  expect(leftClosingBrace).toBeTruthy()

  // Find the closing brace on the right (new line 20)
  const rightClosingBrace = frameLines.find((l) => l.match(/\s*20\s+\}/))
  expect(rightClosingBrace).toBeTruthy()

  // They should be on the SAME line in the output
  expect(leftClosingBrace).toBe(rightClosingBrace)
})

test("DiffRenderable - switching between unified and split views multiple times", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Step 1: Verify unified view works
  let frame = captureFrame()
  expect(frame).toContain("function hello")
  expect(frame).toContain('console.log("Hello")')
  expect(frame).toContain('console.log("Hello, World!")')

  // Step 2: Switch to split view
  diffRenderable.view = "split"
  await renderOnce()

  frame = captureFrame()
  expect(frame).toContain("function hello")
  expect(frame).toContain('console.log("Hello")')
  expect(frame).toContain('console.log("Hello, World!")')

  // Step 3: Switch back to unified view
  diffRenderable.view = "unified"
  await renderOnce()

  frame = captureFrame()
  expect(frame).toContain("function hello")
  expect(frame).toContain('console.log("Hello")')
  expect(frame).toContain('console.log("Hello, World!")')

  // Step 4: Switch to split view again (this currently fails)
  diffRenderable.view = "split"
  await renderOnce()

  frame = captureFrame()
  expect(frame).toContain("function hello")
  expect(frame).toContain('console.log("Hello")')
  expect(frame).toContain('console.log("Hello, World!")')
})

test("DiffRenderable - wrapMode works in unified view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  // Create a diff with a very long line that will wrap
  const longLineDiff = `--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 function hello() {
-  console.log("This is a very long line that should wrap when wrapMode is set to word but not when it is set to none");
+  console.log("This is a very long line that has been modified and should wrap when wrapMode is set to word but not when it is set to none");
 }`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: longLineDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    wrapMode: "none",
    width: 80,
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Capture with wrapMode: none
  const frameNone = captureFrame()
  expect(frameNone).toMatchSnapshot("wrapMode-none")

  // Change to wrapMode: word
  diffRenderable.wrapMode = "word"
  await renderOnce()

  // Capture with wrapMode: word
  const frameWord = captureFrame()
  expect(frameWord).toMatchSnapshot("wrapMode-word")

  // Frames should be different (word wrapping should create more lines)
  expect(frameNone).not.toBe(frameWord)

  // Change back to wrapMode: none
  diffRenderable.wrapMode = "none"
  await renderOnce()

  // Should match the original
  const frameNoneAgain = captureFrame()
  expect(frameNoneAgain).toMatchSnapshot("wrapMode-none")
  expect(frameNoneAgain).toBe(frameNone)
})

test("DiffRenderable - split view with wrapMode honors wrapping alignment", async () => {
  // Create a larger test renderer to fit the whole diff with wrapping
  const testRenderer = await createTestRenderer({ width: 80, height: 40 })
  const renderer = testRenderer.renderer
  const renderOnce = testRenderer.renderOnce
  const captureFrame = testRenderer.captureCharFrame

  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const calculatorDiff = `--- a/calculator.ts
+++ b/calculator.ts
@@ -1,13 +1,20 @@
 class Calculator {
   add(a: number, b: number): number {
     return a + b;
   }
 
-  subtract(a: number, b: number): number {
-    return a - b;
+  subtract(a: number, b: number, c: number = 0): number {
+    return a - b - c;
   }
 
   multiply(a: number, b: number): number {
     return a * b;
   }
+
+  divide(a: number, b: number): number {
+    if (b === 0) {
+      throw new Error("Division by zero");
+    }
+    return a / b;
+  }
 }`

  const diffRenderable = new DiffRenderable(renderer, {
    id: "test-diff",
    diff: calculatorDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    wrapMode: "word",
    width: "100%",
    height: "100%",
  })

  renderer.root.add(diffRenderable)
  await renderOnce()

  // Flush microtask-based deferred rebuild for wrap alignment
  await Promise.resolve()
  await renderOnce()

  const frame = captureFrame()
  const frameLines = frame.split("\n")

  // Find the closing brace on the left (old line 13)
  const leftClosingBraceLine = frameLines.find((l) => l.match(/^\s*13\s+\}/))
  expect(leftClosingBraceLine).toBeTruthy()

  // Find the closing brace on the right (new line 20)
  const rightClosingBraceLine = frameLines.find((l) => l.match(/\s*20\s+\}/))
  expect(rightClosingBraceLine).toBeTruthy()

  // They should be on the SAME line in the output (same visual row)
  // even though the right side has wrapped lines above it
  expect(leftClosingBraceLine).toBe(rightClosingBraceLine)

  // Both sides should have the same number of final visual lines
  // (counting both logical lines and wrap continuations)
  // This is hard to assert directly, but if alignment is correct,
  // the closing braces being on the same line proves it worked

  // Clean up
  renderer.destroy()
})

test("DiffRenderable - context lines show new line numbers in unified view", async () => {
  // Create a larger test renderer to fit the whole diff
  const testRenderer = await createTestRenderer({ width: 80, height: 30 })
  const renderer = testRenderer.renderer
  const renderOnce = testRenderer.renderOnce
  const captureFrame = testRenderer.captureCharFrame

  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  // This diff adds lines in the middle, so context lines after additions
  // should show their NEW line numbers, not old ones
  const calculatorDiff = `--- a/calculator.ts
+++ b/calculator.ts
@@ -1,13 +1,20 @@
 class Calculator {
   add(a: number, b: number): number {
     return a + b;
   }
 
-  subtract(a: number, b: number): number {
-    return a - b;
+  subtract(a: number, b: number, c: number = 0): number {
+    return a - b - c;
   }
 
   multiply(a: number, b: number): number {
     return a * b;
   }
+
+  divide(a: number, b: number): number {
+    if (b === 0) {
+      throw new Error("Division by zero");
+    }
+    return a / b;
+  }
 }`

  const diffRenderable = new DiffRenderable(renderer, {
    id: "test-diff",
    diff: calculatorDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  renderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  const frameLines = frame.split("\n")

  // The closing brace "}" for the Calculator class is a context line
  // In the old file it was at line 13
  // In the new file it's at line 20 (after adding 7 lines for divide method)
  // Unified view should show line 20, not line 13
  // Find the LAST closing brace that's just "}" (at the beginning of indentation, not nested)
  // This regex matches: optional spaces, digits, spaces, optional sign (+/-), spaces, "}", trailing spaces
  const closingBraceLines = frameLines.filter((l) => l.match(/^\s*\d+\s+[+-]?\s*\}\s*$/))

  // The last one should be the class closing brace
  const classClosingBraceLine = closingBraceLines[closingBraceLines.length - 1]
  expect(classClosingBraceLine).toBeTruthy()

  // Extract the line number from the closing brace line
  const lineNumberMatch = classClosingBraceLine!.match(/^\s*(\d+)/)
  expect(lineNumberMatch).toBeTruthy()

  const lineNumber = parseInt(lineNumberMatch![1])

  // The closing brace should show line 20 (new file position), not 13 (old file position)
  expect(lineNumber).toBe(20)

  // Clean up
  renderer.destroy()
})

test("DiffRenderable - multiple hunks in unified view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  // Diff with three separate hunks
  const multiHunkDiff = `--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
 function first() {
-  return 1;
+  return "one";
 }
@@ -15,4 +15,5 @@
 function second() {
   var x = 10;
+  var y = 20;
   return x;
 }
@@ -30,3 +31,3 @@
 function third() {
-  console.log("old");
+  console.log("new");
 }`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: multiHunkDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("unified view multiple hunks")

  // All three hunks should be present
  expect(frame).toContain('return "one"')
  expect(frame).toContain("var y = 20")
  expect(frame).toContain('console.log("new")')

  // Line numbers should be correct for each hunk
  const frameLines = frame.split("\n")

  // First hunk around line 2
  const firstHunkLine = frameLines.find((l) => l.includes('return "one"'))
  expect(firstHunkLine).toMatch(/2 \+/)

  // Second hunk around line 17 (added line)
  const secondHunkLine = frameLines.find((l) => l.includes("var y = 20"))
  expect(secondHunkLine).toMatch(/17 \+/)

  // Third hunk around line 32
  const thirdHunkLine = frameLines.find((l) => l.includes('console.log("new")'))
  expect(thirdHunkLine).toMatch(/32 \+/)
})

test("DiffRenderable - multiple hunks in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const multiHunkDiff = `--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
 function first() {
-  return 1;
+  return "one";
 }
@@ -15,4 +15,5 @@
 function second() {
   var x = 10;
+  var y = 20;
   return x;
 }
@@ -30,3 +31,3 @@
 function third() {
-  console.log("old");
+  console.log("new");
 }`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: multiHunkDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view multiple hunks")

  // All three hunks should be present in split view
  expect(frame).toContain('return "one"')
  expect(frame).toContain("var y = 20")
  expect(frame).toContain('console.log("new")')

  // Both old and new content should be visible
  expect(frame).toContain("return 1")
  expect(frame).toContain('console.log("old")')
})

test("DiffRenderable - no newline at end of file in unified view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const noNewlineDiff = `--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 line1
 line2
-line3
\\ No newline at end of file
+line3_modified
\\ No newline at end of file`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: noNewlineDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("unified view with no newline marker")

  // Should show both old and new versions
  expect(frame).toContain("line3")
  expect(frame).toContain("line3_modified")

  // Should NOT show the "No newline" marker as content
  // (it's a special marker that should be skipped)
  const frameLines = frame.split("\n")
  const markerLines = frameLines.filter((l) => l.includes("No newline at end of file"))
  expect(markerLines.length).toBe(0)
})

test("DiffRenderable - no newline at end of file in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const noNewlineDiff = `--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 line1
 line2
-line3
\\ No newline at end of file
+line3_modified
\\ No newline at end of file`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: noNewlineDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view with no newline marker")

  // Both sides should show their respective versions
  expect(frame).toContain("line3")
  expect(frame).toContain("line3_modified")

  // Should NOT show the "No newline" marker
  const frameLines = frame.split("\n")
  const markerLines = frameLines.filter((l) => l.includes("No newline at end of file"))
  expect(markerLines.length).toBe(0)
})

test("DiffRenderable - asymmetric block with more removes than adds in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const asymmetricDiff = `--- a/test.js
+++ b/test.js
@@ -1,7 +1,4 @@
 context_before
-remove1
-remove2
-remove3
-remove4
-remove5
+add1
+add2
 context_after`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: asymmetricDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view asymmetric block more removes")

  // Left side should have all 5 removes
  expect(frame).toContain("remove1")
  expect(frame).toContain("remove2")
  expect(frame).toContain("remove3")
  expect(frame).toContain("remove4")
  expect(frame).toContain("remove5")

  // Right side should have 2 adds
  expect(frame).toContain("add1")
  expect(frame).toContain("add2")

  // Context lines should appear on both sides at the same visual position
  const frameLines = frame.split("\n")
  const contextBeforeLines = frameLines.filter((l) => l.includes("context_before"))
  const contextAfterLines = frameLines.filter((l) => l.includes("context_after"))

  // context_before should appear once (on same visual line for both sides)
  expect(contextBeforeLines.length).toBeGreaterThanOrEqual(1)

  // context_after should appear once (on same visual line for both sides)
  expect(contextAfterLines.length).toBeGreaterThanOrEqual(1)

  // The right side should have empty padding lines to align with left side's extra removes
  // We can verify this by checking that context_after appears at similar vertical positions
})

test("DiffRenderable - asymmetric block with more adds than removes in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const asymmetricDiff = `--- a/test.js
+++ b/test.js
@@ -1,4 +1,7 @@
 context_before
-remove1
-remove2
+add1
+add2
+add3
+add4
+add5
 context_after`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: asymmetricDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view asymmetric block more adds")

  // Left side should have 2 removes
  expect(frame).toContain("remove1")
  expect(frame).toContain("remove2")

  // Right side should have all 5 adds
  expect(frame).toContain("add1")
  expect(frame).toContain("add2")
  expect(frame).toContain("add3")
  expect(frame).toContain("add4")
  expect(frame).toContain("add5")

  // Context lines should be aligned
  const frameLines = frame.split("\n")
  const contextBeforeLines = frameLines.filter((l) => l.includes("context_before"))
  const contextAfterLines = frameLines.filter((l) => l.includes("context_after"))

  expect(contextBeforeLines.length).toBeGreaterThanOrEqual(1)
  expect(contextAfterLines.length).toBeGreaterThanOrEqual(1)
})

test("DiffRenderable - back-to-back change blocks without context lines in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const backToBackDiff = `--- a/test.js
+++ b/test.js
@@ -1,4 +1,4 @@
-remove1
-remove2
-remove3
-remove4
+add1
+add2
+add3
+add4`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: backToBackDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view back-to-back blocks")

  // All removes should be on left
  expect(frame).toContain("remove1")
  expect(frame).toContain("remove2")
  expect(frame).toContain("remove3")
  expect(frame).toContain("remove4")

  // All adds should be on right
  expect(frame).toContain("add1")
  expect(frame).toContain("add2")
  expect(frame).toContain("add3")
  expect(frame).toContain("add4")

  // Both sides should have same number of visual lines (with alignment)
  const frameLines = frame.split("\n").filter((l) => l.trim().length > 0)
  expect(frameLines.length).toBeGreaterThan(0)
})

test("DiffRenderable - very long lines wrapping multiple times in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const longLineDiff = `--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 short line
-This is an extremely long line that will definitely wrap multiple times when rendered in a split view with word wrapping enabled because it contains so many words and characters
+This is an extremely long line that has been modified and will definitely wrap multiple times when rendered in a split view with word wrapping enabled because it contains so many words and characters and even more content
 another short line`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: longLineDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    wrapMode: "word",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Flush microtask-based wrap alignment
  await Promise.resolve()
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("split view multi-wrap lines")

  // Both versions of the long line should be present
  expect(frame).toContain("extremely long line")
  expect(frame).toContain("has been modified")

  // Short lines should still be aligned
  expect(frame).toContain("short line")
  expect(frame).toContain("another short line")

  const frameLines = frame.split("\n")

  // Find the "another short line" on both sides
  const shortLineMatches = frameLines.filter((l) => l.includes("another short line"))

  // Should appear (on the same visual line in split view)
  expect(shortLineMatches.length).toBeGreaterThanOrEqual(1)
})

test("DiffRenderable - rapid diff updates trigger microtask coalescing", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    wrapMode: "word",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Rapidly update the diff multiple times
  diffRenderable.diff = multiLineDiff
  diffRenderable.diff = addOnlyDiff
  diffRenderable.diff = removeOnlyDiff
  diffRenderable.diff = simpleDiff

  // Flush microtask-based coalesced rebuild
  await Promise.resolve()
  await renderOnce()

  const frame = captureFrame()

  // Should show the final diff (simpleDiff)
  expect(frame).toContain("function hello")
  expect(frame).toContain('console.log("Hello")')
  expect(frame).toContain('console.log("Hello, World!")')

  // Should NOT show content from intermediate diffs
  expect(frame).not.toContain("subtract")
  expect(frame).not.toContain("newFunction")
  expect(frame).not.toContain("oldFunction")
})

test("DiffRenderable - explicit content background colors differ from gutter", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    addedBg: "#1a4d1a",
    removedBg: "#4d1a1a",
    addedContentBg: "#2a5d2a",
    removedContentBg: "#5d2a2a",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()

  // Verify content is rendered
  expect(frame).toContain("function hello")
  expect(frame).toContain('console.log("Hello")')
  expect(frame).toContain('console.log("Hello, World!")')

  // Verify properties are set correctly
  expect(diffRenderable.addedBg).toEqual(RGBA.fromHex("#1a4d1a"))
  expect(diffRenderable.removedBg).toEqual(RGBA.fromHex("#4d1a1a"))
  expect(diffRenderable.addedContentBg).toEqual(RGBA.fromHex("#2a5d2a"))
  expect(diffRenderable.removedContentBg).toEqual(RGBA.fromHex("#5d2a2a"))

  // Test that we can update them
  diffRenderable.addedContentBg = "#3a6d3a"
  expect(diffRenderable.addedContentBg).toEqual(RGBA.fromHex("#3a6d3a"))

  await renderOnce()
  const frame2 = captureFrame()

  // Should still render correctly after update
  expect(frame2).toContain("function hello")
})

test("DiffRenderable - malformed diff string handled gracefully", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const malformedDiff = `This is not a valid diff format
Just some random text
Without proper headers`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: malformedDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)

  // Should not crash when rendering malformed diff
  await renderOnce()

  const frame = captureFrame()

  // Should render empty/blank since diff can't be parsed
  // The important thing is it doesn't crash
  expect(diffRenderable.diff).toBe(malformedDiff)
})

test("DiffRenderable - invalid diff format shows error with raw diff", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  // This diff has a malformed hunk header that will cause parsePatch to throw
  // The hunk header must have the format @@ -oldStart,oldLines +newStart,newLines @@
  const invalidDiff = `--- a/test.js
+++ b/test.js
@@ -a,b +c,d @@
 function hello() {
-  console.log("Hello");
+  console.log("Hello, World!");
 }`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: invalidDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)

  // Should not crash when rendering invalid diff
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("invalid diff format with error")

  // Should contain error message (the error from parsePatch)
  expect(frame).toContain("Error parsing diff")

  // Should show the raw diff content
  expect(frame).toContain("@@ -a,b +c,d @@")
  expect(frame).toContain("function hello")
})

test("DiffRenderable - diff with only context lines (no changes)", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const contextOnlyDiff = `--- a/test.js
+++ b/test.js
@@ -1,5 +1,5 @@
 line1
 line2
 line3
 line4
 line5`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: contextOnlyDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toMatchSnapshot("diff with only context lines")

  // All lines should be present as context
  expect(frame).toContain("line1")
  expect(frame).toContain("line2")
  expect(frame).toContain("line3")
  expect(frame).toContain("line4")
  expect(frame).toContain("line5")

  // No +/- signs should be present (only context)
  const frameLines = frame.split("\n")
  const changedLines = frameLines.filter((l) => l.match(/[+-]\s*line/))
  expect(changedLines.length).toBe(0)
})

test("DiffRenderable - should not leak listeners on unified view updates", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Get the underlying CodeRenderable (leftCodeRenderable in unified view)
  const codeRenderable = (diffRenderable as any).leftCodeRenderable
  expect(codeRenderable).toBeDefined()

  // Check initial listener count
  const initialListenerCount = codeRenderable.listenerCount("line-info-change")
  expect(initialListenerCount).toBeGreaterThanOrEqual(1)

  // Update the diff multiple times - this should not add more listeners
  for (let i = 0; i < 10; i++) {
    diffRenderable.diff = simpleDiff.replace('"Hello"', `"Hello${i}"`)
    await renderOnce()
  }

  // Check that listener count hasn't grown
  const finalListenerCount = codeRenderable.listenerCount("line-info-change")
  expect(finalListenerCount).toBe(initialListenerCount)
})

test("DiffRenderable - should not leak listeners on split view updates", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Get the underlying CodeRenderables
  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  const rightCodeRenderable = (diffRenderable as any).rightCodeRenderable
  expect(leftCodeRenderable).toBeDefined()
  expect(rightCodeRenderable).toBeDefined()

  // Check initial listener counts
  const leftInitialCount = leftCodeRenderable.listenerCount("line-info-change")
  const rightInitialCount = rightCodeRenderable.listenerCount("line-info-change")
  expect(leftInitialCount).toBeGreaterThanOrEqual(1)
  expect(rightInitialCount).toBeGreaterThanOrEqual(1)

  // Update the diff multiple times - this should not add more listeners
  for (let i = 0; i < 10; i++) {
    diffRenderable.diff = simpleDiff.replace('"Hello"', `"Hello${i}"`)
    await renderOnce()
  }

  // Check that listener counts haven't grown
  const leftFinalCount = leftCodeRenderable.listenerCount("line-info-change")
  const rightFinalCount = rightCodeRenderable.listenerCount("line-info-change")
  expect(leftFinalCount).toBe(leftInitialCount)
  expect(rightFinalCount).toBe(rightInitialCount)
})

test("DiffRenderable - should not leak listeners when switching views", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Get initial renderables
  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  expect(leftCodeRenderable).toBeDefined()
  const initialLeftCount = leftCodeRenderable.listenerCount("line-info-change")

  // Switch to split view and back multiple times
  for (let i = 0; i < 5; i++) {
    diffRenderable.view = "split"
    await renderOnce()

    diffRenderable.view = "unified"
    await renderOnce()
  }

  const finalLeftCount = leftCodeRenderable.listenerCount("line-info-change")

  // Listener count should remain stable (allow some flexibility for implementation details)
  expect(finalLeftCount).toBeLessThanOrEqual(initialLeftCount + 2)
})

test("DiffRenderable - should not leak listeners on rapid property changes", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  const rightCodeRenderable = (diffRenderable as any).rightCodeRenderable
  const leftInitialCount = leftCodeRenderable.listenerCount("line-info-change")
  const rightInitialCount = rightCodeRenderable.listenerCount("line-info-change")

  // Make rapid changes that trigger rebuilds
  for (let i = 0; i < 10; i++) {
    diffRenderable.wrapMode = i % 2 === 0 ? "word" : "char"
    diffRenderable.addedBg = i % 2 === 0 ? "#ff0000" : "#00ff00"
    diffRenderable.removedBg = i % 2 === 0 ? "#0000ff" : "#ffff00"
    await renderOnce()
  }

  const leftFinalCount = leftCodeRenderable.listenerCount("line-info-change")
  const rightFinalCount = rightCodeRenderable.listenerCount("line-info-change")

  // Listener counts should remain stable
  expect(leftFinalCount).toBe(leftInitialCount)
  expect(rightFinalCount).toBe(rightInitialCount)
})

test("DiffRenderable - can toggle conceal with markdown diff", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const mockClient = new MockTreeSitterClient()

  const markdownDiff = `--- a/test.md
+++ b/test.md
@@ -1,3 +1,3 @@
 First line
-Some text **old**
+Some text **boldtext** and *italic*
 End line`

  const mockHighlightsWithConceal: SimpleHighlight[] = [
    [21, 23, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }], // **
    [31, 33, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }], // **
    [38, 39, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }], // *
    [45, 46, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }], // *
  ]

  mockClient.setMockResult({ highlights: mockHighlightsWithConceal })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: markdownDiff,
    view: "unified",
    syntaxStyle,
    filetype: "markdown",
    conceal: true,
    treeSitterClient: mockClient,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  const frameWithConceal = captureFrame()
  expect(frameWithConceal).toMatchSnapshot("markdown diff with conceal enabled")
  expect(diffRenderable.conceal).toBe(true)

  diffRenderable.conceal = false
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  const frameWithoutConceal = captureFrame()
  expect(frameWithoutConceal).toMatchSnapshot("markdown diff with conceal disabled")
  expect(diffRenderable.conceal).toBe(false)

  expect(frameWithConceal).not.toBe(frameWithoutConceal)

  diffRenderable.conceal = true
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  const frameWithConcealAgain = captureFrame()
  expect(frameWithConcealAgain).toBe(frameWithConceal)
})

test("DiffRenderable - conceal works in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const mockClient = new MockTreeSitterClient()

  const markdownDiff = `--- a/test.md
+++ b/test.md
@@ -1,3 +1,3 @@
 First line
-Some **old** text
+Some **new** text
 End line`

  const mockHighlightsWithConceal: SimpleHighlight[] = [
    [16, 18, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }], // **
    [21, 23, "conceal", { isInjection: true, injectionLang: "markdown_inline", conceal: "" }], // **
  ]

  mockClient.setMockResult({ highlights: mockHighlightsWithConceal })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: markdownDiff,
    view: "split",
    syntaxStyle,
    filetype: "markdown",
    conceal: true,
    treeSitterClient: mockClient,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  const frameWithConceal = captureFrame()
  expect(frameWithConceal).toMatchSnapshot("split view markdown diff with conceal enabled")
  expect(diffRenderable.conceal).toBe(true)

  diffRenderable.conceal = false
  await settleDiffHighlighting(diffRenderable, mockClient, renderOnce)

  const frameWithoutConceal = captureFrame()
  expect(frameWithoutConceal).toMatchSnapshot("split view markdown diff with conceal disabled")
  expect(diffRenderable.conceal).toBe(false)

  expect(frameWithConceal).not.toBe(frameWithoutConceal)
})

test("DiffRenderable - conceal defaults to false when not specified", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    filetype: "javascript",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  expect(diffRenderable.conceal).toBe(false)
})

test("DiffRenderable - should handle resize with wrapping without leaking listeners", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
    wrapMode: "word",
    width: 100,
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  const rightCodeRenderable = (diffRenderable as any).rightCodeRenderable
  const leftInitialCount = leftCodeRenderable.listenerCount("line-info-change")
  const rightInitialCount = rightCodeRenderable.listenerCount("line-info-change")

  // Simulate multiple resizes (which trigger rebuilds in split view with wrapping)
  for (let i = 0; i < 10; i++) {
    diffRenderable.width = 50 + i * 5
    await renderOnce()
    // Flush microtask rebuild
    await Promise.resolve()
    await renderOnce()
  }

  const leftFinalCount = leftCodeRenderable.listenerCount("line-info-change")
  const rightFinalCount = rightCodeRenderable.listenerCount("line-info-change")

  expect(leftFinalCount).toBe(leftInitialCount)
  expect(rightFinalCount).toBe(rightInitialCount)
})

test("DiffRenderable - gutter configuration updates work correctly", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  const leftSide = (diffRenderable as any).leftSide

  // Verify initial state
  expect(leftSide).toBeDefined()
  expect(leftCodeRenderable).toBeDefined()
  const initialListenerCount = leftCodeRenderable.listenerCount("line-info-change")

  // Get initial frame to verify line numbers are showing
  let frame = captureFrame()
  expect(frame).toContain("function hello")

  // Update multiple gutter configurations that trigger recreateGutter()
  // Each of these calls setLineNumbers/setHideLineNumbers internally
  for (let i = 0; i < 5; i++) {
    diffRenderable.diff = simpleDiff.replace('"Hello"', `"Hello${i}"`)
    await renderOnce()
  }

  // Verify listener count is stable
  const finalListenerCount = leftCodeRenderable.listenerCount("line-info-change")
  expect(finalListenerCount).toBe(initialListenerCount)

  // Verify rendering still works
  frame = captureFrame()
  expect(frame).toContain("function hello")
  expect(frame).toContain("Hello4") // Last update should be visible
})

test("DiffRenderable - target remains functional after multiple updates", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: multiLineDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  const rightCodeRenderable = (diffRenderable as any).rightCodeRenderable

  // Verify targets are responding to line-info-change events
  let leftEventFired = false
  let rightEventFired = false

  const leftListener = () => {
    leftEventFired = true
  }
  const rightListener = () => {
    rightEventFired = true
  }

  leftCodeRenderable.on("line-info-change", leftListener)
  rightCodeRenderable.on("line-info-change", rightListener)

  // Update diff multiple times
  for (let i = 0; i < 5; i++) {
    leftEventFired = false
    rightEventFired = false

    diffRenderable.diff = multiLineDiff.replace("add(a, b)", `add(a, b, ${i})`)
    await renderOnce()

    // Events should have fired during the update
    expect(leftEventFired).toBe(true)
    expect(rightEventFired).toBe(true)
  }

  leftCodeRenderable.off("line-info-change", leftListener)
  rightCodeRenderable.off("line-info-change", rightListener)
})

test("DiffRenderable - split view scroll is not synchronized by default", async () => {
  const mockMouse = createMockMouse(currentRenderer)
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: multiLineDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: 4,
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  const rightCodeRenderable = (diffRenderable as any).rightCodeRenderable

  expect(leftCodeRenderable).toBeTruthy()
  expect(rightCodeRenderable).toBeTruthy()

  // Scroll over left pane
  mockMouse.scroll(leftCodeRenderable.x, leftCodeRenderable.y + 1, "down")
  await renderOnce()

  expect(leftCodeRenderable.scrollY).toBe(1)
  expect(rightCodeRenderable.scrollY).toBe(0)

  // Scroll over right pane
  mockMouse.scroll(rightCodeRenderable.x + 1, rightCodeRenderable.y + 1, "down")
  await renderOnce()

  expect(rightCodeRenderable.scrollY).toBe(1)
  expect(leftCodeRenderable.scrollY).toBe(1)
})

test("DiffRenderable - split view wheel scroll keeps panes synchronized", async () => {
  const mockMouse = createMockMouse(currentRenderer)
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: multiLineDiff,
    syncScroll: true,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: 4,
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  const rightCodeRenderable = (diffRenderable as any).rightCodeRenderable

  expect(leftCodeRenderable).toBeTruthy()
  expect(rightCodeRenderable).toBeTruthy()

  // Scroll over left pane
  await mockMouse.scroll(leftCodeRenderable.x + 1, leftCodeRenderable.y + 1, "down")
  await renderOnce()

  expect(leftCodeRenderable.scrollY).toBeGreaterThan(0)
  expect(leftCodeRenderable.scrollY).toBe(rightCodeRenderable.scrollY)

  // Scroll over right pane
  await mockMouse.scroll(rightCodeRenderable.x + 1, rightCodeRenderable.y + 1, "down")
  await renderOnce()

  expect(rightCodeRenderable.scrollY).toBeGreaterThan(0)
  expect(leftCodeRenderable.scrollY).toBe(rightCodeRenderable.scrollY)
})

test("DiffRenderable - gutter remains in correct position after updates", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Initial frame should have line numbers on the left
  let frame = captureFrame()
  const lines = frame.split("\n")

  // Find a line with content
  const contentLine = lines.find((l) => l.includes("function hello"))
  expect(contentLine).toBeDefined()

  // Line number should be at the start (before the content)
  expect(contentLine).toMatch(/^\s*\d+/)

  // Update diff multiple times
  for (let i = 0; i < 5; i++) {
    diffRenderable.diff = simpleDiff.replace('"Hello"', `"Hello${i}"`)
    await renderOnce()

    frame = captureFrame()
    const updatedLines = frame.split("\n")
    const updatedContentLine = updatedLines.find((l) => l.includes("function hello"))

    // Line numbers should still be at the start
    expect(updatedContentLine).toBeDefined()
    expect(updatedContentLine).toMatch(/^\s*\d+/)
  }
})

test("DiffRenderable - properly cleans up listeners on destroy", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  const rightCodeRenderable = (diffRenderable as any).rightCodeRenderable

  // Update multiple times to potentially create leaks
  for (let i = 0; i < 5; i++) {
    diffRenderable.diff = simpleDiff.replace('"Hello"', `"Hello${i}"`)
    await renderOnce()
  }

  const leftCountBeforeDestroy = leftCodeRenderable.listenerCount("line-info-change")
  const rightCountBeforeDestroy = rightCodeRenderable.listenerCount("line-info-change")

  // Verify listeners exist
  expect(leftCountBeforeDestroy).toBeGreaterThan(0)
  expect(rightCountBeforeDestroy).toBeGreaterThan(0)

  // Destroy the diff
  diffRenderable.destroyRecursively()

  // The LineNumberRenderables should have been destroyed
  // Check that they're either null or destroyed
  const leftSide = (diffRenderable as any).leftSide
  const rightSide = (diffRenderable as any).rightSide

  if (leftSide) {
    expect(leftSide.isDestroyed).toBe(true)
  }
  if (rightSide) {
    expect(rightSide.isDestroyed).toBe(true)
  }
})

test("DiffRenderable - line numbers update correctly after resize causes wrapping changes", async () => {
  const testRenderer = await createTestRenderer({ width: 120, height: 40 })
  const renderer = testRenderer.renderer
  const renderOnce = testRenderer.renderOnce
  const captureFrame = testRenderer.captureCharFrame
  const resize = testRenderer.resize

  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const longLineDiff = `--- a/test.js
+++ b/test.js
@@ -1,4 +1,4 @@
 function calculateSomethingVeryComplexWithALongFunctionNameThatWillWrap() {
-  const oldResultWithAVeryLongVariableNameThatWillDefinitelyWrapWhenRenderedInASmallerTerminal = 42;
+  const newResultWithAVeryLongVariableNameThatWillDefinitelyWrapWhenRenderedInASmallerTerminal = 100;
   return result;
 }`

  const diffRenderable = new DiffRenderable(renderer, {
    id: "test-diff",
    diff: longLineDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    wrapMode: "word",
    width: "100%",
    height: "100%",
  })

  renderer.root.add(diffRenderable)
  await renderOnce()

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable

  let lineInfoChangeEmitted = false
  const lineInfoChangeListener = () => {
    lineInfoChangeEmitted = true
  }
  leftCodeRenderable.on("line-info-change", lineInfoChangeListener)

  const frameBefore = captureFrame()
  expect(frameBefore).toMatchSnapshot("before resize - line numbers with no wrapping")

  const lineInfoBefore = leftCodeRenderable.lineInfo
  expect(lineInfoBefore.lineSources).toEqual([0, 1, 2, 3, 4])
  expect(leftCodeRenderable.virtualLineCount).toBe(5)

  lineInfoChangeEmitted = false

  resize(60, 40)

  await Promise.resolve()
  await renderOnce()

  expect(lineInfoChangeEmitted).toBe(true)
  expect(leftCodeRenderable.virtualLineCount).toBe(11)

  await Promise.resolve()
  await renderOnce()

  const frameAfter = captureFrame()
  expect(frameAfter).toMatchSnapshot("after resize - line numbers with wrapping")

  const lineInfoAfter = leftCodeRenderable.lineInfo
  expect(lineInfoAfter.lineSources).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 4])

  const linesAfter = frameAfter.split("\n").filter((l) => l.trim().length > 0)

  const lineNumberMatches = linesAfter
    .map((line, idx) => {
      const match = line.match(/^\s*(\d+)\s+([+-]?)/)
      if (match) {
        return { lineIdx: idx, lineNum: parseInt(match[1]), sign: match[2], content: line }
      }
      return null
    })
    .filter((m) => m !== null)

  expect(lineNumberMatches.length).toBe(5)

  expect(lineNumberMatches[0]!.lineNum).toBe(1)
  expect(lineNumberMatches[1]!.lineNum).toBe(2)
  expect(lineNumberMatches[1]!.sign).toBe("-")
  expect(lineNumberMatches[2]!.lineNum).toBe(2)
  expect(lineNumberMatches[2]!.sign).toBe("+")
  expect(lineNumberMatches[3]!.lineNum).toBe(3)
  expect(lineNumberMatches[4]!.lineNum).toBe(4)

  leftCodeRenderable.off("line-info-change", lineInfoChangeListener)
  renderer.destroy()
})

test("DiffRenderable - fg prop is passed to CodeRenderable on construction", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })
  const customFg = "#000000"

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    fg: customFg,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  expect(diffRenderable.fg).toEqual(RGBA.fromHex(customFg))

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  expect(leftCodeRenderable).toBeDefined()
  expect(leftCodeRenderable.fg).toEqual(RGBA.fromHex(customFg))
})

test("DiffRenderable - fg prop can be updated via setter", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })
  const initialFg = "#000000"
  const updatedFg = "#333333"

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    fg: initialFg,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  diffRenderable.fg = updatedFg
  await renderOnce()

  expect(diffRenderable.fg).toEqual(RGBA.fromHex(updatedFg))

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  expect(leftCodeRenderable.fg).toEqual(RGBA.fromHex(updatedFg))
})

test("DiffRenderable - fg prop is passed to both CodeRenderables in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })
  const customFg = "#222222"

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
    fg: customFg,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  expect(diffRenderable.fg).toEqual(RGBA.fromHex(customFg))

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  const rightCodeRenderable = (diffRenderable as any).rightCodeRenderable

  expect(leftCodeRenderable).toBeDefined()
  expect(rightCodeRenderable).toBeDefined()
  expect(leftCodeRenderable.fg).toEqual(RGBA.fromHex(customFg))
  expect(rightCodeRenderable.fg).toEqual(RGBA.fromHex(customFg))
})

test("DiffRenderable - fg prop updates both CodeRenderables in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })
  const initialFg = "#111111"
  const updatedFg = "#444444"

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
    fg: initialFg,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  const rightCodeRenderable = (diffRenderable as any).rightCodeRenderable

  diffRenderable.fg = updatedFg
  await renderOnce()

  expect(diffRenderable.fg).toEqual(RGBA.fromHex(updatedFg))
  expect(leftCodeRenderable.fg).toEqual(RGBA.fromHex(updatedFg))
  expect(rightCodeRenderable.fg).toEqual(RGBA.fromHex(updatedFg))
})

test("DiffRenderable - fg prop defaults to undefined when not specified", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  expect(diffRenderable.fg).toBeUndefined()
})

test("DiffRenderable - fg prop can be set to undefined to clear it", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })
  const initialFg = "#000000"

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    fg: initialFg,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  expect(diffRenderable.fg).toEqual(RGBA.fromHex(initialFg))

  diffRenderable.fg = undefined
  await renderOnce()

  expect(diffRenderable.fg).toBeUndefined()
})

test("DiffRenderable - fg prop accepts RGBA directly", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })
  const customFg = RGBA.fromValues(0.2, 0.2, 0.2, 1)

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
    fg: customFg,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  expect(diffRenderable.fg).toEqual(customFg)

  const leftCodeRenderable = (diffRenderable as any).leftCodeRenderable
  expect(leftCodeRenderable.fg).toEqual(customFg)
})

test("DiffRenderable - split view with word wrapping: changing diff content should not misalign sides", async () => {
  const { BoxRenderable } = await import("./Box.js")
  const { parseColor } = await import("../lib/RGBA.js")

  // Use terminal width that matches the demo (~116 chars)
  const testRenderer = await createTestRenderer({ width: 116, height: 30 })
  const renderer = testRenderer.renderer
  const captureFrame = testRenderer.captureCharFrame

  // GitHub Dark theme - EXACTLY as in diff-demo.ts
  const theme = {
    backgroundColor: "#0D1117",
    addedBg: "#1a4d1a",
    removedBg: "#4d1a1a",
    contextBg: "transparent",
    addedSignColor: "#22c55e",
    removedSignColor: "#ef4444",
    lineNumberFg: "#6b7280",
    lineNumberBg: "#161b22",
    addedLineNumberBg: "#0d3a0d",
    removedLineNumberBg: "#3a0d0d",
    selectionBg: "#264F78",
    selectionFg: "#FFFFFF",
  }

  // Syntax style EXACTLY as in diff-demo.ts GitHub Dark theme
  const syntaxStyle = SyntaxStyle.fromStyles({
    keyword: { fg: parseColor("#FF7B72"), bold: true },
    "keyword.import": { fg: parseColor("#FF7B72"), bold: true },
    string: { fg: parseColor("#A5D6FF") },
    comment: { fg: parseColor("#8B949E"), italic: true },
    number: { fg: parseColor("#79C0FF") },
    boolean: { fg: parseColor("#79C0FF") },
    constant: { fg: parseColor("#79C0FF") },
    function: { fg: parseColor("#D2A8FF") },
    "function.call": { fg: parseColor("#D2A8FF") },
    constructor: { fg: parseColor("#FFA657") },
    type: { fg: parseColor("#FFA657") },
    operator: { fg: parseColor("#FF7B72") },
    variable: { fg: parseColor("#E6EDF3") },
    property: { fg: parseColor("#79C0FF") },
    bracket: { fg: parseColor("#F0F6FC") },
    punctuation: { fg: parseColor("#F0F6FC") },
    default: { fg: parseColor("#E6EDF3") },
  })

  // contentExamples[0] - TypeScript Calculator diff
  const calculatorDiff = `--- a/calculator.ts
+++ b/calculator.ts
@@ -1,13 +1,20 @@
 class Calculator {
   add(a: number, b: number): number {
     return a + b;
   }
 
-  subtract(a: number, b: number): number {
-    return a - b;
+  subtract(a: number, b: number, c: number = 0): number {
+    return a - b - c;
   }
 
   multiply(a: number, b: number): number {
     return a * b;
   }
+
+  divide(a: number, b: number): number {
+    if (b === 0) {
+      throw new Error("Division by zero");
+    }
+    return a / b;
+  }
 }`

  // contentExamples[1] - Real Session: Text Demo
  const textDemoDiff = `Index: packages/examples/src/index.ts
===================================================================
--- packages/examples/src/index.ts	before
+++ packages/examples/src/index.ts	after
@@ -56,6 +56,7 @@
 import * as terminalDemo from "./terminal"
 import * as diffDemo from "./diff-demo"
 import * as keypressDebugDemo from "./keypress-debug-demo"
+import * as textTruncationDemo from "./text-truncation-demo"
 import { setupCommonDemoKeys } from "./lib/standalone-keys"
 
 interface Example {
@@ -85,6 +86,12 @@
     destroy: textSelectionExample.destroy,
   },
   {
+    name: "Text Truncation Demo",
+    description: "Middle truncation with ellipsis - toggle with 'T' key and resize to test responsive behavior",
+    run: textTruncationDemo.run,
+    destroy: textTruncationDemo.destroy,
+  },
+  {
     name: "ASCII Font Selection Demo",
     description: "Text selection with ASCII fonts - precise character-level selection across different font types",
     run: asciiFontSelectionExample.run,`

  renderer.setBackgroundColor(theme.backgroundColor)

  // PART 1: CORRECT PATH
  // Start with textDemoDiff, view="unified", wrapMode="none"
  // Then toggle to split, then toggle to word wrap
  // This produces CORRECT alignment
  const parentContainer1 = new BoxRenderable(renderer, {
    id: "parent-container-1",
    padding: 1,
  })
  renderer.root.add(parentContainer1)

  const correctDiff = new DiffRenderable(renderer, {
    id: "correct-diff",
    diff: textDemoDiff, // Start with textDemoDiff directly
    view: "unified",
    filetype: "typescript",
    syntaxStyle,
    showLineNumbers: true,
    wrapMode: "none",
    conceal: true,
    addedBg: theme.addedBg,
    removedBg: theme.removedBg,
    contextBg: theme.contextBg,
    addedSignColor: theme.addedSignColor,
    removedSignColor: theme.removedSignColor,
    lineNumberFg: theme.lineNumberFg,
    lineNumberBg: theme.lineNumberBg,
    addedLineNumberBg: theme.addedLineNumberBg,
    removedLineNumberBg: theme.removedLineNumberBg,
    selectionBg: theme.selectionBg,
    selectionFg: theme.selectionFg,
    flexGrow: 1,
    flexShrink: 1,
  })

  parentContainer1.add(correctDiff)
  await renderOnce()

  // Press V - toggle to split view
  correctDiff.view = "split"
  await Promise.resolve()
  await renderOnce()

  // Press W - toggle to word wrap
  correctDiff.wrapMode = "word"
  await Promise.resolve()
  await renderOnce()
  await Promise.resolve()
  await renderOnce()

  const correctFrame = captureFrame()

  // Clean up
  parentContainer1.destroyRecursively()
  renderer.root.remove("parent-container-1")
  await renderOnce()

  // PART 2: BUGGY PATH
  // Start with calculatorDiff, view="unified", wrapMode="none"
  // Press V (split), Press W (word), Press C (change to textDemoDiff)
  // This produces WRONG alignment due to stale lineInfo
  const parentContainer2 = new BoxRenderable(renderer, {
    id: "parent-container-2",
    padding: 1,
  })
  renderer.root.add(parentContainer2)

  const buggyDiff = new DiffRenderable(renderer, {
    id: "buggy-diff",
    diff: calculatorDiff, // Start with calculatorDiff (contentExamples[0])
    view: "unified",
    filetype: "typescript",
    syntaxStyle,
    showLineNumbers: true,
    wrapMode: "none",
    conceal: true,
    addedBg: theme.addedBg,
    removedBg: theme.removedBg,
    contextBg: theme.contextBg,
    addedSignColor: theme.addedSignColor,
    removedSignColor: theme.removedSignColor,
    lineNumberFg: theme.lineNumberFg,
    lineNumberBg: theme.lineNumberBg,
    addedLineNumberBg: theme.addedLineNumberBg,
    removedLineNumberBg: theme.removedLineNumberBg,
    selectionBg: theme.selectionBg,
    selectionFg: theme.selectionFg,
    flexGrow: 1,
    flexShrink: 1,
  })

  parentContainer2.add(buggyDiff)
  await renderOnce()

  // Press V - toggle to split view
  buggyDiff.view = "split"
  await Promise.resolve()
  await renderOnce()

  // Press W - toggle to word wrap
  buggyDiff.wrapMode = "word"
  await Promise.resolve()
  await renderOnce()

  // Press C - change diff content to textDemoDiff
  // THIS IS WHERE THE BUG MANIFESTS - lineInfo is STALE
  buggyDiff.diff = textDemoDiff
  buggyDiff.filetype = "typescript"
  await Promise.resolve()
  await renderOnce()
  await Promise.resolve()
  await renderOnce()

  const buggyFrame = captureFrame()

  // Clean up
  renderer.destroy()

  // ASSERTION: Both frames should be identical since they show the same diff content
  // with the same view settings (split + word wrap)
  // But due to the bug, the buggy frame has misaligned left/right sides because
  // the lineInfo from CodeRenderable is STALE after changing diff content
  expect(buggyFrame).toBe(correctFrame)
})

test("DiffRenderable - setLineColor applies color to line", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
  })

  diffRenderable.setLineColor(0, "#ff0000")
  diffRenderable.setLineColor(1, { gutter: "#00ff00", content: "#0000ff" })
  diffRenderable.clearLineColor(0)
  diffRenderable.clearLineColor(1)
})

test("DiffRenderable - highlightLines applies color to range", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: multiLineDiff,
    view: "unified",
    syntaxStyle,
  })

  diffRenderable.highlightLines(0, 3, "#ff0000")
  diffRenderable.clearHighlightLines(0, 3)
})

test("DiffRenderable - setLineColors and clearAllLineColors", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "unified",
    syntaxStyle,
  })

  const lineColors = new Map<number, string>()
  lineColors.set(0, "#ff0000")
  lineColors.set(1, "#00ff00")
  lineColors.set(2, "#0000ff")

  diffRenderable.setLineColors(lineColors)
  diffRenderable.clearAllLineColors()
})

test("DiffRenderable - line highlighting works in split view", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromValues(1, 1, 1, 1) },
  })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: simpleDiff,
    view: "split",
    syntaxStyle,
  })

  diffRenderable.setLineColor(0, "#ff0000")
  diffRenderable.highlightLines(0, 2, "#00ff00")
  diffRenderable.clearHighlightLines(0, 2)
  diffRenderable.clearAllLineColors()
})

const threeHunkDiff = `--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
 function first() {
-  return 1;
+  return "one";
 }
@@ -15,4 +15,5 @@
 function second() {
   var x = 10;
+  var y = 20;
   return x;
 }
@@ -30,3 +31,3 @@
 function third() {
-  console.log("old");
+  console.log("new");
 }`

test("DiffRenderable - getHunkRowOffsets returns the first row of each hunk (unified)", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: threeHunkDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Hunks flatten into one column: 4 lines, then 5 lines, then 4 lines.
  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 4, 9])
})

test("DiffRenderable - getHunkRowOffsets accounts for wrapped lines (unified)", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } })

  const longLine = "x".repeat(220)
  const wrappingDiff = `--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
 const short = 1;
-const removed = 2;
+const ${longLine} = 2;
 const after = 3;
@@ -20,3 +20,4 @@
 function second() {
   var value = 10;
+  var added = 20;
   return value;
@@ -40,3 +41,3 @@
 function third() {
-  console.log("old");
+  console.log("new");
 }`

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: wrappingDiff,
    view: "unified",
    syntaxStyle,
    showLineNumbers: true,
    wrapMode: "char",
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  const leftCode = (diffRenderable as any).leftCodeRenderable
  const sources: number[] = leftCode.lineInfo.lineSources

  // The wrapped line in the first hunk pushes the later hunks down by extra visual rows.
  expect(sources.length).toBeGreaterThan(12)
  expect(diffRenderable.getHunkRowOffsets()).toEqual([sources.indexOf(0), sources.indexOf(4), sources.indexOf(8)])
})

test("DiffRenderable - getHunkRowOffsets uses split-view rows (split)", async () => {
  const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } })

  const diffRenderable = new DiffRenderable(currentRenderer, {
    id: "test-diff",
    diff: threeHunkDiff,
    view: "split",
    syntaxStyle,
    showLineNumbers: true,
    width: "100%",
    height: "100%",
  })

  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  // Split view pairs adds/removes side by side, so the add-only second hunk leaves the
  // left column one row shorter than the unified flattening.
  expect(diffRenderable.getHunkRowOffsets()).toEqual([0, 3, 8])
})

test("DiffRenderable - getHunkRowOffsets is empty without a diff", async () => {
  const diffRenderable = new DiffRenderable(currentRenderer, { id: "test-diff" })
  currentRenderer.root.add(diffRenderable)
  await renderOnce()

  expect(diffRenderable.getHunkRowOffsets()).toEqual([])
})
