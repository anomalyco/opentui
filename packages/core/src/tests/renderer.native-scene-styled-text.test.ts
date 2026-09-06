import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable } from "../Renderable.js"
import { RGBA } from "../lib/RGBA.js"
import { StyledText } from "../lib/styled-text.js"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TextAttributes } from "../types.js"

const setups: TestRendererSetup[] = []
afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup(content: StyledText) {
  const target = await createTestRenderer({ width: 24, height: 8 })
  setups.push(target)
  const text = new TextRenderable(target.renderer, { content, width: 5, selectable: false, flexShrink: 0 })
  target.renderer.root.add(text)
  await target.renderOnce()
  return { ...target, text }
}

function snapshot(target: Awaited<ReturnType<typeof setup>>) {
  const { text } = target
  return {
    cells: target.captureSpans(),
    plainText: text.plainText,
    textLength: text.textLength,
    lineCount: text.lineCount,
    virtualLineCount: text.virtualLineCount,
    lineInfo: text.lineInfo,
    scrollWidth: text.scrollWidth,
    scrollHeight: text.scrollHeight,
    geometry: text.getLayout(),
    hits: Array.from({ length: target.renderer.height * target.renderer.width }, (_, index) =>
      target.renderer.hitTest(index % target.renderer.width, Math.floor(index / target.renderer.width)),
    ),
  }
}

test("native StyledText retains mutable projection identity and skips same-object assignment", async () => {
  const color = RGBA.fromInts(255, 0, 0)
  const chunk = { __isChunk: true as const, text: "before", fg: color, attributes: TextAttributes.BOLD }
  const content = new StyledText([chunk])
  const target = await setup(content)
  const { text } = target
  const before = snapshot(target)
  chunk.text = "after"
  chunk.attributes = TextAttributes.ITALIC
  color.r = 0
  color.g = 1
  content.chunks.push({ __isChunk: true, text: " appended" })
  text.content = content
  assert.equal(text.content, content)
  assert.equal(text.chunks, content.chunks)
  assert.equal(text.chunks[0], chunk)
  assert.equal(text.chunks[0].fg, color)
  await target.renderOnce()
  assert.deepEqual(snapshot(target), before)
  const replacement = new StyledText(content.chunks)
  text.content = replacement
  await target.renderOnce()
  assert.equal(text.content, replacement)
  assert.equal(text.chunks, content.chunks)
  assert.equal(text.plainText, "after appended")
  const span = target.captureSpans().lines[0].spans[0]
  assert.equal(span.text, "after")
  assert.deepEqual(span.fg.toInts(), [0, 255, 0, 255])
  assert.equal(span.attributes, TextAttributes.ITALIC)
})

test("native StyledText rejection preserves cells, metrics, hits, subscriptions and constructor ownership", async () => {
  const content = new StyledText([{ __isChunk: true, text: "accepted text", fg: RGBA.fromInts(20, 200, 140) }])
  const target = await setup(content)
  const { text } = target
  const before = snapshot(target)
  const registered = new Set(Renderable.renderablesByNumber.keys())
  let changes = 0
  text.on("line-info-change", () => changes++)
  const invalid: unknown[] = [
    { chunks: [] },
    { [Symbol.for("@opentui/core/StyledText")]: 1, chunks: [] },
    new StyledText(null as never),
    new StyledText([null as never]),
    new StyledText([{} as never]),
    new StyledText([{ __isChunk: true, text: 1 } as never]),
  ]
  for (const value of ["", "visible"]) {
    for (const link of [null, {}, { url: 1 }, "https://example.test/"]) {
      invalid.push(new StyledText([{ __isChunk: true, text: value, link: link as never }]))
    }
    for (const attributes of [-1, 0.5, NaN, 0x100, 0x1_0000_0000]) {
      invalid.push(new StyledText([{ __isChunk: true, text: value, attributes }]))
    }
    for (const fg of [{ buffer: [0, 0, 0, 256] }, { buffer: [1, 2, 3] }]) {
      invalid.push(new StyledText([{ __isChunk: true, text: value, fg: fg as unknown as RGBA }]))
    }
  }
  for (const rejected of invalid) {
    assert.throws(() => {
      text.content = rejected as StyledText
    })
    assert.equal(text.content, content)
    assert.equal(text.chunks, content.chunks)
    assert.deepEqual(snapshot(target), before)
    assert.throws(() => new TextRenderable(target.renderer, { content: rejected as StyledText }))
    assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), registered)
    await target.renderOnce()
    assert.deepEqual(snapshot(target), before)
    assert.equal(changes, 0)
  }
  text.content = new StyledText([{ __isChunk: true, text: "recovered" }])
  assert.equal(changes, 1)
  await target.renderOnce()
  assert.equal(text.plainText, "recovered")
})
