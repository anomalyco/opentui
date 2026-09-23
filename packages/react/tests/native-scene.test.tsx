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
