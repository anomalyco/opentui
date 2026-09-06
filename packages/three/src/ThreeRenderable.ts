import { OrthographicCamera, PerspectiveCamera, Scene } from "three"

import {
  RGBA,
  Renderable,
  type CliRenderer,
  type OptimizedBuffer,
  type RenderableOptions,
  type RenderContext,
} from "@opentui/core"
import { ThreeCliRenderer, type ThreeCliRendererOptions } from "./WGPURenderer.js"

export interface ThreeRenderableOptions extends RenderableOptions<ThreeRenderable> {
  scene?: Scene | null
  camera?: PerspectiveCamera | OrthographicCamera
  renderer?: Omit<ThreeCliRendererOptions, "width" | "height" | "autoResize">
  autoAspect?: boolean
}

export class ThreeRenderable extends Renderable {
  private engine: ThreeCliRenderer
  private scene: Scene | null
  private autoAspect: boolean
  private initPromise: Promise<boolean> | null = null
  private initFailed: boolean = false
  private drawInFlight: boolean = false
  private frameCallback: ((deltaTime: number) => Promise<void>) | null = null
  private frameCallbackRegistered: boolean = false
  private cliRenderer: CliRenderer
  private clearColor: RGBA

  constructor(ctx: RenderContext, options: ThreeRenderableOptions) {
    const { scene = null, camera, renderer, autoAspect = true, ...renderableOptions } = options
    const clearColor = renderer?.backgroundColor ? RGBA.clone(renderer.backgroundColor) : RGBA.fromValues(0, 0, 0, 1)
    super(ctx, { ...renderableOptions, buffered: true, live: options.live ?? true })

    const cliRenderer = ctx as CliRenderer
    if (typeof cliRenderer.setFrameCallback !== "function" || typeof cliRenderer.removeFrameCallback !== "function") {
      throw new Error("ThreeRenderable requires a CliRenderer context")
    }

    this.cliRenderer = cliRenderer
    this.scene = scene
    this.autoAspect = autoAspect
    this.clearColor = clearColor

    const { width, height } = this.getRenderSize()
    this.engine = new ThreeCliRenderer(cliRenderer, {
      width,
      height,
      autoResize: false,
      ...renderer,
      backgroundColor: this.clearColor,
    })

    if (camera) {
      this.engine.setActiveCamera(camera)
    }
    this.updateCameraAspect(width, height)

    this.registerFrameCallback()
  }

  public get aspectRatio(): number {
    return this.getAspectRatio(this.width, this.height)
  }

  public get renderer(): ThreeCliRenderer {
    return this.engine
  }

  public getScene(): Scene | null {
    return this.scene
  }

  public setScene(scene: Scene | null): void {
    this.scene = scene
    this.requestRender()
  }

  public getActiveCamera(): PerspectiveCamera | OrthographicCamera {
    return this.engine.getActiveCamera()
  }

  public setActiveCamera(camera: PerspectiveCamera | OrthographicCamera): void {
    this.engine.setActiveCamera(camera)
    this.updateCameraAspect(this.width, this.height)
    this.requestRender()
  }

  public setAutoAspect(autoAspect: boolean): void {
    if (this.autoAspect === autoAspect) return
    this.autoAspect = autoAspect
    if (autoAspect) {
      this.updateCameraAspect(this.width, this.height)
    }
  }

  protected onResize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.engine.setSize(width, height, true)
      this.updateCameraAspect(width, height)
    }
    super.onResize(width, height)
  }

  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    if (!this.visible || this.isDestroyed) return
    if (this.frameCallbackRegistered) return
    if (this.buffered && !this.frameBuffer) return
    void this.renderToBuffer(buffer, deltaTime / 1000)
  }

  protected destroySelf(): void {
    if (this.frameCallback && this.frameCallbackRegistered) {
      this.cliRenderer.removeFrameCallback(this.frameCallback)
      this.frameCallbackRegistered = false
      this.frameCallback = null
    }

    this.engine.destroy()
    super.destroySelf()
  }

  private registerFrameCallback(): void {
    if (this.frameCallbackRegistered) return

    this.frameCallback = async (deltaTime: number) => {
      if (this.isDestroyed || !this.visible || !this.parent) return
      if (!this.scene || !this.frameBuffer) return
      await this.renderToBuffer(this.frameBuffer, deltaTime / 1000)
    }

    this.cliRenderer.setFrameCallback(this.frameCallback)
    this.frameCallbackRegistered = true
  }

  private async renderToBuffer(buffer: OptimizedBuffer, deltaTime: number): Promise<void> {
    if (!this.scene || this.isDestroyed || this.drawInFlight) return

    this.drawInFlight = true
    try {
      const initialized = await this.ensureInitialized()
      if (!initialized || !this.scene) return

      if (buffer === this.frameBuffer) {
        buffer.clear(this.clearColor)
      }

      await this.engine.drawScene(this.scene, buffer, deltaTime)
    } finally {
      this.drawInFlight = false
    }
  }

  private async ensureInitialized(): Promise<boolean> {
    if (this.initFailed) return false
    if (!this.initPromise) {
      this.initPromise = this.engine
        .init()
        .then(() => true)
        .catch((error) => {
          this.initFailed = true
          console.error("ThreeRenderable init failed:", error)
          return false
        })
    }
    return this.initPromise
  }

  private updateCameraAspect(width: number, height: number): void {
    if (!this.autoAspect || width <= 0 || height <= 0) return

    const camera = this.engine.getActiveCamera()
    if (camera instanceof PerspectiveCamera) {
      camera.aspect = this.getAspectRatio(width, height)
      camera.updateProjectionMatrix()
    }
  }

  private getAspectRatio(width: number, height: number): number {
    if (width <= 0 || height <= 0) return 1

    const resolution = this.cliRenderer.resolution
    if (resolution && this.cliRenderer.terminalWidth > 0 && this.cliRenderer.terminalHeight > 0) {
      const cellWidth = resolution.width / this.cliRenderer.terminalWidth
      const cellHeight = resolution.height / this.cliRenderer.terminalHeight
      if (cellHeight > 0) {
        return (width * cellWidth) / (height * cellHeight)
      }
    }

    return width / (height * 2)
  }

  private getRenderSize(): { width: number; height: number } {
    return {
      width: Math.max(1, this.width),
      height: Math.max(1, this.height),
    }
  }
}
