# Testing Utilities

Test utilities for opentui terminal UI testing.

## Test Renderer

```ts
import { createTestRenderer } from "@opentui/core/testing"

const { renderer, mockInput, mockMouse, renderOnce, captureCharFrame, resize } = await createTestRenderer({
  width: 80,
  height: 24,
})

// Render once and capture output
await renderOnce()
const output = captureCharFrame()

// Resize terminal
resize(100, 30)
```

## Terminal Capabilities

```ts
import { createTerminalCapabilities, setRendererCapabilities } from "@opentui/core/testing"

const capabilities = createTerminalCapabilities({ kitty_keyboard: true })
setRendererCapabilities(renderer, { notifications: true })
```

## Mock Keyboard Input

```ts
import { createMockKeys, KeyCodes } from "@opentui/core/testing"

const mockInput = createMockKeys(renderer)

// Type text
mockInput.typeText("hello world")
await mockInput.typeText("hello", 10) // 10ms delay between keys

// Press single keys
mockInput.pressKey("a")
mockInput.pressKey(KeyCodes.ENTER)

// Press keys with modifiers
mockInput.pressKey("a", { ctrl: true })
mockInput.pressKey("f", { meta: true })
mockInput.pressKey("z", { ctrl: true, shift: true })
mockInput.pressKey(KeyCodes.ARROW_LEFT, { meta: true })

// Press multiple keys
mockInput.pressKeys(["h", "e", "l", "l", "o"])
await mockInput.pressKeys(["a", "b"], 10) // with delay

// Convenience methods
mockInput.pressEnter()
mockInput.pressEnter({ meta: true })
mockInput.pressEscape()
mockInput.pressTab()
mockInput.pressBackspace()
mockInput.pressArrow("up" | "down" | "left" | "right")
mockInput.pressArrow("left", { meta: true })
mockInput.pressCtrlC()
mockInput.pasteBracketedText("paste content")
```

### KeyCodes

Special keycodes available: `RETURN`, `LINEFEED`, `TAB`, `BACKSPACE`, `DELETE`, `HOME`, `END`, `ESCAPE`, `ARROW_UP`, `ARROW_DOWN`, `ARROW_LEFT`, `ARROW_RIGHT`, `F1`-`F12`

### Modifiers

All `pressKey()`, `pressEnter()`, `pressEscape()`, `pressTab()`, `pressBackspace()`, and `pressArrow()` methods support an optional modifiers object:

```ts
{ ctrl?: boolean; shift?: boolean; meta?: boolean }
```

## Mock Mouse Input

```ts
import { createMockMouse, MouseButtons } from "@opentui/core/testing"

const mockMouse = createMockMouse(renderer)

// Click
await mockMouse.click(x, y)
await mockMouse.click(x, y, MouseButtons.RIGHT)
await mockMouse.click(x, y, MouseButtons.LEFT, {
  modifiers: { ctrl: true, shift: true, alt: true },
  delayMs: 10,
})

// Double click
await mockMouse.doubleClick(x, y)

// Press and release
await mockMouse.pressDown(x, y, MouseButtons.MIDDLE)
await mockMouse.release(x, y, MouseButtons.MIDDLE)

// Move
await mockMouse.moveTo(x, y)
await mockMouse.moveTo(x, y, { modifiers: { shift: true } })

// Drag
await mockMouse.drag(startX, startY, endX, endY)
await mockMouse.drag(startX, startY, endX, endY, MouseButtons.RIGHT, {
  modifiers: { alt: true },
})

// Scroll
await mockMouse.scroll(x, y, "up" | "down" | "left" | "right")
await mockMouse.scroll(x, y, "up", { modifiers: { shift: true } })

// State
const pos = mockMouse.getCurrentPosition() // { x, y }
const buttons = mockMouse.getPressedButtons() // MouseButton[]
```

### MouseButtons

`LEFT` (0), `MIDDLE` (1), `RIGHT` (2)

`WHEEL_UP` (64), `WHEEL_DOWN` (65), `WHEEL_LEFT` (66), `WHEEL_RIGHT` (67)

## Spy

Simple function spy for testing callbacks.

```ts
import { createSpy } from "@opentui/core/testing"

const spy = createSpy()

// Use as callback
someFunction(spy)

// Assertions
spy.callCount() // number
spy.calledWith(arg1, arg2) // boolean
spy.calls // any[][]
spy.reset()
```

## Test Recorder

Record frames during rendering for testing or analysis.

```ts
import { TestRecorder } from "@opentui/core/testing"

const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 24 })
const recorder = new TestRecorder(renderer)

// Start recording
recorder.rec()

// Add content and trigger renders
const text = new TextRenderable(renderer, { content: "Hello" })
renderer.root.add(text)
await Bun.sleep(1) // Wait for automatic render from add()

text.content = "World"
await Bun.sleep(1) // Wait for automatic render from content change

// Stop recording
recorder.stop()

// Access recorded frames
const frames = recorder.recordedFrames
console.log(`Recorded ${frames.length} frames`)

frames.forEach((frame) => {
  console.log(`Frame ${frame.frameNumber} at ${frame.timestamp}ms:`)
  console.log(frame.frame)
})

// Clear and start new recording
recorder.clear()
recorder.rec()
```

### TestRecorder API

- `rec()` - Start recording frames
- `stop()` - Stop recording frames
- `clear()` - Clear all recorded frames
- `isRecording` - Check if currently recording
- `recordedFrames` - Get array of recorded frames (returns a copy)

### RecordedFrame

Each frame contains:

- `frame: string` - The captured frame content
- `timestamp: number` - Time in milliseconds since recording started
- `frameNumber: number` - Sequential frame number (0-indexed)

## Example

```ts
import { test, expect } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

test("button click", async () => {
  const { renderer, mockMouse, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24 })

  const clicked = createSpy()
  const button = new Button("btn", { text: "Click me", onClick: clicked })

  renderer.add(button)
  await renderOnce()

  await mockMouse.click(10, 5)
  expect(clicked.callCount()).toBe(1)
})
```
