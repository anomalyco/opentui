import { Readable, Writable } from "node:stream"
import { CliRenderEvents, createCliRenderer, type CliRenderer } from "@opentui/core"
import type { ServerChannel } from "ssh2"
import { DenyError } from "./errors.js"
import { ignoreErrors, type SafeInvoke } from "./safe.js"
import type { Identity, MiddlewareSession, RemoteAddress, Session, SessionHandler } from "./types.js"

/** Renderer factory; injectable for renderer creation and disconnect-race tests. */
export type RendererFactory = (options: Parameters<typeof createCliRenderer>[0]) => Promise<CliRenderer>

/** PTY parameters from the client's `pty-req`; the renderer sizes off cols/rows. */
export interface PtyInfo {
  term: string
  cols: number
  rows: number
  hasPty: boolean
}

export const DEFAULT_PTY: PtyInfo = { term: "xterm-256color", cols: 80, rows: 24, hasPty: false }
export const MAX_PTY = { cols: 500, rows: 200 } as const
const TRANSPORT_DRAIN_TIMEOUT_MS = 1_000

const UNKNOWN_REMOTE_ADDRESS: RemoteAddress = { address: "unknown" }

function clampPtyDimension(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  const integer = Math.floor(value)
  return integer > 0 ? Math.min(integer, max) : fallback
}

function normalizePtyInfo(pty: PtyInfo): PtyInfo {
  return {
    term: pty.term || DEFAULT_PTY.term,
    cols: clampPtyDimension(pty.cols, DEFAULT_PTY.cols, MAX_PTY.cols),
    rows: clampPtyDimension(pty.rows, DEFAULT_PTY.rows, MAX_PTY.rows),
    hasPty: pty.hasPty,
  }
}

/**
 * Adapter stream pair for the renderer:
 *  - stdin: a flowing Readable; raw client bytes from the channel are pushed in.
 *  - stdout: a Writable the renderer's NativeSpanFeed writes frames to.
 */
function createSessionStreams(channel: ServerChannel, cols: number, rows: number, onActivity?: () => void) {
  let inputPaused = false
  const stdin = new Readable({
    read() {
      if (!inputPaused) return
      inputPaused = false
      channel.resume()
    },
  })
  const onData = (chunk: Buffer) => {
    onActivity?.() // client input resets the idle-timeout clock
    if (!stdin.push(chunk) && !inputPaused) {
      inputPaused = true
      channel.pause()
    }
  }
  channel.on("data", onData)

  let channelGone = false
  let pendingDrain: (() => void) | null = null
  // A deferred write will never drain after the peer vanishes.
  const releasePending = () => {
    const done = pendingDrain
    pendingDrain = null
    done?.()
  }
  channel.on("close", () => {
    channelGone = true
    releasePending()
  })
  channel.on("error", () => {
    channelGone = true
    releasePending()
  })

  const stdout = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (channelGone) return cb()
      // Copy renderer frame memory before acknowledging the write.
      const bytes = Buffer.from(chunk)
      if (bytes.byteLength === 0) return cb()
      // channel.write() returns false under backpressure; defer cb() to 'drain'
      // so flow control is applied back onto the feed instead of dropping frames.
      const ok = channel.write(bytes)
      if (ok) return cb()
      pendingDrain = cb
      channel.once("drain", releasePending)
    },
  }) as unknown as NodeJS.WriteStream
  stdout.columns = cols
  stdout.rows = rows

  return { stdin: stdin as unknown as NodeJS.ReadStream, stdout, detach: () => channel.removeListener("data", onData) }
}

export interface SessionBridge {
  /** One runtime object exposed through middleware and handler session views. */
  session: Session & MiddlewareSession
  /** True once the session has closed (disconnect, end(), deny(), or idle reap). */
  readonly closed: boolean
  /**
   * Attach the renderer after middleware authorizes, run the handler, and resolve
   * when the session closes.
   */
  enterApp(handler: SessionHandler): Promise<void>
  resize(cols: number, rows: number): void
  destroy(): Promise<void>
}

