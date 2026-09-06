import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"

import { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"

import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CodeRenderable, type CodeOptions } from "../renderables/Code.js"

import { SyntaxStyle } from "../syntax-style.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TestWriteStream } from "../testing/test-streams.js"

const setups: TestRendererSetup[] = []
const styles: SyntaxStyle[] = []
const clients: MockTreeSitterClient[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
  for (const style of styles.splice(0)) style.destroy()
  for (const client of clients.splice(0)) await client.destroy()
})

async function setup(options: Partial<CodeOptions> = {}, stdout?: TestWriteStream) {
  const target = await createTestRenderer({
    width: 28,
    height: 8,
    useMouse: true,
    clock: new ManualClock(),
    ...(stdout
      ? { stdout: stdout as unknown as NodeJS.WriteStream, bufferedOutput: "stdout" as const, remote: true }
      : {}),
  })
  setups.push(target)
  const syntaxStyle = SyntaxStyle.fromStyles({ keyword: { fg: "#80c0ff", bold: true } }, target.renderer.nativeScene)
  styles.push(syntaxStyle)
  const client = new MockTreeSitterClient()
  clients.push(client)
  client.setMockResult({ highlights: [[0, 5, "keyword"]] })
  const code = new CodeRenderable(target.renderer, {
    position: "absolute",
    left: 2,
    top: 1,
    width: 18,
    height: 3,
    content: "alpha beta gamma",
    filetype: "typescript",
    syntaxStyle,
    treeSitterClient: client,
    ...options,
  })
  target.renderer.root.add(code)
  const errors: Error[] = []
  let frames = 0
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  target.renderer.on(CliRenderEvents.FRAME, () => frames++)
  return {
    ...target,
    code,
    client,
    async renderOnce() {
      const previous = frames
      await target.renderOnce()
      assert.deepEqual(errors, [])
      assert.equal(frames, previous + 1)
    },
  }
}

test("native Code keeps pending highlighting at its paint position without hiding layout or hits", async () => {
  const target = await setup({ drawUnstyledText: false, height: "auto", width: 8 })
  const { renderer, code, client } = target
  const calls: string[] = []
  const highlight = client.highlightOnce.bind(client)
  client.highlightOnce = (content, filetype) => {
    calls.push("highlight")
    return highlight(content, filetype)
  }
  renderer.root.add(
    new BoxRenderable(renderer, { width: 1, height: 1, zIndex: -1, renderBefore: () => calls.push("before") }),
  )
  renderer.root.add(
    new BoxRenderable(renderer, { width: 1, height: 1, zIndex: 1, renderBefore: () => calls.push("after") }),
  )
  code.renderBefore = () => calls.push("ignored-before")
  code.renderAfter = () => calls.push("ignored-after")
  await target.renderOnce()
  assert.deepEqual(calls, ["before", "highlight", "after"])
  assert.equal(target.captureCharFrame().trim(), "")
  assert.ok(code.height > 1)
  assert.equal(renderer.hitTest(code.x, code.y), code.num)
  client.resolveAllHighlightOnce()
  await code.highlightingDone
  await target.renderOnce()
  assert.ok(target.captureCharFrame().includes("alpha"))
})

test.each([false, true])(
  "native Code renderSelf overrides retain super drawing order when buffered=%s",
  async (buffered) => {
    const target = await setup({ filetype: undefined })
    target.code.destroy()
    const calls: string[] = []
    class CustomCode extends CodeRenderable {
      protected override renderSelf(buffer: OptimizedBuffer, deltaTime?: number): void {
        assert.equal(deltaTime, undefined)
        assert.ok(buffer === target.renderer.nextRenderBuffer, "Code self receives the main render buffer")
        calls.push("before")
        buffer.drawText("before", this.x, this.y, RGBA.fromHex("#ff0000"))
        super.renderSelf(buffer)
        calls.push("after")
        buffer.drawText("!", this.x, this.y, RGBA.fromHex("#00ff00"))
      }
    }
    const code = new CustomCode(target.renderer, {
      content: "alpha",
      position: "absolute",
      left: 2,
      top: 1,
      width: 8,
      height: 1,
      buffered,
      syntaxStyle: target.code.syntaxStyle,
      treeSitterClient: target.client,
    })
    target.renderer.root.add(code)
    await target.renderOnce()
    assert.deepEqual(calls, ["before", "after"])
    assert.ok(target.captureCharFrame().split("\n")[1].startsWith("  !lpha"))
    assert.equal(target.renderer.hitTest(code.x, code.y), code.num)
  },
)

