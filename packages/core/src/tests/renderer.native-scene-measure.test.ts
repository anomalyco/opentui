import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []
async function setup() {
  const target = await createTestRenderer({
    width: 12,
    height: 4,
    clock: new ManualClock(),
  })
  setups.push(target)
  return target
}

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

test("native custom measurement replaces, dirties, and clears", async () => {
  const { renderer, renderOnce } = await setup()
  const text = new TextRenderable(renderer, { content: "abcdef", selectable: false, alignSelf: "flex-start" })
  renderer.root.add(text)
  text.setMeasureProvider(() => ({ width: 3, height: 2 }))
  await renderOnce()
  assert.equal(text.width, 3)
  assert.equal(text.height, 2)
  text.setMeasureProvider(() => ({ width: 5, height: 2 }))
  text.invalidateIntrinsicSize()
  await renderOnce()
  assert.equal(text.width, 5)
  text.setMeasureProvider(null)
  text.invalidateIntrinsicSize()
  await renderOnce()
  assert.equal(text.getLayout().width, 0)
  assert.equal(text.getLayout().height, 0)
})

test("native measurement exceptions preserve the previous frame and permit retry", async () => {
  const { renderer, renderOnce, captureSpans } = await setup()
  const box = new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: "red" })
  renderer.root.add(box)
  await renderOnce()
  const before = captureSpans()
  const errors: unknown[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) => errors.push(event.error))
  box.width = "auto"
  box.height = "auto"
  const failure = new Error("measure failure")
  box.setMeasureProvider(() => {
    throw failure
  })
  await renderOnce()
  assert.deepEqual(errors, [failure])
  assert.deepEqual(captureSpans(), before)
  box.setMeasureProvider(() => ({ width: 3, height: 1 }))
  await renderOnce()
  assert.equal(box.height, 1)
  assert.deepEqual(errors, [failure])
})

test("native measured leaves reject children and destroyed providers cannot poison a peer", async () => {
  const target = await setup()
  const peer = await setup()
  const box = new BoxRenderable(target.renderer, { alignSelf: "flex-start" })
  const child = new BoxRenderable(target.renderer, {})
  const other = new BoxRenderable(peer.renderer, { alignSelf: "flex-start" })
  box.setMeasureProvider(() => ({ width: 3, height: 1 }))
  assert.throws(() => box.add(child), /InvalidArgument/i)
  assert.equal(child.parent, null)
  box.setMeasureProvider(null)
  box.add(child)
  assert.throws(() => box.setMeasureProvider(() => ({ width: 8, height: 1 })), /InvalidArgument/i)
  box.remove(child)
  other.setMeasureProvider(() => ({ width: 5, height: 1 }))
  peer.renderer.root.add(other)
  box.destroy()
  assert.throws(() => box.setMeasureProvider(() => ({ width: 7, height: 1 })), /destroyed/)
  await peer.renderOnce()
  assert.equal(other.width, 5)
})
