import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import {
  TabSelectRenderable,
  type TabSelectRenderableOptions,
  TabSelectRenderableEvents,
  type TabSelectOption,
} from "./TabSelect.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../testing/test-renderer.js"
import { KeyEvent } from "../lib/KeyHandler.js"
import { ManualClock } from "../testing/manual-clock.js"

function createKeyEvent(input: {
  name: string
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
  super?: boolean
  baseCode?: number
}): KeyEvent {
  return new KeyEvent({
    name: input.name,
    sequence: input.name === "space" ? " " : input.name,
    ctrl: input.ctrl ?? false,
    meta: input.meta ?? false,
    shift: input.shift ?? false,
    super: input.super ?? false,
    baseCode: input.baseCode,
    option: false,
    number: false,
    raw: input.name,
    eventType: "press",
    source: "raw",
  })
}

let currentRenderer: TestRenderer
let currentMockInput: MockInput
let renderOnce: () => Promise<void>
let captureCharFrame: () => string
let currentClock: ManualClock

const sampleOptions: TabSelectOption[] = [
  { name: "Tab 1", description: "First tab" },
  { name: "Tab 2", description: "Second tab" },
  { name: "Tab 3", description: "Third tab" },
  { name: "Tab 4", description: "Fourth tab" },
  { name: "Tab 5", description: "Fifth tab" },
]

async function createTabSelectRenderable(
  renderer: TestRenderer,
  options: TabSelectRenderableOptions,
): Promise<{ tabSelect: TabSelectRenderable; root: any }> {
  const tabSelectRenderable = new TabSelectRenderable(renderer, { left: 0, top: 0, ...options })
  renderer.root.add(tabSelectRenderable)
  await renderOnce()

  return { tabSelect: tabSelectRenderable, root: renderer.root }
}

beforeEach(async () => {
  currentClock = new ManualClock()
  ;({
    renderer: currentRenderer,
    mockInput: currentMockInput,
    renderOnce,
    captureCharFrame,
  } = await createTestRenderer({
    clock: currentClock,
  }))
})

afterEach(() => {
  currentRenderer.destroy()
})

