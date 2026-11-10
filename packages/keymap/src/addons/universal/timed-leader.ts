import type { Keymap, KeymapEvent, KeySequencePart } from "../../index.js"
import { registerLeader, resolveLeaderTrigger, type LeaderOptions } from "./leader.js"

export interface TimedLeaderOptions extends LeaderOptions {
  timeoutMs?: number
  onArm?: () => void
  onDisarm?: () => void
}

/**
 * Defines a leader token and clears it if no follow-up key arrives before the
 * timeout.
 */
export function registerTimedLeader<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
  options: TimedLeaderOptions,
): () => void {
  const trigger = resolveLeaderTrigger(options.trigger)
  if (trigger === undefined) {
    return () => {}
  }

  const matchesTrigger = keymap.createKeyMatcher(trigger)
  const timeoutMs = options.timeoutMs ?? 1500

  let armed = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  const clearTimer = (): void => {
    if (!timeout) {
      return
    }

    clearTimeout(timeout)
    timeout = undefined
  }

  const scheduleTimeout = (): void => {
    clearTimer()
    timeout = setTimeout(() => {
      keymap.clearPendingSequence()
    }, timeoutMs)
  }

  const syncArmedState = (sequence: readonly KeySequencePart[]): void => {
    const nextArmed = matchesTrigger(sequence[0])
    if (nextArmed) {
      scheduleTimeout()
    } else {
      clearTimer()
    }

    if (nextArmed === armed) {
      return
    }

    armed = nextArmed
    if (armed) {
      options.onArm?.()
      return
    }

    options.onDisarm?.()
  }

  const offLeader = registerLeader(keymap, { name: options.name, trigger })
  const offPendingSequenceChange = keymap.on("pendingSequence", (sequence) => {
    syncArmedState(sequence)
  })
  syncArmedState(keymap.getPendingSequence())

  const dispose = (): void => {
    clearTimer()
    offPendingSequenceChange()
    offLeader()

    if (!armed) {
      return
    }

    armed = false
    options.onDisarm?.()
  }

  return dispose
}
