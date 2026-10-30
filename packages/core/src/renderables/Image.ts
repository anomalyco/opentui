import { Renderable, type RenderableOptions, type NativeRenderableIntegration } from "../Renderable.js"
import { NativeImage, type ExtractOptions, type ImageSource } from "../image.js"
import type { OptimizedBuffer } from "../buffer.js"
import type { ImageRenderProtocol, RenderContext, TerminalCapabilities } from "../types.js"

export type ImageFit = "fit" | "cover" | "fill"
export type ImageRenderableSource = ImageSource | NativeImage

export interface ImageRenderableOptions extends RenderableOptions<ImageRenderable> {
  source?: ImageRenderableSource
  fit?: ImageFit
  /** The region of the source to show, in source pixels; `fit` applies to it. */
  crop?: ExtractOptions
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

/** @internal Copies a crop of u32 pixels with a positive size that lies inside a width x height source, or throws. */
export function checkCrop(crop: ExtractOptions, width = Infinity, height = Infinity): ExtractOptions {
  const { left, top, width: cropWidth, height: cropHeight } = crop
  const u32 = (value: number, min: number) => Number.isInteger(value) && value >= min && value <= 0xffff_ffff
  if (!u32(left, 0) || !u32(top, 0) || !u32(cropWidth, 1) || !u32(cropHeight, 1))
    throw new RangeError("crop needs u32 left and top and a positive u32 width and height")
  if (left + cropWidth > width || top + cropHeight > height)
    throw new RangeError(`crop ${cropWidth}x${cropHeight} at ${left},${top} lies outside the ${width}x${height} source`)
  return { left, top, width: cropWidth, height: cropHeight }
}

/** @internal */
export function sameCrop(a: ExtractOptions | undefined, b: ExtractOptions | undefined): boolean {
  return a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height)
}

function pixelResolution(ctx: RenderContext): { width: number; height: number } | null {
  const terminalWidth = ctx.terminalWidth ?? 0
  const terminalHeight = ctx.terminalHeight ?? 0
  const resolution = terminalWidth > 0 && terminalHeight > 0 ? ctx.resolution : null
  return resolution && resolution.width > 0 && resolution.height > 0 ? resolution : null
}

export class ImageRenderable extends Renderable {
  static override readonly nativeIntegration: NativeRenderableIntegration = {
    kind: "image",
    body: { native: this.prototype.renderSelf, buffered: true },
    bufferComposition: "native",
  }

  private _source: ImageRenderableSource | undefined
  private _image: NativeImage | null = null
  private _pendingImage: NativeImage | null = null
  private _loadError: unknown = null
  private _loadController: AbortController | null = null
  public onLoad?: (image: NativeImage) => void
  public onError?: (error: unknown) => void
  private _fit: ImageFit
  private _crop: ExtractOptions | undefined
  private _protocol: ImageRenderProtocol
  public loadPromise: Promise<void> | null = null

  constructor(ctx: RenderContext, options: ImageRenderableOptions) {
    super(ctx, options)
    try {
      this._fit = options.fit ?? "fit"
      this._protocol = options.protocol ?? "auto"
      this.onLoad = options.onLoad
      this.onError = options.onError
      this.setNativeSceneImage()
      if (options.source !== undefined) this.source = options.source
      this.crop = options.crop
    } catch (error) {
      this.abortConstruction(error, () => this.destroySelf())
    }
  }

  public get source(): ImageRenderableSource | undefined {
    return this._source
  }

  public set source(source: ImageRenderableSource | undefined) {
    source ??= undefined
    if (source === this._source) return
    if (source === undefined) this.setNativeSceneImage(null)
    this._source = source
    const previous = this._loadController
    previous?.abort()
    // Cancellation can synchronously replace the source or destroy this node.
    if (this.isDestroyed || this._loadController !== previous) return
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
      imagePromise = NativeImage.load(source, {
        signal: controller.signal,
        owner: this._ctx.nativeScene.resourceContext,
      })
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
    this.setNativeSceneImage(this._image, next)
    this._fit = next
    this.requestRender()
  }

  public get crop(): ExtractOptions | undefined {
    return this._crop && { ...this._crop }
  }

  /** A crop that is not whole pixels, or lies outside the loaded image, reports through onError and keeps the previous one. */
  public set crop(value: ExtractOptions | null | undefined) {
    if (sameCrop(this._crop, value ?? undefined) || this.isDestroyed) return
    // A loading source checks the crop when it loads, not against the outgoing image.
    const next = this.acceptCrop(value ?? undefined, this._loadController ? null : this._image)
    if (next === null) return
    this._ctx.nativeScene.setCrop(this, next)
    this._crop = next
    this.requestRender()
  }

  public get protocol(): ImageRenderProtocol {
    return this._protocol
  }

