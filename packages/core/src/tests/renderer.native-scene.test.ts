import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { Renderable, RenderableEvents, RootRenderable } from "../Renderable.js"
import { getYogaNode } from "../lib/renderable-layout.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderEvents } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({ width: 20, height: 4, clock: new ManualClock() })
  setups.push(target)
  return target
}

test("ordinary renderer defaults to native scene ownership and presentation", async () => {
  const target = await setup()
  assert.ok(target.renderer.nativeScene)
  const text = new TextRenderable(target.renderer, { content: "native default", width: 18, height: 1 })
  target.renderer.root.add(text)
  const traversal = spyOn(RootRenderable.prototype, "getChildren")
  try {
    await target.renderOnce()
    assert.ok(target.captureCharFrame().includes("native default"))
    assert.equal(target.renderer.hitTest(1, 0), text.num)
    assert.equal(traversal.mock.calls.length, 0)
  } finally {
    traversal.mockRestore()
  }
})

test("renderOnce completes when an active live frame stops after failure", async () => {
  const target = await setup()
  const hold = Promise.withResolvers<void>()
  target.renderer.setFrameCallback(() => hold.promise)
  target.renderer.addPostProcessFn(() => {
    throw new Error("paint failed")
  })
  target.renderer.on(CliRenderEvents.RENDER_ERROR, () => target.renderer.stop())
  target.renderer.start()
  let completed = false
  const frame = target.renderOnce().then(() => {
    completed = true
  })
  try {
    hold.resolve()
    await target.renderer.idle()
    await setImmediate()
    assert.equal(completed, true)
  } finally {
    hold.resolve()
    target.renderer.destroy()
    await frame
  }
})

test("concurrent renderOnce callers wait for an intervening redraw", async () => {
  const target = await setup()
  const first = Promise.withResolvers<void>()
  const redraw = Promise.withResolvers<void>()
  let calls = 0
  target.renderer.setFrameCallback(() => (++calls === 1 ? first.promise : redraw.promise))
  const active = target.renderOnce()
  let completed = 0
  const observers = [target.renderOnce(), target.renderOnce()].map((frame) =>
    frame.then(() => {
      completed++
    }),
  )
  try {
    first.resolve()
    for (let turn = 0; turn < 32 && calls < 2; turn++) await setImmediate()
    assert.equal(calls, 2)
    await setImmediate()
    assert.equal(completed, 0)
    redraw.resolve()
    await Promise.all(observers)
    assert.equal(target.renderer.getSchedulerState().isRendering, false)
  } finally {
    first.resolve()
    redraw.resolve()
    await Promise.all([active, ...observers])
  }
})

test("an overlapping scheduled activation does not consume the resized repaint", async () => {
  const clock = new ManualClock()
  const target = await createTestRenderer({ width: 32, height: 12, clock })
  setups.push(target)
  target.renderer.root.add(new TextRenderable(target.renderer, { content: "resize repaint" }))
  await target.renderOnce()
  for (let turn = 0; turn < 4; turn++) {
    clock.advance(100)
    await setImmediate()
  }
  const hold = Promise.withResolvers<void>()
  target.renderer.setFrameCallback(() => hold.promise)
  target.renderer.requestRender()
  const frame = target.renderOnce()
  try {
    await setImmediate()
    target.renderer.requestResize(20, 4)
    clock.advance(100)
    await setImmediate()
    hold.resolve()
    await frame
    for (let turn = 0; turn < 8; turn++) {
      clock.advance(100)
      await setImmediate()
    }
    assert.deepEqual([target.renderer.width, target.renderer.height], [20, 4])
    assert.ok(target.captureCharFrame().includes("resize repaint"))
  } finally {
    hold.resolve()
    await frame
  }
})

