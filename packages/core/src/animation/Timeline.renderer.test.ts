import { expect, test } from "bun:test"
import { createTimeline, getTimelineEngine } from "./Timeline.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"

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
    createTimeline({ duration: 100 }, second.renderer).add(secondValue, {
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
  } finally {
    first.renderer.destroy()
    second.renderer.destroy()
    await Promise.all([first.renderer.closed, second.renderer.closed])
  }
})
