import type { EditBuffer } from "../edit-buffer.js"
import type { EditorView } from "../editor-view.js"
import { NativeEditMarkOperation, type NativeEditMark } from "../zig.js"

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

type BufferRules = Pick<
  EditBuffer,
  "moveCursorLeft" | "moveCursorRight" | "setCursorByOffset" | "deleteCharBackward" | "deleteChar"
>

// Payloads and type names belong to the buffer, as its marks do, so every controller of the buffer shares them and
// they outlive a controller. The newest live controller's rules are the ones installed on the buffer.
interface BufferState {
  payloads: Map<number, { data?: any; metadata?: any }>
  typeNameToId: Map<string, number>
  typeIdToName: Map<number, string>
  nextTypeId: number
  originals: BufferRules
  controllers: ExtmarksController[]
}

const states = new WeakMap<EditBuffer, BufferState>()

function bufferState(editBuffer: EditBuffer): BufferState {
  let state = states.get(editBuffer)
  if (state) return state
  const bind = <K extends keyof BufferRules>(name: K) => editBuffer[name].bind(editBuffer) as BufferRules[K]
  state = {
    payloads: new Map(),
    typeNameToId: new Map(),
    typeIdToName: new Map(),
    nextTypeId: 1,
    originals: {
      moveCursorLeft: bind("moveCursorLeft"),
      moveCursorRight: bind("moveCursorRight"),
      setCursorByOffset: bind("setCursorByOffset"),
      deleteCharBackward: bind("deleteCharBackward"),
      deleteChar: bind("deleteChar"),
    },
    controllers: [],
  }
  states.set(editBuffer, state)
  const payloads = state.payloads
  editBuffer._onHistoryReset = () => payloads.clear()
  return state
}

// A u32, as native ids, kinds, styles, priorities and offsets are.
function isU32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff
}

/**
 * Extmarks live in the native edit buffer, which moves them with edits and restores them with undo and redo. Ids are
 * never reused. Text inserted strictly inside a virtual extmark, or an edit that removes part of it, drops it.
 * Use with caution: the cursor rules around virtual extmarks are still applied here.
 */
export class ExtmarksController {
  private editBuffer: EditBuffer
  private editorView: EditorView
  // Payloads stay while undo can restore their marks; only live ids read them.
  private state: BufferState
  private rules = {} as BufferRules
  private destroyed = false

  private originalMoveCursorLeft: typeof EditBuffer.prototype.moveCursorLeft
  private originalMoveCursorRight: typeof EditBuffer.prototype.moveCursorRight
  private originalSetCursorByOffset: typeof EditBuffer.prototype.setCursorByOffset
  private originalMoveUpVisual: typeof EditorView.prototype.moveUpVisual
  private originalMoveDownVisual: typeof EditorView.prototype.moveDownVisual
  private originalDeleteCharBackward: typeof EditBuffer.prototype.deleteCharBackward
  private originalDeleteChar: typeof EditBuffer.prototype.deleteChar

  constructor(editBuffer: EditBuffer, editorView: EditorView) {
    this.editBuffer = editBuffer
    this.editorView = editorView
    this.state = bufferState(editBuffer)

    const originals = this.state.originals
    this.originalMoveCursorLeft = originals.moveCursorLeft
    this.originalMoveCursorRight = originals.moveCursorRight
    this.originalSetCursorByOffset = originals.setCursorByOffset
    this.originalMoveUpVisual = editorView.moveUpVisual.bind(editorView)
    this.originalMoveDownVisual = editorView.moveDownVisual.bind(editorView)
    this.originalDeleteCharBackward = originals.deleteCharBackward
    this.originalDeleteChar = originals.deleteChar

    this.wrapCursorMovement()
    this.wrapDeletion()
    this.state.controllers.push(this)
    Object.assign(editBuffer, this.rules)
  }

