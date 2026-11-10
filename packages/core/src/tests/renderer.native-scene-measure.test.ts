import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import type { Size } from "../yoga.js"

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

const measureFailures: [string, (box: BoxRenderable) => unknown, number, number][] = [
  ["throws once", () => assert.fail("measure failure"), 1, 1],
  ["returns a promise once", async () => ({ width: 3, height: 1 }), 1, 1],
  ["mutates Yoga once", (box) => box.invalidateIntrinsicSize(), 1, 1],
  ["returns an invalid height once", () => ({ width: 3, height: NaN }), 0, 1],
  ["always throws", () => assert.fail("measure failure"), 1, Infinity],
]

for (const [name, fail, errorsPerFrame, failures] of measureFailures) {
  test(`native measurement that ${name} is retried once on the next frame`, async () => {
    const { renderer, renderOnce, captureSpans } = await setup()
    const box = new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: "red", alignSelf: "flex-start" })
    const peer = new BoxRenderable(renderer, { alignSelf: "flex-start" })
    renderer.root.add(box)
    renderer.root.add(peer)
    await renderOnce()
    const before = captureSpans()
    const errors: unknown[] = []
    renderer.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) => errors.push(event.error))
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    box.width = "auto"
    box.height = "auto"
    let calls = 0
    box.setMeasureProvider(() => (++calls <= failures ? fail(box) : { width: 3, height: 1 }) as Size)
    // A peer measured after the failing node in the same solve must not hide its failure.
    peer.setMeasureProvider(() => ({ width: 1, height: 1 }))
    await renderOnce()
    if (errorsPerFrame) assert.deepEqual(captureSpans(), before)
    await renderOnce()
    await renderOnce()
    assert.deepEqual([calls, errors.length], [2, Math.min(failures, 2) * errorsPerFrame])
    assert.deepEqual([box.getLayout().width, box.getLayout().height], failures < 2 ? [3, 1] : [0, 0])
    // Invalidation starts over: a provider that still fails gets one more retry.
    box.invalidateIntrinsicSize()
    await renderOnce()
    await renderOnce()
    await renderOnce()
    assert.equal(calls, failures < 3 ? 3 : 4)
    assert.deepEqual([box.getLayout().width, box.getLayout().height], failures < 3 ? [3, 1] : [0, 0])
    assert.deepEqual(warn.mock.calls, [])
    warn.mockRestore()
  })
}

test("native measurement that failed at one width is measured again at that width", async () => {
  const { renderer, renderOnce } = await setup()
  const column = new BoxRenderable(renderer, { width: 10, alignItems: "flex-start" })
  const box = new BoxRenderable(renderer, {})
  const widths: number[] = []
  box.setMeasureProvider((width) => {
    widths.push(width)
    return widths.length <= 2 ? { width: NaN, height: NaN } : { width: 3, height: 1 }
  })
  renderer.root.add(column)
  column.add(box)
  await renderOnce()
  await renderOnce()
  column.width = 12
  await renderOnce()
  column.width = 10
  await renderOnce()
  // Yoga may reuse the size measured at 12, but never the failed zero measured at 10.
  assert.deepEqual(widths.slice(0, 3), [10, 10, 12])
  assert.deepEqual([box.width, box.height], [3, 1])
})

test("native measurement that is invalid for one constraint keeps the valid one", async () => {
  const { renderer, renderOnce } = await setup()
  const row = new BoxRenderable(renderer, { flexDirection: "row", flexWrap: "wrap", overflow: "scroll", height: 4 })
  const box = new BoxRenderable(renderer, { flexGrow: 1 })
  // Yoga measures this item twice per solve, first without a width.
  box.setMeasureProvider((width) => ({ width: Math.min(width, 10), height: 2 }))
  renderer.root.add(row)
  row.add(box)
  row.add(new BoxRenderable(renderer, { flexGrow: 1 }))
  await renderOnce()
  await renderOnce()
  assert.deepEqual([box.getLayout().width, box.getLayout().height], [6, 2])
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
  // A destroyed renderable ignores the write.
  box.setMeasureProvider(() => ({ width: 7, height: 1 }))
  await peer.renderOnce()
  assert.equal(other.width, 5)
})
