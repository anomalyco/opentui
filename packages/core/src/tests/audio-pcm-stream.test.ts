import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { Audio, AudioStream, AudioStreamError, type AudioStreamOptions } from "../index.js"
import { resolveRenderLib } from "../zig.js"

const audios: Audio[] = []
const options: AudioStreamOptions = {
  format: "pcm",
  sampleFormat: "f32le",
  sampleRate: 48000,
  channels: 2,
  buffer: { capacityMs: 10, startupMs: 2, resumeMs: 2 },
}

function createAudio(sampleRate = 48000): Audio {
  const audio = Audio.create({ autoStart: false, sampleRate })
  audios.push(audio)
  audio.on("error", () => {})
  expect(audio.startMixer()).toBe(true)
  return audio
}

function pcm(samples: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(samples.length * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i], true)
  return bytes
}

async function* chunks(bytes: Uint8Array, size = bytes.length || 1) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}

function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return {
    body,
    push: (bytes: Uint8Array) => controller.enqueue(bytes),
    end: () => controller.close(),
    cancelled: () => cancelled,
  }
}

async function drive<M>(audio: Audio, stream: AudioStream<M>): Promise<Float32Array> {
  let done = false
  let failure: Error | undefined
  stream.on("error", (error) => {
    failure = error
  })
  void stream.closed.then(() => {
    done = true
  })
  const output: number[] = []
  for (let i = 0; i < 2000 && !done; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!done) output.push(...audio.mixFrames(128)!)
  }
  expect(done).toBe(true)
  if (failure) throw failure
  return new Float32Array(output)
}

async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("PCM test condition timed out")
}

afterEach(() => {
  for (const audio of audios.splice(0)) audio.dispose()
})

test("PCM uses the existing AudioStream and is ready before input arrives", async () => {
  const audio = createAudio()
  const input = source()
  const stream = await audio.playStream(input.body, options)
  expect(stream).toBeInstanceOf(AudioStream)
  expect(stream.format).toBe("pcm")
  expect(stream.state).toBe("buffering")
  expect(stream.getMetadata()).toBeNull()
  const frames = Float32Array.from({ length: 960 }, (_, i) => (i % 2 === 0 ? 0.25 : -0.5))
  input.push(pcm(frames))
  await until(() => stream.getStats().bufferedFrames === 480)
  expect(audio.enableTap(256)).toBe(true)
  const output = audio.mixFrames(128)!
  expect(output[2]).toBeCloseTo(0.25)
  expect(output[3]).toBeCloseTo(-0.5)
  expect(audio.readTapFrames(128)!.frames).toEqual(output)
  input.end()
  await drive(audio, stream)
  expect(stream.state).toBe("ended")
  expect(stream.getStats().bytesReceived).toBe(3840n)
  expect(stream.getStats().framesPlayed).toBe(480n)
  expect(audio.getStats()!.voicesActive).toBe(0)
})

test("PCM accepts offset byte views split inside samples and stereo frames", async () => {
  for (const size of [1, 3, 7, 9, 1024]) {
    const audio = createAudio()
    const bytes = pcm(Float32Array.from({ length: 480 }, (_, i) => (i % 2 === 0 ? 0.25 : -0.5)))
    const owner = new Uint8Array(bytes.length + 3)
    owner.set(bytes, 1)
    const stream = await audio.playStream(chunks(owner.subarray(1, 1 + bytes.length), size), options)
    const output = await drive(audio, stream)
    expect(output.some((sample) => sample === 0.25)).toBe(true)
    expect(output.some((sample) => sample === -0.5)).toBe(true)
    expect(stream.getStats().framesPlayed).toBe(240n)
  }
})

test("PCM byte accounting includes a pending fragment without converting it early", async () => {
  const audio = createAudio()
  const input = source()
  const stream = await audio.playStream(input.body, options)
  const bytes = pcm([0.25, -0.5])
  input.push(bytes.subarray(0, 3))
  await until(() => stream.getStats().bytesReceived === 3n)
  expect(stream.getStats().framesDecoded).toBe(0n)
  input.push(bytes.subarray(3))
  await until(() => stream.getStats().bytesReceived === 8n)
  input.end()
  const output = await drive(audio, stream)
  expect(output.some((sample) => sample === 0.25)).toBe(true)
  expect(stream.getStats().framesPlayed).toBe(1n)
})

