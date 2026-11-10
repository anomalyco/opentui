import { RESERVED_COMMAND_FIELDS } from "../schema.js"
import type {
  ActiveBinding,
  Attributes,
  Command,
  CommandEntry,
  CommandBindingsQuery,
  CommandFieldCompiler,
  CommandResolutionStatus,
  CommandQuery,
  CommandQueryValue,
  CommandResolver,
  CommandResolverContext,
  BindingState,
  EventData,
  KeymapEvent,
  KeymapHost,
  CommandState,
  RuntimeMatcher,
} from "../types.js"
import { normalizeCommandName } from "./primitives/command-normalization.js"
import { getFocusedTargetIfAvailable, isLayerActiveForFocused } from "./primitives/active-layers.js"
import { getActiveCommandView as createActiveCommandView, getRegisteredCommandView } from "./runtime-view.js"
import type { ConditionService } from "./conditions.js"
import { createFieldCompilerContext } from "./primitives/field-invariants.js"
import type { NotificationService } from "./notify.js"
import type { ActiveCommandView, LayerCommandEntry, CommandView, ResolvedCommandEntry, State } from "./state.js"
import { createForwarder, getErrorMessage, isPlainData } from "./values.js"

const DEFAULT_COMMAND_SEARCH_FIELDS = ["name"] as const

const EMPTY_COMMAND_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})
const commandSearchCache = new WeakMap<CommandState<any, any>, Map<string, string | undefined>>()

interface NormalizeCommandsOptions<TTarget extends object, TEvent extends KeymapEvent> {
  commands: readonly Command<TTarget, TEvent>[]
  /** Hand out keymap-owned command objects; only for plain-data layers that `replaceLayer` registers. */
  owned: boolean
  commandFields: ReadonlyMap<string, CommandFieldCompiler>
  conditions: ConditionService<TTarget, TEvent>
  onError(code: string, error: unknown, message: string): void
}

interface QueryLayerCommandEntriesOptions<TTarget extends object, TEvent extends KeymapEvent> {
  entries: Iterable<LayerCommandEntry<TTarget, TEvent>>
  query?: CommandQuery<TTarget, TEvent>
  getCommand(command: CommandState<TTarget, TEvent>): Command<TTarget, TEvent>
  onFilterError(error: unknown): void
}

interface CommandQueryMatchOptions<TTarget extends object, TEvent extends KeymapEvent> {
  getCommand(command: CommandState<TTarget, TEvent>): Command<TTarget, TEvent>
  onFilterError(error: unknown): void
}

interface CommandCatalogOptions {
  onCommandResolversChanged(): void
}

interface ResolvedCommandLookup<TTarget extends object, TEvent extends KeymapEvent> {
  resolved?: ResolvedCommandEntry<TTarget, TEvent>
  hadError: boolean
}

interface CommandExecutionFields {
  input: string
  payload?: unknown
}

interface CommandResolverAttempt<TTarget extends object, TEvent extends KeymapEvent> {
  context: CommandResolverContext<TTarget, TEvent>
  getExecutionFields(): CommandExecutionFields
}

export interface CommandCatalogService<TTarget extends object, TEvent extends KeymapEvent> {
  normalizeCommands(commands: readonly Command<TTarget, TEvent>[], owned: boolean): CommandState<TTarget, TEvent>[]
  prependCommandResolver(resolver: CommandResolver<TTarget, TEvent>): () => void
  appendCommandResolver(resolver: CommandResolver<TTarget, TEvent>): () => void
  clearCommandResolvers(): void
  getCommands(query?: CommandQuery<TTarget, TEvent>): readonly Command<TTarget, TEvent>[]
  getCommandEntries(query?: CommandQuery<TTarget, TEvent>): readonly CommandEntry<TTarget, TEvent>[]
  getCommandBindings(
    query: CommandBindingsQuery<TTarget>,
  ): ReadonlyMap<string, readonly ActiveBinding<TTarget, TEvent>[]>
  getResolvedCommandChain(
    command: string,
    focused: TTarget | null,
    execution?: CommandExecutionFields,
  ): { entries?: readonly ResolvedCommandEntry<TTarget, TEvent>[]; hadError: boolean }
  getRegisteredResolvedEntries(command: string): readonly ResolvedCommandEntry<TTarget, TEvent>[] | undefined
  getActiveRegisteredResolvedEntries(
    command: string,
    focused: TTarget | null,
  ): readonly ResolvedCommandEntry<TTarget, TEvent>[] | undefined
  resolveRegisteredResolverFallback(
    command: string,
    execution?: CommandExecutionFields,
  ): ResolvedCommandLookup<TTarget, TEvent>
  resolveActiveResolverFallback(
    command: string,
    focused: TTarget | null,
    execution?: CommandExecutionFields,
  ): ResolvedCommandLookup<TTarget, TEvent>
  getTopCommand(command: string, focused: TTarget | null): Command<TTarget, TEvent> | undefined
  getDispatchUnavailableCommandState(
    command: string,
    focused: TTarget | null,
    includeCommand: boolean,
  ): { reason: "inactive" | "disabled"; command?: Command<TTarget, TEvent> } | undefined
  getActiveCommandView(focused: TTarget | null): ActiveCommandView<TTarget, TEvent>
  isBindingVisible(
    binding: BindingState<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): boolean
  getBindingCommandAttrs(
    binding: BindingState<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): Readonly<Attributes> | undefined
  getCommandResolutionStatus(
    command: string,
    layerCommands?: readonly CommandState<TTarget, TEvent>[],
  ): CommandResolutionStatus
}

