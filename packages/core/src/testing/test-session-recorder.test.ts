import { Buffer } from "node:buffer"
import { EventEmitter } from "node:events"

import { describe, expect, test } from "bun:test"

import type { TestRendererSetup } from "./test-renderer.js"
import {
  exportReplayTest,
  replayTestSession,
  TEST_SESSION_RECORDING_VERSION,
  TestSessionRecorder,
  type RecordedTestSession,
} from "./test-session-recorder.js"

interface FakeSetup extends TestRendererSetup {
  emittedInput: Buffer[]
  resizes: { width: number; height: number }[]
  flushCount: number
  frame: string
}

function createFakeSetup(width: number = 20, height: number = 6): FakeSetup {
  const stdin = new EventEmitter() as NodeJS.ReadStream
  const renderer = new EventEmitter() as TestRendererSetup["renderer"]
  const emittedInput: Buffer[] = []
  const resizes: { width: number; height: number }[] = []
  let currentWidth = width
  let currentHeight = height
  let flushCount = 0
  let frame = ""

  stdin.on("data", (data: Buffer | string | Uint8Array) => {
    const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data)
    emittedInput.push(bytes)
    frame += bytes.toString("utf8")
  })

  Object.defineProperties(renderer, {
    stdin: { value: stdin, configurable: true },
    width: { get: () => currentWidth, configurable: true },
    height: { get: () => currentHeight, configurable: true },
  })

  const setup = {
    renderer,
    mockInput: undefined,
    mockMouse: undefined,
    renderOnce: async () => {},
    flush: async () => {
      flushCount++
    },
    waitFor: async () => {},
    waitForFrame: async () => frame,
    waitForVisualIdle: async () => {
      flushCount++
    },
    externalOutput: {
      take: () => [],
      takeText: () => "",
      clear: () => {},
    },
    getNativeStats: () => ({}) as ReturnType<TestRendererSetup["getNativeStats"]>,
    captureCharFrame: () => frame,
    captureSpans: () => ({ cols: currentWidth, rows: currentHeight, cursor: [0, 0], lines: [] }),
    resize: (nextWidth: number, nextHeight: number) => {
      currentWidth = nextWidth
      currentHeight = nextHeight
      resizes.push({ width: nextWidth, height: nextHeight })
    },
    get emittedInput() {
      return emittedInput
    },
    get resizes() {
      return resizes
    },
    get flushCount() {
      return flushCount
    },
    get frame() {
      return frame
    },
    set frame(value: string) {
      frame = value
    },
  }

  return setup as unknown as FakeSetup
}

