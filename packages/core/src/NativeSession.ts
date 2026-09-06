import { Writable } from "node:stream"
import { writeSync } from "node:fs"
import {
  NativeError,
  NativeSessionPumpStatus,
  NativeSessionRenderStatus,
  NativeSessionState,
  NativeSessionTerminalPhase,
  NativeStatus,
  resolveRenderLib,
  type NativeContextHandle,
  type NativeContextOptions,
  type NativeOutputTicket,
  type NativeSceneFrameRequest,
  type NativeSessionCapabilities,
  type NativeSessionControl,
  type NativeSessionKittyImageTransportStatus,
  type NativeSessionOptions,
  type NativeSessionRendererOptions,
  type NativeSessionTerminalOptions,
  type RenderLib,
  type SessionHandle,
  type NativeSplitSnapshot,
} from "./zig.js"

export interface NativeSessionScheduler {
  /** Monotonic nanoseconds. */
  now(): bigint
  /** Schedule a later event-loop turn, never an inline callback or microtask. */
  schedule(callback: () => void, delayMs?: number): () => void
}

export interface NativeSessionDriverOptions {
  context?: NativeContextOptions
  output?: NativeSessionOptions
  outputBufferSize?: number
  /** Cancel if graceful close has not completed within this finite interval. */
  closeTimeoutMs?: number
  scheduler?: NativeSessionScheduler
}

const scheduler: NativeSessionScheduler = {
  now: () => process.hrtime.bigint(),
  schedule(callback, delayMs) {
    if (delayMs === undefined) {
      const handle = setImmediate(callback)
      return () => clearImmediate(handle)
    }
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  },
}

type ReadyTask = {
  callback: () => void
  active: boolean
  cancel: () => void
  onError: (error: Error) => void
}

class ReadySessions {
  private readonly ready = new Set<Set<ReadyTask>>()
  private readonly pending = new Set<ReadyTask>()
  private current: ReadyTask | null = null
  private cancelTurn: (() => void) | null = null
  private failure: Error | null = null

  constructor(private readonly host: NativeSessionScheduler) {}

  scope(onError: (error: Error) => void): NativeSessionScheduler {
    if (this.failure) throw this.failure
    const tasks = new Set<ReadyTask>()
    const scoped: NativeSessionScheduler = {
      now: () => this.host.now(),
      schedule: (callback, delayMs) => {
        if (this.failure) throw this.failure
        let cancelTimer: (() => void) | undefined
        const task: ReadyTask = {
          callback,
          active: true,
          onError,
          cancel: () => {
            task.active = false
            tasks.delete(task)
            this.pending.delete(task)
            if (tasks.size === 0) this.ready.delete(tasks)
            const cancel = cancelTimer
            cancelTimer = undefined
            try {
              cancel?.()
            } finally {
              if (this.ready.size === 0) {
                const cancel = this.cancelTurn
                this.cancelTurn = null
                cancel?.()
              }
            }
          },
        }
        this.pending.add(task)
        const enqueue = () => {
          if (!task.active) return
          tasks.add(task)
          this.ready.add(tasks)
          this.arm()
        }
        try {
          if (delayMs === undefined) enqueue()
          else cancelTimer = this.host.schedule(enqueue, delayMs)
        } catch (error) {
          this.fail(error)
        }
        if (this.failure) throw this.failure
        return task.cancel
      },
    }
    readyServices.set(scoped, this)
    return scoped
  }

