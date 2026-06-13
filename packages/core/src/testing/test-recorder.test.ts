import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer } from "./test-renderer.js"
import { TestRecorder } from "./test-recorder.js"
import { TextRenderable } from "../renderables/Text.js"

async function waitForScheduledRender(): Promise<void> {
  await new Promise<void>((resolve) => process.nextTick(resolve))
  await Promise.resolve()
}

describe("TestRecorder", () => {
  let renderer: TestRenderer
  let recorder: TestRecorder
  let renderOnce: () => Promise<void>

  beforeEach(async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    renderer = setup.renderer
    renderOnce = setup.renderOnce
    recorder = new TestRecorder(renderer)
  })

  afterEach(() => {
    recorder.stop()
    renderer.destroy()
  })

  test("should initialize with empty frames", () => {
    expect(recorder.recordedFrames).toEqual([])
    expect(recorder.isRecording).toBe(false)
  })

  test("should start recording", () => {
    recorder.rec()
    expect(recorder.isRecording).toBe(true)
  })

  test("should stop recording", () => {
    recorder.rec()
    expect(recorder.isRecording).toBe(true)
    recorder.stop()
    expect(recorder.isRecording).toBe(false)
  })

  test("should record frames during rendering", async () => {
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "Hello World" })
    renderer.root.add(text)
    await waitForScheduledRender()

    expect(recorder.recordedFrames.length).toBe(1)

    await renderOnce()
    expect(recorder.recordedFrames.length).toBe(2)

    recorder.stop()
  })

  test("should capture frame content correctly", async () => {
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "Test Content" })
    renderer.root.add(text)
    await waitForScheduledRender()

    const frames = recorder.recordedFrames
    expect(frames.length).toBe(1)
    expect(frames[0].frame).toContain("Test Content")

    recorder.stop()
  })

  test("should include frame metadata", async () => {
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "Frame Metadata" })
    renderer.root.add(text)
    await waitForScheduledRender()

    const frames = recorder.recordedFrames
    expect(frames.length).toBe(1)
    expect(frames[0].timestamp).toBeGreaterThanOrEqual(0)
    expect(frames[0].frameNumber).toBe(0)

    recorder.stop()
  })

  test("should increment frame numbers", async () => {
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "Multiple Frames" })
    renderer.root.add(text)
    await waitForScheduledRender()

    await renderOnce()
    await renderOnce()

    const frames = recorder.recordedFrames
    expect(frames.length).toBe(3)
    expect(frames[0].frameNumber).toBe(0)
    expect(frames[1].frameNumber).toBe(1)
    expect(frames[2].frameNumber).toBe(2)

    recorder.stop()
  })

  test("should capture changing content across frames", async () => {
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "Initial" })
    renderer.root.add(text)
    await renderer.idle()

    text.content = "Changed"
    await renderer.idle()
    recorder.stop()

    const frames = recorder.recordedFrames
    const initialFrameIndex = frames.findIndex(({ frame }) => frame.includes("Initial"))
    const changedFrameIndex = frames.findIndex(
      ({ frame }, index) => index > initialFrameIndex && frame.includes("Changed"),
    )

    expect(initialFrameIndex).toBeGreaterThanOrEqual(0)
    expect(changedFrameIndex).toBeGreaterThan(initialFrameIndex)

    const frame1 = frames[initialFrameIndex].frame
    const frame2 = frames[changedFrameIndex].frame

    expect(frame1).toContain("Initial")
    expect(frame2).toContain("Changed")
    expect(frame1).not.toEqual(frame2)
  })

  test("should not record when not started", async () => {
    const text = new TextRenderable(renderer, { content: "Not Recording" })
    renderer.root.add(text)
    await waitForScheduledRender()

    expect(recorder.recordedFrames.length).toBe(0)
  })

  test("should not record after stopped", async () => {
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "Stopped" })
    renderer.root.add(text)
    await waitForScheduledRender()

    expect(recorder.recordedFrames.length).toBe(1)

    recorder.stop()
    await renderOnce()
    expect(recorder.recordedFrames.length).toBe(1)
  })

  test("should clear recorded frames", async () => {
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "Clear Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    await renderOnce()

    expect(recorder.recordedFrames.length).toBe(2)
    recorder.clear()
    expect(recorder.recordedFrames.length).toBe(0)

    recorder.stop()
  })

  test("should handle multiple rec/stop cycles", async () => {
    const text = new TextRenderable(renderer, { content: "Cycle Test" })

    recorder.rec()
    renderer.root.add(text)
    await waitForScheduledRender()
    recorder.stop()
    expect(recorder.recordedFrames.length).toBe(1)

    recorder.clear()
    recorder.rec()
    await renderOnce()
    await renderOnce()
    recorder.stop()
    expect(recorder.recordedFrames.length).toBe(2)
  })

  test("should not duplicate frames when rec is called multiple times", async () => {
    recorder.rec()
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "Duplicate Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    recorder.stop()

    expect(recorder.recordedFrames.length).toBe(1)
  })

  test("should capture timestamps in increasing order", async () => {
    let time = 0
    recorder = new TestRecorder(renderer, { now: () => time })
    recorder.rec()

    await renderOnce()
    time += 10
    await renderOnce()

    const frames = recorder.recordedFrames
    expect(frames.length).toBe(2)
    expect(frames[1].timestamp).toBeGreaterThan(frames[0].timestamp)
    expect(frames[1].timestamp - frames[0].timestamp).toBe(10)

    recorder.stop()
  })

  test("should return a copy of recorded frames", async () => {
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "Copy Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    const frames1 = recorder.recordedFrames
    const frames2 = recorder.recordedFrames

    expect(frames1).toEqual(frames2)
    expect(frames1).not.toBe(frames2)

    recorder.stop()
  })

  test("should handle empty renders", async () => {
    recorder.rec()
    await renderOnce()

    expect(recorder.recordedFrames.length).toBe(1)
    expect(recorder.recordedFrames[0].frame).toBeDefined()

    recorder.stop()
  })

  test("should capture complex content", async () => {
    recorder.rec()

    const text1 = new TextRenderable(renderer, { content: "Line 1" })
    const text2 = new TextRenderable(renderer, { content: "Line 2" })
    renderer.root.add(text1)
    renderer.root.add(text2)
    await waitForScheduledRender()

    const frame = recorder.recordedFrames[0].frame
    expect(frame).toContain("Line 1")
    expect(frame).toContain("Line 2")

    recorder.stop()
  })

  test("should handle rapid render calls", async () => {
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "Rapid Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    for (let i = 0; i < 4; i++) {
      await renderOnce()
    }

    expect(recorder.recordedFrames.length).toBe(5)

    recorder.stop()
  })

  test("should optionally record fg buffer", async () => {
    const recorderWithFg = new TestRecorder(renderer, { recordBuffers: { fg: true } })
    recorderWithFg.rec()

    const text = new TextRenderable(renderer, { content: "Buffer Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    const frames = recorderWithFg.recordedFrames
    expect(frames.length).toBe(1)
    expect(frames[0].buffers).toBeDefined()
    expect(frames[0].buffers?.fg).toBeInstanceOf(Uint16Array)
    expect(frames[0].buffers?.bg).toBeUndefined()
    expect(frames[0].buffers?.attributes).toBeUndefined()

    recorderWithFg.stop()
  })

  test("should optionally record bg buffer", async () => {
    const recorderWithBg = new TestRecorder(renderer, { recordBuffers: { bg: true } })
    recorderWithBg.rec()

    const text = new TextRenderable(renderer, { content: "Buffer Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    const frames = recorderWithBg.recordedFrames
    expect(frames.length).toBe(1)
    expect(frames[0].buffers).toBeDefined()
    expect(frames[0].buffers?.bg).toBeInstanceOf(Uint16Array)
    expect(frames[0].buffers?.fg).toBeUndefined()
    expect(frames[0].buffers?.attributes).toBeUndefined()

    recorderWithBg.stop()
  })

  test("should optionally record attributes buffer", async () => {
    const recorderWithAttrs = new TestRecorder(renderer, { recordBuffers: { attributes: true } })
    recorderWithAttrs.rec()

    const text = new TextRenderable(renderer, { content: "Buffer Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    const frames = recorderWithAttrs.recordedFrames
    expect(frames.length).toBe(1)
    expect(frames[0].buffers).toBeDefined()
    expect(frames[0].buffers?.attributes).toBeInstanceOf(Uint8Array)
    expect(frames[0].buffers?.fg).toBeUndefined()
    expect(frames[0].buffers?.bg).toBeUndefined()

    recorderWithAttrs.stop()
  })

  test("should record multiple buffers when requested", async () => {
    const recorderWithAll = new TestRecorder(renderer, {
      recordBuffers: { fg: true, bg: true, attributes: true },
    })
    recorderWithAll.rec()

    const text = new TextRenderable(renderer, { content: "Buffer Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    const frames = recorderWithAll.recordedFrames
    expect(frames.length).toBe(1)
    expect(frames[0].buffers).toBeDefined()
    expect(frames[0].buffers?.fg).toBeInstanceOf(Uint16Array)
    expect(frames[0].buffers?.bg).toBeInstanceOf(Uint16Array)
    expect(frames[0].buffers?.attributes).toBeInstanceOf(Uint8Array)

    recorderWithAll.stop()
  })

  test("should not record buffers when not requested", async () => {
    recorder.rec()

    const text = new TextRenderable(renderer, { content: "No Buffer Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    const frames = recorder.recordedFrames
    expect(frames.length).toBe(1)
    expect(frames[0].buffers).toBeUndefined()

    recorder.stop()
  })

  test("should record independent buffer copies", async () => {
    const recorderWithBuffers = new TestRecorder(renderer, { recordBuffers: { fg: true } })
    recorderWithBuffers.rec()

    const text = new TextRenderable(renderer, { content: "Copy Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    await renderOnce()

    const frames = recorderWithBuffers.recordedFrames
    expect(frames.length).toBe(2)

    const frame1Fg = frames[0].buffers?.fg
    const frame2Fg = frames[1].buffers?.fg

    expect(frame1Fg).toBeDefined()
    expect(frame2Fg).toBeDefined()
    expect(frame1Fg).not.toBe(frame2Fg)

    recorderWithBuffers.stop()
  })

  test("should have correct buffer sizes", async () => {
    const recorderWithAll = new TestRecorder(renderer, {
      recordBuffers: { fg: true, bg: true, attributes: true },
    })
    recorderWithAll.rec()

    const text = new TextRenderable(renderer, { content: "Size Test" })
    renderer.root.add(text)
    await waitForScheduledRender()

    const frames = recorderWithAll.recordedFrames
    expect(frames.length).toBe(1)

    const expectedSize = renderer.width * renderer.height
    expect(frames[0].buffers?.fg?.length).toBe(expectedSize * 4)
    expect(frames[0].buffers?.bg?.length).toBe(expectedSize * 4)
    expect(frames[0].buffers?.attributes?.length).toBe(expectedSize)

    recorderWithAll.stop()
  })
})
