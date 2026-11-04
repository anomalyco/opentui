import { afterEach, expect, it } from "bun:test"
import { BoxRenderable, InputRenderable, TextareaRenderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { act, createRef, useState } from "react"
import { testRender } from "../src/test-utils.js"

let setup: Awaited<ReturnType<typeof testRender>>
afterEach(async () => {
  act(() => setup?.renderer.destroy())
  await setup?.renderer.closed
})

it("preserves editor state through keyed moves and destroys only removed editors", async () => {
  const boxRef = createRef<BoxRenderable>()
  const textareaRef = createRef<TextareaRenderable>()
  const inputRef = createRef<InputRenderable>()
  let update!: (state: { value: string; items: string[]; styled: boolean }) => void
  function App() {
    const [state, setState] = useState({ value: "seed", items: ["textarea", "input"], styled: true })
    update = setState
    const style = state.styled ? { selectionOccupancy: "boundary" as const } : {}
    return (
      <box ref={boxRef}>
        {state.items.map((item) =>
          item === "textarea" ? (
            <textarea key={item} ref={textareaRef} initialValue={state.value} height={1} style={style} />
          ) : (
            <input key={item} ref={inputRef} value={state.value} style={style} />
          ),
        )}
      </box>
    )
  }
  setup = await testRender(<App />, { width: 16, height: 3, clock: new ManualClock() })
  const textarea = textareaRef.current!
  const input = inputRef.current!
  expect(textarea.selectionOccupancy).toBe("boundary")
  textarea.gotoBufferEnd()
  textarea.insertText("!")
  act(() => update({ value: "next", items: ["input", "textarea"], styled: false }))
  await setup.renderOnce()
  expect(boxRef.current!.getChildren()).toEqual([input, textarea])
  expect(textarea.plainText).toBe("seed!")
  expect(input.value).toBe("next")
  expect(textarea.selectionOccupancy).toBe("cell")
  expect(setup.captureCharFrame()).toContain("seed!")
  textarea.undo()
  expect(textarea.plainText).toBe("seed")
  act(() => update({ value: "next", items: ["input"], styled: false }))
  expect(textareaRef.current).toBeNull()
  expect(textarea.isDestroyed).toBe(true)
  expect(input.isDestroyed).toBe(false)
  act(() => setup.renderer.destroy())
  await setup.renderer.closed
  expect(inputRef.current).toBeNull()
  expect(input.isDestroyed).toBe(true)
})

it("replaces controlled Input handlers without duplicates and respects cancelled JSX events", async () => {
  const ref = createRef<InputRenderable>()
  const events: string[] = []
  let replace!: (version: number) => void
  function App() {
    const [value, setValue] = useState("")
    const [version, setVersion] = useState(0)
    replace = setVersion
    return (
      <input
        ref={ref}
        focused
        value={value}
        onKeyDown={(event) => {
          if (event.name === "x") event.preventDefault()
        }}
        onPaste={(event) => event.preventDefault()}
        onInput={(next) => {
          events.push(`${version}:input:${next}`)
          setValue(next)
        }}
        onChange={(next) => events.push(`${version}:change:${next}`)}
        onSubmit={(next) => events.push(`${version}:submit:${next}`)}
      />
    )
  }
  setup = await testRender(<App />, { width: 16, height: 2, clock: new ManualClock() })
  const input = ref.current!
  await act(async () => setup.mockInput.typeText("xa"))
  await act(async () => setup.mockInput.pasteBracketedText("blocked"))
  act(() => replace(1))
  await act(async () => setup.mockInput.typeText("b"))
  act(() => setup.mockInput.pressEnter())
  expect(events).toEqual(["0:input:a", "1:input:ab", "1:change:ab", "1:submit:ab"])
  expect(ref.current).toBe(input)
  expect(input.value).toBe("ab")
  act(() => input.blur())
  expect(events).toHaveLength(4)
})
