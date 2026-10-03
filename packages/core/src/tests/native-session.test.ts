import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { NativeSession, type NativeSessionDriverOptions, type NativeSessionScheduler } from "../NativeSession.js"
import { CliRenderer } from "../renderer.js"
import { settle } from "../testing/harness.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, RecordingWriteStream } from "../testing/test-streams.js"
import { NativeError, NativeStatus, resolveRenderLib, type NativeContextHandle } from "../zig.js"

const lib = resolveRenderLib()
const MS = 1_000_000n
const output = { chunkSize: 4096, spanCapacity: 8, maxBytes: 65_536n, controlCapacity: 4096 }

/** Host scheduler with a manual clock. Set `failure` to make the next `schedule()` call throw. */
class ManualScheduler implements NativeSessionScheduler {
  time = 0n
  failure: Error | null = null
  private readonly tasks = new Set<{ at: bigint; callback: () => void }>()

  now(): bigint {
    return this.time
  }

  schedule(callback: () => void, delayMs = 0): () => void {
    if (this.failure) throw this.failure
    const task = { at: this.time + BigInt(delayMs) * MS, callback }
    this.tasks.add(task)
    return () => void this.tasks.delete(task)
  }

  /** Sets the clock to `ms` (if given), then runs due tasks, one per host turn, until none is due. */
  async run(ms?: number): Promise<void> {
    if (ms !== undefined) {
      assert.ok(BigInt(ms) * MS >= this.time, "the clock is monotonic")
      this.time = BigInt(ms) * MS
    }
    for (let turn = 0; turn < 4096; turn++) {
      await settle()
      const due = [...this.tasks].find((task) => task.at <= this.time)
      if (!due) return
      this.tasks.delete(due)
      due.callback()
    }
    throw new Error("scheduler did not settle within 4096 turns")
  }

  /** Advances 1 ms per host turn and runs the tasks that were due at the start of each turn. */
  async turns(count: number): Promise<void> {
    for (let turn = 0; turn < count; turn++) {
      this.time += MS
      for (const task of [...this.tasks]) {
        if (task.at <= this.time && this.tasks.delete(task)) task.callback()
      }
      await settle()
    }
  }
}

/** Highwater mark 1: every write reports pressure. A write can be parked, failed, or made to throw. */
class Sink extends Writable {
  readonly chunks: Buffer[] = []
  throwOnWrite: Error | null = null
  private parked: ((error?: Error | null) => void) | undefined

  constructor(private held = false) {
    super({ highWaterMark: 1 })
  }

  override write(chunk: any, encoding?: any, callback?: any): boolean {
    if (this.throwOnWrite) throw this.throwOnWrite
    return super.write(chunk, encoding, callback)
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk))
    if (this.held) this.parked = callback
    else callback()
  }

  get pending(): boolean {
    return this.parked !== undefined
  }

  hold(): void {
    this.held = true
  }

  release(error?: Error): void {
    this.held = false
    const parked = this.parked
    this.parked = undefined
    parked?.(error)
  }

  listenerTotal(): number {
    return ["error", "close", "finish", "drain"].reduce((count, event) => count + this.listenerCount(event), 0)
  }
}

function outcome(promise: Promise<void>): Promise<string> {
  return promise.then(
    () => "closed",
    (error: Error) => error.message,
  )
}

const timeout = "NativeSession graceful close timed out; output cancelled without restoration"

test.each([
  { name: "raw output acknowledged before the deadline closes", attach: false, release: true, expected: "closed" },
  { name: "a write still in flight at the deadline times out", attach: false, release: false, expected: timeout },
  { name: "restoration whose last settle wait is due closes", attach: true, release: true, expected: "closed" },
])("a turn that runs late at the close deadline: $name", async ({ attach, release, expected }) => {
  const scheduler = new ManualScheduler()
  const stdout = new RecordingWriteStream(4, 2, { highWaterMark: 1 })
  const driver = new NativeSession(stdout, { scheduler, closeTimeoutMs: 25, output })
  try {
    if (attach) {
      driver.attachRenderer({ width: 4, height: 2 })
      const setup = driver.setupTerminal()
      await scheduler.run()
      await setup
    } else {
      stdout.hold()
      expect(driver.write(Buffer.from("restore"))).toBe(true)
      await scheduler.run()
      expect(stdout.pendingWrite).toBe(true)
    }
    const closed = outcome(driver.close())
    // Restoration waits 10 ms twice for the cursor to settle, so its last wait is due at 20 ms.
    await scheduler.run()
    await scheduler.run(attach ? 10 : 9)
    if (release) stdout.release()
    // The turn that is due before the deadline runs at it.
    await scheduler.run(25)
    expect(await closed).toBe(expected)
    expect(driver.disposed).toBe(true)
  } finally {
    stdout.release()
    driver.dispose()
  }
})

