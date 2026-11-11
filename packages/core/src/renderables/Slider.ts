import { type RenderableOptions, Renderable, type NativeRenderableIntegration } from "../Renderable.js"
import { type RenderContext } from "../types.js"
import { type ColorInput, RGBA, parseColor } from "../lib/RGBA.js"
import { OptimizedBuffer } from "../buffer.js"
import type { NativeSceneSliderOptions } from "../zig.js"

const defaultThumbBackgroundColor = RGBA.fromHex("#9a9ea3")
const defaultTrackBackgroundColor = RGBA.fromHex("#252527")
const defaultMin = 0
const defaultMax = 100

export interface SliderOptions extends RenderableOptions<SliderRenderable> {
  orientation: "vertical" | "horizontal"
  value?: number
  min?: number
  max?: number
  viewPortSize?: number
  backgroundColor?: ColorInput
  foregroundColor?: ColorInput
  onChange?: (value: number) => void
}

export class SliderRenderable extends Renderable {
  static override readonly nativeIntegration: NativeRenderableIntegration = {
    kind: "slider",
    body: { native: this.prototype.renderSelf },
  }

  private _orientation: "vertical" | "horizontal"
  private _value: number
  private _min: number
  private _max: number
  private _viewPortSize: number
  private _backgroundColor: RGBA
  private _foregroundColor: RGBA
  private _onChange?: (value: number) => void

  constructor(ctx: RenderContext, options: SliderOptions) {
    super(ctx, { flexShrink: 0, ...options })
    try {
      this._orientation = options.orientation
      this._min = options.min ?? defaultMin
      this._max = options.max ?? defaultMax
      this._value = options.value ?? this._min
      this._viewPortSize = options.viewPortSize ?? this.defaultViewPortSize()
      this._onChange = options.onChange
      this._backgroundColor = RGBA.clone(parseColor(options.backgroundColor || defaultTrackBackgroundColor))
      this._foregroundColor = RGBA.clone(parseColor(options.foregroundColor || defaultThumbBackgroundColor))
      this.setNativeSceneSlider()
      this.setNativeScenePaint()
      this.setupMouseHandling()
    } catch (error) {
      this.abortConstruction(error)
    }
  }

  get orientation(): "vertical" | "horizontal" {
    return this._orientation
  }

  set orientation(value: "vertical" | "horizontal") {
    if (value === this._orientation) return
    this.setNativeSceneSlider({ orientation: value })
    this._orientation = value
    this.requestRender()
  }

  get value(): number {
    return this._value
  }

  set value(newValue: number) {
    newValue ??= this._min
    const clamped = Math.max(this._min, Math.min(this._max, newValue))
    if (clamped !== this._value) {
      this.setNativeSceneSlider({ value: clamped })
      this.publishValue(clamped)
    }
  }

  private publishValue(value: number): void {
    if (value === this._value) return
    this._value = value
    this.requestRender()
    this._onChange?.(value)
    this.emit("change", { value })
  }

  get min(): number {
    return this._min
  }

  set min(newMin: number) {
    newMin ??= defaultMin
    if (newMin !== this._min) {
      const value = this._value < newMin ? newMin : this._value
      this.setNativeSceneSlider({ min: newMin, value })
      this._min = newMin
      if (this._value < newMin) {
        this.publishValue(value)
      }
      this.requestRender()
    }
  }

  get max(): number {
    return this._max
  }

  set max(newMax: number) {
    newMax ??= defaultMax
    if (newMax !== this._max) {
      const value = this._value > newMax ? Math.max(this._min, newMax) : this._value
      this.setNativeSceneSlider({ max: newMax, value })
      this._max = newMax
      if (this._value > newMax) {
        this.publishValue(value)
      }
      this.requestRender()
    }
  }

  set viewPortSize(size: number) {
    size ??= this.defaultViewPortSize()
    const clampedSize = Math.max(0.01, Math.min(size, this._max - this._min))
    if (clampedSize !== this._viewPortSize) {
      this.setNativeSceneSlider({ viewPortSize: clampedSize })
      this._viewPortSize = clampedSize
      this.requestRender()
    }
  }

  get viewPortSize(): number {
    return this._viewPortSize
  }

  private defaultViewPortSize(): number {
    return Math.max(1, (this._max - this._min) * 0.1)
  }

  get backgroundColor(): RGBA {
    return RGBA.clone(this._backgroundColor)
  }

  set backgroundColor(value: ColorInput) {
    const color = RGBA.clone(parseColor(value ?? defaultTrackBackgroundColor))
    this.setNativeSceneSlider({ backgroundColor: color })
    this._backgroundColor = color
    this.requestRender()
  }

  get foregroundColor(): RGBA {
    return RGBA.clone(this._foregroundColor)
  }

  set foregroundColor(value: ColorInput) {
    const color = RGBA.clone(parseColor(value ?? defaultThumbBackgroundColor))
    this.setNativeSceneSlider({ foregroundColor: color })
    this._foregroundColor = color
    this.requestRender()
  }

