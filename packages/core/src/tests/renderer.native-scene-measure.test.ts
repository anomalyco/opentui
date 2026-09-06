import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"

import { NativeStatus, resolveRenderLib, type FFIRenderLib } from "../zig.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"

import { RGBA } from "../lib/RGBA.js"

const setups: TestRendererSetup[] = []
async function setup() {
  const target = await createTestRenderer({
    width: 12,
    height: 4,
    clock: new ManualClock(),
  })
  setups.push(target)
  return target
}

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

test("native custom measurement replaces, caches, dirties, and clears the single slot", async () => {
  const { renderer, renderOnce } = await setup()
  const text = new TextRenderable(renderer, { content: "abcdef", selectable: false, alignSelf: "flex-start" })
  renderer.root.add(text)

  let calls = 0
  let width = 3
  text.setMeasureProvider(() => {
    calls++
    return { width, height: 2 }
  })
  await renderOnce()
  assert.equal(text.width, 3)
  assert.equal(text.height, 2)
  await renderOnce()
  const measured = calls
  await renderOnce()
  assert.equal(calls, measured)
  width = 5
  text.requestRender()
  await renderOnce()
  assert.equal(calls, measured)
  assert.equal(text.getLayout().width, 3)
  text.invalidateIntrinsicSize()
  await renderOnce()
  assert.ok(calls > measured)
  assert.equal(text.width, 5)
  text.content = "changed content"
  await renderOnce()
  assert.equal(text.width, 5)
  text.setMeasureProvider(() => ({ width: 2, height: 1 }))
  await renderOnce()
  assert.equal(text.width, 2)
  text.setMeasureProvider(null)
  text.invalidateIntrinsicSize()
  text.content = "not restored"
  await renderOnce()
  assert.equal(text.getLayout().width, 0)
  assert.equal(text.getLayout().height, 0)
})

test.each([false, true])(
  "native measurement exceptions cancel first-call tickets (host request: %s)",
  async (hooks) => {
    const { renderer, renderOnce, captureSpans } = await setup()
    const box = new BoxRenderable(renderer, { width: 2, height: 1, backgroundColor: "red" })
    renderer.root.add(box)
    let frames = 0
    renderer.on(CliRenderEvents.FRAME, () => frames++)
    await renderOnce()
    const before = captureSpans()
    const errors: unknown[] = []
    renderer.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) => errors.push(event.error))
    if (hooks) Object.assign(box, { onUpdate: () => {} })
    box.width = "auto"
    box.height = "auto"
    const failure = new Error("measure failure")

    box.setMeasureProvider(() => {
      throw failure
    })
    await renderOnce()
    assert.deepEqual(errors, [failure])
    assert.equal(frames, 1)
    assert.deepEqual(captureSpans(), before)
    box.setMeasureProvider(() => ({ width: 3, height: 1 }))
    await renderOnce()
    assert.equal(box.height, 1)
    assert.equal(frames, 2)
    assert.deepEqual(errors, [failure])
  },
)

test("native measurement rejects session mutations without poisoning the driver", async () => {
  const { renderer, renderOnce } = await setup()
  const driver = renderer.nativeScene.driver
  const errors: Error[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) => errors.push(event.error))
  const box = new BoxRenderable(renderer, { alignSelf: "flex-start" })
  renderer.root.add(box)

  let calls = 0
  box.setMeasureProvider(() => {
    calls++
    for (const mutate of [
      () => driver.dispose(),
      () => driver.close(),
      () => driver.idle(),
      () => driver.setupTerminal(),
      () => driver.suspend(),
      () => driver.resume(),
      () => driver.attachRenderer({ width: 12, height: 4, remote: true }),
      () => driver.resize(20, 5),
      () => driver.write(new Uint8Array([1])),
      () => driver.render(),
      () => driver.whenPresented(),
    ])
      assert.throws(mutate, /Cannot mutate Yoga during a callback/)
    assert.equal(renderer.isDestroyed, false)
    assert.equal(driver.disposed, false)
    assert.equal(driver.error, null)
    return { width: 3, height: 1 }
  })
  await renderOnce()
  assert.ok(calls > 0)
  assert.equal(box.width, 3)
  assert.equal(box.height, 1)
  box.invalidateIntrinsicSize()
  await renderOnce()
  assert.deepEqual(errors, [])
  assert.equal(driver.error, null)
})

