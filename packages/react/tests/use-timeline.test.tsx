import { afterEach, expect, test } from "bun:test"
import type { Timeline } from "@opentui/core"
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

test("useTimeline keeps separate roots independent after either renderer is destroyed", async () => {
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
    firstClock.advance(20)
    await first.renderOnce()
    expect(timelines[0].currentTime).toBe(20)
    expect(timelines[1].currentTime).toBe(0)
    act(() => first.renderer.destroy())
    await first.renderer.closed
    secondClock.advance(30)
    await second.renderOnce()
    expect(timelines[1].currentTime).toBe(30)
  } finally {
    act(() => first.renderer.destroy())
    // testRender clears the process-wide act flag when either renderer closes.
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    act(() => second.renderer.destroy())
    await Promise.all([first.renderer.closed, second.renderer.closed])
  }
})
