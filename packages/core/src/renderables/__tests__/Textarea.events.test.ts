import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockMouse, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput

describe("Textarea - Event Handlers Tests", () => {
  beforeEach(async () => {
    ;({
      renderer: currentRenderer,
      renderOnce,
      mockInput: currentMockInput,
    } = await createTestRenderer({
      width: 80,
      height: 24,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  describe("Change Events", () => {
    describe("onCursorChange", () => {
      it("should fire onCursorChange when cursor moves", async () => {
        let cursorChangeCount = 0
        let lastCursorEvent: { line: number; visualColumn: number } | null = null

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 1\nLine 2\nLine 3",
          width: 40,
          height: 10,
          onCursorChange: (event) => {
            cursorChangeCount++
            lastCursorEvent = event
          },
        })

        editor.focus()
        const initialCount = cursorChangeCount

        editor.moveCursorRight()
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(cursorChangeCount).toBeGreaterThan(initialCount)
        expect(lastCursorEvent).not.toBe(null)
        expect(lastCursorEvent!.line).toBe(0)
        expect(lastCursorEvent!.visualColumn).toBe(1)

        const prevCount = cursorChangeCount

        editor.moveCursorDown()
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(cursorChangeCount).toBeGreaterThanOrEqual(prevCount)
        expect(lastCursorEvent).not.toBe(null)
        expect(lastCursorEvent!.line).toBeGreaterThanOrEqual(0)
      })

      it("should fire onCursorChange when typing moves cursor", async () => {
        let cursorChangeCount = 0
        let lastCursorEvent: { line: number; visualColumn: number } | null = null

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onCursorChange: (event) => {
            cursorChangeCount++
            lastCursorEvent = event
          },
        })

        editor.focus()
        const initialCount = cursorChangeCount

        currentMockInput.pressKey("H")
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(cursorChangeCount).toBeGreaterThan(initialCount)
        expect(lastCursorEvent).not.toBe(null)
        expect(lastCursorEvent!.line).toBe(0)
        expect(lastCursorEvent!.visualColumn).toBe(1)
      })

      it("should fire onCursorChange when pressing arrow keys", async () => {
        let cursorEventCount = 0
        let lastCursorEvent: { line: number; visualColumn: number } | null = null

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "ABC\nDEF",
          width: 40,
          height: 10,
          onCursorChange: (event) => {
            cursorEventCount++
            lastCursorEvent = event
          },
        })

        editor.focus()
        const initialCount = cursorEventCount

        currentMockInput.pressArrow("right")
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(cursorEventCount).toBeGreaterThan(initialCount)
        expect(lastCursorEvent).not.toBe(null)
        expect(lastCursorEvent!.visualColumn).toBe(1)

        const beforeDown = cursorEventCount
        currentMockInput.pressArrow("down")
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(cursorEventCount).toBeGreaterThanOrEqual(beforeDown)
        expect(lastCursorEvent).not.toBe(null)
      })

      it("should fire onCursorChange when using gotoLine", async () => {
        let cursorChangeCount = 0
        let lastCursorEvent: { line: number; visualColumn: number } | null = null

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Line 0\nLine 1\nLine 2",
          width: 40,
          height: 10,
          onCursorChange: (event) => {
            cursorChangeCount++
            lastCursorEvent = event
          },
        })

        editor.focus()
        const initialCount = cursorChangeCount

        editor.gotoLine(2)
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(cursorChangeCount).toBeGreaterThan(initialCount)
        expect(lastCursorEvent).not.toBe(null)
        expect(lastCursorEvent!.line).toBe(2)
        expect(lastCursorEvent!.visualColumn).toBe(0)
      })

      it("should fire onCursorChange after undo", async () => {
        let cursorChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onCursorChange: () => {
            cursorChangeCount++
          },
        })

        editor.focus()

        currentMockInput.pressKey("H")
        currentMockInput.pressKey("i")
        await new Promise((resolve) => setTimeout(resolve, 10))

        const beforeUndo = cursorChangeCount

        editor.undo()
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(cursorChangeCount).toBeGreaterThan(beforeUndo)
      })

      it("should update event handler when set dynamically", async () => {
        let firstHandlerCalled = false
        let secondHandlerCalled = false

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test",
          width: 40,
          height: 10,
          onCursorChange: () => {
            firstHandlerCalled = true
          },
        })

        editor.focus()

        editor.moveCursorRight()
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(firstHandlerCalled).toBe(true)

        editor.onCursorChange = () => {
          secondHandlerCalled = true
        }

        editor.moveCursorRight()
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(secondHandlerCalled).toBe(true)
      })

      it("should not fire when handler is undefined", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test",
          width: 40,
          height: 10,
          onCursorChange: undefined,
        })

        editor.focus()

        editor.moveCursorRight()
        expect(editor.logicalCursor.col).toBe(1)
      })
    })

    describe("onContentChange", () => {
      it("should fire onContentChange when typing", async () => {
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onContentChange: () => {
            contentChangeCount++
          },
        })

        editor.focus()
        const initialCount = contentChangeCount

        currentMockInput.pressKey("H")
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(contentChangeCount).toBeGreaterThan(initialCount)
        expect(editor.plainText).toBe("H")
      })

      it("should fire onContentChange when deleting", async () => {
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Hello",
          width: 40,
          height: 10,
          onContentChange: () => {
            contentChangeCount++
          },
        })

        editor.focus()
        editor.gotoLine(9999)
        const initialCount = contentChangeCount

        currentMockInput.pressBackspace()
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(contentChangeCount).toBeGreaterThan(initialCount)
        expect(editor.plainText).toBe("Hell")
      })

      it("should fire onContentChange when inserting newline", async () => {
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test",
          width: 40,
          height: 10,
          onContentChange: () => {
            contentChangeCount++
          },
        })

        editor.focus()
        editor.gotoLine(9999)
        const initialCount = contentChangeCount

        currentMockInput.pressEnter()
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(contentChangeCount).toBeGreaterThan(initialCount)
        expect(editor.plainText).toBe("Test\n")
      })

      it("should fire onContentChange when pasting", async () => {
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Hello",
          width: 40,
          height: 10,
          onContentChange: () => {
            contentChangeCount++
          },
        })

        editor.focus()
        editor.gotoLine(9999)

        const initialCount = contentChangeCount

        await currentMockInput.pasteBracketedText(" World")

        expect(contentChangeCount).toBeGreaterThan(initialCount)
        expect(editor.plainText).toBe("Hello World")
      })

      it("should fire onContentChange after undo", async () => {
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onContentChange: () => {
            contentChangeCount++
          },
        })

        editor.focus()

        currentMockInput.pressKey("T")
        currentMockInput.pressKey("e")
        await new Promise((resolve) => setTimeout(resolve, 20))

        const beforeUndo = contentChangeCount

        editor.undo()
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(contentChangeCount).toBeGreaterThanOrEqual(beforeUndo)
        expect(editor.plainText).toBe("T")
      })

      it("should fire onContentChange after redo", async () => {
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onContentChange: () => {
            contentChangeCount++
          },
        })

        editor.focus()

        currentMockInput.pressKey("X")
        await new Promise((resolve) => setTimeout(resolve, 20))
        editor.undo()
        await new Promise((resolve) => setTimeout(resolve, 20))

        const beforeRedo = contentChangeCount

        editor.redo()
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(contentChangeCount).toBeGreaterThanOrEqual(beforeRedo)
        expect(editor.plainText).toBe("X")
      })

      it("should fire onContentChange when setting value programmatically", async () => {
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Initial",
          width: 40,
          height: 10,
          onContentChange: () => {
            contentChangeCount++
          },
        })

        const initialCount = contentChangeCount

        editor.setText("Updated")
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(contentChangeCount).toBeGreaterThan(initialCount)
        expect(editor.plainText).toBe("Updated")
      })

      it("should fire onContentChange when deleting selection", async () => {
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Hello World",
          width: 40,
          height: 10,
          selectable: true,
          onContentChange: () => {
            contentChangeCount++
          },
        })

        editor.focus()

        for (let i = 0; i < 5; i++) {
          currentMockInput.pressArrow("right", { shift: true })
        }
        await new Promise((resolve) => setTimeout(resolve, 10))

        const beforeDelete = contentChangeCount

        currentMockInput.pressBackspace()
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(contentChangeCount).toBeGreaterThan(beforeDelete)
        expect(editor.plainText).toBe("World")
      })

      it("should update event handler when set dynamically", async () => {
        let firstHandlerCalled = false
        let secondHandlerCalled = false

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onContentChange: () => {
            firstHandlerCalled = true
          },
        })

        editor.focus()

        currentMockInput.pressKey("A")
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(firstHandlerCalled).toBe(true)

        editor.onContentChange = () => {
          secondHandlerCalled = true
        }

        currentMockInput.pressKey("B")
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(secondHandlerCalled).toBe(true)
      })

      it("should not fire when handler is undefined", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onContentChange: undefined,
        })

        editor.focus()

        currentMockInput.pressKey("X")
        expect(editor.plainText).toBe("X")
      })

      it("should fire exactly once when setting via setter and pressing a key", async () => {
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
        })

        editor.focus()

        editor.onContentChange = () => {
          contentChangeCount++
        }

        currentMockInput.pressKey("X")
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(contentChangeCount).toBe(1)
        expect(editor.plainText).toBe("X")
      })
    })

    describe("onSubmit", () => {
      it("should fire onSubmit with default keybinding (Meta+Enter)", async () => {
        let submitCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test content",
          width: 40,
          height: 10,
          onSubmit: () => {
            submitCount++
          },
        })

        editor.focus()
        const initialCount = submitCount

        currentMockInput.pressEnter({ meta: true })
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(submitCount).toBe(initialCount + 1)
        expect(editor.plainText).toBe("Test content")
      })

      it("should fire onSubmit with alternative keybinding (Meta+Return)", async () => {
        let submitCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test",
          width: 40,
          height: 10,
          onSubmit: () => {
            submitCount++
          },
        })

        editor.focus()

        currentMockInput.pressEnter({ meta: true })
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(submitCount).toBe(1)
      })

      it("should not insert newline when submitting", async () => {
        let submitCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test",
          width: 40,
          height: 10,
          onSubmit: () => {
            submitCount++
          },
        })

        editor.focus()
        editor.gotoLine(9999)

        currentMockInput.pressEnter({ meta: true })
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(submitCount).toBe(1)
        expect(editor.plainText).toBe("Test")
      })

      it("should update handler via setter", async () => {
        let firstHandlerCalled = false
        let secondHandlerCalled = false

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onSubmit: () => {
            firstHandlerCalled = true
          },
        })

        editor.focus()

        currentMockInput.pressEnter({ meta: true })
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(firstHandlerCalled).toBe(true)

        editor.onSubmit = () => {
          secondHandlerCalled = true
        }

        currentMockInput.pressEnter({ meta: true })
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(secondHandlerCalled).toBe(true)
      })

      it("should not fire when handler is undefined", async () => {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test",
          width: 40,
          height: 10,
          onSubmit: undefined,
        })

        editor.focus()

        currentMockInput.pressEnter({ meta: true })
        expect(editor.plainText).toBe("Test")
      })

      it("should support custom keybinding for submit", async () => {
        let submitCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test",
          width: 40,
          height: 10,
          keyBindings: [{ name: "s", ctrl: true, action: "submit" }],
          onSubmit: () => {
            submitCount++
          },
        })

        editor.focus()

        currentMockInput.pressKey("s", { ctrl: true })
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(submitCount).toBe(1)
      })

      it("should get current handler via getter", async () => {
        const handler = () => {}

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onSubmit: handler,
        })

        expect(editor.onSubmit).toBe(handler)
      })

      it("should allow removing handler by setting to undefined", async () => {
        let submitCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onSubmit: () => {
            submitCount++
          },
        })

        editor.focus()

        currentMockInput.pressEnter({ meta: true })
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(submitCount).toBe(1)

        editor.onSubmit = undefined

        currentMockInput.pressEnter({ meta: true })
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(submitCount).toBe(1)
      })
    })

    describe("Combined cursor and content events", () => {
      it("should fire both onCursorChange and onContentChange when typing", async () => {
        let cursorChangeCount = 0
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onCursorChange: () => {
            cursorChangeCount++
          },
          onContentChange: () => {
            contentChangeCount++
          },
        })

        editor.focus()
        const initialCursorCount = cursorChangeCount
        const initialContentCount = contentChangeCount

        currentMockInput.pressKey("H")
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(cursorChangeCount).toBeGreaterThan(initialCursorCount)
        expect(contentChangeCount).toBeGreaterThan(initialContentCount)
      })

      it("should fire onCursorChange but not onContentChange when only moving cursor", async () => {
        let cursorChangeCount = 0
        let contentChangeCount = 0

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test",
          width: 40,
          height: 10,
          onCursorChange: () => {
            cursorChangeCount++
          },
          onContentChange: () => {
            contentChangeCount++
          },
        })

        editor.focus()
        const initialCursorCount = cursorChangeCount
        const initialContentCount = contentChangeCount

        editor.moveCursorRight()
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(cursorChangeCount).toBeGreaterThan(initialCursorCount)
        expect(contentChangeCount).toBe(initialContentCount) // Should not change
      })

      it("should track events through complex editing sequence", async () => {
        const events: Array<{ type: "cursor" | "content"; time: number }> = []

        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "",
          width: 40,
          height: 10,
          onCursorChange: () => {
            events.push({ type: "cursor", time: Date.now() })
          },
          onContentChange: () => {
            events.push({ type: "content", time: Date.now() })
          },
        })

        editor.focus()
        events.length = 0 // Clear initial events

        currentMockInput.pressKey("H")
        currentMockInput.pressKey("e")
        currentMockInput.pressKey("l")
        currentMockInput.pressKey("l")
        currentMockInput.pressKey("o")

        editor.moveCursorLeft()
        editor.moveCursorLeft()

        currentMockInput.pressBackspace()

        await new Promise((resolve) => setTimeout(resolve, 50))

        const cursorEvents = events.filter((e) => e.type === "cursor")
        const contentEvents = events.filter((e) => e.type === "content")

        expect(cursorEvents.length).toBeGreaterThan(0)
        expect(contentEvents.length).toBeGreaterThan(0)
      })
    })
  })
})
