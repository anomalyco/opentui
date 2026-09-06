import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { StyledText } from "../lib/styled-text.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TestWriteStream } from "../testing/test-streams.js"
import { getLinkId } from "../utils.js"

const setups: TestRendererSetup[] = []
const kitty = "\x1bP>|kitty 0.41.0\x1b\\"

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup(width = 8, height = 2) {
  const writes: string[] = []
  const stdout = new TestWriteStream(width, height)
  stdout._write = (chunk, _encoding, callback) => {
    writes.push(Buffer.from(chunk).toString("utf8"))
    callback()
  }
  const target = await createTestRenderer({
    width,
    height,
    stdout: stdout as unknown as NodeJS.WriteStream,
    bufferedOutput: "stdout",
    remote: true,
    clock: new ManualClock(),
  })
  setups.push(target)
  await target.renderer.setupTerminal()
  writes.length = 0
  return { ...target, take: () => writes.splice(0).join("") }
}

function openings(output: string) {
  return [...output.matchAll(/\x1b\]8;id=(\d+);([^\x1b]*)\x1b\\/g)].map((match) => ({
    id: Number(match[1]),
    url: match[2],
  }))
}

function ids(target: TestRendererSetup) {
  return target.renderer.currentRenderBuffer.withBuffers(({ attributes }) => Array.from(attributes, getLinkId))
}

test("StyledText emits OSC8 only after terminal hyperlink capability detection", async () => {
  const target = await setup()
  const url = "https://example.test/a"
  const text = new TextRenderable(target.renderer, {
    selectable: false,
    content: new StyledText([{ __isChunk: true, text: "link", link: { url } }]),
  })
  target.renderer.root.add(text)
  await target.renderOnce()
  assert.deepEqual(openings(target.take()), [])
  const accepted = ids(target)
  assert.ok(accepted[0] > 0)
  target.renderer.stdin.emit("data", Buffer.from(kitty))
  await target.renderOnce()
  const output = target.take()
  assert.deepEqual(openings(output), [{ id: accepted[0], url }])
  assert.ok(output.includes("\x1b]8;;\x1b\\"), "the renderer must close the hyperlink")
  assert.deepEqual(ids(target), accepted)
})

test.each([
  ["0", "", false],
  ["512", "https://example.test/" + "\u00e9".repeat(245) + "x", true],
  ["513", "https://example.test/" + "\u00e9".repeat(246), false],
] as const)("StyledText URL boundary: %s UTF-8 bytes", async (bytes, url, linked) => {
  assert.equal(Buffer.byteLength(url), Number(bytes))
  const target = await setup()
  target.renderer.stdin.emit("data", Buffer.from(kitty))
  const text = new TextRenderable(target.renderer, {
    selectable: false,
    content: new StyledText([{ __isChunk: true, text: "link", link: { url } }]),
  })
  target.renderer.root.add(text)
  await target.renderOnce()
  const linkId = ids(target)[0]
  assert.equal(linkId > 0, linked)
  assert.deepEqual(openings(target.take()), linked ? [{ id: linkId, url }] : [])
  assert.ok(target.captureCharFrame().startsWith("link"))
})

test("StyledText ignores same-object URL edits but ingests a URL-only replacement", async () => {
  const target = await setup()
  target.renderer.stdin.emit("data", Buffer.from(kitty))
  const link = { url: "https://example.test/before" }
  const content = new StyledText([{ __isChunk: true, text: "link", link }])
  const text = new TextRenderable(target.renderer, { selectable: false, content })
  target.renderer.root.add(text)
  await target.renderOnce()
  const accepted = ids(target)
  assert.deepEqual(openings(target.take()), [{ id: accepted[0], url: link.url }])

  link.url = "https://example.test/after"
  text.content = content
  assert.equal(text.content, content)
  assert.equal(text.chunks[0].link, link)
  target.renderer.stdin.emit("data", Buffer.from(kitty))
  await target.renderOnce()
  assert.deepEqual(ids(target), accepted)
  assert.deepEqual(openings(target.take()), [{ id: accepted[0], url: "https://example.test/before" }])

  text.content = new StyledText(content.chunks)
  await target.renderOnce()
  const replaced = ids(target)
  assert.notEqual(replaced[0], accepted[0])
  assert.deepEqual(openings(target.take()), [{ id: replaced[0], url: link.url }])
  assert.equal(text.plainText, "link")
})

test.each([
  ["combining", ["e", "\u0301X", "Y"], [0, 1, 2], [0, 1, 2]],
  ["ZWJ", ["\ud83d\udc69", "\u200d\ud83d\udcbb", "WXYZ"], [0, 0, 1, 1, 1, 1], [0, 2]],
] as const)(
  "StyledText split %s links follow concatenated width-cursor chunk ranges",
  async (_name, parts, ranges, urlIndexes) => {
    const target = await setup(ranges.length, 1)
    target.renderer.stdin.emit("data", Buffer.from(kitty))
    const urls = ["https://example.test/a", "https://example.test/b", "https://example.test/c"]
    const text = new TextRenderable(target.renderer, {
      selectable: false,
      wrapMode: "none",
      content: new StyledText(parts.map((text, index) => ({ __isChunk: true, text, link: { url: urls[index] } }))),
    })
    target.renderer.root.add(text)
    await target.renderOnce()
    const emitted = openings(target.take())
    assert.deepEqual(
      emitted.map(({ url }) => url),
      urlIndexes.map((index) => urls[index]),
    )
    assert.deepEqual(
      ids(target),
      ranges.map((index) => emitted[index].id),
    )
    assert.equal(target.captureCharFrame(), parts.join("") + "\n")
  },
)
