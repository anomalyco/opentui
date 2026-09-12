import { afterEach, expect, test } from "bun:test"
import {
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rename as renameFile,
  rm,
  unlink as unlinkFile,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Audio,
  AudioCaptureStreamError,
  AudioInitializationError,
  AudioRecorder,
  AudioRecorderError,
  setupAudio,
} from "../audio.js"
import { NativeAudioStreamFormat, resolveRenderLib } from "../zig.js"

const SAMPLE_RATE = 48_000
const audioRecorderTestRoot = process.env.OTUI_AUDIO_RECORDER_TEST_TMPDIR ?? tmpdir()

function buildPcm16Wav(samples: number[], channels: number): Uint8Array {
  if (channels <= 0 || samples.length % channels !== 0) {
    throw new Error(`Invalid PCM payload for channel count ${channels}`)
  }

  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const frameCount = samples.length / channels
  const dataSize = frameCount * channels * bytesPerSample
  const byteRate = SAMPLE_RATE * channels * bytesPerSample
  const blockAlign = channels * bytesPerSample
  const totalSize = 44 + dataSize
  const out = new Uint8Array(totalSize)
  const view = new DataView(out.buffer)

  out.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  view.setUint32(4, totalSize - 8, true)
  out.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  out.set([0x66, 0x6d, 0x74, 0x20], 12) // fmt
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  out.set([0x64, 0x61, 0x74, 0x61], 36) // data
  view.setUint32(40, dataSize, true)

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true)
  }

  return out
}

function buildMonoPcm16Wav(samples: number[]): Uint8Array {
  return buildPcm16Wav(samples, 1)
}

const instances: Audio[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.dispose()
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function createRecorderTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(audioRecorderTestRoot, "opentui-audio-recorder-"))
  temporaryDirectories.push(directory)
  return directory
}

function getRecorderFileSystem(): {
  open: typeof openFile
  rename: typeof renameFile
  unlink: typeof unlinkFile
} {
  return (
    AudioRecorder as unknown as {
      fileSystem: {
        open: typeof openFile
        rename: typeof renameFile
        unlink: typeof unlinkFile
      }
    }
  ).fileSystem
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 1000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message)
    await sleep(5)
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject")
}

function replaceCaptureRing(initialSamples: number[], channels: number = 1) {
  const lib = resolveRenderLib()
  const samples = [...initialSamples]
  const starts: Array<{ channels: number; capacityFrames: number }> = []
  let framesReceived = BigInt(Math.floor(samples.length / channels))
  let framesRead = 0n
  let framesDropped = 0n
  let reads = 0
  let running = false
  let sampleRate = SAMPLE_RATE
  let capacityFrames = SAMPLE_RATE
  const restores = [
    replaceMethod(
      lib,
      "audioStartCapture",
      (_engine: unknown, _options: unknown, nextChannels: number, nextCapacityFrames: number) => {
        channels = nextChannels
        capacityFrames = nextCapacityFrames
        starts.push({ channels, capacityFrames })
        running = true
        return 0
      },
    ),
    replaceMethod(lib, "audioStopCapture", () => {
      running = false
      return 0
    }),
    replaceMethod(lib, "audioIsCaptureRunning", () => running),
    replaceMethod(lib, "audioReadCapture", (_engine: unknown, output: Float32Array, frameCount: number) => {
      reads += 1
      const availableFrames = Math.floor(samples.length / channels)
      const readFrames = Math.min(frameCount, availableFrames)
      output.set(samples.splice(0, readFrames * channels))
      framesRead += BigInt(readFrames)
      return { status: 0, framesRead: readFrames }
    }),
    replaceMethod(lib, "audioGetCaptureStats", () => ({
      status: 0,
      stats: {
        framesReceived,
        framesRead,
        framesDropped,
        sampleRate,
        channels,
        bufferedFrames: Math.floor(samples.length / channels),
        capacityFrames,
      },
    })),
  ]
  return {
    samples,
    starts,
    get reads() {
      return reads
    },
    set running(value: boolean) {
      running = value
    },
    set framesDropped(value: bigint) {
      framesDropped = value
    },
    receive(nextSamples: number[]) {
      samples.push(...nextSamples)
      framesReceived += BigInt(Math.floor(nextSamples.length / channels))
    },
    restore() {
      for (const restore of restores.reverse()) restore()
    },
  }
}

function captureAudioEvents(run: () => void): string[] {
  const events: string[] = []
  const restoreEmit = replaceMethod(Audio.prototype, "emit", (event: string) => {
    events.push(event)
    return false
  })
  try {
    run()
  } finally {
    restoreEmit()
  }
  return events
}

test("Audio.create throws synchronously when engine creation fails", () => {
  let thrown: unknown
  const events = captureAudioEvents(() => {
    try {
      Audio.create({ playbackChannels: 0xffffffff })
    } catch (error) {
      thrown = error
    }
  })

  expect(thrown).toBeInstanceOf(AudioInitializationError)
  expect((thrown as AudioInitializationError).action).toBe("createAudioEngine")
  expect(events).toEqual([])
})

test("setupAudio uses the same synchronous initialization contract", () => {
  expect(() => setupAudio({ playbackChannels: 0xffffffff })).toThrow(AudioInitializationError)
})

test("Audio auto-start failure throws and destroys the native engine", () => {
  const lib = resolveRenderLib()
  const originalDestroy = lib.destroyAudioEngine
  let destroyCalls = 0
  let thrown: unknown

  const restoreStart = replaceMethod(lib, "audioStart", () => -5)
  const restoreDestroy = replaceMethod(lib, "destroyAudioEngine", (engine: Parameters<typeof originalDestroy>[0]) => {
    destroyCalls += 1
    originalDestroy.call(lib, engine)
  })
  try {
    const events = captureAudioEvents(() => {
      try {
        Audio.create({ autoStart: true })
      } catch (error) {
        thrown = error
      }
    })
    expect(events).toEqual([])
  } finally {
    restoreDestroy()
    restoreStart()
  }

  expect(thrown).toBeInstanceOf(AudioInitializationError)
  expect((thrown as AudioInitializationError).action).toBe("start")
  expect((thrown as AudioInitializationError).status).toBe(-5)
  expect(destroyCalls).toBe(1)
})

test("Audio wraps an auto-start option packing failure and destroys the native engine", () => {
  const lib = resolveRenderLib()
  const originalCreate = lib.createAudioEngine
  const originalDestroy = lib.destroyAudioEngine
  const startFailure = new Error("start option getter failed")
  const startOptions = Object.defineProperty({}, "periodSizeInFrames", {
    get() {
      throw startFailure
    },
  })
  let createdEngine: ReturnType<typeof originalCreate> = null
  let destroyCalls = 0
  let thrown: unknown

  const restoreCreate = replaceMethod(lib, "createAudioEngine", (options: Parameters<typeof originalCreate>[0]) => {
    createdEngine = originalCreate.call(lib, options)
    return createdEngine
  })
  const restoreDestroy = replaceMethod(lib, "destroyAudioEngine", (engine: Parameters<typeof originalDestroy>[0]) => {
    destroyCalls += 1
    originalDestroy.call(lib, engine)
  })

  try {
    try {
      Audio.create({ autoStart: true, startOptions })
    } catch (error) {
      thrown = error
    }
  } finally {
    restoreDestroy()
    restoreCreate()
    if (createdEngine != null && destroyCalls === 0) originalDestroy.call(lib, createdEngine)
  }

  expect({
    wrapped: thrown instanceof AudioInitializationError,
    action: thrown instanceof AudioInitializationError ? thrown.action : undefined,
    status: thrown instanceof AudioInitializationError ? thrown.status : undefined,
    destroyCalls,
  }).toEqual({ wrapped: true, action: "start", status: -1, destroyCalls: 1 })
})

test("Audio.start reports an option packing failure through its status contract", () => {
  const packingFailure = new Error("start option getter failed")
  const startOptions = Object.defineProperty({}, "periodSizeInFrames", {
    get() {
      throw packingFailure
    },
  })
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)
  const errors: unknown[] = []
  audio.on("error", (error, context) => {
    errors.push({ message: error.message, context })
  })

  expect(audio.start(startOptions)).toBe(false)
  expect(audio.isStarted()).toBe(false)
  expect(audio.isMixerStarted()).toBe(false)
  expect(errors).toEqual([{ message: "Audio start failed: -1", context: { action: "start", status: -1 } }])
})

test("Audio auto-start success updates started state", () => {
  const lib = resolveRenderLib()
  let audio!: Audio
  const restoreStart = replaceMethod(lib, "audioStart", () => 0)
  try {
    const events = captureAudioEvents(() => {
      audio = Audio.create({ autoStart: true })
    })
    expect(events).toEqual([])
  } finally {
    restoreStart()
  }

  expect(audio.isStarted()).toBe(true)
  expect(audio.isMixerStarted()).toBe(true)
  instances.push(audio)
})

test("Audio explicit start emits started after construction", () => {
  const lib = resolveRenderLib()
  const restoreStart = replaceMethod(lib, "audioStart", () => 0)
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    let startedEvents = 0
    audio.on("started", () => {
      startedEvents += 1
    })

    expect(audio.start()).toBe(true)
    expect(startedEvents).toBe(1)
  } finally {
    restoreStart()
  }
})

test("Audio loads wav and mixes frames", () => {
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)

  const wav = buildMonoPcm16Wav([0, 0.25, -0.25, 0.5, -0.5, 0])
  const sound = audio.loadSound(wav)
  const sfx = audio.group("sfx")

  expect(sound).not.toBeNull()
  expect(sfx).not.toBeNull()
  if (sound == null || sfx == null) return

  expect(audio.startMixer()).toBe(true)
  const voice = audio.play(sound, { groupId: sfx, volume: 1, pan: 0, loop: false })
  expect(voice).not.toBeNull()
  const mixed = audio.mixFrames(6, 2)

  expect(mixed).not.toBeNull()
  if (!mixed) return
  expect(mixed.length).toBe(12)
  expect(mixed.some((sample) => Math.abs(sample) > 0.001)).toBe(true)
  expect(audio.getStats()?.soundsLoaded).toBe(1)
})

