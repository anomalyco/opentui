import { test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"

let renderer: TestRenderer
let renderOnce: () => void

beforeEach(async () => {
  ;({ renderer, renderOnce } = await createTestRenderer({}))
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