export function createCommandCatalogService<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
  host: KeymapHost<TTarget, TEvent>,
  notify: NotificationService<TTarget, TEvent>,
  conditions: ConditionService<TTarget, TEvent>,
  options: CommandCatalogOptions,
): CommandCatalogService<TTarget, TEvent> {
  let registeredViewVersion = -1
  let registeredView: CommandView<TTarget, TEvent> | undefined
  let activeViewVersion = -1
  let activeViewFocused: TTarget | null | undefined
  let activeView: ActiveCommandView<TTarget, TEvent> | undefined
  let registeredBindingsCacheVersion = -1
  let registeredBindingsCacheCommands: readonly string[] | undefined
  let registeredBindingsCache: ReadonlyMap<string, readonly ActiveBinding<TTarget, TEvent>[]> | undefined
  let registeredBindingsByCommandVersion = -1
  let registeredBindingsByCommand: ReadonlyMap<string, readonly BindingState<TTarget, TEvent>[]> | undefined
  let registeredResolvedCacheVersion = -1
  let registeredResolvedCache = new Map<string, readonly ResolvedCommandEntry<TTarget, TEvent>[] | null>()

  const normalizeLayerCommands = (
    commands: readonly Command<TTarget, TEvent>[],
    owned: boolean,
  ): CommandState<TTarget, TEvent>[] => {
    return normalizeCommands({
      commands,
      owned,
      commandFields: state.commandFields,
      conditions: conditions,
      onError: (code, error, message) => {
        notify.emitError(code, error, message)
      },
    })
  }

  const prependCommandResolver = (resolver: CommandResolver<TTarget, TEvent>): (() => void) => {
    return mutateCommandResolvers(() => state.commandResolvers.prepend(resolver), resolver)
  }

  const appendCommandResolver = (resolver: CommandResolver<TTarget, TEvent>): (() => void) => {
    return mutateCommandResolvers(() => state.commandResolvers.append(resolver), resolver)
  }

  const clearCommandResolvers = (): void => {
    if (!state.commandResolvers.has()) {
      return
    }

    notify.runWithStateChangeBatch(() => {
      state.commandResolvers.clear()
      options.onCommandResolversChanged()
      notify.queueStateChange()
    })
  }

  const getCommands = (query?: CommandQuery<TTarget, TEvent>): readonly Command<TTarget, TEvent>[] => {
    return getFilteredCommandEntries(query).map((entry) => getCommand(entry.commandState))
  }

  const getCommandEntries = (query?: CommandQuery<TTarget, TEvent>): readonly CommandEntry<TTarget, TEvent>[] => {
    const context = getCommandQueryContext(query)
    const filteredEntries = getFilteredCommandEntries(query, context)
    if (filteredEntries.length === 0) {
      return []
    }

    const grouped = filteredEntries.map((entry) => ({
      entry,
      command: getCommand(entry.commandState),
      commandAttrs: entry.commandState.attrs,
      bindings: [] as ActiveBinding<TTarget, TEvent>[],
    }))
    const indexesByName = new Map<string, number[]>()

    for (const [index, item] of grouped.entries()) {
      const existing = indexesByName.get(item.command.name)
      if (existing) {
        existing.push(index)
      } else {
        indexesByName.set(item.command.name, [index])
      }
    }

    if (indexesByName.size > 0) {
      collectCommandEntryBindings(grouped, indexesByName, context)
    }

    return grouped.map((item) => ({
      command: item.command,
      bindings: item.bindings,
    }))
  }

  const getCommandBindings = (
    query: CommandBindingsQuery<TTarget>,
  ): ReadonlyMap<string, readonly ActiveBinding<TTarget, TEvent>[]> => {
    if (
      query.visibility === "registered" &&
      registeredBindingsCacheVersion === state.derivedVersion &&
      registeredBindingsCacheCommands === query.commands &&
      registeredBindingsCache
    ) {
      return registeredBindingsCache
    }

    const bindingsByCommand = new Map<string, ActiveBinding<TTarget, TEvent>[]>()
    for (const command of query.commands) {
      if (!bindingsByCommand.has(command)) {
        bindingsByCommand.set(command, [])
      }
    }

    if (bindingsByCommand.size === 0) {
      return bindingsByCommand
    }

    collectCommandBindings(bindingsByCommand, getCommandQueryContext(query))
    if (query.visibility === "registered") {
      registeredBindingsCacheVersion = state.derivedVersion
      registeredBindingsCacheCommands = query.commands
      registeredBindingsCache = bindingsByCommand
    }

    return bindingsByCommand
  }

  const getResolvedCommandChain = (
    command: string,
    focused: TTarget | null,
    execution?: CommandExecutionFields,
  ): { entries?: readonly ResolvedCommandEntry<TTarget, TEvent>[]; hadError: boolean } => {
    const view = getActiveCommandView(focused)
    if (execution) {
      const resolved: ResolvedCommandEntry<TTarget, TEvent>[] = []
      const chain = view.chainsByName.get(command)
      if (chain) {
        for (const entry of chain) {
          resolved.push({
            target: entry.layer.target,
            command: entry.commandState.command,
            attrs: entry.commandState.attrs,
            payload: execution.payload,
          })
        }
      }

      const fallback = resolveCommandWithResolversForMode(command, focused, { mode: "active", execution })
      if (fallback.resolved) {
        resolved.push(fallback.resolved)
      }

      return { entries: resolved.length > 0 ? resolved : undefined, hadError: fallback.hadError }
    }

    const resolved: ResolvedCommandEntry<TTarget, TEvent>[] = []
    for (const entry of view.chainsByName.get(command) ?? []) {
      resolved.push({
        target: entry.layer.target,
        command: entry.commandState.command,
        attrs: entry.commandState.attrs,
      })
    }

    const fallback = resolveCommandWithResolversForMode(command, focused, { mode: "active" })
    if (fallback.resolved) {
      resolved.push(fallback.resolved)
    }

    return { entries: resolved.length > 0 ? resolved : undefined, hadError: fallback.hadError }
  }

  const getRegisteredResolvedEntries = (
    command: string,
  ): readonly ResolvedCommandEntry<TTarget, TEvent>[] | undefined => {
    if (registeredResolvedCacheVersion !== state.derivedVersion) {
      registeredResolvedCacheVersion = state.derivedVersion
      registeredResolvedCache = new Map<string, readonly ResolvedCommandEntry<TTarget, TEvent>[] | null>()
    }

    if (registeredResolvedCache.has(command)) {
      return registeredResolvedCache.get(command) ?? undefined
    }

    const resolved = resolveRegisteredEntries(getRegisteredCommandChain(command))
    registeredResolvedCache.set(command, resolved ?? null)
    return resolved
  }

  const getActiveRegisteredResolvedEntries = (
    command: string,
    focused: TTarget | null,
  ): readonly ResolvedCommandEntry<TTarget, TEvent>[] | undefined => {
    return resolveRegisteredEntries(getActiveCommandView(focused).chainsByName.get(command))
  }

  const resolveRegisteredResolverFallback = (
    command: string,
    execution?: CommandExecutionFields,
  ): ResolvedCommandLookup<TTarget, TEvent> => {
    return resolveCommandWithResolversForMode(command, null, { mode: "registered", execution })
  }

  const resolveActiveResolverFallback = (
    command: string,
    focused: TTarget | null,
    execution?: CommandExecutionFields,
  ): ResolvedCommandLookup<TTarget, TEvent> => {
    return resolveCommandWithResolversForMode(command, focused, { mode: "active", execution })
  }

  const getTopCommand = (command: string, focused: TTarget | null): Command<TTarget, TEvent> | undefined => {
    const top = getTopResolvedCommand(command, focused)
    return top?.command
  }

  const getCommandByName = (command: string): Command<TTarget, TEvent> | undefined => {
    const top = getCommandEntry(command)
    return top?.commandState.command
  }

  const getDispatchUnavailableCommandState = (
    command: string,
    focused: TTarget | null,
    includeCommand: boolean,
  ): { reason: "inactive" | "disabled"; command?: Command<TTarget, TEvent> } | undefined => {
    const view = getCommandView()
    const chain = view.chainsByName.get(command)
    if (!chain || chain.length === 0) {
      return undefined
    }

    let inactiveEntry: LayerCommandEntry<TTarget, TEvent> | undefined
    let disabledEntry: LayerCommandEntry<TTarget, TEvent> | undefined

    for (const entry of chain) {
      if (!isLayerActiveForFocused(host, entry.layer, focused)) {
        inactiveEntry ??= entry
        continue
      }

      if (!conditions.matchesConditions(entry.layer) || !conditions.matchesConditions(entry.commandState)) {
        disabledEntry ??= entry
      }
    }

    const unavailableEntry = disabledEntry ?? inactiveEntry
    if (!unavailableEntry) {
      return undefined
    }

    return {
      reason: disabledEntry ? "disabled" : "inactive",
      command: includeCommand ? unavailableEntry.commandState.command : undefined,
    }
  }

  const getActiveCommandView = (focused: TTarget | null): ActiveCommandView<TTarget, TEvent> => {
    if (activeViewVersion === state.derivedVersion && activeViewFocused === focused && activeView) {
      return activeView
    }

    const view = createActiveCommandView(state, host, conditions, focused)
    if (activeCommandViewCanCache()) {
      activeViewVersion = state.derivedVersion
      activeViewFocused = focused
      activeView = view
    }

    return view
  }

  const getCommandView = (): CommandView<TTarget, TEvent> => {
    if (registeredViewVersion === state.derivedVersion && registeredView) {
      return registeredView
    }

    registeredViewVersion = state.derivedVersion
    registeredView = getRegisteredCommandView(state)
    return registeredView
  }

  const activeCommandViewCanCache = (): boolean => {
    return state.activeCommandViewCacheBlockers === 0
  }

  const isBindingVisible = (
    binding: BindingState<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): boolean => {
    if (binding.command === undefined || binding.run) {
      return true
    }

    if (typeof binding.command !== "string") {
      return false
    }

    if (activeView.reachableByName.has(binding.command)) {
      return true
    }

    return getFallbackResolvedCommand(binding.command, focused, "active") !== undefined
  }

  const getBindingCommandAttrs = (
    binding: BindingState<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): Readonly<Attributes> | undefined => {
    if (typeof binding.command !== "string") {
      return undefined
    }

    const active = activeView.reachableByName.get(binding.command)
    if (active) {
      return active.commandState.attrs
    }

    const fallback = getFallbackResolvedCommand(binding.command, focused, "active")
    return fallback?.attrs
  }

  const getCommandResolutionStatus = (
    command: string,
    layerCommands?: readonly CommandState<TTarget, TEvent>[],
  ): CommandResolutionStatus => {
    if (layerCommands?.some((state) => state.command.name === command) || getCommandView().chainsByName.has(command)) {
      return "resolved"
    }

    const lookup = resolveCommandWithResolversForMode(command, getFocusedTargetIfAvailable(host))
    if (lookup.resolved || lookup.hadError) {
      return lookup.resolved ? "resolved" : "error"
    }

    return "unresolved"
  }

  const mutateCommandResolvers = (
    register: () => () => void,
    resolver: CommandResolver<TTarget, TEvent>,
  ): (() => void) => {
    return notify.runWithStateChangeBatch(() => {
      const off = register()
      options.onCommandResolversChanged()
      notify.queueStateChange()

      return () => {
        notify.runWithStateChangeBatch(() => {
          off()
          if (state.commandResolvers.values().includes(resolver)) {
            return
          }

          options.onCommandResolversChanged()
          notify.queueStateChange()
        })
      }
    })
  }

  const getTopResolvedCommand = (
    command: string,
    focused: TTarget | null,
  ): ResolvedCommandEntry<TTarget, TEvent> | undefined => {
    const activeView = getActiveCommandView(focused)
    const active = activeView.reachableByName.get(command)
    if (active) {
      return {
        target: active.layer.target,
        command: active.commandState.command,
        attrs: active.commandState.attrs,
      }
    }

    return getFallbackResolvedCommand(command, focused, "active")
  }

  const getCommandEntry = (command: string): LayerCommandEntry<TTarget, TEvent> | undefined => {
    return getRegisteredCommandChain(command)?.[0]
  }

  const getRegisteredCommandChain = (command: string): readonly LayerCommandEntry<TTarget, TEvent>[] | undefined => {
    const entries: LayerCommandEntry<TTarget, TEvent>[] = []
    for (const layer of state.sortedLayers) {
      for (const commandState of layer.commands) {
        if (commandState.command.name === command) {
          entries.push({ layer, commandState })
        }
      }
    }

    return entries.length > 0 ? entries : undefined
  }

  const resolveRegisteredEntries = (
    chain: readonly LayerCommandEntry<TTarget, TEvent>[] | undefined,
  ): readonly ResolvedCommandEntry<TTarget, TEvent>[] | undefined => {
    if (!chain?.length) {
      return undefined
    }

    return chain.map((entry) => ({
      target: entry.layer.target,
      command: entry.commandState.command,
      attrs: entry.commandState.attrs,
    }))
  }

  const getFallbackResolvedCommand = (
    command: string,
    focused: TTarget | null,
    mode: "active" | "registered",
  ): ResolvedCommandEntry<TTarget, TEvent> | undefined => {
    const lookup = resolveCommandWithResolversForMode(command, focused, { mode })
    return lookup.resolved
  }

  const getRegisteredLayerCommandEntries = (): readonly LayerCommandEntry<TTarget, TEvent>[] => {
    return getCommandView().entries
  }

  const getRegisteredBindingsByCommand = (): ReadonlyMap<string, readonly BindingState<TTarget, TEvent>[]> => {
    if (registeredBindingsByCommandVersion === state.derivedVersion && registeredBindingsByCommand) {
      return registeredBindingsByCommand
    }

    const bindingsByCommand = new Map<string, BindingState<TTarget, TEvent>[]>()
    for (const layer of state.layers) {
      for (const binding of layer.bindings) {
        if (typeof binding.command !== "string") {
          continue
        }

        const bindings = bindingsByCommand.get(binding.command)
        if (bindings) {
          bindings.push(binding)
        } else {
          bindingsByCommand.set(binding.command, [binding])
        }
      }
    }

    registeredBindingsByCommandVersion = state.derivedVersion
    registeredBindingsByCommand = bindingsByCommand
    return bindingsByCommand
  }

  const getCommandQueryContext = (
    query?: CommandQuery<TTarget, TEvent>,
  ): {
    visibility: "reachable" | "active" | "registered"
    focused: TTarget | null
    activeView?: ActiveCommandView<TTarget, TEvent>
  } => {
    const visibility = query?.visibility ?? "reachable"
    const focused =
      query && Object.prototype.hasOwnProperty.call(query, "focused")
        ? (query.focused ?? null)
        : getFocusedTargetIfAvailable(host)

    if (visibility === "registered") {
      return { visibility, focused }
    }

    return {
      visibility,
      focused,
      activeView: getActiveCommandView(focused),
    }
  }

  const getFilteredCommandEntries = (
    query?: CommandQuery<TTarget, TEvent>,
    context: {
      visibility: "reachable" | "active" | "registered"
      focused: TTarget | null
      activeView?: ActiveCommandView<TTarget, TEvent>
    } = getCommandQueryContext(query),
  ): LayerCommandEntry<TTarget, TEvent>[] => {
    let entries: readonly LayerCommandEntry<TTarget, TEvent>[]
    if (context.visibility === "registered") {
      entries = getRegisteredLayerCommandEntries()
    } else if (context.visibility === "active") {
      entries = context.activeView?.entries ?? []
    } else {
      entries = context.activeView?.reachable ?? []
    }

    return queryLayerCommandEntries({
      entries,
      query,
      getCommand: (command) => getCommand(command),
      onFilterError: (error) => {
        notify.emitError("command-query-filter-error", error, "[Keymap] Error in command query filter:")
      },
    })
  }

  const collectCommandEntryBindings = (
    grouped: Array<{
      entry: LayerCommandEntry<TTarget, TEvent>
      command: Command<TTarget, TEvent>
      commandAttrs: Readonly<Attributes> | undefined
      bindings: ActiveBinding<TTarget, TEvent>[]
    }>,
    indexesByName: ReadonlyMap<string, readonly number[]>,
    context: {
      visibility: "reachable" | "active" | "registered"
      focused: TTarget | null
      activeView?: ActiveCommandView<TTarget, TEvent>
    },
  ): void => {
    visitCommandQueryBindings(context, (binding) => {
      collectBindingForCommandEntries(grouped, indexesByName, binding)
    })
  }

  const collectCommandBindings = (
    bindingsByCommand: Map<string, ActiveBinding<TTarget, TEvent>[]>,
    context: {
      visibility: "reachable" | "active" | "registered"
      focused: TTarget | null
      activeView?: ActiveCommandView<TTarget, TEvent>
    },
  ): void => {
    if (context.visibility === "registered") {
      const registeredBindings = getRegisteredBindingsByCommand()
      for (const [command, bindings] of bindingsByCommand) {
        const commandAttrs = getCommandView().chainsByName.get(command)?.[0]?.commandState.attrs
        for (const binding of registeredBindings.get(command) ?? []) {
          bindings.push(createActiveBinding(binding, commandAttrs))
        }
      }
      return
    }

    visitCommandQueryBindings(context, (binding) => {
      collectBindingForCommandBindings(bindingsByCommand, binding, context)
    })
  }

  const visitCommandQueryBindings = (
    context: {
      visibility: "reachable" | "active" | "registered"
      focused: TTarget | null
      activeView?: ActiveCommandView<TTarget, TEvent>
    },
    visit: (binding: BindingState<TTarget, TEvent>) => void,
  ): void => {
    if (context.visibility === "registered") {
      for (const layer of state.layers) {
        for (const binding of layer.bindings) visit(binding)
      }
      return
    }

    const activeView = context.activeView
    if (!activeView) {
      return
    }

    for (const layer of activeView.layers) {
      if (layer.bindings.length === 0 || !conditions.matchesConditions(layer)) {
        continue
      }

      for (const binding of layer.bindings) {
        if (conditions.matchesConditions(binding) && isBindingVisible(binding, context.focused, activeView)) {
          visit(binding)
        }
      }
    }
  }

  const collectBindingForCommandEntries = (
    grouped: Array<{
      entry: LayerCommandEntry<TTarget, TEvent>
      command: Command<TTarget, TEvent>
      commandAttrs: Readonly<Attributes> | undefined
      bindings: ActiveBinding<TTarget, TEvent>[]
    }>,
    indexesByName: ReadonlyMap<string, readonly number[]>,
    binding: BindingState<TTarget, TEvent>,
  ): void => {
    if (typeof binding.command !== "string") {
      return
    }

    const indexes = indexesByName.get(binding.command)
    if (!indexes || indexes.length === 0) {
      return
    }

    for (const index of indexes) {
      const item = grouped[index]
      if (!item) {
        continue
      }

      item.bindings.push(createActiveBinding(binding, item.commandAttrs))
    }
  }

  const collectBindingForCommandBindings = (
    bindingsByCommand: Map<string, ActiveBinding<TTarget, TEvent>[]>,
    binding: BindingState<TTarget, TEvent>,
    context: {
      visibility: "reachable" | "active" | "registered"
      focused: TTarget | null
      activeView?: ActiveCommandView<TTarget, TEvent>
    },
  ): void => {
    if (typeof binding.command !== "string") {
      return
    }

    const bindings = bindingsByCommand.get(binding.command)
    if (!bindings) {
      return
    }

    bindings.push(createActiveBinding(binding, getCommandBindingAttrsForQuery(binding, context)))
  }

  const createActiveBinding = (
    binding: BindingState<TTarget, TEvent>,
    commandAttrs: Readonly<Attributes> | undefined,
  ): ActiveBinding<TTarget, TEvent> => {
    return {
      sequence: binding.sequence,
      command: binding.command,
      commandAttrs,
      attrs: binding.attrs,
      event: binding.event,
      preventDefault: binding.preventDefault,
      fallthrough: binding.fallthrough,
    }
  }

  const getCommandBindingAttrsForQuery = (
    binding: BindingState<TTarget, TEvent>,
    context: {
      visibility: "reachable" | "active" | "registered"
      focused: TTarget | null
      activeView?: ActiveCommandView<TTarget, TEvent>
    },
  ): Readonly<Attributes> | undefined => {
    if (typeof binding.command !== "string") {
      return undefined
    }

    if (context.visibility === "registered") {
      return getCommandView().chainsByName.get(binding.command)?.[0]?.commandState.attrs
    }

    const activeView = context.activeView
    if (!activeView) {
      return undefined
    }

    return getBindingCommandAttrs(binding, context.focused, activeView)
  }

  const resolveCommandWithResolversForMode = (
    command: string,
    focused: TTarget | null,
    options?: { mode?: "active" | "registered"; execution?: CommandExecutionFields },
  ): ResolvedCommandLookup<TTarget, TEvent> => {
    const mode = options?.mode ?? "active"
    const execution = options?.execution ?? { input: command }

    const lookup = resolveCommandWithResolvers(
      command,
      state.commandResolvers.values(),
      () => createCommandResolverContext(focused, mode, execution),
      (error) => {
        notify.emitError("command-resolver-error", error, `[Keymap] Error in command resolver for "${command}":`)
      },
    )
    let resolved = lookup.resolved
    if (resolved) {
      const entry = getCommandEntryForMode(resolved.command.name, focused, mode)
      if (entry?.commandState.command === resolved.command && resolved.target === undefined) {
        resolved = { ...resolved, target: entry.layer.target }
        lookup.resolved = resolved
      }
    }

    if (resolved && !resolved.attrs) {
      const attrs =
        getCommandStateAttrs(resolved.command.name, focused, mode) ?? getResolverCommandAttrs(resolved.command)
      if (attrs) {
        lookup.resolved = { ...resolved, attrs }
      }
    }

    return lookup
  }

  const getCommandStateAttrs = (
    command: string,
    focused: TTarget | null,
    mode: "active" | "registered",
  ): Readonly<Attributes> | undefined => {
    if (mode === "registered") {
      return getCommandEntry(command)?.commandState.attrs
    }

    return getActiveCommandView(focused).reachableByName.get(command)?.commandState.attrs
  }

  const getCommandEntryForMode = (
    command: string,
    focused: TTarget | null,
    mode: "active" | "registered",
  ): LayerCommandEntry<TTarget, TEvent> | undefined => {
    if (mode === "registered") {
      return getCommandEntry(command)
    }

    return getActiveCommandView(focused).reachableByName.get(command)
  }

  const createCommandResolverContext = (
    focused: TTarget | null,
    mode: "active" | "registered",
    execution: CommandExecutionFields,
  ): CommandResolverAttempt<TTarget, TEvent> => {
    let input = execution.input
    let payload = execution.payload

    return {
      context: {
        get input() {
          return input
        },
        get payload() {
          return payload
        },
        setInput(nextInput) {
          input = nextInput
        },
        setPayload(nextPayload) {
          payload = nextPayload
        },
        getCommand: (name: string) => {
          if (mode === "registered") {
            return getCommandByName(name)
          }

          return getTopCommand(name, focused)
        },
      },
      getExecutionFields() {
        return { input, payload }
      },
    }
  }

  return {
    normalizeCommands: normalizeLayerCommands,
    prependCommandResolver,
    appendCommandResolver,
    clearCommandResolvers,
    getCommands,
    getCommandEntries,
    getCommandBindings,
    getResolvedCommandChain,
    getRegisteredResolvedEntries,
    getActiveRegisteredResolvedEntries,
    resolveRegisteredResolverFallback,
    resolveActiveResolverFallback,
    getTopCommand,
    getDispatchUnavailableCommandState,
    getActiveCommandView,
    isBindingVisible,
    getBindingCommandAttrs,
    getCommandResolutionStatus,
  }
}

