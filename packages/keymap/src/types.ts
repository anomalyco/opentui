import type { Keymap } from "./keymap.js"

export interface KeymapEvent {
  name: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  super?: boolean
  hyper?: boolean
  preventDefault(): void
  stopPropagation(): void
  readonly propagationStopped: boolean
}

export type HostPlatform = "macos" | "windows" | "linux" | "unknown"

export type HostModifier = "ctrl" | "shift" | "meta" | "super" | "hyper"

export type HostCapability = "supported" | "unsupported" | "unknown"

export interface HostMetadata {
  platform: HostPlatform
  primaryModifier: "ctrl" | "super" | "unknown"
  modifiers: Record<HostModifier, HostCapability>
}

export interface KeymapHost<TTarget extends object, TEvent extends KeymapEvent = KeymapEvent> {
  readonly metadata: HostMetadata
  readonly rootTarget: TTarget
  readonly isDestroyed: boolean
  getFocusedTarget(): TTarget | null
  getParentTarget(target: TTarget): TTarget | null
  isTargetDestroyed(target: TTarget): boolean
  onKeyPress(listener: (event: TEvent) => void): () => void
  onKeyRelease(listener: (event: TEvent) => void): () => void
  onFocusChange(listener: (target: TTarget | null) => void): () => void
  /** Optional for hosts whose lifetime is managed by GC or root reachability. */
  onDestroy?(listener: () => void): () => void
  onTargetDestroy(target: TTarget, listener: () => void): () => void
  onRawInput?(listener: (sequence: string) => boolean): () => void
  createCommandEvent(): TEvent
}

export type EventData = Record<string, unknown>

export type Attributes = Record<string, unknown>

export interface KeyStrokeInput {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
  hyper?: boolean
}

export interface NormalizedKeyStroke extends KeyStrokeInput {
  ctrl: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export type KeyMatch = string

export interface EventMatchResolverContext {
  resolveKey(key: KeyLike): KeyMatch
}

export type EventMatchResolver<TEvent extends KeymapEvent = KeymapEvent> = (
  event: TEvent,
  ctx: EventMatchResolverContext,
) => readonly KeyMatch[] | undefined

export const KEY_DISAMBIGUATION_DECISION = Symbol("keymap-disambiguation-decision")
export const KEY_DEFERRED_DISAMBIGUATION_DECISION = Symbol("keymap-deferred-disambiguation-decision")

export interface KeyDisambiguationDecision {
  readonly [KEY_DISAMBIGUATION_DECISION]: true
}

export interface KeyDeferredDisambiguationDecision {
  readonly [KEY_DEFERRED_DISAMBIGUATION_DECISION]: true
}

export interface KeyDisambiguationContext<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  readonly event: Readonly<Omit<TEvent, "preventDefault" | "stopPropagation">>
  readonly focused: TTarget | null
  readonly sequence: readonly KeySequencePart[]
  readonly stroke: KeySequencePart
  readonly exact: readonly ActiveBinding<TTarget, TEvent>[]
  readonly continuations: readonly ActiveKey<TTarget, TEvent>[]
  getData(name: string): unknown
  setData(name: string, value: unknown): void
  runExact(): KeyDisambiguationDecision
  continueSequence(): KeyDisambiguationDecision
  clear(): KeyDisambiguationDecision
  defer(run: KeyDeferredDisambiguationHandler<TTarget, TEvent>): KeyDisambiguationDecision
}

export interface KeyDeferredDisambiguationContext<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> {
  readonly signal: AbortSignal
  readonly sequence: readonly KeySequencePart[]
  readonly focused: TTarget | null
  sleep(ms: number): Promise<boolean>
  runExact(): KeyDeferredDisambiguationDecision
  continueSequence(): KeyDeferredDisambiguationDecision
  clear(): KeyDeferredDisambiguationDecision
}

export type KeyDeferredDisambiguationHandler<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> = (
  ctx: KeyDeferredDisambiguationContext<TTarget, TEvent>,
) => KeyDeferredDisambiguationDecision | void | Promise<KeyDeferredDisambiguationDecision | void>

export type KeyDisambiguationResolver<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  ctx: KeyDisambiguationContext<TTarget, TEvent>,
) => KeyDisambiguationDecision | undefined

export interface ResolvedKeyToken {
  stroke: NormalizedKeyStroke
  match: KeyMatch
}

export interface KeySequencePart {
  stroke: NormalizedKeyStroke
  display: string
  match: KeyMatch
  tokenName?: string
  patternName?: string
  payloadKey?: string
}

export interface StringifyOptions {
  preferDisplay?: boolean
  separator?: string
}

