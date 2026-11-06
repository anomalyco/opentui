import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { BoxRenderable } from "../renderables/Box.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderEvents } from "../renderer.js"
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
  const target = await createTestRenderer({ width: 20, height: 4, clock: new ManualClock() })
  setups.push(target)
  return target
}

test("positionAnchor suppresses hidden and detached anchor chains without clearing them", async () => {
  const target = await setup()
  const branch = new BoxRenderable(target.renderer, { position: "absolute", left: 2, top: 1, width: 8, height: 2 })
  const anchor = new BoxRenderable(target.renderer, { width: 1, height: 1 })
  const middle = new BoxRenderable(target.renderer, { positionAnchor: anchor, left: 1, width: 2, height: 1 })
  const popup = new TextRenderable(target.renderer, {
    positionAnchor: middle,
    left: 1,
    width: 1,
    height: 1,
    content: "P",
    zIndex: 1,
  })
  branch.add(anchor)
  target.renderer.root.add(popup)
  target.renderer.root.add(middle)
  target.renderer.root.add(branch)
  const attach = (node: BoxRenderable, shown: boolean) =>
    shown ? target.renderer.root.add(node) : target.renderer.root.remove(node)
  const toggles = [
    (shown: boolean) => (branch.visible = shown),
    (shown: boolean) => attach(branch, shown),
    (shown: boolean) => (anchor.visible = shown),
    (shown: boolean) => attach(middle, shown),
  ]
  for (const toggle of toggles)
    for (const shown of [false, true]) {
      toggle(shown)
      await target.renderOnce()
      assert.equal(target.captureCharFrame().includes("P"), shown)
      assert.equal(target.renderer.hitTest(4, 1) === popup.num, shown)
      assert.deepEqual(
        [popup.positionAnchor, middle.positionAnchor, popup.parent],
        [middle, anchor, target.renderer.root],
      )
    }
})

test("positionAnchor follows scrolling without inheriting anchor clipping or changing paint order", async () => {
  const target = await setup()
  const scroll = new ScrollBoxRenderable(target.renderer, {
    position: "absolute",
    left: 3,
    top: 1,
    width: 8,
    height: 2,
    scrollX: true,
    scrollbarOptions: { visible: false },
  })
  const content = new BoxRenderable(target.renderer, { width: 20, height: 10, flexShrink: 0 })
  const anchor = new BoxRenderable(target.renderer, { position: "absolute", left: 2, top: 1, width: 1, height: 1 })
  const popup = new TextRenderable(target.renderer, {
    positionAnchor: anchor,
    left: "right",
    top: "bottom",
    width: 1,
    height: 1,
    content: "P",
    zIndex: 3,
  })
  const clip = new BoxRenderable(target.renderer, {
    position: "absolute",
    left: 8,
    top: 1,
    width: 2,
    height: 2,
    overflow: "hidden",
    zIndex: 2,
  })
  const clipped = new TextRenderable(target.renderer, {
    positionAnchor: anchor,
    left: "right",
    top: "top",
    width: 1,
    height: 1,
    content: "C",
  })
  content.add(anchor)
  scroll.add(content)
  clip.add(clipped)
  target.renderer.root.add(popup)
  target.renderer.root.add(scroll)
  target.renderer.root.add(clip)
  for (const [scrollX, scrollY, clipX, x, y, showClipped] of [
    [0, 0, 8, 6, 3, false],
    [1, 1, 5, 5, 2, true],
    [3, 2, 5, 3, 1, false],
  ] as const) {
    scroll.scrollTo({ x: scrollX, y: scrollY })
    clip.left = clipX
    await target.renderOnce()
    assert.deepEqual([popup.x, popup.y], [x, y])
    assert.equal(target.captureCharFrame().split("\n")[y][x], "P")
    assert.equal(target.renderer.hitTest(x, y), popup.num)
    assert.equal(target.captureCharFrame().includes("C"), showClipped)
    assert.equal(target.renderer.hitTest(x, y - 1) === clipped.num, showClipped)
    assert.equal(popup.parent, target.renderer.root)
    assert.equal(clipped.parent, clip)
  }
})

test("positionAnchor mutations in layout and paint hooks respect the frame boundary", async () => {
  const target = await setup()
  const first = new BoxRenderable(target.renderer, { position: "absolute", left: 2, top: 1, width: 1, height: 1 })
  const second = new BoxRenderable(target.renderer, { position: "absolute", left: 8, top: 1, width: 1, height: 1 })
  const popup = new BoxRenderable(target.renderer, {
    positionAnchor: first,
    left: "right",
    width: 1,
    height: 1,
    zIndex: 1,
    renderBefore() {
      this.positionAnchor = first
    },
  })
  const mark = new TextRenderable(target.renderer, { content: "P", width: 1, height: 1 })
  popup.add(mark)
  let layouts = 0
  target.renderer.root.on("layout-changed", () => {
    layouts++
    popup.positionAnchor = second
  })
  target.renderer.root.add(popup)
  target.renderer.root.add(first)
  target.renderer.root.add(second)
  for (const x of [9, 3]) {
    await target.renderOnce()
    assert.equal(target.captureCharFrame().split("\n")[1].trimEnd(), " ".repeat(x) + "P")
    for (const column of [3, 9]) assert.equal(target.renderer.hitTest(column, 1) === mark.num, column === x)
    assert.equal(popup.positionAnchor?.num, first.num)
  }
  assert.equal(layouts, 1)
  popup.positionAnchor = second
  popup.renderBefore = () => {
    second.visible = false
  }
  await target.renderOnce()
  assert.equal(target.captureCharFrame().split("\n")[1][9], "P")
  assert.equal(target.renderer.hitTest(9, 1), mark.num)
  await target.renderOnce()
  assert.equal(target.captureCharFrame().includes("P"), false)
  assert.notEqual(target.renderer.hitTest(9, 1), mark.num)
})

