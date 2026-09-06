import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []
const white = RGBA.fromHex("#ffffff")

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({ width: 12, height: 4, clock: new ManualClock() })
  setups.push(target)
  const errors: unknown[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  return {
    ...target,
    async renderOnce() {
      await target.renderOnce()
      assert.deepEqual(errors, [])
    },
  }
}

test("buffered before destruction retains the selected framebuffer argument", async () => {
  const { renderer, renderOnce } = await setup()
  const buffers: OptimizedBuffer[] = []
  class Custom extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      buffers.push(buffer)
    }
  }
  const node = new Custom(renderer, {
    width: 2,
    height: 1,
    buffered: true,
    renderBefore(buffer) {
      buffers.push(buffer)
      this.destroy()
    },
    renderAfter: (buffer) => buffers.push(buffer),
  })
  renderer.root.add(node)
  await renderOnce()
  assert.equal(node.isDestroyed, true)
  assert.equal(buffers.length, 3)
  assert.notEqual(buffers[0], renderer.nextRenderBuffer)
  assert.ok(buffers.every((buffer) => buffer === buffers[0]))
})

test("buffered custom translation retains the native-only parent offset", async () => {
  const { renderer, renderOnce, captureCharFrame } = await setup()
  class Custom extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      buffer.drawText("X", 0, 0, white)
    }
  }
  const parent = new BoxRenderable(renderer, { position: "absolute", left: 4, width: 6, height: 1 })
  const child = new Custom(renderer, {
    position: "absolute",
    left: 2,
    width: 1,
    height: 1,
    buffered: true,
    renderAfter() {
      this.translateX = 1
    },
  })
  parent.add(child)
  renderer.root.add(parent)
  for (let frame = 0; frame < 2; frame++) {
    await renderOnce()
    assert.equal(captureCharFrame().split("\n")[0], "       X    ")
    assert.equal(renderer.hitTest(7, 0), child.num)
  }
})

test.each(["Text", "Textarea"])("custom %s ignores generic hooks and cleans before self", async (kind) => {
  const { renderer, renderOnce, captureCharFrame } = await setup()
  const calls: string[] = []
  class CustomText extends TextRenderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      calls.push(`self:${this.isDirty}`)
      buffer.drawText("X", this.x, this.y, white)
      this.requestRender()
    }
  }
  class CustomTextarea extends TextareaRenderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      calls.push(`self:${this.isDirty}`)
      buffer.drawText("X", this.x, this.y, white)
      this.requestRender()
    }
  }
  const options = {
    width: 3,
    height: 1,
    renderBefore: () => calls.push("before"),
    renderAfter: () => calls.push("after"),
  }
  const node =
    kind === "Text"
      ? new CustomText(renderer, { ...options, content: "OLD" })
      : new CustomTextarea(renderer, { ...options, initialValue: "OLD" })
  renderer.root.add(node)
  if (node instanceof TextareaRenderable) {
    node.focus()
    node.gotoBufferEnd()
  }
  node.requestRender()
  for (let frame = 0; frame < 2; frame++) {
    assert.equal(node.isDirty, true)
    await renderOnce()
    assert.equal(captureCharFrame().trim(), "X")
    assert.deepEqual(calls.splice(0), ["self:false"])
    assert.equal(node.isDirty, true)
    assert.equal(renderer.hitTest(0, 0), node.num)
    if (node instanceof TextareaRenderable) assert.equal(renderer.getCursorState().visible, true)
  }
})
