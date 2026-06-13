import type { CompilerService } from "./compiler.js"
import type { RuntimeEmitter } from "../lib/runtime-utils.js"
import type { ActivationService } from "./activation.js"
import type { CommandExecutorService } from "./command-executor.js"
import type { CommandCatalogService } from "./command-catalog.js"
import type { ConditionService } from "./conditions.js"
import type { LayerService } from "./layers.js"
import type { NotificationService } from "./notify.js"
import type { RuntimeService } from "./runtime.js"
import type { State } from "./state.js"
import { cloneKeySequence, cloneKeyStroke, stringifyKeySequence } from "./keys.js"
import { captureHasContinuations, captureIsExact } from "./primitives/pending-captures.js"
import { advanceSequenceCapture, capturePriority, collectRootSequenceCaptures } from "./sequence-index.js"
import { isPromiseLike } from "./values.js"
import {
  type ActiveBinding,
  type ActiveKey,
  type EventMatchResolverContext,
  type EventMatchResolver,
  type KeyDeferredDisambiguationContext,
  type KeyDeferredDisambiguationDecision,
  type KeyDeferredDisambiguationHandler,
  type KeyDisambiguationContext,
  type KeyDisambiguationDecision,
  type KeyDisambiguationResolver,
  type KeyMatch,
  type KeyInterceptOptions,
  type KeyAfterInputContext,
  type KeyAfterReason,
  type KeyInputContext,
  type KeymapEvent,
  type PendingSequenceCapture,
  type PendingSequenceState,
  type RawInterceptOptions,
  type RawInputContext,
  type BindingState,
  type Hooks,
  type DispatchBinding,
  type DispatchEvent,
  type KeySequencePart,
  type RegisteredLayer,
} from "../types.js"
import type { PriorityRegistration } from "../lib/registry.js"
import {
  createDeferredDecision,
  createSyncDecision,
  isDeferredDecision,
  isSyncDecision,
  sleepWithSignal,
  type InternalDeferredDisambiguationDecision,
  type InternalDisambiguationDecision,
  type PendingDisambiguation,
} from "./dispatch-decisions.js"
import {
  createPatternEventPart as createPatternEventPartFromPattern,
  createSequencePayload as createSequencePayloadFromPattern,
  matchSequencePattern,
} from "./dispatch-patterns.js"

interface KeyDispatchOutcome {
  handled: boolean
  reason: KeyAfterReason
  sequence?: readonly KeySequencePart[]
  captures?: readonly PendingSequenceCapture<any, any>[]
}

type KeyAfterHook<TTarget extends object, TEvent extends KeymapEvent> = PriorityRegistration<
  (ctx: KeyAfterInputContext<TTarget, TEvent>) => void,
  { priority: number; release: boolean }
>

export interface DispatchService<TTarget extends object, TEvent extends KeymapEvent> {
  intercept(name: "key", fn: (ctx: KeyInputContext<TEvent>) => void, options?: KeyInterceptOptions): () => void
  intercept(
    name: "key:after",
    fn: (ctx: KeyAfterInputContext<TTarget, TEvent>) => void,
    options?: KeyInterceptOptions,
  ): () => void
  intercept(name: "raw", fn: (ctx: RawInputContext) => void, options?: RawInterceptOptions): () => void
  prependEventMatchResolver(resolver: EventMatchResolver<TEvent>): () => void
  appendEventMatchResolver(resolver: EventMatchResolver<TEvent>): () => void
  clearEventMatchResolvers(): void
  prependDisambiguationResolver(resolver: KeyDisambiguationResolver<TTarget, TEvent>): () => void
  appendDisambiguationResolver(resolver: KeyDisambiguationResolver<TTarget, TEvent>): () => void
  clearDisambiguationResolvers(): void
  handlePendingSequenceChange(
    previous: PendingSequenceState<TTarget, TEvent> | null,
    next: PendingSequenceState<TTarget, TEvent> | null,
  ): void
  handleRawSequence(sequence: string): boolean
  handleKeyEvent(event: TEvent, release: boolean): void
}

