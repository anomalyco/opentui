import { RGBA } from "./lib/index.js"
import { resolveRenderLib, type OptimizedBufferHandle, type RenderLib } from "./zig.js"
import { type Pointer, type PointerInput, toArrayBuffer, toPointer, ptr } from "./platform/ffi.js"
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

export class OptimizedBuffer {
  private static fbIdCounter = 0
  public id: string
  public lib: RenderLib
  private bufferPtr: OptimizedBufferHandle
  private _width: number
  private _height: number
  private _widthMethod: WidthMethod
  public respectAlpha: boolean = false
  private _rawBuffers: {
    char: Uint32Array
    fg: Uint16Array
    bg: Uint16Array
    attributes: Uint32Array
  } | null = null
  private _destroyed: boolean = false

  get ptr(): OptimizedBufferHandle {
    return this.bufferPtr
  }

  // Fail loud and clear
  // Instead of trying to return values that could work or not,
  // this at least will show a stack trace to know where the call to a destroyed Buffer was made
  private guard(): void {
    if (this._destroyed) throw new Error(`Buffer ${this.id} is destroyed`)
  }

  private ensureRawBufferViews(): void {
    if (this._rawBuffers !== null) {
      return
    }

    const size = this._width * this._height
    const charPtr = this.lib.bufferGetCharPtr(this.bufferPtr)
    const fgPtr = this.lib.bufferGetFgPtr(this.bufferPtr)
    const bgPtr = this.lib.bufferGetBgPtr(this.bufferPtr)
    const attributesPtr = this.lib.bufferGetAttributesPtr(this.bufferPtr)

    this._rawBuffers = {
      char: new Uint32Array(toArrayBuffer(charPtr, 0, size * 4)),
      fg: new Uint16Array(toArrayBuffer(fgPtr, 0, size * 4 * 2)),
      bg: new Uint16Array(toArrayBuffer(bgPtr, 0, size * 4 * 2)),
      attributes: new Uint32Array(toArrayBuffer(attributesPtr, 0, size * 4)),
    }
  }

  get buffers(): {
    char: Uint32Array
    fg: Uint16Array
    bg: Uint16Array
    attributes: Uint32Array
  } {
    this.guard()
    this.ensureRawBufferViews()
    return this._rawBuffers!
  }

  constructor(
    lib: RenderLib,
    ptr: OptimizedBufferHandle,
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
    this.bufferPtr = ptr
  }

  static create(
    width: number,
    height: number,
    widthMethod: WidthMethod,
    options: { respectAlpha?: boolean; id?: string } = {},
  ): OptimizedBuffer {
    const lib = resolveRenderLib()
    const respectAlpha = options.respectAlpha || false
    const id = options.id && options.id.trim() !== "" ? options.id : "unnamed buffer"
    const buffer = lib.createOptimizedBuffer(width, height, widthMethod, respectAlpha, id)
    return buffer
  }

  public get widthMethod(): WidthMethod {
    return this._widthMethod
  }

  public get width(): number {
    return this._width
  }

  public get height(): number {
    return this._height
  }

  public setRespectAlpha(respectAlpha: boolean): void {
    this.guard()
    this.lib.bufferSetRespectAlpha(this.bufferPtr, respectAlpha)
    this.respectAlpha = respectAlpha
  }

  public getNativeId(): string {
    this.guard()
    return this.lib.bufferGetId(this.bufferPtr)
  }

  public getRealCharBytes(addLineBreaks: boolean = false): Uint8Array {
    this.guard()
    const realSize = this.lib.bufferGetRealCharSize(this.bufferPtr)
    const outputBuffer = new Uint8Array(realSize)
    const bytesWritten = this.lib.bufferWriteResolvedChars(this.bufferPtr, outputBuffer, addLineBreaks)
    return outputBuffer.slice(0, bytesWritten)
  }

