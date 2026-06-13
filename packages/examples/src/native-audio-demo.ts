#!/usr/bin/env bun

import { readdir, stat } from "node:fs/promises"
import { basename, dirname, extname, join, resolve } from "node:path"
import {
  Audio,
  BoxRenderable,
  CliRenderer,
  SelectRenderable,
  SelectRenderableEvents,
  type AudioPlaybackDevice,
  type AudioGroup,
  type AudioSound,
  type AudioVoice,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core"
import FFT from "fft.js"
import type { OptimizedBuffer } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

type SoundPreset = {
  name: string
  frequency: number
  durationMs: number
  volume: number
  groupName: "sfx" | "ui"
  decay: number
}

type MixTarget = "effects" | "master" | "bgm"
type FilePickerEntryType = "parent" | "directory" | "file" | "empty"

interface FilePickerEntry {
  type: FilePickerEntryType
  path: string
  name: string
}

interface FilePickerOption extends SelectOption {
  value: FilePickerEntry
}

const PRESETS: SoundPreset[] = [
  { name: "Jump", frequency: 540, durationMs: 120, volume: 0.8, groupName: "sfx", decay: 0.82 },
  { name: "Coin", frequency: 980, durationMs: 90, volume: 0.65, groupName: "ui", decay: 0.86 },
  { name: "Thud", frequency: 140, durationMs: 200, volume: 0.9, groupName: "sfx", decay: 0.75 },
]

const DEFAULT_SAMPLE_RATE = 48_000
const SAMPLE_RATE_OPTIONS = [22_050, 32_000, 44_100, 48_000, 96_000]
const DEFAULT_PLAYBACK_CHANNELS = 2
const PLAYBACK_CHANNEL_OPTIONS = [1, 2, 4]
const MIX_TARGETS: MixTarget[] = ["effects", "master", "bgm"]
const VOLUME_STEP = 0.05
const PAN_STEP = 0.1
const MIN_VOLUME = 0
const MAX_VOLUME = 2
const FFT_SIZE = 2048
const FFT_BINS = 28
const FFT_BANDS = 8
const FFT_BAR_WIDTH = 6
const FFT_BAND_CENTERS = [63, 160, 400, 1000, 2500, 6000, 12000, 16000]
const FFT_400_INDEX = 2
const FFT_12K_INDEX = 6
const VIS_BARS = 28
const VIS_PEAK_FALLOFF_PER_SEC = 1.15
const VIS_BAR_RELEASE = 0.22
const KICK_LOW_BAND_INDEX = 0
const KICK_HIGH_BAND_INDEX = 1
const KICK_REFRACTORY_MS = 95
const KICK_DISPLAY_HOLD_MS = 120
const KICK_HISTORY_SIZE = 32
const KICK_MIN_RATIO = 0.24
const KICK_MIN_FLUX = 0.008
const KICK_THRESHOLD_STD = 1.4
const DEVICE_MENU_MAX_ROWS = 3
const FILE_PICKER_HEIGHT = 24
const FILE_PICKER_WIDTH = 92
const FILE_PICKER_TITLE_HEIGHT = 3
const FILE_PICKER_SELECT_HEIGHT = FILE_PICKER_HEIGHT - FILE_PICKER_TITLE_HEIGHT - 4
const SUPPORTED_AUDIO_FILE_EXTENSIONS = new Set([".flac", ".mp3", ".wav", ".wave"])

const fft = new FFT(FFT_SIZE)
const fftInput = new Float32Array(FFT_SIZE)
const fftOut = fft.createComplexArray()
const fftWindow = new Float32Array(FFT_SIZE)
const fftDisplay = new Float32Array(FFT_BANDS)
const fftBandLevels = new Float32Array(FFT_BANDS)
const fftVizBars = new Float32Array(VIS_BARS)
const fftVizPeak = new Float32Array(VIS_BARS)

for (let i = 0; i < FFT_SIZE; i += 1) {
  fftWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)))
}

let root: BoxRenderable | null = null
let titleText: TextRenderable | null = null
let statusText: TextRenderable | null = null
let mixText: TextRenderable | null = null
let deviceText: TextRenderable | null = null
let statsText: TextRenderable | null = null
let meterText: TextRenderable | null = null
let bgmFileText: TextRenderable | null = null
let controlsText: TextRenderable | null = null
let outputText: TextRenderable | null = null
let filePickerContainer: BoxRenderable | null = null
let filePickerTitleText: TextRenderable | null = null
let filePickerSelect: SelectRenderable | null = null

let keyHandler: ((event: KeyEvent) => void) | null = null

let audio: Audio | null = null
let groups: { sfx: AudioGroup; music: AudioGroup; ui: AudioGroup } | null = null
let sounds: Array<AudioSound | null> = []
let musicSound: AudioSound | null = null
let musicVoice: AudioVoice | null = null
let masterVolume = 1
let masterPan = 0
let effectsVolume = 1
let effectsPan = 0
let bgmVolume = 0.42
let bgmPan = 0
let selectedMixTargetIndex = 0
let playbackDevices: AudioPlaybackDevice[] = []
let selectedPlaybackDeviceIndex: number | null = null
let activePlaybackDeviceIndex: number | null = null
let selectedSampleRateIndex = Math.max(0, SAMPLE_RATE_OPTIONS.indexOf(DEFAULT_SAMPLE_RATE))
let activeSampleRate = SAMPLE_RATE_OPTIONS[selectedSampleRateIndex] ?? DEFAULT_SAMPLE_RATE
let selectedPlaybackChannelIndex = Math.max(0, PLAYBACK_CHANNEL_OPTIONS.indexOf(DEFAULT_PLAYBACK_CHANNELS))
let activePlaybackChannels = PLAYBACK_CHANNEL_OPTIONS[selectedPlaybackChannelIndex] ?? DEFAULT_PLAYBACK_CHANNELS
let reconfiguringOutputConfig = false
let selectedBgmPath: string | null = null
let filePickerDirectory = resolve(process.cwd())
let filePickerVisible = false
let filePickerRequestId = 0

let lastAction = "Ready"
let fourHundredBandLevel = 0
let twelveKBandLevel = 0
let kickPrevLowEnergy = 0
let kickFluxHistory: number[] = []
let kickClockMs = 0
let kickLastTriggerAtMs = -1_000_000
let kickVisibleUntilMs = 0
let kickCount = 0
let vizClockSeconds = 0
let bgVizIntensity = 0

function writeMaxNormalizedChannel(buffer: Uint16Array, index: number, value: number): void {
  const existing = buffer[index] ?? 0
  const existingChannel = existing & 0xff
  const nextChannel = Math.round(Math.max(0, Math.min(1, value)) * 255)
  if (nextChannel > existingChannel) {
    buffer[index] = (existing & 0xff00) | nextChannel
  }
}

