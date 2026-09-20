import { parseColor } from "./lib/RGBA.js"
import { type Clock, type TimerHandle } from "./lib/clock.js"
import type { ThemeMode } from "./types.js"

const OSC_THEME_RESPONSE =
  /\x1b](10|11);(?:(?:rgb:)([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)|#([0-9a-fA-F]{6}))(?:\x07|\x1b\\)/g

const DEVICE_ATTRIBUTES_REPLY = /\x1b\[\?[0-9;]*c/

function scaleOscThemeComponent(component: string): string {
  const value = parseInt(component, 16)
  const maxValue = (1 << (4 * component.length)) - 1
  return Math.round((value / maxValue) * 255)
    .toString(16)
    .padStart(2, "0")
}

function oscThemeColorToHex(r?: string, g?: string, b?: string, hex6?: string): string {
  if (hex6) {
    return `#${hex6.toLowerCase()}`
  }

  if (r && g && b) {
    return `#${scaleOscThemeComponent(r)}${scaleOscThemeComponent(g)}${scaleOscThemeComponent(b)}`
  }

  return "#000000"
}

function inferThemeModeFromBackgroundColor(color: string): ThemeMode {
  const [r, g, b] = parseColor(color).toInts()
  const brightness = (r * 299 + g * 587 + b * 114) / 1000
  return brightness > 128 ? "light" : "dark"
}

export interface RendererThemeModeHost {
  queryThemeColors(): void
}

type ThemeWaiter = {
  resolve: (mode: ThemeMode | null) => void
  timeoutHandle: TimerHandle | null
}

export class RendererThemeMode {
  private static readonly QUERY_TIMEOUT_MS = 250

  private _themeMode: ThemeMode | null = null
  private themeQueryPending = true
  private themeOscForeground: string | null = null
  private themeOscBackground: string | null = null
  private themeRefreshTimeoutId: TimerHandle | null = null
  private waiters = new Set<ThemeWaiter>()

  constructor(
    private readonly host: RendererThemeModeHost,
    private readonly clock: Clock,
  ) {}

  public get themeMode(): ThemeMode | null {
    return this._themeMode
  }

  public waitForThemeMode(timeoutMs: number, isDestroyed: boolean): Promise<ThemeMode | null> {
    if (this._themeMode !== null || isDestroyed || timeoutMs === 0) {
      return Promise.resolve(this._themeMode)
    }

    return new Promise<ThemeMode | null>((resolve) => {
      const waiter: ThemeWaiter = {
        resolve,
        timeoutHandle: null,
      }

      if (timeoutMs > 0) {
        waiter.timeoutHandle = this.clock.setTimeout(() => {
          this.waiters.delete(waiter)
          waiter.timeoutHandle = null
          resolve(this._themeMode)
        }, timeoutMs)
      }

      this.waiters.add(waiter)
    })
  }

  public cancelRefresh(): void {
    if (this.themeRefreshTimeoutId === null) {
      return
    }

    this.clock.clearTimeout(this.themeRefreshTimeoutId)
    this.themeRefreshTimeoutId = null
    this.themeQueryPending = false
  }

  public dispose(): void {
    this.cancelRefresh()

    for (const waiter of this.waiters) {
      if (waiter.timeoutHandle !== null) {
        this.clock.clearTimeout(waiter.timeoutHandle)
      }
      waiter.resolve(this._themeMode)
    }

    this.waiters.clear()
  }

  public handleSequence(sequence: string): { handled: boolean; changedMode: ThemeMode | null } {
    if (sequence === "\x1b[?997;1n" || sequence === "\x1b[?997;2n") {
      this.requestThemeOscColors()
      return { handled: true, changedMode: null }
    }

    if (
      DEVICE_ATTRIBUTES_REPLY.test(sequence) &&
      this.themeQueryPending &&
      this.themeOscForeground === null &&
      this.themeOscBackground === null
    ) {
      // DA1 fences the startup query burst the same way the trailing CPRs fence the explicit-width
      // probes: the color queries are written before CSI c and terminals answer in order, so a DA1
      // reply with no colors means they were ignored. Resolve the waiters with the current mode
      // (null), but keep the query pending so a late OSC reply still applies the mode.
      for (const waiter of this.waiters) {
        if (waiter.timeoutHandle !== null) {
          this.clock.clearTimeout(waiter.timeoutHandle)
        }
        waiter.resolve(this._themeMode)
      }
      this.waiters.clear()
    }

    let handledOscThemeResponse = false
    let match: RegExpExecArray | null

    OSC_THEME_RESPONSE.lastIndex = 0
    while ((match = OSC_THEME_RESPONSE.exec(sequence))) {
      handledOscThemeResponse = true
      const color = oscThemeColorToHex(match[2], match[3], match[4], match[5])

      if (match[1] === "10") {
        this.themeOscForeground = color
      } else {
        this.themeOscBackground = color
      }
    }

    if (!handledOscThemeResponse) {
      return { handled: false, changedMode: null }
    }

    if (!this.themeQueryPending) {
      return { handled: true, changedMode: null }
    }

    if (!this.themeOscForeground || !this.themeOscBackground) {
      return { handled: true, changedMode: null }
    }

    const nextMode = inferThemeModeFromBackgroundColor(this.themeOscBackground)
    const changedMode = this.applyThemeMode(nextMode)
    this.completeThemeQuery()

    return { handled: true, changedMode }
  }

  private clearThemeRefreshTimeout(): void {
    if (this.themeRefreshTimeoutId === null) {
      return
    }

    this.clock.clearTimeout(this.themeRefreshTimeoutId)
    this.themeRefreshTimeoutId = null
  }

  private completeThemeQuery(): void {
    this.clearThemeRefreshTimeout()
    this.themeQueryPending = false
  }

  private requestThemeOscColors(): void {
    // Ignore repeated ?997 notifications while the current OSC refresh is
    // still in flight.
    if (this.themeRefreshTimeoutId !== null) {
      return
    }

    this.themeQueryPending = true
    this.themeOscForeground = null
    this.themeOscBackground = null

    this.host.queryThemeColors()

    this.clearThemeRefreshTimeout()
    this.themeRefreshTimeoutId = this.clock.setTimeout(() => {
      this.completeThemeQuery()
    }, RendererThemeMode.QUERY_TIMEOUT_MS)
  }

  private applyThemeMode(mode: ThemeMode): ThemeMode | null {
    const changed = this._themeMode !== mode
    this._themeMode = mode

    if (!changed) {
      return null
    }

    for (const waiter of this.waiters) {
      if (waiter.timeoutHandle !== null) {
        this.clock.clearTimeout(waiter.timeoutHandle)
      }
      waiter.resolve(mode)
    }

    this.waiters.clear()
    return mode
  }
}
