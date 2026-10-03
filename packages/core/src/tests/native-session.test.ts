import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { NativeSession, type NativeSessionScheduler } from "../NativeSession.js"
import { settle } from "../testing/harness.js"
import { RecordingWriteStream } from "../testing/test-streams.js"

const MS = 1_000_000n
const output = { chunkSize: 4096, spanCapacity: 8, maxBytes: 65_536n, controlCapacity: 4096 }

/** Host scheduler with a manual clock. `run()` lets stream callbacks settle between turns. */
class ManualScheduler implements NativeSessionScheduler {
  time = 0n
  private readonly tasks = new Set<{ at: bigint; callback: () => void }>()

  now(): bigint {
    return this.time
  }

  schedule(callback: () => void, delayMs = 0): () => void {
    const task = { at: this.time + BigInt(delayMs) * MS, callback }
    this.tasks.add(task)
    return () => void this.tasks.delete(task)
  }

  /** Sets the clock to `ms` (if given), then runs due tasks until none is due. */
  async run(ms?: number): Promise<void> {
    if (ms !== undefined) {
      assert.ok(BigInt(ms) * MS >= this.time, "the clock is monotonic")
      this.time = BigInt(ms) * MS
    }
    for (let turn = 0; turn < 256; turn++) {
      await settle()
      const due = [...this.tasks].find((task) => task.at <= this.time)
      if (!due) return
      this.tasks.delete(due)
      due.callback()
    }
    throw new Error("scheduler did not settle within 256 turns")
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

test("invalid environment rejects before attachment", () => {
  const sink = new Writable({ write: (_bytes, _encoding, done) => done() })
  const driver = new NativeSession(sink)
  try {
    const invalid: Record<string, string>[] = [{ "": "1" }, { "a=b": "1" }, { "a\0": "1" }, { a: "\0" }]
    for (const environment of invalid) {
      assert.throws(() => driver.attachRenderer({ width: 4, height: 2, environment }))
    }
    driver.attachRenderer({ width: 4, height: 2, environment: { TERM: "xterm" } })
  } finally {
    driver.dispose()
  }
})
