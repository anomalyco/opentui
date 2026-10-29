// Deterministic simulation of the Session output driver on virtual time. A seeded script drives the real
// CliRenderer and NativeSession over a modeled link: pty and socket buffers drained at a fixed rate. Two output
// paths: a borrowed Writable (tickets), and process.stdout on fd 1, whose drain_stdout write is modeled with the
// ticket ABI as a blocking write, a non-blocking write (partial counts, EAGAIN), or a handle that cannot be written
// directly. Reproduce one row with `bun test native-session.sim -t "<row name>"`.
import { afterAll, expect, test } from "bun:test"
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
  onHangup = () => {}
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
      this.onHangup()
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
function modelDrainStdout(world: World, link: Link, fd: Fd, run: { blockedNs: bigint }): typeof lib.sessionDrainStdout {
  const drain = lib.sessionDrainStdout
  return (context, session, maxBytes = 65_536) => {
    if (fd === "unsupported") throw new NativeError("ot_session_drain_stdout", NativeStatus.UnsupportedResource)
    const capacity = fd === "blocking" || link.failed ? maxBytes : Math.min(maxBytes, link.room())
    if (capacity <= 0) return 0
    const bytes = new Uint8Array(capacity)
    const ticket = lib.sessionReadOutput(context, session, bytes)
    if (!ticket) return 0
    if (fd === "blocking") {
      const wait = link.delay(ticket.byteCount)
      world.now += wait
      run.blockedNs += wait
    }
    const written = link.accept(bytes.subarray(0, ticket.byteCount)) === ticket.byteCount
    lib.sessionCompleteOutput(context, session, ticket, written)
    // A failed transport reports itself through the real call, as drain_stdout does.
    return written ? ticket.byteCount : drain.call(lib, context, session, maxBytes)
  }
}

interface Run {
  hash: number
  steps: number
  fd: Fd | null
  keys: number
  keysSent: number
  stalledKeys: number
  keyWaitMaxMs: number
  blockedNs: bigint
  committed: number
  presented: number
  i2: string[]
  suspends: number
  suspendsUnrestored: number
  end: "destroy" | "exit" | "exit mid-stream"
  exit:
    | "restored"
    | "claimed without bytes"
    | "borrowed sink"
    | "ticket in flight"
    | "zero-byte drain"
    | "unsupported"
    | null
  closed: string
  failed: boolean
  hangupInFrame: boolean
  sessionError: string | null
  quiesceMs: number
  stale: boolean
  quiesceBoundMs: number
  closeMs: number
  closeBoundMs: number
}

