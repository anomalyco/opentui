import { test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { Writable } from "node:stream"
import { NativeSession } from "../NativeSession.js"
import { OptimizedBuffer } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { SyntaxStyle } from "../syntax-style.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { RGBA } from "../lib/RGBA.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { NativeSessionState, NativeStatus, resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()
const dimensions = { width: 2, height: 1, remote: true }

async function setup() {
  return createTestRenderer({
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    width: 8,
    height: 4,
    footerHeight: 1,
    consoleMode: "disabled",
  })
}

test("definition bindings own distinct style handles across detached scenes in the same Context", async () => {
  const { renderer } = await setup()
  const styles: SyntaxStyle[] = []
  try {
    const first = renderer.createScrollbackSurface()
    const second = renderer.createScrollbackSurface()
    const source = SyntaxStyle.fromStyles({ token: { bold: true } }, renderer.nativeScene!)
    styles.push(source)
    const firstStyle = SyntaxStyle.fromStyles(source.getAllStyles(), first.renderContext.nativeScene!)
    styles.push(firstStyle)
    const secondStyle = SyntaxStyle.fromStyles(source.getAllStyles(), second.renderContext.nativeScene!)
    styles.push(secondStyle)
    const firstHandle = firstStyle._getSceneHandle(first.renderContext.nativeScene!)
    const secondHandle = secondStyle._getSceneHandle(second.renderContext.nativeScene!)
    assert.equal(firstHandle.context, secondHandle.context)
    assert.notDeepEqual(firstHandle, secondHandle)
    assert.throws(() => firstStyle._getSceneHandle(second.renderContext.nativeScene!), /owner mismatch/)
    first.destroy()
    assert.throws(() => firstStyle.getStyleCount(), /destroyed/)
    const later = secondStyle.registerStyle("later", { italic: true })
    assert.equal(lib.contextSyntaxStyleGetStyleCount(firstHandle.context, firstHandle), 1)
    assert.equal(source.getStyleCount(), 1)
    assert.equal(source.registerStyle("later", { italic: true }), later)
    firstStyle.destroy()
    assert.throws(() => lib.contextSyntaxStyleGetStyleCount(firstHandle.context, firstHandle), {
      status: NativeStatus.StaleHandle,
    })
    assert.equal(secondStyle.getStyleCount(), 2)
    secondStyle.destroy()
    assert.throws(() => lib.contextSyntaxStyleGetStyleCount(secondHandle.context, secondHandle), {
      status: NativeStatus.StaleHandle,
    })
    assert.equal(source.getStyleCount(), 2)
  } finally {
    try {
      for (const style of styles.reverse()) style.destroy()
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  }
})

test("resource wrappers release Context handles after detached Session disposal", async () => {
  const { renderer } = await setup()
  const surface = renderer.createScrollbackSurface()
  const scene = surface.renderContext.nativeScene!
  const buffer = OptimizedBuffer.create(1, 1, "unicode", { owner: scene })
  const text = TextBuffer.create("unicode", scene)
  const textView = TextBufferView.create(text)
  const edit = EditBuffer.create("unicode", scene)
  const editor = EditorView.create(edit, 1, 1)
  const bufferHandle = buffer._getSceneHandle(scene)
  const textHandle = text._getSceneHandle(scene)
  const textViewHandle = textView._getSceneHandle(scene)
  const editHandle = edit._getSceneHandle(scene)
  const editorHandle = editor._getSceneHandle(scene)
  try {
    surface.destroy()
    for (const [wrapper, destroyNative] of [
      [buffer, () => lib.destroyContextBuffer(bufferHandle.context, bufferHandle)],
      [textView, () => lib.destroyContextTextBufferView(textViewHandle.context, textViewHandle)],
      [text, () => lib.destroyContextTextBuffer(textHandle.context, textHandle)],
      [editor, () => lib.destroyContextEditorView(editorHandle.context, editorHandle)],
      [edit, () => lib.destroyContextEditBuffer(editHandle.context, editHandle)],
    ] as const) {
      wrapper.destroy()
      assert.throws(destroyNative, { status: NativeStatus.StaleHandle })
    }
  } finally {
    buffer.destroy()
    textView.destroy()
    text.destroy()
    editor.destroy()
    edit.destroy()
    renderer.destroy()
    await renderer.closed
  }
})

test("reentrant graceful parent close retains pending waits until cleanup succeeds", async () => {
  const failure = new Error("parent cleanup failed")
  const parent = new NativeSession(new Writable({ write: (_bytes, _encoding, done) => done() }))
  parent.attachRenderer(dimensions, () => {
    throw failure
  })
  const idle = parent.idle()
  const child = parent.createDetached(dimensions, () => {
    void parent.close()
  })
  try {
    await child.close()
    assert.equal(parent.disposed, true)
    assert.equal(parent.error, failure)
    await assert.rejects(parent.closed, failure)
    await assert.rejects(idle, failure)
  } finally {
    parent.dispose()
  }
})

test("definition snapshots and destination styles do not retain a disposed source Context owner", () => {
  const runtimeArgs =
    "bun" in process.versions ? [] : [...process.execArgv.filter((arg) => !arg.startsWith("--test")), "--expose-gc"]
  const child = spawnSync(
    process.execPath,
    [
      ...runtimeArgs,
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict"
        import { Writable } from "node:stream"
        import { NativeSession } from ${JSON.stringify(new URL("../NativeSession.js", import.meta.url).href)}
        import { NativeScene } from ${JSON.stringify(new URL("../NativeScene.js", import.meta.url).href)}
        import { SyntaxStyle } from ${JSON.stringify(new URL("../syntax-style.js", import.meta.url).href)}
        import { ResourceContext } from ${JSON.stringify(new URL("../buffer.js", import.meta.url).href)}
        const destination = new ResourceContext({ objectCapacity: 64, renderCellsMax: 1 })
        let style
        try {
          const { reference, definitions } = (() => {
            const parent = new NativeSession(new Writable({ write: (_bytes, _encoding, done) => done() }))
            let source
            try {
              const child = parent.createDetached({ width: 2, height: 1, remote: true }, () => {})
              source = SyntaxStyle.fromStyles({ token: { bold: true } }, new NativeScene(child, {}))
              const definitions = source.getAllStyles()
              style = SyntaxStyle.fromStyles(definitions, destination)
              return { reference: new WeakRef(parent), definitions }
            } finally {
              source?.destroy()
              parent.dispose()
            }
          })()
          for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise(resolve => setImmediate(resolve))
            if (typeof Bun !== "undefined") Bun.gc(true)
            else globalThis.gc()
          }
          assert.ok(reference.deref() === undefined, "shared definitions retained their disposed source owner")
          assert.equal(definitions.get("token").bold, true)
          assert.equal(style.getStyleCount(), 1)
        } finally {
          style?.destroy()
          destination.destroy()
        }
      `,
    ],
    { encoding: "utf8", timeout: 30_000 },
  )
  assert.equal(child.status, 0, child.stderr || child.error?.message)
})

test("a leased child close rejects a reentrant parent's waits without retrying cleanup", async () => {
  const calls: string[] = []
  const parent = new NativeSession(new Writable({ write: (_bytes, _encoding, done) => done() }))
  parent.attachRenderer(dimensions, () => calls.push("parent"))
  const failures: unknown[] = []
  void parent.closed.catch((error) => failures.push(error))
  void parent.idle().catch((error) => failures.push(error))
  const child = parent.createDetached(dimensions, () => {
    calls.push("child")
    void parent.close()
  })
  lib.sceneCreateNode(child.context, child.session, "root", 1)
  const frame = lib.sceneFrameStep(child.context, child.session, null, {
    background: RGBA.fromInts(0, 0, 0),
    useMouse: false,
    excludedHitNum: 0,
    maxLayoutRounds: 8,
    maxHostRequests: 64,
  })
  const lease = lib.sceneFrameAcquireBufferLease(child.context, child.session, frame, "next")
  try {
    try {
      await assert.rejects(child.close(), { status: NativeStatus.ContextBusy })
      assert.deepEqual(failures, [child.error, child.error])
      assert.deepEqual(calls, ["child"])
      assert.equal(child.disposed, false)
      assert.equal(parent.disposed, false)
      assert.equal(parent.error, child.error)
      assert.equal(lib.sessionGetState(parent.context, parent.session), NativeSessionState.Cancelled)
    } finally {
      lib.contextReleaseBufferLease(child.context, lease.handle)
    }
    parent.dispose()
    assert.equal(child.disposed, true)
    assert.equal(parent.disposed, true)
    assert.deepEqual(calls, ["child", "child", "parent"])
    assert.throws(() => lib.sessionGetState(parent.context, parent.session), { status: NativeStatus.WrongContext })
  } finally {
    parent.dispose()
  }
})