const fftBackgroundPostProcess = (buffer: OptimizedBuffer, deltaTime: number): void => {
  vizClockSeconds += deltaTime / 1000
  const width = buffer.width
  const height = buffer.height
  if (width <= 0 || height <= 0) return

  const bg = buffer.buffers.bg
  const barWidth = Math.max(1, Math.floor(width / VIS_BARS))
  const spacing = 1
  const totalBarWidth = VIS_BARS * barWidth - spacing
  const barOffsetX = Math.max(0, Math.floor((width - totalBarWidth) / 2))
  const usableHeight = Math.max(4, Math.floor(height * 0.62))
  const baseY = height - 1

  const falloff = VIS_PEAK_FALLOFF_PER_SEC * (deltaTime / 1000)
  const pulse = 0.08 + (isKickVisible() ? 0.28 : 0)

  for (let i = 0; i < VIS_BARS; i += 1) {
    const level = Math.max(0, Math.min(1, fftVizBars[i] ?? 0))
    const barHeight = Math.floor(level * usableHeight)

    const peak = Math.max(level, (fftVizPeak[i] ?? 0) - falloff)
    fftVizPeak[i] = Math.max(0, peak)
    const peakY = baseY - Math.floor(Math.max(0, Math.min(1, peak)) * usableHeight)

    const xStart = barOffsetX + i * barWidth
    const xEnd = Math.min(width, xStart + barWidth - spacing)

    for (let x = xStart; x < xEnd; x += 1) {
      for (let y = baseY; y >= baseY - barHeight && y >= 0; y -= 1) {
        const t = 1 - (baseY - y) / Math.max(1, barHeight)
        const idx = (y * width + x) * 4
        const r = Math.min(1, 0.12 + t * 1.05 + pulse * 0.2)
        const g = Math.min(1, 0.22 + (1 - Math.abs(t - 0.35) * 1.4) * 0.95 + pulse)
        const b = Math.min(1, 0.1 + (1 - t) * 0.24)
        writeMaxNormalizedChannel(bg, idx, r * bgVizIntensity)
        writeMaxNormalizedChannel(bg, idx + 1, g * bgVizIntensity)
        writeMaxNormalizedChannel(bg, idx + 2, b * bgVizIntensity)
      }

      if (peakY >= 0 && peakY < height) {
        const idx = (peakY * width + x) * 4
        writeMaxNormalizedChannel(bg, idx, 0.95 * bgVizIntensity)
        writeMaxNormalizedChannel(bg, idx + 1, 0.95 * bgVizIntensity)
        writeMaxNormalizedChannel(bg, idx + 2, 0.85 * bgVizIntensity)
      }
    }
  }
}

function buildMonoPcm16Wav(options: {
  frequency: number
  durationMs: number
  amplitude: number
  decay: number
}): Uint8Array {
  const sampleRate = activeSampleRate
  const sampleCount = Math.max(1, Math.floor((sampleRate * options.durationMs) / 1000))
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
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bitsPerSample, true)
  out.set([0x64, 0x61, 0x74, 0x61], 36)
  view.setUint32(40, dataSize, true)

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate
    const envelope = Math.pow(Math.max(0, 1 - i / sampleCount), options.decay)
    const value = Math.sin(2 * Math.PI * options.frequency * t) * options.amplitude * envelope
    const sample = Math.round(Math.max(-1, Math.min(1, value)) * 32767)
    view.setInt16(44 + i * 2, sample, true)
  }

  return out
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampVolume(value: number): number {
  return clamp(value, MIN_VOLUME, MAX_VOLUME)
}

function clampPan(value: number): number {
  return clamp(value, -1, 1)
}

function selectedMixTarget(): MixTarget {
  return MIX_TARGETS[selectedMixTargetIndex] ?? "effects"
}

function mixTargetLabel(target: MixTarget): string {
  switch (target) {
    case "effects":
      return "Effects"
    case "master":
      return "Master"
    case "bgm":
      return "BGM"
  }
}

function formatSigned(value: number): string {
  const normalized = Math.abs(value) < 0.005 ? 0 : value
  return normalized >= 0 ? `+${normalized.toFixed(2)}` : normalized.toFixed(2)
}

function formatMixTarget(target: MixTarget, volume: number, pan: number): string {
  const marker = selectedMixTarget() === target ? ">" : " "
  return `${marker}${mixTargetLabel(target)} v${volume.toFixed(2)} p${formatSigned(pan)}`
}

function presetBasePan(index: number): number {
  return index === 0 ? -0.2 : index === 1 ? 0.2 : 0
}

function applyGroupVolumes(): void {
  if (!groups || !audio) return
  audio.setGroupVolume(groups.sfx, effectsVolume)
  audio.setGroupVolume(groups.ui, clampVolume(effectsVolume * 0.9))
  audio.setGroupVolume(groups.music, bgmVolume)
}

function playBgmVoice(): void {
  if (!musicSound || !groups || !audio) return
  musicVoice = audio.play(musicSound, {
    volume: 1,
    pan: clampPan(bgmPan + masterPan),
    loop: true,
    groupId: groups.music,
  })
  if (!musicVoice) {
    lastAction = "BGM start failed (output unavailable)"
    updateHeader()
  }
}

function restartBgmVoiceIfPlaying(): void {
  if (!musicVoice || !audio) return
  audio.stopVoice(musicVoice)
  musicVoice = null
  playBgmVoice()
}

function selectMixTarget(step: number): void {
  selectedMixTargetIndex = (selectedMixTargetIndex + step + MIX_TARGETS.length) % MIX_TARGETS.length
  lastAction = `Selected ${mixTargetLabel(selectedMixTarget())}`
  updateHeader()
}

function adjustSelectedVolume(delta: number): void {
  if (!audio) return
  const target = selectedMixTarget()

  switch (target) {
    case "effects":
      effectsVolume = clampVolume(effectsVolume + delta)
      applyGroupVolumes()
      lastAction = `Effects volume ${effectsVolume.toFixed(2)}`
      break
    case "master":
      masterVolume = clampVolume(masterVolume + delta)
      audio.setMasterVolume(masterVolume)
      lastAction = `Master volume ${masterVolume.toFixed(2)}`
      break
    case "bgm":
      bgmVolume = clampVolume(bgmVolume + delta)
      applyGroupVolumes()
      lastAction = `BGM volume ${bgmVolume.toFixed(2)}`
      break
  }

  updateHeader()
}

