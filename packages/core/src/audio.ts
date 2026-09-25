import { EventEmitter } from "events"
import { randomBytes } from "node:crypto"
import { open as openFile, readFile, rename, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import {
  selectAudioStreamDemuxer,
  type AudioStreamDemuxer,
  type AudioStreamDemuxerFactory,
  type AudioStreamDemuxOutput,
} from "./audio-stream/demuxer.js"
import { resolveRenderLib, type AudioEngineHandle, type RenderLib } from "./zig.js"
import {
  NativeAudioStreamCloseReason as CloseReason,
  NativeAudioStreamFormat as NativeStreamFormat,
  NativeAudioStreamState as StreamState,
  NativeAudioStreamStateNames as StateNames,
  type AudioStreamCreateOptions,
  type AudioStats,
  type NativeAudioStreamCloseReason,
  type NativeAudioStreamFormat,
  type NativeAudioStreamStats,
} from "./zig-structs.js"

export interface AudioSetupOptions {
  autoStart?: boolean
  sampleRate?: number
  playbackChannels?: number
  startOptions?: AudioStartOptions
}

export interface AudioStartOptions {
  periodSizeInFrames?: number
  periodSizeInMilliseconds?: number
  periods?: number
  performanceProfile?: number
  shareMode?: number
  noPreSilencedOutputBuffer?: boolean
  noClip?: boolean
  noDisableDenormals?: boolean
  noFixedSizedCallback?: boolean
  wasapiNoAutoConvertSrc?: boolean
  wasapiNoDefaultQualitySrc?: boolean
  alsaNoMMap?: boolean
  alsaNoAutoFormat?: boolean
  alsaNoAutoChannels?: boolean
  alsaNoAutoResample?: boolean
}

export interface AudioPlayOptions {
  volume?: number
  pan?: number
  loop?: boolean
  groupId?: number
}

export type AudioStreamBody = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>

export type AudioStreamFormat = "mp3" | "flac" | "pcm"

export interface AudioStreamContentTypeContext {
  readonly format: AudioStreamFormat
  readonly contentType: string | null
  readonly status: number
  readonly url: string
}

export type AudioStreamContentTypePolicy = "validate" | "ignore" | ((context: AudioStreamContentTypeContext) => boolean)

export interface AudioStreamConnectContext {
  readonly signal: AbortSignal
  readonly attempt: number
}

export interface AudioStreamConnection<I = unknown> {
  readonly body: AudioStreamBody
  readonly info: I
  close?(): void | Promise<void>
}

export type AudioStreamRetryPhase = "connect" | "read"

export interface AudioStreamRetryContext {
  readonly attempt: number
  readonly maxRetries: number
  readonly phase: AudioStreamRetryPhase
}

export type AudioStreamRetryDecision = false | { readonly delayMs?: number }

export interface AudioStreamConnector<I = unknown> {
  connect(context: AudioStreamConnectContext): Promise<AudioStreamConnection<I>>
}

export interface AudioStreamBufferOptions {
  capacityMs?: number
  startupMs?: number
  resumeMs?: number
}

export interface AudioStreamReconnectOptions {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffFactor?: number
  retryOnEnd?: boolean
  retry?(error: AudioStreamError, context: AudioStreamRetryContext): AudioStreamRetryDecision
}

export interface AudioStreamOptions {
  format?: AudioStreamFormat
  /** Required for raw PCM. Input consists of interleaved little-endian float32 samples. */
  sampleFormat?: "f32le"
  sampleRate?: number
  channels?: 1 | 2
  volume?: number
  pan?: number
  groupId?: number
  maxProbeBytes?: number
  buffer?: AudioStreamBufferOptions
  signal?: AbortSignal
}

export interface AudioStreamBodyOptions<M = AudioStreamMetadata> extends AudioStreamOptions {
  demuxer?: AudioStreamDemuxerFactory<M>
  contentTypePolicy?: never
  request?: never
  reconnect?: never
  metadataEncoding?: never
}

export interface AudioStreamSourceOptions<I = unknown, M = AudioStreamMetadata> extends AudioStreamOptions {
  demuxer?: (info: I) => AudioStreamDemuxer<M> | null
  reconnect?: AudioStreamReconnectOptions
  contentTypePolicy?: never
  request?: never
  metadataEncoding?: never
}

export interface AudioStreamUrlOptions extends AudioStreamOptions {
  request?: Omit<RequestInit, "body" | "signal">
  reconnect?: AudioStreamReconnectOptions
  metadataEncoding?: string
  contentTypePolicy?: AudioStreamContentTypePolicy
  demuxer?: never
}

export type AudioStreamState =
  | "initializing"
  | "buffering"
  | "playing"
  | "reconnecting"
  | "ended"
  | "errored"
  | "disposed"

export interface AudioStreamStats {
  state: AudioStreamState
  sampleRate: number
  channels: number
  bufferedFrames: number
  capacityFrames: number
  bufferedDurationMs: number
  bytesReceived: bigint
  framesDecoded: bigint
  framesPlayed: bigint
  underruns: number
  reconnectAttempts: number
}

export type AudioStreamMetadataFormat = "icy"

export interface AudioStreamMetadata {
  readonly format: AudioStreamMetadataFormat
  readonly headers: Readonly<Record<string, string>>
  readonly fields: Readonly<Record<string, string>>
}

export type AudioStreamAction =
  | "fetch"
  | "response"
  | "source"
  | "demuxer"
  | "create"
  | "write"
  | "end"
  | "restart"
  | "stats"
  | "decoder"
  | "destroy"
  | "setVolume"
  | "setPan"
  | "setGroup"

export interface AudioStreamErrorContext {
  action: AudioStreamAction
  status?: number
  errorCode?: number
  attempt?: number
}

export interface AudioStreamReconnectEvent {
  attempt: number
  delayMs: number
  maxRetries: number
  error: AudioStreamError
}

export interface AudioStreamEvents<M = AudioStreamMetadata> {
  metadata: [metadata: M | null]
  reconnecting: [event: AudioStreamReconnectEvent]
  ended: []
  error: [error: Error, context: AudioStreamErrorContext]
  disposed: []
}

export type AudioGroup = number
export type AudioVoice = number
export type AudioSound = number

export interface AudioPlaybackDevice {
  index: number
  name: string
  isDefault: boolean
}

export interface AudioCaptureDevice {
  index: number
  name: string
  isDefault: boolean
}

export interface AudioCaptureOptions {
  channels?: number
  capacityFrames?: number
  startOptions?: AudioStartOptions
}

export interface AudioCaptureStreamOptions extends AudioCaptureOptions {
  chunkFrames?: number
  signal?: AbortSignal
}

export type AudioCaptureStreamState = "initializing" | "capturing" | "stopping" | "stopped" | "errored" | "disposed"

export type AudioCaptureStreamAction = "start" | "read" | "stop" | "stats" | "destroy"

export interface AudioCaptureStreamErrorContext {
  action: AudioCaptureStreamAction
  status?: number
}

export interface AudioCaptureStreamEvents {
  stopped: []
  error: [error: AudioCaptureStreamError, context: AudioCaptureStreamErrorContext]
  disposed: []
}

export interface AudioCaptureStats {
  sampleRate: number
  channels: number
  capacityFrames: number
  bufferedFrames: number
  framesReceived: bigint
  framesRead: bigint
  framesDropped: bigint
}

export interface AudioCaptureStreamStats extends AudioCaptureStats {
  state: AudioCaptureStreamState
  bufferedDurationMs: number
}

export interface AudioCaptureReadResult {
  frames: Float32Array
  framesRead: number
}

export type AudioRecordToFileOptions = AudioCaptureStreamOptions

export type AudioRecorderState = "initializing" | "recording" | "stopping" | "stopped" | "errored" | "disposed"

export type AudioRecorderAction =
  | "open"
  | "start"
  | "read"
  | "write"
  | "stop"
  | "finalize"
  | "publish"
  | "stats"
  | "destroy"

export interface AudioRecorderErrorContext {
  action: AudioRecorderAction
  status?: number
}

export interface AudioRecorderEvents {
  stopped: []
  error: [error: AudioRecorderError, context: AudioRecorderErrorContext]
  disposed: []
}

export interface AudioRecorderStats extends AudioCaptureStats {
  state: AudioRecorderState
  bufferedDurationMs: number
  framesWritten: bigint
  dataBytesWritten: bigint
  durationMs: number
}

export type AudioAction =
  | "createAudioEngine"
  | "start"
  | "startMixer"
  | "stop"
  | "loadSound"
  | "loadSoundFile"
  | "unloadSound"
  | "group"
  | "play"
  | "stopVoice"
  | "setVoiceGroup"
  | "setGroupVolume"
  | "setMasterVolume"
  | "mixFrames"
  | "enableTap"
  | "readTapFrames"
  | "listPlaybackDevices"
  | "selectPlaybackDevice"
  | "clearPlaybackDeviceSelection"
  | "listCaptureDevices"
  | "selectCaptureDevice"
  | "clearCaptureDeviceSelection"
  | "startCapture"
  | "readCaptureFrames"
  | "getCaptureStats"
  | "stopCapture"
  | "getStats"

export interface AudioErrorContext {
  action: AudioAction
  status?: number
}

export interface AudioEvents {
  error: [error: Error, context: AudioErrorContext]
  started: []
  mixerStarted: []
  captureStarted: []
  captureStopped: []
  stopped: []
  disposed: []
}

export type AudioInitializationAction = "resolveRenderLib" | "createAudioEngine" | "start"

export class AudioInitializationError extends Error {
  readonly action: AudioInitializationAction
  readonly status?: number

  constructor(action: AudioInitializationAction, message: string, status?: number, cause?: unknown) {
    super(message)
    this.name = "AudioInitializationError"
    this.action = action
    this.status = status
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause
  }
}

export class AudioCaptureStreamError extends Error {
  readonly context: AudioCaptureStreamErrorContext

  constructor(message: string, context: AudioCaptureStreamErrorContext, cause?: unknown) {
    super(message)
    this.name = "AudioCaptureStreamError"
    this.context = context
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause
  }
}

export class AudioRecorderError extends Error {
  readonly context: AudioRecorderErrorContext

  constructor(message: string, context: AudioRecorderErrorContext, cause?: unknown) {
    super(message)
    this.name = "AudioRecorderError"
    this.context = context
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause
  }
}

function statusToError(action: string, status: number): Error {
  return new Error(`Audio ${action} failed: ${status}`)
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

const DEFAULT_AUDIO_SAMPLE_RATE = 48_000
const DEFAULT_STREAM_PROBE_BYTES = 1024 * 1024
const STREAM_POLL_INTERVAL_MS = 5
const MAX_TIMER_DELAY_MS = 0x7fffffff
const MAX_U32 = 0xffffffff
const DEFAULT_CAPTURE_CHUNK_FRAMES = 2048
const CAPTURE_DISCARD_BATCH_CHUNKS = 32
const WAV_HEADER_BYTES = 44
const MAX_WAV_DATA_BYTES = BigInt(MAX_U32 - 36)
const INVALID_STREAM_CHUNK_MESSAGE = "Audio stream chunks must be Uint8Array instances"

interface ResolvedAudioCaptureStreamOptions {
  sampleRate: number
  channels: number
  capacityFrames: number
  chunkFrames: number
  startOptions?: AudioStartOptions
  signal?: AbortSignal
}

interface AudioCaptureOperationResult {
  status: number
  cause?: unknown
}

interface AudioCaptureReadOperationResult extends AudioCaptureOperationResult {
  frames: Float32Array
  framesRead: number
}

interface AudioCaptureStatsOperationResult extends AudioCaptureOperationResult {
  stats: AudioCaptureStats | null
}

interface ResolvedAudioStreamReconnectOptions {
  maxRetries: number
  initialDelayMs: number
  maxDelayMs: number
  backoffFactor: number
  retryOnEnd: boolean
  retry?: (error: AudioStreamError, context: AudioStreamRetryContext) => AudioStreamRetryDecision
}

interface ResolvedAudioStreamOptions {
  format: AudioStreamFormat
  native: AudioStreamCreateOptions
  signal?: AbortSignal
  reconnect?: ResolvedAudioStreamReconnectOptions
}

interface ResolvedAudioStreamConnection<I> {
  readonly body: AudioStreamBody
  readonly info: I
}

interface AudioStreamInit<I, M> {
  lib: RenderLib
  engine: AudioEngineHandle
  connector: AudioStreamConnector<I>
  demuxer?: (info: I) => AudioStreamDemuxer<M> | null
  options: AudioStreamOptions & { reconnect?: AudioStreamReconnectOptions }
  readAction: "fetch" | "source"
  removeFromOwner: () => void
}

interface AudioStreamAttempt<M> {
  controller: AbortController
  writeBatches: number
  body: AudioStreamBody | null
  closeConnection: (() => void | Promise<void>) | null
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  iterator: AsyncIterator<Uint8Array> | null
  demuxer: AudioStreamDemuxer<M> | null
  demuxerFinished: boolean
  sourceReleased: boolean
  sourceAcquisitionAttempted: boolean
  connectionClosed: boolean
  demuxerAborted: boolean
  resourceAcquisition: Promise<void> | null
  cleanupPromise: Promise<void> | null
}

export class AudioStreamError extends Error {
  readonly context: AudioStreamErrorContext

  constructor(message: string, context: AudioStreamErrorContext, cause?: unknown) {
    super(message)
    this.name = "AudioStreamError"
    this.context = context
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause
  }
}

class ClassifiedAudioStreamError extends AudioStreamError {
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(
    message: string,
    context: AudioStreamErrorContext,
    retryable: boolean,
    retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(message, context, cause)
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

function createAbortError(): Error {
  return new DOMException("The operation was aborted", "AbortError")
}

const isU32 = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= MAX_U32

function resolvePositiveU32(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || !Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a finite positive integer`)
  }
  if (resolved > MAX_U32) throw new RangeError(`${name} exceeds the supported limit`)
  return resolved
}

function resolveAudioCaptureStreamOptions(
  options: AudioCaptureStreamOptions,
  sampleRate: number,
): ResolvedAudioCaptureStreamOptions {
  const channels = resolvePositiveU32(options.channels, 1, "channels")
  const capacityFrames = resolvePositiveU32(options.capacityFrames, sampleRate, "capacityFrames")
  const chunkFrames = resolvePositiveU32(options.chunkFrames, DEFAULT_CAPTURE_CHUNK_FRAMES, "chunkFrames")
  if (chunkFrames > capacityFrames) throw new RangeError("chunkFrames must not exceed capacityFrames")
  if (chunkFrames > Math.floor(MAX_U32 / channels)) {
    throw new RangeError("chunkFrames * channels exceeds the supported limit")
  }
  return {
    sampleRate,
    channels,
    capacityFrames,
    chunkFrames,
    startOptions: options.startOptions,
    signal: options.signal,
  }
}

function resolveU32Index(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative integer`)
  }
  if (value > MAX_U32) throw new RangeError(`${name} exceeds the supported limit`)
  return value
}

function resolveReconnectOptions(options: AudioStreamReconnectOptions): ResolvedAudioStreamReconnectOptions {
  const maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY
  const initialDelayMs = options.initialDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 15_000
  const backoffFactor = options.backoffFactor ?? 2
  const retryOnEnd = options.retryOnEnd ?? false
  const retry = options.retry
  if (maxRetries !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
    throw new TypeError("reconnect.maxRetries must be a non-negative integer or Infinity")
  }

  if (!Number.isFinite(initialDelayMs) || !Number.isInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new TypeError("reconnect.initialDelayMs must be a finite non-negative integer")
  }
  if (!Number.isFinite(maxDelayMs) || !Number.isInteger(maxDelayMs) || maxDelayMs < 0) {
    throw new TypeError("reconnect.maxDelayMs must be a finite non-negative integer")
  }
  if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
    throw new TypeError("reconnect.backoffFactor must be a finite number greater than or equal to 1")
  }
  if (typeof retryOnEnd !== "boolean") {
    throw new TypeError("reconnect.retryOnEnd must be a boolean")
  }
  if (retry !== undefined && typeof retry !== "function") {
    throw new TypeError("reconnect.retry must be a function")
  }

  return {
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    backoffFactor,
    retryOnEnd,
    retry: retry == null ? undefined : (error, context) => retry.call(options, error, context),
  }
}

function resolveAudioStreamOptions(
  options: AudioStreamOptions & { reconnect?: AudioStreamReconnectOptions },
): ResolvedAudioStreamOptions {
  const format = resolveAudioStreamFormat(options.format)
  const sampleRate = options.sampleRate
  const channels = options.channels
  if (format === "pcm") {
    if (options.sampleFormat !== "f32le") throw new TypeError("PCM sampleFormat must be 'f32le'")
    if (typeof sampleRate !== "number" || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
      throw new RangeError("PCM sampleRate must be an integer from 8000 to 192000 Hz")
    }
    if (channels !== 1 && channels !== 2) throw new RangeError("PCM channels must be 1 or 2")
    if (options.reconnect !== undefined) throw new TypeError("PCM reconnect is not supported")
  } else if (sampleRate !== undefined || channels !== undefined || options.sampleFormat !== undefined) {
    throw new TypeError("sampleFormat, sampleRate, and channels are only supported for PCM streams")
  }
  const capacityMs = resolvePositiveU32(options.buffer?.capacityMs, 2000, "buffer.capacityMs")
  const startupMs = resolvePositiveU32(options.buffer?.startupMs, 1000, "buffer.startupMs")
  const resumeMs = resolvePositiveU32(options.buffer?.resumeMs, 1000, "buffer.resumeMs")
  const maxProbeBytes = resolvePositiveU32(options.maxProbeBytes, DEFAULT_STREAM_PROBE_BYTES, "maxProbeBytes")
  if (startupMs > capacityMs) throw new RangeError("buffer.startupMs must not exceed buffer.capacityMs")
  if (resumeMs > capacityMs) throw new RangeError("buffer.resumeMs must not exceed buffer.capacityMs")

  return {
    format,
    native: {
      format: toNativeAudioStreamFormat(format),
      sampleRate,
      channels,
      capacityMs,
      startupMs,
      resumeMs,
      volume: options.volume ?? 1,
      pan: options.pan ?? 0,
      groupId: options.groupId ?? 0,
      maxProbeBytes,
    },
    signal: options.signal,
    reconnect: options.reconnect === undefined ? undefined : resolveReconnectOptions(options.reconnect),
  }
}

function resolveAudioStreamConnector<I>(connector: AudioStreamConnector<I>): AudioStreamConnector<I> {
  const connect = connector?.connect
  if (typeof connect !== "function") throw new TypeError("Audio stream connector must define connect()")
  return { connect: (context) => connect.call(connector, context) }
}

function runBoundedCleanup(cleanup: () => unknown, timeoutMs: number = 50): Promise<void> {
  let result: Promise<unknown>
  try {
    result = Promise.resolve(cleanup()).catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    void result.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError())
  return new Promise((resolve, reject) => {
    let remainingMs = delayMs
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      const currentDelayMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS)
      timer = setTimeout(() => {
        remainingMs -= currentDelayMs
        if (remainingMs > 0) schedule()
        else {
          signal.removeEventListener("abort", onAbort)
          resolve()
        }
      }, currentDelayMs)
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(createAbortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
    schedule()
  })
}

function waitForPoll(signal: AbortSignal): Promise<boolean> {
  return waitForDelay(STREAM_POLL_INTERVAL_MS, signal)
    .then(() => true)
    .catch(() => false)
}

function parseRetryAfter(value: string | null, maxDelayMs: number): number | undefined {
  if (value == null) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelayMs, Math.ceil(seconds * 1000))
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return undefined
  return Math.min(maxDelayMs, Math.max(0, date - Date.now()))
}

