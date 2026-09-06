import { RGBA } from "./lib/index.js"
import { withBufferAccess, withLazyBufferAccess } from "./lib/buffer-access.js"
import {
  resolveRenderLib,
  type RenderLib,
  type NativeContextHandle,
  type NativeContextOptions,
  type NativeSceneFrameRequest,
  type SessionHandle,
  type SessionBuffer,
  type ContextBufferHandle,
  type NativeBufferDraw,
  type NativeBufferStack,
  type NativeBufferGrid,
  type NativeContextBufferLease,
  type ContextUnicodeHandle,
} from "./zig.js"
import { acquireSessionBufferLease } from "./session-buffer.js"
import type { PointerInput } from "./platform/ffi.js"
import type { NativeImage } from "./image.js"
import type { ImageRenderProtocol } from "./types.js"
import type { NativeScene } from "./NativeScene.js"

function requireInteger(value: number, name: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  }
}
import { type BorderStyle, type BorderSides, BorderCharArrays, parseBorderStyle } from "./lib/index.js"
import { TargetChannel, type WidthMethod, type CapturedSpan, type CapturedLine } from "./types.js"
import type { TextBufferView } from "./text-buffer-view.js"
import type { EditorView } from "./editor-view.js"

// Pack drawing options into a single u32
// bits 0-3: borderSides, bit 4: shouldFill, bits 5-6: titleAlignment, bits 7-8: bottomTitleAlignment
function packDrawOptions(
  border: boolean | BorderSides[],
  shouldFill: boolean,
  titleAlignment: "left" | "center" | "right",
  bottomTitleAlignment: "left" | "center" | "right",
): number {
  let packed = 0

  if (border === true) {
    packed |= 0b1111 // All sides
  } else if (Array.isArray(border)) {
    if (border.includes("top")) packed |= 0b1000
    if (border.includes("right")) packed |= 0b0100
    if (border.includes("bottom")) packed |= 0b0010
    if (border.includes("left")) packed |= 0b0001
  }

  if (shouldFill) {
    packed |= 1 << 4
  }

  const alignmentMap: Record<string, number> = {
    left: 0,
    center: 1,
    right: 2,
  }
  const alignment = alignmentMap[titleAlignment]
  const bottomAlignment = alignmentMap[bottomTitleAlignment]

  packed |= alignment << 5
  packed |= bottomAlignment << 7

  return packed
}

export interface BufferAccess {
  readonly width: number
  readonly height: number
  readonly generation: bigint
  readonly char: Uint32Array
  readonly fg: Uint16Array
  readonly bg: Uint16Array
  readonly attributes: Uint32Array
}

type SessionBufferSource = {
  context: NativeContextHandle
  session: SessionHandle
  which: SessionBuffer
  getFrame?: () => NativeSceneFrameRequest | null
}

type ContextBufferSource = {
  context: NativeContextHandle
  buffer: ContextBufferHandle
  scene: NativeResourceOwner
}

export interface NativeResourceOwner {
  readonly driver: {
    readonly renderLib: RenderLib
    readonly context: NativeContextHandle
    readonly disposed: boolean
    readonly contextDisposed: boolean
  }
  assertAlive(): void
}

/** Owns standalone checked resources without a renderer, output Session, or terminal. */
export class ResourceContext implements NativeResourceOwner {
  readonly driver = this
  readonly renderLib = resolveRenderLib()
  readonly context: NativeContextHandle
  private _disposed = false

  constructor(options: NativeContextOptions) {
    this.context = this.renderLib.createContext(options)
  }

  get disposed(): boolean {
    return this._disposed
  }

  get contextDisposed(): boolean {
    return this._disposed
  }

  assertAlive(): void {
    if (this._disposed) throw new Error("Resource Context is destroyed")
  }

  destroy(): void {
    if (this._disposed) return
    this.renderLib.getYogaHost().runMutation(() => {
      this.renderLib.destroyContext(this.context)
      this._disposed = true
    })
  }
}

