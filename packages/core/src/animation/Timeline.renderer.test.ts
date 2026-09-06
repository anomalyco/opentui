import { expect, spyOn, test } from "bun:test"
import { createTimeline, engine, getTimelineEngine, Timeline } from "./Timeline.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import * as core from "../index.js"

test("root animation exports preserve the public API without exposing renderer cleanup", () => {
  expect(core.Timeline).toBe(Timeline)
  expect(core.createTimeline).toBe(createTimeline)
  expect(core.engine).toBe(engine)
  expect(core.getTimelineEngine).toBe(getTimelineEngine)
  expect("destroyTimelineEngine" in core).toBe(false)
})

test("renderer-owned timelines advance independently and release only their owner's callbacks", async () => {
  const firstClock = new ManualClock()
  const secondClock = new ManualClock()
  const first = await createTestRenderer({ width: 2, height: 1, clock: firstClock })
  const second = await createTestRenderer({ width: 2, height: 1, clock: secondClock })
  try {
    first.renderer.pause()
    second.renderer.pause()
    const firstEngine = getTimelineEngine(first.renderer)
    const secondEngine = getTimelineEngine(second.renderer)
    expect(getTimelineEngine(first.renderer)).toBe(firstEngine)
    expect(firstEngine).not.toBe(secondEngine)
    const firstValue = { x: 0 }
    const secondValue = { x: 0 }
    const firstTimeline = createTimeline({ duration: 100 }, first.renderer).add(firstValue, { x: 100, duration: 100 })
    const secondTimeline = createTimeline({ duration: 100 }, second.renderer).add(secondValue, {
      x: 100,
      duration: 100,
    })

    firstClock.advance(25)
    await first.renderOnce()
    expect(firstValue.x).toBe(25)
    expect(secondValue.x).toBe(0)
    secondClock.advance(50)
    await second.renderOnce()
    expect(secondValue.x).toBe(50)
    expect(firstValue.x).toBe(25)
    expect(() => secondEngine.register(firstTimeline)).toThrow("another timeline engine")

    first.renderer.destroy()
    await first.renderer.closed
    firstTimeline.play()
    firstEngine.update(25)
    expect(firstValue.x).toBe(25)
    expect(() => getTimelineEngine(first.renderer)).toThrow("destroyed")
    secondClock.advance(50)
    await second.renderOnce()
    expect(secondValue.x).toBe(100)
    expect(secondTimeline.isComplete).toBe(true)
  } finally {
    first.renderer.destroy()
    second.renderer.destroy()
    await Promise.all([first.renderer.closed, second.renderer.closed])
  }
})

test("clearing one renderer engine does not drop another renderer's live timeline", async () => {
  const first = await createTestRenderer({ width: 2, height: 1 })
  const second = await createTestRenderer({ width: 2, height: 1 })
  try {
    const firstTimeline = createTimeline({ loop: true }, first.renderer)
    const secondTimeline = createTimeline({ loop: true }, second.renderer)
    getTimelineEngine(first.renderer).clear()
    expect(first.renderer.isRunning).toBe(false)
    expect(second.renderer.isRunning).toBe(true)
    firstTimeline.pause().play()
    expect(first.renderer.isRunning).toBe(false)
    getTimelineEngine(second.renderer).unregister(secondTimeline)
    expect(second.renderer.isRunning).toBe(false)
  } finally {
    first.renderer.destroy()
    second.renderer.destroy()
    await Promise.all([first.renderer.closed, second.renderer.closed])
  }
})

test("legacy engine attachment is explicit and cannot silently move timelines to a second renderer", async () => {
  const first = await createTestRenderer({ width: 2, height: 1 })
  const second = await createTestRenderer({ width: 2, height: 1 })
  try {
    engine.attach(first.renderer)
    const timeline = createTimeline({ loop: true })
    expect(getTimelineEngine(first.renderer)).toBe(engine)
    expect(() => engine.attach(second.renderer)).toThrow("already attached")
    expect(first.renderer.isRunning).toBe(true)
    expect(second.renderer.isRunning).toBe(false)
    engine.unregister(timeline)
    expect(first.renderer.isRunning).toBe(false)
  } finally {
    engine.clear()
    engine.detach()
    first.renderer.destroy()
    second.renderer.destroy()
    await Promise.all([first.renderer.closed, second.renderer.closed])
  }
})

test("a renderer engine can be explicitly restored after frame callbacks are cleared", async () => {
  const clock = new ManualClock()
  const { renderer, renderOnce } = await createTestRenderer({ width: 2, height: 1, clock })
  try {
    renderer.pause()
    const owner = getTimelineEngine(renderer)
    const timeline = new Timeline({ duration: 100 }).play()
    owner.register(timeline)
    renderer.clearFrameCallbacks()
    expect(getTimelineEngine(renderer)).toBe(owner)
    clock.advance(10)
    await renderOnce()
    expect(timeline.currentTime).toBe(10)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test.each(["lookup", "factory"] as const)(
  "engine %s preserves frame callback order and ordinary duplicates",
  async (operation) => {
    const clock = new ManualClock()
    const { renderer, renderOnce } = await createTestRenderer({ width: 2, height: 1, clock })
    const observed: number[] = []
    let duplicates = 0
    try {
      renderer.pause()
      const timeline = createTimeline({ duration: 100 }, renderer)
      renderer.setFrameCallback(async () => {
        observed.push(timeline.currentTime)
      })
      const duplicate = async () => {
        duplicates++
      }
      renderer.setFrameCallback(duplicate)
      renderer.setFrameCallback(duplicate)
      clock.advance(10)
      await renderOnce()
      if (operation === "lookup") getTimelineEngine(renderer)
      else createTimeline({ autoplay: false }, renderer)
      clock.advance(10)
      await renderOnce()
      expect(observed).toEqual([10, 20])
      expect(duplicates).toBe(4)
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  },
)

test.each(["earlier", "prepended"] as const)(
  "a throwing %s destroy listener cannot retain timeline ownership",
  async (position) => {
    const first = await createTestRenderer({ width: 2, height: 1 })
    const clock = new ManualClock()
    const second = await createTestRenderer({ width: 2, height: 1, clock })
    const failure = new Error("fixture destroy listener")
    const fail = () => {
      throw failure
    }
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      first.renderer.pause()
      second.renderer.pause()
      if (position === "earlier") first.renderer.on("destroy", fail)
      const owner = getTimelineEngine(first.renderer)
      const timeline = createTimeline({ duration: 100 }, first.renderer)
      if (position === "prepended") first.renderer.prependOnceListener("destroy", fail)
      first.renderer.destroy()
      await first.renderer.closed
      const retained = owner as unknown as { renderer: unknown; timelines: Set<Timeline> }
      expect(retained.renderer === null).toBe(true)
      expect(retained.timelines.size).toBe(0)
      expect((timeline as unknown as { stateChangeListeners: unknown[] }).stateChangeListeners).toHaveLength(0)
      expect(errors).toHaveBeenCalledWith("Error in native scene destroy listener:", failure)
      getTimelineEngine(second.renderer).register(timeline)
      clock.advance(10)
      await second.renderOnce()
      expect(timeline.currentTime).toBe(10)
    } finally {
      first.renderer.destroy()
      second.renderer.destroy()
      await Promise.all([first.renderer.closed, second.renderer.closed])
      errors.mockRestore()
    }
  },
)
