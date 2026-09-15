import { appendFileSync, writeFileSync } from "node:fs"
import { Writable } from "node:stream"
import { ANSI } from "./ansi.js"
import { destroyTimelineEngine } from "./animation/Timeline.js"
import { Renderable, RootRenderable } from "./Renderable.js"
import { BoxRenderable } from "./renderables/Box.js"
import { CodeRenderable } from "./renderables/Code.js"
import { ImageRenderable } from "./renderables/Image.js"
import { TextRenderable } from "./renderables/Text.js"
import {
  DebugOverlayCorner,
  type CursorStyleOptions,
  type MousePointerStyle,
  type RenderContext,
  type TerminalCapabilities,
  type ThemeMode,
  type SelectionBehavior,
  type ViewportBounds,
  type WidthMethod,
} from "./types.js"
import { RGBA, parseColor, type ColorInput } from "./lib/RGBA.js"
import { OptimizedBuffer } from "./buffer.js"
import {
  NativeError,
  NativeSessionRenderStatus,
  NativeStatus,
  type NativeBufferedOutput,
  type NativeRenderStats,
  type RenderLib,
  type ContextBufferHandle,
} from "./zig.js"
import { NativeSession } from "./NativeSession.js"
import { NativeScene } from "./NativeScene.js"
import { TerminalConsole, type ConsoleOptions, capture } from "./console.js"
import { type MouseEventType, type RawMouseEvent, type ScrollInfo } from "./lib/parse.mouse.js"
import { Selection } from "./lib/selection.js"
import { ClipboardTarget } from "./lib/clipboard.js"
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
import { getLinkId } from "./utils.js"

registerEnvVar({
  name: "OTUI_DUMP_CAPTURES",
  description: "Dump captured stdout and console caches when the renderer exit handler runs.",
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
  name: "OTUI_STDIN_LOG",
  description: "Write the raw stdin byte stream to this file for debugging.",
  type: "string",
  default: "",
})

registerEnvVar({
  name: "OTUI_SHOW_STATS",
  description: "Show the debug overlay at startup.",
  type: "boolean",
  default: false,
})

export type KittyImageTransport = "raw" | "zlib" | "file"
const KITTY_IMAGE_TRANSPORTS: KittyImageTransport[] = ["raw", "zlib", "file"]

export interface KittyImageTransportStatus {
  requested: KittyImageTransport
  effective: "raw" | "zlib" | "png" | "file"
  fileState: "disabled" | "probing" | "ready" | "unsupported" | "timeout" | "io-error" | "cancelled"
  fallback: "none" | "not-ready" | "unavailable" | "budget" | "busy" | "preparation" | "compression"
  pendingFiles: number
  pendingBytes: number
}

export interface CliRendererConfig {
  /** Transfer this driver's ownership after attachment succeeds. Requires the same stdout. */
  nativeSession?: NativeSession
  /** Opt-in native paint members per event-loop turn. Yoga and encoding remain synchronous. */
  nativeScenePaintBudget?: number
  /** Opt-in native preparation/feedback items per turn. Yoga, cell drawing, and encoding remain synchronous. */
  nativeSceneWorkBudget?: number
  // Read input from this stream. Defaults to process.stdin. Any `Readable`
  // works; capabilities like `setRawMode` are duck-typed and used when present.
  stdin?: NodeJS.ReadStream

  // Destination for rendered output. Defaults to process.stdout. The native
  // Session borrows this Writable and preserves output order and completion.
  // TTY capabilities like `columns`/`rows` are duck-typed.
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

  // Raw is the default. File requires a local terminal with medium and upload ACK support.
  kittyImageTransport?: KittyImageTransport

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

export interface CliRendererErrorEvent {
  error: Error
  renderable: Renderable | undefined
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
  nativeSnapshot?: ContextBufferHandle
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
  private commits: Array<ExternalOutputCommit & { cells: number }> = []
  private cells = 0

  constructor(
    private readonly maxCells: number,
    private readonly maxCommits: number,
  ) {}

  owns(snapshot: OptimizedBuffer): boolean {
    return this.commits.some((commit) => commit.snapshot === snapshot)
  }

  get size(): number {
    return this.commits.length
  }

  writeSnapshots(commits: readonly ExternalOutputCommit[]): void {
    const entries = commits.map((commit) => ({ ...commit, cells: commit.snapshot.width * commit.snapshot.height }))
    const cells = entries.reduce((total, commit) => total + commit.cells, 0)
    if (commits.length > this.maxCommits - this.commits.length || cells > this.maxCells - this.cells) {
      throw new Error("Scrollback snapshot queue capacity exceeded")
    }
    for (const entry of entries) this.commits.push(entry)
    this.cells += cells
  }

  peek(limit: number = Number.POSITIVE_INFINITY): readonly ExternalOutputCommit[] {
    const clampedLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : this.commits.length
    return this.commits.slice(0, clampedLimit)
  }

  claim(): ExternalOutputCommit[] {
    const output = this.commits
    this.commits = []
    this.cells = 0
    return output
  }

  drop(count: number): void {
    for (const commit of this.commits.splice(0, count)) {
      this.cells -= commit.cells
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
  public terminalWidth: number
  public terminalHeight: number
  public resolution: PixelResolution | null
  public frameId = 0
  public widthMethod: WidthMethod
  public capabilities: TerminalCapabilities | null
  public hasSelection: boolean = false
  public currentFocusedRenderable: Renderable | null = null
  public keyInput: KeyHandler
  public _internalKeyInput: InternalKeyHandler
  public readonly nativeScene: NativeScene
  public root!: RootRenderable
  public nextRenderBuffer!: OptimizedBuffer
  public isDestroyed = false
  public controlState = RendererControlState.IDLE
  private readonly detachedSession: NativeSession

  constructor(
    width: number,
    height: number,
    widthMethod: WidthMethod,
    terminalWidth: number,
    terminalHeight: number,
    resolution: PixelResolution | null,
    capabilities: TerminalCapabilities | null,
    private readonly nativeOwner: NativeSession,
  ) {
    super()
    this.width = width
    this.height = height
    this.terminalWidth = terminalWidth
    this.terminalHeight = terminalHeight
    this.resolution = resolution
    this.capabilities = capabilities
    this.widthMethod = widthMethod
    this.keyInput = new KeyHandler()
    this._internalKeyInput = new InternalKeyHandler()
    this.detachedSession = nativeOwner.createDetached({ width, height, remote: true, environment: {} }, () => {
      this.nativeScene?.cancelFrame()
      this.nativeScene?.destroy()
    })
    try {
      nativeOwner.renderLib.sessionSyncDetached(nativeOwner.context, this.detachedSession.session, nativeOwner.session)
      this.nativeScene = new NativeScene(this.detachedSession, this)
      this.nextRenderBuffer = OptimizedBuffer.fromSession(
        nativeOwner.renderLib,
        nativeOwner.context,
        this.detachedSession.session,
        "next",
        () => this.nativeScene.frame,
      )
    } catch (error) {
      this.detachedSession.dispose()
      throw error
    }
  }

  public renderSnapshot(root: RootRenderable, buffer: OptimizedBuffer): void {
    this.root = root
    this.detachedSession.renderLib.sessionSyncDetached(
      this.detachedSession.context,
      this.detachedSession.session,
      this.nativeOwner.session,
    )
    this.detachedSession.resize(this.width, this.height)
    try {
      this.nativeScene.paint(0, () => ({
        background: TRANSPARENT_RGBA,
        useMouse: false,
        excludedHitNum: 0,
        preserveUnwritten: true,
      }))
      if (!this.nativeScene.frame) throw new Error("Detached scene did not complete painting")
      this.detachedSession.renderLib.sceneFrameCopyBuffer(
        this.detachedSession.context,
        this.detachedSession.session,
        this.nativeScene.frame,
        buffer._getSceneHandle(this.nativeScene),
      )
    } finally {
      this.nativeScene.cancelFrame()
      if (this.isDestroyed) this.disposeSession()
    }
  }

  public destroy(): void {
    if (this.isDestroyed) return
    this.isDestroyed = true
    let failure: { error: unknown } | undefined
    for (const emitter of [this, this.keyInput, this._internalKeyInput]) {
      try {
        emitter.removeAllListeners()
      } catch (error) {
        failure ??= { error }
      }
    }
    this.disposeSession()
    if (failure) throw failure.error
  }

  private disposeSession(): void {
    const dispose = () => this.detachedSession.dispose()
    if (!this.root?._deferUntilCleanupComplete(dispose)) dispose()
  }

  public requestRender(): void {}
  public requestAnimationFrame(_callback: FrameRequestCallback): number {
    return -1
  }
  public cancelAnimationFrame(_handle: number): void {}
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
    this.getLifecyclePasses().add(renderable)
  }
  public unregisterLifecyclePass(renderable: Renderable): void {
    this.getLifecyclePasses().delete(renderable)
  }
  public getLifecyclePasses(): Set<Renderable> {
    return this.nativeScene.lifecyclePasses
  }
  public clearSelection(): void {}
  public startSelection(_renderable: Renderable, _x: number, _y: number, _behavior?: SelectionBehavior): void {}
  public updateSelection(
    _currentRenderable: Renderable | undefined,
    _x: number,
    _y: number,
    _options?: { finishDragging?: boolean },
  ): void {}
}

const DEFAULT_FORWARDED_ENV_KEYS = [
  "TMPDIR",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
  "MOSH_CONNECTION",
  "TMUX",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  "TERM",
  "OPENTUI_GRAPHICS",
  "OPENTUI_IMAGE_PROTOCOL",
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
  public readonly currentTarget: Renderable | null = null
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

export interface CliRendererHandlerErrorEvent {
  error: unknown
  event: MouseEvent
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
    await renderer.closed.catch(() => {})
    throw error
  }
}

export enum CliRenderEvents {
  RESIZE = "resize",
  FRAME = "frame",
  RENDER_ERROR = "render:error",
  HANDLER_ERROR = "handler:error",
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

const CLICK_REPEAT_INTERVAL_MS = 500

export class CliRenderer extends EventEmitter implements RenderContext {
  private static animationFrameId = 0
  private lib: RenderLib
  public readonly nativeScene: NativeScene
  private readonly nativeSession!: NativeSession
  private readonly nativeDestroyWait?: ReturnType<typeof Promise.withResolvers<void>>
  private readonly nativeClosed: Promise<void>
  private nativeTerminalTransition: Promise<void> | null = null
  private pendingNativeResize: { width: number; height: number } | null = null
  private pendingNativeMode: { screenMode: ScreenMode; footerHeight: number } | null = null
  private nativeSplitAcceptedCount = 0
  private nativeSplitFlush: Promise<void> | null = null
  private pendingNativeReplay: { options: SplitFooterReplayResetOptions; remaining: number } | null = null
  private readonly detachedSurfaces = new Set<() => void>()
  private nativeResizeWait: Promise<void> | null = null
  private nativeKittyKeyboardFlags = 0
  private kittyTransportMode: KittyImageTransport = "raw"
  private kittyTransportTimer: TimerHandle | null = null
  private _lastSceneTimeMs = 0

  public get lastSceneTimeMs(): number {
    return this._lastSceneTimeMs
  }

  /** Await after destroy() before closing stdout or calling process.exit(). */
  public get closed(): Promise<void> {
    return this.nativeClosed
  }
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
  private gatherStats: boolean = false
  private frameTimes: number[] = []
  private maxStatSamples: number = 300
  private postProcessFns: ((buffer: OptimizedBuffer, deltaTime: number) => void)[] = []
  private backgroundColor: RGBA = RGBA.fromInts(0, 0, 0, 0)
  private waitingForPixelResolution: boolean = false
  private pixelResolutionRequeryPending: boolean = false
  public readonly clock: Clock

  private rendering: boolean = false
  private renderingCompletion: PromiseWithResolvers<void> | null = null
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
  private cancelFrameContinuation: (() => void) | null = null
  private cancelReadyFrame: (() => void) | null = null

  private resizeTimeoutId: TimerHandle | null = null
  private capabilityTimeoutId: TimerHandle | null = null
  private terminalKeepAliveTimer: ReturnType<typeof setInterval> | null = null
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
  private capturedRenderable?: Renderable
  private lastOverRenderableNum: number = 0
  private lastOverRenderable?: Renderable

  private currentSelection: Selection | null = null
  private selectionContainers: Renderable[] = []
  private lastClick: { count: number; time: number; x: number; y: number; renderableId: number } | null = null

  private _splitHeight: number = 0
  private renderOffset: number = 0
  private splitTailColumn: number = 0
  private pendingSplitFooterTransition: PendingSplitFooterTransition | null = null
  // One-shot latch used to request a full split repaint after transitions
  // (resize/mode/output-path changes). Cleared after completed presentation.
  private forceFullRepaintRequested: boolean = false
  // Upper bound for captured stdout commits consumed per native frame.
  // This is a visual smoothness control: smaller batches reduce frame envelope
  // churn and keep render latency predictable under heavy scrollback append load.
  private readonly maxSplitCommitsPerFrame: number = 8

  private _terminalWidth: number = 0
  private _terminalHeight: number = 0
  private _terminalIsSetup: boolean = false

  private externalOutputQueue: ExternalOutputQueue
  private pendingExternalOutputMode: ExternalOutputMode | null = null
  private realStdoutWrite: (chunk: any, encoding?: any, callback?: any) => boolean

