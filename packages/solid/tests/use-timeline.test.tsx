import { expect, spyOn, test } from "bun:test"
import { getTimelineEngine, type Timeline } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { testRender, useTimeline } from "../index.js"

test("useTimeline keeps separate roots independent after either renderer is destroyed", async () => {
  const timelines: Timeline[] = []
  function App() {
    timelines.push(useTimeline({ autoplay: false }))
    return <text>timeline</text>
  }
  const firstClock = new ManualClock()
  const secondClock = new ManualClock()
  const first = await testRender(App, { width: 10, height: 1, clock: firstClock })
  const second = await testRender(App, { width: 10, height: 1, clock: secondClock })
  try {
    first.renderer.pause()
    second.renderer.pause()
    timelines[0]!.play()
    timelines[1]!.play()
    firstClock.advance(20)
    await first.renderOnce()
    expect(timelines[0]!.currentTime).toBe(20)
    expect(timelines[1]!.currentTime).toBe(0)
    first.renderer.destroy()
    await first.renderer.closed
    secondClock.advance(30)
    await second.renderOnce()
    expect(timelines[1]!.currentTime).toBe(30)
  } finally {
    first.renderer.destroy()
    second.renderer.destroy()
    await Promise.all([first.renderer.closed, second.renderer.closed])
  }
})

test("a throwing timeline cleanup cannot retain another hook's engine ownership", async () => {
  const timelines: Timeline[] = []
  const failure = new Error("fixture timeline pause")
  function App() {
    timelines.push(useTimeline({ autoplay: false }))
    timelines.push(
      useTimeline({
        autoplay: false,
        onPause() {
          throw failure
        },
      }),
    )
    return <text>timelines</text>
  }
  const source = await testRender(App, { width: 10, height: 1 })
  const target = await createTestRenderer({ width: 10, height: 1 })
  const owner = getTimelineEngine(source.renderer)
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    source.renderer.destroy()
    await source.renderer.closed
    const retained = owner as unknown as { renderer: unknown; timelines: Set<Timeline> }
    expect(retained.renderer === null).toBe(true)
    expect(retained.timelines.size).toBe(0)
    const next = getTimelineEngine(target.renderer)
    for (const timeline of timelines) {
      expect((timeline as unknown as { stateChangeListeners: unknown[] }).stateChangeListeners).toHaveLength(0)
      expect(() => next.register(timeline)).not.toThrow()
    }
    expect(errors).toHaveBeenCalledWith("Error in native scene destroy listener:", failure)
  } finally {
    source.renderer.destroy()
    target.renderer.destroy()
    await Promise.all([source.renderer.closed, target.renderer.closed])
    errors.mockRestore()
  }
})
