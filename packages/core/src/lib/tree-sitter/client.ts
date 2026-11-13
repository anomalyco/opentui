import { EventEmitter } from "events"
import type {
  TreeSitterClientOptions,
  TreeSitterClientEvents,
  BufferState,
  FiletypeParserOptions,
  Edit,
  PerformanceStats,
  SimpleHighlight,
  TreeSitterWorkerRequest,
  TreeSitterWorkerResponse,
} from "./types.js"
import { getParsers } from "./default-parsers.js"
import { resolve, isAbsolute, parse } from "path"
import { existsSync } from "fs"
import { registerEnvVar, env } from "../env.js"
import { isBunfsPath, normalizeBunfsPath } from "../bunfs.js"
import {
  type PlatformWorkerHandle,
  type WorkerErrorEvent,
  type WorkerMessageEvent,
  Worker as PlatformWorker,
} from "../../platform/worker.js"
import { resolveDefaultTreeSitterWorkerPath, resolveTreeSitterWasm } from "#opentui/runtime-assets"

registerEnvVar({
  name: "OTUI_TREE_SITTER_WORKER_PATH",
  description: "Path to the TreeSitter worker entry script",
  type: "string",
  default: "",
})

declare global {
  const OTUI_TREE_SITTER_WORKER_PATH: string
}

type TreeSitterWorkerPath = string | URL
type TreeSitterWorkerHandle = Pick<PlatformWorkerHandle, "onerror" | "onmessage" | "postMessage" | "terminate">

interface TreeSitterClientInternalOptions {
  autoStartWorker?: boolean
}

interface PendingRequest {
  resolve: (response: any) => void
  reject: (error: Error) => void
}

let DEFAULT_PARSER_OVERRIDES: FiletypeParserOptions[] = []

export function addDefaultParsers(parsers: FiletypeParserOptions[]): void {
  for (const parser of parsers) {
    DEFAULT_PARSER_OVERRIDES = [
      ...DEFAULT_PARSER_OVERRIDES.filter((existingParser) => existingParser.filetype !== parser.filetype),
      parser,
    ]
  }
}

const isUrl = (path: string) => path.startsWith("http://") || path.startsWith("https://")

// Parser options now support both URLs and local file paths
// TODO: TreeSitterClient should have a setOptions method, passing it on to the worker etc.
export class TreeSitterClient extends EventEmitter<TreeSitterClientEvents> {
  private initialized = false
  private worker: TreeSitterWorkerHandle | undefined
  private buffers: Map<number, BufferState> = new Map()
  private initializePromise: Promise<void> | undefined
  private initializeResolvers:
    | { resolve: () => void; reject: (error: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
    | undefined
  private messageCallbacks = new Map<string, PendingRequest>()
  private messageIdCounter: number = 0
  // The version of each buffer's last reset sent to the worker.
  private resetVersions = new Map<number, number>()
  private options: TreeSitterClientOptions
  private destroyCallbacks = new Set<() => void>()
  private lifecycleGeneration = 0
  private rejectInitialization: ((error: Error) => void) | undefined
  private destroyPromise: Promise<void> | undefined
  private workerTerminationFailed = false

  constructor(options: TreeSitterClientOptions, internalOptions: TreeSitterClientInternalOptions = {}) {
    super()
    this.options = options
    if (internalOptions.autoStartWorker ?? true) {
      this.startWorker()
    }
  }

  public onDestroy(callback: () => void): () => void {
    this.destroyCallbacks.add(callback)
    return () => {
      this.destroyCallbacks.delete(callback)
    }
  }

  private emitError(error: string, bufferId?: number): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", error, bufferId)
    }
  }

  private emitWarning(warning: string, bufferId?: number): void {
    if (this.listenerCount("warning") > 0) {
      this.emit("warning", warning, bufferId)
    }
  }

