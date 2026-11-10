import type { Keymap, KeymapEvent } from "../../index.js"

export type Aliases = Record<string, string>

const ALIASES_FIELD_RESOURCE = Symbol("keymap:aliases-field")

function normalizeAliases(value: unknown): Aliases {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Keymap aliases field "aliases" must be an object of key-name mappings')
  }

  const aliases: Aliases = {}

  for (const [name, key] of Object.entries(value as Record<string, unknown>)) {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Keymap aliases field "aliases" cannot contain empty alias names')
    }

    if (typeof key !== "string") {
      throw new Error(`Keymap alias "${trimmedName}" must map to a string key name`)
    }

    const trimmedKey = key.trim()
    if (!trimmedKey) {
      throw new Error(`Keymap alias "${trimmedName}" cannot map to an empty key name`)
    }

    aliases[trimmedName.toLowerCase()] = trimmedKey.toLowerCase()
  }

  return aliases
}

function getAliases(layer: Readonly<Record<string, unknown>>): Aliases | undefined {
  const aliases = layer.aliases
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    return undefined
  }

  return normalizeAliases(aliases)
}

/**
 * Adds an `aliases` layer field for remapping single-key binding names within
 * that layer.
 */
export function registerAliasesField<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.acquireResource(ALIASES_FIELD_RESOURCE, () => {
    const offLayerField = keymap.registerLayerFields({
      aliases(value, ctx) {
        normalizeAliases(value)
      },
    })

    const offBindingTransformer = keymap.appendBindingTransformer((binding, ctx) => {
      const aliases = getAliases(ctx.layer)
      if (!aliases) {
        return
      }

      if (binding.sequence.length !== 1) {
        return
      }

      const [part] = binding.sequence
      if (!part) {
        return
      }

      const aliasedName = aliases[part.stroke.name]
      if (!aliasedName) {
        return
      }

      ctx.add({
        ...binding,
        sequence: [
          ctx.parseKey({
            ...part.stroke,
            name: aliasedName,
          }),
        ],
      })
    })

    return () => {
      offBindingTransformer()
      offLayerField()
    }
  })
}
