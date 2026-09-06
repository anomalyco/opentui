import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { CliRenderEvents, FrameBufferRenderable, type CliRendererErrorEvent } from "@opentui/core"
import { createTestRenderer, ManualClock, type TestRendererSetup } from "@opentui/core/testing"
import { Color, Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, Scene } from "three"
import { ThreeRenderable } from "../ThreeRenderable.js"
import { SuperSampleType, ThreeCliRenderer } from "../WGPURenderer.js"

function snapshot(target: TestRendererSetup) {
  return {
    text: target.captureCharFrame(),
    ...target.renderer.currentRenderBuffer.withBuffers((cells) => ({
      width: cells.width,
      height: cells.height,
      fg: cells.fg.slice(),
    })),
  }
}

test("ThreeCliRenderer destroy releases its subscriptions while the renderer stays alive", async () => {
  const { renderer } = await createTestRenderer({ width: 16, height: 8, clock: new ManualClock() })
  const events = ["resize", CliRenderEvents.DEBUG_OVERLAY_TOGGLE, CliRenderEvents.DESTROY]
  const listeners = events.map((event) => renderer.listeners(event))
  let engine: ThreeCliRenderer | undefined
  try {
    engine = new ThreeCliRenderer(renderer, { width: 16, height: 8 })
    for (const [index, event] of events.entries()) {
      assert.equal(renderer.listenerCount(event), listeners[index].length + 1, event)
    }
    engine.destroy()
    assert.equal(renderer.isDestroyed, false)
    for (const [index, event] of events.entries()) {
      assert.deepEqual(renderer.listeners(event), listeners[index], event)
    }
    assert.doesNotThrow(() => engine!.destroy())
  } finally {
    engine?.destroy()
    renderer.destroy()
    await renderer.closed
  }
})

test.skipIf(process.env.OTUI_TEST_WEBGPU !== "1").each(["absent", "readonly"])(
  "Three animation belongs to its CLI renderer with %s global browser APIs",
  async (globals) => {
    const names = ["requestAnimationFrame", "cancelAnimationFrame"] as const
    const original = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
    const targets: TestRendererSetup[] = []
    const engines: ThreeCliRenderer[] = []
    const devices: GPUDevice[] = []
    try {
      for (const name of names) {
        if (globals === "absent") {
          Reflect.deleteProperty(globalThis, name)
        } else {
          Object.defineProperty(globalThis, name, {
            configurable: true,
            writable: false,
            value: () => assert.fail(`Three must not call global ${name}`),
          })
        }
      }
      const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
      for (let index = 0; index < 2; index++) {
        const target = await createTestRenderer({ width: 8, height: 4, clock: new ManualClock() })
        targets.push(target)
        target.renderer.pause()
        engines.push(new ThreeCliRenderer(target.renderer, { width: 8, height: 4, superSample: SuperSampleType.NONE }))
      }
      await Promise.all(engines.map((engine) => engine.init()))
      devices.push(...engines.map((engine) => engine["device"]!))
      const gpu = engines.map((engine) => engine["threeRenderer"]!)
      assert.deepEqual(
        targets.map((target) => target.renderer.liveRequestCount),
        [1, 1],
      )
      const frames = gpu.map((renderer) => renderer.info.frame)
      await targets[0].renderOnce()
      assert.equal(gpu[0].info.frame, frames[0] + 1)
      assert.equal(gpu[1].info.frame, frames[1])
      await targets[1].renderOnce()
      assert.equal(gpu[0].info.frame, frames[0] + 1)
      assert.equal(gpu[1].info.frame, frames[1] + 1)

      engines[0].destroy()
      assert.deepEqual(
        targets.map((target) => target.renderer.liveRequestCount),
        [0, 1],
      )
      await targets[0].renderOnce()
      await targets[1].renderOnce()
      assert.equal(gpu[0].info.frame, frames[0] + 1)
      assert.equal(gpu[1].info.frame, frames[1] + 2)
      targets[1].renderer.destroy()
      await targets[1].renderer.closed
      assert.equal(gpu[1]._animation!._requestId, null)
      assert.deepEqual(
        names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name)),
        descriptors,
      )
    } finally {
      for (const engine of engines) engine.destroy()
      for (const { renderer } of targets) {
        renderer.destroy()
        await renderer.closed
      }
      for (const device of devices) {
        device.destroy()
        await device.lost
      }
      for (const [index, name] of names.entries()) {
        const descriptor = original[index]
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  },
)

