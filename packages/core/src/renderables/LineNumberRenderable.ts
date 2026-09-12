import { Renderable, type BaseRenderable, type RenderableOptions } from "../Renderable.js"
import { OptimizedBuffer } from "../buffer.js"
import type { RenderContext, LineInfoProvider } from "../types.js"
import { RGBA, parseColor } from "../lib/RGBA.js"
import { stringWidth } from "../platform/runtime.js"
import { MeasureMode } from "../yoga.js"

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
}

const DEFAULT_GUTTER_FG = "#888888"
const DEFAULT_GUTTER_BG = "transparent"

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
  private _paintedSources?: number[]
  private _paintedSourceOffset: number = 0

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
    },
  ) {
    super(ctx, {
      id: options.id,
      width: "auto",
      height: "auto",
      flexGrow: 0,
      flexShrink: 0,
      buffered: true,
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
        const width = stringWidth(sign.before)
        this._maxBeforeWidth = Math.max(this._maxBeforeWidth, width)
      }
      if (sign.after) {
        const width = stringWidth(sign.after)
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

  public get fg(): RGBA {
    return this._fg
  }

  public setFg(fg: RGBA): void {
    if (this._fg !== fg) {
      this._fg = fg
      this.requestRender()
    }
  }

  public get bg(): RGBA {
    return this._bg
  }

  public setBg(bg: RGBA): void {
    if (this._bg !== bg) {
      this._bg = bg
      this.requestRender()
    }
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

  // The destination's paint window, not Yoga's document height, owns raster allocation.
  protected override createFrameBuffer(): void {}
  protected override handleFrameBufferResize(): void {}

  public override render(buffer: OptimizedBuffer, deltaTime: number): void {
    // Match native integer-cell drawing before deriving the source window.
    const x = this._screenX
    const y = Math.trunc(this._screenY)
    const start = Math.max(0, -y)
    const end = Math.min(this.height, buffer.height - y)
    if (end <= start || x >= buffer.width || x + this.width <= 0) return

    if (!this.frameBuffer) {
      this.frameBuffer = OptimizedBuffer.create(this.width, end - start, this._ctx.widthMethod, {
        respectAlpha: true,
        id: `framebuffer-${this.id}`,
      })
    } else if (this.frameBuffer.width !== this.width || this.frameBuffer.height !== end - start) {
      this.frameBuffer.resize(this.width, end - start)
      this._paintedSources = undefined
    }

    // Repaint only requested rows. Outer scrolling changes y without changing target.scrollY,
    // and source mappings can change without changing the number of visual rows.
    this.refreshFrameBuffer(this.frameBuffer, Math.trunc(this.target.scrollY) + start)
    this.markClean()
    this._ctx.addToHitGrid(x, this._screenY, this.width, this.height, this.num)
    buffer.drawFrameBuffer(x, y + start, this.frameBuffer)
  }

  private refreshFrameBuffer(buffer: OptimizedBuffer, startLine: number): void {
    // Get the logical line index of the line *before* the first visible line
    // This helps determine if the first visible line is a wrapped continuation
    const sourceStart = Math.max(0, startLine - 1)
    const sourceOffset = startLine - sourceStart
    const sources = getLineSources(this.target, sourceStart, buffer.height + sourceOffset)
    const paintedSources = this._paintedSources
    // Row IDs also catch remapping changes without relying on the target's paint order or dirty flag.
    if (
      !this.isDirty &&
      sourceOffset === this._paintedSourceOffset &&
      paintedSources &&
      sources.length === paintedSources.length &&
      sources.every((source, i) => source === paintedSources[i])
    ) {
      return
    }
    buffer.clear(this._bg)
    let lastSource = sourceOffset > 0 ? sources[0] : -1

    for (let i = 0; i < buffer.height; i++) {
      const visualLineIndex = sourceOffset + i
      if (visualLineIndex >= sources.length) break

      const logicalLine = sources[visualLineIndex]
      const lineBg = this._lineColorsGutter.get(logicalLine) ?? this._bg

      // Fill background for this line if it has a custom color
      if (lineBg !== this._bg) {
        buffer.fillRect(0, i, this.width, 1, lineBg)
      }

      // Draw line number only for the first visual line of a logical line (wrapping)
      if (logicalLine === lastSource) {
        // Continuation line, maybe draw a dot or nothing
      } else {
        let currentX = 0

        // Draw 'before' sign if present
        const sign = this._lineSigns.get(logicalLine)
        if (sign?.before) {
          const beforeWidth = stringWidth(sign.before)
          // Pad to max before width for alignment
          const padding = this._maxBeforeWidth - beforeWidth
          currentX += padding
          const beforeColor = sign.beforeColor ? parseColor(sign.beforeColor) : this._fg
          buffer.drawText(sign.before, currentX, i, beforeColor, lineBg)
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
          const lineNumX = this._maxBeforeWidth + 1 + availableSpace - lineNumWidth - 1

          if (lineNumX >= this._maxBeforeWidth + 1) {
            buffer.drawText(lineNumStr, lineNumX, i, this._fg, lineBg)
          }
        }

        // Draw 'after' sign if present
        if (sign?.after) {
          const afterX = this.width - this._paddingRight - this._maxAfterWidth
          const afterColor = sign.afterColor ? parseColor(sign.afterColor) : this._fg
          buffer.drawText(sign.after, afterX, i, afterColor, lineBg)
        }
      }

      lastSource = logicalLine
    }
    this._paintedSources = sources.slice()
    this._paintedSourceOffset = sourceOffset
  }
}

function getLineSources(target: LineInfoProvider, startLine: number, lineCount: number): number[] {
  return target.getLineSources
    ? target.getLineSources(startLine, lineCount)
    : target.lineInfo.lineSources.slice(startLine, startLine + lineCount)
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

    this._fg = parseColor(options.fg ?? DEFAULT_GUTTER_FG)
    this._bg = parseColor(options.bg ?? DEFAULT_GUTTER_BG)
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
      super.remove(this.target)
    }

    if (this.gutter) {
      super.remove(this.gutter)
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
  public override remove(child: BaseRenderable): void {
    if (this._isDestroying) {
      super.remove(child)
      return
    }

    if (this.gutter && child === this.gutter) {
      throw new Error("LineNumberRenderable: Cannot remove gutter directly.")
    }
    if (this.target && child === this.target) {
      throw new Error("LineNumberRenderable: Cannot remove target directly. Use clearTarget() instead.")
    }
    super.remove(child)
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
      super.remove(this.target)
      this.target = null
    }
    if (this.gutter) {
      super.remove(this.gutter)
      this.gutter = null
    }
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    // Draw full-width line backgrounds before children render
    if (!this.target || !this.gutter || this._lineColorsContent.size === 0) return

    const y = Math.trunc(this.y)
    const start = Math.max(0, -y)
    const end = Math.min(this.height, buffer.height - y)
    if (end <= start || this.x >= buffer.width || this.x + this.width <= 0) return

    const sources = getLineSources(this.target, Math.trunc(this.target.scrollY) + start, end - start)

    // Calculate the area to fill: from after the gutter (if visible) to the end of our width
    const gutterWidth = this.gutter.visible ? this.gutter.width : 0
    const contentWidth = this.width - gutterWidth

    // Draw full-width background colors for lines with custom colors
    for (let i = 0; i < sources.length; i++) {
      const logicalLine = sources[i]
      const lineBg = this._lineColorsContent.get(logicalLine)

      if (lineBg) {
        // Fill from after gutter to the end of the LineNumberRenderable
        buffer.fillRect(this.x + gutterWidth, y + start + i, contentWidth, 1, lineBg)
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

  public get fg(): RGBA {
    return this._fg
  }

  public set fg(value: string | RGBA | undefined) {
    const parsed = parseColor(value ?? DEFAULT_GUTTER_FG)
    if (this._fg !== parsed) {
      this._fg = parsed
      this.gutter?.setFg(parsed)
    }
  }

  public get bg(): RGBA {
    return this._bg
  }

  public set bg(value: string | RGBA | undefined) {
    const parsed = parseColor(value ?? DEFAULT_GUTTER_BG)
    if (this._bg !== parsed) {
      this._bg = parsed
      this.gutter?.setBg(parsed)
    }
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

  public highlightLines(startLine: number, endLine: number, color: string | RGBA | LineColorConfig): void {
    for (let i = startLine; i <= endLine; i++) {
      this.parseLineColor(i, color)
    }
    if (this.gutter) {
      this.gutter.setLineColors(this._lineColorsGutter, this._lineColorsContent)
    }
  }

  public clearHighlightLines(startLine: number, endLine: number): void {
    for (let i = startLine; i <= endLine; i++) {
      this._lineColorsGutter.delete(i)
      this._lineColorsContent.delete(i)
    }
    if (this.gutter) {
      this.gutter.setLineColors(this._lineColorsGutter, this._lineColorsContent)
    }
  }
}