function resolveAudioStreamFormat(value: AudioStreamFormat | undefined): AudioStreamFormat {
  const format = value ?? "mp3"
  if (format !== "mp3" && format !== "flac" && format !== "pcm")
    throw new TypeError(`Unsupported audio stream format: ${format}`)
  return format
}

function toNativeAudioStreamFormat(format: AudioStreamFormat): NativeAudioStreamFormat {
  switch (format) {
    case "mp3":
      return NativeStreamFormat.Mp3
    case "flac":
      return NativeStreamFormat.Flac
    case "pcm":
      return NativeStreamFormat.Pcm
  }
}

function resolveContentTypePolicy(
  value: AudioStreamContentTypePolicy | undefined,
  receiver: AudioStreamUrlOptions,
): AudioStreamContentTypePolicy {
  const policy = value ?? "validate"
  if (policy !== "validate" && policy !== "ignore" && typeof policy !== "function") {
    throw new TypeError("contentTypePolicy must be 'validate', 'ignore', or a function")
  }
  return typeof policy === "function" ? (context) => policy.call(receiver, context) : policy
}

function isAllowedContentType(format: AudioStreamFormat, value: string): boolean {
  const contentType = value.split(";", 1)[0]?.trim().toLowerCase()
  switch (format) {
    case "mp3":
      return ["audio/mpeg", "audio/mp3", "application/octet-stream", "application/mp3"].includes(contentType ?? "")
    case "flac":
      return ["audio/flac", "audio/x-flac", "application/octet-stream"].includes(contentType ?? "")
    case "pcm":
      return ["audio/pcm", "application/octet-stream"].includes(contentType ?? "")
  }
}

interface AudioStreamUrlConnectionInfo {
  readonly headers: Headers
  readonly status: number
}

function createAudioStreamUrlConnector(
  source: string | URL,
  request: Omit<RequestInit, "body" | "signal"> | undefined,
  format: AudioStreamFormat,
  contentTypePolicy: AudioStreamContentTypePolicy,
): AudioStreamConnector<AudioStreamUrlConnectionInfo> {
  return {
    async connect({ signal, attempt }) {
      let response: Response
      try {
        const headers = new Headers(request?.headers)
        if (!headers.has("icy-metadata")) headers.set("Icy-MetaData", "1")
        response = await globalThis.fetch(source, { ...request, headers, signal })
      } catch (cause) {
        throw new ClassifiedAudioStreamError(
          "Audio stream fetch failed",
          { action: "fetch", attempt },
          true,
          undefined,
          cause,
        )
      }

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), Number.POSITIVE_INFINITY)
        await runBoundedCleanup(() => response.body?.cancel())
        const retryable =
          [408, 425, 429].includes(response.status) || (response.status >= 500 && response.status <= 599)
        throw new ClassifiedAudioStreamError(
          `Audio stream request failed with HTTP ${response.status}`,
          { action: "response", status: response.status, attempt },
          retryable,
          retryAfterMs,
        )
      }

      const contentType = response.headers.get("content-type")
      let contentTypeAccepted = contentType == null || contentTypePolicy === "ignore"
      if (!contentTypeAccepted && contentTypePolicy === "validate") {
        contentTypeAccepted = isAllowedContentType(format, contentType!)
      } else if (typeof contentTypePolicy === "function") {
        try {
          const result = contentTypePolicy(
            Object.freeze({
              format,
              contentType,
              status: response.status,
              url: response.url || String(source),
            }),
          )
          if (typeof result !== "boolean") throw new TypeError("contentTypePolicy must return a boolean")
          contentTypeAccepted = result
        } catch (cause) {
          await runBoundedCleanup(() => response.body?.cancel())
          throw new ClassifiedAudioStreamError(
            cause instanceof Error ? cause.message : "Audio stream content type policy failed",
            { action: "response", status: response.status, attempt },
            false,
            undefined,
            cause,
          )
        }
      }
      if (!contentTypeAccepted) {
        await runBoundedCleanup(() => response.body?.cancel())
        throw new ClassifiedAudioStreamError(
          `Unsupported audio stream Content-Type: ${contentType}`,
          { action: "response", status: response.status, attempt },
          false,
        )
      }
      if (response.body == null) {
        throw new ClassifiedAudioStreamError(
          "Audio stream response has no body",
          { action: "response", status: response.status, attempt },
          true,
        )
      }
      return {
        body: response.body,
        info: { headers: response.headers, status: response.status },
      }
    },
  }
}

function resolveMetadataEncoding(value: string | undefined): string {
  try {
    return new TextDecoder(value ?? "iso-8859-1").encoding
  } catch {
    throw new TypeError(`Unsupported metadataEncoding: ${value}`)
  }
}

function resolveAudioStreamRequest(
  request: Omit<RequestInit, "body" | "signal"> | undefined,
): Omit<RequestInit, "body" | "signal"> | undefined {
  if (request === undefined) return undefined
  const { body: _body, signal: _signal, ...safeRequest } = request as RequestInit
  return safeRequest
}

function isReadableStreamSource(source: unknown): source is ReadableStream<Uint8Array> {
  try {
    return typeof (source as ReadableStream<Uint8Array> | null)?.getReader === "function"
  } catch {
    return false
  }
}

function isAsyncIterableSource(source: unknown): source is AsyncIterable<Uint8Array> {
  try {
    return typeof (source as AsyncIterable<Uint8Array> | null)?.[Symbol.asyncIterator] === "function"
  } catch {
    return false
  }
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]"
}

let createAudioStream: <I, M>(init: AudioStreamInit<I, M>) => AudioStream<M>
let openAudioStream: <M>(stream: AudioStream<M>) => Promise<void>

export class AudioStream<M = AudioStreamMetadata> extends EventEmitter<AudioStreamEvents<M>> {
  readonly closed: Promise<void>
  readonly format: AudioStreamFormat
  private readonly lib: RenderLib
  private readonly engine: AudioEngineHandle
  private readonly connector: AudioStreamConnector<unknown>
  private readonly demuxerFactory?: (info: unknown) => AudioStreamDemuxer<M> | null
  private readonly readAction: "fetch" | "source"
  private readonly options: ResolvedAudioStreamOptions
  private readonly removeFromOwner: () => void
  private readonly lifecycleController = new AbortController()
  private nativeStreamId: number | null = null
  private nativeStats: NativeAudioStreamStats | null = null
  private readyGeneration = 0
  private activeAttempt: AudioStreamAttempt<M> | null = null
  private pendingCleanup: Promise<void> | null = null
  private reconnectAttempts = 0
  private consecutiveReconnectAttempts = 0
  private disposed = false
  private exposed = false
  private terminalError: Error | null = null
  private metadata: M | null = null
  private pendingMetadataEvent = false
  private metadataEventScheduled = false
  private terminalEventScheduled = false
  private setupResolve!: () => void
  private setupReject!: (error: Error) => void
  private closedResolve!: () => void
  private readonly setupPromise: Promise<void>
  private readonly overallAbortListener = () => this.dispose()

  static {
    createAudioStream = <I, T>(init: AudioStreamInit<I, T>) => new AudioStream<T>(init as AudioStreamInit<unknown, T>)
    openAudioStream = <T>(stream: AudioStream<T>) => stream.open()
  }

  private constructor(init: AudioStreamInit<unknown, M>) {
    super()
    this.lib = init.lib
    this.engine = init.engine
    this.connector = init.connector
    this.demuxerFactory = init.demuxer
    this.readAction = init.readAction
    this.options = resolveAudioStreamOptions(init.options)
    this.format = this.options.format
    this.removeFromOwner = init.removeFromOwner
    this.setupPromise = new Promise((resolve, reject) => ((this.setupResolve = resolve), (this.setupReject = reject)))
    this.closed = new Promise((resolve) => (this.closedResolve = resolve))
    this.options.signal?.addEventListener("abort", this.overallAbortListener, { once: true })
  }

  get state(): AudioStreamState {
    // State is the latest snapshot; getStats() is the explicit FFI refresh.
    if (this.disposed) return "disposed"
    if (this.terminalError != null) return "errored"
    return this.nativeStats == null ? "initializing" : (StateNames[this.nativeStats.state] ?? "errored")
  }

  private async open(): Promise<void> {
    if (this.options.signal?.aborted) this.dispose()
    else void this.runLifecycle()
    await this.setupPromise
    if (this.lifecycleController.signal.aborted && this.state !== "ended")
      throw this.terminalError ?? createAbortError()
    this.exposed = true
    if (this.pendingMetadataEvent && this.metadata != null) this.emitMetadata()
    this.pendingMetadataEvent = false
    if (this.state === "ended") this.emitTerminal("ended")
  }

  getStats(): AudioStreamStats {
    const stats = this.readNativeStats()
    if (!this.lifecycleController.signal.aborted && this.nativeStreamId != null) {
      const error = this.snapshotError(stats)
      const ended = stats?.state === StreamState.Ended && !this.options.reconnect?.retryOnEnd
      if (error != null || ended) {
        queueMicrotask(() => {
          if (this.lifecycleController.signal.aborted) return
          const reason =
            error == null || error.context.action === "decoder"
              ? CloseReason.PreserveNativeTerminal
              : CloseReason.TransportError
          void this.finish(reason, error ?? undefined)
        })
      }
    }
    return this.toPublicStats()
  }

  getMetadata(): M | null {
    return this.metadata
  }

  setVolume(volume: number): boolean {
    return this.control("setVolume", (streamId) => this.lib.audioSetStreamVolume(this.engine, streamId, volume))
  }

  setPan(pan: number): boolean {
    return this.control("setPan", (streamId) => this.lib.audioSetStreamPan(this.engine, streamId, pan))
  }

  setGroup(groupId: number): boolean {
    if (!isU32(groupId)) {
      const context: AudioStreamErrorContext = { action: "setGroup" }
      if (this.exposed) {
        this.emitAsync("error", new AudioStreamError("Invalid audio stream group", context), context)
      }
      return false
    }
    return this.control("setGroup", (streamId) => this.lib.audioSetStreamGroup(this.engine, streamId, groupId))
  }