test("Audio does not auto-start by default", () => {
  const audio = Audio.create()
  instances.push(audio)

  expect(audio.isStarted()).toBe(false)
  expect(audio.isMixerStarted()).toBe(false)
})

test("Audio start reports playback availability only", () => {
  const audio = Audio.create({ autoStart: false })
  audio.on("error", () => {})
  instances.push(audio)

  expect(audio.isStarted()).toBe(false)
  expect(audio.isMixerStarted()).toBe(false)
  let startedEvents = 0
  audio.on("started", () => {
    startedEvents += 1
  })

  const started = audio.start()
  expect(audio.isStarted()).toBe(started)
  expect(audio.isMixerStarted()).toBe(started)
  expect(startedEvents).toBe(started ? 1 : 0)
})

test("Audio startMixer enables headless mixing without playback", () => {
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)

  const wav = buildMonoPcm16Wav([0, 0.25, -0.25, 0.5, -0.5, 0])
  const sound = audio.loadSound(wav)
  expect(sound).not.toBeNull()
  if (sound == null) return

  expect(audio.startMixer()).toBe(true)
  expect(audio.isStarted()).toBe(false)
  expect(audio.isMixerStarted()).toBe(true)

  const voice = audio.play(sound, { volume: 1, loop: true })
  expect(voice).not.toBeNull()

  const mixed = audio.mixFrames(6, 2)
  expect(mixed).not.toBeNull()
  expect(mixed?.some((sample) => Math.abs(sample) > 0.001)).toBe(true)

  expect(audio.stop()).toBe(true)
  expect(audio.isStarted()).toBe(false)
  expect(audio.isMixerStarted()).toBe(false)
})

test("Audio unloads sounds and invalidates old handles", () => {
  const audio = Audio.create({ autoStart: false })
  audio.on("error", () => {})
  instances.push(audio)

  const first = audio.loadSound(buildMonoPcm16Wav([0, 0.25, -0.25, 0.5, -0.5, 0]))
  expect(first).not.toBeNull()
  if (first == null) return

  expect(audio.startMixer()).toBe(true)
  const firstVoice = audio.play(first, { volume: 1, pan: 0, loop: true })
  expect(firstVoice).not.toBeNull()
  expect(audio.getStats()?.voicesActive).toBeGreaterThan(0)

  expect(audio.unloadSound(first)).toBe(true)
  expect(audio.getStats()?.soundsLoaded).toBe(0)
  expect(audio.getStats()?.voicesActive).toBe(0)
  expect(audio.play(first, { volume: 1 })).toBeNull()
  expect(audio.unloadSound(first)).toBe(false)

  const second = audio.loadSound(buildMonoPcm16Wav([0.6, -0.2, 0.4, -0.4, 0.3, -0.1]))
  expect(second).not.toBeNull()
  if (second == null) return
  expect(second).not.toBe(first)

  const secondVoice = audio.play(second, { volume: 1, pan: 0, loop: false })
  expect(secondVoice).not.toBeNull()
})

test("Audio mixes into mono and multichannel output buffers", () => {
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)

  const wav = buildMonoPcm16Wav([0.6, -0.2, 0.4, -0.4, 0.3, -0.1])
  const sound = audio.loadSound(wav)
  expect(sound).not.toBeNull()
  if (sound == null) return

  expect(audio.startMixer()).toBe(true)
  const voice = audio.play(sound, { volume: 1, pan: 0, loop: true })
  expect(voice).not.toBeNull()

  const mono = audio.mixFrames(6, 1)
  expect(mono).not.toBeNull()
  if (!mono) return
  expect(mono.length).toBe(6)
  expect(mono.some((sample) => Math.abs(sample) > 0.001)).toBe(true)

  const quad = audio.mixFrames(6, 4)
  expect(quad).not.toBeNull()
  if (!quad) return
  expect(quad.length).toBe(24)
  expect(quad.some((sample, index) => index % 4 < 2 && Math.abs(sample) > 0.001)).toBe(true)
  for (let frame = 0; frame < 6; frame += 1) {
    expect(quad[frame * 4 + 2]).toBe(0)
    expect(quad[frame * 4 + 3]).toBe(0)
  }
})

test("Audio updates mix stats", () => {
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)

  const wave = Array.from({ length: 2048 }, (_, index) => Math.sin((Math.PI * 2 * index) / 32) * 0.8)
  const wav = buildMonoPcm16Wav(wave)
  const sound = audio.loadSound(wav)
  expect(sound).not.toBeNull()
  if (sound == null) return

  expect(audio.startMixer()).toBe(true)
  const voice = audio.play(sound, { volume: 1, pan: 0, loop: true })
  expect(voice).not.toBeNull()

  const initialStats = audio.getStats()
  expect(initialStats).not.toBeNull()
  const initialFrames = initialStats?.framesMixed ?? 0n

  const mixed = audio.mixFrames(512, 2)
  expect(mixed).not.toBeNull()

  const finalStats = audio.getStats()
  expect(finalStats).not.toBeNull()
  expect(finalStats?.framesMixed ?? 0n).toBeGreaterThan(initialFrames)
  expect(finalStats?.voicesActive ?? 0).toBeGreaterThan(0)
})

test("Audio tap mirrors mixed frames without consuming stream", () => {
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)

  const wav = buildMonoPcm16Wav([0, 0.5, -0.5, 0.25, -0.25, 0])
  const sound = audio.loadSound(wav)
  expect(sound).not.toBeNull()
  if (sound == null) return

  expect(audio.startMixer()).toBe(true)
  expect(audio.enableTap(2048)).toBe(true)
  const voice = audio.play(sound, { volume: 1, pan: 0, loop: true })
  expect(voice).not.toBeNull()

  const mixed = audio.mixFrames(256, 2)
  expect(mixed).not.toBeNull()

  const tap = audio.readTapFrames(128, 2)
  expect(tap).not.toBeNull()
  if (!tap) return

  expect(tap.framesRead).toBeGreaterThan(0)
  expect(tap.frames.length).toBe(256)
  expect(tap.frames.some((sample) => Math.abs(sample) > 0.001)).toBe(true)

  expect(audio.disableTap()).toBe(true)
})

test("Audio supports immutable custom sample rate", () => {
  const audio = Audio.create({ autoStart: false, sampleRate: 44_100, playbackChannels: 1 })
  instances.push(audio)

  const wav = buildMonoPcm16Wav([0.3, -0.3, 0.2, -0.2, 0.1, -0.1])
  const sound = audio.loadSound(wav)
  expect(sound).not.toBeNull()
  if (sound == null) return

  expect(audio.startMixer()).toBe(true)
  const voice = audio.play(sound, { volume: 1, pan: 0, loop: true })
  expect(voice).not.toBeNull()

  const mixed = audio.mixFrames(128, 2)
  expect(mixed).not.toBeNull()
  if (!mixed) return
  expect(mixed.some((sample) => Math.abs(sample) > 0.001)).toBe(true)
})

test("audioLoad rejects oversized payload lengths before truncating to u32", () => {
  const lib = resolveRenderLib()
  const engine = lib.createAudioEngine()
  expect(engine).not.toBeNull()
  if (engine == null) return

  const oversized = {
    buffer: new ArrayBuffer(1),
    byteOffset: 0,
    byteLength: 0x1_0000_0000,
    length: 0x1_0000_0000,
  } as unknown as Uint8Array

  try {
    expect(() => lib.audioLoad(engine, oversized)).toThrow("Audio data length exceeds native u32 length limit")
  } finally {
    lib.destroyAudioEngine(engine)
  }
})

test("audioWriteStream rejects oversized payload lengths before truncating to u32", () => {
  const lib = resolveRenderLib()
  const engine = lib.createAudioEngine()
  expect(engine).not.toBeNull()
  if (engine == null) return

  const oversized = {
    buffer: new ArrayBuffer(1),
    byteOffset: 0,
    byteLength: 0x1_0000_0000,
    length: 0x1_0000_0000,
  } as unknown as Uint8Array

  try {
    expect(() => lib.audioWriteStream(engine, 1, oversized)).toThrow(
      "Audio stream data length exceeds native u32 length limit",
    )
  } finally {
    lib.destroyAudioEngine(engine)
  }
})

test("audio stream wrappers reject a destroyed engine handle", () => {
  const lib = resolveRenderLib()
  const engine = lib.createAudioEngine()
  expect(engine).not.toBeNull()
  if (engine == null) return
  lib.destroyAudioEngine(engine)

  expect(
    lib.audioCreateStream(engine, {
      capacityMs: 100,
      startupMs: 10,
      resumeMs: 10,
      volume: 1,
      pan: 0,
      groupId: 0,
      maxProbeBytes: 1024 * 1024,
      format: NativeAudioStreamFormat.Mp3,
    }),
  ).toEqual({ status: -1, streamId: null })
  expect(lib.audioWriteStream(engine, 1, new Uint8Array())).toBe(-1)
  expect(lib.audioEndStream(engine, 1)).toBe(-1)
  expect(lib.audioRestartStream(engine, 1)).toBe(-1)
  expect(lib.audioSetStreamVolume(engine, 1, 1)).toBe(-1)
  expect(lib.audioSetStreamPan(engine, 1, 0)).toBe(-1)
  expect(lib.audioSetStreamGroup(engine, 1, 0)).toBe(-1)
  expect(lib.audioGetStreamStats(engine, 1)).toBeNull()
  expect(lib.audioCloseStream(engine, 1, 2)).toEqual({ status: -1, stats: null })
})

test("audioCreateGroup rejects oversized encoded name lengths before truncating to u32", () => {
  const lib = resolveRenderLib()
  const engine = lib.createAudioEngine()
  expect(engine).not.toBeNull()
  if (engine == null) return

  const originalEncode = lib.encoder.encode
  const oversized = {
    buffer: new ArrayBuffer(1),
    byteOffset: 0,
    byteLength: 0x1_0000_0000,
    length: 0x1_0000_0000,
  } as unknown as Uint8Array

  ;(lib.encoder as { encode: (input: string) => Uint8Array }).encode = () => oversized

  try {
    expect(() => lib.audioCreateGroup(engine, "oversized")).toThrow(
      "Audio group name length exceeds native u32 length limit",
    )
  } finally {
    ;(lib.encoder as { encode: (input: string) => Uint8Array }).encode = originalEncode
    lib.destroyAudioEngine(engine)
  }
})

