import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { RGBA } from "../lib/RGBA.js"
import { toArrayBuffer } from "../platform/ffi.js"
import { NativeStatus, resolveRenderLib, type NativeContextBufferLease, type NativeSceneFrameRequest } from "../zig.js"

const lib = resolveRenderLib()
const options = {
  background: RGBA.fromInts(0, 0, 0),
  useMouse: true,
  excludedHitNum: 0,
  maxLayoutRounds: 8,
  maxHostRequests: 64,
}

test("Context buffers compose only through current frame tickets and survive source teardown", () => {
  const { context, session, paint } = setup(5)
  const source = lib.createContextBuffer(context, { width: 2, height: 1 })
  try {
    lib.contextDrawBuffer(context, source, null, { operation: "clear", background: RGBA.fromInts(0, 0, 0) })
    lib.contextDrawBuffer(context, source, null, {
      operation: "text",
      text: "\u754c",
      foreground: RGBA.fromInts(255, 255, 255),
    })
    const frame = paint()
    assert.throws(
      () =>
        lib.contextDrawBuffer(
          context,
          session,
          { ...frame, frameId: frame.frameId + 1n },
          {
            operation: "compose",
            source,
          },
        ),
      {
        status: NativeStatus.StaleFrame,
      },
    )
    for (const value of [-0x8000_0001, 0x8000_0000, 0.5, NaN, Infinity, "1", 1n]) {
      assert.throws(
        () => lib.contextDrawBuffer(context, session, frame, { operation: "compose", source, x: value as never }),
        RangeError,
      )
      assert.throws(
        () => lib.contextDrawBuffer(context, session, frame, { operation: "compose", source, y: value as never }),
        RangeError,
      )
    }
    lib.contextDrawBuffer(context, session, frame, { operation: "compose", source, x: 1 })
    lib.destroyContextBuffer(context, source)
    const lease = lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
    try {
      const bytes = new Uint8Array(32)
      const count = lib.contextBufferLeaseWriteResolvedChars(context, lease.handle, bytes, false)
      assert.equal(Buffer.from(bytes.subarray(0, count)).toString(), " \u754c     ")
    } finally {
      lib.contextReleaseBufferLease(context, lease.handle)
    }
    lib.sceneFrameCancel(context, session, frame.frameId)
    assert.throws(() => lib.contextDrawBuffer(context, session, frame, { operation: "compose", source }), {
      status: NativeStatus.StaleFrame,
    })
  } finally {
    lib.destroyContext(context)
  }
})