  private _useConsole: boolean = true
  private sigwinchHandler: () => void = (() => {
    const width = this.stdout.columns
    const height = this.stdout.rows
    if (width > 0 && height > 0) this.requestResize(width, height)
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
  private focusChange?: object
  private _openConsoleOnError: boolean = true
  private _paletteDetector: TerminalPaletteDetector | null = null
  private _paletteCache = new Map<number, TerminalColors>()
  private _paletteDetectionPromise: Promise<TerminalColors> | null = null
  private _cancelPaletteDetection: ((reason: Error) => void) | null = null
  private _paletteDetectionSize = 0
  private _paletteDetectionGeneration = 0
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
  private readonly stdinLogPath: string = env.OTUI_STDIN_LOG

  private handleError: (error: Error) => void = ((error: Error) => {
    console.error(error)

    if (this._openConsoleOnError && !this._isDestroyed && !this.nativeSession?.error && !this.nativeSession?.disposed) {
      this.console.show()
    }
  }).bind(this)

  private dumpOutputCache(optionalMessage: string = ""): void {
    const cachedLogs = this._console.getCachedLogs()
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
    void this.closed
      .then(() => {
        if (env.OTUI_DUMP_CAPTURES) this.dumpOutputCache("=== CAPTURED OUTPUT ===\n")
      })
      .catch((error) => console.error("Native scene shutdown failed:", error))
  }).bind(this)

  private nativeProcessExitHandler = (): void => {
    if (!this.nativeSession || this.nativeSession.disposed) return
    const restored = this.nativeSession.restoreOnExit()
    try {
      this.destroy()
    } finally {
      this.nativeSession.dispose()
      if (!restored && this._terminalIsSetup) {
        console.error("Native scene output cancelled at process exit; terminal restoration did not complete")
      }
    }
  }

  private warningHandler: (warning: any) => void = ((warning: any) => {
    console.warn(JSON.stringify(warning.message, null, 2))
  }).bind(this)

  // Stream identity flag. Used only for SIGWINCH gating (terminal-driven
  // resize only fires for process.stdout). Other per-stream behavior uses
  // identity checks inline (e.g. rendererTracker compares `stdin` directly)
  // or duck-typed capability checks (e.g. `stdin.setRawMode?.()`).
  private readonly _usesProcessStdout: boolean

  private outputIdleRenderScheduled = false
  private ordinaryFrameWaitingForOutput = false
  private ordinaryFrameWaitControlState: RendererControlState | null = null

  public get controlState(): RendererControlState {
    return this._controlState
  }

  /**
   * Construct a renderer over the given streams.
   *
   * A NativeSession owns ordered output to `stdout`, or to an in-memory sink
   * when `bufferedOutput: "memory"` is set. Prefer `createCliRenderer` for the
   * async `setupTerminal` convenience.
   *
   * Construction side effects (observable before the constructor returns):
   *   - Acquires exclusive ownership of the given stdin/stdout streams
   *   - Attaches a NativeSession and allocates its scene
   *   - Registers in the process-wide `rendererTracker`
   *   - Adds `process.on(...)` listeners for SIGWINCH (process.stdout only),
   *     "warning", "uncaughtException", "unhandledRejection", plus the
   *     configured `exitSignals`
   *   - When `setupTerminal()` is called, it will put `stdin` in raw mode and
   *     call `stdin.resume()`
   *
   * Construction failures release the owner. `createCliRenderer` also destroys
   * the renderer if asynchronous terminal setup fails.
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

    for (const name of ["nativeScenePaintBudget", "nativeSceneWorkBudget"] as const) {
      const budget = config[name]
      if (budget !== undefined && (!Number.isInteger(budget) || budget <= 0 || budget > 0xffff_ffff)) {
        throw new Error(`${name} must be a positive u32`)
      }
    }
    this.kittyTransportMode = config.kittyImageTransport ?? "raw"
    const transportCode = KITTY_IMAGE_TRANSPORTS.indexOf(this.kittyTransportMode)
    if (transportCode < 0) throw new TypeError("Invalid kittyImageTransport")
    const useMemoryBufferedOutput = config.bufferedOutput === "memory"
    if (config.nativeSession) {
      if (useMemoryBufferedOutput) throw new Error("nativeSession does not support memory buffered output")
      if (!config.nativeSession.usesOutput(stdout)) throw new Error("nativeSession must use the renderer stdout")
    }
    const { screenMode, footerHeight, externalOutputMode } = resolveModes(config)
    const initialGeometry = calculateRenderGeometry(screenMode, width, height, footerHeight)
    const remoteMode = config.remote ?? (!this._usesProcessStdout && !useMemoryBufferedOutput ? true : undefined)
    const forwardEnvKeys = config.forwardEnvKeys ?? (remoteMode === true ? [] : DEFAULT_FORWARDED_ENV_KEYS)

    if (rendererTracker.streamOwners.get(stdin)) {
      throw new Error("Cannot create CliRenderer: stdin is already used by another CliRenderer")
    }
    if (rendererTracker.streamOwners.get(stdout)) {
      throw new Error("Cannot create CliRenderer: stdout is already used by another CliRenderer")
    }

    let driver: NativeSession | undefined
    try {
      const sink = useMemoryBufferedOutput
        ? new Writable({
            write(_bytes, _encoding, complete) {
              complete()
            },
          })
        : stdout
      driver = config.nativeSession ?? new NativeSession(sink)
      driver.attachRenderer(
        {
          width: initialGeometry.renderWidth,
          height: initialGeometry.renderHeight,
          remote: remoteMode,
          environment: Object.fromEntries(
            forwardEnvKeys.flatMap((key) => {
              const value = process.env[key]
              return value === undefined ? [] : [[key, value]]
            }),
          ),
        },
        () => {
          try {
            this.nativeScene?.cancelFrame()
          } finally {
            this.nativeScene?.destroy()
          }
        },
      )
      this.nativeSession = driver
      this.externalOutputQueue = new ExternalOutputQueue(Number(driver.maxWriteBytes / 24n), driver.maxSnapshotCount)
      this.nativeDestroyWait = Promise.withResolvers<void>()
      this.nativeClosed = this.nativeSession.closed
        .finally(() => this.nativeDestroyWait!.promise)
        .finally(() => {
          if (this.nativeSession.error && !this.nativeSession.disposed) this.nativeSession.dispose()
          this.releaseStreamLease()
        })
      void this.nativeClosed.catch(() => {})
      this.nativeScene = new NativeScene(
        this.nativeSession,
        this,
        config.nativeScenePaintBudget,
        config.nativeSceneWorkBudget,
      )
      this.nativeSession.setKittyImageTransport(transportCode)
    } catch (error) {
      // A supplied Session transfers only after attachRenderer succeeds.
      if (!config.nativeSession || this.nativeSession) driver?.dispose()
      this.nativeDestroyWait?.resolve()
      throw error
    }
    this.lib = this.nativeSession.renderLib
    try {
      const kittyConfig = config.useKittyKeyboard ?? {}
      this.nativeKittyKeyboardFlags = buildKittyKeyboardFlags(kittyConfig)

      this._terminalWidth = width
      this._terminalHeight = height
      this._externalOutputMode = externalOutputMode

      this.width = initialGeometry.renderWidth
      this.height = initialGeometry.renderHeight
      this._splitHeight = initialGeometry.effectiveFooterHeight
      this.renderOffset = screenMode === "split-footer" ? 0 : initialGeometry.renderOffset

      this._footerHeight = footerHeight

      this.clearOnShutdown = config.clearOnShutdown ?? true

      this.exitOnCtrlC = config.exitOnCtrlC === undefined ? true : config.exitOnCtrlC
      this.exitSignals = config.exitSignals || [
        "SIGINT", // Ctrl+C
        "SIGTERM", // Termination signal
        "SIGQUIT", // Ctrl+\
        "SIGABRT", // Abort signal
        "SIGHUP", // Hangup (terminal closed)
        "SIGPIPE", // Broken output pipe
        "SIGBREAK", // Ctrl+Break on Windows
        "SIGBUS", // Bus error
      ]

      this.resizeDebounceDelay = config.debounceDelay || 100
      this.targetFps = config.targetFps || 30
      this.maxFps = config.maxFps || 60
      this.clock = config.clock ?? new SystemClock()
      this.themeModeState = new RendererThemeMode(
        {
          queryThemeColors: () => {
            this.nativeSession.control({ kind: "query-theme-colors" })
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
      this.nextRenderBuffer = OptimizedBuffer.fromSession(
        this.lib,
        this.nativeSession.context,
        this.nativeSession.session,
        "next",
        () => this.nativeScene.frame,
      )
      this.currentRenderBuffer = OptimizedBuffer.fromSession(
        this.lib,
        this.nativeSession.context,
        this.nativeSession.session,
        "current",
        () => this.nativeScene.frame,
      )
      this._capabilities = this.nativeSession.getCapabilities()
      if (config.backgroundColor !== undefined) this.backgroundColor = RGBA.clone(parseColor(config.backgroundColor))
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
      const useKittyForParsing = kittyConfig !== null
      this._keyHandler = new InternalKeyHandler()
      this._keyHandler.on("keypress", (event) => {
        // Use the shared matcher here too. Kitty can report a non-Latin
        // character plus a base-layout `c`, and Ctrl+C should still exit.
        if (this.exitOnCtrlC && matchesKeyBinding(event, { name: "c", ctrl: true })) {
          process.nextTick(this.exitHandler)
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

      this.setupInput()
      process.on("exit", this.nativeProcessExitHandler)
      void this.nativeSession.closed.then(
        () => this.removeCleanupListener(process, "exit", this.nativeProcessExitHandler),
        () => this.removeCleanupListener(process, "exit", this.nativeProcessExitHandler),
      )
      void this.nativeSession.closed.catch((error) => {
        if (this._isDestroyed) return
        try {
          this.handleError(error instanceof Error ? error : new Error(String(error)))
        } catch {
          // The original Session failure remains available through closed.
        } finally {
          this.destroy()
        }
      })
    } catch (error) {
      try {
        this.destroy()
      } catch (destroyError) {
        console.error("Error destroying partially constructed renderer:", destroyError)
      } finally {
        this.nativeSession.dispose()
        this.nativeDestroyWait?.resolve()
        this.releaseStreamLease()
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

  private startTerminalKeepAlive(): void {
    if (this.stdin !== process.stdin || this.terminalKeepAliveTimer !== null) return
    this.terminalKeepAliveTimer = setInterval(() => {}, 60_000)
  }

  private stopTerminalKeepAlive(): void {
    if (this.terminalKeepAliveTimer === null) return
    clearInterval(this.terminalKeepAliveTimer)
    this.terminalKeepAliveTimer = null
  }

  private removeExitListeners(): void {
    if (!this._exitListenersAdded || this.exitSignals.length === 0) return

    this.exitSignals.forEach((signal) => {
      this.removeCleanupListener(process, signal, this.exitHandler)
    })

    this._exitListenersAdded = false
  }

  private removeCleanupListener(target: EventEmitter, event: string, listener: (...args: any[]) => void): void {
    try {
      target.removeListener(event, listener)
    } catch (error) {
      if (!this._isDestroyed) throw error
      // EventEmitter removes the listener before notifying removal observers.
      // Their exceptions must not interrupt the remaining native teardown.
      console.error("Error removing native scene lifecycle listener:", error)
    }
  }

  public get isDestroyed(): boolean {
    return this._isDestroyed
  }

  public registerLifecyclePass(renderable: Renderable) {
    this.getLifecyclePasses().add(renderable)
  }

  public unregisterLifecyclePass(renderable: Renderable) {
    this.getLifecyclePasses().delete(renderable)
  }

  public getLifecyclePasses(): Set<Renderable> {
    return this.nativeScene.lifecyclePasses
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
    if (renderable.ctx !== this) {
      throw new Error("Cannot focus renderables from another render context")
    }
    this.changeFocus(renderable)
  }

  public blurRenderable(renderable: Renderable): void {
    if (this._currentFocusedRenderable !== renderable) {
      return
    }

    this.changeFocus(null)
  }

  private changeFocus(renderable: Renderable | null): void {
    if (this._currentFocusedRenderable === renderable) return
    const change = (this.focusChange = {})
    const previous = this._currentFocusedRenderable
    const previousEditor = this.currentFocusedEditor
    this._currentFocusedRenderable = renderable
    let failure: { error: unknown } | undefined
    const run = (operation: () => void) => {
      try {
        operation()
      } catch (error) {
        failure ??= { error }
      }
    }
    if (renderable) run(() => previous?.blur())
    // Editor observers must release the previous editor even when focus changed again.
    const currentEditor = this.currentFocusedEditor
    if (previousEditor !== currentEditor)
      run(() => this.emit(CliRenderEvents.FOCUSED_EDITOR, currentEditor, previousEditor))
    if (this.focusChange === change && this._currentFocusedRenderable === renderable && !renderable?.isDestroyed) {
      run(() => this.emit(CliRenderEvents.FOCUSED_RENDERABLE, renderable, previous))
    }
    if (failure) throw failure.error
  }

  private setCapturedRenderable(renderable: Renderable | undefined): void {
    if (this.capturedRenderable === renderable) {
      return
    }
    this.capturedRenderable = renderable
  }

  public get widthMethod(): WidthMethod {
    return this.capabilities?.unicode ?? this.nextRenderBuffer.widthMethod
  }

  public get frameId(): number {
    return this._frameId
  }

  private scheduleRenderAfterOutputIdle(): void {
    if (this.outputIdleRenderScheduled || this._isDestroyed) return

    this.outputIdleRenderScheduled = true
    this.nativeSession
      .idle()
      .then(() => {
        this.outputIdleRenderScheduled = false
        const ordinaryFrameWasWaiting = this.ordinaryFrameWaitingForOutput
        const ordinaryFrameWaitControlState = this.ordinaryFrameWaitControlState
        this.ordinaryFrameWaitingForOutput = false
        // An explicit frame may already own newer demand while this older wait completes.
        if (!this.rendering) this.ordinaryFrameWaitControlState = null
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
      .catch((error) => {
        this.outputIdleRenderScheduled = false
        this.ordinaryFrameWaitingForOutput = false
        this.ordinaryFrameWaitControlState = null
        if (!this._isDestroyed) this.handleError(error instanceof Error ? error : new Error(String(error)))
        this.resolveIdleIfNeeded()
      })
  }

  private scheduleRenderTimer(): void {
    if (
      this.renderTimeout ||
      this.cancelReadyFrame ||
      this._isDestroyed ||
      this._controlState === RendererControlState.EXPLICIT_SUSPENDED
    )
      return

    const now = this.normalizeClockTime(this.clock.now(), this.lastTime)
    const elapsed = this.getElapsedMs(now, this.lastTime)
    const delay = Math.max(this.minTargetFrameTime - elapsed, 0)
    this.renderTimeout = this.clock.setTimeout(() => {
      this.renderTimeout = null
      this.queueFrame()
    }, delay)
  }

  public requestRender() {
    if (this._isDestroyed || this._controlState === RendererControlState.EXPLICIT_SUSPENDED) {
      return
    }

    // A skipped frame owns its retry through Session.idle(). Coalesce invalidations
    // so split-footer output and UI updates do not compete while output is busy.
    if (this.outputIdleRenderScheduled) {
      this.ordinaryFrameWaitControlState = this._controlState
      return
    }

    if (this._isRunning) {
      if (!this.rendering && !this.renderTimeout && !this.cancelReadyFrame && !this.ordinaryFrameWaitingForOutput) {
        this.scheduleRenderTimer()
      }
      return
    }

    if (this.ordinaryFrameWaitingForOutput) {
      return
    }

    // NOTE: Using a frame callback that causes a re-render while already rendering
    // leads to a continuous loop of renders.
    if (this.rendering) {
      this.immediateRerenderRequested = true
      this.ordinaryFrameWaitControlState = this._controlState
      return
    }

    if (!this.cancelReadyFrame && !this.renderTimeout) {
      const now = this.normalizeClockTime(this.clock.now(), this.lastTime)
      const elapsed = this.getElapsedMs(now, this.lastTime)
      const delay = Math.max(this.minTargetFrameTime - elapsed, 0)

      if (delay === 0) {
        this.queueFrame()
        return
      }

      this.renderTimeout = this.clock.setTimeout(() => {
        this.renderTimeout = null
        this.queueFrame()
      }, delay)
    }
  }

  public get consoleMode(): ConsoleMode {
    return this._useConsole ? "console-overlay" : "disabled"
  }

  public set consoleMode(mode: ConsoleMode) {
    this._useConsole = mode === "console-overlay"
    if (this._useConsole) {
      this._console.activate()
    } else {
      this._console.deactivate()
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
      !this.nativeTerminalTransition &&
      !this.nativeResizeWait &&
      (!this.pendingNativeResize || this._controlState === RendererControlState.EXPLICIT_SUSPENDED) &&
      !this.renderTimeout &&
      !this.cancelReadyFrame &&
      !this.outputIdleRenderScheduled &&
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
    if (this._isDestroyed) return this.closed
    const idle = this.isIdleNow()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          this.idleResolvers.push(resolve)
        })
    return idle.then(() => this.nativeSession.idle())
  }

  public getSchedulerState(): RendererSchedulerState {
    return {
      isRunning: this._isRunning,
      isRendering: this.rendering,
      hasScheduledRender: Boolean(
        this.renderTimeout ||
        this.cancelReadyFrame ||
        this.outputIdleRenderScheduled ||
        this.immediateRerenderRequested ||
        this.nativeTerminalTransition ||
        this.nativeResizeWait ||
        (this.pendingNativeResize && this._controlState !== RendererControlState.EXPLICIT_SUSPENDED),
      ),
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
    if (this.nativeTerminalTransition || this._controlState === RendererControlState.EXPLICIT_SUSPENDED) {
      throw new Error("Cannot change native scene mouse modes during a terminal transition or suspension")
    }
    if (this._useMouse === useMouse) return // No change needed

    if (useMouse) {
      this.enableMouse()
      this.requestRender()
    } else {
      this.disableMouse()
      this.requestRender()
    }
  }

  public get screenMode(): ScreenMode {
    return this.pendingNativeMode?.screenMode ?? this._screenMode
  }

  public set screenMode(mode: ScreenMode) {
    if (this.pendingExternalOutputMode === "passthrough" && mode !== "split-footer") {
      this.applyScreenMode(mode)
      return
    }
    if (this.externalOutputMode === "capture-stdout" && mode !== "split-footer") {
      throw new Error('externalOutputMode "capture-stdout" requires screenMode "split-footer"')
    }

    this.applyScreenMode(mode)
  }

  public get footerHeight(): number {
    return this.pendingNativeMode?.footerHeight ?? this._footerHeight
  }

  public set footerHeight(footerHeight: number) {
    const normalizedFooterHeight = normalizeFooterHeight(footerHeight)
    if (normalizedFooterHeight === this.footerHeight) {
      return
    }

    if (this.screenMode === "split-footer") {
      this.applyScreenMode("split-footer", true, true, normalizedFooterHeight)
    } else {
      this._footerHeight = normalizedFooterHeight
    }
  }

  public get externalOutputMode(): ExternalOutputMode {
    return this.pendingExternalOutputMode ?? this._externalOutputMode
  }

  public set externalOutputMode(mode: ExternalOutputMode) {
    if (mode === "capture-stdout" && this.screenMode !== "split-footer") {
      throw new Error('externalOutputMode "capture-stdout" requires screenMode "split-footer"')
    }

    if (this._isDestroyed) {
      this.pendingExternalOutputMode = null
      this.applyExternalOutputMode(mode)
      return
    }
    if (this.rendering || this.pendingNativeMode || this.externalOutputQueue.size > 0) {
      this.pendingExternalOutputMode = mode
      this.requestRender()
      return
    }

    const previousMode = this._externalOutputMode
    if (previousMode === mode) {
      if (this.pendingExternalOutputMode !== null && this.pendingExternalOutputMode !== mode) {
        this.pendingExternalOutputMode = null
      }
      return
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
    if (this.rendering) return
    const pendingMode = this.pendingExternalOutputMode
    if (
      pendingMode === null ||
      (this.externalOutputQueue.size > 0 && !(pendingMode === "capture-stdout" && this._screenMode === "split-footer"))
    ) {
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

  public get liveRequestCount(): number {
    return this.liveRequestCounter
  }

  public get currentControlState(): string {
    return this._controlState
  }

  public get capabilities(): TerminalCapabilities | null {
    return this._capabilities
  }

  public get kittyImageTransport(): KittyImageTransport {
    return this.kittyTransportMode
  }

  public set kittyImageTransport(mode: KittyImageTransport) {
    const code = KITTY_IMAGE_TRANSPORTS.indexOf(mode)
    if (code < 0) throw new TypeError("Invalid kittyImageTransport")
    if (this._isDestroyed || mode === this.kittyTransportMode) return
    this.kittyTransportMode = mode
    this.startKittyTransportPolling()
    this.nativeSession.setKittyImageTransport(code)
    this.requestRender()
  }

  private startKittyTransportPolling(): void {
    if (!this._terminalIsSetup || this.kittyTransportMode !== "file" || this.kittyTransportTimer !== null) return
    // Old file transfers still need ACKs, expiry, and error cleanup after selecting an inline mode.
    this.stdout.on("error", this.kittyOutputErrorHandler)
    this.kittyTransportTimer = this.clock.setInterval(() => {
      if (!this._isDestroyed && this.nativeSession.pollKittyImageTransport()) this.requestRender()
    }, 1000)
  }

  public get kittyImageTransportStatus(): KittyImageTransportStatus {
    const status = this.nativeSession.getKittyImageTransport()
    return {
      requested: KITTY_IMAGE_TRANSPORTS[status.requested]!,
      effective: (["raw", "zlib", "png", "file"] as const)[status.effective]!,
      fileState: (["disabled", "probing", "ready", "unsupported", "timeout", "io-error", "cancelled"] as const)[
        status.fileState
      ]!,
      fallback: (["none", "not-ready", "unavailable", "budget", "busy", "preparation", "compression"] as const)[
        status.fallback
      ]!,
      pendingFiles: status.pendingFiles,
      pendingBytes: status.pendingBytes,
    }
  }

  public cancelKittyImageTransport(): void {
    if (this._isDestroyed) return
    this.nativeSession.cancelKittyImageTransport(false)
    this.requestRender()
  }

  private kittyOutputErrorHandler = (): void => {
    if (this._isDestroyed || this.nativeSession.disposed || this.nativeSession.error) return
    this.nativeSession.cancelKittyImageTransport(true)
  }

  public triggerNotification(message: string, title?: string): boolean {
    if (this._isDestroyed) return false
    return this.nativeSession.triggerNotification(message, title)
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
    return this.nativeKittyKeyboardFlags !== 0
  }

  public set useKittyKeyboard(use: boolean) {
    const flags = use ? KITTY_FLAG_DISAMBIGUATE | KITTY_FLAG_ALTERNATE_KEYS : 0
    this.enableKittyKeyboard(flags)
  }

  public createScrollbackSurface(options: ScrollbackSurfaceOptions = {}): ScrollbackSurface {
    if (this._isDestroyed) throw new Error("Renderer is destroyed")
    if (this.screenMode !== "split-footer" || this.externalOutputMode !== "capture-stdout") {
      throw new Error(
        'createScrollbackSurface requires screenMode "split-footer" and externalOutputMode "capture-stdout"',
      )
    }

    const renderer = this
    const surfaceId = scrollbackSurfaceCounter++
    const startOnNewLine = options.startOnNewLine ?? true
    const tailColumn = renderer.getPendingSplitTailColumn()
    const firstLineOffset = !startOnNewLine && tailColumn > 0 && tailColumn < renderer.width ? tailColumn : 0

    const snapshotContext = new ScrollbackSnapshotRenderContext(
      renderer.width,
      1,
      renderer.widthMethod,
      renderer._terminalWidth,
      renderer._terminalHeight,
      renderer.resolution,
      renderer.capabilities,
      renderer.nativeSession,
    )
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

    let internalRoot: RootRenderable | undefined
    let publicRoot: BoxRenderable
    let backingBuffer: OptimizedBuffer
    try {
      internalRoot = new RootRenderable(renderContext)
      snapshotContext.root = internalRoot
      publicRoot = new BoxRenderable(renderContext, {
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
      backingBuffer = OptimizedBuffer.create(renderer.width, 1, renderer.widthMethod, {
        id: `scrollback-surface-buffer-${surfaceId}`,
        owner: renderer.nativeScene,
      })
    } catch (error) {
      try {
        internalRoot?.destroyRecursively()
      } finally {
        snapshotContext.destroy()
      }
      throw error
    }

    let surfaceWidth = renderer.width
    let surfaceHeight = 1
    let surfaceWidthMethod = renderer.widthMethod
    let surfaceTerminalWidth = renderer._terminalWidth
    let surfaceTerminalHeight = renderer._terminalHeight
    let surfaceResolutionWidth = renderer.resolution?.width ?? null
    let surfaceResolutionHeight = renderer.resolution?.height ?? null
    let surfaceDestroyed = false
    let hasRendered = false
    let nextCommitStartOnNewLine = startOnNewLine
    const pendingWaits = new Set<() => void>()

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
      if (
        renderer.width !== surfaceWidth ||
        renderer.widthMethod !== surfaceWidthMethod ||
        renderer._terminalWidth !== surfaceTerminalWidth ||
        renderer._terminalHeight !== surfaceTerminalHeight ||
        (renderer.resolution?.width ?? null) !== surfaceResolutionWidth ||
        (renderer.resolution?.height ?? null) !== surfaceResolutionHeight
      ) {
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

    const collectPendingResources = (node: Renderable): Promise<void>[] => {
      const pending: Promise<void>[] = []
      for (const resource of snapshotContext.nativeScene.getRenderables()) {
        if (resource.isDestroyed) continue
        const promise =
          resource instanceof CodeRenderable && resource.isHighlighting
            ? resource.highlightingDone
            : resource instanceof ImageRenderable && resource.loading
              ? resource.loadPromise
              : null
        if (!promise) continue
        let ancestor: Renderable | null = resource
        while (ancestor && ancestor !== node) ancestor = ancestor.parent
        if (ancestor === node) pending.push(promise)
      }
      return pending
    }

    const waitForPendingHighlights = async (pending: Promise<void>[], timeoutMs: number): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: unknown): void => {
          if (settled) return
          settled = true
          renderer.clock.clearTimeout(timeoutHandle)
          pendingWaits.delete(cancel)
          if (error) reject(error)
          else resolve()
        }
        const cancel = () => finish(new Error("ScrollbackSurface is destroyed"))
        const timeoutHandle = renderer.clock.setTimeout(
          () => finish(new Error("ScrollbackSurface.settle timed out waiting for CodeRenderable highlighting")),
          timeoutMs,
        )
        pendingWaits.add(cancel)
        Promise.all(pending).then(() => finish(), finish)
      })
    }

    const renderSurface = (): void => {
      assertNotDestroyed()
      hasRendered = false

      const width = renderer.width
      const widthMethod = renderer.widthMethod

      snapshotContext.width = width
      snapshotContext.widthMethod = widthMethod
      snapshotContext.terminalWidth = renderer._terminalWidth
      snapshotContext.terminalHeight = renderer._terminalHeight
      snapshotContext.resolution = renderer.resolution
      snapshotContext.capabilities = renderer.capabilities
      publicRoot.width = width

      const renderPass = (height: number): void => {
        snapshotContext.height = height
        internalRoot!.resize(width, height)
        backingBuffer.resize(width, height)
        backingBuffer.clear(TRANSPARENT_RGBA)
        snapshotContext.frameId += 1
        snapshotContext.renderSnapshot(internalRoot!, backingBuffer)
      }

      let targetHeight = Math.max(1, surfaceHeight)

      if (surfaceWidthMethod !== widthMethod) {
        const replacement = OptimizedBuffer.create(width, targetHeight, widthMethod, {
          id: `scrollback-surface-buffer-${surfaceId}`,
          owner: renderer.nativeScene,
        })
        backingBuffer.destroy()
        backingBuffer = replacement
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
          surfaceTerminalWidth = renderer._terminalWidth
          surfaceTerminalHeight = renderer._terminalHeight
          surfaceResolutionWidth = renderer.resolution?.width ?? null
          surfaceResolutionHeight = renderer.resolution?.height ?? null
          hasRendered = true
          return
        }

        targetHeight = measuredHeight
      }

      renderPass(targetHeight)

      surfaceWidth = width
      surfaceHeight = targetHeight
      surfaceWidthMethod = widthMethod
      surfaceTerminalWidth = renderer._terminalWidth
      surfaceTerminalHeight = renderer._terminalHeight
      surfaceResolutionWidth = renderer.resolution?.width ?? null
      surfaceResolutionHeight = renderer.resolution?.height ?? null
      hasRendered = true
    }

    const settleSurface = async (timeoutMs: number = 2000): Promise<void> => {
      assertNotDestroyed()
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
        throw new Error("ScrollbackSurface.settle requires a finite non-negative timeout")

      const startedAt = renderer.clock.now()
      renderSurface()

      while (true) {
        assertNotDestroyed()

        const pending = collectPendingResources(publicRoot)
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
        owner: renderer.nativeScene,
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
        if (!renderer.externalOutputQueue.owns(commitBuffer)) commitBuffer.destroy()
        throw error
      }
    }

    const destroySurface = (): void => {
      if (surfaceDestroyed) {
        return
      }

      surfaceDestroyed = true
      renderer.detachedSurfaces.delete(destroySurface)
      for (const cancel of pendingWaits) cancel()

      let failure: { error: unknown } | undefined
      for (const cleanup of [
        () => internalRoot!.destroyRecursively(),
        () => backingBuffer.destroy(),
        () => renderContext.removeAllListeners(),
        () => snapshotContext.destroy(),
      ]) {
        try {
          cleanup()
        } catch (error) {
          failure ??= { error }
        }
      }
      if (failure) throw failure.error
    }

    renderer.detachedSurfaces.add(destroySurface)

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
    if (this._isDestroyed) throw new Error("Renderer is destroyed")
    if (this.screenMode !== "split-footer" || this.externalOutputMode !== "capture-stdout") {
      throw new Error('writeToScrollback requires screenMode "split-footer" and externalOutputMode "capture-stdout"')
    }

    const snapshotContext = new ScrollbackSnapshotRenderContext(
      this.width,
      this.height,
      this.widthMethod,
      this._terminalWidth,
      this._terminalHeight,
      this.resolution,
      this.capabilities,
      this.nativeSession,
    )
    let snapshot: ScrollbackSnapshot | undefined
    let renderFailed = false
    let snapshotRoot: RootRenderable | null = null
    let snapshotBuffer: OptimizedBuffer | null = null

    try {
      snapshotRoot = new RootRenderable(snapshotContext)
      snapshotContext.root = snapshotRoot
      snapshot = write({
        width: this.width,
        widthMethod: this.widthMethod,
        tailColumn: this.getPendingSplitTailColumn(),
        renderContext: snapshotContext,
      })
      if (!snapshot || !snapshot.root) throw new Error("writeToScrollback must return a snapshot root renderable")
      const rootRenderable = snapshot.root
      const snapshotWidth = this.getSnapshotWidth(snapshot.width, rootRenderable.width)
      const snapshotHeight = this.getSnapshotHeight(snapshot.height, rootRenderable.height)

      snapshotContext.width = snapshotWidth
      snapshotContext.height = snapshotHeight
      snapshotContext.widthMethod = this.widthMethod

      snapshotRoot.resize(snapshotWidth, snapshotHeight)
      snapshotBuffer = OptimizedBuffer.create(snapshotWidth, snapshotHeight, this.widthMethod, {
        id: "scrollback-snapshot-commit",
        owner: this.nativeScene,
      })

      // Render through normal renderables so split scrollback output uses the same
      // text shaping/styling pipeline as the rest of the renderer.
      snapshotRoot.add(rootRenderable)
      snapshotContext.renderSnapshot(snapshotRoot, snapshotBuffer)
      this.enqueueRenderedScrollbackCommit({
        snapshot: snapshotBuffer,
        rowColumns: snapshot.rowColumns,
        startOnNewLine: snapshot.startOnNewLine,
        trailingNewline: snapshot.trailingNewline,
      })
    } catch (error) {
      renderFailed = true
      if (snapshotBuffer && !this.externalOutputQueue.owns(snapshotBuffer)) snapshotBuffer.destroy()
      throw error
    } finally {
      let cleanupError: unknown | null = null

      try {
        snapshotRoot?.destroyRecursively()
      } catch (error) {
        cleanupError = error
      }

      try {
        snapshot?.teardown?.()
      } catch (error) {
        if (cleanupError === null) {
          cleanupError = error
        }
      }

      try {
        snapshotContext.destroy()
      } catch (error) {
        cleanupError ??= error
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

    if (this.rendering || this.externalOutputQueue.size > 0) {
      this.pendingNativeReplay = { options, remaining: this.externalOutputQueue.size }
      this.requestRender()
      return
    }
    this.applySplitFooterReplayReset(options)
  }

  private applySplitFooterReplayReset(options: SplitFooterReplayResetOptions): void {
    const bytes = this.lib.encoder.encode(
      ANSI.resetScrollRegion +
        ANSI.reset +
        ANSI.home +
        ANSI.clearScreen +
        (options.clearSavedLines ? ANSI.clearSavedLines : "") +
        ANSI.home,
    )
    if (!this.nativeSession.write(bytes))
      throw new NativeError("Native terminal output", NativeStatus.OutputBackpressure)
    this.abortSplitStartupCursorSeed()
    this.clearPendingSplitFooterTransition()
    this.resetSplitScrollback()
    this.pendingNativeReplay = null
    this.forceFullRepaintRequested = true
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
    return snapshot.withBuffers(({ width, height, char }) => {
      const widths: number[] = []
      const limit = Math.min(Math.max(Math.trunc(rowColumns), 0), width)

      for (let y = 0; y < height; y += 1) {
        let x = limit

        while (x > 0) {
          const cp = char[y * width + x - 1]
          if (cp === 0 || (cp & CHAR_FLAG_MASK) === CHAR_FLAG_CONTINUATION) {
            x -= 1
            continue
          }

          break
        }

        widths.push(x)
      }

      return widths
    })
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
    let tailColumn = this.pendingNativeReplay ? 0 : this.splitTailColumn

    for (const commit of this.externalOutputQueue.peek().slice(this.pendingNativeReplay?.remaining ?? 0)) {
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
    if (this.screenMode !== "split-footer" || this.externalOutputMode !== "capture-stdout") {
      throw new Error('scrollback commit requires screenMode "split-footer" and externalOutputMode "capture-stdout"')
    }

    const rowColumns = Math.min(
      Math.max(Math.trunc(options.rowColumns ?? options.snapshot.width), 0),
      options.snapshot.width,
    )

    this.enqueueSplitCommits([
      {
        snapshot: options.snapshot,
        rowColumns,
        startOnNewLine: options.startOnNewLine ?? true,
        trailingNewline: options.trailingNewline ?? true,
      },
    ])
  }

  private enqueueSplitCommits(commits: readonly ExternalOutputCommit[]): void {
    for (const commit of commits) commit.nativeSnapshot = commit.snapshot._getSceneHandle(this.nativeScene)
    this.externalOutputQueue.writeSnapshots(commits)
    this.requestRender()
    if (this.listenerCount(CliRenderEvents.EXTERNAL_OUTPUT) > 0) {
      for (const commit of commits) this.emit(CliRenderEvents.EXTERNAL_OUTPUT, commit)
    }
  }

  private createStdoutSnapshotCommit(line: string, trailingNewline: boolean): ExternalOutputCommit {
    // Convert captured stdout into the same commit shape used by writeToScrollback.
    // One commit format keeps split append behavior consistent across both sources.
    const snapshotContext = new ScrollbackSnapshotRenderContext(
      this.width,
      1,
      this.widthMethod,
      this._terminalWidth,
      this._terminalHeight,
      this.resolution,
      this.capabilities,
      this.nativeSession,
    )
    const maxWidth = Math.max(1, this.width)
    const lineCells = [...line]
    const rowColumns = Math.min(lineCells.length, maxWidth)
    const renderedLine = lineCells.slice(0, maxWidth).join("")
    snapshotContext.width = Math.max(1, rowColumns)
    let snapshotRoot: RootRenderable | undefined
    let snapshotBuffer: OptimizedBuffer | undefined
    try {
      snapshotRoot = new RootRenderable(snapshotContext)
      const snapshotRenderable = new TextRenderable(snapshotContext, {
        id: "captured-stdout-snapshot",
        position: "absolute",
        left: 0,
        top: 0,
        width: Math.max(1, rowColumns),
        height: 1,
        content: renderedLine,
      })
      snapshotBuffer = OptimizedBuffer.create(Math.max(1, rowColumns), 1, this.widthMethod, {
        id: "captured-stdout-snapshot",
        owner: this.nativeScene,
      })
      snapshotRoot.add(snapshotRenderable)
      snapshotContext.renderSnapshot(snapshotRoot, snapshotBuffer)
      return {
        snapshot: snapshotBuffer,
        rowColumns,
        startOnNewLine: false,
        trailingNewline,
      }
    } catch (error) {
      snapshotBuffer?.destroy()
      throw error
    } finally {
      try {
        snapshotRoot?.destroyRecursively()
      } finally {
        snapshotContext.destroy()
      }
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
    if (BigInt(Buffer.byteLength(text)) > this.nativeSession.maxWriteBytes) {
      throw new Error("Captured stdout exceeds the Session output capacity")
    }

    // Chunk captured stdout into width-bounded row commits so each commit is a
    // small, deterministic append step. This keeps bursty output smooth while
    // preserving newline ownership on the final chunk of each logical row.
    const commits: ExternalOutputCommit[] = []
    // Split commits are row-oriented snapshots. We chunk by renderer width so each
    // commit maps to a single logical terminal row append operation.
    const chunkWidth = Math.max(1, this.width)
    const append = (line: string, trailingNewline: boolean): void => {
      if (commits.length >= this.nativeSession.maxSnapshotCount - this.externalOutputQueue.size) {
        throw new Error("Scrollback snapshot queue capacity exceeded")
      }
      commits.push(this.createStdoutSnapshotCommit(line, trailingNewline))
    }
    try {
      for (const row of this.splitStdoutRows(text)) {
        const rowCells = [...row.line]
        if (rowCells.length === 0) {
          // Preserve empty-line writes: newline-only chunks still need a commit so
          // split scrollback state advances correctly in native code.
          append("", row.trailingNewline)
          continue
        }

        let offset = 0
        while (offset < rowCells.length) {
          const chunk = rowCells.slice(offset, offset + chunkWidth).join("")
          offset += chunkWidth
          const isLastChunk = offset >= rowCells.length
          // Only the final wrapped chunk carries newline intent.
          append(chunk, isLastChunk ? row.trailingNewline : false)
        }
      }

      return commits
    } catch (error) {
      for (const commit of commits) commit.snapshot.destroy()
      throw error
    }
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
      try {
        this.enqueueSplitCommits(commits)
      } catch (error) {
        for (const commit of commits) {
          if (!this.externalOutputQueue.owns(commit.snapshot)) commit.snapshot.destroy()
        }
        throw error
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
    const cursorState = this.getCursorState()
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

  private resetSplitScrollback(seedRows: number = 0): void {
    this.renderOffset = this.lib.sessionSplitControl(this.nativeSession.context, this.nativeSession.session, {
      kind: "reset",
      seedRows,
      pinnedRenderOffset: this.getSplitPinnedRenderOffset(),
    })
    this.splitTailColumn = 0
  }

  private syncSplitScrollback(): void {
    this.renderOffset = this.lib.sessionSplitControl(this.nativeSession.context, this.nativeSession.session, {
      kind: "sync",
      pinnedRenderOffset: this.getSplitPinnedRenderOffset(),
    })
  }

  private getSplitOutputOffset(surfaceOffset: number = this.renderOffset): number {
    return this.lib.sessionSplitControl(this.nativeSession.context, this.nativeSession.session, {
      kind: "output-offset",
      surfaceOffset,
    })
  }

  private clearPendingSplitFooterTransition(): void {
    if (this.pendingSplitFooterTransition === null) {
      return
    }

    this.lib.sessionSplitControl(this.nativeSession.context, this.nativeSession.session, { kind: "clear-transition" })
    this.pendingSplitFooterTransition = null
  }

  private setPendingSplitFooterTransition(transition: PendingSplitFooterTransition): void {
    this.lib.sessionSplitControl(this.nativeSession.context, this.nativeSession.session, {
      kind: "transition",
      ...transition,
    })
    this.pendingSplitFooterTransition = transition
  }

  private setRenderOffset(offset: number): void {
    this.lib.sessionSplitControl(this.nativeSession.context, this.nativeSession.session, {
      kind: "render-offset",
      renderOffset: offset,
    })
    this.renderOffset = offset
  }

  private syncSplitFooterState(): void {
    const splitActive = this._screenMode === "split-footer" && this._splitHeight > 0

    if (!splitActive) {
      this.clearPendingSplitFooterTransition()
      this.splitTailColumn = 0
      this.resetSplitScrollback()
      this.setRenderOffset(0)
      return
    }

    if (this._externalOutputMode === "capture-stdout") {
      this.syncSplitScrollback()
    } else {
      this.clearPendingSplitFooterTransition()
      this.splitTailColumn = 0
      this.resetSplitScrollback()
      this.setRenderOffset(this.getSplitPinnedRenderOffset())
    }
  }

  private getStaleSplitSurfaceClear(
    previousTopLine: number,
    previousHeight: number,
    nextTopLine: number,
    nextHeight: number,
  ): string {
    if (!this._terminalIsSetup || previousHeight <= 0 || this._terminalHeight <= 0) {
      return ""
    }

    const terminalBottom = this._terminalHeight
    const previousStart = Math.max(1, previousTopLine)
    const previousEnd = Math.min(terminalBottom, previousTopLine + previousHeight - 1)

    if (previousEnd < previousStart) {
      return ""
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

    return clear
  }

  private applyScreenMode(
    screenMode: ScreenMode,
    emitResize: boolean = true,
    requestRender: boolean = true,
    footerHeight: number = this._footerHeight,
  ): void {
    if (this._isDestroyed) return
    if (this.nativeTerminalTransition && this._screenMode !== screenMode) {
      throw new Error("Cannot change native scene screen mode during a terminal transition")
    }
    if (this._screenMode === "split-footer" && screenMode !== "split-footer") {
      this.abortSplitStartupCursorSeed()
    }
    if (
      this.rendering ||
      (this._screenMode === "split-footer" && this.externalOutputQueue.size > 0) ||
      this.nativeTerminalTransition
    ) {
      this.pendingNativeMode = { screenMode, footerHeight }
      this.requestRender()
      return
    }
    const prevScreenMode = this._screenMode
    const prevSplitHeight = this._splitHeight
    const nextGeometry = calculateRenderGeometry(screenMode, this._terminalWidth, this._terminalHeight, footerHeight)
    const nextSplitHeight = nextGeometry.effectiveFooterHeight

    if (prevScreenMode === screenMode && prevSplitHeight === nextSplitHeight) {
      this._footerHeight = footerHeight
      this.pendingNativeMode = null
      return
    }

    const terminalWritable = this._terminalIsSetup && this._controlState !== RendererControlState.EXPLICIT_SUSPENDED
    const prevUseAlternateScreen = prevScreenMode === "alternate-screen"
    const nextUseAlternateScreen = screenMode === "alternate-screen"
    const terminalScreenModeChanged = this._terminalIsSetup && prevUseAlternateScreen !== nextUseAlternateScreen
    const leavingSplitFooter = prevSplitHeight > 0 && nextSplitHeight === 0

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

    let scrollOutput = ""
    if (terminalWritable && !terminalScreenModeChanged && !shouldDeferSplitFooterResizeTransition) {
      if (prevSplitHeight === 0 && nextSplitHeight > 0) {
        scrollOutput = ANSI.scrollDown(this._terminalHeight - nextSplitHeight)
      } else if (splitViewportScrollLines > 0) {
        scrollOutput = ANSI.scrollUp(splitViewportScrollLines)
      }
    }
    const clearOutput =
      terminalWritable && leavingSplitFooter && !terminalScreenModeChanged
        ? ANSI.moveCursorAndClear(splitTransitionSourceTopLine, 1)
        : shouldClearSplitSurfaceRowsImmediately
          ? this.getStaleSplitSurfaceClear(
              splitTransitionSourceTopLine,
              splitTransitionSourceHeight,
              this._externalOutputMode === "capture-stdout" ? splitTransitionTargetTopLine : nextPinnedRenderOffset + 1,
              nextSplitHeight,
            )
          : ""

    this.nativeSession.setScreen(
      nextUseAlternateScreen,
      nextGeometry.renderWidth,
      nextGeometry.renderHeight,
      this.lib.encoder.encode(scrollOutput + clearOutput),
    )

    // Custom stdout writes can synchronously inspect the renderer and its buffers.
    this._screenMode = screenMode
    this._footerHeight = footerHeight
    this._splitHeight = nextSplitHeight
    this.width = nextGeometry.renderWidth
    this.height = nextGeometry.renderHeight
    this.pendingNativeMode = null

    if (terminalWritable && leavingSplitFooter) {
      this.clearPendingSplitFooterTransition()
      this.renderOffset = 0
      this.setRenderOffset(0)
    }

    if (this._screenMode === "split-footer" && this._externalOutputMode === "capture-stdout") {
      if (prevScreenMode !== "split-footer") {
        this.resetSplitScrollback(this.getSplitCursorSeedRows())
      } else {
        this.renderOffset = nextSplitSurfaceOffset
        this.setRenderOffset(this.renderOffset)
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
      } else {
        this.clearPendingSplitFooterTransition()
      }
    } else {
      this.syncSplitFooterState()
    }

    this._console.resize(this.width, this.height)
    this.root.resize(this.width, this.height)

    if (emitResize) {
      this.emit(CliRenderEvents.RESIZE, this.width, this.height)
    }

    if (requestRender) {
      this.requestRender()
    }
  }

  private applyPendingNativeMode(): void {
    if (this._isDestroyed || this.rendering || this.nativeSplitFlush) return
    try {
      if (this.pendingNativeReplay?.remaining === 0) this.applySplitFooterReplayReset(this.pendingNativeReplay.options)
      if (this.pendingExternalOutputMode === "capture-stdout" && this._screenMode === "split-footer") {
        this.applyPendingExternalOutputModeIfReady()
      }
      if (this._screenMode === "split-footer" && this.externalOutputQueue.size > 0) return
      if (this.pendingExternalOutputMode === "passthrough") this.applyPendingExternalOutputModeIfReady()
      const mode = this.pendingNativeMode
      if (mode) this.applyScreenMode(mode.screenMode, true, true, mode.footerHeight)
      if (!this.pendingNativeMode) this.applyPendingExternalOutputModeIfReady()
    } catch (error) {
      if (
        error instanceof NativeError &&
        (error.status === NativeStatus.OutputBusy || error.status === NativeStatus.OutputBackpressure)
      ) {
        this.scheduleRenderAfterOutputIdle()
      } else throw error
    }
  }

  private enableMouse(): void {
    if (this._terminalIsSetup)
      this.nativeSession.control({ kind: "mouse", mode: this.enableMouseMovement ? "motion" : "drag" })
    this._useMouse = true
  }

  private disableMouse(): void {
    if (this._terminalIsSetup && !this._isDestroyed && this._controlState !== RendererControlState.EXPLICIT_SUSPENDED) {
      this.nativeSession.control({ kind: "mouse", mode: "disabled" })
    }
    this._useMouse = false
    this.setCapturedRenderable(undefined)
    this.stdinParser?.resetMouseState()
  }

  public enableKittyKeyboard(flags: number = 0b00011): void {
    if (this.nativeTerminalTransition || this._controlState === RendererControlState.EXPLICIT_SUSPENDED) {
      throw new Error("Cannot change native scene Kitty modes during a terminal transition or suspension")
    }
    if (!Number.isInteger(flags) || flags < 0 || flags > 31)
      throw new RangeError("Native scene Kitty flags must be in 0..31")
    if (this._terminalIsSetup) this.nativeSession.control({ kind: "kitty-keyboard-flags", flags })
    this.nativeKittyKeyboardFlags = flags
    this.updateStdinParserProtocolContext({ kittyKeyboardEnabled: flags !== 0 })
  }

  public disableKittyKeyboard(): void {
    if (this.nativeTerminalTransition || this._controlState === RendererControlState.EXPLICIT_SUSPENDED) {
      throw new Error("Cannot change native scene Kitty modes during a terminal transition or suspension")
    }
    if (this._terminalIsSetup) this.nativeSession.control({ kind: "kitty-keyboard-flags", flags: 0 })
    this.nativeKittyKeyboardFlags = 0
    this.updateStdinParserProtocolContext({ kittyKeyboardEnabled: false }, true)
  }

  // TODO: All input management may move to native when zig finally has async io support again,
  // without rolling a full event loop
  public async setupTerminal(): Promise<void> {
    if (this._terminalIsSetup) return
    if (this.nativeTerminalTransition) return this.nativeTerminalTransition

    const startupCursorCprActive = this._screenMode === "split-footer" && this._externalOutputMode === "capture-stdout"
    this.pendingSplitStartupCursorSeed = startupCursorCprActive
    this.updateStdinParserProtocolContext({
      privateCapabilityRepliesActive: true,
      explicitWidthCprActive: true,
      startupCursorCprActive,
    })
    try {
      await this.trackNativeTerminalTransition(
        this.nativeSession.setupTerminal({
          useAlternateScreen: this._screenMode === "alternate-screen",
          mouse: this._useMouse,
          mouseMovement: this.enableMouseMovement,
          kittyKeyboardFlags: this.nativeKittyKeyboardFlags,
          clearOnClose: this.clearOnShutdown,
        }),
        () => {
          if (this._isDestroyed) return
          this._terminalIsSetup = true
          this._capabilities = this.nativeSession.getCapabilities()
          this.startKittyTransportPolling()
          this.nativeSession.startKittyFileProbe()
        },
      )
    } catch (error) {
      this.abortSplitStartupCursorSeed()
      this.updateStdinParserProtocolContext({ privateCapabilityRepliesActive: false, explicitWidthCprActive: false })
      throw error
    }
    if (this._isDestroyed) return

    if (this.debugOverlay.enabled) {
      this.configureDebugOverlay({})
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

    if (this.pendingSplitStartupCursorSeed) {
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

        if (this.externalOutputQueue.size > 0) this.requestRender()
      }, 120)
    }

    this.queryPixelResolution()
    if (this.shouldSyncNativePaletteState()) {
      this.refreshPalette()
    }
  }

  private trackNativeTerminalTransition(transition: Promise<void>, complete?: () => void): Promise<void> {
    // Publish host state before releasing the option guard or the caller's wait.
    const tracked = transition
      .then(() => complete?.())
      .finally(() => {
        if (this.nativeTerminalTransition === tracked) this.nativeTerminalTransition = null
        this.applyPendingNativeResize()
        this.resolveIdleIfNeeded()
      })
    this.nativeTerminalTransition = tracked
    void tracked.catch((error) => {
      if (!this._isDestroyed) this.handleError(error instanceof Error ? error : new Error(String(error)))
    })
    return tracked
  }

  private stdinListener: (chunk: Buffer | string) => void = ((chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (!this.stdinParser) return

    if (this.stdinLogPath) {
      appendFileSync(this.stdinLogPath, data)
    }

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
      hasStandardCapabilitySignature ||
      (hasCursorReport && (this.capabilityTimeoutId !== null || this.nativeTerminalTransition !== null))

    if (!shouldProcessAsCapability) {
      return false
    }

    const transition = hasCursorReport && this.pendingSplitStartupCursorSeed ? this.pendingSplitFooterTransition : null
    // Native controls require idle split state; a rejected reply must retain the transition.
    if (transition) this.clearPendingSplitFooterTransition()
    try {
      this.nativeSession.control({ kind: "capability-response", bytes: Buffer.from(sequence) })
    } catch (error) {
      if (error instanceof NativeError && error.status === NativeStatus.InvalidPhase) return false
      throw error
    } finally {
      if (transition) this.setPendingSplitFooterTransition(transition)
    }
    this._capabilities = this.nativeSession.getCapabilities()
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
        this.nativeSession.control({ kind: "restore-modes" })
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
    // Native resume can publish probes before the JS control state is restored.
    if (event.type === "response" && event.sequence.startsWith("\x1b_G")) {
      try {
        const result = this.nativeSession.processKittyImageReply(Buffer.from(event.sequence))
        if (result !== 0) {
          if (result === 2) this.requestRender()
          return
        }
      } catch (error) {
        if (
          !(error instanceof NativeError) ||
          (error.status !== NativeStatus.SessionClosed &&
            error.status !== NativeStatus.StaleHandle &&
            error.status !== NativeStatus.RendererNotAttached)
        ) {
          throw error
        }
      }
    }
    if (this._controlState === RendererControlState.EXPLICIT_SUSPENDED) {
      if (event.type === "response" && isPixelResolutionResponse(event.sequence)) {
        this.dispatchSequenceHandlers(event.sequence)
      }
      return
    }
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
    if (this.stdinLogPath) {
      writeFileSync(this.stdinLogPath, Buffer.alloc(0), { mode: 0o600 })
    }

    for (const handler of this.prependedInputHandlers) {
      this.addInputHandler(handler)
    }

    this.addInputHandler((sequence: string) => {
      if (isPixelResolutionResponse(sequence) && this.waitingForPixelResolution) {
        this.waitingForPixelResolution = false
        if (this.pixelResolutionRequeryPending) {
          this.updateStdinParserProtocolContext({ pixelResolutionQueryActive: false })
          this.queryPixelResolution()
          return true
        }
        try {
          const resolution = parsePixelResolution(sequence)
          if (resolution) {
            this.lib.sessionSetImageResolution(
              this.nativeSession.context,
              this.nativeSession.session,
              this._terminalWidth,
              this._terminalHeight,
              resolution.width,
              resolution.height,
            )
            this._resolution = resolution
            this.requestRender()
          }
        } finally {
          this.updateStdinParserProtocolContext({ pixelResolutionQueryActive: false }, true)
        }
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
    this.startTerminalKeepAlive()
  }

  private dispatchMouseEvent(
    target: Renderable,
    attributes: RawMouseEvent & { source?: Renderable; isDragging?: boolean },
  ): MouseEvent {
    const event = new MouseEvent(target, attributes)
    this.sendMouseEvent(target, event)
    if (this._isDestroyed || target.isDestroyed) return event

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

  private sendMouseEvent(target: Renderable, event: MouseEvent): void {
    if (this._isDestroyed || target.isDestroyed) return
    try {
      target.processMouseEvent(event)
    } catch (error) {
      const handled = this.emit(CliRenderEvents.HANDLER_ERROR, { error, event } satisfies CliRendererHandlerErrorEvent)
      if (!handled) console.error("Error in mouse handler:", error)
    }
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
        this.sendMouseEvent(scrollTarget, event)
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
        this.startSelection(
          maybeRenderable,
          mouseEvent.x,
          mouseEvent.y,
          this.nextClickBehavior(maybeRenderable, mouseEvent.x, mouseEvent.y),
        )
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
        this.sendMouseEvent(maybeRenderable, event)
      }

      return true
    }

    if (mouseEvent.type === "up" && mouseEvent.button === MouseButton.LEFT && this.currentSelection?.isDragging) {
      if (maybeRenderable) {
        const event = new MouseEvent(maybeRenderable, {
          ...mouseEvent,
          isDragging: true,
        })
        this.sendMouseEvent(maybeRenderable, event)
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
        this.sendMouseEvent(this.lastOverRenderable, event)
      }
      this.lastOverRenderable = maybeRenderable
      if (maybeRenderable) {
        const event = new MouseEvent(maybeRenderable, {
          ...mouseEvent,
          type: "over",
          source: this.capturedRenderable,
        })
        this.sendMouseEvent(maybeRenderable, event)
      }
    }

    if (this.capturedRenderable && mouseEvent.type !== "up") {
      const event = new MouseEvent(this.capturedRenderable, mouseEvent)
      this.sendMouseEvent(this.capturedRenderable, event)
      return true
    }

    if (this.capturedRenderable && mouseEvent.type === "up") {
      const event = new MouseEvent(this.capturedRenderable, {
        ...mouseEvent,
        type: "drag-end",
      })
      this.sendMouseEvent(this.capturedRenderable, event)
      this.sendMouseEvent(this.capturedRenderable, new MouseEvent(this.capturedRenderable, mouseEvent))
      if (maybeRenderable) {
        const event = new MouseEvent(maybeRenderable, {
          ...mouseEvent,
          type: "drop",
          source: this.capturedRenderable,
        })
        this.sendMouseEvent(maybeRenderable, event)
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

    if (
      !event?.defaultPrevented &&
      mouseEvent.type === "down" &&
      mouseEvent.button === MouseButton.LEFT &&
      this.currentSelection
    ) {
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
      this.sendMouseEvent(lastOver, event)
    }
    if (this._isDestroyed || this.capturedRenderable || this.lastOverRenderable !== lastOver) return

    this.lastOverRenderable = hitRenderable?.isDestroyed ? undefined : hitRenderable
    this.lastOverRenderableNum = this.lastOverRenderable?.num ?? 0

    // Fire over on new element
    if (hitRenderable && !hitRenderable.isDestroyed) {
      const event = new MouseEvent(hitRenderable, {
        ...baseEvent,
        type: "over",
      })
      this.sendMouseEvent(hitRenderable, event)
      if (this.lastOverRenderable === hitRenderable && (this._isDestroyed || hitRenderable.isDestroyed)) {
        this.lastOverRenderable = undefined
        this.lastOverRenderableNum = 0
      }
    }
  }
  public setMousePointer(style: MousePointerStyle): void {
    this.setCursorStyle({ cursor: style })
  }

  public hitTest(x: number, y: number): number {
    return this.nativeScene.hitTest(x, y)
  }

  private takeMemorySnapshot(): void {
    if (this._isDestroyed) return

    const memoryUsage = process.memoryUsage()
    this.lastMemorySnapshot = {
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      arrayBuffers: memoryUsage.arrayBuffers,
    }

    this.lib.sessionUpdateMemoryStats(
      this.nativeSession.context,
      this.nativeSession.session,
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

  /** Queue a debounced resize intent. RESIZE is emitted only after the latest size is accepted. */
  public requestResize(width: number, height: number): void {
    if (this._isDestroyed) return
    this.pendingNativeResize = { width, height }
    if (this._splitHeight > 0) {
      this.applyPendingNativeResize()
      return
    }

    if (this.resizeTimeoutId !== null) {
      this.clock.clearTimeout(this.resizeTimeoutId)
      this.resizeTimeoutId = null
    }

    this.resizeTimeoutId = this.clock.setTimeout(() => {
      this.resizeTimeoutId = null
      this.applyPendingNativeResize()
    }, this.resizeDebounceDelay)
  }

  private applyPendingNativeResize(): void {
    const resize = this.pendingNativeResize
    if (
      !resize ||
      this._isDestroyed ||
      this.rendering ||
      this.resizeTimeoutId !== null ||
      this.nativeResizeWait ||
      this.nativeTerminalTransition ||
      this._controlState === RendererControlState.EXPLICIT_SUSPENDED
    )
      return
    if (this.externalOutputQueue.size > 0 && !this.isSplitCursorSeedFrameBlocked()) {
      this.requestRender()
      return
    }
    try {
      this.processResize(resize.width, resize.height)
      if (this.pendingNativeResize === resize) this.pendingNativeResize = null
    } catch (error) {
      if (error instanceof NativeError && error.status === NativeStatus.InvalidPhase) return
      if (error instanceof NativeError && error.status === NativeStatus.OutputBusy) {
        // One wait per blocked resize. New terminal sizes replace the retained
        // intent; frame finalization or resume handles an active renderer turn.
        const wait = this.nativeSession.idle()
        this.nativeResizeWait = wait
        void wait.then(
          () => {
            this.nativeResizeWait = null
            this.applyPendingNativeResize()
            this.resolveIdleIfNeeded()
          },
          (error) => {
            this.nativeResizeWait = null
            this.pendingNativeResize = null
            if (!this._isDestroyed) this.handleError(error instanceof Error ? error : new Error(String(error)))
            this.resolveIdleIfNeeded()
          },
        )
        return
      }
      if (this.pendingNativeResize === resize) this.pendingNativeResize = null
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    }
    this.resolveIdleIfNeeded()
  }

  private pixelResolutionRetry: Promise<void> | null = null

  private queryPixelResolution(retry = true) {
    this.pixelResolutionRequeryPending = true
    if (
      this._isDestroyed ||
      !this._terminalIsSetup ||
      this._controlState === RendererControlState.EXPLICIT_SUSPENDED ||
      this.waitingForPixelResolution ||
      this.pixelResolutionRetry
    )
      return
    this.pixelResolutionRequeryPending = false
    this.waitingForPixelResolution = true
    this.updateStdinParserProtocolContext({ pixelResolutionQueryActive: true })
    try {
      this.nativeSession.control({ kind: "query-pixel-resolution" })
    } catch (error) {
      this.waitingForPixelResolution = false
      this.pixelResolutionRequeryPending = true
      this.updateStdinParserProtocolContext({ pixelResolutionQueryActive: false })
      if (!(error instanceof NativeError)) throw error
      if (error.status === NativeStatus.InvalidPhase) return
      if (error.status !== NativeStatus.OutputBackpressure && error.status !== NativeStatus.OutputBusy) throw error
      if (!retry) return
      // One coalesced retry after output drains; further pressure retains intent for the next lifecycle query.
      const wait = this.nativeSession.idle()
      this.pixelResolutionRetry = wait
      void wait.then(
        () => {
          this.pixelResolutionRetry = null
          if (!this._isDestroyed && this.pixelResolutionRequeryPending) {
            try {
              this.queryPixelResolution(false)
            } catch (error) {
              this.handleError(error instanceof Error ? error : new Error(String(error)))
            }
          }
        },
        (error) => {
          this.pixelResolutionRetry = null
          if (!this._isDestroyed) this.handleError(error instanceof Error ? error : new Error(String(error)))
        },
      )
    }
  }

  private processResize(width: number, height: number): void {
    if (width === this._terminalWidth && height === this._terminalHeight) return

    const terminalWritable = this._terminalIsSetup && this._controlState !== RendererControlState.EXPLICIT_SUSPENDED
    if (terminalWritable && !this.isSplitCursorSeedFrameBlocked() && this.externalOutputQueue.size > 0) {
      this.pendingNativeResize = { width, height }
      this.requestRender()
      return
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

    const nextGeometry = calculateRenderGeometry(this._screenMode, width, height, this._footerHeight)
    const splitFooterActive = this._screenMode === "split-footer"
    let clearStart: number | null = null
    if (splitFooterActive && terminalWritable) {
      // Width shrink needs a broader scrub band, including any deferred transition's visible source.
      if (width < prevWidth && visiblePreviousSplitHeight > 0) {
        clearStart = Math.max(previousTerminalHeight - visiblePreviousSplitHeight * 2, 1)
      }
      if (pendingSplitFooterTransition !== null) {
        clearStart =
          clearStart === null
            ? pendingSplitFooterTransition.sourceTopLine
            : Math.min(clearStart, pendingSplitFooterTransition.sourceTopLine)
      }
    }
    if (clearStart === null) this.nativeSession.resize(nextGeometry.renderWidth, nextGeometry.renderHeight)
    else {
      // Preserve the drain gate without publishing the target size before scrub admission.
      this.nativeSession.resize(this.width, this.height)
      this.nativeSession.setScreen(
        this._screenMode === "alternate-screen",
        nextGeometry.renderWidth,
        nextGeometry.renderHeight,
        this.lib.encoder.encode(ANSI.moveCursorAndClear(clearStart, 1)),
      )
    }

    if (nextGeometry.renderWidth !== this.width || nextGeometry.renderHeight !== this.height) {
      this.nativeScene.restartPaint()
    }

    this._terminalWidth = width
    this._terminalHeight = height
    this._splitHeight = nextGeometry.effectiveFooterHeight
    this.width = nextGeometry.renderWidth
    this.height = nextGeometry.renderHeight

    this._resolution = null
    this.lib.sessionSetImageResolution(this.nativeSession.context, this.nativeSession.session, 0, 0, 0, 0)

    this.setCapturedRenderable(undefined)
    this.stdinParser?.resetMouseState()

    if (splitFooterActive) {
      this.forceFullRepaintRequested = true
    }

    this.clearPendingSplitFooterTransition()

    if (this._screenMode === "split-footer" && this._externalOutputMode === "capture-stdout") {
      this.syncSplitScrollback()
    } else if (splitFooterActive) {
      this.syncSplitFooterState()
    }

    this._console.resize(this.width, this.height)
    this.root.resize(this.width, this.height)
    this.queryPixelResolution()
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
    const pending = this.pendingNativeResize
    this.processResize(width, height)
    if (this.pendingNativeResize === pending) {
      this.pendingNativeResize = null
      this.resolveIdleIfNeeded()
    }
  }

  public setBackgroundColor(color: ColorInput): void {
    this.backgroundColor = RGBA.clone(parseColor(color))
    this.requestRender()
  }

  public toggleDebugOverlay(): void {
    const willBeEnabled = !this.debugOverlay.enabled
    this.configureDebugOverlay({ enabled: willBeEnabled })

    if (willBeEnabled && !this.memorySnapshotInterval) {
      this.memorySnapshotInterval = 3000
      this.startMemorySnapshotTimer()
      this.automaticMemorySnapshot = true
    } else if (!willBeEnabled && this.automaticMemorySnapshot) {
      this.stopMemorySnapshotTimer()
      this.memorySnapshotInterval = 0
      this.automaticMemorySnapshot = false
    }

    this.emit(CliRenderEvents.DEBUG_OVERLAY_TOGGLE, this.debugOverlay.enabled)
  }

  public configureDebugOverlay(options: { enabled?: boolean; corner?: DebugOverlayCorner }): void {
    const enabled = options.enabled ?? this.debugOverlay.enabled
    const corner = options.corner ?? this.debugOverlay.corner
    this.lib.sessionSetDebugOverlay(this.nativeSession.context, this.nativeSession.session, enabled, corner)
    this.debugOverlay.enabled = enabled
    this.debugOverlay.corner = corner
    this.requestRender()
  }

  public setTerminalTitle(title: string): void {
    this.nativeSession.control({ kind: "title", title })
  }

  /**
   * Reset the terminal background color to its default via OSC 111.
   * Called automatically by destroy() and suspend(), but exposed for
   * consumers that need explicit control (e.g. before SIGTSTP).
   */
  public resetTerminalBgColor(): void {
    this.nativeSession.control({ kind: "reset-background" })
  }

  public copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean {
    if (!this.isOsc52Supported()) return false
    return this.nativeSession.writeClipboard(target ?? ClipboardTarget.Clipboard, this.lib.encoder.encode(text))
  }

  public clearClipboardOSC52(target?: ClipboardTarget): boolean {
    return this.nativeSession.writeClipboard(target ?? ClipboardTarget.Clipboard, new Uint8Array(0))
  }

  public isOsc52Supported(): boolean {
    return this.nativeSession.getCapabilities().osc52_support !== "unsupported"
  }

  public dumpHitGrid(): void {
    this.lib.sessionDumpHitGrid(this.nativeSession.context, this.nativeSession.session)
  }

  public getLinkIdAt(x: number, y: number): number {
    if (this._isDestroyed || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return 0
    return this.currentRenderBuffer.withBuffers((cells) => {
      if (x >= cells.width || y >= cells.height) return 0
      return getLinkId(cells.attributes[y * cells.width + x])
    })
  }

  public getLinkAt(x: number, y: number): string | null {
    const linkId = this.getLinkIdAt(x, y)
    return linkId === 0 ? null : this.lib.contextGetLinkUrl(this.nativeSession.context, linkId) || null
  }

  public static setCursorPosition(renderer: CliRenderer, x: number, y: number, visible: boolean = true): void {
    renderer.setCursorPosition(x, y, visible)
  }

  public static setCursorStyle(renderer: CliRenderer, options: CursorStyleOptions): void {
    renderer.setCursorStyle(options)
  }

  public static setCursorColor(renderer: CliRenderer, color: RGBA): void {
    renderer.setCursorColor(color)
  }

  public setCursorPosition(x: number, y: number, visible: boolean = true): void {
    this.lib.sessionSetCursor(this.nativeSession.context, this.nativeSession.session, { position: { x, y, visible } })
  }

  public setCursorStyle(options: CursorStyleOptions): void {
    this.lib.sessionSetCursor(this.nativeSession.context, this.nativeSession.session, options)
    if (options.cursor !== undefined) {
      this._currentMousePointerStyle = options.cursor
    }
  }

  public setCursorColor(color: RGBA): void {
    this.lib.sessionSetCursor(this.nativeSession.context, this.nativeSession.session, { color })
  }

  public getCursorState() {
    return this.lib.sceneGetCursorState(this.nativeSession.context, this.nativeSession.session)
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

  public hasFrameCallback(callback: (deltaTime: number) => Promise<void>): boolean {
    return this.frameCallbacks.includes(callback)
  }

  public removeFrameCallback(callback: (deltaTime: number) => Promise<void>): void {
    this.frameCallbacks = this.frameCallbacks.filter((cb) => cb !== callback)
  }

  public clearFrameCallbacks(): void {
    this.frameCallbacks = []
  }

  private get canRender(): boolean {
    return !this._isDestroyed && !this.nativeSession.error && !this.nativeSession.disposed
  }

  public requestAnimationFrame(callback: FrameRequestCallback): number {
    if (!this.canRender) return -1
    const id = CliRenderer.animationFrameId++
    this.animationRequest.set(id, callback)
    this.requestLive()
    return id
  }

  public cancelAnimationFrame(handle: number): void {
    if (this.animationRequest.delete(handle)) this.dropLive()
  }

  private yieldFrame(): Promise<void> {
    if (!this.canRender) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        this.cancelFrameContinuation = null
        resolve()
      }
      const cancel = this.nativeSession.scheduler.schedule(finish)
      this.cancelFrameContinuation = () => {
        cancel()
        finish()
      }
    })
  }

  private queueFrame(): void {
    if (this.cancelReadyFrame || this._isDestroyed) return
    if (!this.canRender) {
      this.destroy()
      return
    }
    this.cancelReadyFrame = this.nativeSession.scheduler.schedule(() => {
      this.cancelReadyFrame = null
      void this.loop()
    })
  }

  public requestLive(): void {
    if (!this.canRender) return
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
      this.cancelReadyFrame?.()
      this.cancelReadyFrame = null
      if (this.renderTimeout) {
        this.clock.clearTimeout(this.renderTimeout)
        this.renderTimeout = null
      }

      if (this.memorySnapshotInterval > 0) {
        this.startMemorySnapshotTimer()
      }

      this.startRenderLoop()
    }
  }

