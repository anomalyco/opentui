import { captureRenderSnapshot as snapshot, expectRenderSnapshot } from "./render-snapshot.js"

import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { Renderable } from "../Renderable.js"
import { NativeImage } from "../image.js"
import { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { ImageRenderable } from "../renderables/Image.js"
import { BoxRenderable } from "../renderables/Box.js"

import { FrameBufferRenderable } from "../renderables/FrameBuffer.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TestWriteStream } from "../testing/test-streams.js"
import { NativeError, NativeStatus, resolveRenderLib } from "../zig.js"

const setups: TestRendererSetup[] = []
const fixture = new URL("./fixtures/images/rgba.png", import.meta.url)
class ImageOutput extends TestWriteStream {
  private writes: Buffer[] = []

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk))
    callback()
  }

  take(): string {
    return Buffer.concat(this.writes.splice(0)).toString("binary")
  }
}

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup(output?: ImageOutput) {
  const target = await createTestRenderer({
    width: 10,
    height: 6,
    clock: new ManualClock(),
    stdout: output as unknown as NodeJS.WriteStream,
    bufferedOutput: output ? "stdout" : undefined,
    remote: true,
  })
  setups.push(target)
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  return { ...target, errors }
}

test.each(["destroy", "replace"] as const)(
  "native Image cancellation can %s its owner during replacement",
  async (action) => {
    const { renderer } = await setup()
    const replacement = NativeImage.fromRgba(Uint8Array.of(0, 255, 0, 255, 0, 255, 0, 255), 2, 1)
    const loaded: number[] = []
    const image = new ImageRenderable(renderer, { width: 2, height: 1, onLoad: (value) => loaded.push(value.width) })
    renderer.root.add(image)
    let cancelled = 0
    let nested: Promise<void> | null = null
    const first = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++
          if (action === "destroy") image.destroy()
          else image.source = replacement
          nested = image.loadPromise
        },
      }),
    )
    let pending!: ReadableStreamDefaultController<Uint8Array>
    const superseded = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          pending = controller
        },
      }),
    )
    image.source = first
    const initial = image.loadPromise
    try {
      assert.equal(first.body!.locked, true)
      image.source = superseded
      assert.equal(cancelled, 1)
      assert.equal(superseded.body!.locked, false)
      assert.equal(image.isDestroyed, action === "destroy")
      await Promise.all([initial, nested, image.loadPromise])
      assert.equal(first.body!.locked, false)
      assert.equal(image.loading, false)
      assert.deepEqual(loaded, action === "destroy" ? [] : [2])
      if (action === "replace") {
        assert.equal(image.source, replacement)
        assert.equal(image.image?.width, 2)
      }
    } finally {
      pending.error(new Error("fixture cleanup"))
      image.destroy()
      await Promise.allSettled([initial, nested, image.loadPromise])
      replacement.dispose()
    }
  },
)

test.each([false, true])("native Image preserves paint hooks (buffered=%s)", async (buffered) => {
  const frames = []
  {
    const target = await setup()
    const calls: string[] = []
    class CustomImage extends ImageRenderable {
      protected override renderSelf(buffer: OptimizedBuffer): void {
        calls.push("self")
        super.renderSelf(buffer)
      }
    }
    const image = new CustomImage(target.renderer, {
      source: await readFile(fixture),
      buffered,
      protocol: "blocks",
      opacity: 0.5,
      width: 4,
      height: 2,
      renderBefore(buffer) {
        calls.push(`before:${buffer.getRealCharBytes(false)[0]}`)
      },
      renderAfter(buffer) {
        calls.push("after")
        buffer.drawText("A", 0, 0, RGBA.fromHex("#ffffff"))
      },
    })
    target.renderer.root.add(image)
    await image.loadPromise
    for (let frame = 0; frame < 2; frame++) {
      await target.renderOnce()
      assert.deepEqual(target.errors, [])
      frames.push(snapshot(target))
    }
    const sequence = ["before:32", "self", "after"]
    assert.deepEqual(calls, [...sequence, ...sequence])
  }
  expectRenderSnapshot(frames)
})

test("native Image failed binding preserves accepted state and releases its candidate", async () => {
  const target = await setup()
  const image = new ImageRenderable(target.renderer, { source: await readFile(fixture), width: 2, height: 1 })
  target.renderer.root.add(image)
  await image.loadPromise
  await target.renderOnce()
  const previous = image.image!
  const before = snapshot(target)
  const lib = resolveRenderLib()
  const failure = new NativeError("fixture image binding", NativeStatus.ObjectLimit)
  const errors: unknown[] = []
  image.onError = (error) => errors.push(error)
  const bind = spyOn(lib, "sceneSetImage").mockImplementation(() => {
    throw failure
  })
  const release = spyOn(lib, "destroyContextImage")
  try {
    image.source = new Uint8Array(await readFile(fixture))
    await image.loadPromise
    assert.equal(image.image, previous)
    assert.equal(image.loadError, failure)
    assert.equal(image.loading, false)
    assert.deepEqual(errors, [failure])
    assert.equal(release.mock.calls.length, 1)
    const source = image.source
    assert.throws(() => (image.source = undefined), failure)
    assert.equal(image.source, source)
    assert.equal(image.image, previous)
    assert.throws(() => (image.fit = "cover"), failure)
    assert.equal(image.fit, "fit")
  } finally {
    bind.mockRestore()
    release.mockRestore()
  }
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
  assert.deepEqual(snapshot(target), before)
})

