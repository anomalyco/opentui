import type { Keymap, KeymapEvent } from "../../index.js"

const METADATA_FIELDS_RESOURCE = Symbol("keymap:metadata-fields")

function normalizeMetadataText(fieldName: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Keymap metadata field "${fieldName}" must be a string`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`Keymap metadata field "${fieldName}" cannot be empty`)
  }

  return trimmed
}

/**
 * Maps `desc`, `group`, `title`, and `category` fields into binding and
 * command attrs.
 *
 * This addon only registers binding and command field compilers. Apps can
 * register layer metadata fields directly with `registerLayerFields`.
 */
export function registerMetadataFields<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.acquireResource(METADATA_FIELDS_RESOURCE, () => {
    const offBindingFields = keymap.registerBindingFields({
      desc(value, ctx) {
        ctx.attr("desc", normalizeMetadataText("desc", value))
      },
      group(value, ctx) {
        ctx.attr("group", normalizeMetadataText("group", value))
      },
    })

    const offCommandFields = keymap.registerCommandFields({
      desc(value, ctx) {
        ctx.attr("desc", normalizeMetadataText("desc", value))
      },
      title(value, ctx) {
        ctx.attr("title", normalizeMetadataText("title", value))
      },
      category(value, ctx) {
        ctx.attr("category", normalizeMetadataText("category", value))
      },
    })

    return () => {
      offCommandFields()
      offBindingFields()
    }
  })
}
