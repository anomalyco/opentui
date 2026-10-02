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
