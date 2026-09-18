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
import { type ColorInput, RGBA, hexToRgb, parseColor } from "../lib/RGBA.js"
import { isValidPercentage } from "../lib/renderable.validations.js"
import type { RenderContext } from "../types.js"

const BOX_DEFAULTS = {
  backgroundColor: RGBA.fromValues(0, 0, 0, 0), // transparent
  border: false,
  borderStyle: "single",
  borderColor: hexToRgb("#FFFFFF"),
  focusedBorderColor: hexToRgb("#00AAFF"),
  shouldFill: true,
  titleAlignment: "left",
  bottomTitleAlignment: "left",
} satisfies Partial<BoxOptions>

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
  protected _backgroundColor: RGBA | undefined
  protected _border: boolean | BorderSides[] | undefined
  protected _borderStyle: BorderStyle | undefined
  protected _borderColor: RGBA | undefined
  protected _focusedBorderColor: RGBA | undefined
  private _customBorderCharsObj: BorderCharacters | undefined
  protected _customBorderChars?: Uint32Array
  protected borderSides: BorderSidesConfig
  public shouldFill: boolean
  protected _title: string | undefined
  protected _titleColor: RGBA | undefined
  protected _titleAlignment: "left" | "center" | "right" | undefined
  protected _bottomTitle: string | undefined
  protected _bottomTitleAlignment: "left" | "center" | "right" | undefined

  constructor(ctx: RenderContext, options: BoxOptions) {
    super(ctx, options)

    if (options.focusable === true) {
      this._focusable = true
    }

    this._border = options.border
    this._borderStyle = options.borderStyle != null ? parseBorderStyle(options.borderStyle) : undefined
    this._borderColor = options.borderColor != null ? parseColor(options.borderColor) : undefined
    this._focusedBorderColor = options.focusedBorderColor ? parseColor(options.focusedBorderColor) : undefined
    this._backgroundColor = options.backgroundColor != null ? parseColor(options.backgroundColor) : undefined
    this._customBorderCharsObj = options.customBorderChars
    this._customBorderChars = this._customBorderCharsObj ? borderCharsToArray(this._customBorderCharsObj) : undefined
    this.borderSides = getBorderSides(this.border)
    this.shouldFill = options.shouldFill ?? BOX_DEFAULTS.shouldFill
    this._title = options.title
    this._titleAlignment = options.titleAlignment
    this._titleColor = options.titleColor ? parseColor(options.titleColor) : undefined
    this._bottomTitle = options.bottomTitle
    this._bottomTitleAlignment = options.bottomTitleAlignment

    this.applyYogaBorders()

    const hasInitialGapProps =
      options.gap !== undefined || options.rowGap !== undefined || options.columnGap !== undefined
    if (hasInitialGapProps) {
      this.applyYogaGap(options)
    }
  }

  // Recomputes the derived border state after any border-related property
  // changes, since `border` can flip on/off without being set itself.
  private syncBorderSides(): void {
    this.borderSides = getBorderSides(this.border)
    this.applyYogaBorders()
  }

  public get customBorderChars(): BorderCharacters | undefined {
    return this._customBorderCharsObj
  }

  public set customBorderChars(value: BorderCharacters | undefined) {
    if (this._customBorderCharsObj !== value) {
      this._customBorderCharsObj = value
      this._customBorderChars = value ? borderCharsToArray(value) : undefined
      this.syncBorderSides()
    }
  }

  public get backgroundColor(): RGBA {
    return this._backgroundColor ?? BOX_DEFAULTS.backgroundColor
  }

  public set backgroundColor(value: RGBA | string | undefined) {
    const newColor = value != null ? parseColor(value) : undefined
    if (this._backgroundColor !== newColor) {
      this._backgroundColor = newColor
      this.requestRender()
    }
  }

  public get border(): boolean | BorderSides[] {
    if (this._border != null) {
      return this._border
    }
    // https://github.com/anomalyco/opentui/issues/186
    // Reconcilers set properties one by one after construction, so any
    // border-related property being set implies a border.
    if (
      this._borderStyle != null ||
      this._borderColor != null ||
      this._focusedBorderColor != null ||
      this._customBorderChars != null
    ) {
      return true
    }
    return BOX_DEFAULTS.border
  }

  public set border(value: boolean | BorderSides[] | undefined) {
    if (this._border !== value) {
      this._border = value
      this.syncBorderSides()
    }
  }

  public get borderStyle(): BorderStyle {
    return this._borderStyle ?? BOX_DEFAULTS.borderStyle
  }

  public set borderStyle(value: BorderStyle | undefined) {
    const newValue = value != null ? parseBorderStyle(value) : undefined
    if (this._borderStyle !== newValue) {
      this._borderStyle = newValue
      if (newValue != null) {
        // a concrete style replaces previously set custom characters
        this._customBorderCharsObj = undefined
        this._customBorderChars = undefined
      }
      this.syncBorderSides()
    }
  }

  public get borderColor(): RGBA {
    return this._borderColor ?? BOX_DEFAULTS.borderColor
  }

  public set borderColor(value: RGBA | string | undefined) {
    const newColor = value != null ? parseColor(value) : undefined
    if (this._borderColor !== newColor) {
      this._borderColor = newColor
      this.syncBorderSides()
    }
  }

  public get focusedBorderColor(): RGBA {
    return this._focusedBorderColor ?? BOX_DEFAULTS.focusedBorderColor
  }

  public set focusedBorderColor(value: RGBA | string | undefined) {
    const newColor = value != null ? parseColor(value) : undefined
    if (this._focusedBorderColor !== newColor) {
      this._focusedBorderColor = newColor
      this.syncBorderSides()
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
    return this._titleAlignment ?? BOX_DEFAULTS.titleAlignment
  }

  public set titleAlignment(value: "left" | "center" | "right" | undefined) {
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
    return this._bottomTitleAlignment ?? BOX_DEFAULTS.bottomTitleAlignment
  }

  public set bottomTitleAlignment(value: "left" | "center" | "right" | undefined) {
    if (this._bottomTitleAlignment !== value) {
      this._bottomTitleAlignment = value
      this.requestRender()
    }
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    const hasBorder = this.borderSides.top || this.borderSides.right || this.borderSides.bottom || this.borderSides.left
    const hasVisibleFill = this.shouldFill && this.backgroundColor.a > 0
    // Many boxes are used only for layout. Skip drawBox entirely when a box
    // would not draw pixels so wrapper nodes do not pay the FFI/native cost.
    if (!hasBorder && !hasVisibleFill) {
      return
    }

    const hasFocusWithin = this._focusable && (this._focused || this._hasFocusedDescendant)
    const currentBorderColor = hasFocusWithin ? this.focusedBorderColor : this.borderColor
    const screenX = this._screenX
    const screenY = this._screenY

    buffer.drawBox({
      x: screenX,
      y: screenY,
      width: this.width,
      height: this.height,
      borderStyle: this.borderStyle,
      customBorderChars: this._customBorderChars,
      border: this.border,
      borderColor: currentBorderColor,
      backgroundColor: this.backgroundColor,
      shouldFill: this.shouldFill,
      title: this._title,
      titleColor: this._titleColor ?? currentBorderColor,
      titleAlignment: this.titleAlignment,
      bottomTitle: this._bottomTitle,
      bottomTitleAlignment: this.bottomTitleAlignment,
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
