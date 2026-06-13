import { MeasureMode } from "@opentui/core/yoga"
import {
  OptimizedBuffer,
  parseColor,
  RGBA,
  Renderable,
  type ColorInput,
  type RenderableOptions,
  type RenderContext,
} from "@opentui/core"
import { ErrorCorrectionLevel, QRCode } from "../lib/qrcode.js"

const DEFAULT_FOREGROUND = RGBA.fromHex("#000000")
const DEFAULT_BACKGROUND = RGBA.fromHex("#ffffff")
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)
const QR_CODE_MINIMUM_QUIET_ZONE = 4

export type QRCodeFitMode = "contain" | "none"

interface EncodedQRCode<TVersion extends number> {
  readonly version: TVersion
  readonly size: number
  toMatrix(): boolean[][]
}

interface QRCodeSharedOptions<TRenderable extends Renderable, TEcl> extends RenderableOptions<TRenderable> {
  content?: string
  errorCorrectionLevel?: TEcl
  quietZone?: number
  scale?: number
  fit?: QRCodeFitMode
  foregroundColor?: ColorInput
  backgroundColor?: ColorInput
  fallbackContent?: string
  fallbackColor?: ColorInput
}

export interface QRCodeOptions extends QRCodeSharedOptions<QRCodeRenderable, ErrorCorrectionLevel> {}

interface QRCodeRenderableDefaults<TEcl> {
  content: string
  errorCorrectionLevel: TEcl
  quietZone: number
  scale: number
  fit: QRCodeFitMode
  foregroundColor: RGBA
  backgroundColor: RGBA
  fallbackContent: string
  fallbackColor: RGBA
}

abstract class BaseQRCodeRenderable<
  TEcl,
  TVersion extends number,
  TEncoded extends EncodedQRCode<TVersion>,
