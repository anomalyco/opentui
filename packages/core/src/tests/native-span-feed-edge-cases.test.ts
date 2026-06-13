import { test, expect } from "bun:test"
import { NativeSpanFeed } from "../NativeSpanFeed.js"
import { resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()

function writeData(stream: NativeSpanFeed, text: string): void {
  const data = new TextEncoder().encode(text)
  lib.streamWrite(stream.streamPtr, data)
}

function commitData(stream: NativeSpanFeed): void {
  lib.streamCommit(stream.streamPtr)
}

function produceData(stream: NativeSpanFeed, text: string): void {
  writeData(stream, text)
  commitData(stream)
}

test("throwing handler does not prevent state buffer decrements", () => {
  // Decrement must happen even if a handler throws.
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const received: string[] = []
  let shouldThrow = true

  stream.onData((data) => {
    received.push(new TextDecoder().decode(data))
    if (shouldThrow) {
      throw new Error("handler error")
    }
  })

  try {
    produceData(stream, "first")
  } catch {}

  try {
    produceData(stream, "second")
  } catch {}

  expect(received).toContain("first")
  expect(received).toContain("second")
  shouldThrow = false
  produceData(stream, "third")

  try {
    stream.drainAll()
  } catch {}

  expect(received).toContain("third")

  stream.close()
})

test("attach with pre-queued data waits for onData", () => {
  const bootstrap = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1 })
  bootstrap.close()
  const rawPtr = lib.createNativeSpanFeed({
    chunkSize: 128,
    initialChunks: 1,
    autoCommitOnFull: true,
  })
  expect(rawPtr).toBeTruthy()

  const pre = new TextEncoder().encode("pre-attach")
  lib.streamWrite(rawPtr!, pre)
  lib.streamCommit(rawPtr!)

  const stream = NativeSpanFeed.attach(rawPtr!)

  const received: string[] = []
  stream.onData((data) => {
    received.push(new TextDecoder().decode(data))
  })

  stream.drainAll()
  expect(received).toEqual(["pre-attach"])

  produceData(stream, "post-attach")
  stream.drainAll()
  expect(received).toEqual(["pre-attach", "post-attach"])

  stream.close()
})

test("streamWrite accepts empty JS-owned byte slices", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1 })
  const received: string[] = []

  stream.onData((data) => {
    received.push(new TextDecoder().decode(data))
  })

  expect(lib.streamWrite(stream.streamPtr, new Uint8Array())).toBe(0)
  expect(lib.streamWrite(stream.streamPtr, "")).toBe(0)
  expect(lib.streamCommit(stream.streamPtr)).toBe(0)
  stream.drainAll()
  expect(received).toEqual([])

  stream.close()
})

test("streamWrite rejects null pointers for non-zero writes without trapping", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1 })

  const rawStatus = (lib as any).opentui.symbols.streamWrite(stream.streamPtr, null, 1)

  expect(rawStatus).toBe(-3)

  stream.close()
})

test("decrementRefcount with out-of-bounds chunkIndex does not crash or corrupt", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1 })

  const received: string[] = []
  let closedOnSpan = -1

  stream.onData((data) => {
    const text = new TextDecoder().decode(data)
    received.push(text)
    if (closedOnSpan < 0) {
      closedOnSpan = 0
      // Force an empty state buffer to exercise the guard.
      ;(stream as any).stateBuffer = new Uint8Array(0)
    }
  })
  for (let i = 0; i < 5; i++) {
    const msg = new TextEncoder().encode(`s${i}`)
    lib.streamWrite(stream.streamPtr, msg)
    lib.streamCommit(stream.streamPtr)
  }

  stream.drainAll()
  expect(received).toEqual(["s0", "s1", "s2", "s3", "s4"])

  stream.close()
})

test("toArrayBuffer aliases Zig-owned chunk memory", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const received: Uint8Array[] = []
  stream.onData((data) => {
    received.push(data)
  })

  produceData(stream, "hello")
  stream.drainAll()

  expect(received.length).toBe(1)
  const view = received[0]

  const original = view[0]
  const sentinel = original ^ 0xff
  view[0] = sentinel
  expect(view[0]).toBe(sentinel)
  // Restore original value so the chunk data isn't corrupted.
  view[0] = original

  stream.close()
})

test("state buffer view stays current across chunk growth", () => {
  // StateBuffer events must keep the TS view in sync after growth.
  const stream = NativeSpanFeed.create({
    chunkSize: 32,
    initialChunks: 1,
  })

  const allData: string[] = []
  stream.onData((data) => {
    allData.push(new TextDecoder().decode(data))
  })

  for (let i = 0; i < 20; i++) {
    const msg = new TextEncoder().encode(`msg${i.toString().padStart(2, "0")}`)
    lib.streamWrite(stream.streamPtr, msg)
    lib.streamCommit(stream.streamPtr)
  }

  stream.drainAll()

  const allContent = allData.join("")
  for (let i = 0; i < 20; i++) {
    const expected = `msg${i.toString().padStart(2, "0")}`
    expect(allContent).toContain(expected)
  }
  expect(allContent.length).toBe(20 * 5)

  stream.close()
})

