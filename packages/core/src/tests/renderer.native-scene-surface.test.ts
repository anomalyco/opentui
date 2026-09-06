import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { OptimizedBuffer } from "../buffer.js"
import { Renderable } from "../Renderable.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { FrameBufferRenderable } from "../renderables/FrameBuffer.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const targets: TestRendererSetup[] = []
const white = RGBA.fromInts(255, 255, 255)

class PassThroughBox extends BoxRenderable {
  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)
  }
}

class PassThroughFrameBuffer extends FrameBufferRenderable {
  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)
  }
}

afterEach(async () => {
  for (const { renderer } of targets.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({ width: 10, height: 4, clock: new ManualClock() })
  targets.push(target)
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  return { ...target, errors }
}

test("retained FrameBuffer composes unchanged and edited cells without host paint callbacks", async () => {
  const target = await setup()
  const surface = new FrameBufferRenderable(target.renderer, { width: 4, height: 1 })
  target.renderer.root.add(surface)
  surface.frameBuffer.drawText("keep", 0, 0, white)
  const hooks = spyOn(Renderable.prototype, "_runNativeSceneHook")
  try {
    for (let frame = 0; frame < 3; frame++) {
      if (frame === 2) surface.frameBuffer.drawText("edit", 0, 0, white)
      await target.renderOnce()
      assert.deepEqual(target.errors, [])
      assert.ok(target.captureCharFrame().startsWith(frame === 2 ? "edit" : "keep"))
    }
    assert.equal(hooks.mock.calls.filter(([request]) => request.num === surface.num && request.kind === 7).length, 0)
  } finally {
    hooks.mockRestore()
  }
})

test("retained FrameBuffer preserves resize and overridden paint callback ordering", async () => {
  const target = await setup()
  const calls: string[] = []
  class Surface extends FrameBufferRenderable {
    protected override onResize(width: number, height: number): void {
      calls.push(`resize:${width}x${height}`)
      super.onResize(width, height)
      this.frameBuffer.drawText("wide", 0, 0, white)
    }

    protected override renderSelf(buffer: OptimizedBuffer): void {
      calls.push("self")
      super.renderSelf(buffer)
    }
  }
  const surface = new Surface(target.renderer, {
    width: 2,
    height: 1,
    renderBefore: () => calls.push("before"),
    renderAfter: () => calls.push("after"),
  })
  target.renderer.root.add(surface)
  await target.renderOnce()
  calls.length = 0
  surface.width = 4
  surface.height = 2
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
  assert.deepEqual(calls, ["resize:4x2", "before", "self", "after"])
  assert.deepEqual([surface.frameBuffer.width, surface.frameBuffer.height], [4, 2])
  assert.ok(target.captureCharFrame().startsWith("wide"))
  const buffer = surface.frameBuffer
  surface.destroy()
  assert.throws(() => buffer.clear(), /destroyed/)
  await target.renderOnce()
  assert.equal(target.captureCharFrame().trim(), "")
})

test("retained FrameBuffer accepts replacement before publishing and rejects foreign buffers", async () => {
  const target = await setup()
  const other = await setup()
  const surface = new FrameBufferRenderable(target.renderer, { width: 4, height: 1 })
  target.renderer.root.add(surface)
  const previous = surface.frameBuffer
  const replacement = OptimizedBuffer.create(4, 1, "unicode", { owner: target.renderer.nativeScene })
  const foreign = OptimizedBuffer.create(4, 1, "unicode", { owner: other.renderer.nativeScene })
  try {
    previous.drawText("old", 0, 0, white)
    replacement.drawText("new", 0, 0, white)
    surface.frameBuffer = replacement
    assert.throws(() => (surface.frameBuffer = foreign), /same Context/)
    assert.equal(surface.frameBuffer, replacement)
    previous.destroy()
    await target.renderOnce()
    assert.deepEqual(target.errors, [])
    assert.ok(target.captureCharFrame().startsWith("new"))
    surface.destroy()
    assert.throws(() => replacement.clear(), /destroyed/)
    assert.throws(() => (surface.frameBuffer = foreign), /destroyed/)
    assert.equal(foreign.width, 4)
  } finally {
    previous.destroy()
    replacement.destroy()
    foreign.destroy()
  }
})

test("retained FrameBuffer binding keeps native cells alive after the public handle is released", async () => {
  const target = await setup()
  const surface = new FrameBufferRenderable(target.renderer, { width: 4, height: 1 })
  target.renderer.root.add(surface)
  surface.frameBuffer.drawText("held", 0, 0, white)
  surface.frameBuffer.destroy()
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
  assert.ok(target.captureCharFrame().startsWith("held"))
  surface.destroy()
  await target.renderOnce()
  assert.equal(target.captureCharFrame().trim(), "")
})

test.each(["destroy", "hide"] as const)(
  "retained FrameBuffer %s in before skips composition but runs after",
  async (action) => {
    const target = await setup()
    const calls: string[] = []
    const surface = new FrameBufferRenderable(target.renderer, {
      width: 4,
      height: 1,
      renderBefore() {
        calls.push("before")
        if (action === "destroy") this.destroy()
        else this.visible = false
      },
      renderAfter: () => calls.push("after"),
    })
    surface.frameBuffer.drawText("gone", 0, 0, white)
    target.renderer.root.add(surface)
    await target.renderOnce()
    assert.deepEqual(target.errors, [])
    assert.deepEqual(calls, ["before", "after"])
    assert.equal(target.captureCharFrame().trim(), "")
  },
)

test("lifecycle-created FrameBuffer class fields bind before painting and retain the assignment setter", async () => {
  const target = await setup()
  const replacement = OptimizedBuffer.create(4, 1, "unicode", { owner: target.renderer.nativeScene })
  const Surface = new Function(
    "Base",
    "replacement",
    `return class extends Base {
      initial = this.frameBuffer
      frameBuffer = replacement
    }`,
  )(FrameBufferRenderable, replacement) as new (
    ...args: ConstructorParameters<typeof FrameBufferRenderable>
  ) => FrameBufferRenderable & { initial: OptimizedBuffer }
  let surface: InstanceType<typeof Surface> | undefined
  target.renderer.root.onLifecyclePass = () => {
    if (surface) return
    surface = new Surface(target.renderer, { width: 4, height: 1 })
    target.renderer.root.add(surface)
  }
  target.renderer.registerLifecyclePass(target.renderer.root)
  replacement.drawText("new", 0, 0, white)
  try {
    await target.renderOnce()
    assert.deepEqual(target.errors, [])
    assert.ok(target.captureCharFrame().startsWith("new"))
    assert.ok(surface)
    surface.initial.drawText("old", 0, 0, white)
    surface.frameBuffer = surface.initial
    await target.renderOnce()
    assert.ok(target.captureCharFrame().startsWith("old"))
    Object.defineProperty(surface, "frameBuffer", { configurable: true, value: replacement })
    surface.refreshHooks()
    await target.renderOnce()
    assert.ok(target.captureCharFrame().startsWith("new"))
  } finally {
    surface?.destroy()
    surface?.initial.destroy()
    replacement.destroy()
  }
})

test.each([PassThroughBox, PassThroughFrameBuffer])("inherited %p truncates fractional coordinates", async (Body) => {
  const target = await setup()
  const body = new Body(target.renderer, { width: 3, height: 2, border: true })
  body.translateX = 2.5
  body.translateY = 2.5
  const surface = body instanceof FrameBufferRenderable
  if (surface) body.frameBuffer.drawText("XYZ", 0, 0, white)
  target.renderer.root.add(body)
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
  assert.equal(target.captureCharFrame().split("\n")[2], surface ? "  XYZ     " : "  ┌─┐     ")
  assert.equal(target.renderer.hitTest(2, 2), body.num)
})

test.each([FrameBufferRenderable, PassThroughFrameBuffer])("prepared %p ignores ancestor changes", async (Body) => {
  const target = await setup()
  const parent = new BoxRenderable(target.renderer, {
    position: "absolute",
    left: 1,
    width: 6,
    height: 1,
    renderBefore() {
      this.translateX = 3
    },
  })
  const positions: number[] = []
  const surface = new Body(target.renderer, {
    position: "absolute",
    left: 1,
    width: 1,
    height: 1,
    renderBefore() {
      positions.push(this.x)
    },
  })
  surface.frameBuffer.drawText("X", 0, 0, white)
  parent.add(surface)
  target.renderer.root.add(parent)
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
  assert.deepEqual(positions, [5])
  assert.equal(target.captureCharFrame().split("\n")[0], "  X       ")
  assert.equal(target.renderer.hitTest(2, 0), surface.num)
  assert.notEqual(target.renderer.hitTest(5, 0), surface.num)
  await target.renderOnce()
  assert.deepEqual(target.errors, [])
  assert.deepEqual(positions, [5, 5])
  assert.equal(target.captureCharFrame().split("\n")[0], "     X    ")
  assert.equal(target.renderer.hitTest(5, 0), surface.num)
})
