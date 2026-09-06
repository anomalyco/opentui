import { test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { TestWriteStream } from "../testing/test-streams.js"

test("prefix destruction skips upcoming nodes without losing painted graphemes", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 12, height: 4 })
  const calls: string[] = []
  const text = new TextRenderable(renderer, { content: "e\u0301", selectable: false, width: 1, height: 1 })
  const upcoming = new BoxRenderable(renderer, { width: 1, height: 1, renderBefore: () => calls.push("destroyed") })
  const box = new BoxRenderable(renderer, {
    width: 1,
    height: 1,
    renderBefore(buffer) {
      calls.push("before")
      text.destroy()
      upcoming.destroy()
      assert.equal(buffer.getSpanLines()[0].spans[0].text.trimEnd(), "e\u0301")
    },
    renderAfter: () => calls.push("after"),
  })
  renderer.root.add(text)
  renderer.root.add(box)
  renderer.root.add(upcoming)
  try {
    await renderOnce()
    assert.deepEqual(calls, ["before", "after"])
    assert.equal(captureCharFrame().trimEnd(), "e\u0301")
    assert.notEqual(renderer.hitTest(0, 0), text.num)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

class HeldOutput extends TestWriteStream {
  hold = false
  complete: ((error?: Error | null) => void) | undefined

  override _write(_chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.hold) this.complete = callback
    else callback()
  }
}

test.each(["success", "failure"] as const)(
  "prefix changes publish only after completed output: %s",
  async (outcome) => {
    const fail = outcome === "failure"
    const stdout = new HeldOutput(12, 4)
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 12,
      height: 4,
      clock: new ManualClock(),
      stdout: stdout as unknown as NodeJS.WriteStream,
      bufferedOutput: "stdout",
    })
    let hooks = 0
    let frames = 0
    const errors: unknown[] = []
    renderer.on(CliRenderEvents.FRAME, () => frames++)
    renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
    const box = new BoxRenderable(renderer, {
      position: "absolute",
      width: 1,
      height: 1,
      backgroundColor: "red",
      renderAfter(buffer) {
        hooks++
        buffer.withBuffers(({ char }) => {
          char[this.x] = 88
        })
      },
    })
    renderer.root.add(box)
    try {
      await renderOnce()
      assert.equal(captureCharFrame().trimEnd(), "X")
      const previousHit = renderer.hitTest(4, 0)
      stdout.hold = true
      box.left = 4
      let returned = false
      const pending = renderOnce().then(() => {
        returned = true
      })
      for (let turn = 0; turn < 32 && !stdout.complete; turn++) await setImmediate()
      assert.ok(stdout.complete)
      assert.equal(returned, false)
      assert.equal(hooks, 2)
      assert.equal(frames, 1)
      assert.equal(renderer.hitTest(0, 0), box.num)
      assert.equal(renderer.hitTest(4, 0), previousHit)
      stdout.hold = false
      const complete = stdout.complete
      stdout.complete = undefined
      complete(fail ? new Error("prefix output failure") : undefined)
      await pending
      assert.equal(hooks, 2, "output completion must not replay paint hooks")
      if (fail) {
        assert.equal(frames, 1)
        assert.equal(box.isDestroyed, true)
        assert.ok(errors.length > 0)
      } else {
        assert.deepEqual(errors, [])
        assert.equal(frames, 2)
        assert.equal(captureCharFrame().trimEnd(), "    X")
        assert.equal(renderer.hitTest(4, 0), box.num)
      }
    } finally {
      stdout.hold = false
      const complete = stdout.complete
      stdout.complete = undefined
      complete?.()
      renderer.destroy()
      if (fail) await assert.rejects(renderer.closed, /prefix output failure/)
      else await renderer.closed
    }
  },
)
