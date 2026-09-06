import { runRenderableMutation } from "../lib/renderable-layout.js"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import { convertGlobalToLocalSelection, Selection, type LocalSelectionBounds } from "../lib/selection.js"
import { EditBuffer, type LogicalCursor } from "../edit-buffer.js"
import { EditorView, type VisualCursor } from "../editor-view.js"
import { RGBA, parseColor } from "../lib/RGBA.js"
import type {
  RenderContext,
  Highlight,
  CursorStyleOptions,
  LineInfoProvider,
  LineInfo,
  SelectionOccupancy,
} from "../types.js"
import type { OptimizedBuffer } from "../buffer.js"
import type { SyntaxStyle } from "../syntax-style.js"
import type { NativeSceneEditorOptions } from "../zig.js"

const BrandedEditBufferRenderable: unique symbol = Symbol.for("@opentui/core/EditBufferRenderable")

export type EditorCapture = "escape" | "navigate" | "submit" | "tab"

export interface EditorTraits {
  capture?: readonly EditorCapture[]
  suspend?: boolean
  status?: string
}

export enum EditBufferRenderableEvents {
  TRAITS_CHANGED = "traits-changed",
}

function sameCapture(a?: readonly EditorCapture[], b?: readonly EditorCapture[]) {
  if (a === b) return true
  if (!a || !b) return !a && !b
  if (a.length !== b.length) return false
  return a.every((item, i) => item === b[i])
}

function sameTraits(a: EditorTraits, b: EditorTraits) {
  return a.suspend === b.suspend && a.status === b.status && sameCapture(a.capture, b.capture)
}

export function isEditBufferRenderable(obj: unknown): obj is EditBufferRenderable {
  return !!(obj && typeof obj === "object" && BrandedEditBufferRenderable in obj)
}

export interface CursorChangeEvent {
  line: number
  visualColumn: number
}

export interface ContentChangeEvent {
  // No payload - use getText() to retrieve content if needed
}

export interface EditBufferOptions extends RenderableOptions<EditBufferRenderable> {
  textColor?: string | RGBA
  backgroundColor?: string | RGBA
  selectionBg?: string | RGBA
  selectionFg?: string | RGBA
  selectable?: boolean
  attributes?: number
  wrapMode?: "none" | "char" | "word"
  scrollMargin?: number
  scrollSpeed?: number
  showCursor?: boolean
  cursorColor?: string | RGBA
  cursorStyle?: CursorStyleOptions
  selectionOccupancy?: SelectionOccupancy
  syntaxStyle?: SyntaxStyle
  tabIndicator?: string | number
  tabIndicatorColor?: string | RGBA
  onCursorChange?: (event: CursorChangeEvent) => void
  onContentChange?: (event: ContentChangeEvent) => void
}

export abstract class EditBufferRenderable extends Renderable implements LineInfoProvider {
  [BrandedEditBufferRenderable] = true
  protected _focusable: boolean = true
  private _traits: EditorTraits = {}

  protected _textColor: RGBA
  protected _backgroundColor: RGBA
  protected _defaultAttributes: number
  protected _selectionBg: RGBA | undefined
  protected _selectionFg: RGBA | undefined
  protected _wrapMode: "none" | "char" | "word" = "word"
  protected _scrollMargin: number = 0.2
  protected _showCursor: boolean = true
  protected _cursorColor: RGBA
  protected _cursorStyle: CursorStyleOptions
  protected lastLocalSelection: LocalSelectionBounds | null = null
  protected _tabIndicator?: string | number
  protected _tabIndicatorColor?: RGBA

  private _cursorChangeListener: ((event: CursorChangeEvent) => void) | undefined = undefined
  private _contentChangeListener: ((event: ContentChangeEvent) => void) | undefined = undefined

  private _autoScrollVelocity: number = 0
  private _autoScrollAccumulator: number = 0
  private _scrollSpeed: number = 16
  private _keyboardSelectionActive: boolean = false

  public readonly editBuffer: EditBuffer
  public readonly editorView: EditorView

  protected _defaultOptions = {
    textColor: RGBA.fromValues(1, 1, 1, 1),
    backgroundColor: "transparent",
    selectionBg: undefined,
    selectionFg: undefined,
    selectable: true,
    attributes: 0,
    wrapMode: "word" as "none" | "char" | "word",
    scrollMargin: 0.2,
    scrollSpeed: 16,
    showCursor: true,
    cursorColor: RGBA.fromValues(1, 1, 1, 1),
    cursorStyle: {
      style: "block",
      blinking: true,
    },
    tabIndicator: undefined,
    tabIndicatorColor: undefined,
  } satisfies Partial<EditBufferOptions>

