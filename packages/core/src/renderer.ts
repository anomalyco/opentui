import { ANSI } from "./ansi.js"
import { Renderable, RootRenderable } from "./Renderable.js"
import { BoxRenderable } from "./renderables/Box.js"
import { CodeRenderable } from "./renderables/Code.js"
import { TextRenderable } from "./renderables/Text.js"
import {
  DebugOverlayCorner,
  type CursorStyleOptions,
  type MousePointerStyle,
  type RenderContext,
  type TerminalCapabilities,
  type ThemeMode,
  type ViewportBounds,
  type WidthMethod,
} from "./types.js"
import { RGBA, parseColor, type ColorInput } from "./lib/RGBA.js"
import { sleep } from "./platform/runtime.js"
import { OptimizedBuffer } from "./buffer.js"
import {
  resolveRenderLib,
  type NativeBufferedOutput,
  type NativeRenderStats,
  type RenderLib,
  type RendererHandle,
} from "./zig.js"
import { NativeSpanFeed } from "./NativeSpanFeed.js"
import { TerminalConsole, type ConsoleOptions, capture } from "./console.js"
import { type MouseEventType, type RawMouseEvent, type ScrollInfo } from "./lib/parse.mouse.js"
import { Selection } from "./lib/selection.js"
import { Clipboard, type ClipboardTarget } from "./lib/clipboard.js"
import { EventEmitter } from "events"
import { singleton } from "./lib/singleton.js"
import { getObjectsInViewport } from "./lib/objects-in-viewport.js"
import { KeyHandler, InternalKeyHandler } from "./lib/KeyHandler.js"
import { isEditBufferRenderable, type EditBufferRenderable } from "./renderables/EditBufferRenderable.js"
import { env, registerEnvVar } from "./lib/env.js"
import { destroyTreeSitterClient } from "./lib/tree-sitter/index.js"
import {
  buildTerminalPaletteSignature,
  createTerminalPalette,
  normalizeTerminalPalette,
  type TerminalPaletteDetector,
  type TerminalColors,
  type GetPaletteOptions,
} from "./lib/terminal-palette.js"
import { calculateRenderGeometry } from "./lib/render-geometry.js"
import {
  isCapabilityResponse,
  isPixelResolutionResponse,
  parsePixelResolution,
} from "./lib/terminal-capability-detection.js"
import { type Clock, type TimerHandle, SystemClock } from "./lib/clock.js"
import { StdinParser, type StdinEvent, type StdinParserProtocolContext } from "./lib/stdin-parser.js"
import { matchesKeyBinding } from "./lib/keybinding.internal.js"
import { RendererThemeMode } from "./renderer-theme-mode.js"

registerEnvVar({
  name: "OTUI_DUMP_CAPTURES",
  description: "Dump captured stdout and console caches when the renderer exit handler runs.",
  type: "boolean",
  default: false,
})

registerEnvVar({
  name: "OTUI_NO_NATIVE_RENDER",
  description:
    "Skip the Zig/native frame renderer. Useful for debugging the render loop; split-footer stdout flushing may still write ANSI.",
  type: "boolean",
  default: false,
})

registerEnvVar({
  name: "OTUI_USE_ALTERNATE_SCREEN",
  description: "When explicitly set, force screen mode selection: true=alternate-screen, false=main-screen.",
  type: "boolean",
  default: true,
})

registerEnvVar({
  name: "OTUI_OVERRIDE_STDOUT",
  description: "When explicitly set, force stdout routing: false=passthrough, true=capture in split-footer mode.",
  type: "boolean",
  default: true,
})

registerEnvVar({
  name: "OTUI_DEBUG",
  description: "Enable debug mode to capture all raw input for debugging purposes.",
  type: "boolean",
  default: false,
})

registerEnvVar({
  name: "OTUI_SHOW_STATS",
  description: "Show the debug overlay at startup.",
  type: "boolean",
  default: false,
})

export interface CliRendererConfig {
  // Read input from this stream. Defaults to process.stdin. Any `Readable`
  // works; capabilities like `setRawMode` are duck-typed and used when present.
  stdin?: NodeJS.ReadStream

  // Destination for rendered output. Defaults to process.stdout. When this is
  // not `process.stdout`, the renderer internally wires a `NativeSpanFeed`
  // between Zig and the provided `Writable` so frames flow there instead of
  // the host terminal. TTY capabilities like `columns`/`rows` are duck-typed.
  stdout?: NodeJS.WriteStream

  // Fallback terminal width when `stdout.columns` is not available. Useful
  // when running against a non-TTY `Writable` (e.g. an SSH channel) where
  // initial dimensions come from elsewhere. Default 80.
  width?: number

  // Fallback terminal height when `stdout.rows` is not available. Default 24.
  height?: number

  // Tell the native renderer it is driving a remote terminal. When omitted,
  // native startup auto-detects SSH/mosh sessions; custom stdout feed output
  // defaults to remote because it is not connected to the host TTY directly.
  remote?: boolean

  // Use an in-memory native buffered output destination instead of process stdout.
  // Intended for test helpers that need native rendering without terminal I/O.
  bufferedOutput?: NativeBufferedOutput

  // Call renderer.destroy() when Ctrl+C is pressed. Defaults to true.
  exitOnCtrlC?: boolean

  // Clean up on these signals. Defaults to the common termination signals.
  exitSignals?: NodeJS.Signals[]

  // Clear owned screen regions on suspend/destroy. Defaults to true.
  clearOnShutdown?: boolean

  // Forward these env var names to native terminal detection.
  forwardEnvKeys?: string[]

  // Wait this long before handling resize events. Defaults to 100 ms.
  debounceDelay?: number

  // Aim for this many frames per second in continuous mode. Defaults to 30.
  targetFps?: number

  // Cap immediate re-renders at this frame rate. Defaults to 60.
  maxFps?: number

  // Emit memory snapshots on this interval in ms. Set 0 to disable.
  memorySnapshotInterval?: number

  // Render from a separate thread when the platform supports it.
  useThread?: boolean

  // Collect frame timing stats for the debug overlay.
  gatherStats?: boolean

  // Keep this many timing samples. Defaults to 300.
  maxStatSamples?: number

  // Pass options to the built-in console overlay.
  consoleOptions?: Omit<ConsoleOptions, "clock">

  // Run these hooks after each render pass.
  postProcessFns?: ((buffer: OptimizedBuffer, deltaTime: number) => void)[]

  // Track mouse move events. Defaults to true.
  enableMouseMovement?: boolean

  // Enable mouse input. Defaults to true.
  useMouse?: boolean

  // Focus the nearest focusable renderable on left click. Defaults to true.
  autoFocus?: boolean

  // Choose where the renderer owns terminal space. Defaults to "alternate-screen".
  screenMode?: ScreenMode

  // Set the requested footer height for "split-footer". Defaults to 12.
  footerHeight?: number

  // Choose what happens to writes that go through `stdout.write`.
  externalOutputMode?: ExternalOutputMode

  // Choose what the built-in console overlay does.
  consoleMode?: ConsoleMode

  // Set Kitty keyboard protocol flags, or null to disable them.
  useKittyKeyboard?: KittyKeyboardOptions | null

  // Fill the render buffer with this background color. Default transparent.
  backgroundColor?: ColorInput

  // Open the console overlay on uncaught errors. Defaults to true in development.
  openConsoleOnError?: boolean

  // Run these input handlers before the built-in handlers.
  prependInputHandlers?: ((sequence: string) => boolean)[]

  // Cap the stdin parser buffer size in bytes. Defaults to 64 MB.
  stdinParserMaxBufferBytes?: number

  // Use a custom clock for timers and tests.
  clock?: Clock

  // Run after destroy() finishes cleanup.
  onDestroy?: () => void
}

// Controls how the renderer uses terminal space:
//
// - "alternate-screen": Use the terminal's alternate screen buffer.
//
// - "main-screen": Render on the main screen.
//
// - "split-footer": Keep the renderer in a reserved footer on the main screen.
export type ScreenMode = "alternate-screen" | "main-screen" | "split-footer"

// Controls writes that go through the configured `stdout.write`.
//
// - "capture-stdout": Queue stdout and replay it above the split footer.
//   Only valid with "split-footer".
//
// - "passthrough": Leave stdout alone.
export type ExternalOutputMode = "capture-stdout" | "passthrough"

export interface CliRendererExternalOutputEvent {
  snapshot: OptimizedBuffer
  rowColumns: number
  startOnNewLine: boolean
  trailingNewline: boolean
}

// Controls the built-in console overlay:
//
// - "console-overlay": Capture `console.*` output and show the overlay.
//
// - "disabled": Hide the overlay. `OTUI_USE_CONSOLE` controls global console
//   capture.
export type ConsoleMode = "console-overlay" | "disabled"

export type PixelResolution = {
  width: number
  height: number
}

export interface CliRendererStats extends NativeRenderStats {
  fps: number
  frameCount: number
  frameTimes: number[]
  averageFrameTime: number
  minFrameTime: number
  maxFrameTime: number
  frameCallbackTime: number
}

export interface CliRendererFrameEvent {
  frameId: number
}

export interface RendererSchedulerState {
  isRunning: boolean
  isRendering: boolean
  hasScheduledRender: boolean
}

export interface ScrollbackRenderContext {
  width: number
  widthMethod: WidthMethod
  tailColumn: number
  renderContext: RenderContext
}

export interface ScrollbackSnapshot {
  root: Renderable
  width?: number
  height?: number
  rowColumns?: number
  startOnNewLine?: boolean
  trailingNewline?: boolean
  teardown?: () => void
}

export type ScrollbackWriter = (ctx: ScrollbackRenderContext) => ScrollbackSnapshot

export interface ScrollbackSurfaceOptions {
  startOnNewLine?: boolean
}

export interface ScrollbackSurfaceCommitOptions {
  rowColumns?: number
  trailingNewline?: boolean
}

export interface ScrollbackSurface {
  readonly renderContext: RenderContext
  readonly root: Renderable
  readonly width: number
  readonly height: number
  readonly isDestroyed: boolean

  render(): void
  settle(timeoutMs?: number): Promise<void>
  commitRows(startRow: number, endRowExclusive: number, options?: ScrollbackSurfaceCommitOptions): void
  destroy(): void
}

export interface SplitFooterReplayResetOptions {
  clearSavedLines?: boolean
}

const DEFAULT_FOOTER_HEIGHT = 12
const MAX_SCROLLBACK_SURFACE_HEIGHT_PASSES = 4
const TRANSPARENT_RGBA = RGBA.fromValues(0, 0, 0, 0)

let scrollbackSurfaceCounter = 0

function normalizeFooterHeight(footerHeight: number | undefined): number {
  if (footerHeight === undefined) {
    return DEFAULT_FOOTER_HEIGHT
  }

  if (!Number.isFinite(footerHeight)) {
    throw new Error("footerHeight must be a finite number")
  }

  const normalizedFooterHeight = Math.trunc(footerHeight)
  if (normalizedFooterHeight <= 0) {
    throw new Error("footerHeight must be greater than 0")
  }

  return normalizedFooterHeight
}

function resolveModes(config: CliRendererConfig): {
  screenMode: ScreenMode
  footerHeight: number
  externalOutputMode: ExternalOutputMode
} {
  let screenMode = config.screenMode ?? "alternate-screen"
  if (process.env.OTUI_USE_ALTERNATE_SCREEN !== undefined) {
    screenMode = env.OTUI_USE_ALTERNATE_SCREEN ? "alternate-screen" : "main-screen"
  }

  const footerHeight =
    screenMode === "split-footer" ? normalizeFooterHeight(config.footerHeight) : DEFAULT_FOOTER_HEIGHT

  let externalOutputMode =
    config.externalOutputMode ?? (screenMode === "split-footer" ? "capture-stdout" : "passthrough")
  if (process.env.OTUI_OVERRIDE_STDOUT !== undefined) {
    externalOutputMode = env.OTUI_OVERRIDE_STDOUT && screenMode === "split-footer" ? "capture-stdout" : "passthrough"
  }

  if (externalOutputMode === "capture-stdout" && screenMode !== "split-footer") {
    throw new Error('externalOutputMode "capture-stdout" requires screenMode "split-footer"')
  }

  return {
    screenMode,
    footerHeight,
    externalOutputMode,
  }
}

type ExternalOutputCommit = {
  snapshot: OptimizedBuffer
  rowColumns: number
  startOnNewLine: boolean
  trailingNewline: boolean
}

type PendingSplitFooterTransition = {
  mode: "viewport-scroll" | "clear-stale-rows"
  sourceTopLine: number
  sourceHeight: number
  targetTopLine: number
  targetHeight: number
  scrollLines?: number
}

class ExternalOutputQueue {
  private commits: ExternalOutputCommit[] = []

  get size(): number {
    return this.commits.length
  }

  writeSnapshot(commit: ExternalOutputCommit): void {
    this.commits.push(commit)
  }

  peek(limit: number = Number.POSITIVE_INFINITY): readonly ExternalOutputCommit[] {
    const clampedLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : this.commits.length
    return this.commits.slice(0, clampedLimit)
  }

  claim(limit: number = Number.POSITIVE_INFINITY): ExternalOutputCommit[] {
    if (this.commits.length === 0) {
      return []
    }

    // Split-footer capture can enqueue many tiny commits in a burst (for example,
    // simulated Ctrl+R hold). Taking everything at once creates very large native
    // frames that increase visible churn. We keep claim() bounded so one render tick
    // produces one modest frame and schedules another tick if work remains.
    const clampedLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : this.commits.length
    if (clampedLimit >= this.commits.length) {
      const output = this.commits
      this.commits = []
      return output
    }

    const output = this.commits.slice(0, clampedLimit)
    this.commits = this.commits.slice(clampedLimit)
    return output
  }

  drop(count: number): void {
    for (const commit of this.commits.splice(0, count)) {
      commit.snapshot.destroy()
    }
  }

  clear(): void {
    this.drop(this.commits.length)
  }
}

const CHAR_FLAG_CONTINUATION = 0xc0000000 >>> 0
const CHAR_FLAG_MASK = 0xc0000000 >>> 0

class ScrollbackSnapshotRenderContext extends EventEmitter implements RenderContext {
  public width: number
  public height: number
  public frameId = 0
  public widthMethod: WidthMethod
  public capabilities: TerminalCapabilities | null = null
  public hasSelection: boolean = false
  public currentFocusedRenderable: Renderable | null = null
  public keyInput: KeyHandler
  public _internalKeyInput: InternalKeyHandler

  private lifecyclePasses: Set<Renderable> = new Set()

  constructor(width: number, height: number, widthMethod: WidthMethod) {
    super()
    this.width = width
    this.height = height
    this.widthMethod = widthMethod
    this.keyInput = new KeyHandler()
    this._internalKeyInput = new InternalKeyHandler()
  }

  public addToHitGrid(_x: number, _y: number, _width: number, _height: number, _id: number): void {}
  public pushHitGridScissorRect(_x: number, _y: number, _width: number, _height: number): void {}
  public popHitGridScissorRect(): void {}
  public clearHitGridScissorRects(): void {}
  public requestRender(): void {}
  public setCursorPosition(_x: number, _y: number, _visible: boolean): void {}
  public setCursorStyle(_options: CursorStyleOptions): void {}
  public setCursorColor(_color: RGBA): void {}
  public setMousePointer(_shape: MousePointerStyle): void {}
  public requestLive(): void {}
  public dropLive(): void {}
  public getSelection(): Selection | null {
    return null
  }
  public get currentFocusedEditor(): EditBufferRenderable | null {
    if (!this.currentFocusedRenderable) return null
    if (!isEditBufferRenderable(this.currentFocusedRenderable)) return null
    return this.currentFocusedRenderable
  }
  public requestSelectionUpdate(): void {}
  public focusRenderable(renderable: Renderable): void {
    this.currentFocusedRenderable = renderable
  }
  public blurRenderable(renderable: Renderable): void {
    if (this.currentFocusedRenderable === renderable) {
      this.currentFocusedRenderable = null
    }
  }
  public registerLifecyclePass(renderable: Renderable): void {
    this.lifecyclePasses.add(renderable)
  }
  public unregisterLifecyclePass(renderable: Renderable): void {
    this.lifecyclePasses.delete(renderable)
  }
  public getLifecyclePasses(): Set<Renderable> {
    return this.lifecyclePasses
  }
  public clearSelection(): void {}
  public startSelection(_renderable: Renderable, _x: number, _y: number): void {}
  public updateSelection(
    _currentRenderable: Renderable | undefined,
    _x: number,
    _y: number,
    _options?: { finishDragging?: boolean },
  ): void {}
}

const DEFAULT_FORWARDED_ENV_KEYS = [
  "TMUX",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  "TERM",
  "OPENTUI_GRAPHICS",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_FEATURES",
  "ALACRITTY_SOCKET",
  "ALACRITTY_LOG",
  "COLORTERM",
  "TERMUX_VERSION",
  "VHS_RECORD",
  "OPENTUI_FORCE_WCWIDTH",
  "OPENTUI_FORCE_UNICODE",
  "OPENTUI_FORCE_NOZWJ",
  "OPENTUI_FORCE_EXPLICIT_WIDTH",
  "OPENTUI_NOTIFICATION_PROTOCOL",
  "OPENTUI_NOTIFICATIONS",
  "WT_SESSION",
  "STY",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
] as const

const NATIVE_RENDER_STATUS_SKIPPED = 1
const NATIVE_RENDER_STATUS_FAILED = 2

// Kitty keyboard protocol flags
// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
const KITTY_FLAG_DISAMBIGUATE = 0b1 // Report disambiguated escape codes
const KITTY_FLAG_EVENT_TYPES = 0b10 // Report event types (press/repeat/release)
const KITTY_FLAG_ALTERNATE_KEYS = 0b100 // Report alternate keys (e.g., numpad vs regular)
const KITTY_FLAG_ALL_KEYS_AS_ESCAPES = 0b1000 // Report all keys as escape codes
const KITTY_FLAG_REPORT_TEXT = 0b10000 // Report text associated with key events

const DEFAULT_STDIN_PARSER_MAX_BUFFER_BYTES = 64 * 1024 * 1024
const NATIVE_PALETTE_QUERY_SIZE = 16

/**
 * Kitty Keyboard Protocol configuration options
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/#progressive-enhancement
 */
export interface KittyKeyboardOptions {
  /** Disambiguate escape codes (fixes ESC timing, alt+key ambiguity, ctrl+c as event). Default: true */
  disambiguate?: boolean
  /** Report alternate keys (numpad, shifted, base layout) for cross-keyboard shortcuts. Default: true */
  alternateKeys?: boolean
  /** Report event types (press/repeat/release). Default: false */
  events?: boolean
  /** Report all keys as escape codes. Default: false */
  allKeysAsEscapes?: boolean
  /** Report text associated with key events. Default: false */
  reportText?: boolean
}

/**
 * Build kitty keyboard protocol flags based on configuration
 * @param config Kitty keyboard configuration object (null/undefined = disabled)
 * @returns The combined flags value (0 = disabled, >0 = enabled)
 * @internal Exported for testing
 */
export function buildKittyKeyboardFlags(config: KittyKeyboardOptions | null | undefined): number {
  if (!config) {
    return 0
  }

  let flags = 0

  // Default: disambiguate + alternate keys (both default to true)
  // - Disambiguate (0b1): Fixes ESC timing issues, alt+key ambiguity, makes ctrl+c a key event
  // - Alternate keys (0b100): Reports shifted/base-layout keys for cross-keyboard shortcuts

  // disambiguate defaults to true unless explicitly set to false
  if (config.disambiguate !== false) {
    flags |= KITTY_FLAG_DISAMBIGUATE
  }

  // alternateKeys defaults to true unless explicitly set to false
  if (config.alternateKeys !== false) {
    flags |= KITTY_FLAG_ALTERNATE_KEYS
  }

  // Optional flags (default to false, only enabled when explicitly true)
  if (config.events === true) {
    flags |= KITTY_FLAG_EVENT_TYPES
  }

  if (config.allKeysAsEscapes === true) {
    flags |= KITTY_FLAG_ALL_KEYS_AS_ESCAPES
  }

  if (config.reportText === true) {
    flags |= KITTY_FLAG_REPORT_TEXT
  }

  return flags
}

export class MouseEvent {
  public readonly type: MouseEventType
  public readonly button: number
  public readonly x: number
  public readonly y: number
  public readonly source?: Renderable
  public readonly modifiers: {
    shift: boolean
    alt: boolean
    ctrl: boolean
  }
  public readonly scroll?: ScrollInfo
  public readonly target: Renderable | null
  public readonly isDragging?: boolean
  private _propagationStopped: boolean = false
  private _defaultPrevented: boolean = false

