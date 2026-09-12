import { expect, test } from "bun:test"
import { setupGlobals } from "bun-webgpu"
import { OptimizedBuffer } from "@opentui/core"
import { CLICanvas } from "./canvas.js"
import { SuperSampleType } from "./WGPURenderer.js"

for (const format of ["rgba8unorm", "bgra8unorm"] as const) {
  test.skipIf(process.env.GPU_TESTS !== "1")(`NONE readback preserves padded ${format} frames`, async () => {
    await setupGlobals()
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error("GPU test requires a WebGPU adapter")
    const device = await adapter.requestDevice()
    const canvas = new CLICanvas(device, 65, 3, SuperSampleType.NONE)
    const context = canvas.getContext("webgpu")
    const output = OptimizedBuffer.create(65, 3, "unicode", { id: "none-readback-test" })
    try {
      context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
      for (const color of [
        { r: 1, g: 0, b: 0, a: 1 },
        { r: 0, g: 0, b: 1, a: 1 },
      ]) {
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              clearValue: color,
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        })
        pass.end()
        device.queue.submit([encoder.finish()])
        await canvas.readPixelsIntoBuffer(output)
        for (const index of [0, 64, 65, 194]) {
          expect(output.buffers.char[index]).toBe(0x2588)
          expect([...output.buffers.fg.slice(index * 4, index * 4 + 4)]).toEqual([color.r * 255, 0, color.b * 255, 255])
        }
      }
    } finally {
      output.destroy()
      canvas.destroy()
      context.unconfigure()
      device.destroy()
    }
  })
}
