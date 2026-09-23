import { afterEach, beforeEach, expect, test } from "bun:test"
import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const red = RGBA.fromHex("#ff0000")
const blue = RGBA.fromHex("#0000ff")
const clear = RGBA.fromInts(0, 0, 0, 0)
let setup: TestRendererSetup

beforeEach(async () => {
  setup = await createTestRenderer({ width: 12, height: 4 })
})

afterEach(async () => {
  setup.renderer.destroy()
  await setup.renderer.closed
})

function backgroundAt(buffer: OptimizedBuffer, x: number, y: number): Uint16Array {
  return buffer.withBuffers(({ bg, width }) => bg.slice((y * width + x) * 4, (y * width + x + 1) * 4))
}

test.each(["before", "after"] as const)(
  "self-destruction in %s preserves own drawing without stale hits and skips a destroyed scheduled box",
  async (phase) => {
    const { renderer, renderOnce } = setup
    const victim = new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: blue })
    const box = new BoxRenderable(renderer, {
      width: 2,
      height: 1,
      backgroundColor: red,
      renderBefore() {
        if (phase === "before") this.destroy()
        victim.destroy()
      },
      renderAfter() {
        if (phase === "after") this.destroy()
      },
    })
    renderer.root.add(box)
    renderer.root.add(victim)

    await renderOnce()

    expect(box.isDestroyed).toBe(true)
    expect(victim.isDestroyed).toBe(true)
    expect(backgroundAt(renderer.currentRenderBuffer, 0, 0)).toEqual(red.buffer)
    expect(backgroundAt(renderer.currentRenderBuffer, 0, 1)).toEqual(clear.buffer)
    expect(renderer.hitTest(0, 0)).toBe(0)
    expect(renderer.hitTest(0, 1)).toBe(0)

    await renderOnce()

    expect(backgroundAt(renderer.currentRenderBuffer, 0, 0)).toEqual(clear.buffer)
    expect(renderer.hitTest(0, 0)).toBe(0)
  },
)