  private control(action: "setVolume" | "setPan" | "setGroup", call: (streamId: number) => number): boolean {
    const streamId = this.nativeStreamId
    if (this.disposed || this.lifecycleController.signal.aborted || streamId == null) return false
    const status = call(streamId)
    if (status !== 0) {
      const context: AudioStreamErrorContext = { action, status }
      if (this.exposed) {
        this.emitAsync("error", new AudioStreamError(`Audio stream ${action} failed: ${status}`, context), context)
      }
      return false
    }
    return true
  }

  dispose(): void {
    const wasExposed = this.exposed
    if (!this.disposed) {
      this.disposed = true
      this.lifecycleController.abort()
      this.setupReject(createAbortError())
    }
    const cleanup = this.stopSource()
    const closeStatus = this.closeNativeStream(CloseReason.Disposed)
    if (closeStatus !== 0) {
      throw new AudioStreamError(`Audio stream destroy failed: ${closeStatus}`, {
        action: "destroy",
        status: closeStatus,
      })
    }
    this.removeOwner()
    void cleanup.finally(() => {
      if (wasExposed && !this.terminalEventScheduled) this.emitTerminal("disposed")
      else if (!this.terminalEventScheduled) this.closedResolve()
    })
  }

  private async runLifecycle(): Promise<void> {
    while (!this.lifecycleController.signal.aborted) {
      const attempt: AudioStreamAttempt<M> = {
        controller: new AbortController(),
        writeBatches: 0,
        body: null,
        closeConnection: null,
        reader: null,
        iterator: null,
        demuxer: null,
        demuxerFinished: false,
        sourceReleased: false,
        sourceAcquisitionAttempted: false,
        connectionClosed: false,
        demuxerAborted: false,
        resourceAcquisition: null,
        cleanupPromise: null,
      }
      this.activeAttempt = attempt

      let connection: ResolvedAudioStreamConnection<unknown>
      try {
        let returnedConnection: AudioStreamConnection<unknown>
        const finishConnectionAcquisition = this.beginResourceAcquisition(attempt)
        try {
          returnedConnection = await this.connector.connect({
            signal: attempt.controller.signal,
            attempt: this.consecutiveReconnectAttempts,
          })
        } finally {
          finishConnectionAcquisition()
        }
        connection = this.resolveConnection(returnedConnection, attempt)
      } catch (failure) {
        const active = this.isAttemptActive(attempt)
        await this.stopSource(attempt)
        if (!active) return
        const context: AudioStreamErrorContext = {
          action: this.readAction,
          attempt: this.consecutiveReconnectAttempts,
        }
        const error =
          failure instanceof AudioStreamError
            ? failure
            : new AudioStreamError(
                failure instanceof Error ? failure.message : "Audio stream connection failed",
                context,
                failure,
              )
        if (await this.retry(error, attempt, "connect")) continue
        return
      }

      if (!this.isAttemptActive(attempt)) {
        await this.stopSource(attempt)
        return
      }
      if (!isReadableStreamSource(connection.body) && !isAsyncIterableSource(connection.body)) {
        await this.stopSource(attempt)
        const context: AudioStreamErrorContext = { action: "source" }
        await this.finish(
          CloseReason.TransportError,
          new AudioStreamError("Audio stream connection body must be a ReadableStream or AsyncIterable", context),
        )
        return
      }
      if (!this.isAttemptActive(attempt)) {
        await this.stopSource(attempt)
        return
      }

      let initialMetadata: M | null = null
      let demuxerFailed = false
      let demuxerFailure: unknown
      const finishDemuxerAcquisition = this.beginResourceAcquisition(attempt)
      try {
        attempt.demuxer = this.demuxerFactory?.(connection.info) ?? null
        initialMetadata = attempt.demuxer?.initialMetadata ?? null
      } catch (cause) {
        demuxerFailed = true
        demuxerFailure = cause
      } finally {
        finishDemuxerAcquisition()
      }
      if (demuxerFailed) {
        await this.stopSource(attempt)
        const error =
          demuxerFailure instanceof AudioStreamError
            ? demuxerFailure
            : new AudioStreamError(
                demuxerFailure instanceof Error ? demuxerFailure.message : "Audio stream demuxer creation failed",
                { action: "demuxer" },
                demuxerFailure,
              )
        await this.finish(CloseReason.TransportError, error)
        return
      }
      if (!this.isAttemptActive(attempt)) {
        await this.stopSource(attempt)
        return
      }

      this.publishMetadata(initialMetadata, attempt)
      try {
        this.createNativeStream()
      } catch (cause) {
        await this.stopSource(attempt)
        const error =
          cause instanceof AudioStreamError
            ? cause
            : new AudioStreamError("Audio stream create failed", { action: "create" }, cause)
        await this.finish(CloseReason.TransportError, error)
        return
      }
      try {
        if (!(await this.consumeSource(connection, attempt))) return
      } catch (cause) {
        if (this.lifecycleController.signal.aborted) return
        const error =
          cause instanceof AudioStreamError
            ? cause
            : cause instanceof TypeError && cause.message === INVALID_STREAM_CHUNK_MESSAGE
              ? cause
              : new AudioStreamError("Audio stream source failed", { action: "source" }, cause)
        if (error instanceof ClassifiedAudioStreamError) {
          if (await this.retry(error, attempt, "read")) continue
          return
        }
        const context = error instanceof AudioStreamError ? error.context : { action: "source" as const }
        await this.finish(CloseReason.TransportError, error, context)
        return
      }

      if (!this.options.reconnect?.retryOnEnd) {
        await this.finish(CloseReason.PreserveNativeTerminal)
        return
      }
      const error = new AudioStreamError("Audio stream source ended", { action: "source" })
      if (await this.retry(error, attempt, undefined, true)) continue
      return
    }
  }

  private createNativeStream(): void {
    if (this.nativeStreamId != null) return
    const created = this.lib.audioCreateStream(this.engine, this.options.native)
    if (created.status !== 0 || created.streamId == null) {
      const context: AudioStreamErrorContext = { action: "create", status: created.status }
      throw new AudioStreamError(`Audio stream create failed: ${created.status}`, context)
    }
    this.nativeStreamId = created.streamId
  }

  private async consumeSource(
    connection: ResolvedAudioStreamConnection<unknown>,
    attempt: AudioStreamAttempt<M>,
  ): Promise<boolean> {
    const previousGeneration = this.readyGeneration
    if ((await this.pollNativeSnapshot(attempt)) == null || !this.isAttemptActive(attempt)) return false
    const decoderReady = this.awaitReady(attempt, previousGeneration)
    try {
      await this.pumpSource(connection, attempt)
    } catch (cause) {
      this.observeReady(this.readNativeStats(), previousGeneration)
      await this.stopSource(attempt)
      await decoderReady
      if (!this.lifecycleController.signal.aborted) throw cause
      return false
    }
    if (this.lifecycleController.signal.aborted) return false
    const status = this.lib.audioEndStream(this.engine, this.nativeStreamId!)
    if (status !== 0) {
      const nativeError = this.snapshotError(this.readNativeStats())
      if (nativeError?.context.action === "decoder") throw nativeError
      const context: AudioStreamErrorContext = { action: "end", status }
      throw new AudioStreamError(`Audio stream end failed: ${status}`, context)
    }
    if (!(await decoderReady) || this.lifecycleController.signal.aborted) return false
    if (!(await this.awaitEnded(attempt))) return false
    await this.stopSource(attempt)
    return !this.lifecycleController.signal.aborted
  }

  private async pumpSource(
    connection: ResolvedAudioStreamConnection<unknown>,
    attempt: AudioStreamAttempt<M>,
  ): Promise<void> {
    const source = connection.body
    if (!this.isAttemptActive(attempt)) {
      await this.runBoundedAttemptCleanup(attempt)
      return
    }
    const release = (): void => {
      if (attempt.sourceReleased) return
      if (attempt.reader == null) {
        attempt.sourceReleased = true
        return
      }
      try {
        attempt.reader.releaseLock()
        attempt.sourceReleased = true
      } catch {}
    }
    const next = (): Promise<{ done?: boolean; value?: unknown }> =>
      attempt.reader == null ? attempt.iterator!.next() : attempt.reader.read()

    attempt.sourceAcquisitionAttempted = true
    const finishSourceAcquisition = this.beginResourceAcquisition(attempt)
    try {
      attempt.reader = isReadableStreamSource(source) ? source.getReader() : null
      attempt.iterator = attempt.reader == null ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]() : null
    } catch (cause) {
      const context: AudioStreamErrorContext = { action: this.readAction }
      throw new ClassifiedAudioStreamError("Audio stream source failed", context, true, undefined, cause)
    } finally {
      finishSourceAcquisition()
    }

    if (!this.isAttemptActive(attempt)) {
      await this.runBoundedAttemptCleanup(attempt)
      return
    }