export type KeyStringifyInput =
  | KeyStrokeInput
  | NormalizedKeyStroke
  | KeySequencePart
  | { stroke: NormalizedKeyStroke; display?: string }

export type KeyLike = string | KeyStrokeInput

/**
 * Public command shape used for layer registration, command queries, command
 * contexts, and command resolver results. Custom command fields are top-level
 * properties so registration stays as simple as `{ name, run, desc }`.
 */
export interface Command<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
  TPayload = unknown,
> {
  name: string
  run(ctx: CommandContext<TTarget, TEvent, TPayload>): CommandResult<TTarget, TEvent>
  [key: string]: unknown
}

export type CommandQueryValue<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | unknown
  | readonly unknown[]
  | ((value: unknown, command: Command<TTarget, TEvent>) => boolean)

export type CommandFilter<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | Readonly<Record<string, CommandQueryValue<TTarget, TEvent>>>
  | ((command: Command<TTarget, TEvent>) => boolean)

export interface CommandQuery<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  visibility?: "reachable" | "active" | "registered"
  focused?: TTarget | null
  namespace?: string | readonly string[]
  search?: string
  searchIn?: readonly string[]
  filter?: CommandFilter<TTarget, TEvent>
  limit?: number
}

export interface CommandBindingsQuery<TTarget extends object = object> {
  visibility?: "reachable" | "active" | "registered"
  focused?: TTarget | null
  commands: readonly string[]
}

export interface RunCommandOptions<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  event?: TEvent
  focused?: TTarget | null
  target?: TTarget | null
  includeCommand?: boolean
  payload?: unknown
}

export type RunCommandResult<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | { ok: true; command?: Command<TTarget, TEvent> }
  | { ok: false; reason: "not-found" }
  | {
      ok: false
      reason: "inactive" | "disabled" | "invalid-args" | "rejected" | "error"
      command?: Command<TTarget, TEvent>
    }

export interface CommandContext<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
  TPayload = unknown,
> {
  keymap: Keymap<TTarget, TEvent>
  event: TEvent
  focused: TTarget | null
  target: TTarget | null
  data: Readonly<EventData>
  command?: Command<TTarget, TEvent, TPayload>
  input: string
  payload: TPayload
}

export type CommandResult<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | boolean
  | void
  | RunCommandResult<TTarget, TEvent>
  | Promise<boolean | void | RunCommandResult<TTarget, TEvent>>

export type CommandResolutionStatus = "resolved" | "unresolved" | "error"

export type CommandHandler<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
  TPayload = unknown,
> = (ctx: CommandContext<TTarget, TEvent, TPayload>) => CommandResult<TTarget, TEvent>

export type BindingCommand<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | string
  | CommandHandler<TTarget, TEvent>

export type BindingEvent = "press" | "release"

export interface Binding<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  key: KeyLike
  cmd?: BindingCommand<TTarget, TEvent>
  event?: BindingEvent
  /**
   * Default `true`. Calls `event.preventDefault()` and
   * `event.stopPropagation()` so the matched key does not reach the focused
   * target or later host listeners. Independent of `fallthrough`, which only
   * controls dispatch inside the keymap. Set `preventDefault: false` if you
   * want a fallthrough binding to keep matching inside the keymap and still let
   * the key escape to later handlers.
   */
  preventDefault?: boolean
  /**
   * Default `false`. Continues to later matching bindings in the same
   * dispatch chain after this command runs. Independent of `preventDefault`,
   * which controls whether the key event leaves the keymap.
   */
  fallthrough?: boolean
  [key: string]: unknown
}

export type Bindings<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = readonly Binding<
  TTarget,
  TEvent
>[]

export type TargetMode = "focus" | "focus-within"

export interface Layer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  target?: TTarget
  priority?: number
  bindings?: Bindings<TTarget, TEvent>
  commands?: readonly Command<TTarget, TEvent, any>[]
  targetMode?: TargetMode
  /**
   * Extra layer fields feed layer-field compilers and binding compilation via
   * `BindingParserContext.layer` / `BindingTransformerContext.layer`. Unlike
   * binding and command fields, layer fields do not compile into public attrs.
   */
  [key: string]: unknown
}

export interface ParsedCommand {
  input: string
  name: string
  args: string[]
}

export interface CommandResolverContext<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  readonly input: string
  readonly payload: unknown
  setInput(input: string): void
  setPayload(payload: unknown): void
  getCommand(name: string): Command<TTarget, TEvent> | undefined
}

export type CommandResolver<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  command: string,
  ctx: CommandResolverContext<TTarget, TEvent>,
) => Command<TTarget, TEvent> | undefined

