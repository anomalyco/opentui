import { afterEach, beforeEach, expect, it } from "bun:test"
import { BoxRenderable, type Renderable, TextRenderable } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { createRoot, createSignal } from "solid-js"
import { createSlotNode, insert } from "../index.js"

let setup: Awaited<ReturnType<typeof createTestRenderer>>
let left: BoxRenderable
let right: BoxRenderable
let text: TextRenderable
let slot: ReturnType<typeof createSlotNode>
let dispose: (() => void) | undefined
const tick = () => new Promise<void>((resolve) => process.nextTick(resolve))
beforeEach(async () => {
  setup = await createTestRenderer({
    width: 8,
    height: 6,
    clock: new ManualClock(),
  })
  left = new BoxRenderable(setup.renderer, { id: "duplicate", height: 1 })
  right = new BoxRenderable(setup.renderer, { id: "duplicate", height: 1 })
  text = new TextRenderable(setup.renderer, { id: "duplicate", content: "text", height: 1 })
  for (const host of [left, right, text]) setup.renderer.root.add(host)
  slot = createSlotNode()
})
afterEach(async () => {
  try {
    dispose?.()
    dispose = undefined
    slot.destroy()
  } finally {
    setup.renderer.destroy()
    await setup.renderer.closed
    await tick()
  }
})

it("destroys an attached slot before its host releases layout", () => {
  insert(left, slot)
  const marker = left.getChildren()[0]!
  left.destroyRecursively()
  expect(marker.isDestroyed).toBe(true)
  expect(marker.parent).toBeNull()
  expect(slot.layoutNode).toBeUndefined()
  expect(slot.parent).toBeNull()
})

it("moves slots across layout and text hosts", async () => {
  const [target, setTarget] = createSignal<Renderable>(left)
  dispose = createRoot((dispose) => {
    for (const host of [left, right, text]) {
      insert(host, () => (target() === host ? slot : null))
    }
    return dispose
  })
  const first = left.getChildren()[0]!
  setTarget(right)
  const moved = right.getChildren()[0]!
  expect(moved).toBe(first)
  expect(slot.parent).toBe(right)
  expect(left.getChildren()).toEqual([])
  await tick()
  expect(moved.isDestroyed).toBe(false)
  setTarget(text)
  const textSlot = text.getTextChildren()[0]!
  expect(slot.parent).toBe(text)
  await tick()
  expect(moved.isDestroyed).toBe(true)
  expect(right.getChildren()).toEqual([])
  setTarget(left)
  await tick()
  expect(slot.parent).toBe(left)
  expect(left.getChildren()[0]).not.toBe(first)
  expect(textSlot.parent).toBeNull()
  await setup.renderOnce()
  expect(setup.captureCharFrame().trim()).toBe("text")
})
