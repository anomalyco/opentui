import { RGBA } from "./lib/RGBA.js"
import {
  resolveRenderLib,
  type EditorViewHandle,
  type RenderLib,
  type TextBufferViewHandle,
  type VisualCursor,
  type LineInfo,
} from "./zig.js"
import type { EditBuffer } from "./edit-buffer.js"
import { createExtmarksController } from "./lib/index.js"

export interface Viewport {
  offsetY: number
  offsetX: number
  height: number
  width: number
}

export type { VisualCursor }

export class EditorView {
  private lib: RenderLib
  private viewPtr: EditorViewHandle
  private editBuffer: EditBuffer
  private _destroyed: boolean = false
  private _extmarksController?: any
  private _textBufferViewPtr?: TextBufferViewHandle

  constructor(lib: RenderLib, ptr: EditorViewHandle, editBuffer: EditBuffer) {
    this.lib = lib
    this.viewPtr = ptr
    this.editBuffer = editBuffer
  }

  static create(editBuffer: EditBuffer, viewportWidth: number, viewportHeight: number): EditorView {
    const lib = resolveRenderLib()
    const viewPtr = lib.createEditorView(editBuffer.ptr, viewportWidth, viewportHeight)
    return new EditorView(lib, viewPtr, editBuffer)
  }

  private guard(): void {
    if (this._destroyed) throw new Error("EditorView is destroyed")
  }

  public get ptr(): EditorViewHandle {
    this.guard()
    return this.viewPtr
  }

  public setViewportSize(width: number, height: number): void {
    this.guard()
    this.lib.editorViewSetViewportSize(this.viewPtr, width, height)
  }

  public setViewport(x: number, y: number, width: number, height: number, moveCursor: boolean = true): void {
    this.guard()
    this.lib.editorViewSetViewport(this.viewPtr, x, y, width, height, moveCursor)
  }

  public getViewport(): Viewport {
    this.guard()
    return this.lib.editorViewGetViewport(this.viewPtr)
  }

  public setScrollMargin(margin: number): void {
    this.guard()
    this.lib.editorViewSetScrollMargin(this.viewPtr, margin)
  }

  public setWrapMode(mode: "none" | "char" | "word"): void {
    this.guard()
    this.lib.editorViewSetWrapMode(this.viewPtr, mode)
  }

  public getVirtualLineCount(): number {
    this.guard()
    return this.lib.editorViewGetVirtualLineCount(this.viewPtr)
  }

  public getTotalVirtualLineCount(): number {
    this.guard()
    return this.lib.editorViewGetTotalVirtualLineCount(this.viewPtr)
  }

  public setSelection(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.editorViewSetSelection(this.viewPtr, start, end, bgColor || null, fgColor || null)
  }

  public updateSelection(end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.editorViewUpdateSelection(this.viewPtr, end, bgColor || null, fgColor || null)
  }

  public resetSelection(): void {
    this.guard()
    this.lib.editorViewResetSelection(this.viewPtr)
  }

  public getSelection(): { start: number; end: number } | null {
    this.guard()
    return this.lib.editorViewGetSelection(this.viewPtr)
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
    updateCursor?: boolean,
    followCursor?: boolean,
  ): boolean {
    this.guard()
    return this.lib.editorViewSetLocalSelection(
      this.viewPtr,
      anchorX,
      anchorY,
      focusX,
      focusY,
      bgColor || null,
      fgColor || null,
      updateCursor ?? false,
      followCursor ?? false,
    )
  }

  public updateLocalSelection(
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor?: RGBA,
    fgColor?: RGBA,
    updateCursor?: boolean,
    followCursor?: boolean,
  ): boolean {
    this.guard()
    return this.lib.editorViewUpdateLocalSelection(
      this.viewPtr,
      anchorX,
      anchorY,
      focusX,
      focusY,
      bgColor || null,
      fgColor || null,
      updateCursor ?? false,
      followCursor ?? false,
    )
  }

  public resetLocalSelection(): void {
    this.guard()
    this.lib.editorViewResetLocalSelection(this.viewPtr)
  }

