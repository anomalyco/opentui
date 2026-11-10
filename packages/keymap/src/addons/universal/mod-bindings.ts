import type { BindingExpander, HostMetadata, Keymap, KeymapEvent } from "../../index.js"

const MOD_BINDINGS_RESOURCE = Symbol("keymap:mod-bindings")

const MOD_MODIFIER_PATTERN = /(^|[+,\s])mod(?=\s*\+)/i
const MOD_MODIFIER_REPLACE_PATTERN = /(^|[+,\s])mod(?=\s*\+)/gi

function resolveModModifier(metadata: Readonly<HostMetadata>): "ctrl" | "super" {
  const primary = metadata.primaryModifier
  if ((primary === "ctrl" || primary === "super") && metadata.modifiers[primary] !== "unsupported") {
    return primary
  }

  if (metadata.modifiers.ctrl !== "unsupported") {
    return "ctrl"
  }

  return "super"
}

function createDisplays(input: string): readonly string[] {
  if (input.includes(",")) {
    return [input]
  }

  const trimmed = input.trim()
  return trimmed.includes(" ") ? trimmed.split(/\s+/) : [input]
}

/**
 * Adds a platform-aware `mod+...` modifier alias. `mod` resolves to the host's
 * primary modifier, with `ctrl` as the fallback when the host is unknown.
 */
export function registerModBindings<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.acquireResource(MOD_BINDINGS_RESOURCE, () => {
    const expandModBinding: BindingExpander = ({ input, displays }) => {
      if (!MOD_MODIFIER_PATTERN.test(input)) {
        return undefined
      }

      const modifier = resolveModModifier(keymap.getHostMetadata())
      return [
        {
          key: input.replace(MOD_MODIFIER_REPLACE_PATTERN, (_match, prefix: string) => `${prefix}${modifier}`),
          displays: displays ?? createDisplays(input),
        },
      ]
    }

    return keymap.appendBindingExpander(expandModBinding)
  })
}
