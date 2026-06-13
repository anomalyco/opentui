#!/usr/bin/env bun

import { performance } from "node:perf_hooks"
import { Audio } from "../audio.js"

type MixScenario = {
  name: string
  activeVoices: number
  frameCount: number
  channels: number
}

type VoiceLifecycleScenario = {
  name: string
  operations: number
}

type BurstScenario = {
  name: string
  startsPerTick: number
  frameCount: number
  channels: number
}

type MixResult = {
  scenario: string
  voices: number
  frames: number
  channels: number
  avgMs: number
  medianMs: number
  p95Ms: number
  maxMs: number
  samplesPerSec: number
  deltaVsIdlePct: number
}

type VoiceLifecycleResult = {
  scenario: string
  operations: number
  avgMs: number
  medianMs: number
  p95Ms: number
  maxMs: number
  opsPerSec: number
}

type BurstResult = {
  scenario: string
  startsPerTick: number
  frames: number
  channels: number
  avgMs: number
  medianMs: number
  p95Ms: number
  maxMs: number
  ticksPerSec: number
  deltaVsIdleTickPct: number
}

const MIX_ITERATIONS = Number(process.env.AUDIO_BENCH_ITERS ?? 16000)
const MIX_WARMUP_ITERATIONS = Number(process.env.AUDIO_BENCH_WARMUP ?? 200)
const LIFECYCLE_ITERATIONS = Number(process.env.AUDIO_BENCH_LIFECYCLE_ITERS ?? 6000)
const LIFECYCLE_WARMUP_ITERATIONS = Number(process.env.AUDIO_BENCH_LIFECYCLE_WARMUP ?? 200)
const BURST_ITERATIONS = Number(process.env.AUDIO_BENCH_BURST_ITERS ?? 8000)
const BURST_WARMUP_ITERATIONS = Number(process.env.AUDIO_BENCH_BURST_WARMUP ?? 200)
const SAMPLE_RATE = 48_000
const MAX_AUDIO_VOICES = 32

const mixScenarios: MixScenario[] = [
  { name: "idle", activeVoices: 0, frameCount: 256, channels: 2 },
  { name: "playback_1_voice", activeVoices: 1, frameCount: 256, channels: 2 },
  { name: "playback_8_voices", activeVoices: 8, frameCount: 256, channels: 2 },
  { name: "playback_16_voices", activeVoices: 16, frameCount: 256, channels: 2 },
  { name: "playback_32_voices", activeVoices: MAX_AUDIO_VOICES, frameCount: 256, channels: 2 },
]

const lifecycleScenarios: VoiceLifecycleScenario[] = [
  { name: "lifecycle_1", operations: 1 },
  { name: "lifecycle_8", operations: 8 },
  { name: "lifecycle_32", operations: 32 },
  { name: "lifecycle_64", operations: 64 },
]

const burstScenarios: BurstScenario[] = [
  { name: "burst_idle", startsPerTick: 0, frameCount: 256, channels: 2 },
  { name: "burst_4", startsPerTick: 4, frameCount: 256, channels: 2 },
  { name: "burst_16", startsPerTick: 16, frameCount: 256, channels: 2 },
  { name: "burst_32", startsPerTick: 32, frameCount: 256, channels: 2 },
]

function buildMonoPcm16Wav(options: {
  frequency: number
  durationMs: number
  amplitude: number
  decay: number
}): Uint8Array {
  const sampleCount = Math.max(1, Math.floor((SAMPLE_RATE * options.durationMs) / 1000))
  const channels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const dataSize = sampleCount * channels * bytesPerSample
  const out = new Uint8Array(44 + dataSize)
  const view = new DataView(out.buffer)

  out.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, out.length - 8, true)
  out.set([0x57, 0x41, 0x56, 0x45], 8)
  out.set([0x66, 0x6d, 0x74, 0x20], 12)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bitsPerSample, true)
  out.set([0x64, 0x61, 0x74, 0x61], 36)
  view.setUint32(40, dataSize, true)

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / SAMPLE_RATE
    const envelope = Math.pow(Math.max(0, 1 - i / sampleCount), options.decay)
    const value = Math.sin(2 * Math.PI * options.frequency * t) * options.amplitude * envelope
    const sample = Math.round(Math.max(-1, Math.min(1, value)) * 32767)
    view.setInt16(44 + i * 2, sample, true)
  }

  return out
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.floor((sorted.length - 1) * p)
  return sorted[index] ?? 0
}

