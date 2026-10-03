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

// A dormant built-in keeps its registration position while it needs no pass.
class Dormant extends BoxRenderable {
  active = false
  override _needsLifecyclePass(): boolean {
    return this.active
  }
}

test("lifecycle passes run once per frame in registration order, including passes activated during the frame", async () => {
  const result = await createTestRenderer({ width: 12, height: 4 })
  setups.push(result)
  const { renderer, renderOnce } = result
  const passes = renderer.nativeScene.lifecyclePasses
  const runs: string[] = []
  const node = (id: string, Kind = BoxRenderable) => {
    const renderable = new Kind(renderer, { id })
    renderer.root.add(renderable)
    return renderable
  }
  const record = function (this: BoxRenderable) {
    runs.push(this.id)
  }
  const early = node("early", Dormant) as Dormant
  renderer.registerLifecyclePass(early)
  const first = node("first")
  first.onLifecyclePass = function () {
    record.call(this)
    // Activation behind the running pass waits for the next frame; ahead of it, the pass runs in this frame.
    early.active = late.active = true
    passes.refresh(early)
    passes.refresh(late)
    passes.refresh(late)
    removed.onLifecyclePass = null
    expect(() => passes.iteratePending().next()).toThrow("already active")
  }
  const late = node("late", Dormant) as Dormant
  renderer.registerLifecyclePass(late)
  const removed = node("removed")
  removed.onLifecyclePass = record
  early.onLifecyclePass = late.onLifecyclePass = record

  await renderOnce()
  expect(runs).toEqual(["first", "late"])

  runs.length = 0
  await renderOnce()
  expect(runs).toEqual(["early", "first", "late"])

  runs.length = 0
  late.onLifecyclePass = function () {
    record.call(this)
    passes.clear()
  }
  passes.add(removed)
  removed.onLifecyclePass = record
  await renderOnce()
  expect(runs).toEqual(["early", "first", "late"])
  runs.length = 0
  await renderOnce()
  expect(runs).toEqual([])
})