  public get propagationStopped(): boolean {
    return this._propagationStopped
  }

  public get defaultPrevented(): boolean {
    return this._defaultPrevented
  }

  constructor(target: Renderable | null, attributes: RawMouseEvent & { source?: Renderable; isDragging?: boolean }) {
    this.target = target
    this.type = attributes.type
    this.button = attributes.button
    this.x = attributes.x
    this.y = attributes.y
    this.modifiers = attributes.modifiers
    this.scroll = attributes.scroll
    this.source = attributes.source
    this.isDragging = attributes.isDragging
  }

  public stopPropagation(): void {
    this._propagationStopped = true
  }

  public preventDefault(): void {
    this._defaultPrevented = true
  }
}

export enum MouseButton {
  LEFT = 0,
  MIDDLE = 1,
  RIGHT = 2,
  WHEEL_UP = 4,
  WHEEL_DOWN = 5,
}

const rendererTracker = singleton("RendererTracker", () => ({
  renderers: new Set<CliRenderer>(),
  streamOwners: new WeakMap<object, CliRenderer>(),
}))

/**
 * Create a CLI renderer and run its async terminal setup. The constructor
 * owns all stream and backend decisions; this factory only layers on the
 * `--delay-start` flag and the `await setupTerminal()` convenience.
 */
export async function createCliRenderer(config: CliRendererConfig = {}): Promise<CliRenderer> {
  if (process.argv.includes("--delay-start")) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  const stdin = config.stdin ?? process.stdin
  const stdout = config.stdout ?? process.stdout

  // Prefer real TTY dimensions, then explicit config fallbacks, then defaults.
  // `||` (not `??`) preserves the historical falsy-fallback semantics where
  // `stdout.columns === 0` falls through rather than being treated as valid.
  const width = stdout.columns || config.width || 80
  const height = stdout.rows || config.height || 24

  const renderer = new CliRenderer(stdin, stdout, width, height, config)
  try {
    await renderer.setupTerminal()
    return renderer
  } catch (error) {
    try {
      renderer.destroy()
    } catch (destroyError) {
      console.error("Error destroying partially-set-up renderer:", destroyError)
    }
    throw error
  }
}

export enum CliRenderEvents {
  RESIZE = "resize",
  FRAME = "frame",
  EXTERNAL_OUTPUT = "external_output",
  FOCUS = "focus",
  BLUR = "blur",
  FOCUSED_RENDERABLE = "focused_renderable",
  FOCUSED_EDITOR = "focused_editor",
  THEME_MODE = "theme_mode",
  PALETTE = "palette",
  CAPABILITIES = "capabilities",
  SELECTION = "selection",
  DEBUG_OVERLAY_TOGGLE = "debugOverlay:toggle",
  DESTROY = "destroy",
  MEMORY_SNAPSHOT = "memory:snapshot",
}

export enum RendererControlState {
  IDLE = "idle",
  AUTO_STARTED = "auto_started",
  EXPLICIT_STARTED = "explicit_started",
  EXPLICIT_PAUSED = "explicit_paused",
  EXPLICIT_SUSPENDED = "explicit_suspended",
  EXPLICIT_STOPPED = "explicit_stopped",
}

export class CliRenderer extends EventEmitter implements RenderContext {
  private static animationFrameId = 0
  private lib: RenderLib
  public rendererPtr: RendererHandle
  public stdin: NodeJS.ReadStream
  private stdout: NodeJS.WriteStream
  private exitOnCtrlC: boolean
  private exitSignals: NodeJS.Signals[]
  private _exitListenersAdded: boolean = false
  private _isDestroyed: boolean = false
  private _destroyPending: boolean = false
  private _destroyFinalized: boolean = false
  private _destroyCleanupPrepared: boolean = false
  private _streamLeaseAcquired: boolean = false
  public nextRenderBuffer: OptimizedBuffer
  public currentRenderBuffer: OptimizedBuffer
  private _isRunning: boolean = false
  private _targetFps: number = 30
  private _maxFps: number = 60
  private automaticMemorySnapshot: boolean = false
  private memorySnapshotInterval: number
  private memorySnapshotTimer: TimerHandle | null = null
  private lastMemorySnapshot: {
    heapUsed: number
    heapTotal: number
    arrayBuffers: number
  } = {
    heapUsed: 0,
    heapTotal: 0,
    arrayBuffers: 0,
  }
  public readonly root: RootRenderable
  public width: number
  public height: number
  private _useThread: boolean = false
  private gatherStats: boolean = false
  private frameTimes: number[] = []
  private maxStatSamples: number = 300
  private postProcessFns: ((buffer: OptimizedBuffer, deltaTime: number) => void)[] = []
  private backgroundColor: RGBA = RGBA.fromInts(0, 0, 0, 0)
  private waitingForPixelResolution: boolean = false
  private readonly clock: Clock

  private rendering: boolean = false
  private renderingNative: boolean = false
  private renderTimeout: TimerHandle | null = null
  private lastTime: number = 0
  private frameCount: number = 0
  // Bumped once per loop() iteration; see RenderContext.frameId.
  private _frameId: number = 0
  private lastFpsTime: number = 0
  private currentFps: number = 0
  private targetFrameTime: number = 1000 / this._targetFps
  private minTargetFrameTime: number = 1000 / this._maxFps
  private immediateRerenderRequested: boolean = false
  private updateScheduled: boolean = false

  private liveRequestCounter: number = 0
  private _controlState: RendererControlState = RendererControlState.IDLE

  private frameCallbacks: ((deltaTime: number) => Promise<void>)[] = []
  private renderStats: {
    frameCount: number
    fps: number
    renderTime?: number
    frameCallbackTime: number
  } = {
    frameCount: 0,
    fps: 0,
    renderTime: 0,
    frameCallbackTime: 0,
  }
  public debugOverlay = {
    enabled: env.OTUI_SHOW_STATS,
    corner: DebugOverlayCorner.bottomRight,
  }

  private _console: TerminalConsole
  private _resolution: PixelResolution | null = null
  private _keyHandler: InternalKeyHandler
  private stdinParser: StdinParser | null = null
  private readonly oscSubscribers = new Set<(sequence: string) => void>()
  private hasLoggedStdinParserError = false

  private animationRequest: Map<number, FrameRequestCallback> = new Map()

  private resizeTimeoutId: TimerHandle | null = null
  private capabilityTimeoutId: TimerHandle | null = null
  private xtVersionWaiters = new Set<() => void>()
  private splitStartupSeedTimeoutId: TimerHandle | null = null
  private pendingSplitStartupCursorSeed: boolean = false
  private resizeDebounceDelay: number = 100

  private enableMouseMovement: boolean = false
  private _useMouse: boolean = true
  private autoFocus: boolean = true
  private _screenMode: ScreenMode = "alternate-screen"
  private _footerHeight: number = DEFAULT_FOOTER_HEIGHT
  private _externalOutputMode: ExternalOutputMode = "passthrough"
  private clearOnShutdown: boolean = true
  private _suspendedMouseEnabled: boolean = false
  private _previousControlState: RendererControlState = RendererControlState.IDLE
  private pendingSuspendedTerminalSetup: boolean = false
  private suspendedNonAltSurfacePreserved: boolean = false
  private capturedRenderable?: Renderable
  private lastOverRenderableNum: number = 0
  private lastOverRenderable?: Renderable

  private currentSelection: Selection | null = null
  private selectionContainers: Renderable[] = []
  private clipboard: Clipboard

  private _splitHeight: number = 0
  private renderOffset: number = 0
  private splitTailColumn: number = 0
  private pendingSplitFooterTransition: PendingSplitFooterTransition | null = null
  // One-shot latch used to request a full split repaint after transitions
  // (resize/mode/output-path changes). Cleared on first renderNative tick.
  private forceFullRepaintRequested: boolean = false
  // Upper bound for captured stdout commits consumed per native frame.
  // This is a visual smoothness control: smaller batches reduce frame envelope
  // churn and keep render latency predictable under heavy scrollback append load.
  private readonly maxSplitCommitsPerFrame: number = 8

  private _terminalWidth: number = 0
  private _terminalHeight: number = 0
  private _terminalIsSetup: boolean = false

  private externalOutputQueue = new ExternalOutputQueue()
  private pendingExternalOutputMode: ExternalOutputMode | null = null
  private realStdoutWrite: (chunk: any, encoding?: any, callback?: any) => boolean

  private _useConsole: boolean = true
  private sigwinchHandler: () => void = (() => {
    const width = this.stdout.columns || 80
    const height = this.stdout.rows || 24
    this.handleResize(width, height)
  }).bind(this)
  private _capabilities: TerminalCapabilities | null = null
  private _latestPointer: { x: number; y: number } = { x: 0, y: 0 }
  private _hasPointer: boolean = false
  private _lastPointerModifiers: RawMouseEvent["modifiers"] = {
    shift: false,
    alt: false,
    ctrl: false,
  }
  private _currentMousePointerStyle: MousePointerStyle | undefined = undefined

  private _currentFocusedRenderable: Renderable | null = null
  private lifecyclePasses: Set<Renderable> = new Set()
  private _openConsoleOnError: boolean = true
  private _paletteDetector: TerminalPaletteDetector | null = null
  private _paletteCache = new Map<number, TerminalColors>()
  private _paletteDetectionPromise: Promise<TerminalColors> | null = null
  private _paletteDetectionSize = 0
  private _paletteEpoch = 0
  private _nativePaletteSignature: string | null = null
  private _emittedPaletteSignature: string | null = null
  private _palettePublishGeneration = 0
  private _onDestroy?: () => void
  private themeModeState: RendererThemeMode
  private _terminalFocusState: boolean | null = null

  private sequenceHandlers: ((sequence: string) => boolean)[] = []
  private prependedInputHandlers: ((sequence: string) => boolean)[] = []
  private shouldRestoreModesOnNextFocus: boolean = false
  private themeModeHandler!: (sequence: string) => boolean

  private idleResolvers: (() => void)[] = []

  private _debugInputs: Array<{ timestamp: string; sequence: string }> = []
  private _debugModeEnabled: boolean = env.OTUI_DEBUG

  private handleError: (error: Error) => void = ((error: Error) => {
    console.error(error)

    if (this._openConsoleOnError) {
      this.console.show()
    }
  }).bind(this)

  private dumpOutputCache(optionalMessage: string = ""): void {
    const cachedLogs = this.console.getCachedLogs()
    const capturedConsoleOutput = capture.claimOutput()
    const capturedExternalOutputCommits = this.externalOutputQueue.claim()

    let capturedExternalOutput = ""
    for (const commit of capturedExternalOutputCommits) {
      capturedExternalOutput += `[snapshot ${commit.snapshot.width}x${commit.snapshot.height}]\n`
      commit.snapshot.destroy()
    }

    if (capturedConsoleOutput.length > 0 || capturedExternalOutput.length > 0 || cachedLogs.length > 0) {
      this.realStdoutWrite.call(this.stdout, optionalMessage)
    }

    if (cachedLogs.length > 0) {
      this.realStdoutWrite.call(this.stdout, "Console cache:\n")
      this.realStdoutWrite.call(this.stdout, cachedLogs)
    }

    if (capturedConsoleOutput.length > 0) {
      this.realStdoutWrite.call(this.stdout, "\nCaptured console output:\n")
      this.realStdoutWrite.call(this.stdout, capturedConsoleOutput + "\n")
    }

    if (capturedExternalOutput.length > 0) {
      this.realStdoutWrite.call(this.stdout, "\nCaptured external output:\n")
      this.realStdoutWrite.call(this.stdout, capturedExternalOutput + "\n")
    }

    this.realStdoutWrite.call(this.stdout, ANSI.reset)
  }

  private exitHandler: () => void = (() => {
    this.destroy()
    if (env.OTUI_DUMP_CAPTURES) {
      sleep(100).then(() => {
        this.dumpOutputCache("=== CAPTURED OUTPUT ===\n")
      })
    }
  }).bind(this)

  private warningHandler: (warning: any) => void = ((warning: any) => {
    console.warn(JSON.stringify(warning.message, null, 2))
  }).bind(this)

  // Stream identity flag. Used only for SIGWINCH gating (terminal-driven
  // resize only fires for process.stdout). Other per-stream behavior uses
  // identity checks inline (e.g. rendererTracker compares `stdin` directly)
  // or duck-typed capability checks (e.g. `stdin.setRawMode?.()`).
  private readonly _usesProcessStdout: boolean

  // Feed wiring. Non-null when the given stdout is not process.stdout and native
  // output is not explicitly redirected to a buffered memory destination.
  private _feed: NativeSpanFeed | null = null
  private _detachFeed: (() => void) | null = null
  private _detachFeedError: (() => void) | null = null
  private feedIdleRenderScheduled = false
  private ordinaryFrameWaitingForFeed = false
  private ordinaryFrameWaitControlState: RendererControlState | null = null

  public get controlState(): RendererControlState {
    return this._controlState
  }