test("native Code ignores late chunks after its Context closes without affecting a peer", async () => {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const target = await setup({
    onChunks: async (chunks) => {
      entered.resolve()
      await gate.promise
      return chunks
    },
  })
  const peer = await setup({ filetype: undefined })
  await target.renderOnce()
  target.client.resolveAllHighlightOnce()
  await entered.promise
  const pending = target.code.highlightingDone
  target.renderer.destroy()
  await target.renderer.closed
  gate.resolve()
  await pending
  assert.equal(target.code.isDestroyed, true)
  assert.equal(target.code.isHighlighting, false)
  await peer.renderOnce()
  assert.ok(peer.captureCharFrame().includes("alpha beta gamma"))
})

test("native Code owns highlighted URLs before asynchronous presentation", async () => {
  const writes: string[] = []
  const stdout = new TestWriteStream(28, 8)
  stdout._write = (chunk, _encoding, callback) => {
    writes.push(Buffer.from(chunk).toString("utf8"))
    callback()
  }
  const first = "https://example.test/code-before"
  const second = "https://example.test/code-after"
  const link = { url: first }
  const target = await setup(
    {
      content: "alpha",
      onChunks: (chunks) => chunks.map((chunk) => ({ ...chunk, link })),
    },
    stdout,
  )
  await target.renderer.setupTerminal()
  target.renderer.stdin.emit("data", Buffer.from("\x1bP>|kitty 0.41.0\x1b\\"))
  await target.renderOnce()
  target.client.resolveAllHighlightOnce()
  await target.code.highlightingDone
  link.url = second
  writes.length = 0
  await target.renderOnce()
  const urls = () => [...writes.join("").matchAll(/\x1b\]8;id=\d+;([^\x1b]*)\x1b\\/g)].map((match) => match[1])
  assert.deepEqual(urls(), [first])
  target.code.content = "alpha2"
  await target.renderOnce()
  target.client.resolveAllHighlightOnce()
  await target.code.highlightingDone
  writes.length = 0
  await target.renderOnce()
  assert.deepEqual(urls(), [second])
})

test.each(["none", "renderSelf"] as const)(
  "native buffered Code converts fractional translations with %s override",
  async (override) => {
    const target = await setup({ buffered: true, filetype: undefined, content: "alpha" })
    if (override === "renderSelf") {
      const renderSelf = target.code["renderSelf"]
      target.code["renderSelf"] = (buffer) => renderSelf.call(target.code, buffer)
    }
    for (const [translateX, translateY, x, y] of [
      [0.5, 0.5, 2.5, 1.5],
      [-2.5, -1.5, -0.5, -0.5],
    ]) {
      target.code.translateX = translateX
      target.code.translateY = translateY
      await target.renderOnce()
      assert.deepEqual([target.code.x, target.code.y], [x, y])
      assert.ok(target.captureCharFrame().split("\n")[Math.trunc(y)].slice(Math.trunc(x)).startsWith("alpha"))
    }
  },
)

test("native Code quantizes fractional viewport offsets without changing logical scroll", async () => {
  const target = await setup({
    content: "abcdef\nghijkl\nmnop",
    filetype: undefined,
    width: 3,
    height: 1,
    wrapMode: "none",
  })
  target.code.scrollX = 0.5
  assert.equal(target.code.scrollX, 0.5)
  target.code.scrollX = 0.75
  target.code.scrollY = 1.5
  await target.renderOnce()
  assert.equal(target.code.scrollX, 0.75)
  assert.equal(target.code.scrollY, 1.5)
  assert.equal(target.captureCharFrame().split("\n")[1].trim(), "ghi")
  target.code.scrollX = 1.5
  await target.renderOnce()
  assert.equal(target.code.scrollX, 1.5)
  assert.equal(target.captureCharFrame().split("\n")[1].trim(), "hij")
})
