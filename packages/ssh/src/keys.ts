import { createHash, randomUUID } from "node:crypto"
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import ssh2, { type ParsedKey } from "ssh2"
import { ConfigError } from "./errors.js"
import type { ServerConfig } from "./types.js"

const { utils } = ssh2

/** SSH key helpers: fingerprinting, single-key parse normalization, and host-key resolution. */

const HOST_KEYGEN_ATTEMPTS = 20
const isKeyInput = (value: unknown): value is string | Buffer => typeof value === "string" || Buffer.isBuffer(value)

/** OpenSSH-style SHA256 fingerprint of a raw public-key blob (`ssh-keygen -lf` form, e.g. `SHA256:nThbg6kX…`). */
export function sha256Fingerprint(publicKeyBlob: Buffer): string {
  const digest = createHash("sha256").update(publicKeyBlob).digest("base64")
  return `SHA256:${digest.replace(/=+$/, "")}`
}

/**
 * Parse a single SSH key from any form `utils.parseKey` accepts (PEM,
 * `authorized_keys` line, PPK), returning `null` on a parse error so callers
 * choose their own failure. parseKey returns an array for multi-key inputs;
 * this narrows to the first key.
 */
export function parseOneKey(input: string | Buffer): ParsedKey | null {
  const parsed = utils.parseKey(input)
  if (parsed instanceof Error) return null
  return Array.isArray(parsed) ? parsed[0]! : parsed
}

function generateParseableHostKey(): string {
  for (let i = 0; i < HOST_KEYGEN_ATTEMPTS; i++) {
    const pair = utils.generateKeyPairSync("ed25519")
    if (parseOneKey(pair.private)) return pair.private
  }
  throw new ConfigError("could not generate a parseable ed25519 host key")
}

/** Resolve host-key PEM(s) + fingerprints: explicit PEM, persisted path, or ephemeral. */
export function resolveHostKey(config: Pick<ServerConfig, "hostKey">): {
  hostKeyPems: (string | Buffer)[]
  fingerprints: string[]
  algorithms: string[]
  source: string
} {
  const hostKey = config.hostKey
  let hostKeyPems: (string | Buffer)[]
  let source: string

  if (hostKey === undefined) {
    hostKeyPems = [generateParseableHostKey()]
    source = "ephemeral"
  } else if (!hostKey || typeof hostKey !== "object" || Array.isArray(hostKey)) {
    throw new ConfigError("hostKey must contain either path or pem")
  } else if ("pem" in hostKey) {
    if ("path" in hostKey) throw new ConfigError("hostKey must contain either path or pem, not both")
    if (!(isKeyInput(hostKey.pem) || (Array.isArray(hostKey.pem) && hostKey.pem.every(isKeyInput)))) {
      throw new ConfigError("hostKey.pem must be a key or array of keys")
    }
    hostKeyPems = Array.isArray(hostKey.pem) ? hostKey.pem : [hostKey.pem]
    source = "provided"
  } else if ("path" in hostKey) {
    if (typeof hostKey.path !== "string" || hostKey.path.length === 0) {
      throw new ConfigError("hostKey.path must be a non-empty string")
    }
    if (existsSync(hostKey.path)) {
      hostKeyPems = [readFileSync(hostKey.path)]
      source = `loaded ${hostKey.path}`
    } else {
      // First run: generate an ed25519 key, persist it owner-only, and use it.
      // POSIX-only hardening (dir 0700, key 0600), mirroring charmbracelet/keygen.
      // Windows has no POSIX mode bits, so there the key inherits the directory ACL.
      const pem = generateParseableHostKey()
      mkdirSync(dirname(hostKey.path), { recursive: true, mode: 0o700 })
      const temporaryPath = `${hostKey.path}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporaryPath, pem, { mode: 0o600, flag: "wx" })
        try {
          linkSync(temporaryPath, hostKey.path)
          hostKeyPems = [pem]
          source = `generated ${hostKey.path}`
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
          hostKeyPems = [readFileSync(hostKey.path)]
          source = `loaded ${hostKey.path}`
        }
      } finally {
        try {
          unlinkSync(temporaryPath)
        } catch {
          // The temporary file may not exist if creation failed.
        }
      }
    }
  } else {
    throw new ConfigError("hostKey must contain either path or pem")
  }

  const keys = hostKeyPems.map((pem) => parseOneKey(pem))
  if (keys.length === 0) throw new ConfigError("hostKey.pem must contain at least one host key")
  if (keys.some((key) => !key)) throw new ConfigError(`could not parse host key (${source})`)
  return {
    hostKeyPems,
    fingerprints: keys.map((key) => sha256Fingerprint(key!.getPublicSSH() as Buffer)),
    algorithms: keys.map((key) => key!.type),
    source,
  }
}
