import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { CliRenderEvents, Renderable, type CliRendererErrorEvent } from "@opentui/core"
import { createTestRenderer, ManualClock, type TestRendererSetup } from "@opentui/core/testing"
import { QRCodeRenderable } from "./QRCode.js"

let target: TestRendererSetup
const errors: Error[] = []
beforeEach(async () => {
  target = await createTestRenderer({
    width: 80,
    height: 40,
    clock: new ManualClock(),
  })
  errors.length = 0
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
})
afterEach(async () => {
  target.renderer.destroy()
  await target.renderer.closed
})

test("native QRCode retries raster allocation, reuses it on resize, and releases it without compatibility buffers", async () => {
  const { renderer } = target
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const lib = renderer.nativeScene!.driver.renderLib
  const failure = new Error("QR raster allocation failed")
  const created = spyOn(lib, "createContextBuffer").mockImplementationOnce(() => {
    throw failure
  })
  const destroyed = spyOn(lib, "destroyContextBuffer")
  try {
    expect(() => new QRCodeRenderable(renderer, { quietZone: 3 })).toThrow(RangeError)
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
    const qr = new QRCodeRenderable(renderer, { content: "HELLO WORLD" })
    renderer.root.add(qr)
    expect(created).not.toHaveBeenCalled()
    await target.renderOnce()
    expect(errors).toEqual([failure])
    expect(destroyed).not.toHaveBeenCalled()
    errors.length = 0
    await target.renderOnce()
    expect(errors).toEqual([])
    expect(target.captureCharFrame()).toMatch(/[\u2580\u2584\u2588]/)
    expect(created).toHaveBeenCalledTimes(2)
    const buffer = qr["renderBuffer"]!

    qr.scale = 2
    await target.renderOnce()
    target.resize(60, 30)
    await target.renderOnce()
    expect(errors).toEqual([])
    expect(qr["renderBuffer"]).toBe(buffer)
    expect(created).toHaveBeenCalledTimes(2)
    expect([buffer.width, buffer.height]).toEqual([60, 29])
    qr.destroy()
    expect(destroyed).toHaveBeenCalledTimes(1)
    expect(() => buffer.clear()).toThrow(/destroyed/i)
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)

    renderer.root.add(new QRCodeRenderable(renderer, { content: "renderer teardown" }))
    await target.renderOnce()
    expect(errors).toEqual([])
    expect(created).toHaveBeenCalledTimes(3)
    renderer.destroy()
    await renderer.closed
    expect(destroyed).toHaveBeenCalledTimes(2)
  } finally {
    created.mockRestore()
    destroyed.mockRestore()
  }
})
