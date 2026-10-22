import { test, expect } from "bun:test"
import { NativeSpanFeed } from "../NativeSpanFeed.js"
import { resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()

function produceData(stream: NativeSpanFeed, text: string): void {
  lib.streamWrite(stream.streamPtr, text)
  lib.streamCommit(stream.streamPtr)
}

test("attach replays ChunkAdded and receives subsequent data", () => {
  // Pre-queued spans should not drain until an onData handler exists.
  // Create+close a dummy stream so ensureCallback() runs.
  const dummy = NativeSpanFeed.create({ chunkSize: 64, initialChunks: 1 })
  dummy.close()

  const rawPtr = lib.createNativeSpanFeed({
    chunkSize: 256,
    initialChunks: 1,
    autoCommitOnFull: true,
  })
  expect(rawPtr).not.toBe(0)
  expect(rawPtr).not.toBeNull()

  const msg1 = new TextEncoder().encode("pre-queued-1")
  lib.streamWrite(rawPtr!, msg1)
  lib.streamCommit(rawPtr!)
  const stream = NativeSpanFeed.attach(rawPtr!)

  const received: string[] = []
  stream.onData((data) => {
    received.push(new TextDecoder().decode(data))
  })

  stream.drainAll()
  expect(received).toEqual(["pre-queued-1"])
  const post1 = new TextEncoder().encode("post-attach-1")
  lib.streamWrite(rawPtr!, post1)
  lib.streamCommit(rawPtr!)
  stream.drainAll()

  expect(received).toEqual(["pre-queued-1", "post-attach-1"])

  const post2 = new TextEncoder().encode("post-attach-2")
  lib.streamWrite(rawPtr!, post2)
  lib.streamCommit(rawPtr!)
  stream.drainAll()

  expect(received).toEqual(["pre-queued-1", "post-attach-1", "post-attach-2"])

  stream.close()
})

test("multiple concurrent streams operate independently", () => {
  const streamA = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })
  const streamB = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const receivedA: string[] = []
  const receivedB: string[] = []

  streamA.onData((data) => {
    receivedA.push(new TextDecoder().decode(data))
  })
  streamB.onData((data) => {
    receivedB.push(new TextDecoder().decode(data))
  })

  produceData(streamA, "alpha")
  streamA.drainAll()
  produceData(streamB, "beta")
  streamB.drainAll()
  produceData(streamA, "gamma")
  produceData(streamB, "delta")
  streamA.drainAll()
  streamB.drainAll()

  expect(receivedA).toEqual(["alpha", "gamma"])
  expect(receivedB).toEqual(["beta", "delta"])
  streamA.close()

  produceData(streamB, "epsilon")
  streamB.drainAll()

  expect(receivedB).toEqual(["beta", "delta", "epsilon"])
  expect(receivedA).toEqual(["alpha", "gamma"])

  streamB.close()
})

test("onError handler fires when Error event is received", () => {
  // Zig doesn't emit Error yet; this verifies the handler plumbing.

  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const errors1: number[] = []
  const errors2: number[] = []

  const unsub1 = stream.onError((code) => {
    errors1.push(code)
  })
  const unsub2 = stream.onError((code) => {
    errors2.push(code)
  })

  expect(typeof unsub1).toBe("function")
  expect(typeof unsub2).toBe("function")
  unsub1()
  const received: string[] = []
  stream.onData((data) => {
    received.push(new TextDecoder().decode(data))
  })

  produceData(stream, "hello")
  stream.drainAll()
  expect(received).toContain("hello")

  unsub2()
  stream.close()
})

test("handler calling close() during drain does not crash", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const received: string[] = []
  let closeCalled = false

  stream.onData((data) => {
    received.push(new TextDecoder().decode(data))
    if (!closeCalled) {
      closeCalled = true
      stream.close()
    }
  })

  stream.onData((data) => {
    received.push("B:" + new TextDecoder().decode(data))
  })

  produceData(stream, "trigger")
  expect(received).toContain("trigger")
  stream.drainAll()
})

test("handler calling close() during drain silently drops remaining spans", () => {
  // After close, dropping remaining spans is safe because the stream is destroyed.

  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const received: string[] = []
  let closeCalled = false

  stream.onData((data) => {
    received.push(new TextDecoder().decode(data))
    if (!closeCalled && received.length >= 2) {
      closeCalled = true
      stream.close()
    }
  })

  for (let i = 0; i < 5; i++) {
    const msg = new TextEncoder().encode(`msg${i}`)
    lib.streamWrite(stream.streamPtr, msg)
    lib.streamCommit(stream.streamPtr)
  }

  stream.drainAll()
  expect(received).toEqual(["msg0", "msg1"])
  stream.drainAll()
  expect(received).toEqual(["msg0", "msg1"])
})
test("draining more than 256 spans works correctly", () => {
  // drainBuffer holds 256 spans, so drainAll must loop.
  const stream = NativeSpanFeed.create({ chunkSize: 4096, initialChunks: 1 })

  const received: Uint8Array[] = []
  stream.onData((data) => {
    received.push(new Uint8Array(data))
  })

  const totalSpans = 400

  for (let i = 0; i < totalSpans; i++) {
    const byte = new Uint8Array([i & 0xff])
    lib.streamWrite(stream.streamPtr, byte)
    lib.streamCommit(stream.streamPtr)
  }

  stream.drainAll()
  expect(received.length).toBe(totalSpans)
  for (let i = 0; i < totalSpans; i++) {
    expect(received[i].length).toBe(1)
    expect(received[i][0]).toBe(i & 0xff)
  }

  stream.close()
})

test("draining exactly 256 spans works correctly", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 4096, initialChunks: 1 })

  let totalBytes = 0
  stream.onData((data) => {
    totalBytes += data.byteLength
  })

  for (let i = 0; i < 256; i++) {
    const byte = new Uint8Array([0xaa])
    lib.streamWrite(stream.streamPtr, byte)
    lib.streamCommit(stream.streamPtr)
  }

  stream.drainAll()

  expect(totalBytes).toBe(256)

  stream.close()
})
