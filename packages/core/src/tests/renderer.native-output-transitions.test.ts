import { getYogaNode } from "../lib/renderable-layout.js"
import { test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { NativeSession } from "../NativeSession.js"
import { ANSI } from "../ansi.js"
import { CliRenderer, CliRenderEvents, type CliRendererConfig } from "../renderer.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"
import { NativeError, NativeStatus } from "../zig.js"

class HeldOutput extends TestWriteStream {
  chunks: Buffer[] = []
  hold = false
  complete?: () => void

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, complete: () => void): void {
    this.chunks.push(Buffer.from(chunk))
    if (this.hold) this.complete = complete
    else complete()
  }

  release(): void {
    this.hold = false
    const complete = this.complete
    this.complete = undefined
    complete?.()
  }
}

function setup(config: CliRendererConfig = {}, spanCapacity = 32, chunkSize = 4096) {
  const stdout = new HeldOutput(24, 10)
  const driver = new NativeSession(stdout, {
    output: { chunkSize, spanCapacity, maxBytes: BigInt(spanCapacity * chunkSize), controlCapacity: 4096 },
  })
  const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, 24, 10, {
    nativeSession: driver,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
    remote: true,
    clock: new ManualClock(),
    ...config,
  })
  const loop = () => (renderer as unknown as { loop(): Promise<void> }).loop()
  const close = async () => {
    stdout.release()
    renderer.destroy()
    await renderer.closed
  }
  return { renderer, driver, stdout, loop, close }
}

test("native capture enabled in a one-shot callback drains its queued snapshot", async () => {
  const { renderer, driver, stdout, loop, close } = setup()
  let callbacks = 0
  try {
    const captureOnce = async () => {
      renderer.removeFrameCallback(captureOnce)
      callbacks++
      renderer.externalOutputMode = "capture-stdout"
      renderer.writeToScrollback(({ renderContext }) => ({
        root: new TextRenderable(renderContext, { content: "captured-once", width: 13, height: 1 }),
      }))
    }
    renderer.setFrameCallback(captureOnce)
    await loop()
    await loop()
    await driver.idle()
    assert.equal(callbacks, 1)
    const output = Buffer.concat(stdout.chunks).toString()
    assert.equal(output.split("captured-once").length - 1, 1, JSON.stringify(output))
  } finally {
    await close()
  }
})

test("native footer height can revert while captured output delays the change", async () => {
  const { renderer, loop, close } = setup({ externalOutputMode: "capture-stdout" })
  try {
    renderer.writeToScrollback(({ renderContext }) => ({
      root: new TextRenderable(renderContext, { content: "queued", width: 6, height: 1 }),
    }))
    renderer.footerHeight = 4
    renderer.footerHeight = 3
    assert.equal(renderer.footerHeight, 3)
    await loop()
    await loop()
    assert.equal(renderer.height, 3)
    assert.equal(renderer.root.height, 3)
  } finally {
    await close()
  }
})

test.each(["enter-footer", "queued-footer", "shrink-width"] as const)(
  "native %s retains complete geometry when terminal output is full",
  async (transition) => {
    const { renderer, driver, stdout, loop, close } = setup({
      screenMode: transition === "shrink-width" ? "split-footer" : "main-screen",
    })
    try {
      await renderer.setupTerminal()
      await driver.idle()
      stdout.chunks.length = 0
      stdout.hold = true
      const bytes = Buffer.alloc(4096, "x")
      let accepted = 0
      for (let count = 0; count < 32 && driver.write(bytes); count++) accepted += bytes.length
      assert.ok(accepted > 0)
      assert.equal(driver.write(Uint8Array.of(120)), false)
      for (let turn = 0; turn < 32 && !stdout.complete; turn++) await setImmediate()
      assert.ok(stdout.complete)
      const callback = stdout.complete
      const sizes: number[][] = []
      renderer.on(CliRenderEvents.RESIZE, (width, height) => sizes.push([width, height]))
      const before = [renderer.width, renderer.height, renderer.root.width, renderer.root.height]
      let callbacks = 0
      const change = () => {
        if (transition !== "shrink-width") {
          renderer.footerHeight = 3
          renderer.screenMode = "split-footer"
        } else renderer.resize(18, 10)
      }
      try {
        if (transition === "queued-footer") {
          const changeOnce = async () => {
            renderer.removeFrameCallback(changeOnce)
            callbacks++
            change()
          }
          renderer.setFrameCallback(changeOnce)
          await loop()
          assert.deepEqual([renderer.width, renderer.height, renderer.root.width, renderer.root.height], before)
        } else change()
      } catch (error) {
        assert.ok(
          error instanceof NativeError &&
            (error.status === NativeStatus.OutputBackpressure || error.status === NativeStatus.OutputBusy),
        )
        assert.deepEqual([renderer.width, renderer.height, renderer.root.width, renderer.root.height], before)
        assert.deepEqual(sizes, [])
      }
      assert.equal(stdout.complete, callback)
      stdout.release()
      await driver.idle()
      if (transition !== "queued-footer") change()
      await loop()
      await loop()
      await driver.idle()
      const expected = transition === "shrink-width" ? [18, 3] : [24, 3]
      assert.deepEqual([renderer.width, renderer.height], expected)
      assert.deepEqual([renderer.root.width, renderer.root.height], expected)
      assert.deepEqual(sizes, [expected])
      const output = Buffer.concat(stdout.chunks).toString()
      assert.equal(output.slice(0, accepted), "x".repeat(accepted))
      const control = transition === "shrink-width" ? ANSI.moveCursorAndClear(4, 1) : ANSI.scrollDown(7)
      assert.equal(output.split(control).length - 1, 1)
      if (transition === "queued-footer") assert.equal(callbacks, 1)
    } finally {
      await close()
    }
  },
)

