import { getYogaNode } from "../lib/renderable-layout.js"
import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"

import { Renderable } from "../Renderable.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { SliderRenderable } from "../renderables/Slider.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

import { TextAttributes } from "../types.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup(width = 20, height = 8) {
  const target = await createTestRenderer({ width, height, clock: new ManualClock() })
  setups.push(target)
  const errors: Error[] = []
  let frames = 0
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  target.renderer.on(CliRenderEvents.FRAME, () => frames++)
  return {
    ...target,
    errors,
    async frame() {
      const before = target.renderer.getStats().nativeFrameCount
      const completed = frames
      await target.renderOnce()
      assert.deepEqual(errors, [])
      assert.equal(frames, completed + 1)
      assert.equal(target.renderer.getStats().nativeFrameCount, before + 1)
    },
  }
}

test.each([0, 12])("ScrollBox clamps infinite positions with %i rows", async (count) => {
  const target = await setup()
  const scroll = new ScrollBoxRenderable(target.renderer, { width: 20, height: 6, scrollX: true })
  target.renderer.root.add(scroll)
  addRows(target, scroll, count, 40)
  await target.frame()
  const start = target.captureSpans()
  const maxX = Math.max(0, scroll.scrollWidth - scroll.viewport.width)
  const maxY = Math.max(0, scroll.scrollHeight - scroll.viewport.height)
  scroll.scrollTo({ x: maxX, y: maxY })
  await target.frame()
  const end = target.captureSpans()

  scroll.scrollTo({ x: -Infinity, y: -Infinity })
  await target.frame()
  assert.equal(scroll.scrollTop, 0)
  assert.equal(scroll.scrollLeft, 0)
  assert.deepEqual(target.captureSpans(), start)

  scroll.scrollTo(Infinity)
  await target.frame()
  assert.equal(scroll.scrollTop, maxY)
  assert.equal(scroll.scrollLeft, 0)

  scroll.scrollTo({ x: Infinity, y: Infinity })
  await target.frame()
  assert.equal(scroll.scrollTop, maxY)
  assert.equal(scroll.scrollLeft, maxX)
  assert.deepEqual(target.captureSpans(), end)

  assert.throws(() => scroll.scrollTo(NaN), /finite/)
  assert.equal(scroll.scrollTop, maxY)
  scroll.scrollTo(-Infinity)
  scroll.scrollLeft = -Infinity
  await target.frame()
  assert.equal(scroll.scrollTop, 0)
  assert.equal(scroll.scrollLeft, 0)
  assert.deepEqual(target.captureSpans(), start)
})

function tree(root: Renderable) {
  const nodes: Renderable[] = [root]
  for (let index = 0; index < nodes.length; index++) {
    // ScrollBox.getChildren() delegates to content and omits its controller nodes.
    nodes.push(...Renderable.prototype.getChildren.call(nodes[index]))
  }
  return nodes
}

function addRows(
  target: TestRendererSetup,
  scroll: ScrollBoxRenderable,
  count: number,
  width: number | "100%" = "100%",
) {
  const start = scroll.getChildren().length
  return Array.from({ length: count }, (_, index) => {
    const id = `row-${String(start + index).padStart(2, "0")}`
    const row = new TextRenderable(target.renderer, {
      id,
      content: `${id}: \u4e16\u754c e\u0301 \ud83d\udc69\u200d\ud83d\udcbb trailing text`,
      selectable: false,
      wrapMode: "none",
      width,
      height: 1,
      flexShrink: 0,
      fg: "#90c0ff",
      bg: "#102030",
      attributes: index % 2 === 0 ? TextAttributes.BOLD : TextAttributes.ITALIC,
    })
    scroll.add(row)
    return row
  })
}

test("native content clicks focus ScrollBox and route both-axis keyboard input", async () => {
  const target = await setup()
  const scroll = new ScrollBoxRenderable(target.renderer, {
    width: "100%",
    height: "100%",
    scrollX: true,
    horizontalScrollbarOptions: { height: 1, flexShrink: 0 },
  })
  const [first] = addRows(target, scroll, 20, 36)
  target.renderer.root.add(scroll)
  await target.frame()
  await target.frame()
  assert.equal(scroll.focusable, true)
  assert.equal(target.renderer.hitTest(first.x, first.y), first.num)
  await target.mockMouse.pressDown(first.x, first.y)
  await target.mockMouse.release(first.x, first.y)
  assert.equal(target.renderer.currentFocusedRenderable, scroll)
  assert.equal(scroll.focused, true)
  for (const [key, x, y] of [
    ["ARROW_DOWN", 0, Math.round(scroll.viewport.height / 5)],
    ["ARROW_UP", 0, 0],
    ["ARROW_RIGHT", Math.round(scroll.viewport.width / 5), 0],
    ["ARROW_LEFT", 0, 0],
    ["END", 0, scroll.scrollHeight - scroll.viewport.height],
    ["HOME", 0, 0],
  ] as const) {
    target.mockInput.pressKey(key)
    await target.frame()
    assert.deepEqual([scroll.scrollLeft, scroll.scrollTop], [x, y])
  }
  scroll.blur()
  target.mockInput.pressKey("ARROW_DOWN")
  assert.equal(scroll.scrollTop, 0)
})

