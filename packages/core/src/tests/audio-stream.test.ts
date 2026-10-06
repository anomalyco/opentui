import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { createServer, type Server, type ServerResponse } from "node:http"
import { runInNewContext } from "node:vm"
import { afterEach, expect, test } from "bun:test"
import {
  Audio as PublicAudio,
  AudioStreamError,
  NativeAudioStreamCloseReason,
  createIcyStreamDemuxer,
} from "../index.js"
import { Audio, AudioStream, type AudioStreamErrorContext, type AudioStreamStats } from "../audio.js"
import type {
  AudioEngineLib,
  AudioStream as PublicAudioStream,
  AudioStreamBody,
  AudioStreamBodyOptions,
  AudioStreamConnection,
  AudioStreamConnector,
  AudioStreamContentTypeContext,
  AudioStreamCreateOptions,
  AudioStreamDemuxOutput,
  AudioStreamDemuxer,
  AudioStreamFormat,
  AudioStreamMetadata,
  AudioStreamReconnectOptions,
  AudioStreamUrlOptions,
  NativeAudioStreamStats,
} from "../index.js"
import { NativeAudioStreamState } from "../zig-structs.js"
import { resolveRenderLib } from "../zig.js"

const SAMPLE_RATE = 48_000
const MP3_URL = new URL("./fixtures/audio/tone-750hz-48k-mono-1s.mp3", import.meta.url)
const MP3_HIGH_BITRATE_URL = new URL("./fixtures/audio/tone-750hz-48k-mono-1s-320k.mp3", import.meta.url)
const MP3_5S_URL = new URL("./fixtures/audio/tone-750hz-48k-mono-5s.mp3", import.meta.url)
const MP3_3000_URL = new URL("./fixtures/audio/tone-3000hz-48k-mono-1s.mp3", import.meta.url)
const FLAC_URL = new URL("./fixtures/audio/tone-750hz-48k-mono-1s.flac", import.meta.url)
const audios: Audio[] = []
const servers: Server[] = []

interface TestStreamMetadata {
  readonly title: string
}

function assertPublicAudioStreamApis(
  audio: PublicAudio,
  bodySource: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  urlSource: string | URL,
  connector: AudioStreamConnector<{ readonly station: string }>,
  demuxer: AudioStreamDemuxer<TestStreamMetadata>,
  options: AudioStreamBodyOptions<TestStreamMetadata>,
  urlOptions: AudioStreamUrlOptions,
): void {
  const bodyStream: Promise<PublicAudioStream<TestStreamMetadata>> = audio.playStream(bodySource, {
    ...options,
    format: "mp3",
    demuxer: () => demuxer,
  })
  const sourceStream: Promise<PublicAudioStream<TestStreamMetadata>> = audio.playStreamSource(connector, {
    demuxer: () => demuxer,
    reconnect: {
      maxRetries: 1,
      retry: (_error, context) => (context.maxRetries === 1 ? {} : false),
    },
  })
  const urlStream: Promise<PublicAudioStream<AudioStreamMetadata>> = audio.playStreamUrl(urlSource, urlOptions)
  void bodyStream
  void sourceStream
  void urlStream
  // @ts-expect-error URL sources use playStreamUrl().
  void audio.playStream(urlSource, options)
  // @ts-expect-error Byte sources use playStream().
  void audio.playStreamUrl(bodySource, urlOptions)
  // @ts-expect-error URL options are not valid for byte sources.
  void audio.playStream(bodySource, urlOptions)
  // @ts-expect-error Body demuxers are not configured through playStreamUrl().
  void audio.playStreamUrl(urlSource, options)
  // @ts-expect-error URL request options are not valid for custom connectors.
  void audio.playStreamSource(connector, urlOptions)
  const reconnectOptions: AudioStreamReconnectOptions = { maxRetries: 1 }
  void reconnectOptions
  const format: AudioStreamFormat = "mp3"
  const flacFormat: AudioStreamFormat = "flac"
  const contentTypeContext: AudioStreamContentTypeContext = {
    format,
    contentType: "audio/mpeg",
    status: 200,
    url: "https://example.test/radio",
  }
  void contentTypeContext
  void flacFormat
  const connectorWithRetry: AudioStreamConnector<{ readonly station: string }> = {
    ...connector,
    // @ts-expect-error Retry policy belongs to reconnect options.
    retry: () => ({}),
  }
  void connectorWithRetry
  const legacyReconnectOptions: AudioStreamReconnectOptions = {
    // @ts-expect-error maxAttempts was renamed to maxRetries.
    maxAttempts: 1,
  }
  void legacyReconnectOptions
  // @ts-expect-error WAV is not a supported stream format.
  void audio.playStream(bodySource, { format: "wav" })
  void audio.playStreamUrl(urlSource, { contentTypePolicy: "ignore" })
  void audio.playStreamUrl(urlSource, { contentTypePolicy: "validate" })
  // @ts-expect-error Content-type policy applies only to URL streams.
  void audio.playStream(bodySource, { contentTypePolicy: "ignore" })
  // @ts-expect-error Content-type policy applies only to URL streams.
  void audio.playStreamSource(connector, { contentTypePolicy: "ignore" })
}

function assertPublicReconnectError(stream: PublicAudioStream): void {
  stream.on("reconnecting", ({ error }) => {
    const streamError: AudioStreamError = error
    void streamError
  })
}

function assertPublicNativeAudioStreamTypes(
  lib: AudioEngineLib,
  engine: Parameters<AudioEngineLib["audioCreateStream"]>[0],
  options: AudioStreamCreateOptions,
): NativeAudioStreamStats | null {
  void lib.audioCreateStream(engine, options)
  void lib.audioCloseStream(engine, 1, NativeAudioStreamCloseReason.TransportError)
  // @ts-expect-error Arbitrary numbers are not valid native stream close reasons.
  void lib.audioCloseStream(engine, 1, 99)
  return lib.audioGetStreamStats(engine, 1)
}

function expectAudioStreamError(value: unknown): AudioStreamError {
  expect(value).toBeInstanceOf(AudioStreamError)
  if (!(value instanceof AudioStreamError)) throw new Error("Expected AudioStreamError")
  return value
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function yieldToRuntime(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address == null || typeof address === "string") throw new Error("Test server did not bind a TCP port")
  servers.push(server)
  return `http://127.0.0.1:${address.port}`
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  advance?: () => void,
  timeoutMs: number = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    advance?.()
    if (predicate()) return
    await yieldToRuntime()
  }
  throw new Error(message)
}

function tonePower(samples: Float32Array, frameCount: number, frequency: number): number {
  let real = 0
  let imaginary = 0
  for (let frame = 0; frame < frameCount; frame += 1) {
    const mono = ((samples[frame * 2] ?? 0) + (samples[frame * 2 + 1] ?? 0)) * 0.5
    const phase = (2 * Math.PI * frequency * frame) / SAMPLE_RATE
    real += mono * Math.cos(phase)
    imaginary -= mono * Math.sin(phase)
  }
  return real * real + imaginary * imaginary
}

function hasSignal(samples: Float32Array, threshold: number = 0.005): boolean {
  return samples.some((sample) => Math.abs(sample) > threshold)
}

function channelEnergy(samples: Float32Array, channel: 0 | 1): number {
  let energy = 0
  for (let index = channel; index < samples.length; index += 2) {
    const sample = samples[index] ?? 0
    energy += sample * sample
  }
  return energy
}

function repeatBytes(bytes: Uint8Array, count: number): Uint8Array {
  const repeated = new Uint8Array(bytes.length * count)
  for (let index = 0; index < count; index += 1) repeated.set(bytes, index * bytes.length)
  return repeated
}

function icyMetadataBlock(payload: string | Uint8Array | null): Uint8Array {
  if (payload == null) return new Uint8Array(1)
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload
  const blocks = Math.ceil(bytes.byteLength / 16)
  if (blocks > 255) throw new Error("ICY test metadata exceeds the wire limit")
  const framed = new Uint8Array(1 + blocks * 16)
  framed[0] = blocks
  framed.set(bytes, 1)
  return framed
}

function interleaveIcy(
  audio: Uint8Array,
  interval: number,
  metadata: ReadonlyArray<string | Uint8Array | null> = [],
): Uint8Array {
  const chunks: Uint8Array[] = []
  let outputLength = 0
  let metadataIndex = 0
  for (let offset = 0; offset < audio.byteLength; offset += interval) {
    const end = Math.min(audio.byteLength, offset + interval)
    const audioChunk = audio.subarray(offset, end)
    chunks.push(audioChunk)
    outputLength += audioChunk.byteLength
    if (audioChunk.byteLength === interval) {
      const metadataChunk = icyMetadataBlock(metadata[metadataIndex] ?? null)
      metadataIndex += 1
      chunks.push(metadataChunk)
      outputLength += metadataChunk.byteLength
    }
  }
  const output = new Uint8Array(outputLength)
  let outputOffset = 0
  for (const chunk of chunks) {
    output.set(chunk, outputOffset)
    outputOffset += chunk.byteLength
  }
  return output
}

function latin1(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0))
}

function replaceMethod(target: object, name: string, replacement: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, name)
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value: replacement,
  })
  return () => {
    if (previous) Object.defineProperty(target, name, previous)
    else delete (target as Record<string, unknown>)[name]
  }
}

function prependId3Padding(mp3: Uint8Array, paddingBytes: number): Uint8Array {
  const tagged = new Uint8Array(10 + paddingBytes + mp3.byteLength)
  tagged.set([0x49, 0x44, 0x33, 4, 0, 0], 0)
  tagged[6] = (paddingBytes >> 21) & 0x7f
  tagged[7] = (paddingBytes >> 14) & 0x7f
  tagged[8] = (paddingBytes >> 7) & 0x7f
  tagged[9] = paddingBytes & 0x7f
  tagged.set(mp3, 10 + paddingBytes)
  return tagged
}

async function waitForTapSignal<M>(audio: Audio, stream: AudioStream<M>): Promise<Float32Array> {
  let frames: Float32Array<ArrayBufferLike> = new Float32Array(0)
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    audio.mixFrames(256, 2)
    const tap = audio.readTapFrames(2048, 2)
    if (tap != null && tap.framesRead >= 2048 && tap.frames.some((sample) => Math.abs(sample) > 0.005)) {
      frames = tap.frames
      break
    }
    await yieldToRuntime()
  }
  if (frames.length === 0) {
    const stats = stream.getStats()
    throw new Error(
      `Audio stream did not produce tapped PCM (state=${stats.state}, bytes=${stats.bytesReceived}, decoded=${stats.framesDecoded}, played=${stats.framesPlayed}, buffered=${stats.bufferedFrames})`,
    )
  }
  return frames
}

async function drainStream<M>(audio: Audio, stream: AudioStream<M>): Promise<void> {
  await waitFor(
    () => stream.state === "ended",
    "Audio stream did not reach its ended state",
    () => {
      audio.mixFrames(256, 2)
    },
  )
  await stream.closed
}

afterEach(async () => {
  for (const audio of audios.splice(0)) audio.dispose()
  for (const server of servers.splice(0)) {
    if (server.listening) {
      const closed = once(server, "close")
      server.close()
      server.closeAllConnections?.()
      await closed
    }
  }
})

test("Audio exposes typed stream setup failures through the public API", async () => {
  const server = createServer((_, response) => {
    response.writeHead(404, { Connection: "close" })
    response.end()
  })
  const baseUrl = await listen(server)
  const audio = PublicAudio.create({ autoStart: false })
  audios.push(audio)

  let rejection: unknown
  try {
    await audio.playStreamUrl(`${baseUrl}/missing`)
  } catch (error) {
    rejection = error
  }

  expect(expectAudioStreamError(rejection).context).toEqual({ action: "response", status: 404, attempt: 0 })
})

test("Audio.dispose retains the engine when an owned stream cannot close", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(mp3)
    },
  })
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  audio.on("error", () => {})
  expect(audio.startMixer()).toBe(true)
  const stream = await audio.playStream(source)
  const lib = resolveRenderLib()
  const originalClose = lib.audioCloseStream
  let closeCalls = 0
  const restoreClose = replaceMethod(lib, "audioCloseStream", (...args: Parameters<typeof originalClose>) => {
    closeCalls += 1
    if (closeCalls === 1) throw new Error("injected stream close failure")
    return originalClose.apply(lib, args)
  })
  try {
    expect(() => audio.dispose()).toThrow("injected stream close failure")
    expect(audio.getStats()).not.toBeNull()
    audio.dispose()
    await stream.closed
    expect(audio.getStats()).toBeNull()
    expect(closeCalls).toBe(2)
  } finally {
    restoreClose()
    audio.dispose()
  }
})

test("Audio streams an MP3 before the HTTP response ends and exposes it through the tap", async () => {
  const mp3 = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 8)
  const releaseTail = deferred()
  let responseEnded = false
  const split = Math.floor(mp3.length * 0.75)
  const server = createServer((_, response) => {
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    response.write(mp3.subarray(0, split))
    void releaseTail.promise.then(() => {
      responseEnded = true
      response.end(mp3.subarray(split))
    })
  })
  const baseUrl = await listen(server)

  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  expect(audio.enableTap(4096)).toBe(true)

  const stream = await audio.playStreamUrl(new URL("/radio", baseUrl))
  expect(["buffering", "playing"]).toContain(stream.getStats().state)
  expect(stream.getMetadata()).toBeNull()
  const pcm = await waitForTapSignal(audio, stream)

  expect(responseEnded).toBe(false)
  const playingStats = stream.getStats()
  expect(playingStats.state).toBe("playing")
  expect(playingStats.sampleRate).toBe(SAMPLE_RATE)
  expect(playingStats.channels).toBe(2)
  expect(playingStats.capacityFrames).toBe(SAMPLE_RATE * 2)
  expect(playingStats.bufferedFrames).toBeLessThanOrEqual(playingStats.capacityFrames)
  expect(playingStats.bufferedDurationMs).toBe((playingStats.bufferedFrames * 1000) / playingStats.sampleRate)
  expect(playingStats.framesPlayed).toBeGreaterThan(0n)
  expect(tonePower(pcm, 2048, 750)).toBeGreaterThan(tonePower(pcm, 2048, 3000) * 10)

  releaseTail.resolve()
  await waitFor(() => responseEnded, "Test server did not finish the MP3 response")
  stream.dispose()
  await stream.closed
})

test("Audio streams FLAC before the HTTP response ends", async () => {
  const flac = new Uint8Array(await readFile(FLAC_URL))
  const releaseTail = deferred()
  let responseEnded = false
  const split = Math.floor(flac.length * 0.75)
  const server = createServer((_, response) => {
    response.writeHead(200, { "Content-Type": "audio/flac", Connection: "close" })
    response.write(flac.subarray(0, split))
    void releaseTail.promise.then(() => {
      responseEnded = true
      response.end(flac.subarray(split))
    })
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  expect(audio.enableTap(4096)).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    format: "flac",
    buffer: { capacityMs: 500, startupMs: 25, resumeMs: 25 },
  })
  const pcm = await waitForTapSignal(audio, stream)

  expect(responseEnded).toBe(false)
  expect(stream.format).toBe("flac")
  expect(tonePower(pcm, 2048, 750)).toBeGreaterThan(tonePower(pcm, 2048, 3000) * 10)

  releaseTail.resolve()
  await drainStream(audio, stream)
  expect(stream.getStats().bytesReceived).toBe(BigInt(flac.byteLength))
})

