import type { RGBA } from "./lib/RGBA.js"
import type { EventEmitter } from "events"
import type { Selection } from "./lib/selection.js"
import type { Renderable } from "./Renderable.js"
import type { InternalKeyHandler, KeyHandler } from "./lib/KeyHandler.js"
import type { EditBufferRenderable } from "./renderables/EditBufferRenderable.js"

export const TextAttributes = {
  NONE: 0,
  BOLD: 1 << 0, // 1
  DIM: 1 << 1, // 2
  ITALIC: 1 << 2, // 4
  UNDERLINE: 1 << 3, // 8
  BLINK: 1 << 4, // 16
  INVERSE: 1 << 5, // 32
  HIDDEN: 1 << 6, // 64
  STRIKETHROUGH: 1 << 7, // 128
}

// Constants for attribute bit packing
export const ATTRIBUTE_BASE_BITS = 8
export const ATTRIBUTE_BASE_MASK = 0xff

/**
 * Extract the base 8 bits of attributes from a u32 attribute value.
 * Currently we only use the first 8 bits for standard text attributes.
 */
export function getBaseAttributes(attr: number): number {
  return attr & ATTRIBUTE_BASE_MASK
}

export type ThemeMode = "dark" | "light"

export type CursorStyle = "block" | "line" | "underline" | "default"

/** How a selection occupies cells between stored anchor and focus offsets.
 * Independent of `cursorStyle` (CSI `q` is paint). Default `cell` includes
 * the grapheme under the max endpoint. `boundary` is the half-open insert
 * range `[min, max)`. */
export type SelectionOccupancy = "cell" | "boundary"

/** How local cell coordinates expand into a highlight range.
 * `cell` is the current inclusive press/drag. `word` and `line` expand
 * each endpoint through native selectWord / selectLine. */
export type SelectionBehavior = "cell" | "word" | "line"

export type MousePointerStyle =
  | "auto"
  | "default"
  | "none"
  | "context-menu"
  | "help"
  | "pointer"
  | "progress"
  | "wait"
  | "cell"
  | "crosshair"
  | "text"
  | "vertical-text"
  | "alias"
  | "copy"
  | "move"
  | "no-drop"
  | "not-allowed"
  | "grab"
  | "grabbing"
  | "all-scroll"
  | "col-resize"
  | "row-resize"
  | "n-resize"
  | "e-resize"
  | "s-resize"
  | "w-resize"
  | "ne-resize"
  | "nw-resize"
  | "se-resize"
  | "sw-resize"
  | "ew-resize"
  | "ns-resize"
  | "nesw-resize"
  | "nwse-resize"
  | "zoom-in"
  | "zoom-out"

export interface CursorStyleOptions {
  style?: CursorStyle
  blinking?: boolean
  color?: RGBA
  cursor?: MousePointerStyle
}

export enum DebugOverlayCorner {
  topLeft = 0,
  topRight = 1,
  bottomLeft = 2,
  bottomRight = 3,
}

export enum TargetChannel {
  FG = 1,
  BG = 2,
  Both = 3,
}

export type WidthMethod = "wcwidth" | "unicode" | "unicode-wide"
export type TerminalMultiplexer = "none" | "tmux" | "zellij" | "screen" | "unknown"
export type TerminalCapabilityState = "unknown" | "supported" | "unsupported"
export type ImageRenderProtocol = "auto" | "kitty" | "sixel" | "blocks"

export interface TerminalInfo {
  name: string
  version: string
  from_xtversion: boolean
}

export interface TerminalCapabilities {
  kitty_keyboard: boolean
  kitty_graphics: boolean
  rgb: boolean
  ansi256: boolean
  unicode: WidthMethod
  sgr_pixels: boolean
  color_scheme_updates: boolean
  explicit_width: boolean
  scaled_text: boolean
  sixel: boolean
  focus_tracking: boolean
  sync: boolean
  bracketed_paste: boolean
  hyperlinks: boolean
  osc52: boolean
  osc52_support: TerminalCapabilityState
  notifications: boolean
  explicit_cursor_positioning: boolean
  remote: boolean
  multiplexer: TerminalMultiplexer
  image_protocol?: ImageRenderProtocol
  terminal: TerminalInfo
}

