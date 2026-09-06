import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { RGBA } from "../lib/RGBA.js"
import { NativeStatus, resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()
const options = {
  background: RGBA.fromInts(0, 0, 0),
  useMouse: false,
  excludedHitNum: 0,
  maxLayoutRounds: 8,
  maxHostRequests: 64,
}

function setup(objectCapacity = 6) {
  const context = lib.createContext({ objectCapacity, renderCellsMax: 16 })
  try {
    const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
    lib.sessionAttachRenderer(context, session, { width: 4, height: 2, remote: true })
    const root = lib.sceneCreateNode(context, session, "root", 1)
    const node = lib.sceneCreateNode(context, session, "box", 2)
    lib.sceneMoveNode(context, node, root, 0)
    return { context, session, root, node }
  } catch (error) {
    lib.destroyContext(context)
    throw error
  }
}

test("frame replies carry separate prepared and public geometry at the delivered phase", () => {
  const { context, session, root, node } = setup()
  try {
    lib.sceneSetHooks(context, root, 1 | 2, 1n, 0, 0)
    lib.sceneSetHooks(context, node, 8 | 16, 1n, 0, 0)
    let frame = lib.sceneFrameStep(context, session, null, options)
    const kinds: number[] = []
    while (frame.kind !== 0) {
      kinds.push(frame.kind)
      assert.deepEqual(frame.paintLayout, lib.sceneGetLayout(context, frame.node, "paint"))
      assert.deepEqual(frame.publicLayout, lib.sceneGetLayout(context, frame.node))
      if (frame.kind === 1) assert.equal(frame.publicLayout!.width, 0)
      if (frame.kind === 2) assert.equal(frame.publicLayout!.width, 4)
      frame = lib.sceneFrameStep(context, session, frame, options)
    }
    assert.deepEqual(kinds, [1, 2, 4, 5])
    assert.equal(frame.paintLayout, undefined)
    assert.equal(frame.publicLayout, undefined)
    lib.sceneFrameCancel(context, session, frame.frameId)
  } finally {
    lib.destroyContext(context)
  }
})

test("frame geometry snapshots survive scratch reuse and omit destroyed continuations", () => {
  const { context, session, node } = setup()
  try {
    lib.sceneSetHooks(context, node, 8 | 16, 1n, 0, 0)
    const before = lib.sceneFrameStep(context, session, null, options)
    assert.equal(before.kind, 4)
    const saved = structuredClone(before.publicLayout)
    assert.equal(saved?.width, 4)
    lib.sceneDestroyNode(context, node)
    const after = lib.sceneFrameStep(context, session, before, options)
    assert.equal(after.kind, 5)
    assert.equal(after.paintLayout, undefined)
    assert.equal(after.publicLayout, undefined)
    assert.deepEqual(before.publicLayout, saved)
    lib.sceneFrameCancel(context, session, after.frameId)
  } finally {
    lib.destroyContext(context)
  }
})

test("scene destruction removes only the accepted measurement registration", () => {
  const { context, session, root, node } = setup()
  const second = lib.sceneCreateNode(context, session, "box", 3)
  lib.sceneMoveNode(context, second, root, 1)
  lib.sceneSetMeasure(context, node, () => ({ width: 1, height: 1 }))
  let measures = 0
  lib.sceneSetMeasure(context, second, () => {
    measures++
    return { width: 2, height: 1 }
  })
  const symbols = (lib as any).opentui.symbols
  const native = symbols.ot_scene_destroy_node
  const destroy = spyOn(symbols, "ot_scene_destroy_node")
  try {
    destroy.mockImplementation(() => NativeStatus.InternalError)
    assert.throws(() => lib.sceneDestroyNode(context, node), { status: NativeStatus.InternalError })
    assert.equal(lib.sceneHasMeasure(context, node), true)
    destroy.mockImplementation(native)
    lib.sceneDestroyNode(context, node)
    const frame = lib.sceneFrameStep(context, session, null, options)
    lib.sceneFrameCancel(context, session, frame.frameId)
    assert.ok(measures > 0)
    assert.equal(lib.sceneHasMeasure(context, second), true)
    lib.sceneDestroyNode(context, second)
    assert.throws(() => lib.sceneHasMeasure(context, second), { status: NativeStatus.StaleHandle })
  } finally {
    destroy.mockRestore()
    lib.destroyContext(context)
  }
})