test("Audio strips negotiated ICY metadata and exposes changed metadata without duplicate events", async () => {
  const fixture = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 4)
  const interval = 1024
  const initialAudioLength = interval * 8
  const firstPayload = "StreamTitle='First track';StreamUrl='https://example.test/first';"
  const secondPayload = "StreamTitle='Second; mix';Custom='value';__proto__='safe';"
  let requestMetadataHeader: string | string[] | undefined
  const activeResponse: { current: ServerResponse | null } = { current: null }
  const responseReady = deferred()
  const server = createServer((request, currentResponse) => {
    requestMetadataHeader = request.headers["icy-metadata"]
    currentResponse.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "icy-metaint": interval,
      "icy-name": "Test station",
      "icy-genre": "Test genre",
      Connection: "close",
    })
    currentResponse.write(interleaveIcy(fixture.subarray(0, initialAudioLength), interval, [firstPayload]))
    activeResponse.current = currentResponse
    responseReady.resolve()
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 500, startupMs: 25, resumeMs: 25 },
  })
  await responseReady.promise
  if (activeResponse.current == null) throw new Error("ICY test response was not created")

  expect(requestMetadataHeader).toBe("1")
  expect(stream.getMetadata()).toEqual({
    format: "icy",
    headers: {
      "icy-genre": "Test genre",
      "icy-metaint": interval.toString(),
      "icy-name": "Test station",
    },
    fields: {
      StreamTitle: "First track",
      StreamUrl: "https://example.test/first",
    },
  })
  expect(Object.isFrozen(stream.getMetadata())).toBe(true)
  expect(Object.isFrozen(stream.getMetadata()?.headers)).toBe(true)
  expect(Object.isFrozen(stream.getMetadata()?.fields)).toBe(true)

  const metadataEvents: AudioStreamMetadata[] = []
  stream.on("metadata", (metadata) => {
    if (metadata != null) metadataEvents.push(metadata)
  })
  await waitFor(() => metadataEvents.length === 1, "Initial ICY metadata event was not observable after setup")
  await waitFor(
    () => stream.getStats().bytesReceived === BigInt(initialAudioLength),
    "Initial ICY response bytes were not fully consumed",
  )

  let audioOffset = initialAudioLength
  const writeCycle = async (payload: string | null): Promise<void> => {
    const previousBytes = stream.getStats().bytesReceived
    activeResponse.current!.write(
      interleaveIcy(fixture.subarray(audioOffset, audioOffset + interval), interval, [payload]),
    )
    audioOffset += interval
    await waitFor(
      () => stream.getStats().bytesReceived >= previousBytes + BigInt(interval),
      "ICY test cycle was not consumed",
    )
    await yieldToRuntime()
  }

  await writeCycle(firstPayload)
  await writeCycle(null)
  await writeCycle("not a metadata assignment")
  expect(metadataEvents).toHaveLength(1)

  await writeCycle(secondPayload)
  await waitFor(() => metadataEvents.length === 2, "Changed ICY metadata did not emit an event")
  expect(metadataEvents[1]?.fields.StreamTitle).toBe("Second; mix")
  expect(metadataEvents[1]?.fields.Custom).toBe("value")
  expect(metadataEvents[1]?.fields["__proto__"]).toBe("safe")
  expect(Object.prototype.hasOwnProperty.call(metadataEvents[1]?.fields, "__proto__")).toBe(true)

  await writeCycle("StreamTitle='';")
  await waitFor(() => metadataEvents.length === 3, "An explicit empty ICY title did not emit an event")
  expect(metadataEvents.map((metadata) => metadata.fields.StreamTitle)).toEqual(["First track", "Second; mix", ""])

  activeResponse.current.end(interleaveIcy(fixture.subarray(audioOffset), interval))
  await drainStream(audio, stream)
  expect(stream.getStats().bytesReceived).toBe(BigInt(fixture.byteLength))
  expect(stream.getStats().framesDecoded).toBeGreaterThan(0n)
  expect(stream.getStats().framesPlayed).toBeGreaterThan(0n)
  expect(stream.getMetadata()?.fields).toEqual({ StreamTitle: "" })
})

test("Audio coalesces rapid ICY changes into the latest metadata event", async () => {
  const fixture = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 3)
  const interval = 1024
  const initialAudioLength = interval * 8
  const controllerRef: { current: ReadableStreamDefaultController<Uint8Array> | null } = { current: null }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef.current = controller
        controller.enqueue(interleaveIcy(fixture.subarray(0, initialAudioLength), interval, ["StreamTitle='Initial';"]))
      },
    })
    return Promise.resolve(
      new Response(body, {
        headers: { "Content-Type": "audio/mpeg", "icy-metaint": interval.toString() },
      }),
    )
  }) as unknown as typeof fetch
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  try {
    const stream = await audio.playStreamUrl("https://example.test/radio", {
      buffer: { capacityMs: 500, startupMs: 25, resumeMs: 25 },
    })
    if (controllerRef.current == null) throw new Error("ICY response controller was not created")
    const metadataEvents: AudioStreamMetadata[] = []
    stream.on("metadata", (metadata) => {
      if (metadata != null) metadataEvents.push(metadata)
    })
    await waitFor(() => metadataEvents.length === 1, "Initial metadata event was not emitted")

    controllerRef.current.enqueue(
      interleaveIcy(fixture.subarray(initialAudioLength, initialAudioLength + interval * 2), interval, [
        "StreamTitle='Intermediate';",
        "StreamTitle='Latest';",
      ]),
    )
    await waitFor(() => stream.getMetadata()?.fields.StreamTitle === "Latest", "Latest metadata was not stored")
    await waitFor(() => metadataEvents.length === 2, "Coalesced metadata event was not emitted")
    await sleep(10)
    expect(metadataEvents.map((metadata) => metadata.fields.StreamTitle)).toEqual(["Initial", "Latest"])

    controllerRef.current.enqueue(interleaveIcy(fixture.subarray(initialAudioLength + interval * 2), interval))
    controllerRef.current.close()
    await drainStream(audio, stream)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Audio preserves an explicit ICY negotiation override and exposes response metadata without framing", async () => {
  const fixture = new Uint8Array(await readFile(MP3_URL))
  let requestMetadataHeader: string | string[] | undefined
  let customHeader: string | string[] | undefined
  const server = createServer((request, response) => {
    requestMetadataHeader = request.headers["icy-metadata"]
    customHeader = request.headers["x-audio-test"]
    response.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "icy-name": "Headers only",
      Connection: "close",
    })
    response.end(fixture)
  })
  const baseUrl = await listen(server)
  const headers = new Headers([
    ["Icy-MetaData", "0"],
    ["X-Audio-Test", "preserved"],
  ])
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    request: { headers },
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  await drainStream(audio, stream)

  expect(requestMetadataHeader).toBe("0")
  expect(customHeader).toBe("preserved")
  expect(stream.getStats().bytesReceived).toBe(BigInt(fixture.byteLength))
  expect(stream.getMetadata()).toEqual({
    format: "icy",
    headers: { "icy-name": "Headers only" },
    fields: {},
  })
})

test("Audio decodes ICY metadata with the documented default and an explicit encoding", async () => {
  const fixture = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 2)
  const scenarios = [
    {
      payload: latin1("StreamTitle='Price \x80';"),
      options: {},
      expected: "Price €",
    },
    {
      payload: new TextEncoder().encode("StreamTitle='日本語 UTF-8';"),
      options: { metadataEncoding: "utf-8" },
      expected: "日本語 UTF-8",
    },
  ]

  for (const scenario of scenarios) {
    const server = createServer((_, response) => {
      response.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "icy-metaint": "1024",
        Connection: "close",
      })
      response.end(interleaveIcy(fixture, 1024, [scenario.payload]))
    })
    const baseUrl = await listen(server)
    const audio = Audio.create({ autoStart: false })
    audios.push(audio)
    expect(audio.startMixer()).toBe(true)

    const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
      ...scenario.options,
      buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    })
    await drainStream(audio, stream)
    expect(stream.getMetadata()?.fields.StreamTitle).toBe(scenario.expected)
    expect(stream.getStats().bytesReceived).toBe(BigInt(fixture.byteLength))
    audio.dispose()
  }
})

test("Audio handles maximum-size ICY metadata across one-byte response chunks", async () => {
  const fixture = new Uint8Array(await readFile(MP3_URL))
  const payload = new Uint8Array(255 * 16)
  payload.set(new TextEncoder().encode("StreamTitle='Fragmented metadata';"))
  const interval = 1024
  const wireBytes = interleaveIcy(fixture, interval, [payload])
  const originalFetch = globalThis.fetch
  const observedRequest: { metadataHeader: string | null } = { metadataHeader: null }
  globalThis.fetch = ((_input, init) => {
    observedRequest.metadataHeader = new Headers(init?.headers).get("icy-metadata")
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(wireBytes.subarray(0, interval))
        const metadataEnd = interval + 1 + payload.byteLength
        for (let offset = interval; offset < metadataEnd; offset += 1) {
          controller.enqueue(wireBytes.subarray(offset, offset + 1))
        }
        for (let offset = metadataEnd; offset < wireBytes.byteLength; offset += 13) {
          controller.enqueue(wireBytes.subarray(offset, Math.min(wireBytes.byteLength, offset + 13)))
        }
        controller.close()
      },
    })
    return Promise.resolve(
      new Response(body, {
        headers: { "Content-Type": "audio/mpeg", "icy-metaint": "001024" },
      }),
    )
  }) as typeof fetch
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  try {
    const stream = await audio.playStreamUrl("https://example.test/radio", {
      buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    })
    await drainStream(audio, stream)
    expect(observedRequest.metadataHeader).toBe("1")
    expect(stream.getMetadata()?.fields.StreamTitle).toBe("Fragmented metadata")
    expect(stream.getStats().bytesReceived).toBe(BigInt(fixture.byteLength))
    expect(stream.getStats().framesPlayed).toBeGreaterThan(0n)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Audio rejects ambiguous ICY intervals before allocating a native stream", async () => {
  const fixture = new Uint8Array(await readFile(MP3_URL))
  for (const interval of ["-1", "1.5", "invalid", "1, 2", "9007199254740992"]) {
    const server = createServer((_, response) => {
      response.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "icy-metaint": interval,
        Connection: "close",
      })
      response.end(fixture)
    })
    const baseUrl = await listen(server)
    const audio = Audio.create({ autoStart: false })
    audios.push(audio)

    let rejection: unknown
    try {
      await audio.playStreamUrl(`${baseUrl}/radio`)
    } catch (error) {
      rejection = error
    }
    const streamError = expectAudioStreamError(rejection)
    expect(streamError.message).toContain("Invalid icy-metaint")
    expect(streamError.context).toEqual({
      action: "response",
      status: 200,
    })
    expect(audio.getStats()?.voicesActive).toBe(0)
    audio.dispose()
  }
})

test("Audio selects a fresh ICY demuxer after reconnecting from a partial metadata block", async () => {
  const firstFixture = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 12)
  const replacementFixture = repeatBytes(new Uint8Array(await readFile(MP3_3000_URL)), 12)
  const interrupt = deferred()
  const releaseReplacementBody = deferred()
  const keepReplacementOpen = deferred()
  const requestMetadataHeaders: Array<string | string[] | undefined> = []
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    requestMetadataHeaders.push(request.headers["icy-metadata"])
    if (requests === 1) {
      response.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "icy-metaint": "1024",
        "icy-name": "First station",
        Connection: "close",
      })
      response.write(interleaveIcy(firstFixture.subarray(0, 8192), 1024, ["StreamTitle='First track';"]))
      void interrupt.promise.then(() => {
        response.write(firstFixture.subarray(8192, 8192 + 1024))
        response.write(Uint8Array.of(2))
        response.end("partial")
      })
      return
    }

    response.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "icy-metaint": "777",
      "icy-name": "Replacement station",
      Connection: "close",
    })
    response.flushHeaders()
    void releaseReplacementBody.promise.then(() => {
      response.write(interleaveIcy(replacementFixture.subarray(0, 777 * 12), 777, ["StreamTitle='Replacement track';"]))
      void keepReplacementOpen.promise.then(() => response.end())
    })
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 500, startupMs: 25, resumeMs: 25 },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
  })
  stream.on("error", () => {})
  expect(stream.getMetadata()?.fields.StreamTitle).toBe("First track")

  let reconnecting = false
  stream.on("reconnecting", () => {
    reconnecting = true
  })
  interrupt.resolve()
  await waitFor(
    () =>
      reconnecting &&
      requests === 2 &&
      stream.getMetadata()?.headers["icy-metaint"] === "777" &&
      Object.keys(stream.getMetadata()?.fields ?? {}).length === 0,
    "Replacement ICY response did not clear the previous response fields",
  )
  releaseReplacementBody.resolve()
  await waitFor(
    () =>
      stream.getMetadata()?.headers["icy-metaint"] === "777" &&
      stream.getMetadata()?.fields.StreamTitle === "Replacement track",
    "Audio stream did not adopt replacement ICY framing and metadata",
  )
  expect(requestMetadataHeaders).toEqual(["1", "1"])
  expect(stream.getStats().reconnectAttempts).toBe(1)
  expect(stream.getStats().framesDecoded).toBeGreaterThan(0n)
  expect(stream.getMetadata()).toEqual({
    format: "icy",
    headers: {
      "icy-metaint": "777",
      "icy-name": "Replacement station",
    },
    fields: { StreamTitle: "Replacement track" },
  })

  stream.dispose()
  keepReplacementOpen.resolve()
  await stream.closed
})

test("Audio clears ICY metadata when a replacement response is plain MP3", async () => {
  const fixture = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 12)
  const interrupt = deferred()
  const keepReplacementOpen = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    if (requests === 1) {
      response.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "icy-metaint": "1024",
        Connection: "close",
      })
      response.write(interleaveIcy(fixture.subarray(0, 8192), 1024, ["StreamTitle='ICY track';"]))
      void interrupt.promise.then(() => {
        response.end(fixture.subarray(8192, 8192 + 1024))
      })
      return
    }
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    response.write(fixture)
    void keepReplacementOpen.promise.then(() => response.end())
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 500, startupMs: 25, resumeMs: 25 },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
  })
  stream.on("error", () => {})
  expect(stream.getMetadata()?.fields.StreamTitle).toBe("ICY track")

  const metadataEvents: Array<AudioStreamMetadata | null> = []
  stream.on("metadata", (metadata) => metadataEvents.push(metadata))
  interrupt.resolve()
  await waitFor(
    () => requests === 2 && stream.getMetadata() == null && stream.getStats().reconnectAttempts === 1,
    "Plain replacement response did not clear ICY metadata",
  )
  await waitFor(() => metadataEvents.includes(null), "Metadata clear event was not emitted")

  stream.dispose()
  keepReplacementOpen.resolve()
  await stream.closed
})