export interface KeyToken {
  name: string
  key: KeyLike
}

export interface SequencePatternMatch {
  value?: unknown
  display?: string
}

export interface SequencePattern<TEvent extends KeymapEvent = KeymapEvent> {
  name: string
  display?: string
  payloadKey?: string
  min?: number
  max?: number
  match(event: TEvent): SequencePatternMatch | undefined
  finalize?(values: readonly unknown[]): unknown
}

export interface ResolvedSequencePattern<TEvent extends KeymapEvent = KeymapEvent> {
  name: string
  display?: string
  payloadKey: string
  match: KeyMatch
  min: number
  max: number
  matcher(event: TEvent): SequencePatternMatch | undefined
  finalize?: (values: readonly unknown[]) => unknown
}

export interface ActiveBinding<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  sequence: KeySequencePart[]
  command?: BindingCommand<TTarget, TEvent>
  commandAttrs?: Readonly<Attributes>
  attrs?: Readonly<Attributes>
  event: BindingEvent
  preventDefault: boolean
  fallthrough: boolean
}

export interface DispatchLayer<TTarget extends object = object> {
  order: number
  priority: number
  target?: TTarget
  targetMode?: TargetMode
}

export interface DispatchBinding<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> extends ActiveBinding<TTarget, TEvent> {
  sourceLayerOrder: number
  bindingIndex: number
}

export type DispatchPhase =
  | "sequence-start"
  | "sequence-advance"
  | "sequence-clear"
  | "binding-execute"
  | "binding-reject"

export interface DispatchEvent<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  phase: DispatchPhase
  event: BindingEvent
  focused: TTarget | null
  layer?: DispatchLayer<TTarget>
  binding?: DispatchBinding<TTarget, TEvent>
  sequence: readonly KeySequencePart[]
  command?: BindingCommand<TTarget, TEvent>
}

export type KeyAfterReason =
  | "intercept-consumed"
  | "binding-handled"
  | "binding-rejected"
  | "no-match"
  | "sequence-pending"
  | "sequence-miss"
  | "sequence-cleared"

export interface KeyAfterInputContext<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  event: TEvent
  eventType: BindingEvent
  focused: TTarget | null
  handled: boolean
  reason: KeyAfterReason
  sequence: readonly KeySequencePart[]
  pendingSequence: readonly KeySequencePart[]
  setData: (name: string, value: unknown) => void
  getData: (name: string) => unknown
  consume: (options?: { preventDefault?: boolean; stopPropagation?: boolean }) => void
}

/**
 * Command metadata together with the bindings that invoke it in a given query
 * projection.
 */
export interface CommandEntry<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  command: Command<TTarget, TEvent>
  bindings: readonly ActiveBinding<TTarget, TEvent>[]
}

export interface ActiveKeyOptions {
  includeBindings?: boolean
  includeMetadata?: boolean
}

export interface ActiveKey<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  stroke: NormalizedKeyStroke
  display: string
  tokenName?: string
  bindings?: ActiveBinding<TTarget, TEvent>[]
  bindingAttrs?: Readonly<Attributes>
  commandAttrs?: Readonly<Attributes>
  command?: BindingCommand<TTarget, TEvent>
  continues: boolean
}

/**
 * Boolean source with subscription-based invalidation. `ctx.activeWhen(...)`
 * subscribes at registration time and unsubscribes when the owning
 * layer or binding is removed.
 */
export interface ReactiveMatcher {
  get(): boolean
  subscribe(onChange: () => void): () => void
}

export interface BindingFieldContext {
  require(name: string, value: unknown): void
  attr(name: string, value: unknown): void
  /**
   * Registers a runtime matcher. Matchers are evaluated when the owning
   * record is queried or dispatched; reactive matchers also notify state
   * subscribers when their external source changes.
   */
  activeWhen(matcher: (() => boolean) | ReactiveMatcher): void
}

export type BindingFieldCompiler = (value: unknown, ctx: BindingFieldContext) => void

export interface LayerFieldContext {
  require(name: string, value: unknown): void
  attr(name: string, value: unknown): void
  /**
   * Registers a runtime matcher. Matchers are evaluated when the owning
   * record is queried or dispatched; reactive matchers also notify state
   * subscribers when their external source changes.
   */
  activeWhen(matcher: (() => boolean) | ReactiveMatcher): void
}

export type LayerFieldCompiler = (value: unknown, ctx: LayerFieldContext) => void

