import { describe, expect, it, afterEach } from "bun:test"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { createTestRenderer, type TestRenderer, type MockInput } from "../testing/test-renderer.js"
import { type ExtmarksController } from "./extmarks.js"
import { SyntaxStyle } from "../syntax-style.js"
import { RGBA } from "./RGBA.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput
let textarea: TextareaRenderable
let extmarks: ExtmarksController

async function setup(initialValue: string = "Hello World") {
  const result = await createTestRenderer({ width: 80, height: 24 })
  currentRenderer = result.renderer
  renderOnce = result.renderOnce
  currentMockInput = result.mockInput

  textarea = new TextareaRenderable(currentRenderer, {
    left: 0,
    top: 0,
    width: 40,
    height: 10,
    initialValue,
  })

  currentRenderer.root.add(textarea)
  await renderOnce()

  extmarks = textarea.extmarks

  return { textarea, extmarks }
}

describe("ExtmarksController", () => {
  afterEach(() => {
    if (extmarks) extmarks.destroy()
    if (currentRenderer) currentRenderer.destroy()
  })

  describe("Creation and Basic Operations", () => {
    it("should create extmark with basic options", async () => {
      await setup()

      const id = extmarks.create({
        start: 0,
        end: 5,
      })

      expect(id).toBe(1)
      const extmark = extmarks.get(id)
      expect(extmark).not.toBeNull()
      expect(extmark?.start).toBe(0)
      expect(extmark?.end).toBe(5)
      expect(extmark?.virtual).toBe(false)
    })

    it("should create virtual extmark", async () => {
      await setup()

      const id = extmarks.create({
        start: 6,
        end: 11,
        virtual: true,
      })

      const extmark = extmarks.get(id)
      expect(extmark?.virtual).toBe(true)
    })

    it("should create multiple extmarks with unique IDs", async () => {
      await setup()

      const id1 = extmarks.create({ start: 0, end: 5 })
      const id2 = extmarks.create({ start: 6, end: 11 })

      expect(id1).toBe(1)
      expect(id2).toBe(2)
      expect(extmarks.getAll().length).toBe(2)
    })

    it("should store custom data with extmark", async () => {
      await setup()

      const id = extmarks.create({
        start: 0,
        end: 5,
        data: { type: "link", url: "https://example.com" },
      })

      const extmark = extmarks.get(id)
      expect(extmark?.data).toEqual({ type: "link", url: "https://example.com" })
    })
  })

  describe("Delete Operations", () => {
    it("should delete extmark", async () => {
      await setup()

      const id = extmarks.create({ start: 0, end: 5 })
      const result = extmarks.delete(id)

      expect(result).toBe(true)
      expect(extmarks.get(id)).toBeNull()
    })

    it("should return false when deleting non-existent extmark", async () => {
      await setup()

      const result = extmarks.delete(999)
      expect(result).toBe(false)
    })

    it("should delete extmark without emitting events", async () => {
      await setup()

      const id = extmarks.create({ start: 0, end: 5 })
      extmarks.delete(id)
      expect(extmarks.get(id)).toBeNull()
    })

    it("should clear all extmarks", async () => {
      await setup()

      extmarks.create({ start: 0, end: 5 })
      extmarks.create({ start: 6, end: 11 })

      expect(extmarks.getAll().length).toBe(2)

      extmarks.clear()

      expect(extmarks.getAll().length).toBe(0)
    })
  })

  describe("Query Operations", () => {
    it("should get all extmarks", async () => {
      await setup()

      extmarks.create({ start: 0, end: 5 })
      extmarks.create({ start: 6, end: 11 })

      const all = extmarks.getAll()
      expect(all.length).toBe(2)
    })

    it("should get only virtual extmarks", async () => {
      await setup()

      extmarks.create({ start: 0, end: 5, virtual: false })
      extmarks.create({ start: 6, end: 11, virtual: true })
      extmarks.create({ start: 12, end: 15, virtual: true })

      const virtual = extmarks.getVirtual()
      expect(virtual.length).toBe(2)
      expect(virtual.every((e) => e.virtual)).toBe(true)
    })

    it("should get extmarks at specific offset", async () => {
      await setup()

      extmarks.create({ start: 0, end: 5 })
      extmarks.create({ start: 3, end: 8 })
      extmarks.create({ start: 10, end: 15 })

      const atOffset4 = extmarks.getAtOffset(4)
      expect(atOffset4.length).toBe(2)

      const atOffset10 = extmarks.getAtOffset(10)
      expect(atOffset10.length).toBe(1)
    })
  })

  describe("Virtual Extmark - Cursor Jumping Right", () => {
    it("should jump cursor over virtual extmark when moving right", async () => {
      await setup("abcdefgh")

      textarea.focus()
      textarea.cursorOffset = 2

      extmarks.create({
        start: 3,
        end: 6,
        virtual: true,
      })

      expect(textarea.cursorOffset).toBe(2)

      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(6)
    })

    it("should jump to position AFTER extmark end when moving right from before extmark", async () => {
      await setup("abcdefgh")

      textarea.focus()
      textarea.cursorOffset = 2

      extmarks.create({
        start: 3,
        end: 6,
        virtual: true,
      })

      expect(textarea.cursorOffset).toBe(2)

      // When moving right from position 2 (before extmark start at 3),
      // should jump to position 6 (after extmark end)
      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(6)
    })

    it("should allow cursor to move normally outside virtual extmark", async () => {
      await setup("abcdefgh")

      textarea.focus()
      textarea.cursorOffset = 0

      extmarks.create({
        start: 3,
        end: 6,
        virtual: true,
      })

      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(1)

      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(2)
    })

    it("should jump over multiple virtual extmarks", async () => {
      await setup("abcdefghij")

      textarea.focus()
      textarea.cursorOffset = 0

      extmarks.create({ start: 2, end: 4, virtual: true })
      extmarks.create({ start: 5, end: 7, virtual: true })

      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(1)

      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(4)

      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(7)
    })
  })

  describe("Virtual Extmark - Cursor Jumping Left", () => {
    it("should jump cursor over virtual extmark when moving left", async () => {
      await setup("abcdefgh")

      textarea.focus()
      textarea.cursorOffset = 7

      extmarks.create({
        start: 3,
        end: 6,
        virtual: true,
      })

      expect(textarea.cursorOffset).toBe(7)

      currentMockInput.pressArrow("left")
      expect(textarea.cursorOffset).toBe(6)

      currentMockInput.pressArrow("left")
      expect(textarea.cursorOffset).toBe(2)
    })

    it("should jump to position BEFORE extmark start when moving left from after extmark", async () => {
      await setup("abcdefgh")

      textarea.focus()
      textarea.cursorOffset = 6

      extmarks.create({
        start: 3,
        end: 6,
        virtual: true,
      })

      expect(textarea.cursorOffset).toBe(6)

      // When moving left from position 6 (right after extmark end),
      // should jump to position 2 (before extmark start at 3)
      currentMockInput.pressArrow("left")
      expect(textarea.cursorOffset).toBe(2)
    })

    it("should allow normal cursor movement left outside virtual extmark", async () => {
      await setup("abcdefgh")

      textarea.focus()
      textarea.cursorOffset = 2

      extmarks.create({
        start: 3,
        end: 6,
        virtual: true,
      })

      currentMockInput.pressArrow("left")
      expect(textarea.cursorOffset).toBe(1)

      currentMockInput.pressArrow("left")
      expect(textarea.cursorOffset).toBe(0)
    })
  })

  describe("Virtual Extmark - Selection Mode", () => {
    it("should allow selection through virtual extmark", async () => {
      await setup("abcdefgh")

      textarea.focus()
      textarea.cursorOffset = 0

      extmarks.create({
        start: 2,
        end: 5,
        virtual: true,
      })

      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })

      expect(textarea.cursorOffset).toBe(3)
      expect(textarea.hasSelection()).toBe(true)
    })
  })

  describe("Virtual Extmark - Backspace Deletion", () => {
    it("should delete entire virtual extmark on backspace at end", async () => {
      await setup("abc[LINK]def")

      textarea.focus()
      textarea.cursorOffset = 9

      const id = extmarks.create({
        start: 3,
        end: 9,
        virtual: true,
      })

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("abcdef")
      expect(textarea.cursorOffset).toBe(3)
      expect(extmarks.get(id)).toBeNull()
    })

    it("should not delete virtual extmark on backspace outside range", async () => {
      await setup("abc[LINK]def")

      textarea.focus()
      textarea.cursorOffset = 2

      const id = extmarks.create({
        start: 3,
        end: 9,
        virtual: true,
      })

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("ac[LINK]def")
      expect(extmarks.get(id)).not.toBeNull()
    })

    it("should delete normal character inside virtual extmark", async () => {
      await setup("abc[LINK]def")

      textarea.focus()
      textarea.cursorOffset = 5

      extmarks.create({
        start: 3,
        end: 9,
        virtual: true,
      })

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("abc[INK]def")
    })
  })

  describe("Virtual Extmark - Delete Key", () => {
    it("should delete entire virtual extmark on delete at start", async () => {
      await setup("abc[LINK]def")

      textarea.focus()
      textarea.cursorOffset = 3

      const id = extmarks.create({
        start: 3,
        end: 9,
        virtual: true,
      })

      currentMockInput.pressKey("DELETE")

      expect(textarea.plainText).toBe("abcdef")
      expect(textarea.cursorOffset).toBe(3)
      expect(extmarks.get(id)).toBeNull()
    })
  })

  describe("Extmark Position Adjustment - Insertion", () => {
    it("should adjust extmark positions after insertion before extmark", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      currentMockInput.pressKey("X")
      currentMockInput.pressKey("X")

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(8)
      expect(extmark?.end).toBe(13)
    })

    it("should expand extmark when inserting inside", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.focus()
      textarea.cursorOffset = 8

      currentMockInput.pressKey("X")
      currentMockInput.pressKey("X")

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(6)
      expect(extmark?.end).toBe(13)
    })

    it("should not adjust extmark when inserting after", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 0,
        end: 5,
      })

      textarea.focus()
      textarea.cursorOffset = 11

      currentMockInput.pressKey("X")
      currentMockInput.pressKey("X")

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(0)
      expect(extmark?.end).toBe(5)
    })

    it("should adjust extmark positions by display width after multi-width text insertion before extmark", async () => {
      await setup("abc")

      const id = extmarks.create({
        start: 1,
        end: 3,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      textarea.insertText("한글")

      const extmark = extmarks.get(id)
      expect(textarea.plainText).toBe("한글abc")
      expect(extmark?.start).toBe(5)
      expect(extmark?.end).toBe(7)
    })

    it("should adjust extmark positions by display width after multi-width char insertion before extmark", async () => {
      await setup("abc")

      const id = extmarks.create({
        start: 1,
        end: 3,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      textarea.insertChar("한")

      const extmark = extmarks.get(id)
      expect(textarea.plainText).toBe("한abc")
      expect(extmark?.start).toBe(3)
      expect(extmark?.end).toBe(5)
    })

    it("should count newlines in display offsets after multi-line multi-width insertion before extmark", async () => {
      await setup("abc")

      const id = extmarks.create({
        start: 1,
        end: 3,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      textarea.insertText("한\n글")

      const extmark = extmarks.get(id)
      expect(textarea.plainText).toBe("한\n글abc")
      expect(extmark?.start).toBe(6)
      expect(extmark?.end).toBe(8)
    })
  })

  describe("Extmark Position Adjustment - Deletion", () => {
    it("should adjust extmark positions after deletion before extmark", async () => {
      await setup("XXHello World")

      const id = extmarks.create({
        start: 8,
        end: 13,
      })

      textarea.focus()
      textarea.cursorOffset = 2

      currentMockInput.pressBackspace()
      currentMockInput.pressBackspace()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(6)
      expect(extmark?.end).toBe(11)
    })

    it("should remove extmark when its range is deleted", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.deleteRange(0, 6, 0, 11)

      expect(extmarks.get(id)).toBeNull()
    })

    it("should adjust extmark positions by display width after backspacing multi-width text before extmark", async () => {
      await setup("한글abc")

      const id = extmarks.create({
        start: 4,
        end: 7,
      })

      textarea.focus()
      textarea.cursorOffset = 4
      currentMockInput.pressBackspace()

      const extmark = extmarks.get(id)
      expect(textarea.plainText).toBe("한abc")
      expect(extmark?.start).toBe(2)
      expect(extmark?.end).toBe(5)
    })

    it("should adjust extmark positions by display width after deleting multi-width text before extmark", async () => {
      await setup("한abc")

      const id = extmarks.create({
        start: 2,
        end: 5,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("DELETE")

      const extmark = extmarks.get(id)
      expect(textarea.plainText).toBe("abc")
      expect(extmark?.start).toBe(0)
      expect(extmark?.end).toBe(3)
    })
  })

  describe("Highlighting Integration", () => {
    it("should apply highlight for extmark with styleId", async () => {
      await setup("Hello World")

      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("link", {
        fg: RGBA.fromValues(0, 0, 1, 1),
      })

      textarea.syntaxStyle = style

      extmarks.create({
        start: 0,
        end: 5,
        styleId,
      })

      const highlights = textarea.getLineHighlights(0)
      expect(highlights.length).toBe(1)
      expect(highlights[0].start).toBe(0)
      expect(highlights[0].end).toBe(5)
      expect(highlights[0].styleId).toBe(styleId)
    })

    it("should correctly position highlights in middle of single line", async () => {
      await setup("AAAA")

      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("test", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      textarea.syntaxStyle = style

      // Highlight just the middle two chars (positions 1-2, which is "AA")
      extmarks.create({
        start: 1,
        end: 3,
        styleId,
      })

      const highlights = textarea.getLineHighlights(0)
      expect(highlights.length).toBe(1)
      expect(highlights[0].start).toBe(1)
      expect(highlights[0].end).toBe(3)
    })

    it("should correctly position highlights across newlines", async () => {
      await setup("AAAA\nBBBB\nCCCC")

      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("test", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      textarea.syntaxStyle = style

      // Text: "AAAA\nBBBB\nCCCC"
      // Cursor offsets (with newlines): 0-3="AAAA", 4="\n", 5-8="BBBB", 9="\n", 10-13="CCCC"
      // Want to highlight just "BBBB" which is cursor offset 5-9
      extmarks.create({
        start: 5,
        end: 9,
        styleId,
      })

      const hl0 = textarea.getLineHighlights(0)
      const hl1 = textarea.getLineHighlights(1)
      const hl2 = textarea.getLineHighlights(2)

      // Line 0 should have no highlights
      expect(hl0.length).toBe(0)

      // Line 1 should have the entire "BBBB" highlighted
      expect(hl1.length).toBe(1)
      expect(hl1[0].start).toBe(0)
      expect(hl1[0].end).toBe(4)

      // Line 2 should have no highlights
      expect(hl2.length).toBe(0)
    })

    it("should correctly position multiline highlights", async () => {
      await setup("AAA\nBBB\nCCC")

      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("test", {
        fg: RGBA.fromValues(0, 1, 0, 1),
      })

      textarea.syntaxStyle = style

      // Text: "AAA\nBBB\nCCC"
      // Cursor offsets: 0-2="AAA", 3="\n", 4-6="BBB", 7="\n", 8-10="CCC"
      // Want to highlight from middle of line 0 to middle of line 2
      // From cursor offset 1 (second 'A') to 9 (second 'C')
      extmarks.create({
        start: 1,
        end: 9,
        styleId,
      })

      const hl0 = textarea.getLineHighlights(0)
      const hl1 = textarea.getLineHighlights(1)
      const hl2 = textarea.getLineHighlights(2)

      // Line 0: should highlight from position 1 to end (last two A's)
      expect(hl0.length).toBe(1)
      expect(hl0[0].start).toBe(1)
      expect(hl0[0].end).toBe(3)

      // Line 1: should highlight entire line (all of BBB)
      expect(hl1.length).toBe(1)
      expect(hl1[0].start).toBe(0)
      expect(hl1[0].end).toBe(3)

      // Line 2: should highlight from start to position 1 (first C only)
      // Cursor offset 9 = char offset 7 = second 'C'
      // Line 2 starts at char offset 6, so we highlight positions 0-1 (first 'C')
      expect(hl2.length).toBe(1)
      expect(hl2[0].start).toBe(0)
      expect(hl2[0].end).toBe(1)
    })

    it("should update highlights when extmark position changes", async () => {
      await setup("Hello World")

      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("link", {
        fg: RGBA.fromValues(0, 0, 1, 1),
      })

      textarea.syntaxStyle = style

      const id = extmarks.create({
        start: 0,
        end: 5,
        styleId,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("X")

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(1)
      expect(extmark?.end).toBe(6)
    })

    it("should remove highlight when extmark is deleted", async () => {
      await setup("Hello World")

      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("link", {
        fg: RGBA.fromValues(0, 0, 1, 1),
      })

      textarea.syntaxStyle = style

      const id = extmarks.create({
        start: 0,
        end: 5,
        styleId,
      })

      const highlightsBefore = textarea.getLineHighlights(0)
      expect(highlightsBefore.length).toBeGreaterThan(0)

      extmarks.delete(id)

      const highlightsAfter = textarea.getLineHighlights(0)
      expect(highlightsAfter.length).toBe(0)
    })
  })

  describe("Multiline Text Support", () => {
    it("should handle extmarks in multiline text", async () => {
      await setup("Line 1\nLine 2\nLine 3")

      const id = extmarks.create({
        start: 7,
        end: 13,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("X")

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(8)
      expect(extmark?.end).toBe(14)
    })

    it("should handle virtual extmark across lines", async () => {
      await setup("Line 1\nLine 2\nLine 3")

      textarea.focus()
      textarea.cursorOffset = 5

      extmarks.create({
        start: 7,
        end: 13,
        virtual: true,
      })

      for (let i = 0; i < 3; i++) {
        currentMockInput.pressArrow("right")
      }

      expect(textarea.cursorOffset).toBe(14)
    })
  })

  describe("Destroy", () => {
    it("should restore original methods on destroy", async () => {
      await setup("Hello World")

      textarea.focus()
      textarea.cursorOffset = 2

      extmarks.create({
        start: 3,
        end: 6,
        virtual: true,
      })

      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(6)

      extmarks.destroy()

      textarea.cursorOffset = 2
      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(3)
    })

    it("should clear all extmarks on destroy", async () => {
      await setup()

      extmarks.create({ start: 0, end: 5 })
      extmarks.create({ start: 6, end: 11 })

      expect(extmarks.getAll().length).toBe(2)

      extmarks.destroy()

      expect(extmarks.getAll().length).toBe(0)
    })

    it("should throw error when using destroyed controller", async () => {
      await setup()

      extmarks.destroy()

      expect(() => {
        extmarks.create({ start: 0, end: 5 })
      }).toThrow("ExtmarksController is destroyed")
    })
  })

  describe("Highlight Boundaries", () => {
    it("should highlight only virtual marker without extending to end of line", async () => {
      await setup("text [VIRTUAL] more text")

      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("virtual", {
        fg: RGBA.fromValues(0.3, 0.7, 1.0, 1.0),
        bg: RGBA.fromValues(0.1, 0.2, 0.3, 1.0),
      })

      textarea.syntaxStyle = style

      const virtualStart = 5
      const virtualEnd = 14

      extmarks.create({
        start: virtualStart,
        end: virtualEnd,
        virtual: true,
        styleId,
      })

      const highlights = textarea.getLineHighlights(0)

      expect(highlights.length).toBe(1)
      expect(highlights[0].start).toBe(virtualStart)
      expect(highlights[0].end).toBe(virtualEnd)
    })

    it("should highlight virtual marker in middle with text after", async () => {
      await setup("abc [MARKER] def")

      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("virtual", {
        fg: RGBA.fromValues(0.3, 0.7, 1.0, 1.0),
      })

      textarea.syntaxStyle = style

      const start = 4
      const end = 12

      extmarks.create({
        start,
        end,
        virtual: true,
        styleId,
      })

      const highlights = textarea.getLineHighlights(0)

      expect(highlights.length).toBe(1)
      expect(highlights[0].start).toBe(start)
      expect(highlights[0].end).toBe(end)
    })

    it("should highlight virtual marker in multiline text correctly", async () => {
      const text = `Try moving your cursor through the [VIRTUAL] markers below:
- Use arrow keys to navigate`

      await setup(text)

      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("virtual", {
        fg: RGBA.fromValues(0.3, 0.7, 1.0, 1.0),
        bg: RGBA.fromValues(0.1, 0.2, 0.3, 1.0),
      })

      textarea.syntaxStyle = style

      const pattern = /\[VIRTUAL\]/g
      const match = pattern.exec(text)

      if (!match) {
        throw new Error("Pattern not found")
      }

      const start = match.index
      const end = match.index + match[0].length

      extmarks.create({
        start,
        end,
        virtual: true,
        styleId,
      })

      const hl0 = textarea.getLineHighlights(0)
      const hl1 = textarea.getLineHighlights(1)

      expect(hl0.length).toBe(1)
      expect(hl0[0].start).toBe(35)
      expect(hl0[0].end).toBe(44)
      expect(hl1.length).toBe(0)
    })

    it("should correctly highlight multiple virtual markers with pattern matching", async () => {
      const initialContent = `Welcome to the Extmarks Demo!

This demo showcases virtual extmarks - text ranges that the cursor jumps over.

Try moving your cursor through the [VIRTUAL] markers below:
- Use arrow keys to navigate
- Notice how the cursor skips over [VIRTUAL] ranges`

      await setup(initialContent)

      const style = SyntaxStyle.create()
      const virtualStyleId = style.registerStyle("virtual", {
        fg: RGBA.fromValues(0.3, 0.7, 1.0, 1.0),
        bg: RGBA.fromValues(0.1, 0.2, 0.3, 1.0),
      })

      textarea.syntaxStyle = style

      const text = textarea.plainText
      const pattern = /\[(VIRTUAL|LINK:[^\]]+|TAG:[^\]]+|MARKER)\]/g
      let match: RegExpExecArray | null

      while ((match = pattern.exec(text)) !== null) {
        const start = match.index
        const end = match.index + match[0].length

        extmarks.create({
          start,
          end,
          virtual: true,
          styleId: virtualStyleId,
          data: { type: "auto-detected", content: match[0] },
        })
      }

      const line4Highlights = textarea.getLineHighlights(4)
      const line6Highlights = textarea.getLineHighlights(6)
      const lines = text.split("\n")

      expect(line4Highlights.length).toBeGreaterThan(0)
      expect(line6Highlights.length).toBeGreaterThan(0)

      const line4FirstHighlight = line4Highlights[0]
      const line6FirstHighlight = line6Highlights[0]

      expect(line4FirstHighlight.end).toBe(44)
      expect(line4FirstHighlight.end).toBeLessThan(lines[4].length)

      expect(line6FirstHighlight.end).toBe(44)
      expect(line6FirstHighlight.end).toBeLessThan(lines[6].length)
    })
  })

  describe("Multiple Extmarks", () => {
    it("should maintain correct positions after deleting first extmark", async () => {
      await setup("abc [VIRTUAL] def [VIRTUAL] ghi")

      const style = SyntaxStyle.create()
      const styleId = style.registerStyle("virtual", {
        fg: RGBA.fromValues(0.3, 0.7, 1.0, 1.0),
      })

      textarea.syntaxStyle = style

      const id1 = extmarks.create({
        start: 4,
        end: 13,
        virtual: true,
        styleId,
      })

      const id2 = extmarks.create({
        start: 18,
        end: 27,
        virtual: true,
        styleId,
      })

      textarea.focus()
      textarea.cursorOffset = 13
      currentMockInput.pressBackspace()

      expect(extmarks.get(id1)).toBeNull()

      const em2 = extmarks.get(id2)
      expect(em2).not.toBeNull()

      expect(textarea.plainText.substring(em2!.start, em2!.end)).toBe("[VIRTUAL]")
    })
  })

  describe("Complex Multiline Scenarios", () => {
    it("should handle multiple marker types across many lines", async () => {
      const initialContent = `Welcome to the Extmarks Demo!

This demo showcases virtual extmarks - text ranges that the cursor jumps over.

Try moving your cursor through the [VIRTUAL] markers below:
- Use arrow keys to navigate
- Notice how the cursor skips over [VIRTUAL] ranges
- Try backspacing at the end of a [VIRTUAL] marker
- It will delete the entire marker!

Example text with [LINK:https://example.com] embedded links.
You can also have [TAG:important] tags that act like atoms.

Regular text here can be edited normally.

Press Ctrl+L to add a new [MARKER] at cursor position.
Press ESC to return to main menu.`

      await setup(initialContent)

      const style = SyntaxStyle.create()
      const virtualStyleId = style.registerStyle("virtual", {
        fg: RGBA.fromValues(0.3, 0.7, 1.0, 1.0),
        bg: RGBA.fromValues(0.1, 0.2, 0.3, 1.0),
      })

      textarea.syntaxStyle = style

      const text = textarea.plainText
      const pattern = /\[(VIRTUAL|LINK:[^\]]+|TAG:[^\]]+|MARKER)\]/g
      let match: RegExpExecArray | null
      const markedRanges: Array<{ start: number; end: number; text: string; line: number }> = []

      const lines = text.split("\n")

      while ((match = pattern.exec(text)) !== null) {
        const start = match.index
        const end = match.index + match[0].length

        let lineIdx = 0
        let charCount = 0
        for (let i = 0; i < lines.length; i++) {
          if (charCount + lines[i].length >= start) {
            lineIdx = i
            break
          }
          charCount += lines[i].length + 1
        }

        markedRanges.push({ start, end, text: match[0], line: lineIdx })

        extmarks.create({
          start,
          end,
          virtual: true,
          styleId: virtualStyleId,
          data: { type: "auto-detected", content: match[0] },
        })
      }

      for (const range of markedRanges) {
        const highlights = textarea.getLineHighlights(range.line)
        const lineText = lines[range.line]

        expect(highlights.length).toBeGreaterThan(0)

        const matchingHighlight = highlights.find((h) => {
          const hlText = lineText.substring(h.start, Math.min(h.end, lineText.length))
          return hlText.includes(range.text.substring(0, Math.min(5, range.text.length)))
        })

        expect(matchingHighlight).not.toBeUndefined()
        expect(matchingHighlight!.end).toBeLessThanOrEqual(lineText.length)
      }
    })
  })

  describe("Virtual Extmark - Word Boundary Movement", () => {
    it("should not land inside virtual extmark when moving backward by word from after extmark", async () => {
      await setup("bla [VIRTUAL] bla")

      textarea.focus()
      textarea.cursorOffset = 13

      extmarks.create({
        start: 4,
        end: 13,
        virtual: true,
      })

      expect(textarea.cursorOffset).toBe(13)

      textarea.moveWordBackward()
      expect(textarea.cursorOffset).toBe(3)
    })

    it("should jump cursor over virtual extmark when moving forward by word", async () => {
      await setup("hello [VIRTUAL] world test")

      textarea.focus()
      textarea.cursorOffset = 0

      const id = extmarks.create({
        start: 6,
        end: 16,
        virtual: true,
      })

      expect(textarea.cursorOffset).toBe(0)

      textarea.moveWordForward()
      expect(textarea.cursorOffset).toBe(16)

      textarea.moveWordForward()
      expect(textarea.cursorOffset).toBe(22)

      const extmark = extmarks.get(id)
      expect(extmark).not.toBeNull()
    })

    it("should jump cursor over virtual extmark when moving backward by word", async () => {
      await setup("hello [VIRTUAL] world test")

      textarea.focus()
      textarea.cursorOffset = 22

      const id = extmarks.create({
        start: 6,
        end: 16,
        virtual: true,
      })

      expect(textarea.cursorOffset).toBe(22)

      textarea.moveWordBackward()
      expect(textarea.cursorOffset).toBe(16)

      textarea.moveWordBackward()
      expect(textarea.cursorOffset).toBe(5)

      const extmark = extmarks.get(id)
      expect(extmark).not.toBeNull()
    })

    it("should jump over multiple virtual extmarks when moving forward by word", async () => {
      await setup("one [V1] two [V2] three")

      textarea.focus()
      textarea.cursorOffset = 0

      extmarks.create({ start: 4, end: 9, virtual: true })
      extmarks.create({ start: 13, end: 18, virtual: true })

      textarea.moveWordForward()
      expect(textarea.cursorOffset).toBe(9)

      textarea.moveWordForward()
      expect(textarea.cursorOffset).toBe(18)

      textarea.moveWordForward()
      expect(textarea.cursorOffset).toBe(23)
    })

    it("should jump over multiple virtual extmarks when moving backward by word", async () => {
      await setup("one [V1] two [V2] three")

      textarea.focus()
      textarea.cursorOffset = 23

      extmarks.create({ start: 4, end: 9, virtual: true })
      extmarks.create({ start: 13, end: 18, virtual: true })

      textarea.moveWordBackward()
      expect(textarea.cursorOffset).toBe(18)

      textarea.moveWordBackward()
      expect(textarea.cursorOffset).toBe(12)

      textarea.moveWordBackward()
      expect(textarea.cursorOffset).toBe(9)

      textarea.moveWordBackward()
      expect(textarea.cursorOffset).toBe(3)
    })
  })

  describe("setText() Operations", () => {
    it("should clear all extmarks when setText is called", async () => {
      await setup("Hello World")

      const id1 = extmarks.create({ start: 0, end: 5 })
      const id2 = extmarks.create({ start: 6, end: 11, virtual: true })

      expect(extmarks.getAll().length).toBe(2)

      textarea.setText("New Text")

      expect(extmarks.getAll().length).toBe(0)
      expect(extmarks.get(id1)).toBeNull()
      expect(extmarks.get(id2)).toBeNull()
    })

    it("should clear all extmarks on setText", async () => {
      await setup("Hello World")

      extmarks.create({ start: 0, end: 5 })
      extmarks.create({ start: 6, end: 11 })

      expect(extmarks.getAll().length).toBe(2)

      textarea.setText("New Text")

      expect(extmarks.getAll().length).toBe(0)
    })

    it("should allow new extmarks after setText", async () => {
      await setup("Hello World")

      extmarks.create({ start: 0, end: 5 })
      textarea.setText("New Text")

      const newId = extmarks.create({ start: 0, end: 3 })
      const extmark = extmarks.get(newId)

      expect(extmark).not.toBeNull()
      expect(extmark?.start).toBe(0)
      expect(extmark?.end).toBe(3)
    })
  })

  describe("deleteWordForward() Operations", () => {
    it("should adjust extmark positions after deleteWordForward before extmark", async () => {
      await setup("hello world test")

      const id = extmarks.create({
        start: 12,
        end: 16,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      textarea.deleteWordForward()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(6)
      expect(extmark?.end).toBe(10)
      expect(textarea.plainText).toBe("world test")
    })

    it("should remove extmark when deleteWordForward covers it", async () => {
      await setup("hello world test")

      const id = extmarks.create({
        start: 0,
        end: 5,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      textarea.deleteWordForward()

      expect(extmarks.get(id)).toBeNull()
      expect(textarea.plainText).toBe("world test")
    })

    it("should not adjust extmark when deleteWordForward after", async () => {
      await setup("hello world test")

      const id = extmarks.create({
        start: 0,
        end: 5,
      })

      textarea.focus()
      textarea.cursorOffset = 6

      textarea.deleteWordForward()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(0)
      expect(extmark?.end).toBe(5)
    })
  })

  describe("deleteWordBackward() Operations", () => {
    it("should adjust extmark positions after deleteWordBackward before extmark", async () => {
      await setup("hello world test")

      const id = extmarks.create({
        start: 12,
        end: 16,
      })

      textarea.focus()
      textarea.cursorOffset = 11

      textarea.deleteWordBackward()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(7)
      expect(extmark?.end).toBe(11)
      expect(textarea.plainText).toBe("hello  test")
    })

    it("should remove extmark when deleteWordBackward covers it", async () => {
      await setup("hello world test")

      const id = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.focus()
      textarea.cursorOffset = 11

      textarea.deleteWordBackward()

      expect(extmarks.get(id)).toBeNull()
      expect(textarea.plainText).toBe("hello  test")
    })

    it("should not adjust extmark when deleteWordBackward after", async () => {
      await setup("hello world test")

      const id = extmarks.create({
        start: 12,
        end: 16,
      })

      textarea.focus()
      textarea.cursorOffset = 5

      textarea.deleteWordBackward()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(7)
      expect(extmark?.end).toBe(11)
      expect(textarea.plainText).toBe(" world test")
    })
  })

  describe("deleteToLineEnd() Operations", () => {
    it("should remove extmark when deleteToLineEnd covers it", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.focus()
      textarea.cursorOffset = 2

      textarea.deleteToLineEnd()

      expect(extmarks.get(id)).toBeNull()
      expect(textarea.plainText).toBe("He")
    })

    it("should partially trim extmark when deleteToLineEnd overlaps end", async () => {
      await setup("Hello World Extra")

      const id = extmarks.create({
        start: 3,
        end: 8,
      })

      textarea.focus()
      textarea.cursorOffset = 6

      textarea.deleteToLineEnd()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(3)
      expect(extmark?.end).toBe(6)
      expect(textarea.plainText).toBe("Hello ")
    })

    it("should not adjust extmark when deleteToLineEnd after", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 0,
        end: 2,
      })

      textarea.focus()
      textarea.cursorOffset = 5

      textarea.deleteToLineEnd()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(0)
      expect(extmark?.end).toBe(2)
      expect(textarea.plainText).toBe("Hello")
    })
  })

  describe("deleteLine() Operations", () => {
    it("should adjust extmark positions after deleteLine before extmark", async () => {
      await setup("Line1\nLine2\nLine3")

      const id = extmarks.create({
        start: 12,
        end: 17,
      })

      textarea.focus()
      textarea.cursorOffset = 3

      textarea.deleteLine()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(6)
      expect(extmark?.end).toBe(11)
      expect(textarea.plainText).toBe("Line2\nLine3")
    })

    it("should remove extmark when deleteLine on line containing it", async () => {
      await setup("Line1\nLine2\nLine3")

      const id = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.focus()
      textarea.cursorOffset = 8

      textarea.deleteLine()

      expect(extmarks.get(id)).toBeNull()
      expect(textarea.plainText).toBe("Line1\nLine3")
    })

    it("should not adjust extmark when deleteLine after", async () => {
      await setup("Line1\nLine2\nLine3")

      const id = extmarks.create({
        start: 0,
        end: 5,
      })

      textarea.focus()
      textarea.cursorOffset = 8

      textarea.deleteLine()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(0)
      expect(extmark?.end).toBe(5)
    })
  })

  describe("newLine() Operations", () => {
    it("should adjust extmark positions after newLine before extmark", async () => {
      await setup("HelloWorld")

      const id = extmarks.create({
        start: 5,
        end: 10,
      })

      textarea.focus()
      textarea.cursorOffset = 2

      textarea.newLine()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(6)
      expect(extmark?.end).toBe(11)
      expect(textarea.plainText).toBe("He\nlloWorld")
    })

    it("should expand extmark when newLine inside", async () => {
      await setup("HelloWorld")

      const id = extmarks.create({
        start: 2,
        end: 8,
      })

      textarea.focus()
      textarea.cursorOffset = 5

      textarea.newLine()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(2)
      expect(extmark?.end).toBe(9)
    })

    it("should not adjust extmark when newLine after", async () => {
      await setup("HelloWorld")

      const id = extmarks.create({
        start: 0,
        end: 5,
      })

      textarea.focus()
      textarea.cursorOffset = 10

      textarea.newLine()

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(0)
      expect(extmark?.end).toBe(5)
    })
  })

  describe("clear() Operations", () => {
    it("should clear all extmarks when clear is called", async () => {
      await setup("Hello World")

      const id1 = extmarks.create({ start: 0, end: 5 })
      const id2 = extmarks.create({ start: 6, end: 11, virtual: true })

      expect(extmarks.getAll().length).toBe(2)

      textarea.clear()

      expect(extmarks.getAll().length).toBe(0)
      expect(extmarks.get(id1)).toBeNull()
      expect(extmarks.get(id2)).toBeNull()
      expect(textarea.plainText).toBe("")
    })

    it("should clear all extmarks on clear", async () => {
      await setup("Hello World")

      extmarks.create({ start: 0, end: 5 })
      extmarks.create({ start: 6, end: 11 })

      expect(extmarks.getAll().length).toBe(2)

      textarea.clear()

      expect(extmarks.getAll().length).toBe(0)
    })

    it("should allow new extmarks after clear", async () => {
      await setup("Hello World")

      extmarks.create({ start: 0, end: 5 })
      textarea.clear()
      textarea.insertText("New")

      const newId = extmarks.create({ start: 0, end: 3 })
      const extmark = extmarks.get(newId)

      expect(extmark).not.toBeNull()
      expect(extmark?.start).toBe(0)
      expect(extmark?.end).toBe(3)
    })
  })

  describe("Selection Deletion", () => {
    it("should adjust extmarks when deleting selection with backspace", async () => {
      await setup("hello world test")

      const id = extmarks.create({
        start: 12,
        end: 16,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })

      expect(textarea.hasSelection()).toBe(true)

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("o world test")

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(8)
      expect(extmark?.end).toBe(12)
    })

    it("should adjust extmarks when deleting selection with delete key", async () => {
      await setup("hello world test")

      const id = extmarks.create({
        start: 12,
        end: 16,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })

      expect(textarea.hasSelection()).toBe(true)

      currentMockInput.pressKey("DELETE")

      expect(textarea.plainText).toBe("o world test")

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(8)
      expect(extmark?.end).toBe(12)
    })

    it("should adjust extmarks when replacing selection with text", async () => {
      await setup("hello world test")

      const id = extmarks.create({
        start: 12,
        end: 16,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })

      expect(textarea.hasSelection()).toBe(true)

      currentMockInput.pressKey("X")

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(8)
      expect(extmark?.end).toBe(12)
      expect(textarea.plainText).toBe("X world test")
    })

    it("should remove extmark when selection covers it", async () => {
      await setup("hello world test")

      const id = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      for (let i = 0; i < 12; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(textarea.hasSelection()).toBe(true)

      currentMockInput.pressBackspace()

      expect(extmarks.get(id)).toBeNull()
      expect(textarea.plainText).toBe("test")
    })
  })

  describe("Multiline Selection Deletion", () => {
    it("should adjust extmarks after deleting multiline selection", async () => {
      await setup("Line 1\nLine 2\nLine 3\nLine 4")

      const id = extmarks.create({
        start: 21,
        end: 27,
      })

      textarea.focus()
      textarea.cursorOffset = 7

      for (let i = 0; i < 7; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(textarea.hasSelection()).toBe(true)

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("Line 1\nLine 3\nLine 4")

      const extmark = extmarks.get(id)
      expect(extmark).not.toBeNull()
      expect(extmark?.start).toBe(14)
      expect(extmark?.end).toBe(20)
    })

    it("should adjust multiple extmarks after deleting multiline selection", async () => {
      await setup("AAA\nBBB\nCCC\nDDD")

      const id1 = extmarks.create({
        start: 8,
        end: 11,
      })

      const id2 = extmarks.create({
        start: 12,
        end: 15,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      for (let i = 0; i < 8; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(textarea.hasSelection()).toBe(true)

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("CCC\nDDD")

      const extmark1 = extmarks.get(id1)
      expect(extmark1).not.toBeNull()
      expect(extmark1?.start).toBe(0)
      expect(extmark1?.end).toBe(3)
      expect(textarea.plainText.substring(extmark1!.start, extmark1!.end)).toBe("CCC")

      const extmark2 = extmarks.get(id2)
      expect(extmark2).not.toBeNull()
      expect(extmark2?.start).toBe(4)
      expect(extmark2?.end).toBe(7)
      expect(textarea.plainText.substring(extmark2!.start, extmark2!.end)).toBe("DDD")
    })

    it("should correctly adjust extmark spanning multiple lines after multiline deletion", async () => {
      await setup("AAA\nBBB\nCCC\nDDD\nEEE")

      const id = extmarks.create({
        start: 12,
        end: 19,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      for (let i = 0; i < 8; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(textarea.hasSelection()).toBe(true)

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("CCC\nDDD\nEEE")

      const extmark = extmarks.get(id)
      expect(extmark).not.toBeNull()
      expect(extmark?.start).toBe(4)
      expect(extmark?.end).toBe(11)
      expect(textarea.plainText.substring(extmark!.start, extmark!.end)).toBe("DDD\nEEE")
    })

    it("should handle deletion of selection that partially overlaps extmark start", async () => {
      await setup("AAA\nBBB\nCCC\nDDD")

      const id = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.focus()
      textarea.cursorOffset = 4

      for (let i = 0; i < 6; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(textarea.hasSelection()).toBe(true)

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("AAA\nC\nDDD")

      const extmark = extmarks.get(id)
      expect(extmark).not.toBeNull()
      expect(extmark?.start).toBe(4)
      expect(extmark?.end).toBe(5)
    })

    it("should handle deletion across three lines with extmarks after", async () => {
      await setup("Line1\nLine2\nLine3\nLine4\nLine5")

      const id1 = extmarks.create({
        start: 18,
        end: 23,
      })

      const id2 = extmarks.create({
        start: 24,
        end: 29,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      for (let i = 0; i < 18; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(textarea.hasSelection()).toBe(true)

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("Line4\nLine5")

      const extmark1 = extmarks.get(id1)
      expect(extmark1).not.toBeNull()
      expect(extmark1?.start).toBe(0)
      expect(extmark1?.end).toBe(5)
      expect(textarea.plainText.substring(extmark1!.start, extmark1!.end)).toBe("Line4")

      const extmark2 = extmarks.get(id2)
      expect(extmark2).not.toBeNull()
      expect(extmark2?.start).toBe(6)
      expect(extmark2?.end).toBe(11)
      expect(textarea.plainText.substring(extmark2!.start, extmark2!.end)).toBe("Line5")
    })
  })

  describe("Edge Cases", () => {
    it("should handle extmark at start of text", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 0,
        end: 5,
        virtual: true,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(5)

      const extmark = extmarks.get(id)
      expect(extmark).not.toBeNull()
    })

    it("should handle extmark at end of text", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 6,
        end: 11,
        virtual: true,
      })

      textarea.focus()
      textarea.cursorOffset = 11

      currentMockInput.pressArrow("left")
      expect(textarea.cursorOffset).toBe(5)

      const extmark = extmarks.get(id)
      expect(extmark).not.toBeNull()
    })

    it("should handle zero-width extmark", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 5,
        end: 5,
      })

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(5)
      expect(extmark?.end).toBe(5)
    })

    it("should handle overlapping extmarks", async () => {
      await setup("Hello World")

      const id1 = extmarks.create({ start: 0, end: 7 })
      const id2 = extmarks.create({ start: 3, end: 9 })

      const atOffset5 = extmarks.getAtOffset(5)
      expect(atOffset5.length).toBe(2)
      expect(atOffset5.map((e) => e.id).sort()).toEqual([id1, id2])
    })

    it("should handle empty text", async () => {
      await setup("")

      const id = extmarks.create({
        start: 0,
        end: 0,
      })

      const extmark = extmarks.get(id)
      expect(extmark).not.toBeNull()
    })
  })

  describe("Virtual Extmark - Cursor Up/Down Movement", () => {
    it("should not land inside virtual extmark when moving down", async () => {
      await setup("abc\n[VIRTUAL]\ndef")

      textarea.focus()
      textarea.cursorOffset = 1

      extmarks.create({
        start: 4,
        end: 13,
        virtual: true,
      })

      expect(textarea.cursorOffset).toBe(1)

      currentMockInput.pressArrow("down")
      const cursorAfterDown = textarea.cursorOffset

      const isInsideExtmark = cursorAfterDown >= 4 && cursorAfterDown < 13
      expect(isInsideExtmark).toBe(false)
    })

    it("should not land inside virtual extmark when moving up", async () => {
      await setup("abc\n[VIRTUAL]\ndef")

      textarea.focus()
      textarea.cursorOffset = 15

      extmarks.create({
        start: 4,
        end: 13,
        virtual: true,
      })

      expect(textarea.cursorOffset).toBe(15)

      currentMockInput.pressArrow("up")
      const cursorAfterUp = textarea.cursorOffset

      const isInsideExtmark = cursorAfterUp >= 4 && cursorAfterUp < 13
      expect(isInsideExtmark).toBe(false)
    })

    it("should jump to closest boundary when moving down into virtual extmark", async () => {
      await setup("abc\n[VIRTUAL]\ndef")

      textarea.focus()
      textarea.cursorOffset = 1

      extmarks.create({
        start: 4,
        end: 13,
        virtual: true,
      })

      currentMockInput.pressArrow("down")
      const cursorAfterDown = textarea.cursorOffset

      expect(cursorAfterDown === 3 || cursorAfterDown === 13).toBe(true)
    })

    it("should jump to closest boundary when moving up into virtual extmark", async () => {
      await setup("abc\n[VIRTUAL]\ndef")

      textarea.focus()
      textarea.cursorOffset = 15

      extmarks.create({
        start: 4,
        end: 13,
        virtual: true,
      })

      currentMockInput.pressArrow("up")
      const cursorAfterUp = textarea.cursorOffset

      expect(cursorAfterUp === 3 || cursorAfterUp === 13).toBe(true)
    })

    it("should handle multiline virtual extmarks when moving up", async () => {
      await setup("line1\n[VIRTUAL\nMULTILINE]\nline4")

      textarea.focus()
      textarea.cursorOffset = 28

      extmarks.create({
        start: 6,
        end: 25,
        virtual: true,
      })

      currentMockInput.pressArrow("up")
      currentMockInput.pressArrow("up")
      const cursorAfterUp = textarea.cursorOffset

      const isInsideExtmark = cursorAfterUp >= 6 && cursorAfterUp < 25
      expect(isInsideExtmark).toBe(false)
    })

    it("should handle multiline virtual extmarks when moving down", async () => {
      await setup("line1\n[VIRTUAL\nMULTILINE]\nline4")

      textarea.focus()
      textarea.cursorOffset = 3

      extmarks.create({
        start: 6,
        end: 25,
        virtual: true,
      })

      currentMockInput.pressArrow("down")
      currentMockInput.pressArrow("down")
      const cursorAfterDown = textarea.cursorOffset

      const isInsideExtmark = cursorAfterDown >= 6 && cursorAfterDown < 25
      expect(isInsideExtmark).toBe(false)
    })

    it("should not get stuck when moving down into virtual extmark at start of line", async () => {
      // Regression test for cursor getting stuck when moving down over
      // virtual extmarks at the beginning of lines.
      // Setup:
      //   Line 0: "a"
      //   Line 1: "" (empty)
      //   Line 2: "[EXT]" (virtual extmark starting at column 0)
      //   Line 3: "b"
      await setup("a\n\n[EXT]\nb")

      textarea.focus()
      textarea.cursorOffset = 2

      const virtualStart = 3
      const virtualEnd = 8

      extmarks.create({
        start: virtualStart,
        end: virtualEnd,
        virtual: true,
      })

      const initialOffset = textarea.cursorOffset
      expect(initialOffset).toBe(2)

      currentMockInput.pressArrow("down")
      const cursorAfterDown = textarea.cursorOffset

      expect(cursorAfterDown).toBe(virtualEnd)
    })

    it("should land at trailing text when moving down into line-start virtual extmark", async () => {
      await setup("a\n\n[EXT]tail\nb")

      textarea.focus()
      textarea.cursorOffset = 2

      const virtualStart = 3
      const virtualEnd = 8

      extmarks.create({
        start: virtualStart,
        end: virtualEnd,
        virtual: true,
      })

      currentMockInput.pressArrow("down")

      const cursorAfterDown = textarea.cursorOffset

      expect(cursorAfterDown).toBe(virtualEnd)
      expect(textarea.plainText.slice(cursorAfterDown, cursorAfterDown + 4)).toBe("tail")
    })

    it("should not jump past buffer end when moving down into line-start virtual extmark at EOF", async () => {
      await setup("a\n\n[EXT]")

      textarea.focus()
      textarea.cursorOffset = 2

      const virtualStart = 3
      const virtualEnd = 8

      extmarks.create({
        start: virtualStart,
        end: virtualEnd,
        virtual: true,
      })

      currentMockInput.pressArrow("down")

      const cursorAfterDown = textarea.cursorOffset

      expect(cursorAfterDown).toBe(virtualEnd)
      expect(cursorAfterDown).toBe(textarea.plainText.length)
    })

    it("should navigate past virtual extmark at line start with repeated down presses", async () => {
      await setup("abc\n\n[EXTMARK]\n\nxyz")

      textarea.focus()
      textarea.cursorOffset = 0

      const virtualStart = 5
      const virtualEnd = 14

      extmarks.create({
        start: virtualStart,
        end: virtualEnd,
        virtual: true,
      })

      currentMockInput.pressArrow("down")
      currentMockInput.pressArrow("down")
      const afterExtmark = textarea.cursorOffset

      expect(afterExtmark).toBe(virtualEnd)

      currentMockInput.pressArrow("down")
      currentMockInput.pressArrow("down")
      const finalOffset = textarea.cursorOffset

      const xyzStart = textarea.plainText.indexOf("xyz")
      expect(finalOffset).toBeGreaterThanOrEqual(xyzStart)
      expect(finalOffset).toBeLessThanOrEqual(textarea.plainText.length)
    })
  })

  describe("TypeId Operations", () => {
    it("should create extmark with default typeId 0", async () => {
      await setup()

      const id = extmarks.create({
        start: 0,
        end: 5,
      })

      const extmark = extmarks.get(id)
      expect(extmark?.typeId).toBe(0)
    })

    it("should create extmark with custom typeId", async () => {
      await setup()

      const id = extmarks.create({
        start: 0,
        end: 5,
        typeId: 42,
      })

      const extmark = extmarks.get(id)
      expect(extmark?.typeId).toBe(42)
    })

    it("should retrieve all extmarks for a specific typeId", async () => {
      await setup()

      const id1 = extmarks.create({ start: 0, end: 5, typeId: 1 })
      const id2 = extmarks.create({ start: 6, end: 11, typeId: 1 })
      const id3 = extmarks.create({ start: 12, end: 15, typeId: 2 })

      const type1Marks = extmarks.getAllForTypeId(1)
      expect(type1Marks.length).toBe(2)
      expect(type1Marks.map((e) => e.id).sort()).toEqual([id1, id2])

      const type2Marks = extmarks.getAllForTypeId(2)
      expect(type2Marks.length).toBe(1)
      expect(type2Marks[0].id).toBe(id3)
    })

    it("should return empty array for non-existent typeId", async () => {
      await setup()

      extmarks.create({ start: 0, end: 5, typeId: 1 })

      const noMarks = extmarks.getAllForTypeId(999)
      expect(noMarks.length).toBe(0)
    })

    it("should handle multiple extmarks with same typeId", async () => {
      await setup()

      const ids = []
      for (let i = 0; i < 10; i++) {
        ids.push(extmarks.create({ start: i, end: i + 1, typeId: 5 }))
      }

      const type5Marks = extmarks.getAllForTypeId(5)
      expect(type5Marks.length).toBe(10)
      expect(type5Marks.map((e) => e.id).sort()).toEqual(ids.sort())
    })

    it("should remove extmark from typeId index when deleted", async () => {
      await setup()

      const id = extmarks.create({ start: 0, end: 5, typeId: 3 })

      let type3Marks = extmarks.getAllForTypeId(3)
      expect(type3Marks.length).toBe(1)

      extmarks.delete(id)

      type3Marks = extmarks.getAllForTypeId(3)
      expect(type3Marks.length).toBe(0)
    })

    it("should clear all typeId indexes when clear is called", async () => {
      await setup()

      extmarks.create({ start: 0, end: 5, typeId: 1 })
      extmarks.create({ start: 6, end: 11, typeId: 2 })
      extmarks.create({ start: 12, end: 15, typeId: 3 })

      extmarks.clear()

      expect(extmarks.getAllForTypeId(1).length).toBe(0)
      expect(extmarks.getAllForTypeId(2).length).toBe(0)
      expect(extmarks.getAllForTypeId(3).length).toBe(0)
    })

    it("should maintain typeId through text operations", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 6,
        end: 11,
        typeId: 7,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("X")
      currentMockInput.pressKey("X")

      const extmark = extmarks.get(id)
      expect(extmark?.typeId).toBe(7)

      const type7Marks = extmarks.getAllForTypeId(7)
      expect(type7Marks.length).toBe(1)
      expect(type7Marks[0].id).toBe(id)
    })

    it("should group virtual and non-virtual extmarks by typeId", async () => {
      await setup()

      const id1 = extmarks.create({ start: 0, end: 5, typeId: 10, virtual: false })
      const id2 = extmarks.create({ start: 6, end: 11, typeId: 10, virtual: true })
      const id3 = extmarks.create({ start: 12, end: 15, typeId: 10, virtual: false })

      const type10Marks = extmarks.getAllForTypeId(10)
      expect(type10Marks.length).toBe(3)

      const virtualMarks = type10Marks.filter((e) => e.virtual)
      const nonVirtualMarks = type10Marks.filter((e) => !e.virtual)

      expect(virtualMarks.length).toBe(1)
      expect(nonVirtualMarks.length).toBe(2)
    })

    it("should handle typeId 0 as default", async () => {
      await setup()

      const id1 = extmarks.create({ start: 0, end: 5 })
      const id2 = extmarks.create({ start: 6, end: 11, typeId: 0 })
      const id3 = extmarks.create({ start: 12, end: 15 })

      const type0Marks = extmarks.getAllForTypeId(0)
      expect(type0Marks.length).toBe(3)
      expect(type0Marks.map((e) => e.id).sort()).toEqual([id1, id2, id3])
    })

    it("should remove extmark from typeId index on deletion during backspace", async () => {
      await setup("abc[LINK]def")

      textarea.focus()
      textarea.cursorOffset = 9

      const id = extmarks.create({
        start: 3,
        end: 9,
        virtual: true,
        typeId: 15,
      })

      let type15Marks = extmarks.getAllForTypeId(15)
      expect(type15Marks.length).toBe(1)

      currentMockInput.pressBackspace()

      expect(extmarks.get(id)).toBeNull()

      type15Marks = extmarks.getAllForTypeId(15)
      expect(type15Marks.length).toBe(0)
    })

    it("should remove extmark from typeId index on deletion during delete key", async () => {
      await setup("abc[LINK]def")

      textarea.focus()
      textarea.cursorOffset = 3

      const id = extmarks.create({
        start: 3,
        end: 9,
        virtual: true,
        typeId: 20,
      })

      let type20Marks = extmarks.getAllForTypeId(20)
      expect(type20Marks.length).toBe(1)

      currentMockInput.pressKey("DELETE")

      expect(extmarks.get(id)).toBeNull()

      type20Marks = extmarks.getAllForTypeId(20)
      expect(type20Marks.length).toBe(0)
    })

    it("should handle getAllForTypeId on destroyed controller", async () => {
      await setup()

      extmarks.create({ start: 0, end: 5, typeId: 1 })

      extmarks.destroy()

      const type1Marks = extmarks.getAllForTypeId(1)
      expect(type1Marks.length).toBe(0)
    })

    it("should support multiple different typeIds simultaneously", async () => {
      await setup("The quick brown fox jumps over the lazy dog")

      const linkId1 = extmarks.create({ start: 0, end: 3, typeId: 1 })
      const linkId2 = extmarks.create({ start: 10, end: 15, typeId: 1 })

      const tagId1 = extmarks.create({ start: 4, end: 9, typeId: 2 })
      const tagId2 = extmarks.create({ start: 16, end: 19, typeId: 2 })

      const markerId = extmarks.create({ start: 20, end: 25, typeId: 3 })

      const links = extmarks.getAllForTypeId(1)
      expect(links.length).toBe(2)
      expect(links.map((e) => e.id).sort()).toEqual([linkId1, linkId2])

      const tags = extmarks.getAllForTypeId(2)
      expect(tags.length).toBe(2)
      expect(tags.map((e) => e.id).sort()).toEqual([tagId1, tagId2])

      const markers = extmarks.getAllForTypeId(3)
      expect(markers.length).toBe(1)
      expect(markers[0].id).toBe(markerId)

      const allExtmarks = extmarks.getAll()
      expect(allExtmarks.length).toBe(5)
    })

    it("should preserve typeId when extmark is adjusted after insertion", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 6,
        end: 11,
        typeId: 50,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("Z")

      const extmark = extmarks.get(id)
      expect(extmark?.typeId).toBe(50)
      expect(extmark?.start).toBe(7)
      expect(extmark?.end).toBe(12)

      const type50Marks = extmarks.getAllForTypeId(50)
      expect(type50Marks.length).toBe(1)
    })

    it("should preserve typeId when extmark is adjusted after deletion", async () => {
      await setup("XXHello World")

      const id = extmarks.create({
        start: 8,
        end: 13,
        typeId: 60,
      })

      textarea.focus()
      textarea.cursorOffset = 2
      currentMockInput.pressBackspace()
      currentMockInput.pressBackspace()

      const extmark = extmarks.get(id)
      expect(extmark?.typeId).toBe(60)
      expect(extmark?.start).toBe(6)
      expect(extmark?.end).toBe(11)

      const type60Marks = extmarks.getAllForTypeId(60)
      expect(type60Marks.length).toBe(1)
    })
  })

  describe("Undo/Redo with Extmarks", () => {
    it("should restore extmark after undo of text insertion", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 0,
        end: 5,
        styleId: 1,
      })

      textarea.focus()
      textarea.cursorOffset = 3
      currentMockInput.pressKey("X")

      const extmarkAfterInsert = extmarks.get(id)
      expect(extmarkAfterInsert?.start).toBe(0)
      expect(extmarkAfterInsert?.end).toBe(6)

      textarea.undo()

      const extmarkAfterUndo = extmarks.get(id)
      expect(extmarkAfterUndo?.start).toBe(0)
      expect(extmarkAfterUndo?.end).toBe(5)
    })

    it("should restore extmark after undo of text deletion", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 6,
        end: 11,
        styleId: 1,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("DELETE")

      const extmarkAfterDelete = extmarks.get(id)
      expect(extmarkAfterDelete?.start).toBe(5)
      expect(extmarkAfterDelete?.end).toBe(10)

      textarea.undo()

      const extmarkAfterUndo = extmarks.get(id)
      expect(extmarkAfterUndo?.start).toBe(6)
      expect(extmarkAfterUndo?.end).toBe(11)
    })

    it("should restore extmark after redo", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 0,
        end: 5,
        styleId: 1,
      })

      textarea.focus()
      textarea.cursorOffset = 3
      currentMockInput.pressKey("X")

      const extmarkAfterInsert = extmarks.get(id)
      expect(extmarkAfterInsert?.start).toBe(0)
      expect(extmarkAfterInsert?.end).toBe(6)

      textarea.undo()

      const extmarkAfterUndo = extmarks.get(id)
      expect(extmarkAfterUndo?.start).toBe(0)
      expect(extmarkAfterUndo?.end).toBe(5)

      textarea.redo()

      const extmarkAfterRedo = extmarks.get(id)
      expect(extmarkAfterRedo?.start).toBe(0)
      expect(extmarkAfterRedo?.end).toBe(6)
    })

    it("should restore deleted virtual extmark after undo", async () => {
      await setup("abc[LINK]def")

      textarea.focus()
      textarea.cursorOffset = 9

      const id = extmarks.create({
        start: 3,
        end: 9,
        virtual: true,
      })

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("abcdef")
      expect(extmarks.get(id)).toBeNull()

      textarea.undo()

      const extmarkAfterUndo = extmarks.get(id)
      expect(extmarkAfterUndo).not.toBeNull()
      expect(extmarkAfterUndo?.start).toBe(3)
      expect(extmarkAfterUndo?.end).toBe(9)
      expect(extmarkAfterUndo?.virtual).toBe(true)
      expect(textarea.plainText).toBe("abc[LINK]def")
    })

    it("should handle multiple undo/redo operations", async () => {
      await setup("Test")

      const id = extmarks.create({
        start: 0,
        end: 4,
      })

      textarea.focus()
      textarea.cursorOffset = 2

      currentMockInput.pressKey("1")
      expect(extmarks.get(id)?.end).toBe(5)

      currentMockInput.pressKey("2")
      expect(extmarks.get(id)?.end).toBe(6)

      currentMockInput.pressKey("3")
      expect(extmarks.get(id)?.end).toBe(7)

      textarea.undo()
      expect(extmarks.get(id)?.end).toBe(6)

      textarea.undo()
      expect(extmarks.get(id)?.end).toBe(5)

      textarea.undo()
      expect(extmarks.get(id)?.end).toBe(4)

      textarea.redo()
      expect(extmarks.get(id)?.end).toBe(5)

      textarea.redo()
      expect(extmarks.get(id)?.end).toBe(6)

      textarea.redo()
      expect(extmarks.get(id)?.end).toBe(7)
    })

    it("should restore multiple extmarks after undo", async () => {
      await setup("Hello World Test")

      const id1 = extmarks.create({
        start: 0,
        end: 5,
      })

      const id2 = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("X")

      expect(extmarks.get(id1)?.start).toBe(1)
      expect(extmarks.get(id1)?.end).toBe(6)
      expect(extmarks.get(id2)?.start).toBe(7)
      expect(extmarks.get(id2)?.end).toBe(12)

      textarea.undo()

      expect(extmarks.get(id1)?.start).toBe(0)
      expect(extmarks.get(id1)?.end).toBe(5)
      expect(extmarks.get(id2)?.start).toBe(6)
      expect(extmarks.get(id2)?.end).toBe(11)
    })

    it("should handle undo after backspace that deleted virtual extmark", async () => {
      await setup("text[VIRTUAL]more")

      textarea.focus()
      textarea.cursorOffset = 13

      const id = extmarks.create({
        start: 4,
        end: 13,
        virtual: true,
      })

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe("textmore")
      expect(extmarks.get(id)).toBeNull()

      textarea.undo()

      const restoredExtmark = extmarks.get(id)
      expect(restoredExtmark).not.toBeNull()
      expect(restoredExtmark?.start).toBe(4)
      expect(restoredExtmark?.end).toBe(13)
      expect(restoredExtmark?.virtual).toBe(true)
    })

    it("should restore extmark IDs correctly after undo", async () => {
      await setup("Test")

      const id1 = extmarks.create({
        start: 0,
        end: 2,
      })

      const id2 = extmarks.create({
        start: 2,
        end: 4,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("X")

      textarea.undo()

      expect(extmarks.get(id1)).not.toBeNull()
      expect(extmarks.get(id2)).not.toBeNull()
      expect(extmarks.get(id1)?.id).toBe(id1)
      expect(extmarks.get(id2)?.id).toBe(id2)
    })

    it("should preserve extmark data after undo/redo", async () => {
      await setup("Hello")

      const id = extmarks.create({
        start: 0,
        end: 5,
        data: { type: "link", url: "https://example.com" },
      })

      textarea.focus()
      textarea.cursorOffset = 5
      currentMockInput.pressKey("X")

      textarea.undo()

      const extmark = extmarks.get(id)
      expect(extmark?.data).toEqual({ type: "link", url: "https://example.com" })

      textarea.redo()

      const extmarkAfterRedo = extmarks.get(id)
      expect(extmarkAfterRedo?.data).toEqual({ type: "link", url: "https://example.com" })
    })

    it("should handle undo/redo with multiline extmarks", async () => {
      await setup("Line1\nLine2\nLine3")

      const id = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("X")

      expect(extmarks.get(id)?.start).toBe(7)
      expect(extmarks.get(id)?.end).toBe(12)

      textarea.undo()

      expect(extmarks.get(id)?.start).toBe(6)
      expect(extmarks.get(id)?.end).toBe(11)

      textarea.redo()

      expect(extmarks.get(id)?.start).toBe(7)
      expect(extmarks.get(id)?.end).toBe(12)
    })

    it("should handle undo after deleteRange", async () => {
      await setup("Hello World Test")

      const id = extmarks.create({
        start: 12,
        end: 16,
      })

      textarea.focus()
      textarea.deleteRange(0, 0, 0, 6)

      expect(extmarks.get(id)?.start).toBe(6)
      expect(extmarks.get(id)?.end).toBe(10)

      textarea.undo()

      expect(extmarks.get(id)?.start).toBe(12)
      expect(extmarks.get(id)?.end).toBe(16)
    })

    it("should maintain correct nextId after undo/redo", async () => {
      await setup("Test")

      extmarks.create({ start: 0, end: 2 })

      textarea.focus()
      textarea.cursorOffset = 4
      currentMockInput.pressKey("X")

      textarea.undo()

      const newId = extmarks.create({ start: 2, end: 4 })

      expect(newId).toBe(2)
    })

    it("should handle undo/redo of selection deletion", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 6,
        end: 11,
      })

      textarea.focus()
      textarea.cursorOffset = 0

      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      currentMockInput.pressBackspace()

      expect(textarea.plainText).toBe(" World")
      expect(extmarks.get(id)?.start).toBe(1)
      expect(extmarks.get(id)?.end).toBe(6)

      textarea.undo()

      expect(textarea.plainText).toBe("Hello World")
      expect(extmarks.get(id)?.start).toBe(6)
      expect(extmarks.get(id)?.end).toBe(11)
    })
  })

  describe("Type Registry", () => {
    it("should register a type name and return a unique typeId", async () => {
      await setup()

      const linkTypeId = extmarks.registerType("link")
      expect(linkTypeId).toBe(1)

      const tagTypeId = extmarks.registerType("tag")
      expect(tagTypeId).toBe(2)

      expect(linkTypeId).not.toBe(tagTypeId)
    })

    it("should return the same typeId for duplicate type name registration", async () => {
      await setup()

      const firstId = extmarks.registerType("link")
      const secondId = extmarks.registerType("link")

      expect(firstId).toBe(secondId)
    })

    it("should resolve typeName to typeId", async () => {
      await setup()

      const linkTypeId = extmarks.registerType("link")
      const resolvedId = extmarks.getTypeId("link")

      expect(resolvedId).toBe(linkTypeId)
    })

    it("should return null for unregistered typeName", async () => {
      await setup()

      const resolvedId = extmarks.getTypeId("nonexistent")
      expect(resolvedId).toBeNull()
    })

    it("should resolve typeId to typeName", async () => {
      await setup()

      const linkTypeId = extmarks.registerType("link")
      const resolvedName = extmarks.getTypeName(linkTypeId)

      expect(resolvedName).toBe("link")
    })

    it("should return null for unregistered typeId", async () => {
      await setup()

      const resolvedName = extmarks.getTypeName(999)
      expect(resolvedName).toBeNull()
    })

    it("should create extmark with registered type", async () => {
      await setup()

      const linkTypeId = extmarks.registerType("link")
      const extmarkId = extmarks.create({
        start: 0,
        end: 5,
        typeId: linkTypeId,
      })

      const extmark = extmarks.get(extmarkId)
      expect(extmark?.typeId).toBe(linkTypeId)
    })

    it("should retrieve extmarks by registered type name", async () => {
      await setup()

      const linkTypeId = extmarks.registerType("link")
      const tagTypeId = extmarks.registerType("tag")

      const linkId1 = extmarks.create({ start: 0, end: 5, typeId: linkTypeId })
      const linkId2 = extmarks.create({ start: 6, end: 11, typeId: linkTypeId })
      const tagId = extmarks.create({ start: 12, end: 15, typeId: tagTypeId })

      const linkExtmarks = extmarks.getAllForTypeId(linkTypeId)
      expect(linkExtmarks.length).toBe(2)
      expect(linkExtmarks.map((e) => e.id).sort()).toEqual([linkId1, linkId2])

      const tagExtmarks = extmarks.getAllForTypeId(tagTypeId)
      expect(tagExtmarks.length).toBe(1)
      expect(tagExtmarks[0].id).toBe(tagId)
    })

    it("should handle multiple type registrations", async () => {
      await setup()

      const types = ["link", "tag", "marker", "highlight", "error"]
      const typeIds = types.map((type) => extmarks.registerType(type))

      expect(new Set(typeIds).size).toBe(types.length)

      for (let i = 0; i < types.length; i++) {
        expect(extmarks.getTypeId(types[i])).toBe(typeIds[i])
        expect(extmarks.getTypeName(typeIds[i])).toBe(types[i])
      }
    })

    it("should preserve type registry across text operations", async () => {
      await setup("Hello World")

      const linkTypeId = extmarks.registerType("link")
      const extmarkId = extmarks.create({
        start: 0,
        end: 5,
        typeId: linkTypeId,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("X")

      expect(extmarks.getTypeId("link")).toBe(linkTypeId)
      expect(extmarks.getTypeName(linkTypeId)).toBe("link")

      const extmark = extmarks.get(extmarkId)
      expect(extmark?.typeId).toBe(linkTypeId)
    })

    it("should clear type registry on destroy", async () => {
      await setup()

      const linkTypeId = extmarks.registerType("link")
      extmarks.registerType("tag")

      extmarks.destroy()

      expect(extmarks.getTypeId("link")).toBeNull()
      expect(extmarks.getTypeName(linkTypeId)).toBeNull()
    })

    it("should throw error when registering type on destroyed controller", async () => {
      await setup()

      extmarks.destroy()

      expect(() => {
        extmarks.registerType("link")
      }).toThrow("ExtmarksController is destroyed")
    })

    it("should support workflow of register then create extmarks", async () => {
      await setup("The quick brown fox")

      const linkTypeId = extmarks.registerType("link")
      const emphasisTypeId = extmarks.registerType("emphasis")

      const link1 = extmarks.create({ start: 0, end: 3, typeId: linkTypeId, virtual: true })
      const link2 = extmarks.create({ start: 10, end: 15, typeId: linkTypeId, virtual: true })
      const emphasis1 = extmarks.create({ start: 4, end: 9, typeId: emphasisTypeId })

      const links = extmarks.getAllForTypeId(linkTypeId)
      expect(links.length).toBe(2)
      expect(links.map((e) => e.id).sort()).toEqual([link1, link2])

      const emphases = extmarks.getAllForTypeId(emphasisTypeId)
      expect(emphases.length).toBe(1)
      expect(emphases[0].id).toBe(emphasis1)

      expect(extmarks.getTypeName(linkTypeId)).toBe("link")
      expect(extmarks.getTypeName(emphasisTypeId)).toBe("emphasis")
    })

    it("should handle type names with special characters", async () => {
      await setup()

      const typeId1 = extmarks.registerType("my-type")
      const typeId2 = extmarks.registerType("my_type")
      const typeId3 = extmarks.registerType("my.type")
      const typeId4 = extmarks.registerType("my:type")

      expect(extmarks.getTypeId("my-type")).toBe(typeId1)
      expect(extmarks.getTypeId("my_type")).toBe(typeId2)
      expect(extmarks.getTypeId("my.type")).toBe(typeId3)
      expect(extmarks.getTypeId("my:type")).toBe(typeId4)

      expect(typeId1).not.toBe(typeId2)
      expect(typeId2).not.toBe(typeId3)
      expect(typeId3).not.toBe(typeId4)
    })

    it("should handle empty string as type name", async () => {
      await setup()

      const typeId = extmarks.registerType("")
      expect(typeId).toBe(1)
      expect(extmarks.getTypeId("")).toBe(typeId)
      expect(extmarks.getTypeName(typeId)).toBe("")
    })

    it("should return null for getTypeId and getTypeName on destroyed controller", async () => {
      await setup()

      const linkTypeId = extmarks.registerType("link")
      extmarks.destroy()

      expect(extmarks.getTypeId("link")).toBeNull()
      expect(extmarks.getTypeName(linkTypeId)).toBeNull()
    })

    it("should allow re-registration after clear", async () => {
      await setup()

      const firstLinkId = extmarks.registerType("link")
      extmarks.create({ start: 0, end: 5, typeId: firstLinkId })

      extmarks.clear()

      expect(extmarks.getTypeId("link")).toBe(firstLinkId)

      const newExtmarkId = extmarks.create({ start: 0, end: 3, typeId: firstLinkId })
      expect(extmarks.get(newExtmarkId)?.typeId).toBe(firstLinkId)
    })

    it("should support case-sensitive type names", async () => {
      await setup()

      const lowerId = extmarks.registerType("link")
      const upperId = extmarks.registerType("Link")
      const upperCaseId = extmarks.registerType("LINK")

      expect(lowerId).not.toBe(upperId)
      expect(upperId).not.toBe(upperCaseId)
      expect(lowerId).not.toBe(upperCaseId)

      expect(extmarks.getTypeId("link")).toBe(lowerId)
      expect(extmarks.getTypeId("Link")).toBe(upperId)
      expect(extmarks.getTypeId("LINK")).toBe(upperCaseId)
    })

    it("should maintain typeId sequence independent of extmark IDs", async () => {
      await setup()

      const extmarkId1 = extmarks.create({ start: 0, end: 1 })
      const extmarkId2 = extmarks.create({ start: 1, end: 2 })

      const linkTypeId = extmarks.registerType("link")
      const tagTypeId = extmarks.registerType("tag")

      expect(linkTypeId).toBe(1)
      expect(tagTypeId).toBe(2)
      expect(extmarkId1).toBeGreaterThanOrEqual(1)
      expect(extmarkId2).toBeGreaterThanOrEqual(2)
    })

    it("should handle numeric-like string type names", async () => {
      await setup()

      const typeId1 = extmarks.registerType("123")
      const typeId2 = extmarks.registerType("456")

      expect(extmarks.getTypeId("123")).toBe(typeId1)
      expect(extmarks.getTypeId("456")).toBe(typeId2)
      expect(typeId1).not.toBe(typeId2)
    })

    it("should support long type names", async () => {
      await setup()

      const longName = "a".repeat(1000)
      const typeId = extmarks.registerType(longName)

      expect(extmarks.getTypeId(longName)).toBe(typeId)
      expect(extmarks.getTypeName(typeId)).toBe(longName)
    })
  })

  describe("Metadata Operations", () => {
    it("should store and retrieve metadata for extmark", async () => {
      await setup()

      const metadata = { url: "https://example.com", title: "Example" }
      const id = extmarks.create({
        start: 0,
        end: 5,
        metadata,
      })

      const retrieved = extmarks.getMetadataFor(id)
      expect(retrieved).toEqual(metadata)
    })

    it("should return undefined for extmark without metadata", async () => {
      await setup()

      const id = extmarks.create({
        start: 0,
        end: 5,
      })

      const retrieved = extmarks.getMetadataFor(id)
      expect(retrieved).toBeUndefined()
    })

    it("should return undefined for non-existent extmark", async () => {
      await setup()

      const retrieved = extmarks.getMetadataFor(999)
      expect(retrieved).toBeUndefined()
    })

    it("should handle different metadata types", async () => {
      await setup()

      const id1 = extmarks.create({
        start: 0,
        end: 5,
        metadata: { type: "object", value: 42 },
      })

      const id2 = extmarks.create({
        start: 6,
        end: 11,
        metadata: "string metadata",
      })

      const id3 = extmarks.create({
        start: 12,
        end: 15,
        metadata: 123,
      })

      const id4 = extmarks.create({
        start: 16,
        end: 20,
        metadata: true,
      })

      const id5 = extmarks.create({
        start: 21,
        end: 25,
        metadata: ["array", "metadata"],
      })

      expect(extmarks.getMetadataFor(id1)).toEqual({ type: "object", value: 42 })
      expect(extmarks.getMetadataFor(id2)).toBe("string metadata")
      expect(extmarks.getMetadataFor(id3)).toBe(123)
      expect(extmarks.getMetadataFor(id4)).toBe(true)
      expect(extmarks.getMetadataFor(id5)).toEqual(["array", "metadata"])
    })

    it("should handle null metadata", async () => {
      await setup()

      const id = extmarks.create({
        start: 0,
        end: 5,
        metadata: null,
      })

      const retrieved = extmarks.getMetadataFor(id)
      expect(retrieved).toBeNull()
    })

    it("should preserve metadata when extmark is adjusted", async () => {
      await setup("Hello World")

      const metadata = { label: "important" }
      const id = extmarks.create({
        start: 6,
        end: 11,
        metadata,
      })

      textarea.focus()
      textarea.cursorOffset = 0
      currentMockInput.pressKey("X")
      currentMockInput.pressKey("X")

      const extmark = extmarks.get(id)
      expect(extmark?.start).toBe(8)
      expect(extmark?.end).toBe(13)

      const retrieved = extmarks.getMetadataFor(id)
      expect(retrieved).toEqual(metadata)
    })

    it("should remove metadata when extmark is deleted", async () => {
      await setup()

      const metadata = { data: "test" }
      const id = extmarks.create({
        start: 0,
        end: 5,
        metadata,
      })

      expect(extmarks.getMetadataFor(id)).toEqual(metadata)

      extmarks.delete(id)

      expect(extmarks.getMetadataFor(id)).toBeUndefined()
    })

    it("should clear all metadata when clear is called", async () => {
      await setup()

      const id1 = extmarks.create({
        start: 0,
        end: 5,
        metadata: { key: "value1" },
      })

      const id2 = extmarks.create({
        start: 6,
        end: 11,
        metadata: { key: "value2" },
      })

      extmarks.clear()

      expect(extmarks.getMetadataFor(id1)).toBeUndefined()
      expect(extmarks.getMetadataFor(id2)).toBeUndefined()
    })

    it("should remove metadata when virtual extmark is deleted via backspace", async () => {
      await setup("abc[LINK]def")

      textarea.focus()
      textarea.cursorOffset = 9

      const metadata = { url: "https://test.com" }
      const id = extmarks.create({
        start: 3,
        end: 9,
        virtual: true,
        metadata,
      })

      expect(extmarks.getMetadataFor(id)).toEqual(metadata)

      currentMockInput.pressBackspace()

      expect(extmarks.get(id)).toBeNull()
      expect(extmarks.getMetadataFor(id)).toBeUndefined()
    })

    it("should handle metadata with nested objects", async () => {
      await setup()

      const metadata = {
        user: {
          id: 123,
          name: "John Doe",
          settings: {
            theme: "dark",
            notifications: true,
          },
        },
        timestamp: Date.now(),
      }

      const id = extmarks.create({
        start: 0,
        end: 5,
        metadata,
      })

      const retrieved = extmarks.getMetadataFor(id)
      expect(retrieved).toEqual(metadata)
    })

    it("should store independent metadata for multiple extmarks", async () => {
      await setup()

      const id1 = extmarks.create({
        start: 0,
        end: 5,
        metadata: { id: 1, color: "red" },
      })

      const id2 = extmarks.create({
        start: 6,
        end: 11,
        metadata: { id: 2, color: "blue" },
      })

      const id3 = extmarks.create({
        start: 12,
        end: 15,
        metadata: { id: 3, color: "green" },
      })

      expect(extmarks.getMetadataFor(id1)).toEqual({ id: 1, color: "red" })
      expect(extmarks.getMetadataFor(id2)).toEqual({ id: 2, color: "blue" })
      expect(extmarks.getMetadataFor(id3)).toEqual({ id: 3, color: "green" })
    })

    it("should handle metadata with both metadata and data fields", async () => {
      await setup()

      const data = { oldField: "data" }
      const metadata = { newField: "metadata" }

      const id = extmarks.create({
        start: 0,
        end: 5,
        data,
        metadata,
      })

      const extmark = extmarks.get(id)
      expect(extmark?.data).toEqual(data)
      expect(extmarks.getMetadataFor(id)).toEqual(metadata)
    })

    it("should return undefined when getting metadata on destroyed controller", async () => {
      await setup()

      const id = extmarks.create({
        start: 0,
        end: 5,
        metadata: { test: "data" },
      })

      extmarks.destroy()

      expect(extmarks.getMetadataFor(id)).toBeUndefined()
    })

    it("should handle metadata with special values", async () => {
      await setup()

      const id1 = extmarks.create({
        start: 0,
        end: 5,
        metadata: undefined,
      })

      const id2 = extmarks.create({
        start: 6,
        end: 11,
        metadata: 0,
      })

      const id3 = extmarks.create({
        start: 12,
        end: 15,
        metadata: "",
      })

      const id4 = extmarks.create({
        start: 16,
        end: 20,
        metadata: false,
      })

      expect(extmarks.getMetadataFor(id1)).toBeUndefined()
      expect(extmarks.getMetadataFor(id2)).toBe(0)
      expect(extmarks.getMetadataFor(id3)).toBe("")
      expect(extmarks.getMetadataFor(id4)).toBe(false)
    })

    it("should handle metadata for extmarks with same range", async () => {
      await setup()

      const id1 = extmarks.create({
        start: 0,
        end: 5,
        metadata: { layer: 1 },
      })

      const id2 = extmarks.create({
        start: 0,
        end: 5,
        metadata: { layer: 2 },
      })

      expect(extmarks.getMetadataFor(id1)).toEqual({ layer: 1 })
      expect(extmarks.getMetadataFor(id2)).toEqual({ layer: 2 })
    })

    it("should preserve metadata through text insertion", async () => {
      await setup("Hello World")

      const metadata = { type: "highlight", priority: 10 }
      const id = extmarks.create({
        start: 0,
        end: 5,
        metadata,
      })

      textarea.focus()
      textarea.cursorOffset = 2
      currentMockInput.pressKey("Z")

      expect(extmarks.getMetadataFor(id)).toEqual(metadata)
    })

    it("should preserve metadata through text deletion", async () => {
      await setup("XXHello World")

      const metadata = { category: "text" }
      const id = extmarks.create({
        start: 8,
        end: 13,
        metadata,
      })

      textarea.focus()
      textarea.cursorOffset = 2
      currentMockInput.pressBackspace()
      currentMockInput.pressBackspace()

      expect(extmarks.getMetadataFor(id)).toEqual(metadata)
    })

    it("should remove metadata when extmark range is deleted", async () => {
      await setup("Hello World")

      const metadata = { info: "will be deleted" }
      const id = extmarks.create({
        start: 6,
        end: 11,
        metadata,
      })

      textarea.deleteRange(0, 6, 0, 11)

      expect(extmarks.get(id)).toBeNull()
      expect(extmarks.getMetadataFor(id)).toBeUndefined()
    })

    it("should handle metadata for virtual extmarks", async () => {
      await setup("abcdefgh")

      const metadata = { virtual: true, link: "https://example.com" }
      const id = extmarks.create({
        start: 3,
        end: 6,
        virtual: true,
        metadata,
      })

      expect(extmarks.getMetadataFor(id)).toEqual(metadata)

      textarea.focus()
      textarea.cursorOffset = 2
      currentMockInput.pressArrow("right")

      expect(textarea.cursorOffset).toBe(6)
      expect(extmarks.getMetadataFor(id)).toEqual(metadata)
    })

    it("should handle large metadata objects", async () => {
      await setup()

      const largeMetadata = {
        items: Array.from({ length: 1000 }, (_, i) => ({ id: i, value: `item-${i}` })),
        description: "A".repeat(10000),
      }

      const id = extmarks.create({
        start: 0,
        end: 5,
        metadata: largeMetadata,
      })

      const retrieved = extmarks.getMetadataFor(id)
      expect(retrieved).toEqual(largeMetadata)
      expect(retrieved.items.length).toBe(1000)
      expect(retrieved.description.length).toBe(10000)
    })

    it("should handle metadata with functions", async () => {
      await setup()

      const metadata = {
        onClick: () => "clicked",
        onHover: (x: number) => x * 2,
      }

      const id = extmarks.create({
        start: 0,
        end: 5,
        metadata,
      })

      const retrieved = extmarks.getMetadataFor(id)
      expect(typeof retrieved.onClick).toBe("function")
      expect(typeof retrieved.onHover).toBe("function")
      expect(retrieved.onClick()).toBe("clicked")
      expect(retrieved.onHover(5)).toBe(10)
    })

    it("should store metadata by reference", async () => {
      await setup()

      const original = { value: 1, nested: { count: 0 } }
      const id = extmarks.create({
        start: 0,
        end: 5,
        metadata: original,
      })

      const retrieved = extmarks.getMetadataFor(id)
      retrieved.value = 999
      retrieved.nested.count = 100

      expect(original.value).toBe(999)
      expect(original.nested.count).toBe(100)
      expect(extmarks.getMetadataFor(id).value).toBe(999)
    })

    it("should handle metadata for extmarks with typeId", async () => {
      await setup()

      const linkTypeId = extmarks.registerType("link")

      const id1 = extmarks.create({
        start: 0,
        end: 5,
        typeId: linkTypeId,
        metadata: { url: "https://first.com" },
      })

      const id2 = extmarks.create({
        start: 6,
        end: 11,
        typeId: linkTypeId,
        metadata: { url: "https://second.com" },
      })

      expect(extmarks.getMetadataFor(id1)).toEqual({ url: "https://first.com" })
      expect(extmarks.getMetadataFor(id2)).toEqual({ url: "https://second.com" })

      const links = extmarks.getAllForTypeId(linkTypeId)
      expect(links.length).toBe(2)

      for (const link of links) {
        const meta = extmarks.getMetadataFor(link.id)
        expect(meta).toHaveProperty("url")
        expect(meta.url).toMatch(/^https:\/\//)
      }
    })

    it("should preserve metadata after setText clears extmarks", async () => {
      await setup("Hello World")

      const id = extmarks.create({
        start: 0,
        end: 5,
        metadata: { persisted: false },
      })

      textarea.setText("New Text")

      expect(extmarks.get(id)).toBeNull()
      expect(extmarks.getMetadataFor(id)).toBeUndefined()
    })
  })
})
