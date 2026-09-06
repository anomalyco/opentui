import { expect, test } from "bun:test"
import { createTestRenderer } from "../testing/test-renderer.js"
import { RendererControlState } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { setImmediate } from "node:timers/promises"
import { once } from "node:events"

test("animation requests belong to their renderer without replacing host globals", async () => {
  const originalRequest = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  const first = await createTestRenderer({ width: 2, height: 1, clock: new ManualClock() })
  const second = await createTestRenderer({ width: 2, height: 1, clock: new ManualClock() })
  const calls: string[] = []
  try {
    first.renderer.pause()
    second.renderer.pause()
    const firstRequest = first.renderer.requestAnimationFrame(() => calls.push("first"))
    second.renderer.requestAnimationFrame(() => calls.push("second"))
    second.renderer.cancelAnimationFrame(firstRequest)
    await first.renderOnce()
    expect(calls).toEqual(["first"])
    await second.renderOnce()
    expect(calls).toEqual(["first", "second"])
    expect(globalThis.requestAnimationFrame).toBe(originalRequest)
    expect(globalThis.cancelAnimationFrame).toBe(originalCancel)
  } finally {
    first.renderer.destroy()
    second.renderer.destroy()
    await Promise.all([first.renderer.closed, second.renderer.closed])
  }
})

test("animation cancellation releases liveness and can cancel another callback in the same frame", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 2, height: 1 })
  const calls: string[] = []
  try {
    const cancelled = renderer.requestAnimationFrame(() => calls.push("cancelled"))
    renderer.cancelAnimationFrame(cancelled)
    renderer.cancelAnimationFrame(cancelled)
    await renderer.idle()
    expect(calls).toEqual([])
    expect(renderer.controlState).toBe(RendererControlState.IDLE)

    renderer.pause()
    renderer.requestAnimationFrame(() => renderer.cancelAnimationFrame(later))
    const later = renderer.requestAnimationFrame(() => calls.push("later"))
    await renderOnce()
    expect(calls).toEqual([])
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test.each(["pause", "stop", "destroy"] as const)(
  "%s cancels a queued one-shot frame and settles idle",
  async (method) => {
    const clock = new ManualClock()
    const { renderer } = await createTestRenderer({ width: 2, height: 1, clock })
    let calls = 0
    renderer.setFrameCallback(async () => {
      calls++
    })
    try {
      renderer.requestRender()
      const idle = renderer.idle()
      renderer[method]()
      await idle
      clock.advance(100)
      await setImmediate()
      expect(calls).toBe(0)
      expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  },
)

test.each([
  ["renderOnce", 0],
  ["renderOnce", 1000],
  ["intermediateRender", 0],
  ["intermediateRender", 1000],
] as const)("%s releases a queued one-shot at clock %ims", async (method, time) => {
  const clock = new ManualClock()
  const { renderer, renderOnce } = await createTestRenderer({ width: 2, height: 1, clock })
  try {
    clock.setTime(time)
    renderer.requestRender()
    if (method === "renderOnce") await renderOnce()
    else {
      const frame = once(renderer, "frame")
      renderer.intermediateRender()
      await frame
      const followup = once(renderer, "frame")
      clock.advance(20)
      await followup
      await setImmediate()
    }
    expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
    const frames = renderer.getStats().nativeFrameCount
    renderer.requestRender()
    clock.advance(20)
    await renderer.idle()
    expect(renderer.getStats().nativeFrameCount).toBe(frames + 1)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test("destroy cancels queued animation and frame continuations, including reentrant requests", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 2, height: 1 })
  const calls: string[] = []
  renderer.pause()
  renderer.requestAnimationFrame(() => {
    calls.push("destroy")
    renderer.destroy()
    renderer.requestAnimationFrame(() => calls.push("reentrant"))
  })
  renderer.requestAnimationFrame(() => calls.push("later"))
  renderer.setFrameCallback(async () => {
    calls.push("frame")
  })
  await renderOnce()
  await renderer.closed
  expect(calls).toEqual(["destroy"])
  expect(renderer.isRunning).toBe(false)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})

test("throwing animation callbacks release their live request without losing later callbacks", async () => {
  const { renderer } = await createTestRenderer({ width: 2, height: 1 })
  const calls: string[] = []
  renderer.on("render:error", () => calls.push("error"))
  try {
    renderer.requestAnimationFrame(() => {
      throw new Error("animation failure")
    })
    renderer.requestAnimationFrame(() => calls.push("later"))
    await renderer.idle()
    expect(calls).toEqual(["error", "later"])
    expect(renderer.controlState).toBe(RendererControlState.IDLE)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test.each(["completed", "pending"] as const)(
  "animation waits for the startup cursor reply with %s setup",
  async (phase) => {
    const clock = new ManualClock()
    const { renderer, renderOnce } = await createTestRenderer({
      width: 4,
      height: 2,
      clock,
      screenMode: "split-footer",
      externalOutputMode: "capture-stdout",
    })
    let calls = 0
    try {
      if (phase === "pending") renderer.requestAnimationFrame(() => calls++)
      const setup = renderer.setupTerminal()
      if (phase === "completed") {
        await setup
        renderer.requestAnimationFrame(() => calls++)
      }
      await renderOnce()
      await setup
      expect(calls).toBe(0)
      expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
      clock.advance(60)
      await setImmediate()
      expect(calls).toBe(0)
      renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
      await renderOnce()
      expect(calls).toBe(1)
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  },
)

test("a startup-blocked one-shot settles existing idle waiters before the seed timeout", async () => {
  const clock = new ManualClock()
  const { renderer } = await createTestRenderer({
    width: 4,
    height: 2,
    clock,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })
  let calls = 0
  let settled = false
  renderer.setFrameCallback(async () => {
    calls++
  })
  try {
    await renderer.setupTerminal()
    renderer.requestRender()
    const idle = renderer.idle().then(() => {
      settled = true
    })
    clock.advance(20)
    for (let turn = 0; turn < 16 && !settled; turn++) await setImmediate()
    expect(renderer.getSchedulerState()).toEqual({ isRunning: false, isRendering: false, hasScheduledRender: false })
    expect(calls).toBe(0)
    expect(clock.now()).toBe(20)
    expect(settled).toBe(true)
    await idle
    renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
    await renderer.idle()
    expect(calls).toBe(1)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