export interface LayerAnalysisContext<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  target?: TTarget
  order: number
  sourceBindings: readonly Binding<TTarget, TEvent>[]
  bindings: readonly LayerBindingAnalysis<TTarget, TEvent>[]
  hasTokenBindings: boolean
  checkCommandResolution(command: string): CommandResolutionStatus
  warn(code: string, warning: unknown, message: string): void
  warnOnce(key: string, code: string, warning: unknown, message: string): void
  error(code: string, error: unknown, message: string): void
}

export interface LayerBindingAnalysis<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  sequence: KeySequencePart[]
  command?: BindingCommand<TTarget, TEvent>
  attrs?: Readonly<Attributes>
  event: BindingEvent
  preventDefault: boolean
  fallthrough: boolean
  parsedBinding: ParsedBinding<TTarget, TEvent>
  sourceTarget?: TTarget
  sourceLayerOrder: number
  bindingIndex: number
  hasCommandAtSequence: boolean
  hasContinuations: boolean
}

export type LayerAnalyzer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  ctx: LayerAnalysisContext<TTarget, TEvent>,
) => void

export interface BindingParserContext {
  input: string
  index: number
  layer: Readonly<Record<string, unknown>>
  tokens: ReadonlyMap<string, ResolvedKeyToken>
  patterns: ReadonlyMap<string, ResolvedSequencePattern>
  normalizeTokenName(token: string): string
  createMatch(id: string): KeyMatch
  parseObjectKey(
    key: KeyStrokeInput,
    options?: {
      display?: string
      match?: KeyMatch
      tokenName?: string
    },
  ): KeySequencePart
}

export interface BindingExpanderContext {
  input: string
  displays?: readonly string[]
  layer: Readonly<Record<string, unknown>>
}

export interface BindingExpansion {
  key: string
  displays?: readonly string[]
}

export interface BindingParserResult {
  parts: KeySequencePart[]
  nextIndex: number
  usedTokens?: readonly string[]
  unknownTokens?: readonly string[]
}

export type BindingParser = (ctx: BindingParserContext) => BindingParserResult | undefined

export type BindingExpander = (ctx: BindingExpanderContext) => readonly BindingExpansion[] | undefined

export interface ParsedBinding<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  key: KeyLike
  sequence: KeySequencePart[]
  cmd?: BindingCommand<TTarget, TEvent>
  event?: BindingEvent
  preventDefault?: boolean
  fallthrough?: boolean
  [key: string]: unknown
}

export interface BindingTransformerContext<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  layer: Readonly<Record<string, unknown>>
  parseKey(key: KeyLike): KeySequencePart
  add(binding: ParsedBinding<TTarget, TEvent>): void
  skipOriginal(): void
}

export type BindingTransformer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  binding: ParsedBinding<TTarget, TEvent>,
  ctx: BindingTransformerContext<TTarget, TEvent>,
) => void

export type BindingsValidationResult = { ok: true } | { ok: false; reason: string }

export interface LayerBindingsTransformerContext<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> {
  layer: Readonly<Layer<TTarget, TEvent>>
  validateBindings(bindings: unknown): BindingsValidationResult
}

export type LayerBindingsTransformer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  bindings: readonly Binding<TTarget, TEvent>[],
  ctx: LayerBindingsTransformerContext<TTarget, TEvent>,
) => readonly Binding<TTarget, TEvent>[] | void

export interface CommandTransformerContext<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  layer: Readonly<Layer<TTarget, TEvent>>
  add(command: Command<TTarget, TEvent>): void
  skipOriginal(): void
}

export type CommandTransformer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  command: Command<TTarget, TEvent>,
  ctx: CommandTransformerContext<TTarget, TEvent>,
) => void

export interface CommandFieldContext {
  require(name: string, value: unknown): void
  attr(name: string, value: unknown): void
  /**
   * Registers a runtime matcher. Matchers are evaluated when the owning
   * record is queried or dispatched; reactive matchers also notify state
   * subscribers when their external source changes.
   */
  activeWhen(matcher: (() => boolean) | ReactiveMatcher): void
}

export type CommandFieldCompiler = (value: unknown, ctx: CommandFieldContext) => void

export interface KeyInputContext<TEvent extends KeymapEvent = KeymapEvent> {
  event: TEvent
  setData: (name: string, value: unknown) => void
  getData: (name: string) => unknown
  consume: (options?: { preventDefault?: boolean; stopPropagation?: boolean }) => void
}

export interface RawInputContext {
  sequence: string
  stop: () => void
}

