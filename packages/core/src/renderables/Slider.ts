import { type RenderableOptions, Renderable } from "../Renderable.js"
import { type RenderContext } from "../types.js"
import { type ColorInput, RGBA, parseColor } from "../lib/RGBA.js"
import { OptimizedBuffer } from "../buffer.js"

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
  public readonly orientation: "vertical" | "horizontal"
  private _value: number
  private _min: number
  private _max: number
  private _viewPortSize: number
  private _backgroundColor: RGBA
  private _foregroundColor: RGBA
  private _onChange?: (value: number) => void

  constructor(ctx: RenderContext, options: SliderOptions) {
    super(ctx, { flexShrink: 0, ...options })
    this.orientation = options.orientation
    this._min = options.min ?? 0
    this._max = options.max ?? 100
    this._value = options.value ?? this._min
    this._viewPortSize = options.viewPortSize ?? Math.max(1, (this._max - this._min) * 0.1)
    this._onChange = options.onChange
    this._backgroundColor = options.backgroundColor ? parseColor(options.backgroundColor) : defaultTrackBackgroundColor
    this._foregroundColor = options.foregroundColor ? parseColor(options.foregroundColor) : defaultThumbBackgroundColor

    this.setupMouseHandling()
  }

  get value(): number {
    return this._value
  }

  set value(newValue: number) {
    const clamped = Math.max(this._min, Math.min(this._max, newValue))
    if (clamped !== this._value) {
      this._value = clamped
      this._onChange?.(clamped)
      this.emit("change", { value: clamped })
      this.requestRender()
    }
  }

  get min(): number {
    return this._min
  }

  set min(newMin: number) {
    if (newMin !== this._min) {
      this._min = newMin
      if (this._value < newMin) {
        this.value = newMin
      }
      this.requestRender()
    }
  }

  get max(): number {
    return this._max
  }

  set max(newMax: number) {
    if (newMax !== this._max) {
      this._max = newMax
      if (this._value > newMax) {
        this.value = newMax
      }
      this.requestRender()
    }
  }

  set viewPortSize(size: number) {
    const clampedSize = Math.max(0.01, size)
    if (clampedSize !== this._viewPortSize) {
      this._viewPortSize = clampedSize
      this.requestRender()
    }
  }

  get viewPortSize(): number {
    return this._viewPortSize
  }

  get backgroundColor(): RGBA {
    return this._backgroundColor
  }

  set backgroundColor(value: ColorInput) {
    this._backgroundColor = parseColor(value)
    this.requestRender()
  }

  get foregroundColor(): RGBA {
    return this._foregroundColor
  }

  set foregroundColor(value: ColorInput) {
    this._foregroundColor = parseColor(value)
    this.requestRender()
  }

  private calculateDragOffsetVirtual(event: any): number {
    const trackStart = this.orientation === "vertical" ? this.y : this.x
    const mousePos = (this.orientation === "vertical" ? event.y : event.x) - trackStart
    const virtualMousePos = Math.max(
      0,
      Math.min((this.orientation === "vertical" ? this.height : this.width) * 2, mousePos * 2),
    )
    const virtualThumbStart = this.getVirtualThumbStart()
    const virtualThumbSize = this.getVirtualThumbSize()

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

    const virtualThumbSize = this.getVirtualThumbSize()
    const maxThumbStart = Math.max(0, virtualTrackSize - virtualThumbSize)

    let desiredThumbStart = virtualMousePos - offsetVirtual
    desiredThumbStart = Math.max(0, Math.min(maxThumbStart, desiredThumbStart))

    const ratio = maxThumbStart === 0 ? 0 : desiredThumbStart / maxThumbStart
    const range = this._max - this._min
    const newValue = this._min + ratio * range

    this.value = newValue
  }

  private getThumbRect(): { x: number; y: number; width: number; height: number } {
    const virtualThumbSize = this.getVirtualThumbSize()
    const virtualThumbStart = this.getVirtualThumbStart()

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
    if (this.orientation === "horizontal") {
      this.renderHorizontal(buffer)
    } else {
      this.renderVertical(buffer)
    }
  }

  private renderHorizontal(buffer: OptimizedBuffer): void {
    const virtualThumbSize = this.getVirtualThumbSize()
    const virtualThumbStart = this.getVirtualThumbStart()
    const virtualThumbEnd = virtualThumbStart + virtualThumbSize

    buffer.fillRect(this.x, this.y, this.width, this.height, this._backgroundColor)

    const realStartCell = Math.floor(virtualThumbStart / 2)
    const realEndCell = Math.ceil(virtualThumbEnd / 2) - 1
    const startX = Math.max(0, realStartCell)
    const endX = Math.min(this.width - 1, realEndCell)

    for (let realX = startX; realX <= endX; realX++) {
      const virtualCellStart = realX * 2
      const virtualCellEnd = virtualCellStart + 2

      const thumbStartInCell = Math.max(virtualThumbStart, virtualCellStart)
      const thumbEndInCell = Math.min(virtualThumbEnd, virtualCellEnd)
      const coverage = thumbEndInCell - thumbStartInCell

      let char = " "

      if (coverage >= 2) {
        char = "█"
      } else {
        const isLeftHalf = thumbStartInCell === virtualCellStart
        if (isLeftHalf) {
          char = "▌"
        } else {
          char = "▐"
        }
      }

      for (let y = 0; y < this.height; y++) {
        buffer.setCellWithAlphaBlending(this.x + realX, this.y + y, char, this._foregroundColor, this._backgroundColor)
      }
    }
  }

  private renderVertical(buffer: OptimizedBuffer): void {
    const virtualThumbSize = this.getVirtualThumbSize()
    const virtualThumbStart = this.getVirtualThumbStart()
    const virtualThumbEnd = virtualThumbStart + virtualThumbSize

    buffer.fillRect(this.x, this.y, this.width, this.height, this._backgroundColor)

    const realStartCell = Math.floor(virtualThumbStart / 2)
    const realEndCell = Math.ceil(virtualThumbEnd / 2) - 1
    const startY = Math.max(0, realStartCell)
    const endY = Math.min(this.height - 1, realEndCell)

    for (let realY = startY; realY <= endY; realY++) {
      const virtualCellStart = realY * 2
      const virtualCellEnd = virtualCellStart + 2

      const thumbStartInCell = Math.max(virtualThumbStart, virtualCellStart)
      const thumbEndInCell = Math.min(virtualThumbEnd, virtualCellEnd)
      const coverage = thumbEndInCell - thumbStartInCell

      let char = " "

      if (coverage >= 2) {
        char = "█"
      } else if (coverage > 0) {
        const virtualPositionInCell = thumbStartInCell - virtualCellStart
        if (virtualPositionInCell === 0) {
          char = "▀"
        } else {
          char = "▄"
        }
      }

      for (let x = 0; x < this.width; x++) {
        buffer.setCellWithAlphaBlending(this.x + x, this.y + realY, char, this._foregroundColor, this._backgroundColor)
      }
    }
  }

  private getVirtualThumbSize(): number {
    const virtualTrackSize = this.orientation === "vertical" ? this.height * 2 : this.width * 2
    const range = this._max - this._min

    if (range === 0) return virtualTrackSize

    const viewportSize = Math.max(1, this._viewPortSize)
    const contentSize = range + viewportSize

    if (contentSize <= viewportSize) return virtualTrackSize

    const thumbRatio = viewportSize / contentSize
    const calculatedSize = Math.floor(virtualTrackSize * thumbRatio)

    return Math.max(1, Math.min(calculatedSize, virtualTrackSize))
  }

  private getVirtualThumbStart(): number {
    const virtualTrackSize = this.orientation === "vertical" ? this.height * 2 : this.width * 2
    const range = this._max - this._min

    if (range === 0) return 0

    const valueRatio = (this._value - this._min) / range
    const virtualThumbSize = this.getVirtualThumbSize()

    return Math.round(valueRatio * (virtualTrackSize - virtualThumbSize))
  }
}
