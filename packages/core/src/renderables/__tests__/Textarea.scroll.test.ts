import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockMouse } from "../../testing/test-renderer.js"
import { createTextareaRenderable, simulateFrames as _simulateFrames } from "./renderable-test-utils.js"
import { TestRecorder } from "../../testing/test-recorder.js"
import { RGBA } from "../../lib/RGBA.js"
import { ManualClock } from "../../testing/manual-clock.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMouse: MockMouse
let clock: ManualClock

const simulateFrames = (ms: number, frameInterval?: number) => _simulateFrames(clock, renderOnce, ms, frameInterval)

function countSelectedCells(
  background: Uint16Array,
  bufferWidth: number,
  bounds: { x: number; y: number; width: number; height: number },
): number {
  let selectedCells = 0
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      const bufferIdx = y * bufferWidth + x
      const bgG = (background[bufferIdx * 4 + 1] & 0xff) / 255
      if (Math.abs(bgG - 1.0) < 0.01) {
        selectedCells++
      }
    }
  }
  return selectedCells
}

describe("Textarea - Scroll Tests", () => {
  beforeEach(async () => {
    clock = new ManualClock()
    ;({
      renderer: currentRenderer,
      renderOnce,
      mockMouse: currentMouse,
    } = await createTestRenderer({
      width: 80,
      height: 24,
      clock,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  describe("Mouse Selection Auto-Scroll", () => {
    it("should auto-scroll down when dragging selection below viewport", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      // Position at top
      editor.editBuffer.gotoLine(0)
      await renderOnce()

      const viewportBefore = editor.editorView.getViewport()
      expect(viewportBefore.offsetY).toBe(0)

      // Start dragging from top
      await currentMouse.pressDown(editor.x, editor.y)

      // Move to bottom edge to trigger auto-scroll (keep button pressed)
      await currentMouse.moveTo(editor.x + 5, editor.y + editor.height - 1)

      // Simulate 1 second of frames for auto-scroll
      await simulateFrames(1000)

      const viewportAfter = editor.editorView.getViewport()

      // Release mouse
      await currentMouse.release(editor.x + 5, editor.y + editor.height - 1)

      // Viewport should have scrolled down significantly
      expect(viewportAfter.offsetY).toBeGreaterThan(viewportBefore.offsetY)

      editor.destroy()
    })

    it("should set cursor to selection focus when selecting", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.editBuffer.gotoLine(0)
      await renderOnce()

      const cursorBefore = editor.logicalCursor

      // Start selection and drag
      await currentMouse.drag(editor.x, editor.y, editor.x + 10, editor.y + 5)
      await renderOnce()

      const cursorAfter = editor.logicalCursor

      // Cursor should have moved to the selection focus position
      expect(cursorAfter.row).toBeGreaterThan(cursorBefore.row)

      editor.destroy()
    })

    it("should auto-scroll up when dragging selection above viewport", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 100 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      // Start somewhere in the middle so we can scroll up
      editor.editBuffer.gotoLine(40)
      await renderOnce()

      const viewportBefore = editor.editorView.getViewport()
      expect(viewportBefore.offsetY).toBeGreaterThan(0)

      // Start dragging from within viewport
      await currentMouse.pressDown(editor.x + 2, editor.y + 5)
      // Drag to the top edge (within bounds) to trigger upward auto-scroll
      await currentMouse.moveTo(editor.x + 2, editor.y)

      // Simulate 1 second of frames for auto-scroll
      await simulateFrames(1000)

      const viewportAfter = editor.editorView.getViewport()

      await currentMouse.release(editor.x + 2, editor.y)

      expect(viewportAfter.offsetY).toBeLessThan(viewportBefore.offsetY)

      editor.destroy()
    })

    it("should stop auto-scroll when selection ends", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 100 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.editBuffer.gotoLine(0)
      await renderOnce()

      await currentMouse.pressDown(editor.x + 2, editor.y)
      await currentMouse.moveTo(editor.x + 2, editor.y + editor.height - 1)

      // Simulate 1 second of auto-scroll
      await simulateFrames(1000)

      // End selection (mouse up) and render a few more frames
      await currentMouse.release(editor.x + 2, editor.y + editor.height - 1)
      await simulateFrames(200)

      const viewportAfterRelease = editor.editorView.getViewport()

      // If selection-end notifications work, viewport should remain stable
      await simulateFrames(1000)

      const viewportFinal = editor.editorView.getViewport()

      expect(viewportFinal.offsetY).toBe(viewportAfterRelease.offsetY)

      editor.destroy()
    })
  })

  describe("Selection Focus Clamping", () => {
    it("should clamp cursor when dragging selection focus beyond buffer bounds", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 10 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      await renderOnce()

      // Start selection at the top of the buffer
      await currentMouse.pressDown(editor.x, editor.y)
      await renderOnce()

      // Drag selection far below the renderable's bounds (focusY way beyond buffer)
      await currentMouse.moveTo(editor.x + 2, editor.y + 200)
      await renderOnce()

      const cursor = editor.logicalCursor
      expect(cursor.row).toBe(9)

      await currentMouse.release(editor.x + 2, editor.y + 200)
      await renderOnce()

      editor.destroy()
    })
  })

  describe("Mouse Click Cursor Positioning", () => {
    it("should set cursor when clicking without dragging", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 0\nLine 1\nLine 2\nLine 3\nLine 4",
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.editBuffer.gotoLine(0)
      await renderOnce()

      const cursorBefore = editor.logicalCursor
      expect(cursorBefore.row).toBe(0)
      expect(cursorBefore.col).toBe(0)

      // Click on line 2, column 3
      await currentMouse.click(editor.x + 3, editor.y + 2)
      await renderOnce()

      const cursorAfter = editor.logicalCursor
      expect(cursorAfter.row).toBe(2)
      expect(cursorAfter.col).toBe(3)

      editor.destroy()
    })

    it("should set cursor when clicking on empty line", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Line 0\n\nLine 2\n\nLine 4",
        width: 40,
        height: 10,
        selectable: true,
      })

      await renderOnce()

      // Click on empty line 1
      await currentMouse.click(editor.x + 5, editor.y + 1)
      await renderOnce()

      const cursor1 = editor.logicalCursor
      expect(cursor1.row).toBe(1)
      expect(cursor1.col).toBe(0) // Empty line, cursor at column 0

      // Click on empty line 3
      await currentMouse.click(editor.x + 10, editor.y + 3)
      await renderOnce()

      const cursor2 = editor.logicalCursor
      expect(cursor2.row).toBe(3)
      expect(cursor2.col).toBe(0)

      editor.destroy()
    })

    it("should clamp cursor when clicking beyond line end", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Short\nMedium line\nVery long line here",
        width: 40,
        height: 10,
        selectable: true,
      })

      await renderOnce()

      // Click way beyond the end of "Short" (5 chars)
      await currentMouse.click(editor.x + 20, editor.y)
      await renderOnce()

      const cursor = editor.logicalCursor
      expect(cursor.row).toBe(0)
      expect(cursor.col).toBeLessThanOrEqual(5) // Clamped to line end

      editor.destroy()
    })

    it("should set cursor when clicking with scrolled viewport", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      // Scroll to middle
      editor.editBuffer.gotoLine(25)
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBeGreaterThan(10)

      const offsetYBefore = viewport.offsetY

      // Click on first visible line (which is line offsetY in absolute terms)
      await currentMouse.click(editor.x + 3, editor.y)
      await renderOnce()

      const cursor = editor.logicalCursor
      expect(cursor.row).toBe(offsetYBefore) // Should be the first visible line
      expect(cursor.col).toBe(3)

      editor.destroy()
    })
  })

  describe("Mouse Wheel Scrolling", () => {
    it("should scroll down on mouse wheel down", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.editBuffer.gotoLine(0)
      await renderOnce()

      const viewportBefore = editor.editorView.getViewport()
      expect(viewportBefore.offsetY).toBe(0)

      // Scroll down by 3 lines
      for (let i = 0; i < 3; i++) {
        await currentMouse.scroll(editor.x + 5, editor.y + 5, "down")
      }
      await renderOnce()

      const viewportAfter = editor.editorView.getViewport()
      expect(viewportAfter.offsetY).toBe(3)

      editor.destroy()
    })

    it("should move cursor into the viewport when wheel scrolling", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.editBuffer.gotoLine(0)
      await renderOnce()

      const cursorBefore = editor.logicalCursor
      expect(cursorBefore.row).toBe(0)

      // Scroll down a few lines
      for (let i = 0; i < 3; i++) {
        await currentMouse.scroll(editor.x + 5, editor.y + 5, "down")
      }
      await renderOnce()

      const viewportAfter = editor.editorView.getViewport()
      const cursorAfter = editor.logicalCursor

      // Wheel scrolling uses setViewport(..., moveCursor=true), which moves the cursor to stay visible
      expect(cursorAfter.row).toBeGreaterThan(cursorBefore.row)
      expect(cursorAfter.row).toBeGreaterThanOrEqual(viewportAfter.offsetY)
      expect(cursorAfter.row).toBeLessThan(viewportAfter.offsetY + viewportAfter.height)

      editor.destroy()
    })

    it("should scroll up on mouse wheel up", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      // Start at line 20
      editor.editBuffer.gotoLine(20)
      await renderOnce()

      const viewportBefore = editor.editorView.getViewport()
      expect(viewportBefore.offsetY).toBeGreaterThan(10)
      const offsetBefore = viewportBefore.offsetY

      // Scroll up by 5 lines
      for (let i = 0; i < 5; i++) {
        await currentMouse.scroll(editor.x + 5, editor.y + 5, "up")
      }
      await renderOnce()

      const viewportAfter = editor.editorView.getViewport()
      expect(viewportAfter.offsetY).toBe(offsetBefore - 5)

      editor.destroy()
    })

    it("should not scroll beyond top", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      editor.editBuffer.gotoLine(2)
      await renderOnce()

      // Scroll up by 100 lines (should clamp to 0)
      for (let i = 0; i < 100; i++) {
        await currentMouse.scroll(editor.x + 5, editor.y + 5, "up")
      }
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBe(0)

      editor.destroy()
    })

    it("should not scroll beyond bottom", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      await renderOnce()

      // Scroll down by 100 lines (should clamp to maxOffsetY = 20 - 10 = 10)
      for (let i = 0; i < 100; i++) {
        await currentMouse.scroll(editor.x + 5, editor.y + 5, "down")
      }
      await renderOnce()

      const viewport = editor.editorView.getViewport()
      expect(viewport.offsetY).toBe(10) // 20 lines - 10 viewport height

      editor.destroy()
    })

    it("should allow mouse wheel scroll after selection auto-scroll", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 100 }, (_, i) => `Line ${i}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
      })

      // Position at top
      editor.editBuffer.gotoLine(0)
      await renderOnce()

      const viewportInitial = editor.editorView.getViewport()
      expect(viewportInitial.offsetY).toBe(0)

      // Drag selection from top to way below viewport to trigger auto-scroll to bottom
      await currentMouse.pressDown(editor.x, editor.y)
      await currentMouse.moveTo(editor.x + 5, editor.y + editor.height - 1)

      // Simulate 2 seconds for auto-scroll to reach near the end
      await simulateFrames(2000)

      // Release mouse to complete selection
      await currentMouse.release(editor.x + 5, editor.y + editor.height - 1)

      const viewportAfterSelection = editor.editorView.getViewport()

      // Should have scrolled down significantly
      expect(viewportAfterSelection.offsetY).toBeGreaterThan(20)

      // Now use mouse wheel to scroll all the way back up
      for (let i = 0; i < 100; i++) {
        await currentMouse.scroll(editor.x + 5, editor.y + 5, "up")
      }
      await renderOnce()

      const viewportFinal = editor.editorView.getViewport()

      // Should have scrolled all the way back to top
      expect(viewportFinal.offsetY).toBe(0)

      editor.destroy()
    })
  })

  describe("Mouse Wheel Horizontal Scrolling", () => {
    it("should scroll horizontally with wheel when wrapping is disabled", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "A".repeat(200),
        width: 20,
        height: 5,
        wrapMode: "none",
        selectable: true,
      })

      await renderOnce()

      // Keep a selection active so native updateBeforeRender doesn't auto-scroll viewport back to cursor
      await currentMouse.drag(editor.x, editor.y, editor.x + 1, editor.y)
      await renderOnce()

      const viewportBefore = editor.editorView.getViewport()
      expect(viewportBefore.offsetX).toBe(0)

      for (let i = 0; i < 5; i++) {
        await currentMouse.scroll(editor.x + 2, editor.y + 2, "right")
      }
      await renderOnce()

      const viewportAfterRight = editor.editorView.getViewport()
      expect(viewportAfterRight.offsetX).toBe(5)

      for (let i = 0; i < 3; i++) {
        await currentMouse.scroll(editor.x + 2, editor.y + 2, "left")
      }
      await renderOnce()

      const viewportAfterLeft = editor.editorView.getViewport()
      expect(viewportAfterLeft.offsetX).toBe(2)

      editor.destroy()
    })

    it("should not scroll horizontally with wheel when wrapping is enabled", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "A".repeat(200),
        width: 20,
        height: 5,
        wrapMode: "word",
        selectable: true,
      })

      await renderOnce()

      // Keep selection active to avoid cursor-driven viewport changes
      await currentMouse.drag(editor.x, editor.y, editor.x + 1, editor.y)
      await renderOnce()

      const viewportBefore = editor.editorView.getViewport()
      expect(viewportBefore.offsetX).toBe(0)

      for (let i = 0; i < 5; i++) {
        await currentMouse.scroll(editor.x + 2, editor.y + 2, "right")
      }
      await renderOnce()

      const viewportAfter = editor.editorView.getViewport()
      expect(viewportAfter.offsetX).toBe(0)

      editor.destroy()
    })
  })

  describe("Viewport Offset After Resize", () => {
    it("should keep content at bottom when resizing from narrow wrapped to wide unwrapped", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from(
          { length: 15 },
          (_, i) => `This is line ${i.toString().padStart(2, "0")} with enough text to wrap when narrow`,
        ).join("\n"),
        width: 10,
        height: 10,
        wrapMode: "word",
        selectable: true,
      })

      await renderOnce()

      editor.focus()

      // Scroll to the very bottom
      editor.editBuffer.gotoLine(999)
      await renderOnce()

      const viewportAtBottom = editor.editorView.getViewport()
      const totalVirtualLinesNarrow = editor.editorView.getTotalVirtualLineCount()

      expect(viewportAtBottom.offsetY).toBeGreaterThan(10)

      // Resize to much wider - this will unwrap most lines
      editor.width = 80
      await renderOnce()

      const viewportAfterResize = editor.editorView.getViewport()
      const totalVirtualLinesWide = editor.editorView.getTotalVirtualLineCount()

      // After unwrapping, total lines should be much less (close to 15 logical lines)
      expect(totalVirtualLinesWide).toBeLessThan(totalVirtualLinesNarrow)

      // Content should still be at the bottom of the viewport
      // The last line should be visible at the bottom
      const maxOffsetYWide = Math.max(0, totalVirtualLinesWide - viewportAfterResize.height)
      expect(viewportAfterResize.offsetY).toBe(maxOffsetYWide)

      editor.destroy()
    })

    it("should clamp horizontal viewport offset when resizing wider with no wrap", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "A".repeat(200),
        width: 20,
        height: 10,
        wrapMode: "none",
        selectable: true,
      })

      await renderOnce()

      // Scroll horizontally to the far right
      editor.focus()
      for (let i = 0; i < 100; i++) {
        editor.moveCursorRight()
      }
      await renderOnce()

      const viewportNarrow = editor.editorView.getViewport()

      expect(viewportNarrow.offsetX).toBeGreaterThan(50)

      // Resize to much wider - viewport offsetX might now exceed valid range
      editor.width = 250
      await renderOnce()

      const viewportWide = editor.editorView.getViewport()
      const totalLineWidthWide = editor.lineInfo.lineWidthColsMax
      const maxOffsetXWide = Math.max(0, totalLineWidthWide - viewportWide.width)

      expect(viewportWide.offsetX).toBeLessThanOrEqual(maxOffsetXWide)

      editor.destroy()
    })

    it("should allow scrolling and selecting last line immediately after resize from wide to narrow", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from(
          { length: 20 },
          (_, i) =>
            `Line ${i.toString().padStart(2, "0")} with enough text content to cause wrapping when viewport becomes narrow`,
        ).join("\n"),
        width: 80,
        height: 10,
        wrapMode: "word",
        selectable: true,
      })

      await renderOnce()

      // Resize to very narrow - this will cause heavy wrapping
      editor.width = 10
      await renderOnce()

      const viewportAfterResize = editor.editorView.getViewport()
      const totalVirtualLinesNarrow = editor.editorView.getTotalVirtualLineCount()

      expect(totalVirtualLinesNarrow).toBeGreaterThan(20)

      // Immediately try to scroll down to the bottom with mouse wheel
      const maxOffsetY = Math.max(0, totalVirtualLinesNarrow - viewportAfterResize.height)

      for (let i = 0; i < maxOffsetY + 20; i++) {
        await currentMouse.scroll(editor.x + 2, editor.y + 2, "down")
      }
      await renderOnce()

      const viewportAfterScroll = editor.editorView.getViewport()

      // Should have scrolled close to the bottom (within scroll margin tolerance)
      expect(viewportAfterScroll.offsetY).toBeGreaterThan(maxOffsetY - 5)
      expect(viewportAfterScroll.offsetY).toBeLessThanOrEqual(maxOffsetY)

      // Now try to select text on the last visible line
      await currentMouse.drag(editor.x, editor.y + editor.height - 1, editor.x + 8, editor.y + editor.height - 1)
      await renderOnce()

      const selectedText = editor.getSelectedText()

      expect(editor.hasSelection()).toBe(true)
      expect(selectedText.length).toBeGreaterThan(0)

      editor.destroy()
    })

    it("should continuously update selection during auto-scroll without mouse movement", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: Array.from({ length: 100 }, (_, i) => `Line ${i.toString().padStart(2, "0")}`).join("\n"),
        width: 40,
        height: 10,
        selectable: true,
        selectionBg: RGBA.fromValues(0, 1, 0, 1), // Bright green for easy detection
      })

      await renderOnce()

      const recorder = new TestRecorder(currentRenderer, { recordBuffers: { bg: true } })

      editor.editBuffer.gotoLine(0)
      await renderOnce()

      recorder.rec()

      await currentMouse.pressDown(editor.x + 2, editor.y)
      await currentMouse.moveTo(editor.x + 2, editor.y + editor.height - 1)

      // Simulate 2 seconds of auto-scroll WITHOUT moving mouse
      await simulateFrames(2000)

      await currentMouse.release(editor.x + 2, editor.y + editor.height - 1)
      await renderOnce()
      recorder.stop()

      const frames = recorder.recordedFrames
      expect(frames.length).toBeGreaterThan(10)

      const bufferWidth = currentRenderer.width
      const editorBounds = { x: editor.x, y: editor.y, width: editor.width, height: editor.height }
      const selectionCellCounts: number[] = []

      for (const frame of frames) {
        if (!frame.buffers?.bg) continue
        selectionCellCounts.push(countSelectedCells(frame.buffers.bg, bufferWidth, editorBounds))
      }

      const firstFrameSelection = selectionCellCounts[0] || 0
      const lastFrameSelection = selectionCellCounts[selectionCellCounts.length - 1] || 0

      const framesWithoutSelection = selectionCellCounts.filter((count, i) => i > 0 && count === 0).length

      // Selection should expand and be continuously visible (no flicker)
      expect(lastFrameSelection).toBeGreaterThan(firstFrameSelection)
      expect(framesWithoutSelection).toBe(0)

      editor.destroy()
    })
  })
})
