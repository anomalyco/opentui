import { afterEach, expect, it } from "bun:test"
import type { InputKeyBinding, InputRenderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { testRender } from "../index.js"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  setup?.renderer.destroy()
  await setup?.renderer.closed
  setup = undefined
})

it("preserves Input submit defaults when keyBindings props mount, change and reset", async () => {
  let input!: InputRenderable
  const events: string[] = []
  const shortcut: InputKeyBinding[] = [{ name: "x", ctrl: true, action: "line-home" }]
  const [bindings, setBindings] = createSignal<InputKeyBinding[] | undefined>(shortcut)
  setup = await testRender(
    () => (
      <input
        ref={(node) => (input = node)}
        focused
        value="hello"
        keyBindings={bindings()}
        onChange={(value) => events.push(`change:${value}`)}
        onSubmit={(value) => events.push(`submit:${value}`)}
      />
    ),
    { width: 30, height: 3 },
  )
  const original = input
  input.insertText("!")
  setup.mockInput.pressKey("x", { ctrl: true })
  expect(input.cursorOffset).toBe(0)
  setup.mockInput.pressEnter()
  expect(events).toEqual(["change:hello!", "submit:hello!"])
  events.length = 0
  setBindings([{ name: "return", action: "line-home" }])
  input.gotoBufferEnd()
  input.insertText("?")
  setup.mockInput.pressEnter()
  expect(input.cursorOffset).toBe(0)
  expect(events).toEqual([])
  setBindings(shortcut)
  setup.mockInput.pressEnter()
  expect(events).toEqual(["change:hello!?", "submit:hello!?"])
  events.length = 0
  setBindings(undefined)
  input.gotoBufferEnd()
  input.insertText(".")
  setup.mockInput.pressEnter()
  expect(input).toBe(original)
  expect(input.value).toBe("hello!?.")
  expect(events).toEqual(["change:hello!?.", "submit:hello!?."])
  input.blur()
  expect(events).toHaveLength(2)
})