test.each([
  {
    name: "a write callback error",
    held: true,
    inject: (sink: Sink) => sink.release(new Error("callback failed")),
    message: "callback failed",
  },
  {
    name: "a sink destroyed with an error",
    inject: (sink: Sink) => sink.destroy(new Error("sink failed")),
    message: "sink failed",
  },
  {
    name: "a destroyed sink",
    inject: (sink: Sink) => sink.destroy(),
    message: "NativeSession sink closed before graceful close",
  },
  {
    name: "an ended sink",
    inject: (sink: Sink) => sink.end(),
    message: "NativeSession sink finished before graceful close",
  },
  {
    name: "a sink write that throws",
    inject: (sink: Sink, driver: NativeSession) => {
      sink.throwOnWrite = new Error("write threw")
      driver.write(Buffer.from("next"))
    },
    message: "write threw",
  },
  {
    name: "a host scheduler that throws",
    inject: (_sink: Sink, driver: NativeSession, scheduler: ManualScheduler) => {
      scheduler.failure = new Error("schedule failed")
      driver.write(Buffer.from("next"))
    },
    message: "schedule failed",
  },
])("$name fails the Session once and releases it", async ({ inject, message, ...row }) => {
  const scheduler = new ManualScheduler()
  const sink = new Sink()
  const driver = new NativeSession(sink, { scheduler, output })
  const closed = outcome(driver.closed)
  sink.hold()
  expect(driver.write(Buffer.from("first"))).toBe(true)
  await scheduler.run()
  if (!("held" in row)) sink.release()
  await scheduler.run()

  inject(sink, driver, scheduler)
  await scheduler.run()
  expect(await closed).toBe(message)
  expect(driver.error?.message).toBe(message)
  expect([driver.disposed, driver.contextDisposed]).toEqual([true, true])
  expect(sink.listenerTotal()).toBe(0)
  expect(() => driver.write(Buffer.from("late"))).toThrow(message)
  driver.dispose()
  expect(await outcome(driver.close())).toBe(message)
})

test("a throwing host scheduler fails each Session that schedules on it, and later Sessions cannot start", async () => {
  const scheduler = new ManualScheduler()
  const drivers = [0, 1].map(() => new NativeSession(new Sink(), { scheduler, output }))
  const closed = drivers.map((driver) => outcome(driver.closed))
  scheduler.failure = new Error("schedule failed")
  for (const driver of drivers) expect(driver.write(Buffer.from("x"))).toBe(true)
  expect(await Promise.all(closed)).toEqual(["schedule failed", "schedule failed"])
  expect(drivers.map((driver) => driver.disposed)).toEqual([true, true])
  scheduler.failure = null
  assert.throws(() => new NativeSession(new Sink(), { scheduler, output }), /schedule failed/)
})

test("an inline host scheduler fails the Session instead of stalling ready work", async () => {
  const scheduler: NativeSessionScheduler = {
    now: () => 0n,
    schedule(callback) {
      callback()
      return () => {}
    },
  }
  const driver = new NativeSession(new Sink(), { scheduler, output })
  driver.write(Buffer.from("x"))
  expect(await outcome(driver.closed)).toBe("NativeSessionScheduler.schedule ran a callback inline")
  expect(driver.disposed).toBe(true)
})