  private setNativeSceneSlider(options: Partial<NativeSceneSliderOptions> = {}): void {
    if (this.isFreed()) return
    this._ctx.nativeScene.setSlider(this, {
      orientation: this.orientation,
      min: this._min,
      max: this._max,
      value: this._value,
      viewPortSize: this._viewPortSize,
      foregroundColor: this._foregroundColor,
      backgroundColor: this._backgroundColor,
      ...options,
    })
  }

  // The pointer's distance from the thumb start that the current value implies. The painted thumb starts on a whole
  // half cell, but measuring from that rounded start would make a press and release at one position change the value.
  private calculateDragOffsetVirtual(event: any): number {
    const trackStart = this.orientation === "vertical" ? this.y : this.x
    const trackSize = this.orientation === "vertical" ? this.height : this.width
    const mousePos = (this.orientation === "vertical" ? event.y : event.x) - trackStart
    const virtualMousePos = Math.max(0, Math.min(trackSize, mousePos)) * 2
    const maxThumbStart = Math.max(0, trackSize * 2 - this._ctx.nativeScene.getSliderThumb(this).size)
    const range = this._max - this._min
    const ratio = range === 0 ? 0 : (this._value - this._min) / range

    return virtualMousePos - ratio * maxThumbStart
  }

  private setupMouseHandling(): void {
    let isDragging = false
    let dragOffsetVirtual = 0
    // The track position the value already reflects. An event there has nothing to apply, and recomputing the value
    // could differ from it by a rounding error.
    let appliedMousePos = 0
    const trackMousePos = (event: any): number => (this.orientation === "vertical" ? event.y : event.x)

    this.onMouseDown = (event) => {
      event.stopPropagation()
      event.preventDefault()

      const thumb = this.getThumbRect()
      const inThumb =
        event.x >= thumb.x && event.x < thumb.x + thumb.width && event.y >= thumb.y && event.y < thumb.y + thumb.height

      if (!inThumb) {
        this.updateValueFromMouseDirect(event)
        if (this.isDestroyed) return
      }
      isDragging = true
      dragOffsetVirtual = this.calculateDragOffsetVirtual(event)
      appliedMousePos = trackMousePos(event)
    }

    const drag = (event: any): void => {
      const mousePos = trackMousePos(event)
      if (mousePos === appliedMousePos) return
      appliedMousePos = mousePos
      this.updateValueFromMouseWithOffset(event, dragOffsetVirtual)
    }

    this.onMouseDrag = (event) => {
      if (!isDragging) return
      event.stopPropagation()
      drag(event)
    }

    this.onMouseUp = (event) => {
      if (isDragging) drag(event)
      isDragging = false
    }
  }

  private updateValueFromMouseDirect(event: any): void {
    const trackStart = this.orientation === "vertical" ? this.y : this.x
    const trackSize = this.orientation === "vertical" ? this.height : this.width
    const mousePos = this.orientation === "vertical" ? event.y : event.x

    const relativeMousePos = mousePos - trackStart
    const clampedMousePos = Math.max(0, Math.min(trackSize, relativeMousePos))
    const ratio = trackSize === 0 ? 0 : clampedMousePos / trackSize
    const range = this._max - this._min
    const newValue = this._min + ratio * range

    this.value = newValue
  }

  private updateValueFromMouseWithOffset(event: any, offsetVirtual: number): void {
    const trackStart = this.orientation === "vertical" ? this.y : this.x
    const trackSize = this.orientation === "vertical" ? this.height : this.width
    const mousePos = this.orientation === "vertical" ? event.y : event.x

    const virtualTrackSize = trackSize * 2
    const relativeMousePos = mousePos - trackStart
    const clampedMousePos = Math.max(0, Math.min(trackSize, relativeMousePos))
    const virtualMousePos = clampedMousePos * 2

    const virtualThumbSize = this._ctx.nativeScene.getSliderThumb(this).size
    const maxThumbStart = Math.max(0, virtualTrackSize - virtualThumbSize)

    let desiredThumbStart = virtualMousePos - offsetVirtual
    desiredThumbStart = Math.max(0, Math.min(maxThumbStart, desiredThumbStart))

    const ratio = maxThumbStart === 0 ? 0 : desiredThumbStart / maxThumbStart
    const range = this._max - this._min
    const newValue = this._min + ratio * range

    this.value = newValue
  }

  private getThumbRect(): { x: number; y: number; width: number; height: number } {
    const thumb = this._ctx.nativeScene.getSliderThumb(this)
    const virtualThumbSize = thumb.size
    const virtualThumbStart = thumb.start

    const realThumbStart = Math.floor(virtualThumbStart / 2)
    const realThumbSize = Math.ceil((virtualThumbStart + virtualThumbSize) / 2) - realThumbStart

    if (this.orientation === "vertical") {
      return {
        x: this.x,
        y: this.y + realThumbStart,
        width: this.width,
        height: Math.max(1, realThumbSize),
      }
    } else {
      return {
        x: this.x + realThumbStart,
        y: this.y,
        width: Math.max(1, realThumbSize),
        height: this.height,
      }
    }
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    this._drawNativeBody(buffer)
  }
}
