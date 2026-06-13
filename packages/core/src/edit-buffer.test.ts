import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { EditBuffer } from "./edit-buffer.js"
import { resolveRenderLib } from "./zig.js"
import { ManualClock } from "./testing/manual-clock.js"

async function flushNativeEvents(): Promise<void> {
  // EditBuffer forwards native events via queueMicrotask, so a manual 0ms tick
  // gives the tests a deterministic async boundary without sleeping.
  const clock = new ManualClock()
  const wait = new Promise<void>((resolve) => {
    clock.setTimeout(resolve, 0)
  })
  clock.advance(0)
  await wait
}

describe("EditBuffer", () => {
  let buffer: EditBuffer

  beforeEach(() => {
    buffer = EditBuffer.create("wcwidth")
  })

  afterEach(() => {
    buffer.destroy()
  })

  describe("setText and getText", () => {
    it("should set and retrieve text content", () => {
      buffer.setText("Hello World")
      expect(buffer.getText()).toBe("Hello World")
    })

    it("should handle empty text", () => {
      buffer.setText("")
      expect(buffer.getText()).toBe("")
    })

    it("should handle text with newlines", () => {
      const text = "Line 1\nLine 2\nLine 3"
      buffer.setText(text)
      expect(buffer.getText()).toBe(text)
    })

    it("should handle Unicode characters", () => {
      const text = "Hello 世界 🌟"
      buffer.setText(text)
      expect(buffer.getText()).toBe(text)
    })

    it("should return null bytes for zero-length getText output buffer", () => {
      buffer.setText("Hello World")

      const textBytes = (buffer as any).lib.editBufferGetText(buffer.ptr, 0)

      expect(textBytes).toBeNull()
    })
  })

  describe("cursor position", () => {
    it("should start cursor at beginning after setText", () => {
      buffer.setText("Hello World")
      const cursor = buffer.getCursorPosition()

      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
    })

    it("should track cursor position after movements", () => {
      buffer.setText("Hello World")

      buffer.moveCursorRight()
      let cursor = buffer.getCursorPosition()
      expect(cursor.col).toBe(1)

      buffer.moveCursorRight()
      cursor = buffer.getCursorPosition()
      expect(cursor.col).toBe(2)
    })

    it("should handle multi-line cursor positions", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")

      buffer.moveCursorDown()
      let cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(1)

      buffer.moveCursorDown()
      cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(2)
    })
  })

  describe("cursor movement", () => {
    it("should move cursor left and right", () => {
      buffer.setText("ABCDE")

      buffer.setCursorToLineCol(0, 5) // Move to end
      expect(buffer.getCursorPosition().col).toBe(5)

      buffer.moveCursorLeft()
      expect(buffer.getCursorPosition().col).toBe(4)

      buffer.moveCursorLeft()
      expect(buffer.getCursorPosition().col).toBe(3)
    })

    it("should move cursor up and down", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")

      buffer.moveCursorDown()
      expect(buffer.getCursorPosition().row).toBe(1)

      buffer.moveCursorDown()
      expect(buffer.getCursorPosition().row).toBe(2)

      buffer.moveCursorUp()
      expect(buffer.getCursorPosition().row).toBe(1)
    })

    it("should move to line start and end", () => {
      buffer.setText("Hello World")

      buffer.setCursorToLineCol(0, 11) // Move to end
      expect(buffer.getCursorPosition().col).toBe(11)

      const cursor = buffer.getCursorPosition()
      buffer.setCursor(cursor.row, 0)
      expect(buffer.getCursorPosition().col).toBe(0)
    })

    it("should goto specific line", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")

      buffer.gotoLine(1)
      expect(buffer.getCursorPosition().row).toBe(1)

      buffer.gotoLine(2)
      expect(buffer.getCursorPosition().row).toBe(2)
    })

    it("should handle Unicode grapheme movement correctly", () => {
      buffer.setText("A🌟B")

      expect(buffer.getCursorPosition().col).toBe(0)

      buffer.moveCursorRight() // Move to emoji
      expect(buffer.getCursorPosition().col).toBe(1)

      buffer.moveCursorRight() // Move past emoji (2 cells wide)
      expect(buffer.getCursorPosition().col).toBe(3)

      buffer.moveCursorRight() // Move to B
      expect(buffer.getCursorPosition().col).toBe(4)
    })
  })

  describe("text insertion", () => {
    it("should insert single character", () => {
      buffer.setText("Hello World")

      buffer.setCursorToLineCol(0, 11) // Move to end
      buffer.insertChar("!")

      expect(buffer.getText()).toBe("Hello World!")
    })

    it("should insert text at cursor", () => {
      buffer.setText("Hello")

      buffer.setCursorToLineCol(0, 5) // Move to end
      buffer.insertText(" World")

      expect(buffer.getText()).toBe("Hello World")
    })

    it("should insert text in middle", () => {
      buffer.setText("HelloWorld")

      buffer.setCursorToLineCol(0, 5)
      buffer.insertText(" ")

      expect(buffer.getText()).toBe("Hello World")
    })

    it("should handle continuous typing (edit session)", () => {
      buffer.setText("")

      buffer.insertText("Hello")
      buffer.insertText(" ")
      buffer.insertText("World")

      expect(buffer.getText()).toBe("Hello World")
    })

    it("should insert Unicode characters", () => {
      buffer.setText("Hello")

      buffer.setCursorToLineCol(0, 5) // Move to end
      buffer.insertText(" 世界 🌟")

      expect(buffer.getText()).toBe("Hello 世界 🌟")
    })

    it("should handle newline insertion", () => {
      buffer.setText("HelloWorld")

      buffer.setCursorToLineCol(0, 5)
      buffer.newLine()

      expect(buffer.getText()).toBe("Hello\nWorld")
    })
  })

  describe("text deletion", () => {
    it("should delete character at cursor", () => {
      buffer.setText("Hello World")

      buffer.setCursorToLineCol(0, 6)
      buffer.deleteChar()

      expect(buffer.getText()).toBe("Hello orld")
    })

    it("should delete character backward", () => {
      buffer.setText("")

      buffer.insertText("test")
      buffer.deleteCharBackward()

      expect(buffer.getText()).toBe("tes")
    })

    it("should delete range within a single line", () => {
      buffer.setText("Hello World")

      buffer.deleteRange(0, 0, 0, 5)

      expect(buffer.getText()).toBe(" World")
    })

    it("should delete range across multiple lines", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")

      buffer.deleteRange(0, 5, 2, 5)

      expect(buffer.getText()).toBe("Line 3")
    })

    it("should handle deleteRange with start equal to end (no-op)", () => {
      buffer.setText("Hello World")

      buffer.deleteRange(0, 5, 0, 5)

      expect(buffer.getText()).toBe("Hello World")
    })

    it("should handle deleteRange with reversed start and end", () => {
      buffer.setText("Hello World")

      buffer.deleteRange(0, 10, 0, 5)

      expect(buffer.getText()).toBe("Hellod")
    })

    it("should delete from middle of one line to middle of another", () => {
      buffer.setText("AAAA\nBBBB\nCCCC")

      buffer.deleteRange(0, 2, 2, 2)

      expect(buffer.getText()).toBe("AACC")
    })

    it("should delete entire content with deleteRange", () => {
      buffer.setText("Hello World")

      buffer.deleteRange(0, 0, 0, 11)

      expect(buffer.getText()).toBe("")
    })

    it("should handle deleteRange with Unicode characters", () => {
      buffer.setText("Hello 世界 🌟")

      buffer.deleteRange(0, 6, 0, 10)

      expect(buffer.getText()).toBe("Hello  🌟")
    })

    it("should delete entire line", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")

      buffer.gotoLine(1) // Go to Line 2
      buffer.deleteLine()

      expect(buffer.getText()).toBe("Line 1\nLine 3")
    })

    // TODO: Re-implement deleteToLineEnd as scripted method
    it.skip("should delete to line end", () => {
      buffer.setText("Hello World")

      buffer.setCursorToLineCol(0, 6)
      // buffer.deleteToLineEnd()

      expect(buffer.getText()).toBe("Hello ")
    })

    it("should handle backspace in active edit session", () => {
      buffer.setText("")

      buffer.insertText("test")
      buffer.deleteCharBackward()
      buffer.deleteCharBackward()

      expect(buffer.getText()).toBe("te")
    })
  })

  describe("complex editing scenarios", () => {
    it("should handle multiple edit operations in sequence", () => {
      buffer.setText("Hello World")

      buffer.setCursorToLineCol(0, 11) // Move to end
      buffer.insertText("!")

      buffer.setCursorToLineCol(0, 0) // Move to start
      buffer.insertText(">> ")

      buffer.setCursorToLineCol(0, 99) // Move to end of line
      buffer.newLine()
      buffer.insertText("New line")

      expect(buffer.getText()).toBe(">> Hello World!\nNew line")
    })

    it("should handle insert, delete, and cursor movement", () => {
      buffer.setText("AAAA\nBBBB\nCCCC")

      buffer.gotoLine(1)
      buffer.setCursorToLineCol(1, 4) // Move to end of line 1
      buffer.insertText("X")

      const text1 = buffer.getText()
      expect(text1).toBe("AAAA\nBBBBX\nCCCC")

      // After insert, cursor is at end, deleteCharBackward will delete X
      buffer.deleteCharBackward()

      expect(buffer.getText()).toBe("AAAA\nBBBB\nCCCC")
    })

    it("should handle line operations", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")

      buffer.gotoLine(1) // Go to Line 2
      buffer.deleteLine()

      // After deleting Line 2, we should have Line 1 and Line 3
      const result = buffer.getText()
      expect(result === "Line 1\nLine 3" || result === "Line 1\nLine 3\n").toBe(true)
    })
  })

  describe("history metadata", () => {
    it("should return null bytes for zero-length undo and redo output buffers", () => {
      buffer.setText("Hello")
      buffer.insertText(" World")

      const lib = (buffer as any).lib
      const undoBytes = lib.editBufferUndo(buffer.ptr, 0)
      const redoBytes = lib.editBufferRedo(buffer.ptr, 0)

      expect(undoBytes).toBeNull()
      expect(redoBytes).toBeNull()
    })
  })

  describe("range getters", () => {
    it("should return null bytes for zero-length range output buffers", () => {
      buffer.setText("Hello\nWorld")

      const lib = (buffer as any).lib

      expect(lib.editBufferGetTextRange(buffer.ptr, 0, 5, 0)).toBeNull()
      expect(lib.editBufferGetTextRangeByCoords(buffer.ptr, 0, 0, 1, 5, 0)).toBeNull()
    })
  })

  describe("setCursor methods", () => {
    it("should set cursor by line and byte offset", () => {
      buffer.setText("Hello World")

      buffer.setCursor(0, 6)
      const cursor = buffer.getCursorPosition()
      expect(cursor.col).toBe(6)
    })

    it("should set cursor by line and column", () => {
      buffer.setText("Hello World")

      buffer.setCursorToLineCol(0, 5)
      const cursor = buffer.getCursorPosition()
      expect(cursor.col).toBe(5)
    })

    it("should handle multi-line setCursorToLineCol", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")

      buffer.setCursorToLineCol(1, 3)
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(1)
      expect(cursor.col).toBe(3)
    })
  })

  describe("word boundary navigation", () => {
    it("should get next word boundary", () => {
      buffer.setText("hello world foo")
      buffer.setCursorToLineCol(0, 0)

      const nextBoundary = buffer.getNextWordBoundary()
      expect(nextBoundary.col).toBeGreaterThan(0)
    })

    it("should get previous word boundary", () => {
      buffer.setText("hello world foo")
      buffer.setCursorToLineCol(0, 15)

      const prevBoundary = buffer.getPrevWordBoundary()
      expect(prevBoundary.col).toBeLessThan(15)
    })

    it("should handle word boundary at start", () => {
      buffer.setText("hello world")
      buffer.setCursorToLineCol(0, 0)

      const prevBoundary = buffer.getPrevWordBoundary()
      expect(prevBoundary.row).toBe(0)
      expect(prevBoundary.col).toBe(0)
    })

    it("should handle word boundary at end", () => {
      buffer.setText("hello world")
      buffer.setCursorToLineCol(0, 11)

      const nextBoundary = buffer.getNextWordBoundary()
      expect(nextBoundary.col).toBe(11)
    })

    it("should navigate across lines", () => {
      buffer.setText("hello\nworld")
      buffer.setCursorToLineCol(0, 5)

      const nextBoundary = buffer.getNextWordBoundary()
      expect(nextBoundary.row).toBeGreaterThanOrEqual(0)
    })

    it("should handle punctuation boundaries", () => {
      buffer.setText("hello-world test")
      buffer.setCursorToLineCol(0, 0)

      const next1 = buffer.getNextWordBoundary()
      expect(next1.col).toBeGreaterThan(0)
    })

    it("should handle word boundaries after CJK graphemes", () => {
      // "你" = 2 cols, " " = 1 col, "好" = 2 cols
      buffer.setText("你 好")
      buffer.setCursorToLineCol(0, 0)

      const nextBoundary = buffer.getNextWordBoundary()
      expect(nextBoundary.col).toBe(3)

      buffer.setCursorToLineCol(0, 5)
      const prevBoundary = buffer.getPrevWordBoundary()
      expect(prevBoundary.col).toBe(3)
    })

    it("should handle word boundaries after emoji", () => {
      // "🌟" = 2 cols, " " = 1 col, "ok" = 2 cols
      buffer.setText("🌟 ok")
      buffer.setCursorToLineCol(0, 0)

      const nextBoundary = buffer.getNextWordBoundary()
      expect(nextBoundary.col).toBe(3)

      buffer.setCursorToLineCol(0, 5)
      const prevBoundary = buffer.getPrevWordBoundary()
      expect(prevBoundary.col).toBe(3)
    })

    it("should handle word boundaries around tabs", () => {
      // tab = 2 cols
      buffer.setText("Hello\tWorld")
      buffer.setCursorToLineCol(0, 0)

      const nextBoundary = buffer.getNextWordBoundary()
      expect(nextBoundary.col).toBe(7)

      buffer.setCursorToLineCol(0, 12)
      const prevBoundary = buffer.getPrevWordBoundary()
      expect(prevBoundary.col).toBe(7)
    })
  })

  describe("native coordinate conversion methods", () => {
    it("should convert offset to position", () => {
      buffer.setText("Hello\nWorld")

      const pos0 = buffer.offsetToPosition(0)
      expect(pos0).toEqual({ row: 0, col: 0 })

      const pos5 = buffer.offsetToPosition(5)
      expect(pos5).toEqual({ row: 0, col: 5 })

      const pos6 = buffer.offsetToPosition(6)
      expect(pos6).toEqual({ row: 1, col: 0 })

      const pos11 = buffer.offsetToPosition(11)
      expect(pos11).toEqual({ row: 1, col: 5 })
    })

    it("should convert position to offset", () => {
      buffer.setText("Hello\nWorld")

      expect(buffer.positionToOffset(0, 0)).toBe(0)
      expect(buffer.positionToOffset(0, 5)).toBe(5)
      expect(buffer.positionToOffset(1, 0)).toBe(6)
      expect(buffer.positionToOffset(1, 5)).toBe(11)
    })

    it("should get line start offset", () => {
      buffer.setText("Line1\nLine2\nLine3")

      expect(buffer.getLineStartOffset(0)).toBe(0)
      expect(buffer.getLineStartOffset(1)).toBe(6)
      expect(buffer.getLineStartOffset(2)).toBe(12)
    })

    it("should handle multiline text with varying lengths", () => {
      buffer.setText("AAA\nBB\nCCCC")

      expect(buffer.offsetToPosition(0)).toEqual({ row: 0, col: 0 })
      expect(buffer.offsetToPosition(3)).toEqual({ row: 0, col: 3 })
      expect(buffer.offsetToPosition(4)).toEqual({ row: 1, col: 0 })
      expect(buffer.offsetToPosition(6)).toEqual({ row: 1, col: 2 })
      expect(buffer.offsetToPosition(7)).toEqual({ row: 2, col: 0 })

      expect(buffer.positionToOffset(0, 0)).toBe(0)
      expect(buffer.positionToOffset(1, 0)).toBe(4)
      expect(buffer.positionToOffset(2, 0)).toBe(7)
    })

    it("should return null for invalid offset", () => {
      buffer.setText("Hello")
      const result = buffer.offsetToPosition(1000)
      expect(result).toBeNull()
    })

    it("should handle empty text", () => {
      buffer.setText("")

      const pos = buffer.offsetToPosition(0)
      expect(pos).toEqual({ row: 0, col: 0 })

      expect(buffer.positionToOffset(0, 0)).toBe(0)
      expect(buffer.getLineStartOffset(0)).toBe(0)
    })
  })

  describe("getEOL navigation", () => {
    it("should get end of line from start", () => {
      buffer.setText("Hello World")
      buffer.setCursorToLineCol(0, 0)

      const eol = buffer.getEOL()
      expect(eol.row).toBe(0)
      expect(eol.col).toBe(11)
    })

    it("should get end of line from middle", () => {
      buffer.setText("Hello World")
      buffer.setCursorToLineCol(0, 5)

      const eol = buffer.getEOL()
      expect(eol.row).toBe(0)
      expect(eol.col).toBe(11)
    })

    it("should stay at end of line when already there", () => {
      buffer.setText("Hello")
      buffer.setCursorToLineCol(0, 5)

      const eol = buffer.getEOL()
      expect(eol.row).toBe(0)
      expect(eol.col).toBe(5)
    })

    it("should handle multi-line text", () => {
      buffer.setText("Hello\nWorld\nTest")
      buffer.setCursorToLineCol(1, 0)

      const eol = buffer.getEOL()
      expect(eol.row).toBe(1)
      expect(eol.col).toBe(5)
    })

    it("should handle empty lines", () => {
      buffer.setText("Hello\n\nWorld")
      buffer.setCursorToLineCol(1, 0)

      const eol = buffer.getEOL()
      expect(eol.row).toBe(1)
      expect(eol.col).toBe(0)
    })

    it("should work on different lines", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")

      buffer.setCursorToLineCol(0, 0)
      const eol0 = buffer.getEOL()
      expect(eol0.row).toBe(0)
      expect(eol0.col).toBe(6)

      buffer.setCursorToLineCol(1, 0)
      const eol1 = buffer.getEOL()
      expect(eol1.row).toBe(1)
      expect(eol1.col).toBe(6)

      buffer.setCursorToLineCol(2, 0)
      const eol2 = buffer.getEOL()
      expect(eol2.row).toBe(2)
      expect(eol2.col).toBe(6)
    })
  })

  describe("error handling", () => {
    it("should throw error when using destroyed buffer", () => {
      buffer.setText("Test")
      buffer.destroy()

      expect(() => buffer.getText()).toThrow("EditBuffer is destroyed")
      expect(() => buffer.insertText("x")).toThrow("EditBuffer is destroyed")
      expect(() => buffer.moveCursorLeft()).toThrow("EditBuffer is destroyed")
    })
  })

  describe("line boundary operations", () => {
    it("should merge lines when backspacing at BOL", () => {
      buffer.setText("Line 1\nLine 2")
      buffer.setCursorToLineCol(1, 0) // Start of line 2
      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("Line 1Line 2")
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(6)
    })

    it("should merge lines when deleting at EOL", () => {
      buffer.setText("Line 1\nLine 2")
      buffer.setCursorToLineCol(0, 6) // End of line 1
      buffer.deleteChar()
      expect(buffer.getText()).toBe("Line 1Line 2")
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(6)
    })

    it("should handle newline insertion at BOL", () => {
      buffer.setText("Hello")
      buffer.setCursorToLineCol(0, 0)
      buffer.newLine()
      expect(buffer.getText()).toBe("\nHello")
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(1)
      expect(cursor.col).toBe(0)
    })

    it("should handle newline insertion at EOL", () => {
      buffer.setText("Hello")
      buffer.setCursorToLineCol(0, 5)
      buffer.newLine()
      expect(buffer.getText()).toBe("Hello\n")
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(1)
      expect(cursor.col).toBe(0)
    })

    it("should handle CRLF in text", () => {
      // CRLF is detected as a line break during setText
      buffer.setText("Line 1\r\nLine 2")
      // Both CR and LF are detected, so we get the text back
      const text = buffer.getText()
      // Verify we have two lines
      buffer.setCursorToLineCol(1, 0)
      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("Line 1Line 2")
    })

    it("should handle multiple consecutive newlines", () => {
      buffer.setText("A\n\n\nB")
      buffer.setCursorToLineCol(1, 0) // Empty line
      buffer.deleteCharBackward()
      expect(buffer.getText()).toBe("A\n\nB")
    })
  })

  describe("wide character handling", () => {
    it("should handle tabs correctly in edits", () => {
      buffer.setText("A\tB")
      // Tab has a display width of 2 columns (by default, rounded to multiple of 2)
      // So "A\tB" has positions: A at col 0-1, tab at col 1-2, B at col 2
      // To insert after A, we use column 1
      buffer.setCursorToLineCol(0, 1) // After A, at the tab position
      // But since setCursorToLineCol might snap to grapheme boundaries,
      // let's just verify the text remains intact when inserting at byte level
      buffer.insertText("X")
      // The insert should happen at the cursor position
      const text = buffer.getText()
      // Either AX\tB or A\tXB depending on how cursor snaps
      expect(text.includes("A") && text.includes("B") && text.includes("\t") && text.includes("X")).toBe(true)
    })

    it("should handle CJK characters correctly", () => {
      buffer.setText("世界")
      buffer.setCursorToLineCol(0, 2) // After first character (2 columns wide)
      buffer.insertText("X")
      expect(buffer.getText()).toBe("世X界")
    })

    it("should handle emoji correctly", () => {
      buffer.setText("🌟")
      buffer.setCursorToLineCol(0, 0)
      buffer.moveCursorRight()
      const cursor = buffer.getCursorPosition()
      expect(cursor.col).toBe(2) // Emoji is 2 columns wide
    })

    it("should handle mixed width text correctly", () => {
      buffer.setText("A世🌟B")
      buffer.setCursorToLineCol(0, 1) // After A
      buffer.moveCursorRight()
      const cursor = buffer.getCursorPosition()
      expect(cursor.col).toBe(3) // A(1) + 世(2)
    })
  })

  describe("multi-line insertion", () => {
    it("should insert multi-line text correctly", () => {
      buffer.setText("Start")
      buffer.setCursorToLineCol(0, 5)
      buffer.insertText("\nMiddle\nEnd")
      expect(buffer.getText()).toBe("Start\nMiddle\nEnd")
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(2)
      expect(cursor.col).toBe(3)
    })

    it("should insert multi-line text in middle", () => {
      buffer.setText("StartEnd")
      buffer.setCursorToLineCol(0, 5)
      buffer.insertText("\nMiddle\n")
      expect(buffer.getText()).toBe("Start\nMiddle\nEnd")
    })

    it("should handle inserting text with various line endings", () => {
      buffer.setText("")
      buffer.insertText("Line 1\nLine 2\rLine 3\r\nLine 4")
      const text = buffer.getText()
      // Line breaks are preserved in the buffer
      // Just verify we have 4 lines
      const lines = text.split(/\r?\n|\r/)
      expect(lines.length).toBe(4)
      expect(lines[0]).toBe("Line 1")
      expect(lines[3]).toBe("Line 4")
    })
  })
})

