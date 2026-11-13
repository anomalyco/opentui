import {
  NativeEditAtomic,
  NativeEditCommand,
  NativeEditPositionQuery,
  NativeEditorStyleMask,
  NativeEditHighlightOperation,
  NativeEditMarkOperation,
  resolveRenderLib,
  type LogicalCursor,
  type NativeEditMark,
  type RenderLib,
  type ContextEditBufferHandle,
  type NativeEditorStyle,
} from "./zig.js"
import { type WidthMethod, type Highlight } from "./types.js"
import { RGBA } from "./lib/RGBA.js"
import { EventEmitter } from "events"
import type { SyntaxStyle } from "./syntax-style.js"
import type { NativeResourceOwner, ResourceContext } from "./buffer.js"

export type { LogicalCursor }

/**
 * EditBuffer provides a text editing buffer with cursor management,
 * incremental editing, and grapheme-aware operations.
 */
export class EditBuffer extends EventEmitter {
  private lib: RenderLib
  private native: { owner: ResourceContext; handle: ContextEditBufferHandle }
  private unsubscribe?: () => void
  public readonly id: number
  private _destroyed: boolean = false
  private _syntaxStyle?: SyntaxStyle

  constructor(lib: RenderLib, handle: ContextEditBufferHandle, source: NativeResourceOwner) {
    super()
    const owner = source?.resourceContext
    if (!owner) throw new Error("EditBuffer requires an explicit resource owner")
    owner.assertAlive()
    if (owner.renderLib !== lib || !handle || typeof handle !== "object" || handle.context !== owner.context) {
      throw new Error("EditBuffer Context owner mismatch")
    }
    this.lib = lib
    this.native = { owner, handle }
    this.id = handle.slot
    this.unsubscribe = lib.onContextEditEvent(handle.context, handle, (name) => {
      if (!this._destroyed && !owner.disposed) this.emit(name)
    })
  }

  static create(widthMethod: WidthMethod, source: NativeResourceOwner): EditBuffer {
    const owner = source?.resourceContext
    if (!owner)
      throw new Error(
        "EditBuffer requires an explicit resource owner: pass renderer.nativeScene, or a ResourceContext when there is no renderer",
      )
    owner.assertAlive()
    const lib = owner.renderLib
    const handle = lib.createContextEditBuffer(owner.context, { widthMethod })
    try {
      return new EditBuffer(lib, handle, owner)
    } catch (error) {
      lib.destroyContextEditBuffer(owner.context, handle)
      throw error
    }
  }

  public get isDestroyed(): boolean {
    return this._destroyed
  }

  private guard(): void {
    if (this._destroyed) throw new Error("EditBuffer is destroyed")
    this.native.owner.assertAlive()
  }

  /** @internal Editor views must use the buffer's library and Context. */
  public _getOwner(): ResourceContext {
    this.guard()
    return this.native.owner
  }

  /** @internal Resources can be shared by scenes in the same Context. */
  public _getSceneHandle(scene: NativeResourceOwner): ContextEditBufferHandle {
    this.guard()
    if (this.native.owner !== scene.resourceContext) throw new Error("EditBuffer Context owner mismatch")
    return this.native.handle
  }

  public runMutation<T>(operation: () => T): T {
    this.guard()
    return this.lib.getYogaHost().runMutation(operation)
  }

  private command(command: NativeEditCommand, argument?: number): void {
    this.guard()
    this.lib.contextEditBufferCommand(this.native.handle.context, this.native.handle, command, argument)
  }

  private position(query: NativeEditPositionQuery, a?: number, b?: number): LogicalCursor | null {
    this.guard()
    return this.lib.contextEditBufferGetPosition(this.native.handle.context, this.native.handle, query, a, b)
  }

  private highlight(operation: NativeEditHighlightOperation, argument?: number, highlight?: Highlight): void {
    this.guard()
    this.lib.contextEditBufferHighlight(this.native.handle.context, this.native.handle, operation, argument, highlight)
  }

  private setDefaults(mask: NativeEditorStyleMask, style: NativeEditorStyle): void {
    this.guard()
    this.lib.contextEditBufferSetDefaults(this.native.handle.context, this.native.handle, mask, style)
  }

  /** @internal Called when text replacement drops the marks with the history, or on destroy: nothing can restore them. */
  public _onHistoryReset?: () => void