test("Audio capture applies defaults, honors explicit options, and emits lifecycle events once", () => {
  const lib = resolveRenderLib()
  const starts: Array<{ options: unknown; channels: number; capacityFrames: number }> = []
  let stopCalls = 0
  let running = false
  const restoreStart = replaceMethod(
    lib,
    "audioStartCapture",
    (_engine: unknown, options: unknown, channels: number, capacityFrames: number) => {
      starts.push({ options, channels, capacityFrames })
      running = true
      return 0
    },
  )
  const restoreStop = replaceMethod(lib, "audioStopCapture", () => {
    stopCalls += 1
    running = false
    return 0
  })
  const restoreRunning = replaceMethod(lib, "audioIsCaptureRunning", () => running)

  try {
    const audio = Audio.create({ autoStart: false, sampleRate: 44_100 })
    instances.push(audio)
    const events: string[] = []
    audio.on("captureStarted", () => events.push("started"))
    audio.on("captureStopped", () => events.push("stopped"))

    expect(audio.startCapture()).toBe(true)
    expect(audio.startCapture()).toBe(true)
    expect(starts).toEqual([{ options: undefined, channels: 1, capacityFrames: 44_100 }])
    expect(audio.isCapturing()).toBe(true)

    expect(audio.stopCapture()).toBe(true)
    expect(audio.stopCapture()).toBe(true)
    expect(stopCalls).toBe(1)
    expect(audio.isCapturing()).toBe(false)

    expect(
      audio.startCapture({
        channels: 2,
        capacityFrames: 12,
        startOptions: { periods: 3, noFixedSizedCallback: false },
      }),
    ).toBe(true)
    expect(starts[1]).toEqual({
      options: { periods: 3, noFixedSizedCallback: false },
      channels: 2,
      capacityFrames: 12,
    })
    expect(events).toEqual(["started", "stopped", "started"])
  } finally {
    restoreRunning()
    restoreStop()
    restoreStart()
  }
})

test("Audio capture validates explicit options while active", () => {
  const lib = resolveRenderLib()
  let running = false
  let startCalls = 0
  const restores = [
    replaceMethod(lib, "audioStartCapture", () => {
      startCalls += 1
      running = true
      return 0
    }),
    replaceMethod(lib, "audioIsCaptureRunning", () => running),
    replaceMethod(lib, "audioStopCapture", () => {
      running = false
      return 0
    }),
  ]

  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    audio.on("error", () => {})

    expect(audio.startCapture({ channels: 1, capacityFrames: 8 })).toBe(true)
    expect(() => audio.startCapture({ channels: 0 })).toThrow(TypeError)
    expect(() => audio.startCapture({ capacityFrames: Number.NaN })).toThrow(TypeError)
    expect(startCalls).toBe(1)
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test("Audio capture rejects explicit reconfiguration while active", () => {
  const lib = resolveRenderLib()
  let running = false
  let startCalls = 0
  const restores = [
    replaceMethod(lib, "audioStartCapture", () => {
      startCalls += 1
      running = true
      return 0
    }),
    replaceMethod(lib, "audioIsCaptureRunning", () => running),
    replaceMethod(lib, "audioStopCapture", () => {
      running = false
      return 0
    }),
  ]

  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const errors: Array<{ message: string; action: string }> = []
    audio.on("error", (error, context) => errors.push({ message: error.message, action: context.action }))

    expect(audio.startCapture({ channels: 1, capacityFrames: 8 })).toBe(true)
    expect(audio.startCapture()).toBe(true)
    expect(audio.startCapture({ channels: 1, capacityFrames: 8 })).toBe(true)
    expect(audio.startCapture({ channels: 2 })).toBe(false)
    expect(audio.startCapture({ capacityFrames: 16 })).toBe(false)
    expect(audio.startCapture({ startOptions: { periods: 3 } })).toBe(false)

    expect(startCalls).toBe(1)
    expect(errors).toEqual([
      { message: "Audio capture is already running with a different configuration", action: "startCapture" },
      { message: "Audio capture is already running with a different configuration", action: "startCapture" },
      { message: "Audio capture is already running with a different configuration", action: "startCapture" },
    ])
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test("Audio capture validates dimensions before allocation or native calls", () => {
  const lib = resolveRenderLib()
  let startCalls = 0
  let readCalls = 0
  const restoreStart = replaceMethod(lib, "audioStartCapture", () => {
    startCalls += 1
    return 0
  })
  const restoreRead = replaceMethod(lib, "audioReadCapture", () => {
    readCalls += 1
    return { status: 0, framesRead: 0 }
  })

  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)

    for (const channels of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1]) {
      expect(() => audio.startCapture({ channels })).toThrow(TypeError)
    }
    expect(() => audio.startCapture({ channels: 0x1_0000_0000 })).toThrow(RangeError)
    for (const capacityFrames of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1]) {
      expect(() => audio.startCapture({ capacityFrames })).toThrow(TypeError)
    }
    expect(() => audio.startCapture({ capacityFrames: 0x1_0000_0000 })).toThrow(RangeError)
    expect(startCalls).toBe(0)

    expect(audio.startCapture({ channels: 2 })).toBe(true)
    expect(startCalls).toBe(1)
    for (const frameCount of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1]) {
      expect(() => audio.readCaptureFrames(frameCount)).toThrow(TypeError)
    }
    expect(() => audio.readCaptureFrames(0x1_0000_0000)).toThrow(RangeError)
    expect(() => audio.readCaptureFrames(0xffffffff)).toThrow(RangeError)
    expect(readCalls).toBe(0)
  } finally {
    restoreRead()
    restoreStart()
  }
})

