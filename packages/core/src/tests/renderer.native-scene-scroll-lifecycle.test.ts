import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable, RenderableEvents } from "../Renderable.js"
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

function controlTimers(bar: ScrollBarRenderable) {
  const original = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
  }
  const pending = new Map<number, { callback: () => void; delay: number; repeat: boolean }>()
  let id = 0
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    pending.set(++id, { callback, delay, repeat: false })
    return id
  }) as typeof setTimeout
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    pending.set(++id, { callback, delay, repeat: true })
    return id
  }) as typeof setInterval
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    pending.delete(Number(handle))
  }) as typeof clearTimeout
  return {
    pending,
    fire(delay: number) {
      const entry = [...pending].find(([, timer]) => timer.delay === delay)
      assert.ok(entry, `missing ${delay}ms timer`)
      const [handle, timer] = entry
      if (!timer.repeat) pending.delete(handle)
      timer.callback()
    },
    restore() {
      try {
        bar.destroyRecursively()
      } finally {
        pending.clear()
        Object.assign(globalThis, original)
      }
    },
  }
}

test("native scroll constructor failures release attached and provisional nodes", async () => {
  const { renderer } = await setup()
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const listeners = renderer.listenerCount("selection")
  const lib = renderer.nativeScene!.driver.renderLib
  const created = spyOn(lib, "sceneCreateNode")
  const destroyed = spyOn(lib, "sceneDestroyNode")
  const callbackFailure = new Error("initial track callback failed")
  const constructors = [
    () => new ScrollBarRenderable(renderer, { orientation: "vertical", trackOptions: { value: NaN } }),
    () => new ScrollBarRenderable(renderer, { orientation: "vertical", arrowOptions: { attributes: NaN } }),
    () =>
      new ScrollBarRenderable(renderer, {
        orientation: "vertical",
        trackOptions: {
          value: 10,
          max: 20,
          onChange() {
            throw callbackFailure
          },
        },
      }),
    () =>
      new ScrollBoxRenderable(renderer, {
        horizontalScrollbarOptions: { arrowOptions: { attributes: NaN } },
      }),
  ]
  try {
    for (const construct of constructors) {
      assert.throws(construct, (error) => error === callbackFailure || /finite|u32/i.test(String(error)))
      assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), registered)
      assert.equal(created.mock.calls.length, destroyed.mock.calls.length)
      assert.equal(renderer.listenerCount("selection"), listeners)
    }
    assert.ok(created.mock.calls.length > 0)
  } finally {
    created.mockRestore()
    destroyed.mockRestore()
  }
})

test.each(["wheel", "key"] as const)(
  "native sticky ScrollBox %s input stops after a change listener destroys its controller",
  async (input) => {
    const { target, scroll } = await setupScroll()
    const bar = input === "wheel" ? scroll.verticalScrollBar : scroll.horizontalScrollBar
    const expected = input === "wheel" ? 1 : Math.round(scroll.viewport.width / 5)
    const changes: number[] = []
    bar.on("change", ({ position }: { position: number }) => {
      changes.push(position)
      scroll.destroyRecursively()
    })
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      scroll.focus()
      if (input === "wheel") await target.mockMouse.scroll(scroll.viewport.x, scroll.viewport.y, "down")
      else target.mockInput.pressKey("ARROW_RIGHT")
      assert.deepEqual(changes, [expected])
      assert.equal(bar.scrollPosition, expected)
      assert.equal(bar.slider.value, expected)
      assert.equal(scroll.isDestroyed, true)
      assert.deepEqual(logged.mock.calls, [])
    } finally {
      logged.mockRestore()
    }
  },
)

test.each(["height", "width"] as const)(
  "native sticky ScrollBox content %s shrink stops after a clamp listener destroys its controller",
  async (dimension) => {
    const { target, scroll, child } = await setupScroll()
    const bar = dimension === "height" ? scroll.verticalScrollBar : scroll.horizontalScrollBar
    bar.scrollPosition = 20
    const changes: number[] = []
    const errors: Error[] = []
    target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
    bar.on("change", ({ position }: { position: number }) => {
      changes.push(position)
      scroll.destroyRecursively()
    })
    child[dimension] = 15
    await target.renderOnce()
    const expected = 15 - bar.viewportSize
    assert.deepEqual(changes, [expected])
    assert.equal(bar.scrollPosition, expected)
    assert.equal(bar.slider.value, expected)
    assert.equal(scroll.isDestroyed, true)
    assert.deepEqual(errors, [])
  },
)

test.each(["press", "delay", "repeat"] as const)(
  "native arrow %s callback can destroy its bar without retaining repeat timers",
  async (phase) => {
    const { target, bar } = await setupBar()
    const timers = controlTimers(bar)
    let changes = 0
    const destroyAt = phase === "press" ? 1 : phase === "delay" ? 2 : 3
    bar.on("change", () => {
      if (++changes === destroyAt) bar.destroy()
    })
    try {
      await target.mockMouse.pressDown(bar.endArrow.x, bar.endArrow.y)
      if (phase !== "press") timers.fire(500)
      if (phase === "repeat") timers.fire(200)
      assert.equal(changes, destroyAt)
      assert.equal(bar.isDestroyed, true)
      assert.equal(timers.pending.size, 0)
    } finally {
      timers.restore()
    }
  },
)

test("native stale arrow repeat cannot cancel a newer arrow's repeat", async () => {
  const { target, bar } = await setupBar()
  bar.scrollPosition = 50
  const timers = controlTimers(bar)
  const failure = new Error("arrow destruction failed")
  bar.endArrow.prependListener(RenderableEvents.DESTROYED, () => {
    throw failure
  })
  try {
    await target.mockMouse.pressDown(bar.endArrow.x, bar.endArrow.y)
    timers.fire(500)
    const previous = [...timers.pending.values()][0].callback
    assert.throws(
      () => bar.endArrow.destroy(),
      (error) => error === failure,
    )
    await target.mockMouse.pressDown(bar.startArrow.x, bar.startArrow.y)
    previous()
    assert.equal(bar.scrollPosition, 55)
    assert.equal(timers.pending.size, 1)
    timers.fire(500)
    timers.fire(200)
    assert.equal(bar.scrollPosition, 48)
    await target.mockMouse.release(bar.startArrow.x, bar.startArrow.y)
    assert.equal(timers.pending.size, 0)
  } finally {
    timers.restore()
  }
})

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

test("hiding native arrows stops when the first arrow's blur removes the scrollbar", async () => {
  const { bar } = await setupBar()
  bar.startArrow.focusable = true
  bar.startArrow.focus()
  bar.startArrow.once(RenderableEvents.BLURRED, () => bar.destroyRecursively())
  assert.doesNotThrow(() => {
    bar.showArrows = false
  })
  assert.equal(bar.isDestroyed, true)
  assert.equal(bar.endArrow.isDestroyed, true)
})

test.each(["arrows", "track"])("native %s options stop when a callback removes the owner", async (part) => {
  const { bar } = await setupBar()
  if (part === "arrows") {
    bar.startArrow.focusable = true
    bar.startArrow.focus()
    bar.startArrow.once(RenderableEvents.BLURRED, () => bar.destroyRecursively())
  } else bar.once("change", () => bar.destroyRecursively())
  assert.doesNotThrow(() => {
    if (part === "arrows") bar.arrowOptions = { visible: false }
    else bar.trackOptions = { value: 3, backgroundColor: "red" }
  })
  assert.equal(bar.isDestroyed, true)
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