  public getSelectedText(): string {
    this.guard()
    // TODO: native can stack alloc all the text and decode will alloc as js string then
    const maxLength = 1024 * 1024 // 1MB should be enough for most selections
    const selectedBytes = this.lib.editorViewGetSelectedTextBytes(this.viewPtr, maxLength)

    if (!selectedBytes) return ""

    return this.lib.decoder.decode(selectedBytes)
  }

  public getCursor(): { row: number; col: number } {
    this.guard()
    return this.lib.editorViewGetCursor(this.viewPtr)
  }

  public getText(): string {
    this.guard()
    const maxLength = 1024 * 1024 // 1MB buffer
    const textBytes = this.lib.editorViewGetText(this.viewPtr, maxLength)
    if (!textBytes) return ""
    return this.lib.decoder.decode(textBytes)
  }

  public getVisualCursor(): VisualCursor {
    this.guard()
    return this.lib.editorViewGetVisualCursor(this.viewPtr)
  }

  public moveUpVisual(): void {
    this.guard()
    this.lib.editorViewMoveUpVisual(this.viewPtr)
  }

  public moveDownVisual(): void {
    this.guard()
    this.lib.editorViewMoveDownVisual(this.viewPtr)
  }

  public deleteSelectedText(): void {
    this.guard()
    this.lib.editorViewDeleteSelectedText(this.viewPtr)
  }

  public setCursorByOffset(offset: number): void {
    this.guard()
    this.lib.editorViewSetCursorByOffset(this.viewPtr, offset)
  }

  public getNextWordBoundary(): VisualCursor {
    this.guard()
    return this.lib.editorViewGetNextWordBoundary(this.viewPtr)
  }

  public getPrevWordBoundary(): VisualCursor {
    this.guard()
    return this.lib.editorViewGetPrevWordBoundary(this.viewPtr)
  }

  public getEOL(): VisualCursor {
    this.guard()
    return this.lib.editorViewGetEOL(this.viewPtr)
  }

  public getVisualSOL(): VisualCursor {
    this.guard()
    return this.lib.editorViewGetVisualSOL(this.viewPtr)
  }

  public getVisualEOL(): VisualCursor {
    this.guard()
    return this.lib.editorViewGetVisualEOL(this.viewPtr)
  }

  public getLineInfo(): LineInfo {
    this.guard()
    return this.lib.editorViewGetLineInfo(this.viewPtr)
  }

  public getLogicalLineInfo(): LineInfo {
    this.guard()
    return this.lib.editorViewGetLogicalLineInfo(this.viewPtr)
  }

  public get extmarks(): any {
    if (!this._extmarksController) {
      this._extmarksController = createExtmarksController(this.editBuffer, this)
    }
    return this._extmarksController
  }

  public setPlaceholderStyledText(chunks: { text: string; fg?: RGBA; bg?: RGBA; attributes?: number }[]): void {
    this.guard()
    this.lib.editorViewSetPlaceholderStyledText(this.viewPtr, chunks)
  }

  public setTabIndicator(indicator: string | number): void {
    this.guard()
    const codePoint = typeof indicator === "string" ? (indicator.codePointAt(0) ?? 0) : indicator
    this.lib.editorViewSetTabIndicator(this.viewPtr, codePoint)
  }

  public setTabIndicatorColor(color: RGBA): void {
    this.guard()
    this.lib.editorViewSetTabIndicatorColor(this.viewPtr, color)
  }

  public measureForDimensions(width: number, height: number): { lineCount: number; widthColsMax: number } | null {
    this.guard()
    if (!this._textBufferViewPtr) {
      this._textBufferViewPtr = this.lib.editorViewGetTextBufferView(this.viewPtr)
    }
    return this.lib.textBufferViewMeasureForDimensions(this._textBufferViewPtr, width, height)
  }

  public destroy(): void {
    if (this._destroyed) return

    if (this._extmarksController) {
      this._extmarksController.destroy()
      this._extmarksController = undefined
    }

    this._destroyed = true
    this.lib.destroyEditorView(this.viewPtr)
  }
}
