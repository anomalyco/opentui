import { test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type MockMouse, type TestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextareaRenderable } from "../renderables/Textarea.js"

let renderer: TestRenderer
let renderOnce: () => Promise<void>
let mockMouse: MockMouse
let clock: ManualClock

beforeEach(async () => {
  clock = new ManualClock()
  ;({ renderer, renderOnce, mockMouse } = await createTestRenderer({ clock }))
})

afterEach(() => {
  renderer.destroy()
})

test("selection on destroyed renderable should not throw", () => {
  const text = new TextRenderable(renderer, {
    content: "Hello World",
    width: 20,
    height: 1,
  })

  renderer.root.add(text)
  renderOnce()

  // Start selection
  renderer.startSelection(text, 0, 0)

  // Update selection - this should not throw
  renderer.updateSelection(text, 5, 1)

  expect(renderer.getSelection()).not.toBeNull()

  // Destroy the text renderable
  text.destroy()

  expect(text.isDestroyed).toBe(true)

  // Get selection - this should not throw
  expect(renderer.getSelection()!.getSelectedText()).toBe("")

  // Update selection - this should not throw
  renderer.updateSelection(text, 8, 1)

  // Clear selection - this should not throw
  renderer.clearSelection()

  expect(renderer.getSelection()).toBeNull()
})

test("selected text joins same-row renderables without newlines", () => {
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    width: 20,
    height: 1,
  })
  const left = new TextRenderable(renderer, {
    content: "Hello ",
    width: 6,
    height: 1,
    selectable: true,
  })
  const right = new TextRenderable(renderer, {
    content: "World",
    width: 5,
    height: 1,
    selectable: true,
  })

  row.add(left)
  row.add(right)
  renderer.root.add(row)
  renderOnce()

  renderer.startSelection(left, left.x, left.y)
  renderer.updateSelection(right, right.x + right.width, right.y, { finishDragging: true })

  expect(renderer.getSelection()?.getSelectedText()).toBe("Hello World")
})

test("selected text keeps newlines between different rows", () => {
  const top = new TextRenderable(renderer, {
    content: "First row",
    left: 0,
    top: 0,
    width: 9,
    height: 1,
    selectable: true,
  })
  const bottom = new TextRenderable(renderer, {
    content: "Second row",
    left: 0,
    top: 1,
    width: 10,
    height: 1,
    selectable: true,
  })

  renderer.root.add(top)
  renderer.root.add(bottom)
  renderOnce()

  renderer.startSelection(top, top.x, top.y)
  renderer.updateSelection(bottom, bottom.x + bottom.width, bottom.y, { finishDragging: true })

  expect(renderer.getSelection()?.getSelectedText()).toBe("First row\nSecond row")
})

test("selected text merges multiline same-row renderables by visual row", () => {
  const row = new BoxRenderable(renderer, {
    flexDirection: "row",
    width: 4,
    height: 2,
  })
  const left = new TextRenderable(renderer, {
    content: "A\nB",
    width: 1,
    height: 2,
    selectable: true,
  })
  const right = new TextRenderable(renderer, {
    content: "1\n2",
    width: 1,
    height: 2,
    selectable: true,
  })

  row.add(left)
  row.add(right)
  renderer.root.add(row)
  renderOnce()

  renderer.startSelection(left, left.x, left.y)
  renderer.updateSelection(right, right.x + right.width, right.y + 1, { finishDragging: true })

  expect(renderer.getSelection()?.getSelectedText()).toBe("A1\nB2")
})

async function addSelectableText(): Promise<TextRenderable> {
  const text = new TextRenderable(renderer, {
    content: "alpha beta gamma",
    width: 20,
    height: 1,
    selectable: true,
  })
  renderer.root.add(text)
  await renderOnce()
  return text
}

test("double-click on beta selects the word", async () => {
  const text = await addSelectableText()
  await mockMouse.doubleClick(text.x + 6, text.y)
  await renderOnce()
  expect(text.getSelectedText()).toBe("beta")
})

test("triple-click selects the line", async () => {
  const text = await addSelectableText()
  await mockMouse.click(text.x + 6, text.y)
  await mockMouse.click(text.x + 6, text.y)
  await mockMouse.click(text.x + 6, text.y)
  await renderOnce()
  expect(text.getSelectedText()).toBe("alpha beta gamma")
})

test("two clicks 600ms apart stay a cell press", async () => {
  const text = await addSelectableText()
  await mockMouse.click(text.x + 6, text.y)
  clock.advance(600)
  await mockMouse.click(text.x + 6, text.y)
  await renderOnce()
  expect(text.getSelectedText()).toBe("")
})

test("two clicks one cell apart start a new sequence", async () => {
  const text = await addSelectableText()
  await mockMouse.click(text.x + 6, text.y)
  await mockMouse.click(text.x + 8, text.y)
  await renderOnce()
  expect(text.getSelectedText()).toBe("")
})