test("ordinary renderer defaults to native scene ownership and presentation", async () => {
  const target = await setup()
  assert.ok(target.renderer.nativeScene)
  const text = new TextRenderable(target.renderer, { content: "native default", width: 18, height: 1 })
  target.renderer.root.add(text)
  await target.renderOnce()
  assert.ok(target.captureCharFrame().includes("native default"))
  assert.equal(target.renderer.hitTest(1, 0), text.num)
})

test("positionAnchor updates geometry, output, and hits in the current frame", async () => {
  const target = await setup()
  const anchor = new BoxRenderable(target.renderer, { width: 6, height: 1 })
  const popup = new TextRenderable(target.renderer, {
    content: "P",
    width: 1,
    left: 1,
    top: 1,
    positionAnchor: anchor,
  })
  target.renderer.root.flexDirection = "row"
  target.renderer.root.justifyContent = "flex-end"
  target.renderer.root.add(popup)
  target.renderer.root.add(anchor)
  for (const [left, translateX, width, expectedX] of [
    [0, 0, 6, 15],
    [-2, 0, 6, 13],
    [-2, -1, 6, 12],
    [-2, -1, 4, 14],
  ] as const) {
    Object.assign(anchor, { left, translateX, width })
    await target.renderOnce()
    assert.deepEqual([popup.x, popup.y], [expectedX, 1])
    assert.equal(target.captureCharFrame().split("\n")[1].trimEnd(), " ".repeat(expectedX) + "P")
    for (const column of [12, 13, 14, 15]) {
      assert.equal(target.renderer.hitTest(column, 1) === popup.num, column === expectedX)
    }
  }
  target.renderer.root.justifyContent = "flex-start"
  Object.assign(anchor, { left: 2, translateX: 0 })
  popup.setPosition({ left: "right", top: "bottom" })
  for (const [width, height, x, y] of [
    [6, 1, 8, 1],
    [4, 2, 6, 2],
    [4, 2, 6, 2],
  ]) {
    Object.assign(anchor, { width, height })
    await target.renderOnce()
    assert.deepEqual([popup.x, popup.y], [x, y])
    assert.equal(target.captureCharFrame().split("\n")[y].trimEnd(), " ".repeat(x) + "P")
    assert.equal(target.renderer.hitTest(x, y), popup.num)
    assert.notEqual(target.renderer.hitTest(x - 1, y), popup.num)
  }
  const work = target.renderer.getNativeStats().frameWork
  assert.deepEqual([work.candidateVisits, work.yogaSolves], [0, 0])
})

test("positionAnchor percentage insets preserve Yoga sizing and cell placement", async () => {
  const target = await setup()
  const parent = new BoxRenderable(target.renderer, { width: 8, height: 4, zIndex: 1 })
  const anchor = new BoxRenderable(target.renderer, { position: "absolute", left: 2, border: true, padding: 1 })
  const popup = new TextRenderable(target.renderer, {
    content: "P",
    width: "50%",
    height: "25%",
    positionAnchor: anchor,
  })
  parent.add(popup)
  target.renderer.root.add(parent)
  target.renderer.root.add(anchor)
  for (const [insets, width, height, x, y] of [
    [{ left: "50%", top: "50%" }, 6, 5, 5, 2.5],
    [{ left: "auto", top: undefined, right: "25%", bottom: "50%" }, 6, 5, 2.5, 1.5],
    [{ left: "50%", top: "50%" }, 8, 6, 6, 3],
    [{ left: "-31.25%", top: 0 }, 8, 6, -0.5, 0],
  ] as const) {
    popup.setPosition(insets)
    Object.assign(anchor, { width, height })
    await target.renderOnce()
    assert.deepEqual([popup.x, popup.y, popup.width, popup.height], [x, y, 4, 1])
    const [column, row] = [Math.trunc(x), Math.trunc(y)]
    assert.equal(target.captureCharFrame().split("\n")[row][column], "P")
    assert.equal(target.renderer.hitTest(column, row), popup.num)
  }
  await target.renderOnce()
  const work = target.renderer.getNativeStats().frameWork
  assert.deepEqual([work.candidateVisits, work.yogaSolves], [0, 0])
})

