import type { Keymap, KeymapEvent } from "../../index.js"

export interface NeovimDisambiguationOptions {
  timeoutMs?: number
}

/**
 * Defers ambiguous exact-vs-prefix bindings and runs the exact binding if no
 * continuation arrives before the timeout, matching Neovim-style timeout-based
 * disambiguation.
 */
export function registerNeovimDisambiguation<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
  options?: NeovimDisambiguationOptions,
): () => void {
  const timeoutMs = options?.timeoutMs ?? 300

  return keymap.appendDisambiguationResolver((ctx) => {
    return ctx.defer(async (deferred) => {
      // Let a queued continuation cancel the exact match before committing it.
      if ((await deferred.sleep(timeoutMs)) && (await deferred.sleep(0))) {
        return deferred.runExact()
      }
    })
  })
}
