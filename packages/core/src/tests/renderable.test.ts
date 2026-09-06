import { getYogaNode } from "../lib/renderable-layout.js"
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
import { Unit } from "../yoga.js"

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
let captureCharFrame: () => string

beforeEach(async () => {
  ;({
    renderer: testRenderer,
    mockMouse: testMockMouse,
    mockInput: testMockInput,
    renderOnce,
    captureCharFrame,
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

  test.each([
    ["getter", "minWidth"],
    ["getter", "flexGrow"],
    ["proxy", "minWidth"],
    ["proxy", "flexGrow"],
  ] as const)("constructor restores defaults after %s reentry changes %s", async (access, property) => {
    const options = { id: `constructor-${access}-${property}`, width: 2, height: 2, border: true }
    const reenter = () => {
      const constructing = [...Renderable.renderablesByNumber.values()].find((node) => node.id === options.id)
      expect(constructing).toBeDefined()
      constructing![property] = 8
      return undefined
    }
    const box = new BoxRenderable(
      testRenderer,
      access === "getter"
        ? Object.defineProperty(options, "minWidth", { get: reenter })
        : new Proxy(options, {
            get(target, key, receiver) {
              return key === "minWidth" ? reenter() : Reflect.get(target, key, receiver)
            },
          }),
    )
    testRenderer.root.add(box)
    const node = getYogaNode(box)
    expect(node.getMinWidth()).toEqual({ unit: Unit.Undefined, value: NaN })
    expect(node.getFlexGrow()).toBe(0)
    await renderOnce()
    expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, 2, 2])
    expect(
      captureCharFrame()
        .split("\n")
        .slice(0, 3)
        .map((row) => row.trimEnd()),
    ).toEqual(["\u250c\u2510", "\u2514\u2518", ""])
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
  test("primary-axis sorting reads each child's layout once", async () => {
    const parent = new TestRenderable(testRenderer, { width: 10, height: 10 })
    for (const top of [3, 1, 2, 0]) {
      parent.add(new TestRenderable(testRenderer, { id: String(top), position: "absolute", top, width: 1, height: 1 }))
    }
    testRenderer.root.add(parent)
    await renderOnce()
    const reads = spyOn(testRenderer.nativeScene.driver.renderLib, "sceneGetLayout")
    try {
      expect(parent.getChildrenSortedByPrimaryAxis().map((child) => child.id)).toEqual(["0", "1", "2", "3"])
      expect(reads).toHaveBeenCalledTimes(4)
    } finally {
      reads.mockRestore()
    }
  })

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
  test("ordinary first attachment does not allocate unused propagation maps", async () => {
    const child = new BoxRenderable(testRenderer, { width: 2, height: 1 })
    const OriginalMap = globalThis.Map
    let allocations = 0
    globalThis.Map = class<K, V> extends OriginalMap<K, V> {
      constructor(entries?: Iterable<readonly [K, V]> | null) {
        super(entries)
        allocations++
      }
    }
    try {
      testRenderer.root.add(child)
    } finally {
      globalThis.Map = OriginalMap
    }
    expect(allocations).toBe(0)
    expect(child.parent).toBe(testRenderer.root)
    expect(testRenderer.root.getChildren()).toContain(child)
    await renderOnce()
    expect(child.width).toBe(2)
  })

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

  test("renderBefore position changes update hit-grid coordinates in the same frame", async () => {
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

    expect(testRenderer.hitTest(renderable.screenX, renderable.screenY)).toBe(renderable.num)
    expect(testRenderer.hitTest(2, 3)).not.toBe(renderable.num)
  })

  test("renderBefore position changes update frame-buffer compositing coordinates in the same frame", async () => {
    testRenderer.requestRender = () => {}
    const drawFrameBufferSpy = spyOn(testRenderer.nextRenderBuffer, "drawFrameBuffer")

    const renderable = new TestRenderable(testRenderer, {
      id: "hook-moved-buffered",
      buffered: true,
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

    const call = drawFrameBufferSpy.mock.calls.find((args) => args[2]?.id === `framebuffer-${renderable.id}`)
    if (!call) {
      throw new Error("Expected renderable frame buffer to be composited")
    }

    expect(call[0]).toBe(renderable.screenX)
    expect(call[1]).toBe(renderable.screenY)
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

  test("destroyRecursively destroys nested children recursively", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child = new TestRenderable(testRenderer, { id: "child" })
    const grandchild = new TestRenderable(testRenderer, { id: "grandchild" })
    const greatGrandchild = new TestRenderable(testRenderer, { id: "greatGrandchild" })

    parent.add(child)
    child.add(grandchild)
    grandchild.add(greatGrandchild)

    expect(parent.isDestroyed).toBe(false)
    expect(child.isDestroyed).toBe(false)
    expect(grandchild.isDestroyed).toBe(false)
    expect(greatGrandchild.isDestroyed).toBe(false)

    parent.destroyRecursively()

    expect(parent.isDestroyed).toBe(true)
    expect(child.isDestroyed).toBe(true)
    expect(grandchild.isDestroyed).toBe(true)
    expect(greatGrandchild.isDestroyed).toBe(true)
  })

  test("destroyRecursively handles empty renderable without errors", () => {
    const parent = new TestRenderable(testRenderer, { id: "empty-parent" })

    expect(parent.isDestroyed).toBe(false)
    expect(() => parent.destroyRecursively()).not.toThrow()
    expect(parent.isDestroyed).toBe(true)
  })

  test("destroyRecursively destroys all children correctly with multiple children", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent" })
    const child1 = new TestRenderable(testRenderer, { id: "child1" })
    const child2 = new TestRenderable(testRenderer, { id: "child2" })
    const child3 = new TestRenderable(testRenderer, { id: "child3" })

    parent.add(child1)
    parent.add(child2)
    parent.add(child3)

    parent.destroyRecursively()

    expect(parent.isDestroyed).toBe(true)
    expect(child1.isDestroyed).toBe(true)
    expect(child2.isDestroyed).toBe(true)
    expect(child3.isDestroyed).toBe(true)
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

  test("newly added children receive correct layout dimensions on first render", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 100,
      flexDirection: "column",
    })

    testRenderer.root.add(parent)
    await renderOnce()

    // Add children after parent has been rendered
    const child1 = new TestRenderable(testRenderer, {
      id: "child1",
      height: 30,
      flexGrow: 0,
    })
    const child2 = new TestRenderable(testRenderer, {
      id: "child2",
      height: 20,
      flexGrow: 0,
    })

    parent.add(child1)
    parent.add(child2)

    expect(child1.width).toBe(0)
    expect(child2.width).toBe(0)

    await renderOnce()

    expect(child1.width).toBe(100)
    expect(child1.height).toBe(30)
    expect(child2.width).toBe(100)
    expect(child2.height).toBe(20)
  })

  test("newly added children with nested children receive correct layout", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 100,
    })

    testRenderer.root.add(parent)
    await renderOnce()

    const child = new TestRenderable(testRenderer, {
      id: "child",
      width: 50,
      height: 50,
    })
    const grandchild = new TestRenderable(testRenderer, {
      id: "grandchild",
      flexGrow: 1,
    })

    child.add(grandchild)
    parent.add(child)

    await renderOnce()

    expect(child.width).toBe(50)
    expect(child.height).toBe(50)

    expect(grandchild.width).toBeGreaterThan(0)
    expect(grandchild.height).toBeGreaterThan(0)
  })

  test("children added via insertBefore receive correct layout on first render", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 100,
      flexDirection: "column",
    })

    const child1 = new TestRenderable(testRenderer, {
      id: "child1",
      height: 20,
      flexGrow: 0,
    })
    const child3 = new TestRenderable(testRenderer, {
      id: "child3",
      height: 20,
      flexGrow: 0,
    })

    parent.add(child1)
    parent.add(child3)
    testRenderer.root.add(parent)
    await renderOnce()

    // Insert child2 between child1 and child3
    const child2 = new TestRenderable(testRenderer, {
      id: "child2",
      height: 15,
      flexGrow: 0,
    })

    parent.insertBefore(child2, child3)

    expect(child2.width).toBe(0)

    await renderOnce()

    expect(child2.width).toBe(100)
    expect(child2.height).toBe(15)

    expect(child1.y).toBe(0)
    expect(child2.y).toBe(20)
    expect(child3.y).toBe(35)
  })

  test("children after insertBefore anchor maintain correct layout", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 100,
      flexDirection: "row",
    })

    const child1 = new TestRenderable(testRenderer, {
      id: "child1",
      width: 20,
      flexGrow: 0,
    })
    const child2 = new TestRenderable(testRenderer, {
      id: "child2",
      width: 25,
      flexGrow: 0,
    })
    const child3 = new TestRenderable(testRenderer, {
      id: "child3",
      width: 30,
      flexGrow: 0,
    })

    parent.add(child1)
    parent.add(child2)
    parent.add(child3)
    testRenderer.root.add(parent)
    await renderOnce()

    const child1InitialX = child1.x
    const child2InitialX = child2.x
    const child3InitialX = child3.x

    const newChild = new TestRenderable(testRenderer, {
      id: "newChild",
      width: 10,
      flexGrow: 0,
    })

    parent.insertBefore(newChild, child2)
    await renderOnce()

    expect(child1.x).toBe(child1InitialX)
    expect(newChild.x).toBe(child1InitialX + 20)
    expect(child2.x).toBe(child1InitialX + 30)
    expect(child3.x).toBe(child1InitialX + 55)

    expect(child1.width).toBe(20)
    expect(newChild.width).toBe(10)
    expect(child2.width).toBe(25)
    expect(child3.width).toBe(30)
  })

  test("multiple children inserted in sequence receive correct layout", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 200,
      height: 100,
      flexDirection: "column",
    })

    const anchor = new TestRenderable(testRenderer, {
      id: "anchor",
      height: 10,
      flexGrow: 0,
    })

    parent.add(anchor)
    testRenderer.root.add(parent)
    await renderOnce()

    // Insert multiple children before the anchor in sequence
    const newChild1 = new TestRenderable(testRenderer, {
      id: "new1",
      height: 15,
      flexGrow: 0,
    })
    const newChild2 = new TestRenderable(testRenderer, {
      id: "new2",
      height: 20,
      flexGrow: 0,
    })
    const newChild3 = new TestRenderable(testRenderer, {
      id: "new3",
      height: 25,
      flexGrow: 0,
    })

    parent.insertBefore(newChild1, anchor)
    parent.insertBefore(newChild2, anchor)
    parent.insertBefore(newChild3, anchor)

    await renderOnce()

    expect(newChild1.width).toBe(200)
    expect(newChild1.height).toBe(15)
    expect(newChild2.width).toBe(200)
    expect(newChild2.height).toBe(20)
    expect(newChild3.width).toBe(200)
    expect(newChild3.height).toBe(25)

    expect(newChild1.y).toBe(0)
    expect(newChild2.y).toBe(15)
    expect(newChild3.y).toBe(35)
    expect(anchor.y).toBe(60)
  })

  test("existing child moved via insertBefore maintains layout integrity", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 100,
      flexDirection: "column",
    })

    const child1 = new TestRenderable(testRenderer, {
      id: "child1",
      height: 10,
      flexGrow: 0,
    })
    const child2 = new TestRenderable(testRenderer, {
      id: "child2",
      height: 20,
      flexGrow: 0,
    })
    const child3 = new TestRenderable(testRenderer, {
      id: "child3",
      height: 30,
      flexGrow: 0,
    })

    parent.add(child1)
    parent.add(child2)
    parent.add(child3)
    testRenderer.root.add(parent)
    await renderOnce()

    parent.insertBefore(child3, child1)
    await renderOnce()

    expect(child3.y).toBe(0)
    expect(child1.y).toBe(30)
    expect(child2.y).toBe(40)

    expect(child1.width).toBe(100)
    expect(child1.height).toBe(10)
    expect(child2.width).toBe(100)
    expect(child2.height).toBe(20)
    expect(child3.width).toBe(100)
    expect(child3.height).toBe(30)
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
  test("handles destroy", () => {
    const renderable = new TestRenderable(testRenderer, { id: "test-destroy" })
    expect(renderable.isDestroyed).toBe(false)

    renderable.destroy()
    expect(renderable.isDestroyed).toBe(true)
  })

  test("prevents double destroy", () => {
    const renderable = new TestRenderable(testRenderer, { id: "test-double-destroy" })
    renderable.destroy()
    expect(renderable.isDestroyed).toBe(true)

    // Should not throw or cause issues
    renderable.destroy()
    expect(renderable.isDestroyed).toBe(true)
  })

  test("handles recursive destroy", () => {
    const parent = new TestRenderable(testRenderer, { id: "parent-destroy" })
    const child = new TestRenderable(testRenderer, { id: "child-destroy" })
    parent.add(child)

    parent.destroyRecursively()
    expect(parent.isDestroyed).toBe(true)
    expect(child.isDestroyed).toBe(true)
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

describe("Renderable - Nested Children Layout", () => {
  test("newly added parent with deeply nested children all receive layout", async () => {
    const root = new TestRenderable(testRenderer, {
      id: "root",
      width: 200,
      height: 200,
    })

    testRenderer.root.add(root)
    await renderOnce()

    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 150,
      height: 150,
    })
    const child = new TestRenderable(testRenderer, {
      id: "child",
      width: 100,
      height: 100,
    })
    const grandchild = new TestRenderable(testRenderer, {
      id: "grandchild",
      width: 50,
      height: 50,
    })
    const greatGrandchild = new TestRenderable(testRenderer, {
      id: "greatGrandchild",
      flexGrow: 1,
    })

    grandchild.add(greatGrandchild)
    child.add(grandchild)
    parent.add(child)

    root.add(parent)

    await renderOnce()

    expect(parent.width).toBe(150)
    expect(parent.height).toBe(150)

    expect(child.width).toBe(100)
    expect(child.height).toBe(100)

    expect(grandchild.width).toBeGreaterThan(0)
    expect(grandchild.height).toBeGreaterThan(0)
  })

  test("insertBefore with nested children updates all descendants correctly", async () => {
    const root = new TestRenderable(testRenderer, {
      id: "root",
      width: 200,
      height: 200,
      flexDirection: "column",
    })

    const existingChild = new TestRenderable(testRenderer, {
      id: "existing",
      height: 50,
      flexGrow: 0,
    })

    root.add(existingChild)
    testRenderer.root.add(root)
    await renderOnce()

    const newParent = new TestRenderable(testRenderer, {
      id: "newParent",
      height: 80,
      flexGrow: 0,
    })
    const nestedChild = new TestRenderable(testRenderer, {
      id: "nested",
      flexGrow: 1,
    })

    newParent.add(nestedChild)
    root.insertBefore(newParent, existingChild)

    await renderOnce()

    expect(newParent.width).toBe(200)
    expect(newParent.height).toBe(80)
    expect(newParent.y).toBe(0)

    expect(nestedChild.width).toBeGreaterThan(0)
    expect(nestedChild.height).toBeGreaterThan(0)

    expect(existingChild.y).toBe(80)
  })
})

