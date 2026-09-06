import { test } from "bun:test"
import assert from "node:assert/strict"
import type { BufferAccess } from "../buffer.js"
import { CliRenderEvents } from "../renderer.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { NativeStatus } from "../zig.js"

test("post-process failure releases storage and preserves published cells and hits until retry", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 8,
    height: 2,
    clock: new ManualClock(),
  })
  const text = new TextRenderable(renderer, { content: "A", position: "absolute", width: 1, height: 1 })
  const errors: unknown[] = []
  const calls: string[] = []
  let saved: BufferAccess | undefined
  let frames = 0
  renderer.root.add(text)
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  const failure = new Error("post-process failed")
  const fail = () => {
    renderer.nextRenderBuffer.withBuffers((cells) => {
      saved = cells
      cells.char[5] = 67
      throw failure
    })
  }
  try {
    await renderOnce()
    const before = captureCharFrame()
    renderer.addPostProcessFn((buffer) => {
      calls.push("first")
      buffer.buffers.char[4] = 66
    })
    renderer.addPostProcessFn(fail)
    renderer.addPostProcessFn(() => calls.push("last"))
    text.left = 4
    await renderOnce()
    assert.deepEqual(errors, [failure])
    assert.deepEqual(calls, ["first"])
    assert.equal(frames, 1)
    assert.equal(captureCharFrame(), before)
    assert.equal(renderer.hitTest(0, 0), text.num)
    assert.notEqual(renderer.hitTest(4, 0), text.num)
    assert.throws(() => saved!.char, /scope has ended/)
    assert.throws(() => renderer.nextRenderBuffer.buffers, /withBuffers/)
    renderer.removePostProcessFn(fail)
    await renderOnce()
    assert.deepEqual(calls, ["first", "first", "last"])
    assert.equal(frames, 2)
    assert.equal(captureCharFrame(), "    B   \n        \n")
    assert.equal(renderer.hitTest(4, 0), text.num)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test("post-process suspension finishes active access and later effects but does not present", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 8,
    height: 2,
    clock: new ManualClock(),
  })
  const errors: unknown[] = []
  const calls: string[] = []
  let suspension: void | Promise<void> = undefined
  let frames = 0
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  renderer.root.add(new TextRenderable(renderer, { content: "A" }))
  try {
    await renderer.setupTerminal()
    await renderOnce()
    renderer.addPostProcessFn((buffer) => {
      buffer.withBuffers(({ char }) => {
        suspension = renderer.suspend()
        char[4] = 66
        assert.equal(char[4], 66)
        assert.throws(() => buffer.getRealCharBytes(), { status: NativeStatus.InvalidPhase })
      })
      calls.push("released")
    })
    renderer.addPostProcessFn(() => calls.push("later"))
    await renderOnce()
    await suspension
    assert.deepEqual(calls, ["released", "later"])
    assert.equal(errors.length, 1)
    assert.equal((errors[0] as { status: NativeStatus }).status, NativeStatus.InvalidPhase)
    assert.equal(frames, 1)
    renderer.clearPostProcessFns()
    await renderer.resume()
    await renderOnce()
    assert.equal(frames, 2)
    assert.equal(captureCharFrame(), "A       \n        \n")
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
