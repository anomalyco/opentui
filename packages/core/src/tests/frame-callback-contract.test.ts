import { afterEach, beforeEach, expect, test } from "bun:test"
import { Renderable } from "../Renderable.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const red = RGBA.fromHex("#ff0000")
const green = RGBA.fromHex("#00ff00")
const blue = RGBA.fromHex("#0000ff")
let setup: TestRendererSetup

beforeEach(async () => {
  setup = await createTestRenderer({ width: 12, height: 4, clock: new ManualClock() })
})

afterEach(async () => {
  setup.renderer.destroy()
  await setup.renderer.closed
})

test("custom painting can publish a geometry-dependent foreground to later text in the same frame", async () => {
  const { renderer, renderOnce, captureSpans } = setup
  const label = new TextRenderable(renderer, { content: "tab", width: 3, height: 1, fg: red })
  class PulseRenderable extends Renderable {
    protected renderSelf(): void {
      label.fg = this.width === 6 ? green : blue
    }
  }
  const pulse = new PulseRenderable(renderer, { width: "50%", height: 1 })
  renderer.root.add(pulse)
  renderer.root.add(label)

  await renderOnce()

  expect(captureSpans().lines[1].spans[0]).toMatchObject({ text: "tab", fg: green })

  pulse.width = "25%"
  await renderOnce()

  expect(captureSpans().lines[1].spans[0]).toMatchObject({ text: "tab", fg: blue })
})

test("accepted width is immediate while computed and painted width wait for layout", async () => {
  const { renderer, renderOnce, captureSpans } = setup
  const box = new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: red })
  renderer.root.add(box)
  await renderOnce()

  box.width = 4
  expect(box.getWidth().value).toBe(4)
  expect(box.width).toBe(2)
  box.renderBefore = function () {
    this.width = 6
    this.renderBefore = undefined
  }

  await renderOnce()

  expect(box.getWidth().value).toBe(6)
  expect(box.width).toBe(4)
  expect(captureSpans().lines[0].spans[0]).toMatchObject({ width: 4, bg: red })

  await renderOnce()

  expect(box.width).toBe(6)
  expect(captureSpans().lines[0].spans[0]).toMatchObject({ width: 6, bg: red })
})