/** What `createSessionBridge` needs to wire one ssh2 shell channel into a session. */
export interface SessionBridgeOptions {
  pty: PtyInfo
  identity: Identity
  idleTimeoutMs: number | undefined
  maxTimeoutMs: number | undefined
  safe: SafeInvoke
  /** Injectable renderer factory; defaults to `createCliRenderer` (tests drive the race/failure paths). */
  createRenderer?: RendererFactory
  remoteAddress?: RemoteAddress
}

/**
 * Turn an ssh2 shell channel into a wired-up OpenTUI session.
 *
 * The session starts without a renderer; `enterApp()` creates it only after the
 * middleware chain reaches the handler. The throwing getter catches JS callers and
 * unsafe casts that touch `session.renderer` too early.
 */
export function createSessionBridge(channel: ServerChannel, options: SessionBridgeOptions): SessionBridge {
  const {
    pty,
    identity,
    idleTimeoutMs,
    maxTimeoutMs,
    safe,
    createRenderer = createCliRenderer,
    remoteAddress = UNKNOWN_REMOTE_ADDRESS,
  } = options
  const initialPty = normalizePtyInfo(pty)
  // Assigned after `destroy` exists; the stream activity hook calls through it.
  let resetIdle = () => {}
  const { stdin, stdout, detach } = createSessionStreams(channel, initialPty.cols, initialPty.rows, () => resetIdle())

  // Created only if middleware reaches the handler.
  let renderer: CliRenderer | undefined

  let cols = initialPty.cols
  let rows = initialPty.rows
  // Per-session context bag filled by middleware `next(add)` calls.
  const context: Record<string, unknown> = {}
  const resizeListeners = new Set<(cols: number, rows: number) => void>()
  const closeListeners = new Set<() => void>()

  let closed = false
  let channelClosed = false // set when the client hung up — don't poke a dead channel
  let stdoutFinished = false
  let pendingRawWrites = 0
  let transportCloseTimer: ReturnType<typeof setTimeout> | undefined
  let resolveTransportClosed!: () => void
  const transportClosed = new Promise<void>((resolve) => {
    resolveTransportClosed = resolve
  })
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let maxTimer: ReturnType<typeof setTimeout> | undefined

  // One object backing both public session views.
  const session: Session & MiddlewareSession = {
    get renderer() {
      if (!renderer) {
        throw new Error(
          "@opentui/ssh: session.renderer is unavailable until the handler runs — a middleware must call next() before using it",
        )
      }
      return renderer
    },
    identity,
    context,
    term: initialPty.term,
    hasPty: initialPty.hasPty,
    remoteAddress,
    get cols() {
      return cols
    },
    get rows() {
      return rows
    },
    onResize(listener) {
      if (closed) return () => {}
      resizeListeners.add(listener)
      return () => resizeListeners.delete(listener)
    },
    onClose(listener) {
      // Late subscribers still get the close callback once.
      if (closed) {
        safe(listener)
        return () => {}
      }
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    write(data) {
      if (closed) return
      pendingRawWrites++
      channel.write(data, () => {
        pendingRawWrites--
        finishTransportClose()
      })
    },
    end() {
      void destroy()
    },
    deny(reason): never {
      // Keep deny reasons on the main screen by writing before the renderer exists.
      if (reason && !closed) {
        session.write(/\r?\n$/.test(reason) ? reason : `${reason}\r\n`)
      }
      void destroy()
      throw new DenyError(reason)
    },
  }

  const resize = (requestedCols: number, requestedRows: number) => {
    if (closed) return
    // Clamp each axis independently so one bad value does not discard the other.
    const nextCols = clampPtyDimension(requestedCols, cols, MAX_PTY.cols)
    const nextRows = clampPtyDimension(requestedRows, rows, MAX_PTY.rows)
    cols = nextCols
    rows = nextRows
    stdout.columns = nextCols
    stdout.rows = nextRows
    renderer?.resize(nextCols, nextRows)
    resizeListeners.forEach((listener) => safe(() => listener(nextCols, nextRows)))
  }

  // All session-ending paths funnel through this idempotent teardown.
  const settleTransportClosed = () => {
    if (transportCloseTimer) clearTimeout(transportCloseTimer)
    resolveTransportClosed()
  }

  const closeTransport = () => {
    if (channelClosed) return settleTransportClosed()
    ignoreErrors(() => channel.exit(0))
    ignoreErrors(() => channel.close())
    settleTransportClosed()
  }

  const finishTransportClose = () => {
    if (!closed || !stdoutFinished || pendingRawWrites > 0 || channelClosed) return
    closeTransport()
  }

  const destroy = (): Promise<void> => {
    if (closed) return transportClosed
    closed = true
    if (idleTimer) clearTimeout(idleTimer)
    if (maxTimer) clearTimeout(maxTimer)
    ignoreErrors(() => renderer?.destroy())
    if (!channelClosed) {
      transportCloseTimer = setTimeout(closeTransport, TRANSPORT_DRAIN_TIMEOUT_MS)
      // Core can enqueue final terminal-restoration bytes during destroy. End the
      // adapter on the next microtask and let its pending writes drain before close.
      queueMicrotask(() => {
        stdout.end(() => {
          stdoutFinished = true
          finishTransportClose()
        })
      })
    }
    detach()
    closeListeners.forEach((listener) => safe(listener))
    if (channelClosed) settleTransportClosed()
    return transportClosed
  }

  // Reap a session that goes quiet for too long. Armed at start and re-armed on
  // every client keystroke; cleared on close so a reaped/closed session can't fire.
  if (idleTimeoutMs && idleTimeoutMs > 0) {
    resetIdle = () => {
      if (closed) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(destroy, idleTimeoutMs)
    }
    resetIdle()
  }

  if (maxTimeoutMs && maxTimeoutMs > 0) {
    maxTimer = setTimeout(destroy, maxTimeoutMs)
  }

  // Mark the channel gone before teardown so we do not write to a dead peer.
  channel.on("close", () => {
    channelClosed = true
    settleTransportClosed()
    void destroy()
  })
  channel.on("error", (error: Error) => {
    channelClosed = true
    settleTransportClosed()
    safe.report(error)
    void destroy()
  })

  // Use current dimensions so resizes during middleware are honored.
  const attachRenderer = async (): Promise<CliRenderer | null> => {
    if (renderer) return renderer
    // The session may have closed while middleware was still running.
    if (closed) return null
    const createdRenderer = await createRenderer({
      stdin,
      stdout, // custom stdout → frames routed through NativeSpanFeed
      width: cols,
      height: rows,
      exitOnCtrlC: false, // the app/server owns quit; don't kill on ^C
      exitSignals: [], // no process-level signal handling for a remote peer
      consoleMode: "disabled", // never patch the host's global console per session
      targetFps: 30,
    })
    // The client may vanish while createRenderer is awaiting; release the renderer
    // immediately instead of attaching it to dead streams.
    if (closed) {
      ignoreErrors(() => createdRenderer.destroy())
      return null
    }
    if (createdRenderer.width !== cols || createdRenderer.height !== rows) {
      createdRenderer.resize(cols, rows)
    }
    createdRenderer.on(CliRenderEvents.DESTROY, destroy)
    renderer = createdRenderer
    return renderer
  }

  const enterApp = async (handler: SessionHandler): Promise<void> => {
    // Register before renderer setup so an early close cannot be missed.
    const ended = new Promise<void>((resolve) => session.onClose(resolve))
    if (closed) return ended
    let attachedRenderer: CliRenderer | null
    try {
      attachedRenderer = await attachRenderer()
    } catch (err) {
      destroy()
      throw err
    }
    if (!attachedRenderer) return ended
    const handlerDone = Promise.resolve()
      .then(() => handler(session))
      .then(
        () => ({ type: "handler" as const }),
        (err) => ({ type: "handler-error" as const, err }),
      )

    const outcome = await Promise.race([handlerDone, ended.then(() => ({ type: "ended" as const }))])
    if (outcome.type === "handler-error") throw outcome.err
    if (outcome.type === "handler") await ended
    if (outcome.type === "ended") {
      void handlerDone.then((late) => {
        if (late.type === "handler-error") safe.report(late.err)
      })
    }
  }

  return {
    session,
    get closed() {
      return closed
    },
    enterApp,
    resize,
    destroy,
  }
}