type ContextUnicode = { lib: RenderLib; handle: ContextUnicodeHandle; tokens: number[] }
const contextUnicode = new WeakMap<object, ContextUnicode>()
const contextUnicodeChars = new WeakMap<NativeContextHandle, Map<number, { owner: ContextUnicode; index: number }>>()
let nextUnicodeChar = 0x1_0000_0000

export interface EncodedUnicode {
  data: Array<{ width: number; char: number }>
}

export class OptimizedBuffer {
  private static fbIdCounter = 0
  public id: string
  public lib: RenderLib
  private source: SessionBufferSource | ContextBufferSource
  private _width: number
  private _height: number
  private _widthMethod: WidthMethod
  public respectAlpha: boolean = false
  private _destroyed: boolean = false
  private _nativePaintAccess: (() => BufferAccess) | null = null

  // Fail loud and clear
  // Instead of trying to return values that could work or not,
  // this at least will show a stack trace to know where the call to a destroyed Buffer was made
  private guard(): void {
    if (this._destroyed) throw new Error(`Buffer ${this.id} is destroyed`)
    if ("buffer" in this.source) this.source.scene.assertAlive()
  }

  private checkedTarget(): {
    context: NativeContextHandle
    target: ContextBufferHandle | SessionHandle
    frame: NativeSceneFrameRequest | null
  } {
    const source = this.source
    if ("buffer" in source) {
      return { context: source.context, target: source.buffer, frame: null }
    }
    const frame = source.getFrame?.()
    if (source.which !== "next" || !frame) throw new Error("Session scene drawing requires an active next frame")
    return { context: source.context, target: source.session, frame }
  }

  /** @internal Native built-ins may retain only buffers belonging to their Context. */
  public _getSceneHandle(scene: NativeResourceOwner): ContextBufferHandle {
    this.guard()
    const source = this.source
    if (!("buffer" in source) || source.context !== scene.driver.context || this.lib !== scene.driver.renderLib) {
      throw new Error("Scene binding requires a buffer owned by the same Context")
    }
    return source.buffer
  }

  /** @internal Resource controllers draw only within their owning Context. */
  public _getSceneDrawTarget(scene: NativeScene) {
    this.guard()
    scene.assertAlive()
    const target = this.checkedTarget()
    if (target.context !== scene.driver.context || this.lib !== scene.driver.renderLib) {
      throw new Error("Scene drawing requires a buffer owned by the same Context")
    }
    return target
  }

  private drawChecked(options: NativeBufferDraw): void {
    const target = this.checkedTarget()
    this.lib.contextDrawBuffer(target.context, target.target, target.frame, options)
  }

  /** Raw planes are available only during a synchronous native paint scope. Prefer withBuffers(). */
  get buffers(): {
    char: Uint32Array
    fg: Uint16Array
    bg: Uint16Array
    attributes: Uint32Array
  } {
    this.guard()
    if (this._nativePaintAccess !== null) return this._nativePaintAccess()
    throw new Error("Use withBuffers() for Context-owned framebuffer access")
  }

  /**
   * Borrows one live storage generation for a synchronous callback. Copy data
   * that must outlive the callback; saved arrays cannot be revoked after release.
   * Resize/destruction retains the old storage to scope exit, then reports stale
   * access. This is not a frozen frame or an atomic cell-edit transaction.
   * Do not use saved arrays after exit or change pooled grapheme/link IDs through
   * these planes. Use OptimizedBuffer drawing methods or contextDrawBuffer instead.
   * Styled-text/editor resources, hyperlinks, and images need their checked APIs.
   *
   * Session access without a scene ticket is storage-only. Rendering can change cells
   * without changing generation. `current` is the encoder's comparison buffer, not a
   * guaranteed last-presented frame; `next` is drawing storage cleared after encoding.
   * Finish drawing before submitting a frame. Acquisition rejects pending presentation
   * and non-rendering phases. Checked Session drawing requires an active scene ticket;
   * ticketless storage access does not grant drawing access.
   */
  public withBuffers<T>(callback: (cells: BufferAccess) => T): T {
    this.guard()
    const lib = this.lib
    const source = this.source
    const lease =
      "session" in source
        ? acquireSessionBufferLease(lib, source.context, source.session, source.which, source.getFrame?.())
        : lib.contextAcquireBufferLease(source.context, source.buffer)
    return withBufferAccess(lib, source.context, lease, callback)
  }

