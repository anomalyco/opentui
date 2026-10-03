import { test, expect, beforeEach, afterEach, describe, spyOn } from "bun:test"
import { decodePasteBytes } from "../lib/paste.js"
import {
  Renderable,
  BaseRenderable,
  RenderableEvents,
  isRenderable,
  type BaseRenderableOptions,
  type RenderableOptions,
} from "../Renderable.js"
import { createTestRenderer, type TestRenderer, type MockMouse, type MockInput } from "../testing/test-renderer.js"
import type { RenderContext } from "../types.js"
import { TextNodeRenderable } from "../renderables/TextNode.js"
import { TextRenderable } from "../renderables/Text.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { BoxRenderable } from "../renderables/Box.js"
import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"

export class TestBaseRenderable extends BaseRenderable {
  constructor(options: BaseRenderableOptions) {
    super(options)
  }

  add(obj: BaseRenderable | unknown, index?: number): number {
    throw new Error("Method not implemented.")
  }
  remove(child: BaseRenderable): void {
    throw new Error("Method not implemented.")
  }
  insertBefore(obj: BaseRenderable | unknown, anchor: BaseRenderable | unknown): void {
    throw new Error("Method not implemented.")
  }
  getChildren(): BaseRenderable[] {
    throw new Error("Method not implemented.")
  }
  getChildrenCount(): number {
    throw new Error("Method not implemented.")
  }
  getRenderable(id: string): BaseRenderable | undefined {
    throw new Error("Method not implemented.")
  }
  requestRender(): void {
    throw new Error("Method not implemented.")
  }
  findDescendantById(id: string): BaseRenderable | undefined {
    throw new Error("Method not implemented.")
  }
}

class TestRenderable extends Renderable {
  constructor(ctx: RenderContext, options: RenderableOptions<TestRenderable>) {
    super(ctx, options)
  }
}

class CountingRenderable extends Renderable {
  public renderCount = 0

  constructor(ctx: RenderContext, options: RenderableOptions) {
    super(ctx, options)
  }

  protected renderSelf(): void {
    this.renderCount += 1
  }

  public getScreenPosition(): { x: number; y: number } {
    return { x: this.screenX, y: this.screenY }
  }
}

class TestFocusableRenderable extends Renderable {
  _focusable = true

  constructor(ctx: RenderContext, options: RenderableOptions) {
    super(ctx, options)
  }
}

let testRenderer: TestRenderer
let testMockMouse: MockMouse
let testMockInput: MockInput
let renderOnce: () => Promise<void>

beforeEach(async () => {
  ;({
    renderer: testRenderer,
    mockMouse: testMockMouse,
    mockInput: testMockInput,
    renderOnce,
  } = await createTestRenderer({}))
})

afterEach(() => {
  testRenderer.destroy()
})

describe("BaseRenderable", () => {
  test("creates with default id", () => {
    const renderable = new TestBaseRenderable({})
    expect(renderable.id).toMatch(/^renderable-\d+$/)
    expect(typeof renderable.num).toBe("number")
    expect(renderable.num).toBeGreaterThan(0)
  })

  test("creates with custom id", () => {
    const renderable = new TestBaseRenderable({ id: "custom-id" })
    expect(renderable.id).toBe("custom-id")
  })

  test("has unique numbers", () => {
    const r1 = new TestBaseRenderable({})
    const r2 = new TestBaseRenderable({})
    expect(r1.num).not.toBe(r2.num)
  })

  test("initial visibility state", () => {
    const renderable = new TestBaseRenderable({})
    expect(renderable.visible).toBe(true)
  })

  test("can set visibility", () => {
    const renderable = new TestBaseRenderable({})
    renderable.visible = false
    expect(renderable.visible).toBe(false)
  })
})

describe("Renderable", () => {
  test("creates with basic options", () => {
    const renderable = new TestRenderable(testRenderer, { id: "test-renderable" })
    expect(renderable.id).toBe("test-renderable")
    expect(renderable.visible).toBe(true)
    expect(renderable.focusable).toBe(false)
    expect(renderable.zIndex).toBe(0)
    expect(renderable.live).toBe(false)
    expect(renderable.liveCount).toBe(0)
  })

  test("isRenderable", () => {
    const renderable = new TestBaseRenderable({})
    expect(isRenderable(renderable)).toBe(true)
    expect(isRenderable({})).toBe(false)
    expect(isRenderable(null)).toBe(false)
    expect(isRenderable(undefined)).toBe(false)
  })

  test("creates with width and height", () => {
    const renderable = new TestRenderable(testRenderer, {
      id: "test-size",
      width: 100,
      height: 50,
    })
    expect(renderable.width).toBe(100)
    expect(renderable.height).toBe(50)
  })

  test("throws on invalid width", () => {
    expect(() => {
      new TestRenderable(testRenderer, { width: -10 })
    }).toThrow(TypeError)
  })

  test("throws on invalid height", () => {
    expect(() => {
      new TestRenderable(testRenderer, { width: 100, height: -5 })
    }).toThrow(TypeError)
  })

  test("handles visibility changes", () => {
    const renderable = new TestRenderable(testRenderer, { id: "test-visible" })
    expect(renderable.visible).toBe(true)

    renderable.visible = false
    expect(renderable.visible).toBe(false)

    renderable.visible = true
    expect(renderable.visible).toBe(true)
  })

  test("handles live mode", () => {
    const renderable = new TestRenderable(testRenderer, { id: "test-live", live: true })
    expect(renderable.live).toBe(true)
    expect(renderable.liveCount).toBe(1)
  })

  test("screen position cache matches x/y after layout", async () => {
    const parent = new CountingRenderable(testRenderer, {
      id: "parent",
      position: "absolute",
      left: 10,
      top: 4,
      width: 30,
      height: 10,
    })
    parent.translateX = 2
    parent.translateY = 1

    const child = new CountingRenderable(testRenderer, {
      id: "child",
      position: "absolute",
      left: 3,
      top: 2,
      width: 8,
      height: 4,
    })
    child.translateX = 1
    child.translateY = 2

    const grandchild = new CountingRenderable(testRenderer, {
      id: "grandchild",
      width: 4,
      height: 2,
    })
    grandchild.translateX = 2
    grandchild.translateY = 1

    child.add(grandchild)
    parent.add(child)
    testRenderer.root.add(parent)

    await renderOnce()

    expect(parent.getScreenPosition()).toEqual({ x: parent.x, y: parent.y })
    expect(child.getScreenPosition()).toEqual({ x: child.x, y: child.y })
    expect(grandchild.getScreenPosition()).toEqual({ x: grandchild.x, y: grandchild.y })
  })

  test("screen position cache tracks translate changes on the next render", async () => {
    const parent = new CountingRenderable(testRenderer, {
      id: "parent",
      position: "absolute",
      left: 5,
      top: 6,
      width: 24,
      height: 12,
    })
    const child = new CountingRenderable(testRenderer, {
      id: "child",
      width: 10,
      height: 4,
    })

    parent.add(child)
    testRenderer.root.add(parent)

    await renderOnce()

    parent.translateX = 7
    parent.translateY = 3
    child.translateX = 2
    child.translateY = 5

    expect(parent.screenX).toBe(parent.x)
    expect(parent.screenY).toBe(parent.y)
    expect(child.screenX).toBe(child.x)
    expect(child.screenY).toBe(child.y)

    await renderOnce()

    expect(parent.getScreenPosition()).toEqual({ x: parent.x, y: parent.y })
    expect(child.getScreenPosition()).toEqual({ x: child.x, y: child.y })
  })
})