  private arm(): void {
    if (this.failure || this.cancelTurn || this.ready.size === 0) return
    try {
      this.cancelTurn = this.host.schedule(() => {
        this.cancelTurn = null
        // One ready callback per host turn; rotate owners before calling user code.
        const tasks = this.ready.values().next().value
        if (!tasks) return
        const task = (this.current = tasks.values().next().value!)
        this.ready.delete(tasks)
        tasks.delete(task)
        if (tasks.size > 0) this.ready.add(tasks)
        task.active = false
        this.pending.delete(task)
        try {
          task.callback()
        } finally {
          try {
            this.arm()
          } finally {
            this.current = null
          }
        }
      })
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    if (this.failure) return
    this.failure = asError(error)
    // Include the current turn: an owner may have parked on output before re-arming fails.
    const affected = new Set(this.pending)
    if (this.current) affected.add(this.current)
    const owners = new Set<(error: Error) => void>()
    let cleanupFailure: { error: unknown } | undefined
    for (const task of affected) {
      owners.add(task.onError)
      try {
        task.cancel()
      } catch (error) {
        cleanupFailure ??= { error }
      }
    }
    this.ready.clear()
    this.pending.clear()
    for (const onError of owners) {
      try {
        onError(this.failure)
      } catch (error) {
        cleanupFailure ??= { error }
      }
    }
    if (cleanupFailure) throw cleanupFailure.error
  }
}

const readyServices = new WeakMap<NativeSessionScheduler, ReadySessions>()

function sessionScheduler(host: NativeSessionScheduler, onError: (error: Error) => void): NativeSessionScheduler {
  let service = readyServices.get(host)
  if (!service) {
    service = new ReadySessions(host)
    readyServices.set(host, service)
  }
  return service.scope(onError)
}

function completion() {
  const result = Promise.withResolvers<void>()
  // Failure remains observable through the original promise, even if nobody awaits it.
  void result.promise.catch(() => {})
  return result
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("NativeSession failed", { cause: error })
}

/**
 * Owns one checked Session and optionally its Context. Borrows a Writable without
 * ending or destroying it. If emitClose is false, the owner must call dispose() again
 * after silent asynchronous destruction completes; no notification is available.
 */
export class NativeSession {
  private readonly lib = resolveRenderLib()
  private attachmentCleanup?: () => void
  private readonly nativeContext: NativeContextHandle
  private readonly nativeSession: Readonly<SessionHandle>
  private readonly buffer: Uint8Array
  private readonly sinkWrite: Writable["write"]
  /** @internal Shared later-turn scheduler; frame and output cancellations remain independent. */
  readonly scheduler: NativeSessionScheduler
  /** Configured output capacity, including reserved control storage; raw admission can fail earlier. */
  readonly maxWriteBytes: bigint
  /** Maximum raw write in an empty queue, excluding reserved control storage and span slots. */
  readonly maxAtomicWriteBytes: bigint
  /** @internal Snapshot count shares the Session's configured bounded admission scale. */
  readonly maxSnapshotCount: number
  private readonly closeTimeoutNs: bigint
  private readonly closeWait = completion()
  private idleWait: ReturnType<typeof completion> | null = null
  private presentationWait: ReturnType<typeof completion> | null = null
  private transition: { kind: "setup" | "suspend" | "resume"; wait: ReturnType<typeof completion> } | null = null
  private scheduled: { deadlineNs: bigint | null; cancel: () => void } | null = null
  private output: { ticket: NativeOutputTicket; completed: boolean; failed: boolean } | null = null
  private blocked = false
  private sinkErrorSeen = false
  private detached = false
  private closeDeadlineNs: bigint | null = null
  private closeRequested = false
  private closeInterruption: Error | null = null
  private stopped = false
  private exiting = false
  private finishing = false
  private _disposed = false
  private _error: Error | null = null
  private readonly detachedSessions = new Set<NativeSession>()

  /** Resolves after graceful native close and owned resource cleanup; failure or cancellation rejects. */
  readonly closed = this.closeWait.promise

