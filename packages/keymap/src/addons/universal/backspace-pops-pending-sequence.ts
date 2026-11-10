import type { Keymap, KeymapEvent } from "../../index.js"

export interface BackspacePopsPendingSequenceOptions {
  /**
   * When true, consume Backspace after popping the sequence so it does not
   * reach the focused target or lower-priority listeners. Default: `true`.
   */
  preventDefault?: boolean
  priority?: number
}

/**
 * Lets `Backspace` step back through the current pending multi-key sequence.
 */
export function registerBackspacePopsPendingSequence<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
  options?: BackspacePopsPendingSequenceOptions,
): () => void {
  const shouldPreventDefault = options?.preventDefault ?? true

  return keymap.intercept(
    "key",
    ({ event, consume }) => {
      if (event.name !== "backspace") {
        return
      }

      if (!keymap.popPendingSequence()) {
        return
      }

      if (shouldPreventDefault) {
        consume()
      }
    },
    { priority: options?.priority ?? 0 },
  )
}