function summarizeSamples(samples: number[]): { avgMs: number; medianMs: number; p95Ms: number; maxMs: number } {
  const avgMs = samples.reduce((sum, ms) => sum + ms, 0) / samples.length
  return {
    avgMs,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
  }
}

function runMixScenario(audio: Audio, soundId: number, scenario: MixScenario): MixResult {
  const startedVoices: number[] = []

  for (let i = 0; i < scenario.activeVoices; i += 1) {
    const voice = audio.play(soundId, {
      volume: 0.25,
      pan: (i % 2 === 0 ? -1 : 1) * 0.2,
      loop: true,
    })
    if (voice != null) {
      startedVoices.push(voice)
    }
  }

  for (let i = 0; i < MIX_WARMUP_ITERATIONS; i += 1) {
    audio.mixFrames(scenario.frameCount, scenario.channels)
  }

  const samples = new Array<number>(MIX_ITERATIONS)
  for (let i = 0; i < MIX_ITERATIONS; i += 1) {
    const start = performance.now()
    const mixed = audio.mixFrames(scenario.frameCount, scenario.channels)
    if (!mixed) {
      throw new Error(`mixFrames failed in scenario '${scenario.name}'`)
    }
    samples[i] = performance.now() - start
  }

  for (const voice of startedVoices) {
    audio.stopVoice(voice)
  }

  const stats = summarizeSamples(samples)
  const samplesPerSec = (scenario.frameCount * scenario.channels) / (stats.avgMs / 1000)

  return {
    scenario: scenario.name,
    voices: scenario.activeVoices,
    frames: scenario.frameCount,
    channels: scenario.channels,
    avgMs: Number(stats.avgMs.toFixed(4)),
    medianMs: Number(stats.medianMs.toFixed(4)),
    p95Ms: Number(stats.p95Ms.toFixed(4)),
    maxMs: Number(stats.maxMs.toFixed(4)),
    samplesPerSec: Number(samplesPerSec.toFixed(0)),
    deltaVsIdlePct: 0,
  }
}

function runVoiceLifecycleScenario(
  audio: Audio,
  soundId: number,
  scenario: VoiceLifecycleScenario,
): VoiceLifecycleResult {
  for (let i = 0; i < LIFECYCLE_WARMUP_ITERATIONS; i += 1) {
    for (let j = 0; j < scenario.operations; j += 1) {
      const voice = audio.play(soundId, { volume: 0.5, pan: 0, loop: false })
      if (voice != null) {
        audio.stopVoice(voice)
      }
    }
  }

  const samples = new Array<number>(LIFECYCLE_ITERATIONS)
  for (let i = 0; i < LIFECYCLE_ITERATIONS; i += 1) {
    const start = performance.now()
    for (let j = 0; j < scenario.operations; j += 1) {
      const voice = audio.play(soundId, { volume: 0.5, pan: 0, loop: false })
      if (voice != null) {
        audio.stopVoice(voice)
      }
    }
    samples[i] = performance.now() - start
  }

  const stats = summarizeSamples(samples)
  const opsPerSec = scenario.operations / (stats.avgMs / 1000)

  return {
    scenario: scenario.name,
    operations: scenario.operations,
    avgMs: Number(stats.avgMs.toFixed(4)),
    medianMs: Number(stats.medianMs.toFixed(4)),
    p95Ms: Number(stats.p95Ms.toFixed(4)),
    maxMs: Number(stats.maxMs.toFixed(4)),
    opsPerSec: Number(opsPerSec.toFixed(0)),
  }
}