  constructor(
    private readonly sink: Writable,
    options: NativeSessionDriverOptions = {},
    private readonly owner?: NativeSession,
  ) {
    this.lib.getYogaHost().assertMutable()
    const size = options.outputBufferSize ?? 65_536
    const timeout = options.closeTimeoutMs ?? 1000
    const output = options.output ?? {
      chunkSize: 65_536,
      spanCapacity: 128,
      maxBytes: 8_388_608n,
      controlCapacity: 4096,
    }
    if (!Number.isInteger(size) || size <= 0 || size > 0xffff_ffff) {
      throw new RangeError("NativeSession outputBufferSize must be a positive u32")
    }
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 0x7fff_ffff) {
      throw new RangeError("NativeSession closeTimeoutMs must be an integer from 0 to 2147483647")
    }
    if (!sink.writable || sink.destroyed || sink.writableEnded) throw new Error("NativeSession sink is not writable")
    this.sinkWrite = sink.write
    this.buffer = new Uint8Array(size)
    this.scheduler = sessionScheduler(options.scheduler ?? scheduler, (error) => {
      if (this.stopped) {
        if (this.canDetach()) this.detach()
      } else this.finish(error)
    })
    this.maxWriteBytes = output.maxBytes
    this.maxSnapshotCount = output.spanCapacity
    this.closeTimeoutNs = BigInt(timeout) * 1_000_000n
    owner?.checkOpen()
    this.nativeContext =
      owner?.context ?? this.lib.createContext(options.context ?? { objectCapacity: 65_536, renderCellsMax: 1_000_000 })
    let session: SessionHandle | undefined
    try {
      session = this.lib.createSession(this.nativeContext, output)
      this.nativeSession = Object.freeze(session)
      this.maxAtomicWriteBytes = this.lib.sessionGetWriteLimit(this.nativeContext, session)
      sink.on("error", this.onError)
      sink.on("close", this.onClose)
      sink.on("finish", this.onFinish)
      sink.on("drain", this.onDrain)
      if (this._error) throw this._error
      if (!sink.writable || sink.destroyed || sink.writableEnded) throw new Error("NativeSession sink is not writable")
      this.blocked = sink.writableNeedDrain
      owner?.detachedSessions.add(this)
    } catch (error) {
      this.stopped = true
      try {
        if (session) this.finish(asError(error))
        else if (!owner) this.lib.destroyContext(this.nativeContext)
      } catch {
        // Preserve the construction failure.
      } finally {
        this.detach()
      }
      throw error
    }
  }

  get context(): NativeContextHandle {
    return this.nativeContext
  }

  get renderLib(): RenderLib {
    return this.lib
  }

  get session(): Readonly<SessionHandle> {
    return this.nativeSession
  }

  /** Native Session teardown is complete; pending sink I/O can still retain listeners. */
  get disposed(): boolean {
    return this._disposed
  }

  /** @internal Shared Context identity and lifetime, independent of detached Session teardown. */
  get contextOwner(): NativeSession {
    return this.owner?.contextOwner ?? this
  }

  get contextDisposed(): boolean {
    return this.contextOwner.disposed
  }

  get error(): Error | null {
    return this._error
  }

  usesOutput(sink: Writable): boolean {
    return this.sink === sink
  }

  /** The optional attachment cleanup is installed only after checked native acceptance. */
  attachRenderer(options: NativeSessionRendererOptions, beforeDispose?: () => void): void {
    this.checkOpen()
    this.lib.sessionAttachRenderer(this.context, this.session, options)
    this.attachmentCleanup = beforeDispose
  }

  /** @internal Independent scene/frame ownership, sharing only the parent's Context resources. */
  createDetached(options: NativeSessionRendererOptions, beforeDispose: () => void): NativeSession {
    this.checkOpen()
    const detached = new NativeSession(
      new Writable({
        write(_bytes, _encoding, complete) {
          complete()
        },
      }),
      {
        output: { chunkSize: 4096, spanCapacity: 2, maxBytes: 8192n, controlCapacity: 0 },
        outputBufferSize: 4096,
        scheduler: this.scheduler,
      },
      this,
    )
    try {
      detached.attachRenderer(options, beforeDispose)
      return detached
    } catch (error) {
      detached.dispose()
      throw error
    }
  }

  /** Repeated calls share pending setup; the first call supplies its options. */
  setupTerminal(options: NativeSessionTerminalOptions = {}): Promise<void> {
    return this.changeTerminal("setup", options)
  }

  suspend(): Promise<void> {
    return this.changeTerminal("suspend")
  }

  resume(): Promise<void> {
    return this.changeTerminal("resume")
  }

