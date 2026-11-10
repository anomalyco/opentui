import { parseColor } from "./lib/RGBA.js"
import { type Clock, type TimerHandle } from "./lib/clock.js"
import type { ThemeMode } from "./types.js"

const OSC_THEME_RESPONSE =
  /\x1b](10|11);(?:(?:rgb:)([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)|#([0-9a-fA-F]{6}))(?:\x07|\x1b\\)/g

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
  /** Returns true when the query ends with a DA1 sentinel; the host then calls `cancelRefresh` at its reply. */
  queryThemeColors(): boolean
}

type ThemeWaiter = {
  resolve: (mode: ThemeMode | null) => void
  timeoutHandle: TimerHandle | null
}

export class RendererThemeMode {
  private static readonly QUERY_TIMEOUT_MS = 250

  private _themeMode: ThemeMode | null = null
  private refreshPending = false
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

  public dispose(): void {
    this.cancelRefresh()
    this.resolveWaiters()
  }

  /** Resolves every wait with the current mode, also when no mode is known. */
  public resolveWaiters(): void {
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

    // A reply is applied whenever it arrives: a late one still reports the terminal's current color. The mode
    // follows the background; the foreground is consumed but unused.
    let handled = false
    let background: string | null = null
    let match: RegExpExecArray | null

    OSC_THEME_RESPONSE.lastIndex = 0
    while ((match = OSC_THEME_RESPONSE.exec(sequence))) {
      handled = true
      if (match[1] === "11") background = oscThemeColorToHex(match[2], match[3], match[4], match[5])
    }

    if (background === null) {
      return { handled, changedMode: null }
    }

    this.cancelRefresh()
    return { handled, changedMode: this.applyThemeMode(inferThemeModeFromBackgroundColor(background)) }
  }

  public cancelRefresh(): void {
    this.refreshPending = false
    if (this.themeRefreshTimeoutId === null) {
      return
    }

    this.clock.clearTimeout(this.themeRefreshTimeoutId)
    this.themeRefreshTimeoutId = null
  }

  private requestThemeOscColors(): void {
    // Ignore repeated ?997 notifications while the current OSC refresh is
    // still in flight.
    if (this.refreshPending) {
      return
    }

    const batched = this.host.queryThemeColors()
    this.refreshPending = true
    // Without a sentinel, a timer ends the refresh.
    if (batched) return

    this.themeRefreshTimeoutId = this.clock.setTimeout(() => {
      this.themeRefreshTimeoutId = null
      this.refreshPending = false
    }, RendererThemeMode.QUERY_TIMEOUT_MS)
  }

  private applyThemeMode(mode: ThemeMode): ThemeMode | null {
    const changed = this._themeMode !== mode
    this._themeMode = mode

    if (!changed) {
      return null
    }

    this.resolveWaiters()
    return mode
  }
}
