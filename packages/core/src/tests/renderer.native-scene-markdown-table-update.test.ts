import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { MarkdownRenderable } from "../renderables/Markdown.js"
import { TextTableRenderable } from "../renderables/TextTable.js"
import { SyntaxStyle } from "../syntax-style.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { resolveRenderLib } from "../zig.js"

test("native Markdown table updates keep cell styles buffer-owned and preserve selection", async () => {
  const target = await createTestRenderer({ width: 160, height: 50, useMouse: true, clock: new ManualClock() })
  const { renderer } = target
  const style = SyntaxStyle.fromStyles(
    { default: { fg: "#65c8ff" }, "markup.strong": { bold: true }, "markup.raw": { fg: "#ffd166" } },
    renderer.nativeScene,
  )
  const lib = resolveRenderLib()
  const sharedStyles = [spyOn(lib, "createContextSyntaxStyle"), spyOn(lib, "contextTextBufferSetSyntaxStyle")]
  const created = spyOn(lib, "createContextTextBuffer")
  const destroyed = spyOn(lib, "destroyContextTextBuffer")
  try {
    // The frozen wide baseline changes two cells in each of fourteen data rows.
    const unicode = [
      "alpha \u4e16\u754c e\u0301 \ud83d\udc69\u200d\ud83d\udcbb \ud83c\uddfa\ud83c\uddf3 wrap at the cell boundary ",
      "bravo \u65e5\u672c a\u0308 \ud83d\udc68\u200d\ud83d\ude80 \ud83c\uddef\ud83c\uddf5 different wrapped text ",
    ]
    const content = [0, 1].map(
      (phase) =>
        "| Name | Status | Detail |\n| --- | --- | --- |\n" +
        Array.from(
          { length: 14 },
          (_, i) => `| **item ${i}** | ${phase ? "ready" : "pending"} | \`${i}\` ${unicode[phase]} |`,
        ).join("\n"),
    )
    const markdown = new MarkdownRenderable(renderer, {
      width: "100%",
      content: content[0],
      syntaxStyle: style,
      tableOptions: { style: "grid", widthMode: "full", wrapMode: "word", cellPadding: 0 },
    })
    renderer.root.add(markdown)
    await target.renderOnce()
    const table = markdown.getChildren()[0]
    assert.ok(table instanceof TextTableRenderable)
    const lines = target.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("item 0"))
    const x = lines[y].indexOf("item 0")
    renderer.startSelection(table, x, y)
    renderer.updateSelection(table, x + 5, y, { finishDragging: true })
    for (let iteration = 0; iteration < 6; iteration++) {
      const phase = (iteration + 1) % 2
      markdown.content = content[phase]
      await target.renderOnce()
      assert.equal(markdown.getChildren()[0], table)
      assert.equal(table.getSelectedText(), "item 0")
      const frame = target.captureCharFrame()
      const word = phase ? "bravo" : "alpha"
      assert.ok(frame.includes(phase ? "ready" : "pending"))
      const detailX = frame.split("\n")[y].indexOf(word) - 2
      assert.ok(detailX >= 0)
      renderer.currentRenderBuffer.withBuffers(({ fg, attributes }) => {
        assert.equal(attributes[y * 160 + x] & 1, 1)
        const offset = (y * 160 + detailX) * 4
        assert.deepEqual(fg.slice(offset, offset + 4), style.getStyle("markup.raw")!.fg!.buffer)
      })
    }
    assert.equal(created.mock.calls.length, 45)
    markdown.destroyRecursively()
    assert.equal(destroyed.mock.calls.length, created.mock.calls.length)
    for (const call of sharedStyles) assert.equal(call.mock.calls.length, 0)
  } finally {
    for (const call of [...sharedStyles, created, destroyed]) call.mockRestore()
    renderer.root.getChildren().forEach((child) => child.destroyRecursively())
    style.destroy()
    renderer.destroy()
    await renderer.closed
  }
})
