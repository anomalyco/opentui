import { afterEach, describe, expect, it } from "bun:test"
import { InputRenderable, InputRenderableEvents, type InputKeyBinding } from "./Input.js"
import { TextareaRenderable } from "./Textarea.js"
import { setRenderableProp } from "./props.js"
import { createTestRenderer } from "../testing/test-renderer.js"

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined
afterEach(async () => {
  setup?.renderer.destroy()
  await setup?.renderer.closed
  setup = undefined
})

const shortcut: InputKeyBinding[] = [{ name: "x", ctrl: true, action: "line-home" }]
const replacements: [string, InputKeyBinding[] | null | undefined][] = [
  ["custom bindings", shortcut],
  ["empty bindings", []],
  ["null reset", null],
  ["undefined reset", undefined],
]
const enterKeys = [
  ["return", "\r"],
  ["linefeed", "\n"],
  ["kpenter", "\x1b[57414u"],
] as const

for (const [key, sequence] of enterKeys) {
  describe(`Input ${key} bindings`, () => {
    it.each(replacements)("submits after replacing with %s", async (_name, bindings) => {
      setup = await createTestRenderer({ width: 30, height: 3, kittyKeyboard: true })
      const input = new InputRenderable(setup.renderer, {
        value: "hello",
        keyBindings: [{ name: key, action: "line-home" }],
      })
      setup.renderer.root.add(input)
      input.focus()
      const events: string[] = []
      input.on(InputRenderableEvents.CHANGE, (value) => events.push(`change:${value}`))
      input.on(InputRenderableEvents.ENTER, (value) => events.push(`submit:${value}`))
      input.insertText("!")
      input.keyBindings = bindings
      if (bindings === shortcut) {
        setup.mockInput.pressKey("x", { ctrl: true })
        expect(input.cursorOffset).toBe(0)
      }
      await setup.mockInput.pressKeys([sequence])
      expect(input.value).toBe("hello!")
      expect(events).toEqual(["change:hello!", "submit:hello!"])
      input.blur()
      expect(events).toHaveLength(2)
    })

    it("keeps explicit overrides through alias-map replacement", async () => {
      setup = await createTestRenderer({ width: 30, height: 3, kittyKeyboard: true })
      const input = new InputRenderable(setup.renderer, { value: "hello" })
      setup.renderer.root.add(input)
      input.focus()
      const events: string[] = []
      input.on(InputRenderableEvents.CHANGE, (value) => events.push(`change:${value}`))
      input.on(InputRenderableEvents.ENTER, (value) => events.push(`submit:${value}`))
      input.insertText("!")
      input.keyBindings = [{ name: "accept", action: "line-home" }]
      input.keyAliasMap = { accept: key }
      await setup.mockInput.pressKeys([sequence])
      expect(input.value).toBe("hello!")
      expect(input.cursorOffset).toBe(0)
      expect(events).toEqual([])
      input.keyBindings = undefined
      input.keyAliasMap = {}
      await setup.mockInput.pressKeys([sequence])
      expect(events).toEqual(["change:hello!", "submit:hello!"])
    })

    it("keeps Textarea multiline defaults after replacement", async () => {
      setup = await createTestRenderer({ width: 30, height: 3, kittyKeyboard: true })
      const textarea = new TextareaRenderable(setup.renderer, { initialValue: "hello", height: 3 })
      setup.renderer.root.add(textarea)
      textarea.focus()
      textarea.gotoBufferEnd()
      textarea.keyBindings = shortcut
      await setup.mockInput.pressKeys([sequence])
      expect(textarea.plainText).toBe("hello\n")
    })
  })
}

it("retains modifier-specific submit bindings and mapped prop resets", async () => {
  setup = await createTestRenderer({ width: 30, height: 3, kittyKeyboard: true })
  const input = new InputRenderable(setup.renderer, { value: "hello" })
  setup.renderer.root.add(input)
  input.focus()
  const submitted: string[] = []
  input.on(InputRenderableEvents.ENTER, (value) => submitted.push(value))
  input.keyBindings = [
    { name: "return", action: "line-home" },
    { name: "return", ctrl: true, action: "submit" },
    { name: "s", ctrl: true, action: "submit" },
  ]
  setup.mockInput.pressEnter()
  expect(input.cursorOffset).toBe(0)
  expect(submitted).toEqual([])
  setup.mockInput.pressKey("RETURN", { ctrl: true })
  setup.mockInput.pressKey("s", { ctrl: true })
  expect(submitted).toEqual(["hello", "hello"])
  setRenderableProp(input, "keyBindings", shortcut, undefined)
  setRenderableProp(input, "keyBindings", undefined, shortcut)
  setup.mockInput.pressKey("RETURN", { ctrl: true })
  expect(submitted).toHaveLength(2)
  setup.mockInput.pressEnter()
  expect(submitted).toEqual(["hello", "hello", "hello"])
  expect(input.value).toBe("hello")
  expect(input.keyBindings).toBeUndefined()
})
