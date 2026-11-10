import type { KeyLike, Keymap, KeymapEvent } from "../../index.js"

export type LeaderTrigger = KeyLike | Readonly<{ key: KeyLike }> | readonly Readonly<{ key: KeyLike }>[]

export interface LeaderOptions {
  trigger: LeaderTrigger
  name?: string
}

function isLeaderTriggerArray(trigger: LeaderTrigger): trigger is readonly Readonly<{ key: KeyLike }>[] {
  return Array.isArray(trigger)
}

export function resolveLeaderTrigger(trigger: LeaderTrigger): KeyLike | undefined {
  if (isLeaderTriggerArray(trigger)) {
    if (trigger.length === 0) {
      return undefined
    }

    if (trigger.length > 1) {
      throw new Error("Invalid leader trigger: expected exactly one binding")
    }

    return trigger[0]!.key
  }

  if (typeof trigger === "object" && "key" in trigger) {
    return trigger.key
  }

  return trigger
}

/**
 * Defines a token such as `leader` that the default parser can reference as `<leader>`.
 */
export function registerLeader<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
  options: LeaderOptions,
): () => void {
  const key = resolveLeaderTrigger(options.trigger)
  if (key === undefined) {
    return () => {}
  }

  return keymap.registerToken({
    name: options.name ?? "leader",
    key,
  })
}