describe("EditBuffer Placeholder", () => {
  let buffer: EditBuffer

  beforeEach(() => {
    buffer = EditBuffer.create("wcwidth")
  })

  afterEach(() => {
    buffer.destroy()
  })
})

describe("EditBuffer Events", () => {
  describe("events", () => {
    it("should emit cursor-changed event when cursor moves", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("cursor-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello World")
      testBuffer.moveCursorRight()

      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(1) // setText + moveCursorRight
      testBuffer.destroy()
    })

    it("should emit cursor-changed event on setCursor", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("cursor-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello World")
      testBuffer.setCursorToLineCol(0, 5)
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(1) // setText + setCursor
      testBuffer.destroy()
    })

    it("should emit cursor-changed event on text insertion", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("cursor-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello")
      testBuffer.insertText(" World")
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(1) // setText + insertText
      testBuffer.destroy()
    })

    it("should emit cursor-changed event on deletion", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("cursor-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello World")
      const beforeDelete = eventCount
      testBuffer.setCursorToLineCol(0, 5)
      testBuffer.deleteChar()
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(beforeDelete + 1) // setCursor + deleteChar
      testBuffer.destroy()
    })

    it("should emit cursor-changed event on undo/redo", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("cursor-changed", () => {
        eventCount++
      })

      testBuffer.setText("Test")
      testBuffer.insertText(" Hello")

      if (testBuffer.canUndo()) {
        const beforeUndo = eventCount
        testBuffer.undo()
        await flushNativeEvents()
        expect(eventCount).toBeGreaterThan(beforeUndo)
      }

      if (testBuffer.canRedo()) {
        const beforeRedo = eventCount
        testBuffer.redo()
        await flushNativeEvents()
        expect(eventCount).toBeGreaterThan(beforeRedo)
      }

      testBuffer.destroy()
    })

    it("should handle multiple event listeners", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let count1 = 0
      let count2 = 0

      testBuffer.on("cursor-changed", () => {
        count1++
      })
      testBuffer.on("cursor-changed", () => {
        count2++
      })

      testBuffer.setText("Hello")
      testBuffer.moveCursorRight()
      await flushNativeEvents()

      expect(count1).toBeGreaterThan(1)
      expect(count2).toBeGreaterThan(1)
      expect(count1).toBe(count2)

      testBuffer.destroy()
    })

    it("should support removing event listeners", async () => {
      const testBuffer = EditBuffer.create("wcwidth")
      testBuffer.setText("Hello")

      let eventCount = 0
      const listener = () => {
        eventCount++
      }

      testBuffer.on("cursor-changed", listener)
      testBuffer.moveCursorRight()
      await flushNativeEvents()

      const firstCount = eventCount

      testBuffer.off("cursor-changed", listener)
      testBuffer.moveCursorRight()
      await flushNativeEvents()

      // Count should not have increased after removing listener
      expect(eventCount).toBe(firstCount)

      testBuffer.destroy()
    })

    it("should isolate events between different buffer instances", async () => {
      const testBuffer1 = EditBuffer.create("wcwidth")
      const testBuffer2 = EditBuffer.create("wcwidth")

      let count1 = 0
      let count2 = 0

      testBuffer1.on("cursor-changed", () => {
        count1++
      })
      testBuffer2.on("cursor-changed", () => {
        count2++
      })

      testBuffer1.setText("Buffer 1")
      await flushNativeEvents()
      const count1AfterSetText = count1
      testBuffer1.moveCursorRight()
      await flushNativeEvents()

      expect(count1).toBeGreaterThan(count1AfterSetText)
      expect(count2).toBe(0)

      testBuffer2.setText("Buffer 2")
      await flushNativeEvents()
      const count2AfterSetText = count2
      testBuffer2.moveCursorRight()
      await flushNativeEvents()

      expect(count1).toBe(count1AfterSetText + 1)
      expect(count2).toBeGreaterThan(count2AfterSetText)

      testBuffer1.destroy()
      testBuffer2.destroy()
    })

    it("should not emit events after destroy", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("cursor-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello")
      testBuffer.moveCursorRight()
      await flushNativeEvents()

      const countBeforeDestroy = eventCount

      testBuffer.destroy()

      // Trying to move cursor on destroyed buffer should throw
      // So we can't test event emission, but we can verify the instance is removed from registry
      expect(countBeforeDestroy).toBeGreaterThan(1) // setText + moveCursorRight
    })
  })

  describe("content-changed events", () => {
    it("should emit content-changed event on setText", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("content-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello World")
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(0)
      testBuffer.destroy()
    })

    it("should emit content-changed event on insertText", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("content-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello")
      await flushNativeEvents()
      const countAfterSetText = eventCount

      testBuffer.insertText(" World")
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(countAfterSetText)
      testBuffer.destroy()
    })

    it("should emit content-changed event on deleteChar", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("content-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello World")
      await flushNativeEvents()
      const countAfterSetText = eventCount

      testBuffer.setCursorToLineCol(0, 5)
      testBuffer.deleteChar()
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(countAfterSetText)
      testBuffer.destroy()
    })

    it("should emit content-changed event on deleteCharBackward", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("content-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello")
      await flushNativeEvents()
      const countAfterSetText = eventCount

      testBuffer.setCursorToLineCol(0, 5)
      testBuffer.deleteCharBackward()
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(countAfterSetText)
      testBuffer.destroy()
    })

    it("should emit content-changed event on deleteLine", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("content-changed", () => {
        eventCount++
      })

      testBuffer.setText("Line 1\nLine 2\nLine 3")
      await flushNativeEvents()
      const countAfterSetText = eventCount

      testBuffer.gotoLine(1)
      testBuffer.deleteLine()
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(countAfterSetText)
      testBuffer.destroy()
    })

    it("should emit content-changed event on newLine", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("content-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello")
      await flushNativeEvents()
      const countAfterSetText = eventCount

      testBuffer.setCursorToLineCol(0, 5)
      testBuffer.newLine()
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(countAfterSetText)
      testBuffer.destroy()
    })

    it("should handle multiple content-changed listeners", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let count1 = 0
      let count2 = 0

      testBuffer.on("content-changed", () => {
        count1++
      })
      testBuffer.on("content-changed", () => {
        count2++
      })

      testBuffer.setText("Hello")
      await flushNativeEvents()

      expect(count1).toBeGreaterThan(0)
      expect(count2).toBeGreaterThan(0)
      expect(count1).toBe(count2)

      testBuffer.destroy()
    })

    it("should support removing content-changed listeners", async () => {
      const testBuffer = EditBuffer.create("wcwidth")
      testBuffer.setText("Hello")
      await flushNativeEvents()

      let eventCount = 0
      const listener = () => {
        eventCount++
      }

      testBuffer.on("content-changed", listener)
      testBuffer.insertText(" World")
      await flushNativeEvents()

      const firstCount = eventCount

      testBuffer.off("content-changed", listener)
      testBuffer.insertText("!")
      await flushNativeEvents()

      // Count should not have increased after removing listener
      expect(eventCount).toBe(firstCount)

      testBuffer.destroy()
    })

    it("should deliver native event payload bytes through the event callback bridge", async () => {
      const lib = resolveRenderLib()
      const testBuffer = EditBuffer.create("wcwidth")

      const payload = await new Promise<ArrayBuffer>((resolve) => {
        lib.onceNativeEvent("eb_content-changed", (data) => resolve(data))
        testBuffer.setText("event payload")
      })

      const id = new DataView(payload).getUint16(0, true)

      expect(payload.byteLength).toBe(2)
      expect(id).toBe(testBuffer.id)

      testBuffer.destroy()
    })

    it("should isolate content-changed events between different buffer instances", async () => {
      const testBuffer1 = EditBuffer.create("wcwidth")
      const testBuffer2 = EditBuffer.create("wcwidth")

      let count1 = 0
      let count2 = 0

      testBuffer1.on("content-changed", () => {
        count1++
      })
      testBuffer2.on("content-changed", () => {
        count2++
      })

      testBuffer1.setText("Buffer 1")
      await flushNativeEvents()
      const count1AfterSetText = count1

      testBuffer1.insertText(" updated")
      await flushNativeEvents()

      expect(count1).toBeGreaterThan(count1AfterSetText)
      expect(count2).toBe(0)

      testBuffer2.setText("Buffer 2")
      await flushNativeEvents()
      const count2AfterSetText = count2

      testBuffer2.insertText(" updated")
      await flushNativeEvents()

      expect(count1).toBe(count1AfterSetText + 1)
      expect(count2).toBeGreaterThan(count2AfterSetText)

      testBuffer1.destroy()
      testBuffer2.destroy()
    })

    it("should not emit content-changed after destroy", async () => {
      const testBuffer = EditBuffer.create("wcwidth")

      let eventCount = 0
      testBuffer.on("content-changed", () => {
        eventCount++
      })

      testBuffer.setText("Hello")
      await flushNativeEvents()

      const countBeforeDestroy = eventCount

      testBuffer.destroy()

      // Trying to modify destroyed buffer should throw
      expect(countBeforeDestroy).toBeGreaterThan(0)
    })
  })
})