describe("Renderable - layout read caching invariants", () => {
  test("grandchild screen position follows a translate-only ancestor move", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "cascade-parent",
      position: "absolute",
      left: 2,
      top: 2,
      width: 30,
      height: 10,
    })
    const child = new TestRenderable(testRenderer, { id: "cascade-child", width: 20, height: 6 })
    const grandchild = new TestRenderable(testRenderer, { id: "cascade-grandchild", width: 10, height: 2 })

    child.add(grandchild)
    parent.add(child)
    testRenderer.root.add(parent)
    await renderOnce()

    const beforeX = grandchild.screenX
    const beforeY = grandchild.screenY

    // Translate does not touch yoga: no relayout happens, only ancestor
    // screen positions move. Every descendant must follow on the next frame.
    parent.translateX = 7
    parent.translateY = 5
    await renderOnce()

    expect(grandchild.screenX).toBe(beforeX + 7)
    expect(grandchild.screenY).toBe(beforeY + 5)
  })
})

describe("Renderable - Child Management", () => {
  test("can add and remove children", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child1 = new TestRenderable(testRenderer, { id: "child1" })
    const child2 = new TestRenderable(testRenderer, { id: "child2" })

    const index1 = parent.add(child1)
    expect(index1).toBe(0)
    expect(parent.getChildrenCount()).toBe(1)
    expect(parent.getRenderable("child1")).toBe(child1)

    const index2 = parent.add(child2)
    expect(index2).toBe(1)
    expect(parent.getChildrenCount()).toBe(2)

    parent.remove(child1)
    expect(parent.getChildrenCount()).toBe(1)
    expect(parent.getRenderable("child1")).toBeUndefined()
    expect(parent.getRenderable("child2")).toBe(child2)
  })

  test("public id lookup returns first matching duplicate child", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const first = new TestRenderable(testRenderer, { id: "duplicate" })
    const second = new TestRenderable(testRenderer, { id: "duplicate" })
    const tail = new TestRenderable(testRenderer, { id: "tail" })

    parent.add(first)
    parent.add(second)
    parent.add(tail)

    expect(parent.getRenderable("duplicate")).toBe(first)
    expect(parent.findDescendantById("duplicate")).toBe(first)

    const found = parent.getRenderable("duplicate")
    expect(found).toBe(first)
    if (found) parent.remove(found)

    const children = parent.getChildren()
    expect(children).toHaveLength(2)
    expect(children[0]).toBe(second)
    expect(children[1]).toBe(tail)
    expect(first.parent).toBeNull()
    expect(second.parent).toBe(parent)
    expect(parent.getRenderable("duplicate")).toBe(second)
  })

  test("remove detaches the exact duplicate-id child", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const first = new TestRenderable(testRenderer, { id: "duplicate" })
    const second = new TestRenderable(testRenderer, { id: "duplicate" })
    const tail = new TestRenderable(testRenderer, { id: "tail" })

    parent.add(first)
    parent.add(second)
    parent.add(tail)

    parent.remove(second)

    const children = parent.getChildren()
    expect(children).toHaveLength(2)
    expect(children[0]).toBe(first)
    expect(children[1]).toBe(tail)
    expect(first.parent).toBe(parent)
    expect(second.parent).toBeNull()
    expect(parent.getRenderable("duplicate")).toBe(first)
  })

  test("remove rejects string ids at runtime", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child = new TestRenderable(testRenderer, { id: "child" })
    parent.add(child)

    expect(() => (parent as any).remove("child")).toThrow("remove expects a renderable child object")
    expect(parent.getChildren()[0]).toBe(child)
  })

  test("remove warns in dev when the object was never a child", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child = new TestRenderable(testRenderer, { id: "child" })
    const stranger = new TestRenderable(testRenderer, { id: "stranger" })
    parent.add(child)

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(() => parent.remove(stranger)).not.toThrow()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(parent.getChildren()).toEqual([child])
      expect(stranger.parent).toBeNull()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("remove warns in dev and does not detach a child that belongs to another parent", () => {
    const parentA = new TestRenderable(testRenderer, { id: "parent-a" })
    const parentB = new TestRenderable(testRenderer, { id: "parent-b" })
    const child = new TestRenderable(testRenderer, { id: "child" })
    parentA.add(child)

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      parentB.remove(child)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(child.parent).toBe(parentA)
      expect(parentA.getChildren()).toEqual([child])
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("remove warns in dev when passed a text node instead of a layout child", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const textNode = new TextNodeRenderable({ id: "text-node" })

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(() => parent.remove(textNode)).not.toThrow()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("remove stays silent for actual children", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child = new TestRenderable(testRenderer, { id: "child" })
    parent.add(child)

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      parent.remove(child)
      expect(warnSpy).not.toHaveBeenCalled()
      expect(child.parent).toBeNull()
      expect(parent.getChildrenCount()).toBe(0)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("changing a child's id keeps parent lookups working", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child = new TestRenderable(testRenderer, { id: "old-id" })
    parent.add(child)

    child.id = "new-id"

    expect(child.id).toBe("new-id")
    expect(parent.getRenderable("new-id")).toBe(child)
    expect(parent.getRenderable("old-id")).toBeUndefined()
    expect(parent.findDescendantById("new-id")).toBe(child)
  })

  test("insertBefore accepts an anchor with the same public id", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const first = new TestRenderable(testRenderer, { id: "duplicate" })
    const second = new TestRenderable(testRenderer, { id: "duplicate" })
    const tail = new TestRenderable(testRenderer, { id: "tail" })

    parent.add(first)
    parent.add(tail)
    parent.insertBefore(second, first)

    const children = parent.getChildren()
    expect(children).toHaveLength(3)
    expect(children[0]).toBe(second)
    expect(children[1]).toBe(first)
    expect(children[2]).toBe(tail)
    expect(first.parent).toBe(parent)
    expect(second.parent).toBe(parent)
  })

  test("reparenting moves the exact duplicate-id child", () => {
    const oldParent = new TestRenderable(testRenderer, { id: "old-parent" })
    const newParent = new TestRenderable(testRenderer, { id: "new-parent" })
    const first = new TestRenderable(testRenderer, { id: "duplicate" })
    const second = new TestRenderable(testRenderer, { id: "duplicate" })

    oldParent.add(first)
    oldParent.add(second)
    newParent.add(second)

    const oldChildren = oldParent.getChildren()
    const newChildren = newParent.getChildren()
    expect(oldChildren).toHaveLength(1)
    expect(newChildren).toHaveLength(1)
    expect(oldChildren[0]).toBe(first)
    expect(newChildren[0]).toBe(second)
    expect(first.parent).toBe(oldParent)
    expect(second.parent).toBe(newParent)
  })

  test("destroying a duplicate-id child removes that exact child", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const first = new TestRenderable(testRenderer, { id: "duplicate" })
    const second = new TestRenderable(testRenderer, { id: "duplicate" })
    const tail = new TestRenderable(testRenderer, { id: "tail" })

    parent.add(first)
    parent.add(second)
    parent.add(tail)

    second.destroy()

    const children = parent.getChildren()
    expect(children).toHaveLength(2)
    expect(children[0]).toBe(first)
    expect(children[1]).toBe(tail)
    expect(first.parent).toBe(parent)
    expect(second.parent).toBeNull()
    expect(second.isDestroyed).toBe(true)
  })

  test("renderBefore position changes hit at the prepared position until the next frame", async () => {
    testRenderer.requestRender = () => {}

    const renderable = new TestRenderable(testRenderer, {
      id: "hook-moved-hit-grid",
      position: "absolute",
      left: 2,
      top: 3,
      width: 4,
      height: 2,
      renderBefore: function () {
        if (this.translateX === 0) {
          this.translateX = 5
        }
      },
    })

    testRenderer.root.add(renderable)
    await renderOnce()

    expect(renderable.screenX).toBe(7)
    expect(testRenderer.hitTest(2, 3)).toBe(renderable.num)
    expect(testRenderer.hitTest(7, 3)).not.toBe(renderable.num)

    await renderOnce()

    expect(testRenderer.hitTest(7, 3)).toBe(renderable.num)
    expect(testRenderer.hitTest(2, 3)).not.toBe(renderable.num)
  })

  test("renderBefore position changes compose frame buffers at the prepared position until the next frame", async () => {
    const setup = await createTestRenderer({ width: 12, height: 4 })
    try {
      class BufferedMark extends Renderable {
        protected renderSelf(buffer: OptimizedBuffer): void {
          buffer.drawText("BB", 0, 0, RGBA.fromInts(255, 255, 255))
        }
      }
      const renderable = new BufferedMark(setup.renderer, {
        buffered: true,
        position: "absolute",
        left: 2,
        top: 1,
        width: 2,
        height: 1,
        renderBefore: function () {
          if (this.translateX === 0) this.translateX = 5
        },
      })
      setup.renderer.root.add(renderable)
      await setup.renderOnce()

      expect(renderable.screenX).toBe(7)
      expect(setup.captureCharFrame().split("\n")[1]).toBe("  BB        ")

      await setup.renderOnce()

      expect(setup.captureCharFrame().split("\n")[1]).toBe("       BB   ")
    } finally {
      setup.renderer.destroy()
      await setup.renderer.closed
    }
  })

  test("can insert child at specific index", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child1 = new TestRenderable(testRenderer, { id: "child1" })
    const child2 = new TestRenderable(testRenderer, { id: "child2" })
    const child3 = new TestRenderable(testRenderer, { id: "child3" })

    parent.add(child1)
    parent.add(child2)
    parent.insertBefore(child3, child2)

    const children = parent.getChildren()
    expect(children[0].id).toBe("child1")
    expect(children[1].id).toBe("child3")
    expect(children[2].id).toBe("child2")
  })

  test("insertBefore makes new child accessible", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child1 = new TestRenderable(testRenderer, { id: "child1" })
    const child2 = new TestRenderable(testRenderer, { id: "child2" })
    const newChild = new TestRenderable(testRenderer, { id: "newChild" })

    parent.add(child1)
    parent.add(child2)
    parent.insertBefore(newChild, child2)

    expect(parent.getRenderable("newChild")).toBe(newChild)
  })

  test("insertBefore with same node as anchor should not change order", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child1 = new TestRenderable(testRenderer, { id: "child1" })
    const child2 = new TestRenderable(testRenderer, { id: "child2" })
    const child3 = new TestRenderable(testRenderer, { id: "child3" })

    parent.add(child1)
    parent.add(child2)
    parent.add(child3)

    const childrenBefore = parent.getChildren()
    expect(childrenBefore[0].id).toBe("child1")
    expect(childrenBefore[1].id).toBe("child2")
    expect(childrenBefore[2].id).toBe("child3")

    // Call insertBefore with child2 as both the node and anchor
    // This should be a no-op
    parent.insertBefore(child3, child3)
    parent.insertBefore(child2, child2)
    parent.insertBefore(child1, child1)

    const childrenAfter = parent.getChildren()
    expect(childrenAfter[0].id).toBe("child1")
    expect(childrenAfter[1].id).toBe("child2")
    expect(childrenAfter[2].id).toBe("child3")
    expect(parent.getChildrenCount()).toBe(3)
  })

  test("handles adding destroyed renderable", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child = new TestRenderable(testRenderer, { id: "child" })
    child.destroy()

    const result = parent.add(child)
    expect(result).toBe(-1)
    expect(parent.getChildrenCount()).toBe(0)
  })

  test("can change renderable id and updates parent mapping", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child = new TestRenderable(testRenderer, { id: "child" })

    parent.add(child)
    expect(parent.getRenderable("child")).toBe(child)

    child.id = "new-child-id"
    expect(child.id).toBe("new-child-id")

    expect(parent.getRenderable("child")).toBeUndefined()
    expect(parent.getRenderable("new-child-id")).toBe(child)
  })

  test("findDescendantById finds direct children", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child1 = new TestRenderable(testRenderer, { id: "child1" })
    const child2 = new TestRenderable(testRenderer, { id: "child2" })

    parent.add(child1)
    parent.add(child2)

    expect(parent.findDescendantById("child1")).toBe(child1)
    expect(parent.findDescendantById("child2")).toBe(child2)
    expect(parent.findDescendantById("nonexistent")).toBeUndefined()
  })

  test("findDescendantById finds nested descendants", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child1 = new TestRenderable(testRenderer, { id: "child1" })
    const child2 = new TestRenderable(testRenderer, { id: "child2" })
    const grandchild = new TestRenderable(testRenderer, { id: "grandchild" })

    parent.add(child1)
    parent.add(child2)
    child1.add(grandchild)

    expect(parent.findDescendantById("grandchild")).toBe(grandchild)
    expect(parent.findDescendantById("child1")).toBe(child1)
    expect(parent.findDescendantById("child2")).toBe(child2)
  })

  test("findDescendantById handles TextNodeRenderable children without crashing", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child1 = new TestRenderable(testRenderer, { id: "child1" })
    const child2 = new TestRenderable(testRenderer, { id: "child2" })
    const child3 = new TextRenderable(testRenderer, { id: "child3" })
    const textNode = new TextNodeRenderable({ id: "text-node" })

    parent.add(child1)
    child1.add(child2)
    child2.add(child3)
    child3.add(textNode)

    expect(parent.findDescendantById("child1")).toBe(child1)
    expect(parent.findDescendantById("child2")).toBe(child2)
    expect(parent.findDescendantById("text-node")).toBeUndefined()
  })

  test("handles immediate add and destroy before render tick", async () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const children = []
    for (let i = 0; i < 10; i++) {
      children.push(new TestRenderable(testRenderer, { id: `child-${i}` }))
    }

    for (const child of children) {
      parent.add(child)
    }

    testRenderer.root.add(parent)

    parent.destroyRecursively()

    await renderOnce()
    expect(parent.getChildrenCount()).toBe(0)
  })

  test("newly added child receives no lifecycle or paint hooks if destroyed before render", async () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child = new TestRenderable(testRenderer, { id: "child" })

    parent.add(child)
    testRenderer.root.add(parent)
    await renderOnce()

    const child2 = new CountingRenderable(testRenderer, { id: "child2" })
    let lifecycleCalls = 0
    child2.onLifecyclePass = () => lifecycleCalls++
    parent.add(child2)

    child2.destroy()

    await renderOnce()

    expect(lifecycleCalls).toBe(0)
    expect(child2.renderCount).toBe(0)
    expect(child2.isDestroyed).toBe(true)
  })

  test("child added during the layout pass is sized by the next pass", async () => {
    const sizes: number[][] = []
    const child = new TestRenderable(testRenderer, { flexGrow: 1, onSizeChange: () => sizes.push([child.width]) })
    const parent = new TestRenderable(testRenderer, { width: "100%", onSizeChange: () => parent.add(child) })
    testRenderer.root.add(parent)

    await renderOnce()
    await renderOnce()

    expect(sizes).toEqual([[testRenderer.width]])
  })
})