async function simulate(preset: Preset, path: Path, seed: number): Promise<Run> {
  const draw = random(seed)
  const world = new World(random(seed ^ 0x5eed))
  const config = presets[preset]
  const rate = config.rate === null ? null : Math.round(config.rate * (0.75 + draw(51) / 100))
  const link = new Link(world, rate, config.capacity, config.hangup ? 20_000 + draw(200_000) : null)
  const sink = new LinkSink(world, link)
  const run: Run = {
    hash: 0,
    steps: 0,
    fd: path === "fd" ? fds[seed % fds.length]! : null,
    keys: 0,
    keysSent: 0,
    stalledKeys: 0,
    keyWaitMaxMs: 0,
    blockedNs: 0n,
    committed: 0,
    presented: 0,
    i2: [],
    suspends: 0,
    suspendsUnrestored: 0,
    end: (["destroy", "exit", "exit mid-stream"] as const)[draw(3)]!,
    exit: null,
    closed: "pending",
    failed: false,
    hangupInFrame: false,
    sessionError: null,
    quiesceMs: 0,
    stale: false,
    quiesceBoundMs: 0,
    closeMs: 0,
    closeBoundMs: 0,
  }
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!
  const drainStdout = lib.sessionDrainStdout
  const consoleError = console.error
  console.error = () => {}
  if (run.fd) {
    sink.fd = 1
    Object.defineProperty(process, "stdout", { value: sink, configurable: true, writable: true })
    lib.sessionDrainStdout = modelDrainStdout(world, link, run.fd, run)
  }
  let renderer: CliRenderer | undefined
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
      () => (run.closed = "closed"),
      (error: Error) => (run.closed = error.message),
    )
    const pendingFrame = () =>
      !driver.disposed && lib.sessionGetRendererState(driver.context, driver.session).framePending
    let inFlight = false
    let changed = false
    link.onHangup = () => (run.hangupInFrame = pendingFrame())
    const render = driver.render
    driver.render = (force, frame) => {
      // I2: the renderer commits only after the previous frame was presented.
      if (pendingFrame()) run.i2.push(`commit at ${world.now} while a frame is pending`)
      const status = render.call(driver, force, frame)
      if (status === NativeSessionRenderStatus.Pending || status === NativeSessionRenderStatus.Presented) {
        run.committed++
        changed = false
      }
      if (status === NativeSessionRenderStatus.Presented) run.presented++
      inFlight ||= status === NativeSessionRenderStatus.Pending
      return status
    }
    let keyArrival = 0n
    app.keyInput.on("keypress", () => {
      run.keys++
      const wait = world.now - keyArrival
      if (wait > 0n) run.stalledKeys++
      run.keyWaitMaxMs = Math.max(run.keyWaitMaxMs, Number(wait / MS))
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
    let tokens = 0
    void app.setupTerminal().then(
      () => (setup = true),
      () => {},
    )
    const active = () => setup && !suspended && !transition && !app.isDestroyed
    const press = (event: { at: bigint }) => {
      if (!active()) return
      run.keysSent++
      keyArrival = event.at
      app.stdin.emit("data", Buffer.from(String.fromCharCode(97 + draw(26))))
    }
    const suspendCycle = () => {
      transition = true
      const offset = link.bytes.length
      app.suspend().then(
        () => {
          run.suspends++
          // I7: suspend resolves only after the restoration reached the link.
          if (!link.restored(offset) && !link.failed) run.suspendsUnrestored++
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
    const check = () => {
      if (inFlight && !pendingFrame()) {
        inFlight = false
        run.presented++
      }
      if (run.committed - run.presented > 1 || run.committed < run.presented) {
        run.i2.push(`committed ${run.committed}, presented ${run.presented} at ${world.now}`)
      }
    }
    await world.until(() => (check(), scripted))
    await world.until(() => (check(), !transition || app.isDestroyed))

    if (run.end !== "exit mid-stream") {
      // I9: with the script done, output drains and the loop goes idle within the link's bound.
      const start = world.now
      let quiet = false
      void app.idle().then(
        () => (quiet = true),
        () => (quiet = true),
      )
      await world.until(() => (check(), quiet))
      run.quiesceMs = Number((world.now - start) / MS)
      run.stale = changed && !app.isDestroyed
    }
    run.quiesceBoundMs = rate === null ? 200 : Math.ceil(((link.capacity + 2 * 65_536) * 1000) / rate) + 200
    run.failed = link.failed
    run.sessionError = driver.error?.message ?? null

    const end = world.now
    if (run.end !== "destroy" && !app.isDestroyed) {
      const offset = link.bytes.length
      const ticket = (driver as unknown as { output: { completed: boolean } | null }).output
      let restored = false
      const restoreOnExit = driver.restoreOnExit
      driver.restoreOnExit = () => (restored = restoreOnExit.call(driver))
      ;(app as unknown as { nativeProcessExitHandler(): void }).nativeProcessExitHandler()
      if (restored) run.exit = link.restored(offset) ? "restored" : "claimed without bytes"
      else if (!run.fd) run.exit = "borrowed sink"
      else if (ticket && !ticket.completed) run.exit = "ticket in flight"
      else if (driver.error instanceof NativeError) run.exit = "unsupported"
      else run.exit = "zero-byte drain"
    } else app.destroy()
    await world.until(() => run.closed !== "pending")
    run.closeMs = Number((world.now - end) / MS)
    run.closeBoundMs = 1000 + (rate === null ? 0 : Math.ceil((output.chunkSize * 1000) / rate)) + 100
    run.steps = world.steps
    world.record(`end ${run.closed} ${run.exit}`)
    run.hash = world.hash >>> 0
    return run
  } finally {
    console.error = consoleError
    Object.defineProperty(process, "stdout", stdout)
    lib.sessionDrainStdout = drainStdout
    if (renderer && run.closed === "pending") {
      renderer.destroy()
      renderer.nativeScene.driver.dispose()
    }
  }
}

const rows = Object.keys(presets).flatMap((preset) =>
  (["writable", "fd"] as const).flatMap((path) =>
    Array.from({ length: SEEDS }, (_, seed) => ({ preset: preset as Preset, path, seed })),
  ),
)
const runs = new Map<string, Run>()

test.each(rows)("$preset $path seed $seed", async ({ preset, path, seed }) => {
  const run = await simulate(preset, path, seed)
  runs.set(`${preset} ${path} ${seed}`, run)
  const label = `seed ${seed} ${preset} ${path}${run.fd ? `/${run.fd}` : ""}, ${run.steps} steps, trace ${run.hash.toString(16)}`
  expect({ label, i2: run.i2 }).toEqual({ label, i2: [] })
  expect({ label, suspendsUnrestored: run.suspendsUnrestored }).toEqual({ label, suspendsUnrestored: 0 })
  // I1: only a blocking fd write holds the owner. On a slow link keys wait behind it today (388); the stdout
  // writer thread turns this row into stalledKeys 0.
  if (run.fd !== "blocking") expect({ label, stalledKeys: run.stalledKeys }).toEqual({ label, stalledKeys: 0 })
  else if (preset === "ssh_slow") expect(run.stalledKeys, label).toBeGreaterThan(0)
  expect({ label, keys: run.keys }).toEqual({ label, keys: run.keysSent })
  expect(run.quiesceMs, label).toBeLessThanOrEqual(run.quiesceBoundMs)
  // I9: at quiescence the last scene change has been committed.
  expect({ label, stale: run.stale }).toEqual({ label, stale: false })
  expect(run.closeMs, label).toBeLessThanOrEqual(run.closeBoundMs)
  // A hangup fails the Session instead of restoring; nothing else may fail it.
  expect({ label, failed: run.sessionError !== null }).toEqual({ label, failed: run.failed })
  if (run.fd === "blocking" && !run.failed && run.exit)
    expect({ label, exit: run.exit }).toEqual({ label, exit: "restored" })
  expect({ label, exit: run.exit }).not.toEqual({ label, exit: "claimed without bytes" })
  if (seed < REPLAY_SEEDS) expect((await simulate(preset, path, seed)).hash, `${label}: replay`).toBe(run.hash)
})

// OUTPUT_SIM_SUMMARY=1 prints the recorded baseline: owner stalls (I1) and exit outcomes (I7) per path.
afterAll(() => {
  if (!process.env.OUTPUT_SIM_SUMMARY) return
  const groups = new Map<string, Record<string, number | string[]>>()
  for (const [key, run] of runs) {
    const [preset, , seed] = key.split(" ")
    const name = `${preset} ${run.fd ?? "writable"}`
    const group = groups.get(name) ?? {
      keys: 0,
      stalled: 0,
      waitMaxMs: 0,
      blockedMs: 0,
      suspends: 0,
      hangupInFrame: 0,
      ends: [],
    }
    group.keys = (group.keys as number) + run.keys
    group.stalled = (group.stalled as number) + run.stalledKeys
    group.waitMaxMs = Math.max(group.waitMaxMs as number, run.keyWaitMaxMs)
    group.blockedMs = (group.blockedMs as number) + Number(run.blockedNs / MS)
    group.suspends = (group.suspends as number) + run.suspends
    group.hangupInFrame = (group.hangupInFrame as number) + Number(run.hangupInFrame)
    ;(group.ends as string[]).push(`${seed}:${run.hash.toString(16)}:${run.end}=${run.exit ?? run.closed}`)
    groups.set(name, group)
  }
  for (const [name, group] of groups) console.log(name, JSON.stringify(group))
})