export function getCommand<TTarget extends object, TEvent extends KeymapEvent>(
  state: CommandState<TTarget, TEvent>,
): Command<TTarget, TEvent> {
  return state.command
}

// Hands out a keymap-owned copy of a plain command whose methods are forwarders, so a layer re-registered
// with fresh functions keeps the command objects that callers already hold.
function ownCommand<TTarget extends object, TEvent extends KeymapEvent>(
  command: Command<TTarget, TEvent>,
  name: string,
): Command<TTarget, TEvent> {
  const own: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(command)) {
    own[key] = typeof value === "function" ? createForwarder(value) : value
  }
  own.name = name
  return own as unknown as Command<TTarget, TEvent>
}

function normalizeCommands<TTarget extends object, TEvent extends KeymapEvent>(
  options: NormalizeCommandsOptions<TTarget, TEvent>,
): CommandState<TTarget, TEvent>[] {
  const normalizedCommands: CommandState<TTarget, TEvent>[] = []
  const seen = new Set<string>()

  for (const command of options.commands) {
    try {
      const mergedRequires: EventData = {}
      const matchers: RuntimeMatcher[] = []
      const normalizedName = normalizeCommandName(command.name)
      const fields = getCommandFields(command)
      const attrs: Attributes = {}

      if (seen.has(normalizedName)) {
        options.onError(
          "duplicate-command",
          { command: normalizedName },
          `Duplicate keymap command "${normalizedName}" in the same layer`,
        )
        continue
      }

      // A compiled command that is not plain data (a transformer can make one) is handed out as it is.
      const owned = options.owned && isPlainData(command)
      if (!owned) command.name = normalizedName
      const exposed = owned ? ownCommand(command, normalizedName) : command

      for (const [fieldName, value] of Object.entries(fields)) {
        if (value === undefined) {
          continue
        }

        const compiler = options.commandFields.get(fieldName)
        if (!compiler) {
          continue
        }

        compiler(
          value,
          createFieldCompilerContext({
            fieldName,
            conditions: options.conditions,
            requirements: mergedRequires,
            matchers,
            attrs,
          }),
        )
      }

      const commandState: CommandState<TTarget, TEvent> = {
        command: exposed,
        // Field compilers read the registered values; queries read the exposed command's.
        fields: owned ? getCommandFields(exposed) : fields,
        attrs: Object.keys(attrs).length === 0 ? undefined : attrs,
        requires: Object.entries(mergedRequires),
        matchers,
      }

      seen.add(commandState.command.name)
      normalizedCommands.push(commandState)
    } catch (error) {
      options.onError(
        "register-command-failed",
        error,
        getErrorMessage(error, `Failed to register keymap command "${String(command.name)}"`),
      )
      continue
    }
  }

  return normalizedCommands
}