describe("Renderable - Events", () => {
  test("handles mouse events", async () => {
    const renderable = new TestRenderable(testRenderer, { id: "test-mouse", left: 0, top: 0, width: 10, height: 10 })
    let mouseCalled = false

    renderable.onMouse = () => {
      mouseCalled = true
    }

    testRenderer.root.add(renderable)
    await renderOnce()

    testMockMouse.click(5, 5)
    expect(mouseCalled).toBe(true)
  })

  test("handles mouse event types", async () => {
    const renderable = new TestRenderable(testRenderer, {
      id: "test-mouse-types",
      left: 0,
      top: 0,
      width: 10,
      height: 10,
    })
    let downCalled = false
    let upCalled = false

    renderable.onMouseDown = () => {
      downCalled = true
    }
    renderable.onMouseUp = () => {
      upCalled = true
    }

    testRenderer.root.add(renderable)
    await renderOnce()

    testMockMouse.pressDown(5, 5)
    expect(downCalled).toBe(true)

    testMockMouse.release(5, 5)
    expect(upCalled).toBe(true)
  })
})

describe("Renderable - Focus", () => {
  test("handles focus when not focusable", () => {
    const renderable = new TestRenderable(testRenderer, { id: "test-focus" })
    expect(renderable.focusable).toBe(false)
    expect(renderable.focused).toBe(false)

    renderable.focus()
    expect(renderable.focused).toBe(false)
  })

  test("handles focus when focusable", () => {
    const renderable = new TestFocusableRenderable(testRenderer, { id: "test-focusable" })

    expect(renderable.focusable).toBe(true)
    expect(renderable.focused).toBe(false)

    renderable.focus()
    expect(renderable.focused).toBe(true)
    expect(testRenderer.currentFocusedRenderable).toEqual(renderable)

    renderable.blur()
    expect(renderable.focused).toBe(false)
  })

  test("emits focus events", () => {
    const renderable = new TestFocusableRenderable(testRenderer, { id: "test-focus-events" })

    let focused = false
    let blurred = false

    renderable.on(RenderableEvents.FOCUSED, () => {
      focused = true
    })
    renderable.on(RenderableEvents.BLURRED, () => {
      blurred = true
    })

    renderable.focus()
    expect(focused).toBe(true)

    renderable.blur()
    expect(blurred).toBe(true)
  })

  test("onPaste receives full paste event with preventDefault", async () => {
    const renderable = new TestFocusableRenderable(testRenderer, { id: "test-paste" })
    let receivedEvent: any = null
    let handlePasteCalled = false

    renderable.handlePaste = (event) => {
      handlePasteCalled = true
    }

    renderable.onPaste = (event) => {
      receivedEvent = event
      event.preventDefault()
    }

    renderable.focus()
    await testMockInput.pasteBracketedText("test text")

    expect(receivedEvent).not.toBeNull()
    expect(decodePasteBytes(receivedEvent.bytes)).toBe("test text")
    expect(receivedEvent.defaultPrevented).toBe(true)
    expect(handlePasteCalled).toBe(false)
  })

  test("handlePaste receives full paste event", async () => {
    const renderable = new TestFocusableRenderable(testRenderer, { id: "test-paste-handler" })
    let receivedEvent: any = null

    renderable.handlePaste = (event) => {
      receivedEvent = event
    }

    renderable.focus()
    await testMockInput.pasteBracketedText("handler text")

    expect(receivedEvent).not.toBeNull()
    expect(decodePasteBytes(receivedEvent.bytes)).toBe("handler text")
    expect(typeof receivedEvent.preventDefault).toBe("function")
  })

  test("preventDefault in onPaste prevents handlePaste", async () => {
    const renderable = new TestFocusableRenderable(testRenderer, { id: "test-prevent" })
    let onPasteCalled = false
    let handlePasteCalled = false

    renderable.onPaste = (event) => {
      onPasteCalled = true
      event.preventDefault()
    }

    renderable.handlePaste = () => {
      handlePasteCalled = true
    }

    renderable.focus()
    await testMockInput.pasteBracketedText("prevented")

    expect(onPasteCalled).toBe(true)
    expect(handlePasteCalled).toBe(false)
  })

  test("blur() calls _ctx.blurRenderable to reset focusedRenderable", () => {
    const renderable = new TestFocusableRenderable(testRenderer, { id: "test-blur-context" })
    const blurSpy = spyOn(testRenderer, "blurRenderable")

    renderable.focus()
    expect(renderable.focused).toBe(true)
    expect(blurSpy).not.toHaveBeenCalled()
    expect(testRenderer.currentFocusedRenderable).toEqual(renderable)

    renderable.blur()
    expect(blurSpy).toHaveBeenCalledWith(renderable)
    expect(blurSpy).toHaveBeenCalledTimes(1)
    expect(testRenderer.currentFocusedRenderable).toBeNull()
  })

  test("destroy() blurs renderable on context when focused", () => {
    const renderable = new TestFocusableRenderable(testRenderer, { id: "test-destroy-focused" })
    const blurSpy = spyOn(testRenderer, "blurRenderable")

    renderable.focus()
    expect(renderable.focused).toBe(true)
    expect(blurSpy).not.toHaveBeenCalled()
    expect(testRenderer.currentFocusedRenderable).toEqual(renderable)

    renderable.destroy()
    expect(blurSpy).toHaveBeenCalledWith(renderable)
    expect(blurSpy).toHaveBeenCalledTimes(1)
    expect(renderable.focused).toBe(false)
    expect(testRenderer.currentFocusedRenderable).toBeNull()
  })

  test("destroy() releases focus state when the native blur fails", () => {
    const keyHandlers = (testRenderer._internalKeyInput as unknown as { renderableHandlers: Map<string, Set<unknown>> })
      .renderableHandlers
    const node = new TestFocusableRenderable(testRenderer, {})
    testRenderer.root.add(node)
    node.focus()
    expect(keyHandlers.get("keypress")?.size).toBe(1)
    const setFocus = spyOn(testRenderer.nativeScene, "setFocus").mockImplementation(() => {
      throw new Error("native blur failed")
    })
    expect(() => node.destroy()).toThrow("native blur failed")
    setFocus.mockRestore()

    expect([node.isDestroyed, node.focused]).toEqual([true, false])
    expect(testRenderer.currentFocusedRenderable).toBeNull()
    expect([keyHandlers.get("keypress")?.size, keyHandlers.get("paste")?.size]).toEqual([0, 0])
    const other = new TestFocusableRenderable(testRenderer, {})
    testRenderer.root.add(other)
    other.focus()
    expect(testRenderer.currentFocusedRenderable === other).toBe(true)
  })

  test("destroy() does not call blurRenderable when renderable was not focused", () => {
    const renderable = new TestFocusableRenderable(testRenderer, { id: "test-destroy-not-focused" })
    const blurSpy = spyOn(testRenderer, "blurRenderable")

    // Don't focus the renderable
    expect(renderable.focused).toBe(false)

    renderable.destroy()
    // blur() is called but returns early since renderable wasn't focused
    // so blurRenderable is never called
    expect(blurSpy).not.toHaveBeenCalled()
  })
})

