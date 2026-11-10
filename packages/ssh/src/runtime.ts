import { type Authenticator, resolveAuth } from "./auth.js"
import type { BannerDescriptor } from "./banner.js"
import { ConfigError } from "./errors.js"
import { resolveHostKey } from "./keys.js"
import { createSafeInvoke, type SafeInvoke } from "./safe.js"
import type { AuthConfig, ServerConfig } from "./types.js"

const MAX_DURATION_MS = 24 * 60 * 60 * 1_000
const DURATION_UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const
const DEFAULT_SESSION_LIMITS = { perConnection: 1, global: 100 } as const

/** Parse a duration into milliseconds: a number is ms; "10m"/"30s"/"500ms" is unit-suffixed. */
function parseDuration(name: string, value: string | number): number {
  let ms: number
  if (typeof value === "number") {
    ms = value
  } else {
    const match = /^(\d+)\s*(ms|s|m|h)?$/.exec(value.trim())
    if (!match) throw new ConfigError(`invalid ${name}: ${value}`)
    const unit = match[2] as keyof typeof DURATION_UNITS | undefined
    ms = Number(match[1]) * DURATION_UNITS[unit ?? "ms"]
  }
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_DURATION_MS) throw new ConfigError(`invalid ${name}: ${value}`)
  return ms
}

function parseLimit(name: string, value: number | undefined, fallback: number): number {
  const limit = value === undefined ? fallback : value
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new ConfigError(`invalid ${name}: ${limit}`)
  return limit
}

export interface ResolvedSessionLimits {
  perConnection: number
  global: number
}

/**
 * Everything a function of `config` alone, resolved once at startup. Nothing
 * here touches a live ssh2 connection.
 */
export interface ResolvedRuntime {
  /** Host-key PEM(s) handed to the ssh2 `Server`. */
  hostKeys: (string | Buffer)[]
  /** SHA256 fingerprints of every configured host key. */
  fingerprints: string[]
  /** The security core, normalized off `auth` (+ any static allowlist). */
  authenticator: Authenticator
  /** Idle reap budget in ms, or undefined when no `idleTimeout` was set. */
  idleTimeoutMs: number | undefined
  /** Absolute session lifetime in ms, or undefined when no `maxTimeout` was set. */
  maxTimeoutMs: number | undefined
  /** Hard bounds for concurrently retained renderer-backed shells. */
  sessionLimits: ResolvedSessionLimits
  /** The error sink, closed over `onError`. */
  safe: SafeInvoke
  /** True when `none` is the only advertised method — listen() warns outside localhost. */
  noneOnly: boolean
  /** Data the startup banner is rendered from; formatted by `formatBanner` (banner.ts). */
  banner: BannerDescriptor
}

/**
 * Resolve a `ServerConfig` into the runtime the server runs on. Reads config and
 * the filesystem (for host keys); does not touch ssh2 connections. Throws when
 * the config admits no one (empty credentials).
 */
export function resolveRuntime(config: ServerConfig<AuthConfig>): ResolvedRuntime {
  const { hostKeyPems, fingerprints, algorithms, source } = resolveHostKey(config)
  const idleTimeoutMs = config.idleTimeout != null ? parseDuration("idleTimeout", config.idleTimeout) : undefined
  const maxTimeoutMs = config.maxTimeout != null ? parseDuration("maxTimeout", config.maxTimeout) : undefined
  const sessionLimits: ResolvedSessionLimits = {
    perConnection: parseLimit(
      "limits.session.perConnection",
      config.limits?.session?.perConnection,
      DEFAULT_SESSION_LIMITS.perConnection,
    ),
    global: parseLimit("limits.session.global", config.limits?.session?.global, DEFAULT_SESSION_LIMITS.global),
  }

  // One error sink for handler, callback, connection, and server errors.
  const onError = config.onError ?? ((err: unknown) => console.error(err))
  // Keep user callback failures from escaping into ssh2 event handlers.
  const safe = createSafeInvoke(onError)

  // Auth failures from user predicates are reported through the same sink.
  const { authenticator, noneOnly, authorizedKeys } = resolveAuth(config.auth, safe.report)

  const banner: BannerDescriptor = { algorithms, source, methods: authenticator.advertisedMethods(), authorizedKeys }

  return {
    hostKeys: hostKeyPems,
    fingerprints,
    authenticator,
    idleTimeoutMs,
    maxTimeoutMs,
    sessionLimits,
    safe,
    noneOnly,
    banner,
  }
}