  /** Internal synchronous host-paint scope. Native views never escape as persistent buffer state. */
  public _withNativePaint<T>(callback: () => T): T {
    // Retained hooks can outlive the buffer. Guard actual access, not callback dispatch.
    const source = this.source
    const lib = this.lib
    let lease: NativeContextBufferLease | undefined
    const previous = this._nativePaintAccess
    try {
      return withLazyBufferAccess(
        () =>
          (lease ??=
            "session" in source
              ? acquireSessionBufferLease(lib, source.context, source.session, source.which, source.getFrame?.())
              : lib.contextAcquireBufferLease(source.context, source.buffer)),
        (getCells) => {
          this._nativePaintAccess = getCells
          return callback()
        },
        () => {
          if (lease) lib.contextValidateBufferLease(source.context, lease.handle)
        },
      )
    } finally {
      this._nativePaintAccess = previous
      if (lease) lib.contextReleaseBufferLease(source.context, lease.handle)
    }
  }

  private constructor(
    lib: RenderLib,
    source: SessionBufferSource | ContextBufferSource,
    width: number,
    height: number,
    options: { respectAlpha?: boolean; id?: string; widthMethod?: WidthMethod },
  ) {
    this.id = options.id || `fb_${OptimizedBuffer.fbIdCounter++}`
    this.lib = lib
    this.respectAlpha = options.respectAlpha || false
    this._width = width
    this._height = height
    this._widthMethod = options.widthMethod || "unicode"
    this.source = source
  }

  static fromSession(
    lib: RenderLib,
    context: NativeContextHandle,
    session: SessionHandle,
    which: SessionBuffer,
    getFrame?: () => NativeSceneFrameRequest | null,
  ): OptimizedBuffer {
    const { width, height } = lib.sessionGetRendererState(context, session)
    return new OptimizedBuffer(lib, { context, session, which, getFrame }, width, height, { id: `scene-${which}` })
  }

  static create(
    width: number,
    height: number,
    widthMethod: WidthMethod,
    options: { respectAlpha?: boolean; id?: string; owner: NativeResourceOwner },
  ): OptimizedBuffer {
    const owner = options?.owner
    if (!owner || !("driver" in owner)) throw new Error("OptimizedBuffer requires an explicit resource owner")
    owner.assertAlive()
    const { renderLib: lib, context } = owner.driver
    const buffer = lib.createContextBuffer(context, {
      width,
      height,
      widthMethod,
      respectAlpha: options.respectAlpha,
    })
    try {
      return new OptimizedBuffer(lib, { context, buffer, scene: owner }, width, height, { ...options, widthMethod })
    } catch (error) {
      try {
        lib.destroyContextBuffer(context, buffer)
      } catch {
        // Preserve the construction failure if option access disposed the owner.
      }
      throw error
    }
  }

  public get widthMethod(): WidthMethod {
    if ("session" in this.source) {
      this.guard()
      this._widthMethod = this.lib.sessionGetCapabilities(this.source.context, this.source.session).unicode
    }
    return this._widthMethod
  }

  public get width(): number {
    this.guard()
    if ("session" in this.source)
      return this.lib.sessionGetRendererState(this.source.context, this.source.session).width
    return this._width
  }

  public get height(): number {
    this.guard()
    if ("session" in this.source)
      return this.lib.sessionGetRendererState(this.source.context, this.source.session).height
    return this._height
  }

  public setRespectAlpha(respectAlpha: boolean): void {
    this.guard()
    this.drawChecked({ operation: "respectAlpha", packedOptions: Number(respectAlpha) })
    this.respectAlpha = respectAlpha
  }

  public getRealCharBytes(addLineBreaks: boolean = false): Uint8Array {
    return this.withResolvedChars({ addLineBreaks }, (bytes) => bytes)
  }

