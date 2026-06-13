import { afterEach, expect, spyOn, test } from "bun:test"
import { CliRenderEvents } from "../renderer.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "./manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "./test-renderer.js"

let setup: TestRendererSetup | null = null

async function drainImmediateWork(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => process.nextTick(resolve))
  await Promise.resolve()
}

afterEach(() => {
  setup?.renderer.destroy()
  setup = null
})

test("flush waits for scheduled render work without forcing an extra frame", async () => {
  setup = await createTestRenderer({ width: 10, height: 4, useThread: false, maxFps: Number.POSITIVE_INFINITY })

  const text = new TextRenderable(setup.renderer, {
    content: "abc",
    width: 3,
    height: 1,
  })
  setup.renderer.root.add(text)

  await setup.flush({ maxPasses: 1 })

  const renderedStats = setup.getNativeStats()
  expect(renderedStats.nativeFrameCount).toBe(1)
  expect(renderedStats.cellsUpdated).toBeGreaterThanOrEqual(3)

  await setup.flush()

  expect(setup.getNativeStats().nativeFrameCount).toBe(1)
})

test("waitForFrame observes text from a scheduled render", async () => {
  setup = await createTestRenderer({ width: 10, height: 4, useThread: false, maxFps: Number.POSITIVE_INFINITY })

  const text = new TextRenderable(setup.renderer, {
    content: "hello",
    width: 5,
    height: 1,
  })
  setup.renderer.root.add(text)

  const frame = await setup.waitForFrame((value) => value.includes("hello"), { maxPasses: 1 })

  expect(frame).toContain("hello")
  expect(setup.getNativeStats().nativeFrameCount).toBe(1)
})

test("waitFor observes predicate changes after scheduled work", async () => {
  setup = await createTestRenderer({ width: 10, height: 4, useThread: false, maxFps: Number.POSITIVE_INFINITY })

  const text = new TextRenderable(setup.renderer, {
    content: "ready",
    width: 5,
    height: 1,
  })
  setup.renderer.root.add(text)

  await setup.waitFor(() => setup!.getNativeStats().nativeFrameCount > 0, { maxPasses: 1 })

  expect(setup.getNativeStats().nativeFrameCount).toBe(1)
})

test("renderer does not build frame event stats when no frame listener is registered", async () => {
  setup = await createTestRenderer({ width: 10, height: 4, useThread: false })

  const getStats = spyOn(setup.renderer, "getStats")

  const text = new TextRenderable(setup.renderer, {
    content: "quiet",
    width: 5,
    height: 1,
  })
  setup.renderer.root.add(text)

  await setup.renderOnce()

  expect(getStats).not.toHaveBeenCalled()
  getStats.mockRestore()
})

test("renderer emits frame event without building stats when a frame listener is registered", async () => {
  setup = await createTestRenderer({ width: 10, height: 4, useThread: false })

  const getStats = spyOn(setup.renderer, "getStats")
  let frameEventCount = 0
  let frameEvent: unknown
  setup.renderer.on(CliRenderEvents.FRAME, (event) => {
    frameEventCount++
    frameEvent = event
  })

  const text = new TextRenderable(setup.renderer, {
    content: "event",
    width: 5,
    height: 1,
  })
  setup.renderer.root.add(text)

  await setup.renderOnce()

  expect(frameEventCount).toBe(1)
  expect(frameEvent).toEqual({ frameId: setup.renderer.frameId })
  expect(getStats).not.toHaveBeenCalled()
  getStats.mockRestore()
})

test("waitForFrame fails instead of rendering when no work is pending", async () => {
  setup = await createTestRenderer({ width: 10, height: 4, useThread: false, maxFps: Number.POSITIVE_INFINITY })

  await expect(setup.waitForFrame((frame) => frame.includes("missing"), { maxPasses: 2 })).rejects.toThrow(
    "hasScheduledRender: false",
  )

  expect(setup.getNativeStats().nativeFrameCount).toBe(0)
})