test("Audio capture device methods mirror playback device mapping and selection", () => {
  const lib = resolveRenderLib()
  const selected: number[] = []
  let refreshCalls = 0
  let deviceNames = ["Built-in Mic", "USB Mic"]
  let clearCalls = 0
  const restores = [
    replaceMethod(lib, "audioRefreshCaptureDevices", () => {
      refreshCalls += 1
      return 0
    }),
    replaceMethod(lib, "audioGetCaptureDeviceCount", () => 2),
    replaceMethod(lib, "audioGetCaptureDeviceName", (_engine: unknown, index: number) => deviceNames[index]),
    replaceMethod(lib, "audioIsCaptureDeviceDefault", (_engine: unknown, index: number) => index === 0),
    replaceMethod(lib, "audioSelectCaptureDevice", (_engine: unknown, index: number) => {
      selected.push(index)
      return 0
    }),
    replaceMethod(lib, "audioClearCaptureDeviceSelection", () => {
      clearCalls += 1
    }),
  ]

  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    expect(audio.listCaptureDevices()).toEqual([
      { index: 0, name: "Built-in Mic", isDefault: true },
      { index: 1, name: "USB Mic", isDefault: false },
    ])
    expect(audio.selectCaptureDevice(1)).toBe(true)
    expect(refreshCalls).toBe(1)
    expect(selected).toEqual([1])

    deviceNames = ["USB Mic", "USB Mic"]
    expect(audio.listCaptureDevices()).toEqual([
      { index: 0, name: "USB Mic", isDefault: true },
      { index: 1, name: "USB Mic", isDefault: false },
    ])
    expect(refreshCalls).toBe(2)
    expect(selected).toEqual([1])
    expect(audio.selectCaptureDevice(0)).toBe(true)
    expect(selected).toEqual([1, 0])

    for (const index of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      expect(() => audio.selectCaptureDevice(index)).toThrow(TypeError)
    }
    expect(() => audio.selectCaptureDevice(0x1_0000_0000)).toThrow(RangeError)
    audio.clearCaptureDeviceSelection()
    expect(selected).toEqual([1, 0])
    expect(clearCalls).toBe(1)
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test("Audio capture reports status failures through Audio.error", () => {
  const lib = resolveRenderLib()
  let refreshStatus = -2
  let startStatus = -3
  let stopStatus = -6
  const restores = [
    replaceMethod(lib, "audioRefreshCaptureDevices", () => refreshStatus),
    replaceMethod(lib, "audioStartCapture", () => startStatus),
    replaceMethod(lib, "audioReadCapture", () => ({ status: -4, framesRead: 0 })),
    replaceMethod(lib, "audioGetCaptureStats", () => ({ status: -5, stats: null })),
    replaceMethod(lib, "audioStopCapture", () => stopStatus),
    replaceMethod(lib, "audioIsCaptureRunning", () => true),
  ]

  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const errors: unknown[] = []
    audio.on("error", (error, context) => errors.push({ message: error.message, context }))

    expect(audio.listCaptureDevices()).toBeNull()
    refreshStatus = 0
    expect(audio.startCapture()).toBe(false)
    startStatus = 0
    expect(audio.startCapture()).toBe(true)
    expect(audio.readCaptureFrames(1)).toBeNull()
    expect(audio.getCaptureStats()).toBeNull()
    expect(audio.stopCapture()).toBe(false)
    expect(audio.isCapturing()).toBe(true)
    expect(errors).toEqual([
      { message: "Audio listCaptureDevices failed: -2", context: { action: "listCaptureDevices", status: -2 } },
      { message: "Audio startCapture failed: -3", context: { action: "startCapture", status: -3 } },
      { message: "Audio readCaptureFrames failed: -4", context: { action: "readCaptureFrames", status: -4 } },
      { message: "Audio getCaptureStats failed: -5", context: { action: "getCaptureStats", status: -5 } },
      { message: "Audio stopCapture failed: -6", context: { action: "stopCapture", status: -6 } },
    ])
    stopStatus = 0
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test("Audio capture retains EventEmitter unhandled error semantics", () => {
  const lib = resolveRenderLib()
  const restoreRefresh = replaceMethod(lib, "audioRefreshCaptureDevices", () => -2)
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    expect(() => audio.listCaptureDevices()).toThrow("Audio listCaptureDevices failed: -2")
  } finally {
    restoreRefresh()
  }
})

test("Audio capture reads interleaved frames, drains after stop, and exposes bigint stats", () => {
  const lib = resolveRenderLib()
  let readIndex = 0
  const readLengths: number[] = []
  const restores = [
    replaceMethod(lib, "audioStartCapture", () => 0),
    replaceMethod(lib, "audioStopCapture", () => 0),
    replaceMethod(lib, "audioIsCaptureRunning", () => true),
    replaceMethod(lib, "audioReadCapture", (_engine: unknown, output: Float32Array, frameCount: number) => {
      readLengths.push(output.length)
      if (readIndex++ === 0) {
        output.set([0.25, -0.25, 0.5, -0.5])
        return { status: 0, framesRead: Math.min(2, frameCount) }
      }
      return { status: 0, framesRead: 0 }
    }),
    replaceMethod(lib, "audioGetCaptureStats", () => ({
      status: 0,
      stats: {
        framesReceived: 9_007_199_254_740_993n,
        framesRead: 2n,
        framesDropped: 3n,
        sampleRate: 48_000,
        channels: 2,
        bufferedFrames: 4,
        capacityFrames: 8,
      },
    })),
  ]

  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    expect(audio.startCapture({ channels: 2, capacityFrames: 8 })).toBe(true)
    expect(audio.stopCapture()).toBe(true)

    expect(audio.readCaptureFrames(3)).toEqual({
      frames: new Float32Array([0.25, -0.25, 0.5, -0.5, 0, 0]),
      framesRead: 2,
    })
    expect(audio.readCaptureFrames(3)).toEqual({ frames: new Float32Array(6), framesRead: 0 })
    expect(readLengths).toEqual([6, 6])
    expect(audio.getCaptureStats()).toEqual({
      sampleRate: 48_000,
      channels: 2,
      capacityFrames: 8,
      bufferedFrames: 4,
      framesReceived: 9_007_199_254_740_993n,
      framesRead: 2n,
      framesDropped: 3n,
    })
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test("Audio playback stop is capture-independent and disposal stops capture before destroy", () => {
  const lib = resolveRenderLib()
  const calls: string[] = []
  const originalDestroy = lib.destroyAudioEngine
  const restores = [
    replaceMethod(lib, "audioStart", () => 0),
    replaceMethod(lib, "audioStop", () => {
      calls.push("playbackStop")
      return 0
    }),
    replaceMethod(lib, "audioStartCapture", () => 0),
    replaceMethod(lib, "audioIsCaptureRunning", () => true),
    replaceMethod(lib, "audioStopCapture", () => {
      calls.push("captureStop")
      return 0
    }),
    replaceMethod(lib, "destroyAudioEngine", (engine: Parameters<typeof originalDestroy>[0]) => {
      calls.push("destroy")
      originalDestroy.call(lib, engine)
    }),
  ]

  try {
    const audio = Audio.create({ autoStart: false })
    let stoppedEvents = 0
    audio.on("captureStopped", () => {
      stoppedEvents += 1
    })
    expect(audio.start()).toBe(true)
    expect(audio.startCapture()).toBe(true)
    expect(audio.stop()).toBe(true)
    expect(audio.isCapturing()).toBe(true)
    expect(calls).toEqual(["playbackStop"])

    audio.dispose()
    audio.dispose()
    expect(calls).toEqual(["playbackStop", "captureStop", "destroy"])
    expect(stoppedEvents).toBe(1)
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test("Audio capture observes external stops and can restart without duplicating lifecycle events", () => {
  const lib = resolveRenderLib()
  let running = false
  let starts = 0
  let stops = 0
  const restores = [
    replaceMethod(lib, "audioStartCapture", () => {
      starts += 1
      running = true
      return 0
    }),
    replaceMethod(lib, "audioIsCaptureRunning", () => running),
    replaceMethod(lib, "audioStopCapture", () => {
      stops += 1
      return 0
    }),
  ]

  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const events: string[] = []
    audio.on("captureStarted", () => events.push("started"))
    audio.on("captureStopped", () => events.push("stopped"))

    expect(audio.startCapture()).toBe(true)
    running = false
    expect(audio.isCapturing()).toBe(false)
    expect(audio.stopCapture()).toBe(true)
    expect(stops).toBe(1)

    expect(audio.startCapture()).toBe(true)
    expect(starts).toBe(2)
    expect(events).toEqual(["started", "stopped", "started"])
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test("Audio capture preserves reentrant restart format after an external stop event", () => {
  const lib = resolveRenderLib()
  let running = false
  const starts: Array<{ channels: number; capacityFrames: number }> = []
  const restores = [
    replaceMethod(
      lib,
      "audioStartCapture",
      (_engine: unknown, _options: unknown, channels: number, capacityFrames: number) => {
        starts.push({ channels, capacityFrames })
        running = true
        return 0
      },
    ),
    replaceMethod(lib, "audioIsCaptureRunning", () => running),
    replaceMethod(lib, "audioReadCapture", () => ({ status: 0, framesRead: 0 })),
  ]

  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    audio.on("error", () => {})
    expect(audio.startCapture({ channels: 2, capacityFrames: 16 })).toBe(true)
    let restartOnStop = true
    audio.on("captureStopped", () => {
      if (!restartOnStop) return
      restartOnStop = false
      expect(audio.startCapture({ channels: 1, capacityFrames: 8 })).toBe(true)
    })

    running = false
    expect(audio.startCapture({ channels: 2, capacityFrames: 16 })).toBe(false)
    expect(starts).toEqual([
      { channels: 2, capacityFrames: 16 },
      { channels: 1, capacityFrames: 8 },
    ])
    expect(audio.readCaptureFrames(8)?.frames.length).toBe(8)
    expect(() => audio.readCaptureFrames(9)).toThrow(RangeError)
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test("Audio capture bounds reads to initialized buffer capacity", () => {
  const lib = resolveRenderLib()
  let readCalls = 0
  const restores = [
    replaceMethod(lib, "audioStartCapture", () => 0),
    replaceMethod(lib, "audioReadCapture", () => {
      readCalls += 1
      return { status: 0, framesRead: 0 }
    }),
  ]

  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    audio.on("error", () => {})
    expect(audio.readCaptureFrames(1)).toBeNull()
    expect(readCalls).toBe(0)

    expect(audio.startCapture({ channels: 1, capacityFrames: 8 })).toBe(true)
    expect(() => audio.readCaptureFrames(9)).toThrow(RangeError)
    expect(() => audio.readCaptureFrames(0xffffffff)).toThrow(RangeError)
    expect(readCalls).toBe(0)
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test("Audio capture cannot restart reentrantly while disposal emits captureStopped", () => {
  const lib = resolveRenderLib()
  let starts = 0
  const restores = [
    replaceMethod(lib, "audioStartCapture", () => {
      starts += 1
      return 0
    }),
    replaceMethod(lib, "audioStopCapture", () => 0),
  ]

  try {
    const audio = Audio.create({ autoStart: false })
    expect(audio.startCapture()).toBe(true)
    audio.on("captureStopped", () => {
      expect(audio.startCapture()).toBe(false)
    })
    audio.dispose()
    expect(starts).toBe(1)
    expect(audio.isCapturing()).toBe(false)
  } finally {
    for (const restore of restores.reverse()) restore()
  }
})

test("AudioCaptureStream applies defaults and reads only on demand", async () => {
  const ring = replaceCaptureRing(Array.from({ length: 2048 }, (_, index) => index / 2048))
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const stream = await audio.openCapture()

    expect(stream.channels).toBe(1)
    expect(stream.chunkFrames).toBe(2048)
    expect(ring.starts).toEqual([{ channels: 1, capacityFrames: SAMPLE_RATE }])
    await sleep(10)
    expect(ring.reads).toBe(0)

    const reader = stream.readable.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.value?.length).toBe(2048)
    expect(first.value?.[1024]).toBe(0.5)
    stream.stop()
    expect((await reader.read()).done).toBe(true)
    await stream.closed
    expect(stream.state).toBe("stopped")
  } finally {
    ring.restore()
  }
})

test("AudioCaptureStream preserves multichannel interleaving and channel count", async () => {
  const samples = [0.125, 0.25, 0.375, 0.5, -0.125, -0.25, -0.375, -0.5]
  const ring = replaceCaptureRing(samples, 4)
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const stream = await audio.openCapture({ channels: 4, capacityFrames: 4, chunkFrames: 2 })
    const reader = stream.readable.getReader()

    expect(stream.channels).toBe(4)
    expect(stream.getStats().channels).toBe(4)
    expect(await reader.read()).toEqual({ done: false, value: new Float32Array(samples) })

    stream.stop()
    expect((await reader.read()).done).toBe(true)
    await stream.closed
  } finally {
    ring.restore()
  }
})

test("AudioCaptureStream waits for full chunks, drains a final partial chunk, and orders closed after stopped", async () => {
  const ring = replaceCaptureRing([0.25])
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const stream = await audio.openCapture({ capacityFrames: 4, chunkFrames: 2 })
    const reader = stream.readable.getReader()
    let settled = false
    const pending = reader.read().then((result) => {
      settled = true
      return result
    })
    await sleep(10)
    expect(settled).toBe(false)
    expect(ring.reads).toBe(0)

    const order: string[] = []
    stream.on("stopped", () => order.push("stopped"))
    stream.on("stopped", () => {
      stream.stop()
      stream.dispose()
    })
    void stream.closed.then(() => order.push("closed"))
    stream.stop()
    expect(stream.state).toBe("stopping")
    expect(await pending).toEqual({ done: false, value: new Float32Array([0.25]) })
    expect((await reader.read()).done).toBe(true)
    await stream.closed
    expect(stream.getStats()).toMatchObject({ framesRead: 1n, bufferedFrames: 0 })
    expect(order).toEqual(["stopped", "closed"])
  } finally {
    ring.restore()
  }
})

test("AudioCaptureStream.stop without a reader discards buffered PCM, closes, and releases ownership", async () => {
  const ring = replaceCaptureRing([0.1, 0.2, 0.3, 0.4, 0.5])
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    audio.on("error", () => {})
    const stream = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    stream.stop()
    await stream.closed

    expect(stream.state).toBe("stopped")
    expect(ring.reads).toBe(3)
    expect(stream.getStats()).toMatchObject({ framesRead: 5n, bufferedFrames: 0 })
    const reader = stream.readable.getReader()
    expect((await reader.read()).done).toBe(true)

    const next = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    next.dispose()
    await next.closed
    expect(ring.starts).toHaveLength(2)
  } finally {
    ring.restore()
  }
})

test("AudioCaptureStream stop discards after an idle reader releases its lock", async () => {
  const ring = replaceCaptureRing([0.1, 0.2, 0.3])
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const stream = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    const reader = stream.readable.getReader()
    stream.stop()
    reader.releaseLock()
    await stream.closed

    expect(stream.state).toBe("stopped")
    expect(ring.reads).toBe(2)
    expect(stream.readable.locked).toBe(false)
    const next = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    next.dispose()
    await next.closed
  } finally {
    ring.restore()
  }
})

test("AudioCaptureStream discard draining yields after bounded batches and never queues PCM", async () => {
  const chunkFrames = 2
  const chunkCount = 70
  const ring = replaceCaptureRing(Array.from({ length: chunkFrames * chunkCount }, (_, index) => index / 1000))
  const originalSetTimeout = globalThis.setTimeout
  const zeroDelayReadCounts: number[] = []
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 0) zeroDelayReadCounts.push(ring.reads)
    return originalSetTimeout(callback, delay, ...args)
  }) as typeof setTimeout
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const stream = await audio.openCapture({ capacityFrames: chunkFrames * chunkCount, chunkFrames })
    stream.stop()
    await stream.closed

    expect(ring.reads).toBe(chunkCount)
    expect(zeroDelayReadCounts).toContain(32)
    expect(zeroDelayReadCounts).toContain(64)
    expect((await stream.readable.getReader().read()).done).toBe(true)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    ring.restore()
  }
})

test("AudioCaptureStream observes abort synchronously during native start and cleans before rejecting", async () => {
  const ring = replaceCaptureRing([])
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const controller = new AbortController()
    audio.once("captureStarted", () => controller.abort())

    await expect(
      audio.openCapture({ signal: controller.signal, capacityFrames: 8, chunkFrames: 2 }),
    ).rejects.toHaveProperty("name", "AbortError")
    expect(audio.isCapturing()).toBe(false)

    const next = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    next.dispose()
    await next.closed
    expect(ring.starts).toHaveLength(2)
  } finally {
    ring.restore()
  }
})

test("AudioCaptureStream retains ownership after repeated native stop failures and parent disposal retries", async () => {
  const ring = replaceCaptureRing([])
  const lib = resolveRenderLib()
  let stopCalls = 0
  const restoreStop = replaceMethod(lib, "audioStopCapture", () => {
    stopCalls += 1
    return -6
  })
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    audio.on("error", () => {})
    const stream = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    stream.on("error", () => {})
    stream.stop()
    await stream.closed

    expect(stream.state).toBe("errored")
    expect(await rejectionOf(audio.openCapture({ capacityFrames: 8, chunkFrames: 2 }))).toBeInstanceOf(
      AudioCaptureStreamError,
    )
    expect(ring.starts).toHaveLength(1)
    const callsBeforeParentDispose = stopCalls
    audio.dispose()
    expect(stopCalls).toBeGreaterThan(callsBeforeParentDispose)
    expect(ring.starts).toHaveLength(1)
  } finally {
    restoreStop()
    ring.restore()
  }
})

test("AudioCaptureStream cancellation, abort, exclusivity, external stop, and parent disposal are terminal once", async () => {
  const ring = replaceCaptureRing([])
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const errors: string[] = []
    audio.on("error", (_error, context) => errors.push(context.action))
    const stream = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    let disposed = 0
    stream.on("disposed", () => {
      disposed += 1
      stream.dispose()
    })
    ring.framesDropped = 2n
    expect(stream.getStats().framesDropped).toBe(2n)
    ring.framesDropped = 0n

    expect(await rejectionOf(audio.openCapture({ capacityFrames: 8, chunkFrames: 2 }))).toBeInstanceOf(
      AudioCaptureStreamError,
    )
    expect(audio.startCapture()).toBe(false)
    expect(audio.readCaptureFrames(1)).toBeNull()
    expect(audio.stopCapture()).toBe(false)
    expect(audio.selectCaptureDevice(0)).toBe(false)
    audio.clearCaptureDeviceSelection()
    expect(errors).toEqual([
      "startCapture",
      "readCaptureFrames",
      "stopCapture",
      "selectCaptureDevice",
      "clearCaptureDeviceSelection",
    ])
    expect(ring.starts).toHaveLength(1)

    ring.running = false
    const reader = stream.readable.getReader()
    expect((await reader.read()).done).toBe(true)
    await stream.closed
    expect(stream.state).toBe("stopped")

    const canceled = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    canceled.on("disposed", () => {
      disposed += 1
      canceled.dispose()
    })
    await canceled.readable.getReader().cancel()
    await canceled.closed
    expect(canceled.state).toBe("disposed")

    const controller = new AbortController()
    const aborted = await audio.openCapture({ signal: controller.signal, capacityFrames: 8, chunkFrames: 2 })
    aborted.on("disposed", () => {
      disposed += 1
    })
    ring.receive([0.1, 0.2, 0.3])
    controller.abort()
    await aborted.closed
    expect(aborted.state).toBe("disposed")
    expect(aborted.getStats()).toMatchObject({ framesReceived: 3n, bufferedFrames: 3 })

    const parentOwned = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    parentOwned.on("disposed", () => {
      disposed += 1
    })
    const lib = resolveRenderLib()
    const stopBeforeParentDispose = lib.audioStopCapture
    let parentStopCalls = 0
    const restoreParentStop = replaceMethod(
      lib,
      "audioStopCapture",
      (engine: Parameters<typeof stopBeforeParentDispose>[0]) => {
        parentStopCalls += 1
        if (parentStopCalls <= 2) return -6
        ring.receive([0.4])
        return stopBeforeParentDispose.call(lib, engine)
      },
    )
    try {
      audio.dispose()
    } finally {
      restoreParentStop()
    }
    await parentOwned.closed
    expect(parentOwned.state).toBe("disposed")
    expect(parentOwned.getStats()).toMatchObject({ framesReceived: 4n, bufferedFrames: 4 })
    expect(parentStopCalls).toBeGreaterThanOrEqual(3)
    expect(disposed).toBe(3)
  } finally {
    ring.restore()
  }
})

test("Audio direct capture validates arguments before reporting stream ownership", async () => {
  const ring = replaceCaptureRing([])
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const errors: string[] = []
    audio.on("error", (_error, context) => errors.push(context.action))
    const stream = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })

    expect(() => audio.selectCaptureDevice(Number.NaN)).toThrow(TypeError)
    expect(() => audio.startCapture({ channels: 0 })).toThrow(TypeError)
    expect(() => audio.readCaptureFrames(0)).toThrow(TypeError)
    expect(errors).toEqual([])

    stream.dispose()
    await stream.closed
  } finally {
    ring.restore()
  }
})

