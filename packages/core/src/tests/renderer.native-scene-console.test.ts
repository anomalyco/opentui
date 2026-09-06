import { resolveRenderLib } from "../zig.js"
import { afterEach, beforeAll, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { CliRenderer, CliRenderEvents, MouseEvent } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererOptions } from "../testing/test-renderer.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"
import { NativeStatus } from "../zig.js"

const renderers: CliRenderer[] = []

beforeAll(async () => {
  resolveRenderLib()
  await setImmediate()
})

afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    renderer.console.clear()
    renderer.destroy()
    await renderer.closed
  }
})

async function setup(options: TestRendererOptions = {}) {
  const result = await createTestRenderer({
    width: 80,
    height: 20,
    clock: new ManualClock(),
    consoleMode: "console-overlay",
    ...options,
  })
  renderers.push(result.renderer)
  result.renderer.console.clear()
  return result
}

test("native error console presents CRLF and ANSI diagnostics with matching selection and copy text", async () => {
  const copied: string[] = []
  const { renderer, renderOnce, captureCharFrame, mockInput } = await setup({
    width: 48,
    openConsoleOnError: true,
    consoleOptions: { sizePercent: 100, onCopySelection: (text) => copied.push(text) },
  })
  const diagnostic = new Error("diagnostic\r\n\x1b[31mred failure\x1b[0m")
  diagnostic.stack = "Error: diagnostic\r\n\tat file.ts:4\r\ncaused by \x85timeout"
  renderer.addPostProcessFn(() => {
    throw diagnostic
  })
  await renderOnce()
  assert.equal(renderer.console.visible, true)
  renderer.clearPostProcessFns()
  const errors: Error[] = []
  let frames = 0
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  await renderOnce()
  await renderOnce()
  assert.deepEqual(errors, [])
  assert.equal(frames, 2, "the error console must continue presenting frames")
  const frame = captureCharFrame()
  const selected = "\\x1b[31mred failure\\x1b[0m"
  assert.ok(frame.includes(selected))
  assert.match(frame, /diagnostic/)
  assert.match(frame, /at file.ts:4/)
  assert.match(frame, /caused by \\x85timeout/)
  assert.equal(frame.includes("\\x0d"), false, "CRLF must become a single newline")
  const rows = frame.split("\n")
  const y = rows.findIndex((row) => row.includes(selected))
  const x = rows[y].indexOf(selected)
  for (const [type, column] of [
    ["down", x],
    ["drag", x + selected.length],
    ["up", x + selected.length],
  ] as const) {
    assert.equal(
      renderer.console.handleMouse(
        new MouseEvent(null, {
          type,
          button: 0,
          x: column,
          y,
          modifiers: { shift: false, alt: false, ctrl: false },
        }),
      ),
      true,
    )
  }
  await renderOnce()
  renderer.console.keyBindings = [{ name: "y", action: "copy-selection" }]
  mockInput.pressKey("y")
  assert.deepEqual(copied, [selected])
  assert.deepEqual(errors, [])
})

test.each(["dispose", "sink failure", "reporting failure"] as const)(
  "idle native renderer closes without opening a console after %s",
  async (failure) => {
    const stdout = new TestWriteStream(80, 20)
    const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, 80, 20, {
      screenMode: "main-screen",
      externalOutputMode: "passthrough",
      consoleMode: "console-overlay",
      openConsoleOnError: true,
      clock: new ManualClock(),
    })
    const driver = renderer.nativeScene!.driver
    const show = spyOn(renderer.console, "show")
    const logged = spyOn(console, "error").mockImplementation(() => {
      if (failure === "reporting failure") throw new Error("error reporter failed")
    })
    let closed = false
    const settled = renderer.closed.catch((error) => {
      assert.equal(error, driver.error)
      closed = true
    })
    try {
      assert.equal(renderer.console.visible, false)
      assert.equal(renderer.getSchedulerState().isRendering, false)
      if (failure === "sink failure") stdout.emit("error", new Error("idle sink failure"))
      else driver.dispose()
      for (let turn = 0; turn < 32 && !closed; turn++) await setImmediate()
      assert.equal(closed, true, "renderer.closed must settle without a render loop or manual destroy")
      assert.equal(renderer.isDestroyed, true)
      assert.equal(renderer.root.isDestroyed, true)
      assert.equal(driver.disposed, true)
      assert.equal(show.mock.calls.length, 0, "a failed native owner cannot show an error overlay")
      assert.equal(logged.mock.calls.length, 1)
    } finally {
      show.mockRestore()
      logged.mockRestore()
      renderer.destroy()
      await settled
    }
  },
)

class HeldOutput extends TestWriteStream {
  hold = false
  complete?: (error?: Error | null) => void
  override _write(_chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.hold) this.complete = callback
    else callback()
  }
}

test("native console tears down immediately while closed waits for held output", async () => {
  const stdout = new HeldOutput(80, 20)
  const target = await setup({ stdout: stdout as unknown as NodeJS.WriteStream, bufferedOutput: "stdout" })
  const { renderer } = target
  const lib = renderer.nativeScene!.driver.renderLib
  renderer.console.show()
  console.log("held console frame")
  const destroy = spyOn(lib, "destroyContextBuffer")
  try {
    stdout.hold = true
    let complete = false
    const pending = target.renderOnce().then(() => {
      complete = true
    })
    for (let turn = 0; turn < 32 && !stdout.complete; turn++) await setImmediate()
    assert.ok(stdout.complete)
    assert.equal(complete, false)
    assert.match(new TextDecoder().decode(renderer.console["frameBuffer"]!.getRealCharBytes()), /held console frame/)
    assert.throws(() => renderer.resize(96, 24), { status: NativeStatus.OutputBusy })
    renderer.requestResize(96, 24)
    assert.equal(renderer.console.bounds.width, 80)
    const retained = renderer.console["frameBuffer"]!
    let closed = false
    void renderer.closed.then(() => {
      closed = true
    })
    renderer.destroy()
    assert.equal(destroy.mock.calls.length, 1)
    assert.throws(() => retained.clear(), /destroyed/)
    await setImmediate()
    assert.equal(closed, false)
    stdout.hold = false
    stdout.complete()
    stdout.complete = undefined
    await pending
    await renderer.closed
    assert.equal(destroy.mock.calls.length, 1)
  } finally {
    stdout.hold = false
    stdout.complete?.()
    destroy.mockRestore()
  }
})