test("seeded writes reach the sink in order, and idle waits for the last acknowledgement", async () => {
  let refused = 0
  for (const [seed, outputBufferSize] of [
    [1, 7],
    [2, 64],
    [3, 4096],
  ] as const) {
    let state = seed
    const random = (limit: number) => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0
      return state % limit
    }
    const scheduler = new ManualScheduler()
    const sink = new Sink()
    const driver = new NativeSession(sink, {
      scheduler,
      outputBufferSize,
      output: { chunkSize: 64, spanCapacity: 8, maxBytes: 512n, controlCapacity: 0 },
    })
    try {
      assert.throws(() => driver.write(new Uint8Array(Number(driver.maxAtomicWriteBytes) + 1)), RangeError)
      const accepted: number[] = []
      for (let step = 0; step < 200; step++) {
        const operation = random(8)
        if (operation < 4) {
          const bytes = Uint8Array.from({ length: random(97) }, () => random(256))
          if (driver.write(bytes)) accepted.push(...bytes)
          else refused++
        } else if (operation === 4) sink.hold()
        else if (operation === 5) sink.release()
        else await scheduler.run()
      }
      sink.hold()
      await scheduler.run()
      let idle = false
      const waiting = driver.idle().then(() => (idle = true))
      await scheduler.run()
      expect(idle).toBe(!sink.pending)
      sink.release()
      await scheduler.run()
      await waiting
      expect(Buffer.concat(sink.chunks)).toEqual(Buffer.from(accepted))
    } finally {
      sink.release()
      driver.dispose()
    }
  }
  expect(refused).toBeGreaterThan(0)
})

test("terminal transitions share a pending request, refuse another kind, and close interrupts them", async () => {
  const scheduler = new ManualScheduler()
  const sink = new Sink(true)
  const driver = new NativeSession(sink, { scheduler, output })
  driver.attachRenderer({ width: 4, height: 2 })
  const setup = driver.setupTerminal()
  expect(driver.setupTerminal()).toBe(setup)
  expect(() => driver.suspend()).toThrow("NativeSession terminal transition is pending")
  await scheduler.run()
  expect(sink.pending).toBe(true)

  const interrupted = setup.catch((error: unknown) => error)
  const closed = outcome(driver.close())
  expect(driver.isCloseInterruption(await interrupted)).toBe(true)
  expect(driver.isCloseInterruption(new Error("other"))).toBe(false)
  expect(driver.close()).toBe(driver.closed)
  sink.release()
  await scheduler.run()
  await scheduler.run(10)
  await scheduler.run(20)
  expect(await closed).toBe("closed")
  expect(sink.listenerTotal()).toBe(0)
  driver.dispose()
  expect(driver.restoreOnExit()).toBe(false)
})

test("dispose keeps a busy Context and completes when called again after the lease is released", async () => {
  const sink = new Sink()
  const driver = new NativeSession(sink, { output })
  driver.attachRenderer({ width: 4, height: 2 })
  const lease = lib.sessionAcquireBufferLease(driver.context, driver.session, "next")
  // Exit restoration supports only real stdout; the caller disposes next either way.
  expect(driver.restoreOnExit()).toBe(false)
  driver.dispose()
  expect([driver.disposed, driver.contextDisposed]).toEqual([false, false])
  expect(driver.error?.message).toBe("NativeSession disposed without graceful close")
  lib.contextReleaseBufferLease(driver.context, lease.handle)
  driver.dispose()
  expect([driver.disposed, driver.contextDisposed]).toEqual([true, true])
  expect(await outcome(driver.closed)).toBe("NativeSession disposed without graceful close")
})

test("failed session creation or listener registration releases its Context", () => {
  const options: NativeSessionDriverOptions = {
    context: { objectCapacity: 2, renderCellsMax: 16 },
    output: { chunkSize: 4, spanCapacity: 2, maxBytes: 8n },
  }
  const create = lib.createContext
  let allocated: NativeContextHandle | undefined
  lib.createContext = (createOptions) => (allocated = create.call(lib, createOptions))
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
      assert.equal(sink.listenerTotal(), 0)
    }
  } finally {
    lib.createContext = create
  }
})

