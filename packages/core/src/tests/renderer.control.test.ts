import { test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput, type MockMouse } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { RendererControlState } from "../renderer.js"
import { Renderable } from "../Renderable.js"
import { TextRenderable } from "../renderables/Text.js"
import { createTestStdout } from "../testing/test-streams.js"

class TestRenderable extends Renderable {
  constructor(renderer: TestRenderer, options: any) {
    super(renderer, options)
  }
}

let renderer: TestRenderer
let mockInput: MockInput
let mockMouse: MockMouse
let renderOnce: () => Promise<void>

beforeEach(async () => {
  ;({ renderer, mockInput, mockMouse, renderOnce } = await createTestRenderer({}))
  await renderer.setupTerminal()
})

afterEach(async () => {
  renderer.destroy()
  await renderer.closed
})

async function expectStartedResumeForcesNextRender(screenMode: "main-screen" | "alternate-screen"): Promise<void> {
  renderer.destroy()
  await renderer.closed
  let output = ""
  const stdout = createTestStdout()
  stdout._write = (chunk, _encoding, callback) => {
    output += chunk.toString()
    callback()
  }
  ;({ renderer, mockInput, mockMouse, renderOnce } = await createTestRenderer({
    screenMode,
    stdout,
    bufferedOutput: "stdout",
  }))
  await renderer.setupTerminal()
  renderer.root.add(new TextRenderable(renderer, { content: "resume repaint" }))
  await renderOnce()

  renderer.start()
  await renderer.suspend()
  output = ""

  await renderer.resume()
  await renderOnce()
  renderer.pause()
  await renderer.idle()

  expect(output).toContain("resume repaint")
  output = ""
  await renderOnce()
  expect(output).not.toContain("resume repaint")
}

test("initial renderer state is IDLE", () => {
  expect(renderer.controlState).toBe(RendererControlState.IDLE)
  expect(renderer.isRunning).toBe(false)
})

test("start() transitions to EXPLICIT_STARTED and starts rendering", () => {
  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)
})

test("pause() transitions to EXPLICIT_PAUSED and stops rendering", () => {
  renderer.start()
  expect(renderer.isRunning).toBe(true)

  renderer.pause()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  expect(renderer.isRunning).toBe(false)
})

test("suspend() transitions to EXPLICIT_SUSPENDED and stops rendering", async () => {
  renderer.start()
  expect(renderer.isRunning).toBe(true)

  await renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)
})

test("suspend() disables mouse and keyboard input", async () => {
  renderer.start()
  expect(renderer.useMouse).toBe(true)

  await renderer.suspend()
  expect(renderer.useMouse).toBe(false)
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
})

test("resume() restores previous EXPLICIT_STARTED state and restarts rendering", async () => {
  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)

  await renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  await renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)
})

test("resume() restores previous IDLE state without starting rendering", async () => {
  expect(renderer.controlState).toBe(RendererControlState.IDLE)
  expect(renderer.isRunning).toBe(false)

  await renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  await renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.IDLE)
  expect(renderer.isRunning).toBe(false)
})

test("resume() restores previous EXPLICIT_PAUSED state without starting rendering", async () => {
  renderer.start()
  renderer.pause()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  expect(renderer.isRunning).toBe(false)

  await renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  await renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  expect(renderer.isRunning).toBe(false)
})

test("resume() restores previous AUTO_STARTED state and restarts rendering", async () => {
  renderer.requestLive()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)

  await renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  await renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)
})

test("resume() forces the next main-screen render to fully repaint", async () => {
  await expectStartedResumeForcesNextRender("main-screen")
})

test("resume() forces the next alternate-screen render to fully repaint", async () => {
  await expectStartedResumeForcesNextRender("alternate-screen")
})

test("stop() transitions to EXPLICIT_STOPPED and stops rendering", () => {
  renderer.start()
  expect(renderer.isRunning).toBe(true)

  renderer.stop()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STOPPED)
  expect(renderer.isRunning).toBe(false)
})

test("requestRender() does not trigger when renderer is suspended", async () => {
  renderer.start()
  await renderer.suspend()
  const frames = renderer.getStats().nativeFrameCount

  renderer.requestRender()
  await renderer.idle()
  expect(renderer.getStats().nativeFrameCount).toBe(frames)
})

test("requestRender() does trigger when renderer is paused", async () => {
  renderer.destroy()
  await renderer.closed
  const clock = new ManualClock()
  ;({ renderer, mockInput, mockMouse, renderOnce } = await createTestRenderer({ clock }))

  renderer.start()
  renderer.pause()
  await renderer.idle()

  const frames = renderer.getStats().nativeFrameCount

  renderer.requestRender()
  clock.advance(20)
  await renderer.idle()

  expect(renderer.getStats().nativeFrameCount).toBe(frames + 1)
})

test("auto() transitions running renderer to AUTO_STARTED state", () => {
  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)

  renderer.auto()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)
})

test("requestLive() auto-starts idle renderer", () => {
  expect(renderer.controlState).toBe(RendererControlState.IDLE)
  expect(renderer.isRunning).toBe(false)

  renderer.requestLive()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)
})

