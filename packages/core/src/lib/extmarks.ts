import type { EditBuffer } from "../edit-buffer.js"
import type { EditorView } from "../editor-view.js"
import { stringWidth } from "../platform/runtime.js"
import { ExtmarksHistory, type ExtmarksSnapshot } from "./extmarks-history.js"

export interface Extmark {
  id: number
  start: number // Display-width offset (including newlines), NOT JS string index
  end: number // Display-width offset (including newlines), NOT JS string index
  virtual: boolean
  styleId?: number
  priority?: number
  data?: any
  typeId: number
}

export interface ExtmarkOptions {
  start: number // Display-width offset (including newlines), NOT JS string index
  end: number // Display-width offset (including newlines), NOT JS string index
  virtual?: boolean
  styleId?: number
  priority?: number
  data?: any
  typeId?: number
  metadata?: any
}

/**
 * WARNING: This is simulating extmarks in the edit buffer
 * and will move to a real native implementation in the future.
 * Use with caution.
 */
export class ExtmarksController {
  private editBuffer: EditBuffer
  private editorView: EditorView
  private extmarks = new Map<number, Extmark>()
  private extmarksByTypeId = new Map<number, Set<number>>()
  private metadata = new Map<number, any>()
  private nextId = 1
  private destroyed = false
  private history = new ExtmarksHistory()
  private typeNameToId = new Map<string, number>()
  private typeIdToName = new Map<number, string>()
  private nextTypeId = 1

  private originalMoveCursorLeft: typeof EditBuffer.prototype.moveCursorLeft
  private originalMoveCursorRight: typeof EditBuffer.prototype.moveCursorRight
  private originalSetCursorByOffset: typeof EditBuffer.prototype.setCursorByOffset
  private originalMoveUpVisual: typeof EditorView.prototype.moveUpVisual
  private originalMoveDownVisual: typeof EditorView.prototype.moveDownVisual
  private originalDeleteCharBackward: typeof EditBuffer.prototype.deleteCharBackward
  private originalDeleteChar: typeof EditBuffer.prototype.deleteChar
  private originalInsertText: typeof EditBuffer.prototype.insertText
  private originalInsertChar: typeof EditBuffer.prototype.insertChar
  private originalDeleteRange: typeof EditBuffer.prototype.deleteRange
  private originalSetText: typeof EditBuffer.prototype.setText
  private originalReplaceText: typeof EditBuffer.prototype.replaceText
  private originalClear: typeof EditBuffer.prototype.clear
  private originalNewLine: typeof EditBuffer.prototype.newLine
  private originalDeleteLine: typeof EditBuffer.prototype.deleteLine
  private originalEditorViewDeleteSelectedText: typeof EditorView.prototype.deleteSelectedText
  private originalEditorViewReplaceSelectedText: typeof EditorView.prototype._replaceSelectedText
  private originalUndo: typeof EditBuffer.prototype.undo
  private originalRedo: typeof EditBuffer.prototype.redo
  private readonly contentChangeListener = () => {
    if (!this.destroyed) this.updateHighlights()
  }

  constructor(editBuffer: EditBuffer, editorView: EditorView) {
    this.editBuffer = editBuffer
    this.editorView = editorView

    this.originalMoveCursorLeft = editBuffer.moveCursorLeft.bind(editBuffer)
    this.originalMoveCursorRight = editBuffer.moveCursorRight.bind(editBuffer)
    this.originalSetCursorByOffset = editBuffer.setCursorByOffset.bind(editBuffer)
    this.originalMoveUpVisual = editorView.moveUpVisual.bind(editorView)
    this.originalMoveDownVisual = editorView.moveDownVisual.bind(editorView)
    this.originalDeleteCharBackward = editBuffer.deleteCharBackward.bind(editBuffer)
    this.originalDeleteChar = editBuffer.deleteChar.bind(editBuffer)
    this.originalInsertText = editBuffer.insertText.bind(editBuffer)
    this.originalInsertChar = editBuffer.insertChar.bind(editBuffer)
    this.originalDeleteRange = editBuffer.deleteRange.bind(editBuffer)
    this.originalSetText = editBuffer.setText.bind(editBuffer)
    this.originalReplaceText = editBuffer.replaceText.bind(editBuffer)
    this.originalClear = editBuffer.clear.bind(editBuffer)
    this.originalNewLine = editBuffer.newLine.bind(editBuffer)
    this.originalDeleteLine = editBuffer.deleteLine.bind(editBuffer)
    this.originalEditorViewDeleteSelectedText = editorView.deleteSelectedText.bind(editorView)
    this.originalEditorViewReplaceSelectedText = editorView._replaceSelectedText.bind(editorView)
    this.originalUndo = editBuffer.undo.bind(editBuffer)
    this.originalRedo = editBuffer.redo.bind(editBuffer)

    this.wrapCursorMovement()
    this.wrapDeletion()
    this.wrapInsertion()
    this.wrapEditorViewDeleteSelectedText()
    this.wrapUndoRedo()
    this.setupContentChangeListener()
  }

