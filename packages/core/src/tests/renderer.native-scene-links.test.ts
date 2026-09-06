import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { StyledText } from "../lib/styled-text.js"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextNodeRenderable } from "../renderables/TextNode.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TestWriteStream } from "../testing/test-streams.js"
import { getLinkId } from "../utils.js"
import { resolveRenderLib } from "../zig.js"

const kitty = "\x1bP>|kitty 0.41.0\x1b\\"
const firstUrl = "https://example.test/first"
const secondUrl = "https://example.test/second"

class LinkOutput extends TestWriteStream {
  writes: string[] = []
  hold = false
  complete: ((error?: Error | null) => void) | undefined

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk).toString("utf8"))
    if (this.hold) this.complete = callback
    else callback()
  }

  take() {
    return this.writes.splice(0).join("")
  }

  release(error?: Error) {
    this.hold = false
    const complete = this.complete
    this.complete = undefined
    complete?.(error)
  }
}

async function setup() {
  const output = new LinkOutput(8, 4)
  const target = await createTestRenderer({
    width: 8,
    height: 4,
    stdout: output as unknown as NodeJS.WriteStream,
    bufferedOutput: "stdout",
    remote: true,
    useMouse: true,
    clock: new ManualClock(),
  })
  try {
    await target.renderer.setupTerminal()
  } catch (error) {
    target.renderer.destroy()
    await target.renderer.closed.catch(() => {})
    throw error
  }
  output.take()
  return {
    ...target,
    output,
    async close() {
      output.release()
      target.renderer.destroy()
      await target.renderer.closed
    },
  }
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

function linked(url: string) {
  return new StyledText([{ __isChunk: true, text: "e\u0301", link: { url } }])
}

test("inline links inherit, override and remove URLs on the production renderer", async () => {
  {
    const target = await setup()
    try {
      target.renderer.stdin.emit("data", Buffer.from(kitty))
      const text = new TextRenderable(target.renderer, { selectable: false })
      const parent = TextNodeRenderable.fromString("A", { link: { url: firstUrl } })
      const child = TextNodeRenderable.fromString("B", { link: { url: secondUrl } })
      parent.add(child)
      parent.add("C")
      text.add(parent)
      target.renderer.root.add(text)
      await target.renderOnce()
      const emitted = openings(target.output.take())
      const urls = new Map(emitted.map(({ id, url }) => [id, url]))
      assert.deepEqual(
        ids(target)
          .slice(0, 3)
          .map((id) => urls.get(id)),
        [firstUrl, secondUrl, firstUrl],
      )
      child.link = undefined
      parent.link = { url: secondUrl }
      await target.renderOnce()
      const inherited = openings(target.output.take())
      assert.deepEqual(
        inherited.map(({ url }) => url),
        [secondUrl],
      )
      assert.deepEqual(ids(target).slice(0, 3), Array(3).fill(inherited[0].id))
      parent.link = undefined
      await target.renderOnce()
      assert.deepEqual(ids(target).slice(0, 3), [0, 0, 0])
      assert.ok(target.captureCharFrame().startsWith("ABC"))
    } finally {
      await target.close()
    }
  }
})

test("native links own transient ABI URL bytes before emitting OSC8", async () => {
  const target = await setup()
  const symbols = (
    resolveRenderLib() as unknown as {
      opentui: { symbols: { ot_scene_set_styled_text_with_links(...args: unknown[]): number } }
    }
  ).opentui.symbols
  const submitted = spyOn(symbols, "ot_scene_set_styled_text_with_links")
  try {
    target.renderer.stdin.emit("data", Buffer.from(kitty))
    const text = new TextRenderable(target.renderer, { selectable: false, content: linked(firstUrl) })
    target.renderer.root.add(text)
    const urls = submitted.mock.calls.at(-1)?.[6]
    assert.ok(urls instanceof Uint8Array)
    assert.equal(new TextDecoder().decode(urls), firstUrl)
    urls.fill(0)
    await target.renderOnce()
    assert.deepEqual(openings(target.output.take()), [{ id: ids(target)[0], url: firstUrl }])
  } finally {
    submitted.mockRestore()
    await target.close()
  }
})

test.each(["replace", "destroy"] as const)(
  "native painted link scopes retain URLs after document %s",
  async (operation) => {
    const target = await setup()
    try {
      target.renderer.stdin.emit("data", Buffer.from(kitty))
      const text = new TextRenderable(target.renderer, { selectable: false, content: linked(firstUrl) })
      target.renderer.root.add(text)
      let paintedId = 0
      target.renderer.addPostProcessFn((buffer) => {
        buffer.withBuffers(({ attributes }) => {
          paintedId = getLinkId(attributes[0])
          assert.ok(paintedId > 0)
          if (operation === "destroy") text.destroy()
          else text.content = "plain"
          buffer.withBuffers((nested) => assert.equal(getLinkId(nested.attributes[0]), paintedId))
          assert.ok(buffer.getSpanLines()[0].spans[0].text.startsWith("e\u0301"))
        })
      })
      await target.renderOnce()
      assert.deepEqual(openings(target.output.take()), [{ id: paintedId, url: firstUrl }])
      assert.equal(ids(target)[0], paintedId)
      assert.ok(target.captureCharFrame().startsWith("e\u0301"))
      if (operation === "destroy") assert.equal(target.renderer.hitTest(0, 0), 0)
      target.renderer.clearPostProcessFns()
      await target.renderOnce()
      assert.ok(ids(target).every((id) => id === 0))
      assert.deepEqual(openings(target.output.take()), [])
    } finally {
      await target.close()
    }
  },
)

test("native ordered prefixes retain painted URLs and update a later linked node this frame", async () => {
  const target = await setup()
  try {
    target.renderer.stdin.emit("data", Buffer.from(kitty))
    const before = new TextRenderable(target.renderer, { selectable: false, content: linked(firstUrl), height: 1 })
    const after = new TextRenderable(target.renderer, { selectable: false, content: linked(firstUrl), height: 1 })
    let paintedId = 0
    const hook = new BoxRenderable(target.renderer, {
      height: 1,
      renderBefore(buffer) {
        buffer.withBuffers(({ attributes }) => {
          paintedId = getLinkId(attributes[0])
          assert.ok(paintedId > 0)
          before.destroy()
          after.content = linked(secondUrl)
          assert.equal(getLinkId(attributes[0]), paintedId)
        })
      },
    })
    target.renderer.root.add(before)
    target.renderer.root.add(hook)
    target.renderer.root.add(after)
    await target.renderOnce()
    assert.deepEqual(openings(target.output.take()), [
      { id: paintedId, url: firstUrl },
      { id: ids(target)[16], url: secondUrl },
    ])
    assert.ok(ids(target)[16] > 0)
    assert.equal(target.renderer.hitTest(0, 0), 0)
    assert.equal(target.renderer.hitTest(0, 2), after.num)
  } finally {
    await target.close()
  }
})

test.each(["success", "failure"] as const)(
  "native link output publishes only completed FRAME and hits: %s",
  async (result) => {
    const fail = result === "failure"
    const target = await setup()
    const { renderer, output } = target
    const logged = spyOn(console, "error").mockImplementation(() => {})
    let failure: Error | undefined
    try {
      renderer.stdin.emit("data", Buffer.from(kitty))
      const text = new TextRenderable(renderer, {
        selectable: false,
        content: linked(firstUrl),
        position: "absolute",
        width: 2,
        height: 1,
      })
      renderer.root.add(text)
      let frames = 0
      renderer.on(CliRenderEvents.FRAME, () => frames++)
      await target.renderOnce()
      assert.deepEqual(openings(output.take()), [{ id: ids(target)[0], url: firstUrl }])
      const previousHit = renderer.hitTest(4, 0)
      output.hold = true
      text.left = 4
      text.content = linked(secondUrl)
      let completed = false
      const pending = target.renderOnce().then(() => {
        completed = true
      })
      for (let turn = 0; turn < 32 && !output.complete; turn++) await setImmediate()
      assert.ok(output.complete, "the real renderer must reach the held Writable")
      assert.equal(completed, false)
      assert.equal(frames, 1)
      assert.equal(renderer.hitTest(0, 0), text.num)
      assert.equal(renderer.hitTest(4, 0), previousHit)
      const emitted = openings(output.take())
      assert.equal(emitted.length, 1)
      assert.equal(emitted[0].url, secondUrl)
      text.content = linked("https://example.test/later")
      const observing = fail ? target.renderOnce() : Promise.resolve()
      failure = fail ? new Error("link output failure") : undefined
      output.release(failure)
      await pending
      await observing
      if (fail) {
        assert.equal(frames, 1)
        assert.equal(text.isDestroyed, true)
        assert.throws(() => renderer.hitTest(0, 0), /destroyed/)
        assert.ok(logged.mock.calls.length > 0)
      } else {
        assert.equal(frames, 2)
        assert.equal(renderer.hitTest(4, 0), text.num)
        assert.notEqual(renderer.hitTest(0, 0), text.num)
        assert.equal(ids(target)[4], emitted[0].id)
        await target.renderOnce()
        assert.deepEqual(openings(output.take()), [{ id: ids(target)[4], url: "https://example.test/later" }])
      }
    } finally {
      logged.mockRestore()
      if (failure) await assert.rejects(target.close(), /link output failure/)
      else await target.close()
    }
  },
)
