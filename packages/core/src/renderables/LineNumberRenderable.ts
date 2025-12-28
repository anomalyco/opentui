import { Renderable, type RenderableOptions } from "../Renderable"
import { OptimizedBuffer } from "../buffer"
import type { RenderContext, LineInfoProvider } from "../types"
import { RGBA, parseColor } from "../lib/RGBA"
import { MeasureMode } from "yoga-layout"

export interface LineSign {
  before?: string
  beforeColor?: string | RGBA
  after?: string
  afterColor?: string | RGBA
}

export interface LineColorConfig {
  gutter?: string | RGBA
  content?: string | RGBA
}

/**
 * Represents a highlighted span within a line for word-level diff highlighting.
 */
export interface LineInlineHighlight {
  /** Starting column (0-based, in display characters) */
  startCol: number
  /** Ending column (exclusive, in display characters) */
  endCol: number
  /** Background color for this highlight */
  bg: RGBA
}

export interface LineNumberOptions extends RenderableOptions<LineNumberRenderable> {
  target?: Renderable & LineInfoProvider
  fg?: string | RGBA
  bg?: string | RGBA
  minWidth?: number
  paddingRight?: number
  lineColors?: Map<number, string | RGBA | LineColorConfig>
  lineSigns?: Map<number, LineSign>
  lineNumberOffset?: number
  hideLineNumbers?: Set<number>
  lineNumbers?: Map<number, number>
  showLineNumbers?: boolean
  /** Inline highlights for word-level diff highlighting (per logical line) */
  inlineHighlights?: Map<number, LineInlineHighlight[]>
}

class GutterRenderable extends Renderable {
  private target: Renderable & LineInfoProvider
  private _fg: RGBA
  private _bg: RGBA
  private _minWidth: number
  private _paddingRight: number
  private _lineColorsGutter: Map<number, RGBA>
  private _lineColorsContent: Map<number, RGBA>
  private _lineSigns: Map<number, LineSign>
  private _lineNumberOffset: number
  private _hideLineNumbers: Set<number>
  private _lineNumbers: Map<number, number>
  private _maxBeforeWidth: number = 0
  private _maxAfterWidth: number = 0
  private _lastKnownLineCount: number = 0
  private _lastKnownScrollY: number = 0

  constructor(
    ctx: RenderContext,
    target: Renderable & LineInfoProvider,
    options: {
      fg: RGBA
      bg: RGBA
      minWidth: number
      paddingRight: number
      lineColorsGutter: Map<number, RGBA>
      lineColorsContent: Map<number, RGBA>
      lineSigns: Map<number, LineSign>
      lineNumberOffset: number
      hideLineNumbers: Set<number>
      lineNumbers?: Map<number, number>
      id?: string
      buffered?: boolean
    },
  ) {
    super(ctx, {
      id: options.id,
      width: "auto",
      height: "auto",
      flexGrow: 0,
      flexShrink: 0,
      buffered: options.buffered,
    })
    this.target = target
    this._fg = options.fg
    this._bg = options.bg
    this._minWidth = options.minWidth
    this._paddingRight = options.paddingRight
    this._lineColorsGutter = options.lineColorsGutter
    this._lineColorsContent = options.lineColorsContent
    this._lineSigns = options.lineSigns
    this._lineNumberOffset = options.lineNumberOffset
    this._hideLineNumbers = options.hideLineNumbers
    this._lineNumbers = options.lineNumbers ?? new Map()
    this._lastKnownLineCount = this.target.virtualLineCount
    this._lastKnownScrollY = this.target.scrollY
    this.calculateSignWidths()
    this.setupMeasureFunc()

    // Use lifecycle pass to detect line count changes BEFORE layout
    this.onLifecyclePass = () => {
      const currentLineCount = this.target.virtualLineCount
      if (currentLineCount !== this._lastKnownLineCount) {
        this._lastKnownLineCount = currentLineCount
        this.yogaNode.markDirty()
        this.requestRender()
      }
    }
  }

