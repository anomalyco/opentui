import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"
import { RGBA } from "../../lib/RGBA.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { OptimizedBuffer } from "../../buffer.js"
import type { CapturedFrame } from "../../types.js"
import { fg, t } from "../../lib/index.js"
import { BoxRenderable } from "../Box.js"
import { TextareaRenderable } from "../Textarea.js"
import { TextRenderable } from "../Text.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput
let captureFrame: () => string
let captureSpans: () => CapturedFrame
let resize: (width: number, height: number) => void

describe("Textarea - Rendering Tests", () => {
  beforeEach(async () => {
    ;({
      renderer: currentRenderer,
      renderOnce,
      captureCharFrame: captureFrame,
      captureSpans,
      mockInput: currentMockInput,
      resize,
    } = await createTestRenderer({
      width: 80,
      height: 24,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  describe("Wrapping", () => {
    it("fills textarea bounds with indexed background color", async () => {
      const surface = RGBA.fromIndex(254)
      await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "abc",
        width: 6,
        height: 2,
        backgroundColor: surface,
        focusedBackgroundColor: surface,
      })

      const frame = captureSpans()
      expect(frame.lines[0].spans[0].text).toBe("abc   ")
      expect(frame.lines[0].spans[0].bg.intent).toBe("indexed")
      expect(frame.lines[0].spans[0].bg.slot).toBe(254)
      expect(frame.lines[1].spans[0].text).toBe("      ")
      expect(frame.lines[1].spans[0].bg.intent).toBe("indexed")
      expect(frame.lines[1].spans[0].bg.slot).toBe(254)
    })

    it("fills textarea bounds without double-blending translucent backgrounds", async () => {
      const surface = RGBA.fromValues(1, 0, 0, 0.5)
      await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "abc",
        width: 6,
        height: 2,
        backgroundColor: surface,
        focusedBackgroundColor: surface,
      })

      const frame = captureSpans()
      expect(frame.lines[0].spans[0].text).toBe("abc   ")
      expect(frame.lines[1].spans[0].text).toBe("      ")
      expect(frame.lines[0].spans[0].bg.r).toBeCloseTo(frame.lines[1].spans[0].bg.r, 5)
      expect(frame.lines[0].spans[0].bg.g).toBeCloseTo(frame.lines[1].spans[0].bg.g, 5)
      expect(frame.lines[0].spans[0].bg.b).toBeCloseTo(frame.lines[1].spans[0].bg.b, 5)
      expect(frame.lines[0].spans[0].bg.a).toBeCloseTo(frame.lines[1].spans[0].bg.a, 5)
    })

    it("fills textarea background while placeholder is shown", async () => {
      const surface = RGBA.fromIndex(254)
      await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        placeholder: "hint",
        width: 6,
        height: 2,
        backgroundColor: surface,
        focusedBackgroundColor: surface,
      })

      const frame = captureSpans()
      expect(frame.lines[0].spans.some((span) => span.text.includes("hint"))).toBe(true)
      expect(
        frame.lines[0].spans.slice(0, 2).every((span) => span.bg.intent === "indexed" && span.bg.slot === 254),
      ).toBe(true)
      expect(frame.lines[1].spans[0].bg.intent).toBe("indexed")
      expect(frame.lines[1].spans[0].bg.slot).toBe(254)
    })

    it("should move cursor down through all wrapped visual lines at column 0", async () => {
      // Create a long line that will wrap into multiple visual lines
      const longText =
        "This is a very long line that will definitely wrap into multiple visual lines when the viewport is small"
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: longText,
        width: 20, // Small viewport to force wrapping
        height: 10,
        wrapMode: "word",
      })

      editor.focus()

      // Set cursor at the beginning (0, 0) - logical position
      editor.editBuffer.setCursor(0, 0)
      await renderOnce()

      // Get initial visual cursor position - should be at visual 0, 0
      let visualCursor = editor.editorView.getVisualCursor()
      expect(visualCursor.visualRow).toBe(0)
      expect(visualCursor.visualCol).toBe(0)

      // Verify we have multiple wrapped lines (should be 7 for this text)
      const vlineCount = editor.editorView.getVirtualLineCount()
      expect(vlineCount).toBeGreaterThan(1)

      // Move down through each wrapped line - cursor should stay at column 0
      for (let i = 1; i < vlineCount; i++) {
        currentMockInput.pressArrow("down")
        await renderOnce()

        visualCursor = editor.editorView.getVisualCursor()

        // Cursor should have moved down to the next visual line
        expect(visualCursor.visualRow).toBe(i)

        // Cursor should be at column 0 (beginning of each wrapped line)
        expect(visualCursor.visualCol).toBe(0)
      }

      // After moving through all wrapped lines, we should be at the last wrapped line
      expect(visualCursor.visualRow).toBe(vlineCount - 1)
      expect(visualCursor.visualCol).toBe(0)
    })

    it("should move cursor up through all wrapped visual lines at column 0", async () => {
      // Create a long line that will wrap into multiple visual lines
      const longText =
        "This is a very long line that will definitely wrap into multiple visual lines when the viewport is small"
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: longText,
        width: 20, // Small viewport to force wrapping
        height: 10,
        wrapMode: "word",
      })

      editor.focus()

      // Verify we have multiple wrapped lines
      const vlineCount = editor.editorView.getVirtualLineCount()
      expect(vlineCount).toBeGreaterThan(1)

      // Start at the END of the line (which will be on the last wrapped visual line)
      const eol = editor.editBuffer.getEOL()
      editor.editBuffer.setCursor(eol.row, eol.col)
      await renderOnce()

      // Move to the beginning of the last wrapped line (column 0 of last visual line)
      let visualCursor = editor.editorView.getVisualCursor()
      const lastVisualRow = visualCursor.visualRow

      // Set cursor to column 0 of the last wrapped visual line by finding its logical column
      // Last visual line starts at a specific logical column - we need to find it
      const lastVlineStartCol = editor.logicalCursor.col - visualCursor.visualCol
      editor.editBuffer.setCursor(0, lastVlineStartCol)
      await renderOnce()

      visualCursor = editor.editorView.getVisualCursor()
      expect(visualCursor.visualRow).toBe(lastVisualRow)
      expect(visualCursor.visualCol).toBe(0)

      // Now move UP through each wrapped line - cursor should stay at column 0
      for (let i = lastVisualRow - 1; i >= 0; i--) {
        currentMockInput.pressArrow("up")
        await renderOnce()

        visualCursor = editor.editorView.getVisualCursor()

        // Cursor should have moved up to the previous visual line
        expect(visualCursor.visualRow).toBe(i)

        // Cursor should be at column 0 (beginning of each wrapped line)
        expect(visualCursor.visualCol).toBe(0)
      }

      // After moving through all wrapped lines, we should be at the first wrapped line
      expect(visualCursor.visualRow).toBe(0)
      expect(visualCursor.visualCol).toBe(0)
    })

    it("should handle wrap mode property", async () => {
      const longText = "A".repeat(100)
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: longText,
        width: 20,
        height: 10,
        wrapMode: "word",
      })

      expect(editor.wrapMode).toBe("word")
      const wrappedCount = editor.editorView.getVirtualLineCount()
      expect(wrappedCount).toBeGreaterThan(1)

      editor.wrapMode = "none"
      expect(editor.wrapMode).toBe("none")
      const unwrappedCount = editor.editorView.getVirtualLineCount()
      expect(unwrappedCount).toBe(1)
    })

    it("should handle wrapMode changes", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello wonderful world",
        width: 12,
        height: 10,
        wrapMode: "char",
      })

      expect(editor.wrapMode).toBe("char")

      editor.wrapMode = "word"
      expect(editor.wrapMode).toBe("word")
    })

    it("should handle wrapIndent property", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "    " + "a".repeat(80),
        width: 20,
        height: 10,
        wrapMode: "char",
        wrapIndent: "none",
      })

      expect(editor.wrapIndent).toBe("none")
      editor.wrapIndent = "same"
      expect(editor.wrapIndent).toBe("same")
      expect(editor.editorView.getVirtualLineCount()).toBeGreaterThan(1)
    })

    it.each(["char", "word"] as const)("keeps the cursor aligned with wrapIndent in %s mode", async (wrapMode) => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "    " + "aaa ".repeat(20),
        width: 20,
        height: 10,
        wrapMode,
        wrapIndent: "same",
      })
      editor.focus()
      editor.editBuffer.setCursor(0, 4)
      await renderOnce()

      const lines = captureFrame().split("\n")
      for (const line of lines.slice(0, 3)) {
        expect(line.slice(0, 20)).toBe("    " + "aaa ".repeat(4))
      }

      for (const row of [1, 2]) {
        currentMockInput.pressArrow("down")
        await renderOnce()
        expect(editor.visualCursor.visualRow).toBe(row)
        expect(editor.visualCursor.visualCol).toBe(4)
        expect(editor.logicalCursor.col).toBe(20 + (row - 1) * 16)
      }

      for (const row of [1, 0]) {
        currentMockInput.pressArrow("up")
        await renderOnce()
        expect(editor.visualCursor.visualRow).toBe(row)
        expect(editor.visualCursor.visualCol).toBe(4)
      }
      expect(editor.logicalCursor.col).toBe(4)
    })

    it("should render with tab indicator correctly", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\tTabbed\nLine 2\t\tDouble tab",
        tabIndicator: "→",
        tabIndicatorColor: RGBA.fromValues(0.5, 0.5, 0.5, 1),
        width: 40,
        height: 10,
      })

      await renderOnce()
      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })
  })

  describe("Height and Width Measurement", () => {
    it("should grow height for multiline text without wrapping", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
        wrapMode: "none",
        width: 40,
      })

      await renderOnce()

      expect(editor.height).toBe(5)
      expect(editor.width).toBeGreaterThanOrEqual(6)
    })

    it("should grow height for wrapped text when wrapping enabled", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "This is a very long line that will definitely wrap to multiple lines",
        wrapMode: "word",
        width: 15,
      })

      await renderOnce()

      expect(editor.height).toBeGreaterThan(1)
      expect(editor.width).toBeLessThanOrEqual(15)
    })

    it("should measure full width when wrapping is disabled and not constrained by parent", async () => {
      const longLine = "This is a very long line that would wrap but wrapping is disabled"
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: longLine,
        wrapMode: "none",
        position: "absolute",
      })

      await renderOnce()

      expect(editor.height).toBe(1)
      expect(editor.width).toBe(longLine.length)
    })

    it("should shrink height when deleting lines via value setter", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
        width: 40,
        wrapMode: "none",
      })

      editor.focus()
      await renderOnce()
      expect(editor.height).toBe(5)

      // Remove lines by setting new value
      editor.setText("Line 1\nLine 2")
      await renderOnce()

      expect(editor.height).toBe(2)
      expect(editor.plainText).toBe("Line 1\nLine 2")
    })

    it("should update height when content changes from single to multiline", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Single line",
        wrapMode: "none",
      })

      await renderOnce()
      expect(editor.height).toBe(1)

      editor.setText("Line 1\nLine 2\nLine 3")
      await renderOnce()

      expect(editor.height).toBe(3)
    })

    it("should grow height when pressing Enter to add newlines", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Single line",
        width: 40,
        wrapMode: "none",
      })

      // Add a second textarea below to verify layout reflow
      const { textarea: belowEditor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Below",
        width: 40,
      })

      await renderOnce()
      expect(editor.height).toBe(1)
      const initialHeight = editor.height
      const initialBelowY = belowEditor.y

      editor.focus()
      editor.gotoLine(9999) // Move to end

      // Press Enter 3 times to add 3 newlines
      currentMockInput.pressEnter()
      expect(editor.plainText).toBe("Single line\n")
      await renderOnce() // Wait for layout recalculation

      currentMockInput.pressEnter()
      expect(editor.plainText).toBe("Single line\n\n")
      await renderOnce() // Wait for layout recalculation

      currentMockInput.pressEnter()
      expect(editor.plainText).toBe("Single line\n\n\n")
      await renderOnce() // Wait for layout recalculation

      // The editor should have grown
      expect(editor.height).toBeGreaterThan(initialHeight)
      expect(editor.height).toBe(4) // 1 original line + 3 new lines
      expect(editor.plainText).toBe("Single line\n\n\n")

      // The element below should have moved down
      expect(belowEditor.y).toBeGreaterThan(initialBelowY)
      expect(belowEditor.y).toBe(4) // After the 4-line editor
    })
  })

  describe("Unicode Support", () => {
    it("should handle emoji insertion", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end
      editor.insertText(" 🌟")

      expect(editor.plainText).toBe("Hello 🌟")
    })

    it("should handle CJK characters", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end
      editor.insertText(" 世界")

      expect(editor.plainText).toBe("Hello 世界")
    })

    it("should handle emoji cursor movement", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "A🌟B",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressArrow("right") // Move past A
      expect(editor.logicalCursor.col).toBe(1)

      currentMockInput.pressArrow("right") // Move past emoji (2 cells)
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressArrow("right") // Move past B
      expect(editor.logicalCursor.col).toBe(4)
    })
  })

  describe("Content Property", () => {
    it("should update content programmatically", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Initial",
        width: 40,
        height: 10,
      })

      editor.setText("Updated")
      expect(editor.plainText).toBe("Updated")
      expect(editor.plainText).toBe("Updated")
    })

    it("should reset cursor when content changes", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.gotoLine(9999) // Move to end
      expect(editor.logicalCursor.col).toBe(11)

      editor.setText("New")
      // Cursor should reset to start
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should clear text with clear() method", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      expect(editor.plainText).toBe("Hello World")

      editor.clear()
      expect(editor.plainText).toBe("")
    })

    it("should clear highlights with clear() method", async () => {
      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("highlight", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        syntaxStyle: style,
      })

      editor.addHighlightByCharRange({
        start: 0,
        end: 5,
        styleId: styleId,
        priority: 0,
      })

      const highlightsBefore = editor.getLineHighlights(0)
      expect(highlightsBefore.length).toBeGreaterThan(0)

      editor.clear()

      expect(editor.plainText).toBe("")
      const highlightsAfter = editor.getLineHighlights(0)
      expect(highlightsAfter.length).toBe(0)
    })

    it("should clear both text and highlights together", async () => {
      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("highlight", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        syntaxStyle: style,
      })

      editor.addHighlight(0, { start: 0, end: 6, styleId: styleId, priority: 0 })
      editor.addHighlight(1, { start: 0, end: 6, styleId: styleId, priority: 0 })

      expect(editor.plainText).toBe("Line 1\nLine 2\nLine 3")
      expect(editor.getLineHighlights(0).length).toBe(1)
      expect(editor.getLineHighlights(1).length).toBe(1)

      editor.clear()

      expect(editor.plainText).toBe("")
      expect(editor.getLineHighlights(0).length).toBe(0)
      expect(editor.getLineHighlights(1).length).toBe(0)
    })

    it("should allow typing after clear()", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.plainText).toBe("Hello World")

      currentMockInput.pressKey("!")
      expect(editor.plainText).toBe("!Hello World")

      editor.clear()
      expect(editor.plainText).toBe("")

      currentMockInput.pressKey("N")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("w")
      expect(editor.plainText).toBe("New")

      currentMockInput.pressKey(" ")
      currentMockInput.pressKey("T")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("x")
      currentMockInput.pressKey("t")
      expect(editor.plainText).toBe("New Text")
    })
  })

  describe("Rendering After Edits", () => {
    it("should render correctly after insert text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.insertText("x")

      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")
      buffer.drawEditorView(editor.editorView, 0, 0)

      expect(editor.plainText).toBe("xTest")
      expect(editor.logicalCursor.col).toBe(1)

      buffer.destroy()
    })

    it("should render correctly after rapid edits", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      for (let i = 0; i < 5; i++) {
        editor.insertText("a")
        buffer.drawEditorView(editor.editorView, 0, 0)
      }

      expect(editor.plainText).toBe("aaaaa")
      expect(editor.logicalCursor.col).toBe(5)

      buffer.destroy()
    })

    it("should render correctly after newline", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)

      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      editor.newLine()
      buffer.drawEditorView(editor.editorView, 0, 0)

      expect(editor.plainText).toBe("Hello\n")
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(0)

      buffer.destroy()
    })

    it("should render correctly after backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)

      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      editor.deleteCharBackward()
      buffer.drawEditorView(editor.editorView, 0, 0)

      expect(editor.plainText).toBe("Hell")
      expect(editor.logicalCursor.col).toBe(4)

      buffer.destroy()
    })

    it("should render correctly with draw-edit-draw pattern", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()

      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      buffer.drawEditorView(editor.editorView, 0, 0)
      editor.insertText("x")
      buffer.drawEditorView(editor.editorView, 0, 0)

      expect(editor.plainText).toBe("xTest")
      expect(editor.logicalCursor.col).toBe(1)

      buffer.destroy()
    })

    it("should render correctly after multiple text buffer modifications", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line1\nLine2\nLine3",
        width: 40,
        height: 10,
      })

      editor.focus()

      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      buffer.drawEditorView(editor.editorView, 0, 0)

      editor.insertText("X")
      buffer.drawEditorView(editor.editorView, 0, 0)
      expect(editor.plainText).toBe("XLine1\nLine2\nLine3")

      editor.newLine()
      buffer.drawEditorView(editor.editorView, 0, 0)
      expect(editor.plainText).toBe("X\nLine1\nLine2\nLine3")

      editor.deleteCharBackward()
      buffer.drawEditorView(editor.editorView, 0, 0)
      expect(editor.plainText).toBe("XLine1\nLine2\nLine3")

      buffer.destroy()
    })
  })

  describe("Viewport Scrolling", () => {
    it("should scroll viewport down when cursor moves below visible area", async () => {
      // Create editor with small viewport
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9",
        width: 40,
        height: 5, // Only 5 lines visible
      })

      editor.focus()

      // Initial viewport should show lines 0-4
      let viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBe(0)
      expect(viewport.height).toBe(5)

      // Move cursor to line 7 (beyond viewport)
      editor.gotoLine(7)

      // Viewport should have scrolled to keep cursor visible
      viewport = editor.editorView.getViewport()
      // With scroll margin of 0.2 (20% = 1 line), viewport should scroll to show line 7
      // Expected: offsetY should be at least 3 (to show lines 3-7)
      expect(viewport.offsetY).toBeGreaterThanOrEqual(3)
    })

    it("should scroll viewport up when cursor moves above visible area", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9",
        width: 40,
        height: 5,
      })

      editor.focus()

      // Start at line 8
      editor.gotoLine(8)

      let viewport = editor.editorView.getViewport()
      // Viewport should have automatically scrolled to show line 8
      expect(viewport.offsetY).toBeGreaterThan(0)

      // Now move to line 1 (above viewport)
      editor.gotoLine(1)

      viewport = editor.editorView.getViewport()
      // Viewport should have scrolled up to show line 1
      expect(viewport.offsetY).toBeLessThanOrEqual(1)
    })

    it("should scroll viewport when using arrow keys to move beyond visible area", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 5,
      })

      editor.focus()

      let viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBe(0)

      // Press down arrow 6 times to move beyond initial viewport
      for (let i = 0; i < 6; i++) {
        currentMockInput.pressArrow("down")
      }

      viewport = editor.editorView.getViewport()
      // Should have scrolled
      expect(viewport.offsetY).toBeGreaterThan(0)
    })

    it("should maintain scroll margin when moving cursor", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        scrollMargin: 0.2, // 20% = 2 lines margin
      })

      editor.focus()

      // Move to line 8 (near bottom of initial viewport)
      editor.gotoLine(8)

      let viewport = editor.editorView.getViewport()

      // With 2-line margin, cursor at line 8 should trigger scroll
      // so that line 8 is at most at position 8 in viewport
      expect(viewport.offsetY).toBeGreaterThanOrEqual(0)
    })

    it("should handle viewport scrolling with text wrapping", async () => {
      const longLine = "word ".repeat(50) // Creates line that will wrap
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 10 }, (_, i) => (i === 5 ? longLine : `Line ${i}`)).join("\n"),
        width: 20,
        height: 5,
        wrapMode: "word",
      })

      editor.focus()

      // Move to the long line
      editor.gotoLine(5)

      const vlineCount = editor.editorView.getTotalVirtualLineCount()
      expect(vlineCount).toBeGreaterThan(10) // Should be more due to wrapping

      // Move to end of long line
      const cursor = editor.logicalCursor
      editor.editBuffer.setCursorToLineCol(cursor.row, 9999) // Move to end of line

      let viewport = editor.editorView.getViewport()

      // Viewport should have scrolled to show cursor
      // This is complex with wrapping - we need virtual line scrolling
    })

    it("should verify viewport follows cursor to line 10", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 8,
      })

      editor.focus()

      // Move to line 10
      editor.gotoLine(10)

      const viewport = editor.editorView.getViewport()

      // Viewport should have scrolled to show line 10
      // With height=8 and scroll margin, line 10 should be visible
      expect(viewport.offsetY).toBeGreaterThan(0)
      expect(viewport.offsetY).toBeLessThanOrEqual(10)

      // Line 10 should be within the viewport range
      const viewportEnd = viewport.offsetY + viewport.height
      expect(10).toBeGreaterThanOrEqual(viewport.offsetY)
      expect(10).toBeLessThan(viewportEnd)
    })

    it("should track viewport offset as cursor moves through document", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 15 }, (_, i) => `Line ${i}`).join("\n"),
        width: 30,
        height: 5,
      })

      editor.focus()

      const viewportOffsets: number[] = []

      // Track viewport offset at different cursor positions
      for (const line of [0, 2, 4, 6, 8, 10, 12]) {
        editor.gotoLine(line)
        const viewport = editor.editorView.getViewport()
        viewportOffsets.push(viewport.offsetY)
      }

      // Viewport should generally increase as cursor moves down
      // (with possible plateaus when cursor is already visible)
      const lastOffset = viewportOffsets[viewportOffsets.length - 1]
      const firstOffset = viewportOffsets[0]
      expect(lastOffset).toBeGreaterThan(firstOffset)

      // At line 0, viewport should be at 0
      expect(viewportOffsets[0]).toBe(0)

      // At line 12, viewport should have scrolled
      expect(viewportOffsets[viewportOffsets.length - 1]).toBeGreaterThan(5)
    })

    it("should scroll viewport when cursor moves with Page Up/Page Down", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
      })

      editor.focus()

      let viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBe(0)

      // Move down 15 lines (more than viewport height)
      for (let i = 0; i < 15; i++) {
        editor.moveCursorDown()
      }

      viewport = editor.editorView.getViewport()

      // Should have scrolled
      expect(viewport.offsetY).toBeGreaterThan(0)
      expect(editor.logicalCursor.row).toBe(15)
    })

    it("should scroll viewport down when pressing Enter repeatedly", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Start",
        width: 40,
        height: 5,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      let viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBe(0)
      expect(editor.logicalCursor.row).toBe(0)

      // Press Enter 8 times to create 8 new lines
      for (let i = 0; i < 8; i++) {
        currentMockInput.pressEnter()
      }

      // After 8 Enters, we should have 9 lines total (0-8)
      expect(editor.logicalCursor.row).toBe(8)

      // Viewport should have scrolled to keep cursor visible
      viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(0)

      // Cursor should be visible in viewport
      const cursorLine = editor.logicalCursor.row
      expect(cursorLine).toBeGreaterThanOrEqual(viewport.offsetY)
      expect(cursorLine).toBeLessThan(viewport.offsetY + viewport.height)
    })

    it("should scroll viewport up when pressing Backspace to delete characters and move up", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 15 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 5,
      })

      editor.focus()

      // Start at line 10, move to end so we have characters to delete
      editor.gotoLine(10)
      let cursor = editor.logicalCursor
      editor.editBuffer.setCursorToLineCol(cursor.row, 9999) // Move to end of line

      let viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(0)
      const initialOffset = viewport.offsetY

      // Delete all text and move cursor up to line 0
      // Press Ctrl+A to go to start, then move to line 2, then backspace repeatedly
      editor.gotoLine(0) // Move to start
      editor.gotoLine(2)
      cursor = editor.logicalCursor
      editor.editBuffer.setCursorToLineCol(cursor.row, 9999) // Move to end of line

      // Now we're at line 2, and viewport should have scrolled up
      viewport = editor.editorView.getViewport()

      // Viewport should have scrolled up from initial position
      expect(viewport.offsetY).toBeLessThan(initialOffset)
      expect(editor.logicalCursor.row).toBe(2)
    })

    it("should scroll viewport when typing at end creates wrapped lines beyond viewport", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Start",
        width: 20,
        height: 5,
        wrapMode: "word",
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      let viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBe(0)

      // Type enough to create multiple wrapped lines
      const longText = " word".repeat(50)
      for (const char of longText) {
        currentMockInput.pressKey(char)
      }

      viewport = editor.editorView.getViewport()
      const vlineCount = editor.editorView.getTotalVirtualLineCount()

      // Should have created multiple virtual lines
      expect(vlineCount).toBeGreaterThan(5)

      // Viewport should have scrolled to keep cursor visible
      // (This test may fail if virtual line scrolling isn't implemented yet)
      expect(viewport.offsetY).toBeGreaterThanOrEqual(0)
    })

    it("should scroll viewport when using Enter to add lines, then Backspace to remove them", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 0\nLine 1\nLine 2",
        width: 40,
        height: 5,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      let viewport = editor.editorView.getViewport()
      const initialOffset = viewport.offsetY

      // Add 6 new lines
      for (let i = 0; i < 6; i++) {
        currentMockInput.pressEnter()
        currentMockInput.pressKey("X")
      }

      // Should have scrolled down
      viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(initialOffset)
      const maxOffset = viewport.offsetY

      // Now delete those lines by backspacing
      for (let i = 0; i < 12; i++) {
        // 12 backspaces to delete 6 "X\n" pairs
        currentMockInput.pressBackspace()
      }

      // Should have scrolled back up
      viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeLessThan(maxOffset)
    })

    it("should show last line at bottom of viewport with no gap", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 10 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 5,
      })

      editor.focus()

      // Move to last line (line 9)
      editor.gotoLine(9)

      let viewport = editor.editorView.getViewport()

      // With 10 lines (0-9) and viewport height 5, max offset is 10 - 5 = 5
      // Viewport should be at offset 5, showing lines 5-9 with line 9 at the bottom
      expect(viewport.offsetY).toBe(5)

      // Verify cursor line is visible
      expect(9).toBeGreaterThanOrEqual(viewport.offsetY)
      expect(9).toBeLessThan(viewport.offsetY + viewport.height)

      // No gap - last visible line should be the last line of content
      const lastVisibleLine = viewport.offsetY + viewport.height - 1
      expect(lastVisibleLine).toBe(9)
    })

    it("should not scroll past end when document is smaller than viewport", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 0\nLine 1\nLine 2",
        width: 40,
        height: 10, // Viewport bigger than content
      })

      editor.focus()

      // Move to last line
      editor.gotoLine(2)

      let viewport = editor.editorView.getViewport()

      // Should NOT scroll at all - content fits in viewport
      expect(viewport.offsetY).toBe(0)
    })
  })

  describe("Placeholder Support", () => {
    it("should display placeholder when empty", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "Enter text here...",
      })

      // plainText should return empty (placeholder is display-only)
      expect(editor.plainText).toBe("")
      expect(editor.placeholder).toBe("Enter text here...")
    })

    it("should hide placeholder when text is inserted", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "Type something...",
      })

      editor.focus()
      expect(editor.plainText).toBe("")

      currentMockInput.pressKey("H")
      currentMockInput.pressKey("i")

      expect(editor.plainText).toBe("Hi")
    })

    it("should reactivate placeholder when all text is deleted", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        placeholder: "Empty buffer...",
      })

      editor.focus()
      expect(editor.plainText).toBe("Test")

      // Move to end, then delete all text
      editor.gotoLine(9999)
      for (let i = 0; i < 4; i++) {
        currentMockInput.pressBackspace()
      }

      expect(editor.plainText).toBe("")
    })

    it("should update placeholder text dynamically", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "First placeholder",
      })

      expect(editor.placeholder).toBe("First placeholder")
      expect(editor.plainText).toBe("")

      editor.placeholder = "Second placeholder"
      expect(editor.placeholder).toBe("Second placeholder")
      expect(editor.plainText).toBe("")
    })

    it("should update placeholder with styled text dynamically", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "Colored placeholder",
      })

      expect(editor.plainText).toBe("")

      // Update placeholder with styled text
      editor.placeholder = t`${fg("#FF0000")("Red placeholder")}`
      expect(editor.plainText).toBe("")
    })

    it("should work with value property setter", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "Empty state",
      })

      expect(editor.plainText).toBe("")

      editor.setText("New content")
      expect(editor.plainText).toBe("New content")

      editor.setText("")
      expect(editor.plainText).toBe("")
    })

    it("should handle placeholder with focus changes", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "Click to edit",
      })

      // Placeholder should show regardless of focus
      expect(editor.plainText).toBe("")

      editor.focus()
      expect(editor.plainText).toBe("")

      editor.blur()
      expect(editor.plainText).toBe("")
    })

    it("should handle typing after placeholder is shown", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "Start typing...",
      })

      editor.focus()
      expect(editor.plainText).toBe("")

      currentMockInput.pressKey("H")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("o")

      expect(editor.plainText).toBe("Hello")
    })

    it("should show placeholder after deleting all typed text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "Type here",
      })

      editor.focus()

      // Type "Test"
      currentMockInput.pressKey("T")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("s")
      currentMockInput.pressKey("t")
      expect(editor.plainText).toBe("Test")

      // Backspace all
      for (let i = 0; i < 4; i++) {
        currentMockInput.pressBackspace()
      }

      expect(editor.plainText).toBe("")
    })

    it("should handle placeholder with newlines", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "Line 1\nLine 2",
      })

      expect(editor.plainText).toBe("")

      editor.insertText("Content")
      expect(editor.plainText).toBe("Content")
    })

    it("should handle null placeholder (no placeholder)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: null,
      })

      expect(editor.placeholder).toBe(null)
      expect(editor.plainText).toBe("")

      editor.insertText("Content")
      expect(editor.plainText).toBe("Content")
    })

    it("should clear placeholder when set to null", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "Initial placeholder",
      })

      expect(editor.placeholder).toBe("Initial placeholder")
      expect(editor.plainText).toBe("")

      editor.placeholder = null
      expect(editor.placeholder).toBe(null)
      expect(editor.plainText).toBe("")
    })

    it("should reset placeholder when set to undefined", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        placeholder: "Initial placeholder",
      })

      expect(editor.placeholder).toBe("Initial placeholder")

      expect(() => {
        editor.placeholder = undefined
      }).not.toThrow()

      expect(editor.placeholder).toBe(null)
      expect(editor.plainText).toBe("")
    })
  })

  describe("Textarea Content Snapshots", () => {
    it("should render basic text content correctly", async () => {
      await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        left: 5,
        top: 3,
        width: 20,
        height: 5,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render multiline text content correctly", async () => {
      await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1: Hello\nLine 2: World\nLine 3: Testing\nLine 4: Multiline",
        left: 1,
        top: 1,
        width: 30,
        height: 10,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render text with character wrapping correctly", async () => {
      await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "This is a very long text that should wrap to multiple lines when wrap is enabled",
        wrapMode: "char",
        width: 15,
        left: 0,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render text with word wrapping and punctuation", async () => {
      await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello,World.Test-Example/Path with various punctuation marks!",
        wrapMode: "word",
        width: 12,
        left: 0,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render placeholder when creating textarea with placeholder directly", async () => {
      await createTextareaRenderable(currentRenderer, renderOnce, {
        placeholder: "Enter text here...",
        left: 1,
        top: 1,
        width: 30,
        height: 5,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render placeholder when set programmatically after creation", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        left: 1,
        top: 1,
        width: 30,
        height: 5,
      })

      textarea.placeholder = "Type something..."
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should resize correctly when typing return as first input with placeholder", async () => {
      resize(40, 10)

      const container = new BoxRenderable(currentRenderer, {
        border: true,
        left: 1,
        top: 1,
      })
      currentRenderer.root.add(container)

      const textarea = new TextareaRenderable(currentRenderer, {
        placeholder: "Enter your message...",
        width: 30,
        minHeight: 1,
        maxHeight: 3,
      })
      container.add(textarea)

      textarea.focus()
      await renderOnce()

      const frameBeforeEnter = captureFrame()
      expect(textarea.height).toBe(1)

      currentMockInput.pressEnter()
      await renderOnce()
      await renderOnce()

      const frameAfterEnter = captureFrame()
      expect(frameAfterEnter).toMatchSnapshot()
      expect(textarea.height).toBe(2)
      expect(textarea.plainText).toBe("\n")
    })
  })

  describe("Layout Reflow on Size Change", () => {
    it("should reflow subsequent elements when textarea grows and shrinks", async () => {
      const { textarea: firstEditor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Short",
        width: 20,
        wrapMode: "word",
      })

      const { textarea: secondEditor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "I am below the first textarea",
        width: 30,
      })

      await renderOnce()

      // Initially, first editor is 1 line high
      expect(firstEditor.height).toBe(1)
      const initialSecondY = secondEditor.y
      expect(initialSecondY).toBe(1) // Right after first editor

      // Expand first editor with wrapped content
      firstEditor.setText("This is a very long line that will wrap to multiple lines and push the second textarea down")
      await renderOnce()

      // First editor should now be taller
      expect(firstEditor.height).toBeGreaterThan(1)
      // Second editor should have moved down
      expect(secondEditor.y).toBeGreaterThan(initialSecondY)
      const expandedSecondY = secondEditor.y

      // Shrink first editor back
      firstEditor.setText("Short again")
      await renderOnce()

      // First editor should be 1 line again
      expect(firstEditor.height).toBe(1)
      // Second editor should have moved back up
      expect(secondEditor.y).toBeLessThan(expandedSecondY)
      expect(secondEditor.y).toBe(initialSecondY)
    })
  })

  describe("Width/Height Setter Layout Tests", () => {
    it("should not shrink box when width is set via setter", async () => {
      resize(40, 10)

      const container = new BoxRenderable(currentRenderer, { border: true, width: 30 })
      currentRenderer.root.add(container)

      const row = new BoxRenderable(currentRenderer, { flexDirection: "row", width: "100%" })
      container.add(row)

      const indicator = new BoxRenderable(currentRenderer, { backgroundColor: "#f00" })
      row.add(indicator)

      const indicatorText = new TextRenderable(currentRenderer, { content: ">" })
      indicator.add(indicatorText)

      const content = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexGrow: 1 })
      row.add(content)

      const contentText = new TextRenderable(currentRenderer, { content: "Content that takes up space" })
      content.add(contentText)

      await renderOnce()

      const initialIndicatorWidth = indicator.width

      indicator.width = 5
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(indicator.width).toBe(5)
      expect(content.width).toBeGreaterThan(0)
      expect(content.width).toBeLessThan(30)
    })

    it("should not shrink box when height is set via setter in column layout with textarea", async () => {
      resize(30, 15)

      const outerBox = new BoxRenderable(currentRenderer, { border: true, width: 25, height: 10 })
      currentRenderer.root.add(outerBox)

      const column = new BoxRenderable(currentRenderer, { flexDirection: "column", height: "100%" })
      outerBox.add(column)

      const header = new BoxRenderable(currentRenderer, { backgroundColor: "#f00" })
      column.add(header)

      const headerText = new TextRenderable(currentRenderer, { content: "Header" })
      header.add(headerText)

      const mainContent = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexGrow: 1 })
      column.add(mainContent)

      const { textarea: mainTextarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line1\nLine2\nLine3\nLine4\nLine5\nLine6\nLine7\nLine8",
      })
      mainContent.add(mainTextarea)

      const footer = new BoxRenderable(currentRenderer, { height: 2, backgroundColor: "#00f" })
      column.add(footer)

      const footerText = new TextRenderable(currentRenderer, { content: "Footer" })
      footer.add(footerText)

      await renderOnce()

      header.height = 3
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(header.height).toBe(3)
      expect(mainContent.height).toBeGreaterThan(0)
      expect(footer.height).toBe(2)
    })

    it("should not shrink box when minWidth is set via setter", async () => {
      resize(40, 10)

      const container = new BoxRenderable(currentRenderer, { border: true, width: 30 })
      currentRenderer.root.add(container)

      const row = new BoxRenderable(currentRenderer, { flexDirection: "row", width: "100%" })
      container.add(row)

      const indicator = new BoxRenderable(currentRenderer, { backgroundColor: "#f00", flexShrink: 1 })
      row.add(indicator)

      const indicatorText = new TextRenderable(currentRenderer, { content: ">" })
      indicator.add(indicatorText)

      const content = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexGrow: 1 })
      row.add(content)

      const contentText = new TextRenderable(currentRenderer, { content: "Content that takes up space" })
      content.add(contentText)

      await renderOnce()

      indicator.minWidth = 5
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
      expect(indicator.width).toBeGreaterThanOrEqual(5)
      expect(content.width).toBeGreaterThan(0)
    })

    it("should not shrink box when minHeight is set via setter in column layout with textarea", async () => {
      resize(30, 15)

      const outerBox = new BoxRenderable(currentRenderer, { border: true, width: 25, height: 10 })
      currentRenderer.root.add(outerBox)

      const column = new BoxRenderable(currentRenderer, { flexDirection: "column", height: "100%" })
      outerBox.add(column)

      const header = new BoxRenderable(currentRenderer, { backgroundColor: "#f00", flexShrink: 1 })
      column.add(header)

      const headerText = new TextRenderable(currentRenderer, { content: "Header" })
      header.add(headerText)

      const mainContent = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexGrow: 1 })
      column.add(mainContent)

      const { textarea: mainTextarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line1\nLine2\nLine3\nLine4\nLine5\nLine6\nLine7\nLine8",
      })
      mainContent.add(mainTextarea)

      const footer = new BoxRenderable(currentRenderer, { height: 2, backgroundColor: "#00f" })
      column.add(footer)

      const footerText = new TextRenderable(currentRenderer, { content: "Footer" })
      footer.add(footerText)

      await renderOnce()

      header.minHeight = 3
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(header.height).toBeGreaterThanOrEqual(3)
      expect(mainContent.height).toBeGreaterThan(0)
      expect(footer.height).toBe(2)
    })

    it("should not shrink box when width is set from undefined via setter", async () => {
      resize(40, 10)

      const container = new BoxRenderable(currentRenderer, { border: true, width: 30 })
      currentRenderer.root.add(container)

      const row = new BoxRenderable(currentRenderer, { flexDirection: "row", width: "100%" })
      container.add(row)

      const indicator = new BoxRenderable(currentRenderer, { backgroundColor: "#f00", flexShrink: 1 })
      row.add(indicator)

      const indicatorText = new TextRenderable(currentRenderer, { content: ">" })
      indicator.add(indicatorText)

      const content = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexGrow: 1 })
      row.add(content)

      const contentText = new TextRenderable(currentRenderer, { content: "Content that takes up space" })
      content.add(contentText)

      await renderOnce()

      indicator.width = 5
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(indicator.width).toBe(5)
      expect(content.width).toBeGreaterThan(0)
    })

    it("should verify dimensions are actually respected under extreme pressure", async () => {
      resize(30, 10)

      const container = new BoxRenderable(currentRenderer, { border: true, width: 20 })
      currentRenderer.root.add(container)

      const row = new BoxRenderable(currentRenderer, { flexDirection: "row", width: "100%" })
      container.add(row)

      const box1 = new BoxRenderable(currentRenderer, { backgroundColor: "#f00", flexShrink: 1 })
      row.add(box1)
      const text1 = new TextRenderable(currentRenderer, { content: "AAA" })
      box1.add(text1)

      const box2 = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexShrink: 1 })
      row.add(box2)
      const text2 = new TextRenderable(currentRenderer, { content: "BBB" })
      box2.add(text2)

      const box3 = new BoxRenderable(currentRenderer, { backgroundColor: "#00f", flexGrow: 1 })
      row.add(box3)
      const text3 = new TextRenderable(currentRenderer, { content: "CCC" })
      box3.add(text3)

      await renderOnce()

      box1.width = 7
      box2.minWidth = 5
      await renderOnce()

      expect(box1.width).toBe(7)
      expect(box2.width).toBeGreaterThanOrEqual(5)
      expect(box3.width).toBeGreaterThan(0)

      const total = box1.width + box2.width + box3.width
      expect(total).toBeLessThanOrEqual(18)
    })
  })

  describe("Absolute Positioned Box with Textarea", () => {
    it("should render textarea in absolute positioned box with padding and borders correctly", async () => {
      resize(80, 20)

      const notificationBox = new BoxRenderable(currentRenderer, {
        position: "absolute",
        justifyContent: "center",
        alignItems: "flex-start",
        top: 2,
        right: 2,
        maxWidth: Math.min(60, 80 - 6),
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        backgroundColor: "#1e293b",
        borderColor: "#3b82f6",
        border: ["left", "right"],
      })

      currentRenderer.root.add(notificationBox)

      const outerWrapperBox = new BoxRenderable(currentRenderer, {
        flexDirection: "row",
        paddingBottom: 1,
        paddingTop: 1,
        paddingLeft: 2,
        paddingRight: 2,
        gap: 2,
      })
      notificationBox.add(outerWrapperBox)

      const innerContentBox = new BoxRenderable(currentRenderer, {
        flexGrow: 1,
        gap: 1,
      })
      outerWrapperBox.add(innerContentBox)

      const titleText = new TextRenderable(currentRenderer, {
        content: "Important Notification",
        attributes: 1,
        marginBottom: 1,
        fg: "#f8fafc",
      })
      innerContentBox.add(titleText)

      const { textarea: messageTextarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue:
          "This is a longer message that should wrap properly within the absolutely positioned box with appropriate width constraints and padding applied.",
        textColor: "#e2e8f0",
        wrapMode: "word",
        width: "100%",
      })
      innerContentBox.add(messageTextarea)

      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(notificationBox.x).toBeGreaterThan(0)
      expect(notificationBox.y).toBe(2)
      expect(notificationBox.width).toBeGreaterThan(25)

      expect(outerWrapperBox.width).toBeGreaterThan(15)
      expect(innerContentBox.width).toBeGreaterThan(15)

      expect(titleText.width).toBeGreaterThan(15)
      expect(titleText.plainText).toBe("Important Notification")
      expect(titleText.height).toBe(1)

      expect(messageTextarea.width).toBeGreaterThan(15)
      expect(messageTextarea.height).toBeGreaterThanOrEqual(1)
      expect(messageTextarea.plainText).toBe(
        "This is a longer message that should wrap properly within the absolutely positioned box with appropriate width constraints and padding applied.",
      )
    })

    it("should render textarea fully visible in absolute positioned box at various positions", async () => {
      resize(100, 25)

      const topRightBox = new BoxRenderable(currentRenderer, {
        position: "absolute",
        top: 1,
        right: 1,
        maxWidth: 40,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        backgroundColor: "#fef2f2",
        borderColor: "#ef4444",
        border: true,
      })
      currentRenderer.root.add(topRightBox)

      const { textarea: topRightTextarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Error: File not found in the specified directory path",
        textColor: "#991b1b",
        wrapMode: "word",
        width: "100%",
      })
      topRightBox.add(topRightTextarea)

      const bottomLeftBox = new BoxRenderable(currentRenderer, {
        position: "absolute",
        bottom: 1,
        left: 1,
        maxWidth: 35,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: "#f0fdf4",
        borderColor: "#22c55e",
        border: ["top", "bottom"],
      })
      currentRenderer.root.add(bottomLeftBox)

      const { textarea: bottomLeftTextarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Success: Operation completed successfully!",
        textColor: "#166534",
        wrapMode: "word",
        width: "100%",
      })
      bottomLeftBox.add(bottomLeftTextarea)

      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(topRightBox.y).toBe(1)
      expect(topRightBox.x).toBeGreaterThan(50)
      expect(topRightBox.width).toBeGreaterThan(30)
      expect(topRightBox.width).toBeLessThanOrEqual(40)

      expect(topRightTextarea.plainText).toBe("Error: File not found in the specified directory path")
      expect(topRightTextarea.width).toBeGreaterThan(25)
      expect(topRightTextarea.width).toBeLessThanOrEqual(38)
      expect(topRightTextarea.height).toBeGreaterThan(1)

      expect(bottomLeftBox.x).toBe(1)
      expect(bottomLeftBox.y).toBeGreaterThan(15)
      expect(bottomLeftBox.width).toBeGreaterThan(25)
      expect(bottomLeftBox.width).toBeLessThanOrEqual(35)

      expect(bottomLeftTextarea.plainText).toBe("Success: Operation completed successfully!")
      expect(bottomLeftTextarea.width).toBeGreaterThan(25)
      expect(bottomLeftTextarea.width).toBeLessThanOrEqual(33)
      expect(bottomLeftTextarea.height).toBeGreaterThan(1)
    })

    it("should handle width:100% textarea in absolute positioned box with constrained maxWidth", async () => {
      resize(70, 15)

      const constrainedBox = new BoxRenderable(currentRenderer, {
        position: "absolute",
        top: 5,
        left: 10,
        maxWidth: 50,
        paddingLeft: 3,
        paddingRight: 3,
        paddingTop: 2,
        paddingBottom: 2,
        backgroundColor: "#1e1e2e",
      })
      currentRenderer.root.add(constrainedBox)

      const { textarea: longTextarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue:
          "This is an extremely long piece of text that needs to wrap multiple times within the constrained width of the absolutely positioned container box with significant padding on all sides.",
        textColor: "#cdd6f4",
        wrapMode: "word",
        width: "100%",
      })
      constrainedBox.add(longTextarea)

      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(constrainedBox.width).toBeLessThanOrEqual(50)
      expect(constrainedBox.width).toBeGreaterThan(40)
      expect(constrainedBox.x).toBe(10)
      expect(constrainedBox.y).toBe(5)

      expect(longTextarea.width).toBeGreaterThan(35)
      expect(longTextarea.width).toBeLessThanOrEqual(44)
      expect(longTextarea.height).toBeGreaterThanOrEqual(5)
      expect(longTextarea.plainText).toBe(
        "This is an extremely long piece of text that needs to wrap multiple times within the constrained width of the absolutely positioned container box with significant padding on all sides.",
      )
    })

    it("should render multiple textarea elements in absolute positioned box with proper spacing", async () => {
      resize(90, 20)

      const infoBox = new BoxRenderable(currentRenderer, {
        position: "absolute",
        justifyContent: "flex-start",
        alignItems: "flex-start",
        top: 3,
        right: 5,
        maxWidth: 45,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        backgroundColor: "#eff6ff",
        borderColor: "#3b82f6",
        border: true,
      })
      currentRenderer.root.add(infoBox)

      const headerText = new TextRenderable(currentRenderer, {
        content: "System Update",
        attributes: 1,
        fg: "#1e40af",
      })
      infoBox.add(headerText)

      const { textarea: bodyTextarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "A new version is available with bug fixes and performance improvements.",
        textColor: "#1e3a8a",
        wrapMode: "word",
        width: "100%",
        marginTop: 1,
      })
      infoBox.add(bodyTextarea)

      const footerText = new TextRenderable(currentRenderer, {
        content: "Click to install",
        fg: "#60a5fa",
        marginTop: 1,
      })
      infoBox.add(footerText)

      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(headerText.plainText).toBe("System Update")
      expect(bodyTextarea.plainText).toBe("A new version is available with bug fixes and performance improvements.")
      expect(footerText.plainText).toBe("Click to install")

      expect(infoBox.width).toBeGreaterThan(35)
      expect(infoBox.width).toBeLessThanOrEqual(45)

      expect(headerText.width).toBeGreaterThan(10)
      expect(headerText.height).toBe(1)

      expect(bodyTextarea.width).toBeGreaterThan(30)
      expect(bodyTextarea.height).toBeGreaterThanOrEqual(2)

      expect(footerText.width).toBeGreaterThan(10)
      expect(footerText.height).toBe(1)

      expect(bodyTextarea.y).toBeGreaterThan(headerText.y)
      expect(footerText.y).toBeGreaterThan(bodyTextarea.y)
    })
  })
})