test("dropLive() stops auto-started renderer when no live requests remain", () => {
  renderer.requestLive()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.dropLive()
  expect(renderer.controlState).toBe(RendererControlState.IDLE)
  expect(renderer.isRunning).toBe(false)
})

test("dropLive() does not stop explicitly started renderer", () => {
  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.requestLive()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)

  renderer.dropLive()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)
})

test("suspend() preserves live request state for resume", async () => {
  renderer.requestLive()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)

  await renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  await renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)
})

test("control state transitions maintain consistency", async () => {
  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.pause()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  expect(renderer.isRunning).toBe(false)

  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)

  await renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  await renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.auto()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.stop()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STOPPED)
  expect(renderer.isRunning).toBe(false)
})

test("multiple suspend/resume cycles work correctly", async () => {
  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)

  await renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  await renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)

  await renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  await renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)

  renderer.pause()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  await renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  await renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
})

test("keyboard input is suspended when renderer is suspended", async () => {
  renderer.start()

  let keyEventReceived = false
  const onKeypress = () => {
    keyEventReceived = true
  }
  renderer.keyInput.on("keypress", onKeypress)

  mockInput.pressKey("a")
  expect(keyEventReceived).toBe(true)

  keyEventReceived = false
  await renderer.suspend()

  mockInput.pressKey("b")
  expect(keyEventReceived).toBe(false)
  await renderer.resume()
  mockInput.pressKey("c")
  expect(keyEventReceived).toBe(true)
  renderer.keyInput.off("keypress", onKeypress)
})

test("mouse input is suspended when renderer is suspended", async () => {
  renderer.start()

  const testRenderable = new TestRenderable(renderer, {
    x: 0,
    y: 0,
    width: renderer.width,
    height: renderer.height,
  })
  renderer.root.add(testRenderable)
  await renderOnce()

  let mouseEventReceived = false
  testRenderable.onMouse = () => {
    mouseEventReceived = true
  }

  await mockMouse.click(0, 0)
  expect(mouseEventReceived).toBe(true)

  mouseEventReceived = false
  await renderer.suspend()

  await mockMouse.click(0, 0)
  expect(mouseEventReceived).toBe(false)

  await renderer.resume()
  await mockMouse.click(0, 0)
  expect(mouseEventReceived).toBe(true)

  renderer.root.remove(testRenderable)
  testRenderable.destroy()
})

test("paste input is suspended when renderer is suspended", async () => {
  renderer.start()

  let pasteEventReceived = false
  const onPaste = () => {
    pasteEventReceived = true
  }
  renderer.keyInput.on("paste", onPaste)

  mockInput.pasteBracketedText("pasted text")
  expect(pasteEventReceived).toBe(true)

  pasteEventReceived = false
  await renderer.suspend()

  mockInput.pasteBracketedText("pasted text 2")
  expect(pasteEventReceived).toBe(false)

  await renderer.resume()

  mockInput.pasteBracketedText("pasted text 3")
  expect(pasteEventReceived).toBe(true)

  renderer.keyInput.off("paste", onPaste)
})

test("keystrokes received immediately after resume() completes without another yield", async () => {
  renderer.start()

  const received: string[] = []
  const onKeypress = (e: { name: string }) => received.push(e.name)
  renderer.keyInput.on("keypress", onKeypress)

  await renderer.suspend()
  await renderer.resume()
  mockInput.pressKey("a")
  mockInput.pressKey("b")

  expect(received).toEqual(["a", "b"])
  renderer.keyInput.off("keypress", onKeypress)
})

test("keystrokes survive multiple rapid suspend/resume cycles", async () => {
  renderer.start()

  const received: string[] = []
  const onKeypress = (e: { name: string }) => received.push(e.name)
  renderer.keyInput.on("keypress", onKeypress)

  for (let i = 0; i < 5; i++) {
    await renderer.suspend()
    await renderer.resume()
  }
  mockInput.pressKey("a")

  expect(received).toEqual(["a"])
  renderer.keyInput.off("keypress", onKeypress)
})

test("input buffered during suspension is drained on resume", async () => {
  renderer.start()

  const received: string[] = []
  const onKeypress = (e: { name: string }) => received.push(e.name)
  renderer.keyInput.on("keypress", onKeypress)

  await renderer.suspend()
  // Simulate stale input accumulating in stdin's internal buffer during
  // suspension (e.g. from a child process or kernel line buffer).
  // push() writes to the Readable's internal buffer without emitting.
  renderer.stdin.push(Buffer.from("x"))
  await renderer.resume()
  mockInput.pressKey("a")

  // "x" should have been drained — only "a" received
  expect(received).toEqual(["a"])
  renderer.keyInput.off("keypress", onKeypress)
})

test("suspend/resume does not leak stdin listeners", async () => {
  renderer.start()
  const baseline = renderer.stdin.listenerCount("data")

  for (let i = 0; i < 10; i++) {
    await renderer.suspend()
    await renderer.resume()
  }

  expect(renderer.stdin.listenerCount("data")).toBe(baseline)
})
