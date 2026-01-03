import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test"
import { TerminalConsole, ConsolePosition } from "./console"
import { MouseEvent } from "./renderer"

interface MockRenderer {
  terminalWidth: number
  terminalHeight: number
  width: number
  height: number
  isRunning: boolean
  widthMethod: string
  requestRender: () => void
  keyInput: {
    on: (event: string, handler: any) => void
    off: (event: string, handler: any) => void
  }
}

// Helper function to create MouseEvent objects for testing
function createMouseEvent(
  x: number,
  y: number,
  type: "down" | "up" | "move" | "drag" | "scroll",
  button: number = 0,
  scroll?: { direction: "up" | "down" | "left" | "right"; delta: number },
): MouseEvent {
  return new MouseEvent(null, {
    type,
    button,
    x,
    y,
    modifiers: { shift: false, alt: false, ctrl: false },
    scroll,
  })
}

describe("TerminalConsole", () => {
  let mockRenderer: MockRenderer
  let terminalConsole: TerminalConsole | undefined

  beforeEach(() => {
    mockRenderer = {
      terminalWidth: 100,
      terminalHeight: 30,
      width: 100,
      height: 30,
      isRunning: false,
      widthMethod: "cell",
      requestRender: mock(() => {}),
      keyInput: {
        on: mock(() => {}),
        off: mock(() => {}),
      },
    }
  })

  afterEach(() => {
    terminalConsole?.destroy()
  })

  describe("resize", () => {
    test("should use provided width and height parameters", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      const initialWidth = terminalConsole["consoleWidth"]
      expect(initialWidth).toBe(100)

      terminalConsole.resize(80, 50)

      expect(terminalConsole["consoleWidth"]).toBe(80)
      expect(terminalConsole["consoleHeight"]).toBe(15) // 30% of 50
    })

    test("should apply sizePercent correctly for different positions", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.TOP,
        sizePercent: 40,
      })

      terminalConsole.resize(100, 50)

      expect(terminalConsole["consoleHeight"]).toBe(20) // 40% of 50
      expect(terminalConsole["consoleY"]).toBe(0) // TOP position
    })

    test("should position console correctly for BOTTOM position", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      terminalConsole.resize(100, 50)

      const consoleHeight = terminalConsole["consoleHeight"]
      expect(terminalConsole["consoleY"]).toBe(50 - consoleHeight)
    })

    test("should position console correctly for RIGHT position", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.RIGHT,
        sizePercent: 30,
      })

      terminalConsole.resize(100, 50)

      const consoleWidth = terminalConsole["consoleWidth"]
      expect(terminalConsole["consoleX"]).toBe(100 - consoleWidth)
    })

    test("should enforce minimum dimension of 1", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 5,
      })

      terminalConsole.resize(100, 10)

      expect(terminalConsole["consoleHeight"]).toBeGreaterThanOrEqual(1)
    })
  })

  describe("Console Selection", () => {
    test("should have no selection initially", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      expect(terminalConsole["hasSelection"]()).toBe(false)
      expect(terminalConsole["getSelectedText"]()).toBe("")
    })

    test("should set selection on mouse down in log area", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })
      terminalConsole["isVisible"] = true

      terminalConsole["_displayLines"] = [
        { text: "Hello World", level: "LOG" as any, indent: false },
        { text: "Second Line", level: "LOG" as any, indent: false },
      ]

      const bounds = terminalConsole.bounds
      const mouseEvent = createMouseEvent(bounds.x + 5, bounds.y + 1, "down", 0)
      terminalConsole.handleMouse(mouseEvent)

      expect(terminalConsole["_selectionStart"]).not.toBeNull()
      expect(terminalConsole["_isSelecting"]).toBe(true)
    })

    test("should extend selection on drag", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })
      terminalConsole["isVisible"] = true

      terminalConsole["_displayLines"] = [
        { text: "Hello World", level: "LOG" as any, indent: false },
        { text: "Second Line", level: "LOG" as any, indent: false },
      ]

      const bounds = terminalConsole.bounds
      const downEvent = createMouseEvent(bounds.x + 1, bounds.y + 1, "down", 0)
      terminalConsole.handleMouse(downEvent)
      const dragEvent = createMouseEvent(bounds.x + 10, bounds.y + 1, "drag", 0)
      terminalConsole.handleMouse(dragEvent)

      expect(terminalConsole["_selectionEnd"]?.col).toBe(9)
    })

    test("should finalize selection on mouse up", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })
      terminalConsole["isVisible"] = true

      terminalConsole["_displayLines"] = [{ text: "Hello World", level: "LOG" as any, indent: false }]

      const bounds = terminalConsole.bounds
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 1, "down", 0))
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 5, bounds.y + 1, "drag", 0))
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 5, bounds.y + 1, "up", 0))

      expect(terminalConsole["_isSelecting"]).toBe(false)
      expect(terminalConsole["hasSelection"]()).toBe(true)
    })

    test("should normalize reverse selection", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      terminalConsole["_selectionStart"] = { line: 5, col: 10 }
      terminalConsole["_selectionEnd"] = { line: 2, col: 5 }

      const normalized = terminalConsole["normalizeSelection"]()

      expect(normalized?.startLine).toBe(2)
      expect(normalized?.startCol).toBe(5)
      expect(normalized?.endLine).toBe(5)
      expect(normalized?.endCol).toBe(10)
    })

    test("should extract correct text for single-line selection", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      terminalConsole["_displayLines"] = [{ text: "Hello World Test", level: "LOG" as any, indent: false }]
      terminalConsole["_selectionStart"] = { line: 0, col: 0 }
      terminalConsole["_selectionEnd"] = { line: 0, col: 5 }

      expect(terminalConsole["getSelectedText"]()).toBe("Hello")
    })

    test("should extract correct text for multi-line selection", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      terminalConsole["_displayLines"] = [
        { text: "First Line", level: "LOG" as any, indent: false },
        { text: "Second Line", level: "LOG" as any, indent: false },
        { text: "Third Line", level: "LOG" as any, indent: false },
      ]
      terminalConsole["_selectionStart"] = { line: 0, col: 6 }
      terminalConsole["_selectionEnd"] = { line: 2, col: 5 }

      const text = terminalConsole["getSelectedText"]()
      expect(text).toBe("Line\nSecond Line\nThird")
    })

    test("should clear selection on clearSelection", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      terminalConsole["_selectionStart"] = { line: 0, col: 0 }
      terminalConsole["_selectionEnd"] = { line: 0, col: 5 }
      terminalConsole["_isSelecting"] = true

      terminalConsole["clearSelection"]()

      expect(terminalConsole["_selectionStart"]).toBeNull()
      expect(terminalConsole["_selectionEnd"]).toBeNull()
      expect(terminalConsole["_isSelecting"]).toBe(false)
    })
  })

  describe("Copy Button", () => {
    test("should trigger onCopySelection callback on click when selection exists", () => {
      const onCopy = mock(() => {})
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
        onCopySelection: onCopy,
      })
      terminalConsole["isVisible"] = true
      terminalConsole["_copyButtonBounds"] = { x: 93, y: 0, width: 6, height: 1 }

      terminalConsole["_displayLines"] = [{ text: "Hello World", level: "LOG" as any, indent: false }]
      terminalConsole["_selectionStart"] = { line: 0, col: 0 }
      terminalConsole["_selectionEnd"] = { line: 0, col: 5 }

      const bounds = terminalConsole.bounds
      const copyButtonX = bounds.x + terminalConsole["_copyButtonBounds"].x
      const mouseEvent = createMouseEvent(copyButtonX, bounds.y, "down", 0)
      terminalConsole.handleMouse(mouseEvent)

      expect(onCopy).toHaveBeenCalledWith("Hello")
    })

    test("should not trigger callback when no selection", () => {
      const onCopy = mock(() => {})
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
        onCopySelection: onCopy,
      })
      terminalConsole["isVisible"] = true
      terminalConsole["_copyButtonBounds"] = { x: 93, y: 0, width: 6, height: 1 }

      const bounds = terminalConsole.bounds
      const copyButtonX = bounds.x + terminalConsole["_copyButtonBounds"].x
      const mouseEvent = createMouseEvent(copyButtonX, bounds.y, "down", 0)
      terminalConsole.handleMouse(mouseEvent)

      expect(onCopy).not.toHaveBeenCalled()
    })
  })

  describe("Copy Keyboard Shortcut", () => {
    test("should trigger copy on Ctrl+Shift+C when focused with selection", () => {
      const onCopy = mock(() => {})
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
        onCopySelection: onCopy,
      })

      terminalConsole["_displayLines"] = [{ text: "Hello World", level: "LOG" as any, indent: false }]
      terminalConsole["_selectionStart"] = { line: 0, col: 0 }
      terminalConsole["_selectionEnd"] = { line: 0, col: 5 }

      terminalConsole["handleKeyPress"]({ name: "c", ctrl: true, shift: true, meta: false } as any)

      expect(onCopy).toHaveBeenCalledWith("Hello")
    })

    test("should not trigger when no selection", () => {
      const onCopy = mock(() => {})
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
        onCopySelection: onCopy,
      })

      terminalConsole["handleKeyPress"]({ name: "c", ctrl: true, shift: true, meta: false } as any)

      expect(onCopy).not.toHaveBeenCalled()
    })

    test("should respect custom key bindings", () => {
      const onCopy = mock(() => {})
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
        onCopySelection: onCopy,
        keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
      })

      terminalConsole["_displayLines"] = [{ text: "Test", level: "LOG" as any, indent: false }]

      // Test default binding (Ctrl+Shift+C) still works
      terminalConsole["_selectionStart"] = { line: 0, col: 0 }
      terminalConsole["_selectionEnd"] = { line: 0, col: 4 }
      terminalConsole["handleKeyPress"]({ name: "c", ctrl: true, shift: true, meta: false } as any)
      expect(onCopy).toHaveBeenCalledWith("Test")
      expect(terminalConsole["hasSelection"]()).toBe(false) // Selection cleared after copy
      onCopy.mockClear()

      // Test custom binding (Ctrl+Y) also works
      terminalConsole["_selectionStart"] = { line: 0, col: 0 }
      terminalConsole["_selectionEnd"] = { line: 0, col: 4 }
      terminalConsole["handleKeyPress"]({ name: "y", ctrl: true, shift: false, meta: false } as any)
      expect(onCopy).toHaveBeenCalledWith("Test")
      expect(terminalConsole["hasSelection"]()).toBe(false) // Selection cleared after copy
    })

    test("should update copy button label when key bindings change", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      // Check default label (lowercase)
      const defaultLabel = terminalConsole["getCopyButtonLabel"]()
      expect(defaultLabel).toContain("ctrl+shift+c")

      // Update key bindings - last binding for the action wins in the label
      terminalConsole.keyBindings = [{ name: "y", ctrl: true, action: "copy-selection" }]

      // Check updated label - should show the last binding for copy-selection
      const updatedLabel = terminalConsole["getCopyButtonLabel"]()
      expect(updatedLabel).toContain("ctrl+y")
      expect(updatedLabel).not.toContain("ctrl+shift+c")
    })
  })

  describe("Mouse Event Bounds", () => {
    test("should handle mouse events based on console bounds", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })
      terminalConsole["isVisible"] = true

      // Outside bounds
      const outsideEvent = createMouseEvent(0, 0, "down", 0)
      expect(terminalConsole.handleMouse(outsideEvent)).toBe(false)

      // Inside bounds
      const bounds = terminalConsole.bounds
      const insideEvent = createMouseEvent(bounds.x + 1, bounds.y + 1, "down", 0)
      expect(terminalConsole.handleMouse(insideEvent)).toBe(true)
    })

    test("should not start selection on right-click", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })
      terminalConsole["isVisible"] = true
      terminalConsole["_displayLines"] = [{ text: "Test", level: "LOG" as any, indent: false }]

      const bounds = terminalConsole.bounds
      const rightClickEvent = createMouseEvent(bounds.x + 1, bounds.y + 1, "down", 2)
      terminalConsole.handleMouse(rightClickEvent)

      expect(terminalConsole["_isSelecting"]).toBe(false)
      expect(terminalConsole["_selectionStart"]).toBeNull()
    })
  })

  describe("Auto-scroll during selection", () => {
    test("should auto-scroll up when dragging at top edge", async () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })
      terminalConsole["isVisible"] = true

      // Create many display lines
      const lines = []
      for (let i = 0; i < 50; i++) {
        lines.push({ text: `Line ${i}`, level: "LOG" as any, indent: false })
      }
      terminalConsole["_displayLines"] = lines

      // Scroll to middle
      terminalConsole["scrollTopIndex"] = 20

      const bounds = terminalConsole.bounds
      // Start selection in middle
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 5, "down", 0))

      // Drag to top edge
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 1, "drag", 0))

      // Check that auto-scroll interval was started
      expect(terminalConsole["_autoScrollInterval"]).not.toBeNull()

      // Wait for auto-scroll to happen
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should have scrolled up
      expect(terminalConsole["scrollTopIndex"]).toBeLessThan(20)

      // Stop selecting
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 1, "up", 0))

      // Auto-scroll should be stopped
      expect(terminalConsole["_autoScrollInterval"]).toBeNull()
    })

    test("should auto-scroll down when dragging at bottom edge", async () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })
      terminalConsole["isVisible"] = true

      // Create many display lines
      const lines = []
      for (let i = 0; i < 50; i++) {
        lines.push({ text: `Line ${i}`, level: "LOG" as any, indent: false })
      }
      terminalConsole["_displayLines"] = lines

      // Scroll to beginning
      terminalConsole["scrollTopIndex"] = 0

      const bounds = terminalConsole.bounds
      const logAreaHeight = Math.max(1, bounds.height - 1)

      // Start selection in middle
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 5, "down", 0))

      // Drag to bottom edge
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + logAreaHeight, "drag", 0))

      // Check that auto-scroll interval was started
      expect(terminalConsole["_autoScrollInterval"]).not.toBeNull()

      // Wait for auto-scroll to happen
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should have scrolled down
      expect(terminalConsole["scrollTopIndex"]).toBeGreaterThan(0)

      // Stop selecting
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + logAreaHeight, "up", 0))

      // Auto-scroll should be stopped
      expect(terminalConsole["_autoScrollInterval"]).toBeNull()
    })

    test("should stop auto-scroll when dragging away from edge", async () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })
      terminalConsole["isVisible"] = true

      // Create many display lines
      const lines = []
      for (let i = 0; i < 50; i++) {
        lines.push({ text: `Line ${i}`, level: "LOG" as any, indent: false })
      }
      terminalConsole["_displayLines"] = lines
      terminalConsole["scrollTopIndex"] = 20

      const bounds = terminalConsole.bounds

      // Start selection
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 5, "down", 0))

      // Drag to top edge to start auto-scroll
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 1, "drag", 0))
      expect(terminalConsole["_autoScrollInterval"]).not.toBeNull()

      // Drag away from edge
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 5, "drag", 0))

      // Auto-scroll should be stopped
      expect(terminalConsole["_autoScrollInterval"]).toBeNull()
    })

    test("should extend selection as auto-scroll happens", async () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })
      terminalConsole["isVisible"] = true

      // Create many display lines
      const lines = []
      for (let i = 0; i < 50; i++) {
        lines.push({ text: `Line ${i}`, level: "LOG" as any, indent: false })
      }
      terminalConsole["_displayLines"] = lines
      terminalConsole["scrollTopIndex"] = 20

      const bounds = terminalConsole.bounds

      // Start selection
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 5, "down", 0))
      const initialStartLine = terminalConsole["_selectionStart"]?.line

      // Drag to top edge
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 1, "drag", 0))

      // Wait for auto-scroll
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Selection end should have moved with the scroll
      const endLine = terminalConsole["_selectionEnd"]?.line
      expect(endLine).toBeLessThan(initialStartLine!)

      // Stop selecting
      terminalConsole.handleMouse(createMouseEvent(bounds.x + 1, bounds.y + 1, "up", 0))
    })
  })

  describe("Edge Cases", () => {
    test("should extract correct text for indented line selection", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      terminalConsole["_displayLines"] = [
        { text: "Parent", level: "LOG" as any, indent: false },
        { text: "Child", level: "LOG" as any, indent: true },
      ]
      terminalConsole["_selectionStart"] = { line: 1, col: 0 }
      terminalConsole["_selectionEnd"] = { line: 1, col: 7 }

      expect(terminalConsole["getSelectedText"]()).toBe("  Child")
    })

    test("should handle selection extending beyond display lines", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      terminalConsole["_displayLines"] = [{ text: "Only Line", level: "LOG" as any, indent: false }]
      terminalConsole["_selectionStart"] = { line: 0, col: 0 }
      terminalConsole["_selectionEnd"] = { line: 5, col: 10 }

      expect(terminalConsole["getSelectedText"]()).toBe("Only Line")
    })

    test("should not crash when onCopySelection is not provided", () => {
      terminalConsole = new TerminalConsole(mockRenderer as any, {
        position: ConsolePosition.BOTTOM,
        sizePercent: 30,
      })

      terminalConsole["_displayLines"] = [{ text: "Test", level: "LOG" as any, indent: false }]
      terminalConsole["_selectionStart"] = { line: 0, col: 0 }
      terminalConsole["_selectionEnd"] = { line: 0, col: 4 }

      expect(() => terminalConsole["triggerCopy"]()).not.toThrow()
    })
  })
})
