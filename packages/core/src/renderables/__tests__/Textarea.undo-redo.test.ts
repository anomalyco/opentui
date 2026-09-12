import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput

describe("Textarea - Undo/Redo Tests", () => {
  beforeEach(async () => {
    ;({
      renderer: currentRenderer,
      renderOnce,
      mockInput: currentMockInput,
    } = await createTestRenderer({
      width: 80,
      height: 24,
      otherModifiersMode: true,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  describe("Undo/Redo", () => {
    it("should delete multiple selected ranges and restore with undo", async () => {
      const initialText = "Hello World Test"
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: initialText,
        width: 40,
        height: 10,
      })

      editor.focus()

      editor.editBuffer.setCursor(0, 0)
      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }
      // Inclusive selection: each range extends through the cell under the cursor.
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello ")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("World Test")
      expect(editor.hasSelection()).toBe(false)

      editor.editBuffer.setCursor(0, 0)
      for (let i = 0; i < 6; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("World T")

      currentMockInput.pressKey("DELETE")
      expect(editor.plainText).toBe("est")
      expect(editor.hasSelection()).toBe(false)

      editor.editBuffer.setCursor(0, 0)
      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("est")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("")
      expect(editor.hasSelection()).toBe(false)

      currentMockInput.pressKey("-", { ctrl: true })
      expect(editor.plainText).toBe("est")

      currentMockInput.pressKey("-", { ctrl: true })
      expect(editor.plainText).toBe("World Test")

      currentMockInput.pressKey("-", { ctrl: true })
      expect(editor.plainText).toBe(initialText)
    })
  })

  describe("History - Undo/Redo", () => {
    it("should undo text insertion", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Type "Hello"
      currentMockInput.pressKey("H")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("o")
      expect(editor.plainText).toBe("Hello")

      // Undo
      editor.undo()
      expect(editor.plainText).toBe("Hell")
    })

    it("should redo after undo", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Type text
      currentMockInput.pressKey("T")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("s")
      currentMockInput.pressKey("t")
      expect(editor.plainText).toBe("Test")

      // Undo
      editor.undo()
      expect(editor.plainText).toBe("Tes")

      // Redo
      editor.redo()
      expect(editor.plainText).toBe("Test")
    })

    it("should handle multiple undo operations", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Type characters one by one
      currentMockInput.pressKey("A")
      currentMockInput.pressKey("B")
      currentMockInput.pressKey("C")
      expect(editor.plainText).toBe("ABC")

      // Undo 3 times
      editor.undo()
      expect(editor.plainText).toBe("AB")

      editor.undo()
      expect(editor.plainText).toBe("A")

      editor.undo()
      expect(editor.plainText).toBe("")
    })

    it("should handle Ctrl+- for undo", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("H")
      currentMockInput.pressKey("i")
      expect(editor.plainText).toBe("Hi")

      // Ctrl+- to undo
      currentMockInput.pressKey("-", { ctrl: true })
      expect(editor.plainText).toBe("H")
    })

    it("should handle Ctrl+. for redo", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("X")
      expect(editor.plainText).toBe("X")

      // Undo
      currentMockInput.pressKey("-", { ctrl: true })
      expect(editor.plainText).toBe("")

      // Ctrl+. to redo
      currentMockInput.pressKey(".", { ctrl: true })
      expect(editor.plainText).toBe("X")
    })

    it("should handle redo programmatically", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("Y")
      expect(editor.plainText).toBe("Y")

      editor.undo()
      expect(editor.plainText).toBe("")

      // Programmatic redo
      editor.redo()
      expect(editor.plainText).toBe("Y")
    })

    it("should undo deletion", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      // Delete backward
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Hello Worl")

      // Undo
      editor.undo()
      expect(editor.plainText).toBe("Hello World")
    })

    it("should undo newline insertion", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      currentMockInput.pressEnter()
      expect(editor.plainText).toBe("Hello\n")

      // Undo
      editor.undo()
      expect(editor.plainText).toBe("Hello")
    })

    it("should restore cursor position after undo", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressEnter()
      currentMockInput.pressKey("L")
      currentMockInput.pressKey("i")
      expect(editor.plainText).toBe("Line 1\nLi")
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(2)

      // Undo last character "i"
      editor.undo()
      expect(editor.plainText).toBe("Line 1\nL")
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(1)

      // Undo "L"
      editor.undo()
      expect(editor.plainText).toBe("Line 1\n")
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should handle undo/redo chain", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Build up edits
      currentMockInput.pressKey("1")
      currentMockInput.pressKey("2")
      currentMockInput.pressKey("3")
      expect(editor.plainText).toBe("123")

      // Undo all
      editor.undo()
      expect(editor.plainText).toBe("12")
      editor.undo()
      expect(editor.plainText).toBe("1")
      editor.undo()
      expect(editor.plainText).toBe("")

      // Redo all
      editor.redo()
      expect(editor.plainText).toBe("1")
      editor.redo()
      expect(editor.plainText).toBe("12")
      editor.redo()
      expect(editor.plainText).toBe("123")
    })

    it("should handle undo after deleteChar", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABCDE",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Delete "A"
      currentMockInput.pressKey("DELETE")
      expect(editor.plainText).toBe("BCDE")

      // Undo
      editor.undo()
      expect(editor.plainText).toBe("ABCDE")
    })

    it("should handle undo after deleteLine", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)

      const beforeDelete = editor.plainText

      // Delete line 2
      currentMockInput.pressKey("d", { ctrl: true })
      const afterDelete = editor.plainText

      // Verify delete happened
      expect(afterDelete).not.toBe(beforeDelete)

      // Undo
      editor.undo()
      expect(editor.plainText).toBe(beforeDelete)
    })

    it("should clear selection on undo", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      // Type a character first
      currentMockInput.pressKey("A")
      expect(editor.plainText).toBe("AHello World")

      // Undo to get back to original
      editor.undo()
      expect(editor.plainText).toBe("Hello World")

      // Make a selection
      currentMockInput.pressArrow("right", { shift: true })
      expect(editor.hasSelection()).toBe(true)

      // Undo should clear selection (even though there's nothing to undo now)
      editor.undo()
      expect(editor.hasSelection()).toBe(false)
    })
  })
})
