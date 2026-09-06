import { test, expect } from "bun:test"
import { NativeSpanFeed } from "../NativeSpanFeed.js"
import { resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()

test.each([
  { limit: "span", chunkSize: 32, maxBytes: 64n, capacity: 2, chunks: 1, status: -1, texts: ["first", "second"] },
  { limit: "byte", chunkSize: 8, maxBytes: 16n, capacity: 8, chunks: 2, status: -2, texts: ["first---", "second--"] },
])("finite $limit admission includes stalled handlers and retries after completion", async (options) => {
  const stream = NativeSpanFeed.create({
    chunkSize: options.chunkSize,
    initialChunks: 1,
    maxBytes: options.maxBytes,
    spanQueueCapacity: options.capacity,
    autoCommitOnFull: false,
  })
  const gate = Promise.withResolvers<void>()
  const retained: Uint8Array[] = []
  const unsubscribe = stream.onData((data) => {
    retained.push(data)
    return gate.promise
  })

  try {
    for (const text of options.texts) {
      expect(lib.streamWrite(stream.streamPtr, text)).toBe(0)
      expect(lib.streamCommit(stream.streamPtr)).toBe(0)
      stream.drainAll()
    }
    for (let i = 0; i < 20; i++) {
      expect(lib.streamWrite(stream.streamPtr, "blocked!")).toBe(options.status)
      stream.drainAll()
    }
    expect(lib.streamGetStats(stream.streamPtr)?.chunks).toBe(options.chunks)
    expect(retained.map((data) => new TextDecoder().decode(data))).toEqual([...options.texts])
    expect(stream.isBackpressured()).toBe(true)
    gate.resolve()
    await stream.idle()
    unsubscribe()
    let received = ""
    stream.onData((data) => {
      received += new TextDecoder().decode(data)
    })
    expect(lib.streamWrite(stream.streamPtr, "retry")).toBe(0)
    expect(lib.streamCommit(stream.streamPtr)).toBe(0)
    expect(received).toBe("retry")
  } finally {
    gate.resolve()
    stream.close()
    await stream.idle()
  }
})

function writeAndCommit(stream: NativeSpanFeed, data: Uint8Array): void {
  lib.streamWrite(stream.streamPtr, data)
  lib.streamCommit(stream.streamPtr)
}

test("async handler keeps chunk pinned until Promise resolves", async () => {
  // Single chunk forces reuse; async handlers must keep data pinned.
  const stream = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1 })

  let resolveHandler!: () => void
  const handlerDone = new Promise<void>((r) => {
    resolveHandler = r
  })

  let capturedData: Uint8Array | null = null
  let dataValidAtResolve = false

  stream.onData(async (data) => {
    capturedData = data
    const originalBytes = new Uint8Array(data)
    await handlerDone
    dataValidAtResolve = capturedData.every((b, i) => b === originalBytes[i])
  })
  const original = new Uint8Array(64)
  for (let i = 0; i < 64; i++) original[i] = i
  writeAndCommit(stream, original)
  const overwrite = new Uint8Array(64).fill(0xff)
  writeAndCommit(stream, overwrite)
  stream.drainAll()
  resolveHandler()
  await new Promise((r) => setTimeout(r, 10))

  expect(capturedData).not.toBeNull()
  expect(dataValidAtResolve).toBe(true)

  stream.close()
})

test("mixed sync and async handlers on same stream", async () => {
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const syncReceived: string[] = []
  let asyncReceived: string[] = []
  let resolveAsync!: () => void
  const asyncDone = new Promise<void>((r) => {
    resolveAsync = r
  })

  stream.onData((data) => {
    syncReceived.push(new TextDecoder().decode(data))
  })
  stream.onData(async (data) => {
    const text = new TextDecoder().decode(data)
    await asyncDone
    asyncReceived.push(text)
  })

  const msg = new TextEncoder().encode("hello")
  writeAndCommit(stream, msg)
  stream.drainAll()

  expect(syncReceived).toEqual(["hello"])
  expect(asyncReceived).toEqual([])
  resolveAsync()
  await new Promise((r) => setTimeout(r, 10))

  expect(asyncReceived).toEqual(["hello"])

  stream.close()
})

test("async handler rejection still decrements refcount", async () => {
  const stream = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1 })

  stream.onData(async () => {
    throw new Error("async failure")
  })

  const data = new Uint8Array(64).fill(0xaa)
  writeAndCommit(stream, data)
  stream.drainAll()

  await new Promise((r) => setTimeout(r, 10))
  const received: Uint8Array[] = []
  stream.onData((d) => {
    received.push(new Uint8Array(d))
  })

  const data2 = new Uint8Array(64).fill(0xbb)
  writeAndCommit(stream, data2)
  stream.drainAll()

  expect(received.length).toBe(1)
  expect(received[0][0]).toBe(0xbb)

  stream.close()
})

test("sync-only handlers decrement refcount immediately (no regression)", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1 })

  const received: string[] = []
  stream.onData((data) => {
    received.push(new TextDecoder().decode(data))
  })

  const msg1 = new TextEncoder().encode("A".repeat(64))
  writeAndCommit(stream, msg1)
  stream.drainAll()
  const msg2 = new TextEncoder().encode("B".repeat(64))
  writeAndCommit(stream, msg2)
  stream.drainAll()

  expect(received.length).toBe(2)
  expect(received[1]).toBe("B".repeat(64))

  stream.close()
})

test("multiple async handlers all settle before refcount decrement", async () => {
  const stream = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1, maxBytes: 64n, spanQueueCapacity: 1 })

  let resolve1!: () => void
  let resolve2!: () => void
  const done1 = new Promise<void>((r) => {
    resolve1 = r
  })
  const done2 = new Promise<void>((r) => {
    resolve2 = r
  })

  const order: string[] = []

  stream.onData(async (_data) => {
    await done1
    order.push("handler1")
  })

  stream.onData(async (_data) => {
    await done2
    order.push("handler2")
  })

  const data = new Uint8Array(64).fill(0xcc)
  writeAndCommit(stream, data)
  stream.drainAll()

  resolve1()
  await new Promise((r) => setTimeout(r, 10))
  expect(lib.streamWrite(stream.streamPtr, new Uint8Array(64).fill(0xdd))).toBe(-1)
  expect(lib.streamGetStats(stream.streamPtr)?.outstandingBytes).toBe(64n)
  resolve2()
  await new Promise((r) => setTimeout(r, 10))

  expect(order).toEqual(["handler1", "handler2"])

  const received: number[] = []
  stream.onData((d) => {
    received.push(d[0])
  })

  const data2 = new Uint8Array(64).fill(0xdd)
  writeAndCommit(stream, data2)
  stream.drainAll()

  expect(received).toContain(0xdd)

  stream.close()
})
