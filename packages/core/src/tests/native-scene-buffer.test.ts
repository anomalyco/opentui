import { test } from "bun:test"
import assert from "node:assert/strict"
import { CliRenderEvents } from "../renderer.js"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test("an async post-process presents its synchronous drawing", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 2, height: 1 })
  const errors: unknown[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  try {
    renderer.addPostProcessFn(async (buffer) => {
      buffer.buffers.char[0] = 66
    })
    await renderOnce()
    assert.deepEqual(errors, [])
    assert.equal(captureCharFrame(), "B \n")
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test("native text scene capture resolves CJK, combining graphemes, and ZWJ emoji", async () => {
  const { renderer, renderOnce, captureCharFrame, captureSpans } = await createTestRenderer({
    width: 4,
    height: 3,
  })
  try {
    renderer.root.add(
      new TextRenderable(renderer, {
        selectable: false,
        content: "\u4e16\u754c\ne\u0301a\u0308\n\ud83d\udc69\u200d\ud83d\udcbbZ",
        width: 4,
        height: 3,
      }),
    )
    await renderOnce()
    const rows = ["\u4e16\u754c", "e\u0301a\u0308  ", "\ud83d\udc69\u200d\ud83d\udcbbZ "]
    assert.equal(captureCharFrame(), `${rows.join("\n")}\n`)
    assert.deepEqual(
      captureSpans().lines.map(({ spans }) => spans.map((span) => span.text).join("")),
      rows,
    )
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
