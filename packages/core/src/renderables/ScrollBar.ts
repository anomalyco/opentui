import { assertRenderableMutable } from "../lib/renderable-layout.js"
import type { OptimizedBuffer } from "../buffer.js"
import { parseColor, RGBA, type ColorInput } from "../lib/index.js"
import type { KeyEvent } from "../lib/KeyHandler.js"
import { Renderable, RenderableEvents, type RenderableOptions } from "../Renderable.js"
import type { RenderContext, Timeout } from "../types.js"
import type { NativeSceneArrowOptions } from "../zig.js"
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
  private arrowRepeat?: { arrow: ArrowRenderable; timer: Timeout }

  scrollStep: number | undefined | null = null

  get visible(): boolean {
    return super.visible
  }

  set visible(value: boolean) {
    assertRenderableMutable(this)
    this._manualVisibility = true
    super.visible = value
  }

  public resetVisibilityControl(): void {
    assertRenderableMutable(this)
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
    if (this.isDestroyed) return
    assertRenderableMutable(this)
    if (!Number.isFinite(value) || !Number.isFinite(value - this._viewportSize)) {
      throw new RangeError("Scene scroll sizes and ranges must be finite numbers")
    }
    if (value === this.scrollSize) return
    this._scrollSize = value
    this.recalculateVisibility()
    if (this.isDestroyed || this.slider.isDestroyed) return
    this.updateSliderFromScrollState()
    if (this.isDestroyed || this.slider.isDestroyed) return
    this.scrollPosition = this.scrollPosition
  }

  set scrollPosition(value: number) {
    if (this.isDestroyed) return
    assertRenderableMutable(this)
    const newPosition = Math.round(Math.min(Math.max(0, value), this.scrollSize - this.viewportSize))
    if (!Number.isFinite(newPosition)) {
      throw new RangeError("Scene scroll positions must be finite numbers")
    }
    if (newPosition !== this._scrollPosition) {
      this._scrollPosition = newPosition
      this.updateSliderFromScrollState()
      // Events are triggered by the slider change event
      // this._onChange?.(newPosition)
      // this.emit("change", { position: newPosition })
    }
  }

  set viewportSize(value: number) {
    if (this.isDestroyed) return
    assertRenderableMutable(this)
    if (!Number.isFinite(value) || !Number.isFinite(this._scrollSize - value)) {
      throw new RangeError("Scene viewport sizes and ranges must be finite numbers")
    }
    if (value === this.viewportSize) return
    this.slider.viewPortSize = Math.max(1, value)
    this._viewportSize = value
    this.recalculateVisibility()
    if (this.isDestroyed || this.slider.isDestroyed) return
    this.updateSliderFromScrollState()
    if (this.isDestroyed || this.slider.isDestroyed) return
    this.scrollPosition = this.scrollPosition
  }

  get showArrows(): boolean {
    return this._showArrows
  }

  set showArrows(value: boolean) {
    if (this.isDestroyed || value === this._showArrows) return
    assertRenderableMutable(this)
    this._showArrows = value
    this.startArrow.visible = value
    if (this.isDestroyed || this.endArrow.isDestroyed) return
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

    const children: Renderable[] = []
    try {
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
          if (this.isDestroyed) return
          this._scrollPosition = Math.round(value)
          this._onChange?.(this._scrollPosition)
          if (!this.isDestroyed) this.emit("change", { position: this._scrollPosition })
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
      children.push(this.slider)

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
      children.push(this.startArrow)

      this.endArrow = new ArrowRenderable(ctx, {
        alignSelf: "center",
        visible: this.showArrows,
        direction: this.orientation === "vertical" ? "down" : "right",
        height: this.orientation === "vertical" ? 1 : 1,
        ...arrowOpts,
      })
      children.push(this.endArrow)

      this.add(this.startArrow)
      this.add(this.slider)
      this.add(this.endArrow)

      for (const [arrow, direction] of [
        [this.startArrow, -1],
        [this.endArrow, 1],
      ] as const) {
        arrow.onMouseDown = (event) => {
          event.stopPropagation()
          event.preventDefault()
          this.stopArrowRepeat()
          if (this.isDestroyed || arrow.isDestroyed) return
          const repeat = { arrow, timer: undefined as Timeout }
          this.arrowRepeat = repeat
          this.scrollBy(direction * 0.5, "viewport")
          if (this.arrowRepeat !== repeat || this.isDestroyed || arrow.isDestroyed) return

          repeat.timer = setTimeout(() => {
            repeat.timer = undefined
            if (this.arrowRepeat !== repeat || this.isDestroyed || arrow.isDestroyed) return
            this.scrollBy(direction * 0.5, "viewport")
            if (this.arrowRepeat !== repeat || this.isDestroyed || arrow.isDestroyed) return

            repeat.timer = setInterval(() => {
              if (this.arrowRepeat !== repeat) return
              if (this.isDestroyed || arrow.isDestroyed) {
                this.stopArrowRepeat()
                return
              }
              this.scrollBy(direction * 0.2, "viewport")
            }, 200)
          }, 500)
        }

        arrow.onMouseUp = (event) => {
          event.stopPropagation()
          this.stopArrowRepeat()
        }
        arrow.on(RenderableEvents.DESTROYED, () => {
          if (this.arrowRepeat?.arrow === arrow) this.stopArrowRepeat()
        })
      }
      this.setNativeScenePaint()
    } catch (error) {
      this.abortConstruction(error, (run) => {
        run(() => this.stopArrowRepeat())
        for (let index = children.length - 1; index >= 0; index--) {
          run(() => children[index].destroyRecursively())
        }
      })
    }
  }

  private stopArrowRepeat(): void {
    const repeat = this.arrowRepeat
    this.arrowRepeat = undefined
    if (repeat) clearTimeout(repeat.timer)
  }

  protected destroyOwnedResources(): void {
    this.stopArrowRepeat()
    super.destroyOwnedResources()
  }

  public set arrowOptions(options: ScrollBarOptions["arrowOptions"]) {
    this.assignOptions(this.startArrow, options)
    this.assignOptions(this.endArrow, options)
    if (!this.isDestroyed) this.requestRender()
  }

  public set trackOptions(options: ScrollBarOptions["trackOptions"]) {
    this.assignOptions(this.slider, options)
    if (!this.isDestroyed) this.requestRender()
  }

  private updateSliderFromScrollState(): void {
    const scrollRange = Math.max(0, this._scrollSize - this._viewportSize)

    this.slider.min = 0
    if (this.isDestroyed || this.slider.isDestroyed) return
    this.slider.max = scrollRange
    if (this.isDestroyed || this.slider.isDestroyed) return
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
    try {
      this._direction = options.direction
      this._foregroundColor = options.foregroundColor
        ? RGBA.clone(parseColor(options.foregroundColor))
        : RGBA.fromValues(1, 1, 1, 1)
      this._backgroundColor = options.backgroundColor
        ? RGBA.clone(parseColor(options.backgroundColor))
        : RGBA.fromValues(0, 0, 0, 0)
      this._attributes = options.attributes ?? 0

      this._arrowChars = {
        up: "▲",
        down: "▼",
        left: "◀",
        right: "▶",
        ...options.arrowChars,
      }

      if (!options.width) {
        const { context, renderLib } = ctx.nativeScene.driver
        const unicode = renderLib.createContextUnicode(context, this.getArrowChar(), ctx.widthMethod)
        try {
          this.width = renderLib.getContextUnicode(context, unicode).reduce((width, glyph) => width + glyph.width, 0)
        } finally {
          renderLib.destroyContextUnicode(context, unicode)
        }
      }
      this.setNativeSceneArrow()
      this.setNativeScenePaint()
    } catch (error) {
      this.abortConstruction(error)
    }
  }

  get direction(): "up" | "down" | "left" | "right" {
    return this._direction
  }

  set direction(value: "up" | "down" | "left" | "right") {
    if (this._direction !== value) {
      this.setNativeSceneArrow({ direction: value, text: this._arrowChars[value] })
      this._direction = value
      this.requestRender()
    }
  }

  get foregroundColor(): RGBA {
    return RGBA.clone(this._foregroundColor)
  }

  set foregroundColor(value: ColorInput) {
    if (this._foregroundColor !== value) {
      const color = RGBA.clone(parseColor(value))
      this.setNativeSceneArrow({ foregroundColor: color })
      this._foregroundColor = color
      this.requestRender()
    }
  }

  get backgroundColor(): RGBA {
    return RGBA.clone(this._backgroundColor)
  }

  set backgroundColor(value: ColorInput) {
    if (this._backgroundColor !== value) {
      const color = RGBA.clone(parseColor(value))
      this.setNativeSceneArrow({ backgroundColor: color })
      this._backgroundColor = color
      this.requestRender()
    }
  }

  get attributes(): number {
    return this._attributes
  }

  set attributes(value: number) {
    if (this._attributes !== value) {
      this.setNativeSceneArrow({ attributes: value })
      this._attributes = value
      this.requestRender()
    }
  }

  set arrowChars(value: ArrowOptions["arrowChars"]) {
    const chars = {
      ...this._arrowChars,
      ...value,
    }
    this.setNativeSceneArrow({ text: chars[this._direction] })
    this._arrowChars = chars
    this.requestRender()
  }

  private setNativeSceneArrow(options: Partial<NativeSceneArrowOptions> = {}): void {
    this._ctx.nativeScene.setArrow(this, {
      direction: this._direction,
      attributes: this._attributes,
      foregroundColor: this._foregroundColor,
      backgroundColor: this._backgroundColor,
      text: this.getArrowChar(),
      ...options,
    })
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
