import { afterEach, beforeEach, expect, test } from "bun:test"
import { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { Renderable } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents } from "../renderer.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const red = RGBA.fromHex("#ff0000")
const green = RGBA.fromHex("#00ff00")
const blue = RGBA.fromHex("#0000ff")
const white = RGBA.fromHex("#ffffff")
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
  "self-destruction in %s drops the node, its recording, and a destroyed later box",
  async (phase) => {
    const { renderer, renderOnce, captureCharFrame } = setup
    const victim = new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: blue })
    const box = new BoxRenderable(renderer, {
      width: 2,
      height: 1,
      backgroundColor: red,
      renderBefore(buffer) {
        buffer.drawText("x", 0, 0, white)
        if (phase === "before") this.destroy()
        victim.destroy()
      },
      renderAfter(buffer) {
        buffer.drawText("y", 1, 0, white)
        if (phase === "after") this.destroy()
      },
    })
    renderer.root.add(box)
    renderer.root.add(victim)

    await renderOnce()

    expect(box.isDestroyed).toBe(true)
    expect(victim.isDestroyed).toBe(true)
    expect(backgroundAt(renderer.currentRenderBuffer, 0, 0)).toEqual(clear.buffer)
    expect(backgroundAt(renderer.currentRenderBuffer, 0, 1)).toEqual(clear.buffer)
    expect(captureCharFrame().split("\n")[0].trimEnd()).toBe("")
    expect(renderer.hitTest(0, 0)).toBe(0)
    expect(renderer.hitTest(0, 1)).toBe(0)
  },
)

test("paint hooks run before native paint, so earlier nodes paint a later hook's change", async () => {
  const { renderer, renderOnce, captureSpans } = setup
  const calls: string[] = []
  const first = new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: red })
  class Recolor extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      calls.push("self")
      first.backgroundColor = green
      buffer.drawText("ok", this.x, this.y, white)
    }
  }
  renderer.root.add(first)
  renderer.root.add(new Recolor(renderer, { width: 2, height: 1 }))

  await renderOnce()

  expect(calls).toEqual(["self"])
  expect(captureSpans().lines[0].spans[0]).toMatchObject({ width: 2, bg: green })
  expect(captureSpans().lines[1].spans[0].text.trimEnd()).toBe("ok")
})

test("paint hooks cannot read the frame and report the failing node", async () => {
  const { renderer, renderOnce } = setup
  const errors: { error: unknown; renderable?: Renderable }[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, (event) => errors.push(event))
  const reader = new BoxRenderable(renderer, {
    width: 2,
    height: 1,
    renderAfter(buffer) {
      buffer.withBuffers(() => {})
    },
  })
  renderer.root.add(reader)

  await renderOnce()

  expect(errors).toHaveLength(1)
  expect(String(errors[0].error)).toContain("cannot read the frame")
  expect(errors[0].renderable).toBe(reader)
})

test("an owned buffer composed by a hook reads its cells when native code paints", async () => {
  const { renderer, renderOnce, captureCharFrame } = setup
  class Composer extends Renderable {
    readonly surface = OptimizedBuffer.create(2, 1, "unicode", { owner: this.ctx.nativeScene })
    protected renderSelf(buffer: OptimizedBuffer): void {
      this.surface.drawText("ab", 0, 0, white)
      buffer.drawFrameBuffer(this.x, this.y, this.surface)
      this.surface.drawText("cd", 0, 0, white)
    }
    protected destroySelf(): void {
      this.surface.destroy()
      super.destroySelf()
    }
  }
  renderer.root.add(new Composer(renderer, { width: 2, height: 1 }))

  await renderOnce()

  expect(captureCharFrame().split("\n")[0].trimEnd()).toBe("cd")
})
