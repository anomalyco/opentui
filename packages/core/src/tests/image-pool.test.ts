import { describe, expect, test } from "bun:test"
import { OptimizedBuffer } from "../buffer.js"
import { ImageError, NativeImage, NativeImagePool, type PixelImportOptions } from "../image.js"
import { resolveRenderLib } from "../zig.js"

describe("NativeImagePool", () => {
  test("publishes shared pixel views through busy and reused slots", () => {
    const pixels = new Uint8Array(new SharedArrayBuffer(5), 1)
    pixels.set([3, 2, 1, 128])
    const pool = new NativeImagePool({ width: 1, height: 1, capacity: 1 })
    let frame = pool.publishPixels(pixels, { format: "bgra8" })!
    try {
      pixels.set([6, 5, 4, 255])
      expect(pool.publishPixels(pixels, { format: "bgra8" })).toBeNull()
      expect(frame.raw().data).toEqual(Uint8Array.of(1, 2, 3, 128))
      frame.dispose()
      frame = pool.publishPixels(pixels, { format: "bgra8" })!
      expect(frame.raw().data).toEqual(Uint8Array.of(4, 5, 6, 255))
    } finally {
      frame.dispose()
      pool.dispose()
    }
  })

  test.each([
    ["rgba8", "straight", 64, 64, 256],
    ["bgra8", "straight", 65, 3, 267],
    ["bgra8", "opaque", 65, 3, 267],
  ] as const)(
    "publishes %s with %s alpha at %dx%d, stride %d, and immutable readers",
    (format, alpha, width, height, stride) => {
      const offset = format === "bgra8" ? 1 : 0
      const pixels = new Uint8Array(stride * (height - 1) + width * 4 + offset).subarray(offset)
      const expected = new Uint8Array(width * height * 4)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          pixels.set([x, y, 99, 255], y * stride + x * 4)
          expected.set(format === "bgra8" ? [99, y, x, 255] : [x, y, 99, 255], (y * width + x) * 4)
        }
      }
      pixels[pixels.length - 1] = 128
      expected[expected.length - 1] = alpha === "opaque" ? 255 : 128
      const options: PixelImportOptions = { stride, format, alpha, colorSpace: "srgb" }
      const pool = new NativeImagePool({ width, height, capacity: 2 })
      const publish = () => (format === "rgba8" ? pool.publishRgba(pixels) : pool.publishPixels(pixels, options))
      const first = publish()!
      const retained = first.retain()
      first.dispose()
      const lib = resolveRenderLib()
      try {
        expect(retained.raw().data).toEqual(expected)
        expect(retained.info().hasAlpha).toBe(alpha === "straight")
        pixels.fill(42, 0, 3)
        const second = publish()!
        const allocated = lib.getAllocatorStats().activeAllocations
        try {
          expect(publish()).toBeNull()
          expect(lib.getAllocatorStats().activeAllocations).toBe(allocated)
          expect(second.raw().data.subarray(0, 3)).toEqual(Uint8Array.of(42, 42, 42))
          expect(retained.raw().data).toEqual(expected)
        } finally {
          second.dispose()
        }
        for (let index = 0; index < 3; index++) {
          const rgb = [index, 255 - index, index + 1]
          pixels.set(rgb)
          pixels[pixels.length - 1] = index % 2 === 0 ? 255 : 0
          const frame = publish()!
          try {
            const raw = frame.raw().data
            expect([...raw.subarray(0, 3)]).toEqual(format === "bgra8" ? rgb.toReversed() : rgb)
            expect(frame.info().hasAlpha).toBe(alpha === "straight" && index % 2 !== 0)
            expect(raw.at(-1)).toBe(alpha === "opaque" ? 255 : pixels[pixels.length - 1])
            expect(lib.getAllocatorStats().activeAllocations).toBe(allocated)
            expect(retained.raw().data).toEqual(expected)
          } finally {
            frame.dispose()
          }
        }
        pixels.fill(0)
        expect(retained.raw().data).toEqual(expected)
      } finally {
        retained.dispose()
        pool.dispose()
      }
    },
  )

  test("publishPixels validates input before reporting a busy pool", () => {
    const pixels = Uint8Array.of(1, 2, 3, 255)
    const pool = new NativeImagePool({ width: 1, height: 1, capacity: 1 })
    const frame = pool.publishPixels(pixels)!
    try {
      for (const [options, error] of [
        [{ stride: 3 }, ImageError],
        [{ stride: NaN }, RangeError],
        [{ format: "argb8" }, TypeError],
        [{ format: "toString" }, TypeError],
        [{ alpha: "premultiplied" }, TypeError],
        [{ colorSpace: "display-p3" }, TypeError],
      ] as const) {
        expect(() => pool.publishPixels(pixels, options as PixelImportOptions)).toThrow(error)
      }
      expect(() => pool.publishPixels(new Uint8Array(3))).toThrow(ImageError)
      expect(() => pool.publishPixels([] as unknown as Uint8Array)).toThrow(TypeError)
      expect(pool.publishPixels(pixels)).toBeNull()
      expect(frame.raw().data).toEqual(pixels)
    } finally {
      frame.dispose()
      pool.dispose()
    }
    expect(() => pool.publishPixels(pixels)).toThrow("disposed")
  })

  test("failed publications can retry without leaking native images", () => {
    const lib = resolveRenderLib()
    const pixels = Uint8Array.of(1, 2, 3, 255)
    NativeImage.fromRgba(pixels, 1, 1).dispose()
    const allocated = lib.getAllocatorStats().activeAllocations
    const retain = lib.imageRetain
    const pool = new NativeImagePool({ width: 1, height: 1, capacity: 1 })
    let frame: NativeImage | null = null
    try {
      lib.imageRetain = () => ({ status: 8, handle: null })
      expect(() => pool.publishRgba(pixels)).toThrow(ImageError)
      lib.imageRetain = retain
      frame = pool.publishRgba(pixels)
      expect(frame!.raw().data).toEqual(pixels)
    } finally {
      lib.imageRetain = retain
      frame?.dispose()
      pool.dispose()
    }
    expect(lib.getAllocatorStats().activeAllocations).toBe(allocated)
  })

  test("drawImage and copied buffers pin snapshots until both are cleared", () => {
    const pool = new NativeImagePool({ width: 1, height: 1, capacity: 1 })
    const source = OptimizedBuffer.create(1, 1, "unicode")
    const snapshot = OptimizedBuffer.create(1, 1, "unicode")
    const red = Uint8Array.of(255, 0, 0, 255)
    const blue = Uint8Array.of(0, 0, 255, 255)
    const frame = pool.publishRgba(red)!
    try {
      expect(source.drawImage(frame, 0, 0, 1, 1)).toBe(true)
      frame.dispose()
      snapshot.drawFrameBuffer(0, 0, source)
      source.clear()
      expect(pool.publishRgba(blue)).toBeNull()
      snapshot.clear()
      const next = pool.publishRgba(blue)!
      expect(next.raw().data).toEqual(blue)
      next.dispose()
    } finally {
      frame.dispose()
      source.destroy()
      snapshot.destroy()
      pool.dispose()
    }
  })

  test("copies strided views, refreshes alpha metadata, and rejects invalid input without consuming a slot", () => {
    const pool = new NativeImagePool({ width: 1, height: 2, capacity: 1 })
    const pixels = Uint8Array.of(99, 1, 2, 3, 255, 77, 77, 77, 77, 4, 5, 6, 255, 99).subarray(1, 13)
    try {
      expect(() => pool.publishRgba(pixels, 3)).toThrow(ImageError)
      expect(() => pool.publishRgba(pixels.subarray(0, 11), 8)).toThrow(ImageError)
      const frame = pool.publishRgba(pixels, 8)!
      try {
        expect(frame.raw().data).toEqual(Uint8Array.of(1, 2, 3, 255, 4, 5, 6, 255))
        expect(frame.info().hasAlpha).toBe(false)
        expect(() => pool.publishRgba(new Uint8Array(0))).toThrow(ImageError)
      } finally {
        frame.dispose()
      }
      pixels[3] = 0
      const next = pool.publishRgba(pixels, 8)!
      pixels.fill(0)
      expect(next.raw().data).toEqual(Uint8Array.of(1, 2, 3, 0, 4, 5, 6, 255))
      expect(next.info().hasAlpha).toBe(true)
      next.dispose()
    } finally {
      pool.dispose()
    }
  })

  test("dispose cancels future publications but leaves outstanding frames alive", () => {
    const pool = new NativeImagePool({ width: 1, height: 1 })
    const frame = pool.publishRgba(Uint8Array.of(1, 2, 3, 255))!
    pool.dispose()
    pool.dispose()
    try {
      expect(() => pool.publishRgba(Uint8Array.of(4, 5, 6, 255))).toThrow("disposed")
      expect(frame.raw().data).toEqual(Uint8Array.of(1, 2, 3, 255))
      const raw = frame.takeRaw()
      raw.dispose()
    } finally {
      frame.dispose()
    }
  })

  test("validates pool bounds and native limits", () => {
    for (const capacity of [0, -1, 1.5, 9, NaN, Infinity]) {
      expect(() => new NativeImagePool({ width: 1, height: 1, capacity })).toThrow(RangeError)
    }
    for (const width of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => new NativeImagePool({ width, height: 1 })).toThrow(RangeError)
    }
    const pool = new NativeImagePool({ width: 16_385, height: 1 })
    try {
      expect(() => pool.publishRgba(new Uint8Array(16_385 * 4))).toThrow(ImageError)
      expect(() => pool.publishRgba([] as unknown as Uint8Array)).toThrow(TypeError)
      expect(() => pool.publishRgba(new Uint8Array(0), NaN)).toThrow(RangeError)
    } finally {
      pool.dispose()
    }
  })
})