test("Audio does not reserve a native voice before a URL response is valid", async () => {
  const fixture = new Uint8Array(await readFile(MP3_URL))
  const requestStarted = deferred()
  const releaseResponse = deferred()
  const server = createServer((_, response) => {
    requestStarted.resolve()
    void releaseResponse.promise.then(() => {
      response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
      response.end(fixture)
    })
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const opening = audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  await requestStarted.promise
  expect(audio.getStats()?.voicesActive).toBe(0)

  releaseResponse.resolve()
  const stream = await opening
  await drainStream(audio, stream)
})

test("Audio accepts an async iterable and drains it to completion", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield new Uint8Array(0)
    for (let offset = 0; offset < mp3.length; offset += 97) {
      yield mp3.subarray(offset, Math.min(mp3.length, offset + 97))
    }
  }

  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const group = audio.group("radio")
  expect(group).not.toBeNull()
  const stream = await audio.playStream(chunks(), {
    groupId: group ?? 0,
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  let endedEvents = 0
  stream.on("ended", () => {
    endedEvents += 1
  })

  expect(stream.setVolume(0.6)).toBe(true)
  expect(stream.setPan(-0.25)).toBe(true)
  expect(stream.setGroup(group ?? 0)).toBe(true)
  stream.on("error", () => {})
  expect(stream.setGroup(0xffffffff)).toBe(false)
  expect(stream.state).not.toBe("errored")
  await drainStream(audio, stream)
  await waitFor(() => endedEvents === 1, "Audio stream did not emit ended")
  await yieldToRuntime()
  expect(endedEvents).toBe(1)

  const stats = stream.getStats()
  expect(stats.state).toBe("ended")
  expect(stats.sampleRate).toBe(SAMPLE_RATE)
  expect(stats.channels).toBe(2)
  expect(stats.capacityFrames).toBe(SAMPLE_RATE / 4)
  expect(stats.bufferedFrames).toBe(0)
  expect(stats.bufferedDurationMs).toBe(0)
  expect(stats.bytesReceived).toBe(BigInt(mp3.length))
  expect(stats.framesDecoded).toBeGreaterThan(0n)
  expect(stats.framesPlayed).toBeGreaterThan(0n)
  expect(stats.reconnectAttempts).toBe(0)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio accepts fragmented ReadableStream input and counts only supplied MP3 bytes", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(0))
      controller.enqueue(mp3.subarray(0, 1))
      for (let offset = 1; offset < mp3.length; offset += 97) {
        controller.enqueue(mp3.subarray(offset, Math.min(mp3.length, offset + 97)))
      }
      controller.close()
    },
  })
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStream(source, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  await drainStream(audio, stream)

  const stats = stream.getStats()
  expect(stats.bytesReceived).toBe(BigInt(mp3.length))
  expect(stats.framesDecoded).toBeGreaterThan(0n)
  expect(stats.framesPlayed).toBeGreaterThan(0n)
  expect(stats.reconnectAttempts).toBe(0)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio does not leave readiness polling active after stream setup", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_HIGH_BITRATE_URL))
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(mp3)
    },
  })
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const stream = await audio.playStream(source, {
    buffer: { capacityMs: 2000, startupMs: 25, resumeMs: 25 },
  })

  const originalSetTimeout = globalThis.setTimeout
  let pollTimers = 0
  globalThis.setTimeout = ((callback: TimerHandler, delayMs?: number, ...args: unknown[]) => {
    if (delayMs === 5) pollTimers += 1
    return originalSetTimeout(callback, delayMs, ...args)
  }) as typeof setTimeout
  try {
    await sleep(25)
    expect(pollTimers).toBe(0)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    stream.dispose()
    await stream.closed
  }
})

test("Audio keeps playing decoded buffered frames while reconnecting an interrupted response", async () => {
  const fixture = new Uint8Array(await readFile(MP3_URL))
  const replacementFixture = new Uint8Array(await readFile(MP3_3000_URL))
  const mp3 = repeatBytes(fixture, 8)
  const replacementMp3 = repeatBytes(replacementFixture, 8)
  const interruptResponse = deferred()
  const keepSecondResponseOpen = deferred()
  let requests = 0
  const requestHeaders: Array<string | string[] | undefined> = []
  const server = createServer((request, response) => {
    requests += 1
    requestHeaders.push(request.headers["x-audio-test"])
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    if (requests > 1) {
      response.write(replacementMp3)
      void keepSecondResponseOpen.promise.then(() => response.end())
      return
    }
    response.write(mp3)
    void interruptResponse.promise.then(() => response.destroy())
  })
  const baseUrl = await listen(server)

  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const mutedGroup = audio.group("reconnect-muted")
  if (mutedGroup == null) throw new Error("Could not create reconnect test group")
  expect(audio.setGroupVolume(mutedGroup, 0)).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 2000, startupMs: 200, resumeMs: 200 },
    reconnect: { maxRetries: 1, initialDelayMs: 100, maxDelayMs: 100 },
    request: { headers: { "x-audio-test": "reconnect" } },
  })
  stream.on("error", () => {})

  try {
    await waitFor(
      () => stream.getStats().bufferedDurationMs >= 1000,
      "Audio stream did not buffer enough decoded PCM before interruption",
    )

    let heardBeforeInterruption = false
    await waitFor(
      () => heardBeforeInterruption,
      "Audio stream did not produce audible PCM before interruption",
      () => {
        const mixed = audio.mixFrames(256, 2)
        heardBeforeInterruption = mixed?.some((sample) => Math.abs(sample) > 0.005) ?? false
      },
    )
    await waitFor(
      () => stream.getStats().bufferedDurationMs >= 1000,
      "Audio stream did not retain enough decoded PCM before interruption",
    )

    const silentSound = audio.loadSound(fixture)
    expect(silentSound).not.toBeNull()
    if (silentSound == null) return
    for (let voice = 0; voice < 31; voice += 1) {
      expect(audio.play(silentSound, { loop: true, volume: 0 })).not.toBeNull()
    }
    expect(audio.getStats()?.voicesActive).toBe(32)

    const reconnectEvent: { value?: { attempt: number; delayMs: number; maxRetries: number } } = {}
    let reconnectGroupResult: boolean | undefined
    stream.on("reconnecting", ({ attempt, delayMs, maxRetries }) => {
      reconnectEvent.value = { attempt, delayMs, maxRetries }
      reconnectGroupResult = stream.setGroup(0xffffffff)
    })
    interruptResponse.resolve()
    await waitFor(
      () => reconnectEvent.value != null,
      "Audio stream did not enter reconnecting state after interruption",
    )
    expect(reconnectEvent.value).toEqual({ attempt: 1, delayMs: 100, maxRetries: 1 })
    expect(reconnectGroupResult).toBe(false)

    const reconnectStats = stream.getStats()
    let heardBufferedAudio = false
    for (let block = 0; block < 20; block += 1) {
      const mixed = audio.mixFrames(256, 2)
      if (mixed?.some((sample) => Math.abs(sample) > 0.005)) heardBufferedAudio = true
      await yieldToRuntime()
    }

    expect(heardBufferedAudio).toBe(true)
    expect(stream.getStats().framesPlayed).toBeGreaterThan(reconnectStats.framesPlayed)
    expect(stream.setVolume(1)).toBe(true)
    expect(stream.setPan(-1)).toBe(true)
    expect(stream.setGroup(mutedGroup)).toBe(true)

    await waitFor(
      () => {
        const stats = stream.getStats()
        return (
          requests === 2 &&
          stats.bytesReceived > reconnectStats.bytesReceived &&
          stats.framesDecoded > reconnectStats.framesDecoded
        )
      },
      "Audio stream did not resume decoding after reconnecting",
      () => {
        audio.mixFrames(256, 2)
      },
    )
    expect(audio.getStats()?.voicesActive).toBe(32)
    expect(stream.getStats().reconnectAttempts).toBe(1)

    const framesBeforeMutedGroup = stream.getStats().framesPlayed
    let heardMutedGroup = false
    for (let block = 0; block < 10; block += 1) {
      heardMutedGroup = heardMutedGroup || hasSignal(audio.mixFrames(2048, 2) ?? new Float32Array())
    }
    expect(heardMutedGroup).toBe(false)
    expect(stream.getStats().framesPlayed).toBeGreaterThan(framesBeforeMutedGroup)
    expect(stream.setGroup(0)).toBe(true)

    let replacementOutput: Float32Array | null = null
    await waitFor(
      () =>
        replacementOutput != null &&
        hasSignal(replacementOutput) &&
        tonePower(replacementOutput, 2048, 3000) > tonePower(replacementOutput, 2048, 750) * 10,
      "Audio stream did not play replacement response PCM",
      () => {
        replacementOutput = audio.mixFrames(2048, 2)
      },
    )
    if (replacementOutput == null) return
    expect(channelEnergy(replacementOutput, 0)).toBeGreaterThan(channelEnergy(replacementOutput, 1) * 4)

    expect(stream.setVolume(0)).toBe(true)
    const framesBeforeMute = stream.getStats().framesPlayed
    let mutedReplacement: Float32Array | null = null
    await waitFor(
      () => mutedReplacement != null && !hasSignal(mutedReplacement),
      "Audio stream replacement did not apply the reconnect-time volume control",
      () => {
        mutedReplacement = audio.mixFrames(2048, 2)
      },
    )
    expect(stream.getStats().framesPlayed).toBeGreaterThan(framesBeforeMute)
    expect(requestHeaders).toEqual(["reconnect", "reconnect"])
  } finally {
    keepSecondResponseOpen.resolve()
    stream.dispose()
    await stream.closed
  }
})

test("Audio preserves the initial startup threshold when reconnecting before playback", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_HIGH_BITRATE_URL))
  const interruptResponse = deferred()
  const releaseReplacement = deferred()
  const releaseReplacementRemainder = deferred()
  const keepReplacementOpen = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    if (requests === 1) {
      response.write(mp3)
      void interruptResponse.promise.then(() => response.destroy())
      return
    }
    void releaseReplacement.promise.then(() => {
      const initialReplacementBytes = 2048
      response.write(mp3.subarray(0, initialReplacementBytes))
      void releaseReplacementRemainder.promise.then(() => {
        response.write(mp3.subarray(initialReplacementBytes))
        void keepReplacementOpen.promise.then(() => response.end())
      })
    })
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 2000, startupMs: 1200, resumeMs: 100 },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
  })
  stream.on("error", () => {})
  try {
    await waitFor(
      () => stream.getStats().bufferedDurationMs >= 500,
      "Audio stream did not buffer below its startup threshold",
    )
    const beforeReconnect = stream.getStats()
    expect(beforeReconnect.state).toBe("buffering")
    expect(beforeReconnect.framesPlayed).toBe(0n)

    let reconnecting = false
    stream.on("reconnecting", () => {
      reconnecting = true
    })
    interruptResponse.resolve()
    await waitFor(() => reconnecting && requests === 2, "Audio stream did not enter reconnecting state")

    let heardAudio = false
    for (let block = 0; block < 10; block += 1) {
      heardAudio = heardAudio || hasSignal(audio.mixFrames(2048, 2) ?? new Float32Array())
    }
    expect(heardAudio).toBe(false)
    expect(stream.getStats().framesPlayed).toBe(beforeReconnect.framesPlayed)

    releaseReplacement.resolve()
    await waitFor(() => {
      const stats = stream.getStats()
      return stats.state === "buffering" && stats.bufferedDurationMs > 500 && stats.bufferedDurationMs < 1200
    }, "Replacement decoder did not become ready below the startup threshold")
    for (let block = 0; block < 10; block += 1) {
      heardAudio = heardAudio || hasSignal(audio.mixFrames(2048, 2) ?? new Float32Array())
    }
    expect(heardAudio).toBe(false)
    expect(stream.getStats().framesPlayed).toBe(beforeReconnect.framesPlayed)

    releaseReplacementRemainder.resolve()
    await waitFor(
      () => stream.getStats().bufferedDurationMs >= 1200,
      "Replacement stream did not reach the retained startup threshold",
    )
    await waitFor(
      () => heardAudio,
      "Replacement stream did not start after reaching the startup threshold",
      () => {
        heardAudio = hasSignal(audio.mixFrames(2048, 2) ?? new Float32Array())
      },
    )
    expect(stream.getStats().framesPlayed).toBeGreaterThan(beforeReconnect.framesPlayed)
  } finally {
    releaseReplacement.resolve()
    releaseReplacementRemainder.resolve()
    keepReplacementOpen.resolve()
    stream.dispose()
    await stream.closed
  }
})

test("Audio disposes a buffered stream while reconnecting", async () => {
  const mp3 = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 8)
  const interruptResponse = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    response.write(mp3)
    void interruptResponse.promise.then(() => response.destroy())
  })
  const baseUrl = await listen(server)

  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const abortController = new AbortController()

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    signal: abortController.signal,
    buffer: { capacityMs: 1000, startupMs: 100, resumeMs: 100 },
    reconnect: { maxRetries: 1, initialDelayMs: 1000, maxDelayMs: 1000 },
  })
  stream.on("error", () => {})
  await waitFor(
    () => stream.getStats().bufferedDurationMs >= 500,
    "Audio stream did not buffer enough decoded PCM before interruption",
  )

  let observedReconnect = false
  stream.on("reconnecting", () => {
    observedReconnect = true
    abortController.abort()
  })
  interruptResponse.resolve()
  await stream.closed

  expect(observedReconnect).toBe(true)
  expect(stream.state).toBe("disposed")
  expect(audio.getStats()?.voicesActive).toBe(0)
  expect(requests).toBe(1)
})

test("Audio drains clean EOF before reconnecting", async () => {
  const fixture = new Uint8Array(await readFile(MP3_URL))
  const mp3 = repeatBytes(fixture, 6)
  const finishFirstResponse = deferred()
  const keepSecondResponseOpen = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    if (requests === 1) {
      response.write(mp3)
      void finishFirstResponse.promise.then(() => response.end())
      return
    }
    response.write(mp3)
    void keepSecondResponseOpen.promise.then(() => response.end())
  })
  const baseUrl = await listen(server)

  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: { initialDelayMs: 0, maxDelayMs: 0, retryOnEnd: true },
  })
  stream.on("error", () => {})
  await waitFor(() => stream.getStats().bufferedFrames > 0, "Audio stream did not buffer its first response")

  const silentSound = audio.loadSound(fixture)
  expect(silentSound).not.toBeNull()
  if (silentSound == null) return
  for (let voice = 0; voice < 31; voice += 1) {
    expect(audio.play(silentSound, { loop: true, volume: 0 })).not.toBeNull()
  }
  expect(audio.getStats()?.voicesActive).toBe(32)
  expect(stream.setVolume(0.6)).toBe(true)
  expect(stream.setPan(0.2)).toBe(true)

  const reconnectStats: { value?: AudioStreamStats } = {}
  stream.on("reconnecting", () => {
    reconnectStats.value = stream.getStats()
  })
  finishFirstResponse.resolve()
  await waitFor(
    () => requests === 2 && reconnectStats.value != null,
    "Audio stream did not reconnect after draining clean EOF",
    () => audio.mixFrames(256, 2),
  )
  const statsAtReconnect = reconnectStats.value
  if (statsAtReconnect == null) throw new Error("Audio stream reconnect stats were unavailable")
  await waitFor(
    () => {
      const stats = stream.getStats()
      return (
        stats.bytesReceived > statsAtReconnect.bytesReceived &&
        stats.framesDecoded > statsAtReconnect.framesDecoded &&
        stats.framesPlayed > statsAtReconnect.framesPlayed
      )
    },
    "Audio stream did not resume decoding after clean EOF",
    () => audio.mixFrames(256, 2),
  )

  expect(stream.getStats().framesPlayed).toBeGreaterThan(statsAtReconnect.framesPlayed)
  expect(stream.getStats().reconnectAttempts).toBe(1)
  expect(audio.getStats()?.voicesActive).toBe(32)
  stream.dispose()
  keepSecondResponseOpen.resolve()
  await stream.closed
})

test("A short clean MP3 can finish setup before retryOnEnd reconnects", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const keepSecondResponseOpen = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    if (requests === 1) {
      response.end(mp3.subarray(0, 1000))
      return
    }
    response.write(repeatBytes(mp3, 6))
    void keepSecondResponseOpen.promise.then(() => response.end())
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0, retryOnEnd: true },
  })
  stream.on("error", () => {})
  await waitFor(
    () => requests === 2 && stream.state !== "reconnecting",
    "Short MP3 response did not complete setup and reconnect",
    () => audio.mixFrames(256, 2),
  )

  expect(stream.state).not.toBe("errored")
  expect(stream.getStats().reconnectAttempts).toBe(1)
  stream.dispose()
  keepSecondResponseOpen.resolve()
  await stream.closed
})

