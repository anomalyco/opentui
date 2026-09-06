import { RGBA } from "./lib/RGBA.js"
import {
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
} from "./zig.js"
import type { EditBuffer } from "./edit-buffer.js"
import type { NativeResourceOwner } from "./buffer.js"
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
  private native: { scene: NativeResourceOwner; handle: ContextEditorViewHandle }
  private editBuffer: EditBuffer
  private _destroyed: boolean = false
  private _extmarksController?: any

  constructor(lib: RenderLib, handle: ContextEditorViewHandle, editBuffer: EditBuffer, scene: NativeResourceOwner) {
    if (!scene?.driver) throw new Error("EditorView requires an explicit resource owner")
    scene.assertAlive()
    const owner = editBuffer._getOwner()
    if (owner.lib !== lib) throw new Error("EditorView library owner mismatch")
    if (owner.scene !== scene || !handle || typeof handle !== "object" || handle.context !== scene.driver.context) {
      throw new Error("EditorView Context owner mismatch")
    }
    this.lib = lib
    this.native = { scene, handle }
    this.editBuffer = editBuffer
  }

  static create(editBuffer: EditBuffer, viewportWidth: number, viewportHeight: number): EditorView {
    const { lib, scene } = editBuffer._getOwner()
    const handle = lib.createContextEditorView(
      scene.driver.context,
      editBuffer._getSceneHandle(scene),
      viewportWidth,
      viewportHeight,
    )
    try {
      return new EditorView(lib, handle, editBuffer, scene)
    } catch (error) {
      lib.destroyContextEditorView(scene.driver.context, handle)
      throw error
    }
  }

  private guard(): void {
    if (this._destroyed) throw new Error("EditorView is destroyed")
    this.native.scene.assertAlive()
    this.editBuffer._getOwner()
  }

  /** @internal Drawing targets must use the view's library and Context. */
  public _getOwner(): { lib: RenderLib; scene: NativeResourceOwner } {
    this.guard()
    return { lib: this.lib, scene: this.native.scene }
  }

  /** @internal Requires the exact resource owner. */
  public _getSceneHandle(scene: NativeResourceOwner): ContextEditorViewHandle {
    this.guard()
    if (this.native.scene !== scene) throw new Error("EditorView Context owner mismatch")
    return this.native.handle
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
    this.guard()
    return this.lib.contextEditorViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditorCommand.WrapMode,
      mode === "none" ? 0 : mode === "char" ? 1 : 2,
    )
  }

  public getVirtualLineCount(): number {
    this.guard()
    return this.lib.contextEditorViewGetInfo(this.native.handle.context, this.native.handle, true).virtualLineCount
  }

  public getTotalVirtualLineCount(): number {
    this.guard()
    return this.lib.contextEditorViewGetInfo(this.native.handle.context, this.native.handle).totalVirtualLineCount
  }

  public setSelection(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Set,
      start,
      end,
      bg: bgColor,
      fg: fgColor,
    })
  }

  public updateSelection(end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Update,
      end,
      bg: bgColor,
      fg: fgColor,
    })
  }

  public resetSelection(): void {
    this.guard()
    this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Reset,
    })
  }

  public getSelection(): { start: number; end: number } | null {
    this.guard()
    return this.lib.contextEditorViewGetSelection(this.native.handle.context, this.native.handle).selection
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
    behavior: SelectionBehavior = "cell",
  ): boolean {
    this.guard()
    return this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, {
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
    this.guard()
    return this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, {
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
    this.guard()
    this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.LocalReset,
    })
  }

  public convertSelectionToCell(): boolean {
    this.guard()
    return this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Cell,
    })
  }

  public setSelectionOccupancy(occupancy: SelectionOccupancy): void {
    this.guard()
    this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Occupancy,
      behavior: occupancy === "boundary" ? 1 : 0,
    })
  }

  public getSelectionOccupancy(): SelectionOccupancy {
    this.guard()
    return this.lib.contextEditorViewGetSelection(this.native.handle.context, this.native.handle).selectionOccupancy
  }

  public setSelectionInclusive(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Inclusive,
      start,
      end,
      bg: bgColor,
      fg: fgColor,
    })
  }

  public setSelectionColors(bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.contextEditorViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Colors,
      bg: bgColor,
      fg: fgColor,
    })
  }

  public getSelectedText(): string {
    this.guard()
    return this.lib.contextEditorViewGetSelectedText(this.native.handle.context, this.native.handle)
  }

  public getCursor(): { row: number; col: number } {
    this.guard()
    const { row, col } = this.editBuffer.getCursorPosition()
    return { row, col }
  }

  public getText(): string {
    this.guard()
    return this.editBuffer.getText()
  }

  public getVisualCursor(): VisualCursor {
    this.guard()
    return this.lib.contextEditorViewGetPosition(
      this.native.handle.context,
      this.native.handle,
      NativeEditorPositionQuery.Cursor,
    )
  }

  public moveUpVisual(): void {
    this.guard()
    return this.lib.contextEditorViewCommand(this.native.handle.context, this.native.handle, NativeEditorCommand.MoveUp)
  }

  public moveDownVisual(): void {
    this.guard()
    return this.lib.contextEditorViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditorCommand.MoveDown,
    )
  }

  public deleteSelectedText(): void {
    this.guard()
    return this.lib.contextEditorViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditorCommand.DeleteSelection,
    )
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

  public setCursorByOffset(offset: number): void {
    this.guard()
    return this.lib.contextEditorViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditorCommand.CursorOffset,
      offset,
    )
  }

  public getNextWordBoundary(): VisualCursor {
    this.guard()
    return this.lib.contextEditorViewGetPosition(
      this.native.handle.context,
      this.native.handle,
      NativeEditorPositionQuery.NextWord,
    )
  }

  public getPrevWordBoundary(): VisualCursor {
    this.guard()
    return this.lib.contextEditorViewGetPosition(
      this.native.handle.context,
      this.native.handle,
      NativeEditorPositionQuery.PrevWord,
    )
  }

  public getEOL(): VisualCursor {
    this.guard()
    return this.lib.contextEditorViewGetPosition(
      this.native.handle.context,
      this.native.handle,
      NativeEditorPositionQuery.Eol,
    )
  }

  public getVisualSOL(): VisualCursor {
    this.guard()
    return this.lib.contextEditorViewGetPosition(
      this.native.handle.context,
      this.native.handle,
      NativeEditorPositionQuery.VisualSol,
    )
  }

  public getVisualEOL(): VisualCursor {
    this.guard()
    return this.lib.contextEditorViewGetPosition(
      this.native.handle.context,
      this.native.handle,
      NativeEditorPositionQuery.VisualEol,
    )
  }

  public gotoVisualLineEnd(): void {
    this.guard()
    return this.lib.contextEditorViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditorCommand.GotoLineEnd,
    )
  }

  public getLineInfo(): LineInfo {
    this.guard()
    return this.lib.contextEditorViewGetLines(this.native.handle.context, this.native.handle, false)
  }

  public getLogicalLineInfo(): LineInfo {
    this.guard()
    return this.lib.contextEditorViewGetLines(this.native.handle.context, this.native.handle, true)
  }

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
    this.guard()
    const codePoint = typeof indicator === "string" ? (indicator.codePointAt(0) ?? 0) : indicator
    return this.lib.contextEditorViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditorCommand.TabIndicator,
      codePoint,
    )
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
      if (!this.native.scene.driver.contextDisposed) {
        try {
          this.lib.destroyContextEditorView(this.native.handle.context, this.native.handle)
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
