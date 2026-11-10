import { stringifyKeySequence, stringifyKeyStroke } from "@opentui/keymap"
import type { Keymap, KeymapEvent, LayerAnalysisContext, ParsedBinding } from "@opentui/keymap"

const UNRESOLVED_COMMAND_WARNINGS_RESOURCE = Symbol("keymap:unresolved-command-warnings")

interface UnresolvedCommandWarning<TTarget extends object, TEvent extends KeymapEvent> {
  command: string
  binding: ParsedBinding<TTarget, TEvent>
  target?: TTarget
}

function warnUnresolvedCommand<TTarget extends object, TEvent extends KeymapEvent>(
  ctx: LayerAnalysisContext<TTarget, TEvent>,
  binding: LayerAnalysisContext<TTarget, TEvent>["bindings"][number],
): void {
  if (typeof binding.command !== "string") {
    return
  }

  if (ctx.checkCommandResolution(binding.command) !== "unresolved") {
    return
  }

  const sequence = stringifyKeySequence(binding.parsedBinding.sequence, { preferDisplay: true })
  const sourceKey =
    typeof binding.parsedBinding.key === "string"
      ? binding.parsedBinding.key
      : stringifyKeyStroke(binding.parsedBinding.key)
  const warning: UnresolvedCommandWarning<TTarget, TEvent> = {
    command: binding.command,
    binding: binding.parsedBinding,
    target: binding.sourceTarget,
  }

  ctx.warnOnce(
    `unresolved:${binding.sourceLayerOrder}:${binding.bindingIndex}:${binding.command}:${sourceKey}`,
    "unresolved-command",
    warning,
    `[Keymap] Unresolved command "${binding.command}" for binding "${sequence}"`,
  )
}

/**
 * Warns when a string command name cannot be resolved by registered commands
 * or resolvers.
 */
export function registerUnresolvedCommandWarnings<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.acquireResource(UNRESOLVED_COMMAND_WARNINGS_RESOURCE, () => {
    return keymap.appendLayerAnalyzer((ctx) => {
      for (const binding of ctx.bindings) {
        warnUnresolvedCommand(ctx, binding)
      }
    })
  })
}
