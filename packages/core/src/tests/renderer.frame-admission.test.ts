import { afterEach, expect, test } from "bun:test"
import { NativeSession } from "../NativeSession.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderer, CliRenderEvents, createCliRenderer, type CliRendererConfig } from "../renderer.js"
import { settle, settleUntil } from "../testing/harness.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, RecordingWriteStream } from "../testing/test-streams.js"
import { NativeSceneFrame } from "../zig.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function createAdmissionRenderer(width = 80, height = 24, config: CliRendererConfig = {}) {
  const clock = new ManualClock()
  const stdout = new RecordingWriteStream(width, height, { highWaterMark: 1 })
  stdout.hold()
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
    stdout.release()
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
  await settleUntil(() => stdout.pendingWrite)
  expect(observed).toEqual(["A"])

  state = "B"
  for (let attempt = 0; attempt < 32; attempt++) {
    renderer.requestRender()
    clock.advance(100)
    await settle()
  }
  expect(observed).toEqual(["A"])

  state = "C"
  stdout.release()
  await driver.idle()
  for (let turn = 0; turn < 32 && observed.length < 2; turn++) {
    clock.advance(100)
    await settle()
  }
  renderer.pause()
  await renderer.idle()

  expect(observed).toEqual(["A", "C"])
  expect(frames).toBeGreaterThanOrEqual(2)
  const output = stdout.text()
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

  stdout.release()
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
    stdout.release()
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
  const stdout = new RecordingWriteStream()
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

const busyResizes = {
  "a pending frame presentation": async () => {
    const target = createAdmissionRenderer(80, 24)
    target.renderer.requestRender()
    target.clock.advance(100)
    await settleUntil(() => target.stdout.pendingWrite)
    return { ...target, size: [100, 30] }
  },
  "a parked split-footer paint": async () => {
    const target = createAdmissionRenderer(30, 12, {
      screenMode: "split-footer",
      externalOutputMode: "passthrough",
      footerHeight: 6,
      nativeSceneWorkBudget: 1,
    })
    target.stdout.release()
    await target.renderer.setupTerminal()
    const column = new BoxRenderable(target.renderer, { flexDirection: "column" })
    target.renderer.root.add(column)
    for (let line = 0; line < 4; line++) column.add(new TextRenderable(target.renderer, { content: `line ${line}` }))
    const lib = target.driver.renderLib
    const step = lib.sceneFrameStep
    const parked = Promise.withResolvers<void>()
    lib.sceneFrameStep = (...args) => {
      const result = step.apply(lib, args)
      if (result.kind === NativeSceneFrame.Yield) parked.resolve()
      return result
    }
    cleanups.unshift(async () => {
      lib.sceneFrameStep = step
    })
    target.renderer.requestRender()
    target.clock.advance(100)
    await parked.promise
    expect(target.renderer.getSchedulerState().isRendering).toBe(true)
    return { ...target, size: [20, 12] }
  },
}

for (const [state, enter] of Object.entries(busyResizes)) {
  test(`resize() during ${state} applies once the Session is ready`, async () => {
    const { renderer, stdout, clock, size } = await enter()
    const resizes: number[][] = []
    const errors: unknown[] = []
    renderer.on(CliRenderEvents.RESIZE, (width: number, height: number) => resizes.push([width, height]))
    renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))

    expect(() => renderer.resize(size[0], size[1])).not.toThrow()
    stdout.release()
    for (let turn = 0; turn < 8; turn++) {
      clock.advance(100)
      await settle()
    }
    await renderer.idle()

    expect({ size: [renderer.terminalWidth, renderer.terminalHeight], resizes, errors }).toEqual({
      size,
      resizes: [[renderer.width, renderer.height]],
      errors: [],
    })
  })
}
