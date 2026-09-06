import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({ width: 28, height: 8, clock: new ManualClock() })
  setups.push(target)
  return target
}

test("native editor keeps input cancellation and its existing ignored paint and resize hooks", async () => {
  const target = await setup()
  const trace: string[] = []
  const editor = new TextareaRenderable(target.renderer, {
    width: 12,
    height: 3,
    onKeyDown: (event) => {
      trace.push("key")
      event.preventDefault()
    },
    onPaste: (event) => {
      trace.push("paste")
      event.preventDefault()
    },
    renderBefore: () => trace.push("before"),
    renderAfter: () => trace.push("after"),
    onSizeChange: () => trace.push("size"),
  })
  editor.on("resize", () => trace.push("resize"))
  target.renderer.root.add(editor)
  editor.focus()
  await target.renderOnce()
  target.mockInput.pressKey("a")
  await target.mockInput.pasteBracketedText("pasted")
  editor.width = 8
  await target.renderOnce()
  assert.equal(editor.plainText, "")
  assert.deepEqual(trace, ["key", "paste"])
})

test("native buffer-first cleanup releases the editor wrapper and extmark controller", async () => {
  const target = await setup()
  const editor = new TextareaRenderable(target.renderer, { width: 10, height: 2, initialValue: "abc" })
  target.renderer.root.add(editor)
  editor.extmarks.create({ start: 0, end: 2, metadata: { label: "mark" } })
  editor.editBuffer.destroy()
  editor.editorView.destroy()
  editor.editorView.destroy()
  assert.throws(() => editor.editorView.getSelection(), /destroyed/)
  editor.destroy()
  const second = new TextareaRenderable(target.renderer, { width: 10, height: 2 })
  target.renderer.root.add(second)
  const listeners = second.editBuffer.listenerCount("content-changed")
  void second.extmarks
  assert.equal(second.editBuffer.listenerCount("content-changed"), listeners + 1)
  second.editorView.destroy()
  assert.equal(second.editBuffer.listenerCount("content-changed"), listeners)
})

test("native deletion-only replacement stores one matching extmark undo snapshot", async () => {
  const target = await setup()
  const editor = new TextareaRenderable(target.renderer, { width: 10, height: 2, initialValue: "abcdef" })
  target.renderer.root.add(editor)
  const metadata = { label: "selected" }
  const id = editor.extmarks.create({ start: 1, end: 3, metadata })
  editor.setSelection(1, 3)
  editor.insertText("")
  assert.equal(editor.plainText, "adef")
  editor.undo()
  assert.equal(editor.plainText, "abcdef")
  assert.equal(editor.extmarks.getMetadataFor(id), metadata)
  assert.equal(editor.extmarks.get(id)?.start, 1)
})

test("native typing after selecting placeholder text edits the buffer", async () => {
  const target = await setup()
  const editor = new TextareaRenderable(target.renderer, { width: 10, height: 2, placeholder: "hint" })
  target.renderer.root.add(editor)
  editor.focus()
  await target.renderOnce()
  editor.setSelection(0, 4)
  assert.equal(editor.getSelectedText(), "hint")
  editor.insertText("X")
  assert.equal(editor.plainText, "X")
  await target.renderOnce()
  assert.ok(target.captureCharFrame().startsWith("X"))
})
