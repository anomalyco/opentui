import { test } from "bun:test"
import assert from "node:assert/strict"
import type { BufferAccess } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { withBufferAccess } from "../lib/buffer-access.js"
import { acquireSessionBufferLease } from "../session-buffer.js"
import { NativeSessionRenderStatus, NativeStatus, resolveRenderLib, type NativeSceneFrameRequest } from "../zig.js"

const lib = resolveRenderLib()
const contextOptions = { objectCapacity: 4, renderCellsMax: 16 }
const sessionOptions = { chunkSize: 1024, spanCapacity: 2, maxBytes: 2048n }

test.each(["Session", "Context"] as const)("%s buffer drawing reaches checked terminal output", (owner) => {
  const context = lib.createContext({ ...contextOptions, objectCapacity: 5 })
  const session = lib.createSession(context, sessionOptions)
  const source = owner === "Context" ? lib.createContextBuffer(context, { width: 4, height: 1 }) : undefined
  let frame: NativeSceneFrameRequest | null = null
  const access = <T>(callback: (cells: BufferAccess) => T) =>
    withBufferAccess(
      lib,
      context,
      source
        ? lib.contextAcquireBufferLease(context, source)
        : acquireSessionBufferLease(lib, context, session, "next"),
      callback,
    )
  try {
    assert.throws(() => acquireSessionBufferLease(lib, context, session, "next"), {
      status: NativeStatus.RendererNotAttached,
    })
    lib.sessionAttachRenderer(context, session, { width: 4, height: 1, remote: true })
    if (source) {
      lib.sceneCreateNode(context, session, "root", 1)
      frame = lib.sceneFrameStep(context, session, null, {
        background: RGBA.fromInts(0, 0, 0),
        useMouse: false,
        excludedHitNum: 0,
        maxLayoutRounds: 8,
        maxHostRequests: 64,
      })
      assert.equal(frame.kind, 0)
      lib.contextDrawBuffer(context, source, null, { operation: "clear", background: RGBA.fromInts(68, 85, 102) })
      lib.contextDrawBuffer(context, source, null, {
        operation: "text",
        text: "T\u4e2dZ",
        foreground: RGBA.fromInts(17, 34, 51),
        attributes: 1,
      })
    }
    const copy = access((cells) => {
      assert.deepEqual([cells.width, cells.height, cells.char.length, cells.fg.length], [4, 1, 4, 16])
      if (!source) {
        for (let i = 0; i < 4; i++) {
          cells.char[i] = "TEST".charCodeAt(i)
          cells.fg.set([17, 34, 51, 255], i * 4)
          cells.bg.set([68, 85, 102, 255], i * 4)
          cells.attributes[i] = 1
        }
      }
      access((nested) => {
        assert.deepEqual([...nested.char], [...cells.char])
        assert.equal(nested.generation, cells.generation)
      })
      assert.throws(() => lib.destroyContext(context), { status: NativeStatus.ContextBusy })
      return cells.char.slice()
    })
    if (source) {
      lib.contextDrawBuffer(context, { ...session }, frame, { operation: "compose", source: { ...source } })
      access((cells) => assert.deepEqual(cells.char, copy))
      lib.destroyContextBuffer(context, source)
    }
    assert.equal(
      frame ? lib.sceneFrameCommit(context, session, frame, true) : lib.sessionRender(context, session, true),
      NativeSessionRenderStatus.Pending,
    )
    frame = null
    assert.equal(lib.sessionGetRendererState(context, session).frameCount, 0n)
    for (const which of ["current", "next"] as const) {
      assert.throws(() => acquireSessionBufferLease(lib, context, session, which), {
        status: NativeStatus.OutputBusy,
      })
    }
    const output = new Uint8Array(13)
    const received: number[] = []
    for (let step = 0; step < 256; step++) {
      const ticket = lib.sessionReadOutput(context, session, output)
      if (!ticket) break
      received.push(...output.subarray(0, ticket.byteCount))
      lib.sessionCompleteOutput(context, session, ticket, true)
    }
    const encoded = Buffer.from(received).toString()
    assert.ok(Buffer.from(received).includes(Buffer.from(source ? "\u4e2d" : "TEST")))
    assert.ok(encoded.includes("38;2;17;34;51"))
    assert.ok(encoded.includes("48;2;68;85;102"))
    assert.equal(lib.sessionGetRendererState(context, session).frameCount, 1n)
    withBufferAccess(lib, context, acquireSessionBufferLease(lib, context, session, "current"), (cells) => {
      assert.deepEqual([...cells.char], [...copy])
      assert.deepEqual([...cells.fg.subarray(0, 4)], [17, 34, 51, 255])
      assert.deepEqual([...cells.bg.subarray(0, 4)], [68, 85, 102, 255])
      assert.equal(cells.attributes[0], 1)
    })
    withBufferAccess(lib, context, acquireSessionBufferLease(lib, context, session, "next"), (cells) =>
      assert.equal(cells.char[0], 32),
    )
  } finally {
    if (frame) lib.sceneFrameCancel(context, session, frame.frameId)
    lib.sessionCancel(context, session)
    lib.destroyContext(context)
  }
})

