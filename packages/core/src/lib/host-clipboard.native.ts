import {
  NativeClipboardCopyStatus,
  NativeClipboardDestroyStatus,
  NativeClipboardOperationStatus,
  NativeClipboardShutdownStatus,
  NativeClipboardStartStatus,
  resolveRenderLib,
  type ClipboardOperationHandle,
  type ClipboardServiceHandle,
  type RenderLib,
} from "../zig.js"
import type {
  ClipboardReadResult,
  ClipboardSelection,
  HostClipboardBackend,
  HostClipboardClearResult,
  HostClipboardWriteResult,
} from "./clipboard.js"
import { type HostClipboardBackendFactory } from "./host-clipboard.internal.js"

type NativeResult = ClipboardReadResult | HostClipboardWriteResult | HostClipboardClearResult
const SHUTDOWN_POLL_INTERVAL_MS = 1
const OPERATION_POLL_INTERVAL_MS = 1
const PROVIDER_POLL_INTERVAL_MS = 8
const MAX_WORK_UNITS_PER_DRAIN = 64

interface PendingOperation {
  readonly handle: ClipboardOperationHandle
  readonly kind: "read" | "write" | "clear"
  readonly signal: AbortSignal
  readonly resolve: (result: NativeResult) => void
  readonly reject: (error: unknown) => void
  cleanupError?: unknown
}

const selectionValue = (selection: ClipboardSelection): number => (selection === "clipboard" ? 0 : 1)

const encodeReadRequest = (preferredTypes: readonly [string, ...string[]]): Uint8Array => {
  const encoder = new TextEncoder()
  const encoded = preferredTypes.map((mimeType) => encoder.encode(mimeType))
  const size = encoded.reduce((total, mimeType) => total + 4 + mimeType.byteLength, 4)
  const request = new Uint8Array(size)
  const view = new DataView(request.buffer)
  view.setUint32(0, encoded.length, true)
  let offset = 4
  for (const mimeType of encoded) {
    view.setUint32(offset, mimeType.byteLength, true)
    offset += 4
    request.set(mimeType, offset)
    offset += mimeType.byteLength
  }
  return request
}

const startFailure = (status: NativeClipboardStartStatus): NativeResult => ({
  status: "failed",
  error: new Error(`Native clipboard operation failed to start (${NativeClipboardStartStatus[status]})`),
})

class NativeClipboardBackend implements HostClipboardBackend {
  private readonly library: RenderLib
  private readonly service: ClipboardServiceHandle
  private readonly pending = new Map<ClipboardOperationHandle, PendingOperation>()
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private pollTimerForOperation = false
  private providerActive = false
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(
    private readonly maxImagePixels: number,
    private readonly maxConversionBytes: number,
    maxConcurrentOperations: number,
    maxProviderTransfers: number,
    waylandSeat?: string,
  ) {
    this.library = resolveRenderLib()
    const service = this.library.clipboardServiceCreate(maxConcurrentOperations, maxProviderTransfers, waylandSeat)
    if (!service) throw new Error("Failed to create native clipboard service")
    this.service = service
  }

  read(options: Parameters<HostClipboardBackend["read"]>[0]): Promise<ClipboardReadResult> {
    const request = encodeReadRequest(options.preferredTypes)
    const started = this.library.clipboardReadOperationStart(
      this.service,
      request,
      selectionValue(options.selection),
      options.maxBytes,
      this.maxImagePixels,
      this.maxConversionBytes,
      options.timeoutMs,
    )
    return this.track(started, options.signal, "read") as Promise<ClipboardReadResult>
  }

  writeText(
    text: string,
    options: Parameters<HostClipboardBackend["writeText"]>[1],
  ): Promise<HostClipboardWriteResult> {
    const started = this.library.clipboardWriteOperationStart(
      this.service,
      new TextEncoder().encode(text),
      selectionValue(options.selection),
      options.timeoutMs,
    )
    return this.track(started, options.signal, "write") as Promise<HostClipboardWriteResult>
  }

  clear(options: Parameters<HostClipboardBackend["clear"]>[0]): Promise<HostClipboardClearResult> {
    const started = this.library.clipboardClearOperationStart(
      this.service,
      selectionValue(options.selection),
      options.timeoutMs,
    )
    return this.track(started, options.signal, "clear") as Promise<HostClipboardClearResult>
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.disposePromise = this.shutdown()
    return this.disposePromise
  }