  public pause(): void {
    this._controlState = RendererControlState.EXPLICIT_PAUSED
    this.immediateRerenderRequested = false
    this.ordinaryFrameWaitControlState = null
    this.internalPause()
  }

  public suspend(): Promise<void> {
    if (this.nativeSplitFlush) return this.nativeTerminalTransition!
    if (!this._terminalIsSetup || this.nativeTerminalTransition) {
      throw new Error("Native scene suspension requires completed terminal setup and no pending transition")
    }
    const flushNativeSplit = this.externalOutputQueue.size > 0 || this.pendingNativeReplay
    if (flushNativeSplit) this.lib.getYogaHost().assertMutable()
    let nativeTransition: Promise<void>
    if (flushNativeSplit) {
      const count = this.externalOutputQueue.size
      // Publish the finite drain before listeners can reenter; native work starts after scopes unwind.
      this.nativeSplitFlush = Promise.resolve().then(() => this.flushNativeSplitOutput(count))
      nativeTransition = (async () => {
        try {
          await this.nativeSplitFlush
          if (this._isDestroyed) throw new Error("Native scene suspension interrupted by renderer destruction")
          return this.nativeSession.suspend()
        } finally {
          this.nativeSplitFlush = null
        }
      })()
    } else {
      nativeTransition = this.nativeSession.suspend()
    }
    nativeTransition = this.trackNativeTerminalTransition(nativeTransition)
    if (this._controlState !== RendererControlState.EXPLICIT_SUSPENDED) {
      // A failed native split drain leaves the host suspended until the caller retries.
      this._previousControlState = this._controlState
      this._suspendedMouseEnabled = this._useMouse
    }

    this._controlState = RendererControlState.EXPLICIT_SUSPENDED
    this._cancelPaletteDetection?.(new Error("Cannot detect palette while renderer is suspended"))
    this.resolveXtVersionWaiters()
    this.nativeScene.interruptPaint()
    this.immediateRerenderRequested = false
    this.internalPause()

    this.clearSplitStartupCursorSeed()

    this.disableMouse()
    this.removeExitListeners()
    this.updateStdinParserProtocolContext({
      privateCapabilityRepliesActive: false,
      pixelResolutionQueryActive: this.waitingForPixelResolution,
      explicitWidthCprActive: false,
      startupCursorCprActive: false,
    })
    if (this.stdinParser?.hasPendingPixelResolutionResponse()) this.stdinParser.pausePendingTimeout()
    else this.stdinParser?.reset()
    this.stdin.removeListener("data", this.stdinListener)
    this.stopTerminalKeepAlive()

    this.themeModeState?.cancelRefresh()

    if (this.stdin.setRawMode) {
      this.stdin.setRawMode(false)
    }

    this.stdin.pause()
    return nativeTransition
  }

