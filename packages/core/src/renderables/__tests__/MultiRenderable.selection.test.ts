import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockMouse } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"
import { TextRenderable } from "../Text.js"
import { RGBA } from "../../lib/RGBA.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMouse: MockMouse

describe("Multi-Renderable Selection Tests", () => {
  beforeEach(async () => {
    ;({
      renderer: currentRenderer,
      renderOnce,
      mockMouse: currentMouse,
    } = await createTestRenderer({
      width: 80,
      height: 24,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  it("should handle selection across Textarea and Text renderable", async () => {
    // Create a Textarea with scrolling content
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n"),
      width: 40,
      height: 5,
      left: 0,
      top: 0,
      selectable: true,
    })

    // Create a Text renderable below the Textarea
    const textRenderable = new TextRenderable(currentRenderer, {
      content: "Text Below Textarea",
      width: 40,
      height: 1,
      left: 0,
      top: 6, // Positioned below the textarea (height 5 + some gap or directly below)
      selectable: true,
    })
    currentRenderer.root.add(textRenderable)
    await renderOnce()

    // Scroll the Textarea down
    editor.gotoLine(10)
    await renderOnce()

    const viewport = editor.editorView.getViewport()
    expect(viewport.offsetY).toBeGreaterThan(0)

    // Mouse drag from inside the Textarea to the Text renderable
    // Start: middle of the visible Textarea (relative to scrolled content)
    // End: inside the Text renderable

    const startX = editor.x + 2
    const startY = editor.y + 2
    const endX = textRenderable.x + 5
    const endY = textRenderable.y

    await currentMouse.drag(startX, startY, endX, endY)
    await renderOnce()

    expect(editor.hasSelection()).toBe(true)
    expect(textRenderable.hasSelection()).toBe(true)

    const selectedTextareaText = editor.getSelectedText()
    const selectedTextText = textRenderable.getSelectedText()

    // Verify selection in Textarea (should be from the scrolled viewport)
    // The selection starts at column 2 of the line visible at relative row 2
    // and extends to the end of the visible buffer since we dragged out of it.
    // Since we scrolled to line 10 with a height of 5 and scroll margin of 0.2 (default),
    // the viewport logic will position line 10 appropriately.
    // We check for content that corresponds to this viewport position.
    expect(selectedTextareaText).toContain("ne 9")
    expect(selectedTextareaText).toContain("Line 10")

    // Verify selection in Text renderable
    expect(selectedTextText).toBe("Text B")
  })
})