  constructor(ctx: RenderContext, options: EditBufferOptions) {
    super(ctx, options)

    let editBuffer: EditBuffer | undefined
    let editorView: EditorView | undefined

    try {
      this._textColor = RGBA.clone(parseColor(options.textColor ?? this._defaultOptions.textColor))
      this._backgroundColor = RGBA.clone(parseColor(options.backgroundColor ?? this._defaultOptions.backgroundColor))
      this._defaultAttributes = options.attributes ?? this._defaultOptions.attributes
      this._selectionBg = options.selectionBg ? RGBA.clone(parseColor(options.selectionBg)) : undefined
      this._selectionFg = options.selectionFg ? RGBA.clone(parseColor(options.selectionFg)) : undefined
      this.selectable = options.selectable ?? this._defaultOptions.selectable
      this._wrapMode = options.wrapMode ?? this._defaultOptions.wrapMode
      this._scrollMargin = options.scrollMargin ?? this._defaultOptions.scrollMargin
      this._scrollSpeed = options.scrollSpeed ?? this._defaultOptions.scrollSpeed
      this._showCursor = options.showCursor ?? this._defaultOptions.showCursor
      this._cursorColor = RGBA.clone(parseColor(options.cursorColor ?? this._defaultOptions.cursorColor))
      this._cursorStyle = { ...(options.cursorStyle ?? this._defaultOptions.cursorStyle) }
      if (this._cursorStyle.color) this._cursorStyle.color = RGBA.clone(this._cursorStyle.color)
      this._tabIndicator = options.tabIndicator ?? this._defaultOptions.tabIndicator
      this._tabIndicatorColor = options.tabIndicatorColor
        ? RGBA.clone(parseColor(options.tabIndicatorColor))
        : this._defaultOptions.tabIndicatorColor

      editBuffer = EditBuffer.create(this._ctx.widthMethod, this._ctx.nativeScene)
      this.editBuffer = editBuffer
      editorView = EditorView.create(
        editBuffer,
        Math.max(1, Math.trunc(this.width || 80)),
        Math.max(1, Math.trunc(this.height || 24)),
      )
      this.editorView = editorView

      this.editorView.setWrapMode(this._wrapMode)
      this.editorView.setScrollMargin(this._scrollMargin)
      if (options.selectionOccupancy === "boundary") {
        this.editorView.setSelectionOccupancy("boundary")
      }

      this.editBuffer.setDefaultFg(this._textColor)
      this.editBuffer.setDefaultBg(this._backgroundColor)
      this.editBuffer.setDefaultAttributes(this._defaultAttributes)

      if (options.syntaxStyle) {
        this.editBuffer.setSyntaxStyle(options.syntaxStyle)
      }

      if (this._tabIndicator !== undefined) {
        this.editorView.setTabIndicator(this._tabIndicator)
      }
      if (this._tabIndicatorColor !== undefined) {
        this.editorView.setTabIndicatorColor(this._tabIndicatorColor)
      }

      this._ctx.nativeScene.setEditorView(this, this.editorView._getSceneHandle(this._ctx.nativeScene))
      this.setNativeEditorOptions()
      this.setupEventListeners(options)
    } catch (error) {
      this.abortConstruction(error, (run) => {
        run(() => editorView?.destroy())
        run(() => editBuffer?.destroy())
      })
    }
  }

  public get lineInfo(): LineInfo {
    return this.editorView.getLogicalLineInfo()
  }

  private setupEventListeners(options: EditBufferOptions): void {
    this._cursorChangeListener = options.onCursorChange
    this._contentChangeListener = options.onContentChange

    this.editBuffer.on("cursor-changed", () => {
      if (this._cursorChangeListener) {
        const cursor = this.editBuffer.getCursorPosition()
        this._cursorChangeListener({
          line: cursor.row,
          visualColumn: cursor.col,
        })
      }
    })

    this.editBuffer.on("content-changed", () => {
      this.requestRender()
      this.emit("line-info-change")
      if (this._contentChangeListener) {
        this._contentChangeListener({})
      }
    })
  }

  public get lineCount(): number {
    return this.editBuffer.getLineCount()
  }

