import type { OptimizedBuffer } from "../buffer.js"
import { parseColor, RGBA, type ColorInput } from "../lib/index.js"
import type { KeyEvent } from "../lib/KeyHandler.js"
import { stringWidth } from "../platform/runtime.js"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import type { RenderContext, Timeout } from "../types.js"
import { type BoxOptions } from "./Box.js"
import { SliderRenderable, type SliderOptions } from "./Slider.js"

export interface ScrollBarOptions extends RenderableOptions<ScrollBarRenderable> {
  orientation: "vertical" | "horizontal"
  showArrows?: boolean
  arrowOptions?: Omit<ArrowOptions, "direction">
  trackOptions?: Partial<SliderOptions>
  onChange?: (position: number) => void
}

export type ScrollUnit = "absolute" | "viewport" | "content" | "step"

export class ScrollBarRenderable extends Renderable {
  public readonly slider: SliderRenderable
  public readonly startArrow: ArrowRenderable
  public readonly endArrow: ArrowRenderable
  public readonly orientation: "vertical" | "horizontal"

  protected _focusable: boolean = true

  private _scrollSize = 0
  private _scrollPosition = 0
  private _viewportSize = 0
  private _showArrows = false
  private _manualVisibility = false

  private _onChange: ((position: number) => void) | undefined

  scrollStep: number | undefined | null = null

  get visible(): boolean {
    return super.visible
  }

  set visible(value: boolean) {
    this._manualVisibility = true
    super.visible = value
  }

  public resetVisibilityControl(): void {
    this._manualVisibility = false
    this.recalculateVisibility()
  }

  get scrollSize(): number {
    return this._scrollSize
  }

  get scrollPosition(): number {
    return this._scrollPosition
  }

  get viewportSize(): number {
    return this._viewportSize
  }

  set scrollSize(value: number) {
    if (value === this.scrollSize) return
    this._scrollSize = value
    this.recalculateVisibility()
    this.updateSliderFromScrollState()
    this.scrollPosition = this.scrollPosition
  }

  set scrollPosition(value: number) {
    const newPosition = Math.round(Math.max(0, Math.min(value, this.scrollSize - this.viewportSize)))
    if (newPosition !== this._scrollPosition) {
      this._scrollPosition = newPosition
      this.updateSliderFromScrollState()
      // Events are triggered by the slider change event
      // this._onChange?.(newPosition)
      // this.emit("change", { position: newPosition })
    }
  }

  set viewportSize(value: number) {
    if (value === this.viewportSize) return
    this._viewportSize = value
    this.slider.viewPortSize = Math.max(1, this._viewportSize)
    this.recalculateVisibility()
    this.updateSliderFromScrollState()
    this.scrollPosition = this.scrollPosition
  }

  get showArrows(): boolean {
    return this._showArrows
  }

  set showArrows(value: boolean) {
    if (value === this._showArrows) return
    this._showArrows = value
    this.startArrow.visible = value
    this.endArrow.visible = value
  }

  constructor(
    ctx: RenderContext,
    { trackOptions, arrowOptions, orientation, showArrows = false, ...options }: ScrollBarOptions,
  ) {
    super(ctx, {
      flexDirection: orientation === "vertical" ? "column" : "row",
      alignSelf: "stretch",
      alignItems: "stretch",
      ...(options as BoxOptions),
    })

    this._onChange = options.onChange

    this.orientation = orientation
    this._showArrows = showArrows

    const scrollRange = Math.max(0, this._scrollSize - this._viewportSize)

    const defaultStepSize = Math.max(1, this._viewportSize)
    const stepSize = trackOptions?.viewPortSize ?? defaultStepSize

    this.slider = new SliderRenderable(ctx, {
      orientation,
      min: 0,
      max: scrollRange,
      value: this._scrollPosition,
      viewPortSize: stepSize,
      onChange: (value) => {
        this._scrollPosition = Math.round(value)
        this._onChange?.(this._scrollPosition)
        this.emit("change", { position: this._scrollPosition })
      },
      ...(orientation === "vertical"
        ? {
            width: Math.max(1, Math.min(2, this.width)),
            height: "100%",
            marginLeft: "auto",
          }
        : {
            width: "100%",
            height: 1,
            marginTop: "auto",
          }),
      flexGrow: 1,
      flexShrink: 1,
      ...trackOptions,
    })

    this.updateSliderFromScrollState()

    const arrowOpts = arrowOptions
      ? {
          foregroundColor: arrowOptions.backgroundColor,
          backgroundColor: arrowOptions.backgroundColor,
          attributes: arrowOptions.attributes,
          ...arrowOptions,
        }
      : {}

    this.startArrow = new ArrowRenderable(ctx, {
      alignSelf: "center",
      visible: this.showArrows,
      direction: this.orientation === "vertical" ? "up" : "left",
      height: this.orientation === "vertical" ? 1 : 1,
      ...arrowOpts,
    })

    this.endArrow = new ArrowRenderable(ctx, {
      alignSelf: "center",
      visible: this.showArrows,
      direction: this.orientation === "vertical" ? "down" : "right",
      height: this.orientation === "vertical" ? 1 : 1,
      ...arrowOpts,
    })

    this.add(this.startArrow)
    this.add(this.slider)
    this.add(this.endArrow)

    let startArrowMouseTimeout = undefined as Timeout
    let endArrowMouseTimeout = undefined as Timeout

    this.startArrow.onMouseDown = (event) => {
      event.stopPropagation()
      event.preventDefault()

      this.scrollBy(-0.5, "viewport")

      startArrowMouseTimeout = setTimeout(() => {
        this.scrollBy(-0.5, "viewport")

        startArrowMouseTimeout = setInterval(() => {
          this.scrollBy(-0.2, "viewport")
        }, 200)
      }, 500)
    }

    this.startArrow.onMouseUp = (event) => {
      event.stopPropagation()
      clearInterval(startArrowMouseTimeout!)
    }

    this.endArrow.onMouseDown = (event) => {
      event.stopPropagation()
      event.preventDefault()

      this.scrollBy(0.5, "viewport")

      endArrowMouseTimeout = setTimeout(() => {
        this.scrollBy(0.5, "viewport")

        endArrowMouseTimeout = setInterval(() => {
          this.scrollBy(0.2, "viewport")
        }, 200)
      }, 500)
    }

    this.endArrow.onMouseUp = (event) => {
      event.stopPropagation()
      clearInterval(endArrowMouseTimeout!)
    }
  }

