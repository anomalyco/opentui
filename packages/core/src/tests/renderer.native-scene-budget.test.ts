import { test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderEvents } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test.each(["nativeScenePaintBudget", "nativeSceneWorkBudget"] as const)("%s rejects invalid limits", async (key) => {
  for (const limit of [0, -1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    await assert.rejects(createTestRenderer({ [key]: limit }), /positive u32/)
  }
})

test("native paint budget still completes and sheds work added mid-frame", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    nativeScenePaintBudget: 1,
    width: 8,
    height: 2,
    clock: new ManualClock(),
  })
  const errors: unknown[] = []
  const children = Array.from("ABC", (content, left) => {
    const child = new TextRenderable(renderer, {
      selectable: false,
      content,
      position: "absolute",
      left,
      width: 1,
      height: 1,
    })
    renderer.root.add(child)
    return child
  })
  let presented = false
  renderer.on(CliRenderEvents.FRAME, () => {
    presented = true
  })
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  try {
    const turn = setImmediate().then(() => {
      assert.equal(presented, false)
      renderer.root.add(
        new TextRenderable(renderer, { content: "D", position: "absolute", left: 3, width: 1, height: 1 }),
      )
    })
    await Promise.all([renderOnce(), turn])
    assert.deepEqual(errors, [])
    assert.equal(captureCharFrame().split("\n")[0], "ABC     ")
    assert.equal(renderer.hitTest(2, 0), children[2].num)
    await renderOnce()
    assert.equal(captureCharFrame().split("\n")[0], "ABCD    ")
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
