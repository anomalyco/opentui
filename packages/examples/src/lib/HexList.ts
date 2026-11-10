import type { RenderableOptions } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { FrameBufferRenderable, type FrameBufferOptions } from "@opentui/core"
import type { RenderContext } from "@opentui/core"
import { TextAttributes } from "@opentui/core"

export interface HexListOptions extends Omit<RenderableOptions<HexListRenderable>, "width" | "height"> {
  colors: string[]
  columns?: number
  blockWidth?: number
  blockHeight?: number
  maxHeight?: number
}

export class HexListRenderable extends FrameBufferRenderable {
  private _colors: string[]
  private _columns: number
  private _blockWidth: number
  private _blockHeight: number
  private _maxHeight: number
  private _itemWidth: number

  constructor(ctx: RenderContext, options: HexListOptions) {
    const columns = options.columns ?? 4
    const blockWidth = options.blockWidth ?? 4
    const blockHeight = options.blockHeight ?? 2
    const itemWidth = 18 // Space for color box + spacing + index + hex
    const maxHeight = options.maxHeight ?? Math.ceil(256 / columns) * (blockHeight + 1)

    const colors = options.colors ?? []
    const numRows = Math.ceil(colors.length / columns)
    const requiredHeight = numRows * (blockHeight + 1)
    const height = Math.min(requiredHeight, maxHeight)
    const width = columns * itemWidth

    super(ctx, {
      ...options,
      width,
      height: Math.max(height, 1),
    } as FrameBufferOptions)

    this._colors = colors
    this._columns = columns
    this._blockWidth = blockWidth
    this._blockHeight = blockHeight
    this._maxHeight = maxHeight
    this._itemWidth = itemWidth

    this.renderHexList()
  }

  get colors(): string[] {
    return this._colors
  }

  set colors(value: string[]) {
    this._colors = value
    this.updateDimensions()
    this.renderHexList()
    this.requestRender()
  }

  private updateDimensions(): void {
    const numRows = Math.ceil(this._colors.length / this._columns)
    const requiredHeight = numRows * (this._blockHeight + 1)
    const newHeight = Math.min(requiredHeight, this._maxHeight)

    if (this.height !== newHeight) {
      this.height = Math.max(newHeight, 1)
    }
  }

  protected onResize(width: number, height: number): void {
    super.onResize(width, height)
    this.renderHexList()
  }

  private renderHexList(): void {
    if (this.isDestroyed) return

    const buffer = this.frameBuffer
    buffer.clear(RGBA.fromInts(30, 41, 59, 255)) // Slate-800 background

    const actualSize = Math.min(this._colors.length, 256)

    for (let i = 0; i < actualSize; i++) {
      const color = this._colors[i]
      if (!color) continue

      const row = Math.floor(i / this._columns)
      const col = i % this._columns

      const x = col * this._itemWidth
      const y = row * (this._blockHeight + 1) // Add spacing between rows

      // Parse hex color
      const hex = color.replace("#", "")
      const r = parseInt(hex.substring(0, 2), 16)
      const g = parseInt(hex.substring(2, 4), 16)
      const b = parseInt(hex.substring(4, 6), 16)
      const rgba = RGBA.fromInts(r, g, b)

      // Draw colored box
      for (let dy = 0; dy < this._blockHeight; dy++) {
        for (let dx = 0; dx < this._blockWidth; dx++) {
          buffer.setCell(x + dx, y + dy, " ", RGBA.fromInts(255, 255, 255), rgba)
        }
      }

      // Draw index and hex value next to the box
      const text = `${i.toString().padStart(3, " ")}: ${color.toUpperCase()}`
      const textColor = RGBA.fromInts(148, 163, 184)
      const bgColor = RGBA.fromInts(30, 41, 59, 255)
      const textStartX = x + this._blockWidth + 1
      const spacing = 2

      for (let ci = 0; ci < text.length && textStartX + ci < x + this._itemWidth - spacing; ci++) {
        buffer.drawText(text[ci], textStartX + ci, y, textColor, bgColor, TextAttributes.NONE)
      }
    }
  }
}
