import type { BindingExpander, Keymap, KeymapEvent } from "../../index.js"

const COMMA_BINDINGS_RESOURCE = Symbol("keymap:comma-bindings")

const commaBindingExpander: BindingExpander = ({ input, displays }) => {
  if (!input.includes(",")) {
    return undefined
  }

  const parts = input.split(",").map((part) => part.trim())
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid key sequence "${input}": comma-separated bindings cannot contain empty entries`)
  }

  if (!displays) {
    return parts.map((key) => ({ key }))
  }

  const displayParts = displays.length === 1 ? displays[0]!.split(",").map((part) => part.trim()) : displays
  if (displayParts.length !== parts.length || displayParts.some((part) => part.length === 0)) {
    return parts.map((key) => ({ key }))
  }

  return parts.map((key, index) => ({
    key,
    displays: displayParts[index]!.trim().split(/\s+/).filter(Boolean),
  }))
}

/**
 * Expands comma-separated binding strings such as `j,k` into separate
 * bindings.
 */
export function registerCommaBindings<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.acquireResource(COMMA_BINDINGS_RESOURCE, () => {
    return keymap.appendBindingExpander(commaBindingExpander)
  })
}
