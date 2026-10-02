import { test, expect, beforeEach, afterEach, describe } from "bun:test"
import { Buffer } from "node:buffer"
import { createTestRenderer, type TestRenderer, type MockInput, type MockMouse } from "../testing/test-renderer.js"
import { Renderable } from "../Renderable.js"
import { ManualClock } from "../testing/manual-clock.js"
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
let output: string
let clock: ManualClock

beforeEach(async () => {
  clock = new ManualClock()
  output = ""
  const stdout = createTestStdout()
  stdout._write = (chunk, _encoding, callback) => {
    output += chunk.toString()
    callback()
  }
  ;({ renderer, mockInput, mockMouse, renderOnce } = await createTestRenderer({
    useMouse: true,
    clock,
    stdout,
    bufferedOutput: "stdout",
  }))
  await renderer.setupTerminal()
  await renderer.idle()
  output = ""
})

afterEach(async () => {
  renderer.destroy()
  await renderer.closed
})

describe("focus restore - terminal mode re-enable on focus-in", () => {
  test("terminal modes are NOT restored on focus-in without prior blur", async () => {
    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    await renderer.idle()
    expect(output).not.toContain("\x1b[?2004h")
  })

  test("terminal modes are restored once after blur then focus-in", async () => {
    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    await renderer.idle()
    expect(output.split("\x1b[?2004h")).toHaveLength(2)
  })

  test("terminal modes are NOT restored on blur event", async () => {
    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)

    await renderer.idle()
    expect(output).not.toContain("\x1b[?2004h")
  })

  test("terminal modes are restored before output from the focus event after blur", async () => {
    renderer.on("focus", () => {
      renderer.setTerminalTitle("focus-event")
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    await renderer.idle()
    const restore = output.indexOf("\x1b[?2004h")
    expect(restore).toBeGreaterThanOrEqual(0)
    expect(output.indexOf("focus-event")).toBeGreaterThan(restore)
  })

  test("repeated focus-in events only restore once per blur cycle", async () => {
    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    await renderer.idle()
    expect(output.split("\x1b[?2004h")).toHaveLength(2)
  })

  test("multiple blur/focus cycles each trigger one restore", async () => {
    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    await renderer.idle()
    expect(output.split("\x1b[?2004h")).toHaveLength(3)
  })

  test("focus-in emits focus event on the renderer", async () => {
    const events: string[] = []

    renderer.on("focus", () => {
      events.push("focus")
    })

    renderer.on("blur", () => {
      events.push("blur")
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)

    expect(events).toEqual(["focus", "blur"])
  })

  test("duplicate focus and blur sequences only emit transitions once", async () => {
    const events: string[] = []

    renderer.on("focus", () => {
      events.push("focus")
    })

    renderer.on("blur", () => {
      events.push("blur")
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)
    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)
    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)
    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)

    expect(events).toEqual(["blur", "focus", "blur"])
  })

  test("focus events do not trigger keypress events", async () => {
    const keypresses: any[] = []

    renderer.keyInput.on("keypress", (event) => {
      keypresses.push(event)
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)
    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)

    expect(keypresses).toHaveLength(0)
  })

  test("mouse events work after focus restore cycle", async () => {
    const target = new TestRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: renderer.width,
      height: renderer.height,
    })
    renderer.root.add(target)
    renderer.start()
    await renderOnce()
    renderer.pause()
    await renderer.idle()

    let mouseEventCount = 0
    target.onMouse = () => {
      mouseEventCount++
    }

    // Verify mouse works initially
    await mockMouse.click(5, 5)
    expect(mouseEventCount).toBeGreaterThan(0)

    const countBefore = mouseEventCount

    // Simulate focus loss and regain
    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)
    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    await renderer.idle()
    expect(output.split("\x1b[?2004h")).toHaveLength(2)

    // Verify mouse still works after focus restore
    await mockMouse.click(5, 5)
    expect(mouseEventCount).toBeGreaterThan(countBefore)

    renderer.root.remove(target)
    target.destroy()
  })

  test("keyboard input works after focus restore cycle", async () => {
    renderer.start()

    let keyEventCount = 0
    const onKeypress = () => {
      keyEventCount++
    }
    renderer.keyInput.on("keypress", onKeypress)

    // Verify keyboard works initially
    mockInput.pressKey("a")
    clock.advance(15)
    expect(keyEventCount).toBeGreaterThan(0)

    const countBefore = keyEventCount

    // Simulate focus loss and regain
    renderer.stdin.emit("data", Buffer.from("\x1b[O"))
    clock.advance(15)
    renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    clock.advance(15)

    // Verify keyboard still works after focus restore
    mockInput.pressKey("b")
    clock.advance(15)
    expect(keyEventCount).toBeGreaterThan(countBefore)

    renderer.keyInput.off("keypress", onKeypress)
  })

  test("rapid focus toggle does not cause issues", async () => {
    // Simulate rapid alt-tab back and forth
    for (let i = 0; i < 10; i++) {
      renderer.stdin.emit("data", Buffer.from("\x1b[O"))
      renderer.stdin.emit("data", Buffer.from("\x1b[I"))
    }
    clock.advance(15)

    await renderer.idle()
    expect(output.split("\x1b[?2004h")).toHaveLength(11)
  })
})
