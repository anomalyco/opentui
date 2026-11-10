/**
 * Isolation guard for user callbacks. Each runs synchronously inside an ssh2
 * event handler, where an uncaught throw or rejection would reach ssh2's emitter
 * and could drop the connection or the process, and would starve sibling
 * callbacks in the same dispatch.
 *
 * `safe(fn)` runs a callback and routes any throw/rejection to the sink; its
 * returned promise always resolves, so callers can await without their own guard.
 * `safe.report(err)` sinks an error with no callback (connection/server errors).
 * A throwing sink is contained too.
 */
export interface SafeInvoke {
  (fn: () => unknown): Promise<void>
  /** Report an error directly to the sink, without ever letting the sink throw escape. */
  report(err: unknown): void
}

export function createSafeInvoke(onError: (err: unknown) => void): SafeInvoke {
  const report = (err: unknown) => {
    try {
      onError(err)
    } catch {
      // Last frame before ssh2's handler; a throwing sink cannot escape.
    }
  }

  const safe = async (fn: () => unknown): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      report(err)
    }
  }

  return Object.assign(safe, { report })
}

/**
 * Best-effort teardown: run `fn` and swallow any throw. Distinct from `safe`:
 * this ignores the error rather than routing it to `onError`, for cleanup paths
 * (renderer/channel/socket destroy) where a failure is not worth reporting.
 */
export function ignoreErrors(fn: () => void): void {
  try {
    fn()
  } catch {}
}
