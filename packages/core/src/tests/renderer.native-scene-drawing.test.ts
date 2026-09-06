import { expectRenderSnapshot } from "./render-snapshot.js"
import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { FrameBufferRenderable } from "../renderables/FrameBuffer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"

const setups: TestRendererSetup[] = []
const red = RGBA.fromHex("#c04020")
const black = RGBA.fromHex("#102030")
const matrix = new Float32Array([99, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 99]).subarray(1, 17)
const mask = new Float32Array([99, 0, 0, 1, 1, 0, 0.5, -1, 0, 1, NaN, 0, 1, 0, 1, Infinity, 99]).subarray(1)

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({
    width: 6,
    height: 2,
    clock: new ManualClock(),
  })
  setups.push(target)
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  return { ...target, errors }
}

function snapshot(buffer: OptimizedBuffer) {
  return buffer.withBuffers((cells) => ({
    text: buffer.getRealCharBytes(),
    fg: cells.fg.slice(),
    bg: cells.bg.slice(),
    attributes: cells.attributes.slice(),
  }))
}

test("native color matrices preserve retained-buffer channels masks and typed subarrays", async () => {
  const target = await setup()
  const node = new FrameBufferRenderable(target.renderer, { width: 5, height: 2 })
  target.renderer.root.add(node)
  {
    for (const channel of [1, 2, 3]) {
      const buffer = node.frameBuffer
      buffer.clear(black)
      buffer.drawText("A\u754cB", 0, 0, red, black, 1)
      const before = snapshot(buffer)
      buffer.colorMatrix(matrix, new Float32Array(), 1, channel)
      assert.deepEqual(snapshot(buffer), before)
      buffer.colorMatrixUniform(matrix, 0.75, channel)
      buffer.colorMatrix(matrix, mask, 0.5, channel)
      node.requestRender()
      await target.renderOnce()
      assert.deepEqual(target.errors, [])
      expectRenderSnapshot(snapshot(node.frameBuffer))
      expectRenderSnapshot(snapshot(target.renderer.currentRenderBuffer))
    }
  }
})

test("native color matrices run in custom paint and post-process scopes and reject late no-ops", async () => {
  const target = await setup()
  let saved: OptimizedBuffer | undefined
  class Matrix extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      buffer.drawText("ABCDE", 0, 0, red, black)
      buffer.colorMatrixUniform(matrix, 1, 1)
    }
  }
  const parent = new BoxRenderable(target.renderer, { width: 3, height: 1, overflow: "hidden", opacity: 0.5 })
  parent.add(new Matrix(target.renderer, { width: 5, height: 1 }))
  target.renderer.root.add(parent)
  target.renderer.addPostProcessFn((buffer) => {
    saved = buffer
    buffer.withBuffers((cells) => {
      const generation = cells.generation
      buffer.colorMatrix(matrix, mask, 1, 3)
      assert.equal(cells.generation, generation)
    })
  })
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
  const frame = snapshot(target.renderer.currentRenderBuffer)
  assert.throws(() => saved!.colorMatrix(matrix, mask), /active next frame/)
  assert.throws(() => saved!.colorMatrixUniform(matrix), /active next frame/)
  assert.throws(() => saved!.colorMatrixUniform(matrix, 0), /active next frame/)
  expectRenderSnapshot(frame)
})

test("native color matrices reject invalid effects without changing retained cells", async () => {
  const { renderer } = await setup()
  const node = new FrameBufferRenderable(renderer, { width: 5, height: 2 })
  renderer.root.add(node)
  const buffer = node.frameBuffer
  buffer.clear(black)
  buffer.drawText("A\u754cB", 0, 0, red, black)
  const before = snapshot(buffer)
  const invalid = matrix.slice()
  invalid[15] = NaN
  for (const effect of [new Float32Array(15), invalid]) {
    assert.throws(() => buffer.colorMatrix(effect, mask))
    assert.throws(() => buffer.colorMatrixUniform(effect))
  }
  for (const strength of [NaN, Infinity]) {
    assert.throws(() => buffer.colorMatrix(matrix, mask, strength))
    assert.throws(() => buffer.colorMatrixUniform(matrix, strength))
  }
  for (const channel of [0, 4, 0.5]) {
    assert.throws(() => buffer.colorMatrix(matrix, mask, 1, channel))
    assert.throws(() => buffer.colorMatrixUniform(matrix, 1, channel))
  }
  assert.deepEqual(snapshot(buffer), before)
  node.destroy()
  assert.throws(() => buffer.colorMatrix(matrix, mask), /destroyed/)
  assert.throws(() => buffer.colorMatrixUniform(matrix, 0), /destroyed/)
})
