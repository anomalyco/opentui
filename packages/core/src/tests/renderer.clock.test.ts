import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { once } from "node:events"
import { setImmediate } from "node:timers/promises"
import { CliRenderEvents } from "../renderer.js"
import { SystemClock } from "../lib/clock.js"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { NativeSessionRenderStatus } from "../zig.js"

let clock: ManualClock
let renderer: TestRenderer
let renderOnce: () => Promise<void>
let captureCharFrame: () => string

async function serviceReadyFrames(): Promise<void> {
  for (let turn = 0; turn < 64; turn++) {
    await setImmediate()
    const state = renderer as unknown as {
      rendering: boolean
      cancelReadyFrame: unknown
      outputIdleRenderScheduled: boolean
    }
    if (!state.rendering && !state.cancelReadyFrame && !state.outputIdleRenderScheduled) return
  }
  throw new Error("Renderer did not finish ready work within 64 host turns")
}

beforeEach(async () => {
  clock = new ManualClock()
  ;({ renderer, renderOnce, captureCharFrame } = await createTestRenderer({ clock, maxFps: 60 }))
})

afterEach(async () => {
  renderer.destroy()
  await renderer.closed
})

test("renderer init does not pre-schedule frames when size is unchanged", async () => {
  let frameCalls = 0
  renderer.setFrameCallback(async () => {
    frameCalls++
  })

  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
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

  renderer.requestRender()
  clock.advance(20)
  await renderer.idle()

  expect(renderer.getStats().nativeFrameCount).toBe(1)
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

    expect(defaultRenderer.clock).toBeInstanceOf(SystemClock)

    // @ts-expect-error - inspect private renderer timing state in regression test
    defaultRenderer.lastTime = 10_000
    nowValue = 8_000

    defaultRenderer.requestRender()
    defaultClock.advance(20)
    await defaultRenderer.idle()

    expect(defaultRenderer.getStats().nativeFrameCount).toBe(1)
  } finally {
    defaultRenderer?.destroy()
    globalThis.performance.now = originalNow
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    await defaultRenderer?.closed
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
  renderer.maxFps = 10

  expect(renderer.maxFps).toBe(10)
  // @ts-expect-error - inspect private renderer timing state in regression test
  expect(renderer.minTargetFrameTime).toBe(1000 / 10)

  renderer.requestRender()

  clock.advance(99)
  await Promise.resolve()
  expect(renderer.getStats().nativeFrameCount).toBe(0)

  clock.advance(1)
  await renderer.idle()
  expect(renderer.getStats().nativeFrameCount).toBe(1)
})

test("intermediateRender() replaces the pending live frame timer", async () => {
  const liveFrame = once(renderer, CliRenderEvents.FRAME)
  renderer.requestLive()
  await liveFrame

  // @ts-expect-error - inspect private manual clock timers in regression test
  expect(clock.timers.size).toBe(1)

  const intermediateFrame = once(renderer, CliRenderEvents.FRAME)
  renderer.intermediateRender()
  await intermediateFrame

  // @ts-expect-error - inspect private manual clock timers in regression test
  expect(clock.timers.size).toBe(1)
})

test("Session output backpressure retries a skipped native frame", async () => {
  const driver = renderer.nativeScene.driver
  const originalRender = driver.render.bind(driver)
  let calls = 0
  const render = spyOn(driver, "render").mockImplementation((...args) =>
    calls++ === 0 ? NativeSessionRenderStatus.Skipped : originalRender(...args),
  )
  try {
    renderer.requestRender()
    clock.advance(20)
    await serviceReadyFrames()
    expect(render).toHaveBeenCalledTimes(1)
    expect(renderer.getStats().nativeFrameCount).toBe(0)

    clock.advance(20)
    await renderer.idle()
    expect(render).toHaveBeenCalledTimes(2)
    expect(renderer.getStats().nativeFrameCount).toBe(1)
  } finally {
    render.mockRestore()
  }
})

test("threaded output backpressure delivers the final automatic animation frame before going idle", async () => {
  const text = new TextRenderable(renderer, { content: "before" })
  renderer.root.add(text)
  await renderOnce()
  expect(captureCharFrame()).toContain("before")
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)

  const driver = renderer.nativeScene.driver
  const originalRender = driver.render.bind(driver)
  let attempts = 0
  const render = spyOn(driver, "render").mockImplementation((...args) =>
    attempts++ === 0 ? NativeSessionRenderStatus.Skipped : originalRender(...args),
  )
  try {
    renderer.requestAnimationFrame(() => {
      text.content = "after"
    })
    clock.advance(20)
    await serviceReadyFrames()
    expect(captureCharFrame()).toContain("before")
    clock.advance(20)
    await renderer.idle()
    expect(captureCharFrame()).toContain("after")
    expect(renderer.getSchedulerState()).toEqual({
      isRunning: false,
      isRendering: false,
      hasScheduledRender: false,
    })
  } finally {
    render.mockRestore()
  }
})

