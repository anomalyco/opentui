import { afterAll, beforeAll, expect, test } from "bun:test"
import { OptimizedBuffer } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { NativeImage } from "../image.js"
import { RGBA } from "../lib/RGBA.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderEvents } from "../renderer.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { TargetChannel } from "../types.js"

// Every recording command draws once through a paint hook (recorded, played by native paint) and once directly into an
// owned buffer. Both must produce the same cells, so recording changes neither what nor where a call draws. Resource
// rows free what they drew right after drawing it: a recording must keep it alive until native code paints.
const width = 12
const height = 4
const white = RGBA.fromInts(255, 255, 255)
const red = RGBA.fromInts(255, 0, 0)
const blue = RGBA.fromInts(0, 0, 255)
const glass = RGBA.fromInts(0, 255, 0, 128)
const black = RGBA.fromInts(0, 0, 0)
const sepia = new Float32Array([0.39, 0.77, 0.19, 0, 0.35, 0.69, 0.17, 0, 0.27, 0.53, 0.13, 0, 0, 0, 0, 1])
const box = { x: 0, y: 0, width: 10, height: 3, border: true, borderColor: white, backgroundColor: blue }
const grid = {
  borderChars: new Uint32Array(Array.from("┌┐└┘─│┬┴├┤┼", (char) => char.codePointAt(0)!)),
  borderFg: white,
  borderBg: blue,
  columnOffsets: new Int32Array([0, 4, 9]),
  rowOffsets: new Int32Array([0, 2, 3]),
  drawInner: true,
  drawOuter: true,
}

let setup: TestRendererSetup
const errors: unknown[] = []
let sceneText: TextRenderable
let pixel: NativeImage
const scene = () => setup.renderer.nativeScene
const pixels = new Uint8Array(4 * 4 * 4).map((_, index) => (index * 37) & 0xff)

beforeAll(async () => {
  setup = await createTestRenderer({ width, height })
  setup.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  // Hidden scene text keeps its layout without painting itself.
  sceneText = new TextRenderable(setup.renderer, { content: "scene", width: 5, height: 1, opacity: 0 })
  setup.renderer.root.add(sceneText)
  pixel = NativeImage.fromRgba(pixels, 1, 1, 4, { owner: scene().resourceContext })
})

afterAll(async () => {
  setup.renderer.destroy()
  await setup.renderer.closed
})

