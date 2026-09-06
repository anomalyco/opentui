import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { OptimizedBuffer, ResourceContext } from "./buffer.js"
import { TextBuffer } from "./text-buffer.js"
import { TextBufferView } from "./text-buffer-view.js"
import { StyledText, stringToStyledText } from "./lib/styled-text.js"
import { RGBA } from "./lib/RGBA.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 32, renderCellsMax: 4096 })
})
afterEach(() => resourceContext.destroy())

it("cached word and CJK breaks retain streaming source order", () => {
  const part = "AB \u65e5\u672c\u3002\u8a9e\u6587 "
  const layouts = []
  for (const fragmented of [false, true]) {
    const buffer = TextBuffer.create("wcwidth", resourceContext)
    const view = TextBufferView.create(buffer)
    const screen = OptimizedBuffer.create(10, 256, "wcwidth", { owner: resourceContext })
    try {
      if (fragmented) {
        for (let i = 0; i < 64; i++) buffer.append(part)
      } else {
        buffer.setText(part.repeat(64))
      }
      view.setWrapMode("word")
      for (const width of [6, 8, 6]) {
        view.setWrapWidth(width)
        screen.clear()
        screen.drawTextBuffer(view, 0, 0)
        const lines = view.lineInfo
        layouts.push({
          rows: new TextDecoder().decode(screen.getRealCharBytes(true)),
          starts: lines.lineStartCols,
          widths: lines.lineWidthCols,
        })
      }
    } finally {
      screen.destroy()
      view.destroy()
      buffer.destroy()
    }
  }
  expect(layouts.slice(0, 3)).toEqual(layouts.slice(3))
})

for (const method of ["unicode", "unicode-wide", "wcwidth"] as const) {
  for (const [name, parts, width, expectedRows] of [
    [
      "mixed CJK and split flags using the existing word policy",
      ["\u65e5\u672c\u{1f1fa}", "\u{1f1f8}\u{1f1fa}\u{1f1f8}\u8a9e\u6587"],
      4,
      ["\u65e5\u672c", "\u{1f1fa}\u{1f1f8}\u{1f1fa}\u{1f1f8}", "\u8a9e\u6587"],
    ],
    [
      "non-CJK chunk-local flag boundaries",
      ["\u{1f1e6}", "\u{1f1e7}\u{1f1e8}", "\u{1f1e9}\u{1f1ea}\u{1f1eb}"],
      3,
      ["\u{1f1e6}\u{1f1e7}\u{1f1e8}", "\u{1f1e9}\u{1f1ea}\u{1f1eb}"],
    ],
    [
      "mixed CJK and a split modifier using the existing word policy",
      ["\u65e5\u672c\u{1f44b}", "\u{1f3fb}\u8a9e\u6587"],
      4,
      ["\u65e5\u672c", "\u{1f44b}\u{1f3fb}", "\u8a9e\u6587"],
    ],
    [
      "mixed CJK and a split ZWJ using the existing word policy",
      ["\u65e5\u672c\u{1f469}\u200d", "\u{1f4bb}\u8a9e\u6587"],
      4,
      ["\u65e5\u672c", "\u{1f469}\u200d\u{1f4bb}", "\u8a9e\u6587"],
    ],
    [
      "existing modifier and ZWJ limitations",
      ["\u65e5\u672c\u{1f469}", "\u{1f3fb}\u200d\u{1f4bb}\u8a9e\u6587"],
      6,
      ["\u65e5\u672c\u{1f469}", "\u{1f3fb}\u200d\u{1f4bb}\u8a9e", "\u6587"],
    ],
    [
      "CJK opportunities on logical lines following an unsafe line",
      ["\u65e5\u672c\u{1f44b}", "\u{1f3fb}\u8a9e\u6587\n\nA \u65e5\u672c\u8a9e"],
      4,
      ["\u65e5\u672c", "\u{1f44b}\u{1f3fb}", "\u8a9e\u6587", "A \u65e5", "\u672c\u8a9e"],
    ],
    ["kana punctuation", ["AB \u30ab", "\u30fb\u30ca"], 6, ["AB", "\u30ab\u30fb\u30ca"]],
  ] as const) {
    it(`word wrapping preserves ${name} across appends (${method})`, () => {
      const buffer = TextBuffer.create(method, resourceContext)
      const view = TextBufferView.create(buffer)
      const screen = OptimizedBuffer.create(width + 1, 8, method, { owner: resourceContext })
      try {
        for (const part of parts) buffer.append(part)
        view.setWrapMode("word")
        for (const wrapWidth of [width, width + 1, width]) {
          view.setWrapWidth(wrapWidth)
          const measure = view.measureForDimensions(wrapWidth, 8)
          const lines = view.lineInfo
          expect(Math.max(...lines.lineWidthCols)).toBeLessThanOrEqual(wrapWidth)
          expect(measure).toEqual({
            lineCount: lines.lineWidthCols.length,
            widthColsMax: Math.max(...lines.lineWidthCols),
          })
        }
        screen.clear()
        screen.drawTextBuffer(view, 0, 0)
        const rows = new TextDecoder()
          .decode(screen.getRealCharBytes(true))
          .split("\n")
          .map((row) => row.trimEnd())
          .filter(Boolean)
        expect(rows).toEqual([...expectedRows])
        expect(buffer.getPlainText()).toBe(parts.join(""))
      } finally {
        screen.destroy()
        view.destroy()
        buffer.destroy()
      }
    })
  }
}

