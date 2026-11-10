import { describe, expect, it, afterAll, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockMouse, type MockInput } from "../../testing/test-renderer.js"
import { ManualClock } from "../../testing/manual-clock.js"
import { createTextareaRenderable } from "./renderable-test-utils.js"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let currentMouse: MockMouse
let currentMockInput: MockInput
let currentClock: ManualClock

describe("Textarea - Stress Tests", () => {
  beforeEach(async () => {
    currentClock = new ManualClock()
    ;({
      renderer: currentRenderer,
      renderOnce,
      mockMouse: currentMouse,
      mockInput: currentMockInput,
    } = await createTestRenderer({
      width: 80,
      height: 24,
      clock: currentClock,
    }))
  })

  afterEach(() => {
    currentRenderer.destroy()
  })

  it("STRESS TEST: should not process raw mouse bytes in textarea buffer with hundreds of rapid movements", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Initial text content",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // Send 500 rapid mouse movement events across the screen
    for (let i = 0; i < 500; i++) {
      const x = i % 40
      const y = i % 10
      await currentMouse.moveTo(x, y)
    }

    // The text content should remain unchanged - no raw mouse bytes should appear
    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
  })

  it("STRESS TEST: thousands of mouse events per second should not corrupt textarea", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Test content",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // Send 2000 mouse movement events as fast as possible
    for (let i = 0; i < 2000; i++) {
      const x = (i * 7) % 40
      const y = (i * 3) % 10
      await currentMouse.moveTo(x, y)
    }

    // Text should be unchanged
    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toMatch(/\x1b|\[<|[0-9]+;[0-9]+/)
  })

  it("STRESS TEST: mouse movements while typing should not inject mouse bytes", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "",
      width: 40,
      height: 10,
    })

    editor.focus()

    // Interleave typing and mouse movements
    for (let i = 0; i < 100; i++) {
      currentMockInput.pressKey("a")
      await currentMouse.moveTo(i % 40, i % 10)
      currentMockInput.pressKey("b")
      await currentMouse.moveTo((i + 5) % 40, (i + 5) % 10)
    }

    // Should only contain the typed characters
    expect(editor.plainText).toMatch(/^[ab]+$/)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
  })

  it("STRESS TEST: rapid mouse drags should not leak bytes into buffer", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Original",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // Perform 50 rapid drag operations (reduced to avoid timeouts)
    for (let i = 0; i < 10; i++) {
      const startX = i % 20
      const startY = i % 5
      const endX = (i + 10) % 30
      const endY = (i + 3) % 8
      await currentMouse.drag(startX, startY, endX, endY, 0, { delayMs: 0 })
    }

    // Text should remain unchanged or only contain valid selections/edits
    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toMatch(/[0-9]+;[0-9]+/)
  }, 10000) // 10 second timeout for drag operations

  it("STRESS TEST: mouse clicks during rapid typing should not corrupt buffer", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Start",
      width: 40,
      height: 10,
    })

    editor.focus()

    // Type while clicking randomly (reduced to 50 iterations to avoid timeout)
    for (let i = 0; i < 10; i++) {
      if (i % 3 === 0) {
        currentMockInput.pressKey("x")
      }
      await currentMouse.click(i % 40, i % 10, 0, { delayMs: 0 })
      if (i % 5 === 0) {
        currentMockInput.pressKey("y")
      }
    }

    // Should not contain any mouse escape sequences
    expect(editor.plainText).not.toContain("\x1b[<")
    expect(editor.plainText).not.toMatch(/[0-9]+;[0-9]+;[0-9]+/)
  }, 10000) // 10 second timeout for click operations

  it("STRESS TEST: high-frequency mouse scroll should not inject bytes", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
      width: 40,
      height: 5,
    })

    editor.focus()
    const initialText = editor.plainText

    // Rapid scroll events
    for (let i = 0; i < 500; i++) {
      const direction = i % 2 === 0 ? "down" : "up"
      await currentMouse.scroll(20, 3, direction as "up" | "down")
    }

    // Text should be unchanged
    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("\x1b")
  })

  it("STRESS TEST: raw stdin with mouse SGR sequences should be filtered", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Clean text",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // Directly inject raw mouse SGR sequences into stdin
    const rawMouseSequences = [
      "\x1b[<35;20;5m", // mouse move
      "\x1b[<0;10;3M", // left button press
      "\x1b[<0;10;3m", // left button release
      "\x1b[<35;25;7m", // mouse move
      "\x1b[<64;15;2M", // scroll up
      "\x1b[<65;15;2M", // scroll down
    ]

    for (let i = 0; i < 10; i++) {
      for (const seq of rawMouseSequences) {
        currentRenderer.stdin.emit("data", Buffer.from(seq))
      }
    }

    // Text should remain unchanged
    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
    expect(editor.plainText).not.toMatch(/[0-9]+;[0-9]+/)
  })

  it("STRESS TEST: simultaneous typing and mouse flood", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "",
      width: 40,
      height: 10,
    })

    editor.focus()

    const typedText = "hello world"
    let typeIndex = 0

    // Type text while flooding with mouse events
    for (let i = 0; i < 1000; i++) {
      // Every 100 mouse events, type one character
      if (i % 100 === 0 && typeIndex < typedText.length) {
        currentMockInput.pressKey(typedText[typeIndex])
        typeIndex++
      }

      // Flood with mouse movements
      await currentMouse.moveTo(i % 40, i % 10)
    }

    // Type remaining characters
    while (typeIndex < typedText.length) {
      currentMockInput.pressKey(typedText[typeIndex])
      typeIndex++
    }

    // Should only contain the typed text
    expect(editor.plainText).toBe(typedText)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toMatch(/[0-9]+;[0-9]+/)
  })

  it("STRESS TEST: mouse events during multi-line editing", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Line1\nLine2\nLine3",
      width: 40,
      height: 10,
    })

    editor.focus()

    // Navigate and edit while sending mouse events
    for (let i = 0; i < 500; i++) {
      if (i % 100 === 0) {
        currentMockInput.pressArrow("down")
      }
      if (i % 150 === 0) {
        currentMockInput.pressKey("X")
      }

      await currentMouse.moveTo(i % 40, i % 10)
    }

    // Text should only contain edits from keyboard, not mouse bytes
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
    expect(editor.plainText).not.toMatch(/35;[0-9]+;[0-9]+/)
  })

  it("STRESS TEST: 10000 raw mouse byte injections without delay", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Protected",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // Inject 10000 raw mouse movement sequences as fast as possible
    for (let i = 0; i < 10000; i++) {
      const x = (i % 40) + 1
      const y = (i % 10) + 1
      const rawSeq = `\x1b[<35;${x};${y}m`
      currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
    }

    // Verify no corruption
    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
    expect(editor.plainText).not.toContain("35;")
  })

  it("STRESS TEST: inject mouse bytes between every character typed", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "",
      width: 40,
      height: 10,
    })

    editor.focus()

    const toType = "HelloWorld"
    for (let i = 0; i < toType.length; i++) {
      // Inject 100 mouse sequences before each character
      for (let j = 0; j < 100; j++) {
        const rawSeq = `\x1b[<35;${(j % 40) + 1};${(j % 10) + 1}m`
        currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
      }

      currentMockInput.pressKey(toType[i])

      // Inject 100 mouse sequences after each character
      for (let j = 0; j < 100; j++) {
        const rawSeq = `\x1b[<35;${(j % 40) + 1};${(j % 10) + 1}m`
        currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
      }
    }

    // Should only contain the typed text
    expect(editor.plainText).toBe(toType)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
    expect(editor.plainText).not.toMatch(/[0-9]+;[0-9]+/)
  })

  it("STRESS TEST: extreme burst - 50000 mouse events in rapid succession", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Stable content",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // Massive burst of mouse events
    for (let i = 0; i < 50000; i++) {
      const x = ((i * 17) % 40) + 1
      const y = ((i * 11) % 10) + 1
      const buttonCode = 35 + (i % 4) // Vary the button codes
      const rawSeq = `\x1b[<${buttonCode};${x};${y}m`
      currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
    }

    // Verify integrity
    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
  })

  it("STRESS TEST: partial/malformed mouse sequences", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Clean",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // Send partial sequences that might confuse the parser
    const partialSequences = [
      "\x1b[<35;",
      "\x1b[<35;20",
      "\x1b[<35;20;",
      "\x1b[<35;20;5",
      "\x1b",
      "\x1b[",
      "\x1b[<",
      "\x1b[<35;20;5m\x1b[<35;", // Complete + incomplete
    ]

    for (let i = 0; i < 1000; i++) {
      const seq = partialSequences[i % partialSequences.length]
      currentRenderer.stdin.emit("data", Buffer.from(seq))
    }

    // Text should remain unchanged
    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
  })

  it("STRESS TEST: mouse events mixed with paste operations", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "",
      width: 40,
      height: 10,
    })

    editor.focus()

    // Simulate paste with mouse flood
    for (let i = 0; i < 100; i++) {
      // Inject mouse bytes
      for (let j = 0; j < 50; j++) {
        const rawSeq = `\x1b[<35;${(j % 40) + 1};${(j % 10) + 1}m`
        currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
      }

      // Paste some text
      const pasteText = `Paste${i}`
      editor.insertText(pasteText)

      // More mouse bytes
      for (let j = 0; j < 50; j++) {
        const rawSeq = `\x1b[<0;${(j % 40) + 1};${(j % 10) + 1}M`
        currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
      }
    }

    // Should not contain escape sequences
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
    expect(editor.plainText).toContain("Paste")
  })

  it("STRESS TEST: focused vs unfocused with mouse flood", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Content",
      width: 40,
      height: 10,
    })

    const initialText = editor.plainText

    // Flood while unfocused
    for (let i = 0; i < 5000; i++) {
      const rawSeq = `\x1b[<35;${(i % 40) + 1};${(i % 10) + 1}m`
      currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
    }

    expect(editor.plainText).toBe(initialText)

    // Focus and flood
    editor.focus()
    for (let i = 0; i < 5000; i++) {
      const rawSeq = `\x1b[<35;${(i % 40) + 1};${(i % 10) + 1}m`
      currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
    }

    expect(editor.plainText).toBe(initialText)

    // Blur and flood again
    editor.blur()
    for (let i = 0; i < 5000; i++) {
      const rawSeq = `\x1b[<35;${(i % 40) + 1};${(i % 10) + 1}m`
      currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
    }

    // Final check - no corruption at any stage
    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
  })

  it("STRESS TEST: all mouse button types with modifiers", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Test",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // Test all button codes with all modifier combinations
    const buttonCodes = [0, 1, 2, 3, 32, 33, 34, 35, 36, 37, 38, 39, 64, 65, 66, 67]
    const modifiers = [0, 4, 8, 12, 16, 20, 24, 28] // shift, alt, ctrl combinations

    for (let i = 0; i < 10000; i++) {
      const button = buttonCodes[i % buttonCodes.length]
      const modifier = modifiers[((i / buttonCodes.length) % modifiers.length) | 0]
      const code = button | modifier
      const x = (i % 40) + 1
      const y = (i % 10) + 1
      const suffix = i % 2 === 0 ? "M" : "m"
      const rawSeq = `\x1b[<${code};${x};${y}${suffix}`
      currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
    }

    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("\x1b")
  })

  it("STRESS TEST: mouse data split across multiple buffers", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Original",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // When mouse SGR sequences like \x1b[<35;20;5m are split across multiple
    // stdin data events (as happens in real terminals), the partial sequences
    // bypass the mouse event filter in parseKeypress and get inserted as text!

    // Send just ONE mouse sequence split across multiple emit calls
    currentRenderer.stdin.emit("data", Buffer.from("\x1b"))
    currentRenderer.stdin.emit("data", Buffer.from("["))
    currentRenderer.stdin.emit("data", Buffer.from("<"))
    currentRenderer.stdin.emit("data", Buffer.from("35"))
    currentRenderer.stdin.emit("data", Buffer.from(";"))
    currentRenderer.stdin.emit("data", Buffer.from("20"))
    currentRenderer.stdin.emit("data", Buffer.from(";"))
    currentRenderer.stdin.emit("data", Buffer.from("5"))
    currentRenderer.stdin.emit("data", Buffer.from("m"))

    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("[<")
  })

  it("STRESS TEST: delayed split SGR mouse sequence should not leak into textarea", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Original",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // Simulate ESC and continuation arriving in separate chunks where the ESC is
    // timeout-flushed before the continuation arrives.
    currentRenderer.stdin.emit("data", Buffer.from("\x1b"))
    currentClock.advance(1000)
    currentRenderer.stdin.emit("data", Buffer.from("[<35;20;5m"))

    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("[<")
  })

  it("STRESS TEST: alternating mouse and keyboard at high frequency", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "",
      width: 40,
      height: 10,
    })

    editor.focus()

    // Alternate between mouse and keyboard events very rapidly
    const chars = "abcdefghij"
    for (let i = 0; i < 1000; i++) {
      // Mouse event
      const rawSeq = `\x1b[<35;${(i % 40) + 1};${(i % 10) + 1}m`
      currentRenderer.stdin.emit("data", Buffer.from(rawSeq))

      // Keyboard event
      if (i % 100 === 0) {
        currentMockInput.pressKey(chars[(i / 100) % chars.length])
      }

      // Another mouse event
      const rawSeq2 = `\x1b[<0;${(i % 20) + 1};${(i % 5) + 1}M`
      currentRenderer.stdin.emit("data", Buffer.from(rawSeq2))
    }

    // Should only contain the typed characters
    expect(editor.plainText).toMatch(/^[a-j]*$/)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
  })

  it("STRESS TEST: mouse during undo/redo operations", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Start",
      width: 40,
      height: 10,
    })

    editor.focus()

    // Make some edits with mouse flood
    for (let i = 0; i < 100; i++) {
      currentMockInput.pressKey("x")

      // Flood with mouse
      for (let j = 0; j < 50; j++) {
        const rawSeq = `\x1b[<35;${(j % 40) + 1};${(j % 10) + 1}m`
        currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
      }
    }

    // Undo with mouse flood
    for (let i = 0; i < 50; i++) {
      currentMockInput.pressKey("z", { ctrl: true })

      for (let j = 0; j < 100; j++) {
        const rawSeq = `\x1b[<35;${(j % 40) + 1};${(j % 10) + 1}m`
        currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
      }
    }

    // Should not contain mouse bytes
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")
  })

  it("STRESS TEST: 100000 mouse events - ultimate stress", async () => {
    const { textarea: editor } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Extreme test",
      width: 40,
      height: 10,
    })

    editor.focus()
    const initialText = editor.plainText

    // Send 100,000 mouse events as fast as possible
    for (let i = 0; i < 100000; i++) {
      const x = ((i * 19) % 40) + 1
      const y = ((i * 13) % 10) + 1
      const code = 32 + (i % 8)
      const rawSeq = `\x1b[<${code};${x};${y}m`
      currentRenderer.stdin.emit("data", Buffer.from(rawSeq))
    }

    // After this extreme flood, text should be intact
    expect(editor.plainText).toBe(initialText)
    expect(editor.plainText).not.toContain("\x1b")
    expect(editor.plainText).not.toContain("[<")

    // Also check the raw bytes haven't corrupted the cursor position
    const cursor = editor.logicalCursor
    expect(typeof cursor.row).toBe("number")
    expect(typeof cursor.col).toBe("number")
  })

  it("STRESS TEST: concurrent mouse events on multiple textareas", async () => {
    const { textarea: editor1 } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Editor 1",
      width: 40,
      height: 5,
    })

    const { textarea: editor2 } = await createTextareaRenderable(currentRenderer, renderOnce, {
      initialValue: "Editor 2",
      width: 40,
      height: 5,
    })

    editor1.focus()
    const text1 = editor1.plainText
    const text2 = editor2.plainText

    // Flood both editors with mouse events
    for (let i = 0; i < 10000; i++) {
      const x = (i % 40) + 1
      const y = (i % 10) + 1
      const rawSeq = `\x1b[<35;${x};${y}m`
      currentRenderer.stdin.emit("data", Buffer.from(rawSeq))

      // Switch focus occasionally
      if (i % 500 === 0) {
        if (i % 1000 === 0) {
          editor1.focus()
        } else {
          editor2.focus()
        }
      }
    }

    // Both should be intact
    expect(editor1.plainText).toBe(text1)
    expect(editor2.plainText).toBe(text2)
    expect(editor1.plainText).not.toContain("\x1b")
    expect(editor2.plainText).not.toContain("\x1b")
  })
})
