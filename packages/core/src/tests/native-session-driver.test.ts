import { test } from "bun:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { setImmediate } from "node:timers/promises"
import { NativeSession, type NativeSessionDriverOptions, type NativeSessionScheduler } from "../NativeSession.js"
import { OptimizedBuffer } from "../buffer.js"
import { NativeSessionRenderStatus, NativeStatus, resolveRenderLib, type NativeContextHandle } from "../zig.js"

const lib = resolveRenderLib()
const options: NativeSessionDriverOptions = {
  context: { objectCapacity: 2, renderCellsMax: 16 },
  output: { chunkSize: 4, spanCapacity: 2, maxBytes: 8n },
  outputBufferSize: 2,
  closeTimeoutMs: 100,
}
const frameOptions: NativeSessionDriverOptions = {
  ...options,
  output: { chunkSize: 64, spanCapacity: 16, maxBytes: 1024n },
  outputBufferSize: 13,
}

class Clock implements NativeSessionScheduler {
  time = (1n << 53n) + 1n
  tasks = new Set<{ at: bigint; callback: () => void }>()
  delays: number[] = []
  now() {
    return this.time
  }
  schedule(callback: () => void, delayMs?: number) {
    if (delayMs !== undefined) this.delays.push(delayMs)
    const task = { at: this.time + BigInt(delayMs ?? 0) * 1_000_000n, callback }
    this.tasks.add(task)
    return () => {
      this.tasks.delete(task)
    }
  }
  turn() {
    const ready = [...this.tasks].filter((task) => task.at <= this.time)
    for (const task of ready) if (this.tasks.delete(task)) task.callback()
    return ready.length
  }
  run() {
    for (let turn = 0; turn < 128; turn++) if (this.turn() === 0) return
    assert.fail("Driver exceeded the fixture turn bound")
  }
}

type Write = { view: Uint8Array; bytes: Buffer; callback: (error?: Error | null) => void }
class Sink extends Writable {
  writes: Write[] = []
  ready = true
  synchronous = false
  duringWrite?: (write: Write) => void
  override write(
    chunk: Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const complete = typeof encodingOrCallback === "function" ? encodingOrCallback : callback
    assert.ok(complete)
    const write = { view: chunk, bytes: Buffer.from(chunk), callback: complete }
    this.writes.push(write)
    this.duringWrite?.(write)
    if (this.synchronous) complete()
    return this.ready
  }
}

test.each([
  ["span count", { chunkSize: 4, spanCapacity: 2, maxBytes: 16n }, 8],
  ["byte limit", { chunkSize: 4, spanCapacity: 4, maxBytes: 8n }, 8],
  ["rounded reservation", { chunkSize: 4, spanCapacity: 4, maxBytes: 16n, controlCapacity: 5 }, 8],
  ["reserved span count", { chunkSize: 4, spanCapacity: 3, maxBytes: 20n, controlCapacity: 5 }, 4],
  ["reserved byte limit", { chunkSize: 4, spanCapacity: 5, maxBytes: 12n, controlCapacity: 5 }, 4],
  ["minimum capacity", { chunkSize: 1, spanCapacity: 2, maxBytes: 2n, controlCapacity: 1 }, 1],
] as const)("permanent write limits differ from transient pressure: %s", async (_, output, limit) => {
  const clock = new Clock()
  const sink = new Sink()
  const driver = new NativeSession(sink, { ...options, output, scheduler: clock })
  try {
    assert.equal(driver.maxAtomicWriteBytes, BigInt(limit))
    assert.throws(() => driver.write(Buffer.alloc(limit + 1)), RangeError)
    assert.equal(driver.write(Buffer.alloc(limit)), true)
    const idle = driver.idle()
    clock.turn()
    assert.equal(driver.write(Uint8Array.of(1)), false)
    assert.throws(() => driver.write(Buffer.alloc(limit + 1)), RangeError)
    sink.synchronous = true
    sink.writes[0].callback()
    clock.run()
    await idle
    assert.equal(driver.write(Buffer.alloc(limit)), true)
    clock.run()
    assert.equal(Buffer.concat(sink.writes.map((write) => write.bytes)).length, 2 * limit)
  } finally {
    driver.dispose()
  }
})

test("attachment cleanup runs before Context release despite failure and reentry", async () => {
  let calls = 0
  const cleanupError = new Error("fixture cleanup failure")
  const driver = new NativeSession(new Sink(), options)
  driver.attachRenderer({ width: 1, height: 1, remote: true }, () => {
    calls++
    assert.equal(driver.disposed, false)
    driver.dispose()
    throw cleanupError
  })
  try {
    await assert.rejects(driver.close(), cleanupError)
    assert.equal(calls, 1)
    assert.equal(driver.disposed, true)
  } finally {
    driver.dispose()
  }
})