function resolveCommandWithResolvers<TTarget extends object, TEvent extends KeymapEvent>(
  command: string,
  resolvers: readonly CommandResolver<TTarget, TEvent>[],
  createContext: () => CommandResolverAttempt<TTarget, TEvent>,
  onResolverError: (error: unknown) => void,
): ResolvedCommandLookup<TTarget, TEvent> {
  if (resolvers.length === 0) {
    return { hadError: false }
  }

  let hadError = false

  for (const resolver of resolvers) {
    let resolvedCommand: Command<TTarget, TEvent> | undefined
    const attempt = createContext()

    try {
      resolvedCommand = resolver(command, attempt.context)
    } catch (error) {
      hadError = true
      onResolverError(error)
      continue
    }

    if (resolvedCommand) {
      return { hadError, resolved: getResolverCommandEntry(resolvedCommand, attempt.getExecutionFields()) }
    }
  }

  return { hadError }
}

function isCommandMetadataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getCommandFields<TTarget extends object, TEvent extends KeymapEvent>(
  command: Command<TTarget, TEvent>,
): Readonly<Record<string, unknown>> {
  const fields: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(command)) {
    if (!RESERVED_COMMAND_FIELDS.has(name) && value !== undefined) {
      fields[name] = value
    }
  }

  return Object.keys(fields).length === 0 ? EMPTY_COMMAND_FIELDS : fields
}

