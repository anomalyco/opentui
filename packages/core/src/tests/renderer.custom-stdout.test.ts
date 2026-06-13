import { test, expect, afterEach } from "bun:test"
import { Writable } from "stream"
import { createCliRenderer, CliRenderer, CliRenderEvents } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"

// Collecting Writable used as a mock stdout. Because it is !== process.stdout,
// createCliRenderer allocates a NativeSpanFeed and pipes bytes through it.
class CollectingWriteStream extends TestWriteStream {
  public readonly writes: Buffer[] = []
  /** When > 0, delay the write callback by this many ms to simulate a slow consumer. */
  public delayMs = 0

  override _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    // Defensive copy: `Buffer.from(Uint8Array)` can alias the source's
    // underlying ArrayBuffer. For feed-backed renderers the source is a view
    // into Zig-owned chunk memory that is freed when the feed closes. Copy
    // into a standalone Buffer so reads in assertions are safe after teardown.
    const buf = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk.slice())
    this.writes.push(buf)
    if (this.delayMs > 0) {
      setTimeout(callback, this.delayMs)
    } else {
      callback()
    }
  }

  getWrittenBytes(): Buffer {
    return Buffer.concat(this.writes)
  }

  clearWrites(): void {
    this.writes.length = 0
  }
}

type CollectingStdout = CollectingWriteStream & NodeJS.WriteStream

function createCollectingStdout(columns = 80, rows = 24): CollectingStdout {
  return new CollectingWriteStream(columns, rows) as CollectingStdout
}

function createPlainStdout(): NodeJS.WriteStream {
  return new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as NodeJS.WriteStream
}

function createRetryRenderer(feedBacked = false): { renderer: CliRenderer; clock: ManualClock } {
  const clock = new ManualClock()
  const renderer = new CliRenderer(
    createTestStdin(),
    feedBacked ? createCollectingStdout() : createPlainStdout(),
    80,
    24,
    {
      consoleMode: "disabled",
      bufferedOutput: feedBacked ? undefined : "memory",
      clock,
    },
  )
  ;(renderer as any).updateScheduled = false
  clock.runAll()
  destroyFns.push(() => renderer.destroy())
  return { renderer, clock }
}

function mockNativeRender(renderer: CliRenderer, render: (...args: any[]) => number): void {
  const rendererAny = renderer as any
  const originalRender = rendererAny.lib.render
  rendererAny.lib.render = render
  destroyFns.unshift(() => {
    rendererAny.lib.render = originalRender
  })
}

function deferFeedIdle(renderer: CliRenderer): { resolve: () => Promise<void>; calls: () => number } {
  const feed = (renderer as any)._feed
  const originalIdle = feed.idle.bind(feed)
  let resolve = () => {}
  let calls = 0
  feed.idle = () => {
    calls++
    return new Promise<void>((done) => {
      resolve = done
    })
  }
  destroyFns.unshift(() => {
    feed.idle = originalIdle
  })
  return {
    resolve: async () => {
      resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    calls: () => calls,
  }
}

function forceNativeSplitSkip(renderer: CliRenderer): () => void {
  const rendererAny = renderer as any
  const originalCommit = rendererAny.lib.commitSplitFooterSnapshot.bind(rendererAny.lib)

  rendererAny.lib.commitSplitFooterSnapshot = () => ({ renderOffset: rendererAny.renderOffset, status: 1 })

  return () => {
    rendererAny.lib.commitSplitFooterSnapshot = originalCommit
  }
}

let destroyFns: Array<() => void> = []

afterEach(() => {
  for (const fn of destroyFns) {
    try {
      fn()
    } catch (e) {
      console.error("cleanup error:", e)
    }
  }
  destroyFns = []
})

// ---- Byte-routing behavior ----

test("non-process stdout: rendered bytes flow to the custom Writable", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })
  destroyFns.push(() => renderer.destroy())

  // Let setup writes settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 30))

  const received = stdout.getWrittenBytes()
  expect(received.length).toBeGreaterThan(0)
  // ANSI escape sequences contain ESC (0x1b).
  expect(received.includes(0x1b)).toBe(true)
})

