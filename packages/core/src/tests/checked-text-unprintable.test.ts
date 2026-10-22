import { test } from "bun:test"
import assert from "node:assert/strict"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { createTestRenderer } from "../testing/test-renderer.js"

// One grapheme of 129 UTF-8 bytes: the native grapheme pool stores at most 128.
const zalgo = "e" + "\u0301".repeat(64)

test("controls and graphemes a cell cannot hold do not fail a frame", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 12, height: 5 })
  const errors: unknown[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  try {
    renderer.root.add(new TextareaRenderable(renderer, { initialValue: `a${zalgo}b`, width: 6, height: 1 }))
    renderer.root.add(new TextRenderable(renderer, { content: `c${zalgo}d`, width: 6, height: 1 }))
    await renderOnce()
    assert.deepEqual(errors, [])
    let lines = captureCharFrame().split("\n")
    assert.equal(lines[0].slice(0, 3), "a b")
    assert.equal(lines[1].slice(0, 3), "c d")

    renderer.root.add(new BoxRenderable(renderer, { title: "x\ny\x1b", border: true, width: 12, height: 3 }))
    await renderOnce()
    assert.deepEqual(errors, [])
    lines = captureCharFrame().split("\n")
    assert.match(lines[2], /xy/)
  } finally {
    renderer.destroy()
  }
})
