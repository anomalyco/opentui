// OSC 52 clipboard support for terminal applications.
// Delegates to native Zig implementation for ANSI sequence generation.

import type { RendererHandle, RenderLib } from "../zig.js"
import {
  createHostClipboardWithBackend,
  runTrackedOperation,
  validateClipboardText,
  type ActiveClipboardOperation,
} from "./host-clipboard.internal.js"
import { createNativeHostClipboardBackend } from "./host-clipboard.native.js"

export interface ClipboardRepresentation {
  // Identifies the content with a canonical, lowercase MIME essence without parameters.
  readonly mimeType: string
  // Contains stable, caller-owned data. The backend does not reuse or change these bytes.
  readonly bytes: Uint8Array
}

export type ClipboardSelection = "clipboard" | "primary"

export interface ClipboardReadOptions {
  // Lists accepted MIME types in preference order. Include at least one type.
  readonly preferredTypes: readonly [string, ...string[]]
  // Selects the standard clipboard by default. Reads always use the process host.
  readonly selection?: ClipboardSelection
  // Requests cancellation when aborted. A synchronous platform call may finish before cancellation is observed.
  readonly signal?: AbortSignal
}

// Reports whether a read returned data or why it did not.
export type ClipboardReadResult =
  | { readonly status: "read"; readonly representation: ClipboardRepresentation }
  | { readonly status: "empty" | "unsupported" | "cancelled" | "timed-out" | "limit-exceeded" }
  | { readonly status: "failed"; readonly error: Error }

