import { type RenderableOptions, Renderable } from "../Renderable.js"
import { OptimizedBuffer } from "../buffer.js"
import type { RenderContext } from "../types.js"

export interface FrameBufferOptions extends RenderableOptions<FrameBufferRenderable> {
  width: number
  height: number
  respectAlpha?: boolean
}

export class FrameBufferRenderable extends Renderable {
  declare public frameBuffer: OptimizedBuffer
  protected respectAlpha: boolean

  constructor(ctx: RenderContext, options: FrameBufferOptions) {
    super(ctx, options)
    try {
      this.respectAlpha = options.respectAlpha || false
      this.frameBuffer?.destroy()
      this.frameBuffer = OptimizedBuffer.create(options.width, options.height, this._ctx.widthMethod, {
        respectAlpha: this.respectAlpha,
        id: options.id || `framebufferrenderable-${this.id}`,
        owner: ctx.nativeScene,
      })
      this._refreshNativeSceneSurface()
    } catch (error) {
      this.abortConstruction(error)
    }
  }

  /** @internal Native class fields can replace the accessor after this constructor returns. */
  _refreshNativeSceneSurface(): void {
    if (this.respectAlpha === undefined || Object.getOwnPropertyDescriptor(this, "frameBuffer")?.get) return
    let surface: OptimizedBuffer | null = this.frameBuffer
    this._ctx.nativeScene.setSurface(this, surface)
    Object.defineProperty(this, "frameBuffer", {
      enumerable: true,
      configurable: true,
      get: () => surface,
      set: (value: OptimizedBuffer | null) => {
        if (this.isDestroyed) {
          if (value !== null) throw new Error(`FrameBufferRenderable ${this.id} is destroyed`)
          surface = null
          return
        }
        if (value === surface) return
        this._ctx.nativeScene.setSurface(this, value)
        // Replaced wrappers remain caller-owned; the scene releases only its retained reference.
        surface = value
        this.requestRender()
      },
    })
  }

  protected onResize(width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      throw new Error(`Invalid resize dimensions for FrameBufferRenderable ${this.id}: ${width}x${height}`)
    }

    this.frameBuffer.resize(width, height)
    super.onResize(width, height)
    this.requestRender()
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible || this.isDestroyed) return
    buffer.drawFrameBuffer(Math.trunc(this._screenX), Math.trunc(this._screenY), this.frameBuffer)
  }
}