test("shared stream pumping yields across small positive writes so cancellation can run", async () => {
  const audio = createAudio()
  const controller = new AbortController()
  let reads = 0
  async function* input() {
    const bytes = pcm([0.25, -0.5])
    for (; reads < 1024; reads++) yield bytes
  }
  const stream = await audio.playStream(input(), {
    ...options,
    buffer: { capacityMs: 100, startupMs: 1, resumeMs: 1 },
    signal: controller.signal,
  })
  const timer = setTimeout(() => controller.abort(), 0)
  try {
    await stream.closed
    expect(stream.state).toBe("disposed")
    expect(reads).toBeLessThan(1024)
  } finally {
    clearTimeout(timer)
  }
})

test("PCM backpressures source reads and releases borrowed chunks before advancing", async () => {
  const audio = createAudio()
  let reads = 0
  async function* input() {
    // Exceed the shared 256 KiB input queue plus the bounded worker batch/output ring.
    const bytes = pcm(new Float32Array(100000).fill(0.125))
    reads++
    yield bytes
    bytes.fill(0)
    reads++
    yield pcm(new Float32Array(2).fill(0.25))
  }
  const stream = await audio.playStream(input(), options)
  await until(() => stream.getStats().bufferedFrames === 480)
  expect(reads).toBe(1)
  const output = await drive(audio, stream)
  expect(reads).toBe(2)
  expect(stream.getStats().framesPlayed).toBe(50001n)
  expect(output.filter((sample) => sample === 0.125).length).toBe(100000)
})

test("PCM shares stream, group and master controls", async () => {
  const audio = createAudio()
  const input = source()
  const group = audio.group("pcm")!
  audio.setGroupVolume(group, 0.5)
  audio.setMasterVolume(0.5)
  const stream = await audio.playStream(input.body, options)
  expect(stream.setGroup(group)).toBe(true)
  expect(stream.setVolume(0.5)).toBe(true)
  expect(stream.setPan(-1)).toBe(true)
  input.push(pcm(new Float32Array(960).fill(0.5)))
  await until(() => stream.getStats().bufferedFrames === 480)
  const output = audio.mixFrames(128)!
  expect(output[254]).toBeCloseTo(0.0625)
  expect(output[255]).toBe(0)
  stream.dispose()
  await stream.closed
  expect(input.cancelled()).toBe(true)
})

for (const [inputRate, outputRate] of [
  [8000, 48000],
  [44100, 48000],
  [48000, 44100],
  [96000, 48000],
  [192000, 8000],
]) {
  test(`PCM ${inputRate} to ${outputRate} preserves tone and fragmented conversion continuity`, async () => {
    const bytes = pcm(
      Float32Array.from({ length: inputRate * 0.04 }, (_, i) => Math.sin((2 * Math.PI * 500 * i) / inputRate) * 0.25),
    )
    async function render(size: number) {
      const audio = createAudio(outputRate)
      const stream = await audio.playStream(chunks(bytes, size), {
        ...options,
        sampleRate: inputRate,
        channels: 1,
        buffer: { capacityMs: 100, startupMs: 1, resumeMs: 1 },
      })
      // Let the finite source reach EOF before comparing samples; mixing during ingestion would add underrun silence.
      await until(() => stream.getStats().bytesReceived === BigInt(bytes.length))
      const output = await drive(audio, stream)
      const stats = stream.getStats()
      expect(stats.framesPlayed).toBe(stats.framesDecoded)
      expect(Number(stats.framesPlayed)).toBeGreaterThanOrEqual(Math.floor(outputRate * 0.04))
      expect(Number(stats.framesPlayed)).toBeLessThan(Math.ceil(outputRate * 0.045))
      const audible = output.slice(0, Number(stats.framesPlayed) * 2)
      let crossings = 0
      for (let i = 2; i < audible.length; i += 2) {
        expect(audible[i]).toBeCloseTo(audible[i + 1], 6)
        if (audible[i - 2] < 0 && audible[i] >= 0) crossings++
      }
      expect(crossings).toBeGreaterThanOrEqual(19)
      expect(crossings).toBeLessThanOrEqual(21)
      return audible
    }
    const whole = await render(bytes.length)
    const fragmented = await render(7)
    expect(fragmented.length).toBe(whole.length)
    for (let i = 0; i < whole.length; i++) expect(fragmented[i]).toBeCloseTo(whole[i], 5)
  })
}