  private setNativeText(text: string, preserveHistory = false): void {
    const textBytes = this.lib.encoder.encode(text)
    this.lib.contextEditBufferSetText(this.native.handle.context, this.native.handle, textBytes, preserveHistory)
    if (!preserveHistory) this._onHistoryReset?.()
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

  /** Sets the fixed width of each tab in display cells. */
  public setTabWidth(width: number): void {
    this.runMutation(() => {
      this.lib.contextEditBufferSetTabWidth(this.native.handle.context, this.native.handle, width)
    })
  }

  /** Returns the fixed width of each tab in display cells. */
  public getTabWidth(): number {
    this.guard()
    return this.lib.contextEditBufferGetInfo(this.native.handle.context, this.native.handle).tabWidth
  }

  /** Returns the buffer text with LF line breaks. JavaScript indexes this string in UTF-16 code units. */
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

  /** @internal Set by extmarks controllers: whether the cursor rules around virtual extmarks apply now. */
  public _atomic?: () => boolean

  private rules(): number {
    return this._atomic?.() ? NativeEditAtomic : 0
  }

  public deleteChar(): void {
    this.command(NativeEditCommand.DeleteForward, this.rules())
  }

  public deleteCharBackward(): void {
    this.command(NativeEditCommand.Backspace, this.rules())
  }

  /** Deletes a half-open range between (zero-based logical line, display-cell column) pairs. */
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
    this.command(NativeEditCommand.NewLine)
  }

  public deleteLine(): void {
    this.command(NativeEditCommand.DeleteLine)
  }

  /** Moves to the previous cursor stop, not necessarily one display cell or UTF-16 code unit. */
  public moveCursorLeft(): void {
    this.command(NativeEditCommand.MoveLeft, this.rules())
  }

  /** Moves to the next cursor stop, not necessarily one display cell or UTF-16 code unit. */
  public moveCursorRight(): void {
    this.command(NativeEditCommand.MoveRight, this.rules())
  }

  /** Moves up one logical line using the desired display-cell column. */
  public moveCursorUp(): void {
    this.command(NativeEditCommand.MoveUp)
  }

  /** Moves down one logical line using the desired display-cell column. */
  public moveCursorDown(): void {
    this.command(NativeEditCommand.MoveDown)
  }

  /** Moves to a zero-based logical line. */
  public gotoLine(line: number): void {
    this.command(NativeEditCommand.GotoLine, line)
  }

  /** Sets the cursor by zero-based logical line and display-cell column. */
  public setCursor(line: number, col: number): void {
    this.guard()
    return this.lib.contextEditBufferSetCursor(this.native.handle.context, this.native.handle, line, col)
  }

  /** Sets the cursor by zero-based logical line and display-cell column. */
  public setCursorToLineCol(line: number, col: number): void {
    this.guard()
    return this.lib.contextEditBufferSetCursor(this.native.handle.context, this.native.handle, line, col)
  }

  /** Sets the cursor in display cells from the document start, counting each newline as one cell. */
  public setCursorByOffset(offset: number): void {
    this.command(this.rules() ? NativeEditCommand.CursorOffsetAtomic : NativeEditCommand.CursorOffset, offset)
  }

  /** @internal Moves a cursor inside virtual extmarks to their outer edge: the end (> 0), the start (< 0) or nearer. */
  public _keepOutside(direction: number): void {
    this.command(NativeEditCommand.KeepOutside, direction > 0 ? 1 : direction < 0 ? 2 : 0)
  }

  /** Returns the logical line, display-cell column, and document cell offset (one cell per newline). */
  public getCursorPosition(): LogicalCursor {
    this.guard()
    return this.lib.contextEditBufferGetInfo(this.native.handle.context, this.native.handle).cursor
  }

  /** Returns the next word boundary in logical line and cell coordinates. */
  public getNextWordBoundary(): LogicalCursor {
    return this.position(NativeEditPositionQuery.NextWord)!
  }

  /** Returns the previous word boundary in logical line and cell coordinates. */
  public getPrevWordBoundary(): LogicalCursor {
    return this.position(NativeEditPositionQuery.PrevWord)!
  }

  /** Returns the logical line end in display cells. */
  public getEOL(): LogicalCursor {
    return this.position(NativeEditPositionQuery.Eol)!
  }

  /** @internal Extmarks are stored in the native buffer, which moves them with edits, undo and redo. */
  public _mark(operation: NativeEditMarkOperation, mark?: Partial<NativeEditMark>): number {
    this.guard()
    return this.lib.contextEditBufferMark(this.native.handle.context, this.native.handle, operation, mark)
  }

  /** @internal */
  public _getMarks(id?: number, kind?: number): NativeEditMark[] {
    this.guard()
    return this.lib.contextEditBufferGetMarks(this.native.handle.context, this.native.handle, id, kind)
  }

  /** Maps document cells (one per newline) to a logical row and cell column, not a string index. */
  public offsetToPosition(offset: number): { row: number; col: number } | null {
    const result = this.position(NativeEditPositionQuery.Offset, offset)
    return result && { row: result.row, col: result.col }
  }

  /** Maps a logical row and cell column to document cells, counting one cell per newline. */
  public positionToOffset(row: number, col: number): number {
    return this.position(NativeEditPositionQuery.Coords, row, col)?.offset ?? 0
  }