test("native width shrink completes before an optional pixel query consumes the last output span", async () => {
  const { renderer, driver, stdout, close } = setup({}, 2)
  try {
    await renderer.setupTerminal()
    await driver.idle()
    renderer.stdin.emit("data", Buffer.from("\x1b[4;200;480t"))
    assert.deepEqual(renderer.resolution, { width: 480, height: 200 })
    const sizes: number[][] = []
    renderer.on(CliRenderEvents.RESIZE, (width, height) => sizes.push([width, height]))
    stdout.chunks.length = 0
    assert.doesNotThrow(() => renderer.resize(18, 10))
    assert.deepEqual(
      [
        renderer.width,
        renderer.height,
        getYogaNode(renderer.root).getWidth().value,
        getYogaNode(renderer.root).getHeight().value,
      ],
      [18, 3, 18, 3],
    )
    assert.deepEqual(sizes, [[18, 3]])
    await driver.idle()
    renderer.resize(18, 10)
    await driver.idle()
    const output = Buffer.concat(stdout.chunks).toString()
    assert.equal(output.split(ANSI.moveCursorAndClear(4, 1)).length - 1, 1)
    assert.equal(output.split("\x1b[14t").length - 1, 1)
    assert.ok(output.indexOf(ANSI.moveCursorAndClear(4, 1)) < output.indexOf("\x1b[14t"))
    assert.deepEqual(sizes, [[18, 3]])
  } finally {
    await close()
  }
})

test.each([
  ["before suspension", 2],
  ["before suspension", 4],
  ["while suspended", 2],
  ["while suspended", 4],
] as const)(
  "native footer height changed %s to %s preserves deferred cleanup through resume",
  async (phase, height) => {
    const { renderer, driver, stdout, loop, close } = setup({ externalOutputMode: "capture-stdout" })
    try {
      renderer.root.add(new TextRenderable(renderer, { content: "footer", height: 1 }))
      await renderer.setupTerminal()
      renderer.stdin.emit("data", Buffer.from("\x1b[10;1R"))
      await loop()
      await driver.idle()
      const sizes: number[][] = []
      renderer.on(CliRenderEvents.RESIZE, (width, height) => sizes.push([width, height]))
      if (phase === "before suspension") renderer.footerHeight = height
      await renderer.suspend()
      if (phase === "while suspended") renderer.footerHeight = height
      assert.equal(renderer.footerHeight, height)
      await renderer.resume()
      await driver.idle()
      stdout.chunks.length = 0
      await loop()
      await loop()
      await driver.idle()
      assert.equal(renderer.height, height)
      assert.equal(renderer.root.height, height)
      assert.deepEqual(sizes, [[24, height]])
      const output = Buffer.concat(stdout.chunks).toString()
      assert.ok(output.includes("footer"), JSON.stringify(output))
      const cleanup = height === 4 ? ANSI.scrollUp(1) : `${ANSI.moveCursor(10, 1)}\x1b[2K`
      assert.equal(output.split(cleanup).length - 1, 1, JSON.stringify(output))
    } finally {
      await close()
    }
  },
)

test("native resize rejects an oversized scrub without publishing geometry or consuming its retry", async () => {
  const { renderer, driver, stdout, close } = setup({}, 513, 8)
  try {
    await renderer.setupTerminal()
    await driver.idle()
    const sizes: number[][] = []
    renderer.on(CliRenderEvents.RESIZE, (width, height) => sizes.push([width, height]))
    stdout.chunks.length = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => renderer.resize(18, 10), { status: NativeStatus.OutputBackpressure })
      assert.deepEqual([renderer.width, renderer.height], [24, 3])
      assert.equal(getYogaNode(renderer.root).getWidth().value, 24)
      assert.equal(renderer.currentRenderBuffer.width, 24)
      assert.equal(renderer.nextRenderBuffer.width, 24)
      assert.deepEqual(sizes, [])
      await driver.idle()
      assert.equal(stdout.chunks.length, 0)
    }
    renderer.resize(30, 10)
    assert.equal(renderer.width, 30)
    assert.deepEqual(sizes, [[30, 3]])
  } finally {
    await close()
  }
})
