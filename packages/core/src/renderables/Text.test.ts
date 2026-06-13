import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { TextRenderable, type TextOptions } from "./Text.js"
import { TextNodeRenderable } from "./TextNode.js"
import { RGBA } from "../lib/RGBA.js"
import { stringToStyledText, StyledText } from "../lib/styled-text.js"
import { createTestRenderer, type MockMouse, type TestRenderer } from "../testing/test-renderer.js"
import { BoxRenderable } from "./Box.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMouse: MockMouse
let captureFrame: () => string
let resize: (width: number, height: number) => void

async function createTextRenderable(
  renderer: TestRenderer,
  options: TextOptions,
): Promise<{ text: TextRenderable; root: any }> {
  const textRenderable = new TextRenderable(renderer, { left: 0, top: 0, ...options })
  renderer.root.add(textRenderable)
  await renderOnce()

  return { text: textRenderable, root: renderer.root }
}

describe("TextRenderable Selection", () => {
  describe("Native getSelectedText", () => {
    it("should use native implementation", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello World",
        selectable: true,
      })

      await currentMouse.drag(text.x, text.y, text.x + 5, text.y)
      await renderOnce()

      const selectedText = text.getSelectedText()
      expect(selectedText).toBe("Hello")
    })

    it("should handle graphemes correctly", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello 🌍 World",
        selectable: true,
      })

      // Select "Hello 🌍" (7 characters: H,e,l,l,o, ,🌍)
      await currentMouse.drag(text.x, text.y, text.x + 7, text.y)
      await renderOnce()

      const selectedText = text.getSelectedText()
      expect(selectedText).toBe("Hello 🌍")
    })
  })

  beforeEach(async () => {
    ;({
      renderer: currentRenderer,
      renderOnce,
      mockMouse: currentMouse,
      captureCharFrame: captureFrame,
      resize,
    } = await createTestRenderer({
      width: 20,
      height: 5,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  describe("Initialization", () => {
    it("should initialize properly", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello World",
        selectable: true,
      })

      expect(text.x).toBeDefined()
      expect(text.y).toBeDefined()
      expect(text.width).toBeGreaterThan(0)
      expect(text.height).toBeGreaterThan(0)
    })
  })

  describe("Basic Selection Flow", () => {
    it("should handle selection from start to end", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello World",
        selectable: true,
      })

      expect(text.hasSelection()).toBe(false)
      expect(text.getSelection()).toBe(null)
      expect(text.getSelectedText()).toBe("")

      expect(text.shouldStartSelection(6, 0)).toBe(true)

      await currentMouse.drag(text.x + 6, text.y, text.x + 11, text.y)
      await renderOnce()

      expect(text.hasSelection()).toBe(true)

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      expect(selection!.start).toBe(6)
      expect(selection!.end).toBe(11)

      expect(text.getSelectedText()).toBe("World")
    })

    it("should handle selection with newline characters", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Line 1\nLine 2\nLine 3",
        selectable: true,
      })

      // Select from middle of line 2 to middle of line 3
      await currentMouse.drag(text.x + 2, text.y + 1, text.x + 4, text.y + 2)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      // With newline-aware offsets: Line 0 (0-5) + newline (6) + Line 1 starts at 7
      // Position "n" in "Line 2" is at 7 + 2 = 9
      expect(selection!.start).toBe(9)
      // Line 2 starts at 14, position after "Line" is 14 + 4 = 18
      expect(selection!.end).toBe(18)

      expect(text.getSelectedText()).toBe("ne 2\nLine")
    })

    it("should handle selection across empty lines", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Line 1\nLine 2\n\nLine 4",
        selectable: true,
      })

      // Select from start of line 1 to position 2 on empty line 3
      await currentMouse.drag(text.x, text.y, text.x + 2, text.y + 2)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      // With newline-aware offsets: Line 0 (0-5) + newline (6) + Line 1 (7-12) + newline (13) + Line 2 empty (14)
      // Selecting to (col=2, row=2) on empty line clamps to col=0, so end=14.
      // The range includes the line break before the empty logical line.
      expect(selection!.start).toBe(0)
      expect(selection!.end).toBe(14)
      expect(text.getSelectedText()).toBe("Line 1\nLine 2\n")
    })

    it("should handle selection ending in empty line", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Line 1\n\nLine 3",
        selectable: true,
      })

      // Select from start of line 1 into the empty line 2
      await currentMouse.drag(text.x, text.y, text.x + 3, text.y + 1)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      // With newline-aware offsets: Line 0 (0-5) + newline (6) + Line 1 empty (7)
      // Selecting to (col=3, row=1) on empty line clamps to col=0, so end=7.
      // The range includes the line break before the empty logical line.
      expect(selection!.start).toBe(0)
      expect(selection!.end).toBe(7)
      expect(text.getSelectedText()).toBe("Line 1\n")
    })

    it("should handle selection spanning multiple lines completely", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "First\nSecond\nThird",
        selectable: true,
      })

      // Select from start of line 1 to end of line 2 (actually selecting Second)
      await currentMouse.drag(text.x, text.y + 1, text.x + 6, text.y + 1)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      expect(text.getSelectedText()).toBe("Second")
    })

    it("should handle selection including multiple line breaks", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "A\nB\nC\nD",
        selectable: true,
      })

      // Select from middle of first line to middle of last line
      await currentMouse.drag(text.x, text.y + 1, text.x + 1, text.y + 2)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      const selectedText = text.getSelectedText()
      expect(selectedText).toContain("\n")
      expect(selectedText).toContain("B")
      expect(selectedText).toContain("C")
    })

    it("should handle selection that includes line breaks at boundaries", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Line1\nLine2\nLine3",
        selectable: true,
      })

      // Select across line boundaries
      await currentMouse.drag(text.x + 4, text.y, text.x + 2, text.y + 1)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      const selectedText = text.getSelectedText()
      expect(selectedText).toContain("1")
      expect(selectedText).toContain("\n")
      expect(selectedText).toContain("Li")
    })

    it("should handle reverse selection (end before start)", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello World",
        selectable: true,
      })

      await currentMouse.drag(text.x + 11, text.y, text.x + 6, text.y)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      expect(selection!.start).toBe(6)
      expect(selection!.end).toBe(11)

      expect(text.getSelectedText()).toBe("World")
    })
  })

  describe("Selection Edge Cases", () => {
    it("should handle empty text", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      await currentMouse.drag(text.x, text.y, text.x, text.y)
      await renderOnce()

      expect(text.hasSelection()).toBe(false)
      expect(text.getSelection()).toBe(null)
      expect(text.getSelectedText()).toBe("")
    })

    it("should handle single character selection", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "A",
        selectable: true,
      })

      await currentMouse.drag(text.x, text.y, text.x + 1, text.y)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      expect(selection!.start).toBe(0)
      expect(selection!.end).toBe(1)

      expect(text.getSelectedText()).toBe("A")
    })

    it("should handle zero-width selection", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello World",
        selectable: true,
      })

      await currentMouse.drag(text.x + 5, text.y, text.x + 5, text.y)
      await renderOnce()

      expect(text.hasSelection()).toBe(false)
      expect(text.getSelection()).toBe(null)
      expect(text.getSelectedText()).toBe("")
    })

    it("should handle selection beyond text bounds", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hi",
        selectable: true,
      })

      await currentMouse.drag(text.x, text.y, text.x + 10, text.y)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      expect(selection!.start).toBe(0)
      expect(selection!.end).toBe(2)

      expect(text.getSelectedText()).toBe("Hi")
    })
  })

  describe("Selection with Styled Text", () => {
    it("should handle styled text selection", async () => {
      const styledText = stringToStyledText("Hello World")
      styledText.chunks[0].fg = RGBA.fromValues(1, 0, 0, 1) // Red text

      const { text } = await createTextRenderable(currentRenderer, {
        content: styledText,
        selectable: true,
      })

      await currentMouse.drag(text.x + 6, text.y, text.x + 11, text.y)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      expect(selection!.start).toBe(6)
      expect(selection!.end).toBe(11)

      expect(text.getSelectedText()).toBe("World")
    })

    it("should handle selection with different text colors", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Red and Blue",
        selectable: true,
        selectionBg: RGBA.fromValues(1, 1, 0, 1),
        selectionFg: RGBA.fromValues(0, 0, 0, 1),
      })

      await currentMouse.drag(text.x + 8, text.y, text.x + 12, text.y)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      expect(selection!.start).toBe(8)
      expect(selection!.end).toBe(12)

      expect(text.getSelectedText()).toBe("Blue")
    })
  })

  describe("Selection State Management", () => {
    it("should clear selection when selection is cleared", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello World",
        selectable: true,
      })

      await currentMouse.drag(text.x + 6, text.y, text.x + 11, text.y)
      await renderOnce()
      expect(text.hasSelection()).toBe(true)

      currentRenderer.clearSelection()
      await renderOnce()

      expect(text.hasSelection()).toBe(false)
      expect(text.getSelection()).toBe(null)
      expect(text.getSelectedText()).toBe("")
    })

    it("should handle multiple selection changes", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello World Test",
        selectable: true,
      })

      await currentMouse.drag(text.x + 0, text.y, text.x + 5, text.y)
      await renderOnce()
      expect(text.getSelectedText()).toBe("Hello")
      expect(text.getSelection()).toEqual({ start: 0, end: 5 })

      await currentMouse.drag(text.x + 6, text.y, text.x + 11, text.y)
      await renderOnce()
      expect(text.getSelectedText()).toBe("World")
      expect(text.getSelection()).toEqual({ start: 6, end: 11 })

      await currentMouse.drag(text.x + 12, text.y, text.x + 16, text.y)
      await renderOnce()
      expect(text.getSelectedText()).toBe("Test")
      expect(text.getSelection()).toEqual({ start: 12, end: 16 })
    })
  })

  describe("shouldStartSelection", () => {
    it("should return false for non-selectable text", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello World",
        selectable: false,
      })

      expect(text.shouldStartSelection(0, 0)).toBe(false)
      expect(text.shouldStartSelection(5, 0)).toBe(false)
    })

    it("should return true for selectable text within bounds", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello World",
        selectable: true,
      })

      expect(text.shouldStartSelection(0, 0)).toBe(true) // Start of text
      expect(text.shouldStartSelection(5, 0)).toBe(true) // Middle of text
      expect(text.shouldStartSelection(10, 0)).toBe(true) // End of text
    })

    it("should handle shouldStartSelection with multi-line text", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Line 1\nLine 2\nLine 3",
        selectable: true,
      })

      expect(text.shouldStartSelection(0, 0)).toBe(true) // Line 1 start
      expect(text.shouldStartSelection(2, 1)).toBe(true) // Line 2 middle
      expect(text.shouldStartSelection(5, 2)).toBe(true) // Line 3 end
    })
  })

  describe("Selection with Custom Dimensions", () => {
    it("should handle selection in constrained width", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "This is a very long text that should wrap to multiple lines",
        width: 10,
        selectable: true,
      })

      await currentMouse.drag(text.x, text.y, text.x + 10, text.y + 2)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      expect(selection!.start).toBeGreaterThanOrEqual(0)
      expect(selection!.end).toBeGreaterThan(selection!.start)
      expect(text.getSelectedText().length).toBeGreaterThan(0)
    })
  })

  describe("Cross-Renderable Selection in Nested Boxes", () => {
    it("should handle selection across multiple nested text renderables in boxes", async () => {
      const { text: statusText } = await createTextRenderable(currentRenderer, {
        content: "Selected 5 chars:",
        selectable: true,
        fg: "#f0f6fc",
        top: 0,
      })

      const { text: selectionStartText } = await createTextRenderable(currentRenderer, {
        content: '"Hello"',
        selectable: true,
        fg: "#7dd3fc",
        top: 1,
      })

      const { text: selectionMiddleText } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
        fg: "#94a3b8",
        top: 2,
      })

      const { text: selectionEndText } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
        fg: "#7dd3fc",
        top: 3,
      })

      const { text: debugText } = await createTextRenderable(currentRenderer, {
        content: "Selected renderables: 2/5",
        selectable: true,
        fg: "#e6edf3",
        top: 4,
      })

      // Simulate starting selection above the box and ending below/right of the box
      // This should cover all renderables in the "box"
      const allRenderables = [statusText, selectionStartText, selectionMiddleText, selectionEndText, debugText]

      await currentMouse.drag(0, 0, 50, 10)
      await renderOnce()

      expect(statusText.hasSelection()).toBe(true)
      expect(statusText.getSelectedText()).toBe("Selected 5 chars:")

      expect(selectionStartText.hasSelection()).toBe(true)
      expect(selectionStartText.getSelectedText()).toBe('"Hello"')

      // Empty text renderables should not have selections since there's no content to select
      expect(selectionMiddleText.hasSelection()).toBe(false)
      expect(selectionMiddleText.getSelectedText()).toBe("")

      expect(selectionEndText.hasSelection()).toBe(false)
      expect(selectionEndText.getSelectedText()).toBe("")

      expect(debugText.hasSelection()).toBe(true)
      expect(debugText.getSelectedText()).toBe("Selected renderables: 2/5")

      const globalSelectedText = currentRenderer.getSelection()?.getSelectedText()

      expect(globalSelectedText).toContain("Selected 5 chars:")
      expect(globalSelectedText).toContain('"Hello"')
      expect(globalSelectedText).toContain("Selected renderables: 2/5")
    })

    it("should automatically update selection when text content changes within covered area", async () => {
      const { text: statusText } = await createTextRenderable(currentRenderer, {
        content: "Selected 5 chars:",
        selectable: true,
        fg: "#f0f6fc",
        top: 0,
        wrapMode: "none",
      })

      const { text: selectionStartText } = await createTextRenderable(currentRenderer, {
        top: 1,
        content: '"Hello"',
        selectable: true,
        fg: "#7dd3fc",
        wrapMode: "none",
      })

      const { text: debugText } = await createTextRenderable(currentRenderer, {
        top: 2,
        content: "Selected renderables: 2/5",
        selectable: true,
        fg: "#e6edf3",
        wrapMode: "none",
      })

      await currentMouse.drag(0, 0, 50, 5)
      await renderOnce()

      expect(statusText.getSelectedText()).toBe("Selected 5 chars:")
      expect(selectionStartText.getSelectedText()).toBe('"Hello"')
      expect(debugText.getSelectedText()).toBe("Selected renderables: 2/5")

      selectionStartText.content = '"Hello World Extended Selection"'

      expect(statusText.getSelectedText()).toBe("Selected 5 chars:")
      expect(selectionStartText.getSelectedText()).toBe('"Hello World Extended Selection"')
      expect(debugText.getSelectedText()).toBe("Selected renderables: 2/5")

      const updatedGlobalSelectedText = currentRenderer.getSelection()?.getSelectedText()

      expect(updatedGlobalSelectedText).toContain('"Hello World Extended Selection"')
      expect(updatedGlobalSelectedText).toContain("Selected 5 chars:")
      expect(updatedGlobalSelectedText).toContain("Selected renderables: 2/5")

      debugText.content = "Selected renderables: 3/5 | Container: statusBox"

      expect(debugText.getSelectedText()).toBe("Selected renderables: 3/5 | Container: statusBox")

      const finalGlobalSelectedText = currentRenderer.getSelection()?.getSelectedText()

      expect(finalGlobalSelectedText).toContain("Selected renderables: 3/5 | Container: statusBox")
    })

    it("should automatically update selection when text node content changes with clear and add", async () => {
      const { text: statusText } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
        fg: "#f0f6fc",
        top: 0,
        wrapMode: "none",
      })

      const statusNode = new TextNodeRenderable({})
      statusNode.add("Selected 5 chars:")
      statusText.add(statusNode)

      const { text: selectionStartText } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
        fg: "#7dd3fc",
        top: 1,
        wrapMode: "none",
      })

      const selectionNode = new TextNodeRenderable({})
      selectionNode.add('"Hello"')
      selectionStartText.add(selectionNode)

      const { text: debugText } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
        fg: "#e6edf3",
        top: 2,
        wrapMode: "none",
      })

      const debugNode = new TextNodeRenderable({})
      debugNode.add("Selected renderables: 2/5")
      debugText.add(debugNode)

      await currentMouse.drag(0, 0, 50, 5)
      await renderOnce()

      expect(statusText.getSelectedText()).toBe("Selected 5 chars:")
      expect(selectionStartText.getSelectedText()).toBe('"Hello"')
      expect(debugText.getSelectedText()).toBe("Selected renderables: 2/5")

      // Clear and add new content to the selection node
      selectionNode.clear()
      selectionNode.add('"Hello World Extended Selection"')
      await renderOnce()

      expect(statusText.getSelectedText()).toBe("Selected 5 chars:")
      expect(selectionStartText.getSelectedText()).toBe('"Hello World Extended Selection"')
      expect(debugText.getSelectedText()).toBe("Selected renderables: 2/5")

      const updatedGlobalSelectedText = currentRenderer.getSelection()?.getSelectedText()

      expect(updatedGlobalSelectedText).toContain('"Hello World Extended Selection"')
      expect(updatedGlobalSelectedText).toContain("Selected 5 chars:")
      expect(updatedGlobalSelectedText).toContain("Selected renderables: 2/5")

      // Clear and add new content to the debug node
      debugNode.clear()
      debugNode.add("Selected renderables: 3/5 | Container: statusBox")
      await renderOnce()

      expect(debugText.getSelectedText()).toBe("Selected renderables: 3/5 | Container: statusBox")

      const finalGlobalSelectedText = currentRenderer.getSelection()?.getSelectedText()

      expect(finalGlobalSelectedText).toContain("Selected renderables: 3/5 | Container: statusBox")
    })

    it("should handle selection that starts above box and ends below/right of box", async () => {
      const { text: statusText } = await createTextRenderable(currentRenderer, {
        content: "Status: Selection active",
        selectable: true,
        fg: "#f0f6fc",
        top: 2,
        wrapMode: "none",
      })

      const { text: selectionStartText } = await createTextRenderable(currentRenderer, {
        content: "Start: (10,5)",
        selectable: true,
        fg: "#7dd3fc",
        top: 3,
        wrapMode: "none",
      })

      const { text: selectionEndText } = await createTextRenderable(currentRenderer, {
        content: "End: (45,12)",
        selectable: true,
        fg: "#7dd3fc",
        top: 4,
        wrapMode: "none",
      })

      const { text: debugText } = await createTextRenderable(currentRenderer, {
        content: "Debug: Cross-renderable selection spanning 3 elements",
        selectable: true,
        fg: "#e6edf3",
        top: 5,
        wrapMode: "none",
      })

      const allRenderables = [statusText, selectionStartText, selectionEndText, debugText]

      await currentMouse.drag(statusText.x, statusText.y, 60, 10)
      await renderOnce()

      allRenderables.forEach((renderable) => {
        expect(renderable.hasSelection()).toBe(true)
      })

      expect(statusText.getSelectedText()).toBe("Status: Selection active")
      expect(selectionStartText.getSelectedText()).toBe("Start: (10,5)")
      expect(selectionEndText.getSelectedText()).toBe("End: (45,12)")
      expect(debugText.getSelectedText()).toBe("Debug: Cross-renderable selection spanning 3 elements")

      const globalSelectedText = currentRenderer.getSelection()?.getSelectedText()

      expect(globalSelectedText).toContain("Status: Selection active")
      expect(globalSelectedText).toContain("Start: (10,5)")
      expect(globalSelectedText).toContain("End: (45,12)")
      expect(globalSelectedText).toContain("Debug: Cross-renderable selection spanning 3 elements")
    })
  })

  describe("TextNode Integration with getPlainText", () => {
    it("should render correct plain text after adding TextNodes", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      const node1 = new TextNodeRenderable({
        fg: RGBA.fromValues(1, 0, 0, 1),
        bg: RGBA.fromValues(0, 0, 0, 1),
      })
      node1.add("Hello")

      const node2 = new TextNodeRenderable({
        fg: RGBA.fromValues(0, 1, 0, 1),
        bg: RGBA.fromValues(0, 0, 0, 1),
      })
      node2.add(" World")

      text.add(node1)
      text.add(node2)

      await renderOnce()

      expect(text.plainText).toBe("Hello World")
    })

    it("should render correct plain text after inserting TextNodes", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      const node1 = new TextNodeRenderable({})
      node1.add("Hello")

      const node2 = new TextNodeRenderable({})
      node2.add(" World")

      const node3 = new TextNodeRenderable({})
      node3.add("!")

      text.add(node1)
      text.add(node2)

      text.insertBefore(node3, node2)

      await renderOnce()

      expect(text.plainText).toBe("Hello! World")
    })

    it("should render correct plain text after removing TextNodes", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      const node1 = new TextNodeRenderable({})
      node1.add("Hello")

      const node2 = new TextNodeRenderable({})
      node2.add(" Cruel")

      const node3 = new TextNodeRenderable({})
      node3.add(" World")

      text.add(node1)
      text.add(node2)
      text.add(node3)

      await renderOnce()
      expect(text.plainText).toBe("Hello Cruel World")

      text.remove(node2.id)

      await renderOnce()

      expect(text.plainText).toBe("Hello World")
    })

    it("should handle simple add and remove operations", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      const node = new TextNodeRenderable({})
      node.add("Test")

      text.add(node)

      await renderOnce()
      expect(text.plainText).toBe("Test")

      text.remove(node.id)

      await renderOnce()
      expect(text.plainText).toBe("")
    })

    it("should render correct plain text after clearing all TextNodes", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      const node1 = new TextNodeRenderable({})
      node1.add("Hello")

      const node2 = new TextNodeRenderable({})
      node2.add(" World")

      text.add(node1)
      text.add(node2)

      await renderOnce()
      expect(text.plainText).toBe("Hello World")

      text.clear()

      await renderOnce()

      expect(text.plainText).toBe("")
    })

    it("should handle nested TextNode structures correctly", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      // Create nested structure: Parent -> [Child1, Child2]
      const parent = new TextNodeRenderable({
        fg: RGBA.fromValues(1, 1, 0, 1),
      })

      const child1 = new TextNodeRenderable({
        fg: RGBA.fromValues(1, 0, 0, 1),
      })
      child1.add("Red")

      const child2 = new TextNodeRenderable({
        fg: RGBA.fromValues(0, 1, 0, 1),
      })
      child2.add(" Green")

      parent.add(child1)
      parent.add(child2)

      const standalone = new TextNodeRenderable({
        fg: RGBA.fromValues(0, 0, 1, 1),
      })
      standalone.add(" Blue")

      text.add(parent)
      text.add(standalone)

      await renderOnce()

      expect(text.plainText).toBe("Red Green Blue")
    })

    it("should handle mixed string and TextNode content", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      const startNode = new TextNodeRenderable({})
      startNode.add("Start ")

      const node1 = new TextNodeRenderable({})
      node1.add("middle")

      const node2 = new TextNodeRenderable({})
      node2.add(" end")

      text.add(startNode)
      text.add(node1)
      text.add(node2)

      await renderOnce()

      expect(text.plainText).toBe("Start middle end")
    })

    it("should handle TextNode operations with inherited styles", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
        fg: RGBA.fromValues(1, 1, 1, 1), // White default
      })

      const redParent = new TextNodeRenderable({
        fg: RGBA.fromValues(1, 0, 0, 1), // Red
      })

      const redChild = new TextNodeRenderable({})

      const greenGrandchild = new TextNodeRenderable({
        fg: RGBA.fromValues(0, 1, 0, 1), // Green
      })
      greenGrandchild.add("Green")

      redChild.add(greenGrandchild)
      redParent.add(redChild)

      const blueNode = new TextNodeRenderable({
        fg: RGBA.fromValues(0, 0, 1, 1), // Blue
      })
      blueNode.add(" Blue")

      text.add(redParent)
      text.add(blueNode)

      await renderOnce()

      expect(text.plainText).toBe("Green Blue")
    })

    it("should handle empty TextNodes correctly", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      const emptyNode1 = new TextNodeRenderable({})
      const nodeWithText = new TextNodeRenderable({})
      nodeWithText.add("Text")
      const emptyNode2 = new TextNodeRenderable({})

      text.add(emptyNode1)
      text.add(nodeWithText)
      text.add(emptyNode2)

      await renderOnce()

      expect(text.plainText).toBe("Text")
    })

    it("should handle complex TextNode operations sequence", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      const initialNode = new TextNodeRenderable({})
      initialNode.add("Initial")

      const nodeA = new TextNodeRenderable({})
      nodeA.add(" A")

      const nodeB = new TextNodeRenderable({})
      nodeB.add(" B")

      const nodeC = new TextNodeRenderable({})
      nodeC.add(" C")

      const nodeD = new TextNodeRenderable({})
      nodeD.add(" D")

      text.add(initialNode)
      text.add(nodeA)
      text.add(nodeB)
      text.add(nodeC)
      text.add(nodeD)

      await renderOnce()
      expect(text.plainText).toBe("Initial A B C D")

      text.remove(nodeB.id)

      await renderOnce()
      expect(text.plainText).toBe("Initial A C D")

      const nodeX = new TextNodeRenderable({})
      nodeX.add(" X")
      text.insertBefore(nodeX, nodeC)

      await renderOnce()
      expect(text.plainText).toBe("Initial A X C D")

      nodeX.add(" Y")

      await renderOnce()
      expect(text.plainText).toBe("Initial A X Y C D")
    })

    it("should inherit fg/bg colors from TextRenderable to TextNode children", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
        fg: RGBA.fromValues(1, 0, 0, 1),
        bg: RGBA.fromValues(0, 0, 1, 1),
      })

      const child1 = new TextNodeRenderable({})
      child1.add("Child1")

      const child2 = new TextNodeRenderable({})
      child2.add(" Child2")

      text.add(child1)
      text.add(child2)

      await renderOnce()

      expect(text.plainText).toBe("Child1 Child2")

      const chunks = text.textNode.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(2)

      chunks.forEach((chunk) => {
        expect(chunk.fg).toEqual(RGBA.fromValues(1, 0, 0, 1))
        expect(chunk.bg).toEqual(RGBA.fromValues(0, 0, 1, 1))
        expect(chunk.attributes).toBe(0)
      })

      expect(chunks[0].text).toBe("Child1")
      expect(chunks[1].text).toBe(" Child2")
    })

    it("should allow TextNode children to override parent TextRenderable colors", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
        fg: RGBA.fromValues(1, 0, 0, 1),
        bg: RGBA.fromValues(0, 0, 1, 1),
      })

      const inheritingChild = new TextNodeRenderable({})
      inheritingChild.add("Inherit")

      const overridingChild = new TextNodeRenderable({
        fg: RGBA.fromValues(0, 1, 0, 1),
        bg: RGBA.fromValues(1, 1, 0, 1),
      })
      overridingChild.add(" Override")

      const partialOverrideChild = new TextNodeRenderable({
        fg: RGBA.fromValues(0, 0, 1, 1),
      })
      partialOverrideChild.add(" Partial")

      text.add(inheritingChild)
      text.add(overridingChild)
      text.add(partialOverrideChild)

      await renderOnce()

      expect(text.plainText).toBe("Inherit Override Partial")

      const chunks = text.textNode.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(3)

      // First child: inherits both fg and bg from parent
      expect(chunks[0].text).toBe("Inherit")
      expect(chunks[0].fg).toEqual(RGBA.fromValues(1, 0, 0, 1))
      expect(chunks[0].bg).toEqual(RGBA.fromValues(0, 0, 1, 1))

      // Second child: overrides both fg and bg
      expect(chunks[1].text).toBe(" Override")
      expect(chunks[1].fg).toEqual(RGBA.fromValues(0, 1, 0, 1))
      expect(chunks[1].bg).toEqual(RGBA.fromValues(1, 1, 0, 1))

      // Third child: overrides fg, inherits bg
      expect(chunks[2].text).toBe(" Partial")
      expect(chunks[2].fg).toEqual(RGBA.fromValues(0, 0, 1, 1))
      expect(chunks[2].bg).toEqual(RGBA.fromValues(0, 0, 1, 1))
    })

    it("should inherit TextRenderable colors through nested TextNode hierarchies", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
        fg: RGBA.fromValues(0, 1, 0, 1),
        bg: RGBA.fromValues(0, 0, 0, 1),
      })

      const grandparent = new TextNodeRenderable({})
      const parent = new TextNodeRenderable({})
      const child = new TextNodeRenderable({})

      child.add("Deep")
      parent.add("Nested ")
      parent.add(child)
      grandparent.add("Very ")
      grandparent.add(parent)

      text.add(grandparent)

      await renderOnce()

      expect(text.plainText).toBe("Very Nested Deep")

      const chunks = text.textNode.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(3)

      // All chunks should inherit the TextRenderable's green fg and black bg
      chunks.forEach((chunk) => {
        expect(chunk.fg).toEqual(RGBA.fromValues(0, 1, 0, 1))
        expect(chunk.bg).toEqual(RGBA.fromValues(0, 0, 0, 1))
        expect(chunk.attributes).toBe(0)
      })

      expect(chunks[0].text).toBe("Very ")
      expect(chunks[1].text).toBe("Nested ")
      expect(chunks[2].text).toBe("Deep")
    })

    it("should handle TextRenderable color changes affecting existing TextNode children", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
        fg: RGBA.fromValues(1, 0, 0, 1),
        bg: RGBA.fromValues(0, 0, 0, 1),
      })

      const child1 = new TextNodeRenderable({})
      child1.add("Before")

      const child2 = new TextNodeRenderable({})
      child2.add(" Change")

      text.add(child1)
      text.add(child2)

      await renderOnce()
      expect(text.plainText).toBe("Before Change")

      text.fg = RGBA.fromValues(0, 0, 1, 1)
      text.bg = RGBA.fromValues(1, 1, 1, 1)

      await renderOnce()

      const chunks = text.textNode.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(2)

      chunks.forEach((chunk) => {
        expect(chunk.fg).toEqual(RGBA.fromValues(0, 0, 1, 1))
        expect(chunk.bg).toEqual(RGBA.fromValues(1, 1, 1, 1))
      })

      expect(chunks[0].text).toBe("Before")
      expect(chunks[1].text).toBe(" Change")
    })

    it("should handle TextNode commands with multiple operations per render", async () => {
      const { text, root } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      const node1 = new TextNodeRenderable({})
      node1.add("First")

      const node2 = new TextNodeRenderable({})
      node2.add("Second")

      const node3 = new TextNodeRenderable({})
      node3.add("Third")

      text.add(node1)
      text.add(node2)
      text.insertBefore(node3, node1)

      node2.add(" Modified")

      await renderOnce()

      expect(text.plainText).toBe("ThirdFirstSecond Modified")
    })
  })

  describe("StyledText Integration", () => {
    it("should render StyledText content correctly", async () => {
      const styledText = stringToStyledText("Hello World")

      styledText.chunks[0].fg = RGBA.fromValues(1, 0, 0, 1) // Red text
      styledText.chunks[0].bg = RGBA.fromValues(0, 0, 0, 1) // Black background

      const { text } = await createTextRenderable(currentRenderer, {
        content: styledText,
        selectable: true,
      })

      await renderOnce()

      expect(text.plainText).toBe("Hello World")
      expect(text.width).toBeGreaterThan(0)
      expect(text.height).toBeGreaterThan(0)
    })

    it("should handle selection with StyledText content", async () => {
      const styledText = stringToStyledText("Hello World")
      styledText.chunks[0].fg = RGBA.fromValues(1, 0, 0, 1) // Red text

      const { text } = await createTextRenderable(currentRenderer, {
        content: styledText,
        selectable: true,
      })

      await currentMouse.drag(text.x + 6, text.y, text.x + 11, text.y)
      await renderOnce()

      const selection = text.getSelection()
      expect(selection).not.toBe(null)
      expect(selection!.start).toBe(6)
      expect(selection!.end).toBe(11)
      expect(text.getSelectedText()).toBe("World")
    })

    it("should handle empty StyledText", async () => {
      const emptyStyledText = stringToStyledText("")

      const { text, root } = await createTextRenderable(currentRenderer, {
        content: emptyStyledText,
        selectable: true,
      })

      await renderOnce()

      expect(text.plainText).toBe("")
      expect(text.hasSelection()).toBe(false)
      expect(text.getSelectedText()).toBe("")
    })

    it("should handle StyledText with multiple chunks", async () => {
      const styledText = new StyledText([
        { __isChunk: true, text: "Red", fg: RGBA.fromValues(1, 0, 0, 1), attributes: 1 },
        { __isChunk: true, text: " ", fg: undefined, attributes: 0 },
        { __isChunk: true, text: "Green", fg: RGBA.fromValues(0, 1, 0, 1), attributes: 2 },
        { __isChunk: true, text: " ", fg: undefined, attributes: 0 },
        { __isChunk: true, text: "Blue", fg: RGBA.fromValues(0, 0, 1, 1), attributes: 0 },
      ])

      const { text } = await createTextRenderable(currentRenderer, {
        content: styledText,
        selectable: true,
      })

      await renderOnce()

      expect(text.plainText).toBe("Red Green Blue")

      await currentMouse.drag(text.x + 4, text.y, text.x + 9, text.y)
      await renderOnce()

      expect(text.getSelectedText()).toBe("Green")
    })

    it("should handle StyledText with TextNodeRenderable children", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "",
        selectable: true,
      })

      const baseNode = new TextNodeRenderable({})
      baseNode.add("Base ")
      text.add(baseNode)

      const styledNode = new TextNodeRenderable({
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      const nodeStyledText = new StyledText([
        { __isChunk: true, text: "Styled", fg: RGBA.fromValues(0, 1, 0, 1), attributes: 1 },
      ])

      styledNode.add(nodeStyledText)
      text.add(styledNode)

      await renderOnce()

      expect(text.plainText).toBe("Base Styled")

      await currentMouse.drag(text.x + 5, text.y, text.x + 11, text.y)
      await renderOnce()
      expect(text.getSelectedText()).toBe("Styled")
    })
  })

  describe("Text Selection with Truncation", () => {
    it("should not extend selection across ellipsis in single line", async () => {
      const buffer = currentRenderer.currentRenderBuffer
      const { text } = await createTextRenderable(currentRenderer, {
        content: "0123456789ABCDEFGHIJ",
        width: 10,
        height: 1,
        selectable: true,
        selectionBg: RGBA.fromValues(1, 0, 0, 1),
        truncate: true,
      })

      await currentMouse.drag(text.x + 6, text.y, text.x + 3, text.y)
      await renderOnce()

      expect(text.hasSelection()).toBe(true)

      const { bg } = buffer.buffers
      const bufferWidth = buffer.width

      const ellipsisIdx = text.y * bufferWidth + text.x + 3
      const ellipsisBgR = (bg[ellipsisIdx * 4] & 0xff) / 255
      const ellipsisBgG = (bg[ellipsisIdx * 4 + 1] & 0xff) / 255
      const ellipsisBgB = (bg[ellipsisIdx * 4 + 2] & 0xff) / 255

      expect(Math.abs(ellipsisBgR - 1.0)).toBeLessThan(0.05)
      expect(Math.abs(ellipsisBgG - 0.0)).toBeLessThan(0.05)
      expect(Math.abs(ellipsisBgB - 0.0)).toBeLessThan(0.05)
    })

    it("should render selection end correctly across ellipsis in last line", async () => {
      const buffer = currentRenderer.currentRenderBuffer
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Line 1: This is a long line without wrapping\nLine 2: Another very long line that will be truncated",
        width: 10,
        height: 2,
        selectable: true,
        selectionBg: RGBA.fromValues(1, 0, 0, 1),
        truncate: true,
        wrapMode: "none",
      })

      await currentMouse.drag(text.x + 6, text.y, text.x + 2, text.y + 1)
      await renderOnce()

      expect(text.hasSelection()).toBe(true)

      const { bg } = buffer.buffers
      const bufferWidth = buffer.width

      const ellipsisIdx = (text.y + 1) * bufferWidth + text.x + 3
      const ellipsisBgR = (bg[ellipsisIdx * 4] & 0xff) / 255
      const ellipsisBgG = (bg[ellipsisIdx * 4 + 1] & 0xff) / 255
      const ellipsisBgB = (bg[ellipsisIdx * 4 + 2] & 0xff) / 255

      expect(Math.abs(ellipsisBgR - 1.0)).toBeGreaterThan(0.05)
      expect(Math.abs(ellipsisBgG - 0.0)).toBeLessThan(0.05)
      expect(Math.abs(ellipsisBgB - 0.0)).toBeLessThan(0.05)
    })
  })

  describe("Text Content Snapshots", () => {
    it("should render basic text content correctly", async () => {
      await createTextRenderable(currentRenderer, {
        content: "Hello World",
        left: 5,
        top: 3,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render multiline text content correctly", async () => {
      await createTextRenderable(currentRenderer, {
        content: "Line 1: Hello\nLine 2: World\nLine 3: Testing\nLine 4: Multiline",
        left: 1,
        top: 1,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render text with graphemes/emojis correctly", async () => {
      await createTextRenderable(currentRenderer, {
        content: "Hello 🌍 World 👋\n Test 🚀 Emoji",
        left: 0,
        top: 2,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render TextNode text composition correctly", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "",
        left: 0,
        top: 0,
      })

      const node1 = new TextNodeRenderable({})
      node1.add("First")

      const node2 = new TextNodeRenderable({})
      node2.add(" Second")

      const node3 = new TextNodeRenderable({})
      node3.add(" Third")

      text.add(node1)
      text.add(node2)
      text.add(node3)

      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render text positioning correctly", async () => {
      await createTextRenderable(currentRenderer, {
        content: "Top",
        position: "absolute",
        left: 0,
        top: 0,
      })

      await createTextRenderable(currentRenderer, {
        content: "Mid",
        position: "absolute",
        left: 8,
        top: 2,
      })

      await createTextRenderable(currentRenderer, {
        content: "Bot",
        position: "absolute",
        left: 16,
        top: 4,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render empty buffer correctly", async () => {
      currentRenderer.currentRenderBuffer.clear()
      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render text with character wrapping correctly", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "This is a very long text that should wrap to multiple lines when wrap is enabled",
        wrapMode: "char", // Explicitly test character wrapping
        width: 15, // Force wrapping at 15 characters width
        left: 0,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render wrapped text with different content", async () => {
      await createTextRenderable(currentRenderer, {
        content: "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789",
        wrapMode: "char", // Explicitly test character wrapping
        width: 10, // Force wrapping at 10 characters width
        left: 2,
        top: 1,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render wrapped text with emojis and graphemes", async () => {
      await createTextRenderable(currentRenderer, {
        content: "Hello 🌍 World 👋 This is a test with emojis 🚀 that should wrap properly",
        wrapMode: "char", // Explicitly test character wrapping
        width: 12, // Force wrapping at 12 characters width
        left: 1,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render wrapped multiline text correctly", async () => {
      await createTextRenderable(currentRenderer, {
        content: "First line with long content\nSecond line also with content\nThird line",
        wrapMode: "char", // Explicitly test character wrapping
        width: 8, // Force wrapping at 8 characters width
        left: 0,
        top: 1,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render text with tab indicator correctly", async () => {
      await createTextRenderable(currentRenderer, {
        content: "Line 1\tTabbed\nLine 2\t\tDouble tab",
        tabIndicator: "→",
        tabIndicatorColor: RGBA.fromValues(0.5, 0.5, 0.5, 1),
        left: 0,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should render word wrapped text with CJK and English correctly", async () => {
      resize(60, 10)

      const { text } = await createTextRenderable(currentRenderer, {
        content: "🌟 Unicode test: こんにちは世界 Hello World 你好世界",
        wrapMode: "word",
        width: 35,
        left: 0,
        top: 0,
      })

      await renderOnce()

      const frame = captureFrame()
      const lines = frame.split("\n").filter((l) => l.trim().length > 0)

      // Verify no character duplication - each character should appear only once
      const line0 = lines[0] || ""
      const line1 = lines[1] || ""

      const line0_ends_with_kai = line0.trimEnd().endsWith("界")
      const line1_starts_with_kai = line1.trimStart().startsWith("界")

      // "界" should not appear on both lines (would indicate duplication bug)
      expect(line0_ends_with_kai && line1_starts_with_kai).toBe(false)
    })

    it("should not split English word 'Hello' in middle when word wrapping with CJK characters", async () => {
      // This test reproduces the exact issue from text-truncation-demo.ts where "Hello"
      // is incorrectly split as "Hell" on first line and "o World" on second line
      // when word wrapping is enabled with CJK/emoji characters before it.
      resize(60, 10)

      const { text } = await createTextRenderable(currentRenderer, {
        content: "🌟 Unicode test: こんにちは世界 Hello World 你好世界 안녕하세요 🚀 More emoji: 🎨🎭🎪🎬🎮🎯",
        wrapMode: "word",
        width: 50, // Width that causes wrapping in the demo
        left: 0,
        top: 0,
      })

      await renderOnce()

      const frame = captureFrame()

      const lines = frame.split("\n").filter((l) => l.trim().length > 0)

      // The word "Hello" should NOT be split in the middle
      // Check for the specific incorrect split: "Hell" on one line, "o" starting the next
      let foundIncorrectSplit = false
      for (let i = 0; i < lines.length - 1; i++) {
        const currentLine = lines[i] || ""
        const nextLine = lines[i + 1] || ""

        // Check if current line ends with "Hell" (incorrect split)
        if (currentLine.trimEnd().endsWith("Hell")) {
          // And next line starts with "o" (the rest of "Hello")
          if (nextLine.trimStart().startsWith("o")) {
            foundIncorrectSplit = true
          }
        }
      }

      // Verify "Hello" is not split as "Hell" + "o"
      expect(foundIncorrectSplit).toBe(false)

      // Verify the word "Hello" appears complete on a single line
      const fullText = lines.join(" ")
      expect(fullText).toContain("Hello")

      // Verify "Hello" is not split in the middle
      const helloLineIndex = lines.findIndex((line) => line.includes("Hello"))
      expect(helloLineIndex).toBeGreaterThanOrEqual(0) // "Hello" should be found

      const helloLine = lines[helloLineIndex] || ""
      // Verify "Hello" appears as a complete word on this line
      expect(helloLine).toMatch(/Hello/)

      // Verify no previous line ends with "Hell" without "o"
      if (helloLineIndex > 0) {
        const prevLine = lines[helloLineIndex - 1] || ""
        expect(prevLine.trimEnd().endsWith("Hell")).toBe(false)
      }

      // Additional verification: "Hello World" should ideally be together
      // (this is a nice-to-have, showing improved wrapping behavior)
      expect(helloLine).toContain("Hello World")
    })
  })

  describe("Text Node Dimension Updates", () => {
    it("should update dimensions and reposition subsequent elements when text nodes expand", async () => {
      const { text: firstText } = await createTextRenderable(currentRenderer, {
        content: "",
        width: 20,
        wrapMode: "char",
      })

      const shortNode = new TextNodeRenderable({})
      shortNode.add("Short")
      firstText.add(shortNode)

      const { text: secondText } = await createTextRenderable(currentRenderer, {
        content: "Second text",
      })

      await renderOnce()
      const initialFrame = captureFrame()
      expect(initialFrame).toMatchSnapshot()

      expect(firstText.height).toEqual(1)
      expect(secondText.y).toEqual(1)

      shortNode.add(" text that will definitely wrap")

      await renderOnce()

      const finalFrame = captureFrame()

      expect(firstText.height).toEqual(2)
      expect(secondText.y).toEqual(2)

      expect(finalFrame).not.toBe(initialFrame)
      expect(finalFrame).toMatchSnapshot()
    })

    it("should handle multiple text node updates with complex layout changes", async () => {
      resize(20, 10)
      const { text: firstText } = await createTextRenderable(currentRenderer, {
        width: 10,
        wrapMode: "word",
      })

      const node1 = TextNodeRenderable.fromString("First")
      const node2 = TextNodeRenderable.fromString(" part")

      firstText.add(node1)
      firstText.add(node2)

      const { text: secondText } = await createTextRenderable(currentRenderer, {
        width: 12,
        wrapMode: "word",
      })
      secondText.add("Middle text")

      const { text: thirdText } = await createTextRenderable(currentRenderer, {})
      thirdText.add("Bottom text")

      await renderOnce()
      const initialFrame = captureFrame()
      expect(initialFrame).toMatchSnapshot()

      // Record initial positions
      expect(firstText.height).toEqual(1)
      expect(secondText.y).toEqual(1)
      expect(thirdText.y).toEqual(2)

      node1.add(" of a sentence")
      node2.add("that will wrap")

      await renderOnce()

      const finalFrame = captureFrame()
      expect(finalFrame).toMatchSnapshot()

      expect(firstText.height).toEqual(5)
      expect(secondText.y).toEqual(5)
      expect(thirdText.y).toEqual(6)
    })
  })

  describe("Height and Width Measurement", () => {
    it("should grow height for multiline text without wrapping", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
        wrapMode: "none",
      })

      await renderOnce()

      expect(text.height).toBe(5)
      expect(text.width).toBeGreaterThanOrEqual(6)
    })

    it("should grow height for wrapped text when wrapping enabled", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "This is a very long line that will definitely wrap to multiple lines",
        wrapMode: "word",
        width: 15,
      })

      await renderOnce()

      expect(text.height).toBeGreaterThan(1)
      expect(text.width).toBeLessThanOrEqual(15)
    })

    it("should measure full width when wrapping is disabled and not constrained by parent", async () => {
      const longLine = "This is a very long line that would wrap but wrapping is disabled"
      const { text } = await createTextRenderable(currentRenderer, {
        content: longLine,
        wrapMode: "none",
        position: "absolute",
      })

      await renderOnce()

      expect(text.height).toBe(1)
      expect(text.width).toBe(longLine.length)
    })

    it("should update height when content changes from single to multiline", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Single line",
        wrapMode: "none",
      })

      await renderOnce()
      expect(text.height).toBe(1)

      text.content = "Line 1\nLine 2\nLine 3"
      await renderOnce()

      expect(text.height).toBe(3)
    })

    it("should update height when wrapping mode changes", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "This is a long line that will wrap to multiple lines",
        wrapMode: "none",
        width: 15,
      })

      await renderOnce()
      const unwrappedHeight = text.height
      expect(unwrappedHeight).toBe(1)
      expect(text.width).toBe(15)

      text.wrapMode = "word"
      await renderOnce()

      const wrappedHeight = text.height

      expect(wrappedHeight).toBeGreaterThan(unwrappedHeight)
      expect(wrappedHeight).toBeGreaterThanOrEqual(3)
    })

    it("should shrink height when content changes from multi-line to single line", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
        wrapMode: "none",
      })

      await renderOnce()
      expect(text.height).toBe(5)

      text.content = "Single line"
      await renderOnce()

      expect(text.height).toBe(1)
    })

    it("should shrink width when replacing long line with shorter (wrapMode: none, position: absolute)", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "This is a very long line with many characters",
        wrapMode: "none",
        position: "absolute",
      })

      await renderOnce()
      const initialWidth = text.width
      expect(initialWidth).toBe(45) // length of the long line

      text.content = "Short"
      await renderOnce()

      expect(text.width).toBe(5)
      expect(text.width).toBeLessThan(initialWidth)
    })
  })

  describe("Width/Height Setter Layout Tests", () => {
    it("should not shrink box when width is set via setter", async () => {
      resize(40, 10)

      const container = new BoxRenderable(currentRenderer, { border: true, width: 30 })
      currentRenderer.root.add(container)

      const row = new BoxRenderable(currentRenderer, { flexDirection: "row", width: "100%" })
      container.add(row)

      const indicator = new BoxRenderable(currentRenderer, { backgroundColor: "#f00" })
      row.add(indicator)

      const indicatorText = new TextRenderable(currentRenderer, { content: ">" })
      indicator.add(indicatorText)

      const content = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexGrow: 1 })
      row.add(content)

      const contentText = new TextRenderable(currentRenderer, { content: "Content that takes up space" })
      content.add(contentText)

      await renderOnce()

      const initialIndicatorWidth = indicator.width

      indicator.width = 5
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(indicator.width).toBe(5)
      expect(content.width).toBeGreaterThan(0)
      expect(content.width).toBeLessThan(30) // Should be compressed but not zero
    })

    it("should not shrink box when height is set via setter in column layout with text", async () => {
      resize(30, 15)

      const outerBox = new BoxRenderable(currentRenderer, { border: true, width: 25, height: 10 })
      currentRenderer.root.add(outerBox)

      const column = new BoxRenderable(currentRenderer, { flexDirection: "column", height: "100%" })
      outerBox.add(column)

      const header = new BoxRenderable(currentRenderer, { backgroundColor: "#f00" })
      column.add(header)

      const headerText = new TextRenderable(currentRenderer, { content: "Header" })
      header.add(headerText)

      const mainContent = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexGrow: 1 })
      column.add(mainContent)

      const mainText = new TextRenderable(currentRenderer, {
        content: "Line1\nLine2\nLine3\nLine4\nLine5\nLine6\nLine7\nLine8",
      })
      mainContent.add(mainText)

      const footer = new BoxRenderable(currentRenderer, { height: 2, backgroundColor: "#00f" })
      column.add(footer)

      const footerText = new TextRenderable(currentRenderer, { content: "Footer" })
      footer.add(footerText)

      await renderOnce()

      header.height = 3
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(header.height).toBe(3)
      expect(mainContent.height).toBeGreaterThan(0)
      expect(footer.height).toBe(2)
    })

    it("should not shrink box when minWidth is set via setter", async () => {
      resize(40, 10)

      const container = new BoxRenderable(currentRenderer, { border: true, width: 30 })
      currentRenderer.root.add(container)

      const row = new BoxRenderable(currentRenderer, { flexDirection: "row", width: "100%" })
      container.add(row)

      const indicator = new BoxRenderable(currentRenderer, { backgroundColor: "#f00", flexShrink: 1 })
      row.add(indicator)

      const indicatorText = new TextRenderable(currentRenderer, { content: ">" })
      indicator.add(indicatorText)

      const content = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexGrow: 1 })
      row.add(content)

      const contentText = new TextRenderable(currentRenderer, { content: "Content that takes up space" })
      content.add(contentText)

      await renderOnce()

      indicator.minWidth = 5
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(indicator.width).toBeGreaterThanOrEqual(5)
      expect(content.width).toBeGreaterThan(0)
    })

    it("should not shrink box when minHeight is set via setter in column layout with text", async () => {
      resize(30, 15)

      const outerBox = new BoxRenderable(currentRenderer, { border: true, width: 25, height: 10 })
      currentRenderer.root.add(outerBox)

      const column = new BoxRenderable(currentRenderer, { flexDirection: "column", height: "100%" })
      outerBox.add(column)

      const header = new BoxRenderable(currentRenderer, { backgroundColor: "#f00", flexShrink: 1 })
      column.add(header)

      const headerText = new TextRenderable(currentRenderer, { content: "Header" })
      header.add(headerText)

      const mainContent = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexGrow: 1 })
      column.add(mainContent)

      const mainText = new TextRenderable(currentRenderer, {
        content: "Line1\nLine2\nLine3\nLine4\nLine5\nLine6\nLine7\nLine8",
      })
      mainContent.add(mainText)

      const footer = new BoxRenderable(currentRenderer, { height: 2, backgroundColor: "#00f" })
      column.add(footer)

      const footerText = new TextRenderable(currentRenderer, { content: "Footer" })
      footer.add(footerText)

      await renderOnce()

      header.minHeight = 3
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(header.height).toBeGreaterThanOrEqual(3)
      expect(mainContent.height).toBeGreaterThan(0)
      expect(footer.height).toBe(2)
    })

    it("should not shrink box when width is set from undefined via setter", async () => {
      resize(40, 10)

      const container = new BoxRenderable(currentRenderer, { border: true, width: 30 })
      currentRenderer.root.add(container)

      const row = new BoxRenderable(currentRenderer, { flexDirection: "row", width: "100%" })
      container.add(row)

      const indicator = new BoxRenderable(currentRenderer, { backgroundColor: "#f00", flexShrink: 1 })
      row.add(indicator)

      const indicatorText = new TextRenderable(currentRenderer, { content: ">" })
      indicator.add(indicatorText)

      const content = new BoxRenderable(currentRenderer, { backgroundColor: "#0f0", flexGrow: 1 })
      row.add(content)

      const contentText = new TextRenderable(currentRenderer, { content: "Content that takes up space" })
      content.add(contentText)

      await renderOnce()

      indicator.width = 5
      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      expect(indicator.width).toBe(5)
      expect(content.width).toBeGreaterThan(0)
    })
  })

  describe("Absolute Positioned Box with Text", () => {
    it("should render text in absolute positioned box with padding and borders correctly", async () => {
      resize(80, 20)

      const notificationBox = new BoxRenderable(currentRenderer, {
        position: "absolute",
        justifyContent: "center",
        alignItems: "flex-start",
        top: 2,
        right: 2,
        width: Math.min(60, 80 - 6),
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        backgroundColor: "#1e293b",
        borderColor: "#3b82f6",
        border: ["left", "right"],
      })

      currentRenderer.root.add(notificationBox)

      // Wrap content in nested boxes with row layout and gap
      const outerWrapperBox = new BoxRenderable(currentRenderer, {
        flexDirection: "row",
        paddingBottom: 1,
        paddingTop: 1,
        paddingLeft: 2,
        paddingRight: 2,
        gap: 2,
      })
      notificationBox.add(outerWrapperBox)

      const innerContentBox = new BoxRenderable(currentRenderer, {
        flexGrow: 1,
        gap: 1,
      })
      outerWrapperBox.add(innerContentBox)

      const titleText = new TextRenderable(currentRenderer, {
        content: "Important Notification",
        attributes: 1, // BOLD
        marginBottom: 1,
        fg: "#f8fafc",
      })
      innerContentBox.add(titleText)

      const messageText = new TextRenderable(currentRenderer, {
        content:
          "This is a longer message that should wrap properly within the absolutely positioned box with appropriate width constraints and padding applied.",
        fg: "#e2e8f0",
        wrapMode: "word",
        width: "100%",
      })
      innerContentBox.add(messageText)

      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      // Verify the box is positioned correctly
      expect(notificationBox.x).toBeGreaterThan(0)
      expect(notificationBox.y).toBe(2)
      expect(notificationBox.width).toBe(60)

      // Note: With current Yoga behavior, nested flex boxes with width:"100%" inside
      // an absolutely positioned parent with only maxWidth (no explicit width) causes
      // the children to grow to their intrinsic size rather than being constrained
      // This is Yoga's shrink-to-fit behavior with the circular dependency
      // See: https://github.com/facebook/yoga/issues/1409
      expect(outerWrapperBox.width).toBeGreaterThan(100)
      expect(innerContentBox.width).toBeGreaterThan(100)
      expect(messageText.width).toBeGreaterThan(100)
      expect(messageText.height).toBe(1)
      expect(messageText.plainText).toBe(
        "This is a longer message that should wrap properly within the absolutely positioned box with appropriate width constraints and padding applied.",
      )
    })

    it("should render text fully visible in absolute positioned box at various positions", async () => {
      resize(100, 25)

      // Top-right positioned box
      const topRightBox = new BoxRenderable(currentRenderer, {
        position: "absolute",
        top: 1,
        right: 1,
        maxWidth: 40,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        backgroundColor: "#fef2f2",
        borderColor: "#ef4444",
        border: true,
      })
      currentRenderer.root.add(topRightBox)

      const topRightText = new TextRenderable(currentRenderer, {
        content: "Error: File not found in the specified directory path",
        fg: "#991b1b",
        wrapMode: "word",
        width: "100%",
      })
      topRightBox.add(topRightText)

      // Bottom-left positioned box
      const bottomLeftBox = new BoxRenderable(currentRenderer, {
        position: "absolute",
        bottom: 1,
        left: 1,
        maxWidth: 35,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: "#f0fdf4",
        borderColor: "#22c55e",
        border: ["top", "bottom"],
      })
      currentRenderer.root.add(bottomLeftBox)

      const bottomLeftText = new TextRenderable(currentRenderer, {
        content: "Success: Operation completed successfully!",
        fg: "#166534",
        wrapMode: "word",
        width: "100%",
      })
      bottomLeftBox.add(bottomLeftText)

      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      // Verify top-right box positioning and dimensions
      expect(topRightBox.y).toBe(1)
      expect(topRightBox.x).toBeGreaterThan(50)
      expect(topRightBox.width).toBeGreaterThan(30)
      expect(topRightBox.width).toBeLessThanOrEqual(40)

      // Verify top-right text renders with proper width
      expect(topRightText.plainText).toBe("Error: File not found in the specified directory path")
      expect(topRightText.width).toBeGreaterThan(25)
      expect(topRightText.width).toBeLessThanOrEqual(38)
      expect(topRightText.height).toBeGreaterThan(1)

      // Verify bottom-left box positioning and dimensions
      expect(bottomLeftBox.x).toBe(1)
      expect(bottomLeftBox.y).toBeGreaterThan(15)
      expect(bottomLeftBox.width).toBeGreaterThan(25)
      expect(bottomLeftBox.width).toBeLessThanOrEqual(35)

      // Verify bottom-left text renders with proper width
      expect(bottomLeftText.plainText).toBe("Success: Operation completed successfully!")
      expect(bottomLeftText.width).toBeGreaterThan(25)
      expect(bottomLeftText.width).toBeLessThanOrEqual(33)
      expect(bottomLeftText.height).toBeGreaterThan(1)
      expect(bottomLeftText.width).toBeGreaterThan(0)
      expect(bottomLeftText.width).toBeLessThanOrEqual(33) // maxWidth 35 - padding 2
    })

    it("should handle width:100% text in absolute positioned box with constrained maxWidth", async () => {
      resize(70, 15)

      const constrainedBox = new BoxRenderable(currentRenderer, {
        position: "absolute",
        top: 5,
        left: 10,
        maxWidth: 50,
        paddingLeft: 3,
        paddingRight: 3,
        paddingTop: 2,
        paddingBottom: 2,
        backgroundColor: "#1e1e2e",
      })
      currentRenderer.root.add(constrainedBox)

      const longText = new TextRenderable(currentRenderer, {
        content:
          "This is an extremely long piece of text that needs to wrap multiple times within the constrained width of the absolutely positioned container box with significant padding on all sides.",
        fg: "#cdd6f4",
        wrapMode: "word",
        width: "100%",
      })
      constrainedBox.add(longText)

      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      // Verify the box respects maxWidth
      expect(constrainedBox.width).toBeLessThanOrEqual(50)
      expect(constrainedBox.width).toBeGreaterThan(40)
      expect(constrainedBox.x).toBe(10)
      expect(constrainedBox.y).toBe(5)

      // Verify text wraps and fills available width
      expect(longText.width).toBeGreaterThan(35)
      expect(longText.width).toBeLessThanOrEqual(44)
      expect(longText.height).toBeGreaterThanOrEqual(5)
      expect(longText.plainText).toBe(
        "This is an extremely long piece of text that needs to wrap multiple times within the constrained width of the absolutely positioned container box with significant padding on all sides.",
      )
    })

    it("should render multiple text elements in absolute positioned box with proper spacing", async () => {
      resize(90, 20)

      const infoBox = new BoxRenderable(currentRenderer, {
        position: "absolute",
        justifyContent: "flex-start",
        alignItems: "flex-start",
        top: 3,
        right: 5,
        maxWidth: 45,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        backgroundColor: "#eff6ff",
        borderColor: "#3b82f6",
        border: true,
      })
      currentRenderer.root.add(infoBox)

      const headerText = new TextRenderable(currentRenderer, {
        content: "System Update",
        attributes: 1, // BOLD
        fg: "#1e40af",
      })
      infoBox.add(headerText)

      const bodyText = new TextRenderable(currentRenderer, {
        content: "A new version is available with bug fixes and performance improvements.",
        fg: "#1e3a8a",
        wrapMode: "word",
        width: "100%",
        marginTop: 1,
      })
      infoBox.add(bodyText)

      const footerText = new TextRenderable(currentRenderer, {
        content: "Click to install",
        fg: "#60a5fa",
        marginTop: 1,
      })
      infoBox.add(footerText)

      await renderOnce()

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()

      // Verify all texts are rendered with correct content
      expect(headerText.plainText).toBe("System Update")
      expect(bodyText.plainText).toBe("A new version is available with bug fixes and performance improvements.")
      expect(footerText.plainText).toBe("Click to install")

      // Verify box dimensions are reasonable
      expect(infoBox.width).toBeGreaterThan(35)
      expect(infoBox.width).toBeLessThanOrEqual(45)

      // Verify header text renders properly
      expect(headerText.width).toBeGreaterThan(10)
      expect(headerText.height).toBe(1)

      // Verify body text fills width and wraps
      expect(bodyText.width).toBeGreaterThan(30)
      expect(bodyText.height).toBeGreaterThanOrEqual(2)

      // Verify footer text renders properly
      expect(footerText.width).toBeGreaterThan(10)
      expect(footerText.height).toBe(1)

      // Verify vertical spacing
      expect(bodyText.y).toBeGreaterThan(headerText.y)
      expect(footerText.y).toBeGreaterThan(bodyText.y)
    })
  })

  describe("Word Wrapping", () => {
    it("should default to word wrap mode", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Hello World",
      })

      expect(text.wrapMode).toBe("word")
    })

    it("should wrap at word boundaries when using word mode", async () => {
      await createTextRenderable(currentRenderer, {
        content: "The quick brown fox jumps over the lazy dog",
        wrapMode: "word",
        width: 15,
        left: 0,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should wrap at character boundaries when using char mode", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "The quick brown fox jumps over the lazy dog",
        wrapMode: "char",
        width: 15,
        left: 0,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should handle word wrapping with punctuation", async () => {
      await createTextRenderable(currentRenderer, {
        content: "Hello,World.Test-Example/Path",
        wrapMode: "word",
        width: 10,
        left: 0,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should handle word wrapping with hyphens and dashes", async () => {
      await createTextRenderable(currentRenderer, {
        content: "self-contained multi-line text-wrapping example",
        wrapMode: "word",
        width: 12,
        left: 0,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("regression #651: should keep multi-byte UTF-8 words intact when wrapping in word mode", async () => {
      resize(80, 24)

      await createTextRenderable(currentRenderer, {
        content: "gyorskiszolgáló éttermek közül. Azóta alapjaiban értelmeztük újra a vendéglátást",
        wrapMode: "word",
        width: 40,
        left: 0,
        top: 0,
      })

      const lines = captureFrame()
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)

      const expectedLines = ["gyorskiszolgáló éttermek közül. Azóta", "alapjaiban értelmeztük újra a", "vendéglátást"]

      expect(lines).toEqual(expectedLines)
    })

    it("should dynamically change wrap mode", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "The quick brown fox jumps",
        wrapMode: "char",
        width: 10,
        left: 0,
        top: 0,
      })

      expect(text.wrapMode).toBe("char")

      // Change to word mode
      text.wrapMode = "word"
      await renderOnce()

      expect(text.wrapMode).toBe("word")
      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should handle long words that exceed wrap width in word mode", async () => {
      await createTextRenderable(currentRenderer, {
        content: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        wrapMode: "word",
        width: 10,
        left: 0,
        top: 0,
      })

      // Since there's no word boundary, it should fall back to character wrapping
      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should preserve empty lines with word wrapping", async () => {
      await createTextRenderable(currentRenderer, {
        content: "First line\n\nThird line",
        wrapMode: "word",
        width: 8,
        left: 0,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should handle word wrapping with single character words", async () => {
      await createTextRenderable(currentRenderer, {
        content: "a b c d e f g h i j k l m n o p",
        wrapMode: "word",
        width: 8,
        left: 0,
        top: 0,
      })

      const frame = captureFrame()
      expect(frame).toMatchSnapshot()
    })

    it("should compare char vs word wrapping with same content", async () => {
      const content = "Hello wonderful world of text wrapping"

      // Test with char mode
      const { text: charText } = await createTextRenderable(currentRenderer, {
        content,
        wrapMode: "char",
        width: 12,
        left: 0,
        top: 0,
      })

      const charFrame = captureFrame()

      // Remove the char text and add word text
      currentRenderer.root.remove(charText.id)
      await renderOnce()

      await createTextRenderable(currentRenderer, {
        content,
        wrapMode: "word",
        width: 12,
        left: 0,
        top: 0,
      })

      const wordFrame = captureFrame()

      // The frames should be different as word wrapping preserves word boundaries
      expect(charFrame).not.toBe(wordFrame)
      expect(wordFrame).toMatchSnapshot()
    })

    it("should correctly wrap text when updating content via text.content", async () => {
      const { text } = await createTextRenderable(currentRenderer, {
        content: "Short text",
        wrapMode: "word",
        left: 0,
        top: 0,
      })

      await renderOnce()
      const initialFrame = captureFrame()
      expect(initialFrame).toMatchSnapshot()

      text.content = "This is a much longer text that should definitely wrap to multiple lines"

      await renderOnce()
      const updatedFrame = captureFrame()
      expect(updatedFrame).toMatchSnapshot()
    })
  })

  describe("Mouse Scrolling", () => {
    it("should receive mouse scroll events", async () => {
      resize(20, 10)

      const longText = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10"
      const { text } = await createTextRenderable(currentRenderer, {
        content: longText,
        wrapMode: "none",
      })

      await renderOnce()

      let scrollEventReceived = false
      let scrollInfo: any = null

      // Override the handler to capture events
      const originalHandler = text.onMouseScroll
      text.onMouseScroll = (event: any) => {
        scrollEventReceived = true
        scrollInfo = event.scroll
        // Call original handler
        if (originalHandler) {
          originalHandler.call(text, event)
        }
      }

      await currentMouse.scroll(text.x + 1, text.y + 1, "down")
      await renderOnce()

      expect(scrollEventReceived).toBe(true)
      expect(scrollInfo).toBeDefined()
      expect(scrollInfo?.direction).toBe("down")
    })

    it("should handle mouse scroll events for vertical scrolling", async () => {
      resize(20, 5)

      const longText = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10"
      const { text } = await createTextRenderable(currentRenderer, {
        content: longText,
        wrapMode: "none",
      })

      await renderOnce()

      // Initially should be at scroll position 0
      expect(text.scrollY).toBe(0)
      expect(text.scrollX).toBe(0)

      // Scroll down (each scroll event typically moves by 1)
      await currentMouse.scroll(text.x + 1, text.y + 1, "down")
      await currentMouse.scroll(text.x + 1, text.y + 1, "down")
      await currentMouse.scroll(text.x + 1, text.y + 1, "down")
      await renderOnce()

      expect(text.scrollY).toBe(3)

      // Scroll up
      await currentMouse.scroll(text.x + 1, text.y + 1, "up")
      await renderOnce()

      expect(text.scrollY).toBe(2)
    })

    it("should handle mouse scroll events for horizontal scrolling with unwrapped text", async () => {
      resize(80, 5)

      const wideText =
        "This is a very long line that extends way beyond the visible area and should definitely need scrolling"
      const { text } = await createTextRenderable(currentRenderer, {
        content: wideText,
        wrapMode: "none",
        width: 20,
        maxWidth: 20,
      })

      await renderOnce()

      expect(text.scrollX).toBe(0)
      expect(text.scrollY).toBe(0)

      // Scroll right
      for (let i = 0; i < 5; i++) {
        await currentMouse.scroll(text.x + 1, text.y, "right")
      }
      await renderOnce()

      expect(text.scrollX).toBe(5)

      // Scroll left
      await currentMouse.scroll(text.x + 1, text.y, "left")
      await currentMouse.scroll(text.x + 1, text.y, "left")
      await renderOnce()

      expect(text.scrollX).toBe(3)
    })

    it("should not allow horizontal scrolling when text is wrapped", async () => {
      resize(20, 5)

      const longText =
        "Line 1 text\nLine 2 text\nLine 3 text\nLine 4 text\nLine 5 text\nLine 6 text\nLine 7 text\nLine 8 text"
      const { text } = await createTextRenderable(currentRenderer, {
        content: longText,
        wrapMode: "word",
        width: 15,
        height: 3, // Constrain height to enable vertical scrolling
      })

      await renderOnce()

      // Try to scroll horizontally
      for (let i = 0; i < 5; i++) {
        await currentMouse.scroll(text.x + 1, text.y + 1, "right")
      }
      await renderOnce()

      // Should not scroll horizontally when wrapped
      expect(text.scrollX).toBe(0)

      // But vertical scrolling should still work if there's content
      if (text.maxScrollY > 0) {
        await currentMouse.scroll(text.x + 1, text.y + 1, "down")
        await currentMouse.scroll(text.x + 1, text.y + 1, "down")
        await renderOnce()

        expect(text.scrollY).toBe(2)
      }
    })

    it("should clamp scroll position to valid bounds", async () => {
      resize(20, 5)

      const shortText = "Line 1\nLine 2\nLine 3"
      const { text } = await createTextRenderable(currentRenderer, {
        content: shortText,
        wrapMode: "none",
      })

      await renderOnce()

      // Try to scroll beyond content
      for (let i = 0; i < 10; i++) {
        await currentMouse.scroll(text.x + 1, text.y + 1, "down")
      }
      await renderOnce()

      // Should be clamped to maxScrollY
      expect(text.scrollY).toBeLessThanOrEqual(text.maxScrollY)
      expect(text.scrollY).toBeGreaterThanOrEqual(0)

      // Try to scroll up beyond 0
      for (let i = 0; i < 20; i++) {
        await currentMouse.scroll(text.x + 1, text.y + 1, "up")
      }
      await renderOnce()

      expect(text.scrollY).toBe(0)
    })

    it("should expose scrollWidth and scrollHeight getters", async () => {
      resize(20, 5)

      const text = "Line 1\nLine 2 with more content\nLine 3"
      const { text: textRenderable } = await createTextRenderable(currentRenderer, {
        content: text,
        wrapMode: "none",
      })

      await renderOnce()

      expect(textRenderable.scrollHeight).toBe(3) // 3 lines
      expect(textRenderable.scrollWidth).toBeGreaterThan(0) // Max width of lines
    })

    it("should calculate maxScrollY and maxScrollX correctly", async () => {
      resize(20, 5)

      const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8"
      const { text: textRenderable } = await createTextRenderable(currentRenderer, {
        content: text,
        wrapMode: "none",
        height: 5,
      })

      await renderOnce()

      // maxScrollY should be scrollHeight - viewport height
      expect(textRenderable.maxScrollY).toBe(Math.max(0, textRenderable.scrollHeight - textRenderable.height))

      // maxScrollX should be scrollWidth - viewport width
      expect(textRenderable.maxScrollX).toBe(Math.max(0, textRenderable.scrollWidth - textRenderable.width))
    })

    it("should update scroll position via setters", async () => {
      resize(20, 5)

      const longText =
        "Line 1 with some extra content\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10"
      const { text } = await createTextRenderable(currentRenderer, {
        content: longText,
        wrapMode: "none",
        width: 20, // Constrain width
        height: 5, // Constrain height
      })

      await renderOnce()

      // Set scroll position directly
      text.scrollY = 3
      await renderOnce()

      expect(text.scrollY).toBe(3)

      // Set scrollX (only works if there's horizontal scrollable content)
      if (text.maxScrollX > 0) {
        text.scrollX = 2
        await renderOnce()
        expect(text.scrollX).toBe(2)
      }
    })
  })
})
