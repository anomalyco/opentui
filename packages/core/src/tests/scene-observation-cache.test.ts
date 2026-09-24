import { afterEach, describe, expect, test } from "bun:test"
import { nativeConstants } from "../native-abi.generated.js"
import { BoxRenderable } from "../renderables/Box.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"
import { SceneStaging, type NativeContextHandle, type SceneNodeHandle } from "../zig.js"

let renderer: TestRenderer | undefined

afterEach(() => {
  renderer?.destroy()
  renderer = undefined
})

describe("scene layout observations", () => {
  test("repeated reads follow frames, host writes, and translations", async () => {
    const setup = await createTestRenderer({ width: 20, height: 5 })
    renderer = setup.renderer
    const box = new BoxRenderable(renderer, { width: 4, height: 1 })
    renderer.root.add(box)
    await setup.renderOnce()

    const first = box.getComputedLayout()
    expect(first.width).toBe(4)
    first.width = 99
    expect(box.getComputedLayout().width).toBe(4)
    expect(box.getComputedLayout()).not.toBe(box.getComputedLayout())
    expect(box.width).toBe(4)

    box.width = 7
    await setup.renderOnce()
    expect(box.getComputedLayout().width).toBe(7)
    expect(box.width).toBe(7)

    box.translateX = 3
    expect(box.x).toBe(3)

    box.destroy()
    expect(() => box.getComputedLayout()).toThrow()
  })
})

describe("scene staging", () => {
  const context = Object.freeze({}) as NativeContextHandle
  const node = { context, contextId: 1n, slot: 3, generation: 1 } as SceneNodeHandle
  const { OT_STYLE_DIMENSION, OT_DIMENSION_WIDTH, OT_DIMENSION_HEIGHT, OT_UNIT_POINT, OT_STYLE_DISABLE_FLEX_SHRINK } =
    nativeConstants

  test("rewrites the newest record only when it sets the same property", () => {
    const staging = new SceneStaging()
    const width = (value: number, flags = 0) =>
      staging.stageStyle(context, node, OT_STYLE_DIMENSION, OT_DIMENSION_WIDTH, 0, OT_UNIT_POINT, value, flags)
    width(10)
    width(20)
    expect(staging.count).toBe(1)
    staging.stageStyle(context, node, OT_STYLE_DIMENSION, OT_DIMENSION_HEIGHT, 0, OT_UNIT_POINT, 5, 0)
    width(30)
    expect(staging.count).toBe(3)
    width(40, OT_STYLE_DISABLE_FLEX_SHRINK)
    expect(staging.count).toBe(4)
    staging.stageStyle(context, { ...node, slot: 4 }, OT_STYLE_DIMENSION, OT_DIMENSION_WIDTH, 0, OT_UNIT_POINT, 1, 0)
    expect(staging.count).toBe(5)

    const words = staging._views(context)
    const floats = new Float32Array(words.buffer)
    expect(floats[8]).toBe(20)
    expect(staging.byteLength).toBe(5 * 40)
  })
})
