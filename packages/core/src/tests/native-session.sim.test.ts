// Seeded simulation of the real CliRenderer and NativeSession on virtual time over a modeled link, through a
// borrowed Writable and through fd 1. On fd 1 the stdout writer thread (post_stdout) and, with
// OTUI_STDOUT_THREAD=0, the synchronous drain_stdout write are modeled with the ticket ABI.
import { expect, test } from "bun:test"
import { clearEnvCache } from "../lib/env.js"
import { NativeSession } from "../NativeSession.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderer } from "../renderer.js"
import { settle } from "../testing/harness.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"
import {
  NativeError,
  NativeSessionPumpStatus,
  NativeSessionRenderStatus,
  NativeSessionTerminalPhase,
  NativeStatus,
  resolveRenderLib,
  type NativeOutputTicket,
} from "../zig.js"

const lib = resolveRenderLib()
const MS = 1_000_000n
// Small chunks, so a full repaint spans several tickets.
const output = { chunkSize: 4096, spanCapacity: 128, maxBytes: 8_388_608n, controlCapacity: 4096 }
// What suspend, exit and close must have handed to the link: the cursor shown and the alternate screen left.
const restoration = ["\x1b[?25h", "\x1b[?1049l"]
const timeout = "NativeSession graceful close timed out; output cancelled without restoration"
const fds = ["blocking", "nonblocking", "unsupported"] as const
type Fd = (typeof fds)[number]
// Width and height pairs.
const sizes = [120, 40, 100, 30, 132, 43]

const presets = {
  local_fast: { rate: null, capacity: 18_944, hangup: false, stall: 0 },
  ssh_slow: { rate: 48_000, capacity: 18_944 + 65_536, hangup: false, stall: 0 },
  hangup_mid_frame: { rate: 48_000, capacity: 18_944 + 65_536, hangup: true, stall: 0 },
  // The link stalls for 4 s as the run ends, past the 1 s close timeout, with a write running.
  close_timeout: { rate: 48_000, capacity: 18_944 + 65_536, hangup: false, stall: 4000 },
  // The link stalls as the run ends and does not recover within the run.
  close_stuck: { rate: 48_000, capacity: 18_944 + 65_536, hangup: false, stall: 3_600_000 },
  // R23: split-footer captured stdout at about 1,000 lines a second, titles and a 1 MiB OSC 52 on a 16 KB/s link;
  // what each producer gets at its limit and the JS queue's peak are recorded.
  producer_flood: { rate: 16_000, capacity: 18_944 + 65_536, hangup: false, stall: 0 },
}
type Preset = keyof typeof presets
// fd: the stdout writer thread; fd-off: OTUI_STDOUT_THREAD=0, today's drain on the JS thread.
type Path = "writable" | "fd" | "fd-off"

/** Runs `then` once the promise resolves; the run observes rejections elsewhere. */
const after = (promise: Promise<unknown>, then: () => unknown) => void promise.then(then, () => {})

function random(seed: number): (limit: number) => number {
  let state = seed | 0
  return (limit) => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296) * limit)
  }
}

type Event = { at: bigint; actor: string; run: () => void }

/** One virtual time for the Session scheduler (ns) and the renderer's ManualClock (ms). */
class World {
  now = 0n
  steps = 0
  hostTurns = 0
  hash = 0x811c9dc5
  // I15: at most one pending later-turn task and one pending timed task share the Session scheduler.
  extraTasks = 0
  readonly clock = new ManualClock()
  private readonly events = new Set<Event>()
  private readonly live = { immediate: 0, delayed: 0 }
  readonly scheduler = {
    now: () => this.now,
    schedule: (callback: () => void, delayMs?: number) => {
      const slot = delayMs === undefined ? "immediate" : "delayed"
      if (++this.live[slot] > 1) this.extraTasks++
      const event = this.at("host", BigInt(delayMs ?? 0) * MS, () => {
        this.live[slot]--
        this.hostTurns++
        callback()
      })
      return () => void (this.events.delete(event) && this.live[slot]--)
    },
  }

  constructor(private readonly tie: (limit: number) => number) {}

  get settled(): boolean {
    return this.events.size === 0 && this.clock.pendingTimerCount === 0
  }

  at(actor: string, delayNs: bigint, run: (event: Event) => void): Event {
    const event: Event = { at: this.now + delayNs, actor, run: () => run(event) }
    this.events.add(event)
    return event
  }