    while (this.isAttemptActive(attempt)) {
      let result: { done?: boolean; value?: unknown }
      try {
        result = await next()
      } catch (cause) {
        const context: AudioStreamErrorContext = { action: this.readAction }
        throw new ClassifiedAudioStreamError("Audio stream source failed", context, true, undefined, cause)
      }
      if (!this.isAttemptActive(attempt)) return
      if (result.done) {
        release()
        if (attempt.demuxer != null) {
          try {
            await this.processDemuxOutput(attempt.demuxer.flush(), attempt)
          } catch (cause) {
            if (cause instanceof AudioStreamError) throw cause
            const context: AudioStreamErrorContext = { action: this.readAction }
            throw new ClassifiedAudioStreamError(
              cause instanceof Error ? cause.message : "Audio stream demuxer flush failed",
              context,
              true,
              undefined,
              cause,
            )
          }
        }
        attempt.demuxerFinished = true
        await this.runBoundedAttemptCleanup(attempt)
        return
      }
      const chunk = result.value
      if (!isUint8Array(chunk)) throw new TypeError(INVALID_STREAM_CHUNK_MESSAGE)
      if (chunk.byteLength === 0) {
        await waitForDelay(0, attempt.controller.signal)
        continue
      }

      if (attempt.demuxer == null) {
        await this.writeStreamChunk(chunk, attempt)
        continue
      }
      try {
        await this.processDemuxOutput(attempt.demuxer.push(chunk), attempt)
      } catch (cause) {
        if (cause instanceof AudioStreamError) throw cause
        throw new AudioStreamError(
          cause instanceof Error ? cause.message : "Audio stream demuxer failed",
          { action: "demuxer" },
          cause,
        )
      }
    }
  }

  private async processDemuxOutput(
    outputs: Iterable<AudioStreamDemuxOutput<M>>,
    attempt: AudioStreamAttempt<M>,
  ): Promise<void> {
    for (const output of outputs) {
      if (!this.isAttemptActive(attempt)) return
      if (output.type === "audio") {
        if (!isUint8Array(output.data)) {
          throw new AudioStreamError("Audio stream demuxer audio output must be a Uint8Array", {
            action: "demuxer",
          })
        }
        await this.writeStreamChunk(output.data, attempt)
      } else if (output.type === "metadata") {
        this.publishMetadata(output.metadata, attempt)
      } else {
        throw new AudioStreamError("Audio stream demuxer returned an invalid output", { action: "demuxer" })
      }
    }
  }

  private async writeStreamChunk(chunk: Uint8Array, attempt: AudioStreamAttempt<M>): Promise<void> {
    if (Object.prototype.toString.call(chunk.buffer) === "[object SharedArrayBuffer]") {
      throw new AudioStreamError("Audio stream chunks must have non-shared backing memory", { action: "write" })
    }
    let offset = 0
    while (offset < chunk.byteLength && this.isAttemptActive(attempt)) {
      const streamId = this.nativeStreamId
      if (streamId == null) return
      let accepted: number
      try {
        accepted = this.lib.audioWriteStream(this.engine, streamId, chunk.subarray(offset))
      } catch (cause) {
        const context: AudioStreamErrorContext = { action: "write" }
        throw new AudioStreamError("Audio stream write failed", context, cause)
      }
      if (accepted < 0) {
        const context: AudioStreamErrorContext = { action: "write", status: accepted }
        throw new AudioStreamError(`Audio stream write failed: ${accepted}`, context)
      }
      offset += accepted
      if (accepted === 0 || ++attempt.writeBatches >= 32) {
        // Yield across chunk boundaries as well as on backpressure so fast sources remain cancellable.
        attempt.writeBatches = 0
        if ((await this.pollNativeSnapshot(attempt)) == null) return
        await waitForDelay(accepted === 0 ? STREAM_POLL_INTERVAL_MS : 0, attempt.controller.signal)
      }
    }
  }

  private resolveConnection(
    connection: AudioStreamConnection<unknown>,
    attempt: AudioStreamAttempt<M>,
  ): ResolvedAudioStreamConnection<unknown> {
    const finishAcquisition = this.beginResourceAcquisition(attempt)
    try {
      const close = connection.close
      if (close !== undefined && typeof close !== "function") {
        throw new TypeError("Audio stream connection close must be a function")
      }
      attempt.closeConnection = close == null ? null : () => close.call(connection)
      const info = connection.info
      const body = connection.body
      attempt.body = body
      return { body, info }
    } finally {
      finishAcquisition()
    }
  }

  private beginResourceAcquisition(attempt: AudioStreamAttempt<M>): () => void {
    let resolve!: () => void
    const acquisition = new Promise<void>((done) => {
      resolve = done
    })
    attempt.resourceAcquisition = acquisition
    return () => {
      if (attempt.resourceAcquisition === acquisition) attempt.resourceAcquisition = null
      resolve()
    }
  }

  private cleanupAttempt(attempt: AudioStreamAttempt<M>): Promise<void> {
    if (attempt.cleanupPromise != null) return attempt.cleanupPromise
    let resolveCleanup!: () => void
    let rejectCleanup!: (error: unknown) => void
    const cleanup = new Promise<void>((resolve, reject) => {
      resolveCleanup = resolve
      rejectCleanup = reject
    })
    attempt.cleanupPromise = cleanup
    void this.performAttemptCleanup(attempt).then(resolveCleanup, rejectCleanup)
    const clearCleanup = (): void => {
      if (attempt.cleanupPromise === cleanup) attempt.cleanupPromise = null
    }
    void cleanup.then(clearCleanup, clearCleanup)
    return cleanup
  }

  private async performAttemptCleanup(attempt: AudioStreamAttempt<M>): Promise<void> {
    if (attempt.resourceAcquisition != null) await attempt.resourceAcquisition
    const pending: Promise<unknown>[] = []
    const reason = createAbortError()

    if (!attempt.demuxerFinished && !attempt.demuxerAborted && attempt.demuxer != null) {
      attempt.demuxerAborted = true
      try {
        attempt.demuxer.abort?.(reason)
      } catch {}
    }

    if (!attempt.sourceReleased) {
      if (attempt.reader != null) {
        attempt.sourceReleased = true
        try {
          const result = attempt.reader.cancel(reason)
          try {
            attempt.reader.releaseLock()
          } catch {}
          pending.push(result)
        } catch {}
      } else if (attempt.iterator != null) {
        attempt.sourceReleased = true
        try {
          pending.push(Promise.resolve(attempt.iterator.return?.()))
        } catch {}
      } else if (attempt.body != null && !attempt.sourceAcquisitionAttempted) {
        attempt.sourceReleased = true
        try {
          if (isReadableStreamSource(attempt.body)) {
            pending.push(attempt.body.cancel(reason))
          } else if (isAsyncIterableSource(attempt.body)) {
            attempt.iterator = attempt.body[Symbol.asyncIterator]()
            pending.push(Promise.resolve(attempt.iterator.return?.()))
          }
        } catch {}
      }
    }

    if (!attempt.connectionClosed && attempt.closeConnection != null) {
      attempt.connectionClosed = true
      try {
        pending.push(Promise.resolve(attempt.closeConnection()))
      } catch {}
    }
    await Promise.allSettled(pending)
  }

  private runBoundedAttemptCleanup(attempt: AudioStreamAttempt<M>): Promise<void> {
    if (this.pendingCleanup != null) return this.pendingCleanup
    let resolveCleanup!: () => void
    let rejectCleanup!: (error: unknown) => void
    const pendingCleanup = new Promise<void>((resolve, reject) => {
      resolveCleanup = resolve
      rejectCleanup = reject
    })
    this.pendingCleanup = pendingCleanup
    const cleanup = runBoundedCleanup(() => this.cleanupAttempt(attempt))
    void cleanup.then(resolveCleanup, rejectCleanup)
    const clearCleanup = (): void => {
      if (this.pendingCleanup === pendingCleanup) this.pendingCleanup = null
    }
    void pendingCleanup.then(clearCleanup, clearCleanup)
    return pendingCleanup
  }

  private async retry(
    error: AudioStreamError,
    attempt: AudioStreamAttempt<M>,
    phase?: AudioStreamRetryPhase,
    cleanEnd: boolean = false,
  ): Promise<boolean> {
    if (this.lifecycleController.signal.aborted) return false
    const reconnect = this.options.reconnect
    const retryable = phase == null || !(error instanceof ClassifiedAudioStreamError) || error.retryable
    if (reconnect == null || this.consecutiveReconnectAttempts >= reconnect.maxRetries) {
      if (cleanEnd) await this.finish(CloseReason.PreserveNativeTerminal)
      else await this.finish(CloseReason.TransportError, error)
      return false
    }

    let retryDelayMs = error instanceof ClassifiedAudioStreamError ? error.retryAfterMs : undefined
    if (phase != null && reconnect.retry != null) {
      let decision: AudioStreamRetryDecision
      try {
        decision = reconnect.retry(error, {
          attempt: this.consecutiveReconnectAttempts + 1,
          maxRetries: reconnect.maxRetries,
          phase,
        })
        if (decision !== false && (decision == null || typeof decision !== "object")) {
          throw new TypeError("Audio stream retry policy must return false or a retry decision")
        }
      } catch (cause) {
        await this.finish(
          CloseReason.TransportError,
          new AudioStreamError("Audio stream retry policy failed", { action: "source" }, cause),
        )
        return false
      }
      if (decision === false) {
        await this.finish(CloseReason.TransportError, error)
        return false
      }
      if (this.lifecycleController.signal.aborted) return false
      let policyDelayMs: number | undefined
      try {
        policyDelayMs = decision.delayMs
      } catch (cause) {
        await this.finish(
          CloseReason.TransportError,
          new AudioStreamError("Audio stream retry policy failed", { action: "source" }, cause),
        )
        return false
      }
      if (
        policyDelayMs !== undefined &&
        (!Number.isFinite(policyDelayMs) || !Number.isInteger(policyDelayMs) || policyDelayMs < 0)
      ) {
        await this.finish(
          CloseReason.TransportError,
          new AudioStreamError("Audio stream retry delay must be a finite non-negative integer", {
            action: "source",
          }),
        )
        return false
      }
      if (policyDelayMs !== undefined) retryDelayMs = Math.min(reconnect.maxDelayMs, policyDelayMs)
    } else if (!retryable) {
      await this.finish(CloseReason.TransportError, error)
      return false
    }

    if (retryDelayMs !== undefined) retryDelayMs = Math.min(reconnect.maxDelayMs, retryDelayMs)

    await this.cleanupAttempt(attempt)
    if (this.lifecycleController.signal.aborted) return false

    if (this.nativeStreamId != null) {
      const stats = this.readNativeStats()
      const nativeError = this.snapshotError(stats)
      if (nativeError != null) {
        const reason =
          nativeError.context.action === "decoder" ? CloseReason.PreserveNativeTerminal : CloseReason.TransportError
        await this.finish(reason, nativeError)
        return false
      }
      // Save the old decoder generation before restart can publish its replacement's readiness.
      if (stats != null) this.readyGeneration = stats.readyGeneration
      const restartStatus = this.lib.audioRestartStream(this.engine, this.nativeStreamId)
      if (restartStatus !== 0) {
        const restartContext: AudioStreamErrorContext = { action: "restart", status: restartStatus }
        await this.finish(
          CloseReason.TransportError,
          new AudioStreamError("Audio stream restart failed during reconnect", restartContext),
        )
        return false
      }
      this.readNativeStats()
    }
    this.reconnectAttempts += 1
    this.consecutiveReconnectAttempts += 1
    const delayMs =
      retryDelayMs ??
      Math.min(
        reconnect.maxDelayMs,
        reconnect.initialDelayMs * reconnect.backoffFactor ** (this.consecutiveReconnectAttempts - 1),
      )
    // Initial retries happen before callers receive the AudioStream and can attach listeners. Do not replay completed
    // setup retries after success; callers can bound or cancel pending setup with reconnect.maxRetries or signal.
    if (this.exposed) {
      this.emitAsync("reconnecting", {
        attempt: this.consecutiveReconnectAttempts,
        delayMs,
        maxRetries: reconnect.maxRetries,
        error,
      })
    }
    return waitForDelay(delayMs, this.lifecycleController.signal)
      .then(() => true)
      .catch(() => false)
  }

  private async awaitReady(attempt: AudioStreamAttempt<M>, previousGeneration: number): Promise<boolean> {
    while (this.isAttemptActive(attempt)) {
      const stats = await this.pollNativeSnapshot(attempt)
      if (stats == null) return false
      if (this.observeReady(stats, previousGeneration)) return true
      if (!(await waitForPoll(attempt.controller.signal))) return false
    }
    return false
  }

  private observeReady(stats: NativeAudioStreamStats | null, previousGeneration: number): boolean {
    if (stats == null || stats.readyGeneration === previousGeneration) return false
    this.readyGeneration = stats.readyGeneration
    this.consecutiveReconnectAttempts = 0
    this.setupResolve()
    return true
  }

  private async awaitEnded(attempt: AudioStreamAttempt<M>): Promise<boolean> {
    while (this.isAttemptActive(attempt)) {
      const stats = await this.pollNativeSnapshot(attempt)
      if (stats == null) return false
      if (stats.state === StreamState.Ended) return true
      if (!(await waitForPoll(attempt.controller.signal))) return false
    }
    return false
  }

  private async pollNativeSnapshot(attempt: AudioStreamAttempt<M>): Promise<NativeAudioStreamStats | null> {
    if (!this.isAttemptActive(attempt)) return null
    const stats = this.readNativeStats()
    const error = this.snapshotError(stats)
    if (error != null) {
      const reason =
        error.context.action === "decoder" ? CloseReason.PreserveNativeTerminal : CloseReason.TransportError
      await this.finish(reason, error)
      return null
    }
    return stats!
  }

  private snapshotError(stats: NativeAudioStreamStats | null): AudioStreamError | null {
    if (stats == null) return new AudioStreamError("Audio stream stats failed", { action: "stats" })
    if (StateNames[stats.state] == null) {
      return new AudioStreamError(`Unknown native audio stream state: ${stats.state}`, { action: "stats" })
    }
    if (stats.state !== StreamState.Failed && stats.state !== StreamState.Cancelled) return null
    const context: AudioStreamErrorContext = { action: "decoder", errorCode: stats.errorCode }
    return new AudioStreamError(
      stats.state === StreamState.Failed
        ? `Audio stream decoder failed: ${stats.errorCode}`
        : "Audio stream was cancelled by the decoder",
      context,
    )
  }

  private async finish(
    reason: NativeAudioStreamCloseReason,
    error?: Error,
    context?: AudioStreamErrorContext,
  ): Promise<void> {
    if (this.lifecycleController.signal.aborted) return
    if (error instanceof AudioStreamError) context = error.context
    this.lifecycleController.abort()
    this.terminalError = error ?? null
    const cleanup = this.stopSource()
    const closeStatus = this.closeNativeStream(reason)
    if (error == null && closeStatus !== 0) {
      context = { action: "destroy", status: closeStatus }
      error = new AudioStreamError("Audio stream destroy failed after end", context)
      this.terminalError = error
    }
    await cleanup
    if (error != null) this.setupReject(error)
    else this.setupResolve()
    if (closeStatus === 0) this.removeOwner()
    if (!this.disposed && this.exposed) {
      if (error != null) this.emitTerminal("error", error, context!)
      else this.emitTerminal("ended")
    } else if (error != null && !this.disposed) this.closedResolve()
  }

  private publishMetadata(metadata: M | null, attempt: AudioStreamAttempt<M>): void {
    if (!this.isAttemptActive(attempt) || Object.is(this.metadata, metadata)) return
    this.metadata = metadata
    if (!this.exposed) {
      this.pendingMetadataEvent = true
      return
    }
    this.emitMetadata()
  }

  private emitMetadata(): void {
    if (this.metadataEventScheduled) return
    this.metadataEventScheduled = true
    setTimeout(() => {
      this.metadataEventScheduled = false
      if (!this.disposed) EventEmitter.prototype.emit.call(this, "metadata", this.metadata)
    }, 0)
  }

  private emitAsync<K extends keyof AudioStreamEvents<M>>(event: K, ...args: AudioStreamEvents<M>[K]): void {
    setTimeout(() => EventEmitter.prototype.emit.call(this, event, ...args), 0)
  }

  private emitTerminal<K extends "ended" | "error" | "disposed">(event: K, ...args: AudioStreamEvents<M>[K]): void {
    if (this.terminalEventScheduled) return
    this.terminalEventScheduled = true
    setTimeout(() => {
      try {
        EventEmitter.prototype.emit.call(this, event, ...args)
      } finally {
        this.closedResolve()
      }
    }, 0)
  }

  private isAttemptActive(attempt: AudioStreamAttempt<M>): boolean {
    return !this.lifecycleController.signal.aborted && this.activeAttempt === attempt
  }

  private stopSource(attempt: AudioStreamAttempt<M> | null = this.activeAttempt): Promise<void> {
    if (attempt == null) return this.pendingCleanup ?? Promise.resolve()
    if (this.activeAttempt === attempt) this.activeAttempt = null
    attempt.controller.abort()
    return this.runBoundedAttemptCleanup(attempt)
  }

  private closeNativeStream(reason: NativeAudioStreamCloseReason): number {
    const streamId = this.nativeStreamId
    if (streamId == null) return 0
    const result = this.lib.audioCloseStream(this.engine, streamId, reason)
    if (result.status !== 0 || result.stats == null) return result.status === 0 ? -1 : result.status
    this.nativeStats = result.stats
    this.nativeStreamId = null
    return 0
  }

  private readNativeStats(): NativeAudioStreamStats | null {
    if (this.nativeStreamId == null) return this.nativeStats
    const stats = this.lib.audioGetStreamStats(this.engine, this.nativeStreamId)
    if (stats != null) this.nativeStats = stats
    return stats
  }

  private toPublicStats(): AudioStreamStats {
    const stats = this.nativeStats
    const sampleRate = stats?.sampleRate ?? 0
    const bufferedFrames = stats?.bufferedFrames ?? 0
    return {
      state: this.state,
      sampleRate,
      channels: stats?.channels ?? 0,
      bufferedFrames,
      capacityFrames: stats?.capacityFrames ?? 0,
      bufferedDurationMs: sampleRate === 0 ? 0 : (bufferedFrames * 1000) / sampleRate,
      bytesReceived: stats?.bytesReceived ?? 0n,
      framesDecoded: stats?.framesDecoded ?? 0n,
      framesPlayed: stats?.framesPlayed ?? 0n,
      underruns: stats?.underruns ?? 0,
      reconnectAttempts: this.reconnectAttempts,
    }
  }

  private removeOwner(): void {
    this.options.signal?.removeEventListener("abort", this.overallAbortListener)
    this.removeFromOwner()
  }
}

interface AudioCaptureStreamInit {
  options: ResolvedAudioCaptureStreamOptions
  start(): AudioCaptureOperationResult
  read(frameCount: number): AudioCaptureReadOperationResult
  stats(): AudioCaptureStatsOperationResult
  stop(): AudioCaptureOperationResult
  isRunning(): boolean
  removeFromOwner(): void
}

let createAudioCaptureStream: (init: AudioCaptureStreamInit) => AudioCaptureStream
let openAudioCaptureStream: (stream: AudioCaptureStream) => Promise<void>
let refreshAudioCaptureStreamFinalStats: (stream: AudioCaptureStream) => void

export class AudioCaptureStream extends EventEmitter<AudioCaptureStreamEvents> {
  readonly readable: ReadableStream<Float32Array>
  readonly sampleRate: number
  readonly channels: number
  readonly chunkFrames: number
  readonly closed: Promise<void>
  private readonly init: AudioCaptureStreamInit
  private readonly lifecycleController = new AbortController()
  private streamController: ReadableStreamDefaultController<Float32Array> | null = null
  private nativeStats: AudioCaptureStats
  private currentState: AudioCaptureStreamState = "initializing"
  private pendingFrames = 0
  private readonly pendingSamples: Float32Array
  private producerStopAttempted = false
  private producerStopped = false
  private producerMayBeRunning = false
  private ownerRemoved = false
  private exposed = false
  private terminal = false
  private discardRequested = false
  private discardDecisionScheduled = false
  private pumpPromise: Promise<void> | null = null
  private producerCleanupPromise: Promise<AudioCaptureOperationResult> | null = null
  private lastCleanupFailure: AudioCaptureOperationResult | null = null
  private terminalCompletionPromise: Promise<void> | null = null
  private closedResolve!: () => void
  private readonly signalAbortListener = () => this.dispose()

  static {
    createAudioCaptureStream = (init) => new AudioCaptureStream(init)
    openAudioCaptureStream = (stream) => stream.open()
    refreshAudioCaptureStreamFinalStats = (stream) => stream.refreshFinalStats()
  }

  private constructor(init: AudioCaptureStreamInit) {
    super()
    this.init = init
    this.sampleRate = init.options.sampleRate
    this.channels = init.options.channels
    this.chunkFrames = init.options.chunkFrames
    this.pendingSamples = new Float32Array(this.chunkFrames * this.channels)
    this.nativeStats = {
      sampleRate: this.sampleRate,
      channels: this.channels,
      capacityFrames: init.options.capacityFrames,
      bufferedFrames: 0,
      framesReceived: 0n,
      framesRead: 0n,
      framesDropped: 0n,
    }
    this.closed = new Promise((resolve) => (this.closedResolve = resolve))
    this.readable = new ReadableStream<Float32Array>(
      {
        start: (controller) => {
          this.streamController = controller
        },
        pull: () => this.pull(),
        cancel: () => this.disposeInternal(true),
      },
      { highWaterMark: 0 },
    )
    this.init.options.signal?.addEventListener("abort", this.signalAbortListener, { once: true })
  }

