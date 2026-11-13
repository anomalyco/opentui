import { describe, expect, it, afterEach } from "bun:test"

import { TextareaRenderable } from "../renderables/Textarea.js"
import { createTestRenderer, type TestRenderer, type MockInput } from "../testing/test-renderer.js"
import { type ExtmarksController } from "./extmarks.js"
import { SyntaxStyle } from "../syntax-style.js"
import { stringWidth } from "../platform/runtime.js"
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

describe("ExtmarksController - Multi-width Graphemes", () => {
  afterEach(() => {
    if (extmarks) extmarks.destroy()
    if (currentRenderer) currentRenderer.destroy()
  })

  describe("Basic Multi-width Highlighting", () => {
    it("should correctly highlight text AFTER multi-width characters", async () => {
      // Text: "前后端分离 @git-committer"
      // Chinese chars are multi-width, @ onwards should highlight correctly
      await setup("前后端分离 @git-committer")

      const style = SyntaxStyle.create(currentRenderer.nativeScene)
      const styleId = style.registerStyle("mention", {
        fg: RGBA.fromValues(0, 0, 1, 1),
        bg: RGBA.fromValues(0.9, 0.9, 1, 1),
      })

      textarea.syntaxStyle = style

      const text = textarea.plainText

      // Calculate CORRECT display-width offsets
      // "前" = 2 cols, "后" = 2 cols, "端" = 2 cols, "分" = 2 cols, "离" = 2 cols, " " = 1 col
      // Total before "@": 10 + 1 = 11 display-width columns
      let displayOffset = 0
      const atJsIndex = text.indexOf("@")
      for (let i = 0; i < atJsIndex; i++) {
        if (text[i] === "\n") {
          displayOffset += 1
        } else {
          displayOffset += stringWidth(text[i])
        }
      }

      const mentionText = "@git-committer"
      const mentionDisplayWidth = stringWidth(mentionText)
      const mentionStart = displayOffset // Should be 11
      const mentionEnd = displayOffset + mentionDisplayWidth // Should be 25

      extmarks.create({
        start: mentionStart,
        end: mentionEnd,
        styleId,
      })

      const highlights = textarea.getLineHighlights(0)
      expect(highlights.length).toBe(1)
      expect(highlights[0].start).toBe(11)
      expect(highlights[0].end).toBe(25)
    })

    // A tab or control takes cells that a string width does not count. A highlight that ends at the end of the first
    // line must stay on that line. An end past the text covers the rest of it.
    it.each<[string, number, number, number[][][]]>([
      ["a\tb\ncd", 0, 4, [[[0, 4]], []]],
      ["a\fb\ncd", 0, 4, [[[0, 4]], []]],
      ["a\u0085b\ncd", 0, 6, [[[0, 6]], []]],
      ["a\fb\ncd", 3, 100, [[[3, 4]], [[0, 2]]]],
    ])("highlights %j from %d to %d", async (text, start, end, expected) => {
      await setup(text)
      const style = SyntaxStyle.create(currentRenderer.nativeScene)
      textarea.syntaxStyle = style
      extmarks.create({ start, end, styleId: style.registerStyle("test", { fg: RGBA.fromValues(1, 0, 0, 1) }) })
      const lines = [0, 1].map((line) =>
        textarea.getLineHighlights(line).map((highlight) => [highlight.start, highlight.end]),
      )
      expect(lines).toEqual(expected)
    })

    // Offsets and highlight columns count cells, so they match around wide text. Marks rest on cursor stops: an
    // offset inside a wide character moves to its start.
    it.each<[string, number, number, number[]]>([
      ["hello 前后端分离", 0, 5, [0, 5]],
      ["前后 test 端分离", 5, 9, [5, 9]],
      ["hello 前后端分离 world", 6, 16, [6, 16]],
      ["前后 🌟 test", 8, 12, [8, 12]],
      ["前后 test 端分离", 3, 11, [2, 10]],
    ])("highlights %j from %d to %d", async (text, start, end, [column, endColumn]) => {
      await setup(text)
      const style = SyntaxStyle.create(currentRenderer.nativeScene)
      textarea.syntaxStyle = style
      const styleId = style.registerStyle("test", { fg: RGBA.fromValues(1, 0, 0, 1) })
      const id = extmarks.create({ start, end, styleId })
      expect(textarea.getLineHighlights(0)).toMatchObject([{ start: column, end: endColumn }])
      expect(extmarks.get(id)).toMatchObject({ start: column, end: endColumn, styleId })
    })
  })

  describe("Complex Multi-width Scenarios", () => {
    it("should handle multiple highlights with multi-width characters", async () => {
      await setup("前后端 @user1 分离 @user2 end")

      const style = SyntaxStyle.create(currentRenderer.nativeScene)
      const styleId = style.registerStyle("mention", {
        fg: RGBA.fromValues(0, 0, 1, 1),
      })

      textarea.syntaxStyle = style

      const text = textarea.plainText

      const user1Start = text.indexOf("@user1")
      const user1End = user1Start + 6
      const user2Start = text.indexOf("@user2")
      const user2End = user2Start + 6

      extmarks.create({
        start: user1Start,
        end: user1End,
        styleId,
      })

      extmarks.create({
        start: user2Start,
        end: user2End,
        styleId,
      })

      const highlights = textarea.getLineHighlights(0)

      highlights.forEach((h, i) => {
        const lineText = textarea.plainText.split("\n")[0]
        const highlightedText = lineText.substring(h.start, h.end)
      })

      expect(highlights.length).toBe(2)
    })
  })

  describe("Cursor Movement with Multi-width Characters", () => {
    it("should correctly position cursor after multi-width characters", async () => {
      await setup("前后 test")

      textarea.focus()
      textarea.cursorOffset = 0

      // Text: "前后 test"
      // "前" = display width 2, "后" = display width 2, " " = display width 1
      // After 3 arrow right presses from position 0:
      //   Press 1: move to display-width 2 (after "前")
      //   Press 2: move to display-width 4 (after "后")
      //   Press 3: move to display-width 5 (after " ")

      for (let i = 0; i < 3; i++) {
        currentMockInput.pressArrow("right")
      }

      const cursorPos = textarea.cursorOffset

      // Cursor should be at display-width offset 5 (after "前后 ")
      expect(cursorPos).toBe(5)
    })

    // Wide text takes more cells than string units, so the end of the buffer is past the string length.
    it.each(["\u0085\u0085\u0085", "日日日日"])("skips a virtual extmark at the end after %j", async (prefix) => {
      await setup(`${prefix}@ab`)
      textarea.focus()
      const end = textarea.editBuffer.getEOL().offset
      extmarks.create({ start: end - 3, end, virtual: true })
      textarea.cursorOffset = end - 3
      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(end)
      currentMockInput.pressArrow("right")
      expect(textarea.cursorOffset).toBe(end)
    })

    // Left or a word left from a virtual extmark's end, and Up or Down into it nearer its start, go to the start of
    // the character before it, not into the second cell of a wide one; with none, to the end of the line above.
    // Halfway or nearer the end goes to the end.
    for (const char of ["a", "日", "👍", "\t", ""]) {
      for (const [move, row, col, to] of [
        ["left", 1, 8, 0],
        ["word", 1, 8, 0],
        ["down", 0, 1, 0],
        ["up", 2, 1, 0],
        ["down", 0, 4, 8],
        ["down", 0, 6, 8],
      ] as const) {
        it(`${move} from column ${col} into a virtual extmark after ${JSON.stringify(char)}`, async () => {
          await setup(`0123456789\n${char}@main.rs\nxxxxxxxxxx`)
          const width = textarea.editBuffer.measureText(char)
          extmarks.create({ start: 11 + width, end: 19 + width, virtual: true })
          textarea.focus()
          textarea.editBuffer.setCursor(row, width + col)
          if (move === "word") textarea.moveWordBackward()
          else currentMockInput.pressArrow(move)
          expect(textarea.editBuffer.getCursorPosition().offset).toBe(to ? 11 + width + to : width ? 11 : 10)
        })
      }
    }

    // In 6 columns the mark 2..15 wraps under `日`. Down from 0 lands in it nearer its start, and before it is where
    // Down started, so it goes to the end: past a second mark that overlaps that end, not past one that starts there.
    for (const [second, to] of [
      [null, 15],
      [{ start: 14, end: 19 }, 19],
      [{ start: 15, end: 17 }, 15],
    ] as const) {
      it(`Down from before a wrapped virtual extmark goes to ${to} with ${JSON.stringify(second)}`, async () => {
        await setup("日@mainrsxyzuvwABCDEFGH")
        textarea.width = 6
        await renderOnce()
        extmarks.create({ start: 2, end: 15, virtual: true })
        if (second) extmarks.create({ ...second, virtual: true })
        textarea.focus()
        textarea.editBuffer.setCursor(0, 0)
        currentMockInput.pressArrow("down")
        expect(textarea.editBuffer.getCursorPosition().offset).toBe(to)
      })
    }

    // Up from the end of the wrapped mark lands nearer its end, which is where Up started: it goes before the mark.
    it("Up from the end of a wrapped virtual extmark leaves it by its start", async () => {
      await setup("日@mainrsxyzuvwABCDEFGH")
      textarea.width = 6
      await renderOnce()
      extmarks.create({ start: 2, end: 15, virtual: true })
      textarea.focus()
      textarea.editBuffer.setCursorByOffset(15)
      currentMockInput.pressArrow("up")
      expect(textarea.editBuffer.getCursorPosition().offset).toBe(0)
    })

    // A selection skips the mark logic: the second Shift+Down or Shift+Up, which extends one, stops inside the mark.
    for (const [key, from] of [
      ["down", 3],
      ["up", 26],
    ] as const) {
      it(`Shift+${key} twice from ${from} extends the selection into a virtual extmark`, async () => {
        await setup("0123\nabcd\n日@file\nwxyz\n0123")
        extmarks.create({ start: 12, end: 17, virtual: true })
        textarea.focus()
        textarea.editBuffer.setCursorByOffset(from)
        currentMockInput.pressArrow(key, { shift: true })
        currentMockInput.pressArrow(key, { shift: true })
        expect(textarea.editBuffer.getCursorPosition()).toMatchObject({ row: 2, col: 3 })
      })
    }
  })

  describe("Visual vs Byte Offset Issues", () => {
    it("should demonstrate the offset to char offset conversion issue", async () => {
      // This is the CRITICAL test - offsetToCharOffset doesn't account for display width
      await setup("前后端分离 @git-committer")

      const style = SyntaxStyle.create(currentRenderer.nativeScene)
      const styleId = style.registerStyle("mention", {
        fg: RGBA.fromValues(0, 0, 1, 1),
        bg: RGBA.fromValues(0.9, 0.9, 1, 1),
      })

      textarea.syntaxStyle = style

      const text = textarea.plainText

      // The @ symbol is at cursor offset 6
      const atPos = text.indexOf("@")

      // We want to highlight from @ to the end of "committer"
      const start = atPos
      const end = atPos + 14 // "@git-committer" is 14 chars

      const extmarkId = extmarks.create({
        start: start,
        end: end,
        styleId,
      })

      const extmark = extmarks.get(extmarkId)

      const highlights = textarea.getLineHighlights(0)

      if (highlights.length > 0) {
        const h = highlights[0]

        // This is where the bug manifests:
        // The offsetToCharOffset in extmarks.ts doesn't account for multi-width display
        // So the highlight char offset will be wrong

        const lineText = text.split("\n")[0]

        // Try to extract what's actually highlighted using the char offsets
        const actualText = lineText.substring(h.start, Math.min(h.end, lineText.length))

        // This will likely FAIL because the char offsets don't account for display width
      }

      expect(highlights.length).toBe(1)
    })
  })

  describe("Edits that rejoin a grapheme", () => {
    // Deleting `x` joins U+1F44B and U+1F3FB into one 2-cell grapheme, so `Z` moves 3 cells, not 1. Typing ZWJ
    // joins U+1F468 and U+1F469 into one 2-cell grapheme, so `Z` moves 2 cells left. The cursor ends after the
    // joined grapheme, and each edit publishes one cursor change.
    const wave = ["\u{1f44b}x\u{1f3fb}Z", "\u{1f44b}\u{1f3fb}Z", 5] as const
    const family = ["\u{1f468}\u{1f469}Z", "\u{1f468}\u200d\u{1f469}Z", 4] as const
    const view = () => textarea.editorView
    for (const [name, [before, after, markStart], cursor, edit] of [
      ["Delete", wave, 2, () => textarea.editBuffer.deleteChar()],
      ["Backspace", wave, 3, () => textarea.editBuffer.deleteCharBackward()],
      ["deleteRange", wave, 2, () => textarea.editBuffer.deleteRange(0, 2, 0, 3)],
      ["deleteSelectedText", wave, 2, () => (view().setSelection(2, 3), view().deleteSelectedText())],
      ["replaceSelectedText", wave, 2, () => (view().setSelection(2, 3), view()._replaceSelectedText(""))],
      ["insertChar", family, 2, () => textarea.editBuffer.insertChar("\u200d")],
      ["insertText", family, 2, () => textarea.editBuffer.insertText("\u200d")],
    ] as const) {
      it(`${name} shifts the marks after it by the change in width`, async () => {
        await setup(before)
        const id = extmarks.create({ start: markStart, end: markStart + 1 })
        textarea.editBuffer.setCursor(0, cursor)
        await Promise.resolve()
        let cursorEvents = 0
        textarea.editBuffer.on("cursor-changed", () => cursorEvents++)
        edit()
        await Promise.resolve()
        expect(textarea.plainText).toBe(after)
        expect(extmarks.get(id)).toMatchObject({ start: 2, end: 3 })
        expect(textarea.editBuffer.getCursorPosition().offset).toBe(2)
        expect(cursorEvents).toBe(1)
      })
    }

    // A pasted joiner moves the virtual mark's start across the cursor: the paste leaves the cursor outside the mark,
    // so the next character keeps it.
    it("a pasted joiner leaves the cursor outside the virtual extmark it joins", async () => {
      await setup("\u{1f468}\u{1f469}abc")
      textarea.focus()
      textarea.cursorOffset = 2
      const id = extmarks.create({ start: 2, end: 7, virtual: true })
      await currentMockInput.pasteBracketedText("‍")
      expect([textarea.cursorOffset, extmarks.get(id)]).toMatchObject([0, { start: 0, end: 5 }])
      await currentMockInput.typeText("x")
      expect(extmarks.get(id)).toMatchObject({ start: 1, end: 6 })
    })

    // Backspace over `x` joins the flag and leaves the cursor after it, past where the deletion started.
    it("Backspace that joins a flag removes the mark on the character it deletes", async () => {
      await setup("\n\u{1f1fa}x\u{1f1f8}z")
      const id = extmarks.create({ start: 2, end: 3 })
      textarea.editBuffer.setCursor(1, 2)
      textarea.editBuffer.deleteCharBackward()
      expect(textarea.plainText).toBe("\n\u{1f1fa}\u{1f1f8}z")
      expect(extmarks.get(id)).toBeNull()
    })

    // Deleting the line break joins U+263A and U+FE0F into one 2-cell grapheme, so `Y` keeps its offset. A mark at 2
    // would start at the zero-width U+FE0F, which joins the grapheme before it.
    it("Delete before a widening join keeps the marks after it", async () => {
      await setup("\u263a\n\ufe0fZY")
      const id = extmarks.create({ start: 3, end: 4 })
      textarea.editBuffer.setCursor(0, 1)
      textarea.editBuffer.deleteChar()
      expect(textarea.plainText).toBe("\u263a\ufe0fZY")
      expect(extmarks.get(id)).toMatchObject({ start: 3, end: 4 })
    })
  })
})
