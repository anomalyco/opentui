import { captureRenderSnapshot as snapshot, expectRenderSnapshot } from "./render-snapshot.js"
import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { BorderCharArrays } from "../lib/border.js"
import { RGBA } from "../lib/RGBA.js"
import { FrameBufferRenderable } from "../renderables/FrameBuffer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"

const setups: TestRendererSetup[] = []
const grid = {
  borderChars: BorderCharArrays.single,
  borderFg: RGBA.fromHex("#c08040"),
  borderBg: RGBA.fromHex("#102030"),
  columnOffsets: new Int32Array([0, 3, 6]),
  rowOffsets: new Int32Array([0, 2, 4]),
  drawInner: true,
  drawOuter: true,
}

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({
    width: 12,
    height: 8,
    clock: new ManualClock(),
  })
  setups.push(target)
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  return { ...target, errors }
}

test("native grid supports Context offscreen buffers without compatibility drawing", async () => {
  const native = await setup()
  const node = new FrameBufferRenderable(native.renderer, { width: 7, height: 5, left: 1, top: 1 })
  native.renderer.root.add(node)
  const target = node.frameBuffer
  for (const [drawInner, drawOuter] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ]) {
    target.clear(RGBA.fromHex("#000000"))
    target.drawGrid({ ...grid, drawInner, drawOuter })
    node.requestRender()
    await native.renderOnce()
    assert.deepEqual(native.errors, [])
    expectRenderSnapshot(snapshot(native))
  }
  assert.throws(() => target.drawGrid({ ...grid, borderChars: new Uint32Array(10) }))
  assert.throws(() => target.drawGrid({ ...grid, columnOffsets: new Int32Array([2, 1]) }))
  assert.throws(() => target.drawGrid({ ...grid, rowOffsets: new Int32Array([0, 0]) }))
  target.drawGrid({ ...grid, columnOffsets: new Int32Array() })
  node.destroy()
  assert.throws(() => target.drawGrid(grid), /destroyed/)
})

test("native frame grid retains clip and opacity and rejects drawing after the scope", async () => {
  const target = await setup()
  let saved: OptimizedBuffer | undefined
  class Grid extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      saved = buffer
      buffer.drawGrid(grid)
    }
  }
  const parent = new BoxRenderable(target.renderer, { width: 4, height: 3, overflow: "hidden", opacity: 0.5 })
  const node = new Grid(target.renderer, { width: 4, height: 3 })
  parent.add(node)
  target.renderer.root.add(parent)
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
  const frame = snapshot(target)
  assert.equal(frame.text.split("\n")[0].slice(0, 4), "\u250c\u2500\u2500\u252c")
  assert.equal(frame.text.split("\n")[0].slice(4).trim(), "")
  assert.equal(frame.text.split("\n")[4].trim(), "")
  assert.ok(frame.bg[0] > 0 && frame.bg[0] < 16)
  assert.throws(() => saved!.drawGrid(grid), /active next frame/)
})