{
  test.each([15, 16])(
    `native filtered %s-child content refreshes all rows before updates and suppresses hidden hooks`,
    async (count) => {
      const target = await setup(20, 5)
      const scroll = new ScrollBoxRenderable(target.renderer, { width: "100%", height: "100%" })
      const rows = Array.from({ length: count }, () => {
        const row = new BoxRenderable(target.renderer, { width: "100%", height: 2, flexShrink: 0 })
        scroll.add(row)
        return row
      })
      const last = rows.at(-1)!
      const child = new BoxRenderable(target.renderer, { width: "100%", height: 1 })
      last.add(child)
      target.renderer.root.add(scroll)
      await target.frame()
      await target.frame()
      scroll.scrollTo(1_000_000)
      await target.frame()
      scroll.scrollTo(0)
      await target.frame()
      const previousChild = [child.width, child.height]
      const calls: string[] = []
      const widths: number[][] = []
      let notifications = 0
      Object.assign(rows[0], {
        onUpdate: () => {
          widths.push(rows.map((row) => row.width))
          calls.push(`first:update:last-width=${last.width}`)
        },
      })
      Object.assign(last, { onUpdate: () => calls.push("last:update") })
      Object.assign(child, { onUpdate: () => calls.push("child:update") })
      last.onSizeChange = () => calls.push("last:resize")
      child.onSizeChange = () => calls.push("child:resize")
      last.on("resize", () => notifications++)
      child.on("resize", () => notifications++)

      rows.forEach((row, index) => {
        row.width = index + 2
      })
      child.height = 2
      await target.frame()
      assert.deepEqual(widths, [rows.map((_, index) => index + 2)])
      assert.deepEqual([last.width, last.height], [count + 1, 2])
      assert.deepEqual(
        calls,
        count === 15
          ? ["last:resize", `first:update:last-width=${count + 1}`, "last:update", "child:update", "child:resize"]
          : ["last:resize", `first:update:last-width=${count + 1}`],
      )
      assert.deepEqual([child.width, child.height], count === 15 ? [count + 1, 2] : previousChild)
      assert.equal(notifications, count === 15 ? 2 : 1)

      calls.length = 0
      notifications = 0
      last.visible = false
      await target.frame()
      assert.deepEqual([last.width, last.height], [1, 1])
      assert.deepEqual(calls, ["first:update:last-width=1"])
      assert.equal(notifications, 0)
    },
  )
}

test.each([false, true])(
  "native late viewport reveals settle control geometry and resize feedback: %s",
  async (resize) => {
    const target = await setup(12, 4)
    const scroll = new ScrollBoxRenderable(target.renderer, { width: 12, height: 4 })
    const rows = Array.from({ length: 16 }, () => {
      const row = new BoxRenderable(target.renderer, { width: 10, height: 2, flexShrink: 0 })
      scroll.add(row)
      return row
    })
    const slider = new SliderRenderable(target.renderer, { orientation: "horizontal", width: 2, height: 1 })
    rows[10].add(slider)
    target.renderer.root.add(scroll)
    for (const top of [0, 20, 0]) {
      scroll.scrollTo(top)
      await target.frame()
    }
    const updates: string[] = []
    const sizes: number[] = []
    Object.assign(rows[0], {
      onUpdate: () => {
        updates.push("first")
        scroll.scrollTo(20)
      },
    })
    Object.assign(rows[1], { onUpdate: () => updates.push("second") })
    Object.assign(slider, { onUpdate: () => updates.push(`slider:${slider.width}`) })
    slider.onSizeChange = () => {
      sizes.push(slider.width)
      if (resize && slider.width === 8) slider.width = 6
    }
    slider.width = 8
    await target.frame()
    const width = resize ? 6 : 8
    assert.equal(slider.width, width)
    assert.deepEqual(sizes, resize ? [8, 6] : [8])
    assert.deepEqual(updates, ["first", "second", "slider:2"])
    for (let x = 0; x < width; x++) assert.equal(target.renderer.hitTest(x, 0), slider.num)
    await target.mockMouse.pressDown(width / 2, 0)
    assert.equal(slider.value, 50)
  },
)

test("native 10000-entry ScrollBox frames never traverse or read content child layouts in JavaScript", async () => {
  const target = await setup()
  const scroll = new ScrollBoxRenderable(target.renderer, { width: "100%", height: "100%" })
  const rows = addRows(target, scroll, 10_000)
  target.renderer.root.add(scroll)
  const scene = target.renderer.nativeScene!
  const childSlots = new Set(rows.map((row) => getYogaNode(row)._getSceneHandle(scene).slot))
  const internalCount = tree(target.renderer.root).length - rows.length
  for (const operation of ["initial", "steady", "down", "up", "changed"] as const) {
    if (operation === "down") scroll.scrollTo(1_000_000)
    else if (operation === "up") scroll.scrollTo(0)
    else if (operation === "changed") rows[0].content = "fresh first row"
    const traversals = [
      spyOn(Renderable.prototype, "getChildrenCount"),
      spyOn(Renderable.prototype, "getChildrenSortedByPrimaryAxis"),
      spyOn(Renderable.prototype, "getChildren"),
    ]
    const reads = spyOn(scene.driver.renderLib, "sceneGetLayout")
    try {
      await target.frame()
      assert.equal(
        traversals.reduce((count, spy) => count + spy.mock.calls.length, 0),
        0,
      )
      assert.equal(
        reads.mock.calls.some(([, handle]) => childSlots.has(handle.slot)),
        false,
      )
      assert.ok(reads.mock.calls.length <= internalCount * 32, "only bounded controller geometry queries are allowed")
    } finally {
      reads.mockRestore()
      for (const spy of traversals) spy.mockRestore()
    }
  }
  assert.match(target.captureCharFrame(), /fresh first row/)
})
