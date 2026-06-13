import { GPUCanvasContextMock } from "bun-webgpu"
import { RGBA, type OptimizedBuffer } from "@opentui/core"
import { SuperSampleType } from "./WGPURenderer.js"
import { Jimp } from "jimp"

// @ts-ignore
import shaderTemplate from "./shaders/supersampling.wgsl" with { type: "text" }

const WORKGROUP_SIZE = 4
const SUPERSAMPLING_COMPUTE_SHADER = shaderTemplate.replace(/\${WORKGROUP_SIZE}/g, WORKGROUP_SIZE.toString())

export enum SuperSampleAlgorithm {
  STANDARD = 0,
  PRE_SQUEEZED = 1,
}

export class CLICanvas {
  private device: GPUDevice
  private readbackBuffer: GPUBuffer | null = null
  private width: number
  private height: number
  private gpuCanvasContext: GPUCanvasContextMock

  public superSampleDrawTimeMs: number = 0
  public mapAsyncTimeMs: number = 0
  public superSample: SuperSampleType = SuperSampleType.GPU

  // Compute shader super sampling
  private computePipeline: GPUComputePipeline | null = null
  private computeBindGroupLayout: GPUBindGroupLayout | null = null
  private computeOutputBuffer: GPUBuffer | null = null
  private computeParamsBuffer: GPUBuffer | null = null
  private computeReadbackBuffer: GPUBuffer | null = null
  private updateScheduled: boolean = false
  private screenshotGPUBuffer: GPUBuffer | null = null
  private superSampleAlgorithm: SuperSampleAlgorithm = SuperSampleAlgorithm.STANDARD
  private destroyed: boolean = false

  constructor(
    device: GPUDevice,
    width: number,
    height: number,
    superSample: SuperSampleType,
    sampleAlgo: SuperSampleAlgorithm = SuperSampleAlgorithm.STANDARD,
  ) {
    this.device = device
    this.width = width
    this.height = height
    this.superSample = superSample
    this.gpuCanvasContext = new GPUCanvasContextMock(this as unknown as HTMLCanvasElement, width, height)
    this.superSampleAlgorithm = sampleAlgo
  }

  public destroy(): void {
    this.destroyed = true
  }

  public setSuperSampleAlgorithm(superSampleAlgorithm: SuperSampleAlgorithm): void {
    this.superSampleAlgorithm = superSampleAlgorithm
    this.scheduleUpdateComputeBuffers()
  }

  public getSuperSampleAlgorithm(): SuperSampleAlgorithm {
    return this.superSampleAlgorithm
  }

  getContext(type: string, attrs?: WebGLContextAttributes) {
    if (type === "webgpu") {
      this.updateReadbackBuffer(this.width, this.height)
      this.updateComputeBuffers(this.width, this.height)
      return this.gpuCanvasContext
    }
    throw new Error(`getContext not implemented: ${type}`)
  }

  setSize(width: number, height: number) {
    this.width = width
    this.height = height
    this.gpuCanvasContext.setSize(width, height)
    this.updateReadbackBuffer(width, height)
    this.scheduleUpdateComputeBuffers()
  }

  addEventListener(event: string, listener: any, options?: any) {
    console.error("addEventListener mockCanvas", event, listener, options)
  }

  removeEventListener(event: string, listener: any, options?: any) {
    console.error("removeEventListener mockCanvas", event, listener, options)
  }

  dispatchEvent(event: Event) {
    console.error("dispatchEvent mockCanvas", event)
  }

  public setSuperSample(superSample: SuperSampleType): void {
    this.superSample = superSample
  }