  private wrapCursorMovement(): void {
    this.rules.moveCursorLeft = (): void => {
      const currentOffset = this.editBuffer.getCursorPosition().offset
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

      const marks = this.virtualMarks()
      const virtualExtmark = findContaining(marks, targetOffset)
      if (virtualExtmark && currentOffset >= virtualExtmark.end) {
        this.moveBefore(marks, virtualExtmark)
        return
      }

      this.originalMoveCursorLeft()
    }

    this.rules.moveCursorRight = (): void => {
      const currentOffset = this.editBuffer.getCursorPosition().offset
      const hasSelection = this.editorView.hasSelection()

      if (hasSelection) {
        this.originalMoveCursorRight()
        return
      }

      const targetOffset = currentOffset + 1
      // A target past the end of the buffer has no position.
      if (this.editBuffer.offsetToPosition(targetOffset) === null) {
        this.originalMoveCursorRight()
        return
      }

      const virtualExtmark = findContaining(this.virtualMarks(), targetOffset)
      if (virtualExtmark && currentOffset <= virtualExtmark.start) {
        this.editBuffer.setCursorByOffset(virtualExtmark.end)
        return
      }

      this.originalMoveCursorRight()
    }

    this.editorView.moveUpVisual = (): void => {
      if (this.editorView.hasSelection()) {
        this.originalMoveUpVisual()
        return
      }
      this.originalMoveUpVisual()
      this.leaveVirtualExtmark()
    }

    this.editorView.moveDownVisual = (): void => {
      if (this.editorView.hasSelection()) {
        this.originalMoveDownVisual()
        return
      }
      const currentOffset = this.editBuffer.getCursorPosition().offset
      this.originalMoveDownVisual()
      this.leaveVirtualExtmark(currentOffset)
    }

    this.rules.setCursorByOffset = (offset: number): void => {
      const currentOffset = this.editBuffer.getCursorPosition().offset
      const hasSelection = this.editorView.hasSelection()

      if (hasSelection) {
        this.originalSetCursorByOffset(offset)
        return
      }

      const movingForward = offset > currentOffset
      const marks = this.virtualMarks()

      if (movingForward) {
        const virtualExtmark = findContaining(marks, offset)
        if (virtualExtmark && currentOffset <= virtualExtmark.start) {
          this.originalSetCursorByOffset(virtualExtmark.end)
          return
        }
      } else {
        for (const extmark of marks) {
          if (currentOffset >= extmark.end && offset < extmark.end && offset >= extmark.start) {
            this.moveBefore(marks, extmark)
            return
          }
        }
      }

      this.originalSetCursorByOffset(offset)
    }
  }

  // Left from the start lands on the start of the character before, even a wide one or a tab, or before a mark there.
  private moveBefore(marks: NativeEditMark[], extmark: NativeEditMark): void {
    this.originalSetCursorByOffset(extmark.start)
    this.originalMoveCursorLeft()
    const inside = findContaining(marks, this.editBuffer.getCursorPosition().offset)
    if (inside && inside.start < extmark.start) this.moveBefore(marks, inside)
  }

  // A cursor that Up or Down put inside a virtual extmark goes to its nearer edge, but never back to `from` or before it.
  private leaveVirtualExtmark(from = -1): void {
    const offset = this.editBuffer.getCursorPosition().offset
    const marks = this.virtualMarks()
    const extmark = findContaining(marks, offset)
    if (!extmark) return
    if (offset - extmark.start < extmark.end - offset) {
      this.moveBefore(marks, extmark)
      if (this.editBuffer.getCursorPosition().offset > from) return
    }
    this.originalSetCursorByOffset(outside(marks, extmark.end, 1))
  }

  /**
   * @internal A cursor that a wheel step, a pointer or the offset setter left inside virtual extmarks goes to the
   * outer edge of the marks around it: toward the end for a positive `direction`, the start for a negative one, or the
   * nearer edge, as the Rust editor's. Not while a selection is left: it holds the cursor at its focus.
   */
  public _keepCursorOutside(direction: number): void {
    if (this.destroyed) return
    const marks = this.virtualMarks()
    if (marks.length === 0 || this.editorView.hasSelection()) return
    const offset = this.editBuffer.getCursorPosition().offset
    const start = outside(marks, offset, -1)
    if (start === offset) return
    const end = outside(marks, offset, 1)
    const toEnd = direction === 0 ? end - offset <= offset - start : direction > 0
    this.originalSetCursorByOffset(toEnd ? end : start)
  }

  private wrapDeletion(): void {
    // Backspace at a virtual extmark's end and Delete at its start delete the whole mark, which drops it.
    const deleteWhole = (edge: "start" | "end", original: () => void): void => {
      if (this.editorView.hasSelection()) return original()
      const offset = this.editBuffer.getCursorPosition().offset
      const extmark = findContaining(this.virtualMarks(), edge === "end" ? offset - 1 : offset)
      if (!extmark || extmark[edge] !== offset) return original()
      const start = this.editBuffer.offsetToPosition(extmark.start)!
      const end = this.editBuffer.offsetToPosition(extmark.end)!
      this.editBuffer.deleteRange(start.row, start.col, end.row, end.col)
    }

    this.rules.deleteCharBackward = (): void =>
      this.editBuffer.runMutation(() => deleteWhole("end", this.originalDeleteCharBackward))

    this.rules.deleteChar = (): void => this.editBuffer.runMutation(() => deleteWhole("start", this.originalDeleteChar))
  }

  // The rules see overlapping marks in creation order.
  private virtualMarks(): NativeEditMark[] {
    return this.editBuffer
      ._getMarks()
      .filter((mark) => mark.atomic)
      .sort((a, b) => a.id - b.id)
  }

