import { sha256Fingerprint } from "./keys.js"
import type { ListenInfo } from "./types.js"

/** Data a startup banner is rendered from; a function of config alone. */
export interface BannerDescriptor {
  /** Host-key algorithms in fingerprint order. */
  algorithms: string[]
  /** Where the host key came from: "provided" / "ephemeral" / "loaded …" / "generated …". */
  source: string
  /** Advertised auth methods, in banner order. */
  methods: string[]
  /** Base64 public-SSH blobs of the static allowlist; sampled for display. */
  authorizedKeys?: Set<string>
}

/** Startup-summary lines for `listen()`: pure formatting over a {@link BannerDescriptor} and bind. */
export function formatBanner(info: ListenInfo, descriptor: BannerDescriptor): string[] {
  const displayHost = info.host === "0.0.0.0" || info.host === "::" ? "localhost" : info.host
  const urlHost = displayHost.includes(":") ? `[${displayHost}]` : displayHost
  const lines = [
    `@opentui/ssh  ▸  ssh://${urlHost}:${info.port}`,
    ...info.fingerprints.map(
      (fingerprint, index) => `host key      ${fingerprint}  (${descriptor.algorithms[index]}, ${descriptor.source})`,
    ),
    `auth          ${descriptor.methods.join(", ")}`,
  ]
  if (descriptor.authorizedKeys?.size) {
    const fps = [...descriptor.authorizedKeys].slice(0, 3).map((b64) => sha256Fingerprint(Buffer.from(b64, "base64")))
    const more = descriptor.authorizedKeys.size > fps.length ? " …" : ""
    lines.push(`authorized    ${descriptor.authorizedKeys.size} keys  ·  ${fps.join(" ")}${more}`)
  }
  return lines
}