function getResolverCommandEntry<TTarget extends object, TEvent extends KeymapEvent>(
  command: Command<TTarget, TEvent>,
  execution: CommandExecutionFields,
): ResolvedCommandEntry<TTarget, TEvent> {
  return {
    command,
    input: execution.input,
    payload: execution.payload,
  }
}

function getResolverCommandAttrs<TTarget extends object, TEvent extends KeymapEvent>(
  command: Command<TTarget, TEvent>,
): Readonly<Attributes> | undefined {
  const fields = getCommandFields(command)
  return fields === EMPTY_COMMAND_FIELDS ? undefined : fields
}

function queryLayerCommandEntries<TTarget extends object, TEvent extends KeymapEvent>(
  options: QueryLayerCommandEntriesOptions<TTarget, TEvent>,
): LayerCommandEntry<TTarget, TEvent>[] {
  const namespace = options.query?.namespace
  const limit = normalizeQueryLimit(options.query?.limit)
  if (limit === 0) {
    return []
  }

  const normalizedSearch = options.query?.search?.trim().toLowerCase() ?? ""
  let searchKeys = DEFAULT_COMMAND_SEARCH_FIELDS as readonly string[]
  if (options.query?.searchIn && options.query.searchIn.length > 0) {
    searchKeys = options.query.searchIn
  }

  const filter = options.query?.filter
  let filterEntries: readonly [string, CommandQueryValue<TTarget, TEvent>][] | undefined
  let filterPredicate: ((command: Command<TTarget, TEvent>) => boolean) | undefined
  let exactNameFilter: ReadonlySet<string> | undefined

  if (typeof filter === "function") {
    filterPredicate = filter
  } else if (filter) {
    const entries = Object.entries(filter)
    const remainingEntries: [string, CommandQueryValue<TTarget, TEvent>][] = []
    for (const [key, matcher] of entries) {
      if (key === "name") {
        if (typeof matcher === "string") {
          exactNameFilter = new Set([matcher])
          continue
        }

        if (Array.isArray(matcher)) {
          const names = new Set<string>()
          for (const value of matcher) {
            if (typeof value === "string") {
              names.add(value)
            }
          }
          exactNameFilter = names
          continue
        }
      }

      remainingEntries.push([key, matcher])
    }
    filterEntries = remainingEntries.length > 0 ? remainingEntries : undefined
  }

  const results: LayerCommandEntry<TTarget, TEvent>[] = []
  for (const entry of options.entries) {
    const commandState = entry.commandState

    if (!commandMatchesNamespace(commandState, namespace)) {
      continue
    }

    if (!commandMatchesSearch(commandState, normalizedSearch, searchKeys)) {
      continue
    }

    if (exactNameFilter && !exactNameFilter.has(commandState.command.name)) {
      continue
    }

    if (!commandMatchesFilters(commandState, filterEntries, options)) {
      continue
    }

    if (filterPredicate) {
      let matches = false

      try {
        matches = filterPredicate(options.getCommand(commandState))
      } catch (error) {
        options.onFilterError(error)
        continue
      }

      if (!matches) {
        continue
      }
    }

    results.push(entry)
    if (limit !== undefined && results.length >= limit) {
      break
    }
  }

  return results
}

function normalizeQueryLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const limit = Math.floor(Number(value))
  if (!Number.isFinite(limit) || limit <= 0) {
    return 0
  }

  return limit
}

function commandMatchesSearch<TTarget extends object, TEvent extends KeymapEvent>(
  commandState: CommandState<TTarget, TEvent>,
  search: string,
  searchKeys: readonly string[],
): boolean {
  if (!search) {
    return true
  }

  for (const key of searchKeys) {
    if (commandKeyMatchesSearch(commandState, key, search)) {
      return true
    }
  }

  return false
}

function commandMatchesNamespace<TTarget extends object, TEvent extends KeymapEvent>(
  commandState: CommandState<TTarget, TEvent>,
  namespace: string | readonly string[] | undefined,
): boolean {
  if (namespace === undefined) {
    return true
  }

  const fields = commandState.fields
  if (!Object.prototype.hasOwnProperty.call(fields, "namespace")) {
    return false
  }

  return valueMatchesFilter(fields.namespace, namespace)
}

function commandMatchesFilters<TTarget extends object, TEvent extends KeymapEvent>(
  commandState: CommandState<TTarget, TEvent>,
  filters: readonly [string, CommandQueryValue<TTarget, TEvent>][] | undefined,
  options: CommandQueryMatchOptions<TTarget, TEvent>,
): boolean {
  if (!filters) {
    return true
  }

  for (const [key, matcher] of filters) {
    if (!commandKeyMatchesQuery(commandState, key, matcher, options)) {
      return false
    }
  }

  return true
}

