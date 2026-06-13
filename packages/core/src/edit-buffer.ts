import {
  resolveRenderLib,
  type EditBufferHandle,
  type LogicalCursor,
  type RenderLib,
  type TextBufferHandle,
} from "./zig.js"
import { type WidthMethod, type Highlight } from "./types.js"
import { RGBA } from "./lib/RGBA.js"
import { EventEmitter } from "events"
import type { SyntaxStyle } from "./syntax-style.js"

export type { LogicalCursor }

/**
 * EditBuffer provides a text editing buffer with cursor management,
 * incremental editing, and grapheme-aware operations.
 */
export class EditBuffer extends EventEmitter {
  private static registry = new Map<number, EditBuffer>()
  private static nativeEventsSubscribed = false

  private lib: RenderLib
  private bufferPtr: EditBufferHandle
  private textBufferPtr: TextBufferHandle
  public readonly id: number
  private _destroyed: boolean = false
  private _textBytes: Uint8Array[] = []
  private _singleTextBytes: Uint8Array | null = null
  private _singleTextMemId: number | null = null
  private _syntaxStyle?: SyntaxStyle

  constructor(lib: RenderLib, ptr: EditBufferHandle) {
    super()
    this.lib = lib
    this.bufferPtr = ptr
    this.textBufferPtr = lib.editBufferGetTextBuffer(ptr)
    this.id = lib.editBufferGetId(ptr)

    EditBuffer.registry.set(this.id, this)
    EditBuffer.subscribeToNativeEvents(lib)
  }

  static create(widthMethod: WidthMethod): EditBuffer {
    const lib = resolveRenderLib()
    const ptr = lib.createEditBuffer(widthMethod)
    return new EditBuffer(lib, ptr)
  }

  private static subscribeToNativeEvents(lib: RenderLib): void {
    if (EditBuffer.nativeEventsSubscribed) return
    EditBuffer.nativeEventsSubscribed = true

    lib.onAnyNativeEvent((name: string, data: ArrayBuffer) => {
      const buffer = new Uint16Array(data)

      if (name.startsWith("eb_") && buffer.length >= 1) {
        const id = buffer[0]
        const instance = EditBuffer.registry.get(id)

        if (instance) {
          // Strip the "eb_" prefix and forward the event
          const eventName = name.slice(3)
          const eventData = data.slice(2)
          instance.emit(eventName, eventData)
        }
      }
    })
  }

  private guard(): void {
    if (this._destroyed) throw new Error("EditBuffer is destroyed")
  }

  public get ptr(): EditBufferHandle {
    this.guard()
    return this.bufferPtr
  }

  /**
   * Set text and completely reset the buffer state (clears history, resets add_buffer).
   * Use this for initial text setting or when you want a clean slate.
   */
  public setText(text: string): void {
    this.guard()
    const textBytes = this.lib.encoder.encode(text)

    if (this._singleTextMemId !== null) {
      this.lib.textBufferReplaceMemBuffer(this.textBufferPtr, this._singleTextMemId, textBytes, false)
    } else {
      this._singleTextMemId = this.lib.textBufferRegisterMemBuffer(this.textBufferPtr, textBytes, false)
    }
    this._singleTextBytes = textBytes
    this.lib.editBufferSetTextFromMem(this.bufferPtr, this._singleTextMemId)
  }

  /**
   * Set text using owned memory and completely reset the buffer state (clears history, resets add_buffer).
   * The native code takes ownership of the memory.
   */
  public setTextOwned(text: string): void {
    this.guard()
    const textBytes = this.lib.encoder.encode(text)
    this.lib.editBufferSetText(this.bufferPtr, textBytes)
  }

  /**
   * Replace text while preserving undo history (creates an undo point).
   * Use this when you want the setText operation to be undoable.
   */
  public replaceText(text: string): void {
    this.guard()
    const textBytes = this.lib.encoder.encode(text)
    this._textBytes.push(textBytes)
    const memId = this.lib.textBufferRegisterMemBuffer(this.textBufferPtr, textBytes, false)
    this.lib.editBufferReplaceTextFromMem(this.bufferPtr, memId)
  }

  /**
   * Replace text using owned memory while preserving undo history (creates an undo point).
   * The native code takes ownership of the memory.
   */
  public replaceTextOwned(text: string): void {
    this.guard()
    const textBytes = this.lib.encoder.encode(text)
    this.lib.editBufferReplaceText(this.bufferPtr, textBytes)
  }

