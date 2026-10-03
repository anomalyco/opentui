import { afterEach, beforeEach, expect, test } from "bun:test"
import { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { Renderable } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents } from "../renderer.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { nativeConstants } from "../native-abi.generated.js"
import { NATIVE_BUFFER_TEXT_BYTES_MAX, NativePaintRecorder, NativeScenePaintPhase } from "../zig.js"

const red = RGBA.fromHex("#ff0000")
const green = RGBA.fromHex("#00ff00")
const blue = RGBA.fromHex("#0000ff")
const white = RGBA.fromHex("#ffffff")
const clear = RGBA.fromInts(0, 0, 0, 0)
let setup: TestRendererSetup

beforeEach(async () => {
  setup = await createTestRenderer({ width: 12, height: 4 })
})

afterEach(async () => {
  setup.renderer.destroy()
  await setup.renderer.closed
})

function backgroundAt(buffer: OptimizedBuffer, x: number, y: number): Uint16Array {
  return buffer.withBuffers(({ bg, width }) => bg.slice((y * width + x) * 4, (y * width + x + 1) * 4))
}

test.each(["before", "after"] as const)(
  "self-destruction in %s drops the node, its recording, and a destroyed later box",
  async (phase) => {
    const { renderer, renderOnce, captureCharFrame } = setup
    const victim = new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: blue })
    const box = new BoxRenderable(renderer, {
      width: 2,
      height: 1,
      backgroundColor: red,
      renderBefore(buffer) {
        buffer.drawText("x", 0, 0, white)
        if (phase === "before") this.destroy()
        victim.destroy()
      },
      renderAfter(buffer) {
        buffer.drawText("y", 1, 0, white)
        if (phase === "after") this.destroy()
      },
    })
    renderer.root.add(box)
    renderer.root.add(victim)

    await renderOnce()

    expect(box.isDestroyed).toBe(true)
    expect(victim.isDestroyed).toBe(true)
    expect(backgroundAt(renderer.currentRenderBuffer, 0, 0)).toEqual(clear.buffer)
    expect(backgroundAt(renderer.currentRenderBuffer, 0, 1)).toEqual(clear.buffer)
    expect(captureCharFrame().split("\n")[0].trimEnd()).toBe("")
    expect(renderer.hitTest(0, 0)).toBe(0)
    expect(renderer.hitTest(0, 1)).toBe(0)
  },
)

test("paint hooks run before native paint, so earlier nodes paint a later hook's change", async () => {
  const { renderer, renderOnce, captureSpans } = setup
  const calls: string[] = []
  const first = new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: red })
  class Recolor extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      calls.push("self")
      first.backgroundColor = green
      buffer.drawText("ok", this.x, this.y, white)
    }
  }
  renderer.root.add(first)
  renderer.root.add(new Recolor(renderer, { width: 2, height: 1 }))

  await renderOnce()

  expect(calls).toEqual(["self"])
  expect(captureSpans().lines[0].spans[0]).toMatchObject({ width: 2, bg: green })
  expect(captureSpans().lines[1].spans[0].text.trimEnd()).toBe("ok")
})

test("paint hooks cannot read the frame and report the failing node", async () => {
  const { renderer, renderOnce } = setup
  const errors: { error: unknown; renderable?: Renderable }[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, (event) => errors.push(event))
  const reader = new BoxRenderable(renderer, {
    width: 2,
    height: 1,
    renderAfter(buffer) {
      buffer.withBuffers(() => {})
    },
  })
  renderer.root.add(reader)

  await renderOnce()

  expect(errors).toHaveLength(1)
  expect(String(errors[0].error)).toContain("cannot read the frame")
  expect(errors[0].renderable).toBe(reader)
})

test("an owned buffer composed by a hook reads its cells when native code paints", async () => {
  const { renderer, renderOnce, captureCharFrame } = setup
  class Composer extends Renderable {
    readonly surface = OptimizedBuffer.create(2, 1, "unicode", { owner: this.ctx.nativeScene })
    protected renderSelf(buffer: OptimizedBuffer): void {
      this.surface.drawText("ab", 0, 0, white)
      buffer.drawFrameBuffer(this.x, this.y, this.surface)
      this.surface.drawText("cd", 0, 0, white)
    }
    protected destroySelf(): void {
      this.surface.destroy()
      super.destroySelf()
    }
  }
  renderer.root.add(new Composer(renderer, { width: 2, height: 1 }))

  await renderOnce()

  expect(captureCharFrame().split("\n")[0].trimEnd()).toBe("cd")
})

// The release window spans the whole RECORD batch, not one slot (frame-record-parity frees in the drawing hook).
test("a text buffer that a later node's hook destroys still paints the view an earlier hook drew", async () => {
  const { renderer, renderOnce, captureCharFrame } = setup
  const text = TextBuffer.create("unicode", renderer.nativeScene)
  text.setText("ab")
  const view = TextBufferView.create(text)
  renderer.root.add(
    new BoxRenderable(renderer, { width: 4, height: 1, renderAfter: (buffer) => buffer.drawTextBuffer(view, 0, 0) }),
  )
  renderer.root.add(new BoxRenderable(renderer, { width: 1, height: 1, renderAfter: () => text.destroy() }))

  await renderOnce()

  expect(captureCharFrame().split("\n")[0].trimEnd()).toBe("ab")
})

test("a recorded text reserves its UTF-8 bytes against the text and recording limits", () => {
  const recorder = new NativePaintRecorder()
  const draw = (text: string) =>
    recorder.draw({ operation: "text", text, x: 0, y: 0, foreground: white, background: clear, attributes: 0 })
  recorder.begin(setup.renderer.nativeScene.driver.context)
  try {
    recorder.slot(0, NativeScenePaintPhase.Self, 1)
    expect(() => draw("x".repeat(20_000_000))).toThrow("Buffer text exceeds the native byte limit")
    expect(() => draw("é".repeat(NATIVE_BUFFER_TEXT_BYTES_MAX / 2 + 1))).toThrow("exceeds the native byte limit")
    expect(recorder.recording).toBeNull()
    draw("a")
    // A rejected text leaves the recording at its initial capacity.
    expect(recorder.recording!.buffer.byteLength).toBe(16_384)

    const filler = nativeConstants.OT_SCENE_RECORD_BYTES_MAX - 70_000
    recorder.packed(new Uint8Array(filler), filler, 0, 0, 1, 1)
    draw("a".repeat(NATIVE_BUFFER_TEXT_BYTES_MAX))
    expect(() => draw("a".repeat(8_000))).toThrow("Paint recording exceeds")
  } finally {
    recorder.end()
    recorder.settle()
  }
})

test("a slot whose hooks an earlier hook replaced still records its body", async () => {
  const { renderer, renderOnce, captureCharFrame } = setup
  class Later extends Renderable {
    protected renderSelf(buffer: OptimizedBuffer): void {
      buffer.drawText("LATER", this.x, this.y, white)
    }
  }
  const later = new Later(renderer, { width: 5, height: 1 })
  class Earlier extends Renderable {
    protected renderSelf(): void {
      later.renderAfter = () => {}
    }
  }
  renderer.root.add(new Earlier(renderer, { width: 5, height: 1 }))
  renderer.root.add(later)

  for (let frame = 0; frame < 3; frame++) {
    await renderOnce()
    expect(captureCharFrame().split("\n")[1].trimEnd()).toBe("LATER")
  }
})
