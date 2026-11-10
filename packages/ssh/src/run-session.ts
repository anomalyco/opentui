import type { SessionBridge } from "./bridge.js"
import { isDeny } from "./errors.js"
import type { SafeInvoke } from "./safe.js"
import type { Identity, MiddlewareSession, Next, SessionHandler } from "./types.js"

/**
 * Erased middleware-chain type for the runtime. Type safety lives in the public
 * `ServerBuilder` interface; the impl runs with the contribution generic erased.
 */
export type RuntimeMiddleware<Id extends Identity = Identity> = (
  session: MiddlewareSession<Id>,
  next: Next,
) => unknown | Promise<unknown>

/**
 * Run the middleware onion around the handler for one session, then ensure the
 * session is closed once the chain settles.
 *
 * `dispatch()` invokes link `i`; the link continues by calling `next()`, which
 * recurses to link `i + 1`. `next(add)` merges `add` into the live per-session
 * context bag BEFORE advancing, so every downstream link and the handler read it.
 * The innermost `next()` reaches the leaf `bridge.enterApp(handler)`, which runs
 * the handler and resolves at teardown — so a link's post-`next()` code runs as
 * teardown. First `.use()` is the OUTERMOST link (use order === execution order).
 *
 * Settling means the session is over: normally at disconnect, or early when a link
 * calls `deny()` (swallowed here) or never calls `next()`. The `finally` closes the
 * session either way; `end()` is idempotent. A real (non-deny) throw reaches
 * `safe()` → `onError`.
 */
export function runSession(
  middlewares: RuntimeMiddleware[],
  handler: SessionHandler,
  bridge: SessionBridge,
  safe: SafeInvoke,
): void {
  const session = bridge.session
  const context = session.context as Record<string, unknown>

  const dispatch = async (index: number): Promise<void> => {
    // The leaf owns the renderer lifecycle and resolves at teardown.
    if (index === middlewares.length) return bridge.enterApp(handler)
    const mw = middlewares[index]!
    // Calling next() twice would re-run the rest of the chain; reject it.
    // Contained by safe() → onError.
    let nextCalled = false
    const next = (add?: object): Promise<void> => {
      if (nextCalled) throw new Error("@opentui/ssh: next() called more than once in a single middleware")
      nextCalled = true
      if (add) Object.assign(context, add)
      return dispatch(index + 1)
    }
    // Await the returned handoff so post-next teardown runs. The `Handoff` brand is erased here.
    await mw(session as MiddlewareSession, next as unknown as Next)
  }

  void safe(async () => {
    try {
      await dispatch(0)
    } catch (err) {
      // deny() already wrote the reason and closed the session; the throw only
      // unwinds the chain, so swallow it. Anything else is a real failure for safe().
      if (!isDeny(err)) throw err
    } finally {
      session.end()
    }
  })
}