  public get virtualLineCount(): number {
    return this.editorView.getVirtualLineCount()
  }

  public get scrollY(): number {
    return this.editorView.getViewport().offsetY
  }

  get plainText(): string {
    return this.editBuffer.getText()
  }

  get logicalCursor(): LogicalCursor {
    return this.editBuffer.getCursorPosition()
  }

  get visualCursor(): VisualCursor {
    return this.editorView.getVisualCursor()
  }

  get cursorOffset(): number {
    return this.editorView.getVisualCursor().offset
  }

  set cursorOffset(offset: number) {
    this.clearSelection()
    this.editorView.setCursorByOffset(offset)
    this.requestRender()
  }

  get cursorCharacterOffset(): number | undefined {
    const len = this.plainText.length
    if (len <= 0) return

    const cursor = this.logicalCursor
    const offset = this.cursorOffset
    if (offset >= len) {
      if (cursor.col > 0) return len - 1
      return 0
    }

    if (this.plainText[offset] === "\n" && cursor.col > 0) {
      return offset - 1
    }

    return offset
  }

  get textColor(): RGBA {
    return RGBA.clone(this._textColor)
  }

  set textColor(value: RGBA | string | undefined) {
    const newColor = RGBA.clone(parseColor(value ?? this._defaultOptions.textColor))
    this.editBuffer.setDefaultFg(newColor)
    this._textColor = newColor
    this.requestRender()
  }

  get selectionBg(): RGBA | undefined {
    return this._selectionBg ? RGBA.clone(this._selectionBg) : undefined
  }

  get traits(): EditorTraits {
    return this._traits
  }

  set traits(value: EditorTraits) {
    if (sameTraits(this._traits, value)) return
    const prev = this._traits
    this._traits = value
    this.emit(EditBufferRenderableEvents.TRAITS_CHANGED, value, prev)
  }

  set selectionBg(value: RGBA | string | undefined) {
    const newColor = value ? RGBA.clone(parseColor(value)) : undefined
    if (this._selectionBg !== newColor) {
      this.editorView.setSelectionColors(newColor, this._selectionFg)
      this._selectionBg = newColor
      this.requestRender()
    }
  }

  get selectionFg(): RGBA | undefined {
    return this._selectionFg ? RGBA.clone(this._selectionFg) : undefined
  }

  set selectionFg(value: RGBA | string | undefined) {
    const newColor = value ? RGBA.clone(parseColor(value)) : undefined
    if (this._selectionFg !== newColor) {
      this.editorView.setSelectionColors(this._selectionBg, newColor)
      this._selectionFg = newColor
      this.requestRender()
    }
  }

  get backgroundColor(): RGBA {
    return RGBA.clone(this._backgroundColor)
  }

  set backgroundColor(value: RGBA | string | undefined) {
    const newColor = RGBA.clone(parseColor(value ?? this._defaultOptions.backgroundColor))
    this.editBuffer.setDefaultBg(newColor)
    this._backgroundColor = newColor
    this.requestRender()
  }

  get attributes(): number {
    return this._defaultAttributes
  }

  set attributes(value: number | undefined) {
    const attributes = value ?? this._defaultOptions.attributes
    if (this._defaultAttributes !== attributes) {
      runRenderableMutation(this, () => {
        this.editBuffer.setDefaultAttributes(attributes)
        this._defaultAttributes = attributes
        this.requestRender()
      })
    }
  }

  get wrapMode(): "none" | "char" | "word" {
    return this._wrapMode
  }

  set wrapMode(value: "none" | "char" | "word") {
    if (this._wrapMode !== value) {
      runRenderableMutation(this, () => {
        this.editorView.setWrapMode(value)
        this._wrapMode = value
        this.requestRender()
      })
    }
  }

  get showCursor(): boolean {
    return this._showCursor
  }

  set showCursor(value: boolean) {
    if (this._showCursor !== value) {
      this.setNativeEditorOptions({ showCursor: value })
      this._showCursor = value
      this.requestRender()
    }
  }

  get cursorColor(): RGBA {
    return RGBA.clone(this._cursorColor)
  }

  set cursorColor(value: RGBA | string) {
    const newColor = RGBA.clone(parseColor(value))
    this.setNativeEditorOptions({ color: newColor })
    this._cursorColor = newColor
    if (this._focused) {
      this.requestRender()
    }
  }