function adjustSelectedPan(delta: number): void {
  const target = selectedMixTarget()

  switch (target) {
    case "effects":
      effectsPan = clampPan(effectsPan + delta)
      lastAction = `Effects pan ${formatSigned(effectsPan)}`
      break
    case "master":
      masterPan = clampPan(masterPan + delta)
      restartBgmVoiceIfPlaying()
      lastAction = `Master pan ${formatSigned(masterPan)}`
      break
    case "bgm":
      bgmPan = clampPan(bgmPan + delta)
      restartBgmVoiceIfPlaying()
      lastAction = `BGM pan ${formatSigned(bgmPan)}`
      break
  }

  updateHeader()
}

function meterBar(value: number, width = 28): string {
  const clamped = Math.max(0, Math.min(1, value))
  const filled = Math.floor(clamped * width)
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`
}

function rangeBar(value: number, width: number = FFT_BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(1, value))
  const filled = Math.round(clamped * width)
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`
}

function computeSpectrum(pcm: Float32Array, channels: number): string {
  const stride = Math.max(1, channels)
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const sampleIndex = i * stride
    const left = pcm[sampleIndex] ?? 0
    const right = channels > 1 ? (pcm[sampleIndex + 1] ?? left) : left
    fftInput[i] = (left + right) * 0.5 * fftWindow[i]
  }

  fft.realTransform(fftOut, fftInput)

  const nyquistBins = FFT_SIZE / 2
  const nyquistHz = activeSampleRate / 2
  const minHz = 30
  const logMin = Math.log(minHz)
  const logMax = Math.log(nyquistHz)
  const buckets = new Array<number>(FFT_BINS).fill(0)

  for (let bucket = 0; bucket < FFT_BINS; bucket += 1) {
    let sum = 0
    let count = 0
    const t0 = bucket / FFT_BINS
    const t1 = (bucket + 1) / FFT_BINS
    const hz0 = Math.exp(logMin + (logMax - logMin) * t0)
    const hz1 = Math.exp(logMin + (logMax - logMin) * t1)
    const start = Math.max(1, Math.floor((hz0 / nyquistHz) * (nyquistBins - 1)))
    const end = Math.min(nyquistBins, Math.max(start + 1, Math.ceil((hz1 / nyquistHz) * (nyquistBins - 1))))
    for (let i = start; i < end; i += 1) {
      const re = fftOut[i * 2] ?? 0
      const im = fftOut[i * 2 + 1] ?? 0
      const mag = Math.sqrt(re * re + im * im)
      sum += mag
      count += 1
    }
    buckets[bucket] = count > 0 ? sum / count : 0
  }

  const maxBucket = Math.max(0.00001, ...buckets)
  const normalized = buckets.map((value) => Math.pow(value / maxBucket, 0.45))

  for (let i = 0; i < VIS_BARS; i += 1) {
    const incoming = normalized[i] ?? 0
    const previous = fftVizBars[i] ?? 0
    fftVizBars[i] = incoming > previous ? incoming : previous * (1 - VIS_BAR_RELEASE) + incoming * VIS_BAR_RELEASE
  }

  const lowerBoundaries: number[] = []
  const upperBoundaries: number[] = []
  for (let i = 0; i < FFT_BAND_CENTERS.length; i += 1) {
    const current = FFT_BAND_CENTERS[i] ?? 0
    const prev = FFT_BAND_CENTERS[i - 1]
    const next = FFT_BAND_CENTERS[i + 1]
    const low = prev ? Math.sqrt(prev * current) : 20
    const high = next ? Math.sqrt(current * next) : nyquistHz
    lowerBoundaries.push(low)
    upperBoundaries.push(high)
  }

  let out = ""
  for (let i = 0; i < FFT_BANDS; i += 1) {
    const low = lowerBoundaries[i] ?? 20
    const high = upperBoundaries[i] ?? nyquistHz
    const lowBin = Math.max(0, Math.floor((low / nyquistHz) * (FFT_BINS - 1)))
    const highBin = Math.min(FFT_BINS - 1, Math.max(lowBin, Math.ceil((high / nyquistHz) * (FFT_BINS - 1))))

    let sum = 0
    let count = 0
    for (let bin = lowBin; bin <= highBin; bin += 1) {
      sum += normalized[bin] ?? 0
      count += 1
    }

    const incoming = count > 0 ? sum / count : 0
    const previous = fftDisplay[i] ?? 0
    const smoothed = incoming > previous ? incoming : previous * 0.86 + incoming * 0.14
    fftDisplay[i] = smoothed
    fftBandLevels[i] = smoothed
    if (i === FFT_400_INDEX) {
      fourHundredBandLevel = smoothed
    }
    if (i === FFT_12K_INDEX) {
      twelveKBandLevel = smoothed
    }
    out += rangeBar(smoothed)
  }

  return out
}

function updateKickDetector(deltaMs: number): void {
  kickClockMs += deltaMs

  const low = fftBandLevels[KICK_LOW_BAND_INDEX] ?? 0
  const lowHigh = fftBandLevels[KICK_HIGH_BAND_INDEX] ?? 0
  const lowEnergy = low * 1.2 + lowHigh * 0.8
  const totalEnergy = fftBandLevels.reduce((sum, value) => sum + value, 0.00001)
  const lowRatio = lowEnergy / totalEnergy

  const flux = Math.max(0, lowEnergy - kickPrevLowEnergy)
  kickPrevLowEnergy = lowEnergy

  kickFluxHistory.push(flux)
  if (kickFluxHistory.length > KICK_HISTORY_SIZE) {
    kickFluxHistory.shift()
  }

  if (kickFluxHistory.length < 8) return

  const mean = kickFluxHistory.reduce((sum, value) => sum + value, 0) / kickFluxHistory.length
  const variance =
    kickFluxHistory.reduce((sum, value) => {
      const d = value - mean
      return sum + d * d
    }, 0) / kickFluxHistory.length
  const std = Math.sqrt(variance)
  const threshold = Math.max(KICK_MIN_FLUX, mean + std * KICK_THRESHOLD_STD)
  const refractoryOver = kickClockMs - kickLastTriggerAtMs >= KICK_REFRACTORY_MS

  if (refractoryOver && lowRatio >= KICK_MIN_RATIO && flux > threshold) {
    kickLastTriggerAtMs = kickClockMs
    kickVisibleUntilMs = kickClockMs + KICK_DISPLAY_HOLD_MS
    kickCount += 1
  }
}

function isKickVisible(): boolean {
  return kickClockMs <= kickVisibleUntilMs
}

function truncateDeviceName(name: string, maxLength: number = 40): string {
  return name.length <= maxLength ? name : `${name.slice(0, Math.max(1, maxLength - 3))}...`
}

