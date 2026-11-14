import { Gutter } from "../yoga.js"
import { type RenderableOptions, Renderable, type NativeRenderableIntegration } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import {
  type BorderCharacters,
  type BorderSides,
  type BorderSidesConfig,
  type BorderStyle,
  borderCharsToArray,
  getBorderSides,
  isValidBorderStyle,
  parseBorderStyle,
} from "../lib/index.js"
import { type ColorInput, RGBA, parseColor } from "../lib/RGBA.js"
import { isValidPercentage } from "../lib/renderable.validations.js"
import type { RenderContext } from "../types.js"
import type { NativeScenePaint, NativeSceneBoxDetails } from "../zig.js"

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
  /** One side's style over `borderStyle`; undefined takes `borderStyle`. It draws no side: `border` chooses those. */
  borderTopStyle?: BorderStyle | undefined
  borderRightStyle?: BorderStyle | undefined
  borderBottomStyle?: BorderStyle | undefined
  borderLeftStyle?: BorderStyle | undefined
  /** One side's color over `borderColor`; undefined takes `borderColor`. `focusedBorderColor` still colors every side. */
  borderTopColor?: ColorInput | undefined
  borderRightColor?: ColorInput | undefined
  borderBottomColor?: ColorInput | undefined
  borderLeftColor?: ColorInput | undefined
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

function borderMask(sides: BorderSidesConfig): number {
  return (sides.left ? 1 : 0) | (sides.bottom ? 2 : 0) | (sides.right ? 4 : 0) | (sides.top ? 8 : 0)
}

// Side indexes follow the border mask's bits: left, bottom, right, top.
const LEFT = 0
const BOTTOM = 1
const RIGHT = 2
const TOP = 3
const SIDE_STYLE_OPTIONS = ["borderLeftStyle", "borderBottomStyle", "borderRightStyle", "borderTopStyle"] as const
const SIDE_COLOR_OPTIONS = ["borderLeftColor", "borderBottomColor", "borderRightColor", "borderTopColor"] as const

/** A box's per-side overrides; only boxes that set one hold them. */
interface SideOverrides {
  styles: (BorderStyle | undefined)[]
  colors: (RGBA | undefined)[]
}

/** An invalid style is ignored, as CSS ignores an invalid declaration: the side takes `borderStyle`. */
function parseSideStyle(value: unknown): BorderStyle | undefined {
  if (value == null || isValidBorderStyle(value)) return value ?? undefined
  console.warn(
    `Invalid border side style "${value}", using borderStyle. Valid values are: single, double, rounded, heavy`,
  )
  return undefined
}

function isEmpty(sides: SideOverrides): boolean {
  return sides.styles.every((style) => style === undefined) && sides.colors.every((color) => color === undefined)
}

export class BoxRenderable extends Renderable {
  static override readonly nativeIntegration: NativeRenderableIntegration = {
    kind: "box",
    body: { native: this.prototype.renderSelf },
  }
  protected _backgroundColor: RGBA
  protected _border: boolean | BorderSides[]
  protected _borderStyle: BorderStyle
  protected _borderColor: RGBA
  protected _focusedBorderColor: RGBA
  private _customBorderCharsObj: BorderCharacters | undefined
  protected _customBorderChars?: Uint32Array
  protected borderSides: BorderSidesConfig
  private _shouldFill: boolean
  protected _title?: string
  protected _titleColor?: RGBA
  protected _titleAlignment: "left" | "center" | "right"
  protected _bottomTitle?: string
  protected _bottomTitleAlignment: "left" | "center" | "right"
  // Declared, not initialized: a box without overrides never gets the property, so it costs nothing (D122).
  declare private _sideOverrides: SideOverrides | undefined

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