  public getSpanLines(): CapturedLine[] {
    this.guard()
    const { char, fg, bg, attributes } = this.buffers
    const lines: CapturedLine[] = []

    const CHAR_FLAG_CONTINUATION = 0xc0000000 | 0
    const CHAR_FLAG_MASK = 0xc0000000 | 0

    const realTextBytes = this.getRealCharBytes(true)
    const realTextLines = new TextDecoder().decode(realTextBytes).split("\n")

    for (let y = 0; y < this._height; y++) {
      const spans: CapturedSpan[] = []
      let currentSpan: CapturedSpan | null = null

      const lineChars = [...(realTextLines[y] || "")]
      let charIdx = 0

      for (let x = 0; x < this._width; x++) {
        const i = y * this._width + x
        const cp = char[i]
        const cellFg = RGBA.fromArray(fg.slice(i * 4, i * 4 + 4))
        const cellBg = RGBA.fromArray(bg.slice(i * 4, i * 4 + 4))
        const cellAttrs = attributes[i] & 0xff

        // Continuation cells are placeholders for wide characters (emojis, CJK)
        const isContinuation = (cp & CHAR_FLAG_MASK) === CHAR_FLAG_CONTINUATION
        const cellChar = isContinuation ? "" : (lineChars[charIdx++] ?? " ")

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
  }

  public clear(bg: RGBA = RGBA.fromValues(0, 0, 0, 1)): void {
    this.guard()
    this.lib.bufferClear(this.bufferPtr, bg)
  }

  public setCell(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number = 0): void {
    this.guard()
    this.lib.bufferSetCell(this.bufferPtr, x, y, char, fg, bg, attributes)
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
    this.lib.bufferSetCellWithAlphaBlending(this.bufferPtr, x, y, char, fg, bg, attributes)
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
      this.lib.bufferDrawText(this.bufferPtr, text, x, y, fg, bg, attributes)
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
      this.lib.bufferDrawText(this.bufferPtr, beforeText, x, y, fg, bg, attributes)
    }

    if (end > start) {
      const selectedText = text.slice(start, end)
      this.lib.bufferDrawText(this.bufferPtr, selectedText, x + start, y, selectionFg, selectionBg, attributes)
    }

    if (end < text.length) {
      const afterText = text.slice(end)
      this.lib.bufferDrawText(this.bufferPtr, afterText, x + end, y, fg, bg, attributes)
    }
  }

  public fillRect(x: number, y: number, width: number, height: number, bg: RGBA): void {
    this.guard()
    this.lib.bufferFillRect(this.bufferPtr, x, y, width, height, bg)
  }

  public colorMatrix(
    matrix: Float32Array,
    cellMask: Float32Array,
    strength: number = 1.0,
    target: TargetChannel = TargetChannel.Both,
  ): void {
    this.guard()
    if (matrix.length !== 16) throw new RangeError(`colorMatrix matrix must have length 16, got ${matrix.length}`)
    const cellMaskCount = Math.floor(cellMask.length / 3)
    this.lib.bufferColorMatrix(this.bufferPtr, ptr(matrix), ptr(cellMask), cellMaskCount, strength, target)
  }

  public colorMatrixUniform(
    matrix: Float32Array,
    strength: number = 1.0,
    target: TargetChannel = TargetChannel.Both,
  ): void {
    this.guard()
    if (matrix.length !== 16)
      throw new RangeError(`colorMatrixUniform matrix must have length 16, got ${matrix.length}`)
    if (strength === 0.0) return
    this.lib.bufferColorMatrixUniform(this.bufferPtr, ptr(matrix), strength, target)
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
    this.lib.drawFrameBuffer(this.bufferPtr, destX, destY, frameBuffer.ptr, sourceX, sourceY, sourceWidth, sourceHeight)
  }

  public destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    // Cached typed arrays alias native memory and are invalid after destroy.
    this._rawBuffers = null
    this.lib.destroyOptimizedBuffer(this.bufferPtr)
  }

  public drawTextBuffer(textBufferView: TextBufferView, x: number, y: number): void {
    this.guard()
    this.lib.bufferDrawTextBufferView(this.bufferPtr, textBufferView.ptr, x, y)
  }

  public drawEditorView(editorView: EditorView, x: number, y: number): void {
    this.guard()
    this.lib.bufferDrawEditorView(this.bufferPtr, editorView.ptr, x, y)
  }