describe("TabSelectRenderable", () => {
  describe("Key Bindings and Aliases", () => {
    test("should support custom key bindings", async () => {
      const { tabSelect } = await createTabSelectRenderable(currentRenderer, {
        width: 100,
        options: sampleOptions,
        keyBindings: [
          { name: "h", action: "move-left" },
          { name: "l", action: "move-right" },
        ],
      })

      tabSelect.focus()
      expect(tabSelect.getSelectedIndex()).toBe(0)

      // L should move right
      currentMockInput.pressKey("l")
      expect(tabSelect.getSelectedIndex()).toBe(1)

      // H should move left
      currentMockInput.pressKey("h")
      expect(tabSelect.getSelectedIndex()).toBe(0)
    })

    test("should use baseCode for custom key bindings from alternate layouts", async () => {
      const { tabSelect } = await createTabSelectRenderable(currentRenderer, {
        width: 100,
        options: sampleOptions,
        keyBindings: [{ name: "l", action: "move-right" }],
      })

      tabSelect.focus()
      expect(tabSelect.getSelectedIndex()).toBe(0)

      const handled = tabSelect.handleKeyPress(createKeyEvent({ name: "ㅣ", baseCode: 108 }))

      expect(handled).toBe(true)
      expect(tabSelect.getSelectedIndex()).toBe(1)
    })

    test("should support key aliases", async () => {
      const { tabSelect } = await createTabSelectRenderable(currentRenderer, {
        width: 100,
        options: sampleOptions,
        keyAliasMap: {
          enter: "return",
        },
      })

      tabSelect.focus()
      tabSelect.setSelectedIndex(1)

      let itemSelected = false
      tabSelect.on(TabSelectRenderableEvents.ITEM_SELECTED, () => {
        itemSelected = true
      })

      currentMockInput.pressEnter()
      expect(itemSelected).toBe(true)
    })

    test("should merge custom bindings with defaults", async () => {
      const { tabSelect } = await createTabSelectRenderable(currentRenderer, {
        width: 100,
        options: sampleOptions,
        keyBindings: [{ name: "n", action: "move-right" }],
      })

      tabSelect.focus()
      expect(tabSelect.getSelectedIndex()).toBe(0)

      // Default binding should still work
      currentMockInput.pressArrow("right")
      expect(tabSelect.getSelectedIndex()).toBe(1)

      // Custom binding should also work
      currentMockInput.pressKey("n")
      expect(tabSelect.getSelectedIndex()).toBe(2)
    })

    test("should override default bindings with custom ones", async () => {
      const { tabSelect } = await createTabSelectRenderable(currentRenderer, {
        width: 100,
        options: sampleOptions,
        keyBindings: [
          { name: "[", action: "move-right" }, // Override [ to move right instead of left
        ],
      })

      tabSelect.focus()
      expect(tabSelect.getSelectedIndex()).toBe(0)

      currentMockInput.pressKey("[")
      currentClock.advance(10)
      expect(tabSelect.getSelectedIndex()).toBe(1)
    })

    test("should allow updating key bindings dynamically", async () => {
      const { tabSelect } = await createTabSelectRenderable(currentRenderer, {
        width: 100,
        options: sampleOptions,
      })

      tabSelect.focus()
      expect(tabSelect.getSelectedIndex()).toBe(0)

      // Move right with default binding
      currentMockInput.pressArrow("right")
      expect(tabSelect.getSelectedIndex()).toBe(1)

      // Update bindings
      tabSelect.keyBindings = [{ name: "space", action: "move-right" }]

      // Space should now move right
      currentMockInput.pressKey(" ")
      expect(tabSelect.getSelectedIndex()).toBe(2)
    })

    test("should handle modifiers in custom bindings", async () => {
      const { tabSelect } = await createTabSelectRenderable(currentRenderer, {
        width: 100,
        options: sampleOptions,
        keyBindings: [
          { name: "left", ctrl: true, action: "move-right" },
          { name: "right", ctrl: true, action: "move-left" },
        ],
      })

      tabSelect.focus()
      tabSelect.setSelectedIndex(2)

      // Ctrl+Right should move left
      currentMockInput.pressArrow("right", { ctrl: true })
      expect(tabSelect.getSelectedIndex()).toBe(1)

      // Ctrl+Left should move right
      currentMockInput.pressArrow("left", { ctrl: true })
      expect(tabSelect.getSelectedIndex()).toBe(2)
    })

    test("should handle wrap selection with custom bindings", async () => {
      const { tabSelect } = await createTabSelectRenderable(currentRenderer, {
        width: 100,
        options: sampleOptions,
        wrapSelection: true,
        keyBindings: [
          { name: "n", action: "move-right" },
          { name: "p", action: "move-left" },
        ],
      })

      tabSelect.focus()
      expect(tabSelect.getSelectedIndex()).toBe(0)

      // P should wrap to end
      currentMockInput.pressKey("p")
      expect(tabSelect.getSelectedIndex()).toBe(4)

      // N should wrap to start
      currentMockInput.pressKey("n")
      expect(tabSelect.getSelectedIndex()).toBe(0)
    })
  })

  describe("Underline", () => {
    test("should render the default underline character under the selected tab", async () => {
      const { tabSelect } = await createTabSelectRenderable(currentRenderer, {
        width: 100,
        options: sampleOptions,
      })

      const underlineRow = captureCharFrame().split("\n")[1]
      expect(underlineRow.startsWith("▂".repeat(tabSelect.tabWidth))).toBe(true)
    })

    test("should render a custom underline character", async () => {
      const { tabSelect } = await createTabSelectRenderable(currentRenderer, {
        width: 100,
        options: sampleOptions,
        underlineChar: "▃",
      })

      let underlineRow = captureCharFrame().split("\n")[1]
      expect(underlineRow.startsWith("▃".repeat(tabSelect.tabWidth))).toBe(true)

      tabSelect.underlineChar = "─"
      await renderOnce()

      underlineRow = captureCharFrame().split("\n")[1]
      expect(underlineRow.startsWith("─".repeat(tabSelect.tabWidth))).toBe(true)
    })
  })
})
