import { Renderable, type RenderableOptions } from "../Renderable.js"
import { NativeImage, type ImageSource } from "../image.js"
import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import type { ImageRenderProtocol, RenderContext, TerminalCapabilities } from "../types.js"

export type ImageFit = "fit" | "cover" | "fill"
export type ImageRenderableSource = ImageSource | NativeImage

const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)

export interface ImageRenderableOptions extends RenderableOptions<ImageRenderable> {
  source?: ImageRenderableSource
  fit?: ImageFit
  protocol?: ImageRenderProtocol
  onLoad?: (image: NativeImage) => void
  onError?: (error: unknown) => void
}

export function resolveImageRenderProtocol(
  requested: ImageRenderProtocol,
  capabilities: TerminalCapabilities | null,
  hasResolution: boolean,
): Exclude<ImageRenderProtocol, "auto"> {
  if (requested !== "auto") return requested === "sixel" && !hasResolution ? "blocks" : requested
  const configured = capabilities?.image_protocol ?? "auto"
  if (configured !== "auto") return configured === "sixel" && !hasResolution ? "blocks" : configured
  if (!capabilities || capabilities.multiplexer === "tmux") return "blocks"
  if (capabilities.kitty_graphics) return "kitty"
  if (capabilities.sixel && hasResolution) return "sixel"
  return "blocks"
}

function pixelResolution(ctx: RenderContext): { width: number; height: number } | null {
  const terminalWidth = ctx.terminalWidth ?? 0
  const terminalHeight = ctx.terminalHeight ?? 0
  const resolution = terminalWidth > 0 && terminalHeight > 0 ? ctx.resolution : null
  return resolution && resolution.width > 0 && resolution.height > 0 ? resolution : null
}

export class ImageRenderable extends Renderable {
  private _source: ImageRenderableSource | undefined
  private _image: NativeImage | null = null
  private _pendingImage: NativeImage | null = null
  private _loadError: unknown = null
  private _loadController: AbortController | null = null
  public onLoad?: (image: NativeImage) => void
  public onError?: (error: unknown) => void
  private _fit: ImageFit
  private _protocol: ImageRenderProtocol
  public loadPromise: Promise<void> | null = null

  constructor(ctx: RenderContext, options: ImageRenderableOptions) {
    super(ctx, options)
    this._fit = options.fit ?? "fit"
    this._protocol = options.protocol ?? "auto"
    this.onLoad = options.onLoad
    this.onError = options.onError
    if (options.source !== undefined) this.source = options.source
  }

  public get source(): ImageRenderableSource | undefined {
    return this._source
  }

  public set source(source: ImageRenderableSource | undefined) {
    source ??= undefined
    if (source === this._source) return
    this._source = source
    this._loadController?.abort()
    this._loadController = null
    this._pendingImage?.dispose()
    this._pendingImage = null

    if (source === undefined) {
      this._loadError = null
      this._image?.dispose()
      this._image = null
      this.loadPromise = null
      this.requestRender()
      return
    }

    const controller = new AbortController()
    this._loadController = controller
    this._loadError = null
    let imagePromise: Promise<NativeImage>
    if (source instanceof NativeImage) {
      try {
        const image = source.retain()
        this._pendingImage = image
        imagePromise = Promise.resolve(image)
      } catch (error) {
        imagePromise = Promise.reject(error)
      }
    } else {
      imagePromise = NativeImage.load(source, { signal: controller.signal })
    }
    this.loadPromise = this.load(imagePromise, controller)
  }

  public get image(): NativeImage | null {
    return this._image
  }

  public get fit(): ImageFit {
    return this._fit
  }

  public set fit(value: ImageFit | null | undefined) {
    const next = value ?? "fit"
    if (this._fit === next) return
    this._fit = next
    this.requestRender()
  }

  public get protocol(): ImageRenderProtocol {
    return this._protocol
  }

  public set protocol(value: ImageRenderProtocol | null | undefined) {
    const next = value ?? "auto"
    if (this._protocol === next) return
    this._protocol = next
    this.requestRender()
  }

  public get effectiveProtocol(): Exclude<ImageRenderProtocol, "auto"> {
    return resolveImageRenderProtocol(this._protocol, this._ctx.capabilities, pixelResolution(this._ctx) !== null)
  }

