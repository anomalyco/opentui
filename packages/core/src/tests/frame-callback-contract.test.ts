import { getYogaNode } from "../lib/renderable-layout.js"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Renderable } from "../Renderable.js"
import type { BufferAccess, OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const red = RGBA.fromHex("#ff0000")
const green = RGBA.fromHex("#00ff00")
const blue = RGBA.fromHex("#0000ff")
let setup: TestRendererSetup

beforeEach(async () => {
  setup = await createTestRenderer({ width: 12, height: 4, clock: new ManualClock() })
})

afterEach(() => {
  setup.renderer.destroy()
})

test("renderAfter follows the node's own drawing, before descendants in parent-local z-order", async () => {
  const { renderer, renderOnce } = setup
  const calls: string[] = []
  class TracedRenderable extends Renderable {
    protected renderSelf(): void {
      calls.push(`${this.id}:self`)
    }
  }

  const parent = new TracedRenderable(renderer, { id: "parent", width: 1, height: 1, zIndex: 0 })
  const child = new TracedRenderable(renderer, { id: "child", width: 1, height: 1, zIndex: 100 })
  const sibling = new TracedRenderable(renderer, { id: "sibling", width: 1, height: 1, zIndex: 1 })
  for (const node of [parent, child, sibling]) {
    node.renderBefore = () => calls.push(`${node.id}:before`)
    node.renderAfter = () => calls.push(`${node.id}:after`)
  }
  parent.add(child)
  renderer.root.add(sibling)
  renderer.root.add(parent)

  await renderOnce()

  expect(calls).toEqual([
    "parent:before",
    "parent:self",
    "parent:after",
    "child:before",
    "child:self",
    "child:after",
    "sibling:before",
    "sibling:self",
    "sibling:after",
  ])
})

test.each(["legacy", "scoped"] as const)(
  "%s paint access reads and rewrites the framebuffer prefix before later drawing",
  async (access) => {
    const { renderer, renderOnce, captureCharFrame, captureSpans } = setup
    const withCells = (buffer: OptimizedBuffer, callback: (cells: Pick<BufferAccess, "char" | "fg">) => void) => {
      if (access === "scoped") buffer.withBuffers(callback)
      else callback(buffer.buffers)
    }
    await renderOnce()
    const previous = captureCharFrame()
    const next = renderer.nextRenderBuffer
    const current = renderer.currentRenderBuffer
    const calls: string[] = []
    let saved: Pick<BufferAccess, "char" | "fg"> | undefined
    let prefixColor: Uint16Array | undefined
    renderer.root.add(new TextRenderable(renderer, { content: "AB", width: 2, height: 1, fg: red }))
    renderer.root.add(
      new BoxRenderable(renderer, {
        width: 1,
        height: 1,
        renderBefore(buffer) {
          expect(buffer).toBe(next)
          expect(renderer.currentRenderBuffer).toBe(current)
          withCells(buffer, (cells) => {
            saved = cells
            const { char, fg } = cells
            calls.push(`prefix:${String.fromCharCode(...char.subarray(0, 3))}`)
            prefixColor = fg.slice(0, 4)
            char[0] = "X".charCodeAt(0)
            fg.set(green.buffer, 0)
            buffer.withBuffers(({ char }) => expect(char[0]).toBe(88))
            expect(new TextDecoder().decode(buffer.getRealCharBytes()).slice(0, 3)).toBe("XB ")
            expect(buffer.getSpanLines()[0].spans[0].text).toBe("X")
            expect(captureCharFrame()).toBe(previous)
            current.withBuffers(({ char }) => expect(char[0]).toBe(32))
          })
        },
      }),
    )
    renderer.root.add(
      new TextRenderable(renderer, {
        content: "Z",
        position: "absolute",
        left: 2,
        top: 0,
        width: 1,
        height: 1,
      }),
    )
    renderer.addPostProcessFn((buffer) => {
      expect(() => saved!.char).toThrow(/scope has ended/)
      withCells(buffer, ({ char }) => {
        calls.push(`post:${String.fromCharCode(...char.subarray(0, 3))}`)
        char[2] = "Y".charCodeAt(0)
      })
    })
    renderer.on("frame", () => calls.push(`frame:${captureCharFrame().trimEnd()}`))

    await renderOnce()

    expect(calls).toEqual(["prefix:AB ", "post:XBZ", "frame:XBY"])
    expect(prefixColor).toEqual(red.buffer)
    expect(captureSpans().lines[0].spans[0].fg).toEqual(green)
  },
)

test("custom painting can publish a geometry-dependent foreground to later text in the same frame", async () => {
  const { renderer, renderOnce, captureSpans } = setup
  const label = new TextRenderable(renderer, { content: "tab", width: 3, height: 1, fg: red })
  class PulseRenderable extends Renderable {
    protected renderSelf(): void {
      label.fg = this.width === 6 ? green : blue
    }
  }
  const pulse = new PulseRenderable(renderer, { width: "50%", height: 1 })
  renderer.root.add(pulse)
  renderer.root.add(label)

  await renderOnce()

  expect(captureSpans().lines[1].spans[0]).toMatchObject({ text: "tab", fg: green })

  pulse.width = "25%"
  await renderOnce()

  expect(captureSpans().lines[1].spans[0]).toMatchObject({ text: "tab", fg: blue })
})

test("lifecycle runs before layout and onUpdate before paint, including unchanged frames", async () => {
  const { renderer, renderOnce, captureSpans } = setup
  const calls: string[] = []
  class UpdatingBox extends BoxRenderable {
    protected onUpdate(): void {
      calls.push(`${this.id}:update`)
    }
  }
  const parent = new UpdatingBox(renderer, { id: "parent", width: 2, height: 1, backgroundColor: red })
  const child = new UpdatingBox(renderer, { id: "child", width: "100%", height: 1, backgroundColor: blue })
  parent.onLifecyclePass = () => {
    calls.push("parent:lifecycle")
    parent.width = 6
  }
  child.onLifecyclePass = () => calls.push("child:lifecycle")
  parent.renderBefore = () => calls.push("parent:paint")
  child.renderBefore = () => calls.push("child:paint")
  renderer.root.on("layout-changed", () => calls.push("layout"))
  renderer.root.add(parent)
  parent.add(child)

  await renderOnce()

  expect(calls).toEqual([
    "parent:lifecycle",
    "child:lifecycle",
    "layout",
    "parent:update",
    "child:update",
    "parent:paint",
    "child:paint",
  ])
  expect(child.width).toBe(6)
  expect(captureSpans().lines[0].spans[0].width).toBe(6)
  calls.length = 0

  await renderOnce()

  expect(calls).toEqual([
    "parent:lifecycle",
    "child:lifecycle",
    "parent:update",
    "child:update",
    "parent:paint",
    "child:paint",
  ])
  expect(renderer.getNativeStats().cellsUpdated).toBe(0)
})

test("accepted width is immediate while computed and painted width wait for layout", async () => {
  const { renderer, renderOnce, captureSpans } = setup
  const box = new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: red })
  renderer.root.add(box)
  await renderOnce()

  box.width = 4
  expect(getYogaNode(box).getWidth().value).toBe(4)
  expect(box.width).toBe(2)
  box.renderBefore = function () {
    this.width = 6
    this.renderBefore = undefined
  }

  await renderOnce()

  expect(getYogaNode(box).getWidth().value).toBe(6)
  expect(box.width).toBe(4)
  expect(captureSpans().lines[0].spans[0]).toMatchObject({ width: 4, bg: red })

  await renderOnce()

  expect(box.width).toBe(6)
  expect(captureSpans().lines[0].spans[0]).toMatchObject({ width: 6, bg: red })
})

test("mounted unfiltered nodes notify only size changes and update before wrapper geometry refresh", async () => {
  const { renderer, renderOnce } = setup
  const updates: number[][] = []
  const resizes: number[] = []
  class UpdatingBox extends BoxRenderable {
    protected onUpdate(): void {
      const layout = this.getLayout()
      updates.push([this.width, this.x, this.y, layout.width, layout.left, layout.top])
    }
  }
  const box = new UpdatingBox(renderer, {
    width: 2,
    height: 1,
    position: "absolute",
    left: 1,
    onSizeChange() {
      resizes.push(this.width)
    },
  })
  renderer.root.add(box)
  await renderOnce()
  expect(updates).toEqual([[2, 1, 0, 2, 1, 0]])
  expect(resizes).toEqual([])

  box.width = 4
  box.left = 3
  box.top = 1
  await renderOnce()
  expect(updates).toEqual([
    [2, 1, 0, 2, 1, 0],
    [2, 1, 0, 4, 3, 1],
  ])
  expect(resizes).toEqual([4])
  expect([box.width, box.x, box.y]).toEqual([4, 3, 1])

  await renderOnce()
  expect(updates.at(-1)).toEqual([4, 3, 1, 4, 3, 1])
  expect(resizes).toEqual([4])
})
