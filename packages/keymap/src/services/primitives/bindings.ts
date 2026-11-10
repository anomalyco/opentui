import type { Binding, BindingsValidationResult, Bindings, KeymapEvent, ParsedBinding } from "../../types.js"
import { cloneKeySequence } from "../keys.js"

function isKeyLike(value: unknown): boolean {
  return typeof value === "string" || (!!value && typeof value === "object" && !Array.isArray(value))
}

export function validateBindings(bindings: unknown): BindingsValidationResult {
  if (!Array.isArray(bindings)) {
    return { ok: false, reason: "Invalid keymap bindings: expected an array of binding objects" }
  }

  for (const [index, binding] of bindings.entries()) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      return { ok: false, reason: `Invalid keymap binding at index ${index}: expected a binding object` }
    }

    if (!isKeyLike((binding as Binding).key)) {
      return {
        ok: false,
        reason: `Invalid keymap binding at index ${index}: expected "key" to be a string or keystroke object`,
      }
    }
  }

  return { ok: true }
}

export function snapshotBindings<TTarget extends object, TEvent extends KeymapEvent>(
  bindings: Bindings<TTarget, TEvent>,
): Binding<TTarget, TEvent>[] {
  const validation = validateBindings(bindings)
  if (!validation.ok) {
    throw new Error(validation.reason)
  }

  return bindings.map((binding) => ({
    ...binding,
    key: typeof binding.key === "string" ? binding.key : { ...binding.key },
  }))
}

export function snapshotParsedBinding<TTarget extends object, TEvent extends KeymapEvent>(
  binding: ParsedBinding<TTarget, TEvent>,
): ParsedBinding<TTarget, TEvent> {
  return {
    ...binding,
    sequence: cloneKeySequence(binding.sequence),
  }
}
