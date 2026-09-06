import { ResourceContext } from "./buffer.js"
import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TextBuffer } from "./text-buffer.js"
import { NativeStatus, resolveRenderLib } from "./zig.js"
import { StyledText, stringToStyledText } from "./lib/styled-text.js"
import { RGBA } from "./lib/RGBA.js"
import { SyntaxStyle } from "./syntax-style.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 8, renderCellsMax: 1 })
})
afterEach(() => resourceContext.destroy())

const MALFORMED_UTF8_ABOVE_UNICODE_RANGE = new Uint8Array([0x41, 0xf4, 0x90, 0x80, 0x80, 0x42])

it.each(["setText", "append"] as const)("%s publishes only accepted mutations before deferred errors", (method) => {
  const buffer = TextBuffer.create("unicode", resourceContext)
  const lib = resourceContext.renderLib
  const operation = method === "setText" ? "contextTextBufferSetText" : "contextTextBufferAppend"
  const original = lib[operation].bind(lib)
  const failure = new Error("rejected text mutation")
  buffer.setText("old")
  const rejected = spyOn(lib, operation).mockImplementation(() => {
    throw failure
  })
  try {
    expect(() => buffer[method]("new")).toThrow(failure)
    expect(buffer.getPlainText()).toBe("old")
    expect(buffer.length).toBe(3)
    rejected.mockImplementation((...args) => {
      original(...args)
      lib.getYogaHost().invokeCallback(() => {
        throw failure
      })
    })
    expect(() => buffer[method]("new")).toThrow(failure)
    expect(buffer.getPlainText()).toBe(method === "setText" ? "new" : "oldnew")
    expect(buffer.length).toBe(method === "setText" ? 3 : 6)
  } finally {
    rejected.mockRestore()
    buffer.destroy()
  }
})

