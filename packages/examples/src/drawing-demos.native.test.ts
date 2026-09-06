import { expect, spyOn, test } from "bun:test"
import { CliRenderEvents, FrameBufferRenderable, type CliRendererErrorEvent } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"

test.skipIf(process.env.OTUI_TEST_WEBGPU !== "1")(
  "Fractal retains real GPU pixels in its first resized frame",
  async () => {
    const fractal = await import("./fractal-shader-demo.js")
    const target = await createTestRenderer({ width: 100, height: 50, clock: new ManualClock() })
    const { renderer } = target
    const errors: Error[] = []
    renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
    const consoleErrors = spyOn(console, "error")
    const aspectRatio = process.env.CELL_ASPECT_RATIO
    process.env.CELL_ASPECT_RATIO = "1"
    try {
      await fractal.run(renderer)
      renderer.pause()
      await renderer.idle()
      await target.renderOnce()
      target.resize(80, 40)
      const before = target.getNativeStats().nativeFrameCount
      await target.renderOnce()
      expect(target.getNativeStats().nativeFrameCount).toBe(before + 1)
      expect(errors).toEqual([])
      expect(consoleErrors.mock.calls).toEqual([])
      expect(target.captureCharFrame()).toMatch(/[\u2580\u2584\u2588]/)
      const framebuffer = renderer.root.findDescendantById("fractal-framebuffer") as FrameBufferRenderable
      const colors = framebuffer.frameBuffer.withBuffers((cells) => new Set([...cells.fg, ...cells.bg]).size)
      expect(colors, `First resized GPU frame has only ${colors} color values`).toBeGreaterThan(8)
    } finally {
      try {
        fractal.destroy(renderer)
      } finally {
        renderer.destroy()
        await renderer.closed
        consoleErrors.mockRestore()
        if (aspectRatio === undefined) delete process.env.CELL_ASPECT_RATIO
        else process.env.CELL_ASPECT_RATIO = aspectRatio
      }
    }
  },
)
