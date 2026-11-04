import { afterEach, expect, it } from "bun:test"
import { BoxRenderable, TextRenderable, type Renderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import {
  act,
  createContext,
  createRef,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactPortal,
} from "react"
import { createPortal, flushSync } from "../src/index.js"
import { testRender } from "../src/test-utils.js"

let setup: Awaited<ReturnType<typeof testRender>>
afterEach(async () => {
  act(() => setup?.renderer.destroy())
  await setup?.renderer.closed
})

it("exposes each flushSync commit before drawing while ordinary updates batch", async () => {
  const ref = createRef<TextRenderable>()
  const commits: number[] = []
  let update!: (value: number) => void
  function App() {
    const [value, setValue] = useState(0)
    update = setValue
    useLayoutEffect(() => {
      commits.push(Number(ref.current!.plainText))
    })
    return <text ref={ref} content={String(value)} />
  }
  setup = await testRender(<App />, { width: 8, height: 1, clock: new ManualClock() })
  await setup.renderOnce()
  act(() => {
    update(1)
    update(2)
    expect(commits).toEqual([0])
  })
  expect(commits).toEqual([0, 2])
  expect(setup.captureCharFrame().trim()).toBe("0")
  act(() => {
    flushSync(() => update(3))
    expect(commits).toEqual([0, 2, 3])
    flushSync(() => update(4))
    expect(commits).toEqual([0, 2, 3, 4])
  })
  expect(setup.captureCharFrame().trim()).toBe("0")
  await setup.renderOnce()
  expect(setup.captureCharFrame().trim()).toBe("4")
})

it.each(["main", "detached"])("portals preserve context and keyed identity in %s mounts", async (mode) => {
  const Value = createContext("missing")
  const cleanups: string[] = []
  const nodes = new Map<string, TextRenderable>()
  let update!: (state: { target: Renderable | null; items: string[]; label: string }) => void
  function Item({ name }: { name: string }) {
    const label = useContext(Value)
    useEffect(
      () => () => {
        cleanups.push(name)
      },
      [],
    )
    return (
      <text
        ref={(node) => {
          if (node) nodes.set(name, node)
        }}
        id="duplicate"
        content={`${name}${label}`}
      />
    )
  }
  function App() {
    const [state, setState] = useState<{ target: Renderable | null; items: string[]; label: string }>({
      target: null,
      items: ["A", "B"],
      label: "0",
    })
    update = setState
    return (
      <Value.Provider value={state.label}>
        <text content="footer" />
        {state.target &&
          (createPortal(
            state.items.map((name) => <Item key={name} name={name} />),
            state.target,
            null,
          ) as unknown as ReactPortal)}
      </Value.Provider>
    )
  }
  setup = await testRender(<App />, {
    width: 16,
    height: 10,
    footerHeight: 6,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    clock: new ManualClock(),
  })
  const surface = mode === "detached" ? setup.renderer.createScrollbackSurface() : undefined
  const root = surface?.root ?? setup.renderer.root
  const context = surface?.renderContext ?? setup.renderer
  const left = new BoxRenderable(context, { height: 2 })
  const right = new BoxRenderable(context, { height: 2 })
  root.add(left)
  root.add(right)
  const change = (target: Renderable | null, items = ["B", "A"], label = "1") =>
    act(() => update({ target, items, label }))
  change(left, ["A", "B"], "0")
  const a = nodes.get("A")!
  const b = nodes.get("B")!
  expect(left.getChildren()).toEqual([a, b])
  expect(a.ctx).toBe(context)
  change(left)
  expect(left.getChildren()).toEqual([b, a])
  expect(a.plainText).toBe("A1")
  expect(cleanups).toEqual([])
  change(right)
  expect(left.getChildren()).toEqual([])
  expect(a.isDestroyed && b.isDestroyed).toBe(true)
  expect(cleanups.toSorted()).toEqual(["A", "B"])
  const moved = right.getChildren()
  expect(moved).toEqual([nodes.get("B")!, nodes.get("A")!])
  expect(moved.every((node) => node.ctx === context && !node.isDestroyed)).toBe(true)
  if (surface) {
    surface.render()
    surface.commitRows(0, surface.height)
    expect(setup.externalOutput.takeText()).toContain("A1")
    await setup.renderOnce()
    expect(setup.captureCharFrame().trim()).toBe("footer")
    surface.destroy()
    expect(moved.every((node) => node.isDestroyed)).toBe(true)
  } else {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("A1")
  }
  change(null)
  expect(right.getChildren()).toEqual([])
  expect(cleanups.toSorted()).toEqual(["A", "A", "B", "B"])
  expect(moved.every((node) => node.isDestroyed && node.parent === null)).toBe(true)
})