  public getLineCount(): number {
    this.guard()
    return this.lib.textBufferGetLineCount(this.textBufferPtr)
  }

  public getText(): string {
    this.guard()
    // TODO: Use byte size of text buffer to get the actual size of the text
    // actually native can stack alloc all the text and decode will alloc as js string then
    const maxSize = 1024 * 1024 // 1MB max
    const textBytes = this.lib.editBufferGetText(this.bufferPtr, maxSize)

    if (!textBytes) return ""

    return this.lib.decoder.decode(textBytes)
  }

  public insertChar(char: string): void {
    this.guard()
    this.lib.editBufferInsertChar(this.bufferPtr, char)
  }

  public insertText(text: string): void {
    this.guard()
    this.lib.editBufferInsertText(this.bufferPtr, text)
  }

  public deleteChar(): void {
    this.guard()
    this.lib.editBufferDeleteChar(this.bufferPtr)
  }

  public deleteCharBackward(): void {
    this.guard()
    this.lib.editBufferDeleteCharBackward(this.bufferPtr)
  }

  public deleteRange(startLine: number, startCol: number, endLine: number, endCol: number): void {
    this.guard()
    this.lib.editBufferDeleteRange(this.bufferPtr, startLine, startCol, endLine, endCol)
  }

  public newLine(): void {
    this.guard()
    this.lib.editBufferNewLine(this.bufferPtr)
  }

  public deleteLine(): void {
    this.guard()
    this.lib.editBufferDeleteLine(this.bufferPtr)
  }

  public moveCursorLeft(): void {
    this.guard()
    this.lib.editBufferMoveCursorLeft(this.bufferPtr)
  }

  public moveCursorRight(): void {
    this.guard()
    this.lib.editBufferMoveCursorRight(this.bufferPtr)
  }

  public moveCursorUp(): void {
    this.guard()
    this.lib.editBufferMoveCursorUp(this.bufferPtr)
  }

  public moveCursorDown(): void {
    this.guard()
    this.lib.editBufferMoveCursorDown(this.bufferPtr)
  }

  public gotoLine(line: number): void {
    this.guard()
    this.lib.editBufferGotoLine(this.bufferPtr, line)
  }

  public setCursor(line: number, col: number): void {
    this.guard()
    this.lib.editBufferSetCursor(this.bufferPtr, line, col)
  }

  public setCursorToLineCol(line: number, col: number): void {
    this.guard()
    this.lib.editBufferSetCursorToLineCol(this.bufferPtr, line, col)
  }

  public setCursorByOffset(offset: number): void {
    this.guard()
    this.lib.editBufferSetCursorByOffset(this.bufferPtr, offset)
  }

  public getCursorPosition(): LogicalCursor {
    this.guard()
    return this.lib.editBufferGetCursorPosition(this.bufferPtr)
  }

  public getNextWordBoundary(): LogicalCursor {
    this.guard()
    const boundary = this.lib.editBufferGetNextWordBoundary(this.bufferPtr)
    return {
      row: boundary.row,
      col: boundary.col,
      offset: boundary.offset,
    }
  }

  public getPrevWordBoundary(): LogicalCursor {
    this.guard()
    const boundary = this.lib.editBufferGetPrevWordBoundary(this.bufferPtr)
    return {
      row: boundary.row,
      col: boundary.col,
      offset: boundary.offset,
    }
  }

  public getEOL(): LogicalCursor {
    this.guard()
    const boundary = this.lib.editBufferGetEOL(this.bufferPtr)
    return {
      row: boundary.row,
      col: boundary.col,
      offset: boundary.offset,
    }
  }

  public offsetToPosition(offset: number): { row: number; col: number } | null {
    this.guard()
    const result = this.lib.editBufferOffsetToPosition(this.bufferPtr, offset)
    if (!result) return null
    return { row: result.row, col: result.col }
  }

  public positionToOffset(row: number, col: number): number {
    this.guard()
    return this.lib.editBufferPositionToOffset(this.bufferPtr, row, col)
  }

  public getLineStartOffset(row: number): number {
    this.guard()
    return this.lib.editBufferGetLineStartOffset(this.bufferPtr, row)
  }

