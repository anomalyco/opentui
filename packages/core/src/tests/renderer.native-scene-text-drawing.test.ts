import { expectRenderSnapshot } from "./render-snapshot.js"
import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import { OptimizedBuffer } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { RGBA } from "../lib/RGBA.js"

import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"

import { InputRenderable } from "../renderables/Input.js"

import { TextareaRenderable } from "../renderables/Textarea.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"

import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import type { RenderContext } from "../types.js"

const setups: TestRendererSetup[] = []
const resources: { destroy(): void }[] = []

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) resource.destroy()
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({
    width: 18,
    height: 6,
    clock: new ManualClock(),
  })
  setups.push(target)
  const errors: Error[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  return { ...target, errors }
}

function snapshot(buffer: OptimizedBuffer) {
  return {
    text: buffer.getRealCharBytes(),
    ...buffer.withBuffers((cells) => ({
      fg: cells.fg.slice(),
      bg: cells.bg.slice(),
      attributes: cells.attributes.slice(),
    })),
  }
}

test.each(["Textarea", "Input"] as const)(
  "native inherited %s drawing uses the same translated cells as built-in drawing",
  async (kind) => {
    const frames = []
    const Base: new (ctx: RenderContext, options: RenderableOptions) => Renderable =
      kind === "Textarea" ? TextareaRenderable : InputRenderable
    let calls = 0
    class Custom extends Base {
      protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
        calls++
        super.renderSelf(buffer, deltaTime)
      }
    }
    for (const Node of [Base, Custom]) {
      const target = await setup()
      const node = new Node(target.renderer, {
        position: "absolute",
        left: 2,
        top: 1,
        width: 4,
        height: 1,
        [kind === "Textarea" ? "initialValue" : "value"]: "view",
      })
      node.translateX = 0.5
      node.translateY = 0.5
      target.renderer.root.add(node)
      await target.renderOnce()
      assert.deepEqual(target.errors, [])
      assert.deepEqual([node.x, node.y], [2.5, 1.5])
      assert.ok(target.captureCharFrame().trim().length > 0)
      frames.push(snapshot(target.renderer.currentRenderBuffer))
    }
    assert.equal(calls, 1)
    assert.deepEqual(frames[1], frames[0])
    expectRenderSnapshot(frames[0])
  },
)

test.each(["text", "editor"])(
  "native %s-view drawing validates ownership, lifetime and coordinates atomically",
  async (kind) => {
    const first = await setup()
    const second = await setup()
    const target = OptimizedBuffer.create(8, 2, first.renderer.widthMethod, {
      owner: first.renderer.nativeScene,
    })
    resources.push(target)
    target.clear(RGBA.fromHex("#102030"))
    const accepted = snapshot(target)
    const create = ({ renderer }: TestRendererSetup) => {
      const buffer =
        kind === "text"
          ? TextBuffer.create(renderer.widthMethod, renderer.nativeScene)
          : EditBuffer.create(renderer.widthMethod, renderer.nativeScene)
      resources.push(buffer)
      buffer.setText("valid")
      const view = buffer instanceof TextBuffer ? TextBufferView.create(buffer) : EditorView.create(buffer, 8, 2)
      resources.push(view)
      if (view instanceof TextBufferView) view.setViewport(0, 0, 8, 2)
      return { buffer, view }
    }
    const draw = (view: TextBufferView | EditorView, x = 0) => {
      if (view instanceof TextBufferView) target.drawTextBuffer(view, x, 0)
      else target.drawEditorView(view, x, 0)
    }
    for (const owner of [second, first]) {
      const { view } = create(owner)
      if (owner === first) view.destroy()
      assert.throws(() => draw(view))
      assert.deepEqual(snapshot(target), accepted)
    }
    const { buffer, view } = create(first)
    assert.throws(() => draw(view, Number.NaN))
    assert.deepEqual(snapshot(target), accepted)
    draw(view)
    assert.ok(new TextDecoder().decode(target.getRealCharBytes()).includes("valid"))
    buffer.destroy()
    const painted = snapshot(target)
    assert.throws(() => draw(view))
    assert.deepEqual(snapshot(target), painted)
  },
)

test.each([
  { width: 0x7fff_ffff, height: 1 },
  { width: 1, height: 0x7fff_ffff },
])("native editor-view drawing clips large viewport endpoints %p", async ({ width, height }) => {
  const { renderer } = await setup()
  const target = OptimizedBuffer.create(8, 3, renderer.widthMethod, {
    owner: renderer.nativeScene,
  })
  resources.push(target)
  const background = RGBA.fromHex("#102030")
  const fill = RGBA.fromHex("#804020")
  target.clear(background)
  const edit = EditBuffer.create(renderer.widthMethod, renderer.nativeScene)
  resources.push(edit)
  edit.setText("x")
  edit.setDefaultBg(fill)
  const view = EditorView.create(edit, width, height)
  resources.push(view)
  target.drawEditorView(view, 2, 1)
  target.withBuffers(({ bg }) => {
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 8; x++) {
        const inside = x >= 2 && x < 2 + width && y >= 1 && y < 1 + height
        const offset = (y * 8 + x) * 4
        assert.deepEqual(bg.slice(offset, offset + 4), (inside ? fill : background).buffer)
      }
    }
  })
})
