import { captureRenderSnapshot as snapshot, expectRenderSnapshot } from "./render-snapshot.js"
import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { ptr } from "../platform/ffi.js"
import { FrameBufferRenderable } from "../renderables/FrameBuffer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"

const setups: TestRendererSetup[] = []
const red = RGBA.fromHex("#ff0000")
const black = RGBA.fromHex("#000000")
const packed = new Uint8Array(96)
const floats = new Float32Array(packed.buffer)
for (let index = 0; index < 2; index++) {
  floats.set([0, 0, 0, 1, 1, 0, 0, 1], index * 12)
  new Uint32Array(packed.buffer)[index * 12 + 8] = 65 + index
}
const pixels = new Uint8Array(Array.from({ length: 8 }, () => [255, 0, 0, 255]).flat())
const gray = new Float32Array(8).fill(1)

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({
    width: 6,
    height: 5,
    clock: new ManualClock(),
  })
  setups.push(target)
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  return { ...target, errors }
}

function draw(buffer: OptimizedBuffer, raw: boolean) {
  const packedOwner = packed.buffer
  const pixelOwner = pixels.buffer
  buffer.drawPackedBuffer(raw ? ptr(packed) : packed, packedOwner.byteLength, 0, 0, 2, 1)
  buffer.drawSuperSampleBuffer(0, 1, raw ? ptr(pixels) : pixels, pixelOwner.byteLength, "rgba8unorm", 16)
  buffer.drawGrayscaleBuffer(0, 2, gray, 2, 1, red, black)
  buffer.drawGrayscaleBufferSupersampled(0, 3, gray, 4, 2, red, black)
}

test("native pixel drawing preserves typed and mapped-pointer offscreen inputs", async () => {
  const native = await setup()
  const node = new FrameBufferRenderable(native.renderer, { width: 2, height: 4 })
  native.renderer.root.add(node)
  for (const raw of [false, true]) {
    node.frameBuffer.clear(black)
    draw(node.frameBuffer, raw)
    node.requestRender()
    await native.renderOnce()
    assert.deepEqual(native.errors, [])
    const frame = snapshot(native)
    expectRenderSnapshot(frame)
    assert.ok(frame.text.startsWith("AB"))
  }
})

test("native pixel frame scopes preserve inherited clip opacity and reject late drawing", async () => {
  const target = await setup()
  let saved: OptimizedBuffer | undefined
  class Pixels extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      saved = buffer
      draw(buffer, false)
    }
  }
  const parent = new BoxRenderable(target.renderer, { width: 1, height: 4, overflow: "hidden", opacity: 0.5 })
  parent.add(new Pixels(target.renderer, { width: 2, height: 4 }))
  target.renderer.root.add(parent)
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
  const frame = snapshot(target)
  assert.equal(frame.text.split("\n")[0].trim(), "A")
  assert.throws(() => draw(saved!, false), /active next frame/)
  expectRenderSnapshot(frame)
})

test("native pixel drawing rejects invalid lengths and visible floats without changing cells", async () => {
  const target = await setup()
  const node = new FrameBufferRenderable(target.renderer, { width: 2, height: 4 })
  target.renderer.root.add(node)
  const buffer = node.frameBuffer
  buffer.clear(black)
  assert.throws(() => buffer.drawPackedBuffer(packed, packed.byteLength + 1, 0, 0, 2, 1))
  assert.throws(() => buffer.drawPackedBuffer(0, packed.byteLength, 0, 0, 2, 1))
  assert.throws(() => buffer.drawPackedBuffer(packed, packed.byteLength, 0, 0, 3, 1))
  assert.throws(() => buffer.drawSuperSampleBuffer(0, 0, pixels, pixels.byteLength + 1, "rgba8unorm", 16))
  assert.throws(() => buffer.drawSuperSampleBuffer(0, 0, pixels, pixels.byteLength, "rgba8unorm", 0))
  assert.throws(() => buffer.drawGrayscaleBuffer(0, 0, new Float32Array([1]), 2, 1))
  assert.throws(() => buffer.drawGrayscaleBuffer(0, 0, new Float32Array([1, NaN]), 2, 1))
  assert.throws(() => buffer.drawGrayscaleBufferSupersampled(0, 0, new Float32Array([1, 1, 1, Infinity]), 2, 2))
  buffer.withBuffers((cells) => assert.deepEqual([...cells.char], new Array(8).fill(32)))
  node.destroy()
  assert.throws(() => draw(buffer, false), /destroyed/)
})
