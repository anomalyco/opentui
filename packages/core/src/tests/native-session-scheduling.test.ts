import { expect, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { setImmediate } from "node:timers/promises"
import { NativeSession, type NativeSessionScheduler } from "../NativeSession.js"
import { CliRenderer } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin } from "../testing/test-streams.js"
import { NativeStatus, type SessionHandle } from "../zig.js"

class Scheduler implements NativeSessionScheduler {
  time = 0n
  tasks = new Set<{ at: bigint; callback: () => void }>()
  calls = 0
  failAt = Infinity
  failure = new Error("fixture scheduler failure")
  now() {
    return this.time
  }
  schedule(callback: () => void, delayMs = 0) {
    if (++this.calls === this.failAt) throw this.failure
    const task = { at: this.time + BigInt(delayMs) * 1_000_000n, callback }
    this.tasks.add(task)
    return () => {
      this.tasks.delete(task)
    }
  }
  turn() {
    this.time += 1_000_000n
    for (const task of [...this.tasks]) {
      if (task.at <= this.time && this.tasks.delete(task)) task.callback()
    }
  }
  async run(turns = 8) {
    for (let turn = 0; turn < turns; turn++) {
      this.turn()
      await setImmediate()
    }
  }
}

function rendererFor(scheduler: Scheduler, stdout: Writable, clock = new ManualClock()) {
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

test.each(["re-arm", "synchronous", "deadline"] as const)(
  "%s failure settles owners despite held output",
  async (mode) => {
    const scheduler = new Scheduler()
    let release: ((error?: Error | null) => void) | undefined
    const sink = new Writable({
      write: (_bytes, _encoding, complete) => {
        release = complete
      },
    })
    const driver = new NativeSession(sink, { scheduler, closeTimeoutMs: 10 })
    const peer = new NativeSession(new Writable({ write: (_bytes, _encoding, done) => done() }), { scheduler })
    try {
      driver.write(Uint8Array.of(1))
      if (mode === "re-arm") {
        peer.write(Uint8Array.of(2))
        scheduler.failAt = 2
      }
      let idle = mode === "synchronous" ? undefined : driver.idle()
      scheduler.turn()
      expect(release).toBeDefined()
      if (mode === "synchronous") {
        scheduler.failAt = scheduler.calls + 1
        idle = driver.idle()
      } else if (mode === "deadline") {
        void driver.close()
        scheduler.turn()
        scheduler.failAt = scheduler.calls + 1
        scheduler.time += 10_000_000n
        expect(() => scheduler.turn()).not.toThrow()
      }
      await expect(idle).rejects.toBe(scheduler.failure)
      await expect(driver.closed).rejects.toBe(scheduler.failure)
      expect(driver.disposed).toBe(true)
      if (mode === "re-arm") await expect(peer.closed).rejects.toBe(scheduler.failure)
      expect(sink.listenerCount("error")).toBe(1)
      release!(new Error("late Writable failure"))
      release = undefined
      await scheduler.run()
      expect(sink.listenerCount("error")).toBe(0)
      expect(scheduler.tasks.size).toBe(0)
    } finally {
      driver.dispose()
      peer.dispose()
      release?.()
      await scheduler.run()
    }
  },
)

test("ready service is fair, bounded and cancellable even when selected work throws", async () => {
  const scheduler = new Scheduler()
  const drivers = Array.from(
    { length: 3 },
    () => new NativeSession(new Writable({ write: (_bytes, _encoding, done) => done() }), { scheduler }),
  )
  const calls: number[] = []
  try {
    for (const [index, driver] of drivers.entries()) {
      for (let call = 0; call < 2; call++) driver.scheduler.schedule(() => calls.push(index))
    }
    for (let turn = 0; turn < 6; turn++) {
      expect(scheduler.tasks.size).toBe(1)
      scheduler.turn()
      expect(calls.length).toBe(turn + 1)
    }
    expect(calls).toEqual([0, 1, 2, 0, 1, 2])
    const queue = drivers[0].scheduler
    const cancel = queue.schedule(() => calls.push(9))
    cancel()
    expect(scheduler.tasks.size).toBe(0)
    queue.schedule(() => {
      queue.schedule(() => calls.push(4))
      throw new Error("fixture callback")
    })
    queue.schedule(() => calls.push(3))
    expect(() => scheduler.turn()).toThrow("fixture callback")
    expect(calls.slice(6)).toEqual([])
    scheduler.turn()
    expect(calls.slice(6)).toEqual([3])
    scheduler.turn()
    expect(calls.slice(6)).toEqual([3, 4])
    queue.schedule(() => cancelPending())
    const cancelPending = queue.schedule(() => calls.push(9))
    scheduler.turn()
    expect(calls.slice(6)).toEqual([3, 4])
    expect(scheduler.tasks.size).toBe(0)
    await Promise.all(drivers.map((driver) => driver.close()))
  } finally {
    for (const driver of drivers) driver.dispose()
  }
})

test("failed host cancellation leaves late turns harmless", async () => {
  const scheduler = new Scheduler()
  const schedule = scheduler.schedule.bind(scheduler)
  scheduler.schedule = (...args) => {
    schedule(...args)
    return () => {
      throw scheduler.failure
    }
  }
  const sink = new Writable({ write: (_bytes, _encoding, done) => done() })
  const driver = new NativeSession(sink, { scheduler })
  driver.write(Uint8Array.of(1))
  driver.dispose()
  await expect(driver.closed).rejects.toThrow("disposed")
  expect(driver.disposed).toBe(true)
  expect(sink.listenerCount("error")).toBe(0)
  expect(() => scheduler.turn()).not.toThrow()
  expect(scheduler.tasks.size).toBe(0)
  const lib = driver.renderLib
  let session: SessionHandle | undefined
  const createSession = lib.createSession.bind(lib)
  const create = spyOn(lib, "createSession").mockImplementation((...args) => (session = createSession(...args)))
  const failure = new Error("sink failed during listener registration")
  sink.on("newListener", (event) => {
    if (event === "drain") sink.emit("error", failure)
  })
  try {
    assert.throws(
      () => new NativeSession(sink, { scheduler }),
      (error) => error === failure,
    )
    const allocated = session
    assert.ok(allocated)
    assert.throws(() => lib.sessionGetState(allocated.context, allocated), { status: NativeStatus.WrongContext })
    for (const event of ["error", "close", "finish", "drain"]) expect(sink.listenerCount(event)).toBe(0)
  } finally {
    create.mockRestore()
    if (session) {
      try {
        lib.destroyContext(session.context)
      } catch {}
    }
    scheduler.turn()
    sink.removeAllListeners()
    sink.destroy()
  }
})

test.each(["sink", "animation", "frame"] as const)(
  "%s failure cancels pending and reentrant renderer work",
  async (mode) => {
    const scheduler = new Scheduler()
    const sink = new Writable({ write: (_bytes, _encoding, done) => done() })
    const renderer = rendererFor(scheduler, sink)
    const driver = renderer.nativeScene.driver
    const calls: string[] = []
    const errors = spyOn(console, "error").mockImplementation(() => {})
    const dispose = () => {
      calls.push("dispose")
      driver.dispose()
      expect(renderer.requestAnimationFrame(() => calls.push("reentrant"))).toBe(-1)
    }
    try {
      renderer.pause()
      if (mode === "frame") renderer.setFrameCallback(async () => dispose())
      else renderer.requestAnimationFrame(dispose)
      if (mode === "frame")
        renderer.setFrameCallback(async () => {
          calls.push("later")
        })
      else renderer.requestAnimationFrame(() => calls.push("later"))
      renderer.start()
      if (mode === "sink") sink.emit("error", new Error("fixture Writable failure"))
      await scheduler.run()
      await expect(renderer.closed).rejects.toThrow()
      expect(calls).toEqual(mode === "sink" ? [] : ["dispose"])
      expect(renderer.root.isDestroyed).toBe(true)
      expect(renderer.getSchedulerState().isRendering).toBe(false)
      expect(scheduler.tasks.size).toBe(0)
    } finally {
      renderer.destroy()
      driver.dispose()
      await scheduler.run()
      await renderer.closed.catch(() => {})
      errors.mockRestore()
    }
  },
)

test("blocked output and host promises do not hold other renderers' input, resize or shutdown", async () => {
  const scheduler = new Scheduler()
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
    await scheduler.run(24)
    expect(animation).toEqual([0, 1, 2, 0, 1, 2])
    expect(release).toBeDefined()
    for (const renderer of renderers) {
      renderer.stdin.emit("data", Buffer.from("a"))
      renderer.requestResize(4, 2)
      renderer.requestResize(3, 1)
    }
    expect(inputs).toEqual([0, 1, 2])
    clock.advance(2)
    await scheduler.run(24)
    expect(resizes).toEqual([1])
    expect(renderers.map((renderer) => renderer.width)).toEqual([2, 3, 2])
    expect(scheduler.tasks.size).toBe(0)
    for (const [index, renderer] of renderers.entries()) {
      renderer.destroy()
      void renderer.closed.then(() => closed.push(index))
    }
    await scheduler.run(24)
    expect(closed.sort()).toEqual([1, 2])
    hold = false
    release?.()
    release = undefined
    await scheduler.run(24)
    await Promise.all(renderers.map((renderer) => renderer.closed))
    expect(animation).toHaveLength(6)
    expect(scheduler.tasks.size).toBe(0)
  } finally {
    host.resolve()
    hold = false
    release?.()
    for (const renderer of renderers) {
      renderer.destroy()
      renderer.nativeScene.driver.dispose()
    }
    await scheduler.run()
    await Promise.allSettled(renderers.map((renderer) => renderer.closed))
  }
})