test("Audio rejects unsupported stream buffer capacity before consuming the source", async () => {
  const audio = Audio.create({ autoStart: false, sampleRate: 1000 })
  audios.push(audio)

  let sourceConsumed = false
  async function* source(): AsyncGenerator<Uint8Array> {
    sourceConsumed = true
  }

  let rejection: unknown
  try {
    await audio.playStream(source(), {
      buffer: {
        capacityMs: 268_435_453,
        startupMs: 1,
        resumeMs: 1,
      },
    })
  } catch (error) {
    rejection = error
  }

  expect(expectAudioStreamError(rejection).context).toEqual({ action: "create", status: -1 })
  expect(sourceConsumed).toBe(false)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio validates the stream group before consuming the source", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)

  let sourceConsumed = false
  async function* source(): AsyncGenerator<Uint8Array> {
    sourceConsumed = true
  }

  let rejection: unknown
  try {
    await audio.playStream(source(), {
      groupId: 0xffffffff,
      buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    })
  } catch (error) {
    rejection = error
  }

  expect(expectAudioStreamError(rejection).context).toEqual({ action: "create", status: -1 })
  expect(sourceConsumed).toBe(false)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio rejects a fractional stream group before consuming the source", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let sourceConsumed = false
  async function* source(): AsyncGenerator<Uint8Array> {
    sourceConsumed = true
  }

  let rejection: unknown
  try {
    await audio.playStream(source(), { groupId: 1.5 })
  } catch (error) {
    rejection = error
  }

  expect(expectAudioStreamError(rejection).context).toEqual({ action: "create", status: -1 })
  expect(sourceConsumed).toBe(false)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio streams share the existing 32 active voice slots", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const sound = audio.loadSound(mp3)
  expect(sound).not.toBeNull()
  if (sound == null) return

  for (let index = 0; index < 32; index += 1) {
    expect(audio.play(sound, { loop: true })).not.toBeNull()
  }
  expect(audio.getStats()?.voicesActive).toBe(32)

  let sourceConsumed = false
  async function* source(): AsyncGenerator<Uint8Array> {
    sourceConsumed = true
  }

  let rejection: unknown
  try {
    await audio.playStream(source(), {
      buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    })
  } catch (error) {
    rejection = error
  }

  expect(expectAudioStreamError(rejection).context).toEqual({ action: "create", status: -2 })
  expect(sourceConsumed).toBe(false)
  expect(audio.getStats()?.voicesActive).toBe(32)

  expect(audio.unloadSound(sound)).toBe(true)
  expect(audio.getStats()?.voicesActive).toBe(0)
  expect(audio.startMixer()).toBe(true)
  async function* recoveredSource(): AsyncGenerator<Uint8Array> {
    yield mp3
  }
  const recoveredStream = await audio.playStream(recoveredSource(), {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  await drainStream(audio, recoveredStream)
  expect(recoveredStream.getStats().framesPlayed).toBeGreaterThan(0n)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio rejects an invalid MP3 during decoder setup", async () => {
  async function* invalidMp3(): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode("not an mp3 stream")
  }
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  await expect(audio.playStream(invalidMp3())).rejects.toThrow()
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio enforces the default decoder probe limit and accepts a configured override", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const taggedMp3 = prependId3Padding(mp3, 1024 * 1024)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  let defaultRejection: unknown
  try {
    await audio.playStream(
      (async function* () {
        yield taggedMp3
      })(),
    )
  } catch (error) {
    defaultRejection = error
  }
  expect(expectAudioStreamError(defaultRejection).context).toEqual({
    action: "decoder",
    errorCode: -3,
  })
  expect(audio.getStats()?.voicesActive).toBe(0)

  const stream = await audio.playStream(
    (async function* () {
      yield taggedMp3
    })(),
    { maxProbeBytes: taggedMp3.byteLength },
  )
  let heardAudio = false
  await waitFor(
    () => stream.getStats().state === "ended",
    "Tagged MP3 did not finish playback",
    () => {
      const mixed = audio.mixFrames(256, 2)
      heardAudio = heardAudio || hasSignal(mixed ?? new Float32Array())
    },
  )
  await stream.closed
  expect(heardAudio).toBe(true)
  expect(stream.getStats().framesPlayed).toBeGreaterThan(0n)
})

test("Audio reports a byte-source failure after stream setup", async () => {
  const mp3 = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 6)
  const failSource = deferred()
  let sourceReturned = false
  let pulls = 0
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          pulls += 1
          if (pulls === 1) return { done: false as const, value: mp3 }
          await failSource.promise
          throw new Error("test source failure")
        },
        async return() {
          sourceReturned = true
          return { done: true as const, value: undefined }
        },
      }
    },
  }
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStream(source, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  const streamErrors: Error[] = []
  stream.on("error", (error) => {
    streamErrors.push(error)
  })
  failSource.resolve()
  await waitFor(
    () => stream.state === "errored",
    "Audio stream did not enter its errored state",
    () => audio.mixFrames(256, 2),
  )
  await stream.closed
  await waitFor(() => streamErrors.length === 1, "Audio stream did not emit its source failure")

  expect(stream.state).toBe("errored")
  expect(streamErrors[0]?.message).toContain("source failed")
  expect(sourceReturned).toBe(true)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Source failure cleanup cannot overwrite reentrant Audio disposal", async () => {
  const mp3 = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 6)
  const failSource = deferred()
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  let pulls = 0
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          pulls += 1
          if (pulls === 1) return { done: false as const, value: mp3 }
          await failSource.promise
          throw new Error("test source failure")
        },
        async return() {
          audio.dispose()
          return { done: true as const, value: undefined }
        },
      }
    },
  }

  const stream = await audio.playStream(source, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  stream.on("error", () => {})
  failSource.resolve()
  await stream.closed

  expect(stream.state).toBe("disposed")
})

test("Audio ends cleanly when retryOnEnd has no retry budget", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        info: undefined,
        body: (async function* () {
          yield mp3
        })(),
      }
    },
  }

  const stream = await audio.playStreamSource(connector, {
    format: "mp3",
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: { maxRetries: 0, retryOnEnd: true },
  })
  let errors = 0
  stream.on("error", () => {
    errors += 1
  })
  await drainStream(audio, stream)
  expect(stream.state).toBe("ended")
  expect(errors).toBe(0)
  expect(stream.getStats().reconnectAttempts).toBe(0)
})

test("Audio stream setup remains abortable while a source emits empty chunks", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)

  const abortController = new AbortController()
  const maximumPullsBeforeAbort = 100_000
  let pulls = 0
  async function* source(): AsyncGenerator<Uint8Array> {
    while (pulls < maximumPullsBeforeAbort) {
      pulls += 1
      yield new Uint8Array(0)
    }
    await new Promise<void>(() => {})
  }

  const setup = audio.playStream(source(), { signal: abortController.signal })
  setTimeout(() => abortController.abort(), 0)

  let rejection: unknown
  try {
    await setup
  } catch (error) {
    rejection = error
  }

  expect((rejection as Error)?.name).toBe("AbortError")
  expect(pulls).toBeLessThan(maximumPullsBeforeAbort)
})

test("Disposing an audio stream cancels its byte source and releases its voice", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  let cancelled = false
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(mp3.subarray(0, Math.floor(mp3.length * 0.75)))
    },
    cancel() {
      cancelled = true
    },
  })
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStream(source, {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
  })
  let observedDisposed = false
  stream.on("disposed", () => {
    observedDisposed = true
  })
  stream.dispose()
  await stream.closed
  await waitFor(() => observedDisposed, "Audio stream did not emit disposed")

  expect(cancelled).toBe(true)
  expect(stream.state).toBe("disposed")
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Stream teardown tolerates source cancellation disposing the owning Audio", async () => {
  const mp3 = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 6)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  let activeVoicesAtCancel: number | undefined
  let audioDisposed = false
  audio.on("disposed", () => {
    audioDisposed = true
  })
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(mp3)
    },
    cancel() {
      activeVoicesAtCancel = audio.getStats()?.voicesActive
      audio.dispose()
    },
  })

  const stream = await audio.playStream(source, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  stream.dispose()
  await stream.closed

  expect(activeVoicesAtCancel).toBe(1)
  expect(audioDisposed).toBe(true)
  expect(stream.state).toBe("disposed")
  expect(stream.getStats().bufferedFrames).toBe(0)
})

test("Disposal settles even when a byte source does not finish cancelling", async () => {
  const mp3 = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 6)
  const never = new Promise<void>(() => {})
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(mp3)
    },
    cancel() {
      return never
    },
  })
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStream(source, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  stream.dispose()
  await Promise.race([
    stream.closed,
    sleep(1000).then(() => {
      throw new Error("Audio stream disposal waited indefinitely for source cancellation")
    }),
  ])

  expect(stream.state).toBe("disposed")
  expect(stream.getStats().bufferedFrames).toBe(0)
})

test("Audio honors startup and resume thresholds and counts underruns once per starvation", async () => {
  const fixture = new Uint8Array(await readFile(MP3_URL))
  const startupFixture = new Uint8Array(await readFile(MP3_HIGH_BITRATE_URL))
  const longFixture = new Uint8Array(await readFile(MP3_5S_URL))
  let sourceController!: ReadableStreamDefaultController<Uint8Array>
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller
      controller.enqueue(startupFixture)
    },
  })
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStream(source, {
    buffer: { capacityMs: 3000, startupMs: 1200, resumeMs: 500 },
  })
  await waitFor(
    () => stream.getStats().bufferedDurationMs >= 500,
    "Audio stream did not decode the initial buffering payload",
  )

  const beforeStartup = stream.getStats()
  for (let block = 0; block < 8; block += 1) {
    const mixed = audio.mixFrames(2048, 2)
    expect(mixed).not.toBeNull()
    expect(hasSignal(mixed ?? new Float32Array())).toBe(false)
  }
  expect(stream.getStats().state).toBe("buffering")
  expect(stream.getStats().framesPlayed).toBe(beforeStartup.framesPlayed)
  expect(stream.getStats().underruns).toBe(0)

  sourceController.enqueue(longFixture)
  let heardStartup = false
  await waitFor(
    () => stream.getStats().state === "playing" && heardStartup,
    "Audio stream did not begin after crossing the startup threshold",
    () => {
      const mixed = audio.mixFrames(2048, 2)
      heardStartup = heardStartup || (mixed != null && hasSignal(mixed))
    },
  )

  await waitFor(
    () => stream.getStats().state === "buffering" && stream.getStats().underruns === 1,
    "Audio stream did not report its first underrun",
    () => {
      audio.mixFrames(2048, 2)
    },
    4000,
  )
  const firstUnderrunFrames = stream.getStats().framesPlayed
  for (let block = 0; block < 8; block += 1) {
    const mixed = audio.mixFrames(2048, 2)
    expect(mixed).not.toBeNull()
    expect(hasSignal(mixed ?? new Float32Array())).toBe(false)
  }
  expect(stream.getStats().framesPlayed).toBe(firstUnderrunFrames)
  expect(stream.getStats().underruns).toBe(1)

  sourceController.enqueue(fixture)
  let heardResume = false
  await waitFor(
    () => stream.getStats().state === "playing" && heardResume,
    "Audio stream did not resume at the smaller resume threshold",
    () => {
      const mixed = audio.mixFrames(2048, 2)
      heardResume = heardResume || (mixed != null && hasSignal(mixed))
    },
  )
  await waitFor(
    () => stream.getStats().state === "buffering" && stream.getStats().underruns === 2,
    "Audio stream did not report a second starvation cycle",
    () => {
      audio.mixFrames(2048, 2)
    },
    4000,
  )

  sourceController.close()
  await drainStream(audio, stream)
})

test("Audio applies source backpressure until the mixer consumes buffered audio", async () => {
  const longFixture = new Uint8Array(await readFile(MP3_5S_URL))
  const largeChunk = repeatBytes(longFixture, 24)
  let pulls = 0
  let returned = false
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          pulls += 1
          if (pulls === 1) return { done: false as const, value: largeChunk }
          return { done: true as const, value: undefined }
        },
        async return() {
          returned = true
          return { done: true as const, value: undefined }
        },
      }
    },
  }
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)

  const stream = await audio.playStream(source, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  await waitFor(
    () => stream.getStats().bufferedFrames === stream.getStats().capacityFrames,
    "Audio stream did not fill its bounded decoded buffer",
  )
  let previousBytes = -1n
  let stablePolls = 0
  await waitFor(() => {
    if (pulls !== 1) return false
    const bytes = stream.getStats().bytesReceived
    stablePolls = bytes === previousBytes ? stablePolls + 1 : 0
    previousBytes = bytes
    return stablePolls >= 5
  }, "Audio stream byte acceptance did not stop under backpressure")
  const stalledStats = stream.getStats()
  expect(pulls).toBe(1)
  expect(stream.getStats().bufferedFrames).toBeLessThanOrEqual(stream.getStats().capacityFrames)
  expect(stalledStats.bytesReceived).toBeLessThan(BigInt(largeChunk.length))

  expect(audio.startMixer()).toBe(true)
  await waitFor(
    () => stream.getStats().bytesReceived > stalledStats.bytesReceived,
    "Audio stream did not resume byte acceptance after mixer progress",
    () => {
      audio.mixFrames(2048, 2)
    },
  )
  expect(pulls).toBe(1)
  stream.dispose()
  await stream.closed
  expect(returned).toBe(true)
})

test("Audio stream volume, pan, and group controls affect real mixed PCM", async () => {
  const longFixture = new Uint8Array(await readFile(MP3_5S_URL))
  const finishSource = deferred()
  async function* source(): AsyncGenerator<Uint8Array> {
    yield longFixture
    await finishSource.promise
  }
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const mutedGroup = audio.group("muted-stream")
  expect(mutedGroup).not.toBeNull()
  if (mutedGroup == null) return
  expect(audio.setGroupVolume(mutedGroup, 0)).toBe(true)

  const stream = await audio.playStream(source(), {
    volume: 0,
    buffer: { capacityMs: 2000, startupMs: 25, resumeMs: 25 },
  })
  const controlErrors: AudioStreamErrorContext[] = []
  stream.on("error", (_error, context) => controlErrors.push(context))
  await waitFor(() => stream.getStats().bufferedDurationMs >= 500, "Audio stream did not buffer control audio")

  const mutedFramesBefore = stream.getStats().framesPlayed
  const mutedOutput = audio.mixFrames(2048, 2)
  expect(mutedOutput).not.toBeNull()
  expect(hasSignal(mutedOutput ?? new Float32Array())).toBe(false)
  expect(stream.getStats().framesPlayed).toBeGreaterThan(mutedFramesBefore)

  expect(stream.setVolume(1)).toBe(true)
  let audibleOutput: Float32Array | null = null
  await waitFor(
    () => audibleOutput != null && hasSignal(audibleOutput),
    "Audio stream did not become audible after raising volume",
    () => {
      audibleOutput = audio.mixFrames(2048, 2)
    },
  )

  expect(stream.setPan(-1)).toBe(true)
  const leftOutput = audio.mixFrames(2048, 2)
  expect(leftOutput).not.toBeNull()
  if (leftOutput == null) return
  expect(channelEnergy(leftOutput, 0)).toBeGreaterThan(channelEnergy(leftOutput, 1) * 4)

  expect(stream.setPan(1)).toBe(true)
  const rightOutput = audio.mixFrames(2048, 2)
  expect(rightOutput).not.toBeNull()
  if (rightOutput == null) return
  expect(channelEnergy(rightOutput, 1)).toBeGreaterThan(channelEnergy(rightOutput, 0) * 4)

  expect(stream.setPan(0)).toBe(true)
  expect(stream.setGroup(mutedGroup)).toBe(true)
  const groupFramesBefore = stream.getStats().framesPlayed
  const groupMutedOutput = audio.mixFrames(2048, 2)
  expect(groupMutedOutput).not.toBeNull()
  expect(hasSignal(groupMutedOutput ?? new Float32Array())).toBe(false)
  expect(stream.getStats().framesPlayed).toBeGreaterThan(groupFramesBefore)

  expect(stream.setGroup(0)).toBe(true)
  const groupAudibleOutput = audio.mixFrames(2048, 2)
  expect(groupAudibleOutput).not.toBeNull()
  expect(hasSignal(groupAudibleOutput ?? new Float32Array())).toBe(true)
  expect(stream.setGroup(1.5)).toBe(false)
  await waitFor(
    () => controlErrors.some((context) => context.action === "setGroup" && context.status == null),
    "Fractional group ID did not emit its nonterminal error",
  )
  expect(stream.state).not.toBe("errored")
  expect(stream.setGroup(0xffffffff)).toBe(false)
  expect(stream.state).not.toBe("errored")

  finishSource.resolve()
  await drainStream(audio, stream)
  expect(stream.setVolume(1)).toBe(false)
  expect(stream.setPan(0)).toBe(false)
  expect(stream.setGroup(0)).toBe(false)
})