function selectedPlaybackDevicePosition(): number {
  if (playbackDevices.length === 0) return -1
  if (selectedPlaybackDeviceIndex == null) return 0
  const position = playbackDevices.findIndex((device) => device.index === selectedPlaybackDeviceIndex)
  return position >= 0 ? position : 0
}

function selectedPlaybackDevice(): AudioPlaybackDevice | null {
  const position = selectedPlaybackDevicePosition()
  if (position < 0 || position >= playbackDevices.length) return null
  return playbackDevices[position] ?? null
}

function activePlaybackDevice(): AudioPlaybackDevice | null {
  if (activePlaybackDeviceIndex == null) return null
  return playbackDevices.find((device) => device.index === activePlaybackDeviceIndex) ?? null
}

function selectedSampleRate(): number {
  return SAMPLE_RATE_OPTIONS[selectedSampleRateIndex] ?? DEFAULT_SAMPLE_RATE
}

function formatSampleRate(sampleRate: number): string {
  return `${sampleRate} Hz`
}

function selectedPlaybackChannels(): number {
  return PLAYBACK_CHANNEL_OPTIONS[selectedPlaybackChannelIndex] ?? DEFAULT_PLAYBACK_CHANNELS
}

function formatPlaybackChannels(channels: number): string {
  return `${channels} ch`
}

function formatBgmPath(filePath: string): string {
  const name = basename(filePath)
  return name.length > 32 ? `${name.slice(0, 29)}...` : name
}

function updateBgmFileText(): void {
  if (!bgmFileText) return

  const loadedFile = selectedBgmPath ? formatBgmPath(selectedBgmPath) : "none selected"
  bgmFileText.content = `BGM file: ${loadedFile} | F choose audio file | B play/stop selected file`
}

function getFilePickerOption(option: SelectOption): FilePickerOption {
  return option as FilePickerOption
}

function isSupportedAudioFileName(fileName: string): boolean {
  return SUPPORTED_AUDIO_FILE_EXTENSIONS.has(extname(fileName).toLowerCase())
}

function isVisibleFilePickerName(name: string): boolean {
  return !name.startsWith(".")
}

function updateFilePickerTitle(message?: string): void {
  if (!filePickerTitleText) return

  const status = message ? `\n${message}` : ""
  filePickerTitleText.content = `Choose BGM audio file | Enter open/load | Backspace parent | Esc close\n${filePickerDirectory}${status}`
}

async function classifyFilePickerEntry(
  directory: string,
  name: string,
  isDirectory: boolean,
  isFile: boolean,
): Promise<FilePickerEntry | null> {
  if (!isVisibleFilePickerName(name)) return null

  const entryPath = join(directory, name)
  if (isDirectory) return { type: "directory", path: entryPath, name }
  if (isFile) return isSupportedAudioFileName(name) ? { type: "file", path: entryPath, name } : null

  try {
    const stats = await stat(entryPath)
    if (stats.isDirectory()) return { type: "directory", path: entryPath, name }
    if (stats.isFile()) return isSupportedAudioFileName(name) ? { type: "file", path: entryPath, name } : null
  } catch {
    return null
  }

  return null
}

function entryToOption(entry: FilePickerEntry): FilePickerOption {
  const prefix = entry.type === "directory" ? "/" : ""

  return {
    name: `${entry.name}${prefix}`,
    description: "",
    value: entry,
  }
}

async function refreshFilePicker(directory: string = filePickerDirectory): Promise<void> {
  const requestId = ++filePickerRequestId
  filePickerDirectory = resolve(directory)
  updateFilePickerTitle("Loading...")

  try {
    const dirents = await readdir(filePickerDirectory, { withFileTypes: true })
    if (requestId !== filePickerRequestId) return

    const entries = (
      await Promise.all(
        dirents.map((dirent) =>
          classifyFilePickerEntry(filePickerDirectory, dirent.name, dirent.isDirectory(), dirent.isFile()),
        ),
      )
    )
      .filter((entry): entry is FilePickerEntry => entry != null)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return a.name.localeCompare(b.name)
      })

    const parentDirectory = dirname(filePickerDirectory)
    const options: FilePickerOption[] =
      parentDirectory === filePickerDirectory
        ? []
        : [
            {
              name: "../",
              description: `Parent: ${parentDirectory}`,
              value: { type: "parent", path: parentDirectory, name: ".." },
            },
          ]

    options.push(...entries.map(entryToOption))

    if (options.length === 0) {
      options.push({
        name: "(empty)",
        description: "No supported audio files or visible directories in this directory",
        value: { type: "empty", path: filePickerDirectory, name: "" },
      })
    }

    if (filePickerSelect) {
      filePickerSelect.options = options
      filePickerSelect.setSelectedIndex(0)
    }
    updateFilePickerTitle()
  } catch (error) {
    if (requestId !== filePickerRequestId) return

    const message = error instanceof Error ? error.message : "Unknown error"
    if (filePickerSelect) {
      filePickerSelect.options = [
        {
          name: "(unreadable)",
          description: message,
          value: { type: "empty", path: filePickerDirectory, name: "" },
        },
      ]
      filePickerSelect.setSelectedIndex(0)
    }
    updateFilePickerTitle(`Error: ${message}`)
  }
}

function showFilePicker(): void {
  if (!filePickerContainer || !filePickerSelect) return

  filePickerVisible = true
  filePickerContainer.visible = true
  filePickerSelect.focus()
  void refreshFilePicker(filePickerDirectory)
}

function hideFilePicker(): void {
  if (!filePickerContainer || !filePickerSelect) return

  filePickerVisible = false
  filePickerSelect.blur()
  filePickerContainer.visible = false
}

async function loadBgmFile(filePath: string): Promise<void> {
  if (!audio) {
    lastAction = "Audio engine unavailable"
    updateHeader()
    return
  }

  const displayName = formatBgmPath(filePath)
  const previousVoice = musicVoice
  lastAction = `Loading BGM ${displayName}...`
  updateHeader()

  const nextSound = await audio.loadSoundFile(filePath)
  if (nextSound == null) {
    lastAction = `BGM load failed: ${displayName}`
    updateHeader()
    return
  }

  if (previousVoice != null) {
    audio.stopVoice(previousVoice)
  }

  selectedBgmPath = filePath
  musicSound = nextSound
  musicVoice = null

  if (groups && audio.isMixerStarted()) {
    playBgmVoice()
    lastAction = musicVoice ? `BGM playing ${displayName}` : `BGM loaded ${displayName}`
  } else {
    lastAction = `BGM loaded ${displayName}`
  }

  updateHeader()
}

async function handleFilePickerOption(option: SelectOption): Promise<void> {
  const entry = getFilePickerOption(option).value
  if (entry.type === "empty") return

  if (entry.type === "parent" || entry.type === "directory") {
    await refreshFilePicker(entry.path)
    return
  }

  hideFilePicker()
  await loadBgmFile(entry.path)
}

