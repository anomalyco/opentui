import {
  NativeEditCommand,
  NativeEditPositionQuery,
  NativeEditorStyleMask,
  NativeEditHighlightOperation,
  type LogicalCursor,
  type RenderLib,
  type ContextEditBufferHandle,
} from "./zig.js"
import { type WidthMethod, type Highlight } from "./types.js"
import { RGBA } from "./lib/RGBA.js"
import { EventEmitter } from "events"
import type { SyntaxStyle } from "./syntax-style.js"
import type { NativeResourceOwner } from "./buffer.js"

export type { LogicalCursor }

/**
 * EditBuffer provides a text editing buffer with cursor management,
 * incremental editing, and grapheme-aware operations.
 */
export class EditBuffer extends EventEmitter {
  private lib: RenderLib
  private native: { scene: NativeResourceOwner; handle: ContextEditBufferHandle }
  private unsubscribe?: () => void
  public readonly id: number
  private _destroyed: boolean = false
  private _syntaxStyle?: SyntaxStyle

  constructor(lib: RenderLib, handle: ContextEditBufferHandle, scene: NativeResourceOwner) {
    super()
    if (!scene?.driver) throw new Error("EditBuffer requires an explicit resource owner")
    scene.assertAlive()
    if (
      scene.driver.renderLib !== lib ||
      !handle ||
      typeof handle !== "object" ||
      handle.context !== scene.driver.context
    ) {
      throw new Error("EditBuffer Context owner mismatch")
    }
    this.lib = lib
    this.native = { scene, handle }
    this.id = handle.slot
    this.unsubscribe = lib.onContextEditEvent(handle.context, handle, (name) => {
      if (!this._destroyed && !scene.driver.disposed) this.emit(name)
    })
  }

  static create(widthMethod: WidthMethod, owner: NativeResourceOwner): EditBuffer {
    if (!owner?.driver) throw new Error("EditBuffer requires an explicit resource owner")
    owner.assertAlive()
    const lib = owner.driver.renderLib
    const handle = lib.createContextEditBuffer(owner.driver.context, { widthMethod })
    try {
      return new EditBuffer(lib, handle, owner)
    } catch (error) {
      lib.destroyContextEditBuffer(owner.driver.context, handle)
      throw error
    }
  }

  private guard(): void {
    if (this._destroyed) throw new Error("EditBuffer is destroyed")
    this.native.scene.assertAlive()
  }

  /** @internal Editor views must use the buffer's library and Context. */
  public _getOwner(): { lib: RenderLib; scene: NativeResourceOwner } {
    this.guard()
    return { lib: this.lib, scene: this.native.scene }
  }

  /** @internal Requires the exact resource owner. */
  public _getSceneHandle(scene: NativeResourceOwner): ContextEditBufferHandle {
    this.guard()
    if (this.native.scene !== scene) throw new Error("EditBuffer Context owner mismatch")
    return this.native.handle
  }

  public runMutation<T>(operation: () => T): T {
    this.guard()
    return this.lib.getYogaHost().runMutation(operation)
  }

  private setNativeText(text: string, preserveHistory = false): void {
    const textBytes = this.lib.encoder.encode(text)
    this.lib.contextEditBufferSetText(this.native.handle.context, this.native.handle, textBytes, preserveHistory)
  }

  /**
   * Set text and completely reset the buffer state (clears history, resets add_buffer).
   * Use this for initial text setting or when you want a clean slate.
   */
  public setText(text: string): void {
    this.runMutation(() => this.setNativeText(text))
  }

  /** Historical name for copied text replacement without undo history. */
  public setTextOwned(text: string): void {
    this.guard()
    this.setNativeText(text)
  }

  /**
   * Replace text while preserving undo history (creates an undo point).
   * Use this when you want the setText operation to be undoable.
   */
  public replaceText(text: string): void {
    this.runMutation(() => this.setNativeText(text, true))
  }

  /** Historical name for copied text replacement that preserves undo history. */
  public replaceTextOwned(text: string): void {
    this.guard()
    this.setNativeText(text, true)
  }

  public getLineCount(): number {
    this.guard()
    return this.lib.contextEditBufferGetInfo(this.native.handle.context, this.native.handle).lineCount
  }

  public setTabWidth(width: number): void {
    this.guard()
    this.runMutation(() => {
      this.lib.contextEditBufferSetTabWidth(this.native.handle.context, this.native.handle, width)
    })
  }

  public getTabWidth(): number {
    this.guard()
    return this.lib.contextEditBufferGetInfo(this.native.handle.context, this.native.handle).tabWidth
  }

  public getText(): string {
    this.guard()
    return this.lib.contextEditBufferGetText(this.native.handle.context, this.native.handle)
  }

