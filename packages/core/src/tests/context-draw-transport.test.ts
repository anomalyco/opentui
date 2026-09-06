import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { RGBA } from "../lib/RGBA.js"
import { withBufferAccess } from "../lib/buffer-access.js"
import { NativeStatus, resolveRenderLib, type NativeBufferDraw } from "../zig.js"

const lib = resolveRenderLib()
const red = RGBA.fromInts(255, 0, 0)
const blue = RGBA.fromInts(0, 0, 255)

test("drawing transport clears optional values between operations", () => {
  const context = lib.createContext({ objectCapacity: 8, renderCellsMax: 16 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  lib.sessionAttachRenderer(context, session, { width: 4, height: 1, remote: true })
  lib.sceneCreateNode(context, session, "root", 1)
  const source = lib.createContextBuffer(context, { width: 4, height: 1 })
  const draw = spyOn((lib as any).opentui.symbols, "ot_buffer_draw")
  try {
    const frame = lib.sceneFrameStep(context, session, null, {
      background: red,
      useMouse: true,
      excludedHitNum: 0,
      maxLayoutRounds: 8,
      maxHostRequests: 64,
    })
    lib.contextDrawBuffer(context, session, frame, {
      operation: "compose",
      source,
      sourceWidth: 1,
      sourceHeight: 1,
      background: red,
      titleColor: red,
      borderChars: new Uint32Array(11).fill(65),
    })
    lib.contextDrawBuffer(context, session, frame, {
      operation: "text",
      text: "test",
      foreground: blue,
    })
    const lease = lib.sceneFrameAcquireBufferLease(context, session, frame, "next")
    try {
      const bytes = new Uint8Array(4)
      assert.equal(lib.contextBufferLeaseWriteResolvedChars(context, lease.handle, bytes, false), 4)
      assert.equal(Buffer.from(bytes).toString(), "test")
    } finally {
      lib.contextReleaseBufferLease(context, lease.handle)
    }
    lib.sceneFrameCancel(context, session, frame.frameId)
    assert.throws(() => lib.contextDrawBuffer(context, session, frame, { operation: "clear" }), {
      status: NativeStatus.StaleFrame,
    })
    const reads: string[] = []
    lib.contextDrawBuffer(context, source, null, {
      operation: "fill",
      width: 4,
      height: 1,
      background: blue,
      get text() {
        reads.push("text")
        return ""
      },
      get bottomTitle() {
        reads.push("bottom")
        return ""
      },
    })
    assert.deepEqual(reads, ["text", "bottom"])
    withBufferAccess(lib, context, lib.contextAcquireBufferLease(context, source), (cells) =>
      assert.deepEqual([...cells.bg.slice(0, 4)], [...blue.buffer]),
    )
    const invalid = RGBA.fromInts(1, 2, 3)
    invalid.buffer[2] = 256
    const calls = draw.mock.calls.length
    assert.throws(
      () =>
        lib.contextDrawBuffer(context, source, null, {
          operation: "text",
          text: "bad!",
          foreground: invalid,
        }),
      /Invalid terminal color intent/,
    )
    assert.equal(draw.mock.calls.length, calls)
    lib.contextDrawBuffer(context, source, null, { operation: "clear" })
    withBufferAccess(lib, context, lib.contextAcquireBufferLease(context, source), (cells) =>
      assert.deepEqual([...cells.bg], Array(16).fill(0)),
    )
  } finally {
    draw.mockRestore()
    lib.destroyContext(context)
  }
})

test.each(["handle", "options"] as const)("drawing transport isolates %s reentry", (phase) => {
  const context = lib.createContext({ objectCapacity: 4, renderCellsMax: 16 })
  const first = lib.createContextBuffer(context, { width: 4, height: 1 })
  const second = lib.createContextBuffer(context, { width: 4, height: 1 })
  const nested = () =>
    lib.contextDrawBuffer(context, second, null, {
      operation: "text",
      text: "peer",
      foreground: blue,
    })
  try {
    lib.contextDrawBuffer(
      context,
      phase === "handle"
        ? {
            ...first,
            get slot() {
              nested()
              return first.slot
            },
          }
        : first,
      null,
      {
        operation: "text",
        text: "self",
        get foreground() {
          if (phase === "options") nested()
          return red
        },
      },
    )
    for (const [buffer, text, color] of [
      [first, "self", red],
      [second, "peer", blue],
    ] as const) {
      withBufferAccess(lib, context, lib.contextAcquireBufferLease(context, buffer), (cells) => {
        assert.equal(String.fromCodePoint(...cells.char), text)
        assert.deepEqual([...cells.fg.slice(0, 4)], [...color.buffer])
      })
    }
    const invalid: NativeBufferDraw = { operation: "fill", width: 4, height: 1, background: red, x: Infinity }
    assert.throws(() => lib.contextDrawBuffer(context, first, null, invalid), RangeError)
    lib.contextDrawBuffer(context, first, null, { operation: "text", text: "next", foreground: blue })
    withBufferAccess(lib, context, lib.contextAcquireBufferLease(context, first), (cells) =>
      assert.equal(String.fromCodePoint(...cells.char), "next"),
    )
  } finally {
    lib.destroyContext(context)
  }
})

test.each(["draw", "layout"] as const)("%s transport rejects an owner destroyed during encoding", (operation) => {
  const context = lib.createContext({ objectCapacity: 4, renderCellsMax: 16 })
  const session = lib.createSession(context, { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n })
  lib.sessionAttachRenderer(context, session, { width: 4, height: 1, remote: true })
  const node = lib.sceneCreateNode(context, session, "root", 1)
  const symbol = operation === "draw" ? "ot_buffer_draw" : "ot_scene_get_layout"
  const call = spyOn((lib as any).opentui.symbols, symbol)
  let destroyed = false
  const destroy = () => {
    lib.destroyContext(context)
    destroyed = true
  }
  try {
    assert.throws(
      () =>
        operation === "draw"
          ? lib.contextDrawBuffer(context, session, null, {
              operation: "text",
              get bottomTitle() {
                destroy()
                return ""
              },
            })
          : lib.sceneGetLayout(context, {
              ...node,
              get generation() {
                destroy()
                return node.generation
              },
            }),
      { status: NativeStatus.WrongContext },
    )
    assert.equal(call.mock.calls.length, 0)
  } finally {
    call.mockRestore()
    if (!destroyed) lib.destroyContext(context)
  }
})