describe("Renderable - Lifecycle", () => {
  test("layout reads during destroy return the live layout", async () => {
    const parent = new TestRenderable(testRenderer, { width: 12, height: 4, position: "absolute", left: 3, top: 1 })
    const child = new TestRenderable(testRenderer, { marginLeft: 2, height: 2 })
    parent.add(child)
    testRenderer.root.add(parent)
    await renderOnce()
    const layout = () => [
      child.x,
      child.y,
      child.screenX,
      child.screenY,
      child.width,
      child.height,
      child.getLayout().width,
    ]
    const live = layout()
    let destroying: number[] = []
    child.on(RenderableEvents.DESTROYED, () => (destroying = layout()))
    child.destroy()
    expect(live).toEqual([5, 1, 5, 1, 10, 2, 10])
    expect(destroying).toEqual(live)
  })
})

describe("Renderable - Layout with Viewport Filtering", () => {
  beforeEach(async () => {
    testRenderer.destroy()
    ;({ renderer: testRenderer, renderOnce } = await createTestRenderer({ width: 120, height: 100 }))
  })

  test("viewport culling skips children below the visible area", async () => {
    const parent = new ScrollBoxRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 30,
      flexDirection: "column",
      scrollbarOptions: { visible: false },
      viewportCulling: true,
    })

    const visibleChild = new TextRenderable(testRenderer, {
      id: "visible-child",
      content: "visible-child",
      height: 30,
      flexGrow: 0,
    })
    const filteredChild = new TextRenderable(testRenderer, {
      id: "filtered-child",
      content: "filtered-child",
      height: 30,
      flexGrow: 0,
    })

    parent.add(visibleChild)
    parent.add(filteredChild)
    testRenderer.root.add(parent)

    await renderOnce()

    const frame = new TextDecoder().decode(testRenderer.currentRenderBuffer.getRealCharBytes(true))
    expect(frame).toContain("visible-child")
    expect(frame).not.toContain("filtered-child")
    expect(testRenderer.hitTest(visibleChild.x, visibleChild.y)).toBe(visibleChild.num)
    expect(testRenderer.hitTest(filteredChild.x, filteredChild.y)).not.toBe(filteredChild.num)
  })

  test("newly added children receive layout even when filtered from viewport", async () => {
    const parent = new ScrollBoxRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 60,
      flexDirection: "column",
      scrollbarOptions: { visible: false },
      viewportCulling: true,
    })

    // Add initial children
    const child1 = new TestRenderable(testRenderer, {
      id: "child1",
      height: 30,
      flexGrow: 0,
    })
    const child2 = new TestRenderable(testRenderer, {
      id: "child2",
      height: 30,
      flexGrow: 0,
    })

    parent.add(child1)
    parent.add(child2)
    testRenderer.root.add(parent)
    await renderOnce()

    // Add a third child that will be filtered out
    const child3 = new TestRenderable(testRenderer, {
      id: "child3",
      height: 25,
      flexGrow: 0,
    })

    parent.add(child3)

    expect(child3.width).toBe(0)

    await renderOnce()

    expect(child3.width).toBe(100)
    expect(child3.height).toBe(25)
    expect(child3.y).toBe(60)
  })

  test("renders all children when viewport culling is disabled", async () => {
    const parent = new ScrollBoxRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 60,
      flexDirection: "column",
      scrollbarOptions: { visible: false },
      viewportCulling: false,
    })

    const child1 = new CountingRenderable(testRenderer, { id: "child1", height: 20, flexGrow: 0 })
    const child2 = new CountingRenderable(testRenderer, { id: "child2", height: 20, flexGrow: 0 })
    const child3 = new CountingRenderable(testRenderer, { id: "child3", height: 20, flexGrow: 0 })

    parent.add(child1)
    parent.add(child2)
    parent.add(child3)
    testRenderer.root.add(parent)

    await renderOnce()

    expect(child1.renderCount).toBeGreaterThan(0)
    expect(child2.renderCount).toBeGreaterThan(0)
    expect(child3.renderCount).toBeGreaterThan(0)
    expect(child1.renderCount).toBe(child2.renderCount)
    expect(child2.renderCount).toBe(child3.renderCount)
  })

  test("renders only filtered children while still updating hidden layout", async () => {
    const parent = new ScrollBoxRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 40,
      flexDirection: "column",
      scrollbarOptions: { visible: false },
      viewportCulling: true,
    })

    const child1 = new TextRenderable(testRenderer, { id: "child1", content: "child1", height: 20, flexGrow: 0 })
    const child2 = new TextRenderable(testRenderer, { id: "child2", content: "child2", height: 20, flexGrow: 0 })
    const child3 = new TextRenderable(testRenderer, { id: "child3", content: "child3", height: 20, flexGrow: 0 })

    parent.add(child1)
    parent.add(child2)
    parent.add(child3)
    testRenderer.root.add(parent)

    await renderOnce()

    const frame = new TextDecoder().decode(testRenderer.currentRenderBuffer.getRealCharBytes(true))
    expect(frame).toContain("child1")
    expect(frame).toContain("child2")
    expect(frame).not.toContain("child3")
    expect(child3.height).toBe(20)
  })

  test("child inserted before visible children receives layout when filtered", async () => {
    const parent = new ScrollBoxRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 40,
      flexDirection: "column",
      scrollbarOptions: { visible: false },
      viewportCulling: true,
    })

    const child1 = new TestRenderable(testRenderer, {
      id: "child1",
      height: 20,
      flexGrow: 0,
    })
    const child2 = new TestRenderable(testRenderer, {
      id: "child2",
      height: 20,
      flexGrow: 0,
    })
    const child3 = new TestRenderable(testRenderer, {
      id: "child3",
      height: 20,
      flexGrow: 0,
    })

    parent.add(child1)
    parent.add(child2)
    parent.add(child3)
    testRenderer.root.add(parent)
    await renderOnce()

    // Insert a new child that pushes child3 further down (outside viewport filter)
    const newChild = new TestRenderable(testRenderer, {
      id: "newChild",
      height: 15,
      flexGrow: 0,
    })

    parent.insertBefore(newChild, child2)

    await renderOnce()

    expect(newChild.width).toBe(100)
    expect(newChild.height).toBe(15)
    expect(child3.width).toBe(100)
    expect(child3.height).toBe(20)

    expect(child1.y).toBe(0)
    expect(newChild.y).toBe(20)
    expect(child2.y).toBe(35)
    expect(child3.y).toBe(55)
  })
})

