import { test } from "bun:test"
import assert from "node:assert/strict"
import { CliRenderEvents } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { SuperSampleType, ThreeCliRenderer } from "../WGPURenderer.js"

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
    let engine: ThreeCliRenderer | undefined
    let device: GPUDevice | undefined
    const { renderer, renderOnce } = await createTestRenderer({ width: 8, height: 4, clock: new ManualClock() })
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
      renderer.pause()
      engine = new ThreeCliRenderer(renderer, { width: 8, height: 4, superSample: SuperSampleType.NONE })
      await engine.init()
      device = engine["device"]!
      await renderOnce()
      engine.destroy()
      engine = undefined
      assert.equal(renderer.isDestroyed, false)
      assert.deepEqual(
        names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name)),
        descriptors,
      )
    } finally {
      engine?.destroy()
      renderer.destroy()
      await renderer.closed
      device?.destroy()
      await device?.lost
      for (const [index, name] of names.entries()) {
        const descriptor = original[index]
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  },
)
