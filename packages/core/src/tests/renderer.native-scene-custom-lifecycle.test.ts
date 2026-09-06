import { expect, test } from "bun:test"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test("native custom Box draws its inherited body at native geometry", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 12,
    height: 4,
  })
  const errors: Error[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  class CustomBox extends BoxRenderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      super.renderSelf(buffer)
      buffer.drawText("X", this.x + 1, this.y + 1, RGBA.fromHex("#ffffff"))
    }
  }
  try {
    const box = new CustomBox(renderer, { position: "absolute", left: 3, top: 1, width: 5, height: 3, border: true })
    renderer.root.add(box)
    await renderOnce()
    expect(errors).toEqual([])
    expect(captureCharFrame().split("\n").slice(1, 4)).toEqual(["   ┌───┐    ", "   │X  │    ", "   └───┘    "])
    expect(renderer.hitTest(4, 2)).toBe(box.num)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test("native custom nodes retain initial z-order and opacity", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 4,
    height: 2,
  })
  const calls: string[] = []
  class Custom extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      calls.push(this.id)
      buffer.drawText(this.id, this.x, this.y, RGBA.fromHex("#ffffff"))
    }
  }
  try {
    renderer.root.add(new Custom(renderer, { id: "A", position: "absolute", width: 1, height: 1, zIndex: 1 }))
    renderer.root.add(new Custom(renderer, { id: "B", position: "absolute", width: 1, height: 1 }))
    renderer.root.add(
      new Custom(renderer, { id: "C", position: "absolute", width: 1, height: 1, opacity: 0, zIndex: 2 }),
    )
    await renderOnce()
    expect(calls).toEqual(["B", "A", "C"])
    expect(captureCharFrame().slice(0, 1)).toBe("A")
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test("native custom raw-buffer scopes unwind after a throwing body", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 4,
    height: 2,
  })
  const failure = new Error("custom draw failed")
  const errors: Error[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  let fail = true
  let calls = 0
  class Custom extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      calls++
      buffer.buffers.char[0] = 88
      if (fail) throw failure
    }
  }
  try {
    await renderOnce()
    const before = captureCharFrame()
    renderer.root.add(new Custom(renderer, { width: 1, height: 1 }))
    await renderOnce()
    expect(errors).toEqual([failure])
    expect(captureCharFrame()).toBe(before)
    expect(() => renderer.nextRenderBuffer.buffers).toThrow()
    fail = false
    await renderOnce()
    expect(calls).toBe(2)
    expect(captureCharFrame().slice(0, 1)).toBe("X")
    expect(() => renderer.nextRenderBuffer.buffers).toThrow()
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
