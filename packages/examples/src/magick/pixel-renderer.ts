import { globalConstructors, GPUCanvasContextMock, setupGlobals } from "bun-webgpu"
import { NoToneMapping, SRGBColorSpace, type Camera, type Scene } from "three"
import { WebGPURenderer } from "three/webgpu"
import { managePixelGpu } from "./gpu-lifetime.js"

export interface PixelFrame {
  data: Uint8Array
  width: number
  height: number
  stride: number
  format: "rgba8" | "bgra8"
}

export async function createPixelRenderer(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 3840 * 2160
  ) {
    throw new RangeError("Framebuffer must be positive integers and at most 3840 * 2160 pixels")
  }
  globalThis.requestAnimationFrame ??= (callback) =>
    Number(setTimeout(() => callback(performance.now()), 1000 / 60).unref())
  globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)
  await setupGlobals()
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  if (!adapter) throw new Error("No WebGPU adapter")
  const device = await adapter.requestDevice()
  const canvas = { width, height, getContext: () => context, addEventListener() {}, removeEventListener() {} }
  const context = new GPUCanvasContextMock(canvas as unknown as HTMLCanvasElement, width, height)
  const stride = Math.ceil((width * 4) / 256) * 256
  let renderer: WebGPURenderer | undefined
  let lifetime: ReturnType<typeof managePixelGpu> | undefined
  let readback: GPUBuffer | undefined

  function cleanup() {
    if (renderer) renderer.onDeviceLost = () => {}
    try {
      readback?.destroy()
    } finally {
      try {
        renderer?.dispose()
      } finally {
        try {
          lifetime?.dispose()
        } finally {
          try {
            context.unconfigure()
          } finally {
            device.destroy()
          }
        }
      }
    }
  }

  try {
    if (!(device instanceof globalConstructors.GPUDevice)) throw new Error("Pixel adapter requires bun-webgpu 0.1.7")
    lifetime = managePixelGpu(device, context)
    renderer = new WebGPURenderer({
      canvas: canvas as unknown as HTMLCanvasElement,
      device,
      alpha: false,
      antialias: false,
    })
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = NoToneMapping
    renderer.setSize(width, height, false)
    await renderer.init()
    readback = device.createBuffer({ size: stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  } catch (error) {
    try {
      cleanup()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Pixel renderer initialization and cleanup failed")
    }
    throw error
  }
  let busy = false
  let destroyed = false
  let animationActive = true
  const animation = (renderer as unknown as { _animation: { start(): void; stop(): void } })._animation
  return {
    adapter: adapter.info,
    ownership: () => lifetime!.snapshot(),
    setAnimationActive(active: boolean) {
      if (destroyed) throw new Error("Pixel renderer is disposed")
      if (active === animationActive) return
      // Three 0.177.0 runs an internal RAF even without a user animation loop.
      if (active) animation.start()
      else animation.stop()
      animationActive = active
    },
    async draw<T>(scene: Scene, camera: Camera, consume: (frame: PixelFrame) => T): Promise<T> {
      if (busy || destroyed) throw new Error("Pixel renderer is busy or disposed")
      busy = true
      try {
        renderer!.render(scene, camera)
        const texture = context.getCurrentTexture()
        const encoder = device.createCommandEncoder()
        encoder.copyTextureToBuffer(
          { texture },
          { buffer: readback!, bytesPerRow: stride, rowsPerImage: height },
          { width, height },
        )
        device.queue.submit([encoder.finish()])
        await readback!.mapAsync(GPUMapMode.READ)
        try {
          // The consumer is synchronous: it cannot retain this view past unmap.
          return consume({
            data: new Uint8Array(readback!.getMappedRange()),
            width,
            height,
            stride,
            format: texture.format === "bgra8unorm" ? "bgra8" : "rgba8",
          })
        } finally {
          readback!.unmap()
        }
      } finally {
        try {
          lifetime!.discardPending()
        } finally {
          busy = false
        }
      }
    },
    dispose() {
      if (busy) throw new Error("Cannot dispose a pending readback")
      if (destroyed) return
      destroyed = true
      cleanup()
    },
  }
}