test("AudioStream async and terminal emission preserve EventEmitter throw semantics", () => {
  const stream = Object.create(AudioStream.prototype) as AudioStream
  const callbacks: Array<() => void> = []
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: TimerHandler) => {
    callbacks.push(callback as () => void)
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  const unhandledError = new Error("unhandled stream error")
  const listenerError = new Error("stream listener failed")
  let closed = 0
  try {
    ;(stream as any).emitAsync("error", unhandledError, { action: "source" })
    stream.on("ended", () => {
      throw listenerError
    })
    ;(stream as any).emitAsync("ended")
    ;(stream as any).terminalEventScheduled = false
    ;(stream as any).closedResolve = () => {
      closed += 1
    }
    ;(stream as any).emitTerminal("ended")
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }

  expect(callbacks).toHaveLength(3)
  expect(() => callbacks[0]!()).toThrow(unhandledError)
  expect(() => callbacks[1]!()).toThrow(listenerError)
  expect(() => callbacks[2]!()).toThrow(listenerError)
  expect(closed).toBe(1)
})

test("Audio retries initial fetch failures without a default attempt limit", async () => {
  const fixture = new Uint8Array(await readFile(MP3_URL))
  const server = createServer((_, response) => {
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    response.end(fixture)
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetches += 1
    if (fetches <= 3) return Promise.reject(new TypeError("simulated connection failure"))
    return originalFetch(input, init)
  }) as typeof fetch

  let stream: AudioStream
  try {
    stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
      buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
      reconnect: { initialDelayMs: 0, maxDelayMs: 0 },
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  await drainStream(audio, stream)
  expect(fetches).toBe(4)
  expect(stream.getStats().reconnectAttempts).toBe(3)
})

test("Audio does not replay initial reconnect attempts after stream setup", async () => {
  const fixture = new Uint8Array(await readFile(MP3_URL))
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    if (requests === 1) {
      response.writeHead(503, { Connection: "close" })
      response.end()
      return
    }
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    response.end(fixture)
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
  })
  const reconnectAttempts: number[] = []
  stream.on("reconnecting", ({ attempt }) => reconnectAttempts.push(attempt))
  await yieldToRuntime()

  expect(requests).toBe(2)
  expect(stream.getStats().reconnectAttempts).toBe(1)
  expect(reconnectAttempts).toEqual([])
  await drainStream(audio, stream)
})

test("Audio retries only documented HTTP statuses and enforces maxRetries", async () => {
  const fixture = new Uint8Array(await readFile(MP3_URL))
  const retryableStatuses = [408, 425, 429, 500, 503, 599]
  for (const status of retryableStatuses) {
    let requests = 0
    const server = createServer((_, response) => {
      requests += 1
      if (requests === 1) {
        response.writeHead(status, { Connection: "close" })
        response.end()
        return
      }
      response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
      response.end(fixture)
    })
    const baseUrl = await listen(server)
    const audio = Audio.create({ autoStart: false })
    audios.push(audio)
    expect(audio.startMixer()).toBe(true)

    const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
      buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
      reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
    })
    await drainStream(audio, stream)
    expect(requests).toBe(2)
    expect(stream.getStats().reconnectAttempts).toBe(1)
    audio.dispose()
  }

  const nonRetryableStatuses = [400, 404, 499, 600]
  for (const status of nonRetryableStatuses) {
    let requests = 0
    const server = createServer((_, response) => {
      requests += 1
      response.writeHead(status, { Connection: "close" })
      response.end()
    })
    const baseUrl = await listen(server)
    const audio = Audio.create({ autoStart: false })
    audios.push(audio)

    await expect(
      audio.playStreamUrl(`${baseUrl}/radio`, {
        reconnect: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
      }),
    ).rejects.toThrow(`HTTP ${status}`)
    expect(requests).toBe(1)
    expect(audio.getStats()?.voicesActive).toBe(0)
    audio.dispose()
  }

  for (const maxRetries of [0, 2]) {
    let requests = 0
    const server = createServer((_, response) => {
      requests += 1
      response.writeHead(503, { Connection: "close" })
      response.end()
    })
    const baseUrl = await listen(server)
    const audio = Audio.create({ autoStart: false })
    audios.push(audio)

    await expect(
      audio.playStreamUrl(`${baseUrl}/radio`, {
        reconnect: { maxRetries, initialDelayMs: 0, maxDelayMs: 0 },
      }),
    ).rejects.toThrow("HTTP 503")
    expect(requests).toBe(maxRetries + 1)
    expect(audio.getStats()?.voicesActive).toBe(0)
    audio.dispose()
  }
})

test("Audio reconnect policy can override default URL response classification", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    if (requests === 1) {
      response.writeHead(404, { Connection: "close" })
      response.end()
      return
    }
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    response.end(mp3)
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let policies = 0

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: {
      maxRetries: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      retry(error, context) {
        policies += 1
        expect(error.context).toEqual({ action: "response", status: 404, attempt: 0 })
        expect(context.phase).toBe("connect")
        return {}
      },
    },
  })
  await drainStream(audio, stream)
  expect(requests).toBe(2)
  expect(policies).toBe(1)
})

test("Audio applies exponential reconnect backoff and caps it at maxDelayMs", async () => {
  const fixture = new Uint8Array(await readFile(MP3_5S_URL))
  const interruptResponse = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    if (requests === 1) {
      response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
      response.write(fixture)
      void interruptResponse.promise.then(() => response.destroy())
      return
    }
    response.writeHead(503, { Connection: "close" })
    response.end()
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
    reconnect: { maxRetries: 3, initialDelayMs: 10, maxDelayMs: 25, backoffFactor: 2 },
  })
  const attempts: number[] = []
  const delays: number[] = []
  const reconnectErrors: AudioStreamError[] = []
  let terminalContext: AudioStreamErrorContext | undefined
  stream.on("reconnecting", ({ attempt, delayMs, error }) => {
    attempts.push(attempt)
    delays.push(delayMs)
    reconnectErrors.push(error)
  })
  stream.on("error", (_error, context) => {
    terminalContext = context
  })

  const originalSetTimeout = globalThis.setTimeout
  const scheduledDelays: number[] = []
  globalThis.setTimeout = ((callback: TimerHandler, delayMs?: number, ...args: unknown[]) => {
    if (delayMs === 10 || delayMs === 20 || delayMs === 25) scheduledDelays.push(delayMs)
    return originalSetTimeout(callback, delayMs, ...args)
  }) as typeof setTimeout
  try {
    interruptResponse.resolve()
    await stream.closed
    await waitFor(() => terminalContext != null, "Exhausted reconnect attempts did not emit an error")
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }

  expect(attempts).toEqual([1, 2, 3])
  expect(delays).toEqual([10, 20, 25])
  expect(reconnectErrors.map((error) => expectAudioStreamError(error).context.action)).toEqual([
    "fetch",
    "response",
    "response",
  ])
  expect(scheduledDelays).toEqual(delays)
  expect(requests).toBe(4)
  expect(terminalContext).toEqual({ action: "response", status: 503, attempt: 3 })
  expect(stream.getStats().reconnectAttempts).toBe(3)
  expect(stream.state).toBe("errored")
})

test("Audio resets consecutive reconnect attempts after decoder recovery", async () => {
  const longFixture = new Uint8Array(await readFile(MP3_5S_URL))
  const replacementFixture = repeatBytes(new Uint8Array(await readFile(MP3_3000_URL)), 5)
  const finalFixture = new Uint8Array(await readFile(MP3_URL))
  const interruptFirst = deferred()
  const interruptSecond = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    if (requests === 1) {
      response.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": longFixture.length * 2,
        Connection: "close",
      })
      response.write(longFixture)
      void interruptFirst.promise.then(() => response.destroy())
      return
    }
    if (requests === 2) {
      response.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": replacementFixture.length * 2,
        Connection: "close",
      })
      response.write(replacementFixture)
      void interruptSecond.promise.then(() => response.destroy())
      return
    }
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    response.end(finalFixture)
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
  })
  stream.on("error", () => {})
  const attempts: number[] = []
  stream.on("reconnecting", ({ attempt }) => {
    attempts.push(attempt)
  })

  interruptFirst.resolve()
  let replacementOutput: Float32Array | null = null
  await waitFor(
    () =>
      requests === 2 &&
      replacementOutput != null &&
      tonePower(replacementOutput, 2048, 3000) > tonePower(replacementOutput, 2048, 750) * 10,
    "Audio stream did not recover from its first outage",
    () => {
      replacementOutput = audio.mixFrames(2048, 2)
    },
    4000,
  )

  const beforeSecondOutage = stream.getStats()
  interruptSecond.resolve()
  await waitFor(
    () => {
      const stats = stream.getStats()
      if (stats.state === "errored") {
        throw new Error(
          `Audio stream errored during second recovery (requests=${requests}, attempts=${attempts.join(",")})`,
        )
      }
      return requests === 3 && stats.bytesReceived > beforeSecondOutage.bytesReceived
    },
    "Audio stream did not recover from its second independent outage",
    () => {
      audio.mixFrames(2048, 2)
    },
    4000,
  )
  await drainStream(audio, stream)

  expect(attempts).toEqual([1, 1])
  expect(stream.getStats().reconnectAttempts).toBe(2)
})

test("Audio reports Retry-After delay through reconnect events without waiting for it", async () => {
  const longFixture = new Uint8Array(await readFile(MP3_5S_URL))
  const interruptFirst = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    if (requests === 1) {
      response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
      response.write(longFixture)
      void interruptFirst.promise.then(() => response.destroy())
      return
    }
    response.writeHead(503, { "Retry-After": "1", Connection: "close" })
    response.end()
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
    reconnect: {
      maxRetries: 3,
      initialDelayMs: 0,
      maxDelayMs: 100,
      backoffFactor: 2,
      retry: () => ({}),
    },
  })
  stream.on("error", () => {})
  const delays: number[] = []
  stream.on("reconnecting", ({ delayMs }) => {
    delays.push(delayMs)
    if (delays.length === 2) stream.dispose()
  })

  interruptFirst.resolve()
  await stream.closed

  expect(delays).toEqual([0, 100])
  expect(requests).toBe(2)
  expect(stream.state).toBe("disposed")
})

test("Audio preserves long reconnect delays across runtime timer limits", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_5S_URL))
  const interruptResponse = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    if (requests === 1) {
      response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
      response.write(mp3)
      void interruptResponse.promise.then(() => response.destroy())
      return
    }
    response.writeHead(503, { Connection: "close" })
    response.end()
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const delayMs = 3_000_000_000
  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
    reconnect: { maxRetries: 1, initialDelayMs: delayMs, maxDelayMs: delayMs },
  })
  stream.on("error", () => {})
  const reconnecting = new Promise<void>((resolve) => {
    stream.on("reconnecting", () => resolve())
  })

  const originalSetTimeout = globalThis.setTimeout
  const scheduled: Array<{ callback: () => void; delayMs: number }> = []
  globalThis.setTimeout = ((callback: TimerHandler, delayMs?: number, ...args: unknown[]) => {
    if ((delayMs ?? 0) > 100) {
      scheduled.push({
        callback: () => (callback as (...callbackArgs: unknown[]) => void)(...args),
        delayMs: delayMs ?? 0,
      })
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    return originalSetTimeout(callback, delayMs, ...args)
  }) as typeof setTimeout

  try {
    interruptResponse.resolve()
    await reconnecting
    expect(requests).toBe(1)

    let elapsedMs = 0
    let timerIndex = 0
    while (elapsedMs < delayMs) {
      const timer = scheduled[timerIndex]
      if (timer == null) {
        const remainingMs = delayMs - elapsedMs
        if (remainingMs > 100) throw new Error("Long reconnect delay did not schedule its complete duration")
        globalThis.setTimeout = originalSetTimeout
        await waitFor(() => requests === 2, "Final reconnect delay segment did not complete")
        elapsedMs = delayMs
        break
      }
      expect(timer.delayMs).toBeGreaterThan(0)
      expect(timer.delayMs).toBeLessThanOrEqual(0x7fffffff)
      elapsedMs += timer.delayMs
      expect(elapsedMs).toBeLessThanOrEqual(delayMs)
      timer.callback()
      timerIndex += 1
      if (elapsedMs < delayMs) expect(requests).toBe(1)
    }
    expect(elapsedMs).toBe(delayMs)
    expect(timerIndex).toBeGreaterThan(1)
    globalThis.setTimeout = originalSetTimeout
    await waitFor(() => requests === 2, "Reconnect did not resume after the complete segmented delay")
    await stream.closed
    expect(stream.state).toBe("errored")
  } finally {
    globalThis.setTimeout = originalSetTimeout
    stream.dispose()
    await stream.closed
  }
})

test("Audio retries successful URL responses that have no body", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = (() => {
    requests += 1
    return Promise.resolve(new Response(null, { status: 200 }))
  }) as unknown as typeof fetch

  let rejection: unknown
  try {
    await audio.playStreamUrl("https://example.test/radio", {
      reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
    })
  } catch (error) {
    rejection = error
  } finally {
    globalThis.fetch = originalFetch
  }

  const streamError = expectAudioStreamError(rejection)
  expect(streamError.message).toContain("response has no body")
  expect(streamError.context).toEqual({
    action: "response",
    status: 200,
    attempt: 1,
  })
  expect(requests).toBe(2)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio enforces the documented HTTP content-type policy", async () => {
  const fixtures = {
    mp3: new Uint8Array(await readFile(MP3_URL)),
    flac: new Uint8Array(await readFile(FLAC_URL)),
  }
  const scenarios: Array<{ format: keyof typeof fixtures; contentTypes: Array<string | undefined> }> = [
    {
      format: "mp3",
      contentTypes: [
        "audio/mpeg",
        "audio/mp3",
        "application/octet-stream",
        "application/mp3",
        "Audio/MPEG; charset=binary",
        undefined,
      ],
    },
    {
      format: "flac",
      contentTypes: ["audio/flac", "audio/x-flac", "application/octet-stream", undefined],
    },
  ]
  for (const scenario of scenarios) {
    for (const contentType of scenario.contentTypes) {
      const server = createServer((_, response) => {
        const headers: Record<string, string> = { Connection: "close" }
        if (contentType != null) headers["Content-Type"] = contentType
        response.writeHead(200, headers)
        response.end(fixtures[scenario.format])
      })
      const baseUrl = await listen(server)
      const audio = Audio.create({ autoStart: false })
      audios.push(audio)
      expect(audio.startMixer()).toBe(true)

      const stream = await audio.playStreamUrl(new URL("/radio", baseUrl), {
        format: scenario.format,
        buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
      })
      await drainStream(audio, stream)
      expect(stream.getStats().framesPlayed).toBeGreaterThan(0n)
      audio.dispose()
    }
  }

  for (const scenario of [
    { format: "mp3" as const, contentType: "audio/flac" },
    { format: "flac" as const, contentType: "audio/mpeg" },
  ]) {
    let requests = 0
    const server = createServer((_, response) => {
      requests += 1
      response.writeHead(200, { "Content-Type": scenario.contentType, Connection: "close" })
      response.end(fixtures[scenario.format])
    })
    const baseUrl = await listen(server)
    const unsupportedAudio = Audio.create({ autoStart: false })
    audios.push(unsupportedAudio)
    await expect(
      unsupportedAudio.playStreamUrl(`${baseUrl}/radio`, {
        format: scenario.format,
        reconnect: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
      }),
    ).rejects.toThrow("Unsupported audio stream Content-Type")
    expect(unsupportedAudio.getStats()?.voicesActive).toBe(0)
    expect(requests).toBe(1)
    unsupportedAudio.dispose()
  }
})

test("Audio exposes MP3 as the resolved stream format", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStream(
    (async function* () {
      yield mp3
    })(),
    {
      format: "mp3",
      buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    },
  )
  expect(stream.format).toBe("mp3")
  await drainStream(audio, stream)
})