test("state buffer view stays current when writes span multiple chunks", () => {
  const chunkSize = 32
  const stream = NativeSpanFeed.create({ chunkSize, initialChunks: 1 })

  const allData: Uint8Array[] = []
  stream.onData((data) => {
    allData.push(new Uint8Array(data)) // copy to avoid aliasing
  })

  const bigWrite = new Uint8Array(256)
  for (let i = 0; i < 256; i++) bigWrite[i] = i & 0xff
  lib.streamWrite(stream.streamPtr, bigWrite)

  lib.streamCommit(stream.streamPtr)
  stream.drainAll()
  const received = new Uint8Array(allData.reduce((sum, d) => sum + d.length, 0))
  let offset = 0
  for (const chunk of allData) {
    received.set(chunk, offset)
    offset += chunk.length
  }

  expect(received.length).toBe(256)
  for (let i = 0; i < 256; i++) {
    expect(received[i]).toBe(i & 0xff)
  }

  stream.close()
})

test("unsubscribing self during onData iteration does not affect other handlers", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const calls: string[] = []

  const unsubA = stream.onData(() => {
    calls.push("A")
    unsubA()
  })
  stream.onData(() => {
    calls.push("B")
  })

  produceData(stream, "msg1")
  stream.drainAll()

  expect(calls).toEqual(["A", "B"])
  produceData(stream, "msg2")
  stream.drainAll()

  expect(calls).toEqual(["A", "B", "B"])

  stream.close()
})

test("unsubscribing a later handler during iteration skips it", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const calls: string[] = []
  let unsubB: (() => void) | null = null

  stream.onData(() => {
    calls.push("A")
    if (unsubB) {
      unsubB()
      unsubB = null
    }
  })

  unsubB = stream.onData(() => {
    calls.push("B")
  })

  produceData(stream, "msg1")
  stream.drainAll()

  expect(calls).toEqual(["A"])
  produceData(stream, "msg2")
  stream.drainAll()

  expect(calls).toEqual(["A", "A"])

  stream.close()
})

test("handler adding a new handler during iteration includes it per Set semantics", () => {
  // Set iteration visits handlers added before they're reached.
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const calls: string[] = []

  let added = false
  stream.onData(() => {
    calls.push("A")
    if (!added) {
      added = true
      stream.onData(() => {
        calls.push("B")
      })
    }
  })

  produceData(stream, "msg1")
  stream.drainAll()

  expect(calls).toEqual(["A", "B"])
  produceData(stream, "msg2")
  stream.drainAll()

  expect(calls).toEqual(["A", "B", "A", "B"])

  stream.close()
})

test("throwing handler does not skip remaining handlers for the same span", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const calls: string[] = []

  stream.onData(() => {
    calls.push("A")
    throw new Error("handler A error")
  })
  stream.onData((data) => {
    calls.push("B:" + new TextDecoder().decode(data))
  })

  let caughtError: unknown
  try {
    produceData(stream, "msg1")
    stream.drainAll()
  } catch (error) {
    caughtError = error
  }
  expect(caughtError).toBeInstanceOf(Error)
  expect((caughtError as Error).message).toBe("handler A error")
  expect(calls).toEqual(["A", "B:msg1"])

  stream.close()
})

test("reentrant drainAll from handler is safely ignored", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const received: string[] = []
  let reentrantCallCount = 0

  stream.onData((data) => {
    received.push(new TextDecoder().decode(data))
    reentrantCallCount++
    stream.drainAll()
  })

  produceData(stream, "msg1")
  produceData(stream, "msg2")
  stream.drainAll()

  expect(received).toContain("msg1")
  expect(received).toContain("msg2")
  expect(received.length).toBe(2)

  stream.close()
})

test("committing during drain does not drop pending spans", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1 })

  const received: string[] = []
  let injected = false

  stream.onData((data) => {
    received.push(new TextDecoder().decode(data))
    if (!injected) {
      injected = true
      const next = new TextEncoder().encode("inner")
      lib.streamWrite(stream.streamPtr, next)
      lib.streamCommit(stream.streamPtr)
    }
  })

  const first = new TextEncoder().encode("outer")
  lib.streamWrite(stream.streamPtr, first)
  lib.streamCommit(stream.streamPtr)
  stream.drainAll()

  expect(received).toEqual(["outer", "inner"])

  stream.close()
})
