import { afterEach, beforeEach, expect, test } from "bun:test"
import assert from "node:assert/strict"
import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents, RendererControlState } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { NativeStatus } from "../zig.js"

const red = RGBA.fromHex("#ff0000")
const green = RGBA.fromHex("#00ff00")
const blue = RGBA.fromHex("#0000ff")
const clear = RGBA.fromInts(0, 0, 0, 0)
let setup: TestRendererSetup
let errors: Error[]

beforeEach(async () => {
  errors = []
  setup = await createTestRenderer({
    width: 12,
    height: 4,
    clock: new ManualClock(),
  })
  setup.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
})

afterEach(async () => {
  setup.renderer.destroy()
  await setup.renderer.closed
  expect(errors).toEqual([])
})

function backgroundAt(buffer: OptimizedBuffer, x: number, y: number): Uint16Array {
  return buffer.withBuffers(({ bg, width }) => bg.slice((y * width + x) * 4, (y * width + x + 1) * 4))
}

function prefix(buffer: OptimizedBuffer): string {
  return new TextDecoder().decode(buffer.getRealCharBytes(true)).split("\n")[0].trimEnd()
}

test.each(["before", "after"] as const)(
  "self-destruction in %s preserves own drawing without stale hits and skips a destroyed scheduled box",
  async (phase) => {
    const { renderer, renderOnce } = setup
    const calls: string[] = []
    const victim = new BoxRenderable(renderer, {
      width: 2,
      height: 1,
      backgroundColor: blue,
      renderBefore: () => calls.push("victim:before"),
      renderAfter: () => calls.push("victim:after"),
    })
    const box = new BoxRenderable(renderer, {
      width: 2,
      height: 1,
      backgroundColor: red,
      renderBefore(buffer) {
        calls.push("before")
        expect(backgroundAt(buffer, 0, 0)).toEqual(clear.buffer)
        if (phase === "before") this.destroy()
        victim.destroy()
      },
      renderAfter(buffer) {
        calls.push(`after:${this.isDestroyed}`)
        expect(backgroundAt(buffer, 0, 0)).toEqual(red.buffer)
        if (phase === "after") this.destroy()
        expect([this.screenX, this.screenY]).toEqual([0, 0])
      },
    })
    renderer.root.add(box)
    renderer.root.add(victim)

    await renderOnce()

    expect(calls).toEqual(["before", `after:${phase === "before"}`])
    expect(box.isDestroyed).toBe(true)
    expect([box.screenX, box.screenY]).toEqual([0, 0])
    expect(victim.isDestroyed).toBe(true)
    expect(backgroundAt(renderer.currentRenderBuffer, 0, 0)).toEqual(red.buffer)
    expect(backgroundAt(renderer.currentRenderBuffer, 0, 1)).toEqual(clear.buffer)
    expect(renderer.hitTest(0, 0)).toBe(0)
    expect(renderer.hitTest(0, 1)).toBe(0)

    await renderOnce()

    expect(backgroundAt(renderer.currentRenderBuffer, 0, 0)).toEqual(clear.buffer)
    expect(renderer.hitTest(0, 0)).toBe(0)
  },
)

test("before-hook replacement takes effect next frame while after and later-node replacements are live", async () => {
  const { renderer, renderOnce } = setup
  const calls: string[] = []
  const later = new BoxRenderable(renderer, {
    width: 1,
    height: 1,
    renderBefore: () => calls.push("later:old-before"),
    renderAfter: () => calls.push("later:old-after"),
  })
  const box = new BoxRenderable(renderer, {
    width: 2,
    height: 1,
    backgroundColor: red,
    renderBefore(buffer) {
      calls.push("old-before")
      expect(backgroundAt(buffer, 0, 0)).toEqual(clear.buffer)
      this.renderBefore = () => calls.push("new-before")
      this.renderAfter = function (buffer) {
        calls.push("new-after")
        expect(this).toBe(box)
        expect(backgroundAt(buffer, 0, 0)).toEqual(red.buffer)
      }
      later.renderBefore = () => calls.push("later:new-before")
      later.renderAfter = undefined
    },
    renderAfter: () => calls.push("old-after"),
  })
  renderer.root.add(box)
  renderer.root.add(later)

  await renderOnce()
  expect(calls).toEqual(["old-before", "new-after", "later:new-before"])
  calls.length = 0

  await renderOnce()
  expect(calls).toEqual(["new-before", "new-after", "later:new-before"])
})

