export const WORKER_UNAVAILABLE = "OpenTUI tree-sitter workers are not available for this runtime yet."

export interface WorkerMessageEvent<T = unknown> {
  readonly data: T
}

export interface WorkerErrorEvent {
  readonly error?: unknown
  readonly message: string
}

export type WorkerMessageHandler<T = unknown> = (event: WorkerMessageEvent<T>) => void | Promise<void>
export type WorkerErrorHandler = (event: WorkerErrorEvent) => void

type AnyWorkerMessageHandler = WorkerMessageHandler<any>

export interface PlatformWorkerOptions {
  name?: string
}

export interface PlatformWorkerHandle {
  onmessage: WorkerMessageHandler | null
  onerror: WorkerErrorHandler | null
  postMessage(value: unknown): void
  terminate(): void | Promise<number>
  addEventListener(type: "message" | "error", listener: WorkerMessageHandler | WorkerErrorHandler): void
  removeEventListener(type: "message" | "error", listener: WorkerMessageHandler | WorkerErrorHandler): void
}

export type PlatformWorkerConstructor = new (
  specifier: string | URL,
  options?: PlatformWorkerOptions,
) => PlatformWorkerHandle

interface NodeMessagePort {
  postMessage(value: unknown): void
  on(event: "message", listener: (value: unknown) => void): void
  off(event: "message", listener: (value: unknown) => void): void
}

interface NodeWorkerThread {
  postMessage(value: unknown): void
  on(event: "message", listener: (value: unknown) => void): void
  on(event: "error", listener: (error: Error) => void): void
  off(event: "message", listener: (value: unknown) => void): void
  off(event: "error", listener: (error: Error) => void): void
  terminate(): Promise<number>
}

interface NodeWorkerThreadsModule {
  Worker: new (
    filename: string,
    options: {
      eval: true
      type: "module"
      name?: string
    },
  ) => NodeWorkerThread
  readonly parentPort: NodeMessagePort | null
  readonly isMainThread: boolean
}

interface WorkerRuntimeBridge {
  postMessage(value: unknown): void
  setMessageHandler<T>(handler: WorkerMessageHandler<T>): () => void
}

type GlobalWithWorker = typeof globalThis & {
  Worker?: PlatformWorkerConstructor
  __opentuiWorkerMessageBridge?: true
  close?: () => void
  postMessage?: (value: unknown) => void
}

interface NodePathModule {
  isAbsolute(path: string): boolean
  resolve(...paths: string[]): string
}

interface NodeUrlModule {
  pathToFileURL(path: string): URL
}

interface ProcessWithBuiltinModule {
  readonly getBuiltinModule?: (id: string) => unknown
}

const globalWithWorker = globalThis as GlobalWithWorker
const nodeWorkerThreads = getBuiltinModule<NodeWorkerThreadsModule>("node:worker_threads")
const runtimeBridge = loadWorkerRuntime(nodeWorkerThreads)

class UnsupportedWorker implements PlatformWorkerHandle {
  public onmessage: WorkerMessageHandler | null = null
  public onerror: WorkerErrorHandler | null = null

  constructor() {
    throw new Error(WORKER_UNAVAILABLE)
  }

  postMessage(): void {
    throw new Error(WORKER_UNAVAILABLE)
  }

  terminate(): void {
    throw new Error(WORKER_UNAVAILABLE)
  }

  addEventListener(): void {
    throw new Error(WORKER_UNAVAILABLE)
  }

  removeEventListener(): void {
    throw new Error(WORKER_UNAVAILABLE)
  }
}

export const Worker: PlatformWorkerConstructor = loadWorkerConstructor()
export const isWorkerRuntime = runtimeBridge !== undefined

export function postWorkerMessage(value: unknown): void {
  if (!runtimeBridge) {
    throw new Error(WORKER_UNAVAILABLE)
  }

  runtimeBridge.postMessage(value)
}

export function setWorkerMessageHandler<T>(handler: WorkerMessageHandler<T>): () => void {
  if (!runtimeBridge) {
    throw new Error(WORKER_UNAVAILABLE)
  }

  return runtimeBridge.setMessageHandler(handler)
}

