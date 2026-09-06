import { describe, expect, spyOn, test } from "bun:test"
import { OptimizedBuffer, ResourceContext } from "./buffer.js"
import { RGBA } from "./lib/RGBA.js"
import { TextBuffer } from "./text-buffer.js"
import { TextBufferView } from "./text-buffer-view.js"
import { EditBuffer } from "./edit-buffer.js"
import { EditorView } from "./editor-view.js"
import { SyntaxStyle } from "./syntax-style.js"
import { FFIRenderLib, resolveRenderLib, setRenderLibPath, type NativeSceneFrameRequest } from "./zig.js"

describe("native handles", () => {
  test("Context embedded terminal rejects stale and wrong-kind handles", () => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 2, renderCellsMax: 20 })
    try {
      const terminal = lib.createContextEmbeddedTerminal(context, { cols: 10, rows: 2 })
      lib.destroyContextEmbeddedTerminal(context, terminal)
      expect(() => lib.destroyContextEmbeddedTerminal(context, terminal)).toThrow("StaleHandle")
      expect(() => lib.contextEmbeddedTerminalWrite(context, terminal, "stale")).toThrow("StaleHandle")
      const text = lib.createContextTextBuffer(context)
      lib.contextTextBufferSetText(context, text, lib.encoder.encode("preserved"))
      expect(() => lib.contextEmbeddedTerminalWrite(context, text as never, "wrong kind")).toThrow("WrongKind")
      expect(() => lib.destroyContextEmbeddedTerminal(context, text as never)).toThrow("WrongKind")
      expect(lib.contextTextBufferGetText(context, text)).toBe("preserved")
    } finally {
      lib.destroyContext(context)
    }
  })

  test("checked resource handles reject stale and wrong-kind access", () => {
    const owner = new ResourceContext({ objectCapacity: 12, renderCellsMax: 32 })
    const { renderLib: lib, context } = owner
    try {
      const text = TextBuffer.create("unicode", owner)
      const edit = EditBuffer.create("unicode", owner)
      const view = TextBufferView.create(text)
      const editor = EditorView.create(edit, 8, 2)
      const style = SyntaxStyle.create(owner)
      const buffer = OptimizedBuffer.create(4, 3, "unicode", { owner })
      const textHandle = text._getSceneHandle(owner)
      const editHandle = edit._getSceneHandle(owner)
      const viewHandle = view._getSceneHandle(owner)
      const editorHandle = editor._getSceneHandle(owner)
      const styleHandle = style._getSceneHandle(owner)
      const bufferHandle = buffer._getSceneHandle(owner)
      const bytes = lib.encoder.encode("replacement")
      expect(() => lib.contextTextBufferSetText(context, editHandle as never, bytes)).toThrow("WrongKind")
      expect(() => lib.contextEditBufferSetText(context, textHandle as never, bytes)).toThrow("WrongKind")
      expect(() => lib.contextAcquireBufferLease(context, textHandle as never)).toThrow("WrongKind")
      text.destroy()
      edit.destroy()
      style.destroy()
      buffer.destroy()
      for (const access of [
        () => lib.contextTextBufferSetText(context, textHandle, bytes),
        () => lib.contextEditBufferSetText(context, editHandle, bytes),
        () => lib.contextTextBufferViewGetInfo(context, viewHandle),
        () => lib.contextEditorViewGetInfo(context, editorHandle),
        () => lib.contextSyntaxStyleGetStyleCount(context, styleHandle),
        () => lib.contextAcquireBufferLease(context, bufferHandle),
      ])
        expect(access).toThrow("StaleHandle")
      expect(() => view.getPlainText()).toThrow("destroyed")
      expect(() => editor.getVirtualLineCount()).toThrow("destroyed")
      view.destroy()
      editor.destroy()
    } finally {
      owner.destroy()
    }
  })

  test("buffer leases retain their issuing library and release after callback failures", () => {
    const owner = new ResourceContext({ objectCapacity: 4, renderCellsMax: 4 })
    const lib = owner.renderLib
    const other = new FFIRenderLib()
    const buffer = OptimizedBuffer.create(2, 2, "unicode", { owner })
    try {
      const lease = lib.contextAcquireBufferLease(owner.context, buffer._getSceneHandle(owner))
      expect(() => other.contextReleaseBufferLease(owner.context, lease.handle)).toThrow()
      expect(() => owner.destroy()).toThrow("ContextBusy")
      lib.contextReleaseBufferLease(owner.context, lease.handle)
      expect(() => lib.contextReleaseBufferLease(owner.context, lease.handle)).toThrow("StaleHandle")
      const failure = new Error("leased callback failed")
      expect(() =>
        buffer.withBuffers(() => {
          throw failure
        }),
      ).toThrow(failure)
      const acquire = lib.contextAcquireBufferLease.bind(lib)
      const mapping = spyOn(lib, "contextAcquireBufferLease").mockImplementation((...args) => ({
        ...acquire(...args),
        get char(): never {
          throw failure
        },
      }))
      try {
        expect(() => buffer.withBuffers((cells) => cells.char[0])).toThrow(failure)
      } finally {
        mapping.mockRestore()
      }
      buffer.destroy()
      expect(() => owner.destroy()).not.toThrow()
    } finally {
      buffer.destroy()
      owner.destroy()
      other.dispose()
    }
  })

  test("Session buffer wrappers follow resized storage and reject destroyed owners", () => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 4, renderCellsMax: 32 })
    try {
      const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
      lib.sessionAttachRenderer(context, session, { width: 4, height: 3, remote: true })
      const current = OptimizedBuffer.fromSession(lib, context, session, "current")
      const next = OptimizedBuffer.fromSession(lib, context, session, "next")
      const generation = current.withBuffers((cells) => cells.generation)
      lib.sessionResizeRenderer(context, session, 7, 2)
      for (const buffer of [current, next]) {
        expect([buffer.width, buffer.height]).toEqual([7, 2])
        buffer.withBuffers((cells) => {
          expect([cells.width, cells.height, cells.char.length]).toEqual([7, 2, 14])
          expect(cells.generation > generation).toBe(true)
        })
      }
      expect(current.getSpanLines()).toHaveLength(2)
      let retained = 0
      expect(() =>
        next.withBuffers((cells) => {
          const chars = cells.char
          chars[0] = 65
          lib.destroySession(context, session)
          const second = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
          expect(second.slot).toBe(session.slot)
          expect(second.generation).not.toBe(session.generation)
          lib.sessionAttachRenderer(context, second, { width: 4, height: 3, remote: true })
          const before = lib.sceneGetCursorState(context, second)
          expect(() => lib.sessionSetCursor(context, session, { position: { x: 2, y: 2, visible: true } })).toThrow(
            "StaleHandle",
          )
          expect(lib.sceneGetCursorState(context, second)).toEqual(before)
          retained = chars[0]
        }),
      ).toThrow("StaleLease")
      expect(retained).toBe(65)
      expect(() => current.withBuffers(() => {})).toThrow("StaleHandle")
      expect(() => lib.sessionSetCursor(context, session, { position: { x: 1, y: 1, visible: true } })).toThrow(
        "StaleHandle",
      )
      expect(() => lib.destroySession(context, session)).toThrow("StaleHandle")
    } finally {
      lib.destroyContext(context)
    }
  })

  test("render library path cannot change after native use", () => {
    resolveRenderLib()
    expect(() => setRenderLibPath("/tmp/opentui-unused-native-library.so")).toThrow(
      "setRenderLibPath() must be called before resolveRenderLib()",
    )
  })
})

