import { RGBA } from "./lib/RGBA.js"
import {
  NativeEditAtomic,
  NativeEditorCommand,
  NativeEditorPositionQuery,
  NativeEditorSelectionOperation,
  NativeError,
  NativeStatus,
  type ContextEditorViewHandle,
  type RenderLib,
  type VisualCursor,
  type LineInfo,
  type NativeEditorReplacement,
  type NativeEditorSelection,
} from "./zig.js"
import type { EditBuffer } from "./edit-buffer.js"
import type { NativeResourceOwner, ResourceContext } from "./buffer.js"
import { createExtmarksController } from "./lib/index.js"
import { StyledText } from "./lib/styled-text.js"
import type { SelectionBehavior, SelectionOccupancy } from "./types.js"

export interface Viewport {
  offsetY: number
  offsetX: number
  height: number
  width: number
}

export type { VisualCursor }

export class EditorView {
  private lib: RenderLib
  private native: { owner: ResourceContext; handle: ContextEditorViewHandle }
  private editBuffer: EditBuffer
  private _destroyed: boolean = false
  private _extmarksController?: any

  constructor(lib: RenderLib, handle: ContextEditorViewHandle, editBuffer: EditBuffer, source: NativeResourceOwner) {
    const owner = source?.resourceContext
    if (!owner) throw new Error("EditorView requires an explicit resource owner")
    owner.assertAlive()
    if (owner.renderLib !== lib) throw new Error("EditorView library owner mismatch")
    if (editBuffer._getOwner() !== owner || !handle || typeof handle !== "object" || handle.context !== owner.context) {
      throw new Error("EditorView Context owner mismatch")
    }
    this.lib = lib
    this.native = { owner, handle }
    this.editBuffer = editBuffer
  }

  static create(editBuffer: EditBuffer, viewportWidth: number, viewportHeight: number): EditorView {
    const owner = editBuffer._getOwner()
    const lib = owner.renderLib
    const handle = lib.createContextEditorView(
      owner.context,
      editBuffer._getSceneHandle(owner),
      viewportWidth,
      viewportHeight,
    )
    try {
      return new EditorView(lib, handle, editBuffer, owner)
    } catch (error) {
      lib.destroyContextEditorView(owner.context, handle)
      throw error
    }
  }

  public get isDestroyed(): boolean {
    return this._destroyed
  }

  private guard(): void {
    if (this._destroyed) throw new Error("EditorView is destroyed")
    this.native.owner.assertAlive()
    this.editBuffer._getOwner()
  }

  /** @internal Drawing targets must use the view's library and Context. */
  public _getOwner(): ResourceContext {
    this.guard()
    return this.native.owner
  }

  /** @internal Resources can be shared by scenes in the same Context. */
  public _getSceneHandle(scene: NativeResourceOwner): ContextEditorViewHandle {
    this.guard()
    if (this.native.owner !== scene.resourceContext) throw new Error("EditorView Context owner mismatch")
    return this.native.handle
  }

  private command(command: NativeEditorCommand, argument?: number): void {
    this.guard()
    this.lib.contextEditorViewCommand(this.native.handle.context, this.native.handle, command, argument)
  }

  private position(query: NativeEditorPositionQuery): VisualCursor {
    this.guard()
    return this.lib.contextEditorViewGetPosition(this.native.handle.context, this.native.handle, query)
  }