test("split-footer custom stdout: native feed bytes bypass stdout capture", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  // Construct directly so the test isolates the feed/write bridge without
  // setupTerminal() adding unrelated startup ANSI.
  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  stdout.clearWrites()

  renderer.setTerminalTitle("split-footer custom stdout")

  // Renderer-owned ANSI must go straight to the sink, not back through the
  // split-footer stdout-capture queue.
  expect((renderer as any).externalOutputQueue.size).toBe(0)

  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(stdout.getWrittenBytes().toString("binary")).toContain("\x1b]0;split-footer custom stdout\x07")
})

test("custom stdout resetTerminalBgColor routes through configured stdout", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  stdout.clearWrites()
  renderer.resetTerminalBgColor()

  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(stdout.getWrittenBytes().toString("binary")).toContain("\x1b]111\x07")
})

test("process.stdout: no feed is allocated (stdout-direct path)", async () => {
  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: process.stdout,
    bufferedOutput: "memory",
  })
  // Direct private-field inspection: no feed should be allocated when output
  // goes straight to process.stdout.
  expect((renderer as any)._feed).toBeNull()
  expect(() => renderer.destroy()).not.toThrow()
})

test("feed-backed renderer retries one skipped frame after feed idle", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferFeedIdle(renderer)
  let calls = 0
  let frames = 0
  mockNativeRender(renderer, () => (calls++ === 0 ? 1 : 0))
  renderer.on(CliRenderEvents.FRAME, () => frames++)

  await (renderer as any).loop()
  expect(calls).toBe(1)
  expect(frames).toBe(0)
  expect(idle.calls()).toBe(1)

  await idle.resolve()
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(true)
  clock.advance(17)

  expect(calls).toBe(2)
  expect(frames).toBe(1)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})

test("feed-backed renderer retries immediately when feed pressure outlasts the frame interval", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferFeedIdle(renderer)
  let calls = 0
  mockNativeRender(renderer, () => (calls++ === 0 ? 1 : 0))

  await (renderer as any).loop()
  clock.advance(100)
  await idle.resolve()
  clock.advance(0)

  expect(calls).toBe(2)
})

test("feed-backed renderer coalesces requests while waiting for feed idle", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferFeedIdle(renderer)
  const observed: number[] = []
  let state = 1
  let calls = 0
  renderer.setFrameCallback(async () => {
    observed.push(state)
  })
  mockNativeRender(renderer, () => (calls++ === 0 ? 1 : 0))

  await (renderer as any).loop()
  state = 2
  renderer.requestRender()
  renderer.requestRender()
  renderer.requestRender()
  expect(calls).toBe(1)

  await idle.resolve()
  clock.advance(17)
  await Promise.resolve()

  expect(calls).toBe(2)
  expect(observed).toEqual([1, 2])
})

test("starting a feed-backed renderer waits for a skipped frame's feed idle", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferFeedIdle(renderer)
  let calls = 0
  mockNativeRender(renderer, () => (calls++ === 0 ? 1 : 0))

  await (renderer as any).loop()
  renderer.start()

  expect(renderer.isRunning).toBe(true)
  clock.advance(100)
  expect(calls).toBe(1)

  await idle.resolve()
  clock.advance(0)

  expect(calls).toBe(2)
  expect(renderer.isRunning).toBe(true)
  renderer.pause()
})

test("feed-backed renderer waits for each repeated skip", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const firstIdle = deferFeedIdle(renderer)
  let calls = 0
  mockNativeRender(renderer, () => (calls++ < 2 ? 1 : 0))

  await (renderer as any).loop()
  await firstIdle.resolve()
  clock.advance(17)
  expect(calls).toBe(2)
  expect(firstIdle.calls()).toBe(2)

  await firstIdle.resolve()
  clock.advance(17)
  expect(calls).toBe(3)
})