  private wrapCursorMovement(): void {
    this.editBuffer.moveCursorLeft = (): void => {
      if (this.destroyed) {
        this.originalMoveCursorLeft()
        return
      }

      const currentOffset = this.editorView.getVisualCursor().offset
      const hasSelection = this.editorView.hasSelection()

      if (hasSelection) {
        this.originalMoveCursorLeft()
        return
      }

      const targetOffset = currentOffset - 1
      if (targetOffset < 0) {
        this.originalMoveCursorLeft()
        return
      }

      const virtualExtmark = this.findVirtualExtmarkContaining(targetOffset)
      if (virtualExtmark && currentOffset >= virtualExtmark.end) {
        this.editBuffer.setCursorByOffset(Math.max(0, virtualExtmark.start - 1))
        return
      }

      this.originalMoveCursorLeft()
    }

    this.editBuffer.moveCursorRight = (): void => {
      if (this.destroyed) {
        this.originalMoveCursorRight()
        return
      }

      const currentOffset = this.editorView.getVisualCursor().offset
      const hasSelection = this.editorView.hasSelection()

      if (hasSelection) {
        this.originalMoveCursorRight()
        return
      }

      const targetOffset = currentOffset + 1
      const textLength = this.editBuffer.getText().length

      if (targetOffset > textLength) {
        this.originalMoveCursorRight()
        return
      }

      const virtualExtmark = this.findVirtualExtmarkContaining(targetOffset)
      if (virtualExtmark && currentOffset <= virtualExtmark.start) {
        this.editBuffer.setCursorByOffset(virtualExtmark.end)
        return
      }

      this.originalMoveCursorRight()
    }

    this.editorView.moveUpVisual = (): void => {
      if (this.destroyed) {
        this.originalMoveUpVisual()
        return
      }

      const hasSelection = this.editorView.hasSelection()

      if (hasSelection) {
        this.originalMoveUpVisual()
        return
      }

      const currentOffset = this.editorView.getVisualCursor().offset
      this.originalMoveUpVisual()
      const newOffset = this.editorView.getVisualCursor().offset

      const virtualExtmark = this.findVirtualExtmarkContaining(newOffset)
      if (virtualExtmark) {
        const distanceToStart = newOffset - virtualExtmark.start
        const distanceToEnd = virtualExtmark.end - newOffset

        if (distanceToStart < distanceToEnd) {
          this.editorView.setCursorByOffset(Math.max(0, virtualExtmark.start - 1))
        } else {
          this.editorView.setCursorByOffset(virtualExtmark.end)
        }
      }
    }

    this.editorView.moveDownVisual = (): void => {
      if (this.destroyed) {
        this.originalMoveDownVisual()
        return
      }

      const hasSelection = this.editorView.hasSelection()

      if (hasSelection) {
        this.originalMoveDownVisual()
        return
      }

      const currentOffset = this.editorView.getVisualCursor().offset
      this.originalMoveDownVisual()
      const newOffset = this.editorView.getVisualCursor().offset

      const virtualExtmark = this.findVirtualExtmarkContaining(newOffset)
      if (virtualExtmark) {
        const distanceToStart = newOffset - virtualExtmark.start
        const distanceToEnd = virtualExtmark.end - newOffset

        if (distanceToStart < distanceToEnd) {
          const adjustedOffset = virtualExtmark.start - 1
          const targetOffset = adjustedOffset <= currentOffset ? virtualExtmark.end : adjustedOffset
          this.editorView.setCursorByOffset(targetOffset)
        } else {
          this.editorView.setCursorByOffset(virtualExtmark.end)
        }
      }
    }

    this.editBuffer.setCursorByOffset = (offset: number): void => {
      if (this.destroyed) {
        this.originalSetCursorByOffset(offset)
        return
      }

      const currentOffset = this.editorView.getVisualCursor().offset
      const hasSelection = this.editorView.hasSelection()

      if (hasSelection) {
        this.originalSetCursorByOffset(offset)
        return
      }

      const movingForward = offset > currentOffset

      if (movingForward) {
        const virtualExtmark = this.findVirtualExtmarkContaining(offset)
        if (virtualExtmark && currentOffset <= virtualExtmark.start) {
          this.originalSetCursorByOffset(virtualExtmark.end)
          return
        }
      } else {
        for (const extmark of this.extmarks.values()) {
          if (extmark.virtual && currentOffset >= extmark.end && offset < extmark.end && offset >= extmark.start) {
            this.originalSetCursorByOffset(Math.max(0, extmark.start - 1))
            return
          }
        }
      }

      this.originalSetCursorByOffset(offset)
    }
  }

