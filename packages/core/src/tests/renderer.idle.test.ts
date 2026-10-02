import { test, expect, beforeEach, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { RendererControlState } from "../renderer.js"

let renderer: TestRenderer

async function expectIdleWithoutAnotherFrame(renderer: TestRenderer): Promise<void> {
  const frameId = renderer.frameId
  await renderer.idle()
  expect(renderer.frameId).toBe(frameId)
  expect(renderer.getSchedulerState().isRendering).toBe(false)
}

beforeEach(async () => {
  ;({ renderer } = await createTestRenderer({}))
})

afterEach(async () => {
  renderer.destroy()
  await renderer.closed
})

test("idle() resolves without another frame when renderer is already idle", async () => {
  expect(renderer.controlState).toBe(RendererControlState.IDLE)
  expect(renderer.isRunning).toBe(false)

  await expectIdleWithoutAnotherFrame(renderer)
})

test("idle() waits for running renderer to stop", async () => {
  renderer.start()
  expect(renderer.isRunning).toBe(true)

  const idlePromise = renderer.idle()

  await new Promise((resolve) => setTimeout(resolve, 50))

  renderer.stop()

  await idlePromise

  expect(renderer.isRunning).toBe(false)
})

test("idle() waits for paused renderer after requestRender()", async () => {
  renderer.pause()
  expect(renderer.isRunning).toBe(false)

  renderer.requestRender()

  const idlePromise = renderer.idle()

  await idlePromise

  expect(renderer.isRunning).toBe(false)
})

test("idle() resolves without another frame after requestRender() completes", async () => {
  renderer.requestRender()

  await renderer.idle()

  await expectIdleWithoutAnotherFrame(renderer)
})

test("multiple idle() calls all resolve when renderer becomes idle", async () => {
  renderer.start()

  const idlePromise1 = renderer.idle()
  const idlePromise2 = renderer.idle()
  const idlePromise3 = renderer.idle()

  await new Promise((resolve) => setTimeout(resolve, 50))

  renderer.stop()

  await Promise.all([idlePromise1, idlePromise2, idlePromise3])

  expect(renderer.isRunning).toBe(false)
})

test("idle() resolves when AUTO_STARTED renderer drops all live requests", async () => {
  renderer.requestLive()
  expect(renderer.controlState).toBe(RendererControlState.AUTO_STARTED)
  expect(renderer.isRunning).toBe(true)

  const idlePromise = renderer.idle()

  renderer.dropLive()

  await idlePromise

  expect(renderer.controlState).toBe(RendererControlState.IDLE)
  expect(renderer.isRunning).toBe(false)
})

test("idle() resolves after explicit pause", async () => {
  renderer.start()
  expect(renderer.isRunning).toBe(true)

  const idlePromise = renderer.idle()

  renderer.pause()

  await idlePromise

  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  expect(renderer.isRunning).toBe(false)
})

test("idle() resolves without another frame when called on paused renderer", async () => {
  renderer.start()
  renderer.pause()
  await expectIdleWithoutAnotherFrame(renderer)
})

test("idle() resolves when renderer is destroyed", async () => {
  renderer.start()

  const idlePromise = renderer.idle()

  renderer.destroy()

  await idlePromise
})

test("idle() resolves without another frame when called on destroyed renderer", async () => {
  renderer.destroy()
  await renderer.closed

  await expectIdleWithoutAnotherFrame(renderer)
})

test("idle() waits through multiple requestRender() calls", async () => {
  renderer.requestRender()
  renderer.requestRender()

  await renderer.idle()

  expect(renderer.isRunning).toBe(false)
})

test("idle() works correctly with stop() called during rendering", async () => {
  renderer.start()

  await new Promise((resolve) => setTimeout(resolve, 50))

  const idlePromise = renderer.idle()

  renderer.stop()

  await idlePromise

  expect(renderer.isRunning).toBe(false)
})

test("idle() resolves after pause() called during rendering", async () => {
  renderer.start()

  await new Promise((resolve) => setTimeout(resolve, 50))

  const idlePromise = renderer.idle()

  renderer.pause()

  await idlePromise

  expect(renderer.controlState).toBe(RendererControlState.EXPLICIT_PAUSED)
  expect(renderer.isRunning).toBe(false)
})

test("idle() can be used in a loop to wait between operations", async () => {
  const operations: string[] = []

  operations.push("start")
  renderer.requestRender()
  await renderer.idle()
  operations.push("rendered")

  renderer.requestRender()
  await renderer.idle()
  operations.push("rendered again")

  expect(operations).toEqual(["start", "rendered", "rendered again"])
})

test("idle() works with requestAnimationFrame", async () => {
  let frameCallbackExecuted = false

  renderer.requestAnimationFrame(() => {
    frameCallbackExecuted = true
  })

  await renderer.idle()

  expect(frameCallbackExecuted).toBe(true)
})

test("idle() waits for all animation frames to complete", async () => {
  let count = 0

  renderer.requestAnimationFrame(() => {
    count++
    renderer.requestAnimationFrame(() => {
      count++
    })
  })

  await renderer.idle()

  expect(count).toBe(2)
})