test("native failure does not retry and recovers on a later render request", async () => {
  const { renderer, clock } = createRetryRenderer()
  const originalError = console.error
  const errors: unknown[][] = []
  console.error = (...args: unknown[]) => errors.push(args)
  destroyFns.unshift(() => {
    console.error = originalError
  })
  let calls = 0
  let frames = 0
  mockNativeRender(renderer, () => (calls++ === 0 ? 2 : 0))
  renderer.on(CliRenderEvents.FRAME, () => frames++)

  await (renderer as any).loop()
  clock.advance(1000)
  expect(calls).toBe(1)
  expect(frames).toBe(0)
  expect(errors).toHaveLength(1)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)

  renderer.intermediateRender()

  expect(calls).toBe(2)
  expect(frames).toBe(1)
})

test("running renderer recovers from native failure on a later render request", async () => {
  const { renderer, clock } = createRetryRenderer()
  const originalError = console.error
  console.error = () => {}
  destroyFns.unshift(() => {
    console.error = originalError
  })
  let calls = 0
  mockNativeRender(renderer, () => (calls++ === 0 ? 2 : 0))

  renderer.start()
  expect(calls).toBe(1)
  expect(renderer.isRunning).toBe(true)

  renderer.requestRender()
  clock.advance(17)

  expect(calls).toBe(2)
})

test("feed-backed native failure does not wait for feed idle or retry", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferFeedIdle(renderer)
  const originalError = console.error
  console.error = () => {}
  destroyFns.unshift(() => {
    console.error = originalError
  })
  let calls = 0
  mockNativeRender(renderer, () => {
    calls++
    return 2
  })

  await (renderer as any).loop()
  clock.advance(1000)

  expect(calls).toBe(1)
  expect(idle.calls()).toBe(0)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})

test("unexpected skip without a feed does not retry", async () => {
  const { renderer, clock } = createRetryRenderer()
  const originalError = console.error
  const errors: unknown[][] = []
  console.error = (...args: unknown[]) => errors.push(args)
  destroyFns.unshift(() => {
    console.error = originalError
  })
  let calls = 0
  mockNativeRender(renderer, () => {
    calls++
    return 1
  })

  await (renderer as any).loop()
  clock.advance(1000)

  expect(calls).toBe(1)
  expect(errors).toHaveLength(1)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})

for (const control of ["pause", "stop", "suspend", "destroy"] as const) {
  test(`${control} cancels a feed-idle retry`, async () => {
    const { renderer, clock } = createRetryRenderer(true)
    const idle = deferFeedIdle(renderer)
    let calls = 0
    mockNativeRender(renderer, () => {
      calls++
      return 1
    })

    await (renderer as any).loop()
    renderer[control]()
    await idle.resolve()
    clock.advance(17)

    expect(calls).toBe(1)
  })
}

for (const [control, state] of [
  ["pause", "paused"],
  ["stop", "stopped"],
] as const) {
  test(`one-shot render requested while ${state} retries after feed idle`, async () => {
    const { renderer, clock } = createRetryRenderer(true)
    const idle = deferFeedIdle(renderer)
    let calls = 0
    mockNativeRender(renderer, () => (calls++ === 0 ? 1 : 0))

    renderer[control]()
    renderer.requestRender()
    clock.advance(17)
    expect(calls).toBe(1)

    await idle.resolve()
    clock.advance(17)

    expect(calls).toBe(2)
  })
}

test("cancelling a skipped frame with an immediate rerender request resolves idle", async () => {
  const { renderer } = createRetryRenderer(true)
  const idle = deferFeedIdle(renderer)
  renderer.setFrameCallback(async () => {
    renderer.requestRender()
  })
  mockNativeRender(renderer, () => 1)

  await (renderer as any).loop()
  renderer.pause()
  const idlePromise = renderer.idle()
  let idleResolved = false
  void idlePromise.then(() => {
    idleResolved = true
  })

  await idle.resolve()
  await Promise.resolve()

  expect(idleResolved).toBe(true)
})

