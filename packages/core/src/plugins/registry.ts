import type { CliRenderer } from "../renderer.js"
import type {
  Plugin,
  PluginContext,
  PluginErrorEvent,
  PluginErrorReport,
  ResolvedSlotRenderer,
  SlotRenderer,
} from "./types.js"

const noop = () => {}
const DEFAULT_DEBUG_PLUGIN_ERRORS = false
const DEFAULT_MAX_PLUGIN_ERRORS = 100

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  if (typeof error === "string") {
    return new Error(error)
  }

  return new Error(`Unknown plugin error: ${String(error)}`)
}

export interface SlotRegistryOptions {
  onPluginError?: (event: PluginErrorEvent) => void
  debugPluginErrors?: boolean
  maxPluginErrors?: number
}

interface RegisteredPlugin<TNode, TSlots extends object, TContext extends PluginContext = PluginContext> {
  plugin: Plugin<TNode, TSlots, TContext>
  registrationOrder: number
  cachedOrder: number
  cachedId: string
}

export class SlotRegistry<TNode, TSlots extends object, TContext extends PluginContext = PluginContext> {
  private plugins: RegisteredPlugin<TNode, TSlots, TContext>[] = []
  private sortedPluginsCache: RegisteredPlugin<TNode, TSlots, TContext>[] | null = null
  private listeners: Set<() => void> = new Set()
  private errorListeners: Set<(event: PluginErrorEvent) => void> = new Set()
  private pluginErrors: PluginErrorEvent[] = []
  private registrationOrder = 0
  private batchDepth = 0
  private batchedNotify = false
  private rendererInstance: CliRenderer
  private hostContext: Readonly<TContext>
  private options: Required<Pick<SlotRegistryOptions, "debugPluginErrors" | "maxPluginErrors">> &
    Pick<SlotRegistryOptions, "onPluginError">

  constructor(renderer: CliRenderer, context: TContext, options: SlotRegistryOptions = {}) {
    this.rendererInstance = renderer
    this.hostContext = context
    this.options = {
      debugPluginErrors: options.debugPluginErrors ?? DEFAULT_DEBUG_PLUGIN_ERRORS,
      maxPluginErrors: options.maxPluginErrors ?? DEFAULT_MAX_PLUGIN_ERRORS,
      onPluginError: options.onPluginError,
    }
  }

  public get renderer(): CliRenderer {
    return this.rendererInstance
  }

  public get context(): Readonly<TContext> {
    return this.hostContext
  }

  public configure(options: SlotRegistryOptions): void {
    if ("debugPluginErrors" in options) {
      this.options.debugPluginErrors = options.debugPluginErrors ?? DEFAULT_DEBUG_PLUGIN_ERRORS
    }

    if ("maxPluginErrors" in options) {
      this.options.maxPluginErrors = options.maxPluginErrors ?? DEFAULT_MAX_PLUGIN_ERRORS
    }

    if ("onPluginError" in options) {
      this.options.onPluginError = options.onPluginError
    }
  }

  public register(plugin: Plugin<TNode, TSlots, TContext>): () => void {
    if (this.plugins.some((entry) => entry.plugin.id === plugin.id)) {
      throw new Error(`Plugin with id "${plugin.id}" is already registered`)
    }

    try {
      plugin.setup?.(this.hostContext, this.rendererInstance)
    } catch (error) {
      this.reportPluginError({
        pluginId: plugin.id,
        phase: "setup",
        source: "registry",
        error,
      })

      return noop
    }

    this.plugins.push({
      plugin,
      registrationOrder: this.registrationOrder++,
      cachedOrder: plugin.order ?? 0,
      cachedId: plugin.id,
    })

    this.invalidateSortedPluginsCache()
    this.notifyListeners()

    return () => {
      this.unregister(plugin.id)
    }
  }

  public unregister(id: string): boolean {
    const index = this.plugins.findIndex((entry) => entry.plugin.id === id)
    if (index === -1) {
      return false
    }

    const [entry] = this.plugins.splice(index, 1)

    this.invalidateSortedPluginsCache()

    try {
      entry?.plugin.dispose?.()
    } catch (error) {
      this.reportPluginError({
        pluginId: id,
        phase: "dispose",
        source: "registry",
        error,
      })
    }

    this.notifyListeners()

    return true
  }

  public updateOrder(id: string, order: number): boolean {
    const entry = this.plugins.find((pluginEntry) => pluginEntry.plugin.id === id)
    if (!entry) {
      return false
    }

    if ((entry.plugin.order ?? 0) === order) {
      return true
    }

    entry.plugin.order = order
    entry.cachedOrder = order
    this.invalidateSortedPluginsCache()
    this.notifyListeners()
    return true
  }