describe("EditBuffer History Management", () => {
  let buffer: EditBuffer

  beforeEach(() => {
    buffer = EditBuffer.create("wcwidth")
  })

  afterEach(() => {
    buffer.destroy()
  })

  describe("replaceText with history", () => {
    it("should create undo history when using replaceText", () => {
      buffer.replaceText("Initial text")
      expect(buffer.canUndo()).toBe(true)
    })

    it("should allow undo after replaceText", () => {
      buffer.replaceText("First text")
      expect(buffer.getText()).toBe("First text")

      buffer.undo()
      expect(buffer.getText()).toBe("")
    })

    it("should allow redo after undo of replaceText", () => {
      buffer.replaceText("First text")
      buffer.undo()
      expect(buffer.getText()).toBe("")

      buffer.redo()
      expect(buffer.getText()).toBe("First text")
    })

    it("should restore cursor position after undo and redo for mid-line edits", () => {
      buffer.setText("hello world")
      buffer.setCursorToLineCol(0, 8)

      buffer.insertText("X")
      expect(buffer.getText()).toBe("hello woXrld")
      expect(buffer.getCursorPosition().row).toBe(0)
      expect(buffer.getCursorPosition().col).toBe(9)

      buffer.undo()
      expect(buffer.getText()).toBe("hello world")
      expect(buffer.getCursorPosition().row).toBe(0)
      expect(buffer.getCursorPosition().col).toBe(8)

      buffer.redo()
      expect(buffer.getText()).toBe("hello woXrld")
      expect(buffer.getCursorPosition().row).toBe(0)
      expect(buffer.getCursorPosition().col).toBe(9)
    })

    it("should maintain history across multiple replaceText calls", () => {
      buffer.replaceText("Text 1")
      buffer.replaceText("Text 2")
      buffer.replaceText("Text 3")

      expect(buffer.getText()).toBe("Text 3")
      expect(buffer.canUndo()).toBe(true)

      buffer.undo()
      expect(buffer.getText()).toBe("Text 2")

      buffer.undo()
      expect(buffer.getText()).toBe("Text 1")

      buffer.undo()
      expect(buffer.getText()).toBe("")
    })
  })

  describe("replaceTextOwned with history", () => {
    it("should create undo history when using replaceTextOwned", () => {
      buffer.replaceTextOwned("Initial text")
      expect(buffer.canUndo()).toBe(true)
    })

    it("should allow undo after replaceTextOwned", () => {
      buffer.replaceTextOwned("First text")
      expect(buffer.getText()).toBe("First text")

      buffer.undo()
      expect(buffer.getText()).toBe("")
    })

    it("should allow redo after undo of replaceTextOwned", () => {
      buffer.replaceTextOwned("First text")
      buffer.undo()
      expect(buffer.getText()).toBe("")

      buffer.redo()
      expect(buffer.getText()).toBe("First text")
    })

    it("should work correctly with Unicode text", () => {
      buffer.replaceTextOwned("Hello 世界 🌟")
      expect(buffer.getText()).toBe("Hello 世界 🌟")
      expect(buffer.canUndo()).toBe(true)

      buffer.undo()
      expect(buffer.getText()).toBe("")
    })
  })

  describe("setTextOwned without history", () => {
    it("should not create undo history when using setTextOwned", () => {
      buffer.setTextOwned("Initial text")
      expect(buffer.canUndo()).toBe(false)
    })

    it("should work correctly with Unicode text", () => {
      buffer.setTextOwned("Hello 世界 🌟")
      expect(buffer.getText()).toBe("Hello 世界 🌟")
      expect(buffer.canUndo()).toBe(false)
    })
  })

  describe("setText without history", () => {
    it("should not create undo history when using setText", () => {
      buffer.setText("Initial text")
      expect(buffer.canUndo()).toBe(false)
    })

    it("should set text content correctly", () => {
      buffer.setText("Test content")
      expect(buffer.getText()).toBe("Test content")
    })

    it("should clear existing history", () => {
      buffer.replaceText("First text")
      expect(buffer.canUndo()).toBe(true)

      buffer.setText("Second text")
      expect(buffer.getText()).toBe("Second text")
      // setText clears all history
      expect(buffer.canUndo()).toBe(false)
    })

    it("should work with multi-line text", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")
      expect(buffer.getText()).toBe("Line 1\nLine 2\nLine 3")
      expect(buffer.canUndo()).toBe(false)
    })

    it("should work with Unicode text", () => {
      buffer.setText("Unicode 世界 🌟")
      expect(buffer.getText()).toBe("Unicode 世界 🌟")
      expect(buffer.canUndo()).toBe(false)
    })

    it("should work with empty text", () => {
      buffer.replaceText("Some text")
      buffer.setText("")
      expect(buffer.getText()).toBe("")
    })

    it("should reuse single memory slot on repeated calls", () => {
      // This tests the memory efficiency - each call should replace the previous
      buffer.setText("Text 1")
      expect(buffer.getText()).toBe("Text 1")

      buffer.setText("Text 2")
      expect(buffer.getText()).toBe("Text 2")

      buffer.setText("Text 3")
      expect(buffer.getText()).toBe("Text 3")

      // Should not have created any history
      expect(buffer.canUndo()).toBe(false)
    })
  })

  describe("mixed operations", () => {
    it("should handle replaceText followed by insertText with full undo", () => {
      buffer.replaceText("Hello")
      // replaceText places cursor at (0,0), so move to end
      buffer.setCursorToLineCol(0, 5) // Move to end
      buffer.insertText(" World")
      expect(buffer.getText()).toBe("Hello World")

      buffer.undo()
      expect(buffer.getText()).toBe("Hello")

      buffer.undo()
      expect(buffer.getText()).toBe("")
    })

    it("should handle replaceText followed by insertText", () => {
      buffer.replaceText("Hello")
      // replaceText places cursor at (0,0)
      buffer.setCursorToLineCol(0, 5) // Move to end
      buffer.insertText(" World")
      expect(buffer.getText()).toBe("Hello World")

      // Can undo the insertText
      buffer.undo()
      expect(buffer.getText()).toBe("Hello")

      // Can undo replaceText since it preserved history
      buffer.undo()
      expect(buffer.getText()).toBe("")
    })

    it("should handle setText followed by insertText", () => {
      buffer.setText("Hello")
      // setText places cursor at (0,0)
      buffer.setCursorToLineCol(0, 5) // Move to end
      buffer.insertText(" World")
      expect(buffer.getText()).toBe("Hello World")

      // Can undo the insertText
      buffer.undo()
      expect(buffer.getText()).toBe("Hello")

      // Cannot undo setText since it cleared history
      expect(buffer.canUndo()).toBe(false)
    })

    it("should handle replaceText and setText together", () => {
      buffer.replaceText("Text 1")
      buffer.setText("Text 2")
      expect(buffer.getText()).toBe("Text 2")

      // Cannot undo because setText cleared history
      expect(buffer.canUndo()).toBe(false)
    })

    it("should allow clearing history after replaceText", () => {
      buffer.replaceText("Text 1")
      buffer.replaceText("Text 2")
      expect(buffer.canUndo()).toBe(true)

      buffer.clearHistory()
      expect(buffer.canUndo()).toBe(false)
      expect(buffer.getText()).toBe("Text 2")
    })
  })

  describe("events with different methods", () => {
    it("should emit content-changed for setText", async () => {
      let eventCount = 0
      buffer.on("content-changed", () => {
        eventCount++
      })

      buffer.setText("Hello")
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(0)
    })

    it("should emit content-changed for replaceText", async () => {
      let eventCount = 0
      buffer.on("content-changed", () => {
        eventCount++
      })

      buffer.replaceText("Hello")
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(0)
    })

    it("should emit content-changed for setTextOwned", async () => {
      let eventCount = 0
      buffer.on("content-changed", () => {
        eventCount++
      })

      buffer.setTextOwned("Hello")
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(0)
    })
  })
})