test("running renderer resumes after feed idle", async () => {
  const { renderer, clock } = createRetryRenderer(true)
  const idle = deferFeedIdle(renderer)
  let calls = 0
  mockNativeRender(renderer, () => (calls++ === 0 ? 1 : 0))

  renderer.start()
  expect(calls).toBe(1)
  await idle.resolve()
  clock.advance(17)

  expect(calls).toBe(2)
  expect(renderer.isRunning).toBe(true)
  renderer.pause()
})

test("omitting stdin/stdout uses process streams", async () => {
  const renderer = await createCliRenderer({
    bufferedOutput: "memory",
  })
  expect(renderer.stdin).toBe(process.stdin)
  destroyFns.push(() => renderer.destroy())
})

test("custom stdout defaults to remote env behavior", async () => {
  const previous = process.env.OPENTUI_FORCE_WCWIDTH
  process.env.OPENTUI_FORCE_WCWIDTH = "1"

  try {
    const defaultRemoteRenderer = await createCliRenderer({
      stdin: createTestStdin(),
      stdout: createCollectingStdout(80, 24),
    })
    destroyFns.push(() => defaultRemoteRenderer.destroy())

    expect(defaultRemoteRenderer.widthMethod).toBe("unicode")

    const localRenderer = await createCliRenderer({
      stdin: createTestStdin(),
      stdout: createCollectingStdout(80, 24),
      remote: false,
    })
    destroyFns.push(() => localRenderer.destroy())

    expect(localRenderer.widthMethod).toBe("wcwidth")
  } finally {
    if (previous === undefined) {
      delete process.env.OPENTUI_FORCE_WCWIDTH
    } else {
      process.env.OPENTUI_FORCE_WCWIDTH = previous
    }
  }
})

// ---- Shutdown bytes reach the remote Writable (F1 regression test) ----

test("destroy emits shutdown ANSI sequence through the custom Writable", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })

  // Let setup output settle, then clear so we can isolate shutdown output.
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  stdout.clearWrites()

  renderer.destroy()

  // Let final writes settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 50))

  const shutdownBytes = stdout.getWrittenBytes().toString("binary")

  // The shutdown sequence must include at least:
  //   - showCursor (ANSI.showCursor = ESC[?25h) so the user isn't left with a hidden cursor
  //   - either the reset-cursor-color sequence or the default-cursor-style sequence
  // This is the regression test for the teardown-order bug where the data
  // handler was detached before destroyRenderer emitted shutdown, causing
  // those bytes to be discarded.
  expect(shutdownBytes.length).toBeGreaterThan(0)
  expect(shutdownBytes).toContain("\x1b[?25h") // showCursor
})

// ---- Backpressure ----

test("slow Writable marks feed as backpressured until write callback settles", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)
  stdout.delayMs = 50

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })
  destroyFns.push(() => {
    stdout.delayMs = 0
    renderer.destroy()
  })

  const feed = (renderer as any)._feed
  expect(feed).not.toBeNull()

  renderer.setTerminalTitle("slow-write")
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(feed.isBackpressured()).toBe(true)

  stdout.delayMs = 0
  await feed.idle()

  expect(feed.isBackpressured()).toBe(false)
})

test("split-footer custom stdout can flush captured commits while feed writes are in flight", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)
  stdout.delayMs = 100

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => {
    stdout.delayMs = 0
    renderer.destroy()
  })

  const feed = (renderer as any)._feed
  expect(feed).not.toBeNull()

  renderer.setTerminalTitle("pin-feed")
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(feed.isBackpressured()).toBe(true)

  stdout.write("captured\n")
  await (renderer as any).loop()

  expect((renderer as any).externalOutputQueue.size).toBe(0)

  stdout.delayMs = 0
  await feed.idle()
  expect(stdout.getWrittenBytes().toString("binary")).toContain("captured")
})

