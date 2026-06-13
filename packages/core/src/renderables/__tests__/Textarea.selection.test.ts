import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockMouse, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"
import { RGBA } from "../../lib/RGBA.js"
import { OptimizedBuffer } from "../../buffer.js"
import { TextRenderable } from "../Text.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMouse: MockMouse
let currentMockInput: MockInput

describe("Textarea - Selection Tests", () => {
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

  describe("Selection Support", () => {
    it("should support selection via mouse drag", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      expect(editor.hasSelection()).toBe(false)

      await currentMouse.drag(editor.x, editor.y, editor.x + 5, editor.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)

      const sel = editor.getSelection()
      expect(sel).not.toBe(null)
      expect(sel!.start).toBe(0)
      expect(sel!.end).toBe(5)

      expect(editor.getSelectedText()).toBe("Hello")
    })

    it("should return selected text from multi-line content", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAA\nBBBB\nCCCC",
        width: 40,
        height: 10,
        selectable: true,
      })

      await currentMouse.drag(editor.x + 2, editor.y, editor.x + 2, editor.y + 2)
      await renderOnce()

      const selectedText = editor.getSelectedText()
      expect(selectedText).toBe("AA\nBBBB\nCC")
    })

    it("should handle selection with viewport scrolling", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 5,
        selectable: true,
      })

      editor.gotoLine(10)
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(0)

      await currentMouse.drag(editor.x, editor.y, editor.x + 4, editor.y + 2)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()
      expect(selectedText.length).toBeGreaterThan(0)
      expect(selectedText).not.toContain("Line 0")
      expect(selectedText).not.toContain("Line 1")
      expect(selectedText).toContain("Line")
    })

    it("should disable selection when selectable is false", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: false,
      })

      const shouldHandle = editor.shouldStartSelection(editor.x, editor.y)
      expect(shouldHandle).toBe(false)

      await currentMouse.drag(editor.x, editor.y, editor.x + 5, editor.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(false)
      expect(editor.getSelectedText()).toBe("")
    })

    it("should update selection when selectionBg/selectionFg changes", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
        selectionBg: RGBA.fromValues(0, 0, 1, 1),
      })

      await currentMouse.drag(editor.x, editor.y, editor.x + 5, editor.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)

      editor.selectionBg = RGBA.fromValues(1, 0, 0, 1)
      editor.selectionFg = RGBA.fromValues(1, 1, 1, 1)

      expect(editor.hasSelection()).toBe(true)
    })

    it("should clear selection", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      await currentMouse.drag(editor.x, editor.y, editor.x + 5, editor.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)

      currentRenderer.clearSelection()
      await renderOnce()

      expect(editor.hasSelection()).toBe(false)
      expect(editor.getSelectedText()).toBe("")
    })

    it("should handle selection with wrapping enabled", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "ABCDEFGHIJKLMNOP",
        width: 10,
        height: 10,
        wrapMode: "word",
        selectable: true,
      })

      const vlineCount = editor.editorView.getVirtualLineCount()
      expect(vlineCount).toBe(2)

      await currentMouse.drag(editor.x + 2, editor.y, editor.x + 3, editor.y + 1)
      await renderOnce()

      const sel = editor.getSelection()
      expect(sel).not.toBe(null)
      expect(sel!.start).toBe(2)
      expect(sel!.end).toBe(13)
    })

    it("should handle reverse selection (drag from end to start)", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      await currentMouse.drag(editor.x + 11, editor.y, editor.x + 6, editor.y)
      await renderOnce()

      const sel = editor.getSelection()
      expect(sel).not.toBe(null)
      expect(sel!.start).toBe(6)
      expect(sel!.end).toBe(11)

      expect(editor.getSelectedText()).toBe("World")
    })

    it("should render selection properly when drawing to buffer", async () => {
      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
        selectionBg: RGBA.fromValues(0, 0, 1, 1),
        selectionFg: RGBA.fromValues(1, 1, 1, 1),
      })

      await currentMouse.drag(editor.x, editor.y, editor.x + 5, editor.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello")

      buffer.clear(RGBA.fromValues(0, 0, 0, 1))
      buffer.drawEditorView(editor.editorView, editor.x, editor.y)

      const sel = editor.getSelection()
      expect(sel).not.toBe(null)
      expect(sel!.start).toBe(0)
      expect(sel!.end).toBe(5)

      buffer.destroy()
    })

    it("should handle viewport-aware selection correctly", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 15 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 5,
        selectable: true,
        scrollMargin: 0,
        scrollSpeed: 0,
      })

      editor.gotoLine(10)
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(0)

      const expectedLineNumber = viewport.offsetY

      await currentMouse.drag(editor.x, editor.y, editor.x + 6, editor.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()

      expect(selectedText).not.toContain("Line 0")
      expect(selectedText).not.toContain("Line 1")
      expect(selectedText).toContain(`Line ${expectedLineNumber}`)
    })

    it("should handle multi-line selection with viewport scrolling", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `AAAA${i}`).join("\n"),
        width: 40,
        height: 5,
        selectable: true,
      })

      editor.gotoLine(8)
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(0)

      await currentMouse.drag(editor.x, editor.y, editor.x + 4, editor.y + 2)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()

      const line1 = `AAAA${viewport.offsetY}`
      const line2 = `AAAA${viewport.offsetY + 1}`
      const line3 = `AAAA${viewport.offsetY + 2}`

      expect(selectedText).toContain(line1)
      expect(selectedText).toContain(line2)
      expect(selectedText).toContain(line3.substring(0, 4))
    })

    it("should handle horizontal scrolled selection without wrapping", async () => {
      const longLine = "A".repeat(100)
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: longLine,
        width: 20,
        height: 5,
        wrapMode: "none",
        selectable: true,
      })

      for (let i = 0; i < 50; i++) {
        editor.moveCursorRight()
      }
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetX).toBeGreaterThan(0)

      await currentMouse.drag(editor.x, editor.y, editor.x + 10, editor.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()

      expect(selectedText).toBe("A".repeat(10))

      const sel = editor.getSelection()
      expect(sel).not.toBe(null)
      expect(sel!.start).toBeGreaterThanOrEqual(viewport.offsetX)
    })

    it("should render selection highlighting at correct screen position with viewport scroll", async () => {
      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 15 }, (_, i) => `Line${i}`).join("\n"),
        width: 20,
        height: 5,
        selectable: true,
        selectionBg: RGBA.fromValues(1, 0, 0, 1),
      })

      editor.gotoLine(8)
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(0)

      // Use manual drag steps instead of the drag helper to avoid timing issues
      await currentMouse.pressDown(editor.x, editor.y)
      await currentMouse.emitMouseEvent("drag", editor.x + 5, editor.y)
      await currentMouse.release(editor.x + 5, editor.y)
      await renderOnce()

      buffer.clear(RGBA.fromValues(0, 0, 0, 1))
      buffer.drawEditorView(editor.editorView, editor.x, editor.y)

      const selectedText = editor.getSelectedText()
      expect(selectedText).toBe(`Line${viewport.offsetY}`.substring(0, 5))

      const { bg } = buffer.buffers
      const bufferWidth = buffer.width

      for (let cellX = editor.x; cellX < editor.x + 5; cellX++) {
        const bufferIdx = editor.y * bufferWidth + cellX
        const bgR = (bg[bufferIdx * 4] & 0xff) / 255
        const bgG = (bg[bufferIdx * 4 + 1] & 0xff) / 255
        const bgB = (bg[bufferIdx * 4 + 2] & 0xff) / 255

        expect(Math.abs(bgR - 1.0)).toBeLessThan(0.01)
        expect(Math.abs(bgG - 0.0)).toBeLessThan(0.01)
        expect(Math.abs(bgB - 0.0)).toBeLessThan(0.01)
      }

      buffer.destroy()
    })

    it("should render selection correctly with empty lines between content", async () => {
      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAA\n\nBBBB\n\nCCCC",
        width: 40,
        height: 10,
        selectable: true,
        selectionBg: RGBA.fromValues(1, 0, 0, 1),
      })

      editor.focus()
      editor.gotoLine(2)

      for (let i = 0; i < 4; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.getSelectedText()).toBe("BBBB")

      buffer.clear(RGBA.fromValues(0, 0, 0, 1))
      buffer.drawEditorView(editor.editorView, 0, 0)

      const { bg } = buffer.buffers
      const bufferWidth = buffer.width

      for (let cellX = 0; cellX < 4; cellX++) {
        const bufferIdx = 2 * bufferWidth + cellX
        const bgR = (bg[bufferIdx * 4] & 0xff) / 255
        const bgG = (bg[bufferIdx * 4 + 1] & 0xff) / 255
        const bgB = (bg[bufferIdx * 4 + 2] & 0xff) / 255

        expect(Math.abs(bgR - 1.0)).toBeLessThan(0.01)
        expect(Math.abs(bgG - 0.0)).toBeLessThan(0.01)
        expect(Math.abs(bgB - 0.0)).toBeLessThan(0.01)
      }

      buffer.destroy()
    })

    it("should handle shift+arrow selection with viewport scrolling", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `Line${i}`).join("\n"),
        width: 40,
        height: 5,
        selectable: true,
      })

      editor.focus()

      editor.gotoLine(15)
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(10)

      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()

      expect(selectedText).toBe("Line1")

      const sel = editor.getSelection()
      expect(sel).not.toBe(null)
      expect(sel!.end - sel!.start).toBe(5)
    })

    it("should handle mouse drag selection with scrolled viewport using correct offset", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 30 }, (_, i) => `AAAA${i}`).join("\n"),
        width: 40,
        height: 5,
        selectable: true,
        scrollSpeed: 0,
      })

      editor.gotoLine(20)
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(15)

      await currentMouse.drag(editor.x, editor.y, editor.x + 4, editor.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()

      expect(selectedText).not.toContain("AAAA0")
      expect(selectedText).not.toContain("AAAA1")

      const firstVisibleLineIdx = viewport.offsetY
      const expectedText = `AAAA${firstVisibleLineIdx}`.substring(0, 4)
      expect(selectedText).toBe(expectedText)
    })

    it("should handle multi-line mouse drag with scrolled viewport", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 30 }, (_, i) => `Line${i}`).join("\n"),
        width: 40,
        height: 5,
        selectable: true,
      })

      editor.gotoLine(12)
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(7)

      await currentMouse.drag(editor.x, editor.y, editor.x + 5, editor.y + 2)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()

      expect(selectedText.startsWith("Line0")).toBe(false)
      expect(selectedText.startsWith("Line1")).toBe(false)
      expect(selectedText.startsWith("Line2")).toBe(false)

      const line1 = `Line${viewport.offsetY}`
      const line2 = `Line${viewport.offsetY + 1}`
      const line3 = `Line${viewport.offsetY + 2}`

      expect(selectedText).toContain(line1)
      expect(selectedText).toContain(line2)
      expect(selectedText).toContain(line3.substring(0, 5))
    })
  })

  describe("Shift+Arrow Key Selection", () => {
    it("should start selection with shift+right", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()
      expect(editor.hasSelection()).toBe(false)

      currentMockInput.pressArrow("right", { shift: true })

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("H")
    })

    it("should extend selection with shift+right", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello")
    })

    it("should extend a mouse selection with shift+right", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      await currentMouse.drag(editor.x, editor.y, editor.x + 5, editor.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello")

      currentMockInput.pressArrow("right", { shift: true })
      await renderOnce()

      expect(editor.getSelectedText()).toBe("Hello ")
    })

    it("should handle shift+left selection", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()
      const cursor = editor.logicalCursor
      editor.editBuffer.setCursorToLineCol(cursor.row, 9999)

      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("left", { shift: true })
      }

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("World")
    })

    it("should select with shift+down", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      currentMockInput.pressArrow("down", { shift: true })

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()
      expect(selectedText).toBe("Line 1\n")
    })

    it("should select with shift+up", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()
      editor.gotoLine(2)

      currentMockInput.pressArrow("up", { shift: true })

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()
      expect(selectedText.includes("Line 2")).toBe(true)
    })

    it("should select to line start with shift+home", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()
      for (let i = 0; i < 6; i++) {
        editor.moveCursorRight()
      }

      currentMockInput.pressKey("HOME", { shift: true })

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello W")
    })

    it("should select to line end with shift+end", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      currentMockInput.pressKey("END", { shift: true })

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello World")
    })

    it("should clear selection when moving without shift", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.hasSelection()).toBe(true)

      currentMockInput.pressArrow("right")

      expect(editor.hasSelection()).toBe(false)
    })

    it("should delete selected text with backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.getSelectedText()).toBe("Hello")
      expect(editor.plainText).toBe("Hello World")

      currentMockInput.pressBackspace()

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe(" World")
      expect(editor.logicalCursor.col).toBe(0)
    })

    it("should delete selected text with delete key", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World!",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      const cursor = editor.logicalCursor
      editor.editBuffer.setCursorToLineCol(cursor.row, 9999)
      for (let i = 0; i < 6; i++) {
        currentMockInput.pressArrow("left", { shift: true })
      }

      expect(editor.getSelectedText()).toBe("World!")
      expect(editor.plainText).toBe("Hello World!")

      currentMockInput.pressKey("DELETE")

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("Hello ")
      expect(editor.logicalCursor.col).toBe(6)
    })

    it("should delete multi-line selection with backspace", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      for (let i = 0; i < 10; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      const selectedText = editor.getSelectedText()
      expect(editor.plainText).toBe("Line 1\nLine 2\nLine 3")

      currentMockInput.pressBackspace()

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("e 2\nLine 3")
      expect(editor.logicalCursor.col).toBe(0)
      expect(editor.logicalCursor.row).toBe(0)
    })

    it("should delete entire line when selected with delete", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 1\nLine 2\nLine 3",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()
      editor.gotoLine(1)

      currentMockInput.pressArrow("down", { shift: true })

      const selectedText = editor.getSelectedText()
      expect(selectedText).toBe("Line 2\n")

      currentMockInput.pressKey("DELETE")

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("Line 1\nLine 3")
      expect(editor.logicalCursor.row).toBe(1)
    })

    it("should replace selected text when typing", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      for (let i = 0; i < 5; i++) {
        currentMockInput.pressArrow("right", { shift: true })
      }

      expect(editor.getSelectedText()).toBe("Hello")

      currentMockInput.pressKey("H")
      currentMockInput.pressKey("i")

      expect(editor.hasSelection()).toBe(false)
      expect(editor.plainText).toBe("Hi World")
    })

    it("should delete selected text via native deleteSelectedText API", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Hello World",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()

      await currentMouse.drag(editor.x, editor.y, editor.x + 5, editor.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toBe("Hello")

      editor.editorView.deleteSelectedText()
      currentRenderer.clearSelection()
      await renderOnce()

      expect(editor.plainText).toBe(" World")
      expect(editor.logicalCursor.row).toBe(0)
      expect(editor.logicalCursor.col).toBe(0)
      expect(editor.editorView.hasSelection()).toBe(false)
    })
    it("should maintain correct selection start when scrolling down with shift+down", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n"),
        width: 20,
        height: 5,
        selectable: true,
      })

      editor.focus()

      for (let i = 0; i < 8; i++) {
        currentMockInput.pressArrow("down", { shift: true })
        await renderOnce()
      }

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(0)

      const sel = editor.getSelection()
      expect(sel).not.toBe(null)
      expect(sel!.start).toBe(0)
    })

    it("should not start selection in textarea when clicking in text renderable below after scrolling", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `Textarea Line ${i}`).join("\n"),
        width: 40,
        height: 5,
        selectable: true,
        top: 0,
      })

      const textBelow = new TextRenderable(currentRenderer, {
        id: "text-below",
        content: "This is text below the textarea",
        selectable: true,
        top: 5,
        left: 0,
        width: 40,
        height: 1,
      })
      currentRenderer.root.add(textBelow)

      editor.focus()

      editor.gotoBufferEnd()
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(10)

      await currentMouse.drag(textBelow.x, textBelow.y, textBelow.x + 10, textBelow.y)
      await renderOnce()

      expect(editor.hasSelection()).toBe(false)
      expect(editor.getSelectedText()).toBe("")

      expect(textBelow.hasSelection()).toBe(true)
      expect(textBelow.getSelectedText()).toBe("This is te")

      textBelow.destroy()
    })

    it("should maintain selection in both renderables when dragging from text-below up into textarea", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `Textarea Line ${i}`).join("\n"),
        width: 40,
        height: 5,
        selectable: true,
        top: 0,
      })

      const textBelow = new TextRenderable(currentRenderer, {
        id: "text-below",
        content: "This is text below the textarea",
        selectable: true,
        top: 5,
        left: 0,
        width: 40,
        height: 1,
      })
      currentRenderer.root.add(textBelow)

      editor.focus()

      editor.gotoBufferEnd()
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(10)

      const startX = textBelow.x + 5
      const startY = textBelow.y
      const endX = editor.x + 15
      const endY = editor.y + 3

      await currentMouse.drag(startX, startY, endX, endY)
      await renderOnce()

      expect(textBelow.hasSelection()).toBe(true)
      const textBelowSelection = textBelow.getSelectedText()
      expect(textBelowSelection.length).toBeGreaterThan(0)

      expect(editor.hasSelection()).toBe(true)
      const textareaSelection = editor.getSelectedText()
      expect(textareaSelection.length).toBeGreaterThan(0)

      textBelow.destroy()
    })

    it("should handle cross-renderable selection from bottom-left text to top-right text", async () => {
      const { BoxRenderable } = await import("../Box.js")

      const bottomText = new TextRenderable(currentRenderer, {
        id: "bottom-instructions",
        content: "Click and drag to select text across any elements",
        left: 5,
        top: 20,
        width: 50,
        height: 1,
        selectable: true,
      })
      currentRenderer.root.add(bottomText)

      const rightBox = new BoxRenderable(currentRenderer, {
        id: "right-box",
        left: 50,
        top: 5,
        width: 30,
        height: 10,
        padding: 1,
        flexDirection: "column",
      })
      currentRenderer.root.add(rightBox)

      const codeText1 = new TextRenderable(currentRenderer, {
        id: "code-line-1",
        content: "function handleSelection() {",
        selectable: true,
      })
      rightBox.add(codeText1)

      const codeText2 = new TextRenderable(currentRenderer, {
        id: "code-line-2",
        content: "  const selected = getText()",
        selectable: true,
      })
      rightBox.add(codeText2)

      const codeText3 = new TextRenderable(currentRenderer, {
        id: "code-line-3",
        content: "  console.log(selected)",
        selectable: true,
      })
      rightBox.add(codeText3)

      const codeText4 = new TextRenderable(currentRenderer, {
        id: "code-line-4",
        content: "}",
        selectable: true,
      })
      rightBox.add(codeText4)

      await renderOnce()

      const startX = bottomText.x + 10
      const startY = bottomText.y
      const endX = codeText2.x + 15
      const endY = codeText2.y

      await currentMouse.drag(startX, startY, endX, endY)
      await renderOnce()

      expect(bottomText.hasSelection()).toBe(true)
      const bottomSelected = bottomText.getSelectedText()
      expect(bottomSelected).toBe("Click and d")

      expect(codeText1.hasSelection()).toBe(false)

      expect(codeText2.hasSelection()).toBe(true)
      const codeText2Selected = codeText2.getSelectedText()
      const codeText2Content = "  const selected = getText()"
      expect(codeText2Selected).toBe(codeText2Content.substring(0, 15))

      bottomText.destroy()
      rightBox.destroy()
    })
  })

  describe("Selection After Resize", () => {
    it("should maintain selection correctly after resize - same text selected and rendered properly", async () => {
      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      const { textarea: editor, root } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 30 }, (_, i) => `Line ${i.toString().padStart(2, "0")}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
        selectionBg: RGBA.fromValues(0, 1, 0, 1),
        selectionFg: RGBA.fromValues(0, 0, 0, 1),
      })

      editor.gotoLine(5)
      await renderOnce()

      await currentMouse.drag(editor.x + 5, editor.y + 2, editor.x + 10, editor.y + 4)
      await renderOnce()

      const selectedTextBefore = editor.getSelectedText()
      const selectionBefore = editor.getSelection()

      expect(editor.hasSelection()).toBe(true)
      expect(selectedTextBefore).toBeTruthy()

      buffer.clear(RGBA.fromValues(0, 0, 0, 1))
      buffer.drawEditorView(editor.editorView, editor.x, editor.y)

      const { bg: bgBefore } = buffer.buffers
      const bufferWidth = buffer.width

      const selectedCellsBefore: Array<{ x: number; y: number }> = []
      for (let y = 0; y < editor.height; y++) {
        for (let x = 0; x < editor.width; x++) {
          const bufferIdx = (editor.y + y) * bufferWidth + (editor.x + x)
          const bgG = (bgBefore[bufferIdx * 4 + 1] & 0xff) / 255
          if (Math.abs(bgG - 1.0) < 0.01) {
            selectedCellsBefore.push({ x, y })
          }
        }
      }

      expect(selectedCellsBefore.length).toBeGreaterThan(0)

      editor.width = 50
      editor.height = 15
      root.yogaNode.calculateLayout(80, 24)
      await renderOnce()

      const selectedTextAfter = editor.getSelectedText()
      const selectionAfter = editor.getSelection()

      expect(editor.hasSelection()).toBe(true)
      expect(selectedTextAfter).toBe(selectedTextBefore)
      expect(selectionAfter?.start).toBe(selectionBefore?.start)
      expect(selectionAfter?.end).toBe(selectionBefore?.end)

      buffer.clear(RGBA.fromValues(0, 0, 0, 1))
      buffer.drawEditorView(editor.editorView, editor.x, editor.y)

      const { bg: bgAfter } = buffer.buffers

      const selectedCellsAfter: Array<{ x: number; y: number }> = []
      for (let y = 0; y < editor.height; y++) {
        for (let x = 0; x < editor.width; x++) {
          const bufferIdx = (editor.y + y) * bufferWidth + (editor.x + x)
          const bgG = (bgAfter[bufferIdx * 4 + 1] & 0xff) / 255
          if (Math.abs(bgG - 1.0) < 0.01) {
            selectedCellsAfter.push({ x, y })
          }
        }
      }

      expect(selectedCellsAfter.length).toBeGreaterThan(0)
      expect(selectedCellsAfter.length).toBe(selectedCellsBefore.length)

      buffer.destroy()
      editor.destroy()
    })

    it("should maintain exact same text selected after wrap width changes", async () => {
      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      const { textarea: editor, root } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "AAAAA BBBBB CCCCC DDDDD EEEEE FFFFF GGGGG HHHHH",
        width: 50,
        height: 10,
        wrapMode: "word",
        selectable: true,
        selectionBg: RGBA.fromValues(1, 0, 1, 1),
        selectionFg: RGBA.fromValues(1, 1, 1, 1),
      })

      await renderOnce()

      await currentMouse.drag(editor.x + 6, editor.y, editor.x + 17, editor.y)
      await renderOnce()

      const selectedTextBefore = editor.getSelectedText()
      const selectionBefore = editor.getSelection()

      expect(editor.hasSelection()).toBe(true)
      expect(selectedTextBefore).toBe("BBBBB CCCCC")

      editor.width = 15
      editor.height = 15
      root.yogaNode.calculateLayout(80, 24)
      await renderOnce()

      const selectedTextAfterNarrow = editor.getSelectedText()
      const selectionAfterNarrow = editor.getSelection()

      expect(editor.hasSelection()).toBe(true)
      expect(selectedTextAfterNarrow).toBe("BBBBB CCCCC")
      expect(selectionAfterNarrow?.start).toBe(selectionBefore?.start)
      expect(selectionAfterNarrow?.end).toBe(selectionBefore?.end)

      buffer.clear(RGBA.fromValues(0, 0, 0, 1))
      buffer.drawEditorView(editor.editorView, editor.x, editor.y)

      const { bg: bgNarrow } = buffer.buffers
      const bufferWidth = buffer.width

      let selectedCellsNarrow = 0
      for (let y = 0; y < editor.height; y++) {
        for (let x = 0; x < editor.width; x++) {
          const bufferIdx = (editor.y + y) * bufferWidth + (editor.x + x)
          const bgR = (bgNarrow[bufferIdx * 4 + 0] & 0xff) / 255
          const bgB = (bgNarrow[bufferIdx * 4 + 2] & 0xff) / 255
          if (Math.abs(bgR - 1.0) < 0.01 && Math.abs(bgB - 1.0) < 0.01) {
            selectedCellsNarrow++
          }
        }
      }

      expect(selectedCellsNarrow).toBe(11)

      editor.width = 50
      editor.height = 10
      root.yogaNode.calculateLayout(80, 24)
      await renderOnce()

      const selectedTextAfterWide = editor.getSelectedText()
      const selectionAfterWide = editor.getSelection()

      expect(editor.hasSelection()).toBe(true)
      expect(selectedTextAfterWide).toBe("BBBBB CCCCC")
      expect(selectionAfterWide?.start).toBe(selectionBefore?.start)
      expect(selectionAfterWide?.end).toBe(selectionBefore?.end)

      buffer.clear(RGBA.fromValues(0, 0, 0, 1))
      buffer.drawEditorView(editor.editorView, editor.x, editor.y)

      const { bg: bgWide } = buffer.buffers

      let selectedCellsWide = 0
      for (let y = 0; y < editor.height; y++) {
        for (let x = 0; x < editor.width; x++) {
          const bufferIdx = (editor.y + y) * bufferWidth + (editor.x + x)
          const bgR = (bgWide[bufferIdx * 4 + 0] & 0xff) / 255
          const bgB = (bgWide[bufferIdx * 4 + 2] & 0xff) / 255
          if (Math.abs(bgR - 1.0) < 0.01 && Math.abs(bgB - 1.0) < 0.01) {
            selectedCellsWide++
          }
        }
      }

      expect(selectedCellsWide).toBe(11)

      buffer.destroy()
      editor.destroy()
    })

    it("should handle resize during active mouse selection drag", async () => {
      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      const { textarea: editor, root } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
        selectionBg: RGBA.fromValues(0, 1, 1, 1),
      })

      await renderOnce()

      await currentMouse.pressDown(editor.x + 2, editor.y + 1)
      await currentMouse.moveTo(editor.x + 8, editor.y + 3)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      const selectedBeforeResize = editor.getSelectedText()

      editor.width = 30
      editor.height = 8
      root.yogaNode.calculateLayout(80, 24)
      await renderOnce()

      await currentMouse.moveTo(editor.x + 10, editor.y + 2)
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)

      await currentMouse.release(editor.x + 10, editor.y + 2)
      await renderOnce()

      buffer.clear(RGBA.fromValues(0, 0, 0, 1))
      buffer.drawEditorView(editor.editorView, editor.x, editor.y)

      const { bg: bgAfterResize } = buffer.buffers
      const bufferWidth = buffer.width

      let selectedCellsAfterResize = 0
      for (let y = 0; y < editor.height; y++) {
        for (let x = 0; x < editor.width; x++) {
          const bufferIdx = (editor.y + y) * bufferWidth + (editor.x + x)
          const bgG = (bgAfterResize[bufferIdx * 4 + 1] & 0xff) / 255
          const bgB = (bgAfterResize[bufferIdx * 4 + 2] & 0xff) / 255
          if (Math.abs(bgG - 1.0) < 0.01 && Math.abs(bgB - 1.0) < 0.01) {
            selectedCellsAfterResize++
          }
        }
      }

      expect(selectedCellsAfterResize).toBeGreaterThan(0)

      buffer.destroy()
      editor.destroy()
    })

    it("should maintain selection correctly when renderable position changes during resize", async () => {
      const buffer = OptimizedBuffer.create(80, 24, "wcwidth")

      const { textarea: editor, root } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `Line ${i.toString().padStart(2, "0")}`).join("\n"),
        left: 10,
        top: 5,
        width: 40,
        height: 10,
        selectable: true,
        selectionBg: RGBA.fromValues(1, 1, 0, 1),
        selectionFg: RGBA.fromValues(0, 0, 0, 1),
      })

      await renderOnce()

      const initialX = editor.x
      const initialY = editor.y

      await currentMouse.drag(editor.x + 5, editor.y + 2, editor.x + 10, editor.y + 4)
      await renderOnce()

      const selectedTextBefore = editor.getSelectedText()
      const selectionBefore = editor.getSelection()

      expect(editor.hasSelection()).toBe(true)
      expect(selectedTextBefore).toBeTruthy()

      buffer.clear(RGBA.fromValues(0, 0, 0, 1))
      buffer.drawEditorView(editor.editorView, editor.x, editor.y)

      const { bg: bgBefore } = buffer.buffers
      const bufferWidth = buffer.width

      const selectedCellsBeforeCount = countSelectedCells(bgBefore, bufferWidth, editor, 1, 1, 0)
      expect(selectedCellsBeforeCount).toBeGreaterThan(0)

      editor.left = 20
      editor.top = 10
      root.yogaNode.calculateLayout(80, 24)
      await renderOnce()

      const newX = editor.x
      const newY = editor.y

      expect(newX).not.toBe(initialX)
      expect(newY).not.toBe(initialY)

      const selectedTextAfter = editor.getSelectedText()
      const selectionAfter = editor.getSelection()

      expect(editor.hasSelection()).toBe(true)
      expect(selectedTextAfter).toBe(selectedTextBefore)
      expect(selectionAfter?.start).toBe(selectionBefore?.start)
      expect(selectionAfter?.end).toBe(selectionBefore?.end)

      buffer.clear(RGBA.fromValues(0, 0, 0, 1))
      buffer.drawEditorView(editor.editorView, editor.x, editor.y)

      const { bg: bgAfter } = buffer.buffers
      const selectedCellsAfterCount = countSelectedCells(bgAfter, bufferWidth, editor, 1, 1, 0)

      expect(selectedCellsAfterCount).toBe(selectedCellsBeforeCount)
      expect(selectedCellsAfterCount).toBeGreaterThan(0)

      buffer.destroy()
      editor.destroy()
    })

    it("should keep cursor within textarea bounds after resize causes wrapping with scrolled selection", async () => {
      const { textarea: editor, root } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from(
          { length: 50 },
          (_, i) =>
            `This is a long line ${i.toString().padStart(2, "0")} with enough text to cause wrapping when narrow`,
        ).join("\n"),
        width: 60,
        height: 10,
        top: 0,
        wrapMode: "word",
        selectable: true,
        showCursor: true,
      })

      const textBelow = new TextRenderable(currentRenderer, {
        id: "text-below",
        content: "Element below textarea",
        top: 10,
        left: 0,
      })
      currentRenderer.root.add(textBelow)

      await renderOnce()

      editor.focus()
      editor.gotoLine(15)
      await renderOnce()

      await currentMouse.drag(editor.x + 5, editor.y + 3, editor.x + 10, editor.y + 9)
      await renderOnce()

      const viewportAfterSelection = editor.editorView.getViewport()

      expect(editor.hasSelection()).toBe(true)
      expect(viewportAfterSelection.offsetY).toBeGreaterThan(0)

      editor.width = 8
      root.yogaNode.calculateLayout(80, 24)
      await renderOnce()

      const viewportAfterResize = editor.editorView.getViewport()
      const cursorAfterResize = editor.visualCursor

      expect(cursorAfterResize.visualRow).toBeGreaterThanOrEqual(0)
      expect(cursorAfterResize.visualRow).toBeLessThan(editor.height)
      expect(cursorAfterResize.visualCol).toBeGreaterThanOrEqual(0)
      expect(cursorAfterResize.visualCol).toBeLessThan(editor.width)

      textBelow.destroy()
      editor.destroy()
    })
  })

  describe("Selection Preserved on Viewport Scroll", () => {
    it("should preserve selection when scrolling viewport", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.focus()
      await renderOnce()

      // Select all text using keyboard (Cmd+Shift+Down)
      currentMockInput.pressKey("ARROW_DOWN", { shift: true, super: true })
      await renderOnce()

      const selectionBefore = editor.getSelection()
      const selectedTextBefore = editor.getSelectedText()

      expect(selectionBefore).not.toBeNull()
      expect(selectedTextBefore).toContain("Line 0")
      expect(selectedTextBefore).toContain("Line 49")

      // Start renderer to simulate real app with continuous render loop
      currentRenderer.start()

      // Scroll up with mouse wheel
      await currentMouse.scroll(editor.x, editor.y + 1, "up")
      currentRenderer.pause()
      await currentRenderer.idle()

      const selectionAfter = editor.getSelection()
      const selectedTextAfter = editor.getSelectedText()

      // Selection should not change when scrolling viewport
      expect(selectionAfter).not.toBeNull()
      expect(selectionAfter!.start).toBe(selectionBefore!.start)
      expect(selectionAfter!.end).toBe(selectionBefore!.end)
      expect(selectedTextAfter).toBe(selectedTextBefore)

      editor.destroy()
    })
  })

  describe("Keyboard Selection with Viewport Scrolling", () => {
    it("should select to buffer home after shift+end then shift+home when scrolled", async () => {
      const lines = Array.from({ length: 30 }, (_, i) => `Line ${i.toString().padStart(2, "0")}`)
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: lines.join("\n"),
        width: 40,
        height: 6,
        selectable: true,
      })

      editor.focus()
      await renderOnce()

      for (let i = 0; i < 3; i++) {
        await currentMouse.scroll(editor.x + 2, editor.y + 2, "down")
      }
      await renderOnce()

      const viewportAfterScroll = editor.editorView.getViewport()
      expect(viewportAfterScroll.offsetY).toBeGreaterThan(0)
      expect(editor.logicalCursor.row).toBeGreaterThan(0)

      currentMockInput.pressKey("END", { shift: true })
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)

      currentMockInput.pressKey("HOME", { shift: true })
      await renderOnce()

      const selection = editor.getSelection()
      expect(selection).not.toBeNull()
      expect(selection!.start).toBe(0)

      const selectedText = editor.getSelectedText()
      expect(selectedText.startsWith("Line 00")).toBe(true)
      expect(selectedText).not.toContain("Line 29")
    })

    it("should allow shift+end after shift+home from a mid-buffer cursor", async () => {
      const lines = Array.from({ length: 30 }, (_, i) => `Line ${i.toString().padStart(2, "0")}`)
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: lines.join("\n"),
        width: 40,
        height: 6,
        selectable: true,
      })

      editor.focus()
      editor.gotoLine(10)
      await renderOnce()

      currentMockInput.pressKey("END", { shift: true })
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)

      currentMockInput.pressKey("HOME", { shift: true })
      await renderOnce()

      currentMockInput.pressKey("END", { shift: true })
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      expect(editor.getSelectedText()).toContain("Line 29")
    })

    it("should select to buffer home with shift+super+up in scrollable textarea", async () => {
      // Create textarea with content taller than visible area
      const lines = Array.from({ length: 50 }, (_, i) => `Line ${i.toString().padStart(2, "0")}`)
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: lines.join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      // Move cursor to middle of content (line 25)
      editor.focus()
      editor.gotoLine(25)
      await renderOnce()

      // Verify viewport has scrolled
      const viewportBefore = editor.editorView.getViewport()
      expect(viewportBefore.offsetY).toBeGreaterThan(0)

      // Select to buffer home (shift+super+up)
      currentMockInput.pressKey("ARROW_UP", { shift: true, super: true })
      await renderOnce()

      // Should have selection
      expect(editor.hasSelection()).toBe(true)

      // Selection should include content from line 0 to line 25
      const selectedText = editor.getSelectedText()
      expect(selectedText).toContain("Line 00")
      expect(selectedText).toContain("Line 24")
      expect(selectedText.split("\n").length).toBeGreaterThanOrEqual(25)

      const viewportAfter = editor.editorView.getViewport()
      expect(viewportAfter.offsetY).toBe(0)
    })

    it("should select to buffer end with shift+super+down in scrollable textarea", async () => {
      // Create textarea with content taller than visible area
      const lines = Array.from({ length: 50 }, (_, i) => `Line ${i.toString().padStart(2, "0")}`)
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: lines.join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      // Move cursor to line 20
      editor.focus()
      editor.gotoLine(20)
      await renderOnce()

      const viewportBefore = editor.editorView.getViewport()
      expect(viewportBefore.offsetY).toBeGreaterThan(0)

      // Select to buffer end (shift+super+down)
      currentMockInput.pressKey("ARROW_DOWN", { shift: true, super: true })
      await renderOnce()

      // Should have selection
      expect(editor.hasSelection()).toBe(true)

      // Selection should include content from line 20 to line 49
      const selectedText = editor.getSelectedText()
      expect(selectedText).toContain("Line 20")
      expect(selectedText).toContain("Line 49")
      expect(selectedText.split("\n").length).toBeGreaterThanOrEqual(29)

      const viewportAfter = editor.editorView.getViewport()
      const totalLines = editor.editorView.getTotalVirtualLineCount()
      const maxOffsetY = Math.max(0, totalLines - viewportBefore.height)
      expect(viewportAfter.offsetY).toBe(maxOffsetY)
    })

    it("should handle selection across viewport boundaries correctly", async () => {
      // Create textarea with content taller than visible area
      const lines = Array.from({ length: 30 }, (_, i) => `Line ${i.toString().padStart(2, "0")}`)
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: lines.join("\n"),
        width: 40,
        height: 5, // Small viewport
        selectable: true,
      })

      // Move cursor to middle (line 15)
      editor.focus()
      editor.gotoLine(15)
      // Move to column 5
      for (let i = 0; i < 5; i++) {
        editor.moveCursorRight()
      }
      await renderOnce()

      const cursorBefore = editor.editorView.getVisualCursor()
      expect(cursorBefore.logicalRow).toBe(15)
      expect(cursorBefore.logicalCol).toBe(5)

      // Select to buffer home
      currentMockInput.pressKey("ARROW_UP", { shift: true, super: true })
      await renderOnce()

      expect(editor.hasSelection()).toBe(true)
      const selectedText = editor.getSelectedText()

      // Should select from (15, 5) to (0, 0)
      // First line should be complete, last line should be partial
      expect(selectedText.startsWith("Line 00")).toBe(true)
      expect(selectedText).toContain("Line 14")
    })
  })
})

function countSelectedCells(
  bg: Uint16Array,
  bufferWidth: number,
  editor: { x: number; y: number; height: number; width: number },
  r: number,
  g: number,
  b: number,
): number {
  let count = 0
  for (let y = 0; y < editor.height; y++) {
    for (let x = 0; x < editor.width; x++) {
      const bufferIdx = (editor.y + y) * bufferWidth + (editor.x + x)
      const bgR = (bg[bufferIdx * 4] & 0xff) / 255
      const bgG = (bg[bufferIdx * 4 + 1] & 0xff) / 255
      const bgB = (bg[bufferIdx * 4 + 2] & 0xff) / 255
      if (Math.abs(bgR - r) < 0.01 && Math.abs(bgG - g) < 0.01 && Math.abs(bgB - b) < 0.01) {
        count++
      }
    }
  }
  return count
}