  public getTextRange(startOffset: number, endOffset: number): string {
    this.guard()
    if (startOffset >= endOffset) return ""

    // TODO: Use actual expected size of the text
    // like other methods native can just return a pointer and size
    // and we immediately decode the text into a js string then the native stack
    // can go out of scope
    const maxSize = 1024 * 1024 // 1MB max
    const textBytes = this.lib.editBufferGetTextRange(this.bufferPtr, startOffset, endOffset, maxSize)

    if (!textBytes) return ""

    return this.lib.decoder.decode(textBytes)
  }

  public getTextRangeByCoords(startRow: number, startCol: number, endRow: number, endCol: number): string {
    this.guard()

    const maxSize = 1024 * 1024 // 1MB max
    const textBytes = this.lib.editBufferGetTextRangeByCoords(
      this.bufferPtr,
      startRow,
      startCol,
      endRow,
      endCol,
      maxSize,
    )

    if (!textBytes) return ""

    return this.lib.decoder.decode(textBytes)
  }

  public debugLogRope(): void {
    this.guard()
    this.lib.editBufferDebugLogRope(this.bufferPtr)
  }

  public undo(): string | null {
    this.guard()
    const maxSize = 256
    const metaBytes = this.lib.editBufferUndo(this.bufferPtr, maxSize)
    if (!metaBytes) return null
    return this.lib.decoder.decode(metaBytes)
  }

  public redo(): string | null {
    this.guard()
    const maxSize = 256
    const metaBytes = this.lib.editBufferRedo(this.bufferPtr, maxSize)
    if (!metaBytes) return null
    return this.lib.decoder.decode(metaBytes)
  }

  public canUndo(): boolean {
    this.guard()
    return this.lib.editBufferCanUndo(this.bufferPtr)
  }

  public canRedo(): boolean {
    this.guard()
    return this.lib.editBufferCanRedo(this.bufferPtr)
  }

  public clearHistory(): void {
    this.guard()
    this.lib.editBufferClearHistory(this.bufferPtr)
  }

  public setDefaultFg(fg: RGBA | null): void {
    this.guard()
    this.lib.textBufferSetDefaultFg(this.textBufferPtr, fg)
  }

  public setDefaultBg(bg: RGBA | null): void {
    this.guard()
    this.lib.textBufferSetDefaultBg(this.textBufferPtr, bg)
  }

  public setDefaultAttributes(attributes: number | null): void {
    this.guard()
    this.lib.textBufferSetDefaultAttributes(this.textBufferPtr, attributes)
  }

  public resetDefaults(): void {
    this.guard()
    this.lib.textBufferResetDefaults(this.textBufferPtr)
  }

  public setSyntaxStyle(style: SyntaxStyle | null): void {
    this.guard()
    if (this.lib.textBufferSetSyntaxStyle(this.textBufferPtr, style?.ptr ?? null)) {
      this._syntaxStyle = style ?? undefined
    }
  }

  public getSyntaxStyle(): SyntaxStyle | null {
    this.guard()
    return this._syntaxStyle ?? null
  }

  public addHighlight(lineIdx: number, highlight: Highlight): void {
    this.guard()
    this.lib.textBufferAddHighlight(this.textBufferPtr, lineIdx, highlight)
  }

  public addHighlightByCharRange(highlight: Highlight): void {
    this.guard()
    this.lib.textBufferAddHighlightByCharRange(this.textBufferPtr, highlight)
  }

  public removeHighlightsByRef(hlRef: number): void {
    this.guard()
    this.lib.textBufferRemoveHighlightsByRef(this.textBufferPtr, hlRef)
  }

  public clearLineHighlights(lineIdx: number): void {
    this.guard()
    this.lib.textBufferClearLineHighlights(this.textBufferPtr, lineIdx)
  }

  public clearAllHighlights(): void {
    this.guard()
    this.lib.textBufferClearAllHighlights(this.textBufferPtr)
  }

  public getLineHighlights(lineIdx: number): Array<Highlight> {
    this.guard()
    return this.lib.textBufferGetLineHighlights(this.textBufferPtr, lineIdx)
  }

  public clear(): void {
    this.guard()
    this.lib.editBufferClear(this.bufferPtr)
  }

  public destroy(): void {
    if (this._destroyed) return

    this._destroyed = true
    EditBuffer.registry.delete(this.id)
    this.lib.destroyEditBuffer(this.bufferPtr)
  }
}
