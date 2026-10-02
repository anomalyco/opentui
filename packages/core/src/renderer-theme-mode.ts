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
  queryThemeColors(): void
}

type ThemeWaiter = {
  resolve: (mode: ThemeMode | null) => void
  timeoutHandle: TimerHandle | null
}

export class RendererThemeMode {
  private static readonly QUERY_TIMEOUT_MS = 250
  private static readonly FOLLOW_UP_COOLDOWN_MS = 5000
  private static readonly PROVOKED_WINDOW_MS = 1000

  private _themeMode: ThemeMode | null = null
  private themeOscForeground: string | null = null
  private themeOscBackground: string | null = null
  private themeRefreshTimeoutId: TimerHandle | null = null
  private requeryPending = false
  private lastFollowUpQueryAt = Number.NEGATIVE_INFINITY
  private lastQueryActivityAt = Number.NEGATIVE_INFINITY
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
    this.requeryPending = false
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

    // Apply the inferred mode once both foreground and background replies have
    // arrived, even if the 250ms query timeout already fired. A terminal that
    // answers OSC 10/11 slower than QUERY_TIMEOUT_MS — common under WezTerm,
    // where a color-scheme change can take ~1s to settle in the OSC 11 reply —
    // would otherwise have its late answer silently dropped, leaving the mode
    // stuck on the old value. requestThemeOscColors resets fg/bg to null at
    // the start of each query, so stale values from a prior query cannot leak
    // in here.
    //
    // Note this means unsolicited OSC 10/11 replies can mutate the theme mode
    // at any time (fg/bg persist after a completed query). After suspend(),
    // inertness relies on the stdin data listener being detached — not on an
    // internal pending flag.
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
    this.lastQueryActivityAt = this.clock.now()
    this.consumePendingRequery()
  }

  private requestThemeOscColors(): void {
    // A ?997 while a query is in flight must not start another query
    // immediately — under tmux on macOS the OSC 10/11 round-trip itself
    // provokes the next ?997, and querying per notification recreates the
    // feedback loop from #975. Remember it instead (single slot) so the
    // current query can be followed by at most one cooldown-gated re-query.
    if (this.themeRefreshTimeoutId !== null) {
      this.requeryPending = true
      return
    }

    // A ?997 arriving shortly after the previous query's activity while idle
    // is likely provoked by that query's own round-trip (fast-reply variant
    // of #975: the reply completes the query before the provoked ?997
    // lands). Route it through the same cooldown gate instead of treating it
    // as fresh.
    if (this.clock.now() - this.lastQueryActivityAt < RendererThemeMode.PROVOKED_WINDOW_MS) {
      this.requeryPending = true
      this.consumePendingRequery()
      return
    }

    this.beginThemeQuery(false)
  }

  private consumePendingRequery(): void {
    if (!this.requeryPending) {
      return
    }

    this.requeryPending = false

    // At most one follow-up query per cooldown regardless of how many
    // notifications arrived: this is what breaks the self-sustaining
    // query→provoked-?997→re-query cycle of #975 while still honoring one
    // genuine notification that landed mid-flight.
    if (this.clock.now() - this.lastFollowUpQueryAt < RendererThemeMode.FOLLOW_UP_COOLDOWN_MS) {
      return
    }

    this.beginThemeQuery(true)
  }

  private beginThemeQuery(isFollowUp: boolean): void {
    const now = this.clock.now()
    this.lastQueryActivityAt = now
    if (isFollowUp) {
      this.lastFollowUpQueryAt = now
    }

    this.themeOscForeground = null
    this.themeOscBackground = null
    this.requeryPending = false

    this.host.queryThemeColors()

    this.themeRefreshTimeoutId = this.clock.setTimeout(() => {
      this.clearThemeRefreshTimeout()
      this.lastQueryActivityAt = this.clock.now()
      this.consumePendingRequery()
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
