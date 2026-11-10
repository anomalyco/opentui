import { BaseRenderable, Renderable, type RenderableOptions } from "../Renderable.js"
import type { CliRenderer } from "../renderer.js"
import type { RenderContext } from "../types.js"
import { createSlotRegistry, SlotRegistry, type SlotRegistryOptions } from "./registry.js"
import type { Plugin, PluginContext, PluginErrorEvent, SlotMode } from "./types.js"

export type CoreSlotMode = SlotMode

type CoreSlotProps<TSlotName extends string, TData extends object> = {
  [K in TSlotName]: TData
}

export type CoreSlotRegistry<
  TSlotName extends string,
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> = SlotRegistry<BaseRenderable, CoreSlotProps<TSlotName, TData>, TContext>

export type CoreSlotRenderer<
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> = (ctx: Readonly<TContext>, data: TData) => BaseRenderable

export interface CoreManagedSlot<
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> {
  render: CoreSlotRenderer<TContext, TData>
  onActivate?: (ctx: Readonly<TContext>) => void
  onDeactivate?: (ctx: Readonly<TContext>) => void
  onDispose?: (ctx: Readonly<TContext>) => void
}

export type CoreSlotContribution<
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> = CoreSlotRenderer<TContext, TData> | CoreManagedSlot<TContext, TData>

export interface CorePlugin<
  TSlotName extends string,
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> {
  id: string
  order?: number
  setup?: (ctx: Readonly<TContext>, renderer: CliRenderer) => void
  dispose?: () => void
  slots: Partial<Record<TSlotName, CoreSlotContribution<TContext, TData>>>
}

export interface CoreResolvedSlotRenderer<
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> {
  id: string
  renderer: CoreSlotRenderer<TContext, TData>
}

type FallbackNodes = BaseRenderable | BaseRenderable[] | undefined

export type CoreSlotFailurePlaceholder<TContext extends PluginContext = PluginContext> = (
  failure: PluginErrorEvent,
  ctx: Readonly<TContext>,
) => FallbackNodes

type CoreSlotOwnership = "host" | "plugin"

type WrappedCoreSlotRenderer<
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> = ((ctx: Readonly<TContext>, props: TData) => BaseRenderable) & {
  __coreSlotOwnership?: CoreSlotOwnership
  __coreManagedSlot?: CoreManagedSlot<TContext, TData>
}

interface ResolvedCoreSlotEntry<
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> extends CoreResolvedSlotRenderer<TContext, TData> {
  ownership: CoreSlotOwnership
  managedSlot?: CoreManagedSlot<TContext, TData>
}

interface SlotNodeState<
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> {
  nodes: BaseRenderable[]
  ownership: CoreSlotOwnership
  managedSlot?: CoreManagedSlot<TContext, TData>
  dataRef: TData
}

function isCoreManagedSlot<
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
>(contribution: CoreSlotContribution<TContext, TData>): contribution is CoreManagedSlot<TContext, TData> {
  return typeof contribution === "object" && contribution !== null && "render" in contribution
}

function toCorePlugin<
  TSlotName extends string,
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
>(plugin: CorePlugin<TSlotName, TContext, TData>): Plugin<BaseRenderable, CoreSlotProps<TSlotName, TData>, TContext> {
  const slots: Partial<Record<TSlotName, WrappedCoreSlotRenderer<TContext, TData>>> = {}

  for (const [slotName, contribution] of Object.entries(plugin.slots) as Array<
    [TSlotName, CoreSlotContribution<TContext, TData>]
  >) {
    const wrappedRenderer: WrappedCoreSlotRenderer<TContext, TData> = (ctx: Readonly<TContext>, data: TData) => {
      if (isCoreManagedSlot(contribution)) {
        return contribution.render(ctx, data)
      }

      return contribution(ctx, data)
    }

    if (isCoreManagedSlot(contribution)) {
      wrappedRenderer.__coreSlotOwnership = "plugin"
      wrappedRenderer.__coreManagedSlot = contribution
    } else {
      wrappedRenderer.__coreSlotOwnership = "host"
    }

    slots[slotName] = wrappedRenderer
  }

  return {
    id: plugin.id,
    order: plugin.order,
    setup: plugin.setup,
    dispose: plugin.dispose,
    slots,
  }
}