function attachAudioErrorHandler(nextAudio: Audio): void {
  nextAudio.on("error", (error, context) => {
    lastAction = `${context.action}: ${error.message}`
    updateHeader()
  })
}

async function initializeAudioForOutputConfig(
  sampleRate: number,
  playbackChannels: number,
  resumeBgm: boolean,
): Promise<boolean> {
  const preferredDeviceIndex = selectedPlaybackDeviceIndex ?? activePlaybackDeviceIndex
  const previousAudio = audio
  const nextAudio = Audio.create({ autoStart: false, sampleRate, playbackChannels })
  attachAudioErrorHandler(nextAudio)

  audio = nextAudio
  activeSampleRate = sampleRate
  activePlaybackChannels = playbackChannels
  previousAudio?.dispose()

  groups = null
  sounds = []
  musicSound = null
  musicVoice = null
  selectedPlaybackDeviceIndex = preferredDeviceIndex
  activePlaybackDeviceIndex = null

  if (!refreshPlaybackDevices(true)) {
    playbackDevices = []
    selectedPlaybackDeviceIndex = null
  }

  if (playbackDevices.length > 0) {
    const defaultDevice = playbackDevices.find((device) => device.isDefault) ?? playbackDevices[0]
    if (selectedPlaybackDeviceIndex == null) {
      selectedPlaybackDeviceIndex = defaultDevice?.index ?? null
    }

    if (selectedPlaybackDeviceIndex != null && nextAudio.selectPlaybackDevice(selectedPlaybackDeviceIndex)) {
      activePlaybackDeviceIndex = selectedPlaybackDeviceIndex
    }
  }

  let outputStarted = nextAudio.start()
  if (!outputStarted) {
    if (activePlaybackDeviceIndex != null) {
      nextAudio.clearPlaybackDeviceSelection()
      activePlaybackDeviceIndex = null
    }

    outputStarted = nextAudio.start()
    if (!outputStarted) {
      lastAction = nextAudio.startMixer() ? "Playback unavailable; mixer-only mode" : "Audio engine unavailable"
    } else {
      lastAction = "Output started with default device"
    }
  } else if (activePlaybackDeviceIndex != null) {
    const activeDevice = activePlaybackDevice()
    lastAction = activeDevice ? `Output device ${truncateDeviceName(activeDevice.name, 26)}` : "Output started"
  } else {
    lastAction = "Output started with default device"
  }

  const sfxGroup = nextAudio.group("sfx")
  const musicGroup = nextAudio.group("music")
  const uiGroup = nextAudio.group("ui")
  groups =
    sfxGroup != null && musicGroup != null && uiGroup != null ? { sfx: sfxGroup, music: musicGroup, ui: uiGroup } : null

  if (!nextAudio.enableTap(8192)) {
    lastAction = "Audio tap unavailable; visualization disabled"
  }
  nextAudio.setMasterVolume(masterVolume)
  applyGroupVolumes()

  sounds = PRESETS.map((preset) => {
    const wav = buildMonoPcm16Wav({
      frequency: preset.frequency,
      durationMs: preset.durationMs,
      amplitude: 0.95,
      decay: preset.decay,
    })
    return nextAudio.loadSound(wav)
  })

  musicSound = selectedBgmPath ? await nextAudio.loadSoundFile(selectedBgmPath) : null
  if (selectedBgmPath && musicSound == null) {
    lastAction = `BGM unavailable: ${formatBgmPath(selectedBgmPath)}`
  }

  if (resumeBgm && musicSound && groups && nextAudio.isMixerStarted()) {
    playBgmVoice()
  }

  return true
}

function stepSampleRate(step: number): void {
  if (SAMPLE_RATE_OPTIONS.length === 0) return
  selectedSampleRateIndex = (selectedSampleRateIndex + step + SAMPLE_RATE_OPTIONS.length) % SAMPLE_RATE_OPTIONS.length
  lastAction = `Sample rate cursor ${formatSampleRate(selectedSampleRate())}`
  updateHeader()
}

function stepPlaybackChannels(step: number): void {
  if (PLAYBACK_CHANNEL_OPTIONS.length === 0) return
  selectedPlaybackChannelIndex =
    (selectedPlaybackChannelIndex + step + PLAYBACK_CHANNEL_OPTIONS.length) % PLAYBACK_CHANNEL_OPTIONS.length
  lastAction = `Playback channels cursor ${formatPlaybackChannels(selectedPlaybackChannels())}`
  updateHeader()
}

async function applySelectedSampleRate(): Promise<void> {
  if (reconfiguringOutputConfig) {
    lastAction = "Output config change already in progress"
    updateHeader()
    return
  }

  const targetSampleRate = selectedSampleRate()
  if (targetSampleRate === activeSampleRate) {
    lastAction = `Sample rate already ${formatSampleRate(activeSampleRate)}`
    updateHeader()
    return
  }

  reconfiguringOutputConfig = true
  const shouldResumeBgm = musicVoice != null
  lastAction = `Switching sample rate to ${formatSampleRate(targetSampleRate)}...`
  updateHeader()

  try {
    await initializeAudioForOutputConfig(targetSampleRate, activePlaybackChannels, shouldResumeBgm)
    lastAction = `Sample rate active ${formatSampleRate(activeSampleRate)}`
  } catch {
    lastAction = `Sample rate switch failed (${formatSampleRate(targetSampleRate)})`
  } finally {
    reconfiguringOutputConfig = false
    updateHeader()
  }
}

async function applySelectedPlaybackChannels(): Promise<void> {
  if (reconfiguringOutputConfig) {
    lastAction = "Output config change already in progress"
    updateHeader()
    return
  }

  const targetPlaybackChannels = selectedPlaybackChannels()
  if (targetPlaybackChannels === activePlaybackChannels) {
    lastAction = `Playback channels already ${formatPlaybackChannels(activePlaybackChannels)}`
    updateHeader()
    return
  }

  reconfiguringOutputConfig = true
  const shouldResumeBgm = musicVoice != null
  lastAction = `Switching playback channels to ${formatPlaybackChannels(targetPlaybackChannels)}...`
  updateHeader()

  try {
    await initializeAudioForOutputConfig(activeSampleRate, targetPlaybackChannels, shouldResumeBgm)
    lastAction = `Playback channels active ${formatPlaybackChannels(activePlaybackChannels)}`
  } catch {
    lastAction = `Playback channels switch failed (${formatPlaybackChannels(targetPlaybackChannels)})`
  } finally {
    reconfiguringOutputConfig = false
    updateHeader()
  }
}

