/**
 * The package's error vocabulary: {@link SshError} for failures and
 * {@link DenyError} for intentional session denial.
 */

/**
 * Base for every failure this package throws. Carries a stable `code` so a
 * caller can branch without string-matching the message; `name` is the concrete
 * subclass (e.g. `"ConfigError"`).
 */
export class SshError extends Error {
  /** Stable, machine-branchable category — e.g. `"CONFIG"`. */
  readonly code: string
  constructor(code: string, message: string) {
    // Prefix with the package name: these are dev-facing (startup/`onError`),
    // never shown to a client, so the prefix leaks nothing. `DenyError` is the
    // exception — its message is the client-facing deny reason, so it stays plain.
    super(`@opentui/ssh: ${message}`)
    this.name = new.target.name
    this.code = code
  }
}

/**
 * A misconfiguration the developer must fix before the server can run (empty
 * credentials, an unparseable host key, a malformed `idleTimeout`). Thrown at
 * startup, never per-connection, so it surfaces when you wire the server up
 * rather than on a client's first connect.
 */
export class ConfigError extends SshError {
  constructor(message: string) {
    super("CONFIG", message)
  }
}

/**
 * The control-flow signal a middleware's `session.deny()` throws to unwind the
 * chain — not a failure. `runSession` swallows it; anything that is not a
 * `DenyError` routes to `onError`.
 */
export class DenyError extends Error {
  /** The reason passed to `deny()`, if any — already delivered to the client. */
  readonly reason: string | undefined
  constructor(reason?: string) {
    super(reason ?? "session denied")
    this.name = "DenyError"
    this.reason = reason
  }
}

/** True for the deny control-flow signal — the one throw `runSession` swallows. */
export const isDeny = (err: unknown): err is DenyError => err instanceof DenyError
