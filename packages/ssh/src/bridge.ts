import { Readable } from "node:stream"
import { CliRenderEvents, NativeSession, createCliRenderer, type CliRenderer } from "@opentui/core"
import type { ServerChannel } from "ssh2"
import { DenyError, OutputPressureError } from "./errors.js"
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
 *  - stdout: the channel borrowed by the renderer's NativeSession.
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

  const stdout = channel as unknown as NodeJS.WriteStream
  stdout.columns = cols
  stdout.rows = rows

  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    detach: () => {
      channel.removeListener("data", onData)
      stdin.destroy()
      // ssh2 defers channel close until readable EOF, including after local end().
      // Discard paused input once it no longer belongs to the renderer.
      queueMicrotask(() => channel.resume())
    },
  }
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
  /** Cancel a lost connection without relying on ssh2's delayed channel close event. */
  disconnect(): Promise<void>
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
  const nativeSession = new NativeSession(channel)
  // Assigned after `destroy` exists; the stream activity hook calls through it.
  let resetIdle = () => {}
  const { stdin, stdout, detach } = createSessionStreams(channel, initialPty.cols, initialPty.rows, () => resetIdle())

  // Created only if middleware reaches the handler.
  let renderer: CliRenderer | undefined
  let creatingRenderer: Promise<CliRenderer> | undefined

  let cols = initialPty.cols
  let rows = initialPty.rows
  // Per-session context bag filled by middleware `next(add)` calls.
  const context: Record<string, unknown> = {}
  const resizeListeners = new Set<(cols: number, rows: number) => void>()
  const closeListeners = new Set<() => void>()

  let closed = false
  let channelClosed = false // set when the client hung up — don't poke a dead channel
  let reportedNativeError: unknown
  const reportTransportError = (error: unknown) => {
    if (error === reportedNativeError) return
    reportedNativeError = error
    safe.report(error)
  }
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
      // Check code units first to bound the UTF-8 scan, then check bytes before allocation.
      if (
        data.length > nativeSession.maxAtomicWriteBytes ||
        Buffer.byteLength(data) > nativeSession.maxAtomicWriteBytes
      ) {
        throw new RangeError("@opentui/ssh: raw write exceeds the native session output limit")
      }
      if (!nativeSession.write(typeof data === "string" ? Buffer.from(data) : data)) throw new OutputPressureError()
    },
    end() {
      void destroy()
    },
    deny(reason): never {
      try {
        if (reason && !closed) {
          if (reason.length > nativeSession.maxAtomicWriteBytes) {
            throw new RangeError("@opentui/ssh: deny reason exceeds the native session output limit")
          }
          session.write(/\r?\n$/.test(reason) ? reason : `${reason}\r\n`)
        }
      } catch (error) {
        safe.report(error)
      } finally {
        void destroy()
      }
      throw new DenyError(reason)
    },
  }

  const resize = (requestedCols: number, requestedRows: number) => {
    if (closed) return
    // Clamp each axis independently so one bad value does not discard the other.
    const nextCols = clampPtyDimension(requestedCols, stdout.columns, MAX_PTY.cols)
    const nextRows = clampPtyDimension(requestedRows, stdout.rows, MAX_PTY.rows)
    stdout.columns = nextCols
    stdout.rows = nextRows
    if (renderer) renderer.requestResize(nextCols, nextRows)
    else {
      cols = nextCols
      rows = nextRows
    }
  }

  // All session-ending paths funnel through this idempotent teardown.
  const closeTransport = (restored = true) => {
    if (channelClosed) return resolveTransportClosed()
    ignoreErrors(() => channel.exit(restored ? 0 : 1))
    ignoreErrors(() => channel.close())
    resolveTransportClosed()
  }

  const destroy = (): Promise<void> => {
    if (closed) return transportClosed
    closed = true
    if (idleTimer) clearTimeout(idleTimer)
    if (maxTimer) clearTimeout(maxTimer)
    ignoreErrors(() => renderer?.destroy())
    // Closing interrupts setup if the factory is still awaiting terminal output.
    // A late renderer still owns its wrapper cleanup and must finish before the channel.
    const closing = renderer?.closed ?? (channelClosed ? nativeSession.closed : nativeSession.close())
    void (async () => {
      let restored = true
      try {
        await closing
      } catch {
        restored = false
      }
      if (creatingRenderer) {
        try {
          const created = await creatingRenderer
          await created.closed
        } catch (error) {
          if (!nativeSession.isCloseInterruption(error)) restored = false
        }
      }
      closeTransport(restored)
    })()
    detach()
    closeListeners.forEach((listener) => safe(listener))
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
  const onChannelClose = () => {
    channelClosed = true
    channel.removeListener("close", onChannelClose)
    channel.removeListener("error", onChannelError)
    void destroy()
  }
  const onChannelError = (error: Error) => {
    channelClosed = true
    reportTransportError(error)
    void destroy()
  }
  channel.on("close", onChannelClose)
  channel.on("error", onChannelError)

  void nativeSession.closed.catch((error) => {
    void destroy()
    if (creatingRenderer) {
      // Creation reports real failures. An interrupted setup or late success must
      // still report a failed close, unless the channel already reported it.
      void creatingRenderer.then(
        () => {
          if (!channelClosed) reportTransportError(error)
        },
        (creationError) => {
          if (!channelClosed && nativeSession.isCloseInterruption(creationError)) reportTransportError(error)
        },
      )
    } else if (!channelClosed) reportTransportError(error)
  })

  // Use current dimensions so resizes during middleware are honored.
  const attachRenderer = async (): Promise<CliRenderer | null> => {
    if (renderer) return renderer
    // The session may have closed while middleware was still running.
    if (closed) return null
    creatingRenderer = createRenderer({
      stdin,
      stdout,
      width: cols,
      height: rows,
      exitOnCtrlC: false, // the app/server owns quit; don't kill on ^C
      exitSignals: [], // no process-level signal handling for a remote peer
      consoleMode: "disabled", // never patch the host's global console per session
      targetFps: 30,
      nativeSession,
      externalOutputMode: "passthrough",
    })
    const createdRenderer = await creatingRenderer
    // The client may vanish while createRenderer is awaiting; release the renderer
    // immediately instead of attaching it to dead streams.
    if (closed) {
      ignoreErrors(() => createdRenderer.destroy())
      return null
    }
    const requestedCols = cols
    const requestedRows = rows
    cols = createdRenderer.width
    rows = createdRenderer.height
    createdRenderer.on(CliRenderEvents.RESIZE, (width: number, height: number) => {
      if (closed) return
      cols = width
      rows = height
      resizeListeners.forEach((listener) => safe(() => listener(width, height)))
    })
    renderer = createdRenderer
    createdRenderer.on(CliRenderEvents.DESTROY, destroy)
    createdRenderer.requestResize(requestedCols, requestedRows)
    creatingRenderer = undefined
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
      if (nativeSession.isCloseInterruption(err)) return ended
      if (err === nativeSession.error && (channelClosed || err === reportedNativeError)) return ended
      // runSession reports the factory rejection; a later channel error must not repeat it.
      reportedNativeError = err
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
    disconnect() {
      channelClosed = true
      const closing = destroy()
      nativeSession.dispose()
      return closing
    },
  }
}