  get state(): AudioCaptureStreamState {
    return this.currentState
  }

  private async open(): Promise<void> {
    if (this.init.options.signal?.aborted) {
      await this.disposeInternal(false)
      throw createAbortError()
    }
    let result: AudioCaptureOperationResult
    this.producerMayBeRunning = true
    try {
      result = this.init.start()
    } catch (cause) {
      this.currentState = "errored"
      await this.cleanupProducer()
      this.closedResolve()
      throw new AudioCaptureStreamError("Audio capture stream start failed", { action: "start" }, cause)
    }
    if (result.status !== 0) {
      this.producerMayBeRunning = false
      this.currentState = "errored"
      this.removeOwner()
      this.closedResolve()
      throw this.operationError("start", result)
    }
    if (this.terminal || this.init.options.signal?.aborted) {
      await (this.terminalCompletionPromise ?? this.disposeInternal(false))
      throw createAbortError()
    }
    let stats: AudioCaptureStatsOperationResult
    try {
      stats = this.init.stats()
    } catch (cause) {
      stats = { status: -1, stats: null, cause }
    }
    if (stats.status !== 0 || stats.stats == null) {
      this.currentState = "errored"
      await this.cleanupProducer()
      this.closedResolve()
      throw this.operationError("stats", stats)
    }
    this.nativeStats = stats.stats
    if (this.terminal || this.init.options.signal?.aborted) {
      await (this.terminalCompletionPromise ?? this.disposeInternal(false))
      throw createAbortError()
    }
    this.currentState = "capturing"
    this.exposed = true
  }

  getStats(): AudioCaptureStreamStats {
    if (!this.terminal) {
      const stats = this.refreshStats()
      if (stats != null && !this.observeProducer()) this.scheduleDiscardIfIdle()
    }
    return this.publicStats()
  }

  stop(): void {
    if (this.terminal || this.currentState === "stopping") return
    this.currentState = "stopping"
    const result = this.stopProducer()
    if (result != null && result.status !== 0) this.fail(this.operationError("stop", result))
    else this.scheduleDiscardIfIdle()
  }

  dispose(): void {
    this.disposeInternal(false)
  }

  private disposeInternal(fromCancel: boolean): Promise<void> {
    if (this.terminal) {
      if (this.ownerRemoved) return this.terminalCompletionPromise ?? Promise.resolve()
      return this.retryTerminalCleanup()
    }
    this.terminal = true
    this.currentState = "disposed"
    this.refreshFinalStats()
    this.lifecycleController.abort()
    const immediateCleanup =
      !this.producerMayBeRunning || this.producerStopped
        ? { status: 0 }
        : this.producerStopAttempted
          ? null
          : this.stopProducer()
    if (immediateCleanup?.status === 0) this.refreshFinalStats()
    this.terminalCompletionPromise = (async () => {
      const cleanup = immediateCleanup?.status === 0 ? immediateCleanup : await this.cleanupProducer()
      this.refreshFinalStats()
      if (cleanup.status === 0) {
        this.removeOwner()
        if (!fromCancel) {
          try {
            this.streamController?.close()
          } catch {}
        }
        if (this.exposed) this.emitTerminal("disposed")
        else this.closedResolve()
        return
      }
      this.currentState = "errored"
      const error = this.operationError("destroy", cleanup)
      try {
        this.streamController?.error(error)
      } catch {}
      if (this.exposed) this.emitTerminal("error", error, error.context)
      else this.closedResolve()
    })()
    return this.terminalCompletionPromise
  }

  private pull(): Promise<void> {
    return this.pump()
  }

  private pump(): Promise<void> {
    if (this.pumpPromise != null) return this.pumpPromise
    const pump = Promise.resolve().then(async () => {
      do {
        await this.pumpSource()
      } while (this.discardRequested && !this.terminal)
    })
    this.pumpPromise = pump
    const clear = (): void => {
      if (this.pumpPromise === pump) this.pumpPromise = null
    }
    void pump.then(clear, clear)
    return pump
  }

  private async pumpSource(): Promise<void> {
    if (this.discardRequested) {
      await this.discardNativeRing()
      return
    }
    const controller = this.streamController!
    while (!this.terminal) {
      if (this.discardRequested) {
        await this.discardNativeRing()
        return
      }
      const stats = this.refreshStats()
      if (stats == null || this.terminal) return
      const running = this.observeProducer()
      if (this.terminal) return
      const neededFrames = this.chunkFrames - this.pendingFrames
      const readableFrames = running
        ? stats.bufferedFrames >= neededFrames
          ? neededFrames
          : 0
        : Math.min(neededFrames, stats.bufferedFrames)

      let framesRead = 0
      if (readableFrames > 0) {
        let result: AudioCaptureReadOperationResult
        try {
          result = this.init.read(readableFrames)
        } catch (cause) {
          this.fail(new AudioCaptureStreamError("Audio capture stream read failed", { action: "read" }, cause))
          return
        }
        if (result.status !== 0) {
          this.fail(this.operationError("read", result))
          return
        }
        framesRead = Math.min(readableFrames, result.framesRead)
        if (framesRead > 0) {
          const sampleCount = framesRead * this.channels
          this.pendingSamples.set(result.frames.subarray(0, sampleCount), this.pendingFrames * this.channels)
          this.pendingFrames += framesRead
          if (this.pendingFrames === this.chunkFrames) {
            controller.enqueue(this.pendingSamples.slice())
            this.pendingFrames = 0
            if (!running && stats.bufferedFrames <= framesRead) this.finishStopped()
            return
          }
        }
      }

      if (!running && stats.bufferedFrames <= framesRead) {
        if (this.pendingFrames > 0) {
          controller.enqueue(this.pendingSamples.slice(0, this.pendingFrames * this.channels))
          this.pendingFrames = 0
        }
        this.finishStopped()
        return
      }
      if (!(await waitForPoll(this.lifecycleController.signal))) return
    }
  }

  private async discardNativeRing(): Promise<void> {
    this.pendingFrames = 0
    let chunksThisTurn = 0
    while (!this.terminal) {
      const stats = this.refreshStats()
      if (stats == null || this.terminal) return
      if (stats.bufferedFrames === 0) {
        this.finishStopped()
        return
      }
      const frameCount = Math.min(this.chunkFrames, stats.bufferedFrames)
      let result: AudioCaptureReadOperationResult
      try {
        result = this.init.read(frameCount)
      } catch (cause) {
        this.fail(new AudioCaptureStreamError("Audio capture stream read failed", { action: "read" }, cause))
        return
      }
      if (result.status !== 0) {
        this.fail(this.operationError("read", result))
        return
      }
      chunksThisTurn += 1
      if (result.framesRead === 0) {
        if (!(await waitForPoll(this.lifecycleController.signal))) return
      } else if (chunksThisTurn >= CAPTURE_DISCARD_BATCH_CHUNKS) {
        chunksThisTurn = 0
        await waitForDelay(0, this.lifecycleController.signal).catch(() => undefined)
      }
    }
  }

  private requestDiscardDrain(): void {
    if (this.terminal || this.discardRequested) return
    this.discardRequested = true
    void this.pump()
  }

  private scheduleDiscardIfIdle(): void {
    if (this.terminal || this.discardRequested || this.discardDecisionScheduled) return
    this.discardDecisionScheduled = true
    setTimeout(() => {
      this.discardDecisionScheduled = false
      if (this.terminal) return
      if (this.readable.locked) this.scheduleDiscardIfIdle()
      else this.requestDiscardDrain()
    }, STREAM_POLL_INTERVAL_MS)
  }

  private refreshStats(): AudioCaptureStats | null {
    let result: AudioCaptureStatsOperationResult
    try {
      result = this.init.stats()
    } catch (cause) {
      this.fail(new AudioCaptureStreamError("Audio capture stream stats failed", { action: "stats" }, cause))
      return null
    }
    if (result.status !== 0 || result.stats == null) {
      this.fail(this.operationError("stats", result))
      return null
    }
    this.nativeStats = result.stats
    return result.stats
  }

  private observeProducer(): boolean {
    if (this.producerStopAttempted) return false
    let running: boolean
    try {
      running = this.init.isRunning()
    } catch (cause) {
      this.fail(new AudioCaptureStreamError("Audio capture stream stats failed", { action: "stats" }, cause))
      return false
    }
    if (this.terminal) return false
    if (running) return true
    this.currentState = "stopping"
    const result = this.stopProducer()
    if (result != null && result.status !== 0) this.fail(this.operationError("stop", result))
    return false
  }

  private stopProducer(): AudioCaptureOperationResult | null {
    if (this.producerStopAttempted) return null
    this.producerStopAttempted = true
    try {
      const result = this.init.stop()
      if (result.status === 0) {
        this.producerStopped = true
        this.producerMayBeRunning = false
      }
      return result
    } catch (cause) {
      return { status: -1, cause }
    }
  }

  private finishStopped(): void {
    if (this.terminal) return
    if (this.refreshStats() == null || this.terminal) return
    this.terminal = true
    this.currentState = "stopped"
    this.lifecycleController.abort()
    this.removeOwner()
    this.streamController?.close()
    this.emitTerminal("stopped")
  }

  private fail(error: AudioCaptureStreamError): void {
    if (this.terminal) return
    this.terminal = true
    this.currentState = "errored"
    this.lifecycleController.abort()
    try {
      this.streamController?.error(error)
    } catch {}
    this.terminalCompletionPromise = (async () => {
      if ((await this.cleanupProducer()).status === 0) this.removeOwner()
      this.refreshFinalStats()
      if (this.exposed) this.emitTerminal("error", error, error.context)
      else this.closedResolve()
    })()
  }

  private operationError(
    action: AudioCaptureStreamAction,
    result: AudioCaptureOperationResult,
  ): AudioCaptureStreamError {
    const context: AudioCaptureStreamErrorContext = { action }
    if (result.status !== 0) context.status = result.status
    return new AudioCaptureStreamError(
      `Audio capture stream ${action} failed${result.status ? `: ${result.status}` : ""}`,
      context,
      result.cause,
    )
  }

  private cleanupProducer(): Promise<AudioCaptureOperationResult> {
    if (!this.producerMayBeRunning || this.producerStopped) return Promise.resolve({ status: 0 })
    if (this.producerCleanupPromise != null) return this.producerCleanupPromise
    const cleanup = (async () => {
      let lastFailure: AudioCaptureOperationResult = this.lastCleanupFailure ?? { status: -1 }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        this.producerStopAttempted = false
        const result = this.stopProducer()
        if (result?.status === 0) {
          this.lastCleanupFailure = null
          return result
        }
        if (result != null) {
          lastFailure = result
          this.lastCleanupFailure = result
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_INTERVAL_MS))
      }
      return lastFailure
    })()
    this.producerCleanupPromise = cleanup
    void cleanup.finally(() => {
      if (this.producerCleanupPromise === cleanup) this.producerCleanupPromise = null
    })
    return cleanup
  }

  private retryTerminalCleanup(): Promise<void> {
    return this.cleanupProducer().then((result) => {
      if (result.status === 0) this.removeOwner()
    })
  }

  private publicStats(): AudioCaptureStreamStats {
    return {
      ...this.nativeStats,
      state: this.currentState,
      bufferedDurationMs:
        this.nativeStats.sampleRate === 0 ? 0 : (this.nativeStats.bufferedFrames * 1000) / this.nativeStats.sampleRate,
    }
  }

  private refreshFinalStats(): void {
    try {
      const result = this.init.stats()
      if (result.status === 0 && result.stats != null) this.nativeStats = result.stats
    } catch {}
  }

  private removeOwner(): void {
    if (this.ownerRemoved) return
    this.ownerRemoved = true
    this.init.options.signal?.removeEventListener("abort", this.signalAbortListener)
    this.init.removeFromOwner()
  }

  private emitTerminal<K extends keyof AudioCaptureStreamEvents>(event: K, ...args: AudioCaptureStreamEvents[K]): void {
    setTimeout(() => {
      try {
        EventEmitter.prototype.emit.call(this, event, ...args)
      } finally {
        this.closedResolve()
      }
    }, 0)
  }
}

interface AudioRecorderInit {
  filePath: string
  signal?: AbortSignal
  captureOptions: ResolvedAudioCaptureStreamOptions
  openCapture(options: AudioCaptureStreamOptions): Promise<AudioCaptureStream>
  removeFromOwner(): void
}

let createAudioRecorder: (init: AudioRecorderInit) => AudioRecorder
let openAudioRecorder: (recorder: AudioRecorder) => Promise<void>

function createWavHeader(sampleRate: number, channels: number, dataBytes: number): Uint8Array {
  const header = new Uint8Array(WAV_HEADER_BYTES)
  const view = new DataView(header.buffer)
  header.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, dataBytes + 36, true)
  header.set([0x57, 0x41, 0x56, 0x45], 8)
  header.set([0x66, 0x6d, 0x74, 0x20], 12)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  header.set([0x64, 0x61, 0x74, 0x61], 36)
  view.setUint32(40, dataBytes, true)
  return header
}

export class AudioRecorder extends EventEmitter<AudioRecorderEvents> {
  private static readonly fileSystem = { open: openFile, rename, unlink }

  readonly filePath: string
  readonly format = "wav" as const
  readonly sampleRate: number
  readonly channels: number
  readonly closed: Promise<void>
  private readonly init: AudioRecorderInit
  private currentState: AudioRecorderState = "initializing"
  private capture: AudioCaptureStream | null = null
  private reader: ReadableStreamDefaultReader<Float32Array> | null = null
  private fileHandle: FileHandle | null = null
  private tempPath: string | null = null
  private captureStats: AudioCaptureStreamStats
  private framesWritten = 0n
  private dataBytesWritten = 0n
  private stopRequested = false
  private terminal: "stopped" | "error" | "disposed" | null = null
  private terminationRequest: { kind: "error" | "disposed"; error?: AudioRecorderError } | null = null
  private publicationStarted = false
  private exposed = false
  private ownerRemoved = false
  private cleanupPromise: Promise<AudioRecorderError | null> | null = null
  private resourceCleanupPromise: Promise<AudioRecorderError | null> | null = null
  private retainedCleanupScheduled = false
  private lifecyclePromise: Promise<void> | null = null
  private closedResolve!: () => void
  private readonly signalAbortListener = () => this.dispose()
  private readonly captureErrorListener = (error: AudioCaptureStreamError) => {
    void this.fail(this.fromCaptureError(error))
  }

  static {
    createAudioRecorder = (init) => new AudioRecorder(init)
    openAudioRecorder = (recorder) => recorder.open()
  }