  public insertChar(char: string): void {
    this.guard()
    return this.lib.contextEditBufferInsertText(
      this.native.handle.context,
      this.native.handle,
      this.lib.encoder.encode(char),
    )
  }

  public insertText(text: string): void {
    this.guard()
    return this.lib.contextEditBufferInsertText(
      this.native.handle.context,
      this.native.handle,
      this.lib.encoder.encode(text),
    )
  }

  public deleteChar(): void {
    this.guard()
    return this.lib.contextEditBufferCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditCommand.DeleteForward,
    )
  }

  public deleteCharBackward(): void {
    this.guard()
    return this.lib.contextEditBufferCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditCommand.Backspace,
    )
  }

  public deleteRange(startLine: number, startCol: number, endLine: number, endCol: number): void {
    this.guard()
    return this.lib.contextEditBufferDeleteRange(
      this.native.handle.context,
      this.native.handle,
      startLine,
      startCol,
      endLine,
      endCol,
    )
  }

  public newLine(): void {
    this.guard()
    return this.lib.contextEditBufferCommand(this.native.handle.context, this.native.handle, NativeEditCommand.NewLine)
  }

  public deleteLine(): void {
    this.guard()
    return this.lib.contextEditBufferCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditCommand.DeleteLine,
    )
  }

  public moveCursorLeft(): void {
    this.guard()
    return this.lib.contextEditBufferCommand(this.native.handle.context, this.native.handle, NativeEditCommand.MoveLeft)
  }

  public moveCursorRight(): void {
    this.guard()
    return this.lib.contextEditBufferCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditCommand.MoveRight,
    )
  }

  public moveCursorUp(): void {
    this.guard()
    return this.lib.contextEditBufferCommand(this.native.handle.context, this.native.handle, NativeEditCommand.MoveUp)
  }

  public moveCursorDown(): void {
    this.guard()
    return this.lib.contextEditBufferCommand(this.native.handle.context, this.native.handle, NativeEditCommand.MoveDown)
  }

  public gotoLine(line: number): void {
    this.guard()
    return this.lib.contextEditBufferCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditCommand.GotoLine,
      line,
    )
  }

  public setCursor(line: number, col: number): void {
    this.guard()
    return this.lib.contextEditBufferSetCursor(this.native.handle.context, this.native.handle, line, col)
  }

  public setCursorToLineCol(line: number, col: number): void {
    this.guard()
    return this.lib.contextEditBufferSetCursor(this.native.handle.context, this.native.handle, line, col)
  }

  public setCursorByOffset(offset: number): void {
    this.guard()
    return this.lib.contextEditBufferCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditCommand.CursorOffset,
      offset,
    )
  }

  public getCursorPosition(): LogicalCursor {
    this.guard()
    return this.lib.contextEditBufferGetInfo(this.native.handle.context, this.native.handle).cursor
  }

  public getNextWordBoundary(): LogicalCursor {
    this.guard()
    return this.lib.contextEditBufferGetPosition(
      this.native.handle.context,
      this.native.handle,
      NativeEditPositionQuery.NextWord,
    )!
  }

  public getPrevWordBoundary(): LogicalCursor {
    this.guard()
    return this.lib.contextEditBufferGetPosition(
      this.native.handle.context,
      this.native.handle,
      NativeEditPositionQuery.PrevWord,
    )!
  }

  public getEOL(): LogicalCursor {
    this.guard()
    return this.lib.contextEditBufferGetPosition(
      this.native.handle.context,
      this.native.handle,
      NativeEditPositionQuery.Eol,
    )!
  }

  public offsetToPosition(offset: number): { row: number; col: number } | null {
    this.guard()
    const result = this.lib.contextEditBufferGetPosition(
      this.native.handle.context,
      this.native.handle,
      NativeEditPositionQuery.Offset,
      offset,
    )
    if (!result) return null
    return { row: result.row, col: result.col }
  }

  public positionToOffset(row: number, col: number): number {
    this.guard()
    return (
      this.lib.contextEditBufferGetPosition(
        this.native.handle.context,
        this.native.handle,
        NativeEditPositionQuery.Coords,
        row,
        col,
      )?.offset ?? 0
    )
  }

  public getLineStartOffset(row: number): number {
    this.guard()
    return (
      this.lib.contextEditBufferGetPosition(
        this.native.handle.context,
        this.native.handle,
        NativeEditPositionQuery.LineStart,
        row,
      )?.offset ?? 0
    )
  }

  public getTextRange(startOffset: number, endOffset: number): string {
    this.guard()
    if (startOffset >= endOffset) return ""
    return this.lib.contextEditBufferGetRange(
      this.native.handle.context,
      this.native.handle,
      false,
      0,
      startOffset,
      0,
      endOffset,
    )
  }

  public getTextRangeByCoords(startRow: number, startCol: number, endRow: number, endCol: number): string {
    this.guard()
    return this.lib.contextEditBufferGetRange(
      this.native.handle.context,
      this.native.handle,
      true,
      startRow,
      startCol,
      endRow,
      endCol,
    )
  }

  public debugLogRope(): void {
    this.guard()
    this.lib.contextEditBufferCommand(this.native.handle.context, this.native.handle, NativeEditCommand.DebugRope)
    this.lib.logContextDiagnostics(this.native.handle.context)
  }

  public undo(): string | null {
    this.guard()
    return this.lib.contextEditBufferHistory(this.native.handle.context, this.native.handle, false)
  }

  public redo(): string | null {
    this.guard()
    return this.lib.contextEditBufferHistory(this.native.handle.context, this.native.handle, true)
  }

  public canUndo(): boolean {
    this.guard()
    return this.lib.contextEditBufferGetInfo(this.native.handle.context, this.native.handle).canUndo
  }

  public canRedo(): boolean {
    this.guard()
    return this.lib.contextEditBufferGetInfo(this.native.handle.context, this.native.handle).canRedo
  }

  public clearHistory(): void {
    this.guard()
    return this.lib.contextEditBufferCommand(
      this.native.handle.context,
      this.native.handle,
      NativeEditCommand.ClearHistory,
    )
  }

  public setDefaultFg(fg: RGBA | null): void {
    this.guard()
    return this.lib.contextEditBufferSetDefaults(
      this.native.handle.context,
      this.native.handle,
      NativeEditorStyleMask.Foreground,
      { fg },
    )
  }

  public setDefaultBg(bg: RGBA | null): void {
    this.guard()
    return this.lib.contextEditBufferSetDefaults(
      this.native.handle.context,
      this.native.handle,
      NativeEditorStyleMask.Background,
      { bg },
    )
  }

  public setDefaultAttributes(attributes: number | null): void {
    this.guard()
    return this.lib.contextEditBufferSetDefaults(
      this.native.handle.context,
      this.native.handle,
      NativeEditorStyleMask.Attributes,
      { attributes },
    )
  }

  public resetDefaults(): void {
    this.guard()
    return this.lib.contextEditBufferSetDefaults(
      this.native.handle.context,
      this.native.handle,
      NativeEditorStyleMask.All,
      {},
    )
  }

  public setSyntaxStyle(style: SyntaxStyle | null): void {
    this.runMutation(() => {
      this.lib.contextEditBufferSetSyntaxStyle(
        this.native.handle.context,
        this.native.handle,
        style?._getSceneHandle(this.native.scene) ?? null,
      )
      this._syntaxStyle = style ?? undefined
    })
  }

  public getSyntaxStyle(): SyntaxStyle | null {
    this.guard()
    return this._syntaxStyle ?? null
  }

  public addHighlight(lineIdx: number, highlight: Highlight): void {
    this.guard()
    return this.lib.contextEditBufferHighlight(
      this.native.handle.context,
      this.native.handle,
      NativeEditHighlightOperation.AddLine,
      lineIdx,
      highlight,
    )
  }

  public addHighlightByCharRange(highlight: Highlight): void {
    this.guard()
    return this.lib.contextEditBufferHighlight(
      this.native.handle.context,
      this.native.handle,
      NativeEditHighlightOperation.AddRange,
      0,
      highlight,
    )
  }

  public removeHighlightsByRef(hlRef: number): void {
    this.guard()
    return this.lib.contextEditBufferHighlight(
      this.native.handle.context,
      this.native.handle,
      NativeEditHighlightOperation.RemoveRef,
      hlRef,
    )
  }

  public clearLineHighlights(lineIdx: number): void {
    this.guard()
    return this.lib.contextEditBufferHighlight(
      this.native.handle.context,
      this.native.handle,
      NativeEditHighlightOperation.ClearLine,
      lineIdx,
    )
  }

  public clearAllHighlights(): void {
    this.guard()
    return this.lib.contextEditBufferHighlight(
      this.native.handle.context,
      this.native.handle,
      NativeEditHighlightOperation.ClearAll,
    )
  }

  public getLineHighlights(lineIdx: number): Array<Highlight> {
    this.guard()
    return this.lib.contextEditBufferGetHighlights(this.native.handle.context, this.native.handle, lineIdx)
  }

  public clear(): void {
    this.guard()
    return this.lib.contextEditBufferCommand(this.native.handle.context, this.native.handle, NativeEditCommand.Clear)
  }

  public destroy(): void {
    if (this._destroyed) return
    this.lib.getYogaHost().runMutation(() => {
      if (!this.native.scene.driver.contextDisposed)
        this.lib.destroyContextEditBuffer(this.native.handle.context, this.native.handle)
      this._destroyed = true
      this.unsubscribe?.()
      this.unsubscribe = undefined
      this.removeAllListeners()
      this._syntaxStyle = undefined
    })
  }
}
