import { expectRenderSnapshot } from "./render-snapshot.js"
import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable } from "../Renderable.js"
import { RGBA } from "../lib/RGBA.js"
import { StyledText } from "../lib/styled-text.js"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { ArrowRenderable } from "../renderables/ScrollBar.js"
import { SliderRenderable } from "../renderables/Slider.js"

import { TextRenderable } from "../renderables/Text.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererOptions, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup(options: TestRendererOptions = {}) {
  const target = await createTestRenderer({ width: 16, height: 8, clock: new ManualClock(), ...options })
  setups.push(target)
  target.renderer.setCursorPosition(1, 1, false)
  const errors: unknown[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  return {
    ...target,
    async frame() {
      await target.renderOnce()
      assert.deepEqual(errors, [])
      return { cells: target.captureSpans(), cursor: target.renderer.getCursorState() }
    },
  }
}

test.each([
  ["Box", "backgroundColor"],
  ["Box", "borderColor"],
  ["Box", "focusedBorderColor"],
  ["Box", "titleColor"],
  ["Slider", "backgroundColor"],
  ["Slider", "foregroundColor"],
  ["Arrow", "backgroundColor"],
  ["Arrow", "foregroundColor"],
  ["editor", "cursorColor"],
] as const)("%s %s retains assigned colors independently of caller and getter arrays", async (kind, property) => {
  const target = await setup()
  const color = RGBA.fromHex("#123456")
  const options = { width: 8, height: 3, [property]: color }
  const node =
    kind === "Box"
      ? new BoxRenderable(target.renderer, { ...options, border: true, title: "T", focusable: true })
      : kind === "Slider"
        ? new SliderRenderable(target.renderer, { ...options, orientation: "horizontal", value: 40 })
        : kind === "Arrow"
          ? new ArrowRenderable(target.renderer, { ...options, direction: "right" })
          : new TextareaRenderable(target.renderer, { ...options, initialValue: "edit" })
  target.renderer.root.add(node)
  if (property === "focusedBorderColor" || kind === "editor") node.focus()
  const before = await target.frame()
  color.buffer.fill(0)
  const exposed = Reflect.get(node, property) as RGBA
  exposed.buffer.fill(0)
  node.requestRender()
  assert.deepEqual(await target.frame(), before)
  assert.deepEqual((Reflect.get(node, property) as RGBA).toInts(), [18, 52, 86, 255])
  color.buffer = RGBA.fromHex("#abcdef").buffer
  Reflect.set(node, property, color)
  const reassigned = await target.frame()
  assert.notDeepEqual(reassigned, before)
  color.buffer.fill(0)
  node.requestRender()
  assert.deepEqual(await target.frame(), reassigned)
})

test.each(["construction", "setter"] as const)("renderer snapshots its background at %s", async (stage) => {
  const color = RGBA.fromHex("#123456")
  const target = await setup({ backgroundColor: stage === "construction" ? color : undefined })
  if (stage === "setter") target.renderer.setBackgroundColor(color)
  const before = await target.frame()
  color.buffer.fill(255)
  target.renderer.requestRender()
  assert.deepEqual(await target.frame(), before)
  target.renderer.setBackgroundColor(color)
  assert.notDeepEqual(await target.frame(), before)
})

test("paint-time same-object reassignment affects only the unpainted suffix", async () => {
  const target = await setup()
  const color = RGBA.fromHex("#123456")
  const later = new BoxRenderable(target.renderer, { width: 4, height: 1, backgroundColor: color })
  const first = new BoxRenderable(target.renderer, {
    width: 4,
    height: 1,
    backgroundColor: color,
    renderAfter() {
      color.buffer[0] = 200
      later.backgroundColor = color
    },
  })
  target.renderer.root.add(first)
  target.renderer.root.add(later)
  const frame = await target.frame()
  assert.deepEqual(frame.cells.lines[0].spans[0].bg.toInts(), [18, 52, 86, 255])
  assert.deepEqual(frame.cells.lines[1].spans[0].bg.toInts(), [200, 52, 86, 255])
  expectRenderSnapshot([frame, await target.frame()])
})

test("draw-time RGBA reuse stays mutable while retained text and boxes remain snapshots", async () => {
  const target = await setup()
  const color = RGBA.fromHex("#123456")
  const box = new BoxRenderable(target.renderer, { width: 8, height: 1, backgroundColor: color })
  const styled = new TextRenderable(target.renderer, {
    height: 1,
    content: new StyledText([{ __isChunk: true, text: "styled", fg: color }]),
  })
  const text = new TextRenderable(target.renderer, { height: 1, content: "plain", fg: color })
  const editor = new TextareaRenderable(target.renderer, { height: 1, initialValue: "editor", textColor: color })
  const custom = new BoxRenderable(target.renderer, {
    width: 8,
    height: 1,
    renderAfter(buffer) {
      buffer.fillRect(this.x, this.y, this.width, this.height, color)
    },
  })
  for (const node of [box, styled, text, editor, custom]) target.renderer.root.add(node)
  const before = await target.frame()
  color.buffer[0] = 220
  const after = await target.frame()
  assert.deepEqual(after.cells.lines.slice(0, 4), before.cells.lines.slice(0, 4))
  assert.notDeepEqual(after.cells.lines[4], before.cells.lines[4])
})

test("entered Box paint retains its snapshot and finishes after destruction", async () => {
  const target = await setup()
  const color = RGBA.fromHex("#123456")
  const calls: string[] = []
  const box = new BoxRenderable(target.renderer, {
    width: 4,
    height: 1,
    backgroundColor: color,
    renderBefore() {
      calls.push("before")
      color.buffer[0] = 200
      this.destroy()
    },
    renderAfter() {
      calls.push("after")
    },
  })
  target.renderer.root.add(box)
  const first = await target.frame()
  assert.deepEqual(first.cells.lines[0].spans[0].bg.toInts(), [18, 52, 86, 255])
  assert.deepEqual(calls, ["before", "after"])
  assert.equal(Renderable.renderablesByNumber.has(box.num), false)
  expectRenderSnapshot([first, await target.frame()])
})