test("Audio rejects unsupported stream formats before opening a source", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let bodyPulls = 0
  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      bodyPulls += 1
    },
  }
  await expect(audio.playStream(body, { format: "wav" as never })).rejects.toThrow("Unsupported audio stream format")
  expect(bodyPulls).toBe(0)

  let connections = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      return { body, info: undefined }
    },
  }
  await expect(audio.playStreamSource(connector, { format: "wav" as never })).rejects.toThrow(
    "Unsupported audio stream format",
  )
  expect(connections).toBe(0)
  await expect(audio.playStreamSource(connector, { contentTypePolicy: "ignore" } as never)).rejects.toThrow(
    "only supported by playStreamUrl",
  )
  expect(connections).toBe(0)

  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = (() => {
    requests += 1
    return Promise.reject(new Error("unexpected request"))
  }) as unknown as typeof fetch
  try {
    await expect(audio.playStreamUrl("https://example.test/radio", { format: "wav" as never })).rejects.toThrow(
      "Unsupported audio stream format",
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(requests).toBe(0)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio can ignore URL content type validation explicitly", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const server = createServer((_, response) => {
    response.writeHead(200, { "Content-Type": "text/plain", Connection: "close" })
    response.end(mp3)
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    format: "mp3",
    contentTypePolicy: "ignore",
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  expect(stream.format).toBe("mp3")
  await drainStream(audio, stream)
})

test("Audio passes format-aware response context to content type policy", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const server = createServer((_, response) => {
    response.writeHead(200, { "Content-Type": "audio/custom", Connection: "close" })
    response.end(mp3)
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const contexts: AudioStreamContentTypeContext[] = []

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    format: "mp3",
    contentTypePolicy(context) {
      contexts.push(context)
      return context.format === "mp3" && context.contentType === "audio/custom"
    },
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  await drainStream(audio, stream)
  expect(contexts).toEqual([
    {
      format: "mp3",
      contentType: "audio/custom",
      status: 200,
      url: `${baseUrl}/radio`,
    },
  ])
})

test("Audio content type policy receives the effective redirected URL", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/radio", Connection: "close" })
      response.end()
      return
    }
    response.writeHead(200, { "Content-Type": "audio/custom", Connection: "close" })
    response.end(mp3)
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let effectiveUrl: string | undefined

  const stream = await audio.playStreamUrl(`${baseUrl}/redirect`, {
    contentTypePolicy(context) {
      effectiveUrl = context.url
      return context.url === `${baseUrl}/radio`
    },
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  await drainStream(audio, stream)
  expect(effectiveUrl).toBe(`${baseUrl}/radio`)
})

test("Audio re-evaluates and enforces content type policy for reconnect responses", async () => {
  const initialMp3 = new Uint8Array(await readFile(MP3_5S_URL))
  const replacementMp3 = new Uint8Array(await readFile(MP3_URL))
  const interrupt = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    if (requests === 1) {
      response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
      response.write(initialMp3)
      void interrupt.promise.then(() => response.destroy())
      return
    }
    response.writeHead(200, { "Content-Type": "audio/custom", Connection: "close" })
    response.end(replacementMp3)
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const contentTypes: Array<string | null> = []
  let replacementRejected = false

  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    contentTypePolicy(context) {
      contentTypes.push(context.contentType)
      if (context.contentType === "audio/custom") replacementRejected = true
      return context.contentType === "audio/mpeg"
    },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
  })
  const errors: Array<{ error: Error; context: AudioStreamErrorContext }> = []
  stream.on("error", (error, context) => {
    errors.push({ error, context })
  })
  await waitFor(
    () => stream.getStats().bytesReceived >= BigInt(initialMp3.byteLength),
    "Initial response bytes were not accepted before interruption",
  )
  const internals = stream as unknown as {
    lib: {
      audioWriteStream: (...args: unknown[]) => number
    }
  }
  const originalWriteStream = internals.lib.audioWriteStream
  let rejectedResponseWrites = 0
  const restoreWriteStream = replaceMethod(internals.lib, "audioWriteStream", (...args: unknown[]) => {
    if (replacementRejected) rejectedResponseWrites += 1
    return originalWriteStream.apply(internals.lib, args)
  })
  try {
    interrupt.resolve()
    await stream.closed
  } finally {
    restoreWriteStream()
  }
  expect(requests).toBe(2)
  expect(contentTypes).toEqual(["audio/mpeg", "audio/custom"])
  expect(errors).toHaveLength(1)
  expect(errors[0]?.context).toEqual({ action: "response", status: 200, attempt: 1 })
  expect(rejectedResponseWrites).toBe(0)
})

test("Audio validates URL content type policy before requesting", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = (() => {
    requests += 1
    return Promise.reject(new Error("unexpected request"))
  }) as unknown as typeof fetch
  try {
    await expect(
      audio.playStreamUrl("https://example.test/radio", { contentTypePolicy: "invalid" as never }),
    ).rejects.toThrow("contentTypePolicy")
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(requests).toBe(0)
})

test("Audio treats content type callbacks as authoritative before native allocation", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const originalFetch = globalThis.fetch
  try {
    for (const contentType of ["audio/mpeg", null]) {
      globalThis.fetch = (async () =>
        new Response(mp3, {
          status: 200,
          headers: contentType == null ? undefined : { "Content-Type": contentType },
        })) as unknown as typeof fetch
      const audio = Audio.create({ autoStart: false })
      audios.push(audio)
      const internals = audio as unknown as {
        lib: {
          audioCreateStream: (...args: unknown[]) => unknown
        }
      }
      const originalCreateStream = internals.lib.audioCreateStream
      let nativeCreates = 0
      const restoreCreateStream = replaceMethod(internals.lib, "audioCreateStream", (...args: unknown[]) => {
        nativeCreates += 1
        return originalCreateStream.apply(internals.lib, args)
      })
      let context: AudioStreamContentTypeContext | undefined
      let rejection: unknown
      try {
        await audio.playStreamUrl("https://example.test/radio", {
          contentTypePolicy(value) {
            context = value
            return false
          },
        })
      } catch (error) {
        rejection = error
      } finally {
        restoreCreateStream()
      }
      const streamError = expectAudioStreamError(rejection)
      expect(streamError.context).toEqual({ action: "response", status: 200, attempt: 0 })
      expect(context?.contentType).toBe(contentType)
      expect(nativeCreates).toBe(0)
      expect(audio.getStats()?.voicesActive).toBe(0)
      audio.dispose()
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Audio rejects invalid content type policy results before native allocation", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(mp3, {
      status: 200,
      headers: { "Content-Type": "audio/custom" },
    })) as unknown as typeof fetch
  try {
    const scenarios = [
      {
        policy: () => false,
        message: "Unsupported audio stream Content-Type",
      },
      {
        policy: () => "yes" as never,
        message: "contentTypePolicy must return a boolean",
      },
      {
        policy: () => {
          throw new Error("policy failed")
        },
        message: "policy failed",
      },
    ]
    for (const scenario of scenarios) {
      const audio = Audio.create({ autoStart: false })
      audios.push(audio)
      let rejection: unknown
      try {
        await audio.playStreamUrl("https://example.test/radio", {
          contentTypePolicy: scenario.policy,
        })
      } catch (error) {
        rejection = error
      }
      const streamError = expectAudioStreamError(rejection)
      expect(streamError.message).toContain(scenario.message)
      expect(streamError.context).toEqual({ action: "response", status: 200, attempt: 0 })
      expect(audio.getStats()?.voicesActive).toBe(0)
      audio.dispose()
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Audio classifies invalid chunks and invalid reconnect media at the public boundary", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let invalidSetupConsumed = false
  const invalidSetupSource: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      invalidSetupConsumed = true
      yield "invalid chunk" as unknown as Uint8Array
    },
  }
  await expect(audio.playStream(invalidSetupSource)).rejects.toThrow("Uint8Array")
  expect(invalidSetupConsumed).toBe(true)
  expect(audio.getStats()?.voicesActive).toBe(0)

  const longFixture = new Uint8Array(await readFile(MP3_5S_URL))
  const releaseInvalidChunk = deferred()
  async function* invalidRuntimeSource(): AsyncGenerator<Uint8Array> {
    yield longFixture
    await releaseInvalidChunk.promise
    yield "invalid chunk" as unknown as Uint8Array
  }
  expect(audio.startMixer()).toBe(true)
  const runtimeStream = await audio.playStream(invalidRuntimeSource(), {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
  })
  const runtimeErrorContext: { value?: AudioStreamErrorContext } = {}
  runtimeStream.on("error", (_error, context) => {
    runtimeErrorContext.value = context
  })
  releaseInvalidChunk.resolve()
  await runtimeStream.closed
  await waitFor(() => runtimeErrorContext.value != null, "Invalid runtime chunk did not emit an error")
  expect(runtimeStream.state).toBe("errored")
  expect(runtimeErrorContext.value?.action).toBe("source")
  expect(audio.getStats()?.voicesActive).toBe(0)

  const interruptFirst = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    if (requests === 1) {
      response.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": longFixture.length * 2,
        Connection: "close",
      })
      response.write(longFixture)
      void interruptFirst.promise.then(() => response.destroy())
      return
    }
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    response.end("not an mp3 stream")
  })
  const baseUrl = await listen(server)
  const reconnectStream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
    reconnect: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
  })
  const reconnectErrorContext: { value?: AudioStreamErrorContext } = {}
  reconnectStream.on("error", (_error, context) => {
    reconnectErrorContext.value = context
  })
  interruptFirst.resolve()
  await reconnectStream.closed
  await waitFor(() => reconnectErrorContext.value != null, "Invalid replacement MP3 did not emit an error")

  expect(reconnectStream.state).toBe("errored")
  expect(reconnectErrorContext.value?.action).toBe("decoder")
  expect(requests).toBe(2)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio reports a native restart failure during reconnect and releases the stream", async () => {
  const fixture = new Uint8Array(await readFile(MP3_5S_URL))
  const interruptResponse = deferred()
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    response.writeHead(200, { "Content-Type": "audio/mpeg", Connection: "close" })
    response.write(fixture)
    void interruptResponse.promise.then(() => response.destroy())
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const stream = await audio.playStreamUrl(`${baseUrl}/radio`, {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
  })

  const internals = stream as unknown as {
    lib: { audioRestartStream: (...args: unknown[]) => number }
  }
  const restoreRestart = replaceMethod(internals.lib, "audioRestartStream", () => -77)
  let errorContext: AudioStreamErrorContext | undefined
  stream.on("error", (_error, context) => {
    errorContext = context
  })

  try {
    interruptResponse.resolve()
    await stream.closed
    await waitFor(() => errorContext != null, "Restart failure did not emit an error")
  } finally {
    restoreRestart()
  }

  expect(errorContext).toEqual({ action: "restart", status: -77 })
  expect(requests).toBe(1)
  expect(stream.state).toBe("errored")
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("AudioStream.getStats surfaces a native decoder failure while the source is idle", async () => {
  const fixture = new Uint8Array(await readFile(MP3_5S_URL))
  let sourceCancelled = false
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(fixture)
    },
    cancel() {
      sourceCancelled = true
    },
  })
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const stream = await audio.playStream(source, {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
  })

  const internals = stream as unknown as {
    engine: unknown
    nativeStreamId: number
    lib: {
      audioGetStreamStats: (
        engine: unknown,
        streamId: number,
      ) => {
        bytesReceived: bigint
        framesDecoded: bigint
        framesPlayed: bigint
        state: number
        sampleRate: number
        channels: number
        bufferedFrames: number
        capacityFrames: number
        underruns: number
        errorCode: number
        readyGeneration: number
      } | null
    }
  }
  const originalGetStats = internals.lib.audioGetStreamStats
  const nativeStats = originalGetStats.call(internals.lib, internals.engine, internals.nativeStreamId)
  if (nativeStats == null) throw new Error("Native stream stats unavailable before fault injection")
  const restoreGetStats = replaceMethod(internals.lib, "audioGetStreamStats", () => ({
    ...nativeStats,
    state: NativeAudioStreamState.Failed,
    errorCode: -77,
  }))
  const errors: Array<{ error: Error; context: AudioStreamErrorContext }> = []
  stream.on("error", (error, context) => {
    errors.push({ error, context })
  })

  try {
    expect(stream.getStats().state).toBe("errored")
  } finally {
    restoreGetStats()
  }
  await stream.closed
  await waitFor(() => errors.length === 1, "Observed decoder failure did not emit exactly one error")

  expect(errors[0]?.error.message).toContain("-77")
  expect(errors[0]?.context).toEqual({ action: "decoder", errorCode: -77 })
  expect(sourceCancelled).toBe(true)
  expect(stream.state).toBe("errored")
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio accepts Uint8Array chunks created in another realm", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const foreignChunk = runInNewContext("Uint8Array.from(bytes)", { bytes: mp3 }) as Uint8Array
  expect(foreignChunk).not.toBeInstanceOf(Uint8Array)

  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const stream = await audio.playStream(
    (async function* () {
      yield foreignChunk
    })(),
    { buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 } },
  )
  await drainStream(audio, stream)
  expect(stream.getStats().framesPlayed).toBeGreaterThan(0n)
})

test("AbortSignal cancels a URL stream while response headers are pending", async () => {
  const requestStarted = deferred()
  let requestClosed = false
  const server = createServer((request, response) => {
    requestStarted.resolve()
    request.on("close", () => {
      requestClosed = true
      response.end()
    })
  })
  const baseUrl = await listen(server)
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const abortController = new AbortController()

  const setup = audio.playStreamUrl(`${baseUrl}/radio`, { signal: abortController.signal })
  await requestStarted.promise
  abortController.abort()

  let rejection: unknown
  try {
    await setup
  } catch (error) {
    rejection = error
  }
  await waitFor(() => requestClosed, "Aborted URL request did not close")

  expect((rejection as Error)?.name).toBe("AbortError")
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("AbortSignal cancels stream setup and active playback without error events", async () => {
  const preAborted = new AbortController()
  preAborted.abort()
  let pulls = 0
  const unconsumedSource: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      pulls += 1
      yield new Uint8Array(await readFile(MP3_URL))
    },
  }
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let setupRejection: unknown
  try {
    await audio.playStream(unconsumedSource, { signal: preAborted.signal })
  } catch (error) {
    setupRejection = error
  }
  expect((setupRejection as Error)?.name).toBe("AbortError")
  expect(pulls).toBe(0)
  expect(audio.getStats()?.voicesActive).toBe(0)

  const longFixture = new Uint8Array(await readFile(MP3_5S_URL))
  let cancelled = false
  const activeSource = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(longFixture)
    },
    cancel() {
      cancelled = true
    },
  })
  expect(audio.startMixer()).toBe(true)
  const activeAbort = new AbortController()
  const stream = await audio.playStream(activeSource, {
    signal: activeAbort.signal,
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
  })
  let disposedEvents = 0
  let errorEvents = 0
  stream.on("disposed", () => {
    disposedEvents += 1
  })
  stream.on("error", () => {
    errorEvents += 1
  })
  activeAbort.abort()
  await stream.closed
  await waitFor(() => disposedEvents === 1, "Aborted stream did not emit disposed")

  expect(cancelled).toBe(true)
  expect(errorEvents).toBe(0)
  expect(stream.state).toBe("disposed")
  expect(stream.getStats().bufferedFrames).toBe(0)
  expect(stream.setVolume(1)).toBe(false)
  expect(stream.setPan(0)).toBe(false)
  expect(stream.setGroup(0)).toBe(false)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio.dispose cancels active streams and pending setup", async () => {
  const longFixture = new Uint8Array(await readFile(MP3_5S_URL))
  let activeCancelled = false
  const activeSource = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(longFixture)
    },
    cancel() {
      activeCancelled = true
      audio.dispose()
    },
  })
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let audioDisposedEvents = 0
  audio.on("disposed", () => {
    audioDisposedEvents += 1
  })
  expect(audio.startMixer()).toBe(true)
  const activeStream = await audio.playStream(activeSource, {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
  })
  audio.dispose()
  await activeStream.closed

  expect(activeCancelled).toBe(true)
  expect(audioDisposedEvents).toBe(1)
  expect(activeStream.state).toBe("disposed")
  expect(activeStream.getStats().bufferedFrames).toBe(0)

  let pendingCancelled = false
  const pendingSource = new ReadableStream<Uint8Array>({
    cancel() {
      pendingCancelled = true
    },
  })
  const pendingAudio = Audio.create({ autoStart: false })
  audios.push(pendingAudio)
  const pendingSetup = pendingAudio.playStream(pendingSource)
  pendingAudio.dispose()
  let pendingRejection: unknown
  try {
    await pendingSetup
  } catch (error) {
    pendingRejection = error
  }

  expect((pendingRejection as Error)?.name).toBe("AbortError")
  expect(pendingCancelled).toBe(true)
  pendingAudio.dispose()
})

