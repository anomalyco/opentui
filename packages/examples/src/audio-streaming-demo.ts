#!/usr/bin/env bun

import {
  Audio,
  AudioStreamError,
  BoxRenderable,
  CliRenderer,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  bold,
  createCliRenderer,
  fg,
  t,
  type AudioGroup,
  type AudioStream,
  type AudioStreamMetadata,
  type AudioStreamStats,
  type KeyEvent,
} from "@opentui/core"
import { AUDIO_DEMO_PALETTE, AUDIO_SPECTRUM_FFT_SIZE, AudioSpectrumRenderable } from "./lib/AudioSpectrum.js"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const DEMO_STATIONS = [
  { name: "FIP", url: "https://icecast.radiofrance.fr/fip-midfi.mp3" },
  { name: "WFMU", url: "https://stream0.wfmu.org/freeform-128k" },
  { name: "NPO Radio 5", url: "https://icecast.omroep.nl/radio5-bb-mp3" },
  { name: "NPR", url: "https://npr-ice.streamguys1.com/live.mp3" },
  { name: "Dance Wave", url: "https://dancewave.online/dance.mp3" },
] as const
const DEFAULT_STREAM_URL = DEMO_STATIONS[0].url
const SAMPLE_RATE = 48_000
const FFT_UPDATE_MS = 50
const VOLUME_STEP = 0.1
const PAN_STEP = 0.1

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function formatBytes(value: bigint): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes)) return `${value.toString()} B`
  if (bytes < 1024) return `${bytes.toFixed(0)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function displayMetadata(value: string | undefined): string {
  const sanitized = value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()
  return sanitized || "-"
}

class AudioStreamingDemo {
  private readonly renderer: CliRenderer
  private readonly root: BoxRenderable
  private readonly urlInput: InputRenderable
  private readonly stationButtons: Array<{ box: BoxRenderable; label: TextRenderable }> = []
  private readonly spectrumPanel: AudioSpectrumRenderable
  private readonly statsText: TextRenderable
  private readonly controlsText: TextRenderable
  private readonly audio: Audio
  private readonly fullGroup: AudioGroup
  private readonly dimGroup: AudioGroup
  private readonly frameCallback: (deltaMs: number) => Promise<void>

  private stream: AudioStream | null = null
  private streamController: AbortController | null = null
  private streamStats: AudioStreamStats | null = null
  private streamMetadata: AudioStreamMetadata | null = null
  private connectionGeneration = 0
  private destroyed = false
  private liveRequested = false
  private outputMode = "starting"
  private statusMessage = "Initializing native audio"
  private statusColor: string = AUDIO_DEMO_PALETTE.warning
  private selectedStationIndex = 0
  private volume = 0.8
  private pan = 0
  private useDimGroup = false
  private fftElapsedMs = 0
  private lastAnalyzedFrame = -1n

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
    this.renderer.setBackgroundColor(AUDIO_DEMO_PALETTE.background)

    this.root = new BoxRenderable(renderer, {
      id: "audio-streaming-demo-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      gap: 0,
      backgroundColor: AUDIO_DEMO_PALETTE.background,
    })

    const inputPanel = new BoxRenderable(renderer, {
      id: "audio-streaming-demo-input-panel",
      title: " LIVE MP3 STREAM / URL + station presets ",
      width: "100%",
      height: 6,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: AUDIO_DEMO_PALETTE.border,
      focusedBorderColor: AUDIO_DEMO_PALETTE.accent,
      backgroundColor: AUDIO_DEMO_PALETTE.panel,
      paddingLeft: 1,
      paddingRight: 1,
      flexShrink: 0,
    })
    this.urlInput = new InputRenderable(renderer, {
      id: "audio-streaming-demo-url",
      width: "100%",
      flexShrink: 0,
      value: DEFAULT_STREAM_URL,
      placeholder: "https://example.com/live.mp3",
      maxLength: 2048,
      backgroundColor: AUDIO_DEMO_PALETTE.panel,
      focusedBackgroundColor: AUDIO_DEMO_PALETTE.panelAlt,
      textColor: AUDIO_DEMO_PALETTE.text,
      focusedTextColor: "#FFFFFF",
      placeholderColor: AUDIO_DEMO_PALETTE.muted,
      cursorColor: AUDIO_DEMO_PALETTE.accent,
    })
    inputPanel.add(this.urlInput)

    const stationRow = new BoxRenderable(renderer, {
      id: "audio-streaming-demo-stations",
      width: "100%",
      height: 3,
      flexDirection: "row",
      gap: 0,
      flexShrink: 0,
    })
    for (const [index, station] of DEMO_STATIONS.entries()) {
      const box = new BoxRenderable(renderer, {
        id: `audio-streaming-demo-station-${index + 1}`,
        border: true,
        borderStyle: "single",
        borderColor: index === this.selectedStationIndex ? AUDIO_DEMO_PALETTE.accent : AUDIO_DEMO_PALETTE.border,
        backgroundColor: index === this.selectedStationIndex ? AUDIO_DEMO_PALETTE.panelAlt : AUDIO_DEMO_PALETTE.panel,
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        alignItems: "center",
        justifyContent: "center",
        onMouseDown: (event) => {
          event.stopPropagation()
          this.selectStation(index)
        },
      })
      const label = new TextRenderable(renderer, {
        id: `audio-streaming-demo-station-label-${index + 1}`,
        content: `${index + 1} ${station.name}`,
        fg: index === this.selectedStationIndex ? AUDIO_DEMO_PALETTE.signal : AUDIO_DEMO_PALETTE.muted,
        height: 1,
      })
      box.add(label)
      stationRow.add(box)
      this.stationButtons.push({ box, label })
    }
    inputPanel.add(stationRow)
    this.root.add(inputPanel)

    const body = new BoxRenderable(renderer, {
      id: "audio-streaming-demo-body",
      width: "100%",
      flexDirection: "row",
      flexGrow: 1,
      flexShrink: 1,
      gap: 0,
      minHeight: 12,
    })

    this.spectrumPanel = new AudioSpectrumRenderable(renderer, {
      id: "audio-streaming-demo-spectrum-panel",
      sampleRate: SAMPLE_RATE,
      title: " Master mix spectrum ",
      border: true,
      borderStyle: "rounded",
      borderColor: AUDIO_DEMO_PALETTE.signal,
      backgroundColor: AUDIO_DEMO_PALETTE.panel,
      paddingLeft: 1,
      paddingRight: 1,
      flexGrow: 2,
      flexBasis: 0,
      minWidth: 0,
    })

    const statsPanel = new BoxRenderable(renderer, {
      id: "audio-streaming-demo-stats-panel",
      title: " Stream telemetry ",
      border: true,
      borderStyle: "rounded",
      borderColor: AUDIO_DEMO_PALETTE.purple,
      backgroundColor: AUDIO_DEMO_PALETTE.panel,
      paddingLeft: 1,
      paddingRight: 1,
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 40,
    })
    this.statsText = new TextRenderable(renderer, {
      id: "audio-streaming-demo-stats",
      content: "",
      fg: AUDIO_DEMO_PALETTE.text,
      width: "100%",
      height: "100%",
    })
    statsPanel.add(this.statsText)

    body.add(this.spectrumPanel)
    body.add(statsPanel)
    this.root.add(body)

    const controlsPanel = new BoxRenderable(renderer, {
      id: "audio-streaming-demo-controls-panel",
      title: " Controls ",
      width: "100%",
      height: 4,
      border: true,
      borderStyle: "single",
      borderColor: AUDIO_DEMO_PALETTE.border,
      backgroundColor: AUDIO_DEMO_PALETTE.panel,
      paddingLeft: 1,
      paddingRight: 1,
      flexShrink: 0,
    })
    this.controlsText = new TextRenderable(renderer, {
      id: "audio-streaming-demo-controls",
      content: "",
      fg: AUDIO_DEMO_PALETTE.muted,
      height: 2,
    })
    controlsPanel.add(this.controlsText)
    this.root.add(controlsPanel)

    this.renderer.root.add(this.root)

    this.audio = Audio.create({ autoStart: false, sampleRate: SAMPLE_RATE })
    this.audio.on("error", (error, context) => {
      if (this.destroyed) return
      this.statusMessage = `${context.action}: ${error.message}`
      this.statusColor = AUDIO_DEMO_PALETTE.error
      this.refreshText()
    })

    this.fullGroup = this.audio.group("stream-full") ?? 0
    this.dimGroup = this.audio.group("stream-dim") ?? 0
    this.audio.setGroupVolume(this.fullGroup, 1)
    this.audio.setGroupVolume(this.dimGroup, 0.35)
    this.audio.enableTap(8192)

    if (this.audio.start()) {
      this.outputMode = "native device"
      this.statusMessage = "Audio output started"
    } else if (this.audio.startMixer()) {
      this.outputMode = "mixer only"
      this.statusMessage = "No playback device; visualization remains active"
    } else {
      this.outputMode = "unavailable"
      this.statusMessage = "Audio mixer could not start"
    }

    this.urlInput.on(InputRenderableEvents.ENTER, (value: string) => {
      this.urlInput.blur()
      this.refreshControls()
      void this.connect(value)
    })
    this.renderer.keyInput.on("keypress", this.handleKeyPress)

    this.frameCallback = async (deltaMs: number): Promise<void> => {
      this.updateFrame(deltaMs)
    }
    this.renderer.setFrameCallback(this.frameCallback)
    this.renderer.requestLive()
    this.liveRequested = true

    this.refreshText()
    void this.connect(DEFAULT_STREAM_URL)
  }

  private activeGroup(): AudioGroup {
    return this.useDimGroup ? this.dimGroup : this.fullGroup
  }

  private parseStreamUrl(rawValue: string): URL | null {
    const value = rawValue.trim()
    if (value.length === 0) {
      this.statusMessage = "Enter an MP3 stream URL"
      this.statusColor = AUDIO_DEMO_PALETTE.error
      return null
    }

    try {
      const url = new URL(value)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        this.statusMessage = "Stream URL must use http or https"
        this.statusColor = AUDIO_DEMO_PALETTE.error
        return null
      }
      return url
    } catch {
      this.statusMessage = "Stream URL is not valid"
      this.statusColor = AUDIO_DEMO_PALETTE.error
      return null
    }
  }

  private async connect(rawUrl: string): Promise<void> {
    const url = this.parseStreamUrl(rawUrl)
    if (!url || this.destroyed) {
      if (!url && !this.stream && this.streamController) {
        this.connectionGeneration += 1
        this.streamController.abort()
        this.streamController = null
      }
      this.refreshText()
      return
    }

    this.selectedStationIndex = DEMO_STATIONS.findIndex((station) => station.url === url.href)
    this.refreshStationButtons()
    const sourceName = this.selectedStationIndex >= 0 ? DEMO_STATIONS[this.selectedStationIndex]!.name : url.host

    const generation = ++this.connectionGeneration
    this.streamController?.abort()
    this.streamController = new AbortController()
    this.stream?.dispose()
    this.stream = null
    this.streamStats = null
    this.streamMetadata = null
    this.spectrumPanel.reset()
    this.lastAnalyzedFrame = 0n
    this.audio.disableTap()
    this.audio.enableTap(8192)
    this.statusMessage = `Connecting to ${sourceName}`
    this.statusColor = AUDIO_DEMO_PALETTE.warning
    this.refreshText()

    let nextStream: AudioStream
    try {
      nextStream = await this.audio.playStreamUrl(url, {
        format: "mp3",
        signal: this.streamController.signal,
        volume: this.volume,
        pan: this.pan,
        groupId: this.activeGroup(),
        buffer: {
          capacityMs: 2000,
          startupMs: 1000,
          resumeMs: 1000,
        },
        reconnect: {
          maxRetries: 5,
          retryOnEnd: true,
          initialDelayMs: 1000,
          maxDelayMs: 15_000,
          backoffFactor: 2,
        },
      })
    } catch (error) {
      if (this.destroyed || generation !== this.connectionGeneration) return
      this.statusMessage =
        error instanceof AudioStreamError
          ? `${error.context.action}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "Stream connection failed"
      this.statusColor = AUDIO_DEMO_PALETTE.error
      this.refreshText()
      return
    }

    if (this.destroyed || generation !== this.connectionGeneration) {
      nextStream.dispose()
      return
    }

    this.stream = nextStream
    this.streamMetadata = nextStream.getMetadata()
    nextStream.on("metadata", (metadata) => {
      if (!this.isCurrent(nextStream, generation)) return
      this.streamMetadata = metadata
      this.refreshText()
    })
    nextStream.on("error", (error, context) => {
      if (!this.isCurrent(nextStream, generation)) return
      this.streamStats = nextStream.getStats()
      this.statusMessage = `${context.action}: ${error.message}`
      this.statusColor = AUDIO_DEMO_PALETTE.error
    })
    nextStream.on("reconnecting", ({ attempt, delayMs, error }) => {
      if (!this.isCurrent(nextStream, generation)) return
      this.statusMessage = `Reconnect ${attempt} in ${delayMs}ms: ${error.context.action}: ${error.message}`
      this.statusColor = AUDIO_DEMO_PALETTE.warning
    })
    nextStream.on("ended", () => {
      if (!this.isCurrent(nextStream, generation)) return
      this.streamStats = nextStream.getStats()
      this.statusMessage = "Stream ended"
      this.statusColor = AUDIO_DEMO_PALETTE.muted
    })

    const volumeApplied = nextStream.setVolume(this.volume)
    const panApplied = nextStream.setPan(this.pan)
    const groupApplied = nextStream.setGroup(this.activeGroup())
    this.streamStats = nextStream.getStats()
    if (volumeApplied && panApplied && groupApplied) {
      this.statusMessage = `Connected to ${sourceName}`
      this.statusColor = AUDIO_DEMO_PALETTE.accent
    } else {
      this.statusMessage = "Connected, but current stream controls could not be applied"
      this.statusColor = AUDIO_DEMO_PALETTE.error
    }
    this.refreshText()
  }

  private isCurrent(stream: AudioStream, generation: number): boolean {
    return !this.destroyed && this.stream === stream && this.connectionGeneration === generation
  }

  private selectStation(index: number): void {
    const station = DEMO_STATIONS[index]
    if (!station) return
    this.urlInput.value = station.url
    this.urlInput.blur()
    this.refreshControls()
    void this.connect(station.url)
  }

  private refreshStationButtons(): void {
    for (const [index, button] of this.stationButtons.entries()) {
      const selected = index === this.selectedStationIndex
      button.box.borderColor = selected ? AUDIO_DEMO_PALETTE.accent : AUDIO_DEMO_PALETTE.border
      button.box.backgroundColor = selected ? AUDIO_DEMO_PALETTE.panelAlt : AUDIO_DEMO_PALETTE.panel
      button.label.fg = selected ? AUDIO_DEMO_PALETTE.signal : AUDIO_DEMO_PALETTE.muted
    }
  }

  private stopStream(): void {
    this.connectionGeneration += 1
    this.streamController?.abort()
    this.streamController = null
    this.stream?.dispose()
    this.stream = null
    this.streamStats = null
    this.streamMetadata = null
    this.lastAnalyzedFrame = -1n
    this.statusMessage = "Stream stopped"
    this.statusColor = AUDIO_DEMO_PALETTE.muted
    this.refreshText()
  }

  private adjustVolume(delta: number): void {
    const next = clamp(this.volume + delta, 0, 4)
    if (this.stream && !this.stream.setVolume(next)) {
      this.statusMessage = "Could not update stream volume"
      this.statusColor = AUDIO_DEMO_PALETTE.error
      return
    }
    this.volume = next
    this.statusMessage = `Stream volume ${this.volume.toFixed(1)}`
    this.statusColor = AUDIO_DEMO_PALETTE.accent
    this.refreshText()
  }

  private adjustPan(delta: number): void {
    const next = clamp(this.pan + delta, -1, 1)
    if (this.stream && !this.stream.setPan(next)) {
      this.statusMessage = "Could not update stream pan"
      this.statusColor = AUDIO_DEMO_PALETTE.error
      return
    }
    this.pan = next
    this.statusMessage = `Stream pan ${this.pan.toFixed(1)}`
    this.statusColor = AUDIO_DEMO_PALETTE.accent
    this.refreshText()
  }

  private toggleGroup(): void {
    const nextDimmed = !this.useDimGroup
    const nextGroup = nextDimmed ? this.dimGroup : this.fullGroup
    if (this.stream && !this.stream.setGroup(nextGroup)) {
      this.statusMessage = "Could not move the stream to another group"
      this.statusColor = AUDIO_DEMO_PALETTE.error
      return
    }
    this.useDimGroup = nextDimmed
    this.statusMessage = nextDimmed ? "Stream routed through 35% group" : "Stream routed through full group"
    this.statusColor = AUDIO_DEMO_PALETTE.accent
    this.refreshText()
  }

  private handleKeyPress = (key: KeyEvent): void => {
    if (key.name === "tab") {
      key.preventDefault()
      if (this.urlInput.focused) this.urlInput.blur()
      else this.urlInput.focus()
      this.refreshControls()
      return
    }

    if (this.urlInput.focused || key.ctrl || key.meta) return

    const stationIndex = Number.parseInt(key.name, 10) - 1
    if (key.name.length === 1 && stationIndex >= 0 && stationIndex < DEMO_STATIONS.length) {
      key.preventDefault()
      this.selectStation(stationIndex)
      return
    }

    switch (key.name) {
      case "r":
        key.preventDefault()
        void this.connect(this.urlInput.value)
        break
      case "s":
        key.preventDefault()
        this.stopStream()
        break
      case "j":
        key.preventDefault()
        this.adjustVolume(-VOLUME_STEP)
        break
      case "k":
        key.preventDefault()
        this.adjustVolume(VOLUME_STEP)
        break
      case "h":
        key.preventDefault()
        this.adjustPan(-PAN_STEP)
        break
      case "l":
        key.preventDefault()
        this.adjustPan(PAN_STEP)
        break
      case "g":
        key.preventDefault()
        this.toggleGroup()
        break
    }
  }

  private updateFrame(deltaMs: number): void {
    if (this.destroyed) return
    if (!this.audio.isStarted() && this.audio.isMixerStarted()) {
      const frameCount = Math.max(64, Math.min(2048, Math.round((SAMPLE_RATE * deltaMs) / 1000)))
      this.audio.mixFrames(frameCount, 2)
    }

    this.fftElapsedMs += deltaMs
    if (this.fftElapsedMs < FFT_UPDATE_MS) return
    this.fftElapsedMs %= FFT_UPDATE_MS

    if (this.stream) this.streamStats = this.stream.getStats()
    const engineStats = this.audio.getStats()
    const peak = engineStats?.lastPeak ?? 0
    const rms = engineStats?.lastRms ?? 0

    const playedFrames = this.streamStats?.framesPlayed ?? -1n
    if (playedFrames > 0n && playedFrames !== this.lastAnalyzedFrame) {
      this.lastAnalyzedFrame = playedFrames
      const tap = this.audio.readTapFrames(AUDIO_SPECTRUM_FFT_SIZE, 2)
      if (tap) {
        this.spectrumPanel.update({
          mode: "analyze",
          pcm: tap.frames,
          framesRead: tap.framesRead,
          channels: 2,
          peak,
          rms,
        })
      } else {
        this.spectrumPanel.update({ mode: "hold", peak, rms })
      }
    } else {
      this.spectrumPanel.update({ mode: "decay", peak, rms })
    }
    this.refreshText()
  }

  private refreshText(): void {
    const state = this.streamStats?.state ?? (this.stream ? this.stream.state : "idle")

    const stats = this.streamStats
    const bufferRatio = stats && stats.capacityFrames > 0 ? stats.bufferedFrames / stats.capacityFrames : 0
    const stateColor =
      state === "playing"
        ? AUDIO_DEMO_PALETTE.signal
        : state === "errored"
          ? AUDIO_DEMO_PALETTE.error
          : state === "idle" || state === "ended" || state === "disposed"
            ? AUDIO_DEMO_PALETTE.muted
            : AUDIO_DEMO_PALETTE.warning
    const bufferColor =
      bufferRatio >= 0.5
        ? AUDIO_DEMO_PALETTE.signal
        : bufferRatio > 0
          ? AUDIO_DEMO_PALETTE.warning
          : AUDIO_DEMO_PALETTE.muted
    const label = (value: string) => fg(AUDIO_DEMO_PALETTE.muted)(value.padEnd(9))
    const underruns = stats?.underruns ?? 0
    const reconnects = stats?.reconnectAttempts ?? 0
    const station = displayMetadata(this.streamMetadata?.headers["icy-name"])
    const title = displayMetadata(this.streamMetadata?.fields.StreamTitle)

    this.statsText.content = t`${label("state")}${bold(fg(stateColor)(state))}
${label("output")}${fg(AUDIO_DEMO_PALETTE.accent)(this.outputMode)}
${label("status")}${fg(this.statusColor)(displayMetadata(this.statusMessage))}
${label("station")}${fg(AUDIO_DEMO_PALETTE.accent)(station)}
${label("title")}${fg(AUDIO_DEMO_PALETTE.signal)(title)}
${label("buffer")}${fg(bufferColor)(`${stats?.bufferedDurationMs.toFixed(0) ?? "0"}ms ${Math.round(bufferRatio * 100)}%`)}
${label("received")}${fg(AUDIO_DEMO_PALETTE.accent)(formatBytes(stats?.bytesReceived ?? 0n))}
${label("decoded")}${fg(AUDIO_DEMO_PALETTE.purple)(`${stats?.framesDecoded.toString() ?? "0"} frames`)}
${label("played")}${fg(AUDIO_DEMO_PALETTE.signal)(`${stats?.framesPlayed.toString() ?? "0"} frames`)}
${label("health")}${fg(underruns > 0 ? AUDIO_DEMO_PALETTE.error : AUDIO_DEMO_PALETTE.muted)(`u:${underruns}`)}  ${fg(reconnects > 0 ? AUDIO_DEMO_PALETTE.warning : AUDIO_DEMO_PALETTE.muted)(`r:${reconnects}`)}
${label("volume")}${fg(AUDIO_DEMO_PALETTE.accent)(this.volume.toFixed(1))}  ${fg(AUDIO_DEMO_PALETTE.muted)("pan")} ${fg(AUDIO_DEMO_PALETTE.purple)(this.pan.toFixed(1))}
${label("group")}${fg(AUDIO_DEMO_PALETTE.signal)(this.useDimGroup ? "dim (35%)" : "full")}`
    this.refreshControls()
  }

  private refreshControls(): void {
    const mode = this.urlInput.focused ? "URL EDIT" : "CONTROLS"
    this.controlsText.content =
      `${mode} | 1-5 stations | Enter connect | Tab edit/controls | R reconnect | S stop\n` +
      `J/K volume (${this.volume.toFixed(1)}) | H/L pan (${this.pan.toFixed(1)}) | G group (${this.useDimGroup ? "dim" : "full"}) | Esc back`
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.connectionGeneration += 1
    this.streamController?.abort()
    this.streamController = null
    this.stream?.dispose()
    this.stream = null

    this.renderer.removeFrameCallback(this.frameCallback)
    if (this.liveRequested) {
      this.renderer.dropLive()
      this.liveRequested = false
    }
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.urlInput.blur()
    this.audio.dispose()
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }
}

let activeDemo: AudioStreamingDemo | null = null

export function run(renderer: CliRenderer): void {
  activeDemo?.destroy()
  activeDemo = new AudioStreamingDemo(renderer)
}

export function destroy(_renderer: CliRenderer): void {
  activeDemo?.destroy()
  activeDemo = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })
  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
