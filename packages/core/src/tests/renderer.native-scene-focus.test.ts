import { test } from "bun:test"
import assert from "node:assert/strict"
import { BoxRenderable } from "../renderables/Box.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test("native focus-within border follows reparenting, detach, reattach, and focusable changes", async () => {
  const target = await createTestRenderer({ width: 20, height: 8, clock: new ManualClock() })
  const { renderer, renderOnce } = target
  const parents = [0, 10].map((left) => {
    const box = new BoxRenderable(renderer, {
      position: "absolute",
      left,
      width: 10,
      height: 7,
      border: true,
      focusable: true,
      borderColor: "blue",
      focusedBorderColor: "red",
    })
    renderer.root.add(box)
    return box
  })
  const bridge = new BoxRenderable(renderer, {
    width: 8,
    height: 5,
    border: true,
    borderColor: "green",
    focusedBorderColor: "red",
  })
  const child = new BoxRenderable(renderer, { width: 4, height: 2, focusable: true })
  const color = (box: BoxRenderable) =>
    renderer.currentRenderBuffer.withBuffers(({ fg, width }) => {
      const offset = (box.y * width + box.x) * 4
      return [...fg.subarray(offset, offset + 4)]
    })
  bridge.add(child)
  parents[0].add(bridge)
  try {
    child.focus()
    for (const owner of [parents[0], parents[1], null, parents[0]]) {
      if (owner) owner.add(bridge)
      else bridge.parent!.remove(bridge)
      assert.deepEqual(
        parents.map((box) => box.hasFocusedDescendant),
        parents.map((box) => box === owner),
      )
      assert.equal(renderer.root.hasFocusedDescendant, owner !== null)
      await renderOnce()
      for (const parent of parents) {
        assert.deepEqual(color(parent), parent === owner ? [255, 0, 0, 255] : [0, 0, 255, 255])
      }
      if (owner) assert.deepEqual(color(bridge), [0, 128, 0, 255])
    }
    for (const focusable of [false, true]) {
      parents[0].focusable = focusable
      await renderOnce()
      assert.deepEqual(color(parents[0]), focusable ? [255, 0, 0, 255] : [0, 0, 255, 255])
    }
    child.blur()
    await renderOnce()
    assert.deepEqual(color(parents[0]), [0, 0, 255, 255])
  } finally {
    bridge.destroyRecursively()
    renderer.destroy()
    await renderer.closed
  }
})
