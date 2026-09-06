import { test } from "bun:test"
import assert from "node:assert/strict"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test("native scene forwards initialization environment into actual text cells", async () => {
  const saved = process.env.OPENTUI_FORCE_WCWIDTH
  process.env.OPENTUI_FORCE_WCWIDTH = "1"
  try {
    const target = await createTestRenderer({
      width: 16,
      height: 2,
      screenMode: "main-screen",
      externalOutputMode: "passthrough",
      consoleMode: "disabled",
      remote: false,
      forwardEnvKeys: ["OPENTUI_FORCE_WCWIDTH"],
    })
    try {
      delete process.env.OPENTUI_FORCE_WCWIDTH
      assert.equal(target.renderer.widthMethod, "wcwidth")
      const text = new TextRenderable(target.renderer, {
        id: "width",
        content: "\u{1f469}\u200d\u{1f680}X",
        selectable: false,
        width: "auto",
      })
      target.renderer.root.add(text)
      await target.renderOnce()
      assert.ok(target.captureCharFrame().includes("X"))
      assert.equal(text.lineInfo.lineWidthCols[0], 5)
      target.renderer.currentRenderBuffer.withBuffers((cells) => assert.equal(cells.char[4], 88))
      assert.equal(target.renderer.widthMethod, "wcwidth")
    } finally {
      target.renderer.destroy()
      await target.renderer.closed
    }
  } finally {
    if (saved === undefined) delete process.env.OPENTUI_FORCE_WCWIDTH
    else process.env.OPENTUI_FORCE_WCWIDTH = saved
  }
})