test("split-footer custom stdout retains captured commits when native skips", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  const restoreNative = forceNativeSplitSkip(renderer)

  stdout.write("captured-while-native-skipped\n")
  const rendererAny = renderer as any
  expect(rendererAny.externalOutputQueue.size).toBeGreaterThan(0)

  try {
    await rendererAny.loop()
    expect(rendererAny.externalOutputQueue.size).toBeGreaterThan(0)
  } finally {
    restoreNative()
  }
})

test("split-footer coalesces render requests while waiting for feed idle", async () => {
  const clock = new ManualClock()
  const stdout = createCollectingStdout(80, 24)
  const renderer = new CliRenderer(createTestStdin(), stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
    clock,
  })
  ;(renderer as any).updateScheduled = false
  clock.runAll()
  destroyFns.push(() => renderer.destroy())

  const idle = deferFeedIdle(renderer)
  const rendererAny = renderer as any
  const originalCommit = rendererAny.lib.commitSplitFooterSnapshot
  let calls = 0
  rendererAny.lib.commitSplitFooterSnapshot = () => {
    calls++
    return { renderOffset: rendererAny.renderOffset, status: calls === 1 ? 1 : 0 }
  }
  destroyFns.unshift(() => {
    rendererAny.lib.commitSplitFooterSnapshot = originalCommit
  })

  stdout.write("first\n")
  clock.advance(17)
  await Promise.resolve()
  expect(calls).toBe(1)

  stdout.write("second\n")
  renderer.requestRender()
  clock.advance(100)
  await Promise.resolve()

  expect(calls).toBe(1)
  expect(idle.calls()).toBe(1)
  expect(rendererAny.externalOutputQueue.size).toBe(2)

  await idle.resolve()
  clock.advance(0)
  await Promise.resolve()

  expect(calls).toBe(3)
  expect(rendererAny.externalOutputQueue.size).toBe(0)
})

test("split-footer custom stdout retains captured commits when native fails and retries", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => renderer.destroy())

  const rendererAny = renderer as any
  const originalCommit = rendererAny.lib.commitSplitFooterSnapshot.bind(rendererAny.lib)
  let calls = 0
  rendererAny.lib.commitSplitFooterSnapshot = () => {
    calls++
    return { renderOffset: rendererAny.renderOffset, status: 2 }
  }

  stdout.write("captured-while-native-failed\n")
  expect(rendererAny.externalOutputQueue.size).toBeGreaterThan(0)

  try {
    await rendererAny.loop()
    expect(calls).toBeGreaterThan(0)
    expect(rendererAny.externalOutputQueue.size).toBeGreaterThan(0)
  } finally {
    rendererAny.lib.commitSplitFooterSnapshot = originalCommit
  }

  await rendererAny.loop()
  await (rendererAny._feed?.idle() ?? Promise.resolve())

  expect(rendererAny.externalOutputQueue.size).toBe(0)
  expect(stdout.getWrittenBytes().toString("binary")).toContain("captured-while-native-failed")
})

test("split-footer native failure without a feed does not schedule automatic retries", async () => {
  const clock = new ManualClock()
  const stdout = createPlainStdout()
  const renderer = new CliRenderer(createTestStdin(), stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
    bufferedOutput: "memory",
    clock,
  })
  ;(renderer as any).updateScheduled = false
  clock.runAll()
  destroyFns.push(() => renderer.destroy())

  const rendererAny = renderer as any
  const originalCommit = rendererAny.lib.commitSplitFooterSnapshot
  const originalError = console.error
  let calls = 0
  rendererAny.lib.commitSplitFooterSnapshot = () => {
    calls++
    return { renderOffset: rendererAny.renderOffset, status: 2 }
  }
  console.error = () => {}
  destroyFns.unshift(() => {
    rendererAny.lib.commitSplitFooterSnapshot = originalCommit
    console.error = originalError
  })

  stdout.write("captured-while-native-failed\n")
  rendererAny.updateScheduled = false
  await rendererAny.loop()
  expect(calls).toBe(1)

  clock.advance(1000)

  expect(calls).toBe(1)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
})