  get cursorStyle(): CursorStyleOptions {
    return { ...this._cursorStyle, color: this._cursorStyle.color ? RGBA.clone(this._cursorStyle.color) : undefined }
  }

  set cursorStyle(style: CursorStyleOptions) {
    const newStyle = { ...style, color: style.color ? RGBA.clone(style.color) : undefined }
    if (
      this._cursorStyle.style !== newStyle.style ||
      this._cursorStyle.blinking !== newStyle.blinking ||
      this._cursorStyle.cursor !== newStyle.cursor
    ) {
      this.setNativeEditorOptions({
        style: newStyle.style ?? "block",
        blinking: newStyle.blinking ?? true,
        cursor: newStyle.cursor,
      })
      this._cursorStyle = newStyle
      if (this._focused) {
        this.requestRender()
      }
    }
  }

  get selectionOccupancy(): SelectionOccupancy {
    return this.editorView.getSelectionOccupancy()
  }

  set selectionOccupancy(value: SelectionOccupancy | null | undefined) {
    const occupancy = value ?? "cell"
    if (this.selectionOccupancy === occupancy) return
    this.editorView.setSelectionOccupancy(occupancy)
    this.requestRender()
  }

  get tabIndicator(): string | number | undefined {
    return this._tabIndicator
  }

  set tabIndicator(value: string | number | undefined) {
    if (this._tabIndicator !== value) {
      this._tabIndicator = value
      if (value !== undefined) {
        this.editorView.setTabIndicator(value)
      }
      this.requestRender()
    }
  }

  get tabIndicatorColor(): RGBA | undefined {
    return this._tabIndicatorColor ? RGBA.clone(this._tabIndicatorColor) : undefined
  }

  set tabIndicatorColor(value: RGBA | string | undefined) {
    const newColor = value ? RGBA.clone(parseColor(value)) : undefined
    if (this._tabIndicatorColor !== newColor) {
      if (newColor !== undefined) {
        this.editorView.setTabIndicatorColor(newColor)
      }
      this._tabIndicatorColor = newColor
      this.requestRender()
    }
  }

  get scrollSpeed(): number {
    return this._scrollSpeed
  }

  set scrollSpeed(value: number) {
    this._scrollSpeed = Math.max(0, value)
  }

  protected override onMouseEvent(event: any): void {
    if (event.type === "scroll") {
      this.handleScroll(event)
    }
  }

  protected handleScroll(event: any): void {
    if (!event.scroll) return

    const { direction, delta } = event.scroll
    const viewport = this.editorView.getViewport()

    if (direction === "up") {
      const newOffsetY = Math.max(0, viewport.offsetY - delta)
      this.editorView.setViewport(viewport.offsetX, newOffsetY, viewport.width, viewport.height, true)
      this.requestRender()
    } else if (direction === "down") {
      const totalVirtualLines = this.editorView.getTotalVirtualLineCount()
      const maxOffsetY = Math.max(0, totalVirtualLines - viewport.height)
      const newOffsetY = Math.min(viewport.offsetY + delta, maxOffsetY)
      this.editorView.setViewport(viewport.offsetX, newOffsetY, viewport.width, viewport.height, true)
      this.requestRender()
    }

    if (this._wrapMode === "none") {
      if (direction === "left") {
        const newOffsetX = Math.max(0, viewport.offsetX - delta)
        this.editorView.setViewport(newOffsetX, viewport.offsetY, viewport.width, viewport.height, true)
        this.requestRender()
      } else if (direction === "right") {
        const newOffsetX = viewport.offsetX + delta
        this.editorView.setViewport(newOffsetX, viewport.offsetY, viewport.width, viewport.height, true)
        this.requestRender()
      }
    }
  }

  protected onResize(width: number, height: number): void {
    this.editorView.setViewportSize(width, height)
  }

  protected refreshLocalSelection(): boolean {
    if (this.lastLocalSelection) {
      return this.updateLocalSelection(this.lastLocalSelection)
    }
    return false
  }

  private updateLocalSelection(localSelection: LocalSelectionBounds | null): boolean {
    if (!localSelection?.isActive) {
      this.editorView.resetLocalSelection()
      return true
    }
    return this.editorView.setLocalSelection(
      localSelection.anchorX,
      localSelection.anchorY,
      localSelection.focusX,
      localSelection.focusY,
      this._selectionBg,
      this._selectionFg,
      false,
      false,
      localSelection.behavior,
    )
  }

