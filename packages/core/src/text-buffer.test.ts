import { ResourceContext } from "./buffer.js"
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TextBuffer } from "./text-buffer.js"
import { EditBuffer } from "./edit-buffer.js"
import { resolveRenderLib } from "./zig.js"
import { StyledText, stringToStyledText } from "./lib/styled-text.js"
import { RGBA } from "./lib/RGBA.js"
import { SyntaxStyle } from "./syntax-style.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 8, renderCellsMax: 1 })
})
afterEach(() => resourceContext.destroy())

const MALFORMED_UTF8_ABOVE_UNICODE_RANGE = new Uint8Array([0x41, 0xf4, 0x90, 0x80, 0x80, 0x42])

type Operation = ["setText" | "setStyledText" | "append", string] | ["clear" | "reset"]

describe("TextBuffer", () => {
  let buffer: TextBuffer

  beforeEach(() => {
    buffer = TextBuffer.create("wcwidth", resourceContext)
  })

  afterEach(() => {
    buffer.destroy()
  })

  // Each row starts from an empty buffer. Expected: plain text, length in display cells without newlines, UTF-8
  // byte size, and line count.
  it.each<[string, Operation[], [string, number, number, number]]>([
    ["no operation", [], ["", 0, 0, 1]],
    ["setText", [["setText", "Hello World"]], ["Hello World", 11, 11, 1]],
    ["setText with newlines", [["setText", "Line 1\nLine 2\nLine 3"]], ["Line 1\nLine 2\nLine 3", 18, 20, 3]],
    [
      "setText to empty",
      [
        ["setText", "Hello World"],
        ["setText", ""],
      ],
      ["", 0, 0, 1],
    ],
    ["empty styled text", [["setStyledText", ""]], ["", 0, 0, 1]],
    ["styled CJK and emoji", [["setStyledText", "Hello 世界 🌟"]], ["Hello 世界 🌟", 13, 17, 1]],
    [
      "styled text replaces",
      [
        ["setStyledText", "First"],
        ["setStyledText", "Second"],
      ],
      ["Second", 6, 6, 1],
    ],
    [
      "combining mark and ZWJ emoji (wcwidth splits the ZWJ sequence)",
      [["setText", "e\u0301👩\u200d💻"]],
      ["e\u0301👩\u200d💻", 5, 14, 1],
    ],
    ["tab (default width 2)", [["setText", "a\tb"]], ["a\tb", 4, 3, 1]],
    ["clear", [["setText", "Initial"], ["clear"]], ["", 0, 0, 1]],
    ["clear then setText", [["setText", "Initial"], ["clear"], ["setText", "After clear"]], ["After clear", 11, 11, 1]],
    ["reset then setText", [["setText", "Initial"], ["reset"], ["setText", "New text"]], ["New text", 8, 8, 1]],
    ["append to empty", [["append", "Hello"]], ["Hello", 5, 5, 1]],
    ["append empty", [["append", ""]], ["", 0, 0, 1]],
    [
      "append empty to text",
      [
        ["setText", "Hello"],
        ["append", ""],
      ],
      ["Hello", 5, 5, 1],
    ],
    [
      "append unicode",
      [
        ["setText", "Hello "],
        ["append", "世界 🌟"],
      ],
      ["Hello 世界 🌟", 13, 17, 1],
    ],
    [
      "streaming appends",
      [
        ["append", "First"],
        ["append", "\nLine2"],
        ["append", "\n"],
        ["append", "Line3"],
        ["append", " end"],
      ],
      ["First\nLine2\nLine3 end", 19, 21, 3],
    ],
    [
      "CRLF appends become LF",
      [
        ["append", "Line1\r\n"],
        ["append", "Line2\r\n"],
        ["append", "Line3"],
      ],
      ["Line1\nLine2\nLine3", 15, 17, 3],
    ],
    ["append after clear", [["setText", "Initial"], ["clear"], ["append", "After clear"]], ["After clear", 11, 11, 1]],
    ["append after reset", [["setText", "Initial"], ["reset"], ["append", "After reset"]], ["After reset", 11, 11, 1]],
    [
      "setText resets appends",
      [
        ["setText", "First"],
        ["append", " appended"],
        ["setText", "Reset"],
        ["append", " again"],
      ],
      ["Reset again", 11, 11, 1],
    ],
  ])("content: %s", (_name, operations, expected) => {
    for (const [operation, value = ""] of operations) {
      if (operation === "clear" || operation === "reset") buffer[operation]()
      else if (operation === "setStyledText") buffer.setStyledText(stringToStyledText(value))
      else buffer[operation](value)
    }
    // Native must have copied the encoded input.
    if (typeof Bun !== "undefined") Bun.gc(true)
    expect([buffer.getPlainText(), buffer.length, buffer.byteSize, buffer.getLineCount()]).toEqual(expected)
    // The cached lengths match native after every kind of mutation.
    const info = resolveRenderLib().contextTextBufferGetInfo(
      resourceContext.context,
      buffer._getSceneHandle(resourceContext),
    )
    expect([info.textLength, info.byteLength]).toEqual([buffer.length, buffer.byteSize])
  })

  it("accepts styled text after the attached style is destroyed", () => {
    const style = SyntaxStyle.create(resourceContext)
    buffer.setSyntaxStyle(style)
    style.destroy()
    buffer.setStyledText(stringToStyledText("after"))
    expect(buffer.getPlainText()).toBe("after")
  })

  it("clamps tab width 255 to the largest representable even width", () => {
    buffer.setText("a\tb")
    buffer.setTabWidth(255)

    expect(buffer.getTabWidth()).toBe(254)
    expect(buffer.length).toBe(256)
  })

  it("returns ranges that remain unchanged after replacement", () => {
    buffer.setText("Hello World")
    const first = buffer.getTextRange(0, 5)
    buffer.setText("Other World")
    expect(first).toBe("Hello")
    expect(buffer.getTextRange(0, 5)).toBe("Other")
    expect(buffer.getTextRange(3, 3)).toBe("")
  })

  it("accepts default style changes", () => {
    buffer.setDefaultFg(RGBA.fromValues(1, 0, 0, 1))
    buffer.setDefaultBg(RGBA.fromValues(0, 0, 1, 1))
    buffer.setDefaultAttributes(1)
    buffer.resetDefaults()
  })

  describe("highlights", () => {
    it("adds, reads, and removes highlights by line, character range, and reference", () => {
      const style = SyntaxStyle.create(resourceContext)
      try {
        const styleId = style.registerStyle("highlight", { fg: RGBA.fromValues(1, 0, 0, 1) })
        buffer.setSyntaxStyle(style)
        expect(buffer.getSyntaxStyle()).toBe(style)
        buffer.setText("ab\n世c")
        expect([buffer.getLineHighlights(0), buffer.getLineHighlights(1)]).toEqual([[], []])

        buffer.addHighlight(0, { start: 0, end: 2, styleId, priority: 7, hlRef: 42 })
        expect(buffer.getLineHighlights(0)).toEqual([{ start: 0, end: 2, styleId, priority: 7, hlRef: 42 }])
        // Character offsets count display cells and skip newlines, so 1..4 spans "b" and "世".
        buffer.addHighlightByCharRange({ start: 1, end: 4, styleId, priority: 1, hlRef: 7 })
        expect(buffer.getHighlightCount()).toBe(3)
        expect(buffer.getLineHighlights(1)).toEqual([{ start: 0, end: 2, styleId, priority: 1, hlRef: 7 }])

        buffer.removeHighlightsByRef(7)
        expect([buffer.getHighlightCount(), buffer.getLineHighlights(1)]).toEqual([1, []])
        buffer.addHighlight(1, { start: 0, end: 1, styleId })
        buffer.clearLineHighlights(0)
        expect([buffer.getLineHighlights(0), buffer.getHighlightCount()]).toEqual([[], 1])
        buffer.clearAllHighlights()
        expect(buffer.getHighlightCount()).toBe(0)
      } finally {
        buffer.setSyntaxStyle(null)
        style.destroy()
      }
      expect(buffer.getSyntaxStyle()).toBeNull()
    })

    // Replacement drops styled chunk highlights (line -1: the old text is styled) and keeps user highlights
    // only on lines that still exist. Expected: the hlRefs left on lines 0 and 1.
    it.each<[string, string, number, string, number[]]>([
      ["TextBuffer.setText", "Styled", -1, "Plain", []],
      ["TextBuffer.setText", "Hello World", 0, "New Text", [65535]],
      ["TextBuffer.setText", "first\nsecond", 1, "xyz", []],
      ["EditBuffer.setText", "first\nsecond", 1, "xyz", []],
      ["EditBuffer.replaceText", "first\nsecond", 1, "xyz", []],
      ["EditBuffer.replaceText", "a\nb\nc", 1, "x\ny", [65535]],
    ])("%s from %j with a highlight on line %d to %j keeps %j", (operation, before, line, after, expected) => {
      const syntaxStyle = SyntaxStyle.create(resourceContext)
      const fg = RGBA.fromValues(0, 1, 0, 1)
      const target = operation === "TextBuffer.setText" ? buffer : EditBuffer.create("wcwidth", resourceContext)
      target.setSyntaxStyle(syntaxStyle)
      if (line < 0) buffer.setStyledText(new StyledText([{ __isChunk: true, text: before, fg }]))
      else target.setText(before)
      const styleId = syntaxStyle.registerStyle("user-highlight", { fg })
      if (line >= 0) target.addHighlight(line, { start: 0, end: 1, styleId, priority: 0, hlRef: 65535 })
      expect([0, 1].flatMap((i) => target.getLineHighlights(i)).length).toBe(1)

      if (operation === "EditBuffer.replaceText") (target as EditBuffer).replaceText(after)
      else target.setText(after)

      expect([0, 1].flatMap((i) => target.getLineHighlights(i).map((hl) => hl.hlRef))).toEqual(expected)
      if (target === buffer) expect(buffer.getHighlightCount()).toBe(expected.length)
      if (target !== buffer) target.destroy()
      syntaxStyle.destroy()
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

  it("should handle more streaming appends than the native chunk registry holds", () => {
    let expected = ""
    for (let i = 0; i < 1000; i++) {
      buffer.append(`Line ${i}\n`)
      expected += `Line ${i}\n`
    }
    expect(buffer.getPlainText()).toBe(expected)
    expect(buffer.byteSize).toBe(expected.length)
    // Newlines take no cells.
    expect(buffer.length).toBe(expected.length - 1000)
    expect(buffer.getLineCount()).toBe(1001)
  })
})
