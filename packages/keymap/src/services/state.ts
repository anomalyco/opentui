import type {
  Attributes,
  BindingExpander,
  BindingFieldCompiler,
  LayerBindingsTransformer,
  BindingParser,
  BindingTransformer,
  Command,
  CommandFieldCompiler,
  CommandTransformer,
  CommandResolver,
  EventData,
  KeyDisambiguationResolver,
  EventMatchResolver,
  Hooks,
  KeyAfterInputContext,
  KeyInputContext,
  KeymapEvent,
  LayerFieldCompiler,
  PendingSequenceState,
  RawInputContext,
  ResolvedSequencePattern,
  CommandState,
  RegisteredLayer,
} from "../types.js"
import {
  createRuntimeOrderedRegistry,
  createRuntimePriorityRegistry,
  type RuntimeOrderedRegistry,
  type RuntimePriorityRegistry,
} from "../lib/runtime-utils.js"

const EMPTY_DATA: Readonly<EventData> = Object.freeze({})

export interface LayerCommandEntry<TTarget extends object, TEvent extends KeymapEvent> {
  layer: RegisteredLayer<TTarget, TEvent>
  commandState: CommandState<TTarget, TEvent>
}

export interface ResolvedCommandEntry<TTarget extends object, TEvent extends KeymapEvent> {
  target?: TTarget
  command: Command<TTarget, TEvent>
  attrs?: Readonly<Attributes>
  input?: string
  payload?: unknown
}

export interface ActiveCommandView<TTarget extends object, TEvent extends KeymapEvent> {
  layers: readonly RegisteredLayer<TTarget, TEvent>[]
  entries: readonly LayerCommandEntry<TTarget, TEvent>[]
  reachable: readonly LayerCommandEntry<TTarget, TEvent>[]
  reachableByName: ReadonlyMap<string, LayerCommandEntry<TTarget, TEvent>>
  chainsByName: ReadonlyMap<string, readonly LayerCommandEntry<TTarget, TEvent>[]>
}

export interface CommandView<TTarget extends object, TEvent extends KeymapEvent> {
  entries: readonly LayerCommandEntry<TTarget, TEvent>[]
  chainsByName: ReadonlyMap<string, readonly LayerCommandEntry<TTarget, TEvent>[]>
}

export interface State<TTarget extends object, TEvent extends KeymapEvent> {
  order: number
  tokens: Map<string, import("../types.js").ResolvedKeyToken>
  patterns: Map<string, ResolvedSequencePattern<TEvent>>
  layerFields: Map<string, LayerFieldCompiler>
  layerBindingsTransformers: RuntimeOrderedRegistry<LayerBindingsTransformer<TTarget, TEvent>>
  bindingExpanders: RuntimeOrderedRegistry<BindingExpander>
  bindingParsers: RuntimeOrderedRegistry<BindingParser>
  bindingTransformers: RuntimeOrderedRegistry<BindingTransformer<TTarget, TEvent>>
  bindingFields: Map<string, BindingFieldCompiler>
  commandTransformers: RuntimeOrderedRegistry<CommandTransformer<TTarget, TEvent>>
  commandFields: Map<string, CommandFieldCompiler>
  eventMatchResolvers: RuntimeOrderedRegistry<EventMatchResolver<TEvent>>
  disambiguationResolvers: RuntimeOrderedRegistry<KeyDisambiguationResolver<TTarget, TEvent>>
  keyHooks: RuntimePriorityRegistry<(ctx: KeyInputContext<TEvent>) => void, { priority: number; release: boolean }>
  keyAfterHooks: RuntimePriorityRegistry<
    (ctx: KeyAfterInputContext<TTarget, TEvent>) => void,
    { priority: number; release: boolean }
  >
  rawHooks: RuntimePriorityRegistry<(ctx: RawInputContext) => void, { priority: number }>
  layers: Set<RegisteredLayer<TTarget, TEvent>>
  sortedLayers: RegisteredLayer<TTarget, TEvent>[]
  activeLayersCacheVersion: number
  activeLayersCacheFocused: TTarget | null | undefined
  activeLayersCache: RegisteredLayer<TTarget, TEvent>[]
  activeKeyCacheBlockers: number
  activeCommandViewCacheBlockers: number
  commandResolvers: RuntimeOrderedRegistry<CommandResolver<TTarget, TEvent>>
  pending: PendingSequenceState<TTarget, TEvent> | null
  data: EventData
  dataVersion: number
  readonlyDataVersion: number
  readonlyData: Readonly<EventData>
  cacheVersion: number
  derivedVersion: number
  stateChangeDepth: number
  stateChangePending: boolean
  flushingStateChange: boolean
  usedWarningKeys: Set<string>
}

export function createKeymapState<TTarget extends object, TEvent extends KeymapEvent>(): State<TTarget, TEvent> {
  return {
    order: 0,
    tokens: new Map<string, import("../types.js").ResolvedKeyToken>(),
    patterns: new Map<string, ResolvedSequencePattern<TEvent>>(),
    layerFields: new Map<string, LayerFieldCompiler>(),
    layerBindingsTransformers: createRuntimeOrderedRegistry<LayerBindingsTransformer<TTarget, TEvent>>(),
    bindingExpanders: createRuntimeOrderedRegistry<BindingExpander>(),
    bindingParsers: createRuntimeOrderedRegistry<BindingParser>(),
    bindingTransformers: createRuntimeOrderedRegistry<BindingTransformer<TTarget, TEvent>>(),
    bindingFields: new Map<string, BindingFieldCompiler>(),
    commandTransformers: createRuntimeOrderedRegistry<CommandTransformer<TTarget, TEvent>>(),
    commandFields: new Map<string, CommandFieldCompiler>(),
    eventMatchResolvers: createRuntimeOrderedRegistry<EventMatchResolver<TEvent>>(),
    disambiguationResolvers: createRuntimeOrderedRegistry<KeyDisambiguationResolver<TTarget, TEvent>>(),
    keyHooks: createRuntimePriorityRegistry<
      (ctx: KeyInputContext<TEvent>) => void,
      { priority: number; release: boolean }
    >(),
    keyAfterHooks: createRuntimePriorityRegistry<
      (ctx: KeyAfterInputContext<TTarget, TEvent>) => void,
      { priority: number; release: boolean }
    >(),
    rawHooks: createRuntimePriorityRegistry<(ctx: RawInputContext) => void, { priority: number }>(),
    layers: new Set<RegisteredLayer<TTarget, TEvent>>(),
    sortedLayers: [],
    activeLayersCacheVersion: -1,
    activeLayersCacheFocused: undefined,
    activeLayersCache: [],
    activeKeyCacheBlockers: 0,
    activeCommandViewCacheBlockers: 0,
    commandResolvers: createRuntimeOrderedRegistry<CommandResolver<TTarget, TEvent>>(),
    pending: null,
    data: {},
    dataVersion: 0,
    readonlyDataVersion: -1,
    readonlyData: EMPTY_DATA,
    cacheVersion: 0,
    derivedVersion: 0,
    stateChangeDepth: 0,
    stateChangePending: false,
    flushingStateChange: false,
    usedWarningKeys: new Set<string>(),
  }
}
