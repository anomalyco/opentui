import { expect, test } from "bun:test"
import { createTimeline, engine, type Timeline } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { testRender, useTimeline } from "../index.js"

test("createTimeline without a renderer animates after render()", async () => {
  engine.detach() // A renderer leaked by an earlier test file would keep driving the default engine.
  const clock = new ManualClock()
  const setup = await testRender(() => <text>timeline</text>, { width: 10, height: 1, clock })
  try {
    setup.renderer.pause()
    const value = { x: 0 }
    createTimeline({ duration: 100 }).add(value, { x: 100, duration: 100 })
    clock.advance(25)
    await setup.renderOnce()
    expect(value.x).toBe(25)
  } finally {
    setup.renderer.destroy()
    await setup.renderer.closed
  }
})

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
