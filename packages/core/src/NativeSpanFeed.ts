import { toArrayBuffer, type Pointer } from "./platform/ffi.js"
import { resolveRenderLib } from "./zig.js"
import { SpanInfoStruct } from "./zig-structs.js"
import type { NativeSpanFeedOptions } from "./zig-structs.js"

export type { GrowthPolicy, NativeSpanFeedOptions, NativeSpanFeedStats } from "./zig-structs.js"

const enum EventId {
  ChunkAdded = 2,
  Closed = 5,
  Error = 6,
  DataAvailable = 7,
}

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value
}

type StreamEventHandler = (eventId: number, arg0: Pointer, arg1: number | bigint) => void

export type DataHandler = (data: Uint8Array) => void | Promise<void>

const canThrowAcrossNativeCallback =
  typeof process !== "undefined" &&
  typeof process.versions === "object" &&
  process.versions !== null &&
  typeof process.versions.bun === "string"

/**
 * Zero-copy wrapper over Zig memory; not a full stream interface.
 * Data views are borrowed until all handlers for a span have completed.
 */
export class NativeSpanFeed {
  static create(options?: NativeSpanFeedOptions): NativeSpanFeed {
    const lib = resolveRenderLib()
    const streamPtr = lib.createNativeSpanFeed(options)
    try {
      const stream = new NativeSpanFeed(streamPtr)
      lib.registerNativeSpanFeedStream(streamPtr, stream.eventHandler)
      const status = lib.attachNativeSpanFeed(streamPtr)
      if (status !== 0) throw new Error(`Failed to attach stream: ${status}`)
      return stream
    } catch (error) {
      lib.unregisterNativeSpanFeedStream(streamPtr)
      lib.destroyNativeSpanFeed(streamPtr)
      throw error
    }
  }

  static attach(streamPtr: Pointer, _options?: NativeSpanFeedOptions): NativeSpanFeed {
    const lib = resolveRenderLib()
    const stream = new NativeSpanFeed(streamPtr)

    try {
      lib.registerNativeSpanFeedStream(streamPtr, stream.eventHandler)
      const status = lib.attachNativeSpanFeed(streamPtr)
      if (status !== 0) throw new Error(`Failed to attach stream: ${status}`)
      return stream
    } catch (error) {
      lib.unregisterNativeSpanFeedStream(streamPtr)
      throw error
    }
  }

  readonly streamPtr: Pointer
  private readonly lib = resolveRenderLib()
  private readonly eventHandler: StreamEventHandler
  private chunkMap = new Map<Pointer, ArrayBuffer>()
  private dataHandlers = new Set<DataHandler>()
  private errorHandlers = new Set<(code: number) => void>()
  private drainBuffer: Uint8Array | null = null
  private closed = false
  private destroyed = false
  private draining = false
  private pendingDataAvailable = false
  private pendingClose = false
  private closing = false
  private pendingAsyncHandlers = 0
  private inCallback = false
  private closeQueued = false
  private idleResolvers: Array<() => void> = []
  private pendingHandlerError: { value: unknown } | null = null
  private pendingHandlerErrorQueued = false

  private constructor(streamPtr: Pointer) {
    this.streamPtr = streamPtr
    this.eventHandler = (eventId, arg0, arg1) => {
      this.handleEvent(eventId, arg0, arg1)
    }
    this.ensureDrainBuffer()
  }

  private ensureDrainBuffer(): void {
    if (this.drainBuffer) return
    const capacity = 256
    this.drainBuffer = new Uint8Array(capacity * SpanInfoStruct.size)
  }

  onData(handler: DataHandler): () => void {
    this.dataHandlers.add(handler)
    if (this.pendingDataAvailable) {
      this.pendingDataAvailable = false
      this.drainAll()
    }
    return () => this.dataHandlers.delete(handler)
  }

  onError(handler: (code: number) => void): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  private hasPinnedChunks(): boolean {
    return !this.destroyed && (this.lib.streamGetStats(this.streamPtr)?.outstandingSpans ?? 0) > 0
  }

  isBackpressured(): boolean {
    return this.pendingAsyncHandlers > 0 || this.pendingDataAvailable || this.hasPinnedChunks()
  }

  close(): void {
    if (this.destroyed) return
    if (this.inCallback || this.draining || this.pendingAsyncHandlers > 0) {
      this.pendingClose = true
      if (!this.closeQueued) {
        this.closeQueued = true
        queueMicrotask(() => {
          this.closeQueued = false
          this.processPendingClose()
        })
      }
      return
    }
    this.performClose()
  }

  private processPendingClose(): void {
    if (!this.pendingClose || this.destroyed) return
    if (this.inCallback || this.draining || this.pendingAsyncHandlers > 0) return
    this.pendingClose = false
    this.performClose()
    this.resolveIdleIfNeeded()
  }

  private performClose(): void {
    if (this.closing) return
    this.closing = true
    if (!this.closed) {
      const status = this.lib.streamClose(this.streamPtr)
      if (status !== 0) {
        this.closing = false
        return
      }
      this.closed = true
    }
    this.finalizeDestroy()
  }

