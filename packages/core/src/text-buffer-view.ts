import { RGBA } from "./lib/RGBA"
import { resolveRenderLib, type LineInfo, type RenderLib } from "./zig"
import { type Pointer } from "bun:ffi"
import type { TextBuffer } from "./text-buffer"

export class TextBufferView {
  private lib: RenderLib
  private viewPtr: Pointer
  private textBuffer: TextBuffer
  private _destroyed: boolean = false

  private _measureCache: Map<number, { lineCount: number; maxWidth: number }> = new Map()
  private _measureCacheVersion: number = -1

  constructor(lib: RenderLib, ptr: Pointer, textBuffer: TextBuffer) {
    this.lib = lib
    this.viewPtr = ptr
    this.textBuffer = textBuffer
  }

  static create(textBuffer: TextBuffer): TextBufferView {
    const lib = resolveRenderLib()
    const viewPtr = lib.createTextBufferView(textBuffer.ptr)
    return new TextBufferView(lib, viewPtr, textBuffer)
  }

  // Fail loud and clear
  private guard(): void {
    if (this._destroyed) throw new Error("TextBufferView is destroyed")
  }

  public get ptr(): Pointer {
    this.guard()
    return this.viewPtr
  }

  public setSelection(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.textBufferViewSetSelection(this.viewPtr, start, end, bgColor || null, fgColor || null)
  }

  public updateSelection(end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.textBufferViewUpdateSelection(this.viewPtr, end, bgColor || null, fgColor || null)
  }

  public resetSelection(): void {
    this.guard()
    this.lib.textBufferViewResetSelection(this.viewPtr)
  }

  public getSelection(): { start: number; end: number } | null {
    this.guard()
    return this.lib.textBufferViewGetSelection(this.viewPtr)
  }

  public hasSelection(): boolean {
    this.guard()
    return this.getSelection() !== null
  }

  public setLocalSelection(
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor?: RGBA,
    fgColor?: RGBA,
  ): boolean {
    this.guard()
    return this.lib.textBufferViewSetLocalSelection(
      this.viewPtr,
      anchorX,
      anchorY,
      focusX,
      focusY,
      bgColor || null,
      fgColor || null,
    )
  }

  public updateLocalSelection(
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor?: RGBA,
    fgColor?: RGBA,
  ): boolean {
    this.guard()
    return this.lib.textBufferViewUpdateLocalSelection(
      this.viewPtr,
      anchorX,
      anchorY,
      focusX,
      focusY,
      bgColor || null,
      fgColor || null,
    )
  }

  public resetLocalSelection(): void {
    this.guard()
    this.lib.textBufferViewResetLocalSelection(this.viewPtr)
  }

  public setWrapWidth(width: number | null): void {
    this.guard()
    this._measureCache.clear()
    this.lib.textBufferViewSetWrapWidth(this.viewPtr, width ?? 0)
  }

  public setWrapMode(mode: "none" | "char" | "word"): void {
    this.guard()
    this._measureCache.clear()
    this.lib.textBufferViewSetWrapMode(this.viewPtr, mode)
  }

  public setViewportSize(width: number, height: number): void {
    this.guard()
    this._measureCache.clear()
    this.lib.textBufferViewSetViewportSize(this.viewPtr, width, height)
  }

  public setViewport(x: number, y: number, width: number, height: number): void {
    this.guard()
    this._measureCache.clear()
    this.lib.textBufferViewSetViewport(this.viewPtr, x, y, width, height)
  }

  public get lineInfo(): LineInfo {
    this.guard()
    return this.lib.textBufferViewGetLineInfo(this.viewPtr)
  }

  public get logicalLineInfo(): LineInfo {
    this.guard()
    return this.lib.textBufferViewGetLogicalLineInfo(this.viewPtr)
  }

  public getSelectedText(): string {
    this.guard()
    const byteSize = this.textBuffer.byteSize
    if (byteSize === 0) return ""

    const selectedBytes = this.lib.textBufferViewGetSelectedTextBytes(this.viewPtr, byteSize)

    if (!selectedBytes) return ""

    return this.lib.decoder.decode(selectedBytes)
  }

  public getPlainText(): string {
    this.guard()
    const byteSize = this.textBuffer.byteSize
    if (byteSize === 0) return ""

    const plainBytes = this.lib.textBufferViewGetPlainTextBytes(this.viewPtr, byteSize)

    if (!plainBytes) return ""

    return this.lib.decoder.decode(plainBytes)
  }

  public setTabIndicator(indicator: string | number): void {
    this.guard()
    const codePoint = typeof indicator === "string" ? (indicator.codePointAt(0) ?? 0) : indicator
    this.lib.textBufferViewSetTabIndicator(this.viewPtr, codePoint)
  }

  public setTabIndicatorColor(color: RGBA): void {
    this.guard()
    this.lib.textBufferViewSetTabIndicatorColor(this.viewPtr, color)
  }

  public measureForDimensions(width: number, height: number): { lineCount: number; maxWidth: number } | null {
    this.guard()

    const flooredWidth = Math.floor(width)
    const version = this.textBuffer.version
    if (version !== this._measureCacheVersion) {
      this._measureCache.clear()
      this._measureCacheVersion = version
    }

    const cached = this._measureCache.get(flooredWidth)
    if (cached) {
      return cached
    }

    const result = this.lib.textBufferViewMeasureForDimensions(this.viewPtr, flooredWidth, Math.floor(height))
    if (result) {
      this._measureCache.set(flooredWidth, result)
    }

    return result
  }

  public getVirtualLineCount(): number {
    this.guard()
    return this.lib.textBufferViewGetVirtualLineCount(this.viewPtr)
  }

  public destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    this.lib.destroyTextBufferView(this.viewPtr)
  }
}
