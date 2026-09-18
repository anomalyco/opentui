import { PerspectiveCamera, OrthographicCamera, Color, NoToneMapping, LinearSRGBColorSpace, Scene } from "three"
import { WebGPURenderer } from "three/webgpu"
import { createWebGPUDevice, setupGlobals } from "bun-webgpu"
import { CliRenderEvents, RGBA, type CliRenderer, type OptimizedBuffer } from "@opentui/core"
import { CLICanvas, SuperSampleAlgorithm } from "./canvas.js"

export enum SuperSampleType {
  NONE = "none",
  GPU = "gpu",
  CPU = "cpu",
}

export interface ThreeCliRendererOptions {
  width: number
  height: number
  focalLength?: number
  backgroundColor?: RGBA
  superSample?: SuperSampleType
  alpha?: boolean
  autoResize?: boolean
  libPath?: string
}

export class ThreeCliRenderer {
  private outputWidth: number
  private outputHeight: number
  private renderWidth: number
  private renderHeight: number
  private superSample: SuperSampleType
  private backgroundColor: RGBA = RGBA.fromValues(0, 0, 0, 1)
  private alpha: boolean = false
  private threeRenderer?: WebGPURenderer
  private canvas?: CLICanvas
  private device: GPUDevice | null = null

  private activeCamera: PerspectiveCamera | OrthographicCamera
  private _aspectRatio: number | null = null
  private doRenderStats: boolean = false

  private resizeHandler: (width: number, height: number) => void
  private debugToggleHandler: (enabled: boolean) => void
  private destroyHandler: () => void

  // Stats tracking
  private renderTimeMs: number = 0
  private readbackTimeMs: number = 0
  private totalDrawTimeMs: number = 0

  private renderMethod: (
    root: Scene,
    camera: PerspectiveCamera | OrthographicCamera,
    buffer: OptimizedBuffer,
    deltaTime: number,
  ) => Promise<void> = () => Promise.resolve()

  public get aspectRatio(): number {
    if (this._aspectRatio) return this._aspectRatio
    if (this.cliRenderer.resolution) {
      const pixelAspectRatio = this.cliRenderer.resolution.width / this.cliRenderer.resolution.height
      return pixelAspectRatio
    }
    const terminalWidth = process.stdout.columns
    const terminalHeight = process.stdout.rows
    return terminalWidth / (terminalHeight * 2)
  }

  constructor(
    private readonly cliRenderer: CliRenderer,
    options: ThreeCliRendererOptions,
  ) {
    this.outputWidth = options.width
    this.outputHeight = options.height
    this.superSample = options.superSample ?? SuperSampleType.GPU

    this.renderWidth = this.outputWidth * (this.superSample !== SuperSampleType.NONE ? 2 : 1)
    this.renderHeight = this.outputHeight * (this.superSample !== SuperSampleType.NONE ? 2 : 1)

    this.backgroundColor = options.backgroundColor ?? RGBA.fromValues(0, 0, 0, 1)
    this.alpha = options.alpha ?? false

    if (process.env.CELL_ASPECT_RATIO) {
      this._aspectRatio = parseFloat(process.env.CELL_ASPECT_RATIO)
    }

    // Create a default active camera
    const fov = options.focalLength ? 2 * Math.atan(this.outputHeight / (2 * options.focalLength)) * (180 / Math.PI) : 1 // Default FOV if focal length not provided
    this.activeCamera = new PerspectiveCamera(
      fov,
      this.aspectRatio,
      0.1, // near plane
      1000, // far plane
    )
    this.activeCamera.position.set(0, 0, 3)
    this.activeCamera.up.set(0, 1, 0)
    this.activeCamera.lookAt(0, 0, 0)
    this.activeCamera.updateMatrixWorld()

    this.resizeHandler = (width: number, height: number) => {
      this.setSize(width, height, true)
    }

    this.debugToggleHandler = (enabled: boolean) => {
      this.doRenderStats = enabled
    }

    this.destroyHandler = () => {
      this.destroy()
    }

    if (options.autoResize !== false) {
      this.cliRenderer.on("resize", this.resizeHandler)
    }

    this.cliRenderer.on(CliRenderEvents.DEBUG_OVERLAY_TOGGLE, this.debugToggleHandler)
    this.cliRenderer.on(CliRenderEvents.DESTROY, this.destroyHandler)

    setupGlobals({ libPath: options.libPath })
  }

  public toggleDebugStats(): void {
    this.doRenderStats = !this.doRenderStats
  }

  async init(): Promise<void> {
    this.device = await createWebGPUDevice()
    this.canvas = new CLICanvas(this.device, this.renderWidth, this.renderHeight, this.superSample)

    try {
      this.threeRenderer = new WebGPURenderer({
        canvas: this.canvas as unknown as HTMLCanvasElement,
        device: this.device,
        alpha: this.alpha,
      })

      // Three 0.177 creates and starts _animation inside init(), with no public context option.
      // Bind on assignment before start(), then restore the ordinary instance property.
      const cliRenderer = this.cliRenderer
      Object.defineProperty(this.threeRenderer, "_animation", {
        configurable: true,
        get: () => null,
        set(animation: NonNullable<WebGPURenderer["_animation"]>) {
          animation.setContext(cliRenderer)
          Object.defineProperty(this, "_animation", { value: animation, writable: true, configurable: true })
        },
      })

      this.setBackgroundColor(this.backgroundColor)

      this.threeRenderer.toneMapping = NoToneMapping
      this.threeRenderer.outputColorSpace = LinearSRGBColorSpace

      this.threeRenderer.setSize(this.renderWidth, this.renderHeight, false)
    } catch (error) {
      console.error("Error creating THREE.WebGPURenderer:", error)
      throw error
    }

    await this.threeRenderer.init().then(() => {
      this.renderMethod = this.doDrawScene.bind(this)
    })
  }

