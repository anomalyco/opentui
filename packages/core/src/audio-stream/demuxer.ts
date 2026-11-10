import { createIcyStreamDemuxer } from "./icy/demuxer.js"
import type { AudioStreamMetadata } from "../audio.js"

export type AudioStreamDemuxOutput<M> = { type: "audio"; data: Uint8Array } | { type: "metadata"; metadata: M | null }

export interface AudioStreamDemuxer<M> {
  readonly initialMetadata: M | null
  push(chunk: Uint8Array): Iterable<AudioStreamDemuxOutput<M>>
  flush(): Iterable<AudioStreamDemuxOutput<M>>
  abort?(reason: unknown): void
}

export type AudioStreamDemuxerFactory<M> = () => AudioStreamDemuxer<M>

export function selectAudioStreamDemuxer(options: {
  headers: Headers
  metadataEncoding: string
}): AudioStreamDemuxer<AudioStreamMetadata> | null {
  const icyHeaders: Record<string, string> = Object.create(null)
  options.headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith("icy-")) icyHeaders[name.toLowerCase()] = value
  })
  const headers = Object.freeze(icyHeaders)
  const rawInterval = options.headers.get("icy-metaint")
  if (rawInterval == null) {
    return Object.keys(headers).length === 0
      ? null
      : createIcyStreamDemuxer({ metadataInterval: 0, metadataEncoding: options.metadataEncoding, headers })
  }

  const value = rawInterval.trim()
  if (!/^\d+$/.test(value)) throw new Error(`Invalid icy-metaint response header: ${rawInterval}`)
  const interval = Number(value)
  if (!Number.isSafeInteger(interval)) throw new Error(`Invalid icy-metaint response header: ${rawInterval}`)
  return createIcyStreamDemuxer({ metadataInterval: interval, metadataEncoding: options.metadataEncoding, headers })
}
