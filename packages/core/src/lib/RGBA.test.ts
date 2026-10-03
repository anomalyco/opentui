import { describe, expect, test } from "bun:test"
import { RGBA, ansi256IndexToRgb, hexToRgb, normalizeColorValue, parseColor, rgbToHex } from "./RGBA.js"

describe("RGBA", () => {
  test("uses packed Uint16 transport", () => {
    const color = RGBA.fromValues(1, 0, 0, 0.5)
    expect(color.buffer).toBeInstanceOf(Uint16Array)
    expect(color.buffer).toHaveLength(4)
    expect(color.toInts()).toEqual([255, 0, 0, 128])
    expect(color.intent).toBe("rgb")
  })

  test("copies constructor input", () => {
    const input = new Uint16Array([1, 2, 3, 4])
    const color = new RGBA(input)
    input[0] = 255
    expect(color.buffer[0]).toBe(1)
  })

  test("preserves metadata when mutating channels", () => {
    const color = RGBA.fromIndex(6)
    color.r = 1
    expect(color.intent).toBe("indexed")
    expect(color.slot).toBe(6)
    expect(color.toInts()[0]).toBe(255)
  })

  test("constructs indexed and default colors", () => {
    const indexed = RGBA.fromIndex(12, "#112233")
    const defaultFg = RGBA.defaultForeground("#abcdef")

    expect(indexed.intent).toBe("indexed")
    expect(indexed.slot).toBe(12)
    expect(indexed.toInts()).toEqual([0x11, 0x22, 0x33, 255])
    expect(defaultFg.intent).toBe("default")
    expect(defaultFg.toInts()).toEqual([0xab, 0xcd, 0xef, 255])
  })

  test("converts ANSI 256 indexes", () => {
    expect(ansi256IndexToRgb(9)).toEqual([255, 0, 0])
    expect(ansi256IndexToRgb(21)).toEqual([0, 0, 255])
    expect(ansi256IndexToRgb(232)).toEqual([8, 8, 8])
  })

  test("parses and formats colors", () => {
    expect(hexToRgb("#F808").toInts()).toEqual([255, 136, 0, 136])
    expect(parseColor("transparent").toInts()).toEqual([0, 0, 0, 0])
    expect(rgbToHex(RGBA.fromInts(255, 128, 64, 128))).toBe("#ff804080")
  })

  test("normalizes ColorInput values", () => {
    expect(normalizeColorValue(null)).toBeNull()
    expect(normalizeColorValue("#123456")?.rgba.toInts()).toEqual([0x12, 0x34, 0x56, 255])
  })

  test("compares packed values exactly", () => {
    expect(RGBA.fromIndex(4, "#0000ff").equals(RGBA.fromInts(0, 0, 255))).toBe(false)
    expect(RGBA.clone(RGBA.fromIndex(4)).equals(RGBA.fromIndex(4))).toBe(true)
  })
})
