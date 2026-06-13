import type { CliRenderer } from "@opentui/core"

/** A client public key as surfaced by ssh2 during authentication. */
export type PublicKey = { algorithm: string; blob: Buffer }

/**
 * Discriminated union on `method`; only `publickey` carries `fingerprint`/`publicKey`.
 * {@link IdentityFor} narrows it to exactly the configured methods.
 *
 * Security note: `username` is client-supplied. For `publickey`, key ownership is
 * verified but the name is not; authorize by `fingerprint` and pair names to keys
 * in `auth.publicKey.allow` if you need that binding. For password and
 * keyboard-interactive auth, the name is only as trustworthy as your predicate.
 */
export type Identity =
  | { method: "none"; username: string }
  | { method: "password"; username: string }
  | { method: "keyboard-interactive"; username: string }
  | {
      method: "publickey"
      /** Client-supplied label; not bound to the key. */
      username: string
      /** The verified principal: SHA256 fingerprint of the authenticated key. */
      fingerprint: string
      publicKey: PublicKey
    }

export interface RemoteAddress {
  readonly address: string
  readonly port?: number
}

declare const HANDOFF: unique symbol
/**
 * Opaque token returned by `next()`. Middleware return it to prove control was
 * handed onward; `Add` is the context contributed by `next(add)`.
 */
export interface Handoff<Add extends object = object> {
  readonly [HANDOFF]: Add
}

/**
 * Hand off to the rest of the chain. Call bare to continue, or pass an object to
 * contribute typed context to downstream middleware and the handler. The promise
 * resolves when the session ends, making `finally` blocks natural teardown points.
 */
export interface Next {
  (): Promise<Handoff>
  <Add extends object>(add: Add): Promise<Handoff<Add>>
}

/** Fields every session exposes, whether held by a middleware or the handler. */
export interface SessionCommon<Id extends Identity = Identity> {
  /** Who connected, and how — narrowed to the configured auth methods. */
  readonly identity: Id
  /** Terminal type reported by the client (e.g. "xterm-256color"). */
  readonly term: string
  /** Current terminal size; updates on resize. */
  readonly cols: number
  readonly rows: number
  /** Whether the client requested a PTY; false for bare shell channels. */
  readonly hasPty: boolean
  /** Client socket address for logging, rate limiting, and policy. */
  readonly remoteAddress: RemoteAddress
  /** Fired when the client resizes; renderer is already resized for you. */
  onResize(cb: (cols: number, rows: number) => void): () => void
  /**
   * Fired when the client disconnects. The renderer is already destroyed; use this
   * for app-owned teardown such as framework roots, timers, or counters.
   */
  onClose(cb: () => void): () => void
  /**
   * Write raw bytes to the client terminal, bypassing frame diffing — the escape
   * hatch for control the renderer doesn't model (OSC 52, title, bell). No-op once closed.
   */
  write(data: Buffer | string): void
  /** Force-close this session. */
  end(): void
}

/**
 * The session shape middleware receives. The renderer is created only after the
 * chain authorizes, so gating middleware can deny before the alternate screen is
 * entered. Contribute context with `next({ ... })`; gate with `deny()`.
 */
export interface MiddlewareSession<
  Id extends Identity = Identity,
  Ctx extends object = object,
> extends SessionCommon<Id> {
  /** Typed contributions from earlier middleware; `{}` at the chain head. */
  readonly context: Ctx
  /**
   * Deny this session before the handler runs. A reason is written to the main
   * screen, the session closes, and the middleware chain unwinds as intended.
   */
  deny(reason?: string): never
}

/**
 * A reusable middleware: annotate a function with this type to author one outside
 * a `.use(...)` call. `Add` is the context it contributes via `next({ ... })`; it
 * sees the wide `Identity` and an untyped upstream `context` (a standalone link
 * can't know what precedes it — use {@link MiddlewareFunction} to require a `Ctx`).
 */
export type Middleware<Id extends Identity = Identity, Add extends object = object> = (
  session: MiddlewareSession<Id>,
  next: Next,
) => Handoff<Add> | Promise<Handoff<Add>>