  private setupMeasureFunc(): void {
    const measureFunc = (
      width: number,
      widthMode: MeasureMode,
      height: number,
      heightMode: MeasureMode,
    ): { width: number; height: number } => {
      // Calculate the gutter width based on the target's line count
      const gutterWidth = this.calculateWidth()

      // Calculate gutter height based on target's actual virtual line count
      // The gutter should match the height of the content it's numbering
      const gutterHeight = this.target.virtualLineCount

      // Return calculated dimensions based on content, not parent constraints
      return {
        width: gutterWidth,
        height: gutterHeight,
      }
    }

    this.yogaNode.setMeasureFunc(measureFunc)
  }

  public remeasure(): void {
    // Mark the yoga node as dirty to trigger re-measurement
    this.yogaNode.markDirty()
  }

  public setLineNumberOffset(offset: number): void {
    if (this._lineNumberOffset !== offset) {
      this._lineNumberOffset = offset
      this.yogaNode.markDirty()
      this.requestRender()
    }
  }

  public setHideLineNumbers(hideLineNumbers: Set<number>): void {
    this._hideLineNumbers = hideLineNumbers
    this.yogaNode.markDirty()
    this.requestRender()
  }

  public setLineNumbers(lineNumbers: Map<number, number>): void {
    this._lineNumbers = lineNumbers
    this.yogaNode.markDirty()
    this.requestRender()
  }

  private calculateSignWidths(): void {
    this._maxBeforeWidth = 0
    this._maxAfterWidth = 0

    for (const sign of this._lineSigns.values()) {
      if (sign.before) {
        const width = Bun.stringWidth(sign.before)
        this._maxBeforeWidth = Math.max(this._maxBeforeWidth, width)
      }
      if (sign.after) {
        const width = Bun.stringWidth(sign.after)
        this._maxAfterWidth = Math.max(this._maxAfterWidth, width)
      }
    }
  }

  private calculateWidth(): number {
    const totalLines = this.target.virtualLineCount

    // Find max line number, considering both calculated and custom line numbers
    let maxLineNumber = totalLines + this._lineNumberOffset
    if (this._lineNumbers.size > 0) {
      for (const customLineNum of this._lineNumbers.values()) {
        maxLineNumber = Math.max(maxLineNumber, customLineNum)
      }
    }

    const digits = maxLineNumber > 0 ? Math.floor(Math.log10(maxLineNumber)) + 1 : 1
    const baseWidth = Math.max(this._minWidth, digits + this._paddingRight + 1) // +1 for left padding
    return baseWidth + this._maxBeforeWidth + this._maxAfterWidth
  }

  public setLineColors(lineColorsGutter: Map<number, RGBA>, lineColorsContent: Map<number, RGBA>): void {
    this._lineColorsGutter = lineColorsGutter
    this._lineColorsContent = lineColorsContent
    this.requestRender()
  }

  public getLineColors(): { gutter: Map<number, RGBA>; content: Map<number, RGBA> } {
    return {
      gutter: this._lineColorsGutter,
      content: this._lineColorsContent,
    }
  }

  public setLineSigns(lineSigns: Map<number, LineSign>): void {
    const oldMaxBefore = this._maxBeforeWidth
    const oldMaxAfter = this._maxAfterWidth

    this._lineSigns = lineSigns
    this.calculateSignWidths()

    // Mark dirty if sign widths changed - this will trigger remeasure
    if (this._maxBeforeWidth !== oldMaxBefore || this._maxAfterWidth !== oldMaxAfter) {
      this.yogaNode.markDirty()
    }

    // Always request render since signs themselves may have changed
    this.requestRender()
  }

  public getLineSigns(): Map<number, LineSign> {
    return this._lineSigns
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    // For buffered rendering, only re-render when dirty OR when scroll position changed
    const currentScrollY = this.target.scrollY
    const scrollChanged = currentScrollY !== this._lastKnownScrollY

    if (this.buffered && !this.isDirty && !scrollChanged) {
      return
    }

    this._lastKnownScrollY = currentScrollY
    this.refreshFrameBuffer(buffer)
  }

