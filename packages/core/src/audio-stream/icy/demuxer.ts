import { parseIcyMetadata } from "./metadata.js"
import type { AudioStreamMetadata } from "../../audio.js"
import type { AudioStreamDemuxer, AudioStreamDemuxOutput } from "../demuxer.js"

export interface IcyStreamDemuxerOptions {
  metadataInterval: number
  metadataEncoding?: string
  headers?: Readonly<Record<string, string>>
}

const EMPTY_FIELDS: Readonly<Record<string, string>> = Object.freeze(Object.create(null))

function copyHeaders(headers: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const copy: Record<string, string> = Object.create(null)
  for (const [name, value] of Object.entries(headers ?? {})) copy[name.toLowerCase()] = value
  return Object.freeze(copy)
}

function fieldsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key])
  )
}

export class IcyStreamDemuxer implements AudioStreamDemuxer<AudioStreamMetadata> {
  readonly initialMetadata: AudioStreamMetadata
  private audioRemaining: number
  private metadata: Uint8Array | null = null
  private metadataOffset = 0
  private fields = EMPTY_FIELDS
  private readonly interval: number
  private readonly decoder: TextDecoder
  private readonly headers: Readonly<Record<string, string>>

  constructor(options: IcyStreamDemuxerOptions) {
    if (!Number.isSafeInteger(options.metadataInterval) || options.metadataInterval < 0) {
      throw new TypeError("metadataInterval must be a non-negative safe integer")
    }
    this.interval = options.metadataInterval
    try {
      this.decoder = new TextDecoder(options.metadataEncoding ?? "iso-8859-1")
    } catch {
      throw new TypeError(`Unsupported metadataEncoding: ${options.metadataEncoding}`)
    }
    this.headers = copyHeaders(options.headers)
    this.audioRemaining = this.interval
    this.initialMetadata = Object.freeze({ format: "icy", headers: this.headers, fields: this.fields })
  }

  *push(chunk: Uint8Array): IterableIterator<AudioStreamDemuxOutput<AudioStreamMetadata>> {
    if (this.interval === 0) {
      if (chunk.byteLength > 0) yield { type: "audio", data: chunk }
      return
    }

    let offset = 0
    while (offset < chunk.byteLength) {
      if (this.audioRemaining > 0) {
        const length = Math.min(this.audioRemaining, chunk.byteLength - offset)
        yield { type: "audio", data: chunk.subarray(offset, offset + length) }
        offset += length
        this.audioRemaining -= length
        continue
      }

      if (this.metadata == null) {
        const metadataLength = (chunk[offset] ?? 0) * 16
        offset += 1
        if (metadataLength === 0) {
          this.audioRemaining = this.interval
          continue
        }
        this.metadata = new Uint8Array(metadataLength)
        this.metadataOffset = 0
      }

      const metadata = this.metadata
      const length = Math.min(metadata.byteLength - this.metadataOffset, chunk.byteLength - offset)
      metadata.set(chunk.subarray(offset, offset + length), this.metadataOffset)
      offset += length
      this.metadataOffset += length
      if (this.metadataOffset !== metadata.byteLength) continue

      const fields = parseIcyMetadata(metadata, this.decoder)
      this.metadata = null
      this.metadataOffset = 0
      this.audioRemaining = this.interval
      if (fields != null && !fieldsEqual(this.fields, fields)) {
        this.fields = fields
        yield {
          type: "metadata",
          metadata: Object.freeze({ format: "icy", headers: this.headers, fields }),
        }
      }
    }
  }

  *flush(): IterableIterator<AudioStreamDemuxOutput<AudioStreamMetadata>> {
    if (this.interval === 0) return
    if (this.audioRemaining === 0 || this.metadata != null) {
      throw new Error("ICY stream ended inside a metadata block")
    }
  }
}

export function createIcyStreamDemuxer(options: IcyStreamDemuxerOptions): AudioStreamDemuxer<AudioStreamMetadata> {
  return new IcyStreamDemuxer(options)
}
