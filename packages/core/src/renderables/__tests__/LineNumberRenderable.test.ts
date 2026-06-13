import { afterEach, describe, test, expect } from "bun:test"
import { createTestRenderer as baseCreateTestRenderer, type TestRenderer } from "../../testing/test-renderer.js"
import { TextBufferRenderable } from "../TextBufferRenderable.js"
import { LineNumberRenderable } from "../LineNumberRenderable.js"
import { BoxRenderable } from "../Box.js"
import { TextareaRenderable } from "../Textarea.js"
import { t, fg, bold, cyan } from "../../lib/styled-text.js"
import { parseColor } from "../../lib/RGBA.js"
import type { CodeRenderable } from "../Code.js"

const HIGHLIGHT_TIMEOUT_MS = 5000

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

const initialContent = `Welcome to the TextareaRenderable Demo!

This is an interactive text editor powered by EditBuffer and EditorView.

\tThis is a tab
\t\t\tMultiple tabs

Emojis:
👩🏽‍💻  👨‍👩‍👧‍👦  🏳️‍🌈  🇺🇸  🇩🇪  🇯🇵  🇮🇳

NAVIGATION:
  • Arrow keys to move cursor
  • Home/End for line navigation
  • Ctrl+A/Ctrl+E for buffer start/end
  • Alt+F/Alt+B for word forward/backward
  • Alt+Left/Alt+Right for word forward/backward

SELECTION:
  • Shift+Arrow keys to select
  • Shift+Home/End to select to line start/end
  • Alt+Shift+F/B to select word forward/backward
  • Alt+Shift+Left/Right to select word forward/backward

EDITING:
  • Type any text to insert
  • Backspace/Delete to remove text
  • Enter to create new lines
  • Ctrl+D to delete current line
  • Ctrl+K to delete to line end
  • Alt+D to delete word forward
  • Alt+Backspace or Ctrl+W to delete word backward

UNDO/REDO:
  • Ctrl+Z to undo
  • Ctrl+Shift+Z or Ctrl+Y to redo

VIEW:
  • Shift+W to toggle wrap mode (word/char/none)
  • Shift+L to toggle line numbers

FEATURES:
  ✓ Grapheme-aware cursor movement
  ✓ Unicode (emoji 🌟 and CJK 世界, 你好世界, 中文, 한글)
  ✓ Incremental editing
  ✓ Text wrapping and viewport management
  ✓ Undo/redo support
  ✓ Word-based navigation and deletion
  ✓ Text selection with shift keys

Press ESC to return to main menu`

class MockTextBuffer extends TextBufferRenderable {
  constructor(ctx: any, options: any) {
    super(ctx, options)
    this.textBuffer.setText(options.text || "")
  }
}

const activeRenderers = new Set<TestRenderer>()

async function createTestRenderer(...args: Parameters<typeof baseCreateTestRenderer>) {
  const testRenderer = await baseCreateTestRenderer(...args)
  activeRenderers.add(testRenderer.renderer)
  return testRenderer
}

afterEach(() => {
  for (const renderer of activeRenderers) {
    renderer.destroy()
  }
  activeRenderers.clear()
})