test("fractional transforms preserve display-cell boundaries and border-inset clipping", async () => {
  for (const axis of ["x", "y"] as const) {
    for (const translation of [-0.5, 0.999999999, 0.1]) {
      const target = await setup()
      const parent = new BoxRenderable(target.renderer, {
        width: 4,
        height: 4,
        border: translation < 0 ? [axis === "x" ? "left" : "top"] : false,
        overflow: translation < 0 ? "hidden" : "visible",
      })
      const child = new BoxRenderable(target.renderer, { width: 1, height: 1, backgroundColor: "#00ff00" })
      parent.add(child)
      target.renderer.root.add(parent)
      if (axis === "x") parent.translateX = translation
      else parent.translateY = translation
      await target.renderOnce()
      assert.equal(target.renderer.hitTest(0, 0), child.num)
      const coordinate = translation + (translation < 0 ? 1 : 0)
      assert.deepEqual([child.x, child.y], axis === "x" ? [coordinate, 0] : [0, coordinate])
      target.renderer.currentRenderBuffer.withBuffers(({ bg }) => {
        assert.deepEqual([...bg.subarray(0, 4)], [0, 255, 0, 255])
      })
    }
  }
})

test("native scene destroys 10,000 boxes once without invalidating another renderer", async () => {
  const survivor = await setup()
  const text = new TextRenderable(survivor.renderer, { content: "survivor" })
  survivor.renderer.root.add(text)
  await survivor.renderOnce()
  const before = survivor.captureSpans()
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const target = await setup()
  const owned: Renderable[] = [target.renderer.root]
  let destroyed = 0
  // Short chains exercise recursive cleanup without exceeding Yoga's depth limit.
  for (let branch = 0; branch < 100; branch++) {
    let parent: Renderable = target.renderer.root
    for (let depth = 0; depth < 100; depth++) {
      const box = new BoxRenderable(target.renderer, { width: 1, height: 1 })
      parent.add(box)
      owned.push(box)
      parent = box
    }
  }
  for (const node of owned) node.on(RenderableEvents.DESTROYED, () => destroyed++)
  const layouts = owned.map((node) => getYogaNode(node))
  await target.renderOnce()
  target.renderer.destroy()
  target.renderer.destroy()
  await target.renderer.closed
  assert.equal(destroyed, 10_001)
  assert.ok(owned.every((node) => node.isDestroyed && node.parent === null))
  assert.ok(owned.every((node) => node.listenerCount(RenderableEvents.DESTROYED) === 0))
  assert.ok(layouts.every((node) => node.isFreed()))
  assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), registered)
  await survivor.renderOnce()
  assert.deepEqual(survivor.captureSpans(), before)
  text.content = "still usable"
  await survivor.renderOnce()
  assert.ok(survivor.captureCharFrame().includes("still usable"))
}, 30_000)

test("native scene hits cannot target destroyed or foreign nodes before presentation", async () => {
  const target = await setup()
  const peer = await setup()
  const first = new BoxRenderable(target.renderer, { width: 3, height: 2 })
  target.renderer.root.add(first)
  await target.renderOnce()
  assert.equal(target.renderer.hitTest(0, 0), first.num)
  first.destroy()
  const replacement = new BoxRenderable(target.renderer, { width: 3, height: 2 })
  target.renderer.root.add(replacement)
  assert.equal(target.renderer.hitTest(0, 0), 0)
  assert.throws(() => peer.renderer.root.add(replacement), /context|scene|owner/i)
  assert.equal(replacement.parent, target.renderer.root)
  assert.deepEqual(peer.renderer.root.getChildren(), [])
  await target.renderOnce()
  assert.equal(target.renderer.hitTest(0, 0), replacement.num)
})

test("native hover cleanup cannot dispatch to destroyed nodes or publish a later frame", async () => {
  const target = await setup()
  const a = new BoxRenderable(target.renderer, { position: "absolute", left: 0, width: 3, height: 2 })
  const b = new BoxRenderable(target.renderer, { position: "absolute", left: 8, width: 3, height: 2 })
  target.renderer.root.add(a)
  target.renderer.root.add(b)
  await target.renderOnce()
  await target.mockMouse.moveTo(1, 0)
  const events: string[] = []
  a.onMouseOut = () => {
    events.push("out")
    target.renderer.destroy()
  }
  b.onMouseOver = () => events.push(`over:${b.isDestroyed}`)
  target.renderer.on(CliRenderEvents.DESTROY, () => events.push("destroy"))
  target.renderer.on(CliRenderEvents.FRAME, () => events.push("frame"))
  a.left = 8
  b.left = 0
  await target.renderOnce()
  await target.renderer.closed
  assert.deepEqual(events, ["out", "destroy"])
})