  private refreshFrameBuffer(buffer: OptimizedBuffer): void {
    const startX = this.buffered ? 0 : this.x
    const startY = this.buffered ? 0 : this.y

    if (this.buffered) {
      buffer.clear(this._bg)
    } else if (this._bg.a > 0) {
      // Fill background if not buffered and opaque (if buffered, clear handles it)
      // Note: this.height might be determined by parent (flex stretch)
      buffer.fillRect(startX, startY, this.width, this.height, this._bg)
    }

    const lineInfo = this.target.lineInfo
    if (!lineInfo || !lineInfo.lineSources) return

    const sources = lineInfo.lineSources
    let lastSource = -1

    // lineSources contains the logical line index for each visual line
    // We start iterating from the scroll offset (first visible line)
    const startLine = this.target.scrollY

    // If scrolled past content (shouldn't happen normally but good to be safe)
    if (startLine >= sources.length) return

    // Get the logical line index of the line *before* the first visible line
    // This helps determine if the first visible line is a wrapped continuation
    lastSource = startLine > 0 ? sources[startLine - 1] : -1

    for (let i = 0; i < this.height; i++) {
      const visualLineIndex = startLine + i
      if (visualLineIndex >= sources.length) break

      const logicalLine = sources[visualLineIndex]
      const lineBg = this._lineColorsGutter.get(logicalLine) ?? this._bg

      // Fill background for this line if it has a custom color
      if (lineBg !== this._bg) {
        buffer.fillRect(startX, startY + i, this.width, 1, lineBg)
      }

      // Draw line number only for the first visual line of a logical line (wrapping)
      if (logicalLine === lastSource) {
        // Continuation line, maybe draw a dot or nothing
      } else {
        let currentX = startX

        // Draw 'before' sign if present
        const sign = this._lineSigns.get(logicalLine)
        if (sign?.before) {
          const beforeWidth = Bun.stringWidth(sign.before)
          // Pad to max before width for alignment
          const padding = this._maxBeforeWidth - beforeWidth
          currentX += padding
          const beforeColor = sign.beforeColor ? parseColor(sign.beforeColor) : this._fg
          buffer.drawText(sign.before, currentX, startY + i, beforeColor, lineBg)
          currentX += beforeWidth
        } else if (this._maxBeforeWidth > 0) {
          currentX += this._maxBeforeWidth
        }

        // Draw line number (right-aligned in its space with left padding of 1)
        if (!this._hideLineNumbers.has(logicalLine)) {
          // Use custom line number if provided, otherwise use calculated line number
          const customLineNum = this._lineNumbers.get(logicalLine)
          const lineNum = customLineNum !== undefined ? customLineNum : logicalLine + 1 + this._lineNumberOffset
          const lineNumStr = lineNum.toString()
          const lineNumWidth = lineNumStr.length
          const availableSpace = this.width - this._maxBeforeWidth - this._maxAfterWidth - this._paddingRight
          const lineNumX = startX + this._maxBeforeWidth + 1 + availableSpace - lineNumWidth - 1

          if (lineNumX >= startX + this._maxBeforeWidth + 1) {
            buffer.drawText(lineNumStr, lineNumX, startY + i, this._fg, lineBg)
          }
        }

        // Draw 'after' sign if present
        if (sign?.after) {
          const afterX = startX + this.width - this._paddingRight - this._maxAfterWidth
          const afterColor = sign.afterColor ? parseColor(sign.afterColor) : this._fg
          buffer.drawText(sign.after, afterX, startY + i, afterColor, lineBg)
        }
      }

      lastSource = logicalLine
    }
  }
}

// Helper function to darken an RGBA color by 20%
function darkenColor(color: RGBA): RGBA {
  return RGBA.fromValues(color.r * 0.8, color.g * 0.8, color.b * 0.8, color.a)
}

export class LineNumberRenderable extends Renderable {
  private gutter: GutterRenderable | null = null
  private target: (Renderable & LineInfoProvider) | null = null
  private _lineColorsGutter: Map<number, RGBA>
  private _lineColorsContent: Map<number, RGBA>
  private _lineSigns: Map<number, LineSign>
  private _inlineHighlights: Map<number, LineInlineHighlight[]>
  private _fg: RGBA
  private _bg: RGBA
  private _minWidth: number
  private _paddingRight: number
  private _lineNumberOffset: number
  private _hideLineNumbers: Set<number>
  private _lineNumbers: Map<number, number>
  private _isDestroying: boolean = false
  private handleLineInfoChange = (): void => {
    // When line info changes in the target, remeasure the gutter
    this.gutter?.remeasure()
    this.requestRender()
  }

