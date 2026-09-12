import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"
import { decodePasteBytes, PasteEvent } from "../../lib/index.js"
import { pasteBytes } from "../../testing/mock-keys.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput

describe("Textarea - Paste Tests", () => {
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

  describe("Paste Events", () => {
    it("should paste text at cursor position", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      await currentMockInput.pasteBracketedText(" World")

      expect(editor.plainText).toBe("Hello World")
    })

    it("should paste text in the middle", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "HelloWorld",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 5; i++) {
        editor.moveCursorRight()
      }

      await currentMockInput.pasteBracketedText(" ")

      expect(editor.plainText).toBe("Hello World")
    })

    it("should paste multi-line text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Start",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)

      await currentMockInput.pasteBracketedText("\nLine 2\nLine 3")

      expect(editor.plainText).toBe("Start\nLine 2\nLine 3")
    })

    it("should paste text at beginning of buffer", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "World",
        width: 40,
        height: 10,
      })

      editor.focus()
      // Cursor starts at beginning

      await currentMockInput.pasteBracketedText("Hello ")

      expect(editor.plainText).toBe("Hello World")
    })

    it("should replace selected text when pasting", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      // Select "Hello" using shift+right
      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      // Inclusive selection: 5 shift+right presses select "Hello" plus the
      // space under the cursor.
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello ")

      // Paste to replace selection
      await currentMockInput.pasteBracketedText("Goodbye")

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("GoodbyeWorld")
    })

    it("should replace multi-line selection when pasting", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      // Select from start through "Line 1\nLine" (inclusive of the cell
      // under the cursor)
      for (let i = 0; i < 10; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.hasSelection()).toBe(true)

      // Paste replacement text
      await currentMockInput.pasteBracketedText("New")

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("New 2\nLine 3")
    })

    it("should replace selected text with multi-line paste", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      // Select "Hello"
      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.getSelectedText()).toBe("Hello ")

      // Paste multi-line text to replace selection
      await currentMockInput.pasteBracketedText("Line 1\nLine 2")

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("Line 1\nLine 2World")
    })

    it("should paste empty string without error", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()

      await currentMockInput.pasteBracketedText("")

      expect(editor.plainText).toBe("Test")
    })

    it("should resize viewport when pasting multiline text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        maxHeight: 4,
        wrapMode: "none",
      })

      editor.focus()

      await renderOnce()
      expect(editor.height).toBe(1)

      await currentMockInput.pasteBracketedText("Line 1\nLine 2\nLine 3")
      await renderOnce()
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(editor.plainText).toBe("Line 1\nLine 2\nLine 3")
      expect(viewport.height).toBeGreaterThan(1)
    })

    it("should paste Unicode characters (emoji, CJK)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)

      await currentMockInput.pasteBracketedText(" 🌟世界👍")

      expect(editor.plainText).toBe("Hello 🌟世界👍")
    })

    it("should strip ANSI sequences when inserting pasted text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      await currentMockInput.pasteBracketedText("text with \x1b[31mred\x1b[0m color")

      expect(editor.plainText).toBe("text with red color")
    })

    it("should replace entire selection with pasted text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAA\nBBBB\nCCCC",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()
      editor.gotoLine(1) // Go to BBBB line

      // Select all of BBBB
      for (let i = 0; i < 4; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.getSelectedText()).toBe("BBBB")

      // Paste replacement
      await currentMockInput.pasteBracketedText("XXXX")

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("AAAA\nXXXX\nCCCC")
    })

    it("should handle paste via handlePaste method directly", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)

      editor.handlePaste(new PasteEvent(pasteBytes(" Content")))

      expect(editor.plainText).toBe("Test Content")
    })

    it("should replace selection when using handlePaste directly", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      // Select "World"
      const cursor = editor.logicalCursor
      editor.editBuffer.setCursorToLineCol(cursor.row, 9999)
      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("left", { shift: true })
      }

      expect(editor.getSelectedText()).toBe("World")

      // Use handlePaste directly
      editor.handlePaste(new PasteEvent(pasteBytes("Universe")))

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("Hello Universe")
    })

    it("should support preventDefault on paste event", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        onPaste: (event) => {
          event.preventDefault()
        },
      })

      editor.focus()
      editor.gotoLine(9999)

      await currentMockInput.pasteBracketedText(" Prevented")

      expect(editor.plainText).toBe("Test")
    })

    it("should pass full PasteEvent to onPaste handler", async () => {
      let receivedEvent: any = null
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        onPaste: (event) => {
          receivedEvent = event
        },
      })

      editor.focus()
      editor.gotoLine(9999)

      await currentMockInput.pasteBracketedText(" Event")

      expect(receivedEvent).not.toBeNull()
      expect(receivedEvent.bytes).toEqual(pasteBytes(" Event"))
      expect(typeof receivedEvent.preventDefault).toBe("function")
      expect(receivedEvent.defaultPrevented).toBe(false)
      expect(editor.plainText).toBe("Test Event")
    })

    it("should allow conditional paste prevention", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        onPaste: (event) => {
          if (decodePasteBytes(event.bytes).includes("blocked")) {
            event.preventDefault()
          }
        },
      })

      editor.focus()
      editor.gotoLine(9999)

      await currentMockInput.pasteBracketedText(" allowed")
      expect(editor.plainText).toBe("Test allowed")

      await currentMockInput.pasteBracketedText(" blocked content")
      expect(editor.plainText).toBe("Test allowed")
    })
  })
})
