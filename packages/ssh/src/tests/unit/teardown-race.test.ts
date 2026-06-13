import { EventEmitter } from "node:events"
import { expect, test } from "bun:test"
import type { ServerChannel } from "ssh2"
import { createSessionBridge, DEFAULT_PTY, MAX_PTY, type RendererFactory } from "../../bridge.js"
import { runSession } from "../../run-session.js"
import { createSafeInvoke } from "../../safe.js"
import type { SessionHandler } from "../../types.js"

/**
 * The teardown race: the renderer is lazy, so a client can disconnect in the
 * window between "the chain authorized" and "the renderer is ready". A disconnect
 * mid-setup closes the session without running the handler or reporting an error;
 * a genuine renderer-creation failure tears the half-open session down and
 * rethrows for safe() to report. The renderer factory is injected so both paths
 * drive the real bridge deterministically.
 */

/**
 * Minimal ssh2 `ServerChannel` stub: the bridge wires its own adapter streams to
 * the renderer, so the renderer only needs an EventEmitter with
 * `write()`/`exit()`/`close()`. Counts peer-disconnect calls so idempotency can
 * be proven.
 */
function fakeChannel(): EventEmitter & {
  exitCalls: number
  closeCalls: number
  pauseCalls: number
  resumeCalls: number
  writes: Buffer[]
} {
  const ch = new EventEmitter() as EventEmitter & {
    exitCalls: number
    closeCalls: number
    pauseCalls: number
    resumeCalls: number
    writes: Buffer[]
  }
  ch.exitCalls = 0
  ch.closeCalls = 0
  ch.pauseCalls = 0
  ch.resumeCalls = 0
  ch.writes = []
  return Object.assign(ch, {
    write: (data: Buffer | string, callback?: () => void) => {
      ch.writes.push(Buffer.from(data))
      callback?.()
      return true
    },
    pause: () => {
      ch.pauseCalls++
      return ch
    },
    resume: () => {
      ch.resumeCalls++
      return ch
    },
    exit: () => {
      ch.exitCalls++
      return true
    },
    close: () => {
      ch.closeCalls++
    },
  })
}

function testBridge(
  options: {
    channel?: ReturnType<typeof fakeChannel>
    pty?: Parameters<typeof createSessionBridge>[1]["pty"]
    username?: string
    safe?: ReturnType<typeof createSafeInvoke>
    createRenderer?: RendererFactory
  } = {},
) {
  const channel = options.channel ?? fakeChannel()
  const bridge = createSessionBridge(channel as unknown as ServerChannel, {
    pty: options.pty ?? DEFAULT_PTY,
    identity: { method: "none", username: options.username ?? "t" },
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    safe: options.safe ?? createSafeInvoke(() => {}),
    createRenderer: options.createRenderer,
  })
  return { channel, bridge }
}

test("destroy is idempotent — a second call tells the peer only once", async () => {
  const { channel, bridge } = testBridge()
  let closes = 0
  bridge.session.onClose(() => closes++)

  bridge.destroy()
  bridge.destroy()
  await flush()

  expect(closes).toBe(1)
  expect(channel.exitCalls).toBe(1) // peer disconnected once, not twice
  expect(channel.closeCalls).toBe(1)
})

test("destroy is per-session — closing one bridge leaves another untouched", () => {
  const safe = createSafeInvoke(() => {}) // one server-wide sink, shared by both
  const chA = fakeChannel()
  const chB = fakeChannel()
  const { bridge: a } = testBridge({ channel: chA, username: "a", safe })
  const { bridge: b } = testBridge({ channel: chB, username: "b", safe })
  let aClosed = false
  let bClosed = false
  a.session.onClose(() => {
    aClosed = true
  })
  b.session.onClose(() => {
    bClosed = true
  })

  a.destroy()

  expect(a.closed).toBe(true)
  expect(aClosed).toBe(true)
  expect(b.closed).toBe(false) // the other session is untouched
  expect(bClosed).toBe(false)
  expect(chB.exitCalls).toBe(0)
  expect(chB.closeCalls).toBe(0)
})

