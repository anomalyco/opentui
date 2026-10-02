import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable, RenderableEvents } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { LineNumberRenderable } from "../renderables/LineNumberRenderable.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"

// Native-backed measurement wires renderables to native state (measure targets,
// Yoga measure funcs, handles). These tests lock the lifecycle behavior:
// destroying renderables must detach cleanly while the rest of the tree keeps
// measuring, including under create/layout/destroy churn.

let renderer: TestRenderer
let renderOnce: () => Promise<void>

beforeEach(async () => {
  ;({ renderer, renderOnce } = await createTestRenderer({ width: 80, height: 30 }))
})

afterEach(async () => {
  renderer.destroy()
  await renderer.closed
})

function maybeCollectGarbage(): void {
  const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun
  bun?.gc?.(false)
}

function expectSize(
  renderable: TextRenderable | TextareaRenderable,
  expected: { width: number; height: number },
): void {
  expect(renderable.width).toBeCloseTo(expected.width, 5)
  expect(renderable.height).toBeCloseTo(expected.height, 5)
}

describe("native-backed measurement lifecycle", () => {
  test("line-number setup failure after gutter construction releases listeners and ownership", () => {
    const target = new TextRenderable(renderer, { content: "owned" })
    renderer.root.add(target)
    const registered = new Set(Renderable.renderablesByNumber.keys())
    Object.defineProperty(target, "virtualLineCount", {
      get() {
        throw new Error("line info failed")
      },
    })
    expect(() => new LineNumberRenderable(renderer, { target })).toThrow("line info failed")
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
    expect(target.listenerCount("line-info-change")).toBe(0)
    expect(target.plainText).toBe("owned")
    target.destroy()
  })

  test.each(["target", "reentrant target", "owner", "gutter"])(
    "line-number %s teardown releases the gutter without remounting",
    (entry) => {
      const target = new TextRenderable(renderer, { content: "owned" })
      const replacement = new TextRenderable(renderer, { content: "new" })
      const lines = new LineNumberRenderable(renderer, { target })
      const gutter = lines.getChildren().find((node) => node !== target)!
      if (entry === "reentrant target") target.on(RenderableEvents.DESTROYED, () => lines.clearTarget())
      if (entry === "owner") gutter.on(RenderableEvents.DESTROYED, () => lines.add(replacement))
      try {
        if (entry === "owner") lines.destroy()
        else if (entry === "gutter") gutter.destroy()
        else target.destroy()
        expect(target.parent).toBeNull()
        expect(target.listenerCount("line-info-change")).toBe(0)
        expect(lines.getChildrenCount()).toBe(0)
        expect(target.isDestroyed).toBe(entry === "target" || entry === "reentrant target")
        expect(gutter.isFreed()).toBe(true)
        expect(replacement.parent).toBeNull()
        expect(replacement.listenerCount("line-info-change")).toBe(0)
      } finally {
        lines.destroy()
        target.destroy()
        replacement.destroy()
      }
    },
  )

  test.each([false, true])("recursive teardown defers parent reentry and preserves the child error=%s", (throws) => {
    const parent = new BoxRenderable(renderer, {})
    const first = new TextRenderable(renderer, { content: "first" })
    const second = new TextRenderable(renderer, { content: "second" })
    renderer.root.add(parent)
    parent.add(first)
    parent.add(second)
    const events: string[] = []
    const failure = new Error("child failed")
    first.on(RenderableEvents.DESTROYED, () => {
      events.push("first")
      parent.destroy()
      parent.destroyRecursively()
      if (throws) throw failure
    })
    second.on(RenderableEvents.DESTROYED, () => events.push("second"))
    parent.on(RenderableEvents.DESTROYED, () => {
      events.push("parent")
      expect([first.isFreed(), second.isFreed(), parent.isFreed()]).toEqual([true, true, false])
      if (throws) throw new Error("later parent failure")
    })
    if (throws)
      assert.throws(
        () => parent.destroyRecursively(),
        (error) => error === failure,
      )
    else parent.destroyRecursively()
    expect(events).toEqual(["first", "second", "parent"])
    expect(parent.isFreed()).toBe(true)
  })

  test("destroying a text renderable keeps sibling measurement working", async () => {
    const parent = new BoxRenderable(renderer, { width: 40, flexDirection: "column", alignItems: "flex-start" })
    const first = new TextRenderable(renderer, { content: "AAAAA", wrapMode: "none", alignSelf: "flex-start" })
    const second = new TextRenderable(renderer, { content: "BBBBBBBBBB", wrapMode: "none", alignSelf: "flex-start" })
    parent.add(first)
    parent.add(second)
    renderer.root.add(parent)
    await renderOnce()

    expectSize(first, { width: 5, height: 1 })
    expectSize(second, { width: 10, height: 1 })

    first.destroy()
    await renderOnce()
    expectSize(second, { width: 10, height: 1 })

    second.content = "CCC"
    await renderOnce()
    expectSize(second, { width: 3, height: 1 })
  })

  test("destroying a textarea keeps sibling measurement working", async () => {
    const parent = new BoxRenderable(renderer, { width: 40, flexDirection: "column", alignItems: "flex-start" })
    const first = new TextareaRenderable(renderer, { initialValue: "AAAAA", wrapMode: "none", alignSelf: "flex-start" })
    const second = new TextareaRenderable(renderer, {
      initialValue: "BBBBBBBBBB",
      wrapMode: "none",
      alignSelf: "flex-start",
    })
    parent.add(first)
    parent.add(second)
    renderer.root.add(parent)
    await renderOnce()

    expectSize(first, { width: 5, height: 1 })
    expectSize(second, { width: 10, height: 1 })

    first.destroy()
    await renderOnce()
    expectSize(second, { width: 10, height: 1 })

    second.setText("CCC")
    await renderOnce()
    expectSize(second, { width: 3, height: 1 })
  })

  test("survives create/layout/destroy churn of native-backed renderables", async () => {
    for (let round = 0; round < 20; round++) {
      const container = new BoxRenderable(renderer, { flexDirection: "column", alignItems: "flex-start" })
      renderer.root.add(container)

      const texts: TextRenderable[] = []
      const textareas: TextareaRenderable[] = []
      for (let index = 0; index < 16; index++) {
        const width = 1 + ((round + index) % 20)
        const text = new TextRenderable(renderer, {
          content: "X".repeat(width),
          wrapMode: "none",
          alignSelf: "flex-start",
        })
        texts.push(text)
        container.add(text)
      }
      for (let index = 0; index < 6; index++) {
        const width = 1 + ((round + index) % 15)
        const textarea = new TextareaRenderable(renderer, {
          initialValue: "Y".repeat(width),
          wrapMode: "none",
          alignSelf: "flex-start",
        })
        textareas.push(textarea)
        container.add(textarea)
      }

      await renderOnce()

      for (const [index, text] of texts.entries()) {
        expectSize(text, { width: 1 + ((round + index) % 20), height: 1 })
      }
      for (const [index, textarea] of textareas.entries()) {
        expectSize(textarea, { width: 1 + ((round + index) % 15), height: 1 })
      }

      // Alternate destroy orders: children-first and recursive subtree destroy.
      if (round % 2 === 0) {
        for (const text of texts) text.destroy()
        for (const textarea of textareas) textarea.destroy()
        container.destroy()
      } else {
        container.destroyRecursively()
      }

      if (round % 5 === 0) maybeCollectGarbage()
      await renderOnce()
    }
  })
})
