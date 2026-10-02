import { afterEach, describe, expect, test } from "bun:test"
import { nativeConstants } from "../native-abi.generated.js"
import { LayoutEvents } from "../Renderable.js"
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

  test("a style set and restored before a frame still runs layout", async () => {
    const setup = await createTestRenderer({ width: 20, height: 5 })
    renderer = setup.renderer
    const box = new BoxRenderable(renderer, { width: 5, height: 1 })
    renderer.root.add(box)
    await setup.renderOnce()
    let changes = 0
    renderer.root.on(LayoutEvents.LAYOUT_CHANGED, () => changes++)
    await setup.renderOnce()
    expect(changes).toBe(0)

    box.width = 10
    box.width = 5
    await setup.renderOnce()
    expect(changes).toBe(1)
    expect(box.width).toBe(5)

    // Values Yoga compares as equal although their bits differ still leave the run dirty.
    for (const writes of [
      [0, 10, -0],
      [-0, 10, 0],
      [{ unit: 0, value: 1 }, 10, { unit: 0, value: 2 }],
      [undefined, 10, { unit: 1, value: NaN }],
    ]) {
      changes = 0
      for (const value of writes) box.setMinWidth(value as never)
      await setup.renderOnce()
      expect(changes).toBe(1)
    }
  })
})

describe("scene staging", () => {
  const context = Object.freeze({}) as NativeContextHandle
  const node = { context, contextId: 1n, slot: 3, generation: 1 } as SceneNodeHandle
  const { OT_STYLE_DIMENSION, OT_DIMENSION_WIDTH, OT_DIMENSION_HEIGHT, OT_UNIT_POINT, OT_STYLE_DISABLE_FLEX_SHRINK } =
    nativeConstants

  test("keeps a run of writes to one property as at most two differing records", () => {
    const staging = new SceneStaging()
    const width = (value: number, flags = 0) =>
      staging.stageStyle(context, node, OT_STYLE_DIMENSION, OT_DIMENSION_WIDTH, 0, OT_UNIT_POINT, value, flags)
    const values = () => {
      const words = staging._views(context)
      const floats = new Float32Array(words.buffer)
      const result = Array.from({ length: staging.count }, (_, index) => floats[index * 10 + 8])
      staging.consume(0)
      return result
    }
    width(10)
    width(10)
    expect(values()).toEqual([10])
    width(20)
    expect(values()).toEqual([10, 20])
    width(30)
    expect(values()).toEqual([10, 30])
    // Returning to the older value keeps a differing value ahead of it, so Yoga still sees a change.
    width(10)
    expect(values()).toEqual([30, 10])
    width(10)
    expect(values()).toEqual([30, 10])

    staging.stageStyle(context, node, OT_STYLE_DIMENSION, OT_DIMENSION_HEIGHT, 0, OT_UNIT_POINT, 5, 0)
    width(40)
    width(50)
    expect(values()).toEqual([30, 10, 5, 40, 50])
    width(60, OT_STYLE_DISABLE_FLEX_SHRINK)
    staging.stageStyle(context, { ...node, slot: 4 }, OT_STYLE_DIMENSION, OT_DIMENSION_WIDTH, 0, OT_UNIT_POINT, 1, 0)
    expect(values()).toEqual([30, 10, 5, 40, 50, 60, 1])
  })
})