test("AudioCaptureStream disposal reentered from Audio.captureStopped remains disposed", async () => {
  const ring = replaceCaptureRing([])
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const stream = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    const events: string[] = []
    let stateDuringListener = ""
    let disposedEvents = 0
    let stoppedEvents = 0

    audio.on("captureStopped", () => {
      events.push("audio.captureStopped")
      stream.dispose()
      stateDuringListener = stream.state
    })
    stream.on("disposed", () => {
      events.push("stream.disposed")
      disposedEvents += 1
    })
    stream.on("stopped", () => {
      events.push("stream.stopped")
      stoppedEvents += 1
    })

    ring.running = false
    const reader = stream.readable.getReader()
    expect((await reader.read()).done).toBe(true)
    await stream.closed

    expect(stateDuringListener).toBe("disposed")
    expect(stream.state).toBe("disposed")
    expect(disposedEvents).toBe(1)
    expect(stoppedEvents).toBe(0)
    expect(events).toEqual(["audio.captureStopped", "stream.disposed"])
  } finally {
    ring.restore()
  }
})

test("AudioCaptureStream rejects invalid and pre-aborted setup without native capture calls", async () => {
  const ring = replaceCaptureRing([])
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    expect(await rejectionOf(audio.openCapture({ chunkFrames: 0 }))).toBeInstanceOf(TypeError)
    expect(await rejectionOf(audio.openCapture({ capacityFrames: 4, chunkFrames: 5 }))).toBeInstanceOf(RangeError)
    const controller = new AbortController()
    controller.abort()
    await expect(audio.openCapture({ signal: controller.signal })).rejects.toHaveProperty("name", "AbortError")
    expect(ring.starts).toEqual([])
  } finally {
    ring.restore()
  }
})

test("AudioCaptureStream preserves native setup error status", async () => {
  const lib = resolveRenderLib()
  const restoreStart = replaceMethod(lib, "audioStartCapture", () => -5)
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const error = await rejectionOf(audio.openCapture())
    expect(error).toBeInstanceOf(AudioCaptureStreamError)
    expect((error as AudioCaptureStreamError).context).toEqual({ action: "start", status: -5 })
  } finally {
    restoreStart()
  }
})

test("AudioCaptureStream reports one terminal read error", async () => {
  const ring = replaceCaptureRing([0.25, -0.25])
  const lib = resolveRenderLib()
  const restoreRead = replaceMethod(lib, "audioReadCapture", () => ({ status: -7, framesRead: 0 }))
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const stream = await audio.openCapture({ capacityFrames: 2, chunkFrames: 2 })
    const terminal: AudioCaptureStreamError[] = []
    stream.on("error", (error) => terminal.push(error))
    const reader = stream.readable.getReader()
    expect(await rejectionOf(reader.read())).toBeInstanceOf(AudioCaptureStreamError)
    await stream.closed
    stream.dispose()
    expect(terminal).toHaveLength(1)
    expect(terminal[0]?.context).toEqual({ action: "read", status: -7 })
    expect(stream.state).toBe("errored")
  } finally {
    restoreRead()
    ring.restore()
  }
})

