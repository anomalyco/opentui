import { test } from "bun:test"
import assert from "node:assert/strict"
import { ResourceContext } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { resolveRenderLib } from "../zig.js"

test("rejected selection replacement preserves text, selection and undo history", () => {
  const owner = new ResourceContext({ objectCapacity: 16, renderCellsMax: 64 })
  const edit = EditBuffer.create("unicode", owner)
  const view = EditorView.create(edit, 8, 2)
  try {
    edit.setText("abcDEFghi")
    view.setSelection(3, 6)
    assert.throws(() =>
      resolveRenderLib().contextEditorViewReplaceSelection(
        owner.context,
        view._getSceneHandle(owner),
        Uint8Array.of(0xff),
      ),
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