test("own transforms are live for drawing and post-hook hits without refreshing descendant paint coordinates", async () => {
  const { renderer, renderOnce } = setup
  const parent = new BoxRenderable(renderer, {
    width: 2,
    height: 1,
    backgroundColor: red,
    renderBefore() {
      this.translateX = 2
      this.translateY = 1
      this.renderBefore = undefined
    },
    renderAfter(buffer) {
      expect(backgroundAt(buffer, 2, 1)).toEqual(red.buffer)
      this.translateX = 4
      this.translateY = 2
      this.renderAfter = undefined
    },
  })
  const child = new BoxRenderable(renderer, {
    position: "absolute",
    left: 1,
    top: 0,
    width: 1,
    height: 1,
    backgroundColor: blue,
  })
  parent.add(child)
  renderer.root.add(parent)

  await renderOnce()

  expect([parent.x, parent.y, child.x, child.y]).toEqual([4, 2, 5, 2])
  expect(backgroundAt(renderer.currentRenderBuffer, 2, 1)).toEqual(red.buffer)
  expect(backgroundAt(renderer.currentRenderBuffer, 1, 0)).toEqual(blue.buffer)
  expect(backgroundAt(renderer.currentRenderBuffer, 4, 2)).toEqual(clear.buffer)
  expect(renderer.hitTest(2, 1)).toBe(0)
  expect(renderer.hitTest(4, 2)).toBe(parent.num)
  expect(renderer.hitTest(5, 2)).toBe(parent.num)
  expect(renderer.hitTest(1, 0)).toBe(child.num)

  await renderOnce()

  expect(backgroundAt(renderer.currentRenderBuffer, 4, 2)).toEqual(red.buffer)
  expect(backgroundAt(renderer.currentRenderBuffer, 5, 2)).toEqual(blue.buffer)
  expect(backgroundAt(renderer.currentRenderBuffer, 1, 0)).toEqual(clear.buffer)
  expect(renderer.hitTest(5, 2)).toBe(child.num)
  expect(renderer.hitTest(1, 0)).toBe(0)
})

test("prepared clip and opacity commands survive hook mutations while a child's own transform is live", async () => {
  const { renderer, renderOnce, captureSpans } = setup
  const parent = new BoxRenderable(renderer, {
    position: "absolute",
    left: 1,
    top: 1,
    width: 4,
    height: 2,
    overflow: "hidden",
    opacity: 0.5,
    renderBefore() {
      this.translateX = 2
      this.overflow = "visible"
      this.opacity = 1
      this.renderBefore = undefined
    },
  })
  const child = new BoxRenderable(renderer, {
    width: 6,
    height: 1,
    flexShrink: 0,
    backgroundColor: red,
    renderBefore() {
      this.translateX = 1
    },
  })
  parent.add(child)
  renderer.root.add(parent)

  await renderOnce()

  expect([parent.x, child.x, parent.opacity, parent.overflow]).toEqual([3, 4, 1, "visible"])
  expect(captureSpans().lines[1].spans.map(({ width, bg }) => [width, bg.toInts()])).toEqual([
    [4, [0, 0, 0, 0]],
    [1, [128, 0, 0, 255]],
    [7, [0, 0, 0, 0]],
  ])
  expect(renderer.hitTest(3, 1)).toBe(parent.num)
  expect(renderer.hitTest(4, 1)).toBe(child.num)
  expect(renderer.hitTest(5, 1)).toBe(parent.num)

  await renderOnce()

  expect(captureSpans().lines[1].spans.map(({ width, bg }) => [width, bg.toInts()])).toEqual([
    [4, [0, 0, 0, 0]],
    [6, [255, 0, 0, 255]],
    [2, [0, 0, 0, 0]],
  ])
  expect(renderer.hitTest(9, 1)).toBe(child.num)
  expect(renderer.hitTest(10, 1)).toBe(0)
})

class ReparentedBox extends BoxRenderable {
  protected renderSelf(buffer: OptimizedBuffer): void {
    expect(this.x).toBe(7)
    super.renderSelf(buffer)
  }
}

test.each([
  ["Box", BoxRenderable],
  ["custom Box", ReparentedBox],
] as const)("%s reparenting changes getters but retains prepared paint and hits", async (_name, Box) => {
  const { renderer, renderOnce } = setup
  const source = new BoxRenderable(renderer, {
    position: "absolute",
    left: 1,
    top: 0,
    width: 3,
    height: 4,
  })
  const destination = new BoxRenderable(renderer, {
    position: "absolute",
    left: 7,
    top: 0,
    width: 3,
    height: 4,
  })
  const child = new Box(renderer, { width: 2, height: 1, backgroundColor: red })
  const hidden = new BoxRenderable(renderer, { width: 1, height: 1, backgroundColor: green, visible: false })
  source.add(child)
  source.add(hidden)
  source.renderAfter = function () {
    destination.add(child)
    destination.add(hidden)
    hidden.visible = true
    destination.add(new BoxRenderable(renderer, { width: 1, height: 1, backgroundColor: blue }))
    this.renderAfter = undefined
    expect([child.x, child.y]).toEqual([7, 0])
  }
  renderer.root.add(source)
  renderer.root.add(destination)

  await renderOnce()

  expect(backgroundAt(renderer.currentRenderBuffer, 1, 0)).toEqual(red.buffer)
  for (const y of [0, 1, 2]) expect(backgroundAt(renderer.currentRenderBuffer, 7, y)).toEqual(clear.buffer)
  expect(renderer.hitTest(1, 0)).toBe(child.num)
  expect(renderer.hitTest(7, 0)).toBe(destination.num)
  expect(renderer.hitTest(7, 1)).toBe(destination.num)

  await renderOnce()

  expect(backgroundAt(renderer.currentRenderBuffer, 1, 0)).toEqual(clear.buffer)
  expect(backgroundAt(renderer.currentRenderBuffer, 7, 0)).toEqual(red.buffer)
  expect(backgroundAt(renderer.currentRenderBuffer, 7, 1)).toEqual(green.buffer)
  expect(backgroundAt(renderer.currentRenderBuffer, 7, 2)).toEqual(blue.buffer)
  expect(renderer.hitTest(1, 0)).toBe(source.num)
  expect(renderer.hitTest(7, 0)).toBe(child.num)
  expect(renderer.hitTest(7, 1)).toBe(hidden.num)
  expect(renderer.hitTest(7, 2)).toBe(destination.getChildren()[2].num)
})

