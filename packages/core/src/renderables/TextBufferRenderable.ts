import { runRenderableMutation } from "../lib/renderable-layout.js"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import { convertGlobalToLocalSelection, Selection, type LocalSelectionBounds } from "../lib/selection.js"
import { TextBuffer, type TextChunk } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { RGBA, parseColor } from "../lib/RGBA.js"
import { type RenderContext, type LineInfoProvider } from "../types.js"
import type { OptimizedBuffer } from "../buffer.js"
import type { LineInfo, NativeSceneTextOptions } from "../zig.js"
import { SyntaxStyle } from "../syntax-style.js"

export interface TextBufferOptions extends RenderableOptions<TextBufferRenderable> {
  fg?: string | RGBA
  bg?: string | RGBA
  selectionBg?: string | RGBA
  selectionFg?: string | RGBA
  selectable?: boolean
  attributes?: number
  wrapMode?: "none" | "char" | "word"
  tabIndicator?: string | number
  tabIndicatorColor?: string | RGBA
  truncate?: boolean
}

export abstract class TextBufferRenderable extends Renderable implements LineInfoProvider {
  protected _defaultFg: RGBA
  protected _defaultBg: RGBA
  protected _defaultAttributes: number
  protected _selectionBg: RGBA | undefined
  protected _selectionFg: RGBA | undefined
  protected _wrapMode: "none" | "char" | "word" = "word"
  protected lastLocalSelection: LocalSelectionBounds | null = null
  protected _tabIndicator?: string | number
  protected _tabIndicatorColor?: RGBA
  protected _scrollX: number = 0
  protected _scrollY: number = 0
  protected _truncate: boolean = false
  protected _firstLineOffset: number = 0

  // Ordinary scene Text owns an aggregate; resource-backed widgets own these wrappers.
  protected textBuffer!: TextBuffer
  protected textBufferView!: TextBufferView
  protected _textBufferSyntaxStyle!: SyntaxStyle
  private readonly nativeTextScene: RenderContext["nativeScene"] | undefined

  protected _defaultOptions = {
    fg: RGBA.fromValues(1, 1, 1, 1),
    bg: RGBA.fromValues(0, 0, 0, 0),
    selectionBg: undefined,
    selectionFg: undefined,
    selectable: true,
    attributes: 0,
    wrapMode: "word" as "none" | "char" | "word",
    tabIndicator: undefined,
    tabIndicatorColor: undefined,
    truncate: false,
  } satisfies Partial<TextBufferOptions>