function runBurstScenario(audio: Audio, soundId: number, scenario: BurstScenario): BurstResult {
  for (let i = 0; i < BURST_WARMUP_ITERATIONS; i += 1) {
    const voices: number[] = []
    for (let j = 0; j < scenario.startsPerTick; j += 1) {
      const voice = audio.play(soundId, {
        volume: 0.35,
        pan: (j % 2 === 0 ? -1 : 1) * 0.15,
        loop: false,
      })
      if (voice != null) {
        voices.push(voice)
      }
    }
    audio.mixFrames(scenario.frameCount, scenario.channels)
    for (const voice of voices) {
      audio.stopVoice(voice)
    }
  }

  const samples = new Array<number>(BURST_ITERATIONS)
  for (let i = 0; i < BURST_ITERATIONS; i += 1) {
    const start = performance.now()
    const voices: number[] = []
    for (let j = 0; j < scenario.startsPerTick; j += 1) {
      const voice = audio.play(soundId, {
        volume: 0.35,
        pan: (j % 2 === 0 ? -1 : 1) * 0.15,
        loop: false,
      })
      if (voice != null) {
        voices.push(voice)
      }
    }

    const mixed = audio.mixFrames(scenario.frameCount, scenario.channels)
    if (!mixed) {
      throw new Error(`mixFrames failed in burst scenario '${scenario.name}'`)
    }

    for (const voice of voices) {
      audio.stopVoice(voice)
    }
    samples[i] = performance.now() - start
  }

  const stats = summarizeSamples(samples)
  const ticksPerSec = 1 / (stats.avgMs / 1000)

  return {
    scenario: scenario.name,
    startsPerTick: scenario.startsPerTick,
    frames: scenario.frameCount,
    channels: scenario.channels,
    avgMs: Number(stats.avgMs.toFixed(4)),
    medianMs: Number(stats.medianMs.toFixed(4)),
    p95Ms: Number(stats.p95Ms.toFixed(4)),
    maxMs: Number(stats.maxMs.toFixed(4)),
    ticksPerSec: Number(ticksPerSec.toFixed(0)),
    deltaVsIdleTickPct: 0,
  }
}

function main(): void {
  const audio = Audio.create({ autoStart: false })

  if (!audio.startMixer()) {
    throw new Error("audio.startMixer() failed")
  }

  const wav = buildMonoPcm16Wav({
    frequency: 330,
    durationMs: 480,
    amplitude: 0.9,
    decay: 0.85,
  })
  const soundId = audio.loadSound(wav)
  if (soundId == null) {
    throw new Error("audio.loadSound() failed")
  }

  const mixResults = mixScenarios.map((scenario) => runMixScenario(audio, soundId, scenario))
  const idleMixMs = mixResults[0]?.avgMs ?? 0
  for (const row of mixResults) {
    row.deltaVsIdlePct = idleMixMs > 0 ? Number((((row.avgMs - idleMixMs) / idleMixMs) * 100).toFixed(2)) : 0
  }

  const lifecycleResults = lifecycleScenarios.map((scenario) => runVoiceLifecycleScenario(audio, soundId, scenario))

  const burstResults = burstScenarios.map((scenario) => runBurstScenario(audio, soundId, scenario))
  const idleBurstMs = burstResults[0]?.avgMs ?? 0
  for (const row of burstResults) {
    row.deltaVsIdleTickPct = idleBurstMs > 0 ? Number((((row.avgMs - idleBurstMs) / idleBurstMs) * 100).toFixed(2)) : 0
  }

  console.log(`Audio mix benchmark (${MIX_ITERATIONS} iterations, ${MIX_WARMUP_ITERATIONS} warmup)`)
  console.table(mixResults)

  console.log(
    `Audio voice lifecycle benchmark (${LIFECYCLE_ITERATIONS} iterations, ${LIFECYCLE_WARMUP_ITERATIONS} warmup)`,
  )
  console.table(lifecycleResults)

  console.log(`Audio burst benchmark (${BURST_ITERATIONS} iterations, ${BURST_WARMUP_ITERATIONS} warmup)`)
  console.table(burstResults)

  audio.dispose()
}

main()