  /** Returns the native admission/presentation result; skipped or pending frames are not retried. */
  render(force = false, frame: NativeSceneFrameRequest | null = null): NativeSessionRenderStatus {
    this.checkOpen()
    const result = frame
      ? this.lib.sceneFrameCommit(this.context, this.session, frame, force)
      : this.lib.sessionRender(this.context, this.session, force)
    if (result === NativeSessionRenderStatus.Pending) this.schedule()
    return result
  }

  /** @internal One checked admission for a complete split frame. */
  renderSplit(
    frame: NativeSceneFrameRequest | null,
    commits: readonly NativeSplitSnapshot[],
    pinnedRenderOffset: number,
    force: boolean,
  ): { status: NativeSessionRenderStatus; renderOffset: number } {
    this.checkOpen()
    const result = this.lib.sessionRenderSplit(this.context, this.session, frame, commits, pinnedRenderOffset, force)
    if (result.status === NativeSessionRenderStatus.Pending) this.schedule()
    return result
  }

  /** @internal Screen changes join the same ordered output queue as frames and controls. */
  setScreen(alternate: boolean, width: number, height: number, trailingOutput?: Uint8Array): void {
    this.checkOpen()
    this.lib.sessionSetScreen(this.context, this.session, alternate, width, height, trailingOutput)
    this.schedule()
  }

  /** Waits for the current frame's endpoint, not later output or sink drain. Calls share one pending wait. */
  whenPresented(): Promise<void> {
    this.checkOpen()
    if (this.presentationWait) return this.presentationWait.promise
    if (!this.lib.sessionGetRendererState(this.context, this.session).framePending) return Promise.resolve()
    const wait = (this.presentationWait = completion())
    this.schedule()
    return wait.promise
  }

  resize(width: number, height: number): void {
    this.checkOpen()
    this.lib.sessionResizeRenderer(this.context, this.session, width, height)
  }

  control(command: NativeSessionControl): void {
    this.checkOpen()
    this.lib.sessionControl(this.context, this.session, command)
    this.schedule()
  }

  writeClipboard(target: number, bytes: Uint8Array): boolean {
    this.checkOpen()
    const accepted = this.lib.sessionClipboard(this.context, this.session, target, bytes)
    if (accepted) this.schedule()
    return accepted
  }

  triggerNotification(message: string, title?: string): boolean {
    this.checkOpen()
    const accepted = this.lib.sessionNotification(this.context, this.session, message, title)
    if (accepted) this.schedule()
    return accepted
  }

  setKittyImageTransport(mode: number): void {
    this.checkOpen()
    this.lib.sessionSetKittyImageTransport(this.context, this.session, mode)
    this.schedule()
  }

  getKittyImageTransport(): NativeSessionKittyImageTransportStatus {
    this.checkOpen()
    return this.lib.sessionGetKittyImageTransport(this.context, this.session)
  }

  pollKittyImageTransport(): boolean {
    this.checkOpen()
    return this.lib.sessionPollKittyImageTransport(this.context, this.session)
  }

  cancelKittyImageTransport(failed: boolean): void {
    this.checkOpen()
    this.lib.sessionCancelKittyImageTransport(this.context, this.session, failed)
  }

  processKittyImageReply(bytes: Uint8Array): number {
    this.checkOpen()
    return this.lib.sessionProcessKittyImageReply(this.context, this.session, bytes)
  }

  startKittyFileProbe(): void {
    this.checkOpen()
    this.lib.sessionStartKittyFileProbe(this.context, this.session)
    this.schedule()
  }

  getCapabilities(): NativeSessionCapabilities {
    this.checkOpen()
    return this.lib.sessionGetCapabilities(this.context, this.session)
  }

  /** Copies all bytes or returns false under queue pressure. Capacity-exceeding writes throw RangeError;
   * lifecycle errors take precedence while writing is unavailable. */
  write(bytes: Uint8Array): boolean {
    this.checkOpen()
    try {
      this.lib.sessionWrite(this.context, this.session, bytes)
    } catch (error) {
      if (error instanceof NativeError && error.status === NativeStatus.OutputBackpressure) return false
      throw error
    }
    this.schedule()
    return true
  }

