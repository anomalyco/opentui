import {
  BoxRenderable,
  RGBA,
  TextAttributes,
  type BoxOptions,
  type OptimizedBuffer,
  type RenderContext,
} from "@opentui/core"
import FFT from "fft.js"

export const AUDIO_SPECTRUM_FFT_SIZE = 2048

export const AUDIO_DEMO_PALETTE = {
  background: "#071018",
  panel: "#0C1824",
  panelAlt: "#102231",
  border: "#28465C",
  accent: "#38BDF8",
  signal: "#34D399",
  warning: "#FBBF24",
  error: "#FB7185",
  text: "#E2E8F0",
  muted: "#7C91A3",
  purple: "#C4B5FD",
} as const

const BAND_CENTERS = [63, 160, 400, 1000, 2500, 6000, 12000, 16000] as const
const BAR_RGB = [
  [244, 63, 94],
  [249, 115, 22],
  [250, 204, 21],
  [74, 222, 128],
  [45, 212, 191],
  [56, 189, 248],
  [129, 140, 248],
  [192, 132, 252],
] as const
const PEAK_FALLOFF = 0.04
const DECAY = 0.94
const DB_FLOOR = -72
const DB_CEILING = 0

const BUFFER_COLORS = {
  peak: RGBA.fromInts(251, 113, 133),
  rms: RGBA.fromInts(56, 189, 248),
  value: RGBA.fromInts(226, 232, 240),
  muted: RGBA.fromInts(124, 145, 163),
}
const LABEL_COLORS = BAR_RGB.map(([red, green, blue]) => RGBA.fromInts(red, green, blue))

interface RasterBounds {
  left: number
  right: number
  top: number
  bottom: number
}

export type AudioSpectrumUpdate = {
  peak: number
  rms: number
} & (
  | { mode: "analyze"; pcm: Float32Array; framesRead: number; channels: number }
  | { mode: "hold" }
  | { mode: "decay" }
)

