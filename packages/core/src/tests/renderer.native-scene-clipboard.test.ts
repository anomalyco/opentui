import { test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { NativeSession } from "../NativeSession.js"

import { CliRenderer } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"
import { NativeStatus } from "../zig.js"

class Output extends TestWriteStream {
  chunks: Buffer[] = []
  hold = false
  complete?: () => void

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, complete: () => void): void {
    this.chunks.push(Buffer.from(chunk))
    if (this.hold) this.complete = complete
    else complete()
  }

  release(): void {
    this.hold = false
    const complete = this.complete
    this.complete = undefined
    complete?.()
  }
}

function setup(output = new Output(8, 3), driver?: NativeSession) {
  const renderer = new CliRenderer(createTestStdin(), output as unknown as NodeJS.WriteStream, 8, 3, {
    nativeSession: driver,
    remote: true,
    forwardEnvKeys: [],
    screenMode: "main-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
    clock: new ManualClock(),
  })
  return { renderer, output }
}

test("native clipboard admission wakes the output driver without compatibility dispatch", async () => {
  const { renderer, output } = setup()
  const driver = renderer.nativeScene!.driver
  try {
    await renderer.setupTerminal()
    await driver.idle()
    output.chunks.length = 0
    assert.equal(renderer.copyToClipboardOSC52("scheduled"), true)
    for (let turn = 0; turn < 32 && output.chunks.length === 0; turn++) await setImmediate()
    assert.equal(Buffer.concat(output.chunks).toString(), "\x1b]52;c;c2NoZWR1bGVk\x1b\\")
    await driver.idle()
    renderer.resetTerminalBgColor()
    await driver.idle()
    assert.equal(Buffer.concat(output.chunks).toString(), "\x1b]52;c;c2NoZWR1bGVk\x1b\\\x1b]111\x07")
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test("native clipboard rejection preserves held output and permits restoration and teardown", async () => {
  const output = new Output(8, 3)
  const driver = new NativeSession(output, {
    output: { chunkSize: 4096, spanCapacity: 4, maxBytes: 16384n, controlCapacity: 4096 },
  })
  const { renderer } = setup(output, driver)
  try {
    assert.throws(() => renderer.copyToClipboardOSC52("inactive"), { status: NativeStatus.InvalidPhase })
    assert.throws(() => renderer.resetTerminalBgColor(), { status: NativeStatus.InvalidPhase })
    await renderer.setupTerminal()
    await driver.idle()
    output.chunks.length = 0
    output.hold = true
    assert.equal(driver.write(Buffer.alloc(3 * 4096, "x")), true)
    for (let turn = 0; turn < 32 && !output.complete; turn++) await setImmediate()
    assert.ok(output.complete)
    const callback = output.complete
    assert.equal(renderer.copyToClipboardOSC52("rejected"), false)
    assert.equal(renderer.clearClipboardOSC52(), false)
    assert.throws(() => renderer.resetTerminalBgColor(), { status: NativeStatus.OutputBackpressure })
    assert.equal(output.complete, callback)
    output.release()
    await driver.idle()
    assert.equal(Buffer.concat(output.chunks).toString(), "x".repeat(3 * 4096))
    output.chunks.length = 0
    assert.equal(renderer.copyToClipboardOSC52("accepted"), true)
    renderer.destroy()
    await renderer.closed
    assert.ok(Buffer.concat(output.chunks).toString().startsWith("\x1b]52;c;YWNjZXB0ZWQ=\x1b\\"))
    assert.equal(driver.disposed, true)
    assert.equal(output.destroyed, false)
    assert.equal(output.listenerCount("error"), 0)
    assert.throws(() => renderer.copyToClipboardOSC52("destroyed"))
  } finally {
    output.release()
    renderer.destroy()
    await renderer.closed
  }
})
