import { ResourceContext } from "./buffer.js"
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { OptimizedBuffer, type BufferAccess } from "./buffer.js"
import { RGBA } from "./lib/RGBA.js"
import { NativeImage } from "./image.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 16, renderCellsMax: 256 })
})
afterEach(() => resourceContext.destroy())

for (const scenario of ["before", "after", "rejected"]) {
  it(`preserves native resize outcomes when FFI file logging fails: ${scenario}`, () => {
    const dir = mkdtempSync(join(process.env.OTUI_TEXT_BUFFER_TEST_TMPDIR ?? tmpdir(), "opentui-ffi-log-"))
    try {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
      const runtimeArgs = "bun" in process.versions ? [] : process.execArgv.filter((arg) => !arg.startsWith("--test"))
      const child = spawnSync(
        process.execPath,
        [
          ...runtimeArgs,
          fileURLToPath(new URL(`tests/buffer-resize-logging-child.${extension}`, import.meta.url)),
          scenario,
          dir,
        ],
        { encoding: "utf8", timeout: 30_000, env: { ...process.env, OTUI_DEBUG_FFI: "1", OTUI_TRACE_FFI: "1" } },
      )
      expect({ status: child.status, signal: child.signal, stderr: child.stderr, error: child.error?.message }).toEqual(
        {
          status: 0,
          signal: null,
          stderr: "",
          error: undefined,
        },
      )
      expect(child.stdout).toMatch(/^ot_buffer_resize\s+\|\s+4\s+\|/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

describe("OptimizedBuffer", () => {
  let buffer: OptimizedBuffer

  beforeEach(() => {
    buffer = OptimizedBuffer.create(20, 5, "unicode", { owner: resourceContext, id: "test-buffer" })
  })

  afterEach(() => {
    buffer.destroy()
  })

  it("scopes resized native geometry and immediate cell writes", () => {
    const initial = buffer.withBuffers((cells) => cells.generation)
    buffer.resize(3, 2)
    expect([buffer.width, buffer.height]).toEqual([3, 2])

    const generation = buffer.withBuffers((cells) => {
      expect([cells.width, cells.height, cells.char.length, cells.fg.length]).toEqual([3, 2, 6, 24])
      expect(cells.bg.length).toBe(24)
      expect(cells.attributes.length).toBe(6)
      cells.char[5] = 88
      cells.attributes[5] = 0x8000_00ff
      return cells.generation
    })

    expect(generation > initial).toBe(true)
    expect(new TextDecoder().decode(buffer.getRealCharBytes())).toContain("X")
    buffer.withBuffers((cells) => expect(cells.attributes[5]).toBe(0x8000_00ff))
  })

  it.each(["resize", "destroy"] as const)("retains storage through scoped %s and reports invalidation", (operation) => {
    let entered = false
    let retained = 0
    expect(() =>
      buffer.withBuffers((cells) => {
        entered = true
        cells.char[0] = 65
        const chars = cells.char
        if (operation === "resize") buffer.resize(3, 2)
        else buffer.destroy()
        retained = chars[0]
      }),
    ).toThrow()
    expect(entered).toBe(true)
    expect(retained).toBe(65)
    if (operation === "resize") {
      buffer.withBuffers((cells) => expect([cells.width, cells.height]).toEqual([3, 2]))
    }
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

  it("keeps nested scopes independent and rejects asynchronous callback results", async () => {
    let outer: BufferAccess | undefined
    let inner: BufferAccess | undefined
    buffer.withBuffers((first) => {
      outer = first
      buffer.withBuffers((second) => {
        inner = second
        expect(second.generation).toBe(first.generation)
        second.char[0] = 66
      })
      expect(() => inner!.char).toThrow("scope has ended")
      expect(first.char[0]).toBe(66)
    })
    expect(() => outer!.char).toThrow("scope has ended")
    expect(() => buffer.withBuffers(() => Promise.resolve())).toThrow("must be synchronous")
    expect(() => buffer.withBuffers(() => Promise.reject(new Error("async rejection")))).toThrow("must be synchronous")
    await Promise.resolve()
    buffer.withBuffers((cells) => expect(cells.char[0]).toBe(66))
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

  it("preserves literal attributes and rejects foreign pooled IDs across per-cell calls", () => {
    const fg = RGBA.fromInts(255, 255, 255)
    const bg = RGBA.fromInts(0, 0, 0)
    const attributes = [0xff, 0xfe, 0xfd]

    buffer.setCell(0, 0, "S", fg, bg, attributes[0])
    buffer.setCellWithAlphaBlending(1, 0, "A", fg, bg, attributes[1])
    buffer.drawChar("D".codePointAt(0)!, 2, 0, fg, bg, attributes[2])

    expect(() => buffer.setCell(0, 0, "X", fg, bg, 0x8000_00ff)).toThrow("InvalidArgument")
    buffer.withBuffers((cells) => expect([...cells.attributes.slice(0, attributes.length)]).toEqual(attributes))
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

  it("releases drawn images when cleared", () => {
    const image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
    let raw: ReturnType<NativeImage["takeRaw"]> | undefined
    try {
      expect(buffer.drawImage(image, 0, 0, 1, 1)).toBe(true)
      buffer.clear()
      raw = image.takeRaw()
      expect([...raw.data]).toEqual([1, 2, 3, 255])
    } finally {
      raw?.dispose()
      image.dispose()
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
})