function asArray(value: FallbackNodes): BaseRenderable[] {
  if (!value) {
    return []
  }

  return Array.isArray(value) ? [...value] : [value]
}

function ensureValidNode(node: unknown, pluginId: string, mount: BaseRenderable): asserts node is BaseRenderable {
  if (!node) {
    throw new Error(`Plugin "${pluginId}" did not return a renderable node`)
  }

  if (typeof (node as { then?: unknown }).then === "function") {
    throw new Error(`Plugin "${pluginId}" returned an async value. Core slots require synchronous renderers.`)
  }

  if (!(node instanceof BaseRenderable)) {
    throw new Error(`Plugin "${pluginId}" must return a BaseRenderable`)
  }

  if (node === mount) {
    throw new Error(`Plugin "${pluginId}" returned the slot mount container as its node`)
  }

  if (node.parent && node.parent !== mount) {
    throw new Error(`Plugin "${pluginId}" returned a renderable already attached to another parent`)
  }
}

export function createCoreSlotRegistry<
  TSlotName extends string,
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
>(
  renderer: CliRenderer,
  context: TContext,
  options: SlotRegistryOptions = {},
): CoreSlotRegistry<TSlotName, TContext, TData> {
  return createSlotRegistry<BaseRenderable, CoreSlotProps<TSlotName, TData>, TContext>(
    renderer,
    "core:slot-registry",
    context,
    options,
  )
}

export function registerCorePlugin<
  TSlotName extends string,
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
>(registry: CoreSlotRegistry<TSlotName, TContext, TData>, plugin: CorePlugin<TSlotName, TContext, TData>): () => void {
  return registry.register(toCorePlugin(plugin))
}

export function resolveCoreSlot<
  TSlotName extends string,
  K extends TSlotName,
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
>(registry: CoreSlotRegistry<TSlotName, TContext, TData>, slot: K): Array<CoreResolvedSlotRenderer<TContext, TData>> {
  return resolveCoreSlotEntries(registry, slot).map((entry) => {
    return {
      id: entry.id,
      renderer: entry.renderer,
    }
  })
}

function resolveCoreSlotEntries<
  TSlotName extends string,
  K extends TSlotName,
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
>(registry: CoreSlotRegistry<TSlotName, TContext, TData>, slot: K): Array<ResolvedCoreSlotEntry<TContext, TData>> {
  return registry.resolveEntries(slot).map((entry) => {
    const wrappedRenderer = entry.renderer as WrappedCoreSlotRenderer<TContext, TData>

    return {
      id: entry.id,
      renderer: (ctx: Readonly<TContext>, data: TData) => wrappedRenderer(ctx, data),
      ownership: wrappedRenderer.__coreSlotOwnership ?? "host",
      managedSlot: wrappedRenderer.__coreManagedSlot,
    }
  })
}

// -- SlotRenderable ---------------------------------------------------------

export interface SlotRenderableOptions<
  TSlotName extends string,
  K extends TSlotName,
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> extends RenderableOptions {
  registry: CoreSlotRegistry<TSlotName, TContext, TData>
  name: K
  data?: TData
  mode?: CoreSlotMode
  fallback?: FallbackNodes | (() => FallbackNodes)
  pluginFailurePlaceholder?: CoreSlotFailurePlaceholder<TContext>
}

export class SlotRenderable<
  TSlotName extends string = string,
  TContext extends PluginContext = PluginContext,
  TData extends object = Record<string, unknown>,
