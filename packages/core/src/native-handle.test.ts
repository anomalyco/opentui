import { describe, expect, test } from "bun:test"
import { OptimizedBuffer } from "./buffer.js"
import { RGBA } from "./lib/RGBA.js"
import { TextBuffer } from "./text-buffer.js"
import { TextBufferView } from "./text-buffer-view.js"
import { EditBuffer } from "./edit-buffer.js"
import { EditorView } from "./editor-view.js"
import { SyntaxStyle } from "./syntax-style.js"
import type { Pointer } from "./platform/ffi.js"
import Yoga from "./yoga.js"
import {
  NativeMeasureTargetKind,
  resolveRenderLib,
  setRenderLibPath,
  type OptimizedBufferHandle,
  type EmbeddedTerminalHandle,
  type RendererHandle,
  type TextBufferHandle,
} from "./zig.js"

describe("native handles", () => {
  test("render library path cannot change after native use", () => {
    resolveRenderLib()
    expect(() => setRenderLibPath("/tmp/opentui-unused-native-library.so")).toThrow(
      "setRenderLibPath() must be called before resolveRenderLib()",
    )
  })

  test("renderer calls after destroy are rejected safely", () => {
    const lib = resolveRenderLib()
    const renderer = lib.createRenderer(4, 3, { bufferedOutput: "memory" })
    expect(renderer).toBeTruthy()
    const rendererHandle = renderer as RendererHandle
    const current = lib.getCurrentBuffer(rendererHandle)
    const currentHandle = current.ptr

    lib.destroyRenderer(rendererHandle)
    lib.setCursorPosition(rendererHandle, 1, 1, true)
    lib.destroyRenderer(rendererHandle)

    expect(lib.getBufferWidth(currentHandle)).toBe(0)

    const second = lib.createRenderer(4, 3, { bufferedOutput: "memory" }) as RendererHandle
    expect(second).toBeTruthy()
    const before = lib.getCursorState(second)
    lib.setCursorPosition(rendererHandle, 2, 2, true)
    expect(lib.getCursorState(second).x).toBe(before.x)
    expect(lib.getCursorState(second).y).toBe(before.y)
    lib.destroyRenderer(second)
  })

  test("buffer stale and wrong-kind handles are rejected", () => {
    const lib = resolveRenderLib()
    const buffer = OptimizedBuffer.create(4, 3, "unicode")
    expect(buffer.buffers.char.length).toBe(12)
    const bufferHandle = buffer.ptr
    buffer.destroy()
    expect(() => buffer.buffers).toThrow()
    expect(() => buffer.fillRect(0, 0, 1, 1, RGBA.fromValues(1, 0, 0, 1))).toThrow("is destroyed")

    expect(lib.getBufferWidth(bufferHandle)).toBe(0)
    lib.destroyOptimizedBuffer(bufferHandle)

    const renderer = lib.createRenderer(4, 3, { bufferedOutput: "memory" }) as RendererHandle
    expect(lib.getBufferWidth(renderer as unknown as OptimizedBufferHandle)).toBe(0)
    lib.destroyRenderer(renderer)
  })

  test("embedded terminal stale and wrong-kind handles are rejected", () => {
    const lib = resolveRenderLib()
    const terminal = lib.createEmbeddedTerminal({ cols: 10, rows: 2 })
    lib.destroyEmbeddedTerminal(terminal)
    lib.destroyEmbeddedTerminal(terminal)
    expect(() => lib.embeddedTerminalWrite(terminal, "stale")).toThrow("invalid value or handle")

    const renderer = lib.createRenderer(4, 3, { bufferedOutput: "memory" }) as RendererHandle
    expect(() => lib.embeddedTerminalWrite(renderer as unknown as EmbeddedTerminalHandle, "wrong kind")).toThrow(
      "invalid value or handle",
    )
    lib.destroyRenderer(renderer)
  })

  test("text, view, edit, editor, and syntax stale handles are rejected", () => {
    const lib = resolveRenderLib()

    const textBuffer = TextBuffer.create("unicode")
    const textHandle = textBuffer.ptr
    const textView = TextBufferView.create(textBuffer)
    const textViewHandle = textView.ptr
    textView.destroy()
    expect(lib.textBufferViewGetVirtualLineCount(textViewHandle)).toBe(0)
    textBuffer.destroy()
    expect(lib.textBufferGetLength(textHandle)).toBe(0)

    const editBuffer = EditBuffer.create("unicode")
    const editHandle = editBuffer.ptr
    const borrowedTextHandle = lib.editBufferGetTextBuffer(editHandle)
    const editorView = EditorView.create(editBuffer, 10, 4)
    const editorHandle = editorView.ptr
    const borrowedViewHandle = lib.editorViewGetTextBufferView(editorHandle)
    editorView.destroy()
    expect(lib.textBufferViewGetVirtualLineCount(borrowedViewHandle)).toBe(0)
    editBuffer.destroy()
    expect(lib.editBufferGetId(editHandle)).toBe(0)
    expect(lib.textBufferGetLength(borrowedTextHandle)).toBe(0)

    const style = SyntaxStyle.create()
    const styleHandle = style.ptr
    style.destroy()
    expect(lib.syntaxStyleGetStyleCount(styleHandle)).toBe(0)

    expect(lib.textBufferGetLength(editHandle as unknown as TextBufferHandle)).toBe(0)
  })

  test("owned text buffer destroys child views", () => {
    const lib = resolveRenderLib()
    const textBuffer = TextBuffer.create("unicode")
    const textView = TextBufferView.create(textBuffer)
    const textViewHandle = textView.ptr

    textBuffer.destroy()

    expect(lib.textBufferViewGetVirtualLineCount(textViewHandle)).toBe(0)
  })

  test("borrowed edit buffer text handle cannot own text buffer views", () => {
    const lib = resolveRenderLib()
    const editBuffer = EditBuffer.create("unicode")
    const editHandle = editBuffer.ptr
    const borrowedTextHandle = lib.editBufferGetTextBuffer(editHandle)

    expect(() => lib.createTextBufferView(borrowedTextHandle)).toThrow("Failed to create TextBufferView")

    editBuffer.destroy()
    expect(lib.textBufferGetLength(borrowedTextHandle)).toBe(0)
  })
})

