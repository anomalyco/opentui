// Deterministic simulation of the Session output driver on virtual time. A seeded script drives the real
// CliRenderer and NativeSession over a modeled link: pty and socket buffers drained at a fixed rate. Two output
// paths: a borrowed Writable (tickets), and process.stdout on fd 1, whose drain_stdout write is modeled with the
// ticket ABI as a blocking write, a non-blocking write (partial counts, EAGAIN), or a handle that cannot be written
// directly. Reproduce one row with `bun test native-session.sim -t "<row name>"`.
import { expect, test } from "bun:test"
import { NativeSession } from "../NativeSession.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderer } from "../renderer.js"
import { settle } from "../testing/harness.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"
import { NativeError, NativeSessionRenderStatus, NativeStatus, resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()
const MS = 1_000_000n
const EVENTS = 200
const SEEDS = 16
// The Writable path matches the fd unsupported fallback up to exit, so it needs fewer seeds.
const WRITABLE_SEEDS = 4
const REPLAY_SEEDS = 4
// Small chunks, so a full repaint spans several tickets.
const output = { chunkSize: 4096, spanCapacity: 128, maxBytes: 8_388_608n, controlCapacity: 4096 }
// What suspend and exit must have handed to the link: the cursor shown and the alternate screen left.
const restoration = ["\x1b[?25h", "\x1b[?1049l"]

type Path = "writable" | "fd"
type Fd = "blocking" | "nonblocking" | "unsupported"
const fds: readonly Fd[] = ["blocking", "nonblocking", "unsupported"]
const sizes = [
  [120, 40],
  [100, 30],
  [132, 43],
] as const

const presets = {
  local_fast: { rate: null, capacity: 18_944, hangup: false },
  ssh_slow: { rate: 48_000, capacity: 18_944 + 65_536, hangup: false },
  hangup_mid_frame: { rate: 48_000, capacity: 18_944 + 65_536, hangup: true },
} satisfies Record<string, { rate: number | null; capacity: number; hangup: boolean }>
type Preset = keyof typeof presets

function random(seed: number): (limit: number) => number {
  let state = seed | 0
  return (limit) => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296) * limit)
  }
}

interface Event {
  at: bigint
  seq: number
  actor: string
  run: () => void
}

/** One virtual time for the Session scheduler (ns) and the renderer's ManualClock (ms). */
class World {
  now = 0n
  steps = 0
  hash = 0x811c9dc5
  readonly clock = new ManualClock()
  private readonly events = new Set<Event>()
  private seq = 0
  readonly scheduler = {
    now: () => this.now,
    schedule: (callback: () => void, delayMs?: number) => {
      const event = this.at("host", BigInt(delayMs ?? 0) * MS, callback)
      return () => void this.events.delete(event)
    },
  }

  constructor(private readonly tie: (limit: number) => number) {}

  at(actor: string, delayNs: bigint, run: (event: Event) => void): Event {
    const event: Event = { at: this.now + delayNs, seq: this.seq++, actor, run: () => run(event) }
    this.events.add(event)
    return event
  }

  record(kind: string, bytes: Uint8Array = new Uint8Array()): void {
    for (const unit of `${this.now} ${kind};`) this.hash = Math.imul(this.hash ^ unit.charCodeAt(0), 0x01000193)
    for (const byte of bytes) this.hash = Math.imul(this.hash ^ byte, 0x01000193)
  }

  /** Runs the earliest event. Actors due at once run in seeded order; each actor's events run in FIFO order. */
  private step(): void {
    if (++this.steps > 100_000) throw new Error("I9: no progress within 100000 steps")
    const timer = (this.clock as unknown as { peekNextTimer(): { fireAt: number } | null }).peekNextTimer()
    let due = timer === null ? null : BigInt(timer.fireAt) * MS
    for (const event of this.events) if (due === null || event.at < due) due = event.at
    if (due === null) throw new Error("I9: deadlock, nothing can make progress")
    if (due > this.now) this.now = due
    if (timer !== null && BigInt(timer.fireAt) * MS <= this.now) {
      // Timers win ties, so syncing the clock for another actor never fires a timer out of turn.
      this.record("clock")
      this.clock.setTime(Number(this.now / MS))
    } else {
      const heads = new Map<string, Event>()
      for (const event of this.events) {
        const head = heads.get(event.actor)
        if (event.at <= due && (!head || event.seq < head.seq)) heads.set(event.actor, event)
      }
      const event = [...heads.values()].sort((left, right) => left.seq - right.seq)[this.tie(heads.size)]!
      this.events.delete(event)
      this.record(event.actor)
      this.clock.setTime(Number(this.now / MS))
      event.run()
    }
  }

