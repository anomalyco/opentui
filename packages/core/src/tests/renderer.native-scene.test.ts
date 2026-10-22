import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
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
  await target.renderOnce()
  assert.ok(target.captureCharFrame().includes("native default"))
  assert.equal(target.renderer.hitTest(1, 0), text.num)
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

test("destroying one renderer does not invalidate another", async () => {
  const survivor = await setup()
  const text = new TextRenderable(survivor.renderer, { content: "survivor" })
  survivor.renderer.root.add(text)
  await survivor.renderOnce()
  const doomed = await setup()
  doomed.renderer.root.add(new BoxRenderable(doomed.renderer, { width: 1, height: 1 }))
  await doomed.renderOnce()
  doomed.renderer.destroy()
  doomed.renderer.destroy()
  await doomed.renderer.closed
  text.content = "still usable"
  await survivor.renderOnce()
  assert.ok(survivor.captureCharFrame().includes("still usable"))
})

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