export function createDispatchService<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
  notify: NotificationService<TTarget, TEvent>,
  runtime: RuntimeService<TTarget, TEvent>,
  activation: ActivationService<TTarget, TEvent>,
  conditions: ConditionService<TTarget, TEvent>,
  executor: CommandExecutorService<TTarget, TEvent>,
  compiler: CompilerService<TTarget, TEvent>,
  catalog: CommandCatalogService<TTarget, TEvent>,
  layers: LayerService<TTarget, TEvent>,
  hooks: RuntimeEmitter<Hooks<TTarget, TEvent>>,
): DispatchService<TTarget, TEvent> {
  const eventMatchResolverContext: EventMatchResolverContext = {
    resolveKey: (key) => compiler.parseTokenKey(key).match,
  }
  let pendingDisambiguation: PendingDisambiguation<TTarget, TEvent> | null = null
  let nextPendingDisambiguationId = 0

  function intercept(name: "key", fn: (ctx: KeyInputContext<TEvent>) => void, options?: KeyInterceptOptions): () => void

  function intercept(
    name: "key:after",
    fn: (ctx: KeyAfterInputContext<TTarget, TEvent>) => void,
    options?: KeyInterceptOptions,
  ): () => void

  function intercept(name: "raw", fn: (ctx: RawInputContext) => void, options?: RawInterceptOptions): () => void

  function intercept(
    name: "key" | "key:after" | "raw",
    fn:
      | ((ctx: KeyInputContext<TEvent>) => void)
      | ((ctx: KeyAfterInputContext<TTarget, TEvent>) => void)
      | ((ctx: RawInputContext) => void),
    options?: KeyInterceptOptions | RawInterceptOptions,
  ): () => void {
    if (name === "key") {
      const keyOptions = options as KeyInterceptOptions | undefined
      return state.keyHooks.register(fn as (ctx: KeyInputContext<TEvent>) => void, {
        priority: keyOptions?.priority ?? 0,
        release: keyOptions?.release ?? false,
      })
    }

    if (name === "key:after") {
      const keyOptions = options as KeyInterceptOptions | undefined
      return state.keyAfterHooks.register(fn as (ctx: KeyAfterInputContext<TTarget, TEvent>) => void, {
        priority: keyOptions?.priority ?? 0,
        release: keyOptions?.release ?? false,
      })
    }

    const rawOptions = options as RawInterceptOptions | undefined
    return state.rawHooks.register(fn as (ctx: RawInputContext) => void, {
      priority: rawOptions?.priority ?? 0,
    })
  }

  function prependEventMatchResolver(resolver: EventMatchResolver<TEvent>): () => void {
    return state.eventMatchResolvers.prepend(resolver)
  }

  function appendEventMatchResolver(resolver: EventMatchResolver<TEvent>): () => void {
    return state.eventMatchResolvers.append(resolver)
  }

  function clearEventMatchResolvers(): void {
    state.eventMatchResolvers.clear()
  }

  function prependDisambiguationResolver(resolver: KeyDisambiguationResolver<TTarget, TEvent>): () => void {
    return mutateDisambiguationResolvers(() => state.disambiguationResolvers.prepend(resolver), resolver)
  }

  function appendDisambiguationResolver(resolver: KeyDisambiguationResolver<TTarget, TEvent>): () => void {
    return mutateDisambiguationResolvers(() => state.disambiguationResolvers.append(resolver), resolver)
  }

  function clearDisambiguationResolvers(): void {
    if (!state.disambiguationResolvers.has()) {
      return
    }

    notify.runWithStateChangeBatch(() => {
      state.disambiguationResolvers.clear()
      layers.recompileBindings()
    })
  }

  function handlePendingSequenceChange(
    _previous: PendingSequenceState<TTarget, TEvent> | null,
    _next: PendingSequenceState<TTarget, TEvent> | null,
  ): void {
    if (!pendingDisambiguation) {
      return
    }

    cancelPendingDisambiguation()
  }

  function handleRawSequence(sequence: string): boolean {
    const hooks = state.rawHooks.entries()
    if (hooks.length === 0) {
      return false
    }

    let stopped = false
    const context: RawInputContext = {
      sequence,
      stop() {
        stopped = true
      },
    }

    for (const hook of hooks) {
      try {
        hook.listener(context)
      } catch (error) {
        notify.emitError("raw-intercept-error", error, "[Keymap] Error in raw intercept listener:")
      }

      if (stopped) {
        return true
      }
    }

    return false
  }

  function createDispatchBinding(
    binding: BindingState<TTarget, TEvent>,
    focused: TTarget | null,
  ): DispatchBinding<TTarget, TEvent> {
    return {
      sequence: cloneKeySequence(binding.sequence),
      command: binding.command,
      commandAttrs: catalog.getBindingCommandAttrs(binding, focused, catalog.getActiveCommandView(focused)),
      attrs: binding.attrs,
      event: binding.event,
      preventDefault: binding.preventDefault,
      fallthrough: binding.fallthrough,
      sourceLayerOrder: binding.sourceLayerOrder,
      bindingIndex: binding.bindingIndex,
    }
  }

  function emitDispatchEvent(event: DispatchEvent<TTarget, TEvent>): void {
    if (!hooks.has("dispatch")) {
      return
    }

    hooks.emit("dispatch", event)
  }

  function emitBindingDispatch(
    phase: "binding-execute" | "binding-reject",
    layer: RegisteredLayer<TTarget, TEvent>,
    binding: BindingState<TTarget, TEvent>,
    focused: TTarget | null,
  ): void {
    if (!hooks.has("dispatch")) {
      return
    }

    emitDispatchEvent({
      phase,
      event: binding.event,
      focused,
      layer: {
        order: layer.order,
        priority: layer.priority,
        target: layer.target,
        targetMode: layer.targetMode,
      },
      binding: createDispatchBinding(binding, focused),
      sequence: cloneKeySequence(binding.sequence),
      command: binding.command,
    })
  }

  function emitSequenceDispatch(
    phase: "sequence-start" | "sequence-advance" | "sequence-clear",
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    focused: TTarget | null,
  ): void {
    if (!hooks.has("dispatch")) {
      return
    }

    const first = captures[0]
    const sequence = captures.length > 0 ? activation.collectSequencePartsFromPending({ captures }) : []

    emitDispatchEvent({
      phase,
      event: "press",
      focused,
      layer: first
        ? {
            order: first.layer.order,
            priority: first.layer.priority,
            target: first.layer.target,
            targetMode: first.layer.targetMode,
          }
        : undefined,
      sequence,
    })
  }

  function getKeyAfterHooks(release: boolean): readonly KeyAfterHook<TTarget, TEvent>[] | undefined {
    const hooks = state.keyAfterHooks.entries()
    for (const hook of hooks) {
      if (hook.release === release) {
        return hooks
      }
    }

    return undefined
  }

  function getOutcomeSequence(outcome: KeyDispatchOutcome): readonly KeySequencePart[] {
    if (outcome.sequence) {
      return cloneKeySequence(outcome.sequence)
    }

    if (outcome.captures) {
      return activation.collectSequencePartsFromPending({ captures: outcome.captures })
    }

    return []
  }

  function createSequenceOutcome(
    reason: "sequence-pending" | "sequence-miss" | "sequence-cleared",
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
  ): KeyDispatchOutcome {
    return {
      handled: reason !== "sequence-miss",
      reason,
      captures,
    }
  }

  function createBindingOutcome(binding: BindingState<TTarget, TEvent>, handled: boolean): KeyDispatchOutcome {
    return {
      handled,
      reason: handled ? "binding-handled" : "binding-rejected",
      sequence: binding.sequence,
    }
  }

  function preferDispatchOutcome(current: KeyDispatchOutcome, next: KeyDispatchOutcome): KeyDispatchOutcome {
    if (next.handled || current.reason === "no-match") {
      return next
    }

    return current
  }

  function emitKeyAfter(
    hooks: readonly KeyAfterHook<TTarget, TEvent>[],
    event: TEvent,
    release: boolean,
    focused: TTarget | null,
    outcome: KeyDispatchOutcome,
  ): void {
    const context: KeyAfterInputContext<TTarget, TEvent> = {
      event,
      eventType: release ? "release" : "press",
      focused,
      handled: outcome.handled,
      reason: outcome.reason,
      sequence: getOutcomeSequence(outcome),
      pendingSequence: activation.getPendingSequence(),
      setData: (name, value) => {
        runtime.setData(name, value)
      },
      getData: (name) => {
        return runtime.getData(name)
      },
      consume: (options) => {
        const shouldPreventDefault = options?.preventDefault ?? true
        const shouldStopPropagation = options?.stopPropagation ?? true

        if (shouldPreventDefault) {
          event.preventDefault()
        }

        if (shouldStopPropagation) {
          event.stopPropagation()
        }
      },
    }

    for (const hook of hooks) {
      if (hook.release !== release) {
        continue
      }

      try {
        hook.listener(context)
      } catch (error) {
        notify.emitError("key-after-intercept-error", error, "[Keymap] Error in key:after intercept listener:")
      }
    }
  }

  function noMatchOutcome(): KeyDispatchOutcome {
    return { handled: false, reason: "no-match" }
  }

  function consumeSequenceEvent(event: TEvent): void {
    event.preventDefault()
    event.stopPropagation()
  }

  function holdSequence(
    phase: "sequence-start" | "sequence-advance",
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    focused: TTarget | null,
    event: TEvent,
  ): KeyDispatchOutcome {
    activation.setPendingSequence({ captures })
    const outcome = createSequenceOutcome("sequence-pending", captures)
    emitSequenceDispatch(phase, captures, focused)
    consumeSequenceEvent(event)
    return outcome
  }

  function clearSequence(
    reason: "sequence-cleared",
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    focused: TTarget | null,
    event: TEvent,
  ): KeyDispatchOutcome {
    const outcome = createSequenceOutcome(reason, captures)
    emitSequenceDispatch("sequence-clear", captures, focused)
    activation.setPendingSequence(null)
    consumeSequenceEvent(event)
    return outcome
  }

  function handleKeyEvent(event: TEvent, release: boolean): void {
    if (!release) {
      cancelPendingDisambiguation()
    }

    const afterHooks = getKeyAfterHooks(release)
    const afterFocused = afterHooks ? activation.getFocusedTarget() : null
    const hooks = state.keyHooks.entries()
    const context: KeyInputContext<TEvent> = {
      event,
      setData: (name, value) => {
        runtime.setData(name, value)
      },
      getData: (name) => {
        return runtime.getData(name)
      },
      consume: (options) => {
        const shouldPreventDefault = options?.preventDefault ?? true
        const shouldStopPropagation = options?.stopPropagation ?? true

        if (shouldPreventDefault) {
          event.preventDefault()
        }

        if (shouldStopPropagation) {
          event.stopPropagation()
        }
      },
    }

    for (const hook of hooks) {
      if (hook.release !== release) {
        continue
      }

      try {
        hook.listener(context)
      } catch (error) {
        notify.emitError("key-intercept-error", error, "[Keymap] Error in key intercept listener:")
      }

      if (event.propagationStopped) {
        if (afterHooks) {
          emitKeyAfter(afterHooks, event, release, afterFocused, {
            handled: true,
            reason: "intercept-consumed",
            sequence: [],
          })
        }
        return
      }
    }

    if (release) {
      const outcome = dispatchReleaseLayers(event)
      if (afterHooks) {
        emitKeyAfter(afterHooks, event, release, afterFocused, outcome)
      }
      return
    }

    const outcome = dispatchLayers(event)
    if (afterHooks) {
      emitKeyAfter(afterHooks, event, release, afterFocused, outcome)
    }
  }

  function mutateDisambiguationResolvers(
    register: () => () => void,
    resolver: KeyDisambiguationResolver<TTarget, TEvent>,
  ): () => void {
    return notify.runWithStateChangeBatch(() => {
      const hadResolvers = state.disambiguationResolvers.has()
      const off = register()

      if (!hadResolvers && state.disambiguationResolvers.has()) {
        layers.recompileBindings()
      }

      return () => {
        notify.runWithStateChangeBatch(() => {
          const hadBeforeRemoval = state.disambiguationResolvers.has()
          off()

          if (state.disambiguationResolvers.values().includes(resolver)) {
            return
          }

          if (hadBeforeRemoval && !state.disambiguationResolvers.has()) {
            layers.recompileBindings()
          }
        })
      }
    })
  }

  function dispatchReleaseLayers(event: TEvent): KeyDispatchOutcome {
    const focused = activation.getFocusedTarget()
    const activeLayers = activation.getActiveLayers(focused)
    const matchKeys = resolveEventMatchKeys(event)
    let outcome = noMatchOutcome()

    for (const strokeKey of matchKeys) {
      layerLoop: for (const layer of activeLayers) {
        if (layer.bindings.length === 0) {
          continue
        }

        if (!conditions.matchesConditions(layer)) {
          continue
        }

        const result = runReleaseBindings(layer, strokeKey, event, focused)
        outcome = preferDispatchOutcome(outcome, result.outcome)
        if (!result.handled) {
          continue
        }

        if (result.stop) {
          return outcome
        }

        continue layerLoop
      }
    }

    return outcome
  }

  function dispatchLayers(event: TEvent): KeyDispatchOutcome {
    const focused = activation.getFocusedTarget()
    const pending = activation.ensureValidPendingSequence()
    const matchKeys = resolveEventMatchKeys(event)

    if (pending) {
      return dispatchPendingSequence(pending, matchKeys, event, focused)
    }

    const activeLayers = activation.getActiveLayers(focused)
    let outcome = noMatchOutcome()

    for (const matchKey of matchKeys) {
      const result = dispatchFromRoot(activeLayers, [matchKey], event, focused)
      outcome = preferDispatchOutcome(outcome, result)
      if (result.handled) {
        return outcome
      }
    }

    return outcome
  }

  function dispatchPendingSequence(
    pending: PendingSequenceState<TTarget, TEvent>,
    matchKeys: readonly KeyMatch[],
    event: TEvent,
    focused: TTarget | null,
  ): KeyDispatchOutcome {
    const activeView = catalog.getActiveCommandView(focused)
    const advancedCaptures: PendingSequenceCapture<TTarget, TEvent>[] = []

    for (const capture of pending.captures) {
      const advanced = advanceSequenceCapture(
        capture,
        matchKeys,
        event,
        state.patterns,
        matchPattern,
        createPatternEventPart,
      )
      if (!advanced) {
        continue
      }

      advancedCaptures.push(advanced)
    }

    const bestPriority = advancedCaptures.reduce(
      (best, capture) => Math.min(best, capturePriority(capture, matchKeys)),
      Number.POSITIVE_INFINITY,
    )
    const prioritizedCaptures = advancedCaptures.filter(
      (capture) => capturePriority(capture, matchKeys) === bestPriority,
    )

    if (
      prioritizedCaptures.length === 0 ||
      !prioritizedCaptures.some((capture) => captureIsReachable(capture, focused, activeView))
    ) {
      const outcome = createSequenceOutcome("sequence-miss", pending.captures)
      emitSequenceDispatch("sequence-clear", pending.captures, focused)
      activation.setPendingSequence(null)
      return outcome
    }

    return dispatchPendingCapturesFromIndex(prioritizedCaptures, 0, false, event, focused)
  }

  function dispatchPendingCapturesFromIndex(
    advancedCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    startIndex: number,
    handledExact: boolean,
    event: TEvent,
    focused: TTarget | null,
  ): KeyDispatchOutcome {
    let hasHandledExact = handledExact
    let outcome = noMatchOutcome()
    const processedExact = new Set<PendingSequenceCapture<TTarget, TEvent>>()

    for (let index = startIndex; index < advancedCaptures.length; index += 1) {
      const capture = advancedCaptures[index]
      if (!capture || processedExact.has(capture)) {
        continue
      }

      const continuationCapturesForPrefix = collectContinuationCapturesForPrefix(advancedCaptures, index, capture)
      if (continuationCapturesForPrefix.length > 0) {
        if (hasHandledExact) {
          continue
        }

        const exactCaptures = collectExactCapturesForPrefix(advancedCaptures, capture)
        const resolvedOutcome = tryResolvePendingAmbiguity(
          advancedCaptures,
          index,
          continuationCapturesForPrefix,
          exactCaptures,
          event,
          focused,
          hasHandledExact,
        )
        if (resolvedOutcome) {
          return resolvedOutcome
        }

        return holdSequence("sequence-advance", continuationCapturesForPrefix, focused, event)
      }

      if (!captureIsExact(capture, state.patterns)) {
        continue
      }

      const exactCaptures = collectExactCapturesForPrefix(advancedCaptures, capture)
      for (const exact of exactCaptures) processedExact.add(exact)
      const result = runCaptureBindings(capture.layer, exactCaptures, event, focused)
      outcome = preferDispatchOutcome(outcome, result.outcome)
      if (!result.handled) {
        continue
      }

      hasHandledExact = true
      if (result.stop) {
        emitSequenceDispatch("sequence-clear", advancedCaptures, focused)
        activation.setPendingSequence(null)
        return outcome
      }
    }

    emitSequenceDispatch("sequence-clear", advancedCaptures, focused)
    activation.setPendingSequence(null)
    return outcome
  }

  function dispatchFromRoot(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    matchKeys: readonly KeyMatch[],
    event: TEvent,
    focused: TTarget | null,
  ): KeyDispatchOutcome {
    return dispatchFromRootAtIndex(activeLayers, 0, matchKeys, event, focused)
  }

  function dispatchFromRootAtIndex(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    startIndex: number,
    matchKeys: readonly KeyMatch[],
    event: TEvent,
    focused: TTarget | null,
  ): KeyDispatchOutcome {
    const activeView = catalog.getActiveCommandView(focused)
    let outcome = noMatchOutcome()

    for (let index = startIndex; index < activeLayers.length; index += 1) {
      const layer = activeLayers[index]
      if (!layer) {
        continue
      }

      if (!conditions.matchesConditions(layer)) {
        continue
      }

      const captures = collectRootCaptures(layer, matchKeys, event, focused, activeView)
      if (captures.length === 0) {
        continue
      }

      const layerContinuationCaptures = captures.filter((capture) =>
        captureHasContinuations(capture, state.patterns, false),
      )
      if (layerContinuationCaptures.length > 0) {
        const exactCaptures = captures.filter((capture) => captureIsExact(capture, state.patterns))
        const continuationCaptures = collectPendingCapturesFromRoot(activeLayers, index, matchKeys, event, focused)
        const resolvedOutcome = tryResolveRootAmbiguity(
          activeLayers,
          index,
          matchKeys,
          continuationCaptures,
          exactCaptures,
          event,
          focused,
        )
        if (resolvedOutcome) {
          return resolvedOutcome
        }

        return holdSequence("sequence-start", continuationCaptures, focused, event)
      }

      const exactCaptures = captures.filter((capture) => captureIsExact(capture, state.patterns))
      const result = runCaptureBindings(layer, exactCaptures, event, focused)
      outcome = preferDispatchOutcome(outcome, result.outcome)
      if (!result.handled) {
        continue
      }

      if (result.stop) {
        return outcome
      }
    }

    return outcome
  }

  function tryResolveRootAmbiguity(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    layerIndex: number,
    matchKeys: readonly KeyMatch[],
    continuationCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    exactCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    event: TEvent,
    focused: TTarget | null,
  ): KeyDispatchOutcome | undefined {
    const applyExact = (): KeyDispatchOutcome => {
      activation.setPendingSequence(null)
      const layer = exactCaptures[0]?.layer
      if (!layer) return noMatchOutcome()
      const result = runCaptureBindings(layer, exactCaptures, event, focused)
      if (!result.stop) {
        return preferDispatchOutcome(
          result.outcome,
          dispatchFromRootAtIndex(activeLayers, layerIndex + 1, matchKeys, event, focused),
        )
      }

      return result.outcome
    }

    return tryResolveAmbiguity({
      event,
      focused,
      continuationCaptures,
      exactBindingsSource: exactCaptures.map((capture) => capture.binding),
      sequencePhase: "sequence-start",
      runExact: applyExact,
    })
  }

  function tryResolvePendingAmbiguity(
    advancedCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    captureIndex: number,
    continuationCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    exactCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    event: TEvent,
    focused: TTarget | null,
    handledExact: boolean,
  ): KeyDispatchOutcome | undefined {
    const applyExact = (): KeyDispatchOutcome => {
      activation.setPendingSequence(null)
      const layer = exactCaptures[0]?.layer
      if (!layer) return noMatchOutcome()
      const result = runCaptureBindings(layer, exactCaptures, event, focused)
      if (result.stop) {
        return result.outcome
      }

      return preferDispatchOutcome(
        result.outcome,
        dispatchPendingCapturesFromIndex(
          advancedCaptures,
          captureIndex + 1,
          handledExact || result.handled,
          event,
          focused,
        ),
      )
    }

    return tryResolveAmbiguity({
      event,
      focused,
      continuationCaptures,
      exactBindingsSource: exactCaptures.map((capture) => capture.binding),
      sequencePhase: "sequence-advance",
      runExact: applyExact,
    })
  }

  function tryResolveAmbiguity(options: {
    event: TEvent
    focused: TTarget | null
    continuationCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[]
    exactBindingsSource: readonly BindingState<TTarget, TEvent>[]
    sequencePhase: "sequence-start" | "sequence-advance"
    runExact: () => KeyDispatchOutcome
  }): KeyDispatchOutcome | undefined {
    const { event, focused, continuationCaptures, exactBindingsSource, sequencePhase, runExact } = options

    if (!state.disambiguationResolvers.has() || continuationCaptures.length === 0) {
      return undefined
    }

    const activeView = catalog.getActiveCommandView(focused)
    const exactBindings = activation.collectMatchingBindings(exactBindingsSource, focused, activeView)
    if (!exactBindings.some((binding) => binding.command !== undefined)) {
      return undefined
    }

    const continueSequence = (): KeyDispatchOutcome => {
      return holdSequence(sequencePhase, continuationCaptures, focused, event)
    }

    const clear = (): KeyDispatchOutcome => {
      return clearSequence("sequence-cleared", continuationCaptures, focused, event)
    }

    let sequence: ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]> | undefined
    const getSequence = (): ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]> => {
      sequence ??= activation.collectSequencePartsFromPending({ captures: continuationCaptures })
      return sequence
    }

    const decision = resolveDisambiguation({
      event,
      focused,
      getSequence,
      exactBindings,
      continuationCaptures,
      activeView,
    })

    if (!decision) {
      warnUnresolvedAmbiguity(getSequence())
      return continueSequence()
    }

    return applySyncDecision(decision, continuationCaptures, runExact, continueSequence, clear, focused, getSequence)
  }

  function applySyncDecision(
    decision: InternalDisambiguationDecision,
    continuationCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    runExact: () => KeyDispatchOutcome,
    continueSequence: () => KeyDispatchOutcome,
    clear: () => KeyDispatchOutcome,
    focused: TTarget | null,
    getSequence: () => ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]>,
  ): KeyDispatchOutcome {
    if (decision.action === "run-exact") {
      return runExact()
    }

    if (decision.action === "continue-sequence") {
      return continueSequence()
    }

    if (decision.action === "clear") {
      return clear()
    }

    const outcome = continueSequence()
    scheduleDeferredDisambiguation(continuationCaptures, decision.handler!, focused, getSequence(), (nextDecision) => {
      if (!nextDecision) {
        return
      }

      if (nextDecision.action === "run-exact") {
        runExact()
        return
      }

      if (nextDecision.action === "continue-sequence") {
        continueSequence()
        return
      }

      clear()
    })
    return outcome
  }

  function resolveDisambiguation(options: {
    event: TEvent
    focused: TTarget | null
    getSequence: () => ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]>
    exactBindings: readonly BindingState<TTarget, TEvent>[]
    continuationCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[]
    activeView: ReturnType<CommandCatalogService<TTarget, TEvent>["getActiveCommandView"]>
  }): InternalDisambiguationDecision | undefined {
    let sequence: ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]> | undefined
    let exact: readonly ActiveBinding<TTarget, TEvent>[] | undefined
    let continuations: readonly ActiveKey<TTarget, TEvent>[] | undefined
    let strokePart: KeyDisambiguationContext<TTarget, TEvent>["stroke"] | undefined

    const ctx: KeyDisambiguationContext<TTarget, TEvent> = {
      event: options.event as Readonly<Omit<TEvent, "preventDefault" | "stopPropagation">>,
      focused: options.focused,
      get sequence() {
        sequence ??= cloneKeySequence(options.getSequence())
        return sequence
      },
      get stroke() {
        const stroke = options.getSequence().at(-1)
        if (!stroke) {
          throw new Error("Disambiguation context expected a non-empty sequence")
        }

        strokePart ??= {
          ...stroke,
          stroke: cloneKeyStroke(stroke.stroke),
        }

        return strokePart
      },
      get exact() {
        exact ??= activation
          .collectActiveBindings(options.exactBindings, options.focused, options.activeView)
          .map((binding) => ({
            ...binding,
            sequence: cloneKeySequence(binding.sequence),
          }))

        return exact
      },
      get continuations() {
        continuations ??= activation.getActiveKeysForCaptures(options.continuationCaptures, {
          includeBindings: true,
          includeMetadata: true,
        })

        return continuations
      },
      getData: (name) => {
        return runtime.getData(name)
      },
      setData: (name, value) => {
        runtime.setData(name, value)
      },
      runExact: () => createSyncDecision("run-exact"),
      continueSequence: () => createSyncDecision("continue-sequence"),
      clear: () => createSyncDecision("clear"),
      defer: (run) => createSyncDecision("defer", run),
    }

    for (const resolver of state.disambiguationResolvers.values()) {
      let result: KeyDisambiguationDecision | undefined

      try {
        result = resolver(ctx)
      } catch (error) {
        notify.emitError("disambiguation-resolver-error", error, "[Keymap] Error in disambiguation resolver:")
        continue
      }

      if (result === undefined) {
        continue
      }

      if (isPromiseLike(result)) {
        notify.emitError(
          "invalid-disambiguation-resolver-return",
          result,
          "[Keymap] Disambiguation resolvers must return synchronously; use ctx.defer(...) for async handling",
        )
        continue
      }

      if (!isSyncDecision(result)) {
        notify.emitError(
          "invalid-disambiguation-decision",
          result,
          "[Keymap] Invalid disambiguation decision returned by resolver:",
        )
        continue
      }

      return result
    }

    return undefined
  }

  function scheduleDeferredDisambiguation(
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    handler: KeyDeferredDisambiguationHandler<TTarget, TEvent>,
    focused: TTarget | null,
    sequence: ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]>,
    apply: (decision: InternalDeferredDisambiguationDecision | void) => void,
  ): void {
    cancelPendingDisambiguation()

    const controller = new AbortController()
    const pending: PendingDisambiguation<TTarget, TEvent> = {
      id: nextPendingDisambiguationId++,
      controller,
      captures,
      apply,
    }
    pendingDisambiguation = pending

    queueMicrotask(() => {
      executeDeferredDisambiguation(pending, handler, focused, sequence)
    })
  }

  function executeDeferredDisambiguation(
    pending: PendingDisambiguation<TTarget, TEvent>,
    handler: KeyDeferredDisambiguationHandler<TTarget, TEvent>,
    focused: TTarget | null,
    sequence: ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]>,
  ): void {
    if (!isPendingDisambiguationCurrent(pending)) {
      return
    }

    const ctx: KeyDeferredDisambiguationContext<TTarget, TEvent> = {
      signal: pending.controller.signal,
      sequence: cloneKeySequence(sequence),
      focused,
      sleep: (ms) => {
        return sleepWithSignal(ms, pending.controller.signal)
      },
      runExact: () => createDeferredDecision("run-exact"),
      continueSequence: () => createDeferredDecision("continue-sequence"),
      clear: () => createDeferredDecision("clear"),
    }

    let result: KeyDeferredDisambiguationDecision | void | Promise<KeyDeferredDisambiguationDecision | void>
    try {
      result = handler(ctx)
    } catch (error) {
      if (isPendingDisambiguationCurrent(pending)) {
        notify.emitError("deferred-disambiguation-error", error, "[Keymap] Error in deferred disambiguation handler:")
        finishPendingDisambiguation(pending)
      }
      return
    }

    if (isPromiseLike(result)) {
      result
        .then((resolved) => {
          applyDeferredDisambiguationResult(pending, resolved)
        })
        .catch((error) => {
          if (!isPendingDisambiguationCurrent(pending)) {
            return
          }

          notify.emitError("deferred-disambiguation-error", error, "[Keymap] Error in deferred disambiguation handler:")
          finishPendingDisambiguation(pending)
        })
      return
    }

    applyDeferredDisambiguationResult(pending, result)
  }

  function applyDeferredDisambiguationResult(
    pending: PendingDisambiguation<TTarget, TEvent>,
    result: KeyDeferredDisambiguationDecision | void,
  ): void {
    if (!isPendingDisambiguationCurrent(pending)) {
      return
    }

    if (result !== undefined && !isDeferredDecision(result)) {
      notify.emitError(
        "invalid-deferred-disambiguation-decision",
        result,
        "[Keymap] Invalid deferred disambiguation decision returned by handler:",
      )
      finishPendingDisambiguation(pending)
      return
    }

    finishPendingDisambiguation(pending)
    pending.apply(result as InternalDeferredDisambiguationDecision | void)
  }

  function finishPendingDisambiguation(pending: PendingDisambiguation<TTarget, TEvent>): void {
    if (!isPendingDisambiguationCurrent(pending)) {
      return
    }

    pendingDisambiguation = null
  }

  function cancelPendingDisambiguation(): void {
    const pending = pendingDisambiguation
    if (!pending) {
      return
    }

    pendingDisambiguation = null
    pending.controller.abort()
  }

  function isPendingDisambiguationCurrent(pending: PendingDisambiguation<TTarget, TEvent>): boolean {
    return pendingDisambiguation === pending
  }

  function warnUnresolvedAmbiguity(
    sequence: ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]>,
  ): void {
    const display = stringifyKeySequence(sequence, { preferDisplay: true })

    notify.warnOnce(
      `unresolved-disambiguation:${display}`,
      "unresolved-disambiguation",
      { sequence: display },
      `[Keymap] Ambiguous exact/prefix sequence "${display}" fell back to prefix handling because no disambiguation resolver resolved it`,
    )
  }

  function collectPendingCapturesFromRoot(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    startIndex: number,
    matchKeys: readonly KeyMatch[],
    event: TEvent,
    focused: TTarget | null,
  ): PendingSequenceCapture<TTarget, TEvent>[] {
    const captures: PendingSequenceCapture<TTarget, TEvent>[] = []
    const activeView = catalog.getActiveCommandView(focused)

    for (let index = startIndex; index < activeLayers.length; index += 1) {
      const layer = activeLayers[index]
      if (!layer) {
        continue
      }

      if (!conditions.matchesConditions(layer)) {
        continue
      }

      for (const capture of collectRootCaptures(layer, matchKeys, event, focused, activeView)) {
        if (captureHasContinuations(capture, state.patterns, false)) {
          captures.push(capture)
        }
      }
    }

    return captures
  }

  function collectContinuationCapturesForPrefix(
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    startIndex: number,
    prefix: PendingSequenceCapture<TTarget, TEvent>,
  ): PendingSequenceCapture<TTarget, TEvent>[] {
    return captures.filter((candidate, candidateIndex) => {
      return (
        candidateIndex >= startIndex &&
        captureHasContinuations(candidate, state.patterns, false) &&
        sameParts(candidate.parts, prefix.parts)
      )
    })
  }

  function collectExactCapturesForPrefix(
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    prefix: PendingSequenceCapture<TTarget, TEvent>,
  ): PendingSequenceCapture<TTarget, TEvent>[] {
    return captures.filter((capture) => {
      return (
        capture.layer === prefix.layer &&
        captureIsExact(capture, state.patterns) &&
        sameParts(capture.parts, prefix.parts)
      )
    })
  }

  function resolveEventMatchKeys(event: TEvent): KeyMatch[] {
    const resolvers = state.eventMatchResolvers.values()

    if (resolvers.length === 0) {
      return []
    }

    if (resolvers.length === 1) {
      return resolveSingleEventMatchKeys(resolvers[0]!, event, eventMatchResolverContext, notify)
    }

    const keys: KeyMatch[] = []
    const seen = new Set<KeyMatch>()

    for (const resolver of resolvers) {
      let resolved: readonly KeyMatch[] | undefined

      try {
        resolved = resolver(event, eventMatchResolverContext)
      } catch (error) {
        notify.emitError("event-match-resolver-error", error, "[Keymap] Error in event match resolver:")
        continue
      }

      if (!resolved || resolved.length === 0) {
        continue
      }

      for (const candidate of resolved) {
        if (typeof candidate !== "string") {
          notify.emitError(
            "invalid-event-match-resolver-candidate",
            candidate,
            "[Keymap] Invalid event match resolver candidate:",
          )
          continue
        }

        if (seen.has(candidate)) {
          continue
        }

        seen.add(candidate)
        keys.push(candidate)
      }
    }

    return keys
  }

  function runReleaseBindings(
    layer: RegisteredLayer<TTarget, TEvent>,
    strokeKey: KeyMatch,
    event: TEvent,
    focused: TTarget | null,
  ): { handled: boolean; stop: boolean; outcome: KeyDispatchOutcome } {
    let handled = false
    let outcome = noMatchOutcome()

    for (const binding of layer.bindings) {
      if (binding.event !== "release") {
        continue
      }

      const firstPart = binding.sequence[0]
      if (!firstPart || firstPart.match !== strokeKey) {
        continue
      }

      if (!conditions.matchesConditions(binding)) {
        continue
      }

      const bindingHandled = executor.runBinding(layer, binding, event, focused)
      outcome = preferDispatchOutcome(outcome, createBindingOutcome(binding, bindingHandled))
      if (!bindingHandled) {
        emitBindingDispatch("binding-reject", layer, binding, focused)
        continue
      }

      emitBindingDispatch("binding-execute", layer, binding, focused)
      handled = true
      if (!binding.fallthrough) {
        return { handled: true, stop: true, outcome }
      }
    }

    return { handled, stop: false, outcome }
  }

  function matchPattern(patternName: string, event: TEvent) {
    return matchSequencePattern(state.patterns, notify, patternName, event)
  }

  function createPatternEventPart(
    event: TEvent,
    patternName: string,
    match: NonNullable<ReturnType<typeof matchPattern>>,
  ) {
    return createPatternEventPartFromPattern(state.patterns, event, patternName, match)
  }

  function collectRootCaptures(
    layer: RegisteredLayer<TTarget, TEvent>,
    matchKeys: readonly KeyMatch[],
    event: TEvent,
    focused: TTarget | null,
    activeView: ReturnType<CommandCatalogService<TTarget, TEvent>["getActiveCommandView"]>,
  ): PendingSequenceCapture<TTarget, TEvent>[] {
    const captures = collectRootSequenceCaptures(layer, matchKeys, event, matchPattern, createPatternEventPart)
    return captures.some((capture) => captureIsReachable(capture, focused, activeView)) ? captures : []
  }

  function createSequencePayload(capture?: PendingSequenceCapture<TTarget, TEvent>): unknown {
    return createSequencePayloadFromPattern(state.patterns, notify, capture)
  }

  function bindingMatchesRuntimeState(
    binding: BindingState<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ReturnType<CommandCatalogService<TTarget, TEvent>["getActiveCommandView"]>,
  ): boolean {
    return conditions.matchesConditions(binding) && catalog.isBindingVisible(binding, focused, activeView)
  }

  function captureIsReachable(
    capture: PendingSequenceCapture<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ReturnType<CommandCatalogService<TTarget, TEvent>["getActiveCommandView"]>,
  ): boolean {
    return bindingMatchesRuntimeState(capture.binding, focused, activeView)
  }

  function runCaptureBindings(
    layer: RegisteredLayer<TTarget, TEvent>,
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    event: TEvent,
    focused: TTarget | null,
  ): { handled: boolean; stop: boolean; outcome: KeyDispatchOutcome } {
    let handled = false
    let outcome = noMatchOutcome()

    for (const capture of captures) {
      const binding = capture.binding
      if (!conditions.matchesConditions(binding)) {
        continue
      }

      const bindingHandled = executor.runBinding(layer, binding, event, focused, createSequencePayload(capture))
      outcome = preferDispatchOutcome(outcome, createBindingOutcome(binding, bindingHandled))
      if (!bindingHandled) {
        emitBindingDispatch("binding-reject", layer, binding, focused)
        continue
      }

      emitBindingDispatch("binding-execute", layer, binding, focused)
      handled = true
      if (!binding.fallthrough) {
        return { handled: true, stop: true, outcome }
      }
    }

    return { handled, stop: false, outcome }
  }

  return {
    intercept,
    prependEventMatchResolver,
    appendEventMatchResolver,
    clearEventMatchResolvers,
    prependDisambiguationResolver,
    appendDisambiguationResolver,
    clearDisambiguationResolvers,
    handlePendingSequenceChange,
    handleRawSequence,
    handleKeyEvent,
  }
}

