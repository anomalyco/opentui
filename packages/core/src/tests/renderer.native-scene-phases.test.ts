import { afterEach, expect, test } from "bun:test"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []
afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

test("oscillating size feedback is bounded and cannot publish an unsettled frame", async () => {
  const clock = new ManualClock()
  const result = await createTestRenderer({ width: 12, height: 4, clock })
  setups.push(result)
  const { renderer, renderOnce, captureSpans } = result
  const errors: Error[] = []
  let frames = 0
  const box = new BoxRenderable(renderer, { width: 2, height: 1, position: "absolute", backgroundColor: "red" })
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  renderer.root.add(box)
  await renderOnce()
  clock.runAll()
  await renderer.idle()
  const previousFrames = frames
  const before = captureSpans()
  const previousHit = renderer.hitTest(4, 0)
  let changes = 0
  const runaway = new Error("test safety limit reached before layout rejected oscillation")
  box.onSizeChange = () => {
    if (++changes >= 1024) throw runaway
    box.width = box.width === 2 ? 3 : 2
  }
  box.left = 4
  box.width = 3
  clock.runAll()
  await renderer.idle()
  expect(changes).toBeGreaterThan(1)
  expect(errors).toHaveLength(1)
  expect(errors[0]).not.toBe(runaway)
  expect(frames).toBe(previousFrames)
  expect(captureSpans()).toEqual(before)
  expect(renderer.hitTest(0, 0)).toBe(box.num)
  expect(renderer.hitTest(4, 0)).toBe(previousHit)
  expect(renderer.getSchedulerState().isRendering).toBe(false)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})
