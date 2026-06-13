import { test, expect, beforeEach, afterEach, describe } from "bun:test"
import { SelectRenderable, type SelectRenderableOptions, SelectRenderableEvents, type SelectOption } from "./Select.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../testing/test-renderer.js"
import { KeyEvent } from "../lib/KeyHandler.js"

// Helper function to create a KeyEvent from a string or object
function createKeyEvent(
  input: string | { name: string; shift?: boolean; ctrl?: boolean; meta?: boolean; super?: boolean; baseCode?: number },
): KeyEvent {
  if (typeof input === "string") {
    return new KeyEvent({
      name: input,
      sequence: input,
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      number: false,
      raw: input,
      eventType: "press",
      source: "raw",
    })
  } else {
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
}

let currentRenderer: TestRenderer
let currentMockInput: MockInput
let renderOnce: () => Promise<void>
let captureCharFrame: () => string

const sampleOptions: SelectOption[] = [
  { name: "Option 1", description: "First option" },
  { name: "Option 2", description: "Second option" },
  { name: "Option 3", description: "Third option" },
  { name: "Option 4", description: "Fourth option" },
  { name: "Option 5", description: "Fifth option" },
]

async function createSelectRenderable(
  renderer: TestRenderer,
  options: SelectRenderableOptions,
): Promise<{ select: SelectRenderable; root: any }> {
  const selectRenderable = new SelectRenderable(renderer, { left: 0, top: 0, ...options })
  renderer.root.add(selectRenderable)
  await renderOnce()

  return { select: selectRenderable, root: renderer.root }
}

beforeEach(async () => {
  ;({
    renderer: currentRenderer,
    mockInput: currentMockInput,
    renderOnce,
    captureCharFrame,
  } = await createTestRenderer({}))
})

afterEach(() => {
  currentRenderer.destroy()
})

describe("SelectRenderable", () => {
  describe("Initialization", () => {
    test("should initialize with default options", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
      })

      expect(select.options).toEqual(sampleOptions)
      expect(select.getSelectedIndex()).toBe(0)
      expect(select.getSelectedOption()).toEqual(sampleOptions[0])
      expect(select.focusable).toBe(true)
      expect(select.showScrollIndicator).toBe(false)
      expect(select.showDescription).toBe(true)
      expect(select.wrapSelection).toBe(false)
    })

    test("should initialize with custom selected index", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 2,
      })

      expect(select.getSelectedIndex()).toBe(2)
      expect(select.getSelectedOption()).toEqual(sampleOptions[2])
    })

    test("should initialize with custom options", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        showScrollIndicator: true,
        showDescription: false,
        wrapSelection: true,
        itemSpacing: 1,
        fastScrollStep: 3,
      })

      expect(select.showScrollIndicator).toBe(true)
      expect(select.showDescription).toBe(false)
      expect(select.wrapSelection).toBe(true)
    })

    test("should handle empty options array", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: [],
      })

      expect(select.options).toEqual([])
      expect(select.getSelectedIndex()).toBe(0)
      expect(select.getSelectedOption()).toBe(null)
    })

    test("should clamp selectedIndex to valid range", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 10, // Out of range
      })

      expect(select.getSelectedIndex()).toBe(sampleOptions.length - 1)
      expect(select.getSelectedOption()).toEqual(sampleOptions[sampleOptions.length - 1])
    })
  })

  describe("Options Management", () => {
    test("should update options dynamically", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 2,
      })

      const newOptions: SelectOption[] = [
        { name: "New Option 1", description: "New first option" },
        { name: "New Option 2", description: "New second option" },
      ]

      select.options = newOptions

      expect(select.options).toEqual(newOptions)
      expect(select.getSelectedIndex()).toBe(1) // Should be clamped to valid index
      expect(select.getSelectedOption()).toEqual(newOptions[1])
    })

    test("should handle setting empty options", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 2,
      })

      select.options = []

      expect(select.options).toEqual([])
      expect(select.getSelectedIndex()).toBe(0)
      expect(select.getSelectedOption()).toBe(null)
    })

    test("should clear rendered option text when options are set to empty", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 24,
        height: 6,
        options: sampleOptions,
      })

      await renderOnce()
      expect(captureCharFrame()).toContain("Option 1")

      select.options = []
      await renderOnce()

      expect(captureCharFrame()).not.toContain("Option 1")
      expect(captureCharFrame()).not.toContain("Option 2")
    })

    test("should preserve valid selected index when options change", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 1,
      })

      const extendedOptions = [...sampleOptions, { name: "Option 6", description: "Sixth option" }]
      select.options = extendedOptions

      expect(select.getSelectedIndex()).toBe(1) // Should remain the same
      expect(select.getSelectedOption()).toEqual(sampleOptions[1])
    })
  })

  describe("Selection Management", () => {
    test("should set selected index programmatically", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
      })

      let selectionChangedFired = false
      let selectionIndex = -1
      let selectionOption: SelectOption | null = null

      select.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number, option: SelectOption) => {
        selectionChangedFired = true
        selectionIndex = index
        selectionOption = option
      })

      select.setSelectedIndex(3)

      expect(select.getSelectedIndex()).toBe(3)
      expect(select.getSelectedOption()).toEqual(sampleOptions[3])
      expect(selectionChangedFired).toBe(true)
      expect(selectionIndex).toBe(3)
      expect(selectionOption!).toEqual(sampleOptions[3])
    })

    test("should ignore invalid selected index", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 2,
      })

      const originalIndex = select.getSelectedIndex()
      const originalOption = select.getSelectedOption()

      select.setSelectedIndex(-1) // Invalid
      expect(select.getSelectedIndex()).toBe(originalIndex)

      select.setSelectedIndex(10) // Out of range
      expect(select.getSelectedIndex()).toBe(originalIndex)

      expect(select.getSelectedOption()).toEqual(originalOption)
    })

    test("should move up correctly", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 2,
      })

      select.moveUp()
      expect(select.getSelectedIndex()).toBe(1)

      select.moveUp()
      expect(select.getSelectedIndex()).toBe(0)

      // Should not move beyond first item without wrap
      select.moveUp()
      expect(select.getSelectedIndex()).toBe(0)
    })

    test("should move down correctly", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 2,
      })

      select.moveDown()
      expect(select.getSelectedIndex()).toBe(3)

      select.moveDown()
      expect(select.getSelectedIndex()).toBe(4)

      // Should not move beyond last item without wrap
      select.moveDown()
      expect(select.getSelectedIndex()).toBe(4)
    })

    test("should wrap selection when enabled", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        wrapSelection: true,
      })

      // Move up from first item should wrap to last
      expect(select.getSelectedIndex()).toBe(0)
      select.moveUp()
      expect(select.getSelectedIndex()).toBe(4)

      // Move down from last item should wrap to first
      select.moveDown()
      expect(select.getSelectedIndex()).toBe(0)
    })

    test("should move multiple steps", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 0,
      })

      select.moveDown(3)
      expect(select.getSelectedIndex()).toBe(3)

      select.moveUp(2)
      expect(select.getSelectedIndex()).toBe(1)
    })

    test("should select current item", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 2,
      })

      let itemSelectedFired = false
      let selectedIndex = -1
      let selectedOption: SelectOption | null = null

      select.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: SelectOption) => {
        itemSelectedFired = true
        selectedIndex = index
        selectedOption = option
      })

      select.selectCurrent()

      expect(itemSelectedFired).toBe(true)
      expect(selectedIndex).toBe(2)
      expect(selectedOption!).toEqual(sampleOptions[2])
    })

    test("should not select when no options available", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: [],
      })

      let itemSelectedFired = false

      select.on(SelectRenderableEvents.ITEM_SELECTED, () => {
        itemSelectedFired = true
      })

      select.selectCurrent()

      expect(itemSelectedFired).toBe(false)
    })
  })

  describe("Keyboard Interaction", () => {
    test("should handle up/down arrow keys", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 1,
      })

      select.focus()

      // Test down arrow
      const downHandled = select.handleKeyPress(createKeyEvent("down"))
      expect(downHandled).toBe(true)
      expect(select.getSelectedIndex()).toBe(2)

      // Test up arrow
      const upHandled = select.handleKeyPress(createKeyEvent("up"))
      expect(upHandled).toBe(true)
      expect(select.getSelectedIndex()).toBe(1)
    })

    test("should handle j/k keys (vim-style)", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 1,
      })

      select.focus()

      // Test 'j' (down)
      const jHandled = select.handleKeyPress(createKeyEvent("j"))
      expect(jHandled).toBe(true)
      expect(select.getSelectedIndex()).toBe(2)

      // Test 'k' (up)
      const kHandled = select.handleKeyPress(createKeyEvent("k"))
      expect(kHandled).toBe(true)
      expect(select.getSelectedIndex()).toBe(1)
    })

    test("should use baseCode for custom bindings from alternate layouts", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 1,
        keyBindings: [{ name: "j", action: "move-down" }],
      })

      select.focus()

      const handled = select.handleKeyPress(createKeyEvent({ name: "ㅓ", baseCode: 106 }))

      expect(handled).toBe(true)
      expect(select.getSelectedIndex()).toBe(2)
    })

    test("should handle enter key", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 2,
      })

      select.focus()

      let itemSelectedFired = false
      let selectedIndex = -1

      select.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
        itemSelectedFired = true
        selectedIndex = index
      })

      const enterHandled = select.handleKeyPress(createKeyEvent("return"))
      expect(enterHandled).toBe(true)
      expect(itemSelectedFired).toBe(true)
      expect(selectedIndex).toBe(2)
    })

    test("should handle linefeed key", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 2,
      })

      select.focus()

      let itemSelectedFired = false

      select.on(SelectRenderableEvents.ITEM_SELECTED, () => {
        itemSelectedFired = true
      })

      const linefeedHandled = select.handleKeyPress(createKeyEvent("linefeed"))
      expect(linefeedHandled).toBe(true)
      expect(itemSelectedFired).toBe(true)
    })

    test("should handle fast scroll with shift modifier", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 0,
        fastScrollStep: 3,
      })

      select.focus()

      // Test shift+down
      const shiftDownHandled = select.handleKeyPress(createKeyEvent({ name: "down", shift: true }))
      expect(shiftDownHandled).toBe(true)
      expect(select.getSelectedIndex()).toBe(3) // Should move 3 steps

      // Test shift+up
      const shiftUpHandled = select.handleKeyPress(createKeyEvent({ name: "up", shift: true }))
      expect(shiftUpHandled).toBe(true)
      expect(select.getSelectedIndex()).toBe(0) // Should move back 3 steps
    })

    test("should ignore unhandled keys", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 1,
      })

      select.focus()

      const originalIndex = select.getSelectedIndex()

      // Test unhandled key
      const handled = select.handleKeyPress(createKeyEvent("a"))
      expect(handled).toBe(false)
      expect(select.getSelectedIndex()).toBe(originalIndex)
    })
  })

  describe("Property Changes", () => {
    test("should update showScrollIndicator", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        showScrollIndicator: false,
      })

      expect(select.showScrollIndicator).toBe(false)

      select.showScrollIndicator = true
      expect(select.showScrollIndicator).toBe(true)
    })

    test("should update showDescription", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        showDescription: true,
      })

      expect(select.showDescription).toBe(true)

      select.showDescription = false
      expect(select.showDescription).toBe(false)
    })

    test("should update wrapSelection", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        wrapSelection: false,
      })

      expect(select.wrapSelection).toBe(false)

      select.wrapSelection = true
      expect(select.wrapSelection).toBe(true)
    })

    test("should update colors", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
      })

      // Test all color setters
      select.backgroundColor = "#ff0000"
      select.textColor = "#00ff00"
      select.focusedBackgroundColor = "#0000ff"
      select.focusedTextColor = "#ffff00"
      select.selectedBackgroundColor = "#ff00ff"
      select.selectedTextColor = "#00ffff"
      select.descriptionColor = "#808080"
      select.selectedDescriptionColor = "#ffffff"

      // Should not throw errors
      expect(select).toBeDefined()
    })

    test("should update font", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
      })

      select.font = "tiny"
      // Should not throw errors
      expect(select).toBeDefined()
    })

    test("should update itemSpacing", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        itemSpacing: 0,
      })

      select.itemSpacing = 2
      // Should not throw errors
      expect(select).toBeDefined()
    })

    test("should update fastScrollStep", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        fastScrollStep: 5,
      })

      select.fastScrollStep = 10
      // Should not throw errors
      expect(select).toBeDefined()
    })

    test("should update selectedIndex via setter", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 0,
      })

      select.selectedIndex = 3
      expect(select.getSelectedIndex()).toBe(3)
    })
  })

  describe("Event Emission", () => {
    test("should emit SELECTION_CHANGED when moving", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 1,
      })

      let eventCount = 0
      let lastIndex = -1
      let lastOption: SelectOption | null = null

      select.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number, option: SelectOption) => {
        eventCount++
        lastIndex = index
        lastOption = option
      })

      select.moveDown()
      expect(eventCount).toBe(1)
      expect(lastIndex).toBe(2)
      expect(lastOption!).toEqual(sampleOptions[2])

      select.moveUp()
      expect(eventCount).toBe(2)
      expect(lastIndex).toBe(1)
      expect(lastOption!).toEqual(sampleOptions[1])
    })

    test("should emit ITEM_SELECTED when selecting", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 2,
      })

      let eventCount = 0
      let lastIndex = -1
      let lastOption: SelectOption | null = null

      select.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: SelectOption) => {
        eventCount++
        lastIndex = index
        lastOption = option
      })

      select.selectCurrent()
      expect(eventCount).toBe(1)
      expect(lastIndex).toBe(2)
      expect(lastOption!).toEqual(sampleOptions[2])
    })

    test("should not reuse the same keypress after focusing another select", async () => {
      const { select: first } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 1,
      })
      const { select: second } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: [
          { name: "A", description: "A" },
          { name: "B", description: "B" },
        ],
      })

      let firstSelections = 0
      let secondSelections = 0

      first.on(SelectRenderableEvents.ITEM_SELECTED, () => {
        firstSelections++
        second.focus()
      })
      second.on(SelectRenderableEvents.ITEM_SELECTED, () => {
        secondSelections++
      })

      first.focus()
      currentMockInput.pressKey("RETURN")

      expect(firstSelections).toBe(1)
      expect(secondSelections).toBe(0)
      expect(second.focused).toBe(true)
    })

    test("should emit events even when movement is blocked", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        selectedIndex: 0, // At the beginning
        wrapSelection: false,
      })

      let eventCount = 0

      select.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
        eventCount++
      })

      // Try to move up from first item (index stays the same but event is emitted)
      select.moveUp()
      expect(eventCount).toBe(1)
      expect(select.getSelectedIndex()).toBe(0)

      // Try to move down to last item and then try to move down again
      select.setSelectedIndex(4) // Move to last item
      eventCount = 0 // Reset counter

      select.moveDown()
      expect(eventCount).toBe(1)
      expect(select.getSelectedIndex()).toBe(4) // Should stay at last item
    })
  })

  describe("Resize Handling", () => {
    test("should handle resize events", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
      })

      // Simulate resize by calling onResize directly
      // @ts-expect-error - Testing protected method
      select.onResize(30, 10)

      // Should not throw errors and should be able to continue functioning
      expect(select.getSelectedIndex()).toBe(0)
      expect(select.getSelectedOption()).toEqual(sampleOptions[0])
    })
  })

  describe("Edge Cases", () => {
    test("should handle options with undefined values", async () => {
      const optionsWithValues: SelectOption[] = [
        { name: "Option 1", description: "First option", value: "value1" },
        { name: "Option 2", description: "Second option", value: undefined },
        { name: "Option 3", description: "Third option" },
      ]

      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: optionsWithValues,
      })

      expect(select.options).toEqual(optionsWithValues)
      expect(select.getSelectedOption()?.value).toBe("value1")

      select.setSelectedIndex(1)
      expect(select.getSelectedOption()?.value).toBe(undefined)

      select.setSelectedIndex(2)
      expect(select.getSelectedOption()?.value).toBe(undefined)
    })

    test("should handle single option", async () => {
      const singleOption: SelectOption[] = [{ name: "Only Option", description: "The only choice" }]

      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: singleOption,
      })

      expect(select.getSelectedIndex()).toBe(0)
      expect(select.getSelectedOption()).toEqual(singleOption[0])

      let eventCount = 0
      select.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
        eventCount++
      })

      // Movement should not change selection but events are still emitted
      select.moveUp()
      expect(select.getSelectedIndex()).toBe(0)
      expect(eventCount).toBe(1)

      select.moveDown()
      expect(select.getSelectedIndex()).toBe(0)
      expect(eventCount).toBe(2)
    })

    test("should handle very small dimensions", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 1,
        height: 1,
        options: sampleOptions,
      })

      // Should still function even with minimal space
      expect(select.getSelectedIndex()).toBe(0)
      expect(select.getSelectedOption()).toEqual(sampleOptions[0])

      select.moveDown()
      expect(select.getSelectedIndex()).toBe(1)
    })

    test("should handle long option names and descriptions", async () => {
      const longOptions: SelectOption[] = [
        {
          name: "This is a very long option name that exceeds normal width",
          description:
            "This is an extremely long description that definitely exceeds the available width and should be handled gracefully",
        },
        {
          name: "Short",
          description: "Short desc",
        },
      ]

      const { select } = await createSelectRenderable(currentRenderer, {
        width: 10,
        height: 5,
        options: longOptions,
      })

      expect(select.getSelectedIndex()).toBe(0)
      expect(select.getSelectedOption()).toEqual(longOptions[0])

      select.moveDown()
      expect(select.getSelectedIndex()).toBe(1)
      expect(select.getSelectedOption()).toEqual(longOptions[1])
    })

    test("should handle focus state changes", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
      })

      expect(select.focused).toBe(false)

      select.focus()
      expect(select.focused).toBe(true)

      select.blur()
      expect(select.focused).toBe(false)
    })
  })

  describe("Key Bindings and Aliases", () => {
    test("should support custom key bindings", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 10,
        options: sampleOptions,
        keyBindings: [
          { name: "h", action: "move-up" },
          { name: "l", action: "move-down" },
        ],
      })

      select.focus()
      expect(select.getSelectedIndex()).toBe(0)

      // H should move up (but we're at top)
      currentMockInput.pressKey("h")
      expect(select.getSelectedIndex()).toBe(0)

      // L should move down
      currentMockInput.pressKey("l")
      expect(select.getSelectedIndex()).toBe(1)
    })

    test("should support key aliases", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 10,
        options: sampleOptions,
        keyAliasMap: {
          enter: "return",
        },
      })

      select.focus()
      select.setSelectedIndex(1)

      let itemSelected = false
      select.on(SelectRenderableEvents.ITEM_SELECTED, () => {
        itemSelected = true
      })

      currentMockInput.pressEnter()
      expect(itemSelected).toBe(true)
    })

    test("should merge custom bindings with defaults", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 10,
        options: sampleOptions,
        keyBindings: [{ name: "n", action: "move-down" }],
      })

      select.focus()
      expect(select.getSelectedIndex()).toBe(0)

      // Default binding should still work
      currentMockInput.pressArrow("down")
      expect(select.getSelectedIndex()).toBe(1)

      // Custom binding should also work
      currentMockInput.pressKey("n")
      expect(select.getSelectedIndex()).toBe(2)
    })

    test("should override default bindings with custom ones", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 10,
        options: sampleOptions,
        keyBindings: [
          { name: "k", action: "move-down" }, // Override k to move down instead of up
        ],
      })

      select.focus()
      expect(select.getSelectedIndex()).toBe(0)

      // K should now move down instead of up
      currentMockInput.pressKey("k")
      expect(select.getSelectedIndex()).toBe(1)
    })

    test("should support fast scroll with shift by default", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 10,
        options: sampleOptions,
        fastScrollStep: 3,
      })

      select.focus()
      expect(select.getSelectedIndex()).toBe(0)

      // Shift+Down should fast scroll
      currentMockInput.pressArrow("down", { shift: true })
      expect(select.getSelectedIndex()).toBe(3)
    })

    test("should allow custom bindings for fast scroll", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 10,
        options: sampleOptions,
        fastScrollStep: 2,
        keyBindings: [{ name: "down", ctrl: true, action: "move-down-fast" }],
      })

      select.focus()
      expect(select.getSelectedIndex()).toBe(0)

      // Ctrl+Down should fast scroll down
      currentMockInput.pressArrow("down", { ctrl: true })
      expect(select.getSelectedIndex()).toBe(2)
    })

    test("should allow updating key bindings dynamically", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 10,
        options: sampleOptions,
      })

      select.focus()
      expect(select.getSelectedIndex()).toBe(0)

      // Move down with default binding
      currentMockInput.pressArrow("down")
      expect(select.getSelectedIndex()).toBe(1)

      // Update bindings
      select.keyBindings = [{ name: "x", action: "move-down" }]

      // X should now move down
      currentMockInput.pressKey("x")
      expect(select.getSelectedIndex()).toBe(2)
    })

    test("should handle modifiers in custom bindings", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 10,
        options: sampleOptions,
        keyBindings: [
          { name: "n", ctrl: true, action: "move-down" },
          { name: "p", ctrl: true, action: "move-up" },
        ],
      })

      select.focus()
      select.setSelectedIndex(2)

      // Ctrl+P should move up
      currentMockInput.pressKey("p", { ctrl: true })
      expect(select.getSelectedIndex()).toBe(1)

      // Ctrl+N should move down
      currentMockInput.pressKey("n", { ctrl: true })
      expect(select.getSelectedIndex()).toBe(2)
    })
  })
})
