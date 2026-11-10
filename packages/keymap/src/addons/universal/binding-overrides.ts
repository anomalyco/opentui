import type { Binding, Keymap, KeymapEvent } from "../../index.js"

const BINDING_OVERRIDES_RESOURCE = Symbol("keymap:binding-overrides")

function normalizeBindingOverrides<TTarget extends object, TEvent extends KeymapEvent>(
  value: unknown,
): readonly Binding<TTarget, TEvent>[] {
  if (!Array.isArray(value)) {
    throw new Error('Keymap layer field "bindingOverrides" must be an array of binding objects')
  }

  return value as readonly Binding<TTarget, TEvent>[]
}

function getBindingOverrides<TTarget extends object, TEvent extends KeymapEvent>(
  layer: Readonly<Record<string, unknown>>,
): readonly Binding<TTarget, TEvent>[] | undefined {
  const overrides = layer.bindingOverrides
  if (!overrides || !Array.isArray(overrides)) {
    return undefined
  }

  return normalizeBindingOverrides<TTarget, TEvent>(overrides)
}

/**
 * Adds a `bindingOverrides` layer field that replaces bindings by string
 * command name within that layer before compilation.
 */
export function registerBindingOverrides<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.acquireResource(BINDING_OVERRIDES_RESOURCE, () => {
    const offLayerField = keymap.registerLayerFields({
      bindingOverrides(value) {
        normalizeBindingOverrides<TTarget, TEvent>(value)
      },
    })

    const offTransformer = keymap.appendLayerBindingsTransformer((bindings, ctx) => {
      const overrides = getBindingOverrides<TTarget, TEvent>(ctx.layer)
      if (!overrides) {
        return
      }

      const validation = ctx.validateBindings(overrides)
      if (!validation.ok) {
        throw new Error(validation.reason)
      }

      const overrideCommands = new Set(
        overrides.flatMap((binding) => (typeof binding.cmd === "string" ? [binding.cmd.trim()] : [])),
      )

      return [
        ...overrides,
        ...bindings.filter((binding) => {
          return typeof binding.cmd !== "string" || !overrideCommands.has(binding.cmd.trim())
        }),
      ]
    })

    return () => {
      offTransformer()
      offLayerField()
    }
  })
}