  shouldStartSelection(x: number, y: number): boolean {
    if (!this.selectable) return false

    const localX = x - this.x
    const localY = y - this.y

    return localX >= 0 && localX < this.width && localY >= 0 && localY < this.height
  }

  onSelectionChanged(selection: Selection | null): boolean {
    const localSelection = convertGlobalToLocalSelection(selection, Math.trunc(this.x), Math.trunc(this.y))
    this.lastLocalSelection = localSelection

    const updateCursor = true
    const followCursor = this._keyboardSelectionActive

    let changed: boolean
    if (!localSelection?.isActive) {
      this._keyboardSelectionActive = false
      this.editorView.resetLocalSelection()
      changed = true
    } else if (selection?.isStart) {
      changed = this.editorView.setLocalSelection(
        localSelection.anchorX,
        localSelection.anchorY,
        localSelection.focusX,
        localSelection.focusY,
        this._selectionBg,
        this._selectionFg,
        updateCursor,
        followCursor,
        localSelection.behavior,
      )
    } else {
      changed = this.editorView.updateLocalSelection(
        localSelection.anchorX,
        localSelection.anchorY,
        localSelection.focusX,
        localSelection.focusY,
        this._selectionBg,
        this._selectionFg,
        updateCursor,
        followCursor,
        localSelection.behavior,
      )
    }

    const previousVelocity = this._autoScrollVelocity
    const previousAccumulator = this._autoScrollAccumulator
    if (changed && localSelection?.isActive && selection?.isDragging) {
      const viewport = this.editorView.getViewport()
      const focusY = localSelection.focusY
      const scrollMargin = Math.max(1, Math.floor(viewport.height * this._scrollMargin))

      if (focusY < scrollMargin) {
        this._autoScrollVelocity = -this._scrollSpeed
      } else if (focusY >= viewport.height - scrollMargin) {
        this._autoScrollVelocity = this._scrollSpeed
      } else {
        this._autoScrollVelocity = 0
      }
    } else {
      this._keyboardSelectionActive = false
      this._autoScrollVelocity = 0
      this._autoScrollAccumulator = 0
    }

    if ((previousVelocity !== 0) !== this._needsAutoScrollUpdate) {
      const generation = this._nativeSceneHookGeneration
      try {
        this.refreshNativeSceneHooks()
      } catch (error) {
        if (generation === this._nativeSceneHookGeneration) {
          this._autoScrollVelocity = previousVelocity
          this._autoScrollAccumulator = previousAccumulator
        }
        throw error
      }
    }

    if (changed) {
      this.requestRender()
    }

    return this.hasSelection()
  }

  /** @internal */
  get _needsAutoScrollUpdate(): boolean {
    return (this._autoScrollVelocity ?? 0) !== 0
  }

  protected override onUpdate(deltaTime: number): void {
    super.onUpdate(deltaTime)

    if (this._autoScrollVelocity !== 0 && this.hasSelection()) {
      const deltaSeconds = deltaTime / 1000
      this._autoScrollAccumulator += this._autoScrollVelocity * deltaSeconds

      const linesToScroll = Math.floor(Math.abs(this._autoScrollAccumulator))
      if (linesToScroll > 0) {
        const direction = this._autoScrollVelocity > 0 ? 1 : -1
        const viewport = this.editorView.getViewport()
        const totalVirtualLines = this.editorView.getTotalVirtualLineCount()
        const maxOffsetY = Math.max(0, totalVirtualLines - viewport.height)
        const newOffsetY = Math.max(0, Math.min(viewport.offsetY + direction * linesToScroll, maxOffsetY))

        if (newOffsetY !== viewport.offsetY) {
          this.editorView.setViewport(viewport.offsetX, newOffsetY, viewport.width, viewport.height, false)

          this._ctx.requestSelectionUpdate()
        }

        this._autoScrollAccumulator -= direction * linesToScroll
      }
    }
  }

  getSelectedText(): string {
    return this.editorView.getSelectedText()
  }

  hasSelection(): boolean {
    return this.editorView.hasSelection()
  }

  getSelection(): { start: number; end: number } | null {
    return this.editorView.getSelection()
  }

  private deleteSelectedText(): void {
    this.editorView.deleteSelectedText()
    this._ctx.clearSelection()
    this.requestRender()
  }

  setSelection(start: number, end: number): void {
    this.lastLocalSelection = null
    this.editorView.resetLocalSelection()
    this._ctx.clearSelection()
    this.editorView.setSelection(start, end, this._selectionBg, this._selectionFg)
    this.requestRender()
  }

