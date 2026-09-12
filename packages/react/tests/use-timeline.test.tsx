import { afterEach, expect, test } from "bun:test"
import type { Timeline } from "@opentui/core"
import { act, useState } from "react"

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