function refreshPlaybackDevices(keepSelection: boolean = true): boolean {
  if (!audio) return false

  const devices = audio.listPlaybackDevices()
  if (!devices) return false

  const previousSelected = selectedPlaybackDeviceIndex
  const previousActive = activePlaybackDeviceIndex
  playbackDevices = devices

  if (playbackDevices.length === 0) {
    selectedPlaybackDeviceIndex = null
    activePlaybackDeviceIndex = null
    updateDeviceMenu()
    return true
  }

  const defaultDevice = playbackDevices.find((device) => device.isDefault) ?? playbackDevices[0]

  if (
    keepSelection &&
    previousSelected != null &&
    playbackDevices.some((device) => device.index === previousSelected)
  ) {
    selectedPlaybackDeviceIndex = previousSelected
  } else {
    selectedPlaybackDeviceIndex = defaultDevice?.index ?? null
  }

  activePlaybackDeviceIndex =
    previousActive != null && playbackDevices.some((device) => device.index === previousActive) ? previousActive : null

  updateDeviceMenu()
  return true
}

function stepPlaybackDevice(step: number): void {
  if (playbackDevices.length === 0) {
    lastAction = "No playback devices"
    updateHeader()
    return
  }

  const currentPosition = selectedPlaybackDevicePosition()
  const nextPosition = (currentPosition + step + playbackDevices.length) % playbackDevices.length
  const nextDevice = playbackDevices[nextPosition]
  selectedPlaybackDeviceIndex = nextDevice?.index ?? null
  if (nextDevice) {
    lastAction = `Device cursor ${truncateDeviceName(nextDevice.name, 26)}`
  }
  updateHeader()
}

function applySelectedPlaybackDevice(): void {
  if (!audio) return

  const selectedDevice = selectedPlaybackDevice()
  if (!selectedDevice) {
    lastAction = "No playback device selected"
    updateHeader()
    return
  }

  const resumeBgm = musicVoice != null
  if (musicVoice) {
    audio.stopVoice(musicVoice)
    musicVoice = null
  }

  if (audio.isMixerStarted() && !audio.stop()) {
    lastAction = "Failed to stop current output"
    updateHeader()
    return
  }

  if (!audio.selectPlaybackDevice(selectedDevice.index)) {
    lastAction = `Failed selecting ${truncateDeviceName(selectedDevice.name, 24)}`
    updateHeader()
    return
  }

  const selectedOutputStarted = audio.start()
  let outputStarted = selectedOutputStarted
  if (!selectedOutputStarted) {
    audio.clearPlaybackDeviceSelection()
    activePlaybackDeviceIndex = null
    outputStarted = audio.start()
  }

  if (!outputStarted) {
    const mixerStarted = audio.startMixer()
    lastAction = mixerStarted
      ? `Failed ${truncateDeviceName(selectedDevice.name, 20)}; mixer-only mode`
      : `Failed to start ${truncateDeviceName(selectedDevice.name, 20)}`
  } else if (!selectedOutputStarted) {
    lastAction = `Device unavailable; fallback default (${truncateDeviceName(selectedDevice.name, 20)})`
  } else {
    activePlaybackDeviceIndex = selectedDevice.index
    lastAction = `Output device ${truncateDeviceName(selectedDevice.name, 26)}`
  }

  if (!outputStarted && !audio.isMixerStarted()) {
    updateHeader()
    return
  }

  audio.setMasterVolume(masterVolume)
  applyGroupVolumes()
  if (resumeBgm && musicSound && groups && audio.isMixerStarted()) {
    playBgmVoice()
  }

  updateHeader()
}

function outputStateLabel(): string {
  if (!audio) return "OFF"
  if (audio.isStarted()) return "ON (miniaudio)"
  if (audio.isMixerStarted()) return "MIXER ONLY"
  return "OFF"
}

function mixOfflineFrame(deltaMs: number): void {
  if (!audio || audio.isStarted() || !audio.isMixerStarted()) return
  const frameCount = Math.max(64, Math.min(2048, Math.round((activeSampleRate * deltaMs) / 1000)))
  audio.mixFrames(frameCount, 2)
}

function updateDeviceMenu(): void {
  if (!deviceText) return

  const selectedRate = selectedSampleRate()
  const rateHeader = `Rate n/m select | g apply (${formatSampleRate(selectedRate)} -> ${formatSampleRate(activeSampleRate)})`
  const selectedChannels = selectedPlaybackChannels()
  const channelsHeader = `Channels y/i select | t apply (${formatPlaybackChannels(selectedChannels)} -> ${formatPlaybackChannels(activePlaybackChannels)})`

  if (playbackDevices.length === 0) {
    deviceText.content = `${rateHeader}\n${channelsHeader}\nDevices u/o select | p apply | r refresh\n(no playback devices found)`
    return
  }

  const selectedPosition = selectedPlaybackDevicePosition()
  let windowStart = Math.max(0, selectedPosition - Math.floor(DEVICE_MENU_MAX_ROWS / 2))
  if (windowStart + DEVICE_MENU_MAX_ROWS > playbackDevices.length) {
    windowStart = Math.max(0, playbackDevices.length - DEVICE_MENU_MAX_ROWS)
  }
  const windowEnd = Math.min(playbackDevices.length, windowStart + DEVICE_MENU_MAX_ROWS)

  const lines: string[] = []
  for (let i = windowStart; i < windowEnd; i += 1) {
    const device = playbackDevices[i]
    if (!device) continue
    const selected = i === selectedPosition ? ">" : " "
    const active = device.index === activePlaybackDeviceIndex ? "@" : " "
    const defaultMark = device.isDefault ? "*" : " "
    lines.push(`${selected}${active}${defaultMark} ${truncateDeviceName(device.name)}`)
  }

  const header = `Devices u/o select | p apply | r refresh (${selectedPosition + 1}/${playbackDevices.length})`
  deviceText.content = `${rateHeader}\n${channelsHeader}\n${header}\n${lines.join("\n")}`
}

function updateHeader(): void {
  if (!statusText) return
  statusText.content = `Action: ${lastAction}`

  if (mixText) {
    const items = [
      formatMixTarget("effects", effectsVolume, effectsPan),
      formatMixTarget("master", masterVolume, masterPan),
      formatMixTarget("bgm", bgmVolume, bgmPan),
    ]
    mixText.content = `Select j/k item | h/l volume | H/L pan\n${items.join("  ")}`
  }

  if (outputText && audio) {
    const activeDevice = activePlaybackDevice()
    const activeDeviceLabel = audio.isStarted()
      ? activeDevice
        ? truncateDeviceName(activeDevice.name, 18)
        : "default/auto"
      : "none"
    outputText.content = `Output: ${outputStateLabel()} | ${formatSampleRate(activeSampleRate)} ${formatPlaybackChannels(activePlaybackChannels)} | Device ${activeDeviceLabel} | 400=${(fourHundredBandLevel * 100).toFixed(0)}% 12k=${(twelveKBandLevel * 100).toFixed(0)}% | Kick ${isKickVisible() ? "HIT" : "-"}`
  }

  updateBgmFileText()
  updateDeviceMenu()
}

