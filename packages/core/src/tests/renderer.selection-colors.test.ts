import { afterEach, describe, expect, it } from "bun:test"
import { RGBA } from "../lib/RGBA.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { createTestRenderer, type MockMouse, type TestRenderer } from "../testing/test-renderer.js"

const highlight = RGBA.fromHex("#3366ff")
const ink = RGBA.fromHex("#ffffff")
const own = RGBA.fromHex("#ff0000")

let renderer: TestRenderer | undefined

afterEach(() => {
  renderer?.destroy()
  renderer = undefined
})

async function setup(options: { selectionBg?: RGBA; selectionFg?: RGBA } = {}) {
  const setup = await createTestRenderer({ width: 40, height: 6, ...options })
  renderer = setup.renderer
  return setup
}

function cell(target: TestRenderer, x: number, y: number) {
  const index = y * target.currentRenderBuffer.width + x
  return target.currentRenderBuffer.withBuffers(({ fg, bg }) => ({
    fg: RGBA.fromArray(fg.slice(index * 4, index * 4 + 4)),
    bg: RGBA.fromArray(bg.slice(index * 4, index * 4 + 4)),
  }))
}

async function select(mouse: MockMouse, renderOnce: () => Promise<void>, x: number, y: number, length: number) {
  await mouse.drag(x, y, x + length, y)
  await renderOnce()
}

describe("renderer selection colours", () => {
  it("paints a text selection with the renderer's colours", async () => {
    const { renderer, mockMouse, renderOnce } = await setup({ selectionBg: highlight, selectionFg: ink })
    const text = new TextRenderable(renderer, { content: "Selected text", fg: "#101010" })
    renderer.root.add(text)
    await renderOnce()

    await select(mockMouse, renderOnce, text.x, text.y, 5)

    expect(text.getSelectedText()).toBe("Select")
    expect(cell(renderer, text.x + 1, text.y)).toEqual({ fg: ink, bg: highlight })
    expect(text.selectionBg).toBeUndefined()
  })

  it("paints a textarea selection with the renderer's colours", async () => {
    const { renderer, mockMouse, renderOnce } = await setup({ selectionBg: highlight, selectionFg: ink })
    const textarea = new TextareaRenderable(renderer, {
      initialValue: "Selected text",
      width: 30,
      height: 2,
      textColor: "#101010",
    })
    renderer.root.add(textarea)
    await renderOnce()

    await select(mockMouse, renderOnce, textarea.x, textarea.y, 5)

    expect(textarea.getSelectedText()).toBe("Select")
    expect(cell(renderer, textarea.x + 1, textarea.y)).toEqual({ fg: ink, bg: highlight })
  })

  it("keeps a renderable's own selection colours", async () => {
    const { renderer, mockMouse, renderOnce } = await setup({ selectionBg: highlight, selectionFg: ink })
    const text = new TextRenderable(renderer, { content: "Selected text", fg: "#101010", selectionBg: own })
    renderer.root.add(text)
    await renderOnce()

    await select(mockMouse, renderOnce, text.x, text.y, 5)

    expect(cell(renderer, text.x + 1, text.y)).toEqual({ fg: ink, bg: own })
  })

  it("repaints an active selection when the renderer's colours change", async () => {
    const { renderer, mockMouse, renderOnce } = await setup()
    const text = new TextRenderable(renderer, { content: "Selected text", fg: "#101010" })
    renderer.root.add(text)
    await renderOnce()
    await select(mockMouse, renderOnce, text.x, text.y, 5)

    renderer.setSelectionColors(highlight, ink)
    await renderOnce()

    expect(text.getSelectedText()).toBe("Select")
    expect(cell(renderer, text.x + 1, text.y)).toEqual({ fg: ink, bg: highlight })
    expect(renderer.selectionBg).toEqual(highlight)
    expect(renderer.selectionFg).toEqual(ink)
  })

  it("inverts the cells again once the renderer's colours are cleared", async () => {
    const { renderer, mockMouse, renderOnce } = await setup({ selectionBg: highlight, selectionFg: ink })
    const text = new TextRenderable(renderer, { content: "Selected text", fg: "#101010" })
    renderer.root.add(text)
    await renderOnce()
    await select(mockMouse, renderOnce, text.x, text.y, 5)

    renderer.setSelectionColors(undefined, undefined)
    await renderOnce()

    expect(cell(renderer, text.x + 1, text.y).bg).toEqual(RGBA.fromHex("#101010"))
  })
})
