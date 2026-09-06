import { Duplex } from "node:stream"
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { CliRenderEvents, NativeSession, TextRenderable, createCliRenderer, type CliRenderer } from "@opentui/core"
import type { ServerChannel } from "ssh2"
import { createSessionBridge, DEFAULT_PTY, type RendererFactory, type SessionBridge } from "../../bridge.js"
import { DenyError, OutputPressureError } from "../../errors.js"
import { runSession } from "../../run-session.js"
import { createSafeInvoke } from "../../safe.js"
import { deferred, waitFor } from "../support.js"

class Channel extends Duplex {
  chunks: Buffer[] = []
  complete: ((error?: Error | null) => void) | undefined
  automatic = false
  holdWhen: RegExp | undefined
  holdDestroy = false
  finishDestroy: (() => void) | undefined
  closeCalls = 0
  exitCode: number | undefined
  constructor(
    highWaterMark = 1,
    readonly destroyOnClose = true,
  ) {
    super({ highWaterMark })
  }
  _read() {}
  _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (this.holdDestroy)
      this.finishDestroy = () => {
        this.finishDestroy = undefined
        callback(error)
      }
    else callback(error)
  }
  _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.from(bytes))
    if (this.holdWhen?.test(bytes.toString())) this.automatic = false
    if (this.automatic) callback()
    else this.complete = callback
  }
  release(error?: Error) {
    const callback = this.complete
    this.complete = undefined
    callback?.(error)
  }
  exit(code: number) {
    this.exitCode = code
  }
  close() {
    this.closeCalls++
    if (this.destroyOnClose) this.destroy()
  }
  get output() {
    return Buffer.concat(this.chunks).toString()
  }
}

const bridges: SessionBridge[] = []
const channels: Channel[] = []
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
afterEach(async () => {
  for (const channel of channels) {
    channel.holdDestroy = false
    channel.automatic = true
    channel.release()
    channel.finishDestroy?.()
  }
  await Promise.all(bridges.splice(0).map((bridge) => bridge.destroy()))
  for (const channel of channels.splice(0)) channel.destroy()
})

function setup(createRenderer?: RendererFactory, channel = new Channel()) {
  const errors: unknown[] = []
  const safe = createSafeInvoke((error) => errors.push(error))
  const bridge = createSessionBridge(channel as unknown as ServerChannel, {
    pty: DEFAULT_PTY,
    identity: { method: "none", username: "native" },
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    safe,
    createRenderer,
  })
  bridges.push(bridge)
  channels.push(channel)
  const handler = mock(() => {})
  const closed = mock(() => {})
  bridge.session.onClose(closed)
  return { bridge, channel, errors, handler, closed, start: () => runSession([], handler, bridge, safe) }
}

test.each([
  { highWaterMark: 1, destroyOnClose: true, acknowledge: true },
  { highWaterMark: 1_000_000, destroyOnClose: false, acknowledge: true },
  { highWaterMark: 1, destroyOnClose: true, acknowledge: false },
  { highWaterMark: 1, destroyOnClose: false, acknowledge: false },
])(
  "raw close waits for callbacks or reports its deadline (%j)",
  async ({ highWaterMark, destroyOnClose, acknowledge }) => {
    const { bridge, channel, errors, closed } = setup(undefined, new Channel(highWaterMark, destroyOnClose))
    const streamClosed = new Promise<void>((resolve) => channel.once("close", resolve))
    bridge.session.write("RAW")
    let finished = false
    const closing = bridge.destroy().then(() => {
      finished = true
    })
    await waitFor(() => channel.complete !== undefined)
    expect(channel.writableNeedDrain).toBe(highWaterMark === 1)
    channel.emit("drain")
    await tick()
    expect(channel.closeCalls).toBe(0)
    expect(channel.writableEnded).toBe(false)
    expect(finished).toBe(false)
    if (acknowledge) channel.release()
    await closing
    expect(channel.output).toBe("RAW")
    expect(channel.closeCalls).toBe(1)
    expect(channel.exitCode).toBe(acknowledge ? 0 : 1)
    if (acknowledge) {
      expect(errors).toEqual([])
      expect(channel.destroyed).toBe(destroyOnClose)
    } else expect(errors).toHaveLength(1)
    if (!acknowledge) expect(String(errors[0])).toContain("without restoration")
    channel.destroy()
    await streamClosed
    for (const event of ["data", "error", "drain"]) expect(channel.listenerCount(event)).toBe(0)
    expect(closed).toHaveBeenCalledTimes(1)
  },
  1500,
)

