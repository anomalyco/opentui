import { test } from "bun:test"
import assert from "node:assert/strict"
import type { BufferAccess } from "../buffer.js"
import { CliRenderEvents } from "../renderer.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test("post-process failure releases storage and preserves published cells and hits until retry", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 8,
    height: 2,
    clock: new ManualClock(),
  })
  const text = new TextRenderable(renderer, { content: "A", position: "absolute", width: 1, height: 1 })
  const errors: unknown[] = []
  let saved: BufferAccess | undefined
  renderer.root.add(text)
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
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
      buffer.buffers.char[4] = 66
    })
    renderer.addPostProcessFn(fail)
    text.left = 4
    await renderOnce()
    assert.deepEqual(errors, [failure])
    assert.equal(captureCharFrame(), before)
    assert.equal(renderer.hitTest(0, 0), text.num)
    assert.notEqual(renderer.hitTest(4, 0), text.num)
    assert.throws(() => saved!.char, /scope has ended/)
    renderer.removePostProcessFn(fail)
    await renderOnce()
    assert.equal(captureCharFrame(), "    B   \n        \n")
    assert.equal(renderer.hitTest(4, 0), text.num)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
