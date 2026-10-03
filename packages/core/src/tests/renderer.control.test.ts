import { test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockInput, type MockMouse } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { CliRenderEvents, RendererControlState } from "../renderer.js"
import { Renderable } from "../Renderable.js"
import { TextRenderable } from "../renderables/Text.js"
import { RecordingWriteStream } from "../testing/test-streams.js"

class TestRenderable extends Renderable {
  constructor(renderer: TestRenderer, options: any) {
    super(renderer, options)
  }
}

let renderer: TestRenderer
let mockInput: MockInput
let mockMouse: MockMouse
let renderOnce: () => Promise<void>
let captureCharFrame: () => string

beforeEach(async () => {
  ;({ renderer, mockInput, mockMouse, renderOnce, captureCharFrame } = await createTestRenderer({}))
  await renderer.setupTerminal()
})

afterEach(async () => {
  renderer.destroy()
  await renderer.closed
})

type ControlStep = "start" | "pause" | "stop" | "auto" | "live" | "drop" | "raf" | "cancelRaf" | "suspend" | "resume"

const IDLE = RendererControlState.IDLE
const AUTO = RendererControlState.AUTO_STARTED
const STARTED = RendererControlState.EXPLICIT_STARTED
const PAUSED = RendererControlState.EXPLICIT_PAUSED
const STOPPED = RendererControlState.EXPLICIT_STOPPED
const SUSPENDED = RendererControlState.EXPLICIT_SUSPENDED

// Each row runs its steps from a set-up IDLE renderer and checks the final control state.
const controlCases: Array<[steps: ControlStep[], state: RendererControlState, running: boolean, live?: number]> = [
  [[], IDLE, false],
  [["start"], STARTED, true],
  [["start", "pause"], PAUSED, false],
  [["start", "stop"], STOPPED, false],
  [["start", "auto"], AUTO, true],
  [["auto"], IDLE, false],
  [["live"], AUTO, true, 1],
  [["live", "drop"], IDLE, false],
  [["start", "live", "drop"], STARTED, true],
  [["start", "suspend"], SUSPENDED, false],
  [["suspend", "resume"], IDLE, false],
  [["start", "suspend", "resume"], STARTED, true],
  [["start", "pause", "suspend", "resume"], PAUSED, false],
  [["live", "suspend", "resume"], AUTO, true, 1],
  [["start", "pause", "start", "suspend", "resume", "auto", "stop"], STOPPED, false],
  [["start", "suspend", "resume", "suspend", "resume", "pause", "suspend", "resume"], PAUSED, false],
  // Live owners added or removed while suspended decide whether resume restarts automatic rendering.
  [["raf", "suspend", "cancelRaf", "resume"], IDLE, false],
  [["start", "raf", "suspend", "cancelRaf", "resume"], STARTED, true],
  [["start", "auto", "suspend", "resume"], AUTO, true],
  [["raf", "suspend", "cancelRaf", "live", "resume"], AUTO, true, 1],
  [["suspend", "live", "resume"], AUTO, true, 1],
  [["suspend", "live", "drop", "resume"], IDLE, false],
]

for (const [steps, state, running, live = 0] of controlCases) {
  test(`control steps [${steps.join(", ")}] end ${state}`, async () => {
    let frame = -1
    for (const step of steps) {
      if (step === "raf") frame = renderer.requestAnimationFrame(() => {})
      else if (step === "cancelRaf") renderer.cancelAnimationFrame(frame)
      else if (step === "live") renderer.requestLive()
      else if (step === "drop") renderer.dropLive()
      else await renderer[step]()
    }
    const suspended = state === SUSPENDED
    expect({
      state: renderer.controlState,
      running: renderer.isRunning,
      live: renderer.liveRequestCount,
      mouse: renderer.useMouse,
    }).toEqual({ state, running, live, mouse: !suspended })
  })
}

test("dropping the last live owner keeps a pending render", async () => {
  const text = new TextRenderable(renderer, { content: "before" })
  renderer.root.add(text)
  await renderOnce()
  renderer.requestLive()
  text.content = "after"
  renderer.dropLive()
  expect(renderer.isRunning).toBe(false)
  await renderer.idle()
  expect(captureCharFrame()).toContain("after")
})

for (const screenMode of ["main-screen", "alternate-screen"] as const) {
  test(`resume() forces the next ${screenMode} render to fully repaint`, async () => {
    renderer.destroy()
    await renderer.closed
    const stdout = new RecordingWriteStream()
    ;({ renderer, mockInput, mockMouse, renderOnce } = await createTestRenderer({
      screenMode,
      stdout: stdout as unknown as NodeJS.WriteStream,
      bufferedOutput: "stdout",
    }))
    await renderer.setupTerminal()
    renderer.root.add(new TextRenderable(renderer, { content: "resume repaint" }))
    await renderOnce()

    renderer.start()
    await renderer.suspend()
    stdout.clear()

    await renderer.resume()
    await renderOnce()
    renderer.pause()
    await renderer.idle()

    expect(stdout.text()).toContain("resume repaint")
    stdout.clear()
    await renderOnce()
    expect(stdout.text()).not.toContain("resume repaint")
  })
}

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

const transitionsDuringFrame = {
  suspend: async (target: TestRenderer) => {
    await target.suspend()
    await target.resume()
  },
  setupTerminal: (target: TestRenderer) => target.setupTerminal(),
}

for (const [transition, run] of Object.entries(transitionsDuringFrame)) {
  test(`a screen mode set during a frame waits for a ${transition} that starts before the frame ends`, async () => {
    renderer.destroy()
    await renderer.closed
    const stdout = new RecordingWriteStream()
    ;({ renderer, renderOnce } = await createTestRenderer({
      screenMode: "main-screen",
      stdout: stdout as unknown as NodeJS.WriteStream,
      bufferedOutput: "stdout",
    }))
    if (transition !== "setupTerminal") await renderer.setupTerminal()
    const errors: unknown[] = []
    renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    renderer.setFrameCallback(async () => {
      entered.resolve()
      await gate.promise
    })
    const frame = renderOnce()
    await entered.promise
    renderer.screenMode = "alternate-screen"
    stdout.clear()
    const transitioned = run(renderer)
    gate.resolve()

    await frame
    await transitioned
    await renderOnce()

    expect({ mode: renderer.screenMode, errors }).toEqual({ mode: "alternate-screen", errors: [] })
    expect(stdout.text()).toContain("\x1b[?1049h")
  })
}