  constructor(ctx: RenderContext, options: TextBufferOptions, sharedText = false) {
    super(ctx, options)
    this.nativeTextScene = sharedText ? undefined : ctx.nativeScene

    let textBuffer: TextBuffer | undefined
    let textBufferView: TextBufferView | undefined
    let syntaxStyle: SyntaxStyle | undefined

    try {
      this._defaultFg = RGBA.clone(parseColor(options.fg ?? this._defaultOptions.fg))
      this._defaultBg = RGBA.clone(parseColor(options.bg ?? this._defaultOptions.bg))
      this._defaultAttributes = options.attributes ?? this._defaultOptions.attributes
      this._selectionBg = options.selectionBg ? RGBA.clone(parseColor(options.selectionBg)) : undefined
      this._selectionFg = options.selectionFg ? RGBA.clone(parseColor(options.selectionFg)) : undefined
      this.selectable = options.selectable ?? this._defaultOptions.selectable
      this._wrapMode = options.wrapMode ?? this._defaultOptions.wrapMode
      this._tabIndicator = options.tabIndicator ?? this._defaultOptions.tabIndicator
      this._tabIndicatorColor = options.tabIndicatorColor
        ? RGBA.clone(parseColor(options.tabIndicatorColor))
        : this._defaultOptions.tabIndicatorColor
      this._truncate = options.truncate ?? this._defaultOptions.truncate

      if (this.nativeTextScene) {
        this._firstLineOffset = ctx.claimFirstLineOffset?.(this) ?? 0
        this.setNativeScenePaint()
        this.setNativeSceneTextOptions()
        return
      }

      textBuffer = TextBuffer.create(this._ctx.widthMethod, ctx.nativeScene)
      this.textBuffer = textBuffer
      textBufferView = TextBufferView.create(textBuffer)
      this.textBufferView = textBufferView
      this._firstLineOffset = ctx.claimFirstLineOffset?.(this) ?? 0

      syntaxStyle = SyntaxStyle.create(ctx.nativeScene)
      this._textBufferSyntaxStyle = syntaxStyle
      textBuffer.setSyntaxStyle(syntaxStyle)

      this.textBufferView.setWrapMode(this._wrapMode)
      this.textBufferView.setFirstLineOffset(this._firstLineOffset)
      ctx.nativeScene.setTextView(this, textBufferView._getSceneHandle(ctx.nativeScene))

      this.textBuffer._setDefaults(this._defaultFg, this._defaultBg, this._defaultAttributes)

      if (this._tabIndicator !== undefined) {
        this.textBufferView.setTabIndicator(this._tabIndicator)
      }
      if (this._tabIndicatorColor !== undefined) {
        this.textBufferView.setTabIndicatorColor(this._tabIndicatorColor)
      }

      const width = this.width
      const height = this.height
      if (width > 0 && height > 0) {
        this.textBufferView.setViewport(
          Math.trunc(this._scrollX),
          Math.trunc(this._scrollY),
          Math.trunc(width),
          Math.trunc(height),
        )
      } else if (this._wrapMode !== "none" && width > 0) {
        this.textBufferView.setWrapWidth(Math.trunc(width))
      }

      this.textBufferView.setTruncate(this._truncate)

      this.updateTextInfo()
    } catch (error) {
      this.abortConstruction(error, (run) => {
        run(() => textBuffer?.setSyntaxStyle(null))
        run(() => syntaxStyle?.destroy())
        run(() => textBufferView?.destroy())
        run(() => textBuffer?.destroy())
      })
    }
  }

  protected onMouseEvent(event: any): void {
    if (event.type === "scroll") {
      this.handleScroll(event)
    }
  }

  protected handleScroll(event: any): void {
    if (!event.scroll) return

    const { direction, delta } = event.scroll

    if (direction === "up") {
      this.scrollY -= delta
    } else if (direction === "down") {
      this.scrollY += delta
    }

    if (this._wrapMode === "none") {
      if (direction === "left") {
        this.scrollX -= delta
      } else if (direction === "right") {
        this.scrollX += delta
      }
    }
  }

  public get lineInfo(): LineInfo {
    if (this.nativeTextScene) return this.nativeTextScene.getTextLineInfo(this)
    return this.textBufferView.logicalLineInfo
  }

  public getLineSources(startLine: number, lineCount: number): number[] {
    // A lineInfo override remaps sources; native-scene Text has no view to query.
    if (this.needsLineInfoFallback(TextBufferRenderable.prototype)) {
      return this.lineInfo.lineSources.slice(startLine, startLine + lineCount)
    }
    if (this.nativeTextScene) {
      return this.nativeTextScene.getTextLineInfo(this).lineSources.slice(startLine, startLine + lineCount)
    }
    return this.textBufferView.getLineSources(startLine, lineCount)
  }

  protected needsLineInfoFallback(owner: object): boolean {
    // A bounded override opts in; a nearer legacy lineInfo override keeps the virtual getter.
    let prototype: object | null = this
    while (prototype && prototype !== owner) {
      if (Object.hasOwn(prototype, "getLineSources")) return false
      if (Object.hasOwn(prototype, "lineInfo")) return true
      prototype = Object.getPrototypeOf(prototype)
    }
    return false
  }

  public get lineCount(): number {
    if (this.nativeTextScene) return this.nativeTextScene.getTextMetrics(this).lineCount
    return this.textBuffer.getLineCount()
  }