test("oversized strings reject before encoding or retaining output", async () => {
  const { bridge, channel } = setup()
  for (const value of ["x".repeat(8_323_073), "x".repeat(8_388_608), "\u0800".repeat(2_774_358)]) {
    const encode = spyOn(Buffer, "from")
    try {
      expect(() => bridge.session.write(value)).toThrow(RangeError)
      expect(encode).not.toHaveBeenCalled()
    } finally {
      encode.mockRestore()
    }
  }
  await bridge.destroy()
  expect(channel.chunks).toEqual([])
})

test.each(["resume", "deny"])("bounds raw output atomically and preserves %s under pressure", async (mode) => {
  const factory = mock(async () => {
    throw new Error("raw output must not create a renderer")
  })
  const { bridge, channel, errors } = setup(factory)
  const packet = Buffer.alloc(8_323_072, 65)
  for (const length of [packet.length + 1, 8_388_608]) {
    expect(() => bridge.session.write(Buffer.alloc(length))).toThrow(RangeError)
  }
  expect(channel.chunks).toEqual([])
  bridge.session.write(packet)
  expect(() => bridge.session.write(packet)).toThrow(OutputPressureError)
  expect(() => bridge.session.write("x")).toThrow(OutputPressureError)
  expect(() => bridge.session.write(Buffer.alloc(packet.length + 1))).toThrow(RangeError)
  await waitFor(() => channel.complete !== undefined)
  expect(() => bridge.session.write("x")).toThrow(OutputPressureError)
  if (mode === "deny") expect(() => bridge.session.deny("not admitted")).toThrow(DenyError)
  channel.automatic = true
  channel.release()
  await waitFor(() => channel.chunks.reduce((bytes, chunk) => bytes + chunk.length, 0) === packet.length)
  if (mode === "resume") {
    expect(() => bridge.session.write(Buffer.alloc(packet.length + 1))).toThrow(RangeError)
    bridge.session.write(packet)
  } else expect(bridge.closed).toBe(true)
  await bridge.destroy()
  expect(Buffer.concat(channel.chunks)).toEqual(Buffer.alloc(packet.length * (mode === "resume" ? 2 : 1), 65))
  expect(factory).not.toHaveBeenCalled()
  if (mode === "deny") {
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(OutputPressureError)
  } else expect(errors).toEqual([])
  expect(() => bridge.session.write("closed")).not.toThrow()
})

test("adopts the channel, delays frame events, and coalesces resize behind held output", async () => {
  let driver: NativeSession | undefined
  let stdout: NodeJS.WriteStream | undefined
  const { bridge, channel, errors } = setup((config) => {
    driver = config!.nativeSession
    stdout = config!.stdout
    return createCliRenderer(config)
  })
  channel.automatic = true
  bridge.session.write("BEFORE")
  bridge.resize(91, 29)
  const ready = deferred<CliRenderer>()
  const entered = bridge.enterApp((session) => ready.resolve(session.renderer))
  const renderer = await Promise.race([
    ready.promise,
    entered.then(() => {
      throw new Error("handler did not run")
    }),
  ])
  expect(driver).toBeInstanceOf(NativeSession)
  expect(stdout).toBe(channel as unknown as NodeJS.WriteStream)
  expect([renderer.width, renderer.height]).toEqual([91, 29])
  await renderer.idle()
  let frames = 0
  const sizes: number[][] = []
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  bridge.session.onResize((cols, rows) => {
    expect([renderer.width, renderer.height]).toEqual([cols, rows])
    sizes.push([cols, rows])
  })
  channel.automatic = false
  renderer.root.add(new TextRenderable(renderer, { content: "NATIVE_FRAME" }))
  await waitFor(() => channel.complete !== undefined)
  bridge.session.write("AFTER_FRAME")
  bridge.resize(90, 30)
  bridge.resize(100, 40)
  channel.emit("drain")
  await tick()
  expect(frames).toBe(0)
  expect(sizes).toEqual([])
  expect([bridge.session.cols, bridge.session.rows]).toEqual([91, 29])
  channel.automatic = true
  channel.release()
  await waitFor(() => frames > 0 && sizes.length > 0)
  expect(sizes).toEqual([[100, 40]])
  await bridge.destroy()
  await entered
  expect(channel.output.startsWith("BEFORE")).toBe(true)
  expect(channel.output.indexOf("NATIVE_FRAME")).toBeLessThan(channel.output.indexOf("AFTER_FRAME"))
  expect(channel.output).toContain("\x1b[?1049l")
  expect(errors).toEqual([])
})