  private constructor(init: AudioRecorderInit) {
    super()
    this.init = init
    this.filePath = init.filePath
    this.sampleRate = init.captureOptions.sampleRate
    this.channels = init.captureOptions.channels
    this.captureStats = {
      state: "initializing",
      sampleRate: this.sampleRate,
      channels: this.channels,
      capacityFrames: init.captureOptions.capacityFrames,
      bufferedFrames: 0,
      bufferedDurationMs: 0,
      framesReceived: 0n,
      framesRead: 0n,
      framesDropped: 0n,
    }
    this.closed = new Promise((resolve) => (this.closedResolve = resolve))
    this.init.signal?.addEventListener("abort", this.signalAbortListener, { once: true })
  }

  get state(): AudioRecorderState {
    return this.currentState
  }

  private async open(): Promise<void> {
    try {
      this.fileHandle = await this.openTemporaryFile()
      this.ensureOpening()
      await this.writeFully(new Uint8Array(WAV_HEADER_BYTES), 0, "write")
      this.ensureOpening()
      try {
        this.capture = await this.init.openCapture({
          channels: this.init.captureOptions.channels,
          capacityFrames: this.init.captureOptions.capacityFrames,
          chunkFrames: this.init.captureOptions.chunkFrames,
          startOptions: this.init.captureOptions.startOptions,
        })
        this.capture.on("error", this.captureErrorListener)
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause
        throw new AudioRecorderError("Audio recorder capture start failed", { action: "start" }, cause)
      }
      this.ensureOpening()
      this.captureStats = this.capture.getStats()
      if (this.captureStats.framesDropped > 0n) {
        throw new AudioRecorderError("Audio recorder capture dropped frames", { action: "stats" })
      }
      this.currentState = "recording"
      this.exposed = true
      this.reader = this.capture.readable.getReader()
      const lifecycle = this.consume()
      this.lifecyclePromise = lifecycle
      void lifecycle.finally(() => {
        if (this.lifecyclePromise === lifecycle) this.lifecyclePromise = null
        const request = this.terminationRequest
        if (request != null) void this.finishCleanup(request.kind, request.error)
      })
    } catch (cause) {
      if (this.terminationRequest == null) {
        if (cause instanceof DOMException && cause.name === "AbortError") this.requestTermination("disposed")
        else {
          const error =
            cause instanceof AudioRecorderError
              ? cause
              : new AudioRecorderError("Audio recorder open failed", { action: "open" }, cause)
          this.requestTermination("error", error)
        }
      }
      const request = this.terminationRequest!
      const cleanupError = await this.finishCleanup(request.kind, request.error)
      if (cleanupError != null) {
        throw new AudioRecorderError(
          "Audio recorder setup cleanup failed",
          { action: "destroy" },
          new AggregateError([cause, cleanupError], "Audio recorder setup and cleanup failed"),
        )
      }
      if (request.kind === "disposed") throw createAbortError()
      if (cause instanceof AudioRecorderError) throw cause
      throw new AudioRecorderError("Audio recorder open failed", { action: "open" }, cause)
    }
  }

  getStats(): AudioRecorderStats {
    if (this.capture != null && this.terminal == null && this.terminationRequest == null) {
      this.captureStats = this.capture.getStats()
      if (this.captureStats.framesDropped > 0n) {
        void this.fail(new AudioRecorderError("Audio recorder capture dropped frames", { action: "stats" }))
      }
    }
    return {
      sampleRate: this.captureStats.sampleRate,
      channels: this.captureStats.channels,
      capacityFrames: this.captureStats.capacityFrames,
      bufferedFrames: this.captureStats.bufferedFrames,
      bufferedDurationMs: this.captureStats.bufferedDurationMs,
      framesReceived: this.captureStats.framesReceived,
      framesRead: this.captureStats.framesRead,
      framesDropped: this.captureStats.framesDropped,
      state: this.currentState,
      framesWritten: this.framesWritten,
      dataBytesWritten: this.dataBytesWritten,
      durationMs: this.sampleRate === 0 ? 0 : (Number(this.framesWritten) * 1000) / this.sampleRate,
    }
  }

  stop(): void {
    if (this.terminal != null || this.terminationRequest != null || this.stopRequested) return
    this.stopRequested = true
    this.currentState = "stopping"
    try {
      this.capture?.stop()
    } catch (cause) {
      void this.fail(new AudioRecorderError("Audio recorder capture stop failed", { action: "stop" }, cause))
    }
  }

  dispose(): void {
    if (this.terminal != null) {
      void this.retryRetainedCleanup()
      return
    }
    if (this.publicationStarted) return
    this.requestTermination("disposed")
  }

  private async consume(): Promise<void> {
    const reader = this.reader!
    let pendingRead: ReturnType<AudioRecorder["readWithStats"]> | null = this.readWithStats(reader)
    try {
      while (this.terminal == null && this.terminationRequest == null) {
        const result = await pendingRead
        pendingRead = null
        if (this.terminal != null || this.terminationRequest != null) return
        if (result.done) {
          if (!this.stopRequested) {
            this.fail(new AudioRecorderError("Audio capture stopped unexpectedly", { action: "stop" }))
          } else {
            await this.complete()
          }
          return
        }
        // Keep one capture read pending while the current chunk is written so stop() can drain without buffering a queue.
        pendingRead = this.readWithStats(reader)
        this.captureStats = this.capture!.getStats()
        if (this.captureStats.framesDropped > 0n) {
          this.fail(new AudioRecorderError("Audio recorder capture dropped frames", { action: "stats" }))
          return
        }
        await this.writeSamples(result.value)
      }
    } catch (cause) {
      if (this.terminal == null && this.terminationRequest == null) {
        const error =
          cause instanceof AudioRecorderError
            ? cause
            : cause instanceof AudioCaptureStreamError
              ? this.fromCaptureError(cause)
              : new AudioRecorderError("Audio recorder read failed", { action: "read" }, cause)
        this.fail(error)
      }
    } finally {
      if (pendingRead != null) void pendingRead.catch(() => undefined)
      try {
        reader.releaseLock()
      } catch {}
    }
  }

  private async writeSamples(samples: Float32Array): Promise<void> {
    if (samples.length % this.channels !== 0) {
      throw new AudioRecorderError("Audio recorder received a partial frame", { action: "read" })
    }
    const bytes = new Uint8Array(samples.length * 2)
    const view = new DataView(bytes.buffer)
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]!))
      view.setInt16(index * 2, Math.round(sample * 32767), true)
    }
    const nextDataBytes = this.dataBytesWritten + BigInt(bytes.byteLength)
    if (nextDataBytes > MAX_WAV_DATA_BYTES) {
      throw new AudioRecorderError("Audio recorder exceeded the classic RIFF size limit", { action: "write" })
    }
    await this.writeFully(bytes, WAV_HEADER_BYTES + Number(this.dataBytesWritten), "write")
    this.dataBytesWritten = nextDataBytes
    this.framesWritten += BigInt(samples.length / this.channels)
  }

  private readWithStats(
    reader: ReadableStreamDefaultReader<Float32Array>,
  ): Promise<{ done: false; value: Float32Array } | { done: true; value?: undefined }> {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        callback()
      }
      const poll = (): void => {
        if (settled) return
        if (this.terminal != null || this.terminationRequest != null) {
          finish(() => resolve({ done: true, value: undefined }))
          return
        }
        this.captureStats = this.capture!.getStats()
        if (this.captureStats.framesDropped > 0n) {
          finish(() => reject(new AudioRecorderError("Audio recorder capture dropped frames", { action: "stats" })))
          return
        }
        timer = setTimeout(poll, STREAM_POLL_INTERVAL_MS)
      }
      void reader.read().then(
        (result) => finish(() => resolve(result)),
        (cause) => finish(() => reject(cause)),
      )
      timer = setTimeout(poll, STREAM_POLL_INTERVAL_MS)
    })
  }

  private async complete(): Promise<void> {
    if (this.terminal != null || this.terminationRequest != null) return
    this.captureStats = this.capture!.getStats()
    if (this.captureStats.framesDropped > 0n) {
      this.fail(new AudioRecorderError("Audio recorder capture dropped frames", { action: "stats" }))
      return
    }
    try {
      await this.writeFully(
        createWavHeader(this.sampleRate, this.channels, Number(this.dataBytesWritten)),
        0,
        "finalize",
      )
      if (this.terminationRequest != null) return
      await this.fileHandle!.sync()
      if (this.terminationRequest != null) return
      await this.fileHandle!.close()
      this.fileHandle = null
    } catch (cause) {
      if (this.terminationRequest == null) {
        this.fail(
          cause instanceof AudioRecorderError
            ? cause
            : new AudioRecorderError("Audio recorder finalize failed", { action: "finalize" }, cause),
        )
      }
      return
    }
    if (this.terminationRequest != null) return
    this.publicationStarted = true
    try {
      await this.publish()
    } catch (cause) {
      const error = new AudioRecorderError("Audio recorder publish failed", { action: "publish" }, cause)
      this.terminal = "error"
      this.currentState = "errored"
      await this.finishCleanup("error", error)
      return
    }
    this.terminal = "stopped"
    this.currentState = "stopped"
    this.init.signal?.removeEventListener("abort", this.signalAbortListener)
    this.capture?.removeListener("error", this.captureErrorListener)
    if (this.hasRetainedResources()) this.scheduleRetainedCleanup()
    else this.removeOwner()
    this.emitTerminal("stopped")
  }

  private async publish(): Promise<void> {
    const tempPath = this.tempPath!
    await AudioRecorder.fileSystem.rename(tempPath, this.filePath)
    this.tempPath = null
  }

  private fail(error: AudioRecorderError): void {
    if (this.terminal != null || this.publicationStarted) return
    this.requestTermination("error", error)
  }

  private requestTermination(kind: "error" | "disposed", error?: AudioRecorderError): void {
    if (this.terminal != null || this.publicationStarted || this.terminationRequest != null) return
    this.terminationRequest = { kind, error }
    this.currentState = kind === "disposed" ? "disposed" : "errored"
    this.capture?.dispose()
    if (this.exposed && this.lifecyclePromise == null) void this.finishCleanup(kind, error)
  }

  private finishCleanup(kind: "error" | "disposed", error?: AudioRecorderError): Promise<AudioRecorderError | null> {
    if (this.cleanupPromise != null) return this.cleanupPromise
    this.cleanupPromise = (async () => {
      this.init.signal?.removeEventListener("abort", this.signalAbortListener)
      const capture = this.capture
      capture?.dispose()
      if (capture != null) {
        await capture.closed
        this.captureStats = capture.getStats()
      }
      capture?.removeListener("error", this.captureErrorListener)
      const cleanupError = await this.cleanupOwnedResources()
      const captureCleanupError =
        capture?.state === "errored"
          ? new AudioRecorderError("Audio recorder capture cleanup failed", { action: "destroy" })
          : null
      const terminalKind = cleanupError == null && captureCleanupError == null ? kind : "error"
      const terminalError = cleanupError ?? error ?? captureCleanupError
      this.terminal = terminalKind
      this.currentState = terminalKind === "disposed" ? "disposed" : "errored"
      if (this.hasRetainedResources()) this.scheduleRetainedCleanup()
      else this.removeOwner()
      if (!this.exposed) {
        this.closedResolve()
      } else if (terminalKind === "error") {
        this.emitTerminal("error", terminalError!, terminalError!.context)
      } else {
        this.emitTerminal("disposed")
      }
      return cleanupError ?? captureCleanupError
    })()
    return this.cleanupPromise
  }

  private cleanupOwnedResources(): Promise<AudioRecorderError | null> {
    if (!this.hasRetainedResources()) return Promise.resolve(null)
    if (this.resourceCleanupPromise != null) return this.resourceCleanupPromise
    const cleanup = (async () => {
      let lastError: AudioRecorderError | null = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const handle = this.fileHandle
        if (handle != null) {
          try {
            await handle.close()
            if (this.fileHandle === handle) this.fileHandle = null
          } catch (cause) {
            lastError = new AudioRecorderError("Audio recorder file close failed", { action: "destroy" }, cause)
          }
        }
        if (this.fileHandle == null) {
          const tempPath = this.tempPath
          if (tempPath != null) {
            try {
              await AudioRecorder.fileSystem.unlink(tempPath)
              if (this.tempPath === tempPath) this.tempPath = null
            } catch (cause) {
              lastError = new AudioRecorderError(
                "Audio recorder temp file cleanup failed",
                { action: "destroy" },
                cause,
              )
            }
          }
        }
        if (!this.hasRetainedResources()) return null
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_INTERVAL_MS))
      }
      return lastError ?? new AudioRecorderError("Audio recorder resource cleanup failed", { action: "destroy" })
    })()
    this.resourceCleanupPromise = cleanup
    const clear = (): void => {
      if (this.resourceCleanupPromise === cleanup) this.resourceCleanupPromise = null
    }
    void cleanup.then(clear, clear)
    return cleanup
  }

  private retryRetainedCleanup(): Promise<void> {
    this.capture?.dispose()
    if (!this.hasRetainedResources()) {
      this.removeOwner()
      return Promise.resolve()
    }
    return this.cleanupOwnedResources().then(() => {
      if (!this.hasRetainedResources()) this.removeOwner()
    })
  }

  private scheduleRetainedCleanup(): void {
    if (this.retainedCleanupScheduled || !this.hasRetainedResources()) return
    this.retainedCleanupScheduled = true
    setTimeout(() => {
      this.retainedCleanupScheduled = false
      void this.retryRetainedCleanup()
    }, STREAM_POLL_INTERVAL_MS)
  }

  private hasRetainedResources(): boolean {
    return this.fileHandle != null || this.tempPath != null
  }

  private async openTemporaryFile(): Promise<FileHandle> {
    const directory = dirname(this.filePath)
    const destinationName = basename(this.filePath)
    const tempNameLength = Math.max(1, Math.min(24, destinationName.length))
    const singleCharacterNames = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-"
    for (let attempt = 0; attempt < singleCharacterNames.length; attempt += 1) {
      const tempName =
        tempNameLength === 1 ? singleCharacterNames[attempt]! : randomBytes(16).toString("hex").slice(0, tempNameLength)
      if (tempName === destinationName) continue
      const tempPath = join(directory, tempName)
      try {
        const handle = await AudioRecorder.fileSystem.open(tempPath, "wx")
        this.tempPath = tempPath
        return handle
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new AudioRecorderError("Audio recorder temp file open failed", { action: "open" }, cause)
        }
      }
    }
    throw new AudioRecorderError("Audio recorder could not allocate a temporary file", { action: "open" })
  }

  private async writeFully(bytes: Uint8Array, position: number, action: "write" | "finalize"): Promise<void> {
    let offset = 0
    while (offset < bytes.byteLength) {
      let bytesWritten: number
      try {
        ;({ bytesWritten } = await this.fileHandle!.write(bytes, offset, bytes.byteLength - offset, position + offset))
      } catch (cause) {
        throw new AudioRecorderError(`Audio recorder ${action} write failed`, { action }, cause)
      }
      if (bytesWritten <= 0) {
        throw new AudioRecorderError(`Audio recorder ${action} write made no progress`, { action })
      }
      offset += Math.min(bytesWritten, bytes.byteLength - offset)
    }
  }

  private ensureOpening(): void {
    if (this.terminationRequest?.kind === "disposed" || this.init.signal?.aborted) throw createAbortError()
    if (this.terminationRequest?.kind === "error") throw this.terminationRequest.error
  }

  private fromCaptureError(error: AudioCaptureStreamError): AudioRecorderError {
    const action: AudioRecorderAction =
      error.context.action === "stop"
        ? "stop"
        : error.context.action === "stats"
          ? "stats"
          : error.context.action === "destroy"
            ? "destroy"
            : "read"
    const context: AudioRecorderErrorContext = { action }
    if (error.context.status !== undefined) context.status = error.context.status
    return new AudioRecorderError(`Audio recorder capture ${action} failed`, context, error)
  }

  private removeOwner(): void {
    if (this.ownerRemoved) return
    this.ownerRemoved = true
    this.init.removeFromOwner()
  }

  private emitTerminal<K extends keyof AudioRecorderEvents>(event: K, ...args: AudioRecorderEvents[K]): void {
    setTimeout(() => {
      try {
        EventEmitter.prototype.emit.call(this, event, ...args)
      } finally {
        this.closedResolve()
      }
    }, 0)
  }
}

