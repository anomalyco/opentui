import { afterEach, expect, it } from "bun:test"
import { BoxRenderable, InputRenderable, TextareaRenderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { createSignal, For } from "solid-js"
import { testRender, type InputProps } from "../index.js"

let setup: Awaited<ReturnType<typeof testRender>>
afterEach(async () => {
  setup?.renderer.destroy()
  await setup?.renderer.closed
})

it("preserves editor state through keyed moves and defers disposal of removed editors", async () => {
  const [state, update] = createSignal({ value: "seed", items: ["textarea", "input"], styled: true })
  let box!: BoxRenderable
  let textarea!: TextareaRenderable
  let input!: InputRenderable
  const style = () => (state().styled ? { selectionOccupancy: "boundary" as const } : {})
  setup = await testRender(
    () => (
      <box ref={box}>
        <For each={state().items}>
          {(item) =>
            item === "textarea" ? (
              <textarea ref={textarea} initialValue={state().value} height={1} style={style()} />
            ) : (
              <input ref={input} value={state().value} style={style()} />
            )
          }
        </For>
      </box>
    ),
    { width: 16, height: 3, clock: new ManualClock() },
  )
  const original = [input, textarea]
  expect(textarea.selectionOccupancy).toBe("boundary")
  textarea.gotoBufferEnd()
  textarea.insertText("!")
  update({ value: "next", items: ["input", "textarea"], styled: false })
  await setup.renderOnce()
  expect(box.getChildren()).toEqual(original)
  expect(textarea.plainText).toBe("seed!")
  expect(input.value).toBe("next")
  expect(textarea.selectionOccupancy).toBe("cell")
  expect(setup.captureCharFrame()).toContain("seed!")
  textarea.undo()
  expect(textarea.plainText).toBe("seed")
  update({ value: "next", items: ["input"], styled: false })
  expect(textarea.parent).toBeNull()
  expect(textarea.isDestroyed).toBe(false)
  await new Promise<void>((resolve) => process.nextTick(resolve))
  expect(textarea.isDestroyed).toBe(true)
  expect(input.isDestroyed).toBe(false)
  setup.renderer.destroy()
  await setup.renderer.closed
  expect(input.isDestroyed).toBe(true)
})

it("replaces controlled Input handlers without duplicates and respects cancelled JSX events", async () => {
  const [value, setValue] = createSignal("")
  const [version, replace] = createSignal(0)
  const events: string[] = []
  let input!: InputRenderable
  const handlers = (): Pick<InputProps, "onInput" | "onChange" | "onSubmit"> => {
    const current = version()
    return {
      onInput: (next) => {
        events.push(`${current}:input:${next}`)
        setValue(next)
      },
      onChange: (next) => events.push(`${current}:change:${next}`),
      onSubmit: (next) => events.push(`${current}:submit:${next}`),
    }
  }
  setup = await testRender(
    () => (
      <input
        ref={input}
        focused
        value={value()}
        onKeyDown={(event) => {
          if (event.name === "x") event.preventDefault()
        }}
        onPaste={(event) => event.preventDefault()}
        {...handlers()}
      />
    ),
    { width: 16, height: 2, clock: new ManualClock() },
  )
  const original = input
  await setup.mockInput.typeText("xa")
  await setup.mockInput.pasteBracketedText("blocked")
  replace(1)
  await setup.mockInput.typeText("b")
  setup.mockInput.pressEnter()
  expect(events).toEqual(["0:input:a", "1:input:ab", "1:change:ab", "1:submit:ab"])
  expect(input).toBe(original)
  expect(value()).toBe("ab")
  input.blur()
  expect(events).toHaveLength(4)
})
