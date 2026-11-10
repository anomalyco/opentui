import type { Keymap, KeymapEvent, ReactiveMatcher } from "../../index.js"

const ENABLED_FIELDS_RESOURCE = Symbol("keymap:enabled-fields")

/**
 * Accepted `enabled` values: boolean, raw `() => boolean`, or an
 * `ReactiveMatcher` for subscription-driven invalidation.
 */
export type Enabled = boolean | (() => boolean) | ReactiveMatcher

function isReactiveMatcher(value: unknown): value is ReactiveMatcher {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as { get?: unknown; subscribe?: unknown }
  return typeof candidate.get === "function" && typeof candidate.subscribe === "function"
}

function normalizeEnabledValue(fieldName: string, value: unknown): Enabled {
  if (typeof value === "boolean") {
    return value
  }

  if (typeof value === "function") {
    return value as () => boolean
  }

  if (isReactiveMatcher(value)) {
    return value
  }

  throw new Error(`Keymap enabled field "${fieldName}" must be a boolean, a function, or a reactive matcher`)
}

/**
 * Adds `enabled` layer and command fields for boolean, callback, or reactive
 * matcher gating.
 */
export function registerEnabledFields<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.acquireResource(ENABLED_FIELDS_RESOURCE, () => {
    const offLayerFields = keymap.registerLayerFields({
      enabled(value, ctx) {
        const normalized = normalizeEnabledValue("enabled", value)
        if (normalized === true) {
          return
        }

        if (normalized === false) {
          ctx.activeWhen(() => false)
          return
        }

        ctx.activeWhen(normalized)
      },
    })

    const offCommandFields = keymap.registerCommandFields({
      enabled(value, ctx) {
        const normalized = normalizeEnabledValue("enabled", value)
        if (normalized === true) {
          return
        }

        if (normalized === false) {
          ctx.activeWhen(() => false)
          return
        }

        ctx.activeWhen(normalized)
      },
    })

    return () => {
      offCommandFields()
      offLayerFields()
    }
  })
}
