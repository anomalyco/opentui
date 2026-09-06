import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { NativeSession } from "../NativeSession.js"
import { CliRenderer, CliRenderEvents, RendererControlState } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { RGBA } from "../lib/RGBA.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"

class Output extends TestWriteStream {
  chunks: Buffer[] = []
  hold = false
  complete?: (error?: Error) => void

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, complete: (error?: Error) => void): void {
    this.chunks.push(Buffer.from(chunk))
    if (this.hold) this.complete = complete
    else complete()
  }

  release(error?: Error): void {
    this.hold = false
    const complete = this.complete
    this.complete = undefined
    complete?.(error)
  }

  text(): string {
    return Buffer.concat(this.chunks).toString()
  }
}

const targets: { renderer: CliRenderer; stdout: Output }[] = []
afterEach(async () => {
  for (const { renderer, stdout } of targets.splice(0)) {
    stdout.release()
    renderer.destroy()
    await renderer.closed.catch(() => {})
  }
})

async function setup(options: ConstructorParameters<typeof NativeSession>[1] = {}) {
  const stdout = new Output(24, 10)
  const driver = new NativeSession(stdout, options)
  const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, 24, 10, {
    nativeSession: driver,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    remote: true,
    clock: new ManualClock(),
  })
  targets.push({ renderer, stdout })
  const renderOnce = () => renderer["loop"]()
  renderer.root.add(new TextRenderable(renderer, { content: "footer", height: 1 }))
  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[10;1R"))
  await renderOnce()
  await driver.idle()
  assert.ok(stdout.text().includes("footer"))
  stdout.chunks.length = 0
  return { renderer, stdout, driver, renderOnce }
}

function writeSnapshot(renderer: CliRenderer, content: string): void {
  renderer.writeToScrollback(({ renderContext }) => ({
    root: new TextRenderable(renderContext, { content, width: content.length, height: 1 }),
  }))
}

async function held(stdout: Output): Promise<void> {
  for (let turn = 0; turn < 32 && !stdout.complete; turn++) await setImmediate()
  assert.ok(stdout.complete, "the real output callback must be held")
}

test("close flushes accepted snapshots without replaying cancelled footer cells", async () => {
  const { renderer, stdout, renderOnce } = await setup()
  writeSnapshot(renderer, "accepted")
  renderer.addPostProcessFn((buffer) => {
    buffer.drawText("REVOKED", 0, 0, RGBA.fromInts(255, 255, 255))
    renderer.destroy()
  })
  await renderOnce()
  await renderer.closed
  assert.ok(stdout.text().includes("accepted"))
  assert.equal(stdout.text().includes("REVOKED"), false)
  assert.ok(stdout.text().includes("\x1b[?25h"))
})

test("suspension drains snapshot batches and captured output in order behind held raw output", async () => {
  const { renderer, stdout, driver, renderOnce } = await setup({
    output: { chunkSize: 4096, spanCapacity: 16, maxBytes: 65536n, controlCapacity: 4096 },
  })
  stdout.hold = true
  const bytes = Buffer.alloc(Number(driver.maxAtomicWriteBytes), "x")
  assert.equal(driver.write(bytes), true)
  assert.equal(driver.write(Uint8Array.of(120)), false)
  const rows = Array.from({ length: 10 }, (_, index) => `snapshot-${index}`)
  for (const row of rows) writeSnapshot(renderer, row)
  stdout.write("captured-tail")
  await held(stdout)
  let suspended = false
  const suspension = Promise.resolve(renderer.suspend()).then(() => {
    suspended = true
  })
  await setImmediate()
  assert.equal(suspended, false)
  assert.equal(renderer.controlState, RendererControlState.EXPLICIT_SUSPENDED)
  stdout.release()
  await suspension
  assert.ok(stdout.text().startsWith(bytes.toString()))
  assert.deepEqual(stdout.text().match(/snapshot-\d|captured-tail/g), [...rows, "captured-tail"])
  assert.ok(stdout.text().indexOf("captured-tail") < stdout.text().indexOf("\x1b[?2004l"))
  await renderer.resume()
  renderer.writeToScrollback(({ renderContext, tailColumn }) => {
    assert.equal(tailColumn, "captured-tail".length)
    return {
      root: new TextRenderable(renderContext, { content: "resumed", width: 7, height: 1 }),
      startOnNewLine: false,
    }
  })
  await renderOnce()
  renderer.destroy()
  await renderer.closed
  assert.equal(stdout.text().split("resumed").length - 1, 1)
  assert.equal(stdout.destroyed, false)
  assert.equal(stdout.listenerCount("error"), 0)
})

