import {
  getCharacterPositions,
  measureText,
  renderFontToFrameBuffer,
  type ASCIIFontName,
  type fonts,
} from "../lib/ascii.font.js"
import { RGBA, parseColor, type ColorInput } from "../lib/RGBA.js"
import {
  ASCIIFontSelectionHelper,
  convertGlobalToLocalSelection,
  Selection,
  type LocalSelectionBounds,
} from "../lib/selection.js"
import type { RenderableOptions } from "../Renderable.js"
import type { RenderContext } from "../types.js"
import { FrameBufferRenderable, type FrameBufferOptions } from "./FrameBuffer.js"

export interface ASCIIFontOptions extends Omit<RenderableOptions<ASCIIFontRenderable>, "width" | "height"> {
  text?: string
  font?: ASCIIFontName
  color?: ColorInput | ColorInput[]
  backgroundColor?: ColorInput
  selectionBg?: ColorInput
  selectionFg?: ColorInput
  selectable?: boolean
}

export class ASCIIFontRenderable extends FrameBufferRenderable {
  public selectable: boolean = true

  protected static readonly _defaultOptions = {
    text: "",
    font: "tiny",
    color: "#FFFFFF",
    backgroundColor: "transparent",
    selectionBg: undefined,
    selectionFg: undefined,
    selectable: true,
  } satisfies Partial<ASCIIFontOptions>

  protected _text: string
  protected _font: keyof typeof fonts
  protected _color: RGBA | RGBA[]
  protected _backgroundColor: RGBA
  protected _selectionBg: RGBA | undefined
  protected _selectionFg: RGBA | undefined
  protected lastLocalSelection: LocalSelectionBounds | null = null

  private selectionHelper: ASCIIFontSelectionHelper

  constructor(ctx: RenderContext, options: ASCIIFontOptions) {
    const defaultOptions = ASCIIFontRenderable._defaultOptions
    const font = options.font || defaultOptions.font
    const text = options.text || defaultOptions.text
    const measurements = measureText({ text: text, font })

    super(ctx, {
      flexShrink: 0,
      ...options,
      width: measurements.width || 1,
      height: measurements.height || 1,
      respectAlpha: true,
    } as FrameBufferOptions)

    try {
      this._text = text
      this._font = font
      const color = options.color || defaultOptions.color
      this._color = Array.isArray(color)
        ? color.map((value) => RGBA.clone(parseColor(value)))
        : RGBA.clone(parseColor(color))
      this._backgroundColor = RGBA.clone(parseColor(options.backgroundColor || defaultOptions.backgroundColor))
      this._selectionBg = options.selectionBg ? RGBA.clone(parseColor(options.selectionBg)) : undefined
      this._selectionFg = options.selectionFg ? RGBA.clone(parseColor(options.selectionFg)) : undefined
      this.selectable = options.selectable ?? true

      this.selectionHelper = new ASCIIFontSelectionHelper(
        () => this._text,
        () => this._font,
      )

      this.renderFontToBuffer()
    } catch (error) {
      this.abortConstruction(error)
    }
  }

  get text(): string {
    return this._text
  }

  set text(value: string) {
    this._text = value
    this.updateDimensions()

    if (this.lastLocalSelection) {
      this.selectionHelper.onLocalSelectionChanged(this.lastLocalSelection, this.width, this.height)
    }

    this.renderFontToBuffer()
    this.requestRender()
  }

  get font(): keyof typeof fonts {
    return this._font
  }

  set font(value: keyof typeof fonts) {
    this._font = value
    this.updateDimensions()

    if (this.lastLocalSelection) {
      this.selectionHelper.onLocalSelectionChanged(this.lastLocalSelection, this.width, this.height)
    }

    this.renderFontToBuffer()
    this.requestRender()
  }

  get color(): ColorInput | ColorInput[] {
    return Array.isArray(this._color) ? this._color.map((color) => RGBA.clone(color)) : RGBA.clone(this._color)
  }

  set color(value: ColorInput | ColorInput[]) {
    this._color = Array.isArray(value)
      ? value.map((color) => RGBA.clone(parseColor(color)))
      : RGBA.clone(parseColor(value))
    this.renderFontToBuffer()
    this.requestRender()
  }

  get backgroundColor(): ColorInput {
    return RGBA.clone(this._backgroundColor)
  }

  set backgroundColor(value: ColorInput) {
    this._backgroundColor = RGBA.clone(parseColor(value))
    this.renderFontToBuffer()
    this.requestRender()
  }

  private updateDimensions(): void {
    const measurements = measureText({ text: this._text, font: this._font })
    this.width = measurements.width
    this.height = measurements.height
  }

  shouldStartSelection(x: number, y: number): boolean {
    const localX = x - this.x
    const localY = y - this.y
    return this.selectionHelper.shouldStartSelection(localX, localY, this.width, this.height)
  }

  onSelectionChanged(selection: Selection | null): boolean {
    const localSelection = convertGlobalToLocalSelection(selection, Math.trunc(this.x), Math.trunc(this.y))
    this.lastLocalSelection = localSelection
    const changed = this.selectionHelper.onLocalSelectionChanged(localSelection, this.width, this.height)
    if (changed) {
      this.renderFontToBuffer()
      this.requestRender()
    }
    return this.selectionHelper.hasSelection()
  }

  getSelectedText(): string {
    const selection = this.selectionHelper.getSelection()
    if (!selection) return ""
    return this._text.slice(selection.start, selection.end)
  }

  hasSelection(): boolean {
    return this.selectionHelper.hasSelection()
  }

  protected onResize(width: number, height: number): void {
    super.onResize(width, height)
    this.renderFontToBuffer()
  }

  private renderFontToBuffer(): void {
    if (this.isDestroyed) return
    this.frameBuffer.clear(parseColor(this._backgroundColor))

    renderFontToFrameBuffer(this.frameBuffer, {
      text: this._text,
      x: 0,
      y: 0,
      color: this._color,
      backgroundColor: this._backgroundColor,
      font: this._font,
    })

    const selection = this.selectionHelper.getSelection()
    if (selection && (this._selectionBg || this._selectionFg)) {
      this.renderSelectionHighlight(selection)
    }
  }

  private renderSelectionHighlight(selection: { start: number; end: number }): void {
    if (!this._selectionBg && !this._selectionFg) return

    const selectedText = this._text.slice(selection.start, selection.end)
    if (!selectedText) return

    const positions = getCharacterPositions(this._text, this._font)
    const startX = positions[selection.start] || 0
    const endX =
      selection.end < positions.length
        ? positions[selection.end]
        : measureText({ text: this._text, font: this._font }).width

    if (this._selectionBg) {
      this.frameBuffer.fillRect(startX, 0, endX - startX, this.height, parseColor(this._selectionBg))
    }

    if (this._selectionFg || this._selectionBg) {
      renderFontToFrameBuffer(this.frameBuffer, {
        text: selectedText,
        x: startX,
        y: 0,
        color: this._selectionFg ? this._selectionFg : this._color,
        backgroundColor: this._selectionBg ? this._selectionBg : this._backgroundColor,
        font: this._font,
      })
    }
  }
}