export type AudioSpectrumOptions = Omit<BoxOptions, "renderAfter"> & {
  sampleRate: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function formatFrequency(value: number): string {
  return value >= 1000 ? `${value / 1000}k` : value.toString()
}

function writeBufferRgb(
  backgrounds: Uint16Array,
  bufferWidth: number,
  x: number,
  y: number,
  red: number,
  green: number,
  blue: number,
  bounds: RasterBounds,
): void {
  if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return
  const index = (y * bufferWidth + x) * 4
  backgrounds[index] = ((backgrounds[index] ?? 0) & 0xff00) | red
  backgrounds[index + 1] = ((backgrounds[index + 1] ?? 0) & 0xff00) | green
  backgrounds[index + 2] = ((backgrounds[index + 2] ?? 0) & 0xff00) | blue
}

export class AudioSpectrumRenderable extends BoxRenderable {
  private readonly sampleRate: number
  private readonly fft = new FFT(AUDIO_SPECTRUM_FFT_SIZE)
  private readonly fftInput = new Float32Array(AUDIO_SPECTRUM_FFT_SIZE)
  private readonly fftOutput = this.fft.createComplexArray()
  private readonly fftWindow = new Float32Array(AUDIO_SPECTRUM_FFT_SIZE)
  private readonly fftMagnitudes = new Float32Array(BAND_CENTERS.length)
  private readonly spectrum = new Float32Array(BAND_CENTERS.length)
  private readonly spectrumPeaks = new Float32Array(BAND_CENTERS.length)
  private fftWindowSum = 0
  private peak = 0
  private rms = 0

  constructor(ctx: RenderContext, options: AudioSpectrumOptions) {
    const { sampleRate, ...boxOptions } = options
    super(ctx, boxOptions)
    this.sampleRate = sampleRate

    for (let index = 0; index < AUDIO_SPECTRUM_FFT_SIZE; index += 1) {
      const windowValue = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (AUDIO_SPECTRUM_FFT_SIZE - 1)))
      this.fftWindow[index] = windowValue
      this.fftWindowSum += windowValue
    }

    this.renderAfter = (buffer) => this.renderSpectrum(buffer)
  }

  public update(update: AudioSpectrumUpdate): void {
    this.peak = update.peak
    this.rms = update.rms

    if (update.mode === "analyze") {
      const sampleCount = AUDIO_SPECTRUM_FFT_SIZE * update.channels
      if (
        Number.isInteger(update.channels) &&
        update.channels > 0 &&
        update.framesRead >= AUDIO_SPECTRUM_FFT_SIZE &&
        update.pcm.length >= sampleCount
      ) {
        this.computeSpectrum(update.pcm, update.channels)
      }
    } else if (update.mode === "decay") {
      for (let index = 0; index < this.spectrum.length; index += 1) this.spectrum[index] *= DECAY
    }

    for (let index = 0; index < this.spectrumPeaks.length; index += 1) {
      this.spectrumPeaks[index] = Math.max(this.spectrum[index] ?? 0, (this.spectrumPeaks[index] ?? 0) - PEAK_FALLOFF)
    }
    this.requestRender()
  }

  public reset(): void {
    this.fftInput.fill(0)
    this.fftOutput.fill(0)
    this.fftMagnitudes.fill(0)
    this.spectrum.fill(0)
    this.spectrumPeaks.fill(0)
    this.peak = 0
    this.rms = 0
    this.requestRender()
  }

  private computeSpectrum(pcm: Float32Array, channels: number): void {
    for (let index = 0; index < AUDIO_SPECTRUM_FFT_SIZE; index += 1) {
      let sample = 0
      const frameOffset = index * channels
      for (let channel = 0; channel < channels; channel += 1) sample += pcm[frameOffset + channel] ?? 0
      this.fftInput[index] = (sample / channels) * this.fftWindow[index]
    }
    this.fft.realTransform(this.fftOutput, this.fftInput)

    for (let band = 0; band < BAND_CENTERS.length; band += 1) {
      const center = BAND_CENTERS[band] ?? 60
      const previous = BAND_CENTERS[band - 1]
      const next = BAND_CENTERS[band + 1]
      const low = previous ? Math.sqrt(previous * center) : center / Math.sqrt((next ?? center * 2) / center)
      const high = next ? Math.sqrt(center * next) : center * Math.sqrt(center / (previous ?? center / 2))
      const firstBin = Math.max(1, Math.floor((low * AUDIO_SPECTRUM_FFT_SIZE) / this.sampleRate))
      const lastBin = Math.min(
        AUDIO_SPECTRUM_FFT_SIZE / 2,
        Math.ceil((high * AUDIO_SPECTRUM_FFT_SIZE) / this.sampleRate),
      )
      let maximum = 0
      for (let bin = firstBin; bin < lastBin; bin += 1) {
        const real = this.fftOutput[bin * 2] ?? 0
        const imaginary = this.fftOutput[bin * 2 + 1] ?? 0
        maximum = Math.max(maximum, (2 * Math.sqrt(real * real + imaginary * imaginary)) / this.fftWindowSum)
      }
      this.fftMagnitudes[band] = maximum
    }

    // A fixed dBFS scale preserves level changes instead of pinning each frame's strongest band.
    for (let index = 0; index < this.spectrum.length; index += 1) {
      const decibels = 20 * Math.log10(Math.max(this.fftMagnitudes[index] ?? 0, 1e-8))
      const incoming = clamp((decibels - DB_FLOOR) / (DB_CEILING - DB_FLOOR), 0, 1)
      const previous = this.spectrum[index] ?? 0
      this.spectrum[index] = incoming > previous ? incoming : previous * 0.8 + incoming * 0.2
    }
  }

  private renderSpectrum(buffer: OptimizedBuffer): void {
    const innerX = this.x + 1
    const innerY = this.y + 1
    const innerWidth = Math.max(0, this.width - 2)
    const innerHeight = Math.max(0, this.height - 2)
    if (innerWidth < 8 || innerHeight < 4) return

    const bounds: RasterBounds = {
      left: Math.max(0, innerX),
      right: Math.min(buffer.width, innerX + innerWidth),
      top: Math.max(0, innerY),
      bottom: Math.min(buffer.height, innerY + innerHeight),
    }
    if (bounds.left >= bounds.right || bounds.top >= bounds.bottom) return

    const backgrounds = buffer.buffers.bg
    this.renderLevelMeter(
      buffer,
      backgrounds,
      innerX,
      innerY,
      innerWidth,
      "PEAK",
      this.peak,
      BUFFER_COLORS.peak,
      [251, 113, 133],
      bounds,
    )
    this.renderLevelMeter(
      buffer,
      backgrounds,
      innerX,
      innerY + 1,
      innerWidth,
      "RMS",
      this.rms,
      BUFFER_COLORS.rms,
      [56, 189, 248],
      bounds,
    )

    const showLabels = innerHeight >= 7
    const labelY = innerY + innerHeight - 1
    const barsTop = innerY + 2
    const barsBottom = showLabels ? labelY - 1 : innerY + innerHeight - 1
    const availableHeight = barsBottom - barsTop + 1
    if (availableHeight <= 0) return

    const bandCount = Math.min(BAND_CENTERS.length, innerWidth)
    const gap = innerWidth >= bandCount * 3 ? 1 : 0
    const barWidth = Math.max(1, Math.floor((innerWidth - gap * (bandCount - 1)) / bandCount))
    const totalWidth = bandCount * barWidth + (bandCount - 1) * gap
    const offsetX = innerX + Math.max(0, Math.floor((innerWidth - totalWidth) / 2))

    for (let bar = 0; bar < bandCount; bar += 1) {
      const band = bandCount === 1 ? 0 : Math.round((bar * (BAND_CENTERS.length - 1)) / (bandCount - 1))
      const level = clamp(this.spectrum[band] ?? 0, 0, 1)
      const peak = clamp(this.spectrumPeaks[band] ?? 0, 0, 1)
      const filledHeight = level * availableHeight
      const rows = Math.ceil(filledHeight)
      const [baseRed, baseGreen, baseBlue] = BAR_RGB[band] ?? BAR_RGB[0]
      const xStart = offsetX + bar * (barWidth + gap)

      for (let row = 0; row < rows; row += 1) {
        const y = barsBottom - row
        const coverage = Math.min(1, filledHeight - row)
        const heightRatio = availableHeight <= 1 ? 1 : row / (availableHeight - 1)
        const intensity = (0.42 + heightRatio * 0.58) * (0.35 + coverage * 0.65)
        const red = Math.round(baseRed * intensity)
        const green = Math.round(baseGreen * intensity)
        const blue = Math.round(baseBlue * intensity)
        for (let x = xStart; x < xStart + barWidth; x += 1) {
          writeBufferRgb(backgrounds, buffer.width, x, y, red, green, blue, bounds)
        }
      }

      if (peak > 0.01) {
        const peakY = barsBottom - Math.round(peak * Math.max(0, availableHeight - 1))
        const peakRed = Math.round(baseRed * 0.45 + 140)
        const peakGreen = Math.round(baseGreen * 0.45 + 140)
        const peakBlue = Math.round(baseBlue * 0.45 + 140)
        for (let x = xStart; x < xStart + barWidth; x += 1) {
          writeBufferRgb(backgrounds, buffer.width, x, peakY, peakRed, peakGreen, peakBlue, bounds)
        }
      }

      if (showLabels && bandCount === BAND_CENTERS.length && barWidth >= 3) {
        const label = formatFrequency(BAND_CENTERS[band] ?? 0)
        const labelX = xStart + Math.max(0, Math.floor((barWidth - label.length) / 2))
        this.drawTextClipped(buffer, label, labelX, labelY, LABEL_COLORS[band] ?? BUFFER_COLORS.muted, bounds)
      }
    }
  }

  private renderLevelMeter(
    buffer: OptimizedBuffer,
    backgrounds: Uint16Array,
    x: number,
    y: number,
    width: number,
    label: string,
    value: number,
    labelColor: RGBA,
    rgb: readonly [number, number, number],
    bounds: RasterBounds,
  ): void {
    const valueText = value.toFixed(3)
    const valueX = x + width - valueText.length
    const meterX = x + label.length + 1
    const meterWidth = Math.max(0, valueX - meterX - 1)
    const filled = Math.round(clamp(value, 0, 1) * meterWidth)

    for (let column = 0; column < meterWidth; column += 1) {
      const active = column < filled
      const progress = meterWidth <= 1 ? 1 : column / (meterWidth - 1)
      const intensity = active ? 0.45 + progress * 0.55 : 0.16
      writeBufferRgb(
        backgrounds,
        buffer.width,
        meterX + column,
        y,
        Math.round(rgb[0] * intensity),
        Math.round(rgb[1] * intensity),
        Math.round(rgb[2] * intensity),
        bounds,
      )
    }

    this.drawTextClipped(buffer, label, x, y, labelColor, bounds, TextAttributes.BOLD)
    this.drawTextClipped(buffer, valueText, valueX, y, BUFFER_COLORS.value, bounds)
  }

  private drawTextClipped(
    buffer: OptimizedBuffer,
    text: string,
    x: number,
    y: number,
    color: RGBA,
    bounds: RasterBounds,
    attributes: number = TextAttributes.NONE,
  ): void {
    if (y < bounds.top || y >= bounds.bottom) return
    const start = Math.max(0, bounds.left - x)
    const end = Math.min(text.length, bounds.right - x)
    if (start >= end) return
    buffer.drawText(text.slice(start, end), x + start, y, color, undefined, attributes)
  }
}