  async until(done: () => boolean): Promise<void> {
    for (await settle(); !done(); await settle()) this.step()
  }
}

/** The pty and socket buffers between the app and the far end, drained at the link rate. */
class Link {
  readonly bytes: number[] = []
  failed = false
  private backlog = 0
  private measured = 0n

  constructor(
    private readonly world: World,
    readonly rate: number | null,
    readonly capacity: number,
    private readonly hangupAt: number | null,
  ) {}

  room(): number {
    if (this.rate === null) return Number.MAX_SAFE_INTEGER
    this.backlog = Math.max(0, this.backlog - (this.rate * Number(this.world.now - this.measured)) / 1e9)
    this.measured = this.world.now
    return Math.floor(this.capacity - this.backlog)
  }

  /** Whole milliseconds until `count` bytes fit. */
  delay(count: number): bigint {
    const excess = count - this.room()
    return excess <= 0 ? 0n : BigInt(Math.ceil((excess * 1000) / this.rate!)) * MS
  }

  /** Takes the bytes; after a hangup only the prefix before it. Returns the count taken. */
  accept(bytes: Uint8Array): number {
    let count = this.failed ? 0 : bytes.length
    if (!this.failed && this.hangupAt !== null && this.bytes.length + count >= this.hangupAt) {
      count = Math.max(0, this.hangupAt - this.bytes.length)
      this.failed = true
    }
    this.room()
    this.backlog += count
    for (let index = 0; index < count; index++) this.bytes.push(bytes[index]!)
    this.world.record(this.failed ? "link hangup" : "link", bytes.subarray(0, count))
    return count
  }

  restored(offset: number): boolean {
    const text = Buffer.from(this.bytes.slice(offset)).toString("latin1")
    return restoration.every((sequence) => text.includes(sequence))
  }
}

/** A Writable over the link: each write completes once the link has taken all of its bytes. */
class LinkSink extends TestWriteStream {
  fd: number | undefined

  constructor(
    private readonly world: World,
    private readonly link: Link,
  ) {
    super(120, 40, { highWaterMark: 1 })
  }

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    const bytes = Uint8Array.from(chunk)
    this.world.at("link", this.link.delay(bytes.length), () => {
      done(this.link.accept(bytes) < bytes.length ? new Error("EIO") : null)
    })
  }
}

/**
 * Replaces the fd 1 write of drain_stdout. read_output and complete_output move the same span prefix that
 * drainOutput hands to its writer, so the Session sees what each kind of fd would do: a blocking write takes the
 * whole prefix while the owner waits, a non-blocking one takes what fits (zero is EAGAIN), and a hangup fails it.
 */
function modelDrainStdout(world: World, link: Link, fd: Fd): typeof lib.sessionDrainStdout {
  const drain = lib.sessionDrainStdout
  return (context, session, maxBytes = 65_536) => {
    if (fd === "unsupported") throw new NativeError("ot_session_drain_stdout", NativeStatus.UnsupportedResource)
    const capacity = fd === "blocking" || link.failed ? maxBytes : Math.min(maxBytes, link.room())
    if (capacity <= 0) return 0
    const bytes = new Uint8Array(capacity)
    const ticket = lib.sessionReadOutput(context, session, bytes)
    if (!ticket) return 0
    if (fd === "blocking") world.now += link.delay(ticket.byteCount)
    const written = link.accept(bytes.subarray(0, ticket.byteCount)) === ticket.byteCount
    lib.sessionCompleteOutput(context, session, ticket, written)
    // A failed transport reports itself through the real call, as drain_stdout does.
    return written ? ticket.byteCount : drain.call(lib, context, session, maxBytes)
  }
}