  cancel(event: Event): void {
    this.events.delete(event)
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
      // A Set iterates in insertion order, so the first due event of each actor is its FIFO head.
      const heads = new Map<string, Event>()
      for (const event of this.events) if (event.at <= due && !heads.has(event.actor)) heads.set(event.actor, event)
      const event = [...heads.values()][this.tie(heads.size)]!
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
  // Latin-1 keeps one character per byte.
  stream = ""
  failed = false
  /** The link moves nothing before this time. */
  stalledUntil = 0n
  /** A split footer has no alternate screen to leave. */
  restoration = restoration
  private backlog = 0
  private measured = 0n

  constructor(
    readonly world: World,
    readonly rate: number | null,
    readonly capacity: number,
    private readonly hangupAt: number | null,
  ) {}

  room(): number {
    if (this.rate === null) return Number.MAX_SAFE_INTEGER
    const moving =
      this.world.now > this.stalledUntil
        ? this.world.now - (this.measured > this.stalledUntil ? this.measured : this.stalledUntil)
        : 0n
    this.backlog = Math.max(0, this.backlog - (this.rate * Number(moving)) / 1e9)
    this.measured = this.world.now
    return Math.floor(this.capacity - this.backlog)
  }

  /** Whole milliseconds until `count` bytes fit. A stalled link (a frozen ssh with a full pty) takes nothing. */
  delay(count: number): bigint {
    const excess = count - this.room()
    const stall = this.stalledUntil > this.world.now ? this.stalledUntil - this.world.now : 0n
    return (excess <= 0 ? 0n : BigInt(Math.ceil((excess * 1000) / this.rate!)) * MS) + stall
  }

  /** Takes the bytes; after a hangup only the prefix before it. Returns the count taken. */
  accept(bytes: Uint8Array): number {
    let count = this.failed ? 0 : bytes.length
    if (!this.failed && this.hangupAt !== null && this.stream.length + count >= this.hangupAt) {
      count = Math.max(0, this.hangupAt - this.stream.length)
      this.failed = true
    }
    this.room()
    this.backlog += count
    this.stream += Buffer.from(bytes.subarray(0, count)).toString("latin1")
    this.world.record(this.failed ? "link hangup" : "link", bytes.subarray(0, count))
    return count
  }

  restored(offset: number): boolean {
    return this.restoration.every((sequence) => this.stream.includes(sequence, offset))
  }
}

/** A Writable over the link: each write completes once the link has taken all of its bytes. */
class LinkSink extends TestWriteStream {
  fd: number | undefined

  constructor(private readonly link: Link) {
    super(120, 40, { highWaterMark: 1 })
  }

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    const bytes = Uint8Array.from(chunk)
    this.link.world.at("link", this.link.delay(bytes.length), () => {
      done(this.link.accept(bytes) < bytes.length ? new Error("EIO") : null)
    })
  }
}

/**
 * Replaces the fd 1 write of drain_stdout with the ticket ABI, which moves the span prefix drainOutput offers: a
 * blocking fd takes it all while the owner waits, a non-blocking one what fits (0 is EAGAIN); a hangup fails it.
 */
type Calls = {
  posts: number
  drains: number
  exiting: boolean
  runningDrains: number
  idleCollects: number
  busyPolls: number
}

function modelDrainStdout(world: World, link: Link, fd: Fd, calls: Calls): typeof lib.sessionDrainStdout {
  return (context, session, maxBytes = 65_536) => {
    calls.drains++
    if (!calls.exiting) calls.runningDrains++
    if (fd === "unsupported") throw new NativeError("ot_session_drain_stdout", NativeStatus.UnsupportedResource)
    const capacity = fd === "blocking" || link.failed ? maxBytes : Math.min(maxBytes, link.room())
    if (capacity <= 0) return 0
    const bytes = new Uint8Array(capacity)
    const ticket = lib.sessionReadOutput(context, session, bytes)
    if (!ticket) return 0
    if (fd === "blocking") world.now += link.delay(ticket.byteCount)
    const written = link.accept(bytes.subarray(0, ticket.byteCount)) === ticket.byteCount
    lib.sessionCompleteOutput(context, session, ticket, written)
    if (!written) throw new NativeError("ot_session_drain_stdout", NativeStatus.OutputFailed)
    return ticket.byteCount
  }
}

