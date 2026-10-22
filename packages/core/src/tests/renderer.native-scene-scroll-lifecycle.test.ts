import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { RenderableEvents } from "../Renderable.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { ScrollBarRenderable } from "../renderables/ScrollBar.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup() {
  const target = await createTestRenderer({
    width: 20,
    height: 10,
    screenMode: "main-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
    useMouse: true,
    clock: new ManualClock(),
  })
  setups.push(target)
  return target
}

async function setupBar() {
  const target = await setup()
  const bar = new ScrollBarRenderable(target.renderer, {
    orientation: "vertical",
    width: 2,
    height: 10,
    showArrows: true,
  })
  bar.scrollSize = 100
  bar.viewportSize = 10
  target.renderer.root.add(bar)
  await target.renderOnce()
  return { target, bar }
}

async function setupScroll() {
  const target = await setup()
  const scroll = new ScrollBoxRenderable(target.renderer, {
    width: 12,
    height: 6,
    scrollX: true,
    stickyScroll: true,
    horizontalScrollbarOptions: { height: 1, flexShrink: 0 },
  })
  const child = new BoxRenderable(target.renderer, { width: 40, height: 30, flexShrink: 0 })
  scroll.add(child)
  target.renderer.root.add(scroll)
  await target.renderOnce()
  assert.ok(scroll.scrollWidth > scroll.viewport.width)
  assert.ok(scroll.scrollHeight > scroll.viewport.height)
  return { target, scroll, child }
}

test.each(["wheel input", "key input", "content height shrink", "content width shrink"])(
  "native sticky ScrollBox %s stops after a change listener destroys its controller",
  async (name) => {
    const { target, scroll, child } = await setupScroll()
    const vertical = /wheel|height/.test(name)
    const shrink = name.includes("shrink")
    const bar = vertical ? scroll.verticalScrollBar : scroll.horizontalScrollBar
    if (shrink) bar.scrollPosition = 20
    const inputStep = vertical ? 1 : Math.round(scroll.viewport.width / 5)
    const changes: number[] = []
    const errors: Error[] = []
    target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
    bar.on("change", ({ position }: { position: number }) => {
      changes.push(position)
      scroll.destroyRecursively()
    })
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      scroll.focus()
      if (shrink) {
        child[vertical ? "height" : "width"] = 15
        await target.renderOnce()
      } else if (vertical) await target.mockMouse.scroll(scroll.viewport.x, scroll.viewport.y, "down")
      else target.mockInput.pressKey("ARROW_RIGHT")
      const expected = shrink ? 15 - bar.viewportSize : inputStep
      assert.deepEqual([changes, bar.scrollPosition, bar.slider.value], [[expected], expected, expected])
      assert.deepEqual([scroll.isDestroyed, errors, logged.mock.calls], [true, [], []])
    } finally {
      logged.mockRestore()
    }
  },
)

test("a retained native slider does not call its destroyed scrollbar controller", async () => {
  const target = await setup()
  let ownerChanges = 0
  const bar = new ScrollBarRenderable(target.renderer, {
    orientation: "vertical",
    onChange: () => {
      ownerChanges++
      void bar.width
    },
  })
  bar.scrollSize = 100
  bar.viewportSize = 10
  const slider = bar.slider
  let leafChanges = 0
  slider.on("change", () => leafChanges++)
  target.renderer.root.add(slider)
  bar.destroyRecursively()
  assert.doesNotThrow(() => {
    slider.value = 3
  })
  assert.equal(slider.isDestroyed, false)
  assert.equal(slider.value, 3)
  assert.equal(leafChanges, 1)
  assert.equal(ownerChanges, 0)
  await target.renderOnce()
})

const barWrites: Record<string, (bar: ScrollBarRenderable) => void> = {
  "hiding arrows": (bar) => (bar.showArrows = false),
  "arrow options": (bar) => (bar.arrowOptions = { visible: false }),
  "track options": (bar) => (bar.trackOptions = { value: 3, backgroundColor: "red" }),
}

test.each(Object.keys(barWrites))("native ScrollBar %s stop when a callback removes the owner", async (name) => {
  const { bar } = await setupBar()
  if (name === "track options") bar.once("change", () => bar.destroyRecursively())
  else {
    bar.startArrow.focusable = true
    bar.startArrow.focus()
    bar.startArrow.once(RenderableEvents.BLURRED, () => bar.destroyRecursively())
  }
  assert.doesNotThrow(() => barWrites[name](bar))
  assert.deepEqual([bar.isDestroyed, bar.endArrow.isDestroyed], [true, true])
})

test("native ScrollBox root options stop after a blur callback removes the owner", async () => {
  const { renderer } = await setup()
  const scroll = new ScrollBoxRenderable(renderer, { width: 10, height: 5 })
  renderer.root.add(scroll)
  scroll.focus()
  scroll.once(RenderableEvents.BLURRED, () => scroll.destroyRecursively())
  assert.doesNotThrow(() => {
    scroll.rootOptions = { visible: false, backgroundColor: "red" }
  })
  assert.equal(scroll.isDestroyed, true)
})