  private parseLineColor(line: number, color: string | RGBA | LineColorConfig): void {
    if (typeof color === "object" && "gutter" in color) {
      // LineColorConfig format
      const config = color as LineColorConfig
      if (config.gutter) {
        this._lineColorsGutter.set(line, parseColor(config.gutter))
      }
      if (config.content) {
        this._lineColorsContent.set(line, parseColor(config.content))
      } else if (config.gutter) {
        // If only gutter is specified, use a darker version for content
        this._lineColorsContent.set(line, darkenColor(parseColor(config.gutter)))
      }
    } else {
      // Simple format - same color for both, but content is darker
      const parsedColor = parseColor(color as string | RGBA)
      this._lineColorsGutter.set(line, parsedColor)
      this._lineColorsContent.set(line, darkenColor(parsedColor))
    }
  }

  constructor(ctx: RenderContext, options: LineNumberOptions) {
    super(ctx, {
      ...options,
      flexDirection: "row",
      // CRITICAL:
      // By forcing height=auto, we ensure the parent box properly accounts for our full height.
      height: "auto",
    })

    this._fg = parseColor(options.fg ?? "#888888")
    this._bg = parseColor(options.bg ?? "transparent")
    this._minWidth = options.minWidth ?? 3
    this._paddingRight = options.paddingRight ?? 1
    this._lineNumberOffset = options.lineNumberOffset ?? 0
    this._hideLineNumbers = options.hideLineNumbers ?? new Set()
    this._lineNumbers = options.lineNumbers ?? new Map()

    this._lineColorsGutter = new Map<number, RGBA>()
    this._lineColorsContent = new Map<number, RGBA>()
    if (options.lineColors) {
      for (const [line, color] of options.lineColors) {
        this.parseLineColor(line, color)
      }
    }

    this._lineSigns = new Map<number, LineSign>()
    if (options.lineSigns) {
      for (const [line, sign] of options.lineSigns) {
        this._lineSigns.set(line, sign)
      }
    }

    this._inlineHighlights = new Map<number, LineInlineHighlight[]>()
    if (options.inlineHighlights) {
      for (const [line, highlights] of options.inlineHighlights) {
        this._inlineHighlights.set(line, highlights)
      }
    }

    // If target is provided in constructor, set it up immediately
    if (options.target) {
      this.setTarget(options.target)
    }
  }

  private setTarget(target: Renderable & LineInfoProvider): void {
    if (this.target === target) return

    if (this.target) {
      // Remove event listener from old target
      this.target.off("line-info-change", this.handleLineInfoChange)
      super.remove(this.target.id)
    }

    if (this.gutter) {
      super.remove(this.gutter.id)
      this.gutter = null
    }

    this.target = target

    // Listen for line info changes from target
    this.target.on("line-info-change", this.handleLineInfoChange)

    this.gutter = new GutterRenderable(this.ctx, this.target, {
      fg: this._fg,
      bg: this._bg,
      minWidth: this._minWidth,
      paddingRight: this._paddingRight,
      lineColorsGutter: this._lineColorsGutter,
      lineColorsContent: this._lineColorsContent,
      lineSigns: this._lineSigns,
      lineNumberOffset: this._lineNumberOffset,
      hideLineNumbers: this._hideLineNumbers,
      lineNumbers: this._lineNumbers,
      id: this.id ? `${this.id}-gutter` : undefined,
      buffered: true,
    })

    super.add(this.gutter)
    super.add(this.target)
  }

  // Override add to intercept and set as target if it's a LineInfoProvider
  public override add(child: Renderable): number {
    // If this is a LineInfoProvider and we don't have a target yet, set it
    if (
      !this.target &&
      "lineInfo" in child &&
      "lineCount" in child &&
      "virtualLineCount" in child &&
      "scrollY" in child
    ) {
      this.setTarget(child as Renderable & LineInfoProvider)
      return this.getChildrenCount() - 1
    }
    // Otherwise ignore - SolidJS may try to add layout slots or other helpers
    return -1
  }

