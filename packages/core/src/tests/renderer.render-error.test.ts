import { expect, spyOn, test } from "bun:test"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { createTestRenderer } from "../testing.js"
import type { RenderContext } from "../types.js"

class ThrowingRenderable extends Renderable {
  public shouldThrow = true

  constructor(
    ctx: RenderContext,
    options: RenderableOptions,
    private readonly error: unknown = new Error("render failed"),
  ) {
    super(ctx, options)
  }

  protected renderSelf(_buffer: OptimizedBuffer, _deltaTime: number): void {
    if (this.shouldThrow) throw this.error
  }
}

test("emits render errors and continues rendering", async () => {
  const { renderer, waitFor } = await createTestRenderer({})
  const target = new ThrowingRenderable(renderer, { width: 1, height: 1 })
  const errors: CliRendererErrorEvent[] = []
  const animationError = new Error("animation failed")

  try {
    renderer.root.add(target)
    renderer.on(CliRenderEvents.RENDER_ERROR, (event) => {
      errors.push(event)
      if (event.renderable) {
        target.shouldThrow = false
        requestAnimationFrame(() => {
          throw animationError
        })
      }
    })

    renderer.start()
    await waitFor(() => errors.length === 2 && renderer.getStats().nativeFrameCount > 0)

    expect(errors).toHaveLength(2)
    expect(errors[0].error).toEqual(new Error("render failed"))
    expect(errors[0].renderable).toBe(target)
    expect(errors[1]).toEqual({ error: animationError, renderable: undefined })
  } finally {
    renderer.destroy()
  }
})

test("a one-shot render can request recovery from an error listener", async () => {
  const { renderer, waitFor } = await createTestRenderer({})
  const target = new ThrowingRenderable(renderer, { width: 1, height: 1 })
  const errors: CliRendererErrorEvent[] = []

  try {
    renderer.root.add(target)
    renderer.on(CliRenderEvents.RENDER_ERROR, (event) => {
      errors.push(event)
      target.shouldThrow = false
      renderer.requestRender()
    })

    renderer.requestRender()
    await waitFor(() => errors.length === 1 && renderer.getStats().nativeFrameCount > 0)

    expect(errors[0]).toEqual({ error: new Error("render failed"), renderable: target })
  } finally {
    renderer.destroy()
  }
})

test("reports an unobserved render error", async () => {
  const { renderer, waitFor } = await createTestRenderer({ openConsoleOnError: false })
  const target = new ThrowingRenderable(renderer, { width: 1, height: 1 }, "render failed")
  const consoleError = spyOn(console, "error").mockImplementation(() => {})

  try {
    renderer.root.add(target)
    renderer.requestRender()
    await waitFor(() => consoleError.mock.calls.length > 0)

    expect(consoleError).toHaveBeenCalledWith(new Error("render failed"))
  } finally {
    consoleError.mockRestore()
    renderer.destroy()
  }
})