  public drawSuperSampleBuffer(
    x: number,
    y: number,
    pixelDataPtr: PointerInput,
    pixelDataLength: number,
    format: "bgra8unorm" | "rgba8unorm",
    alignedBytesPerRow: number,
  ): void {
    this.guard()
    this.lib.bufferDrawSuperSampleBuffer(
      this.bufferPtr,
      x,
      y,
      toPointer(pixelDataPtr),
      pixelDataLength,
      format,
      alignedBytesPerRow,
    )
  }

  public drawPackedBuffer(
    dataPtr: PointerInput,
    dataLen: number,
    posX: number,
    posY: number,
    terminalWidthCells: number,
    terminalHeightCells: number,
  ): void {
    this.guard()
    this.lib.bufferDrawPackedBuffer(
      this.bufferPtr,
      toPointer(dataPtr),
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
    this.lib.bufferDrawGrayscaleBuffer(this.bufferPtr, posX, posY, ptr(intensities), srcWidth, srcHeight, fg, bg)
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
    this.lib.bufferDrawGrayscaleBufferSupersampled(
      this.bufferPtr,
      posX,
      posY,
      ptr(intensities),
      srcWidth,
      srcHeight,
      fg,
      bg,
    )
  }

  public resize(width: number, height: number): void {
    this.guard()
    if (this._width === width && this._height === height) return

    this._width = width
    this._height = height
    this._rawBuffers = null

    this.lib.bufferResize(this.bufferPtr, width, height)
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

    this.lib.bufferDrawBox(
      this.bufferPtr,
      options.x,
      options.y,
      options.width,
      options.height,
      borderChars,
      packedOptions,
      options.borderColor,
      options.backgroundColor,
      options.titleColor ?? options.borderColor,
      options.title ?? null,
      options.bottomTitle ?? null,
    )
  }

  public pushScissorRect(x: number, y: number, width: number, height: number): void {
    this.guard()
    this.lib.bufferPushScissorRect(this.bufferPtr, x, y, width, height)
  }

  public popScissorRect(): void {
    this.guard()
    this.lib.bufferPopScissorRect(this.bufferPtr)
  }

  public clearScissorRects(): void {
    this.guard()
    this.lib.bufferClearScissorRects(this.bufferPtr)
  }

  public pushOpacity(opacity: number): void {
    this.guard()
    this.lib.bufferPushOpacity(this.bufferPtr, Math.max(0, Math.min(1, opacity)))
  }

  public popOpacity(): void {
    this.guard()
    this.lib.bufferPopOpacity(this.bufferPtr)
  }

  public getCurrentOpacity(): number {
    this.guard()
    return this.lib.bufferGetCurrentOpacity(this.bufferPtr)
  }

  public clearOpacity(): void {
    this.guard()
    this.lib.bufferClearOpacity(this.bufferPtr)
  }

  public encodeUnicode(text: string): { ptr: Pointer; data: Array<{ width: number; char: number }> } | null {
    this.guard()
    return this.lib.encodeUnicode(text, this._widthMethod)
  }

  public freeUnicode(encoded: { ptr: Pointer; data: Array<{ width: number; char: number }> }): void {
    this.guard()
    this.lib.freeUnicode(encoded)
  }

  public drawGrid(options: {
    borderChars: Uint32Array
    borderFg: RGBA
    borderBg: RGBA
    columnOffsets: Int32Array
    rowOffsets: Int32Array
    drawInner: boolean
    drawOuter: boolean
  }): void {
    this.guard()

    const columnCount = Math.max(0, options.columnOffsets.length - 1)
    const rowCount = Math.max(0, options.rowOffsets.length - 1)

    this.lib.bufferDrawGrid(
      this.bufferPtr,
      options.borderChars,
      options.borderFg,
      options.borderBg,
      options.columnOffsets,
      columnCount,
      options.rowOffsets,
      rowCount,
      {
        drawInner: options.drawInner,
        drawOuter: options.drawOuter,
      },
    )
  }

  public drawChar(char: number, x: number, y: number, fg: RGBA, bg: RGBA, attributes: number = 0): void {
    this.guard()
    this.lib.bufferDrawChar(this.bufferPtr, char, x, y, fg, bg, attributes)
  }
}
