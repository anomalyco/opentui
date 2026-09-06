import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable, RGBA } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { Scene } from "three"
import { ThreeRenderable } from "../ThreeRenderable.js"
import { ThreeCliRenderer } from "../WGPURenderer.js"

test("native ThreeRenderable cleans up rejected constructor colors", async () => {
  const target = await createTestRenderer({ width: 8, height: 4, clock: new ManualClock() })
  try {
    const before = new Set(Renderable.renderablesByNumber.keys())
    const color = RGBA.fromHex("#123456")
    Object.defineProperty(color, "buffer", {
      get() {
        throw new Error("rejected color capture")
      },
    })
    assert.throws(
      () => new ThreeRenderable(target.renderer, { renderer: { backgroundColor: color } }),
      /rejected color capture/,
    )
    assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), before)
  } finally {
    target.renderer.destroy()
    await target.renderer.closed
  }
})

test("native ThreeRenderable snapshots retained buffer clearing", async () => {
  const target = await createTestRenderer({ width: 8, height: 4, clock: new ManualClock() })
  const init = spyOn(ThreeCliRenderer.prototype, "init").mockImplementation(async () => {})
  const draw = spyOn(ThreeCliRenderer.prototype, "drawScene").mockImplementation(async () => {})
  try {
    const color = RGBA.fromHex("#123456")
    const view = new ThreeRenderable(target.renderer, {
      width: 8,
      height: 4,
      live: false,
      scene: new Scene(),
      renderer: { backgroundColor: color },
    })
    target.renderer.root.add(view)
    color.buffer.fill(255)
    await target.renderOnce()
    await target.renderOnce()
    assert.ok(draw.mock.calls.length > 0)
    assert.deepEqual(target.captureSpans().lines[0].spans[0].bg.toInts(), [18, 52, 86, 255])
  } finally {
    init.mockRestore()
    draw.mockRestore()
    target.renderer.destroy()
    await target.renderer.closed
  }
})
