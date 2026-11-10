import {
  createSlotRegistry,
  SlotRegistry,
  type CliRenderer,
  type Plugin,
  type PluginContext,
  type PluginErrorEvent,
  type ResolvedSlotRenderer,
  type SlotMode,
  type SlotRegistryOptions,
} from "@opentui/core"
import { children, createMemo, createSignal, ErrorBoundary, For, onCleanup, splitProps, type JSX } from "solid-js"

export type { SlotMode }
type SlotMap = Record<string, object>
const EMPTY_ENTRY_IDS: string[] = []

export type SolidPlugin<TSlots extends SlotMap, TContext extends PluginContext = PluginContext> = Plugin<
  JSX.Element,
  TSlots,
  TContext
>

export type SolidSlotProps<
  TSlots extends SlotMap,
  K extends keyof TSlots,
  TContext extends PluginContext = PluginContext,
> = {
  registry: SlotRegistry<JSX.Element, TSlots, TContext>
  name: K
  mode?: SlotMode
  children?: JSX.Element
  pluginFailurePlaceholder?: (failure: PluginErrorEvent) => JSX.Element
} & TSlots[K]

export type SolidBoundSlotProps<TSlots extends SlotMap, K extends keyof TSlots> = {
  name: K
  mode?: SlotMode
  children?: JSX.Element
} & TSlots[K]

export type SolidRegistrySlotComponent<TSlots extends SlotMap, TContext extends PluginContext = PluginContext> = <
  K extends keyof TSlots,
>(
  props: SolidSlotProps<TSlots, K, TContext>,
) => JSX.Element

export type SolidSlotComponent<TSlots extends SlotMap> = <K extends keyof TSlots>(
  props: SolidBoundSlotProps<TSlots, K>,
) => JSX.Element

export interface SolidSlotOptions {
  pluginFailurePlaceholder?: (failure: PluginErrorEvent) => JSX.Element
}

export function createSolidSlotRegistry<TSlots extends SlotMap, TContext extends PluginContext = PluginContext>(
  renderer: CliRenderer,
  context: TContext,
  options: SlotRegistryOptions = {},
): SlotRegistry<JSX.Element, TSlots, TContext> {
  // Solid slots intentionally use one registry key per renderer instance.
  // Use createSlotRegistry from @opentui/core with a custom key for independent registries.
  return createSlotRegistry<JSX.Element, TSlots, TContext>(renderer, "solid:slot-registry", context, options)
}

export function createSlot<TSlots extends SlotMap, TContext extends PluginContext = PluginContext>(
  registry: SlotRegistry<JSX.Element, TSlots, TContext>,
  options: SolidSlotOptions = {},
): SolidSlotComponent<TSlots> {
  return function BoundSlot<K extends keyof TSlots>(props: SolidBoundSlotProps<TSlots, K>): JSX.Element {
    return (
      <Slot<TSlots, TContext, K>
        {...(props as SolidBoundSlotProps<TSlots, K>)}
        registry={registry}
        pluginFailurePlaceholder={options.pluginFailurePlaceholder}
      />
    )
  }
}

export function Slot<
  TSlots extends SlotMap,
  TContext extends PluginContext = PluginContext,
  K extends keyof TSlots = keyof TSlots,
