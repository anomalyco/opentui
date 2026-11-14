import { afterEach, expect, it } from "bun:test"
import type { InputKeyBinding, InputRenderable } from "@opentui/core"
import { act, createRef, useState } from "react"
import { testRender } from "../src/test-utils.js"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  act(() => setup?.renderer.destroy())
  await setup?.renderer.closed
  setup = undefined
})

it("preserves Input submit defaults when keyBindings props mount, change and disappear", async () => {
  const ref = createRef<InputRenderable>()
  const events: string[] = []
  const shortcut: InputKeyBinding[] = [{ name: "x", ctrl: true, action: "line-home" }]
  let update!: (bindings: InputKeyBinding[] | undefined) => void
  function App() {
    const [bindings, setBindings] = useState<InputKeyBinding[] | undefined>(shortcut)
    update = setBindings
    return (
      <input
        ref={ref}
        focused
        value="hello"
        {...(bindings === undefined ? {} : { keyBindings: bindings })}
        onChange={(value) => events.push(`change:${value}`)}
        onSubmit={(value) => events.push(`submit:${value}`)}
      />
    )
  }
  setup = await testRender(<App />, { width: 30, height: 3 })
  const input = ref.current!
  act(() => input.insertText("!"))
  act(() => setup!.mockInput.pressKey("x", { ctrl: true }))
  expect(input.cursorOffset).toBe(0)
  act(() => setup!.mockInput.pressEnter())
  expect(events).toEqual(["change:hello!", "submit:hello!"])
  events.length = 0
  act(() => update([{ name: "return", action: "line-home" }]))
  act(() => {
    input.gotoBufferEnd()
    input.insertText("?")
    setup!.mockInput.pressEnter()
  })
  expect(input.cursorOffset).toBe(0)
  expect(events).toEqual([])
  act(() => update(shortcut))
  act(() => setup!.mockInput.pressEnter())
  expect(events).toEqual(["change:hello!?", "submit:hello!?"])
  events.length = 0
  act(() => update(undefined))
  act(() => {
    input.gotoBufferEnd()
    input.insertText(".")
    setup!.mockInput.pressEnter()
  })
  expect(ref.current).toBe(input)
  expect(input.value).toBe("hello!?.")
  expect(events).toEqual(["change:hello!?.", "submit:hello!?."])
  act(() => input.blur())
  expect(events).toHaveLength(2)
})