> extends Renderable {
  private _mode: CoreSlotMode
  private _slotRegistry: CoreSlotRegistry<TSlotName, TContext, TData>
  private _slotName: TSlotName
  private _data: TData
  private _fallbackOption: FallbackNodes | (() => FallbackNodes)
  private _pluginFailurePlaceholder?: CoreSlotFailurePlaceholder<TContext>
  private _disposed = false
  private _mountedNodes: BaseRenderable[] = []
  private _pluginNodes = new Map<string, SlotNodeState<TContext, TData>>()
  private _activePluginIds = new Set<string>()
  private _fallbackNodes: BaseRenderable[] | null = null
  private _unsubscribe: (() => void) | null = null

  constructor(ctx: RenderContext, options: SlotRenderableOptions<TSlotName, TSlotName, TContext, TData>) {
    super(ctx, options)

    this._slotRegistry = options.registry
    this._slotName = options.name
    this._data = options.data ?? ({} as TData)
    this._mode = options.mode ?? "append"
    this._fallbackOption = options.fallback
    this._pluginFailurePlaceholder = options.pluginFailurePlaceholder

    this._unsubscribe = this._slotRegistry.subscribe(() => this.refresh())

    try {
      this.refresh()
    } catch (error) {
      this._cleanupAll()
      throw error
    }
  }

  public get mode(): CoreSlotMode {
    return this._mode
  }

  public set mode(value: CoreSlotMode) {
    this._mode = value
    this.refresh()
  }

  public get data(): TData {
    return this._data
  }

  public set data(value: TData) {
    this._data = value
    this.refresh()
  }

  public refresh(): void {
    if (this._disposed) {
      return
    }

    const allEntries = resolveCoreSlotEntries(this._slotRegistry, this._slotName)
    const activeEntries = this._mode === "single_winner" && allEntries.length > 0 ? [allEntries[0]] : allEntries
    const nextActivePluginIds = new Set(activeEntries.map((entry) => entry.id))
    const registeredPluginIds = new Set(allEntries.map((entry) => entry.id))

    this._cleanupInactivePluginNodes(nextActivePluginIds, registeredPluginIds)

    for (const entry of activeEntries) {
      let state = this._pluginNodes.get(entry.id)
      const shouldRender =
        !state || (state.ownership === "plugin" && state.nodes.length === 0) || state.dataRef !== this._data

      if (shouldRender) {
        const previousState = state

        try {
          const node = entry.renderer(this._slotRegistry.context, this._data)
          ensureValidNode(node, entry.id, this)
          state = {
            nodes: [node],
            ownership: entry.ownership,
            managedSlot: entry.managedSlot ?? state?.managedSlot,
            dataRef: this._data,
          }
        } catch (error) {
          const failure = this._slotRegistry.reportPluginError({
            pluginId: entry.id,
            slot: String(this._slotName),
            phase: "render",
            source: "core",
            error,
          })

          state = {
            nodes: this._resolvePluginFailurePlaceholder(failure),
            ownership: "host",
            managedSlot: entry.managedSlot ?? state?.managedSlot,
            dataRef: this._data,
          }
        }

        if (previousState) {
          this._cleanupReplacedPluginNodes(previousState, state.nodes)
        }

        this._pluginNodes.set(entry.id, state)
      }

      if (!this._activePluginIds.has(entry.id)) {
        const activeState = this._pluginNodes.get(entry.id)
        if (activeState) {
          this._callManagedHook(entry.id, activeState.managedSlot, "onActivate", "setup")
        }
      }
    }

    const desiredNodes: BaseRenderable[] = []

    if (this._mode === "append" || activeEntries.length === 0) {
      desiredNodes.push(...this._ensureFallbackNodes())
    }

    for (const entry of activeEntries) {
      const state = this._pluginNodes.get(entry.id)
      if (state) {
        desiredNodes.push(...state.nodes)
      }
    }

    if (this._mode !== "append" && desiredNodes.length === 0) {
      desiredNodes.push(...this._ensureFallbackNodes())
    }

    this._reconcileMountedNodes(desiredNodes)
    this._activePluginIds = nextActivePluginIds
  }

  protected override destroySelf(): void {
    this._cleanupAll()
  }

  private _cleanupAll(): void {
    if (this._disposed) {
      return
    }
    this._disposed = true

    this._unsubscribe?.()
    this._unsubscribe = null

    for (const [pluginId, state] of this._pluginNodes) {
      if (this._activePluginIds.has(pluginId)) {
        this._callManagedHook(pluginId, state.managedSlot, "onDeactivate", "dispose")
      }

      this._callManagedHook(pluginId, state.managedSlot, "onDispose", "dispose")

      for (const node of state.nodes) {
        this._detachNodeFromMount(node)
      }

      if (state.ownership === "host") {
        for (const node of state.nodes) {
          node.destroyRecursively()
        }
      }
    }

    this._pluginNodes.clear()
    this._activePluginIds = new Set()

    if (this._fallbackNodes) {
      for (const node of this._fallbackNodes) {
        node.destroyRecursively()
      }
      this._fallbackNodes = null
    }

    this._mountedNodes = []
  }

  private _ensureFallbackNodes(): BaseRenderable[] {
    if (this._fallbackNodes !== null) {
      return this._fallbackNodes
    }

    const source = typeof this._fallbackOption === "function" ? this._fallbackOption() : this._fallbackOption
    const nodes = asArray(source)
    for (const node of nodes) {
      ensureValidNode(node, "fallback", this)
    }

    this._fallbackNodes = nodes
    return this._fallbackNodes
  }

  private _callManagedHook(
    pluginId: string,
    managedSlot: CoreManagedSlot<TContext, TData> | undefined,
    hook: "onActivate" | "onDeactivate" | "onDispose",
    phase: "setup" | "dispose",
  ): void {
    const callback = managedSlot?.[hook]
    if (!callback) {
      return
    }

    try {
      callback(this._slotRegistry.context)
    } catch (error) {
      this._slotRegistry.reportPluginError({
        pluginId,
        slot: String(this._slotName),
        phase,
        source: "core",
        error,
      })
    }
  }

  private _detachNodeFromMount(node: BaseRenderable): void {
    if (node.parent === this) {
      this.remove(node)
    }
  }

  private _cleanupInactivePluginNodes(nextActivePluginIds: Set<string>, registeredPluginIds: Set<string>): void {
    for (const [pluginId, state] of this._pluginNodes) {
      if (nextActivePluginIds.has(pluginId)) {
        continue
      }

      if (this._activePluginIds.has(pluginId)) {
        this._callManagedHook(pluginId, state.managedSlot, "onDeactivate", "dispose")
      }

      for (const node of state.nodes) {
        this._detachNodeFromMount(node)
      }

      if (!registeredPluginIds.has(pluginId)) {
        this._callManagedHook(pluginId, state.managedSlot, "onDispose", "dispose")

        if (state.ownership === "host") {
          for (const node of state.nodes) {
            node.destroyRecursively()
          }
        }

        this._pluginNodes.delete(pluginId)
        continue
      }

      if (state.ownership === "host") {
        for (const node of state.nodes) {
          node.destroyRecursively()
        }
        this._pluginNodes.delete(pluginId)
        continue
      }

      state.nodes = []
    }
  }

  private _cleanupReplacedPluginNodes(
    previousState: SlotNodeState<TContext, TData>,
    nextNodes: BaseRenderable[],
  ): void {
    const retainedNodes = new Set(nextNodes)

    for (const node of previousState.nodes) {
      if (retainedNodes.has(node)) {
        continue
      }

      this._detachNodeFromMount(node)

      if (previousState.ownership === "host") {
        node.destroyRecursively()
      }
    }
  }

  private _resolvePluginFailurePlaceholder(failure: PluginErrorEvent): BaseRenderable[] {
    if (!this._pluginFailurePlaceholder) {
      return []
    }

    try {
      const placeholderSource = this._pluginFailurePlaceholder(failure, this._slotRegistry.context)
      const placeholderNodes = asArray(placeholderSource)

      for (const node of placeholderNodes) {
        ensureValidNode(node, `${failure.pluginId}:error-placeholder`, this)
      }

      return placeholderNodes
    } catch (placeholderError) {
      this._slotRegistry.reportPluginError({
        pluginId: failure.pluginId,
        slot: String(this._slotName),
        phase: "error_placeholder",
        source: "core",
        error: placeholderError,
      })
      return []
    }
  }

  private _reconcileMountedNodes(desiredNodes: BaseRenderable[]): void {
    const desiredNodeSet = new Set(desiredNodes)

    for (const node of this._mountedNodes) {
      if (!desiredNodeSet.has(node)) {
        if (node.parent === this) {
          this.remove(node)
        }
      }
    }

    for (let index = 0; index < desiredNodes.length; index++) {
      const node = desiredNodes[index]

      if (node.parent !== this) {
        this.add(node, index)
        continue
      }

      const childAtIndex = this.getChildren()[index]
      if (childAtIndex !== node) {
        this.add(node, index)
      }
    }

    this._mountedNodes = [...desiredNodes]
  }
}
