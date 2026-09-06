import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { setImmediate, setTimeout } from "node:timers/promises"
import { NativeSession } from "../NativeSession.js"
import { CliRenderEvents } from "../renderer.js"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { NativeSessionRenderStatus } from "../zig.js"

test.each(["flush", "waitForVisualIdle", "waitForFrame", "waitFor"] as const)(
  "passive %s observes an output-blocked render retry",
  async (method) => {
    const writes: Buffer[] = []
    let hold = false
    let complete: (() => void) | undefined
    const stdout = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes.push(Buffer.from(chunk))
        if (hold) complete = callback
        else callback()
      },
    })
    const release = () => {
      hold = false
      const callback = complete
      complete = undefined
      callback?.()
    }
    const driver = new NativeSession(stdout, {
      output: { chunkSize: 4096, spanCapacity: 16, maxBytes: 65536n, controlCapacity: 4096 },
    })
    let skipped = false
    const original = driver.render.bind(driver)
    const render = spyOn(driver, "render").mockImplementation((...args) => {
      const result = original(...args)
      skipped ||= result === NativeSessionRenderStatus.Skipped
      return result
    })
    let target: TestRendererSetup | undefined
    let wait: Promise<unknown> | undefined
    try {
      target = await createTestRenderer({
        stdout: stdout as NodeJS.WriteStream,
        bufferedOutput: "stdout",
        nativeSession: driver,
        width: 24,
        height: 4,
        maxFps: Number.POSITIVE_INFINITY,
        remote: true,
      })
      const { renderer } = target
      let frames = 0
      renderer.on(CliRenderEvents.FRAME, () => frames++)
      const text = new TextRenderable(renderer, { content: "before", height: 1 })
      renderer.root.add(text)
      await target.renderOnce()
      await renderer.idle()
      const presented = frames
      writes.length = 0
      hold = true
      const raw = Buffer.alloc(Number(driver.maxAtomicWriteBytes), "x")
      assert.equal(driver.write(raw), true)
      assert.equal(driver.write(Uint8Array.of(120)), false)
      text.content = "AFTER!"
      for (let turn = 0; turn < 200 && (!skipped || renderer.getSchedulerState().isRendering); turn++) {
        await setTimeout(5)
      }
      assert.equal(skipped, true)
      assert.equal(renderer.getSchedulerState().isRendering, false)
      assert.ok(complete)
      assert.equal(stdout.writableNeedDrain, true)
      let settled = false
      wait =
        method === "waitForFrame"
          ? target.waitForFrame((frame) => frame.includes("AFTER!"))
          : method === "waitFor"
            ? target.waitFor(() => frames > presented)
            : target[method]()
      void wait.then(
        () => (settled = true),
        () => (settled = true),
      )
      await setImmediate()
      assert.equal(settled, false)
      assert.equal(frames, presented)
      release()
      for (let turn = 0; turn < 200 && !settled; turn++) await setTimeout(5)
      assert.equal(settled, true, "output release must wake the existing render retry")
      await wait
      await renderer.idle()
      assert.ok(target.captureCharFrame().includes("AFTER!"))
      const output = Buffer.concat(writes)
      assert.ok(output.subarray(0, raw.length).equals(raw))
      assert.ok(output.subarray(raw.length).includes("AFTER!"))
    } finally {
      release()
      render.mockRestore()
      if (target) {
        target.renderer.destroy()
        await target.renderer.closed
      } else driver.dispose()
      await wait?.catch(() => {})
      stdout.destroy()
    }
  },
)