  public resume(): Promise<void> {
    if (
      !this._terminalIsSetup ||
      this.nativeTerminalTransition ||
      this._controlState !== RendererControlState.EXPLICIT_SUSPENDED
    ) {
      throw new Error("Native scene resume requires completed suspension")
    }
    if (this.pendingSplitFooterTransition) {
      // Terminal setup requires clean native split state; retain the deferred work on the host.
      this.lib.sessionSplitControl(this.nativeSession.context, this.nativeSession.session, {
        kind: "clear-transition",
      })
    }
    const resumed = this.trackNativeTerminalTransition(this.nativeSession.resume(), () => {
      if (this._isDestroyed) return
      if (this.pendingSplitFooterTransition) this.setPendingSplitFooterTransition(this.pendingSplitFooterTransition)
      this.finishResume()
    }).then(() => {
      if (
        !this._isDestroyed &&
        (this.shouldSyncNativePaletteState() || this.listenerCount(CliRenderEvents.PALETTE) > 0)
      ) {
        this.clearPaletteCache()
        this.refreshPalette()
      }
    })
    void resumed.catch(() => {})
    return resumed
  }

  private finishResume(): void {
    if (this.stdin.setRawMode) {
      this.stdin.setRawMode(true)
    }

    let drained: Buffer | string | null
    while ((drained = this.stdin.read()) !== null) this.stdinListener(drained)
    if (this.stdinParser?.hasPendingPixelResolutionResponse()) this.stdinParser.pausePendingTimeout()
    else this.stdinParser?.reset()
    this.stdin.on("data", this.stdinListener)
    this.stdin.resume()
    this.startTerminalKeepAlive()
    this.addExitListeners()

    this._useMouse = this._suspendedMouseEnabled

    if (this._screenMode === "split-footer" && this._splitHeight > 0) {
      this.syncSplitFooterState()
    }

    this.forceFullRepaintRequested = true
    this.startKittyTransportPolling()
    this.nativeSession.startKittyFileProbe()
    this._controlState = this._previousControlState
    if (this.pixelResolutionRequeryPending) this.queryPixelResolution()
    this.stdinParser?.resumePendingTimeout()
    this.applyPendingNativeResize()

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
    this.cancelReadyFrame?.()
    this.cancelReadyFrame = null

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
    this.immediateRerenderRequested = false
    this.ordinaryFrameWaitControlState = null
    this.internalStop()
  }

