import { expectRenderSnapshot } from "./render-snapshot.js"
import { test } from "bun:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"

import { RGBA } from "../lib/RGBA.js"
import { FrameBufferRenderable } from "../renderables/FrameBuffer.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { createTestRenderer } from "../testing/test-renderer.js"

const foreground = RGBA.fromInts(255, 255, 255)
const background = RGBA.fromInts(0, 0, 0)

test("checked buffer drawing preserves indexed and default color intent through presentation", async () => {
  const writes: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, complete) {
      writes.push(chunk.toString())
      complete()
    },
  })
  const target = await createTestRenderer({
    width: 16,
    height: 3,
    remote: true,
    stdout: stdout as NodeJS.WriteStream,
    bufferedOutput: "stdout",
  })
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  const node = new FrameBufferRenderable(target.renderer, { width: 16, height: 3 })
  target.renderer.root.add(node)
  const buffer = node.frameBuffer
  const fg = RGBA.fromIndex(255, "#123456")
  const bg = RGBA.defaultBackground("#112233")
  try {
    await target.renderer.setupTerminal()
    target.renderer.stdin.emit("data", Buffer.from("\x1bP>|kitty 0.41.0\x1b\\"))
    await target.renderer.nativeScene?.driver.idle()
    writes.length = 0
    buffer.clear(bg)
    for (let slot = 0; slot < 16; slot++) {
      buffer.setCell(slot, 0, " ", RGBA.defaultForeground(), RGBA.fromIndex(slot, "#abcdef"))
    }
    buffer.fillRect(0, 1, 16, 1, fg)
    buffer.drawText("text", 0, 1, fg, bg)
    const encoded = buffer.encodeUnicode("e\u0301")!
    try {
      buffer.drawChar(encoded.data[0].char, 4, 1, fg, bg)
    } finally {
      buffer.freeUnicode(encoded)
    }
    buffer.drawGrayscaleBuffer(5, 1, new Float32Array([1, 0.5]), 2, 1, fg, bg)
    const before = buffer.withBuffers(({ fg, bg }) => ({ fg: fg.slice(), bg: bg.slice() }))
    for (const color of [new Uint16Array([256, 0, 0, 255]), new Uint16Array([0, 768, 0, 255])]) {
      assert.throws(() => buffer.setCell(0, 0, "X", foreground, RGBA.fromArray(color)))
    }
    assert.deepEqual(
      buffer.withBuffers(({ fg, bg }) => ({ fg: fg.slice(), bg: bg.slice() })),
      before,
    )
    await target.renderOnce()
    await target.renderer.nativeScene?.driver.whenPresented()
    assert.deepEqual(errors, [])
    expectRenderSnapshot({
      text: target.captureCharFrame(),
      ...target.renderer.currentRenderBuffer.withBuffers(({ fg, bg }) => ({ fg: fg.slice(), bg: bg.slice() })),
    })
    const output = writes.join("")
    assert.match(output, /\x1b\[48;5;1m/)
    assert.match(output, /\x1b\[38;5;255m/)
    assert.match(output, /\x1b\[49m/)
  } finally {
    target.renderer.destroy()
    await target.renderer.closed
  }
})

test("native framebuffer presentation retains encoded graphemes after resource release and replacement", async () => {
  const target = await createTestRenderer({ width: 4, height: 2 })
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  const node = new FrameBufferRenderable(target.renderer, { width: 4, height: 2 })
  target.renderer.root.add(node)
  try {
    for (const text of ["\ud83d\ude48", "\ud83d\udc69\u200d\ud83d\udcbb", "\u754c", "e\u0301"]) {
      const encoded = node.frameBuffer.encodeUnicode(text)!
      node.frameBuffer.clear(background)
      node.frameBuffer.drawChar(encoded.data[0].char, 0, 0, foreground, background)
      node.frameBuffer.freeUnicode(encoded)
      await target.renderOnce()
      assert.deepEqual(errors, [])
      assert.ok(target.captureCharFrame().startsWith(text))
      assert.ok(node.frameBuffer.getSpanLines()[0].spans[0].text.startsWith(text))
    }
    node.destroy()
    await target.renderOnce()
    assert.deepEqual(errors, [])
    assert.equal(target.captureCharFrame().trim(), "")
  } finally {
    target.renderer.destroy()
    await target.renderer.closed
  }
})
