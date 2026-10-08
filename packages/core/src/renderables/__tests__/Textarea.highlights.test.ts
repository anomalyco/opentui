import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockMouse, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"
import { OptimizedBuffer } from "../../buffer.js"
import { SyntaxStyle } from "../../syntax-style.js"
import { RGBA } from "../../lib/index.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput

describe("Textarea - Syntax Highlighting Tests", () => {
  beforeEach(async () => {
    ;({
      renderer: currentRenderer,
      renderOnce,
      mockInput: currentMockInput,
    } = await createTestRenderer({
      width: 80,
      height: 24,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  describe("Syntax Highlighting", () => {
    describe("SyntaxStyle Management", () => {
      it("should set syntax style via constructor option", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("keyword", {
          fg: RGBA.fromValues(0, 1, 0, 1),
          bold: true,
        })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "const x = 5",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        expect(editor.syntaxStyle).toBe(style)
      })

      it("should set syntax style via setter", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "test",
          width: 40,
          height: 10,
        })

        expect(editor.syntaxStyle).toBe(null)

        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        editor.syntaxStyle = style

        expect(editor.syntaxStyle).toBe(style)
      })

      it("should clear syntax style when set to null", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "test",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        expect(editor.syntaxStyle).toBe(style)

        editor.syntaxStyle = null

        expect(editor.syntaxStyle).toBe(null)
      })
    })

    describe("Highlight Management", () => {
      it("should add highlight by line and column range", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("highlight", {
          fg: RGBA.fromValues(1, 0, 0, 1),
        })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Hello World",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 5, styleId: styleId, priority: 0 })

        const highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(1)
        expect(highlights[0].start).toBe(0)
        expect(highlights[0].end).toBe(5)
        expect(highlights[0].styleId).toBe(styleId)
        expect(highlights[0].priority).toBe(0)
        expect(highlights[0].hlRef).toBe(0)
      })

      it("should add multiple highlights to same line", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const keywordId = style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
        const stringId = style.registerStyle("string", { fg: RGBA.fromValues(0, 1, 0, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "const name = 'value'",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 5, styleId: keywordId, priority: 0 }) // "const"
        editor.addHighlight(0, { start: 13, end: 20, styleId: stringId, priority: 0 }) // "'value'"

        const highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(2)
        expect(highlights[0].start).toBe(0)
        expect(highlights[0].end).toBe(5)
        expect(highlights[0].styleId).toBe(keywordId)
        expect(highlights[1].start).toBe(13)
        expect(highlights[1].end).toBe(20)
        expect(highlights[1].styleId).toBe(stringId)
      })

      it("should add highlight by character range", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("highlight", {
          fg: RGBA.fromValues(1, 1, 0, 1),
        })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 1\nLine 2\nLine 3",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        // Highlight from "ine 2" to "ine 3" (char offset 7-13, newlines not counted)
        // Char positions (excluding newlines): "Line 1" = 0-5, "Line 2" = 6-11, "Line 3" = 12-17
        // Char 7 = "i" in "Line 2" (col 1), Char 13 = "i" in "Line 3" (col 1)
        editor.addHighlightByCharRange({ start: 7, end: 13, styleId: styleId, priority: 0 })

        const highlights = editor.getLineHighlights(1)
        expect(highlights.length).toBe(1)
        expect(highlights[0].start).toBe(1) // Second character "i" in "Line 2"
        expect(highlights[0].end).toBe(6) // End of "Line 2"
        expect(highlights[0].styleId).toBe(styleId)
      })

      it("should add highlight with custom priority", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const lowPriorityId = style.registerStyle("low", { fg: RGBA.fromValues(0.5, 0.5, 0.5, 1) })
        const highPriorityId = style.registerStyle("high", { fg: RGBA.fromValues(1, 0, 0, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "overlapping",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 10, styleId: lowPriorityId, priority: 1 })
        editor.addHighlight(0, { start: 3, end: 8, styleId: highPriorityId, priority: 10 })

        const highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(2)
        expect(highlights[0].priority).toBe(1)
        expect(highlights[1].priority).toBe(10)
      })

      it("should add highlight with reference ID", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("ref-highlight", {
          fg: RGBA.fromValues(0, 0, 1, 1),
        })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "test content",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        const refId = 42
        editor.addHighlight(0, { start: 0, end: 4, styleId: styleId, priority: 0, hlRef: refId })

        const highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(1)
        expect(highlights[0].hlRef).toBe(refId)
      })

      it("should remove highlights by reference ID", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId1 = style.registerStyle("style1", { fg: RGBA.fromValues(1, 0, 0, 1) })
        const styleId2 = style.registerStyle("style2", { fg: RGBA.fromValues(0, 1, 0, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "test content here",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 4, styleId: styleId1, priority: 0, hlRef: 1 })
        editor.addHighlight(0, { start: 5, end: 12, styleId: styleId2, priority: 0, hlRef: 2 })
        editor.addHighlight(0, { start: 13, end: 17, styleId: styleId1, priority: 0, hlRef: 1 })

        let highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(3)

        editor.removeHighlightsByRef(1)

        highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(1)
        expect(highlights[0].start).toBe(5)
        expect(highlights[0].hlRef).toBe(2)
      })

      it("should clear highlights for specific line", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("style", { fg: RGBA.fromValues(1, 1, 1, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 1\nLine 2\nLine 3",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 6, styleId: styleId, priority: 0 })
        editor.addHighlight(1, { start: 0, end: 6, styleId: styleId, priority: 0 })
        editor.addHighlight(2, { start: 0, end: 6, styleId: styleId, priority: 0 })

        expect(editor.getLineHighlights(0).length).toBe(1)
        expect(editor.getLineHighlights(1).length).toBe(1)
        expect(editor.getLineHighlights(2).length).toBe(1)

        editor.clearLineHighlights(1)

        expect(editor.getLineHighlights(0).length).toBe(1)
        expect(editor.getLineHighlights(1).length).toBe(0)
        expect(editor.getLineHighlights(2).length).toBe(1)
      })

      it("should clear all highlights", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("style", { fg: RGBA.fromValues(1, 1, 1, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 1\nLine 2\nLine 3",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 6, styleId: styleId, priority: 0 })
        editor.addHighlight(1, { start: 0, end: 6, styleId: styleId, priority: 0 })
        editor.addHighlight(2, { start: 0, end: 6, styleId: styleId, priority: 0 })

        expect(editor.getLineHighlights(0).length).toBe(1)
        expect(editor.getLineHighlights(1).length).toBe(1)
        expect(editor.getLineHighlights(2).length).toBe(1)

        editor.clearAllHighlights()

        expect(editor.getLineHighlights(0).length).toBe(0)
        expect(editor.getLineHighlights(1).length).toBe(0)
        expect(editor.getLineHighlights(2).length).toBe(0)
      })

      it("should return empty array for line with no highlights", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 1\nLine 2",
          width: 40,
          height: 10,
        })

        const highlights = editor.getLineHighlights(0)
        expect(highlights).toEqual([])
      })

      it("should return empty array for line index out of bounds", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Single line",
          width: 40,
          height: 10,
        })

        const highlights = editor.getLineHighlights(999)
        expect(highlights).toEqual([])
      })

      it("should handle highlights spanning multiple lines via character range", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("multiline", {
          bg: RGBA.fromValues(0.2, 0.2, 0.2, 1),
        })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "AAAA\nBBBB\nCCCC",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        // Highlight from middle of line 0 to all of line 2 (chars 2-12, newlines not counted)
        // Char positions (excluding newlines): "AAAA" = 0-3, "BBBB" = 4-7, "CCCC" = 8-11
        // Char 2 = third "A", Char 12 = one past end
        editor.addHighlightByCharRange({ start: 2, end: 12, styleId: styleId, priority: 0 })

        const hl0 = editor.getLineHighlights(0)
        const hl1 = editor.getLineHighlights(1)
        const hl2 = editor.getLineHighlights(2)

        expect(hl0.length).toBe(1)
        expect(hl0[0].start).toBe(2)
        expect(hl0[0].end).toBe(4)

        expect(hl1.length).toBe(1)
        expect(hl1[0].start).toBe(0)
        expect(hl1[0].end).toBe(4)

        expect(hl2.length).toBe(1)
        expect(hl2[0].start).toBe(0)
        expect(hl2[0].end).toBe(4) // All of "CCCC"
      })

      it("should preserve highlights after text editing when using hlRef", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("persistent", {
          fg: RGBA.fromValues(1, 0, 1, 1),
        })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Hello World",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 5, styleId: styleId, priority: 0, hlRef: 100 })

        let highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(1)
        expect(highlights[0].hlRef).toBe(100)

        // Edit text
        editor.focus()
        editor.gotoLine(9999)
        currentMockInput.pressKey("!")

        // Highlight should still exist (this is line-based, not offset-based)
        highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(1)
        expect(highlights[0].hlRef).toBe(100)
      })

      it("should handle multiple highlights with different priorities", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const baseId = style.registerStyle("base", { fg: RGBA.fromValues(0.5, 0.5, 0.5, 1) })
        const mediumId = style.registerStyle("medium", { fg: RGBA.fromValues(0, 1, 0, 1) })
        const highId = style.registerStyle("high", { fg: RGBA.fromValues(1, 0, 0, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "overlapping text",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 15, styleId: baseId, priority: 0 })
        editor.addHighlight(0, { start: 3, end: 12, styleId: mediumId, priority: 5 })
        editor.addHighlight(0, { start: 6, end: 9, styleId: highId, priority: 10 })

        const highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(3)

        const sorted = [...highlights].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
        expect(sorted[0].priority).toBe(0)
        expect(sorted[1].priority).toBe(5)
        expect(sorted[2].priority).toBe(10)
      })

      it("should clear highlights when removing by ref across multiple lines", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("temp", { bg: RGBA.fromValues(0.1, 0.1, 0.1, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 1\nLine 2\nLine 3",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        const refId = 555
        editor.addHighlight(0, { start: 0, end: 6, styleId: styleId, priority: 0, hlRef: refId })
        editor.addHighlight(1, { start: 0, end: 6, styleId: styleId, priority: 0, hlRef: refId })
        editor.addHighlight(2, { start: 0, end: 6, styleId: styleId, priority: 0, hlRef: 999 }) // Different ref

        expect(editor.getLineHighlights(0).length).toBe(1)
        expect(editor.getLineHighlights(1).length).toBe(1)
        expect(editor.getLineHighlights(2).length).toBe(1)

        editor.removeHighlightsByRef(refId)

        expect(editor.getLineHighlights(0).length).toBe(0)
        expect(editor.getLineHighlights(1).length).toBe(0)
        expect(editor.getLineHighlights(2).length).toBe(1)
        expect(editor.getLineHighlights(2)[0].hlRef).toBe(999)
      })

      it("should handle empty highlights without hlRef", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("no-ref", { fg: RGBA.fromValues(1, 1, 1, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "test",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 4, styleId: styleId, priority: 0 })

        const highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(1)
        expect(highlights[0].hlRef).toBe(0)
      })

      it("should work without syntax style set", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "test",
          width: 40,
          height: 10,
        })

        // Can still add highlights even without syntax style (just need style IDs)
        editor.addHighlight(0, { start: 0, end: 4, styleId: 999, priority: 0 })

        const highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(1)
        expect(highlights[0].styleId).toBe(999)
      })

      it("should handle char range spanning entire buffer", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("all", { bg: RGBA.fromValues(0.1, 0.1, 0.1, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "AAA\nBBB\nCCC",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        // Highlight entire content (0 to end)
        editor.addHighlightByCharRange({ start: 0, end: 11, styleId: styleId, priority: 0 })

        expect(editor.getLineHighlights(0).length).toBeGreaterThan(0)
        expect(editor.getLineHighlights(1).length).toBeGreaterThan(0)
        expect(editor.getLineHighlights(2).length).toBeGreaterThan(0)
      })

      it("should handle updating highlights after clearing specific line", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("test", { fg: RGBA.fromValues(1, 1, 0, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 1\nLine 2\nLine 3",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 6, styleId: styleId, priority: 0 })
        editor.addHighlight(1, { start: 0, end: 6, styleId: styleId, priority: 0 })
        editor.addHighlight(2, { start: 0, end: 6, styleId: styleId, priority: 0 })

        editor.clearLineHighlights(1)

        // Re-add highlight on line 1
        editor.addHighlight(1, { start: 2, end: 5, styleId: styleId, priority: 0 })

        const highlights = editor.getLineHighlights(1)
        expect(highlights.length).toBe(1)
        expect(highlights[0].start).toBe(2)
        expect(highlights[0].end).toBe(5)
      })

      it("should handle zero-width highlights (should be ignored)", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("zero", { fg: RGBA.fromValues(1, 0, 0, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "test",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        // Add zero-width highlight (start == end)
        editor.addHighlight(0, { start: 2, end: 2, styleId: styleId, priority: 0 })

        const highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(0) // Should be ignored
      })

      it("should handle multiple reference IDs independently", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("ref-style", { fg: RGBA.fromValues(1, 1, 1, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "test content for multiple refs",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 4, styleId: styleId, priority: 0, hlRef: 10 })
        editor.addHighlight(0, { start: 5, end: 12, styleId: styleId, priority: 0, hlRef: 20 })
        editor.addHighlight(0, { start: 13, end: 16, styleId: styleId, priority: 0, hlRef: 30 })

        let highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(3)

        editor.removeHighlightsByRef(20)

        highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(2)
        expect(highlights.filter((h) => h.hlRef === 10).length).toBe(1)
        expect(highlights.filter((h) => h.hlRef === 30).length).toBe(1)
      })
    })

    describe("Highlight Rendering Integration", () => {
      it("should render highlighted text without crashing", async () => {
        const buffer = OptimizedBuffer.create(80, 24, "wcwidth", {
          owner: currentRenderer.nativeScene,
        })

        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const styleId = style.registerStyle("keyword", {
          fg: RGBA.fromValues(1, 0, 0, 1),
          bold: true,
        })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "const x = 5",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 5, styleId: styleId, priority: 0 })

        // Should render without crashing
        buffer.drawEditorView(editor.editorView, 0, 0)

        expect(editor.getLineHighlights(0).length).toBe(1)
      })

      it("should handle highlights with overlapping ranges", async () => {
        const style = SyntaxStyle.create(currentRenderer.nativeScene)
        const style1 = style.registerStyle("style1", { fg: RGBA.fromValues(1, 0, 0, 1) })
        const style2 = style.registerStyle("style2", { fg: RGBA.fromValues(0, 1, 0, 1) })

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "overlapping",
          width: 40,
          height: 10,
          syntaxStyle: style,
        })

        editor.addHighlight(0, { start: 0, end: 8, styleId: style1, priority: 0 })
        editor.addHighlight(0, { start: 4, end: 11, styleId: style2, priority: 5 }) // Higher priority

        const highlights = editor.getLineHighlights(0)
        expect(highlights.length).toBe(2)

        const buffer = OptimizedBuffer.create(80, 24, "wcwidth", {
          owner: currentRenderer.nativeScene,
        })

        // Should render without crashing
        buffer.drawEditorView(editor.editorView, 0, 0)
      })
    })
  })
})