  /**
   * Construct a renderer over the given streams.
   *
   * If `stdout` is not `process.stdout`, a `NativeSpanFeed` is allocated
   * internally and rendered bytes are piped through it to `stdout` unless
   * `bufferedOutput: "memory"` is set. Prefer `createCliRenderer` for the async
   * `setupTerminal` convenience.
   *
   * Construction side effects (observable before the constructor returns):
   *   - Acquires exclusive ownership of the given stdin/stdout streams
   *   - Allocates a `NativeSpanFeed` (for non-process stdout unless bufferedOutput is "memory")
   *   - Calls `lib.createRenderer` → native Zig allocation
   *   - Registers in the process-wide `rendererTracker`
   *   - Adds `process.on(...)` listeners for SIGWINCH (process.stdout only),
   *     "warning", "uncaughtException", "unhandledRejection", "beforeExit",
   *     plus the configured `exitSignals`
   *   - Replaces `global.requestAnimationFrame` with the renderer's impl
   *   - When `setupTerminal()` is called, it will put `stdin` in raw mode and
   *     call `stdin.resume()`
   *
   * Some late constructor side effects are not rolled back if construction
   * throws partway; production callers should use `createCliRenderer`, which
   * wraps `setupTerminal()` in a try/catch that calls `destroy()` on failure.
   */
  constructor(
    stdin: NodeJS.ReadStream,
    stdout: NodeJS.WriteStream,
    width: number,
    height: number,
    config: CliRendererConfig = {},
  ) {
    super()

    this.stdin = stdin
    this.stdout = stdout
    this._usesProcessStdout = stdout === process.stdout
    this.realStdoutWrite = stdout.write

    const lib = resolveRenderLib()
    const useMemoryBufferedOutput = config.bufferedOutput === "memory"
    const useFeedOutput = !this._usesProcessStdout && !useMemoryBufferedOutput
    const { screenMode, footerHeight, externalOutputMode } = resolveModes(config)
    const initialGeometry = calculateRenderGeometry(screenMode, width, height, footerHeight)
    const remoteMode = config.remote ?? (useFeedOutput ? true : undefined)

    if (rendererTracker.streamOwners.get(stdin)) {
      throw new Error("Cannot create CliRenderer: stdin is already used by another CliRenderer")
    }
    if (rendererTracker.streamOwners.get(stdout)) {
      throw new Error("Cannot create CliRenderer: stdout is already used by another CliRenderer")
    }

    // Feed allocation: only when the output target is a non-process Writable.
    // Tests use custom Writable instances too; those should exercise the same
    // output transport as production custom stdout.
    let feed: NativeSpanFeed | null = null
    if (useFeedOutput) {
      try {
        feed = NativeSpanFeed.create()
      } catch (error) {
        throw new Error(
          `Failed to allocate NativeSpanFeed for custom stdout: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    // Native renderer creation. Custom writable feed output defaults to remote
    // so Zig skips local-TTY capability-query timing assumptions; process
    // stdout and memory output preserve native auto detection.
    //
    let rendererPtr: RendererHandle | null
    try {
      rendererPtr = lib.createRenderer(initialGeometry.renderWidth, initialGeometry.renderHeight, {
        remote: remoteMode,
        feedPtr: feed?.streamPtr ?? null,
        bufferedOutput: config.bufferedOutput,
      })
    } catch (error) {
      feed?.close()
      throw error
    }
    if (!rendererPtr) {
      feed?.close()
      throw new Error("Failed to create renderer")
    }

    // Threading defaults (on everywhere except linux, where it currently
    // crashes — likely a missing build dep).
    if (config.useThread === undefined) config.useThread = true
    if (process.platform === "linux") config.useThread = false
    lib.setUseThread(rendererPtr, config.useThread)

    const kittyConfig = config.useKittyKeyboard ?? {}
    const kittyFlags = buildKittyKeyboardFlags(kittyConfig)
    lib.setKittyKeyboardFlags(rendererPtr, kittyFlags)

    // Wire feed → Writable piping. The returned Promise keeps the chunk
    // pinned (refcount held) until Node's write callback fires; this turns
    // Node's Writable flow control into async backpressure for the feed.
    // Write errors are surfaced via feed.onError / console.error; we do not
    // interfere with the Writable's own error handling (matches the
    // pre-feed-integration posture where process.stdout EPIPE was the OS's
    // problem, not the renderer's).
    this._feed = feed
    if (feed) {
      this._detachFeed = feed.onData((bytes: Uint8Array) => {
        return new Promise<void>((resolve) => {
          // Renderer-owned frame bytes must bypass any later stdout.write
          // interception (e.g. split-footer capture) and go straight to the
          // caller's actual sink.
          this.realStdoutWrite.call(this.stdout, bytes, () => resolve())
        })
      })
      this._detachFeedError = feed.onError((code) => {
        console.error(`[CliRenderer] NativeSpanFeed error: code=${code}`)
      })
    }

    this.lib = lib
    this._terminalWidth = width
    this._terminalHeight = height
    this._useThread = config.useThread
    this._externalOutputMode = externalOutputMode

    this.width = initialGeometry.renderWidth
    this.height = initialGeometry.renderHeight
    this._splitHeight = initialGeometry.effectiveFooterHeight
    this.renderOffset = screenMode === "split-footer" ? 0 : initialGeometry.renderOffset

    this._footerHeight = footerHeight

    this.rendererPtr = rendererPtr
    this.clearOnShutdown = config.clearOnShutdown ?? true
    this.lib.setClearOnShutdown(this.rendererPtr, this.clearOnShutdown)

    const forwardEnvKeys = config.forwardEnvKeys ?? (config.remote === false ? [...DEFAULT_FORWARDED_ENV_KEYS] : [])
    for (const key of forwardEnvKeys) {
      const value = process.env[key]
      if (value === undefined) continue
      this.lib.setTerminalEnvVar(this.rendererPtr, key, value)
    }

    this.exitOnCtrlC = config.exitOnCtrlC === undefined ? true : config.exitOnCtrlC
    this.exitSignals = config.exitSignals || [
      "SIGINT", // Ctrl+C
      "SIGTERM", // Termination signal
      "SIGQUIT", // Ctrl+\
      "SIGABRT", // Abort signal
      "SIGHUP", // Hangup (terminal closed)
      "SIGBREAK", // Ctrl+Break on Windows
      "SIGPIPE", // Broken pipe
      "SIGBUS", // Bus error
    ]

    this.clipboard = new Clipboard(this.lib, this.rendererPtr)
    this.resizeDebounceDelay = config.debounceDelay || 100
    this.targetFps = config.targetFps || 30
    this.maxFps = config.maxFps || 60
    this.clock = config.clock ?? new SystemClock()
    this.themeModeState = new RendererThemeMode(
      {
        queryThemeColors: () => {
          this.lib.queryThemeColors(this.rendererPtr)
        },
      },
      this.clock,
    )
    this.themeModeHandler = (sequence: string) => {
      const result = this.themeModeState.handleSequence(sequence)
      if (result.changedMode) {
        this.clearPaletteCache()
        if (this.shouldSyncNativePaletteState() || this.listenerCount(CliRenderEvents.PALETTE) > 0) {
          this.refreshPalette()
        }
        this.emit(CliRenderEvents.THEME_MODE, result.changedMode)
      }
      return result.handled
    }
    this.memorySnapshotInterval = config.memorySnapshotInterval ?? 0
    this.gatherStats = config.gatherStats || false
    this.maxStatSamples = config.maxStatSamples || 300
    this.enableMouseMovement = config.enableMouseMovement ?? true
    this._useMouse = config.useMouse ?? true
    this.autoFocus = config.autoFocus ?? true
    this.nextRenderBuffer = this.lib.getNextBuffer(this.rendererPtr)
    this.currentRenderBuffer = this.lib.getCurrentBuffer(this.rendererPtr)
    this.postProcessFns = config.postProcessFns || []
    this.prependedInputHandlers = config.prependInputHandlers || []

    this.root = new RootRenderable(this)

    if (this.memorySnapshotInterval > 0) {
      this.startMemorySnapshotTimer()
    }

    // Handle terminal resize via SIGWINCH, but only when attached to the
    // process's real stdout — a custom Writable wouldn't drive SIGWINCH
    // anyway, and external consumers can call `renderer.resize(w, h)` to
    // announce dimension changes themselves.
    if (this._usesProcessStdout) {
      process.on("SIGWINCH", this.sigwinchHandler)
    }

    process.on("warning", this.warningHandler)

    process.on("uncaughtException", this.handleError)
    process.on("unhandledRejection", this.handleError)
    process.on("beforeExit", this.exitHandler)

    const useKittyForParsing = kittyConfig !== null
    this._keyHandler = new InternalKeyHandler()
    this._keyHandler.on("keypress", (event) => {
      // Use the shared matcher here too. Kitty can report a non-Latin
      // character plus a base-layout `c`, and Ctrl+C should still exit.
      if (this.exitOnCtrlC && matchesKeyBinding(event, { name: "c", ctrl: true })) {
        process.nextTick(() => {
          this.destroy()
        })
        return
      }
    })

    this.addExitListeners()

    const stdinParserMaxBufferBytes = config.stdinParserMaxBufferBytes ?? DEFAULT_STDIN_PARSER_MAX_BUFFER_BYTES
    this.stdinParser = new StdinParser({
      timeoutMs: 20,
      maxPendingBytes: stdinParserMaxBufferBytes,
      armTimeouts: true,
      onTimeoutFlush: () => {
        this.drainStdinParser()
      },
      useKittyKeyboard: useKittyForParsing,
      protocolContext: {
        kittyKeyboardEnabled: useKittyForParsing,
        privateCapabilityRepliesActive: false,
        pixelResolutionQueryActive: false,
        explicitWidthCprActive: false,
        startupCursorCprActive: false,
      },
      clock: this.clock,
    })

    this._console = new TerminalConsole(this, {
      ...(config.consoleOptions ?? {}),
      clock: this.clock,
    })
    this.consoleMode = config.consoleMode ?? "console-overlay"
    this.applyScreenMode(screenMode, false, false)
    rendererTracker.streamOwners.set(stdin, this)
    rendererTracker.streamOwners.set(stdout, this)
    this._streamLeaseAcquired = true
    rendererTracker.renderers.add(this)
    this.stdout.write = externalOutputMode === "capture-stdout" ? this.interceptStdoutWrite : this.realStdoutWrite
    this._openConsoleOnError = config.openConsoleOnError ?? process.env.NODE_ENV !== "production"
    this._onDestroy = config.onDestroy

    global.requestAnimationFrame = (callback: FrameRequestCallback) => {
      const id = CliRenderer.animationFrameId++
      this.animationRequest.set(id, callback)
      this.requestLive()
      return id
    }
    global.cancelAnimationFrame = (handle: number) => {
      this.animationRequest.delete(handle)
    }

    const window = global.window
    if (!window) {
      global.window = {} as Window & typeof globalThis
    }
    global.window.requestAnimationFrame = requestAnimationFrame

    // Prevents output from being written to the terminal, useful for debugging
    if (env.OTUI_NO_NATIVE_RENDER) {
      this.renderNative = () => {
        if (this._splitHeight > 0) {
          this.flushStdoutCache(this._splitHeight)
        }
        return "rendered"
      }
    }

    try {
      this.setupInput()
    } catch (error) {
      try {
        this.destroy()
      } catch (destroyError) {
        console.error("Error destroying renderer after input setup failure:", destroyError)
      }
      throw error
    }
  }

  private addExitListeners(): void {
    if (this._exitListenersAdded || this.exitSignals.length === 0) return

    this.exitSignals.forEach((signal) => {
      process.addListener(signal, this.exitHandler)
    })

    this._exitListenersAdded = true
  }

  private removeExitListeners(): void {
    if (!this._exitListenersAdded || this.exitSignals.length === 0) return

    this.exitSignals.forEach((signal) => {
      process.removeListener(signal, this.exitHandler)
    })

    this._exitListenersAdded = false
  }

  public get isDestroyed(): boolean {
    return this._isDestroyed
  }

  public registerLifecyclePass(renderable: Renderable) {
    this.lifecyclePasses.add(renderable)
  }

  public unregisterLifecyclePass(renderable: Renderable) {
    this.lifecyclePasses.delete(renderable)
  }

  public getLifecyclePasses() {
    return this.lifecyclePasses
  }

  public get currentFocusedRenderable(): Renderable | null {
    return this._currentFocusedRenderable
  }

  public get currentFocusedEditor(): EditBufferRenderable | null {
    if (!this._currentFocusedRenderable) return null
    if (!isEditBufferRenderable(this._currentFocusedRenderable)) return null
    return this._currentFocusedRenderable
  }

  private normalizeClockTime(now: number, fallback: number): number {
    if (Number.isFinite(now)) {
      return now
    }

    return Number.isFinite(fallback) ? fallback : 0
  }

  private getElapsedMs(now: number, then: number): number {
    if (!Number.isFinite(now) || !Number.isFinite(then)) {
      return 0
    }

    return Math.max(now - then, 0)
  }

  public focusRenderable(renderable: Renderable) {
    if (this._currentFocusedRenderable === renderable) {
      return
    }

    const previousRenderable = this._currentFocusedRenderable
    const previousEditor = this.currentFocusedEditor

    this._currentFocusedRenderable = renderable
    previousRenderable?.blur()

    const currentEditor = this.currentFocusedEditor
    if (previousEditor !== currentEditor) {
      this.emit(CliRenderEvents.FOCUSED_EDITOR, currentEditor, previousEditor)
    }

    this.emit(CliRenderEvents.FOCUSED_RENDERABLE, renderable, previousRenderable)
  }

  public blurRenderable(renderable: Renderable): void {
    if (this._currentFocusedRenderable !== renderable) {
      return
    }

    const previousEditor = this.currentFocusedEditor
    this._currentFocusedRenderable = null

    if (previousEditor !== null) {
      this.emit(CliRenderEvents.FOCUSED_EDITOR, null, previousEditor)
    }

    this.emit(CliRenderEvents.FOCUSED_RENDERABLE, null, renderable)
  }

  private setCapturedRenderable(renderable: Renderable | undefined): void {
    if (this.capturedRenderable === renderable) {
      return
    }
    this.capturedRenderable = renderable
  }

  public addToHitGrid(x: number, y: number, width: number, height: number, id: number) {
    if (!this._useMouse) return
    if (id !== this.capturedRenderable?.num) {
      this.lib.addToHitGrid(this.rendererPtr, x, y, width, height, id)
    }
  }

  public pushHitGridScissorRect(x: number, y: number, width: number, height: number): void {
    this.lib.hitGridPushScissorRect(this.rendererPtr, x, y, width, height)
  }

  public popHitGridScissorRect(): void {
    this.lib.hitGridPopScissorRect(this.rendererPtr)
  }

  public clearHitGridScissorRects(): void {
    this.lib.hitGridClearScissorRects(this.rendererPtr)
  }

  public get widthMethod(): WidthMethod {
    const caps = this.capabilities
    return caps?.unicode === "wcwidth" ? "wcwidth" : "unicode"
  }

  public get frameId(): number {
    return this._frameId
  }

  private writeOut(chunk: any, encoding?: any, callback?: any): boolean {
    // Route through the native backend whenever:
    //   (a) threading is on (pre-existing path — batches with the render thread), OR
    //   (b) a feed is wired (custom stdout) — otherwise the else-branch would
    //       write directly to the user's Writable, bypassing the feed and
    //       causing TS-side ANSI to interleave with Zig-emitted frame bytes
    //       on Linux where threading is forced off.
    if (this.rendererPtr && (this._useThread || this._feed !== null)) {
      const data = typeof chunk === "string" ? chunk : (chunk?.toString() ?? "")
      this.lib.writeOut(this.rendererPtr, data)
      if (typeof callback === "function") {
        process.nextTick(callback)
      }
      return true
    }

    return this.realStdoutWrite.call(this.stdout, chunk, encoding, callback)
  }

  private scheduleRenderAfterFeedIdle(): void {
    const feed = this._feed
    if (!feed || this.feedIdleRenderScheduled || this._isDestroyed) return

    this.feedIdleRenderScheduled = true
    feed.idle().then(() => {
      this.feedIdleRenderScheduled = false
      const ordinaryFrameWasWaiting = this.ordinaryFrameWaitingForFeed
      const ordinaryFrameWaitControlState = this.ordinaryFrameWaitControlState
      this.ordinaryFrameWaitingForFeed = false
      this.ordinaryFrameWaitControlState = null
      if (
        this._isDestroyed ||
        (ordinaryFrameWasWaiting &&
          this._controlState !== ordinaryFrameWaitControlState &&
          (this._controlState === RendererControlState.EXPLICIT_PAUSED ||
            this._controlState === RendererControlState.EXPLICIT_STOPPED ||
            this._controlState === RendererControlState.EXPLICIT_SUSPENDED))
      ) {
        this.resolveIdleIfNeeded()
        return
      }

      this.scheduleRenderTimer()
      this.resolveIdleIfNeeded()
    })
  }

  private handleNativeRenderRejection(status: number): "retryable-skip" | "backpressured" | "failed" {
    if (status === NATIVE_RENDER_STATUS_SKIPPED && this._feed) {
      this.ordinaryFrameWaitingForFeed = true
      this.ordinaryFrameWaitControlState = this._controlState
      this.scheduleRenderAfterFeedIdle()
      return "retryable-skip"
    }

    if (status === NATIVE_RENDER_STATUS_SKIPPED) {
      if (this._useThread && this._usesProcessStdout) return "backpressured"
      console.error("[CliRenderer] Native frame render unexpectedly skipped without a feed")
      return "failed"
    }

    return this.reportNativeRenderFailure()
  }

  private reportNativeRenderFailure(): "failed" {
    console.error("[CliRenderer] Native frame render failed; waiting for the next render request to force repaint")
    return "failed"
  }

  private scheduleRenderTimer(): void {
    if (this.renderTimeout || this._isDestroyed || this._controlState === RendererControlState.EXPLICIT_SUSPENDED)
      return

    const now = this.normalizeClockTime(this.clock.now(), this.lastTime)
    const elapsed = this.getElapsedMs(now, this.lastTime)
    const delay = Math.max(this.minTargetFrameTime - elapsed, 0)
    this.renderTimeout = this.clock.setTimeout(() => {
      this.renderTimeout = null
      this.loop()
    }, delay)
  }

  private scheduleRenderAfterBackpressure(): void {
    if (this._feed) {
      this.scheduleRenderAfterFeedIdle()
      return
    }

    this.scheduleRenderTimer()
  }

  public requestRender() {
    if (this._controlState === RendererControlState.EXPLICIT_SUSPENDED) {
      return
    }

    // A skipped feed-backed frame already owns the next scheduling attempt through
    // feed.idle(). Coalesce normal invalidations into that retry so split-footer
    // output and UI updates cannot start competing render passes while the feed is busy.
    if (this.feedIdleRenderScheduled) {
      return
    }

    if (this._isRunning) {
      if (!this.rendering && !this.renderTimeout && !this.ordinaryFrameWaitingForFeed) {
        this.scheduleRenderTimer()
      }
      return
    }

    if (this.ordinaryFrameWaitingForFeed) {
      return
    }

    // NOTE: Using a frame callback that causes a re-render while already rendering
    // leads to a continuous loop of renders.
    if (this.rendering) {
      this.immediateRerenderRequested = true
      return
    }

    if (!this.updateScheduled && !this.renderTimeout) {
      this.updateScheduled = true
      const now = this.normalizeClockTime(this.clock.now(), this.lastTime)
      const elapsed = this.getElapsedMs(now, this.lastTime)
      const delay = Math.max(this.minTargetFrameTime - elapsed, 0)

      if (delay === 0) {
        process.nextTick(() => this.activateFrame())
        return
      }

      this.clock.setTimeout(() => this.activateFrame(), delay)
    }
  }

  private async activateFrame() {
    if (!this.updateScheduled) {
      this.resolveIdleIfNeeded()
      return
    }

    try {
      await this.loop()
    } finally {
      this.updateScheduled = false
      this.resolveIdleIfNeeded()
    }
  }

  public get consoleMode(): ConsoleMode {
    return this._useConsole ? "console-overlay" : "disabled"
  }

  public set consoleMode(mode: ConsoleMode) {
    this._useConsole = mode === "console-overlay"
    if (this._useConsole) {
      this.console.activate()
    } else {
      this.console.deactivate()
    }
  }

  public get isRunning(): boolean {
    return this._isRunning
  }

  private isIdleNow(): boolean {
    if (this._isDestroyed) return true

    return (
      !this._isRunning &&
      !this.rendering &&
      !this.renderTimeout &&
      !this.updateScheduled &&
      !this.feedIdleRenderScheduled &&
      !this.immediateRerenderRequested
    )
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdleNow()) return
    const resolvers = this.idleResolvers.splice(0)
    for (const resolve of resolvers) {
      resolve()
    }
  }

  public idle(): Promise<void> {
    if (this._isDestroyed) return Promise.resolve()
    if (this.isIdleNow()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve)
    })
  }

  public getSchedulerState(): RendererSchedulerState {
    return {
      isRunning: this._isRunning,
      isRendering: this.rendering,
      hasScheduledRender: Boolean(this.renderTimeout || this.updateScheduled || this.immediateRerenderRequested),
    }
  }

  public get resolution(): PixelResolution | null {
    return this._resolution
  }

  public get console(): TerminalConsole {
    return this._console
  }

  public get keyInput(): KeyHandler {
    return this._keyHandler
  }

  public get _internalKeyInput(): InternalKeyHandler {
    return this._keyHandler
  }

  public get terminalWidth(): number {
    return this._terminalWidth
  }

  public get terminalHeight(): number {
    return this._terminalHeight
  }

  public get useThread(): boolean {
    return this._useThread
  }

  public get targetFps(): number {
    return this._targetFps
  }

  public set targetFps(targetFps: number) {
    this._targetFps = targetFps
    this.targetFrameTime = 1000 / this._targetFps
  }

  public get maxFps(): number {
    return this._maxFps
  }

  public set maxFps(maxFps: number) {
    this._maxFps = maxFps
    this.minTargetFrameTime = 1000 / this._maxFps
  }

  public get useMouse(): boolean {
    return this._useMouse
  }

  public set useMouse(useMouse: boolean) {
    if (this._useMouse === useMouse) return // No change needed

    this._useMouse = useMouse

    if (useMouse) {
      this.enableMouse()
      this.requestRender()
    } else {
      this.disableMouse()
    }
  }

  public get screenMode(): ScreenMode {
    return this._screenMode
  }

  public set screenMode(mode: ScreenMode) {
    if (this.externalOutputMode === "capture-stdout" && mode !== "split-footer") {
      if (this.pendingExternalOutputMode === "passthrough") {
        this.flushPendingSplitOutputBeforeLeavingSplitFooter()
      }

      if (this.externalOutputMode !== "capture-stdout") {
        this.applyScreenMode(mode)
        return
      }

      throw new Error('externalOutputMode "capture-stdout" requires screenMode "split-footer"')
    }

    this.applyScreenMode(mode)
  }

  public get footerHeight(): number {
    return this._footerHeight
  }

  public set footerHeight(footerHeight: number) {
    const normalizedFooterHeight = normalizeFooterHeight(footerHeight)
    if (normalizedFooterHeight === this._footerHeight) {
      return
    }

    this._footerHeight = normalizedFooterHeight
    if (this.screenMode === "split-footer") {
      this.applyScreenMode("split-footer")
    }
  }

  public get externalOutputMode(): ExternalOutputMode {
    return this._externalOutputMode
  }

  public set externalOutputMode(mode: ExternalOutputMode) {
    if (mode === "capture-stdout" && this.screenMode !== "split-footer") {
      throw new Error('externalOutputMode "capture-stdout" requires screenMode "split-footer"')
    }

    const previousMode = this._externalOutputMode
    if (previousMode === mode) {
      if (this.pendingExternalOutputMode !== null && this.pendingExternalOutputMode !== mode) {
        this.pendingExternalOutputMode = null
      }
      return
    }

    const canFlushSplitOutputBeforeTransition = this.canFlushSplitOutputBeforeTransition()
    const isSplitCaptureToPassthrough =
      previousMode === "capture-stdout" &&
      mode === "passthrough" &&
      this._screenMode === "split-footer" &&
      this._splitHeight > 0

    if (isSplitCaptureToPassthrough && this.externalOutputQueue.size > 0 && !canFlushSplitOutputBeforeTransition) {
      this.pendingExternalOutputMode = "passthrough"
      return
    }

    if (isSplitCaptureToPassthrough && canFlushSplitOutputBeforeTransition) {
      this.flushPendingSplitOutputBeforeTransition()
    }

    this.pendingExternalOutputMode = null
    this.applyExternalOutputMode(mode)
    this.afterExternalOutputModeChanged(previousMode, mode)
  }

  private applyExternalOutputMode(mode: ExternalOutputMode): void {
    this._externalOutputMode = mode
    this.stdout.write = mode === "capture-stdout" ? this.interceptStdoutWrite : this.realStdoutWrite
  }

  private afterExternalOutputModeChanged(previousMode: ExternalOutputMode, mode: ExternalOutputMode): void {
    if (this._screenMode === "split-footer" && this._splitHeight > 0 && mode === "capture-stdout") {
      const previousSurfaceTopLine = this.renderOffset + 1
      const previousSurfaceHeight = this._splitHeight

      this.clearPendingSplitFooterTransition()
      this.resetSplitScrollback(this.getSplitCursorSeedRows())

      if (previousMode === "passthrough" && this._terminalIsSetup) {
        const nextSurfaceTopLine = this.renderOffset + 1
        if (previousSurfaceTopLine !== nextSurfaceTopLine) {
          this.setPendingSplitFooterTransition({
            mode: "clear-stale-rows",
            sourceTopLine: previousSurfaceTopLine,
            sourceHeight: previousSurfaceHeight,
            targetTopLine: nextSurfaceTopLine,
            targetHeight: this._splitHeight,
            scrollLines: 0,
          })
          this.forceFullRepaintRequested = true
        }
      }

      this.requestRender()
      return
    }

    if (
      this._screenMode === "split-footer" &&
      this._splitHeight > 0 &&
      previousMode === "capture-stdout" &&
      mode === "passthrough"
    ) {
      this.clearPendingSplitFooterTransition()
      return
    }

    this.syncSplitFooterState()
  }

  private applyPendingExternalOutputModeIfReady(): void {
    const pendingMode = this.pendingExternalOutputMode
    if (pendingMode === null || this.externalOutputQueue.size > 0) {
      return
    }

    const previousMode = this._externalOutputMode
    this.pendingExternalOutputMode = null

    if (previousMode === pendingMode) {
      return
    }

    this.applyExternalOutputMode(pendingMode)
    this.afterExternalOutputModeChanged(previousMode, pendingMode)
  }

  private flushPendingSplitOutputBeforeLeavingSplitFooter(): void {
    if (this.pendingExternalOutputMode !== "passthrough") {
      return
    }

    if (this.isSplitCursorSeedFrameBlocked() && this._controlState !== RendererControlState.EXPLICIT_SUSPENDED) {
      this.abortSplitStartupCursorSeed()
    }

    this.flushPendingSplitOutputBeforeTransition()

    if (this.pendingExternalOutputMode !== null) {
      throw new Error("Cannot leave split-footer while captured output is pending")
    }
  }

  public get liveRequestCount(): number {
    return this.liveRequestCounter
  }

  public get currentControlState(): string {
    return this._controlState
  }

  public get capabilities(): TerminalCapabilities | null {
    return this._capabilities
  }

  public triggerNotification(message: string, title?: string): boolean {
    if (this._isDestroyed) return false
    return this.lib.triggerNotification(this.rendererPtr, message, title)
  }

  public get themeMode(): ThemeMode | null {
    return this.themeModeState.themeMode
  }

  public waitForThemeMode(timeoutMs: number = 1000): Promise<ThemeMode | null> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("timeoutMs must be a non-negative finite number")
    }

    return this.themeModeState.waitForThemeMode(timeoutMs, this._isDestroyed)
  }

  public getDebugInputs(): Array<{ timestamp: string; sequence: string }> {
    return [...this._debugInputs]
  }

  public get useKittyKeyboard(): boolean {
    return this.lib.getKittyKeyboardFlags(this.rendererPtr) > 0
  }

  public set useKittyKeyboard(use: boolean) {
    const flags = use ? KITTY_FLAG_DISAMBIGUATE | KITTY_FLAG_ALTERNATE_KEYS : 0
    this.lib.setKittyKeyboardFlags(this.rendererPtr, flags)
  }

  public createScrollbackSurface(options: ScrollbackSurfaceOptions = {}): ScrollbackSurface {
    if (this._screenMode !== "split-footer" || this._externalOutputMode !== "capture-stdout") {
      throw new Error(
        'createScrollbackSurface requires screenMode "split-footer" and externalOutputMode "capture-stdout"',
      )
    }

    const renderer = this
    const surfaceId = scrollbackSurfaceCounter++
    const startOnNewLine = options.startOnNewLine ?? true
    const tailColumn = renderer.getPendingSplitTailColumn()
    const firstLineOffset = !startOnNewLine && tailColumn > 0 && tailColumn < renderer.width ? tailColumn : 0

    const snapshotContext = new ScrollbackSnapshotRenderContext(renderer.width, 1, renderer.widthMethod)
    let firstLineOffsetOwner: Renderable | null = null
    const renderContext = Object.create(snapshotContext) as RenderContext
    Object.defineProperty(renderContext, "claimFirstLineOffset", {
      value: (renderable?: Renderable): number => {
        if (firstLineOffsetOwner?.isDestroyed) {
          firstLineOffsetOwner = null
        }

        if (firstLineOffsetOwner) {
          return 0
        }

        firstLineOffsetOwner = renderable ?? null
        return firstLineOffset
      },
      enumerable: true,
      configurable: true,
    })

    const internalRoot = new RootRenderable(renderContext)
    const publicRoot = new BoxRenderable(renderContext, {
      id: `scrollback-surface-root-${surfaceId}`,
      position: "absolute",
      left: 0,
      top: 0,
      width: renderer.width,
      height: "auto",
      border: false,
      backgroundColor: "transparent",
      shouldFill: false,
      flexDirection: "column",
    })
    internalRoot.add(publicRoot)

    let surfaceWidth = renderer.width
    let surfaceHeight = 1
    let surfaceWidthMethod = renderer.widthMethod
    let surfaceDestroyed = false
    let hasRendered = false
    let nextCommitStartOnNewLine = startOnNewLine
    let backingBuffer = OptimizedBuffer.create(surfaceWidth, surfaceHeight, surfaceWidthMethod, {
      id: `scrollback-surface-buffer-${surfaceId}`,
    })

    const destroyListener = (): void => {
      destroySurface()
    }

    const assertNotDestroyed = (): void => {
      if (surfaceDestroyed) {
        throw new Error("ScrollbackSurface is destroyed")
      }
    }

    const assertRendered = (): void => {
      if (!hasRendered) {
        throw new Error("ScrollbackSurface.commitRows requires render() before commitRows()")
      }
    }

    const assertGeometryStillCurrent = (): void => {
      if (renderer.width !== surfaceWidth || renderer.widthMethod !== surfaceWidthMethod) {
        throw new Error("ScrollbackSurface.commitRows requires render() after renderer geometry changes")
      }
    }

    const assertRowRange = (startRow: number, endRowExclusive: number): void => {
      if (!Number.isInteger(startRow) || !Number.isInteger(endRowExclusive)) {
        throw new Error("ScrollbackSurface.commitRows requires finite integer row bounds")
      }

      if (startRow < 0) {
        throw new Error("ScrollbackSurface.commitRows requires startRow >= 0")
      }

      if (endRowExclusive < startRow) {
        throw new Error("ScrollbackSurface.commitRows requires endRowExclusive >= startRow")
      }

      if (endRowExclusive > surfaceHeight) {
        throw new Error("ScrollbackSurface.commitRows row range exceeds rendered surface height")
      }
    }

    const collectPendingCodeRenderables = (node: Renderable): CodeRenderable[] => {
      const pending: CodeRenderable[] = []

      if (node instanceof CodeRenderable && node.isHighlighting) {
        pending.push(node)
      }

      for (const child of node.getChildren()) {
        pending.push(...collectPendingCodeRenderables(child))
      }

      return pending
    }

    const waitForPendingHighlights = async (pending: CodeRenderable[], timeoutMs: number): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timeoutHandle = renderer.clock.setTimeout(() => {
          if (settled) {
            return
          }

          settled = true
          reject(new Error("ScrollbackSurface.settle timed out waiting for CodeRenderable highlighting"))
        }, timeoutMs)

        Promise.all(pending.map((renderable) => renderable.highlightingDone)).then(
          () => {
            if (settled) {
              return
            }

            settled = true
            renderer.clock.clearTimeout(timeoutHandle)
            resolve()
          },
          (error) => {
            if (settled) {
              return
            }

            settled = true
            renderer.clock.clearTimeout(timeoutHandle)
            reject(error)
          },
        )
      })
    }

    const renderSurface = (): void => {
      assertNotDestroyed()

      const width = renderer.width
      const widthMethod = renderer.widthMethod

      snapshotContext.width = width
      snapshotContext.widthMethod = widthMethod
      publicRoot.width = width

      const renderPass = (height: number): void => {
        snapshotContext.height = height
        internalRoot.resize(width, height)
        backingBuffer.resize(width, height)
        backingBuffer.clear(TRANSPARENT_RGBA)
        snapshotContext.frameId += 1
        internalRoot.render(backingBuffer, 0)
      }

      let targetHeight = Math.max(1, surfaceHeight)

      if (surfaceWidthMethod !== widthMethod) {
        backingBuffer.destroy()
        backingBuffer = OptimizedBuffer.create(width, targetHeight, widthMethod, {
          id: `scrollback-surface-buffer-${surfaceId}`,
        })
      } else {
        backingBuffer.resize(width, targetHeight)
      }

      for (let pass = 0; pass < MAX_SCROLLBACK_SURFACE_HEIGHT_PASSES; pass += 1) {
        renderPass(targetHeight)

        const measuredHeight = Math.max(1, publicRoot.height)
        if (measuredHeight === targetHeight) {
          surfaceWidth = width
          surfaceHeight = measuredHeight
          surfaceWidthMethod = widthMethod
          hasRendered = true
          return
        }

        targetHeight = measuredHeight
      }

      renderPass(targetHeight)

      surfaceWidth = width
      surfaceHeight = targetHeight
      surfaceWidthMethod = widthMethod
      hasRendered = true
    }

    const settleSurface = async (timeoutMs: number = 2000): Promise<void> => {
      assertNotDestroyed()

      const startedAt = renderer.clock.now()
      renderSurface()

      while (true) {
        assertNotDestroyed()

        const pending = collectPendingCodeRenderables(publicRoot)
        if (pending.length === 0) {
          return
        }

        const remainingMs = timeoutMs - (renderer.clock.now() - startedAt)
        if (remainingMs <= 0) {
          throw new Error("ScrollbackSurface.settle timed out waiting for CodeRenderable highlighting")
        }

        await waitForPendingHighlights(pending, remainingMs)
        assertNotDestroyed()
        renderSurface()
      }
    }

    const commitRows = (
      startRow: number,
      endRowExclusive: number,
      commitOptions: ScrollbackSurfaceCommitOptions = {},
    ): void => {
      assertNotDestroyed()
      assertRendered()
      assertGeometryStillCurrent()
      assertRowRange(startRow, endRowExclusive)

      if (startRow === endRowExclusive) {
        return
      }

      const rowCount = endRowExclusive - startRow
      const commitBuffer = OptimizedBuffer.create(surfaceWidth, rowCount, surfaceWidthMethod, {
        id: `scrollback-surface-commit-${surfaceId}`,
      })

      try {
        commitBuffer.drawFrameBuffer(0, 0, backingBuffer, 0, startRow, surfaceWidth, rowCount)

        renderer.enqueueRenderedScrollbackCommit({
          snapshot: commitBuffer,
          rowColumns: commitOptions.rowColumns,
          startOnNewLine: nextCommitStartOnNewLine,
          trailingNewline: commitOptions.trailingNewline ?? true,
        })

        nextCommitStartOnNewLine = false
      } catch (error) {
        commitBuffer.destroy()
        throw error
      }
    }

    const destroySurface = (): void => {
      if (surfaceDestroyed) {
        return
      }

      surfaceDestroyed = true
      renderer.off(CliRenderEvents.DESTROY, destroyListener)

      let destroyError: unknown = null

      try {
        internalRoot.destroyRecursively()
      } catch (error) {
        destroyError = error
      }

      try {
        backingBuffer.destroy()
      } catch (error) {
        if (destroyError === null) {
          destroyError = error
        }
      }

      renderContext.removeAllListeners()
      snapshotContext.removeAllListeners()

      if (destroyError !== null) {
        throw destroyError
      }
    }

    renderer.on(CliRenderEvents.DESTROY, destroyListener)

    return {
      get renderContext(): RenderContext {
        return renderContext
      },
      get root(): Renderable {
        return publicRoot
      },
      get width(): number {
        return surfaceWidth
      },
      get height(): number {
        return surfaceHeight
      },
      get isDestroyed(): boolean {
        return surfaceDestroyed
      },
      render: renderSurface,
      settle: settleSurface,
      commitRows,
      destroy: destroySurface,
    }
  }

  // writeToScrollback is a "render to scrollback commit" API, not a direct stdout
  // write. The callback returns a renderable tree, we render that tree into an
  // off-screen OptimizedBuffer, then enqueue the result as one ExternalOutputCommit.
  //
  // Why this shape exists:
  // - It keeps app-authored scrollback output in the same FIFO queue as captured
  //   stdout, so ordering is deterministic even when both sources interleave.
  // - It lets the render loop batch multiple queued commits into one native frame,
  //   which is the key mechanism that avoids repeated sync/cursor toggles (flicker).
  // - It reuses the normal renderable pipeline (layout, styling, grapheme shaping),
  //   so scrollback payloads match what users see in the live UI.
  //
  // startOnNewLine and trailingNewline preserve newline intent when one logical
  // write spans multiple commits. startOnNewLine adds a newline before this commit
  // if the previous commit ended mid-row. trailingNewline adds a newline after this
  // commit's final row.
  //
  // Native split append uses these flags to avoid glued rows (missing newline), and
  // double-advance gaps (extra newline), while still appending payload and repainting
  // footer in the same frame.
  //
  // Side effects: throws if split-footer capture mode is not active, transfers
  // snapshot buffer ownership to the queue on success, triggers async render,
  // and invokes snapshot teardown when cleanup runs.
  public writeToScrollback(write: ScrollbackWriter): void {
    if (this._screenMode !== "split-footer" || this._externalOutputMode !== "capture-stdout") {
      throw new Error('writeToScrollback requires screenMode "split-footer" and externalOutputMode "capture-stdout"')
    }

    const snapshotContext = new ScrollbackSnapshotRenderContext(this.width, this.height, this.widthMethod)
    const snapshot = write({
      width: this.width,
      widthMethod: this.widthMethod,
      tailColumn: this.getPendingSplitTailColumn(),
      renderContext: snapshotContext,
    })

    if (!snapshot || !snapshot.root) {
      throw new Error("writeToScrollback must return a snapshot root renderable")
    }

    let renderFailed = false
    let snapshotRoot: RootRenderable | null = null
    let snapshotBuffer: OptimizedBuffer | null = null

    try {
      const rootRenderable = snapshot.root
      const snapshotWidth = this.getSnapshotWidth(snapshot.width, rootRenderable.width)
      const snapshotHeight = this.getSnapshotHeight(snapshot.height, rootRenderable.height)

      snapshotContext.width = snapshotWidth
      snapshotContext.height = snapshotHeight
      snapshotContext.widthMethod = this.widthMethod

      snapshotRoot = new RootRenderable(snapshotContext)
      snapshotBuffer = OptimizedBuffer.create(snapshotWidth, snapshotHeight, this.widthMethod, {
        id: "scrollback-snapshot-commit",
      })

      // Render through normal renderables so split scrollback output uses the same
      // text shaping/styling pipeline as the rest of the renderer.
      snapshotRoot.add(rootRenderable)
      snapshotRoot.render(snapshotBuffer, 0)
      this.enqueueRenderedScrollbackCommit({
        snapshot: snapshotBuffer,
        rowColumns: snapshot.rowColumns,
        startOnNewLine: snapshot.startOnNewLine,
        trailingNewline: snapshot.trailingNewline,
      })
    } catch (error) {
      renderFailed = true
      snapshotBuffer?.destroy()
      throw error
    } finally {
      let cleanupError: unknown | null = null

      try {
        if (snapshotRoot) {
          snapshotRoot.destroyRecursively()
        } else {
          snapshot.root.destroyRecursively()
        }
      } catch (error) {
        cleanupError = error
      }

      try {
        snapshot.teardown?.()
      } catch (error) {
        if (cleanupError === null) {
          cleanupError = error
        }
      }

      if (!renderFailed && cleanupError) {
        throw cleanupError
      }
    }
  }

  public resetSplitFooterForReplay(options: SplitFooterReplayResetOptions = {}): void {
    if (this._isDestroyed) return
    if (this._screenMode !== "split-footer" || this._externalOutputMode !== "capture-stdout") {
      throw new Error(
        'resetSplitFooterForReplay requires screenMode "split-footer" and externalOutputMode "capture-stdout"',
      )
    }
    if (!this._terminalIsSetup || this._controlState === RendererControlState.EXPLICIT_SUSPENDED) {
      throw new Error("resetSplitFooterForReplay requires an active terminal")
    }

    this.flushPendingSplitOutputBeforeTransition(true)
    this.externalOutputQueue.clear()
    this.abortSplitStartupCursorSeed()
    this.clearPendingSplitFooterTransition()
    this.resetSplitScrollback()
    this.currentRenderBuffer.clear(this.backgroundColor)
    this.nextRenderBuffer.clear(this.backgroundColor)
    this.forceFullRepaintRequested = true
    this.writeOut(
      ANSI.resetScrollRegion +
        ANSI.reset +
        ANSI.home +
        ANSI.clearScreen +
        (options.clearSavedLines ? ANSI.clearSavedLines : "") +
        ANSI.home,
    )
    this.requestRender()
  }

  private getSnapshotWidth(value: number | undefined, fallback: number): number {
    const rawValue = value ?? fallback

    if (!Number.isFinite(rawValue)) {
      throw new Error("writeToScrollback produced a non-finite width")
    }

    return Math.min(Math.max(Math.trunc(rawValue), 1), Math.max(this.width, 1))
  }

  private getSnapshotHeight(value: number | undefined, fallback: number): number {
    const rawValue = value ?? fallback

    if (!Number.isFinite(rawValue)) {
      throw new Error("writeToScrollback produced a non-finite height")
    }

    return Math.max(Math.trunc(rawValue), 1)
  }

  private getSnapshotRowWidths(snapshot: OptimizedBuffer, rowColumns: number): number[] {
    const widths: number[] = []
    const limit = Math.min(Math.max(Math.trunc(rowColumns), 0), snapshot.width)
    const chars = snapshot.buffers.char

    for (let y = 0; y < snapshot.height; y += 1) {
      let x = limit

      while (x > 0) {
        const cp = chars[y * snapshot.width + x - 1]
        if (cp === 0 || (cp & CHAR_FLAG_MASK) === CHAR_FLAG_CONTINUATION) {
          x -= 1
          continue
        }

        break
      }

      widths.push(x)
    }

    return widths
  }

  private advanceSplitTailColumn(tailColumn: number, columns: number, width: number): number {
    if (columns <= 0) {
      return tailColumn
    }

    let tail = tailColumn
    let remaining = columns

    while (remaining > 0) {
      if (tail >= width) {
        tail = 0
      }

      const step = Math.min(remaining, width - tail)
      tail += step
      remaining -= step

      if (remaining > 0 && tail >= width) {
        tail = 0
      }
    }

    return tail
  }

  private getSplitTailColumnAfterCommit(
    commit: ExternalOutputCommit,
    initialTailColumn: number,
    width: number,
  ): number {
    let tailColumn = initialTailColumn

    if (commit.startOnNewLine && tailColumn > 0) {
      tailColumn = 0
    }

    const rowWidths = this.getSnapshotRowWidths(commit.snapshot, commit.rowColumns)
    for (const [index, rowWidth] of rowWidths.entries()) {
      tailColumn = this.advanceSplitTailColumn(tailColumn, rowWidth, width)
      if (index < rowWidths.length - 1 || commit.trailingNewline) {
        tailColumn = 0
      }
    }

    return tailColumn
  }

  private recordSplitCommit(commit: ExternalOutputCommit): void {
    this.splitTailColumn = this.getSplitTailColumnAfterCommit(commit, this.splitTailColumn, Math.max(this.width, 1))
  }

  private getPendingSplitTailColumn(): number {
    const width = Math.max(this.width, 1)
    let tailColumn = this.splitTailColumn

    for (const commit of this.externalOutputQueue.peek()) {
      tailColumn = this.getSplitTailColumnAfterCommit(commit, tailColumn, width)
    }

    return tailColumn
  }

  private enqueueRenderedScrollbackCommit(options: {
    snapshot: OptimizedBuffer
    rowColumns?: number
    startOnNewLine?: boolean
    trailingNewline?: boolean
  }): void {
    if (this._screenMode !== "split-footer" || this._externalOutputMode !== "capture-stdout") {
      throw new Error('scrollback commit requires screenMode "split-footer" and externalOutputMode "capture-stdout"')
    }

    const rowColumns = Math.min(
      Math.max(Math.trunc(options.rowColumns ?? options.snapshot.width), 0),
      options.snapshot.width,
    )

    this.enqueueSplitCommit({
      snapshot: options.snapshot,
      rowColumns,
      startOnNewLine: options.startOnNewLine ?? true,
      trailingNewline: options.trailingNewline ?? true,
    })

    this.requestRender()
  }

  private enqueueSplitCommit(commit: ExternalOutputCommit): void {
    this.externalOutputQueue.writeSnapshot(commit)
    if (this.listenerCount(CliRenderEvents.EXTERNAL_OUTPUT) > 0) {
      this.emit(CliRenderEvents.EXTERNAL_OUTPUT, commit)
    }
  }

  private createStdoutSnapshotCommit(line: string, trailingNewline: boolean): ExternalOutputCommit {
    // Convert captured stdout into the same commit shape used by writeToScrollback.
    // One commit format keeps split append behavior consistent across both sources.
    const snapshotContext = new ScrollbackSnapshotRenderContext(this.width, 1, this.widthMethod)
    const maxWidth = Math.max(1, this.width)
    const lineCells = [...line]
    const rowColumns = Math.min(lineCells.length, maxWidth)
    const renderedLine = lineCells.slice(0, maxWidth).join("")
    const snapshotRoot = new RootRenderable(snapshotContext)
    const snapshotRenderable = new TextRenderable(snapshotContext, {
      id: "captured-stdout-snapshot",
      position: "absolute",
      left: 0,
      top: 0,
      width: Math.max(1, rowColumns),
      height: 1,
      content: renderedLine,
    })
    const snapshotBuffer = OptimizedBuffer.create(Math.max(1, rowColumns), 1, this.widthMethod, {
      id: "captured-stdout-snapshot",
    })

    try {
      snapshotRoot.add(snapshotRenderable)
      snapshotRoot.render(snapshotBuffer, 0)
      return {
        snapshot: snapshotBuffer,
        rowColumns,
        startOnNewLine: false,
        trailingNewline,
      }
    } catch (error) {
      snapshotBuffer.destroy()
      throw error
    } finally {
      snapshotRoot.destroyRecursively()
    }
  }

  private splitStdoutRows(text: string): Array<{ line: string; trailingNewline: boolean }> {
    // Captured stdout arrives as an arbitrary byte stream, but split append commits
    // are row-based (line text + whether that row ended with '\n'). We normalize
    // here because native split append expects already-decoded row intent, not raw
    // control characters.
    //
    // '\r' must restart the in-progress row so in-place status updates (progress
    // bars/spinners) do not accumulate stale prefixes in scrollback. '\n' commits
    // the row and marks newline intent for the final chunk of that logical row.
    const rows: Array<{ line: string; trailingNewline: boolean }> = []
    let current = ""

    for (const char of text) {
      if (char === "\r") {
        current = ""
        continue
      }

      if (char === "\n") {
        rows.push({ line: current, trailingNewline: true })
        current = ""
        continue
      }

      current += char
    }

    if (current.length > 0) {
      rows.push({ line: current, trailingNewline: false })
    }

    return rows
  }

  private createStdoutSnapshotCommits(text: string): ExternalOutputCommit[] {
    if (text.length === 0) {
      return []
    }

    // Chunk captured stdout into width-bounded row commits so each commit is a
    // small, deterministic append step. This keeps bursty output smooth while
    // preserving newline ownership on the final chunk of each logical row.
    const commits: ExternalOutputCommit[] = []
    // Split commits are row-oriented snapshots. We chunk by renderer width so each
    // commit maps to a single logical terminal row append operation.
    const chunkWidth = Math.max(1, this.width)
    for (const row of this.splitStdoutRows(text)) {
      const rowCells = [...row.line]
      if (rowCells.length === 0) {
        // Preserve empty-line writes: newline-only chunks still need a commit so
        // split scrollback state advances correctly in native code.
        commits.push(this.createStdoutSnapshotCommit("", row.trailingNewline))
        continue
      }

      let offset = 0
      while (offset < rowCells.length) {
        const chunk = rowCells.slice(offset, offset + chunkWidth).join("")
        offset += chunkWidth
        const isLastChunk = offset >= rowCells.length
        // Only the final wrapped chunk carries newline intent.
        commits.push(this.createStdoutSnapshotCommit(chunk, isLastChunk ? row.trailingNewline : false))
      }
    }

    return commits
  }

  private flushPendingSplitCommits(
    forceFooterRepaint: boolean = false,
    drainAll: boolean = false,
  ): "rendered" | "backpressured" | "failed" {
    // Drain only a bounded prefix so one JS render pass maps to one native frame.
    // Remaining commits are intentionally left queued and rendered on subsequent
    // ticks to avoid giant multi-thousand-cell frames that can flicker.
    const commits = this.externalOutputQueue.peek(drainAll ? Number.POSITIVE_INFINITY : this.maxSplitCommitsPerFrame)
    let hasCommittedOutput = false
    const lastCommitIndex = commits.length - 1
    let acceptedCommits = 0
    let nativeBackpressured = false
    let nativeFailed = false

    for (const [index, commit] of commits.entries()) {
      // Force repaint only on the last commit in a frame. Repainting after every
      // chunk negates batching and reintroduces duplicate clear/move traffic.
      const forceCommit = forceFooterRepaint && index === lastCommitIndex
      // beginFrame/finalizeFrame tell native code whether this commit opens or
      // closes the shared frame envelope. Intermediate commits append payload only.
      const beginFrame = index === 0
      const finalizeFrame = index === lastCommitIndex

      // Keep split append policy in native code so every producer (captured stdout
      // and writeToScrollback) shares the same cursor/scrollback invariants.
      const nativeResult = this.lib.commitSplitFooterSnapshot(
        this.rendererPtr,
        commit.snapshot,
        commit.rowColumns,
        commit.startOnNewLine,
        commit.trailingNewline,
        this.getSplitPinnedRenderOffset(),
        forceCommit,
        beginFrame,
        finalizeFrame,
      )
      if (nativeResult.status === NATIVE_RENDER_STATUS_SKIPPED) {
        nativeBackpressured = true
        break
      }

      if (nativeResult.status === NATIVE_RENDER_STATUS_FAILED) {
        nativeFailed = true
        break
      }

      this.renderOffset = nativeResult.renderOffset
      this.recordSplitCommit(commit)
      hasCommittedOutput = true
      acceptedCommits++
    }

    if (acceptedCommits > 0) {
      this.externalOutputQueue.drop(acceptedCommits)
    }

    if (nativeFailed) {
      return this.reportNativeRenderFailure()
    }

    if (nativeBackpressured) {
      this.scheduleRenderAfterFeedIdle()
      return "backpressured"
    }

    if (!hasCommittedOutput) {
      const nativeResult = this.lib.repaintSplitFooter(
        this.rendererPtr,
        this.getSplitPinnedRenderOffset(),
        forceFooterRepaint,
      )
      if (nativeResult.status === NATIVE_RENDER_STATUS_SKIPPED) {
        this.scheduleRenderAfterFeedIdle()
        return "backpressured"
      }
      if (nativeResult.status === NATIVE_RENDER_STATUS_FAILED) {
        return this.reportNativeRenderFailure()
      }
      this.renderOffset = nativeResult.renderOffset
    }

    this.pendingSplitFooterTransition = null

    if (this.externalOutputQueue.size > 0) {
      // Preserve FIFO ordering without doing unbounded work in one tick.
      // This keeps sustained stdout bursts smooth instead of blocking on one frame.
      this.requestRender()
    } else {
      this.applyPendingExternalOutputModeIfReady()
    }

    return "rendered"
  }

  private interceptStdoutWrite = (chunk: any, encoding?: any, callback?: any): boolean => {
    const resolvedCallback = typeof encoding === "function" ? encoding : callback
    const resolvedEncoding = typeof encoding === "string" ? encoding : undefined
    const text = typeof chunk === "string" ? chunk : (chunk?.toString(resolvedEncoding) ?? "")

    if (this._externalOutputMode === "capture-stdout" && this._screenMode === "split-footer" && this._splitHeight > 0) {
      // Capture mode intentionally diverts stdout into split commit snapshots
      // instead of writing directly to process stdout. Native flushing will append
      // and repaint in one controlled frame, which is what avoids footer flicker.
      const commits = this.createStdoutSnapshotCommits(text)
      for (const commit of commits) {
        this.enqueueSplitCommit(commit)
      }

      if (commits.length > 0) {
        // Defer actual terminal writes to the render loop so commits can be batched.
        this.requestRender()
      }
    }

    if (typeof resolvedCallback === "function") {
      process.nextTick(resolvedCallback)
    }

    return true
  }

  private getSplitPinnedRenderOffset(): number {
    return this._screenMode === "split-footer" ? Math.max(this._terminalHeight - this._splitHeight, 0) : 0
  }

  private getSplitCursorSeedRows(): number {
    const cursorState = this.lib.getCursorState(this.rendererPtr)
    const cursorRow = Number.isFinite(cursorState.y) ? Math.max(Math.trunc(cursorState.y), 1) : 1
    return Math.min(cursorRow, Math.max(this._terminalHeight, 1))
  }

  private isSplitCursorSeedFrameBlocked(): boolean {
    return (
      this._screenMode === "split-footer" &&
      this._externalOutputMode === "capture-stdout" &&
      this._splitHeight > 0 &&
      this.pendingSplitStartupCursorSeed &&
      this.splitStartupSeedTimeoutId !== null
    )
  }

  private canFlushSplitOutputBeforeTransition(allowSuspended: boolean = false, allowUnsetup: boolean = false): boolean {
    return (
      (this._terminalIsSetup || allowUnsetup) &&
      (allowSuspended || this._controlState !== RendererControlState.EXPLICIT_SUSPENDED) &&
      !this.isSplitCursorSeedFrameBlocked()
    )
  }

  private clearSplitStartupCursorSeed(): void {
    this.pendingSplitStartupCursorSeed = false
    if (this.splitStartupSeedTimeoutId !== null) {
      this.clock.clearTimeout(this.splitStartupSeedTimeoutId)
      this.splitStartupSeedTimeoutId = null
    }
  }

  private abortSplitStartupCursorSeed(): void {
    this.clearSplitStartupCursorSeed()
    this.stdinParser?.abortPendingStartupCursorCpr()
    this.updateStdinParserProtocolContext({ startupCursorCprActive: false })
  }

  private flushPendingSplitOutputBeforeTransition(
    forceFooterRepaint: boolean = false,
    options: { allowSuspended?: boolean; allowPassthrough?: boolean; allowUnsetup?: boolean } = {},
  ): void {
    const hasDeferredCapturedOutput = this.externalOutputQueue.size > 0 || this.pendingExternalOutputMode !== null
    if (
      this._screenMode !== "split-footer" ||
      this._splitHeight <= 0 ||
      (this._externalOutputMode !== "capture-stdout" && !(options.allowPassthrough && hasDeferredCapturedOutput))
    ) {
      return
    }

    if (!this.canFlushSplitOutputBeforeTransition(options.allowSuspended ?? false, options.allowUnsetup ?? false)) {
      return
    }

    if (this.externalOutputQueue.size === 0 && !forceFooterRepaint) {
      this.applyPendingExternalOutputModeIfReady()
      return
    }

    this.flushPendingSplitCommits(this._externalOutputMode === "capture-stdout" ? forceFooterRepaint : false, true)
  }

  private resetSplitScrollback(seedRows: number = 0): void {
    this.splitTailColumn = 0
    this.renderOffset = this.lib.resetSplitScrollback(this.rendererPtr, seedRows, this.getSplitPinnedRenderOffset())
  }

  private syncSplitScrollback(): void {
    this.renderOffset = this.lib.syncSplitScrollback(this.rendererPtr, this.getSplitPinnedRenderOffset())
  }

  private getSplitOutputOffset(surfaceOffset: number = this.renderOffset): number {
    return this.lib.getSplitOutputOffset(this.rendererPtr, surfaceOffset)
  }

  private clearPendingSplitFooterTransition(): void {
    if (this.pendingSplitFooterTransition === null) {
      return
    }

    this.pendingSplitFooterTransition = null
    this.lib.clearPendingSplitFooterTransition(this.rendererPtr)
  }

  private setPendingSplitFooterTransition(transition: PendingSplitFooterTransition): void {
    this.pendingSplitFooterTransition = transition
    this.lib.setPendingSplitFooterTransition(
      this.rendererPtr,
      transition.mode === "viewport-scroll" ? 1 : 2,
      transition.sourceTopLine,
      transition.sourceHeight,
      transition.targetTopLine,
      transition.targetHeight,
      transition.scrollLines ?? 0,
    )
  }

  private syncSplitFooterState(): void {
    const splitActive = this._screenMode === "split-footer" && this._splitHeight > 0

    if (!splitActive) {
      this.clearPendingSplitFooterTransition()
      this.splitTailColumn = 0
      this.lib.resetSplitScrollback(this.rendererPtr, 0, 0)
      this.renderOffset = 0
      this.lib.setRenderOffset(this.rendererPtr, this.renderOffset)
      return
    }

    if (this._externalOutputMode === "capture-stdout") {
      this.syncSplitScrollback()
    } else {
      this.clearPendingSplitFooterTransition()
      this.splitTailColumn = 0
      this.lib.resetSplitScrollback(this.rendererPtr, 0, 0)
      this.renderOffset = this.getSplitPinnedRenderOffset()
      this.lib.setRenderOffset(this.rendererPtr, this.renderOffset)
    }
  }

  private clearStaleSplitSurfaceRows(
    previousTopLine: number,
    previousHeight: number,
    nextTopLine: number,
    nextHeight: number,
  ): void {
    if (!this._terminalIsSetup || previousHeight <= 0 || this._terminalHeight <= 0) {
      return
    }

    const terminalBottom = this._terminalHeight
    const previousStart = Math.max(1, previousTopLine)
    const previousEnd = Math.min(terminalBottom, previousTopLine + previousHeight - 1)

    if (previousEnd < previousStart) {
      return
    }

    const nextStart = Math.max(1, nextTopLine)
    const nextEnd = Math.min(terminalBottom, nextTopLine + Math.max(nextHeight, 0) - 1)

    let clear = ""
    for (let line = previousStart; line <= previousEnd; line += 1) {
      if (line >= nextStart && line <= nextEnd) {
        continue
      }

      clear += `${ANSI.moveCursor(line, 1)}\x1b[2K`
    }

    if (clear.length > 0) {
      this.writeOut(clear)
    }
  }

  private applyScreenMode(screenMode: ScreenMode, emitResize: boolean = true, requestRender: boolean = true): void {
    const prevScreenMode = this._screenMode
    const prevSplitHeight = this._splitHeight
    const nextGeometry = calculateRenderGeometry(
      screenMode,
      this._terminalWidth,
      this._terminalHeight,
      this._footerHeight,
    )
    const nextSplitHeight = nextGeometry.effectiveFooterHeight

    if (prevScreenMode === screenMode && prevSplitHeight === nextSplitHeight) {
      return
    }

    const terminalWritable = this._terminalIsSetup && this._controlState !== RendererControlState.EXPLICIT_SUSPENDED
    const prevUseAlternateScreen = prevScreenMode === "alternate-screen"
    const nextUseAlternateScreen = screenMode === "alternate-screen"
    const terminalScreenModeChanged = this._terminalIsSetup && prevUseAlternateScreen !== nextUseAlternateScreen
    const leavingSplitFooter = prevSplitHeight > 0 && nextSplitHeight === 0

    if (terminalWritable && prevSplitHeight > 0) {
      this.flushPendingSplitOutputBeforeTransition()
    }

    const previousSurfaceTopLine = this.renderOffset + 1
    const shouldDeferSplitFooterResizeTransition =
      this._terminalIsSetup &&
      prevScreenMode === "split-footer" &&
      screenMode === "split-footer" &&
      this._externalOutputMode === "capture-stdout" &&
      prevSplitHeight > 0 &&
      nextSplitHeight > 0 &&
      !terminalScreenModeChanged
    const splitStartupSeedBlocksFirstNativeFrame =
      this.pendingSplitStartupCursorSeed && this.splitStartupSeedTimeoutId !== null
    const splitTransitionSourceTopLine = this.pendingSplitFooterTransition?.sourceTopLine ?? previousSurfaceTopLine
    const splitTransitionSourceHeight = this.pendingSplitFooterTransition?.sourceHeight ?? prevSplitHeight
    const splitTransitionSourceSurfaceOffset = Math.max(splitTransitionSourceTopLine - 1, 0)
    const splitTransitionSourceOutputOffset =
      prevScreenMode === "split-footer" && prevSplitHeight > 0 && this._externalOutputMode === "capture-stdout"
        ? this.getSplitOutputOffset(splitTransitionSourceSurfaceOffset)
        : splitTransitionSourceSurfaceOffset
    const nextPinnedRenderOffset = nextGeometry.renderOffset
    const nextSplitOutputOffset =
      screenMode === "split-footer" && nextSplitHeight > 0 && this._externalOutputMode === "capture-stdout"
        ? this.getSplitOutputOffset(nextPinnedRenderOffset)
        : nextPinnedRenderOffset
    const pendingSplitFooterTransition = this.pendingSplitFooterTransition
    const pendingSplitFooterReturn =
      pendingSplitFooterTransition !== null && nextSplitHeight === splitTransitionSourceHeight
    const pendingSplitFooterViewportReturn =
      pendingSplitFooterReturn &&
      pendingSplitFooterTransition.mode === "viewport-scroll" &&
      (pendingSplitFooterTransition.scrollLines ?? 0) > 0
    const shrinkingSplitFooter = nextSplitHeight > 0 && nextSplitHeight < splitTransitionSourceHeight
    const growingSplitFooter = nextSplitHeight > splitTransitionSourceHeight && splitTransitionSourceHeight > 0
    const nextSplitSurfaceOffset =
      screenMode !== "split-footer" || nextSplitHeight === 0
        ? 0
        : pendingSplitFooterViewportReturn
          ? pendingSplitFooterTransition.targetTopLine - 1
          : pendingSplitFooterReturn
            ? splitTransitionSourceSurfaceOffset
            : shrinkingSplitFooter && splitTransitionSourceSurfaceOffset > 0
              ? splitTransitionSourceSurfaceOffset
              : shrinkingSplitFooter
                ? nextSplitOutputOffset
                : growingSplitFooter
                  ? Math.max(
                      nextSplitOutputOffset,
                      Math.min(splitTransitionSourceSurfaceOffset, nextPinnedRenderOffset),
                    )
                  : nextPinnedRenderOffset
    const splitTransitionTargetTopLine = nextSplitSurfaceOffset + 1
    const splitViewportScrollLines = pendingSplitFooterViewportReturn
      ? (pendingSplitFooterTransition.scrollLines ?? 0)
      : nextSplitHeight > 0 && !pendingSplitFooterReturn
        ? Math.max(splitTransitionSourceOutputOffset - nextSplitOutputOffset, 0)
        : 0
    const splitTransitionMode =
      (!shrinkingSplitFooter || pendingSplitFooterViewportReturn) && splitViewportScrollLines > 0
        ? "viewport-scroll"
        : "clear-stale-rows"
    const splitFooterSurfaceMovesDown = nextSplitSurfaceOffset > splitTransitionSourceSurfaceOffset
    const splitFooterSurfaceLeavesStaleRows = splitFooterSurfaceMovesDown || shrinkingSplitFooter
    const shouldClearSplitSurfaceRowsImmediately =
      terminalWritable &&
      !terminalScreenModeChanged &&
      !shouldDeferSplitFooterResizeTransition &&
      splitFooterSurfaceLeavesStaleRows &&
      nextSplitHeight > 0

    if (terminalWritable && leavingSplitFooter) {
      this.clearPendingSplitFooterTransition()
      this.renderOffset = 0
      this.lib.setRenderOffset(this.rendererPtr, 0)
    }

    if (terminalWritable && !terminalScreenModeChanged && !shouldDeferSplitFooterResizeTransition) {
      if (prevSplitHeight === 0 && nextSplitHeight > 0) {
        const freedLines = this._terminalHeight - nextSplitHeight
        const scrollDown = ANSI.scrollDown(freedLines)
        this.writeOut(scrollDown)
      } else if (splitViewportScrollLines > 0) {
        const additionalLines = splitViewportScrollLines
        const scrollUp = ANSI.scrollUp(additionalLines)
        this.writeOut(scrollUp)
      }
    }

    this._screenMode = screenMode
    this._splitHeight = nextSplitHeight
    this.width = nextGeometry.renderWidth
    this.height = nextGeometry.renderHeight

    this.lib.resizeRenderer(this.rendererPtr, this.width, this.height)

    if (this._screenMode === "split-footer" && this._externalOutputMode === "capture-stdout") {
      if (prevScreenMode !== "split-footer") {
        this.resetSplitScrollback(this.getSplitCursorSeedRows())
      } else {
        this.renderOffset = nextSplitSurfaceOffset
        this.lib.setRenderOffset(this.rendererPtr, this.renderOffset)
      }

      if (shouldDeferSplitFooterResizeTransition) {
        if (splitStartupSeedBlocksFirstNativeFrame) {
          this.clearPendingSplitFooterTransition()
        } else {
          this.setPendingSplitFooterTransition({
            mode: splitTransitionMode,
            sourceTopLine: splitTransitionSourceTopLine,
            sourceHeight: splitTransitionSourceHeight,
            targetTopLine: splitTransitionTargetTopLine,
            targetHeight: nextSplitHeight,
            scrollLines: splitViewportScrollLines,
          })
        }
        this.forceFullRepaintRequested = true
      } else if (shouldClearSplitSurfaceRowsImmediately) {
        this.clearPendingSplitFooterTransition()
        this.clearStaleSplitSurfaceRows(
          splitTransitionSourceTopLine,
          splitTransitionSourceHeight,
          splitTransitionTargetTopLine,
          nextSplitHeight,
        )
      } else {
        this.clearPendingSplitFooterTransition()
      }
    } else {
      this.syncSplitFooterState()
      if (shouldClearSplitSurfaceRowsImmediately) {
        this.clearStaleSplitSurfaceRows(
          splitTransitionSourceTopLine,
          splitTransitionSourceHeight,
          this.renderOffset + 1,
          nextSplitHeight,
        )
      }
    }

    this.nextRenderBuffer = this.lib.getNextBuffer(this.rendererPtr)
    this.currentRenderBuffer = this.lib.getCurrentBuffer(this.rendererPtr)

    this._console.resize(this.width, this.height)
    this.root.resize(this.width, this.height)

    if (terminalScreenModeChanged) {
      if (terminalWritable) {
        this.lib.suspendRenderer(this.rendererPtr)
        this.lib.setupTerminal(this.rendererPtr, nextUseAlternateScreen)
        this.pendingSuspendedTerminalSetup = false
      } else {
        this.pendingSuspendedTerminalSetup = true
      }

      if (terminalWritable && this._useMouse) {
        this.enableMouse()
      }
    }

    if (emitResize) {
      this.emit(CliRenderEvents.RESIZE, this.width, this.height)
    }

    if (requestRender) {
      this.requestRender()
    }
  }

  // TODO: Move this to native
  private flushStdoutCache(space: number, force: boolean = false): boolean {
    if (this.externalOutputQueue.size === 0 && !force) return false

    const outputCommits = this.externalOutputQueue.claim()
    let output = ""
    for (const commit of outputCommits) {
      output += `[snapshot ${commit.snapshot.width}x${commit.snapshot.height}]\n`
      commit.snapshot.destroy()
    }

    const rendererStartLine = this.renderOffset + 1
    const flush = ANSI.moveCursorAndClear(rendererStartLine, 1)

    const outputLine = this.renderOffset + 1
    const move = ANSI.moveCursor(outputLine, 1)

    let clear = ""
    if (space > 0) {
      const backgroundColor = this.backgroundColor.toInts()
      const newlines = " ".repeat(this.width) + "\n".repeat(space)
      // Check if background is transparent (alpha = 0)
      if (backgroundColor[3] === 0) {
        clear = newlines
      } else {
        clear =
          ANSI.setRgbBackground(backgroundColor[0], backgroundColor[1], backgroundColor[2]) +
          newlines +
          ANSI.resetBackground
      }
    }

    this.writeOut(flush + move + output + clear)

    return true
  }

  private enableMouse(): void {
    this._useMouse = true
    this.lib.enableMouse(this.rendererPtr, this.enableMouseMovement)
  }

  private disableMouse(): void {
    this._useMouse = false
    this.setCapturedRenderable(undefined)
    this.stdinParser?.resetMouseState()
    this.lib.disableMouse(this.rendererPtr)
  }

  public enableKittyKeyboard(flags: number = 0b00011): void {
    this.lib.enableKittyKeyboard(this.rendererPtr, flags)
    this.updateStdinParserProtocolContext({ kittyKeyboardEnabled: true })
  }

  public disableKittyKeyboard(): void {
    this.lib.disableKittyKeyboard(this.rendererPtr)
    this.updateStdinParserProtocolContext({ kittyKeyboardEnabled: false }, true)
  }

  public set useThread(useThread: boolean) {
    this._useThread = useThread
    this.lib.setUseThread(this.rendererPtr, useThread)
  }

  // TODO: All input management may move to native when zig finally has async io support again,
  // without rolling a full event loop
  public async setupTerminal(): Promise<void> {
    if (this._terminalIsSetup) return
    this._terminalIsSetup = true

    const startupCursorCprActive = this._screenMode === "split-footer" && this._externalOutputMode === "capture-stdout"
    this.updateStdinParserProtocolContext({
      privateCapabilityRepliesActive: true,
      explicitWidthCprActive: true,
      startupCursorCprActive,
    })
    this.lib.setupTerminal(this.rendererPtr, this._screenMode === "alternate-screen")
    this._capabilities = this.lib.getTerminalCapabilities(this.rendererPtr)

    if (this.debugOverlay.enabled) {
      this.lib.setDebugOverlay(this.rendererPtr, true, this.debugOverlay.corner)
      if (!this.memorySnapshotInterval) {
        this.memorySnapshotInterval = 3000
        this.startMemorySnapshotTimer()
        this.automaticMemorySnapshot = true
      }
    }

    this.capabilityTimeoutId = this.clock.setTimeout(() => {
      this.capabilityTimeoutId = null
      this.clearSplitStartupCursorSeed()

      if (this._screenMode === "split-footer" && this._externalOutputMode === "capture-stdout") {
        this.requestRender()
      }

      this.removeInputHandler(this.capabilityHandler)
      this.updateStdinParserProtocolContext(
        {
          privateCapabilityRepliesActive: false,
          explicitWidthCprActive: false,
          startupCursorCprActive: false,
        },
        true,
      )
      this.resolveXtVersionWaiters()
    }, 5000)

    if (this._useMouse) {
      this.enableMouse()
    }

    if (this._screenMode === "split-footer" && this._externalOutputMode === "capture-stdout") {
      this.pendingSplitStartupCursorSeed = true

      if (this.splitStartupSeedTimeoutId !== null) {
        this.clock.clearTimeout(this.splitStartupSeedTimeoutId)
      }

      this.splitStartupSeedTimeoutId = this.clock.setTimeout(() => {
        this.splitStartupSeedTimeoutId = null

        if (!this.pendingSplitStartupCursorSeed) {
          return
        }

        this.updateStdinParserProtocolContext({ startupCursorCprActive: false })

        if (this._screenMode === "split-footer" && this._externalOutputMode === "capture-stdout") {
          this.requestRender()
        }

        this.flushPendingSplitOutputBeforeTransition(false, { allowPassthrough: true })
      }, 120)
    }

    this.queryPixelResolution()
    if (this.shouldSyncNativePaletteState()) {
      this.refreshPalette()
    }

    // Feed-backed startup writes are async relative to the JS Writable. Wait
    // until they drain so callers can safely destroy immediately after
    // createCliRenderer() resolves.
    if (this._feed?.isBackpressured()) {
      await this._feed.idle()
    }
  }

  private stdinListener: (chunk: Buffer | string) => void = ((chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (!this.stdinParser) return

    try {
      this.stdinParser.push(data)
      this.drainStdinParser()
    } catch (error) {
      this.handleStdinParserFailure(error)
    }
  }).bind(this)

  public addInputHandler(handler: (sequence: string) => boolean): void {
    this.sequenceHandlers.push(handler)
  }

  public prependInputHandler(handler: (sequence: string) => boolean): void {
    this.sequenceHandlers.unshift(handler)
  }

  public removeInputHandler(handler: (sequence: string) => boolean): void {
    this.sequenceHandlers = this.sequenceHandlers.filter((candidate) => candidate !== handler)
  }

  private updateStdinParserProtocolContext(patch: Partial<StdinParserProtocolContext>, drain = false): void {
    if (!this.stdinParser) return
    this.stdinParser.updateProtocolContext(patch)
    if (drain) this.drainStdinParser()
  }

  public subscribeOsc(handler: (sequence: string) => void): () => void {
    this.oscSubscribers.add(handler)
    return () => {
      this.oscSubscribers.delete(handler)
    }
  }

  private processCapabilitySequence(sequence: string, hasCursorReport: boolean): boolean {
    const hasStandardCapabilitySignature = isCapabilityResponse(sequence)
    const shouldProcessAsCapability =
      hasStandardCapabilitySignature || (hasCursorReport && this.capabilityTimeoutId !== null)

    if (!shouldProcessAsCapability) {
      return false
    }

    this.lib.processCapabilityResponse(this.rendererPtr, sequence)
    this._capabilities = this.lib.getTerminalCapabilities(this.rendererPtr)
    if (this._capabilities?.terminal?.from_xtversion) {
      this.resolveXtVersionWaiters()
    }
    if (hasStandardCapabilitySignature) {
      this.forceFullRepaintRequested = true
      this.requestRender()
    }
    this.emit(CliRenderEvents.CAPABILITIES, this._capabilities)

    const hadPendingSplitStartupCursorSeed = this.pendingSplitStartupCursorSeed

    if (
      hadPendingSplitStartupCursorSeed &&
      hasCursorReport &&
      this._screenMode === "split-footer" &&
      this._externalOutputMode === "capture-stdout"
    ) {
      this.resetSplitScrollback(this.getSplitCursorSeedRows())
      this.clearPendingSplitFooterTransition()
      this.clearSplitStartupCursorSeed()
      this.updateStdinParserProtocolContext({ startupCursorCprActive: false })

      this.requestRender()
      if (this.pendingExternalOutputMode === "passthrough") {
        this.flushPendingSplitOutputBeforeTransition()
      }
    }

    const consumeStartupCursorReport =
      hadPendingSplitStartupCursorSeed && hasCursorReport && this.splitStartupSeedTimeoutId !== null

    return hasStandardCapabilitySignature || consumeStartupCursorReport
  }

  private capabilityHandler: (sequence: string) => boolean = ((sequence: string) => {
    return this.processCapabilitySequence(sequence, false)
  }).bind(this)

  private focusHandler: (sequence: string) => boolean = ((sequence: string) => {
    if (sequence === "\x1b[I") {
      // When the terminal regains focus, some terminal emulators (notably
      // Windows Terminal / ConPTY) may have stripped DEC private modes like
      // mouse tracking, bracketed paste, and focus tracking itself while the
      // window was unfocused.
      if (this.shouldRestoreModesOnNextFocus) {
        this.lib.restoreTerminalModes(this.rendererPtr)
        this.shouldRestoreModesOnNextFocus = false
      }
      if (this._terminalFocusState !== true) {
        this._terminalFocusState = true
        this.emit(CliRenderEvents.FOCUS)
      }
      return true
    }
    if (sequence === "\x1b[O") {
      this.shouldRestoreModesOnNextFocus = true
      if (this._terminalFocusState !== false) {
        this._terminalFocusState = false
        this.emit(CliRenderEvents.BLUR)
      }
      return true
    }
    return false
  }).bind(this)

  private dispatchSequenceHandlers(sequence: string): boolean {
    if (this._debugModeEnabled) {
      this._debugInputs.push({
        timestamp: new Date().toISOString(),
        sequence,
      })
    }

    for (const handler of this.sequenceHandlers) {
      if (handler(sequence)) {
        return true
      }
    }

    return false
  }

  private drainStdinParser(): void {
    if (!this.stdinParser) return

    this.stdinParser.drain((event) => {
      this.handleStdinEvent(event)
    })
  }

  private handleStdinEvent(event: StdinEvent): void {
    switch (event.type) {
      case "key":
        if (this.dispatchSequenceHandlers(event.raw)) {
          return
        }

        this._keyHandler.processParsedKey(event.key)
        return
      case "mouse":
        if (this._useMouse && this.processSingleMouseEvent(event.event)) {
          return
        }

        this.dispatchSequenceHandlers(event.raw)
        return
      case "paste":
        this._keyHandler.processPaste(event.bytes, event.metadata)
        return
      case "response":
        if (event.protocol === "osc") {
          for (const subscriber of this.oscSubscribers) {
            subscriber(event.sequence)
          }
        }

        if (event.protocol === "cpr" && this.processCapabilitySequence(event.sequence, true)) {
          return
        }

        this.dispatchSequenceHandlers(event.sequence)
        return
    }
  }

  private handleStdinParserFailure(error: unknown): void {
    if (!this.hasLoggedStdinParserError) {
      this.hasLoggedStdinParserError = true
      if (process.env.NODE_ENV !== "test") {
        console.error("[stdin-parser-error] parser failure, resetting parser", error)
      }
    }

    try {
      this.stdinParser?.reset()
    } catch (resetError) {
      console.error("stdin parser reset failed after parser error", resetError)
    }
  }

  private setupInput(): void {
    for (const handler of this.prependedInputHandlers) {
      this.addInputHandler(handler)
    }

    this.addInputHandler((sequence: string) => {
      if (isPixelResolutionResponse(sequence) && this.waitingForPixelResolution) {
        const resolution = parsePixelResolution(sequence)
        if (resolution) {
          this._resolution = resolution
        }
        this.waitingForPixelResolution = false
        this.updateStdinParserProtocolContext({ pixelResolutionQueryActive: false }, true)
        return true
      }
      return false
    })
    this.addInputHandler(this.capabilityHandler)
    this.addInputHandler(this.focusHandler)
    this.addInputHandler(this.themeModeHandler)

    if (this.stdin.setRawMode) {
      this.stdin.setRawMode(true)
    }

    this.stdin.on("data", this.stdinListener)
    this.stdin.resume()
  }

  private dispatchMouseEvent(
    target: Renderable,
    attributes: RawMouseEvent & { source?: Renderable; isDragging?: boolean },
  ): MouseEvent {
    const event = new MouseEvent(target, attributes)
    target.processMouseEvent(event)

    if (this.autoFocus && event.type === "down" && event.button === MouseButton.LEFT && !event.defaultPrevented) {
      let current: Renderable | null = target
      while (current) {
        if (current.focusable) {
          current.focus()
          break
        }
        current = current.parent
      }
    }

    return event
  }

  private processSingleMouseEvent(mouseEvent: RawMouseEvent): boolean {
    if (this._splitHeight > 0) {
      if (mouseEvent.y < this.renderOffset) {
        return false
      }
      mouseEvent.y -= this.renderOffset
    }

    this._latestPointer.x = mouseEvent.x
    this._latestPointer.y = mouseEvent.y
    this._hasPointer = true
    this._lastPointerModifiers = mouseEvent.modifiers

    if (this._console.visible) {
      const consoleBounds = this._console.bounds
      if (
        mouseEvent.x >= consoleBounds.x &&
        mouseEvent.x < consoleBounds.x + consoleBounds.width &&
        mouseEvent.y >= consoleBounds.y &&
        mouseEvent.y < consoleBounds.y + consoleBounds.height
      ) {
        const event = new MouseEvent(null, mouseEvent)
        const handled = this._console.handleMouse(event)
        if (handled) return true
      }
    }

    if (mouseEvent.type === "scroll") {
      const maybeRenderableId = this.hitTest(mouseEvent.x, mouseEvent.y)
      const maybeRenderable = Renderable.renderablesByNumber.get(maybeRenderableId)
      const fallbackTarget =
        this._currentFocusedRenderable &&
        !this._currentFocusedRenderable.isDestroyed &&
        this._currentFocusedRenderable.focused
          ? this._currentFocusedRenderable
          : null
      const scrollTarget = maybeRenderable ?? fallbackTarget

      if (scrollTarget) {
        const event = new MouseEvent(scrollTarget, mouseEvent)
        scrollTarget.processMouseEvent(event)
      }
      return true
    }

    const maybeRenderableId = this.hitTest(mouseEvent.x, mouseEvent.y)
    const sameElement = maybeRenderableId === this.lastOverRenderableNum
    this.lastOverRenderableNum = maybeRenderableId
    const maybeRenderable = Renderable.renderablesByNumber.get(maybeRenderableId)

    if (
      mouseEvent.type === "down" &&
      mouseEvent.button === MouseButton.LEFT &&
      !this.currentSelection?.isDragging &&
      !mouseEvent.modifiers.ctrl
    ) {
      const canStartSelection = Boolean(
        maybeRenderable &&
        maybeRenderable.selectable &&
        !maybeRenderable.isDestroyed &&
        maybeRenderable.shouldStartSelection(mouseEvent.x, mouseEvent.y),
      )

      if (canStartSelection && maybeRenderable) {
        this.startSelection(maybeRenderable, mouseEvent.x, mouseEvent.y)
        this.dispatchMouseEvent(maybeRenderable, mouseEvent)
        return true
      }
    }

    if (mouseEvent.type === "drag" && this.currentSelection?.isDragging) {
      this.updateSelection(maybeRenderable, mouseEvent.x, mouseEvent.y)

      if (maybeRenderable) {
        const event = new MouseEvent(maybeRenderable, {
          ...mouseEvent,
          isDragging: true,
        })
        maybeRenderable.processMouseEvent(event)
      }

      return true
    }

    if (mouseEvent.type === "up" && this.currentSelection?.isDragging) {
      if (maybeRenderable) {
        const event = new MouseEvent(maybeRenderable, {
          ...mouseEvent,
          isDragging: true,
        })
        maybeRenderable.processMouseEvent(event)
      }

      this.finishSelection()
      return true
    }

    if (mouseEvent.type === "down" && mouseEvent.button === MouseButton.LEFT && this.currentSelection) {
      if (mouseEvent.modifiers.ctrl) {
        this.currentSelection.isDragging = true
        this.updateSelection(maybeRenderable, mouseEvent.x, mouseEvent.y)
        return true
      }
    }

    if (!sameElement && (mouseEvent.type === "drag" || mouseEvent.type === "move")) {
      if (
        this.lastOverRenderable &&
        this.lastOverRenderable !== this.capturedRenderable &&
        !this.lastOverRenderable.isDestroyed
      ) {
        const event = new MouseEvent(this.lastOverRenderable, {
          ...mouseEvent,
          type: "out",
        })
        this.lastOverRenderable.processMouseEvent(event)
      }
      this.lastOverRenderable = maybeRenderable
      if (maybeRenderable) {
        const event = new MouseEvent(maybeRenderable, {
          ...mouseEvent,
          type: "over",
          source: this.capturedRenderable,
        })
        maybeRenderable.processMouseEvent(event)
      }
    }

    if (this.capturedRenderable && mouseEvent.type !== "up") {
      const event = new MouseEvent(this.capturedRenderable, mouseEvent)
      this.capturedRenderable.processMouseEvent(event)
      return true
    }

    if (this.capturedRenderable && mouseEvent.type === "up") {
      const event = new MouseEvent(this.capturedRenderable, {
        ...mouseEvent,
        type: "drag-end",
      })
      this.capturedRenderable.processMouseEvent(event)
      this.capturedRenderable.processMouseEvent(new MouseEvent(this.capturedRenderable, mouseEvent))
      if (maybeRenderable) {
        const event = new MouseEvent(maybeRenderable, {
          ...mouseEvent,
          type: "drop",
          source: this.capturedRenderable,
        })
        maybeRenderable.processMouseEvent(event)
      }
      this.lastOverRenderable = this.capturedRenderable
      this.lastOverRenderableNum = this.capturedRenderable.num
      this.setCapturedRenderable(undefined)
      // Dropping the renderable needs to push another frame when the renderer is not live
      // to update the hit grid, otherwise capturedRenderable won't be in the hit grid and will not receive mouse events
      this.requestRender()
    }

    let event: MouseEvent | undefined
    if (maybeRenderable) {
      if (mouseEvent.type === "drag" && mouseEvent.button === MouseButton.LEFT) {
        this.setCapturedRenderable(maybeRenderable)
      } else {
        this.setCapturedRenderable(undefined)
      }
      event = this.dispatchMouseEvent(maybeRenderable, mouseEvent)
    } else {
      this.setCapturedRenderable(undefined)
      this.lastOverRenderable = undefined
    }

    if (!event?.defaultPrevented && mouseEvent.type === "down" && this.currentSelection) {
      this.clearSelection()
    }

    return true
  }

  /**
   * Recheck hover state after hit grid changes.
   * Called after render when native code detects the hit grid changed.
   * Fires out/over events if the element under the cursor changed.
   */
  private recheckHoverState(): void {
    if (this._isDestroyed || !this._hasPointer) return
    if (this.capturedRenderable) return

    const hitId = this.hitTest(this._latestPointer.x, this._latestPointer.y)
    const hitRenderable = Renderable.renderablesByNumber.get(hitId)
    const lastOver = this.lastOverRenderable

    // No change
    if (lastOver?.num === hitId) {
      this.lastOverRenderableNum = hitId
      return
    }

    const baseEvent: RawMouseEvent = {
      type: "move",
      button: 0,
      x: this._latestPointer.x,
      y: this._latestPointer.y,
      modifiers: this._lastPointerModifiers,
    }

    // Fire out on old element
    if (lastOver && !lastOver.isDestroyed) {
      const event = new MouseEvent(lastOver, { ...baseEvent, type: "out" })
      lastOver.processMouseEvent(event)
    }

    this.lastOverRenderable = hitRenderable
    this.lastOverRenderableNum = hitId

    // Fire over on new element
    if (hitRenderable) {
      const event = new MouseEvent(hitRenderable, {
        ...baseEvent,
        type: "over",
      })
      hitRenderable.processMouseEvent(event)
    }
  }
  public setMousePointer(style: MousePointerStyle): void {
    this._currentMousePointerStyle = style
    this.lib.setCursorStyleOptions(this.rendererPtr, { cursor: style })
  }

  public hitTest(x: number, y: number): number {
    return this.lib.checkHit(this.rendererPtr, x, y)
  }

  private takeMemorySnapshot(): void {
    if (this._isDestroyed) return

    const memoryUsage = process.memoryUsage()
    this.lastMemorySnapshot = {
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      arrayBuffers: memoryUsage.arrayBuffers,
    }

    this.lib.updateMemoryStats(
      this.rendererPtr,
      this.lastMemorySnapshot.heapUsed,
      this.lastMemorySnapshot.heapTotal,
      this.lastMemorySnapshot.arrayBuffers,
    )

    this.emit(CliRenderEvents.MEMORY_SNAPSHOT, this.lastMemorySnapshot)
  }

  private startMemorySnapshotTimer(): void {
    this.stopMemorySnapshotTimer()

    this.memorySnapshotTimer = this.clock.setInterval(() => {
      this.takeMemorySnapshot()
    }, this.memorySnapshotInterval)
  }

  private stopMemorySnapshotTimer(): void {
    if (this.memorySnapshotTimer) {
      this.clock.clearInterval(this.memorySnapshotTimer)
      this.memorySnapshotTimer = null
    }
  }

  public setMemorySnapshotInterval(interval: number): void {
    this.memorySnapshotInterval = interval

    if (this._isRunning && interval > 0) {
      this.startMemorySnapshotTimer()
    } else if (interval <= 0 && this.memorySnapshotTimer) {
      this.clock.clearInterval(this.memorySnapshotTimer)
      this.memorySnapshotTimer = null
    }
  }

  private handleResize(width: number, height: number): void {
    if (this._isDestroyed) return
    if (this._splitHeight > 0) {
      this.processResize(width, height)
      return
    }

    if (this.resizeTimeoutId !== null) {
      this.clock.clearTimeout(this.resizeTimeoutId)
      this.resizeTimeoutId = null
    }

    this.resizeTimeoutId = this.clock.setTimeout(() => {
      this.resizeTimeoutId = null
      this.processResize(width, height)
    }, this.resizeDebounceDelay)
  }

  private queryPixelResolution() {
    this.waitingForPixelResolution = true
    this.updateStdinParserProtocolContext({ pixelResolutionQueryActive: true })
    this.lib.queryPixelResolution(this.rendererPtr)
  }

  private processResize(width: number, height: number): void {
    if (width === this._terminalWidth && height === this._terminalHeight) return

    if (
      this._terminalIsSetup &&
      this._controlState !== RendererControlState.EXPLICIT_SUSPENDED &&
      !this.isSplitCursorSeedFrameBlocked()
    ) {
      this.flushPendingSplitOutputBeforeTransition()
    }

    const pendingSplitFooterTransition = this.pendingSplitFooterTransition
    const previousGeometry = calculateRenderGeometry(
      this._screenMode,
      this._terminalWidth,
      this._terminalHeight,
      this._footerHeight,
    )
    const prevWidth = this._terminalWidth
    const previousTerminalHeight = this._terminalHeight
    const visiblePreviousSplitHeight =
      pendingSplitFooterTransition?.sourceHeight ?? previousGeometry.effectiveFooterHeight

    this._terminalWidth = width
    this._terminalHeight = height
    this.queryPixelResolution()

    this.setCapturedRenderable(undefined)
    this.stdinParser?.resetMouseState()

    const nextGeometry = calculateRenderGeometry(
      this._screenMode,
      this._terminalWidth,
      this._terminalHeight,
      this._footerHeight,
    )
    const splitFooterActive = this._screenMode === "split-footer"

    if (splitFooterActive) {
      // Width shrink historically needs a broader scrub band, but if resize interrupts
      // a deferred footer transition we also need to clear from that visible source surface.
      let clearStart: number | null = null

      if (width < prevWidth && visiblePreviousSplitHeight > 0) {
        clearStart = Math.max(previousTerminalHeight - visiblePreviousSplitHeight * 2, 1)
      }

      if (pendingSplitFooterTransition !== null) {
        clearStart =
          clearStart === null
            ? pendingSplitFooterTransition.sourceTopLine
            : Math.min(clearStart, pendingSplitFooterTransition.sourceTopLine)
      }

      if (clearStart !== null) {
        const flush = ANSI.moveCursorAndClear(clearStart, 1)
        this.writeOut(flush)
      }

      this.currentRenderBuffer.clear(this.backgroundColor)
    }

    this.clearPendingSplitFooterTransition()

    this._splitHeight = nextGeometry.effectiveFooterHeight
    this.width = nextGeometry.renderWidth
    this.height = nextGeometry.renderHeight

    this.lib.resizeRenderer(this.rendererPtr, this.width, this.height)

    if (this._screenMode === "split-footer" && this._externalOutputMode === "capture-stdout") {
      this.syncSplitScrollback()
    } else {
      this.syncSplitFooterState()
    }

    this.nextRenderBuffer = this.lib.getNextBuffer(this.rendererPtr)
    this.currentRenderBuffer = this.lib.getCurrentBuffer(this.rendererPtr)
    this._console.resize(this.width, this.height)
    this.root.resize(this.width, this.height)
    this.emit(CliRenderEvents.RESIZE, this.width, this.height)
    this.requestRender()
  }

  /**
   * Programmatically resize the renderer to new dimensions.
   *
   * Use this for externally-driven resize events — for example, an SSH
   * `window-change` signal or a test harness simulating a terminal resize.
   * When the renderer is attached to `process.stdout`, `SIGWINCH` is handled
   * automatically and callers do not need this method.
   */
  public resize(width: number, height: number): void {
    if (this._isDestroyed) return
    this.processResize(width, height)
  }

  public setBackgroundColor(color: ColorInput): void {
    const parsedColor = parseColor(color)
    this.lib.setBackgroundColor(this.rendererPtr, parsedColor as RGBA)
    this.backgroundColor = parsedColor as RGBA
    this.nextRenderBuffer.clear(parsedColor as RGBA)
    this.requestRender()
  }

  public toggleDebugOverlay(): void {
    const willBeEnabled = !this.debugOverlay.enabled

    if (willBeEnabled && !this.memorySnapshotInterval) {
      this.memorySnapshotInterval = 3000
      this.startMemorySnapshotTimer()
      this.automaticMemorySnapshot = true
    } else if (!willBeEnabled && this.automaticMemorySnapshot) {
      this.stopMemorySnapshotTimer()
      this.memorySnapshotInterval = 0
      this.automaticMemorySnapshot = false
    }

    this.debugOverlay.enabled = !this.debugOverlay.enabled
    this.lib.setDebugOverlay(this.rendererPtr, this.debugOverlay.enabled, this.debugOverlay.corner)
    this.emit(CliRenderEvents.DEBUG_OVERLAY_TOGGLE, this.debugOverlay.enabled)
    this.requestRender()
  }

  public configureDebugOverlay(options: { enabled?: boolean; corner?: DebugOverlayCorner }): void {
    this.debugOverlay.enabled = options.enabled ?? this.debugOverlay.enabled
    this.debugOverlay.corner = options.corner ?? this.debugOverlay.corner
    this.lib.setDebugOverlay(this.rendererPtr, this.debugOverlay.enabled, this.debugOverlay.corner)
    this.requestRender()
  }

  public setTerminalTitle(title: string): void {
    this.lib.setTerminalTitle(this.rendererPtr, title)
  }

  /**
   * Reset the terminal background color to its default via OSC 111.
   * Called automatically by destroy() and suspend(), but exposed for
   * consumers that need explicit control (e.g. before SIGTSTP).
   */
  public resetTerminalBgColor(): void {
    this.writeOut("\x1b]111\x07")
  }

  public copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean {
    return this.clipboard.copyToClipboardOSC52(text, target)
  }

  public clearClipboardOSC52(target?: ClipboardTarget): boolean {
    return this.clipboard.clearClipboardOSC52(target)
  }

  public isOsc52Supported(): boolean {
    return this._capabilities?.osc52 ?? this.clipboard.isOsc52Supported()
  }

  public dumpHitGrid(): void {
    this.lib.dumpHitGrid(this.rendererPtr)
  }

  public dumpBuffers(timestamp?: number): void {
    this.lib.dumpBuffers(this.rendererPtr, timestamp)
  }

  public dumpOutputBuffer(timestamp?: number): void {
    this.lib.dumpOutputBuffer(this.rendererPtr, timestamp)
  }

  public static setCursorPosition(renderer: CliRenderer, x: number, y: number, visible: boolean = true): void {
    const lib = resolveRenderLib()
    lib.setCursorPosition(renderer.rendererPtr, x, y, visible)
  }

  public static setCursorStyle(renderer: CliRenderer, options: CursorStyleOptions): void {
    const lib = resolveRenderLib()
    lib.setCursorStyleOptions(renderer.rendererPtr, options)
    if (options.cursor !== undefined) {
      renderer._currentMousePointerStyle = options.cursor
    }
  }

  public static setCursorColor(renderer: CliRenderer, color: RGBA): void {
    const lib = resolveRenderLib()
    lib.setCursorColor(renderer.rendererPtr, color)
  }

  public setCursorPosition(x: number, y: number, visible: boolean = true): void {
    this.lib.setCursorPosition(this.rendererPtr, x, y, visible)
  }

  public setCursorStyle(options: CursorStyleOptions): void {
    this.lib.setCursorStyleOptions(this.rendererPtr, options)
    if (options.cursor !== undefined) {
      this._currentMousePointerStyle = options.cursor
    }
  }

  public setCursorColor(color: RGBA): void {
    this.lib.setCursorColor(this.rendererPtr, color)
  }

  public getCursorState() {
    return this.lib.getCursorState(this.rendererPtr)
  }

  public addPostProcessFn(processFn: (buffer: OptimizedBuffer, deltaTime: number) => void): void {
    this.postProcessFns.push(processFn)
  }

  public removePostProcessFn(processFn: (buffer: OptimizedBuffer, deltaTime: number) => void): void {
    this.postProcessFns = this.postProcessFns.filter((fn) => fn !== processFn)
  }

  public clearPostProcessFns(): void {
    this.postProcessFns = []
  }

  public setFrameCallback(callback: (deltaTime: number) => Promise<void>): void {
    this.frameCallbacks.push(callback)
  }

  public removeFrameCallback(callback: (deltaTime: number) => Promise<void>): void {
    this.frameCallbacks = this.frameCallbacks.filter((cb) => cb !== callback)
  }

  public clearFrameCallbacks(): void {
    this.frameCallbacks = []
  }

  public requestLive(): void {
    this.liveRequestCounter++

    if (this._controlState === RendererControlState.IDLE && this.liveRequestCounter > 0) {
      this._controlState = RendererControlState.AUTO_STARTED
      this.internalStart()
    }
  }

  public dropLive(): void {
    this.liveRequestCounter = Math.max(0, this.liveRequestCounter - 1)

    if (this._controlState === RendererControlState.AUTO_STARTED && this.liveRequestCounter === 0) {
      this._controlState = RendererControlState.IDLE
      this.internalPause()
    }
  }

  public start(): void {
    this._controlState = RendererControlState.EXPLICIT_STARTED
    this.internalStart()
  }

  public auto(): void {
    this._controlState = this._isRunning ? RendererControlState.AUTO_STARTED : RendererControlState.IDLE
  }

  private internalStart(): void {
    if (!this._isRunning && !this._isDestroyed) {
      this._isRunning = true

      // Invalidate any queued idle one-shot frame.
      // start()/live/resume transition to the continuous loop, so queued
      // activateFrame callbacks must no-op via !updateScheduled.
      this.updateScheduled = false

      if (this.memorySnapshotInterval > 0) {
        this.startMemorySnapshotTimer()
      }

      this.startRenderLoop()
    }
  }

  public pause(): void {
    this._controlState = RendererControlState.EXPLICIT_PAUSED
    this.internalPause()
  }

  public suspend(): void {
    this._previousControlState = this._controlState

    this._controlState = RendererControlState.EXPLICIT_SUSPENDED
    this.updateScheduled = false
    this.internalPause()

    if (this._terminalIsSetup) {
      this.clearSplitStartupCursorSeed()
      this.flushPendingSplitOutputBeforeTransition(true, { allowSuspended: true })
      this.suspendedNonAltSurfacePreserved = this._screenMode !== "alternate-screen" && this.renderOffset > 0
    } else {
      this.suspendedNonAltSurfacePreserved = false
    }

    this._suspendedMouseEnabled = this._useMouse

    this.disableMouse()
    this.removeExitListeners()
    this.waitingForPixelResolution = false
    this.updateStdinParserProtocolContext({
      privateCapabilityRepliesActive: false,
      pixelResolutionQueryActive: false,
      explicitWidthCprActive: false,
      startupCursorCprActive: false,
    })
    this.stdinParser?.reset()
    this.stdin.removeListener("data", this.stdinListener)

    this.themeModeState.cancelRefresh()

    this.lib.suspendRenderer(this.rendererPtr)

    if (this.stdin.setRawMode) {
      this.stdin.setRawMode(false)
    }

    this.stdin.pause()
  }

  public resume(): void {
    if (this.stdin.setRawMode) {
      this.stdin.setRawMode(true)
    }

    // Drain any input buffered during suspension before registering the
    // listener. Adding a "data" listener can auto-resume a Readable, so the
    // drain must come first while the stream is still paused and read()
    // pulls from the internal buffer rather than being a flowing-mode no-op.
    while (this.stdin.read() !== null) {}
    this.stdin.on("data", this.stdinListener)
    this.stdin.resume()
    this.addExitListeners()

    const resumePreservedNonAltSurface =
      this.pendingSuspendedTerminalSetup &&
      this._screenMode !== "alternate-screen" &&
      this.suspendedNonAltSurfacePreserved &&
      this.renderOffset > 0

    if (this.pendingSuspendedTerminalSetup) {
      this.pendingSuspendedTerminalSetup = false
      if (resumePreservedNonAltSurface) {
        this.lib.resumeRenderer(this.rendererPtr)
      } else {
        this.lib.setupTerminal(this.rendererPtr, this._screenMode === "alternate-screen")
      }
    } else {
      this.lib.resumeRenderer(this.rendererPtr)
    }

    this.suspendedNonAltSurfacePreserved = false

    this.flushPendingSplitOutputBeforeTransition(false, { allowSuspended: true, allowPassthrough: true })

    if (this._screenMode === "split-footer" && this._splitHeight > 0) {
      this.syncSplitFooterState()
    }

    if (this._suspendedMouseEnabled) {
      this.enableMouse()
    }

    this.forceFullRepaintRequested = true
    this._controlState = this._previousControlState

    if (
      this._previousControlState === RendererControlState.AUTO_STARTED ||
      this._previousControlState === RendererControlState.EXPLICIT_STARTED
    ) {
      this.internalStart()
    } else {
      this.requestRender()
    }
  }

  private internalPause(): void {
    this._isRunning = false

    if (this.renderTimeout) {
      this.clock.clearTimeout(this.renderTimeout)
      this.renderTimeout = null
    }

    if (!this.rendering) {
      this.resolveIdleIfNeeded()
    }
  }

  public stop(): void {
    this._controlState = RendererControlState.EXPLICIT_STOPPED
    this.internalStop()
  }

  private internalStop(): void {
    if (this.isRunning && !this._isDestroyed) {
      this._isRunning = false

      if (this.memorySnapshotTimer) {
        this.clock.clearInterval(this.memorySnapshotTimer)
        this.memorySnapshotTimer = null
      }

      if (this.renderTimeout) {
        this.clock.clearTimeout(this.renderTimeout)
        this.renderTimeout = null
      }

      // If we're currently rendering, the frame will resolve idle when it completes
      // Otherwise, resolve immediately
      if (!this.rendering) {
        this.resolveIdleIfNeeded()
      }
    }
  }

  public destroy(): void {
    if (this._isDestroyed) return
    this._isDestroyed = true
    this._destroyPending = true
    this._palettePublishGeneration++

    if (this.rendering) {
      // Restore terminal/input state immediately, but defer full native teardown until the frame unwinds.
      this.prepareDestroyDuringRender()
      return
    }

    this.finalizeDestroy()
  }

  private cleanupBeforeDestroy(): void {
    if (this._destroyCleanupPrepared) return
    this._destroyCleanupPrepared = true

    if (this._usesProcessStdout) {
      process.removeListener("SIGWINCH", this.sigwinchHandler)
    }
    process.removeListener("uncaughtException", this.handleError)
    process.removeListener("unhandledRejection", this.handleError)
    process.removeListener("warning", this.warningHandler)
    process.removeListener("beforeExit", this.exitHandler)
    this.removeExitListeners()

    if (this.resizeTimeoutId !== null) {
      this.clock.clearTimeout(this.resizeTimeoutId)
      this.resizeTimeoutId = null
    }

    if (this.capabilityTimeoutId !== null) {
      this.clock.clearTimeout(this.capabilityTimeoutId)
      this.capabilityTimeoutId = null
    }

    this.clearSplitStartupCursorSeed()

    if (this.memorySnapshotTimer) {
      this.clock.clearInterval(this.memorySnapshotTimer)
      this.memorySnapshotTimer = null
    }

    if (this.renderTimeout) {
      this.clock.clearTimeout(this.renderTimeout)
      this.renderTimeout = null
    }

    this.themeModeState.cancelRefresh()

    this._isRunning = false
    this.waitingForPixelResolution = false
    this.updateStdinParserProtocolContext(
      {
        privateCapabilityRepliesActive: false,
        pixelResolutionQueryActive: false,
        explicitWidthCprActive: false,
        startupCursorCprActive: false,
      },
      true,
    )
    this._useMouse = false
    this.setCapturedRenderable(undefined)

    this.stdin.removeListener("data", this.stdinListener)
    if (this.stdin.setRawMode) {
      try {
        this.stdin.setRawMode(false)
      } catch (e) {
        console.error("Error disabling raw mode during destroy:", e)
      }
    }
    try {
      this.stdin.pause()
    } catch (e) {
      console.error("Error pausing stdin during destroy:", e)
    }

    if (this._feed !== null && this._splitHeight > 0 && !this._terminalIsSetup) {
      this.flushPendingSplitOutputBeforeTransition(false, { allowSuspended: true, allowUnsetup: true })
    }

    this.externalOutputMode = "passthrough"

    if (this._splitHeight > 0) {
      this.flushStdoutCache(this._splitHeight, true)
    }
  }

  private prepareDestroyDuringRender(): void {
    this.cleanupBeforeDestroy()
    this.lib.suspendRenderer(this.rendererPtr)
  }

  private finalizeDestroy(): void {
    if (this._destroyFinalized) return

    this._destroyFinalized = true
    this._destroyPending = false

    this.cleanupBeforeDestroy()

    // Clean up palette detector
    if (this._paletteDetector) {
      this._paletteDetector.cleanup()
      this._paletteDetector = null
    }
    this._paletteCache.clear()
    this._paletteDetectionPromise = null
    this._paletteDetectionSize = 0
    this._nativePaletteSignature = null
    this._emittedPaletteSignature = null
    this._paletteEpoch = 0
    this.resolveXtVersionWaiters()

    this.themeModeState.dispose()

    this.emit(CliRenderEvents.DESTROY)

    try {
      this.root.destroyRecursively()
    } catch (e) {
      console.error("Error destroying root renderable:", e instanceof Error ? e.stack : String(e))
    }

    this.stdinParser?.destroy()
    this.stdinParser = null
    this.oscSubscribers.clear()
    this._console.destroy()

    // Split-footer cleanup: flush pending output and reset offset before
    // tearing down the native renderer.
    if (
      this._splitHeight > 0 &&
      this._terminalIsSetup &&
      this._controlState !== RendererControlState.EXPLICIT_SUSPENDED
    ) {
      this.flushPendingSplitOutputBeforeTransition(true)
      this.renderOffset = 0
      if (this.clearOnShutdown) {
        this.lib.setRenderOffset(this.rendererPtr, 0)
      }
    }

    this._externalOutputMode = "passthrough"
    this.pendingExternalOutputMode = null
    this.stdout.write = this.realStdoutWrite
    this.externalOutputQueue.clear()

    // Teardown ordering for the feed backend is subtle and must satisfy two
    // invariants simultaneously:
    //
    //   1. The shutdown ANSI sequence emitted by `lib.destroyRenderer` via
    //      FeedBackend.writeOut MUST reach the user's Writable. Otherwise the
    //      remote terminal is left in alt-screen / mouse-tracking / kitty-
    //      keyboard state at session close.
    //
    //   2. The data handler (which does `stdout.write`) must be detached
    //      before `feed.close()`, otherwise `close()` will wait for any
    //      in-flight writes that reference chunks about to be freed.
    //
    // The correct order is:
    //   a) drain any frames already committed but not yet delivered
    //   b) call lib.destroyRenderer — this commits shutdown bytes into the feed
    //   c) drain again — this flushes those shutdown bytes through the handler
    //   d) detach the handler now that no more data will flow
    //   e) close the feed (releases chunk memory once async handlers settle)
    //
    // Memory-lifetime invariant: `lib.destroyRenderer` calls into Zig's
    // `FeedBackend.deinit`, which is a DOCUMENTED NO-OP — feed memory is
    // owned by the TS side and only released by `feed.close()` at step (e).
    // Consequently, step (c)'s drain operates on still-valid chunk memory;
    // there is no use-after-free window between (b) and (e).
    //
    // Caller note: `feed.close()` is queued as a microtask when async handlers
    // from the final drain are still pending. If the caller tears down the
    // underlying Writable synchronously right after `destroy()` returns (e.g.
    // `channel.close()` on the very next line, or `process.exit()`), the
    // shutdown bytes may not have flushed yet. For async teardown, allow one
    // microtask tick (e.g. `await new Promise(queueMicrotask)`) before closing
    // the transport.
    if (this._feed) {
      try {
        this._feed.drainAll()
      } catch (e) {
        console.error("Error draining NativeSpanFeed during destroy:", e)
      }
    }

    try {
      this.lib.destroyRenderer(this.rendererPtr)
    } catch (e) {
      console.error("Error in lib.destroyRenderer during destroy:", e)
    }
    rendererTracker.renderers.delete(this)
    if (rendererTracker.renderers.size === 0) {
      void destroyTreeSitterClient().catch((error) => {
        console.error("Failed to destroy tree-sitter client:", error)
      })
    }

    if (this._feed) {
      try {
        this._feed.drainAll()
      } catch (e) {
        console.error("Error draining NativeSpanFeed shutdown frames:", e)
      }
      this._detachFeed?.()
      this._detachFeed = null
      this._detachFeedError?.()
      this._detachFeedError = null
      this._feed.close()
      this._feed = null
    }

    if (this._streamLeaseAcquired) {
      if (rendererTracker.streamOwners.get(this.stdin) === this) rendererTracker.streamOwners.delete(this.stdin)
      if (rendererTracker.streamOwners.get(this.stdout) === this) rendererTracker.streamOwners.delete(this.stdout)
      this._streamLeaseAcquired = false
    }

    if (this._onDestroy) {
      try {
        this._onDestroy()
      } catch (e) {
        console.error("Error in onDestroy callback:", e instanceof Error ? e.stack : String(e))
      }
    }

    // Resolve any pending idle() calls
    this.resolveIdleIfNeeded()
  }

  private startRenderLoop(): void {
    if (!this._isRunning) return

    this.lastTime = this.normalizeClockTime(this.clock.now(), 0)
    this.frameCount = 0
    this.lastFpsTime = this.lastTime
    this.currentFps = 0
    this.renderStats.fps = 0

    // Starting continuous mode must not bypass an existing feed-idle retry. Keep
    // _isRunning true, but let the idle callback schedule the first loop once the
    // feed is ready; a successful frame will then resume the normal cadence.
    if (this.feedIdleRenderScheduled) return

    this.loop()
  }

  private async loop(): Promise<void> {
    if (this.rendering || this._isDestroyed) return
    this.renderTimeout = null

    this.rendering = true
    if (this.renderTimeout) {
      this.clock.clearTimeout(this.renderTimeout)
      this.renderTimeout = null
    }
    try {
      // Bump before any work so all callers this iteration see the new id.
      this._frameId++

      const now = this.normalizeClockTime(this.clock.now(), this.lastTime)
      const elapsed = this.getElapsedMs(now, this.lastTime)

      const deltaTime = elapsed
      this.lastTime = now

      this.renderStats.frameCount++
      const overallStart = performance.now()

      const frameRequests = Array.from(this.animationRequest.values())
      this.animationRequest.clear()
      const animationRequestStart = performance.now()
      for (const callback of frameRequests) {
        callback(deltaTime)
        this.dropLive()
      }
      const animationRequestEnd = performance.now()
      const animationRequestTime = animationRequestEnd - animationRequestStart

      const start = performance.now()
      for (const frameCallback of this.frameCallbacks) {
        try {
          await frameCallback(deltaTime)
        } catch (error) {
          console.error("Error in frame callback:", error)
        }
      }
      const end = performance.now()
      this.renderStats.frameCallbackTime = end - start

      this.root.render(this.nextRenderBuffer, deltaTime)

      for (const postProcessFn of this.postProcessFns) {
        postProcessFn(this.nextRenderBuffer, deltaTime)
      }

      this._console.renderToBuffer(this.nextRenderBuffer)

      // If destroy() was requested during this frame, skip native work and scheduling.
      if (!this._isDestroyed) {
        const nativeStatus = this.renderNative() ?? "rendered"
        if (nativeStatus === "rendered") this.frameCount++
        if (this.getElapsedMs(now, this.lastFpsTime) >= 1000) {
          this.currentFps = this.frameCount
          this.frameCount = 0
          this.lastFpsTime = now
        }
        this.renderStats.fps = this.currentFps

        if (nativeStatus === "rendered") {
          // Check if hit grid changed and recheck hover state if needed
          if (this._useMouse && this.lib.getHitGridDirty(this.rendererPtr)) {
            this.recheckHoverState()
          }

          const overallFrameTime = performance.now() - overallStart

          // TODO: Add animationRequestTime to stats
          this.lib.updateStats(
            this.rendererPtr,
            overallFrameTime,
            this.renderStats.fps,
            this.renderStats.frameCallbackTime,
          )

          if (this.listenerCount(CliRenderEvents.FRAME) > 0) {
            this.emit(CliRenderEvents.FRAME, {
              frameId: this.frameId,
            })
          }

          if (this.gatherStats) {
            this.collectStatSample(overallFrameTime)
          }

          if (this._isRunning || this.immediateRerenderRequested) {
            const targetFrameTime = this.immediateRerenderRequested ? this.minTargetFrameTime : this.targetFrameTime
            const delay = Math.max(1, targetFrameTime - Math.floor(overallFrameTime))
            this.immediateRerenderRequested = false
            this.renderTimeout = this.clock.setTimeout(() => {
              this.renderTimeout = null
              this.loop()
            }, delay)
          } else {
            this.clock.clearTimeout(this.renderTimeout!)
            this.renderTimeout = null
          }
        } else if (nativeStatus === "blocked") {
          const overallFrameTime = performance.now() - overallStart

          if (this._isRunning || this.immediateRerenderRequested) {
            const targetFrameTime = this.immediateRerenderRequested ? this.minTargetFrameTime : this.targetFrameTime
            const delay = Math.max(1, targetFrameTime - Math.floor(overallFrameTime))
            this.immediateRerenderRequested = false
            this.renderTimeout = this.clock.setTimeout(() => {
              this.renderTimeout = null
              this.loop()
            }, delay)
          } else {
            this.clock.clearTimeout(this.renderTimeout!)
            this.renderTimeout = null
          }
        } else if (nativeStatus === "backpressured") {
          this.scheduleRenderAfterBackpressure()
        } else if (nativeStatus === "retryable-skip") {
          this.immediateRerenderRequested = false
          this.renderTimeout = null
        } else if (nativeStatus === "failed") {
          this.immediateRerenderRequested = false
          this.renderTimeout = null
        }
      }
    } finally {
      this.rendering = false
      if (this._destroyPending) {
        this.finalizeDestroy()
      }
      this.resolveIdleIfNeeded()
    }
  }

  public intermediateRender(): void {
    this.immediateRerenderRequested = true
    this.loop()
  }

  private renderNative(): "rendered" | "retryable-skip" | "failed" | "blocked" | "backpressured" {
    if (this.renderingNative) {
      console.error("Rendering called concurrently")
      throw new Error("Rendering called concurrently")
    }

    this.renderingNative = true

    try {
      if (this.isSplitCursorSeedFrameBlocked()) {
        return "blocked"
      }

      if (this._splitHeight > 0 && this._externalOutputMode === "capture-stdout") {
        // forceFullRepaintRequested is a one-shot latch used when mode/geometry
        // transitions need a complete footer refresh. Consume it once so steady-state
        // capture path keeps using diff-based repainting.
        const forceSplitRepaint = this.forceFullRepaintRequested
        const status = this.flushPendingSplitCommits(
          forceSplitRepaint,
          this.pendingExternalOutputMode === "passthrough",
        )
        if (status === "backpressured") {
          return "backpressured"
        }
        if (status === "failed") {
          return "failed"
        }
        this.forceFullRepaintRequested = false
        this.pendingSplitFooterTransition = null
        return "rendered"
      }

      const force = this.forceFullRepaintRequested
      const nativeStatus = this.lib.render(this.rendererPtr, force)
      if (nativeStatus === NATIVE_RENDER_STATUS_SKIPPED || nativeStatus === NATIVE_RENDER_STATUS_FAILED) {
        return this.handleNativeRenderRejection(nativeStatus)
      }

      this.forceFullRepaintRequested = false
      this.pendingSplitFooterTransition = null
      // this.dumpOutputBuffer(Date.now())
      return "rendered"
    } finally {
      this.renderingNative = false
    }
  }

  private collectStatSample(frameTime: number): void {
    this.frameTimes.push(frameTime)
    if (this.frameTimes.length > this.maxStatSamples) {
      this.frameTimes.shift()
    }
  }

  public getNativeStats(): NativeRenderStats {
    return this.lib.getRenderStats(this.rendererPtr)
  }

  public getStats(): CliRendererStats {
    const nativeStats = this.getNativeStats()
    const frameTimes = [...this.frameTimes]
    const sum = frameTimes.reduce((acc, time) => acc + time, 0)
    const avg = frameTimes.length ? sum / frameTimes.length : 0
    const min = frameTimes.length ? Math.min(...frameTimes) : 0
    const max = frameTimes.length ? Math.max(...frameTimes) : 0

    return {
      ...nativeStats,
      fps: this.renderStats.fps,
      frameCount: this.renderStats.frameCount,
      frameTimes,
      averageFrameTime: avg,
      minFrameTime: min,
      maxFrameTime: max,
      frameCallbackTime: this.renderStats.frameCallbackTime,
    }
  }

  public resetStats(): void {
    this.frameTimes = []
    this.renderStats.frameCount = 0
  }

  public setGatherStats(enabled: boolean): void {
    this.gatherStats = enabled
    if (!enabled) {
      this.frameTimes = []
    }
  }

  public getSelection(): Selection | null {
    return this.currentSelection
  }

  public get hasSelection(): boolean {
    return !!this.currentSelection
  }

  public getSelectionContainer(): Renderable | null {
    return this.selectionContainers.length > 0 ? this.selectionContainers[this.selectionContainers.length - 1] : null
  }

  public clearSelection(): void {
    if (this.currentSelection) {
      for (const renderable of this.currentSelection.touchedRenderables) {
        if (renderable.selectable && !renderable.isDestroyed) {
          renderable.onSelectionChanged(null)
        }
      }
      this.currentSelection = null
    }
    this.selectionContainers = []
  }

  /**
   * Start a new selection at the given coordinates.
   * Used by both mouse and keyboard selection.
   */
  public startSelection(renderable: Renderable, x: number, y: number): void {
    if (!renderable.selectable) return

    this.clearSelection()
    this.selectionContainers.push(renderable.parent || this.root)
    this.currentSelection = new Selection(renderable, { x, y }, { x, y })
    this.currentSelection.isStart = true

    this.notifySelectablesOfSelectionChange()
  }

  public updateSelection(
    currentRenderable: Renderable | undefined,
    x: number,
    y: number,
    options?: { finishDragging?: boolean },
  ): void {
    if (this.currentSelection) {
      this.currentSelection.isStart = false
      this.currentSelection.focus = { x, y }

      if (options?.finishDragging) {
        this.currentSelection.isDragging = false
      }

      if (this.selectionContainers.length > 0) {
        const currentContainer = this.selectionContainers[this.selectionContainers.length - 1]

        if (!currentRenderable || !this.isWithinContainer(currentRenderable, currentContainer)) {
          const parentContainer = currentContainer.parent || this.root
          this.selectionContainers.push(parentContainer)
        } else if (currentRenderable && this.selectionContainers.length > 1) {
          let containerIndex = this.selectionContainers.indexOf(currentRenderable)

          if (containerIndex === -1) {
            const immediateParent = currentRenderable.parent || this.root
            containerIndex = this.selectionContainers.indexOf(immediateParent)
          }

          if (containerIndex !== -1 && containerIndex < this.selectionContainers.length - 1) {
            this.selectionContainers = this.selectionContainers.slice(0, containerIndex + 1)
          }
        }
      }

      this.notifySelectablesOfSelectionChange()
    }
  }

  public requestSelectionUpdate(): void {
    if (this.currentSelection?.isDragging) {
      const pointer = this._latestPointer

      const maybeRenderableId = this.hitTest(pointer.x, pointer.y)
      const maybeRenderable = Renderable.renderablesByNumber.get(maybeRenderableId)

      this.updateSelection(maybeRenderable, pointer.x, pointer.y)
    }
  }

  private isWithinContainer(renderable: Renderable, container: Renderable): boolean {
    let current: Renderable | null = renderable
    while (current) {
      if (current === container) return true
      current = current.parent
    }
    return false
  }

  private finishSelection(): void {
    if (this.currentSelection) {
      this.currentSelection.isDragging = false
      this.emit(CliRenderEvents.SELECTION, this.currentSelection)
      this.notifySelectablesOfSelectionChange()
    }
  }

  private notifySelectablesOfSelectionChange(): void {
    const selectedRenderables: Renderable[] = []
    const touchedRenderables: Renderable[] = []
    const currentContainer =
      this.selectionContainers.length > 0 ? this.selectionContainers[this.selectionContainers.length - 1] : this.root

    if (this.currentSelection) {
      this.walkSelectableRenderables(
        currentContainer,
        this.currentSelection.bounds,
        selectedRenderables,
        touchedRenderables,
      )

      for (const renderable of this.currentSelection.touchedRenderables) {
        if (!touchedRenderables.includes(renderable) && !renderable.isDestroyed) {
          renderable.onSelectionChanged(null)
        }
      }

      this.currentSelection.updateSelectedRenderables(selectedRenderables)
      this.currentSelection.updateTouchedRenderables(touchedRenderables)
    }
  }

  private walkSelectableRenderables(
    container: Renderable,
    selectionBounds: ViewportBounds,
    selectedRenderables: Renderable[],
    touchedRenderables: Renderable[],
  ): void {
    const children = getObjectsInViewport<Renderable>(
      selectionBounds,
      container.getChildrenSortedByPrimaryAxis(),
      container.primaryAxis,
      0, // padding
      0, // minTriggerSize - always perform overlap checks for selection
    )

    for (const child of children) {
      if (child.selectable) {
        const hasSelection = child.onSelectionChanged(this.currentSelection)
        if (hasSelection) {
          selectedRenderables.push(child)
        }
        touchedRenderables.push(child)
      }
      if (child.getChildrenCount() > 0) {
        this.walkSelectableRenderables(child, selectionBounds, selectedRenderables, touchedRenderables)
      }
    }
  }

  public get paletteDetectionStatus(): "idle" | "detecting" | "cached" {
    if (this._paletteDetectionPromise) return "detecting"
    if (this._paletteCache.size > 0) return "cached"
    return "idle"
  }

  private getCachedPaletteBySize(size: number): TerminalColors | null {
    const exactMatch = this._paletteCache.get(size)
    if (exactMatch) {
      return exactMatch
    }

    const largerSize = [...this._paletteCache.keys()].sort((a, b) => a - b).find((candidate) => candidate >= size)
    if (largerSize === undefined) {
      return null
    }

    const source = this._paletteCache.get(largerSize)
    if (!source) {
      return null
    }

    const projected = {
      ...source,
      palette: source.palette.slice(0, size),
    }

    this._paletteCache.set(size, projected)
    return projected
  }

  private ensurePaletteDetector(): TerminalPaletteDetector {
    if (!this._paletteDetector) {
      const isTmux = Boolean(
        this.capabilities?.multiplexer === "tmux" || this.capabilities?.terminal?.name?.toLowerCase()?.includes("tmux"),
      )
      const isLegacyTmux =
        this.capabilities?.terminal?.name?.toLowerCase()?.includes("tmux") &&
        this.capabilities?.terminal?.version?.localeCompare("3.6") < 0
      this._paletteDetector = createTerminalPalette({
        stdin: this.stdin,
        stdout: this.stdout,
        writeFn: (data) => (this._isDestroyed ? false : this.writeOut(data)),
        isLegacyTmux,
        isTmux,
        oscSource: {
          subscribeOsc: this.subscribeOsc.bind(this),
        },
        clock: this.clock,
      })
    }

    return this._paletteDetector
  }

  private syncNativePaletteState(colors: TerminalColors | null): void {
    const signature = buildTerminalPaletteSignature(colors)
    if (this._nativePaletteSignature !== signature) {
      this._paletteEpoch = (this._paletteEpoch + 1) >>> 0
    }

    this._nativePaletteSignature = signature

    const normalized = normalizeTerminalPalette(colors)
    this.lib.rendererSetPaletteState(
      this.rendererPtr,
      normalized.palette,
      normalized.defaultForeground,
      normalized.defaultBackground,
      this._paletteEpoch,
    )
  }

  private emitPaletteChange(colors: TerminalColors): void {
    if (this.listenerCount(CliRenderEvents.PALETTE) === 0) return

    const signature = buildTerminalPaletteSignature(colors)
    if (this._emittedPaletteSignature === signature) return

    this._emittedPaletteSignature = signature
    this.emit(CliRenderEvents.PALETTE, colors)
  }

  private resolveXtVersionWaiters(): void {
    if (this.xtVersionWaiters.size === 0) return

    const resolvers = [...this.xtVersionWaiters]
    this.xtVersionWaiters.clear()
    for (const resolve of resolvers) {
      resolve()
    }
  }

  private waitForXtVersion(): Promise<void> {
    if (this.capabilityTimeoutId === null || this._capabilities?.terminal?.from_xtversion) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      this.xtVersionWaiters.add(resolve)
    })
  }

  private shouldSyncNativePaletteState(): boolean {
    return Boolean(
      this._terminalIsSetup && !this._isDestroyed && this._capabilities?.ansi256 && !this._capabilities?.rgb,
    )
  }

  private refreshPalette(): void {
    const publishGeneration = this._palettePublishGeneration

    void this.getPalette({ size: NATIVE_PALETTE_QUERY_SIZE })
      .then(() => {
        if (this._isDestroyed) return
        if (this._palettePublishGeneration === publishGeneration) this.requestRender()
      })
      .catch(() => {})
  }

  public clearPaletteCache(): void {
    this._palettePublishGeneration++
    this._paletteCache.clear()
  }

  /**
   * Detects the terminal's color palette
   *
   * @returns Promise resolving to TerminalColors object containing palette and special colors
   * @throws Error if renderer is suspended
   */
  public async getPalette(options?: GetPaletteOptions): Promise<TerminalColors> {
    if (this._controlState === RendererControlState.EXPLICIT_SUSPENDED) {
      throw new Error("Cannot detect palette while renderer is suspended")
    }

    const requestedSize = options?.size ?? 16
    const detectionTimeout = options?.timeout

    const cachedPalette = this.getCachedPaletteBySize(requestedSize)
    if (cachedPalette) {
      return cachedPalette
    }

    // tmux OSC 4 strategy depends on version. Env may provide it via
    // TERM_PROGRAM=tmux/TERM_PROGRAM_VERSION; otherwise wait for XTVERSION.
    const terminal = this._capabilities?.terminal
    const hasTmuxVersion = terminal?.name?.toLowerCase() === "tmux" && Boolean(terminal.version)
    if (this._capabilities?.multiplexer === "tmux" && !hasTmuxVersion) {
      await this.waitForXtVersion()

      // Another caller may have populated the cache while this call waited.
      const afterCapabilityWait = this.getCachedPaletteBySize(requestedSize)
      if (afterCapabilityWait) {
        return afterCapabilityWait
      }
    }

    if (this._paletteDetectionPromise) {
      if (this._paletteDetectionSize >= requestedSize) {
        return this._paletteDetectionPromise.then((palette) => {
          const cached = this.getCachedPaletteBySize(requestedSize)
          if (cached) {
            return cached
          }

          const projected = {
            ...palette,
            palette: palette.palette.slice(0, requestedSize),
          }
          this._paletteCache.set(requestedSize, projected)
          return projected
        })
      }

      await this._paletteDetectionPromise

      const afterWait = this.getCachedPaletteBySize(requestedSize)
      if (afterWait) {
        return afterWait
      }
    }

    const detector = this.ensurePaletteDetector()
    const publishGeneration = this._palettePublishGeneration
    this._paletteDetectionSize = requestedSize
    this._paletteDetectionPromise = detector
      .detect({ ...options, timeout: detectionTimeout })
      .then((result) => {
        this._paletteCache.set(result.palette.length, result)
        this._paletteDetectionPromise = null
        this._paletteDetectionSize = 0

        if (!this._isDestroyed && this._palettePublishGeneration === publishGeneration) {
          this.emitPaletteChange(result)
          if (this.shouldSyncNativePaletteState() && result.palette.length >= NATIVE_PALETTE_QUERY_SIZE) {
            this.syncNativePaletteState(result)
          } else if (this.shouldSyncNativePaletteState() && !this._paletteCache.has(NATIVE_PALETTE_QUERY_SIZE)) {
            this.refreshPalette()
          }
        }

        return result
      })
      .catch((error) => {
        this._paletteDetectionPromise = null
        this._paletteDetectionSize = 0
        throw error
      })

    const detected = await this._paletteDetectionPromise
    const finalPalette = this.getCachedPaletteBySize(requestedSize) ?? detected
    return finalPalette
  }
}