/**
 * The stdout writer thread on fd 1 (post_stdout), over the ticket ABI. A copy's write is a world event that
 * completes once the link has room for it (the thread's blocking write); its publish is a later seeded event, so
 * a destroy, the close timeout or exit can land between the two. wait=1 (exit) advances virtual time to the
 * write's end. Collecting completes the real ticket, which presents frames; a hangup fails it.
 */
function modelPostStdout(world: World, link: Link, fd: Fd, calls: Calls, publishDelay: () => bigint) {
  type Copy = {
    ticket: NativeOutputTicket
    bytes: Uint8Array
    state: "writing" | "written" | "published"
    ok: boolean
    event: Event | null
  }
  let copy: Copy | null = null
  const buffer = new Uint8Array(65_536)
  const write = (current: Copy) => {
    current.ok = link.accept(current.bytes) === current.bytes.length
    current.state = "written"
  }
  const model: typeof lib.sessionPostStdout = (context, session, maxBytes, wait) => {
    calls.posts++
    if (fd === "unsupported") {
      if (wait) return { written: 0, inFlight: false }
      throw new NativeError("ot_session_post_stdout", NativeStatus.UnsupportedResource)
    }
    let written = 0
    if (copy) {
      if (copy.state !== "published") {
        if (!wait) {
          calls.busyPolls++
          return { written: 0, inFlight: true }
        }
        if (copy.event) world.cancel(copy.event)
        if (copy.state === "writing") {
          world.now += link.delay(copy.bytes.length)
          write(copy)
        }
        copy.state = "published"
      }
      const done = copy
      copy = null
      lib.sessionCompleteOutput(context, session, done.ticket, done.ok)
      if (!done.ok) throw new NativeError("ot_session_post_stdout", NativeStatus.OutputFailed)
      written = done.ticket.byteCount
    }
    // I12: on fd 1 the driver collects and starts the next copy in one call.
    if (!wait && maxBytes === 0 && written > 0) calls.idleCollects++
    if (wait || maxBytes === 0) return { written, inFlight: false }
    const ticket = lib.sessionReadOutput(context, session, buffer.subarray(0, Math.min(maxBytes, buffer.length)))
    if (!ticket) return { written, inFlight: false }
    const current: Copy = { ticket, bytes: buffer.slice(0, ticket.byteCount), state: "writing", ok: true, event: null }
    current.event = world.at("writer", link.delay(current.bytes.length), () => {
      write(current)
      current.event = world.at("writer", publishDelay(), () => {
        current.event = null
        current.state = "published"
      })
    })
    copy = current
    return { written, inFlight: true }
  }
  return model
}