/**
 * The call signature `.use(...)` accepts. `Ctx` is what earlier links contributed;
 * `Add` is inferred from this link's `next({ ... })` call.
 */
export type MiddlewareFunction<
  Id extends Identity = Identity,
  Ctx extends object = object,
  Add extends object = object,
> = (session: MiddlewareSession<Id, Ctx>, next: Next) => Handoff<Add> | Promise<Handoff<Add>>

/**
 * The per-session app handler. Receives a {@link Session} with the live renderer
 * and combined middleware context. The renderer is destroyed on disconnect;
 * `session.onClose` is for app-owned teardown.
 */
export type SessionHandler<Id extends Identity = Identity, Ctx extends object = {}> = (
  session: Session<Id, Ctx>,
) => void | Promise<void>

/**
 * The session shape the handler receives: common fields plus the attached renderer
 * and typed context.
 */
export interface Session<Id extends Identity = Identity, Ctx extends object = {}> extends SessionCommon<Id> {
  /** The sum of every middleware's contribution; `{}` with no middleware. Each session gets its own bag. */
  readonly context: Ctx
  /**
   * Pre-wired renderer: stdin/stdout = SSH channel, dims = client PTY. Use `write`
   * for raw output the renderer doesn't model.
   */
  readonly renderer: CliRenderer
}

/**
 * Public-key admission policy. A key is admitted when it matches `authorizedKeys`,
 * when `allow` returns true, or both.
 */
export interface PublicKeyPolicy {
  /** Static allowlist: a path to an authorized_keys file, or an array of public key strings. */
  authorizedKeys?: string | string[]
  /**
   * Dynamic decision for checks a static file cannot express, such as DB lookup,
   * revocation, or username-to-key pairing. Runs only after the signature verifies,
   * so `fingerprint` and `publicKey` refer to a proven key.
   */
  allow?: (ctx: { username: string; fingerprint: string; publicKey: PublicKey }) => boolean | Promise<boolean>
}

/** Promise-based keyboard-interactive prompt, bridged onto ssh2's callback flow. */
export type KeyboardPrompt = (questions: { prompt: string; echo: boolean }[]) => Promise<string[]>

/** The credential methods a client can present. Not re-exported from the package index. */
export interface CredentialMethods {
  /**
   * Public-key auth. `"any"` accepts & identifies any key; a `PublicKeyPolicy`
   * configures an allowlist, an `allow` predicate, or both. `session.identity` is
   * the publickey variant either way.
   */
  publicKey?: "any" | PublicKeyPolicy
  /** Password check. */
  password?: (ctx: { username: string; password: string }) => boolean | Promise<boolean>
  /** Keyboard-interactive flow. */
  keyboardInteractive?: (ctx: { username: string; prompt: KeyboardPrompt }) => boolean | Promise<boolean>
}

/**
 * The credential methods a client can present. Each is optional and they merge
 * (the server advertises every one you set; the client picks). An empty set is
 * rejected at startup; use `auth: "open"` for deliberate no-auth.
 *
 * `none` is typed `never` so a no-auth server and a credentialed one cannot be
 * mixed: `{ none: true, publicKey }` is a compile error, not a silent open server.
 */
export interface AuthMethods extends CredentialMethods {
  /** Not a credential — use `auth: "open"` for no authentication. */
  none?: never
}

/**
 * How clients authenticate: either `"open"` or a configured set of auth methods.
 */
export type AuthConfig = "open" | AuthMethods

/** Maps each configured credential key to its Identity variant. */
type CredentialVariant = {
  password: Extract<Identity, { method: "password" }>
  keyboardInteractive: Extract<Identity, { method: "keyboard-interactive" }>
  publicKey: Extract<Identity, { method: "publickey" }>
}

/** The credential keys actually configured in `A` (value is not `undefined`). */
type ConfiguredCredentialKeys<A extends AuthMethods> = {
  [K in keyof A & keyof CredentialVariant]: A[K] extends undefined ? never : K
}[keyof A & keyof CredentialVariant]

/**
 * Narrows `Identity` to exactly the methods `A` configures: `"open"` → the `none`
 * variant; an `AuthMethods` set → the union of its configured methods. You can only
 * read a field you required.
 */
