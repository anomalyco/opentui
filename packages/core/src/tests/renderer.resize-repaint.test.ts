import { afterEach, describe, expect, test } from "bun:test"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"

describe("CliRenderer resize repaint", () => {
  let renderer: TestRenderer | null = null

  afterEach(async () => {
    renderer?.destroy()
    await renderer?.closed
    renderer = null
  })

  test("alternate-screen width shrink requests a full repaint for the first frame after the resize", async () => {
    const result = await createTestRenderer({
      width: 10,
      height: 4,
      screenMode: "alternate-screen",
      externalOutputMode: "passthrough",
      consoleMode: "disabled",
    })
    renderer = result.renderer
    renderer.root.add(new TextRenderable(renderer, { content: "abcdefghi", width: 9, height: 1 }))
    await result.renderOnce()

    const frameCountBefore = renderer.getNativeStats().nativeFrameCount

    // @ts-expect-error - asserting private renderer state
    expect(renderer.forceFullRepaintRequested).toBe(false)

    result.resize(8, 4)

    // The size change must request a full repaint: the incremental diff after
    // resize would otherwise skip cells that match the tracked buffer while the
    // terminal grid still shows reflowed rows and exposed columns (#1110).
    // @ts-expect-error - asserting private renderer state
    expect(renderer.forceFullRepaintRequested).toBe(true)

    await result.renderOnce()

    const stats = renderer.getNativeStats()
    expect(stats.nativeFrameCount).toBe(frameCountBefore + 1)
    // The first paint after the size change rewrites the entire new surface
    // instead of only the cells that differ from the previous buffer.
    expect(stats.cellsUpdated).toBe(8 * 4)
  })
})