  private internalStop(): void {
    this.cancelReadyFrame?.()
    this.cancelReadyFrame = null
    if (this.renderTimeout) {
      this.clock.clearTimeout(this.renderTimeout)
      this.renderTimeout = null
    }
    if (this.isRunning && !this._isDestroyed) {
      this._isRunning = false

      if (this.memorySnapshotTimer) {
        this.clock.clearInterval(this.memorySnapshotTimer)
        this.memorySnapshotTimer = null
      }
    }
    if (!this.rendering) this.resolveIdleIfNeeded()
  }

  public destroy(): void {
    if (this._isDestroyed) return
    this.lib.getYogaHost().assertMutable()
    this._isDestroyed = true
    this._destroyPending = true
    this._palettePublishGeneration++

    this._cancelPaletteDetection?.(new Error("Cannot detect palette after renderer destruction"))

    const splitFlush = this.nativeSplitFlush
    const terminalTransition = this.nativeTerminalTransition
    // Scene hooks run between native calls with no borrowed pointers. Storage
    // scopes still unwind before this microtask releases the Context.
    queueMicrotask(async () => {
      try {
        if (splitFlush || this.externalOutputQueue.size > 0 || this.pendingNativeReplay) {
          this.nativeSession.armCloseTimeout()
          if (splitFlush) await splitFlush
          else if (terminalTransition) await terminalTransition
          if (this.externalOutputQueue.size > 0 || this.pendingNativeReplay) await this.flushNativeSplitOutput()
        }
        void this.nativeSession.close()
      } catch (error) {
        this.externalOutputQueue.clear()
        this.nativeSession.dispose()
        console.error("Native split output cancelled during close:", error)
      }
    })
    this.finalizeDestroy()
  }

