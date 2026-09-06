import { test } from "bun:test"
import assert from "node:assert/strict"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { LineNumberRenderable } from "../renderables/LineNumberRenderable.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test("editor line-info edits repaint retained numbers when wrapped row count is unchanged", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 32,
    height: 12,
    clock: new ManualClock(),
  })
  const errors: Error[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  try {
    const editor = new TextareaRenderable(renderer, {
      width: 8,
      height: 4,
      wrapMode: "char",
      initialValue: "aaaabbbbcccc\ndddd\neeee",
    })
    renderer.root.add(new LineNumberRenderable(renderer, { width: 26, target: editor }))
    await renderOnce()
    assert.deepEqual(editor.lineInfo.lineSources, [0, 0, 1, 2])
    editor.setText("aaaa\nbbbbccccdddd\neeee")
    await renderOnce()
    assert.deepEqual(errors, [])
    assert.deepEqual(editor.lineInfo.lineSources, [0, 1, 1, 2])
    assert.deepEqual(
      captureCharFrame()
        .split("\n")
        .slice(0, 4)
        .map((line) => line.trimEnd()),
      [" 1 aaaa", " 2 bbbbcccc", "   dddd", " 3 eeee"],
    )
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