  private wrapDeletion(): void {
    this.editBuffer.deleteCharBackward = (): void =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed) {
          this.originalDeleteCharBackward()
          return
        }

        const currentOffset = this.editorView.getVisualCursor().offset
        const hadSelection = this.editorView.hasSelection()

        if (currentOffset === 0 || hadSelection) {
          this.originalDeleteCharBackward()
          this.saveSnapshot()
          return
        }

        const targetOffset = currentOffset - 1
        const virtualExtmark = this.findVirtualExtmarkContaining(targetOffset)

        if (virtualExtmark && currentOffset === virtualExtmark.end) {
          const startCursor = this.offsetToPosition(virtualExtmark.start)
          const endCursor = this.offsetToPosition(virtualExtmark.end)
          const deleteOffset = virtualExtmark.start
          const deleteLength = virtualExtmark.end - virtualExtmark.start

          this.originalDeleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
          this.saveSnapshot()
          this.deleteExtmarkById(virtualExtmark.id)
          this.adjustExtmarksAfterDeletion(deleteOffset, deleteLength)

          return
        }

        this.originalDeleteCharBackward()
        this.saveSnapshot()
        const deleteOffset = this.editBuffer.getCursorPosition().offset
        const deleteLength = currentOffset - deleteOffset
        if (deleteLength > 0) {
          this.adjustExtmarksAfterDeletion(deleteOffset, deleteLength)
        }
      })

    this.editBuffer.deleteChar = (): void =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed) {
          this.originalDeleteChar()
          return
        }

        const currentOffset = this.editorView.getVisualCursor().offset
        const hadSelection = this.editorView.hasSelection()

        if (hadSelection) {
          this.originalDeleteChar()
          this.saveSnapshot()
          return
        }

        const targetOffset = currentOffset
        const virtualExtmark = this.findVirtualExtmarkContaining(targetOffset)

        if (virtualExtmark && currentOffset === virtualExtmark.start) {
          const startCursor = this.offsetToPosition(virtualExtmark.start)
          const endCursor = this.offsetToPosition(virtualExtmark.end)
          const deleteOffset = virtualExtmark.start
          const deleteLength = virtualExtmark.end - virtualExtmark.start

          this.originalDeleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
          this.saveSnapshot()
          this.deleteExtmarkById(virtualExtmark.id)
          this.adjustExtmarksAfterDeletion(deleteOffset, deleteLength)

          return
        }

        const deleteEndOffset = this.getNextCursorOffset(currentOffset)
        const deleteLength = deleteEndOffset - currentOffset

        this.originalDeleteChar()
        this.saveSnapshot()

        if (deleteLength > 0) {
          this.adjustExtmarksAfterDeletion(currentOffset, deleteLength)
        }
      })

    this.editBuffer.deleteRange = (startLine: number, startCol: number, endLine: number, endCol: number): void =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed) {
          this.originalDeleteRange(startLine, startCol, endLine, endCol)
          return
        }

        const startOffset = this.positionToOffset(startLine, startCol)
        const endOffset = this.positionToOffset(endLine, endCol)
        const length = endOffset - startOffset

        this.originalDeleteRange(startLine, startCol, endLine, endCol)
        this.saveSnapshot()
        this.adjustExtmarksAfterDeletion(startOffset, length)
      })

    this.editBuffer.deleteLine = (): void =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed) {
          this.originalDeleteLine()
          return
        }

        const text = this.editBuffer.getText()
        const currentOffset = this.editorView.getVisualCursor().offset

        let lineStart = 0
        for (let i = currentOffset - 1; i >= 0; i--) {
          if (text[i] === "\n") {
            lineStart = i + 1
            break
          }
        }

        let lineEnd = text.length
        for (let i = currentOffset; i < text.length; i++) {
          if (text[i] === "\n") {
            lineEnd = i + 1
            break
          }
        }

        const deleteLength = lineEnd - lineStart

        this.originalDeleteLine()
        this.saveSnapshot()
        this.adjustExtmarksAfterDeletion(lineStart, deleteLength)
      })
  }

  private wrapInsertion(): void {
    this.editBuffer.insertText = (text: string): void =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed) {
          this.originalInsertText(text)
          return
        }

        const currentOffset = this.editorView.getVisualCursor().offset
        this.originalInsertText(text)
        this.saveSnapshot()
        const insertLength = this.editBuffer.getCursorPosition().offset - currentOffset
        if (insertLength > 0) {
          this.adjustExtmarksAfterInsertion(currentOffset, insertLength)
        }
      })

    this.editBuffer.insertChar = (char: string): void =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed) {
          this.originalInsertChar(char)
          return
        }

        const currentOffset = this.editorView.getVisualCursor().offset
        this.originalInsertChar(char)
        this.saveSnapshot()
        const insertLength = this.editBuffer.getCursorPosition().offset - currentOffset
        if (insertLength > 0) {
          this.adjustExtmarksAfterInsertion(currentOffset, insertLength)
        }
      })

    this.editBuffer.setText = (text: string): void => {
      if (this.destroyed) {
        this.originalSetText(text)
        return
      }

      this.editBuffer.runMutation(() => {
        this.originalSetText(text)
        this.clear()
      })
    }

    this.editBuffer.replaceText = (text: string): void => {
      if (this.destroyed) {
        this.originalReplaceText(text)
        return
      }

      this.editBuffer.runMutation(() => {
        this.originalReplaceText(text)
        this.saveSnapshot()
        this.clear()
      })
    }

    this.editBuffer.clear = (): void =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed) {
          this.originalClear()
          return
        }

        this.originalClear()
        this.saveSnapshot()
        this.clear()
      })

    this.editBuffer.newLine = (): void =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed) {
          this.originalNewLine()
          return
        }

        const currentOffset = this.editorView.getVisualCursor().offset
        this.originalNewLine()
        this.saveSnapshot()
        this.adjustExtmarksAfterInsertion(currentOffset, 1)
      })
  }

  private wrapEditorViewDeleteSelectedText(): void {
    this.editorView._replaceSelectedText = (text: string) =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed) return this.originalEditorViewReplaceSelectedText(text)
        const selection = this.editorView.getSelection()
        const deleteOffset = selection ? Math.min(selection.start, selection.end) : 0
        const deleteLength = selection ? Math.abs(selection.end - selection.start) : 0
        const cursorOffset = this.editBuffer.getCursorPosition().offset
        const result = this.originalEditorViewReplaceSelectedText(text)
        const insertOffset = result.deleted ? deleteOffset : cursorOffset
        if (result.deleted) {
          this.saveSnapshot()
          if (deleteLength > 0) this.adjustExtmarksAfterDeletion(deleteOffset, deleteLength, false)
        }
        if (result.inserted) this.saveSnapshot()
        const insertLength = this.editBuffer.getCursorPosition().offset - insertOffset
        if (insertLength > 0) this.adjustExtmarksAfterInsertion(insertOffset, insertLength, false)
        if (deleteLength > 0 || insertLength > 0) this.updateHighlights()
        return result
      })

    this.editorView.deleteSelectedText = (): void =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed) {
          this.originalEditorViewDeleteSelectedText()
          return
        }

        const selection = this.editorView.getSelection()
        if (!selection) {
          this.originalEditorViewDeleteSelectedText()
          this.saveSnapshot()
          return
        }

        const deleteOffset = Math.min(selection.start, selection.end)
        const deleteLength = Math.abs(selection.end - selection.start)

        this.originalEditorViewDeleteSelectedText()
        this.saveSnapshot()

        if (deleteLength > 0) {
          this.adjustExtmarksAfterDeletion(deleteOffset, deleteLength)
        }
      })
  }

  private setupContentChangeListener(): void {
    this.editBuffer.on("content-changed", this.contentChangeListener)
  }

  private deleteExtmarkById(id: number): void {
    const extmark = this.extmarks.get(id)
    if (extmark) {
      this.extmarks.delete(id)
      this.extmarksByTypeId.get(extmark.typeId)?.delete(id)
      this.metadata.delete(id)
    }
  }

  private findVirtualExtmarkContaining(offset: number): Extmark | null {
    for (const extmark of this.extmarks.values()) {
      if (extmark.virtual && offset >= extmark.start && offset < extmark.end) {
        return extmark
      }
    }
    return null
  }

  private adjustExtmarksAfterInsertion(insertOffset: number, length: number, updateHighlights = true): void {
    for (const extmark of this.extmarks.values()) {
      if (extmark.start >= insertOffset) {
        extmark.start += length
        extmark.end += length
      } else if (extmark.end > insertOffset) {
        extmark.end += length
      }
    }
    if (updateHighlights) this.updateHighlights()
  }

  public adjustExtmarksAfterDeletion(deleteOffset: number, length: number, updateHighlights = true): void {
    const toDelete: number[] = []

    for (const extmark of this.extmarks.values()) {
      if (extmark.end <= deleteOffset) {
        continue
      }

      if (extmark.start >= deleteOffset + length) {
        extmark.start -= length
        extmark.end -= length
      } else if (extmark.start >= deleteOffset && extmark.end <= deleteOffset + length) {
        toDelete.push(extmark.id)
      } else if (extmark.start < deleteOffset && extmark.end > deleteOffset + length) {
        extmark.end -= length
      } else if (extmark.start < deleteOffset && extmark.end > deleteOffset) {
        extmark.end -= Math.min(extmark.end, deleteOffset + length) - deleteOffset
      } else if (extmark.start < deleteOffset + length && extmark.end > deleteOffset + length) {
        const overlap = deleteOffset + length - extmark.start
        extmark.start = deleteOffset
        extmark.end -= length
      }
    }

    for (const id of toDelete) {
      this.deleteExtmarkById(id)
    }

    if (updateHighlights) this.updateHighlights()
  }

  private offsetToPosition(offset: number): { row: number; col: number } {
    const result = this.editBuffer.offsetToPosition(offset)
    if (!result) {
      return { row: 0, col: 0 }
    }
    return result
  }

  private positionToOffset(row: number, col: number): number {
    return this.editBuffer.positionToOffset(row, col)
  }

  private getNextCursorOffset(currentOffset: number): number {
    this.originalMoveCursorRight()
    const nextOffset = this.editorView.getVisualCursor().offset
    this.originalSetCursorByOffset(currentOffset)
    return nextOffset
  }

  private updateHighlights(): void {
    this.editBuffer.clearAllHighlights()
    let text: string | undefined

    for (const extmark of this.extmarks.values()) {
      if (extmark.styleId !== undefined) {
        text ??= this.editBuffer.getText()
        // extmark.start/end are display-width offsets including newlines (from cursor operations)
        // addHighlightByCharRange expects display-width offsets excluding newlines
        // So we need to subtract the number of newlines before each position
        const startWithoutNewlines = this.offsetExcludingNewlines(extmark.start, text)
        const endWithoutNewlines = this.offsetExcludingNewlines(extmark.end, text)

        this.editBuffer.addHighlightByCharRange({
          start: startWithoutNewlines,
          end: endWithoutNewlines,
          styleId: extmark.styleId,
          priority: extmark.priority ?? 0,
          hlRef: extmark.id & 0xffff,
        })
      }
    }
  }

  private offsetExcludingNewlines(offset: number, text: string): number {
    // offset is a display-width offset from the start of the buffer (includes newlines)
    // We need to convert to display-width excluding newlines
    // This means: subtract 1 for each newline encountered before this offset
    let displayWidthSoFar = 0
    let newlineCount = 0

    // Walk through the text and calculate display widths
    let i = 0
    while (i < text.length && displayWidthSoFar < offset) {
      if (text[i] === "\n") {
        displayWidthSoFar++ // newline counts as width 1 in cursor offset
        newlineCount++
        i++
      } else {
        // Find the next newline or end of string
        let j = i
        while (j < text.length && text[j] !== "\n") {
          j++
        }
        const chunk = text.substring(i, j)
        const chunkWidth = stringWidth(chunk)

        if (displayWidthSoFar + chunkWidth < offset) {
          // Entire chunk fits before offset
          displayWidthSoFar += chunkWidth
          i = j
        } else {
          // Offset is within this chunk - need to find exact position
          // Walk character by character
          for (let k = i; k < j && displayWidthSoFar < offset; k++) {
            const charWidth = stringWidth(text[k])
            displayWidthSoFar += charWidth
          }
          break
        }
      }
    }

    return offset - newlineCount
  }

  public create(options: ExtmarkOptions): number {
    if (this.destroyed) {
      throw new Error("ExtmarksController is destroyed")
    }

    const id = this.nextId++
    const typeId = options.typeId ?? 0
    const extmark: Extmark = {
      id,
      start: options.start,
      end: options.end,
      virtual: options.virtual ?? false,
      styleId: options.styleId,
      priority: options.priority,
      data: options.data,
      typeId,
    }

    this.extmarks.set(id, extmark)

    if (!this.extmarksByTypeId.has(typeId)) {
      this.extmarksByTypeId.set(typeId, new Set())
    }
    this.extmarksByTypeId.get(typeId)!.add(id)

    if (options.metadata !== undefined) {
      this.metadata.set(id, options.metadata)
    }

    this.updateHighlights()

    return id
  }

  public delete(id: number): boolean {
    if (this.destroyed) {
      throw new Error("ExtmarksController is destroyed")
    }

    const extmark = this.extmarks.get(id)
    if (!extmark) return false

    this.deleteExtmarkById(id)
    this.updateHighlights()

    return true
  }

  public get(id: number): Extmark | null {
    if (this.destroyed) return null
    return this.extmarks.get(id) ?? null
  }

  public getAll(): Extmark[] {
    if (this.destroyed) return []
    return Array.from(this.extmarks.values())
  }

  public getVirtual(): Extmark[] {
    if (this.destroyed) return []
    return Array.from(this.extmarks.values()).filter((e) => e.virtual)
  }

  public getAtOffset(offset: number): Extmark[] {
    if (this.destroyed) return []
    return Array.from(this.extmarks.values()).filter((e) => offset >= e.start && offset < e.end)
  }

  public getAllForTypeId(typeId: number): Extmark[] {
    if (this.destroyed) return []
    const ids = this.extmarksByTypeId.get(typeId)
    if (!ids) return []
    return Array.from(ids)
      .map((id) => this.extmarks.get(id))
      .filter((e): e is Extmark => e !== undefined)
  }

  public clear(): void {
    if (this.destroyed) return

    this.extmarks.clear()
    this.extmarksByTypeId.clear()
    this.metadata.clear()
    this.updateHighlights()
  }

  private saveSnapshot(): void {
    this.history.saveSnapshot(this.snapshotExtmarks(), this.nextId)
  }

  private snapshotExtmarks(): Map<number, Extmark & { metadata?: any }> {
    return new Map(Array.from(this.extmarks, ([id, extmark]) => [id, { ...extmark, metadata: this.metadata.get(id) }]))
  }

  private restoreSnapshot(snapshot: ExtmarksSnapshot): void {
    this.extmarks.clear()
    this.extmarksByTypeId.clear()
    this.metadata.clear()
    for (const [id, saved] of snapshot.extmarks) {
      const { metadata, ...extmark } = saved as Extmark & { metadata?: any }
      this.extmarks.set(id, extmark)
      if (!this.extmarksByTypeId.has(extmark.typeId)) {
        this.extmarksByTypeId.set(extmark.typeId, new Set())
      }
      this.extmarksByTypeId.get(extmark.typeId)!.add(id)
      if (metadata !== undefined) this.metadata.set(id, metadata)
    }
    this.nextId = snapshot.nextId
    this.updateHighlights()
  }

  private wrapUndoRedo(): void {
    this.editBuffer.undo = (): string | null =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed || !this.history.canUndo()) {
          return this.originalUndo()
        }

        const result = this.originalUndo()
        const currentSnapshot: ExtmarksSnapshot = {
          extmarks: this.snapshotExtmarks(),
          nextId: this.nextId,
        }
        this.history.pushRedo(currentSnapshot)

        const snapshot = this.history.undo()!
        this.restoreSnapshot(snapshot)

        return result
      })

    this.editBuffer.redo = (): string | null =>
      this.editBuffer.runMutation(() => {
        if (this.destroyed || !this.history.canRedo()) {
          return this.originalRedo()
        }

        const result = this.originalRedo()
        const currentSnapshot: ExtmarksSnapshot = {
          extmarks: this.snapshotExtmarks(),
          nextId: this.nextId,
        }
        this.history.pushUndo(currentSnapshot)

        const snapshot = this.history.redo()!
        this.restoreSnapshot(snapshot)

        return result
      })
  }

  public registerType(typeName: string): number {
    if (this.destroyed) {
      throw new Error("ExtmarksController is destroyed")
    }

    const existing = this.typeNameToId.get(typeName)
    if (existing !== undefined) {
      return existing
    }

    const typeId = this.nextTypeId++
    this.typeNameToId.set(typeName, typeId)
    this.typeIdToName.set(typeId, typeName)
    return typeId
  }

  public getTypeId(typeName: string): number | null {
    if (this.destroyed) return null
    return this.typeNameToId.get(typeName) ?? null
  }

  public getTypeName(typeId: number): string | null {
    if (this.destroyed) return null
    return this.typeIdToName.get(typeId) ?? null
  }

  public getMetadataFor(extmarkId: number): any {
    if (this.destroyed) return undefined
    return this.metadata.get(extmarkId)
  }

  public destroy(): void {
    if (this.destroyed) return
    this.editBuffer.off("content-changed", this.contentChangeListener)

    this.editBuffer.moveCursorLeft = this.originalMoveCursorLeft
    this.editBuffer.moveCursorRight = this.originalMoveCursorRight
    this.editBuffer.setCursorByOffset = this.originalSetCursorByOffset
    this.editorView.moveUpVisual = this.originalMoveUpVisual
    this.editorView.moveDownVisual = this.originalMoveDownVisual
    this.editBuffer.deleteCharBackward = this.originalDeleteCharBackward
    this.editBuffer.deleteChar = this.originalDeleteChar
    this.editBuffer.insertText = this.originalInsertText
    this.editBuffer.insertChar = this.originalInsertChar
    this.editBuffer.deleteRange = this.originalDeleteRange
    this.editBuffer.setText = this.originalSetText
    this.editBuffer.replaceText = this.originalReplaceText
    this.editBuffer.clear = this.originalClear
    this.editBuffer.newLine = this.originalNewLine
    this.editBuffer.deleteLine = this.originalDeleteLine
    this.editorView.deleteSelectedText = this.originalEditorViewDeleteSelectedText
    this.editorView._replaceSelectedText = this.originalEditorViewReplaceSelectedText
    this.editBuffer.undo = this.originalUndo
    this.editBuffer.redo = this.originalRedo

    this.extmarks.clear()
    this.extmarksByTypeId.clear()
    this.metadata.clear()
    this.typeNameToId.clear()
    this.typeIdToName.clear()
    this.history.clear()
    this.destroyed = true
  }
}

export function createExtmarksController(editBuffer: EditBuffer, editorView: EditorView): ExtmarksController {
  return new ExtmarksController(editBuffer, editorView)
}