  private cleanupBeforeDestroy(): void {
    if (this._destroyCleanupPrepared) return
    this._destroyCleanupPrepared = true
    if (this.kittyTransportTimer !== null) {
      this.clock.clearInterval(this.kittyTransportTimer)
      this.kittyTransportTimer = null
      this.stdout.off("error", this.kittyOutputErrorHandler)
      if (!this.nativeSession.disposed && !this.nativeSession.error) this.nativeSession.cancelKittyImageTransport(false)
    }
    this.pendingNativeResize = null
    this.cancelReadyFrame?.()
    this.cancelReadyFrame = null
    this.cancelFrameContinuation?.()
    this.animationRequest.clear()
    this.frameCallbacks = []
    this.liveRequestCounter = 0
    this.immediateRerenderRequested = false

    if (this._usesProcessStdout) {
      this.removeCleanupListener(process, "SIGWINCH", this.sigwinchHandler)
    }
    this.removeCleanupListener(process, "uncaughtException", this.handleError)
    this.removeCleanupListener(process, "unhandledRejection", this.handleError)
    this.removeCleanupListener(process, "warning", this.warningHandler)
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

    this.themeModeState?.cancelRefresh()

    this._isRunning = false
    this.waitingForPixelResolution = false
    this.pixelResolutionRequeryPending = false
    try {
      this.updateStdinParserProtocolContext(
        {
          privateCapabilityRepliesActive: false,
          pixelResolutionQueryActive: false,
          explicitWidthCprActive: false,
          startupCursorCprActive: false,
        },
        true,
      )
    } catch (error) {
      // Draining can run a user input handler. Reset its pending input, but do
      // not let that failure strand the remaining teardown or its completion.
      this.handleStdinParserFailure(error)
    }
    if (this.stdin === process.stdin && this._usesProcessStdout) this.disableMouse()
    this._useMouse = false
    this.setCapturedRenderable(undefined)

    this.removeCleanupListener(this.stdin, "data", this.stdinListener)
    this.stopTerminalKeepAlive()
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

    this.externalOutputMode = "passthrough"
  }