test("failed snapshot suspension can retry without losing the saved control state", async () => {
  const { renderer, stdout, driver, renderOnce } = await setup({
    output: { chunkSize: 32, spanCapacity: 256, maxBytes: 8192n, controlCapacity: 4096 },
  })
  renderer.pause()
  const before = renderer.controlState
  const useMouse = renderer.useMouse
  const frames = renderer.getNativeStats().nativeFrameCount
  stdout.hold = true
  const bytes = Buffer.alloc(Number(driver.maxAtomicWriteBytes) - 32, "x")
  assert.equal(driver.write(bytes), true)
  await held(stdout)
  writeSnapshot(renderer, "retry-snapshot")
  await assert.rejects(Promise.resolve(renderer.suspend()), /Native split output frame failed/)
  assert.equal(renderer.controlState, RendererControlState.EXPLICIT_SUSPENDED)
  assert.equal(renderer.useMouse, false)
  assert.equal(renderer.getNativeStats().nativeFrameCount, frames)
  assert.equal(stdout.text(), "x".repeat(32))
  stdout.release()
  await driver.idle()
  await renderer.suspend()
  assert.equal(stdout.text().split("retry-snapshot").length - 1, 1)
  assert.ok(stdout.text().indexOf("retry-snapshot") < stdout.text().indexOf("\x1b[?2004l"))
  await renderer.resume()
  await renderOnce()
  assert.equal(renderer.controlState, before)
  assert.equal(renderer.useMouse, useMouse)
  assert.ok(renderer.getNativeStats().nativeFrameCount > frames)
})

test.each(["release", "failure", "timeout"] as const)("destroy joins held suspension until %s", async (outcome) => {
  const { renderer, stdout, driver } = await setup({ closeTimeoutMs: outcome === "timeout" ? 5 : 2000 })
  const logged = spyOn(console, "error").mockImplementation(() => {})
  const failure = new Error("split output failed")
  try {
    const rows = Array.from({ length: 10 }, (_, index) => `snapshot-${index}`)
    for (const row of rows) writeSnapshot(renderer, row)
    stdout.hold = true
    const suspension = Promise.resolve(renderer.suspend())
    void suspension.catch(() => {})
    await held(stdout)
    writeSnapshot(renderer, "late-snapshot")
    let closed = false
    void renderer.closed.then(
      () => {
        closed = true
      },
      () => {},
    )
    renderer.destroy()
    if (outcome !== "timeout") await setImmediate()
    assert.equal(renderer.root.isDestroyed, true)
    assert.equal(driver.disposed, false)
    assert.equal(closed, false)
    if (outcome !== "timeout") stdout.release(outcome === "failure" ? failure : undefined)
    if (outcome === "release") {
      await assert.rejects(suspension, /interrupted by renderer destruction/)
      await renderer.closed
      assert.deepEqual(stdout.text().match(/snapshot-\d|late-snapshot/g), [...rows, "late-snapshot"])
      assert.equal(stdout.text().includes("\x1b[?2004h"), false)
    } else {
      const expected = outcome === "timeout" ? /graceful close timed out/ : (error: unknown) => error === failure
      await assert.rejects(suspension, expected)
      await assert.rejects(renderer.closed, expected)
    }
    assert.equal(driver.disposed, true)
    const output = stdout.text()
    stdout.release()
    await setImmediate()
    assert.equal(stdout.text(), output)
    assert.equal(stdout.destroyed, outcome === "failure")
    assert.equal(stdout.listenerCount("error"), 0)
  } finally {
    logged.mockRestore()
  }
})