  public get cellAspectRatio(): number {
    const resolution = pixelResolution(this._ctx)
    if (!resolution) return 2
    const cellWidth = resolution.width / this._ctx.terminalWidth!
    const cellHeight = resolution.height / this._ctx.terminalHeight!
    return cellWidth > 0 && cellHeight > 0 ? cellHeight / cellWidth : 2
  }

  public getFittedSize(
    targetWidth: number,
    targetHeight: number,
    cellAspectRatio: number = this.cellAspectRatio,
    sourceWidth: number = this._image?.width ?? 0,
    sourceHeight: number = this._image?.height ?? 0,
  ): { width: number; height: number } {
    if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) return { width: 0, height: 0 }
    if (this._fit === "fill") return { width: targetWidth, height: targetHeight }

    const displayAspect = (sourceWidth / sourceHeight) * cellAspectRatio
    const scale =
      this._fit === "fit"
        ? Math.min(targetWidth / displayAspect, targetHeight)
        : Math.max(targetWidth / displayAspect, targetHeight)
    return {
      width: Math.max(1, Math.round(displayAspect * scale)),
      height: Math.max(1, Math.round(scale)),
    }
  }

  public get loading(): boolean {
    return this._loadController !== null
  }

  public get loadError(): unknown {
    return this._loadError
  }

  public override render(buffer: OptimizedBuffer, deltaTime: number): void {
    if (this.buffered) this.frameBuffer?.clear(TRANSPARENT)
    super.render(buffer, deltaTime)
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (!this._image || this.width <= 0 || this.height <= 0) return
    const fitted =
      this._fit === "cover" ? { width: this.width, height: this.height } : this.getFittedSize(this.width, this.height)
    if (fitted.width <= 0 || fitted.height <= 0) return
    const originX = this.buffered ? 0 : this._screenX
    const originY = this.buffered ? 0 : this._screenY
    const x = originX + Math.floor((this.width - fitted.width) / 2)
    const y = originY + Math.floor((this.height - fitted.height) / 2)
    const resolution = pixelResolution(this._ctx)
    const pixelWidth = resolution
      ? Math.max(1, Math.round((fitted.width * resolution.width) / this._ctx.terminalWidth!))
      : 0
    const pixelHeight = resolution
      ? Math.max(1, Math.round((fitted.height * resolution.height) / this._ctx.terminalHeight!))
      : 0
    let sourceX = 0
    let sourceY = 0
    let sourceWidth = this._image.width
    let sourceHeight = this._image.height
    if (this._fit === "cover") {
      const targetAspect = this.width / (this.height * this.cellAspectRatio)
      const sourceAspect = sourceWidth / sourceHeight
      if (sourceAspect > targetAspect) {
        sourceWidth = Math.max(1, Math.round(sourceHeight * targetAspect))
        sourceX = Math.floor((this._image.width - sourceWidth) / 2)
      } else {
        sourceHeight = Math.max(1, Math.round(sourceWidth / targetAspect))
        sourceY = Math.floor((this._image.height - sourceHeight) / 2)
      }
    }
    buffer.drawImage(
      this._image,
      x,
      y,
      fitted.width,
      fitted.height,
      pixelWidth,
      pixelHeight,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      this._protocol,
    )
  }

  private async load(imagePromise: Promise<NativeImage>, controller: AbortController): Promise<void> {
    let image: NativeImage
    try {
      image = await imagePromise
    } catch (error) {
      if (controller.signal.aborted || this.isDestroyed || this._loadController !== controller) return
      this._loadController = null
      this._loadError = error
      this.onError?.(error)
      return
    }

    if (this.isDestroyed || this._loadController !== controller) {
      image.dispose()
      return
    }

    if (this._pendingImage === image) this._pendingImage = null
    const previous = this._image
    this._image = image
    this._loadController = null
    previous?.dispose()
    this.requestRender()
    this.onLoad?.(image)
  }

  protected destroySelf(): void {
    this._loadController?.abort()
    this._loadController = null
    this._pendingImage?.dispose()
    this._pendingImage = null
    this._image?.dispose()
    this._image = null
    super.destroySelf()
  }
}
