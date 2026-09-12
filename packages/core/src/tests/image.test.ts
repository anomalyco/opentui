import { createServer } from "node:http"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, open, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync, inflateSync } from "node:zlib"

import { describe, expect, test } from "bun:test"
import { ImageError, ImageLoadError, NativeImage, imageInfo, type ImageErrorCode } from "../image.js"
import { toArrayBuffer } from "../platform/ffi.js"
import { resolveRenderLib } from "../zig.js"

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
    "base64",
  ),
)

const ANIMATED_WEBP = Uint8Array.from(
  Buffer.from(
    "UklGRoYAAABXRUJQVlA4WAoAAAASAAAAAQAAAQAAQU5JTQYAAAD/////AABBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAAJWUDhMDwAAAC8BQAAABxD9j/4HIqL/AQBBTk1GKgAAAAAAAAAAAAEAAAEAAGQAAAJWUDhMEQAAAC8BQAAQDxDzH/MfjBWI6H8IAA==",
    "base64",
  ),
)

const FIXTURES = new URL("./fixtures/images/", import.meta.url)

async function readBase64Fixture(name: string): Promise<Uint8Array> {
  return Uint8Array.from(
    Buffer.from(
      (await readFile(new URL(`../../../native/src/tests/fixtures/${name}`, import.meta.url), "utf8")).trim(),
      "base64",
    ),
  )
}

function injectJpegExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  // Little-endian TIFF with a single IFD0 entry: tag 0x0112 (Orientation),
  // type SHORT, count 1.
  const tiff = Uint8Array.from([
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation & 0xff,
    (orientation >> 8) & 0xff,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ])
  const identifier = Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00])
  const segmentLength = 2 + identifier.length + tiff.length
  const segment = new Uint8Array(2 + segmentLength)
  segment[0] = 0xff
  segment[1] = 0xe1
  segment[2] = (segmentLength >> 8) & 0xff
  segment[3] = segmentLength & 0xff
  segment.set(identifier, 4)
  segment.set(tiff, 4 + identifier.length)

  const result = new Uint8Array(jpeg.length + segment.length)
  result.set(jpeg.slice(0, 2), 0)
  result.set(segment, 2)
  result.set(jpeg.slice(2), 2 + segment.length)
  return result
}

function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function injectPngChunk(png: Uint8Array, type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const chunk = new Uint8Array(payload.length + 12)
  const chunkView = new DataView(chunk.buffer)
  chunkView.setUint32(0, payload.length)
  chunk.set(typeBytes, 4)
  chunk.set(payload, 8)
  chunkView.setUint32(8 + payload.length, pngCrc(chunk.subarray(4, 8 + payload.length)))

  let offset = 8
  while (new TextDecoder().decode(png.subarray(offset + 4, offset + 8)) !== "IDAT") {
    offset += new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0) + 12
  }
  const result = new Uint8Array(png.length + chunk.length)
  result.set(png.subarray(0, offset))
  result.set(chunk, offset)
  result.set(png.subarray(offset), offset + chunk.length)
  return result
}

function pngChunkPayload(png: Uint8Array, wantedType: string): Uint8Array {
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0)
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8))
    if (type === wantedType) return png.subarray(offset + 8, offset + 8 + length)
    offset += length + 12
  }
  throw new Error(`fixture has no ${wantedType} chunk`)
}

function withoutPngChunk(png: Uint8Array, removedType: string): Uint8Array {
  const parts: Uint8Array[] = [png.subarray(0, 8)]
  let total = 8
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0)
    const end = offset + length + 12
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8))
    if (type !== removedType) {
      parts.push(png.subarray(offset, end))
      total += end - offset
    }
    offset = end
    if (type === "IEND") break
  }
  const result = new Uint8Array(total)
  let destination = 0
  for (const part of parts) {
    result.set(part, destination)
    destination += part.length
  }
  return result
}

function withIccProfile(png: Uint8Array, profile: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode("OpenTUI test")
  const compressed = deflateSync(profile)
  const payload = new Uint8Array(name.length + compressed.length + 2)
  payload.set(name)
  payload[name.length + 1] = 0
  payload.set(compressed, name.length + 2)
  return injectPngChunk(withoutPngChunk(png, "iCCP"), "iCCP", payload)
}

