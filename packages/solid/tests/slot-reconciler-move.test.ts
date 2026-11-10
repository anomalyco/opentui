import { describe, expect, it } from "bun:test"
import { BoxRenderable, LineNumberRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { batch, createRoot, createSignal } from "solid-js"
import { createSlotNode, insert, insertNode } from "../index.js"
import { LayoutSlotRenderable } from "../src/elements/slot.js"

type MoveOrder = "remove-then-insert" | "insert-then-remove"

async function runMoveScenario(order: MoveOrder) {
  const setup = await createTestRenderer({ width: 40, height: 10 })
  const parentA = new BoxRenderable(setup.renderer, {
    id: `slot-parent-a-${order}`,
    width: 10,
    height: 1,
  })
  const parentB = new BoxRenderable(setup.renderer, {
    id: `slot-parent-b-${order}`,
    width: 10,
    height: 1,
  })

  setup.renderer.root.add(parentA)
  setup.renderer.root.add(parentB)

  const slot = createSlotNode()
  const controls = createRoot((dispose) => {
    const [inParentA, setInParentA] = createSignal(true)
    const [inParentB, setInParentB] = createSignal(false)

    const mountInParentA = () => (inParentA() ? slot : null)
    const mountInParentB = () => (inParentB() ? slot : null)

    if (order === "remove-then-insert") {
      insert(parentA, mountInParentA)
      insert(parentB, mountInParentB)
    } else {
      insert(parentB, mountInParentB)
      insert(parentA, mountInParentA)
    }

    return {
      dispose,
      move(): void {
        batch(() => {
          setInParentB(true)
          setInParentA(false)
        })
      },
    }
  })

  const originalChild = parentA.getChildren()[0]
  if (!originalChild) {
    throw new Error(`Expected slot child in parent A for ${order}`)
  }

  controls.move()

  const movedChild = parentB.getChildren()[0]
  if (!movedChild) {
    throw new Error(`Expected slot child in parent B for ${order}`)
  }

  await Bun.sleep(0)

  return {
    controls,
    movedChild,
    originalChild,
    parentA,
    parentB,
    setup,
    slot,
  }
}

describe("slot placeholder moves", () => {
  it.each([false, true])("keeps rejected slots reusable (existing host: %p)", async (attached) => {
    const setup = await createTestRenderer({ width: 20, height: 5 })
    const rejecting = new LineNumberRenderable(setup.renderer, {})
    setup.renderer.root.add(rejecting)
    const slot = createSlotNode()

    try {
      if (attached) insertNode(setup.renderer.root, slot)
      const rejected = slot.getSlotChild(rejecting)
      if (!(rejected instanceof LayoutSlotRenderable)) throw new Error("Expected layout placeholder")
      insertNode(rejecting, slot)

      expect(rejected.isFreed()).toBe(true)
      expect(slot.getSlotChildForRemoval(rejecting)).toBeUndefined()

      insertNode(rejecting, new TextRenderable(setup.renderer, { content: "target" }), slot)
      expect(slot.getSlotChildForRemoval(rejecting)).toBeUndefined()

      insertNode(setup.renderer.root, slot)
      const accepted = slot.getSlotChild(setup.renderer.root)
      if (!(accepted instanceof LayoutSlotRenderable)) throw new Error("Expected layout placeholder")
      expect(accepted.parent).toBe(setup.renderer.root)
      expect(accepted.isFreed()).toBe(false)
      setup.renderer.destroy()
      expect(accepted.isFreed()).toBe(true)
    } finally {
      setup.renderer.destroy()
      slot.destroy()
    }
  })

  it("preserves attachment for remove-then-insert registration order", async () => {
    const { controls, movedChild, originalChild, parentA, parentB, setup, slot } =
      await runMoveScenario("remove-then-insert")

    try {
      expect(movedChild).not.toBe(originalChild)
      expect(originalChild.isDestroyed).toBe(true)
      expect(parentA.getChildren()).toHaveLength(0)
      expect(parentB.getChildren()).toHaveLength(1)
      expect(parentB.getChildren()[0]).toBe(movedChild)
      expect(movedChild.parent).toBe(parentB)
      expect(movedChild.isDestroyed).toBe(false)
      expect((slot as any).destroyed).toBe(false)
    } finally {
      controls.dispose()
      setup.renderer.destroy()
    }
  })

  it("recreates attached layout placeholders for insert-then-remove moves", async () => {
    const { controls, movedChild, originalChild, parentA, parentB, setup, slot } =
      await runMoveScenario("insert-then-remove")

    try {
      expect(movedChild).not.toBe(originalChild)
      expect(parentA.getChildren()).toHaveLength(0)
      expect(parentB.getChildren()).toHaveLength(1)
      expect(parentB.getChildren()[0]).toBe(movedChild)
      expect(movedChild.parent).toBe(parentB)
      expect(movedChild.isDestroyed).toBe(false)
      expect((slot as any).destroyed).toBe(false)
    } finally {
      controls.dispose()
      setup.renderer.destroy()
    }
  })

  it.each(["remove", "destroy subtree"])("preserves the other attached slot host on %s", async (cleanup) => {
    const setup = await createTestRenderer({ width: 40, height: 10 })
    const parentA = new BoxRenderable(setup.renderer, {
      id: "slot-parent-host-a",
      width: 10,
      height: 1,
    })
    const parentB = new BoxRenderable(setup.renderer, {
      id: "slot-parent-host-b",
      width: 10,
      height: 1,
    })

    setup.renderer.root.add(parentA)
    setup.renderer.root.add(parentB)

    const slot = createSlotNode()

    try {
      slot.parent = parentA
      const childA = slot.getSlotChild(parentA)
      if (!(childA instanceof LayoutSlotRenderable)) throw new Error("Expected layout placeholder")
      parentA.add(childA)

      slot.parent = parentB
      const childB = slot.getSlotChild(parentB)
      if (!(childB instanceof LayoutSlotRenderable)) throw new Error("Expected layout placeholder")
      parentB.add(childB)

      expect(slot.parent).toBe(parentB)

      if (cleanup === "remove") {
        parentB.remove(childB)
        slot.didRemoveSlotChild(parentB, childB)
      } else {
        parentB.destroyRecursively()
      }

      expect(slot.parent).toBe(parentA)
      expect(parentA.getChildren()[0]).toBe(childA)
      expect(parentB.getChildren()).toHaveLength(0)
      expect(childA.isFreed()).toBe(false)
      expect(childB.isFreed()).toBe(true)

      setup.renderer.destroy()
      expect(childA.isFreed()).toBe(true)
    } finally {
      setup.renderer.destroy()
      slot.destroy()
    }
  })
})