  /** Waits for accepted output, terminal work, and sink pressure to settle. Calls share one wait. */
  idle(): Promise<void> {
    this.lib.getYogaHost().assertMutable()
    if (this.stopped) return this.closed
    if (this.idleWait) return this.idleWait.promise
    const wait = (this.idleWait = completion())
    this.schedule()
    return wait.promise
  }

  /** Release external Context leases first. A busy close rejects; dispose() can retry cleanup after release. */
  close(): Promise<void> {
    this.lib.getYogaHost().assertMutable()
    if (this.stopped || this.closeRequested) return this.closed
    try {
      this.closeRequested = true
      this.closeDeadlineNs ??= this.scheduler.now() + this.closeTimeoutNs
      if (this.transition) {
        this.closeInterruption = new Error("NativeSession terminal transition interrupted by close")
        this.transition.wait.reject(this.closeInterruption)
        this.transition = null
      }
      if (this._error) throw this._error
      this.lib.sessionClose(this.context, this.session)
      if (this.lib.sessionGetState(this.context, this.session) === NativeSessionState.Closed) this.finish(null)
      else this.schedule()
    } catch (error) {
      this.finish(asError(error))
    }
    return this.closed
  }

  /** @internal Bound required snapshot flushing by the same graceful-close deadline. */
  armCloseTimeout(): void {
    this.checkOpen()
    this.closeDeadlineNs ??= this.scheduler.now() + this.closeTimeoutNs
    this.schedule()
  }

  /** Identifies this driver's close interruption, not transport or restoration success. */
  isCloseInterruption(error: unknown): boolean {
    return this.closeInterruption !== null && error === this.closeInterruption
  }

  /**
   * Cancels immediately without claiming restoration. Release external Context
   * leases first; if disposed remains false, release them and call dispose again.
   */
  dispose(): void {
    this.lib.getYogaHost().assertMutable()
    this.finish(this._error ?? new Error("NativeSession disposed without graceful close"))
  }

  /** @internal Restore before exit callbacks can terminate the process. The caller
   * must still dispose after wrapper cleanup; this does not release the Context.
   * Only real stdout supports direct synchronous delivery. In-flight writes cannot
   * be replayed, and arbitrary borrowed sinks cannot finish asynchronously at exit. */
  restoreOnExit(): boolean {
    if (this._disposed || this.finishing) return false
    this.exiting = true
    try {
      if (
        this.sink !== process.stdout ||
        this._error ||
        this.sink.destroyed ||
        this.sink.errored ||
        !this.sink.writable ||
        this.sink.writableEnded
      )
        return false
      if (this.output) {
        if (!this.output.completed || this.output.failed) return false
        this.lib.sessionCompleteOutput(this.context, this.session, this.output.ticket, true)
        this.output = null
      }
      // The first pump stops admission. Only the bounded retained queue and native
      // restoration remain; neither user callbacks nor scheduled turns run here.
      for (;;) {
        const status = this.lib.sessionPumpExit(this.context, this.session)
        if (status === NativeSessionPumpStatus.Closed) return true
        if (status === NativeSessionPumpStatus.Again) continue
        if (status !== NativeSessionPumpStatus.OutputPending) throw new Error("Unexpected native exit pump status")
        const ticket = this.lib.sessionReadOutput(this.context, this.session, this.buffer)
        if (!ticket) throw new Error("NativeSession exit output pending without bytes")
        let offset = 0
        while (offset < ticket.byteCount) {
          const count = writeSync(process.stdout.fd, this.buffer, offset, ticket.byteCount - offset)
          if (count === 0) throw new Error("NativeSession exit output made no progress")
          offset += count
        }
        this.lib.sessionCompleteOutput(this.context, this.session, ticket, true)
      }
    } catch (error) {
      this._error ??= asError(error)
      return false
    }
  }

  private checkOpen(): void {
    this.lib.getYogaHost().assertMutable()
    if (this._error) throw this._error
    if (this.stopped || this.closeRequested) throw new Error("NativeSession is closing or disposed")
    this.owner?.checkOpen()
  }

