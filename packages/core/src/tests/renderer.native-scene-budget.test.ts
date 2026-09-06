import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderEvents } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test.each(["nativeScenePaintBudget", "nativeSceneWorkBudget"] as const)("%s rejects invalid limits", async (key) => {
  for (const limit of [0, -1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    await assert.rejects(createTestRenderer({ [key]: limit }), /positive u32/)
  }
})

test("native paint budget yields before post-processing and preserves prepared membership", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    nativeScenePaintBudget: 1,
    width: 8,
    height: 2,
    clock: new ManualClock(),
  })
  const calls: string[] = []
  const errors: unknown[] = []
  const children = Array.from("ABC", (content, left) => {
    const child = new TextRenderable(renderer, {
      selectable: false,
      content,
      position: "absolute",
      left,
      width: 1,
      height: 1,
    })
    renderer.root.add(child)
    return child
  })
  children[0].onLifecyclePass = () => calls.push("lifecycle")
  renderer.addPostProcessFn(() => calls.push("post"))
  renderer.on(CliRenderEvents.FRAME, () => calls.push("frame"))
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  try {
    const turn = setImmediate().then(() => {
      assert.deepEqual(calls, ["lifecycle"])
      assert.equal(renderer.getStats().nativeFrameCount, 0)
      calls.push("turn")
      children[2].content = "Z"
      renderer.root.add(
        new TextRenderable(renderer, { content: "D", position: "absolute", left: 3, width: 1, height: 1 }),
      )
    })
    await Promise.all([renderOnce(), turn])
    assert.deepEqual(errors, [])
    assert.deepEqual(calls, ["lifecycle", "turn", "post", "frame"])
    assert.equal(captureCharFrame().split("\n")[0], "ABZ     ")
    assert.equal(renderer.hitTest(2, 0), children[2].num)
    await renderOnce()
    assert.equal(captureCharFrame().split("\n")[0], "ABZD    ")
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test.each(["nativeScenePaintBudget", "nativeSceneWorkBudget"] as const)(
  "%s restarts resized work before publishing",
  async (key) => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      [key]: 1,
      width: 8,
      height: 2,
      clock: new ManualClock(),
    })
    const errors: unknown[] = []
    let frames = 0
    for (const content of ["A", "B"]) {
      renderer.root.add(new TextRenderable(renderer, { content, width: 1, height: 1 }))
    }
    const tail = new TextRenderable(renderer, {
      content: "Z",
      position: "absolute",
      right: 0,
      bottom: 0,
      width: 1,
      height: 1,
    })
    renderer.root.add(tail)
    renderer.on(CliRenderEvents.FRAME, () => frames++)
    renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
    try {
      const turn = setImmediate().then(() => {
        assert.equal(frames, 0)
        renderer.resize(12, 3)
      })
      await Promise.all([renderOnce(), turn])
      assert.deepEqual(errors, [])
      assert.equal(frames, 1)
      assert.equal(captureCharFrame().split("\n")[2], "           Z")
      assert.equal(renderer.hitTest(11, 2), tail.num)
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  },
)

test.each(["destroy", "suspend"] as const)(
  "parked native paint unwinds after %s without presenting",
  async (action) => {
    const { renderer, renderOnce } = await createTestRenderer({
      nativeScenePaintBudget: 1,
      width: 8,
      height: 2,
      clock: new ManualClock(),
    })
    const calls: string[] = []
    const errors: unknown[] = []
    if (action === "suspend") await renderer.setupTerminal()
    for (const id of ["a", "b"]) {
      renderer.root.add(new BoxRenderable(renderer, { id, width: 1, height: 1, renderAfter: () => calls.push(id) }))
    }
    renderer.addPostProcessFn(() => calls.push("post"))
    renderer.on(CliRenderEvents.FRAME, () => calls.push("frame"))
    renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
    try {
      const turn = setImmediate().then(() => (action === "destroy" ? renderer.destroy() : renderer.suspend()))
      await Promise.all([renderOnce(), turn])
      await renderer.idle()
      assert.deepEqual(calls, ["a"])
      assert.deepEqual(errors, [])
      assert.equal(renderer.getSchedulerState().isRendering, false)
      if (action === "suspend") {
        await renderer.resume()
        await renderOnce()
        assert.deepEqual(calls, ["a", "a", "b", "post", "frame"])
      }
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  },
)

test("failed cancellation during destroy settles parked paint and cleans detached nodes", async () => {
  const { renderer, renderOnce } = await createTestRenderer({
    nativeScenePaintBudget: 1,
    width: 8,
    height: 2,
    clock: new ManualClock(),
  })
  const calls: string[] = []
  for (const id of ["a", "b"]) {
    renderer.root.add(new BoxRenderable(renderer, { id, width: 1, height: 1, renderAfter: () => calls.push(id) }))
  }
  const detached = new BoxRenderable(renderer, { width: 1, height: 1 })
  const failure = new Error("host cancellation failed")
  const scheduler = renderer.nativeScene.driver.scheduler
  const schedule = scheduler.schedule.bind(scheduler)
  const scheduled = spyOn(scheduler, "schedule").mockImplementation((...args) => {
    const cancel = schedule(...args)
    return () => {
      cancel()
      throw failure
    }
  })
  const logged = spyOn(console, "error").mockImplementation(() => {})
  try {
    const rendering = renderOnce()
    assert.deepEqual(calls, ["a"])
    renderer.destroy()
    await rendering
    assert.deepEqual(calls, ["a"])
    assert.ok(logged.mock.calls.some((args) => args.includes(failure)))
    assert.equal(detached.isDestroyed, true)
    assert.equal(renderer.root.isDestroyed, true)
  } finally {
    scheduled.mockRestore()
    renderer.destroy()
    await renderer.closed
    logged.mockRestore()
  }
})