>(props: SolidSlotProps<TSlots, K, TContext>): JSX.Element {
  const [local, slotProps] = splitProps(props as SolidSlotProps<TSlots, K, TContext>, [
    "registry",
    "name",
    "mode",
    "children",
    "pluginFailurePlaceholder",
  ])
  const registry = () => local.registry
  const pluginFailurePlaceholder = () => local.pluginFailurePlaceholder
  const [version, setVersion] = createSignal(0)
  let queued = false
  let disposed = false

  const unsubscribe = registry().subscribe(() => {
    if (queued) return
    queued = true
    setVersion((current) => current + 1)
    queueMicrotask(() => {
      queued = false
      if (disposed) return
    })
  })
  onCleanup(() => {
    disposed = true
    unsubscribe()
  })

  const entries = createMemo<Array<ResolvedSlotRenderer<JSX.Element, TSlots[K], TContext>>>((previousEntries = []) => {
    version()
    const resolvedEntries = registry().resolveEntries(local.name as K) as Array<
      ResolvedSlotRenderer<JSX.Element, TSlots[K], TContext>
    >

    if (resolvedEntries.length === 0) {
      if (previousEntries.length === 0) return previousEntries
      return []
    }

    const previousById = new Map(previousEntries.map((entry) => [entry.id, entry]))
    const nextEntries = resolvedEntries.map((entry) => {
      const previousEntry = previousById.get(entry.id)
      if (previousEntry && previousEntry.renderer === entry.renderer) {
        return previousEntry
      }

      return entry
    })

    const unchanged =
      nextEntries.length === previousEntries.length &&
      nextEntries.every((entry, index) => entry === previousEntries[index])
    if (unchanged) return previousEntries

    return nextEntries
  })

  const entryIds = createMemo(() => entries().map((entry) => entry.id))
  const entriesById = createMemo(() => new Map(entries().map((entry) => [entry.id, entry])))

  const slotName = () => String(local.name)

  const renderFallback = (): JSX.Element => {
    const value = children(() => local.children)()
    return (value ?? null) as JSX.Element
  }

  const resolveFallback = (fallbackValue?: (() => JSX.Element) | undefined): JSX.Element => fallbackValue?.() ?? null

  const renderPluginFailurePlaceholder = (
    failure: PluginErrorEvent,
    fallbackValue?: (() => JSX.Element) | undefined,
  ): JSX.Element => {
    if (!pluginFailurePlaceholder()) {
      return resolveFallback(fallbackValue)
    }

    try {
      return pluginFailurePlaceholder()!(failure)
    } catch (error) {
      registry().reportPluginError({
        pluginId: failure.pluginId,
        slot: failure.slot ?? slotName(),
        phase: "error_placeholder",
        source: "solid",
        error,
      })

      return resolveFallback(fallbackValue)
    }
  }

  const renderEntry = (
    entry: ResolvedSlotRenderer<JSX.Element, TSlots[K], TContext>,
    fallbackOnError?: () => JSX.Element,
  ): JSX.Element => {
    let initialRender: JSX.Element

    try {
      initialRender = entry.renderer(registry().context, slotProps as TSlots[K])
    } catch (error) {
      const failure = registry().reportPluginError({
        pluginId: entry.id,
        slot: slotName(),
        phase: "render",
        source: "solid",
        error,
      })

      return renderPluginFailurePlaceholder(failure, fallbackOnError)
    }

    const resolvedInitialRender = children(() => initialRender)
    const hasInitialOutput = resolvedInitialRender
      .toArray()
      .some((node) => node !== null && node !== undefined && node !== false)

    if (!hasInitialOutput) {
      return resolveFallback(fallbackOnError)
    }

    return (
      <ErrorBoundary
        fallback={(error: unknown) => {
          const failure = registry().reportPluginError({
            pluginId: entry.id,
            slot: slotName(),
            phase: "render",
            source: "solid",
            error,
          })

          return renderPluginFailurePlaceholder(failure, fallbackOnError)
        }}
      >
        {resolvedInitialRender()}
      </ErrorBoundary>
    )
  }

  const AppendEntry = (appendProps: { entryId: string }): JSX.Element => {
    const entry = createMemo(() => entriesById().get(appendProps.entryId))

    return (
      <>
        {(() => {
          const resolvedEntry = entry()
          if (!resolvedEntry) {
            return null
          }

          return renderEntry(resolvedEntry)
        })()}
      </>
    )
  }

  const appendEntryIds = createMemo(() => {
    const mode = local.mode ?? "append"
    if (mode !== "append") {
      return EMPTY_ENTRY_IDS
    }

    return entryIds()
  })

  const appendView = (
    <>
      {renderFallback}
      <For each={appendEntryIds()}>{(entryId) => <AppendEntry entryId={entryId} />}</For>
    </>
  )

  return (
    <>
      {(() => {
        const resolvedEntries = entries()
        const mode = local.mode ?? "append"

        if (resolvedEntries.length === 0) {
          return renderFallback()
        }

        if (mode === "single_winner") {
          const winner = resolvedEntries[0]
          if (!winner) {
            return renderFallback()
          }

          return renderEntry(winner, renderFallback)
        }

        if (mode === "replace") {
          const renderedEntries = resolvedEntries.map((entry) => renderEntry(entry))
          const hasPluginOutput = renderedEntries.some(
            (entry) => entry !== null && entry !== undefined && entry !== false,
          )

          if (!hasPluginOutput) {
            return renderFallback()
          }

          return <>{renderedEntries}</>
        }

        return appendView
      })()}
    </>
  )
}