describe("native renderable measure target contract", () => {
  test("rejects null nodes, unknown kinds, and stale target handles", () => {
    const lib = resolveRenderLib()
    const textBuffer = TextBuffer.create("unicode")
    const textView = TextBufferView.create(textBuffer)
    const node = Yoga.Node.createForOpenTUI()
    const renderable = lib.createNativeRenderable()

    try {
      expect(lib.nativeRenderableAttachYogaNode(renderable, 0 as unknown as Pointer)).toBe(false)
      expect(lib.nativeRenderableAttachYogaNode(renderable, node.ptr)).toBe(true)
      expect(lib.yogaNodeHasMeasureFunc(node.ptr)).toBe(false)

      expect(
        lib.nativeRenderableSetMeasureTarget(renderable, NativeMeasureTargetKind.TextBufferView, textView.ptr),
      ).toBe(true)
      expect(lib.yogaNodeHasMeasureFunc(node.ptr)).toBe(true)

      // Unknown kinds are rejected and leave the current target in place.
      expect(
        lib.nativeRenderableSetMeasureTarget(renderable, 999 as unknown as NativeMeasureTargetKind, textView.ptr),
      ).toBe(false)
      expect(lib.yogaNodeHasMeasureFunc(node.ptr)).toBe(true)

      // Clear the target before destroying the view: a native renderable must
      // never keep measuring a destroyed view (renderables enforce this by
      // destroying the native renderable before their views).
      expect(lib.nativeRenderableSetMeasureTarget(renderable, NativeMeasureTargetKind.None, 0)).toBe(true)
      expect(lib.yogaNodeHasMeasureFunc(node.ptr)).toBe(false)

      const staleViewHandle = textView.ptr
      textView.destroy()
      expect(
        lib.nativeRenderableSetMeasureTarget(renderable, NativeMeasureTargetKind.TextBufferView, staleViewHandle),
      ).toBe(false)
      expect(lib.yogaNodeHasMeasureFunc(node.ptr)).toBe(false)
    } finally {
      lib.destroyNativeRenderable(renderable)
      node.free()
      textView.destroy()
      textBuffer.destroy()
    }
  })

  test("kind None clears the measure target", () => {
    const lib = resolveRenderLib()
    const editBuffer = EditBuffer.create("unicode")
    const editorView = EditorView.create(editBuffer, 10, 4)
    const node = Yoga.Node.createForOpenTUI()
    const renderable = lib.createNativeRenderable()

    try {
      expect(lib.nativeRenderableAttachYogaNode(renderable, node.ptr)).toBe(true)
      expect(lib.nativeRenderableSetMeasureTarget(renderable, NativeMeasureTargetKind.EditorView, editorView.ptr)).toBe(
        true,
      )
      expect(lib.yogaNodeHasMeasureFunc(node.ptr)).toBe(true)

      expect(lib.nativeRenderableSetMeasureTarget(renderable, NativeMeasureTargetKind.None, 0)).toBe(true)
      expect(lib.yogaNodeHasMeasureFunc(node.ptr)).toBe(false)
    } finally {
      lib.destroyNativeRenderable(renderable)
      node.free()
      editorView.destroy()
      editBuffer.destroy()
    }
  })

  test("destroying a native renderable clears the node measure func and invalidates the handle", () => {
    const lib = resolveRenderLib()
    const textBuffer = TextBuffer.create("unicode")
    const textView = TextBufferView.create(textBuffer)
    const node = Yoga.Node.createForOpenTUI()
    const renderable = lib.createNativeRenderable()

    try {
      expect(lib.nativeRenderableAttachYogaNode(renderable, node.ptr)).toBe(true)
      expect(
        lib.nativeRenderableSetMeasureTarget(renderable, NativeMeasureTargetKind.TextBufferView, textView.ptr),
      ).toBe(true)
      expect(lib.yogaNodeHasMeasureFunc(node.ptr)).toBe(true)

      lib.destroyNativeRenderable(renderable)
      expect(lib.yogaNodeHasMeasureFunc(node.ptr)).toBe(false)

      // Stale native renderable handles are rejected safely, including double destroy.
      lib.destroyNativeRenderable(renderable)
      expect(lib.nativeRenderableAttachYogaNode(renderable, node.ptr)).toBe(false)
      expect(
        lib.nativeRenderableSetMeasureTarget(renderable, NativeMeasureTargetKind.TextBufferView, textView.ptr),
      ).toBe(false)
    } finally {
      node.free()
      textView.destroy()
      textBuffer.destroy()
    }
  })
})
