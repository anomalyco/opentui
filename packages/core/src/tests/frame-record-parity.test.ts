import { afterAll, beforeAll, expect, test } from "bun:test"
import { OptimizedBuffer } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { NativeImage } from "../image.js"
import { RGBA } from "../lib/RGBA.js"
import { Renderable } from "../Renderable.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderEvents } from "../renderer.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { TargetChannel } from "../types.js"

// Every operation draws once through a paint hook (recorded, played by native paint) and once directly into an
// owned buffer. Both must produce the same cells, so recording changes neither what nor where a call draws.
const width = 12
const height = 4
const white = RGBA.fromInts(255, 255, 255)
const red = RGBA.fromInts(255, 0, 0)
const blue = RGBA.fromInts(0, 0, 255)
const glass = RGBA.fromInts(0, 255, 0, 128)
const black = RGBA.fromInts(0, 0, 0)
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
const sepia = new Float32Array([0.39, 0.77, 0.19, 0, 0.35, 0.69, 0.17, 0, 0.27, 0.53, 0.13, 0, 0, 0, 0, 1])

let setup: TestRendererSetup
let resources: {
  surface: OptimizedBuffer
  textView: TextBufferView
  editorView: EditorView
  image: NativeImage
  sceneText: TextRenderable
}

beforeAll(async () => {
  setup = await createTestRenderer({ width, height })
  const scene = setup.renderer.nativeScene
  const surface = OptimizedBuffer.create(3, 2, "unicode", { owner: scene })
  surface.clear(blue)
  surface.drawText("s1", 0, 0, white, blue)
  surface.drawText("界", 0, 1, red)
  const text = TextBuffer.create("unicode", scene)
  text.setText("view\n漢字")
  const edit = EditBuffer.create("unicode", scene)
  edit.setText("edit")
  const pixels = new Uint8Array(4 * 4 * 4).map((_, index) => (index * 37) & 0xff)
  // Hidden scene text keeps its layout without painting itself.
  const sceneText = new TextRenderable(setup.renderer, { content: "scene", width: 5, height: 1, opacity: 0 })
  setup.renderer.root.add(sceneText)
  resources = {
    surface,
    textView: TextBufferView.create(text),
    editorView: EditorView.create(edit, 4, 1),
    image: NativeImage.fromRgba(pixels, 4, 4, 16, { owner: scene.resourceContext }),
    sceneText,
  }
})

afterAll(async () => {
  setup.renderer.destroy()
  await setup.renderer.closed
})

function packedCells(cells: { char: string; fg: RGBA; bg: RGBA }[]): Uint8Array {
  const bytes = new Uint8Array(cells.length * 48)
  const view = new DataView(bytes.buffer)
  cells.forEach(({ char, fg, bg }, cell) => {
    const offset = cell * 48
    bg.toInts().forEach((value, channel) => view.setFloat32(offset + channel * 4, value / 255, true))
    fg.toInts().forEach((value, channel) => view.setFloat32(offset + 16 + channel * 4, value / 255, true))
    view.setUint32(offset + 32, char.codePointAt(0)!, true)
  })
  return bytes
}