test("stdin applies backpressure before renderer creation and resumes when read", async () => {
  const channel = fakeChannel()
  let stdin: NodeJS.ReadStream | undefined
  const { bridge } = testBridge({
    channel,
    createRenderer: (async (options: Parameters<RendererFactory>[0]) => {
      stdin = options!.stdin
      return rendererStub()
    }) as unknown as RendererFactory,
  })

  // Input can arrive while middleware is still deciding whether to enter the app.
  const chunk = Buffer.alloc(64 * 1024)
  channel.emit("data", chunk)
  expect(channel.pauseCalls).toBe(1)

  const entered = bridge.enterApp(() => {})
  await flush()
  if (!stdin) throw new Error("renderer did not receive stdin")

  expect(stdin.readableLength).toBe(chunk.length)
  expect(stdin.readableLength).toBeGreaterThanOrEqual(stdin.readableHighWaterMark)

  expect(stdin.read()).toEqual(chunk)
  expect(channel.resumeCalls).toBe(1)

  channel.emit("data", chunk)
  expect(channel.pauseCalls).toBe(2)
  expect(stdin.read()).toEqual(chunk)
  expect(channel.resumeCalls).toBe(2)

  bridge.destroy()
  await entered
})

test("renderer shutdown output flushes before the SSH channel closes", async () => {
  const channel = fakeChannel()
  const order: string[] = []
  let stdout: NodeJS.WriteStream | undefined
  Object.assign(channel, {
    write(data: Buffer | string) {
      channel.writes.push(Buffer.from(data))
      order.push(`write:${data.toString()}`)
      return false
    },
    close() {
      channel.closeCalls++
      order.push("close")
    },
  })
  const { bridge } = testBridge({
    channel,
    createRenderer: (async (options: Parameters<RendererFactory>[0]) => {
      stdout = options!.stdout
      return rendererStub({
        destroy() {
          queueMicrotask(() => stdout!.write("SHUTDOWN", () => order.push("flushed")))
        },
      })
    }) as unknown as RendererFactory,
  })

  const entered = bridge.enterApp(() => {})
  await flush()
  bridge.destroy()
  await Promise.resolve()

  expect(order).toEqual(["write:SHUTDOWN"])
  expect(channel.closeCalls).toBe(0)

  channel.emit("drain")
  await flush()
  await entered
  expect(order).toEqual(["write:SHUTDOWN", "flushed", "close"])
})

test("raw session writes drain before the SSH channel closes", async () => {
  const channel = fakeChannel()
  let rawCallback: (() => void) | undefined
  Object.assign(channel, {
    write(data: Buffer | string, callback?: () => void) {
      channel.writes.push(Buffer.from(data))
      rawCallback = callback
      return false
    },
  })
  const { bridge } = testBridge({ channel })

  bridge.session.write("RAW")
  bridge.destroy()
  await flush()
  expect(channel.closeCalls).toBe(0)
  expect(Buffer.concat(channel.writes).toString()).toBe("RAW")

  rawCallback?.()
  await flush()
  expect(channel.closeCalls).toBe(1)
})

test("session teardown force-closes a client that never drains", async () => {
  const channel = fakeChannel()
  Object.assign(channel, {
    write(data: Buffer | string) {
      channel.writes.push(Buffer.from(data))
      return false
    },
  })
  let stdout: NodeJS.WriteStream | undefined
  const { bridge } = testBridge({
    channel,
    createRenderer: (async (options: Parameters<RendererFactory>[0]) => {
      stdout = options!.stdout
      return rendererStub({
        destroy() {
          stdout!.write("SHUTDOWN")
        },
      })
    }) as unknown as RendererFactory,
  })

  const entered = bridge.enterApp(() => {})
  await flush()
  const closed = await Promise.race([
    bridge.destroy().then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
  ])

  expect(closed).toBe(true)
  expect(channel.closeCalls).toBe(1)
  await entered
})

test("session teardown force-closes when a raw write callback never runs", async () => {
  const channel = fakeChannel()
  Object.assign(channel, {
    write(data: Buffer | string) {
      channel.writes.push(Buffer.from(data))
      return false
    },
  })
  const { bridge } = testBridge({ channel })

  bridge.session.write("RAW")
  const closed = await Promise.race([
    bridge.destroy().then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
  ])

  expect(closed).toBe(true)
  expect(channel.closeCalls).toBe(1)
})