test("exit restoration retains borrowed Context storage until wrapper cleanup", async () => {
  let cleaned = false
  const driver = new NativeSession(process.stdout, options)
  try {
    driver.attachRenderer({ width: 1, height: 1, remote: true }, () => {
      cleaned = true
    })
    OptimizedBuffer.fromSession(lib, driver.context, driver.session, "next").withBuffers((cells) => {
      assert.equal(driver.restoreOnExit(), true)
      assert.equal(driver.disposed, false)
      assert.equal(cleaned, false)
      assert.equal(cells.char.length, 1)
    })
    driver.dispose()
    assert.equal(cleaned, true)
    await assert.rejects(driver.closed, /disposed/)
  } finally {
    driver.dispose()
  }
})

test("driver retains one copied buffer until completion and ignores duplicate or stale callbacks", async () => {
  const clock = new Clock()
  const sink = new Sink()
  const driver = new NativeSession(sink, { ...options, scheduler: clock })
  try {
    const source = Uint8Array.of(0, 255, 2, 3, 4, 5, 6, 7)
    driver.write(source)
    source.fill(99)
    const idle = driver.idle()
    assert.equal(driver.idle(), idle)
    clock.turn()
    const first = sink.writes[0]
    assert.deepEqual(first.view, Uint8Array.of(0, 255))
    assert.equal(clock.turn(), 0)
    first.callback()
    first.callback(new Error("duplicate before reuse"))
    assert.equal(driver.write(Uint8Array.of(8)), false)
    clock.turn()
    assert.equal(sink.writes[1].view.buffer, first.view.buffer)
    assert.deepEqual(sink.writes[1].view, Uint8Array.of(2, 3))
    sink.writes[1].callback()
    clock.turn()
    assert.equal(driver.write(Uint8Array.of(8, 9, 10, 11)), true)
    first.callback(new Error("stale after reuse"))
    assert.equal(driver.error, null)
    for (let index = 2; index < 6; index++) {
      sink.writes[index].callback()
      clock.run()
    }
    await idle
    assert.deepEqual(
      Buffer.concat(sink.writes.map((write) => write.bytes)),
      Buffer.from([0, 255, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    )
    await driver.close()
    assert.equal(sink.destroyed, false)
    assert.equal(sink.writableEnded, false)
    assert.equal(sink.listenerCount("error"), 0)
  } finally {
    driver.dispose()
  }
})

test.each(["drain-first", "callback-first"] as const)("pressure and completion are independent: %s", async (order) => {
  const clock = new Clock()
  const sink = new Sink()
  sink.ready = false
  const driver = new NativeSession(sink, { ...options, outputBufferSize: 4, scheduler: clock })
  try {
    driver.write(Buffer.alloc(8))
    const idle = driver.idle()
    let settled = false
    void idle.then(() => (settled = true))
    clock.turn()
    if (order === "drain-first") sink.emit("drain")
    else sink.writes[0].callback()
    clock.run()
    assert.equal(sink.writes.length, 1)
    if (order === "drain-first") sink.writes[0].callback()
    else sink.emit("drain")
    clock.turn()
    assert.equal(sink.writes.length, 2)
    sink.writes[1].callback()
    clock.run()
    await Promise.resolve()
    assert.equal(settled, false)
    sink.emit("drain")
    clock.run()
    await idle
  } finally {
    driver.dispose()
  }
})

test("synchronous callback and drain defer buffer reuse to later turns", async () => {
  const clock = new Clock()
  const sink = new Sink()
  sink.ready = false
  sink.duringWrite = (write) => {
    sink.emit("drain")
    write.callback()
  }
  const driver = new NativeSession(sink, { ...options, scheduler: clock })
  try {
    driver.write(Buffer.alloc(8))
    const idle = driver.idle()
    for (let count = 1; count <= 4; count++) {
      assert.equal(clock.turn(), 1)
      assert.equal(sink.writes.length, count)
    }
    clock.run()
    await idle
    assert.equal(clock.tasks.size, 0)
  } finally {
    driver.dispose()
  }
})

test("presentation resolves at the frame endpoint before later output callback and drain", async () => {
  const clock = new Clock()
  const sink = new Sink()
  sink.duringWrite = (write) => {
    if (write.bytes.toString() === "suffix") sink.ready = false
  }
  const driver = new NativeSession(sink, { ...frameOptions, scheduler: clock })
  try {
    driver.attachRenderer({ width: 4, height: 2, remote: true })
    assert.equal(driver.render(true), NativeSessionRenderStatus.Pending)
    const presented = driver.whenPresented()
    assert.equal(driver.whenPresented(), presented)
    driver.write(Buffer.from("suffix"))
    const idle = driver.idle()
    const completed: string[] = []
    void presented.then(
      () => completed.push("frame"),
      () => {},
    )
    void idle.then(
      () => completed.push("idle"),
      () => {},
    )
    clock.turn()
    for (let index = 0; index < 128; index++) {
      const write = sink.writes[index]
      assert.ok(write)
      if (write.bytes.toString() === "suffix") break
      await Promise.resolve()
      assert.deepEqual(completed, [])
      write.callback()
      clock.turn()
    }
    const suffix = sink.writes.at(-1)!
    assert.equal(suffix.bytes.toString(), "suffix")
    await presented
    assert.deepEqual(completed, ["frame"])
    suffix.callback()
    clock.run()
    await Promise.resolve()
    assert.deepEqual(completed, ["frame"])
    sink.emit("drain")
    clock.run()
    await idle
    assert.deepEqual(completed, ["frame", "idle"])
  } finally {
    driver.dispose()
  }
})

test.each(["callback", "error", "close", "finish", "throw", "dispose", "timeout"] as const)(
  "failure stops replay and tolerates late callbacks: %s",
  async (failure) => {
    const clock = new Clock()
    const sink = new Sink()
    const error = new Error("sink failure")
    if (failure === "throw")
      sink.duringWrite = () => {
        throw error
      }
    const driver = new NativeSession(sink, {
      ...frameOptions,
      outputBufferSize: 2,
      scheduler: clock,
      closeTimeoutMs: 5,
    })
    try {
      driver.attachRenderer({ width: 4, height: 2, remote: true })
      driver.write(Uint8Array.of(1, 2, 3, 4))
      assert.equal(driver.render(true), NativeSessionRenderStatus.Pending)
      const presented = driver.whenPresented()
      const idle = driver.idle()
      clock.turn()
      const pending = sink.writes[0]
      if (failure === "callback") pending.callback(error)
      if (failure === "error" || failure === "callback") sink.emit("error", error)
      if (failure === "close" || failure === "finish") sink.emit(failure)
      if (failure === "dispose") {
        assert.equal(driver.restoreOnExit(), false)
        driver.dispose()
      }
      if (failure === "timeout") {
        assert.equal(driver.close(), driver.closed)
        assert.throws(() => driver.write(Uint8Array.of(9)), /closing/)
        clock.run()
        clock.time += 4_999_999n
        assert.equal(clock.turn(), 0)
        assert.equal(driver.disposed, false)
        clock.time++
      }
      clock.run()
      await assert.rejects(driver.closed)
      await assert.rejects(idle)
      await assert.rejects(presented)
      assert.equal(driver.disposed, true)
      assert.throws(() => lib.sessionGetState(driver.context, driver.session), { status: NativeStatus.WrongContext })
      pending.callback()
      pending.callback(error)
      clock.run()
      assert.deepEqual(pending.view, Uint8Array.of(1, 2))
      assert.equal(sink.writes.length, 1)
      assert.equal(clock.tasks.size, 0)
      for (const event of ["error", "close", "finish", "drain"]) assert.equal(sink.listenerCount(event), 0)
      assert.equal(sink.destroyed, false)
      assert.equal(sink.writableEnded, false)
    } finally {
      driver.dispose()
    }
  },
)

test("restoration deadlines retain bigint precision and reschedule early timers", async () => {
  const clock = new Clock()
  const sink = new Sink()
  sink.synchronous = true
  const driver = new NativeSession(sink, {
    ...options,
    output: { chunkSize: 4096, spanCapacity: 2, maxBytes: 8192n, controlCapacity: 4096 },
    outputBufferSize: 4096,
    scheduler: clock,
  })
  try {
    driver.attachRenderer({ width: 4, height: 2, remote: true })
    const setup = driver.setupTerminal()
    clock.run()
    await setup
    driver.render(true)
    const presented = driver.whenPresented()
    const close = driver.close()
    clock.run()
    await presented
    assert.equal(driver.disposed, false)
    const start = clock.time
    assert.equal(clock.delays.at(-1), 10)
    clock.time += 9_999_999n
    const early = clock.tasks.values().next().value!
    clock.tasks.delete(early)
    early.callback()
    clock.run()
    assert.equal(clock.delays.at(-1), 1)
    assert.equal(driver.disposed, false)
    clock.time += 1_000_000n
    clock.run()
    assert.equal(clock.delays.at(-1), 10)
    clock.time += 9_999_999n
    assert.equal(clock.turn(), 0)
    clock.time++
    clock.run()
    await close
    assert.equal(clock.time, start + 20_999_999n)
    const output = Buffer.concat(sink.writes.map((write) => write.bytes)).toString()
    assert.ok(output.lastIndexOf("\x1b[?2026l") < output.lastIndexOf("\x1b[?1049l"))
    assert.equal(clock.tasks.size, 0)
  } finally {
    driver.dispose()
  }
})

test("failed session creation or listener registration releases its Context", () => {
  const create = lib.createContext
  let allocated: NativeContextHandle | undefined
  lib.createContext = (options) => (allocated = create.call(lib, options))
  try {
    for (const failure of ["session", "listener"]) {
      const sink = new Sink()
      if (failure === "listener")
        sink.once("newListener", () => {
          throw new Error("listener registration")
        })
      const output = failure === "session" ? { ...options.output!, maxBytes: 9n } : options.output
      assert.throws(() => new NativeSession(sink, { ...options, output }))
      assert.ok(allocated)
      assert.throws(() => lib.destroyContext(allocated!), { status: NativeStatus.WrongContext })
      for (const event of ["error", "close", "finish", "drain"]) assert.equal(sink.listenerCount(event), 0)
    }
  } finally {
    lib.createContext = create
  }
})

test.each(["write-error", "dispose", "finish"] as const)(
  "failure listeners survive asynchronous Writable destruction: %s",
  async (action) => {
    let writeCallback: ((error?: Error | null) => void) | undefined
    let destroyCallback: ((error?: Error | null) => void) | undefined
    const entered = Promise.withResolvers<void>()
    const failure = new Error("asynchronous Writable destruction")
    const sink = new Writable({
      write(bytes, _encoding, callback) {
        assert.deepEqual(bytes, Buffer.from([1, 2]))
        writeCallback = callback
        entered.resolve()
      },
      destroy(_error, callback) {
        destroyCallback = callback
      },
    })
    const driver = new NativeSession(sink, options)
    try {
      driver.write(Uint8Array.of(1, 2))
      await entered.promise
      if (action === "dispose") driver.dispose()
      if (action === "finish") sink.end()
      writeCallback!(action === "finish" ? undefined : failure)
      await setImmediate()
      await setImmediate()
      await assert.rejects(driver.closed)
      assert.equal(driver.disposed, true)
      assert.ok(destroyCallback)
      assert.equal(sink.listenerCount("error"), 1)
      const emitted = new Promise<Error>((resolve) => sink.once("error", resolve))
      destroyCallback(failure)
      destroyCallback = undefined
      assert.equal(await emitted, failure)
      await setImmediate()
      assert.equal(sink.listenerCount("error"), 0)
    } finally {
      if (destroyCallback) {
        sink.once("error", () => {})
        destroyCallback(failure)
        await setImmediate()
      }
      driver.dispose()
    }
  },
)

test.each([false, true])(
  "silently closed Writable releases its listeners after asynchronous=%s destruction",
  async (asynchronous) => {
    let destroyCallback: (() => void) | undefined
    const sink = new Writable({
      emitClose: false,
      write() {
        assert.fail("Corked output must not reach the sink")
      },
      destroy(_error, callback) {
        if (asynchronous) destroyCallback = () => callback(null)
        else callback(null)
      },
    })
    sink.cork()
    const driver = new NativeSession(sink, options)
    try {
      driver.write(Uint8Array.of(1, 2))
      await setImmediate()
      if (asynchronous) driver.dispose()
      sink.destroy()
      await assert.rejects(driver.closed)
      if (asynchronous) {
        await setImmediate()
        assert.equal(sink.closed, false)
        destroyCallback!()
        destroyCallback = undefined
        driver.dispose()
      }
      await setImmediate()
      await setImmediate()
      assert.equal(sink.closed, true)
      for (const event of ["error", "close", "finish", "drain"]) assert.equal(sink.listenerCount(event), 0)
    } finally {
      destroyCallback?.()
      driver.dispose()
    }
  },
)

test("host limits reject invalid options and zero timeout permits an already-drained close", () => {
  const sink = new Sink()
  for (const outputBufferSize of [0, -1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    assert.throws(() => new NativeSession(sink, { ...options, outputBufferSize }), RangeError)
  }
  for (const closeTimeoutMs of [-1, 0.5, NaN, Infinity, 0x8000_0000]) {
    assert.throws(() => new NativeSession(sink, { ...options, closeTimeoutMs }), RangeError)
  }
  const driver = new NativeSession(sink, { ...options, closeTimeoutMs: 0 })
  assert.equal(driver.close(), driver.closed)
  assert.equal(driver.disposed, true)
  assert.equal(driver.error, null)
})
