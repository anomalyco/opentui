import { RGBA, DEFAULT_BACKGROUND_RGB, DEFAULT_FOREGROUND_RGB, ansi256IndexToRgb } from "./RGBA.js"
import { SystemClock, type Clock, type TimerHandle } from "./clock.js"
import { env, registerEnvVar } from "./env.js"

type Hex = string | null

const SYSTEM_CLOCK = new SystemClock()

registerEnvVar({
  name: "OTUI_PALETTE_IDLE_TIMEOUT_MS",
  description: "Milliseconds of silence after palette queries before using fallback colors.",
  type: "number",
  default: 300,
})

const OSC4_RESPONSE =
  /\x1b]4;(\d+);(?:(?:rgb:)([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)|#([0-9a-fA-F]{6}))(?:\x07|\x1b\\)/g

const OSC_SPECIAL_RESPONSE =
  /\x1b](\d+);(?:(?:rgb:)([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)|#([0-9a-fA-F]{6}))(?:\x07|\x1b\\)/g

export type WriteFunction = (data: string | Buffer) => boolean

export interface TerminalColors {
  palette: Hex[]
  defaultForeground: Hex
  defaultBackground: Hex
  cursorColor: Hex
  mouseForeground: Hex
  mouseBackground: Hex
  tekForeground: Hex
  tekBackground: Hex
  highlightBackground: Hex
  highlightForeground: Hex
}

export interface GetPaletteOptions {
  timeout?: number
  size?: number
}

export interface TerminalPaletteDetector {
  detect(options?: GetPaletteOptions): Promise<TerminalColors>
  detectOSCSupport(timeoutMs?: number): Promise<boolean>
  cleanup(): void
}

export interface NormalizedTerminalPalette {
  palette: RGBA[]
  defaultForeground: RGBA
  defaultBackground: RGBA
}

export type OscSubscriptionSource = {
  subscribeOsc(handler: (sequence: string) => void): () => void
}

export interface TerminalPaletteOptions {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  writeFn?: WriteFunction
  isLegacyTmux?: boolean
  isTmux?: boolean
  oscSource?: OscSubscriptionSource
  clock?: Clock
}

function scaleComponent(comp: string): string {
  const val = parseInt(comp, 16)
  const maxIn = (1 << (4 * comp.length)) - 1
  return Math.round((val / maxIn) * 255)
    .toString(16)
    .padStart(2, "0")
}

function toHex(r?: string, g?: string, b?: string, hex6?: string): string {
  if (hex6) return `#${hex6.toLowerCase()}`
  if (r && g && b) return `#${scaleComponent(r)}${scaleComponent(g)}${scaleComponent(b)}`
  return "#000000"
}

const SPECIAL_COLORS = {
  10: "defaultForeground",
  11: "defaultBackground",
  12: "cursorColor",
  13: "mouseForeground",
  14: "mouseBackground",
  15: "tekForeground",
  16: "tekBackground",
  17: "highlightBackground",
  19: "highlightForeground",
} as const satisfies Record<number, Exclude<keyof TerminalColors, "palette">>

export function emptyTerminalColors(size: number): TerminalColors {
  const colors = { palette: Array(size).fill(null) } as TerminalColors
  for (const key of Object.values(SPECIAL_COLORS)) colors[key] = null
  return colors
}

/** Copies the OSC 4 and OSC 10-19 color replies in `sequence` into `colors`; returns whether a color changed. */
export function applyPaletteReplies(colors: TerminalColors, sequence: string): boolean {
  let changed = false
  let m: RegExpExecArray | null
  OSC4_RESPONSE.lastIndex = 0
  while ((m = OSC4_RESPONSE.exec(sequence))) {
    const index = parseInt(m[1], 10)
    const hex = toHex(m[2], m[3], m[4], m[5])
    if (index >= colors.palette.length || colors.palette[index] === hex) continue
    colors.palette[index] = hex
    changed = true
  }
  OSC_SPECIAL_RESPONSE.lastIndex = 0
  while ((m = OSC_SPECIAL_RESPONSE.exec(sequence))) {
    const key = SPECIAL_COLORS[parseInt(m[1], 10) as keyof typeof SPECIAL_COLORS]
    const hex = toHex(m[2], m[3], m[4], m[5])
    if (!key || colors[key] === hex) continue
    colors[key] = hex
    changed = true
  }
  return changed
}

/**
 * Wrap OSC sequence for tmux passthrough
 * tmux requires DCS sequences to pass OSC to the underlying terminal
 * Format: ESC P tmux; ESC <OSC_SEQUENCE> ESC \
 */
function wrapForTmux(osc: string): string {
  // Replace ESC with ESC ESC for tmux (escape the escape)
  const escaped = osc.replace(/\x1b/g, "\x1b\x1b")
  return `\x1bPtmux;${escaped}\x1b\\`
}

export class TerminalPalette implements TerminalPaletteDetector {
  private stdin: NodeJS.ReadStream
  private stdout: NodeJS.WriteStream
  private writeFn: WriteFunction
  private activeQuerySessions: Array<() => void> = []
  private inLegacyTmux: boolean
  private inTmux: boolean
  private oscSource?: OscSubscriptionSource
  private readonly clock: Clock

  constructor(options: TerminalPaletteOptions) {
    const { stdin, stdout, writeFn, isLegacyTmux, isTmux, oscSource, clock } = options

    this.stdin = stdin
    this.stdout = stdout
    this.writeFn = writeFn || ((data: string | Buffer) => stdout.write(data))
    this.inLegacyTmux = isLegacyTmux ?? false
    this.inTmux = isTmux ?? this.inLegacyTmux
    this.oscSource = oscSource
    this.clock = clock ?? SYSTEM_CLOCK
  }

  private writeOsc(osc: string, wrapForLegacyTmux = false): boolean {
    const data = wrapForLegacyTmux && this.inLegacyTmux ? wrapForTmux(osc) : osc
    return this.writeFn(data)
  }

  cleanup(): void {
    for (const cleanupSession of [...this.activeQuerySessions]) {
      cleanupSession()
    }
    this.activeQuerySessions = []
  }

  private subscribeInput(handler: (chunk: string | Buffer) => void): () => void {
    if (this.oscSource) {
      return this.oscSource.subscribeOsc((sequence) => {
        handler(sequence)
      })
    }

    this.stdin.on("data", handler)
    return () => {
      this.stdin.removeListener("data", handler)
    }
  }

  private createQuerySession() {
    const timers = new Set<TimerHandle>()
    const subscriptions = new Set<() => void>()
    let closed = false

    const cleanup = () => {
      if (closed) return
      closed = true

      for (const timer of timers) {
        this.clock.clearTimeout(timer)
      }
      timers.clear()

      for (const unsubscribe of subscriptions) {
        unsubscribe()
      }
      subscriptions.clear()

      const idx = this.activeQuerySessions.indexOf(cleanup)
      if (idx !== -1) this.activeQuerySessions.splice(idx, 1)
    }

    this.activeQuerySessions.push(cleanup)

    return {
      setTimer: (fn: () => void, ms: number): TimerHandle => {
        const timer = this.clock.setTimeout(fn, ms)
        timers.add(timer)
        return timer
      },
      resetTimer: (existing: TimerHandle | null, fn: () => void, ms: number): TimerHandle => {
        if (existing) {
          this.clock.clearTimeout(existing)
          timers.delete(existing)
        }

        const timer = this.clock.setTimeout(fn, ms)
        timers.add(timer)
        return timer
      },
      subscribeInput: (handler: (chunk: string | Buffer) => void): (() => void) => {
        const unsubscribe = this.subscribeInput(handler)
        subscriptions.add(unsubscribe)
        return () => {
          if (!subscriptions.has(unsubscribe)) return
          subscriptions.delete(unsubscribe)
          unsubscribe()
        }
      },
      cleanup,
    }
  }

  async detectOSCSupport(timeoutMs = 300): Promise<boolean> {
    const out = this.stdout

    if (!out.isTTY || !this.stdin.isTTY) return false

    return new Promise<boolean>((resolve) => {
      const session = this.createQuerySession()
      let buffer = ""
      let settled = false

      const finish = (supported: boolean) => {
        if (settled) return
        settled = true
        session.cleanup()
        resolve(supported)
      }

      const onData = (chunk: string | Buffer) => {
        buffer += chunk.toString()
        // Reset regex lastIndex before testing due to global flag
        OSC4_RESPONSE.lastIndex = 0
        if (OSC4_RESPONSE.test(buffer)) {
          finish(true)
        }
      }

      session.setTimer(() => {
        finish(false)
      }, timeoutMs)
      session.subscribeInput(onData)
      // Only OSC 4 needs legacy tmux passthrough; tmux routes OSC 4 replies back to the pane.
      this.writeOsc("\x1b]4;0;?\x07", true)
    })
  }

  private async queryPalette(
    indices: number[],
    timeoutMs = 1200,
    idleTimeoutMs = env.OTUI_PALETTE_IDLE_TIMEOUT_MS,
  ): Promise<Map<number, Hex>> {
    const out = this.stdout
    const results = new Map<number, Hex>()
    indices.forEach((i) => results.set(i, null))

    if (!out.isTTY || !this.stdin.isTTY) {
      return results
    }

    return new Promise<Map<number, Hex>>((resolve) => {
      const session = this.createQuerySession()
      let buffer = ""
      let idleTimer: TimerHandle | null = null
      let settled = false

      const finish = () => {
        if (settled) return
        settled = true
        session.cleanup()
        resolve(results)
      }

      const onData = (chunk: string | Buffer) => {
        buffer += chunk.toString()

        let m: RegExpExecArray | null
        OSC4_RESPONSE.lastIndex = 0
        while ((m = OSC4_RESPONSE.exec(buffer))) {
          const idx = parseInt(m[1], 10)
          if (results.has(idx)) results.set(idx, toHex(m[2], m[3], m[4], m[5]))
        }

        if (buffer.length > 8192) buffer = buffer.slice(-4096)

        const done = [...results.values()].filter((v) => v !== null).length
        if (done === results.size) {
          finish()
          return
        }

        idleTimer = session.resetTimer(idleTimer, finish, idleTimeoutMs)
      }

      session.setTimer(finish, timeoutMs)
      session.subscribeInput(onData)
      // Only OSC 4 needs legacy tmux passthrough; tmux routes OSC 4 replies back to the pane.
      this.writeOsc(indices.map((i) => `\x1b]4;${i};?\x07`).join(""), true)
      idleTimer = session.resetTimer(idleTimer, finish, idleTimeoutMs)
    })
  }

  private async querySpecialColors(
    timeoutMs = 1200,
    idleTimeoutMs = env.OTUI_PALETTE_IDLE_TIMEOUT_MS,
  ): Promise<Record<number, Hex>> {
    const out = this.stdout
    const results: Record<number, Hex> = Object.fromEntries(Object.keys(SPECIAL_COLORS).map((osc) => [osc, null]))
    // tmux handles plain OSC 10/11/12 only; it has no OSC 13-17/19 handlers or reply routing.
    const queries = this.inTmux ? [10, 11, 12] : [10, 11, 12, 13, 14, 15, 16, 17, 19]

    if (!out.isTTY || !this.stdin.isTTY) {
      return results
    }

    return new Promise<Record<number, Hex>>((resolve) => {
      const session = this.createQuerySession()
      let buffer = ""
      let idleTimer: TimerHandle | null = null
      let settled = false

      const finish = () => {
        if (settled) return
        settled = true
        session.cleanup()
        resolve(results)
      }

      const onData = (chunk: string | Buffer) => {
        buffer += chunk.toString()
        let updated = false

        let m: RegExpExecArray | null
        OSC_SPECIAL_RESPONSE.lastIndex = 0
        while ((m = OSC_SPECIAL_RESPONSE.exec(buffer))) {
          const idx = parseInt(m[1], 10)
          if (idx in results) {
            results[idx] = toHex(m[2], m[3], m[4], m[5])
            updated = true
          }
        }

        if (buffer.length > 8192) buffer = buffer.slice(-4096)

        if (queries.every((idx) => results[idx] !== null)) {
          finish()
          return
        }

        if (!updated) return

        idleTimer = session.resetTimer(idleTimer, finish, idleTimeoutMs)
      }

      session.setTimer(finish, timeoutMs)
      session.subscribeInput(onData)
      // OSC 10/11/12 are plain tmux handlers. DCS passthrough does not help other special colors.
      this.writeOsc(queries.map((idx) => `\x1b]${idx};?\x07`).join(""))
      idleTimer = session.resetTimer(idleTimer, finish, idleTimeoutMs)
    })
  }

  async detect(options?: GetPaletteOptions): Promise<TerminalColors> {
    const { timeout = 5000, size = 16 } = options || {}
    const supported = await this.detectOSCSupport()

    if (!supported) return emptyTerminalColors(size)

    const indicesToQuery = [...Array(size).keys()]
    const idleTimeout = env.OTUI_PALETTE_IDLE_TIMEOUT_MS
    const [paletteResults, specialColors] = await Promise.all([
      this.queryPalette(indicesToQuery, timeout, idleTimeout),
      this.querySpecialColors(timeout, idleTimeout),
    ])

    const colors = emptyTerminalColors(size)
    colors.palette = colors.palette.map((_, i) => paletteResults.get(i) ?? null)
    for (const [osc, key] of Object.entries(SPECIAL_COLORS)) colors[key] = specialColors[Number(osc)]
    return colors
  }
}

export function createTerminalPalette(options: TerminalPaletteOptions): TerminalPaletteDetector {
  return new TerminalPalette(options)
}

const DEFAULT_FOREGROUND_FALLBACK = RGBA.fromInts(...DEFAULT_FOREGROUND_RGB)
const DEFAULT_BACKGROUND_FALLBACK = RGBA.fromInts(...DEFAULT_BACKGROUND_RGB)

let fallbackAnsi256Palette: RGBA[] | null = null

function getFallbackAnsi256Palette(): readonly RGBA[] {
  if (!fallbackAnsi256Palette) {
    fallbackAnsi256Palette = Array.from({ length: 256 }, (_, index) => {
      const [r, g, b] = ansi256IndexToRgb(index)
      return RGBA.fromInts(r, g, b)
    })
  }

  return fallbackAnsi256Palette
}

export function normalizeTerminalPalette(colors?: TerminalColors | null): NormalizedTerminalPalette {
  const fallbackPalette = getFallbackAnsi256Palette()

  return {
    palette: Array.from({ length: 256 }, (_, index) => {
      const detected = colors?.palette[index]
      return detected ? RGBA.fromHex(detected) : RGBA.clone(fallbackPalette[index])
    }),
    defaultForeground: colors?.defaultForeground
      ? RGBA.fromHex(colors.defaultForeground)
      : RGBA.clone(DEFAULT_FOREGROUND_FALLBACK),
    defaultBackground: colors?.defaultBackground
      ? RGBA.fromHex(colors.defaultBackground)
      : RGBA.clone(DEFAULT_BACKGROUND_FALLBACK),
  }
}

export function buildTerminalPaletteSignature(colors?: TerminalColors | null): string {
  const normalized = normalizeTerminalPalette(colors)
  const paletteSignature = normalized.palette.map((color) => color.toInts().join(",")).join(";")

  return [
    paletteSignature,
    normalized.defaultForeground.toInts().join(","),
    normalized.defaultBackground.toInts().join(","),
  ].join("|")
}