  public get virtualLineCount(): number {
    if (this.nativeTextScene) return this.nativeTextScene.getTextMetrics(this).virtualLineCount
    return this.textBufferView.getVirtualLineCount()
  }

  public get scrollY(): number {
    return this._scrollY
  }

  public set scrollY(value: number) {
    const maxScrollY = Math.max(0, this.scrollHeight - this.height)
    const clamped = Math.max(0, Math.min(value, maxScrollY))
    if (this._scrollY !== clamped) {
      runRenderableMutation(this, () => {
        this.setNativeSceneTextOptions({ scrollY: clamped })
        if (!this.nativeTextScene) this.updateViewportOffset(this._scrollX, clamped)
        this._scrollY = clamped
        this.requestRender()
      })
    }
  }

  public get scrollX(): number {
    return this._scrollX
  }

  public set scrollX(value: number) {
    const maxScrollX = Math.max(0, this.scrollWidth - this.width)
    const clamped = Math.max(0, Math.min(value, maxScrollX))
    if (this._scrollX !== clamped) {
      runRenderableMutation(this, () => {
        this.setNativeSceneTextOptions({ scrollX: clamped })
        if (!this.nativeTextScene) this.updateViewportOffset(clamped, this._scrollY)
        this._scrollX = clamped
        this.requestRender()
      })
    }
  }

  public get scrollWidth(): number {
    if (this.nativeTextScene) return this.nativeTextScene.getTextMetrics(this).widthColsMax
    return this.lineInfo.lineWidthColsMax
  }

  public get scrollHeight(): number {
    if (this.nativeTextScene) return this.nativeTextScene.getTextMetrics(this).virtualLineCount
    return this.virtualLineCount
  }

  public get maxScrollY(): number {
    return Math.max(0, this.scrollHeight - this.height)
  }

  public get maxScrollX(): number {
    return Math.max(0, this.scrollWidth - this.width)
  }

  protected updateViewportOffset(scrollX = this._scrollX, scrollY = this._scrollY): void {
    const width = this.width
    const height = this.height
    if (width > 0 && height > 0) {
      this.textBufferView.setViewport(Math.trunc(scrollX), Math.trunc(scrollY), Math.trunc(width), Math.trunc(height))
    }
  }

  get plainText(): string {
    if (this.nativeTextScene) return this.nativeTextScene.getText(this)
    return this.textBuffer.getPlainText()
  }

  get textLength(): number {
    if (this.nativeTextScene) return this.nativeTextScene.getTextMetrics(this).textLength
    return this.textBuffer.length
  }

  get fg(): RGBA {
    return RGBA.clone(this._defaultFg)
  }

  set fg(value: RGBA | string | undefined) {
    const newColor = RGBA.clone(parseColor(value ?? this._defaultOptions.fg))
    runRenderableMutation(this, () => {
      this.setNativeSceneTextOptions({ fg: newColor })
      if (!this.nativeTextScene) this.textBuffer.setDefaultFg(newColor)
      this._defaultFg = newColor
      this.onFgChanged(newColor)
      this.requestRender()
    })
  }

  get selectionBg(): RGBA | undefined {
    return this._selectionBg ? RGBA.clone(this._selectionBg) : undefined
  }

  set selectionBg(value: RGBA | string | undefined) {
    const newColor = value ? RGBA.clone(parseColor(value)) : undefined
    if (this._selectionBg !== newColor) {
      runRenderableMutation(this, () => {
        if (this.nativeTextScene || this.lastLocalSelection) {
          this.updateLocalSelection(this.lastLocalSelection, true, { bg: newColor, fg: this._selectionFg })
        }
        this._selectionBg = newColor
        this.requestRender()
      })
    }
  }

  get selectionFg(): RGBA | undefined {
    return this._selectionFg ? RGBA.clone(this._selectionFg) : undefined
  }

