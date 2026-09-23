import { describe, expect, it } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { batch, createRoot, createSignal } from "solid-js"
import { createSlotNode, insert } from "../index.js"

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

  it("promotes slot.parent back to another attached host when the newest placeholder is removed", async () => {
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
      parentA.add(childA)

      slot.parent = parentB
      const childB = slot.getSlotChild(parentB)
      parentB.add(childB)

      expect(slot.parent).toBe(parentB)

      parentB.remove(childB)
      slot.didRemoveSlotChild(parentB, childB)

      expect(slot.parent).toBe(parentA)
      expect(parentA.getChildren()[0]).toBe(childA)
      expect(parentB.getChildren()).toHaveLength(0)
    } finally {
      setup.renderer.destroy()
    }
  })
})