  private withResolvedChars<T>(
    { addLineBreaks, cellLengths }: { addLineBreaks: boolean; cellLengths?: boolean },
    callback: (bytes: Uint8Array, cells: BufferAccess, lengths?: Uint8Array) => T,
  ): T {
    this.guard()
    const lib = this.lib
    const source = this.source
    const lease =
      "session" in source
        ? acquireSessionBufferLease(lib, source.context, source.session, source.which, source.getFrame?.())
        : lib.contextAcquireBufferLease(source.context, source.buffer)
    return withBufferAccess(lib, source.context, lease, (cells) => {
      const size = lib.contextBufferLeaseGetRealCharSize(source.context, lease.handle, addLineBreaks)
      const output = new Uint8Array(size)
      const lengths = cellLengths ? new Uint8Array(cells.width * cells.height) : undefined
      const written = lib.contextBufferLeaseWriteResolvedChars(
        source.context,
        lease.handle,
        output,
        addLineBreaks,
        lengths,
      )
      return callback(output.subarray(0, written), cells, lengths)
    })
  }

  public getSpanLines(): CapturedLine[] {
    return this.withResolvedChars({ addLineBreaks: false, cellLengths: true }, (bytes, cells, lengths) => {
      const { fg, bg, attributes, width, height } = cells
      const lines: CapturedLine[] = []
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
      let offset = 0

      for (let y = 0; y < height; y++) {
        const spans: CapturedSpan[] = []
        let currentSpan: CapturedSpan | null = null

        for (let x = 0; x < width; x++) {
          const i = y * width + x
          const cellFg = RGBA.fromArray(fg.subarray(i * 4, i * 4 + 4))
          const cellBg = RGBA.fromArray(bg.subarray(i * 4, i * 4 + 4))
          const cellAttrs = attributes[i] & 0xff

          const end = offset + lengths![i]
          const cellChar = decoder.decode(bytes.subarray(offset, end))
          offset = end

          // Check if this cell continues the current span
          if (
            currentSpan &&
            currentSpan.fg.equals(cellFg) &&
            currentSpan.bg.equals(cellBg) &&
            currentSpan.attributes === cellAttrs
          ) {
            currentSpan.text += cellChar
            currentSpan.width += 1
          } else {
            // Start a new span
            if (currentSpan) {
              spans.push(currentSpan)
            }
            currentSpan = {
              text: cellChar,
              fg: cellFg,
              bg: cellBg,
              attributes: cellAttrs,
              width: 1,
            }
          }
        }

        // Push the last span
        if (currentSpan) {
          spans.push(currentSpan)
        }

        lines.push({ spans })
      }

      return lines
    })
  }

  public clear(bg: RGBA = RGBA.fromValues(0, 0, 0, 1)): void {
    this.guard()
    this.drawChecked({ operation: "clear", background: bg })
  }

  public setCell(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number = 0): void {
    this.guard()
    this.drawChecked({
      operation: "cell",
      x,
      y,
      char: char.codePointAt(0) ?? 32,
      foreground: fg,
      background: bg,
      attributes,
    })
  }

  public setCellWithAlphaBlending(
    x: number,
    y: number,
    char: string,
    fg: RGBA,
    bg: RGBA,
    attributes: number = 0,
  ): void {
    this.guard()
    this.drawChecked({
      operation: "cellBlend",
      x,
      y,
      char: char.codePointAt(0) ?? 32,
      foreground: fg,
      background: bg,
      attributes,
    })
  }

  public drawText(
    text: string,
    x: number,
    y: number,
    fg: RGBA,
    bg?: RGBA,
    attributes: number = 0,
    selection?: { start: number; end: number; bgColor?: RGBA; fgColor?: RGBA } | null,
  ): void {
    this.guard()
    if (!selection) {
      this.drawChecked({ operation: "text", text, x, y, foreground: fg, background: bg, attributes })
      return
    }

    const { start, end } = selection

    let selectionBg: RGBA
    let selectionFg: RGBA

    if (selection.bgColor) {
      selectionBg = selection.bgColor
      selectionFg = selection.fgColor || fg
    } else {
      const defaultBg = bg || RGBA.fromValues(0, 0, 0, 0)
      selectionFg = defaultBg.a > 0 ? defaultBg : RGBA.fromValues(0, 0, 0, 1)
      selectionBg = fg
    }

    if (start > 0) {
      const beforeText = text.slice(0, start)
      this.drawText(beforeText, x, y, fg, bg, attributes)
    }

    if (end > start) {
      const selectedText = text.slice(start, end)
      this.drawText(selectedText, x + start, y, selectionFg, selectionBg, attributes)
    }

    if (end < text.length) {
      const afterText = text.slice(end)
      this.drawText(afterText, x + end, y, fg, bg, attributes)
    }
  }

