import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"
import { TextareaRenderable } from "../Textarea.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput

describe("Textarea - Editing Tests", () => {
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

  describe("Initialization", () => {
    it("should initialize with default options", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 40,
        height: 10,
      })

      expect(editor.x).toBeDefined()
      expect(editor.y).toBeDefined()
      expect(editor.width).toBeGreaterThan(0)
      expect(editor.height).toBeGreaterThan(0)
      expect(editor.focusable).toBe(true)
    })

    it("should initialize with content", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      expect(editor.plainText).toBe("Hello World")
    })

    it("should initialize with empty content", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      expect(editor.plainText).toBe("")
    })

    it("should initialize with multi-line content", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      expect(editor.plainText).toBe("Line 1\nLine 2\nLine 3")
    })
  })

  describe("Focus Management", () => {
    it("should handle focus and blur", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "test",
        width: 40,
        height: 10,
      })

      expect(editor.focused).toBe(false)

      editor.focus()
      expect(editor.focused).toBe(true)

      editor.blur()
      expect(editor.focused).toBe(false)
    })
  })

  describe("Text Insertion via Methods", () => {
    it("should insert single character", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.gotoLine(9999) // Move to end
      editor.insertChar("!")

      expect(editor.plainText).toBe("Hello!")
    })

    it("should insert text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.gotoLine(9999) // Move to end
      editor.insertText(" World")

      expect(editor.plainText).toBe("Hello World")
    })

    it("should insert text in middle", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "HelloWorld",
        width: 40,
        height: 10,
      })

      editor.moveCursorRight()
      editor.moveCursorRight()
      editor.moveCursorRight()
      editor.moveCursorRight()
      editor.moveCursorRight()
      editor.insertText(" ")

      expect(editor.plainText).toBe("Hello World")
    })
  })

  describe("Text Deletion via Methods", () => {
    it("should delete character at cursor", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      // Move to 'W' and delete it
      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }
      editor.deleteChar()

      expect(editor.plainText).toBe("Hello orld")
    })

    it("should delete character backward", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.gotoLine(9999) // Move to end
      editor.deleteCharBackward()

      expect(editor.plainText).toBe("Hell")
    })

    it("should delete entire line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.gotoLine(1)
      editor.deleteLine()

      expect(editor.plainText).toBe("Line 1\nLine 3")
    })

    it("should delete to line end", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }
      editor.deleteToLineEnd()

      expect(editor.plainText).toBe("Hello ")
    })

    it("should delete to line start from middle of line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }
      editor.deleteToLineStart()

      expect(editor.plainText).toBe("World")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should join with previous line when deleteToLineStart at col 0", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.gotoLine(1)
      editor.deleteToLineStart()

      expect(editor.plainText).toBe("Line 1Line 2\nLine 3")
    })

    it("should not delete when deleteToLineStart at row 0 col 0", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.deleteToLineStart()

      expect(editor.plainText).toBe("Hello World")
      expect(editor.logicalCursor.col).toBe(0)
      expect(editor.logicalCursor.row).toBe(0)
    })

    it("should repeatedly delete lines with deleteToLineStart", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3\nLine 4",
        width: 40,
        height: 10,
      })

      // Move to end of line 3 (not the last line)
      editor.gotoLine(2)
      editor.gotoLineEnd()

      // First press: clear "Line 3" content
      editor.deleteToLineStart()
      expect(editor.plainText).toBe("Line 1\nLine 2\n\nLine 4")
      expect(editor.logicalCursor.row).toBe(2)
      expect(editor.logicalCursor.col).toBe(0)

      // Second press: join with previous line (delete newline)
      editor.deleteToLineStart()
      expect(editor.plainText).toBe("Line 1\nLine 2\nLine 4")
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(6)

      // Third press: clear "Line 2" content
      editor.deleteToLineStart()
      expect(editor.plainText).toBe("Line 1\n\nLine 4")
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(0)

      // Fourth press: join with first line
      editor.deleteToLineStart()
      expect(editor.plainText).toBe("Line 1\nLine 4")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(6)
    })
  })

  describe("Cursor Movement via Methods", () => {
    it("should move cursor left and right", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABCDE",
        width: 40,
        height: 10,
      })

      const initialCursor = editor.logicalCursor
      expect(initialCursor.col).toBe(0)

      editor.moveCursorRight()
      expect(editor.logicalCursor.col).toBe(1)

      editor.moveCursorRight()
      expect(editor.logicalCursor.col).toBe(2)

      editor.moveCursorLeft()
      expect(editor.logicalCursor.col).toBe(1)
    })

    it("should move cursor up and down", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      expect(editor.logicalCursor.row).toBe(0)

      editor.moveCursorDown()
      expect(editor.logicalCursor.row).toBe(1)

      editor.moveCursorDown()
      expect(editor.logicalCursor.row).toBe(2)

      editor.moveCursorUp()
      expect(editor.logicalCursor.row).toBe(1)
    })

    it("should move to line start and end", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      const cursor = editor.logicalCursor
      editor.editBuffer.setCursorToLineCol(cursor.row, 9999) // Move to end of line
      expect(editor.logicalCursor.col).toBe(11)

      editor.editBuffer.setCursor(editor.logicalCursor.row, 0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should move to buffer start and end", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.gotoLine(9999) // Move to end
      let cursor = editor.logicalCursor
      expect(cursor.row).toBe(2)

      editor.gotoLine(0) // Move to start
      cursor = editor.logicalCursor
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
    })

    it("should goto specific line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 0\nLine 1\nLine 2",
        width: 40,
        height: 10,
      })

      editor.gotoLine(1)
      expect(editor.logicalCursor.row).toBe(1)

      editor.gotoLine(2)
      expect(editor.logicalCursor.row).toBe(2)
    })
  })

  describe("Keyboard Input - Character Insertion", () => {
    it("should insert character when key is pressed", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("h")
      expect(editor.plainText).toBe("h")

      currentMockInput.pressKey("i")
      expect(editor.plainText).toBe("hi")
    })

    it("should insert multiple characters in sequence", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("h")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("o")

      expect(editor.plainText).toBe("hello")
    })

    it("should insert space character", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      currentMockInput.pressKey(" ")
      currentMockInput.pressKey("W")
      currentMockInput.pressKey("o")
      currentMockInput.pressKey("r")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("d")

      expect(editor.plainText).toBe("Hello World")
    })

    it("should not insert when not focused", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      // Don't focus
      expect(editor.focused).toBe(false)

      currentMockInput.pressKey("a")
      expect(editor.plainText).toBe("")
    })
  })

  describe("Keyboard Input - Arrow Keys", () => {
    it("should move cursor left with arrow key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressArrow("left")
      expect(editor.logicalCursor.col).toBe(2)

      currentMockInput.pressArrow("left")
      expect(editor.logicalCursor.col).toBe(1)
    })

    it("should move cursor right with arrow key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(1)

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(2)
    })

    it("should move cursor up and down with arrow keys", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.row).toBe(0)

      currentMockInput.pressArrow("down")
      expect(editor.logicalCursor.row).toBe(1)

      currentMockInput.pressArrow("down")
      expect(editor.logicalCursor.row).toBe(2)

      currentMockInput.pressArrow("up")
      expect(editor.logicalCursor.row).toBe(1)
    })

    it("should move cursor smoothly from end of one line to start of next", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC\nDEF",
        width: 40,
        height: 10,
      })

      editor.focus()
      const cursor = editor.logicalCursor
      editor.editBuffer.setCursorToLineCol(cursor.row, 9999) // Move to end of line // End of "ABC"
      expect(editor.logicalCursor.col).toBe(3)

      // Move right should go to start of next line
      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(0)

      // Move left should go back to end of previous line
      currentMockInput.pressArrow("left")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(3)
    })
  })

  describe("Keyboard Input - Backspace and Delete", () => {
    it("should handle backspace key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Hell")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Hel")
    })

    it("should handle delete key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      // Cursor at start

      currentMockInput.pressKey("DELETE")
      expect(editor.plainText).toBe("ello")
    })

    it("should join lines when backspace at start of line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello\nWorld",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1) // Move to line 2 (0-indexed line 1)
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("HelloWorld")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(5) // Should be at end of "Hello"
    })

    it("should remove empty line when backspace at start", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello\n\nWorld",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1) // Move to empty line
      expect(editor.logicalCursor.row).toBe(1)

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Hello\nWorld")
      expect(editor.logicalCursor.row).toBe(0)
    })

    it("should join lines with content when backspace at start", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line1\nLine2\nLine3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(2) // Move to "Line3"
      expect(editor.logicalCursor.row).toBe(2)
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Line1\nLine2Line3")
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(5) // After "Line2"
    })

    it("should not do anything when backspace at start of first line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello\nWorld",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Hello\nWorld")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should handle multiple backspaces joining multiple lines", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "A\nB\nC\nD",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(3) // Line "D"
      expect(editor.logicalCursor.row).toBe(3)
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("A\nB\nCD")
      expect(editor.logicalCursor.row).toBe(2)
      // Cursor should be at the join point (after "C")
      expect(editor.logicalCursor.col).toBe(1)

      // Now delete "C" by pressing backspace
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("A\nB\nD")
      expect(editor.logicalCursor.row).toBe(2)
      expect(editor.logicalCursor.col).toBe(0)

      // Now join line 2 with line 1
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("A\nBD")
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(1) // After "B"

      // Delete "B"
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("A\nD")
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(0)

      // Now join line 1 with line 0
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("AD")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(1)
    })

    it("should handle backspace after typing on new line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      currentMockInput.pressEnter()
      expect(editor.plainText).toBe("Hello\n")

      currentMockInput.pressKey("W")
      currentMockInput.pressKey("o")
      currentMockInput.pressKey("r")
      expect(editor.plainText).toBe("Hello\nWor")

      // Now backspace to delete "r"
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Hello\nWo")

      // Move to start of line and backspace to join
      editor.editBuffer.setCursor(editor.logicalCursor.row, 0)
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("HelloWo")
    })

    it("should move cursor right after joining lines with backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello\nWorld",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1) // Move to "World"
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(0)

      // Join lines with backspace
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("HelloWorld")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(5) // After "Hello"

      // Press right repeatedly - should advance one at a time
      const positions: number[] = [editor.logicalCursor.col]
      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right")
        positions.push(editor.logicalCursor.col)
      }

      // Should advance one position each time: [5, 6, 7, 8, 9, 10]
      expect(positions).toEqual([5, 6, 7, 8, 9, 10])
    })

    it("should move right one position after join", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AB\nCD",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)

      // Backspace to join
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCD")
      expect(editor.logicalCursor.col).toBe(2)

      // Press right - should advance by 1
      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(3)
    })

    it("should advance cursor by 1 at every position after join", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABCDE\nFGHIJ",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)

      // Join lines
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCDEFGHIJ")
      expect(editor.logicalCursor.col).toBe(5)

      // Each right press should advance by exactly 1
      const expectedPositions = [5, 6, 7, 8, 9, 10]

      for (let i = 0; i < expectedPositions.length; i++) {
        expect(editor.logicalCursor.col).toBe(expectedPositions[i])
        if (i < expectedPositions.length - 1) {
          currentMockInput.pressArrow("right")
        }
      }
    })

    it("should move right after backspace join - setText content", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC\nDEF",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCDEF")
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(4)
    })

    it("should move right after backspace join - typed content", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Type "ABC", Enter, "DEF"
      currentMockInput.pressKey("A")
      currentMockInput.pressKey("B")
      currentMockInput.pressKey("C")
      currentMockInput.pressEnter()
      currentMockInput.pressKey("D")
      currentMockInput.pressKey("E")
      currentMockInput.pressKey("F")

      // Join and verify cursor advances
      editor.editBuffer.setCursor(editor.logicalCursor.row, 0)
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCDEF")
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(4)

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(5)
    })

    it("should move cursor left after joining lines with backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC\nDEF",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1) // Move to "DEF"

      // Join lines
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCDEF")
      expect(editor.logicalCursor.col).toBe(3) // After "ABC"

      // Move right past the boundary
      currentMockInput.pressArrow("right")
      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(5)

      // Now move left - should move smoothly back one at a time
      const positions: number[] = [editor.logicalCursor.col]
      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("left")
        positions.push(editor.logicalCursor.col)
      }

      // Should go back one at a time: [5, 4, 3, 2, 1, 0]
      expect(positions).toEqual([5, 4, 3, 2, 1, 0])
    })

    it("should move cursor left across chunk boundaries after joining lines", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC\nDEF",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1) // Move to "DEF"

      // Join lines
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCDEF")
      expect(editor.logicalCursor.col).toBe(3) // After "ABC"

      // Move right to "D"
      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(4)

      // Move right to "E"
      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(5)

      // Now move left back across the chunk boundary
      currentMockInput.pressArrow("left")
      expect(editor.logicalCursor.col).toBe(4)

      currentMockInput.pressArrow("left")
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressArrow("left")
      expect(editor.logicalCursor.col).toBe(2)
    })

    it("should handle shift+backspace same as backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("Hello Worl")

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("Hello Wor")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Hello Wo")
    })

    it("should join lines with shift+backspace at start of line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "First\nSecond",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("FirstSecond")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(5)
    })

    it("should handle shift+backspace with selection", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()

      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }
      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello ")

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("World")
      expect(editor.hasSelection()).toBe(false)
    })

    it("should delete characters consistently with shift+backspace after typing", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("T")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("s")
      currentMockInput.pressKey("t")
      expect(editor.plainText).toBe("Test")

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("Tes")

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("Te")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("T")

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("")
    })

    it("should not differentiate between backspace and shift+backspace behavior", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABCDEF",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCDE")

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("ABCD")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABC")

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("AB")
    })

    it("should handle shift+backspace at start of buffer", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("Test")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should handle alternating backspace and shift+backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "123456",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)
      expect(editor.plainText).toBe("123456")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("12345")

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("1234")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("123")

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("12")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("1")

      currentMockInput.pressKey("BACKSPACE", { shift: true })
      expect(editor.plainText).toBe("")
    })
  })

  describe("Keyboard Input - Kitty Keyboard Protocol", () => {
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

    it("should handle shift+backspace in kitty mode", async () => {
      const textarea = new TextareaRenderable(kittyRenderer, {
        left: 0,
        top: 0,
        width: 40,
        height: 10,
        initialValue: "Hello World",
      })
      kittyRenderer.root.add(textarea)
      await kittyRenderOnce()

      textarea.focus()
      textarea.gotoLine(9999)

      kittyMockInput.pressKey("BACKSPACE", { shift: true })
      expect(textarea.plainText).toBe("Hello Worl")

      kittyMockInput.pressKey("BACKSPACE", { shift: true })
      expect(textarea.plainText).toBe("Hello Wor")
    })

    it("should handle shift+backspace joining lines in kitty mode", async () => {
      const textarea = new TextareaRenderable(kittyRenderer, {
        left: 0,
        top: 0,
        width: 40,
        height: 10,
        initialValue: "Line1\nLine2",
      })
      kittyRenderer.root.add(textarea)
      await kittyRenderOnce()

      textarea.focus()
      textarea.gotoLine(1)

      kittyMockInput.pressKey("BACKSPACE", { shift: true })
      expect(textarea.plainText).toBe("Line1Line2")
      expect(textarea.logicalCursor.row).toBe(0)
      expect(textarea.logicalCursor.col).toBe(5)
    })

    it("should handle shift+backspace with selection in kitty mode", async () => {
      const textarea = new TextareaRenderable(kittyRenderer, {
        left: 0,
        top: 0,
        width: 40,
        height: 10,
        initialValue: "Hello World",
      })
      kittyRenderer.root.add(textarea)
      await kittyRenderOnce()

      textarea.focus()

      for (let i = 0; i < 5; i++) {
        kittyMockInput.pressArrow("right", { shift: true })
      }
      expect(textarea.hasSelection()).toBe(true)
      expect(textarea.getSelectedText()).toBe("Hello ")

      kittyMockInput.pressKey("BACKSPACE", { shift: true })
      expect(textarea.plainText).toBe("World")
      expect(textarea.hasSelection()).toBe(false)
    })

    it("should distinguish backspace vs shift+backspace keybindings in kitty mode", async () => {
      const textarea = new TextareaRenderable(kittyRenderer, {
        left: 0,
        top: 0,
        width: 40,
        height: 10,
        initialValue: "ABC",
      })
      kittyRenderer.root.add(textarea)
      await kittyRenderOnce()

      textarea.focus()
      textarea.gotoLine(9999)

      kittyMockInput.pressBackspace()
      expect(textarea.plainText).toBe("AB")

      kittyMockInput.pressKey("BACKSPACE", { shift: true })
      expect(textarea.plainText).toBe("A")
    })

    it("should handle mixed backspace and shift+backspace in kitty mode", async () => {
      const textarea = new TextareaRenderable(kittyRenderer, {
        left: 0,
        top: 0,
        width: 40,
        height: 10,
        initialValue: "123456",
      })
      kittyRenderer.root.add(textarea)
      await kittyRenderOnce()

      textarea.focus()
      textarea.gotoLine(9999)

      kittyMockInput.pressBackspace()
      kittyMockInput.pressKey("BACKSPACE", { shift: true })
      kittyMockInput.pressBackspace()
      kittyMockInput.pressKey("BACKSPACE", { shift: true })

      expect(textarea.plainText).toBe("12")
    })

    it("should handle shift+delete in kitty mode", async () => {
      const textarea = new TextareaRenderable(kittyRenderer, {
        left: 0,
        top: 0,
        width: 40,
        height: 10,
        initialValue: "Hello",
      })
      kittyRenderer.root.add(textarea)
      await kittyRenderOnce()

      textarea.focus()

      kittyMockInput.pressKey("DELETE", { shift: true })
      expect(textarea.plainText).toBe("ello")
    })

    it("should handle ctrl+backspace for word deletion in kitty mode", async () => {
      const textarea = new TextareaRenderable(kittyRenderer, {
        left: 0,
        top: 0,
        width: 40,
        height: 10,
        initialValue: "hello world test",
      })
      kittyRenderer.root.add(textarea)
      await kittyRenderOnce()

      textarea.focus()
      textarea.gotoLine(9999)

      kittyMockInput.pressKey("w", { ctrl: true })
      expect(textarea.plainText).toBe("hello world ")
    })

    it("should handle meta+backspace for word deletion in kitty mode", async () => {
      const textarea = new TextareaRenderable(kittyRenderer, {
        left: 0,
        top: 0,
        width: 40,
        height: 10,
        initialValue: "hello world test",
      })
      kittyRenderer.root.add(textarea)
      await kittyRenderOnce()

      textarea.focus()
      textarea.gotoLine(9999)

      kittyMockInput.pressBackspace({ meta: true })
      const text = textarea.plainText
      expect(text.startsWith("hello world")).toBe(true)
      expect(text.length).toBeLessThan(16)
    })
  })

  describe("Keyboard Input - Enter/Return", () => {
    it("should insert newline with Enter key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "HelloWorld",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Move to middle
      for (let i = 0; i < 5; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressEnter()
      expect(editor.plainText).toBe("Hello\nWorld")
    })

    it("should insert newline at end", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      currentMockInput.pressEnter()
      expect(editor.plainText).toBe("Hello\n")
    })

    it("should handle multiple newlines", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line1",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      currentMockInput.pressEnter()
      currentMockInput.pressKey("L")
      currentMockInput.pressKey("i")
      currentMockInput.pressKey("n")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("2")

      expect(editor.plainText).toBe("Line1\nLine2")
    })
  })

  describe("Keyboard Input - Home and End", () => {
    it("should move to line start with Home", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end
      expect(editor.logicalCursor.col).toBe(11)

      currentMockInput.pressKey("HOME")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should move to line end with End", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("END")
      expect(editor.logicalCursor.col).toBe(11)
    })
  })

  describe("Keyboard Input - Control Commands", () => {
    it("should move to line start with Ctrl+A", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1) // Move to line 2
      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight() // Move to middle of line
      }
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressKey("a", { ctrl: true })
      const cursor = editor.logicalCursor
      expect(cursor.row).toBe(1) // Should stay on same line
      expect(cursor.col).toBe(0) // Should move to start of line
    })

    it("should move to line end with Ctrl+E", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1) // Move to line 2

      currentMockInput.pressKey("e", { ctrl: true })
      const cursor = editor.logicalCursor
      expect(cursor.row).toBe(1) // Should stay on same line
      expect(cursor.col).toBe(6) // "Line 2" is 6 chars
    })

    it("should delete character forward with Ctrl+D", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)

      currentMockInput.pressKey("d", { ctrl: true })
      expect(editor.plainText).toBe("Line 1\nine 2\nLine 3")
    })

    it("should delete to line end with Ctrl+K", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
      })

      editor.focus()
      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("k", { ctrl: true })
      expect(editor.plainText).toBe("Hello ")
    })

    it("should move to buffer start with Home key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(2) // Move to line 3
      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight() // Move to middle of line
      }
      expect(editor.logicalCursor.row).toBe(2)
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressKey("HOME")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should move to buffer end with End key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)

      currentMockInput.pressKey("END")
      expect(editor.logicalCursor.row).toBe(2)
      expect(editor.logicalCursor.col).toBe(6) // "Line 3" is 6 chars
    })

    it("should select from cursor to buffer start with Home+Shift", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1) // Move to line 2
      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight() // Move to "Lin|e 2"
      }
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressKey("HOME", { shift: true })
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)

      const selection = editor.getSelection()
      expect(selection).not.toBeNull()
      expect(selection!.start).toBe(0) // Selection starts at buffer start
      // Selection should include everything from buffer start to original cursor position
      // gotoLine(1) positions at end of line, moveCursorRight 3 times goes to col 3 of next line
      // Selection from buffer start to cursor includes "Line 1\nLine" (one more than "Lin" due to cursor position)
      expect(editor.getSelectedText()).toBe("Line 1\nLine")
    })

    it("should select from cursor to buffer end with End+Shift", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1) // Move to line 2
      for (let i = 0; i < 3; i++) {
        editor.moveCursorRight() // Move to "Lin|e 2"
      }
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressKey("END", { shift: true })
      expect(editor.logicalCursor.row).toBe(2)
      expect(editor.logicalCursor.col).toBe(6)

      const selection = editor.getSelection()
      expect(selection).not.toBeNull()
      // Selection should include everything from original cursor position to buffer end
      expect(editor.getSelectedText()).toBe("e 2\nLine 3")
    })
  })

  describe("Word Movement and Deletion", () => {
    it("should move forward by word with Alt+F", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world foo bar",
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

    it("should move backward by word with Alt+B", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world foo bar",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)
      expect(editor.logicalCursor.col).toBe(19)

      currentMockInput.pressKey("b", { meta: true })
      expect(editor.logicalCursor.col).toBe(16)

      currentMockInput.pressKey("b", { meta: true })
      expect(editor.logicalCursor.col).toBe(12)

      currentMockInput.pressKey("b", { meta: true })
      expect(editor.logicalCursor.col).toBe(6)
    })

    it("should move forward by word with Meta+Right", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "one two three",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressArrow("right", { meta: true })
      expect(editor.logicalCursor.col).toBe(4)

      currentMockInput.pressArrow("right", { meta: true })
      expect(editor.logicalCursor.col).toBe(8)
    })

    it("should move backward by word with Meta+Left", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "one two three",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)

      currentMockInput.pressArrow("left", { meta: true })
      expect(editor.logicalCursor.col).toBe(8)

      currentMockInput.pressArrow("left", { meta: true })
      expect(editor.logicalCursor.col).toBe(4)
    })

    it("should delete word forward with Alt+D", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world foo",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.plainText).toBe("hello world foo")

      currentMockInput.pressKey("d", { meta: true })
      expect(editor.plainText).toBe("world foo")
    })

    it("should delete word backward with Alt+Backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world foo",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)

      currentMockInput.pressBackspace({ meta: true })
      const text = editor.plainText
      expect(text.startsWith("hello world")).toBe(true)
      expect(text.length).toBeLessThan(15)
    })

    it("should delete word backward with Ctrl+W", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "test string here",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999)

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("test string ")

      currentMockInput.pressKey("w", { ctrl: true })
      expect(editor.plainText).toBe("test ")
    })

    it("should delete line with Ctrl+Shift+D (requires Kitty keyboard protocol)", async () => {
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

      kittyMockInput.pressKey("d", { ctrl: true, shift: true })
      expect(editor.plainText).toBe("Line 1\nLine 3")

      kittyRenderer.destroy()
    })

    it("should handle word movement across multiple lines", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "first line\nsecond line",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("f", { meta: true })
      expect(editor.logicalCursor.col).toBe(6)

      currentMockInput.pressKey("f", { meta: true })
      expect(editor.logicalCursor.row).toBe(1)
    })

    it("should delete word forward from line start", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello\nworld test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(1)
      const initialLength = editor.plainText.length

      currentMockInput.pressKey("d", { meta: true })
      expect(editor.plainText.length).toBeLessThan(initialLength)
      expect(editor.plainText).toContain("hello")
    })

    it("should handle word deletion operations with Alt+D", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world test",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("d", { meta: true })
      expect(editor.plainText).toBe("world test")
    })

    it("should navigate by words and characters", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "abc def ghi",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("f", { meta: true })
      const col1 = editor.logicalCursor.col
      expect(col1).toBeGreaterThan(0)

      currentMockInput.pressArrow("right")
      const col2 = editor.logicalCursor.col
      expect(col2).toBe(col1 + 1)

      currentMockInput.pressKey("f", { meta: true })
      const col3 = editor.logicalCursor.col
      expect(col3).toBeGreaterThan(col2)
    })

    it("should delete word forward even with selection when using meta+d", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "hello world foo",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })
      currentMockInput.pressArrow("right", { shift: true })
      expect(editor.hasSelection()).toBe(true)

      currentMockInput.pressKey("d", { meta: true })
      expect(editor.plainText).toBe("o world foo")
    })
  })

  describe("Chunk Boundary Navigation", () => {
    it("should move cursor across chunks created by insertions", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Insert "Hello"
      currentMockInput.pressKey("H")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("o")
      expect(editor.plainText).toBe("Hello")
      expect(editor.logicalCursor.col).toBe(5)

      // Move cursor back to position 2
      for (let i = 0; i < 3; i++) {
        currentMockInput.pressArrow("left")
      }
      expect(editor.logicalCursor.col).toBe(2)

      // Insert "XXX" - this creates a new chunk in the middle
      currentMockInput.pressKey("X")
      currentMockInput.pressKey("X")
      currentMockInput.pressKey("X")
      expect(editor.plainText).toBe("HeXXXllo")
      expect(editor.logicalCursor.col).toBe(5)

      // Now move right - should move smoothly across chunk boundaries
      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(6) // "l"

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(7) // "l"

      currentMockInput.pressArrow("right")
      expect(editor.logicalCursor.col).toBe(8) // "o"
    })

    it("should move cursor left across multiple chunks", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      // Insert at end
      currentMockInput.pressKey("1")
      currentMockInput.pressKey("2")
      currentMockInput.pressKey("3")
      expect(editor.plainText).toBe("Test123")

      // Move to middle and insert again
      editor.gotoLine(0) // Move to start
      for (let i = 0; i < 4; i++) {
        currentMockInput.pressArrow("right")
      }
      currentMockInput.pressKey("A")
      currentMockInput.pressKey("B")
      expect(editor.plainText).toBe("TestAB123")
      expect(editor.logicalCursor.col).toBe(6)

      // Now move left across all chunk boundaries
      for (let i = 6; i > 0; i--) {
        currentMockInput.pressArrow("left")
        expect(editor.logicalCursor.col).toBe(i - 1)
      }
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should move cursor right across all chunks to end", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AB",
        width: 40,
        height: 10,
      })

      editor.focus()
      const cursor = editor.logicalCursor
      editor.editBuffer.setCursorToLineCol(cursor.row, 9999) // Move to end of line
      expect(editor.logicalCursor.col).toBe(2)

      // Insert at end
      currentMockInput.pressKey("C")
      currentMockInput.pressKey("D")
      expect(editor.plainText).toBe("ABCD")

      // Move to start
      editor.gotoLine(0) // Move to start
      expect(editor.logicalCursor.col).toBe(0)

      // Move right through all characters
      for (let i = 0; i < 4; i++) {
        currentMockInput.pressArrow("right")
        expect(editor.logicalCursor.col).toBe(i + 1)
      }
    })

    it("should handle cursor movement after multiple insertions and deletions", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Start",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end
      expect(editor.logicalCursor.col).toBe(5)

      // Insert text
      currentMockInput.pressKey("1")
      currentMockInput.pressKey("2")

      // Delete one
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Start1")

      // Insert more
      currentMockInput.pressKey("X")
      currentMockInput.pressKey("Y")
      expect(editor.plainText).toBe("Start1XY")

      // Move back to start
      editor.gotoLine(0) // Move to start

      // Move right through all characters one by one
      for (let i = 0; i < 8; i++) {
        expect(editor.logicalCursor.col).toBe(i)
        currentMockInput.pressArrow("right")
      }
      expect(editor.logicalCursor.col).toBe(8)
    })
  })

  describe("Complex Editing Scenarios", () => {
    it("should handle typing, navigation, and deletion", async () => {
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

      // Add space and "World"
      currentMockInput.pressKey(" ")
      currentMockInput.pressKey("W")
      currentMockInput.pressKey("o")
      currentMockInput.pressKey("r")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("d")
      expect(editor.plainText).toBe("Hello World")

      // Backspace a few times
      currentMockInput.pressBackspace()
      currentMockInput.pressBackspace()
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Hello Wo")
    })

    it("should handle newlines and multi-line editing", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("L")
      currentMockInput.pressKey("i")
      currentMockInput.pressKey("n")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("1")
      currentMockInput.pressEnter()
      currentMockInput.pressKey("L")
      currentMockInput.pressKey("i")
      currentMockInput.pressKey("n")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("2")

      expect(editor.plainText).toBe("Line1\nLine2")
    })

    it("should handle insert and delete in sequence", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      editor.gotoLine(9999) // Move to end

      currentMockInput.pressKey("i")
      currentMockInput.pressKey("n")
      currentMockInput.pressKey("g")
      expect(editor.plainText).toBe("Testing")

      currentMockInput.pressBackspace()
      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("Testi")
    })
  })

  describe("Edit Operations", () => {
    it("should maintain correct cursor position after join, insert, backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABC\nDEF",
        width: 40,
        height: 10,
      })

      editor.focus()

      editor.gotoLine(1)
      expect(editor.logicalCursor.row).toBe(1)
      expect(editor.logicalCursor.col).toBe(0)
      expect(editor.plainText).toBe("ABC\nDEF")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCDEF")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(3)

      currentMockInput.pressKey("X")
      expect(editor.plainText).toBe("ABCXDEF")
      expect(editor.logicalCursor.col).toBe(4)

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("ABCDEF")
      expect(editor.logicalCursor.col).toBe(3)
    })

    it("should type correctly after backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("h")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("l")
      currentMockInput.pressKey("o")

      expect(editor.plainText).toBe("hello")

      currentMockInput.pressBackspace()
      expect(editor.plainText).toBe("hell")

      currentMockInput.pressKey("p")
      expect(editor.plainText).toBe("hellp")

      currentMockInput.pressKey("!")
      expect(editor.plainText).toBe("hellp!")
    })

    it("should type correctly after multiple backspaces", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("t")
      currentMockInput.pressKey("e")
      currentMockInput.pressKey("s")
      currentMockInput.pressKey("t")
      currentMockInput.pressKey("i")
      currentMockInput.pressKey("n")
      currentMockInput.pressKey("g")

      expect(editor.plainText).toBe("testing")

      currentMockInput.pressBackspace()
      currentMockInput.pressBackspace()
      currentMockInput.pressBackspace()

      expect(editor.plainText).toBe("test")

      currentMockInput.pressKey("e")
      currentMockInput.pressKey("d")

      expect(editor.plainText).toBe("tested")
    })

    it("should type correctly after backspacing all text", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "",
        width: 40,
        height: 10,
      })

      editor.focus()

      currentMockInput.pressKey("w")
      currentMockInput.pressKey("r")
      currentMockInput.pressKey("o")
      currentMockInput.pressKey("n")
      currentMockInput.pressKey("g")

      expect(editor.plainText).toBe("wrong")

      for (let i = 0; i < 5; i++) {
        currentMockInput.pressBackspace()
      }

      expect(editor.plainText).toBe("")

      currentMockInput.pressKey("r")
      currentMockInput.pressKey("i")
      currentMockInput.pressKey("g")
      currentMockInput.pressKey("h")
      currentMockInput.pressKey("t")

      expect(editor.plainText).toBe("right")
    })
  })

  describe("Deletion with empty lines", () => {
    it("should delete selection on line after empty lines correctly", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAA\n\nBBBB\n\nCCCC",
        width: 40,
        height: 10,
        selectable: true,
        wrapMode: "word",
      })

      editor.focus()
      editor.gotoLine(2) // Line with "BBBB"

      expect(editor.logicalCursor.row).toBe(2)
      expect(editor.plainText).toBe("AAAA\n\nBBBB\n\nCCCC")

      // Select "BBBB" by pressing shift+right 4 times
      for (let i = 0; i < 4; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("BBBB")

      // Delete the selection
      currentMockInput.pressKey("DELETE")

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("AAAA\n\n\n\nCCCC")
      expect(editor.logicalCursor.row).toBe(2)
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should delete selection on first line correctly (baseline test)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAA\n\nBBBB\n\nCCCC",
        width: 40,
        height: 10,
        selectable: true,
        wrapMode: "word",
      })

      editor.focus()
      editor.gotoLine(0) // First line with "AAAA"

      expect(editor.logicalCursor.row).toBe(0)

      // Select "AAAA"
      for (let i = 0; i < 4; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.getSelectedText()).toBe("AAAA")

      // Delete the selection
      currentMockInput.pressKey("DELETE")

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("\n\nBBBB\n\nCCCC")
    })

    it("should delete selection on last line after empty lines correctly", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAA\n\nBBBB\n\nCCCC",
        width: 40,
        height: 10,
        selectable: true,
        wrapMode: "word",
      })

      editor.focus()
      editor.gotoLine(4) // Last line with "CCCC"

      expect(editor.logicalCursor.row).toBe(4)

      // Select "CCCC"
      for (let i = 0; i < 4; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      const selectedText = editor.getSelectedText()
      expect(selectedText).toBe("CCCC")

      // Delete the selection
      currentMockInput.pressKey("DELETE")

      expect(editor.hasSelection()).toBe(false)
      // After deleting CCCC, we should still have AAAA and BBBB
      expect(editor.plainText).toContain("AAAA")
      expect(editor.plainText).toContain("BBBB")
      expect(editor.plainText).not.toContain("CCCC")
    })
  })
})
