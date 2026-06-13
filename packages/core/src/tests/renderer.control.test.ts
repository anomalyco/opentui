import { test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput, type MockMouse } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { RendererControlState } from "../renderer.js"
import { Renderable } from "../Renderable.js"

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
})

afterEach(() => {
  renderer.destroy()
})

async function expectStartedResumeForcesNextRender(screenMode: "main-screen" | "alternate-screen"): Promise<void> {
  renderer.destroy()
  ;({ renderer, mockInput, mockMouse, renderOnce } = await createTestRenderer({ screenMode }))
  ;(renderer as any)._terminalIsSetup = true

  renderer.start()
  renderer.suspend()

  const renderSpy = spyOn((renderer as any).lib, "render")
  renderer.resume()
  renderer.pause()

  const lastCall = renderSpy.mock.calls[renderSpy.mock.calls.length - 1]
  expect(lastCall?.[1]).toBe(true)
  expect((renderer as any).forceFullRepaintRequested).toBe(false)

  renderSpy.mockRestore()
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

test("suspend() transitions to EXPLICIT_SUSPENDED and stops rendering", () => {
  renderer.start()
  expect(renderer.isRunning).toBe(true)

  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)
})

test("suspend() disables mouse and keyboard input", () => {
  renderer.start()
  expect(renderer.useMouse).toBe(true)

  renderer.suspend()
  expect(renderer.useMouse).toBe(false)
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
})

test("resume() restores previous EXPLICIT_STARTED state and restarts rendering", () => {
  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)
})

test("resume() restores previous IDLE state without starting rendering", () => {
  expect(renderer.controlState).toBe(RendererControlState.IDLE)
  expect(renderer.isRunning).toBe(false)

  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.IDLE)
  expect(renderer.isRunning).toBe(false)
})

test("resume() restores previous EXPLICIT_PAUSED state without starting rendering", () => {
  renderer.start()
  renderer.pause()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  expect(renderer.isRunning).toBe(false)

  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  expect(renderer.isRunning).toBe(false)
})

test("resume() restores previous AUTO_STARTED state and restarts rendering", () => {
  renderer.requestLive()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  renderer.resume()
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
  renderer.suspend()

  let renderCalled = false
  // @ts-expect-error - renderNative is private
  const originalRender = renderer.renderNative.bind(renderer)
  // @ts-expect-error - renderNative is private
  renderer.renderNative = () => {
    renderCalled = true
    return originalRender()
  }

  renderer.requestRender()
  await Promise.resolve()

  expect(renderCalled).toBe(false)

  // @ts-expect-error - renderNative is private
  renderer.renderNative = originalRender
})

test("requestRender() does trigger when renderer is paused", async () => {
  renderer.destroy()
  const clock = new ManualClock()
  ;({ renderer, mockInput, mockMouse, renderOnce } = await createTestRenderer({ clock }))

  renderer.start()
  renderer.pause()
  await renderer.idle()

  let renderCalled = false
  // @ts-expect-error - renderNative is private
  const originalRender = renderer.renderNative.bind(renderer)
  // @ts-expect-error - renderNative is private
  renderer.renderNative = () => {
    renderCalled = true
    return originalRender()
  }

  renderer.requestRender()
  clock.advance(20)
  await renderer.idle()

  expect(renderCalled).toBe(true)

  // @ts-expect-error - renderNative is private
  renderer.renderNative = originalRender
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

test("suspend() preserves live request state for resume", () => {
  renderer.requestLive()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)
})

test("control state transitions maintain consistency", () => {
  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.pause()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  expect(renderer.isRunning).toBe(false)

  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  expect(renderer.isRunning).toBe(false)

  renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.auto()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)

  renderer.stop()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STOPPED)
  expect(renderer.isRunning).toBe(false)
})

test("multiple suspend/resume cycles work correctly", () => {
  renderer.start()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)

  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)

  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_STARTED)

  renderer.pause()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  renderer.suspend()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
  renderer.resume()
  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
})

test("keyboard input is suspended when renderer is suspended", () => {
  renderer.start()

  let keyEventReceived = false
  const onKeypress = () => {
    keyEventReceived = true
  }
  renderer.keyInput.on("keypress", onKeypress)

  mockInput.pressKey("a")
  expect(keyEventReceived).toBe(true)

  keyEventReceived = false
  renderer.suspend()

  mockInput.pressKey("b")
  expect(keyEventReceived).toBe(false)
  renderer.resume()
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
  renderer.suspend()

  await mockMouse.click(0, 0)
  expect(mouseEventReceived).toBe(false)

  renderer.resume()
  await mockMouse.click(0, 0)
  expect(mouseEventReceived).toBe(true)

  renderer.root.remove(testRenderable.id)
})

test("paste input is suspended when renderer is suspended", () => {
  renderer.start()

  let pasteEventReceived = false
  const onPaste = () => {
    pasteEventReceived = true
  }
  renderer.keyInput.on("paste", onPaste)

  mockInput.pasteBracketedText("pasted text")
  expect(pasteEventReceived).toBe(true)

  pasteEventReceived = false
  renderer.suspend()

  mockInput.pasteBracketedText("pasted text 2")
  expect(pasteEventReceived).toBe(false)

  renderer.resume()

  mockInput.pasteBracketedText("pasted text 3")
  expect(pasteEventReceived).toBe(true)

  renderer.keyInput.off("paste", onPaste)
})

test("keystrokes received immediately after resume() without yielding", () => {
  renderer.start()

  const received: string[] = []
  const onKeypress = (e: { name: string }) => received.push(e.name)
  renderer.keyInput.on("keypress", onKeypress)

  renderer.suspend()
  renderer.resume()
  mockInput.pressKey("a")
  mockInput.pressKey("b")

  expect(received).toEqual(["a", "b"])
  renderer.keyInput.off("keypress", onKeypress)
})

test("keystrokes survive multiple rapid suspend/resume cycles", () => {
  renderer.start()

  const received: string[] = []
  const onKeypress = (e: { name: string }) => received.push(e.name)
  renderer.keyInput.on("keypress", onKeypress)

  for (let i = 0; i < 5; i++) {
    renderer.suspend()
    renderer.resume()
  }
  mockInput.pressKey("a")

  expect(received).toEqual(["a"])
  renderer.keyInput.off("keypress", onKeypress)
})

test("input buffered during suspension is drained on resume", () => {
  renderer.start()

  const received: string[] = []
  const onKeypress = (e: { name: string }) => received.push(e.name)
  renderer.keyInput.on("keypress", onKeypress)

  renderer.suspend()
  // Simulate stale input accumulating in stdin's internal buffer during
  // suspension (e.g. from a child process or kernel line buffer).
  // push() writes to the Readable's internal buffer without emitting.
  renderer.stdin.push(Buffer.from("x"))
  renderer.resume()
  mockInput.pressKey("a")

  // "x" should have been drained — only "a" received
  expect(received).toEqual(["a"])
  renderer.keyInput.off("keypress", onKeypress)
})

test("suspend/resume does not leak stdin listeners", () => {
  renderer.start()
  const baseline = renderer.stdin.listenerCount("data")

  for (let i = 0; i < 10; i++) {
    renderer.suspend()
    renderer.resume()
  }

  expect(renderer.stdin.listenerCount("data")).toBe(baseline)
})
