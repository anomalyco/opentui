import { type RenderableOptions, Renderable } from "../Renderable.js"
import { type RenderContext } from "../types.js"
import { type ColorInput, RGBA, parseColor } from "../lib/RGBA.js"
import { OptimizedBuffer } from "../buffer.js"
import type { NativeSceneSliderOptions } from "../zig.js"

const defaultThumbBackgroundColor = RGBA.fromHex("#9a9ea3")
const defaultTrackBackgroundColor = RGBA.fromHex("#252527")

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
      this._min = options.min ?? 0
      this._max = options.max ?? 100
      this._value = options.value ?? this._min
      this._viewPortSize = options.viewPortSize ?? Math.max(1, (this._max - this._min) * 0.1)
      this._onChange = options.onChange
      this._backgroundColor = options.backgroundColor
        ? RGBA.clone(parseColor(options.backgroundColor))
        : RGBA.clone(defaultTrackBackgroundColor)
      this._foregroundColor = options.foregroundColor
        ? RGBA.clone(parseColor(options.foregroundColor))
        : RGBA.clone(defaultThumbBackgroundColor)
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
    if (!Number.isFinite(newValue)) {
      throw new RangeError("Scene slider values must be finite numbers")
    }
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
    if (!Number.isFinite(size)) {
      throw new RangeError("Scene slider values must be finite numbers")
    }
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

  get backgroundColor(): RGBA {
    return RGBA.clone(this._backgroundColor)
  }

  set backgroundColor(value: ColorInput) {
    const color = RGBA.clone(parseColor(value))
    this.setNativeSceneSlider({ backgroundColor: color })
    this._backgroundColor = color
    this.requestRender()
  }

  get foregroundColor(): RGBA {
    return RGBA.clone(this._foregroundColor)
  }

  set foregroundColor(value: ColorInput) {
    const color = RGBA.clone(parseColor(value))
    this.setNativeSceneSlider({ foregroundColor: color })
    this._foregroundColor = color
    this.requestRender()
  }

  private setNativeSceneSlider(options: Partial<NativeSceneSliderOptions> = {}): void {
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

  private calculateDragOffsetVirtual(event: any): number {
    const trackStart = this.orientation === "vertical" ? this.y : this.x
    const mousePos = (this.orientation === "vertical" ? event.y : event.x) - trackStart
    const virtualMousePos = Math.max(
      0,
      Math.min((this.orientation === "vertical" ? this.height : this.width) * 2, mousePos * 2),
    )
    const thumb = this._ctx.nativeScene.getSliderThumb(this)
    const virtualThumbStart = thumb.start
    const virtualThumbSize = thumb.size

    return Math.max(0, Math.min(virtualThumbSize, virtualMousePos - virtualThumbStart))
  }

  private setupMouseHandling(): void {
    let isDragging = false
    let dragOffsetVirtual = 0

    this.onMouseDown = (event) => {
      event.stopPropagation()
      event.preventDefault()

      const thumb = this.getThumbRect()
      const inThumb =
        event.x >= thumb.x && event.x < thumb.x + thumb.width && event.y >= thumb.y && event.y < thumb.y + thumb.height

      if (inThumb) {
        isDragging = true

        dragOffsetVirtual = this.calculateDragOffsetVirtual(event)
      } else {
        this.updateValueFromMouseDirect(event)
        if (this.isDestroyed) return
        isDragging = true

        dragOffsetVirtual = this.calculateDragOffsetVirtual(event)
      }
    }

    this.onMouseDrag = (event) => {
      if (!isDragging) return
      event.stopPropagation()
      this.updateValueFromMouseWithOffset(event, dragOffsetVirtual)
    }

    this.onMouseUp = (event) => {
      if (isDragging) {
        this.updateValueFromMouseWithOffset(event, dragOffsetVirtual)
      }
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
    const x = this.x
    const y = this.y
    const width = this.width
    const height = this.height
    const bufferWidth = buffer.width
    const bufferHeight = buffer.height
    const left = Math.max(0, Math.trunc(x))
    const top = Math.max(0, Math.trunc(y))
    const right = Math.min(bufferWidth, Math.trunc(x) + Math.trunc(width))
    const bottom = Math.min(bufferHeight, Math.trunc(y) + Math.trunc(height))
    // Clip the truncated rectangle before passing its unsigned origin to FFI.
    if (right > left && bottom > top) {
      buffer.fillRect(left, top, right - left, bottom - top, this._backgroundColor)
    }

    const horizontal = this.orientation === "horizontal"
    const origin = horizontal ? x : y
    const crossOrigin = horizontal ? y : x
    const length = horizontal ? width : height
    const crossLength = horizontal ? height : width
    const limit = horizontal ? bufferWidth : bufferHeight
    const crossLimit = horizontal ? bufferHeight : bufferWidth
    const thumb = this._ctx.nativeScene.getSliderThumb(this)
    const virtualThumbSize = thumb.size
    const virtualThumbStart = thumb.start
    const virtualThumbEnd = virtualThumbStart + virtualThumbSize

    // Truncation maps (-1, 1) onto cell zero. Keep a neighbor at each bound for
    // floating-point rounding, then check the actual transformed coordinates.
    const start = Math.max(0, Math.floor(virtualThumbStart / 2), Math.floor(-1 - origin))
    const end = Math.min(Math.floor(length), Math.ceil(virtualThumbEnd / 2), Math.ceil(limit - origin) + 1)
    const crossStart = Math.max(0, Math.floor(-1 - crossOrigin))
    const crossEnd = Math.min(Math.ceil(crossLength), Math.ceil(crossLimit - crossOrigin) + 1)

    for (let along = start; along < end; along++) {
      const cell = Math.trunc(origin + along)
      if (cell < 0 || cell >= limit) continue

      const virtualCellStart = along * 2
      const thumbStartInCell = Math.max(virtualThumbStart, virtualCellStart)
      const coverage = Math.min(virtualThumbEnd, virtualCellStart + 2) - thumbStartInCell
      let char = " "
      if (coverage >= 2) {
        char = "█"
      } else if (horizontal) {
        char = thumbStartInCell === virtualCellStart ? "▌" : "▐"
      } else if (coverage > 0) {
        char = thumbStartInCell === virtualCellStart ? "▀" : "▄"
      }

      for (let across = crossStart; across < crossEnd; across++) {
        const crossCell = Math.trunc(crossOrigin + across)
        if (crossCell < 0 || crossCell >= crossLimit) continue
        buffer.setCellWithAlphaBlending(
          horizontal ? cell : crossCell,
          horizontal ? crossCell : cell,
          char,
          this._foregroundColor,
          this._backgroundColor,
        )
      }
    }
  }
}