test("waitForVisualIdle observes a naturally emitted zero-cell live frame", async () => {
  const clock = new ManualClock()
  setup = await createTestRenderer({
    width: 10,
    height: 4,
    useThread: false,
    clock,
    maxFps: Number.POSITIVE_INFINITY,
    targetFps: Number.POSITIVE_INFINITY,
  })

  const text = new TextRenderable(setup.renderer, {
    content: "live",
    width: 4,
    height: 1,
  })
  setup.renderer.root.add(text)
  setup.renderer.start()

  await drainImmediateWork()
  expect(setup.getNativeStats().nativeFrameCount).toBe(1)

  const idle = setup.waitForVisualIdle({ maxFrames: 2 })
  await drainImmediateWork()
  clock.advance(1)
  await idle

  const stats = setup.getNativeStats()
  expect(stats.nativeFrameCount).toBe(2)
  expect(stats.cellsUpdated).toBe(0)

  setup.renderer.stop()
})

test("externalOutput records writeToScrollback commits without consuming native queue", async () => {
  setup = await createTestRenderer({
    width: 10,
    height: 6,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    useThread: false,
    maxFps: Number.POSITIVE_INFINITY,
  })

  setup.renderer.writeToScrollback((ctx) => {
    const root = new TextRenderable(ctx.renderContext, {
      content: "hello\nworld",
      width: 5,
      height: 2,
    })

    return {
      root,
      width: 5,
      height: 2,
      trailingNewline: false,
    }
  })

  const commits = setup.externalOutput.take()

  expect(commits).toHaveLength(1)
  expect(commits[0]).toMatchObject({
    text: "hello\nworld",
    rows: ["hello", "world"],
    width: 5,
    height: 2,
    rowColumns: 5,
    startOnNewLine: true,
    trailingNewline: false,
  })
  expect((setup.renderer as any).externalOutputQueue.size).toBe(1)

  await setup.renderOnce()

  expect((setup.renderer as any).externalOutputQueue.size).toBe(0)
  expect(setup.externalOutput.take()).toEqual([])
})

test("externalOutput records scrollback surface commits", async () => {
  setup = await createTestRenderer({
    width: 10,
    height: 6,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    useThread: false,
  })

  const surface = setup.renderer.createScrollbackSurface()
  const text = new TextRenderable(surface.renderContext, {
    content: "surface",
    width: 7,
    height: 1,
  })

  surface.root.add(text)
  surface.render()
  surface.commitRows(0, 1, { trailingNewline: false })

  const commits = setup.externalOutput.take()

  expect(commits).toHaveLength(1)
  expect(commits[0]).toMatchObject({
    text: "surface",
    rows: ["surface"],
    width: 10,
    height: 1,
    rowColumns: 10,
    startOnNewLine: true,
    trailingNewline: false,
  })
})

test("externalOutput records captured stdout in FIFO order", async () => {
  setup = await createTestRenderer({
    width: 10,
    height: 6,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    useThread: false,
  })

  setup.renderer.writeToScrollback((ctx) => {
    const root = new TextRenderable(ctx.renderContext, {
      content: "api",
      width: 3,
      height: 1,
    })

    return {
      root,
      width: 3,
      height: 1,
    }
  })
  ;(setup.renderer as any).stdout.write("out-1\n\nout-2")

  const commits = setup.externalOutput.take()

  expect(commits.map((commit) => commit.text)).toEqual(["api", "out-1", "", "out-2"])
  expect(commits.map((commit) => commit.startOnNewLine)).toEqual([true, false, false, false])
  expect(commits.map((commit) => commit.trailingNewline)).toEqual([true, true, true, false])

  ;(setup.renderer as any).stdout.write("again")
  expect(setup.externalOutput.takeText()).toBe("again")
  expect(setup.externalOutput.take()).toEqual([])
})