function getBuiltinModule<T>(id: string): T | undefined {
  if (typeof process === "undefined") {
    return undefined
  }

  const loader = (process as typeof process & ProcessWithBuiltinModule).getBuiltinModule
  if (typeof loader !== "function") {
    return undefined
  }

  try {
    return loader(id) as T
  } catch {
    return undefined
  }
}

function loadWorkerConstructor(): PlatformWorkerConstructor {
  if (typeof globalWithWorker.Worker === "function") {
    return globalWithWorker.Worker
  }

  if (nodeWorkerThreads) {
    return createNodeWorkerConstructor(nodeWorkerThreads)
  }

  return UnsupportedWorker
}

function createNodeWorkerConstructor(node: NodeWorkerThreadsModule): PlatformWorkerConstructor {
  return class NodeWorkerShim implements PlatformWorkerHandle {
    public onmessage: WorkerMessageHandler | null = null
    public onerror: WorkerErrorHandler | null = null

    private readonly errorListeners = new Set<WorkerErrorHandler>()
    private readonly messageListeners = new Set<WorkerMessageHandler>()
    private readonly worker: NodeWorkerThread
    private terminationPromise: Promise<number> | undefined

    constructor(specifier: string | URL, options: PlatformWorkerOptions = {}) {
      const resolvedSpecifier = resolveWorkerImportSpecifier(specifier)

      this.worker = new node.Worker(createWorkerBootstrapSource(resolvedSpecifier), {
        eval: true,
        type: "module",
        name: options.name,
      })

      this.worker.on("message", this.handleMessage)
      this.worker.on("error", this.handleError)
    }

    postMessage(value: unknown): void {
      this.worker.postMessage(value)
    }

    terminate(): Promise<number> {
      if (this.terminationPromise) {
        return this.terminationPromise
      }

      this.worker.off("message", this.handleMessage)
      this.worker.off("error", this.handleError)
      const termination = this.worker.terminate().catch((error: unknown) => {
        this.terminationPromise = undefined
        this.worker.on("message", this.handleMessage)
        this.worker.on("error", this.handleError)
        throw error
      })
      this.terminationPromise = termination
      return termination
    }

    addEventListener(type: "message" | "error", listener: WorkerMessageHandler | WorkerErrorHandler): void {
      if (type === "message") {
        this.messageListeners.add(listener as WorkerMessageHandler)
        return
      }

      this.errorListeners.add(listener as WorkerErrorHandler)
    }

    removeEventListener(type: "message" | "error", listener: WorkerMessageHandler | WorkerErrorHandler): void {
      if (type === "message") {
        this.messageListeners.delete(listener as WorkerMessageHandler)
        return
      }

      this.errorListeners.delete(listener as WorkerErrorHandler)
    }

    private readonly handleMessage = (data: unknown): void => {
      const event: WorkerMessageEvent = { data }

      this.onmessage?.(event)

      for (const listener of this.messageListeners) {
        listener(event)
      }
    }

    private readonly handleError = (error: Error): void => {
      const event: WorkerErrorEvent = {
        error,
        message: error.message,
      }

      this.onerror?.(event)

      for (const listener of this.errorListeners) {
        listener(event)
      }
    }
  }
}

function createWorkerBootstrapSource(specifier: string): string {
  return `
    import { parentPort } from "node:worker_threads"

    const pendingMessages = []
    let messageHandler = null

    globalThis.self ??= globalThis
    globalThis.postMessage ??= (value) => parentPort?.postMessage(value)
    globalThis.__opentuiWorkerMessageBridge = true
    Object.defineProperty(globalThis, "onmessage", {
      configurable: true,
      get: () => messageHandler,
      set: (handler) => {
        messageHandler = typeof handler === "function" ? handler : null
        if (!messageHandler) return

        const messages = pendingMessages.splice(0)
        for (const data of messages) {
          messageHandler({ data })
        }
      },
    })
    parentPort?.on("message", (data) => {
      if (messageHandler) {
        messageHandler({ data })
      } else {
        pendingMessages.push(data)
      }
    })

    await import(${JSON.stringify(specifier)})
  `
}

