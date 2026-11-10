import { test, expect } from "bun:test"
import { NativeSpanFeed } from "../NativeSpanFeed.js"
import { resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()

test("close clears chunkMap and internal state", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  const retained: Uint8Array[] = []
  stream.onData((data) => {
    retained.push(data)
  })

  const data = new TextEncoder().encode("hello world")
  lib.streamWrite(stream.streamPtr, data)
  lib.streamCommit(stream.streamPtr)
  stream.drainAll()

  expect(retained.length).toBe(1)
  expect(new TextDecoder().decode(retained[0])).toBe("hello world")

  stream.close()
  stream.drainAll()
  expect(retained.length).toBe(1)
})

test("onData handlers are cleared on close", () => {
  const stream = NativeSpanFeed.create({ chunkSize: 256, initialChunks: 1 })

  let callCount = 0
  stream.onData(() => {
    callCount++
  })

  const data = new TextEncoder().encode("before close")
  lib.streamWrite(stream.streamPtr, data)
  lib.streamCommit(stream.streamPtr)
  stream.drainAll()
  expect(callCount).toBe(1)

  stream.close()

  expect(callCount).toBe(1)
})