describe("Renderable - tree model", () => {
  // Seeded add, insertBefore, remove, destroy, visibility, live, and focus sequences over a small column tree.
  // After each operation the tree, live counts, focus paths, lifecycle registrations, and native nodes match a
  // model; after each frame every shown node sits right below its shown earlier siblings.
  const width = 40

  interface Entry {
    node: Renderable
    height: number | null
    hook: boolean
    parent: Entry | null
    children: Entry[]
    visible: boolean
    live: boolean
    destroyed: boolean
    registered: boolean
  }

  function createRandom(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  test.each(Array.from({ length: 24 }, (_, i) => i + 1))("seed %j", async (seed) => {
    const random = createRandom(seed)
    const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)]
    const edges = { requestLive: 0, dropLive: 0 }
    const expectedEdges = { requestLive: 0, dropLive: 0 }
    spyOn(testRenderer, "requestLive").mockImplementation(() => void edges.requestLive++)
    spyOn(testRenderer, "dropLive").mockImplementation(() => void edges.dropLive++)
    const create = (node: Renderable, height: number | null, hook = false): Entry => {
      if (hook) node.onLifecyclePass = () => {}
      return {
        node,
        height,
        hook,
        parent: null,
        children: [],
        visible: true,
        live: false,
        destroyed: false,
        registered: false,
      }
    }
    const host = create(new TestRenderable(testRenderer, { id: "host", width }), null)
    const containers = [0, 1, 2].map((i) => create(new TestRenderable(testRenderer, { id: `c${i}` }), null, i === 0))
    const leaves = [1, 2, 3, 1, 2, 3, 1, 2].map((height, i) =>
      create(new TestFocusableRenderable(testRenderer, { id: `l${i}`, height }), height, i < 2),
    )
    const nodes = [host, ...containers, ...leaves]
    testRenderer.root.add(host.node)
    host.parent = create(testRenderer.root, null)
    let focused = null as Entry | null

    const alive = (list: Entry[]) => list.filter((entry) => !entry.destroyed && entry !== host)
    const subtree = (entry: Entry): Entry[] => [entry, ...entry.children.flatMap(subtree)]
    const liveCount = (entry: Entry): number =>
      (entry.live && entry.visible ? 1 : 0) + entry.children.reduce((sum, child) => sum + liveCount(child), 0)
    const hasFocused = (entry: Entry): boolean => entry.children.some((child) => child === focused || hasFocused(child))
    const detach = (entry: Entry) => {
      if (entry.parent) entry.parent.children.splice(entry.parent.children.indexOf(entry), 1)
      entry.parent = null
    }
    const place = (child: Entry, parent: Entry, anchor?: Entry) => {
      detach(child)
      parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child)
      child.parent = parent
      child.registered = child.hook
    }
    const destroy = (entry: Entry) => {
      detach(entry)
      for (const child of entry.children) Object.assign(child, { parent: null, registered: false })
      Object.assign(entry, { children: [], destroyed: true, registered: false })
      if (focused === entry) focused = null
    }
    const parentsFor = (child: Entry) =>
      [host, ...alive(containers)].filter((parent) => !subtree(child).includes(parent))

    const operations: Record<string, () => string | undefined> = {
      add() {
        const child = pick(alive(nodes))
        const parent = child && pick(parentsFor(child))
        if (!child || !parent) return
        let index: number | undefined = Math.floor(random() * (parent.children.length + 2))
        if (index > parent.children.length || parent.children[index] === child) index = undefined
        place(child, parent, index === undefined ? undefined : parent.children[index])
        parent.node.add(child.node, index)
        return `${parent.node.id}.add(${child.node.id}, ${index})`
      },
      insertBefore() {
        const parent = pick([host, ...alive(containers)].filter((entry) => entry.children.length > 0))
        const anchor = parent && pick(parent.children)
        const child =
          anchor && pick(alive(nodes).filter((entry) => entry !== anchor && parentsFor(entry).includes(parent)))
        if (!parent || !anchor || !child) return
        place(child, parent, anchor)
        parent.node.insertBefore(child.node, anchor.node)
        return `${parent.node.id}.insertBefore(${child.node.id}, ${anchor.node.id})`
      },
      remove() {
        const child = pick(alive(nodes).filter((entry) => entry.parent))
        if (!child) return
        const parent = child.parent!
        detach(child)
        child.registered = false
        parent.node.remove(child.node)
        return `${parent.node.id}.remove(${child.node.id})`
      },
      destroy() {
        // Includes destroyed nodes: a second destroy changes nothing.
        const entry = pick(nodes.filter((entry) => entry !== host))!
        if (!entry.destroyed) destroy(entry)
        entry.node.destroy()
        return `${entry.node.id}.destroy()`
      },
      destroyRecursively() {
        const entry = pick(alive(nodes))
        if (!entry) return
        for (const node of subtree(entry).reverse()) destroy(node)
        entry.node.destroyRecursively()
        return `${entry.node.id}.destroyRecursively()`
      },
      visible() {
        const entry = pick(alive(nodes))
        if (!entry) return
        entry.visible = !entry.visible
        // As on `main`, any visibility change blurs the node.
        if (focused === entry) focused = null
        entry.node.visible = entry.visible
        return `${entry.node.id}.visible = ${entry.visible}`
      },
      live() {
        const entry = pick(alive(nodes))
        if (!entry) return
        const value = random() < 0.25 ? null : !entry.live
        entry.live = !!value
        ;(entry.node as { live: boolean | null }).live = value
        return `${entry.node.id}.live = ${value}`
      },
      focus() {
        const entry = pick(alive(leaves))
        if (!entry) return
        focused = entry
        entry.node.focus()
        return `${entry.node.id}.focus()`
      },
      blur() {
        if (!focused) return
        const entry = focused
        focused = null
        entry.node.blur()
        return `${entry.node.id}.blur()`
      },
    }

    const state = (actual: boolean) => {
      const scene = new Set(testRenderer.nativeScene.getRenderables())
      return nodes.map((entry) => {
        const node = entry.node
        const inScene = scene.has(node)
        const native = actual
          ? `freed=${node.isFreed()} scene=${inScene}`
          : `freed=${entry.destroyed} scene=${!entry.destroyed}`
        if (actual ? node.isDestroyed : entry.destroyed) return `${node.id} destroyed ${native}`
        const fields = actual
          ? [node.parent?.id, node.getChildren().map((child) => child.id), node.liveCount, node.focused]
          : [entry.parent?.node.id, entry.children.map((child) => child.node.id), liveCount(entry), entry === focused]
        const focus = actual ? node.hasFocusedDescendant : hasFocused(entry)
        const registered = actual ? testRenderer.getLifecyclePasses().has(node) : entry.registered
        return `${node.id} ${JSON.stringify(fields)} focus=${focus} lifecycle=${registered} ${native}`
      })
    }
    const layout = (entry: Entry, y: number, actual: string[], expected: string[]): number => {
      let bottom = y + (entry.height ?? 0)
      for (const child of entry.children) if (child.visible) bottom += layout(child, bottom, actual, expected)
      const height = entry.height ?? bottom - y
      actual.push(`${entry.node.id} y=${entry.node.y} h=${entry.node.height} w=${entry.node.width}`)
      // Like `main`, public sizes are at least one cell, even for an empty container that takes no rows.
      expected.push(`${entry.node.id} y=${y} h=${Math.max(height, 1)} w=${width}`)
      return height
    }

    // Destruction ends a sequence early, so it is drawn less often.
    const names = [...Object.keys(operations), "add", "add", "insertBefore", "remove", "visible", "live", "focus"]
    const history: string[] = []
    for (let step = 0; step < 80; step++) {
      const rootLive = liveCount(host)
      const operation = operations[pick(names)!]!()
      if (!operation) continue
      history.push(operation)
      const nowLive = liveCount(host)
      if (rootLive === 0 && nowLive > 0) expectedEdges.requestLive++
      if (rootLive > 0 && nowLive === 0) expectedEdges.dropLive++
      const current = testRenderer.currentFocusedRenderable?.id
      expect({ history, state: state(true), edges, current }).toEqual({
        history,
        state: state(false),
        edges: expectedEdges,
        current: focused?.node.id,
      })
      await renderOnce()
      const actual: string[] = []
      const expected: string[] = []
      layout(host, 0, actual, expected)
      expect({ history, layout: actual }).toEqual({ history, layout: expected })
    }
  })
})