const operations: Record<string, (buffer: OptimizedBuffer) => void> = {
  text: (buffer) => {
    buffer.drawText("hello", 1, 0, red, blue, 1)
    buffer.drawText(123 as never, 7, 0, white)
    buffer.drawText("漢字e\u0301👨‍👩‍👧", 0, 1, white)
    buffer.drawText("a\ud800b", 0, 2, white)
    buffer.drawText(["a", "b"] as never, 4, 2, white)
    buffer.drawText(undefined as never, 8, 2, white)
    buffer.drawText(null as never, 8, 2, white)
    buffer.drawText("clipped text", -3, height - 1, white)
  },
  "clear, fills, cells, characters, and boxes": (buffer) => {
    buffer.drawText("gone", 0, 0, white)
    buffer.clear(red)
    buffer.fillRect(0, 0, 6, 2, blue)
    buffer.fillRect(2, 1, 6, 2, glass)
    const titles = { title: "up", titleAlignment: "center", bottomTitle: "dn", bottomTitleAlignment: "right" } as const
    buffer.drawBox({ ...box, y: 1, width: 6, borderStyle: "rounded", ...titles })
    buffer.drawBox({ ...box, x: 6, width: 6, height: 4, shouldFill: true, title: 42 as never, bottomTitle: 0 as never })
    buffer.setCell(1, 0, "x", white, red, 2)
    buffer.setCellWithAlphaBlending(3, 0, "y", white, glass)
    buffer.drawChar(0x41, 5, 0, white, red)
    buffer.drawChar(0x754c, 2, 2, white, blue)
  },
  "composed buffer": (buffer) => {
    const surface = OptimizedBuffer.create(3, 2, "unicode", { owner: scene() })
    surface.clear(blue)
    surface.drawText("s1", 0, 0, white, blue)
    surface.drawText("界", 0, 1, red)
    buffer.drawFrameBuffer(0, 0, surface)
    buffer.drawFrameBuffer(5, 1, surface, 1, 0, 2, 2)
    surface.destroy()
  },
  "scissor and opacity stacks": (buffer) => {
    buffer.fillRect(0, 0, width, height, blue)
    buffer.pushScissorRect(1, 0, 6, 3)
    buffer.pushScissorRect(3, 1, 8, 1)
    buffer.fillRect(0, 0, width, height, red)
    buffer.popScissorRect()
    buffer.pushOpacity(0.5)
    buffer.pushOpacity(0.5)
    buffer.drawText("abcdefghijkl", 0, 0, white)
    buffer.popOpacity()
    buffer.drawText("half", 0, 2, white)
    buffer.clearOpacity()
    buffer.clearScissorRects()
    buffer.drawText("after", 0, 3, white)
  },
  grid: (buffer) => buffer.drawGrid(grid),
  "packed cells": (buffer) => {
    const cells = new Float32Array(24)
    cells.set([1, 0, 0, 1, 1, 1, 1, 1])
    cells.set([0, 0, 1, 0.5, 0, 1, 0, 0.5], 12)
    new Uint32Array(cells.buffer).set([0x70], 8)
    new Uint32Array(cells.buffer).set([0x2588], 20)
    buffer.drawPackedBuffer(new Uint8Array(cells.buffer), cells.byteLength, 1, 1, 2, 1)
  },
  "supersampled pixels": (buffer) => {
    const pixels = new Uint8Array(8 * 4 * 4).map((_, index) => (index * 29) & 0xff)
    buffer.drawSuperSampleBuffer(1, 1, pixels, pixels.byteLength, "rgba8unorm", 8 * 4)
    buffer.drawSuperSampleBuffer(6, 1, pixels, pixels.byteLength, "bgra8unorm", 8 * 4)
  },
  "grayscale with and without colors": (buffer) => {
    const samples = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.1, 0.6, 0.9])
    buffer.drawGrayscaleBuffer(0, 0, samples, 4, 2)
    buffer.drawGrayscaleBuffer(5, 0, samples, 4, 2, red, blue)
    buffer.drawGrayscaleBufferSupersampled(0, 2, samples, 4, 2, white, null)
    buffer.drawGrayscaleBufferSupersampled(5, 2, samples, 4, 2, null, glass)
  },
  "uniform and masked color matrix": (buffer) => {
    buffer.fillRect(0, 0, width, 2, red)
    buffer.drawText("tint", 0, 0, white, blue)
    buffer.colorMatrixUniform(sepia, 0.75, TargetChannel.Both)
    buffer.fillRect(0, 2, width, 2, blue)
    buffer.colorMatrix(sepia, new Float32Array([0, 2, 1, 3, 3, 0.5, 11, 3, 1]), 1, TargetChannel.BG)
    buffer.colorMatrix(sepia, new Float32Array([1, 1, 1]), 1, TargetChannel.FG)
  },
  "text view": (buffer) => {
    const text = TextBuffer.create("unicode", scene())
    text.setText("view\n漢字")
    const view = TextBufferView.create(text)
    buffer.drawTextBuffer(view, 2, 1)
    view.destroy()
    text.destroy()
  },
  "editor view": (buffer) => {
    const edit = EditBuffer.create("unicode", scene())
    edit.setText("edit")
    const view = EditorView.create(edit, 4, 1)
    buffer.drawEditorView(view, 1, 2)
    view.destroy()
    edit.destroy()
  },
  "scene text": (buffer) => scene().drawText(sceneText, buffer, 3, 0),
  // One image shares the scene's Context; the other is copied into it from the automatic image Context.
  images: (buffer) => {
    const shared = NativeImage.fromRgba(pixels, 4, 4, 16, { owner: scene().resourceContext })
    const copied = NativeImage.fromRgba(pixels, 4, 4, 16)
    buffer.drawImage(shared, 0, 0, 4, 2, 0, 0, 0, 0, 4, 4, "blocks")
    buffer.drawImage(copied, 5, 1, 2, 1, 0, 0, 1, 1, 2, 2, "blocks")
    shared.dispose()
    copied.dispose()
  },
  "encoded Unicode": (buffer) => {
    const encoded = buffer.encodeUnicode("A👋B")
    let x = 0
    for (const glyph of encoded.data) {
      buffer.drawChar(glyph.char, x, 0, white, blue)
      x += glyph.width
    }
    buffer.freeUnicode(encoded)
  },
}

