import type {
  ActiveBinding,
  ActiveKey,
  ActiveKeyOptions,
  BindingExpander,
  BindingParser,
  BindingFieldCompiler,
  LayerBindingsTransformer,
  BindingTransformer,
  Events,
  Hooks,
  CommandFieldCompiler,
  CommandTransformer,
  CommandBindingsQuery,
  CommandEntry,
  CommandQuery,
  Command,
  KeymapEvent,
  KeymapHost,
  HostMetadata,
  LayerAnalyzer,
  Listener,
  RunCommandOptions,
  RunCommandResult,
  CommandResolver,
  KeyAfterInputContext,
  KeyInterceptOptions,
  KeyInputContext,
  Layer,
  LayerFieldCompiler,
  KeyDisambiguationResolver,
  RawInterceptOptions,
  RawInputContext,
  EventMatchResolver,
  KeyMatch,
  KeyStringifyInput,
  KeyToken,
  SequencePattern,
  KeyLike,
  KeySequencePart,
  StringifyOptions,
} from "./types.js"
import { createLayerDiagnostics, type LayerDiagnosticsCore } from "./services/layer-diagnostics.js"
import { createActivationService, type ActivationService } from "./services/activation.js"
import { createCommandCatalogService, type CommandCatalogService } from "./services/command-catalog.js"
import { createCommandExecutorService, type CommandExecutorService } from "./services/command-executor.js"
import { createCompilerService, type CompilerService } from "./services/compiler.js"
import { createConditionService, type ConditionService } from "./services/conditions.js"
import { createDispatchService, type DispatchService } from "./services/dispatch.js"
import {
  registerFields,
  registerSequencePattern as registerEnvironmentSequencePattern,
  registerToken as registerEnvironmentToken,
} from "./services/environment.js"
import { createLayerService, type LayerService } from "./services/layers.js"
import type { EmitterListener } from "./lib/emitter.js"
import { createRuntimeEmitter, type RuntimeEmitter } from "./lib/runtime-utils.js"
import { createNotificationService, type NotificationService } from "./services/notify.js"
import { resolveKeyMatch } from "./services/keys.js"
import { createRuntimeService, type RuntimeService } from "./services/runtime.js"
import { KEYMAP_EXTENSION_CONTEXT, type KeymapExtensionContext } from "./services/extension-context.js"
import { createKeymapState } from "./services/state.js"

type DiagnosticEvents<TTarget extends object, TEvent extends KeymapEvent> = Pick<
  Events<TTarget, TEvent>,
  "warning" | "error"
>

function getKeyMatchKey(input: KeyStringifyInput): KeyMatch {
  return resolveKeyMatch(input)
}

export class Keymap<TTarget extends object, TEvent extends KeymapEvent = KeymapEvent> {
  #state = createKeymapState<TTarget, TEvent>()
  #cleanedUp = false
  #resources = new Map<symbol, { count: number; dispose: () => void }>()
  #cleanupListeners: Array<() => void> = []
  // Reuse `Emitter`, but keep its `onError` hook as a no-op so throwing error
  // listeners cannot re-enter `emitError` and loop forever.
  #events = createRuntimeEmitter<DiagnosticEvents<TTarget, TEvent>>(() => {})
  #hooks: RuntimeEmitter<Hooks<TTarget, TEvent>>
  #notify: NotificationService<TTarget, TEvent>
  #activation: ActivationService<TTarget, TEvent>
  #runtime: RuntimeService<TTarget, TEvent>
  #conditions: ConditionService<TTarget, TEvent>
  #catalog: CommandCatalogService<TTarget, TEvent>
  #executor: CommandExecutorService<TTarget, TEvent>
  #compiler: CompilerService<TTarget, TEvent>
  #dispatch: DispatchService<TTarget, TEvent>
  #layers: LayerService<TTarget, TEvent>
  #layerDiagnostics: LayerDiagnosticsCore<TTarget, TEvent>

