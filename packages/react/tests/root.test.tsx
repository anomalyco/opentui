import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { act, memo, useEffect, useState } from "react"
import { useKeyboard } from "../src/hooks/use-keyboard.js"
import { createRoot, flushSync, type Root } from "../src/reconciler/renderer.js"

let setup: Awaited<ReturnType<typeof createTestRenderer>>
let root: Root

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
  setup = await createTestRenderer({ width: 20, height: 6, clock: new ManualClock() })
  root = createRoot(setup.renderer)
})

afterEach(() => setup.dispose())

test.each(["unmount", "destroy"] as const)("rerenders preserve state and clean up effects on %s", async (teardown) => {
  const listeners = setup.renderer.listenerCount("destroy")
  const events: string[] = []
  let setCount!: (value: number) => void
  let keyRenders = 0
  const Keys = memo(() => {
    keyRenders++
    useKeyboard(() => events.push("key"))
    return null
  })
  function Counter({ label }: { label: string }) {
    const [count, update] = useState(0)
    setCount = update
    useEffect(() => {
      events.push(`mount:${label}`)
      return () => {
        events.push(`cleanup:${label}`)
        if (label === "third") root.render(<Counter label="fourth" />)
      }
    }, [])
    return (
      <text>
        {label}:{count}
        <Keys />
      </text>
    )
  }

  flushSync(() => root.render(<Counter label="first" />))
  expect(setup.renderer.listenerCount("destroy")).toBe(listeners + 1)
  flushSync(() => setCount(7))
  flushSync(() => root.render(<Counter label="second" />))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("second:7")

  flushSync(() => root.render(<Counter key="replacement" label="third" />))
  setup.mockInput.pressKey("x")
  expect(keyRenders).toBe(2)
  if (teardown === "unmount") root.unmount()
  else setup.renderer.destroy()
  expect(events).toEqual(["mount:first", "cleanup:first", "mount:third", "key", "cleanup:third"])
  expect(setup.renderer.listenerCount("destroy")).toBe(teardown === "unmount" ? listeners + 1 : 0)

  flushSync(() => root.render(<Counter label="fourth" />))
  setup.renderer.destroy()
  expect(events.slice(5)).toEqual(teardown === "unmount" ? ["mount:fourth", "cleanup:fourth"] : [])
})

test("explicit renders retry a tree that failed on a later render", async () => {
  using errors = spyOn(console, "error").mockImplementation(() => {})
  let broken = false
  function App() {
    if (broken) throw new Error("root")
    return <text>healthy</text>
  }
  const element = <App />
  flushSync(() => root.render(element))
  broken = true
  flushSync(() => root.render(<App />))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Error: root")
  expect(errors).toHaveBeenCalledTimes(1)
  broken = false
  flushSync(() => root.render(element))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("healthy")
})

test("render, render, and destroy in one tick log no error", async () => {
  using errors = spyOn(console, "error")
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  // act() runs the work that the renders queued only after destroy(), when it leaves the callback.
  await act(async () => {
    root.render(<box />)
    root.render(<box />)
    setup.renderer.destroy()
  })
  expect(errors).not.toHaveBeenCalled()
})
