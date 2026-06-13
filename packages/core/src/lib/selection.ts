import { Renderable } from "../Renderable.js"
import type { ViewportBounds } from "../types.js"
import { coordinateToCharacterIndex, fonts } from "./ascii.font.js"

class SelectionAnchor {
  private relativeX: number
  private relativeY: number

  constructor(
    private renderable: Renderable,
    absoluteX: number,
    absoluteY: number,
  ) {
    this.relativeX = absoluteX - this.renderable.x
    this.relativeY = absoluteY - this.renderable.y
  }

  get x(): number {
    return this.renderable.x + this.relativeX
  }

  get y(): number {
    return this.renderable.y + this.relativeY
  }
}

export class Selection {
  private _anchor: SelectionAnchor
  private _focus: { x: number; y: number }
  private _selectedRenderables: Renderable[] = []
  private _touchedRenderables: Renderable[] = []
  private _isActive: boolean = true
  private _isDragging: boolean = true
  private _isStart: boolean = false

  constructor(anchorRenderable: Renderable, anchor: { x: number; y: number }, focus: { x: number; y: number }) {
    this._anchor = new SelectionAnchor(anchorRenderable, anchor.x, anchor.y)
    this._focus = { ...focus }
  }

  get isStart(): boolean {
    return this._isStart
  }

  set isStart(value: boolean) {
    this._isStart = value
  }

  get anchor(): { x: number; y: number } {
    return { x: this._anchor.x, y: this._anchor.y }
  }

  get focus(): { x: number; y: number } {
    return { ...this._focus }
  }

  set focus(value: { x: number; y: number }) {
    this._focus = { ...value }
  }

  get isActive(): boolean {
    return this._isActive
  }

  set isActive(value: boolean) {
    this._isActive = value
  }

  get isDragging(): boolean {
    return this._isDragging
  }

  set isDragging(value: boolean) {
    this._isDragging = value
  }

  get bounds(): ViewportBounds {
    const minX = Math.min(this._anchor.x, this._focus.x)
    const maxX = Math.max(this._anchor.x, this._focus.x)
    const minY = Math.min(this._anchor.y, this._focus.y)
    const maxY = Math.max(this._anchor.y, this._focus.y)

    // Selection bounds are inclusive of both anchor and focus
    // A selection from (0,0) to (0,0) covers 1 cell
    // A selection from (0,0) to (5,3) covers cells from (0,0) to (5,3) inclusive
    const width = maxX - minX + 1
    const height = maxY - minY + 1

    return {
      x: minX,
      y: minY,
      width,
      height,
    }
  }

  updateSelectedRenderables(selectedRenderables: Renderable[]): void {
    this._selectedRenderables = selectedRenderables
  }

  get selectedRenderables(): Renderable[] {
    return this._selectedRenderables
  }

  updateTouchedRenderables(touchedRenderables: Renderable[]): void {
    this._touchedRenderables = touchedRenderables
  }

  get touchedRenderables(): Renderable[] {
    return this._touchedRenderables
  }

  getSelectedText(): string {
    const selectedTextsByLine = new Map<number, Array<{ x: number; text: string }>>()
    const selectedRenderables = this._selectedRenderables
      // Sort by reading order: top-to-bottom, then left-to-right
      .sort((a, b) => {
        const aY = a.y
        const bY = b.y
        if (aY !== bY) {
          return aY - bY
        }
        return a.x - b.x
      })
      .filter((renderable) => !renderable.isDestroyed)

    for (const renderable of selectedRenderables) {
      const text = renderable.getSelectedText()
      if (!text) continue
      const lines = text.split("\n")
      for (let index = 0; index < lines.length; index += 1) {
        const y = renderable.y + index
        const line = selectedTextsByLine.get(y) ?? []
        line.push({ x: renderable.x, text: lines[index] })
        selectedTextsByLine.set(y, line)
      }
    }

    return [...selectedTextsByLine.entries()]
      .sort(([leftY], [rightY]) => leftY - rightY)
      .map(([, line]) =>
        line
          .sort((left, right) => left.x - right.x)
          .map((segment) => segment.text)
          .join(""),
      )
      .join("\n")
  }
}

export interface LocalSelectionBounds {
  anchorX: number
  anchorY: number
  focusX: number
  focusY: number
  isActive: boolean
}

export function convertGlobalToLocalSelection(
  globalSelection: Selection | null,
  localX: number,
  localY: number,
): LocalSelectionBounds | null {
  if (!globalSelection?.isActive) {
    return null
  }

  return {
    anchorX: globalSelection.anchor.x - localX,
    anchorY: globalSelection.anchor.y - localY,
    focusX: globalSelection.focus.x - localX,
    focusY: globalSelection.focus.y - localY,
    isActive: true,
  }
}

export class ASCIIFontSelectionHelper {
  private localSelection: { start: number; end: number } | null = null

  constructor(
    private getText: () => string,
    private getFont: () => keyof typeof fonts,
  ) {}

  hasSelection(): boolean {
    return this.localSelection !== null
  }

  getSelection(): { start: number; end: number } | null {
    return this.localSelection
  }

  shouldStartSelection(localX: number, localY: number, width: number, height: number): boolean {
    if (localX < 0 || localX >= width || localY < 0 || localY >= height) {
      return false
    }

    const text = this.getText()
    const font = this.getFont()
    const charIndex = coordinateToCharacterIndex(localX, text, font)

    return charIndex >= 0 && charIndex <= text.length
  }

  onLocalSelectionChanged(localSelection: LocalSelectionBounds | null, width: number, height: number): boolean {
    const previousSelection = this.localSelection

    if (!localSelection?.isActive) {
      this.localSelection = null
      return previousSelection !== null
    }

    const text = this.getText()
    const font = this.getFont()

    const selStart = { x: localSelection.anchorX, y: localSelection.anchorY }
    const selEnd = { x: localSelection.focusX, y: localSelection.focusY }

    if (height - 1 < selStart.y || 0 > selEnd.y) {
      this.localSelection = null
      return previousSelection !== null
    }

    let startCharIndex = 0
    let endCharIndex = text.length

    if (selStart.y > height - 1) {
      // Selection starts below us - we're not selected
      this.localSelection = null
      return previousSelection !== null
    } else if (selStart.y >= 0 && selStart.y <= height - 1) {
      // Selection starts within our Y range - use the actual start X coordinate
      if (selStart.x > 0) {
        startCharIndex = coordinateToCharacterIndex(selStart.x, text, font)
      }
    }

    if (selEnd.y < 0) {
      // Selection ends above us - we're not selected
      this.localSelection = null
      return previousSelection !== null
    } else if (selEnd.y >= 0 && selEnd.y <= height - 1) {
      // Selection ends within our Y range - use the actual end X coordinate
      if (selEnd.x >= 0) {
        endCharIndex = coordinateToCharacterIndex(selEnd.x, text, font)
      } else {
        endCharIndex = 0
      }
    }

    if (startCharIndex < endCharIndex && startCharIndex >= 0 && endCharIndex <= text.length) {
      this.localSelection = { start: startCharIndex, end: endCharIndex }
    } else {
      this.localSelection = null
    }

    return (
      previousSelection?.start !== this.localSelection?.start || previousSelection?.end !== this.localSelection?.end
    )
  }
}
