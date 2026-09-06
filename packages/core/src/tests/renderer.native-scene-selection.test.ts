import { expectRenderSnapshot } from "./render-snapshot.js"
import { test } from "bun:test"
import assert from "node:assert/strict"

import { ASCIIFontRenderable } from "../renderables/ASCIIFont.js"
import { BoxRenderable } from "../renderables/Box.js"
import { EmbeddedTerminalRenderable } from "../renderables/EmbeddedTerminal.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextTableRenderable } from "../renderables/TextTable.js"
import { TextareaRenderable } from "../renderables/Textarea.js"

import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test.each(["textarea", "text", "table", "terminal", "font"] as const)(
  "%s selection follows painted cells across moved fractional origins",
  async (kind) => {
    const { renderer, renderOnce, mockMouse } = await createTestRenderer({
      width: 40,
      height: 8,
      useMouse: true,
      clock: new ManualClock(),
    })
    try {
      const options = { position: "absolute", left: 4, top: 2, width: 24, height: 3 } as const
      const content = "\nabcdefghijklmnopqrst"
      const node =
        kind === "textarea"
          ? new TextareaRenderable(renderer, { ...options, initialValue: content })
          : kind === "table"
            ? new TextTableRenderable(renderer, {
                ...options,
                border: false,
                content: [[[{ __isChunk: true, text: content }]]],
              })
            : kind === "terminal"
              ? new EmbeddedTerminalRenderable(renderer, options)
              : kind === "font"
                ? new ASCIIFontRenderable(renderer, { ...options, text: "ABCDE", font: "tiny" })
                : new TextRenderable(renderer, { ...options, content })
      if (node instanceof EmbeddedTerminalRenderable) node.write(content)
      renderer.root.add(node)
      node.translateX = 0.5
      node.translateY = -0.5
      await renderOnce()
      await mockMouse.pressDown(12, 2)
      await mockMouse.moveTo(13, 2)
      node.translateX = 1.25
      node.translateY = -1.25
      await renderOnce()
      await mockMouse.moveTo(18, 1)
      await mockMouse.release(18, 1)
      assert.equal(node.getSelectedText(), kind === "font" ? "CD" : "ijklmn")
    } finally {
      renderer.destroy()
      await renderer.closed
    }
  },
)

test("native selection retains detached anchor coordinates and surviving selected peers", async () => {
  const { renderer, renderOnce, mockMouse } = await createTestRenderer({
    width: 28,
    height: 8,
    useMouse: true,
    clock: new ManualClock(),
  })
  try {
    const text = new TextRenderable(renderer, {
      position: "absolute",
      left: 2,
      top: 1,
      width: 8,
      height: 1,
      content: "anchor",
    })
    renderer.root.add(text)
    await renderOnce()
    const parent = new BoxRenderable(renderer, { position: "absolute", left: 2, top: 2, width: 24, height: 4 })
    const peer = new TextRenderable(renderer, {
      position: "absolute",
      left: 12,
      top: 1,
      width: 8,
      height: 1,
      content: "survivor",
    })
    renderer.root.add(parent)
    parent.add(text)
    parent.add(peer)
    text.translateX = 1
    await renderOnce()
    await mockMouse.pressDown(text.x, text.y)
    await mockMouse.moveTo(peer.x + 3, peer.y)
    assert.equal(renderer.getSelection()?.selectedRenderables.length, 2)
    text.destroy()
    assert.equal(renderer.getSelection()?.getSelectedText(), "surv")
    const state = { x: text.x, y: text.y, bounds: renderer.getSelection()?.bounds }
    await mockMouse.moveTo(peer.x + 4, peer.y)
    await mockMouse.release(peer.x + 4, peer.y)
    assert.equal(renderer.getSelection()?.getSelectedText(), "survi")
    renderer.clearSelection()
    expectRenderSnapshot(state)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