describe("scene measure target ownership", () => {
  test.each(["buffers", "views"] as const)("scene measurement detaches when its %s are destroyed", (destroyed) => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 16, renderCellsMax: 32 })
    try {
      const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
      lib.sessionAttachRenderer(context, session, { width: 8, height: 4, remote: true })
      const root = lib.sceneCreateNode(context, session, "root", 1)
      const textNode = lib.sceneCreateNode(context, session, "text_view", 2)
      const editorNode = lib.sceneCreateNode(context, session, "editor", 3)
      lib.sceneMoveNode(context, textNode, root, 0)
      lib.sceneMoveNode(context, editorNode, root, 1)
      const text = lib.createContextTextBuffer(context)
      const textView = lib.createContextTextBufferView(context, text)
      const edit = lib.createContextEditBuffer(context)
      const editorView = lib.createContextEditorView(context, edit, 8, 4)
      lib.contextTextBufferSetText(context, text, Buffer.from("abc\ndef"))
      lib.contextEditBufferSetText(context, edit, Buffer.from("ghi\njkl"))
      const options = {
        background: RGBA.fromInts(0, 0, 0),
        useMouse: false,
        excludedHitNum: 0,
        maxLayoutRounds: 8,
        maxHostRequests: 64,
      }
      const readFrame = (frame: NativeSceneFrameRequest) => {
        expect(frame.kind).toBe(0)
        const lease = lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
        try {
          const bytes = new Uint8Array(128)
          const length = lib.contextBufferLeaseWriteResolvedChars(context, lease.handle, bytes, true)
          return lib.decoder.decode(bytes.subarray(0, length))
        } finally {
          lib.contextReleaseBufferLease(context, lease.handle)
        }
      }

      lib.sceneSetTextView(context, textNode, textView)
      lib.sceneSetEditorView(context, editorNode, editorView)
      let frame = lib.sceneFrameStep(context, session, null, options)
      expect(lib.sceneGetLayout(context, textNode).height).toBe(2)
      expect(lib.sceneGetLayout(context, editorNode).height).toBe(2)
      const paintedText = "abc     \ndef     \nghi     \njkl     \n"
      expect(readFrame(frame)).toBe(paintedText)
      lib.sceneFrameCancel(context, session, frame.frameId)
      expect(() => lib.sceneSetTextView(context, textNode, edit as never)).toThrow("WrongKind")
      expect(() => lib.sceneSetEditorView(context, editorNode, text as never)).toThrow("WrongKind")
      frame = lib.sceneFrameStep(context, session, null, options)
      expect(readFrame(frame)).toBe(paintedText)
      lib.sceneSetTextView(context, textNode, null)
      lib.sceneSetEditorView(context, editorNode, null)
      expect(lib.sceneHasMeasure(context, textNode)).toBe(false)
      expect(lib.sceneHasMeasure(context, editorNode)).toBe(false)
      lib.sceneSetTextView(context, textNode, textView)
      lib.sceneSetEditorView(context, editorNode, editorView)

      if (destroyed === "buffers") {
        lib.destroyContextTextBuffer(context, text)
        lib.destroyContextEditBuffer(context, edit)
      } else {
        lib.destroyContextTextBufferView(context, textView)
        lib.destroyContextEditorView(context, editorView)
      }
      expect(() => lib.sceneSetTextView(context, textNode, textView)).toThrow("StaleHandle")
      expect(() => lib.sceneSetEditorView(context, editorNode, editorView)).toThrow("StaleHandle")
      expect(readFrame(frame)).toBe(paintedText)
      lib.sceneFrameCancel(context, session, frame.frameId)
      frame = lib.sceneFrameStep(context, session, null, options)
      expect(readFrame(frame)).toBe("        \n".repeat(4))
      lib.sceneFrameCancel(context, session, frame.frameId)
      for (const node of [textNode, editorNode]) {
        expect(lib.sceneHasMeasure(context, node)).toBe(false)
        expect(lib.sceneGetLayout(context, node).height).toBe(1)
        lib.sceneDestroyNode(context, node)
        expect(() => lib.sceneGetLayout(context, node)).toThrow("StaleHandle")
        expect(() => lib.sceneDestroyNode(context, node)).toThrow("StaleHandle")
      }
    } finally {
      lib.destroyContext(context)
    }
  })
})