function commandKeyMatchesSearch<TTarget extends object, TEvent extends KeymapEvent>(
  commandState: CommandState<TTarget, TEvent>,
  key: string,
  search: string,
): boolean {
  return getCommandSearchText(commandState, key)?.includes(search) === true
}

function getCommandSearchText<TTarget extends object, TEvent extends KeymapEvent>(
  commandState: CommandState<TTarget, TEvent>,
  key: string,
): string | undefined {
  let cache = commandSearchCache.get(commandState)
  if (!cache) {
    cache = new Map<string, string | undefined>()
    commandSearchCache.set(commandState, cache)
  }

  if (cache.has(key)) {
    return cache.get(key)
  }

  const fields = commandState.fields
  const attrs = commandState.attrs
  let value: unknown
  if (key === "name") {
    value = commandState.command.name
  } else if (Object.prototype.hasOwnProperty.call(fields, key)) {
    value = fields[key]
  } else if (attrs && Object.prototype.hasOwnProperty.call(attrs, key)) {
    value = attrs[key]
  }

  const text = toSearchText(value)
  cache.set(key, text)
  return text
}

function toSearchText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const entry of value) {
      const text = toSearchText(entry)
      if (text !== undefined) {
        parts.push(text)
      }
    }

    return parts.length > 0 ? parts.join("\0") : undefined
  }

  if (typeof value === "string") {
    return value.toLowerCase()
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).toLowerCase()
  }

  return undefined
}

