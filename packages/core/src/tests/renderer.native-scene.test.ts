import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderEvents } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import siblingOrder from "./fixtures/sibling-paint-order.json" with { type: "json" }

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

for (const row of siblingOrder) {
  test(`sibling paint and hits: ${row.name}`, async () => {
    const observe = async (fresh: boolean) => {
      const { renderer, renderOnce, captureCharFrame } = await setup()
      const parent = renderer.root
      const nodes = [..."ABC"].map(
        (key, i) =>
          new TextRenderable(renderer, {
            id: key,
            content: key.repeat(3 - i),
            position: "absolute",
            width: 3 - i,
            height: 1,
            zIndex: Number(key === row.raised),
          }),
      )
      const node = (key: string) => nodes["ABC".indexOf(key)]!
      if (row.reparent) {
        const other = new BoxRenderable(renderer, { width: 0, height: 0 })
        parent.add(other)
        if (!fresh) other.add(node(row.key))
      }
      for (const key of fresh ? row.after : row.before) parent.add(node(key))
      if (!fresh) {
        await renderOnce()
        const next = row.after[row.after.indexOf(row.key) + 1]
        parent.insertBefore(node(row.key), next ? node(next) : undefined)
      }
      await renderOnce()
      return [
        captureCharFrame().slice(0, 3),
        [0, 1, 2]
          .map((x) => {
            const hit = renderer.hitTest(x, 0)
            return nodes.find((node) => node.num === hit)?.id ?? "?"
          })
          .join(""),
      ]
    }
    const fresh = await observe(true)
    assert.deepEqual(fresh, [row.frame, row.frame])
    assert.deepEqual(await observe(false), fresh)
  })
}

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
