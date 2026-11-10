import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"

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

  describe("without wrapping", () => {
    it("gotoVisualLineHome should go to start of line", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 40,
        height: 10,
        wrapMode: "none",
      })

      textarea.setText("Hello World")
      textarea.editBuffer.setCursor(0, 6)

      textarea.gotoVisualLineHome()

      const cursor = textarea.editBuffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(0)
    })

    it("gotoVisualLineEnd should go to end of line", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 40,
        height: 10,
        wrapMode: "none",
      })

      textarea.setText("Hello World")
      textarea.editBuffer.setCursor(0, 6)

      textarea.gotoVisualLineEnd()

      const cursor = textarea.editBuffer.getCursorPosition()
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBe(11)
    })

    it("should support selection with visual line home", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 40,
        height: 10,
      })

      textarea.setText("Hello World")
      textarea.editBuffer.setCursor(0, 11)

      textarea.gotoVisualLineHome({ select: true })

      const selection = textarea.getSelection()
      expect(selection).not.toBeNull()
      expect(selection!.start).toBe(0)
      expect(selection!.end).toBe(11)
      expect(textarea.getSelectedText()).toBe("Hello World")
    })

    it("should support selection with visual line end", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 40,
        height: 10,
      })

      textarea.setText("Hello World")
      textarea.editBuffer.setCursor(0, 0)

      textarea.gotoVisualLineEnd({ select: true })

      const selection = textarea.getSelection()
      expect(selection).not.toBeNull()
      expect(selection!.start).toBe(0)
      expect(selection!.end).toBe(11)
      expect(textarea.getSelectedText()).toBe("Hello World")
    })
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

    it("without wrapping, visual and logical should be the same", async () => {
      const { textarea } = await createTextareaRenderable(currentRenderer, renderOnce, {
        width: 40,
        height: 10,
        wrapMode: "none",
      })

      textarea.setText("Hello World")

      // Test home
      textarea.editBuffer.setCursor(0, 6)
      textarea.gotoVisualLineHome()
      const visualHomeCol = textarea.editBuffer.getCursorPosition().col

      textarea.editBuffer.setCursor(0, 6)
      textarea.gotoLineHome()
      const logicalHomeCol = textarea.editBuffer.getCursorPosition().col

      expect(visualHomeCol).toBe(logicalHomeCol)

      // Test end
      textarea.editBuffer.setCursor(0, 6)
      textarea.gotoVisualLineEnd()
      const visualEndCol = textarea.editBuffer.getCursorPosition().col

      textarea.editBuffer.setCursor(0, 6)
      textarea.gotoLineEnd()
      const logicalEndCol = textarea.editBuffer.getCursorPosition().col

      expect(visualEndCol).toBe(logicalEndCol)
    })
  })
})