// Each call fails after the buffer checks it, inside the recorder for a paint hook. A failed recorder call must leave
// nothing behind, including the slot header that the first drawing call of a hook writes.
const rejectedCalls: ((buffer: OptimizedBuffer) => void)[] = [
  (buffer) => buffer.drawText("x", 0.5, 0, white),
  (buffer) => buffer.drawBox({ ...box, title: "\ud800".repeat(32_769) }),
  (buffer) => buffer.pushScissorRect(0x7fff_ffff, 0, 2, 1),
  (buffer) => buffer.pushOpacity(NaN),
  (buffer) => buffer.drawGrid({ ...grid, drawInner: "yes" as never }),
  (buffer) => buffer.drawPackedBuffer(new Uint8Array(48), 48, 0.5, 0, 1, 1),
  (buffer) => buffer.drawSuperSampleBuffer(0.5, 0, new Uint8Array(16), 16, "rgba8unorm", 8),
  (buffer) => buffer.drawGrayscaleBuffer(0.5, 0, new Float32Array(1), 1, 1),
  (buffer) => buffer.colorMatrixUniform(sepia, 1, -1 as never),
  (buffer) => buffer.colorMatrix(sepia, [0, 0, 1] as never),
  (buffer) => scene().drawText(sceneText, buffer, 0.5, 0),
  (buffer) => buffer.drawImage(pixel, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, "bogus" as never),
  (buffer) => {
    const encoded = buffer.encodeUnicode("👋")
    try {
      buffer.drawChar(encoded.data[0].char, 0.5, 0, white, blue)
    } finally {
      buffer.freeUnicode(encoded)
    }
  },
]

const rejectAll = (buffer: OptimizedBuffer) =>
  rejectedCalls.filter((call) => {
    try {
      call(buffer)
      return false
    } catch {
      return true
    }
  }).length

/** One string per row: each span's text, foreground, background, and attributes. */
function rows(buffer: OptimizedBuffer): string[] {
  return buffer
    .getSpanLines()
    .map(({ spans }) =>
      spans.map(({ text, fg, bg, attributes }) => `${text}|${fg.toInts()}|${bg.toInts()}|${attributes}`).join(" "),
    )
}

test.each(Object.keys(operations))("recorded %s paints the cells that direct drawing does", async (name) => {
  const { renderer, renderOnce } = setup
  let paint: (buffer: OptimizedBuffer) => void
  const node = new BoxRenderable(renderer, {
    position: "absolute",
    width,
    height,
    renderAfter: (buffer) => paint(buffer),
  })
  const direct = OptimizedBuffer.create(width, height, "unicode", { owner: renderer.nativeScene })
  try {
    // Both targets start from the same opaque cells, so blending reads the same destination.
    const rejected: number[] = []
    const draw = (buffer: OptimizedBuffer) => {
      let count = rejectAll(buffer)
      buffer.clear(black)
      operations[name](buffer)
      count += rejectAll(buffer)
      rejected.push(count)
    }
    paint = draw
    renderer.root.add(node)
    await renderOnce()
    const recorded = rows(renderer.currentRenderBuffer)
    draw(direct)
    if (name === "images") {
      // An owned buffer keeps image placements; native resolves them when it composes the buffer into a frame.
      paint = (buffer) => buffer.drawFrameBuffer(0, 0, direct)
      await renderOnce()
    }

    expect(errors.splice(0)).toEqual([])
    expect(rejected).toEqual([rejectedCalls.length * 2, rejectedCalls.length * 2])
    expect(recorded).toEqual(name === "images" ? rows(renderer.currentRenderBuffer) : rows(direct))
  } finally {
    node.destroy()
    direct.destroy()
  }
})
