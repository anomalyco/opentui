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
} from "./zig.js"
import type { TextBuffer } from "./text-buffer.js"
import type { NativeResourceOwner } from "./buffer.js"
import type { SelectionBehavior, SelectionOccupancy } from "./types.js"

export class TextBufferView {
  private lib: RenderLib
  private native: { scene: NativeResourceOwner; handle: ContextTextBufferViewHandle }
  private textBuffer: TextBuffer
  private _destroyed: boolean = false

  constructor(lib: RenderLib, handle: ContextTextBufferViewHandle, textBuffer: TextBuffer, scene: NativeResourceOwner) {
    if (!scene?.driver) throw new Error("TextBufferView requires an explicit resource owner")
    scene.assertAlive()
    const owner = textBuffer._getOwner()
    if (owner.lib !== lib) throw new Error("TextBufferView library owner mismatch")
    if (owner.scene !== scene || !handle || typeof handle !== "object" || handle.context !== scene.driver.context) {
      throw new Error("TextBufferView Context owner mismatch")
    }
    this.lib = lib
    this.native = { scene, handle }
    this.textBuffer = textBuffer
  }

  static create(textBuffer: TextBuffer): TextBufferView {
    const { lib, scene } = textBuffer._getOwner()
    const handle = lib.createContextTextBufferView(scene.driver.context, textBuffer._getSceneHandle(scene))
    try {
      return new TextBufferView(lib, handle, textBuffer, scene)
    } catch (error) {
      lib.destroyContextTextBufferView(scene.driver.context, handle)
      throw error
    }
  }

  // Fail loud and clear
  private guard(): void {
    if (this._destroyed) throw new Error("TextBufferView is destroyed")
    this.native.scene.assertAlive()
    this.textBuffer._getSceneHandle(this.native.scene)
  }

  /** @internal Drawing targets must use the view's library and Context. */
  public _getOwner(): { lib: RenderLib; scene: NativeResourceOwner } {
    this.guard()
    return { lib: this.lib, scene: this.native.scene }
  }

  /** @internal Requires the exact resource owner. */
  public _getSceneHandle(scene: NativeResourceOwner): ContextTextBufferViewHandle {
    this.guard()
    if (this.native.scene !== scene) throw new Error("TextBufferView Context owner mismatch")
    return this.native.handle
  }

  public setSelection(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.contextTextBufferViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Set,
      start,
      end,
      bg: bgColor,
      fg: fgColor,
    })
  }

  public updateSelection(end: number, bgColor?: RGBA, fgColor?: RGBA): void {
    this.guard()
    this.lib.contextTextBufferViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Update,
      end,
      bg: bgColor,
      fg: fgColor,
    })
  }

  public resetSelection(): void {
    this.guard()
    this.lib.contextTextBufferViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.Reset,
    })
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
    this.guard()
    return this.lib.contextTextBufferViewSelect(this.native.handle.context, this.native.handle, {
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
    this.guard()
    return this.lib.contextTextBufferViewSelect(this.native.handle.context, this.native.handle, {
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
    this.guard()
    this.lib.contextTextBufferViewSelect(this.native.handle.context, this.native.handle, {
      operation: NativeEditorSelectionOperation.LocalReset,
    })
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

  public setWrapWidth(width: number | null): void {
    this.guard()
    return this.lib.contextTextBufferViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeTextViewCommand.WrapWidth,
      width ?? 0,
    )
  }

  public setWrapMode(mode: "none" | "char" | "word"): void {
    this.guard()
    return this.lib.contextTextBufferViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeTextViewCommand.WrapMode,
      mode === "none" ? 0 : mode === "char" ? 1 : 2,
    )
  }

  public setFirstLineOffset(offset: number): void {
    this.guard()
    return this.lib.contextTextBufferViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeTextViewCommand.FirstLineOffset,
      offset,
    )
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
    for (const [value, name] of [
      [startLine, "start line"],
      [lineCount, "line count"],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
        throw new RangeError(`${name} must be a u32 integer`)
      }
    }
    return this.logicalLineInfo.lineSources.slice(startLine, startLine + lineCount)
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
    this.guard()
    const codePoint = typeof indicator === "string" ? (indicator.codePointAt(0) ?? 0) : indicator
    return this.lib.contextTextBufferViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeTextViewCommand.TabIndicator,
      codePoint,
    )
  }

  public setTabIndicatorColor(color: RGBA): void {
    this.guard()
    return this.lib.contextTextBufferViewSetTabColor(this.native.handle.context, this.native.handle, color)
  }

  public setTruncate(truncate: boolean): void {
    this.guard()
    return this.lib.contextTextBufferViewCommand(
      this.native.handle.context,
      this.native.handle,
      NativeTextViewCommand.Truncate,
      truncate ? 1 : 0,
    )
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
      if (!this.native.scene.driver.contextDisposed) {
        try {
          this.lib.destroyContextTextBufferView(this.native.handle.context, this.native.handle)
        } catch (error) {
          if (!(error instanceof NativeError) || error.status !== NativeStatus.StaleHandle) throw error
        }
      }
      this._destroyed = true
    })
  }
}