  public getSuperSampleAlgorithm(): SuperSampleAlgorithm {
    return this.canvas!.getSuperSampleAlgorithm()
  }

  public setSuperSampleAlgorithm(superSampleAlgorithm: SuperSampleAlgorithm): void {
    this.canvas!.setSuperSampleAlgorithm(superSampleAlgorithm)
  }

  public saveToFile(filePath: string): Promise<void> {
    return this.canvas!.saveToFile(filePath)
  }

  setActiveCamera(camera: PerspectiveCamera | OrthographicCamera): void {
    this.activeCamera = camera
  }

  getActiveCamera(): PerspectiveCamera | OrthographicCamera {
    return this.activeCamera
  }

  public setBackgroundColor(color: RGBA): void {
    this.backgroundColor = color
    const clearColor = new Color(this.backgroundColor.r, this.backgroundColor.g, this.backgroundColor.b)
    const clearAlpha = this.alpha ? this.backgroundColor.a : 1.0
    this.threeRenderer!.setClearColor(clearColor, clearAlpha)
  }

  setSize(width: number, height: number, forceUpdate: boolean = false): void {
    // Check against OUTPUT dimensions
    if (!forceUpdate && this.outputWidth === width && this.outputHeight === height) return

    this.outputWidth = width
    this.outputHeight = height

    this.renderWidth = this.outputWidth * (this.superSample !== SuperSampleType.NONE ? 2 : 1)
    this.renderHeight = this.outputHeight * (this.superSample !== SuperSampleType.NONE ? 2 : 1)

    this.canvas?.setSize(this.renderWidth, this.renderHeight)

    this.threeRenderer?.setSize(this.renderWidth, this.renderHeight, false)
    this.threeRenderer?.setViewport(0, 0, this.renderWidth, this.renderHeight)

    if (this.activeCamera instanceof PerspectiveCamera) {
      this.activeCamera.aspect = this.aspectRatio
    }
    this.activeCamera.updateProjectionMatrix()
  }

  public async drawScene(root: Scene, buffer: OptimizedBuffer, deltaTime: number): Promise<void> {
    await this.renderMethod(root, this.activeCamera, buffer, deltaTime)

    if (!this.destroyed && this.doRenderStats) {
      this.renderStats(buffer)
    }
  }

  private rendering: boolean = false
  private destroyed: boolean = false
  async doDrawScene(
    root: Scene,
    camera: PerspectiveCamera | OrthographicCamera,
    buffer: OptimizedBuffer,
    deltaTime: number,
  ): Promise<void> {
    if (this.rendering) {
      console.warn("ThreeCliRenderer.drawScene was called concurrently, which is not supported.")
      return
    }
    if (this.destroyed) {
      return
    }
    try {
      this.rendering = true

      const totalStart = performance.now()
      const renderStart = performance.now()
      await this.threeRenderer!.render(root, camera)
      if (this.destroyed) return
      this.renderTimeMs = performance.now() - renderStart

      const readbackStart = performance.now()
      await this.canvas!.readPixelsIntoBuffer(buffer)
      this.readbackTimeMs = performance.now() - readbackStart

      this.totalDrawTimeMs = performance.now() - totalStart
    } finally {
      this.rendering = false
    }
  }

  public toggleSuperSampling(): void {
    if (this.superSample === SuperSampleType.NONE) {
      this.superSample = SuperSampleType.CPU
    } else if (this.superSample === SuperSampleType.CPU) {
      this.superSample = SuperSampleType.GPU
    } else {
      this.superSample = SuperSampleType.NONE
    }
    this.canvas!.setSuperSample(this.superSample)
    this.setSize(this.outputWidth, this.outputHeight, true)
  }

  public renderStats(buffer: OptimizedBuffer): void {
    const stats = [
      `WebGPU Renderer Stats:`,
      ` Render: ${this.renderTimeMs.toFixed(2)}ms`,
      ` Readback: ${this.readbackTimeMs.toFixed(2)}ms`,
      `  ├ MapAsync: ${this.canvas!.mapAsyncTimeMs.toFixed(2)}ms`,
      `  └ SS Draw: ${this.canvas!.superSampleDrawTimeMs.toFixed(2)}ms`,
      ` Total Draw: ${this.totalDrawTimeMs.toFixed(2)}ms`,
      ` SuperSample: ${this.superSample}`,
      ` SuperSample Algorithm: ${this.getSuperSampleAlgorithm()}`,
    ]
    const startY = 4
    const startX = 2
    const fg = RGBA.fromValues(0.9, 0.9, 0.9, 1.0)
    const bg = RGBA.fromValues(0.1, 0.1, 0.1, 1.0)

    stats.forEach((line, index) => {
      buffer.drawText(line, startX + 1, startY + index, fg, bg)
    })
  }

  public destroy(): void {
    this.destroyed = true

    this.cliRenderer.off("resize", this.resizeHandler)
    this.cliRenderer.off(CliRenderEvents.DEBUG_OVERLAY_TOGGLE, this.debugToggleHandler)
    this.cliRenderer.off(CliRenderEvents.DESTROY, this.destroyHandler)

    if (this.canvas) {
      this.canvas.destroy()
    }

    if (this.threeRenderer) {
      this.threeRenderer.dispose()
      this.threeRenderer = undefined
    }

    this.canvas = undefined
    this.device = null
    this.renderMethod = () => Promise.resolve()
  }
}
