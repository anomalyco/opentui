import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { act, useEffect, useLayoutEffect, useState } from "react"
import { createRoot, type Root } from "../src/reconciler/renderer.js"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let previousActEnvironment: boolean | undefined
let setup: Awaited<ReturnType<typeof createTestRenderer>>
let root: Root

beforeEach(async () => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  setup = await createTestRenderer({ width: 20, height: 2 })
  root = createRoot(setup.renderer)
})

afterEach(async () => {
  try {
    await act(() => setup?.renderer.destroy())
  } finally {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

test("root.render updates props while preserving component state and host instances", async () => {
  let updateCount: (count: number) => void = () => {}

  function Counter({ label }: { label: string }) {
    const [count, setCount] = useState(0)
    updateCount = setCount
    return <text>{`${label}: ${count}`}</text>
  }

  await act(() => root.render(<Counter label="first" />))
  const child = setup.renderer.root.getChildren()[0]
  await act(() => updateCount(7))
  await act(() => root.render(<Counter label="second" />))
  await setup.renderOnce()

  expect(setup.captureCharFrame()).toContain("second: 7")
  expect(setup.renderer.root.getChildren()).toEqual([child])
})

test("root.render cleans up effects when replacing a keyed component", async () => {
  const events: string[] = []

  function Probe({ label }: { label: string }) {
    useLayoutEffect(() => {
      events.push(`layout mount ${label}`)
      return () => {
        events.push(`layout cleanup ${label}`)
      }
    }, [])
    useEffect(() => {
      events.push(`effect mount ${label}`)
      return () => {
        events.push(`effect cleanup ${label}`)
      }
    }, [])
    return <text>{label}</text>
  }

  await act(() => root.render(<Probe key="first" label="first" />))
  await act(() => root.render(<Probe key="second" label="second" />))
  await setup.renderOnce()

  expect(setup.captureCharFrame()).toContain("second")
  expect(events).toEqual([
    "layout mount first",
    "effect mount first",
    "layout cleanup first",
    "layout mount second",
    "effect cleanup first",
    "effect mount second",
  ])
})

test.each(["unmount", "destroy"] as const)(
  "%s cleans up the tree after repeated root.render calls",
  async (teardown) => {
    const subscriptions = new Set<object>()
    let cleanups = 0

    function Probe({ label }: { label: string }) {
      useEffect(() => {
        const subscription = {}
        subscriptions.add(subscription)
        return () => {
          subscriptions.delete(subscription)
          cleanups++
        }
      }, [])
      return <text>{label}</text>
    }

    await act(() => root.render(<Probe label="first" />))
    await act(() => root.render(<Probe label="second" />))
    await act(() => root.render(<Probe label="third" />))
    await act(() => {
      if (teardown === "unmount") root.unmount()
      else setup.renderer.destroy()
    })

    expect(subscriptions.size).toBe(0)
    expect(cleanups).toBe(1)
  },
)

test("root.render(null) clears the tree before rendering new content", async () => {
  const cleanups: string[] = []

  function Probe({ label }: { label: string }) {
    useEffect(
      () => () => {
        cleanups.push(label)
      },
      [],
    )
    return <text>{label}</text>
  }

  await act(() => root.render(<Probe label="first" />))
  await act(() => root.render(null))
  expect(setup.renderer.root.getChildren()).toHaveLength(0)
  expect(cleanups).toEqual(["first"])

  await act(() => root.render(<Probe label="second" />))
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("second")
  await act(() => root.unmount())
  expect(cleanups).toEqual(["first", "second"])
})

test("consecutive root.render calls in one batch only mount the latest tree", async () => {
  const mounts: string[] = []

  function Probe({ label }: { label: string }) {
    useEffect(() => {
      mounts.push(label)
    }, [])
    return <text>{label}</text>
  }

  await act(() => {
    root.render(<Probe label="first" />)
    root.render(<Probe label="second" />)
  })
  await setup.renderOnce()

  expect(setup.captureCharFrame()).toContain("second")
  expect(mounts).toEqual(["second"])
})

test("root.render can recover after the previous tree throws", async () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => {})

  function Broken(): never {
    throw new Error("root render failed")
  }

  try {
    await act(() => root.render(<Broken />))
    await act(() => root.render(<text>recovered</text>))
    await setup.renderOnce()

    expect(setup.captureCharFrame()).toContain("recovered")
  } finally {
    consoleError.mockRestore()
  }
})

test("root.render can retry the same element after repeated errors", async () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => {})
  let shouldThrow = true

  function App() {
    if (shouldThrow) throw new Error("root render failed")
    return <text>recovered</text>
  }

  const element = <App />
  try {
    await act(() => root.render(element))
    const errors = consoleError.mock.calls.length
    expect(errors).toBeGreaterThan(0)
    await act(() => root.render(element))
    expect(consoleError.mock.calls.length).toBeGreaterThan(errors)

    shouldThrow = false
    await act(() => root.render(element))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("recovered")
  } finally {
    consoleError.mockRestore()
  }
})