> extends Renderable {
  private _content: string
  private _errorCorrectionLevel: TEcl
  private _quietZone: number
  private _scale: number
  private _fit: QRCodeFitMode
  private _foregroundColor: RGBA
  private _backgroundColor: RGBA
  private _fallbackContent: string
  private _fallbackColor: RGBA
  private encoded: TEncoded
  private modules: boolean[][]
  private renderBuffer: OptimizedBuffer | null = null
  private renderBufferDirty = true

  protected constructor(
    ctx: RenderContext,
    options: QRCodeSharedOptions<any, TEcl>,
    defaults: QRCodeRenderableDefaults<TEcl>,
    private readonly minimumQuietZone: number,
    private readonly encodeContent: (content: string, errorCorrectionLevel: TEcl) => TEncoded,
  ) {
    const content = options.content ?? defaults.content
    const errorCorrectionLevel = options.errorCorrectionLevel ?? defaults.errorCorrectionLevel
    const quietZone = normalizeQuietZone(options.quietZone ?? defaults.quietZone, minimumQuietZone)
    const scale = normalizeScale(options.scale ?? defaults.scale)
    const fit = options.fit ?? defaults.fit
    const encoded = encodeContent(content, errorCorrectionLevel)

    super(ctx, {
      ...options,
    })

    this._content = content
    this._errorCorrectionLevel = errorCorrectionLevel
    this._quietZone = quietZone
    this._scale = scale
    this._fit = fit
    this._foregroundColor = options.foregroundColor ? parseColor(options.foregroundColor) : defaults.foregroundColor
    this._backgroundColor = options.backgroundColor ? parseColor(options.backgroundColor) : defaults.backgroundColor
    this._fallbackContent = options.fallbackContent ?? defaults.fallbackContent
    this._fallbackColor = options.fallbackColor ? parseColor(options.fallbackColor) : defaults.fallbackColor
    this.encoded = encoded
    this.modules = encoded.toMatrix()

    this.setupMeasureFunc()
  }

  public get content(): string {
    return this._content
  }

  public set content(value: string) {
    if (value === this._content) {
      return
    }

    this._content = value
    this.rebuildMatrix()
  }

  public get errorCorrectionLevel(): TEcl {
    return this._errorCorrectionLevel
  }

  public set errorCorrectionLevel(value: TEcl) {
    if (value === this._errorCorrectionLevel) {
      return
    }

    this._errorCorrectionLevel = value
    this.rebuildMatrix()
  }

  public get quietZone(): number {
    return this._quietZone
  }

  public set quietZone(value: number) {
    const nextQuietZone = normalizeQuietZone(value, this.minimumQuietZone)
    if (nextQuietZone === this._quietZone) {
      return
    }

    this._quietZone = nextQuietZone
    this.remeasure()
  }

  public get scale(): number {
    return this._scale
  }

  public set scale(value: number) {
    const nextScale = normalizeScale(value)
    if (nextScale === this._scale) {
      return
    }

    this._scale = nextScale
    this.remeasure()
  }

  public get fit(): QRCodeFitMode {
    return this._fit
  }

  public set fit(value: QRCodeFitMode) {
    if (value === this._fit) {
      return
    }

    this._fit = value
    this.remeasure()
  }

  public get foregroundColor(): RGBA {
    return this._foregroundColor
  }

  public set foregroundColor(value: ColorInput) {
    this._foregroundColor = parseColor(value)
    this.invalidateRenderBuffer()
    this.requestRender()
  }

  public get backgroundColor(): RGBA {
    return this._backgroundColor
  }

  public set backgroundColor(value: ColorInput) {
    this._backgroundColor = parseColor(value)
    this.invalidateRenderBuffer()
    this.requestRender()
  }

  public get fallbackContent(): string {
    return this._fallbackContent
  }

  public set fallbackContent(value: string) {
    if (value === this._fallbackContent) {
      return
    }

    this._fallbackContent = value
    this.remeasure()
  }

  public get fallbackColor(): RGBA {
    return this._fallbackColor
  }

  public set fallbackColor(value: ColorInput) {
    this._fallbackColor = parseColor(value)
    this.invalidateRenderBuffer()
    this.requestRender()
  }

  public get version(): TVersion {
    return this.encoded.version
  }

  public get moduleCount(): number {
    return this.encoded.size
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (this.width <= 0 || this.height <= 0) {
      return
    }

    const renderBuffer = this.getRenderBuffer()
    if (this.renderBufferDirty) {
      this.paintRenderBuffer(renderBuffer)
      this.renderBufferDirty = false
    }

    if (this.buffered) {
      buffer.clear(TRANSPARENT)
      buffer.drawFrameBuffer(0, 0, renderBuffer)
      return
    }

    buffer.drawFrameBuffer(this._screenX, this._screenY, renderBuffer)
  }

  protected override onResize(width: number, height: number): void {
    this.invalidateRenderBuffer()
    super.onResize(width, height)
  }

  protected override destroySelf(): void {
    this.renderBuffer?.destroy()
    this.renderBuffer = null
    super.destroySelf()
  }

  private paintRenderBuffer(buffer: OptimizedBuffer): void {
    buffer.clear(TRANSPARENT)

    const totalModules = this.encoded.size + this._quietZone * 2
    const effectiveScale = this.resolveRenderScale(this.width, this.height)

    if (effectiveScale <= 0) {
      this.paintFallback(buffer)
      return
    }

    const renderWidth = totalModules * effectiveScale
    const renderHeightPixels = totalModules * effectiveScale
    const xOffset = Math.max(0, Math.floor((this.width - renderWidth) / 2))
    const yOffsetPixels = Math.max(0, Math.floor((this.height * 2 - renderHeightPixels) / 2))

    for (let cellY = 0; cellY < this.height; cellY++) {
      const topPixel = cellY * 2 - yOffsetPixels
      const bottomPixel = topPixel + 1
      const intersectsRenderY = bottomPixel >= 0 && topPixel < renderHeightPixels

      if (intersectsRenderY) {
        buffer.fillRect(xOffset, cellY, renderWidth, 1, this._backgroundColor)
      }

      for (let cellX = 0; cellX < renderWidth; cellX++) {
        const top = this.isDarkAtScaledPixel(cellX, topPixel, effectiveScale)
        const bottom = this.isDarkAtScaledPixel(cellX, bottomPixel, effectiveScale)

        if (!top && !bottom) {
          continue
        }

        buffer.setCell(
          xOffset + cellX,
          cellY,
          getBlockCharacter(top, bottom),
          this._foregroundColor,
          this._backgroundColor,
        )
      }
    }
  }

  private rebuildMatrix(): void {
    this.encoded = this.encodeContent(this._content, this._errorCorrectionLevel)
    this.modules = this.encoded.toMatrix()
    this.remeasure()
  }

  private remeasure(): void {
    this.invalidateRenderBuffer()
    this.yogaNode.markDirty()
    this.requestRender()
  }

  private invalidateRenderBuffer(): void {
    this.renderBufferDirty = true
  }

  private getRenderBuffer(): OptimizedBuffer {
    if (this.renderBuffer) {
      if (this.renderBuffer.width !== this.width || this.renderBuffer.height !== this.height) {
        this.renderBuffer.resize(this.width, this.height)
        this.invalidateRenderBuffer()
      }

      return this.renderBuffer
    }

    this.renderBuffer = OptimizedBuffer.create(this.width, this.height, this._ctx.widthMethod, {
      respectAlpha: true,
      id: `qrcode-renderable-${this.id}`,
    })
    this.invalidateRenderBuffer()
    return this.renderBuffer
  }

  private setupMeasureFunc(): void {
    this.yogaNode.setMeasureFunc((width, widthMode, height, heightMode) => {
      const scale = this.resolveMeasuredScale(width, widthMode, height, heightMode)
      if (scale > 0) {
        return getDimensionsForScale(this.encoded.size, this._quietZone, scale)
      }

      if (this._fallbackContent.length > 0) {
        return {
          width: getFallbackWidth(this._fallbackContent, width, widthMode),
          height: 1,
        }
      }

      return {
        width: 0,
        height: 0,
      }
    })
  }

  private resolveMeasuredScale(width: number, widthMode: MeasureMode, height: number, heightMode: MeasureMode): number {
    const availableWidth = widthMode === MeasureMode.Undefined || Number.isNaN(width) ? undefined : Math.floor(width)
    const availableHeight =
      heightMode === MeasureMode.Undefined || Number.isNaN(height) ? undefined : Math.floor(height)
    return this.resolveScaleForBounds(availableWidth, availableHeight)
  }

  private resolveRenderScale(width: number, height: number): number {
    return this.resolveScaleForBounds(width, height)
  }

  private resolveScaleForBounds(availableWidth?: number, availableHeight?: number): number {
    if (this._fit === "none") {
      return this._scale
    }

    const totalModules = this.encoded.size + this._quietZone * 2
    let scale = this._scale

    if (availableWidth !== undefined) {
      scale = Math.min(scale, Math.floor(availableWidth / totalModules))
    }

    if (availableHeight !== undefined) {
      scale = Math.min(scale, Math.floor((availableHeight * 2) / totalModules))
    }

    return Math.max(0, scale)
  }

  private isDarkAtScaledPixel(renderPixelX: number, renderPixelY: number, scale: number): boolean {
    if (renderPixelX < 0 || renderPixelY < 0) {
      return false
    }

    const moduleX = Math.floor(renderPixelX / scale) - this._quietZone
    const moduleY = Math.floor(renderPixelY / scale) - this._quietZone

    if (moduleX < 0 || moduleY < 0 || moduleX >= this.encoded.size || moduleY >= this.encoded.size) {
      return false
    }

    return this.modules[moduleY]![moduleX]!
  }

  private paintFallback(buffer: OptimizedBuffer): void {
    if (this._fallbackContent.length === 0 || this.width <= 0 || this.height <= 0) {
      return
    }

    const content = this._fallbackContent.slice(0, this.width)
    const xOffset = Math.max(0, Math.floor((this.width - content.length) / 2))
    const yOffset = Math.max(0, Math.floor(this.height / 2))

    for (let i = 0; i < content.length; i++) {
      buffer.setCell(xOffset + i, yOffset, content[i]!, this._fallbackColor, TRANSPARENT)
    }
  }
}