/** Runs one seeded script and checks the invariants where they apply. Returns the trace hash. */
async function simulate(preset: Preset, path: Path, seed: number): Promise<number> {
  const draw = random(seed)
  const world = new World(random(seed ^ 0x5eed))
  const config = presets[preset]
  const rate = config.rate === null ? null : Math.round(config.rate * (0.75 + draw(51) / 100))
  const link = new Link(world, rate, config.capacity, config.hangup ? 20_000 + draw(200_000) : null)
  const sink = new LinkSink(world, link)
  const fd = path === "fd" ? fds[seed % fds.length]! : null
  const end = (["destroy", "exit", "exit mid-stream"] as const)[draw(3)]!
  const label = `${preset} ${path}${fd ? `/${fd}` : ""} seed ${seed}`
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!
  const drainStdout = lib.sessionDrainStdout
  const consoleError = console.error
  console.error = () => {}
  if (fd) {
    sink.fd = 1
    Object.defineProperty(process, "stdout", { value: sink, configurable: true, writable: true })
    lib.sessionDrainStdout = modelDrainStdout(world, link, fd)
  }
  let renderer: CliRenderer | undefined
  let closed = "pending"
  try {
    const driver = new NativeSession(sink, { scheduler: world.scheduler, output })
    renderer = new CliRenderer(createTestStdin(), sink as unknown as NodeJS.WriteStream, 120, 40, {
      nativeSession: driver,
      clock: world.clock,
      remote: true,
      screenMode: "alternate-screen",
      consoleMode: "disabled",
      exitSignals: [],
      exitOnCtrlC: false,
      debounceDelay: 20,
    })
    const app = renderer
    void app.closed.then(
      () => (closed = "closed"),
      (error: Error) => (closed = error.message),
    )
    let changed = false
    let committedAt = 0n
    let presentLag = 0n
    const render = driver.render
    driver.render = (force, frame) => {
      const status = render.call(driver, force, frame)
      if (status === NativeSessionRenderStatus.Pending || status === NativeSessionRenderStatus.Presented)
        changed = false
      if (status === NativeSessionRenderStatus.Pending) committedAt = world.now
      return status
    }
    const whenPresented = driver.whenPresented
    driver.whenPresented = () =>
      whenPresented.call(driver).then(() => {
        if (world.now - committedAt > presentLag) presentLag = world.now - committedAt
      })
    let keysSent = 0
    let keys = 0
    let stalled = 0
    let waitMax = 0n
    let keyArrival = 0n
    app.keyInput.on("keypress", () => {
      const wait = world.now - keyArrival
      // I1: only a blocking fd write holds the owner.
      if (fd !== "blocking") expect(wait, label).toBe(0n)
      keys++
      if (wait > 0n) stalled++
      if (wait > waitMax) waitMax = wait
    })

    const history = Array.from(
      { length: 48 },
      (_, line) => `history ${line} ${"lorem ipsum dolor sit amet ".repeat(4)}`,
    )
    const body = new TextRenderable(app, { content: history.slice(-38).join("\n"), height: 38 })
    const status = new TextRenderable(app, { content: "ready", height: 1, fg: "#88cc88" })
    app.root.add(body)
    app.root.add(status)

    let setup = false
    let suspended = false
    let transition = false
    let unrestoredSuspends = 0
    let tokens = 0
    void app.setupTerminal().then(
      () => (setup = true),
      () => {},
    )
    const active = () => setup && !suspended && !transition && !app.isDestroyed
    const press = (event: { at: bigint }) => {
      if (!active()) return
      keysSent++
      keyArrival = event.at
      app.stdin.emit("data", Buffer.from(String.fromCharCode(97 + draw(26))))
    }
    const suspendCycle = () => {
      transition = true
      const offset = link.bytes.length
      app.suspend().then(
        () => {
          // I7: suspend resolves only after the restoration reached the link.
          if (!link.restored(offset) && !link.failed) unrestoredSuspends++
          suspended = true
          world.at("script", BigInt(1 + draw(50)) * MS, () => {
            app.resume().then(
              () => ((suspended = false), (transition = false)),
              () => {},
            )
          })
        },
        () => {},
      )
    }
    let at = 0n
    for (let remaining = EVENTS; remaining > 0; remaining--) {
      at += BigInt(1 + draw(20)) * MS
      const kind = draw(100)
      world.at("script", at - world.now, () => {
        if (app.isDestroyed) return
        if (kind < 55) {
          history[history.length - 1] += ` token${tokens++}`
          // A new line scrolls the whole view, as a streaming transcript does.
          if (draw(4) !== 0) history.push(`line ${history.length} ${"streamed output ".repeat(6)}`)
          body.content = history.slice(-38).join("\n")
          changed = true
          status.content = `${"|/-\\"[tokens % 4]} tokens ${tokens}`
        } else if (kind < 88) world.at("input", BigInt(draw(40)) * MS, press)
        else if (kind < 98) {
          const [width, height] = sizes[draw(sizes.length)]!
          if (active()) app.requestResize(width, height)
        } else if (active() && remaining > 20) suspendCycle()
      })
    }
    let scripted = false
    world.at("script", at, () => (scripted = true))
    await world.until(() => scripted)
    await world.until(() => !transition || app.isDestroyed)
    expect(keys, label).toBe(keysSent)
    expect(unrestoredSuspends, label).toBe(0)
    // On a slow link keys wait behind a blocking write today (388); the stdout writer thread makes this 0.
    if (preset === "ssh_slow" && fd === "blocking") expect(stalled, label).toBeGreaterThan(0)

    if (end !== "exit mid-stream") {
      // I9: with the script done, output drains and the loop goes idle within the link's bound, and the last
      // scene change has been committed.
      const start = world.now
      let quiet = false
      void app.idle().then(
        () => (quiet = true),
        () => (quiet = true),
      )
      await world.until(() => quiet)
      const bound = rate === null ? 200 : Math.ceil(((link.capacity + 2 * 65_536) * 1000) / rate) + 200
      expect(Number((world.now - start) / MS), label).toBeLessThanOrEqual(bound)
      expect(changed && !app.isDestroyed, label).toBe(false)
    }
    // A local terminal presents each frame in the turn that commits it (the writer thread's latency baseline).
    if (preset === "local_fast") expect(presentLag, label).toBe(0n)
    // A hangup fails the Session; nothing else may.
    expect(driver.error !== null, label).toBe(link.failed)

    const ended = world.now
    let restored = null as boolean | null
    if (end !== "destroy" && !app.isDestroyed) {
      const offset = link.bytes.length
      const restoreOnExit = driver.restoreOnExit
      driver.restoreOnExit = () => (restored = restoreOnExit.call(driver))
      ;(app as unknown as { nativeProcessExitHandler(): void }).nativeProcessExitHandler()
      // I7: a restoration that is reported has reached the link, and a blocking fd always restores.
      if (restored) expect(link.restored(offset), label).toBe(true)
      if (fd === "blocking" && !link.failed) expect(restored, label).toBe(true)
    } else app.destroy()
    await world.until(() => closed !== "pending")
    // A graceful close completes unless the link hung up.
    if (end === "destroy") expect(closed === "closed", label).toBe(!link.failed)
    const closeBound = 1000 + (rate === null ? 0 : Math.ceil((output.chunkSize * 1000) / rate)) + 100
    expect(Number((world.now - ended) / MS), label).toBeLessThanOrEqual(closeBound)
    world.record(`end ${closed} ${restored}`)
    const hash = world.hash >>> 0
    // OUTPUT_SIM_SUMMARY=1 prints the recorded baseline: owner stalls (I1) and exit outcomes (I7).
    if (process.env.OUTPUT_SIM_SUMMARY) {
      console.log(
        label,
        JSON.stringify({ hash, keys, stalled, waitMaxMs: Number(waitMax / MS), end, restored, closed }),
      )
    }
    return hash
  } finally {
    console.error = consoleError
    Object.defineProperty(process, "stdout", stdout)
    lib.sessionDrainStdout = drainStdout
    if (renderer && closed === "pending") {
      renderer.destroy()
      renderer.nativeScene.driver.dispose()
    }
  }
}

const rows = Object.keys(presets).flatMap((preset) =>
  (["writable", "fd"] as const).flatMap((path) =>
    Array.from({ length: path === "fd" ? SEEDS : WRITABLE_SEEDS }, (_, seed) => ({
      preset: preset as Preset,
      path,
      seed,
    })),
  ),
)

test.each(rows)("$preset $path seed $seed", async ({ preset, path, seed }) => {
  const hash = await simulate(preset, path, seed)
  // I11: a seed replays to the same trace.
  if (seed < REPLAY_SEEDS)
    expect(await simulate(preset, path, seed), `${preset} ${path} seed ${seed}: replay`).toBe(hash)
})
