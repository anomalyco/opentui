import { afterEach, expect, it } from "bun:test"
import { BoxRenderable, StyledText, TextAttributes, TextRenderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { act, useEffect, useState } from "react"
import { testRender } from "../src/test-utils.js"

let setup: Awaited<ReturnType<typeof testRender>>
afterEach(async () => {
  act(() => setup?.renderer.destroy())
  await setup?.renderer.closed
})

it.each([false, true])("preserves keyed identity and cleans up removed children (inline=%s)", async (inline) => {
  let parent!: BoxRenderable | TextRenderable
  let update!: (items: string[]) => void
  const cleanups: string[] = []
  function Item({ item }: { item: string }) {
    useEffect(
      () => () => {
        cleanups.push(item)
      },
      [],
    )
    return inline ? (
      <span>
        <b>{item}</b>
      </span>
    ) : (
      <box width={1}>
        <text>{item}</text>
      </box>
    )
  }
  function App() {
    const [items, setItems] = useState(["A", "B", "C"])
    update = setItems
    const children = items.map((item) => <Item key={item} item={item} />)
    return inline ? (
      <text
        ref={(node) => {
          parent = node!
        }}
      >
        {children}
      </text>
    ) : (
      <box
        ref={(node) => {
          parent = node!
        }}
        flexDirection="row"
      >
        {children}
      </box>
    )
  }
  setup = await testRender(<App />, { width: 6, height: 1, clock: new ManualClock() })
  const host = parent
  const children = () => (host instanceof TextRenderable ? host.getTextChildren() : host.getChildren())
  const [a, b, c] = children()
  await setup.renderOnce()
  expect(setup.captureCharFrame().trim()).toBe("ABC")
  act(() => update(["B", "D", "A", "C"]))
  const d = children()[1]
  expect(children()).toEqual([b, d, a, c])
  expect(cleanups).toEqual([])
  await setup.renderOnce()
  expect(setup.captureCharFrame().trim()).toBe("BDAC")
  act(() => update(["D", "C"]))
  expect(children()).toEqual([d, c])
  expect(a.parent).toBeNull()
  expect(b.parent).toBeNull()
  if (a instanceof BoxRenderable) expect(a.isDestroyed).toBe(true)
  expect(cleanups.toSorted()).toEqual(["A", "B"])
  await setup.renderOnce()
  expect(setup.captureCharFrame().trim()).toBe("DC")
  act(() => setup.renderer.destroy())
  await setup.renderer.closed
  expect(host.isDestroyed).toBe(true)
  expect(children()).toEqual([])
  expect(cleanups.toSorted()).toEqual(["A", "B", "C", "D"])
})

it("keeps direct content ahead of JSX edits, including an explicit empty replacement", async () => {
  const manual = new StyledText([{ __isChunk: true, text: "manual", attributes: TextAttributes.ITALIC }])
  let update!: (state: { content: string | StyledText; child: string }) => void
  let text!: TextRenderable
  function App() {
    const [state, setState] = useState<{ content: string | StyledText; child: string }>({
      content: manual,
      child: "child",
    })
    update = setState
    return (
      <text
        ref={(node) => {
          text = node!
        }}
        content={state.content}
      >
        <b>{state.child}</b>
      </text>
    )
  }
  setup = await testRender(<App />, { width: 12, height: 1, clock: new ManualClock() })
  const original = text
  for (const [content, child] of [
    [manual, "child"],
    [manual, "updated"],
    ["", "updated"],
    ["", "still hidden"],
  ] as const) {
    act(() => update({ content, child }))
    await setup.renderOnce()
    expect(text).toBe(original)
    if (content === manual) expect(text.content).toBe(manual)
    expect(setup.captureCharFrame().trim()).toBe(content === manual ? "manual" : "")
  }
})

it("resets removed props and style keys to their defaults", async () => {
  let box!: BoxRenderable
  let text!: TextRenderable
  let setOn!: (on: boolean) => void
  function App() {
    const [on, set] = useState(true)
    setOn = set
    const boxProps = on
      ? { titleAlignment: "center" as const, focusable: true, shouldFill: false, style: { translateX: 1 } }
      : { style: {} }
    return (
      <box ref={(node) => (box = node!)} title="T" border width={7} height={3} {...boxProps}>
        <text ref={(node) => (text = node!)} {...(on ? { wrapMode: "char" as const, truncate: true } : {})}>
          hi
        </text>
      </box>
    )
  }
  setup = await testRender(<App />, { width: 8, height: 3, clock: new ManualClock() })
  await setup.renderOnce()
  act(() => setOn(false))
  await setup.renderOnce()
  expect(setup.captureCharFrame().split("\n")[0]).toBe("┌─T───┐ ")
  expect([box.titleAlignment, box.focusable, box.shouldFill, box.translateX]).toEqual(["left", false, true, 0])
  expect([text.wrapMode, text.truncate]).toEqual(["word", false])
})
