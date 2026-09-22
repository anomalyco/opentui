import { test, expect, beforeEach, afterEach, describe } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"

let testRenderer: TestRenderer
let renderOnce: () => Promise<void>
let captureFrame: () => string
let resize: (width: number, height: number) => void

beforeEach(async () => {
  ;({
    renderer: testRenderer,
    renderOnce,
    captureCharFrame: captureFrame,
    resize,
  } = await createTestRenderer({
    width: 40,
    height: 20,
  }))
})

afterEach(() => {
  testRenderer.destroy()
})

describe("Absolute Positioning - Snapshot Tests", () => {
  describe("Basic absolute positioning", () => {
    test("absolute positioned box at top-left", async () => {
      const box = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 0,
        top: 0,
        width: 15,
        height: 5,
        border: true,
      })

      const text = new TextRenderable(testRenderer, { content: "Top Left" })
      box.add(text)
      testRenderer.root.add(box)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute positioned box at top-left")
    })

    test("absolute positioned box at bottom-right using right/bottom", async () => {
      const box = new BoxRenderable(testRenderer, {
        position: "absolute",
        right: 0,
        bottom: 0,
        width: 15,
        height: 5,
        border: true,
      })

      const text = new TextRenderable(testRenderer, { content: "Bottom Right" })
      box.add(text)
      testRenderer.root.add(box)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute positioned box at bottom-right")
    })

    test("absolute positioned box centered with left/top", async () => {
      const box = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 10,
        top: 5,
        width: 20,
        height: 8,
        border: true,
      })

      const text = new TextRenderable(testRenderer, { content: "Centered" })
      box.add(text)
      testRenderer.root.add(box)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute positioned box centered")
    })
  })

  describe("Nested absolute positioning", () => {
    test("absolute child inside absolute parent - basic", async () => {
      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 5,
        top: 3,
        width: 30,
        height: 12,
        border: true,
      })

      const child = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 2,
        top: 1,
        width: 12,
        height: 4,
        border: true,
      })

      const text = new TextRenderable(testRenderer, { content: "Nested" })
      child.add(text)
      parent.add(child)
      testRenderer.root.add(parent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("nested absolute - child inside parent at left/top")
    })

    test("absolute child at bottom:0 inside absolute parent (issue #406 fix)", async () => {
      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 5,
        top: 2,
        width: 30,
        height: 14,
        border: true,
      })

      const child = new BoxRenderable(testRenderer, {
        position: "absolute",
        bottom: 0,
        left: 2,
        width: 15,
        height: 3,
        border: true,
      })

      const text = new TextRenderable(testRenderer, { content: "At Bottom" })
      child.add(text)
      parent.add(child)
      testRenderer.root.add(parent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("nested absolute - child at bottom:0 of parent")
    })

    test("absolute child at right:0 inside absolute parent", async () => {
      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 2,
        top: 2,
        width: 35,
        height: 12,
        border: true,
      })

      const child = new BoxRenderable(testRenderer, {
        position: "absolute",
        right: 0,
        top: 1,
        width: 12,
        height: 4,
        border: true,
      })

      const text = new TextRenderable(testRenderer, { content: "At Right" })
      child.add(text)
      parent.add(child)
      testRenderer.root.add(parent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("nested absolute - child at right:0 of parent")
    })

    test("absolute child at bottom-right corner inside absolute parent", async () => {
      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 3,
        top: 1,
        width: 34,
        height: 16,
        border: true,
      })

      const child = new BoxRenderable(testRenderer, {
        position: "absolute",
        right: 1,
        bottom: 1,
        width: 14,
        height: 4,
        border: true,
      })

      const text = new TextRenderable(testRenderer, { content: "Corner" })
      child.add(text)
      parent.add(child)
      testRenderer.root.add(parent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("nested absolute - child at bottom-right corner")
    })

    test("multiple absolute children inside absolute parent at different positions", async () => {
      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 2,
        top: 1,
        width: 36,
        height: 17,
        border: true,
      })

      const topLeftChild = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 1,
        top: 1,
        width: 10,
        height: 3,
        border: true,
      })

      const topRightChild = new BoxRenderable(testRenderer, {
        position: "absolute",
        right: 1,
        top: 1,
        width: 10,
        height: 3,
        border: true,
      })

      const bottomLeftChild = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 1,
        bottom: 1,
        width: 10,
        height: 3,
        border: true,
      })

      const bottomRightChild = new BoxRenderable(testRenderer, {
        position: "absolute",
        right: 1,
        bottom: 1,
        width: 10,
        height: 3,
        border: true,
      })

      topLeftChild.add(new TextRenderable(testRenderer, { content: "TL" }))
      topRightChild.add(new TextRenderable(testRenderer, { content: "TR" }))
      bottomLeftChild.add(new TextRenderable(testRenderer, { content: "BL" }))
      bottomRightChild.add(new TextRenderable(testRenderer, { content: "BR" }))

      parent.add(topLeftChild)
      parent.add(topRightChild)
      parent.add(bottomLeftChild)
      parent.add(bottomRightChild)
      testRenderer.root.add(parent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("nested absolute - four corners inside parent")
    })
  })

  describe("Three-level nesting", () => {
    test("deeply nested absolute positioning - grandchild at bottom", async () => {
      const grandparent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 1,
        top: 1,
        width: 38,
        height: 18,
        border: true,
      })

      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 2,
        top: 2,
        width: 32,
        height: 12,
        border: true,
      })

      const child = new BoxRenderable(testRenderer, {
        position: "absolute",
        bottom: 1,
        left: 2,
        width: 15,
        height: 3,
        border: true,
      })

      child.add(new TextRenderable(testRenderer, { content: "Deep" }))
      parent.add(child)
      grandparent.add(parent)
      testRenderer.root.add(grandparent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("three-level nested absolute - grandchild at bottom")
    })
  })

  describe("Mixed positioning", () => {
    test("absolute child inside explicit static parent resolves against the nearest positioned ancestor", async () => {
      const container = new BoxRenderable(testRenderer, {
        width: 40,
        height: 20,
      })

      const staticParent = new BoxRenderable(testRenderer, {
        position: "static",
        width: 10,
        height: 4,
        marginLeft: 10,
      })

      const absoluteChild = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 20,
        top: 0,
        width: 5,
        height: 1,
      })

      staticParent.add(absoluteChild)
      container.add(staticParent)
      testRenderer.root.add(container)

      await renderOnce()
      expect(absoluteChild.x).toBe(20)
      expect(absoluteChild.y).toBe(0)
    })

    test("absolute child inside relative parent", async () => {
      const container = new BoxRenderable(testRenderer, {
        width: 40,
        height: 20,
        paddingTop: 2,
        paddingLeft: 3,
      })

      const parent = new BoxRenderable(testRenderer, {
        position: "relative",
        width: 30,
        height: 14,
        border: true,
      })

      const absoluteChild = new BoxRenderable(testRenderer, {
        position: "absolute",
        bottom: 1,
        right: 1,
        width: 12,
        height: 4,
        border: true,
      })

      absoluteChild.add(new TextRenderable(testRenderer, { content: "Absolute" }))
      parent.add(absoluteChild)
      container.add(parent)
      testRenderer.root.add(container)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute child inside relative parent")
    })

    test("sibling absolute elements at same level", async () => {
      const box1 = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 0,
        top: 0,
        width: 15,
        height: 6,
        border: true,
      })

      const box2 = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 12,
        top: 4,
        width: 15,
        height: 6,
        border: true,
      })

      const box3 = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 24,
        top: 8,
        width: 15,
        height: 6,
        border: true,
      })

      box1.add(new TextRenderable(testRenderer, { content: "Box 1" }))
      box2.add(new TextRenderable(testRenderer, { content: "Box 2" }))
      box3.add(new TextRenderable(testRenderer, { content: "Box 3" }))

      testRenderer.root.add(box1)
      testRenderer.root.add(box2)
      testRenderer.root.add(box3)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("sibling absolute elements overlapping")
    })
  })

  describe("Edge cases", () => {
    test("absolute positioned box with negative coordinates (partially off-screen)", async () => {
      const box = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: -5,
        top: -2,
        width: 20,
        height: 8,
        border: true,
      })

      const text = new TextRenderable(testRenderer, { content: "Partial" })
      box.add(text)
      testRenderer.root.add(box)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute box with negative coordinates")
    })

    test("absolute positioned box extending beyond viewport", async () => {
      const box = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 30,
        top: 15,
        width: 20,
        height: 10,
        border: true,
      })

      const text = new TextRenderable(testRenderer, { content: "Overflow" })
      box.add(text)
      testRenderer.root.add(box)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute box extending beyond viewport")
    })

    test("absolute child fills parent completely", async () => {
      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 5,
        top: 3,
        width: 30,
        height: 12,
        border: true,
      })

      const child = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        border: true,
        borderStyle: "double",
      })

      child.add(new TextRenderable(testRenderer, { content: "Full" }))
      parent.add(child)
      testRenderer.root.add(parent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute child fills parent with inset 0")
    })

    test("absolute positioned box with percentage width inside absolute parent", async () => {
      resize(50, 20)

      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 5,
        top: 2,
        width: 40,
        height: 15,
        border: true,
      })

      const child = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 2,
        bottom: 1,
        width: "50%",
        height: 4,
        border: true,
      })

      child.add(new TextRenderable(testRenderer, { content: "50%" }))
      parent.add(child)
      testRenderer.root.add(parent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute child with percentage width")
    })

    test("absolute positioned box with percentage height inside absolute parent", async () => {
      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 5,
        top: 2,
        width: 30,
        height: 16,
        border: true,
      })

      const child = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 2,
        top: 1,
        width: 15,
        height: "50%",
        border: true,
      })

      child.add(new TextRenderable(testRenderer, { content: "50% H" }))
      parent.add(child)
      testRenderer.root.add(parent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute child with percentage height")
    })

    test("absolute child with conflicting insets (left and right without explicit width)", async () => {
      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 3,
        top: 2,
        width: 34,
        height: 14,
        border: true,
      })

      const child = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 2,
        right: 2,
        top: 2,
        height: 5,
        border: true,
      })

      child.add(new TextRenderable(testRenderer, { content: "Stretch" }))
      parent.add(child)
      testRenderer.root.add(parent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute child with left and right insets (no explicit width)")
    })

    test("absolute child with conflicting insets (top and bottom without explicit height)", async () => {
      const parent = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 5,
        top: 1,
        width: 30,
        height: 16,
        border: true,
      })

      const child = new BoxRenderable(testRenderer, {
        position: "absolute",
        top: 1,
        bottom: 1,
        left: 2,
        width: 15,
        border: true,
      })

      child.add(new TextRenderable(testRenderer, { content: "VStretch" }))
      parent.add(child)
      testRenderer.root.add(parent)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("absolute child with top and bottom insets (no explicit height)")
    })
  })

  describe("Complex hierarchies", () => {
    test("relative parent with absolute child containing absolute grandchild", async () => {
      const container = new BoxRenderable(testRenderer, {
        width: 40,
        height: 20,
        paddingTop: 1,
        paddingLeft: 2,
      })

      const relativeParent = new BoxRenderable(testRenderer, {
        position: "relative",
        width: 35,
        height: 16,
        border: true,
      })

      const absoluteChild = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 2,
        top: 1,
        width: 28,
        height: 12,
        border: true,
      })

      const absoluteGrandchild = new BoxRenderable(testRenderer, {
        position: "absolute",
        right: 1,
        bottom: 1,
        width: 12,
        height: 4,
        border: true,
      })

      absoluteGrandchild.add(new TextRenderable(testRenderer, { content: "Grand" }))
      absoluteChild.add(absoluteGrandchild)
      relativeParent.add(absoluteChild)
      container.add(relativeParent)
      testRenderer.root.add(container)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("relative -> absolute -> absolute hierarchy")
    })

    test("multiple nested relative and absolute layers", async () => {
      const root = new BoxRenderable(testRenderer, {
        position: "relative",
        width: 38,
        height: 18,
        border: true,
      })

      const absoluteLayer1 = new BoxRenderable(testRenderer, {
        position: "absolute",
        left: 2,
        top: 1,
        width: 32,
        height: 14,
        border: true,
      })

      const relativeLayer2 = new BoxRenderable(testRenderer, {
        position: "relative",
        width: 28,
        height: 10,
        marginLeft: 1,
        marginTop: 1,
        border: true,
      })

      const absoluteLayer3 = new BoxRenderable(testRenderer, {
        position: "absolute",
        right: 1,
        bottom: 1,
        width: 10,
        height: 3,
        border: true,
      })

      absoluteLayer3.add(new TextRenderable(testRenderer, { content: "Deep" }))
      relativeLayer2.add(absoluteLayer3)
      absoluteLayer1.add(relativeLayer2)
      root.add(absoluteLayer1)
      testRenderer.root.add(root)

      await renderOnce()
      expect(captureFrame()).toMatchSnapshot("relative -> absolute -> relative -> absolute hierarchy")
    })
  })
})