test.each(["resize", "suspend", "setup"] as const)(
  "%s during a prefix preserves scoped storage and permits a fresh frame",
  async (action) => {
    const { renderer, renderOnce, captureCharFrame } = setup
    if (action === "suspend") await renderer.setupTerminal()
    const bufferIdentity = renderer.nextRenderBuffer
    const calls: string[] = []
    let transition: void | Promise<void> = undefined
    const first = new BoxRenderable(renderer, {
      width: 1,
      height: 1,
      renderAfter(buffer) {
        buffer.withBuffers(({ char }) => (char[0] = 65))
      },
    })
    const middle = new BoxRenderable(renderer, {
      width: 1,
      height: 1,
      renderBefore(buffer) {
        calls.push(`before:${prefix(buffer)}`)
        if (action === "resize") {
          setup.resize(10, 3)
          expect(buffer.withBuffers(({ width, height, char }) => [width, height, char.length])).toEqual([10, 3, 30])
          calls.push(`resized:${prefix(buffer)}`)
        } else {
          buffer.withBuffers(({ char }) => {
            transition = action === "suspend" ? renderer.suspend() : renderer.setupTerminal()
            void transition?.catch(() => {})
            assert.throws(() => prefix(buffer), { status: NativeStatus.InvalidPhase })
            expect(char[0]).toBe(65)
          })
          calls.push("transition")
        }
        expect(buffer).toBe(bufferIdentity)
      },
      renderAfter(buffer) {
        calls.push(`after:${prefix(buffer)}`)
        buffer.withBuffers(({ char }) => (char[1] = 66))
      },
    })
    const last = new BoxRenderable(renderer, {
      width: 1,
      height: 1,
      renderAfter(buffer) {
        calls.push(`later:${prefix(buffer)}`)
        buffer.withBuffers(({ char }) => (char[2] = 67))
      },
    })
    renderer.root.add(first)
    renderer.root.add(middle)
    renderer.root.add(last)
    renderer.on(CliRenderEvents.RESIZE, (width, height) => calls.push(`resize:${width}x${height}`))
    renderer.addPostProcessFn((buffer) => {
      expect(buffer).toBe(bufferIdentity)
      calls.push(`post:${prefix(buffer)}`)
    })
    renderer.on(CliRenderEvents.FRAME, () => calls.push(`frame:${captureCharFrame().trimEnd()}`))

    await renderOnce()
    await transition

    expect(calls).toEqual(
      action === "resize"
        ? ["before:A", "resize:10x3", "resized:", "after:", "later: B", "post: BC", "frame: BC"]
        : ["before:A", "transition"],
    )
    expect(renderer.getNativeStats().nativeFrameCount).toBe(action === "resize" ? 1 : 0)
    expect(renderer.hitTest(0, 0)).toBe(0)
    expect(renderer.hitTest(0, 1)).toBe(action === "resize" ? middle.num : 0)
    expect(renderer.hitTest(0, 2)).toBe(action === "resize" ? last.num : 0)
    expect(errors.splice(0).map((error) => (error as { status?: NativeStatus }).status)).toEqual(
      action === "setup" ? [NativeStatus.InvalidPhase] : [],
    )
    if (action === "suspend") {
      assert.throws(captureCharFrame, { status: NativeStatus.InvalidPhase })
      expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_SUSPENDED)
      expect(renderer.getSchedulerState().hasScheduledRender).toBe(false)
    }

    middle.renderBefore = undefined
    calls.length = 0
    if (action === "suspend") await renderer.resume()
    await renderOnce()

    expect(calls).toEqual(["after:A", "later:AB", "post:ABC", "frame:ABC"])
    expect(renderer.getNativeStats().nativeFrameCount).toBe(action === "resize" ? 2 : 1)
    expect(renderer.hitTest(0, 0)).toBe(first.num)
    expect(renderer.hitTest(0, 1)).toBe(middle.num)
    expect(renderer.hitTest(0, 2)).toBe(last.num)
  },
)
