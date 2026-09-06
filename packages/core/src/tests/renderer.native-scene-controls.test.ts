import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable } from "../Renderable.js"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { ArrowRenderable } from "../renderables/ScrollBar.js"
import { SliderRenderable } from "../renderables/Slider.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup(width = 14, height = 12) {
  const target = await createTestRenderer({ width, height, clock: new ManualClock() })
  setups.push(target)
  return target
}

test("native arrow widths count display cells and preserve explicit dimensions", async () => {
  const cases = [
    ["", 1, undefined],
    ["e\u0301", 1, undefined],
    ["\u754c", 2, undefined],
    ["\ud83d\udc69\u200d\ud83d\udcbb", 2, undefined],
    ["Ae\u0301\u754c", 4, undefined],
    ["\u754c", 3, 3],
    ["\u754c", 6, "50%"],
  ] as const
  const target = await setup(12, cases.length)
  const arrows = cases.map(([text, , width], top) => {
    const arrow = new ArrowRenderable(target.renderer, {
      direction: "left",
      arrowChars: { left: text, right: ">" },
      position: "absolute",
      top,
      width,
      height: 1,
    })
    target.renderer.root.add(arrow)
    return arrow
  })
  await target.renderOnce()
  assert.deepEqual(
    arrows.map((arrow) => arrow.width),
    cases.map(([, width]) => width),
  )
  for (const arrow of arrows) {
    assert.equal(target.renderer.hitTest(arrow.width - 1, arrow.y), arrow.num)
    assert.notEqual(target.renderer.hitTest(arrow.width, arrow.y), arrow.num)
  }
  for (const arrow of arrows) {
    arrow.direction = "right"
    arrow.arrowChars = { right: "x" }
  }
  await target.renderOnce()
  assert.deepEqual(
    arrows.map((arrow) => arrow.width),
    cases.map(([, width]) => width),
  )
})

test("native slider clamping publishes accepted values once in callback and event order", async () => {
  const { renderer } = await setup()
  const calls: [string, number][] = []
  const slider = new SliderRenderable(renderer, {
    orientation: "horizontal",
    value: 80,
    onChange(value) {
      assert.equal(slider.value, value)
      calls.push(["callback", value])
    },
  })
  renderer.root.add(slider)
  slider.on("change", ({ value }: { value: number }) => {
    assert.equal(slider.value, value)
    calls.push(["event", value])
  })
  slider.max = 60
  slider.value = 80
  assert.deepEqual(calls, [
    ["callback", 60],
    ["event", 60],
  ])
})

test("native control constructor rejection releases wrappers and scene nodes", async () => {
  const { renderer } = await setup()
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const lib = renderer.nativeScene.driver.renderLib
  const created = spyOn(lib, "sceneCreateNode")
  const destroyed = spyOn(lib, "sceneDestroyNode")
  try {
    for (const construct of [
      () => new SliderRenderable(renderer, { orientation: "horizontal", value: NaN }),
      () => new ArrowRenderable(renderer, { direction: "up", arrowChars: { up: "bad\n" } }),
      () => new BoxRenderable(renderer, { title: "\x1b" }),
    ]) {
      assert.throws(construct, /native|scene|finite|invalid|arrow/i)
      assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), registered)
      assert.equal(created.mock.calls.length, destroyed.mock.calls.length)
    }
  } finally {
    created.mockRestore()
    destroyed.mockRestore()
  }
})

test("rejected native control setters preserve the accepted state and frame", async () => {
  const target = await setup()
  const changes: number[] = []
  const slider = new SliderRenderable(target.renderer, {
    orientation: "horizontal",
    width: 8,
    height: 1,
    value: 50,
    onChange: (value) => changes.push(value),
  })
  const arrow = new ArrowRenderable(target.renderer, { direction: "up", height: 1 })
  const box = new BoxRenderable(target.renderer, { width: 12, height: 3, border: true, title: "saved" })
  target.renderer.root.add(slider)
  target.renderer.root.add(arrow)
  target.renderer.root.add(box)
  await target.renderOnce()
  const before = target.captureSpans()
  assert.throws(() => {
    slider.value = NaN
  }, /native|scene|finite|invalid/i)
  assert.throws(() => {
    arrow.arrowChars = { up: "bad\n" }
  }, /native|scene|arrow|unsupported/i)
  assert.throws(() => {
    box.title = "\x1b"
  })
  assert.equal(slider.value, 50)
  assert.deepEqual(changes, [])
  await target.renderOnce()
  assert.deepEqual(target.captureSpans(), before)
  arrow.direction = "right"
  await target.renderOnce()
  assert.ok(target.captureCharFrame().includes("\u25b6"))
})

test("native Box title changes at an ordered prefix affect later painting", async () => {
  const target = await setup()
  const box = new BoxRenderable(target.renderer, { width: 12, height: 3, border: true, title: "before" })
  target.renderer.root.add(
    new BoxRenderable(target.renderer, {
      height: 1,
      renderBefore() {
        box.title = "after"
      },
    }),
  )
  target.renderer.root.add(box)
  await target.renderOnce()
  assert.ok(target.captureCharFrame().includes("after"))
})

test("slider mouse change can destroy its control without continuing a stale handler", async () => {
  const target = await setup()
  const errors: unknown[] = []
  target.renderer.on(CliRenderEvents.HANDLER_ERROR, ({ error }) => errors.push(error))
  const slider = new SliderRenderable(target.renderer, {
    orientation: "horizontal",
    width: 8,
    height: 1,
    onChange: () => slider.destroy(),
  })
  target.renderer.root.add(slider)
  await target.renderOnce()
  await target.mockMouse.pressDown(6, 0)
  assert.equal(slider.isDestroyed, true)
  assert.deepEqual(errors, [])
  await target.renderOnce()
  assert.notEqual(target.renderer.hitTest(6, 0), slider.num)
})

test.each([
  ["value", 75, 0, 100, 75],
  ["min", 75, 75, 100, 75],
  ["max", 25, 0, 25, 25],
] as const)("native slider %s remains committed after onChange throws", async (property, value, min, max, accepted) => {
  const target = await setup()
  const failure = new Error("fixture callback failure")
  const calls: number[] = []
  const slider = new SliderRenderable(target.renderer, {
    orientation: "horizontal",
    width: 8,
    height: 1,
    value: 50,
    viewPortSize: 20,
    onChange(value) {
      calls.push(value)
      throw failure
    },
  })
  target.renderer.root.add(slider)
  await target.renderOnce()
  const before = target.captureCharFrame()
  assert.throws(
    () => {
      slider[property] = value
    },
    (error) => error === failure,
  )
  assert.deepEqual([slider.min, slider.max, slider.value], [min, max, accepted])
  slider[property] = value
  await target.renderOnce()
  assert.notEqual(target.captureCharFrame(), before)
  assert.deepEqual(calls, [accepted])
})
