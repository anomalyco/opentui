import { afterEach, expect, test } from "bun:test"
import { createTimeline, type Timeline } from "@opentui/core"
import { act, useState } from "react"
import { ManualClock } from "@opentui/core/testing"

import { useTimeline } from "../src/hooks/use-timeline.js"
import { testRender } from "../src/test-utils.js"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  act(() => testSetup?.renderer.destroy())
  testSetup = undefined
})

test("useTimeline preserves its Timeline across rerenders", async () => {
  const timelines: Timeline[] = []
  let setValue: (value: number) => void = () => {}

  function App() {
    const [value, updateValue] = useState(0)
    setValue = updateValue
    timelines.push(useTimeline({ autoplay: false }))
    return <text>{value}</text>
  }

  testSetup = await testRender(<App />, { width: 10, height: 1 })

  act(() => setValue(1))

  expect(timelines).toHaveLength(2)
  expect(timelines[1]).toBe(timelines[0])
})

test("createTimeline without a renderer animates after render()", async () => {
  const clock = new ManualClock()
  testSetup = await testRender(<text>timeline</text>, { width: 10, height: 1, clock })
  testSetup.renderer.pause()
  const value = { x: 0 }
  createTimeline({ duration: 25 }).add(value, { x: 100, duration: 100 })
  clock.advance(25)
  await testSetup.renderOnce()
  expect(value.x).toBe(25)
})

test("useTimeline keeps roots independent; createTimeline() without a renderer follows the last render()", async () => {
  const timelines: Timeline[] = []
  function App() {
    timelines.push(useTimeline({ autoplay: false }))
    return <text>timeline</text>
  }
  const firstClock = new ManualClock()
  const secondClock = new ManualClock()
  const first = await testRender(<App />, { width: 10, height: 1, clock: firstClock })
  const second = await testRender(<App />, { width: 10, height: 1, clock: secondClock })
  try {
    first.renderer.pause()
    second.renderer.pause()
    timelines[0].play()
    timelines[1].play()
    const free = createTimeline({ duration: 30 })
    firstClock.advance(20)
    await first.renderOnce()
    expect([timelines[0].currentTime, timelines[1].currentTime, free.currentTime]).toEqual([20, 0, 0])
    act(() => first.renderer.destroy())
    await first.renderer.closed
    secondClock.advance(30)
    await second.renderOnce()
    expect([timelines[1].currentTime, free.currentTime]).toEqual([30, 30])
  } finally {
    act(() => first.renderer.destroy())
    // testRender clears the process-wide act flag when either renderer closes.
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    act(() => second.renderer.destroy())
    await Promise.all([first.renderer.closed, second.renderer.closed])
  }
})
