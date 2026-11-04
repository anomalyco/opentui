import { expect, test } from "bun:test"
import { createTimeline, engine, getTimelineEngine, Timeline } from "./Timeline.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { settle } from "../testing/harness.js"

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

// targetFps, engine default frameRate, timeline frameRates → frames in the second they play, live, and frames in
// the next second (the live loop draws one more frame to finish). Before frameRate was read, every row was live.
const rateRows: [string, number, number | undefined, (number | undefined)[], number, boolean, number][] = [
  ["the default 60 at targetFps 30 holds the loop", 30, undefined, [undefined], 31, true, 1],
  ["the default 60 at targetFps 60 holds the loop", 60, undefined, [undefined], 63, true, 1],
  ["frameRate 10 ticks instead", 60, undefined, [10], 10, false, 0],
  ["the fastest playing timeline sets the rate", 60, undefined, [10, 20], 20, false, 0],
  ["a default timeline beside a slow one holds the loop", 60, undefined, [10, undefined], 63, true, 1],
  ["engine.defaults.frameRate applies to timelines without one", 60, 20, [undefined], 20, false, 0],
  ["targetFps above the default 60 now runs at 60", 120, undefined, [undefined], 60, false, 0],
  ["frameRate Infinity holds the loop", 60, undefined, [Infinity], 63, true, 1],
]

for (const [name, targetFps, defaultRate, rates, frames, live, after] of rateRows) {
  test(`timeline frameRate: ${name}`, async () => {
    const clock = new ManualClock()
    const { renderer } = await createTestRenderer({ width: 2, height: 1, clock, targetFps, maxFps: 60 })
    try {
      const engine = getTimelineEngine(renderer)
      if (defaultRate !== undefined) engine.defaults.frameRate = defaultRate
      let count = 0
      renderer.on("frame", () => count++)
      // Each timeline animates something, which requests a render on every update.
      const timelines = rates.map((frameRate) =>
        createTimeline({ duration: 1000, frameRate }, renderer).add(
          { x: 0 },
          { x: 1, duration: 1000, onUpdate: () => renderer.root.requestRender() },
        ),
      )
      const run = async (ms: number) => {
        count = 0
        for (let i = 0; i < ms; i++) (clock.advance(1), await settle(4))
        return count
      }
      const playing = await run(1000)
      const isLive = renderer.liveRequestCount > 0
      const ended = await run(1000)
      const complete = timelines.every((timeline) => timeline.isComplete)
      expect({ playing, live: isLive, ended, complete, timers: clock.pendingTimerCount }).toEqual({
        playing: frames,
        live,
        ended: after,
        complete: true,
        timers: 0,
      })
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  })
}

test("timeline frameRate: the default engine moves its ticks to the renderer it attaches to", async () => {
  const clocks = [new ManualClock(), new ManualClock()]
  const setups = await Promise.all(clocks.map((clock) => createTestRenderer({ width: 2, height: 1, clock })))
  try {
    engine.attach(setups[0].renderer)
    const timeline = createTimeline({ frameRate: 10 })
    const before = clocks.map((clock) => clock.pendingTimerCount)
    engine.attach(setups[1].renderer)
    expect([before, clocks.map((clock) => clock.pendingTimerCount)]).toEqual([
      [1, 0],
      [0, 1],
    ])
    engine.unregister(timeline)
  } finally {
    for (const { renderer } of setups) renderer.destroy()
    await Promise.all(setups.map(({ renderer }) => renderer.closed))
  }
})

test("timeline frameRate must be above 0", () => {
  const timeline = new Timeline({ frameRate: Infinity })
  for (const frameRate of [0, -5, NaN]) {
    expect(() => new Timeline({ frameRate })).toThrow(RangeError)
    expect(() => (timeline.frameRate = frameRate)).toThrow(RangeError)
  }
  timeline.frameRate = 10
  timeline.frameRate = undefined
  expect(timeline.frameRate).toBeUndefined()
})
