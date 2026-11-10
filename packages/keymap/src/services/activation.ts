import type { RuntimeEmitter } from "../lib/runtime-utils.js"
import type {
  ActiveBinding,
  ActiveKey,
  ActiveKeyOptions,
  ActiveKeySelection,
  ActiveKeyState,
  BindingState,
  Hooks,
  KeyMatch,
  KeymapEvent,
  KeymapHost,
  PendingSequenceCapture,
  KeySequencePart,
  NormalizedKeyStroke,
  PendingSequenceState,
  RegisteredLayer,
  SequenceNode,
} from "../types.js"
import {
  getActiveLayersForFocused,
  getFocusedTargetIfAvailable as getHostFocusedTargetIfAvailable,
  isLayerActiveForFocused,
} from "./primitives/active-layers.js"
import { captureHasContinuations } from "./primitives/pending-captures.js"
import {
  createActiveKeysCaches,
  getActiveKeysCache,
  getFocusedActiveKeysCache,
  setFocusedActiveKeysCache,
  type ActiveKeysCache,
} from "./active-key-cache.js"
import type { CommandCatalogService } from "./command-catalog.js"
import { cloneKeyStroke, stringifyKeyStroke } from "./keys.js"
import type { ConditionService } from "./conditions.js"
import type { NotificationService } from "./notify.js"
import type { ActiveCommandView, State } from "./state.js"
import { activeOptionsForCaptures, type SequenceActiveOption } from "./sequence-index.js"
import { collectSequencePartsFromPending, isSamePendingSequence, popCapture } from "./pending-sequence.js"

function getLiveHost<TTarget extends object, TEvent extends KeymapEvent>(
  host: KeymapHost<TTarget, TEvent>,
): KeymapHost<TTarget, TEvent> {
  if (host.isDestroyed) {
    throw new Error("Cannot use a keymap after its host was destroyed")
  }

  return host
}

interface ActivationOptions<TTarget extends object, TEvent extends KeymapEvent> {
  onPendingSequenceChanged?: (
    previous: PendingSequenceState<TTarget, TEvent> | null,
    next: PendingSequenceState<TTarget, TEvent> | null,
  ) => void
}

