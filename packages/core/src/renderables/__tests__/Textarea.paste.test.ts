import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"
import { decodePasteBytes, PasteEvent } from "../../lib/index.js"
import { pasteBytes } from "../../testing/mock-keys.js"
import { InputRenderable } from "../Input.js"
import { TextareaRenderable } from "../Textarea.js"

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

  // A paste keeps control characters, as in Vim, but drops terminal escape sequences, a lone ESC, and a sequence that
  // the paste cuts off, on Bun and Node alike. Input also drops CR and LF.
  it.each([
    ["", "x", "x"],
    [" World", "x World", "x World"],
    ["\nLine 2\nLine 3", "x\nLine 2\nLine 3", "xLine 2Line 3"],
    [" 🌟世界👍", "x 🌟世界👍", "x 🌟世界👍"],
    ["a \x1b[31mred\x1b[0m\x1b[2 q\x1b[31", "xa red", "xa red"],
    ["a\fb\u0000c", "xa\fb\u0000c", "xa\fb\u0000c"],
    ["\x1b]0;title\x07y\u009d0;t\u009cz\u0090q\u009c\u0098s\u009c\u009ep\u009c\u009fa\x07w", "xyzw", "xyzw"],
    ["\x1b", "x", "x"],
    ["a\x1bP1$r\x1b\\b\x1bXs\x1b\\c\x1b(Bd\x9b1me\x1b^p\x1b\\\x1b_a\x1b\\\x1b\x07", "xabcde\x07", "xabcde\x07"],
    ["\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\x1b]0;cut", "xlink", "xlink"],
    ["p\u0085q\u007f", "xp\u0085q\u007f", "xp\u0085q\u007f"],
    ["\ty\r\nz", "x\ty\nz", "x\tyz"],
  ])("pastes %j into Textarea and Input", async (pasted, textareaText, inputText) => {
    const errors = spyOn(console, "error")
    const editors = [
      [new TextareaRenderable(currentRenderer, { initialValue: "x", width: 40, height: 3 }), textareaText],
      [new InputRenderable(currentRenderer, { value: "x", width: 40 }), inputText],
    ] as const
    try {
      for (const [editor, expected] of editors) {
        currentRenderer.root.add(editor)
        editor.focus()
        editor.gotoBufferEnd()
        await currentMockInput.pasteBracketedText(pasted)
        currentMockInput.pressKey("\u0085")
        await renderOnce()
        expect(editor.plainText).toBe(expected)
        editor.destroy()
      }
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  describe("Paste Events", () => {
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