test("capture-to-passthrough flushes queued split-footer commits while feed is backpressured", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)
  stdout.delayMs = 30

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => {
    stdout.delayMs = 0
    renderer.destroy()
  })

  const feed = (renderer as any)._feed
  expect(feed).not.toBeNull()

  renderer.setTerminalTitle("pin-feed-before-mode-switch")
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(feed.isBackpressured()).toBe(true)

  stdout.write("captured-before-mode-switch\n")
  expect((renderer as any).externalOutputQueue.size).toBeGreaterThan(0)

  renderer.externalOutputMode = "passthrough"
  stdout.delayMs = 0

  await new Promise<void>((resolve) => setTimeout(resolve, 80))

  expect(stdout.getWrittenBytes().toString("binary")).toContain("captured-before-mode-switch")
  expect((renderer as any).externalOutputQueue.size).toBe(0)
})

test("destroy resolves idle waiters when a feed-idle render was scheduled", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)
  stdout.delayMs = 30

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => {
    stdout.delayMs = 0
    renderer.destroy()
  })

  const feed = (renderer as any)._feed
  expect(feed).not.toBeNull()

  renderer.setTerminalTitle("pin-feed-before-idle")
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(feed.isBackpressured()).toBe(true)

  const restoreNative = forceNativeSplitSkip(renderer)
  stdout.write("captured-before-idle-destroy\n")
  try {
    await (renderer as any).loop()
    expect((renderer as any).feedIdleRenderScheduled).toBe(true)
  } finally {
    restoreNative()
  }

  let idleResolved = false
  const idlePromise = renderer.idle().then(() => {
    idleResolved = true
  })

  renderer.destroy()
  stdout.delayMs = 0
  await Promise.resolve()

  expect(idleResolved).toBe(true)
  await idlePromise

  await new Promise<void>((resolve) => setTimeout(resolve, 80))
  expect(stdout.getWrittenBytes().toString("binary")).toContain("captured-before-idle-destroy")
  expect((renderer as any).externalOutputQueue.size).toBe(0)
})

test("suspend resolves idle waiters when a feed-idle render was scheduled", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)
  stdout.delayMs = 30

  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    screenMode: "split-footer",
    consoleMode: "disabled",
  })
  destroyFns.push(() => {
    stdout.delayMs = 0
    renderer.destroy()
  })

  const feed = (renderer as any)._feed
  expect(feed).not.toBeNull()

  renderer.setTerminalTitle("pin-feed-before-suspend")
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(feed.isBackpressured()).toBe(true)

  const restoreNative = forceNativeSplitSkip(renderer)
  stdout.write("captured-before-suspend\n")
  try {
    await (renderer as any).loop()
    expect((renderer as any).feedIdleRenderScheduled).toBe(true)
  } finally {
    restoreNative()
  }

  let idleResolved = false
  const idlePromise = renderer.idle().then(() => {
    idleResolved = true
  })

  renderer.suspend()
  stdout.delayMs = 0
  await feed.idle()
  await Promise.resolve()

  expect(idleResolved).toBe(true)
  await idlePromise
})

// ---- Dimension fallback ----

test("dimensions: stdout.columns wins over config.width", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(120, 30)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    width: 40,
    height: 10,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(120)
  expect(renderer.height).toBe(30)
})

test("dimensions: config.width used when stdout lacks columns", async () => {
  const stdin = createTestStdin()
  const stdout = createPlainStdout()

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    width: 100,
    height: 50,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(100)
  expect(renderer.height).toBe(50)
})

test("dimensions: config.width used when stdout reports zero columns", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(0, 0)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    width: 100,
    height: 50,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(100)
  expect(renderer.height).toBe(50)
})

test("dimensions: defaults 80x24 when no stdout columns and no config", async () => {
  const stdin = createTestStdin()
  const stdout = createPlainStdout()

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(80)
  expect(renderer.height).toBe(24)
})