  #keypressListener: (event: TEvent) => void
  #keyreleaseListener: (event: TEvent) => void
  #rawListener: (sequence: string) => boolean
  #focusedTargetListener: (focused: TTarget | null) => void

  #host: KeymapHost<TTarget, TEvent>

  public getPendingSequence: () => readonly KeySequencePart[]
  public getActiveKeys: (options?: ActiveKeyOptions) => readonly ActiveKey<TTarget, TEvent>[]

  constructor(host: KeymapHost<TTarget, TEvent>) {
    this.#host = host
    if (host.isDestroyed) {
      throw new Error("Cannot create a keymap for a destroyed host")
    }

    this.#hooks = createRuntimeEmitter<Hooks<TTarget, TEvent>>((name, error) => {
      this.#notify.reportListenerError(name, error)
    })
    this.#notify = createNotificationService(this.#state, this.#events, this.#hooks)
    this.#conditions = createConditionService(this.#state, this.#notify)
    this.#catalog = createCommandCatalogService(this.#state, this.#host, this.#notify, this.#conditions, {
      onCommandResolversChanged: () => {
        this.#activation.ensureValidPendingSequence()
      },
    })
    this.#activation = createActivationService(
      this.#state,
      this.#host,
      this.#hooks,
      this.#notify,
      this.#conditions,
      this.#catalog,
      {
        onPendingSequenceChanged: (previous, next) => {
          this.#dispatch?.handlePendingSequenceChange(previous, next)
        },
      },
    )
    this.#runtime = createRuntimeService(this.#state, this.#notify, this.#activation)
    this.#executor = createCommandExecutorService(this.#notify, this.#runtime, this.#activation, this.#catalog, {
      keymap: this,
      createCommandEvent: () => this.#host.createCommandEvent(),
    })
    this.#compiler = createCompilerService(this.#state, this.#notify, this.#conditions, {
      warnUnknownField: (kind, fieldName) => {
        this.#warnUnknownField(kind, fieldName)
      },
      warnUnknownToken: (token, sequence) => {
        this.#warnUnknownToken(token, sequence)
      },
    })
    this.#layerDiagnostics = createLayerDiagnostics(this.#notify, this.#catalog)
    this.#layers = createLayerService(this.#state, this.#notify, this.#conditions, this.#activation, {
      compiler: this.#compiler,
      commands: this.#catalog,
      host: this.#host,
      diagnostics: this.#layerDiagnostics,
      warnUnknownField: (kind, fieldName) => {
        this.#warnUnknownField(kind, fieldName)
      },
    })
    this.#dispatch = createDispatchService(
      this.#state,
      this.#notify,
      this.#runtime,
      this.#activation,
      this.#conditions,
      this.#executor,
      this.#compiler,
      this.#catalog,
      this.#layers,
      this.#hooks,
    )
    this.getPendingSequence = this.#activation.getPendingSequence
    this.getActiveKeys = this.#activation.getActiveKeys
    this.#keypressListener = (event) => {
      this.#dispatch.handleKeyEvent(event, false)
    }
    this.#keyreleaseListener = (event) => {
      this.#dispatch.handleKeyEvent(event, true)
    }
    this.#rawListener = (sequence) => {
      return this.#dispatch.handleRawSequence(sequence)
    }
    this.#focusedTargetListener = (focused) => {
      this.#handleFocusedTargetChange(focused)
    }

    this.#cleanupListeners.push(this.#host.onKeyPress(this.#keypressListener))
    this.#cleanupListeners.push(this.#host.onKeyRelease(this.#keyreleaseListener))
    if (this.#host.onRawInput) {
      this.#cleanupListeners.push(this.#host.onRawInput(this.#rawListener))
    }
    this.#cleanupListeners.push(this.#host.onFocusChange(this.#focusedTargetListener))
    if (this.#host.onDestroy) {
      this.#cleanupListeners.push(
        this.#host.onDestroy(() => {
          this.#cleanup()
        }),
      )
    }
  }

  public [KEYMAP_EXTENSION_CONTEXT](): KeymapExtensionContext<TTarget, TEvent> {
    return {
      state: this.#state,
      host: this.#host,
      conditions: this.#conditions,
      catalog: this.#catalog,
      activation: this.#activation,
    }
  }

  #cleanup(): void {
    if (this.#cleanedUp) {
      return
    }

    this.#cleanedUp = true

    this.#activation.setPendingSequence(null)

    for (const resource of this.#resources.values()) {
      resource.dispose()
    }
    this.#resources.clear()

    this.#layers.cleanup()

    for (const cleanupListener of this.#cleanupListeners.splice(0)) {
      cleanupListener()
    }
  }

  public setData(name: string, value: unknown): void {
    this.#runtime.setData(name, value)
  }

  public getData(name: string): unknown {
    return this.#runtime.getData(name)
  }

  public getHostMetadata(): Readonly<HostMetadata> {
    return this.#host.metadata
  }

  public hasPendingSequence(): boolean {
    return this.#activation.ensureValidPendingSequence() !== undefined
  }

  public createKeyMatcher(key: KeyLike): (input: KeyStringifyInput | null | undefined) => boolean {
    const match = this.#compiler.parseTokenKey(key).match

    return (input) => {
      if (!input) {
        return false
      }

      return getKeyMatchKey(input) === match
    }
  }

  public parseKeySequence(key: KeyLike): readonly KeySequencePart[] {
    return this.#compiler.parseKeySequence(key)
  }

  public formatKey(key: KeyLike, options?: StringifyOptions): string {
    return this.#compiler.formatKey(key, options)
  }

  public clearPendingSequence(): void {
    this.#activation.setPendingSequence(null)
  }

  public popPendingSequence(): boolean {
    return this.#activation.popPendingSequence()
  }

  public getCommands(query?: CommandQuery<TTarget, TEvent>): readonly Command<TTarget, TEvent>[] {
    return this.#catalog.getCommands(query)
  }

  public getCommandEntries(query?: CommandQuery<TTarget, TEvent>): readonly CommandEntry<TTarget, TEvent>[] {
    return this.#catalog.getCommandEntries(query)
  }

  public getCommandBindings(
    query: CommandBindingsQuery<TTarget>,
  ): ReadonlyMap<string, readonly ActiveBinding<TTarget, TEvent>[]> {
    return this.#catalog.getCommandBindings(query)
  }

  public acquireResource(key: symbol, setup: () => () => void): () => void {
    if (this.#cleanedUp || this.#host.isDestroyed) {
      throw new Error("Cannot use a keymap after its host was destroyed")
    }

    const existing = this.#resources.get(key)
    if (existing) {
      existing.count += 1
      return () => {
        this.#releaseResource(key, existing)
      }
    }

    const dispose = setup()
    const resource = { count: 1, dispose }
    this.#resources.set(key, resource)

    return () => {
      this.#releaseResource(key, resource)
    }
  }

  public runCommand(cmd: string, options?: RunCommandOptions<TTarget, TEvent>): RunCommandResult<TTarget, TEvent> {
    return this.#executor.runCommand(cmd, options)
  }

  public dispatchCommand(cmd: string, options?: RunCommandOptions<TTarget, TEvent>): RunCommandResult<TTarget, TEvent> {
    return this.#executor.dispatchCommand(cmd, options)
  }

  public on(name: "state", fn: Listener<Events<TTarget, TEvent>["state"]>): () => void

  public on(name: "pendingSequence", fn: Listener<Events<TTarget, TEvent>["pendingSequence"]>): () => void

  public on(name: "dispatch", fn: Listener<Events<TTarget, TEvent>["dispatch"]>): () => void

  public on(name: "warning", fn: Listener<Events<TTarget, TEvent>["warning"]>): () => void

  public on(name: "error", fn: Listener<Events<TTarget, TEvent>["error"]>): () => void

  public on(
    name: keyof Events<TTarget, TEvent>,
    fn: (() => void) | ((value: Events<TTarget, TEvent>[keyof Events<TTarget, TEvent>]) => void),
  ): () => void {
    if (name === "warning") {
      return this.#events.hook(name, fn as EmitterListener<Events<TTarget, TEvent>["warning"]>)
    }

    if (name === "error") {
      return this.#events.hook(name, fn as EmitterListener<Events<TTarget, TEvent>["error"]>)
    }

    return this.#hooks.hook(name, fn as Listener<Hooks<TTarget, TEvent>[typeof name]>)
  }

  public intercept(name: "key", fn: (ctx: KeyInputContext<TEvent>) => void, options?: KeyInterceptOptions): () => void

  public intercept(
    name: "key:after",
    fn: (ctx: KeyAfterInputContext<TTarget, TEvent>) => void,
    options?: KeyInterceptOptions,
  ): () => void

  public intercept(name: "raw", fn: (ctx: RawInputContext) => void, options?: RawInterceptOptions): () => void

  public intercept(
    name: "key" | "key:after" | "raw",
    fn:
      | ((ctx: KeyInputContext<TEvent>) => void)
      | ((ctx: KeyAfterInputContext<TTarget, TEvent>) => void)
      | ((ctx: RawInputContext) => void),
    options?: KeyInterceptOptions | RawInterceptOptions,
  ): () => void {
    if (name === "key") {
      return this.#dispatch.intercept(
        name,
        fn as (ctx: KeyInputContext<TEvent>) => void,
        options as KeyInterceptOptions,
      )
    }

    if (name === "key:after") {
      return this.#dispatch.intercept(
        name,
        fn as (ctx: KeyAfterInputContext<TTarget, TEvent>) => void,
        options as KeyInterceptOptions,
      )
    }

    return this.#dispatch.intercept(name, fn as (ctx: RawInputContext) => void, options as RawInterceptOptions)
  }

  public registerLayer(layer: Layer<TTarget, TEvent>): () => void {
    return this.#layers.registerLayer(layer)
  }

  public registerLayerFields(fields: Record<string, LayerFieldCompiler>): () => void {
    return registerFields(this.#state, this.#notify, "layer", fields)
  }

  public prependLayerBindingsTransformer(transformer: LayerBindingsTransformer<TTarget, TEvent>): () => void {
    return this.#state.layerBindingsTransformers.prepend(transformer)
  }

  public appendLayerBindingsTransformer(transformer: LayerBindingsTransformer<TTarget, TEvent>): () => void {
    return this.#state.layerBindingsTransformers.append(transformer)
  }

  public clearLayerBindingsTransformers(): void {
    this.#state.layerBindingsTransformers.clear()
  }

  public prependBindingTransformer(transformer: BindingTransformer<TTarget, TEvent>): () => void {
    return this.#state.bindingTransformers.prepend(transformer)
  }

  public appendBindingTransformer(transformer: BindingTransformer<TTarget, TEvent>): () => void {
    return this.#state.bindingTransformers.append(transformer)
  }

  public clearBindingTransformers(): void {
    this.#state.bindingTransformers.clear()
  }

  public prependCommandTransformer(transformer: CommandTransformer<TTarget, TEvent>): () => void {
    return this.#state.commandTransformers.prepend(transformer)
  }

  public appendCommandTransformer(transformer: CommandTransformer<TTarget, TEvent>): () => void {
    return this.#state.commandTransformers.append(transformer)
  }

  public clearCommandTransformers(): void {
    this.#state.commandTransformers.clear()
  }

  public prependBindingParser(parser: BindingParser): () => void {
    return this.#state.bindingParsers.prepend(parser)
  }

  public appendBindingParser(parser: BindingParser): () => void {
    return this.#state.bindingParsers.append(parser)
  }

  public clearBindingParsers(): void {
    this.#state.bindingParsers.clear()
  }

  public registerToken(token: KeyToken): () => void {
    return registerEnvironmentToken(this.#state, this.#notify, this.#compiler, this.#layers, token)
  }

  public registerSequencePattern(pattern: SequencePattern<TEvent>): () => void {
    return registerEnvironmentSequencePattern(this.#state, this.#notify, this.#layers, pattern)
  }

  public prependBindingExpander(expander: BindingExpander): () => void {
    return this.#state.bindingExpanders.prepend(expander)
  }

  public appendBindingExpander(expander: BindingExpander): () => void {
    return this.#state.bindingExpanders.append(expander)
  }

  public clearBindingExpanders(): void {
    this.#state.bindingExpanders.clear()
  }

  public registerBindingFields(fields: Record<string, BindingFieldCompiler>): () => void {
    return registerFields(this.#state, this.#notify, "binding", fields)
  }

  public registerCommandFields(fields: Record<string, CommandFieldCompiler>): () => void {
    return registerFields(this.#state, this.#notify, "command", fields)
  }

  public prependCommandResolver(resolver: CommandResolver<TTarget, TEvent>): () => void {
    return this.#catalog.prependCommandResolver(resolver)
  }

  public appendCommandResolver(resolver: CommandResolver<TTarget, TEvent>): () => void {
    return this.#catalog.appendCommandResolver(resolver)
  }

  public clearCommandResolvers(): void {
    this.#catalog.clearCommandResolvers()
  }

  public prependLayerAnalyzer(analyzer: LayerAnalyzer<TTarget, TEvent>): () => void {
    return this.#layerDiagnostics.prependLayerAnalyzer(analyzer)
  }

  public appendLayerAnalyzer(analyzer: LayerAnalyzer<TTarget, TEvent>): () => void {
    return this.#layerDiagnostics.appendLayerAnalyzer(analyzer)
  }

  public clearLayerAnalyzers(): void {
    this.#layerDiagnostics.clearLayerAnalyzers()
  }

  public prependEventMatchResolver(resolver: EventMatchResolver<TEvent>): () => void {
    return this.#dispatch.prependEventMatchResolver(resolver)
  }

  public appendEventMatchResolver(resolver: EventMatchResolver<TEvent>): () => void {
    return this.#dispatch.appendEventMatchResolver(resolver)
  }

  public clearEventMatchResolvers(): void {
    this.#dispatch.clearEventMatchResolvers()
  }

  public prependDisambiguationResolver(resolver: KeyDisambiguationResolver<TTarget, TEvent>): () => void {
    return this.#dispatch.prependDisambiguationResolver(resolver)
  }

  public appendDisambiguationResolver(resolver: KeyDisambiguationResolver<TTarget, TEvent>): () => void {
    return this.#dispatch.appendDisambiguationResolver(resolver)
  }

  public clearDisambiguationResolvers(): void {
    this.#dispatch.clearDisambiguationResolvers()
  }

  #handleFocusedTargetChange(_focused: TTarget | null): void {
    this.#notify.runWithStateChangeBatch(() => {
      // Any focus change breaks a pending sequence. Prefix dispatch is captured
      // against the state that started it, and changing focus can change the
      // active bindings and their precedence.
      this.#activation.setPendingSequence(null)
      this.#notify.queueStateChange({ invalidateCaches: false })
    })
  }

  #warnUnknownField(kind: "binding" | "layer", fieldName: string): void {
    this.#notify.warnOnce(
      `${kind}:${fieldName}`,
      `unknown-${kind}-field`,
      { field: fieldName, kind },
      `[Keymap] Unknown ${kind} field "${fieldName}" was ignored`,
    )
  }

  #warnUnknownToken(token: string, sequence: string): void {
    this.#notify.warnOnce(
      `token:${token}`,
      "unknown-token",
      { token, sequence },
      `[Keymap] Unknown token "${token}" in key sequence "${sequence}"; binding was skipped until the token is registered`,
    )
  }

  #releaseResource(key: symbol, resource: { count: number; dispose: () => void }): void {
    const current = this.#resources.get(key)
    if (current !== resource) {
      return
    }

    resource.count -= 1
    if (resource.count > 0) {
      return
    }

    resource.dispose()
    this.#resources.delete(key)
  }
}
