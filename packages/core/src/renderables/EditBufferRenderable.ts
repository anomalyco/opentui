import { Renderable, type RenderableOptions } from "../Renderable.js"
import { convertGlobalToLocalSelection, Selection, type LocalSelectionBounds } from "../lib/selection.js"
import { EditBuffer, type LogicalCursor } from "../edit-buffer.js"
import { EditorView, type VisualCursor } from "../editor-view.js"
import { RGBA, parseColor } from "../lib/RGBA.js"
import type { RenderContext, Highlight, CursorStyleOptions, LineInfoProvider, LineInfo } from "../types.js"
import type { OptimizedBuffer } from "../buffer.js"
import { MeasureMode } from "../yoga.js"
import type { SyntaxStyle } from "../syntax-style.js"

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
  syntaxStyle?: SyntaxStyle
  tabIndicator?: string | number
  tabIndicatorColor?: string | RGBA
  onCursorChange?: (event: CursorChangeEvent) => void
  onContentChange?: (event: ContentChangeEvent) => void
}

export abstract class EditBufferRenderable extends Renderable implements LineInfoProvider {
  [BrandedEditBufferRenderable] = true
  protected _focusable: boolean = true
  public selectable: boolean = true
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

    this._textColor = parseColor(options.textColor ?? this._defaultOptions.textColor)
    this._backgroundColor = parseColor(options.backgroundColor ?? this._defaultOptions.backgroundColor)
    this._defaultAttributes = options.attributes ?? this._defaultOptions.attributes
    this._selectionBg = options.selectionBg ? parseColor(options.selectionBg) : this._defaultOptions.selectionBg
    this._selectionFg = options.selectionFg ? parseColor(options.selectionFg) : this._defaultOptions.selectionFg
    this.selectable = options.selectable ?? this._defaultOptions.selectable
    this._wrapMode = options.wrapMode ?? this._defaultOptions.wrapMode
    this._scrollMargin = options.scrollMargin ?? this._defaultOptions.scrollMargin
    this._scrollSpeed = options.scrollSpeed ?? this._defaultOptions.scrollSpeed
    this._showCursor = options.showCursor ?? this._defaultOptions.showCursor
    this._cursorColor = parseColor(options.cursorColor ?? this._defaultOptions.cursorColor)
    this._cursorStyle = options.cursorStyle ?? this._defaultOptions.cursorStyle
    this._tabIndicator = options.tabIndicator ?? this._defaultOptions.tabIndicator
    this._tabIndicatorColor = options.tabIndicatorColor
      ? parseColor(options.tabIndicatorColor)
      : this._defaultOptions.tabIndicatorColor

    this.editBuffer = EditBuffer.create(this._ctx.widthMethod)
    this.editorView = EditorView.create(this.editBuffer, this.width || 80, this.height || 24)

    this.editorView.setWrapMode(this._wrapMode)
    this.editorView.setScrollMargin(this._scrollMargin)

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