    try {
      if (options.focusable === true) {
        this._focusable = true
      }

      this._backgroundColor = RGBA.clone(parseColor(options.backgroundColor || this._defaultOptions.backgroundColor))
      this._border = options.border ?? this._defaultOptions.border
      if (
        !options.border &&
        (options.borderStyle || options.borderColor || options.focusedBorderColor || options.customBorderChars)
      ) {
        this._border = true
      }
      this._borderStyle = parseBorderStyle(options.borderStyle, this._defaultOptions.borderStyle)
      this._borderColor = RGBA.clone(parseColor(options.borderColor || this._defaultOptions.borderColor))
      if (Array.isArray(this._border)) this._border = [...this._border]
      this._focusedBorderColor = RGBA.clone(
        parseColor(options.focusedBorderColor || this._defaultOptions.focusedBorderColor),
      )
      this._customBorderCharsObj = options.customBorderChars
      this._customBorderChars = this._customBorderCharsObj ? borderCharsToArray(this._customBorderCharsObj) : undefined
      this.borderSides = getBorderSides(this._border)
      this._shouldFill = options.shouldFill ?? this._defaultOptions.shouldFill
      this._title = options.title
      this._titleColor = options.titleColor ? RGBA.clone(parseColor(options.titleColor)) : undefined
      this._titleAlignment = options.titleAlignment || this._defaultOptions.titleAlignment
      this._bottomTitle = options.bottomTitle
      this._bottomTitleAlignment = options.bottomTitleAlignment || this._defaultOptions.bottomTitleAlignment

      this.setNativeScenePaint()
      this.requestRender()
      if (
        this._title ||
        this._bottomTitle ||
        this._titleColor ||
        this._customBorderChars ||
        this._titleAlignment !== "left" ||
        this._bottomTitleAlignment !== "left"
      ) {
        this.setNativeBoxDetails()
      }
      this.applySideOptions(options)

      const hasInitialGapProps =
        options.gap !== undefined || options.rowGap !== undefined || options.columnGap !== undefined
      if (hasInitialGapProps) {
        this.applyYogaGap(options)
      }
    } catch (error) {
      this.abortConstruction(error)
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
    }
  }

  public get customBorderChars(): BorderCharacters | undefined {
    return this._customBorderCharsObj
  }

  public set customBorderChars(value: BorderCharacters | undefined) {
    const chars = value ? borderCharsToArray(value) : undefined
    this.setNativeBoxDetails({ customBorderChars: chars })
    this._customBorderCharsObj = value
    this._customBorderChars = chars
    this.requestRender()
  }

  /** Requested value, snapshotted when staging succeeds; native accepts it at the next boundary. */
  public get backgroundColor(): RGBA {
    return RGBA.clone(this._backgroundColor)
  }

  public set backgroundColor(value: RGBA | string | undefined) {
    if (this.isFreed()) return
    const newColor = RGBA.clone(parseColor(value ?? this._defaultOptions.backgroundColor))
    this._ctx.nativeScene.setBackground(this, newColor)
    this._backgroundColor = newColor
    this.requestRender()
  }

  public get border(): boolean | BorderSides[] {
    if (Array.isArray(this._border)) return [...this._border]
    return this._border
  }

  public set border(value: boolean | BorderSides[]) {
    if (this._border !== value) {
      const sides = getBorderSides(value)
      this.setNativeScenePaint({ border: borderMask(sides) })
      this._border = Array.isArray(value) ? [...value] : value
      this.borderSides = sides
      this.requestRender()
    }
  }

  public get borderStyle(): BorderStyle {
    return this._borderStyle
  }

  public set borderStyle(value: BorderStyle) {
    const _value = parseBorderStyle(value, this._defaultOptions.borderStyle)
    if (this._borderStyle !== _value || !this._border) {
      this.runMutation(() => {
        this._ctx.nativeScene.setBoxBorderStyle(
          this,
          _value,
          this._border === false ? 15 : borderMask(this.borderSides),
        )
        this._borderStyle = _value
        this._customBorderChars = undefined
        this._customBorderCharsObj = undefined
        this.initializeBorder()
        this.requestRender()
      })
    }
  }

  public get borderColor(): RGBA {
    return RGBA.clone(this._borderColor)
  }

  public set borderColor(value: RGBA | string) {
    const newColor = RGBA.clone(parseColor(value ?? this._defaultOptions.borderColor))
    this.setNativeScenePaint({
      borderColor: newColor,
      border: this._border === false ? 15 : borderMask(this.borderSides),
    })
    this._borderColor = newColor
    this.initializeBorder()
    this.requestRender()
  }

  public get focusedBorderColor(): RGBA {
    return RGBA.clone(this._focusedBorderColor)
  }

  public set focusedBorderColor(value: RGBA | string) {
    const newColor = RGBA.clone(parseColor(value ?? this._defaultOptions.focusedBorderColor))
    this.setNativeScenePaint({
      focusedBorderColor: newColor,
      border: this._border === false ? 15 : borderMask(this.borderSides),
    })
    this._focusedBorderColor = newColor
    this.initializeBorder()
    this.requestRender()
  }

  // Per-side overrides. Reads return what was set, not the resolved paint; undefined takes the base again.
  public get borderTopStyle(): BorderStyle | undefined {
    return this._sideOverrides?.styles[TOP]
  }

  public set borderTopStyle(value: BorderStyle | undefined) {
    this.setSideStyle(TOP, value)
  }

  public get borderRightStyle(): BorderStyle | undefined {
    return this._sideOverrides?.styles[RIGHT]
  }

  public set borderRightStyle(value: BorderStyle | undefined) {
    this.setSideStyle(RIGHT, value)
  }

  public get borderBottomStyle(): BorderStyle | undefined {
    return this._sideOverrides?.styles[BOTTOM]
  }

  public set borderBottomStyle(value: BorderStyle | undefined) {
    this.setSideStyle(BOTTOM, value)
  }

  public get borderLeftStyle(): BorderStyle | undefined {
    return this._sideOverrides?.styles[LEFT]
  }

  public set borderLeftStyle(value: BorderStyle | undefined) {
    this.setSideStyle(LEFT, value)
  }

  public get borderTopColor(): RGBA | undefined {
    return this.sideColor(TOP)
  }

  public set borderTopColor(value: ColorInput | undefined) {
    this.setSideColor(TOP, value)
  }

  public get borderRightColor(): RGBA | undefined {
    return this.sideColor(RIGHT)
  }

  public set borderRightColor(value: ColorInput | undefined) {
    this.setSideColor(RIGHT, value)
  }

  public get borderBottomColor(): RGBA | undefined {
    return this.sideColor(BOTTOM)
  }

  public set borderBottomColor(value: ColorInput | undefined) {
    this.setSideColor(BOTTOM, value)
  }

  public get borderLeftColor(): RGBA | undefined {
    return this.sideColor(LEFT)
  }

  public set borderLeftColor(value: ColorInput | undefined) {
    this.setSideColor(LEFT, value)
  }

  private sideColor(side: number): RGBA | undefined {
    const color = this._sideOverrides?.colors[side]
    return color ? RGBA.clone(color) : undefined
  }

  private setSideStyle(side: number, value: BorderStyle | undefined): void {
    const style = parseSideStyle(value)
    if (this._sideOverrides?.styles[side] === style) return
    this.publishSides((sides) => (sides.styles[side] = style))
  }

  private setSideColor(side: number, value: ColorInput | undefined): void {
    const color = value == null ? undefined : RGBA.clone(parseColor(value))
    if (color === undefined && this._sideOverrides?.colors[side] === undefined) return
    this.publishSides((sides) => (sides.colors[side] = color))
  }

  /** One native call per change; the overrides go away when the last one clears. */
  private publishSides(change: (sides: SideOverrides) => void): void {
    if (this.isFreed()) return
    const current = this._sideOverrides
    const next: SideOverrides = current
      ? { styles: [...current.styles], colors: [...current.colors] }
      : { styles: [undefined, undefined, undefined, undefined], colors: [undefined, undefined, undefined, undefined] }
    change(next)
    this._ctx.nativeScene.setBoxSides(this, next)
    this._sideOverrides = isEmpty(next) ? undefined : next
    this.requestRender()
  }

  private applySideOptions(options: BoxOptions): void {
    for (let side = LEFT; side <= TOP; side++) {
      const style = options[SIDE_STYLE_OPTIONS[side]]
      const color = options[SIDE_COLOR_OPTIONS[side]]
      if (style !== undefined || color != null) {
        this.publishSides((sides) => {
          for (let index = LEFT; index <= TOP; index++) {
            sides.styles[index] = parseSideStyle(options[SIDE_STYLE_OPTIONS[index]])
            const input = options[SIDE_COLOR_OPTIONS[index]]
            sides.colors[index] = input == null ? undefined : RGBA.clone(parseColor(input))
          }
        })
        return
      }
    }
  }

  public get title(): string | undefined {
    return this._title
  }

  public set title(value: string | undefined) {
    if (this._title !== value) {
      this.setNativeBoxDetails({ title: value })
      this._title = value
      this.requestRender()
    }
  }

  public get titleColor(): RGBA | undefined {
    return this._titleColor ? RGBA.clone(this._titleColor) : undefined
  }

  public set titleColor(value: string | RGBA | undefined) {
    const newColor = value ? RGBA.clone(parseColor(value)) : undefined
    if (this._titleColor !== newColor) {
      this.setNativeBoxDetails({ titleColor: newColor })
      this._titleColor = newColor
      this.requestRender()
    }
  }

  public get titleAlignment(): "left" | "center" | "right" {
    return this._titleAlignment
  }

  public set titleAlignment(value: "left" | "center" | "right") {
    value ??= this._defaultOptions.titleAlignment
    if (this._titleAlignment !== value) {
      this.setNativeBoxDetails({ titleAlignment: value })
      this._titleAlignment = value
      this.requestRender()
    }
  }

  public get bottomTitle(): string | undefined {
    return this._bottomTitle
  }

  public set bottomTitle(value: string | undefined) {
    if (this._bottomTitle !== value) {
      this.setNativeBoxDetails({ bottomTitle: value })
      this._bottomTitle = value
      this.requestRender()
    }
  }

  public get bottomTitleAlignment(): "left" | "center" | "right" {
    return this._bottomTitleAlignment
  }

  public set bottomTitleAlignment(value: "left" | "center" | "right") {
    value ??= this._defaultOptions.bottomTitleAlignment
    if (this._bottomTitleAlignment !== value) {
      this.setNativeBoxDetails({ bottomTitleAlignment: value })
      this._bottomTitleAlignment = value
      this.requestRender()
    }
  }

  private setNativeBoxDetails(details: Partial<NativeSceneBoxDetails> = {}): void {
    if (this.isFreed()) return
    this._ctx.nativeScene.setBoxDetails(this, {
      title: this._title,
      bottomTitle: this._bottomTitle,
      titleAlignment: this._titleAlignment,
      bottomTitleAlignment: this._bottomTitleAlignment,
      titleColor: this._titleColor,
      customBorderChars: this._customBorderChars,
      ...details,
    })
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    // A layout-only box records nothing; native would draw nothing for it either.
    if (borderMask(this.borderSides) === 0 && !(this._shouldFill && this._backgroundColor.a > 0)) return
    this._drawNativeBody(buffer)
  }

  public get shouldFill(): boolean {
    return this._shouldFill
  }

  public set shouldFill(value: boolean) {
    value ??= this._defaultOptions.shouldFill
    if (this._shouldFill === value) return
    this.setNativeScenePaint({ shouldFill: value })
    this._shouldFill = value
    this.requestRender()
  }

  protected getNativeScenePaint(): NativeScenePaint {
    return {
      zIndex: this._zIndex,
      opacity: this._opacity,
      translateX: this._translateX,
      translateY: this._translateY,
      focusable: this._focusable,
      border: borderMask(this.borderSides),
      shouldFill: this._shouldFill,
      backgroundColor: this._backgroundColor,
      borderColor: this._borderColor,
      focusedBorderColor: this._focusedBorderColor,
      borderStyle: this._borderStyle,
    }
  }

  private applyYogaGap(options: BoxOptions): void {
    if (isGapType(options.gap)) {
      this.setGap(Gutter.All, options.gap)
    }

    if (isGapType(options.rowGap)) {
      this.setGap(Gutter.Row, options.rowGap)
    }

    if (isGapType(options.columnGap)) {
      this.setGap(Gutter.Column, options.columnGap)
    }
  }

  public set gap(gap: number | `${number}%` | null | undefined) {
    this.setGapStyle(Gutter.All, gap)
  }

  public set rowGap(rowGap: number | `${number}%` | null | undefined) {
    this.setGapStyle(Gutter.Row, rowGap)
  }

  public set columnGap(columnGap: number | `${number}%` | null | undefined) {
    this.setGapStyle(Gutter.Column, columnGap)
  }

  // A nullish gap unsets the gutter, as when the option is omitted.
  private setGapStyle(gutter: Gutter, gap: number | `${number}%` | null | undefined): void {
    if (gap != null && !isGapType(gap)) return
    this.setGap(gutter, gap ?? undefined)
    this.requestRender()
  }
}