  public fillRect(x: number, y: number, width: number, height: number, bg: RGBA): void {
    this.guard()
    this.drawChecked({ operation: "fill", x, y, width, height, background: bg })
  }

  public colorMatrix(
    matrix: Float32Array,
    cellMask: Float32Array,
    strength: number = 1.0,
    target: TargetChannel = TargetChannel.Both,
  ): void {
    this.guard()
    if (matrix.length !== 16) throw new RangeError(`colorMatrix matrix must have length 16, got ${matrix.length}`)
    const destination = this.checkedTarget()
    this.lib.contextColorMatrixBuffer(
      destination.context,
      destination.target,
      destination.frame,
      matrix,
      cellMask,
      strength,
      target,
    )
  }

  public colorMatrixUniform(
    matrix: Float32Array,
    strength: number = 1.0,
    target: TargetChannel = TargetChannel.Both,
  ): void {
    this.guard()
    if (matrix.length !== 16)
      throw new RangeError(`colorMatrixUniform matrix must have length 16, got ${matrix.length}`)
    const destination = this.checkedTarget()
    this.lib.contextColorMatrixBuffer(
      destination.context,
      destination.target,
      destination.frame,
      matrix,
      null,
      strength,
      target,
    )
  }

  public drawFrameBuffer(
    destX: number,
    destY: number,
    frameBuffer: OptimizedBuffer,
    sourceX?: number,
    sourceY?: number,
    sourceWidth?: number,
    sourceHeight?: number,
  ): void {
    this.guard()
    frameBuffer.guard()
    const destination = this.source
    const source = frameBuffer.source
    if (!("buffer" in source) || source.context !== destination.context || frameBuffer.lib !== this.lib) {
      throw new Error("Scene composition requires a buffer owned by the same Context")
    }
    this.drawChecked({
      operation: "compose",
      source: source.buffer,
      x: destX,
      y: destY,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
    })
  }

  public destroy(): void {
    if (this._destroyed) return
    if ("buffer" in this.source && !this.source.scene.driver.contextDisposed) {
      this.lib.destroyContextBuffer(this.source.context, this.source.buffer)
    }
    this._destroyed = true
  }

  public drawTextBuffer(textBufferView: TextBufferView, x: number, y: number): void {
    this.guard()
    const target = this.checkedTarget()
    const { lib, scene } = textBufferView._getOwner()
    if (lib !== this.lib || scene.driver.context !== target.context) {
      throw new Error("Text drawing requires a view owned by the same Context")
    }
    this.lib.contextDrawTextBufferView(
      target.context,
      target.target,
      target.frame,
      textBufferView._getSceneHandle(scene),
      x,
      y,
    )
  }

  public drawEditorView(editorView: EditorView, x: number, y: number): void {
    this.guard()
    const target = this.checkedTarget()
    const { lib, scene } = editorView._getOwner()
    if (lib !== this.lib || scene.driver.context !== target.context) {
      throw new Error("Editor drawing requires a view owned by the same Context")
    }
    this.lib.contextDrawEditorView(target.context, target.target, target.frame, editorView._getSceneHandle(scene), x, y)
  }

  public drawSuperSampleBuffer(
    x: number,
    y: number,
    pixelData: PointerInput | Uint8Array,
    pixelDataLength: number,
    format: "bgra8unorm" | "rgba8unorm",
    alignedBytesPerRow: number,
  ): void {
    this.guard()
    const target = this.checkedTarget()
    this.lib.contextDrawSuperSampleBuffer(
      target.context,
      target.target,
      target.frame,
      pixelData,
      pixelDataLength,
      x,
      y,
      format,
      alignedBytesPerRow,
    )
  }

