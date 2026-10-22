import { Readable } from "node:stream"
import { expect, spyOn, test } from "bun:test"
import { CliRenderEvents, createCliRenderer, TextRenderable } from "@opentui/core"
import type { ServerChannel } from "ssh2"
import { createSessionBridge, DEFAULT_PTY, MAX_PTY, type RendererFactory } from "../../bridge.js"
import { runSession } from "../../run-session.js"
import { createSafeInvoke } from "../../safe.js"
import type { Session, SessionHandler } from "../../types.js"
import { sleep, TestChannel, waitFor } from "../support.js"

/**
 * The teardown race: the renderer is lazy, so a client can disconnect in the
 * window between "the chain authorized" and "the renderer is ready". A disconnect
 * mid-setup closes the session without running the handler or reporting an error;
 * a genuine renderer-creation failure tears the half-open session down and
 * rethrows for safe() to report. The renderer factory is injected so both paths
 * drive the real bridge deterministically.
 */

function testBridge(
  options: {
    channel?: TestChannel
    pty?: Parameters<typeof createSessionBridge>[1]["pty"]
    username?: string
    safe?: ReturnType<typeof createSafeInvoke>
    createRenderer?: RendererFactory
  } = {},
) {
  const channel = options.channel ?? new TestChannel()
  const bridge = createSessionBridge(channel as unknown as ServerChannel, {
    pty: options.pty ?? DEFAULT_PTY,
    identity: { method: "none", username: options.username ?? "t" },
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    safe: options.safe ?? createSafeInvoke(() => {}),
    createRenderer:
      options.createRenderer &&
      (async (config) => {
        const renderer = await options.createRenderer!(config)
        const destroy = renderer.destroy.bind(renderer)
        Object.defineProperty(renderer, "closed", { value: config!.nativeSession!.closed })
        renderer.destroy = () => {
          destroy()
          void config!.nativeSession!.close()
        }
        return renderer
      }),
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
  expect(channel.exits).toEqual([0]) // peer disconnected once, not twice
  expect(channel.closeCalls).toBe(1)
})

test("destroy is per-session — closing one bridge leaves another untouched", async () => {
  const safe = createSafeInvoke(() => {}) // one server-wide sink, shared by both
  const chA = new TestChannel()
  const chB = new TestChannel()
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
  expect(chB.exits).toEqual([])
  expect(chB.closeCalls).toBe(0)
  await Promise.all([a.destroy(), b.destroy()])
})

test("stdin applies backpressure before renderer creation and resumes when read", async () => {
  const channel = new TestChannel()
  let stdin: NodeJS.ReadStream | undefined
  const { bridge } = testBridge({
    channel,
    createRenderer: (async (options: Parameters<RendererFactory>[0]) => {
      stdin = options!.stdin
      return rendererStub()
    }) as unknown as RendererFactory,
  })

  // Input can arrive while middleware is still deciding whether to enter the app.
  const initialResumes = channel.resumeCalls
  const chunk = Buffer.alloc(64 * 1024)
  channel.emit("data", chunk)
  expect(channel.pauseCalls).toBe(1)

  const entered = bridge.enterApp(() => {})
  await flush()
  if (!stdin) throw new Error("renderer did not receive stdin")

  expect(stdin.readableLength).toBe(chunk.length)
  expect(stdin.readableLength).toBeGreaterThanOrEqual(stdin.readableHighWaterMark)

  expect(stdin.read()).toEqual(chunk)
  expect(channel.resumeCalls).toBe(initialResumes + 1)

  channel.emit("data", chunk)
  expect(channel.pauseCalls).toBe(2)
  expect(stdin.read()).toEqual(chunk)
  expect(channel.resumeCalls).toBe(initialResumes + 2)

  bridge.destroy()
  await entered
})

test("renderer shutdown output waits for acknowledgement before the SSH channel closes", async () => {
  const channel = new TestChannel()
  const { bridge } = testBridge({
    channel,
    createRenderer: (async (options: Parameters<RendererFactory>[0]) => {
      return rendererStub({
        destroy() {
          options!.nativeSession!.write(Buffer.from("SHUTDOWN"))
        },
      })
    }) as unknown as RendererFactory,
  })

  const entered = bridge.enterApp(() => {})
  await flush()
  channel.hold()
  const closing = bridge.destroy()
  await waitFor(() => channel.pendingWrite)

  expect(channel.text()).toBe("SHUTDOWN")
  channel.emit("drain")
  await flush()
  expect(channel.closeCalls).toBe(0)
  channel.release()
  await closing
  await entered
  expect([channel.exits, channel.closeCalls]).toEqual([[0], 1])
})

test("session teardown force-closes a client that never drains", async () => {
  const channel = new TestChannel()
  const { bridge } = testBridge({
    channel,
    createRenderer: (async (options: Parameters<RendererFactory>[0]) => {
      return rendererStub({
        destroy() {
          options!.nativeSession!.write(Buffer.from("SHUTDOWN"))
        },
      })
    }) as unknown as RendererFactory,
  })

  const entered = bridge.enterApp(() => {})
  await flush()
  channel.hold()
  const closed = await Promise.race([
    bridge.destroy().then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
  ])

  expect(closed).toBe(true)
  // The close deadline cancelled restoration, so the client learns that it failed.
  expect([channel.exits, channel.closeCalls]).toEqual([[1], 1])
  await entered
})

test("a channel error tears down without waiting for close", async () => {
  let rendererDestroyCalls = 0
  let closeCalls = 0
  const channel = new TestChannel()
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
  expect(channel.exits).toEqual([])
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
    requestResize: (cols: number, rows: number) => void
    destroy: () => void
  }> = {},
) {
  return { width: DEFAULT_PTY.cols, height: DEFAULT_PTY.rows, on() {}, requestResize() {}, destroy() {}, ...overrides }
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
  const channel = new TestChannel()
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

test.each([
  { name: "before", fail: () => Promise.reject(new Error("createCliRenderer failed")) },
  {
    // The constructor disposes the Session it took; only the creation failure is reported.
    name: "after",
    fail: (config: Parameters<RendererFactory>[0]) => {
      const stdin = Object.assign(new Readable({ read() {} }), {
        setRawMode(enabled: boolean) {
          if (enabled) throw new Error("createCliRenderer failed")
        },
      })
      return createCliRenderer({ ...config, stdin: stdin as unknown as NodeJS.ReadStream })
    },
  },
])("a genuine renderer-creation failure $name Session attachment is reported once", async ({ fail }) => {
  const errors: unknown[] = []
  let handlerRan = false
  const safe = createSafeInvoke((e) => errors.push(e))
  const { bridge } = testBridge({ safe, createRenderer: fail as RendererFactory })

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
  expect(errors.map((error) => (error as Error).message)).toEqual(["createCliRenderer failed"])
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
    requestResize(c: number, r: number) {
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

test("before the renderer exists, resize sets its creation size and an empty term uses the default", async () => {
  let created: { width?: number; height?: number } | undefined
  const { bridge } = testBridge({
    pty: { term: "", cols: 80, rows: 24, hasPty: true },
    createRenderer: ((options: Parameters<RendererFactory>[0]) => {
      created = { width: options!.width, height: options!.height }
      return rendererStub({ width: options!.width, height: options!.height })
    }) as unknown as RendererFactory,
  })
  expect(bridge.session.term).toBe(DEFAULT_PTY.term)
  bridge.resize(100, 30)
  expect([bridge.session.cols, bridge.session.rows]).toEqual([100, 30])
  const entered = bridge.enterApp(() => {})
  await flush()
  expect(created).toEqual({ width: 100, height: 30 })
  bridge.destroy()
  await entered
})

test("entering the app after close creates no renderer and runs no handler", async () => {
  let created = false
  let handled = false
  const { bridge } = testBridge({
    createRenderer: (() => {
      created = true
      return rendererStub()
    }) as unknown as RendererFactory,
  })
  void bridge.destroy()
  await bridge.enterApp(() => {
    handled = true
  })
  expect([created, handled]).toEqual([false, false])
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

const teardownError = new Error("ECONNRESET")

const teardownCases = [
  { name: "the server closes the session during renderer setup", during: "setup", end: "destroy" },
  { name: "the client disconnects during renderer setup", during: "setup", end: "disconnect" },
  { name: "the channel closes during renderer setup", during: "setup", end: "close" },
  { name: "the channel fails during renderer setup", during: "setup", end: "error" },
  { name: "the client disconnects while a frame is pending", during: "frame", end: "disconnect" },
  { name: "the channel closes while a frame is pending", during: "frame", end: "close" },
  { name: "the channel fails while a frame is pending", during: "frame", end: "error" },
] as const

for (const row of teardownCases) {
  test(`ordinary teardown with a real renderer reports nothing extra: ${row.name}`, () => runTeardown(row))
}

async function runTeardown({ during, end }: (typeof teardownCases)[number]): Promise<void> {
  const channel = new TestChannel()
  const reported: unknown[] = []
  const safe = createSafeInvoke((error) => reported.push(error))
  const bridge = createSessionBridge(channel as unknown as ServerChannel, {
    pty: { term: "xterm-256color", cols: 20, rows: 5, hasPty: true },
    identity: { method: "none", username: "teardown" },
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    safe,
  })
  const errors = spyOn(console, "error").mockImplementation(() => {})
  let session: Session | undefined
  let renderErrors = 0
  try {
    if (during === "setup") channel.hold()
    runSession([], (value) => void (session = value), bridge, safe)
    if (during === "setup") await waitFor(() => channel.pendingWrite, 8000, 1)
    else {
      await waitFor(() => session !== undefined, 8000, 1)
      const renderer = session!.renderer
      renderer.on(CliRenderEvents.RENDER_ERROR, () => renderErrors++)
      await renderer.idle()
      channel.hold()
      renderer.root.add(new TextRenderable(renderer, { content: "pending" }))
      renderer.requestRender()
      await waitFor(() => channel.pendingWrite && renderer.getSchedulerState().isRendering, 8000, 1)
    }

    if (end === "close" || end === "error") {
      const closed = new Promise((resolve) => channel.once("close", resolve))
      channel.destroy(end === "error" ? teardownError : undefined)
      await closed
    }
    const closing = end === "disconnect" ? bridge.disconnect() : bridge.destroy()
    channel.release()
    await closing
    await sleep(25)

    expect(session === undefined).toBe(during === "setup")
    expect(renderErrors).toBe(0)
    expect(reported).toEqual(end === "error" ? [teardownError] : [])
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([])
  } finally {
    errors.mockRestore()
    channel.release()
    await bridge.destroy()
  }
}
