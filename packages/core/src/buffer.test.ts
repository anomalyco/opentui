import { ResourceContext } from "./buffer.js"
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { OptimizedBuffer, type BufferAccess } from "./buffer.js"
import { RGBA } from "./lib/RGBA.js"
import { NativeImage } from "./image.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 16, renderCellsMax: 256 })
})
afterEach(() => resourceContext.destroy())

describe("OptimizedBuffer", () => {
  let buffer: OptimizedBuffer

  beforeEach(() => {
    buffer = OptimizedBuffer.create(20, 5, "unicode", { owner: resourceContext, id: "test-buffer" })
  })

  afterEach(() => {
    buffer.destroy()
  })

  it("releases failed scopes, rejects the saved facade, and permits owned copies", () => {
    let saved: BufferAccess | undefined
    const failure = new Error("injected cell callback failure")
    expect(() =>
      buffer.withBuffers((cells) => {
        saved = cells
        throw failure
      }),
    ).toThrow(failure)
    expect(() => saved!.char).toThrow()
    const copy = buffer.withBuffers((cells) => ({
      width: cells.width,
      height: cells.height,
      char: cells.char.slice(),
    }))
    buffer.destroy()
    expect([copy.width, copy.height, copy.char.length]).toEqual([20, 5, 100])
  })

  it("converts both box titles before a title's toString can draw and skips title controls", () => {
    const other = OptimizedBuffer.create(12, 1, "unicode", { owner: resourceContext })
    const white = RGBA.fromInts(255, 255, 255)
    try {
      const bottomTitle = {
        toString() {
          other.drawText("XYZ", 0, 0, white)
          return "BOT"
        },
      }
      buffer.drawBox({
        x: 0,
        y: 0,
        width: 12,
        height: 3,
        border: true,
        borderColor: white,
        title: "T\nO\x1bP",
        bottomTitle,
      } as never)
      const rows = buffer.withBuffers(({ char }) =>
        [0, 2].map((y) => String.fromCodePoint(...char.subarray(y * 20, y * 20 + 12))),
      )
      expect(rows[0]).toContain("TOP")
      expect(rows[1]).toContain("BOT")
      expect(other.withBuffers(({ char }) => String.fromCodePoint(...char.subarray(0, 3)))).toBe("XYZ")
    } finally {
      other.destroy()
    }
  })

  it("rejects native resize failures without publishing dimensions and retries", () => {
    const fg = RGBA.fromInts(255, 255, 255)
    const bg = RGBA.fromInts(0, 0, 0)
    buffer.setCell(0, 0, "X", fg, bg, 0xff)
    const generation = buffer.withBuffers((cells) => cells.generation)
    expect(() => buffer.resize(65536, 65536)).toThrow()
    expect([buffer.width, buffer.height]).toEqual([20, 5])
    buffer.withBuffers((cells) => {
      expect([cells.width, cells.height]).toEqual([20, 5])
      expect(cells.generation).toBe(generation)
      expect(cells.char[0]).toBe(88)
      expect(cells.attributes[0]).toBe(0xff)
    })

    buffer.resize(4, 3)
    expect([buffer.width, buffer.height]).toEqual([4, 3])
    buffer.withBuffers((cells) => {
      expect([cells.width, cells.height]).toEqual([4, 3])
      expect(cells.generation > generation).toBe(true)
      expect(cells.char).toHaveLength(12)
      expect(cells.fg).toHaveLength(48)
      expect(cells.bg).toHaveLength(48)
      expect(cells.attributes).toHaveLength(12)
    })
    buffer.setCell(3, 2, "Y", fg, bg)
    buffer.withBuffers((cells) => expect(cells.char[11]).toBe(89))
  })

  it("preserves literal attributes and passes all u32 attribute bits across per-cell calls", () => {
    const fg = RGBA.fromInts(255, 255, 255)
    const bg = RGBA.fromInts(0, 0, 0)
    const draws = [
      (attributes: number) => buffer.setCell(0, 0, "S", fg, bg, attributes),
      (attributes: number) => buffer.setCellWithAlphaBlending(1, 0, "A", fg, bg, attributes),
      (attributes: number) => buffer.drawChar("D".codePointAt(0)!, 2, 0, fg, bg, attributes),
    ]
    // Native rejects a foreign link ID in bits 8..31; a truncated value would draw instead.
    draws.forEach((draw, index) => {
      draw(0xff - index)
      expect(() => draw(0x8000_00ff)).toThrow("InvalidArgument")
    })
    buffer.withBuffers((cells) => expect([...cells.attributes.slice(0, 3)]).toEqual([0xff, 0xfe, 0xfd]))
  })

  it("clips draws at negative positions", () => {
    // Positions cross the native API as signed i32, so every call here also checks that negative positions encode.
    const target = OptimizedBuffer.create(3, 2, "unicode", { owner: resourceContext, id: "negative-positions" })
    try {
      const white = RGBA.fromInts(255, 255, 255)
      const black = RGBA.fromInts(0, 0, 0)
      target.clear(black)

      target.setCell(-1, 0, "S", white, black)
      target.setCellWithAlphaBlending(0, -1, "A", white, black)
      target.drawChar("D".codePointAt(0)!, -1, -1, white, black)
      target.drawSuperSampleBuffer(-1, -1, new Uint8Array(16), 16, "rgba8unorm", 8)
      target.drawPackedBuffer(new Uint8Array(48), 48, -1, -1, 1, 1)
      target.drawText("ABCD", -2, 1, white, black)
      target.fillRect(-1, -1, 2, 2, RGBA.fromInts(255, 0, 0))

      expect(new TextDecoder().decode(target.getRealCharBytes(true))).toBe("   \nCD \n")
      expect(target.withBuffers(({ bg }) => [0, 1, 3].map((cell) => bg[cell * 4] & 0xff))).toEqual([255, 0, 0])
    } finally {
      target.destroy()
    }
  })

  it("fills nothing for a non-positive extent", () => {
    // Native extents are unsigned, so the wrapper must return before a negative extent reaches native code.
    const target = OptimizedBuffer.create(3, 2, "unicode", { owner: resourceContext, id: "empty-extents" })
    try {
      const red = RGBA.fromInts(255, 0, 0)
      target.clear(RGBA.fromInts(0, 0, 0))

      target.fillRect(1, 0, -1, 1, red)
      target.fillRect(1, 0, 1, -1, red)
      target.fillRect(1, 0, 0, 1, red)

      expect(target.withBuffers(({ bg }) => [0, 1, 2, 3, 4, 5].map((cell) => bg[cell * 4] & 0xff))).toEqual([
        0, 0, 0, 0, 0, 0,
      ])
    } finally {
      target.destroy()
    }
  })

  it("draws images as reserved cells with resolved fallback glyphs", () => {
    const image = NativeImage.fromRgba(
      Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255),
      2,
      2,
    )
    try {
      expect(buffer.drawImage(image, 0, 0, 1, 1)).toBe(true)
      const marker = buffer.withBuffers((cells) => cells.char[0])
      expect(marker >>> 30).toBe(1)
      expect(new TextDecoder().decode(buffer.getRealCharBytes())).not.toContain("�")
      buffer.setCell(0, 0, "X", RGBA.fromInts(255, 255, 255), RGBA.fromInts(0, 0, 0))
      buffer.withBuffers((cells) => expect(cells.char[0]).toBe("X".codePointAt(0)!))
    } finally {
      image.dispose()
    }
  })

  it("retains a Context-owned image copy after releasing the source", () => {
    const image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
    let raw: ReturnType<NativeImage["takeRaw"]> | undefined
    try {
      expect(buffer.drawImage(image, 0, 0, 1, 1)).toBe(true)
      raw = image.takeRaw()
      expect([...raw.data]).toEqual([1, 2, 3, 255])
      expect(new TextDecoder().decode(buffer.getRealCharBytes())).not.toContain("�")
      buffer.destroy()
    } finally {
      raw?.dispose()
      image.dispose()
    }
  })

  it("retains a drawn same-Context image until the buffer is cleared or destroyed", () => {
    for (const release of [() => buffer.clear(), () => buffer.destroy()]) {
      const image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1, 4, { owner: resourceContext })
      let raw: ReturnType<NativeImage["takeRaw"]> | undefined
      try {
        expect(buffer.drawImage(image, 0, 0, 1, 1)).toBe(true)
        expect(() => image.takeRaw()).toThrow("native buffers retain the image")
        release()
        raw = image.takeRaw()
        expect([...raw.data]).toEqual([1, 2, 3, 255])
      } finally {
        raw?.dispose()
        image.dispose()
      }
    }
  })

  it("rejects invalid image draw geometry before FFI", () => {
    const image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
    try {
      expect(() => buffer.drawImage(image, 0, 0, Number.POSITIVE_INFINITY, 1)).toThrow(RangeError)
      expect(() => buffer.drawImage(image, 0, 0, -1, 1)).toThrow(RangeError)
      expect(() => buffer.drawImage(image, 0.5, 0, 1, 1)).toThrow(RangeError)
      expect(() => buffer.drawImage(image, 0, 0, 0x80000000, 1)).toThrow(RangeError)
      expect(() => buffer.drawImage(image, 0x7fffffff, 0, 1, 1)).toThrow(RangeError)
    } finally {
      image.dispose()
    }
  })

  describe("non-positive extents", () => {
    // Native extents are unsigned, so these must not reach native code as negative values.
    const white = RGBA.fromInts(255, 255, 255)
    const black = RGBA.fromInts(0, 0, 0)
    const red = RGBA.fromInts(255, 0, 0)
    const snapshot = () =>
      buffer.withBuffers((cells) => ({ char: [...cells.char], fg: [...cells.fg], bg: [...cells.bg] }))

    it("clips everything inside a scissor rect with a non-positive extent", () => {
      buffer.clear(black)
      const blank = snapshot()

      buffer.pushScissorRect(0, 0, -1, 5)
      buffer.fillRect(0, 0, 20, 5, red)
      buffer.popScissorRect()

      buffer.pushScissorRect(0, 0, 20, 5)
      buffer.pushScissorRect(0, 0, 20, -1)
      buffer.drawText("hidden", 0, 0, white, black)
      buffer.popScissorRect()
      buffer.popScissorRect()

      expect(snapshot()).toEqual(blank)
    })

    it("skips drawBox with a non-positive extent", () => {
      buffer.clear(black)
      const blank = snapshot()

      for (const [width, height] of [
        [-1, 3],
        [3, -1],
      ]) {
        buffer.drawBox({
          x: 0,
          y: 0,
          width,
          height,
          border: true,
          borderColor: white,
          backgroundColor: red,
          shouldFill: true,
          title: "title",
        })
      }

      expect(snapshot()).toEqual(blank)
    })

    it("skips drawPackedBuffer with a non-positive length or cell count", () => {
      const cellCount = 20 * 5
      const packed = new Uint8Array(cellCount * 48)
      const floats = new Float32Array(packed.buffer)
      const words = new Uint32Array(packed.buffer)
      for (let cell = 0; cell < cellCount; cell++) {
        floats.set([1, 0, 0, 1, 1, 1, 1, 1], cell * 12)
        words[cell * 12 + 8] = "X".codePointAt(0)!
      }
      buffer.clear(black)
      const blank = snapshot()

      buffer.drawPackedBuffer(packed, -48, 0, 0, 20, 5)
      buffer.drawPackedBuffer(packed, packed.byteLength, 0, 0, 0, 5)
      buffer.drawPackedBuffer(packed, packed.byteLength, 0, 0, -1, 5)
      buffer.drawPackedBuffer(packed, packed.byteLength, 0, 0, 20, -1)
      expect(snapshot()).toEqual(blank)

      buffer.drawPackedBuffer(packed, packed.byteLength, 0, 0, 20, 5)
      expect(snapshot()).not.toEqual(blank)
    })
  })

  describe("encodeUnicode", () => {
    it("should encode simple ASCII text", () => {
      const encoded = buffer.encodeUnicode("Hello")
      expect(encoded).not.toBeNull()
      expect(encoded!.data.length).toBe(5)
      expect(encoded!.data.map((entry) => entry.width)).toEqual([1, 1, 1, 1, 1])
      for (const [x, entry] of encoded!.data.entries())
        buffer.drawChar(entry.char, x, 0, RGBA.fromInts(255, 255, 255), RGBA.fromInts(0, 0, 0))
      expect(new TextDecoder().decode(buffer.getRealCharBytes()).startsWith("Hello")).toBe(true)

      buffer.freeUnicode(encoded!)
    })

    it("should encode emoji with correct width", () => {
      const encoded = buffer.encodeUnicode("👋")
      expect(encoded).not.toBeNull()
      expect(encoded!.data.length).toBe(1)
      expect(encoded!.data[0].width).toBe(2)

      buffer.freeUnicode(encoded!)
    })

    it("should encode mixed ASCII and emoji", () => {
      const encoded = buffer.encodeUnicode("Hi 👋 World")
      expect(encoded).not.toBeNull()
      expect(encoded!.data.length).toBe(10) // H, i, space, emoji, space, W, o, r, l, d

      // Check ASCII chars
      expect(encoded!.data[0].width).toBe(1)

      // Check emoji
      expect(encoded!.data[3].width).toBe(2)

      buffer.freeUnicode(encoded!)
    })

    it("should handle empty string", () => {
      const encoded = buffer.encodeUnicode("")
      expect(encoded).not.toBeNull()
      expect(encoded!.data.length).toBe(0)

      buffer.freeUnicode(encoded!)
    })

    it("should encode monkey emoji frames and draw in a line", () => {
      const frames = ["🙈 ", "🙈 ", "🙉 ", "🙊 "]
      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(0, 0, 0, 1)

      buffer.clear(bg)

      let x = 0
      for (const frame of frames) {
        const encoded = buffer.encodeUnicode(frame)
        expect(encoded).not.toBeNull()

        for (const encodedChar of encoded!.data) {
          buffer.drawChar(encodedChar.char, x, 0, fg, bg)
          x += encodedChar.width
        }

        buffer.freeUnicode(encoded!)
      }

      const frameBytes = buffer.getRealCharBytes(false)
      const frameText = new TextDecoder().decode(frameBytes)
      expect(frameText).toContain("🙈")
      expect(frameText).toContain("🙉")
      expect(frameText).toContain("🙊")
    })
  })

  describe("drawChar", () => {
    it("should draw a simple ASCII character", () => {
      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(0, 0, 0, 1)

      buffer.drawChar(72, 0, 0, fg, bg) // 'H'

      const chars = buffer.withBuffers((cells) => cells.char.slice())
      expect(chars[0]).toBe(72)
    })

    it("should draw encoded characters from encodeUnicode", () => {
      const encoded = buffer.encodeUnicode("Hello")
      expect(encoded).not.toBeNull()

      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(0, 0, 0, 1)

      // Draw each character
      for (let i = 0; i < encoded!.data.length; i++) {
        buffer.drawChar(encoded!.data[i].char, i, 0, fg, bg)
      }

      // Verify buffer content
      const frameBytes = buffer.getRealCharBytes(false)
      const frameText = new TextDecoder().decode(frameBytes)
      expect(frameText).toContain("Hello")

      buffer.freeUnicode(encoded!)
    })

    it("should draw emoji using encoded char", () => {
      const encoded = buffer.encodeUnicode("👋")
      expect(encoded).not.toBeNull()

      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(0, 0, 0, 1)

      buffer.drawChar(encoded!.data[0].char, 0, 0, fg, bg)

      const frameBytes = buffer.getRealCharBytes(false)
      const frameText = new TextDecoder().decode(frameBytes)
      expect(frameText).toContain("👋")

      buffer.freeUnicode(encoded!)
    })
  })

  describe("snapshot tests with unicode encoding", () => {
    it("should render ASCII text correctly", () => {
      buffer.clear(RGBA.fromValues(0, 0, 0, 1))

      const encoded = buffer.encodeUnicode("Hello")
      expect(encoded).not.toBeNull()

      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(0, 0, 0, 1)

      let x = 0
      for (const encodedChar of encoded!.data) {
        buffer.drawChar(encodedChar.char, x, 0, fg, bg)
        x += encodedChar.width
      }

      const frameBytes = buffer.getRealCharBytes(true)
      const frameText = new TextDecoder().decode(frameBytes)
      expect(frameText).toMatchSnapshot("ASCII text rendering")

      buffer.freeUnicode(encoded!)
    })

    it("should render emoji text correctly", () => {
      buffer.clear(RGBA.fromValues(0, 0, 0, 1))

      const encoded = buffer.encodeUnicode("Hi 👋 🌍")
      expect(encoded).not.toBeNull()

      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(0, 0, 0, 1)

      let x = 0
      for (const encodedChar of encoded!.data) {
        buffer.drawChar(encodedChar.char, x, 0, fg, bg)
        x += encodedChar.width
      }

      const frameBytes = buffer.getRealCharBytes(true)
      const frameText = new TextDecoder().decode(frameBytes)
      expect(frameText).toMatchSnapshot("Emoji text rendering")

      buffer.freeUnicode(encoded!)
    })

    it("should handle multiline text with unicode", () => {
      buffer.clear(RGBA.fromValues(0, 0, 0, 1))

      const lines = ["Hi 世界", "🌟 Star"]
      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(0, 0, 0, 1)

      for (let y = 0; y < lines.length; y++) {
        const encoded = buffer.encodeUnicode(lines[y])
        expect(encoded).not.toBeNull()

        let x = 0
        for (const encodedChar of encoded!.data) {
          buffer.drawChar(encodedChar.char, x, y, fg, bg)
          x += encodedChar.width
        }

        buffer.freeUnicode(encoded!)
      }

      const frameBytes = buffer.getRealCharBytes(true)
      const frameText = new TextDecoder().decode(frameBytes)
      expect(frameText).toMatchSnapshot("Multiline unicode rendering")
    })

    it("should respect character widths in positioning", () => {
      const encoded = buffer.encodeUnicode("A👋B")
      expect(encoded).not.toBeNull()

      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(0, 0, 0, 1)

      // 'A' at x=0, emoji at x=1 (width 2), 'B' at x=3
      buffer.drawChar(encoded!.data[0].char, 0, 0, fg, bg) // 'A'
      buffer.drawChar(encoded!.data[1].char, 1, 0, fg, bg) // emoji
      buffer.drawChar(encoded!.data[2].char, 3, 0, fg, bg) // 'B'

      const frameBytes = buffer.getRealCharBytes(false)
      const frameText = new TextDecoder().decode(frameBytes)
      expect(frameText).toContain("A👋B")

      buffer.freeUnicode(encoded!)
    })
  })

  describe("drawChar with alpha blending", () => {
    it("should blend semi-transparent foreground", () => {
      const fg = RGBA.fromValues(1, 0, 0, 0.5)
      const bg = RGBA.fromValues(0, 0, 0, 1)

      buffer.drawChar(65, 0, 0, fg, bg) // 'A'

      const fgBuffer = buffer.withBuffers((cells) => cells.fg.slice())
      // Foreground alpha is flattened against the final opaque cell background.
      expect(fgBuffer[0] & 0xff).toBe(128)
      expect(fgBuffer[3] & 0xff).toBe(255)
    })

    it("should blend semi-transparent background", () => {
      buffer.setRespectAlpha(true)

      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(1, 0, 0, 0.5)

      buffer.drawChar(65, 0, 0, fg, bg) // 'A'

      const bgBuffer = buffer.withBuffers((cells) => cells.bg.slice())
      // Background should reflect the alpha
      expect(bgBuffer[3] & 0xff).toBeLessThan(255)
    })
  })

  describe("grapheme pool churn across drawFrameBuffer", () => {
    it("should not crash with WrongGeneration after many grapheme alloc cycles", () => {
      const parent = OptimizedBuffer.create(40, 5, "unicode", { owner: resourceContext, id: "parent" })
      const child = OptimizedBuffer.create(40, 5, "unicode", {
        owner: resourceContext,
        id: "child",
        respectAlpha: true,
      })

      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(0, 0, 0, 1)

      for (let cycle = 0; cycle < 50; cycle++) {
        parent.clear(bg)

        if (cycle % 2 === 0) {
          child.drawText("╭────────────────────────────────────╮", 0, 0, fg, bg)
          child.drawText("│ ◇ Select Files ▫ src/ ▪ file.ts   │", 0, 1, fg, bg)
          child.drawText("│ ↑↓ navigate  ⏎ select  esc close  │", 0, 2, fg, bg)
          child.drawText("╰────────────────────────────────────╯", 0, 3, fg, bg)
        } else {
          child.drawText("  Your Name                              ", 0, 0, fg, bg)
          child.drawText("  John Doe                               ", 0, 1, fg, bg)
          child.drawText("                                         ", 0, 2, fg, bg)
          child.drawText("  Select Files                           ", 0, 3, fg, bg)
        }

        parent.drawFrameBuffer(0, 0, child)

        const frameBytes = parent.getRealCharBytes(true)
        const text = new TextDecoder().decode(frameBytes)
        expect(text.length).toBeGreaterThan(0)
      }

      child.destroy()
      parent.destroy()
    })
  })

  describe("draw text encoding", () => {
    const white = RGBA.fromInts(255, 255, 255)
    const black = RGBA.fromInts(0, 0, 0)
    const rows = (target: OptimizedBuffer) =>
      new TextDecoder()
        .decode(target.getRealCharBytes(true))
        .split("\n")
        .map((row) => row.trimEnd())

    it("draws non-string text as TextEncoder converts it, skips controls, and enforces the byte limit", () => {
      buffer.clear(black)
      buffer.drawText(123 as never, 0, 0, white)
      buffer.drawText(["a", "b"] as never, 0, 1, white)
      buffer.drawText(undefined as never, 0, 2, white)
      buffer.drawText(null as never, 0, 3, white)
      // Controls take no cells. A tab and a grapheme too long for a cell draw as spaces of their width.
      buffer.drawText("a\r\nb\x1b\x7f\u0085c\td" + "e" + "\u0301".repeat(64) + "f", 0, 4, white)
      expect(rows(buffer).slice(0, 5)).toEqual(["123", "a,b", "", "null", "abc  d f"])
      expect(() => buffer.drawText("a".repeat(65_537), 0, 0, white)).toThrow(
        "Buffer text exceeds the native byte limit",
      )
      buffer.drawText("a".repeat(65_536), 0, 0, white)
    })

    it("draws only the latest text after longer and multi-byte text", () => {
      buffer.clear(black)
      buffer.drawText("é漢😀 wide", 0, 0, white)
      buffer.drawText("x".repeat(5000), 0, 1, white)
      buffer.drawText("ok", 0, 1, white)
      buffer.drawText("é漢😀", 0, 2, white)
      buffer.drawText("ab", 0, 2, white)
      expect(rows(buffer).slice(0, 3)).toEqual(["é漢😀 wide", "ok" + "x".repeat(18), "ab 😀"])
    })

    it("draws all of a multi-byte text whose UTF-8 is longer than its UTF-16 length", () => {
      const owner = new ResourceContext({ objectCapacity: 4, renderCellsMax: 3000 })
      const wide = OptimizedBuffer.create(3000, 1, "unicode", { owner, id: "wide-buffer" })
      try {
        const text = "漢".repeat(1400)
        wide.drawText(text, 0, 0, white)
        expect(rows(wide)[0]).toBe(text)
      } finally {
        wide.destroy()
        owner.destroy()
      }
    })
  })
})