function setup(objectCapacity = 3) {
  const context = lib.createContext({ objectCapacity, renderCellsMax: 16 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  lib.sessionAttachRenderer(context, session, { width: 4, height: 2, remote: true })
  const root = lib.sceneCreateNode(context, session, "root", 1)
  return { context, session, root, paint: () => lib.sceneFrameStep(context, session, null, options) }
}

test("scene frame replies retain ticket snapshots and apply current paint options", () => {
  const { context, session, root } = setup(4)
  const text = lib.sceneCreateNode(context, session, "text", 2)
  lib.sceneMoveNode(context, text, root, 0)
  lib.sceneSetText(context, text, Buffer.from("test"))
  lib.sceneSetHooks(context, text, 1, 1n, 0, 0)
  try {
    const first = lib.sceneFrameStep(context, session, null, options)
    const saved = { ...first, session: { ...first.session }, root: { ...first.root }, node: { ...first.node } }
    assert.equal(first.kind, 1)
    const background = RGBA.fromInts(31, 47, 63)
    const done = lib.sceneFrameStep(context, session, first, { ...options, background, useMouse: false })
    assert.equal(done.kind, 0)
    assert.deepEqual(first, saved)
    const lease = lib.sceneFrameAcquireBufferLease(context, session, done, "next")
    try {
      const bytes = new Uint8Array(16)
      const count = lib.contextBufferLeaseWriteResolvedChars(context, lease.handle, bytes, false)
      assert.equal(Buffer.from(bytes.subarray(0, count)).toString(), "test    ")
      assert.deepEqual(new Uint16Array(toArrayBuffer(lease.bg, 4 * 8, 8)), background.buffer)
    } finally {
      lib.contextReleaseBufferLease(context, lease.handle)
    }
    lib.sceneFrameCancel(context, session, done.frameId)
    assert.throws(() => lib.sceneFrameStep(context, session, first, options), { status: NativeStatus.StaleFrame })
    assert.throws(() => lib.sceneFrameStep(context, session, null, { ...options, useMouse: 1 as never }), TypeError)
    const next = lib.sceneFrameStep(context, session, null, options)
    assert.notEqual(next.frameId, first.frameId)
    assert.equal(next.kind, 1)
    lib.sceneFrameCancel(context, session, next.frameId)
  } finally {
    lib.destroyContext(context)
  }
})

test("direct scene frame ownership mutations reject measurement in a peer Context", () => {
  const owner = setup()
  const peer = setup(3)
  const measured = lib.sceneCreateNode(owner.context, owner.session, "box", 2)
  lib.sceneMoveNode(owner.context, measured, owner.root, 0)
  const ticket = peer.paint()
  let calls = 0
  try {
    lib.sceneSetMeasure(owner.context, measured, () => {
      calls++
      for (const write of [
        () => lib.sceneFrameCancel(peer.context, peer.session, ticket.frameId),
        () => lib.sceneFrameCommit(peer.context, peer.session, ticket, false),
        () => lib.sceneFrameAcquireBufferLease(peer.context, peer.session, ticket, "next"),
      ])
        assert.throws(write, /Cannot mutate Yoga during a callback/)
      return { width: 2, height: 1 }
    })
    const frame = owner.paint()
    lib.sceneFrameCancel(owner.context, owner.session, frame.frameId)
    assert.ok(calls > 0)
    const lease = lib.sceneFrameAcquireBufferLease(peer.context, peer.session, ticket, "next")
    lib.contextReleaseBufferLease(peer.context, lease.handle)
    lib.sceneFrameCancel(peer.context, peer.session, ticket.frameId)
    assert.doesNotThrow(() => lib.sceneFrameCommit(peer.context, peer.session, peer.paint(), false))
  } finally {
    lib.sessionCancel(peer.context, peer.session)
    lib.destroyContext(peer.context)
    lib.destroyContext(owner.context)
  }
})

test("frame-qualified acquisition rejects a missing ticket instead of borrowing ordinary storage", () => {
  const { context, session } = setup()
  let lease: NativeContextBufferLease | undefined
  try {
    assert.throws(() => {
      lease = lib.sceneFrameAcquireBufferLease(
        context,
        session,
        undefined as unknown as NativeSceneFrameRequest,
        "next",
      )
    })
  } finally {
    if (lease) lib.contextReleaseBufferLease(context, lease.handle)
    lib.destroyContext(context)
  }
})

test.each([false, true])(
  "work-budgeted frame dispatch retains provider and paint-only paths (provider: %s)",
  (provider) => {
    const { context, session, root } = setup(5)
    const node = lib.sceneCreateNode(context, session, "box", 2)
    lib.sceneMoveNode(context, node, root, 0)
    if (provider) lib.sceneSetMeasure(context, node, () => ({ width: 2, height: 1 }))
    const upload = spyOn((lib as any).opentui.symbols, "ot_scene_frame_step_with_geometry")
    try {
      const paintOnly = lib.sceneFrameStep(context, session, null, options, 0xffffffff)
      assert.equal(paintOnly.kind, 0)
      assert.deepEqual(upload.mock.calls[0].slice(4, 6), [0xffffffff, 0xffffffff])
      upload.mockClear()
      lib.sceneFrameCancel(context, session, paintOnly.frameId)
      for (const invalid of [0, -1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
        assert.throws(() => lib.sceneFrameStep(context, session, null, options, undefined, invalid), RangeError)
      }
      assert.equal(upload.mock.calls.length, 0)
      const first = lib.sceneFrameStep(context, session, null, options, undefined, 1)
      assert.equal(first.kind, 6)
      assert.deepEqual(first.node, root)
      assert.deepEqual(upload.mock.calls[0].slice(4, 6), [0xffffffff, 1])
      assert.throws(() => lib.sceneFrameAcquireBufferLease(context, session, first, "next"), {
        status: NativeStatus.StaleFrame,
      })
      assert.throws(
        () =>
          lib.sceneFrameStep(context, session, { ...first, requestId: first.requestId + 1n }, options, undefined, 1),
        { status: NativeStatus.StaleFrame },
      )
      let request = first
      for (let step = 0; step < 16 && request.kind !== 0; step++) {
        const next = lib.sceneFrameStep(context, session, request, options, 1, 1)
        assert.equal(next.frameId, first.frameId)
        if (next.kind !== 0) {
          assert.equal(next.kind, 6)
          assert.ok(next.requestId > request.requestId)
        }
        request = next
      }
      assert.equal(request.kind, 0)
      lib.sceneFrameCancel(context, session, request.frameId)
    } finally {
      upload.mockRestore()
      lib.destroyContext(context)
    }
  },
)

test("painted frame access validates native tickets even when storage generations match", () => {
  const { context, session, paint } = setup()
  try {
    const frame = paint()
    const current = lib.sceneFrameAcquireBufferLease(context, session, frame, "current")
    lib.contextReleaseBufferLease(context, current.handle)
    const next = lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
    try {
      assert.equal(current.generation, next.generation)
      assert.notEqual(current.char, next.char)
      assert.throws(() => lib.sceneFrameCommit(context, session, frame, false), { status: NativeStatus.FrameBusy })
      lib.sceneFrameCancel(context, session, frame.frameId)
      assert.throws(() => lib.contextValidateBufferLease(context, next.handle), { status: NativeStatus.StaleLease })
      assert.throws(() => lib.contextBufferLeaseGetRealCharSize(context, next.handle, true), {
        status: NativeStatus.StaleLease,
      })
      assert.throws(() => lib.sceneFrameAcquireBufferLease(context, session, frame, "next"), {
        status: NativeStatus.StaleFrame,
      })
    } finally {
      lib.contextReleaseBufferLease(context, next.handle)
    }
    const replacement = paint()
    assert.notEqual(replacement.frameId, frame.frameId)
    assert.throws(() => lib.sceneFrameCommit(context, session, frame, false), { status: NativeStatus.StaleFrame })
    lib.sceneFrameCancel(context, session, replacement.frameId)
  } finally {
    lib.destroyContext(context)
  }
})