describe("TextBuffer", () => {
  let buffer: TextBuffer

  beforeEach(() => {
    buffer = TextBuffer.create("wcwidth", resourceContext)
  })

  afterEach(() => {
    buffer.destroy()
  })

  describe("setText and setStyledText", () => {
    it("should set text content", () => {
      const text = "Hello World"
      buffer.setText(text)
      if (typeof Bun !== "undefined") Bun.gc(true)

      expect(buffer.getPlainText()).toBe(text)
      expect(buffer.length).toBe(11)
      expect(buffer.byteSize).toBeGreaterThan(0)
    })

    it("should set styled text", () => {
      const styledText = stringToStyledText("Hello World")
      buffer.setStyledText(styledText)

      expect(buffer.length).toBe(11)
    })

    it("should handle empty text", () => {
      buffer.setText("")

      expect(buffer.length).toBe(0)
      expect(buffer.getPlainText()).toBe("")
    })

    it("should replace existing text with empty text", () => {
      buffer.setText("Hello World")
      buffer.setText("")

      expect(buffer.length).toBe(0)
      expect(buffer.getPlainText()).toBe("")
    })

    it("should handle empty styled text", () => {
      const emptyText = stringToStyledText("")
      buffer.setStyledText(emptyText)

      expect(buffer.length).toBe(0)
    })

    it("should handle text with newlines", () => {
      const text = "Line 1\nLine 2\nLine 3"
      buffer.setText(text)

      expect(buffer.length).toBe(18) // 6 + 6 + 6 chars (newlines not counted)
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

  describe("tab width", () => {
    it("clamps 255 to the largest representable even width", () => {
      buffer.setText("a\tb")
      buffer.setTabWidth(255)

      expect(buffer.getTabWidth()).toBe(254)
      expect(buffer.length).toBe(256)
    })
  })

  describe("getTextRange", () => {
    it("returns ranges that remain unchanged after replacement", () => {
      buffer.setText("Hello World")
      const first = buffer.getTextRange(0, 5)
      buffer.setText("Other World")
      expect(first).toBe("Hello")
      expect(buffer.getTextRange(0, 5)).toBe("Other")
    })
  })

  describe("line highlights", () => {
    it("should return an empty list when a line has no highlights", () => {
      buffer.setText("Hello\nWorld")

      expect(buffer.getLineHighlights(0)).toEqual([])
      expect(buffer.getLineHighlights(1)).toEqual([])
    })

    it("should round-trip line highlights through the native highlight buffer", () => {
      const style = SyntaxStyle.create(resourceContext)

      try {
        const styleId = style.registerStyle("highlight", {
          fg: RGBA.fromValues(1, 0, 0, 1),
        })

        buffer.setSyntaxStyle(style)
        buffer.setText("Hello World")
        buffer.addHighlight(0, { start: 0, end: 5, styleId, priority: 7, hlRef: 42 })

        expect(buffer.getLineHighlights(0)).toEqual([{ start: 0, end: 5, styleId, priority: 7, hlRef: 42 }])
      } finally {
        style.destroy()
      }
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
    it("reset rejection crosses the native status boundary", () => {
      const handle = buffer._getSceneHandle(resourceContext)
      buffer.destroy()
      expect(() => resolveRenderLib().contextTextBufferClear(resourceContext.context, handle, true)).toThrow(
        "StaleHandle",
      )
    })

    it("clear() should empty buffer but preserve text across setText calls", () => {
      // Set initial text
      buffer.setText("First text")
      expect(buffer.length).toBe(10)

      // Set new text
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

    it("setText should clear styled text chunk highlights", () => {
      const syntaxStyle = SyntaxStyle.create(resourceContext)
      buffer.setSyntaxStyle(syntaxStyle)
      buffer.setStyledText(
        new StyledText([
          {
            __isChunk: true,
            text: "Styled",
            fg: RGBA.fromValues(1, 0, 0, 1),
          },
        ]),
      )

      expect(buffer.getHighlightCount()).toBe(1)

      buffer.setText("Plain")

      expect(buffer.getPlainText()).toBe("Plain")
      expect(buffer.getHighlightCount()).toBe(0)

      syntaxStyle.destroy()
    })

    it("setText should preserve user highlights including max hlRef", () => {
      const syntaxStyle = SyntaxStyle.create(resourceContext)
      const styleId = syntaxStyle.registerStyle("user-highlight", { fg: RGBA.fromValues(0, 1, 0, 1) })
      buffer.setSyntaxStyle(syntaxStyle)
      buffer.setText("Hello World")
      buffer.addHighlight(0, { start: 0, end: 5, styleId, priority: 0, hlRef: 65535 })

      expect(buffer.getHighlightCount()).toBe(1)

      buffer.setText("New Text")

      expect(buffer.getPlainText()).toBe("New Text")
      expect(buffer.getHighlightCount()).toBe(1)
      expect(buffer.getLineHighlights(0)[0]?.hlRef).toBe(65535)

      syntaxStyle.destroy()
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

  describe("malformed UTF-8 bytes", () => {
    it.each(["contextTextBufferSetText", "contextTextBufferAppend"] as const)(
      "%s rejects malformed UTF-8 bytes without changing text",
      (operation) => {
        const lib = resolveRenderLib()
        const unicodeBuffer = TextBuffer.create("unicode", resourceContext)

        try {
          unicodeBuffer.setText("kept")
          expect(() =>
            lib[operation](
              resourceContext.context,
              unicodeBuffer._getSceneHandle(resourceContext),
              MALFORMED_UTF8_ABOVE_UNICODE_RANGE,
            ),
          ).toThrow("InvalidArgument")
          expect(unicodeBuffer.byteSize).toBe(4)
          expect(unicodeBuffer.length).toBe(4)
          expect(unicodeBuffer.getLineCount()).toBe(1)
          expect(unicodeBuffer.getPlainText()).toBe("kept")
        } finally {
          unicodeBuffer.destroy()
        }
      },
    )

    it("loadFile rejects malformed UTF-8 bytes without changing text", () => {
      const dir = mkdtempSync(join(process.env.OTUI_TEXT_BUFFER_TEST_TMPDIR ?? tmpdir(), "opentui-text-buffer-"))
      const path = join(dir, "malformed.txt")
      const unicodeBuffer = TextBuffer.create("unicode", resourceContext)

      try {
        writeFileSync(path, MALFORMED_UTF8_ABOVE_UNICODE_RANGE)

        unicodeBuffer.setText("kept")
        expect(() => unicodeBuffer.loadFile(path)).toThrow("InvalidArgument")
        expect(unicodeBuffer.byteSize).toBe(4)
        expect(unicodeBuffer.length).toBe(4)
        expect(unicodeBuffer.getLineCount()).toBe(1)
        expect(unicodeBuffer.getPlainText()).toBe("kept")
      } finally {
        unicodeBuffer.destroy()
        rmSync(dir, { recursive: true, force: true })
      }
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

    it("should append empty string to an empty buffer", () => {
      buffer.append("")

      expect(buffer.length).toBe(0)
      expect(buffer.getPlainText()).toBe("")
    })

    it("should append unicode content", () => {
      buffer.setText("Hello ")
      buffer.append("世界 🌟")
      if (typeof Bun !== "undefined") Bun.gc(true)
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