const operations: Record<string, (buffer: OptimizedBuffer) => void> = {
  "ASCII text with colors and attributes": (buffer) => buffer.drawText("hello", 1, 0, red, blue, 1),
  "wide, combined, and joined graphemes": (buffer) => {
    buffer.drawText("漢字", 0, 0, white)
    buffer.drawText("e\u0301👨‍👩‍👧", 0, 1, white)
  },
  "a lone surrogate": (buffer) => buffer.drawText("a\ud800b", 0, 0, white),
  "non-string text": (buffer) => {
    buffer.drawText(123 as never, 0, 0, white)
    buffer.drawText(["a", "b"] as never, 4, 0, white)
    buffer.drawText(null as never, 0, 1, white)
    buffer.drawText(undefined as never, 6, 1, white)
    const titles = { title: 42 as never, bottomTitle: 0 as never }
    buffer.drawBox({
      x: 0,
      y: 2,
      width: 8,
      height: 2,
      border: true,
      borderColor: white,
      backgroundColor: blue,
      ...titles,
    })
  },
  "text clipped at the edges": (buffer) => buffer.drawText("clipped text", -3, height - 1, white),
  "fill with alpha": (buffer) => {
    buffer.fillRect(0, 0, 6, 2, red)
    buffer.fillRect(2, 1, 6, 2, glass)
  },
  "cells with and without blending": (buffer) => {
    buffer.fillRect(0, 0, width, 1, blue)
    buffer.setCell(1, 0, "x", white, red, 2)
    buffer.setCellWithAlphaBlending(3, 0, "y", white, glass)
  },
  characters: (buffer) => {
    buffer.drawChar(0x41, 0, 0, white, red)
    buffer.drawChar(0x754c, 2, 0, white, blue)
  },
  "box with titles": (buffer) =>
    buffer.drawBox({
      x: 0,
      y: 0,
      width: 10,
      height: 3,
      border: true,
      borderStyle: "rounded",
      borderColor: white,
      backgroundColor: blue,
      shouldFill: true,
      title: "top",
      titleAlignment: "center",
      bottomTitle: "end",
      bottomTitleAlignment: "right",
    }),
  "composed buffer and region": (buffer) => {
    buffer.drawFrameBuffer(0, 0, resources.surface)
    buffer.drawFrameBuffer(5, 1, resources.surface, 1, 0, 2, 2)
  },
  clear: (buffer) => {
    buffer.drawText("gone", 0, 0, white)
    buffer.clear(red)
  },
  "nested scissors": (buffer) => {
    buffer.pushScissorRect(1, 0, 6, 3)
    buffer.pushScissorRect(3, 1, 8, 1)
    buffer.fillRect(0, 0, width, height, red)
    buffer.popScissorRect()
    buffer.drawText("abcdefghijkl", 0, 0, white)
    buffer.clearScissorRects()
    buffer.drawText("after", 0, 3, white)
  },
  "nested opacity": (buffer) => {
    buffer.fillRect(0, 0, width, height, blue)
    buffer.pushOpacity(0.5)
    buffer.pushOpacity(0.5)
    buffer.fillRect(0, 0, 4, 2, red)
    buffer.popOpacity()
    buffer.drawText("half", 4, 0, white)
    buffer.clearOpacity()
    buffer.drawText("full", 4, 1, white)
  },
  grid: (buffer) =>
    buffer.drawGrid({
      borderChars: new Uint32Array(Array.from("┌┐└┘─│┬┴├┤┼", (char) => char.codePointAt(0)!)),
      borderFg: white,
      borderBg: blue,
      columnOffsets: new Int32Array([0, 4, 9]),
      rowOffsets: new Int32Array([0, 2, 3]),
      drawInner: true,
      drawOuter: true,
    }),
  "packed cells": (buffer) =>
    buffer.drawPackedBuffer(
      packedCells([
        { char: "p", fg: white, bg: red },
        { char: "█", fg: blue, bg: black },
        { char: "q", fg: glass, bg: blue },
        { char: "r", fg: red, bg: glass },
      ]),
      4 * 48,
      1,
      1,
      2,
      2,
    ),
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
  "uniform color matrix": (buffer) => {
    buffer.fillRect(0, 0, width, height, red)
    buffer.drawText("tint", 0, 0, white, blue)
    buffer.colorMatrixUniform(sepia, 0.75, TargetChannel.Both)
  },
  "masked color matrix": (buffer) => {
    buffer.fillRect(0, 0, width, height, blue)
    buffer.colorMatrix(sepia, new Float32Array([0, 0, 1, 3, 1, 0.5, 11, 3, 1]), 1, TargetChannel.BG)
    buffer.colorMatrix(sepia, new Float32Array([1, 1, 1]), 1, TargetChannel.FG)
  },
  "text view": (buffer) => buffer.drawTextBuffer(resources.textView, 2, 1),
  "editor view": (buffer) => buffer.drawEditorView(resources.editorView, 1, 2),
  "scene text": (buffer) => setup.renderer.nativeScene.drawText(resources.sceneText, buffer, 3, 0),
  image: (buffer) => {
    buffer.drawImage(resources.image, 0, 0, 4, 2, 0, 0, 0, 0, 4, 4, "blocks")
    buffer.drawImage(resources.image, 5, 1, 2, 1, 0, 0, 1, 1, 2, 2, "blocks")
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
  (buffer) =>
    buffer.drawBox({
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      border: true,
      borderColor: white,
      backgroundColor: blue,
      title: "\ud800".repeat(32_769),
    }),
  (buffer) => buffer.pushScissorRect(0x7fff_ffff, 0, 2, 1),
  (buffer) => buffer.pushOpacity(NaN),
  (buffer) =>
    buffer.drawGrid({
      borderChars: new Uint32Array(11),
      borderFg: white,
      borderBg: blue,
      columnOffsets: new Int32Array([0, 1]),
      rowOffsets: new Int32Array([0, 1]),
      drawInner: "yes" as never,
      drawOuter: true,
    }),
  (buffer) => buffer.drawPackedBuffer(new Uint8Array(48), 48, 0.5, 0, 1, 1),
  (buffer) => buffer.drawSuperSampleBuffer(0.5, 0, new Uint8Array(16), 16, "rgba8unorm", 8),
  (buffer) => buffer.drawGrayscaleBuffer(0.5, 0, new Float32Array(1), 1, 1),
  (buffer) => buffer.colorMatrixUniform(identity, 1, -1 as never),
  (buffer) => buffer.colorMatrix(identity, [0, 0, 1] as never),
  (buffer) => buffer.drawTextBuffer(resources.textView, 0.5, 0),
  (buffer) => buffer.drawImage(resources.image, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, "bogus" as never),
  (buffer) => {
    const encoded = buffer.encodeUnicode("👋")
    try {
      buffer.drawChar(encoded.data[0].char, 0.5, 0, white, blue)
    } finally {
      buffer.freeUnicode(encoded)
    }
  },
]

function rejectAll(buffer: OptimizedBuffer): number {
  let rejected = 0
  for (const call of rejectedCalls) {
    try {
      call(buffer)
    } catch {
      rejected++
    }
  }
  return rejected
}

/** One string per row: each span's text, foreground, background, and attributes. */
function rows(buffer: OptimizedBuffer): string[] {
  return buffer
    .getSpanLines()
    .map(({ spans }) =>
      spans.map(({ text, fg, bg, attributes }) => `${text}|${fg.toInts()}|${bg.toInts()}|${attributes}`).join(" "),
    )
}

class Recorded extends Renderable {
  draw?: (buffer: OptimizedBuffer) => void
  protected renderSelf(buffer: OptimizedBuffer): void {
    this.draw?.(buffer)
  }
}

test.each(Object.keys(operations))("recorded %s paints the cells that direct drawing does", async (name) => {
  const { renderer, renderOnce } = setup
  const errors: unknown[] = []
  const report = ({ error }: { error: unknown }) => errors.push(error)
  renderer.on(CliRenderEvents.RENDER_ERROR, report)
  const node = new Recorded(renderer, { position: "absolute", width, height })
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
    node.draw = draw
    renderer.root.add(node)
    await renderOnce()
    const recorded = rows(renderer.currentRenderBuffer)
    draw(direct)
    if (name === "image") {
      // An owned buffer keeps image placements; native resolves them when it composes the buffer into a frame.
      node.draw = (buffer) => buffer.drawFrameBuffer(0, 0, direct)
      await renderOnce()
    }

    expect(errors).toEqual([])
    expect(rejected).toEqual([rejectedCalls.length * 2, rejectedCalls.length * 2])
    expect(recorded).toEqual(name === "image" ? rows(renderer.currentRenderBuffer) : rows(direct))
  } finally {
    renderer.off(CliRenderEvents.RENDER_ERROR, report)
    node.destroy()
    direct.destroy()
  }
})
