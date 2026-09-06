import { afterEach, expect, test } from "bun:test"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
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
  const result = await createTestRenderer({ width: 12, height: 4, clock, maxFps: 1000 })
  setups.push(result)
  const errors: Error[] = []
  result.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  return { ...result, errors }
}

test("native root layout callback can subscribe to a box resize in the same frame", async () => {
  const { renderer, renderOnce, errors } = await setup()
  const box = new BoxRenderable(renderer, { width: 2, height: 1 })
  renderer.root.add(box)
  await renderOnce()

  const widths: number[] = []
  renderer.root.once("layout-changed", () => box.once("resize", () => widths.push(box.width)))
  box.width = 4
  await renderOnce()

  expect(errors).toEqual([])
  expect(widths).toEqual([4])
  expect(box.listenerCount("resize")).toBe(0)
})

test.each([false, true])(
  "native parent update determines child traversal order (new z values tie: %s)",
  async (tie) => {
    const { renderer, renderOnce, errors } = await setup()
    const calls: string[] = []
    const parent = new BoxRenderable(renderer, { width: 4, height: 2 })
    const options = { position: "absolute", width: 1, height: 1 } as const
    const first = new BoxRenderable(renderer, { ...options, zIndex: tie ? 1 : 0 })
    const second = new BoxRenderable(renderer, { ...options, zIndex: tie ? 0 : 1 })
    Object.assign(parent, { onUpdate: () => (first.zIndex = tie ? 0 : 2) })
    Object.assign(first, { onUpdate: () => calls.push("first") })
    Object.assign(second, { onUpdate: () => calls.push("second") })
    parent.add(first)
    parent.add(second)
    renderer.root.add(parent)
    await renderOnce()
    expect(errors).toEqual([])
    expect(calls).toEqual(tie ? ["first", "second"] : ["second", "first"])
    expect(renderer.hitTest(0, 0)).toBe((tie ? second : first).num)
  },
)

test("native root layout callback requestRender schedules a newly added text lifecycle pass", async () => {
  const clock = new ManualClock()
  const { renderer, captureCharFrame, waitFor, errors } = await setup(clock)
  const box = new BoxRenderable(renderer, { width: 2, height: 1 })
  renderer.root.add(box)
  clock.advance(1)
  await waitFor(() => {
    const state = renderer.getSchedulerState()
    return !state.isRendering && !state.hasScheduledRender
  })
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
  const frameId = renderer.frameId

  let initializations = 0
  renderer.root.once("layout-changed", () => {
    const text = new TextRenderable(renderer, {
      content: "",
      width: 6,
      height: 1,
      selectable: false,
      visible: false,
    })
    text.onLifecyclePass = () => {
      initializations++
      text.content = "ready"
      text.visible = true
      text.onLifecyclePass = null
    }
    renderer.root.add(text)
    renderer.requestRender()
  })
  box.width = 4
  clock.advance(1)
  await waitFor(() => renderer.frameId === frameId + 1 && !renderer.getSchedulerState().isRendering)

  expect(errors).toEqual([])
  expect(initializations).toBe(0)
  expect(renderer.frameId).toBe(frameId + 1)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(true)

  clock.advance(1)
  await waitFor(() => renderer.frameId === frameId + 2 && !renderer.getSchedulerState().isRendering)
  expect(errors).toEqual([])
  expect(initializations).toBe(1)
  expect(renderer.frameId).toBe(frameId + 2)
  expect(captureCharFrame()).toContain("ready")
})

test.each([false, true])(
  "native reparenting visits the accepted parent before its child (already queued: %s)",
  async (queued) => {
    const { renderer, renderOnce, errors } = await setup()
    // Legacy Node cannot marshal provisional geometry into the hit grid after this reparent.
    renderer.useMouse = queued
    const calls: string[] = []
    const source = new BoxRenderable(renderer, { width: 4, height: queued ? 1 : 2 })
    const destination = new BoxRenderable(renderer, { width: 4, height: 2 })
    const child = new BoxRenderable(renderer, { width: 1, height: 1 })
    if (!queued) source.add(child)
    renderer.root.add(source)
    if (queued) renderer.root.add(child)
    renderer.root.add(destination)
    Object.assign(source, {
      onUpdate() {
        calls.push("source")
        destination.add(child)
      },
    })
    Object.assign(destination, { onUpdate: () => calls.push("destination") })
    Object.assign(child, { onUpdate: () => calls.push("child") })
    await renderOnce()
    expect(errors).toEqual([])
    expect(calls).toEqual(["source", "destination", "child"])
    expect(child.parent).toBe(destination)
  },
)

test.each([false, true] as const)(
  "native child z changes retain this frame's sibling paint order with resize subscription=%s",
  async (registerResize) => {
    const { renderer, renderOnce, errors } = await setup()
    const parent = new BoxRenderable(renderer, { width: 4, height: 2 })
    const first = new BoxRenderable(renderer, { position: "absolute", width: 1, height: 1, zIndex: 0 })
    const second = new BoxRenderable(renderer, { position: "absolute", width: 1, height: 1, zIndex: 1 })
    Object.assign(first, {
      onUpdate() {
        first.zIndex = 2
        if (registerResize) first.onSizeChange ??= () => {}
      },
    })
    parent.add(first)
    parent.add(second)
    renderer.root.add(parent)
    await renderOnce()
    expect(errors).toEqual([])
    expect(renderer.hitTest(0, 0)).toBe(second.num)
    await renderOnce()
    expect(renderer.hitTest(0, 0)).toBe(first.num)
  },
)

test("native resize callbacks can extend the new-child prepass before updates", async () => {
  const { renderer, renderOnce, errors } = await setup()
  const calls: (string | number)[][] = []
  const parent = new BoxRenderable(renderer, { width: 8, height: 3 })
  const existing = new BoxRenderable(renderer, { width: 2, height: 1 })
  parent.add(existing)
  renderer.root.add(parent)
  await renderOnce()
  existing.onSizeChange = () => calls.push(["size", existing.width])
  Object.assign(existing, { onUpdate: () => calls.push(["update", existing.width]) })
  existing.width = 4
  const added = new BoxRenderable(renderer, {
    width: "50%",
    height: 1,
    onSizeChange() {
      calls.push(["added:size", this.width])
      parent.add(existing)
    },
  })
  Object.assign(added, { onUpdate: () => calls.push(["added:update", added.width]) })
  parent.insertBefore(added, existing)
  await renderOnce()
  expect(errors).toEqual([])
  expect(calls).toEqual([
    ["added:size", 4],
    ["size", 4],
    ["update", 4],
    ["added:update", 4],
  ])
})

test("native lifecycle suspension after setup does not fail or publish a frame", async () => {
  const { renderer, renderOnce, errors } = await setup()
  let suspension: Promise<void> | undefined
  try {
    await renderer.setupTerminal()
    let frames = 0
    renderer.on(CliRenderEvents.FRAME, () => frames++)
    const box = new BoxRenderable(renderer, { width: 2, height: 1 })
    box.onLifecyclePass = () => {
      renderer.requestRender()
      suspension = Promise.resolve(renderer.suspend())
    }
    renderer.root.add(box)
    await renderOnce()
    await suspension

    expect(suspension).toBeDefined()
    expect(errors).toEqual([])
    expect(frames).toBe(0)
    expect(renderer.getStats().nativeFrameCount).toBe(0)
    expect(renderer.getSchedulerState()).toEqual({
      isRunning: false,
      isRendering: false,
      hasScheduledRender: false,
    })
    await renderer.idle()
  } finally {
    await suspension
  }
}, 2000)