  public drawImage(
    image: NativeImage,
    x: number,
    y: number,
    width: number,
    height: number,
    pixelWidth: number = 0,
    pixelHeight: number = 0,
    sourceX: number = 0,
    sourceY: number = 0,
    sourceWidth: number = image.width,
    sourceHeight: number = image.height,
    protocol: ImageRenderProtocol = "auto",
  ): boolean {
    this.guard()
    requireInteger(x, "x", -0x80000000, 0x7fffffff)
    requireInteger(y, "y", -0x80000000, 0x7fffffff)
    requireInteger(width, "width", 1, 0x7fffffff)
    requireInteger(height, "height", 1, 0x7fffffff)
    requireInteger(pixelWidth, "pixelWidth", 0, 0x7fffffff)
    requireInteger(pixelHeight, "pixelHeight", 0, 0x7fffffff)
    requireInteger(sourceX, "sourceX", 0, 0xffffffff)
    requireInteger(sourceY, "sourceY", 0, 0xffffffff)
    requireInteger(sourceWidth, "sourceWidth", 1, 0xffffffff)
    requireInteger(sourceHeight, "sourceHeight", 1, 0xffffffff)
    if (x + width > 0x7fffffff || y + height > 0x7fffffff) {
      throw new RangeError("image destination coordinates and dimensions exceed i32 bounds")
    }
    const target = this.checkedTarget()
    return this.lib.contextDrawImage(
      target.context,
      target.target,
      target.frame,
      image._getContextHandle(this.lib, target.context),
      { x, y, width, height, pixelWidth, pixelHeight, sourceX, sourceY, sourceWidth, sourceHeight, protocol },
    )
  }

  public drawPackedBuffer(
    data: PointerInput | Uint8Array,
    dataLen: number,
    posX: number,
    posY: number,
    terminalWidthCells: number,
    terminalHeightCells: number,
  ): void {
    this.guard()
    const target = this.checkedTarget()
    this.lib.contextDrawPackedBuffer(
      target.context,
      target.target,
      target.frame,
      data,
      dataLen,
      posX,
      posY,
      terminalWidthCells,
      terminalHeightCells,
    )
  }

  public drawGrayscaleBuffer(
    posX: number,
    posY: number,
    intensities: Float32Array,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null = null,
    bg: RGBA | null = null,
  ): void {
    this.guard()
    const target = this.checkedTarget()
    this.lib.contextDrawGrayscaleBuffer(
      target.context,
      target.target,
      target.frame,
      intensities,
      posX,
      posY,
      srcWidth,
      srcHeight,
      fg,
      bg,
      false,
    )
  }

  public drawGrayscaleBufferSupersampled(
    posX: number,
    posY: number,
    intensities: Float32Array,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null = null,
    bg: RGBA | null = null,
  ): void {
    this.guard()
    const target = this.checkedTarget()
    this.lib.contextDrawGrayscaleBuffer(
      target.context,
      target.target,
      target.frame,
      intensities,
      posX,
      posY,
      srcWidth,
      srcHeight,
      fg,
      bg,
      true,
    )
  }

  public resize(width: number, height: number): void {
    this.guard()
    const source = this.source
    if ("session" in source) {
      throw new Error("Resizing a Session scene framebuffer is unsupported")
    }
    if (this._width === width && this._height === height) return

    this.lib.contextResizeBuffer(source.context, source.buffer, width, height)

    this._width = width
    this._height = height
  }

  public drawBox(options: {
    x: number
    y: number
    width: number
    height: number
    borderStyle?: BorderStyle
    customBorderChars?: Uint32Array
    border: boolean | BorderSides[]
    borderColor: RGBA
    backgroundColor: RGBA
    shouldFill?: boolean
    title?: string
    titleColor?: RGBA
    titleAlignment?: "left" | "center" | "right"
    bottomTitle?: string
    bottomTitleAlignment?: "left" | "center" | "right"
  }): void {
    this.guard()
    const style = parseBorderStyle(options.borderStyle, "single")
    const borderChars: Uint32Array = options.customBorderChars ?? BorderCharArrays[style]

    const packedOptions = packDrawOptions(
      options.border,
      options.shouldFill ?? false,
      options.titleAlignment || "left",
      options.bottomTitleAlignment || "left",
    )

    this.drawChecked({
      operation: "box",
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height,
      borderChars,
      packedOptions,
      foreground: options.borderColor,
      background: options.backgroundColor,
      titleColor: options.titleColor ?? options.borderColor,
      text: options.title,
      bottomTitle: options.bottomTitle,
    })
  }