  private changeTerminal(kind: "setup" | "suspend" | "resume", options?: NativeSessionTerminalOptions): Promise<void> {
    this.checkOpen()
    if (this.transition) {
      if (this.transition.kind === kind) return this.transition.wait.promise
      throw new Error("NativeSession terminal transition is pending")
    }
    switch (kind) {
      case "setup":
        this.lib.sessionSetupTerminal(this.context, this.session, options)
        break
      case "suspend":
        this.lib.sessionSuspend(this.context, this.session)
        break
      case "resume":
        this.lib.sessionResume(this.context, this.session)
        break
    }
    const wait = completion()
    this.transition = { kind, wait }
    this.schedule()
    return wait.promise
  }

  private onError = (error: Error): void => {
    this.sinkErrorSeen = true
    if (!this.stopped) this._error ??= asError(error)
    this.schedule()
  }

  private onClose = (): void => {
    this.output = null
    if (this.stopped) this.detach()
    else {
      this._error ??= new Error("NativeSession sink closed before graceful close")
      this.schedule()
    }
  }

  private onFinish = (): void => {
    if (!this.stopped) this._error ??= new Error("NativeSession sink finished before graceful close")
    this.schedule()
  }

  private onDrain = (): void => {
    if (this.stopped) return
    this.blocked = false
    this.schedule()
  }

  private schedule(deadlineNs: bigint | null = null): void {
    if (this.exiting) {
      if (this.stopped && this.canDetach()) this.detach()
      return
    }
    if (this.stopped && (this.detached || !this.canDetach())) return
    const previous = this.scheduled
    if (previous && (previous.deadlineNs === null || (deadlineNs !== null && previous.deadlineNs <= deadlineNs))) {
      return
    }
    const task = { deadlineNs, cancel: () => {} }
    try {
      previous?.cancel()
      this.scheduled = task
      let delayMs: number | undefined
      if (deadlineNs !== null) {
        const remaining = deadlineNs - this.scheduler.now()
        delayMs = Math.min(Number(((remaining > 0n ? remaining : 0n) + 999_999n) / 1_000_000n), 0x7fff_ffff)
      }
      task.cancel = this.scheduler.schedule(() => {
        if (this.scheduled !== task) return
        this.scheduled = null
        if (this.stopped) {
          if (this.canDetach()) this.detach()
        } else this.turn()
      }, delayMs)
    } catch (error) {
      if (this.stopped) {
        if (this.canDetach()) this.detach()
      } else this.finish(asError(error))
    }
  }

  private turn(): void {
    let deadlineNs: bigint | null = null
    try {
      if (this._error) throw this._error
      const now = this.scheduler.now()
      if (this.closeDeadlineNs !== null && now >= this.closeDeadlineNs) {
        throw new Error("NativeSession graceful close timed out; output cancelled without restoration")
      }
      if (this.output?.completed) {
        this.lib.sessionCompleteOutput(this.context, this.session, this.output.ticket, true)
        this.output = null
        if (this.presentationWait && !this.lib.sessionGetRendererState(this.context, this.session).framePending) {
          this.presentationWait.resolve()
          this.presentationWait = null
        }
      }
      if (this.output) return
      const result = this.lib.sessionPump(this.context, this.session, now, 1)
      switch (result.status) {
        case NativeSessionPumpStatus.Idle:
          if (this.transition) {
            const phase =
              this.transition.kind === "suspend"
                ? NativeSessionTerminalPhase.Suspended
                : NativeSessionTerminalPhase.Active
            if (this.lib.sessionGetTerminalState(this.context, this.session) !== phase) {
              throw new Error("NativeSession terminal transition did not complete")
            }
            this.transition.wait.resolve()
            this.transition = null
          }
          if (!this.blocked) {
            this.idleWait?.resolve()
            this.idleWait = null
          }
          break
        case NativeSessionPumpStatus.Again:
          this.schedule()
          break
        case NativeSessionPumpStatus.OutputPending:
          if (!this.blocked) this.writeOutput()
          break
        case NativeSessionPumpStatus.WaitUntil:
          deadlineNs = result.deadlineNs
          break
        case NativeSessionPumpStatus.Closed:
          this.finish(null)
          break
      }
    } catch (error) {
      this.finish(asError(error))
    } finally {
      if (this.closeDeadlineNs !== null && (deadlineNs === null || this.closeDeadlineNs < deadlineNs)) {
        deadlineNs = this.closeDeadlineNs
      }
      if (deadlineNs !== null) this.schedule(deadlineNs)
    }
  }