function triggerSound(index: number): void {
  if (!groups || !audio || index < 0 || index >= sounds.length) return
  const sound = sounds[index]
  if (sound == null) {
    lastAction = `${PRESETS[index]?.name ?? "Sound"} unavailable`
    updateHeader()
    return
  }
  const preset = PRESETS[index]
  const voice = audio.play(sound, {
    volume: preset.volume,
    pan: clampPan(presetBasePan(index) + effectsPan + masterPan),
    loop: false,
    groupId: groups[preset.groupName],
  })
  lastAction = voice ? `${preset.name} trigger` : `${preset.name} failed (output unavailable)`
  updateHeader()
}

function updateAudioView(deltaMs: number = 16): void {
  if (!audio || !meterText || !statsText) return

  mixOfflineFrame(deltaMs)

  const analysis = audio.readTapFrames(FFT_SIZE, 2)
  const stats = audio.getStats()
  if (!stats) {
    statsText.content = "Stats unavailable"
    meterText.content =
      "Peak [----------------------------] 0.000\nRMS  [----------------------------] 0.000\nFFT  [------][------][------][------][------][------][------][------]\nBand   63    160    400    1k    2.5k    6k    12k    16k"
    return
  }

  const peak = stats.lastPeak
  const rms = stats.lastRms
  const tapFrames = analysis?.framesRead ?? 0
  const spectrum =
    tapFrames > 0 && analysis
      ? computeSpectrum(analysis.frames, 2)
      : "[------][------][------][------][------][------][------][------]"
  updateKickDetector(deltaMs)
  bgVizIntensity = Math.max(0.2, Math.min(1, fourHundredBandLevel * 1.35))

  meterText.content = `Peak ${meterBar(peak)} ${peak.toFixed(3)}\nRMS  ${meterBar(rms)} ${rms.toFixed(3)}\nFFT  ${spectrum}\nBand   63    160    400    1k    2.5k    6k    12k    16k`

  statsText.content = `sounds=${stats.soundsLoaded} voices=${stats.voicesActive} tap=${tapFrames} frames=${stats.framesMixed.toString()} lockMisses=${stats.lockMisses} kicks=${kickCount}`

  updateHeader()
}

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.setBackgroundColor("#111319")
  renderer.addPostProcessFn(fftBackgroundPostProcess)
  renderer.start()

  masterVolume = 1
  masterPan = 0
  effectsVolume = 1
  effectsPan = 0
  bgmVolume = 0.42
  bgmPan = 0
  selectedMixTargetIndex = 0

  selectedSampleRateIndex = Math.max(0, SAMPLE_RATE_OPTIONS.indexOf(activeSampleRate))
  activeSampleRate = selectedSampleRate()
  selectedPlaybackChannelIndex = Math.max(0, PLAYBACK_CHANNEL_OPTIONS.indexOf(activePlaybackChannels))
  activePlaybackChannels = selectedPlaybackChannels()
  await initializeAudioForOutputConfig(activeSampleRate, activePlaybackChannels, false)

  root = new BoxRenderable(renderer, {
    id: "native-audio-demo-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    backgroundColor: "#111319",
  })
  renderer.root.add(root)

  titleText = new TextRenderable(renderer, {
    id: "native-audio-demo-title",
    content: "Audio Demo - selectable mix controls",
    fg: "#FFFFFF",
    height: 1,
  })
  root.add(titleText)

  statusText = new TextRenderable(renderer, {
    id: "native-audio-demo-status",
    content: "Action: Ready",
    fg: "#EAB308",
    height: 1,
  })
  root.add(statusText)

  mixText = new TextRenderable(renderer, {
    id: "native-audio-demo-mix",
    content: "Select j/k item | h/l volume | H/L pan",
    fg: "#67E8F9",
    height: 2,
    marginTop: 1,
  })
  root.add(mixText)

  deviceText = new TextRenderable(renderer, {
    id: "native-audio-demo-devices",
    content:
      "Rate n/m select | g apply (48000 Hz -> 48000 Hz)\nChannels y/i select | t apply (2 ch -> 2 ch)\nDevices u/o select | p apply | r refresh\n(no playback devices found)",
    fg: "#93C5FD",
    height: 3 + DEVICE_MENU_MAX_ROWS,
    marginTop: 1,
  })
  root.add(deviceText)

  meterText = new TextRenderable(renderer, {
    id: "native-audio-demo-meter",
    content:
      "Peak [----------------------------] 0.000\nRMS  [----------------------------] 0.000\nFFT  [------][------][------][------][------][------][------][------]\nBand   63    160    400    1k    2.5k    6k    12k    16k",
    fg: "#34D399",
    height: 4,
    marginTop: 1,
  })
  root.add(meterText)

  statsText = new TextRenderable(renderer, {
    id: "native-audio-demo-stats",
    content: "sounds=0 voices=0 frames=0 lockMisses=0",
    fg: "#A78BFA",
    height: 1,
    marginTop: 1,
  })
  root.add(statsText)

  outputText = new TextRenderable(renderer, {
    id: "native-audio-demo-output",
    content: "Output: OFF",
    fg: "#FCA5A5",
    height: 1,
    marginTop: 1,
  })
  root.add(outputText)

  bgmFileText = new TextRenderable(renderer, {
    id: "native-audio-demo-bgm-file",
    content: "BGM file: none selected | F choose audio file | B play/stop selected file",
    fg: "#FDE68A",
    height: 1,
    marginTop: 1,
  })
  root.add(bgmFileText)

  controlsText = new TextRenderable(renderer, {
    id: "native-audio-demo-controls",
    content:
      "1/2/3 trigger effects | F choose BGM file | B bgm on/off | J/K mix target | H/L vol | Shift+H/Shift+L pan\nU/O device cursor | P apply device | R refresh devices | N/M sample rate | G apply rate | Y/I channels | T apply channels | Esc back",
    fg: "#9CA3AF",
    height: 2,
    marginTop: 1,
  })
  root.add(controlsText)

  filePickerContainer = new BoxRenderable(renderer, {
    id: "native-audio-demo-file-picker",
    position: "absolute",
    left: "50%",
    top: "50%",
    width: FILE_PICKER_WIDTH,
    height: FILE_PICKER_HEIGHT,
    marginLeft: -(FILE_PICKER_WIDTH / 2),
    marginTop: -(FILE_PICKER_HEIGHT / 2),
    zIndex: 200,
    border: true,
    borderStyle: "rounded",
    borderColor: "#FDE68A",
    backgroundColor: "#111827",
    flexDirection: "column",
    padding: 1,
    visible: false,
  })

  filePickerTitleText = new TextRenderable(renderer, {
    id: "native-audio-demo-file-picker-title",
    content: "Choose BGM audio file",
    fg: "#FDE68A",
    height: FILE_PICKER_TITLE_HEIGHT,
  })
  filePickerContainer.add(filePickerTitleText)

  filePickerSelect = new SelectRenderable(renderer, {
    id: "native-audio-demo-file-picker-select",
    width: "100%",
    height: FILE_PICKER_SELECT_HEIGHT,
    options: [],
    backgroundColor: "#111827",
    focusedBackgroundColor: "#1F2937",
    textColor: "#E5E7EB",
    focusedTextColor: "#F9FAFB",
    selectedBackgroundColor: "#92400E",
    selectedTextColor: "#FFFFFF",
    descriptionColor: "#9CA3AF",
    selectedDescriptionColor: "#FDE68A",
    showDescription: false,
    showScrollIndicator: true,
    wrapSelection: false,
    fastScrollStep: 5,
  })
  filePickerSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    void handleFilePickerOption(option)
  })
  filePickerContainer.add(filePickerSelect)
  root.add(filePickerContainer)

  updateHeader()

  if (musicSound && groups && audio?.isMixerStarted()) {
    playBgmVoice()
    lastAction = "BGM auto start"
    updateHeader()
  }

  updateAudioView()

  keyHandler = (event: KeyEvent) => {
    if (filePickerVisible) {
      switch (event.name) {
        case "escape":
          hideFilePicker()
          lastAction = "File picker closed"
          updateHeader()
          break
        case "backspace":
          void refreshFilePicker(dirname(filePickerDirectory))
          break
        case "r":
          void refreshFilePicker(filePickerDirectory)
          break
      }
      return
    }

    if (!audio) return
    switch (event.name) {
      case "1":
        triggerSound(0)
        break
      case "2":
        triggerSound(1)
        break
      case "3":
        triggerSound(2)
        break
      case "f":
        showFilePicker()
        lastAction = "Choose a BGM audio file"
        updateHeader()
        break
      case "j":
        selectMixTarget(1)
        break
      case "k":
        selectMixTarget(-1)
        break
      case "u":
        stepPlaybackDevice(-1)
        break
      case "o":
        stepPlaybackDevice(1)
        break
      case "p":
        applySelectedPlaybackDevice()
        break
      case "r":
        if (refreshPlaybackDevices(true)) {
          lastAction =
            playbackDevices.length > 0
              ? `Device list refreshed (${playbackDevices.length})`
              : "No playback devices found"
        } else {
          lastAction = "Failed to refresh playback devices"
        }
        updateHeader()
        break
      case "n":
        stepSampleRate(-1)
        break
      case "m":
        stepSampleRate(1)
        break
      case "g":
        void applySelectedSampleRate()
        break
      case "y":
        stepPlaybackChannels(-1)
        break
      case "i":
        stepPlaybackChannels(1)
        break
      case "t":
        void applySelectedPlaybackChannels()
        break
      case "h":
      case "l": {
        const delta = event.name === "h" ? -1 : 1
        if (event.shift) {
          adjustSelectedPan(delta * PAN_STEP)
        } else {
          adjustSelectedVolume(delta * VOLUME_STEP)
        }
        break
      }
      case "b":
        if (!musicSound) {
          lastAction = "Choose a BGM file first"
          updateHeader()
          break
        }
        if (musicVoice) {
          audio.stopVoice(musicVoice)
          musicVoice = null
          lastAction = "BGM stop"
        } else {
          playBgmVoice()
          if (musicVoice) {
            lastAction = "BGM start"
          }
        }
        updateHeader()
        break
    }
  }

  renderer.keyInput.on("keypress", keyHandler)

  renderer.setFrameCallback(async (deltaMs) => {
    updateAudioView(deltaMs)
  })
}

