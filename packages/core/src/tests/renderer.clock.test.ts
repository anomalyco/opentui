import { afterEach, beforeEach, expect, test } from "bun:test"
import { SystemClock } from "../lib/clock.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderEvents } from "../renderer.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"

let clock: ManualClock
let renderer: TestRenderer
let renderOnce: () => Promise<void>
let captureCharFrame: () => string

beforeEach(async () => {
  clock = new ManualClock()
  ;({ renderer, renderOnce, captureCharFrame } = await createTestRenderer({ clock, maxFps: 60 }))
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

test("SIGWINCH refreshes terminal dimensions after the resize debounce", () => {
  const stdout = (renderer as unknown as { stdout: { columns: number; rows: number; _refreshSize?: () => void } })
    .stdout
  const dimensions: Array<[number, number]> = []
  renderer.on(CliRenderEvents.RESIZE, (width, height) => dimensions.push([width, height]))
  stdout._refreshSize = () => {
    stdout.columns = 60
    stdout.rows = 18
  }

  // @ts-expect-error - invoke the private signal handler in a regression test
  renderer.sigwinchHandler()
  clock.advance(100)

  expect(renderer.width).toBe(60)
  expect(renderer.height).toBe(18)
  expect(dimensions).toEqual([[60, 18]])
})

test("SIGWINCH reads dimensions from a TTY stdin when stdout is piped", () => {
  const streams = renderer as unknown as {
    stdout: { columns?: number; rows?: number; isTTY?: boolean }
    stdin: { columns?: number; rows?: number; isTTY?: boolean; _refreshSize?: () => void }
  }
  streams.stdout.isTTY = false
  streams.stdout.columns = undefined
  streams.stdout.rows = undefined
  streams.stdin.isTTY = true
  streams.stdin._refreshSize = () => {
    streams.stdin.columns = 132
    streams.stdin.rows = 44
  }

  // @ts-expect-error - invoke the private signal handler in a regression test
  renderer.sigwinchHandler()
  clock.advance(100)

  expect(renderer.width).toBe(132)
  expect(renderer.height).toBe(44)
})

test("SIGWINCH ignores invalid dimensions after refreshing", () => {
  const stdout = (renderer as unknown as { stdout: { columns: number; rows: number; _refreshSize?: () => void } })
    .stdout
  const before = [renderer.width, renderer.height]
  stdout._refreshSize = () => {
    stdout.columns = 0
    stdout.rows = 0
  }
  // @ts-expect-error - invoke the private signal handler in a regression test
  renderer.sigwinchHandler()
  clock.advance(100)
  expect([renderer.width, renderer.height]).toEqual(before)
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

test("intermediateRender() replaces the pending live frame timer", async () => {
  renderer.requestLive()
  await Promise.resolve()

  // @ts-expect-error - inspect private manual clock timers in regression test
  expect(clock.timers.size).toBe(1)

  renderer.intermediateRender()

  // @ts-expect-error - inspect private manual clock timers in regression test
  expect(clock.timers.size).toBe(1)
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

test("threaded output backpressure delivers the final automatic animation frame before going idle", async () => {
  const text = new TextRenderable(renderer, { content: "before" })
  renderer.root.add(text)
  clock.advance(100)
  await Promise.resolve()
  expect(captureCharFrame()).toContain("before")
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)

  const internals = renderer as unknown as { renderNative: () => string }
  const originalRenderNative = internals.renderNative
  let attempts = 0
  // Reject only the final animation frame; accepted frames still use the native renderer.
  internals.renderNative = () => {
    if (attempts++ === 0) return "backpressured"
    return originalRenderNative.call(renderer)
  }

  try {
    requestAnimationFrame(() => {
      text.content = "after"
    })
    await Promise.resolve()
    expect(captureCharFrame()).toContain("before")

    clock.advance(20)
    await Promise.resolve()
    expect(captureCharFrame()).toContain("after")
    expect(attempts).toBe(2)
    expect(renderer.getSchedulerState()).toEqual({
      isRunning: false,
      isRendering: false,
      hasScheduledRender: false,
    })
  } finally {
    internals.renderNative = originalRenderNative
  }
})

test.each(["pause", "stop"] as const)(
  "threaded output backpressure does not restart a loop cancelled by %s()",
  async (method) => {
    const internals = renderer as unknown as {
      renderNative: () => "backpressured"
    }
    const originalRenderNative = internals.renderNative
    let frameCalls = 0
    internals.renderNative = () => "backpressured"
    renderer.setFrameCallback(async () => {
      frameCalls++
      renderer[method]()
    })

    try {
      renderer.start()
      await Promise.resolve()
      expect(frameCalls).toBe(1)

      clock.advance(20)
      await Promise.resolve()
      expect(frameCalls).toBe(1)
    } finally {
      internals.renderNative = originalRenderNative
    }
  },
)

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