  private finalizeDestroy(): void {
    if (this._destroyFinalized) return
    if (this.root?._deferUntilCleanupComplete(() => this.finalizeDestroy())) {
      this.cleanupBeforeDestroy()
      return
    }

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
    this._paletteDetectionGeneration = 0
    this._nativePaletteSignature = null
    this._emittedPaletteSignature = null
    this._paletteEpoch = 0
    this.resolveXtVersionWaiters()

    this.themeModeState?.dispose()

    for (const destroy of this.detachedSurfaces) {
      try {
        destroy()
      } catch (error) {
        console.error("Error destroying detached surface:", error)
      }
    }
    try {
      this.emit(CliRenderEvents.DESTROY)
    } catch (error) {
      console.error("Error in native scene destroy listener:", error)
    } finally {
      try {
        destroyTimelineEngine(this)
      } catch (error) {
        console.error("Error releasing timeline engine:", error)
      }
    }

    try {
      this.root?.destroyRecursively()
    } catch (e) {
      console.error("Error destroying root renderable:", e instanceof Error ? e.stack : String(e))
    }

    this.stdinParser?.destroy()
    this.stdinParser = null
    this.oscSubscribers.clear()
    try {
      this._console?.destroy()
    } catch (error) {
      console.error("Error destroying console:", error)
    }

    try {
      this.nativeScene.destroy()
    } catch (error) {
      console.error("Error destroying native scene:", error)
    }

    this._externalOutputMode = "passthrough"
    this.pendingExternalOutputMode = null
    this.stdout.write = this.realStdoutWrite

    const discardInput = this._terminalIsSetup && this._controlState !== RendererControlState.EXPLICIT_SUSPENDED
    if (discardInput) {
      const bufferedInput = this.stdin.readableLength
      if (bufferedInput > 0) this.stdin.read(bufferedInput)
    }
    rendererTracker.renderers.delete(this)
    if (rendererTracker.renderers.size === 0) {
      void destroyTreeSitterClient().catch((error) => {
        console.error("Failed to destroy tree-sitter client:", error)
      })
    }

    if (this._onDestroy) {
      try {
        this._onDestroy()
      } catch (e) {
        console.error("Error in onDestroy callback:", e instanceof Error ? e.stack : String(e))
      }
    }

    // Resolve any pending idle() calls
    this.nativeDestroyWait?.resolve()
    this.resolveIdleIfNeeded()
  }

  private releaseStreamLease(): void {
    if (!this._streamLeaseAcquired) return
    if (rendererTracker.streamOwners.get(this.stdin) === this) rendererTracker.streamOwners.delete(this.stdin)
    if (rendererTracker.streamOwners.get(this.stdout) === this) rendererTracker.streamOwners.delete(this.stdout)
    this._streamLeaseAcquired = false
  }

  private startRenderLoop(): void {
    if (!this._isRunning) return

    this.lastTime = this.normalizeClockTime(this.clock.now(), 0)
    this.frameCount = 0
    this.lastFpsTime = this.lastTime
    this.currentFps = 0
    this.renderStats.fps = 0

    // Starting continuous mode must not bypass an existing output-idle retry. Keep
    // _isRunning true, but let the idle callback schedule the first loop once the
    // Session is ready; a successful frame will then resume the normal cadence.
    if (this.outputIdleRenderScheduled) return

    this.queueFrame()
  }

  private async loop(waitForActive = false): Promise<void> {
    if (this.rendering) {
      if (!waitForActive) return
      this.renderingCompletion ??= Promise.withResolvers<void>()
      return this.renderingCompletion.promise
    }
    if (this._isDestroyed) return
    this.cancelReadyFrame?.()
    this.cancelReadyFrame = null
    if (this.renderTimeout) {
      this.clock.clearTimeout(this.renderTimeout)
      this.renderTimeout = null
    }
    this.rendering = true
    this.ordinaryFrameWaitControlState = this._controlState
    let renderFailed = false
    try {
      if (!this.canRender) return
      if (this.nativeTerminalTransition) await this.nativeTerminalTransition
      if (
        !this.canRender ||
        this.currentControlState === RendererControlState.EXPLICIT_SUSPENDED ||
        this.isSplitCursorSeedFrameBlocked()
      )
        return
      // Bump before any work so all callers this iteration see the new id.
      this._frameId++

      const now = this.normalizeClockTime(this.clock.now(), this.lastTime)
      const elapsed = this.getElapsedMs(now, this.lastTime)

      const deltaTime = elapsed
      this.lastTime = now

      this.renderStats.frameCount++
      const overallStart = performance.now()

      const animationFrameEnd = CliRenderer.animationFrameId
      const animationRequestStart = performance.now()
      for (const [id, callback] of this.animationRequest) {
        if (id >= animationFrameEnd) break
        if (!this.canRender || this.currentControlState === RendererControlState.EXPLICIT_SUSPENDED) break
        this.animationRequest.delete(id)
        try {
          callback(deltaTime)
        } finally {
          this.dropLive()
        }
        await this.yieldFrame()
      }
      const animationRequestEnd = performance.now()
      const animationRequestTime = animationRequestEnd - animationRequestStart

      const start = performance.now()
      const frameCallbacks = this.frameCallbacks
      const callbackCount = frameCallbacks.length
      for (let index = 0; index < callbackCount; index++) {
        if (!this.canRender || this.currentControlState === RendererControlState.EXPLICIT_SUSPENDED) break
        const frameCallback = frameCallbacks[index]
        if (this.frameCallbacks !== frameCallbacks && !this.frameCallbacks.includes(frameCallback)) continue
        try {
          await frameCallback(deltaTime)
        } catch (error) {
          console.error("Error in frame callback:", error)
        }
        await this.yieldFrame()
      }
      const end = performance.now()
      this.renderStats.frameCallbackTime = end - start

      if (!this.canRender || this.currentControlState === RendererControlState.EXPLICIT_SUSPENDED) return
      const sceneStart = performance.now()
      const requestedBeforeScene = this.immediateRerenderRequested
      try {
        const painting = this.nativeScene.paint(deltaTime, () => ({
          background: this.backgroundColor,
          useMouse: this._useMouse,
          excludedHitNum: this.capturedRenderable?.num ?? 0,
        }))
        if (painting) await painting
      } catch (error) {
        // Failed feedback must not schedule its own retry. The error handler can request one explicitly.
        this.immediateRerenderRequested = requestedBeforeScene
        throw error
      } finally {
        this._lastSceneTimeMs = performance.now() - sceneStart
      }

      if (
        this._isDestroyed ||
        this.currentControlState === RendererControlState.EXPLICIT_SUSPENDED ||
        !this.nativeScene.frame
      )
        return

      for (const postProcessFn of this.postProcessFns) {
        if (!this.canRender) break
        this.nextRenderBuffer._withNativePaint(() => postProcessFn(this.nextRenderBuffer, deltaTime))
      }

      if (this.canRender) this._console.renderToBuffer(this.nextRenderBuffer)

      // If destroy() was requested during this frame, skip native work and scheduling.
      if (this.canRender && !this.nativeSplitFlush) {
        const nativeStatus = await this.presentNativeScene()
        if (!this.canRender || this.currentControlState === RendererControlState.EXPLICIT_SUSPENDED) return
        if (nativeStatus === "rendered") this.frameCount++
        if (this.getElapsedMs(now, this.lastFpsTime) >= 1000) {
          this.currentFps = this.frameCount
          this.frameCount = 0
          this.lastFpsTime = now
        }
        this.renderStats.fps = this.currentFps

        if (nativeStatus === "rendered") {
          // Check if hit grid changed and recheck hover state if needed
          if (this._useMouse) {
            this.recheckHoverState()
          }
          if (!this.canRender) return

          const overallFrameTime = performance.now() - overallStart

          // TODO: Add animationRequestTime to stats
          this.lib.sessionUpdateStats(
            this.nativeSession.context,
            this.nativeSession.session,
            overallFrameTime,
            this.renderStats.fps,
            this.renderStats.frameCallbackTime,
          )

          if (this.listenerCount(CliRenderEvents.FRAME) > 0) {
            this.emit(CliRenderEvents.FRAME, {
              frameId: this.frameId,
            })
          }
          if (!this.canRender) return

          if (this.gatherStats) {
            this.collectStatSample(overallFrameTime)
          }

          if (this._isRunning || this.immediateRerenderRequested) {
            const targetFrameTime = this.immediateRerenderRequested ? this.minTargetFrameTime : this.targetFrameTime
            const delay = Math.max(1, targetFrameTime - Math.floor(overallFrameTime))
            this.immediateRerenderRequested = false
            this.renderTimeout = this.clock.setTimeout(() => {
              this.renderTimeout = null
              this.queueFrame()
            }, delay)
          } else {
            this.clock.clearTimeout(this.renderTimeout!)
            this.renderTimeout = null
          }
        } else {
          // Blocked frames resume on a cursor reply/timeout; skipped frames wait for output idle.
          this.immediateRerenderRequested = false
          this.renderTimeout = null
        }
      }
    } catch (error) {
      renderFailed = true
      const renderError = error instanceof Error ? error : new Error(String(error))
      const event: CliRendererErrorEvent = { error: renderError, renderable: this.root.takeCurrentRenderable() }
      const handled = this.emit(CliRenderEvents.RENDER_ERROR, event)
      if (!handled) this.handleError(renderError)
    } finally {
      const completion = this.renderingCompletion
      this.renderingCompletion = null
      try {
        this.nativeScene.cancelFrame()
        this.rendering = false
        if (!this.canRender && !this._isDestroyed) this.destroy()
        if (this._destroyPending) {
          this.finalizeDestroy()
        }
        if (renderFailed && (this._isRunning || this.immediateRerenderRequested) && !this._isDestroyed) {
          this.immediateRerenderRequested = false
          this.scheduleRenderTimer()
        }
        // Keep the old dimensions through FRAME publication, even if the output
        // driver completed its presentation and drain in the same turn.
        this.applyPendingNativeMode()
        this.applyPendingNativeResize()
        this.resolveIdleIfNeeded()
      } finally {
        completion?.resolve()
      }
    }
  }