export type IdentityFor<A extends AuthConfig = "open"> = A extends "open"
  ? Extract<Identity, { method: "none" }>
  : A extends AuthMethods
    ? CredentialVariant[ConfiguredCredentialKeys<A> & keyof CredentialVariant]
    : never

/** Static server configuration, excluding the middleware chain and handler. */
export interface ServerConfig<A extends AuthConfig = "open"> {
  /**
   * How clients authenticate. Defaults to `"open"` (no auth) for localhost. Set a
   * `AuthMethods` set instead: `{ publicKey: "any" }`, `{ publicKey: { authorizedKeys } }`, `{ password }`, …
   * `session.identity` narrows to exactly the methods configured here. Listening
   * on a host other than `localhost`, `127.0.0.1`, or `::1` while `"open"` warns
   * (never throws); empty credentials throw.
   */
  auth?: A
  /** Host key source. If `path` is given and missing, it is generated & saved. */
  hostKey?: { path: string } | { pem: string | Buffer | (string | Buffer)[] }
  /** Disconnect after this much inactivity, e.g. "10m" or ms. Optional. */
  idleTimeout?: string | number
  /** Disconnect after this absolute session lifetime, e.g. "1h" or ms. Optional. */
  maxTimeout?: string | number
  /** Resource limits for renderer-backed SSH shell sessions. */
  limits?: {
    session?: {
      /** Maximum live shell sessions on one SSH connection. Default 1. */
      perConnection?: number
      /** Maximum live shell sessions across this server. Default 100. */
      global?: number
    }
  }
  /** Startup summary printed on listen(). Default true; set false to silence. */
  startupBanner?: boolean
  /**
   * The single runtime error sink — the *report* path. Contained application and
   * transport errors land here: a throwing handler/middleware, a throwing
   * `onResize`/`onClose`, a throwing auth predicate, and per-connection /
   * server-level ssh2 errors. Logging sink failures are isolated and ignored so
   * observability cannot affect a session.
   * Defaults to `console.error`. A bind failure during `listen()` rejects the
   * `listen()` promise instead of coming here.
   *
   * This is reporting, not reacting: to *react* to a session (deny, enrich, tear
   * down, render an error screen) use middleware or `onClose`; to *observe* the
   * connection lifecycle use the `logging` middleware.
   */
  onError?: (err: unknown) => void
}

/** What `listen()` resolves to — useful for tests and programmatic callers. */
export interface ListenInfo {
  host: string
  port: number
  /** SHA256 fingerprints for every configured host key, in configuration order. */
  fingerprints: string[]
}

/**
 * The builder returned by `createServer`. `.use(mw)` adds a link and accumulates
 * its contribution into `Ctx`, so each subsequent `.use` and the handler see a
 * `context` typed as the sum of every upstream link. No `listen` here — you must
 * `serve(handler)` first, so "forgot the handler" is a compile error. `.use(...)`
 * order === execution order: the first middleware is the outermost link.
 */
export interface ServerBuilder<Id extends Identity = Identity, Ctx extends object = {}> {
  /**
   * Add a middleware link. Pass an inline arrow (`Id`/`Ctx` flow from the builder,
   * contribution inferred from `next({ ... })`) or a reusable function typed as
   * {@link Middleware} / {@link MiddlewareFunction}. Returns a builder whose `Ctx`
   * is widened by this link's contribution.
   */
  use<Add extends object>(mw: MiddlewareFunction<Id, Ctx, Add>): ServerBuilder<Id, Ctx & Add>
  /**
   * Seal the chain with the handler and return the startable server. The handler's
   * `session.context` is the accumulated `Ctx`.
   */
  serve(handler: SessionHandler<Id, Ctx>): Server
}

export interface Server {
  /**
   * Bind and start accepting (and, unless silenced, print the startup banner).
   * Defaults to `2222` on `127.0.0.1` — pass `0` for an ephemeral port. Listening
   * on a host other than `localhost`, `127.0.0.1`, or `::1` with no auth logs a
   * warning (never throws).
   */
  listen(port?: number, host?: string): Promise<ListenInfo>
  /** Stop accepting, destroy live renderers, close the listener. */
  close(): Promise<void>
}