  private finalizeDestroy(): void {
    if (this.destroyed) return
    if (this.lib.destroyNativeSpanFeed(this.streamPtr) !== 0) {
      this.closing = false
      return
    }
    this.destroyed = true
    this.chunkMap.clear()
    this.drainBuffer = null
    this.dataHandlers.clear()
    this.errorHandlers.clear()
    this.pendingDataAvailable = false
    this.resolveIdleIfNeeded()
  }

  private isIdle(): boolean {
    return (
      !this.inCallback &&
      !this.draining &&
      this.pendingAsyncHandlers === 0 &&
      !this.pendingDataAvailable &&
      !this.hasPinnedChunks()
    )
  }

  private resolveIdleIfNeeded(): void {
    if (this.idleResolvers.length === 0 || !this.isIdle()) return
    const resolvers = this.idleResolvers.splice(0)
    for (const resolve of resolvers) {
      resolve()
    }
  }

  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve)
    })
  }

  private handleEvent(eventId: number, arg0: Pointer, arg1: number | bigint): void {
    const wasInCallback = this.inCallback
    this.inCallback = true
    try {
      switch (eventId) {
        case EventId.DataAvailable: {
          if (this.closing) break
          if (this.dataHandlers.size === 0) {
            this.pendingDataAvailable = true
            break
          }
          this.drainAll()
          break
        }
        case EventId.ChunkAdded: {
          const chunkLen = toNumber(arg1)
          if (chunkLen > 0 && arg0) {
            if (!this.chunkMap.has(arg0)) {
              const buffer = toArrayBuffer(arg0, 0, chunkLen)
              this.chunkMap.set(arg0, buffer)
            }
          }
          break
        }
        case EventId.Error: {
          const code = toNumber(arg0)
          for (const handler of this.errorHandlers) handler(code)
          break
        }
        case EventId.Closed: {
          this.closed = true
          break
        }
        default:
          break
      }
    } finally {
      this.inCallback = wasInCallback
      this.resolveIdleIfNeeded()
    }
  }

  private queuePendingHandlerError(error: unknown): void {
    this.pendingHandlerError ??= { value: error }
    if (this.pendingHandlerErrorQueued) return

    this.pendingHandlerErrorQueued = true
    queueMicrotask(() => {
      this.pendingHandlerErrorQueued = false
      this.throwPendingHandlerError()
    })
  }

  private throwPendingHandlerError(): void {
    if (this.pendingHandlerError === null) return

    const pendingError = this.pendingHandlerError
    this.pendingHandlerError = null
    throw pendingError.value
  }

  private drainOnce(): number {
    if (!this.drainBuffer || this.draining || this.pendingClose) return 0
    const capacity = Math.floor(this.drainBuffer.byteLength / SpanInfoStruct.size)
    if (capacity === 0) return 0

    const count = this.lib.streamDrainSpans(this.streamPtr, this.drainBuffer, capacity)
    if (count === 0) return 0

    this.draining = true
    const spans = SpanInfoStruct.unpackList(this.drainBuffer.buffer, count)
    let firstError: { value: unknown } | null = null

    try {
      for (const span of spans) {
        let asyncResults: Promise<void>[] | null = null
        try {
          // A close request drops undelivered spans, but every drained span must
          // still be released before native storage can be destroyed.
          if (this.pendingClose || span.len === 0) continue

          const buffer = this.chunkMap.get(span.chunkPtr)
          if (!buffer || span.offset + span.len > buffer.byteLength) continue

          const slice = new Uint8Array(buffer, span.offset, span.len)

          for (const handler of this.dataHandlers) {
            try {
              const result = handler(slice)
              if (result && typeof result.then === "function") {
                asyncResults ??= []
                asyncResults.push(result)
              }
            } catch (e) {
              firstError ??= { value: e }
            }
          }
        } finally {
          if (asyncResults) {
            this.pendingAsyncHandlers += 1
            Promise.allSettled(asyncResults).then(() => {
              this.lib.streamReleaseSpan(this.streamPtr, span.slotIndex, span.releaseId)
              this.pendingAsyncHandlers -= 1
              this.processPendingClose()
              this.resolveIdleIfNeeded()
            })
          } else {
            this.lib.streamReleaseSpan(this.streamPtr, span.slotIndex, span.releaseId)
          }
        }
      }
    } finally {
      this.draining = false
      this.resolveIdleIfNeeded()
    }

    if (firstError) {
      if (!this.inCallback || canThrowAcrossNativeCallback) {
        throw firstError.value
      }

      // Node FFI terminates when JS exceptions cross a native callback boundary.
      // Surface the error after the callback returns instead of swallowing it.
      this.queuePendingHandlerError(firstError.value)
    }

    return count
  }

  drainAll(): void {
    let count = this.drainOnce()
    while (count > 0) {
      count = this.drainOnce()
    }
    if (!this.inCallback) {
      this.throwPendingHandlerError()
    }
  }
}