  public pushScissorRect(x: number, y: number, width: number, height: number): void {
    this.guard()
    this.stackChecked({ operation: "pushScissor", x, y, width, height })
  }

  public popScissorRect(): void {
    this.guard()
    this.stackChecked({ operation: "popScissor" })
  }

  public clearScissorRects(): void {
    this.guard()
    this.stackChecked({ operation: "clearScissors" })
  }

  public pushOpacity(opacity: number): void {
    this.guard()
    this.stackChecked({ operation: "pushOpacity", opacity })
  }

  public popOpacity(): void {
    this.guard()
    this.stackChecked({ operation: "popOpacity" })
  }

  public getCurrentOpacity(): number {
    this.guard()
    return this.stackChecked({ operation: "getOpacity" })
  }

  public clearOpacity(): void {
    this.guard()
    this.stackChecked({ operation: "clearOpacity" })
  }

  private stackChecked(options: NativeBufferStack): number {
    const target = this.checkedTarget()
    return this.lib.contextBufferStack(target.context, target.target, target.frame, options)
  }

  public encodeUnicode(text: string): EncodedUnicode {
    this.guard()
    const context = this.source.context
    const handle = this.lib.createContextUnicode(context, text, this.widthMethod)
    const owner: ContextUnicode = { lib: this.lib, handle, tokens: [] }
    let chars = contextUnicodeChars.get(context)
    if (!chars) contextUnicodeChars.set(context, (chars = new Map()))
    try {
      const data = this.lib.getContextUnicode(context, handle)
      if (data.length > Number.MAX_SAFE_INTEGER - nextUnicodeChar) throw new RangeError("Unicode token limit reached")
      data.forEach((glyph, index) => {
        if (glyph.char <= 0x10ffff) return
        // Public numbers are opaque tokens, never pool IDs or truncated native handles.
        glyph.char = nextUnicodeChar++
        owner.tokens.push(glyph.char)
        chars.set(glyph.char, { owner, index })
      })
      const encoded = { data }
      contextUnicode.set(encoded, owner)
      return encoded
    } catch (error) {
      for (const token of owner.tokens) chars.delete(token)
      try {
        this.lib.destroyContextUnicode(context, handle)
      } catch {
        // Preserve the publication failure if the Context was disposed during copying.
      }
      throw error
    }
  }

  public freeUnicode(encoded: EncodedUnicode): void {
    this.guard()
    const native = contextUnicode.get(encoded)
    if (!native || native.lib !== this.lib || native.handle.context !== this.source.context) {
      throw new Error("Encoded Unicode must be live and owned by the same Context")
    }
    this.lib.destroyContextUnicode(this.source.context, native.handle)
    const chars = contextUnicodeChars.get(this.source.context)!
    for (const token of native.tokens) chars.delete(token)
    contextUnicode.delete(encoded)
  }

  public drawGrid(options: NativeBufferGrid): void {
    this.guard()
    const target = this.checkedTarget()
    this.lib.contextDrawGrid(target.context, target.target, target.frame, options)
  }

  public drawChar(char: number, x: number, y: number, fg: RGBA, bg: RGBA, attributes: number = 0): void {
    this.guard()
    if (char > 0xffffffff) {
      const target = this.checkedTarget()
      const glyph = contextUnicodeChars.get(target.context)?.get(char)
      if (!glyph || glyph.owner.lib !== this.lib) {
        throw new Error("Encoded Unicode must be live and owned by the same Context")
      }
      this.lib.contextBufferDrawUnicode(
        target.context,
        target.target,
        target.frame,
        glyph.owner.handle,
        glyph.index,
        x,
        y,
        fg,
        bg,
        attributes,
      )
      return
    }
    this.drawChecked({ operation: "char", char, x, y, foreground: fg, background: bg, attributes })
  }
}