test("Audio validates public stream and reconnect options before consuming a source", async () => {
  const invalidBodyOptions: Array<{
    name: string
    options: Parameters<Audio["playStream"]>[1]
    message: string
  }> = [
    { name: "zero capacity", options: { buffer: { capacityMs: 0 } }, message: "buffer.capacityMs" },
    { name: "fractional capacity", options: { buffer: { capacityMs: 1.5 } }, message: "buffer.capacityMs" },
    {
      name: "non-finite capacity",
      options: { buffer: { capacityMs: Number.POSITIVE_INFINITY } },
      message: "buffer.capacityMs",
    },
    {
      name: "startup above capacity",
      options: { buffer: { capacityMs: 100, startupMs: 101 } },
      message: "buffer.startupMs",
    },
    {
      name: "resume above capacity",
      options: { buffer: { capacityMs: 100, startupMs: 1, resumeMs: 101 } },
      message: "buffer.resumeMs",
    },
    { name: "zero probe limit", options: { maxProbeBytes: 0 }, message: "maxProbeBytes" },
    { name: "fractional probe limit", options: { maxProbeBytes: 1.5 }, message: "maxProbeBytes" },
    {
      name: "non-finite probe limit",
      options: { maxProbeBytes: Number.POSITIVE_INFINITY },
      message: "maxProbeBytes",
    },
    { name: "oversized probe limit", options: { maxProbeBytes: 0x1_0000_0000 }, message: "maxProbeBytes" },
  ]
  for (const scenario of invalidBodyOptions) {
    let pulls = 0
    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        pulls += 1
      },
    }
    const audio = Audio.create({ autoStart: false })
    audios.push(audio)
    await expect(audio.playStream(source, scenario.options)).rejects.toThrow(scenario.message)
    expect(pulls).toBe(0)
    expect(audio.getStats()?.voicesActive).toBe(0)
    audio.dispose()
  }

  let validationRequests = 0
  const validationServer = createServer((_, response) => {
    validationRequests += 1
    response.writeHead(500, { Connection: "close" })
    response.end()
  })
  const validationUrl = await listen(validationServer)
  const invalidMetadataEncodingAudio = Audio.create({ autoStart: false })
  audios.push(invalidMetadataEncodingAudio)
  await expect(
    invalidMetadataEncodingAudio.playStreamUrl(`${validationUrl}/radio`, {
      metadataEncoding: "not-a-real-encoding",
    }),
  ).rejects.toThrow("metadataEncoding")
  expect(validationRequests).toBe(0)
  invalidMetadataEncodingAudio.dispose()

  const invalidReconnectOptions = [
    { reconnect: { maxRetries: -1 }, message: "reconnect.maxRetries" },
    { reconnect: { maxRetries: 1.5 }, message: "reconnect.maxRetries" },
    { reconnect: { initialDelayMs: -1 }, message: "reconnect.initialDelayMs" },
    { reconnect: { maxDelayMs: 1.5 }, message: "reconnect.maxDelayMs" },
    { reconnect: { backoffFactor: 0.5 }, message: "reconnect.backoffFactor" },
    { reconnect: { retryOnEnd: "false" as never }, message: "reconnect.retryOnEnd" },
    {
      reconnect: { backoffFactor: Number.POSITIVE_INFINITY },
      message: "reconnect.backoffFactor",
    },
  ]
  for (const scenario of invalidReconnectOptions) {
    const audio = Audio.create({ autoStart: false })
    audios.push(audio)
    await expect(audio.playStreamUrl(`${validationUrl}/radio`, { reconnect: scenario.reconnect })).rejects.toThrow(
      scenario.message,
    )
    expect(audio.getStats()?.voicesActive).toBe(0)
    audio.dispose()
  }
  expect(validationRequests).toBe(0)

  for (const urlOnlyOptions of [
    { reconnect: {} },
    { request: { headers: { "x-test": "value" } } },
    { metadataEncoding: "utf-8" },
    { contentTypePolicy: "ignore" },
  ]) {
    let pulls = 0
    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        pulls += 1
      },
    }
    const audio = Audio.create({ autoStart: false })
    audios.push(audio)
    // @ts-expect-error Exercise runtime validation for untyped callers.
    await expect(audio.playStream(source, urlOnlyOptions)).rejects.toThrow("only supported by playStreamUrl()")
    expect(pulls).toBe(0)
    expect(audio.getStats()?.voicesActive).toBe(0)
    audio.dispose()
  }
})

test("Audio publishes custom demuxer metadata and writes flush output", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  let flushes = 0
  const stream = await audio.playStream(
    (async function* () {
      yield mp3
    })(),
    {
      buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
      demuxer: (): AudioStreamDemuxer<TestStreamMetadata> => {
        let buffered: Uint8Array | null = null
        return {
          initialMetadata: Object.freeze({ title: "Connected" }),
          *push(chunk: Uint8Array): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {
            buffered = chunk.slice()
            yield { type: "metadata", metadata: Object.freeze({ title: "Playing" }) }
          },
          *flush(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {
            flushes += 1
            if (buffered != null) yield { type: "audio", data: buffered }
          },
        }
      },
    },
  )

  expect(stream.getMetadata()).toEqual({ title: "Playing" })
  const metadataEvent = once(stream, "metadata")
  await drainStream(audio, stream)
  expect(await metadataEvent).toEqual([{ title: "Playing" }])
  expect(stream.getStats().bytesReceived).toBe(BigInt(mp3.byteLength))
  expect(flushes).toBe(1)
})

test("Audio uses the public ICY demuxer with an incrementally fragmented non-HTTP byte source", async () => {
  const mp3 = repeatBytes(new Uint8Array(await readFile(MP3_URL)), 8)
  const interval = 1024
  const framed = interleaveIcy(mp3, interval, ["StreamTitle='Custom transport';"])
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  const stream = await audio.playStream(
    (async function* () {
      for (let offset = 0; offset < framed.byteLength; offset += 37) {
        yield framed.subarray(offset, offset + 37)
        await yieldToRuntime()
      }
    })(),
    {
      buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
      demuxer: () =>
        createIcyStreamDemuxer({
          metadataInterval: interval,
          metadataEncoding: "utf-8",
        }),
    },
  )

  expect(stream.getMetadata()?.fields.StreamTitle).toBe("Custom transport")
  await drainStream(audio, stream)
  expect(stream.getStats().bytesReceived).toBe(BigInt(mp3.byteLength))
})

test("Audio creates a fresh demuxer for every connector attempt", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  let connections = 0
  let demuxers = 0
  let closes = 0
  const connectAttempts: number[] = []
  const retryContexts: Array<{ attempt: number; maxRetries: number; phase: string }> = []
  const connector: AudioStreamConnector<{ readonly connection: number }> = {
    async connect({ attempt }) {
      connectAttempts.push(attempt)
      connections += 1
      const connection = connections
      return {
        info: { connection },
        body: (async function* () {
          if (connection === 1) {
            yield mp3.subarray(0, 128)
            throw new Error("interrupted")
          }
          yield mp3
        })(),
        close() {
          closes += 1
        },
      }
    },
  }

  const stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: {
      maxRetries: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      retry(_error, context) {
        retryContexts.push(context)
        return {}
      },
    },
    demuxer(info): AudioStreamDemuxer<TestStreamMetadata> {
      demuxers += 1
      const ownConnection = info.connection
      return {
        initialMetadata: Object.freeze({ title: `Connection ${ownConnection}` }),
        *push(chunk: Uint8Array): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {
          yield { type: "audio", data: chunk }
        },
        *flush(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {},
      }
    },
  })

  await drainStream(audio, stream)
  expect(connections).toBe(2)
  expect(demuxers).toBe(2)
  expect(closes).toBe(2)
  expect(connectAttempts).toEqual([0, 1])
  expect(retryContexts).toEqual([{ attempt: 1, maxRetries: 1, phase: "read" }])
  expect(stream.getMetadata()).toEqual({ title: "Connection 2" })
  expect(stream.format).toBe("mp3")
  expect(stream.getStats().reconnectAttempts).toBe(1)
})

test("Audio waits for connection cleanup before reconnecting", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const failFirst = deferred()
  const releaseFirstClose = deferred()
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  let connections = 0
  let firstCloseStarted = false
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      const connection = connections
      return {
        info: undefined,
        body: (async function* () {
          yield mp3
          if (connection === 1) {
            await failFirst.promise
            throw new Error("interrupted")
          }
        })(),
        close() {
          if (connection !== 1) return
          firstCloseStarted = true
          return releaseFirstClose.promise
        },
      }
    },
  }

  const stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
  })
  failFirst.resolve()
  await waitFor(() => firstCloseStarted, "First connection cleanup did not start")
  await sleep(75)
  expect(connections).toBe(1)

  releaseFirstClose.resolve()
  await waitFor(() => connections === 2, "Replacement connection did not start after cleanup")
  await drainStream(audio, stream)
  expect(stream.getStats().reconnectAttempts).toBe(1)
})

test("Audio honors a reconnect retry decision", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let connections = 0
  let decisions = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      throw new Error("not retryable")
    },
  }

  await expect(
    audio.playStreamSource(connector, {
      reconnect: {
        maxRetries: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
        retry(_error, context) {
          decisions += 1
          expect(context.attempt).toBe(1)
          return false
        },
      },
    }),
  ).rejects.toThrow("not retryable")
  expect(connections).toBe(1)
  expect(decisions).toBe(1)
})

test("Audio rejects an invalid reconnect retry delay without reconnecting", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let connections = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      throw new Error("retry me")
    },
  }

  await expect(
    audio.playStreamSource(connector, {
      reconnect: {
        maxRetries: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
        retry: () => ({ delayMs: -1 }),
      },
    }),
  ).rejects.toThrow("retry delay")
  expect(connections).toBe(1)
})

test("Audio closes a connection when demuxer creation fails", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let cancellations = 0
  let closes = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        info: undefined,
        body: new ReadableStream<Uint8Array>({
          cancel() {
            cancellations += 1
          },
        }),
        close() {
          closes += 1
        },
      }
    },
  }

  await expect(
    audio.playStreamSource(connector, {
      demuxer() {
        throw new Error("demuxer setup failed")
      },
    }),
  ).rejects.toThrow("demuxer setup failed")
  expect(cancellations).toBe(1)
  expect(closes).toBe(1)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio cancels a connector body and closes its connection exactly once", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let cancellations = 0
  let closes = 0
  let aborts = 0
  let flushes = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        info: undefined,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(mp3)
          },
          cancel() {
            cancellations += 1
          },
        }),
        close() {
          closes += 1
        },
      }
    },
  }

  const stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    demuxer(): AudioStreamDemuxer<TestStreamMetadata> {
      return {
        initialMetadata: null,
        *push(chunk: Uint8Array): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {
          yield { type: "audio", data: chunk }
        },
        *flush(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {
          flushes += 1
        },
        abort() {
          aborts += 1
        },
      }
    },
  })
  stream.dispose()
  stream.dispose()
  await stream.closed
  expect(cancellations).toBe(1)
  expect(closes).toBe(1)
  expect(aborts).toBe(1)
  expect(flushes).toBe(0)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio closes a connection when initial demuxer metadata throws", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let cancellations = 0
  let closes = 0
  let aborts = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        info: undefined,
        body: new ReadableStream<Uint8Array>({
          cancel() {
            cancellations += 1
          },
        }),
        close() {
          closes += 1
        },
      }
    },
  }

  await expect(
    audio.playStreamSource(connector, {
      demuxer(): AudioStreamDemuxer<TestStreamMetadata> {
        return {
          get initialMetadata(): TestStreamMetadata | null {
            throw new Error("metadata setup failed")
          },
          *push(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {},
          *flush(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {},
          abort() {
            aborts += 1
          },
        }
      },
    }),
  ).rejects.toThrow("metadata setup failed")
  expect(cancellations).toBe(1)
  expect(closes).toBe(1)
  expect(aborts).toBe(1)
})

test("Audio closes a connection when reading its body throws", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let closes = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        get body(): AudioStreamBody {
          throw new Error("body accessor failed")
        },
        info: undefined,
        close() {
          closes += 1
        },
      }
    },
  }

  await expect(audio.playStreamSource(connector)).rejects.toThrow("body accessor failed")
  expect(closes).toBe(1)
})

test("Audio preserves resolved cleanup when later connection metadata throws", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let closeReads = 0
  let closes = 0
  let bodyReads = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        get close(): () => void {
          closeReads += 1
          if (closeReads > 1) throw new Error("close read twice")
          return () => {
            closes += 1
          }
        },
        get info(): void {
          throw new Error("info accessor failed")
        },
        get body(): AudioStreamBody {
          bodyReads += 1
          return new ReadableStream<Uint8Array>()
        },
      }
    },
  }

  await expect(audio.playStreamSource(connector)).rejects.toThrow("info accessor failed")
  expect(closeReads).toBe(1)
  expect(closes).toBe(1)
  expect(bodyReads).toBe(0)
})

test("Audio applies custom retry policy from reconnect options", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let connections = 0
  let policyCalls = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      if (connections === 1) throw new Error("stop retrying")
      return {
        info: undefined,
        body: (async function* () {
          yield mp3
        })(),
      }
    },
  }

  await expect(
    audio.playStreamSource(connector, {
      reconnect: {
        maxRetries: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        retry(error, context) {
          policyCalls += 1
          expect(error.message).toContain("stop retrying")
          expect(context).toEqual({ attempt: 1, maxRetries: 1, phase: "connect" })
          return false
        },
      },
    }),
  ).rejects.toThrow("stop retrying")
  expect(connections).toBe(1)
  expect(policyCalls).toBe(1)
})

test("Audio stops retry processing when reconnect policy disposes the stream", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const failSource = deferred()
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let connections = 0
  let stream!: AudioStream
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      return {
        info: undefined,
        body: (async function* () {
          yield mp3
          await failSource.promise
          throw new Error("interrupted")
        })(),
      }
    },
  }

  stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: {
      maxRetries: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      retry() {
        stream.dispose()
        return {}
      },
    },
  })
  let reconnecting = 0
  stream.on("reconnecting", () => {
    reconnecting += 1
  })
  failSource.resolve()
  await stream.closed
  await sleep(5)
  expect(connections).toBe(1)
  expect(stream.getStats().reconnectAttempts).toBe(0)
  expect(reconnecting).toBe(0)
})

test("Audio cleans up when setup is cancelled during demuxer creation", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const controller = new AbortController()
  let cancellations = 0
  let closes = 0
  let aborts = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        info: undefined,
        body: new ReadableStream<Uint8Array>({
          cancel() {
            cancellations += 1
          },
        }),
        close() {
          closes += 1
        },
      }
    },
  }

  const setup = audio.playStreamSource(connector, {
    signal: controller.signal,
    demuxer(): AudioStreamDemuxer<TestStreamMetadata> {
      controller.abort()
      return {
        initialMetadata: null,
        *push(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {},
        *flush(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {},
        abort() {
          aborts += 1
        },
      }
    },
  })

  await expect(setup).rejects.toHaveProperty("name", "AbortError")
  expect(cancellations).toBe(1)
  expect(closes).toBe(1)
  expect(aborts).toBe(1)
  expect(audio.getStats()?.voicesActive).toBe(0)
})