  /** Returns a logical line's start in document cells, counting one cell per newline. */
  public getLineStartOffset(row: number): number {
    return this.position(NativeEditPositionQuery.LineStart, row)?.offset ?? 0
  }

  /**
   * Returns the global display offset at the end of `text` as this buffer would lay it out, without storing it: its
   * cells under this buffer's width method, tab width, and control notation, plus one per line break. Use
   * `measureEditText()` to measure without a buffer.
   */
  public measureText(text: string): number {
    this.guard()
    return this.lib.contextEditBufferMeasureText(
      this.native.handle.context,
      this.native.handle,
      this.lib.encoder.encode(text),
    )
  }

  /** Converts a UTF-16 index in getText() to document cells (one per newline). Rounds down within a grapheme; clamps at EOF. */
  public stringIndexToCellOffset(index: number): number {
    this.guard()
    return this.lib.contextEditBufferConvertOffset(this.native.handle.context, this.native.handle, index, true)
  }

  /** Converts document cells to a UTF-16 index in getText(). Rounds down within a grapheme, past zero-width text at a tie, and clamps at EOF. */
  public cellOffsetToStringIndex(offset: number): number {
    this.guard()
    return this.lib.contextEditBufferConvertOffset(this.native.handle.context, this.native.handle, offset, false)
  }

  /** Reads [startOffset, endOffset) in document display cells, counting one cell per newline. */
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

  /** Reads a half-open range between (zero-based logical row, display-cell column) pairs. */
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
    this.command(NativeEditCommand.DebugRope)
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
    this.command(NativeEditCommand.ClearHistory)
  }

  public setDefaultFg(fg: RGBA | null): void {
    this.setDefaults(NativeEditorStyleMask.Foreground, { fg })
  }

  public setDefaultBg(bg: RGBA | null): void {
    this.setDefaults(NativeEditorStyleMask.Background, { bg })
  }

  public setDefaultAttributes(attributes: number | null): void {
    this.setDefaults(NativeEditorStyleMask.Attributes, { attributes })
  }

  public resetDefaults(): void {
    this.setDefaults(NativeEditorStyleMask.All, {})
  }

  public setSyntaxStyle(style: SyntaxStyle | null): void {
    this.runMutation(() => {
      this.lib.contextEditBufferSetSyntaxStyle(
        this.native.handle.context,
        this.native.handle,
        style?._getSceneHandle(this.native.owner) ?? null,
      )
      this._syntaxStyle = style ?? undefined
    })
  }

  public getSyntaxStyle(): SyntaxStyle | null {
    this.guard()
    return this._syntaxStyle ?? null
  }

  /** Highlights a range in display cells relative to the logical line. */
  public addHighlight(lineIdx: number, highlight: Highlight): void {
    this.highlight(NativeEditHighlightOperation.AddLine, lineIdx, highlight)
  }

  /** Highlights a range in document display cells excluding newlines, not UTF-16 indices. */
  public addHighlightByCharRange(highlight: Highlight): void {
    this.highlight(NativeEditHighlightOperation.AddRange, 0, highlight)
  }

  public removeHighlightsByRef(hlRef: number): void {
    this.highlight(NativeEditHighlightOperation.RemoveRef, hlRef)
  }

  public clearLineHighlights(lineIdx: number): void {
    this.highlight(NativeEditHighlightOperation.ClearLine, lineIdx)
  }

  public clearAllHighlights(): void {
    this.highlight(NativeEditHighlightOperation.ClearAll)
  }

  public getLineHighlights(lineIdx: number): Array<Highlight> {
    this.guard()
    return this.lib.contextEditBufferGetHighlights(this.native.handle.context, this.native.handle, lineIdx)
  }

  public clear(): void {
    this.command(NativeEditCommand.Clear)
  }

  public destroy(): void {
    if (this._destroyed) return
    this.lib.getYogaHost().runMutation(() => {
      if (!this.native.owner.disposed)
        this.lib.releaseAfterPaint(this.native.handle.context, () =>
          this.lib.destroyContextEditBuffer(this.native.handle.context, this.native.handle),
        )
      this._destroyed = true
      this._onHistoryReset?.()
      this.unsubscribe?.()
      this.unsubscribe = undefined
      this.removeAllListeners()
      this._syntaxStyle = undefined
    })
  }
}

/**
 * Returns the editor offset at the end of `text` as an edit buffer with these settings lays it out, without an edit
 * buffer: its cells under `widthMethod`, `tabWidth`, and control notation, plus one per line break. `tabWidth` defaults
 * to the tab width of a new edit buffer and rounds as in `EditBuffer.setTabWidth()`.
 */
export function measureEditText(text: string, options: { widthMethod: WidthMethod; tabWidth?: number }): number {
  const lib = resolveRenderLib()
  // Tab width 0 rounds to the tab width of a new edit buffer.
  return lib.editMeasureText(lib.encoder.encode(text), options.widthMethod, options.tabWidth ?? 0)
}
