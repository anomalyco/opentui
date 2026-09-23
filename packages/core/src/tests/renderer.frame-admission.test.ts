import { afterEach, expect, test } from "bun:test"
import { NativeSession } from "../NativeSession.js"
import { RGBA } from "../lib/RGBA.js"
import { CliRenderer, CliRenderEvents, createCliRenderer, type CliRendererConfig } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"

class HeldWriteStream extends TestWriteStream {
  held = true
  releaseWrite: (() => void) | undefined
  writes: Buffer[] = []

  constructor(columns = 80, rows = 24) {
    super(columns, rows)
    ;(this as unknown as { _writableState: { highWaterMark: number } })._writableState.highWaterMark = 1
  }

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: () => void): void {
    const finish = () => {
      this.writes.push(Buffer.from(chunk))
      callback()
    }
    if (this.held) this.releaseWrite = finish
    else finish()
  }

  releaseAll(): void {
    this.held = false
    const release = this.releaseWrite
    this.releaseWrite = undefined
    release?.()
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

async function waitForHold(stdout: HeldWriteStream, turns = 32): Promise<void> {
  for (let turn = 0; turn < turns && stdout.releaseWrite === undefined; turn++) await settle()
  expect(stdout.releaseWrite).toBeDefined()
}

function createAdmissionRenderer(width = 80, height = 24, config: CliRendererConfig = {}) {
  const clock = new ManualClock()
  const stdout = new HeldWriteStream(width, height)
  const driver = new NativeSession(stdout, {
    output: { chunkSize: 4096, spanCapacity: 8, maxBytes: 32_768n, controlCapacity: 4096 },
  })
  const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, width, height, {
    nativeSession: driver,
    clock,
    consoleMode: "disabled",
    exitSignals: [],
    remote: true,
    ...config,
  })
  cleanups.push(async () => {
    stdout.releaseAll()
    renderer.destroy()
    await renderer.closed.catch(() => {})
  })
  return { renderer, stdout, clock, driver }
}

test("frame admission bounds delayed output to one frame and coalesces callback work", async () => {
  const { renderer, stdout, clock, driver } = createAdmissionRenderer()
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
    buffer.drawText(state.repeat(8), 0, 0, fg, bg)
  })

  renderer.start()
  await waitForHold(stdout)
  expect(observed).toEqual(["A"])

  state = "B"
  for (let attempt = 0; attempt < 32; attempt++) {
    renderer.requestRender()
    clock.advance(100)
    await settle()
  }
  expect(observed).toEqual(["A"])

  state = "C"
  stdout.releaseAll()
  await driver.idle()
  for (let turn = 0; turn < 32 && observed.length < 2; turn++) {
    clock.advance(100)
    await settle()
  }
  renderer.pause()
  await renderer.idle()

  expect(observed).toEqual(["A", "C"])
  expect(frames).toBeGreaterThanOrEqual(2)
  const output = Buffer.concat(stdout.writes).toString()
  expect(output).toContain("A".repeat(8))
  expect(output).toContain("C".repeat(8))
  expect(output).not.toContain("B".repeat(8))
})

test("animation requests wait for output credit and remain cancellable", async () => {
  const { renderer, stdout, clock, driver } = createAdmissionRenderer()
  const observed: string[] = []
  renderer.addPostProcessFn((buffer) => buffer.drawText("held-animation", 0, 0, RGBA.fromInts(255, 255, 255)))
  const cancelled = renderer.requestAnimationFrame(() => observed.push("cancelled"))
  const resumed = renderer.requestAnimationFrame(() => observed.push("resumed"))
  renderer.cancelAnimationFrame(cancelled)
  renderer.cancelAnimationFrame(cancelled)
  clock.advance(100)
  await settle()
  expect(observed).toEqual([])

  stdout.releaseAll()
  await driver.idle()
  clock.advance(0)
  await settle()
  expect(renderer.liveRequestCount).toBe(0)
  expect(renderer.isRunning).toBe(false)
  await renderer.idle()
  expect(observed).toEqual(["resumed"])

  renderer.requestLive()
  renderer.cancelAnimationFrame(resumed)
  expect(renderer.liveRequestCount).toBe(1)
  renderer.dropLive()
})

for (const queuedWork of ["one-shot", "next-tick"] as const) {
  test(`stop cancels a queued ${queuedWork} without cancelling later requests`, async () => {
    const { renderer, stdout, clock } = createAdmissionRenderer()
    let callbacks = 0
    renderer.setFrameCallback(async () => {
      callbacks++
    })
    stdout.held = false
    if (queuedWork === "next-tick") clock.advance(100)
    renderer.requestRender()
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
    exitSignals: [],
    remote: true,
  })
  cleanups.push(async () => {
    renderer.destroy()
    await renderer.closed.catch(() => {})
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
