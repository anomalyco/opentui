import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { BoxRenderable, Renderable, RenderableEvents, TextRenderable } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { createRoot, createSignal } from "solid-js"
import { createSlotNode, insert, removeNode } from "../index.js"

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
    footerHeight: 4,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
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

it.each(["remove-first", "insert-first"])("moves slots across layout and text hosts (%s)", async (order) => {
  const [target, setTarget] = createSignal<Renderable>(left)
  dispose = createRoot((dispose) => {
    for (const host of order === "remove-first" ? [left, right, text] : [text, right, left]) {
      insert(host, () => (target() === host ? slot : null))
    }
    return dispose
  })
  const first = left.getChildren()[0]!
  setTarget(right)
  const moved = right.getChildren()[0]!
  expect(moved === first).toBe(order === "remove-first")
  expect(slot.parent).toBe(right)
  expect(left.getChildren()).toEqual([])
  await tick()
  expect(moved.isDestroyed).toBe(false)
  expect(first.isDestroyed).toBe(order === "insert-first")
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

it.each(["destroy", "remove"])("releases slot markers before rethrowing observer failures (%s)", async (mode) => {
  for (const host of mode === "destroy" ? [left, right, text] : [left, right]) insert(host, slot)
  const first = left.getChildren()[0]!
  const second = right.getChildren()[0]!
  const markers = mode === "destroy" ? [first, second] : [second]
  const destroyed: Renderable[] = []
  for (const [index, marker] of markers.entries())
    marker.on(RenderableEvents.DESTROYED, () => {
      destroyed.push(marker)
      if (mode === "remove") expect(slot.parent).toBe(left)
      throw new Error(`marker ${index} failed`)
    })
  const textMarker = text.getTextChildren()[0]
  const destroyText = textMarker && spyOn(textMarker, "destroy")
  try {
    expect(() => (mode === "destroy" ? slot.destroy() : removeNode(right, slot))).toThrow("marker 0 failed")
    expect(destroyed).toEqual(markers)
    for (const marker of markers) {
      expect(marker.isDestroyed).toBe(true)
      expect(marker.parent).toBeNull()
      expect([...setup.renderer.nativeScene!.getRenderables()]).not.toContain(marker)
    }
    if (mode === "remove") {
      expect(slot.layoutNode === first).toBe(true)
      expect(first.isDestroyed).toBe(false)
      await setup.renderOnce()
    } else {
      expect(slot.parent).toBeNull()
      expect(slot.layoutNode).toBeUndefined()
      expect(slot.textNode).toBeUndefined()
      expect(text.getTextChildren()).toEqual([])
      expect(textMarker!.parent).toBeNull()
      expect(() => slot.destroy()).not.toThrow()
      expect(destroyText).toHaveBeenCalledTimes(1)
      expect(destroyed).toEqual(markers)
    }
  } finally {
    destroyText?.mockRestore()
  }
})

it("allocates new markers when moving across scenes sharing a Context", async () => {
  const surface = setup.renderer.createScrollbackSurface()
  insert(left, slot)
  const first = left.getChildren()[0]!
  removeNode(left, slot)
  insert(surface.root, slot)
  const detached = surface.root.getChildren()[0]!
  expect(detached).not.toBe(first)
  expect(first.isDestroyed).toBe(true)
  expect(detached.ctx.nativeScene).toBe(surface.renderContext.nativeScene)
  await tick()
  expect(detached.isDestroyed).toBe(false)
  surface.render()
  removeNode(surface.root, slot)
  insert(left, slot)
  const returned = left.getChildren()[0]!
  expect(returned.ctx.nativeScene).toBe(setup.renderer.nativeScene)
  surface.destroy()
  await tick()
  expect(detached.isDestroyed).toBe(true)
  expect(slot.parent).toBe(left)
  expect(returned.isDestroyed).toBe(false)
  await setup.renderOnce()
})
