import { RGBA } from "./lib/RGBA.js"
import {
  NativeEditorSelectionOperation,
  NativeTextViewCommand,
  NativeError,
  NativeStatus,
  type LineInfo,
  type MeasureResult,
  type RenderLib,
  type ContextTextBufferViewHandle,
  type NativeEditorSelection,
} from "./zig.js"
import type { TextBuffer } from "./text-buffer.js"
import type { NativeResourceOwner, ResourceContext } from "./buffer.js"
import type { SelectionBehavior, SelectionOccupancy } from "./types.js"

export class TextBufferView {
  private lib: RenderLib
  private native: { owner: ResourceContext; handle: ContextTextBufferViewHandle }
  private textBuffer: TextBuffer
  private _destroyed: boolean = false
  // Only these selection calls change a text view's selection, and resetting a clear one does
  // nothing, so resets skip the native call until a selection call may have set one.
  private selectionClear = true

  constructor(
    lib: RenderLib,
    handle: ContextTextBufferViewHandle,
    textBuffer: TextBuffer,
    source: NativeResourceOwner,
  ) {
    const owner = source?.resourceContext
    if (!owner) throw new Error("TextBufferView requires an explicit resource owner")
    owner.assertAlive()
    if (owner.renderLib !== lib) throw new Error("TextBufferView library owner mismatch")
    if (textBuffer._getOwner() !== owner || !handle || typeof handle !== "object" || handle.context !== owner.context) {
      throw new Error("TextBufferView Context owner mismatch")
    }
    this.lib = lib
    this.native = { owner, handle }
    this.textBuffer = textBuffer
  }

  static create(textBuffer: TextBuffer): TextBufferView {
    const owner = textBuffer._getOwner()
    const lib = owner.renderLib
    const handle = lib.createContextTextBufferView(owner.context, textBuffer._getSceneHandle(owner))
    try {
      return new TextBufferView(lib, handle, textBuffer, owner)
    } catch (error) {
      lib.destroyContextTextBufferView(owner.context, handle)
      throw error
    }
  }

  // Fail loud and clear
  private guard(): void {
    if (this._destroyed) throw new Error("TextBufferView is destroyed")
    this.native.owner.assertAlive()
    this.textBuffer._getSceneHandle(this.native.owner)
  }

  /** @internal Drawing targets must use the view's library and Context. */
  public _getOwner(): ResourceContext {
    this.guard()
    return this.native.owner
  }

  /** @internal Resources can be shared by scenes in the same Context. */
  public _getSceneHandle(scene: NativeResourceOwner): ContextTextBufferViewHandle {
    this.guard()
    if (this.native.owner !== scene.resourceContext) throw new Error("TextBufferView Context owner mismatch")
    return this.native.handle
  }

  private select(selection: NativeEditorSelection): boolean {
    this.guard()
    this.selectionClear = false
    return this.lib.contextTextBufferViewSelect(this.native.handle.context, this.native.handle, selection)
  }

  private reset(local: boolean): void {
    this.guard()
    const { context } = this.native.handle
    this.lib.contextTextBufferViewResetSelection(context, this.native.handle, local, this.selectionClear)
    this.selectionClear = true
  }

  public setSelection(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.select({ operation: NativeEditorSelectionOperation.Set, start, end, bg: bgColor, fg: fgColor })
  }

  public updateSelection(end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.select({ operation: NativeEditorSelectionOperation.Update, end, bg: bgColor, fg: fgColor })
  }

  public resetSelection(): void {
    this.reset(false)
  }