export class QRCodeRenderable extends BaseQRCodeRenderable<ErrorCorrectionLevel, number, QRCode> {
  protected static readonly _defaultOptions = {
    content: "",
    errorCorrectionLevel: ErrorCorrectionLevel.M,
    quietZone: QR_CODE_MINIMUM_QUIET_ZONE,
    scale: 1,
    fit: "contain" as QRCodeFitMode,
    foregroundColor: DEFAULT_FOREGROUND,
    backgroundColor: DEFAULT_BACKGROUND,
    fallbackContent: "",
    fallbackColor: DEFAULT_BACKGROUND,
  } satisfies QRCodeRenderableDefaults<ErrorCorrectionLevel>

  constructor(ctx: RenderContext, options: QRCodeOptions = {}) {
    super(ctx, options, QRCodeRenderable._defaultOptions, QR_CODE_MINIMUM_QUIET_ZONE, (content, errorCorrectionLevel) =>
      QRCode.encodeText(content, errorCorrectionLevel),
    )
  }
}

function getDimensionsForScale(
  moduleCount: number,
  quietZone: number,
  scale: number,
): { width: number; height: number } {
  const totalModules = (moduleCount + quietZone * 2) * scale

  return {
    width: totalModules,
    height: Math.max(1, Math.ceil(totalModules / 2)),
  }
}

function getBlockCharacter(top: boolean, bottom: boolean): string {
  if (top && bottom) {
    return "█"
  }

  if (top) {
    return "▀"
  }

  return "▄"
}

function getFallbackWidth(content: string, width: number, widthMode: MeasureMode): number {
  if (widthMode === MeasureMode.Undefined || Number.isNaN(width)) {
    return content.length
  }

  return Math.max(0, Math.min(content.length, Math.floor(width)))
}

function normalizeQuietZone(value: number, minimumQuietZone: number): number {
  if (!Number.isFinite(value)) {
    return minimumQuietZone
  }

  const quietZone = Math.floor(value)
  if (quietZone < minimumQuietZone) {
    throw new RangeError(`Quiet zone must be at least ${minimumQuietZone} modules`)
  }
  return quietZone
}

function normalizeScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }

  return Math.max(1, Math.floor(value))
}