for (const method of ["unicode", "unicode-wide"] as const) {
  for (const [base, mark, suffix] of [
    ["\u304b", "\u3099", "\u304f"],
    ["\u306f", "\u309a", "\u3072"],
  ]) {
    it(`word wrapping retains an appended kana mark (${method}, ${mark.codePointAt(0)})`, () => {
      const buffer = TextBuffer.create(method, resourceContext)
      const view = TextBufferView.create(buffer)
      const screen = OptimizedBuffer.create(8, 2, method, { owner: resourceContext })
      try {
        buffer.setText(base)
        buffer.append(mark + suffix)
        view.setWrapMode("word")
        view.setWrapWidth(8)
        screen.clear()
        screen.drawTextBuffer(view, 0, 0)
        expect(new TextDecoder().decode(screen.getRealCharBytes(true)).trim()).toBe(base + mark + suffix)
      } finally {
        screen.destroy()
        view.destroy()
        buffer.destroy()
      }
    })
  }
}

describe("TextBufferView", () => {
  let buffer: TextBuffer
  let view: TextBufferView

  beforeEach(() => {
    buffer = TextBuffer.create("wcwidth", resourceContext)
    view = TextBufferView.create(buffer)
  })

  afterEach(() => {
    view.destroy()
    buffer.destroy()
  })

  describe("bounded source rows", () => {
    it("copies only requested logical visual rows without changing the viewport or selection", () => {
      buffer.setText(Array.from({ length: 10000 }, (_, i) => `row-${i}`).join("\n"))
      view.setViewport(0, 3, 20, 4)
      view.setSelection(18, 23)
      const selected = view.getSelectedText()
      const selection = view.getSelection()
      const visible = view.lineInfo
      const sources = view.getLineSources(9995, 3)
      expect(sources).toEqual([9995, 9996, 9997])
      expect(view.getLineSources(9999, 10)).toEqual([9999])
      expect(view.getLineSources(10000, 1)).toEqual([])
      expect(view.getLineSources(0, 0)).toEqual([])
      expect(view.lineInfo).toEqual(visible)
      expect(view.getSelection()).toEqual(selection)
      expect(view.getSelectedText()).toBe(selected)
      buffer.setText("replacement")
      expect(sources).toEqual([9995, 9996, 9997])
      expect(view.getLineSources(0, 10)).toEqual([0])
    })

    it("reads current native mappings after content and layout changes at the same visual-row count", () => {
      buffer.setText("abcdefgh\nx")
      view.setWrapMode("char")
      view.setWrapWidth(4)
      expect(view.getLineSources(0, 3)).toEqual([0, 0, 1])
      buffer.setText("x\nabcdefgh")
      expect(view.getVirtualLineCount()).toBe(3)
      expect(view.getLineSources(0, 3)).toEqual([0, 1, 1])
      buffer.setStyledText(stringToStyledText("abc\ndefg"))
      view.setFirstLineOffset(2)
      expect(view.getVirtualLineCount()).toBe(3)
      expect(view.getLineSources(0, 3)).toEqual([0, 0, 1])
      view.setFirstLineOffset(0)
      view.setWrapWidth(3)
      expect(view.getVirtualLineCount()).toBe(3)
      expect(view.getLineSources(0, 3)).toEqual([0, 1, 1])
      buffer.setText("\tx\ny")
      buffer.setTabWidth(4)
      view.setWrapWidth(4)
      expect(view.getVirtualLineCount()).toBe(3)
      expect(view.getLineSources(0, 3)).toEqual([0, 0, 1])
      buffer.setTabWidth(2)
      buffer.setText("x\n\tyz")
      view.setWrapWidth(3)
      expect(view.getVirtualLineCount()).toBe(3)
      expect(view.getLineSources(0, 3)).toEqual([0, 1, 1])
      view.setWrapMode("word")
      expect(view.getLineSources(1, 2)).toEqual(view.logicalLineInfo.lineSources.slice(1, 3))
      view.setViewportSize(4, 2)
      view.setTruncate(true)
      expect(view.getLineSources(0, 5)).toEqual(view.logicalLineInfo.lineSources)
      buffer.clear()
      expect(view.getLineSources(0, 5)).toEqual(view.logicalLineInfo.lineSources)
      buffer.append("a\nb")
      expect(view.getLineSources(0, 5)).toEqual([0, 1])
      buffer.reset()
      expect(view.getLineSources(0, 5)).toEqual(view.logicalLineInfo.lineSources)
    })

    it("rejects invalid row ranges and use after destruction", () => {
      for (const value of [-1, 0.5, NaN, Infinity, 2 ** 32]) {
        expect(() => view.getLineSources(value, 1)).toThrow(RangeError)
        expect(() => view.getLineSources(0, value)).toThrow(RangeError)
      }
      view.destroy()
      expect(() => view.getLineSources(0, 1)).toThrow("TextBufferView is destroyed")
    })
  })

  it("reset preserves live view ellipsis", () => {
    const output = OptimizedBuffer.create(10, 1, "wcwidth", { owner: resourceContext })
    try {
      view.setTruncate(true)
      view.setViewport(0, 0, 10, 1)
      buffer.reset()
      buffer.setText("")
      buffer.append("0123456789ABCDEFGHIJ")
      output.clear()
      output.drawTextBuffer(view, 0, 0)
      expect(new TextDecoder().decode(output.getRealCharBytes())).toBe("012...GHIJ")
    } finally {
      output.destroy()
    }
  })

  describe("lineInfo getter with wrapping", () => {
    it("should return line info for empty buffer", () => {
      const emptyText = stringToStyledText("")
      buffer.setStyledText(emptyText)

      const lineInfo = view.lineInfo
      expect(lineInfo.lineStartCols).toEqual([0])
      expect(lineInfo.lineWidthCols).toEqual([0])
    })

    it("should return single line info for simple text without newlines", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      const lineInfo = view.lineInfo
      expect(lineInfo.lineStartCols).toEqual([0])
      expect(lineInfo.lineWidthCols.length).toBe(1)
      expect(lineInfo.lineWidthCols[0]).toBeGreaterThan(0)
    })

    it("should handle single newline correctly", () => {
      const styledText = stringToStyledText("Hello\nWorld")
      buffer.setStyledText(styledText)

      const lineInfo = view.lineInfo
      // With newline-aware offsets: "Hello" (0-4) + newline (5) + "World" starts at 6
      expect(lineInfo.lineStartCols).toEqual([0, 6])
      expect(lineInfo.lineWidthCols.length).toBe(2)
      expect(lineInfo.lineWidthCols[0]).toBeGreaterThan(0)
      expect(lineInfo.lineWidthCols[1]).toBeGreaterThan(0)
    })

    it("should return virtual line info when text wrapping is enabled", () => {
      const longText = "This is a very long text that should wrap when the text wrapping is enabled."
      const styledText = stringToStyledText(longText)
      buffer.setStyledText(styledText)

      const unwrappedInfo = view.lineInfo
      expect(unwrappedInfo.lineStartCols).toEqual([0])
      expect(unwrappedInfo.lineWidthCols.length).toBe(1)
      expect(unwrappedInfo.lineWidthCols[0]).toBe(76)

      view.setWrapMode("char") // Enable wrapping
      view.setWrapWidth(20)

      const wrappedInfo = view.lineInfo

      expect(wrappedInfo.lineStartCols.length).toBeGreaterThan(1)
      expect(wrappedInfo.lineWidthCols.length).toBeGreaterThan(1)

      for (const width of wrappedInfo.lineWidthCols) {
        expect(width).toBeLessThanOrEqual(20)
      }

      for (let i = 1; i < wrappedInfo.lineStartCols.length; i++) {
        expect(wrappedInfo.lineStartCols[i]).toBeGreaterThan(wrappedInfo.lineStartCols[i - 1])
      }
    })

    it("should return correct lineInfo for word wrapping", () => {
      const text = "Hello world this is a test"
      const styledText = stringToStyledText(text)
      buffer.setStyledText(styledText)

      view.setWrapMode("word")
      view.setWrapWidth(12)

      const lineInfo = view.lineInfo

      expect(lineInfo.lineStartCols.length).toBeGreaterThan(1)

      for (const width of lineInfo.lineWidthCols) {
        expect(width).toBeLessThanOrEqual(12)
      }
    })

    it("should return correct lineInfo for char wrapping", () => {
      const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      const styledText = stringToStyledText(text)
      buffer.setStyledText(styledText)

      view.setWrapMode("char")
      view.setWrapWidth(10)

      const lineInfo = view.lineInfo

      expect(lineInfo.lineStartCols).toEqual([0, 10, 20])
      expect(lineInfo.lineWidthCols).toEqual([10, 10, 6])
    })

    it("should update lineInfo when wrap width changes", () => {
      const text = "The quick brown fox jumps over the lazy dog"
      const styledText = stringToStyledText(text)
      buffer.setStyledText(styledText)

      view.setWrapMode("char") // Enable wrapping
      view.setWrapWidth(15)

      const lineInfo1 = view.lineInfo
      const lineCount1 = lineInfo1.lineStartCols.length

      view.setWrapWidth(30)

      const lineInfo2 = view.lineInfo
      const lineCount2 = lineInfo2.lineStartCols.length

      expect(lineCount2).toBeLessThan(lineCount1)
    })

    it("should return original lineInfo when wrap is disabled", () => {
      const text = "Line 1\nLine 2\nLine 3"
      const styledText = stringToStyledText(text)
      buffer.setStyledText(styledText)

      const originalInfo = view.lineInfo
      // With newline-aware offsets: Line 0 (0-5) + newline (6) + Line 1 (7-12) + newline (13) + Line 2 (14-19)
      expect(originalInfo.lineStartCols).toEqual([0, 7, 14])

      view.setWrapMode("char") // Enable wrapping
      view.setWrapWidth(5)

      const wrappedInfo = view.lineInfo
      expect(wrappedInfo.lineStartCols.length).toBeGreaterThan(3)

      view.setWrapMode("none") // Disable wrapping
      view.setWrapWidth(null)

      const unwrappedInfo = view.lineInfo
      expect(unwrappedInfo.lineStartCols).toEqual([0, 7, 14])
    })

    it("should return extended wrap info", () => {
      const text = "Line 1 content\nLine 2"
      const styledText = stringToStyledText(text)
      buffer.setStyledText(styledText)

      view.setWrapMode("char")
      view.setWrapWidth(10)

      // Line 1 content (14 chars) wraps into two lines:
      // "Line 1 con" (10)
      // "tent" (4)
      // Line 2 (6 chars) fits on one line

      const info = view.lineInfo

      expect(info.lineSources.length).toBe(3)
      expect(info.lineWraps.length).toBe(3)

      // First visual line: source line 0, wrap 0
      expect(info.lineSources[0]).toBe(0)
      expect(info.lineWraps[0]).toBe(0)

      // Second visual line: source line 0, wrap 1 (continuation)
      expect(info.lineSources[1]).toBe(0)
      expect(info.lineWraps[1]).toBe(1)

      // Third visual line: source line 1, wrap 0
      expect(info.lineSources[2]).toBe(1)
      expect(info.lineWraps[2]).toBe(0)
    })
  })

  describe("getSelectedText", () => {
    it("should return empty string when no selection", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      const selectedText = view.getSelectedText()
      expect(selectedText).toBe("")
    })

    it("should return selected text for simple selection", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      view.setSelection(6, 11)
      const selectedText = view.getSelectedText()
      expect(selectedText).toBe("World")
    })

    it("should return selected text with newlines", () => {
      const styledText = stringToStyledText("Line 1\nLine 2\nLine 3")
      buffer.setStyledText(styledText)

      // Rope offsets: "Line 1" (0-5) + newline (6) + "Line 2" (7-12) + newline (13) + "Line 3" (14-19)
      // Selection [0, 9) = "Line 1" (0-5) + newline (6) + "Li" (7-8) = 9 chars
      view.setSelection(0, 9)
      const selectedText = view.getSelectedText()
      expect(selectedText).toBe("Line 1\nLi")
    })

    it("should handle Unicode characters in selection", () => {
      const styledText = stringToStyledText("Hello 世界 🌟")
      buffer.setStyledText(styledText)

      view.setSelection(6, 12)
      const selectedText = view.getSelectedText()
      expect(selectedText).toBe("世界 🌟")
    })

    it("should handle selection reset", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      view.setSelection(6, 11)
      expect(view.getSelectedText()).toBe("World")

      view.resetSelection()
      expect(view.getSelectedText()).toBe("")
    })
  })

  describe("selection state", () => {
    it("should track selection state", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      expect(view.hasSelection()).toBe(false)

      view.setSelection(0, 5)
      expect(view.hasSelection()).toBe(true)

      const selection = view.getSelection()
      expect(selection).toEqual({ start: 0, end: 5 })

      view.resetSelection()
      expect(view.hasSelection()).toBe(false)
    })

    it("should update selection end position", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      view.setSelection(0, 5)
      expect(view.getSelectedText()).toBe("Hello")

      view.updateSelection(11)
      expect(view.getSelectedText()).toBe("Hello World")

      const selection = view.getSelection()
      expect(selection).toEqual({ start: 0, end: 11 })
    })

    it("should shrink selection with updateSelection", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      view.setSelection(0, 11)
      expect(view.getSelectedText()).toBe("Hello World")

      view.updateSelection(5)
      expect(view.getSelectedText()).toBe("Hello")

      const selection = view.getSelection()
      expect(selection).toEqual({ start: 0, end: 5 })
    })

    it("should do nothing when updateSelection called with no selection", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      expect(view.hasSelection()).toBe(false)

      view.updateSelection(5)
      expect(view.hasSelection()).toBe(false)
      expect(view.getSelectedText()).toBe("")
    })

    it("should update local selection focus position", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      // Inclusive selection: the cell under the focus (5, the space) is selected too.
      const changed1 = view.setLocalSelection(0, 0, 5, 0)
      expect(changed1).toBe(true)
      expect(view.getSelectedText()).toBe("Hello ")

      const changed2 = view.updateLocalSelection(0, 0, 11, 0)
      expect(changed2).toBe(true)
      expect(view.getSelectedText()).toBe("Hello World")
    })

    it("should update local selection across lines", () => {
      const styledText = stringToStyledText("Line 1\nLine 2\nLine 3")
      buffer.setStyledText(styledText)

      view.setLocalSelection(2, 0, 2, 0)

      const changed = view.updateLocalSelection(2, 0, 4, 1)
      expect(changed).toBe(true)

      const selectedText = view.getSelectedText()
      expect(selectedText).toContain("ne 1")
      expect(selectedText).toContain("Line")
    })

    it("should fallback to setLocalSelection when updateLocalSelection called with no existing anchor", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      const changed = view.updateLocalSelection(0, 0, 5, 0)
      expect(changed).toBe(true)
      expect(view.hasSelection()).toBe(true)
      expect(view.getSelectedText()).toBe("Hello ")
    })

    it("should preserve anchor when updating local selection", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      view.setLocalSelection(0, 0, 5, 0)
      expect(view.getSelectedText()).toBe("Hello ")

      view.updateLocalSelection(0, 0, 6, 0)
      expect(view.getSelectedText()).toBe("Hello W")

      view.updateLocalSelection(0, 0, 11, 0)
      expect(view.getSelectedText()).toBe("Hello World")

      view.updateLocalSelection(0, 0, 3, 0)
      expect(view.getSelectedText()).toBe("Hell")
    })

    it("should handle backward selection with updateLocalSelection", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      view.setLocalSelection(11, 0, 11, 0)

      const changed = view.updateLocalSelection(11, 0, 6, 0)
      expect(changed).toBe(true)
      expect(view.getSelectedText()).toBe("World")
    })

    it("should select a word with word behavior on the same cell", () => {
      const styledText = stringToStyledText("alpha beta gamma")
      buffer.setStyledText(styledText)

      const changed = view.setLocalSelection(6, 0, 6, 0, undefined, undefined, "word")
      expect(changed).toBe(true)
      expect(view.getSelectedText()).toBe("beta")
    })

    it("should keep a cell press zero-width", () => {
      const styledText = stringToStyledText("alpha beta")
      buffer.setStyledText(styledText)

      view.setLocalSelection(6, 0, 6, 0)
      expect(view.getSelectedText()).toBe("")
      expect(view.hasSelection()).toBe(false)
    })
  })

  describe("getPlainText", () => {
    it("should return empty string for empty buffer", () => {
      const emptyText = stringToStyledText("")
      buffer.setStyledText(emptyText)

      const plainText = view.getPlainText()
      expect(plainText).toBe("")
    })

    it("should return plain text without styling", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      const plainText = view.getPlainText()
      expect(plainText).toBe("Hello World")
    })

    it("should handle text with newlines", () => {
      const styledText = stringToStyledText("Line 1\nLine 2\nLine 3")
      buffer.setStyledText(styledText)

      const plainText = view.getPlainText()
      expect(plainText).toBe("Line 1\nLine 2\nLine 3")
    })
  })

  describe("undo/redo with line info", () => {
    it("should update lineInfo correctly after undo", () => {
      // This test verifies that marker cache is invalidated after undo
      const styledText = stringToStyledText("Line 1 content\nLine 2")
      buffer.setStyledText(styledText)

      const lineInfoBefore = view.lineInfo
      expect(lineInfoBefore.lineStartCols).toEqual([0, 15])
      expect(lineInfoBefore.lineWidthCols[0]).toBe(14)
      expect(lineInfoBefore.lineWidthCols[1]).toBe(6)

      // Modify the buffer (this would normally go through EditBuffer with undo tracking)
      // For this test, we'll just verify the view updates correctly
      const modifiedText = stringToStyledText("Line 1 \nLine 2")
      buffer.setStyledText(modifiedText)

      const lineInfoAfterModify = view.lineInfo
      expect(lineInfoAfterModify.lineStartCols).toEqual([0, 8])
      expect(lineInfoAfterModify.lineWidthCols[0]).toBe(7)

      // Restore original (simulating undo)
      buffer.setStyledText(styledText)

      const lineInfoAfterRestore = view.lineInfo
      expect(lineInfoAfterRestore.lineStartCols).toEqual([0, 15])
      expect(lineInfoAfterRestore.lineWidthCols[0]).toBe(14)
    })

    it("should handle line info correctly through multiple undo/redo cycles", () => {
      const text1 = stringToStyledText("Short\nLine 2")
      const text2 = stringToStyledText("This is a longer line\nLine 2")
      const text3 = stringToStyledText("X\nLine 2")

      buffer.setStyledText(text1)
      const info1 = view.lineInfo
      expect(info1.lineWidthCols[0]).toBe(5)

      buffer.setStyledText(text2)
      const info2 = view.lineInfo
      expect(info2.lineWidthCols[0]).toBe(21)

      buffer.setStyledText(text3)
      const info3 = view.lineInfo
      expect(info3.lineWidthCols[0]).toBe(1)

      // Go back to text2 (simulating undo)
      buffer.setStyledText(text2)
      const info2Again = view.lineInfo
      expect(info2Again.lineWidthCols[0]).toBe(21)

      // Go back to text1 (simulating another undo)
      buffer.setStyledText(text1)
      const info1Again = view.lineInfo
      expect(info1Again.lineWidthCols[0]).toBe(5)

      // Forward to text2 (simulating redo)
      buffer.setStyledText(text2)
      const info2Redo = view.lineInfo
      expect(info2Redo.lineWidthCols[0]).toBe(21)
    })

    it("should correctly track line starts after undo with multiline text", () => {
      const original = stringToStyledText("Line 1 content\nLine 2 content\nLine 3")
      const modified = stringToStyledText("Line 1 \nLine 2 content\nLine 3")

      buffer.setStyledText(original)
      const originalInfo = view.lineInfo
      expect(originalInfo.lineStartCols).toEqual([0, 15, 30])

      buffer.setStyledText(modified)
      const modifiedInfo = view.lineInfo
      expect(modifiedInfo.lineStartCols).toEqual([0, 8, 23])

      // Restore (undo)
      buffer.setStyledText(original)
      const restoredInfo = view.lineInfo
      expect(restoredInfo.lineStartCols).toEqual([0, 15, 30])
    })
  })

  describe("wrapped view offset stability", () => {
    it("should return line info for empty buffer", () => {
      const emptyText = stringToStyledText("")
      buffer.setStyledText(emptyText)

      const lineInfo = view.lineInfo
      expect(lineInfo.lineStartCols).toEqual([0])
      expect(lineInfo.lineWidthCols).toEqual([0])
    })

    it("should maintain stable char offsets with wide characters", () => {
      const text = "A世B界C" // A(1) 世(2) B(1) 界(2) C(1) = 7 total width
      const styledText = stringToStyledText(text)
      buffer.setStyledText(styledText)

      view.setWrapMode("char")
      view.setWrapWidth(4)

      const lineInfo = view.lineInfo
      // Should wrap at display width boundaries
      expect(lineInfo.lineStartCols[0]).toBe(0)
      expect(lineInfo.lineStartCols.length).toBeGreaterThan(1)

      // Each line should respect wrap width in display columns
      for (const width of lineInfo.lineWidthCols) {
        expect(width).toBeLessThanOrEqual(4)
      }
    })

    it("should maintain stable selection with wrapped wide characters", () => {
      const text = "世界世界世界" // 6 CJK characters = 12 display width
      const styledText = stringToStyledText(text)
      buffer.setStyledText(styledText)

      view.setWrapMode("char")
      view.setWrapWidth(6)

      // Select first 3 CJK characters (6 display width)
      view.setSelection(0, 6)
      const selected = view.getSelectedText()
      expect(selected).toBe("世界世")
    })

    it("should handle tabs correctly in wrapped view", () => {
      const text = "A\tB\tC"
      const styledText = stringToStyledText(text)
      buffer.setStyledText(styledText)

      view.setWrapMode("char")
      view.setWrapWidth(10)

      const lineInfo = view.lineInfo
      // Tabs expand to display width, offsets should account for this
      expect(lineInfo.lineStartCols.length).toBeGreaterThanOrEqual(1)
    })

    it("should handle emoji in wrapped view", () => {
      const text = "🌟🌟🌟🌟🌟" // 5 emoji = 10 display width (assuming 2 each)
      const styledText = stringToStyledText(text)
      buffer.setStyledText(styledText)

      view.setWrapMode("char")
      view.setWrapWidth(6)

      const lineInfo = view.lineInfo
      expect(lineInfo.lineStartCols.length).toBeGreaterThan(1)

      // Each wrapped line should respect display width limits
      for (const width of lineInfo.lineWidthCols) {
        expect(width).toBeLessThanOrEqual(6)
      }
    })

    it("should maintain selection across wrapped lines", () => {
      const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      const styledText = stringToStyledText(text)
      buffer.setStyledText(styledText)

      view.setWrapMode("char")
      view.setWrapWidth(10)

      // Select across wrap boundary: chars 8-12 (IJK)
      view.setSelection(8, 13)
      const selected = view.getSelectedText()
      expect(selected).toBe("IJKLM")
    })
  })

  describe("measureForDimensions", () => {
    it("preserves public result identity", () => {
      buffer.setStyledText(stringToStyledText("abcdefghij"))
      view.setWrapMode("char")
      const first = view.measureForDimensions(10, 10)!
      const second = view.measureForDimensions(5, 10)!
      const repeated = view.measureForDimensions(10, 1)!

      expect(first).not.toBe(second)
      expect(repeated).not.toBe(first)
      expect(repeated).toEqual(first)
      expect(first).toEqual({ lineCount: 1, widthColsMax: 10 })
      expect(second).toEqual({ lineCount: 2, widthColsMax: 5 })
    })

    it("should measure without modifying cache", () => {
      const styledText = stringToStyledText("ABCDEFGHIJKLMNOPQRST")
      buffer.setStyledText(styledText)

      view.setWrapMode("char")
      view.setWrapWidth(100) // Large width

      // Measure with different width
      const measureResult = view.measureForDimensions(10, 10)
      expect(measureResult).not.toBeNull()
      expect(measureResult!.lineCount).toBe(2)
      expect(measureResult!.widthColsMax).toBe(10)

      // Verify cache wasn't modified (should be 1 line with wrap width 100)
      const lineInfo = view.lineInfo
      expect(lineInfo.lineStartCols.length).toBe(1)
    })

    it("should measure char wrap correctly", () => {
      const styledText = stringToStyledText("ABCDEFGHIJKLMNOPQRST")
      buffer.setStyledText(styledText)

      view.setWrapMode("char")

      // Test different widths
      const result1 = view.measureForDimensions(10, 10)
      expect(result1).not.toBeNull()
      expect(result1!.lineCount).toBe(2)
      expect(result1!.widthColsMax).toBe(10)

      const result2 = view.measureForDimensions(5, 10)
      expect(result2).not.toBeNull()
      expect(result2!.lineCount).toBe(4)
      expect(result2!.widthColsMax).toBe(5)

      const result3 = view.measureForDimensions(20, 10)
      expect(result3).not.toBeNull()
      expect(result3!.lineCount).toBe(1)
      expect(result3!.widthColsMax).toBe(20)
    })

    it("should handle no wrap mode", () => {
      const styledText = stringToStyledText("Hello\nWorld\nTest")
      buffer.setStyledText(styledText)

      view.setWrapMode("none")

      const result = view.measureForDimensions(3, 10)
      expect(result).not.toBeNull()
      expect(result!.lineCount).toBe(3)
      expect(result!.widthColsMax).toBeGreaterThanOrEqual(4)
    })

    it("should handle word wrap", () => {
      const styledText = stringToStyledText("Hello wonderful world")
      buffer.setStyledText(styledText)

      view.setWrapMode("word")

      const result = view.measureForDimensions(10, 10)
      expect(result).not.toBeNull()
      expect(result!.lineCount).toBeGreaterThanOrEqual(2)
      expect(result!.widthColsMax).toBeLessThanOrEqual(10)
    })

    it("should handle empty buffer", () => {
      const styledText = stringToStyledText("")
      buffer.setStyledText(styledText)

      view.setWrapMode("char")

      const result = view.measureForDimensions(10, 10)
      expect(result).not.toBeNull()
      expect(result!.lineCount).toBe(1)
      expect(result!.widthColsMax).toBe(0)
    })

    it("should handle multiple lines with wrapping", () => {
      const styledText = stringToStyledText("Short\nAVeryLongLineHere\nMedium")
      buffer.setStyledText(styledText)

      view.setWrapMode("char")

      const result = view.measureForDimensions(10, 10)
      expect(result).not.toBeNull()
      // "Short" (1), "AVeryLongLineHere" (2), "Medium" (1) = 4 lines
      expect(result!.lineCount).toBe(4)
      expect(result!.widthColsMax).toBe(10)
    })

    it("should cache measure results for same width", () => {
      const styledText = stringToStyledText("ABCDEFGHIJKLMNOPQRST")
      buffer.setStyledText(styledText)

      view.setWrapMode("char")

      // First call - cache miss
      const result1 = view.measureForDimensions(10, 10)
      expect(result1).not.toBeNull()
      expect(result1!.lineCount).toBe(2)

      // Second call with same width - should return cached result
      const result2 = view.measureForDimensions(10, 10)
      expect(result2).not.toBeNull()
      expect(result2!.lineCount).toBe(2)
      expect(result2!.widthColsMax).toBe(result1!.widthColsMax)
    })

    it("should invalidate cache when content changes", () => {
      const styledText1 = stringToStyledText("ABCDEFGHIJ")
      buffer.setStyledText(styledText1)

      view.setWrapMode("char")

      // Measure with width 5 - should be 2 lines
      const result1 = view.measureForDimensions(5, 10)
      expect(result1!.lineCount).toBe(2)

      // Change content to be longer
      const styledText2 = stringToStyledText("ABCDEFGHIJKLMNOPQRST")
      buffer.setStyledText(styledText2)

      // Same width should now return different result
      const result2 = view.measureForDimensions(5, 10)
      expect(result2!.lineCount).toBe(4)
    })

    it("should invalidate cache when wrap mode changes", () => {
      const styledText = stringToStyledText("Hello world test string here")
      buffer.setStyledText(styledText)

      view.setWrapMode("word")
      const resultWord = view.measureForDimensions(10, 10)

      view.setWrapMode("char")
      const resultChar = view.measureForDimensions(10, 10)

      // Word and char wrap should produce different results
      expect(resultWord!.lineCount).not.toBe(resultChar!.lineCount)
    })

    it("should handle width 0 for intrinsic measurement", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      view.setWrapMode("word")

      // Width 0 means get intrinsic width (no wrapping)
      const result = view.measureForDimensions(0, 10)
      expect(result).not.toBeNull()
      expect(result!.lineCount).toBe(1)
      expect(result!.widthColsMax).toBe(11) // "Hello World" = 11 chars
    })
  })
})