  set selectionFg(value: RGBA | string | undefined) {
    const newColor = value ? RGBA.clone(parseColor(value)) : undefined
    if (this._selectionFg !== newColor) {
      runRenderableMutation(this, () => {
        if (this.nativeTextScene || this.lastLocalSelection) {
          this.updateLocalSelection(this.lastLocalSelection, true, { bg: this._selectionBg, fg: newColor })
        }
        this._selectionFg = newColor
        this.requestRender()
      })
    }
  }

  get bg(): RGBA {
    return RGBA.clone(this._defaultBg)
  }

  set bg(value: RGBA | string | undefined) {
    const newColor = RGBA.clone(parseColor(value ?? this._defaultOptions.bg))
    runRenderableMutation(this, () => {
      this.setNativeSceneTextOptions({ bg: newColor })
      if (!this.nativeTextScene) this.textBuffer.setDefaultBg(newColor)
      this._defaultBg = newColor
      this.onBgChanged(newColor)
      this.requestRender()
    })
  }

  get attributes(): number {
    return this._defaultAttributes
  }

  set attributes(value: number | undefined) {
    const attributes = value ?? this._defaultOptions.attributes
    if (this._defaultAttributes !== attributes) {
      runRenderableMutation(this, () => {
        this.setNativeSceneTextOptions({ attributes })
        if (!this.nativeTextScene) this.textBuffer.setDefaultAttributes(attributes)
        this._defaultAttributes = attributes
        this.onAttributesChanged(attributes)
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
        this.setNativeSceneTextOptions({ wrapMode: value })
        if (!this.nativeTextScene) this.textBufferView.setWrapMode(value)
        this._wrapMode = value
        if (!this.nativeTextScene && value !== "none") {
          const width = this.width
          if (width > 0) this.textBufferView.setWrapWidth(Math.trunc(width))
        }
        this.requestRender()
      })
    }
  }

  get tabIndicator(): string | number | undefined {
    return this._tabIndicator
  }

  set tabIndicator(value: string | number | undefined) {
    if (this._tabIndicator !== value) {
      runRenderableMutation(this, () => {
        this.setNativeSceneTextOptions({ tabIndicator: value })
        if (!this.nativeTextScene) this.textBufferView.setTabIndicator(value ?? 0)
        this._tabIndicator = value
        this.requestRender()
      })
    }
  }

  get tabIndicatorColor(): RGBA | undefined {
    return this._tabIndicatorColor ? RGBA.clone(this._tabIndicatorColor) : undefined
  }

  set tabIndicatorColor(value: RGBA | string | undefined) {
    const newColor = value ? RGBA.clone(parseColor(value)) : undefined
    if (this._tabIndicatorColor !== newColor) {
      runRenderableMutation(this, () => {
        this.setNativeSceneTextOptions({ tabIndicatorColor: newColor })
        if (!this.nativeTextScene && newColor !== undefined) this.textBufferView.setTabIndicatorColor(newColor)
        this._tabIndicatorColor = newColor
        this.requestRender()
      })
    }
  }

  get truncate(): boolean {
    return this._truncate
  }

  set truncate(value: boolean) {
    if (this._truncate !== value) {
      runRenderableMutation(this, () => {
        this.setNativeSceneTextOptions({ truncate: value })
        if (!this.nativeTextScene) this.textBufferView.setTruncate(value)
        this._truncate = value
        this.requestRender()
      })
    }
  }

  protected onResize(width: number, height: number): void {
    if (!this.nativeTextScene) this.textBufferView.setViewport(this._scrollX, this._scrollY, width, height)
    this.requestRender()
    this.emit("line-info-change")
  }

  protected refreshLocalSelection(): boolean {
    if (this.lastLocalSelection) {
      return this.updateLocalSelection(this.lastLocalSelection)
    }
    return false
  }

