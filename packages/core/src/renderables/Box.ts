import { Edge, Gutter } from "../yoga.js"
import { type RenderableOptions, Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import {
  type BorderCharacters,
  type BorderSides,
  type BorderSidesConfig,
  type BorderStyle,
  borderCharsToArray,
  getBorderSides,
  parseBorderStyle,
} from "../lib/index.js"
import { type ColorInput, RGBA, parseColor } from "../lib/RGBA.js"
import { isValidPercentage } from "../lib/renderable.validations.js"
import type { RenderContext } from "../types.js"

export interface BoxOptions<TRenderable extends Renderable = BoxRenderable> extends RenderableOptions<TRenderable> {
  backgroundColor?: string | RGBA
  borderStyle?: BorderStyle
  border?: boolean | BorderSides[]
  borderColor?: string | RGBA
  customBorderChars?: BorderCharacters
  shouldFill?: boolean
  title?: string
  titleColor?: string | RGBA
  titleAlignment?: "left" | "center" | "right"
  bottomTitle?: string
  bottomTitleAlignment?: "left" | "center" | "right"
  focusedBorderColor?: ColorInput
  focusable?: boolean
  gap?: number | `${number}%`
  rowGap?: number | `${number}%`
  columnGap?: number | `${number}%`
}

function isGapType(value: any): value is number | undefined {
  if (value === undefined) {
    return true
  }
  if (typeof value === "number" && !Number.isNaN(value)) {
    return true
  }
  return isValidPercentage(value)
}

export class BoxRenderable extends Renderable {
  protected _backgroundColor: RGBA
  protected _border: boolean | BorderSides[]
  protected _borderStyle: BorderStyle
  protected _borderColor: RGBA
  protected _focusedBorderColor: RGBA
  private _customBorderCharsObj: BorderCharacters | undefined
  protected _customBorderChars?: Uint32Array
  protected borderSides: BorderSidesConfig
  public shouldFill: boolean
  protected _title?: string
  protected _titleColor?: RGBA
  protected _titleAlignment: "left" | "center" | "right"
  protected _bottomTitle?: string
  protected _bottomTitleAlignment: "left" | "center" | "right"

  protected _defaultOptions = {
    backgroundColor: "transparent",
    borderStyle: "single",
    border: false,
    borderColor: "#FFFFFF",
    shouldFill: true,
    titleAlignment: "left",
    bottomTitleAlignment: "left",
    focusedBorderColor: "#00AAFF",
  } satisfies Partial<BoxOptions>

  constructor(ctx: RenderContext, options: BoxOptions) {
    super(ctx, options)

    if (options.focusable === true) {
      this._focusable = true
    }

    this._backgroundColor = parseColor(options.backgroundColor || this._defaultOptions.backgroundColor)
    this._border = options.border ?? this._defaultOptions.border
    if (
      !options.border &&
      (options.borderStyle || options.borderColor || options.focusedBorderColor || options.customBorderChars)
    ) {
      this._border = true
    }
    this._borderStyle = parseBorderStyle(options.borderStyle, this._defaultOptions.borderStyle)
    this._borderColor = parseColor(options.borderColor || this._defaultOptions.borderColor)
    this._focusedBorderColor = parseColor(options.focusedBorderColor || this._defaultOptions.focusedBorderColor)
    this._customBorderCharsObj = options.customBorderChars
    this._customBorderChars = this._customBorderCharsObj ? borderCharsToArray(this._customBorderCharsObj) : undefined
    this.borderSides = getBorderSides(this._border)
    this.shouldFill = options.shouldFill ?? this._defaultOptions.shouldFill
    this._title = options.title
    this._titleColor = options.titleColor ? parseColor(options.titleColor) : undefined
    this._titleAlignment = options.titleAlignment || this._defaultOptions.titleAlignment
    this._bottomTitle = options.bottomTitle
    this._bottomTitleAlignment = options.bottomTitleAlignment || this._defaultOptions.bottomTitleAlignment

    this.applyYogaBorders()

    const hasInitialGapProps =
      options.gap !== undefined || options.rowGap !== undefined || options.columnGap !== undefined
    if (hasInitialGapProps) {
      this.applyYogaGap(options)
    }
  }

  private initializeBorder(): void {
    // https://github.com/anomalyco/opentui/issues/186
    // Solid-js reconciler does not pass props to constructor on init,
    // so we need to initialize the border when supporting properties are set.
    // borderStyle, borderColor, focusedBorderColor
    if (this._border === false) {
      this._border = true
      this.borderSides = getBorderSides(this._border)
      this.applyYogaBorders()
    }
  }

  public get customBorderChars(): BorderCharacters | undefined {
    return this._customBorderCharsObj
  }

  public set customBorderChars(value: BorderCharacters | undefined) {
    this._customBorderCharsObj = value
    this._customBorderChars = value ? borderCharsToArray(value) : undefined
    this.requestRender()
  }

  public get backgroundColor(): RGBA {
    return this._backgroundColor
  }

  public set backgroundColor(value: RGBA | string | undefined) {
    const newColor = parseColor(value ?? this._defaultOptions.backgroundColor)
    if (this._backgroundColor !== newColor) {
      this._backgroundColor = newColor
      this.requestRender()
    }
  }

  public get border(): boolean | BorderSides[] {
    return this._border
  }

  public set border(value: boolean | BorderSides[]) {
    if (this._border !== value) {
      this._border = value
      this.borderSides = getBorderSides(value)
      this.applyYogaBorders()
      this.requestRender()
    }
  }

  public get borderStyle(): BorderStyle {
    return this._borderStyle
  }

  public set borderStyle(value: BorderStyle) {
    const _value = parseBorderStyle(value, this._defaultOptions.borderStyle)
    if (this._borderStyle !== _value || !this._border) {
      this._borderStyle = _value
      this._customBorderChars = undefined
      this.initializeBorder()
      this.requestRender()
    }
  }

  public get borderColor(): RGBA {
    return this._borderColor
  }

  public set borderColor(value: RGBA | string) {
    const newColor = parseColor(value ?? this._defaultOptions.borderColor)
    if (this._borderColor !== newColor) {
      this._borderColor = newColor
      this.initializeBorder()
      this.requestRender()
    }
  }

  public get focusedBorderColor(): RGBA {
    return this._focusedBorderColor
  }

  public set focusedBorderColor(value: RGBA | string) {
    const newColor = parseColor(value ?? this._defaultOptions.focusedBorderColor)
    if (this._focusedBorderColor !== newColor) {
      this._focusedBorderColor = newColor
      this.initializeBorder()
      if (this._focused) {
        this.requestRender()
      }
    }
  }

  public get title(): string | undefined {
    return this._title
  }

  public set title(value: string | undefined) {
    if (this._title !== value) {
      this._title = value
      this.requestRender()
    }
  }

  public get titleColor(): RGBA | undefined {
    return this._titleColor
  }

  public set titleColor(value: string | RGBA | undefined) {
    const newColor = value ? parseColor(value) : undefined
    if (this._titleColor !== newColor) {
      this._titleColor = newColor
      this.requestRender()
    }
  }

  public get titleAlignment(): "left" | "center" | "right" {
    return this._titleAlignment
  }

  public set titleAlignment(value: "left" | "center" | "right") {
    if (this._titleAlignment !== value) {
      this._titleAlignment = value
      this.requestRender()
    }
  }

  public get bottomTitle(): string | undefined {
    return this._bottomTitle
  }

  public set bottomTitle(value: string | undefined) {
    if (this._bottomTitle !== value) {
      this._bottomTitle = value
      this.requestRender()
    }
  }

  public get bottomTitleAlignment(): "left" | "center" | "right" {
    return this._bottomTitleAlignment
  }

  public set bottomTitleAlignment(value: "left" | "center" | "right") {
    if (this._bottomTitleAlignment !== value) {
      this._bottomTitleAlignment = value
      this.requestRender()
    }
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    const hasBorder = this.borderSides.top || this.borderSides.right || this.borderSides.bottom || this.borderSides.left
    const hasVisibleFill = this.shouldFill && this._backgroundColor.a > 0
    // Many boxes are used only for layout. Skip drawBox entirely when a box
    // would not draw pixels so wrapper nodes do not pay the FFI/native cost.
    if (!hasBorder && !hasVisibleFill) {
      return
    }

    const hasFocusWithin = this._focusable && (this._focused || this._hasFocusedDescendant)
    const currentBorderColor = hasFocusWithin ? this._focusedBorderColor : this._borderColor
    const screenX = this._screenX
    const screenY = this._screenY

    buffer.drawBox({
      x: screenX,
      y: screenY,
      width: this.width,
      height: this.height,
      borderStyle: this._borderStyle,
      customBorderChars: this._customBorderChars,
      border: this._border,
      borderColor: currentBorderColor,
      backgroundColor: this._backgroundColor,
      shouldFill: this.shouldFill,
      title: this._title,
      titleColor: this._titleColor ?? currentBorderColor,
      titleAlignment: this._titleAlignment,
      bottomTitle: this._bottomTitle,
      bottomTitleAlignment: this._bottomTitleAlignment,
    })
  }

  protected getScissorRect(): { x: number; y: number; width: number; height: number } {
    const baseRect = super.getScissorRect()

    if (!this.borderSides.top && !this.borderSides.right && !this.borderSides.bottom && !this.borderSides.left) {
      return baseRect
    }

    const leftInset = this.borderSides.left ? 1 : 0
    const rightInset = this.borderSides.right ? 1 : 0
    const topInset = this.borderSides.top ? 1 : 0
    const bottomInset = this.borderSides.bottom ? 1 : 0

    return {
      x: baseRect.x + leftInset,
      y: baseRect.y + topInset,
      width: Math.max(0, baseRect.width - leftInset - rightInset),
      height: Math.max(0, baseRect.height - topInset - bottomInset),
    }
  }

  private applyYogaBorders(): void {
    const node = this.yogaNode
    node.setBorder(Edge.Left, this.borderSides.left ? 1 : 0)
    node.setBorder(Edge.Right, this.borderSides.right ? 1 : 0)
    node.setBorder(Edge.Top, this.borderSides.top ? 1 : 0)
    node.setBorder(Edge.Bottom, this.borderSides.bottom ? 1 : 0)
    this.requestRender()
  }

  private applyYogaGap(options: BoxOptions): void {
    const node = this.yogaNode

    if (isGapType(options.gap)) {
      node.setGap(Gutter.All, options.gap)
    }

    if (isGapType(options.rowGap)) {
      node.setGap(Gutter.Row, options.rowGap)
    }

    if (isGapType(options.columnGap)) {
      node.setGap(Gutter.Column, options.columnGap)
    }
  }

  public set gap(gap: number | `${number}%` | undefined) {
    if (isGapType(gap)) {
      this.yogaNode.setGap(Gutter.All, gap)
      this.requestRender()
    }
  }

  public set rowGap(rowGap: number | `${number}%` | undefined) {
    if (isGapType(rowGap)) {
      this.yogaNode.setGap(Gutter.Row, rowGap)
      this.requestRender()
    }
  }

  public set columnGap(columnGap: number | `${number}%` | undefined) {
    if (isGapType(columnGap)) {
      this.yogaNode.setGap(Gutter.Column, columnGap)
      this.requestRender()
    }
  }
}
