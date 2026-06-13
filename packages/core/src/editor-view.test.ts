import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { EditBuffer } from "./edit-buffer.js"
import { EditorView } from "./editor-view.js"
import { RGBA } from "./lib/RGBA.js"

describe("EditorView", () => {
  let buffer: EditBuffer
  let view: EditorView

  beforeEach(() => {
    buffer = EditBuffer.create("wcwidth")
    view = EditorView.create(buffer, 40, 10)
  })

  afterEach(() => {
    view.destroy()
    buffer.destroy()
  })

  describe("initialization", () => {
    it("should create view with specified viewport dimensions", () => {
      const viewport = view.getViewport()
      expect(viewport.width).toBe(40)
      expect(viewport.height).toBe(10)
      expect(viewport.offsetY).toBe(0)
      expect(viewport.offsetX).toBe(0)
    })

    it("should start with wrap mode set to none", () => {
      expect(view.getVirtualLineCount()).toBeGreaterThanOrEqual(0)
    })
  })

  describe("viewport management", () => {
    it("should update viewport size", () => {
      view.setViewportSize(80, 20)
      const viewport = view.getViewport()
      expect(viewport.width).toBe(80)
      expect(viewport.height).toBe(20)
    })

    it("should set scroll margin", () => {
      view.setScrollMargin(0.2)
      expect(true).toBe(true)
    })

    it("should return correct virtual line count for simple text", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")
      expect(view.getVirtualLineCount()).toBe(3)
    })
  })

  describe("text wrapping", () => {
    it("should enable and disable wrapping via wrap mode", () => {
      buffer.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRST")

      expect(view.getVirtualLineCount()).toBe(1)

      view.setWrapMode("char")
      expect(view.getVirtualLineCount()).toBeGreaterThan(1)

      view.setWrapMode("none")
      expect(view.getVirtualLineCount()).toBe(1)
    })

    it("should wrap at viewport width", () => {
      buffer.setText("ABCDEFGHIJKLMNOPQRST")

      view.setWrapMode("char")
      view.setViewportSize(10, 10)

      expect(view.getVirtualLineCount()).toBe(2)

      view.setViewportSize(5, 10)
      expect(view.getVirtualLineCount()).toBe(4)

      view.setViewportSize(20, 10)
      expect(view.getVirtualLineCount()).toBe(1)
    })

    it("should change wrap mode", () => {
      buffer.setText("Hello wonderful world")

      view.setViewportSize(10, 10)

      view.setWrapMode("char")
      const charCount = view.getVirtualLineCount()
      expect(charCount).toBeGreaterThanOrEqual(2)

      view.setWrapMode("word")
      const wordCount = view.getVirtualLineCount()
      expect(wordCount).toBeGreaterThanOrEqual(2)

      view.setWrapMode("none")
      const noneCount = view.getVirtualLineCount()
      expect(noneCount).toBe(1)
    })

    it("should preserve newlines when wrapping", () => {
      buffer.setText("Short\nAnother short line\nLast")

      view.setWrapMode("char")
      view.setViewportSize(50, 10)

      expect(view.getVirtualLineCount()).toBe(3)
    })

    it("should wrap long lines with wrapping enabled", () => {
      const longLine = "This is a very long line that will definitely wrap when the viewport is narrow"
      buffer.setText(longLine)

      view.setWrapMode("char")
      view.setViewportSize(20, 10)

      const vlineCount = view.getVirtualLineCount()
      expect(vlineCount).toBeGreaterThan(1)
    })
  })

  describe("integration with EditBuffer", () => {
    it("should reflect edits made to EditBuffer", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")
      expect(view.getVirtualLineCount()).toBe(3)

      buffer.gotoLine(9999)
      buffer.newLine()
      buffer.insertText("Line 4")

      expect(view.getVirtualLineCount()).toBe(4)
    })

    it("should update after text deletion", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")
      expect(view.getVirtualLineCount()).toBe(3)

      buffer.gotoLine(1)
      buffer.deleteLine()

      expect(view.getVirtualLineCount()).toBe(2)
    })
  })

  describe("viewport with wrapping and editing", () => {
    it("should maintain wrapping after edits", () => {
      buffer.setText("Short line")

      view.setWrapMode("char")
      view.setViewportSize(20, 10)

      expect(view.getVirtualLineCount()).toBe(1)

      buffer.gotoLine(9999)
      buffer.insertText(" that becomes very long and should wrap now")

      expect(view.getVirtualLineCount()).toBeGreaterThan(1)
    })

    it("should handle viewport resize with wrapped content", () => {
      const longText = "This is a very long line that will wrap when the viewport is narrow"
      buffer.setText(longText)

      view.setWrapMode("char")
      view.setViewportSize(20, 10)

      const count20 = view.getVirtualLineCount()
      expect(count20).toBeGreaterThan(1)

      view.setViewportSize(40, 10)
      const count40 = view.getVirtualLineCount()
      expect(count40).toBeLessThan(count20)
    })
  })

  describe("selection", () => {
    it("should set and reset selection", () => {
      buffer.setText("Hello World")

      view.setSelection(0, 5)
      expect(view.hasSelection()).toBe(true)

      view.resetSelection()
      expect(view.hasSelection()).toBe(false)
    })

    it("should set selection with colors", () => {
      buffer.setText("Hello World")

      const bgColor = RGBA.fromValues(0, 0, 1, 0.3)
      const fgColor = RGBA.fromValues(1, 1, 1, 1)

      view.setSelection(0, 5, bgColor, fgColor)
      expect(view.hasSelection()).toBe(true)

      const selection = view.getSelection()
      expect(selection).toEqual({ start: 0, end: 5 })
    })

    it("should update selection end position", () => {
      buffer.setText("Hello World")

      view.setSelection(0, 5)
      expect(view.getSelectedText()).toBe("Hello")

      view.updateSelection(11)
      expect(view.getSelectedText()).toBe("Hello World")

      const selection = view.getSelection()
      expect(selection).toEqual({ start: 0, end: 11 })
    })

    it("should shrink selection with updateSelection", () => {
      buffer.setText("Hello World")

      view.setSelection(0, 11)
      expect(view.getSelectedText()).toBe("Hello World")

      view.updateSelection(5)
      expect(view.getSelectedText()).toBe("Hello")
    })

    it("should update local selection focus position", () => {
      buffer.setText("Hello World")

      const changed1 = view.setLocalSelection(0, 0, 5, 0)
      expect(changed1).toBe(true)
      expect(view.getSelectedText()).toBe("Hello")

      const changed2 = view.updateLocalSelection(0, 0, 11, 0)
      expect(changed2).toBe(true)
      expect(view.getSelectedText()).toBe("Hello World")
    })

    it("should update local selection across lines", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")

      view.setLocalSelection(2, 0, 2, 0)

      const changed = view.updateLocalSelection(2, 0, 4, 1)
      expect(changed).toBe(true)

      const selectedText = view.getSelectedText()
      expect(selectedText).toContain("ne 1")
      expect(selectedText).toContain("Line")
    })

    it("should fallback to setLocalSelection when updateLocalSelection called with no existing anchor", () => {
      buffer.setText("Hello World")

      const changed = view.updateLocalSelection(0, 0, 5, 0)
      expect(changed).toBe(true)
      expect(view.hasSelection()).toBe(true)
      expect(view.getSelectedText()).toBe("Hello")
    })

    it("should preserve anchor when updating local selection", () => {
      buffer.setText("Hello World")

      view.setLocalSelection(0, 0, 5, 0)
      expect(view.getSelectedText()).toBe("Hello")

      view.updateLocalSelection(0, 0, 11, 0)
      expect(view.getSelectedText()).toBe("Hello World")

      view.updateLocalSelection(0, 0, 3, 0)
      expect(view.getSelectedText()).toBe("Hel")
    })

    it("should handle backward selection with updateLocalSelection", () => {
      buffer.setText("Hello World")

      view.setLocalSelection(11, 0, 11, 0)

      const changed = view.updateLocalSelection(11, 0, 6, 0)
      expect(changed).toBe(true)
      expect(view.getSelectedText()).toBe("World")
    })

    it("should handle wrapped lines with updateLocalSelection", () => {
      buffer.setText("ABCDEFGHIJKLMNOPQRST")

      view.setWrapMode("char")
      view.setViewportSize(10, 10)

      view.setLocalSelection(0, 0, 0, 0)

      const changed = view.updateLocalSelection(0, 0, 5, 1)
      expect(changed).toBe(true)
      expect(view.getSelectedText()).toBe("ABCDEFGHIJKLMNO")
    })

    it("should return null bytes for zero-length selected-text output buffer", () => {
      buffer.setText("Hello World")
      view.setSelection(0, 5)

      const selectedBytes = (view as any).lib.editorViewGetSelectedTextBytes(view.ptr, 0)

      expect(selectedBytes).toBeNull()
    })
  })

  describe("text getters", () => {
    it("should return null bytes for zero-length text output buffer", () => {
      buffer.setText("Hello World")

      const textBytes = (view as any).lib.editorViewGetText(view.ptr, 0)

      expect(textBytes).toBeNull()
    })

    it("should accept an empty placeholder styled-text list", () => {
      expect(() => view.setPlaceholderStyledText([])).not.toThrow()
      expect(view.getVirtualLineCount()).toBeGreaterThanOrEqual(0)
    })
  })

  describe("word boundary navigation", () => {
    it("should get next word boundary with visual cursor", () => {
      buffer.setText("hello world foo")
      buffer.setCursorToLineCol(0, 0)

      const nextBoundary = view.getNextWordBoundary()
      expect(nextBoundary).toBeDefined()
      expect(nextBoundary.visualCol).toBeGreaterThan(0)
    })

    it("should get previous word boundary with visual cursor", () => {
      buffer.setText("hello world foo")
      buffer.setCursorToLineCol(0, 15)

      const prevBoundary = view.getPrevWordBoundary()
      expect(prevBoundary).toBeDefined()
      expect(prevBoundary.visualCol).toBeLessThan(15)
    })

    it("should handle word boundary at start", () => {
      buffer.setText("hello world")
      buffer.setCursorToLineCol(0, 0)

      const prevBoundary = view.getPrevWordBoundary()
      expect(prevBoundary.logicalRow).toBe(0)
      expect(prevBoundary.visualCol).toBe(0)
    })

    it("should handle word boundary at end", () => {
      buffer.setText("hello world")
      buffer.setCursorToLineCol(0, 11)

      const nextBoundary = view.getNextWordBoundary()
      expect(nextBoundary.visualCol).toBe(11)
    })

    it("should navigate across lines with visual coordinates", () => {
      buffer.setText("hello\nworld")
      buffer.setCursorToLineCol(0, 5)

      const nextBoundary = view.getNextWordBoundary()
      expect(nextBoundary.logicalRow).toBeGreaterThanOrEqual(0)
    })

    it("should handle wrapping when getting word boundaries", () => {
      buffer.setText("hello world test foo bar")
      view.setWrapMode("word")
      view.setViewportSize(10, 10)

      buffer.setCursorToLineCol(0, 0)
      const nextBoundary = view.getNextWordBoundary()

      expect(nextBoundary).toBeDefined()
      expect(nextBoundary.visualRow).toBeGreaterThanOrEqual(0)
      expect(nextBoundary.logicalRow).toBeGreaterThanOrEqual(0)
    })
  })

  describe("large content", () => {
    it("should handle many lines", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`).join("\n")
      buffer.setText(lines)

      expect(view.getTotalVirtualLineCount()).toBe(100)
    })

    it("should handle very long single line with wrapping", () => {
      const longLine = "A".repeat(1000)
      buffer.setText(longLine)

      view.setWrapMode("char")
      view.setViewportSize(80, 24)

      const vlineCount = view.getVirtualLineCount()
      expect(vlineCount).toBeGreaterThan(10)
    })
  })

  describe("viewport slicing", () => {
    it("should show subset of content in viewport", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n")
      buffer.setText(lines)

      const smallView = EditorView.create(buffer, 40, 5)

      expect(smallView.getTotalVirtualLineCount()).toBe(20)

      smallView.destroy()
    })
  })

  describe("error handling", () => {
    it("should throw error when using destroyed view", () => {
      view.destroy()

      expect(() => view.getVirtualLineCount()).toThrow("EditorView is destroyed")
      expect(() => view.setViewportSize(80, 24)).toThrow("EditorView is destroyed")
      expect(() => view.setWrapMode("char")).toThrow("EditorView is destroyed")
    })
  })

  describe("Unicode edge cases", () => {
    it("should handle emoji with wrapping", () => {
      buffer.setText("🌟".repeat(20))

      view.setWrapMode("char")
      view.setViewportSize(10, 10)

      expect(view.getVirtualLineCount()).toBeGreaterThan(1)
    })

    it("should handle CJK characters with wrapping", () => {
      buffer.setText("测试文字处理功能")

      view.setWrapMode("char")
      view.setViewportSize(10, 10)

      const vlineCount = view.getVirtualLineCount()
      expect(vlineCount).toBeGreaterThanOrEqual(1)
    })

    it("should handle mixed ASCII and wide characters", () => {
      buffer.setText("AB测试CD文字EF")

      view.setWrapMode("char")
      view.setViewportSize(8, 10)

      expect(view.getVirtualLineCount()).toBeGreaterThanOrEqual(1)
    })

    it("should navigate visual cursor correctly through emoji and CJK", () => {
      buffer.setText("(emoji 🌟 and CJK 世界)")

      let cursor = view.getVisualCursor()
      expect(cursor.visualRow).toBe(0)
      expect(cursor.visualCol).toBe(0)
      expect(cursor.offset).toBe(0)

      for (let i = 0; i < 6; i++) {
        buffer.moveCursorRight()
      }
      cursor = view.getVisualCursor()
      expect(cursor.offset).toBe(6)

      buffer.moveCursorRight()
      cursor = view.getVisualCursor()
      expect(cursor.offset).toBe(7)

      buffer.moveCursorRight()
      cursor = view.getVisualCursor()
      expect(cursor.offset).toBe(9)

      buffer.moveCursorLeft()
      cursor = view.getVisualCursor()
      expect(cursor.offset).toBe(7)

      buffer.moveCursorLeft()
      cursor = view.getVisualCursor()
      expect(cursor.offset).toBe(6)
    })

    it("should handle vertical navigation through emoji cells correctly", () => {
      buffer.setText("1234567890123456789\n(emoji 🌟 and CJK 世界)\n1234567890123456789")

      buffer.setCursorToLineCol(0, 7)
      let cursor = view.getVisualCursor()
      expect(cursor.visualRow).toBe(0)
      expect(cursor.visualCol).toBe(7)

      view.moveDownVisual()
      cursor = view.getVisualCursor()
      expect(cursor.visualRow).toBe(1)
      expect(cursor.visualCol).toBe(7)

      buffer.moveCursorRight()
      cursor = view.getVisualCursor()
      expect(cursor.visualCol).toBe(9)

      view.moveUpVisual()
      cursor = view.getVisualCursor()
      expect(cursor.visualRow).toBe(0)
      expect(cursor.visualCol).toBe(9)

      buffer.moveCursorLeft()
      cursor = view.getVisualCursor()
      expect(cursor.visualCol).toBe(8)

      view.moveDownVisual()
      cursor = view.getVisualCursor()
      expect(cursor.visualRow).toBe(1)
      expect(cursor.visualCol).toBe(8)

      buffer.moveCursorLeft()
      cursor = view.getVisualCursor()
      expect(cursor.visualCol).toBe(6)
    })
  })

  describe("cursor movement around multi-cell graphemes", () => {
    // These tests verify that the cursor correctly handles multi-cell graphemes like emojis (🌟)
    // and CJK characters (世界). Multi-cell graphemes occupy 2 visual columns but are treated
    // as a single logical unit for cursor movement and deletion.
    //
    // Key behaviors:
    // - moveCursorRight/Left skips over entire graphemes (no intermediate positions)
    // - deleteCharBackward deletes the entire grapheme, not individual cells
    // - Visual column positions reflect the actual display width (2 cells per wide grapheme)
    // - Logical column positions mark grapheme boundaries (skipping intermediate cell positions)

    it("should understand logical vs visual cursor positions", () => {
      buffer.setText("a🌟b")

      buffer.setCursorToLineCol(0, 0)
      expect(view.getVisualCursor().visualCol).toBe(0)

      buffer.setCursorToLineCol(0, 1)
      expect(view.getVisualCursor().visualCol).toBe(1)

      buffer.setCursorToLineCol(0, 3)
      expect(view.getVisualCursor().visualCol).toBe(3)

      buffer.setCursorToLineCol(0, 4)
      expect(view.getVisualCursor().visualCol).toBe(4)

      buffer.setCursorToLineCol(0, 0)
      buffer.moveCursorRight()
      expect(buffer.getCursorPosition().col).toBe(1)

      buffer.moveCursorRight()
      expect(buffer.getCursorPosition().col).toBe(3)
      expect(view.getVisualCursor().visualCol).toBe(3)

      buffer.moveCursorRight()
      expect(buffer.getCursorPosition().col).toBe(4)
    })

    it("should move cursor correctly around emoji (🌟) with visual positions", () => {
      buffer.setText("a🌟b")

      buffer.setCursorToLineCol(0, 1)
      let visualCursor = view.getVisualCursor()
      expect(visualCursor.visualCol).toBe(1)

      buffer.moveCursorRight()
      visualCursor = view.getVisualCursor()
      expect(visualCursor.visualCol).toBe(3)

      buffer.moveCursorRight()
      visualCursor = view.getVisualCursor()
      expect(visualCursor.visualCol).toBe(4)

      buffer.moveCursorLeft()
      visualCursor = view.getVisualCursor()
      expect(visualCursor.visualCol).toBe(3)

      buffer.moveCursorLeft()
      visualCursor = view.getVisualCursor()
      expect(visualCursor.visualCol).toBe(1)
    })

    it("should move cursor correctly around CJK characters (世界) with visual positions", () => {
      buffer.setText("a世界b")

      buffer.setCursorToLineCol(0, 0)
      expect(view.getVisualCursor().visualCol).toBe(0)

      buffer.moveCursorRight()
      expect(view.getVisualCursor().visualCol).toBe(1)

      buffer.moveCursorRight()
      expect(view.getVisualCursor().visualCol).toBe(3)

      buffer.moveCursorRight()
      expect(view.getVisualCursor().visualCol).toBe(5)

      buffer.moveCursorRight()
      expect(view.getVisualCursor().visualCol).toBe(6)

      buffer.moveCursorLeft()
      expect(view.getVisualCursor().visualCol).toBe(5)

      buffer.moveCursorLeft()
      expect(view.getVisualCursor().visualCol).toBe(3)

      buffer.moveCursorLeft()
      expect(view.getVisualCursor().visualCol).toBe(1)
    })

    it("should handle backspace correctly after emoji", () => {
      buffer.setText("a🌟b")

      buffer.setCursorToLineCol(0, 3)
      expect(view.getVisualCursor().visualCol).toBe(3)

      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("ab")
      expect(view.getVisualCursor().visualCol).toBe(1)
    })

    it("should handle backspace correctly after CJK character", () => {
      buffer.setText("世界")

      buffer.setCursorToLineCol(0, 4)
      expect(view.getVisualCursor().visualCol).toBe(4)

      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("世")
      expect(view.getVisualCursor().visualCol).toBe(2)

      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("")
      expect(view.getVisualCursor().visualCol).toBe(0)
    })

    it("should treat multi-cell graphemes as single units for cursor movement", () => {
      buffer.setText("🌟世界🎉")

      buffer.setCursorToLineCol(0, 0)
      expect(view.getVisualCursor().visualCol).toBe(0)

      buffer.moveCursorRight()
      expect(view.getVisualCursor().visualCol).toBe(2)

      buffer.moveCursorRight()
      expect(view.getVisualCursor().visualCol).toBe(4)

      buffer.moveCursorRight()
      expect(view.getVisualCursor().visualCol).toBe(6)

      buffer.moveCursorRight()
      expect(view.getVisualCursor().visualCol).toBe(8)

      buffer.moveCursorLeft()
      expect(view.getVisualCursor().visualCol).toBe(6)

      buffer.moveCursorLeft()
      expect(view.getVisualCursor().visualCol).toBe(4)

      buffer.moveCursorLeft()
      expect(view.getVisualCursor().visualCol).toBe(2)

      buffer.moveCursorLeft()
      expect(view.getVisualCursor().visualCol).toBe(0)
    })

    it("should handle backspace through mixed multi-cell graphemes", () => {
      buffer.setText("a🌟b世c")

      buffer.setCursorToLineCol(0, 7)
      expect(view.getVisualCursor().visualCol).toBe(7)

      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("a🌟b世")
      expect(view.getVisualCursor().visualCol).toBe(6)

      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("a🌟b")
      expect(view.getVisualCursor().visualCol).toBe(4)

      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("a🌟")
      expect(view.getVisualCursor().visualCol).toBe(3)

      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("a")
      expect(view.getVisualCursor().visualCol).toBe(1)

      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("")
      expect(view.getVisualCursor().visualCol).toBe(0)
    })

    it("should handle delete key correctly before multi-cell graphemes", () => {
      buffer.setText("a🌟b")

      buffer.setCursorToLineCol(0, 1)
      expect(view.getVisualCursor().visualCol).toBe(1)

      buffer.deleteChar()
      expect(buffer.getText()).toBe("ab")
      expect(view.getVisualCursor().visualCol).toBe(1)

      buffer.setCursorToLineCol(0, 0)

      buffer.deleteChar()
      expect(buffer.getText()).toBe("b")
      expect(view.getVisualCursor().visualCol).toBe(0)
    })

    it("should handle line start and end with multi-cell graphemes", () => {
      buffer.setText("🌟世界🎉")

      buffer.setCursorToLineCol(0, 0)
      expect(view.getVisualCursor().visualCol).toBe(0)

      const eol = view.getEOL()
      buffer.setCursorToLineCol(eol.logicalRow, eol.logicalCol)
      expect(view.getVisualCursor().visualCol).toBe(8)
    })
  })

  describe("visual line navigation (SOL/EOL)", () => {
    describe("without wrapping", () => {
      it("should get visual SOL on single line", () => {
        buffer.setText("Hello World")
        buffer.setCursorToLineCol(0, 6) // Middle of line

        const sol = view.getVisualSOL()
        expect(sol.logicalRow).toBe(0)
        expect(sol.logicalCol).toBe(0)
        expect(sol.visualRow).toBe(0)
        expect(sol.visualCol).toBe(0)
        expect(sol.offset).toBe(0)
      })

      it("should get visual EOL on single line", () => {
        buffer.setText("Hello World")
        buffer.setCursorToLineCol(0, 6) // Middle of line

        const eol = view.getVisualEOL()
        expect(eol.logicalRow).toBe(0)
        expect(eol.logicalCol).toBe(11)
        expect(eol.visualRow).toBe(0)
        expect(eol.visualCol).toBe(11)
      })

      it("should get visual SOL/EOL on multi-line text", () => {
        buffer.setText("Line 1\nLine 2\nLine 3")

        // Test on second line
        buffer.setCursorToLineCol(1, 3)

        const sol = view.getVisualSOL()
        expect(sol.logicalRow).toBe(1)
        expect(sol.logicalCol).toBe(0)
        expect(sol.visualRow).toBe(1)
        expect(sol.visualCol).toBe(0)

        const eol = view.getVisualEOL()
        expect(eol.logicalRow).toBe(1)
        expect(eol.logicalCol).toBe(6)
        expect(eol.visualRow).toBe(1)
        expect(eol.visualCol).toBe(6)
      })

      it("should handle visual SOL/EOL at line boundaries", () => {
        buffer.setText("ABC\nDEF")

        // At start of line 0
        buffer.setCursorToLineCol(0, 0)
        let sol = view.getVisualSOL()
        expect(sol.logicalCol).toBe(0)

        // At end of line 0
        buffer.setCursorToLineCol(0, 3)
        let eol = view.getVisualEOL()
        expect(eol.logicalCol).toBe(3)

        // At start of line 1
        buffer.setCursorToLineCol(1, 0)
        sol = view.getVisualSOL()
        expect(sol.logicalRow).toBe(1)
        expect(sol.logicalCol).toBe(0)
      })
    })

    describe("with wrapping", () => {
      it("should get SOL of first wrapped line", () => {
        buffer.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        view.setWrapMode("char")
        view.setViewportSize(10, 10)

        // Cursor at position 0 (first visual line)
        buffer.setCursorToLineCol(0, 0)

        const sol = view.getVisualSOL()
        expect(sol.logicalRow).toBe(0)
        expect(sol.logicalCol).toBe(0)
        expect(sol.visualRow).toBe(0)
        expect(sol.visualCol).toBe(0)
      })

      it("should get EOL of first wrapped line", () => {
        buffer.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        view.setWrapMode("char")
        view.setViewportSize(10, 10)

        buffer.setCursorToLineCol(0, 5)

        const eol = view.getVisualEOL()
        expect(eol.logicalRow).toBe(0)
        expect(eol.logicalCol).toBe(9)
        expect(eol.visualRow).toBe(0)
        expect(eol.visualCol).toBe(9)
      })

      it("should get SOL of second wrapped line", () => {
        buffer.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        view.setWrapMode("char")
        view.setViewportSize(10, 10)

        buffer.setCursorToLineCol(0, 15)

        const sol = view.getVisualSOL()
        expect(sol.logicalRow).toBe(0)
        expect(sol.logicalCol).toBe(10)
        expect(sol.visualRow).toBe(1)
        expect(sol.visualCol).toBe(0)
      })

      it("should get EOL of second wrapped line", () => {
        buffer.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        view.setWrapMode("char")
        view.setViewportSize(10, 10)

        buffer.setCursorToLineCol(0, 15)

        const eol = view.getVisualEOL()
        expect(eol.logicalRow).toBe(0)
        expect(eol.logicalCol).toBe(19)
        expect(eol.visualRow).toBe(1)
        expect(eol.visualCol).toBe(9)
      })

      it("should get EOL of last wrapped line (end of logical line)", () => {
        buffer.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        view.setWrapMode("char")
        view.setViewportSize(10, 10)

        buffer.setCursorToLineCol(0, 25)

        const eol = view.getVisualEOL()
        expect(eol.logicalRow).toBe(0)
        expect(eol.logicalCol).toBe(26)
        expect(eol.visualRow).toBe(2)
        expect(eol.visualCol).toBe(6)
      })

      it("should handle word wrapping correctly", () => {
        buffer.setText("Hello wonderful world of text")
        view.setWrapMode("word")
        view.setViewportSize(15, 10)

        buffer.setCursorToLineCol(0, 20)

        const vcursor = view.getVisualCursor()
        expect(vcursor.visualRow).toBeGreaterThan(0)

        const sol = view.getVisualSOL()
        expect(sol.visualRow).toBe(vcursor.visualRow)
        expect(sol.visualCol).toBe(0)
        expect(sol.logicalRow).toBe(0)
        expect(sol.logicalCol).toBeGreaterThan(0)

        const eol = view.getVisualEOL()
        expect(eol.visualRow).toBe(vcursor.visualRow)
        expect(eol.logicalRow).toBe(0)
        expect(eol.logicalCol).toBeGreaterThan(sol.logicalCol)
      })

      it("should move cursor to END of current visual line, NOT start of next line", () => {
        buffer.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        view.setWrapMode("char")
        view.setViewportSize(10, 10)

        buffer.setCursorToLineCol(0, 5)
        let vcursor = view.getVisualCursor()
        expect(vcursor.visualRow).toBe(0)
        expect(vcursor.logicalCol).toBe(5)

        const eol = view.getVisualEOL()
        buffer.setCursor(eol.logicalRow, eol.logicalCol)

        const finalCursor = buffer.getCursorPosition()
        const finalVCursor = view.getVisualCursor()

        expect(finalVCursor.visualRow).toBe(0)
        expect(finalCursor.col).toBe(9)
      })

      it("should navigate through multiple wrapped lines", () => {
        buffer.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        view.setWrapMode("char")
        view.setViewportSize(10, 10)

        const positions = [0, 10, 20, 30]

        for (const pos of positions) {
          buffer.setCursorToLineCol(0, pos)

          const vcursor = view.getVisualCursor()
          const sol = view.getVisualSOL()
          const eol = view.getVisualEOL()

          expect(sol.visualCol).toBe(0)
          expect(sol.visualRow).toBe(vcursor.visualRow)

          expect(eol.logicalCol).toBeGreaterThan(sol.logicalCol)
          expect(eol.visualRow).toBe(vcursor.visualRow)
        }
      })
    })

    describe("with multi-byte characters", () => {
      it("should handle emoji in visual SOL/EOL", () => {
        buffer.setText("Hello 🌟 World")
        buffer.setCursorToLineCol(0, 8) // After emoji

        const sol = view.getVisualSOL()
        expect(sol.logicalCol).toBe(0)
        expect(sol.visualCol).toBe(0)

        const eol = view.getVisualEOL()
        expect(eol.logicalCol).toBe(14)
        expect(eol.visualCol).toBe(14) // Visual width of the line
      })

      it("should handle CJK characters in visual SOL/EOL", () => {
        buffer.setText("测试文字")
        buffer.setCursorToLineCol(0, 2) // Middle

        const sol = view.getVisualSOL()
        expect(sol.logicalCol).toBe(0)
        expect(sol.visualCol).toBe(0)

        const eol = view.getVisualEOL()
        expect(eol.logicalRow).toBe(0)
        expect(eol.logicalCol).toBe(8) // CJK text line width
        expect(eol.visualCol).toBe(8) // Visual width
      })

      it("should handle wrapped emoji correctly", () => {
        buffer.setText("🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟") // 10 emoji
        view.setWrapMode("char")
        view.setViewportSize(10, 10)

        // First wrapped line
        buffer.setCursorToLineCol(0, 2)
        let sol = view.getVisualSOL()
        let eol = view.getVisualEOL()
        let vcursor = view.getVisualCursor()

        expect(vcursor.visualRow).toBe(0)
        expect(sol.logicalCol).toBe(0)
        expect(sol.visualCol).toBe(0)
        expect(eol.logicalCol).toBeGreaterThan(0)
        expect(eol.visualCol).toBeGreaterThan(0)

        // Second wrapped line - need to be far enough to be on next visual line
        buffer.setCursorToLineCol(0, 12) // Past first 5 emoji (10 logical cols)
        vcursor = view.getVisualCursor()
        sol = view.getVisualSOL()
        eol = view.getVisualEOL()

        expect(vcursor.visualRow).toBe(1) // Should be on second visual line
        expect(sol.visualCol).toBe(0)
        expect(sol.logicalCol).toBeGreaterThan(0)
        expect(eol.logicalCol).toBe(20) // End of logical line
      })

      it("should handle mixed ASCII and CJK with wrapping", () => {
        buffer.setText("AB测试CD文字EF") // Mixed width chars
        view.setWrapMode("char")
        view.setViewportSize(8, 10)

        buffer.setCursorToLineCol(0, 5)

        const vcursor = view.getVisualCursor()
        const sol = view.getVisualSOL()
        const eol = view.getVisualEOL()

        expect(sol.visualRow).toBe(vcursor.visualRow)
        expect(sol.visualCol).toBe(0)
        expect(eol.visualRow).toBe(vcursor.visualRow)
        expect(eol.visualCol).toBeGreaterThan(0)
      })
    })

    describe("edge cases", () => {
      it("should handle empty line", () => {
        buffer.setText("\n")
        buffer.setCursorToLineCol(0, 0)

        const sol = view.getVisualSOL()
        const eol = view.getVisualEOL()

        expect(sol.logicalRow).toBe(0)
        expect(sol.logicalCol).toBe(0)
        expect(eol.logicalRow).toBe(0)
        expect(eol.logicalCol).toBe(0)
      })

      it("should handle cursor at exact wrap boundary", () => {
        buffer.setText("0123456789ABCDEFGHIJ")
        view.setWrapMode("char")
        view.setViewportSize(10, 10)

        // Cursor at position 10 (start of second visual line)
        buffer.setCursorToLineCol(0, 10)

        const vcursor = view.getVisualCursor()
        expect(vcursor.visualRow).toBe(1)

        const sol = view.getVisualSOL()
        expect(sol.logicalCol).toBe(10)
        expect(sol.visualRow).toBe(1)
        expect(sol.visualCol).toBe(0)

        const eol = view.getVisualEOL()
        expect(eol.logicalCol).toBe(20)
        expect(eol.visualRow).toBe(1)
      })

      it("should handle single character line", () => {
        buffer.setText("X")
        buffer.setCursorToLineCol(0, 0)

        const sol = view.getVisualSOL()
        const eol = view.getVisualEOL()

        expect(sol.logicalCol).toBe(0)
        expect(eol.logicalCol).toBe(1)
      })

      it("should compare logical EOL vs visual EOL on wrapped line", () => {
        buffer.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        view.setWrapMode("char")
        view.setViewportSize(10, 10)

        buffer.setCursorToLineCol(0, 5)

        const logicalEOL = view.getEOL()
        const visualEOL = view.getVisualEOL()

        expect(logicalEOL.logicalCol).toBe(26)
        expect(visualEOL.logicalCol).toBe(9)
        expect(visualEOL.visualRow).toBe(0)
      })
    })
  })
})