test("Session storage leases reject foreign, wrong-kind, stale, and duplicate handles", () => {
  const context = lib.createContext({ ...contextOptions, objectCapacity: 2 })
  const foreign = lib.createContext(contextOptions)
  const session = lib.createSession(context, sessionOptions)
  try {
    lib.sessionAttachRenderer(context, session, { width: 2, height: 1, remote: true })
    assert.throws(() => lib.sessionAcquireBufferLease(context, session, "invalid" as never), TypeError)
    assert.throws(() => lib.sessionAcquireBufferLease(foreign, session, "next"), {
      status: NativeStatus.WrongContext,
    })
    const lease = lib.sessionAcquireBufferLease(context, session, "next")
    try {
      assert.equal(typeof lease.handle, "object")
      assert.equal(lease.handle.context, context)
      assert.throws(() => lib.contextValidateBufferLease(context, session), { status: NativeStatus.WrongKind })
      assert.throws(() => lib.contextReleaseBufferLease(context, session), { status: NativeStatus.WrongKind })
      assert.throws(() => lib.sessionAcquireBufferLease(context, lease.handle, "next"), {
        status: NativeStatus.WrongKind,
      })
      assert.throws(() => lib.sessionAcquireBufferLease(context, session, "current"), {
        status: NativeStatus.ObjectLimit,
      })
      assert.throws(() => lib.contextValidateBufferLease(foreign, lease.handle), {
        status: NativeStatus.WrongContext,
      })
      assert.throws(() => lib.contextReleaseBufferLease(foreign, lease.handle), {
        status: NativeStatus.WrongContext,
      })
      lib.contextValidateBufferLease(context, { ...lease.handle })
    } finally {
      lib.contextReleaseBufferLease(context, lease.handle)
    }
    assert.throws(() => lib.contextValidateBufferLease(context, lease.handle), { status: NativeStatus.StaleHandle })
    assert.throws(() => lib.contextReleaseBufferLease(context, lease.handle), { status: NativeStatus.StaleHandle })
    withBufferAccess(lib, context, acquireSessionBufferLease(lib, context, session, "current"), (cells) =>
      assert.equal(cells.width, 2),
    )
    lib.sessionClose(context, session)
    assert.throws(() => lib.sessionAcquireBufferLease(context, session, "next"), {
      status: NativeStatus.SessionClosed,
    })
  } finally {
    lib.destroyContext(context)
    lib.destroyContext(foreign)
  }
})

test.each(["Session", "Context"] as const)("%s buffer scopes retain retired storage until exit", (owner) => {
  const context = lib.createContext(contextOptions)
  const target =
    owner === "Context"
      ? lib.createContextBuffer(context, { width: 2, height: 1 })
      : lib.createSession(context, sessionOptions)
  const access = <T>(callback: (cells: BufferAccess) => T) =>
    withBufferAccess(
      lib,
      context,
      owner === "Context"
        ? lib.contextAcquireBufferLease(context, target)
        : acquireSessionBufferLease(lib, context, target, "next"),
      callback,
    )
  let saved: BufferAccess | undefined
  try {
    if (owner === "Session") lib.sessionAttachRenderer(context, target, { width: 2, height: 1, remote: true })
    let generation = 0n
    assert.throws(
      () =>
        access((cells) => {
          saved = cells
          generation = cells.generation
          const chars = cells.char
          chars[0] = 65
          if (owner === "Context") lib.contextResizeBuffer(context, target, 3, 2)
          else lib.sessionResizeRenderer(context, target, 3, 2)
          assert.equal(chars[0], 65)
          assert.equal(cells.char, chars)
          assert.throws(() => lib.destroyContext(context), { status: NativeStatus.ContextBusy })
        }),
      { status: NativeStatus.StaleLease },
    )
    assert.throws(() => saved!.char, /scope has ended/)
    access((cells) => {
      assert.deepEqual([cells.width, cells.height, cells.char.length], [3, 2, 6])
      assert.equal(cells.generation, generation + 1n)
    })
    assert.throws(
      () =>
        access((cells) => {
          const chars = cells.char
          chars[0] = 66
          if (owner === "Context") lib.destroyContextBuffer(context, target)
          else lib.destroySession(context, target)
          assert.equal(chars[0], 66)
          assert.throws(() => lib.destroyContext(context), { status: NativeStatus.ContextBusy })
        }),
      { status: NativeStatus.StaleLease },
    )
    assert.throws(() => access(() => {}), {
      status: NativeStatus.StaleHandle,
    })
  } finally {
    lib.destroyContext(context)
  }
})
