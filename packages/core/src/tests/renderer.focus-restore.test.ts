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

function emitFocus(sequence: string): void {
  for (const change of sequence) {
    renderer.stdin.emit("data", Buffer.from(change === "O" ? "\x1b[O" : "\x1b[I"))
    clock.advance(15)
  }
}

describe("focus restore - terminal mode re-enable on focus-in", () => {
  // O = focus out, I = focus in. Modes are restored on the first focus-in after each blur; events fire on changes.
  const cases: Array<[sequence: string, restores: number, events: string[]]> = [
    ["I", 0, ["focus"]],
    ["O", 0, ["blur"]],
    ["IO", 0, ["focus", "blur"]],
    ["OI", 1, ["blur", "focus"]],
    ["OIII", 1, ["blur", "focus"]],
    ["OIOI", 2, ["blur", "focus", "blur", "focus"]],
    ["OOIIOO", 1, ["blur", "focus", "blur"]],
    ["OI".repeat(10), 10, Array.from({ length: 10 }, () => ["blur", "focus"]).flat()],
  ]

  for (const [sequence, restores, events] of cases) {
    test(`focus changes ${sequence} restore modes ${restores} times`, async () => {
      const seen: string[] = []
      renderer.on("focus", () => seen.push("focus"))
      renderer.on("blur", () => seen.push("blur"))
      let keypresses = 0
      renderer.keyInput.on("keypress", () => keypresses++)

      emitFocus(sequence)
      await renderer.idle()

      expect({ restores: output.split("\x1b[?2004h").length - 1, events: seen, keypresses }).toEqual({
        restores,
        events,
        keypresses: 0,
      })
    })
  }

  test("terminal modes are restored before output from the focus event after blur", async () => {
    renderer.on("focus", () => {
      renderer.setTerminalTitle("focus-event")
    })

    emitFocus("OI")

    await renderer.idle()
    const restore = output.indexOf("\x1b[?2004h")
    expect(restore).toBeGreaterThanOrEqual(0)
    expect(output.indexOf("focus-event")).toBeGreaterThan(restore)
  })

  test("mouse and keyboard input work after a focus restore cycle", async () => {
    const target = new TestRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: renderer.width,
      height: renderer.height,
    })
    renderer.root.add(target)
    await renderOnce()
    let mouseEvents = 0
    let keys = 0
    target.onMouse = () => mouseEvents++
    renderer.keyInput.on("keypress", () => keys++)

    emitFocus("OI")
    await renderer.idle()
    await mockMouse.click(5, 5)
    mockInput.pressKey("b")
    clock.advance(15)

    expect({ restores: output.split("\x1b[?2004h").length - 1, mouse: mouseEvents > 0, keys }).toEqual({
      restores: 1,
      mouse: true,
      keys: 1,
    })
  })
})
