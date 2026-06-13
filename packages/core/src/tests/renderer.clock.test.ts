import { afterEach, beforeEach, expect, test } from "bun:test"
import { SystemClock } from "../lib/clock.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"

let clock: ManualClock
let renderer: TestRenderer
let renderOnce: () => Promise<void>

beforeEach(async () => {
  clock = new ManualClock()
  ;({ renderer, renderOnce } = await createTestRenderer({ clock, maxFps: 60 }))
})

afterEach(() => {
  renderer.destroy()
})

test("renderer init does not pre-schedule frames when size is unchanged", async () => {
  let frameCalls = 0
  renderer.setFrameCallback(async () => {
    frameCalls++
  })

  // @ts-expect-error - inspect private renderer scheduling state in regression test
  expect(renderer.updateScheduled).toBe(false)
  // @ts-expect-error - inspect private manual clock timers in regression test
  expect(clock.timers.size).toBe(0)

  clock.advance(100)
  await Promise.resolve()

  expect(frameCalls).toBe(0)
})

test("requestRender() does not stall after a backward clock jump", async () => {
  clock.setTime(10_000)
  // @ts-expect-error - inspect private renderer timing state in regression test
  renderer.lastTime = 10_000
  clock.setTime(8_000)

  let renderCalled = false
  // @ts-expect-error - intercept private render method in regression test
  renderer.renderNative = () => {
    renderCalled = true
  }

  renderer.requestRender()
  clock.advance(20)
  await Promise.resolve()

  expect(renderCalled).toBe(true)
})