  private updateLocalSelection(
    localSelection: LocalSelectionBounds | null,
    isStart = true,
    colors?: { bg?: RGBA; fg?: RGBA },
  ): boolean {
    const bg = colors ? colors.bg : this._selectionBg
    const fg = colors ? colors.fg : this._selectionFg
    if (this.nativeTextScene) {
      return this.nativeTextScene.setTextSelection(
        this,
        !localSelection?.isActive ? "reset" : isStart ? "set" : "update",
        localSelection,
        bg,
        fg,
      )
    }
    if (!localSelection?.isActive) {
      this.textBufferView.resetLocalSelection()
      return true
    }

    return this.textBufferView[isStart ? "setLocalSelection" : "updateLocalSelection"](
      localSelection.anchorX,
      localSelection.anchorY,
      localSelection.focusX,
      localSelection.focusY,
      bg,
      fg,
      localSelection.behavior,
    )
  }

  protected updateTextInfo(): void {
    if (this.lastLocalSelection) {
      this.updateLocalSelection(this.lastLocalSelection)
    }

    this.requestRender()
    this.emit("line-info-change")
  }

  shouldStartSelection(x: number, y: number): boolean {
    if (!this.selectable) return false

    const localX = x - this.x
    const localY = y - this.y

    return localX >= 0 && localX < this.width && localY >= 0 && localY < this.height
  }

  onSelectionChanged(selection: Selection | null): boolean {
    const localSelection = convertGlobalToLocalSelection(selection, Math.trunc(this.x), Math.trunc(this.y))
    const changed = this.updateLocalSelection(localSelection, selection?.isStart ?? false)
    this.lastLocalSelection = localSelection

    if (changed) {
      this.requestRender()
    }

    return this.hasSelection()
  }

  getSelectedText(): string {
    if (this.nativeTextScene) return this.nativeTextScene.getSelectedText(this)
    return this.textBufferView.getSelectedText()
  }

  hasSelection(): boolean {
    if (this.nativeTextScene) return this.nativeTextScene.getTextSelection(this) !== null
    return this.textBufferView.hasSelection()
  }

  getSelection(): { start: number; end: number } | null {
    if (this.nativeTextScene) return this.nativeTextScene.getTextSelection(this)
    return this.textBufferView.getSelection()
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    this.drawToBuffer(buffer, this._screenX, this._screenY)
  }

  /** Draw the current text viewport in destination-buffer coordinates without changing layout or hits. */
  public drawToBuffer(buffer: OptimizedBuffer, x: number, y: number): void {
    if (this.isDestroyed) throw new Error("Cannot draw destroyed text")
    if (this.nativeTextScene) {
      this.nativeTextScene.drawText(this, buffer, Math.trunc(x), Math.trunc(y))
      return
    }
    buffer.drawTextBuffer(this.textBufferView, Math.trunc(x), Math.trunc(y))
  }

  protected override destroyOwnedResources(): void {
    if (this.nativeTextScene) return
    this.runCleanup((run) => {
      run(() => this.textBuffer.setSyntaxStyle(null))
      run(() => this._textBufferSyntaxStyle.destroy())
      run(() => this.textBufferView.destroy())
      run(() => this.textBuffer.destroy())
    })
  }

  private setNativeSceneTextOptions(options: Partial<NativeSceneTextOptions> = {}): void {
    this.nativeTextScene?.setTextOptions(this, {
      fg: this._defaultFg,
      bg: this._defaultBg,
      attributes: this._defaultAttributes,
      wrapMode: this._wrapMode,
      truncate: this._truncate,
      scrollX: this._scrollX,
      scrollY: this._scrollY,
      firstLineOffset: this._firstLineOffset,
      tabIndicator: this._tabIndicator,
      tabIndicatorColor: this._tabIndicatorColor,
      ...options,
    })
  }

  protected onFgChanged(newColor: RGBA): void {
    // Override in subclasses if needed
  }

  protected onBgChanged(newColor: RGBA): void {
    // Override in subclasses if needed
  }

  protected onAttributesChanged(newAttributes: number): void {
    // Override in subclasses if needed
  }
}