describe("EditBuffer Clear Method", () => {
  let buffer: EditBuffer

  beforeEach(() => {
    buffer = EditBuffer.create("wcwidth")
  })

  afterEach(() => {
    buffer.destroy()
  })

  describe("basic clear functionality", () => {
    it("should clear text content", () => {
      buffer.setText("Hello World")
      expect(buffer.getText()).toBe("Hello World")

      buffer.clear()
      expect(buffer.getText()).toBe("")
    })

    it("should reset cursor to 0,0", () => {
      buffer.setText("Hello World")
      buffer.setCursorToLineCol(0, 5)
      expect(buffer.getCursorPosition().col).toBe(5)

      buffer.clear()
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
      expect(cursor.offset).toBe(0)
    })

    it("should clear multi-line text", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")
      expect(buffer.getText()).toBe("Line 1\nLine 2\nLine 3")

      buffer.clear()
      expect(buffer.getText()).toBe("")
    })

    it("should clear Unicode text", () => {
      buffer.setText("Hello 世界 🌟")
      expect(buffer.getText()).toBe("Hello 世界 🌟")

      buffer.clear()
      expect(buffer.getText()).toBe("")
    })

    it("should handle clearing already empty buffer", () => {
      buffer.setText("")
      expect(buffer.getText()).toBe("")

      buffer.clear()
      expect(buffer.getText()).toBe("")

      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
    })

    it("should handle clearing after multiple edits", () => {
      buffer.setText("Hello")
      buffer.setCursorToLineCol(0, 5) // Move to end
      buffer.insertText(" World")
      buffer.insertText("!")
      expect(buffer.getText()).toBe("Hello World!")

      buffer.clear()
      expect(buffer.getText()).toBe("")
    })
  })

  describe("clear with cursor positions", () => {
    it("should reset cursor from end of text", () => {
      buffer.setText("Hello World")
      buffer.setCursorToLineCol(0, 11) // End of text

      buffer.clear()
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
    })

    it("should reset cursor from middle of multi-line text", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")
      buffer.setCursorToLineCol(1, 3) // Middle of line 2

      buffer.clear()
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
    })

    it("should reset cursor from last line", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")
      buffer.gotoLine(2) // Last line

      buffer.clear()
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
    })
  })

  describe("clear without placeholder", () => {
    it("should handle clear without placeholder", () => {
      buffer.setText("Hello World")

      buffer.clear()
      expect(buffer.getText()).toBe("")
    })
  })

  describe("clear with events", () => {
    it("should emit content-changed event on clear", async () => {
      let eventCount = 0
      buffer.on("content-changed", () => {
        eventCount++
      })

      buffer.setText("Hello World")
      await flushNativeEvents()
      const countAfterSetText = eventCount

      buffer.clear()
      await flushNativeEvents()

      expect(eventCount).toBeGreaterThan(countAfterSetText)
    })

    it("should emit cursor-changed event on clear", async () => {
      let eventCount = 0
      buffer.on("cursor-changed", () => {
        eventCount++
      })

      buffer.setText("Hello World")
      buffer.setCursorToLineCol(0, 5)
      await flushNativeEvents()
      const countBeforeClear = eventCount

      buffer.clear()
      await flushNativeEvents()

      // Should emit cursor-changed when resetting cursor to 0,0
      expect(eventCount).toBeGreaterThan(countBeforeClear)
    })

    it("should emit both events on clear", async () => {
      let contentChangedCount = 0
      let cursorChangedCount = 0

      buffer.on("content-changed", () => {
        contentChangedCount++
      })
      buffer.on("cursor-changed", () => {
        cursorChangedCount++
      })

      buffer.setText("Hello World")
      buffer.setCursorToLineCol(0, 5)
      await flushNativeEvents()

      const contentCountBefore = contentChangedCount
      const cursorCountBefore = cursorChangedCount

      buffer.clear()
      await flushNativeEvents()

      expect(contentChangedCount).toBeGreaterThan(contentCountBefore)
      expect(cursorChangedCount).toBeGreaterThan(cursorCountBefore)
    })
  })

  describe("clear and subsequent operations", () => {
    it("should allow inserting text after clear", () => {
      buffer.setText("Hello")
      buffer.clear()

      buffer.insertText("World")
      expect(buffer.getText()).toBe("World")
    })

    it("should allow setText after clear", () => {
      buffer.setText("Hello")
      buffer.clear()

      buffer.setText("New Text")
      expect(buffer.getText()).toBe("New Text")
    })

    it("should maintain correct cursor after clear and insert", () => {
      buffer.setText("Hello World")
      buffer.clear()

      buffer.insertText("Test")
      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(4)
    })

    it("should allow multiple clear operations", () => {
      buffer.setText("Text 1")
      buffer.clear()
      expect(buffer.getText()).toBe("")

      buffer.setText("Text 2")
      buffer.clear()
      expect(buffer.getText()).toBe("")

      buffer.setText("Text 3")
      buffer.clear()
      expect(buffer.getText()).toBe("")
    })
  })

  describe("clear with complex scenarios", () => {
    it("should clear after edit session", () => {
      buffer.setText("Hello")
      buffer.setCursorToLineCol(0, 5) // Move to end
      buffer.insertText(" World")
      buffer.insertText("!")
      buffer.setCursorToLineCol(0, 0) // Move to start
      buffer.insertText(">> ")

      expect(buffer.getText()).toBe(">> Hello World!")

      buffer.clear()
      expect(buffer.getText()).toBe("")

      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
    })

    it("should clear after line operations", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")
      buffer.gotoLine(1)
      buffer.deleteLine()

      buffer.clear()
      expect(buffer.getText()).toBe("")
    })

    it("should clear after range deletion", () => {
      buffer.setText("Hello World Test")
      buffer.deleteRange(0, 6, 0, 11)
      expect(buffer.getText()).toBe("Hello  Test")

      buffer.clear()
      expect(buffer.getText()).toBe("")
    })

    it("should handle clear with wide characters", () => {
      buffer.setText("A世🌟B")
      buffer.clear()
      expect(buffer.getText()).toBe("")

      const cursor = buffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
    })
  })

  describe("error handling", () => {
    it("should throw error when clearing destroyed buffer", () => {
      buffer.setText("Test")
      buffer.destroy()

      expect(() => buffer.clear()).toThrow("EditBuffer is destroyed")
    })
  })

  describe("Regression Tests", () => {
    it("should handle moving left in a long line (potential BoundedArray overflow)", () => {
      const longText = "a".repeat(500)
      buffer.setText(longText)

      buffer.setCursorToLineCol(0, 500)
      buffer.moveCursorLeft()

      const cursor = buffer.getCursorPosition()
      expect(cursor.col).toBe(499)
    })
  })
})