test("a channel error tears down without waiting for close", async () => {
  let rendererDestroyCalls = 0
  let closeCalls = 0
  const channel = fakeChannel()
  const reported: unknown[] = []
  const error = new Error("transport failed")
  const { bridge } = testBridge({
    channel,
    safe: createSafeInvoke((value) => reported.push(value)),
    createRenderer: (async () =>
      rendererStub({
        destroy() {
          rendererDestroyCalls++
        },
      })) as unknown as RendererFactory,
  })
  bridge.session.onClose(() => closeCalls++)
  const entered = bridge.enterApp(() => {})
  await flush()

  channel.emit("error", error)
  await entered

  expect(bridge.closed).toBe(true)
  expect(rendererDestroyCalls).toBe(1)
  expect(closeCalls).toBe(1)
  expect(channel.exitCalls).toBe(0)
  expect(channel.closeCalls).toBe(0)
  expect(reported).toEqual([error])
})

test("onClose registered AFTER the session closed still fires — no lost app teardown", () => {
  const { bridge } = testBridge()

  bridge.destroy()
  expect(bridge.closed).toBe(true)

  // An onClose registered after close (e.g. an async handler that wired up post-
  // disconnect) must still run its teardown, not be silently dropped.
  let lateRan = false
  const dispose = bridge.session.onClose(() => {
    lateRan = true
  })
  expect(lateRan).toBe(true) // fired immediately, contained by safe()
  expect(typeof dispose).toBe("function")
})

test("onResize registered after close is a harmless no-op (never fires, returns a disposer)", () => {
  const { bridge } = testBridge()
  bridge.destroy()

  let fired = false
  const dispose = bridge.session.onResize(() => {
    fired = true
  })
  bridge.resize(120, 40) // a dead session must not deliver to a late subscriber
  expect(fired).toBe(false)
  expect(typeof dispose).toBe("function")
})

/** Let the fire-and-forget `runSession` work settle before asserting. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function rendererStub(
  overrides: Partial<{
    width: number
    height: number
    on: () => void
    resize: (cols: number, rows: number) => void
    destroy: () => void
  }> = {},
) {
  return { width: DEFAULT_PTY.cols, height: DEFAULT_PTY.rows, on() {}, resize() {}, destroy() {}, ...overrides }
}

function readyBridge(errors: unknown[] = []) {
  const safe = createSafeInvoke((e) => errors.push(e))
  return {
    safe,
    ...testBridge({ safe, createRenderer: (() => rendererStub()) as unknown as RendererFactory }),
  }
}

/**
 * A renderer factory with controllable timing and outcome: it stays pending until
 * `finish()` (modelling the setup window in which the client can disconnect), and
 * records `destroy()` so the race test can prove the late renderer is
 * released, not leaked.
 */
function controllableRenderer() {
  let markCalled!: () => void
  const called = new Promise<void>((resolve) => {
    markCalled = resolve
  })
  let release!: (r: unknown) => void
  const pending = new Promise<unknown>((resolve) => {
    release = resolve
  })
  let destroyed = false
  const renderer = rendererStub({
    destroy() {
      destroyed = true
    },
  })
  return {
    factory: (() => {
      markCalled()
      return pending
    }) as unknown as RendererFactory,
    whenCalled: called,
    finish: () => release(renderer),
    wasDestroyed: () => destroyed,
  }
}

test("a disconnect during renderer setup is teardown, not a reported error", async () => {
  const errors: unknown[] = []
  let handlerRan = false
  const channel = fakeChannel()
  const safe = createSafeInvoke((e) => errors.push(e))
  const rc = controllableRenderer()
  const { bridge } = testBridge({ channel, safe, createRenderer: rc.factory })

  runSession(
    [],
    (() => {
      handlerRan = true
    }) as SessionHandler,
    bridge,
    safe,
  )

  await rc.whenCalled // the leaf is now awaiting the renderer…
  channel.emit("close") // …and the client vanishes mid-setup
  expect(bridge.closed).toBe(true)
  rc.finish() // resolve the late renderer; enterApp must release it and bail
  await flush()

  expect(handlerRan).toBe(false) // never run against a dead renderer
  expect(errors).toEqual([]) // a mid-setup disconnect is not an error
  expect(rc.wasDestroyed()).toBe(true) // late renderer released, not leaked
})

test("a genuine renderer-creation failure is still reported", async () => {
  const errors: unknown[] = []
  let handlerRan = false
  const safe = createSafeInvoke((e) => errors.push(e))
  const { bridge } = testBridge({
    safe,
    createRenderer: (() => {
      throw new Error("createCliRenderer failed")
    }) as unknown as RendererFactory,
  })

  runSession(
    [],
    (() => {
      handlerRan = true
    }) as SessionHandler,
    bridge,
    safe,
  )
  await flush()

  expect(handlerRan).toBe(false)
  expect(errors).toHaveLength(1) // a real failure IS reported…
  expect(bridge.closed).toBe(true) // …and the half-open session was torn down
})

