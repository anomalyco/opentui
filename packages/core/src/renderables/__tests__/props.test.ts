import { afterAll, expect, test } from "bun:test"
import { BoxRenderable, InputRenderable, InputRenderableEvents as Input, SelectRenderable } from "../index.js"
import { SelectRenderableEvents as Select, setRenderableProp, TextareaRenderable } from "../index.js"
import { TabSelectRenderable, TabSelectRenderableEvents as TabSelect } from "../index.js"
import { createTestRenderer } from "../../testing/test-renderer.js"

const { renderer } = await createTestRenderer({ width: 10, height: 4 })
afterAll(() => renderer.destroy())
const [a, b] = [() => {}, () => {}]

// React and Solid write every prop through `setRenderableProp`. Each row writes a sequence of values to one prop.
test.each<[string, new (...args: any[]) => any, string, unknown[], (node: any) => unknown, unknown]>([
  [
    "style keys",
    BoxRenderable,
    "style",
    [{ opacity: 0.5, title: "T" }, {}],
    (n) => [n.opacity, n.title],
    [1, undefined],
  ],
  ["style", BoxRenderable, "style", [{ opacity: 0.5 }, undefined], (n) => n.opacity, 1],
  ["focused", InputRenderable, "focused", [false, true], (n) => n.focused, true],
  ["Input onSubmit", InputRenderable, "onSubmit", [a, b], (n) => n.listeners(Input.ENTER), [b]],
  ["Select", SelectRenderable, "onChange", [a, b], (n) => n.listeners(Select.SELECTION_CHANGED), [b]],
  ["TabSelect", TabSelectRenderable, "onSelect", [a, b], (n) => n.listeners(TabSelect.ITEM_SELECTED), [b]],
  ["Textarea onSubmit", TextareaRenderable, "onSubmit", [a, b], (n) => n.onSubmit, b],
  ["unmapped event prop", BoxRenderable, "onSubmit", [a], (n) => n.onSubmit, a],
])("%s", (_, Renderable, name, writes, read, expected) => {
  const node = new Renderable(renderer, {})
  writes.reduce((prev, value) => (setRenderableProp(node, name, value, prev), value), undefined)
  expect(read(node)).toEqual(expected)
  node.destroyRecursively()
})
