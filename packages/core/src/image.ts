import { open, stat } from "node:fs/promises"

import { toArrayBuffer } from "./platform/ffi.js"
import { resolveRenderLib, type ImageHandle, type RenderLib } from "./zig.js"
import type { NativeImageInfo } from "./zig-structs.js"

export type ImageFormat = "png" | "raw-rgba" | "jpeg" | "webp" | "gif"
export type ImageColorStatus = "assumed-srgb" | "explicit-srgb"
export type ResizeKernel = "default" | "area" | "triangle" | "cubic-bspline" | "catmull-rom" | "mitchell" | "nearest"
export type BlendMode = "source-over" | "source" | "destination-over"
export type PixelFormat = "rgba8" | "bgra8"
export type ImageSource = string | URL | Uint8Array | ArrayBuffer | Blob | Response

export type ImageLoadErrorCode = "file-read" | "network" | "http-status" | "unsupported-url-scheme"

export class ImageLoadError extends Error {
  public readonly code: ImageLoadErrorCode
  public readonly source: string
  public readonly status?: number

  constructor(
    code: ImageLoadErrorCode,
    source: string,
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, { cause: options?.cause })
    this.name = "ImageLoadError"
    this.code = code
    this.source = source
    this.status = options?.status
  }
}

export interface ImageLoadOptions {
  signal?: AbortSignal
  fetch?: (input: URL, init?: RequestInit) => Promise<Response>
}

export interface ImageInfo {
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  format: ImageFormat
  colorStatus: ImageColorStatus
  orientation: number
  hasAlpha: boolean
}

export interface ResizeOptions {
  width?: number
  height?: number
  kernel?: ResizeKernel
}

export interface ExtractOptions {
  left: number
  top: number
  width: number
  height: number
}

export interface ExtendOptions {
  top?: number
  right?: number
  bottom?: number
  left?: number
  background?: readonly [number, number, number, number]
}

export interface CompositeOptions {
  left?: number
  top?: number
  blend?: BlendMode
  opacity?: number
}

export interface RawImage {
  data: Uint8Array
  width: number
  height: number
  stride: number
  format: PixelFormat
  colorSpace: "srgb"
  alpha: "straight"
}

export interface PixelImportOptions {
  stride?: number
  format?: PixelFormat
  alpha?: "straight" | "opaque"
  colorSpace?: "srgb"
}

export interface OwnedRawImage extends RawImage {
  dispose(): void
}

class OwnedRawImageImpl implements OwnedRawImage {
  private handle: ImageHandle | null

  public readonly format = "rgba8"
  public readonly colorSpace = "srgb"
  public readonly alpha = "straight"

  constructor(
    public readonly data: Uint8Array,
    public readonly width: number,
    public readonly height: number,
    public readonly stride: number,
    private readonly lib: RenderLib,
    handle: ImageHandle,
  ) {
    this.handle = handle
  }

  public dispose(): void {
    if (!this.handle) return
    this.lib.imageDestroy(this.handle)
    this.handle = null
  }
}

const STATUS_MESSAGES = [
  "ok",
  "invalid image handle",
  "unsupported image format",
  "unsupported image color space",
  "malformed image data",
  "image dimensions exceed limits",
  "image memory limit exceeded",
  "invalid image argument",
  "out of memory",
  "image output buffer is too small",
  "internal image error",
  "unsupported image feature",
  "image is retained",
] as const

export type ImageErrorCode =
  | "invalid-handle"
  | "unsupported-format"
  | "unsupported-color-space"
  | "malformed-data"
  | "dimension-limit"
  | "memory-limit"
  | "invalid-argument"
  | "out-of-memory"
  | "output-too-small"
  | "internal-error"
  | "unsupported-feature"
  | "busy"

const STATUS_CODES: readonly ImageErrorCode[] = [
  "internal-error",
  "invalid-handle",
  "unsupported-format",
  "unsupported-color-space",
  "malformed-data",
  "dimension-limit",
  "memory-limit",
  "invalid-argument",
  "out-of-memory",
  "output-too-small",
  "internal-error",
  "unsupported-feature",
  "busy",
]
const INVALID_ARGUMENT_STATUS = 7
const BUSY_STATUS = 12

export class ImageError extends Error {
  public readonly code: ImageErrorCode
  public readonly status: number