test("anchor centering updates placement, output, and hits without Yoga solves", async () => {
  const target = await setup()
  const anchor = new BoxRenderable(target.renderer, { position: "absolute", left: 2, width: 6, height: 4 })
  const popup = new TextRenderable(target.renderer, {
    content: "P",
    width: 1,
    zIndex: 1,
    positionAnchor: anchor,
    anchorCenterX: true,
    anchorCenterY: true,
  })
  target.renderer.root.add(popup)
  target.renderer.root.add(anchor)
  assert.throws(() => Reflect.set(popup, "anchorCenterX", 1), TypeError)
  for (const [index, [centerX, centerY, x, y]] of (
    [
      [true, true, 4.5, 1.5],
      [false, true, 2, 1.5],
      [true, undefined, 4.5, 0],
    ] as const
  ).entries()) {
    Object.assign(popup, { anchorCenterX: centerX, anchorCenterY: centerY })
    await target.renderOnce()
    assert.deepEqual([popup.x, popup.y, popup.anchorCenterY], [x, y, centerY ?? false])
    if (index > 0) assert.equal(target.renderer.getNativeStats().frameWork.yogaSolves, 0)
    const [column, row] = [Math.trunc(x), Math.trunc(y)]
    assert.equal(target.captureCharFrame().split("\n")[row][column], "P")
    assert.equal(target.renderer.hitTest(column, row), popup.num)
  }
  popup.anchorCenterY = true
  popup.top = 1
  await target.renderOnce()
  assert.deepEqual([popup.x, popup.y], [4.5, 1])
  popup.setPosition({ top: undefined })
  popup.positionAnchor = null
  await target.renderOnce()
  assert.deepEqual([popup.x, popup.y, popup.anchorCenterX], [0, 0, true])
  popup.positionAnchor = anchor
  await target.renderOnce()
  assert.deepEqual([popup.x, popup.y], [4.5, 1.5])
  await target.renderOnce()
  const work = target.renderer.getNativeStats().frameWork
  assert.deepEqual([work.candidateVisits, work.yogaSolves], [0, 0])
})

test("renderOnce completes when an active live frame stops after failure", async () => {
  const target = await setup()
  const hold = Promise.withResolvers<void>()
  target.renderer.setFrameCallback(() => hold.promise)
  target.renderer.addPostProcessFn(() => {
    throw new Error("paint failed")
  })
  target.renderer.on(CliRenderEvents.RENDER_ERROR, () => target.renderer.stop())
  target.renderer.start()
  let completed = false
  const frame = target.renderOnce().then(() => {
    completed = true
  })
  try {
    hold.resolve()
    await target.renderer.idle()
    await setImmediate()
    assert.equal(completed, true)
  } finally {
    hold.resolve()
    target.renderer.destroy()
    await frame
  }
})

test("destroying one renderer does not invalidate another", async () => {
  const survivor = await setup()
  const text = new TextRenderable(survivor.renderer, { content: "survivor" })
  survivor.renderer.root.add(text)
  await survivor.renderOnce()
  const doomed = await setup()
  doomed.renderer.root.add(new BoxRenderable(doomed.renderer, { width: 1, height: 1 }))
  await doomed.renderOnce()
  doomed.renderer.destroy()
  doomed.renderer.destroy()
  await doomed.renderer.closed
  text.content = "still usable"
  await survivor.renderOnce()
  assert.ok(survivor.captureCharFrame().includes("still usable"))
})

test("native scene hits cannot target destroyed or foreign nodes before presentation", async () => {
  const target = await setup()
  const peer = await setup()
  const first = new BoxRenderable(target.renderer, { width: 3, height: 2 })
  target.renderer.root.add(first)
  await target.renderOnce()
  assert.equal(target.renderer.hitTest(0, 0), first.num)
  first.destroy()
  const replacement = new BoxRenderable(target.renderer, { width: 3, height: 2 })
  target.renderer.root.add(replacement)
  assert.equal(target.renderer.hitTest(0, 0), 0)
  assert.throws(() => peer.renderer.root.add(replacement), /context|scene|owner/i)
  assert.equal(replacement.parent, target.renderer.root)
  assert.deepEqual(peer.renderer.root.getChildren(), [])
  await target.renderOnce()
  assert.equal(target.renderer.hitTest(0, 0), replacement.num)
})

test("native hover cleanup cannot dispatch to destroyed nodes or publish a later frame", async () => {
  const target = await setup()
  const a = new BoxRenderable(target.renderer, { position: "absolute", left: 0, width: 3, height: 2 })
  const b = new BoxRenderable(target.renderer, { position: "absolute", left: 8, width: 3, height: 2 })
  target.renderer.root.add(a)
  target.renderer.root.add(b)
  await target.renderOnce()
  await target.mockMouse.moveTo(1, 0)
  const events: string[] = []
  a.onMouseOut = () => {
    events.push("out")
    target.renderer.destroy()
  }
  b.onMouseOver = () => events.push(`over:${b.isDestroyed}`)
  target.renderer.on(CliRenderEvents.DESTROY, () => events.push("destroy"))
  target.renderer.on(CliRenderEvents.FRAME, () => events.push("frame"))
  a.left = 8
  b.left = 0
  await target.renderOnce()
  await target.renderer.closed
  assert.deepEqual(events, ["out", "destroy"])
})
