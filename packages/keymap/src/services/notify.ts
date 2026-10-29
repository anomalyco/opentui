import type { Events, HookName, Hooks, KeymapEvent } from "../types.js"
import type { RuntimeEmitter } from "../lib/runtime-utils.js"
import type { State } from "./state.js"

type DiagnosticEvents<TTarget extends object, TEvent extends KeymapEvent> = Pick<
  Events<TTarget, TEvent>,
  "warning" | "error"
>

export const MAX_STATE_CHANGE_FLUSH_ITERATIONS = 1000

export interface NotificationService<TTarget extends object, TEvent extends KeymapEvent> {
  runWithStateChangeBatch<T>(fn: () => T): T
  queueStateChange(options?: { invalidateCaches?: boolean }): void
  /** Runs right before each `state` event. */
  onStateEvent(listener: () => void): void
  emitWarning(code: string, warning: unknown, message: string): void
  emitError(code: string, error: unknown, message: string): void
  reportListenerError(name: HookName, error: unknown): void
  warnOnce(key: string, code: string, warning: unknown, message: string): void
}

export function createNotificationService<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
  events: RuntimeEmitter<DiagnosticEvents<TTarget, TEvent>>,
  hooks: RuntimeEmitter<Hooks<TTarget, TEvent>>,
): NotificationService<TTarget, TEvent> {
  const emitWarning = (code: string, warning: unknown, message: string): void => {
    if (!events.has("warning")) {
      const consoleMessage = `[${code}] ${message}`
      if (warning instanceof Error) {
        console.warn(consoleMessage, warning)
      } else {
        console.warn(consoleMessage)
      }

      return
    }

    events.emit("warning", { code, message, warning })
  }

  const emitError = (code: string, error: unknown, message: string): void => {
    if (!events.has("error")) {
      const consoleMessage = `[${code}] ${message}`
      if (error instanceof Error) {
        console.error(consoleMessage, error)
      } else {
        console.error(consoleMessage)
      }

      return
    }

    events.emit("error", { code, message, error })
  }

  let beforeStateEvent: (() => void) | undefined

  const flushStateChange = (): void => {
    if (!state.stateChangePending || state.stateChangeDepth > 0 || state.flushingStateChange) {
      return
    }

    state.flushingStateChange = true

    try {
      let iterations = 0

      while (state.stateChangePending && state.stateChangeDepth === 0) {
        if (iterations >= MAX_STATE_CHANGE_FLUSH_ITERATIONS) {
          state.stateChangePending = false
          emitError(
            "state-change-feedback-loop",
            { iterations: MAX_STATE_CHANGE_FLUSH_ITERATIONS },
            `[Keymap] Possible infinite state listener feedback loop detected after ${MAX_STATE_CHANGE_FLUSH_ITERATIONS} iterations; pending state notifications were dropped`,
          )
          break
        }

        iterations += 1
        state.stateChangePending = false
        beforeStateEvent?.()
        hooks.emit("state")
      }
    } finally {
      state.flushingStateChange = false
    }
  }

  return {
    runWithStateChangeBatch(fn) {
      state.stateChangeDepth += 1

      try {
        return fn()
      } finally {
        state.stateChangeDepth -= 1
        if (state.stateChangeDepth === 0) {
          flushStateChange()
        }
      }
    },
    queueStateChange(options) {
      state.derivedVersion += 1
      if (options?.invalidateCaches !== false) {
        state.cacheVersion += 1
      }

      if (!hooks.has("state")) {
        return
      }

      state.stateChangePending = true
      if (state.stateChangeDepth === 0 && !state.flushingStateChange) {
        flushStateChange()
      }
    },
    onStateEvent(listener) {
      beforeStateEvent = listener
    },
    emitWarning,
    emitError,
    reportListenerError(name, error) {
      if (name === "state") {
        emitError("state-listener-error", error, "[Keymap] Error in state listener:")
        return
      }

      if (name === "pendingSequence") {
        emitError("pending-sequence-listener-error", error, "[Keymap] Error in pending sequence listener:")
        return
      }

      if (name === "dispatch") {
        emitError("dispatch-listener-error", error, "[Keymap] Error in dispatch listener:")
      }
    },
    warnOnce(key, code, warning, message) {
      if (state.usedWarningKeys.has(key)) {
        return
      }

      state.usedWarningKeys.add(key)
      emitWarning(code, warning, message)
    },
  }
}