  constructor(status: number) {
    super(`Native image operation failed: ${STATUS_MESSAGES[status] ?? `unknown status ${status}`}`)
    this.name = "ImageError"
    this.status = status
    this.code = STATUS_CODES[status] ?? "internal-error"
  }
}

const FILTER_IDS: Record<ResizeKernel, number> = {
  default: 0,
  area: 1,
  triangle: 2,
  "cubic-bspline": 3,
  "catmull-rom": 4,
  mitchell: 5,
  nearest: 6,
}

const BLEND_IDS: Record<BlendMode, number> = {
  "source-over": 0,
  source: 1,
  "destination-over": 2,
}

const PIXEL_FORMAT_BGRA: Record<PixelFormat, boolean> = {
  rgba8: false,
  bgra8: true,
}

const PIXEL_ALPHA_IDS = { straight: 0, opaque: 1 } as const

const MAX_ENCODED_BYTES = 64 * 1024 * 1024

function imageError(status: number): Error {
  return new ImageError(status)
}

function checkStatus(status: number): void {
  if (status !== 0) throw imageError(status)
}

function requireMappedOption<T extends string, V>(mapping: Record<T, V>, value: T, name: string): V {
  if (!Object.prototype.hasOwnProperty.call(mapping, value))
    throw new TypeError(`Unsupported ${name}: ${String(value)}`)
  return mapping[value]
}