test("dimensions: defaults 80x24 when stdout reports zero columns and no config", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(0, 0)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(80)
  expect(renderer.height).toBe(24)
})

// ---- Duck-typed stream capabilities ----

test("stdin without setRawMode: start/suspend/resume/destroy all succeed", async () => {
  const stdin = createTestStdin() // Readable has no setRawMode
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })

  expect(() => renderer.suspend()).not.toThrow()
  expect(() => renderer.resume()).not.toThrow()
  expect(() => renderer.destroy()).not.toThrow()
})

// ---- Public resize API ----

test("resize(w, h) updates dimensions and fires RESIZE event", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => renderer.destroy())

  let eventFired = false
  let eventW = 0
  let eventH = 0
  renderer.on(CliRenderEvents.RESIZE, (w: number, h: number) => {
    eventFired = true
    eventW = w
    eventH = h
  })

  renderer.resize(120, 40)

  expect(eventFired).toBe(true)
  expect(eventW).toBe(120)
  expect(eventH).toBe(40)
  expect(renderer.width).toBe(120)
  expect(renderer.height).toBe(40)
})

test("resize() after destroy is a no-op", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })

  renderer.destroy()
  expect(() => renderer.resize(100, 50)).not.toThrow()
})

// ---- Full feed teardown path ----

test("full feed teardown after successful setup does not throw", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })
  // Exercises the full drain → destroyRenderer → drain → detach → close path.
  expect(() => renderer.destroy()).not.toThrow()
})

// ---- Destroy resilience ----

test("constructor cleans up listeners when input setup fails", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)
  const calls: boolean[] = []
  const processEvents = ["warning", "uncaughtException", "unhandledRejection", "beforeExit"] as const
  const listenerCounts = new Map(processEvents.map((event) => [event, process.listenerCount(event)]))

  stdin.setRawMode = (enabled) => {
    calls.push(enabled)
    if (enabled) {
      throw new Error("raw mode setup failed")
    }
    return stdin
  }

  await expect(
    createCliRenderer({
      stdin,
      stdout,
      exitSignals: [],
    }),
  ).rejects.toThrow("raw mode setup failed")

  expect(calls).toEqual([true, false])
  expect(stdin.listenerCount("data")).toBe(0)
  for (const event of processEvents) {
    expect(process.listenerCount(event)).toBe(listenerCounts.get(event) ?? 0)
  }
})

test("destroy tolerates drainAll throwing", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })

  // Monkey-patch drainAll on the private feed handle to throw on the first
  // two calls (one before destroyRenderer, one after), then pass through.
  const feed = (renderer as any)._feed
  expect(feed).not.toBeNull()
  const originalDrainAll = feed.drainAll.bind(feed)
  let calls = 0
  feed.drainAll = () => {
    calls++
    if (calls <= 2) throw new Error("simulated drain failure")
    return originalDrainAll()
  }

  // destroy must swallow the drainAll exceptions and still complete the
  // rest of the teardown path.
  expect(() => renderer.destroy()).not.toThrow()
  expect(calls).toBeGreaterThanOrEqual(2)
})

// ---- onError handler wire-up ----

test("feed.onError handler registration and detach work", async () => {
  const stdin = createTestStdin()
  const stdout = createCollectingStdout(80, 24)

  const renderer = await createCliRenderer({
    stdin,
    stdout,
  })
  destroyFns.push(() => renderer.destroy())

  // The renderer-internal handler is already registered. We register a
  // secondary one and verify the detach function it returns.
  //
  // Note: this test only verifies the wire-up (subscribe + detach). There
  // is currently no supported API to synthetically trigger an EventId.Error
  // event on the feed, so end-to-end invocation is a coverage gap tracked
  // for a future NativeSpanFeed test-harness hook.
  const feed = (renderer as any)._feed
  expect(feed).not.toBeNull()
  const detach = feed.onError(() => {})
  expect(typeof detach).toBe("function")
  expect(() => detach()).not.toThrow()
})