describe("EditBuffer Memory Registry Limits", () => {
  let buffer: EditBuffer

  beforeEach(() => {
    buffer = EditBuffer.create("wcwidth")
  })

  afterEach(() => {
    buffer.destroy()
  })

  describe("Memory buffer management", () => {
    it("should handle many setText calls without exceeding limit", () => {
      for (let i = 0; i < 300; i++) {
        buffer.setText(`Text ${i}`)
      }

      expect(buffer.getText()).toBe("Text 299")
    })

    it("should handle 1000 setText calls without memory registry errors", () => {
      for (let i = 0; i < 1000; i++) {
        buffer.setText(`Text ${i}`)
      }

      expect(buffer.getText()).toBe("Text 999")
      expect(buffer.canUndo()).toBe(false)
    })

    it("should handle limited replaceText calls before hitting buffer limit", () => {
      for (let i = 0; i < 200; i++) {
        buffer.replaceText(`Text ${i}`)
      }

      expect(buffer.getText()).toBe("Text 199")
    })

    it("should handle mixed replaceText and setText calls", () => {
      for (let i = 0; i < 100; i++) {
        buffer.replaceText(`With history ${i}`)
      }

      for (let i = 0; i < 300; i++) {
        buffer.setText(`Without history ${i}`)
      }

      expect(buffer.getText()).toBe("Without history 299")
    })
  })
})
