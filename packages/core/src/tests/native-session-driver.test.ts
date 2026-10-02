import { test } from "bun:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { NativeSession, type NativeSessionDriverOptions } from "../NativeSession.js"
import { NativeStatus, resolveRenderLib, type NativeContextHandle } from "../zig.js"

const lib = resolveRenderLib()
const options: NativeSessionDriverOptions = {
  context: { objectCapacity: 2, renderCellsMax: 16 },
  output: { chunkSize: 4, spanCapacity: 2, maxBytes: 8n },
  outputBufferSize: 2,
  closeTimeoutMs: 100,
}

function sink() {
  return new Writable({ write: (_bytes, _encoding, done) => done() })
}

test("failed session creation or listener registration releases its Context", () => {
  const create = lib.createContext
  let allocated: NativeContextHandle | undefined
  lib.createContext = (createOptions) => (allocated = create.call(lib, createOptions))
  try {
    for (const failure of ["session", "listener"]) {
      const outputSink = sink()
      if (failure === "listener")
        outputSink.once("newListener", () => {
          throw new Error("listener registration")
        })
      const output = failure === "session" ? { ...options.output!, maxBytes: 9n } : options.output
      assert.throws(() => new NativeSession(outputSink, { ...options, output }))
      assert.ok(allocated)
      assert.throws(() => lib.destroyContext(allocated!), { status: NativeStatus.WrongContext })
      for (const event of ["error", "close", "finish", "drain"]) assert.equal(outputSink.listenerCount(event), 0)
    }
  } finally {
    lib.createContext = create
  }
})

test("host limits reject invalid options", () => {
  const outputSink = sink()
  for (const outputBufferSize of [0, -1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    assert.throws(() => new NativeSession(outputSink, { ...options, outputBufferSize }), RangeError)
  }
  for (const closeTimeoutMs of [-1, 0.5, NaN, Infinity, 0x8000_0000]) {
    assert.throws(() => new NativeSession(outputSink, { ...options, closeTimeoutMs }), RangeError)
  }
})