test("PCM EOF flushes a sub-frame downsampling tail instead of playing only silence", async () => {
  const audio = createAudio(8000)
  const stream = await audio.playStream(chunks(pcm(new Float32Array(24).fill(0.5))), {
    ...options,
    sampleRate: 192000,
    channels: 1,
  })
  const output = await drive(audio, stream)
  expect(output.some((sample) => sample > 0.4)).toBe(true)
  expect(stream.getStats().framesPlayed).toBe(2n)
})

test("PCM rejects an incomplete final frame and non-finite samples through shared error events", async () => {
  for (const bytes of [new Uint8Array(7), pcm([Infinity, 0]), pcm([NaN, 0])]) {
    const audio = createAudio()
    const input = source()
    const stream = await audio.playStream(input.body, options)
    const errors: Error[] = []
    stream.on("error", (error) => errors.push(error))
    input.push(bytes)
    input.end()
    await stream.closed
    expect(stream.state).toBe("errored")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(AudioStreamError)
    expect(audio.getStats()!.voicesActive).toBe(0)
  }
})

test("PCM validates options before acquiring a source", async () => {
  const audio = createAudio()
  let acquired = false
  const input = {
    [Symbol.asyncIterator]() {
      acquired = true
      return {
        async next() {
          return { done: true as const, value: undefined }
        },
      }
    },
  }
  for (const invalid of [
    { sampleRate: undefined },
    { sampleRate: NaN },
    { sampleRate: 7999 },
    { sampleRate: 192001 },
    { channels: 3 },
    { sampleFormat: undefined },
    { sampleFormat: "s16le" },
    { reconnect: {} },
  ]) {
    await expect(audio.playStream(input, { ...options, ...invalid } as any)).rejects.toThrow()
  }
  await expect(audio.playStream(input, { format: "mp3", sampleRate: 48000 })).rejects.toThrow("only supported for PCM")
  expect(acquired).toBe(false)
})

test("PCM empty EOF finishes without a mixer", async () => {
  const audio = createAudio()
  audio.stop()
  const stream = await audio.playStream(chunks(new Uint8Array()), options)
  await stream.closed
  expect(stream.state).toBe("ended")
  expect(stream.getStats().framesDecoded).toBe(0n)
})

test("PCM cancellation interrupts pending reads and backpressure and releases the shared voice", async () => {
  for (const mode of ["stream", "owner", "signal"] as const) {
    for (const blocked of [false, true]) {
      const audio = createAudio()
      const input = source()
      const controller = new AbortController()
      const stream = await audio.playStream(input.body, { ...options, signal: controller.signal })
      if (blocked) {
        input.push(pcm(new Float32Array(10000)))
        await until(() => stream.getStats().bufferedFrames === 480)
      }
      if (mode === "stream") stream.dispose()
      else if (mode === "owner") audio.dispose()
      else controller.abort()
      await stream.closed
      expect(stream.state).toBe("disposed")
      expect(input.cancelled()).toBe(true)
    }
  }
})

test("PCM uses custom source/demuxer and URL stream entry points", async () => {
  const audio = createAudio()
  const bytes = pcm(new Float32Array(192).fill(0.25))
  const stream = await audio.playStreamSource(
    {
      async connect() {
        return { body: chunks(bytes, 3), info: "pcm" }
      },
    },
    {
      ...options,
      demuxer: (info) => ({ initialMetadata: info, push: (data) => [{ type: "audio", data }], flush: () => [] }),
    },
  )
  expect(stream.getMetadata()).toBe("pcm")
  await drive(audio, stream)
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" })
    response.end(bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address() as { port: number }
    const remote = await audio.playStreamUrl(`http://127.0.0.1:${address.port}`, options)
    await drive(audio, remote)
    expect(remote.getStats().bytesReceived).toBe(BigInt(bytes.length))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("PCM native close failure retains owner cleanup for retry", async () => {
  const audio = createAudio()
  const input = source()
  const stream = await audio.playStream(input.body, options)
  const lib = resolveRenderLib()
  const original = lib.audioCloseStream
  lib.audioCloseStream = () => ({ status: -5, stats: null })
  try {
    expect(() => audio.dispose()).toThrow("destroy failed")
  } finally {
    lib.audioCloseStream = original
  }
  audio.dispose()
  await stream.closed
  expect(stream.state).toBe("disposed")
})