  public set protocol(value: ImageRenderProtocol | null | undefined) {
    const next = value ?? "auto"
    if (this._protocol === next) return
    this.setNativeSceneImage(this._image, this._fit, next)
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
    sourceWidth: number = this.region()?.width ?? 0,
    sourceHeight: number = this.region()?.height ?? 0,
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

  protected override createFrameBuffer(): void {
    const previous = this.frameBuffer
    super.createFrameBuffer()
    // Base construction can allocate before Image options are initialized.
    if (this._fit === undefined || this.frameBuffer === previous) return
    try {
      this.setNativeSceneImage()
    } catch (error) {
      const candidate = this.frameBuffer
      this.frameBuffer = previous
      try {
        candidate?.destroy()
      } catch {
        // Preserve the binding failure.
      }
      throw error
    }
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    // Paint geometry fits drawImage's cell range; public sizes are Yoga's.
    const width = this._paintWidth
    const height = this._paintHeight
    if (!this._image || width <= 0 || height <= 0) return
    const fitted = this._fit === "cover" ? { width, height } : this.getFittedSize(width, height)
    if (fitted.width <= 0 || fitted.height <= 0) return
    const originX = this.buffered ? 0 : this._screenX
    const originY = this.buffered ? 0 : this._screenY
    const x = originX + Math.floor((width - fitted.width) / 2)
    const y = originY + Math.floor((height - fitted.height) / 2)
    const resolution = pixelResolution(this._ctx)
    const pixelWidth = resolution
      ? Math.max(1, Math.round((fitted.width * resolution.width) / this._ctx.terminalWidth!))
      : 0
    const pixelHeight = resolution
      ? Math.max(1, Math.round((fitted.height * resolution.height) / this._ctx.terminalHeight!))
      : 0
    const region = this.region()!
    let { left: sourceX, top: sourceY, width: sourceWidth, height: sourceHeight } = region
    if (this._fit === "cover") {
      const targetAspect = width / (height * this.cellAspectRatio)
      const sourceAspect = sourceWidth / sourceHeight
      if (sourceAspect > targetAspect) {
        sourceWidth = Math.max(1, Math.round(sourceHeight * targetAspect))
        sourceX += Math.floor((region.width - sourceWidth) / 2)
      } else {
        sourceHeight = Math.max(1, Math.round(sourceWidth / targetAspect))
        sourceY += Math.floor((region.height - sourceHeight) / 2)
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
    let image: NativeImage | undefined
    try {
      image = await imagePromise
      if (this.isDestroyed || this._loadController !== controller) {
        image.dispose()
        return
      }
      if (this._pendingImage === image) this._pendingImage = null
      this.setNativeSceneImage(image)
    } catch (error) {
      try {
        image?.dispose()
      } catch {
        // Preserve the load or binding failure.
      }
      if (controller.signal.aborted || this.isDestroyed || this._loadController !== controller) return
      this._loadController = null
      this._loadError = error
      this.onError?.(error)
      return
    }

    const previous = this._image
    this._image = image
    this._loadController = null
    this.runCleanup((run) => {
      run(() => previous?.dispose())
      run(() => this.requestRender())
      run(() => this.acceptCrop(this._crop, image))
      run(() => this.onLoad?.(image))
    })
  }

  // The part of the image that shows: the crop when it lies inside the image, as native draws it.
  private region(): ExtractOptions | null {
    const image = this._image
    if (!image) return null
    const crop = this._crop
    if (crop && crop.left + crop.width <= image.width && crop.top + crop.height <= image.height) return crop
    return { left: 0, top: 0, width: image.width, height: image.height }
  }

  // Returns the checked copy, or null after reporting why the crop is invalid for the image.
  private acceptCrop(crop: ExtractOptions | undefined, image: NativeImage | null): ExtractOptions | undefined | null {
    try {
      return crop && checkCrop(crop, image?.width, image?.height)
    } catch (error) {
      // Frameworks may assign onError after crop.
      queueMicrotask(() => this.isDestroyed || this.onError?.(error))
      return null
    }
  }

  private setNativeSceneImage(
    image: NativeImage | null = this._image,
    fit: ImageFit = this._fit,
    protocol: ImageRenderProtocol = this._protocol,
  ): void {
    this._ctx.nativeScene.setImage(this, image, fit, protocol, this.buffered ? this.frameBuffer : null)
  }

  protected destroySelf(): void {
    const controller = this._loadController
    const pending = this._pendingImage
    const image = this._image
    this._loadController = null
    this._pendingImage = null
    this._image = null
    this.runCleanup((run) => {
      run(() => controller?.abort())
      run(() => pending?.dispose())
      run(() => image?.dispose())
      run(() => super.destroySelf())
    })
  }
}
