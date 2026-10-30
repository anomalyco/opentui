import { expect, test } from "bun:test"
import { createTimeline, type Timeline } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { createSignal } from "solid-js"
import { onAnimationTick, testRender, useTimeline } from "../index.js"

test("createTimeline without a renderer animates after render()", async () => {
  const clock = new ManualClock()
  const setup = await testRender(() => <text>timeline</text>, { width: 10, height: 1, clock })
  try {
    setup.renderer.pause()
    const value = { x: 0 }
    createTimeline({ duration: 25 }).add(value, { x: 100, duration: 100 })
    clock.advance(25)
    await setup.renderOnce()
    expect(value.x).toBe(25)
  } finally {
    setup.renderer.destroy()
    await setup.renderer.closed
  }
})

test("useTimeline keeps roots independent; createTimeline() without a renderer follows the last render()", async () => {
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
    const free = createTimeline({ duration: 30 })
    firstClock.advance(20)
    await first.renderOnce()
    expect([timelines[0]!.currentTime, timelines[1]!.currentTime, free.currentTime]).toEqual([20, 0, 0])
    first.renderer.destroy()
    await first.renderer.closed
    secondClock.advance(30)
    await second.renderOnce()
    expect([timelines[1]!.currentTime, free.currentTime]).toEqual([30, 30])
  } finally {
    first.renderer.destroy()
    second.renderer.destroy()
    await Promise.all([first.renderer.closed, second.renderer.closed])
  }
})

test("onAnimationTick updates on the tick's own frame and pauses with an undefined rate", async () => {
  const clock = new ManualClock()
  const [fps, setFps] = createSignal<number | undefined>(20)
  function App() {
    const [count, setCount] = createSignal(0)
    onAnimationTick(fps, (_deltaTime, ticks) => setCount((value) => value + ticks))
    return <text>{String(count())}</text>
  }
  const setup = await testRender(App, { width: 4, height: 1, clock, targetFps: 60, maxFps: 60 })
  try {
    let frames = 0
    setup.renderer.on("frame", () => frames++)
    const run = async () => {
      frames = 0
      for (let i = 0; i < 4000; i++) {
        if (i % 4 === 0) clock.advance(1)
        await new Promise((resolve) => setImmediate(resolve))
      }
      return [frames, setup.captureCharFrame().trim()]
    }
    const playing = await run()
    setFps(undefined)
    const paused = await run()
    expect({ playing, paused, timers: clock.pendingTimerCount }).toEqual({
      playing: [21, "20"],
      paused: [0, "20"],
      timers: 0,
    })
  } finally {
    setup.renderer.destroy()
    await setup.renderer.closed
  }
})