test("AudioCaptureStream disposal cleanup failures error once, retain ownership, and retry safely", async () => {
  for (const mode of ["dispose", "cancel", "abort"] as const) {
    const ring = replaceCaptureRing([])
    const lib = resolveRenderLib()
    let cleanupAllowed = false
    let stopCalls = 0
    const restoreStop = replaceMethod(lib, "audioStopCapture", () => {
      stopCalls += 1
      if (!cleanupAllowed) return -6
      ring.running = false
      return 0
    })
    try {
      const audio = Audio.create({ autoStart: false })
      instances.push(audio)
      audio.on("error", () => {})
      const controller = new AbortController()
      const stream = await audio.openCapture({
        signal: controller.signal,
        capacityFrames: 8,
        chunkFrames: 2,
      })
      const errors: AudioCaptureStreamError[] = []
      let disposedEvents = 0
      stream.on("error", (error) => errors.push(error))
      stream.on("disposed", () => {
        disposedEvents += 1
      })
      const reader = stream.readable.getReader()
      if (mode === "cancel") {
        await reader.cancel()
      } else {
        const pendingRead = reader.read()
        if (mode === "dispose") stream.dispose()
        else controller.abort()
        expect(await rejectionOf(pendingRead)).toBeInstanceOf(AudioCaptureStreamError)
      }
      await stream.closed

      expect(stream.state).toBe("errored")
      expect(errors).toHaveLength(1)
      expect(errors[0]?.context).toEqual({ action: "destroy", status: -6 })
      expect(disposedEvents).toBe(0)
      expect(await rejectionOf(audio.openCapture({ capacityFrames: 8, chunkFrames: 2 }))).toBeInstanceOf(
        AudioCaptureStreamError,
      )

      cleanupAllowed = true
      const callsBeforeRetry = stopCalls
      if (mode === "dispose") audio.dispose()
      else stream.dispose()
      await waitFor(() => stopCalls > callsBeforeRetry, "Capture cleanup was not retried")
      expect(errors).toHaveLength(1)
      expect(disposedEvents).toBe(0)

      if (mode !== "dispose") {
        const next = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
        next.dispose()
        await next.closed
      }
    } finally {
      restoreStop()
      ring.restore()
    }
  }
})

test("AudioRecorder keeps capture errors observed through disposal cleanup and allows safe retry", async () => {
  const ring = replaceCaptureRing([])
  const lib = resolveRenderLib()
  let cleanupAllowed = false
  let stopCalls = 0
  const restoreStop = replaceMethod(lib, "audioStopCapture", () => {
    stopCalls += 1
    if (!cleanupAllowed) return -6
    ring.running = false
    return 0
  })
  try {
    const directory = await createRecorderTempDirectory()
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const recorder = await audio.recordToFile(join(directory, "cleanup.wav"), {
      capacityFrames: 8,
      chunkFrames: 2,
    })
    const errors: AudioRecorderError[] = []
    let disposedEvents = 0
    recorder.on("error", (error) => errors.push(error))
    recorder.on("disposed", () => {
      disposedEvents += 1
    })

    recorder.dispose()
    await recorder.closed
    expect(recorder.state).toBe("errored")
    expect(errors).toHaveLength(1)
    expect(errors[0]?.context.action).toBe("destroy")
    expect(disposedEvents).toBe(0)
    expect(await readdir(directory)).toEqual([])

    cleanupAllowed = true
    const callsBeforeRetry = stopCalls
    recorder.dispose()
    await waitFor(() => stopCalls > callsBeforeRetry, "Recorder did not retry capture cleanup")
    await sleep(10)
    const next = await audio.openCapture({ capacityFrames: 8, chunkFrames: 2 })
    next.dispose()
    await next.closed
  } finally {
    restoreStop()
    ring.restore()
  }
})

test("AudioRecorder writes exact mono and stereo PCM16 WAV files", async () => {
  for (const fixture of [
    { channels: 1, samples: [-1, -0.5, 0, 0.5, 1] },
    { channels: 2, samples: [-1, 1, -0.5, 0.5, 0, 0.25] },
  ]) {
    const ring = replaceCaptureRing(fixture.samples, fixture.channels)
    try {
      const directory = await createRecorderTempDirectory()
      const filePath = join(directory, `${fixture.channels}.wav`)
      if (fixture.channels === 1) await writeFile(filePath, "replace me")
      const audio = Audio.create({ autoStart: false })
      instances.push(audio)
      const recorder = await audio.recordToFile(filePath, {
        channels: fixture.channels,
        capacityFrames: 16,
        chunkFrames: 2,
      })
      let stoppedEvents = 0
      recorder.on("stopped", () => {
        stoppedEvents += 1
        recorder.stop()
        recorder.dispose()
      })
      recorder.stop()
      await recorder.closed

      expect(recorder.state).toBe("stopped")
      expect(stoppedEvents).toBe(1)
      expect(recorder.format).toBe("wav")
      const recordedBytes = await readFile(filePath)
      const expectedBytes = buildPcm16Wav(fixture.samples, fixture.channels)
      expect(recordedBytes.byteLength).toBe(expectedBytes.byteLength)
      expect(recordedBytes.equals(expectedBytes)).toBe(true)
      expect(recorder.getStats()).toMatchObject({
        framesWritten: BigInt(fixture.samples.length / fixture.channels),
        dataBytesWritten: BigInt(fixture.samples.length * 2),
        framesRead: BigInt(fixture.samples.length / fixture.channels),
        bufferedFrames: 0,
      })
      expect(await readdir(directory)).toEqual([`${fixture.channels}.wav`])
    } finally {
      ring.restore()
    }
  }
})

test("AudioRecorder loops on partial writes and treats zero-byte progress as a terminal write error", async () => {
  const directory = await createRecorderTempDirectory()
  const probePath = join(directory, "probe")
  const probe = await openFile(probePath, "w")
  const fileHandlePrototype = Object.getPrototypeOf(probe) as object
  const originalWrite = (
    fileHandlePrototype as {
      write(
        this: unknown,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ): Promise<{ bytesWritten: number }>
    }
  ).write
  await probe.close()
  await unlinkFile(probePath)

  const partialRing = replaceCaptureRing([0.25, -0.25, 0.5])
  let partialWrites = 0
  const restorePartialWrite = replaceMethod(
    fileHandlePrototype,
    "write",
    function (this: unknown, buffer: Uint8Array, offset: number, length: number, position: number) {
      const partialLength = Math.max(1, Math.ceil(length / 2))
      if (partialLength < length) partialWrites += 1
      return originalWrite.call(this, buffer, offset, partialLength, position)
    },
  )
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const filePath = join(directory, "partial.wav")
    const recorder = await audio.recordToFile(filePath, { capacityFrames: 8, chunkFrames: 2 })
    recorder.stop()
    await recorder.closed
    expect(recorder.state).toBe("stopped")
    expect(partialWrites).toBeGreaterThan(0)
    const actual = await readFile(filePath)
    expect(actual.equals(buildPcm16Wav([0.25, -0.25, 0.5], 1))).toBe(true)
  } finally {
    restorePartialWrite()
    partialRing.restore()
  }

  const zeroRing = replaceCaptureRing([0.25, -0.25])
  let writes = 0
  const restoreZeroWrite = replaceMethod(
    fileHandlePrototype,
    "write",
    function (this: unknown, buffer: Uint8Array, offset: number, length: number, position: number) {
      writes += 1
      if (writes === 2) return Promise.resolve({ bytesWritten: 0 })
      return originalWrite.call(this, buffer, offset, length, position)
    },
  )
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const recorder = await audio.recordToFile(join(directory, "zero.wav"), { capacityFrames: 4, chunkFrames: 2 })
    const errors: AudioRecorderError[] = []
    recorder.on("error", (error) => errors.push(error))
    await recorder.closed
    expect(errors).toHaveLength(1)
    expect(errors[0]?.context.action).toBe("write")
    expect(await readdir(directory)).toEqual(["partial.wav"])
  } finally {
    restoreZeroWrite()
    zeroRing.restore()
  }
})

test("AudioRecorder stop drains every buffered frame while a file write is delayed", async () => {
  const samples = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
  const ring = replaceCaptureRing(samples)
  const directory = await createRecorderTempDirectory()
  const probePath = join(directory, "probe")
  const probe = await openFile(probePath, "w")
  const fileHandlePrototype = Object.getPrototypeOf(probe) as object
  const originalWrite = (fileHandlePrototype as { write: (...args: unknown[]) => Promise<unknown> }).write
  await probe.close()
  await unlinkFile(probePath)
  const writeGate = deferred()
  let writes = 0
  let dataWriteStarted = false
  const restoreWrite = replaceMethod(fileHandlePrototype, "write", async function (this: unknown, ...args: unknown[]) {
    writes += 1
    if (writes === 2) {
      dataWriteStarted = true
      await writeGate.promise
    }
    return originalWrite.apply(this, args)
  })
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const filePath = join(directory, "drained.wav")
    const recorder = await audio.recordToFile(filePath, { capacityFrames: 8, chunkFrames: 2 })
    await waitFor(() => dataWriteStarted, "Recorder did not begin its first data write")
    recorder.stop()
    writeGate.resolve()
    await recorder.closed

    expect(recorder.state).toBe("stopped")
    const actual = await readFile(filePath)
    expect(actual.equals(buildPcm16Wav(samples, 1))).toBe(true)
  } finally {
    restoreWrite()
    ring.restore()
  }
})