  // Override remove to prevent removing gutter/target directly
  public override remove(id: string): void {
    if (this._isDestroying) {
      super.remove(id)
      return
    }

    if (this.gutter && id === this.gutter.id) {
      throw new Error("LineNumberRenderable: Cannot remove gutter directly.")
    }
    if (this.target && id === this.target.id) {
      throw new Error("LineNumberRenderable: Cannot remove target directly. Use clearTarget() instead.")
    }
    super.remove(id)
  }

  // Override destroyRecursively to properly clean up internal components
  public override destroyRecursively(): void {
    this._isDestroying = true

    if (this.target) {
      this.target.off("line-info-change", this.handleLineInfoChange)
    }

    super.destroyRecursively()

    this.gutter = null
    this.target = null
  }

  public clearTarget(): void {
    if (this.target) {
      this.target.off("line-info-change", this.handleLineInfoChange)
      super.remove(this.target.id)
      this.target = null
    }
    if (this.gutter) {
      super.remove(this.gutter.id)
      this.gutter = null
    }
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    // Draw full-width line backgrounds before children render
    if (!this.target || !this.gutter) return

    const lineInfo = this.target.lineInfo
    if (!lineInfo || !lineInfo.lineSources) return

    const sources = lineInfo.lineSources
    const startLine = this.target.scrollY

    if (startLine >= sources.length) return

    // Calculate the area to fill: from after the gutter (if visible) to the end of our width
    const gutterWidth = this.gutter.visible ? this.gutter.width : 0
    const contentWidth = this.width - gutterWidth
    const contentStartX = this.x + gutterWidth

    // Draw full-width background colors for lines with custom colors
    for (let i = 0; i < this.height; i++) {
      const visualLineIndex = startLine + i
      if (visualLineIndex >= sources.length) break

      const logicalLine = sources[visualLineIndex]
      const lineBg = this._lineColorsContent.get(logicalLine)

      if (lineBg) {
        // Fill from after gutter to the end of the LineNumberRenderable
        buffer.fillRect(contentStartX, this.y + i, contentWidth, 1, lineBg)
      }

      const inlineHighlights = this._inlineHighlights.get(logicalLine)
      if (inlineHighlights && inlineHighlights.length > 0) {
        const scrollX = (this.target as any).scrollX ?? 0
        const wrapIndex = lineInfo.lineWraps?.[visualLineIndex] ?? 0

        // Sum widths of previous wrapped segments to get column offset
        let columnOffset = 0
        if (wrapIndex > 0 && lineInfo.lineWidths) {
          for (let j = visualLineIndex - 1; j >= 0 && sources[j] === logicalLine; j--) {
            columnOffset += lineInfo.lineWidths[j] ?? 0
          }
        }

        const thisLineWidth = lineInfo.lineWidths?.[visualLineIndex] ?? contentWidth

        for (const highlight of inlineHighlights) {
          if (highlight.endCol <= columnOffset || highlight.startCol >= columnOffset + thisLineWidth) {
            continue
          }

          const visibleStartCol = Math.max(highlight.startCol, columnOffset) - columnOffset
          const visibleEndCol = Math.min(highlight.endCol, columnOffset + thisLineWidth) - columnOffset
          const highlightStartX = contentStartX + visibleStartCol - scrollX
          const highlightWidth = visibleEndCol - visibleStartCol

          const clampedStartX = Math.max(highlightStartX, contentStartX)
          const clampedEndX = Math.min(highlightStartX + highlightWidth, contentStartX + contentWidth)
          const clampedWidth = clampedEndX - clampedStartX

          if (clampedWidth > 0) {
            buffer.fillRect(clampedStartX, this.y + i, clampedWidth, 1, highlight.bg)
          }
        }
      }
    }
  }

  public set showLineNumbers(value: boolean) {
    if (this.gutter) {
      this.gutter.visible = value
    }
  }

  public get showLineNumbers(): boolean {
    return this.gutter?.visible ?? false
  }

  public setLineColor(line: number, color: string | RGBA | LineColorConfig): void {
    this.parseLineColor(line, color)
    // Update gutter if it exists
    if (this.gutter) {
      this.gutter.setLineColors(this._lineColorsGutter, this._lineColorsContent)
    }
  }