  setSelectionInclusive(start: number, end: number): void {
    this.lastLocalSelection = null
    this.editorView.resetLocalSelection()
    this._ctx.clearSelection()
    this.editorView.setSelectionInclusive(start, end, this._selectionBg, this._selectionFg)
    this.requestRender()
  }

  clearSelection(): boolean {
    const had = this.hasSelection()
    this.lastLocalSelection = null
    this.editorView.resetLocalSelection()
    this._ctx.clearSelection()
    if (had) {
      this.requestRender()
    }
    return had
  }

  deleteSelection(): boolean {
    if (!this.hasSelection()) return false

    this.lastLocalSelection = null
    this.deleteSelectedText()
    return true
  }

  setCursor(row: number, col: number): void {
    this.clearSelection()
    this.editBuffer.setCursor(row, col)
    this.requestRender()
  }

  public insertChar(char: string): void {
    const hasSelection = this.hasSelection()
    this.editBuffer.runMutation(() => {
      if (hasSelection) {
        this.editorView._replaceSelectedText(char)
        this._ctx.clearSelection()
      } else {
        this.editBuffer.insertChar(char)
      }
      this.requestRender()
    })
  }

  public insertText(text: string): void {
    const hasSelection = this.hasSelection()
    this.editBuffer.runMutation(() => {
      if (hasSelection) {
        this.editorView._replaceSelectedText(text)
        this._ctx.clearSelection()
      } else {
        this.editBuffer.insertText(text)
      }
      this.requestRender()
    })
  }

  public deleteChar(): boolean {
    if (this.hasSelection()) {
      this.deleteSelectedText()
      return true
    }

    this._ctx.clearSelection()
    this.editBuffer.deleteChar()
    this.requestRender()
    return true
  }

  public deleteCharBackward(): boolean {
    if (this.hasSelection()) {
      this.deleteSelectedText()
      return true
    }

    this._ctx.clearSelection()
    this.editBuffer.deleteCharBackward()
    this.requestRender()
    return true
  }

  public newLine(): boolean {
    this._ctx.clearSelection()
    this.editBuffer.newLine()
    this.requestRender()
    return true
  }

  public deleteLine(): boolean {
    this._ctx.clearSelection()
    this.editBuffer.deleteLine()
    this.requestRender()
    return true
  }

  // Horizontal movement collapses to an edge without taking another step.
  private collapseSelectionToEdge(edge: "start" | "end"): boolean {
    const selection = this.getSelection()
    if (!selection) return false
    this.editBuffer.setCursorByOffset(edge === "start" ? selection.start : selection.end)
    this.clearSelection()
    return true
  }

