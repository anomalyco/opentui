import type { EditBuffer } from "../edit-buffer.js"
import type { EditorView } from "../editor-view.js"
import { NativeEditMarkOperation, type NativeEditMark } from "../zig.js"

export interface Extmark {
  id: number
  /** Inclusive document cell offset, counting one cell per newline. */
  start: number // Display-width offset (including newlines), NOT JS string index
  /** Exclusive document cell offset, counting one cell per newline. */
  end: number // Display-width offset (including newlines), NOT JS string index
  virtual: boolean
  styleId?: number
  priority?: number
  data?: any
  typeId: number
}

export interface ExtmarkOptions {
  /** Inclusive document cell offset, counting one cell per newline. */
  start: number // Display-width offset (including newlines), NOT JS string index
  /** Exclusive document cell offset, counting one cell per newline. */
  end: number // Display-width offset (including newlines), NOT JS string index
  virtual?: boolean
  styleId?: number
  priority?: number
  data?: any
  typeId?: number
  metadata?: any
}

// Payloads and type names belong to the buffer, as its marks do, so every controller of the buffer shares them and
// they outlive a controller. The newest live controller's view decides when the buffer's cursor rules apply.
interface BufferState {
  payloads: Map<number, { data?: any; metadata?: any }>
  typeNameToId: Map<string, number>
  typeIdToName: Map<number, string>
  nextTypeId: number
  controllers: ExtmarksController[]
}

const states = new WeakMap<EditBuffer, BufferState>()

function bufferState(editBuffer: EditBuffer): BufferState {
  let state = states.get(editBuffer)
  if (state) return state
  state = { payloads: new Map(), typeNameToId: new Map(), typeIdToName: new Map(), nextTypeId: 1, controllers: [] }
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
 * never reused. Text inserted strictly inside a virtual extmark, or an edit that removes part of it, drops it. While a
 * controller lives and its view has no selection, the buffer's Left, Right, Backspace, Delete and offset setter and the
 * view's Up and Down apply the native cursor rules around virtual extmarks.
 */
export class ExtmarksController {
  private editBuffer: EditBuffer
  private editorView: EditorView
  // Payloads stay while undo can restore their marks; only live ids read them.
  private state: BufferState
  private destroyed = false
  private readonly atomic = (): boolean => !this.editorView.hasSelection()

  constructor(editBuffer: EditBuffer, editorView: EditorView) {
    this.editBuffer = editBuffer
    this.editorView = editorView
    this.state = bufferState(editBuffer)
    this.state.controllers.push(this)
    editBuffer._atomic = this.atomic
    editorView._atomic = true
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

  /** Marks a half-open document cell range, counting one cell per newline. Returns a mark ID. */
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

  /** Looks up marks covering a document cell offset, counting one cell per newline. */
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

  /** Stops the cursor rules for its view. The marks, their payloads and the type names stay with the buffer. */
  public destroy(): void {
    if (this.destroyed) return

    const controllers = this.state.controllers
    controllers.splice(controllers.indexOf(this), 1)
    this.editorView._atomic = controllers.some((controller) => controller.editorView === this.editorView)
    this.editBuffer._atomic = controllers.at(-1)?.atomic
    this.destroyed = true
  }
}

export function createExtmarksController(editBuffer: EditBuffer, editorView: EditorView): ExtmarksController {
  return new ExtmarksController(editBuffer, editorView)
}