test("double-click then drag onto the next word selects both", async () => {
  const text = await addSelectableText()
  await mockMouse.click(text.x + 6, text.y)
  await mockMouse.drag(text.x + 6, text.y, text.x + 12, text.y)
  await renderOnce()
  expect(text.getSelectedText()).toBe("beta gamma")
})

const highlight = RGBA.fromHex("#3366ff")
const ink = RGBA.fromHex("#ffffff")
const own = RGBA.fromHex("#ff0000")

function cell(x: number, y: number) {
  const index = y * renderer.currentRenderBuffer.width + x
  return renderer.currentRenderBuffer.withBuffers(({ fg, bg }) => ({
    fg: RGBA.fromArray(fg.slice(index * 4, index * 4 + 4)),
    bg: RGBA.fromArray(bg.slice(index * 4, index * 4 + 4)),
  }))
}

async function useRendererColours(): Promise<void> {
  renderer.destroy()
  ;({ renderer, renderOnce, mockMouse } = await createTestRenderer({ clock, selectionBg: highlight, selectionFg: ink }))
}

async function selectFirstCells(target: { x: number; y: number }): Promise<void> {
  await mockMouse.drag(target.x, target.y, target.x + 5, target.y)
  await renderOnce()
}

async function selectText(options: { selectionBg?: RGBA } = {}): Promise<TextRenderable> {
  const text = new TextRenderable(renderer, { content: "Selected text", fg: "#101010", ...options })
  renderer.root.add(text)
  await renderOnce()
  await selectFirstCells(text)
  return text
}

async function addTextarea(options: { selectionBg?: RGBA } = {}): Promise<TextareaRenderable> {
  const textarea = new TextareaRenderable(renderer, {
    initialValue: "Selected text",
    width: 30,
    height: 2,
    textColor: "#101010",
    ...options,
  })
  renderer.root.add(textarea)
  await renderOnce()
  return textarea
}

test("renderer selection colours paint a text selection", async () => {
  await useRendererColours()
  const text = await selectText()

  expect(text.getSelectedText()).toBe("Select")
  expect(cell(text.x + 1, text.y)).toEqual({ fg: ink, bg: highlight })
  expect(text.selectionBg).toBeUndefined()
})

test("renderer selection colours paint a textarea selection", async () => {
  await useRendererColours()
  const textarea = await addTextarea()
  await selectFirstCells(textarea)

  expect(textarea.getSelectedText()).toBe("Select")
  expect(cell(textarea.x + 1, textarea.y)).toEqual({ fg: ink, bg: highlight })
})

test("a renderable's own selection colour wins over the renderer's", async () => {
  await useRendererColours()
  const text = await selectText({ selectionBg: own })

  expect(cell(text.x + 1, text.y)).toEqual({ fg: ink, bg: own })
})

test("renderer selection colours repaint an active selection", async () => {
  const text = await selectText()

  renderer.setSelectionColors(highlight, ink)
  await renderOnce()

  expect(text.getSelectedText()).toBe("Select")
  expect(cell(text.x + 1, text.y)).toEqual({ fg: ink, bg: highlight })
  expect(renderer.selectionBg).toEqual(highlight)
  expect(renderer.selectionFg).toEqual(ink)
})

test("clearing the renderer's selection colours inverts the cells again", async () => {
  await useRendererColours()
  const text = await selectText()

  renderer.setSelectionColors(undefined, undefined)
  await renderOnce()

  expect(cell(text.x + 1, text.y).bg).toEqual(RGBA.fromHex("#101010"))
})

test("renderer selection colours recolour a scrolled selection without moving it", async () => {
  const box = new ScrollBoxRenderable(renderer, { width: 20, height: 4 })
  const lines = Array.from({ length: 12 }, (_, i) => `line${i} abcdefgh`)
  const text = new TextRenderable(renderer, { content: lines.join("\n") })
  box.add(text)
  renderer.root.add(box)
  await renderOnce()
  await mockMouse.drag(text.x, text.y, text.x + 4, text.y)
  box.scrollTop = 3
  await renderOnce()

  renderer.setSelectionColors(highlight, ink)
  await renderOnce()

  expect(text.getSelectedText()).toBe("line0")
})

test("renderer selection colours recolour a textarea's setSelection", async () => {
  const textarea = await addTextarea()
  textarea.setSelection(0, 6)

  renderer.setSelectionColors(highlight, ink)
  await renderOnce()

  expect(cell(textarea.x + 1, textarea.y)).toEqual({ fg: ink, bg: highlight })
})

test("a textarea that clears its own selection colour falls back to the renderer's", async () => {
  renderer.setSelectionColors(highlight, ink)
  const textarea = await addTextarea({ selectionBg: own })
  await selectFirstCells(textarea)
  expect(cell(textarea.x + 1, textarea.y)).toEqual({ fg: ink, bg: own })

  textarea.selectionBg = undefined
  await renderOnce()

  expect(cell(textarea.x + 1, textarea.y)).toEqual({ fg: ink, bg: highlight })
})
