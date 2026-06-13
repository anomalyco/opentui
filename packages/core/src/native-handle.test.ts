import { describe, expect, test } from "bun:test"
import { OptimizedBuffer } from "./buffer.js"
import { RGBA } from "./lib/RGBA.js"
import { TextBuffer } from "./text-buffer.js"
import { TextBufferView } from "./text-buffer-view.js"
import { EditBuffer } from "./edit-buffer.js"
import { EditorView } from "./editor-view.js"
import { SyntaxStyle } from "./syntax-style.js"
import {
  resolveRenderLib,
  setRenderLibPath,
  type OptimizedBufferHandle,
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
