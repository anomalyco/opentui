import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "../lib/RGBA.js"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { resolveRenderLib, type NativeRenderStats, type RenderLib } from "../zig.js"
import type { OptimizedBuffer } from "../buffer.js"
import type { Pointer } from "../platform/ffi.js"

const fg = RGBA.fromInts(255, 255, 255, 255)

function expectInitialStats(stats: NativeRenderStats): void {
  expect(stats.nativeLastFrameTime).toBe(0)
  expect(stats.nativeAverageFrameTime).toBe(0)
  expect(stats.nativeFrameCount).toBe(0)
  expect(stats.cellsUpdated).toBe(0)
  expect(stats.averageCellsUpdated).toBe(0)
  expect(stats.nativeRenderTime).toBeUndefined()
  expect(stats.nativeStdoutWriteTime).toBeUndefined()
}

function expectRenderedStats(stats: NativeRenderStats, expectedFrameCount: number, expectedCellsUpdated: number): void {
  expect(stats.nativeFrameCount).toBe(expectedFrameCount)
  expect(stats.cellsUpdated).toBe(expectedCellsUpdated)
  expect(stats.nativeRenderTime).toBeGreaterThanOrEqual(0)
  expect(stats.nativeStdoutWriteTime).toBeGreaterThanOrEqual(0)
}

function createNativeRenderer(lib: RenderLib, width: number, height: number): Pointer {
  const rendererPtr = lib.createRenderer(width, height, { bufferedOutput: "memory" })
  if (!rendererPtr) {
    throw new Error("Failed to create native render-stats test renderer")
  }
  lib.setUseThread(rendererPtr, false)
  return rendererPtr
}

function warmNativeRenderer(lib: RenderLib, rendererPtr: Pointer): OptimizedBuffer {
  const nextBuffer = lib.getNextBuffer(rendererPtr)
  lib.render(rendererPtr, false)
  return nextBuffer
}

describe("native renderer stats", () => {
  const lib = resolveRenderLib()
  let rendererPtr: Pointer | null = null

  afterEach(() => {
    if (rendererPtr) {
      lib.destroyRenderer(rendererPtr)
      rendererPtr = null
    }
  })

  test("getRenderStats exposes initialized values before the first render", () => {
    rendererPtr = createNativeRenderer(lib, 4, 3)

    expectInitialStats(lib.getRenderStats(rendererPtr))
  })

  test("cellsUpdated counts changed diff cells for direct native renders", () => {
    rendererPtr = createNativeRenderer(lib, 4, 2)
    const nextBuffer = warmNativeRenderer(lib, rendererPtr)

    expectRenderedStats(lib.getRenderStats(rendererPtr), 1, 8)
    expect(lib.getRenderStats(rendererPtr).averageCellsUpdated).toBe(8)

    nextBuffer.drawText("abc", 0, 0, fg)
    lib.render(rendererPtr, false)

    expectRenderedStats(lib.getRenderStats(rendererPtr), 2, 3)

    nextBuffer.drawText("abc", 0, 0, fg)
    lib.render(rendererPtr, false)

    expectRenderedStats(lib.getRenderStats(rendererPtr), 3, 0)

    nextBuffer.drawText("axc", 0, 0, fg)
    lib.render(rendererPtr, false)

    expectRenderedStats(lib.getRenderStats(rendererPtr), 4, 1)
  })

  test("forced native renders count the full render surface", () => {
    rendererPtr = createNativeRenderer(lib, 5, 2)
    const nextBuffer = warmNativeRenderer(lib, rendererPtr)

    nextBuffer.drawText("xy", 0, 0, fg)
    lib.render(rendererPtr, false)
    expectRenderedStats(lib.getRenderStats(rendererPtr), 2, 2)

    nextBuffer.drawText("xy", 0, 0, fg)
    lib.render(rendererPtr, true)

    expectRenderedStats(lib.getRenderStats(rendererPtr), 3, 10)
  })
})

describe("test renderer native render stats", () => {
  let renderer: TestRenderer | null = null

  afterEach(() => {
    renderer?.destroy()
    renderer = null
  })

  test("createTestRenderer exposes native stats after renderOnce", async () => {
    const testRenderer = await createTestRenderer({ width: 10, height: 4, useThread: false })
    renderer = testRenderer.renderer

    expectInitialStats(testRenderer.getNativeStats())

    const text = new TextRenderable(renderer, {
      content: "abc",
      width: 3,
      height: 1,
    })
    renderer.root.add(text)

    await testRenderer.renderOnce()

    const firstStats = testRenderer.getNativeStats()
    expect(firstStats.nativeFrameCount).toBe(1)
    expect(firstStats.cellsUpdated).toBeGreaterThanOrEqual(3)
    expect(firstStats.nativeRenderTime).toBeGreaterThanOrEqual(0)
    expect(firstStats.nativeStdoutWriteTime).toBeGreaterThanOrEqual(0)

    const combinedStats = renderer.getStats()
    expect(combinedStats.frameCount).toBe(1)
    expect(combinedStats.frameCallbackTime).toBeGreaterThanOrEqual(0)
    expect(combinedStats.nativeFrameCount).toBe(firstStats.nativeFrameCount)
    expect(combinedStats.cellsUpdated).toBe(firstStats.cellsUpdated)

    await testRenderer.renderOnce()

    const secondStats = renderer.getNativeStats()
    expect(secondStats.nativeFrameCount).toBe(2)
    expect(secondStats.cellsUpdated).toBe(0)

    text.content = "axc"
    await testRenderer.renderOnce()

    const changedStats = testRenderer.getNativeStats()
    expect(changedStats.nativeFrameCount).toBe(3)
    expect(changedStats.cellsUpdated).toBe(1)
  })
})
