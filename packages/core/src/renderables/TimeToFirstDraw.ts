import type { OptimizedBuffer } from "../buffer.js"
import { parseColor, RGBA, type ColorInput } from "../lib/RGBA.js"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import type { RenderContext } from "../types.js"

const transparent = RGBA.fromValues(0, 0, 0, 0)

/** The cells that drawTextFit keeps of text within maxWidth: printable ASCII is one cell per byte. */
function fittedWidth(buffer: OptimizedBuffer, text: string, maxWidth: number): number {
  if (/^[\x20-\x7e]*$/.test(text)) return Math.min(text.length, maxWidth)
  const encoded = buffer.encodeUnicode(text)
  let width = 0
  for (const glyph of encoded.data) {
    if (width + glyph.width > maxWidth) break
    width += glyph.width
  }
  buffer.freeUnicode(encoded)
  return width
}

export interface TimeToFirstDrawOptions extends RenderableOptions<TimeToFirstDrawRenderable> {
  fg?: ColorInput
  label?: string
  precision?: number
}

export class TimeToFirstDrawRenderable extends Renderable {
  private _runtimeMs: number | null = null
  private textColor: RGBA
  private label: string
  private precision: number

  constructor(ctx: RenderContext, options: TimeToFirstDrawOptions = {}) {
    super(ctx, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      alignSelf: "center",
      ...options,
    })

    this.textColor = parseColor(options.fg ?? "#AAAAAA")
    this.label = options.label ?? "Time to first draw"
    this.precision = this.normalizePrecision(options.precision ?? 2)
  }

  protected override defaultDimension(kind: "width" | "height"): number | `${number}%` {
    return kind === "width" ? "100%" : 1
  }

  public get runtimeMs(): number | null {
    return this._runtimeMs
  }

  public set fg(value: ColorInput) {
    this.textColor = parseColor(value)
    this.requestRender()
  }

  public set color(value: ColorInput) {
    this.fg = value
  }

  public set textLabel(value: string) {
    if (value === this.label) {
      return
    }

    this.label = value
    this.requestRender()
  }

  public set decimals(value: number) {
    const nextPrecision = this.normalizePrecision(value)
    if (nextPrecision === this.precision) {
      return
    }

    this.precision = nextPrecision
    this.requestRender()
  }

  public reset(): void {
    this._runtimeMs = null
    this.requestRender()
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this._runtimeMs === null) {
      this._runtimeMs = performance.now()
    }

    const content = `${this.label}: ${this._runtimeMs.toFixed(this.precision)}ms`
    const maxWidth = Math.max(this.width, 1)
    const [x, y] = this._paintOrigin(buffer)
    const width = fittedWidth(buffer, content, maxWidth)

    buffer.drawTextFit(content, x + Math.floor((maxWidth - width) / 2), y, width, this.textColor, transparent)
  }

  private normalizePrecision(value: number): number {
    if (!Number.isFinite(value)) {
      return 2
    }

    return Math.max(0, Math.floor(value))
  }
}