  public async saveToFile(filePath: string): Promise<void> {
    const bytesPerPixel = 4 // RGBA
    const unalignedBytesPerRow = this.width * bytesPerPixel
    const alignedBytesPerRow = Math.ceil(unalignedBytesPerRow / 256) * 256
    const textureBufferSize = alignedBytesPerRow * this.height

    if (!this.screenshotGPUBuffer || this.screenshotGPUBuffer.size !== textureBufferSize) {
      if (this.screenshotGPUBuffer) {
        this.screenshotGPUBuffer.destroy()
      }
      this.screenshotGPUBuffer = this.device.createBuffer({
        label: "Screenshot GPU Buffer",
        size: textureBufferSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
    }

    const texture = this.gpuCanvasContext.getCurrentTexture()

    const commandEncoder = this.device.createCommandEncoder({ label: "Screenshot Command Encoder" })
    commandEncoder.copyTextureToBuffer(
      { texture: texture },
      { buffer: this.screenshotGPUBuffer, bytesPerRow: alignedBytesPerRow, rowsPerImage: this.height },
      { width: this.width, height: this.height },
    )
    const commandBuffer = commandEncoder.finish()
    this.device.queue.submit([commandBuffer])

    await this.screenshotGPUBuffer.mapAsync(GPUMapMode.READ)

    const resultBuffer = this.screenshotGPUBuffer.getMappedRange()
    const pixelData = new Uint8Array(resultBuffer)
    const contextFormat = texture.format
    const isBGRA = contextFormat === "bgra8unorm"

    // Handle row padding - extract only the actual image data
    const imageData = new Uint8Array(this.width * this.height * 4)
    for (let y = 0; y < this.height; y++) {
      const srcOffset = y * alignedBytesPerRow
      const dstOffset = y * this.width * 4

      if (isBGRA) {
        for (let x = 0; x < this.width; x++) {
          const srcPixelOffset = srcOffset + x * 4
          const dstPixelOffset = dstOffset + x * 4

          imageData[dstPixelOffset] = pixelData[srcPixelOffset + 2]
          imageData[dstPixelOffset + 1] = pixelData[srcPixelOffset + 1]
          imageData[dstPixelOffset + 2] = pixelData[srcPixelOffset]
          imageData[dstPixelOffset + 3] = pixelData[srcPixelOffset + 3]
        }
      } else {
        imageData.set(pixelData.subarray(srcOffset, srcOffset + this.width * 4), dstOffset)
      }
    }

    const image = new Jimp({
      data: Buffer.from(imageData),
      width: this.width,
      height: this.height,
    })

    await image.write(filePath as `${string}.${string}`)
    this.screenshotGPUBuffer.unmap()
  }

  private async initComputePipeline(): Promise<void> {
    if (this.computePipeline) return

    const shaderModule = this.device.createShaderModule({
      label: "SuperSampling Compute Shader",
      code: SUPERSAMPLING_COMPUTE_SHADER,
    })

    this.computeBindGroupLayout = this.device.createBindGroupLayout({
      label: "SuperSampling Bind Group Layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float", viewDimension: "2d" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
      ],
    })

    const pipelineLayout = this.device.createPipelineLayout({
      label: "SuperSampling Pipeline Layout",
      bindGroupLayouts: [this.computeBindGroupLayout],
    })

    this.computePipeline = this.device.createComputePipeline({
      label: "SuperSampling Compute Pipeline",
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint: "main",
      },
    })

    // Create uniform buffer for parameters (8 bytes - 2 u32s: width, height)
    this.computeParamsBuffer = this.device.createBuffer({
      label: "SuperSampling Params Buffer",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.updateComputeParams()
  }

  private updateComputeParams(): void {
    if (!this.computeParamsBuffer || this.superSample === SuperSampleType.NONE) return

    // Update uniform buffer with parameters
    // Note: this.width/height are render dimensions (2x terminal size for super sampling)
    const paramsData = new ArrayBuffer(16)
    const uint32View = new Uint32Array(paramsData)

    uint32View[0] = this.width
    uint32View[1] = this.height
    uint32View[2] = this.superSampleAlgorithm

    this.device.queue.writeBuffer(this.computeParamsBuffer, 0, paramsData)
  }

  private scheduleUpdateComputeBuffers(): void {
    this.updateScheduled = true
  }

  private updateComputeBuffers(width: number, height: number): void {
    if (this.superSample === SuperSampleType.NONE) return
    this.updateComputeParams()

    // Calculate output buffer size (48 bytes per cell: 2 vec4f + u32 + 3 padding u32s)
    // Must match WGSL calculation exactly: (params.width + 1u) / 2u
    const cellBytesSize = 48 // 16 + 16 + 4 + 4 + 4 + 4 bytes (16-byte aligned)
    const terminalWidthCells = Math.floor((width + 1) / 2)
    const terminalHeightCells = Math.floor((height + 1) / 2)
    const outputBufferSize = terminalWidthCells * terminalHeightCells * cellBytesSize

    const oldOutputBuffer = this.computeOutputBuffer
    const oldReadbackBuffer = this.computeReadbackBuffer

    if (oldOutputBuffer) {
      oldOutputBuffer.destroy()
    }
    if (oldReadbackBuffer) {
      oldReadbackBuffer.destroy()
    }

    // Create new buffers
    this.computeOutputBuffer = this.device.createBuffer({
      label: "SuperSampling Output Buffer",
      size: outputBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })

    this.computeReadbackBuffer = this.device.createBuffer({
      label: "SuperSampling Readback Buffer",
      size: outputBufferSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
  }

  private async runComputeShaderSuperSampling(texture: GPUTexture, buffer: OptimizedBuffer): Promise<void> {
    if (this.destroyed) {
      return
    }

    if (this.updateScheduled) {
      this.updateScheduled = false
      await this.device.queue.onSubmittedWorkDone()
      this.updateComputeBuffers(this.width, this.height)
    }

    await this.initComputePipeline()

    if (
      !this.computePipeline ||
      !this.computeBindGroupLayout ||
      !this.computeOutputBuffer ||
      !this.computeParamsBuffer
    ) {
      throw new Error("Compute pipeline not initialized")
    }

    const mapAsyncStart = performance.now()
    const textureView = texture.createView({
      label: "SuperSampling Input Texture View",
    })

    const bindGroup = this.device.createBindGroup({
      label: "SuperSampling Bind Group",
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: textureView },
        { binding: 1, resource: { buffer: this.computeOutputBuffer } },
        { binding: 2, resource: { buffer: this.computeParamsBuffer } },
      ],
    })

    const commandEncoder = this.device.createCommandEncoder({ label: "SuperSampling Command Encoder" })
    const computePass = commandEncoder.beginComputePass({ label: "SuperSampling Compute Pass" })
    computePass.setPipeline(this.computePipeline)
    computePass.setBindGroup(0, bindGroup)

    // Must match WGSL calculation exactly: (params.width + 1u) / 2u
    const terminalWidthCells = Math.floor((this.width + 1) / 2)
    const terminalHeightCells = Math.floor((this.height + 1) / 2)
    const dispatchX = Math.ceil(terminalWidthCells / WORKGROUP_SIZE)
    const dispatchY = Math.ceil(terminalHeightCells / WORKGROUP_SIZE)

    computePass.dispatchWorkgroups(dispatchX, dispatchY, 1)
    computePass.end()

    commandEncoder.copyBufferToBuffer(
      this.computeOutputBuffer,
      0,
      this.computeReadbackBuffer!,
      0,
      this.computeOutputBuffer.size,
    )

    const commandBuffer = commandEncoder.finish()
    this.device.queue.submit([commandBuffer])

    await this.computeReadbackBuffer!.mapAsync(GPUMapMode.READ)

    if (this.destroyed) {
      this.computeReadbackBuffer!.unmap()
      return
    }

    const resultsPtr = this.computeReadbackBuffer!.getMappedRangePtr()
    const size = this.computeReadbackBuffer!.size

    this.mapAsyncTimeMs = performance.now() - mapAsyncStart

    const ssStart = performance.now()
    buffer.drawPackedBuffer(resultsPtr, size, 0, 0, terminalWidthCells, terminalHeightCells)
    this.superSampleDrawTimeMs = performance.now() - ssStart

    this.computeReadbackBuffer!.unmap()
  }

  private updateReadbackBuffer(renderWidth: number, renderHeight: number): void {
    if (this.readbackBuffer) {
      this.readbackBuffer.destroy()
    }
    const bytesPerPixel = 4 // Assuming RGBA8 or BGRA8
    const unalignedBytesPerRow = renderWidth * bytesPerPixel
    const alignedBytesPerRow = Math.ceil(unalignedBytesPerRow / 256) * 256
    const textureBufferSize = alignedBytesPerRow * renderHeight
    this.readbackBuffer = this.device!.createBuffer({
      label: "Readback Buffer",
      size: textureBufferSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
  }

  async readPixelsIntoBuffer(buffer: OptimizedBuffer): Promise<void> {
    if (this.destroyed) {
      return
    }

    const texture = this.gpuCanvasContext.getCurrentTexture()
    this.gpuCanvasContext.switchTextures()

    if (this.superSample === SuperSampleType.GPU) {
      await this.runComputeShaderSuperSampling(texture, buffer)
      return
    }

    const textureBuffer = this.readbackBuffer
    if (!textureBuffer) {
      throw new Error("Readback buffer not found")
    }

    try {
      const bytesPerPixel = 4 // Assuming RGBA8 or BGRA8
      const unalignedBytesPerRow = this.width * bytesPerPixel
      const alignedBytesPerRow = Math.ceil(unalignedBytesPerRow / 256) * 256
      const contextFormat = texture.format

      const commandEncoder = this.device.createCommandEncoder({ label: "Readback Command Encoder" })
      commandEncoder.copyTextureToBuffer(
        { texture: texture },
        { buffer: textureBuffer, bytesPerRow: alignedBytesPerRow, rowsPerImage: this.height },
        {
          width: this.width,
          height: this.height,
        },
      )
      const commandBuffer = commandEncoder.finish()
      this.device.queue.submit([commandBuffer])

      const mapStart = performance.now()
      await textureBuffer.mapAsync(GPUMapMode.READ, 0, textureBuffer.size)
      this.mapAsyncTimeMs = performance.now() - mapStart

      if (this.destroyed) {
        textureBuffer.unmap()
        return
      }

      const mappedRangePtr = textureBuffer.getMappedRangePtr(0, textureBuffer.size)
      const bufPtr = mappedRangePtr

      if (this.superSample === SuperSampleType.CPU) {
        const format = contextFormat === "bgra8unorm" ? "bgra8unorm" : "rgba8unorm"
        const ssStart = performance.now()
        buffer.drawSuperSampleBuffer(0, 0, bufPtr, textureBuffer.size, format, alignedBytesPerRow)
        this.superSampleDrawTimeMs = performance.now() - ssStart
      } else {
        this.superSampleDrawTimeMs = 0
        const pixelData = new Uint8Array(textureBuffer.getMappedRange())
        const isBGRA = contextFormat === "bgra8unorm"
        const backgroundColor = RGBA.fromValues(0, 0, 0, 1)

        for (let y = 0; y < this.height; y++) {
          for (let x = 0; x < this.width; x++) {
            const pixelIndexInPaddedRow = y * alignedBytesPerRow + x * bytesPerPixel

            if (pixelIndexInPaddedRow + 3 >= pixelData.length) continue

            let rByte, gByte, bByte // Alpha currently ignored

            if (isBGRA) {
              bByte = pixelData[pixelIndexInPaddedRow]
              gByte = pixelData[pixelIndexInPaddedRow + 1]
              rByte = pixelData[pixelIndexInPaddedRow + 2]
            } else {
              // Assume RGBA
              rByte = pixelData[pixelIndexInPaddedRow]
              gByte = pixelData[pixelIndexInPaddedRow + 1]
              bByte = pixelData[pixelIndexInPaddedRow + 2]
            }

            // Convert to [0-1] range for RGB class
            const r = rByte / 255.0
            const g = gByte / 255.0
            const b = bByte / 255.0

            const cellColor = RGBA.fromValues(r, g, b, 1.0)

            buffer.setCellWithAlphaBlending(x, y, "█", cellColor, backgroundColor)
          }
        }
      }
    } finally {
      textureBuffer.unmap()
    }
  }
}
