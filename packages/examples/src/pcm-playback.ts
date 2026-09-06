#!/usr/bin/env bun

// Run: bun src/pcm-playback.ts [--headless]
import { Audio, type AudioStream } from "@opentui/core"

const headless = process.argv.includes("--headless")
const audio = Audio.create({ autoStart: false })
const controller = new AbortController()
const onInterrupt = () => controller.abort()
process.once("SIGINT", onInterrupt)
audio.on("error", (error) => console.error(error.message))
let mixer: ReturnType<typeof setInterval> | undefined
let stream: AudioStream | undefined

async function* tone(): AsyncGenerator<Uint8Array> {
  const framesPerChunk = 441
  const chunk = new Uint8Array(framesPerChunk * 4)
  const view = new DataView(chunk.buffer)
  for (let offset = 0; offset < 44100 * 2; offset += framesPerChunk) {
    for (let frame = 0; frame < framesPerChunk; frame++) {
      const time = (offset + frame) / 44100
      const envelope = Math.min(1, time * 20, (2 - time) * 20)
      view.setFloat32(frame * 4, Math.sin(2 * Math.PI * 440 * time) * 0.15 * envelope, true)
    }
    yield chunk
    // OpenTUI has consumed this chunk when the generator resumes, so it can be reused.
  }
}

try {
  if (!(headless ? audio.startMixer() : audio.start())) throw new Error("Unable to start audio output")
  if (headless) mixer = setInterval(() => audio.mixFrames(480), 10)
  stream = await audio.playStream(tone(), {
    format: "pcm",
    sampleFormat: "f32le",
    sampleRate: 44100,
    channels: 1,
    buffer: { capacityMs: 500, startupMs: 20, resumeMs: 20 },
    signal: controller.signal,
  })
  stream.on("error", (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  await stream.closed
  console.log(stream.getStats())
} catch (error) {
  if (!(error instanceof Error && error.name === "AbortError")) throw error
} finally {
  if (mixer !== undefined) clearInterval(mixer)
  process.removeListener("SIGINT", onInterrupt)
  try {
    stream?.dispose()
    await stream?.closed
  } finally {
    audio.dispose()
  }
}