export interface RendererEvents {
  resize: (width: number, height: number) => void
  key: (data: Buffer) => void
  "memory:snapshot": (snapshot: { heapUsed: number; heapTotal: number; arrayBuffers: number }) => void
  capabilities: (capabilities: TerminalCapabilities) => void
  selection: (selection: Selection) => void
  focused_renderable: (current: Renderable | null, previous: Renderable | null) => void
  focused_editor: (current: EditBufferRenderable | null, previous: EditBufferRenderable | null) => void
  "debugOverlay:toggle": (enabled: boolean) => void
  theme_mode: (mode: ThemeMode) => void
}

export interface RenderContext extends EventEmitter {
  addToHitGrid: (x: number, y: number, width: number, height: number, id: number) => void
  pushHitGridScissorRect: (x: number, y: number, width: number, height: number) => void
  popHitGridScissorRect: () => void
  clearHitGridScissorRects: () => void
  width: number
  height: number
  terminalWidth?: number
  terminalHeight?: number
  resolution?: { width: number; height: number } | null
  /** Monotonic, bumped once per `loop()` iteration. Lets renderables dedupe per-frame work. */
  frameId: number
  requestRender: () => void
  setCursorPosition: (x: number, y: number, visible: boolean) => void
  setCursorStyle: (options: CursorStyleOptions) => void
  setCursorColor: (color: RGBA) => void
  setMousePointer: (shape: MousePointerStyle) => void
  widthMethod: WidthMethod
  capabilities: TerminalCapabilities | null
  requestLive: () => void
  dropLive: () => void
  hasSelection: boolean
  getSelection: () => Selection | null
  requestSelectionUpdate: () => void
  currentFocusedRenderable: Renderable | null
  currentFocusedEditor: EditBufferRenderable | null
  focusRenderable: (renderable: Renderable) => void
  blurRenderable: (renderable: Renderable) => void
  claimFirstLineOffset?: (renderable?: Renderable) => number
  registerLifecyclePass: (renderable: Renderable) => void
  unregisterLifecyclePass: (renderable: Renderable) => void
  getLifecyclePasses: () => Set<Renderable>
  keyInput: KeyHandler
  _internalKeyInput: InternalKeyHandler
  clearSelection: () => void
  startSelection: (renderable: Renderable, x: number, y: number, behavior?: SelectionBehavior) => void
  updateSelection: (
    currentRenderable: Renderable | undefined,
    x: number,
    y: number,
    options?: { finishDragging?: boolean },
  ) => void
}

export type Timeout = ReturnType<typeof setTimeout> | undefined

export interface ViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Highlight {
  start: number
  end: number
  styleId: number
  priority?: number | null
  hlRef?: number | null
}

export interface LineInfo {
  /** Display-column offset for each visual line start. */
  lineStartCols: number[]
  /** Display-column width for each visual line. */
  lineWidthCols: number[]
  /** Maximum display-column width across the reported lines. */
  lineWidthColsMax: number
  /** Source logical line index for each visual line. */
  lineSources: number[]
  /** Wrap index within each source logical line. */
  lineWraps: number[]
}

export interface LineInfoProvider {
  get lineInfo(): LineInfo
  // Optional bounded read in visual-row coordinates, preserving lineInfo source remapping.
  getLineSources?(startLine: number, lineCount: number): number[]
  get lineCount(): number
  get virtualLineCount(): number
  get scrollY(): number
}

export interface CapturedSpan {
  text: string
  fg: RGBA
  bg: RGBA
  attributes: number
  width: number
}

export interface CapturedLine {
  spans: CapturedSpan[]
}

export interface CapturedFrame {
  cols: number
  rows: number
  cursor: [number, number]
  lines: CapturedLine[]
}