    this.setupMeasureFunc()
    this.setupEventListeners(options)
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
      this.yogaNode.markDirty()
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
    return this._textColor
  }

  set textColor(value: RGBA | string | undefined) {
    const newColor = parseColor(value ?? this._defaultOptions.textColor)
    if (this._textColor !== newColor) {
      this._textColor = newColor
      this.editBuffer.setDefaultFg(newColor)
      this.requestRender()
    }
  }

  get selectionBg(): RGBA | undefined {
    return this._selectionBg
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
    const newColor = value ? parseColor(value) : this._defaultOptions.selectionBg
    if (this._selectionBg !== newColor) {
      this._selectionBg = newColor
      this.refreshSelectionStyle()
      this.requestRender()
    }
  }

  get selectionFg(): RGBA | undefined {
    return this._selectionFg
  }

  set selectionFg(value: RGBA | string | undefined) {
    const newColor = value ? parseColor(value) : this._defaultOptions.selectionFg
    if (this._selectionFg !== newColor) {
      this._selectionFg = newColor
      this.refreshSelectionStyle()
      this.requestRender()
    }
  }

  get backgroundColor(): RGBA {
    return this._backgroundColor
  }

  set backgroundColor(value: RGBA | string | undefined) {
    const newColor = parseColor(value ?? this._defaultOptions.backgroundColor)
    if (this._backgroundColor !== newColor) {
      this._backgroundColor = newColor
      this.editBuffer.setDefaultBg(newColor)
      this.requestRender()
    }
  }

  get attributes(): number {
    return this._defaultAttributes
  }

  set attributes(value: number) {
    if (this._defaultAttributes !== value) {
      this._defaultAttributes = value
      this.editBuffer.setDefaultAttributes(value)
      this.requestRender()
    }
  }

  get wrapMode(): "none" | "char" | "word" {
    return this._wrapMode
  }

  set wrapMode(value: "none" | "char" | "word") {
    if (this._wrapMode !== value) {
      this._wrapMode = value
      this.editorView.setWrapMode(value)
      this.yogaNode.markDirty()
      this.requestRender()
    }
  }

  get showCursor(): boolean {
    return this._showCursor
  }

  set showCursor(value: boolean) {
    if (this._showCursor !== value) {
      this._showCursor = value
      if (!value && this._focused) {
        this._ctx.setCursorPosition(0, 0, false)
      }
      this.requestRender()
    }
  }

  get cursorColor(): RGBA {
    return this._cursorColor
  }

  set cursorColor(value: RGBA | string) {
    const newColor = parseColor(value)
    if (this._cursorColor !== newColor) {
      this._cursorColor = newColor
      if (this._focused) {
        this.requestRender()
      }
    }
  }

  get cursorStyle(): CursorStyleOptions {
    return this._cursorStyle
  }

  set cursorStyle(style: CursorStyleOptions) {
    const newStyle = style
    if (this.cursorStyle.style !== newStyle.style || this.cursorStyle.blinking !== newStyle.blinking) {
      this._cursorStyle = newStyle
      if (this._focused) {
        this.requestRender()
      }
    }
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
    return this._tabIndicatorColor
  }

  set tabIndicatorColor(value: RGBA | string | undefined) {
    const newColor = value ? parseColor(value) : undefined
    if (this._tabIndicatorColor !== newColor) {
      this._tabIndicatorColor = newColor
      if (newColor !== undefined) {
        this.editorView.setTabIndicatorColor(newColor)
      }
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
    )
  }

  shouldStartSelection(x: number, y: number): boolean {
    if (!this.selectable) return false

    const localX = x - this.x
    const localY = y - this.y

    return localX >= 0 && localX < this.width && localY >= 0 && localY < this.height
  }

  onSelectionChanged(selection: Selection | null): boolean {
    const localSelection = convertGlobalToLocalSelection(selection, this.x, this.y)
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
      )
    }

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

    if (changed) {
      this.requestRender()
    }

    return this.hasSelection()
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

  private refreshSelectionStyle(): void {
    if (this.lastLocalSelection) {
      this.updateLocalSelection(this.lastLocalSelection)
      return
    }

    const selection = this.getSelection()
    if (!selection) return
    this.editorView.setSelection(selection.start, selection.end, this._selectionBg, this._selectionFg)
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
    this.setSelection(Math.min(start, end), Math.max(start, end) + 1)
  }

  clearSelection(): boolean {
    const had = this.hasSelection()
    this.lastLocalSelection = null
    this.editorView.resetSelection()
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
    this.editBuffer.setCursor(row, col)
    this.requestRender()
  }

  public insertChar(char: string): void {
    if (this.hasSelection()) {
      this.deleteSelectedText()
    }

    this.editBuffer.insertChar(char)
    this.requestRender()
  }

  public insertText(text: string): void {
    if (this.hasSelection()) {
      this.deleteSelectedText()
    }

    this.editBuffer.insertText(text)
    this.requestRender()
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

  public moveCursorLeft(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false

    if (!select && this.hasSelection()) {
      const selection = this.getSelection()!
      this.editBuffer.setCursorByOffset(selection.start)
      this._ctx.clearSelection()
      this.requestRender()
      return true
    }

    this.updateSelectionForMovement(select, true)
    this.editBuffer.moveCursorLeft()
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public moveCursorRight(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false

    if (!select && this.hasSelection()) {
      const selection = this.getSelection()!
      const targetOffset = this.cursorOffset === selection.start ? selection.end - 1 : selection.end
      this.editBuffer.setCursorByOffset(targetOffset)
      this._ctx.clearSelection()
      this.requestRender()
      return true
    }

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
    this.updateSelectionForMovement(select, true)
    const sol = this.editorView.getVisualSOL()
    this.editBuffer.setCursor(sol.logicalRow, sol.logicalCol)
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public gotoVisualLineEnd(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    this.updateSelectionForMovement(select, true)
    const eol = this.editorView.getVisualEOL()
    this.editBuffer.setCursor(eol.logicalRow, eol.logicalCol)
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public gotoBufferHome(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
    this.updateSelectionForMovement(select, true)
    this.editBuffer.setCursor(0, 0)
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public gotoBufferEnd(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
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
    this.updateSelectionForMovement(select, true)
    const nextWord = this.editBuffer.getNextWordBoundary()
    this.editBuffer.setCursorByOffset(nextWord.offset)
    this.updateSelectionForMovement(select, false)
    this.requestRender()
    return true
  }

  public moveWordBackward(options?: { select?: boolean }): boolean {
    const select = options?.select ?? false
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

  // Undefined = 0,
  // Exactly = 1,
  // AtMost = 2
  private setupMeasureFunc(): void {
    const measureFunc = (
      width: number,
      widthMode: MeasureMode,
      height: number,
      heightMode: MeasureMode,
    ): { width: number; height: number } => {
      // When widthMode is Undefined, Yoga is asking for the intrinsic/natural width
      // Pass width=0 to measureForDimensions to signal we want max-content (no wrapping)
      // The Zig code treats width=0 with wrap_mode != none as null wrap_width,
      // which triggers no-wrap mode and returns the text's intrinsic width
      let effectiveWidth: number
      if (widthMode === MeasureMode.Undefined || isNaN(width)) {
        effectiveWidth = 0
      } else {
        effectiveWidth = width
      }

      const effectiveHeight = isNaN(height) ? 1 : height

      const measureResult = this.editorView.measureForDimensions(
        Math.floor(effectiveWidth),
        Math.floor(effectiveHeight),
      )

      const measuredWidth = measureResult ? Math.max(1, measureResult.widthColsMax) : 1
      const measuredHeight = measureResult ? Math.max(1, measureResult.lineCount) : 1

      if (widthMode === MeasureMode.AtMost && this._positionType !== "absolute") {
        return {
          width: Math.min(effectiveWidth, measuredWidth),
          height: Math.min(effectiveHeight, measuredHeight),
        }
      }

      return {
        width: measuredWidth,
        height: measuredHeight,
      }
    }

    this.yogaNode.setMeasureFunc(measureFunc)
  }

  render(buffer: OptimizedBuffer, deltaTime: number): void {
    if (!this.visible) return
    if (this.isDestroyed) return
    // Editor rendering/cursor placement reads absolute coordinates multiple
    // times per frame, so it benefits from the same cached screen position.
    const screenX = this._screenX
    const screenY = this._screenY

    this.markClean()
    this._ctx.addToHitGrid(screenX, screenY, this.width, this.height, this.num)

    this.renderSelf(buffer)
    this.renderCursor(buffer)
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    buffer.drawEditorView(this.editorView, this._screenX, this._screenY)
  }

  protected renderCursor(buffer: OptimizedBuffer): void {
    if (!this._showCursor || !this._focused) return

    const visualCursor = this.editorView.getVisualCursor()
    const screenX = this._screenX
    const screenY = this._screenY

    const cursorX = screenX + visualCursor.visualCol + 1 // +1 for 1-based terminal coords
    const cursorY = screenY + visualCursor.visualRow + 1 // +1 for 1-based terminal coords

    this._ctx.setCursorPosition(cursorX, cursorY, true)
    this._ctx.setCursorStyle({ ...this._cursorStyle, color: this._cursorColor })
  }

  public focus(): void {
    super.focus()
    this._ctx.setCursorStyle({ ...this._cursorStyle, color: this._cursorColor })
    this.requestRender()
  }

  public blur(): void {
    super.blur()
    this._ctx.setCursorPosition(0, 0, false)
    this.requestRender()
  }

  protected onRemove(): void {
    if (this._focused) {
      this._ctx.setCursorPosition(0, 0, false)
    }
  }

  override destroy(): void {
    if (this.isDestroyed) return

    this.traits = {}

    if (this._focused) {
      this._ctx.setCursorPosition(0, 0, false)
      // Manually blur to unhook event handlers BEFORE setting destroyed flag
      // This prevents the guard in super.destroy() from skipping blur()
      this.blur()
    }

    // Destroy dependent resources in correct order BEFORE calling super
    // EditorView depends on EditBuffer, so destroy it first
    this.editorView.destroy()
    this.editBuffer.destroy()

    // Finally clean up parent resources
    // Note: super.destroy() will try to blur() again, but blur() has guards to prevent double-blur
    super.destroy()
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
    this.editBuffer.setText(text)
    this.yogaNode.markDirty()
    this.requestRender()
  }

  /**
   * Replace text while preserving undo history (creates an undo point).
   * Use this when you want the setText operation to be undoable.
   */
  public replaceText(text: string): void {
    this.editBuffer.replaceText(text)
    this.yogaNode.markDirty()
    this.requestRender()
  }

  public clear(): void {
    this.editBuffer.clear()
    this.editBuffer.clearAllHighlights()
    this.yogaNode.markDirty()
    this.requestRender()
  }

  public deleteRange(startLine: number, startCol: number, endLine: number, endCol: number): void {
    this.editBuffer.deleteRange(startLine, startCol, endLine, endCol)
    this.yogaNode.markDirty()
    this.requestRender()
  }

  public getTextRange(startOffset: number, endOffset: number): string {
    return this.editBuffer.getTextRange(startOffset, endOffset)
  }

  public getTextRangeByCoords(startRow: number, startCol: number, endRow: number, endCol: number): string {
    return this.editBuffer.getTextRangeByCoords(startRow, startCol, endRow, endCol)
  }

  protected updateSelectionForMovement(shiftPressed: boolean, isBeforeMovement: boolean): void {
    if (!this.selectable) return

    if (!shiftPressed) {
      this._keyboardSelectionActive = false
      this._ctx.clearSelection()
      return
    }

    this._keyboardSelectionActive = true

    const visualCursor = this.editorView.getVisualCursor()
    const cursorX = this.x + visualCursor.visualCol
    const cursorY = this.y + visualCursor.visualRow

    if (isBeforeMovement) {
      if (!this._ctx.hasSelection) {
        this._ctx.startSelection(this, cursorX, cursorY)
      }
      return
    }

    this._ctx.updateSelection(this, cursorX, cursorY, { finishDragging: true })
  }
}
