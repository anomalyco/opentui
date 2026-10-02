import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { CliRenderEvents } from "../renderer.js"
import { SliderRenderable } from "../renderables/Slider.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

test("slider mouse change can destroy its control without continuing a stale handler", async () => {
  const target = await createTestRenderer({ width: 14, height: 12, clock: new ManualClock() })
  setups.push(target)
  const errors: unknown[] = []
  target.renderer.on(CliRenderEvents.HANDLER_ERROR, ({ error }) => errors.push(error))
  const slider = new SliderRenderable(target.renderer, {
    orientation: "horizontal",
    width: 8,
    height: 1,
    onChange: () => slider.destroy(),
  })
  target.renderer.root.add(slider)
  await target.renderOnce()
  await target.mockMouse.pressDown(6, 0)
  assert.equal(slider.isDestroyed, true)
  assert.deepEqual(errors, [])
  await target.renderOnce()
  assert.notEqual(target.renderer.hitTest(6, 0), slider.num)
})