  public clearLineColor(line: number): void {
    this._lineColorsGutter.delete(line)
    this._lineColorsContent.delete(line)
    if (this.gutter) {
      this.gutter.setLineColors(this._lineColorsGutter, this._lineColorsContent)
    }
  }

  public clearAllLineColors(): void {
    this._lineColorsGutter.clear()
    this._lineColorsContent.clear()
    if (this.gutter) {
      this.gutter.setLineColors(this._lineColorsGutter, this._lineColorsContent)
    }
  }

  public setLineColors(lineColors: Map<number, string | RGBA | LineColorConfig>): void {
    this._lineColorsGutter.clear()
    this._lineColorsContent.clear()
    for (const [line, color] of lineColors) {
      this.parseLineColor(line, color)
    }
    // Update gutter once after all colors are set
    if (this.gutter) {
      this.gutter.setLineColors(this._lineColorsGutter, this._lineColorsContent)
    }
  }

  public getLineColors(): { gutter: Map<number, RGBA>; content: Map<number, RGBA> } {
    return {
      gutter: this._lineColorsGutter,
      content: this._lineColorsContent,
    }
  }

  public setLineSign(line: number, sign: LineSign): void {
    this._lineSigns.set(line, sign)
    if (this.gutter) {
      this.gutter.setLineSigns(this._lineSigns)
    }
  }

  public clearLineSign(line: number): void {
    this._lineSigns.delete(line)
    if (this.gutter) {
      this.gutter.setLineSigns(this._lineSigns)
    }
  }

  public clearAllLineSigns(): void {
    this._lineSigns.clear()
    if (this.gutter) {
      this.gutter.setLineSigns(this._lineSigns)
    }
  }

  public setLineSigns(lineSigns: Map<number, LineSign>): void {
    this._lineSigns.clear()
    for (const [line, sign] of lineSigns) {
      this._lineSigns.set(line, sign)
    }
    if (this.gutter) {
      this.gutter.setLineSigns(this._lineSigns)
    }
  }

  public getLineSigns(): Map<number, LineSign> {
    return this._lineSigns
  }

  public set lineNumberOffset(value: number) {
    if (this._lineNumberOffset !== value) {
      this._lineNumberOffset = value
      if (this.gutter) {
        // Update the gutter's offset using its setter
        this.gutter.setLineNumberOffset(value)
      }
    }
  }

  public get lineNumberOffset(): number {
    return this._lineNumberOffset
  }

  public setHideLineNumbers(hideLineNumbers: Set<number>): void {
    this._hideLineNumbers = hideLineNumbers
    if (this.gutter) {
      // Update the gutter's hideLineNumbers using its setter
      this.gutter.setHideLineNumbers(hideLineNumbers)
    }
  }

  public getHideLineNumbers(): Set<number> {
    return this._hideLineNumbers
  }

  public setLineNumbers(lineNumbers: Map<number, number>): void {
    this._lineNumbers = lineNumbers
    if (this.gutter) {
      // Update the gutter's lineNumbers using its setter
      this.gutter.setLineNumbers(lineNumbers)
    }
  }

  public getLineNumbers(): Map<number, number> {
    return this._lineNumbers
  }

  /**
   * Sets inline highlights for word-level diff highlighting.
   *
   * @param inlineHighlights - Map from logical line index to array of highlights
   */
  public setInlineHighlights(inlineHighlights: Map<number, LineInlineHighlight[]>): void {
    this._inlineHighlights = inlineHighlights
    this.requestRender()
  }

  /**
   * Gets the current inline highlights.
   */
  public getInlineHighlights(): Map<number, LineInlineHighlight[]> {
    return this._inlineHighlights
  }

  /**
   * Clears all inline highlights.
   */
  public clearInlineHighlights(): void {
    this._inlineHighlights.clear()
    this.requestRender()
  }

  /**
   * Sets inline highlights for a specific line.
   *
   * @param line - Logical line index
   * @param highlights - Array of highlights for this line
   */
  public setLineInlineHighlights(line: number, highlights: LineInlineHighlight[]): void {
    this._inlineHighlights.set(line, highlights)
    this.requestRender()
  }

  /**
   * Clears inline highlights for a specific line.
   */
  public clearLineInlineHighlights(line: number): void {
    this._inlineHighlights.delete(line)
    this.requestRender()
  }
}
