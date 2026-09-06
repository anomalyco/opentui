import { expect, test } from "bun:test"
import { InputRenderable, Renderable, SelectRenderable } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"

test("browser filtering and demo return restore focus, listeners, and owned nodes", async () => {
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const stdinListeners = process.stdin.listenerCount("data")
  const { ExampleSelector } = await import("./index.js")
  expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
  expect(process.stdin.listenerCount("data")).toBe(stdinListeners)
  const clock = new ManualClock()
  const target = await createTestRenderer({ width: 110, height: 40, exitOnCtrlC: false, clock })
  const { renderer, mockInput } = target
  try {
    await renderer.setupTerminal()
    new ExampleSelector(renderer)
    const menu = renderer.root.findDescendantById("example-menu-container")!
    const input = renderer.root.findDescendantById("example-index-filter-input") as InputRenderable
    const select = renderer.root.findDescendantById("example-selector") as SelectRenderable
    const menuRegistered = new Set(Renderable.renderablesByNumber.keys())
    const keys = renderer.keyInput.listeners("keypress")
    expect(renderer.currentFocusedRenderable).toBe(input)
    await mockInput.typeText("no such browser example")
    await target.renderOnce()
    expect(target.captureCharFrame()).toContain("No matching examples")
    mockInput.pressEnter()
    expect(menu.visible).toBe(true)
    input.value = ""
    await mockInput.typeText("Input Demo")
    expect(
      select.options.filter((option) => option.value.kind === "example").map((option) => option.value.example.name),
    ).toEqual(["Input Demo"])
    mockInput.pressTab()
    expect(renderer.currentFocusedRenderable).toBe(select)
    mockInput.pressEnter()
    await target.waitFor(() => renderer.currentFocusedRenderable?.id === "name-input")
    const name = renderer.currentFocusedRenderable!
    expect(menu.visible).toBe(false)
    mockInput.pressEscape()
    clock.advance(20)
    await target.waitFor(() => menu.visible && renderer.currentFocusedRenderable === input)
    expect(name.isDestroyed).toBe(true)
    expect(input.value).toBe("")
    expect(renderer.keyInput.listeners("keypress")).toEqual(keys)
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(menuRegistered)
    mockInput.pressCtrlC()
    await renderer.closed
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