  private toExtmark(mark: NativeEditMark): Extmark {
    return {
      id: mark.id,
      start: mark.start,
      end: mark.end,
      virtual: mark.atomic,
      styleId: mark.style || undefined,
      priority: mark.priority,
      data: this.state.payloads.get(mark.id)?.data,
      typeId: mark.kind,
    }
  }

  public create(options: ExtmarkOptions): number {
    if (this.destroyed) {
      throw new Error("ExtmarksController is destroyed")
    }

    const { start, end, typeId = 0, styleId = 0, priority = 0 } = options
    // A malformed range or field adds nothing, as a lookup of a missing mark finds nothing; offsets past the text mean
    // its end.
    const offset = (value: number) => (Number.isInteger(value) && value >= 0 ? Math.min(value, 0xffffffff) : -1)
    const [from, to] = [offset(start), offset(end)]
    if (from < 0 || to < from || !isU32(typeId) || !isU32(styleId) || !isU32(priority)) return 0
    const id = this.editBuffer._mark(NativeEditMarkOperation.Add, {
      kind: typeId,
      atomic: options.virtual ?? false,
      style: styleId,
      priority,
      start: from,
      end: to,
    })
    if (options.data !== undefined || options.metadata !== undefined) {
      this.state.payloads.set(id, { data: options.data, metadata: options.metadata })
    }
    return id
  }

  public delete(id: number): boolean {
    if (this.destroyed) {
      throw new Error("ExtmarksController is destroyed")
    }
    return isU32(id) && id !== 0 && this.editBuffer._mark(NativeEditMarkOperation.Remove, { id }) !== 0
  }

  // Native reads id 0 and kind 0xffffffff as wildcards; the public queries are exact.
  public get(id: number): Extmark | null {
    if (this.gone || !isU32(id) || id === 0) return null
    const [mark] = this.editBuffer._getMarks(id)
    return mark ? this.toExtmark(mark) : null
  }

  public getAll(): Extmark[] {
    if (this.gone) return []
    return this.editBuffer._getMarks().map((mark) => this.toExtmark(mark))
  }

  public getVirtual(): Extmark[] {
    return this.getAll().filter((e) => e.virtual)
  }

  public getAtOffset(offset: number): Extmark[] {
    return this.getAll().filter((e) => offset >= e.start && offset < e.end)
  }

  public getAllForTypeId(typeId: number): Extmark[] {
    if (this.gone || !isU32(typeId)) return []
    return this.editBuffer
      ._getMarks(0, typeId)
      .filter((mark) => mark.kind === typeId)
      .map((mark) => this.toExtmark(mark))
  }

  public clear(): void {
    if (this.gone) return
    this.editBuffer._mark(NativeEditMarkOperation.Clear)
  }

  public registerType(typeName: string): number {
    if (this.destroyed) {
      throw new Error("ExtmarksController is destroyed")
    }

    const state = this.state
    const existing = state.typeNameToId.get(typeName)
    if (existing !== undefined) {
      return existing
    }

    const typeId = state.nextTypeId++
    state.typeNameToId.set(typeName, typeId)
    state.typeIdToName.set(typeId, typeName)
    return typeId
  }

  public getTypeId(typeName: string): number | null {
    if (this.destroyed) return null
    return this.state.typeNameToId.get(typeName) ?? null
  }

  public getTypeName(typeId: number): string | null {
    if (this.destroyed) return null
    return this.state.typeIdToName.get(typeId) ?? null
  }

  public getMetadataFor(extmarkId: number): any {
    if (!this.get(extmarkId)) return undefined
    return this.state.payloads.get(extmarkId)?.metadata
  }

  private get gone(): boolean {
    return this.destroyed || this.editBuffer.isDestroyed
  }

  /** Restores the methods it wrapped. The marks, their payloads and the type names stay with the buffer. */
  public destroy(): void {
    if (this.destroyed) return

    this.editorView.moveUpVisual = this.originalMoveUpVisual
    this.editorView.moveDownVisual = this.originalMoveDownVisual
    const { controllers, originals } = this.state
    controllers.splice(controllers.indexOf(this), 1)
    Object.assign(this.editBuffer, controllers.at(-1)?.rules ?? originals)
    this.destroyed = true
  }
}

function findContaining(marks: NativeEditMark[], offset: number): NativeEditMark | undefined {
  return marks.find((mark) => offset >= mark.start && offset < mark.end)
}

// The first offset from `offset` toward `direction` that no virtual extmark strictly contains.
function outside(marks: NativeEditMark[], offset: number, direction: number): number {
  for (let inside = true; inside; ) {
    inside = false
    for (const extmark of marks) {
      if (extmark.start < offset && offset < extmark.end) {
        offset = direction > 0 ? extmark.end : extmark.start
        inside = true
      }
    }
  }
  return offset
}

export function createExtmarksController(editBuffer: EditBuffer, editorView: EditorView): ExtmarksController {
  return new ExtmarksController(editBuffer, editorView)
}