describe("Renderable - Complex Layout Update Scenarios", () => {
  test("multiple rapid add operations before render complete correctly", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 200,
      flexDirection: "column",
    })

    testRenderer.root.add(parent)
    await renderOnce()

    const children: TestRenderable[] = []
    for (let i = 0; i < 5; i++) {
      const child = new TestRenderable(testRenderer, {
        id: `child-${i}`,
        height: 20,
        flexGrow: 0,
      })
      children.push(child)
      parent.add(child)
    }

    for (const child of children) {
      expect(child.width).toBe(0)
    }

    await renderOnce()

    let expectedY = 0
    for (const child of children) {
      expect(child.width).toBe(100)
      expect(child.height).toBe(20)
      expect(child.y).toBe(expectedY)
      expectedY += 20
    }
  })

  test("insertBefore at different positions updates subsequent children correctly", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 300,
      flexDirection: "column",
    })

    const children: TestRenderable[] = []
    for (let i = 0; i < 5; i++) {
      const child = new TestRenderable(testRenderer, {
        id: `child-${i}`,
        height: 20,
        flexGrow: 0,
      })
      children.push(child)
      parent.add(child)
    }

    testRenderer.root.add(parent)
    await renderOnce()

    const insert1 = new TestRenderable(testRenderer, {
      id: "insert1",
      height: 15,
      flexGrow: 0,
    })
    parent.insertBefore(insert1, children[2]!)

    await renderOnce()

    expect(children[0]!.y).toBe(0)
    expect(children[1]!.y).toBe(20)
    expect(insert1.y).toBe(40)
    expect(children[2]!.y).toBe(55)
    expect(children[3]!.y).toBe(75)
    expect(children[4]!.y).toBe(95)

    const insert2 = new TestRenderable(testRenderer, {
      id: "insert2",
      height: 10,
      flexGrow: 0,
    })
    parent.insertBefore(insert2, children[4]!)

    await renderOnce()

    expect(children[0]!.y).toBe(0)
    expect(children[1]!.y).toBe(20)
    expect(insert1.y).toBe(40)
    expect(children[2]!.y).toBe(55)
    expect(children[3]!.y).toBe(75)
    expect(insert2.y).toBe(95)
    expect(children[4]!.y).toBe(105)
  })

  test("add and insertBefore mixed operations maintain layout integrity", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 200,
      flexDirection: "column",
    })

    testRenderer.root.add(parent)
    await renderOnce()

    const child1 = new TestRenderable(testRenderer, {
      id: "child1",
      height: 10,
      flexGrow: 0,
    })
    const child2 = new TestRenderable(testRenderer, {
      id: "child2",
      height: 20,
      flexGrow: 0,
    })

    parent.add(child1)
    parent.add(child2)

    const child3 = new TestRenderable(testRenderer, {
      id: "child3",
      height: 15,
      flexGrow: 0,
    })
    parent.insertBefore(child3, child2)

    const child4 = new TestRenderable(testRenderer, {
      id: "child4",
      height: 25,
      flexGrow: 0,
    })
    parent.add(child4)

    await renderOnce()

    expect(child1.y).toBe(0)
    expect(child3.y).toBe(10)
    expect(child2.y).toBe(25)
    expect(child4.y).toBe(45)

    expect(child1.width).toBe(100)
    expect(child2.width).toBe(100)
    expect(child3.width).toBe(100)
    expect(child4.width).toBe(100)
  })

  test("children removed and re-added receive fresh layout", async () => {
    const parent = new TestRenderable(testRenderer, {
      id: "parent",
      width: 100,
      height: 100,
      flexDirection: "column",
    })

    const child1 = new TestRenderable(testRenderer, {
      id: "child1",
      height: 30,
      flexGrow: 0,
    })
    const child2 = new TestRenderable(testRenderer, {
      id: "child2",
      height: 40,
      flexGrow: 0,
    })

    parent.add(child1)
    parent.add(child2)
    testRenderer.root.add(parent)
    await renderOnce()

    const child1InitialY = child1.y
    const child2InitialY = child2.y

    expect(child1InitialY).toBe(0)
    expect(child2InitialY).toBe(30)

    parent.remove(child1)
    await renderOnce()

    expect(child2.y).toBe(0)

    parent.add(child1)
    await renderOnce()

    expect(child2.y).toBe(0)
    expect(child1.y).toBe(40)
    expect(child1.width).toBe(100)
    expect(child1.height).toBe(30)
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