export function destroy(renderer: CliRenderer): void {
  renderer.clearFrameCallbacks()

  if (keyHandler) {
    renderer.keyInput.off("keypress", keyHandler)
    keyHandler = null
  }

  renderer.removePostProcessFn(fftBackgroundPostProcess)

  renderer.root.remove("native-audio-demo-root")
  root = null
  titleText = null
  statusText = null
  mixText = null
  deviceText = null
  statsText = null
  outputText = null
  meterText = null
  bgmFileText = null
  controlsText = null
  filePickerTitleText = null
  filePickerSelect = null
  filePickerContainer = null

  audio?.dispose()
  audio = null
  groups = null
  sounds = []
  musicSound = null
  musicVoice = null
  masterVolume = 1
  masterPan = 0
  effectsVolume = 1
  effectsPan = 0
  bgmVolume = 0.42
  bgmPan = 0
  selectedMixTargetIndex = 0
  playbackDevices = []
  selectedPlaybackDeviceIndex = null
  activePlaybackDeviceIndex = null
  selectedSampleRateIndex = Math.max(0, SAMPLE_RATE_OPTIONS.indexOf(DEFAULT_SAMPLE_RATE))
  activeSampleRate = SAMPLE_RATE_OPTIONS[selectedSampleRateIndex] ?? DEFAULT_SAMPLE_RATE
  selectedPlaybackChannelIndex = Math.max(0, PLAYBACK_CHANNEL_OPTIONS.indexOf(DEFAULT_PLAYBACK_CHANNELS))
  activePlaybackChannels = PLAYBACK_CHANNEL_OPTIONS[selectedPlaybackChannelIndex] ?? DEFAULT_PLAYBACK_CHANNELS
  reconfiguringOutputConfig = false
  selectedBgmPath = null
  filePickerDirectory = resolve(process.cwd())
  filePickerVisible = false
  filePickerRequestId += 1
  fourHundredBandLevel = 0
  twelveKBandLevel = 0
  fftDisplay.fill(0)
  fftBandLevels.fill(0)
  fftVizBars.fill(0)
  fftVizPeak.fill(0)
  vizClockSeconds = 0
  bgVizIntensity = 0
  kickPrevLowEnergy = 0
  kickFluxHistory = []
  kickClockMs = 0
  kickLastTriggerAtMs = -1_000_000
  kickVisibleUntilMs = 0
  kickCount = 0
  lastAction = "Ready"
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })
  await run(renderer)
  setupCommonDemoKeys(renderer)
}
