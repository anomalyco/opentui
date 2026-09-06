import { afterEach, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { NativeSession } from "../NativeSession.js"
import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { getYogaNode } from "../lib/renderable-layout.js"
import { CliRenderEvents } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { wrapWithDelegates } from "../renderables/composition/vnode.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererOptions, type TestRendererSetup } from "../testing/test-renderer.js"
import { createTestStdout } from "../testing/test-streams.js"
import { NATIVE_SCENE_MUTATIONS_MAX, NativeStatus } from "../zig.js"

const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup(options: TestRendererOptions = {}) {
  const target = await createTestRenderer({ width: 16, height: 8, clock: new ManualClock(), ...options })
  setups.push(target)
  const errors: unknown[] = []
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  return {
    ...target,
    async frame() {
      await target.renderOnce()
      assert.deepEqual(errors, [])
      return target.captureSpans()
    },
  }
}

test("ordinary setters coalesce into one native admission and publish the final value", async () => {
  const target = await setup()
  const box = new BoxRenderable(target.renderer, { width: 4, height: 1 })
  target.renderer.root.add(box)
  await target.frame()
  const flush = spyOn(target.renderer.nativeScene.driver.renderLib, "sceneFlush")
  try {
    for (let index = 0; index < 8; index++) box.backgroundColor = RGBA.fromInts(index + 1, 0, 0)
    box.width = 6
    box.zIndex = 3
    assert.equal(flush.mock.calls.length, 0)
    assert.deepEqual(box.backgroundColor.toInts(), [8, 0, 0, 255])
    const cells = await target.frame()
    assert.equal(flush.mock.calls.length, 1)
    assert.equal(box.width, 6)
    assert.deepEqual(cells.lines[0].spans[0].bg.toInts(), [8, 0, 0, 255])
  } finally {
    flush.mockRestore()
  }
})

test("a rejected position edge stages none of its siblings", async () => {
  const target = await setup()
  const box = new BoxRenderable(target.renderer, { width: 4, height: 1, position: "absolute" })
  target.renderer.root.add(box)
  await target.frame()
  assert.throws(() => box.setPosition({ left: 4, top: Infinity }), RangeError)
  assert.equal(target.renderer.nativeScene.hasStagedMutations, false)
  await target.frame()
  assert.equal(box.x, 0)
  box.setPosition({ left: 2, top: 1 })
  await target.frame()
  assert.deepEqual([box.x, box.y], [2, 1])
})

test("background coalescing requires no spare Context objects", async () => {
  const stdout = createTestStdout(8, 2)
  const driver = new NativeSession(stdout, { context: { objectCapacity: 8, renderCellsMax: 32 } })
  const target = await setup({ width: 8, height: 2, nativeSession: driver, stdout, bufferedOutput: "stdout" })
  const boxes: BoxRenderable[] = []
  let full = false
  for (let index = 0; index < 8; index++) {
    try {
      const box = new BoxRenderable(target.renderer, { width: 1, height: 1 })
      target.renderer.root.add(box)
      boxes.push(box)
    } catch (error) {
      assert.equal((error as { status: NativeStatus }).status, NativeStatus.ObjectLimit)
      full = true
      break
    }
  }
  assert.equal(full, true)
  target.renderer.nativeScene.flushStaged()
  for (let index = 0; index < NATIVE_SCENE_MUTATIONS_MAX; index++) {
    boxes[index % boxes.length].backgroundColor = "red"
  }
  target.renderer.nativeScene.flushStaged()
  assert.equal(target.renderer.nativeScene.hasStagedMutations, false)
  // Capturing the result needs a lease object; mutation admission above must not.
  boxes.pop()!.destroy()
  const cells = await target.frame()
  assert.deepEqual(cells.lines[0].spans[0].bg.toInts(), [255, 0, 0, 255])
})

test("measurement callbacks observe staged writes in another scene without flushing unrelated frames", async () => {
  const target = await setup()
  const peer = await setup()
  const peerBox = new BoxRenderable(peer.renderer, { width: 2, height: 1 })
  peer.renderer.root.add(peerBox)
  await peer.frame()
  peerBox.width = 7
  await target.frame()
  assert.equal(peer.renderer.nativeScene.hasStagedMutations, true)
  const box = new BoxRenderable(target.renderer, { alignSelf: "flex-start" })
  box.setMeasureProvider(() => ({ width: getYogaNode(peerBox).getWidth().value, height: 1 }))
  target.renderer.root.add(box)
  await target.frame()
  assert.equal(box.width, 7)
})

test("lifecycle-created class fields survive early attachment and base-constructor hook refresh", async () => {
  const target = await setup()
  const calls: string[] = []
  class Attached extends BoxRenderable {
    constructor(...args: ConstructorParameters<typeof BoxRenderable>) {
      super(...args)
      target.renderer.root.add(this)
      this.refreshHooks()
    }
  }
  // Preserve JavaScript DefineField semantics rather than transpiled assignments.
  const Child = new Function(
    "Base",
    "color",
    "calls",
    `return class extends Base {
      onLifecyclePass = () => calls.push("child")
      onUpdate = () => calls.push("update")
      renderSelf = (buffer) => buffer.drawText("F", this.x, this.y, color)
    }`,
  )(Attached, RGBA.fromInts(255, 255, 255), calls) as typeof Attached
  const parent = new BoxRenderable(target.renderer, { width: 3, height: 1 })
  parent.onLifecyclePass = () => {
    parent.onLifecyclePass = null
    new Child(target.renderer, { width: 2, height: 1 })
  }
  target.renderer.root.add(parent)
  await target.frame()
  assert.deepEqual(calls, ["child", "update"])
  assert.equal(target.captureCharFrame().split("\n")[1].trimEnd(), "F")
})

test("delegated class-field lifecycle runs once and stops on removal", async () => {
  const target = await setup()
  const calls: BoxRenderable[] = []
  const Custom = new Function(
    "Base",
    "calls",
    `return class extends Base {
      onLifecyclePass = function() { calls.push(this) }
    }`,
  )(BoxRenderable, calls) as typeof BoxRenderable
  const attached = wrapWithDelegates(new Custom(target.renderer, { width: 4, height: 2 }), { focus: "inner" })
  try {
    target.renderer.root.add(attached)
    await target.frame()
    assert.deepEqual(calls, [attached])
    target.renderer.root.remove(attached)
    await target.frame()
    assert.deepEqual(calls, [attached])
  } finally {
    attached.destroyRecursively()
  }
})

test("nested Text construction does not discover unfinished detached class fields", async () => {
  const target = await setup()
  const Outer = new Function(
    "Base",
    "Text",
    `return class extends Base {
      renderSelf
      constructor(ctx, options) {
        super(ctx, options)
        const label = new Text(ctx, { content: "nested", width: 6, height: 1 })
        this.renderSelf = () => {}
        this.add(label)
      }
    }`,
  )(BoxRenderable, TextRenderable) as typeof BoxRenderable
  const parent = new BoxRenderable(target.renderer, { width: 8, height: 2 })
  target.renderer.root.add(parent)
  parent.onLifecyclePass = () => {
    parent.onLifecyclePass = null
    parent.add(new Outer(target.renderer, { width: 8, height: 1 }))
  }
  await target.frame()
  assert.ok(target.captureCharFrame().includes("nested"))
})

test("explicit hook refresh preserves reentrant callback assignment without rescanning warm frames", async () => {
  const target = await setup()
  const box = new BoxRenderable(target.renderer, { width: 2, height: 1 })
  target.renderer.root.add(box)
  await target.frame()
  let reads = 0
  let updates = 0
  Object.defineProperty(box, "renderAfter", {
    configurable: true,
    get() {
      if (++reads === 1) Object.assign(box, { onUpdate: () => updates++ })
      return (buffer: OptimizedBuffer) => buffer.drawText("G", box.x, box.y, RGBA.fromInts(255, 255, 255))
    },
  })
  await target.frame()
  assert.equal(reads, 0)
  box.refreshHooks()
  const snapshotReads = reads
  for (let frame = 0; frame < 2; frame++) {
    box.backgroundColor = RGBA.fromInts(frame + 1, 0, 0)
    await target.frame()
    assert.equal(reads, snapshotReads)
    assert.equal(updates, frame + 1)
    assert.equal(target.captureCharFrame().split("\n")[0].trimEnd(), "G")
  }
})
