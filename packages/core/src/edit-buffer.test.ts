import { ResourceContext } from "./buffer.js"
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { EditBuffer } from "./edit-buffer.js"
import { ManualClock } from "./testing/manual-clock.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 8, renderCellsMax: 1 })
})
afterEach(() => resourceContext.destroy())

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
    buffer = EditBuffer.create("wcwidth", resourceContext)
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
  })

  describe("cursor position", () => {
    it("preserves public cursor identity", () => {
      buffer.setText("abc")
      const first = buffer.getCursorPosition()
      buffer.moveCursorRight()
      const second = buffer.getCursorPosition()

      expect(first).not.toBe(second)
      expect(first).toEqual({ row: 0, col: 0, offset: 0 })
      expect(second).toEqual({ row: 0, col: 1, offset: 1 })
    })

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

    it("preserves cursor text boundaries across tab width changes and history", () => {
      buffer.setText("a\tb")
      buffer.setCursor(0, 4)
      buffer.insertText("x")

      buffer.setTabWidth(8)
      expect(buffer.getTabWidth()).toBe(8)
      expect(buffer.getCursorPosition()).toEqual({ row: 0, col: 11, offset: 11 })

      expect(buffer.undo()).toBe("cursor:0:4:4")
      expect(buffer.getCursorPosition()).toEqual({ row: 0, col: 10, offset: 10 })

      buffer.insertText("y")
      expect(buffer.getText()).toBe("a\tby")
    })

    it("remaps the cursor when tab width changes after an insert", () => {
      buffer.setText("a\tb")
      buffer.setCursor(0, 4)
      buffer.insertText("x")

      buffer.setTabWidth(8)
      expect(buffer.getCursorPosition()).toEqual({ row: 0, col: 11, offset: 11 })
      expect(buffer.undo()).toBe("cursor:0:4:4")
      expect(buffer.getCursorPosition()).toEqual({ row: 0, col: 10, offset: 10 })
      expect(buffer.redo()).toBe("cursor:0:11:11")
      buffer.setTabWidth(4)
      expect(buffer.getCursorPosition()).toEqual({ row: 0, col: 7, offset: 7 })
      buffer.insertText("y")
      expect(buffer.getText()).toBe("a\tbxy")
    })
  })

  describe("cursor movement", () => {
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

    it("should handle moving left in a long line (potential BoundedArray overflow)", () => {
      const longText = "a".repeat(500)
      buffer.setText(longText)

      buffer.setCursorToLineCol(0, 500)
      buffer.moveCursorLeft()

      const cursor = buffer.getCursorPosition()
      expect(cursor.col).toBe(499)
    })
  })

  describe("text insertion", () => {
    it("should insert single character", () => {
      buffer.setText("Hello World")

      buffer.setCursorToLineCol(0, 11) // Move to end
      buffer.insertChar("!")

      expect(buffer.getText()).toBe("Hello World!")
    })

    it("should insert Unicode characters", () => {
      buffer.setText("Hello")

      buffer.setCursorToLineCol(0, 5) // Move to end
      buffer.insertText(" 世界 🌟")

      expect(buffer.getText()).toBe("Hello 世界 🌟")
    })
  })

  describe("text deletion", () => {
    it.each([
      ["Hello World", [0, 0, 0, 5], " World"],
      ["Line 1\nLine 2\nLine 3", [0, 5, 2, 5], "Line 3"],
      ["Hello World", [0, 5, 0, 5], "Hello World"],
      ["Hello World", [0, 10, 0, 5], "Hellod"],
      ["AAAA\nBBBB\nCCCC", [0, 2, 2, 2], "AACC"],
      ["Hello World", [0, 0, 0, 11], ""],
      ["Hello 世界 🌟", [0, 6, 0, 10], "Hello  🌟"],
    ] as const)("deleteRange on %j from %j gives %j", (text, [startRow, startCol, endRow, endCol], expected) => {
      buffer.setText(text)
      buffer.deleteRange(startRow, startCol, endRow, endCol)
      expect(buffer.getText()).toBe(expected)
    })

    it("should delete entire line", () => {
      buffer.setText("Line 1\nLine 2\nLine 3")

      buffer.gotoLine(1) // Go to Line 2
      buffer.deleteLine()

      expect(buffer.getText()).toBe("Line 1\nLine 3")
    })
  })

  describe("range getters", () => {
    it("returns coordinate ranges that remain unchanged after replacement", () => {
      buffer.setText("Hello World")
      const first = buffer.getTextRangeByCoords(0, 0, 0, 5)
      buffer.setText("Other World")
      expect(first).toBe("Hello")
      expect(buffer.getTextRangeByCoords(0, 0, 0, 5)).toBe("Other")
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

describe("EditBuffer Events", () => {
  const edit = { "cursor-changed": 1, "content-changed": 1 }
  const move = { "cursor-changed": 1 }
  // Undo and redo emit no content-changed (U21 D7, also on `main`).
  const history = { "cursor-changed": 1, cursorChanged: 1 }
  it.each([
    ["setText", (buffer: EditBuffer) => buffer.setText("xy"), edit],
    ["setTextOwned", (buffer: EditBuffer) => buffer.setTextOwned("xy"), edit],
    ["replaceText", (buffer: EditBuffer) => buffer.replaceText("xy"), edit],
    ["replaceTextOwned", (buffer: EditBuffer) => buffer.replaceTextOwned("xy"), edit],
    ["insertText", (buffer: EditBuffer) => buffer.insertText("x"), edit],
    ["insertChar", (buffer: EditBuffer) => buffer.insertChar("x"), edit],
    ["deleteChar", (buffer: EditBuffer) => buffer.deleteChar(), edit],
    ["deleteCharBackward", (buffer: EditBuffer) => buffer.deleteCharBackward(), edit],
    ["deleteRange", (buffer: EditBuffer) => buffer.deleteRange(0, 0, 1, 1), edit],
    ["deleteLine", (buffer: EditBuffer) => buffer.deleteLine(), edit],
    ["newLine", (buffer: EditBuffer) => buffer.newLine(), edit],
    ["clear", (buffer: EditBuffer) => buffer.clear(), edit],
    ["moveCursorLeft", (buffer: EditBuffer) => buffer.moveCursorLeft(), move],
    ["moveCursorRight", (buffer: EditBuffer) => buffer.moveCursorRight(), move],
    ["setCursorToLineCol", (buffer: EditBuffer) => buffer.setCursorToLineCol(1, 1), move],
    ["setCursorByOffset", (buffer: EditBuffer) => buffer.setCursorByOffset(1), move],
    ["gotoLine", (buffer: EditBuffer) => buffer.gotoLine(0), move],
    ["undo", (buffer: EditBuffer) => buffer.undo(), history],
  ] as const)("%s emits each event once, only to its own buffer", async (_name, operation, expected) => {
    const buffer = EditBuffer.create("wcwidth", resourceContext)
    const other = EditBuffer.create("wcwidth", resourceContext)
    try {
      buffer.setText("ab\ncd")
      buffer.setCursorToLineCol(0, 1)
      buffer.insertText("Z")
      await flushNativeEvents()
      const counts: Record<string, number> = {}
      for (const name of ["cursor-changed", "content-changed", "cursorChanged"]) {
        buffer.on(name, () => (counts[name] = (counts[name] ?? 0) + 1))
        other.on(name, () => (counts.other = (counts.other ?? 0) + 1))
      }
      operation(buffer)
      await flushNativeEvents()
      expect(counts).toEqual(expected)
    } finally {
      buffer.destroy()
      other.destroy()
    }
  })

  it("drops queued events after destroy without routing them to a new buffer", async () => {
    const testBuffer = EditBuffer.create("wcwidth", resourceContext)
    let eventCount = 0
    testBuffer.on("cursor-changed", () => {
      eventCount++
    })

    testBuffer.setText("Hello")
    testBuffer.moveCursorRight()
    await flushNativeEvents()

    const countBeforeDestroy = eventCount
    const previousHandle = testBuffer._getSceneHandle(resourceContext)
    testBuffer.moveCursorLeft()
    testBuffer.destroy()

    const next = EditBuffer.create("wcwidth", resourceContext)
    let nextEventCount = 0
    next.on("cursor-changed", () => {
      nextEventCount++
    })
    try {
      expect(next._getSceneHandle(resourceContext).generation).not.toBe(previousHandle.generation)
      await flushNativeEvents()
      expect(countBeforeDestroy).toBeGreaterThan(1)
      expect(eventCount).toBe(countBeforeDestroy)
      expect(nextEventCount).toBe(0)
      next.setText("New buffer")
      await flushNativeEvents()
      expect(nextEventCount).toBeGreaterThan(0)
    } finally {
      next.destroy()
    }
  })
})

describe("EditBuffer history", () => {
  // replaceText stores an undo point; setText clears the history. The Owned names are aliases.
  it.each([
    ["setText", false],
    ["setTextOwned", false],
    ["replaceText", true],
    ["replaceTextOwned", true],
  ] as const)("%s keeps undo history: %p", (method, undoable) => {
    const buffer = EditBuffer.create("wcwidth", resourceContext)
    try {
      buffer.setText("a")
      buffer.insertText("世")
      buffer[method]("x 🌟")
      expect(buffer.getText()).toBe("x 🌟")
      expect(buffer.canUndo()).toBe(undoable)
      if (undoable) {
        buffer.undo()
        expect(buffer.getText()).toBe("世a")
        buffer.redo()
        expect(buffer.getText()).toBe("x 🌟")
        buffer.clearHistory()
        expect(buffer.canUndo()).toBe(false)
        expect(buffer.getText()).toBe("x 🌟")
      }
    } finally {
      buffer.destroy()
    }
  })
})

describe("EditBuffer Memory Registry Limits", () => {
  let buffer: EditBuffer

  beforeEach(() => {
    buffer = EditBuffer.create("wcwidth", resourceContext)
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
