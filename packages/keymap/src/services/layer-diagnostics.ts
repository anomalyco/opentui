import type { CommandCatalogService } from "./command-catalog.js"
import type { AnalyzeLayerOptions, LayerDiagnostics } from "./layers.js"
import type { NotificationService } from "./notify.js"
import { createRuntimeOrderedRegistry } from "../lib/runtime-utils.js"
import { cloneKeySequence } from "./keys.js"
import { snapshotParsedBinding } from "./primitives/bindings.js"
import type { BindingState, KeymapEvent, LayerAnalysisContext, LayerAnalyzer, LayerBindingAnalysis } from "../types.js"

export interface LayerDiagnosticsCore<TTarget extends object, TEvent extends KeymapEvent> extends LayerDiagnostics<
  TTarget,
  TEvent
> {
  prependLayerAnalyzer(analyzer: LayerAnalyzer<TTarget, TEvent>): () => void
  appendLayerAnalyzer(analyzer: LayerAnalyzer<TTarget, TEvent>): () => void
  clearLayerAnalyzers(): void
}

export function createLayerDiagnostics<TTarget extends object, TEvent extends KeymapEvent>(
  notify: NotificationService<TTarget, TEvent>,
  commands: CommandCatalogService<TTarget, TEvent>,
): LayerDiagnosticsCore<TTarget, TEvent> {
  const analyzers = createRuntimeOrderedRegistry<LayerAnalyzer<TTarget, TEvent>>()

  return {
    prependLayerAnalyzer(analyzer) {
      return analyzers.prepend(analyzer)
    },
    appendLayerAnalyzer(analyzer) {
      return analyzers.append(analyzer)
    },
    clearLayerAnalyzers() {
      analyzers.clear()
    },
    analyzeLayer(options) {
      const registeredAnalyzers = analyzers.values()
      if (registeredAnalyzers.length === 0) return

      const bindings = buildLayerBindingAnalyses(options.bindings)
      const ctx: LayerAnalysisContext<TTarget, TEvent> = {
        target: options.target,
        order: options.order,
        sourceBindings: options.sourceBindings,
        bindings,
        hasTokenBindings: options.hasTokenBindings,
        checkCommandResolution(command) {
          return commands.getCommandResolutionStatus(command, options.commands)
        },
        warn(code, warning, message) {
          notify.emitWarning(code, warning, message)
        },
        warnOnce(key, code, warning, message) {
          notify.warnOnce(key, code, warning, message)
        },
        error(code, error, message) {
          notify.emitError(code, error, message)
        },
      }

      for (const analyzer of registeredAnalyzers) {
        try {
          analyzer(ctx)
        } catch (error) {
          notify.emitError("layer-analyzer-error", error, "[Keymap] Error in layer analyzer:")
        }
      }
    },
  }
}

function buildLayerBindingAnalyses<TTarget extends object, TEvent extends KeymapEvent>(
  bindings: readonly BindingState<TTarget, TEvent>[],
): LayerBindingAnalysis<TTarget, TEvent>[] {
  return bindings.map((binding) => ({
    sequence: cloneKeySequence(binding.sequence),
    command: binding.command,
    attrs: binding.attrs,
    event: binding.event,
    preventDefault: binding.preventDefault,
    fallthrough: binding.fallthrough,
    parsedBinding: snapshotParsedBinding(binding.parsedBinding),
    sourceTarget: binding.sourceTarget,
    sourceLayerOrder: binding.sourceLayerOrder,
    bindingIndex: binding.bindingIndex,
    hasCommandAtSequence: bindings.some((candidate) => {
      return candidate.event === "press" && candidate.command !== undefined && sameSequence(candidate, binding)
    }),
    hasContinuations: bindings.some((candidate) => {
      return candidate.event === "press" && isPrefix(binding, candidate)
    }),
  }))
}

function sameSequence<TTarget extends object, TEvent extends KeymapEvent>(
  left: BindingState<TTarget, TEvent>,
  right: BindingState<TTarget, TEvent>,
): boolean {
  return (
    left.sequence.length === right.sequence.length &&
    left.sequence.every((part, index) => part.match === right.sequence[index]?.match)
  )
}

function isPrefix<TTarget extends object, TEvent extends KeymapEvent>(
  left: BindingState<TTarget, TEvent>,
  right: BindingState<TTarget, TEvent>,
): boolean {
  return (
    left.sequence.length < right.sequence.length &&
    left.sequence.every((part, index) => part.match === right.sequence[index]?.match)
  )
}
