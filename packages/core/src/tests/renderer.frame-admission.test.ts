import { afterEach, expect, test } from "bun:test"
import type { NativeSpanFeed } from "../NativeSpanFeed.js"
import { RGBA } from "../lib/RGBA.js"
import {
  CliRenderer,
  CliRenderEvents,
  RendererControlState,
  createCliRenderer,
  type CliRendererConfig,
} from "../renderer.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"
import { resolveRenderLib } from "../zig.js"

class HeldWriteStream extends TestWriteStream {
  held = true
  releaseWrite: (() => void) | undefined
  writes: Buffer[] = []

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: () => void): void {
    const finish = () => {
      this.writes.push(Buffer.from(chunk))
      callback()
    }
    if (this.held) this.releaseWrite = finish
    else finish()
  }

  releaseOne(): void {
    const release = this.releaseWrite
    this.releaseWrite = undefined
    release?.()
  }

  releaseAll(): void {
    this.held = false
    this.releaseOne()
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function createAdmissionRenderer(width = 80, height = 24, config: CliRendererConfig = {}) {
  const clock = new ManualClock()
  const stdout = new HeldWriteStream(width, height)
  const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, width, height, {
    clock,
    consoleMode: "disabled",
    ...config,
  })
  const internals = renderer as unknown as { _feed: NativeSpanFeed; loop: () => Promise<void> }
  const feed = internals._feed
  cleanups.push(async () => {
    renderer.destroy()
    stdout.releaseAll()
    await feed.idle()
  })
  return { renderer, stdout, clock, feed, internals }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test("frame admission bounds delayed output to one frame and coalesces callback work", async () => {
  const { renderer, stdout, clock, feed } = createAdmissionRenderer(1024, 256)
  const lib = resolveRenderLib()
  const observed: string[] = []
  const deltas: number[] = []
  let state = "A"
  let frames = 0
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  renderer.setFrameCallback(async (delta) => {
    observed.push(state)
    deltas.push(delta)
  })
  const fg = RGBA.fromInts(255, 255, 255)
  const bg = RGBA.fromInts(0, 0, 0)
  renderer.addPostProcessFn((buffer) => {
    const row = state.repeat(renderer.width)
    for (let y = 0; y < renderer.height; y++) buffer.drawText(row, 0, y, fg, bg)
  })

  renderer.start()
  await settle()
  const frameBytes = stdout.writableLength
  const chunks = lib.streamGetStats(feed.streamPtr)!.chunks
  expect(frameBytes).toBeGreaterThan(256 * 1024)
  expect(lib.streamGetStats(feed.streamPtr)!.pendingSpans).toBe(0)
  expect(feed.isBackpressured()).toBe(true)

  state = "B"
  for (let attempt = 0; attempt < 32; attempt++) {
    renderer.requestRender()
    clock.advance(100)
    await settle()
    expect(stdout.writableLength).toBe(frameBytes)
  }

  expect(observed).toEqual(["A"])
  expect(frames).toBe(1)
  expect(lib.streamGetStats(feed.streamPtr)!.chunks).toBe(chunks)
  expect(renderer.frameId).toBe(1)

  stdout.releaseOne()
  await settle()
  clock.advance(100)
  await settle()
  expect(observed).toEqual(["A"])
  expect(feed.isBackpressured()).toBe(true)

  state = "C"
  stdout.releaseAll()
  await feed.idle()
  clock.advance(0)
  await settle()
  renderer.pause()
  await feed.idle()

  expect(observed).toEqual(["A", "C"])
  expect(deltas).toEqual([0, 3300])
  expect(frames).toBe(2)
  const output = Buffer.concat(stdout.writes).toString()
  expect(output).toContain("A".repeat(1024))
  expect(output).toContain("C".repeat(1024))
  expect(output).not.toContain("B".repeat(1024))
})

for (const control of ["pause", "stop", "suspend", "destroy"] as const) {
  test(`${control} cancels callback work waiting for delayed output`, async () => {
    const { renderer, stdout, clock, feed, internals } = createAdmissionRenderer()
    let callbacks = 0
    renderer.setFrameCallback(async () => {
      callbacks++
    })
    renderer.setTerminalTitle("held-control")
    await internals.loop()
    renderer[control]()
    let idleResolved = false
    void renderer.idle().then(() => {
      idleResolved = true
    })
    await settle()
    expect(idleResolved).toBe(true)
    expect(feed.isBackpressured()).toBe(true)
    stdout.releaseAll()
    await feed.idle()
    clock.advance(100)
    await settle()

    expect(callbacks).toBe(0)
    await renderer.idle()
    if (control !== "destroy") {
      if (control === "suspend") renderer.resume()
      else renderer.requestRender()
      await feed.idle()
      await settle()
      clock.advance(100)
      await settle()
      expect(callbacks).toBe(1)
    }
  })
}

test("destroy retains committed frame and shutdown bytes while admission is blocked", async () => {
  const { renderer, stdout, feed, internals } = createAdmissionRenderer()
  stdout.held = false
  await renderer.setupTerminal()
  await feed.idle()
  stdout.writes.length = 0
  stdout.held = true

  renderer.addPostProcessFn((buffer) => buffer.drawText("committed-before-destroy", 0, 0, RGBA.fromInts(255, 255, 255)))
  await internals.loop()
  let callbacks = 0
  renderer.setFrameCallback(async () => {
    callbacks++
  })
  renderer.intermediateRender()
  renderer.setTerminalTitle("control-during-backpressure")
  renderer.destroy()
  await renderer.idle()
  expect(callbacks).toBe(0)
  expect(feed.isBackpressured()).toBe(true)

  stdout.releaseAll()
  await feed.idle()
  const output = Buffer.concat(stdout.writes).toString()
  expect(output).toContain("committed-before-destroy")
  expect(output).toContain("control-during-backpressure")
  expect(output).toContain("\x1b[?25h")
  expect(output.indexOf("committed-before-destroy")).toBeLessThan(output.indexOf("control-during-backpressure"))
  expect(output.indexOf("control-during-backpressure")).toBeLessThan(output.lastIndexOf("\x1b[?25h"))
})

test("animation requests wait for output credit and remain cancellable", async () => {
  const { renderer, stdout, clock, feed } = createAdmissionRenderer()
  const observed: string[] = []
  renderer.setTerminalTitle("held-animation")
  const cancelled = requestAnimationFrame(() => observed.push("cancelled"))
  const resumed = requestAnimationFrame(() => observed.push("resumed"))
  cancelAnimationFrame(cancelled)
  cancelAnimationFrame(cancelled)
  clock.advance(100)
  await settle()
  expect(observed).toEqual([])

  stdout.releaseAll()
  await feed.idle()
  clock.advance(0)
  await settle()
  expect(renderer.liveRequestCount).toBe(0)
  expect(renderer.isRunning).toBe(false)
  await renderer.idle()
  expect(observed).toEqual(["resumed"])

  renderer.requestLive()
  cancelAnimationFrame(resumed)
  expect(renderer.liveRequestCount).toBe(1)
  renderer.dropLive()
})

for (const [setup, transition] of [
  [false, "destroy"],
  [true, "destroy"],
  [true, "suspend"],
  [true, "passthrough"],
] as const) {
  test(`${transition} preserves captured stdout at feed high water with setup=${setup}`, async () => {
    const { renderer, stdout, clock, feed, internals } = createAdmissionRenderer(80, 24, {
      screenMode: "split-footer",
    })
    if (setup) {
      stdout.held = false
      await renderer.setupTerminal()
      renderer.stdin.emit("data", Buffer.from("\x1b[12;1R"))
      clock.advance(200)
      await settle()
      await feed.idle()
      stdout.writes.length = 0
      stdout.held = true
    }

    for (let i = 0; i < 4096; i++) renderer.setTerminalTitle(`pinned-${i}`)
    expect(resolveRenderLib().streamGetStats(feed.streamPtr)!.pendingSpans).toBe(0)
    expect(feed.isBackpressured()).toBe(true)
    stdout.write("captured-before-transition\n")
    let callbacks = 0
    renderer.setFrameCallback(async () => {
      callbacks++
    })
    await internals.loop()
    expect(callbacks).toBe(0)

    if (transition === "passthrough") {
      renderer.externalOutputMode = "passthrough"
      stdout.write("after-transition\n")
    } else {
      renderer[transition]()
    }
    stdout.releaseAll()
    await feed.idle()
    const output = Buffer.concat(stdout.writes).toString()
    expect(output.includes("captured-before-transition")).toBe(true)
    expect(output.includes("[snapshot ")).toBe(false)
    expect(output.indexOf("pinned-4095")).toBeLessThan(output.indexOf("captured-before-transition"))
    if (transition === "passthrough") {
      expect(output.indexOf("captured-before-transition")).toBeLessThan(output.indexOf("after-transition"))
    } else {
      expect(output.indexOf("captured-before-transition")).toBeLessThan(output.lastIndexOf("\x1b[?25h"))
    }
  })
}

test("a cancelled admission continuation cannot clear a newer wait", async () => {
  const { renderer, stdout, clock, feed } = createAdmissionRenderer()
  const originalIdle = feed.idle.bind(feed)
  let releaseOldContinuation = () => {}
  const oldContinuation = new Promise<void>((resolve) => {
    releaseOldContinuation = resolve
  })
  let waits = 0
  // Delay only the scheduler continuation, never the feed's real byte ownership.
  feed.idle = () => (waits++ === 0 ? originalIdle().then(() => oldContinuation) : originalIdle())
  let callbacks = 0
  renderer.setFrameCallback(async () => {
    callbacks++
  })
  renderer.setTerminalTitle("old-write")
  renderer.start()
  renderer.pause()
  stdout.releaseAll()
  await originalIdle()

  stdout.held = true
  renderer.setTerminalTitle("new-write")
  renderer.requestRender()
  clock.advance(100)
  await settle()
  expect(waits).toBe(1)
  releaseOldContinuation()
  await settle()
  expect(waits).toBe(2)
  expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
  let idleResolved = false
  void renderer.idle().then(() => {
    idleResolved = true
  })
  await settle()
  expect(idleResolved).toBe(false)
  expect(callbacks).toBe(0)
  expect(feed.isBackpressured()).toBe(true)

  stdout.releaseAll()
  await originalIdle()
  clock.advance(100)
  await settle()
  expect(callbacks).toBe(1)
  expect(idleResolved).toBe(true)
  feed.idle = originalIdle
})

for (const control of ["pause", "stop"] as const) {
  test(`repeated ${control} bounds admission subscriptions and preserves new requests`, async () => {
    const { renderer, stdout, clock, feed } = createAdmissionRenderer()
    const feedInternals = feed as unknown as { idleResolvers: Array<() => void> }
    let callbacks = 0
    renderer.setFrameCallback(async () => {
      callbacks++
    })
    renderer.setTerminalTitle("held-before-pause")
    const heldBytes = stdout.writableLength
    let cancelledIdleCount = 0
    for (let cycle = 0; cycle < 100; cycle++) {
      renderer.start()
      renderer[control]()
      void renderer.idle().then(() => cancelledIdleCount++)
    }
    await settle()
    expect(cancelledIdleCount).toBe(100)
    expect(feedInternals.idleResolvers.length).toBe(1)
    expect(stdout.writableLength).toBe(heldBytes)

    renderer.requestRender()
    clock.advance(100)
    await settle()
    expect(callbacks).toBe(0)
    expect(feed.isBackpressured()).toBe(true)
    expect(feedInternals.idleResolvers.length).toBe(1)
    let idleResolved = false
    void renderer.idle().then(() => {
      idleResolved = true
    })
    await settle()
    expect(idleResolved).toBe(false)

    stdout.releaseAll()
    await feed.idle()
    clock.advance(100)
    await settle()
    expect(callbacks).toBe(1)
    expect(renderer.isRunning).toBe(false)
    expect(idleResolved).toBe(true)
    expect(Buffer.concat(stdout.writes).toString()).toContain("held-before-pause")
  })
}

for (const releaseBeforeDrop of [false, true]) {
  test(`dropping the last live owner preserves dirty content with credit ready=${releaseBeforeDrop}`, async () => {
    const { renderer, stdout, clock, feed } = createAdmissionRenderer()
    const text = new TextRenderable(renderer, { content: "OLD" })
    renderer.root.add(text)
    clock.advance(100)
    await settle()
    expect(feed.isBackpressured()).toBe(true)
    text.live = true
    text.content = "FINAL"
    if (releaseBeforeDrop) {
      stdout.releaseAll()
      await feed.idle()
    }
    text.live = false
    expect(renderer.controlState).toBe(RendererControlState.IDLE)
    stdout.releaseAll()
    await feed.idle()
    clock.advance(100)
    await settle()
    expect(Buffer.concat(stdout.writes).toString()).toContain("FINAL")
    await renderer.idle()
    expect(renderer.isRunning).toBe(false)
  })
}

test("cancelling the last RAF preserves independently captured stdout", async () => {
  const { renderer, stdout, clock, feed } = createAdmissionRenderer(80, 24, { screenMode: "split-footer" })
  renderer.setTerminalTitle("held-before-raf")
  let callbacks = 0
  const raf = requestAnimationFrame(() => callbacks++)
  stdout.write("captured-before-cancel\n")
  cancelAnimationFrame(raf)
  stdout.releaseAll()
  await feed.idle()
  clock.advance(100)
  await settle()
  expect(Buffer.concat(stdout.writes).toString()).toContain("captured-before-cancel")
  expect(callbacks).toBe(0)
  expect(renderer.isRunning).toBe(false)
  await renderer.idle()
})

test("suspending an empty split footer cannot rearm an admission wait", async () => {
  const { renderer, stdout, clock, feed } = createAdmissionRenderer(80, 24, { screenMode: "split-footer" })
  stdout.held = false
  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[12;1R"))
  clock.advance(200)
  await settle()
  await feed.idle()
  stdout.held = true
  for (let i = 0; i < 4096; i++) renderer.setTerminalTitle(`held-${i}`)
  let callbacks = 0
  renderer.setFrameCallback(async () => {
    callbacks++
  })
  renderer.start()
  renderer.suspend()
  let idleResolved = false
  void renderer.idle().then(() => {
    idleResolved = true
  })
  await settle()
  expect(idleResolved).toBe(true)
  expect(feed.isBackpressured()).toBe(true)
  stdout.releaseAll()
  await feed.idle()
  clock.advance(100)
  await settle()
  expect(callbacks).toBe(0)
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
})

for (const explicitStart of [false, true]) {
  test(`resume reconciles removed live owners without cancelling explicit start=${explicitStart}`, async () => {
    const { renderer, stdout, clock, feed } = createAdmissionRenderer()
    renderer.setTerminalTitle("held-before-suspend")
    if (explicitStart) renderer.start()
    let callbacks = 0
    const raf = requestAnimationFrame(() => callbacks++)
    renderer.suspend()
    cancelAnimationFrame(raf)
    stdout.releaseAll()
    await feed.idle()
    renderer.resume()
    await feed.idle()
    await settle()
    clock.advance(100)
    await settle()
    expect(callbacks).toBe(0)
    expect(renderer.liveRequestCount).toBe(0)
    expect(renderer.isRunning).toBe(explicitStart)
    if (!explicitStart) {
      expect(renderer.controlState).toBe(RendererControlState.IDLE)
      await renderer.idle()
    }
  })
}

test("resume preserves ownerless auto mode selected explicitly", async () => {
  const { renderer, stdout, clock, feed } = createAdmissionRenderer()
  renderer.setTerminalTitle("held-before-auto")
  renderer.start()
  renderer.auto()
  renderer.suspend()
  stdout.releaseAll()
  await feed.idle()
  renderer.resume()
  await feed.idle()
  clock.advance(100)
  await settle()
  expect(renderer.liveRequestCount).toBe(0)
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)
})

test("a new live owner while suspended restores automatic rendering", async () => {
  const { renderer, stdout, clock, feed } = createAdmissionRenderer()
  renderer.setTerminalTitle("held-before-new-owner")
  const raf = requestAnimationFrame(() => {})
  renderer.suspend()
  cancelAnimationFrame(raf)
  renderer.requestLive()
  stdout.releaseAll()
  await feed.idle()
  renderer.resume()
  await feed.idle()
  clock.advance(100)
  await settle()
  expect(renderer.liveRequestCount).toBe(1)
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)
})