  public intermediateRender(): void {
    this.immediateRerenderRequested = true
    this.ordinaryFrameWaitControlState = this._controlState
    this.loop()
  }

  private async presentNativeScene(): Promise<"rendered" | "retryable-skip" | "failed" | "blocked"> {
    if (this.isSplitCursorSeedFrameBlocked()) return "blocked"
    const commits =
      this._splitHeight > 0 && this._externalOutputMode === "capture-stdout"
        ? this.pendingNativeReplay?.remaining === 0
          ? []
          : this.externalOutputQueue.peek(
              Math.min(this.maxSplitCommitsPerFrame, this.pendingNativeReplay?.remaining ?? Infinity),
            )
        : null
    const split =
      commits === null
        ? null
        : this.nativeScene.commitSplit(
            commits.map((commit) => ({ ...commit, snapshot: commit.nativeSnapshot! })),
            this.getSplitPinnedRenderOffset(),
            this.forceFullRepaintRequested,
          )
    const status = split?.status ?? this.nativeScene.commit(this.forceFullRepaintRequested)
    if (commits && (status === NativeSessionRenderStatus.Pending || status === NativeSessionRenderStatus.Presented)) {
      this.nativeSplitAcceptedCount = commits.length
    }
    switch (status) {
      case NativeSessionRenderStatus.Pending:
        await this.nativeSession.whenPresented()
        break
      case NativeSessionRenderStatus.Presented:
        break
      case NativeSessionRenderStatus.Skipped:
        this.ordinaryFrameWaitingForOutput = true
        this.scheduleRenderAfterOutputIdle()
        return "retryable-skip"
      case NativeSessionRenderStatus.Failed:
        console.error("[CliRenderer] Native frame render failed; waiting for the next render request to force repaint")
        return "failed"
      default:
        throw new Error("Unknown native scene presentation status")
    }
    if (this._isDestroyed || this.nativeSplitFlush) return "rendered"
    if (split && commits) {
      this.completeNativeSplitCommits(commits)
      if (this.externalOutputQueue.size > 0) this.requestRender()
      else this.applyPendingExternalOutputModeIfReady()
    }
    this.forceFullRepaintRequested = false
    return "rendered"
  }

  private completeNativeSplitCommits(commits: readonly ExternalOutputCommit[]): void {
    if (!this._isDestroyed) {
      this.syncSplitScrollback()
      for (const commit of commits) this.recordSplitCommit(commit)
    }
    this.externalOutputQueue.drop(commits.length)
    if (this.pendingNativeReplay) this.pendingNativeReplay.remaining -= commits.length
    this.nativeSplitAcceptedCount = 0
    this.pendingSplitFooterTransition = null
  }

  private async flushNativeSplitOutput(remaining: number = this.externalOutputQueue.size): Promise<void> {
    const driver = this.nativeSession
    await driver.whenPresented()
    this.nativeScene.cancelFrame()
    if (this.nativeSplitAcceptedCount > 0) {
      remaining -= this.nativeSplitAcceptedCount
      this.completeNativeSplitCommits(this.externalOutputQueue.peek(this.nativeSplitAcceptedCount))
    }
    while (remaining > 0 || this.pendingNativeReplay?.remaining === 0) {
      if (this.pendingNativeReplay?.remaining === 0) {
        try {
          this.applySplitFooterReplayReset(this.pendingNativeReplay.options)
        } catch (error) {
          if (!(error instanceof NativeError) || error.status !== NativeStatus.OutputBackpressure) throw error
          await driver.idle()
          continue
        }
      }
      if (remaining === 0) break
      const commits = this.externalOutputQueue.peek(
        Math.min(remaining, this.maxSplitCommitsPerFrame, this.pendingNativeReplay?.remaining ?? Infinity),
      )
      const result = driver.renderSplit(
        null,
        commits.map((commit) => ({ ...commit, snapshot: commit.nativeSnapshot! })),
        this.getSplitPinnedRenderOffset(),
        false,
      )
      if (result.status === NativeSessionRenderStatus.Failed) throw new Error("Native split output frame failed")
      if (result.status === NativeSessionRenderStatus.Skipped) {
        await driver.idle()
        continue
      }
      await driver.whenPresented()
      remaining -= commits.length
      this.completeNativeSplitCommits(commits)
    }
    if (!this._isDestroyed) this.applyPendingExternalOutputModeIfReady()
  }

  private collectStatSample(frameTime: number): void {
    this.frameTimes.push(frameTime)
    if (this.frameTimes.length > this.maxStatSamples) {
      this.frameTimes.shift()
    }
  }

  public getNativeStats(): NativeRenderStats {
    return this.lib.sceneGetStats(this.nativeSession.context, this.nativeSession.session)
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
    this.clearSelectionState()
    this.lastClick = null
  }

  private clearSelectionState(): void {
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
  public startSelection(renderable: Renderable, x: number, y: number, behavior: SelectionBehavior = "cell"): void {
    if (!renderable.selectable) return

    this.clearSelectionState()
    this.selectionContainers.push(renderable.parent || this.root)
    this.currentSelection = new Selection(renderable, { x, y }, { x, y }, behavior)
    this.currentSelection.isStart = true

    this.notifySelectablesOfSelectionChange()
  }

  private nextClickBehavior(renderable: Renderable, x: number, y: number): SelectionBehavior {
    const now = this.clock.now()
    const last = this.lastClick
    const continued =
      last !== null &&
      renderable.num === last.renderableId &&
      now - last.time <= CLICK_REPEAT_INTERVAL_MS &&
      Math.max(Math.abs(x - last.x), Math.abs(y - last.y)) <= 1
    const count = continued ? Math.min(last.count + 1, 3) : 1
    this.lastClick = { count, time: now, x, y, renderableId: renderable.num }
    return count === 1 ? "cell" : count === 2 ? "word" : "line"
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
      const detector = createTerminalPalette({
        stdin: this.stdin,
        stdout: this.stdout,
        writeFn: (data) => {
          if (this._isDestroyed || this._paletteDetector !== detector) {
            throw new Error("Palette detection was cancelled")
          }
          this.nativeSession.control({ kind: "palette-query", bytes: Buffer.from(data) })
          return true
        },
        isLegacyTmux,
        isTmux,
        oscSource: {
          subscribeOsc: this.subscribeOsc.bind(this),
        },
        clock: this.clock,
      })
      this._paletteDetector = detector
    }

    return this._paletteDetector
  }

  private syncNativePaletteState(colors: TerminalColors | null): void {
    const signature = buildTerminalPaletteSignature(colors)
    const epoch = this._nativePaletteSignature !== signature ? (this._paletteEpoch + 1) >>> 0 : this._paletteEpoch
    const normalized = normalizeTerminalPalette(colors)
    this.lib.sessionSetPaletteState(
      this.nativeSession.context,
      this.nativeSession.session,
      normalized.palette,
      normalized.defaultForeground,
      normalized.defaultBackground,
      epoch,
    )
    this._nativePaletteSignature = signature
    this._paletteEpoch = epoch
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
    if (this._isDestroyed || !this._terminalIsSetup || this.nativeTerminalTransition) {
      throw new Error("Native palette detection requires an active terminal")
    }

    const requestedSize = options?.size ?? 16
    const detectionTimeout = options?.timeout
    if (!Number.isInteger(requestedSize) || requestedSize < 1 || requestedSize > 256) {
      throw new RangeError("Native palette size must be an integer from 1 to 256")
    }
    const requestedGeneration = this._palettePublishGeneration

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
      if (
        this._isDestroyed ||
        !this._terminalIsSetup ||
        this.nativeTerminalTransition ||
        this.currentControlState === RendererControlState.EXPLICIT_SUSPENDED
      ) {
        throw new Error("Palette detection was cancelled")
      }

      // Another caller may have populated the cache while this call waited.
      const afterCapabilityWait = this.getCachedPaletteBySize(requestedSize)
      if (afterCapabilityWait) {
        return afterCapabilityWait
      }
    }

    while (this._paletteDetectionPromise) {
      if (
        this._paletteDetectionSize >= requestedSize &&
        this._paletteDetectionGeneration === this._palettePublishGeneration
      ) {
        return this._paletteDetectionPromise.then((palette) => {
          const cached = this.getCachedPaletteBySize(requestedSize)
          if (cached) {
            return cached
          }

          const projected = {
            ...palette,
            palette: palette.palette.slice(0, requestedSize),
          }
          if (!this._isDestroyed && requestedGeneration === this._palettePublishGeneration) {
            this._paletteCache.set(requestedSize, projected)
          }
          return projected
        })
      }

      await this._paletteDetectionPromise
      if (
        this._isDestroyed ||
        !this._terminalIsSetup ||
        this.nativeTerminalTransition ||
        this.currentControlState === RendererControlState.EXPLICIT_SUSPENDED
      ) {
        throw new Error("Palette detection was cancelled")
      }

      const afterWait = this.getCachedPaletteBySize(requestedSize)
      if (afterWait) {
        return afterWait
      }
    }

    const detector = this.ensurePaletteDetector()
    const publishGeneration = this._palettePublishGeneration
    this._paletteDetectionSize = requestedSize
    this._paletteDetectionGeneration = publishGeneration
    let cancel: ((reason: Error) => void) | null = null
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = (reason) => {
        detector.cleanup()
        if (this._paletteDetector === detector) this._paletteDetector = null
        reject(reason)
      }
    })
    this._cancelPaletteDetection = cancel
    const detection = detector.detect({ ...options, timeout: detectionTimeout })
    void detection.catch(() => detector.cleanup())
    const completion = Promise.race([detection, cancelled])
      .then((result) => {
        detector.cleanup()
        if (this._paletteDetector === detector) this._paletteDetector = null
        if (this._paletteDetectionPromise === pending) {
          this._paletteDetectionPromise = null
          this._paletteDetectionSize = 0
          this._paletteDetectionGeneration = 0
        }

        const publish = !this._isDestroyed && this._palettePublishGeneration === publishGeneration
        if (publish && this.shouldSyncNativePaletteState() && result.palette.length >= NATIVE_PALETTE_QUERY_SIZE) {
          this.syncNativePaletteState(result)
        }
        if (publish) this._paletteCache.set(result.palette.length, result)
        if (publish) {
          this.emitPaletteChange(result)
          if (this.shouldSyncNativePaletteState() && !this._paletteCache.has(NATIVE_PALETTE_QUERY_SIZE)) {
            this.refreshPalette()
          }
        }

        return result
      })
      .catch((error) => {
        if (this._paletteDetectionPromise === pending) {
          this._paletteDetectionPromise = null
          this._paletteDetectionSize = 0
          this._paletteDetectionGeneration = 0
        }
        detector.cleanup()
        if (this._paletteDetector === detector) this._paletteDetector = null
        throw error
      })
    const pending: Promise<TerminalColors> = completion.finally(() => {
      if (this._cancelPaletteDetection === cancel) this._cancelPaletteDetection = null
    })
    this._paletteDetectionPromise = pending

    const detected = await this._paletteDetectionPromise
    const finalPalette = this.getCachedPaletteBySize(requestedSize) ?? detected
    return finalPalette
  }
}
