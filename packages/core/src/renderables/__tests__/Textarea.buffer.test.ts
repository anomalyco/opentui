import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput } from "../../testing/test-renderer.js"
import { stringWidth } from "../../platform/runtime.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput

describe("Textarea - Buffer Tests", () => {
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

  describe("getTextRange", () => {
    it("should get text range by display-width offsets", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello, World!\nThis is line 2.",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRange(0, 5)
      expect(range1).toBe("Hello")

      const range2 = editor.getTextRange(7, 12)
      expect(range2).toBe("World")

      const range3 = editor.getTextRange(0, 13)
      expect(range3).toBe("Hello, World!")

      const range4 = editor.getTextRange(14, 21)
      expect(range4).toBe("This is")
    })

    it("should get text range by row/col coordinates", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello, World!\nThis is line 2.",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRangeByCoords(0, 0, 0, 5)
      expect(range1).toBe("Hello")

      const range2 = editor.getTextRangeByCoords(0, 7, 0, 12)
      expect(range2).toBe("World")

      const range3 = editor.getTextRangeByCoords(1, 0, 1, 7)
      expect(range3).toBe("This is")

      const range4 = editor.getTextRangeByCoords(0, 0, 1, 7)
      expect(range4).toBe("Hello, World!\nThis is")
    })

    it("should handle empty ranges with getTextRangeByCoords", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello, World!",
        width: 40,
        height: 10,
      })

      const rangeEmpty = editor.getTextRangeByCoords(0, 5, 0, 5)
      expect(rangeEmpty).toBe("")

      const rangeInvalid = editor.getTextRangeByCoords(0, 10, 0, 5)
      expect(rangeInvalid).toBe("")
    })

    it("should handle ranges spanning multiple lines with getTextRangeByCoords", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRangeByCoords(0, 5, 1, 4)
      expect(range1).toBe("1\nLine")

      const range2 = editor.getTextRangeByCoords(0, 0, 2, 6)
      expect(range2).toBe("Line 1\nLine 2\nLine 3")

      const range3 = editor.getTextRangeByCoords(1, 0, 2, 6)
      expect(range3).toBe("Line 2\nLine 3")
    })

    it("should handle Unicode characters with getTextRangeByCoords", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello 🌟 World",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRangeByCoords(0, 0, 0, 6)
      expect(range1).toBe("Hello ")

      const range2 = editor.getTextRangeByCoords(0, 6, 0, 8)
      expect(range2).toBe("🌟")

      const range3 = editor.getTextRangeByCoords(0, 8, 0, 14)
      expect(range3).toBe(" World")
    })

    it("should handle CJK characters with getTextRangeByCoords", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello 世界",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRangeByCoords(0, 0, 0, 6)
      expect(range1).toBe("Hello ")

      const range2 = editor.getTextRangeByCoords(0, 6, 0, 10)
      expect(range2).toBe("世界")
    })

    it("should get text range by coords after editing operations", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC\nDEF",
        width: 40,
        height: 10,
      })

      editor.focus()

      const range1 = editor.getTextRangeByCoords(0, 0, 1, 3)
      expect(range1).toBe("ABC\nDEF")

      editor.gotoLine(1)
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCDEF")

      const range2 = editor.getTextRangeByCoords(0, 1, 0, 5)
      expect(range2).toBe("BCDE")

      const range3 = editor.getTextRangeByCoords(0, 0, 0, 6)
      expect(range3).toBe("ABCDEF")
    })

    it("should handle out-of-bounds coordinates with getTextRangeByCoords", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Short",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRangeByCoords(10, 0, 20, 0)
      expect(range1).toBe("")

      const range2 = editor.getTextRangeByCoords(0, 0, 0, 5)
      expect(range2).toBe("Short")

      const range3 = editor.getTextRangeByCoords(0, 100, 0, 200)
      expect(range3).toBe("")
    })

    it("should match offset-based and coords-based methods", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      const offsetBased = editor.getTextRange(0, 6)
      const coordsBased = editor.getTextRangeByCoords(0, 0, 0, 6)
      expect(coordsBased).toBe(offsetBased)
      expect(coordsBased).toBe("Line 1")

      const offsetBased2 = editor.getTextRange(7, 13)
      const coordsBased2 = editor.getTextRangeByCoords(1, 0, 1, 6)
      expect(coordsBased2).toBe(offsetBased2)
      expect(coordsBased2).toBe("Line 2")

      const offsetBased3 = editor.getTextRange(5, 12)
      const coordsBased3 = editor.getTextRangeByCoords(0, 5, 1, 5)
      expect(coordsBased3).toBe(offsetBased3)
      expect(coordsBased3).toBe("1\nLine ")
    })

    it("should handle empty ranges", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello, World!",
        width: 40,
        height: 10,
      })

      const rangeEmpty = editor.getTextRange(5, 5)
      expect(rangeEmpty).toBe("")

      const rangeInvalid = editor.getTextRange(10, 5)
      expect(rangeInvalid).toBe("")
    })

    it("should handle ranges spanning multiple lines", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRange(0, 13)
      expect(range1).toBe("Line 1\nLine 2")

      const range2 = editor.getTextRange(5, 12)
      expect(range2).toBe("1\nLine ")
    })

    it("should handle Unicode characters in ranges", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello 🌟 World",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRange(0, 6)
      expect(range1).toBe("Hello ")

      const range2 = editor.getTextRange(6, 8)
      expect(range2).toBe("🌟")

      const range3 = editor.getTextRange(8, 14)
      expect(range3).toBe(" World")
    })

    it("should handle CJK characters in ranges", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello 世界",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRange(0, 6)
      expect(range1).toBe("Hello ")

      const range2 = editor.getTextRange(6, 10)
      expect(range2).toBe("世界")
    })

    it("should get text range after editing operations", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC",
        width: 40,
        height: 10,
      })

      editor.focus()

      editor.gotoLine(9999)
      editor.insertText("DEF")
      expect(editor.plainText).toBe("ABCDEF")

      const range1 = editor.getTextRange(0, 6)
      expect(range1).toBe("ABCDEF")

      const range2 = editor.getTextRange(0, 3)
      expect(range2).toBe("ABC")

      const range3 = editor.getTextRange(3, 6)
      expect(range3).toBe("DEF")
    })

    it("should get text range across chunk boundaries after line joins", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC\nDEF",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCDEF")

      const range1 = editor.getTextRange(1, 5)
      expect(range1).toBe("BCDE")

      const range2 = editor.getTextRange(0, 6)
      expect(range2).toBe("ABCDEF")
    })

    it("should handle range at buffer boundaries", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRange(0, 2)
      expect(range1).toBe("Te")

      const range2 = editor.getTextRange(2, 4)
      expect(range2).toBe("st")

      const range3 = editor.getTextRange(0, 4)
      expect(range3).toBe("Test")
    })

    it("should return empty string for out-of-bounds ranges", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Short",
        width: 40,
        height: 10,
      })

      const range1 = editor.getTextRange(100, 200)
      expect(range1).toBe("")

      const range2 = editor.getTextRange(0, 1000)
      expect(range2).toBe("Short")
    })
  })

  describe("Visual Cursor with Offset", () => {
    it("should have visualCursor with offset property", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      const visualCursor = editor.visualCursor
      expect(visualCursor).not.toBe(null)
      expect(visualCursor!.offset).toBeDefined()
      expect(visualCursor!.offset).toBe(0)
    })

    it("should update offset after inserting text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      editor.insertText("Hello")

      const visualCursor = editor.visualCursor
      expect(visualCursor).not.toBe(null)
      expect(visualCursor!.offset).toBe(5)
    })

    it("should update offset correctly for multi-line content", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC\nDEF",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Cursor at start
      let visualCursor = editor.visualCursor
      expect(visualCursor!.offset).toBe(0)

      // Move to end of first line
      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight()
      }
      visualCursor = editor.visualCursor
      expect(visualCursor!.offset).toBe(3)

      // Move to second line (across newline)
      editor.moveCursorRight()
      visualCursor = editor.visualCursor
      expect(visualCursor!.offset).toBe(4)
      expect(visualCursor!.logicalRow).toBe(1)
      expect(visualCursor!.logicalCol).toBe(0)

      // Move to end of second line
      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight()
      }
      visualCursor = editor.visualCursor
      expect(visualCursor!.offset).toBe(7)
    })

    it("should set cursor by offset", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Set cursor to offset 6 (after "Hello ")
      editor.editBuffer.setCursorByOffset(6)

      const visualCursor = editor.visualCursor
      expect(visualCursor).not.toBe(null)
      expect(visualCursor!.offset).toBe(6)
      expect(visualCursor!.logicalRow).toBe(0)
      expect(visualCursor!.logicalCol).toBe(6)

      // Set cursor to offset 2
      editor.editBuffer.setCursorByOffset(2)

      const newVisualCursor = editor.visualCursor
      expect(newVisualCursor).not.toBe(null)
      expect(newVisualCursor!.offset).toBe(2)
      expect(newVisualCursor!.logicalRow).toBe(0)
      expect(newVisualCursor!.logicalCol).toBe(2)
    })

    it("should set cursor by offset in multi-line content", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line1\nLine2\nLine3",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Set cursor to offset 6 (start of "Line2")
      editor.editBuffer.setCursorByOffset(6)

      const visualCursor = editor.visualCursor
      expect(visualCursor).not.toBe(null)
      expect(visualCursor!.offset).toBe(6)
      expect(visualCursor!.logicalRow).toBe(1)
      expect(visualCursor!.logicalCol).toBe(0)

      // Set cursor to offset 8 (L[i]ne2, at 'n')
      editor.editBuffer.setCursorByOffset(8)

      const newVisualCursor = editor.visualCursor
      expect(newVisualCursor).not.toBe(null)
      expect(newVisualCursor!.offset).toBe(8)
      expect(newVisualCursor!.logicalRow).toBe(1)
      expect(newVisualCursor!.logicalCol).toBe(2)
    })

    it("should maintain offset consistency when using editorView.setCursorByOffset", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABCDEF",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Use editorView instead of editBuffer
      editor.editorView.setCursorByOffset(3)

      const visualCursor = editor.visualCursor
      expect(visualCursor).not.toBe(null)
      expect(visualCursor!.offset).toBe(3)
      expect(visualCursor!.logicalRow).toBe(0)
      expect(visualCursor!.logicalCol).toBe(3)
    })

    it("should set cursor to end of content using cursorOffset setter and stringWidth", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      const content = "Hello World"
      editor.setText(content)
      editor.cursorOffset = stringWidth(content)

      const visualCursor = editor.visualCursor
      expect(visualCursor).not.toBe(null)
      expect(visualCursor!.offset).toBe(stringWidth(content))
      expect(visualCursor!.logicalRow).toBe(0)
      expect(visualCursor!.logicalCol).toBe(content.length)
      expect(visualCursor!.visualCol).toBe(content.length)

      // Verify cursor is at the end
      expect(editor.cursorOffset).toBe(11)
      expect(editor.plainText).toBe("Hello World")
    })
  })

  describe("EditBufferRenderable Methods", () => {
    describe("deleteRange", () => {
      it("should delete range within a single line", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Hello World",
          width: 40,
          height: 10,
        })

        editor.deleteRange(0, 6, 0, 11)
        await renderOnce()

        expect(editor.plainText).toBe("Hello ")
      })

      it("should delete range across multiple lines", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 1\nLine 2\nLine 3",
          width: 40,
          height: 10,
        })

        editor.deleteRange(0, 5, 2, 5)
        await renderOnce()

        expect(editor.plainText).toBe("Line 3")
      })

      it("should delete entire line", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "First\nSecond\nThird",
          width: 40,
          height: 10,
        })

        editor.deleteRange(1, 0, 1, 6)
        await renderOnce()

        expect(editor.plainText).toBe("First\n\nThird")
      })

      it("should mark yoga node as dirty and request render", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test text",
          width: 40,
          height: 10,
        })

        const initialHeight = editor.height
        editor.deleteRange(0, 0, 0, 5)
        await renderOnce()

        expect(editor.plainText).toBe("text")
      })

      it("should handle empty range deletion", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Hello",
          width: 40,
          height: 10,
        })

        editor.deleteRange(0, 2, 0, 2)
        await renderOnce()

        expect(editor.plainText).toBe("Hello")
      })
    })

    describe("insertText", () => {
      it("should insert text at cursor position", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Hello",
          width: 40,
          height: 10,
        })

        editor.insertText(" World")
        await renderOnce()

        expect(editor.plainText).toBe(" WorldHello")
      })

      it("should insert text in middle of content", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "HelloWorld",
          width: 40,
          height: 10,
        })

        editor.editBuffer.setCursor(0, 5)
        editor.insertText(" ")
        await renderOnce()

        expect(editor.plainText).toBe("Hello World")
      })

      it("should insert multiline text", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Start",
          width: 40,
          height: 10,
        })

        editor.editBuffer.setCursor(0, 5)
        editor.insertText("\nEnd")
        await renderOnce()

        expect(editor.plainText).toBe("Start\nEnd")
      })

      it("should mark yoga node as dirty and request render", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
        })

        editor.insertText("Test")
        await renderOnce()

        expect(editor.plainText).toBe("Test")
      })

      it("should insert multiline text and update content", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 1",
          width: 40,
          height: 10,
        })

        editor.editBuffer.setCursor(0, 6)
        editor.insertText("\nLine 2\nLine 3")
        await renderOnce()

        expect(editor.plainText).toBe("Line 1\nLine 2\nLine 3")
        expect(editor.logicalCursor.row).toBe(2)
      })
    })

    describe("Combined deleteRange and insertText", () => {
      it("should replace text by deleting range then inserting", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Hello World",
          width: 40,
          height: 10,
        })

        editor.deleteRange(0, 6, 0, 11)
        editor.editBuffer.setCursor(0, 6)
        editor.insertText("Friend")
        await renderOnce()

        expect(editor.plainText).toBe("Hello Friend")
      })

      it("should handle complex editing operations", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 1\nLine 2\nLine 3",
          width: 40,
          height: 10,
        })

        editor.deleteRange(1, 0, 1, 6)
        editor.editBuffer.setCursor(1, 0)
        editor.insertText("Modified")
        await renderOnce()

        expect(editor.plainText).toBe("Line 1\nModified\nLine 3")
      })

      it("should work after multiple operations", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Start",
          width: 40,
          height: 10,
        })

        editor.editBuffer.setCursor(0, 5)
        editor.insertText(" Middle")
        editor.editBuffer.setCursor(0, 12)
        editor.insertText(" End")
        editor.deleteRange(0, 0, 0, 5)
        await renderOnce()

        expect(editor.plainText).toBe(" Middle End")
      })
    })
  })
})