  public moveCursorLeft(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    if (!select && this.collapseSelectionToEdge("start")) return true

    this.updateSelectionForMovement(select, true)
    this.editBuffer.moveCursorLeft()
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public moveCursorRight(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    if (!select && this.collapseSelectionToEdge("end")) return true

    this.updateSelectionForMovement(select, true)
    this.editBuffer.moveCursorRight()
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public moveCursorUp(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    this.updateSelectionForMovement(select, true)
    this.editorView.moveUpVisual()
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public moveCursorDown(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    this.updateSelectionForMovement(select, true)
    this.editorView.moveDownVisual()
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public gotoLine(line: number): void {
    this.clearSelection()
    this.editBuffer.gotoLine(line)
    this.requestRender()
  }

  public gotoLineStart(): void {
    this.setCursor(this.logicalCursor.row, 0)
  }

  public gotoLineTextEnd(): void {
    const eol = this.editBuffer.getEOL()
    this.setCursor(eol.row, eol.col)
  }

  public gotoLineHome(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    if (!select && this.collapseSelectionToEdge("start")) return true
    this.updateSelectionForMovement(select, true)
    const cursor = this.editorView.getCursor()
    if (cursor.col === 0 && cursor.row > 0) {
      this.editBuffer.setCursor(cursor.row - 1, 0)
      const prevLineEol = this.editBuffer.getEOL()
      this.editBuffer.setCursor(prevLineEol.row, prevLineEol.col)
    } else {
      this.editBuffer.setCursor(cursor.row, 0)
    }

    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public gotoLineEnd(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    if (!select && this.collapseSelectionToEdge("end")) return true
    this.updateSelectionForMovement(select, true)
    const cursor = this.editorView.getCursor()
    const eol = this.editBuffer.getEOL()
    const lineCount = this.editBuffer.getLineCount()
    if (cursor.col === eol.col && cursor.row < lineCount - 1) {
      this.editBuffer.setCursor(cursor.row + 1, 0)
    } else {
      this.editBuffer.setCursor(eol.row, eol.col)
    }

    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public gotoVisualLineHome(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    if (!select && this.collapseSelectionToEdge("start")) return true
    this.updateSelectionForMovement(select, true)
    const sol = this.editorView.getVisualSOL()
    this.editBuffer.setCursor(sol.logicalRow, sol.logicalCol)
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public gotoVisualLineEnd(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    if (!select && this.collapseSelectionToEdge("end")) return true
    this.updateSelectionForMovement(select, true)
    this.editorView.gotoVisualLineEnd()
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public gotoBufferHome(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    if (!select && this.collapseSelectionToEdge("start")) return true
    this.updateSelectionForMovement(select, true)
    this.editBuffer.setCursor(0, 0)
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public gotoBufferEnd(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    if (!select && this.collapseSelectionToEdge("end")) return true
    this.updateSelectionForMovement(select, true)
    this.editBuffer.gotoLine(999999)
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public selectAll(): boolean {
    this.updateSelectionForMovement(false, true)
    this.editBuffer.setCursor(0, 0)
    return this.gotoBufferEnd({ select: true })
  }

  public deleteToLineEnd(): boolean {
    const cursor = this.editorView.getCursor()
    const eol = this.editBuffer.getEOL()

    if (eol.col > cursor.col) {
      this.editBuffer.deleteRange(cursor.row, cursor.col, eol.row, eol.col)
    }

    this.requestRender()
    return true
  }

  public deleteToLineStart(): boolean {
    const cursor = this.editorView.getCursor()

    if (cursor.col > 0) {
      this.editBuffer.deleteRange(cursor.row, 0, cursor.row, cursor.col)
    } else if (cursor.row > 0) {
      this.editBuffer.deleteCharBackward()
    }

    this.requestRender()
    return true
  }

  public undo(): boolean {
    this._ctx.clearSelection()
    this.editBuffer.undo()
    this.requestRender()
    return true
  }

  public redo(): boolean {
    this._ctx.clearSelection()
    this.editBuffer.redo()
    this.requestRender()
    return true
  }

  public moveWordForward(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    if (!select && this.collapseSelectionToEdge("end")) return true
    this.updateSelectionForMovement(select, true)
    const nextWord = this.editBuffer.getNextWordBoundary()
    this.editBuffer.setCursorByOffset(nextWord.offset)
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public moveWordBackward(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    if (!select && this.collapseSelectionToEdge("start")) return true
    this.updateSelectionForMovement(select, true)
    const prevWord = this.editBuffer.getPrevWordBoundary()
    this.editBuffer.setCursorByOffset(prevWord.offset)
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public deleteWordForward(): boolean {
    if (this.hasSelection()) {
      this.deleteSelectedText()
      return true
    }

    const currentCursor = this.editBuffer.getCursorPosition()
    const nextWord = this.editBuffer.getNextWordBoundary()

    if (nextWord.offset > currentCursor.offset) {
      this.editBuffer.deleteRange(currentCursor.row, currentCursor.col, nextWord.row, nextWord.col)
    }

    this._ctx.clearSelection()
    this.requestRender()
    return true
  }

  public deleteWordBackward(): boolean {
    if (this.hasSelection()) {
      this.deleteSelectedText()
      return true
    }

    const currentCursor = this.editBuffer.getCursorPosition()
    const prevWord = this.editBuffer.getPrevWordBoundary()

    if (prevWord.offset < currentCursor.offset) {
      this.editBuffer.deleteRange(prevWord.row, prevWord.col, currentCursor.row, currentCursor.col)
    }

    this._ctx.clearSelection()
    this.requestRender()
    return true
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    buffer.drawEditorView(this.editorView, Math.trunc(this._screenX), Math.trunc(this._screenY))
  }

  public focus(): void {
    super.focus()
    this.requestRender()
  }

  public blur(): void {
    super.blur()
    this.requestRender()
  }

  protected override destroyOwnedResources(): void {
    this.runCleanup((run) => {
      run(() => {
        this.traits = {}
      })

      if (this._focused) {
        run(() => this.blur())
      }

      run(() => this.editorView.destroy())
      run(() => this.editBuffer.destroy())
    })
  }

  public set onCursorChange(handler: ((event: CursorChangeEvent) => void) | undefined) {
    this._cursorChangeListener = handler
  }

  public get onCursorChange(): ((event: CursorChangeEvent) => void) | undefined {
    return this._cursorChangeListener
  }

  public set onContentChange(handler: ((event: ContentChangeEvent) => void) | undefined) {
    this._contentChangeListener = handler
  }

  public get onContentChange(): ((event: ContentChangeEvent) => void) | undefined {
    return this._contentChangeListener
  }

  get syntaxStyle(): SyntaxStyle | null {
    return this.editBuffer.getSyntaxStyle()
  }

  set syntaxStyle(style: SyntaxStyle | null) {
    this.editBuffer.setSyntaxStyle(style)
    this.requestRender()
  }

  public addHighlight(lineIdx: number, highlight: Highlight): void {
    this.editBuffer.addHighlight(lineIdx, highlight)
    this.requestRender()
  }

  public addHighlightByCharRange(highlight: Highlight): void {
    this.editBuffer.addHighlightByCharRange(highlight)
    this.requestRender()
  }

  public removeHighlightsByRef(hlRef: number): void {
    this.editBuffer.removeHighlightsByRef(hlRef)
    this.requestRender()
  }

  public clearLineHighlights(lineIdx: number): void {
    this.editBuffer.clearLineHighlights(lineIdx)
    this.requestRender()
  }

  public clearAllHighlights(): void {
    this.editBuffer.clearAllHighlights()
    this.requestRender()
  }

  public getLineHighlights(lineIdx: number): Array<Highlight> {
    return this.editBuffer.getLineHighlights(lineIdx)
  }

  /**
   * Set text and completely reset the buffer state (clears history, resets add_buffer).
   * Use this for initial text setting or when you want a clean slate.
   */
  public setText(text: string): void {
    runRenderableMutation(this, () => {
      this.editBuffer.setText(text)
      this.requestRender()
    })
  }

  /**
   * Replace text while preserving undo history (creates an undo point).
   * Use this when you want the setText operation to be undoable.
   */
  public replaceText(text: string): void {
    runRenderableMutation(this, () => {
      this.editBuffer.replaceText(text)
      this.requestRender()
    })
  }

  public clear(): void {
    this.editBuffer.clear()
    this.editBuffer.clearAllHighlights()
    this.requestRender()
  }

  public deleteRange(startLine: number, startCol: number, endLine: number, endCol: number): void {
    this.editBuffer.deleteRange(startLine, startCol, endLine, endCol)
    this.requestRender()
  }

  public getTextRange(startOffset: number, endOffset: number): string {
    return this.editBuffer.getTextRange(startOffset, endOffset)
  }

  public getTextRangeByCoords(startRow: number, startCol: number, endRow: number, endCol: number): string {
    return this.editBuffer.getTextRangeByCoords(startRow, startCol, endRow, endCol)
  }

  private setNativeEditorOptions(options: Partial<NativeSceneEditorOptions> = {}): void {
    this._ctx.nativeScene.setEditorOptions(this, {
      showCursor: this._showCursor,
      style: this._cursorStyle.style ?? "block",
      blinking: this._cursorStyle.blinking ?? true,
      color: this._cursorColor,
      cursor: this._cursorStyle.cursor,
      ...options,
    })
  }

  protected updateSelectionForMovement(shiftPressed: boolean, isBeforeMovement: boolean): void {
    if (!shiftPressed) {
      this._keyboardSelectionActive = false
      this.clearSelection()
      return
    }

    if (!this.selectable) return

    this._keyboardSelectionActive = true

    const visualCursor = this.editorView.getVisualCursor()
    const cursorX = Math.trunc(this.x) + visualCursor.visualCol
    const cursorY = Math.trunc(this.y) + visualCursor.visualRow

    if (isBeforeMovement) {
      if (!this._ctx.hasSelection || !this.hasSelection()) {
        this._ctx.startSelection(this, cursorX, cursorY)
      } else if (this._ctx.getSelection()?.behavior !== "cell") {
        if (this.editorView.convertSelectionToCell()) {
          const selection = this._ctx.getSelection()
          if (selection) selection.behavior = "cell"
        }
      }
      return
    }

    this._ctx.updateSelection(this, cursorX, cursorY, { finishDragging: true })
  }
}