/** Runs one seeded script and checks the invariants where they apply. Returns the trace hash. */
async function simulate(preset: Preset, path: Path, seed: number): Promise<number> {
  const draw = random(seed)
  const world = new World(random(seed ^ 0x5eed))
  const config = presets[preset]
  const rate = config.rate === null ? null : Math.round(config.rate * (0.75 + draw(51) / 100))
  const link = new Link(world, rate, config.capacity, config.hangup ? 20_000 + draw(200_000) : null)
  const sink = new LinkSink(link)
  if (preset === "producer_flood") link.restoration = restoration.slice(0, 1)
  const fd = path === "writable" ? null : fds[seed % fds.length]!
  const writer = path === "fd"
  const flood = preset === "producer_flood"
  const end = config.stall
    ? "destroy"
    : flood
      ? "destroy mid-stream"
      : (["destroy", "exit", "exit mid-stream", "destroy mid-stream"] as const)[draw(4)]!
  const label = `${preset} ${path}${fd ? `/${fd}` : ""} seed ${seed}`
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!
  const drainStdout = lib.sessionDrainStdout
  const postStdout = lib.sessionPostStdout
  const calls: Calls = { posts: 0, drains: 0, exiting: false, runningDrains: 0, idleCollects: 0, busyPolls: 0 }
  const consoleError = console.error
  console.error = () => {}
  // Fail closed: the real post_stdout would start a thread on this process's fd 1. Only the model may run.
  lib.sessionPostStdout = () => {
    throw new Error(`${label}: the real post_stdout was reached in a simulation`)
  }
  if (path === "fd-off") process.env.OTUI_STDOUT_THREAD = "0"
  else delete process.env.OTUI_STDOUT_THREAD
  clearEnvCache()
  if (fd) {
    sink.fd = 1
    Object.defineProperty(process, "stdout", { value: sink, configurable: true, writable: true })
    lib.sessionDrainStdout = modelDrainStdout(world, link, fd, calls)
    // A local terminal's thread publishes at once; elsewhere 0-2 ms after its write.
    if (writer)
      lib.sessionPostStdout = modelPostStdout(world, link, fd, calls, () => (rate === null ? 0n : BigInt(draw(3)) * MS))
  }
  let renderer: CliRenderer | undefined
  let closed = "pending"
  try {
    const driver = new NativeSession(sink, { scheduler: world.scheduler, output })
    const app = (renderer = new CliRenderer(createTestStdin(), sink as unknown as NodeJS.WriteStream, 120, 40, {
      nativeSession: driver,
      clock: world.clock,
      remote: true,
      screenMode: flood ? "split-footer" : "alternate-screen",
      ...(flood ? { externalOutputMode: "capture-stdout" as const, footerHeight: 12 } : {}),
      consoleMode: "disabled",
      exitSignals: [],
      exitOnCtrlC: false,
      debounceDelay: 20,
    }))
    void app.closed.then(() => (closed = "closed")).catch((error: Error) => (closed = error.message))
    let changed = false
    let slowFrames = 0
    const render = driver.render
    driver.render = (force, frame) => {
      const status = render.call(driver, force, frame)
      changed &&= status !== NativeSessionRenderStatus.Pending && status !== NativeSessionRenderStatus.Presented
      if (status === NativeSessionRenderStatus.Pending && preset === "local_fast") {
        // R20: on a local terminal every path presents each frame in the virtual instant it commits. The synchronous
        // paths take one owner turn per output chunk (plus one for a Writable callback). The writer thread takes
        // one more turn per frame, besides polls that find the copy still being written; those are the next turns,
        // which a write that loses the same-instant tie costs.
        const [committedAt, turns, offset, busy] = [world.now, world.hostTurns, link.stream.length, calls.busyPolls]
        after(driver.whenPresented(), () => {
          const chunks = Math.max(1, Math.ceil((link.stream.length - offset) / output.chunkSize))
          const threaded = writer && fd !== "unsupported"
          const spare = threaded ? 1 : fd === "blocking" || fd === "nonblocking" ? 0 : 1
          const extra = world.hostTurns - turns - (calls.busyPolls - busy) - chunks
          if (world.now !== committedAt || extra > spare) slowFrames++
        })
      }
      return status
    }
    let keysSent = 0
    let keys = 0
    let stalled = 0
    let waitMax = 0n
    let keyArrival = 0n
    app.keyInput.on("keypress", () => {
      const wait = world.now - keyArrival
      // I1: only today's blocking fd write holds the owner; with the writer thread nothing does.
      if (fd !== "blocking" || writer) expect(wait, label).toBe(0n)
      keys++
      if (wait > 0n) stalled++
      if (wait > waitMax) waitMax = wait
    })

    const filler = "lorem ipsum dolor sit amet ".repeat(4)
    const history = Array.from({ length: 48 }, (_, line) => `history ${line} ${filler}`)
    const body = new TextRenderable(app, { content: history.slice(-38).join("\n"), height: 38 })
    const status = new TextRenderable(app, { content: "ready", height: 1, fg: "#88cc88" })
    app.root.add(body)
    app.root.add(status)

    let setup = false
    let transition = false
    let badTransitions = 0
    let tokens = 0
    // I7: a transition resolves only after its output reached the link.
    const checkActive = () => {
      const phase = link.failed || lib.sessionGetTerminalState(driver.context, driver.session)
      if (phase !== true && phase !== NativeSessionTerminalPhase.Active) badTransitions++
    }
    after(app.setupTerminal(), () => ((setup = true), checkActive()))
    const active = () => setup && !transition && !app.isDestroyed
    const press = (event: { at: bigint }) => {
      if (!active()) return
      keysSent++
      keyArrival = event.at
      app.stdin.emit("data", Buffer.from(String.fromCharCode(97 + draw(26))))
    }
    const resume = () => after(app.resume(), () => ((transition = false), checkActive()))
    // I13: capability replies arrive at any time, during transitions and with a copy in flight; they are applied
    // or consumed, never delivered as keys.
    const reply = () => app.stdin.emit("data", Buffer.from("\x1b[?1004;1$y\x1b[?2004;2$y\x1b[?2026;2$y\x1b[?62;22c"))
    // R23: each producer's outcome at the limit, and the captured-stdout queue's peak.
    const produced = { accepted: 0, refused: 0, errors: 0, queuePeak: 0 }
    const produce = (call: () => boolean | void) => {
      try {
        if (call() === false) produced.refused++
        else produced.accepted++
      } catch {
        produced.errors++
      }
    }
    const floodTick = () => {
      for (let line = 0; line < 10; line++) produce(() => void sink.write(`captured ${tokens} ${line} ${filler}\n`))
      produce(() => app.setTerminalTitle(`flood ${tokens}`))
      if (draw(20) === 0) produce(() => app.copyToClipboardOSC52("x".repeat(1 << 20)))
      const queue = (app as unknown as { externalOutputQueue: { size: number } }).externalOutputQueue
      produced.queuePeak = Math.max(produced.queuePeak, queue.size)
    }
    const suspendCycle = (offset = link.stream.length) =>
      after(app.suspend(), () => {
        if (!link.restored(offset) && !link.failed) badTransitions++
        world.at("script", BigInt(1 + draw(50)) * MS, resume)
      })
    let at = 0n
    for (let remaining = 200; remaining > 0; remaining--) {
      at += BigInt(1 + draw(20)) * MS
      const kind = draw(100)
      world.at("script", at - world.now, () => {
        if (app.isDestroyed) return
        if (flood && active()) floodTick()
        // Not on local_fast, whose per-frame turn count (R20) a reply's control packet would add to.
        if (kind < 3 && preset !== "local_fast") reply()
        if (kind < 55) {
          history[history.length - 1] += ` token${tokens++}`
          // A new line scrolls the whole view, as a streaming transcript does.
          if (draw(4) !== 0) history.push(`line ${history.length} ${"streamed output ".repeat(6)}`)
          body.content = history.slice(-38).join("\n")
          changed = true
          status.content = `${"|/-\\"[tokens % 4]} tokens ${tokens}`
        } else if (kind < 88) world.at("input", BigInt(draw(40)) * MS, press)
        else if (kind < 98) {
          const size = 2 * draw(3)
          if (active()) app.requestResize(sizes[size]!, sizes[size + 1]!)
        } else if (active() && remaining > 20) {
          transition = true
          suspendCycle()
        }
      })
    }
    let scripted = false
    world.at("script", at, () => (scripted = true))
    await world.until(() => scripted)
    await world.until(() => !transition || app.isDestroyed)
    expect(keys, label).toBe(keysSent)
    expect(badTransitions, label).toBe(0)
    // On a slow link keys wait behind a blocking write with the writer thread off (388, today's behavior).
    if (preset === "ssh_slow" && fd === "blocking" && path === "fd-off") expect(stalled, label).toBeGreaterThan(0)
    if (writer) expect(stalled, label).toBe(0)

    const bound = rate === null ? 200 : Math.ceil(((link.capacity + 2 * 65_536) * 1000) / rate) + 200
    if (!end.endsWith("mid-stream")) {
      // I9: with the script done, a queued control and all frames drain within the link's bound, idle reports
      // it, and the last scene change has been committed.
      const start = world.now
      let idleFailed = false
      const quiesce = async () => {
        let quiet = false
        after(
          app.idle().catch(() => (idleFailed = true)),
          () => (quiet = true),
        )
        await world.until(() => quiet)
      }
      // The control goes after a first idle, so it cannot restart a driver that stalled on its own.
      await quiesce()
      if (active()) app.setTerminalTitle("done")
      await quiesce()
      expect(Number((world.now - start) / MS), label).toBeLessThanOrEqual(bound)
      expect(changed && !app.isDestroyed, label).toBe(false)
      if (!link.failed) {
        expect(idleFailed, label).toBe(false)
        const pump = lib.sessionPump(driver.context, driver.session, world.now, 1)
        expect(pump.status, label).toBe(NativeSessionPumpStatus.Idle)
      }
    }
    expect(slowFrames, label).toBe(0)
    expect(world.extraTasks, label).toBe(0)
    // A hangup fails the Session; nothing else may.
    expect(driver.error !== null, label).toBe(link.failed)

    const ended = world.now
    const offset = link.stream.length
    let restored = null as boolean | null
    if (end.startsWith("exit") && !app.isDestroyed) {
      const restoreOnExit = driver.restoreOnExit
      driver.restoreOnExit = () => (restored = restoreOnExit.call(driver))
      calls.exiting = true
      ;(app as unknown as { nativeProcessExitHandler(): void }).nativeProcessExitHandler()
      // I7: a restoration that is reported has reached the link, and a blocking fd always restores. R30: through
      // the writer thread a non-blocking fd restores too (today's drain gives up on it).
      if (restored) expect(link.restored(offset), label).toBe(true)
      const restores = fd === "blocking" || (writer && fd === "nonblocking")
      if (restores && !link.failed) expect(restored, label).toBe(true)
    } else {
      if (config.stall) link.stalledUntil = world.now + BigInt(config.stall) * MS
      app.destroy()
    }
    // R27 (#1870): over a stall the close waits for the writer's copy in flight and restores once the link moves,
    // or keeps waiting. The close timeout cancels any other wait, without claiming restoration.
    const waits = config.stall > 0 && writer && fd !== "unsupported"
    await world.until(() => closed !== "pending" || (waits && world.now - ended > 10_000n * MS))
    // A graceful close completes and restores unless the link hung up. Exit drains synchronously, without the
    // close timeout, so only the queue bounds it.
    if (config.stall) {
      expect(closed, label).toBe(!waits ? timeout : preset === "close_stuck" ? "pending" : "closed")
      if (closed === "pending") driver.dispose()
      await world.until(() => closed !== "pending")
    } else if (end.startsWith("destroy") && !flood) expect(closed === "closed", label).toBe(!link.failed)
    if (closed === "closed") expect(link.restored(offset), label).toBe(true)
    // The writer holds the close while the link takes its copies (#1870), and a blocking drain over the stall.
    const held =
      (waits || fd === "blocking" ? config.stall : 0) +
      (writer && rate ? ((link.stream.length - offset) * 1000) / rate : 0)
    const closeBound = held + 1000 + (rate === null ? 0 : Math.ceil((output.chunkSize * 1000) / rate)) + 100
    expect(Number((world.now - ended) / MS), label).toBeLessThanOrEqual(end.startsWith("destroy") ? closeBound : bound)
    // I8: nothing reaches the link after a close, and the driver leaves the sink.
    const afterClose = link.stream.length
    await world.until(() => world.settled)
    if (closed === "closed") expect(link.stream.length, label).toBe(afterClose)
    expect(sink.listenerCount("drain"), label).toBe(0)
    // R24: the writer rows ran the post model, with the drain only at exit; the unsupported writer falls back
    // after one refusal; today's paths never post.
    if (writer && fd !== "unsupported") {
      expect(calls.posts, label).toBeGreaterThan(0)
      // Exit goes through the writer too (R30): no drain at all.
      expect(calls.drains, label).toBe(0)
      expect(calls.idleCollects, label).toBe(0)
    } else if (writer) expect(calls.posts, label).toBe(1)
    else expect(calls.posts, label).toBe(0)
    world.record(`end ${closed} ${restored}`)
    const hash = world.hash >>> 0
    // OUTPUT_SIM_SUMMARY=1 prints the recorded baseline: owner stalls (I1) and exit outcomes (I7).
    const summary = {
      hash,
      keys,
      stalled,
      waitMaxMs: Number(waitMax / MS),
      end,
      restored,
      closed,
      ...(flood ? produced : {}),
    }
    if (process.env.OUTPUT_SIM_SUMMARY) console.log(label, JSON.stringify(summary))
    return hash
  } finally {
    console.error = consoleError
    Object.defineProperty(process, "stdout", stdout)
    lib.sessionDrainStdout = drainStdout
    lib.sessionPostStdout = postStdout
    delete process.env.OTUI_STDOUT_THREAD
    clearEnvCache()
    if (renderer && closed === "pending") {
      renderer.destroy()
      renderer.nativeScene.driver.dispose()
    }
  }
}

// The Writable path matches the fd unsupported fallback up to exit, so it needs fewer seeds.
const seeds: Record<Path, number> = { writable: 4, fd: 16, "fd-off": 16 }
const rows = (Object.keys(presets) as Preset[]).flatMap((preset) =>
  (preset === "producer_flood" ? (["fd"] as const) : (["writable", "fd", "fd-off"] as const)).flatMap((path) =>
    Array.from({ length: presets[preset].stall ? 6 : preset === "producer_flood" ? 3 : seeds[path] }, (_, seed) => ({
      preset,
      path,
      seed,
    })),
  ),
)

test.each(rows)("$preset $path seed $seed", async ({ preset, path, seed }) => {
  const hash = await simulate(preset, path, seed)
  // I11: a seed replays to the same trace.
  if (seed < 4) expect(await simulate(preset, path, seed), `${preset} ${path} seed ${seed}: replay`).toBe(hash)
})