describe("Renderable - hook installation", () => {
  // Each way to provide a hook, on a plain subclass and on built-ins with a native body, runs the hook in frames.
  // Clearing an optional hook stops it. Construction publishes prototype hooks; a scan before the frame finds fields.
  // Text skips the generic paint decorations (`beforeAfter: false`, documented), and its constructor assigns its own
  // lifecycle pass over a subclass method, as on `main`.
  const skipped = (base: string, install: string, hook: string) =>
    base === "Text" &&
    (hook === "renderBefore" || hook === "renderAfter" || (install === "prototype" && hook === "onLifecyclePass"))
  const hooks = ["renderSelf", "onUpdate", "renderBefore", "renderAfter", "onLifecyclePass"] as const
  const bases = { Renderable: TestRenderable, Box: BoxRenderable, Text: TextRenderable } as const
  const installs = ["prototype", "field", "option", "assignment", "defineProperty"] as const
  const cases = (Object.keys(bases) as (keyof typeof bases)[]).flatMap((base) =>
    installs.flatMap((install) =>
      hooks
        .filter((hook) => install !== "option" || hook === "renderBefore" || hook === "renderAfter")
        .map((hook) => [base, install, hook] as const),
    ),
  )

  test.each(cases)("%s %s %s", async (base, install, hook) => {
    let calls = 0
    const handler = () => void calls++
    const descriptor = { value: handler, writable: true, enumerable: true, configurable: true }
    const Base = bases[base] as typeof TestRenderable
    class Probe extends Base {
      constructor(ctx: RenderContext, options: RenderableOptions) {
        super(ctx, options)
        if (install === "field") Object.defineProperty(this, hook, descriptor)
      }
    }
    if (install === "prototype") Object.defineProperty(Probe.prototype, hook, { ...descriptor, enumerable: false })
    const node = new Probe(testRenderer, { width: 4, height: 1, ...(install === "option" && { [hook]: handler }) })
    testRenderer.root.add(node)
    if (install === "assignment") Reflect.set(node, hook, handler)
    if (install === "defineProperty") {
      Object.defineProperty(node, hook, descriptor)
      node.refreshHooks()
    }

    await renderOnce()
    if (skipped(base, install, hook)) return expect(calls).toBe(0)
    expect(calls).toBeGreaterThan(0)
    if (hook === "renderSelf" || hook === "onUpdate") return
    Reflect.set(node, hook, null)
    calls = 0
    await renderOnce()
    expect(calls).toBe(0)
  })
})

describe("RootRenderable", () => {
  test("creates with proper setup", () => {
    const root = testRenderer.root
    expect(root.id).toBe("__root__")
    expect(root.visible).toBe(true)
    expect(root.width).toBe(testRenderer.width)
    expect(root.height).toBe(testRenderer.height)
  })

  test("publishes root layout after rendering", async () => {
    await renderOnce()
    const root = testRenderer.root
    expect(root.getLayout().width).toBe(testRenderer.width)
    expect(root.getLayout().height).toBe(testRenderer.height)
  })

  test("handles resize", async () => {
    const root = testRenderer.root
    const newWidth = 70
    const newHeight = 50

    root.resize(newWidth, newHeight)
    await renderOnce()

    expect(root.width).toBe(newWidth)
    expect(root.height).toBe(newHeight)
  })
})