test.skipIf(process.env.OTUI_TEST_WEBGPU !== "1").each(Object.values(SuperSampleType))(
  "ThreeRenderable %s readback preserves native pixels, resize, and retained buffer ownership",
  async (superSample) => {
    let target: TestRendererSetup | undefined
    let view: ThreeRenderable | undefined
    let device: GPUDevice | null | undefined
    const geometry = new PlaneGeometry(1, 2)
    const leftMaterial = new MeshBasicMaterial({ color: new Color(1, 0, 0) })
    const rightMaterial = new MeshBasicMaterial({ color: new Color(0, 0, 1) })
    const scene = new Scene()
    const left = new Mesh(geometry, leftMaterial)
    left.position.x = -0.5
    const right = new Mesh(geometry, rightMaterial)
    right.position.x = 0.5
    scene.add(left, right)
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
    camera.position.z = 2
    const errors = spyOn(console, "error")
    const renderErrors: Error[] = []
    const spies: { mockRestore(): void }[] = [errors]
    try {
      target = await createTestRenderer({
        width: 16,
        height: 8,
        clock: new ManualClock(),
      })
      target.renderer.pause()
      target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => renderErrors.push(error))

      const lib = target.renderer.nativeScene!.driver.renderLib
      const created = spyOn(lib, "createContextBuffer")
      const destroyed = spyOn(lib, "destroyContextBuffer")
      spies.push(created, destroyed)
      view = new ThreeRenderable(target.renderer, {
        position: "absolute",
        left: 2,
        top: 1,
        width: 8,
        height: 4,
        live: false,
        scene,
        camera,
        renderer: { superSample },
      })
      target.renderer.root.add(view)
      assert.equal(created.mock.calls.length, 1)

      async function capture() {
        const count = target!.renderer.getStats().nativeFrameCount
        await target!.renderOnce()
        assert.deepEqual(renderErrors, [])
        assert.equal(errors.mock.calls.length, 0)
        assert.equal(target!.renderer.getStats().nativeFrameCount, count + 1)
        return snapshot(target!)
      }

      await capture()
      const initial = await capture()
      assert.ok(initial.text.includes("\u2588"))
      const firstCell = (initial.width + 2) * 4
      assert.deepEqual([...initial.fg.slice(firstCell, firstCell + 4)], [255, 0, 0, 255])
      assert.deepEqual([...initial.fg.slice(firstCell + 4 * 4, firstCell + 5 * 4)], [0, 0, 255, 255])

      leftMaterial.color.setRGB(0, 1, 0)
      const changed = await capture()
      assert.deepEqual([...changed.fg.slice(firstCell, firstCell + 4)], [0, 255, 0, 255])

      target.resize(20, 10)
      view.width = 10
      view.height = 6
      await capture()
      const resized = await capture()
      assert.equal(resized.width, 20)
      assert.equal(resized.height, 10)
      assert.deepEqual([view["frameBuffer"]!.width, view["frameBuffer"]!.height], [10, 6])
      const lastCell = (6 * resized.width + 11) * 4
      assert.deepEqual([...resized.fg.slice(lastCell, lastCell + 4)], [0, 0, 255, 255])

      const buffer = view["frameBuffer"]!
      device = view.renderer["device"]
      geometry.dispose()
      leftMaterial.dispose()
      rightMaterial.dispose()
      view.destroy()
      assert.equal(destroyed.mock.calls.length, 1)
      assert.equal((await capture()).text.trim(), "")
      assert.throws(() => buffer.clear(), /destroyed/i)
    } finally {
      device ??= view?.renderer["device"]
      geometry.dispose()
      leftMaterial.dispose()
      rightMaterial.dispose()
      target?.renderer.destroy()
      await target?.renderer.closed
      device?.destroy()
      await device?.lost
      for (const spy of spies) spy.mockRestore()
    }
  },
)

test.skipIf(process.env.OTUI_TEST_WEBGPU !== "1").each(["render", "readback"] as const)(
  "ThreeCliRenderer destruction during real GPU %s skips late buffer and stats access",
  async (phase) => {
    const { renderer } = await createTestRenderer({
      width: 16,
      height: 8,
      clock: new ManualClock(),
    })
    const target = new FrameBufferRenderable(renderer, { width: 16, height: 8 })
    renderer.root.add(target)
    const engine = new ThreeCliRenderer(renderer, { width: 16, height: 8, superSample: SuperSampleType.NONE })
    target.once("destroyed", () => engine.destroy())
    let device: GPUDevice | null = null
    let pause: { mockRestore(): void } | undefined
    const entered = Promise.withResolvers<void>()
    const resumed = Promise.withResolvers<void>()
    let pending: Promise<void> | undefined
    try {
      await engine.init()
      device = engine["device"]
      const scene = new Scene()
      scene.background = new Color(1, 0, 0)
      await engine.drawScene(scene, target.frameBuffer, 0)
      const bytes = target.frameBuffer.withBuffers((cells) => cells.fg.slice())
      assert.ok(bytes.some((value) => value > 0))
      engine.toggleDebugStats()
      if (phase === "render") {
        const gpu = engine["threeRenderer"]!
        const render = gpu.render.bind(gpu)
        pause = spyOn(gpu, "render").mockImplementation(async (...args) => {
          await render(...args)
          entered.resolve()
          await resumed.promise
        })
      } else {
        const readback = engine["canvas"]!["readbackBuffer"]!
        const mapAsync = readback.mapAsync.bind(readback)
        pause = spyOn(readback, "mapAsync").mockImplementation(async (...args) => {
          const mapped = mapAsync(...args)
          entered.resolve()
          await mapped
          await resumed.promise
        })
      }
      pending = engine.drawScene(scene, target.frameBuffer, 0)
      await entered.promise
      target.destroyRecursively()
      resumed.resolve()
      await pending
      assert.equal(renderer.isDestroyed, false)
    } finally {
      resumed.resolve()
      await pending?.catch(() => {})
      pause?.mockRestore()
      target.destroyRecursively()
      engine.destroy()
      renderer.destroy()
      await renderer.closed
      device?.destroy()
      await device?.lost
    }
  },
)
