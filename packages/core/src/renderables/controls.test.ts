import { afterAll, beforeAll, expect, test } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { FrameBufferRenderable } from "./FrameBuffer.js"
import { ScrollBarRenderable } from "./ScrollBar.js"
import { ScrollBoxRenderable } from "./ScrollBox.js"

let renderer: TestRenderer

beforeAll(async () => {
  ;({ renderer } = await createTestRenderer({ width: 40, height: 12 }))
})

afterAll(() => {
  renderer.destroy()
})

// The setters are covered by renderable-nullish-props.test.ts; these are the methods and the instance accessor.
test("control methods ignore calls after destroy", () => {
  const bar = new ScrollBarRenderable(renderer, { orientation: "vertical" })
  const scroll = new ScrollBoxRenderable(renderer, { width: 10, height: 5 })
  const frame = new FrameBufferRenderable(renderer, { width: 2, height: 2 })
  const buffer = frame.frameBuffer
  for (const node of [bar, scroll, frame]) node.destroyRecursively()
  bar.resetVisibilityControl()
  scroll.updateAutoScroll(0, 0)
  scroll.stopAutoScroll()
  frame.frameBuffer = buffer
  expect(frame.frameBuffer).toBeNull()
})