test("Audio cleans up a connector when acquiring its body fails", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const body = new ReadableStream<Uint8Array>()
  const lockedReader = body.getReader()
  let closes = 0
  let aborts = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        info: undefined,
        body,
        close() {
          closes += 1
        },
      }
    },
  }

  try {
    await expect(
      audio.playStreamSource(connector, {
        demuxer(): AudioStreamDemuxer<TestStreamMetadata> {
          return {
            initialMetadata: null,
            *push(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {},
            *flush(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {},
            abort() {
              aborts += 1
            },
          }
        },
      }),
    ).rejects.toThrow("Audio stream source failed")
  } finally {
    lockedReader.releaseLock()
  }
  expect(closes).toBe(1)
  expect(aborts).toBe(1)
})

test("Audio rejects a malformed reconnect retry decision", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const connector: AudioStreamConnector<void> = {
    async connect() {
      throw new Error("connect failed")
    },
  }

  await expect(
    audio.playStreamSource(connector, {
      reconnect: {
        maxRetries: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        retry: () => undefined as never,
      },
    }),
  ).rejects.toThrow("retry policy")
})

test("Audio rejects a reconnect retry decision with a throwing delay", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const connector: AudioStreamConnector<void> = {
    async connect() {
      throw new Error("connect failed")
    },
  }

  await expect(
    audio.playStreamSource(connector, {
      reconnect: {
        maxRetries: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        retry() {
          return {
            get delayMs(): number {
              throw new Error("delay failed")
            },
          }
        },
      },
    }),
  ).rejects.toThrow("retry policy failed")
})

test("Audio reads a reconnect retry delay once", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let connections = 0
  let delayReads = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      if (connections === 1) throw new Error("connect failed")
      return {
        info: undefined,
        body: (async function* () {
          yield mp3
        })(),
      }
    },
  }

  const stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: {
      maxRetries: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      retry() {
        return {
          get delayMs(): number {
            delayReads += 1
            if (delayReads > 1) throw new Error("delay read twice")
            return 0
          },
        }
      },
    },
  })
  await drainStream(audio, stream)
  expect(delayReads).toBe(1)
})

test("Audio rejects a throwing reconnect retry getter before setup", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let connections = 0
  const connector: AudioStreamConnector<void> = {
    async connect(): Promise<AudioStreamConnection<void>> {
      connections += 1
      throw new Error("should not connect")
    },
  }
  const reconnect = Object.defineProperty({ maxRetries: 1 }, "retry", {
    get() {
      throw new Error("retry getter failed")
    },
  }) as AudioStreamReconnectOptions

  await expect(audio.playStreamSource(connector, { reconnect })).rejects.toThrow("retry getter failed")
  expect(connections).toBe(0)
})

test("Audio retries connector failures by default", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let connections = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      if (connections === 1) throw new Error("temporary failure")
      return {
        info: undefined,
        body: (async function* () {
          yield mp3
        })(),
      }
    },
  }

  const stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
  })
  await drainStream(audio, stream)
  expect(connections).toBe(2)
  expect(stream.getStats().reconnectAttempts).toBe(1)
})

test("Audio does not call retry policy after exhausting the retry budget", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let decisions = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      throw new Error("connect failed")
    },
  }

  await expect(
    audio.playStreamSource(connector, {
      reconnect: {
        maxRetries: 0,
        initialDelayMs: 0,
        maxDelayMs: 0,
        retry() {
          decisions += 1
          return {}
        },
      },
    }),
  ).rejects.toThrow("connect failed")
  expect(decisions).toBe(0)
})

test("Audio treats demuxer push failures as terminal", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let connections = 0
  let retryDecisions = 0
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      return {
        info: undefined,
        body: (async function* () {
          yield mp3
        })(),
      }
    },
  }

  let rejection: unknown
  try {
    await audio.playStreamSource(connector, {
      reconnect: {
        maxRetries: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        retry() {
          retryDecisions += 1
          return {}
        },
      },
      demuxer(): AudioStreamDemuxer<TestStreamMetadata> {
        return {
          initialMetadata: null,
          *push(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {
            throw new Error("demuxer push failed")
          },
          *flush(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {},
        }
      },
    })
  } catch (error) {
    rejection = error
  }
  expect(expectAudioStreamError(rejection).context.action).toBe("demuxer")
  expect(connections).toBe(1)
  expect(retryDecisions).toBe(0)
})

test("Audio retries a connector when demuxer flush reports truncated input", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let connections = 0
  let flushes = 0
  const retryPhases: string[] = []
  const connector: AudioStreamConnector<{ readonly connection: number }> = {
    async connect() {
      connections += 1
      const connection = connections
      return {
        info: { connection },
        body: (async function* () {
          yield connection === 1 ? mp3.subarray(0, 128) : mp3
        })(),
      }
    },
  }

  const stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: {
      maxRetries: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      retry(_error, context) {
        retryPhases.push(context.phase)
        return {}
      },
    },
    demuxer(info): AudioStreamDemuxer<TestStreamMetadata> {
      return {
        initialMetadata: null,
        *push(chunk: Uint8Array): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {
          yield { type: "audio", data: chunk }
        },
        *flush(): IterableIterator<AudioStreamDemuxOutput<TestStreamMetadata>> {
          flushes += 1
          if (info.connection === 1) throw new Error("truncated framing")
        },
      }
    },
  })

  await drainStream(audio, stream)
  expect(connections).toBe(2)
  expect(flushes).toBe(2)
  expect(retryPhases).toEqual(["read"])
  expect(stream.getStats().reconnectAttempts).toBe(1)
})

test("Audio returns an iterator acquired during cancellation", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const controller = new AbortController()
  let returns = 0
  let closes = 0
  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      controller.abort()
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return() {
          returns += 1
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        body,
        info: undefined,
        close() {
          closes += 1
        },
      }
    },
  }

  await expect(audio.playStreamSource(connector, { signal: controller.signal })).rejects.toHaveProperty(
    "name",
    "AbortError",
  )
  expect(returns).toBe(1)
  expect(closes).toBe(1)
})

test("Audio does not reacquire an async iterator after acquisition fails", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let acquisitions = 0
  let closes = 0
  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      acquisitions += 1
      throw new Error("iterator acquisition failed")
    },
  }
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        body,
        info: undefined,
        close() {
          closes += 1
        },
      }
    },
  }

  await expect(audio.playStreamSource(connector)).rejects.toThrow("Audio stream source failed")
  expect(acquisitions).toBe(1)
  expect(closes).toBe(1)
})

test("AudioStream.closed waits for resources discovered during cancellation", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const failFirst = deferred()
  const releaseCancel = deferred()
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let connections = 0
  let cancelStarted = false
  let stream!: AudioStream
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      if (connections === 1) {
        return {
          info: undefined,
          body: (async function* () {
            yield mp3
            await failFirst.promise
            throw new Error("interrupted")
          })(),
        }
      }
      return {
        get info(): undefined {
          stream.dispose()
          return undefined
        },
        body: new ReadableStream<Uint8Array>({
          cancel() {
            cancelStarted = true
            return releaseCancel.promise
          },
        }),
      }
    },
  }

  stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
  })
  let closed = false
  void stream.closed.then(() => {
    closed = true
  })
  failFirst.resolve()
  await waitFor(
    () => cancelStarted,
    "Cancellation did not discover the replacement body",
    () => audio.mixFrames(256, 2),
  )
  await sleep(5)
  expect(closed).toBe(false)
  releaseCancel.resolve()
  await stream.closed
  expect(closed).toBe(true)
})

test("AudioStream.closed waits for all cleanup after one cleanup rejects", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const releaseClose = deferred()
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let pulls = 0
  let closeStarted = false
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        info: undefined,
        body: {
          [Symbol.asyncIterator]() {
            return {
              next() {
                pulls += 1
                if (pulls === 1) return Promise.resolve({ done: false as const, value: mp3 })
                return new Promise<IteratorResult<Uint8Array>>(() => {})
              },
              return() {
                return Promise.reject(new Error("return failed"))
              },
            }
          },
        },
        close() {
          closeStarted = true
          return releaseClose.promise
        },
      }
    },
  }

  const stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  let closed = false
  void stream.closed.then(() => {
    closed = true
  })
  stream.dispose()
  await waitFor(() => closeStarted, "Connection cleanup did not start")
  await sleep(5)
  expect(closed).toBe(false)
  releaseClose.resolve()
  await stream.closed
  expect(closed).toBe(true)
})

test("AudioStream.closed remains bounded while connection cleanup is pending", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const releaseClose = deferred()
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)

  let closeStarted = false
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return {
        info: undefined,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(mp3)
          },
        }),
        close() {
          closeStarted = true
          return releaseClose.promise
        },
      }
    },
  }

  const stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  stream.dispose()
  await waitFor(() => closeStarted, "Connection cleanup did not start")
  const closedBeforeRelease = await Promise.race([stream.closed.then(() => true), sleep(250).then(() => false)])
  releaseClose.resolve()

  expect(closedBeforeRelease).toBe(true)
  await stream.closed
})

test("AudioStream.closed resolves after the ended event", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const stream = await audio.playStream(
    (async function* () {
      yield mp3
    })(),
    { buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 } },
  )
  const order: string[] = []
  stream.on("ended", () => {
    order.push("ended")
  })
  void stream.closed.then(() => {
    order.push("closed")
  })

  await drainStream(audio, stream)
  expect(order).toEqual(["ended", "closed"])
})

test("AudioStream.closed resolves after the error event", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const failSource = deferred()
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const stream = await audio.playStream(
    (async function* () {
      yield mp3
      await failSource.promise
      throw new Error("terminal source failure")
    })(),
    { buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 } },
  )
  const order: string[] = []
  stream.on("error", () => {
    order.push("error")
  })
  void stream.closed.then(() => {
    order.push("closed")
  })

  failSource.resolve()
  await waitFor(
    () => stream.state === "errored",
    "Audio stream did not reach its errored state",
    () => audio.mixFrames(256, 2),
  )
  await stream.closed
  expect(order).toEqual(["error", "closed"])
})

test("AudioStream.closed resolves after the disposed event", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  const stream = await audio.playStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(mp3)
      },
    }),
    { buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 } },
  )
  const order: string[] = []
  stream.on("disposed", () => {
    order.push("disposed")
  })
  void stream.closed.then(() => {
    order.push("closed")
  })

  stream.dispose()
  await stream.closed
  expect(order).toEqual(["disposed", "closed"])
})

test("AudioStream.closed waits for reentrant disposal during source cleanup", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const failSource = deferred()
  const releaseReturn = deferred()
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let pulls = 0
  let returnStarted = false
  let stream!: AudioStream
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          pulls += 1
          if (pulls === 1) return { done: false as const, value: mp3 }
          await failSource.promise
          throw new Error("source failed")
        },
        async return() {
          returnStarted = true
          stream.dispose()
          await releaseReturn.promise
          return { done: true as const, value: undefined }
        },
      }
    },
  }

  stream = await audio.playStream(source, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
  })
  const order: string[] = []
  stream.on("disposed", () => {
    order.push("disposed")
  })
  void stream.closed.then(() => {
    order.push("closed")
  })

  failSource.resolve()
  await waitFor(
    () => returnStarted,
    "Source cleanup did not start",
    () => audio.mixFrames(256, 2),
  )
  await sleep(5)
  expect(order).toEqual([])
  releaseReturn.resolve()
  await stream.closed
  expect(order).toEqual(["disposed", "closed"])
})

test("AudioStream.closed waits for reentrant disposal during decoder-error cleanup", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_5S_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let stream!: AudioStream
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(mp3)
    },
    cancel() {
      stream.dispose()
    },
  })
  stream = await audio.playStream(source, {
    buffer: { capacityMs: 500, startupMs: 50, resumeMs: 50 },
  })
  const internals = stream as unknown as {
    engine: unknown
    nativeStreamId: number
    lib: {
      audioGetStreamStats: (...args: unknown[]) => {
        state: number
        errorCode: number
      } | null
    }
  }
  const originalGetStats = internals.lib.audioGetStreamStats
  const nativeStats = originalGetStats.call(internals.lib, internals.engine, internals.nativeStreamId)
  if (nativeStats == null) throw new Error("Native stream stats unavailable before fault injection")
  const restoreGetStats = replaceMethod(internals.lib, "audioGetStreamStats", () => ({
    ...nativeStats,
    state: NativeAudioStreamState.Failed,
    errorCode: -88,
  }))
  const order: string[] = []
  stream.on("error", () => {
    order.push("error")
  })
  stream.on("disposed", () => {
    order.push("disposed")
  })
  void stream.closed.then(() => {
    order.push("closed")
  })

  try {
    expect(stream.getStats().state).toBe("errored")
  } finally {
    restoreGetStats()
  }
  await stream.closed
  expect(order).toEqual(["disposed", "closed"])
})

test("Audio does not reacquire a source after cancellation during initial native polling", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let acquisitions = 0
  let returns = 0
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      acquisitions += 1
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return() {
          returns += 1
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
  const internals = audio as unknown as {
    lib: {
      audioGetStreamStats: (...args: unknown[]) => unknown
    }
  }
  const originalGetStats = internals.lib.audioGetStreamStats
  let disposed = false
  const restoreGetStats = replaceMethod(internals.lib, "audioGetStreamStats", (...args: unknown[]) => {
    const stats = originalGetStats.apply(internals.lib, args)
    if (!disposed) {
      disposed = true
      audio.dispose()
    }
    return stats
  })

  try {
    await expect(audio.playStream(source)).rejects.toHaveProperty("name", "AbortError")
  } finally {
    restoreGetStats()
  }
  expect(acquisitions).toBe(1)
  expect(returns).toBe(1)
})

test("Audio does not create a demuxer after cancellation during body classification", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  const controller = new AbortController()
  let demuxers = 0
  const body = {
    get getReader() {
      controller.abort()
      return () => {
        throw new Error("reader should not be acquired")
      }
    },
  } as unknown as ReadableStream<Uint8Array>
  const connector: AudioStreamConnector<void> = {
    async connect() {
      return { body, info: undefined }
    },
  }

  await expect(
    audio.playStreamSource(connector, {
      signal: controller.signal,
      demuxer() {
        demuxers += 1
        return null
      },
    }),
  ).rejects.toHaveProperty("name", "AbortError")
  expect(demuxers).toBe(0)
})

test("Audio snapshots URL reconnect options before requesting", async () => {
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  let reads = 0
  let requests = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => {
    requests += 1
    return Promise.reject(new Error("unexpected request"))
  }) as unknown as typeof fetch
  const reconnect = {
    maxRetries: 0,
    get maxDelayMs(): number {
      reads += 1
      return reads === 1 ? -1 : 100
    },
  }

  try {
    await expect(audio.playStreamUrl("https://example.test/radio", { reconnect })).rejects.toThrow(
      "reconnect.maxDelayMs",
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(reads).toBe(1)
  expect(requests).toBe(0)
})

test("Audio reads retryOnEnd once while resolving reconnect options", async () => {
  const mp3 = new Uint8Array(await readFile(MP3_URL))
  const audio = Audio.create({ autoStart: false })
  audios.push(audio)
  expect(audio.startMixer()).toBe(true)
  let reads = 0
  let connections = 0
  const reconnect = {
    maxRetries: 1,
    initialDelayMs: 0,
    maxDelayMs: 0,
    get retryOnEnd(): boolean {
      reads += 1
      return reads === 1 ? false : ("true" as unknown as boolean)
    },
  }
  const connector: AudioStreamConnector<void> = {
    async connect() {
      connections += 1
      return {
        info: undefined,
        body: (async function* () {
          yield mp3
        })(),
      }
    },
  }

  const stream = await audio.playStreamSource(connector, {
    buffer: { capacityMs: 250, startupMs: 25, resumeMs: 25 },
    reconnect,
  })
  await drainStream(audio, stream)
  expect(reads).toBe(1)
  expect(connections).toBe(1)
})