function resolveWorkerImportSpecifier(specifier: string | URL): string {
  if (specifier instanceof URL) {
    return specifier.href
  }

  if (isRuntimeSpecifier(specifier)) {
    return specifier
  }

  // The Node shim cannot infer the caller module URL for plain strings, so
  // relative override strings resolve from the current working directory.
  // Callers that need module-relative behavior should pass a URL instead.
  const nodePath = getBuiltinModule<NodePathModule>("node:path")
  const nodeUrl = getBuiltinModule<NodeUrlModule>("node:url")
  if (!nodePath || !nodeUrl) {
    throw new Error(WORKER_UNAVAILABLE)
  }

  const absolutePath = nodePath.isAbsolute(specifier) ? specifier : nodePath.resolve(specifier)

  return nodeUrl.pathToFileURL(absolutePath).href
}

function isRuntimeSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("file:") ||
    specifier.startsWith("data:") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:")
  )
}

function loadWorkerRuntime(node: NodeWorkerThreadsModule | undefined): WorkerRuntimeBridge | undefined {
  if (node?.parentPort && node.isMainThread === false) {
    if (globalWithWorker.__opentuiWorkerMessageBridge) {
      return createGlobalWorkerRuntimeBridge()
    }

    return {
      postMessage(value: unknown): void {
        node.parentPort?.postMessage(value)
      },
      setMessageHandler<T>(handler: WorkerMessageHandler<T>): () => void {
        const listener = (data: unknown): void => {
          void handler({ data: data as T })
        }

        node.parentPort?.on("message", listener)

        return () => {
          node.parentPort?.off("message", listener)
        }
      },
    }
  }

  if (!isGlobalWorkerRuntime()) {
    return undefined
  }

  return createGlobalWorkerRuntimeBridge()
}

function createGlobalWorkerRuntimeBridge(): WorkerRuntimeBridge {
  interface HandlerRegistration {
    active: boolean
    fallbackHandler: AnyWorkerMessageHandler | null
    listener: AnyWorkerMessageHandler
    previous?: HandlerRegistration
  }

  let currentRegistration: HandlerRegistration | undefined

  return {
    postMessage(value: unknown): void {
      globalWithWorker.postMessage?.(value)
    },
    setMessageHandler<T>(handler: WorkerMessageHandler<T>): () => void {
      const previousHandler = getGlobalWorkerMessageHandler()
      if (currentRegistration && previousHandler !== currentRegistration.listener) {
        currentRegistration = undefined
      }

      const listener: WorkerMessageHandler<T> = (event): void => {
        const normalizedEvent = normalizeWorkerMessageEvent<T>(event)
        void handler(normalizedEvent)
      }
      const registration: HandlerRegistration = {
        active: true,
        fallbackHandler: currentRegistration ? currentRegistration.fallbackHandler : previousHandler,
        listener,
        previous: currentRegistration,
      }

      currentRegistration = registration
      setGlobalWorkerMessageHandler(listener)

      return () => {
        registration.active = false
        if (currentRegistration !== registration || getGlobalWorkerMessageHandler() !== listener) {
          return
        }

        let previous = registration.previous
        while (previous && !previous.active) {
          previous = previous.previous
        }

        currentRegistration = previous
        setGlobalWorkerMessageHandler(previous?.listener ?? registration.fallbackHandler)
      }
    },
  }
}

function isGlobalWorkerRuntime(): boolean {
  if (typeof globalWithWorker.postMessage !== "function") {
    return false
  }

  return typeof document === "undefined" && typeof globalWithWorker.close === "function" && "onmessage" in globalThis
}

function normalizeWorkerMessageEvent<T>(event: unknown): WorkerMessageEvent<T> {
  if (event && typeof event === "object" && "data" in event) {
    return event as WorkerMessageEvent<T>
  }

  return { data: event as T }
}

function getGlobalWorkerMessageHandler(): AnyWorkerMessageHandler | null {
  return ((globalThis as { onmessage?: unknown }).onmessage as AnyWorkerMessageHandler | null | undefined) ?? null
}

function setGlobalWorkerMessageHandler(handler: AnyWorkerMessageHandler | null): void {
  ;(globalThis as { onmessage?: unknown }).onmessage = handler
}