test("host limits reject invalid options", () => {
  const sink = new Sink()
  for (const outputBufferSize of [0, -1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    assert.throws(() => new NativeSession(sink, { output, outputBufferSize }), RangeError)
  }
  for (const closeTimeoutMs of [-1, 0.5, NaN, Infinity, 0x8000_0000]) {
    assert.throws(() => new NativeSession(sink, { output, closeTimeoutMs }), RangeError)
  }
  sink.end()
  assert.throws(() => new NativeSession(sink, { output }), /sink is not writable/)
})

test("environment limits reject before attachment and accept the boundary", () => {
  const entries = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`K${index}`, ""]))
  // Each entry takes 8 length bytes; 65,536 bytes is the whole budget.
  const invalid: [Record<string, unknown>, new (...args: never[]) => Error][] = [
    [{ "": "1" }, NativeError],
    [{ "a=b": "1" }, NativeError],
    [{ "a\0": "1" }, NativeError],
    [{ a: "\0" }, NativeError],
    [{ a: 1 }, TypeError],
    [entries(257), NativeError],
    [{ a: "x".repeat(65_528) }, RangeError],
    [{ a: "\u00e9".repeat(32_764) }, RangeError],
  ]
  const valid = [entries(256), { a: "x".repeat(65_527) }, { a: "\u00e9".repeat(32_763) }]
  for (const [environment, error] of invalid) {
    const driver = new NativeSession(new Sink(), { output })
    try {
      assert.throws(() => driver.attachRenderer({ width: 4, height: 2, environment: environment as never }), error)
      driver.attachRenderer({ width: 4, height: 2 })
    } finally {
      driver.dispose()
    }
  }
  for (const environment of valid) {
    const driver = new NativeSession(new Sink(), { output })
    try {
      driver.attachRenderer({ width: 4, height: 2, environment })
    } finally {
      driver.dispose()
    }
  }
})

function rendererFor(scheduler: ManualScheduler, stdout: Writable, clock: ManualClock) {
  return new CliRenderer(createTestStdin(), stdout as NodeJS.WriteStream, 2, 1, {
    nativeSession: new NativeSession(stdout, { scheduler }),
    clock,
    remote: true,
    screenMode: "main-screen",
    consoleMode: "disabled",
    exitSignals: [],
    debounceDelay: 1,
  })
}

test("blocked output and host promises do not hold other renderers' input, resize or shutdown", async () => {
  const scheduler = new ManualScheduler()
  const clock = new ManualClock()
  const host = Promise.withResolvers<void>()
  let release: (() => void) | undefined
  let hold = true
  const animation: number[] = []
  const inputs: number[] = []
  const resizes: number[] = []
  const closed: number[] = []
  const renderers = Array.from({ length: 3 }, (_, index) =>
    rendererFor(
      scheduler,
      new Writable({
        highWaterMark: 1,
        write(_bytes, _encoding, done) {
          if (index === 0 && hold) release = done
          else done()
        },
      }),
      clock,
    ),
  )
  try {
    for (const [index, renderer] of renderers.entries()) {
      renderer.keyInput.on("keypress", () => inputs.push(index))
      renderer.on("resize", () => resizes.push(index))
      renderer.pause()
      for (let call = 0; call < 2; call++) renderer.requestAnimationFrame(() => animation.push(index))
      if (index === 2) renderer.setFrameCallback(() => host.promise)
      renderer.start()
    }
    await scheduler.turns(24)
    expect(animation).toEqual([0, 1, 2, 0, 1, 2])
    expect(release).toBeDefined()
    for (const renderer of renderers) {
      renderer.stdin.emit("data", Buffer.from("a"))
      renderer.requestResize(4, 2)
      renderer.requestResize(3, 1)
    }
    expect(inputs).toEqual([0, 1, 2])
    clock.advance(2)
    await scheduler.turns(24)
    expect(resizes).toEqual([1])
    expect(renderers.map((renderer) => renderer.width)).toEqual([2, 3, 2])
    for (const [index, renderer] of renderers.entries()) {
      renderer.destroy()
      void renderer.closed.then(() => closed.push(index))
    }
    await scheduler.turns(24)
    expect(closed.sort()).toEqual([1, 2])
    hold = false
    release?.()
    release = undefined
    await scheduler.turns(24)
    await Promise.all(renderers.map((renderer) => renderer.closed))
    expect(animation).toHaveLength(6)
  } finally {
    host.resolve()
    hold = false
    release?.()
    for (const renderer of renderers) {
      renderer.destroy()
      renderer.nativeScene.driver.dispose()
    }
    await scheduler.turns(8)
    await Promise.allSettled(renderers.map((renderer) => renderer.closed))
  }
})