export interface HostClipboardReadOptions {
  // Lists accepted MIME types in preference order. Include at least one type.
  readonly preferredTypes: readonly [string, ...string[]]
  readonly selection: ClipboardSelection
  // Rejects representations larger than this number of bytes.
  readonly maxBytes: number
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export interface HostClipboardWriteOptions {
  readonly selection: ClipboardSelection
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export type HostClipboardWriteResult =
  | { readonly status: "written" | "unsupported" | "cancelled" | "timed-out" }
  | { readonly status: "failed"; readonly error: Error }

// `cleared` means the platform completed its clear operation. It does not guarantee durable erasure.
export type HostClipboardClearResult =
  | { readonly status: "cleared" | "unsupported" | "cancelled" | "timed-out" }
  | { readonly status: "failed"; readonly error: Error }

export interface HostClipboardBackend {
  // Returns the first usable representation from `preferredTypes`.
  read(options: HostClipboardReadOptions): Promise<ClipboardReadResult>
  // Writes validated, nonempty text without NUL characters.
  writeText(text: string, options: HostClipboardWriteOptions): Promise<HostClipboardWriteResult>
  // Clears the selection with the platform's clear operation, not an empty-text write.
  clear(options: HostClipboardWriteOptions): Promise<HostClipboardClearResult>
  dispose(): Promise<void>
}

// Controls whether an operation uses the terminal, the process host, or both.
export type ClipboardWriteDestination = "terminal-only" | "host-only" | "best-available" | "all-available"

export interface ClipboardWriteOptions {
  readonly destination: ClipboardWriteDestination
  // Selects the standard clipboard by default.
  readonly selection?: ClipboardSelection
  // Allows a host write when the process runs through a remote terminal session.
  readonly allowRemoteHost?: boolean
  // Requests cancellation when aborted. A synchronous host call may finish before cancellation is observed.
  readonly signal?: AbortSignal
}

export interface TerminalClipboardOperationResult {
  // `attempted` only confirms synchronous local dispatch, including for clear operations.
  readonly status: "attempted" | "local-failure" | "not-attempted"
  // Reports OSC 52 support. It does not guarantee support for the requested selection.
  readonly capability: "supported" | "unsupported" | "unknown"
}

export interface ClipboardWriteResult {
  readonly host: HostClipboardWriteResult | { readonly status: "not-attempted" }
  readonly terminal: TerminalClipboardOperationResult
}

export interface ClipboardClearResult {
  readonly host: HostClipboardClearResult | { readonly status: "not-attempted" }
  readonly terminal: TerminalClipboardOperationResult
}

export interface ClipboardService {
  // Reads the process host clipboard. It cannot read the terminal user's clipboard over SSH.
  read(options: ClipboardReadOptions): Promise<ClipboardReadResult>
  // Rejects empty text and NUL characters before trying any destination.
  writeText(text: string, options: ClipboardWriteOptions): Promise<ClipboardWriteResult>
  // Clears the selected destinations without treating empty text as a clear request.
  clear(options: ClipboardWriteOptions): Promise<ClipboardClearResult>
  // Waits for cooperative cancellation and native resource release; a blocked platform call can delay completion.
  dispose(): Promise<void>
}

export interface HostClipboardOperationOptions {
  readonly selection?: ClipboardSelection
  // Requests cancellation; it cannot interrupt a synchronous platform call already in progress.
  readonly signal?: AbortSignal
}

export interface HostClipboardService {
  readonly maxWriteBytes: number
  read(options: ClipboardReadOptions): Promise<ClipboardReadResult>
  writeText(text: string, options?: HostClipboardOperationOptions): Promise<HostClipboardWriteResult>
  clear(options?: HostClipboardOperationOptions): Promise<HostClipboardClearResult>
  // Waits for cooperative cancellation and native resource release; a blocked platform call can delay completion.
  dispose(): Promise<void>
}

export interface HostClipboardOptions {
  // Cooperative deadline for platform work, not a hard interruption bound for synchronous OS calls.
  readonly timeoutMs?: number
  readonly maxReadBytes?: number
  readonly maxWriteBytes?: number
  readonly maxImagePixels?: number
  readonly maxConversionBytes?: number
  readonly maxConcurrentOperations?: number
  readonly maxProviderTransfers?: number
  readonly waylandSeat?: string
}

export interface TerminalClipboardAdapter {
  readonly remote: boolean
  writeText(text: string, selection: ClipboardSelection): TerminalClipboardOperationResult
  clear(selection: ClipboardSelection): TerminalClipboardOperationResult
}

export interface ClipboardOptions {
  readonly host: HostClipboardService
  readonly terminal: TerminalClipboardAdapter
}

const NOT_ATTEMPTED_TERMINAL: TerminalClipboardOperationResult = {
  status: "not-attempted",
  capability: "unknown",
}

const validateSelection = (selection: ClipboardSelection | undefined): ClipboardSelection => {
  const normalized = selection ?? "clipboard"
  if (normalized !== "clipboard" && normalized !== "primary") {
    throw new TypeError("selection must be clipboard or primary")
  }
  return normalized
}

// WAYLAND_SOCKET-only launches can create one host service per process because the inherited fd is one-shot.
export const createHostClipboard = (options: HostClipboardOptions = {}): HostClipboardService =>
  createHostClipboardWithBackend(options, createNativeHostClipboardBackend)

const validateDestination = (destination: ClipboardWriteDestination): void => {
  if (
    destination !== "terminal-only" &&
    destination !== "host-only" &&
    destination !== "best-available" &&
    destination !== "all-available"
  ) {
    throw new TypeError("destination is not a supported clipboard policy")
  }
}

export const createClipboard = ({ host, terminal }: ClipboardOptions): ClipboardService => {
  const active = new Set<ActiveClipboardOperation>()
  let disposed = false
  let disposePromise: Promise<void> | undefined

  const assertUsable = (): void => {
    if (disposed) throw new Error("Clipboard service is disposed")
  }

  const canUseRemoteHost = (options: ClipboardWriteOptions): boolean =>
    !terminal.remote || options.allowRemoteHost === true

  type HostMutationResult = HostClipboardWriteResult | HostClipboardClearResult
  type MutationResult<Result extends HostMutationResult> = {
    readonly host: Result | { readonly status: "not-attempted" }
    readonly terminal: TerminalClipboardOperationResult
  }

  const composeMutation = async <Result extends HostMutationResult>(
    options: ClipboardWriteOptions,
    signal: AbortSignal,
    hostOperation: () => Promise<Result>,
    terminalOperation: () => TerminalClipboardOperationResult,
  ): Promise<MutationResult<Result>> => {
    if (options.destination === "terminal-only") {
      return { host: { status: "not-attempted" }, terminal: terminalOperation() }
    }
    if (options.destination === "host-only") {
      const hostResult = canUseRemoteHost(options) ? await hostOperation() : { status: "not-attempted" as const }
      return { host: hostResult, terminal: NOT_ATTEMPTED_TERMINAL }
    }
    if (options.destination === "best-available") {
      if (terminal.remote) {
        return { host: { status: "not-attempted" }, terminal: terminalOperation() }
      }
      const hostResult = await hostOperation()
      const terminalResult =
        !signal.aborted && (hostResult.status === "unsupported" || hostResult.status === "failed")
          ? terminalOperation()
          : NOT_ATTEMPTED_TERMINAL
      return { host: hostResult, terminal: terminalResult }
    }
    const hostPromise = canUseRemoteHost(options)
      ? hostOperation()
      : Promise.resolve({ status: "not-attempted" as const })
    const terminalResult = terminalOperation()
    return { host: await hostPromise, terminal: terminalResult }
  }
  return {
    read(options) {
      try {
        assertUsable()
        return host.read(options)
      } catch (error) {
        return Promise.reject(error)
      }
    },
    writeText(text, options) {
      try {
        assertUsable()
        validateDestination(options.destination)
        validateClipboardText(text, host.maxWriteBytes)
        const selection = validateSelection(options.selection)
        if (options.signal?.aborted) {
          return Promise.resolve({ host: { status: "not-attempted" }, terminal: NOT_ATTEMPTED_TERMINAL })
        }
        return runTrackedOperation(active, options.signal, (signal) => {
          const operationOptions = { selection, signal }
          return composeMutation(
            options,
            signal,
            () => host.writeText(text, operationOptions),
            () => terminal.writeText(text, selection),
          )
        })
      } catch (error) {
        return Promise.reject(error)
      }
    },
    clear(options) {
      try {
        assertUsable()
        validateDestination(options.destination)
        const selection = validateSelection(options.selection)
        if (options.signal?.aborted) {
          return Promise.resolve({ host: { status: "not-attempted" }, terminal: NOT_ATTEMPTED_TERMINAL })
        }
        return runTrackedOperation(active, options.signal, (signal) => {
          const operationOptions = { selection, signal }
          return composeMutation(
            options,
            signal,
            () => host.clear(operationOptions),
            () => terminal.clear(selection),
          )
        })
      } catch (error) {
        return Promise.reject(error)
      }
    },
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      for (const operation of active) operation.controller.abort()
      disposePromise = (async () => {
        await Promise.all([...active].map((operation) => operation.settled))
        await host.dispose()
      })()
      return disposePromise
    },
  }
}

export enum ClipboardTarget {
  Clipboard = 0,
  Primary = 1,
  Select = 2,
  Secondary = 3,
}

export interface RendererClipboardBoundary {
  readonly capabilities: {
    readonly remote: boolean
    readonly osc52_support: "supported" | "unsupported" | "unknown"
  } | null
  copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean
  clearClipboardOSC52(target?: ClipboardTarget): boolean
}

export const createRendererClipboardAdapter = (renderer: RendererClipboardBoundary): TerminalClipboardAdapter => {
  const targetFor = (selection: ClipboardSelection): ClipboardTarget =>
    selection === "primary" ? ClipboardTarget.Primary : ClipboardTarget.Clipboard
  const capability = (): TerminalClipboardOperationResult["capability"] =>
    renderer.capabilities?.osc52_support ?? "unknown"

  return {
    get remote() {
      return renderer.capabilities?.remote ?? true
    },
    writeText(text, selection) {
      const currentCapability = capability()
      if (currentCapability === "unsupported") return { status: "not-attempted", capability: currentCapability }
      return {
        status: renderer.copyToClipboardOSC52(text, targetFor(selection)) ? "attempted" : "local-failure",
        capability: currentCapability,
      }
    },
    clear(selection) {
      const currentCapability = capability()
      if (currentCapability === "unsupported") return { status: "not-attempted", capability: currentCapability }
      return {
        status: renderer.clearClipboardOSC52(targetFor(selection)) ? "attempted" : "local-failure",
        capability: currentCapability,
      }
    },
  }
}

export class Clipboard {
  private lib: RenderLib
  private rendererPtr: RendererHandle

  constructor(lib: RenderLib, rendererPtr: RendererHandle) {
    this.lib = lib
    this.rendererPtr = rendererPtr
  }

  public copyToClipboardOSC52(text: string, target: ClipboardTarget = ClipboardTarget.Clipboard): boolean {
    if (!this.isOsc52Supported()) {
      return false
    }
    const textUtf8 = this.lib.encoder.encode(text)
    return this.lib.copyToClipboardOSC52(this.rendererPtr, target, textUtf8)
  }

  public clearClipboardOSC52(target: ClipboardTarget = ClipboardTarget.Clipboard): boolean {
    if (!this.isOsc52Supported()) {
      return false
    }
    return this.lib.clearClipboardOSC52(this.rendererPtr, target)
  }

  public isOsc52Supported(): boolean {
    const caps = this.lib.getTerminalCapabilities(this.rendererPtr)
    return caps?.osc52_support !== "unsupported"
  }
}
