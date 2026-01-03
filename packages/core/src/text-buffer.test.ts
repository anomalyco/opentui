import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { TextBuffer } from "./text-buffer"
import { StyledText, stringToStyledText } from "./lib/styled-text"
import { RGBA } from "./lib/RGBA"
import { SyntaxStyle } from "./syntax-style"

describe("TextBuffer", () => {
  let buffer: TextBuffer

  beforeEach(() => {
    buffer = TextBuffer.create("wcwidth")
  })

  afterEach(() => {
    buffer.destroy()
  })

  describe("setText and setStyledText", () => {
    it("should set text content", () => {
      const text = "Hello World"
      buffer.setText(text)

      expect(buffer.length).toBe(11)
      expect(buffer.byteSize).toBeGreaterThan(0)
    })

    it("should set styled text", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      expect(buffer.length).toBe(11)
    })

    it("should handle empty text", () => {
      const emptyText = stringToStyledText("")
      buffer.setStyledText(emptyText)

      expect(buffer.length).toBe(0)
    })

    it("should handle text with newlines", () => {
      const text = "Line 1\nLine 2\nLine 3"
      buffer.setText(text)

      expect(buffer.length).toBe(18) // 6 + 6 + 6 chars (newlines not counted)
    })

    it("reuses syntax style ids for identical chunk styles", () => {
      const syntaxStyle = SyntaxStyle.create()
      buffer.setSyntaxStyle(syntaxStyle)

      const fgA = RGBA.fromInts(120, 120, 120, 255)
      const fgB = RGBA.fromInts(200, 200, 200, 255)
      const bgA = RGBA.fromInts(10, 10, 10, 255)
      const bgB = RGBA.fromInts(20, 20, 20, 255)

      const baseChunks = [
        { __isChunk: true, text: "A", fg: fgA, bg: bgA, attributes: 0 },
        { __isChunk: true, text: "B", fg: fgB, bg: bgB, attributes: 0 },
      ]
      buffer.setStyledText(new StyledText(baseChunks))
      const baseCount = syntaxStyle.getStyleCount()

      const chunks = Array.from({ length: 200 }, (_, index) => {
        const useA = index % 2 === 0
        return {
          __isChunk: true,
          text: useA ? "A" : "B",
          fg: useA ? fgA : fgB,
          bg: useA ? bgA : bgB,
          attributes: 0,
        }
      })

      buffer.setStyledText(new StyledText(chunks))
      const finalCount = syntaxStyle.getStyleCount()

      expect(finalCount).toBe(baseCount)

      buffer.setSyntaxStyle(null)
      syntaxStyle.destroy()
    })
  })

  describe("getPlainText", () => {
    it("should return empty string for empty buffer", () => {
      const emptyText = stringToStyledText("")
      buffer.setStyledText(emptyText)

      const plainText = buffer.getPlainText()
      expect(plainText).toBe("")
    })

    it("should return plain text without styling", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      const plainText = buffer.getPlainText()
      expect(plainText).toBe("Hello World")
    })

    it("should handle text with newlines", () => {
      const styledText = stringToStyledText("Line 1\nLine 2\nLine 3")
      buffer.setStyledText(styledText)

      const plainText = buffer.getPlainText()
      expect(plainText).toBe("Line 1\nLine 2\nLine 3")
    })

    it("should handle Unicode characters correctly", () => {
      const styledText = stringToStyledText("Hello 世界 🌟")
      buffer.setStyledText(styledText)

      const plainText = buffer.getPlainText()
      expect(plainText).toBe("Hello 世界 🌟")
    })

    it("should handle styled text with colors and attributes", () => {
      const redChunk = {
        __isChunk: true as const,
        text: "Red",
        fg: RGBA.fromValues(1, 0, 0, 1),
      }
      const newlineChunk = {
        __isChunk: true as const,
        text: "\n",
      }
      const blueChunk = {
        __isChunk: true as const,
        text: "Blue",
        fg: RGBA.fromValues(0, 0, 1, 1),
      }

      const styledText = new StyledText([redChunk, newlineChunk, blueChunk])
      buffer.setStyledText(styledText)

      const plainText = buffer.getPlainText()
      expect(plainText).toBe("Red\nBlue")
    })
  })

  describe("length property", () => {
    it("should return correct length for simple text", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      expect(buffer.length).toBe(11)
    })

    it("should return 0 for empty buffer", () => {
      const emptyText = stringToStyledText("")
      buffer.setStyledText(emptyText)

      expect(buffer.length).toBe(0)
    })

    it("should handle text with newlines correctly", () => {
      const styledText = stringToStyledText("Line 1\nLine 2\nLine 3")
      buffer.setStyledText(styledText)

      expect(buffer.length).toBe(18) // 6 + 6 + 6 chars (newlines not counted)
    })

    it("should handle Unicode characters correctly", () => {
      const styledText = stringToStyledText("Hello 世界 🌟")
      buffer.setStyledText(styledText)

      expect(buffer.length).toBe(13)
    })
  })

  describe("default styles", () => {
    it("should set and reset default foreground color", () => {
      const fg = RGBA.fromValues(1, 0, 0, 1)
      buffer.setDefaultFg(fg)
      buffer.resetDefaults()

      // No error should be thrown
      expect(true).toBe(true)
    })

    it("should set and reset default background color", () => {
      const bg = RGBA.fromValues(0, 0, 1, 1)
      buffer.setDefaultBg(bg)
      buffer.resetDefaults()

      // No error should be thrown
      expect(true).toBe(true)
    })

    it("should set and reset default attributes", () => {
      buffer.setDefaultAttributes(1)
      buffer.resetDefaults()

      // No error should be thrown
      expect(true).toBe(true)
    })
  })

  describe("clear() vs reset()", () => {
    it("clear() should empty buffer but preserve text across setText calls", () => {
      // Set initial text
      buffer.setText("First text")
      expect(buffer.length).toBe(10)

      // Set new text (which calls clear() internally)
      buffer.setText("Second text")
      expect(buffer.length).toBe(11)
      expect(buffer.getPlainText()).toBe("Second text")

      // Explicit clear
      buffer.clear()
      expect(buffer.length).toBe(0)
      expect(buffer.getPlainText()).toBe("")
    })

    it("reset() should fully reset the buffer", () => {
      buffer.setText("Some text")
      expect(buffer.length).toBe(9)

      buffer.reset()
      expect(buffer.length).toBe(0)
      expect(buffer.getPlainText()).toBe("")

      // Should be able to use buffer after reset
      buffer.setText("New text")
      expect(buffer.length).toBe(8)
    })

    it("setText should preserve highlights (use clear() not reset())", () => {
      // This test verifies that setText now uses clear() internally
      // and doesn't clear highlights
      buffer.setText("Hello World")

      // Note: We can't easily test highlight preservation from TypeScript
      // without a SyntaxStyle, but we verify the buffer still works
      expect(buffer.length).toBe(11)

      buffer.setText("New Text")
      expect(buffer.length).toBe(8)
      expect(buffer.getPlainText()).toBe("New Text")
    })

    it("setStyledText should preserve content across calls", () => {
      const firstText = stringToStyledText("First")
      buffer.setStyledText(firstText)
      expect(buffer.length).toBe(5)

      const secondText = stringToStyledText("Second")
      buffer.setStyledText(secondText)
      expect(buffer.length).toBe(6)
      expect(buffer.getPlainText()).toBe("Second")
    })

    it("multiple setText calls should work correctly with clear()", () => {
      buffer.setText("Text 1")
      expect(buffer.length).toBe(6)

      buffer.setText("Text 2")
      expect(buffer.length).toBe(6)

      buffer.setText("Text 3")
      expect(buffer.length).toBe(6)

      expect(buffer.getPlainText()).toBe("Text 3")
    })

    it("clear() followed by setText should work", () => {
      buffer.setText("Initial")
      expect(buffer.length).toBe(7)

      buffer.clear()
      expect(buffer.length).toBe(0)

      buffer.setText("After clear")
      expect(buffer.length).toBe(11)
      expect(buffer.getPlainText()).toBe("After clear")
    })

    it("reset() followed by setText should work", () => {
      buffer.setText("Initial")
      expect(buffer.length).toBe(7)

      buffer.reset()
      expect(buffer.length).toBe(0)

      buffer.setText("After reset")
      expect(buffer.length).toBe(11)
      expect(buffer.getPlainText()).toBe("After reset")
    })
  })

  describe("append()", () => {
    it("should append text to empty buffer", () => {
      buffer.append("Hello")
      expect(buffer.length).toBe(5)
      expect(buffer.getPlainText()).toBe("Hello")
    })

    it("should append text to existing content", () => {
      buffer.setText("Hello")
      buffer.append(" World")
      expect(buffer.length).toBe(11)
      expect(buffer.getPlainText()).toBe("Hello World")
    })

    it("should append text with newlines", () => {
      buffer.setText("Line 1")
      buffer.append("\nLine 2")
      expect(buffer.getPlainText()).toBe("Line 1\nLine 2")
    })

    it("should append multiple times", () => {
      buffer.setText("Start")
      buffer.append(" middle")
      buffer.append(" end")
      expect(buffer.getPlainText()).toBe("Start middle end")
    })

    it("should handle appending empty string", () => {
      buffer.setText("Hello")
      const lengthBefore = buffer.length
      buffer.append("")
      expect(buffer.length).toBe(lengthBefore)
      expect(buffer.getPlainText()).toBe("Hello")
    })

    it("should append unicode content", () => {
      buffer.setText("Hello ")
      buffer.append("世界 🌟")
      expect(buffer.getPlainText()).toBe("Hello 世界 🌟")
    })

    it("should handle streaming chunks", () => {
      buffer.append("First")
      buffer.append("\nLine2")
      buffer.append("\n")
      buffer.append("Line3")
      buffer.append(" end")
      expect(buffer.getPlainText()).toBe("First\nLine2\nLine3 end")
    })

    it("should handle CRLF line endings in append", () => {
      buffer.append("Line1\r\n")
      buffer.append("Line2\r\n")
      buffer.append("Line3")
      // CRLF should be normalized to LF
      expect(buffer.getPlainText()).toBe("Line1\nLine2\nLine3")
    })

    it("should work with clear and append", () => {
      buffer.setText("Initial")
      buffer.clear()
      buffer.append("After clear")
      expect(buffer.getPlainText()).toBe("After clear")
    })

    it("should work with reset and append", () => {
      buffer.setText("Initial")
      buffer.reset()
      buffer.append("After reset")
      expect(buffer.getPlainText()).toBe("After reset")
    })

    it("should handle large streaming append", () => {
      for (let i = 0; i < 100; i++) {
        buffer.append(`Line ${i}\n`)
      }
      const result = buffer.getPlainText()
      expect(result).toContain("Line 0")
      expect(result).toContain("Line 99")
    })

    it("should mix setText and append", () => {
      buffer.setText("First")
      buffer.append(" appended")
      expect(buffer.getPlainText()).toBe("First appended")

      buffer.setText("Reset")
      buffer.append(" again")
      expect(buffer.getPlainText()).toBe("Reset again")
    })
  })
})
