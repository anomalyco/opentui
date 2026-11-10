import { describe, expect, test } from "bun:test"
import { OrderedRegistry, PriorityRegistry } from "../registry.js"

describe("keymap registries", () => {
  describe("OrderedRegistry", () => {
    test("starts empty and supports no-op remove and clear", () => {
      const registry = new OrderedRegistry<string>()

      expect(registry.has()).toBe(false)
      expect(registry.values()).toEqual([])
      expect(registry.remove("missing")).toBe(false)

      registry.clear()

      expect(registry.has()).toBe(false)
      expect(registry.values()).toEqual([])
    })

    test("preserves prepend and append order while keeping previous snapshots stable", () => {
      const registry = new OrderedRegistry<string>()

      registry.append("middle")
      const firstSnapshot = registry.values()

      registry.prepend("start")
      const secondSnapshot = registry.values()

      registry.append("end")

      expect(firstSnapshot).toEqual(["middle"])
      expect(secondSnapshot).toEqual(["start", "middle"])
      expect(registry.values()).toEqual(["start", "middle", "end"])

      registry.clear()

      expect(firstSnapshot).toEqual(["middle"])
      expect(secondSnapshot).toEqual(["start", "middle"])
      expect(registry.values()).toEqual([])
    })

    test("removes all matching primitive values and only matching object references", () => {
      const registry = new OrderedRegistry<string | { name: string }>()
      const shared = { name: "shared" }
      const sameShape = { name: "shared" }

      registry.append("dup")
      registry.append("dup")
      registry.append(shared)
      registry.append(sameShape)

      expect(registry.remove({ name: "shared" })).toBe(false)
      expect(registry.values()).toEqual(["dup", "dup", shared, sameShape])

      expect(registry.remove("dup")).toBe(true)
      expect(registry.values()).toEqual([shared, sameShape])

      expect(registry.remove(shared)).toBe(true)
      expect(registry.values()).toEqual([sameShape])
      expect(registry.remove(shared)).toBe(false)
    })

    test("returned unregister functions are idempotent and remove all matching values", () => {
      const registry = new OrderedRegistry<string>()

      const offFirst = registry.append("dup")
      const offSecond = registry.prepend("dup")

      expect(registry.values()).toEqual(["dup", "dup"])
      expect(registry.has()).toBe(true)

      offFirst()

      expect(registry.values()).toEqual([])
      expect(registry.has()).toBe(false)

      offFirst()
      offSecond()

      expect(registry.values()).toEqual([])
      expect(registry.has()).toBe(false)
    })
  })

  describe("PriorityRegistry", () => {
    test("starts empty and supports no-op clear", () => {
      const registry = new PriorityRegistry<string, { priority: number }>()

      expect(registry.has()).toBe(false)
      expect(registry.entries()).toEqual([])

      registry.clear()

      expect(registry.has()).toBe(false)
      expect(registry.entries()).toEqual([])
    })

    test("sorts by descending priority, preserves tie order, and keeps metadata", () => {
      const registry = new PriorityRegistry<string, { priority: number; release: boolean }>()

      registry.register("low-press", { priority: -1, release: false })
      registry.register("high-release", { priority: 5, release: true })
      registry.register("mid-press", { priority: 2, release: false })
      registry.register("high-press", { priority: 5, release: false })

      expect(registry.entries()).toEqual([
        { listener: "high-release", priority: 5, release: true, order: 1 },
        { listener: "high-press", priority: 5, release: false, order: 3 },
        { listener: "mid-press", priority: 2, release: false, order: 2 },
        { listener: "low-press", priority: -1, release: false, order: 0 },
      ])
      expect(registry.has()).toBe(true)
    })

    test("keeps previous entry snapshots stable across registration, removal, and clear", () => {
      const registry = new PriorityRegistry<string, { priority: number }>()

      const offLow = registry.register("low", { priority: 0 })
      const firstSnapshot = registry.entries()

      registry.register("high", { priority: 10 })
      const secondSnapshot = registry.entries()

      offLow()

      expect(firstSnapshot).toEqual([{ listener: "low", priority: 0, order: 0 }])
      expect(secondSnapshot).toEqual([
        { listener: "high", priority: 10, order: 1 },
        { listener: "low", priority: 0, order: 0 },
      ])
      expect(registry.entries()).toEqual([{ listener: "high", priority: 10, order: 1 }])

      registry.clear()

      expect(secondSnapshot).toEqual([
        { listener: "high", priority: 10, order: 1 },
        { listener: "low", priority: 0, order: 0 },
      ])
      expect(registry.entries()).toEqual([])
    })

    test("returned unregister removes only its own registration and stays idempotent after clear", () => {
      const registry = new PriorityRegistry<string, { priority: number }>()

      const offFirst = registry.register("dup", { priority: 1 })
      const offSecond = registry.register("dup", { priority: 1 })

      expect(registry.entries()).toEqual([
        { listener: "dup", priority: 1, order: 0 },
        { listener: "dup", priority: 1, order: 1 },
      ])

      offFirst()

      expect(registry.entries()).toEqual([{ listener: "dup", priority: 1, order: 1 }])
      expect(registry.has()).toBe(true)

      offFirst()

      expect(registry.entries()).toEqual([{ listener: "dup", priority: 1, order: 1 }])

      registry.clear()

      expect(registry.entries()).toEqual([])
      expect(registry.has()).toBe(false)

      offSecond()

      expect(registry.entries()).toEqual([])

      registry.register("after-clear", { priority: 1 })

      expect(registry.entries()).toEqual([{ listener: "after-clear", priority: 1, order: 2 }])
    })
  })
})