test("AudioRecorder final header and sync failures remove the temp and preserve the destination", async () => {
  for (const mode of ["header", "sync"] as const) {
    const ring = replaceCaptureRing([0.25, -0.25])
    const directory = await createRecorderTempDirectory()
    const filePath = join(directory, `${mode}.wav`)
    await writeFile(filePath, "existing")
    const probePath = join(directory, "probe")
    const probe = await openFile(probePath, "w")
    const fileHandlePrototype = Object.getPrototypeOf(probe) as object
    const originalWrite = (fileHandlePrototype as { write: (...args: unknown[]) => Promise<unknown> }).write
    const originalSync = (fileHandlePrototype as { sync(): Promise<void> }).sync
    await probe.close()
    await unlinkFile(probePath)
    let headerWrites = 0
    const restore =
      mode === "header"
        ? replaceMethod(fileHandlePrototype, "write", function (this: unknown, ...args: unknown[]) {
            if (args[3] === 0 && ++headerWrites === 2) return Promise.reject(new Error("injected header failure"))
            return originalWrite.apply(this, args)
          })
        : replaceMethod(fileHandlePrototype, "sync", function (this: unknown) {
            return Promise.reject(new Error("injected sync failure"))
          })
    try {
      const audio = Audio.create({ autoStart: false })
      instances.push(audio)
      const recorder = await audio.recordToFile(filePath, { capacityFrames: 4, chunkFrames: 2 })
      const errors: AudioRecorderError[] = []
      recorder.on("error", (error) => errors.push(error))
      recorder.stop()
      await recorder.closed
      expect(recorder.state).toBe("errored")
      expect(errors[0]?.context.action).toBe("finalize")
      expect(await readFile(filePath, "utf8")).toBe("existing")
      expect(await readdir(directory)).toEqual([`${mode}.wav`])
    } finally {
      restore()
      void originalSync
      ring.restore()
    }
  }
})

test("AudioRecorder dispose before publication waits for finalization and never publishes", async () => {
  const ring = replaceCaptureRing([0.25, -0.25])
  const directory = await createRecorderTempDirectory()
  const filePath = join(directory, "recording.wav")
  await writeFile(filePath, "existing")
  const probePath = join(directory, "probe")
  const probe = await openFile(probePath, "w")
  const fileHandlePrototype = Object.getPrototypeOf(probe) as object
  const originalSync = (fileHandlePrototype as { sync(): Promise<void> }).sync
  await probe.close()
  await unlinkFile(probePath)
  const syncGate = deferred()
  let syncStarted = false
  const restoreSync = replaceMethod(fileHandlePrototype, "sync", function (this: unknown) {
    syncStarted = true
    return syncGate.promise.then(() => originalSync.call(this))
  })
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const recorder = await audio.recordToFile(filePath, { capacityFrames: 4, chunkFrames: 2 })
    const order: string[] = []
    recorder.on("disposed", () => {
      order.push("disposed")
      recorder.dispose()
    })
    void recorder.closed.then(() => order.push("closed"))
    recorder.stop()
    await waitFor(() => syncStarted, "Recorder did not begin sync")
    recorder.dispose()
    expect(recorder.state).toBe("disposed")
    expect(await readFile(filePath, "utf8")).toBe("existing")
    syncGate.resolve()
    await recorder.closed
    expect(order).toEqual(["disposed", "closed"])
    expect(await readFile(filePath, "utf8")).toBe("existing")
    expect(await readdir(directory)).toEqual(["recording.wav"])
  } finally {
    restoreSync()
    ring.restore()
  }
})

test("AudioRecorder publication is a point of no return during parent disposal", async () => {
  const ring = replaceCaptureRing([0.25, -0.25])
  const directory = await createRecorderTempDirectory()
  const filePath = join(directory, "recording.wav")
  await writeFile(filePath, "existing")
  const renameGate = deferred()
  const fileSystem = getRecorderFileSystem()
  const originalRename = fileSystem.rename
  let renameStarted = false
  const restoreRename = replaceMethod(fileSystem, "rename", async (source: string, destination: string) => {
    renameStarted = true
    await renameGate.promise
    await originalRename(source, destination)
  })
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const recorder = await audio.recordToFile(filePath, { capacityFrames: 4, chunkFrames: 2 })
    const order: string[] = []
    recorder.on("stopped", () => {
      order.push("stopped")
      recorder.dispose()
    })
    void recorder.closed.then(() => order.push("closed"))
    recorder.stop()
    await waitFor(() => renameStarted, "Recorder did not begin publication")
    audio.dispose()
    expect(recorder.state).toBe("stopping")
    expect(await readFile(filePath, "utf8")).toBe("existing")
    renameGate.resolve()
    await recorder.closed
    expect(recorder.state).toBe("stopped")
    expect(order).toEqual(["stopped", "closed"])
    expect((await readFile(filePath)).equals(buildPcm16Wav([0.25, -0.25], 1))).toBe(true)
    expect(await readdir(directory)).toEqual(["recording.wav"])
  } finally {
    restoreRename()
    ring.restore()
  }
})

test("AudioRecorder abort and parent disposal during delayed setup clean exactly once", async () => {
  for (const mode of ["abort", "parent"] as const) {
    const ring = replaceCaptureRing([])
    const directory = await createRecorderTempDirectory()
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const probePath = join(directory, "probe")
    const probe = await openFile(probePath, "w")
    const fileHandlePrototype = Object.getPrototypeOf(probe) as object
    const originalWrite = (fileHandlePrototype as { write: (...args: unknown[]) => Promise<unknown> }).write
    await probe.close()
    const controller = new AbortController()
    let headerWriteStarted = false
    const restoreWrite = replaceMethod(
      fileHandlePrototype,
      "write",
      async function (this: unknown, ...args: unknown[]) {
        if (!headerWriteStarted) {
          headerWriteStarted = true
          if (mode === "abort") controller.abort()
          else audio.dispose()
          await Promise.resolve()
        }
        return originalWrite.apply(this, args)
      },
    )
    try {
      await expect(
        audio.recordToFile(join(directory, `${mode}.wav`), { signal: controller.signal }),
      ).rejects.toHaveProperty("name", "AbortError")
      expect(headerWriteStarted).toBe(true)
      expect(ring.starts).toEqual([])
      expect(await readdir(directory)).toEqual(["probe"])
    } finally {
      restoreWrite()
      ring.restore()
    }
  }
})

test("AudioRecorder setup and sequential write failures reject or terminate without native/file leaks", async () => {
  const setupRing = replaceCaptureRing([])
  try {
    const directory = await createRecorderTempDirectory()
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const missingPath = join(directory, "missing", "recording.wav")
    expect(await rejectionOf(audio.recordToFile(missingPath))).toMatchObject({
      name: "AudioRecorderError",
      context: { action: "open" },
    })
    expect(setupRing.starts).toEqual([])
    expect(await readdir(directory)).toEqual([])
  } finally {
    setupRing.restore()
  }

  const writeRing = replaceCaptureRing([0.25, -0.25])
  const directory = await createRecorderTempDirectory()
  const probePath = join(directory, "probe")
  const probe = await openFile(probePath, "w")
  const fileHandlePrototype = Object.getPrototypeOf(probe) as object
  const originalWrite = (fileHandlePrototype as { write: (...args: unknown[]) => Promise<unknown> }).write
  await probe.close()
  await unlinkFile(probePath)
  let writes = 0
  const restoreWrite = replaceMethod(fileHandlePrototype, "write", function (this: unknown, ...args: unknown[]) {
    writes += 1
    if (writes === 2) return Promise.reject(new Error("injected data write failure"))
    return originalWrite.apply(this, args)
  })
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const filePath = join(directory, "recording.wav")
    const recorder = await audio.recordToFile(filePath, { capacityFrames: 4, chunkFrames: 2 })
    const errors: AudioRecorderError[] = []
    recorder.on("error", (error) => errors.push(error))
    await recorder.closed
    expect(errors).toHaveLength(1)
    expect(errors[0]?.context.action).toBe("write")
    expect(recorder.state).toBe("errored")
    expect(await readdir(directory)).toEqual([])
  } finally {
    restoreWrite()
    writeRing.restore()
  }
})

test("AudioRecorder rejects dropped frames and unexpected external capture stops without publishing", async () => {
  for (const mode of ["dropped", "external"] as const) {
    const ring = replaceCaptureRing([])
    try {
      const directory = await createRecorderTempDirectory()
      const filePath = join(directory, `${mode}.wav`)
      const audio = Audio.create({ autoStart: false })
      instances.push(audio)
      const recorder = await audio.recordToFile(filePath, { capacityFrames: 4, chunkFrames: 1 })
      const errors: AudioRecorderError[] = []
      recorder.on("error", (error) => errors.push(error))
      if (mode === "dropped") {
        ring.framesDropped = 1n
        recorder.getStats()
      } else {
        ring.running = false
      }
      await recorder.closed
      expect(errors).toHaveLength(1)
      expect(errors[0]?.context.action).toBe(mode === "dropped" ? "stats" : "stop")
      expect(recorder.state).toBe("errored")
      expect(await readdir(directory)).toEqual([])
    } finally {
      ring.restore()
    }
  }
})

test("AudioRecorder preserves capture read error context through cleanup", async () => {
  const ring = replaceCaptureRing([])
  const lib = resolveRenderLib()
  const directory = await createRecorderTempDirectory()
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const recorder = await audio.recordToFile(join(directory, "read-error.wav"), {
      capacityFrames: 4,
      chunkFrames: 2,
    })
    const errors: AudioRecorderError[] = []
    recorder.on("error", (error) => errors.push(error))
    const restoreRead = replaceMethod(lib, "audioReadCapture", () => ({ status: -7, framesRead: 0 }))
    try {
      ring.receive([0.25, -0.25])
      await recorder.closed
    } finally {
      restoreRead()
    }

    expect(recorder.state).toBe("errored")
    expect(errors).toHaveLength(1)
    expect(errors[0]?.context).toEqual({ action: "read", status: -7 })
    expect(await readdir(directory)).toEqual([])
  } finally {
    ring.restore()
  }
})

test("Audio.dispose destroys the native engine when a captureStopped listener throws", () => {
  const ring = replaceCaptureRing([])
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)
  audio.on("error", () => {})
  const listener = (): never => {
    throw new Error("captureStopped listener failed")
  }
  audio.on("captureStopped", listener)

  try {
    expect(audio.startCapture()).toBe(true)
    try {
      audio.dispose()
    } catch {}
    expect(audio.getStats()).toBeNull()
  } finally {
    audio.off("captureStopped", listener)
    audio.dispose()
    ring.restore()
  }
})

test("Audio.dispose retains the engine when native destruction throws so cleanup can retry", () => {
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)
  audio.on("error", () => {})
  const lib = resolveRenderLib()
  const restoreDestroy = replaceMethod(lib, "destroyAudioEngine", () => {
    throw new Error("injected destroy failure")
  })
  try {
    expect(() => audio.dispose()).toThrow("injected destroy failure")
    expect(audio.getStats()).not.toBeNull()
  } finally {
    restoreDestroy()
  }

  audio.dispose()
  expect(audio.getStats()).toBeNull()
})

