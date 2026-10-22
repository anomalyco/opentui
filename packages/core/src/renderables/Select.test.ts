import { test, expect, beforeEach, afterEach, describe } from "bun:test"
import { SelectRenderable, type SelectRenderableOptions, SelectRenderableEvents, type SelectOption } from "./Select.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../testing/test-renderer.js"

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

    test("should scroll an initial off-screen selection into view", async () => {
      const options: SelectOption[] = Array.from({ length: 20 }, (_, index) => ({
        name: `Item ${index}`,
        description: "",
      }))

      await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options,
        selectedIndex: 12,
        showDescription: false,
        showScrollIndicator: true,
      })

      const frame = captureCharFrame().split("\n")
      expect(frame.some((line) => line.includes("▶ Item 12"))).toBe(true)
      expect(frame.findIndex((line) => line.includes("█"))).toBe(3)
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

  describe("Selection Indicator", () => {
    test("should hide the indicator and reclaim its gutter", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        showDescription: false,
        showSelectionIndicator: false,
      })

      expect(select.showSelectionIndicator).toBe(false)
      expect(captureCharFrame().split("\n")[0].startsWith(" Option 1")).toBe(true)
    })

    test("should restore the default when reset", async () => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: sampleOptions,
        showDescription: false,
        showSelectionIndicator: false,
      })

      select.showSelectionIndicator = undefined
      await renderOnce()

      expect(select.showSelectionIndicator).toBe(true)
      expect(captureCharFrame().split("\n")[0].startsWith(" ▶ Option 1")).toBe(true)
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

  describe("Scroll Indicator", () => {
    const manyOptions: SelectOption[] = Array.from({ length: 20 }, (_, index) => ({
      name: `Item ${index}`,
      description: "",
    }))

    test.each([
      { selectedIndex: 0, expectedRow: 1 },
      { selectedIndex: 2, expectedRow: 1 },
      { selectedIndex: 7, expectedRow: 2 },
      { selectedIndex: 12, expectedRow: 3 },
      { selectedIndex: 17, expectedRow: 4 },
      { selectedIndex: 19, expectedRow: 4 },
    ])("renders the viewport position for selected index $selectedIndex", async ({ selectedIndex, expectedRow }) => {
      const { select } = await createSelectRenderable(currentRenderer, {
        width: 20,
        height: 5,
        options: manyOptions,
        showScrollIndicator: true,
        showDescription: false,
      })

      select.setSelectedIndex(selectedIndex)
      await renderOnce()

      const indicatorRow = captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("█"))
      expect(indicatorRow).toBe(expectedRow)
    })
  })

  describe("Event Emission", () => {
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
})