  private select(selection: NativeEditorSelection): boolean {
    this.guard()
    return this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, selection)
  }

  public setViewportSize(width: number, height: number): void {
    this.guard()
    return this.lib.contextEditorViewSetViewport(
      this.native.handle.context,
      this.native.handle,
      { x: 0, y: 0, width, height },
      true,
    )
  }

  public setViewport(x: number, y: number, width: number, height: number, moveCursor: boolean = true): void {
    this.guard()
    return this.lib.contextEditorViewSetViewport(
      this.native.handle.context,
      this.native.handle,
      { x, y, width, height },
      false,
      moveCursor,
    )
  }

  public getViewport(): Viewport {
    this.guard()
    const { x, y, width, height } = this.lib.contextEditorViewGetViewport(
      this.native.handle.context,
      this.native.handle,
    )
    return { offsetX: x, offsetY: y, width, height }
  }

  public setScrollMargin(margin: number): void {
    this.guard()
    return this.lib.contextEditorViewSetScrollMargin(this.native.handle.context, this.native.handle, margin)
  }

  public setWrapMode(mode: "none" | "char" | "word"): void {
    this.command(NativeEditorCommand.WrapMode, mode === "none" ? 0 : mode === "char" ? 1 : 2)
  }

  public getVirtualLineCount(): number {
    this.guard()
    return this.lib.contextEditorViewGetInfo(this.native.handle.context, this.native.handle, true).virtualLineCount
  }

  public getTotalVirtualLineCount(): number {
    this.guard()
    return this.lib.contextEditorViewGetInfo(this.native.handle.context, this.native.handle).totalVirtualLineCount
  }

  /** Selects [start, end) in document display cells, counting each newline as one. */
  public setSelection(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.select({ operation: NativeEditorSelectionOperation.Set, start, end, bg: bgColor, fg: fgColor })
  }

  /** Sets the exclusive end in document display cells, counting each newline as one. */
  public updateSelection(end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.select({ operation: NativeEditorSelectionOperation.Update, end, bg: bgColor, fg: fgColor })
  }

  public resetSelection(): void {
    this.select({ operation: NativeEditorSelectionOperation.Reset })
  }

  /** Returns half-open bounds in document display cells, counting each newline as one. */
  public getSelection(): { start: number; end: number } | null {
    this.guard()
    return this.lib.contextEditorViewGetSelection(this.native.handle.context, this.native.handle).selection
  }

  public hasSelection(): boolean {
    return this.getSelection() !== null
  }

  /** Selects between viewport-local positions: x in display cells, y in wrapped rows. */
  public setLocalSelection(
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor?: RGBA,
    fgColor?: RGBA,
    updateCursor?: boolean,
    followCursor?: boolean,
    behavior: SelectionBehavior = "cell",
  ): boolean {
    return this.select({
      operation: NativeEditorSelectionOperation.Local,
      anchorX,
      anchorY,
      focusX,
      focusY,
      bg: bgColor,
      fg: fgColor,
      updateCursor,
      followCursor,
      behavior: behavior === "cell" ? 0 : behavior === "word" ? 1 : 2,
    })
  }

  /** Updates the selection between viewport-local cell columns and wrapped rows. */
  public updateLocalSelection(
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor?: RGBA,
    fgColor?: RGBA,
    updateCursor?: boolean,
    followCursor?: boolean,
    behavior: SelectionBehavior = "cell",
  ): boolean {
    return this.select({
      operation: NativeEditorSelectionOperation.LocalUpdate,
      anchorX,
      anchorY,
      focusX,
      focusY,
      bg: bgColor,
      fg: fgColor,
      updateCursor,
      followCursor,
      behavior: behavior === "cell" ? 0 : behavior === "word" ? 1 : 2,
    })
  }

  public resetLocalSelection(): void {
    this.select({ operation: NativeEditorSelectionOperation.LocalReset })
  }

  public convertSelectionToCell(): boolean {
    return this.select({ operation: NativeEditorSelectionOperation.Cell })
  }

  public setSelectionOccupancy(occupancy: SelectionOccupancy): void {
    this.select({
      operation: NativeEditorSelectionOperation.Occupancy,
      behavior: occupancy === "boundary" ? 1 : 0,
    })
  }

  public getSelectionOccupancy(): SelectionOccupancy {
    this.guard()
    return this.lib.contextEditorViewGetSelection(this.native.handle.context, this.native.handle).selectionOccupancy
  }

  /** Selects document cell offsets (one per newline); cell occupancy includes the grapheme at the larger endpoint. */
  public setSelectionInclusive(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.select({ operation: NativeEditorSelectionOperation.Inclusive, start, end, bg: bgColor, fg: fgColor })
  }

  public setSelectionColors(bgColor?: RGBA, fgColor?: RGBA): void {
    this.select({ operation: NativeEditorSelectionOperation.Colors, bg: bgColor, fg: fgColor })
  }

  /** Returns selected text as a UTF-16-indexed JavaScript string. */
  public getSelectedText(): string {
    this.guard()
    return this.lib.contextEditorViewGetSelectedText(this.native.handle.context, this.native.handle)
  }

  /** Returns the zero-based logical row and display-cell column. */
  public getCursor(): { row: number; col: number } {
    this.guard()
    const { row, col } = this.editBuffer.getCursorPosition()
    return { row, col }
  }

  /** Returns the buffer text as a UTF-16-indexed JavaScript string. */
  public getText(): string {
    this.guard()
    return this.editBuffer.getText()
  }

  /** Returns viewport and logical cell coordinates; the offset counts document cells, one per newline. */
  public getVisualCursor(): VisualCursor {
    return this.position(NativeEditorPositionQuery.Cursor)
  }

  /** @internal Set while an extmarks controller lives: Up and Down apply the cursor rules around virtual extmarks. */
  public _atomic = false

  private rules(): number {
    return this._atomic && !this.hasSelection() ? NativeEditAtomic : 0
  }

  /** Moves the cursor up one wrapped row in the view. */
  public moveUpVisual(): void {
    this.command(NativeEditorCommand.MoveUp, this.rules())
  }

  /** Moves the cursor down one wrapped row in the view. */
  public moveDownVisual(): void {
    this.command(NativeEditorCommand.MoveDown, this.rules())
  }

  public deleteSelectedText(): void {
    this.command(NativeEditorCommand.DeleteSelection)
  }

  /** @internal The native controller replaces a selection in one checked operation. */
  public _replaceSelectedText(text: string): NativeEditorReplacement {
    this.guard()
    return this.lib.contextEditorViewReplaceSelection(
      this.native.handle.context,
      this.native.handle,
      this.lib.encoder.encode(text),
    )
  }

  /** Sets the cursor in document display cells, counting each newline as one. */
  public setCursorByOffset(offset: number): void {
    this.command(NativeEditorCommand.CursorOffset, offset)
  }

  /** Returns the next word boundary in logical and viewport cell coordinates. */
  public getNextWordBoundary(): VisualCursor {
    return this.position(NativeEditorPositionQuery.NextWord)
  }

  /** Returns the previous word boundary in logical and viewport cell coordinates. */
  public getPrevWordBoundary(): VisualCursor {
    return this.position(NativeEditorPositionQuery.PrevWord)
  }

  /** Returns the logical line end in logical and viewport cell coordinates. */
  public getEOL(): VisualCursor {
    return this.position(NativeEditorPositionQuery.Eol)
  }

  /** Returns the wrapped row start in logical and viewport cell coordinates. */
  public getVisualSOL(): VisualCursor {
    return this.position(NativeEditorPositionQuery.VisualSol)
  }

  /** Returns the wrapped row end in logical and viewport cell coordinates. */
  public getVisualEOL(): VisualCursor {
    return this.position(NativeEditorPositionQuery.VisualEol)
  }

  public gotoVisualLineEnd(): void {
    this.command(NativeEditorCommand.GotoLineEnd)
  }

  public getLineInfo(): LineInfo {
    this.guard()
    return this.lib.contextEditorViewGetLines(this.native.handle.context, this.native.handle, false)
  }

  public getLogicalLineInfo(): LineInfo {
    this.guard()
    return this.lib.contextEditorViewGetLines(this.native.handle.context, this.native.handle, true)
  }

  /**
   * @internal A cursor that a wheel step, a pointer or the offset setter left inside virtual extmarks goes to the outer
   * edge of the marks around it: toward the end for a positive `direction`, the start for a negative one, or the nearer
   * edge. Only with an extmarks controller, and not while a selection is left: it holds the cursor at its focus.
   */
  public _keepCursorOutside(direction: number): void {
    if (this.rules()) this.editBuffer._keepOutside(direction)
  }

  /** Marks use half-open document cell ranges, counting each newline as one. */
  public get extmarks(): any {
    this.guard()
    if (!this._extmarksController) {
      this._extmarksController = createExtmarksController(this.editBuffer, this)
    }
    return this._extmarksController
  }

  public setPlaceholderStyledText(chunks: { text: string; fg?: RGBA; bg?: RGBA; attributes?: number }[]): void {
    this.guard()
    return this.lib.contextEditorViewSetPlaceholder(
      this.native.handle.context,
      this.native.handle,
      new StyledText(chunks.map((chunk) => ({ ...chunk, __isChunk: true }))),
    )
  }

  public setTabIndicator(indicator: string | number): void {
    const codePoint = typeof indicator === "string" ? (indicator.codePointAt(0) ?? 0) : indicator
    this.command(NativeEditorCommand.TabIndicator, codePoint)
  }

  public setTabIndicatorColor(color: RGBA): void {
    this.guard()
    return this.lib.contextEditorViewSetTabColor(this.native.handle.context, this.native.handle, color)
  }

  public measureForDimensions(width: number, height: number): { lineCount: number; widthColsMax: number } | null {
    this.guard()
    return this.lib.contextEditorViewMeasure(this.native.handle.context, this.native.handle, width, height)
  }

  public destroy(): void {
    if (this._destroyed) return
    this.lib.getYogaHost().runMutation(() => {
      if (!this.native.owner.disposed) {
        try {
          this.lib.releaseAfterPaint(this.native.handle.context, () =>
            this.lib.destroyContextEditorView(this.native.handle.context, this.native.handle),
          )
        } catch (error) {
          if (!(error instanceof NativeError) || error.status !== NativeStatus.StaleHandle) throw error
        }
      }
      this._destroyed = true
      this._extmarksController?.destroy()
      this._extmarksController = undefined
    })
  }
}
