import { getYogaNode } from "../lib/renderable-layout.js"
import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable, RenderableEvents } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { LineNumberRenderable } from "../renderables/LineNumberRenderable.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { NativeStatus } from "../zig.js"

test.each([false, true])("raw cleanup failures preserve an earlier step failure=%s", async (stepFails) => {
  const { renderer } = await createTestRenderer({ width: 10, height: 2 })
  const rawFailure = new Error("raw cleanup failure")
  const calls: string[] = []
  class FailingBox extends BoxRenderable {
    protected override destroyOwnedResources(): void {
      this.runCleanup((run) => {
        if (stepFails)
          run(() => {
            throw undefined
          })
        run(() => {
          calls.push("continued")
        })
        throw rawFailure
      })
    }
    protected override destroySelf(): void {
      calls.push("released")
    }
  }
  try {
    const box = new FailingBox(renderer, { width: 1, height: 1 })
    renderer.root.add(box)
    const node = getYogaNode(box)
    let caught: unknown = "not thrown"
    try {
      box.destroy()
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(stepFails ? undefined : rawFailure)
    expect(calls).toEqual(["continued", "released"])
    expect(box.isDestroyed).toBe(true)
    expect(node.isFreed()).toBe(true)
    expect(renderer.root.getChildren()).toEqual([])
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test("destroys mixed native wrappers child-first after a child listener throws", async () => {
  let recursiveCalls = 0
  class RecursiveBox extends BoxRenderable {
    override destroyRecursively(): void {
      recursiveCalls++
      super.destroyRecursively()
    }
  }

  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24 })
  const owned: Renderable[] = []
  let throwingChild: TextRenderable | undefined
  const throwOnDestroy = () => {
    throw new Error("injected child destroy failure")
  }

  try {
    const survivor = new TextRenderable(renderer, { content: "before", wrapMode: "none", alignSelf: "flex-start" })
    renderer.root.add(survivor)
    const registered = new Set(Renderable.renderablesByNumber.keys())
    const selectionListeners = renderer.listenerCount("selection")
    const subtree = new BoxRenderable(renderer, { width: 30, height: 6 })
    renderer.root.add(subtree)
    owned.push(subtree)
    const custom = new RecursiveBox(renderer, { width: 30, height: 5 })
    subtree.add(custom)
    const scrollbox = new ScrollBoxRenderable(renderer, { width: 30, height: 5 })
    custom.add(scrollbox)
    throwingChild = new TextRenderable(renderer, { content: "first" })
    scrollbox.add(throwingChild)
    const textarea = new TextareaRenderable(renderer, { initialValue: "owned" })
    scrollbox.add(textarea)
    const target = new TextRenderable(renderer, { content: "first\nsecond" })
    const lineNumbers = new LineNumberRenderable(renderer, { target })
    scrollbox.add(lineNumbers)
    expect(throwingChild.parent).toBe(scrollbox.content)
    expect(scrollbox.getChildren()).toEqual([throwingChild, textarea, lineNumbers])
    expect(renderer.listenerCount("selection")).toBe(selectionListeners + 1)

    const destroyed = new Set<Renderable>()
    let destroyCount = 0
    let parentFirstCount = 0
    // Snapshot actual ownership before removal, including ScrollBox's hidden internal children.
    for (let index = 0; index < owned.length; index++) {
      const node = owned[index]
      const children = [...(Reflect.get(node, "_childrenInLayoutOrder") as Renderable[])]
      owned.push(...children)
      node.on(RenderableEvents.DESTROYED, () => {
        destroyCount++
        if (children.some((child) => !destroyed.has(child) || !child.isDestroyed || !getYogaNode(child).isFreed())) {
          parentFirstCount++
        }
        destroyed.add(node)
      })
    }
    const layoutNodes = owned.map((node) => getYogaNode(node))
    const scene = renderer.nativeScene!
    const nativeHandles = layoutNodes.map((node) => node._getSceneHandle(scene))
    expect(owned.includes(scrollbox.content)).toBe(true)
    expect(owned.filter((node) => node.parent === lineNumbers).length).toBe(2)
    expect(layoutNodes.every((node) => !node.isFreed())).toBe(true)
    throwingChild.on(RenderableEvents.DESTROYED, throwOnDestroy)
    await renderOnce()
    expect(captureCharFrame()).toContain("before")

    expect(() => subtree.destroyRecursively()).toThrow("injected child destroy failure")

    expect(destroyCount).toBe(owned.length)
    expect(destroyed.size).toBe(owned.length)
    expect(parentFirstCount).toBe(0)
    expect(recursiveCalls).toBe(1)
    expect(renderer.listenerCount("selection")).toBe(selectionListeners)
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
    expect(owned.every((node) => node.isDestroyed && node.parent === null)).toBe(true)
    expect(owned.every((node) => node.listenerCount(RenderableEvents.DESTROYED) === 0)).toBe(true)
    expect(layoutNodes.every((node) => node.isFreed())).toBe(true)
    for (const handle of nativeHandles) {
      assert.throws(() => scene.driver.renderLib.sceneGetLayout(scene.driver.context, handle), {
        status: NativeStatus.StaleHandle,
      })
    }
    expect(() => throwingChild!.plainText).toThrow("Native scene Yoga node is freed")
    expect(() => target.plainText).toThrow("Native scene Yoga node is freed")
    expect(() => textarea.editBuffer.setText("unreachable")).toThrow("EditBuffer is destroyed")
    expect(() => textarea.editorView.setWrapMode("none")).toThrow("EditorView is destroyed")
    subtree.destroyRecursively()
    expect(destroyCount).toBe(owned.length)
    expect(recursiveCalls).toBe(1)

    expect(getYogaNode(renderer.root).isFreed()).toBe(false)
    expect(survivor.isDestroyed).toBe(false)
    survivor.content = "still usable"
    await renderOnce()
    expect(survivor.width).toBe(12)
    expect(captureCharFrame()).toContain("still usable")
  } finally {
    throwingChild?.off(RenderableEvents.DESTROYED, throwOnDestroy)
    try {
      for (const node of owned) {
        if (!node.isDestroyed) node.destroyRecursively()
      }
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  }
})