for (const queuedWork of ["retry", "one-shot", "next-tick"] as const) {
  test(`stop cancels a queued ${queuedWork} without cancelling later requests`, async () => {
    const { renderer, stdout, clock, feed, internals } = createAdmissionRenderer()
    let callbacks = 0
    renderer.setFrameCallback(async () => {
      callbacks++
    })
    if (queuedWork === "retry") {
      renderer.setTerminalTitle("held-before-stop")
      await internals.loop()
      stdout.releaseAll()
      await feed.idle()
    } else {
      stdout.held = false
      if (queuedWork === "next-tick") clock.advance(100)
      renderer.requestRender()
    }
    expect(renderer.getSchedulerState().hasScheduledRender).toBe(true)
    renderer.stop()
    clock.advance(100)
    await settle()
    expect(callbacks).toBe(0)
    await renderer.idle()
    renderer.requestRender()
    clock.advance(100)
    await settle()
    expect(callbacks).toBe(1)
    expect(renderer.isRunning).toBe(false)
  })
}

test("same-turn stop and request renders once without asynchronous frame callbacks", async () => {
  const stdout = new HeldWriteStream()
  stdout.held = false
  const renderer = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: stdout as unknown as NodeJS.WriteStream,
    consoleMode: "disabled",
  })
  const feed = (renderer as unknown as { _feed: NativeSpanFeed })._feed
  cleanups.push(async () => {
    renderer.destroy()
    await feed.idle()
  })
  let frames = 0
  let postProcesses = 0
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  renderer.addPostProcessFn(() => postProcesses++)

  renderer.requestRender()
  renderer.stop()
  renderer.requestRender()
  await renderer.idle()

  expect({ frames, postProcesses }).toEqual({ frames: 1, postProcesses: 1 })
})

test("an older activation finalizer cannot clear a newer request", async () => {
  const { renderer, stdout, clock } = createAdmissionRenderer()
  stdout.held = false
  let frames = 0
  let postProcesses = 0
  renderer.addPostProcessFn(() => postProcesses++)
  renderer.on(CliRenderEvents.FRAME, () => {
    if (++frames !== 1) return
    queueMicrotask(() => {
      renderer.stop()
      renderer.requestRender()
    })
  })

  renderer.requestRender()
  clock.advance(100)
  await settle()
  clock.advance(100)
  await settle()

  expect({ frames, postProcesses }).toEqual({ frames: 2, postProcesses: 2 })
  await renderer.idle()
})