  private startWorker() {
    if (this.worker) {
      return
    }

    const workerPath = this.resolveWorkerPath()

    const worker = new PlatformWorker(workerPath)
    this.worker = worker

    worker.onmessage = (event) => {
      if (this.worker !== worker) {
        return
      }

      this.handleWorkerMessage(event as WorkerMessageEvent<TreeSitterWorkerResponse>)
    }

    worker.onerror = (error: WorkerErrorEvent) => {
      if (this.worker !== worker) {
        return
      }

      console.error("TreeSitter worker error:", error.message)
      const workerError = new Error(`Worker error: ${error.message}`, { cause: error.error })
      this.handleWorkerFailure(worker, workerError)
      this.emitError(`Worker error: ${error.message}`)
    }
  }

  private sendWorkerMessage(message: TreeSitterWorkerRequest): void {
    if (!this.worker) {
      throw new Error("TreeSitter worker is not available")
    }
    this.worker.postMessage(message)
  }

  private rejectPendingRequests(error: Error): void {
    const requests = Array.from(this.messageCallbacks.values())
    this.messageCallbacks.clear()
    for (const request of requests) {
      request.reject(error)
    }
  }

  private rejectActiveInitialization(error: Error): void {
    if (this.initializeResolvers) {
      clearTimeout(this.initializeResolvers.timeoutId)
      this.initializeResolvers.reject(error)
      this.initializeResolvers = undefined
    }
    this.rejectInitialization?.(error)
    this.rejectInitialization = undefined
  }

  private handleWorkerFailure(worker: TreeSitterWorkerHandle, error: Error): void {
    if (this.worker !== worker) {
      return
    }

    worker.onmessage = null
    worker.onerror = null
    this.worker = undefined
    this.lifecycleGeneration++
    this.initialized = false
    this.initializePromise = undefined
    this.rejectActiveInitialization(error)
    this.rejectPendingRequests(error)
    this.resetVersions.clear()
    this.buffers.clear()

    try {
      void Promise.resolve(worker.terminate()).catch(() => {})
    } catch {
      // The worker has already failed; cleanup is best effort.
    }
  }

  // Path resolution stays in the client for now; runtime-specific Worker construction lives in platform/worker.
  private resolveWorkerPath(): TreeSitterWorkerPath {
    if (this.options.workerPath) {
      return this.options.workerPath
    }

    if (env.OTUI_TREE_SITTER_WORKER_PATH) {
      return env.OTUI_TREE_SITTER_WORKER_PATH
    }

    if (typeof OTUI_TREE_SITTER_WORKER_PATH !== "undefined") {
      return OTUI_TREE_SITTER_WORKER_PATH
    }

    let workerPath = resolveDefaultTreeSitterWorkerPath(new URL("./parser.worker.js", import.meta.url))

    if (!process.env.OTUI_ASSET_ROOT && !existsSync(workerPath)) {
      workerPath = new URL("./parser.worker.ts", import.meta.url).href
    }

    return workerPath
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker
    if (!worker) {
      return
    }

    const onmessage = worker.onmessage
    const onerror = worker.onerror
    worker.onmessage = null
    worker.onerror = null
    this.worker = undefined

    try {
      const termination = worker.terminate()
      if (termination && typeof (termination as PromiseLike<number>).then === "function") {
        await termination
      }
    } catch (error) {
      if (!this.worker) {
        worker.onmessage = onmessage
        worker.onerror = onerror
        this.worker = worker
      }
      throw error
    }
  }

  // NOTE: Unused, but useful for debugging and testing
  private async handleReset() {
    this.buffers.clear()
    await this.stopWorker()
    this.startWorker()
    this.initialized = false
    this.initializePromise = undefined
    this.initializeResolvers = undefined
    return this.initialize()
  }

