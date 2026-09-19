import { test } from "bun:test"
import assert from "node:assert/strict"
import { OptimizedBuffer } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { SyntaxStyle } from "../syntax-style.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test("detached resource access and queued edit events survive Session destruction", async () => {
  const { renderer } = await createTestRenderer({
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    width: 8,
    height: 4,
    footerHeight: 1,
    consoleMode: "disabled",
  })
  const surface = renderer.createScrollbackSurface()
  const scene = surface.renderContext.nativeScene!
  const text = TextBuffer.create("unicode", scene)
  const view = TextBufferView.create(text)
  const edit = EditBuffer.create("unicode", scene)
  const editor = EditorView.create(edit, 4, 1)
  const style = SyntaxStyle.fromStyles({ token: { bold: true } }, scene)
  const buffer = OptimizedBuffer.create(4, 1, "unicode", { owner: scene })
  const events: string[] = []
  edit.on("content-changed", () => events.push(edit.getText()))
  try {
    edit.setText("edit")
    surface.destroy()
    await Promise.resolve()
    assert.deepEqual(events, ["edit"])
    edit.setText("next")
    await Promise.resolve()
    assert.deepEqual(events, ["edit", "next"])
    assert.equal(editor.getText(), "next")
    text.setSyntaxStyle(style)
    edit.setSyntaxStyle(style)
    text.setText("text")
    view.setViewport(0, 0, 4, 1)
    buffer.drawTextBuffer(view, 0, 0)
    assert.equal(new TextDecoder().decode(buffer.getRealCharBytes()), "text")
    assert.equal(style.getStyleCount(), 1)
    const laterView = TextBufferView.create(text)
    laterView.destroy()

    edit.setText("drop")
    edit.destroy()
    await Promise.resolve()
    assert.deepEqual(events, ["edit", "next"])
    assert.equal(edit.listenerCount("content-changed"), 0)
    assert.throws(() => editor.getText(), /destroyed/)
  } finally {
    for (const resource of [buffer, style, editor, edit, view, text]) resource.destroy()
    renderer.destroy()
    await renderer.closed
  }
})
