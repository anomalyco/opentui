import type { RenderableOptions } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { FrameBufferRenderable, type FrameBufferOptions } from "@opentui/core"
import type { RenderContext } from "@opentui/core"
import { TextAttributes } from "@opentui/core"

export interface PaletteGridOptions extends Omit<RenderableOptions<PaletteGridRenderable>, "width" | "height"> {
  colors: string[]
  blockWidth?: number
  blockHeight?: number
  colorsPerRow?: number
  maxHeight?: number
}

export class PaletteGridRenderable extends FrameBufferRenderable {
  private _colors: string[]
  private _blockWidth: number
  private _blockHeight: number
  private _colorsPerRow: number
  private _maxHeight: number

  constructor(ctx: RenderContext, options: PaletteGridOptions) {
    const blockWidth = options.blockWidth ?? 4
    const blockHeight = options.blockHeight ?? 2
    const colorsPerRow = options.colorsPerRow ?? 16
    const maxHeight = options.maxHeight ?? 32

    const colors = options.colors ?? []
    const numRows = Math.ceil(colors.length / colorsPerRow)
    const requiredHeight = numRows * blockHeight
    const height = Math.min(requiredHeight, maxHeight)
    const width = colorsPerRow * blockWidth

    super(ctx, {
      ...options,
      width,
      height: Math.max(height, 1),
    } as FrameBufferOptions)

    this._colors = colors
    this._blockWidth = blockWidth
    this._blockHeight = blockHeight
    this._colorsPerRow = colorsPerRow
    this._maxHeight = maxHeight

    this.renderPalette()
  }

  get colors(): string[] {
    return this._colors
  }

  set colors(value: string[]) {
    this._colors = value
    this.updateDimensions()
    this.renderPalette()
    this.requestRender()
  }

  private updateDimensions(): void {
    const numRows = Math.ceil(this._colors.length / this._colorsPerRow)
    const requiredHeight = numRows * this._blockHeight
    const newHeight = Math.min(requiredHeight, this._maxHeight)

    if (this.height !== newHeight) {
      this.height = Math.max(newHeight, 1)
    }
  }

  protected onResize(width: number, height: number): void {
    super.onResize(width, height)
    this.renderPalette()
  }

  private renderPalette(): void {
    if (this.isDestroyed) return

    const buffer = this.frameBuffer
    buffer.clear(RGBA.fromInts(30, 41, 59, 255)) // Slate-800 background

    const size = this._colors.length

    for (let i = 0; i < size; i++) {
      const color = this._colors[i]
      if (!color) continue

      const row = Math.floor(i / this._colorsPerRow)
      const col = i % this._colorsPerRow

      const x = col * this._blockWidth
      const y = row * this._blockHeight

      // Parse hex color
      const hex = color.replace("#", "")
      const r = parseInt(hex.substring(0, 2), 16)
      const g = parseInt(hex.substring(2, 4), 16)
      const b = parseInt(hex.substring(4, 6), 16)
      const rgba = RGBA.fromInts(r, g, b)

      // Draw the color block using spaces with background color
      for (let dy = 0; dy < this._blockHeight; dy++) {
        for (let dx = 0; dx < this._blockWidth; dx++) {
          buffer.setCell(x + dx, y + dy, " ", RGBA.fromInts(255, 255, 255), rgba)
        }
      }

      // Add color index number in the center of the block (if block is large enough)
      if (this._blockWidth >= 3 && this._blockHeight >= 1) {
        const indexStr = i.toString()
        const textX = x + Math.floor((this._blockWidth - indexStr.length) / 2)
        const textY = y + Math.floor(this._blockHeight / 2)

        // Choose text color based on background brightness
        const brightness = (r * 299 + g * 587 + b * 114) / 1000
        const textColor = brightness > 128 ? RGBA.fromInts(0, 0, 0) : RGBA.fromInts(255, 255, 255)

        if (indexStr.length <= this._blockWidth) {
          for (let ci = 0; ci < indexStr.length; ci++) {
            buffer.drawText(indexStr[ci], textX + ci, textY, textColor, rgba, TextAttributes.NONE)
          }
        }
      }
    }
  }
}
