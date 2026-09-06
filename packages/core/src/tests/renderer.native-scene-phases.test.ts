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

async function setup(clock = new ManualClock()) {
  const result = await createTestRenderer({ width: 12, height: 4, clock })
  setups.push(result)
  return result
}

test("resize feedback settles before painting without repeating unchanged sizes or updates", async () => {
  const { renderer, renderOnce, captureSpans } = await setup()
  const widths: number[] = []
  const updates: number[] = []
  const box = new BoxRenderable(renderer, {
    width: 2,
    height: 1,
    backgroundColor: "red",
    onSizeChange() {
      widths.push(this.width)
      if (this.width === 3) this.width = 6
    },
  })
  Object.assign(box, { onUpdate: () => updates.push(box.width) })
  renderer.root.add(box)
  await renderOnce()
  expect(widths).toEqual([])
  updates.length = 0
  box.width = 3
  await renderOnce()
  expect(updates).toEqual([2])
  expect(widths).toEqual([3, 6])
  expect(captureSpans().lines[0].spans[0].width).toBe(6)
  await renderOnce()
  expect(widths).toEqual([3, 6])
})

test("oscillating size feedback is bounded and cannot publish an unsettled frame", async () => {
  const clock = new ManualClock()
  const { renderer, renderOnce, captureSpans } = await setup(clock)
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

test("feedback preserves wrapper refresh order while raw Yoga exposes the completed round", async () => {
  const { renderer, renderOnce } = await setup()
  const parent = new BoxRenderable(renderer, { width: 4, height: 2 })
  const first = new BoxRenderable(renderer, { width: "100%", height: 1 })
  const second = new BoxRenderable(renderer, { width: "100%", height: 1 })
  parent.add(first)
  parent.add(second)
  renderer.root.add(parent)
  await renderOnce()
  const samples: number[][] = []
  first.onSizeChange = () => {
    samples.push([first.width, second.width, second.getLayout().width])
    if (first.width === 6) parent.width = 8
  }
  parent.width = 6
  await renderOnce()
  expect(samples).toEqual([
    [6, 4, 6],
    [8, 6, 8],
  ])
  expect(second.width).toBe(8)
})

test("resize subscriptions reconcile after throwing and reentrant meta-listeners", async () => {
  const { renderer, renderOnce } = await setup()
  const box = new BoxRenderable(renderer, { width: 2, height: 1 })
  renderer.root.add(box)
  await renderOnce()
  const failure = new Error("observer failure")
  let calls = 0
  const listener = () => calls++
  const rejectAddition = (event: string | symbol) => {
    if (event === "resize") throw failure
  }
  box.on("newListener", rejectAddition)
  expect(() => box.on("resize", listener)).toThrow(failure)
  box.off("newListener", rejectAddition)
  box.width = 3
  await renderOnce()
  expect(calls).toBe(0)
  box.on("resize", listener)
  const replaceRemoval = (event: string | symbol) => {
    if (event !== "resize" || box.isDestroyed) return
    box.on("resize", listener)
    throw failure
  }
  box.on("removeListener", replaceRemoval)
  expect(() => box.removeAllListeners("resize")).toThrow(failure)
  box.off("removeListener", replaceRemoval)
  expect(box.listenerCount("resize")).toBe(1)
  box.width = 4
  await renderOnce()
  expect(calls).toBe(1)
})

test("lifecycle preserves registration order and hidden-descendant behavior", async () => {
  const { renderer, renderOnce } = await setup()
  const calls: string[] = []
  const parent = new BoxRenderable(renderer, { width: 4, height: 2, visible: false })
  const child = new BoxRenderable(renderer, { width: 2, height: 1 })
  parent.onLifecyclePass = () => calls.push("parent:lifecycle")
  child.onLifecyclePass = () => calls.push("child:lifecycle")
  Object.assign(child, { onUpdate: () => calls.push("child:update") })
  parent.add(child)
  renderer.root.add(parent)
  await renderOnce()
  expect(calls).toEqual(["child:lifecycle", "parent:lifecycle"])
  calls.length = 0
  renderer.root.visible = false
  await renderOnce()
  expect(calls).toEqual([])
})