test.each(["pause", "stop"] as const)(
  "Session output backpressure does not restart a loop cancelled by %s() during its callback",
  async (method) => {
    let frameCalls = 0
    const render = spyOn(renderer.nativeScene.driver, "render").mockImplementation(
      () => NativeSessionRenderStatus.Skipped,
    )
    renderer.setFrameCallback(async () => {
      frameCalls++
      renderer[method]()
    })

    try {
      renderer.start()
      await serviceReadyFrames()
      expect(frameCalls).toBe(1)

      clock.advance(20)
      await serviceReadyFrames()
      expect(frameCalls).toBe(1)
    } finally {
      render.mockRestore()
    }
  },
)

test.each(["pause", "stop"] as const)(
  "a fresh render requested after %s() inside a callback survives output pressure",
  async (method) => {
    const driver = renderer.nativeScene.driver
    const original = driver.render.bind(driver)
    let calls = 0
    let callbacks = 0
    const render = spyOn(driver, "render").mockImplementation((...args) =>
      calls++ === 0 ? NativeSessionRenderStatus.Skipped : original(...args),
    )
    renderer.setFrameCallback(async () => {
      if (++callbacks !== 1) return
      renderer[method]()
      renderer.requestRender()
    })
    try {
      renderer.start()
      await serviceReadyFrames()
      clock.advance(20)
      await renderer.idle()
      expect(callbacks).toBe(2)
      expect(renderer.getStats().nativeFrameCount).toBe(1)
      expect(renderer.isRunning).toBe(false)
    } finally {
      render.mockRestore()
    }
  },
)

test.each(["pause", "stop"] as const)(
  "repeating %s() inside a one-shot callback cancels its output retry",
  async (method) => {
    let callbacks = 0
    const render = spyOn(renderer.nativeScene.driver, "render").mockImplementation(
      () => NativeSessionRenderStatus.Skipped,
    )
    renderer[method]()
    renderer.setFrameCallback(async () => {
      callbacks++
      renderer.requestRender()
      renderer[method]()
    })
    try {
      renderer.requestRender()
      clock.advance(20)
      await serviceReadyFrames()
      expect(callbacks).toBe(1)
      clock.advance(20)
      await serviceReadyFrames()
      expect(callbacks).toBe(1)
      expect(renderer.getStats().nativeFrameCount).toBe(0)
    } finally {
      render.mockRestore()
    }
  },
)

test("fps counts rendered frames and excludes dropped frames", async () => {
  const driver = renderer.nativeScene.driver
  const originalRender = driver.render.bind(driver)
  const statuses = [
    NativeSessionRenderStatus.Presented,
    NativeSessionRenderStatus.Skipped,
    NativeSessionRenderStatus.Presented,
    NativeSessionRenderStatus.Skipped,
    NativeSessionRenderStatus.Skipped,
    NativeSessionRenderStatus.Failed,
    NativeSessionRenderStatus.Skipped,
    NativeSessionRenderStatus.Presented,
    NativeSessionRenderStatus.Presented,
  ]
  const render = spyOn(driver, "render").mockImplementation((...args) => {
    const status = statuses.shift()!
    return status === NativeSessionRenderStatus.Presented ? originalRender(...args) : status
  })
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const time of [100, 200, 300, 1000]) {
      clock.setTime(time)
      await renderOnce()
      await driver.idle()
      renderer.pause()
    }
    expect(renderer.getStats().fps).toBe(2)

    for (const time of [1100, 1500, 2000]) {
      clock.setTime(time)
      await renderOnce()
      await driver.idle()
      renderer.pause()
    }
    expect(renderer.getStats().fps).toBe(0)

    for (const time of [2100, 3000]) {
      clock.setTime(time)
      await renderOnce()
      await driver.idle()
      renderer.pause()
    }
    expect(renderer.getStats().fps).toBe(2)
    expect(renderer.getStats().frameCount).toBe(9)
    expect(renderer.getStats().nativeFrameCount).toBe(4)
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    render.mockRestore()
    errors.mockRestore()
  }
})

test("fps excludes frames blocked on the startup cursor reply", async () => {
  renderer.destroy()
  await renderer.closed
  ;({ renderer, renderOnce } = await createTestRenderer({
    clock,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  }))
  clock.setTime(1000)
  await renderer.setupTerminal()
  await renderOnce()
  expect(renderer.getStats().fps).toBe(0)
  expect(renderer.getStats().nativeFrameCount).toBe(0)

  renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  await renderOnce()
  expect(renderer.getStats().nativeFrameCount).toBe(1)
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
  const started = once(renderer, CliRenderEvents.FRAME)
  renderer.requestRender()
  renderer.start()
  await started

  for (let elapsed = 0; elapsed < 1000; elapsed += 10) {
    clock.advance(10)
    await serviceReadyFrames()
  }

  // @ts-expect-error - inspect private manual clock timers in regression test
  expect(clock.timers.size).toBe(1)
  expect(renderer.getStats().nativeFrameCount).toBeGreaterThanOrEqual(25)
  expect(renderer.getStats().nativeFrameCount).toBeLessThanOrEqual(40)
})
