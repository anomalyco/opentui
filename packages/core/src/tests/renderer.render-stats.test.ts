import { afterEach, describe, expect, test } from "bun:test"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import type { NativeRenderStats } from "../zig.js"

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

describe("native renderer stats", () => {
  let renderer: TestRenderer | null = null

  afterEach(async () => {
    renderer?.destroy()
    await renderer?.closed
    renderer = null
  })

  test("cellsUpdated counts changed diff cells for native scene renders", async () => {
    const result = await createTestRenderer({ width: 4, height: 2 })
    renderer = result.renderer
    await result.renderOnce()

    expectRenderedStats(renderer.getNativeStats(), 1, 8)
    expect(renderer.getNativeStats().averageCellsUpdated).toBe(8)

    const text = new TextRenderable(renderer, { content: "abc", width: 3, height: 1 })
    renderer.root.add(text)
    await result.renderOnce()

    expectRenderedStats(renderer.getNativeStats(), 2, 3)

    await result.renderOnce()

    expectRenderedStats(renderer.getNativeStats(), 3, 0)

    text.content = "axc"
    await result.renderOnce()

    expectRenderedStats(renderer.getNativeStats(), 4, 1)
  })

  test("forced native renders count the full render surface", async () => {
    const result = await createTestRenderer({ width: 5, height: 2 })
    renderer = result.renderer
    await result.renderOnce()

    renderer.root.add(new TextRenderable(renderer, { content: "xy", width: 2, height: 1 }))
    await result.renderOnce()
    expectRenderedStats(renderer.getNativeStats(), 2, 2)

    // @ts-expect-error - request the renderer-owned full repaint in this regression test
    renderer.forceFullRepaintRequested = true
    await result.renderOnce()

    expectRenderedStats(renderer.getNativeStats(), 3, 10)
  })
})

describe("test renderer native render stats", () => {
  let renderer: TestRenderer | null = null

  afterEach(async () => {
    renderer?.destroy()
    await renderer?.closed
    renderer = null
  })

  test("createTestRenderer exposes native stats after renderOnce", async () => {
    const testRenderer = await createTestRenderer({ width: 10, height: 4 })
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