function requireU32(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} u32 integer`)
  }
  return value
}

function pixelImportOptions(width: number, options: PixelImportOptions) {
  const stride = requireU32(options.stride ?? width * 4, "stride")
  const bgra = requireMappedOption(PIXEL_FORMAT_BGRA, options.format ?? "rgba8", "pixel format")
  const alpha = requireMappedOption(PIXEL_ALPHA_IDS, options.alpha ?? "straight", "pixel alpha")
  if (options.colorSpace !== undefined && options.colorSpace !== "srgb") {
    throw new TypeError(`Unsupported pixel color space: ${String(options.colorSpace)}`)
  }
  return { stride, format: Number(bgra), alpha }
}

function requireI32(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new RangeError(`${name} must be an i32 integer`)
  }
  return value
}

function requireByte(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 255)
    throw new RangeError(`${name} must be an integer from 0 to 255`)
  return value
}

function unpackInfo(info: NativeImageInfo): ImageInfo {
  const format = (["unknown", "png", "raw-rgba", "jpeg", "webp", "gif"] as const)[info.format]
  if (!format || format === "unknown") throw new Error(`Unknown native image format ${info.format}`)
  return {
    width: info.width,
    height: info.height,
    sourceWidth: info.sourceWidth,
    sourceHeight: info.sourceHeight,
    format,
    colorStatus: info.colorStatus === 1 ? "explicit-srgb" : "assumed-srgb",
    orientation: info.orientation,
    hasAlpha: info.hasAlpha !== 0,
  }
}

function encodedBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new TypeError("image data must be a Uint8Array or ArrayBuffer")
}

async function readResponseBytes(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length")
  if (contentLength !== null) {
    const declaredLength = Number(contentLength)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ENCODED_BYTES) {
      void response.body?.cancel().catch(() => {})
      throw imageError(6)
    }
  }

  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const abort = () => void reader.cancel(signal?.reason).catch(() => {})
  signal?.addEventListener("abort", abort, { once: true })
  let data = new Uint8Array()
  let total = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > MAX_ENCODED_BYTES - total) {
        throw imageError(6)
      }
      if (value.byteLength === 0) continue
      const required = total + value.byteLength
      if (required > data.byteLength) {
        const capacity = Math.min(MAX_ENCODED_BYTES, Math.max(required, data.byteLength * 2))
        const grown = new Uint8Array(capacity)
        grown.set(data.subarray(0, total))
        data = grown
      }
      data.set(value, total)
      total = required
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener("abort", abort)
    reader.releaseLock()
  }

  return data.byteLength === total ? data : data.slice(0, total)
}

async function readFileBytes(path: string | URL, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted()
  if ((await stat(path)).size > MAX_ENCODED_BYTES) throw imageError(6)

  const file = await open(path, "r")
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const chunk = new Uint8Array(Math.min(64 * 1024, MAX_ENCODED_BYTES - total + 1))
      const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > MAX_ENCODED_BYTES) throw imageError(6)
      chunks.push(chunk.subarray(0, bytesRead))
    }
  } finally {
    await file.close()
  }

  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return data
}

async function loadResponseBytes(response: Response, source: string, signal?: AbortSignal): Promise<Uint8Array> {
  try {
    signal?.throwIfAborted()
  } catch (error) {
    void response.body?.cancel().catch(() => {})
    throw error
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new ImageLoadError("http-status", source, `Failed to fetch image: HTTP ${response.status}`, {
      status: response.status,
    })
  }
  try {
    const data = await readResponseBytes(response, signal)
    signal?.throwIfAborted()
    return data
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    if (error instanceof ImageError) throw error
    throw new ImageLoadError("network", source, `Failed to read image response: ${source}`, { cause: error })
  }
}

export function imageInfo(data: Uint8Array | ArrayBuffer): ImageInfo {
  const bytes = encodedBytes(data)
  if (bytes.byteLength === 0) throw new TypeError("image data must not be empty")
  const result = resolveRenderLib().imageInfo(bytes)
  checkStatus(result.status)
  return unpackInfo(result.info)
}

export class NativeImage {
  private readonly lib: RenderLib
  private handle: ImageHandle | null
  private imageInfo: ImageInfo

  private constructor(lib: RenderLib, handle: ImageHandle, info: ImageInfo) {
    this.lib = lib
    this.handle = handle
    this.imageInfo = info
  }

  public static decode(data: Uint8Array | ArrayBuffer): NativeImage {
    const bytes = encodedBytes(data)
    if (bytes.byteLength === 0) throw new TypeError("image data must not be empty")
    const lib = resolveRenderLib()
    const result = lib.imageDecode(bytes)
    checkStatus(result.status)
    if (!result.handle) throw imageError(10)
    return NativeImage.fromHandle(lib, result.handle)
  }

  public static async load(source: ImageSource, options: ImageLoadOptions = {}): Promise<NativeImage> {
    if (source instanceof Response) {
      return NativeImage.decode(await loadResponseBytes(source, source.url || "Response", options.signal))
    }
    options.signal?.throwIfAborted()
    if (source instanceof Uint8Array || source instanceof ArrayBuffer) return NativeImage.decode(source)
    if (source instanceof Blob) {
      if (source.size > MAX_ENCODED_BYTES) throw imageError(6)
      return NativeImage.decode(await loadResponseBytes(new Response(source), "Blob", options.signal))
    }

    const url =
      source instanceof URL
        ? source
        : (/^(?:https?|file|blob|data):/i.test(source) || /^[a-z][a-z0-9+.-]*:\/\//i.test(source)) &&
            !/^[a-z]:[\\/]/i.test(source)
          ? new URL(source)
          : null
    if (!url || url.protocol === "file:") {
      const path = url ?? source
      let data: Uint8Array
      try {
        data = await readFileBytes(path, options.signal)
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason
        if (error instanceof ImageError) throw error
        throw new ImageLoadError("file-read", String(source), `Failed to read image: ${String(source)}`, {
          cause: error,
        })
      }
      options.signal?.throwIfAborted()
      return NativeImage.decode(data)
    }

    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "blob:" && url.protocol !== "data:") {
      throw new ImageLoadError("unsupported-url-scheme", url.href, `Unsupported image URL scheme: ${url.protocol}`)
    }

    let response: Response
    try {
      response = await (options.fetch ?? globalThis.fetch)(url, { signal: options.signal })
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason
      throw new ImageLoadError("network", url.href, `Failed to fetch image: ${url.href}`, { cause: error })
    }
    return NativeImage.decode(await loadResponseBytes(response, url.href, options.signal))
  }

  public static fromRgba(pixels: Uint8Array, width: number, height: number, stride = width * 4): NativeImage {
    if (!(pixels instanceof Uint8Array)) throw new TypeError("pixels must be a Uint8Array")
    requireU32(width, "width")
    requireU32(height, "height")
    requireU32(stride, "stride")
    const lib = resolveRenderLib()
    const result = lib.imageCreateFromRgba(pixels, width, height, stride)
    checkStatus(result.status)
    if (!result.handle) throw imageError(10)
    return NativeImage.fromHandle(lib, result.handle)
  }

  public static fromPixels(
    pixels: Uint8Array,
    width: number,
    height: number,
    options: PixelImportOptions = {},
  ): NativeImage {
    if (!(pixels instanceof Uint8Array)) throw new TypeError("pixels must be a Uint8Array")
    requireU32(width, "width")
    requireU32(height, "height")
    const { stride, format, alpha } = pixelImportOptions(width, options)
    const lib = resolveRenderLib()
    const result = lib.imageCreateFromPixels(pixels, width, height, stride, format, alpha)
    checkStatus(result.status)
    if (!result.handle) throw imageError(10)
    return NativeImage.fromHandle(lib, result.handle)
  }

  private static fromHandle(lib: RenderLib, handle: ImageHandle): NativeImage {
    const result = lib.imageGetInfo(handle)
    if (result.status !== 0) {
      lib.imageDestroy(handle)
      throw imageError(result.status)
    }
    return new NativeImage(lib, handle, unpackInfo(result.info))
  }

  private guard(): ImageHandle {
    if (!this.handle) throw new Error("NativeImage is disposed")
    return this.handle
  }

  public get ptr(): ImageHandle {
    return this.guard()
  }

  private wrap(result: { status: number; handle: ImageHandle | null }): NativeImage {
    checkStatus(result.status)
    if (!result.handle) throw imageError(10)
    return NativeImage.fromHandle(this.lib, result.handle)
  }

  public info(): ImageInfo {
    this.guard()
    return { ...this.imageInfo }
  }

  public get width(): number {
    this.guard()
    return this.imageInfo.width
  }

  public get height(): number {
    this.guard()
    return this.imageInfo.height
  }

  public clone(): NativeImage {
    return this.wrap(this.lib.imageClone(this.guard()))
  }

  public retain(): NativeImage {
    return this.wrap(this.lib.imageRetain(this.guard()))
  }

  public resize(options: ResizeOptions): NativeImage {
    if (!options || (options.width === undefined && options.height === undefined)) {
      throw new TypeError("resize requires width, height, or both")
    }
    let width = options.width
    let height = options.height
    if (width !== undefined) requireU32(width, "width")
    if (height !== undefined) requireU32(height, "height")
    if (width === undefined) width = Math.max(1, Math.round((this.width * height!) / this.height))
    if (height === undefined) height = Math.max(1, Math.round((this.height * width) / this.width))
    requireU32(width, "width")
    requireU32(height, "height")
    const filter = requireMappedOption(FILTER_IDS, options.kernel ?? "area", "resize kernel")
    return this.wrap(this.lib.imageResize(this.guard(), width, height, filter))
  }

  public extract(options: ExtractOptions): NativeImage {
    return this.wrap(
      this.lib.imageExtract(
        this.guard(),
        requireU32(options.left, "left", true),
        requireU32(options.top, "top", true),
        requireU32(options.width, "width"),
        requireU32(options.height, "height"),
      ),
    )
  }

  public extend(options: ExtendOptions = {}): NativeImage {
    const background = options.background ?? [0, 0, 0, 0]
    if (background.length !== 4) throw new TypeError("background must contain four RGBA channels")
    const color = Uint8Array.from(background.map((value, index) => requireByte(value, `background[${index}]`)))
    return this.wrap(
      this.lib.imageExtend(
        this.guard(),
        requireU32(options.top ?? 0, "top", true),
        requireU32(options.right ?? 0, "right", true),
        requireU32(options.bottom ?? 0, "bottom", true),
        requireU32(options.left ?? 0, "left", true),
        color,
      ),
    )
  }

  public rotate(angle: 90 | 180 | 270): NativeImage {
    const operation = angle === 90 ? 0 : angle === 180 ? 1 : angle === 270 ? 2 : -1
    if (operation < 0) throw new RangeError("angle must be 90, 180, or 270")
    return this.wrap(this.lib.imageTransform(this.guard(), operation))
  }

  public flip(): NativeImage {
    return this.wrap(this.lib.imageTransform(this.guard(), 3))
  }

  public flop(): NativeImage {
    return this.wrap(this.lib.imageTransform(this.guard(), 4))
  }

  public composite(overlay: NativeImage, options: CompositeOptions = {}): NativeImage {
    if (!(overlay instanceof NativeImage)) throw new TypeError("overlay must be a NativeImage")
    const opacity = options.opacity ?? 1
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError("opacity must be between 0 and 1")
    return this.wrap(
      this.lib.imageComposite(
        this.guard(),
        overlay.guard(),
        requireI32(options.left ?? 0, "left"),
        requireI32(options.top ?? 0, "top"),
        requireMappedOption(BLEND_IDS, options.blend ?? "source-over", "blend mode"),
        Math.round(opacity * 255),
      ),
    )
  }

  public ensureEncodedPng(): void {
    checkStatus(this.lib.imageEnsureEncodedPng(this.guard()))
  }

  public raw(format: PixelFormat = "rgba8"): RawImage {
    const stride = this.width * 4
    const data = new Uint8Array(stride * this.height)
    checkStatus(
      this.lib.imageCopyPixels(
        this.guard(),
        data,
        stride,
        requireMappedOption(PIXEL_FORMAT_BGRA, format, "pixel format"),
      ),
    )
    return { data, width: this.width, height: this.height, stride, format, colorSpace: "srgb", alpha: "straight" }
  }

  public takeRaw(): OwnedRawImage {
    const handle = this.guard()
    const materializeStatus = this.lib.imageMaterialize(handle)
    if (materializeStatus === INVALID_ARGUMENT_STATUS) {
      throw new Error("Cannot transfer image pixels while native buffers retain the image")
    }
    checkStatus(materializeStatus)
    const pointer = this.lib.imageGetPixelsPtr(handle)
    if (!pointer) throw new Error("Cannot transfer image pixels while native buffers retain the image")
    const width = this.imageInfo.width
    const height = this.imageInfo.height
    const stride = width * 4
    const data = new Uint8Array(toArrayBuffer(pointer, 0, stride * height))
    const raw = new OwnedRawImageImpl(data, width, height, stride, this.lib, handle)
    this.handle = null
    return raw
  }

  public copyTo(destination: Uint8Array, options: { stride?: number; format?: PixelFormat } = {}): void {
    if (!(destination instanceof Uint8Array)) throw new TypeError("destination must be a Uint8Array")
    const stride = options.stride ?? this.width * 4
    requireU32(stride, "stride")
    const bgra = requireMappedOption(PIXEL_FORMAT_BGRA, options.format ?? "rgba8", "pixel format")
    checkStatus(this.lib.imageCopyPixels(this.guard(), destination, stride, bgra))
  }

  public dispose(): void {
    if (!this.handle) return
    this.lib.imageDestroy(this.handle)
    this.handle = null
  }
}

export interface NativeImagePoolOptions {
  width: number
  height: number
  capacity?: number
}

export class NativeImagePool {
  private readonly lib: RenderLib
  private readonly images: NativeImage[] = []
  private disposed = false
  public readonly width: number
  public readonly height: number
  public readonly capacity: number

  constructor(options: NativeImagePoolOptions) {
    this.width = requireU32(options.width, "width")
    this.height = requireU32(options.height, "height")
    this.capacity = requireU32(options.capacity ?? 3, "capacity")
    if (this.capacity > 8) throw new RangeError("capacity must be between 1 and 8")
    this.lib = resolveRenderLib()
  }

  public publishRgba(pixels: Uint8Array, stride = this.width * 4): NativeImage | null {
    return this.publishPixels(pixels, { stride: requireU32(stride, "stride") })
  }

  public publishPixels(pixels: Uint8Array, options: PixelImportOptions = {}): NativeImage | null {
    if (this.disposed) throw new Error("NativeImagePool is disposed")
    if (!(pixels instanceof Uint8Array)) throw new TypeError("pixels must be a Uint8Array")
    const { stride, format, alpha } = pixelImportOptions(this.width, options)

    for (const image of this.images) {
      const status = this.lib.imageUpdatePixels(image.ptr, pixels, stride, format, alpha)
      if (status === BUSY_STATUS) continue
      checkStatus(status)
      // The private owner is never rendered. A fresh handle prevents stale native
      // cache hits and a fresh wrapper triggers ImageRenderable.source invalidation.
      return image.retain()
    }
    if (this.images.length === this.capacity) return null

    const image = NativeImage.fromPixels(pixels, this.width, this.height, options)
    this.images.push(image)
    return image.retain()
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const image of this.images) image.dispose()
    this.images.length = 0
  }
}
