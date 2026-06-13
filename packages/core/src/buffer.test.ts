import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { OptimizedBuffer } from "./buffer.js"
import { RGBA } from "./lib/RGBA.js"

describe("OptimizedBuffer", () => {
  let buffer: OptimizedBuffer

  beforeEach(() => {
    buffer = OptimizedBuffer.create(20, 5, "unicode", { id: "test-buffer" })
  })

  afterEach(() => {
    buffer.destroy()
  })

  describe("encodeUnicode", () => {
    it("should encode simple ASCII text", () => {
      const encoded = buffer.encodeUnicode("Hello")
      expect(encoded).not.toBeNull()
      expect(encoded!.data.length).toBe(5)
      expect(encoded!.data[0]).toEqual({ width: 1, char: 72 }) // 'H'
      expect(encoded!.data[1]).toEqual({ width: 1, char: 101 }) // 'e'
      expect(encoded!.data[2]).toEqual({ width: 1, char: 108 }) // 'l'
      expect(encoded!.data[3]).toEqual({ width: 1, char: 108 }) // 'l'
      expect(encoded!.data[4]).toEqual({ width: 1, char: 111 }) // 'o'

      buffer.freeUnicode(encoded!)
    })

    it("should encode emoji with correct width", () => {
      const encoded = buffer.encodeUnicode("👋")
      expect(encoded).not.toBeNull()
      expect(encoded!.data.length).toBe(1)
      expect(encoded!.data[0].width).toBe(2)
      // Should be a packed grapheme (has high bit set)
      expect(encoded!.data[0].char).toBeGreaterThan(0x80000000)

      buffer.freeUnicode(encoded!)
    })

    it("should encode mixed ASCII and emoji", () => {
      const encoded = buffer.encodeUnicode("Hi 👋 World")
      expect(encoded).not.toBeNull()
      expect(encoded!.data.length).toBe(10) // H, i, space, emoji, space, W, o, r, l, d

      // Check ASCII chars
      expect(encoded!.data[0].width).toBe(1)
      expect(encoded!.data[0].char).toBe(72) // 'H'

      // Check emoji
      expect(encoded!.data[3].width).toBe(2)
      expect(encoded!.data[3].char).toBeGreaterThan(0x80000000)

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

      const chars = buffer.buffers.char
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

      const fgBuffer = buffer.buffers.fg
      // Foreground alpha is flattened against the final opaque cell background.
      expect(fgBuffer[0] & 0xff).toBe(128)
      expect(fgBuffer[3] & 0xff).toBe(255)
    })

    it("should blend semi-transparent background", () => {
      buffer.setRespectAlpha(true)

      const fg = RGBA.fromValues(1, 1, 1, 1)
      const bg = RGBA.fromValues(1, 0, 0, 0.5)

      buffer.drawChar(65, 0, 0, fg, bg) // 'A'

      const bgBuffer = buffer.buffers.bg
      // Background should reflect the alpha
      expect(bgBuffer[3] & 0xff).toBeLessThan(255)
    })
  })

  describe("grapheme pool churn across drawFrameBuffer", () => {
    it("should not crash with WrongGeneration after many grapheme alloc cycles", () => {
      const parent = OptimizedBuffer.create(40, 5, "unicode", { id: "parent" })
      const child = OptimizedBuffer.create(40, 5, "unicode", { id: "child", respectAlpha: true })

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
})
