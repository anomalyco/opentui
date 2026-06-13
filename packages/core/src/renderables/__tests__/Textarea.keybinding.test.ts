import { Buffer } from "node:buffer"
import { describe, expect, it, afterAll, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockMouse, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"
import { KeyEvent } from "../../lib/KeyHandler.js"
import { parseKeypress } from "../../lib/parse.keypress.js"

// Helper function to create a KeyEvent from a string
function createKeyEvent(
  input: string | { name: string; shift?: boolean; ctrl?: boolean; meta?: boolean; super?: boolean; baseCode?: number },
): KeyEvent {
  if (typeof input === "string") {
    return new KeyEvent({
      name: input,
      sequence: input,
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      number: false,
      raw: input,
      eventType: "press",
      source: "raw",
    })
  } else {
    return new KeyEvent({
      name: input.name,
      sequence: input.name === "space" ? " " : input.name,
      ctrl: input.ctrl ?? false,
      meta: input.meta ?? false,
      shift: input.shift ?? false,
      super: input.super ?? false,
      baseCode: input.baseCode,
      option: false,
      number: false,
      raw: input.name,
      eventType: "press",
      source: "raw",
    })
  }
}

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMouse: MockMouse
let currentMockInput: MockInput

describe("Textarea - Keybinding Tests", () => {
  beforeEach(async () => {
    ;({
      renderer: currentRenderer,
      renderOnce,
      mockMouse: currentMouse,
      mockInput: currentMockInput,
    } = await createTestRenderer({
      width: 80,
      height: 24,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  describe("Keyboard Input - Meta Key Bindings", () => {
    it("should bind custom action to meta key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        keyBindings: [{ name: "b", meta: true, action: "buffer-home" }],
      })

      editor.focus()
      editor.gotoLine(9999)

      currentMockInput.pressKey("b", { meta: true })

      const cursor = editor.logicalCursor
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
    })

    it("should bind meta key actions", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        keyBindings: [{ name: "f", meta: true, action: "buffer-end" }],
      })

      editor.focus()

      currentMockInput.pressKey("f", { meta: true })

      const cursor = editor.logicalCursor
      expect(cursor.row).toBe(0)
    })

    it("should work with meta key for navigation", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2",
        width: 40,
        height: 10,
        keyBindings: [{ name: "j", meta: true, action: "move-down" }],
      })

      editor.focus()
      expect(editor.logicalCursor.row).toBe(0)

      currentMockInput.pressKey("j", { meta: true })
      expect(editor.logicalCursor.row).toBe(1)
    })

    it("should allow meta key binding override", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        keyBindings: [{ name: "k", meta: true, action: "move-up" }],
      })

      editor.focus()
      editor.gotoLine(2)
      expect(editor.logicalCursor.row).toBe(2)

      currentMockInput.pressKey("k", { meta: true })
      expect(editor.logicalCursor.row).toBe(1)
    })

    it("should work with Meta+Arrow keys", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "left", meta: true, action: "line-home" },
          { name: "right", meta: true, action: "line-end" },
        ],
      })

      editor.focus()
      for (let i = 0; i < 2; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressArrow("left", { meta: true })
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressArrow("right", { meta: true })
      expect(editor.logicalCursor.col).toBe(3)
    })

    it("should support meta with shift modifier", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        keyBindings: [{ name: "H", meta: true, shift: true, action: "line-home" }],
      })

      editor.focus()
      editor.gotoLine(9999)
      expect(editor.logicalCursor.col).toBe(11)

      currentMockInput.pressKey("h", { meta: true, shift: true })

      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should not trigger action without meta when meta binding exists", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        keyBindings: [{ name: "x", meta: true, action: "delete-line" }],
      })

      editor.focus()

      currentMockInput.pressKey("x")
      expect(editor.plainText).toBe("xTest")

      currentMockInput.pressKey("x", { meta: true })
      expect(editor.plainText).toBe("")
    })

    it("should update keyBindings dynamically with setter", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)

      currentMockInput.pressKey("b", { meta: true })
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)

      editor.keyBindings = [{ name: "b", meta: true, action: "buffer-end" }]

      editor.gotoLine(0)
      expect(editor.logicalCursor.row).toBe(0)

      currentMockInput.pressKey("b", { meta: true })
      expect(editor.logicalCursor.row).toBe(0)
    })

    it("should merge new keyBindings with defaults", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(1)

      editor.keyBindings = [{ name: "d", meta: true, action: "delete-line" }]

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressKey("d", { meta: true })
      expect(editor.plainText).toBe("Line 2")
    })

    it("should override default keyBindings with new bindings", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("f", { meta: true })
      expect(editor.logicalCursor.col).toBe(6)

      editor.keyBindings = [{ name: "f", meta: true, action: "buffer-end" }]

      editor.gotoLine(0)
      currentMockInput.pressKey("f", { meta: true })
      expect(editor.logicalCursor.row).toBe(0)
    })

    it("should override return/enter keys to swap newline and submit actions", async () => {
      let submitCalled = false
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1",
        width: 40,
        height: 10,
        onSubmit: () => {
          submitCalled = true
        },
      })

      editor.focus()
      editor.gotoLine(9999)

      currentMockInput.pressEnter()
      expect(editor.plainText).toBe("Line 1\n")
      expect(submitCalled).toBe(false)

      currentMockInput.pressEnter({ meta: true })
      expect(submitCalled).toBe(true)
      submitCalled = false

      editor.keyBindings = [
        { name: "return", meta: true, action: "newline" },
        { name: "linefeed", meta: true, action: "newline" },
        { name: "return", action: "submit" },
        { name: "linefeed", action: "submit" },
      ]

      currentMockInput.pressEnter()
      expect(submitCalled).toBe(true)
      submitCalled = false

      currentMockInput.pressEnter({ meta: true })
      expect(editor.plainText).toBe("Line 1\n\n")
      expect(submitCalled).toBe(false)
    })
  })

  describe("Key Event Handling - Modifier Keys", () => {
    let kittyRenderer: TestRenderer
    let kittyRenderOnce: () => Promise<void>
    let kittyMockInput: MockInput

    beforeEach(async () => {
      ;({
        renderer: kittyRenderer,
        renderOnce: kittyRenderOnce,
        mockInput: kittyMockInput,
      } = await createTestRenderer({
        width: 80,
        height: 24,
        kittyKeyboard: true,
      }))
    })

    afterEach(() => {
      kittyRenderer.destroy()
    })

    it("should not insert text when ctrl modifier is pressed", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Try to type 'a' with ctrl - should not insert
      kittyMockInput.pressKey("a", { ctrl: true })
      expect(editor.plainText).toBe("")

      // Try to type 'x' with ctrl - should not insert
      kittyMockInput.pressKey("x", { ctrl: true })
      expect(editor.plainText).toBe("")
    })

    it("should not insert text when meta modifier is pressed", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Try to type 'a' with meta - should not insert
      kittyMockInput.pressKey("a", { meta: true })
      expect(editor.plainText).toBe("")

      // Try to type 'x' with meta - should not insert
      kittyMockInput.pressKey("x", { meta: true })
      expect(editor.plainText).toBe("")
    })

    it("should not insert text when super modifier is pressed", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Try to type 'a' with super - should not insert
      kittyMockInput.pressKey("a", { super: true })
      expect(editor.plainText).toBe("")

      // Try to type 'x' with super - should not insert
      kittyMockInput.pressKey("x", { super: true })
      expect(editor.plainText).toBe("")
    })

    it("should not insert text when hyper modifier is pressed", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Try to type 'a' with hyper - should not insert
      kittyMockInput.pressKey("a", { hyper: true })
      expect(editor.plainText).toBe("")

      // Try to type 'x' with hyper - should not insert
      kittyMockInput.pressKey("x", { hyper: true })
      expect(editor.plainText).toBe("")
    })

    it("should not insert text when multiple modifiers are pressed", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Try to type with ctrl+meta - should not insert
      kittyMockInput.pressKey("a", { ctrl: true, meta: true })
      expect(editor.plainText).toBe("")

      // Try to type with ctrl+super - should not insert
      kittyMockInput.pressKey("b", { ctrl: true, super: true })
      expect(editor.plainText).toBe("")

      // Try to type with meta+hyper - should not insert
      kittyMockInput.pressKey("c", { meta: true, hyper: true })
      expect(editor.plainText).toBe("")
    })

    it("should insert text when only shift modifier is pressed", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Shift is okay for uppercase letters
      kittyMockInput.pressKey("A", { shift: true })
      expect(editor.plainText).toBe("A")

      kittyMockInput.pressKey("B", { shift: true })
      expect(editor.plainText).toBe("AB")
    })

    it("should not insert text when Caps Lock key is pressed", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      kittyRenderer.stdin.emit("data", Buffer.from("\x1b[57358u"))
      expect(editor.plainText).toBe("")
    })
  })

  describe("Key Event Handling", () => {
    it("should only handle KeyEvents, not raw escape sequences", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      const rawEscapeSequence = "\x1b[<35;86;19M"
      const handled = editor.handleKeyPress(createKeyEvent(rawEscapeSequence))

      expect(handled).toBe(false)

      expect(editor.plainText).toBe("")
    })

    it("should not insert control sequences into text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Try various control sequences that should NOT be inserted
      const controlSequences = [
        "\x1b[A", // Arrow up
        "\x1b[B", // Arrow down
        "\x1b[C", // Arrow right
        "\x1b[D", // Arrow left
        "\x1b[?1004h", // Focus tracking
        "\x1b[?2004h", // Bracketed paste
        "\x1b[<0;10;10M", // Mouse event
      ]

      for (const seq of controlSequences) {
        const before = editor.plainText
        editor.handleKeyPress(createKeyEvent(seq))
        const after = editor.plainText

        // Content should not change for control sequences
        expect(after).toBe(before)
      }
    })

    it("should handle printable characters via handleKeyPress", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // These should be handled
      const handled1 = editor.handleKeyPress(createKeyEvent("a"))
      expect(handled1).toBe(true)
      expect(editor.plainText).toBe("a")

      const handled2 = editor.handleKeyPress(createKeyEvent("b"))
      expect(handled2).toBe(true)
      expect(editor.plainText).toBe("ab")
    })

    it("should handle multi-byte Unicode characters (emoji, CJK)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Emoji (multi-byte UTF-8)
      const emojiHandled = editor.handleKeyPress(createKeyEvent("🌟"))
      expect(emojiHandled).toBe(true)
      expect(editor.plainText).toBe("🌟")

      // CJK characters (multi-byte UTF-8)
      const cjkHandled = editor.handleKeyPress(createKeyEvent("世"))
      expect(cjkHandled).toBe(true)
      expect(editor.plainText).toBe("🌟世")

      // Another emoji
      editor.insertText(" ")
      const emoji2Handled = editor.handleKeyPress(createKeyEvent("👍"))
      expect(emoji2Handled).toBe(true)
      expect(editor.plainText).toBe("🌟世 👍")
    })

    it("should filter escape sequences when they have non-printable characters", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      // Escape character (0x1b) - should not be inserted
      const escapeChar = String.fromCharCode(0x1b)
      const handled = editor.handleKeyPress(createKeyEvent(escapeChar))

      // Should not insert escape character
      expect(editor.plainText).toBe("Test")
    })
  })

  describe("Key Bindings", () => {
    it("should use default keybindings", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(1)

      currentMockInput.pressKey("HOME")
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("END")
      expect(editor.logicalCursor.col).toBe(11)
    })

    it("should allow custom keybindings to override defaults", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        keyBindings: [{ name: "j", action: "move-left" }],
      })

      editor.focus()
      editor.gotoLine(9999)
      expect(editor.logicalCursor.col).toBe(11)

      currentMockInput.pressKey("j")
      expect(editor.logicalCursor.col).toBe(10)
    })

    it("should map multiple custom keys to the same action", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "h", action: "move-left" },
          { name: "j", action: "move-down" },
          { name: "k", action: "move-up" },
          { name: "l", action: "move-right" },
        ],
      })

      editor.focus()

      currentMockInput.pressKey("l")
      expect(editor.logicalCursor.col).toBe(1)

      currentMockInput.pressKey("l")
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressKey("h")
      expect(editor.logicalCursor.col).toBe(1)

      currentMockInput.pressKey("h")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should support custom keybindings with ctrl modifier", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        keyBindings: [{ name: "g", ctrl: true, action: "buffer-home" }],
      })

      editor.focus()
      editor.gotoLine(9999)
      expect(editor.logicalCursor.row).toBe(2)

      currentMockInput.pressKey("g", { ctrl: true })
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should match ctrl+space from Kitty keyboard protocol", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
        keyBindings: [{ name: "space", ctrl: true, action: "newline" }],
      })

      editor.gotoLine(9999)

      const key = parseKeypress("\x1b[32;5u", { useKittyKeyboard: true })
      expect(key).toMatchObject({ name: "space", ctrl: true, sequence: " " })

      const handled = editor.handleKeyPress(new KeyEvent(key!))

      expect(handled).toBe(true)
      expect(editor.plainText).toBe("Hello\n")
    })

    it("should use baseCode when matching ctrl shortcuts from alternate layouts", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)
      expect(editor.logicalCursor.col).toBe(11)

      const handled = editor.handleKeyPress(createKeyEvent({ name: "ㅁ", baseCode: 97, ctrl: true }))

      expect(handled).toBe(true)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should support custom keybindings with shift modifier", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
        keyBindings: [{ name: "l", shift: true, action: "select-right" }],
      })

      editor.focus()

      currentMockInput.pressKey("L", { shift: true })
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("H")

      currentMockInput.pressKey("L", { shift: true })
      expect(editor.getSelectedText()).toBe("He")
    })

    it("should support custom keybindings with alt modifier", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        keyBindings: [{ name: "b", ctrl: true, action: "buffer-home" }],
      })

      editor.focus()
      editor.gotoLine(2)

      currentMockInput.pressKey("b", { ctrl: true })
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should support keybindings with multiple modifiers", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
        keyBindings: [{ name: "right", ctrl: true, shift: true, action: "select-line-end" }],
      })

      editor.focus()

      currentMockInput.pressArrow("right", { ctrl: true, shift: true })
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello World")
    })

    it("should map newline action to custom key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
        keyBindings: [{ name: "n", ctrl: true, action: "newline" }],
      })

      editor.focus()
      editor.gotoLine(9999)

      currentMockInput.pressKey("n", { ctrl: true })
      expect(editor.plainText).toBe("Hello\n")
    })

    it("should map backspace action to custom key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
        keyBindings: [{ name: "h", ctrl: true, action: "backspace" }],
      })

      editor.focus()
      editor.gotoLine(9999)

      currentMockInput.pressKey("h", { ctrl: true })
      expect(editor.plainText).toBe("Hell")
    })

    it("should map delete action to custom key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
        keyBindings: [{ name: "d", ctrl: false, action: "delete" }],
      })

      editor.focus()

      currentMockInput.pressKey("d")
      expect(editor.plainText).toBe("ello")
    })

    it("should map line-home and line-end to custom keys", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "a", action: "line-home" },
          { name: "e", action: "line-end" },
        ],
      })

      editor.focus()
      editor.moveCursorRight()
      editor.moveCursorRight()
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressKey("a")
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("e")
      expect(editor.logicalCursor.col).toBe(11)
    })

    it("should override default shift+home and shift+end keybindings", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
        keyBindings: [
          { name: "home", shift: true, action: "buffer-home" },
          { name: "end", shift: true, action: "buffer-end" },
        ],
      })

      editor.focus()
      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressKey("HOME", { shift: true })
      expect(editor.hasSelection()).toBe(false)
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)

      editor.moveCursorRight()
      currentMockInput.pressKey("END", { shift: true })
      expect(editor.hasSelection()).toBe(false)
      expect(editor.logicalCursor.row).toBe(0)
    })

    it("should map undo and redo actions to custom keys", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "u", action: "undo" },
          { name: "r", action: "redo" },
        ],
      })

      editor.focus()

      currentMockInput.pressKey("H")
      currentMockInput.pressKey("i")
      expect(editor.plainText).toBe("Hi")

      currentMockInput.pressKey("u")
      expect(editor.plainText).toBe("H")

      currentMockInput.pressKey("r")
      expect(editor.plainText).toBe("Hi")
    })

    it("should map delete-line action to custom key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        keyBindings: [{ name: "x", ctrl: true, action: "delete-line" }],
      })

      editor.focus()
      editor.gotoLine(1)

      currentMockInput.pressKey("x", { ctrl: true })
      expect(editor.plainText).toBe("Line 1\nLine 3")
    })

    it("should map delete-to-line-end action to custom key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        keyBindings: [{ name: "k", action: "delete-to-line-end" }],
      })

      editor.focus()
      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k")
      expect(editor.plainText).toBe("Hello ")
    })

    it("should delete from cursor to line start with ctrl+u", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("u", { ctrl: true })
      expect(editor.plainText).toBe("World")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should map delete-to-line-start action to custom key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        keyBindings: [{ name: "x", ctrl: true, action: "delete-to-line-start" }],
      })

      editor.focus()
      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("x", { ctrl: true })
      expect(editor.plainText).toBe("World")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should delete from cursor to line end with ctrl+k in multiline text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1 content\nLine 2 content\nLine 3 content",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 7; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k", { ctrl: true })
      expect(editor.plainText).toBe("Line 1 \nLine 2 content\nLine 3 content")
      expect(editor.logicalCursor.col).toBe(7)
      expect(editor.logicalCursor.row).toBe(0)
    })

    it("should delete from cursor to line end with ctrl+k on line 2", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1 content\nLine 2 content\nLine 3 content",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)
      for (let i = 0; i < 7; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k", { ctrl: true })
      expect(editor.plainText).toBe("Line 1 content\nLine 2 \nLine 3 content")
      expect(editor.logicalCursor.col).toBe(7)
      expect(editor.logicalCursor.row).toBe(1)
    })

    it("should delete from start to cursor with ctrl+u in multiline text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1 content\nLine 2 content\nLine 3 content",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 7; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("u", { ctrl: true })
      expect(editor.plainText).toBe("content\nLine 2 content\nLine 3 content")
      expect(editor.logicalCursor.col).toBe(0)
      expect(editor.logicalCursor.row).toBe(0)
    })

    it("should delete from start to cursor with ctrl+u on line 2", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1 content\nLine 2 content\nLine 3 content",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)
      for (let i = 0; i < 7; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("u", { ctrl: true })
      expect(editor.plainText).toBe("Line 1 content\ncontent\nLine 3 content")
      expect(editor.logicalCursor.col).toBe(0)
      expect(editor.logicalCursor.row).toBe(1)
    })

    it("should do nothing with ctrl+k when cursor is at end of line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1 content\nLine 2 content",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()

      currentMockInput.pressKey("k", { ctrl: true })
      expect(editor.plainText).toBe("Line 1 content\nLine 2 content")
      expect(editor.logicalCursor.col).toBe(14)
    })

    it("should do nothing with ctrl+u when cursor is at start of line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1 content\nLine 2 content",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("u", { ctrl: true })
      expect(editor.plainText).toBe("Line 1 content\nLine 2 content")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should work with ctrl+k after undo", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        keyBindings: [{ name: "u", action: "undo" }],
      })

      editor.focus()
      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k", { ctrl: true })
      expect(editor.plainText).toBe("Hello ")

      currentMockInput.pressKey("u")
      expect(editor.plainText).toBe("Hello World")
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressKey("k", { ctrl: true })
      expect(editor.plainText).toBe("Hello ")
    })

    it("should work with ctrl+u after undo when cursor is repositioned", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        keyBindings: [{ name: "z", action: "undo" }],
      })

      editor.focus()
      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("u", { ctrl: true })
      expect(editor.plainText).toBe("World")
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("z")
      expect(editor.plainText).toBe("Hello World")
      expect(editor.logicalCursor.col).toBe(6)

      editor.moveCursorLeft()
      editor.moveCursorRight()
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressKey("u", { ctrl: true })
      expect(editor.plainText).toBe("World")
    })

    it("should allow cursor to move right within restored line after undo", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1 content\nLine 2 content\nLine 3 content",
        width: 40,
        height: 10,
        keyBindings: [{ name: "u", action: "undo" }],
      })

      editor.focus()
      for (let i = 0; i < 7; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k", { ctrl: true })
      expect(editor.plainText).toBe("Line 1 \nLine 2 content\nLine 3 content")

      currentMockInput.pressKey("u")
      expect(editor.plainText).toBe("Line 1 content\nLine 2 content\nLine 3 content")

      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight()
      }

      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(10)
    })

    it("should allow ctrl+k to work again after undo", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1 content\nLine 2",
        width: 40,
        height: 10,
        keyBindings: [{ name: "u", action: "undo" }],
      })

      editor.focus()
      for (let i = 0; i < 7; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k", { ctrl: true })
      expect(editor.plainText).toBe("Line 1 \nLine 2")

      currentMockInput.pressKey("u")
      expect(editor.plainText).toBe("Line 1 content\nLine 2")

      currentMockInput.pressKey("k", { ctrl: true })
      expect(editor.plainText).toBe("Line 1 \nLine 2")
    })
  })

  describe("Wrapped Lines", () => {
    it("should delete to end of logical line with ctrl+k when wrapping enabled", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "This is a very long line that will wrap when viewport is narrow\nLine 2 content",
        width: 20,
        height: 10,
        wrapMode: "word",
      })

      editor.focus()

      for (let i = 0; i < 30; i++) {
        editor.moveCursorRight()
      }

      const visualCursor = editor.editorView.getVisualCursor()
      expect(visualCursor.logicalRow).toBe(0)
      expect(visualCursor.logicalCol).toBe(30)

      currentMockInput.pressKey("k", { ctrl: true })

      const lines = editor.plainText.split("\n")
      expect(lines[0]).toBe("This is a very long line that ")
      expect(lines[1]).toBe("Line 2 content")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(30)
    })

    it("should delete from start of logical line with ctrl+u when wrapping enabled", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "This is a very long line that will wrap when viewport is narrow\nLine 2 content",
        width: 20,
        height: 10,
        wrapMode: "word",
      })

      editor.focus()

      const originalLine0 = editor.plainText.split("\n")[0]

      for (let i = 0; i < 30; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("u", { ctrl: true })

      const lines = editor.plainText.split("\n")
      expect(lines[0]).toBe(originalLine0.substring(30))
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should work on second logical line when wrapped", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Short line 1\nThis is another very long line that will wrap\nLine 3",
        width: 20,
        height: 10,
        wrapMode: "word",
      })

      editor.focus()
      editor.gotoLine(1)

      const line1Before = editor.plainText.split("\n")[1]

      for (let i = 0; i < 25; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k", { ctrl: true })

      const lines = editor.plainText.split("\n")
      expect(lines[0]).toBe("Short line 1")
      expect(lines[1]).toBe(line1Before.substring(0, 25))
      expect(lines[2]).toBe("Line 3")
    })

    it("should work after undo with wrapped lines", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "This is a very long line that will wrap\nLine 2",
        width: 15,
        height: 10,
        wrapMode: "word",
        keyBindings: [{ name: "z", action: "undo" }],
      })

      editor.focus()

      for (let i = 0; i < 20; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k", { ctrl: true })

      const afterDelete = editor.plainText.split("\n")[0]
      expect(afterDelete.length).toBe(20)

      currentMockInput.pressKey("z")

      const afterUndo = editor.plainText.split("\n")[0]
      expect(afterUndo.length).toBe(39)

      currentMockInput.pressKey("k", { ctrl: true })

      const afterSecondDelete = editor.plainText.split("\n")[0]
      expect(afterSecondDelete.length).toBe(20)
    })

    it("should handle ctrl+k at exact wrap boundary", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAAAAAAAABBBBBBBBBBCCCCCCCCCC\nLine 2",
        width: 10,
        height: 10,
        wrapMode: "char",
      })

      editor.focus()

      for (let i = 0; i < 10; i++) {
        editor.moveCursorRight()
      }

      const visualCursor = editor.editorView.getVisualCursor()
      expect(visualCursor.visualRow).toBe(1)
      expect(visualCursor.logicalCol).toBe(10)

      currentMockInput.pressKey("k", { ctrl: true })

      const lines = editor.plainText.split("\n")
      expect(lines[0]).toBe("AAAAAAAAAA")
      expect(lines[1]).toBe("Line 2")
    })

    it("should handle ctrl+u on second visual line of first logical line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAAAAAAAABBBBBBBBBBCCCCCCCCCC\nLine 2",
        width: 10,
        height: 10,
        wrapMode: "char",
      })

      editor.focus()

      for (let i = 0; i < 15; i++) {
        editor.moveCursorRight()
      }

      const visualCursor = editor.editorView.getVisualCursor()
      expect(visualCursor.visualRow).toBe(1)
      expect(visualCursor.logicalRow).toBe(0)
      expect(visualCursor.logicalCol).toBe(15)

      currentMockInput.pressKey("u", { ctrl: true })

      const lines = editor.plainText.split("\n")
      expect(lines[0]).toBe("BBBBBCCCCCCCCCC")
      expect(lines[0].length).toBe(15)
      expect(editor.logicalCursor.col).toBe(0)
    })
  })

  describe("Wrapped Lines", () => {
    it("should delete to end of logical line with ctrl+k when wrapping enabled", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "This is a very long line that will wrap when viewport is narrow\nLine 2 content",
        width: 20,
        height: 10,
        wrapMode: "word",
      })

      editor.focus()

      for (let i = 0; i < 30; i++) {
        editor.moveCursorRight()
      }

      const visualCursor = editor.editorView.getVisualCursor()
      expect(visualCursor.logicalRow).toBe(0)
      expect(visualCursor.logicalCol).toBe(30)

      currentMockInput.pressKey("k", { ctrl: true })

      const lines = editor.plainText.split("\n")
      expect(lines[0]).toBe("This is a very long line that ")
      expect(lines[1]).toBe("Line 2 content")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(30)
    })

    it("should delete from start of logical line with ctrl+u when wrapping enabled", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "This is a very long line that will wrap when viewport is narrow\nLine 2 content",
        width: 20,
        height: 10,
        wrapMode: "word",
      })

      editor.focus()

      const originalLine0 = editor.plainText.split("\n")[0]

      for (let i = 0; i < 30; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("u", { ctrl: true })

      const lines = editor.plainText.split("\n")
      expect(lines[0]).toBe(originalLine0.substring(30))
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should work on second logical line when wrapped", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Short line 1\nThis is another very long line that will wrap\nLine 3",
        width: 20,
        height: 10,
        wrapMode: "word",
      })

      editor.focus()
      editor.gotoLine(1)

      const line1Before = editor.plainText.split("\n")[1]

      for (let i = 0; i < 25; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k", { ctrl: true })

      const lines = editor.plainText.split("\n")
      expect(lines[0]).toBe("Short line 1")
      expect(lines[1]).toBe(line1Before.substring(0, 25))
      expect(lines[2]).toBe("Line 3")
    })

    it("should work after undo with wrapped lines", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "This is a very long line that will wrap\nLine 2",
        width: 15,
        height: 10,
        wrapMode: "word",
        keyBindings: [{ name: "z", action: "undo" }],
      })

      editor.focus()

      for (let i = 0; i < 20; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k", { ctrl: true })

      const afterDelete = editor.plainText.split("\n")[0]
      expect(afterDelete.length).toBe(20)

      currentMockInput.pressKey("z")

      const afterUndo = editor.plainText.split("\n")[0]
      expect(afterUndo.length).toBe(39)

      currentMockInput.pressKey("k", { ctrl: true })

      const afterSecondDelete = editor.plainText.split("\n")[0]
      expect(afterSecondDelete.length).toBe(20)
    })

    it("should handle ctrl+k at exact wrap boundary", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAAAAAAAABBBBBBBBBBCCCCCCCCCC\nLine 2",
        width: 10,
        height: 10,
        wrapMode: "char",
      })

      editor.focus()

      for (let i = 0; i < 10; i++) {
        editor.moveCursorRight()
      }

      const visualCursor = editor.editorView.getVisualCursor()
      expect(visualCursor.visualRow).toBe(1)
      expect(visualCursor.logicalCol).toBe(10)

      currentMockInput.pressKey("k", { ctrl: true })

      const lines = editor.plainText.split("\n")
      expect(lines[0]).toBe("AAAAAAAAAA")
      expect(lines[1]).toBe("Line 2")
    })

    it("should handle ctrl+u on second visual line of first logical line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAAAAAAAABBBBBBBBBBCCCCCCCCCC\nLine 2",
        width: 10,
        height: 10,
        wrapMode: "char",
      })

      editor.focus()

      for (let i = 0; i < 15; i++) {
        editor.moveCursorRight()
      }

      const visualCursor = editor.editorView.getVisualCursor()
      expect(visualCursor.visualRow).toBe(1)
      expect(visualCursor.logicalRow).toBe(0)
      expect(visualCursor.logicalCol).toBe(15)

      currentMockInput.pressKey("u", { ctrl: true })

      const lines = editor.plainText.split("\n")
      expect(lines[0]).toBe("BBBBBCCCCCCCCCC")
      expect(lines[0].length).toBe(15)
      expect(editor.logicalCursor.col).toBe(0)
    })
  })

  describe("Key Bindings", () => {
    it("should use default keybindings", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "g", action: "buffer-home" },
          { name: "b", action: "buffer-end" },
        ],
      })

      editor.focus()
      editor.gotoLine(9999)
      expect(editor.logicalCursor.row).toBe(2)

      currentMockInput.pressKey("g")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("b")
      expect(editor.logicalCursor.row).toBe(2)
    })

    it("should map select-up and select-down to custom keys", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        selectable: true,
        keyBindings: [
          { name: "k", shift: true, action: "select-up" },
          { name: "j", shift: true, action: "select-down" },
        ],
      })

      editor.focus()
      editor.gotoLine(1)

      currentMockInput.pressKey("J", { shift: true })
      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()
      expect(selectedText.includes("Line")).toBe(true)
    })

    it("should preserve default keybindings when custom bindings don't override them", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        keyBindings: [{ name: "j", action: "move-down" }],
      })

      editor.focus()

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(1)

      currentMockInput.pressKey("HOME")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should allow remapping default keys to different actions", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        keyBindings: [{ name: "up", action: "buffer-home" }],
      })

      editor.focus()
      editor.gotoLine(2)

      currentMockInput.pressArrow("up")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should handle complex keybinding scenario with multiple custom mappings", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "h", action: "move-left" },
          { name: "j", action: "move-down" },
          { name: "k", action: "move-up" },
          { name: "l", action: "move-right" },
          { name: "i", action: "buffer-home" },
          { name: "a", action: "line-end" },
        ],
      })

      editor.focus()

      currentMockInput.pressKey("i")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("a")
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressKey("h")
      expect(editor.logicalCursor.col).toBe(5)

      currentMockInput.pressKey("j")
      expect(editor.logicalCursor.row).toBe(1)

      currentMockInput.pressKey("k")
      expect(editor.logicalCursor.row).toBe(0)

      currentMockInput.pressKey("l")
      expect(editor.logicalCursor.col).toBe(6)
    })

    it("should not insert text when key is bound to action", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
        keyBindings: [{ name: "x", action: "delete" }],
      })

      editor.focus()

      currentMockInput.pressKey("x")
      expect(editor.plainText).toBe("ello")

      expect(editor.plainText).not.toContain("x")
    })

    it("should still insert unbound keys as text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        keyBindings: [{ name: "j", action: "move-down" }],
      })

      editor.focus()

      currentMockInput.pressKey("h")
      expect(editor.plainText).toBe("h")

      currentMockInput.pressKey("i")
      expect(editor.plainText).toBe("hi")

      currentMockInput.pressKey("j")
      expect(editor.plainText).toBe("hi")
    })

    it("should differentiate between key with and without modifiers", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "d", action: "delete" },
          { name: "d", meta: true, action: "delete-line" },
        ],
      })

      editor.focus()

      currentMockInput.pressKey("d")
      expect(editor.plainText).toBe("ello")
    })

    it("should support selection actions with custom keybindings", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
        keyBindings: [
          { name: "h", shift: true, action: "select-left" },
          { name: "l", shift: true, action: "select-right" },
        ],
      })

      editor.focus()
      editor.gotoLine(9999)

      currentMockInput.pressKey("H", { shift: true })
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("d")

      currentMockInput.pressKey("H", { shift: true })
      expect(editor.getSelectedText()).toBe("ld")

      currentMockInput.pressKey("L", { shift: true })
      expect(editor.getSelectedText()).toBe("d")
    })

    it("should execute correct action when multiple keys map to different actions with same base", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "j", action: "move-down" },
          { name: "j", ctrl: true, action: "buffer-end" },
        ],
      })

      editor.focus()

      currentMockInput.pressKey("j")
      expect(editor.logicalCursor.row).toBe(1)

      editor.gotoLine(0)
      currentMockInput.pressKey("j", { ctrl: true })
      expect(editor.logicalCursor.row).toBe(1)
    })

    it("should handle all action types via custom keybindings", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        selectable: true,
        keyBindings: [
          { name: "1", action: "move-left" },
          { name: "2", action: "move-right" },
          { name: "3", action: "move-up" },
          { name: "4", action: "move-down" },
          { name: "5", shift: true, action: "select-left" },
          { name: "6", shift: true, action: "select-right" },
          { name: "7", shift: true, action: "select-up" },
          { name: "8", shift: true, action: "select-down" },
          { name: "a", action: "line-home" },
          { name: "b", action: "line-end" },
          { name: "c", shift: true, action: "select-line-home" },
          { name: "d", shift: true, action: "select-line-end" },
          { name: "e", action: "buffer-home" },
          { name: "f", action: "buffer-end" },
          { name: "g", action: "delete-line" },
          { name: "h", action: "delete-to-line-end" },
          { name: "i", action: "backspace" },
          { name: "j", action: "delete" },
          { name: "k", action: "newline" },
          { name: "u", action: "undo" },
          { name: "r", action: "redo" },
        ],
      })

      editor.focus()
      editor.gotoLine(1)
      editor.moveCursorRight()
      editor.moveCursorRight()
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressKey("1")
      expect(editor.logicalCursor.col).toBe(1)

      currentMockInput.pressKey("2")
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressKey("3")
      expect(editor.logicalCursor.row).toBe(0)

      currentMockInput.pressKey("4")
      expect(editor.logicalCursor.row).toBe(1)

      currentMockInput.pressKey("a")
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("b")
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressKey("e")
      expect(editor.logicalCursor.row).toBe(0)

      currentMockInput.pressKey("f")
      expect(editor.logicalCursor.row).toBe(2)
    })

    it("should not break when empty keyBindings array is provided", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
        keyBindings: [],
      })

      editor.focus()

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(1)

      currentMockInput.pressKey("HOME")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should document limitation: bound character keys cannot be typed", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "h", action: "move-left" },
          { name: "j", action: "move-down" },
          { name: "k", action: "move-up" },
          { name: "l", action: "move-right" },
        ],
      })

      editor.focus()

      currentMockInput.pressKey("h")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("o")

      expect(editor.plainText).toBe("eo")
    })

    it("should allow typing bound characters when using modifier keys for bindings", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "h", ctrl: true, action: "move-left" },
          { name: "j", ctrl: true, action: "move-down" },
          { name: "k", ctrl: true, action: "move-up" },
          { name: "l", ctrl: true, action: "move-right" },
        ],
      })

      editor.focus()

      currentMockInput.pressKey("h")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("o")

      expect(editor.plainText).toBe("hello")

      currentMockInput.pressKey("h", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(4)
    })
  })

  describe("Default Word Deletion Keybindings", () => {
    it("should delete character forward with ctrl+d", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("d", { ctrl: true })
      expect(editor.plainText).toBe("ello world test")
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("d", { ctrl: true })
      expect(editor.plainText).toBe("llo world test")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should delete word backward with ctrl+w", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()
      expect(editor.logicalCursor.col).toBe(16)

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("hello world ")
      expect(editor.logicalCursor.col).toBe(12)

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("hello ")
      expect(editor.logicalCursor.col).toBe(6)
    })

    it("should stop at CJK-ASCII boundary with ctrl+w", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "日本語abc",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("日本語")

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("")
    })

    it("should keep Hangul run grouped with ctrl+w", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "테스트test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("테스트")

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("")
    })

    it("should stop at CJK punctuation before ASCII with ctrl+w", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "日本語。abc",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("日本語。")

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("")
    })

    it("should stop at compat ideograph boundary with ctrl+w", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "丽abc",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("丽")

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("")
    })

    it("should delete word forward with meta+d", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("d", { meta: true })
      expect(editor.plainText).toBe("world test")
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("d", { meta: true })
      expect(editor.plainText).toBe("test")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should delete character forward from middle of word with ctrl+d", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressKey("d", { ctrl: true })
      expect(editor.plainText).toBe("helo world")
      expect(editor.logicalCursor.col).toBe(3)
    })

    it("should delete word backward from middle of word with ctrl+w", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 8; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(8)

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("hello rld")
      expect(editor.logicalCursor.col).toBe(6)
    })

    it("should delete word forward from middle of word with meta+d", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressKey("d", { meta: true })
      expect(editor.plainText).toBe("helworld")
      expect(editor.logicalCursor.col).toBe(3)
    })

    it("should delete word forward from space with meta+d", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 5; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(5)

      currentMockInput.pressKey("d", { meta: true })
      expect(editor.plainText).toBe("hellotest")
      expect(editor.logicalCursor.col).toBe(5)
    })

    it("should delete word forward with meta+delete", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("DELETE", { meta: true })
      expect(editor.plainText).toBe("world test")
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("DELETE", { meta: true })
      expect(editor.plainText).toBe("test")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should delete word forward from middle of word with meta+delete", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressKey("DELETE", { meta: true })
      expect(editor.plainText).toBe("helworld")
      expect(editor.logicalCursor.col).toBe(3)
    })

    it("should delete word forward from space with meta+delete", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 5; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(5)

      currentMockInput.pressKey("DELETE", { meta: true })
      expect(editor.plainText).toBe("hellotest")
      expect(editor.logicalCursor.col).toBe(5)
    })

    it("should delete word forward with ctrl+delete", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("DELETE", { ctrl: true })
      expect(editor.plainText).toBe("world test")
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("DELETE", { ctrl: true })
      expect(editor.plainText).toBe("test")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should delete word forward from middle of word with ctrl+delete", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressKey("DELETE", { ctrl: true })
      expect(editor.plainText).toBe("helworld")
      expect(editor.logicalCursor.col).toBe(3)
    })

    it("should delete word forward from space with ctrl+delete", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 5; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(5)

      currentMockInput.pressKey("DELETE", { ctrl: true })
      expect(editor.plainText).toBe("hellotest")
      expect(editor.logicalCursor.col).toBe(5)
    })

    it("should delete word backward with ctrl+backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()
      expect(editor.logicalCursor.col).toBe(16)

      currentMockInput.pressBackspace({ ctrl: true })
      expect(editor.plainText).toBe("hello world ")
      expect(editor.logicalCursor.col).toBe(12)

      currentMockInput.pressBackspace({ ctrl: true })
      expect(editor.plainText).toBe("hello ")
      expect(editor.logicalCursor.col).toBe(6)
    })

    it("should delete word backward from middle of word with ctrl+backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 8; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(8)

      currentMockInput.pressBackspace({ ctrl: true })
      expect(editor.plainText).toBe("hello rld")
      expect(editor.logicalCursor.col).toBe(6)
    })

    it("should delete word backward from space with ctrl+backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressBackspace({ ctrl: true })
      expect(editor.plainText).toBe("world test")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should delete line with ctrl+shift+d (requires Kitty keyboard protocol)", async () => {
      const {
        renderer: kittyRenderer,
        renderOnce: kittyRenderOnce,
        mockInput: kittyMockInput,
      } = await createTestRenderer({
        width: 80,
        height: 24,
        kittyKeyboard: true,
      })

      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)
      expect(editor.logicalCursor.row).toBe(1)

      kittyMockInput.pressKey("d", { ctrl: true, shift: true })
      expect(editor.plainText).toBe("Line 1\nLine 3")
      expect(editor.logicalCursor.row).toBe(1)

      kittyRenderer.destroy()
    })

    it("should delete first line with ctrl+shift+d (requires Kitty keyboard protocol)", async () => {
      const {
        renderer: kittyRenderer,
        renderOnce: kittyRenderOnce,
        mockInput: kittyMockInput,
      } = await createTestRenderer({
        width: 80,
        height: 24,
        kittyKeyboard: true,
      })

      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.row).toBe(0)

      kittyMockInput.pressKey("d", { ctrl: true, shift: true })
      expect(editor.plainText).toBe("Line 2\nLine 3")
      expect(editor.logicalCursor.row).toBe(0)

      kittyRenderer.destroy()
    })

    it("should delete last line with ctrl+shift+d (requires Kitty keyboard protocol)", async () => {
      const {
        renderer: kittyRenderer,
        renderOnce: kittyRenderOnce,
        mockInput: kittyMockInput,
      } = await createTestRenderer({
        width: 80,
        height: 24,
        kittyKeyboard: true,
      })

      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(2)
      expect(editor.logicalCursor.row).toBe(2)

      kittyMockInput.pressKey("d", { ctrl: true, shift: true })
      expect(editor.plainText).toBe("Line 1\nLine 2")
      expect(editor.logicalCursor.row).toBe(1)

      kittyRenderer.destroy()
    })
  })

  describe("Default Character and Word Movement Keybindings", () => {
    it("should move forward one character with ctrl+f", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("f", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(1)

      currentMockInput.pressKey("f", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressKey("f", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(3)
    })

    it("should move backward one character with ctrl+b", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()
      expect(editor.logicalCursor.col).toBe(11)

      currentMockInput.pressKey("b", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(10)

      currentMockInput.pressKey("b", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(9)

      currentMockInput.pressKey("b", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(8)
    })

    it("should move forward one word with meta+f", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("f", { meta: true })
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressKey("f", { meta: true })
      expect(editor.logicalCursor.col).toBe(12)

      currentMockInput.pressKey("f", { meta: true })
      expect(editor.logicalCursor.col).toBe(16)
    })

    it("should move backward one word with meta+b", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()
      expect(editor.logicalCursor.col).toBe(16)

      currentMockInput.pressKey("b", { meta: true })
      expect(editor.logicalCursor.col).toBe(12)

      currentMockInput.pressKey("b", { meta: true })
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressKey("b", { meta: true })
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should move forward one word with ctrl+right", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(12)

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(16)
    })

    it("should move backward one word with ctrl+left", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()
      expect(editor.logicalCursor.col).toBe(16)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(12)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should move across CJK-ASCII boundary with ctrl+right and ctrl+left", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "日本語abc",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(9)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should move across CJK punctuation boundary with ctrl+right and ctrl+left", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "日本語。abc",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(8)

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(11)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(8)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should move across compat ideograph boundary with ctrl+right and ctrl+left", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "丽abc",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(5)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should select words across CJK-ASCII boundary with meta+shift+arrows", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "日本語abc",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      currentMockInput.pressArrow("right", { meta: true, shift: true })
      expect(editor.logicalCursor.col).toBe(6)
      expect(editor.getSelectedText()).toBe("日本語")

      currentMockInput.pressArrow("right", { meta: true, shift: true })
      expect(editor.logicalCursor.col).toBe(9)
      expect(editor.getSelectedText()).toBe("日本語abc")

      currentMockInput.pressArrow("left", { meta: true, shift: true })
      expect(editor.logicalCursor.col).toBe(6)
      expect(editor.getSelectedText()).toBe("日本語")

      currentMockInput.pressArrow("left", { meta: true, shift: true })
      expect(editor.logicalCursor.col).toBe(0)
      expect(editor.getSelectedText()).toBe("")
    })

    it("should select words across compat ideograph boundary with meta+shift+arrows", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "丽abc",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      currentMockInput.pressArrow("right", { meta: true, shift: true })
      expect(editor.logicalCursor.col).toBe(2)
      expect(editor.getSelectedText()).toBe("丽")

      currentMockInput.pressArrow("right", { meta: true, shift: true })
      expect(editor.logicalCursor.col).toBe(5)
      expect(editor.getSelectedText()).toBe("丽abc")

      currentMockInput.pressArrow("left", { meta: true, shift: true })
      expect(editor.logicalCursor.col).toBe(2)
      expect(editor.getSelectedText()).toBe("丽")

      currentMockInput.pressArrow("left", { meta: true, shift: true })
      expect(editor.logicalCursor.col).toBe(0)
      expect(editor.getSelectedText()).toBe("")
    })

    it("should combine ctrl+left and ctrl+right for word navigation", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "one two three four",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(4)

      currentMockInput.pressArrow("right", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(8)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(4)

      currentMockInput.pressArrow("left", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should not insert 'f' when using ctrl+f for movement", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "test",
        width: 40,
        height: 10,
      })

      editor.focus()
      const before = editor.plainText

      currentMockInput.pressKey("f", { ctrl: true })
      expect(editor.plainText).toBe(before)
      expect(editor.logicalCursor.col).toBe(1)
    })

    it("should not insert 'b' when using ctrl+b for movement", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()
      const before = editor.plainText

      currentMockInput.pressKey("b", { ctrl: true })
      expect(editor.plainText).toBe(before)
      expect(editor.logicalCursor.col).toBe(3)
    })

    it("should combine ctrl+f and ctrl+b for character navigation", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("f", { ctrl: true })
      currentMockInput.pressKey("f", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressKey("b", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(1)

      currentMockInput.pressKey("f", { ctrl: true })
      currentMockInput.pressKey("f", { ctrl: true })
      currentMockInput.pressKey("f", { ctrl: true })
      expect(editor.logicalCursor.col).toBe(4)
    })

    it("should combine meta+f and meta+b for word navigation", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "one two three four",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("f", { meta: true })
      expect(editor.logicalCursor.col).toBe(4)

      currentMockInput.pressKey("f", { meta: true })
      expect(editor.logicalCursor.col).toBe(8)

      currentMockInput.pressKey("b", { meta: true })
      expect(editor.logicalCursor.col).toBe(4)

      currentMockInput.pressKey("b", { meta: true })
      expect(editor.logicalCursor.col).toBe(0)
    })
  })

  describe("Shift+Space Key Handling", () => {
    let modifierRenderer: TestRenderer
    let modifierRenderOnce: () => Promise<void>
    let modifierMockInput: MockInput

    beforeEach(async () => {
      ;({
        renderer: modifierRenderer,
        renderOnce: modifierRenderOnce,
        mockInput: modifierMockInput,
      } = await createTestRenderer({
        width: 80,
        height: 24,
        otherModifiersMode: true,
      }))
    })

    afterEach(() => {
      modifierRenderer.destroy()
    })

    it("should insert a space when shift+space is pressed", async () => {
      const { textarea: editor } = await createTextareaRenderable(modifierRenderer, modifierRenderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Type "hello"
      modifierMockInput.pressKey("h")
      modifierMockInput.pressKey("e")
      modifierMockInput.pressKey("l")
      modifierMockInput.pressKey("l")
      modifierMockInput.pressKey("o")
      expect(editor.plainText).toBe("hello")

      // Press shift+space - should insert a space
      modifierMockInput.pressKey(" ", { shift: true })
      expect(editor.plainText).toBe("hello ")
      expect(editor.logicalCursor.col).toBe(6)

      // Type "world"
      modifierMockInput.pressKey("w")
      modifierMockInput.pressKey("o")
      modifierMockInput.pressKey("r")
      modifierMockInput.pressKey("l")
      modifierMockInput.pressKey("d")
      expect(editor.plainText).toBe("hello world")
    })

    it("should insert multiple spaces with shift+space", async () => {
      const { textarea: editor } = await createTextareaRenderable(modifierRenderer, modifierRenderOnce, {
        initialValue: "test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLineEnd()

      modifierMockInput.pressKey(" ", { shift: true })
      modifierMockInput.pressKey(" ", { shift: true })
      modifierMockInput.pressKey(" ", { shift: true })

      expect(editor.plainText).toBe("test   ")
      expect(editor.logicalCursor.col).toBe(7)
    })

    it("should insert space at middle of text with shift+space", async () => {
      const { textarea: editor } = await createTextareaRenderable(modifierRenderer, modifierRenderOnce, {
        initialValue: "helloworld",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 5; i++) {
        editor.moveCursorRight()
      }
      expect(editor.logicalCursor.col).toBe(5)

      modifierMockInput.pressKey(" ", { shift: true })

      expect(editor.plainText).toBe("hello world")
      expect(editor.logicalCursor.col).toBe(6)
    })
  })

  describe("Line Home/End Wrap Behavior", () => {
    it("should wrap to end of previous line when at start of line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2",
        width: 40,
        height: 10,
      })
      editor.focus()
      editor.gotoLine(1)
      expect(editor.logicalCursor).toMatchObject({ row: 1, col: 0 })
      editor.gotoLineHome()
      expect(editor.logicalCursor).toMatchObject({ row: 0, col: 6 })
    })

    it("should wrap to start of next line when at end of line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2",
        width: 40,
        height: 10,
      })
      editor.focus()
      editor.gotoLineEnd()
      expect(editor.logicalCursor).toMatchObject({ row: 0, col: 6 })
      editor.gotoLineEnd()
      expect(editor.logicalCursor).toMatchObject({ row: 1, col: 0 })
    })

    it("should stay at buffer boundaries", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2",
        width: 40,
        height: 10,
      })
      editor.focus()
      editor.gotoLineHome()
      expect(editor.logicalCursor).toMatchObject({ row: 0, col: 0 })
      editor.gotoLine(1)
      editor.gotoLineEnd()
      editor.gotoLineEnd()
      expect(editor.logicalCursor).toMatchObject({ row: 1, col: 6 })
    })
  })

  describe("Key Aliases", () => {
    it("should support binding 'enter' alias which maps to 'return'", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
        keyBindings: [{ name: "enter", action: "buffer-home" }],
      })
      editor.focus()
      editor.gotoLine(9999)
      // When user binds "enter", and "return" key is pressed (the actual Enter key)
      // it should work due to the default alias enter->return
      currentMockInput.pressEnter()
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should allow binding 'return' directly", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
        keyBindings: [{ name: "return", action: "buffer-home" }],
      })
      editor.focus()
      editor.gotoLine(9999)
      currentMockInput.pressEnter()
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should support custom aliases via keyAliasMap", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2",
        width: 40,
        height: 10,
        keyBindings: [{ name: "myenter", action: "buffer-home" }],
        keyAliasMap: { myenter: "return" },
      })
      editor.focus()
      editor.gotoLine(9999)
      // Pressing Enter key (which comes in as "return") should trigger buffer-home
      // because "myenter" is aliased to "return"
      currentMockInput.pressEnter()
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should merge custom aliases with defaults", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
        keyBindings: [
          { name: "enter", action: "buffer-home" },
          { name: "customkey", action: "line-end" },
        ],
        keyAliasMap: { customkey: "e", enter: "return" },
      })
      editor.focus()
      // Default alias should still work (enter -> return)
      currentMockInput.pressEnter()
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
      // Custom alias should work (customkey -> e)
      currentMockInput.pressKey("e")
      expect(editor.logicalCursor.col).toBe(5)
    })

    it("should update aliases dynamically with setter", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2",
        width: 40,
        height: 10,
        keyBindings: [{ name: "mykey", action: "buffer-home" }],
      })
      editor.focus()
      editor.gotoLine(9999)
      expect(editor.logicalCursor.row).toBe(1)
      // Initially "mykey" doesn't map to "return", so Enter won't trigger buffer-home
      currentMockInput.pressEnter()
      expect(editor.plainText).toBe("Line 1\nLine 2\n") // newline was inserted
      // Set alias to map "mykey" to "return"
      editor.keyAliasMap = { mykey: "return" }
      // Now remove the newline we just added
      editor.deleteCharBackward()
      // Now pressing Enter should trigger buffer-home
      currentMockInput.pressEnter()
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should handle aliases with modifiers", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2",
        width: 40,
        height: 10,
        keyBindings: [{ name: "enter", meta: true, action: "buffer-home" }],
      })
      editor.focus()
      editor.gotoLine(9999)
      expect(editor.logicalCursor.row).toBe(1)
      // Meta+Enter should trigger buffer-home due to alias (enter -> return)
      currentMockInput.pressEnter({ meta: true })
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })
  })

  describe("Kitty keypad input", () => {
    let kittyRenderer: TestRenderer
    let kittyRenderOnce: () => Promise<void>

    beforeEach(async () => {
      ;({ renderer: kittyRenderer, renderOnce: kittyRenderOnce } = await createTestRenderer({
        width: 80,
        height: 24,
        kittyKeyboard: true,
      }))
    })

    afterEach(() => {
      kittyRenderer.destroy()
    })

    const pressKittyKey = async (sequence: string): Promise<void> => {
      await new Promise<void>((resolve) => {
        kittyRenderer.keyInput.once("keypress", () => {
          resolve()
        })

        kittyRenderer.stdin.emit("data", Buffer.from(sequence))
      })

      await Promise.resolve()
    }

    it("should insert printable keypad keys and handle keypad enter", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        width: 80,
        height: 10,
      })

      editor.focus()

      const printableKeypadKeys = [
        "\x1b[57399u",
        "\x1b[57400u",
        "\x1b[57401u",
        "\x1b[57402u",
        "\x1b[57403u",
        "\x1b[57404u",
        "\x1b[57405u",
        "\x1b[57406u",
        "\x1b[57407u",
        "\x1b[57408u",
        "\x1b[57409u",
        "\x1b[57410u",
        "\x1b[57411u",
        "\x1b[57412u",
        "\x1b[57413u",
        "\x1b[57415u",
        "\x1b[57416u",
      ]

      for (const sequence of printableKeypadKeys) {
        await pressKittyKey(sequence)
      }

      expect(editor.plainText).toBe("0123456789./*-+=,")

      await pressKittyKey("\x1b[57400;5u")
      expect(editor.plainText).toBe("0123456789./*-+=,")

      await pressKittyKey("\x1b[57414u")
      expect(editor.plainText).toBe("0123456789./*-+=,\n")
    })

    it("should submit on meta keypad enter", async () => {
      let submitCount = 0
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        width: 80,
        height: 10,
        onSubmit: () => {
          submitCount += 1
        },
      })

      editor.focus()

      await pressKittyKey("\x1b[57414;3u")

      expect(submitCount).toBe(1)
      expect(editor.plainText).toBe("")
    })
  })

  describe("Selection with ctrl+shift+a/e (line home/end)", () => {
    let kittyRenderer: TestRenderer
    let kittyRenderOnce: () => Promise<void>
    let kittyMockInput: MockInput

    beforeEach(async () => {
      ;({
        renderer: kittyRenderer,
        renderOnce: kittyRenderOnce,
        mockInput: kittyMockInput,
      } = await createTestRenderer({
        width: 80,
        height: 24,
        kittyKeyboard: true,
      }))
    })

    afterEach(() => {
      kittyRenderer.destroy()
    })

    it("should select to line start with ctrl+shift+a", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 11) // End of line

      kittyMockInput.pressKey("a", { ctrl: true, shift: true })

      expect(editor.hasSelection()).toBe(true)
      const selection = editor.getSelection()
      expect(selection).not.toBeNull()
      expect(selection!.start).toBe(0)
      expect(selection!.end).toBe(11)
      expect(editor.getSelectedText()).toBe("Hello World")
    })

    it("should select to line end with ctrl+shift+e", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 0) // Start of line

      kittyMockInput.pressKey("e", { ctrl: true, shift: true })

      expect(editor.hasSelection()).toBe(true)
      const selection = editor.getSelection()
      expect(selection).not.toBeNull()
      expect(selection!.start).toBe(0)
      expect(selection!.end).toBe(11)
      expect(editor.getSelectedText()).toBe("Hello World")
    })

    it("should select to line start from middle with ctrl+shift+a", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 6) // After "Hello "

      kittyMockInput.pressKey("a", { ctrl: true, shift: true })

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello W")
    })

    it("should select to line end from middle with ctrl+shift+e", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 6) // After "Hello "

      kittyMockInput.pressKey("e", { ctrl: true, shift: true })

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("World")
    })

    it("should work on multiline text", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.editBuffer.setCursor(1, 4) // Middle of second line

      // Select to start of line 2
      kittyMockInput.pressKey("a", { ctrl: true, shift: true })
      expect(editor.getSelectedText()).toBe("Line ")

      // Clear selection and move to same position
      editor.editBuffer.setCursor(1, 4)

      // Select to end of line 2
      kittyMockInput.pressKey("e", { ctrl: true, shift: true })
      expect(editor.getSelectedText()).toBe(" 2")
    })

    it("should handle line wrapping behavior", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "Line 1\nLine 2",
        width: 40,
        height: 10,
      })

      editor.focus()
      // At end of line 1
      editor.editBuffer.setCursor(0, 6)

      // First ctrl+shift+a from EOL selects through the line break at EOL
      kittyMockInput.pressKey("a", { ctrl: true, shift: true })
      expect(editor.getSelectedText()).toBe("Line 1\n")

      // Reset
      editor.editBuffer.setCursor(0, 0)

      // From start, ctrl+shift+e should select line, then wrap to next line
      kittyMockInput.pressKey("e", { ctrl: true, shift: true })
      const cursor = editor.editBuffer.getCursorPosition()
      expect(cursor.col).toBeGreaterThan(0)
    })

    it("should not interfere with ctrl+a (without shift)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 11)

      // ctrl+a (without shift) should just move, not select
      currentMockInput.pressKey("a", { ctrl: true })

      expect(editor.hasSelection()).toBe(false)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should not interfere with ctrl+e (without shift)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 0)

      // ctrl+e (without shift) should just move, not select
      currentMockInput.pressKey("e", { ctrl: true })

      expect(editor.hasSelection()).toBe(false)
      expect(editor.logicalCursor.col).toBe(11)
    })
  })

  describe("Visual line navigation with meta+a/e", () => {
    it("should navigate to visual line start with meta+a (no wrapping)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        wrapMode: "none",
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 6)

      currentMockInput.pressKey("a", { meta: true })

      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should navigate to visual line end with meta+e (no wrapping)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        wrapMode: "none",
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 6)

      currentMockInput.pressKey("e", { meta: true })

      expect(editor.logicalCursor.col).toBe(11)
    })

    it("should navigate to visual line start with meta+a (with wrapping)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 22) // In second visual line

      currentMockInput.pressKey("a", { meta: true })

      const cursor = editor.logicalCursor
      expect(cursor.col).toBe(20) // Start of second visual line, not 0
    })

    it("should navigate to visual line end with meta+e (with wrapping)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 5) // In first visual line

      currentMockInput.pressKey("e", { meta: true })

      const cursor = editor.logicalCursor
      expect(cursor.col).toBe(19)
    })

    it("should differ from ctrl+a/e when wrapping is enabled", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 22)

      // meta+a goes to visual line start (col 20)
      currentMockInput.pressKey("a", { meta: true })
      const visualHomeCol = editor.logicalCursor.col
      expect(visualHomeCol).toBe(20)

      // Reset cursor
      editor.editBuffer.setCursor(0, 22)

      // ctrl+a goes to logical line start (col 0)
      currentMockInput.pressKey("a", { ctrl: true })
      const logicalHomeCol = editor.logicalCursor.col
      expect(logicalHomeCol).toBe(0)

      expect(visualHomeCol).not.toBe(logicalHomeCol)
    })
  })

  describe("Visual line selection with meta+shift+a/e", () => {
    let kittyRenderer: TestRenderer
    let kittyRenderOnce: () => Promise<void>
    let kittyMockInput: MockInput

    beforeEach(async () => {
      ;({
        renderer: kittyRenderer,
        renderOnce: kittyRenderOnce,
        mockInput: kittyMockInput,
      } = await createTestRenderer({
        width: 80,
        height: 24,
        kittyKeyboard: true,
      }))
    })

    afterEach(() => {
      kittyRenderer.destroy()
    })

    it("should select to visual line start with meta+shift+a", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 25) // In second visual line

      kittyMockInput.pressKey("a", { meta: true, shift: true })

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()
      expect(selectedText.length).toBe(6) // From col 20 to 26 (includes char at 25)
    })

    it("should select to visual line end with meta+shift+e", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 10) // In first visual line

      kittyMockInput.pressKey("e", { meta: true, shift: true })

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()
      expect(selectedText).toBe("KLMNOPQRS")
    })

    it("should work without wrapping (same as logical)", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        wrapMode: "none",
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 6)

      kittyMockInput.pressKey("a", { meta: true, shift: true })
      expect(editor.getSelectedText()).toBe("Hello W")

      editor.editBuffer.setCursor(0, 6)
      kittyMockInput.pressKey("e", { meta: true, shift: true })
      expect(editor.getSelectedText()).toBe("World")
    })

    it("should differ from ctrl+shift+a/e when wrapping is enabled", async () => {
      const { textarea: editor } = await createTextareaRenderable(kittyRenderer, kittyRenderOnce, {
        initialValue: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      editor.focus()
      editor.editBuffer.setCursor(0, 25) // In second visual line

      // meta+shift+a selects to visual line start
      kittyMockInput.pressKey("a", { meta: true, shift: true })
      const visualSelection = editor.getSelectedText()
      expect(visualSelection.length).toBe(6) // From 20 to 26

      // Reset
      editor.editBuffer.setCursor(0, 25)

      // ctrl+shift+a selects to logical line start
      kittyMockInput.pressKey("a", { ctrl: true, shift: true })
      const logicalSelection = editor.getSelectedText()
      expect(logicalSelection.length).toBe(26) // From 0 to 26

      expect(visualSelection).not.toBe(logicalSelection)
    })
  })
})