export type Hooks<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = {
  /**
   * Batched "derived state may have changed" signal. Re-read through getters;
   * framework adapters should use this event.
   */
  state: void
  /**
   * Synchronous pending-sequence updates, including clear. Payload is the
   * current sequence.
   */
  pendingSequence: readonly KeySequencePart[]
  /** Dispatch trace events for sequence continuation and binding execution. */
  dispatch: DispatchEvent<TTarget, TEvent>
}

export type HookName = keyof Hooks

export type Listener<TValue> = [TValue] extends [void] ? () => void : (value: TValue) => void

export interface WarningEvent {
  code: string
  message: string
  warning: unknown
}

export interface ErrorEvent {
  code: string
  message: string
  error: unknown
}

/** Events exposed by `keymap.on(...)`. `state` is batched and `pendingSequence` is synchronous. */
export type Events<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = Hooks<
  TTarget,
  TEvent
> & {
  warning: WarningEvent
  error: ErrorEvent
}

export type EventName = keyof Events

export type Intercepts<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = {
  key: KeyInputContext<TEvent>
  "key:after": KeyAfterInputContext<TTarget, TEvent>
  raw: RawInputContext
}

export type InterceptName = keyof Intercepts

export interface KeyInterceptOptions {
  priority?: number
  release?: boolean
}

export interface RawInterceptOptions {
  priority?: number
}

export type { Keymap }

export interface RuntimeMatcher {
  source: string
  match: () => boolean
  /**
   * Present for reactive matchers; wired during registration and torn down via
   * `dispose`.
   */
  subscribe?: (onChange: () => void) => () => void
  dispose?: () => void
}

export interface RuntimeMatchable {
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
}

export interface BindingState<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent>
  extends ActiveBinding<TTarget, TEvent>, RuntimeMatchable {
  binding: Binding<TTarget, TEvent>
  run?: CommandHandler<TTarget, TEvent>
  parsedBinding: ParsedBinding<TTarget, TEvent>
  sourceTarget?: TTarget
  sourceLayerOrder: number
  bindingIndex: number
}

export interface ActiveKeySelection<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  display: string
  tokenName?: string
  continues: boolean
  firstBinding?: BindingState<TTarget, TEvent>
  commandBinding?: BindingState<TTarget, TEvent>
  bindings?: readonly BindingState<TTarget, TEvent>[]
  stop: boolean
}

export interface ActiveKeyState<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  stroke: NormalizedKeyStroke
  display: string
  tokenName?: string
  continues: boolean
  firstBinding?: BindingState<TTarget, TEvent>
  commandBinding?: BindingState<TTarget, TEvent>
  bindings?: BindingState<TTarget, TEvent>[]
}

export interface CommandState<
  TTarget extends object = object,
  TEvent extends KeymapEvent = KeymapEvent,
> extends RuntimeMatchable {
  command: Command<TTarget, TEvent, any>
  fields: Readonly<Record<string, unknown>>
  attrs?: Readonly<Attributes>
}

export interface BindingCompilationResult<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  bindings: readonly BindingState<TTarget, TEvent>[]
  hasTokenBindings: boolean
}

export interface SequenceNode<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  parent: SequenceNode<TTarget, TEvent> | null
  depth: number
  stroke: NormalizedKeyStroke | null
  match: KeyMatch | null
  pattern?: ResolvedSequencePattern<TEvent>
  children: Map<KeyMatch, SequenceNode<TTarget, TEvent>>
  patternChildren: SequenceNode<TTarget, TEvent>[]
  bindings: BindingState<TTarget, TEvent>[]
  reachableBindings: BindingState<TTarget, TEvent>[]
}

export interface RegisteredLayer<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  order: number
  target?: TTarget
  targetMode?: TargetMode
  priority: number
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  fields?: Readonly<Record<string, unknown>>
  attrs?: Readonly<Attributes>
  commands: readonly CommandState<TTarget, TEvent>[]
  sourceBindings: readonly Binding<TTarget, TEvent>[]
  bindings: readonly BindingState<TTarget, TEvent>[]
  root: SequenceNode<TTarget, TEvent>
  hasTokenBindings: boolean
  activeKeyCacheBlocked: boolean
  activeCommandViewCacheBlocked: boolean
  offTargetDestroy?: () => void
}

export interface PendingSequenceCapture<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  layer: RegisteredLayer<TTarget, TEvent>
  binding: BindingState<TTarget, TEvent>
  index: number
  parts: readonly KeySequencePart[]
  patterns?: readonly PendingSequencePatternCapture[]
}

export interface PendingSequencePatternCapture {
  name: string
  payloadKey: string
  values: readonly unknown[]
  parts: readonly KeySequencePart[]
}

export interface PendingSequenceState<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  captures: readonly PendingSequenceCapture<TTarget, TEvent>[]
}