  async initialize(): Promise<void> {
    if (this.destroyPromise) {
      throw new Error("Cannot initialize while client is being destroyed")
    }
    if (this.workerTerminationFailed) {
      throw new Error("Cannot initialize after worker termination failed; retry destroy()")
    }

    if (this.initializePromise) {
      return this.initializePromise
    }

    if (!this.worker) {
      this.startWorker()
    }

    const worker = this.worker!
    const generation = this.lifecycleGeneration
    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancellation = reject
    })
    const initialization = Promise.race([this.initializeClient(generation, worker), cancellation])
    this.rejectInitialization = rejectCancellation
    this.initializePromise = initialization

    void initialization.then(
      () => {
        if (this.initializePromise === initialization) {
          this.rejectInitialization = undefined
        }
      },
      () => {
        if (this.initializePromise === initialization) {
          this.rejectInitialization = undefined
        }
      },
    )

    return this.initializePromise
  }

  private assertCurrentInitialization(generation: number, worker: TreeSitterWorkerHandle): void {
    if (this.lifecycleGeneration !== generation || this.worker !== worker || this.destroyPromise) {
      throw new Error("TreeSitter initialization was invalidated")
    }
  }

  private async initializeClient(generation: number, worker: TreeSitterWorkerHandle): Promise<void> {
    const treeSitterWasmPath = await resolveTreeSitterWasm()
    this.assertCurrentInitialization(generation, worker)
    await new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.initTimeout ?? 10000 // Default to 10 seconds
      const timeoutId = setTimeout(() => {
        const error = new Error("Worker initialization timed out")
        console.error("TreeSitter client:", error.message)
        this.initializeResolvers = undefined
        reject(error)
      }, timeoutMs)

      this.initializeResolvers = { resolve, reject, timeoutId }
      this.sendWorkerMessage({
        type: "INIT",
        dataPath: this.options.dataPath,
        treeSitterWasmPath,
      })
    })

    this.assertCurrentInitialization(generation, worker)
    await this.registerDefaultParsers(generation, worker)
    this.assertCurrentInitialization(generation, worker)
    this.initialized = true
  }

  private async registerDefaultParsers(
    generation: number = this.lifecycleGeneration,
    worker: TreeSitterWorkerHandle = this.worker!,
  ): Promise<void> {
    const defaultParsers = await getParsers()
    this.assertCurrentInitialization(generation, worker)
    const overriddenFiletypes = new Set(DEFAULT_PARSER_OVERRIDES.map((parser) => parser.filetype))

    for (const parser of [
      ...defaultParsers.filter((parser) => !overriddenFiletypes.has(parser.filetype)),
      ...DEFAULT_PARSER_OVERRIDES,
    ]) {
      worker.postMessage({ type: "ADD_FILETYPE_PARSER", filetypeParser: this.resolveFiletypeParser(parser) })
    }
  }

  private resolvePath(path: string): string {
    if (isUrl(path)) {
      return path
    }
    if (isBunfsPath(path)) {
      return normalizeBunfsPath(parse(path).base)
    }
    if (!isAbsolute(path)) {
      return resolve(path)
    }
    return path
  }

  public addFiletypeParser(filetypeParser: FiletypeParserOptions): void {
    this.sendWorkerMessage({ type: "ADD_FILETYPE_PARSER", filetypeParser: this.resolveFiletypeParser(filetypeParser) })
  }

  private resolveFiletypeParser(filetypeParser: FiletypeParserOptions): FiletypeParserOptions {
    return {
      ...filetypeParser,
      aliases: filetypeParser.aliases
        ? [...new Set(filetypeParser.aliases.filter((alias) => alias !== filetypeParser.filetype))]
        : undefined,
      wasm: this.resolvePath(filetypeParser.wasm),
      queries: {
        highlights: filetypeParser.queries.highlights.map((path) => this.resolvePath(path)),
        injections: filetypeParser.queries.injections?.map((path) => this.resolvePath(path)),
      },
    }
  }

  public async getPerformance(): Promise<PerformanceStats> {
    const messageId = `performance_${this.messageIdCounter++}`
    return new Promise<PerformanceStats>((resolve, reject) => {
      this.messageCallbacks.set(messageId, { resolve, reject })
      try {
        this.sendWorkerMessage({ type: "GET_PERFORMANCE", messageId })
      } catch (error) {
        this.messageCallbacks.delete(messageId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  public async highlightOnce(
    content: string,
    filetype: string,
  ): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }> {
    return this.request({
      type: "ONESHOT_HIGHLIGHT",
      content,
      filetype,
      messageId: `oneshot_${this.messageIdCounter++}`,
    })
  }

  /**
   * @internal Appends `text` at `offset` to the worker's copy `copyId` (created by the first append, at offset 0; free
   * it with `removeCopy`), parses it with the tree it kept, and answers the highlights of the whole copy. An offset
   * that differs from the copy's length is an error. Copies have their own ids, apart from buffers.
   */
  public async highlightAppend(
    copyId: number,
    offset: number,
    text: string,
    filetype: string,
  ): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }> {
    const messageId = `append_${this.messageIdCounter++}`
    return this.request({ type: "APPEND_HIGHLIGHT", copyId, offset, text, filetype, messageId })
  }

  /** @internal Frees copy `copyId`. An append still waiting for the worker to start posts first, so this waits too. */
  public async removeCopy(copyId: number): Promise<void> {
    if (!this.initialized) {
      if (!this.initializePromise) return
      await this.initialize().catch(() => {})
    }
    if (this.worker) this.sendWorkerMessage({ type: "DISPOSE_COPY", copyId })
  }

  private async request(
    message: Extract<TreeSitterWorkerRequest, { type: "ONESHOT_HIGHLIGHT" | "APPEND_HIGHLIGHT" }>,
  ): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }> {
    if (!this.initialized) {
      try {
        await this.initialize()
      } catch (error) {
        return { error: "Could not highlight because of initialization error" }
      }
    }
    const messageId = message.messageId
    return new Promise((resolve, reject) => {
      this.messageCallbacks.set(messageId, { resolve, reject })
      try {
        this.sendWorkerMessage(message)
      } catch (error) {
        this.messageCallbacks.delete(messageId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private handleWorkerMessage(event: WorkerMessageEvent<TreeSitterWorkerResponse>) {
    const message = event.data

    switch (message.type) {
      case "HIGHLIGHT_RESPONSE": {
        const buffer = this.buffers.get(message.bufferId)
        if (!buffer || !buffer.hasParser) {
          return
        }

        // A stale reply resets unless a later reset was sent: replies come in order, so that reset's reply is still to
        // come. An edit's reply covers only its changed range, so a reply at the last reset's version resets too.
        if (buffer.version !== message.version) {
          if ((this.resetVersions.get(message.bufferId) ?? -Infinity) <= message.version) {
            this.resetBuffer(message.bufferId, buffer.version, buffer.content)
          }
          return
        }

        this.emit("highlights:response", message.bufferId, message.version, message.highlights)
        return
      }

      case "INIT_RESPONSE": {
        if (!this.initializeResolvers) {
          return
        }

        clearTimeout(this.initializeResolvers.timeoutId)

        if (message.error) {
          console.error("TreeSitter client initialization failed:", message.error)
          this.initializeResolvers.reject(new Error(message.error))
        } else {
          this.initializeResolvers.resolve()
        }

        this.initializeResolvers = undefined
        return
      }

      case "PARSER_INIT_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({ hasParser: message.hasParser, warning: message.warning, error: message.error })
        }
        return
      }

      case "PRELOAD_PARSER_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({ hasParser: message.hasParser })
        }
        return
      }

      case "BUFFER_DISPOSED": {
        const callback = this.messageCallbacks.get(`dispose_${message.bufferId}`)
        if (callback) {
          this.messageCallbacks.delete(`dispose_${message.bufferId}`)
          callback.resolve(true)
        }

        this.emit("buffer:disposed", message.bufferId)
        return
      }

      case "PERFORMANCE_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve(message.performance)
        }
        return
      }

      case "ONESHOT_HIGHLIGHT_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({ highlights: message.highlights, warning: message.warning, error: message.error })
        }
        return
      }

      case "UPDATE_DATA_PATH_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({ error: message.error })
        }
        return
      }

      case "CLEAR_CACHE_RESPONSE": {
        const callback = this.messageCallbacks.get(message.messageId)
        if (callback) {
          this.messageCallbacks.delete(message.messageId)
          callback.resolve({ error: message.error })
        }
        return
      }

      case "WARNING": {
        this.emitWarning(message.warning, message.bufferId)
        return
      }

      case "ERROR": {
        if (message.messageId) {
          const callback = this.messageCallbacks.get(message.messageId)
          if (callback) {
            this.messageCallbacks.delete(message.messageId)
            callback.reject(new Error(message.error))
          }
        }
        this.emitError(message.error, message.bufferId)
        return
      }

      case "WORKER_LOG": {
        this.emit("worker:log", message.logType, message.data.join(" "))
        return
      }
    }
  }

  public async preloadParser(filetype: string): Promise<boolean> {
    const messageId = `has_parser_${this.messageIdCounter++}`
    const response = await new Promise<{ hasParser: boolean; warning?: string; error?: string }>((resolve, reject) => {
      this.messageCallbacks.set(messageId, { resolve, reject })
      try {
        this.sendWorkerMessage({
          type: "PRELOAD_PARSER",
          filetype,
          messageId,
        })
      } catch (error) {
        this.messageCallbacks.delete(messageId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return response.hasParser
  }

  public async createBuffer(
    id: number,
    content: string,
    filetype: string,
    version: number = 1,
    autoInitialize: boolean = true,
  ): Promise<boolean> {
    if (!this.initialized && !autoInitialize) {
      this.emitError("Could not create buffer because client is not initialized")
      return false
    }
    if (this.buffers.has(id)) {
      throw new Error(`Buffer with id ${id} already exists`)
    }

    // A removeBuffer, or another createBuffer of this id, replaces this record; this call then returns false.
    const created: BufferState = { id, content, filetype, version, hasParser: false }
    this.buffers.set(id, created)
    const drop = () => this.buffers.get(id) === created && this.buffers.delete(id)
    if (!this.initialized) {
      try {
        await this.initialize()
      } catch (error) {
        drop()
        this.emitError("Could not create buffer because of initialization error")
        return false
      }
      if (this.buffers.get(id) !== created) return false
    }

    const messageId = `init_${this.messageIdCounter++}`
    const response = await new Promise<{ hasParser: boolean; warning?: string; error?: string }>((resolve, reject) => {
      this.messageCallbacks.set(messageId, { resolve, reject })
      try {
        this.sendWorkerMessage({
          type: "INITIALIZE_PARSER",
          bufferId: id,
          version,
          content,
          filetype,
          messageId,
        })
      } catch (error) {
        this.messageCallbacks.delete(messageId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }).catch((error) => (drop(), Promise.reject(error)))

    if (this.buffers.get(id) !== created) return false
    if (!response.hasParser) {
      this.emit("buffer:initialized", id, false)
      if (filetype !== "plaintext") {
        this.emitWarning(response.warning || response.error || "Buffer has no parser", id)
      }
      return false
    }

    this.buffers.set(id, { id, content, filetype, version, hasParser: true })

    this.emit("buffer:initialized", id, true)
    return true
  }

  public async updateBuffer(id: number, edits: Edit[], newContent: string, version: number): Promise<void> {
    if (!this.initialized) {
      return
    }

    const buffer = this.buffers.get(id)
    if (!buffer || !buffer.hasParser) {
      return
    }

    // The worker runs a buffer's messages in the order they are posted, so edits and resets apply in call order.
    this.buffers.set(id, { ...buffer, content: newContent, version })
    this.sendWorkerMessage({ type: "HANDLE_EDITS", bufferId: id, version, content: newContent, edits })
  }

  public async removeBuffer(bufferId: number): Promise<void> {
    this.buffers.delete(bufferId)
    this.resetVersions.delete(bufferId)
    // A client that is not initialized has no worker buffers, only createBuffer records waiting for it to start.
    if (!this.initialized) {
      return
    }

    if (this.worker) {
      await new Promise<boolean>((resolve, reject) => {
        const messageId = `dispose_${bufferId}`
        // An overlapping removeBuffer of this id replaces the stored callback, so it settles the earlier call too.
        const previous = this.messageCallbacks.get(messageId)
        const callback = {
          resolve: (disposed: boolean) => (previous?.resolve(disposed), resolve(disposed)),
          reject: (error: Error) => (previous?.reject(error), reject(error)),
        }
        this.messageCallbacks.set(messageId, callback)
        try {
          this.sendWorkerMessage({
            type: "DISPOSE_BUFFER",
            bufferId,
          })
        } catch (error) {
          console.error("Error disposing buffer", error)
          this.messageCallbacks.delete(messageId)
          callback.resolve(false)
        }

        // Add a timeout in case the worker doesn't respond; a later removeBuffer of this id reuses messageId
        setTimeout(() => {
          if (this.messageCallbacks.get(messageId) === callback) {
            this.messageCallbacks.delete(messageId)
            console.warn({ bufferId }, "Timed out waiting for buffer to be disposed")
            callback.resolve(false)
          }
        }, 3000)
      })
    }
  }

  public destroy(): Promise<void> {
    if (this.destroyPromise) {
      return this.destroyPromise
    }

    let resolveDestroy!: () => void
    let rejectDestroy!: (error: unknown) => void
    const destroyPromise = new Promise<void>((resolve, reject) => {
      resolveDestroy = resolve
      rejectDestroy = reject
    })
    this.destroyPromise = destroyPromise

    const destroyError = new Error("Client destroyed during initialization")
    this.lifecycleGeneration++
    this.initialized = false
    this.initializePromise = undefined
    this.rejectActiveInitialization(destroyError)
    this.rejectPendingRequests(new Error("TreeSitter client destroyed"))

    for (const callback of this.destroyCallbacks) {
      try {
        callback()
      } catch (error) {
        console.error("TreeSitter client destroy callback failed:", error)
      }
    }
    this.destroyCallbacks.clear()

    this.resetVersions.clear()
    this.buffers.clear()

    void this.stopWorker().then(
      () => {
        this.workerTerminationFailed = false
        if (this.destroyPromise === destroyPromise) {
          this.destroyPromise = undefined
        }
        resolveDestroy()
      },
      (error) => {
        this.workerTerminationFailed = true
        if (this.destroyPromise === destroyPromise) {
          this.destroyPromise = undefined
        }
        rejectDestroy(error)
      },
    )
    return destroyPromise
  }

  public async resetBuffer(bufferId: number, version: number, content: string): Promise<void> {
    if (!this.initialized) {
      return
    }

    const buffer = this.buffers.get(bufferId)
    if (!buffer || !buffer.hasParser) {
      this.emitError("Cannot reset buffer with no parser", bufferId)
      return
    }

    this.buffers.set(bufferId, { ...buffer, content, version })
    this.resetVersions.set(bufferId, version)
    this.sendWorkerMessage({ type: "RESET_BUFFER", bufferId, version, content, edits: [] })
  }

  public getBuffer(bufferId: number): BufferState | undefined {
    return this.buffers.get(bufferId)
  }

  public getAllBuffers(): BufferState[] {
    return Array.from(this.buffers.values())
  }

  public isInitialized(): boolean {
    return this.initialized
  }

  public async setDataPath(dataPath: string): Promise<void> {
    if (this.options.dataPath === dataPath) {
      return
    }

    this.options.dataPath = dataPath

    if (this.initialized && this.worker) {
      const messageId = `update_datapath_${this.messageIdCounter++}`
      return new Promise<void>((resolve, reject) => {
        this.messageCallbacks.set(messageId, {
          resolve: (response: any) => {
            if (response.error) {
              reject(new Error(response.error))
            } else {
              resolve()
            }
          },
          reject,
        })
        try {
          this.sendWorkerMessage({
            type: "UPDATE_DATA_PATH",
            dataPath,
            messageId,
          })
        } catch (error) {
          this.messageCallbacks.delete(messageId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }
  }

  public async clearCache(): Promise<void> {
    if (!this.initialized || !this.worker) {
      throw new Error("Cannot clear cache: client is not initialized")
    }

    const messageId = `clear_cache_${this.messageIdCounter++}`
    return new Promise<void>((resolve, reject) => {
      this.messageCallbacks.set(messageId, {
        resolve: (response: any) => {
          if (response.error) {
            reject(new Error(response.error))
          } else {
            resolve()
          }
        },
        reject,
      })
      try {
        this.sendWorkerMessage({
          type: "CLEAR_CACHE",
          messageId,
        })
      } catch (error) {
        this.messageCallbacks.delete(messageId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