describe("LineNumberRenderable", () => {
  test("renders line numbers correctly", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toMatchSnapshot()

    expect(frame).toContain(" 1 Line 1")
    expect(frame).toContain(" 2 Line 2")
    expect(frame).toContain(" 3 Line 3")
  })

  test("renders line numbers for wrapping text", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1 is very long and should wrap around multiple lines"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "auto",
      height: "100%",
      wrapMode: "char",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toMatchSnapshot()

    expect(frame).toContain(" 1 Line 1")
  })

  test("renders line colors for diff highlighting", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineColors = new Map<number, string>()
    lineColors.set(1, "#2d4a2e") // Green for line 2 (index 1)
    lineColors.set(3, "#4a2d2d") // Red for line 4 (index 3)

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      lineColors: lineColors,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const buffer = renderer.currentRenderBuffer
    const bgBuffer = buffer.buffers.bg

    // Helper to get RGBA values from buffer at position
    const getBgColor = (x: number, y: number) => {
      const offset = (y * buffer.width + x) * 4
      return {
        r: (bgBuffer[offset] & 0xff) / 255,
        g: (bgBuffer[offset + 1] & 0xff) / 255,
        b: (bgBuffer[offset + 2] & 0xff) / 255,
        a: (bgBuffer[offset + 3] & 0xff) / 255,
      }
    }

    // Check line 2 (index 1) has green background in gutter (x=2 is in the gutter)
    const line2GutterBg = getBgColor(2, 1)
    expect(line2GutterBg.r).toBeCloseTo(0x2d / 255, 2)
    expect(line2GutterBg.g).toBeCloseTo(0x4a / 255, 2)
    expect(line2GutterBg.b).toBeCloseTo(0x2e / 255, 2)

    // Check line 2 (index 1) has darker green background in content area (x=10 is in content)
    // Content color should be 80% of gutter color
    const line2ContentBg = getBgColor(10, 1)
    expect(line2ContentBg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line2ContentBg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line2ContentBg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)

    // Check line 4 (index 3) has red background in gutter
    const line4GutterBg = getBgColor(2, 3)
    expect(line4GutterBg.r).toBeCloseTo(0x4a / 255, 2)
    expect(line4GutterBg.g).toBeCloseTo(0x2d / 255, 2)
    expect(line4GutterBg.b).toBeCloseTo(0x2d / 255, 2)

    // Check line 4 (index 3) has darker red background in content area (80% of gutter color)
    const line4ContentBg = getBgColor(10, 3)
    expect(line4ContentBg.r).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line4ContentBg.g).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line4ContentBg.b).toBeCloseTo((0x2d / 255) * 0.8, 2)

    // Check line 1 (index 0) has default black background in gutter
    const line1GutterBg = getBgColor(2, 0)
    expect(line1GutterBg.r).toBeCloseTo(0, 2)
    expect(line1GutterBg.g).toBeCloseTo(0, 2)
    expect(line1GutterBg.b).toBeCloseTo(0, 2)
  })

  test("can dynamically update line colors", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const buffer = renderer.currentRenderBuffer
    const bgBuffer = buffer.buffers.bg

    // Helper to get RGBA values from buffer at position
    const getBgColor = (x: number, y: number) => {
      const offset = (y * buffer.width + x) * 4
      return {
        r: (bgBuffer[offset] & 0xff) / 255,
        g: (bgBuffer[offset + 1] & 0xff) / 255,
        b: (bgBuffer[offset + 2] & 0xff) / 255,
        a: (bgBuffer[offset + 3] & 0xff) / 255,
      }
    }

    // Initially no colors
    const line2InitialBg = getBgColor(2, 1)
    expect(line2InitialBg.r).toBeCloseTo(0, 2)
    expect(line2InitialBg.g).toBeCloseTo(0, 2)
    expect(line2InitialBg.b).toBeCloseTo(0, 2)

    // Set line color using setter (gutter will be full color, content will be 80%)
    lineNumberRenderable.setLineColor(1, "#2d4a2e")
    await renderOnce()

    // Check gutter has full color
    const line2AfterSetBg = getBgColor(2, 1)
    expect(line2AfterSetBg.r).toBeCloseTo(0x2d / 255, 2)
    expect(line2AfterSetBg.g).toBeCloseTo(0x4a / 255, 2)
    expect(line2AfterSetBg.b).toBeCloseTo(0x2e / 255, 2)

    // Check content has darker color (80%)
    const line2ContentAfterSetBg = getBgColor(10, 1)
    expect(line2ContentAfterSetBg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line2ContentAfterSetBg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line2ContentAfterSetBg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)

    // Clear the line color
    lineNumberRenderable.clearLineColor(1)
    await renderOnce()

    const line2AfterClearBg = getBgColor(2, 1)
    expect(line2AfterClearBg.r).toBeCloseTo(0, 2)
    expect(line2AfterClearBg.g).toBeCloseTo(0, 2)
    expect(line2AfterClearBg.b).toBeCloseTo(0, 2)

    // Set multiple colors
    const newColors = new Map<number, string>()
    newColors.set(0, "#2d4a2e") // Green for line 1
    newColors.set(2, "#4a2d2d") // Red for line 3
    lineNumberRenderable.setLineColors(newColors)
    await renderOnce()

    // Check gutter colors (full color)
    const line1Bg = getBgColor(2, 0)
    expect(line1Bg.r).toBeCloseTo(0x2d / 255, 2)
    expect(line1Bg.g).toBeCloseTo(0x4a / 255, 2)
    expect(line1Bg.b).toBeCloseTo(0x2e / 255, 2)

    const line3Bg = getBgColor(2, 2)
    expect(line3Bg.r).toBeCloseTo(0x4a / 255, 2)
    expect(line3Bg.g).toBeCloseTo(0x2d / 255, 2)
    expect(line3Bg.b).toBeCloseTo(0x2d / 255, 2)

    // Check content colors (80% darker)
    const line1ContentBg = getBgColor(10, 0)
    expect(line1ContentBg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line1ContentBg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line1ContentBg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)

    const line3ContentBg = getBgColor(10, 2)
    expect(line3ContentBg.r).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line3ContentBg.g).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line3ContentBg.b).toBeCloseTo((0x2d / 255) * 0.8, 2)

    // Clear all colors
    lineNumberRenderable.clearAllLineColors()
    await renderOnce()

    const line1AfterClearAllBg = getBgColor(2, 0)
    expect(line1AfterClearAllBg.r).toBeCloseTo(0, 2)
    expect(line1AfterClearAllBg.g).toBeCloseTo(0, 2)
    expect(line1AfterClearAllBg.b).toBeCloseTo(0, 2)
  })

  test("renders line colors for wrapped lines", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1 is very long and should wrap around multiple lines\nLine 2"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "auto",
      height: "100%",
      wrapMode: "char",
    })

    const lineColors = new Map<number, string>()
    lineColors.set(0, "#2d4a2e") // Green for line 1 (index 0, which wraps)

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      lineColors: lineColors,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const buffer = renderer.currentRenderBuffer
    const bgBuffer = buffer.buffers.bg

    // Helper to get RGBA values from buffer at position
    const getBgColor = (x: number, y: number) => {
      const offset = (y * buffer.width + x) * 4
      return {
        r: (bgBuffer[offset] & 0xff) / 255,
        g: (bgBuffer[offset + 1] & 0xff) / 255,
        b: (bgBuffer[offset + 2] & 0xff) / 255,
        a: (bgBuffer[offset + 3] & 0xff) / 255,
      }
    }

    // First visual line of logical line 0 should have green background in gutter
    const line0Visual0GutterBg = getBgColor(2, 0)
    expect(line0Visual0GutterBg.r).toBeCloseTo(0x2d / 255, 2)
    expect(line0Visual0GutterBg.g).toBeCloseTo(0x4a / 255, 2)
    expect(line0Visual0GutterBg.b).toBeCloseTo(0x2e / 255, 2)

    // First visual line of logical line 0 should have darker green background in content (80%)
    const line0Visual0ContentBg = getBgColor(10, 0)
    expect(line0Visual0ContentBg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line0Visual0ContentBg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line0Visual0ContentBg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)

    // Second visual line of logical line 0 should also have darker green background (wrapped continuation)
    const line0Visual1Bg = getBgColor(10, 1)
    expect(line0Visual1Bg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line0Visual1Bg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line0Visual1Bg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)

    // Third visual line of logical line 0 should also have darker green background (wrapped continuation)
    const line0Visual2Bg = getBgColor(10, 2)
    expect(line0Visual2Bg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line0Visual2Bg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line0Visual2Bg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)
  })

  test("renders line colors correctly within a box with borders", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 30,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineColors = new Map<number, string>()
    lineColors.set(1, "#2d4a2e") // Green for line 2 (index 1)
    lineColors.set(3, "#4a2d2d") // Red for line 4 (index 3)

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      lineColors: lineColors,
      width: "100%",
      height: "100%",
    })

    const box = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "single",
      borderColor: "#ffffff",
      backgroundColor: "#000000",
      width: "100%",
      height: "100%",
      padding: 1,
    })

    box.add(lineNumberRenderable)
    renderer.root.add(box)

    await renderOnce()

    const buffer = renderer.currentRenderBuffer
    const bgBuffer = buffer.buffers.bg
    const charBuffer = buffer.buffers.char

    // Helper to get RGBA values from buffer at position
    const getBgColor = (x: number, y: number) => {
      const offset = (y * buffer.width + x) * 4
      return {
        r: (bgBuffer[offset] & 0xff) / 255,
        g: (bgBuffer[offset + 1] & 0xff) / 255,
        b: (bgBuffer[offset + 2] & 0xff) / 255,
        a: (bgBuffer[offset + 3] & 0xff) / 255,
      }
    }

    const getChar = (x: number, y: number) => {
      return charBuffer[y * buffer.width + x]
    }

    // Box has borders at x=0 (left) and x=29 (right)
    // Box has padding of 1, so content starts at x=2 (after left border + padding)
    // Gutter is about 5 chars wide (minWidth 3 + padding + margin)
    // Content starts around x=7

    // Line 2 (y=3, accounting for top border + padding + 1 line)
    const line2Y = 3

    // Check that left border is NOT colored (should be white border)
    const leftBorderChar = getChar(0, line2Y)
    expect(leftBorderChar).toBe(0x2502) // Vertical line character │

    // Check that right border is NOT colored (should be white border)
    const rightBorderChar = getChar(29, line2Y)
    expect(rightBorderChar).toBe(0x2502) // Vertical line character │

    // Check that gutter area (inside padding) has green background
    const gutterBg = getBgColor(4, line2Y)
    expect(gutterBg.r).toBeCloseTo(0x2d / 255, 2)
    expect(gutterBg.g).toBeCloseTo(0x4a / 255, 2)
    expect(gutterBg.b).toBeCloseTo(0x2e / 255, 2)

    // Check that content area has darker green background (80% of gutter color)
    const contentBg = getBgColor(15, line2Y)
    expect(contentBg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(contentBg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(contentBg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)

    // Check that area near right border (but not the border itself) has darker green background
    const nearRightBg = getBgColor(27, line2Y)
    expect(nearRightBg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(nearRightBg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(nearRightBg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)

    // Verify line without color (line 1, y=2) doesn't have green background
    const line1Y = 2
    const line1ContentBg = getBgColor(15, line1Y)
    expect(line1ContentBg.r).toBeCloseTo(0, 2)
    expect(line1ContentBg.g).toBeCloseTo(0, 2)
    expect(line1ContentBg.b).toBeCloseTo(0, 2)
  })

  test("renders full-width line colors when line numbers are hidden", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineColors = new Map<number, string>()
    lineColors.set(1, "#2d4a2e") // Green for line 2 (index 1)

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      lineColors: lineColors,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    // First render with line numbers visible
    await renderOnce()
    const frameWithLineNumbers = captureCharFrame()

    // Hide line numbers
    lineNumberRenderable.showLineNumbers = false

    await renderOnce()
    const frameWithoutLineNumbers = captureCharFrame()

    const buffer = renderer.currentRenderBuffer
    const bgBuffer = buffer.buffers.bg

    // Helper to get RGBA values from buffer at position
    const getBgColor = (x: number, y: number) => {
      const offset = (y * buffer.width + x) * 4
      return {
        r: (bgBuffer[offset] & 0xff) / 255,
        g: (bgBuffer[offset + 1] & 0xff) / 255,
        b: (bgBuffer[offset + 2] & 0xff) / 255,
        a: (bgBuffer[offset + 3] & 0xff) / 255,
      }
    }

    // Debug: check if text moved to x=0
    expect(frameWithoutLineNumbers).toContain("Line 1")
    expect(frameWithoutLineNumbers.split("\n")[1]).toMatch(/^Line 2/)

    // When line numbers are hidden, the content background (darker, 80%) should start at x=0
    const line2LeftEdgeBg = getBgColor(0, 1)
    expect(line2LeftEdgeBg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line2LeftEdgeBg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line2LeftEdgeBg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)

    // Check middle of line also has darker background
    const line2MiddleBg = getBgColor(10, 1)
    expect(line2MiddleBg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line2MiddleBg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line2MiddleBg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)

    // Check right edge has darker background
    const line2RightEdgeBg = getBgColor(19, 1)
    expect(line2RightEdgeBg.r).toBeCloseTo((0x2d / 255) * 0.8, 2)
    expect(line2RightEdgeBg.g).toBeCloseTo((0x4a / 255) * 0.8, 2)
    expect(line2RightEdgeBg.b).toBeCloseTo((0x2e / 255) * 0.8, 2)
  })

  test("renders line signs before and after line numbers", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 30,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineSigns = new Map<number, any>()
    lineSigns.set(1, { after: "+" }) // Line 2: Added
    lineSigns.set(3, { after: "-" }) // Line 4: Removed
    lineSigns.set(0, { before: "⚠️" }) // Line 1: Warning

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      lineSigns: lineSigns,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const frame = captureCharFrame()

    // Check that signs are present
    expect(frame).toContain("⚠️") // Warning emoji before line 1
    expect(frame).toContain("+") // Plus after line 2
    expect(frame).toContain("-") // Minus after line 4

    // Verify structure: should have emoji, line number, and +/- signs
    const lines = frame.split("\n")
    expect(lines[0]).toMatch(/⚠️.*1/) // Line 1 has warning before number
    expect(lines[1]).toMatch(/2.*\+/) // Line 2 has + after number
    expect(lines[3]).toMatch(/4.*-/) // Line 4 has - after number
  })

  test("renders line signs with custom colors", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 30,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineSigns = new Map<number, any>()
    lineSigns.set(1, { after: " +", afterColor: "#22c55e" }) // Bright green plus
    lineSigns.set(0, { before: "❌", beforeColor: "#ef4444" }) // Bright red error

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#888888",
      bg: "#000000",
      lineSigns: lineSigns,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const buffer = renderer.currentRenderBuffer
    const fgBuffer = buffer.buffers.fg

    // Helper to get RGBA values from buffer at position
    const getFgColor = (x: number, y: number) => {
      const offset = (y * buffer.width + x) * 4
      return {
        r: (fgBuffer[offset] & 0xff) / 255,
        g: (fgBuffer[offset + 1] & 0xff) / 255,
        b: (fgBuffer[offset + 2] & 0xff) / 255,
        a: (fgBuffer[offset + 3] & 0xff) / 255,
      }
    }

    // Find the position of the + sign on line 2 (y=1)
    // It should be after the line number, so around x=7-8
    // Check that it has green color (#22c55e = rgb(34, 197, 94))
    let foundGreenPlus = false
    for (let x = 5; x < 10; x++) {
      const fg = getFgColor(x, 1)
      // Check if color is close to green
      if (Math.abs(fg.g - 197 / 255) < 0.05 && fg.r < 0.2 && fg.b < 0.5) {
        foundGreenPlus = true
        break
      }
    }
    expect(foundGreenPlus).toBe(true)

    // Find the emoji on line 1 (y=0)
    // It should have red color (#ef4444 = rgb(239, 68, 68))
    let foundRedEmoji = false
    for (let x = 0; x < 5; x++) {
      const fg = getFgColor(x, 0)
      // Check if color is close to red
      if (Math.abs(fg.r - 239 / 255) < 0.05 && fg.g < 0.4 && fg.b < 0.4) {
        foundRedEmoji = true
        break
      }
    }
    expect(foundRedEmoji).toBe(true)
  })

  test("dynamically updates line signs", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 30,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()
    let frame = captureCharFrame()
    expect(frame).not.toContain("+")

    // Add a sign
    lineNumberRenderable.setLineSign(1, { after: "+" })
    await renderOnce()
    frame = captureCharFrame()
    expect(frame).toContain("+")

    // Clear the sign
    lineNumberRenderable.clearLineSign(1)
    await renderOnce()
    frame = captureCharFrame()
    expect(frame).not.toContain("+")
  })

  test("renders line numbers with offset", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      lineNumberOffset: 41, // Start at line 42
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toMatchSnapshot()

    // Line numbers should start at 42 instead of 1
    expect(frame).toContain("42 Line 1")
    expect(frame).toContain("43 Line 2")
    expect(frame).toContain("44 Line 3")
  })

  test("can dynamically update line number offset", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      lineNumberOffset: 0,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    let frame = captureCharFrame()
    expect(frame).toContain(" 1 Line 1")
    expect(frame).toContain(" 2 Line 2")

    // Update offset
    lineNumberRenderable.lineNumberOffset = 99
    await renderOnce()

    frame = captureCharFrame()
    expect(frame).toContain("100 Line 1")
    expect(frame).toContain("101 Line 2")
    expect(frame).toContain("102 Line 3")
  })

  test("can dynamically update gutter fg and bg colors", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 5,
    })

    const textRenderable = new MockTextBuffer(renderer, {
      text: "alpha\nbeta",
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      fg: "#ffffff",
      bg: "#000000",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)
    await renderOnce()

    const findCharX = (char: string, y: number) => {
      const buffer = renderer.currentRenderBuffer
      const charBuffer = buffer.buffers.char
      const codePoint = char.codePointAt(0)
      if (codePoint === undefined) return -1

      for (let x = 0; x < buffer.width; x++) {
        if (charBuffer[y * buffer.width + x] === codePoint) {
          return x
        }
      }
      return -1
    }

    const getColorAt = (channel: "fg" | "bg", x: number, y: number) => {
      const buffer = renderer.currentRenderBuffer
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

    const line1NumberX = findCharX("1", 0)
    expect(line1NumberX).toBeGreaterThanOrEqual(0)

    lineNumberRenderable.fg = "#ff0000"
    lineNumberRenderable.bg = "#123456"
    await renderOnce()

    expectColorClose(getColorAt("fg", line1NumberX, 0), parseColor("#ff0000"))
    expectColorClose(getColorAt("bg", line1NumberX, 0), parseColor("#123456"))

    lineNumberRenderable.fg = "#00ff00"
    lineNumberRenderable.bg = "#654321"
    await renderOnce()

    expectColorClose(getColorAt("fg", line1NumberX, 0), parseColor("#00ff00"))
    expectColorClose(getColorAt("bg", line1NumberX, 0), parseColor("#654321"))
  })

  test("hides line numbers for specific lines", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const hideLineNumbers = new Set<number>()
    hideLineNumbers.add(1) // Hide line 2
    hideLineNumbers.add(3) // Hide line 4

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      hideLineNumbers,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toMatchSnapshot()

    // Check that lines 1, 3, 5 have line numbers
    expect(frame).toContain(" 1 Line 1")
    expect(frame).toContain(" 3 Line 3")
    expect(frame).toContain(" 5 Line 5")

    // Lines 2 and 4 should not have line numbers (but text is still visible)
    const lines = frame.split("\n")

    // Line 2 should have text but no line number visible
    expect(lines[1]).toContain("Line 2")
    expect(lines[1]).not.toMatch(/2\s+Line 2/)

    // Line 4 should have text but no line number visible
    expect(lines[3]).toContain("Line 4")
    expect(lines[3]).not.toMatch(/4\s+Line 4/)
  })

  test("can dynamically update hidden line numbers", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    let frame = captureCharFrame()
    expect(frame).toContain(" 1 Line 1")
    expect(frame).toContain(" 2 Line 2")
    expect(frame).toContain(" 3 Line 3")

    // Hide line 2
    const hideSet = new Set<number>()
    hideSet.add(1)
    lineNumberRenderable.setHideLineNumbers(hideSet)
    await renderOnce()

    frame = captureCharFrame()
    expect(frame).toContain(" 1 Line 1")
    expect(frame).toContain("Line 2") // Text still visible
    expect(frame).toContain(" 3 Line 3")

    const lines = frame.split("\n")
    expect(lines[1]).not.toMatch(/2\s+Line 2/)
  })

  test("combines line number offset with hidden line numbers", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const hideLineNumbers = new Set<number>()
    hideLineNumbers.add(1) // Hide line at logical index 1
    hideLineNumbers.add(3) // Hide line at logical index 3

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      lineNumberOffset: 41, // Start at line 42
      hideLineNumbers,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toMatchSnapshot()

    // Line 1 (index 0) should show as line 42
    expect(frame).toContain("42 Line 1")

    // Line 2 (index 1) should be hidden (but text visible)
    expect(frame).toContain("Line 2")
    const lines = frame.split("\n")
    expect(lines[1]).not.toMatch(/43\s+Line 2/)

    // Line 3 (index 2) should show as line 44
    expect(frame).toContain("44 Line 3")

    // Line 4 (index 3) should be hidden
    expect(frame).toContain("Line 4")
    expect(lines[3]).not.toMatch(/45\s+Line 4/)

    // Line 5 (index 4) should show as line 46
    expect(frame).toContain("46 Line 5")
  })

  test("gutter width is stable from first render - no width glitch", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    // First render - this is when layout happens
    await renderOnce()

    // Capture width after first render
    const gutterAfterFirstRender = lineNumberRenderable["gutter"]
    const widthAfterFirstRender = gutterAfterFirstRender?.width

    expect(widthAfterFirstRender).toBeGreaterThan(0)

    // Render a second time - width should NOT change (no glitch)
    await renderOnce()

    const widthAfterSecondRender = lineNumberRenderable["gutter"]?.width
    expect(widthAfterSecondRender).toBe(widthAfterFirstRender)

    // Render a third time to be absolutely sure
    await renderOnce()

    const widthAfterThirdRender = lineNumberRenderable["gutter"]?.width
    expect(widthAfterThirdRender).toBe(widthAfterFirstRender)
  })

  test("gutter width accounts for large line numbers from first render", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 30,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      lineNumberOffset: 997, // Will show lines 998, 999, 1000 (4 digits)
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    // First render - this is when layout happens
    await renderOnce()

    // Capture width after first render
    const gutterAfterFirstRender = lineNumberRenderable["gutter"]
    const widthAfterFirstRender = gutterAfterFirstRender?.width

    // Width should be at least 5 (for "1000" which is 4 digits + padding)
    expect(widthAfterFirstRender).toBeGreaterThanOrEqual(5)

    // Render again - width should NOT change (no glitch)
    await renderOnce()

    const widthAfterSecondRender = lineNumberRenderable["gutter"]?.width
    expect(widthAfterSecondRender).toBe(widthAfterFirstRender)

    // Render a third time to be absolutely sure
    await renderOnce()

    const widthAfterThirdRender = lineNumberRenderable["gutter"]?.width
    expect(widthAfterThirdRender).toBe(widthAfterFirstRender)
  })

  // TODO: flaky - works locally but fails in CI every time
  test.skip("handles async content loading in Code renderable with drawUnstyledText=false", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 30,
      height: 10,
    })

    // Import Code renderable
    const { CodeRenderable } = await import("../Code.js")
    const { SyntaxStyle } = await import("../../syntax-style.js")

    const syntaxStyle = SyntaxStyle.create()

    // Create Code renderable with no initial content and drawUnstyledText=false
    const codeRenderable = new CodeRenderable(renderer, {
      content: "",
      filetype: "typescript",
      syntaxStyle,
      drawUnstyledText: false,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: codeRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    // First render - no content yet
    await renderOnce()

    let frame = captureCharFrame()

    // Should have minimal lines (empty buffer may show 1 line)
    const initialLineCount = codeRenderable.virtualLineCount
    expect(initialLineCount).toBeLessThanOrEqual(1)

    // Now set content on the Code renderable
    const code = `function hello() {\n  console.log("Hello");\n}`
    codeRenderable.content = code

    // Wait for render and highlighting
    await renderOnce()
    await waitForHighlight(codeRenderable)
    await renderOnce()

    frame = captureCharFrame()

    // Should now show line numbers for the content
    expect(codeRenderable.virtualLineCount).toBe(3)
    expect(frame).toContain("function")
    expect(frame).toContain("console")

    // Check that line numbers are present
    const lines = frame.split("\n")
    expect(lines[0]).toMatch(/1/)
    expect(lines[1]).toMatch(/2/)
    expect(lines[2]).toMatch(/3/)
  })

  test("updates line numbers when Code renderable content changes", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 30,
      height: 10,
    })

    const { CodeRenderable } = await import("../Code.js")
    const { SyntaxStyle } = await import("../../syntax-style.js")

    const syntaxStyle = SyntaxStyle.create()

    // Create Code renderable with initial content
    const codeRenderable = new CodeRenderable(renderer, {
      content: "line 1\nline 2",
      filetype: "typescript",
      syntaxStyle,
      drawUnstyledText: true,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: codeRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    // First render
    await renderOnce()
    await waitForHighlight(codeRenderable)
    await renderOnce()

    let frame = captureCharFrame()

    // Should show 2 lines
    expect(codeRenderable.virtualLineCount).toBe(2)
    expect(frame).toContain("line 1")
    expect(frame).toContain("line 2")

    // Now update content to have more lines
    codeRenderable.content = "line 1\nline 2\nline 3\nline 4\nline 5"

    await renderOnce()
    await waitForHighlight(codeRenderable)
    await renderOnce()

    frame = captureCharFrame()

    // Should now show 5 lines
    expect(codeRenderable.virtualLineCount).toBe(5)
    expect(frame).toContain("line 5")

    // Check that line numbers are present for all 5 lines
    const lines = frame.split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(5)
    expect(lines[0]).toMatch(/1/)
    expect(lines[4]).toMatch(/5/)
  })

  test("handles Code renderable switching from no filetype to having filetype", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 30,
      height: 10,
    })

    const { CodeRenderable } = await import("../Code.js")
    const { SyntaxStyle } = await import("../../syntax-style.js")

    const syntaxStyle = SyntaxStyle.create()

    // Create Code renderable with content but no filetype (plain text fallback)
    const codeRenderable = new CodeRenderable(renderer, {
      content: "function test() {\n  return 42;\n}",
      filetype: undefined,
      syntaxStyle,
      drawUnstyledText: true,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: codeRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    // First render - plain text
    await renderOnce()

    let frame = captureCharFrame()

    expect(codeRenderable.virtualLineCount).toBe(3)
    expect(frame).toContain("function")

    // Now set filetype to enable syntax highlighting
    codeRenderable.filetype = "typescript"

    await renderOnce()
    await waitForHighlight(codeRenderable)
    await renderOnce()

    frame = captureCharFrame()

    // Should still show 3 lines with highlighting
    expect(codeRenderable.virtualLineCount).toBe(3)
    expect(frame).toContain("function")

    // Line numbers should be present
    const lines = frame.split("\n")
    expect(lines[0]).toMatch(/1/)
    expect(lines[2]).toMatch(/3/)
  })

  test("maintains consistent left padding for all line numbers", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 30,
      height: 15,
    })

    // Create content with 12 lines so we have both 1-digit (1-9) and 2-digit (10-12) line numbers
    const lines = []
    for (let i = 1; i <= 12; i++) {
      lines.push(`Line ${i}`)
    }
    const text = lines.join("\n")

    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "white",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toMatchSnapshot()

    const frameLines = frame.split("\n")

    // Extract the gutter portion (everything before "Line X")
    // For 1-digit line numbers (1-9), they are right-aligned in a 2-digit space
    // For 2-digit line numbers (10-12), they fill the 2-digit space
    // Both should have 1 space of left padding

    // Line 1 should have format: "  1 Line 1" (1 left pad + 1 space for alignment + "1" + 1 paddingRight)
    expect(frameLines[0]).toMatch(/^  1 Line 1/)
    const line1Match = frameLines[0].match(/^( +)1 /)
    expect(line1Match).toBeTruthy()
    expect(line1Match![1].length).toBe(2) // 1 left padding + 1 alignment space

    // Line 9 should also have the same format as line 1
    expect(frameLines[8]).toMatch(/^  9 Line 9/)
    const line9Match = frameLines[8].match(/^( +)9 /)
    expect(line9Match).toBeTruthy()
    expect(line9Match![1].length).toBe(2) // 1 left padding + 1 alignment space

    // Line 10 should have format: " 10 Line 10" (1 left pad + "10" + 1 paddingRight)
    expect(frameLines[9]).toMatch(/^ 10 Line 10/)
    const line10Match = frameLines[9].match(/^( +)10 /)
    expect(line10Match).toBeTruthy()
    expect(line10Match![1].length).toBe(1) // Just 1 left padding

    // All lines should have at least 1 space of left padding before the first digit
    for (let i = 0; i < 12; i++) {
      const lineMatch = frameLines[i].match(/^( +)\d+/)
      expect(lineMatch).toBeTruthy()
      expect(lineMatch![1].length).toBeGreaterThanOrEqual(1)
    }
  })

  test("supports separate gutter and content colors with LineColorConfig", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineColors = new Map<number, any>()
    lineColors.set(1, { gutter: "#2d4a2e", content: "#1a2e1f" }) // Different colors for gutter and content

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      lineColors: lineColors,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const buffer = renderer.currentRenderBuffer
    const bgBuffer = buffer.buffers.bg

    const getBgColor = (x: number, y: number) => {
      const offset = (y * buffer.width + x) * 4
      return {
        r: (bgBuffer[offset] & 0xff) / 255,
        g: (bgBuffer[offset + 1] & 0xff) / 255,
        b: (bgBuffer[offset + 2] & 0xff) / 255,
        a: (bgBuffer[offset + 3] & 0xff) / 255,
      }
    }

    // Check line 2 (index 1) has the specified gutter color in gutter area (x=2)
    const line2GutterBg = getBgColor(2, 1)
    expect(line2GutterBg.r).toBeCloseTo(0x2d / 255, 2)
    expect(line2GutterBg.g).toBeCloseTo(0x4a / 255, 2)
    expect(line2GutterBg.b).toBeCloseTo(0x2e / 255, 2)

    // Check line 2 (index 1) has the specified content color in content area (x=10)
    const line2ContentBg = getBgColor(10, 1)
    expect(line2ContentBg.r).toBeCloseTo(0x1a / 255, 2)
    expect(line2ContentBg.g).toBeCloseTo(0x2e / 255, 2)
    expect(line2ContentBg.b).toBeCloseTo(0x1f / 255, 2)
  })

  test("defaults content color to darker gutter color when only gutter is specified", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineColors = new Map<number, any>()
    lineColors.set(1, { gutter: "#50fa7b" }) // Only gutter color specified

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      lineColors: lineColors,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const buffer = renderer.currentRenderBuffer
    const bgBuffer = buffer.buffers.bg

    const getBgColor = (x: number, y: number) => {
      const offset = (y * buffer.width + x) * 4
      return {
        r: (bgBuffer[offset] & 0xff) / 255,
        g: (bgBuffer[offset + 1] & 0xff) / 255,
        b: (bgBuffer[offset + 2] & 0xff) / 255,
        a: (bgBuffer[offset + 3] & 0xff) / 255,
      }
    }

    // Check line 2 (index 1) has the specified gutter color in gutter area (x=2)
    const line2GutterBg = getBgColor(2, 1)
    const expectedGutterR = 0x50 / 255
    const expectedGutterG = 0xfa / 255
    const expectedGutterB = 0x7b / 255
    expect(line2GutterBg.r).toBeCloseTo(expectedGutterR, 2)
    expect(line2GutterBg.g).toBeCloseTo(expectedGutterG, 2)
    expect(line2GutterBg.b).toBeCloseTo(expectedGutterB, 2)

    // Check line 2 (index 1) has a darker color (80%) in content area (x=10)
    const line2ContentBg = getBgColor(10, 1)
    expect(line2ContentBg.r).toBeCloseTo(expectedGutterR * 0.8, 2)
    expect(line2ContentBg.g).toBeCloseTo(expectedGutterG * 0.8, 2)
    expect(line2ContentBg.b).toBeCloseTo(expectedGutterB * 0.8, 2)
  })

  test("defaults content color to 80% of gutter when using simple string color format", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineColors = new Map<number, string>()
    lineColors.set(1, "#ff5555") // Simple string format

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      lineColors: lineColors,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const buffer = renderer.currentRenderBuffer
    const bgBuffer = buffer.buffers.bg

    const getBgColor = (x: number, y: number) => {
      const offset = (y * buffer.width + x) * 4
      return {
        r: (bgBuffer[offset] & 0xff) / 255,
        g: (bgBuffer[offset + 1] & 0xff) / 255,
        b: (bgBuffer[offset + 2] & 0xff) / 255,
        a: (bgBuffer[offset + 3] & 0xff) / 255,
      }
    }

    // Check line 2 (index 1) has the specified color in gutter area (x=2)
    const line2GutterBg = getBgColor(2, 1)
    const expectedGutterR = 0xff / 255
    const expectedGutterG = 0x55 / 255
    const expectedGutterB = 0x55 / 255
    expect(line2GutterBg.r).toBeCloseTo(expectedGutterR, 2)
    expect(line2GutterBg.g).toBeCloseTo(expectedGutterG, 2)
    expect(line2GutterBg.b).toBeCloseTo(expectedGutterB, 2)

    // Check line 2 (index 1) has a darker color (80%) in content area (x=10)
    const line2ContentBg = getBgColor(10, 1)
    expect(line2ContentBg.r).toBeCloseTo(expectedGutterR * 0.8, 2)
    expect(line2ContentBg.g).toBeCloseTo(expectedGutterG * 0.8, 2)
    expect(line2ContentBg.b).toBeCloseTo(expectedGutterB * 0.8, 2)
  })

  test("dynamically updates line colors with LineColorConfig", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const buffer = renderer.currentRenderBuffer
    const bgBuffer = buffer.buffers.bg

    const getBgColor = (x: number, y: number) => {
      const offset = (y * buffer.width + x) * 4
      return {
        r: (bgBuffer[offset] & 0xff) / 255,
        g: (bgBuffer[offset + 1] & 0xff) / 255,
        b: (bgBuffer[offset + 2] & 0xff) / 255,
        a: (bgBuffer[offset + 3] & 0xff) / 255,
      }
    }

    // Set line color using LineColorConfig with setLineColor
    lineNumberRenderable.setLineColor(1, { gutter: "#2d4a2e", content: "#1a2e1f" })
    await renderOnce()

    // Check gutter color
    const line2GutterBg = getBgColor(2, 1)
    expect(line2GutterBg.r).toBeCloseTo(0x2d / 255, 2)
    expect(line2GutterBg.g).toBeCloseTo(0x4a / 255, 2)
    expect(line2GutterBg.b).toBeCloseTo(0x2e / 255, 2)

    // Check content color
    const line2ContentBg = getBgColor(10, 1)
    expect(line2ContentBg.r).toBeCloseTo(0x1a / 255, 2)
    expect(line2ContentBg.g).toBeCloseTo(0x2e / 255, 2)
    expect(line2ContentBg.b).toBeCloseTo(0x1f / 255, 2)

    // Clear the line color
    lineNumberRenderable.clearLineColor(1)
    await renderOnce()

    const line2AfterClearBg = getBgColor(2, 1)
    expect(line2AfterClearBg.r).toBeCloseTo(0, 2)
    expect(line2AfterClearBg.g).toBeCloseTo(0, 2)
    expect(line2AfterClearBg.b).toBeCloseTo(0, 2)
  })

  test("getLineColors returns both gutter and content color maps", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineColors = new Map<number, any>()
    lineColors.set(1, { gutter: "#2d4a2e", content: "#1a2e1f" })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      lineColors: lineColors,
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)

    await renderOnce()

    const colors = lineNumberRenderable.getLineColors()
    expect(colors.gutter.size).toBe(1)
    expect(colors.content.size).toBe(1)

    const gutterColor = colors.gutter.get(1)
    expect(gutterColor).toBeDefined()
    expect(gutterColor!.r).toBeCloseTo(0x2d / 255, 2)
    expect(gutterColor!.g).toBeCloseTo(0x4a / 255, 2)
    expect(gutterColor!.b).toBeCloseTo(0x2e / 255, 2)

    const contentColor = colors.content.get(1)
    expect(contentColor).toBeDefined()
    expect(contentColor!.r).toBeCloseTo(0x1a / 255, 2)
    expect(contentColor!.g).toBeCloseTo(0x2e / 255, 2)
    expect(contentColor!.b).toBeCloseTo(0x1f / 255, 2)
  })

  test("highlightLines applies color to a range of lines", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)
    await renderOnce()

    lineNumberRenderable.highlightLines(1, 3, "#2d4a2e")
    await renderOnce()

    const colors = lineNumberRenderable.getLineColors()
    expect(colors.gutter.has(0)).toBe(false)
    expect(colors.gutter.has(1)).toBe(true)
    expect(colors.gutter.has(2)).toBe(true)
    expect(colors.gutter.has(3)).toBe(true)
    expect(colors.gutter.has(4)).toBe(false)
  })

  test("clearHighlightLines removes color from a range of lines", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 20,
      height: 10,
    })

    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const textRenderable = new MockTextBuffer(renderer, {
      text,
      width: "100%",
      height: "100%",
    })

    const lineNumberRenderable = new LineNumberRenderable(renderer, {
      target: textRenderable,
      minWidth: 3,
      paddingRight: 1,
      fg: "#ffffff",
      bg: "#000000",
      width: "100%",
      height: "100%",
    })

    renderer.root.add(lineNumberRenderable)
    await renderOnce()

    lineNumberRenderable.highlightLines(0, 4, "#2d4a2e")
    await renderOnce()

    lineNumberRenderable.clearHighlightLines(1, 3)
    await renderOnce()

    const colors = lineNumberRenderable.getLineColors()
    expect(colors.gutter.has(0)).toBe(true)
    expect(colors.gutter.has(1)).toBe(false)
    expect(colors.gutter.has(2)).toBe(false)
    expect(colors.gutter.has(3)).toBe(false)
    expect(colors.gutter.has(4)).toBe(true)
  })

  test("maintains stable visual line count when scrolling and typing with word wrap", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 35,
      height: 30,
    })

    const parentContainer = new BoxRenderable(renderer, {
      id: "parent-container",
      zIndex: 10,
      padding: 1,
    })
    renderer.root.add(parentContainer)

    const editorBox = new BoxRenderable(renderer, {
      id: "editor-box",
      borderStyle: "single",
      borderColor: "#6BCF7F",
      backgroundColor: "#0D1117",
      title: "Interactive Editor (TextareaRenderable)",
      titleAlignment: "left",
      paddingLeft: 1,
      paddingRight: 1,
      border: true,
    })
    parentContainer.add(editorBox)

    const editor = new TextareaRenderable(renderer, {
      id: "editor",
      initialValue: initialContent,
      textColor: "#F0F6FC",
      selectionBg: "#264F78",
      selectionFg: "#FFFFFF",
      wrapMode: "word",
      showCursor: true,
      cursorColor: "#4ECDC4",
      placeholder: t`${fg("#333333")("Enter")} ${cyan(bold("text"))} ${fg("#333333")("here...")}`,
      tabIndicator: "→",
      tabIndicatorColor: "#30363D",
    })

    const editorWithLines = new LineNumberRenderable(renderer, {
      id: "editor-lines",
      target: editor,
      minWidth: 3,
      paddingRight: 1,
      fg: "#4b5563", // gray-600
      width: "100%",
      height: "100%",
    })

    editorBox.add(editorWithLines)

    // Initial render
    await renderOnce()

    const lineInfoInitial = editor.editorView.getLogicalLineInfo()
    const visualLinesInitial = lineInfoInitial.lineStartCols.length

    // Move cursor to bottom to trigger scrolling
    editor.gotoBufferEnd()
    await renderOnce()

    const lineInfoAfterScroll = editor.editorView.getLogicalLineInfo()
    const visualLinesAfterScroll = lineInfoAfterScroll.lineStartCols.length

    const frame1 = captureCharFrame()
    expect(frame1).toMatchSnapshot()

    // Visual line count should remain stable after scrolling
    expect(visualLinesInitial).toBe(visualLinesAfterScroll)

    // Move cursor to line 49 (index 48) which is an empty line and insert a character
    editor.editBuffer.setCursor(48, 0)
    editor.insertChar("a")
    await renderOnce()

    const lineInfoAfterTyping = editor.editorView.getLogicalLineInfo()
    const visualLinesAfterTyping = lineInfoAfterTyping.lineStartCols.length

    const frame2 = captureCharFrame()
    expect(frame2).toMatchSnapshot()

    // Visual lines should remain stable after typing
    expect(visualLinesAfterScroll).toBe(visualLinesAfterTyping)

    // Verify borders are intact
    const checkBorder = (frame: string, frameName: string) => {
      const lines = frame.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.startsWith(" │")) {
          if (!line.trimEnd().endsWith("│")) {
            throw new Error(`${frameName}: Line ${i} missing right border: "${line}"`)
          }
        }
      }
    }
    checkBorder(frame2, "Frame2")
  })
})