test("close waits for a late-created renderer", async () => {
  const constructed = deferred<CliRenderer>()
  const release = deferred<void>()
  const target = setup(async (config) => {
    const renderer = await createCliRenderer(config)
    constructed.resolve(renderer)
    await release.promise
    return renderer
  })
  target.channel.automatic = true
  target.start()
  const renderer = await constructed.promise
  const closing = target.bridge.destroy()
  try {
    await tick()
    expect(target.channel.closeCalls).toBe(0)
  } finally {
    release.resolve()
  }
  await closing
  await renderer.closed
  expect(renderer.isDestroyed).toBe(true)
  expect(target.handler).not.toHaveBeenCalled()
  expect(target.channel.closeCalls).toBe(1)
})

test.each([false, true])("close during setup preserves restoration outcome (timeout %p)", async (timeout) => {
  let driver: NativeSession | undefined
  const target = setup((config) => {
    driver = config!.nativeSession
    return createCliRenderer(config)
  })
  const { channel, bridge, errors } = target
  channel.automatic = true
  channel.holdWhen = /\x1b\[\?1049h/
  target.start()
  await waitFor(() => channel.output.includes("\x1b[?1049h"))
  const closing = bridge.destroy()
  await tick()
  expect(channel.closeCalls).toBe(0)
  expect(driver?.disposed).toBe(false)
  if (!timeout) {
    channel.holdWhen = undefined
    channel.automatic = true
    channel.release()
  }
  await closing
  if (timeout) {
    const failure = await driver!.closed.catch((error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(errors).toEqual([failure])
  } else {
    await driver!.closed
    expect(errors).toEqual([])
  }
  expect(channel.exitCode).toBe(timeout ? 1 : 0)
  expect(channel.output.includes("\x1b[?1049l")).toBe(!timeout)
  expect(channel.closeCalls).toBe(1)
  expect(target.closed).toHaveBeenCalledTimes(1)
  expect(target.handler).not.toHaveBeenCalled()
})

test.each([false, true])("reports an unrelated late factory failure once (disconnect %p)", async (disconnect) => {
  const pending = deferred<CliRenderer>()
  const target = setup(() => pending.promise)
  const { bridge, channel, errors } = target
  const failure = new Error("late construction failed")
  target.start()
  if (disconnect) channel.destroy()
  else void bridge.destroy()
  await waitFor(() => bridge.closed)
  pending.reject(failure)
  await bridge.destroy()
  await waitFor(() => errors.includes(failure))
  expect(errors).toEqual([failure])
  expect(channel.exitCode).toBe(disconnect ? undefined : 1)
  expect(channel.closeCalls).toBe(disconnect ? 0 : 1)
  expect(target.handler).not.toHaveBeenCalled()
})

test.each(["raw-error", "setup-error", "delayed-error", "disconnect"])(
  "reports transport failures once (%s)",
  async (mode) => {
    const target = setup()
    const { bridge, channel, errors } = target
    const failure = new Error("transport failed")
    channel.holdDestroy = mode === "delayed-error"
    if (mode === "raw-error") bridge.session.write("RAW")
    else target.start()
    await waitFor(() => channel.complete !== undefined)
    if (mode === "disconnect") channel.destroy()
    else channel.release(failure)
    if (channel.holdDestroy) {
      await waitFor(() => errors.length > 0)
      expect(errors).toEqual([failure])
      channel.finishDestroy?.()
    }
    await waitFor(() => bridge.closed)
    await bridge.destroy()
    await tick()
    expect(target.handler).not.toHaveBeenCalled()
    expect(errors).toEqual(mode === "disconnect" ? [] : [failure])
    if (mode === "raw-error") expect(channel.exitCode).toBeUndefined()
  },
)
