import { test } from "bun:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { NativeSession } from "../NativeSession.js"
import { OptimizedBuffer } from "../buffer.js"
import { NativeStatus, resolveRenderLib } from "../zig.js"

test("driver copies capability replies and orders framebuffer controls through one bounded queue", async () => {
  const lib = resolveRenderLib()
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(bytes, _encoding, callback) {
      chunks.push(Buffer.from(bytes))
      callback()
    },
  })
  const driver = new NativeSession(sink, {
    context: { objectCapacity: 2, renderCellsMax: 16 },
    output: { chunkSize: 4096, spanCapacity: 8, maxBytes: 32768n, controlCapacity: 4096 },
    outputBufferSize: 127,
  })
  try {
    driver.attachRenderer({ width: 4, height: 1, remote: true })
    await driver.setupTerminal()
    const reply = Buffer.from("x\x1bP>|kitty 0.41.0\x1b\\x")
    driver.control({ kind: "capability-response", bytes: reply.subarray(1, -1) })
    reply.fill(0)
    await driver.idle()
    const capabilities = driver.getCapabilities()
    assert.equal(capabilities.terminal.name, "kitty")
    OptimizedBuffer.fromSession(lib, driver.context, driver.session, "next").withBuffers((cells) => {
      for (let index = 0; index < 4; index++) {
        cells.char[index] = "HOST".charCodeAt(index)
        cells.fg.set([255, 255, 255, 255], index * 4)
      }
    })
    driver.render(true)
    driver.control({ kind: "title", title: "after-frame" })
    await driver.idle()
    const output = Buffer.concat(chunks).toString()
    const painted = output.indexOf("HOST")
    assert.ok(painted >= 0 && output.indexOf("\x1b]0;after-frame\x07") > painted)
    assert.equal(driver.write(Buffer.alloc(7 * 4096)), true)
    assert.throws(() => driver.control({ kind: "kitty-keyboard-flags", flags: 7 }), {
      status: NativeStatus.OutputBackpressure,
    })
    assert.equal(driver.getCapabilities().kittyKeyboardFlags, 5)
    await driver.idle()
    for (const flags of [-1, 0.5, NaN, Infinity, 0x1_0000_0000, "1", 1n]) {
      assert.throws(() => driver.control({ kind: "kitty-keyboard-flags", flags: flags as never }), RangeError)
    }
    assert.throws(() => driver.control({ kind: "title", title: 1 as never }), TypeError)
    assert.throws(() => driver.control({ kind: "capability-response", bytes: null as never }), TypeError)
    driver.control({ kind: "kitty-keyboard-flags", flags: 7 })
    await driver.idle()
    assert.equal(driver.getCapabilities().kittyKeyboardFlags, 7)
    await driver.close()
    assert.equal(sink.writableEnded, false)
    assert.equal(capabilities.kittyKeyboardFlags, 5)
  } finally {
    driver.dispose()
  }
})
