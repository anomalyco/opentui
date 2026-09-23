import { test, expect, spyOn } from "bun:test"
import { NativeSpanFeed } from "../NativeSpanFeed.js"
import { resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()

test("failed registration releases the native stream and callback entry", () => {
  const register = lib.registerNativeSpanFeedStream.bind(lib)
  const destroy = spyOn(lib, "destroyNativeSpanFeed")
  const unregister = spyOn(lib, "unregisterNativeSpanFeedStream")
  const registration = spyOn(lib, "registerNativeSpanFeedStream").mockImplementation((ptr, handler) => {
    register(ptr, handler)
    throw new Error("registration failed")
  })
  try {
    expect(() => NativeSpanFeed.create({ chunkSize: 8, initialChunks: 1 })).toThrow("registration failed")
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledTimes(1)
  } finally {
    registration.mockRestore()
    unregister.mockRestore()
    destroy.mockRestore()
  }
})

test("failed attach leaves the caller-owned stream available for destruction", () => {
  const ptr = lib.createNativeSpanFeed({ chunkSize: 8, initialChunks: 1 })
  expect(lib.streamClose(ptr)).toBe(0)
  expect(() => NativeSpanFeed.attach(ptr)).toThrow("Failed to attach stream")
  expect(lib.destroyNativeSpanFeed(ptr)).toBe(0)
})

test("close during a batch releases undispatched spans and waits for delivered data", async () => {
  const ptr = lib.createNativeSpanFeed({ chunkSize: 8, initialChunks: 4, maxBytes: 32n })
  for (let i = 0; i < 4; i++) expect(lib.streamWrite(ptr, new Uint8Array(8).fill(i))).toBe(0)
  const stream = NativeSpanFeed.attach(ptr)
  const gate = Promise.withResolvers<void>()
  let calls = 0
  let validAtCompletion = false
  stream.onData(async (data) => {
    calls++
    stream.close()
    await gate.promise
    validAtCompletion = data.every((byte) => byte === 0)
  })
  expect(calls).toBe(1)
  expect(lib.streamGetStats(ptr)?.outstandingSpans).toBe(1)
  expect(lib.destroyNativeSpanFeed(ptr)).toBe(-5)
  gate.resolve()
  await stream.idle()
  expect(validAtCompletion).toBe(true)
  expect((stream as any).destroyed).toBe(true)
})

function nextTick(): Promise<void> {
  // Use a timer turn instead of process.nextTick so Promise/microtask work
  // from async handlers and close deferral can settle before assertions.
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const enum EventId {
  Closed = 5,
}

test("streamClose emits Closed once", () => {
  const events: number[] = []

  const streamPtr = lib.createNativeSpanFeed(null)
  expect(streamPtr).not.toBe(0)
  expect(streamPtr).not.toBeNull()
  lib.registerNativeSpanFeedStream(streamPtr!, (eventId) => {
    events.push(Number(eventId))
  })
  expect(lib.attachNativeSpanFeed(streamPtr!)).toBe(0)

  expect(lib.streamClose(streamPtr!)).toBe(0)
  expect(lib.streamClose(streamPtr!)).toBe(0)
  lib.unregisterNativeSpanFeedStream(streamPtr!)
  lib.destroyNativeSpanFeed(streamPtr!)

  const closedEvents = events.filter((id) => id === EventId.Closed).length
  expect(closedEvents).toBe(1)
})

test("destroyNativeSpanFeed emits Closed when needed", () => {
  const events: number[] = []

  const streamPtr = lib.createNativeSpanFeed(null)
  expect(streamPtr).not.toBe(0)
  expect(streamPtr).not.toBeNull()
  lib.registerNativeSpanFeedStream(streamPtr!, (eventId) => {
    events.push(Number(eventId))
  })
  expect(lib.attachNativeSpanFeed(streamPtr!)).toBe(0)
  lib.destroyNativeSpanFeed(streamPtr!)

  const closedEvents = events.filter((id) => id === EventId.Closed).length
  expect(closedEvents).toBe(1)
})

test("close should not destroy immediately while async handler is still pending", async () => {
  const stream = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1 })
  const ptr = stream.streamPtr

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  let handlerStarted = false
  let handlerSettled = false

  stream.onData(async (_data) => {
    handlerStarted = true
    await gate
    handlerSettled = true
  })

  const payload = new Uint8Array(64).fill(0xaa)
  lib.streamWrite(ptr, payload)
  lib.streamCommit(ptr)
  stream.drainAll()

  expect(handlerStarted).toBe(true)

  stream.close()

  const destroyedImmediately = (stream as any).destroyed === true

  release()
  await nextTick()

  expect(handlerSettled).toBe(true)

  try {
    expect(destroyedImmediately).toBe(false)
  } finally {
    if (!(stream as any).destroyed) {
      lib.destroyNativeSpanFeed(ptr)
    }
  }
})

test("close should not destroy when native close reports Busy", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1, autoCommitOnFull: false })
  const ptr = stream.streamPtr

  const reserve = lib.streamReserve(ptr, 1)
  expect(reserve.status).toBe(0)

  try {
    stream.close()
  } catch {
    // If close starts throwing on Busy, that's acceptable for this assertion.
  }

  const destroyedAfterBusyClose = (stream as any).destroyed === true

  try {
    expect(destroyedAfterBusyClose).toBe(false)
  } finally {
    if (!(stream as any).destroyed) {
      lib.streamCommitReserved(ptr, 0)
      stream.close()
      expect((stream as any).destroyed).toBe(true)
    }
  }
})
