import type {
  KeyDeferredDisambiguationDecision,
  KeyDeferredDisambiguationHandler,
  KeyDisambiguationDecision,
  KeymapEvent,
  PendingSequenceCapture,
} from "../types.js"
import { KEY_DEFERRED_DISAMBIGUATION_DECISION, KEY_DISAMBIGUATION_DECISION } from "../types.js"

export type SyncDecisionAction = "run-exact" | "continue-sequence" | "clear" | "defer"
export type DeferredDecisionAction = "run-exact" | "continue-sequence" | "clear"

export interface InternalDisambiguationDecision extends KeyDisambiguationDecision {
  readonly action: SyncDecisionAction
  readonly handler?: KeyDeferredDisambiguationHandler<any, any>
}

export interface InternalDeferredDisambiguationDecision extends KeyDeferredDisambiguationDecision {
  readonly action: DeferredDecisionAction
}

export interface PendingDisambiguation<TTarget extends object, TEvent extends KeymapEvent> {
  id: number
  controller: AbortController
  captures: readonly PendingSequenceCapture<TTarget, TEvent>[]
  apply: (decision: InternalDeferredDisambiguationDecision | void) => void
}

export function createSyncDecision(
  action: SyncDecisionAction,
  handler?: KeyDeferredDisambiguationHandler<any, any>,
): InternalDisambiguationDecision {
  return {
    [KEY_DISAMBIGUATION_DECISION]: true,
    action,
    handler,
  }
}

export function createDeferredDecision(action: DeferredDecisionAction): InternalDeferredDisambiguationDecision {
  return {
    [KEY_DEFERRED_DISAMBIGUATION_DECISION]: true,
    action,
  }
}

export function isSyncDecision(value: unknown): value is InternalDisambiguationDecision {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { [KEY_DISAMBIGUATION_DECISION]?: unknown })[KEY_DISAMBIGUATION_DECISION] === true
  )
}

export function isDeferredDecision(value: unknown): value is InternalDeferredDisambiguationDecision {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { [KEY_DEFERRED_DISAMBIGUATION_DECISION]?: unknown })[KEY_DEFERRED_DISAMBIGUATION_DECISION] === true
  )
}

export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort)
        resolve(true)
      },
      Math.max(0, ms),
    )

    const onAbort = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      resolve(false)
    }

    signal.addEventListener("abort", onAbort, { once: true })
  })
}
