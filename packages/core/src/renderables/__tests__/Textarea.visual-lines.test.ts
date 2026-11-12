import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"
import { InputRenderable } from "../Input.js"
import { TextareaRenderable } from "../Textarea.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput

describe("TextareaRenderable - Visual Line Navigation", () => {
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

  // 606: without wrapping, a visual line is the logical line, however narrow the field. Each field
  // first scrolls to the line end, so column 1 is before its scroll offset and column 9 past it. A
  // line that fits is one visual line with wrapping on too. `end` and `home` are the selections of
  // select-to-visual-end and -home from the column; a backward cell selection keeps its anchor cell.
  it("visual home and end of a one-line field are its logical home and end", async () => {
    const text = "Hello World"
    type Range = [number, number] | null
    const rows: [kind: string, width: number, wrapMode: "none" | "word", col: number, end: Range, home: Range][] = [
      ["Textarea", 40, "none", 6, [6, 11], [0, 7]],
      ["Textarea", 4, "none", 1, [1, 11], [0, 2]],
      ["Textarea", 4, "none", 9, [9, 11], [0, 10]],
      ["Input", 4, "none", 1, [1, 11], [0, 2]],
      ["Input", 4, "none", 9, [9, 11], [0, 10]],
      ["Textarea", 40, "word", 0, [0, 11], null],
      ["Textarea", 40, "word", 11, null, [0, 11]],
    ]
    for (const [kind, width, wrapMode, col, end, home] of rows) {
      const field =
        kind === "Input"
          ? new InputRenderable(currentRenderer, { width, value: text })
          : new TextareaRenderable(currentRenderer, { width, height: 2, wrapMode, initialValue: text })
      currentRenderer.root.add(field)
      field.focus()
      field.gotoBufferEnd()
      await renderOnce()
      const row = [kind, width, wrapMode, col]
      const after = (move: () => void) => {
        field.clearSelection()
        field.editBuffer.setCursor(0, col)
        move()
        const selection = field.getSelection()
        const range = selection && selection.start !== selection.end ? [selection.start, selection.end] : null
        return [...row, field.logicalCursor.col, range, field.getSelectedText()]
      }
      const at = (cursor: number, range: Range = null) => [...row, cursor, range, range ? text.slice(...range) : ""]
      expect(after(() => currentMockInput.pressKey("e", { meta: true }))).toEqual(at(11))
      expect(after(() => field.gotoLineEnd())).toEqual(at(11))
      expect(after(() => currentMockInput.pressKey("a", { meta: true }))).toEqual(at(0))
      expect(after(() => field.gotoLineHome())).toEqual(at(0))
      expect(after(() => field.gotoVisualLineEnd({ select: true }))).toEqual(at(11, end))
      expect(after(() => field.gotoVisualLineHome({ select: true }))).toEqual(at(0, home))
      field.destroy()
    }
  })

  describe("with wrapping", () => {
    it("gotoVisualLineHome should go to start of visual line, not logical line", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      textarea.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
      textarea.editBuffer.setCursor(0, 22)

      textarea.gotoVisualLineHome()

      const cursor = textarea.editBuffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(20)
    })

    it("gotoVisualLineEnd should go to end of visual line, not logical line", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      textarea.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
      textarea.editBuffer.setCursor(0, 5)

      textarea.gotoVisualLineEnd()

      const cursor = textarea.editBuffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(19)
    })

    it("should navigate between visual lines correctly", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      textarea.setText("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")

      // First visual line
      textarea.editBuffer.setCursor(0, 10)
      textarea.gotoVisualLineHome()
      expect(textarea.editBuffer.getCursorPosition().col).toBe(0)

      textarea.gotoVisualLineEnd()
      expect(textarea.editBuffer.getCursorPosition().col).toBe(19)

      // Move to second visual line
      textarea.editBuffer.moveCursorRight()

      textarea.gotoVisualLineHome()
      expect(textarea.editBuffer.getCursorPosition().col).toBe(20)

      textarea.gotoVisualLineEnd()
      const cursor = textarea.editBuffer.getCursorPosition()
      expect(cursor.col).toBeGreaterThan(20)
    })

    it("should handle word wrapping correctly", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 20,
        height: 10,
        wrapMode: "word",
      })

      textarea.setText("Hello wonderful world of wrapped text")
      textarea.editBuffer.setCursor(0, 25)

      const vcursor = textarea.editorView.getVisualCursor()
      expect(vcursor.visualRow).toBeGreaterThan(0)

      textarea.gotoVisualLineHome()
      const solCursor = textarea.editBuffer.getCursorPosition()
      expect(solCursor.col).toBeGreaterThan(0)

      textarea.gotoVisualLineEnd()
      const eolCursor = textarea.editBuffer.getCursorPosition()
      expect(eolCursor.col).toBeLessThan(37)
    })

    it("should select within visual line boundaries", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      textarea.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
      textarea.editBuffer.setCursor(0, 10)

      textarea.gotoVisualLineEnd({ select: true })

      const selectedText = textarea.getSelectedText()
      expect(selectedText).toBe("KLMNOPQRST")
      expect(selectedText.length).toBe(10)
    })
  })

  describe("with multi-byte characters", () => {
    it("should handle wrapped emoji correctly", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 15,
        height: 10,
        wrapMode: "char",
      })

      textarea.setText("🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟")

      // First visual line
      textarea.editBuffer.setCursor(0, 2)
      textarea.gotoVisualLineHome()
      expect(textarea.editBuffer.getCursorPosition().col).toBe(0)

      textarea.gotoVisualLineEnd()
      const firstLineEnd = textarea.editBuffer.getCursorPosition().col
      expect(firstLineEnd).toBeGreaterThan(0)
      expect(firstLineEnd).toBeLessThan(20)

      // Move to second visual line - need to move far enough
      textarea.editBuffer.setCursor(0, 16)
      const vcursor = textarea.editorView.getVisualCursor()

      // Only test visual line navigation if we actually moved to second visual line
      if (vcursor.visualRow > 0) {
        textarea.gotoVisualLineHome()
        const secondLineStart = textarea.editBuffer.getCursorPosition().col
        expect(secondLineStart).toBeGreaterThan(firstLineEnd - 1)
      }
    })
  })

  describe("comparison with logical line navigation", () => {
    it("visual home should differ from logical home when wrapped", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      textarea.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
      textarea.editBuffer.setCursor(0, 22)

      textarea.gotoVisualLineHome()
      const visualHomeCol = textarea.editBuffer.getCursorPosition().col
      expect(visualHomeCol).toBe(20)

      textarea.editBuffer.setCursor(0, 22)
      textarea.gotoLineHome()
      const logicalHomeCol = textarea.editBuffer.getCursorPosition().col
      expect(logicalHomeCol).toBe(0)

      expect(visualHomeCol).not.toBe(logicalHomeCol)
    })

    it("visual end should differ from logical end when wrapped", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 20,
        height: 10,
        wrapMode: "char",
      })

      textarea.setText("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
      textarea.editBuffer.setCursor(0, 5)

      textarea.gotoVisualLineEnd()
      const visualEndCol = textarea.editBuffer.getCursorPosition().col
      expect(visualEndCol).toBe(19)

      textarea.editBuffer.setCursor(0, 5)
      textarea.gotoLineEnd()
      const logicalEndCol = textarea.editBuffer.getCursorPosition().col
      expect(logicalEndCol).toBe(26)

      expect(visualEndCol).not.toBe(logicalEndCol)
    })
  })
})
