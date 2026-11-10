import { stringifyKeySequence, stringifyKeyStroke } from "@opentui/keymap"
import type { Keymap, KeymapEvent, LayerBindingAnalysis, LayerAnalysisContext } from "@opentui/keymap"

const DEAD_BINDING_WARNINGS_RESOURCE = Symbol("keymap:dead-binding-warnings")

function isDeadMetadataOnlyBinding<TTarget extends object, TEvent extends KeymapEvent>(
  binding: LayerBindingAnalysis<TTarget, TEvent>,
): boolean {
  if (binding.command !== undefined) {
    return false
  }

  if (binding.event === "release") {
    return true
  }

  return !binding.hasContinuations && !binding.hasCommandAtSequence
}

function warnDeadMetadataOnlyBinding<TTarget extends object, TEvent extends KeymapEvent>(
  ctx: LayerAnalysisContext<TTarget, TEvent>,
  binding: LayerBindingAnalysis<TTarget, TEvent>,
): void {
  const sequence = stringifyKeySequence(binding.parsedBinding.sequence, { preferDisplay: true })
  const sourceKey =
    typeof binding.parsedBinding.key === "string"
      ? binding.parsedBinding.key
      : stringifyKeyStroke(binding.parsedBinding.key)
  const warningKey = `dead-binding:${binding.sourceLayerOrder}:${binding.bindingIndex}:${sourceKey}`

  ctx.warnOnce(
    warningKey,
    "dead-binding",
    {
      binding: binding.parsedBinding,
      target: binding.sourceTarget,
    },
    `[Keymap] Binding "${sequence}" has no command and no reachable continuations; it will never trigger`,
  )
}

/**
 * Warns about bindings that can never trigger because they have no command and
 * no reachable continuation.
 */
export function registerDeadBindingWarnings<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.acquireResource(DEAD_BINDING_WARNINGS_RESOURCE, () => {
    return keymap.appendLayerAnalyzer((ctx) => {
      for (const binding of ctx.bindings) {
        if (!isDeadMetadataOnlyBinding(binding)) {
          continue
        }

        warnDeadMetadataOnlyBinding(ctx, binding)
      }
    })
  })
}
