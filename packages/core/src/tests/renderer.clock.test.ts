import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { once } from "node:events"
import { CliRenderEvents } from "../renderer.js"
import { SystemClock } from "../lib/clock.js"
import { TextRenderable } from "../renderables/Text.js"
import { forceRenderStatus, serviceReadyFrames } from "../testing/harness.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { NativeSessionRenderStatus } from "../zig.js"

let clock: ManualClock
let renderer: TestRenderer
let renderOnce: () => Promise<void>
let captureCharFrame: () => string

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
  expect(clock.pendingTimerCount).toBe(0)

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

  expect(clock.pendingTimerCount).toBe(1)

  const intermediateFrame = once(renderer, CliRenderEvents.FRAME)
  renderer.intermediateRender()
  await intermediateFrame

  expect(clock.pendingTimerCount).toBe(1)
})

test("a render that a hook requests when the next frame is already due waits for no timer", async () => {
  renderer.maxFps = Number.POSITIVE_INFINITY
  let requests = 1
  class RequestingText extends TextRenderable {
    protected override onUpdate(): void {
      if (requests-- > 0) this.requestRender()
    }
  }
  renderer.root.add(new RequestingText(renderer, { content: "hook" }))

  renderer.requestRender()
  await serviceReadyFrames(renderer)

  expect(requests).toBe(-1)
  expect(renderer.getStats().nativeFrameCount).toBe(2)
  expect(clock.pendingTimerCount).toBe(0)
})

// Each test owns its renderer, so forced statuses need no restore.
function skipFirstFrames(count: number): () => number {
  let calls = 0
  forceRenderStatus(renderer, () =>
    calls++ < count ? NativeSessionRenderStatus.Skipped : NativeSessionRenderStatus.Presented,
  )
  return () => calls
}

test("Session output backpressure retries a skipped native frame", async () => {
  const commits = skipFirstFrames(1)
  renderer.requestRender()
  clock.advance(20)
  await serviceReadyFrames(renderer)
  expect({ commits: commits(), frames: renderer.getStats().nativeFrameCount }).toEqual({ commits: 1, frames: 0 })

  clock.advance(20)
  await renderer.idle()
  expect({ commits: commits(), frames: renderer.getStats().nativeFrameCount }).toEqual({ commits: 2, frames: 1 })
})

test("threaded output backpressure delivers the final automatic animation frame before going idle", async () => {
  const text = new TextRenderable(renderer, { content: "before" })
  renderer.root.add(text)
  await renderOnce()
  expect(captureCharFrame()).toContain("before")
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)

  skipFirstFrames(1)
  renderer.requestAnimationFrame(() => {
    text.content = "after"
  })
  clock.advance(20)
  await serviceReadyFrames(renderer)
  expect(captureCharFrame()).toContain("before")
  clock.advance(20)
  await renderer.idle()
  expect(captureCharFrame()).toContain("after")
  expect(renderer.getSchedulerState()).toEqual({
    isRunning: false,
    isRendering: false,
    hasScheduledRender: false,
  })
})

test.each(["pause", "stop"] as const)(
  "Session output backpressure does not restart a loop cancelled by %s() during its callback",
  async (method) => {
    let frameCalls = 0
    skipFirstFrames(Infinity)
    renderer.setFrameCallback(async () => {
      frameCalls++
      renderer[method]()
    })

    renderer.start()
    await serviceReadyFrames(renderer)
    expect(frameCalls).toBe(1)

    clock.advance(20)
    await serviceReadyFrames(renderer)
    expect(frameCalls).toBe(1)
  },
)

test.each(["pause", "stop"] as const)(
  "a fresh render requested after %s() inside a callback survives output pressure",
  async (method) => {
    let callbacks = 0
    skipFirstFrames(1)
    renderer.setFrameCallback(async () => {
      if (++callbacks !== 1) return
      renderer[method]()
      renderer.requestRender()
    })
    renderer.start()
    await serviceReadyFrames(renderer)
    clock.advance(20)
    await renderer.idle()
    expect(callbacks).toBe(2)
    expect(renderer.getStats().nativeFrameCount).toBe(1)
    expect(renderer.isRunning).toBe(false)
  },
)

test.each(["pause", "stop"] as const)(
  "repeating %s() inside a one-shot callback cancels its output retry",
  async (method) => {
    let callbacks = 0
    skipFirstFrames(Infinity)
    renderer[method]()
    renderer.setFrameCallback(async () => {
      callbacks++
      renderer.requestRender()
      renderer[method]()
    })
    renderer.requestRender()
    clock.advance(20)
    await serviceReadyFrames(renderer)
    expect(callbacks).toBe(1)
    clock.advance(20)
    await serviceReadyFrames(renderer)
    expect(callbacks).toBe(1)
    expect(renderer.getStats().nativeFrameCount).toBe(0)
  },
)

test("fps counts rendered frames and excludes dropped frames", async () => {
  const driver = renderer.nativeScene.driver
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
  forceRenderStatus(renderer, () => statuses.shift()!)
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const [times, fps] of [
      [[100, 200, 300, 1000], 2],
      [[1100, 1500, 2000], 0],
      [[2100, 3000], 2],
    ] as const) {
      for (const time of times) {
        clock.setTime(time)
        await renderOnce()
        await driver.idle()
        renderer.pause()
      }
      expect(renderer.getStats().fps).toBe(fps)
    }
    expect(renderer.getStats().frameCount).toBe(9)
    expect(renderer.getStats().nativeFrameCount).toBe(4)
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
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
    await serviceReadyFrames(renderer)
  }

  expect(clock.pendingTimerCount).toBe(1)
  expect(renderer.getStats().nativeFrameCount).toBeGreaterThanOrEqual(25)
  expect(renderer.getStats().nativeFrameCount).toBeLessThanOrEqual(40)
})

test("memory snapshots and the debug overlay use the renderer clock and stop on destroy", async () => {
  const snapshots: unknown[] = []
  const toggles: boolean[] = []
  renderer.on(CliRenderEvents.MEMORY_SNAPSHOT, (snapshot) => snapshots.push(snapshot))
  renderer.on(CliRenderEvents.DEBUG_OVERLAY_TOGGLE, (enabled: boolean) => toggles.push(enabled))
  const timers = clock.pendingTimerCount

  renderer.toggleDebugOverlay()
  expect(clock.pendingTimerCount).toBe(timers + 2)
  clock.advance(3000)
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toMatchObject({ heapUsed: expect.any(Number), arrayBuffers: expect.any(Number) })
  renderer.toggleDebugOverlay()
  expect(toggles).toEqual([true, false])
  await renderer.idle()

  renderer.setMemorySnapshotInterval(50)
  renderer.start()
  clock.advance(50)
  expect(snapshots).toHaveLength(2)
  renderer.destroy()
  await renderer.closed
  expect(clock.pendingTimerCount).toBe(0)
})