  private track(
    started: { status: NativeClipboardStartStatus; operation: ClipboardOperationHandle | null },
    signal: AbortSignal,
    kind: PendingOperation["kind"],
  ): Promise<NativeResult> {
    if (this.disposed) return Promise.reject(new Error("Native clipboard backend is disposed"))
    if (started.status !== NativeClipboardStartStatus.Ok || !started.operation) {
      return Promise.resolve(startFailure(started.status))
    }
    return new Promise((resolve, reject) => {
      const operation: PendingOperation = { handle: started.operation!, kind, signal, resolve, reject }
      this.pending.set(operation.handle, operation)
      signal.addEventListener("abort", () => this.requestCancel(operation), { once: true })
      this.ensureScheduled()
      this.drain()
    })
  }

  private requestCancel(operation: PendingOperation): void {
    if (!this.pending.has(operation.handle)) return
    try {
      this.library.clipboardOperationCancel(operation.handle)
    } catch (error) {
      operation.cleanupError ??= error
    }
    this.ensureScheduled()
  }

  private ensureScheduled(): void {
    const hasPendingOperation = this.pending.size > 0
    if (!hasPendingOperation && !this.providerActive) {
      this.clearPollTimer()
      return
    }
    if (this.pollTimer !== undefined) {
      if (hasPendingOperation && !this.pollTimerForOperation) this.clearPollTimer()
      else {
        if (hasPendingOperation) this.pollTimer.ref()
        else this.pollTimer.unref()
        return
      }
    }
    this.pollTimerForOperation = hasPendingOperation
    this.pollTimer = setTimeout(
      () => {
        this.pollTimer = undefined
        this.pollTimerForOperation = false
        this.drain()
      },
      hasPendingOperation ? OPERATION_POLL_INTERVAL_MS : PROVIDER_POLL_INTERVAL_MS,
    )
    if (!hasPendingOperation) this.pollTimer.unref()
  }

  private clearPollTimer(): void {
    if (this.pollTimer === undefined) return
    clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    this.pollTimerForOperation = false
  }

  private drain(): void {
    // A service drain gives cancellation cleanup and queued events their turn before operations settle.
    this.providerActive = false
    try {
      this.providerActive = this.library.clipboardServiceDrain(this.service) === 1
    } catch (error) {
      for (const operation of this.pending.values()) {
        operation.cleanupError ??= error
        try {
          this.library.clipboardOperationCancel(operation.handle)
        } catch {}
      }
    }
    let workUnits = 0
    while (workUnits < MAX_WORK_UNITS_PER_DRAIN && this.pending.size > 0) {
      const operation = this.pending.values().next().value
      if (!operation) break
      workUnits += 1
      try {
        if (operation.cleanupError !== undefined) {
          try {
            this.library.clipboardOperationCancel(operation.handle)
          } catch {}
          const status = this.library.clipboardOperationPoll(operation.handle)
          if (status === NativeClipboardOperationStatus.Pending) {
            this.rotate(operation)
            continue
          }
          this.providerActive = true
          const destroyed = this.library.clipboardOperationDestroy(operation.handle)
          if (destroyed === NativeClipboardDestroyStatus.NotReady) {
            this.rotate(operation)
            continue
          }
          this.pending.delete(operation.handle)
          operation.reject(operation.cleanupError)
          continue
        }
        if (operation.signal.aborted) this.library.clipboardOperationCancel(operation.handle)
        const status = this.library.clipboardOperationPoll(operation.handle)
        if (status === NativeClipboardOperationStatus.Pending) {
          this.rotate(operation)
          continue
        }
        this.providerActive = true
        const result = this.readResult(operation.handle, operation.kind, status)
        const destroyed = this.library.clipboardOperationDestroy(operation.handle)
        if (destroyed === NativeClipboardDestroyStatus.NotReady) {
          this.rotate(operation)
          continue
        }
        this.pending.delete(operation.handle)
        operation.resolve(
          destroyed === NativeClipboardDestroyStatus.Destroyed
            ? result
            : { status: "failed", error: new Error("Native clipboard operation became invalid before destruction") },
        )
      } catch (error) {
        operation.cleanupError ??= error
        try {
          this.library.clipboardOperationCancel(operation.handle)
        } catch {}
        this.rotate(operation)
      }
    }
    this.ensureScheduled()
  }

  private rotate(operation: PendingOperation): void {
    this.pending.delete(operation.handle)
    this.pending.set(operation.handle, operation)
  }

