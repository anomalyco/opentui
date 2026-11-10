import { test, expect, describe } from "bun:test"
import { getObjectsInViewport } from "./objects-in-viewport.js"
import type { ViewportBounds } from "../types.js"

interface TestObject {
  x: number
  y: number
  screenX: number
  screenY: number
  width: number
  height: number
  zIndex: number
  id: string
}

function createObject(id: string, x: number, y: number, width: number, height: number, zIndex: number = 0): TestObject {
  return { id, x, y, screenX: x, screenY: y, width, height, zIndex }
}

describe("getObjectsInViewport", () => {
  describe("basic functionality", () => {
    test("returns empty array for empty input", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 100, height: 100 }
      const result = getObjectsInViewport(viewport, [])
      expect(result).toEqual([])
    })

    test("returns all objects when count is below minTriggerSize", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 100, height: 100 }
      const objects = [createObject("1", 0, 0, 10, 10), createObject("2", 200, 200, 10, 10)]
      const result = getObjectsInViewport(viewport, objects, "column", 10, 16)
      expect(result).toEqual(objects)
    })

    test("filters objects outside viewport in column direction", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 20, 100, 20))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("obj-5")
      expect(visibleIds).toContain("obj-6")
      expect(visibleIds).toContain("obj-9")
      expect(visibleIds).not.toContain("obj-0")
      expect(visibleIds).not.toContain("obj-15")
    })

    test("filters objects outside viewport in row direction", () => {
      const viewport: ViewportBounds = { x: 100, y: 0, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, i * 20, 0, 20, 100))

      const result = getObjectsInViewport(viewport, objects, "row", 0, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("obj-5")
      expect(visibleIds).toContain("obj-6")
      expect(visibleIds).toContain("obj-9")
      expect(visibleIds).not.toContain("obj-0")
      expect(visibleIds).not.toContain("obj-15")
    })
  })

  describe("padding behavior", () => {
    test("includes objects within padding distance", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 20, 100, 20))

      const result = getObjectsInViewport(viewport, objects, "column", 20, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("obj-4")
      expect(visibleIds).toContain("obj-10")
    })

    test("respects custom padding values", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = Array.from({ length: 30 }, (_, i) => createObject(`obj-${i}`, 0, i * 20, 100, 20))

      const resultNoPadding = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const resultWithPadding = getObjectsInViewport(viewport, objects, "column", 50, 16)

      expect(resultWithPadding.length).toBeGreaterThan(resultNoPadding.length)
    })
  })

  describe("zIndex sorting", () => {
    test("sorts visible objects by zIndex", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 10, 100, 10, 20 - i))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      for (let i = 1; i < result.length; i++) {
        expect(result[i].zIndex).toBeGreaterThanOrEqual(result[i - 1].zIndex)
      }
    })

    test("handles objects with same zIndex", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 10, 100, 10, 5))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      expect(result.every((obj) => obj.zIndex === 5)).toBe(true)
    })

    test("handles mixed zIndex values", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 10, 100, 10, i % 3))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      for (let i = 1; i < result.length; i++) {
        expect(result[i].zIndex).toBeGreaterThanOrEqual(result[i - 1].zIndex)
      }
    })
  })

  describe("edge cases - boundary conditions", () => {
    test("includes object that starts at viewport top", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 20, 100, 20))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("obj-5")
    })

    test("excludes object that ends exactly at viewport start (no padding)", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = [
        createObject("before", 0, 50, 100, 50),
        ...Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, (i + 5) * 20, 100, 20)),
      ]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).not.toContain("before")
    })

    test("excludes object that starts exactly at viewport end (no padding)", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = [
        createObject("after", 0, 200, 100, 20),
        ...Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 20, 100, 20)),
      ]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).not.toContain("after")
    })
  })

  describe("cross-axis filtering", () => {
    test("filters objects outside viewport on cross-axis (column mode)", () => {
      const viewport: ViewportBounds = { x: 50, y: 100, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) =>
        createObject(`obj-${i}`, i % 2 === 0 ? 0 : 60, i * 20, 40, 20),
      )

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      result.forEach((obj) => {
        const objectRight = obj.x + obj.width
        expect(objectRight).toBeGreaterThan(viewport.x)
        expect(obj.x).toBeLessThan(viewport.x + viewport.width)
      })
    })

    test("filters objects outside viewport on cross-axis (row mode)", () => {
      const viewport: ViewportBounds = { x: 100, y: 50, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) =>
        createObject(`obj-${i}`, i * 20, i % 2 === 0 ? 0 : 60, 20, 40),
      )

      const result = getObjectsInViewport(viewport, objects, "row", 0, 16)

      result.forEach((obj) => {
        const objectBottom = obj.y + obj.height
        expect(objectBottom).toBeGreaterThan(viewport.y)
        expect(obj.y).toBeLessThan(viewport.y + viewport.height)
      })
    })
  })

  describe("scrolling simulation - vertical", () => {
    const createScrollList = () => {
      return Array.from({ length: 100 }, (_, i) => createObject(`item-${i}`, 0, i * 50, 200, 50, i % 10))
    }

    test("viewport at top", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 200, height: 300 }
      const objects = createScrollList()

      const result = getObjectsInViewport(viewport, objects, "column", 10, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("item-0")
      expect(visibleIds).toContain("item-5")
      expect(visibleIds).not.toContain("item-20")
    })

    test("viewport scrolled to middle", () => {
      const viewport: ViewportBounds = { x: 0, y: 2000, width: 200, height: 300 }
      const objects = createScrollList()

      const result = getObjectsInViewport(viewport, objects, "column", 10, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("item-40")
      expect(visibleIds).toContain("item-45")
      expect(visibleIds).not.toContain("item-0")
      expect(visibleIds).not.toContain("item-99")
    })

    test("viewport at bottom", () => {
      const viewport: ViewportBounds = { x: 0, y: 4700, width: 200, height: 300 }
      const objects = createScrollList()

      const result = getObjectsInViewport(viewport, objects, "column", 10, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("item-94")
      expect(visibleIds).toContain("item-99")
      expect(visibleIds).not.toContain("item-0")
      expect(visibleIds).not.toContain("item-50")
    })

    test("small incremental scrolls", () => {
      const objects = createScrollList()

      for (let scrollY = 0; scrollY < 1000; scrollY += 10) {
        const viewport: ViewportBounds = { x: 0, y: scrollY, width: 200, height: 300 }
        const result = getObjectsInViewport(viewport, objects, "column", 10, 16)

        result.forEach((obj) => {
          const objectBottom = obj.y + obj.height
          expect(objectBottom).toBeGreaterThan(viewport.y - 10)
          expect(obj.y).toBeLessThan(viewport.y + viewport.height + 10)
        })
      }
    })
  })

  describe("scrolling simulation - horizontal", () => {
    const createHorizontalList = () => {
      return Array.from({ length: 100 }, (_, i) => createObject(`item-${i}`, i * 50, 0, 50, 200, i % 10))
    }

    test("viewport at left", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 300, height: 200 }
      const objects = createHorizontalList()

      const result = getObjectsInViewport(viewport, objects, "row", 10, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("item-0")
      expect(visibleIds).toContain("item-5")
      expect(visibleIds).not.toContain("item-20")
    })

    test("viewport scrolled to middle", () => {
      const viewport: ViewportBounds = { x: 2000, y: 0, width: 300, height: 200 }
      const objects = createHorizontalList()

      const result = getObjectsInViewport(viewport, objects, "row", 10, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("item-40")
      expect(visibleIds).toContain("item-45")
      expect(visibleIds).not.toContain("item-0")
      expect(visibleIds).not.toContain("item-99")
    })

    test("viewport at right", () => {
      const viewport: ViewportBounds = { x: 4700, y: 0, width: 300, height: 200 }
      const objects = createHorizontalList()

      const result = getObjectsInViewport(viewport, objects, "row", 10, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("item-94")
      expect(visibleIds).toContain("item-99")
      expect(visibleIds).not.toContain("item-0")
    })
  })

  describe("large objects", () => {
    test("handles objects much larger than viewport", () => {
      const viewport: ViewportBounds = { x: 0, y: 500, width: 100, height: 100 }
      const objects = [
        ...Array.from({ length: 20 }, (_, i) => createObject(`filler-${i}`, 0, i * 100, 100, 50)),
        createObject("huge", 0, 100, 100, 1000),
        createObject("tiny-after", 0, 1200, 100, 10),
      ].sort((a, b) => a.y - b.y)

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("huge")
    })

    test("large object with many small items before viewport (realistic background panel)", () => {
      // Simulates a background panel spanning entire list with small list items
      const objects = [
        createObject("background-panel", 0, 0, 100, 3000), // Large spanning background
        ...Array.from({ length: 30 }, (_, i) => createObject(`item-${i}`, 0, i * 60, 100, 50)), // List items
        ...Array.from({ length: 20 }, (_, i) => createObject(`filler-${i}`, 0, i * 100 + 3000, 100, 50)),
      ]

      // Viewport at y=1500, background spans 0-3000, with ~25 items between them
      const viewport: ViewportBounds = { x: 0, y: 1500, width: 100, height: 100 }
      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("background-panel")
    })

    test("handles very tall objects in vertical scroll", () => {
      const objects = [
        createObject("small-1", 0, 0, 100, 50),
        createObject("tall-1", 0, 100, 100, 500),
        createObject("small-2", 0, 650, 100, 50),
        createObject("tall-2", 0, 750, 100, 800),
        createObject("small-3", 0, 1600, 100, 50),
        ...Array.from({ length: 20 }, (_, i) => createObject(`filler-${i}`, 0, i * 100 + 2000, 100, 50)),
      ]

      for (let scrollY = 0; scrollY < 2000; scrollY += 100) {
        const viewport: ViewportBounds = { x: 0, y: scrollY, width: 100, height: 200 }
        const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

        result.forEach((obj) => {
          const objectBottom = obj.y + obj.height
          expect(objectBottom).toBeGreaterThan(viewport.y)
          expect(obj.y).toBeLessThan(viewport.y + viewport.height)
        })
      }
    })

    test("handles very wide objects in horizontal scroll", () => {
      const objects = [
        createObject("small-1", 0, 0, 50, 100),
        createObject("wide-1", 100, 0, 500, 100),
        createObject("small-2", 650, 0, 50, 100),
        createObject("wide-2", 750, 0, 800, 100),
        ...Array.from({ length: 20 }, (_, i) => createObject(`filler-${i}`, i * 100 + 2000, 0, 50, 100)),
      ]

      for (let scrollX = 0; scrollX < 2000; scrollX += 100) {
        const viewport: ViewportBounds = { x: scrollX, y: 0, width: 200, height: 100 }
        const result = getObjectsInViewport(viewport, objects, "row", 0, 16)

        result.forEach((obj) => {
          const objectRight = obj.x + obj.width
          expect(objectRight).toBeGreaterThan(viewport.x)
          expect(obj.x).toBeLessThan(viewport.x + viewport.width)
        })
      }
    })
  })

  describe("viewport size variations", () => {
    const objects = Array.from({ length: 100 }, (_, i) => createObject(`item-${i}`, 0, i * 30, 200, 30, i % 5))

    test("very small viewport", () => {
      const viewport: ViewportBounds = { x: 0, y: 500, width: 50, height: 50 }
      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      expect(result.length).toBeGreaterThan(0)
      expect(result.length).toBeLessThan(10)
    })

    test("very large viewport", () => {
      const viewport: ViewportBounds = { x: 0, y: 500, width: 1000, height: 1000 }
      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      expect(result.length).toBeGreaterThan(30)
    })

    test("viewport larger than all objects", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 500, height: 5000 }
      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      expect(result.length).toBe(objects.length)
    })
  })

  describe("negative coordinates", () => {
    test("handles negative viewport coordinates", () => {
      const viewport: ViewportBounds = { x: -50, y: -50, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, -100, i * 20 - 100, 200, 20))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      result.forEach((obj) => {
        const objectBottom = obj.y + obj.height
        expect(objectBottom).toBeGreaterThan(viewport.y)
        expect(obj.y).toBeLessThan(viewport.y + viewport.height)
      })
    })

    test("handles negative object coordinates", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 100, height: 100 }
      const objects = [createObject("negative-y", 0, -50, 100, 100), createObject("positive-y", 0, 50, 100, 100)]
      objects.push(...Array.from({ length: 20 }, (_, i) => createObject(`filler-${i}`, 0, i * 20, 100, 20)))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("negative-y")
      expect(visibleIds).toContain("positive-y")
    })
  })

  describe("sparse object distributions", () => {
    test("handles large gaps between objects", () => {
      const viewport: ViewportBounds = { x: 0, y: 5000, width: 100, height: 100 }
      const objects = Array.from({ length: 50 }, (_, i) => createObject(`obj-${i}`, 0, i * 1000, 100, 50))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("obj-5")
      expect(result.length).toBeLessThan(5)
    })

    test("handles clustered objects", () => {
      const viewport: ViewportBounds = { x: 0, y: 500, width: 100, height: 100 }
      const objects = [
        ...Array.from({ length: 10 }, (_, i) => createObject(`cluster-${i}`, 0, 490 + i * 2, 100, 2)),
        ...Array.from({ length: 10 }, (_, i) => createObject(`filler-${i}`, 0, i * 100, 100, 20)),
      ]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      expect(result.length).toBeGreaterThan(5)
    })
  })

  describe("minTriggerSize parameter", () => {
    test("bypasses optimization when object count is below threshold", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 100, height: 100 }
      const objects = [createObject("far-away", 0, 10000, 100, 100), createObject("visible", 0, 50, 100, 100)]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 100)
      expect(result.length).toBe(2)
      expect(result.map((o) => o.id)).toContain("far-away")
    })

    test("applies optimization when object count meets threshold", () => {
      const viewport: ViewportBounds = { x: 0, y: 0, width: 100, height: 100 }
      const objects = [
        ...Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 20, 100, 20)),
        createObject("far-away", 0, 10000, 100, 100),
      ]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      expect(result.map((o) => o.id)).not.toContain("far-away")
    })

    test("performs overlap checks when minTriggerSize is 0", () => {
      const viewport: ViewportBounds = { x: 0, y: 10, width: 40, height: 1 }
      const objects = [createObject("above-viewport", 0, 0, 40, 5), createObject("in-viewport", 0, 10, 40, 1)]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 0)
      expect(result.length).toBe(1)
      expect(result[0].id).toBe("in-viewport")
    })

    test("filters out objects outside viewport when minTriggerSize is 0", () => {
      const viewport: ViewportBounds = { x: 0, y: 10, width: 40, height: 5 }
      const objects = [
        createObject("above-1", 0, 0, 40, 3),
        createObject("above-2", 0, 5, 40, 4),
        createObject("in-viewport", 0, 12, 40, 2),
        createObject("below", 0, 20, 40, 5),
      ]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 0)
      expect(result.length).toBe(1)
      expect(result[0].id).toBe("in-viewport")
    })

    test("respects exact boundary conditions with minTriggerSize 0", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = [
        createObject("ends-at-start", 0, 50, 100, 50),
        createObject("overlaps-start", 0, 50, 100, 51),
        createObject("inside", 0, 150, 100, 20),
        createObject("overlaps-end", 0, 199, 100, 10),
        createObject("starts-at-end", 0, 200, 100, 50),
      ]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 0)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).not.toContain("ends-at-start")
      expect(visibleIds).toContain("overlaps-start")
      expect(visibleIds).toContain("inside")
      expect(visibleIds).toContain("overlaps-end")
      expect(visibleIds).not.toContain("starts-at-end")
    })
  })

  describe("overlapping objects", () => {
    test("handles completely overlapping objects", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = [
        ...Array.from({ length: 10 }, (_, i) => createObject(`filler-before-${i}`, 0, i * 20, 100, 20)),
        createObject("back", 0, 100, 100, 100, 0),
        createObject("middle", 0, 100, 100, 100, 1),
        createObject("front", 0, 100, 100, 100, 2),
        ...Array.from({ length: 10 }, (_, i) => createObject(`filler-after-${i}`, 0, (i + 10) * 20, 100, 20)),
      ]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const overlapping = result.filter(
        (obj) => obj.id.includes("back") || obj.id.includes("middle") || obj.id.includes("front"),
      )

      expect(overlapping[0].id).toBe("back")
      expect(overlapping[1].id).toBe("middle")
      expect(overlapping[2].id).toBe("front")
    })

    test("handles partially overlapping objects", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = Array.from({ length: 30 }, (_, i) => createObject(`obj-${i}`, 0, i * 15, 100, 30, i % 3))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      for (let i = 1; i < result.length; i++) {
        expect(result[i].zIndex).toBeGreaterThanOrEqual(result[i - 1].zIndex)
      }
    })
  })

  describe("extreme values", () => {
    test("zero-sized viewport returns empty array (zero width)", () => {
      const viewport: ViewportBounds = { x: 100, y: 100, width: 0, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 20, 100, 20))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      expect(result.length).toBe(0)
    })

    test("zero-sized viewport returns empty array (zero height)", () => {
      const viewport: ViewportBounds = { x: 100, y: 100, width: 100, height: 0 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 20, 100, 20))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      expect(result.length).toBe(0)
    })

    test("zero-sized viewport returns empty array (both zero)", () => {
      const viewport: ViewportBounds = { x: 100, y: 100, width: 0, height: 0 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 20, 100, 20))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      expect(result.length).toBe(0)
    })

    test("handles zero-sized objects", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = Array.from({ length: 20 }, (_, i) => createObject(`obj-${i}`, 0, i * 20, 100, 0))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      expect(result).toBeDefined()
    })

    test("handles very large coordinates", () => {
      const viewport: ViewportBounds = { x: 1000000, y: 1000000, width: 100, height: 100 }
      const objects = Array.from({ length: 50 }, (_, i) => createObject(`obj-${i}`, 1000000, 1000000 + i * 20, 100, 20))

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe("performance characteristics", () => {
    test("handles 1000 objects efficiently", () => {
      const viewport: ViewportBounds = { x: 0, y: 50000, width: 100, height: 100 }
      const objects = Array.from({ length: 1000 }, (_, i) => createObject(`obj-${i}`, 0, i * 100, 100, 100, i % 10))

      const start = performance.now()
      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const duration = performance.now() - start

      expect(result.length).toBeGreaterThan(0)
      expect(result.length).toBeLessThan(20)
      expect(duration).toBeLessThan(10)
    })

    test("handles 10000 objects efficiently", () => {
      const viewport: ViewportBounds = { x: 0, y: 500000, width: 100, height: 100 }
      const objects = Array.from({ length: 10000 }, (_, i) => createObject(`obj-${i}`, 0, i * 100, 100, 100, i % 10))

      const start = performance.now()
      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const duration = performance.now() - start

      expect(result.length).toBeGreaterThan(0)
      expect(result.length).toBeLessThan(20)
      expect(duration).toBeLessThan(50)
    })
  })

  describe("additional edge cases", () => {
    test("object that starts before viewport and extends through it", () => {
      const viewport: ViewportBounds = { x: 0, y: 500, width: 100, height: 100 }
      const objects = Array.from({ length: 30 }, (_, i) => {
        if (i === 2) {
          return createObject("spanning", 0, 200, 100, 500)
        }
        return createObject(`obj-${i}`, 0, i * 50, 100, 40)
      })

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const visibleIds = result.map((o) => o.id)

      expect(visibleIds).toContain("spanning")
    })

    test("multiple large overlapping objects during scroll", () => {
      const objects = [
        createObject("bg-1", 0, 0, 200, 1000, 0),
        createObject("bg-2", 0, 500, 200, 1000, 0),
        createObject("bg-3", 0, 1000, 200, 1000, 0),
        ...Array.from({ length: 50 }, (_, i) => createObject(`small-${i}`, 0, i * 50, 200, 40, 1)),
      ]

      for (let scrollY = 0; scrollY <= 1500; scrollY += 100) {
        const viewport: ViewportBounds = { x: 0, y: scrollY, width: 200, height: 300 }
        const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

        result.forEach((obj) => {
          const objectBottom = obj.y + obj.height
          expect(objectBottom).toBeGreaterThan(viewport.y)
          expect(obj.y).toBeLessThan(viewport.y + viewport.height)
        })
      }
    })

    test("viewport moves down through very tall object", () => {
      const objects = [
        ...Array.from({ length: 5 }, (_, i) => createObject(`before-${i}`, 0, i * 50, 100, 40)),
        createObject("very-tall", 0, 300, 100, 2000),
        ...Array.from({ length: 20 }, (_, i) => createObject(`after-${i}`, 0, 2400 + i * 50, 100, 40)),
      ]

      for (let scrollY = 0; scrollY <= 2500; scrollY += 200) {
        const viewport: ViewportBounds = { x: 0, y: scrollY, width: 100, height: 200 }
        const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

        if (scrollY >= 100 && scrollY <= 2100) {
          const visibleIds = result.map((o) => o.id)
          expect(visibleIds).toContain("very-tall")
        }
      }
    })

    test("objects with zero width or height", () => {
      const viewport: ViewportBounds = { x: 0, y: 100, width: 100, height: 100 }
      const objects = [
        createObject("zero-height", 0, 150, 100, 0),
        createObject("zero-width", 0, 160, 0, 40),
        createObject("point", 0, 170, 0, 0),
        ...Array.from({ length: 20 }, (_, i) => createObject(`normal-${i}`, 0, i * 20, 100, 15)),
      ]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      expect(result).toBeDefined()
    })

    test("viewport positioned between objects (should return empty)", () => {
      const viewport: ViewportBounds = { x: 0, y: 1000, width: 100, height: 100 }
      const objects = [
        ...Array.from({ length: 10 }, (_, i) => createObject(`before-${i}`, 0, i * 50, 100, 40)),
        ...Array.from({ length: 10 }, (_, i) => createObject(`after-${i}`, 0, 2000 + i * 50, 100, 40)),
      ]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      expect(result.length).toBe(0)
    })

    test("single pixel gaps between objects and viewport", () => {
      const viewport: ViewportBounds = { x: 0, y: 1000, width: 100, height: 100 }
      const objects = [
        createObject("one-pixel-before", 0, 899, 100, 100), // ends at 999, gap of 1px
        createObject("touching-before", 0, 999, 100, 1), // ends exactly at 1000
        createObject("inside", 0, 1050, 100, 10), // fully inside
        createObject("touching-after", 0, 1100, 100, 1), // starts exactly at 1100
        createObject("one-pixel-after", 0, 1101, 100, 100), // starts at 1101, gap of 1px
        ...Array.from({ length: 20 }, (_, i) => createObject(`filler-${i}`, 0, i * 100, 100, 50)),
      ]

      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)
      const visibleIds = result.map((o) => o.id)

      // Objects with even 1px gap should be excluded (no overlap)
      expect(visibleIds).not.toContain("one-pixel-before")
      expect(visibleIds).not.toContain("touching-before")
      expect(visibleIds).toContain("inside")
      expect(visibleIds).not.toContain("touching-after")
      expect(visibleIds).not.toContain("one-pixel-after")
    })
  })

  describe("stress test - continuous scrolling", () => {
    test("scrolling through 1000 objects with varying heights", () => {
      const heights = [20, 50, 30, 100, 40, 60, 25, 80, 35, 70]
      let currentY = 0
      const objects = Array.from({ length: 1000 }, (_, i) => {
        const height = heights[i % heights.length]
        const obj = createObject(`item-${i}`, 0, currentY, 200, height, i % 5)
        currentY += height + 2
        return obj
      })

      const totalHeight = currentY
      const viewportHeight = 400

      for (let scrollY = 0; scrollY < totalHeight - viewportHeight; scrollY += 100) {
        const viewport: ViewportBounds = { x: 0, y: scrollY, width: 200, height: viewportHeight }
        const result = getObjectsInViewport(viewport, objects, "column", 50, 16)

        result.forEach((obj) => {
          const objectBottom = obj.y + obj.height
          expect(objectBottom).toBeGreaterThan(viewport.y - 50)
          expect(obj.y).toBeLessThan(viewport.y + viewport.height + 50)
        })

        expect(result.length).toBeGreaterThan(0)
        expect(result.length).toBeLessThan(50)
      }
    })
  })

  describe("realistic scroll scenarios", () => {
    test("chat-like interface with variable height messages", () => {
      const heights = [30, 60, 45, 90, 120, 35, 50, 75, 40, 100]
      let currentY = 0
      const objects = Array.from({ length: 100 }, (_, i) => {
        const height = heights[i % heights.length]
        const obj = createObject(`msg-${i}`, 0, currentY, 300, height, 0)
        currentY += height + 5
        return obj
      })

      for (let scroll = 0; scroll < currentY - 500; scroll += 50) {
        const viewport: ViewportBounds = { x: 0, y: scroll, width: 300, height: 500 }
        const result = getObjectsInViewport(viewport, objects, "column", 20, 16)

        result.forEach((obj) => {
          const objectBottom = obj.y + obj.height
          expect(objectBottom).toBeGreaterThan(viewport.y - 20)
          expect(obj.y).toBeLessThan(viewport.y + viewport.height + 20)
        })
      }
    })

    test("grid layout with multiple columns", () => {
      const objects = Array.from({ length: 200 }, (_, i) => {
        const col = i % 4
        const row = Math.floor(i / 4)
        return createObject(`item-${i}`, col * 110, row * 110, 100, 100, 0)
      })

      const viewport: ViewportBounds = { x: 0, y: 1000, width: 440, height: 400 }
      const result = getObjectsInViewport(viewport, objects, "column", 0, 16)

      expect(result.length).toBeGreaterThan(0)
      expect(result.length).toBeLessThan(30)

      result.forEach((obj) => {
        expect(obj.y + obj.height).toBeGreaterThan(viewport.y)
        expect(obj.y).toBeLessThan(viewport.y + viewport.height)
        expect(obj.x + obj.width).toBeGreaterThan(viewport.x)
        expect(obj.x).toBeLessThan(viewport.x + viewport.width)
      })
    })
  })
})