describe("TestSessionRecorder", () => {
  test("records stdin emitted through the renderer stdin stream", () => {
    const setup = createFakeSetup()
    const recorder = new TestSessionRecorder(setup, { recordFrames: false, now: () => 10 })

    recorder.start()
    setup.renderer.stdin.emit("data", Buffer.from("a"))
    setup.renderer.stdin.emit("data", Buffer.from("\r"))
    recorder.stop()

    const session = recorder.session
    expect(session.version).toBe(TEST_SESSION_RECORDING_VERSION)
    expect(session.steps.map((step) => step.type)).toEqual(["stdin", "stdin"])
    expect(session.steps[0]).toMatchObject({ type: "stdin", dataText: "a" })
    expect(session.steps[1]).toMatchObject({ type: "stdin", dataText: "\r" })
    expect(session.finalFrame).toBe("a\r")
  })

  test("records resize calls made through the test renderer setup", () => {
    const setup = createFakeSetup(10, 4)
    const recorder = new TestSessionRecorder(setup, { recordFrames: false })

    recorder.start()
    setup.resize(40, 12)
    recorder.stop()

    expect(setup.resizes).toEqual([{ width: 40, height: 12 }])
    expect(recorder.session.steps).toContainEqual(expect.objectContaining({ type: "resize", width: 40, height: 12 }))
  })

  test("records explicit waits and checkpoints", async () => {
    const setup = createFakeSetup()
    const recorder = new TestSessionRecorder(setup, { recordFrames: false })

    recorder.start()
    setup.renderer.stdin.emit("data", Buffer.from("hello"))
    await recorder.flush()
    const checkpoint = recorder.checkpoint("typed hello")
    recorder.stop()

    expect(checkpoint.frame).toBe("hello")
    expect(recorder.session.steps.map((step) => step.type)).toEqual(["stdin", "wait", "checkpoint"])
    expect(setup.flushCount).toBe(1)
  })

  test("supports custom clocks that start at zero", () => {
    const setup = createFakeSetup()
    let time = 0
    const recorder = new TestSessionRecorder(setup, { recordFrames: false, now: () => time })

    recorder.start()
    time = 25
    setup.renderer.stdin.emit("data", Buffer.from("x"))
    recorder.stop()

    expect(recorder.session.steps[0]).toMatchObject({ type: "stdin", timestamp: 25 })
    expect(recorder.session.duration).toBe(25)
  })

  test("preserves an empty final frame captured at stop", () => {
    const setup = createFakeSetup()
    const recorder = new TestSessionRecorder(setup, { recordFrames: false })

    recorder.start()
    recorder.stop()
    setup.frame = "changed after stop"

    expect(recorder.session.finalFrame).toBe("")
  })

  test("restores patched stdin and resize functions after stop", () => {
    const setup = createFakeSetup()
    const originalEmit = setup.renderer.stdin.emit
    const originalResize = setup.resize
    const recorder = new TestSessionRecorder(setup, { recordFrames: false })

    recorder.start()
    expect(setup.renderer.stdin.emit).not.toBe(originalEmit)
    expect(setup.resize).not.toBe(originalResize)

    recorder.stop()
    expect(setup.renderer.stdin.emit).toBe(originalEmit)
    expect(setup.resize).toBe(originalResize)
  })

  test("replays stdin and resize steps", async () => {
    const source = createFakeSetup(20, 6)
    const recorder = new TestSessionRecorder(source, { recordFrames: false })

    recorder.start()
    source.renderer.stdin.emit("data", Buffer.from("abc"))
    source.resize(30, 8)
    recorder.stop()

    const target = createFakeSetup(20, 6)
    const result = await replayTestSession(recorder.session, target, { flushAtEnd: false })

    expect(Buffer.concat(target.emittedInput).toString("utf8")).toBe("abc")
    expect(target.resizes).toEqual([{ width: 30, height: 8 }])
    expect(result.finalFrame).toBe("abc")
    expect(result.replayedSteps).toBe(2)
  })

  test("can assert recorded checkpoints during replay", async () => {
    const setup = createFakeSetup()
    const session: RecordedTestSession = {
      version: TEST_SESSION_RECORDING_VERSION,
      width: 20,
      height: 6,
      duration: 0,
      steps: [
        { type: "stdin", timestamp: 0, dataBase64: Buffer.from("ok").toString("base64"), dataText: "ok" },
        { type: "checkpoint", timestamp: 0, name: "ok frame", frameNumber: 0, frame: "ok" },
      ],
      finalFrame: "ok",
    }

    const result = await replayTestSession(session, setup, { assertCheckpoints: true, flushAtEnd: false })
    expect(result.checkedCheckpoints).toBe(1)
  })

  test("exports a replayable Bun test file", () => {
    const session: RecordedTestSession = {
      version: TEST_SESSION_RECORDING_VERSION,
      width: 20,
      height: 6,
      duration: 0,
      steps: [],
      metadata: { name: "replay smoke" },
      finalFrame: "",
    }

    const source = exportReplayTest(session, { setupCode: "  await mountApp(setup.renderer)\n" })

    expect(source).toContain('import { test, expect } from "bun:test"')
    expect(source).toContain("createTestRenderer")
    expect(source).toContain("await mountApp(setup.renderer)")
    expect(source).toContain("expect(setup.captureCharFrame()).toBe(session.finalFrame)")
  })
})
