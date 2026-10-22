import { expect, test } from "bun:test"
import { RenderableEvents } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { LineNumberRenderable } from "../renderables/LineNumberRenderable.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test("destroys mixed native wrappers child-first after a child listener throws", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 24 })
  const throwOnDestroy = () => {
    throw new Error("injected child destroy failure")
  }
  let throwingChild: TextRenderable | undefined
  try {
    const survivor = new TextRenderable(renderer, { content: "before", wrapMode: "none", alignSelf: "flex-start" })
    renderer.root.add(survivor)
    const subtree = new BoxRenderable(renderer, { width: 30, height: 6 })
    renderer.root.add(subtree)
    const scrollbox = new ScrollBoxRenderable(renderer, { width: 30, height: 5 })
    subtree.add(scrollbox)
    throwingChild = new TextRenderable(renderer, { content: "first" })
    scrollbox.add(throwingChild)
    const textarea = new TextareaRenderable(renderer, { initialValue: "owned" })
    scrollbox.add(textarea)
    const target = new TextRenderable(renderer, { content: "first\nsecond" })
    scrollbox.add(new LineNumberRenderable(renderer, { target }))
    throwingChild.on(RenderableEvents.DESTROYED, throwOnDestroy)
    await renderOnce()
    expect(captureCharFrame()).toContain("before")

    expect(() => subtree.destroyRecursively()).toThrow("injected child destroy failure")

    expect(() => throwingChild!.plainText).toThrow()
    expect(() => target.plainText).toThrow()
    expect(() => textarea.editBuffer.setText("unreachable")).toThrow("EditBuffer is destroyed")
    expect(() => textarea.editorView.setWrapMode("none")).toThrow("EditorView is destroyed")
    expect(survivor.isDestroyed).toBe(false)
    survivor.content = "still usable"
    await renderOnce()
    expect(captureCharFrame()).toContain("still usable")
  } finally {
    throwingChild?.off(RenderableEvents.DESTROYED, throwOnDestroy)
    renderer.destroy()
    await renderer.closed
  }
})