test("requestRender() uses SystemClock by default when no clock is injected", async () => {
  const originalNow = globalThis.performance.now
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const defaultClock = new ManualClock()
  let nowValue = 10_000
  let defaultRenderer: TestRenderer | null = null

  globalThis.performance.now = () => nowValue
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    return defaultClock.setTimeout(() => handler(...args), timeout ?? 0)
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((handle?: ReturnType<typeof globalThis.setTimeout>) => {
    if (handle !== undefined) {
      defaultClock.clearTimeout(handle)
    }
  }) as typeof globalThis.clearTimeout

  try {
    ;({ renderer: defaultRenderer } = await createTestRenderer({ maxFps: 60 }))

    // @ts-expect-error - inspect private renderer clock in regression test
    expect(defaultRenderer.clock).toBeInstanceOf(SystemClock)

    // @ts-expect-error - inspect private renderer timing state in regression test
    defaultRenderer.lastTime = 10_000
    nowValue = 8_000

    let renderCalled = false
    // @ts-expect-error - intercept private render method in regression test
    defaultRenderer.renderNative = () => {
      renderCalled = true
    }

    defaultRenderer.requestRender()
    defaultClock.advance(20)
    await Promise.resolve()

    expect(renderCalled).toBe(true)
  } finally {
    defaultRenderer?.destroy()
    globalThis.performance.now = originalNow
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})

test("loop() clamps negative deltaTime after a backward clock jump", async () => {
  const deltas: number[] = []

  renderer.setFrameCallback(async (deltaTime) => {
    deltas.push(deltaTime)
  })

  clock.setTime(10_000)
  // @ts-expect-error - inspect private renderer timing state in regression test
  renderer.lastTime = 10_000
  // @ts-expect-error - inspect private renderer timing state in regression test
  renderer.lastFpsTime = 10_000
  clock.setTime(8_000)

  await renderOnce()

  expect(deltas).toEqual([0])
})

test("targetFps setter updates frame timing", () => {
  renderer.targetFps = 120

  expect(renderer.targetFps).toBe(120)
  // @ts-expect-error - inspect private renderer timing state in regression test
  expect(renderer.targetFrameTime).toBe(1000 / 120)
})

test("maxFps setter updates requestRender throttle timing", async () => {
  let renderCalled = false

  // @ts-expect-error - intercept private render method in regression test
  renderer.renderNative = () => {
    renderCalled = true
  }

  renderer.maxFps = 10

  expect(renderer.maxFps).toBe(10)
  // @ts-expect-error - inspect private renderer timing state in regression test
  expect(renderer.minTargetFrameTime).toBe(1000 / 10)

  renderer.requestRender()

  clock.advance(99)
  await Promise.resolve()
  expect(renderCalled).toBe(false)

  clock.advance(1)
  await Promise.resolve()
  expect(renderCalled).toBe(true)
})

test("threaded output backpressure retries a skipped native frame", async () => {
  const internals = renderer as unknown as {
    lib: { render: (...args: unknown[]) => number }
    _useThread: boolean
    _usesProcessStdout: boolean
  }
  const originalRender = internals.lib.render
  const originalUseThread = internals._useThread
  const originalUsesProcessStdout = internals._usesProcessStdout
  let calls = 0
  internals.lib.render = () => (calls++ === 0 ? 1 : 0)
  internals._useThread = true
  internals._usesProcessStdout = true
  try {
    renderer.requestRender()
    clock.advance(20)
    await Promise.resolve()
    expect(calls).toBe(1)

    clock.advance(20)
    await Promise.resolve()
    expect(calls).toBe(2)
  } finally {
    internals.lib.render = originalRender
    internals._useThread = originalUseThread
    internals._usesProcessStdout = originalUsesProcessStdout
  }
})

test("fps counts rendered frames and excludes dropped frames", async () => {
  const internals = renderer as unknown as {
    renderNative: () => "rendered" | "retryable-skip" | "backpressured" | "blocked" | "failed"
    lastTime: number
    lastFpsTime: number
    frameCount: number
    currentFps: number
    renderStats: { fps: number; frameCount: number }
  }
  const originalRenderNative = internals.renderNative
  const statuses: Array<"rendered" | "retryable-skip" | "backpressured" | "blocked" | "failed"> = [
    "rendered",
    "retryable-skip",
    "rendered",
    "backpressured",
    "blocked",
    "failed",
    "retryable-skip",
    "rendered",
    "rendered",
  ]
  internals.renderNative = () => statuses.shift() ?? "retryable-skip"
  internals.lastTime = 0
  internals.lastFpsTime = 0
  internals.frameCount = 0
  internals.currentFps = 0
  internals.renderStats.fps = 0
  try {
    for (const time of [100, 200, 300, 1000]) {
      clock.setTime(time)
      await renderOnce()
      renderer.pause()
    }
    expect(renderer.getStats().fps).toBe(2)

    for (const time of [1100, 1500, 2000]) {
      clock.setTime(time)
      await renderOnce()
      renderer.pause()
    }
    expect(renderer.getStats().fps).toBe(0)

    for (const time of [2100, 3000]) {
      clock.setTime(time)
      await renderOnce()
      renderer.pause()
    }
    expect(renderer.getStats().fps).toBe(2)
    expect(internals.renderStats.frameCount).toBe(9)
  } finally {
    internals.renderNative = originalRenderNative
  }
})

test("starting the render loop resets stale fps immediately", () => {
  const internals = renderer as unknown as {
    currentFps: number
    renderStats: { fps: number }
  }
  internals.currentFps = 42
  internals.renderStats.fps = 42
  try {
    renderer.start()
    expect(renderer.getStats().fps).toBe(0)
  } finally {
    renderer.pause()
  }
})

test("start() does not double-schedule frames when a render was already queued", async () => {
  let renderCalls = 0

  // @ts-expect-error - intercept private render method in regression test
  renderer.renderNative = () => {
    renderCalls++
  }

  renderer.requestRender()
  renderer.start()

  clock.advance(1000)
  await Promise.resolve()

  // @ts-expect-error - inspect private manual clock timers in regression test
  expect(clock.timers.size).toBe(1)
  expect(renderCalls).toBeGreaterThanOrEqual(25)
  expect(renderCalls).toBeLessThanOrEqual(40)
})