export interface ActivationService<TTarget extends object, TEvent extends KeymapEvent> {
  getFocusedTarget(): TTarget | null
  getFocusedTargetIfAvailable(): TTarget | null
  setPendingSequence(next: PendingSequenceState<TTarget, TEvent> | null): void
  ensureValidPendingSequence(): PendingSequenceState<TTarget, TEvent> | undefined
  revalidatePendingSequenceIfNeeded(): void
  hasPendingSequenceState(): boolean
  getPendingSequence(): readonly KeySequencePart[]
  popPendingSequence(): boolean
  getActiveKeys(options?: ActiveKeyOptions): readonly ActiveKey<TTarget, TEvent>[]
  getActiveKeysForCaptures(
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    options?: ActiveKeyOptions,
  ): readonly ActiveKey<TTarget, TEvent>[]
  getActiveKeysForFocused(focused: TTarget | null, options?: ActiveKeyOptions): readonly ActiveKey<TTarget, TEvent>[]
  getActiveLayers(focused: TTarget | null): RegisteredLayer<TTarget, TEvent>[]
  isLayerActiveForFocused(layer: RegisteredLayer<TTarget, TEvent>, focused: TTarget | null): boolean
  collectSequencePartsFromPending(pending: PendingSequenceState<TTarget, TEvent>): KeySequencePart[]
  collectMatchingBindings(
    bindings: readonly BindingState<TTarget, TEvent>[],
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): BindingState<TTarget, TEvent>[]
  collectActiveBindings(
    bindings: readonly BindingState<TTarget, TEvent>[],
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveBinding<TTarget, TEvent>[]
}

export function createActivationService<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
  host: KeymapHost<TTarget, TEvent>,
  hooks: RuntimeEmitter<Hooks<TTarget, TEvent>>,
  notify: NotificationService<TTarget, TEvent>,
  conditions: ConditionService<TTarget, TEvent>,
  catalog: CommandCatalogService<TTarget, TEvent>,
  options: ActivationOptions<TTarget, TEvent> = {},
): ActivationService<TTarget, TEvent> {
  const activeKeysCaches = createActiveKeysCaches<TTarget, TEvent>()
  let pendingSequenceCacheVersion = -1
  let pendingSequenceCache: readonly KeySequencePart[] = []

  const getFocusedTarget = (): TTarget | null => {
    return getLiveHost(host).getFocusedTarget()
  }

  const getFocusedTargetIfAvailable = (): TTarget | null => {
    return getHostFocusedTargetIfAvailable(host)
  }

  const setPendingSequence = (next: PendingSequenceState<TTarget, TEvent> | null): void => {
    const previous = state.pending
    if (isSamePendingSequence(previous, next)) {
      return
    }

    state.pending = next
    options.onPendingSequenceChanged?.(previous, next)
    notifyPendingSequenceChange()
    notify.queueStateChange()
  }

  const ensureValidPendingSequence = (): PendingSequenceState<TTarget, TEvent> | undefined => {
    const pending = state.pending
    if (!pending) {
      return undefined
    }

    const focused = getFocusedTarget()
    const activeView = catalog.getActiveCommandView(focused)
    const captures = pending.captures.filter((capture) => {
      return (
        state.layers.has(capture.layer) &&
        isActiveLayerForFocused(capture.layer, focused) &&
        conditions.matchesConditions(capture.layer) &&
        bindingMatchesRuntimeState(capture.binding, focused, activeView) &&
        captureHasContinuations(capture, state.patterns)
      )
    })

    if (captures.length === 0) {
      setPendingSequence(null)
      return undefined
    }

    if (captures.length !== pending.captures.length) {
      setPendingSequence({ captures })
    }

    return state.pending ?? undefined
  }

  const revalidatePendingSequenceIfNeeded = (): void => {
    if (host.isDestroyed || !state.pending) {
      return
    }

    ensureValidPendingSequence()
  }

  const hasPendingSequenceState = (): boolean => {
    return !host.isDestroyed && state.pending !== null
  }

  const getPendingSequence = (): readonly KeySequencePart[] => {
    if (pendingSequenceCacheVersion === state.cacheVersion) {
      return pendingSequenceCache
    }

    const pending = ensureValidPendingSequence()
    const sequence = pending ? collectSequencePartsFromPending(pending) : []
    if (!pending || allRegisteredLayersCanCacheActiveKeys()) {
      pendingSequenceCacheVersion = state.cacheVersion
      pendingSequenceCache = sequence
    }

    return sequence
  }

  const popPendingSequence = (): boolean => {
    const pending = ensureValidPendingSequence()
    if (!pending) {
      return false
    }

    const firstCapture = pending.captures[0]
    if (!firstCapture || firstCapture.parts.length <= 1) {
      setPendingSequence(null)
      return true
    }

    const nextCaptures: PendingSequenceCapture<TTarget, TEvent>[] = []

    for (const capture of pending.captures) {
      const nextCapture = popCapture(capture)
      if (!nextCapture) {
        continue
      }

      nextCaptures.push(nextCapture)
    }

    if (nextCaptures.length === 0) {
      setPendingSequence(null)
      return true
    }

    setPendingSequence({ captures: nextCaptures })
    return true
  }

  const getActiveKeys = (options?: ActiveKeyOptions): readonly ActiveKey<TTarget, TEvent>[] => {
    const includeBindings = options?.includeBindings === true
    const includeMetadata = options?.includeMetadata === true
    const cache = getActiveKeysCache(activeKeysCaches, options)

    if (cache.notifyVersion === state.derivedVersion) {
      return cache.value
    }

    return collectActiveKeysForCache(cache, includeBindings, includeMetadata)
  }

  const collectActiveKeysForCache = (
    cache: ActiveKeysCache<TTarget, TEvent>,
    includeBindings: boolean,
    includeMetadata: boolean,
  ): readonly ActiveKey<TTarget, TEvent>[] => {
    if (host.isDestroyed) {
      getLiveHost(host)
    }

    const focused = getFocusedTarget()
    const cached = getFocusedActiveKeysCache(cache, state.cacheVersion, focused)
    if (cached) {
      cache.notifyVersion = state.derivedVersion
      cache.version = state.cacheVersion
      cache.focused = focused
      cache.value = cached.value
      return cached.value
    }

    const activeView = catalog.getActiveCommandView(focused)
    const pending = ensureValidPendingSequence()
    const activeLayers = pending ? [] : getActiveLayers(focused)

    const activeKeys = pending
      ? collectActiveKeysFromPending(pending.captures, includeBindings, includeMetadata, focused, activeView)
      : collectActiveKeysAtRoot(activeLayers, includeBindings, includeMetadata, focused, activeView)

    const canUseCache = pending ? allRegisteredLayersCanCacheActiveKeys() : activeLayersCanCacheActiveKeys(activeLayers)
    if (canUseCache) {
      cache.version = state.cacheVersion
      cache.notifyVersion = state.derivedVersion
      cache.focused = focused
      cache.value = activeKeys
      setFocusedActiveKeysCache(cache, state.cacheVersion, focused, activeKeys)
    }

    return activeKeys
  }

  const getActiveKeysForCaptures = (
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    options?: ActiveKeyOptions,
  ): readonly ActiveKey<TTarget, TEvent>[] => {
    const includeBindings = options?.includeBindings === true
    const includeMetadata = options?.includeMetadata === true
    const focused = getFocusedTarget()
    const activeView = catalog.getActiveCommandView(focused)

    return collectActiveKeysFromPending(captures, includeBindings, includeMetadata, focused, activeView)
  }

  const getActiveKeysForFocused = (
    focused: TTarget | null,
    options?: ActiveKeyOptions,
  ): readonly ActiveKey<TTarget, TEvent>[] => {
    const includeBindings = options?.includeBindings === true
    const includeMetadata = options?.includeMetadata === true
    const currentFocused = getFocusedTargetIfAvailable()
    const pending = focused === currentFocused ? ensureValidPendingSequence() : undefined
    const activeView = catalog.getActiveCommandView(focused)

    if (pending) {
      return collectActiveKeysFromPending(pending.captures, includeBindings, includeMetadata, focused, activeView)
    }

    return collectActiveKeysAtRoot(getActiveLayers(focused), includeBindings, includeMetadata, focused, activeView)
  }

  const getActiveLayers = (focused: TTarget | null): RegisteredLayer<TTarget, TEvent>[] => {
    if (state.activeLayersCacheVersion === state.cacheVersion && state.activeLayersCacheFocused === focused) {
      return state.activeLayersCache
    }

    state.activeLayersCacheVersion = state.cacheVersion
    state.activeLayersCacheFocused = focused
    state.activeLayersCache = getActiveLayersForFocused(state.sortedLayers, host, focused) as RegisteredLayer<
      TTarget,
      TEvent
    >[]
    return state.activeLayersCache
  }

  const isActiveLayerForFocused = (layer: RegisteredLayer<TTarget, TEvent>, focused: TTarget | null): boolean => {
    return isLayerActiveForFocused(host, layer, focused)
  }

  const activeLayersCanCacheActiveKeys = (activeLayers: readonly RegisteredLayer<TTarget, TEvent>[]): boolean => {
    return !state.commandResolvers.has() && state.activeKeyCacheBlockers === 0
  }

  const allRegisteredLayersCanCacheActiveKeys = (): boolean => {
    return !state.commandResolvers.has() && state.activeKeyCacheBlockers === 0
  }

  const collectMatchingBindings = (
    bindings: readonly BindingState<TTarget, TEvent>[],
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): BindingState<TTarget, TEvent>[] => {
    const matches: BindingState<TTarget, TEvent>[] = []

    for (const binding of bindings) {
      if (conditions.matchesConditions(binding) && catalog.isBindingVisible(binding, focused, activeView)) {
        matches.push(binding)
      }
    }

    return matches
  }

  const bindingMatchesRuntimeState = (
    binding: BindingState<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): boolean => {
    return conditions.matchesConditions(binding) && catalog.isBindingVisible(binding, focused, activeView)
  }

  const getPartPresentation = (
    bindings: readonly BindingState<TTarget, TEvent>[],
    partIndex: number,
  ): { display: string; tokenName?: string } => {
    let display: string | undefined
    let tokenName: string | undefined
    let hasDisplayConflict = false
    let hasTokenConflict = false

    for (const binding of bindings) {
      const part = binding.sequence[partIndex]
      if (!part) {
        continue
      }

      if (display === undefined) {
        display = part.display
        tokenName = part.tokenName
        continue
      }

      if (!hasDisplayConflict && display !== part.display) {
        hasDisplayConflict = true
      }

      if (!hasTokenConflict && tokenName !== part.tokenName) {
        hasTokenConflict = true
      }
    }

    if (display === undefined || hasDisplayConflict) {
      const stroke = bindings[0]?.sequence[partIndex]?.stroke
      display = stroke ? stringifyKeyStroke(stroke) : ""
    }

    if (hasTokenConflict) {
      tokenName = undefined
    }

    return {
      display,
      tokenName,
    }
  }

  const toActiveBinding = (
    binding: BindingState<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveBinding<TTarget, TEvent> => {
    return {
      sequence: binding.sequence,
      command: binding.command,
      commandAttrs: catalog.getBindingCommandAttrs(binding, focused, activeView),
      attrs: binding.attrs,
      event: binding.event,
      preventDefault: binding.preventDefault,
      fallthrough: binding.fallthrough,
    }
  }

  const collectActiveBindings = (
    bindings: readonly BindingState<TTarget, TEvent>[],
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveBinding<TTarget, TEvent>[] => {
    return bindings.map((binding) => toActiveBinding(binding, focused, activeView))
  }

  const collectActiveKeysAtRoot = (
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): readonly ActiveKey<TTarget, TEvent>[] => {
    const activeKeys = new Map<KeyMatch, ActiveKeyState<TTarget, TEvent>>()
    const stopped = new Set<KeyMatch>()

    for (const layer of activeLayers) {
      if (
        (layer.root.children.size === 0 && layer.root.patternChildren.length === 0) ||
        !conditions.matchesConditions(layer)
      ) {
        continue
      }

      collectActiveKeyNodes(layer.root.children.values(), activeKeys, stopped, includeBindings, focused, activeView)
      collectActiveKeyNodes(layer.root.patternChildren, activeKeys, stopped, includeBindings, focused, activeView)
    }

    return materializeActiveKeys(activeKeys, includeBindings, includeMetadata, focused, activeView)
  }

  const collectActiveKeyNodes = (
    nodes: Iterable<SequenceNode<TTarget, TEvent>>,
    activeKeys: Map<KeyMatch, ActiveKeyState<TTarget, TEvent>>,
    stopped: Set<KeyMatch>,
    includeBindings: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): void => {
    for (const node of nodes) {
      const bindingKey = node.match
      if (!bindingKey || stopped.has(bindingKey) || !node.stroke) {
        continue
      }

      const selection = selectActiveKeyNode(node, includeBindings, focused, activeView)
      if (!selection) {
        continue
      }

      const existing = activeKeys.get(bindingKey)
      if (!existing) {
        activeKeys.set(bindingKey, createActiveKeyState(node.stroke, selection, includeBindings))
      } else {
        updateActiveKeyState(existing, selection, includeBindings)
      }

      if (selection.stop) {
        stopped.add(bindingKey)
      }
    }
  }

  const selectActiveKeyNode = (
    node: SequenceNode<TTarget, TEvent>,
    includeBindings: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveKeySelection<TTarget, TEvent> | undefined => {
    const continues = node.children.size > 0 || node.patternChildren.length > 0
    if (!continues) {
      const selected = selectActiveBindings(
        nodeExactBindingsNeedPrefilter(node)
          ? collectMatchingBindings(node.bindings, focused, activeView)
          : node.bindings,
        focused,
        activeView,
      )
      if (!selected) {
        return undefined
      }

      const presentation = getPartPresentation(selected.bindings, node.depth - 1)

      return {
        display: presentation.display,
        tokenName: presentation.tokenName,
        continues: false,
        firstBinding: selected.bindings[0],
        commandBinding: selected.commandBinding,
        bindings: includeBindings ? [...selected.bindings] : undefined,
        stop: selected.stop,
      }
    }

    const reachableBindings = collectMatchingBindings(node.reachableBindings, focused, activeView)
    if (reachableBindings.length === 0) {
      return undefined
    }

    const selected = selectActiveBindings(node.bindings, focused, activeView)
    const presentation = getPartPresentation(reachableBindings, node.depth - 1)

    return {
      display: presentation.display,
      tokenName: presentation.tokenName,
      continues: true,
      firstBinding: selected?.bindings[0],
      commandBinding: selected?.commandBinding,
      bindings: includeBindings && selected ? [...selected.bindings] : undefined,
      stop: true,
    }
  }

  const nodeExactBindingsNeedPrefilter = (node: SequenceNode<TTarget, TEvent>): boolean => {
    if (state.commandResolvers.has()) {
      return true
    }

    for (const binding of node.bindings) {
      if (binding.matchers.length > 0) {
        return true
      }
    }

    return false
  }

  const collectActiveKeysFromPending = (
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): readonly ActiveKey<TTarget, TEvent>[] => {
    const activeKeys = new Map<KeyMatch, ActiveKeyState<TTarget, TEvent>>()
    const stopped = new Set<KeyMatch>()
    collectActiveKeyOptions(
      activeOptionsForCaptures(captures, state.patterns),
      activeKeys,
      stopped,
      includeBindings,
      focused,
      activeView,
    )

    return materializeActiveKeys(activeKeys, includeBindings, includeMetadata, focused, activeView)
  }

  const collectActiveKeyOptions = (
    options: readonly SequenceActiveOption<TTarget, TEvent>[],
    activeKeys: Map<KeyMatch, ActiveKeyState<TTarget, TEvent>>,
    stopped: Set<KeyMatch>,
    includeBindings: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): void => {
    const seen = new Set<KeyMatch>()
    for (const option of options) {
      if (seen.has(option.part.match)) {
        continue
      }

      seen.add(option.part.match)
      collectActiveKeyOption(option, options, activeKeys, stopped, includeBindings, focused, activeView)
    }
  }

  const collectActiveKeyOption = (
    option: SequenceActiveOption<TTarget, TEvent>,
    siblingOptions: readonly SequenceActiveOption<TTarget, TEvent>[],
    activeKeys: Map<KeyMatch, ActiveKeyState<TTarget, TEvent>>,
    stopped: Set<KeyMatch>,
    includeBindings: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): void => {
    const bindingKey = option.part.match
    if (stopped.has(bindingKey)) {
      return
    }

    const selection = selectActiveKeyOption(option, siblingOptions, includeBindings, focused, activeView)
    if (!selection) {
      return
    }

    const existing = activeKeys.get(bindingKey)
    if (!existing) {
      activeKeys.set(bindingKey, createActiveKeyState(option.part.stroke, selection, includeBindings))
    } else {
      updateActiveKeyState(existing, selection, includeBindings)
    }

    if (selection.stop) {
      stopped.add(bindingKey)
    }
  }

  const materializeActiveKeys = (
    activeKeys: ReadonlyMap<KeyMatch, ActiveKeyState<TTarget, TEvent>>,
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): readonly ActiveKey<TTarget, TEvent>[] => {
    const materialized: ActiveKey<TTarget, TEvent>[] = []
    for (const state of activeKeys.values()) {
      const activeKey = materializeActiveKey(state, includeBindings, includeMetadata, focused, activeView)
      if (activeKey) {
        materialized.push(activeKey)
      }
    }

    return materialized
  }

  const selectActiveKeyOption = (
    option: SequenceActiveOption<TTarget, TEvent>,
    siblingOptions: readonly SequenceActiveOption<TTarget, TEvent>[],
    includeBindings: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveKeySelection<TTarget, TEvent> | undefined => {
    const matchingOptions = siblingOptions.filter((candidate) => candidate.part.match === option.part.match)
    const exactBindings = matchingOptions.filter((candidate) => candidate.exact).map((candidate) => candidate.binding)
    const selected = selectActiveBindings(exactBindings, focused, activeView)
    const continues = matchingOptions.some((candidate) => candidate.continues)

    if (!continues && !selected) {
      return undefined
    }

    const presentation = getOptionPresentation(matchingOptions)

    return {
      display: presentation.display,
      tokenName: presentation.tokenName,
      continues,
      firstBinding: selected?.bindings[0],
      commandBinding: selected?.commandBinding,
      bindings: includeBindings && selected ? [...selected.bindings] : undefined,
      stop: continues || selected?.stop === true,
    }
  }

  const getOptionPresentation = (
    options: readonly SequenceActiveOption<TTarget, TEvent>[],
  ): { display: string; tokenName?: string } => {
    let display: string | undefined
    let tokenName: string | undefined
    let hasDisplayConflict = false
    let hasTokenConflict = false

    for (const option of options) {
      const part = option.part
      if (display === undefined) {
        display = part.display
        tokenName = part.tokenName
        continue
      }

      if (!hasDisplayConflict && display !== part.display) {
        hasDisplayConflict = true
      }

      if (!hasTokenConflict && tokenName !== part.tokenName) {
        hasTokenConflict = true
      }
    }

    const firstPart = options[0]?.part
    if (display === undefined || hasDisplayConflict) {
      display = firstPart ? stringifyKeyStroke(firstPart.stroke) : ""
    }

    if (hasTokenConflict) {
      tokenName = undefined
    }

    return { display, tokenName }
  }

  const selectActiveBindings = (
    bindings: readonly BindingState<TTarget, TEvent>[],
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ):
    | {
        bindings: readonly BindingState<TTarget, TEvent>[]
        commandBinding?: BindingState<TTarget, TEvent>
        stop: boolean
      }
    | undefined => {
    const selected: BindingState<TTarget, TEvent>[] = []
    let commandBinding: BindingState<TTarget, TEvent> | undefined

    for (const binding of bindings) {
      if (!conditions.matchesConditions(binding) || !catalog.isBindingVisible(binding, focused, activeView)) {
        continue
      }

      selected.push(binding)
      if (binding.command === undefined) {
        continue
      }

      commandBinding ??= binding
      if (!binding.fallthrough) {
        return { bindings: selected, commandBinding, stop: true }
      }
    }

    if (selected.length === 0) {
      return undefined
    }

    return { bindings: selected, commandBinding, stop: false }
  }

  const createActiveKeyState = (
    stroke: NormalizedKeyStroke,
    selection: ActiveKeySelection<TTarget, TEvent>,
    includeBindings: boolean,
  ): ActiveKeyState<TTarget, TEvent> => {
    return {
      stroke,
      display: selection.display,
      tokenName: selection.tokenName,
      continues: selection.continues,
      firstBinding: selection.firstBinding,
      commandBinding: selection.commandBinding,
      bindings: includeBindings && selection.bindings ? [...selection.bindings] : undefined,
    }
  }

  const updateActiveKeyState = (
    state: ActiveKeyState<TTarget, TEvent>,
    selection: ActiveKeySelection<TTarget, TEvent>,
    includeBindings: boolean,
  ): void => {
    if (!state.firstBinding && selection.firstBinding) {
      state.firstBinding = selection.firstBinding
    }

    if (!state.commandBinding && selection.commandBinding) {
      state.commandBinding = selection.commandBinding
    }

    if (selection.continues) {
      state.continues = true
    }

    if (!includeBindings || !selection.bindings || selection.bindings.length === 0) {
      return
    }

    if (!state.bindings) {
      state.bindings = [...selection.bindings]
      return
    }

    state.bindings.push(...selection.bindings)
  }

  const materializeActiveKey = (
    state: ActiveKeyState<TTarget, TEvent>,
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveKey<TTarget, TEvent> | undefined => {
    if (!state.commandBinding && !state.continues) {
      return undefined
    }

    const activeKey: ActiveKey<TTarget, TEvent> = {
      stroke: cloneKeyStroke(state.stroke),
      display: state.display,
      continues: state.continues,
    }

    if (state.tokenName) {
      activeKey.tokenName = state.tokenName
    }

    if (state.commandBinding) {
      activeKey.command = state.commandBinding.command
    }

    if (includeBindings && state.bindings && state.bindings.length > 0) {
      activeKey.bindings =
        state.bindings.length === 1
          ? [toActiveBinding(state.bindings[0]!, focused, activeView)]
          : collectActiveBindings(state.bindings, focused, activeView)
    }

    if (includeMetadata) {
      if (state.firstBinding?.attrs) {
        activeKey.bindingAttrs = state.firstBinding.attrs
      }

      const commandAttrs = state.commandBinding
        ? catalog.getBindingCommandAttrs(state.commandBinding, focused, activeView)
        : undefined
      if (commandAttrs) {
        activeKey.commandAttrs = commandAttrs
      }
    }

    return activeKey
  }

  const notifyPendingSequenceChange = (): void => {
    if (!hooks.has("pendingSequence")) {
      return
    }

    hooks.emit("pendingSequence", state.pending ? collectSequencePartsFromPending(state.pending) : [])
  }

  return {
    getFocusedTarget,
    getFocusedTargetIfAvailable,
    setPendingSequence,
    ensureValidPendingSequence,
    revalidatePendingSequenceIfNeeded,
    hasPendingSequenceState,
    getPendingSequence,
    popPendingSequence,
    getActiveKeys,
    getActiveKeysForCaptures,
    getActiveKeysForFocused,
    getActiveLayers,
    isLayerActiveForFocused: isActiveLayerForFocused,
    collectSequencePartsFromPending,
    collectMatchingBindings,
    collectActiveBindings,
  }
}
