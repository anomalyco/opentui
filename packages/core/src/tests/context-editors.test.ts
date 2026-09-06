import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { ResourceContext } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { RGBA } from "../lib/RGBA.js"
import { withBufferAccess } from "../lib/buffer-access.js"
import { StyledText } from "../lib/styled-text.js"
import { acquireSessionBufferLease } from "../session-buffer.js"
import { NativeStatus, resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()
const options = { objectCapacity: 16, renderCellsMax: 64 }
const frameOptions = {
  background: RGBA.fromInts(0, 0, 0),
  useMouse: false,
  excludedHitNum: 0,
  maxLayoutRounds: 8,
  maxHostRequests: 64,
}

test("editor wrappers retain rejected destruction and release failed event registration", async () => {
  const owner = new ResourceContext(options)
  const edit = EditBuffer.create("unicode", owner)
  const view = EditorView.create(edit, 8, 2)
  try {
    let events = 0
    edit.on("content-changed", () => events++)
    lib.getYogaHost().invokeCallback(() => {
      assert.throws(() => view.destroy(), /during a callback/)
      assert.throws(() => edit.destroy(), /during a callback/)
    })
    lib.getYogaHost().throwCallbackError()
    edit.setText("retained")
    await Promise.resolve()
    assert.equal(events, 1)
    assert.equal(view.getText(), "retained")
    const register = spyOn(lib, "onContextEditEvent").mockImplementation(() => {
      throw new Error("registration failed")
    })
    const destroy = spyOn(lib, "destroyContextEditBuffer")
    try {
      assert.throws(() => EditBuffer.create("unicode", owner), /registration failed/)
      assert.equal(destroy.mock.calls.length, 1)
      assert.throws(() => lib.contextEditBufferGetText(...destroy.mock.calls[0]), { status: NativeStatus.StaleHandle })
    } finally {
      register.mockRestore()
      destroy.mockRestore()
    }
    view.destroy()
    edit.destroy()
    assert.equal(edit.listenerCount("content-changed"), 0)
    assert.throws(() => view.getText(), /destroyed/)
  } finally {
    view.destroy()
    edit.destroy()
    owner.destroy()
  }
})

test("editor placeholders copy styled input and reject links without replacing accepted text", () => {
  const owner = new ResourceContext(options)
  const edit = EditBuffer.create("unicode", owner)
  const view = EditorView.create(edit, 8, 2)
  try {
    const placeholder = new StyledText([{ __isChunk: true, text: "hint", fg: RGBA.fromInts(255, 0, 0) }])
    lib.contextEditorViewSetPlaceholder(owner.context, view._getSceneHandle(owner), placeholder)
    placeholder.chunks[0].text = "changed"
    assert.throws(
      () =>
        lib.contextEditorViewSetPlaceholder(
          owner.context,
          view._getSceneHandle(owner),
          new StyledText([{ __isChunk: true, text: "link", link: { url: "https://example.com" } }]),
        ),
      /link/i,
    )
    assert.deepEqual(view.measureForDimensions(8, 2), { lineCount: 1, widthColsMax: 4 })
  } finally {
    view.destroy()
    edit.destroy()
    owner.destroy()
  }
})

test("rejected selection replacement preserves text, selection and undo history", () => {
  const owner = new ResourceContext(options)
  const edit = EditBuffer.create("unicode", owner)
  const view = EditorView.create(edit, 8, 2)
  try {
    edit.setText("abcDEFghi")
    view.setSelection(3, 6)
    assert.throws(
      () => lib.contextEditorViewReplaceSelection(owner.context, view._getSceneHandle(owner), Uint8Array.of(0xff)),
      { status: NativeStatus.InvalidArgument },
    )
    assert.equal(edit.getText(), "abcDEFghi")
    assert.deepEqual(view.getSelection(), { start: 3, end: 6 })
    assert.equal(edit.canUndo(), false)
    view._replaceSelectedText("X")
    assert.equal(edit.getText(), "abcXghi")
    edit.undo()
    assert.equal(edit.getText(), "abcghi")
    edit.undo()
    assert.equal(edit.getText(), "abcDEFghi")
  } finally {
    view.destroy()
    edit.destroy()
    owner.destroy()
  }
})

test("Context editors isolate matching local slots and copy owned UTF-8", async () => {
  const left = lib.createContext(options)
  const right = lib.createContext(options)
  try {
    const a = lib.createContextEditBuffer(left)
    const b = lib.createContextEditBuffer(right)
    assert.equal(a.slot, b.slot)
    assert.equal(a.generation, b.generation)
    const events: string[] = []
    lib.onContextEditEvent(left, a, (event) => events.push(`a:${event}`))
    lib.onContextEditEvent(right, b, (event) => events.push(`b:${event}`))
    const bytes = Buffer.from("A\u4e2d\r\nB")
    lib.contextEditBufferSetText(left, a, bytes)
    bytes.fill(0)
    lib.contextEditBufferSetText(right, b, Buffer.from("other"))
    assert.equal(lib.contextEditBufferGetText(left, a), "A\u4e2d\nB")
    assert.equal(lib.contextEditBufferGetText(right, b), "other")
    assert.equal(lib.contextEditBufferGetInfo(left, a).byteLength, 6)
    assert.equal(lib.contextEditBufferGetInfo(left, a).lineCount, 2)
    assert.throws(() => lib.contextEditBufferGetInfo(left, b), { status: NativeStatus.WrongContext })
    assert.deepEqual(events, [])
    await Promise.resolve()
    assert.deepEqual(events, ["a:cursor-changed", "a:content-changed", "b:cursor-changed", "b:content-changed"])
  } finally {
    lib.destroyContext(left)
    lib.destroyContext(right)
  }
})

test("Context editor destruction and unsubscribe suppress already queued notifications", async () => {
  const context = lib.createContext(options)
  let destroyed = false
  try {
    const edit = lib.createContextEditBuffer(context)
    const view = lib.createContextEditorView(context, edit, 4, 2)
    const events: string[] = []
    const listener = (event: string) => events.push(event)
    const off = lib.onContextEditEvent(context, edit, listener)
    lib.contextEditBufferSetText(context, edit, Buffer.from("old"))
    off()
    lib.onContextEditEvent(context, edit, listener)
    await Promise.resolve()
    assert.deepEqual(events, [])
    lib.contextEditBufferInsertText(context, edit, Buffer.from("!"))
    lib.destroyContextEditBuffer(context, { ...edit })
    const replacement = lib.createContextEditBuffer(context)
    lib.onContextEditEvent(context, replacement, listener)
    assert.throws(() => lib.contextEditBufferGetText(context, edit), { status: NativeStatus.StaleHandle })
    assert.throws(() => lib.contextEditorViewGetInfo(context, view), { status: NativeStatus.StaleHandle })
    assert.throws(() => lib.onContextEditEvent(context, edit, listener), { status: NativeStatus.StaleHandle })
    await Promise.resolve()
    assert.deepEqual(events, [])
    lib.contextEditBufferSetText(context, replacement, Buffer.from("last"))
    lib.destroyContext(context)
    destroyed = true
    await Promise.resolve()
    assert.deepEqual(events, [])
    off()
    assert.throws(() => lib.contextEditBufferGetInfo(context, replacement), { status: NativeStatus.WrongContext })
  } finally {
    if (!destroyed) lib.destroyContext(context)
  }
})

test("Context editor rejected inputs preserve owned text and resources", async () => {
  const context = lib.createContext({ ...options, objectCapacity: 2 })
  try {
    const edit = lib.createContextEditBuffer(context, { widthMethod: "unicode-wide" })
    const style = lib.createContextSyntaxStyle(context)
    lib.contextEditBufferSetSyntaxStyle(context, edit, style)
    assert.throws(() => lib.createContextEditorView(context, edit, 4, 2), { status: NativeStatus.ObjectLimit })
    lib.contextEditBufferSetText(context, edit, Buffer.from("kept"))
    await Promise.resolve()
    const events: string[] = []
    lib.onContextEditEvent(context, edit, (event) => events.push(event))
    for (const bytes of [Buffer.from("\x1b"), Uint8Array.of(0xc3), Uint8Array.of(0xff)]) {
      assert.throws(() => lib.contextEditBufferSetText(context, edit, bytes), { status: NativeStatus.InvalidArgument })
      assert.equal(lib.contextEditBufferGetText(context, edit), "kept")
    }
    await Promise.resolve()
    assert.deepEqual(events, [])
    assert.throws(() => lib.contextEditBufferSetCursor(context, edit, -1, 0), RangeError)
    assert.throws(() => lib.contextEditBufferSetSyntaxStyle(context, edit, edit as never), {
      status: NativeStatus.WrongKind,
    })
    lib.destroyContextSyntaxStyle(context, style)
    assert.throws(() => lib.contextEditBufferSetSyntaxStyle(context, edit, style), { status: NativeStatus.StaleHandle })
    lib.contextEditBufferSetSyntaxStyle(context, edit, null)
    lib.contextEditBufferSetText(context, edit, Buffer.from("undo point"), true)
    assert.equal(lib.contextEditBufferGetInfo(context, edit).canUndo, true)
    lib.contextEditBufferSetText(context, edit, new Uint8Array())
    assert.equal(lib.contextEditBufferGetInfo(context, edit).canUndo, false)
    assert.equal(lib.contextEditBufferGetText(context, edit), "")
    const view = lib.createContextEditorView(context, edit, 4, 2)
    lib.destroyContextEditorView(context, view)
    assert.throws(() => lib.destroyContextEditorView(context, view), { status: NativeStatus.StaleHandle })
  } finally {
    lib.destroyContext(context)
  }
})

test("Context edit delivery revalidates subscriptions between listeners", async () => {
  const context = lib.createContext(options)
  try {
    const edit = lib.createContextEditBuffer(context)
    const events: string[] = []
    lib.onContextEditEvent(context, edit, (event) => {
      events.push(event)
      lib.destroyContextEditBuffer(context, edit)
    })
    lib.onContextEditEvent(context, edit, () => events.push("destroyed listener"))
    lib.contextEditBufferSetText(context, edit, Buffer.from("x"))
    await Promise.resolve()
    assert.deepEqual(events, ["cursor-changed"])
  } finally {
    lib.destroyContext(context)
  }
})

test("Context editor native measurement and scene cursor follow edits before notifications", async () => {
  const context = lib.createContext(options)
  try {
    const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
    lib.sessionAttachRenderer(context, session, { width: 8, height: 4, remote: true })
    const root = lib.sceneCreateNode(context, session, "root", 1)
    const node = lib.sceneCreateNode(context, session, "editor", 2)
    const edit = lib.createContextEditBuffer(context)
    const view = lib.createContextEditorView(context, edit, 8, 4)
    lib.sceneSetEditorView(context, node, view)
    lib.sceneMoveNode(context, node, root, 0)
    lib.sceneSetFocus(context, node, true)
    lib.sceneSetEditorOptions(context, node, {
      showCursor: true,
      style: "underline",
      blinking: false,
      color: RGBA.fromInts(255, 0, 0),
    })
    const events: string[] = []
    lib.onContextEditEvent(context, edit, (event) => events.push(event))
    lib.contextEditBufferSetText(context, edit, Buffer.from("abc\ndef"))
    lib.contextEditBufferSetCursor(context, edit, 1, 2)
    let frame = lib.sceneFrameStep(context, session, null, frameOptions)
    assert.equal(frame.kind, 0)
    assert.deepEqual(events, [])
    assert.equal(lib.sceneGetLayout(context, node).height, 2)
    assert.equal(lib.sceneHasMeasure(context, node), true)
    const cursor = lib.sceneGetCursorState(context, session)
    assert.equal(cursor.visible, true)
    assert.equal(cursor.style, "underline")
    assert.equal(cursor.blinking, false)
    assert.deepEqual([cursor.x, cursor.y], [3, 2])
    withBufferAccess(lib, context, acquireSessionBufferLease(lib, context, session, "next", frame), (cells) => {
      assert.equal(cells.char[0], "a".charCodeAt(0))
      assert.equal(cells.char[8], "d".charCodeAt(0))
    })
    lib.sceneFrameCancel(context, session, frame.frameId)
    lib.contextEditBufferDeleteRange(context, edit, 0, 0, 1, 0)
    frame = lib.sceneFrameStep(context, session, null, frameOptions)
    assert.equal(frame.kind, 0)
    assert.equal(lib.contextEditBufferGetText(context, edit), "def")
    assert.equal(lib.sceneGetLayout(context, node).height, 1)
    lib.sceneFrameCancel(context, session, frame.frameId)
    lib.destroyContextEditorView(context, view)
    frame = lib.sceneFrameStep(context, session, null, frameOptions)
    assert.equal(frame.kind, 0)
    assert.equal(lib.sceneGetCursorState(context, session).visible, false)
    assert.equal(lib.contextEditBufferGetText(context, edit), "def")
    lib.sceneFrameCancel(context, session, frame.frameId)
    await Promise.resolve()
    assert.ok(events.length > 0)
  } finally {
    lib.destroyContext(context)
  }
})

test("Context editor callback failures return through YogaHost after native mutation", () => {
  const context = lib.createContext(options)
  try {
    const edit = lib.createContextEditBuffer(context)
    lib.onContextEditEvent(context, edit, () => {})
    const failure = new Error("queue failed")
    const queue = spyOn(globalThis, "queueMicrotask").mockImplementation(() => {
      throw failure
    })
    try {
      assert.throws(
        () => lib.contextEditBufferSetText(context, edit, Buffer.from("accepted")),
        (error) => error === failure,
      )
    } finally {
      queue.mockRestore()
    }
    assert.equal(lib.contextEditBufferGetText(context, edit), "accepted")
    lib.contextEditBufferSetText(context, edit, Buffer.from("retry"))
  } finally {
    lib.destroyContext(context)
  }
})
