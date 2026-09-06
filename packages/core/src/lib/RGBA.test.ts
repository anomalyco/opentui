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

  test("allocates one independent buffer per packed factory result", () => {
    const snapshot = RGBA.fromInts(17, 34, 51, 68)
    const originalUint16Array = globalThis.Uint16Array
    let allocations = 0
    let colors: RGBA[]
    try {
      globalThis.Uint16Array = new Proxy(originalUint16Array, {
        construct(target, args, newTarget) {
          allocations++
          return Reflect.construct(target, args, newTarget)
        },
      })
      colors = [
        RGBA.fromValues(-0.5, 0.5, Infinity, 1.5),
        RGBA.fromInts(-1, 127.5, NaN, 256),
        RGBA.fromIndex(12, snapshot),
        RGBA.defaultForeground(snapshot),
        RGBA.defaultBackground(snapshot),
      ]
    } finally {
      globalThis.Uint16Array = originalUint16Array
    }

    expect(allocations).toBe(colors.length)
    expect(new Set(colors.map((color) => color.buffer.buffer)).size).toBe(colors.length)
    snapshot.buffer.fill(0xffff)
    expect(colors.map((color) => [...color.toInts(), color.intent, color.slot])).toEqual([
      [0, 128, 0, 255, "rgb", 0],
      [0, 128, 0, 255, "rgb", 0],
      [17, 34, 51, 68, "indexed", 12],
      [17, 34, 51, 68, "default", 0],
      [17, 34, 51, 68, "default", 0],
    ])
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
