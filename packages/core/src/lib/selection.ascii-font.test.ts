import { afterEach, describe, expect, it } from "bun:test"
import { ASCIIFontRenderable } from "../renderables/ASCIIFont.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { ASCIIFontSelectionHelper, type LocalSelectionBounds } from "./selection.js"

function helper() {
  return new ASCIIFontSelectionHelper(
    () => "HI",
    () => "tiny",
  )
}

function bounds(anchorX: number, focusX: number, anchorY = 0, focusY = 0): LocalSelectionBounds {
  return {
    anchorX,
    anchorY,
    focusX,
    focusY,
    isActive: true,
    behavior: "cell",
  }
}

describe("ASCIIFontSelectionHelper", () => {
  // tiny "H" is 3 cols, letterspace 1, "I" is 1 col. Positions: H@0, I@4.
  const hStart = 0
  const iStart = 4
  const height = 2
  const width = 5

  it.each([
    ["within H", hStart, 1, { start: 0, end: 1 }],
    ["at the right edge of H", hStart, 2, { start: 0, end: 1 }],
    ["from H to I", hStart, iStart, { start: 0, end: 2 }],
    ["from I to H", iStart, hStart, { start: 0, end: 2 }],
  ] as const)("selects occupied characters %s", (_name, anchorX, focusX, expected) => {
    const sel = helper()
    sel.onLocalSelectionChanged(bounds(anchorX, focusX), width, height)

    expect(sel.getSelection()).toEqual(expected)
  })

  it("stays empty on a press without drag", () => {
    const sel = helper()
    const changed = sel.onLocalSelectionChanged(bounds(hStart, hStart), width, height)

    expect(sel.getSelection()).toBe(null)
    expect(changed).toBe(false)
  })

  it("clears when the local selection is inactive", () => {
    const sel = helper()
    sel.onLocalSelectionChanged(bounds(hStart, iStart), width, height)
    expect(sel.hasSelection()).toBe(true)

    sel.onLocalSelectionChanged(null, width, height)
    expect(sel.hasSelection()).toBe(false)
  })

  it("uses vertical reading order outside the glyph row", () => {
    const sel = helper()
    sel.onLocalSelectionChanged(bounds(width, -1, -1, height), width, height)

    expect(sel.getSelection()).toEqual({ start: 0, end: 2 })
  })
})

describe("ASCIIFontRenderable selection", () => {
  let renderer: TestRenderer | undefined

  afterEach(() => renderer?.destroy())

  it("keeps unchanged active selections in renderer copy state", async () => {
    const test = await createTestRenderer({ width: 20, height: 4 })
    renderer = test.renderer
    const font = new ASCIIFontRenderable(renderer, { text: "HI", font: "tiny" })
    renderer.root.add(font)
    await test.renderOnce()

    renderer.startSelection(font, font.x, font.y)
    renderer.updateSelection(font, font.x + 4, font.y)
    renderer.updateSelection(font, font.x + 4, font.y, { finishDragging: true })

    expect(renderer.getSelection()?.getSelectedText()).toBe("HI")
  })
})