  private readResult(
    handle: ClipboardOperationHandle,
    kind: PendingOperation["kind"],
    status: NativeClipboardOperationStatus,
  ): NativeResult {
    switch (status) {
      case NativeClipboardOperationStatus.Read:
        return kind === "read" ? this.readRepresentation(handle) : this.invalidResult(kind, status)
      case NativeClipboardOperationStatus.Empty:
        return kind === "read" ? { status: "empty" } : this.invalidResult(kind, status)
      case NativeClipboardOperationStatus.Written:
        return kind === "write" ? { status: "written" } : this.invalidResult(kind, status)
      case NativeClipboardOperationStatus.Cleared:
        return kind === "clear" ? { status: "cleared" } : this.invalidResult(kind, status)
      case NativeClipboardOperationStatus.Unsupported:
        return { status: "unsupported" }
      case NativeClipboardOperationStatus.Cancelled:
        return { status: "cancelled" }
      case NativeClipboardOperationStatus.TimedOut:
        return { status: "timed-out" }
      case NativeClipboardOperationStatus.LimitExceeded:
        return kind === "read" ? { status: "limit-exceeded" } : this.invalidResult(kind, status)
      case NativeClipboardOperationStatus.Failed:
        return { status: "failed", error: this.readError(handle) }
      default:
        return { status: "failed", error: new Error("Native clipboard operation returned an invalid status") }
    }
  }

  private invalidResult(kind: PendingOperation["kind"], status: NativeClipboardOperationStatus): NativeResult {
    return {
      status: "failed",
      error: new Error(
        `Native clipboard ${kind} returned inapplicable status ${NativeClipboardOperationStatus[status]}`,
      ),
    }
  }

  private readRepresentation(handle: ClipboardOperationHandle): ClipboardReadResult {
    const mimeLength = this.library.clipboardOperationResultMimeLength(handle)
    const dataLength = this.library.clipboardOperationResultDataLength(handle)
    if (mimeLength.status !== NativeClipboardCopyStatus.Ok || dataLength.status !== NativeClipboardCopyStatus.Ok) {
      return { status: "failed", error: new Error("Failed to read native clipboard result lengths") }
    }
    const mime = new Uint8Array(mimeLength.length)
    const bytes = new Uint8Array(dataLength.length)
    if (
      this.library.clipboardOperationResultMimeCopy(handle, mime) !== NativeClipboardCopyStatus.Ok ||
      this.library.clipboardOperationResultDataCopy(handle, bytes) !== NativeClipboardCopyStatus.Ok
    ) {
      return { status: "failed", error: new Error("Failed to copy native clipboard result") }
    }
    return { status: "read", representation: { mimeType: new TextDecoder().decode(mime), bytes } }
  }

  private readError(handle: ClipboardOperationHandle): Error {
    const code = this.library.clipboardOperationResultErrorCode(handle)
    const length = this.library.clipboardOperationResultDiagnosticLength(handle)
    if (code.status !== NativeClipboardCopyStatus.Ok || length.status !== NativeClipboardCopyStatus.Ok) {
      return new Error("Native clipboard operation failed without a readable diagnostic")
    }
    const diagnostic = new Uint8Array(length.length)
    if (this.library.clipboardOperationResultDiagnosticCopy(handle, diagnostic) !== NativeClipboardCopyStatus.Ok) {
      return new Error("Native clipboard operation failed without a readable diagnostic")
    }
    return Object.assign(new Error(new TextDecoder().decode(diagnostic)), { code: code.errorCode })
  }

  private async shutdown(): Promise<void> {
    this.clearPollTimer()
    let status = this.library.clipboardServiceBeginShutdown(this.service)
    while (status === NativeClipboardShutdownStatus.Pending) {
      await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_POLL_INTERVAL_MS))
      status = this.library.clipboardServicePollShutdown(this.service)
    }
    if (status !== NativeClipboardShutdownStatus.Ready) throw new Error("Native clipboard service became invalid")
    if (this.library.clipboardServiceDestroy(this.service) !== NativeClipboardDestroyStatus.Destroyed) {
      throw new Error("Failed to destroy native clipboard service")
    }
  }
}

export const createNativeHostClipboardBackend: HostClipboardBackendFactory = (options) =>
  new NativeClipboardBackend(
    options.maxImagePixels,
    options.maxConversionBytes,
    options.maxConcurrentOperations,
    options.maxProviderTransfers,
    options.waylandSeat,
  )