test("disconnect runs middleware teardown even if the handler never settles", async () => {
  const errors: unknown[] = []
  let handlerRan = false
  let middlewareTeardownRan = false
  const { channel, bridge, safe } = readyBridge(errors)

  runSession(
    [
      async (_session, next) => {
        try {
          return await next()
        } finally {
          middlewareTeardownRan = true
        }
      },
    ],
    (() => {
      handlerRan = true
      return new Promise(() => {})
    }) as SessionHandler,
    bridge,
    safe,
  )

  await flush()
  expect(handlerRan).toBe(true)
  expect(middlewareTeardownRan).toBe(false)

  channel.emit("close")
  await flush()

  expect(middlewareTeardownRan).toBe(true)
  expect(errors).toEqual([])
})

test("a handler error after disconnect is still reported", async () => {
  const errors: unknown[] = []
  const boom = new Error("late handler boom")
  let rejectHandler!: (err: Error) => void
  const { channel, bridge, safe } = readyBridge(errors)

  runSession(
    [],
    (() =>
      new Promise<void>((_resolve, reject) => {
        rejectHandler = reject
      })) as SessionHandler,
    bridge,
    safe,
  )

  await flush()
  channel.emit("close")
  await flush()
  rejectHandler(boom)
  await flush()

  expect(errors).toContain(boom)
})

test("a handler that ends then throws is still reported", async () => {
  const errors: unknown[] = []
  const boom = new Error("end then throw")
  const { bridge, safe } = readyBridge(errors)

  runSession(
    [],
    ((session) => {
      session.end()
      throw boom
    }) as SessionHandler,
    bridge,
    safe,
  )

  await flush()

  expect(errors).toContain(boom)
})

test("pty dimensions are clamped before renderer creation and resize", async () => {
  const safe = createSafeInvoke(() => {})
  let created: { width?: number; height?: number } | undefined
  let resized: [number, number] | undefined
  const renderer = rendererStub({
    width: MAX_PTY.cols,
    height: MAX_PTY.rows,
    resize(c: number, r: number) {
      resized = [c, r]
    },
  })
  const { bridge } = testBridge({
    pty: { term: "xterm", cols: 999_999, rows: 999_999, hasPty: true },
    safe,
    createRenderer: ((options: Parameters<RendererFactory>[0]) => {
      created = { width: options!.width, height: options!.height }
      return renderer
    }) as unknown as RendererFactory,
  })

  const entered = bridge.enterApp(() => {})
  await flush()
  bridge.resize(999_999, 999_999)
  bridge.destroy()
  await entered

  expect(created).toEqual({ width: MAX_PTY.cols, height: MAX_PTY.rows })
  expect(bridge.session.cols).toBe(MAX_PTY.cols)
  expect(bridge.session.rows).toBe(MAX_PTY.rows)
  expect(resized).toEqual([MAX_PTY.cols, MAX_PTY.rows])
})

test("fuzz: arbitrary PTY dimensions remain finite, positive, and bounded", async () => {
  const values = [
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    -Number.MAX_VALUE,
    -1,
    -0,
    0,
    Number.MIN_VALUE,
    1,
    1.5,
    MAX_PTY.cols,
    MAX_PTY.rows,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
  ]
  for (let seed = 1; seed <= 128; seed++) values.push(((seed * 2_654_435_761) % 2_000_000) - 1_000_000)

  for (let i = 0; i < values.length; i++) {
    let created: { width?: number; height?: number } | undefined
    const { bridge } = testBridge({
      pty: { term: "fuzz", cols: values[i]!, rows: values[values.length - 1 - i]!, hasPty: true },
      createRenderer: ((options: Parameters<RendererFactory>[0]) => {
        created = { width: options!.width, height: options!.height }
        return rendererStub({ width: options!.width, height: options!.height })
      }) as unknown as RendererFactory,
    })
    const entered = bridge.enterApp(() => {})
    await flush()

    expect(created?.width).toBeGreaterThan(0)
    expect(created?.width).toBeLessThanOrEqual(MAX_PTY.cols)
    expect(created?.height).toBeGreaterThan(0)
    expect(created?.height).toBeLessThanOrEqual(MAX_PTY.rows)
    expect(Number.isInteger(created?.width)).toBe(true)
    expect(Number.isInteger(created?.height)).toBe(true)
    bridge.destroy()
    await entered
  }
})