test("snapshot suspension rejects Yoga reentry before changing control state", async () => {
  const { renderer, stdout, renderOnce } = await setup()
  const errors: unknown[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  writeSnapshot(renderer, "accepted")
  const box = new BoxRenderable(renderer, { width: 5 })
  let measures = 0
  box.setMeasureProvider(() => {
    measures++
    const state = renderer.controlState
    assert.throws(() => renderer.suspend(), /Cannot mutate Yoga during a callback/)
    assert.equal(renderer.controlState, state)
    return { width: 5, height: 1 }
  })
  renderer.root.add(box)
  await renderOnce()
  assert.ok(measures > 0)
  assert.deepEqual(errors, [])
  assert.equal(stdout.text().split("accepted").length - 1, 1)
  await renderer.suspend()
})

test("suspension joins synchronous stdin pause reentry and drains before passthrough", async () => {
  const { renderer, stdout } = await setup()
  writeSnapshot(renderer, "pause-reentry")
  renderer.externalOutputMode = "passthrough"
  renderer.stdin.resume()
  await setImmediate()
  let nested: void | Promise<void> = undefined
  renderer.stdin.once("pause", () => {
    nested = renderer.suspend()
  })
  const outer = renderer.suspend()
  await Promise.all([outer, nested])
  assert.equal(stdout.text().split("pause-reentry").length - 1, 1)
  assert.equal(renderer.externalOutputMode, "passthrough")
  await renderer.resume()
  assert.equal(renderer.controlState, RendererControlState.IDLE)
})

test("awaited frame suspension waits for replay capacity without reordering snapshots", async () => {
  const { renderer, stdout, driver, renderOnce } = await setup({
    output: { chunkSize: 4096, spanCapacity: 16, maxBytes: 65536n, controlCapacity: 4096 },
  })
  stdout.hold = true
  const bytes = Buffer.alloc(Number(driver.maxAtomicWriteBytes), "x")
  assert.equal(driver.write(bytes), true)
  await held(stdout)
  let callbacks = 0
  let settled = false
  const errors: unknown[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  const callback = async () => {
    renderer.removeFrameCallback(callback)
    callbacks++
    writeSnapshot(renderer, "before-replay")
    renderer.resetSplitFooterForReplay({ clearSavedLines: true })
    writeSnapshot(renderer, "after-replay")
    await renderer.suspend()
    settled = true
  }
  renderer.setFrameCallback(callback)
  const frame = renderOnce()
  await setImmediate()
  assert.equal(settled, false)
  stdout.release()
  await frame
  assert.deepEqual(errors, [])
  assert.equal(settled, true)
  assert.equal(callbacks, 1)
  const output = stdout.text()
  assert.ok(output.startsWith(bytes.toString()))
  assert.deepEqual(output.match(/before-replay|\x1b\[3J|after-replay|\x1b\[\?2004l/g), [
    "before-replay",
    "\x1b[3J",
    "after-replay",
    "\x1b[?2004l",
  ])
})

test("suspension drains only its accepted prefix despite a snapshot-producing sink", async () => {
  const { renderer, stdout, renderOnce } = await setup()
  const accepted: string[] = []
  const failures: unknown[] = []
  const write = stdout._write.bind(stdout)
  stdout._write = (bytes, encoding, complete) => {
    write(bytes, encoding, complete)
    if (!Buffer.from(bytes).includes("producer-") || accepted.length === 8) return
    try {
      assert.equal(renderer.controlState, RendererControlState.EXPLICIT_SUSPENDED)
      const content = `producer-${accepted.length + 1}`
      writeSnapshot(renderer, content)
      accepted.push(content)
    } catch (error) {
      failures.push(error)
    }
  }
  writeSnapshot(renderer, "producer-0")
  await renderer.suspend()
  stdout._write = write
  assert.deepEqual(failures, [])
  assert.deepEqual(accepted, ["producer-1"])
  assert.deepEqual(stdout.text().match(/producer-\d/g), ["producer-0"])
  await renderer.resume()
  await renderOnce()
  assert.deepEqual(stdout.text().match(/producer-\d/g), ["producer-0", "producer-1"])
})

test.each(["restoring", "suspended"] as const)("close retains snapshots accepted while %s", async (phase) => {
  const { renderer, stdout, driver } = await setup()
  const write = stdout._write.bind(stdout)
  if (phase === "restoring")
    stdout._write = (bytes, encoding, complete) => {
      if (Buffer.from(bytes).includes("\x1b[?2004l")) stdout.hold = true
      write(bytes, encoding, complete)
    }
  const suspension = Promise.resolve(renderer.suspend())
  if (phase === "restoring") await held(stdout)
  else await suspension
  stdout._write = write
  writeSnapshot(renderer, "late-snapshot")
  renderer.destroy()
  stdout.release()
  await suspension
  await renderer.closed
  const output = stdout.text()
  assert.equal(output.split("late-snapshot").length - 1, 1)
  assert.ok(output.lastIndexOf("\x1b[?25h") > output.lastIndexOf("\x1b[?25l"))
  assert.equal(output.includes("\x1b[?2004h"), false)
  assert.equal(driver.disposed, true)
})
