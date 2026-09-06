import { test } from "bun:test"
import assert from "node:assert/strict"
import { RGBA } from "../lib/RGBA.js"
import { NativeStatus, resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()
const options = { objectCapacity: 16, renderCellsMax: 128 }

test("Context image import outlives its compatibility source and rejects stale handles", () => {
  const context = lib.createContext(options)
  const source = lib.imageCreateFromRgba(Uint8Array.of(255, 0, 0, 255), 1, 1, 4).handle!
  try {
    const image = lib.importContextImage(context, source)
    lib.imageDestroy(source)
    const target = lib.createContextBuffer(context, { width: 2, height: 1 })
    assert.equal(lib.contextDrawImage(context, target, null, image, { width: 2, height: 1, protocol: "blocks" }), true)
    assert.equal(lib.contextDrawImage(context, target, null, image, { x: 2, width: 2, height: 1 }), false)
    lib.destroyContextImage(context, image)
    assert.throws(() => lib.contextDrawImage(context, target, null, image, { width: 2, height: 1 }), {
      status: NativeStatus.StaleHandle,
    })
    assert.throws(() => lib.importContextImage(context, source), { status: NativeStatus.StaleHandle })
  } finally {
    lib.imageDestroy(source)
    lib.destroyContext(context)
  }
})

test("Context image transport checks owners kinds optional backing storage and dimensions", () => {
  const context = lib.createContext(options)
  const other = lib.createContext(options)
  const source = lib.imageCreateFromRgba(Uint8Array.of(255, 0, 0, 255), 1, 1, 4).handle!
  try {
    const image = lib.importContextImage(context, source)
    const target = lib.createContextBuffer(context, { width: 2, height: 1 })
    const foreign = lib.createContextBuffer(other, { width: 2, height: 1 })
    const session = lib.createSession(context, { chunkSize: 64, spanCapacity: 16, maxBytes: 1024n })
    lib.sessionAttachRenderer(context, session, { width: 2, height: 1, remote: false, environment: {} })
    lib.sceneCreateNode(context, session, "root", 1)
    const node = lib.sceneCreateNode(context, session, "image", 2)
    lib.sceneSetImage(context, node, image, "cover", "blocks", target)
    lib.sessionSetImageResolution(context, session, 2, 1, 16, 16)
    lib.sessionSetImageResolution(context, session, 0, 0, 0, 0)
    assert.throws(() => lib.sessionSetImageResolution(context, session, 2, 0, 16, 16), {
      status: NativeStatus.InvalidArgument,
    })
    assert.throws(() => lib.sceneSetImage(context, node, image, "fit", "auto", foreign), {
      status: NativeStatus.WrongContext,
    })
    assert.throws(() => lib.sceneSetImage(context, node, image, "fit", "auto", image), {
      status: NativeStatus.WrongKind,
    })
    assert.throws(() => lib.destroyContextImage(context, target as never), { status: NativeStatus.WrongKind })
    assert.throws(() => lib.destroyContextImage(other, image), { status: NativeStatus.WrongContext })
    assert.throws(() => lib.contextDrawImage(context, target, null, target as never, { width: 2, height: 1 }), {
      status: NativeStatus.WrongKind,
    })
    assert.throws(() => lib.contextDrawImage(other, foreign, null, image, { width: 2, height: 1 }), {
      status: NativeStatus.WrongContext,
    })
    for (const width of [-1, 0.5, Number.NaN, 0x1_0000_0000]) {
      assert.throws(() => lib.contextDrawImage(context, target, null, image, { width, height: 1 }), RangeError)
    }
    assert.throws(
      () => lib.contextDrawImage(context, target, null, image, { width: 2, height: 1, x: 0x80000000 }),
      RangeError,
    )
    assert.throws(
      () =>
        lib.contextDrawImage(context, target, null, image, { width: 2, height: 1, protocol: "constructor" as never }),
      TypeError,
    )
    assert.throws(() => lib.sceneSetImage(context, node, image, "bad" as never, "auto", null), TypeError)
    const draw = { width: 2, height: 1, protocol: "blocks" as const }
    assert.throws(() => lib.contextDrawImage(context, session, null, image, draw), { status: NativeStatus.WrongKind })
    const frame = lib.sceneFrameStep(context, session, null, {
      background: RGBA.fromInts(0, 0, 0),
      useMouse: false,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    assert.equal(lib.contextDrawImage(context, session, frame, image, draw), true)
    assert.throws(
      () => lib.contextDrawImage(context, session, { ...frame, frameId: frame.frameId + 1n }, image, draw),
      {
        status: NativeStatus.StaleFrame,
      },
    )
    lib.sceneFrameCancel(context, session, frame.frameId)
    assert.throws(() => lib.contextDrawImage(context, session, frame, image, draw), { status: NativeStatus.StaleFrame })
    lib.destroyContextImage(context, image)
    lib.sceneSetImage(context, node, null, "fill", "auto", null)
    lib.sceneDestroyNode(context, node)
    assert.throws(() => lib.sceneSetImage(context, node, null, "fit", "auto", null), {
      status: NativeStatus.StaleHandle,
    })
  } finally {
    lib.imageDestroy(source)
    lib.destroyContext(context)
    lib.destroyContext(other)
  }
})

test("Context image transport resolves native ownership after draw option getters", () => {
  const context = lib.createContext(options)
  const source = lib.imageCreateFromRgba(Uint8Array.of(255, 0, 0, 255), 1, 1, 4).handle!
  let destroyed = false
  try {
    const image = lib.importContextImage(context, source)
    const target = lib.createContextBuffer(context, { width: 2, height: 1 })
    let reads = 0
    assert.equal(
      lib.contextDrawImage(context, target, null, image, {
        width: 2,
        height: 1,
        get sourceWidth() {
          reads++
          assert.equal(lib.contextDrawImage(context, target, null, image, { width: 2, height: 1, x: 2 }), false)
          return 1
        },
      }),
      true,
    )
    assert.equal(reads, 1)
    assert.throws(
      () =>
        lib.contextDrawImage(context, target, null, image, {
          get width() {
            lib.destroyContext(context)
            destroyed = true
            return 2
          },
          height: 1,
        }),
      { status: NativeStatus.WrongContext },
    )
  } finally {
    lib.imageDestroy(source)
    if (!destroyed) lib.destroyContext(context)
  }
})
