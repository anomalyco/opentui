import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { TextRenderable } from "../renderables/Text.js"
import { StyledText } from "../lib/styled-text.js"
import { TextAttributes } from "../types.js"
import { NativeSessionRenderStatus, resolveRenderLib } from "../zig.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({ width: 28, height: 12, clock: new ManualClock() })
  setups.push(target)
  return target
}

test("native text resets optional attributes to the default", async () => {
  const target = await setup()
  const text = new TextRenderable(target.renderer, { content: "text", attributes: undefined })
  target.renderer.root.add(text)
  await target.renderOnce()
  assert.equal(text.attributes, 0)
  assert.equal(target.captureSpans().lines[0].spans[0].attributes, 0)

  for (const attributes of [undefined, TextAttributes.BOLD, undefined]) {
    text.attributes = attributes
    await target.renderOnce()
    assert.equal(text.attributes, attributes ?? 0)
    assert.ok(target.captureCharFrame().startsWith("text"))
    assert.equal(target.captureSpans().lines[0].spans[0].attributes, attributes ?? 0)
  }
})

test("native pre-layout wrap changes do not acquire viewport constraints from color mutations", async () => {
  const target = await setup()
  const text = new TextRenderable(target.renderer, {
    selectable: false,
    content: "abcdef",
    width: 0.5,
    height: 1,
    wrapMode: "char",
  })
  text.wrapMode = "word"
  text.fg = "red"
  assert.equal(text.virtualLineCount, 1)
  text.scrollY = 99
  assert.equal(text.scrollY, 0)
  target.renderer.root.add(text)
  await target.renderOnce()
  assert.ok(target.captureCharFrame().startsWith("a"))
})

test.each(["x", "y"] as const)("native text preserves fractional pre-layout %s scroll projections", async (axis) => {
  const target = await setup()
  const text = new TextRenderable(target.renderer, {
    selectable: false,
    content: "abcdef",
    width: axis === "x" ? 0.5 : 5,
    height: axis === "x" ? 1 : 0.5,
    wrapMode: axis === "x" ? "none" : "char",
  })
  if (axis === "x") text.scrollX = 99
  else text.scrollY = 99
  assert.equal(axis === "x" ? text.scrollX : text.scrollY, axis === "x" ? 5.5 : 1.5)
  text.fg = "red"
  target.renderer.root.add(text)
  await target.renderOnce()
  assert.ok(target.captureCharFrame().startsWith("f"))
})

test("native text distinguishes logical scroll changes within one display cell", async () => {
  const target = await setup()
  const text = new TextRenderable(target.renderer, {
    selectable: false,
    content: "abcdef",
    width: 0.5,
    height: 1,
    wrapMode: "char",
  })
  text.scrollX = 0.5
  text.wrapMode = "word"
  assert.equal(text.virtualLineCount, 1)
  text.scrollX = 0.75
  assert.equal(text.virtualLineCount, 6)
  text.scrollY = 99
  target.renderer.root.add(text)
  await target.renderOnce()
  assert.ok(target.captureCharFrame().startsWith("f"))
})

test.each([false, true])("native text documents exceed the offscreen draw byte budget (styled=%s)", async (styled) => {
  const target = await setup()
  const content = "x".repeat(70_000) + "\nTAIL"
  const text = new TextRenderable(target.renderer, {
    selectable: false,
    content: styled ? new StyledText([{ __isChunk: true, text: content }]) : content,
    width: 5,
    height: 2,
    wrapMode: "none",
  })
  target.renderer.root.add(text)
  await target.renderOnce()
  assert.equal(text.plainText, content)
  assert.equal(text.textLength, 70_004)
  assert.ok(target.captureCharFrame().startsWith("xxxxx"))
  assert.ok(target.captureCharFrame().split("\n")[1].startsWith("TAIL"))
  const replacement = content + " appended"
  text.content = styled ? new StyledText([{ __isChunk: true, text: replacement }]) : replacement
  await target.renderOnce()
  assert.equal(text.plainText, replacement)
  text.clear()
  await target.renderOnce()
  assert.equal(target.captureCharFrame().trim(), "")
})

test("native text resources survive peer teardown and release detached nodes", async () => {
  const a = await setup()
  const b = await setup()
  const first = new TextRenderable(a.renderer, { content: "first \ud83d\udc69\u200d\ud83d\udcbb" })
  const second = new TextRenderable(b.renderer, { content: "second \u4e16\u754c" })
  a.renderer.root.add(first)
  b.renderer.root.add(second)
  await a.renderOnce()
  await b.renderOnce()
  const before = b.captureSpans()
  a.renderer.root.remove(first)
  a.renderer.destroy()
  await a.renderer.closed
  assert.equal(first.isDestroyed, true)
  await b.renderOnce()
  assert.deepEqual(b.captureSpans(), before)
  second.content = "still alive"
  await b.renderOnce()
  assert.ok(b.captureCharFrame().startsWith("still alive"))
})

test("native text submission rejection preserves previous cells and hits until retry", async () => {
  const target = await setup()
  const text = new TextRenderable(target.renderer, {
    content: "before",
    position: "absolute",
    width: 8,
    height: 2,
  })
  target.renderer.root.add(text)
  await target.renderOnce()
  const before = target.captureSpans()
  const frameCount = target.renderer.getStats().nativeFrameCount
  text.content = "after \u4e16\u754c"
  text.left = 10
  const rejected = spyOn(resolveRenderLib(), "sceneFrameCommit").mockImplementation(
    () => NativeSessionRenderStatus.Failed,
  )
  const logged = spyOn(console, "error").mockImplementation(() => {})
  try {
    await target.renderOnce()
    assert.deepEqual(target.captureSpans(), before)
    assert.equal(target.renderer.hitTest(0, 0), text.num)
    assert.notEqual(target.renderer.hitTest(10, 0), text.num)
    assert.equal(target.renderer.getStats().nativeFrameCount, frameCount)
  } finally {
    rejected.mockRestore()
    logged.mockRestore()
  }
  await target.renderOnce()
  assert.ok(target.captureCharFrame().includes("after"))
  assert.equal(target.renderer.hitTest(10, 0), text.num)
})

test("native text content growth and shrinkage schedule frames and reposition the following sibling", async () => {
  const target = await createTestRenderer({ width: 20, height: 8, useMouse: false })
  setups.push(target)
  const text = new TextRenderable(target.renderer, {
    selectable: false,
    content: "short",
    width: 8,
    flexShrink: 0,
    wrapMode: "char",
  })
  const tail = new TextRenderable(target.renderer, { selectable: false, content: "tail", flexShrink: 0 })
  target.renderer.root.add(text)
  target.renderer.root.add(tail)
  await target.flush()
  assert.equal(text.height, 1)
  assert.equal(tail.y, 1)
  for (const { content, height, rows } of [
    { content: "abcdefghijklmnopq", height: 3, rows: ["abcdefgh", "ijklmnop", "q", "tail"] },
    { content: "x", height: 1, rows: ["x", "tail", "", ""] },
  ]) {
    const frames = target.getNativeStats().nativeFrameCount
    text.content = content
    await target.flush()
    assert.ok(target.getNativeStats().nativeFrameCount > frames, "content assignment must schedule a completed frame")
    assert.equal(text.height, height)
    assert.equal(tail.y, height)
    assert.deepEqual(
      target
        .captureCharFrame()
        .split("\n")
        .slice(0, 4)
        .map((line) => line.trimEnd()),
      rows,
    )
  }
})