export class Audio extends EventEmitter<AudioEvents> {
  static create(options: AudioSetupOptions = {}): Audio {
    let lib: RenderLib
    try {
      lib = resolveRenderLib()
    } catch (cause) {
      throw new AudioInitializationError(
        "resolveRenderLib",
        "Failed to resolve the native audio library",
        undefined,
        cause,
      )
    }
    return new Audio(lib, options)
  }

  readonly sampleRate: number

  private readonly lib: RenderLib
  private readonly defaultStartOptions: AudioStartOptions | undefined
  private engine: AudioEngineHandle | null = null
  private readonly groups = new Map<string, number>()
  private readonly streams = new Set<{ dispose(): void }>()
  private playbackStarted = false
  private mixerStarted = false
  private captureStarted = false
  private captureDeviceOpen = false
  private captureBufferAvailable = false
  private captureChannels = 1
  private captureCapacityFrames = 0
  private captureOwner: object | null = null
  private captureStream: AudioCaptureStream | null = null
  private disposing = false

  private constructor(lib: RenderLib, options: AudioSetupOptions) {
    super()
    this.lib = lib
    this.defaultStartOptions = options.startOptions
    const normalizedSampleRate =
      options.sampleRate == null || !Number.isFinite(options.sampleRate)
        ? 0
        : Math.min(MAX_U32, Math.max(0, Math.trunc(options.sampleRate)))
    this.sampleRate = normalizedSampleRate || DEFAULT_AUDIO_SAMPLE_RATE
    const createOptions =
      options.sampleRate == null && options.playbackChannels == null
        ? undefined
        : {
            sampleRate: options.sampleRate == null ? undefined : normalizedSampleRate,
            playbackChannels:
              options.playbackChannels == null ? undefined : Math.max(0, Math.trunc(options.playbackChannels)),
          }
    this.engine = this.lib.createAudioEngine(createOptions)
    if (!this.engine) {
      throw new AudioInitializationError("createAudioEngine", "Audio createAudioEngine returned null")
    }

    if (options.autoStart ?? false) {
      const status = this.lib.audioStart(this.engine, this.defaultStartOptions)
      if (status !== 0) {
        this.throwAfterInitializationCleanup(
          new AudioInitializationError("start", `Audio auto-start failed: ${status}`, status),
        )
      }
      this.playbackStarted = true
      this.mixerStarted = true
    }
  }

  private throwAfterInitializationCleanup(error: AudioInitializationError): never {
    const engine = this.engine
    this.engine = null
    if (engine) this.lib.destroyAudioEngine(engine)
    throw error
  }

  private emitError(action: AudioAction, status?: number, message?: string, cause?: unknown): void {
    const error = message ? new Error(message) : statusToError(action, status ?? -1)
    if (cause) (error as Error & { cause?: unknown }).cause = cause
    this.emit("error", error, { action, status })
  }

  start(options?: AudioStartOptions): boolean {
    if (this.playbackStarted) return true
    const engine = this.engine
    if (!engine) {
      this.emitError("start", undefined, "Audio engine unavailable during start")
      return false
    }
    const startOptions = options ?? this.defaultStartOptions
    const status = this.lib.audioStart(engine, startOptions)
    if (status !== 0) {
      this.emitError("start", status)
      return false
    }
    this.playbackStarted = true
    this.mixerStarted = true
    this.emit("started")
    return true
  }

  startMixer(): boolean {
    if (this.mixerStarted) return true
    const engine = this.engine
    if (!engine) {
      this.emitError("startMixer", undefined, "Audio engine unavailable during startMixer")
      return false
    }
    const status = this.lib.audioStartMixer(engine)
    if (status !== 0) {
      this.emitError("startMixer", status)
      return false
    }
    this.mixerStarted = true
    this.emit("mixerStarted")
    return true
  }

  stop(): boolean {
    if (!this.mixerStarted) return true
    const engine = this.engine
    if (!engine) {
      this.emitError("stop", undefined, "Audio engine unavailable during stop")
      return false
    }
    const status = this.lib.audioStop(engine)
    if (status !== 0) {
      this.emitError("stop", status)
      return false
    }
    this.playbackStarted = false
    this.mixerStarted = false
    this.emit("stopped")
    return true
  }

  isStarted(): boolean {
    return this.playbackStarted
  }

  isMixerStarted(): boolean {
    return this.mixerStarted
  }

