import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { OptimizedBuffer } from "../buffer.js"
import { Renderable } from "../Renderable.js"
import { RGBA } from "../lib/RGBA.js"
import { StyledText } from "../lib/styled-text.js"

import { CodeRenderable } from "../renderables/Code.js"
import { EmbeddedTerminalRenderable } from "../renderables/EmbeddedTerminal.js"
import { LineNumberRenderable } from "../renderables/LineNumberRenderable.js"
import { ArrowRenderable, ScrollBarRenderable } from "../renderables/ScrollBar.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { SyntaxStyle } from "../syntax-style.js"

import type { LineInfoProvider } from "../types.js"

const targets: TestRendererSetup[] = []
afterEach(async () => {
  for (const { renderer } of targets.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({ width: 20, height: 6 })
  targets.push(target)
  return target
}

test("retained text supports tab indicators and line-info subscriptions", async () => {
  const target = await setup()
  const text = new TextRenderable(target.renderer, {
    content: "a\tb",
    width: 8,
    height: 2,
    tabIndicator: ">",
    tabIndicatorColor: RGBA.fromIndex(3),
  })
  const changes: number[] = []
  const changed = () => changes.push(text.virtualLineCount)
  text.on("line-info-change", changed)
  target.renderer.root.add(text)
  await target.renderOnce()
  assert.ok(target.captureCharFrame().includes("a>"))
  text.content = "one\ntwo"
  assert.ok(changes.length > 0)
  text.content = "abcdef"
  const beforeResize = changes.length
  text.width = 3
  await target.renderOnce()
  assert.ok(changes.length > beforeResize)
  assert.equal(changes.at(-1), 2)
  text.off("line-info-change", changed)
  const afterRemoval = changes.length
  text.width = 8
  await target.renderOnce()
  assert.equal(changes.length, afterRemoval)
  text.tabIndicator = undefined
  text.content = "a\tb"
  await target.renderOnce()
  assert.ok(!target.captureCharFrame().includes(">"))
})

test.each(["on", "prependListener", "once"] as const)(
  "retained text reconciles %s line-info subscriptions after newListener reentry",
  async (subscribe) => {
    const target = await setup()
    const text = new TextRenderable(target.renderer, { content: "abcdef", width: 8, height: 2 })
    target.renderer.root.add(text)
    await target.renderOnce()
    const changes: number[] = []
    text.on("newListener", (event) => {
      if (event === "line-info-change") text.on("resize", () => {})
    })
    text[subscribe]("line-info-change", () => changes.push(text.virtualLineCount))
    text.width = 3
    await target.renderOnce()
    assert.deepEqual(changes, [2])
  },
)

test.each(["target", "add"] as const)(
  "retained gutters accept a custom line-info provider through %s",
  async (mode) => {
    class Provider extends Renderable implements LineInfoProvider {
      lines = ["one", "two"]
      get lineCount() {
        return this.lines.length
      }
      get virtualLineCount() {
        return this.lines.length
      }
      get scrollY() {
        return 0
      }
      get lineInfo() {
        return {
          lineStartCols: this.lines.map(() => 0),
          lineWidthCols: this.lines.map((line) => line.length),
          lineWidthColsMax: Math.max(...this.lines.map((line) => line.length)),
          lineSources: this.lines.map((_, index) => index),
          lineWraps: this.lines.map(() => 0),
        }
      }
      protected renderSelf(buffer: OptimizedBuffer): void {
        this.lines.forEach((line, row) => buffer.drawText(line, this.x, this.y + row, RGBA.fromInts(255, 255, 255)))
      }
    }
    const target = await setup()
    const provider = new Provider(target.renderer, { width: 8, height: 3 })
    let notifications = 0
    provider.on("line-info-change", () => notifications++)
    const gutter = new LineNumberRenderable(target.renderer, {
      width: 16,
      height: 3,
      target: mode === "target" ? provider : undefined,
    })
    if (mode === "add") gutter.add(provider)
    target.renderer.root.add(gutter)
    await target.renderOnce()
    assert.match(target.captureCharFrame(), /1 +one/)
    assert.match(target.captureCharFrame(), /2 +two/)
    assert.equal(notifications, 0)
    provider.lines.push("three")
    provider.emit("line-info-change")
    provider.requestRender()
    await target.renderOnce()
    assert.match(target.captureCharFrame(), /3 +three/)
    assert.equal(notifications, 1)
  },
)

test("retained arrows and scrollbar accept custom multi-cell glyphs and replacements", async () => {
  const target = await setup()
  const arrow = new ArrowRenderable(target.renderer, { direction: "up", height: 1, arrowChars: { up: "UP" } })
  const bar = new ScrollBarRenderable(target.renderer, {
    orientation: "horizontal",
    width: 12,
    height: 1,
    showArrows: true,
    arrowOptions: { arrowChars: { left: "<", right: ">" } },
  })
  bar.scrollSize = 100
  bar.viewportSize = 10
  target.renderer.root.add(arrow)
  target.renderer.root.add(bar)
  await target.renderOnce()
  assert.ok(target.captureCharFrame().startsWith("UP"))
  assert.ok(target.captureCharFrame().includes("<"))
  assert.ok(target.captureCharFrame().includes(">"))
  arrow.arrowChars = { up: "OK" }
  await target.renderOnce()
  assert.ok(target.captureCharFrame().startsWith("OK"))
})

test("retained text draws into an owned buffer at local coordinates without moving layout", async () => {
  const target = await setup()
  const text = new TextRenderable(target.renderer, {
    position: "absolute",
    left: 7,
    top: 3,
    width: 5,
    height: 1,
    content: new StyledText([
      { __isChunk: true, text: "A\u754c", fg: RGBA.fromIndex(5), attributes: 1 },
      { __isChunk: true, text: "B", fg: RGBA.defaultForeground() },
    ]),
  })
  target.renderer.root.add(text)
  await target.renderOnce()
  const buffer = OptimizedBuffer.create(8, 2, target.renderer.widthMethod, {
    owner: target.renderer.nativeScene!,
  })
  try {
    buffer.clear(RGBA.fromInts(0, 0, 0))
    text.drawToBuffer(buffer, 1, 0)
    assert.ok(new TextDecoder().decode(buffer.getRealCharBytes()).startsWith(" A\u754cB"))
    buffer.withBuffers((cells) => {
      assert.deepEqual([...cells.fg.slice(4, 8)], [...RGBA.fromIndex(5).buffer])
      assert.equal(cells.attributes[1] & 1, 1)
      assert.deepEqual([...cells.fg.slice(16, 20)], [...RGBA.defaultForeground().buffer])
    })
    assert.deepEqual([text.x, text.y], [7, 3])
    assert.throws(() => text.drawToBuffer(buffer, Number.NaN, 0))
    text.destroy()
    assert.throws(() => text.drawToBuffer(buffer, 0, 0))
  } finally {
    buffer.destroy()
  }
})

test.each(["Text", "Code", "Textarea"] as const)(
  "%s wide tab indicators preserve emitted terminal columns and selection",
  async (kind) => {
    const writes: string[] = []
    const stdout = new Writable({
      write(chunk, _encoding, complete) {
        writes.push(chunk.toString())
        complete()
      },
    })
    const target = await createTestRenderer({
      width: 8,
      height: 2,
      remote: true,
      stdout: stdout as NodeJS.WriteStream,
      bufferedOutput: "stdout",
    })
    targets.push(target)
    const options = { width: 8, height: 1, tabIndicator: "\u754c", wrapMode: "none" as const }
    const text =
      kind === "Text"
        ? new TextRenderable(target.renderer, { ...options, content: "A\tB" })
        : kind === "Code"
          ? new CodeRenderable(target.renderer, {
              ...options,
              content: "A\tB",
              syntaxStyle: SyntaxStyle.create(target.renderer.nativeScene!),
            })
          : new TextareaRenderable(target.renderer, { ...options, initialValue: "A\tB" })
    target.renderer.root.add(text)
    const mirror = await createTestRenderer({ width: 8, height: 2 })
    targets.push(mirror)
    const terminal = new EmbeddedTerminalRenderable(mirror.renderer, { width: 8, height: 2 })
    mirror.renderer.root.add(terminal)
    for (const selected of [false, true]) {
      if (selected) {
        target.renderer.startSelection(text, text.x + 1, text.y)
        target.renderer.updateSelection(text, text.x + 3, text.y, { finishDragging: true })
        assert.equal(text.getSelectedText(), "\tB")
      }
      await target.renderOnce()
      await target.renderer.nativeScene!.driver.whenPresented()
      terminal.write(writes.splice(0).join(""))
      await mirror.renderOnce()
      terminal["frameBuffer"]!.withBuffers(({ char }) => assert.equal(char[3], "B".codePointAt(0)))
      assert.equal(target.captureCharFrame().split("\n")[0], "A\u754cB    ")
    }
  },
)