  private writeOutput(): void {
    const ticket = this.lib.sessionReadOutput(this.context, this.session, this.buffer)
    if (!ticket) throw new Error("NativeSession output pending without bytes")
    const output = { ticket, completed: false, failed: false }
    this.output = output
    // Set the gate before calling user code so even an inline drain is not lost.
    this.blocked = true
    try {
      const ready = this.sinkWrite.call(
        this.sink,
        this.buffer.subarray(0, ticket.byteCount),
        "utf8",
        (error?: Error | null) => {
          if (this.output !== output || output.completed) return
          output.completed = true
          output.failed = error != null
          if (error && !this.stopped) this._error ??= asError(error)
          this.schedule()
        },
      )
      if (!this.stopped && ready) this.blocked = false
    } catch (error) {
      this.output = null
      if (this.stopped) this.detach()
      throw error
    }
  }

  private detach(): void {
    this.detached = true
    this.output = null
    for (const [event, listener] of [
      ["error", this.onError],
      ["close", this.onClose],
      ["finish", this.onFinish],
      ["drain", this.onDrain],
    ] as const) {
      try {
        this.sink.off(event, listener)
      } catch (error) {
        this._error ??= asError(error)
      }
    }
  }

  private canDetach(): boolean {
    if (this.output && !this.output.completed) return false
    return this.sink.closed || this.sinkErrorSeen || (!this.output?.failed && !this.sink.destroyed)
  }

  private finish(error: Error | null): void {
    if (this.finishing) return
    if (this._disposed) {
      this.schedule()
      return
    }
    this.finishing = true
    try {
      this.stopped = true
      this._error ??= error
      const scheduled = this.scheduled
      this.scheduled = null
      try {
        scheduled?.cancel()
      } catch (error) {
        this._error ??= asError(error)
      }
      if (this._error) {
        try {
          this.lib.sessionCancel(this.context, this.session)
        } catch (error) {
          this._error ??= asError(error)
        }
      }
      for (const child of this.detachedSessions) {
        try {
          child.dispose()
          if (!child.disposed) this._error ??= child.error
        } catch (error) {
          this._error ??= asError(error)
        }
      }
      // A child can reenter its owner or retain a native frame lease during cleanup.
      // Its callbacks and Session must finish before the owner releases shared resources.
      if (this.detachedSessions.size === 0) {
        try {
          this.attachmentCleanup?.()
        } catch (error) {
          this._error ??= asError(error)
          try {
            this.lib.sessionCancel(this.context, this.session)
          } catch (error) {
            this._error ??= asError(error)
          }
        }
        try {
          if (this.owner) this.lib.destroySession(this.context, this.session)
          else this.lib.destroyContext(this.context)
          this._disposed = true
          this.owner?.detachedSessions.delete(this)
        } catch (error) {
          this._error ??= asError(error)
        }
      }
      // A failed write callback can precede asynchronous _destroy and its error
      // event by many turns. Keep the listener until that event or stream close.
      if (!this.output && !this.sink.destroyed && !this.sink.writableFinished && !this.sink.errored) this.detach()
      else this.schedule()
      if (!this._disposed && !this._error) return
      for (const wait of [this.closeWait, this.idleWait, this.presentationWait, this.transition?.wait]) {
        if (this._error) wait?.reject(this._error)
        else wait?.resolve()
      }
      this.idleWait = null
      this.presentationWait = null
      this.transition = null
    } finally {
      try {
        // Notify failures while still finishing so the owner cannot retry this child's borrowed cleanup inline.
        if ((this._disposed || this._error) && this.owner?.stopped && !this.owner.finishing) {
          this.owner.finish(this._disposed ? this.owner.error : this._error)
        }
      } finally {
        this.finishing = false
      }
    }
  }
}
