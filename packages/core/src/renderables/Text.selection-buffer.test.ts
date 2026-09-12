import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { TextRenderable } from "./Text.js"
import { RGBA } from "../lib/RGBA.js"
import { createTestRenderer, type MockMouse, type TestRenderer } from "../testing/test-renderer.js"
import { BoxRenderable } from "./Box.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMouse: MockMouse

describe("TextRenderable Selection - Buffer Validation", () => {
  beforeEach(async () => {
    ;({
      renderer: currentRenderer,
      renderOnce,
      mockMouse: currentMouse,
    } = await createTestRenderer({
      width: 50,
      height: 10,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  it("applies selection background colors to selected text renderables", async () => {
    const box1 = new BoxRenderable(currentRenderer, {
      id: "box1",
      left: 2,
      top: 2,
      width: 45,
      height: 7,
      backgroundColor: "#1e2936",
      borderColor: "#58a6ff",
      title: "Document Section 1",
      flexDirection: "column",
      padding: 1,
      border: true,
    })
    currentRenderer.root.add(box1)

    const text1 = new TextRenderable(currentRenderer, {
      id: "text1",
      content: "This is a paragraph in the first box.",
      fg: "#f0f6fc",
      selectionBg: "#4a5568",
      selectionFg: "#ffffff",
    })
    box1.add(text1)

    const text2 = new TextRenderable(currentRenderer, {
      id: "text2",
      content: "It contains multiple lines of text",
      fg: "#f0f6fc",
      selectionBg: "#4a5568",
      selectionFg: "#ffffff",
    })
    box1.add(text2)

    const text3 = new TextRenderable(currentRenderer, {
      id: "text3",
      content: "that can be selected independently.",
      fg: "#f0f6fc",
      selectionBg: "#4a5568",
      selectionFg: "#ffffff",
    })
    box1.add(text3)

    await renderOnce()

    await currentMouse.drag(text1.x, text1.y, text2.x + 10, text2.y)
    await renderOnce()

    expect(text1.hasSelection()).toBe(true)
    expect(text2.hasSelection()).toBe(true)
    expect(text3.hasSelection()).toBe(false)

    expect(text1.getSelectedText()).toBe("This is a paragraph in the first box.")
    expect(text2.getSelectedText()).toBe("It contains")

    const buffers = currentRenderer.currentRenderBuffer.buffers
    const width = currentRenderer.currentRenderBuffer.width
    const expectedBg = RGBA.fromHex("#4a5568")

    const getBgAt = (x: number, y: number) => {
      const index = y * width + x
      return RGBA.fromArray(buffers.bg.slice(index * 4, index * 4 + 4))
    }

    for (let col = text1.x; col < text1.x + text1.plainText.length; col++) {
      const bg = getBgAt(col, text1.y)
      const bgMatches =
        Math.abs(bg.r - expectedBg.r) < 0.01 &&
        Math.abs(bg.g - expectedBg.g) < 0.01 &&
        Math.abs(bg.b - expectedBg.b) < 0.01
      expect(bgMatches).toBe(true)
    }

    for (let col = text2.x; col < text2.x + 11; col++) {
      const bg = getBgAt(col, text2.y)
      const bgMatches =
        Math.abs(bg.r - expectedBg.r) < 0.01 &&
        Math.abs(bg.g - expectedBg.g) < 0.01 &&
        Math.abs(bg.b - expectedBg.b) < 0.01
      expect(bgMatches).toBe(true)
    }

    for (let col = text2.x + 11; col < text2.x + text2.plainText.length; col++) {
      const bg = getBgAt(col, text2.y)
      const bgMatches =
        Math.abs(bg.r - expectedBg.r) < 0.01 &&
        Math.abs(bg.g - expectedBg.g) < 0.01 &&
        Math.abs(bg.b - expectedBg.b) < 0.01
      expect(bgMatches).toBe(false)
    }
  })
})