function runCommandQueryPredicate<TTarget extends object, TEvent extends KeymapEvent>(
  matcher: (value: unknown, command: Command<TTarget, TEvent>) => boolean,
  value: unknown,
  command: Command<TTarget, TEvent>,
  onFilterError: (error: unknown) => void,
): boolean {
  try {
    return matcher(value, command)
  } catch (error) {
    onFilterError(error)
    return false
  }
}

function commandKeyMatchesQuery<TTarget extends object, TEvent extends KeymapEvent>(
  commandState: CommandState<TTarget, TEvent>,
  key: string,
  matcher: CommandQueryValue<TTarget, TEvent>,
  options: CommandQueryMatchOptions<TTarget, TEvent>,
): boolean {
  if (typeof matcher === "function") {
    return commandKeyMatchesPredicate(
      commandState,
      key,
      matcher as (value: unknown, command: Command<TTarget, TEvent>) => boolean,
      options,
    )
  }

  return commandKeyMatchesExact(commandState, key, matcher)
}

function commandKeyMatchesPredicate<TTarget extends object, TEvent extends KeymapEvent>(
  commandState: CommandState<TTarget, TEvent>,
  key: string,
  matcher: (value: unknown, command: Command<TTarget, TEvent>) => boolean,
  options: CommandQueryMatchOptions<TTarget, TEvent>,
): boolean {
  const command = commandState.command
  const fields = commandState.fields
  const attrs = commandState.attrs
  let commandView: Command<TTarget, TEvent> | undefined
  let foundValue = false
  const getCommandView = () => (commandView ??= options.getCommand(commandState))

  if (key === "name") {
    foundValue = true
    if (runCommandQueryPredicate(matcher, command.name, getCommandView(), options.onFilterError)) {
      return true
    }
  }

  if (Object.prototype.hasOwnProperty.call(fields, key)) {
    foundValue = true
    if (runCommandQueryPredicate(matcher, fields[key], getCommandView(), options.onFilterError)) {
      return true
    }
  }

  if (attrs && Object.prototype.hasOwnProperty.call(attrs, key)) {
    foundValue = true
    if (runCommandQueryPredicate(matcher, attrs[key], getCommandView(), options.onFilterError)) {
      return true
    }
  }

  return !foundValue && runCommandQueryPredicate(matcher, undefined, getCommandView(), options.onFilterError)
}

function commandKeyMatchesExact<TTarget extends object, TEvent extends KeymapEvent>(
  commandState: CommandState<TTarget, TEvent>,
  key: string,
  matcher: unknown | readonly unknown[],
): boolean {
  const command = commandState.command
  const fields = commandState.fields
  const attrs = commandState.attrs

  if (key === "name" && valueMatchesFilter(command.name, matcher)) {
    return true
  }

  if (Object.prototype.hasOwnProperty.call(fields, key) && valueMatchesFilter(fields[key], matcher)) {
    return true
  }

  return !!attrs && Object.prototype.hasOwnProperty.call(attrs, key) && valueMatchesFilter(attrs[key], matcher)
}

function valueMatchesFilter(value: unknown, matcher: unknown | readonly unknown[]): boolean {
  if (Array.isArray(matcher)) {
    return matcher.some((expected) => valueMatchesExact(value, expected))
  }

  return valueMatchesExact(value, matcher)
}

function valueMatchesExact(value: unknown, expected: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => valueMatchesExact(entry, expected))
  }

  return Object.is(value, expected)
}