  public clear(): void {
    if (this.plugins.length === 0) {
      return
    }

    const plugins = [...this.plugins]
    this.plugins = []
    this.invalidateSortedPluginsCache()

    for (const entry of plugins) {
      try {
        entry.plugin.dispose?.()
      } catch (error) {
        this.reportPluginError({
          pluginId: entry.plugin.id,
          phase: "dispose",
          source: "registry",
          error,
        })
      }
    }

    this.notifyListeners()
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public onPluginError(listener: (event: PluginErrorEvent) => void): () => void {
    this.errorListeners.add(listener)
    return () => {
      this.errorListeners.delete(listener)
    }
  }

  public batch<T>(run: () => T): T {
    this.batchDepth += 1

    try {
      return run()
    } finally {
      this.batchDepth -= 1
      if (this.batchDepth === 0 && this.batchedNotify) {
        this.batchedNotify = false
        this.flushListeners()
      }
    }
  }

  public getPluginErrors(): readonly PluginErrorEvent[] {
    return this.pluginErrors
  }

  public clearPluginErrors(): void {
    this.pluginErrors = []
  }

  public reportPluginError(report: PluginErrorReport): PluginErrorEvent {
    const event: PluginErrorEvent = {
      pluginId: report.pluginId,
      slot: report.slot,
      phase: report.phase,
      source: report.source ?? "registry",
      error: normalizeError(report.error),
      timestamp: Date.now(),
    }

    this.pluginErrors.push(event)
    if (this.pluginErrors.length > this.options.maxPluginErrors) {
      this.pluginErrors.splice(0, this.pluginErrors.length - this.options.maxPluginErrors)
    }

    if (this.options.debugPluginErrors) {
      const slotLabel = event.slot ? ` slot="${event.slot}"` : ""
      console.debug(
        `[SlotRegistry][PluginError] plugin="${event.pluginId}" phase="${event.phase}" source="${event.source}"${slotLabel}`,
      )
      console.debug(event.error)
    }

    for (const listener of this.errorListeners) {
      try {
        listener(event)
      } catch (error) {
        console.error("Error in plugin error listener:", error)
      }
    }

    try {
      this.options.onPluginError?.(event)
    } catch (error) {
      console.error("Error in plugin error callback:", error)
    }

    return event
  }

  public resolve<K extends keyof TSlots>(slot: K): Array<SlotRenderer<TNode, TSlots[K], TContext>> {
    return this.resolveEntries(slot).map((entry) => entry.renderer)
  }

  public resolveEntries<K extends keyof TSlots>(slot: K): Array<ResolvedSlotRenderer<TNode, TSlots[K], TContext>> {
    const slotRenderers: Array<ResolvedSlotRenderer<TNode, TSlots[K], TContext>> = []

    for (const entry of this.getSortedPlugins()) {
      const renderer = entry.plugin.slots[slot]
      if (renderer) {
        slotRenderers.push({
          id: entry.plugin.id,
          renderer: renderer as SlotRenderer<TNode, TSlots[K], TContext>,
        })
      }
    }

    return slotRenderers
  }

  private getSortedPlugins(): RegisteredPlugin<TNode, TSlots, TContext>[] {
    this.syncPluginSortMetadata()

    if (this.sortedPluginsCache) {
      return this.sortedPluginsCache
    }

    this.sortedPluginsCache = [...this.plugins].sort((left, right) => {
      const leftOrder = left.cachedOrder
      const rightOrder = right.cachedOrder

      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder
      }

      if (left.registrationOrder !== right.registrationOrder) {
        return left.registrationOrder - right.registrationOrder
      }

      return left.cachedId.localeCompare(right.cachedId)
    })

    return this.sortedPluginsCache
  }

  private syncPluginSortMetadata(): void {
    let hasChanges = false

    for (const entry of this.plugins) {
      const nextOrder = entry.plugin.order ?? 0
      const nextId = entry.plugin.id

      if (entry.cachedOrder !== nextOrder || entry.cachedId !== nextId) {
        entry.cachedOrder = nextOrder
        entry.cachedId = nextId
        hasChanges = true
      }
    }

    if (hasChanges) {
      this.invalidateSortedPluginsCache()
    }
  }

  private invalidateSortedPluginsCache(): void {
    this.sortedPluginsCache = null
  }

  private notifyListeners(): void {
    if (this.batchDepth > 0) {
      this.batchedNotify = true
      return
    }

    this.flushListeners()
  }

  private flushListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error("Error in slot registry listener:", error)
      }
    }
  }
}

const slotRegistriesByRenderer = new WeakMap<CliRenderer, Map<string, SlotRegistry<any, any, any>>>()

function getSlotRegistryStore(renderer: CliRenderer): Map<string, SlotRegistry<any, any, any>> {
  const existingStore = slotRegistriesByRenderer.get(renderer)
  if (existingStore) {
    return existingStore
  }

  const createdStore = new Map<string, SlotRegistry<any, any, any>>()
  slotRegistriesByRenderer.set(renderer, createdStore)

  renderer.once("destroy", () => {
    for (const registry of createdStore.values()) {
      try {
        registry.clear()
      } catch (error) {
        console.error("Error disposing slot registry:", error)
      }
    }

    createdStore.clear()
    slotRegistriesByRenderer.delete(renderer)
  })

  return createdStore
}

export function createSlotRegistry<TNode, TSlots extends object, TContext extends PluginContext = PluginContext>(
  renderer: CliRenderer,
  key: string,
  context: TContext,
  options: SlotRegistryOptions = {},
): SlotRegistry<TNode, TSlots, TContext> {
  const store = getSlotRegistryStore(renderer)
  const existing = store.get(key)

  if (existing) {
    if (existing.context !== context) {
      throw new Error(
        `createSlotRegistry called with a different context for renderer key "${key}". Reuse the original context object.`,
      )
    }

    const typedExisting = existing as SlotRegistry<TNode, TSlots, TContext>
    typedExisting.configure(options)
    return typedExisting
  }

  const created = new SlotRegistry<TNode, TSlots, TContext>(renderer, context, options)
  store.set(key, created as SlotRegistry<any, any, any>)
  return created
}
