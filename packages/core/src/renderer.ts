import { ANSI } from "./ansi"
import { Renderable, RootRenderable } from "./Renderable"
import {
  type CursorStyle,
  DebugOverlayCorner,
  type RenderContext,
  type ViewportBounds,
  type WidthMethod,
} from "./types"
import { RGBA, parseColor, type ColorInput } from "./lib/RGBA"
import type { Pointer } from "bun:ffi"
import { OptimizedBuffer } from "./buffer"
import { resolveRenderLib, type RenderLib } from "./zig"
import { TerminalConsole, type ConsoleOptions, capture } from "./console"
import { MouseParser, type MouseEventType, type RawMouseEvent, type ScrollInfo } from "./lib/parse.mouse"
import { Selection } from "./lib/selection"
import { EventEmitter } from "events"
import { destroySingleton, hasSingleton, singleton } from "./lib/singleton"
import { getObjectsInViewport } from "./lib/objects-in-viewport"
import { KeyHandler, InternalKeyHandler } from "./lib/KeyHandler"
import { StdinBuffer } from "./lib/stdin-buffer"
import { env, registerEnvVar } from "./lib/env"
import { getTreeSitterClient } from "./lib/tree-sitter"
import {
  createTerminalPalette,
  type TerminalPaletteDetector,
  type TerminalColors,
  type GetPaletteOptions,
} from "./lib/terminal-palette"
import {
  isCapabilityResponse,
  isPixelResolutionResponse,
  parsePixelResolution,
} from "./lib/terminal-capability-detection"

registerEnvVar({
  name: "OTUI_DUMP_CAPTURES",
  description: "Dump captured output when the renderer exits.",
  type: "boolean",
  default: false,
})

registerEnvVar({
  name: "OTUI_NO_NATIVE_RENDER",
  description: "Disable native rendering. This will not actually output ansi and is useful for debugging.",
  type: "boolean",
  default: false,
})

registerEnvVar({
  name: "OTUI_USE_ALTERNATE_SCREEN",
  description: "Whether to use the console. Will not capture console output if set to false.",
  type: "boolean",
  default: true,
})

registerEnvVar({
  name: "OTUI_OVERRIDE_STDOUT",
  description: "Override the stdout stream. This is useful for debugging.",
  type: "boolean",
  default: true,
})

registerEnvVar({
  name: "OTUI_DEBUG",
  description: "Enable debug mode to capture all raw input for debugging purposes.",
  type: "boolean",
  default: false,
})

export interface CliRendererConfig {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  exitOnCtrlC?: boolean
  exitSignals?: NodeJS.Signals[]
  debounceDelay?: number
  targetFps?: number
  maxFps?: number
  memorySnapshotInterval?: number
  useThread?: boolean
  gatherStats?: boolean
  maxStatSamples?: number
  consoleOptions?: ConsoleOptions
  postProcessFns?: ((buffer: OptimizedBuffer, deltaTime: number) => void)[]
  enableMouseMovement?: boolean
  useMouse?: boolean
  useAlternateScreen?: boolean
  useConsole?: boolean
  experimental_splitHeight?: number
  useKittyKeyboard?: KittyKeyboardOptions | null
  backgroundColor?: ColorInput
  openConsoleOnError?: boolean
  prependInputHandlers?: ((sequence: string) => boolean)[]
  onDestroy?: () => void
}

export type PixelResolution = {
  width: number
  height: number
}