test("Audio.dispose propagates undefined thrown by native destruction", () => {
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)
  audio.on("error", () => {})
  const lib = resolveRenderLib()
  const restoreDestroy = replaceMethod(lib, "destroyAudioEngine", () => {
    throw undefined
  })
  let didThrow = false
  try {
    try {
      audio.dispose()
    } catch {
      didThrow = true
    }
    expect(didThrow).toBe(true)
    expect(audio.getStats()).not.toBeNull()
  } finally {
    restoreDestroy()
  }
  audio.dispose()
})

test("AudioRecorder accepts a destination at the filesystem component-length limit", async () => {
  const ring = replaceCaptureRing([0.25])
  try {
    const directory = await createRecorderTempDirectory()
    let minimum = 1
    let maximum = 512
    let supported = 0
    while (minimum <= maximum) {
      const length = Math.floor((minimum + maximum) / 2)
      const candidate = join(directory, "r".repeat(length))
      try {
        await writeFile(candidate, "existing")
        await unlinkFile(candidate)
        supported = length
        minimum = length + 1
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENAMETOOLONG" && !(process.platform === "win32" && code === "ENOENT")) throw error
        maximum = length - 1
      }
    }
    expect(supported).toBeGreaterThan(0)

    const filePath = join(directory, "r".repeat(supported))
    await writeFile(filePath, "existing")
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const recorder = await audio.recordToFile(filePath, { capacityFrames: 2, chunkFrames: 1 })
    recorder.stop()
    await recorder.closed

    expect(recorder.state).toBe("stopped")
    expect((await readFile(filePath)).equals(buildPcm16Wav([0.25], 1))).toBe(true)
    expect(await readdir(directory)).toEqual(["r".repeat(supported)])
  } finally {
    ring.restore()
  }
})

test("AudioRecorder temporary path is never longer than its destination path", async () => {
  const ring = replaceCaptureRing([0.25])
  const directory = await createRecorderTempDirectory()
  const filePath = join(directory, "r")
  const fileSystem = getRecorderFileSystem()
  const originalOpen = fileSystem.open
  let temporaryPath = ""
  const restoreOpen = replaceMethod(fileSystem, "open", async (...args: Parameters<typeof originalOpen>) => {
    temporaryPath = String(args[0])
    return originalOpen(...args)
  })
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const recorder = await audio.recordToFile(filePath, { capacityFrames: 2, chunkFrames: 1 })
    recorder.stop()
    await recorder.closed

    expect(Buffer.byteLength(temporaryPath)).toBeLessThanOrEqual(Buffer.byteLength(filePath))
  } finally {
    restoreOpen()
    ring.restore()
  }
})

test("AudioRecorder retains failed close cleanup and later dispose releases it without another terminal event", async () => {
  const ring = replaceCaptureRing([])
  const directory = await createRecorderTempDirectory()
  const filePath = join(directory, "recording.wav")
  await writeFile(filePath, "existing")
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)
  const fileSystem = getRecorderFileSystem()
  const originalOpen = fileSystem.open
  let cleanupAllowed = false
  let closeCalls = 0
  const restoreOpen = replaceMethod(fileSystem, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args)
    const originalClose = handle.close.bind(handle)
    Object.defineProperty(handle, "close", {
      configurable: true,
      value: () => {
        closeCalls += 1
        if (!cleanupAllowed) return Promise.reject(new Error("injected close failure before close"))
        return originalClose()
      },
    })
    return handle
  })
  try {
    const recorder = await audio.recordToFile(filePath, { capacityFrames: 4, chunkFrames: 1 })
    const errors: AudioRecorderError[] = []
    let disposedEvents = 0
    const order: string[] = []
    recorder.on("error", (error) => {
      errors.push(error)
      order.push("error")
    })
    recorder.on("disposed", () => {
      disposedEvents += 1
    })
    void recorder.closed.then(() => order.push("closed"))
    recorder.dispose()
    await recorder.closed

    expect(recorder.state).toBe("errored")
    expect(errors).toHaveLength(1)
    expect(errors[0]?.context.action).toBe("destroy")
    expect(disposedEvents).toBe(0)
    expect(order).toEqual(["error", "closed"])
    expect((await readdir(directory)).length).toBe(2)

    cleanupAllowed = true
    const callsBeforeRetry = closeCalls
    recorder.dispose()
    await waitFor(() => closeCalls > callsBeforeRetry, "Retained recorder handle was not retried")
    await waitFor(async () => (await readdir(directory)).length === 1, "Retained recorder temp was not removed")
    expect(await readdir(directory)).toEqual(["recording.wav"])
    expect(errors).toHaveLength(1)
    expect(disposedEvents).toBe(0)
    expect(order).toEqual(["error", "closed"])
  } finally {
    restoreOpen()
    ring.restore()
  }
})

test("AudioRecorder retains failed unlink cleanup and later dispose removes only its temp", async () => {
  const ring = replaceCaptureRing([])
  const directory = await createRecorderTempDirectory()
  const filePath = join(directory, "recording.wav")
  await writeFile(filePath, "existing")
  const fileSystem = getRecorderFileSystem()
  const originalUnlink = fileSystem.unlink
  let cleanupAllowed = false
  let destinationUnlinkCalls = 0
  const restoreUnlink = replaceMethod(fileSystem, "unlink", async (path: string) => {
    if (path === filePath) destinationUnlinkCalls += 1
    else if (!cleanupAllowed) throw new Error("injected persistent cleanup unlink failure")
    await originalUnlink(path)
  })
  try {
    const audio = Audio.create({ autoStart: false })
    instances.push(audio)
    const recorder = await audio.recordToFile(filePath, { capacityFrames: 4, chunkFrames: 1 })
    const errors: AudioRecorderError[] = []
    recorder.on("error", (error) => errors.push(error))
    recorder.dispose()
    await recorder.closed

    expect(recorder.state).toBe("errored")
    expect(errors[0]?.context.action).toBe("destroy")
    expect(destinationUnlinkCalls).toBe(0)
    expect((await readdir(directory)).length).toBe(2)

    cleanupAllowed = true
    recorder.dispose()
    await waitFor(async () => (await readdir(directory)).length === 1, "Retained temp unlink was not retried")
    expect(await readFile(filePath, "utf8")).toBe("existing")
    expect(destinationUnlinkCalls).toBe(0)
    expect(errors).toHaveLength(1)
  } finally {
    restoreUnlink()
    ring.restore()
  }
})

test("AudioRecorder setup surfaces retained cleanup failure and parent disposal retries it", async () => {
  const ring = replaceCaptureRing([])
  const directory = await createRecorderTempDirectory()
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)
  const fileSystem = getRecorderFileSystem()
  const originalOpen = fileSystem.open
  let cleanupAllowed = false
  const restoreOpen = replaceMethod(fileSystem, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args)
    const originalClose = handle.close.bind(handle)
    Object.defineProperties(handle, {
      close: {
        configurable: true,
        value: () => {
          if (!cleanupAllowed) return Promise.reject(new Error("injected setup close failure before close"))
          return originalClose()
        },
      },
      write: {
        configurable: true,
        value: () => Promise.resolve({ bytesWritten: 0 }),
      },
    })
    return handle
  })
  try {
    expect(await rejectionOf(audio.recordToFile(join(directory, "recording.wav")))).toMatchObject({
      name: "AudioRecorderError",
      context: { action: "destroy" },
    })
    expect((await readdir(directory)).length).toBe(1)

    cleanupAllowed = true
    audio.dispose()
    await waitFor(async () => (await readdir(directory)).length === 0, "Parent did not retry setup cleanup")
  } finally {
    restoreOpen()
    ring.restore()
  }
})

test("AudioRecorder setup propagates child capture cleanup failure", async () => {
  const ring = replaceCaptureRing([])
  const lib = resolveRenderLib()
  const directory = await createRecorderTempDirectory()
  const audio = Audio.create({ autoStart: false })
  instances.push(audio)
  const controller = new AbortController()
  let cleanupAllowed = false
  const restoreStop = replaceMethod(lib, "audioStopCapture", () => {
    if (!cleanupAllowed) return -6
    ring.running = false
    return 0
  })
  audio.once("captureStarted", () => controller.abort())
  try {
    expect(
      await rejectionOf(
        audio.recordToFile(join(directory, "recording.wav"), {
          signal: controller.signal,
          capacityFrames: 8,
          chunkFrames: 2,
        }),
      ),
    ).toMatchObject({ name: "AudioRecorderError", context: { action: "destroy" } })
    expect(await readdir(directory)).toEqual([])

    cleanupAllowed = true
    audio.dispose()
  } finally {
    restoreStop()
    ring.restore()
  }
})

test("AudioRecorder disposal, abort, parent disposal, and overflow never publish and clean up temporary files", async () => {
  for (const mode of ["dispose", "abort", "parent", "overflow"] as const) {
    const ring = replaceCaptureRing([])
    try {
      const directory = await createRecorderTempDirectory()
      const filePath = join(directory, `${mode}.wav`)
      await writeFile(filePath, "existing")
      const audio = Audio.create({ autoStart: false })
      instances.push(audio)
      const controller = new AbortController()
      const recorder = await audio.recordToFile(filePath, {
        capacityFrames: 4,
        chunkFrames: 1,
        signal: controller.signal,
      })
      if (mode === "dispose") {
        recorder.dispose()
        recorder.dispose()
      } else if (mode === "abort") {
        controller.abort()
      } else if (mode === "parent") {
        audio.dispose()
      } else {
        const errors: AudioRecorderError[] = []
        recorder.on("error", (error) => errors.push(error))
        ;(recorder as unknown as { dataBytesWritten: bigint }).dataBytesWritten = 0xffffffdan
        ring.receive([1])
        recorder.stop()
        await waitFor(() => errors.length === 1, "Recorder did not report RIFF overflow")
      }
      await recorder.closed
      expect(await readFile(filePath, "utf8")).toBe("existing")
      expect(await readdir(directory)).toEqual([`${mode}.wav`])
    } finally {
      ring.restore()
    }
  }
})