  public getSelection(): { start: number; end: number } | null {
    this.guard()
    return this.lib.contextTextBufferViewGetInfo(this.native.handle.context, this.native.handle).selection
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
      behavior: behavior === "cell" ? 0 : behavior === "word" ? 1 : 2,
    })
  }

  public resetLocalSelection(): void {
    this.reset(true)
  }

  public setSelectionOccupancy(occupancy: SelectionOccupancy): void {
    this.guard()
    this.lib.contextTextBufferViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Occupancy,
      behavior: occupancy === "boundary" ? 1 : 0,
    })
  }

  public getSelectionOccupancy(): SelectionOccupancy {
    this.guard()
    return this.lib.contextTextBufferViewGetInfo(this.native.handle.context, this.native.handle).selectionOccupancy
  }

  private command(command: NativeTextViewCommand, argument: number): void {
    this.guard()
    this.lib.contextTextBufferViewCommand(this.native.handle.context, this.native.handle, command, argument)
  }

  public setWrapWidth(width: number | null): void {
    this.command(NativeTextViewCommand.WrapWidth, width ?? 0)
  }

  public setWrapMode(mode: "none" | "char" | "word"): void {
    this.command(NativeTextViewCommand.WrapMode, mode === "none" ? 0 : mode === "char" ? 1 : 2)
  }

  public setTextAlign(alignment: "left" | "center" | "right"): void {
    this.command(NativeTextViewCommand.TextAlign, alignment === "left" ? 0 : alignment === "center" ? 1 : 2)
  }

  public setFirstLineOffset(offset: number): void {
    this.command(NativeTextViewCommand.FirstLineOffset, offset)
  }

  public setViewportSize(width: number, height: number): void {
    this.guard()
    return this.lib.contextTextBufferViewSetViewport(
      this.native.handle.context,
      this.native.handle,
      { x: 0, y: 0, width, height },
      true,
    )
  }

  public setViewport(x: number, y: number, width: number, height: number): void {
    this.guard()
    return this.lib.contextTextBufferViewSetViewport(this.native.handle.context, this.native.handle, {
      x,
      y,
      width,
      height,
    })
  }

  public get lineInfo(): LineInfo {
    this.guard()
    return this.lib.contextTextBufferViewGetLines(this.native.handle.context, this.native.handle)
  }

  public get logicalLineInfo(): LineInfo {
    this.guard()
    return this.lib.contextTextBufferViewGetLines(this.native.handle.context, this.native.handle, true)
  }

  public getLineSources(startLine: number, lineCount: number): number[] {
    this.guard()
    const { context } = this.native.handle
    return this.lib.contextTextBufferViewGetLines(context, this.native.handle, true, startLine, lineCount).lineSources
  }

  public getSelectedText(): string {
    this.guard()
    return this.lib.contextTextBufferViewGetSelectedText(this.native.handle.context, this.native.handle)
  }

  public getPlainText(): string {
    this.guard()
    return this.textBuffer.getPlainText()
  }

  public setTabIndicator(indicator: string | number): void {
    const codePoint = typeof indicator === "string" ? (indicator.codePointAt(0) ?? 0) : indicator
    this.command(NativeTextViewCommand.TabIndicator, codePoint)
  }

  public setTabIndicatorColor(color: RGBA): void {
    this.guard()
    return this.lib.contextTextBufferViewSetTabColor(this.native.handle.context, this.native.handle, color)
  }

  public setTruncate(truncate: boolean): void {
    this.command(NativeTextViewCommand.Truncate, truncate ? 1 : 0)
  }

  public measureForDimensions(width: number, height: number): MeasureResult | null {
    this.guard()
    return this.lib.contextTextBufferViewMeasure(this.native.handle.context, this.native.handle, width, height)
  }

  public getVirtualLineCount(): number {
    this.guard()
    return this.lib.contextTextBufferViewGetInfo(this.native.handle.context, this.native.handle).virtualLineCount
  }

  public destroy(): void {
    if (this._destroyed) return
    this.lib.getYogaHost().runMutation(() => {
      if (!this.native.owner.disposed) {
        try {
          this.lib.releaseAfterPaint(this.native.handle.context, () =>
            this.lib.destroyContextTextBufferView(this.native.handle.context, this.native.handle),
          )
        } catch (error) {
          if (!(error instanceof NativeError) || error.status !== NativeStatus.StaleHandle) throw error
        }
      }
      this._destroyed = true
    })
  }
}