test("native measured leaves reject children and destroyed renderables cannot reuse a provider", async () => {
  const target = await setup()
  const peer = await setup()
  const box = new BoxRenderable(target.renderer, { alignSelf: "flex-start" })
  const child = new BoxRenderable(target.renderer, {})
  const other = new BoxRenderable(peer.renderer, { alignSelf: "flex-start" })

  box.setMeasureProvider(() => ({ width: 3, height: 1 }))
  const scene = target.renderer.nativeScene!
  const registrations = (
    scene.driver.renderLib as unknown as { sceneMeasures: Map<unknown, { nodes: Map<number, unknown> }> }
  ).sceneMeasures.get(scene.driver.context)!.nodes
  assert.equal(registrations.size, 1)
  assert.throws(() => box.add(child), /InvalidArgument/i)
  assert.equal(child.parent, null)
  assert.equal(box.getChildrenCount(), 0)
  box.setMeasureProvider(null)
  assert.equal(registrations.size, 0)
  box.add(child)
  assert.throws(() => box.setMeasureProvider(() => ({ width: 8, height: 1 })), /InvalidArgument/i)
  assert.equal(registrations.size, 0)
  box.remove(child)
  box.setMeasureProvider(() => ({ width: 3, height: 1 }))
  other.setMeasureProvider(() => ({ width: 5, height: 1 }))
  peer.renderer.root.add(other)
  box.destroy()
  assert.equal(registrations.size, 0)
  const reused = new BoxRenderable(target.renderer, { alignSelf: "flex-start" })
  target.renderer.root.add(reused)
  await target.renderOnce()
  assert.equal(reused.getLayout().width, 0)
  assert.throws(() => box.setMeasureProvider(() => ({ width: 7, height: 1 })), /destroyed/)
  assert.throws(() => box.invalidateIntrinsicSize(), /destroyed/)
  assert.throws(() => box.getLayout(), /destroyed/)
  target.renderer.destroy()
  await target.renderer.closed
  await peer.renderOnce()
  assert.equal(other.width, 5)
})

test("destroySession releases only accepted session measurement registrations including detached nodes", () => {
  const lib = resolveRenderLib() as FFIRenderLib
  const context = lib.createContext({ objectCapacity: 8, renderCellsMax: 16 })
  const sessions = [0, 1].map(() => lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n }))
  let peerCalls = 0
  try {
    for (const session of sessions) {
      lib.sessionAttachRenderer(context, session, { width: 4, height: 2, remote: true })
      const root = lib.sceneCreateNode(context, session, "root", 1)
      const attached = lib.sceneCreateNode(context, session, "box", 2)
      lib.sceneMoveNode(context, attached, root, 0)
      lib.sceneSetMeasure(context, attached, () => {
        if (session === sessions[1]) peerCalls++
        return { width: 2, height: 1 }
      })
      const detached = lib.sceneCreateNode(context, session, "box", 3)
      lib.sceneSetMeasure(context, detached, () => ({ width: 3, height: 1 }))
    }
    // Inspect retained registrations rather than relying on nondeterministic GC.
    const registrations = (
      lib as unknown as { sceneMeasures: Map<unknown, { nodes: Map<number, unknown> }> }
    ).sceneMeasures.get(context)!.nodes
    assert.equal(registrations.size, 4)
    lib.sessionWrite(context, sessions[0], new Uint8Array([1]))
    assert.throws(() => lib.destroySession(context, sessions[0]), { status: NativeStatus.ContextBusy })
    assert.equal(registrations.size, 4)
    lib.sessionCancel(context, sessions[0])
    lib.destroySession(context, sessions[0])
    assert.equal(registrations.size, 2)
    const frame = lib.sceneFrameStep(context, sessions[1], null, {
      background: RGBA.fromInts(0, 0, 0),
      useMouse: false,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    assert.equal(frame.kind, 0)
    lib.sceneFrameCancel(context, sessions[1], frame.frameId)
    assert.ok(peerCalls > 0)
    lib.destroySession(context, sessions[1])
    assert.equal(registrations.size, 0)
  } finally {
    lib.destroyContext(context)
  }
})
