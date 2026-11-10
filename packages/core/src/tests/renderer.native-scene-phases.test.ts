import { afterEach, expect, test } from "bun:test"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { RGBA } from "../lib/RGBA.js"
import { NativeSceneFrame, NativeStatus } from "../zig.js"
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
  expect(errors[0]).toMatchObject({ status: NativeStatus.LayoutLimit })
  expect(frames).toBe(previousFrames)
  expect(captureSpans()).toEqual(before)
  expect(renderer.hitTest(0, 0)).toBe(box.num)
  expect(renderer.hitTest(4, 0)).toBe(previousHit)
  expect(renderer.getSchedulerState().isRendering).toBe(false)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})

test("paint answers every hook request and completes in one synchronous call", async () => {
  const result = await createTestRenderer({ width: 12, height: 4 })
  setups.push(result)
  const { renderer } = result
  const hooks: string[] = []
  class Hooked extends BoxRenderable {
    protected override onUpdate(): void {
      hooks.push("update")
    }
    protected override renderSelf(): void {
      hooks.push("render")
    }
  }
  renderer.root.add(new Hooked(renderer, { width: 2, height: 1 }))
  const background = RGBA.fromInts(0, 0, 0, 0)
  const painting = renderer.nativeScene.paint(0, () => ({ background, useMouse: false, excludedHitNum: 0 }))
  try {
    expect(painting).toBeUndefined()
    expect(hooks).toEqual(["update", "render"])
    expect(renderer.nativeScene.frame?.kind).toBe(NativeSceneFrame.Done)
  } finally {
    renderer.nativeScene.cancelFrame()
  }
})