  public set arrowOptions(options: ScrollBarOptions["arrowOptions"]) {
    Object.assign(this.startArrow, options)
    Object.assign(this.endArrow, options)
    this.requestRender()
  }

  public set trackOptions(options: ScrollBarOptions["trackOptions"]) {
    Object.assign(this.slider, options)
    this.requestRender()
  }

  private updateSliderFromScrollState(): void {
    const scrollRange = Math.max(0, this._scrollSize - this._viewportSize)

    this.slider.min = 0
    this.slider.max = scrollRange

    this.slider.value = Math.min(this._scrollPosition, scrollRange)
  }

  public scrollBy(delta: number, unit: ScrollUnit = "absolute"): void {
    const multiplier =
      unit === "viewport"
        ? this.viewportSize
        : unit === "content"
          ? this.scrollSize
          : unit === "step"
            ? (this.scrollStep ?? 1)
            : 1

    const resolvedDelta = multiplier * delta
    this.scrollPosition += resolvedDelta
  }

  private recalculateVisibility(): void {
    if (!this._manualVisibility) {
      const sizeRatio = this.scrollSize <= this.viewportSize ? 1 : this.viewportSize / this.scrollSize
      super.visible = sizeRatio < 1
    }
  }

  public handleKeyPress(key: KeyEvent): boolean {
    switch (key.name) {
      case "left":
      case "h":
        if (this.orientation !== "horizontal") return false
        this.scrollBy(-1 / 5, "viewport")
        return true
      case "right":
      case "l":
        if (this.orientation !== "horizontal") return false
        this.scrollBy(1 / 5, "viewport")
        return true
      case "up":
      case "k":
        if (this.orientation !== "vertical") return false
        this.scrollBy(-1 / 5, "viewport")
        return true
      case "down":
      case "j":
        if (this.orientation !== "vertical") return false
        this.scrollBy(1 / 5, "viewport")
        return true
      case "pageup":
        this.scrollBy(-1 / 2, "viewport")
        return true
      case "pagedown":
        this.scrollBy(1 / 2, "viewport")
        return true
      case "home":
        this.scrollBy(-1, "content")
        return true
      case "end":
        this.scrollBy(1, "content")
        return true
    }

    return false
  }
}

export interface ArrowOptions extends RenderableOptions<ArrowRenderable> {
  direction: "up" | "down" | "left" | "right"
  foregroundColor?: ColorInput
  backgroundColor?: ColorInput
  attributes?: number
  arrowChars?: {
    up?: string
    down?: string
    left?: string
    right?: string
  }
}

export class ArrowRenderable extends Renderable {
  private _direction: "up" | "down" | "left" | "right"
  private _foregroundColor: RGBA
  private _backgroundColor: RGBA
  private _attributes: number
  private _arrowChars: {
    up: string
    down: string
    left: string
    right: string
  }

  constructor(ctx: RenderContext, options: ArrowOptions) {
    super(ctx, options)
    this._direction = options.direction
    this._foregroundColor = options.foregroundColor ? parseColor(options.foregroundColor) : RGBA.fromValues(1, 1, 1, 1)
    this._backgroundColor = options.backgroundColor ? parseColor(options.backgroundColor) : RGBA.fromValues(0, 0, 0, 0)
    this._attributes = options.attributes ?? 0

    this._arrowChars = {
      up: "▲",
      down: "▼",
      left: "◀",
      right: "▶",
      ...options.arrowChars,
    }

    if (!options.width) {
      this.width = stringWidth(this.getArrowChar())
    }
  }

  get direction(): "up" | "down" | "left" | "right" {
    return this._direction
  }

  set direction(value: "up" | "down" | "left" | "right") {
    if (this._direction !== value) {
      this._direction = value
      this.requestRender()
    }
  }

  get foregroundColor(): RGBA {
    return this._foregroundColor
  }

  set foregroundColor(value: ColorInput) {
    if (this._foregroundColor !== value) {
      this._foregroundColor = parseColor(value)
      this.requestRender()
    }
  }

  get backgroundColor(): RGBA {
    return this._backgroundColor
  }

  set backgroundColor(value: ColorInput) {
    if (this._backgroundColor !== value) {
      this._backgroundColor = parseColor(value)
      this.requestRender()
    }
  }

  get attributes(): number {
    return this._attributes
  }

  set attributes(value: number) {
    if (this._attributes !== value) {
      this._attributes = value
      this.requestRender()
    }
  }

  set arrowChars(value: ArrowOptions["arrowChars"]) {
    this._arrowChars = {
      ...this._arrowChars,
      ...value,
    }
    this.requestRender()
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    const char = this.getArrowChar()
    buffer.drawText(char, this.x, this.y, this._foregroundColor, this._backgroundColor, this._attributes)
  }

  private getArrowChar(): string {
    switch (this._direction) {
      case "up":
        return this._arrowChars.up
      case "down":
        return this._arrowChars.down
      case "left":
        return this._arrowChars.left
      case "right":
        return this._arrowChars.right
      default:
        return "?"
    }
  }
}
