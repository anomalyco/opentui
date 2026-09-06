import { test } from "bun:test"
import assert from "node:assert/strict"
import { OptimizedBuffer } from "../buffer.js"
import { Renderable } from "../Renderable.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { createTestRenderer } from "../testing/test-renderer.js"

const red = RGBA.fromInts(200, 0, 0)
const black = RGBA.fromInts(0, 0, 0)

test("checked buffer stacks intersect clips and multiply opacity on retained buffers", async () => {
  const { renderer } = await createTestRenderer({ width: 6, height: 1 })
  const buffer = OptimizedBuffer.create(6, 1, "unicode", { owner: renderer.nativeScene })
  try {
    buffer.clear(black)
    buffer.pushScissorRect(1, 0, 4, 1)
    buffer.pushScissorRect(2, 0, 4, 1)
    buffer.pushOpacity(0.5)
    buffer.pushOpacity(0.5)
    assert.equal(buffer.getCurrentOpacity(), 0.25)
    buffer.fillRect(0, 0, 6, 1, red)
    buffer.withBuffers(({ bg }) => assert.deepEqual([bg[0], bg[4], bg[8], bg[16], bg[20]], [0, 0, 50, 50, 0]))
    buffer.popScissorRect()
    buffer.popOpacity()
    assert.equal(buffer.getCurrentOpacity(), 0.5)
    buffer.fillRect(1, 0, 1, 1, red)
    buffer.withBuffers(({ bg }) => assert.equal(bg[4], 100))
    buffer.clearScissorRects()
    buffer.clearOpacity()
    buffer.popScissorRect()
    buffer.popOpacity()
    assert.equal(buffer.getCurrentOpacity(), 1)
    buffer.fillRect(0, 0, 1, 1, red)
    buffer.withBuffers(({ bg }) => assert.equal(bg[0], 200))
  } finally {
    buffer.destroy()
    renderer.destroy()
    await renderer.closed
  }
})

test("checked buffer stacks reject invalid input and bound custom depth without changing accepted state", async () => {
  const { renderer } = await createTestRenderer({ width: 2, height: 1 })
  const buffer = OptimizedBuffer.create(2, 1, "unicode", { owner: renderer.nativeScene })
  try {
    for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => buffer.pushOpacity(value))
    for (const rect of [
      [0.5, 0, 1, 1],
      [0, 0, -1, 1],
      [0x7fffffff, 0, 1, 1],
      [0, 0, 0x80000000, 1],
    ]) {
      assert.throws(() => buffer.pushScissorRect(rect[0], rect[1], rect[2], rect[3]))
    }
    for (let index = 0; index < 256; index++) {
      buffer.pushScissorRect(0, 0, 1, 1)
      buffer.pushOpacity(1)
    }
    assert.throws(() => buffer.pushScissorRect(0, 0, 0, 0))
    assert.throws(() => buffer.pushOpacity(0))
    assert.equal(buffer.getCurrentOpacity(), 1)
    buffer.clear(black)
    buffer.fillRect(0, 0, 2, 1, red)
    buffer.withBuffers(({ bg }) => assert.deepEqual([bg[0], bg[4]], [200, 0]))
    buffer.clearScissorRects()
    buffer.clearOpacity()
    buffer.pushOpacity(2)
    assert.equal(buffer.getCurrentOpacity(), 1)
    buffer.pushOpacity(-1)
    assert.equal(buffer.getCurrentOpacity(), 0)
  } finally {
    buffer.destroy()
    assert.throws(() => buffer.clearOpacity(), /destroyed/)
    renderer.destroy()
    await renderer.closed
  }
})

test("checked frame stacks protect inherited state and restore callback state after return and throw", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 6,
    height: 1,
    backgroundColor: black,
  })
  const errors: Error[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  const source = OptimizedBuffer.create(6, 1, "unicode", { owner: renderer.nativeScene })
  source.drawText("A\u754cBCD", 0, 0, red, red)
  const failure = new Error("stack paint failure")
  let fail = true
  let saved: OptimizedBuffer | undefined
  const calls: string[] = []
  class Paint extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      calls.push("self")
      saved = buffer
      assert.equal(buffer.getCurrentOpacity(), 0.5)
      buffer.popScissorRect()
      buffer.clearScissorRects()
      buffer.popOpacity()
      buffer.clearOpacity()
      assert.equal(buffer.getCurrentOpacity(), 0.5)
      buffer.pushScissorRect(1, 0, 1, 1)
      buffer.pushOpacity(0.5)
      buffer.drawFrameBuffer(0, 0, source)
      if (fail) throw failure
    }
  }
  try {
    const parent = new BoxRenderable(renderer, {
      width: 3,
      height: 1,
      left: 1,
      overflow: "hidden",
      opacity: 0.5,
    })
    parent.add(
      new Paint(renderer, {
        width: 6,
        height: 1,
        renderBefore(buffer) {
          calls.push("before")
          buffer.pushOpacity(0)
          buffer.pushScissorRect(0, 0, 0, 0)
        },
        renderAfter(buffer) {
          calls.push("after")
          assert.equal(buffer.getCurrentOpacity(), 0.5)
          buffer.clearScissorRects()
          buffer.clearOpacity()
          buffer.setCellWithAlphaBlending(3, 0, "Z", red, red)
          buffer.setCellWithAlphaBlending(0, 0, "X", red, red)
          buffer.setCellWithAlphaBlending(4, 0, "X", red, red)
        },
      }),
    )
    renderer.root.add(parent)
    await renderOnce()
    assert.deepEqual(errors, [failure])
    for (const operation of [
      () => saved!.pushOpacity(1),
      () => saved!.getCurrentOpacity(),
      () => saved!.clearScissorRects(),
    ]) {
      assert.throws(operation, /active next frame/)
    }
    fail = false
    calls.length = 0
    await renderOnce()
    assert.deepEqual(errors, [failure])
    assert.deepEqual(calls, ["before", "self", "after"])
    assert.equal(captureCharFrame(), "   Z  \n")
    renderer.currentRenderBuffer.withBuffers(({ bg }) =>
      assert.deepEqual([bg[0], bg[4], bg[8], bg[12], bg[16]], [0, 50, 0, 100, 0]),
    )
  } finally {
    source.destroy()
    renderer.destroy()
    await renderer.closed
  }
})
