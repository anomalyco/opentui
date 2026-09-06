import { getYogaNode } from "../lib/renderable-layout.js"
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable, RenderableEvents } from "../Renderable.js"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CodeRenderable } from "../renderables/Code.js"
import { EditBufferRenderableEvents } from "../renderables/EditBufferRenderable.js"
import { InputRenderable, InputRenderableEvents } from "../renderables/Input.js"
import { LineNumberRenderable } from "../renderables/LineNumberRenderable.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { TextRenderable } from "../renderables/Text.js"
import type { StyledText } from "../lib/styled-text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { NativeStatus, resolveRenderLib } from "../zig.js"

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
  test.each(["id", "width"])("rejects an early %s getter before acquiring native ownership", (property) => {
    const create = spyOn(resolveRenderLib(), "sceneCreateNode")
    const options = Object.defineProperty({}, property, {
      get() {
        throw new Error("early construction failure")
      },
    })
    try {
      expect(() => new TextRenderable(renderer, options)).toThrow("early construction failure")
      expect(create).not.toHaveBeenCalled()
    } finally {
      create.mockRestore()
    }
  })

  test.each([undefined, new Error("construction failed")])(
    "constructor abort and rollback preserve the original error %s after cleanup fails",
    (failure) => {
      const host = resolveRenderLib().getYogaHost()
      const registered = new Set(Renderable.renderablesByNumber.keys())
      for (const [Constructor, property] of [
        [BoxRenderable, "backgroundColor"],
        [TextRenderable, "content"],
      ] as const) {
        const options = Object.defineProperty({}, property, {
          get() {
            host.invokeCallback(() => {
              throw new Error("callback failed")
            })
            throw failure
          },
        })
        assert.throws(
          () => new Constructor(renderer, options),
          (error) => error === failure,
        )
        expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
        host.throwCallbackError()
      }
    },
  )

  test.each([
    "minWidth",
    "backgroundColor",
    "text",
    "textarea",
    "input",
    "attachment",
    "code",
    "syntaxStyle",
    "codeAttachment",
  ])("constructor rollback at %s releases ownership despite a latched callback error", (step) => {
    const lib = resolveRenderLib()
    const host = lib.getYogaHost()
    const registered = new Set(Renderable.renderablesByNumber.keys())
    const owners = [...renderer.nativeScene.getRenderables()]
    const style = SyntaxStyle.create(renderer.nativeScene)
    const released = spyOn(lib, "sceneDestroyNode")
    const failure = new Error("construction failed")
    let failed: Renderable | undefined
    const fail = (): never => {
      failed = [...Renderable.renderablesByNumber.values()].find((node) => !registered.has(node.num))
      host.invokeCallback(() => {
        throw new Error("earlier callback failed")
      })
      throw failure
    }
    class PartialText extends TextRenderable {
      override destroy(): void {
        throw new Error("uninitialized subclass destroy")
      }
    }
    class PartialTextarea extends TextareaRenderable {
      override destroy(): void {
        throw new Error("uninitialized subclass destroy")
      }
    }
    class PartialInput extends InputRenderable {
      override get plainText(): string {
        return fail()
      }
    }
    const attach = spyOn(lib, step === "codeAttachment" ? "sceneSetTextView" : "sceneSetEditorView")
    const createStyle = spyOn(SyntaxStyle, "create")
    try {
      if (step === "attachment" || step === "codeAttachment") attach.mockImplementation(fail)
      if (step === "syntaxStyle") createStyle.mockImplementation(fail)
      expect(() => {
        if (step === "text")
          return new PartialText(renderer, {
            get content() {
              return fail()
            },
          })
        if (step === "textarea")
          return new PartialTextarea(renderer, {
            placeholder: {
              get chunks() {
                return fail()
              },
            } as unknown as StyledText,
          })
        if (step === "input") return new PartialInput(renderer, {})
        if (step === "attachment") return new TextareaRenderable(renderer, {})
        if (step === "code" || step === "syntaxStyle" || step === "codeAttachment")
          return new CodeRenderable(renderer, {
            syntaxStyle: style,
            get content() {
              return step === "code" ? fail() : "owned"
            },
          })
        return new BoxRenderable(renderer, Object.defineProperty({}, step, { get: fail }))
      }).toThrow(failure)
      expect(failed?.isDestroyed).toBe(true)
      expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
      expect([...renderer.nativeScene.getRenderables()]).toEqual(owners)
      expect(released).toHaveBeenCalledTimes(1)
      const [context, handle] = released.mock.calls[0]
      assert.throws(() => lib.sceneGetLayout(context, handle), { status: NativeStatus.StaleHandle })
      if (failed instanceof TextareaRenderable) {
        const { editBuffer, editorView } = failed
        expect(() => editBuffer.getText()).toThrow("destroyed")
        expect(() => editorView.getVirtualLineCount()).toThrow("destroyed")
        expect(editBuffer.listenerCount("content-changed")).toBe(0)
      }
      if (failed instanceof CodeRenderable) {
        const { textBuffer, textBufferView } = failed as unknown as {
          textBuffer: TextBuffer
          textBufferView: TextBufferView
        }
        expect(() => textBuffer.getPlainText()).toThrow("destroyed")
        expect(() => textBufferView.getVirtualLineCount()).toThrow("destroyed")
        const ownedStyle = Reflect.get(failed, "_textBufferSyntaxStyle") as SyntaxStyle | undefined
        if (ownedStyle) expect(() => ownedStyle.getStyleCount()).toThrow("destroyed")
      }
      expect(style.getStyleCount()).toBe(0)
      host.throwCallbackError()
    } finally {
      attach.mockRestore()
      createStyle.mockRestore()
      released.mockRestore()
      if (failed && !failed.isDestroyed) Renderable.prototype.destroy.call(failed)
      style.destroy()
    }
  })

  test.each(["callback", "latched"])("rejected %s destroy preserves inline text, traits and focus", async (entry) => {
    const text = new TextRenderable(renderer, { alignSelf: "flex-start", wrapMode: "none" })
    text.add("owned")
    const input = new InputRenderable(renderer, { value: "owned" })
    renderer.root.add(text)
    renderer.root.add(input)
    input.traits = { status: "active" }
    input.focus()
    const children = [...text.textNode.children]
    const host = resolveRenderLib().getYogaHost()
    const events: string[] = []
    input.on(EditBufferRenderableEvents.TRAITS_CHANGED, () => events.push("traits"))
    input.on(RenderableEvents.BLURRED, () => events.push("blurred"))
    input.on(RenderableEvents.DESTROYED, () => events.push("destroyed"))
    for (const node of [text, input]) {
      if (entry === "callback") {
        host.invokeCallback(() => node.destroy())
        expect(() => host.throwCallbackError()).toThrow("Cannot mutate Yoga during a callback")
      } else {
        const failure = new Error("earlier callback failed")
        host.invokeCallback(() => {
          throw failure
        })
        expect(() => node.destroy()).toThrow(failure)
      }
      expect(node.isDestroyed).toBe(false)
      expect(getYogaNode(node).isFreed()).toBe(false)
    }
    expect(text.textNode.children).toEqual(children)
    expect(input.traits).toEqual({ status: "active" })
    expect(input.focused).toBe(true)
    expect(renderer.currentFocusedRenderable).toBe(input)
    expect(events).toEqual([])
    expect(input.plainText).toBe("owned")
    text.add(" again")
    input.value = "still usable"
    await renderOnce()
    expectSize(text, { width: 11, height: 1 })
    text.destroy()
    expect(text.textNode.children).toEqual([])
    input.destroy()
    expect(events).toEqual(["traits", "blurred", "destroyed"])
  })

  test("rejected code destroy preserves highlighting; accepted destroy cancels it", async () => {
    const syntaxStyle = SyntaxStyle.create(renderer.nativeScene)
    const client = new MockTreeSitterClient()
    const highlighted: string[] = []
    const code = new CodeRenderable(renderer, {
      content: "const owned = true",
      filetype: "typescript",
      syntaxStyle,
      treeSitterClient: client,
      onHighlight: (highlights, context) => {
        highlighted.push(context.content)
        return highlights
      },
    })
    renderer.root.add(code)
    try {
      await renderOnce()
      const pending = code.highlightingDone
      expect(code.isHighlighting).toBe(true)
      const host = resolveRenderLib().getYogaHost()
      host.invokeCallback(() => code.destroy())
      expect(() => host.throwCallbackError()).toThrow("Cannot mutate Yoga during a callback")
      expect(code.isDestroyed).toBe(false)
      expect(code.highlightingDone).toBe(pending)
      client.resolveAllHighlightOnce()
      await pending
      expect(highlighted).toEqual([code.content])
      code.content = "const next = true"
      await renderOnce()
      const cancelled = code.highlightingDone
      code.on(RenderableEvents.DESTROYED, () => expect(code.isHighlighting).toBe(false))
      code.destroy()
      client.resolveAllHighlightOnce()
      await cancelled
      expect(highlighted).toHaveLength(1)
    } finally {
      code.destroy()
      await client.destroy()
      syntaxStyle.destroy()
    }
  })

  test.each(["destroy", "destroyRecursively"] as const)(
    "input %s releases measurement after reentrant events",
    (method) => {
      const input = new InputRenderable(renderer, { value: "before" })
      renderer.root.add(input)
      input.traits = { status: "active" }
      input.focus()
      input.value = "after"
      input.setMeasureProvider(() => ({ width: 7, height: 1 }))
      const node = getYogaNode(input)
      const scene = renderer.nativeScene
      const handle = node._getSceneHandle(scene)
      const events: string[] = []
      for (const [event, name] of [
        [EditBufferRenderableEvents.TRAITS_CHANGED, "traits"],
        [InputRenderableEvents.CHANGE, "change"],
      ])
        input.on(event, () => {
          events.push(name)
          expect(input.isDestroyed).toBe(false)
          expect(node.hasMeasureFunc()).toBe(true)
          expect(input.parent).toBe(renderer.root)
          input.destroy()
          input.destroyRecursively()
          expect(input.value).toBe("after")
        })
      input.on(RenderableEvents.BLURRED, () => events.push("blurred"))
      input.on(RenderableEvents.DESTROYED, () => {
        events.push("destroyed")
        expect(input.isDestroyed).toBe(true)
        expect(() => input.editBuffer.getText()).toThrow("destroyed")
        expect(() => input.editorView.getVirtualLineCount()).toThrow("destroyed")
      })
      const release = spyOn(scene.driver.renderLib, "sceneDestroyNode")
      try {
        input[method]()
        expect(events).toEqual(["traits", "change", "blurred", "destroyed"])
        expect(release).toHaveBeenCalledTimes(1)
        expect(node.isFreed()).toBe(true)
        assert.throws(() => scene.driver.renderLib.sceneHasMeasure(scene.driver.context, handle), {
          status: NativeStatus.StaleHandle,
        })
        expect(
          Reflect.get(scene.driver.renderLib, "sceneMeasures").get(scene.driver.context)?.nodes.has(handle.slot),
        ).not.toBe(true)
      } finally {
        release.mockRestore()
      }
    },
  )

  test.each(["returns", "throws"])(
    "upward recursive cleanup waits for an input CHANGE listener that %s",
    (behavior) => {
      const ancestor = new BoxRenderable(renderer, { focusable: true })
      const parent = new BoxRenderable(renderer, {})
      const input = new InputRenderable(renderer, { value: "before" })
      renderer.root.add(ancestor)
      ancestor.add(parent)
      parent.add(input)
      input.focus()
      input.value = "after"
      const events: string[] = []
      const failure = new Error("CHANGE failed")
      input.on(InputRenderableEvents.CHANGE, () => {
        events.push("change")
        parent.destroyRecursively()
        events.push("change-return")
        if (behavior === "throws") throw failure
      })
      input.on(RenderableEvents.BLURRED, () => events.push("blurred"))
      input.on(RenderableEvents.DESTROYED, () => events.push("input"))
      parent.on(RenderableEvents.DESTROYED, () => {
        events.push("parent")
        expect([input.isDestroyed, getYogaNode(input).isFreed(), input.focused, ancestor.hasFocusedDescendant]).toEqual(
          [true, true, false, false],
        )
      })
      if (behavior === "throws") expect(() => input.destroy()).toThrow(failure)
      else input.destroy()
      expect(events).toEqual(
        behavior === "throws"
          ? ["change", "change-return", "input", "blurred", "parent"]
          : ["change", "change-return", "blurred", "input", "parent"],
      )
      expect(getYogaNode(parent).isFreed()).toBe(true)
      expect(ancestor.isDestroyed).toBe(false)
    },
  )

  test("traits and removal failures do not interrupt editor cleanup or replace the first error", () => {
    const textarea = new TextareaRenderable(renderer, { initialValue: "owned" })
    renderer.root.add(textarea)
    textarea.focus()
    textarea.traits = { status: "active" }
    const failure = new Error("traits failed")
    const events: string[] = []
    textarea.on(EditBufferRenderableEvents.TRAITS_CHANGED, () => {
      textarea.destroyRecursively()
      expect(textarea.plainText).toBe("owned")
      throw failure
    })
    textarea.on(RenderableEvents.BLURRED, () => events.push("blurred"))
    textarea.on(RenderableEvents.DESTROYED, () => events.push("destroyed"))
    const remove = spyOn(textarea as unknown as { onRemove(): void }, "onRemove").mockImplementation(() => {
      throw new Error("later removal failure")
    })
    try {
      assert.throws(
        () => textarea.destroy(),
        (error) => error === failure,
      )
      expect(events).toEqual(["blurred", "destroyed"])
      expect(remove).toHaveBeenCalledTimes(1)
      expect(getYogaNode(textarea).isFreed()).toBe(true)
      expect(() => textarea.editBuffer.getText()).toThrow("destroyed")
      expect(() => textarea.editorView.getVirtualLineCount()).toThrow("destroyed")
      resolveRenderLib().getYogaHost().throwCallbackError()
    } finally {
      remove.mockRestore()
    }
  })

  test.each(["view", "detach", "destroySelf", "listeners", "live"])(
    "text teardown continues after %s failure",
    (step) => {
      const style = SyntaxStyle.create(renderer.nativeScene)
      const parent = new BoxRenderable(renderer, {})
      const text = new CodeRenderable(renderer, { content: "owned", syntaxStyle: style, live: true })
      renderer.root.add(parent)
      parent.add(text)
      const internals = text as unknown as {
        textBuffer: TextBuffer
        textBufferView: TextBufferView
        destroySelf(): void
      }
      const failure = new Error("first cleanup failure")
      const fail = () => {
        throw step === "view" || step === "live" ? failure : new Error("later cleanup failure")
      }
      const dropLive = renderer.dropLive.bind(renderer)
      const failing =
        step === "view"
          ? spyOn(internals.textBufferView, "destroy").mockImplementation(fail)
          : step === "detach"
            ? spyOn(parent, "remove").mockImplementation(fail)
            : step === "destroySelf"
              ? spyOn(internals, "destroySelf").mockImplementation(fail)
              : step === "listeners"
                ? spyOn(text, "removeAllListeners").mockImplementation(fail)
                : spyOn(renderer, "dropLive").mockImplementation(() => {
                    dropLive()
                    fail()
                  })
      let notified = false
      text.on(RenderableEvents.DESTROYED, () => {
        notified = true
        expect(text.isDestroyed).toBe(true)
        if (step === "live") return
        throw step === "view" ? new Error("later listener failure") : failure
      })
      try {
        assert.throws(
          () => text.destroy(),
          (error) => error === failure,
        )
        expect(notified).toBe(true)
        expect(text.parent).toBeNull()
        expect(parent.getChildrenCount()).toBe(0)
        expect(parent.liveCount).toBe(0)
        expect(getYogaNode(text).isFreed()).toBe(true)
        expect(() => internals.textBuffer.getPlainText()).toThrow("destroyed")
        text.destroy()
      } finally {
        failing.mockRestore()
        internals.textBufferView.destroy()
        text.removeAllListeners()
        style.destroy()
      }
    },
  )

  test("cleanup clears ancestor focus even when the renderer blur listener throws", () => {
    const ancestor = new BoxRenderable(renderer, { focusable: true })
    const input = new InputRenderable(renderer, { value: "owned" })
    renderer.root.add(ancestor)
    ancestor.add(input)
    input.focus()
    const failure = new Error("renderer blur failed")
    const onFocus = (editor: unknown) => {
      if (editor === null) throw failure
    }
    renderer.on(CliRenderEvents.FOCUSED_EDITOR, onFocus)
    try {
      expect(() => input.destroy()).toThrow(failure)
      expect(getYogaNode(input).isFreed()).toBe(true)
      expect(renderer.currentFocusedRenderable).toBeNull()
      expect(input.focused).toBe(false)
      expect(ancestor.hasFocusedDescendant).toBe(false)
    } finally {
      renderer.off(CliRenderEvents.FOCUSED_EDITOR, onFocus)
    }
  })

  test("shallow destruction preserves focus moved to a surviving branch", () => {
    const ancestor = new BoxRenderable(renderer, { focusable: true })
    const parent = new BoxRenderable(renderer, {})
    const survivor = new BoxRenderable(renderer, {})
    const input = new InputRenderable(renderer, { value: "kept" })
    renderer.root.add(ancestor)
    ancestor.add(parent)
    ancestor.add(survivor)
    parent.add(input)
    input.focus()
    parent.on(RenderableEvents.DESTROYED, () => survivor.add(input))
    parent.destroy()
    expect(input.parent).toBe(survivor)
    expect(input.isDestroyed).toBe(false)
    expect(renderer.currentFocusedRenderable).toBe(input)
    expect(survivor.hasFocusedDescendant).toBe(true)
    expect(ancestor.hasFocusedDescendant).toBe(true)
    input.blur()
    expect(ancestor.hasFocusedDescendant).toBe(false)
  })

  test.each(["target", "gutter"])("line-number %s cannot be reparented around its removal policy", async (kind) => {
    const target = new TextRenderable(renderer, { content: "owned" })
    const lines = new LineNumberRenderable(renderer, { target })
    const other = new BoxRenderable(renderer, { position: "absolute", left: 40, top: 10, width: 10, height: 2 })
    const anchor = new BoxRenderable(renderer, {})
    renderer.root.add(lines)
    renderer.root.add(other)
    other.add(anchor)
    const children = lines.getChildren()
    const child = kind === "target" ? target : children.find((node) => node !== target)!
    await renderOnce()
    const before = renderer.nativeScene.getLayout(getYogaNode(child))
    for (const move of [() => other.add(child), () => other.insertBefore(child, anchor)]) {
      expect(move).toThrow(`LineNumberRenderable: Cannot remove ${kind} directly.`)
      expect(lines.getChildren()).toEqual(children)
      expect(other.getChildren()).toEqual([anchor])
      expect(child.parent).toBe(lines)
      expect(target.listenerCount("line-info-change")).toBe(1)
      await renderOnce()
      expect(renderer.nativeScene.getLayout(getYogaNode(child))).toEqual(before)
    }
  })

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

  test("custom removal runs only after callback admission and is not rolled back by native rejection", () => {
    let removed = 0
    class Parent extends BoxRenderable {
      override remove(child: Renderable): void {
        super.remove(child)
        removed++
      }
    }
    const previous = new Parent(renderer, {})
    const target = new BoxRenderable(renderer, {})
    const child = new BoxRenderable(renderer, {})
    renderer.root.add(previous)
    renderer.root.add(target)
    previous.add(child)
    previous.add(child)
    expect(removed).toBe(0)
    const lib = resolveRenderLib()
    lib.getYogaHost().invokeCallback(() => target.add(child))
    expect(() => lib.getYogaHost().throwCallbackError()).toThrow("Cannot mutate Yoga during a callback")
    expect(removed).toBe(0)
    const move = lib.sceneMoveNode.bind(lib)
    const reject = spyOn(lib, "sceneMoveNode").mockImplementation((context, node, parent, index) => {
      if (parent) throw new Error("placement failed")
      move(context, node, parent, index)
    })
    try {
      expect(() => target.add(child)).toThrow("placement failed")
      expect(removed).toBe(1)
      expect(child.parent).toBeNull()
      expect(previous.getChildren()).toEqual([])
      reject.mockRestore()
      target.add(child)
      expect(removed).toBe(1)
    } finally {
      reject.mockRestore()
      child.destroy()
    }
  })

  test.each(["add", "insertBefore"] as const)("%s revalidates placement after custom parent removal", (method) => {
    for (const change of ["parent", "destination", "child", "removed anchor", "destroyed anchor", "reordered anchor"]) {
      const other = new BoxRenderable(renderer, { paddingTop: 2 })
      const anchor = new BoxRenderable(renderer, { height: 1 })
      let removals = 0
      class Parent extends BoxRenderable {
        override remove(child: Renderable): void {
          super.remove(child)
          removals++
          if (change === "parent") this.destroy()
          if (change === "destination") other.destroyRecursively()
          if (change === "child") child.destroy()
          if (change === "removed anchor") other.remove(anchor)
          if (change === "destroyed anchor") anchor.destroy()
          if (change === "reordered anchor") other.add(anchor)
        }
      }
      const previous = new Parent(renderer, { height: 1 })
      const child = new BoxRenderable(renderer, { height: 1 })
      const sibling = new BoxRenderable(renderer, { height: 1 })
      renderer.root.add(other)
      other.add(previous)
      other.add(anchor)
      other.add(sibling)
      previous.add(child)
      try {
        const index = method === "add" ? other.add(child) : other.insertBefore(child, anchor)
        const rejected =
          change === "destination" ||
          change === "child" ||
          (method === "insertBefore" && change.endsWith("anchor") && change !== "reordered anchor")
        expect(removals).toBe(1)
        expect(child.parent).toBe(rejected ? null : other)
        if (rejected) expect(index).toBe(-1)
        else {
          const siblings = other.getChildren()
          expect(siblings[index]).toBe(child)
          expect(index).toBe(method === "add" ? siblings.length - 1 : siblings.indexOf(anchor) - 1)
          renderer.nativeScene.measureSnapshot(other)
          expect(getYogaNode(child).getComputedTop()).toBe(index + 2)
        }
        if (change === "parent") expect(previous.isDestroyed).toBe(true)
        else expect(previous.getChildrenCount()).toBe(0)
      } finally {
        child.destroy()
        anchor.destroy()
        other.destroyRecursively()
      }
    }
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
        expect(getYogaNode(gutter).isFreed()).toBe(true)
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
      expect([getYogaNode(first).isFreed(), getYogaNode(second).isFreed(), getYogaNode(parent).isFreed()]).toEqual([
        true,
        true,
        false,
      ])
      if (throws) throw new Error("later parent failure")
    })
    if (throws)
      assert.throws(
        () => parent.destroyRecursively(),
        (error) => error === failure,
      )
    else parent.destroyRecursively()
    expect(events).toEqual(["first", "second", "parent"])
    expect(getYogaNode(parent).isFreed()).toBe(true)
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