function resolveSingleEventMatchKeys<TTarget extends object, TEvent extends KeymapEvent>(
  resolver: EventMatchResolver<TEvent>,
  event: TEvent,
  ctx: EventMatchResolverContext,
  notify: NotificationService<TTarget, TEvent>,
): KeyMatch[] {
  let resolved: readonly KeyMatch[] | undefined
  try {
    resolved = resolver(event, ctx)
  } catch (error) {
    notify.emitError("event-match-resolver-error", error, "[Keymap] Error in event match resolver:")
    return []
  }

  if (!resolved || resolved.length === 0) {
    return []
  }

  if (resolved.length === 1) {
    const [candidate] = resolved
    if (typeof candidate !== "string") {
      notify.emitError(
        "invalid-event-match-resolver-candidate",
        candidate,
        "[Keymap] Invalid event match resolver candidate:",
      )
      return []
    }

    return [candidate]
  }

  const keys: KeyMatch[] = []
  const seen = new Set<KeyMatch>()
  for (const candidate of resolved) {
    if (typeof candidate !== "string") {
      notify.emitError(
        "invalid-event-match-resolver-candidate",
        candidate,
        "[Keymap] Invalid event match resolver candidate:",
      )
      continue
    }

    if (seen.has(candidate)) {
      continue
    }

    seen.add(candidate)
    keys.push(candidate)
  }

  return keys
}

function sameParts(left: readonly KeySequencePart[], right: readonly KeySequencePart[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.match !== right[index]?.match) {
      return false
    }
  }

  return true
}
