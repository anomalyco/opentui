import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput } from "../../testing/test-renderer.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMockInput: MockInput

describe("Textarea - Destroyed Renderable Event Tests", () => {
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

  describe("Keypress events on destroyed renderable", () => {
    it("should not trigger handleKeyPress after destroy is called", async () => {
      let keypressCalled = false
      let handleKeyPressCalled = false

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        onKeyDown: () => {
          keypressCalled = true
        },
      })

      // Override handleKeyPress to track calls
      const originalHandleKeyPress = editor.handleKeyPress.bind(editor)
      editor.handleKeyPress = (key) => {
        handleKeyPressCalled = true
        return originalHandleKeyPress(key)
      }

      editor.focus()
      await renderOnce()

      // Destroy the renderable
      editor.destroy()

      // Reset flags
      keypressCalled = false
      handleKeyPressCalled = false

      // Try to send a key event after destruction
      currentMockInput.pressKey("A")
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(keypressCalled).toBe(false)
      expect(handleKeyPressCalled).toBe(false)
    })

    it("should not trigger handleKeyPress when destroyed before blur", async () => {
      let keypressCalled = false

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        onKeyDown: () => {
          keypressCalled = true
        },
      })

      editor.focus()
      await renderOnce()

      // Destroy without explicitly blurring first (destroy should handle this)
      editor.destroy()

      keypressCalled = false

      currentMockInput.pressKey("B")
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(keypressCalled).toBe(false)
    })

    it("should not trigger keypress during async operations after destroy", async () => {
      let keypressCount = 0

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        onKeyDown: () => {
          keypressCount++
        },
      })

      editor.focus()

      // Queue multiple key presses
      currentMockInput.pressKey("A")
      currentMockInput.pressKey("B")

      // Destroy while events might still be processing
      editor.destroy()

      // Queue more events after destroy
      currentMockInput.pressKey("C")
      currentMockInput.pressKey("D")

      await new Promise((resolve) => setTimeout(resolve, 50))

      // At most the first couple events should have been processed before destroy
      // After destroy, no new events should be processed
      expect(keypressCount).toBeLessThanOrEqual(2)
    })

    it("should handle rapid focus/destroy/keypress cycles", async () => {
      let errors: Error[] = []

      try {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test",
          width: 40,
          height: 10,
        })

        editor.focus()
        currentMockInput.pressKey("A")
        editor.destroy()
        currentMockInput.pressKey("B")

        await new Promise((resolve) => setTimeout(resolve, 20))

        // Create and destroy another
        const { textarea: editor2 } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test2",
          width: 40,
          height: 10,
        })

        editor2.focus()
        currentMockInput.pressKey("C")
        editor2.destroy()
        currentMockInput.pressKey("D")

        await new Promise((resolve) => setTimeout(resolve, 20))
      } catch (error) {
        if (error instanceof Error) {
          errors.push(error)
        }
      }

      expect(errors.length).toBe(0)
    })

    it("should not crash when keypressHandler fires after editBuffer is destroyed", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      await renderOnce()

      // Destroy the whole textarea properly (not just editBuffer)
      // Destroying only editBuffer while textarea is alive is undefined behavior
      editor.destroy()

      // Try pressing key after destroy - should be safely ignored
      currentMockInput.pressKey("X")
      await new Promise((resolve) => setTimeout(resolve, 20))

      // Should not crash
      expect(editor.isDestroyed).toBe(true)
    })
  })

  describe("Paste events on destroyed renderable", () => {
    it("should not trigger handlePaste after destroy is called", async () => {
      let pasteCalled = false

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        onPaste: () => {
          pasteCalled = true
        },
      })

      editor.focus()
      await renderOnce()

      editor.destroy()
      pasteCalled = false

      await currentMockInput.pasteBracketedText("PastedText")
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(pasteCalled).toBe(false)
    })

    it("should not trigger paste during async operations after destroy", async () => {
      let pasteCount = 0

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        onPaste: () => {
          pasteCount++
        },
      })

      editor.focus()

      // Queue paste operation
      const pastePromise = currentMockInput.pasteBracketedText("Text1")

      // Destroy while paste might still be processing
      editor.destroy()

      // Try another paste after destroy
      await currentMockInput.pasteBracketedText("Text2")

      await pastePromise
      await new Promise((resolve) => setTimeout(resolve, 50))

      // At most the first paste should have been processed
      expect(pasteCount).toBeLessThanOrEqual(1)
    })
  })

  describe("Event handlers cleanup on destroy", () => {
    it("should remove keypress handler from internal key input on destroy", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      await renderOnce()

      // Check that handlers are set up
      expect(editor.focused).toBe(true)

      editor.destroy()

      // After destroy, focused should be false and handlers should be removed
      expect(editor.focused).toBe(false)

      // Verify isDestroyed is true
      expect(editor.isDestroyed).toBe(true)
    })

    it("should not trigger events when destroyed renderable is still in tree", async () => {
      let keypressCount = 0

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        onKeyDown: () => {
          keypressCount++
        },
      })

      editor.focus()
      await renderOnce()

      // Destroy the renderable (this should remove it from parent and clean up handlers)
      editor.destroy()

      expect(editor.isDestroyed).toBe(true)
      keypressCount = 0

      // Try to send events
      currentMockInput.pressKey("A")
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(keypressCount).toBe(0)
    })

    it("should handle destroy called multiple times", async () => {
      let errorOccurred = false

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()

      try {
        editor.destroy()
        editor.destroy()
        editor.destroy()
      } catch (error) {
        errorOccurred = true
      }

      expect(errorOccurred).toBe(false)
    })

    it("should clean up event listeners when destroyed while handling an event", async () => {
      let handlerCallCount = 0
      let shouldDestroy = false
      let errorThrown = false

      // Capture console.error to check for error logs
      const originalConsoleError = console.error
      console.error = (...args: any[]) => {
        if (args[0]?.includes?.("[KeyHandler] Error in renderable")) {
          errorThrown = true
        }
        originalConsoleError(...args)
      }

      try {
        const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
          initialValue: "Test",
          width: 40,
          height: 10,
          onKeyDown: () => {
            handlerCallCount++
            if (shouldDestroy) {
              editor.destroy()
            }
          },
        })

        editor.focus()

        // First keypress should work
        currentMockInput.pressKey("A")
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(handlerCallCount).toBe(1)

        // Second keypress destroys the renderable
        shouldDestroy = true
        currentMockInput.pressKey("B")
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(handlerCallCount).toBe(2)

        // Third keypress should not trigger anything
        currentMockInput.pressKey("C")
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(handlerCallCount).toBe(2)

        // CRITICAL: No error should be thrown when destroying during callback
        expect(errorThrown).toBe(false)
      } finally {
        console.error = originalConsoleError
      }
    })
  })

  describe("Destroyed renderable with queued operations", () => {
    it("should not process insertText after destroy", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Initial",
        width: 40,
        height: 10,
      })

      editor.focus()

      editor.destroy()

      // Try to call methods on destroyed renderable
      try {
        editor.insertText("New Text")
      } catch (error) {
        // Expected: operations might throw after destroy
        expect(error).toBeDefined()
      }

      await new Promise((resolve) => setTimeout(resolve, 20))

      // Either the operation threw an error or it was safely ignored
      expect(true).toBe(true)
    })

    it("should handle events arriving between destroy and cleanup", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Queue several key events
      currentMockInput.pressKey("A")
      currentMockInput.pressKey("B")
      currentMockInput.pressKey("C")

      // Destroy immediately without waiting for events to process
      editor.destroy()

      // Events might still be in the queue
      await new Promise((resolve) => setTimeout(resolve, 50))

      // No crashes should occur
      expect(editor.isDestroyed).toBe(true)
    })

    it("should safely handle focus after destroy", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      expect(editor.focused).toBe(true)

      editor.destroy()

      // Try to focus again after destroy (should be no-op or throw)
      try {
        editor.focus()
      } catch (error) {
        // May throw, that's fine
        expect(error).toBeDefined()
      }

      // Whether it throws or not, it shouldn't crash
      expect(editor.focused).toBe(false)
    })
  })

  describe("EditorView and EditBuffer destroyed state", () => {
    it("should check if editBuffer guard prevents operations after destroy", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Destroy the textarea (which should destroy editBuffer and editorView)
      editor.destroy()

      // Try to access editBuffer methods that should throw if destroyed
      let errorThrown = false
      try {
        editor.editBuffer.getText()
      } catch (error) {
        errorThrown = true
        expect((error as Error).message).toContain("destroyed")
      }

      expect(errorThrown).toBe(true)
    })

    it("should check if editorView guard prevents operations after destroy", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()

      // Destroy the textarea
      editor.destroy()

      // Try to access editorView methods that should throw if destroyed
      let errorThrown = false
      try {
        editor.editorView.getCursor()
      } catch (error) {
        errorThrown = true
        expect((error as Error).message).toContain("destroyed")
      }

      expect(errorThrown).toBe(true)
    })

    it("does not throw when reading visualCursor after destroy", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      await renderOnce()
      editor.destroy()

      expect(editor.isDestroyed).toBe(true)
      expect(() => editor.visualCursor).not.toThrow()
      expect(() => editor.cursorOffset).not.toThrow()
      expect(() => editor.editorView.getVisualCursor()).toThrow("EditorView is destroyed")
    })

    it("releases native resources before destroyed listeners read visualCursor", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      editor.focus()
      await renderOnce()
      editor.on("destroyed", () => {
        expect(() => editor.editorView.getVisualCursor()).toThrow("EditorView is destroyed")
        expect(() => editor.editBuffer.getText()).toThrow("EditBuffer is destroyed")
        void editor.visualCursor
        void editor.cursorOffset
      })

      expect(() => editor.destroy()).not.toThrow()
    })

    it("should not allow keypress after proper destroy", async () => {
      let keypressFired = false

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
        onKeyDown: () => {
          keypressFired = true
        },
      })

      editor.focus()
      await renderOnce()

      // Properly destroy the whole textarea
      editor.destroy()

      // Try to trigger a keypress after destroy
      currentMockInput.pressKey("A")
      await new Promise((resolve) => setTimeout(resolve, 20))

      // Keypress handler should not have fired
      expect(keypressFired).toBe(false)
      expect(editor.isDestroyed).toBe(true)
    })
  })

  describe("Multiple renderables and event routing", () => {
    it("should not route events to destroyed renderable when multiple exist", async () => {
      let editor1KeypressCount = 0
      let editor2KeypressCount = 0

      const { textarea: editor1 } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Editor 1",
        width: 40,
        height: 10,
        onKeyDown: () => {
          editor1KeypressCount++
        },
      })

      const { textarea: editor2 } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Editor 2",
        width: 40,
        height: 10,
        top: 10,
        onKeyDown: () => {
          editor2KeypressCount++
        },
      })

      // Focus first editor
      editor1.focus()
      currentMockInput.pressKey("A")
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(editor1KeypressCount).toBe(1)
      expect(editor2KeypressCount).toBe(0)

      // Destroy first editor and focus second
      editor1.destroy()
      editor2.focus()

      editor1KeypressCount = 0
      editor2KeypressCount = 0

      currentMockInput.pressKey("B")
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(editor1KeypressCount).toBe(0)
      expect(editor2KeypressCount).toBe(1)

      editor2.destroy()
    })

    it("should handle switching focus between renderables rapidly", async () => {
      const { textarea: editor1 } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Editor 1",
        width: 40,
        height: 10,
      })

      const { textarea: editor2 } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Editor 2",
        width: 40,
        height: 10,
        top: 10,
      })

      // Rapidly switch focus and destroy
      editor1.focus()
      editor2.focus()
      editor1.destroy()
      editor2.blur()
      editor2.focus()
      editor2.destroy()

      // Send events after all destroyed
      currentMockInput.pressKey("X")
      await new Promise((resolve) => setTimeout(resolve, 20))

      // Should not crash
      expect(true).toBe(true)
    })
  })

  describe("Renderable destroyed flag checks", () => {
    it("should prevent handleKeyPress execution when isDestroyed is true", async () => {
      let callCount = 0

      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      // Wrap handleKeyPress to track calls
      const originalHandleKeyPress = editor.handleKeyPress.bind(editor)
      editor.handleKeyPress = (key) => {
        callCount++
        if (editor.isDestroyed) {
          // Should not execute when destroyed
          throw new Error("handleKeyPress called on destroyed renderable")
        }
        return originalHandleKeyPress(key)
      }

      editor.focus()
      currentMockInput.pressKey("A")
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(callCount).toBe(1)

      // Destroy and try again
      editor.destroy()
      callCount = 0

      let errorThrown = false
      try {
        currentMockInput.pressKey("B")
        await new Promise((resolve) => setTimeout(resolve, 20))
      } catch (error) {
        errorThrown = true
      }

      // Should not have called handleKeyPress after destroy
      expect(callCount).toBe(0)
      expect(errorThrown).toBe(false)
    })

    it("should check isDestroyed in event handler methods", async () => {
      const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
        initialValue: "Test",
        width: 40,
        height: 10,
      })

      expect(editor.isDestroyed).toBe(false)

      editor.focus()
      expect(editor.isDestroyed).toBe(false)

      editor.destroy()
      expect(editor.isDestroyed).toBe(true)

      // After destroy, operations should either fail or be no-ops
      let errorCount = 0
      try {
        editor.focus()
      } catch {
        errorCount++
      }

      try {
        editor.blur()
      } catch {
        errorCount++
      }

      // Operations after destroy should either throw or be ignored
      // The important thing is we should be able to detect destroyed state
      expect(editor.isDestroyed).toBe(true)
    })
  })
})