function expectImageErrorCode(operation: () => unknown, code: ImageErrorCode): void {
  try {
    operation()
    throw new Error("expected image operation to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(ImageError)
    expect((error as ImageError).code).toBe(code)
  }
}

function withPngDimensions(png: Uint8Array, width: number, height: number): Uint8Array {
  const result = png.slice()
  const view = new DataView(result.buffer, result.byteOffset)
  view.setUint32(16, width)
  view.setUint32(20, height)
  view.setUint32(29, pngCrc(result.subarray(12, 29)))
  return result
}

function corruptFirstPngIdat(png: Uint8Array): Uint8Array {
  const result = png.slice()
  let offset = 8
  while (offset + 12 <= result.length) {
    const length = new DataView(result.buffer, result.byteOffset + offset, 4).getUint32(0)
    const type = new TextDecoder().decode(result.subarray(offset + 4, offset + 8))
    if (type === "IDAT") {
      result[offset + 8] ^= 0xff
      new DataView(result.buffer).setUint32(
        offset + 8 + length,
        pngCrc(result.subarray(offset + 4, offset + 8 + length)),
      )
      return result
    }
    offset += length + 12
  }
  throw new Error("fixture has no IDAT chunk")
}

const FORMATS = [
  ["rgba.png", "png", false],
  ["baseline.jpg", "jpeg", false],
  ["progressive.jpg", "jpeg", false],
  ["lossy.webp", "webp", false],
  ["lossless.webp", "webp", false],
  ["alpha.webp", "webp", true],
  ["first-frame.gif", "gif", false],
  ["transparent.gif", "gif", true],
] as const

describe("NativeImage", () => {
  test("inspects and decodes PNG data", () => {
    expect(imageInfo(PNG_1X1)).toMatchObject({ width: 1, height: 1, format: "png" })
    const image = NativeImage.decode(PNG_1X1)
    try {
      expect(image.width).toBe(1)
      expect(image.height).toBe(1)
      expect(image.raw().data).toHaveLength(4)
    } finally {
      image.dispose()
    }
  })

  test("reports transparency consistently for opaque RGBA PNG data", () => {
    const inspected = imageInfo(PNG_1X1)
    const image = NativeImage.decode(PNG_1X1)
    try {
      expect(inspected.hasAlpha).toBe(false)
      expect(image.info().hasAlpha).toBe(false)
    } finally {
      image.dispose()
    }
  })

  test("rejects malformed PNG data", () => {
    const corrupt = PNG_1X1.slice()
    corrupt[29] ^= 1
    expect(() => imageInfo(corrupt)).toThrow("malformed image data")
  })

  test("applies the documented PNG color-space policy", async () => {
    const explicitSrgb = await readFile(new URL("rgba.png", FIXTURES))
    expect(imageInfo(explicitSrgb).colorStatus).toBe("explicit-srgb")

    const iccp = injectPngChunk(PNG_1X1, "iCCP", Uint8Array.of(0))
    expectImageErrorCode(() => imageInfo(iccp), "malformed-data")

    const badGamma = injectPngChunk(PNG_1X1, "gAMA", Uint8Array.of(0, 0, 0, 1))
    expect(() => imageInfo(badGamma)).toThrow("unsupported image color space")

    const badChromaticities = injectPngChunk(PNG_1X1, "cHRM", new Uint8Array(32))
    expect(() => imageInfo(badChromaticities)).toThrow("unsupported image color space")

    const unsupportedCicp = injectPngChunk(PNG_1X1, "cICP", Uint8Array.of(9, 9, 9, 9))
    expect(imageInfo(unsupportedCicp).colorStatus).toBe("assumed-srgb")

    const supportedCicp = injectPngChunk(iccp, "cICP", Uint8Array.of(1, 13, 0, 1))
    expect(imageInfo(supportedCicp).colorStatus).toBe("explicit-srgb")
  })

  test("converts an embedded RGB monitor profile to straight-alpha sRGB", async () => {
    const png = await readBase64Fixture("display-p3.png.base64")
    expect(imageInfo(png)).toMatchObject({ format: "png", colorStatus: "explicit-srgb", hasAlpha: false })

    const image = NativeImage.decode(png)
    try {
      // Generated from a synthetic Display-P3 matrix/TRC profile. Golden values
      // were produced by ImageMagick 7.1.2 with LittleCMS and relative intent.
      expect(image.raw().data).toEqual(Uint8Array.of(220, 0, 19, 255, 0, 205, 0, 255, 95, 122, 143, 255))
    } finally {
      image.dispose()
    }
  })

  test("reports ICC profile-copy allocation failure as out of memory", () => {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
    const runtimeArgs = "bun" in process.versions ? [] : process.execArgv.filter((arg) => !arg.startsWith("--test"))
    const child = spawnSync(
      process.execPath,
      [...runtimeArgs, fileURLToPath(new URL(`image-icc-allocation-child.${extension}`, import.meta.url))],
      { encoding: "utf8" },
    )
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || `child exited with status ${child.status}`)
  })

  test("converts ICC palette and RGBA PNGs and preserves alpha", async () => {
    const cases = [
      ["display-p3-palette.png.base64", Uint8Array.of(220, 0, 19, 255, 0, 205, 0, 255, 95, 122, 143, 255)],
      ["display-p3-palette-alpha.png.base64", Uint8Array.of(220, 0, 19, 1, 0, 205, 0, 127, 95, 122, 143, 255)],
      ["display-p3-rgba.png.base64", Uint8Array.of(220, 0, 19, 1, 0, 205, 0, 127, 95, 122, 143, 255)],
    ] as const
    for (const [fixture, expected] of cases) {
      const image = NativeImage.decode(await readBase64Fixture(fixture))
      try {
        expect(image.info().colorStatus).toBe("explicit-srgb")
        expect(image.raw().data).toEqual(expected)
      } finally {
        image.dispose()
      }
    }
  })

  test("accepts an ICC profile equivalent to sRGB without changing pixels", async () => {
    const image = NativeImage.decode(await readBase64Fixture("srgb-profile.png.base64"))
    try {
      expect(image.raw().data).toEqual(Uint8Array.of(10, 20, 30, 255))
    } finally {
      image.dispose()
    }
  })

  test("converts an embedded grayscale monitor profile to sRGB", async () => {
    const cases = [
      ["gray-profile.png.base64", Uint8Array.of(99, 99, 99, 255, 193, 193, 193, 255)],
      ["gray-alpha-profile.png.base64", Uint8Array.of(99, 99, 99, 1, 193, 193, 193, 127)],
    ] as const
    for (const [fixture, expected] of cases) {
      const image = NativeImage.decode(await readBase64Fixture(fixture))
      try {
        expect(image.raw().data).toEqual(expected)
      } finally {
        image.dispose()
      }
    }
  })

  test("classifies malformed, unsupported, duplicate, and oversized ICC profiles", async () => {
    const png = await readBase64Fixture("display-p3.png.base64")
    const iccp = pngChunkPayload(png, "iCCP")
    const separator = iccp.indexOf(0)
    const profile = Uint8Array.from(inflateSync(iccp.subarray(separator + 2)))

    const invalidHeader = profile.slice()
    invalidHeader[36] = 0
    expectImageErrorCode(() => imageInfo(withIccProfile(png, invalidHeader)), "malformed-data")

    const unsupportedSpace = profile.slice()
    unsupportedSpace.set(new TextEncoder().encode("CMYK"), 16)
    expectImageErrorCode(() => imageInfo(withIccProfile(png, unsupportedSpace)), "unsupported-color-space")

    const unsupportedVersion = profile.slice()
    unsupportedVersion[8] = 5
    expectImageErrorCode(() => imageInfo(withIccProfile(png, unsupportedVersion)), "unsupported-feature")

    const unsupportedIntent = profile.slice()
    new DataView(unsupportedIntent.buffer).setUint32(64, 4)
    expectImageErrorCode(() => imageInfo(withIccProfile(png, unsupportedIntent)), "unsupported-feature")

    const tooManyTags = profile.slice()
    new DataView(tooManyTags.buffer).setUint32(128, 101)
    expectImageErrorCode(() => imageInfo(withIccProfile(png, tooManyTags)), "unsupported-feature")

    const overlappingTags = profile.slice()
    const overlappingView = new DataView(overlappingTags.buffer)
    overlappingView.setUint32(148, overlappingView.getUint32(136) + 4)
    expectImageErrorCode(() => imageInfo(withIccProfile(png, overlappingTags)), "malformed-data")

    const invalidName = iccp.slice()
    invalidName[0] = 0x20
    expectImageErrorCode(
      () => imageInfo(injectPngChunk(withoutPngChunk(png, "iCCP"), "iCCP", invalidName)),
      "malformed-data",
    )

    const invalidMethod = iccp.slice()
    invalidMethod[separator + 1] = 1
    expectImageErrorCode(
      () => imageInfo(injectPngChunk(withoutPngChunk(png, "iCCP"), "iCCP", invalidMethod)),
      "malformed-data",
    )

    const invalidCompressedProfile = iccp.slice()
    invalidCompressedProfile[invalidCompressedProfile.length - 1] ^= 0xff
    expectImageErrorCode(
      () => imageInfo(injectPngChunk(withoutPngChunk(png, "iCCP"), "iCCP", invalidCompressedProfile)),
      "malformed-data",
    )

    expectImageErrorCode(() => imageInfo(injectPngChunk(png, "iCCP", iccp)), "malformed-data")
    const palette = await readBase64Fixture("display-p3-palette.png.base64")
    expectImageErrorCode(
      () => imageInfo(injectPngChunk(withoutPngChunk(palette, "iCCP"), "iCCP", iccp)),
      "malformed-data",
    )
    const oversized = new Uint8Array(8_000_004)
    new DataView(oversized.buffer).setUint32(0, oversized.length)
    expectImageErrorCode(() => imageInfo(withIccProfile(png, oversized)), "memory-limit")
  })

  test("gives ICC precedence over lower-priority PNG color metadata", async () => {
    const png = await readBase64Fixture("display-p3.png.base64")
    const withSrgb = injectPngChunk(png, "sRGB", Uint8Array.of(0))
    const image = NativeImage.decode(withSrgb)
    try {
      expect(image.raw().data.subarray(0, 4)).toEqual(Uint8Array.of(220, 0, 19, 255))
    } finally {
      image.dispose()
    }
  })

  test("uses supported cICP before ICC and falls through unsupported cICP", async () => {
    const png = await readBase64Fixture("display-p3.png.base64")
    const cases = [
      [Uint8Array.of(1, 13, 0, 1), Uint8Array.of(200, 30, 40, 255)],
      [Uint8Array.of(9, 9, 9, 9), Uint8Array.of(220, 0, 19, 255)],
    ] as const
    for (const [cicp, expected] of cases) {
      const image = NativeImage.decode(injectPngChunk(png, "cICP", cicp))
      try {
        expect(image.raw().data.subarray(0, 4)).toEqual(expected)
      } finally {
        image.dispose()
      }
    }
  })

  test("enforces the documented decoded image dimensions", () => {
    for (const png of [withPngDimensions(PNG_1X1, 16_385, 1), withPngDimensions(PNG_1X1, 5_001, 5_000)]) {
      try {
        imageInfo(png)
        throw new Error("expected oversized PNG to be rejected")
      } catch (error) {
        expect(error).toBeInstanceOf(ImageError)
        expect((error as ImageError).code).toBe("dimension-limit")
      }
    }
  })

  test("rejects unsupported encoded formats", () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)
    for (const operation of [() => imageInfo(bytes), () => NativeImage.decode(bytes)]) {
      try {
        operation()
        throw new Error("expected image operation to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ImageError)
        expect((error as ImageError).code).toBe("unsupported-format")
      }
    }
  })

  test("inspects and decodes every required encoded format", async () => {
    for (const [name, format, hasAlpha] of FORMATS) {
      const bytes = await readFile(new URL(name, FIXTURES))
      const inspected = imageInfo(bytes)
      const image = NativeImage.decode(bytes)
      try {
        expect(inspected.format).toBe(format)
        expect(inspected.hasAlpha).toBe(hasAlpha)
        expect(image.info()).toEqual({ ...inspected, orientation: 1 })
        expect(image.raw().data).toHaveLength(image.width * image.height * 4)
      } finally {
        image.dispose()
      }
    }
  })

  test("rejects animated WebP", () => {
    for (const operation of [() => imageInfo(ANIMATED_WEBP), () => NativeImage.decode(ANIMATED_WEBP)]) {
      try {
        operation()
        throw new Error("expected animated WebP to be rejected")
      } catch (error) {
        expect(error).toBeInstanceOf(ImageError)
        expect((error as ImageError).code).toBe("unsupported-feature")
      }
    }
  })

  test("reports malformed data for every recognized format", async () => {
    for (const [name] of FORMATS) {
      const bytes = await readFile(new URL(name, FIXTURES))
      const truncated = bytes.subarray(0, Math.max(2, Math.floor(bytes.byteLength / 2)))
      expect(() => NativeImage.decode(truncated)).toThrow("malformed image data")
    }
  })

  test("rejects a GIF with a missing or invalid mandatory trailer", async () => {
    const gif = await readFile(new URL("first-frame.gif", FIXTURES))
    expect(gif.at(-1)).toBe(0x3b)
    const invalidTrailer = new Uint8Array(gif)
    invalidTrailer[invalidTrailer.length - 1] = 0

    for (const malformed of [gif.subarray(0, -1), invalidTrailer]) {
      for (const operation of [() => imageInfo(malformed), () => NativeImage.decode(malformed)]) {
        try {
          operation()
          throw new Error("expected image operation to fail")
        } catch (error) {
          expect(error).toBeInstanceOf(ImageError)
          expect((error as ImageError).code).toBe("malformed-data")
        }
      }
    }
  })

  test("keeps a transparent GIF logical-screen background transparent", async () => {
    const image = NativeImage.decode(await readFile(new URL("transparent.gif", FIXTURES)))
    try {
      expect([image.width, image.height]).toEqual([2, 2])
      expect(image.info().hasAlpha).toBe(true)
      expect([...image.raw().data]).toEqual([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 255])
    } finally {
      image.dispose()
    }
  })

  test("rejects unsupported pixel formats, resize kernels, and blend modes", () => {
    const image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
    const destination = new Uint8Array(4)
    const expectTypeError = (operation: () => unknown): void => {
      let result: unknown
      try {
        result = operation()
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError)
        return
      }
      if (result instanceof NativeImage) result.dispose()
      throw new Error("expected image operation to reject an unsupported option")
    }

    try {
      expectTypeError(() => image.raw("rgb8" as never))
      expectTypeError(() => image.copyTo(destination, { format: "rgb8" as never }))
      expectTypeError(() => image.resize({ width: 1, kernel: "lanczos3" as never }))
      expectTypeError(() => image.composite(image, { blend: "multiply" as never }))
    } finally {
      image.dispose()
    }
  })

  test("constructs and exports immutable RGBA images", () => {
    const source = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)
    const image = NativeImage.fromRgba(source, 2, 1)
    source.fill(0)
    try {
      expect([...image.raw().data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect([...image.raw("bgra8").data]).toEqual([3, 2, 1, 4, 7, 6, 5, 8])
    } finally {
      image.dispose()
    }
  })

  test("fromPixels imports strided subarrays in both formats and alpha modes", () => {
    const rgba = [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 7, 11, 23, 254]
    for (const format of ["rgba8", "bgra8"] as const) {
      for (const alpha of ["straight", "opaque"] as const) {
        const source = new Uint8Array(24).fill(99)
        for (let index = 0; index < 4; index++) {
          const src = index * 4
          const dst = 1 + Math.floor(index / 2) * 11 + (index % 2) * 4
          source.set(
            [
              rgba[src + (format === "bgra8" ? 2 : 0)],
              rgba[src + 1],
              rgba[src + (format === "bgra8" ? 0 : 2)],
              rgba[src + 3],
            ],
            dst,
          )
        }
        const before = source.slice()
        const image = NativeImage.fromPixels(source.subarray(1, 20), 2, 2, {
          format,
          stride: 11,
          alpha,
          colorSpace: "srgb",
        })
        try {
          expect(source).toEqual(before)
          source.fill(0)
          expect(image.raw()).toEqual({
            data: Uint8Array.from(rgba.map((value, index) => (alpha === "opaque" && index % 4 === 3 ? 255 : value))),
            width: 2,
            height: 2,
            stride: 8,
            format: "rgba8",
            colorSpace: "srgb",
            alpha: "straight",
          })
          expect(image.info()).toEqual({
            width: 2,
            height: 2,
            sourceWidth: 2,
            sourceHeight: 2,
            format: "raw-rgba",
            colorStatus: "explicit-srgb",
            orientation: 1,
            hasAlpha: alpha === "straight",
          })
        } finally {
          image.dispose()
        }
      }
    }
  })

  test("fromPixels defaults to straight RGBA and does not count padding as transparency", () => {
    const source = Uint8Array.of(1, 2, 3, 255, 0, 0, 0, 0, 4, 5, 6, 255, 0, 0, 0, 0)
    const image = NativeImage.fromPixels(source, 1, 2, { stride: 8 })
    try {
      expect(image.info().hasAlpha).toBe(false)
      expect([...image.raw().data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255])
    } finally {
      image.dispose()
    }
  })

  test("fromPixels owns pixels after the source buffer is detached", () => {
    const source = Uint8Array.of(3, 2, 1, 128)
    const image = NativeImage.fromPixels(source, 1, 1, { format: "bgra8" })
    structuredClone(source.buffer, { transfer: [source.buffer] })
    try {
      expect(source.byteLength).toBe(0)
      expect([...image.raw().data]).toEqual([1, 2, 3, 128])
    } finally {
      image.dispose()
    }
    expect(() => NativeImage.fromPixels(source, 1, 1)).toThrow()
  })

  test("fromPixels forces opaque alpha for later image operations", () => {
    const image = NativeImage.fromPixels(Uint8Array.of(0, 0, 255, 0), 1, 1, { format: "bgra8", alpha: "opaque" })
    const base = NativeImage.fromRgba(Uint8Array.of(0, 0, 255, 255), 1, 1)
    const composite = base.composite(image)
    try {
      expect([...composite.raw().data]).toEqual([255, 0, 0, 255])
    } finally {
      composite.dispose()
      base.dispose()
      image.dispose()
    }
  })

  test("fromPixels rejects invalid options, geometry, and short views", () => {
    const pixels = new Uint8Array(24)
    for (const value of [0, -1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
      expect(() => NativeImage.fromPixels(pixels, value, 1)).toThrow(RangeError)
      expect(() => NativeImage.fromPixels(pixels, 1, value)).toThrow(RangeError)
      expect(() => NativeImage.fromPixels(pixels, 1, 1, { stride: value })).toThrow(RangeError)
    }
    for (const value of ["rgb8", "rgba8unorm", "toString", 1]) {
      expect(() => NativeImage.fromPixels(pixels, 1, 1, { format: value as never })).toThrow(TypeError)
    }
    expect(() => NativeImage.fromPixels(pixels, 1, 1, { alpha: "premultiplied" as never })).toThrow(TypeError)
    expect(() => NativeImage.fromPixels(pixels, 1, 1, { colorSpace: "display-p3" as never })).toThrow(TypeError)
    expect(() => NativeImage.fromPixels(new Uint32Array(4) as never, 1, 1)).toThrow(TypeError)
    expectImageErrorCode(() => NativeImage.fromPixels(pixels, 2, 2, { stride: 7 }), "invalid-argument")
    expectImageErrorCode(() => NativeImage.fromPixels(pixels.subarray(1, 20), 2, 2, { stride: 12 }), "invalid-argument")
    expectImageErrorCode(() => NativeImage.fromPixels(new Uint8Array(), 1, 1), "invalid-argument")
    expectImageErrorCode(
      () => NativeImage.fromPixels(pixels, 1, 0xffff_ffff, { stride: 0xffff_ffff }),
      "invalid-argument",
    )
    expect(() => NativeImage.fromPixels(pixels, 0xffff_ffff, 1)).toThrow(RangeError)
    expectImageErrorCode(() => NativeImage.fromPixels(pixels, 0xffff_ffff, 1, { stride: 4 }), "invalid-argument")
    expectImageErrorCode(() => NativeImage.fromPixels(new Uint8Array(16_385 * 4), 16_385, 1), "dimension-limit")
  })

  test("ensureEncodedPng keeps a raw RGBA image usable and rejects disposed images", () => {
    const image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255, 4, 5, 6, 128), 2, 1)
    try {
      image.ensureEncodedPng()
      expect(image.info()).toMatchObject({ width: 2, height: 1, format: "raw-rgba", hasAlpha: true })
      expect([...image.raw().data]).toEqual([1, 2, 3, 255, 4, 5, 6, 128])
    } finally {
      image.dispose()
    }
    expect(() => image.ensureEncodedPng()).toThrow("disposed")
  })

  test("retains independently disposable references without copying", () => {
    const image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
    const retained = image.retain()
    expect(retained.ptr).not.toBe(image.ptr)
    image.dispose()
    try {
      expect([...retained.raw().data]).toEqual([1, 2, 3, 255])
    } finally {
      retained.dispose()
    }
  })

  test("transfers native RGBA pixels without copying", () => {
    const pixels = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)
    const image = NativeImage.fromRgba(pixels, 2, 1)
    const handle = image.ptr
    const raw = image.takeRaw()
    try {
      expect(raw).toMatchObject({
        width: 2,
        height: 1,
        stride: 8,
        format: "rgba8",
        colorSpace: "srgb",
        alpha: "straight",
      })
      expect([...raw.data]).toEqual([...pixels])
      expect(() => image.info()).toThrow("disposed")

      const pointer = resolveRenderLib().imageGetPixelsPtr(handle)
      expect(pointer).not.toBeNull()
      const alias = new Uint8Array(toArrayBuffer(pointer!, 0, pixels.byteLength))
      raw.data[0] = 42
      expect(alias[0]).toBe(42)
    } finally {
      raw.dispose()
      raw.dispose()
    }
    expect(resolveRenderLib().imageGetPixelsPtr(handle)).toBeNull()
  })

  test("takeRaw reports deferred PNG decode errors", async () => {
    const image = NativeImage.decode(corruptFirstPngIdat(await readBase64Fixture("display-p3.png.base64")))
    try {
      expectImageErrorCode(() => image.takeRaw(), "malformed-data")
    } finally {
      image.dispose()
    }
  })

  test("supports exact transforms, extraction, and extension", () => {
    const image = NativeImage.fromRgba(
      Uint8Array.of(1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255),
      3,
      2,
    )
    let extracted: NativeImage | undefined
    let extended: NativeImage | undefined
    const transformed = [
      { image: image.clone(), size: [3, 2], red: [1, 2, 3, 4, 5, 6] },
      { image: image.rotate(90), size: [2, 3], red: [4, 1, 5, 2, 6, 3] },
      { image: image.rotate(180), size: [3, 2], red: [6, 5, 4, 3, 2, 1] },
      { image: image.rotate(270), size: [2, 3], red: [3, 6, 2, 5, 1, 4] },
      { image: image.flip(), size: [3, 2], red: [4, 5, 6, 1, 2, 3] },
      { image: image.flop(), size: [3, 2], red: [3, 2, 1, 6, 5, 4] },
    ]
    try {
      for (const output of transformed) {
        expect([output.image.width, output.image.height]).toEqual(output.size)
        expect([...output.image.raw().data.filter((_, index) => index % 4 === 0)]).toEqual(output.red)
      }
      extracted = image.extract({ left: 1, top: 0, width: 2, height: 2 })
      expect([extracted.width, extracted.height]).toEqual([2, 2])
      expect([...extracted.raw().data.filter((_, index) => index % 4 === 0)]).toEqual([2, 3, 5, 6])
      extended = extracted.extend({ top: 1, left: 1, background: [9, 8, 7, 6] })
      expect([extended.width, extended.height]).toEqual([3, 3])
      expect([...extended.raw().data]).toEqual([
        9, 8, 7, 6, 9, 8, 7, 6, 9, 8, 7, 6, 9, 8, 7, 6, 2, 0, 0, 255, 3, 0, 0, 255, 9, 8, 7, 6, 5, 0, 0, 255, 6, 0, 0,
        255,
      ])
    } finally {
      extended?.dispose()
      extracted?.dispose()
      for (const output of transformed) output.image.dispose()
      image.dispose()
    }
  })

  test("uses nearest-neighbor sampling when requested", () => {
    const image = NativeImage.fromRgba(Uint8Array.of(0, 0, 0, 255, 255, 0, 0, 255), 2, 1)
    let resized: NativeImage | undefined
    try {
      resized = image.resize({ width: 3, height: 1, kernel: "nearest" })
      expect([...resized.raw().data.filter((_, index) => index % 4 === 0)]).toEqual([0, 255, 255])
    } finally {
      resized?.dispose()
      image.dispose()
    }
  })

  test("updates transparency metadata after extracting opaque pixels", () => {
    const image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255, 4, 5, 6, 0), 2, 1)
    const extracted = image.extract({ left: 0, top: 0, width: 1, height: 1 })
    try {
      expect(image.info().hasAlpha).toBe(true)
      expect(extracted.info().hasAlpha).toBe(false)
    } finally {
      extracted.dispose()
      image.dispose()
    }
  })

  test("zero-margin extension preserves opaque metadata and pixels", () => {
    const image = NativeImage.fromRgba(Uint8Array.of(1, 2, 3, 255), 1, 1)
    const extended = image.extend()
    try {
      expect(extended.info().hasAlpha).toBe(false)
      expect(extended.raw().data).toEqual(image.raw().data)
    } finally {
      extended.dispose()
      image.dispose()
    }
  })

  test("preserves aspect ratio when one resize dimension is omitted", () => {
    const image = NativeImage.fromRgba(new Uint8Array(4 * 4 * 2).fill(255), 4, 2)
    const resized = image.resize({ width: 2 })
    try {
      expect([resized.width, resized.height]).toEqual([2, 1])
    } finally {
      resized.dispose()
      image.dispose()
    }
  })

  test("validates aspect-ratio-derived dimensions before FFI conversion", () => {
    const image = NativeImage.fromRgba(new Uint8Array(8), 2, 1)
    try {
      expect(() => image.resize({ height: 0xffff_ffff })).toThrow("width must be a positive u32 integer")
    } finally {
      image.dispose()
    }
  })

  test("composites in linear light", () => {
    const base = NativeImage.fromRgba(Uint8Array.of(0, 0, 0, 255), 1, 1)
    const overlay = NativeImage.fromRgba(Uint8Array.of(255, 255, 255, 128), 1, 1)
    const output = base.composite(overlay)
    try {
      const red = output.raw().data[0]
      expect(red).toBeGreaterThanOrEqual(187)
      expect(red).toBeLessThanOrEqual(190)
      expect(output.raw().data[3]).toBe(255)
    } finally {
      output.dispose()
      overlay.dispose()
      base.dispose()
    }
  })

  test("updates transparency metadata after source compositing", () => {
    const base = NativeImage.fromRgba(Uint8Array.of(0, 0, 0, 255), 1, 1)
    const overlay = NativeImage.fromRgba(Uint8Array.of(255, 0, 0, 255), 1, 1)
    const output = base.composite(overlay, { blend: "source", opacity: 0.5 })
    try {
      expect(output.raw().data[3]).toBe(128)
      expect(output.info().hasAlpha).toBe(true)
    } finally {
      output.dispose()
      overlay.dispose()
      base.dispose()
    }
  })

  test("supports destination-over compositing", () => {
    const base = NativeImage.fromRgba(Uint8Array.of(0, 0, 255, 128), 1, 1)
    let overlay: NativeImage | undefined
    let output: NativeImage | undefined
    try {
      overlay = NativeImage.fromRgba(Uint8Array.of(255, 0, 0, 255), 1, 1)
      output = base.composite(overlay, { blend: "destination-over" })
      const pixels = output.raw().data
      expect(pixels[0]).toBeGreaterThan(0)
      expect(pixels[2]).toBeGreaterThan(0)
      expect(pixels[3]).toBe(255)
    } finally {
      output?.dispose()
      overlay?.dispose()
      base.dispose()
    }
  })

  test("dispose is idempotent and rejects later operations", () => {
    const image = NativeImage.fromRgba(Uint8Array.of(0, 0, 0, 0), 1, 1)
    image.dispose()
    image.dispose()
    expect(() => image.raw()).toThrow("disposed")
  })

  test("validates dimensions and destination buffers", () => {
    expect(() => NativeImage.fromRgba(new Uint8Array(4), 0, 1)).toThrow("positive u32")
    const image = NativeImage.fromRgba(new Uint8Array(4), 1, 1)
    try {
      expect(() => image.extract({ left: 1, top: 0, width: 1, height: 1 })).toThrow("invalid image argument")
      expect(() => image.copyTo(new Uint8Array(3))).toThrow("too small")
    } finally {
      image.dispose()
    }
  })

  test("loads encoded bytes and ArrayBuffer sources", async () => {
    const bytes = await readFile(new URL("rgba.png", FIXTURES))
    const fromView = await NativeImage.load(bytes.subarray(0))
    const fromBuffer = await NativeImage.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    try {
      expect(fromView.info().format).toBe("png")
      expect(fromBuffer.info()).toEqual(fromView.info())
    } finally {
      fromBuffer.dispose()
      fromView.dispose()
    }
  })

  test("loads Blob, Response, data URL, and blob URL sources", async () => {
    const bytes = await readFile(new URL("rgba.png", FIXTURES))
    const blob = new Blob([bytes], { type: "image/png" })
    const objectUrl = URL.createObjectURL(blob)
    const sources = [
      blob,
      new Response(bytes),
      `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      objectUrl,
    ]
    try {
      for (const source of sources) {
        const image = await NativeImage.load(source)
        try {
          expect(image.info().format).toBe("png")
          expect([image.width, image.height]).toEqual([2, 2])
        } finally {
          image.dispose()
        }
      }
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  })

  test("loads one-byte Response chunks", async () => {
    const bytes = new Uint8Array(await readFile(new URL("rgba.png", FIXTURES)))
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
          controller.close()
        },
      }),
    )

    const image = await NativeImage.load(response)
    try {
      expect(image.info().format).toBe("png")
      expect([image.width, image.height]).toEqual([2, 2])
    } finally {
      image.dispose()
    }
  })

  test("preserves HTTP status errors and cancels direct Response bodies", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
      }),
      { status: 503 },
    )

    try {
      await NativeImage.load(response)
      throw new Error("expected load to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ImageLoadError)
      expect((error as ImageLoadError).code).toBe("http-status")
      expect((error as ImageLoadError).status).toBe(503)
      expect(cancelled).toBe(true)
    }
  })

  test("aborts a pending direct Response read", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {},
        cancel() {
          cancelled = true
        },
      }),
    )
    const controller = new AbortController()
    const reason = new Error("stop")
    const loading = NativeImage.load(response, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort(reason)

    await expect(loading).rejects.toBe(reason)
    expect(cancelled).toBe(true)
  })

  test("cancels a direct Response body when already aborted", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
      }),
    )
    const controller = new AbortController()
    const reason = new Error("stop")
    controller.abort(reason)

    await expect(NativeImage.load(response, { signal: controller.signal })).rejects.toBe(reason)
    expect(cancelled).toBe(true)
  })

  test("loads local paths and file URLs", async () => {
    const url = new URL("rgba.png", FIXTURES)
    const fromPath = await NativeImage.load(fileURLToPath(url))
    const fromUrl = await NativeImage.load(url)
    const fromUrlString = await NativeImage.load(url.href)
    try {
      expect(fromPath.info().format).toBe("png")
      expect(fromUrl.info()).toEqual(fromPath.info())
      expect(fromUrlString.info()).toEqual(fromPath.info())
    } finally {
      fromUrlString.dispose()
      fromUrl.dispose()
      fromPath.dispose()
    }
  })

  test("rejects oversized local files before reading their contents", async () => {
    const directory = await mkdtemp(join(process.env.OTUI_IMAGE_TEST_TMPDIR ?? tmpdir(), "opentui-image-limit-"))
    const path = join(directory, "oversized.png")
    const file = await open(path, "w")
    try {
      await file.truncate(64 * 1024 * 1024 + 1)
    } finally {
      await file.close()
    }
    if (process.platform !== "win32") await chmod(path, 0)

    try {
      try {
        await NativeImage.load(path)
        throw new Error("expected oversized image load to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ImageError)
        expect((error as ImageError).code).toBe("memory-limit")
      }
    } finally {
      if (process.platform !== "win32") await chmod(path, 0o600)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("recognizes URL string schemes case-insensitively", async () => {
    const fixture = await readFile(new URL("rgba.png", FIXTURES))
    const image = await NativeImage.load("HTTPS://images.test/image", {
      fetch: async () => new Response(fixture),
    })
    try {
      expect(image.info().format).toBe("png")
    } finally {
      image.dispose()
    }

    const fileUrl = new URL("rgba.png", FIXTURES).href.replace(/^file:/, "FILE:")
    const fileImage = await NativeImage.load(fileUrl)
    try {
      expect(fileImage.info().format).toBe("png")
    } finally {
      fileImage.dispose()
    }
  })

  test("reports unsupported URL schemes consistently for strings and URL objects", async () => {
    for (const source of ["ftp://images.test/image.png", new URL("ftp://images.test/image.png")]) {
      try {
        await NativeImage.load(source)
        throw new Error("expected load to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ImageLoadError)
        expect((error as ImageLoadError).code).toBe("unsupported-url-scheme")
        expect((error as ImageLoadError).source).toBe("ftp://images.test/image.png")
      }
    }

    try {
      await NativeImage.load("Z:\\opentui-definitely-missing-image.png")
      throw new Error("expected load to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ImageLoadError)
      expect((error as ImageLoadError).code).toBe("file-read")
    }
  })

  test("treats a relative path whose first segment contains a colon as a filesystem path", async () => {
    try {
      await NativeImage.load("assets:dark/missing.png")
      throw new Error("expected load to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ImageLoadError)
      expect((error as ImageLoadError).code).toBe("file-read")
    }
  })

  test("reports filesystem failures", async () => {
    try {
      await NativeImage.load(fileURLToPath(new URL("missing.png", FIXTURES)))
      throw new Error("expected load to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ImageLoadError)
      expect((error as ImageLoadError).code).toBe("file-read")
      expect((error as ImageLoadError).cause).toBeDefined()
    }
  })

  test("loads HTTP responses by bytes and reports status failures", async () => {
    const fixture = await readFile(new URL("lossless.webp", FIXTURES))
    const server = createServer((request, response) => {
      if (request.url === "/image.not-an-extension") {
        response.writeHead(200, { "content-type": "text/plain" })
        response.end(fixture)
      } else {
        response.writeHead(404)
        response.end("missing")
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test server address")
    const base = `http://127.0.0.1:${address.port}`
    try {
      const image = await NativeImage.load(`${base}/image.not-an-extension`)
      try {
        expect(image.info().format).toBe("webp")
      } finally {
        image.dispose()
      }

      try {
        await NativeImage.load(new URL("/missing", base))
        throw new Error("expected HTTP load to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(ImageLoadError)
        expect((error as ImageLoadError).code).toBe("http-status")
        expect((error as ImageLoadError).status).toBe(404)
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("rejects an oversized HTTP response before consuming its body", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(body, {
      headers: { "content-length": String(64 * 1024 * 1024 + 1) },
    })

    try {
      await NativeImage.load(new URL("https://images.test/oversized"), {
        fetch: async () => response,
      })
      throw new Error("expected load to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ImageError)
      expect((error as ImageError).code).toBe("memory-limit")
      expect(cancelled).toBe(true)
    }
  })

  test("cancels an unsuccessful HTTP response body", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })

    try {
      await NativeImage.load(new URL("https://images.test/missing"), {
        fetch: async () => new Response(body, { status: 404 }),
      })
      throw new Error("expected load to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ImageLoadError)
      expect((error as ImageLoadError).code).toBe("http-status")
      expect(cancelled).toBe(true)
    }
  })

  test("stops consuming an HTTP stream when it exceeds the encoded byte limit", async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls <= 70) controller.enqueue(chunk)
        else controller.close()
      },
      cancel() {
        cancelled = true
      },
    })

    try {
      await NativeImage.load(new URL("https://images.test/stream"), {
        fetch: async () => new Response(body),
      })
      throw new Error("expected load to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ImageError)
      expect((error as ImageError).code).toBe("memory-limit")
      expect(pulls).toBeLessThan(70)
      expect(cancelled).toBe(true)
    }
  })

  test("reports and applies JPEG EXIF orientation", async () => {
    const plainBytes = new Uint8Array(await readFile(new URL("orientation.jpg", FIXTURES)))
    const plain = NativeImage.decode(plainBytes)
    const reference = plain.raw()
    const sourceWidth = plain.width
    const sourceHeight = plain.height
    plain.dispose()
    expect(sourceWidth).not.toBe(sourceHeight)
    const sourcePixels = new Set<string>()
    for (let offset = 0; offset < reference.data.length; offset += 4) {
      sourcePixels.add(reference.data.subarray(offset, offset + 4).join(","))
    }
    expect(sourcePixels.size).toBe(sourceWidth * sourceHeight)

    const mappings: Record<number, (dx: number, dy: number) => [number, number]> = {
      // Orientation n: decoded output pixel (dx, dy) comes from source (sx, sy).
      2: (dx, dy) => [sourceWidth - 1 - dx, dy],
      3: (dx, dy) => [sourceWidth - 1 - dx, sourceHeight - 1 - dy],
      4: (dx, dy) => [dx, sourceHeight - 1 - dy],
      5: (dx, dy) => [dy, dx],
      6: (dx, dy) => [dy, sourceHeight - 1 - dx],
      7: (dx, dy) => [sourceWidth - 1 - dy, sourceHeight - 1 - dx],
      8: (dx, dy) => [sourceWidth - 1 - dy, dx],
    }

    for (const [orientationText, mapSource] of Object.entries(mappings)) {
      const orientation = Number(orientationText)
      const swapsDimensions = orientation >= 5
      const bytes = injectJpegExifOrientation(plainBytes, orientation)

      const info = imageInfo(bytes)
      expect(info.orientation).toBe(orientation)
      expect(info.sourceWidth).toBe(sourceWidth)
      expect(info.sourceHeight).toBe(sourceHeight)
      expect(info.width).toBe(swapsDimensions ? sourceHeight : sourceWidth)
      expect(info.height).toBe(swapsDimensions ? sourceWidth : sourceHeight)

      const oriented = NativeImage.decode(bytes)
      try {
        expect(oriented.width).toBe(info.width)
        expect(oriented.height).toBe(info.height)
        expect(oriented.info().orientation).toBe(1)
        const raw = oriented.raw()
        for (let dy = 0; dy < oriented.height; dy++) {
          for (let dx = 0; dx < oriented.width; dx++) {
            const [sx, sy] = mapSource(dx, dy)
            const output = (dy * oriented.width + dx) * 4
            const source = (sy * sourceWidth + sx) * 4
            for (let channel = 0; channel < 4; channel++) {
              if (raw.data[output + channel] !== reference.data[source + channel]) {
                throw new Error(`orientation ${orientation}: pixel (${dx},${dy}) differs from source (${sx},${sy})`)
              }
            }
          }
        }
      } finally {
        oriented.dispose()
      }
    }
  })

  test("finds JPEG EXIF orientation after other application segments", async () => {
    const plainBytes = new Uint8Array(await readFile(new URL("orientation.jpg", FIXTURES)))
    // Insert a benign APP0 comment-style segment before the EXIF APP1 payload.
    const app0 = Uint8Array.from([0xff, 0xe0, 0x00, 0x09, 0x4f, 0x50, 0x54, 0x55, 0x49, 0x00, 0x00])
    const withExif = injectJpegExifOrientation(plainBytes, 6)
    const shifted = new Uint8Array(withExif.length + app0.length)
    shifted.set(withExif.slice(0, 2), 0)
    shifted.set(app0, 2)
    shifted.set(withExif.slice(2), 2 + app0.length)
    expect(imageInfo(shifted).orientation).toBe(6)
  })

  test("ignores invalid JPEG EXIF orientation values", async () => {
    const plainBytes = new Uint8Array(await readFile(new URL("orientation.jpg", FIXTURES)))
    for (const invalid of [0, 9]) {
      const info = imageInfo(injectJpegExifOrientation(plainBytes, invalid))
      expect(info.orientation).toBe(1)
      expect(info.width).toBe(16)
      expect(info.height).toBe(8)
    }
  })

  test("loads HTTPS URLs through fetch and reports network failures", async () => {
    const fixture = await readFile(new URL("transparent.gif", FIXTURES))
    const image = await NativeImage.load(new URL("https://images.test/image"), {
      fetch: async () => new Response(fixture),
    })
    try {
      expect(image.info().format).toBe("gif")
    } finally {
      image.dispose()
    }

    try {
      await NativeImage.load(new URL("https://images.test/failure"), {
        fetch: async () => {
          throw new Error("offline")
        },
      })
      throw new Error("expected network load to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ImageLoadError)
      expect((error as ImageLoadError).code).toBe("network")
    }
  })
})