// Kitty keyboard protocol flags
// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
const KITTY_FLAG_DISAMBIGUATE = 0b1 // Report disambiguated escape codes
const KITTY_FLAG_EVENT_TYPES = 0b10 // Report event types (press/repeat/release)
const KITTY_FLAG_ALTERNATE_KEYS = 0b100 // Report alternate keys (e.g., numpad vs regular)
const KITTY_FLAG_ALL_KEYS_AS_ESCAPES = 0b1000 // Report all keys as escape codes
const KITTY_FLAG_REPORT_TEXT = 0b10000 // Report text associated with key events

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
  public readonly isSelecting?: boolean
  private _propagationStopped: boolean = false
  private _defaultPrevented: boolean = false

  public get propagationStopped(): boolean {
    return this._propagationStopped
  }

  public get defaultPrevented(): boolean {
    return this._defaultPrevented
  }

  constructor(target: Renderable | null, attributes: RawMouseEvent & { source?: Renderable; isSelecting?: boolean }) {
    this.target = target
    this.type = attributes.type
    this.button = attributes.button
    this.x = attributes.x
    this.y = attributes.y
    this.modifiers = attributes.modifiers
    this.scroll = attributes.scroll
    this.source = attributes.source
    this.isSelecting = attributes.isSelecting
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

const rendererTracker = singleton("RendererTracker", () => {
  const renderers = new Set<CliRenderer>()
  return {
    addRenderer: (renderer: CliRenderer) => {
      renderers.add(renderer)
    },
    removeRenderer: (renderer: CliRenderer) => {
      renderers.delete(renderer)
      if (renderers.size === 0) {
        process.stdin.pause()

        if (hasSingleton("tree-sitter-client")) {
          getTreeSitterClient().destroy()
          destroySingleton("tree-sitter-client")
        }
      }
    },
  }
})

export async function createCliRenderer(config: CliRendererConfig = {}): Promise<CliRenderer> {
  if (process.argv.includes("--delay-start")) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  const stdin = config.stdin || process.stdin
  const stdout = config.stdout || process.stdout

  const width = stdout.columns || 80
  const height = stdout.rows || 24
  const renderHeight =
    config.experimental_splitHeight && config.experimental_splitHeight > 0 ? config.experimental_splitHeight : height

  const ziglib = resolveRenderLib()
  const rendererPtr = ziglib.createRenderer(width, renderHeight)
  if (!rendererPtr) {
    throw new Error("Failed to create renderer")
  }
  if (config.useThread === undefined) {
    config.useThread = true
  }

  // Disable threading on linux because there currently is currently an issue
  // might be just a missing dependency for the build or something, but threads crash on linux
  if (process.platform === "linux") {
    config.useThread = false
  }
  ziglib.setUseThread(rendererPtr, config.useThread)

  const kittyConfig = config.useKittyKeyboard ?? {}
  const kittyFlags = buildKittyKeyboardFlags(kittyConfig)

  ziglib.setKittyKeyboardFlags(rendererPtr, kittyFlags)

  const renderer = new CliRenderer(ziglib, rendererPtr, stdin, stdout, width, height, config)
  await renderer.setupTerminal()
  return renderer
}

export enum CliRenderEvents {
  DEBUG_OVERLAY_TOGGLE = "debugOverlay:toggle",
  DESTROY = "destroy",
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
  public rendererPtr: Pointer
  public stdin: NodeJS.ReadStream
  private stdout: NodeJS.WriteStream
  private exitOnCtrlC: boolean
  private exitSignals: NodeJS.Signals[]
  private _exitListenersAdded: boolean = false
  private _isDestroyed: boolean = false
  public nextRenderBuffer: OptimizedBuffer
  public currentRenderBuffer: OptimizedBuffer
  private _isRunning: boolean = false
  private targetFps: number = 30
  private maxFps: number = 60
  private automaticMemorySnapshot: boolean = false
  private memorySnapshotInterval: number
  private memorySnapshotTimer: Timer | null = null
  private lastMemorySnapshot: { heapUsed: number; heapTotal: number; arrayBuffers: number } = {
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

  private rendering: boolean = false
  private renderingNative: boolean = false
  private renderTimeout: Timer | null = null
  private lastTime: number = 0
  private frameCount: number = 0
  private lastFpsTime: number = 0
  private currentFps: number = 0
  private targetFrameTime: number = 1000 / this.targetFps
  private minTargetFrameTime: number = 1000 / this.maxFps
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
    enabled: false,
    corner: DebugOverlayCorner.bottomRight,
  }

  private _console: TerminalConsole
  private _resolution: PixelResolution | null = null
  private _keyHandler: InternalKeyHandler
  private _stdinBuffer: StdinBuffer

  private animationRequest: Map<number, FrameRequestCallback> = new Map()

  private resizeTimeoutId: ReturnType<typeof setTimeout> | null = null
  private capabilityTimeoutId: ReturnType<typeof setTimeout> | null = null
  private resizeDebounceDelay: number = 100

  private enableMouseMovement: boolean = false
  private _useMouse: boolean = true
  private _useAlternateScreen: boolean = env.OTUI_USE_ALTERNATE_SCREEN
  private _suspendedMouseEnabled: boolean = false
  private _previousControlState: RendererControlState = RendererControlState.IDLE
  private capturedRenderable?: Renderable
  private lastOverRenderableNum: number = 0
  private lastOverRenderable?: Renderable

  private currentSelection: Selection | null = null
  private selectionContainers: Renderable[] = []

  private _splitHeight: number = 0
  private renderOffset: number = 0

  private _terminalWidth: number = 0
  private _terminalHeight: number = 0
  private _terminalIsSetup: boolean = false

  private realStdoutWrite: (chunk: any, encoding?: any, callback?: any) => boolean
  private captureCallback: () => void = () => {
    if (this._splitHeight > 0) {
      this.requestRender()
    }
  }

  private _useConsole: boolean = true
  private mouseParser: MouseParser = new MouseParser()
  private sigwinchHandler: () => void = (() => {
    const width = this.stdout.columns || 80
    const height = this.stdout.rows || 24
    this.handleResize(width, height)
  }).bind(this)
  private _capabilities: any | null = null
  private _latestPointer: { x: number; y: number } = { x: 0, y: 0 }

  private _currentFocusedRenderable: Renderable | null = null
  private lifecyclePasses: Set<Renderable> = new Set()
  private _openConsoleOnError: boolean = true
  private _paletteDetector: TerminalPaletteDetector | null = null
  private _cachedPalette: TerminalColors | null = null
  private _paletteDetectionPromise: Promise<TerminalColors> | null = null
  private _onDestroy?: () => void

  private inputHandlers: ((sequence: string) => boolean)[] = []
  private prependedInputHandlers: ((sequence: string) => boolean)[] = []

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
    const capturedOutput = capture.claimOutput()

    if (capturedOutput.length > 0 || cachedLogs.length > 0) {
      this.realStdoutWrite.call(this.stdout, optionalMessage)
    }

    if (cachedLogs.length > 0) {
      this.realStdoutWrite.call(this.stdout, "Console cache:\n")
      this.realStdoutWrite.call(this.stdout, cachedLogs)
    }

    if (capturedOutput.length > 0) {
      this.realStdoutWrite.call(this.stdout, "\nCaptured output:\n")
      this.realStdoutWrite.call(this.stdout, capturedOutput + "\n")
    }

    this.realStdoutWrite.call(this.stdout, ANSI.reset)
  }

  private exitHandler: () => void = (() => {
    this.destroy()
    if (env.OTUI_DUMP_CAPTURES) {
      Bun.sleep(100).then(() => {
        this.dumpOutputCache("=== CAPTURED OUTPUT ===\n")
      })
    }
  }).bind(this)

  private warningHandler: (warning: any) => void = ((warning: any) => {
    console.warn(JSON.stringify(warning.message, null, 2))
  }).bind(this)

  public get controlState(): RendererControlState {
    return this._controlState
  }

  constructor(
    lib: RenderLib,
    rendererPtr: Pointer,
    stdin: NodeJS.ReadStream,
    stdout: NodeJS.WriteStream,
    width: number,
    height: number,
    config: CliRendererConfig = {},
  ) {
    super()

    rendererTracker.addRenderer(this)

    this.stdin = stdin
    this.stdout = stdout
    this.realStdoutWrite = stdout.write
    this.lib = lib
    this._terminalWidth = stdout.columns
    this._terminalHeight = stdout.rows
    this.width = width
    this.height = height
    this._useThread = config.useThread === undefined ? false : config.useThread
    this._splitHeight = config.experimental_splitHeight || 0

    if (this._splitHeight > 0) {
      capture.on("write", this.captureCallback)
      this.renderOffset = height - this._splitHeight
      this.height = this._splitHeight
      lib.setRenderOffset(rendererPtr, this.renderOffset)
    }

    this.rendererPtr = rendererPtr
    this.exitOnCtrlC = config.exitOnCtrlC === undefined ? true : config.exitOnCtrlC
    this.exitSignals = config.exitSignals || ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"]
    this.resizeDebounceDelay = config.debounceDelay || 100
    this.targetFps = config.targetFps || 30
    this.maxFps = config.maxFps || 60
    this.targetFrameTime = 1000 / this.targetFps
    this.minTargetFrameTime = 1000 / this.maxFps
    this.memorySnapshotInterval = config.memorySnapshotInterval ?? 0
    this.gatherStats = config.gatherStats || false
    this.maxStatSamples = config.maxStatSamples || 300
    this.enableMouseMovement = config.enableMouseMovement ?? true
    this._useMouse = config.useMouse ?? true
    this._useAlternateScreen = config.useAlternateScreen ?? env.OTUI_USE_ALTERNATE_SCREEN
    this.nextRenderBuffer = this.lib.getNextBuffer(this.rendererPtr)
    this.currentRenderBuffer = this.lib.getCurrentBuffer(this.rendererPtr)
    this.postProcessFns = config.postProcessFns || []
    this.prependedInputHandlers = config.prependInputHandlers || []

    this.root = new RootRenderable(this)

    if (this.memorySnapshotInterval > 0) {
      this.startMemorySnapshotTimer()
    }

    if (env.OTUI_OVERRIDE_STDOUT) {
      this.stdout.write = this.interceptStdoutWrite.bind(this)
    }

    // Handle terminal resize
    process.on("SIGWINCH", this.sigwinchHandler)

    process.on("warning", this.warningHandler)

    process.on("uncaughtException", this.handleError)
    process.on("unhandledRejection", this.handleError)
    process.on("beforeExit", this.exitHandler)

    const kittyConfig = config.useKittyKeyboard ?? {}
    const useKittyForParsing = kittyConfig !== null
    this._keyHandler = new InternalKeyHandler(useKittyForParsing)
    this._keyHandler.on("keypress", (event) => {
      if (this.exitOnCtrlC && event.name === "c" && event.ctrl) {
        process.nextTick(() => {
          this.destroy()
        })
        return
      }
    })

    this.addExitListeners()

    this._stdinBuffer = new StdinBuffer({ timeout: 5 })

    this._console = new TerminalConsole(this, config.consoleOptions)
    this.useConsole = config.useConsole ?? true
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
      }
    }

    this.setupInput()
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

  public focusRenderable(renderable: Renderable) {
    if (this._currentFocusedRenderable === renderable) return

    if (this._currentFocusedRenderable) {
      this._currentFocusedRenderable.blur()
    }

    this._currentFocusedRenderable = renderable
  }

  public addToHitGrid(x: number, y: number, width: number, height: number, id: number) {
    if (id !== this.capturedRenderable?.num) {
      this.lib.addToHitGrid(this.rendererPtr, x, y, width, height, id)
    }
  }

  public get widthMethod(): WidthMethod {
    const caps = this.capabilities
    return caps?.unicode === "wcwidth" ? "wcwidth" : "unicode"
  }

  private writeOut(chunk: any, encoding?: any, callback?: any): boolean {
    return this.realStdoutWrite.call(this.stdout, chunk, encoding, callback)
  }

  public requestRender() {
    if (this._controlState === RendererControlState.EXPLICIT_SUSPENDED) {
      return
    }

    if (this._isRunning) {
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
      const now = Date.now()
      const elapsed = now - this.lastTime
      const delay = Math.max(this.minTargetFrameTime - elapsed, 0)

      if (delay === 0) {
        process.nextTick(() => this.activateFrame())
        return
      }

      setTimeout(() => this.activateFrame(), delay)
    }
  }

  private async activateFrame() {
    await this.loop()
    this.updateScheduled = false
    this.resolveIdleIfNeeded()
  }

  public get useConsole(): boolean {
    return this._useConsole
  }

  public set useConsole(value: boolean) {
    this._useConsole = value
    if (value) {
      this.console.activate()
    } else {
      this.console.deactivate()
    }
  }

  public get isRunning(): boolean {
    return this._isRunning
  }

  private isIdleNow(): boolean {
    return (
      !this._isRunning &&
      !this.rendering &&
      !this.renderTimeout &&
      !this.updateScheduled &&
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

  public get useMouse(): boolean {
    return this._useMouse
  }

  public set useMouse(useMouse: boolean) {
    if (this._useMouse === useMouse) return // No change needed

    this._useMouse = useMouse

    if (useMouse) {
      this.enableMouse()
    } else {
      this.disableMouse()
    }
  }

  public get experimental_splitHeight(): number {
    return this._splitHeight
  }

  public get liveRequestCount(): number {
    return this.liveRequestCounter
  }

  public get currentControlState(): string {
    return this._controlState
  }

  public get capabilities(): any | null {
    return this._capabilities
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

  public set experimental_splitHeight(splitHeight: number) {
    if (splitHeight < 0) splitHeight = 0

    const prevSplitHeight = this._splitHeight

    if (splitHeight > 0) {
      this._splitHeight = splitHeight
      this.renderOffset = this._terminalHeight - this._splitHeight
      this.height = this._splitHeight

      if (prevSplitHeight === 0) {
        this.useConsole = false
        capture.on("write", this.captureCallback)
        const freedLines = this._terminalHeight - this._splitHeight
        const scrollDown = ANSI.scrollDown(freedLines)
        this.writeOut(scrollDown)
      } else if (prevSplitHeight > this._splitHeight) {
        const freedLines = prevSplitHeight - this._splitHeight
        const scrollDown = ANSI.scrollDown(freedLines)
        this.writeOut(scrollDown)
      } else if (prevSplitHeight < this._splitHeight) {
        const additionalLines = this._splitHeight - prevSplitHeight
        const scrollUp = ANSI.scrollUp(additionalLines)
        this.writeOut(scrollUp)
      }
    } else {
      if (prevSplitHeight > 0) {
        this.flushStdoutCache(this._terminalHeight, true)

        capture.off("write", this.captureCallback)
        this.useConsole = true
      }

      this._splitHeight = 0
      this.renderOffset = 0
      this.height = this._terminalHeight
    }

    this.width = this._terminalWidth
    this.lib.setRenderOffset(this.rendererPtr, this.renderOffset)
    this.lib.resizeRenderer(this.rendererPtr, this.width, this.height)
    this.nextRenderBuffer = this.lib.getNextBuffer(this.rendererPtr)

    this._console.resize(this.width, this.height)
    this.root.resize(this.width, this.height)
    this.emit("resize", this.width, this.height)
    this.requestRender()
  }

  private interceptStdoutWrite = (chunk: any, encoding?: any, callback?: any): boolean => {
    const text = chunk.toString()

    capture.write("stdout", text)
    if (this._splitHeight > 0) {
      this.requestRender()
    }

    if (typeof callback === "function") {
      process.nextTick(callback)
    }

    return true
  }

  public disableStdoutInterception(): void {
    this.stdout.write = this.realStdoutWrite
  }

  // TODO: Move this to native
  private flushStdoutCache(space: number, force: boolean = false): boolean {
    if (capture.size === 0 && !force) return false

    const output = capture.claimOutput()

    const rendererStartLine = this._terminalHeight - this._splitHeight
    const flush = ANSI.moveCursorAndClear(rendererStartLine, 1)

    const outputLine = this._terminalHeight - this._splitHeight
    const move = ANSI.moveCursor(outputLine, 1)

    let clear = ""
    if (space > 0) {
      const backgroundColor = this.backgroundColor.toInts()
      const newlines = " ".repeat(this.width) + "\n".repeat(space)
      clear =
        ANSI.setRgbBackground(backgroundColor[0], backgroundColor[1], backgroundColor[2]) +
        newlines +
        ANSI.resetBackground
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
    this.capturedRenderable = undefined
    this.mouseParser.reset()
    this.lib.disableMouse(this.rendererPtr)
  }

  public enableKittyKeyboard(flags: number = 0b00011): void {
    this.lib.enableKittyKeyboard(this.rendererPtr, flags)
  }

  public disableKittyKeyboard(): void {
    this.lib.disableKittyKeyboard(this.rendererPtr)
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

    this.lib.setupTerminal(this.rendererPtr, this._useAlternateScreen)
    this._capabilities = this.lib.getTerminalCapabilities(this.rendererPtr)

    this.capabilityTimeoutId = setTimeout(() => {
      this.capabilityTimeoutId = null
      this.removeInputHandler(this.capabilityHandler)
    }, 5000)

    if (this._useMouse) {
      this.enableMouse()
    }

    this.queryPixelResolution()
  }

  private stdinListener: (data: Buffer) => void = ((data: Buffer) => {
    // Mouse first (consume and stop if handled)
    if (this._useMouse && this.handleMouseData(data)) {
      return
    }

    // Everything else goes through the sequence buffer
    this._stdinBuffer.process(data)
  }).bind(this)

  public addInputHandler(handler: (sequence: string) => boolean): void {
    this.inputHandlers.push(handler)
  }

  public prependInputHandler(handler: (sequence: string) => boolean): void {
    this.inputHandlers.unshift(handler)
  }

  public removeInputHandler(handler: (sequence: string) => boolean): void {
    this.inputHandlers = this.inputHandlers.filter((h) => h !== handler)
  }

  private capabilityHandler: (sequence: string) => boolean = ((sequence: string) => {
    if (isCapabilityResponse(sequence)) {
      this.lib.processCapabilityResponse(this.rendererPtr, sequence)
      this._capabilities = this.lib.getTerminalCapabilities(this.rendererPtr)
      this.emit("capabilities", this._capabilities)
      return true
    }
    return false
  }).bind(this)

  private focusHandler: (sequence: string) => boolean = ((sequence: string) => {
    if (sequence === "\x1b[I") {
      this.emit("focus")
      return true
    }
    if (sequence === "\x1b[O") {
      this.emit("blur")
      return true
    }
    return false
  }).bind(this)

  private setupInput(): void {
    for (const handler of this.prependedInputHandlers) {
      this.addInputHandler(handler)
    }

    this.addInputHandler((sequence: string) => {
      if (isPixelResolutionResponse(sequence) && this.waitingForPixelResolution) {
        const resolution = parsePixelResolution(sequence)
        if (resolution) {
          this._resolution = resolution
          this.waitingForPixelResolution = false
        }
        return true
      }
      return false
    })
    this.addInputHandler(this.capabilityHandler)
    this.addInputHandler(this.focusHandler)
    this.addInputHandler((sequence: string) => {
      return this._keyHandler.processInput(sequence)
    })

    if (this.stdin.setRawMode) {
      this.stdin.setRawMode(true)
    }

    this.stdin.resume()
    this.stdin.setEncoding("utf8")
    this.stdin.on("data", this.stdinListener)
    this._stdinBuffer.on("data", (sequence: string) => {
      // Capture all input in debug mode
      if (this._debugModeEnabled) {
        this._debugInputs.push({
          timestamp: new Date().toISOString(),
          sequence,
        })
      }

      for (const handler of this.inputHandlers) {
        if (handler(sequence)) {
          return
        }
      }
    })
    this._stdinBuffer.on("paste", (data: string) => {
      this._keyHandler.processPaste(data)
    })
  }

  private handleMouseData(data: Buffer): boolean {
    const result = this.mouseParser.parseMouseEventWithConsumed(data)

    if (result) {
      const { event: mouseEvent, consumed } = result

      // Process any remaining data in the buffer (e.g., paste data that follows a mouse event)
      // This handles terminals like Alacritty that combine mouse events with other sequences
      if (consumed < data.length) {
        const remaining = data.slice(consumed)
        this._stdinBuffer.process(remaining)
      }

      if (this._splitHeight > 0) {
        if (mouseEvent.y < this.renderOffset) {
          return false
        }
        mouseEvent.y -= this.renderOffset
      }

      this._latestPointer.x = mouseEvent.x
      this._latestPointer.y = mouseEvent.y

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
        const maybeRenderableId = this.lib.checkHit(this.rendererPtr, mouseEvent.x, mouseEvent.y)
        const maybeRenderable = Renderable.renderablesByNumber.get(maybeRenderableId)

        if (maybeRenderable) {
          const event = new MouseEvent(maybeRenderable, mouseEvent)
          maybeRenderable.processMouseEvent(event)
        }
        return true
      }

      const maybeRenderableId = this.lib.checkHit(this.rendererPtr, mouseEvent.x, mouseEvent.y)
      const sameElement = maybeRenderableId === this.lastOverRenderableNum
      this.lastOverRenderableNum = maybeRenderableId
      const maybeRenderable = Renderable.renderablesByNumber.get(maybeRenderableId)

      if (
        mouseEvent.type === "down" &&
        mouseEvent.button === MouseButton.LEFT &&
        !this.currentSelection?.isSelecting &&
        !mouseEvent.modifiers.ctrl
      ) {
        if (
          maybeRenderable &&
          maybeRenderable.selectable &&
          !maybeRenderable.isDestroyed &&
          maybeRenderable.shouldStartSelection(mouseEvent.x, mouseEvent.y)
        ) {
          this.startSelection(maybeRenderable, mouseEvent.x, mouseEvent.y)
          const event = new MouseEvent(maybeRenderable, mouseEvent)
          maybeRenderable.processMouseEvent(event)
          return true
        }
      }

      if (mouseEvent.type === "drag" && this.currentSelection?.isSelecting) {
        this.updateSelection(maybeRenderable, mouseEvent.x, mouseEvent.y)

        if (maybeRenderable) {
          const event = new MouseEvent(maybeRenderable, { ...mouseEvent, isSelecting: true })
          maybeRenderable.processMouseEvent(event)
        }

        return true
      }

      if (mouseEvent.type === "up" && this.currentSelection?.isSelecting) {
        if (maybeRenderable) {
          const event = new MouseEvent(maybeRenderable, { ...mouseEvent, isSelecting: true })
          maybeRenderable.processMouseEvent(event)
        }

        this.finishSelection()
        return true
      }

      if (mouseEvent.type === "down" && mouseEvent.button === MouseButton.LEFT && this.currentSelection) {
        if (mouseEvent.modifiers.ctrl) {
          this.currentSelection.isSelecting = true
          this.updateSelection(maybeRenderable, mouseEvent.x, mouseEvent.y)
          return true
        }
      }

      if (!sameElement && (mouseEvent.type === "drag" || mouseEvent.type === "move")) {
        if (this.lastOverRenderable && this.lastOverRenderable !== this.capturedRenderable) {
          const event = new MouseEvent(this.lastOverRenderable, { ...mouseEvent, type: "out" })
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
        const event = new MouseEvent(this.capturedRenderable, { ...mouseEvent, type: "drag-end" })
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
        this.capturedRenderable = undefined
        // Dropping the renderable needs to push another frame when the renderer is not live
        // to update the hit grid, otherwise capturedRenderable won't be in the hit grid and will not receive mouse events
        this.requestRender()
      }

      let event: MouseEvent | undefined = undefined
      if (maybeRenderable) {
        if (mouseEvent.type === "drag" && mouseEvent.button === MouseButton.LEFT) {
          this.capturedRenderable = maybeRenderable
        } else {
          this.capturedRenderable = undefined
        }
        event = new MouseEvent(maybeRenderable, mouseEvent)
        maybeRenderable.processMouseEvent(event)
      } else {
        this.capturedRenderable = undefined
        this.lastOverRenderable = undefined
      }

      if (!event?.defaultPrevented && mouseEvent.type === "down" && this.currentSelection) {
        this.clearSelection()
      }

      return true
    }

    return false
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

    this.emit("memory:snapshot", this.lastMemorySnapshot)
  }

  private startMemorySnapshotTimer(): void {
    this.stopMemorySnapshotTimer()

    this.memorySnapshotTimer = setInterval(() => {
      this.takeMemorySnapshot()
    }, this.memorySnapshotInterval)
  }

  private stopMemorySnapshotTimer(): void {
    if (this.memorySnapshotTimer) {
      clearInterval(this.memorySnapshotTimer)
      this.memorySnapshotTimer = null
    }
  }

  public setMemorySnapshotInterval(interval: number): void {
    this.memorySnapshotInterval = interval

    if (this._isRunning && interval > 0) {
      this.startMemorySnapshotTimer()
    } else if (interval <= 0 && this.memorySnapshotTimer) {
      clearInterval(this.memorySnapshotTimer)
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
      clearTimeout(this.resizeTimeoutId)
      this.resizeTimeoutId = null
    }

    this.resizeTimeoutId = setTimeout(() => {
      this.resizeTimeoutId = null
      this.processResize(width, height)
    }, this.resizeDebounceDelay)
  }

  private queryPixelResolution() {
    this.waitingForPixelResolution = true
    this.lib.queryPixelResolution(this.rendererPtr)
  }

  private processResize(width: number, height: number): void {
    if (width === this._terminalWidth && height === this._terminalHeight) return

    const prevWidth = this._terminalWidth

    this._terminalWidth = width
    this._terminalHeight = height
    this.queryPixelResolution()

    this.capturedRenderable = undefined
    this.mouseParser.reset()

    if (this._splitHeight > 0) {
      // TODO: Handle resizing split mode properly
      if (width < prevWidth) {
        const start = this._terminalHeight - this._splitHeight * 2
        const flush = ANSI.moveCursorAndClear(start, 1)
        this.writeOut(flush)
      }
      this.renderOffset = height - this._splitHeight
      this.width = width
      this.height = this._splitHeight
      this.currentRenderBuffer.clear(this.backgroundColor)
      this.lib.setRenderOffset(this.rendererPtr, this.renderOffset)
    } else {
      this.width = width
      this.height = height
    }

    this.lib.resizeRenderer(this.rendererPtr, this.width, this.height)
    this.nextRenderBuffer = this.lib.getNextBuffer(this.rendererPtr)
    this.currentRenderBuffer = this.lib.getCurrentBuffer(this.rendererPtr)
    this._console.resize(this.width, this.height)
    this.root.resize(this.width, this.height)
    this.emit("resize", this.width, this.height)
    this.requestRender()
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

  public dumpHitGrid(): void {
    this.lib.dumpHitGrid(this.rendererPtr)
  }

  public dumpBuffers(timestamp?: number): void {
    this.lib.dumpBuffers(this.rendererPtr, timestamp)
  }

  public dumpStdoutBuffer(timestamp?: number): void {
    this.lib.dumpStdoutBuffer(this.rendererPtr, timestamp)
  }

  public static setCursorPosition(renderer: CliRenderer, x: number, y: number, visible: boolean = true): void {
    const lib = resolveRenderLib()
    lib.setCursorPosition(renderer.rendererPtr, x, y, visible)
  }

  public static setCursorStyle(
    renderer: CliRenderer,
    style: CursorStyle,
    blinking: boolean = false,
    color?: RGBA,
  ): void {
    const lib = resolveRenderLib()
    lib.setCursorStyle(renderer.rendererPtr, style, blinking)
    if (color) {
      lib.setCursorColor(renderer.rendererPtr, color)
    }
  }

  public static setCursorColor(renderer: CliRenderer, color: RGBA): void {
    const lib = resolveRenderLib()
    lib.setCursorColor(renderer.rendererPtr, color)
  }

  public setCursorPosition(x: number, y: number, visible: boolean = true): void {
    this.lib.setCursorPosition(this.rendererPtr, x, y, visible)
  }

  public setCursorStyle(style: CursorStyle, blinking: boolean = false, color?: RGBA): void {
    this.lib.setCursorStyle(this.rendererPtr, style, blinking)
    if (color) {
      this.lib.setCursorColor(this.rendererPtr, color)
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
    this.internalPause()

    this._suspendedMouseEnabled = this._useMouse

    this.disableMouse()
    this.removeExitListeners()
    this._stdinBuffer.clear()
    this.stdin.removeListener("data", this.stdinListener)
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

    this.stdin.resume()
    this.addExitListeners()

    setImmediate(() => {
      // Consume any existing stdin data to avoid processing stale input
      while (this.stdin.read() !== null) {}
      this.stdin.on("data", this.stdinListener)
    })

    this.lib.resumeRenderer(this.rendererPtr)

    if (this._suspendedMouseEnabled) {
      this.enableMouse()
    }

    this.currentRenderBuffer.clear(this.backgroundColor)
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
  }

  public stop(): void {
    this._controlState = RendererControlState.EXPLICIT_STOPPED
    this.internalStop()
  }

  private internalStop(): void {
    if (this.isRunning && !this._isDestroyed) {
      this._isRunning = false

      if (this.memorySnapshotTimer) {
        clearInterval(this.memorySnapshotTimer)
        this.memorySnapshotTimer = null
      }

      if (this.renderTimeout) {
        clearTimeout(this.renderTimeout)
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

    process.removeListener("SIGWINCH", this.sigwinchHandler)
    process.removeListener("uncaughtException", this.handleError)
    process.removeListener("unhandledRejection", this.handleError)
    process.removeListener("warning", this.warningHandler)
    process.removeListener("beforeExit", this.exitHandler)
    capture.removeListener("write", this.captureCallback)
    this.removeExitListeners()

    if (this.resizeTimeoutId !== null) {
      clearTimeout(this.resizeTimeoutId)
      this.resizeTimeoutId = null
    }

    if (this.capabilityTimeoutId !== null) {
      clearTimeout(this.capabilityTimeoutId)
      this.capabilityTimeoutId = null
    }

    if (this.memorySnapshotTimer) {
      clearInterval(this.memorySnapshotTimer)
    }

    // Clean up palette detector
    if (this._paletteDetector) {
      this._paletteDetector.cleanup()
      this._paletteDetector = null
    }
    this._paletteDetectionPromise = null
    this._cachedPalette = null

    this.emit(CliRenderEvents.DESTROY)

    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout)
      this.renderTimeout = null
    }
    this._isRunning = false

    this.waitingForPixelResolution = false
    this.capturedRenderable = undefined

    try {
      this.root.destroyRecursively()
    } catch (e) {
      console.error("Error destroying root renderable:", e instanceof Error ? e.stack : String(e))
    }

    this._stdinBuffer.destroy()
    this._console.destroy()
    this.disableStdoutInterception()

    if (this._splitHeight > 0) {
      this.flushStdoutCache(this._splitHeight, true)
    }

    if (this.stdin.setRawMode) {
      this.stdin.setRawMode(false)
    }
    this.stdin.removeListener("data", this.stdinListener)

    this.lib.destroyRenderer(this.rendererPtr)
    rendererTracker.removeRenderer(this)

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

    this.lastTime = Date.now()
    this.frameCount = 0
    this.lastFpsTime = this.lastTime
    this.currentFps = 0

    this.loop()
  }

  private async loop(): Promise<void> {
    if (this.rendering || this._isDestroyed) return
    this.renderTimeout = null

    this.rendering = true
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout)
      this.renderTimeout = null
    }

    const now = Date.now()
    const elapsed = now - this.lastTime

    const deltaTime = elapsed
    this.lastTime = now

    this.frameCount++
    if (now - this.lastFpsTime >= 1000) {
      this.currentFps = this.frameCount
      this.frameCount = 0
      this.lastFpsTime = now
    }

    this.renderStats.frameCount++
    this.renderStats.fps = this.currentFps
    const overallStart = performance.now()

    const frameRequests = Array.from(this.animationRequest.values())
    this.animationRequest.clear()
    const animationRequestStart = performance.now()
    frameRequests.forEach((callback) => {
      callback(deltaTime)
      this.dropLive()
    })
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

    // Render the renderable tree
    this.root.render(this.nextRenderBuffer, deltaTime)

    for (const postProcessFn of this.postProcessFns) {
      postProcessFn(this.nextRenderBuffer, deltaTime)
    }

    this._console.renderToBuffer(this.nextRenderBuffer)

    if (!this._isDestroyed) {
      this.renderNative()

      const overallFrameTime = performance.now() - overallStart

      // TODO: Add animationRequestTime to stats
      this.lib.updateStats(this.rendererPtr, overallFrameTime, this.renderStats.fps, this.renderStats.frameCallbackTime)

      if (this.gatherStats) {
        this.collectStatSample(overallFrameTime)
      }

      if (this._isRunning || this.immediateRerenderRequested) {
        const targetFrameTime = this.immediateRerenderRequested ? this.minTargetFrameTime : this.targetFrameTime
        const delay = Math.max(1, targetFrameTime - Math.floor(overallFrameTime))
        this.immediateRerenderRequested = false
        this.renderTimeout = setTimeout(() => {
          this.renderTimeout = null
          this.loop()
        }, delay)
      } else {
        clearTimeout(this.renderTimeout!)
        this.renderTimeout = null
      }
    }

    this.rendering = false
    this.resolveIdleIfNeeded()
  }

  public intermediateRender(): void {
    this.immediateRerenderRequested = true
    this.loop()
  }

  private renderNative(): void {
    if (this.renderingNative) {
      console.error("Rendering called concurrently")
      throw new Error("Rendering called concurrently")
    }

    let force = false
    if (this._splitHeight > 0) {
      // TODO: Flickering could maybe be even more reduced by moving the flush to the native layer,
      // to output the flush with the buffered writer, after the render is done.
      force = this.flushStdoutCache(this._splitHeight)
    }

    this.renderingNative = true
    this.lib.render(this.rendererPtr, force)
    // this.dumpStdoutBuffer(Date.now())
    this.renderingNative = false
  }

  private collectStatSample(frameTime: number): void {
    this.frameTimes.push(frameTime)
    if (this.frameTimes.length > this.maxStatSamples) {
      this.frameTimes.shift()
    }
  }

  public getStats(): {
    fps: number
    frameCount: number
    frameTimes: number[]
    averageFrameTime: number
    minFrameTime: number
    maxFrameTime: number
  } {
    const frameTimes = [...this.frameTimes]
    const sum = frameTimes.reduce((acc, time) => acc + time, 0)
    const avg = frameTimes.length ? sum / frameTimes.length : 0
    const min = frameTimes.length ? Math.min(...frameTimes) : 0
    const max = frameTimes.length ? Math.max(...frameTimes) : 0

    return {
      fps: this.renderStats.fps,
      frameCount: this.renderStats.frameCount,
      frameTimes,
      averageFrameTime: avg,
      minFrameTime: min,
      maxFrameTime: max,
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

  public updateSelection(currentRenderable: Renderable | undefined, x: number, y: number): void {
    if (this.currentSelection) {
      this.currentSelection.isStart = false
      this.currentSelection.focus = { x, y }

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
    if (this.currentSelection?.isSelecting) {
      const pointer = this._latestPointer

      const maybeRenderableId = this.lib.checkHit(this.rendererPtr, pointer.x, pointer.y)
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
      this.currentSelection.isSelecting = false
      this.emit("selection", this.currentSelection)
      // Notify renderables that selection is finished (no longer dragging)
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
    if (this._cachedPalette) return "cached"
    if (this._paletteDetectionPromise) return "detecting"
    return "idle"
  }

  public clearPaletteCache(): void {
    this._cachedPalette = null
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

    if (this._cachedPalette && this._cachedPalette.palette.length !== requestedSize) {
      this._cachedPalette = null
    }

    if (this._cachedPalette) {
      return this._cachedPalette
    }

    if (this._paletteDetectionPromise) {
      return this._paletteDetectionPromise
    }

    if (!this._paletteDetector) {
      const isLegacyTmux =
        this.capabilities?.terminal?.name?.toLowerCase()?.includes("tmux") &&
        this.capabilities?.terminal?.version?.localeCompare("3.6") < 0
      this._paletteDetector = createTerminalPalette(this.stdin, this.stdout, this.writeOut.bind(this), isLegacyTmux)
    }

    this._paletteDetectionPromise = this._paletteDetector.detect(options).then((result) => {
      this._cachedPalette = result
      this._paletteDetectionPromise = null
      return result
    })

    return this._paletteDetectionPromise
  }
}