  loadSound(data: Uint8Array | ArrayBuffer): AudioSound | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("loadSound", undefined, "Audio engine unavailable during loadSound")
      return null
    }
    const result = this.lib.audioLoad(engine, toBytes(data))
    if (result.status !== 0 || result.soundId == null) {
      this.emitError("loadSound", result.status)
      return null
    }
    return result.soundId
  }

  async loadSoundFile(filePath: string): Promise<AudioSound | null> {
    const bytes = await readFile(filePath).catch((err) => {
      this.emitError("loadSoundFile", undefined, `Failed to read file '${filePath}': ${err.message}`, err)
      return null
    })
    if (bytes == null) return null
    return this.loadSound(bytes)
  }

  unloadSound(sound: AudioSound): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("unloadSound", undefined, "Audio engine unavailable during unloadSound")
      return false
    }

    const status = this.lib.audioUnload(engine, sound)
    if (status !== 0) {
      this.emitError("unloadSound", status)
      return false
    }
    return true
  }

  group(name: string): AudioGroup | null {
    const existing = this.groups.get(name)
    if (existing != null) {
      return existing
    }

    const engine = this.engine
    if (!engine) {
      this.emitError("group", undefined, "Audio engine unavailable during group")
      return null
    }
    const result = this.lib.audioCreateGroup(engine, name)
    if (result.status !== 0 || result.groupId == null) {
      this.emitError("group", result.status)
      return null
    }

    this.groups.set(name, result.groupId)
    return result.groupId
  }

  play(sound: AudioSound, options?: AudioPlayOptions): AudioVoice | null {
    const rawOptions = options
      ? {
          volume: options.volume,
          pan: options.pan,
          loop: options.loop,
          groupId: options.groupId ?? 0,
        }
      : undefined

    const engine = this.engine
    if (!engine) {
      this.emitError("play", undefined, "Audio engine unavailable during play")
      return null
    }
    const result = this.lib.audioPlay(engine, sound, rawOptions)
    if (result.status !== 0 || result.voiceId == null) {
      this.emitError("play", result.status)
      return null
    }

    return result.voiceId
  }

  async playStream<M = AudioStreamMetadata>(
    source: AudioStreamBody,
    options: AudioStreamBodyOptions<M> = {},
  ): Promise<AudioStream<M>> {
    const urlOptions = options as AudioStreamUrlOptions
    if (
      urlOptions.request !== undefined ||
      urlOptions.reconnect !== undefined ||
      urlOptions.metadataEncoding !== undefined ||
      urlOptions.contentTypePolicy !== undefined
    ) {
      return Promise.reject(
        new TypeError(
          "request, reconnect, metadataEncoding, and contentTypePolicy options are only supported by playStreamUrl()",
        ),
      )
    }
    if (!isReadableStreamSource(source) && !isAsyncIterableSource(source)) {
      return Promise.reject(new TypeError("Audio stream source must be a ReadableStream or AsyncIterable"))
    }
    const { demuxer, ...streamOptions } = options
    const connector: AudioStreamConnector<void> = {
      async connect() {
        return { body: source, info: undefined }
      },
    }
    return this.openStream(connector, demuxer == null ? undefined : () => demuxer(), streamOptions, "source")
  }

  async playStreamUrl(
    source: string | URL,
    options: AudioStreamUrlOptions = {},
  ): Promise<AudioStream<AudioStreamMetadata>> {
    if ((options as AudioStreamBodyOptions).demuxer !== undefined) {
      throw new TypeError("demuxer is only supported by playStream() and playStreamSource()")
    }
    if (typeof source !== "string" && Object.prototype.toString.call(source) !== "[object URL]") {
      return Promise.reject(new TypeError("Audio stream URL source must be a string or URL"))
    }
    const { request, metadataEncoding, reconnect, format, contentTypePolicy, ...streamOptions } = options
    const resolvedFormat = resolveAudioStreamFormat(format)
    const resolvedContentTypePolicy = resolveContentTypePolicy(contentTypePolicy, options)
    const encoding = resolveMetadataEncoding(metadataEncoding)
    const connector = createAudioStreamUrlConnector(
      source,
      resolveAudioStreamRequest(request),
      resolvedFormat,
      resolvedContentTypePolicy,
    )
    return this.openStream(
      connector,
      (info) => {
        try {
          return selectAudioStreamDemuxer({ headers: info.headers, metadataEncoding: encoding })
        } catch (cause) {
          throw new AudioStreamError(
            cause instanceof Error ? cause.message : "Invalid audio stream metadata response",
            { action: "response", status: info.status },
            cause,
          )
        }
      },
      { ...streamOptions, reconnect, format: resolvedFormat },
      "fetch",
    )
  }

  async playStreamSource<I, M = AudioStreamMetadata>(
    connector: AudioStreamConnector<I>,
    options: AudioStreamSourceOptions<I, M> = {},
  ): Promise<AudioStream<M>> {
    const urlOptions = options as AudioStreamUrlOptions
    if (
      urlOptions.request !== undefined ||
      urlOptions.metadataEncoding !== undefined ||
      urlOptions.contentTypePolicy !== undefined
    ) {
      return Promise.reject(
        new TypeError("request, metadataEncoding, and contentTypePolicy are only supported by playStreamUrl()"),
      )
    }
    const { demuxer, ...streamOptions } = options
    return this.openStream(connector, demuxer, streamOptions, "source")
  }

  private async openStream<I, M>(
    connector: AudioStreamConnector<I>,
    demuxer: ((info: I) => AudioStreamDemuxer<M> | null) | undefined,
    options: AudioStreamOptions & { reconnect?: AudioStreamReconnectOptions },
    readAction: "fetch" | "source",
  ): Promise<AudioStream<M>> {
    const engine = this.engine
    if (!engine) throw new Error("Audio engine unavailable during stream playback")
    const resolvedConnector = resolveAudioStreamConnector(connector)

    let stream: AudioStream<M>
    stream = createAudioStream({
      lib: this.lib,
      engine,
      connector: resolvedConnector,
      demuxer,
      options,
      readAction,
      removeFromOwner: () => this.streams.delete(stream),
    })
    this.streams.add(stream)
    try {
      await openAudioStream(stream)
      return stream
    } catch (error) {
      stream.dispose()
      throw error
    }
  }

  stopVoice(voice: AudioVoice): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("stopVoice", undefined, "Audio engine unavailable during stopVoice")
      return false
    }
    const status = this.lib.audioStopVoice(engine, voice)
    if (status !== 0) {
      this.emitError("stopVoice", status)
      return false
    }
    return true
  }

  setVoiceGroup(voice: AudioVoice, group: AudioGroup): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("setVoiceGroup", undefined, "Audio engine unavailable during setVoiceGroup")
      return false
    }
    const status = this.lib.audioSetVoiceGroup(engine, voice, group)
    if (status !== 0) {
      this.emitError("setVoiceGroup", status)
      return false
    }
    return true
  }

  setGroupVolume(group: AudioGroup, volume: number): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("setGroupVolume", undefined, "Audio engine unavailable during setGroupVolume")
      return false
    }
    const status = this.lib.audioSetGroupVolume(engine, group, volume)
    if (status !== 0) {
      this.emitError("setGroupVolume", status)
      return false
    }
    return true
  }

  setMasterVolume(volume: number): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("setMasterVolume", undefined, "Audio engine unavailable during setMasterVolume")
      return false
    }
    const status = this.lib.audioSetMasterVolume(engine, volume)
    if (status !== 0) {
      this.emitError("setMasterVolume", status)
      return false
    }
    return true
  }

  mixFrames(frameCount: number, channels: number = 2): Float32Array | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("mixFrames", undefined, "Audio engine unavailable during mixFrames")
      return null
    }
    const output = new Float32Array(frameCount * channels)
    const status = this.lib.audioMixToBuffer(engine, output, frameCount, channels)
    if (status !== 0) {
      this.emitError("mixFrames", status)
      return null
    }
    return output
  }

  enableTap(capacityFrames: number = 8192): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("enableTap", undefined, "Audio engine unavailable during enableTap")
      return false
    }
    const status = this.lib.audioEnableTap(engine, true, capacityFrames)
    if (status !== 0) {
      this.emitError("enableTap", status)
      return false
    }
    return true
  }

  disableTap(): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("enableTap", undefined, "Audio engine unavailable during disableTap")
      return false
    }
    const status = this.lib.audioEnableTap(engine, false, 0)
    if (status !== 0) {
      this.emitError("enableTap", status)
      return false
    }
    return true
  }

  readTapFrames(frameCount: number, channels: number = 2): { frames: Float32Array; framesRead: number } | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("readTapFrames", undefined, "Audio engine unavailable during readTapFrames")
      return null
    }
    const output = new Float32Array(frameCount * channels)
    const result = this.lib.audioReadTap(engine, output, frameCount, channels)
    if (result.status !== 0) {
      this.emitError("readTapFrames", result.status)
      return null
    }
    return { frames: output, framesRead: result.framesRead }
  }

  listPlaybackDevices(): AudioPlaybackDevice[] | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("listPlaybackDevices", undefined, "Audio engine unavailable during listPlaybackDevices")
      return null
    }

    const refreshStatus = this.lib.audioRefreshPlaybackDevices(engine)
    if (refreshStatus !== 0) {
      this.emitError("listPlaybackDevices", refreshStatus)
      return null
    }

    const count = this.lib.audioGetPlaybackDeviceCount(engine)
    const devices: AudioPlaybackDevice[] = []
    for (let index = 0; index < count; index += 1) {
      devices.push({
        index,
        name: this.lib.audioGetPlaybackDeviceName(engine, index),
        isDefault: this.lib.audioIsPlaybackDeviceDefault(engine, index),
      })
    }

    return devices
  }

  selectPlaybackDevice(index: number): boolean {
    const engine = this.engine
    if (!engine) {
      this.emitError("selectPlaybackDevice", undefined, "Audio engine unavailable during selectPlaybackDevice")
      return false
    }

    const refreshStatus = this.lib.audioRefreshPlaybackDevices(engine)
    if (refreshStatus !== 0) {
      this.emitError("selectPlaybackDevice", refreshStatus)
      return false
    }

    const status = this.lib.audioSelectPlaybackDevice(engine, index)
    if (status !== 0) {
      this.emitError("selectPlaybackDevice", status)
      return false
    }

    return true
  }

  clearPlaybackDeviceSelection(): void {
    const engine = this.engine
    if (!engine) {
      this.emitError(
        "clearPlaybackDeviceSelection",
        undefined,
        "Audio engine unavailable during clearPlaybackDeviceSelection",
      )
      return
    }
    this.lib.audioClearPlaybackDeviceSelection(engine)
  }

  async openCapture(options: AudioCaptureStreamOptions = {}): Promise<AudioCaptureStream> {
    const resolved = resolveAudioCaptureStreamOptions(options, this.sampleRate)
    if (resolved.signal?.aborted) throw createAbortError()
    if (!this.engine) {
      throw new AudioCaptureStreamError("Audio engine unavailable during capture stream start", { action: "start" })
    }
    if (this.captureOwner != null || this.isCapturing()) {
      throw new AudioCaptureStreamError("Audio capture ring is already in use", { action: "start" })
    }

    const owner = {}
    this.captureOwner = owner
    let stream: AudioCaptureStream | null = null
    try {
      stream = createAudioCaptureStream({
        options: resolved,
        start: () => this.startCaptureInternal(resolved, owner),
        read: (frameCount) => this.readCaptureInternal(frameCount, owner),
        stats: () => this.getCaptureStatsInternal(owner),
        stop: () => this.stopCaptureInternal(owner),
        isRunning: () => this.isCapturingInternal(owner),
        removeFromOwner: () => {
          if (this.captureOwner === owner) this.captureOwner = null
          if (this.captureStream === stream) this.captureStream = null
          if (stream != null) this.streams.delete(stream)
        },
      })
      this.captureStream = stream
      this.streams.add(stream)
      await openAudioCaptureStream(stream)
      return stream
    } catch (error) {
      if (stream == null) {
        if (this.captureOwner === owner) this.captureOwner = null
      } else {
        stream.dispose()
        if (this.captureOwner !== owner) this.streams.delete(stream)
      }
      throw error
    }
  }

  async recordToFile(filePath: string, options: AudioRecordToFileOptions = {}): Promise<AudioRecorder> {
    if (typeof filePath !== "string" || filePath.length === 0) throw new TypeError("filePath must be a nonempty string")
    if (filePath.includes("\0")) throw new TypeError("filePath must not contain NUL bytes")
    const resolved = resolveAudioCaptureStreamOptions(options, this.sampleRate)
    if (resolved.channels !== 1 && resolved.channels !== 2) {
      throw new RangeError("WAV recording supports only 1 or 2 channels")
    }
    if (this.sampleRate * resolved.channels * 2 > MAX_U32) {
      throw new RangeError("WAV byte rate exceeds the supported limit")
    }
    if (resolved.signal?.aborted) throw createAbortError()
    if (!this.engine) throw new AudioRecorderError("Audio engine unavailable during recorder open", { action: "open" })

    let recorder: AudioRecorder
    recorder = createAudioRecorder({
      filePath,
      signal: resolved.signal,
      captureOptions: resolved,
      openCapture: (captureOptions) => this.openCapture(captureOptions),
      removeFromOwner: () => this.streams.delete(recorder),
    })
    this.streams.add(recorder)
    try {
      await openAudioRecorder(recorder)
      return recorder
    } catch (error) {
      throw error
    }
  }

  listCaptureDevices(): AudioCaptureDevice[] | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("listCaptureDevices", undefined, "Audio engine unavailable during listCaptureDevices")
      return null
    }

    const refreshStatus = this.lib.audioRefreshCaptureDevices(engine)
    if (refreshStatus !== 0) {
      this.emitError("listCaptureDevices", refreshStatus)
      return null
    }

    const count = this.lib.audioGetCaptureDeviceCount(engine)
    const devices: AudioCaptureDevice[] = []
    for (let index = 0; index < count; index += 1) {
      devices.push({
        index,
        name: this.lib.audioGetCaptureDeviceName(engine, index),
        isDefault: this.lib.audioIsCaptureDeviceDefault(engine, index),
      })
    }
    return devices
  }

  selectCaptureDevice(index: number): boolean {
    const resolvedIndex = resolveU32Index(index, "index")
    if (this.captureOwner != null) {
      this.emitCaptureOwnershipError("selectCaptureDevice")
      return false
    }
    const engine = this.engine
    if (!engine) {
      this.emitError("selectCaptureDevice", undefined, "Audio engine unavailable during selectCaptureDevice")
      return false
    }

    const status = this.lib.audioSelectCaptureDevice(engine, resolvedIndex)
    if (status !== 0) {
      this.emitError("selectCaptureDevice", status)
      return false
    }
    return true
  }

  clearCaptureDeviceSelection(): void {
    if (this.captureOwner != null) {
      this.emitCaptureOwnershipError("clearCaptureDeviceSelection")
      return
    }
    const engine = this.engine
    if (!engine) {
      this.emitError(
        "clearCaptureDeviceSelection",
        undefined,
        "Audio engine unavailable during clearCaptureDeviceSelection",
      )
      return
    }
    this.lib.audioClearCaptureDeviceSelection(engine)
  }

  startCapture(options: AudioCaptureOptions = {}): boolean {
    if (this.disposing) return false
    const channels = resolvePositiveU32(options.channels, 1, "channels")
    const capacityFrames = resolvePositiveU32(options.capacityFrames, this.sampleRate, "capacityFrames")
    if (this.captureOwner != null) {
      this.emitCaptureOwnershipError("startCapture")
      return false
    }
    if (this.isCapturing()) {
      const configurationMatches =
        (options.channels === undefined || channels === this.captureChannels) &&
        (options.capacityFrames === undefined || capacityFrames === this.captureCapacityFrames) &&
        options.startOptions === undefined
      if (configurationMatches) return true
      this.emitError("startCapture", undefined, "Audio capture is already running with a different configuration")
      return false
    }
    const engine = this.engine
    if (!engine) {
      this.emitError("startCapture", undefined, "Audio engine unavailable during startCapture")
      return false
    }
    const result = this.startCaptureInternal(
      { sampleRate: this.sampleRate, channels, capacityFrames, chunkFrames: 1, startOptions: options.startOptions },
      null,
    )
    if (result.status !== 0) {
      this.emitError("startCapture", result.status, undefined, result.cause)
      return false
    }
    return true
  }

  isCapturing(): boolean {
    return this.isCapturingInternal(null)
  }

  private isCapturingInternal(_owner: object | null): boolean {
    if (!this.captureStarted) return false
    const engine = this.engine
    if (engine && this.lib.audioIsCaptureRunning(engine)) return true
    this.captureStarted = false
    this.emit("captureStopped")
    return this.captureStarted
  }

  readCaptureFrames(frameCount: number): AudioCaptureReadResult | null {
    const resolvedFrameCount = resolvePositiveU32(frameCount, frameCount, "frameCount")
    if (this.captureOwner != null) {
      this.emitCaptureOwnershipError("readCaptureFrames")
      return null
    }
    if (!this.captureBufferAvailable) {
      this.emitError("readCaptureFrames", -4)
      return null
    }
    if (resolvedFrameCount > this.captureCapacityFrames) {
      throw new RangeError("frameCount exceeds the capture buffer capacity")
    }
    if (resolvedFrameCount > Math.floor(MAX_U32 / this.captureChannels)) {
      throw new RangeError("frameCount * channels exceeds the supported limit")
    }
    const engine = this.engine
    if (!engine) {
      this.emitError("readCaptureFrames", undefined, "Audio engine unavailable during readCaptureFrames")
      return null
    }
    const result = this.readCaptureInternal(resolvedFrameCount, null)
    if (result.status !== 0) {
      this.emitError("readCaptureFrames", result.status, undefined, result.cause)
      return null
    }
    return { frames: result.frames, framesRead: result.framesRead }
  }

  getCaptureStats(): AudioCaptureStats | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("getCaptureStats", undefined, "Audio engine unavailable during getCaptureStats")
      return null
    }
    const result = this.getCaptureStatsInternal(null)
    if (result.status !== 0 || result.stats == null) {
      this.emitError("getCaptureStats", result.status, undefined, result.cause)
      return null
    }
    return result.stats
  }

  stopCapture(): boolean {
    if (this.captureOwner != null) {
      this.emitCaptureOwnershipError("stopCapture")
      return false
    }
    if (!this.captureDeviceOpen) return true
    const engine = this.engine
    if (!engine) {
      this.emitError("stopCapture", undefined, "Audio engine unavailable during stopCapture")
      return false
    }
    const result = this.stopCaptureInternal(null)
    if (result.status !== 0) {
      this.emitError("stopCapture", result.status, undefined, result.cause)
      return false
    }
    return true
  }

  private emitCaptureOwnershipError(
    action:
      | "selectCaptureDevice"
      | "clearCaptureDeviceSelection"
      | "startCapture"
      | "readCaptureFrames"
      | "stopCapture",
  ): void {
    this.emitError(action, undefined, `Audio ${action} failed: capture is owned by a stream`)
  }

  private startCaptureInternal(
    options: ResolvedAudioCaptureStreamOptions,
    owner: object | null,
  ): AudioCaptureOperationResult {
    if (this.captureOwner != null && this.captureOwner !== owner) return { status: -1 }
    const engine = this.engine
    if (!engine) return { status: -1 }
    let status: number
    try {
      status = this.lib.audioStartCapture(engine, options.startOptions, options.channels, options.capacityFrames)
    } catch (cause) {
      return { status: -1, cause }
    }
    if (status !== 0) return { status }
    this.captureChannels = options.channels
    this.captureCapacityFrames = options.capacityFrames
    this.captureBufferAvailable = true
    this.captureDeviceOpen = true
    this.captureStarted = true
    this.emit("captureStarted")
    return { status: 0 }
  }

  private readCaptureInternal(frameCount: number, owner: object | null): AudioCaptureReadOperationResult {
    const output = new Float32Array(frameCount * this.captureChannels)
    if (this.captureOwner != null && this.captureOwner !== owner) return { status: -1, frames: output, framesRead: 0 }
    const engine = this.engine
    if (!engine || !this.captureBufferAvailable) return { status: -4, frames: output, framesRead: 0 }
    try {
      const result = this.lib.audioReadCapture(engine, output, frameCount)
      return { status: result.status, frames: output, framesRead: Math.min(frameCount, result.framesRead) }
    } catch (cause) {
      return { status: -1, frames: output, framesRead: 0, cause }
    }
  }

  private getCaptureStatsInternal(_owner: object | null): AudioCaptureStatsOperationResult {
    const engine = this.engine
    if (!engine) return { status: -1, stats: null }
    try {
      const result = this.lib.audioGetCaptureStats(engine)
      if (result.status !== 0 || result.stats == null) return { status: result.status, stats: null }
      return {
        status: 0,
        stats: {
          sampleRate: result.stats.sampleRate,
          channels: result.stats.channels,
          capacityFrames: result.stats.capacityFrames,
          bufferedFrames: result.stats.bufferedFrames,
          framesReceived: result.stats.framesReceived,
          framesRead: result.stats.framesRead,
          framesDropped: result.stats.framesDropped,
        },
      }
    } catch (cause) {
      return { status: -1, stats: null, cause }
    }
  }

  private stopCaptureInternal(owner: object | null): AudioCaptureOperationResult {
    if (this.captureOwner != null && this.captureOwner !== owner) return { status: -1 }
    if (!this.captureDeviceOpen) return { status: 0 }
    const engine = this.engine
    if (!engine) return { status: -1 }
    let status: number
    try {
      status = this.lib.audioStopCapture(engine)
    } catch (cause) {
      return { status: -1, cause }
    }
    if (status !== 0) return { status }
    const wasStarted = this.captureStarted
    this.captureDeviceOpen = false
    this.captureStarted = false
    if (wasStarted) this.emit("captureStopped")
    return { status: 0 }
  }

  getStats(): AudioStats | null {
    const engine = this.engine
    if (!engine) {
      this.emitError("getStats", undefined, "Audio engine unavailable during getStats")
      return null
    }
    const stats = this.lib.audioGetStats(engine)
    if (stats == null) {
      this.emitError("getStats", undefined, "Failed to retrieve audio stats")
    }
    return stats
  }

  dispose(): void {
    if (!this.engine || this.disposing) return
    this.disposing = true
    let firstError: unknown
    let hasError = false
    let childCleanupFailed = false
    const runCleanup = (operation: () => void): void => {
      try {
        operation()
      } catch (error) {
        if (!hasError) {
          firstError = error
          hasError = true
        }
      }
    }
    try {
      for (const stream of [...this.streams]) {
        try {
          stream.dispose()
        } catch (error) {
          childCleanupFailed = true
          if (!hasError) {
            firstError = error
            hasError = true
          }
        }
      }
      if (this.captureDeviceOpen) {
        let result: AudioCaptureOperationResult | undefined
        runCleanup(() => {
          result = this.stopCaptureInternal(this.captureOwner)
        })
        if (result && result.status !== 0) {
          const wasStarted = this.captureStarted
          this.captureDeviceOpen = false
          this.captureStarted = false
          runCleanup(() => this.emitError("stopCapture", result!.status, undefined, result!.cause))
          if (wasStarted) runCleanup(() => void this.emit("captureStopped"))
        }
      }
      if (this.captureStream != null) {
        runCleanup(() => refreshAudioCaptureStreamFinalStats(this.captureStream!))
      }
      if (this.mixerStarted) {
        runCleanup(() => void this.stop())
      }
      this.groups.clear()
      const engine = this.engine
      let engineDestroyed = false
      if (!childCleanupFailed) {
        runCleanup(() => {
          this.lib.destroyAudioEngine(engine)
          engineDestroyed = true
        })
      }
      if (engineDestroyed) {
        this.engine = null
        this.captureStarted = false
        this.captureDeviceOpen = false
        this.captureBufferAvailable = false
        this.captureCapacityFrames = 0
        this.captureOwner = null
        this.captureStream = null
        runCleanup(() => void this.emit("disposed"))
      }
    } finally {
      this.disposing = false
    }
    if (hasError) throw firstError
  }
}

export function setupAudio(options: AudioSetupOptions = {}): Audio {
  return Audio.create(options)
}