test("native image buffers cache checked Context imports and retain copies after source disposal", async () => {
  const first = await setup()
  const second = await setup()
  const source = NativeImage.fromRgba(Uint8Array.of(255, 0, 0, 255), 1, 1)
  const lib = resolveRenderLib()
  const imported = spyOn(lib, "importContextImage")
  const released = spyOn(lib, "destroyContextImage")
  try {
    for (const target of [first, second]) {
      const node = new FrameBufferRenderable(target.renderer, { width: 2, height: 1 })
      target.renderer.root.add(node)
      node.frameBuffer.drawImage(source, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, "blocks")
      node.frameBuffer.drawImage(source, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, "blocks")
      const before = node.frameBuffer.getRealCharBytes(false)
      assert.throws(() => node.frameBuffer.drawImage(source, 0, 0, 2, 1, 0, 0, 1, 0, 1, 1, "blocks"))
      assert.deepEqual(node.frameBuffer.getRealCharBytes(false), before)
    }
    assert.equal(imported.mock.calls.length, 2)
    source.dispose()
    assert.equal(released.mock.calls.length, 2)
    for (const target of [first, second]) {
      await target.renderOnce()
      assert.deepEqual(target.errors, [])
      assert.equal(target.captureCharFrame().slice(0, 2), "\u2588\u2588")
    }
  } finally {
    imported.mockRestore()
    released.mockRestore()
    source.dispose()
  }
})

test("native image paint hooks reject late Session drawing", async () => {
  const target = await setup()
  const source = NativeImage.fromRgba(Uint8Array.of(255, 0, 0, 255), 1, 1)
  let saved: OptimizedBuffer | undefined
  const node = new BoxRenderable(target.renderer, {
    width: 2,
    height: 1,
    renderAfter(buffer) {
      saved = buffer
      buffer.drawImage(source, 0, 0, 2, 1, 0, 0, 0, 0, 1, 1, "blocks")
    },
  })
  target.renderer.root.add(node)
  try {
    await target.renderOnce()
    assert.deepEqual(target.errors, [])
    assert.equal(target.captureCharFrame().slice(0, 2), "\u2588\u2588")
    assert.throws(() => saved!.drawImage(source, 0, 0, 2, 1), /active next frame/)
    target.renderer.destroy()
    await target.renderer.closed
    source.dispose()
  } finally {
    source.dispose()
  }
})

test("native Image rejected construction releases its node and framebuffer", async () => {
  const target = await setup()
  const lib = resolveRenderLib()
  const nodes = Renderable.renderablesByNumber.size
  const releaseNode = spyOn(lib, "sceneDestroyNode")
  const releaseBuffer = spyOn(lib, "destroyContextBuffer")
  try {
    assert.throws(
      () => new ImageRenderable(target.renderer, { buffered: true, fit: "invalid" as "fit", width: 2, height: 1 }),
      /Unknown image fit/,
    )
    assert.equal(releaseNode.mock.calls.length, 1)
    assert.equal(releaseBuffer.mock.calls.length, 1)
    assert.equal(Renderable.renderablesByNumber.size, nodes)
  } finally {
    releaseNode.mockRestore()
    releaseBuffer.mockRestore()
  }
})

test("native Image binds a deferred framebuffer before subclass resize and paint hooks", async () => {
  const frames = []
  const bytes = await readFile(fixture)
  {
    const target = await setup()
    class ResizedImage extends ImageRenderable {
      protected override onResize(): void {}
    }
    const image = new ResizedImage(target.renderer, {
      source: bytes,
      buffered: true,
      width: "100%",
      height: 2,
      protocol: "blocks",
      renderAfter(buffer) {
        buffer.drawText("overlay", 0, 0, RGBA.fromHex("#ffffff"))
      },
    })
    target.renderer.root.add(image)
    await image.loadPromise
    for (let frame = 0; frame < 2; frame++) {
      if (frame) target.resize(12, 6)
      await target.renderOnce()
      assert.deepEqual(target.errors, [])
      const captured = snapshot(target)
      assert.ok(captured.text.startsWith("overlay"), `native frame ${frame} must composite the overlay`)
      frames.push(captured)
    }
  }
  expectRenderSnapshot(frames)
})

test("native Image resolution requery survives an old reply drained during resume", async () => {
  const output = new ImageOutput(10, 6)
  const target = await setup(output)
  const driver = target.renderer.nativeScene!.driver
  await target.renderer.setupTerminal()
  await driver.idle()
  output.take()
  target.resize(12, 6)
  await target.renderer.suspend()
  assert.ok(!output.take().includes("\x1b[14t"), "an unanswered query must not be duplicated during suspension")
  target.renderer.stdin.push(Buffer.from("\x1b[4;180;100t"))
  output.take()
  await target.renderer.resume()
  await driver.idle()
  assert.equal(target.renderer.resolution, null)
  assert.ok(output.take().includes("\x1b[14t"), "resume must reissue the query for the resized terminal")
  target.renderer.stdin.emit("data", Buffer.from("\x1b[4;180;120t"))
  assert.deepEqual(target.renderer.resolution, { width: 120, height: 180 })
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
})
