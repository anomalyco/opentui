import {
  dlopen,
  ffiBool,
  toArrayBuffer,
  toPointer,
  type FFICallbackInstance,
  type Pointer,
  type PointerInput,
} from "./platform/ffi.js"
import { writeFile } from "./platform/runtime.js"
import { existsSync, writeFileSync } from "fs"
import {
  ATTRIBUTE_BASE_MASK,
  type CursorStyle,
  type CursorStyleOptions,
  type SelectionOccupancy,
  type SelectionBehavior,
  type DebugOverlayCorner,
  type WidthMethod,
  type TerminalCapabilities,
  type Highlight,
  type LineInfo,
  type MousePointerStyle,
  type ImageRenderProtocol,
} from "./types.js"
export type {
  LineInfo,
  AllocatorStats,
  AudioStreamCreateOptions,
  BuildOptions,
  NativeAudioCaptureStats,
  NativeAudioStreamStats,
  NativeRenderStats,
}

import { RGBA } from "./lib/RGBA.js"
import { isStyledText, type StyledText } from "./lib/styled-text.js"
import { YogaError, YogaHost, YogaStatus, rejectAsyncCallback, type MeasureFunction } from "./yoga.js"
import { env, registerEnvVar } from "./lib/env.js"
import {
  NativeSpanFeedOptionsStruct,
  NativeSpanFeedStatsStruct,
  SpanInfoStruct,
  ReserveInfoStruct,
  AudioCreateOptionsStruct,
  AudioStartOptionsStruct,
  AudioVoiceOptionsStruct,
  AudioStreamCreateOptionsStruct,
  AudioStreamStatsStruct,
  AudioCaptureStatsStruct,
  NativeAudioStreamCloseReason as NativeAudioStreamCloseReasonValue,
  NativeAudioStreamFormat as NativeAudioStreamFormatValue,
  NativeAudioStreamState as NativeAudioStreamStateValue,
  AudioStatsStruct,
  BuildOptionsStruct,
  AllocatorStatsStruct,
  NativeImageInfoStruct,
} from "./zig-structs.js"
import type {
  NativeSpanFeedOptions,
  NativeSpanFeedStats,
  ReserveInfo,
  AudioCreateOptions,
  AudioStartOptions,
  AudioVoiceOptions,
  AudioStreamCreateOptions,
  NativeAudioStreamCloseReason as NativeAudioStreamCloseReasonType,
  NativeAudioStreamFormat as NativeAudioStreamFormatType,
  NativeAudioStreamState as NativeAudioStreamStateType,
  NativeAudioStreamStats,
  NativeAudioCaptureStats,
  AudioStats,
  BuildOptions,
  AllocatorStats,
  NativeRenderStats,
  NativeImageInfo,
} from "./zig-structs.js"
export const NativeAudioStreamState = NativeAudioStreamStateValue
export type NativeAudioStreamState = NativeAudioStreamStateType
export const NativeAudioStreamCloseReason = NativeAudioStreamCloseReasonValue
export type NativeAudioStreamCloseReason = NativeAudioStreamCloseReasonType
export const NativeAudioStreamFormat = NativeAudioStreamFormatValue
export type NativeAudioStreamFormat = NativeAudioStreamFormatType
import { isBunfsPath } from "./lib/bunfs.js"
import { resolveNativeLibraryPath } from "#opentui/runtime-assets"
import { allocStruct } from "bun-ffi-structs"
import { nativeSymbols, nativeCallbacks, nativeLayouts, nativeConstants } from "./native-abi.generated.js"

registerEnvVar({
  name: "OPENTUI_LIBC",
  description: "Select Linux native libc package. Supported values: glibc, musl.",
  type: "string",
  default: "",
})

export type NativeHandle<T extends string> = Pointer & { readonly __nativeHandle: T }
declare const nativeContextBrand: unique symbol
export type NativeContextHandle = { readonly [nativeContextBrand]: true }

/** Native hyperlink URL slot bound. Longer URLs fail allocation. */
export const MAX_LINK_URL_BYTES = 512

export interface NativeContextOptions {
  objectCapacity: number
  renderCellsMax: number
}

export interface ContextObjectHandle {
  readonly context: NativeContextHandle
  contextId: bigint
  slot: number
  generation: number
}

export type SessionHandle = ContextObjectHandle
export type ContextBufferHandle = ContextObjectHandle
export type SceneNodeHandle = ContextObjectHandle
declare const contextResourceBrand: unique symbol
export type ContextEditBufferHandle = ContextObjectHandle & { readonly [contextResourceBrand]: "edit_buffer" }
export type ContextEditorViewHandle = ContextObjectHandle & { readonly [contextResourceBrand]: "editor_view" }
export type ContextSyntaxStyleHandle = ContextObjectHandle & { readonly [contextResourceBrand]: "syntax_style" }
export type ContextTextBufferHandle = ContextObjectHandle & { readonly [contextResourceBrand]: "text_buffer" }
export type ContextTextBufferViewHandle = ContextObjectHandle & { readonly [contextResourceBrand]: "text_buffer_view" }
export type ContextImageHandle = ContextObjectHandle & { readonly [contextResourceBrand]: "image" }
export type ContextUnicodeHandle = ContextObjectHandle & { readonly [contextResourceBrand]: "unicode" }
export type ContextEmbeddedTerminalHandle = ContextObjectHandle & {
  readonly [contextResourceBrand]: "embedded_terminal"
}
export type SessionBuffer = "current" | "next"

export interface NativeContextEditBufferOptions {
  widthMethod?: WidthMethod | "no-zwj"
}

export interface NativeEditBufferInfo {
  contentEpoch: bigint
  byteLength: number
  lineCount: number
  cursor: LogicalCursor
  canUndo: boolean
  canRedo: boolean
  tabWidth: number
}

export interface NativeTextBufferInfo {
  contentEpoch: bigint
  byteLength: number
  textLength: number
  lineCount: number
  highlightCount: number
  tabWidth: number
}

export interface NativeEncodedStyledText {
  bytes: Uint8Array
  records: Uint32Array
  count: number
  urlBytes: Uint8Array
}

export enum NativeTextViewCommand {
  WrapWidth = 0,
  WrapMode = 1,
  FirstLineOffset = 2,
  TabIndicator = 3,
  Truncate = 4,
}

export enum NativeEditCommand {
  DeleteForward = 0,
  Backspace = 1,
  NewLine = 2,
  DeleteLine = 3,
  MoveLeft = 4,
  MoveRight = 5,
  MoveUp = 6,
  MoveDown = 7,
  GotoLine = 8,
  CursorOffset = 9,
  Clear = 10,
  ClearHistory = 11,
  DebugRope = 12,
}

export enum NativeEditPositionQuery {
  Cursor = 0,
  NextWord = 1,
  PrevWord = 2,
  Eol = 3,
  Offset = 4,
  Coords = 5,
  LineStart = 6,
}

export enum NativeEditorStyleMask {
  Foreground = 1,
  Background = 2,
  Attributes = 4,
  All = 7,
}

export interface NativeEditorStyle {
  fg?: RGBA | null
  bg?: RGBA | null
  attributes?: number | null
}

export enum NativeEditHighlightOperation {
  AddLine = 0,
  AddRange = 1,
  RemoveRef = 2,
  ClearLine = 3,
  ClearAll = 4,
}

export interface NativeEditorViewport {
  x: number
  y: number
  width: number
  height: number
}

export enum NativeEditorCommand {
  MoveUp = 0,
  MoveDown = 1,
  GotoLineEnd = 2,
  DeleteSelection = 3,
  CursorOffset = 4,
  WrapMode = 5,
  TabIndicator = 6,
}

export enum NativeEditorSelectionOperation {
  Set = 0,
  Update = 1,
  Reset = 2,
  Local = 3,
  LocalUpdate = 4,
  LocalReset = 5,
  Cell = 6,
  Occupancy = 7,
  Inclusive = 8,
  Colors = 9,
}

export interface NativeEditorSelection {
  operation: NativeEditorSelectionOperation
  behavior?: number
  start?: number
  end?: number
  anchorX?: number
  anchorY?: number
  focusX?: number
  focusY?: number
  updateCursor?: boolean
  followCursor?: boolean
  fg?: RGBA | null
  bg?: RGBA | null
}

export interface NativeEditorViewInfo {
  virtualLineCount: number
  totalVirtualLineCount: number
  selection: { start: number; end: number } | null
  selectionOccupancy: SelectionOccupancy
}

export enum NativeEditorPositionQuery {
  Cursor = 0,
  NextWord = 1,
  PrevWord = 2,
  Eol = 3,
  VisualSol = 4,
  VisualEol = 5,
}

export enum NativeEditEvent {
  CursorChanged = 1,
  ContentChanged = 2,
  HistoryCursorChanged = 4,
}

export type NativeEditEventName = "cursor-changed" | "content-changed" | "cursorChanged"

export interface NativeSceneEditorOptions {
  showCursor: boolean
  style: "block" | "line" | "underline" | "default"
  blinking: boolean
  color: RGBA
  cursor?: MousePointerStyle
}

export interface NativeEditorReplacement {
  deleted: boolean
  inserted: boolean
}

export interface NativeSceneBoxDetails {
  title?: string
  bottomTitle?: string
  titleAlignment: "left" | "center" | "right"
  bottomTitleAlignment: "left" | "center" | "right"
  titleColor?: RGBA
  customBorderChars?: Uint32Array
}

export interface NativeScenePaint {
  zIndex: number
  opacity: number
  translateX: number
  translateY: number
  border: number
  shouldFill: boolean
  backgroundColor: RGBA
  borderColor: RGBA
  borderStyle: "single" | "double" | "rounded" | "heavy"
  focusable: boolean
  focusedBorderColor: RGBA
}

export const NATIVE_SCENE_MUTATIONS_MAX = nativeConstants.OT_SCENE_MUTATIONS_MAX

export interface NativeSceneLayout {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  screenX: number
  screenY: number
}

export interface NativeSceneFrameOptions {
  background: RGBA
  useMouse: boolean
  excludedHitNum: number
  maxLayoutRounds: number
  maxHostRequests: number
  preserveUnwritten?: boolean
}

export interface NativeSceneFrameRequest {
  session: SessionHandle
  root: SceneNodeHandle
  node: SceneNodeHandle
  frameId: bigint
  requestId: bigint
  layoutEpoch: bigint
  hookGeneration: bigint
  kind: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
  num: number
  width: number
  height: number
  paintLayout?: NativeSceneLayout
  publicLayout?: NativeSceneLayout
  /** Host observation revision; never part of native ticket authority. */
  geometryRevision?: number
}

export interface NativeSplitSnapshot {
  snapshot: ContextBufferHandle
  rowColumns: number
  startOnNewLine: boolean
  trailingNewline: boolean
}

export type NativeSessionSplitControl =
  | { kind: "reset"; seedRows: number; pinnedRenderOffset: number }
  | { kind: "sync"; pinnedRenderOffset: number }
  | { kind: "output-offset"; surfaceOffset: number }
  | { kind: "render-offset"; renderOffset: number }
  | {
      kind: "transition"
      mode: "viewport-scroll" | "clear-stale-rows"
      sourceTopLine: number
      sourceHeight: number
      targetTopLine: number
      targetHeight: number
      scrollLines?: number
    }
  | { kind: "clear-transition" }

export interface NativeSceneTextOptions {
  fg: RGBA
  bg: RGBA
  attributes: number
  wrapMode: "none" | "char" | "word"
  truncate: boolean
  scrollX: number
  scrollY: number
  firstLineOffset: number
  tabIndicator?: string | number
  tabIndicatorColor?: RGBA
}

export interface NativeBufferGrid {
  borderChars: Uint32Array
  borderFg: RGBA
  borderBg: RGBA
  columnOffsets: Int32Array
  rowOffsets: Int32Array
  drawInner: boolean
  drawOuter: boolean
}

export interface NativeBufferStack {
  operation:
    | "getOpacity"
    | "pushScissor"
    | "popScissor"
    | "clearScissors"
    | "pushOpacity"
    | "popOpacity"
    | "clearOpacity"
  x?: number
  y?: number
  width?: number
  height?: number
  opacity?: number
}

export interface NativeBufferDraw {
  operation: "clear" | "fill" | "text" | "cell" | "cellBlend" | "char" | "box" | "compose" | "respectAlpha"
  x?: number
  y?: number
  width?: number
  height?: number
  char?: number
  attributes?: number
  foreground?: RGBA
  background?: RGBA
  titleColor?: RGBA
  packedOptions?: number
  borderChars?: Uint32Array
  source?: ContextBufferHandle
  sourceX?: number
  sourceY?: number
  sourceWidth?: number
  sourceHeight?: number
  text?: string
  bottomTitle?: string
}

export interface NativeContextImageDraw {
  x?: number
  y?: number
  width: number
  height: number
  pixelWidth?: number
  pixelHeight?: number
  sourceX?: number
  sourceY?: number
  sourceWidth?: number
  sourceHeight?: number
  protocol?: ImageRenderProtocol
}

export interface NativeSceneTextSelectionOptions {
  operation: "reset" | "set" | "update"
  anchorX: number
  anchorY: number
  focusX: number
  focusY: number
  behavior: SelectionBehavior
  bg?: RGBA
  fg?: RGBA
}

export interface NativeSceneTextMetrics {
  byteLength: number
  textLength: number
  lineCount: number
  virtualLineCount: number
  widthColsMax: number
}

export interface NativeSceneSliderOptions {
  orientation: "horizontal" | "vertical"
  min: number
  max: number
  value: number
  viewPortSize: number
  foregroundColor: RGBA
  backgroundColor: RGBA
}

export interface NativeSceneArrowOptions {
  direction: "up" | "down" | "left" | "right"
  attributes: number
  foregroundColor: RGBA
  backgroundColor: RGBA
  text?: string
}

export interface NativeSessionBufferLease {
  handle: ContextObjectHandle
  width: number
  height: number
  generation: bigint
  char: Pointer
  fg: Pointer
  bg: Pointer
  attributes: Pointer
}

export type NativeContextBufferLease = NativeSessionBufferLease

export interface NativeContextBufferOptions {
  width: number
  height: number
  widthMethod?: WidthMethod | "no-zwj"
  respectAlpha?: boolean
}

export const NATIVE_BUFFER_TEXT_BYTES_MAX = nativeConstants.OT_BUFFER_TEXT_BYTES_MAX

export interface NativeSessionOptions {
  chunkSize: number
  spanCapacity: number
  maxBytes: bigint
  controlCapacity?: number
}

export interface NativeOutputTicket {
  session: SessionHandle
  requestId: bigint
  byteCount: number
}

export enum NativeSessionState {
  Open = 0,
  Closing = 1,
  Closed = 2,
  Failed = 3,
  Cancelled = 4,
}

export interface NativeSessionRendererOptions {
  width: number
  height: number
  /** Omitted selects native auto detection, which ignores host hints when remote. */
  remote?: boolean
  /** Initialization-only copied host hints: at most 256 entries and 65536 encoded bytes. */
  environment?: Readonly<Record<string, string>>
}

export enum NativeSessionRenderStatus {
  Presented = 0,
  Pending = 1,
  Skipped = 2,
  Failed = 3,
}

export interface NativeSessionRendererState {
  width: number
  height: number
  frameCount: bigint
  framePending: boolean
}

export interface NativeSessionKittyImageTransportStatus {
  requested: number
  effective: number
  fileState: number
  fallback: number
  pendingFiles: number
  pendingBytes: number
}

export const NATIVE_SESSION_CONTROL_PACKET_BYTES = nativeConstants.OT_SESSION_CONTROL_PACKET_BYTES

export interface NativeSessionTerminalOptions {
  useAlternateScreen?: boolean
  mouse?: boolean
  mouseMovement?: boolean
  kittyKeyboardFlags?: number
  clearOnClose?: boolean
}

export enum NativeSessionTerminalPhase {
  Uninitialized = 0,
  SettingUp = 1,
  Active = 2,
  Suspending = 3,
  Suspended = 4,
  Resuming = 5,
  Closing = 6,
  Restored = 7,
  Failed = 8,
  Cancelled = 9,
}

export enum NativeSessionPumpStatus {
  Idle = 0,
  Again = 1,
  OutputPending = 2,
  WaitUntil = 3,
  Closed = 4,
}

export interface NativeSessionPumpResult {
  status: NativeSessionPumpStatus
  deadlineNs: bigint | null
}

export type NativeSessionControl =
  | { kind: "capability-response"; bytes: Uint8Array }
  | { kind: "palette-query"; bytes: Uint8Array }
  | { kind: "title"; title: string }
  | { kind: "mouse"; mode: "disabled" | "drag" | "motion" }
  | { kind: "kitty-keyboard-flags"; flags: number }
  | { kind: "restore-modes" | "query-pixel-resolution" | "query-theme-colors" | "reset-background" }

export interface NativeSessionCursorOptions extends CursorStyleOptions {
  position?: { x: number; y: number; visible: boolean }
}

export interface NativeSessionCapabilities extends TerminalCapabilities {
  kittyKeyboardFlags: number
}

export enum NativeStatus {
  Ok = 0,
  InvalidArgument = -1,
  UnsupportedVersion = -2,
  OutOfMemory = -3,
  WrongThread = -4,
  InternalError = -5,
  ContextBusy = -6,
  WrongContext = -7,
  WrongKind = -8,
  StaleHandle = -9,
  WrongSession = -10,
  OutputBackpressure = -11,
  SessionClosed = -12,
  OutputBusy = -13,
  StaleOutput = -14,
  OutputFailed = -15,
  ObjectLimit = -16,
  RendererAttached = -17,
  RendererNotAttached = -18,
  InvalidPhase = -19,
  ControlPacketLimit = -20,
  LeaseLimit = -21,
  LeaseBytesLimit = -22,
  StaleLease = -23,
  UnsupportedResource = -24,
  StaleFrame = -25,
  LayoutLimit = -26,
  FrameBusy = -27,
  FrameRequestLimit = -28,
}

export class NativeError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: NativeStatus,
  ) {
    super(`${operation} failed: ${NativeStatus[status] ?? `status ${status}`}`)
    this.name = "NativeError"
  }
}
export type AudioEngineHandle = NativeHandle<"audio_engine">
export type ImageHandle = NativeHandle<"image">
export type ClipboardServiceHandle = number & { readonly __nativeHandle: "clipboard_service" }
export type ClipboardOperationHandle = number & { readonly __nativeHandle: "clipboard_operation" }

export enum NativeClipboardOperationStatus {
  Pending = 0,
  Read = 1,
  Empty = 2,
  Written = 3,
  Cleared = 4,
  Unsupported = 5,
  Cancelled = 6,
  TimedOut = 7,
  LimitExceeded = 8,
  Failed = 9,
  InvalidHandle = 10,
}

export enum NativeClipboardStartStatus {
  Ok = 0,
  InvalidService = 1,
  ShuttingDown = 2,
  LimitExceeded = 3,
  InvalidArgument = 4,
  OutOfMemory = 5,
}

export enum NativeClipboardCancelStatus {
  Requested = 0,
  AlreadyTerminal = 1,
  InvalidHandle = 2,
}

export enum NativeClipboardCopyStatus {
  Ok = 0,
  BufferTooSmall = 1,
  InvalidHandle = 2,
  InvalidState = 3,
  InvalidArgument = 4,
}

export enum NativeClipboardDestroyStatus {
  Destroyed = 0,
  NotReady = 1,
  InvalidHandle = 2,
}

export enum NativeClipboardShutdownStatus {
  Pending = 0,
  Ready = 1,
  InvalidHandle = 2,
}

export type EmbeddedTerminalCursor = {
  x: number
  y: number
  hasValue: boolean
  visible: boolean
  blinking: boolean
  wideTail: boolean
  style: "bar" | "block" | "underline" | "block-hollow"
  color?: { r: number; g: number; b: number }
}

export type EmbeddedTerminalKey = {
  action?: "release" | "press" | "repeat"
  key?: string
  mods?: number
  consumedMods?: number
  composing?: boolean
  text?: string
  unshiftedCodepoint?: number
}

export type EmbeddedTerminalMouse = {
  action: "press" | "release" | "motion"
  button?: "unknown" | "left" | "right" | "middle" | "four" | "five" | "six" | "seven"
  mods?: number
  x: number
  y: number
  anyButtonPressed?: boolean
}
let targetLibPath: string | undefined
let targetLibError: Error | undefined

try {
  targetLibPath = await resolveNativeLibraryPath()
  if (isBunfsPath(targetLibPath)) {
    targetLibPath = targetLibPath.replace("../", "")
  }
  if (!existsSync(targetLibPath)) {
    throw new Error(`OpenTUI native library does not exist at ${JSON.stringify(targetLibPath)}`)
  }
} catch (error) {
  targetLibError = error instanceof Error ? error : new Error(String(error))
}

registerEnvVar({
  name: "OTUI_DEBUG_FFI",
  description: "Enable debug logging for the FFI bindings.",
  type: "boolean",
  default: false,
})

registerEnvVar({
  name: "OTUI_TRACE_FFI",
  description: "Enable tracing for the FFI bindings.",
  type: "boolean",
  default: false,
})

// Env vars used in terminal.zig
registerEnvVar({
  name: "OPENTUI_FORCE_WCWIDTH",
  description: "Use wcwidth for character width calculations when the variable is present",
  type: "string",
  required: false,
})
registerEnvVar({
  name: "OPENTUI_FORCE_UNICODE",
  description: "Force Mode 2026 Unicode support when the variable is present",
  type: "string",
  required: false,
})
registerEnvVar({
  name: "OPENTUI_GRAPHICS",
  description: "Control Kitty and Sixel graphics detection with the exact value true, 1, false, or 0",
  type: "string",
  required: false,
})
registerEnvVar({
  name: "OPENTUI_IMAGE_PROTOCOL",
  description: "Override image rendering protocol: auto, kitty, sixel, or blocks",
  type: "string",
  default: "auto",
})
registerEnvVar({
  name: "OPENTUI_FORCE_NOZWJ",
  description: "Use no_zwj width mode when the variable is present",
  type: "string",
  required: false,
})

// Cursor & mouse pointer style mappings (avoid recreation on each call)
const CURSOR_STYLE_TO_ID = { block: 0, line: 1, underline: 2, default: 3 } as const
const CURSOR_ID_TO_STYLE = ["block", "line", "underline", "default"] as const
const MOUSE_STYLE_TO_ID = { default: 0, pointer: 1, text: 2, crosshair: 3, move: 4, "not-allowed": 5 } as const
const SCENE_BORDER_STYLES = ["single", "double", "rounded", "heavy"] as const
const SCENE_TEXT_WRAP_MODES = ["none", "char", "word"] as const
const SCENE_NODE_KINDS = ["root", "box", "text", "slider", "arrow", "editor", "custom", "text_view", "image"] as const
const IMAGE_PROTOCOL_TO_ID = { auto: 0, kitty: 1, sixel: 2, blocks: 3 } as const
const IMAGE_FITS = ["fit", "cover", "fill"] as const
const BUFFER_DRAW_OPERATIONS = [
  "clear",
  "fill",
  "text",
  "cell",
  "cellBlend",
  "char",
  "box",
  "compose",
  "respectAlpha",
] as const
const BUFFER_STACK_OPERATIONS = [
  "getOpacity",
  "pushScissor",
  "popScissor",
  "clearScissors",
  "pushOpacity",
  "popOpacity",
  "clearOpacity",
] as const
const SCENE_ARROW_DIRECTIONS = ["up", "down", "left", "right"] as const
const MAX_FFI_U32 = 0xffff_ffff
// Global singleton state for FFI tracing to prevent duplicate exit handlers
let globalTraceSymbols: Record<string, number[]> | null = null
let globalFFILogPath: string | null = null
let exitHandlerRegistered = false

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value
}

function toSafeByteCount(value: number | bigint, label: string): number {
  if (typeof value !== "bigint") {
    return value
  }

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds JavaScript safe integer range`)
  }

  return Number(value)
}

function toSafeFFIU32Length(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FFI_U32) {
    throw new RangeError(`${label} exceeds native u32 length limit`)
  }

  return value
}

function isFFIU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_FFI_U32
}

function toFFIU64(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} must be an unsigned 64-bit bigint`)
  }
  return value
}

function toFFIBool(value: boolean, label: string): 0 | 1 {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`)
  return ffiBool(value)
}

function toFFIF32(value: number, label: string, allowNaN = false): number {
  if (allowNaN && Number.isNaN(value)) return value
  if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) {
    throw new RangeError(`${label} must be a finite 32-bit float${allowNaN ? " or NaN" : ""}`)
  }
  return value
}

function nativeResult(operation: string, status: NativeStatus): void {
  if (status !== NativeStatus.Ok) throw new NativeError(operation, status)
}

function createContextRecord(layout: {
  size: number
  fields: Record<"struct_size" | "abi_version", { offset: number }>
}): Uint32Array {
  const record = new Uint32Array(layout.size / 4)
  record[layout.fields.struct_size.offset / 4] = layout.size
  record[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
  return record
}

const typedArrayAccessors = Object.getOwnPropertyDescriptors(Object.getPrototypeOf(Uint8Array.prototype))

function sessionBytes(bytes: Uint8Array, label: string): Uint8Array {
  const length = toSafeFFIU32Length(bytes.byteLength, label)
  if (typedArrayAccessors.byteLength.get!.call(bytes) !== length) {
    throw new RangeError(`${label} does not match the supplied typed-array view`)
  }
  // The FFI adapter must not invoke caller metadata getters after the context lookup.
  return new Uint8Array(
    typedArrayAccessors.buffer.get!.call(bytes),
    typedArrayAccessors.byteOffset.get!.call(bytes),
    length,
  )
}

function pixelInput(data: Uint8Array | PointerInput, length: number): Uint8Array | Pointer {
  if (typeof data === "number" || typeof data === "bigint") return toPointer(data)
  const input = sessionBytes(data, "Pixel buffer byte length")
  if (length > input.byteLength) throw new RangeError("Pixel byte count exceeds the supplied view")
  return input
}

// Typed arrays preserve native byte order; layout metadata comes from the C header.
function encodeContextHandle(
  context: NativeContextHandle,
  handle: ContextObjectHandle,
  record: BigUint64Array = new BigUint64Array(nativeLayouts.ot_handle.size / 8),
  words: Uint32Array = new Uint32Array(record.buffer, record.byteOffset, nativeLayouts.ot_handle.size / 4),
): BigUint64Array {
  const layout = nativeLayouts.ot_handle
  // Independent native images can issue the same numeric IDs.
  if (handle.context !== context) throw new NativeError("Context handle", NativeStatus.WrongContext)
  record[layout.fields.context_id.offset / 8] = toFFIU64(handle.contextId, "Handle contextId")
  words[layout.fields.slot.offset / 4] = toSafeFFIU32Length(handle.slot, "Handle slot")
  words[layout.fields.generation.offset / 4] = toSafeFFIU32Length(handle.generation, "Handle generation")
  return record
}

function createContextHandleRecord(record = new BigUint64Array(nativeLayouts.ot_handle.size / 8)) {
  return { record, words: new Uint32Array(record.buffer, record.byteOffset, nativeLayouts.ot_handle.size / 4) }
}

function createSceneNodeRecord() {
  return { handle: createContextHandleRecord(), target: createContextHandleRecord() }
}

function createSceneHooksRecord() {
  const record = new BigUint64Array(nativeLayouts.ot_scene_hooks.size / 8)
  return {
    record,
    words: new Uint32Array(record.buffer),
    dimensions: new Float64Array(record.buffer),
    handle: createContextHandleRecord(),
  }
}

function decodeContextHandle(
  context: NativeContextHandle,
  record: BigUint64Array,
  words: Uint32Array = new Uint32Array(record.buffer, record.byteOffset, nativeLayouts.ot_handle.size / 4),
): ContextObjectHandle {
  const layout = nativeLayouts.ot_handle
  return {
    context,
    contextId: record[layout.fields.context_id.offset / 8],
    slot: words[layout.fields.slot.offset / 4],
    generation: words[layout.fields.generation.offset / 4],
  }
}

function createSceneFrameRecord() {
  const layout = nativeLayouts.ot_scene_frame_request
  const output = new BigUint64Array(layout.size / 8)
  const config = createContextRecord(nativeLayouts.ot_scene_frame_options)
  const geometry = createContextRecord(nativeLayouts.ot_scene_frame_geometry)
  return {
    output,
    words: new Uint32Array(output.buffer),
    config,
    colors: new Uint16Array(config.buffer),
    geometry,
    geometryValues: new Float32Array(geometry.buffer),
    geometryCoordinates: new Float64Array(geometry.buffer),
    handle: createContextHandleRecord(),
    session: createContextHandleRecord(
      new BigUint64Array(output.buffer, layout.fields.session.offset, nativeLayouts.ot_handle.size / 8),
    ),
    root: createContextHandleRecord(
      new BigUint64Array(output.buffer, layout.fields.root.offset, nativeLayouts.ot_handle.size / 8),
    ),
    node: createContextHandleRecord(
      new BigUint64Array(output.buffer, layout.fields.node.offset, nativeLayouts.ot_handle.size / 8),
    ),
  }
}

function createBufferDrawRecord() {
  const record = createContextRecord(nativeLayouts.ot_buffer_draw_options)
  return {
    record,
    signed: new Int32Array(record.buffer),
    colors: new Uint16Array(record.buffer),
    handle: createContextHandleRecord(),
    source: createContextHandleRecord(),
    frame: createSceneFrameRecord(),
  }
}

function createSceneLayoutRecord() {
  const output = createContextRecord(nativeLayouts.ot_scene_layout)
  return {
    output,
    values: new Float32Array(output.buffer),
    coordinates: new Float64Array(output.buffer),
    handle: createContextHandleRecord(),
  }
}

function decodeSceneLayout(values: Float32Array, coordinates: Float64Array, offset = 0): NativeSceneLayout {
  const fields = nativeLayouts.ot_scene_layout.fields
  return {
    left: values[(offset + fields.left.offset) / 4],
    top: values[(offset + fields.top.offset) / 4],
    right: values[(offset + fields.right.offset) / 4],
    bottom: values[(offset + fields.bottom.offset) / 4],
    width: values[(offset + fields.width.offset) / 4],
    height: values[(offset + fields.height.offset) / 4],
    screenX: coordinates[(offset + fields.screen_x.offset) / 8],
    screenY: coordinates[(offset + fields.screen_y.offset) / 8],
  }
}

function encodeSceneFrameRequest(
  context: NativeContextHandle,
  frame: NativeSceneFrameRequest | null,
  scratch?: ReturnType<typeof createSceneFrameRecord>,
): BigUint64Array {
  const layout = nativeLayouts.ot_scene_frame_request
  const record = scratch?.output ?? new BigUint64Array(layout.size / 8)
  const words = scratch?.words ?? new Uint32Array(record.buffer)
  record.fill(0n)
  words[layout.fields.struct_size.offset / 4] = layout.size
  words[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
  if (frame !== null) {
    encodeContextHandle(
      context,
      frame.session,
      scratch?.session.record ??
        new BigUint64Array(record.buffer, layout.fields.session.offset, nativeLayouts.ot_handle.size / 8),
      scratch?.session.words,
    )
    encodeContextHandle(
      context,
      frame.root,
      scratch?.root.record ??
        new BigUint64Array(record.buffer, layout.fields.root.offset, nativeLayouts.ot_handle.size / 8),
      scratch?.root.words,
    )
    encodeContextHandle(
      context,
      frame.node,
      scratch?.node.record ??
        new BigUint64Array(record.buffer, layout.fields.node.offset, nativeLayouts.ot_handle.size / 8),
      scratch?.node.words,
    )
    record[layout.fields.frame_id.offset / 8] = toFFIU64(frame.frameId, "Scene frame ID")
    record[layout.fields.request_id.offset / 8] = toFFIU64(frame.requestId, "Scene request ID")
    record[layout.fields.layout_epoch.offset / 8] = toFFIU64(frame.layoutEpoch, "Scene layout epoch")
    record[layout.fields.hook_generation.offset / 8] = toFFIU64(frame.hookGeneration, "Scene hook generation")
    words[layout.fields.kind.offset / 4] = toSafeFFIU32Length(frame.kind, "Scene request kind")
    words[layout.fields.num.offset / 4] = toSafeFFIU32Length(frame.num, "Scene node number")
    words[layout.fields.width.offset / 4] = toSafeFFIU32Length(frame.width, "Scene request width")
    words[layout.fields.height.offset / 4] = toSafeFFIU32Length(frame.height, "Scene request height")
  }
  return record
}

function viewOrNull<T extends ArrayBufferView>(value: T): T | null {
  return value.byteLength === 0 ? null : value
}

function embeddedTerminalDimension(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff) {
    throw new RangeError(`Embedded terminal ${name} must be an integer between 1 and 65535`)
  }
  return value
}

function embeddedTerminalI32(value: number, name: string) {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new RangeError(`Embedded terminal ${name} must be a signed 32-bit integer`)
  }
  return value
}

function rgbaBuffer(value: RGBA): Uint16Array {
  return value.buffer
}

function contextBufferColor(value: RGBA, color: Uint16Array = new Uint16Array(4), offset = 0): Uint16Array {
  const source = rgbaBuffer(value)
  for (let index = 0; index < 4; index++) {
    const channel = source[index]
    if (!Number.isInteger(channel) || channel < 0 || channel > 0xffff) {
      throw new RangeError("Context buffer colors require four integer RGBA channels in 0..65535")
    }
    color[offset + index] = channel
  }
  const intent = color[offset + 1] >>> 8
  if (color[offset + 2] > 255 || color[offset + 3] > 255 || intent > 2 || (intent !== 1 && color[offset] > 255)) {
    throw new RangeError("Invalid terminal color intent")
  }
  return color
}

function createScenePaintRecord() {
  const record = createContextRecord(nativeLayouts.ot_scene_paint_options)
  return {
    record,
    handle: createContextHandleRecord(),
    background: new Uint16Array(record.buffer, nativeLayouts.ot_scene_paint_options.fields.background.offset, 4),
    floats: new Float32Array(record.buffer),
    doubles: new Float64Array(record.buffer),
    colors: new Uint16Array(record.buffer),
  }
}

function encodeScenePaint(paint: NativeScenePaint, scratch: ReturnType<typeof createScenePaintRecord>): void {
  const layout = nativeLayouts.ot_scene_paint_options
  const { record, floats, doubles, colors } = scratch
  const zIndex = paint.zIndex
  if (!Number.isInteger(zIndex) || zIndex < -0x8000_0000 || zIndex > 0x7fff_ffff) {
    throw new RangeError("Scene zIndex must be a signed 32-bit integer")
  }
  record[layout.fields.struct_size.offset / 4] = layout.size
  record[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
  record[layout.fields.z_index.offset / 4] = zIndex
  // Mirror scene.zig setPaint's range rules so staged paint cannot fail only at flush time.
  const opacity = toFFIF32(paint.opacity, "Scene opacity")
  if (opacity < 0 || opacity > 1) throw new RangeError("Scene opacity must be within 0..1")
  floats[layout.fields.opacity.offset / 4] = opacity
  const translateX = paint.translateX
  const translateY = paint.translateY
  if (!Number.isFinite(translateX) || !Number.isFinite(translateY)) {
    throw new RangeError("Scene translations must be finite numbers")
  }
  doubles[layout.fields.translate_x.offset / 8] = translateX
  doubles[layout.fields.translate_y.offset / 8] = translateY
  const borderSides = toSafeFFIU32Length(paint.border, "Scene border")
  if (borderSides > 15) throw new RangeError("Scene border sides must use four edge bits")
  record[layout.fields.border_sides.offset / 4] = borderSides
  record[layout.fields.should_fill.offset / 4] = toFFIBool(paint.shouldFill, "Scene shouldFill")
  contextBufferColor(paint.backgroundColor, colors, layout.fields.background.offset / 2)
  contextBufferColor(paint.borderColor, colors, layout.fields.border_color.offset / 2)
  const borderStyle = SCENE_BORDER_STYLES.indexOf(paint.borderStyle)
  if (borderStyle < 0) throw new TypeError("Unknown scene border style")
  record[layout.fields.border_style.offset / 4] = borderStyle
  record[layout.fields.focusable.offset / 4] = toFFIBool(paint.focusable, "Scene focusable")
  contextBufferColor(paint.focusedBorderColor, colors, layout.fields.focused_border_color.offset / 2)
}

// Match checked Yoga's kind/enum/unit rules before deferring native admission.
const sceneStyleEnumMaxima = [2, 3, 5, 8, 8, 8, 2, 2, 2, 1, 1] as const

function validateSceneStyle(group: number, kind: number, edge: number, unit: number, value: number, flags: number) {
  if (group > 4 || group === 3 || (group !== 4 && flags !== 0) || flags > 1) {
    throw new NativeError("ot_scene_set_style", NativeStatus.InvalidArgument)
  }
  if ((group === 0 || group === 1) && (edge !== 0 || unit !== 0)) {
    throw new NativeError("ot_scene_set_style", NativeStatus.InvalidArgument)
  }
  if (group === 4 && edge !== 0) throw new NativeError("ot_scene_set_style", NativeStatus.InvalidArgument)
  let valid = false
  switch (group) {
    case 0:
      valid = kind < sceneStyleEnumMaxima.length && value <= sceneStyleEnumMaxima[kind]
      break
    case 1:
      valid = kind <= 3
      break
    case 2:
      valid =
        kind <= 10 &&
        unit <= 3 &&
        (kind < 7 || edge <= (kind === 10 ? 2 : 8)) &&
        !(unit === 3 && ((kind >= 2 && kind <= 5) || kind === 8 || kind === 10))
      break
    case 4:
      valid = kind <= 1 && unit <= 3
      break
  }
  if (!valid) throw new NativeError("ot_scene_set_style", NativeStatus.InvalidArgument)
}

type StagedStream = {
  words: Uint32Array
  floats: Float32Array
  colors: Uint16Array
  count: number
}

function createStagedStream(entryBytes: number, capacity: number): StagedStream {
  const buffer = new ArrayBuffer(entryBytes * capacity)
  return {
    words: new Uint32Array(buffer),
    floats: new Float32Array(buffer),
    colors: new Uint16Array(buffer),
    count: 0,
  }
}

function growStagedStream(stream: StagedStream, entryBytes: number, limit: number): void {
  const capacity = stream.words.byteLength / entryBytes
  if (stream.count < capacity) return
  if (capacity >= limit) throw new NativeError("ot_scene_flush", NativeStatus.ObjectLimit)
  const next = createStagedStream(entryBytes, Math.min(limit, capacity * 2))
  next.words.set(stream.words)
  stream.words = next.words
  stream.floats = next.floats
  stream.colors = next.colors
}

/** Staged scene style and paint writes, encoded directly into flush-ready wire
 * records for one scene. Native applies styles, then backgrounds, then paints.
 * Style entries are append-only: Yoga applies the last write for a key. A node
 * keeps at most one live background or paint entry per flush; a later full paint
 * marks an earlier background skipped, and a later background patches a staged
 * paint in place. Inputs are validated and read into scratch before any stream
 * changes, so caller getters that reenter cannot leave a half-written entry.
 * Streams double up to OT_SCENE_MUTATIONS_MAX; the owner flushes before a stream
 * would exceed it. */
export class SceneStaging {
  static readonly limit = nativeConstants.OT_SCENE_MUTATIONS_MAX
  private static readonly styleBytes = nativeLayouts.ot_scene_style_update.size
  private static readonly backgroundBytes = nativeLayouts.ot_scene_background_update.size
  private static readonly paintBytes = nativeLayouts.ot_scene_paint_update.size

  private readonly styles: StagedStream
  private readonly backgrounds: StagedStream
  private readonly paints: StagedStream
  private readonly backgroundBySlot = new Map<number, number>()
  private readonly paintBySlot = new Map<number, number>()
  private context?: NativeContextHandle
  private readonly contextId = new BigUint64Array(1)
  private readonly contextWords = new Uint32Array(this.contextId.buffer)
  private borrowed = false
  private handleScratch: ReturnType<typeof createContextHandleRecord> | undefined = createContextHandleRecord()
  private paintScratch: ReturnType<typeof createScenePaintRecord> | undefined = createScenePaintRecord()

  constructor(initialCapacity = 64) {
    if (!Number.isInteger(initialCapacity) || initialCapacity < 1 || initialCapacity > SceneStaging.limit) {
      throw new RangeError("Scene staging capacity must be within the native mutation limit")
    }
    this.styles = createStagedStream(SceneStaging.styleBytes, initialCapacity)
    this.backgrounds = createStagedStream(SceneStaging.backgroundBytes, initialCapacity)
    this.paints = createStagedStream(SceneStaging.paintBytes, initialCapacity)
  }

  get pending(): boolean {
    return this.styles.count !== 0 || this.backgrounds.count !== 0 || this.paints.count !== 0
  }

  get styleCount(): number {
    return this.styles.count
  }

  get backgroundCount(): number {
    return this.backgrounds.count
  }

  get paintCount(): number {
    return this.paints.count
  }

  /** @internal Borrowed until consume() acknowledges the accepted prefix. */
  _views(context: NativeContextHandle): {
    styles: Uint32Array | null
    backgrounds: Uint32Array | null
    paints: Uint32Array | null
  } {
    this.assertWritable()
    if (this.context !== context) throw new NativeError("ot_scene_flush", NativeStatus.WrongContext)
    this.borrowed = true
    return {
      styles: this.styles.count === 0 ? null : this.styles.words,
      backgrounds: this.backgrounds.count === 0 ? null : this.backgrounds.words,
      paints: this.paints.count === 0 ? null : this.paints.words,
    }
  }

  /** Whether one more entry of this kind would exceed the flush limit. */
  get styleFull(): boolean {
    return this.styles.count >= SceneStaging.limit
  }

  get backgroundFull(): boolean {
    return this.backgrounds.count >= SceneStaging.limit
  }

  get paintFull(): boolean {
    return this.paints.count >= SceneStaging.limit
  }

  /** Validates one style value the way `stageStyle` will, so callers staging several
   * dependent entries can check them all before the first is written. */
  static checkStyleValue(group: number, value: number): number {
    return group === 0 ? toSafeFFIU32Length(value, "Scene enum value") : toFFIF32(value, "Scene style value", true)
  }

  private assertWritable(): void {
    if (this.borrowed) throw new Error("Cannot change staged scene inputs during a native flush")
  }

  private checkHandle(context: NativeContextHandle, handle: ReturnType<typeof createContextHandleRecord>): void {
    this.assertWritable()
    const layout = nativeLayouts.ot_handle
    const offset = layout.fields.context_id.offset / 4
    if (
      this.context !== undefined &&
      (this.context !== context ||
        this.contextWords[0] !== handle.words[offset] ||
        this.contextWords[1] !== handle.words[offset + 1])
    ) {
      throw new NativeError("Context handle", NativeStatus.WrongContext)
    }
  }

  private checkGeneration(stream: StagedStream, index: number | undefined, stride: number, generation: number): void {
    if (
      index !== undefined &&
      stream.words[(index * stride + nativeLayouts.ot_handle.fields.generation.offset) / 4] !== generation
    ) {
      throw new NativeError("Context handle", NativeStatus.StaleHandle)
    }
  }

  /** True only for the first write after a flush, including a flush caused by a payload getter. */
  private bind(context: NativeContextHandle, handle: ReturnType<typeof createContextHandleRecord>): boolean {
    if (this.context !== undefined) return false
    this.context = context
    const offset = nativeLayouts.ot_handle.fields.context_id.offset / 4
    this.contextWords[0] = handle.words[offset]
    this.contextWords[1] = handle.words[offset + 1]
    return true
  }

  stageStyle(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    group: number,
    kind: number,
    edge: number,
    unit: number,
    value: number,
    flags: number,
  ): boolean {
    this.assertWritable()
    const styleGroup = toSafeFFIU32Length(group, "Scene style group")
    const styleKind = toSafeFFIU32Length(kind, "Scene style kind")
    const styleEdge = toSafeFFIU32Length(edge, "Scene style edge")
    const styleUnit = toSafeFFIU32Length(unit, "Scene style unit")
    const styleValue = SceneStaging.checkStyleValue(styleGroup, value)
    const styleFlags = toSafeFFIU32Length(flags, "Scene style flags")
    validateSceneStyle(styleGroup, styleKind, styleEdge, styleUnit, styleValue, styleFlags)
    const layout = nativeLayouts.ot_scene_style_update
    // Construction writes many styles to the same node; reuse the previous handle encoding.
    if (this.styles.count !== 0 && this.context === context && node.context === context) {
      const prevHandle = ((this.styles.count - 1) * layout.size + layout.fields.node.offset) / 4
      const previous = this.styles.words
      const slotField = nativeLayouts.ot_handle.fields.slot.offset / 4
      const generationField = nativeLayouts.ot_handle.fields.generation.offset / 4
      if (
        previous[prevHandle + slotField] === node.slot &&
        previous[prevHandle + generationField] === node.generation
      ) {
        this.checkGeneration(
          this.backgrounds,
          this.backgroundBySlot.get(node.slot),
          SceneStaging.backgroundBytes,
          node.generation,
        )
        this.checkGeneration(this.paints, this.paintBySlot.get(node.slot), SceneStaging.paintBytes, node.generation)
        growStagedStream(this.styles, SceneStaging.styleBytes, SceneStaging.limit)
        const words = this.styles.words
        const base = this.styles.count * layout.size
        const dest = (base + layout.fields.node.offset) / 4
        words.copyWithin(dest, prevHandle, prevHandle + nativeLayouts.ot_handle.size / 4)
        words[(base + layout.fields.group.offset) / 4] = styleGroup
        words[(base + layout.fields.kind.offset) / 4] = styleKind
        words[(base + layout.fields.edge.offset) / 4] = styleEdge
        words[(base + layout.fields.unit.offset) / 4] = styleUnit
        this.styles.floats[(base + layout.fields.value.offset) / 4] = styleValue
        words[(base + layout.fields.flags.offset) / 4] = styleFlags
        this.styles.count++
        return false
      }
    }
    const scratch = this.handleScratch ?? createContextHandleRecord()
    this.handleScratch = undefined
    try {
      encodeContextHandle(context, node, scratch.record, scratch.words)
      this.checkHandle(context, scratch)
      const slot = scratch.words[nativeLayouts.ot_handle.fields.slot.offset / 4]
      const generation = scratch.words[nativeLayouts.ot_handle.fields.generation.offset / 4]
      this.checkGeneration(this.backgrounds, this.backgroundBySlot.get(slot), SceneStaging.backgroundBytes, generation)
      this.checkGeneration(this.paints, this.paintBySlot.get(slot), SceneStaging.paintBytes, generation)
      growStagedStream(this.styles, SceneStaging.styleBytes, SceneStaging.limit)
      const base = this.styles.count * layout.size
      const words = this.styles.words
      words.set(scratch.words, (base + layout.fields.node.offset) / 4)
      words[(base + layout.fields.group.offset) / 4] = styleGroup
      words[(base + layout.fields.kind.offset) / 4] = styleKind
      words[(base + layout.fields.edge.offset) / 4] = styleEdge
      words[(base + layout.fields.unit.offset) / 4] = styleUnit
      this.styles.floats[(base + layout.fields.value.offset) / 4] = styleValue
      words[(base + layout.fields.flags.offset) / 4] = styleFlags
      this.styles.count++
      return this.bind(context, scratch)
    } finally {
      this.handleScratch ??= scratch
    }
  }

  stageBackground(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    color: RGBA,
    owner?: { assertMutable(): void },
  ): boolean {
    this.assertWritable()
    const scratch = this.paintScratch ?? createScenePaintRecord()
    this.paintScratch = undefined
    try {
      encodeContextHandle(context, node, scratch.handle.record, scratch.handle.words)
      contextBufferColor(color, scratch.background)
      owner?.assertMutable()
      this.checkHandle(context, scratch.handle)
      const slot = scratch.handle.words[nativeLayouts.ot_handle.fields.slot.offset / 4]
      const generation = scratch.handle.words[nativeLayouts.ot_handle.fields.generation.offset / 4]
      const paintEntry = this.paintBySlot.get(slot)
      if (paintEntry !== undefined) {
        this.checkGeneration(this.paints, paintEntry, SceneStaging.paintBytes, generation)
        const paintLayout = nativeLayouts.ot_scene_paint_update
        const offset =
          (paintEntry * paintLayout.size +
            paintLayout.fields.paint.offset +
            nativeLayouts.ot_scene_paint_options.fields.background.offset) /
          2
        const colors = this.paints.colors
        colors.set(scratch.background, offset)
        return false
      }
      const layout = nativeLayouts.ot_scene_background_update
      let entry = this.backgroundBySlot.get(slot)
      this.checkGeneration(this.backgrounds, entry, SceneStaging.backgroundBytes, generation)
      if (entry === undefined) {
        growStagedStream(this.backgrounds, SceneStaging.backgroundBytes, SceneStaging.limit)
        entry = this.backgrounds.count
        const base = entry * layout.size
        this.backgrounds.words.set(scratch.handle.words, (base + layout.fields.node.offset) / 4)
        this.backgrounds.words[(base + layout.fields.fields.offset) / 4] = nativeConstants.OT_SCENE_UPDATE_APPLY
        this.backgrounds.words[(base + layout.fields.reserved.offset) / 4] = 0
        // Reserve only after every fallible write succeeded.
        this.backgrounds.count++
        this.backgroundBySlot.set(slot, entry)
      }
      const offset = (entry * layout.size + layout.fields.background.offset) / 2
      const colors = this.backgrounds.colors
      colors.set(scratch.background, offset)
      return this.bind(context, scratch.handle)
    } finally {
      this.paintScratch ??= scratch
    }
  }

  stagePaint(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    paint: NativeScenePaint,
    owner?: { assertMutable(): void },
  ): boolean {
    this.assertWritable()
    // Caller getters may reenter; only idle scratch storage can be reused.
    const scratch = this.paintScratch ?? createScenePaintRecord()
    this.paintScratch = undefined
    try {
      encodeContextHandle(context, node, scratch.handle.record, scratch.handle.words)
      encodeScenePaint(paint, scratch)
      owner?.assertMutable()
      this.checkHandle(context, scratch.handle)
      const slot = scratch.handle.words[nativeLayouts.ot_handle.fields.slot.offset / 4]
      const generation = scratch.handle.words[nativeLayouts.ot_handle.fields.generation.offset / 4]
      const layout = nativeLayouts.ot_scene_paint_update
      let entry = this.paintBySlot.get(slot)
      const background = this.backgroundBySlot.get(slot)
      this.checkGeneration(this.paints, entry, SceneStaging.paintBytes, generation)
      this.checkGeneration(this.backgrounds, background, SceneStaging.backgroundBytes, generation)
      if (entry === undefined) {
        growStagedStream(this.paints, SceneStaging.paintBytes, SceneStaging.limit)
        entry = this.paints.count
        this.paints.words.set(scratch.handle.words, (entry * layout.size + layout.fields.node.offset) / 4)
        // Reserve only after every fallible write succeeded.
        this.paints.count++
        this.paintBySlot.set(slot, entry)
      }
      this.paints.words.set(scratch.record, (entry * layout.size + layout.fields.paint.offset) / 4)
      if (background !== undefined) {
        // The full paint carries the current background; the earlier entry is superseded.
        const backgroundLayout = nativeLayouts.ot_scene_background_update
        this.backgrounds.words[(background * backgroundLayout.size + backgroundLayout.fields.fields.offset) / 4] =
          nativeConstants.OT_SCENE_UPDATE_SKIP
        this.backgroundBySlot.delete(slot)
      }
      return this.bind(context, scratch.handle)
    } finally {
      this.paintScratch ??= scratch
    }
  }

  clear(): void {
    this.assertWritable()
    this.styles.count = 0
    this.backgrounds.count = 0
    this.paints.count = 0
    this.backgroundBySlot.clear()
    this.paintBySlot.clear()
    this.context = undefined
  }

  /** Retain rejected work for retry; never replay the prefix native already accepted. */
  consume(applied: number): void {
    this.borrowed = false
    const total = this.styles.count + this.backgrounds.count + this.paints.count
    if (!Number.isInteger(applied) || applied < 0 || applied > total) throw new Error("Invalid scene flush prefix")
    if (applied === total) return this.clear()
    if (applied === 0) return
    for (const [stream, stride] of [
      [this.styles, SceneStaging.styleBytes / 4],
      [this.backgrounds, SceneStaging.backgroundBytes / 4],
      [this.paints, SceneStaging.paintBytes / 4],
    ] as const) {
      const count = Math.min(applied, stream.count)
      stream.words.copyWithin(0, count * stride, stream.count * stride)
      stream.count -= count
      applied -= count
    }
    this.reindex()
  }

  /** Destruction may discard this node's rejected writes, never another node's suffix. */
  discard(node: SceneNodeHandle): void {
    this.assertWritable()
    if (!this.pending || node.context !== this.context || node.contextId !== this.contextId[0]) return
    const handle = nativeLayouts.ot_handle.fields
    for (const [stream, stride] of [
      [this.styles, SceneStaging.styleBytes / 4],
      [this.backgrounds, SceneStaging.backgroundBytes / 4],
      [this.paints, SceneStaging.paintBytes / 4],
    ] as const) {
      let count = 0
      for (let index = 0; index < stream.count; index++) {
        const offset = index * stride
        if (
          stream.words[offset + handle.slot.offset / 4] === node.slot &&
          stream.words[offset + handle.generation.offset / 4] === node.generation
        )
          continue
        if (count !== index) stream.words.copyWithin(count * stride, offset, offset + stride)
        count++
      }
      stream.count = count
    }
    if (!this.pending) this.clear()
    else this.reindex()
  }

  private reindex(): void {
    this.backgroundBySlot.clear()
    this.paintBySlot.clear()
    const slotWord = nativeLayouts.ot_handle.fields.slot.offset / 4
    const background = nativeLayouts.ot_scene_background_update
    for (let index = 0; index < this.backgrounds.count; index++) {
      const base = (index * background.size) / 4
      if (
        this.backgrounds.words[base + background.fields.fields.offset / 4] === nativeConstants.OT_SCENE_UPDATE_APPLY
      ) {
        this.backgroundBySlot.set(this.backgrounds.words[base + slotWord], index)
      }
    }
    for (let index = 0; index < this.paints.count; index++) {
      this.paintBySlot.set(this.paints.words[(index * SceneStaging.paintBytes) / 4 + slotWord], index)
    }
  }
}

function encodeEditorStyle(style: NativeEditorStyle): Uint32Array {
  const layout = nativeLayouts.ot_editor_style
  const record = new Uint32Array(layout.size / 4)
  const colors = new Uint16Array(record.buffer)
  const { fg, bg, attributes } = style
  record[layout.fields.struct_size.offset / 4] = layout.size
  record[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
  if (fg != null) {
    record[layout.fields.flags.offset / 4] |= NativeEditorStyleMask.Foreground
    contextBufferColor(fg, colors, layout.fields.foreground.offset / 2)
  }
  if (bg != null) {
    record[layout.fields.flags.offset / 4] |= NativeEditorStyleMask.Background
    contextBufferColor(bg, colors, layout.fields.background.offset / 2)
  }
  if (attributes != null) {
    record[layout.fields.flags.offset / 4] |= NativeEditorStyleMask.Attributes
    record[layout.fields.attributes.offset / 4] = toSafeFFIU32Length(attributes, "Editor style attributes")
  }
  return record
}

function encodeEditorSelection(selection: NativeEditorSelection): Uint32Array {
  const layout = nativeLayouts.ot_editor_selection
  const record = createContextRecord(layout)
  record[layout.fields.operation.offset / 4] = toSafeFFIU32Length(selection.operation, "Editor selection operation")
  record[layout.fields.behavior.offset / 4] = toSafeFFIU32Length(selection.behavior ?? 0, "Editor selection behavior")
  record[layout.fields.start.offset / 4] = toSafeFFIU32Length(selection.start ?? 0, "Editor selection start")
  record[layout.fields.end.offset / 4] = toSafeFFIU32Length(selection.end ?? 0, "Editor selection end")
  const coordinates = new Int32Array(record.buffer)
  for (const [field, value] of [
    ["anchor_x", selection.anchorX ?? 0],
    ["anchor_y", selection.anchorY ?? 0],
    ["focus_x", selection.focusX ?? 0],
    ["focus_y", selection.focusY ?? 0],
  ] as const) {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
      throw new RangeError("Editor selection coordinates must fit signed 32-bit cells")
    }
    coordinates[layout.fields[field].offset / 4] = value
  }
  record[layout.fields.update_cursor.offset / 4] = toFFIBool(
    selection.updateCursor ?? false,
    "Editor selection updateCursor",
  )
  record[layout.fields.follow_cursor.offset / 4] = toFFIBool(
    selection.followCursor ?? false,
    "Editor selection followCursor",
  )
  const { fg, bg } = selection
  const colors = new Uint16Array(record.buffer)
  if (fg != null) {
    record[layout.fields.flags.offset / 4] |= NativeEditorStyleMask.Foreground
    contextBufferColor(fg, colors, layout.fields.foreground.offset / 2)
  }
  if (bg != null) {
    record[layout.fields.flags.offset / 4] |= NativeEditorStyleMask.Background
    contextBufferColor(bg, colors, layout.fields.background.offset / 2)
  }
  return record
}

function encodeContextHighlight(highlight: Highlight | undefined): Uint32Array | null {
  if (highlight === undefined) return null
  const layout = nativeLayouts.ot_edit_highlight
  const record = new Uint32Array(layout.size / 4)
  record[layout.fields.start.offset / 4] = toSafeFFIU32Length(highlight.start, "Highlight start")
  record[layout.fields.end.offset / 4] = toSafeFFIU32Length(highlight.end, "Highlight end")
  record[layout.fields.style_id.offset / 4] = toSafeFFIU32Length(highlight.styleId, "Highlight style ID")
  record[layout.fields.priority.offset / 4] = toSafeFFIU32Length(highlight.priority ?? 0, "Highlight priority")
  record[layout.fields.ref.offset / 4] = toSafeFFIU32Length(highlight.hlRef ?? 0, "Highlight reference")
  return record
}

function decodeContextHighlights(records: Uint32Array): Highlight[] {
  const layout = nativeLayouts.ot_edit_highlight
  const highlights: Highlight[] = []
  for (let offset = 0; offset < records.length; offset += layout.size / 4) {
    highlights.push({
      start: records[offset + layout.fields.start.offset / 4],
      end: records[offset + layout.fields.end.offset / 4],
      styleId: records[offset + layout.fields.style_id.offset / 4],
      priority: records[offset + layout.fields.priority.offset / 4],
      hlRef: records[offset + layout.fields.ref.offset / 4],
    })
  }
  return highlights
}

function decodeContextTextLines(lines: Uint32Array, widthColsMax: number): LineInfo {
  const layout = nativeLayouts.ot_scene_text_line
  const info: LineInfo = {
    lineStartCols: [],
    lineWidthCols: [],
    lineWidthColsMax: widthColsMax,
    lineSources: [],
    lineWraps: [],
  }
  for (let index = 0; index < lines.length; index += layout.size / 4) {
    info.lineStartCols.push(lines[index + layout.fields.start_cols.offset / 4])
    info.lineWidthCols.push(lines[index + layout.fields.width_cols.offset / 4])
    info.lineSources.push(lines[index + layout.fields.source_line.offset / 4])
    info.lineWraps.push(lines[index + layout.fields.wrap_index.offset / 4])
  }
  return info
}

function widthMethodCode(widthMethod: WidthMethod): number {
  return widthMethod === "wcwidth" ? 0 : widthMethod === "unicode-wide" ? 3 : 1
}

function widthMethodFromCode(code: number): WidthMethod {
  if (code === 0) return "wcwidth"
  return code === 3 ? "unicode-wide" : "unicode"
}

const yogaSymbols = {
  yogaConfigCreateChecked: { args: ["buffer"], returns: "u32" },
  yogaConfigFreeChecked: { args: ["ptr"], returns: "u32" },
  yogaConfigSetCallbacks: { args: ["ptr", "ptr", "ptr"], returns: "bool" },
  yogaConfigClearCallbacks: { args: ["ptr", "ptr"], returns: "bool" },
  yogaConfigSetUseWebDefaultsChecked: { args: ["ptr", "u32"], returns: "u32" },
  yogaConfigGetUseWebDefaults: { args: ["ptr"], returns: "bool" },
  yogaConfigSetPointScaleFactorChecked: { args: ["ptr", "f32"], returns: "u32" },
  yogaConfigGetPointScaleFactor: { args: ["ptr"], returns: "f32" },
  yogaConfigSetErrataChecked: { args: ["ptr", "u32"], returns: "u32" },
  yogaConfigGetErrata: { args: ["ptr"], returns: "u32" },
  yogaConfigSetExperimentalFeatureEnabledChecked: { args: ["ptr", "u32", "u32"], returns: "u32" },
  yogaConfigIsExperimentalFeatureEnabledChecked: { args: ["ptr", "u32", "buffer"], returns: "u32" },
  yogaNodeCreateForOpenTUIChecked: { args: ["buffer"], returns: "u32" },
  yogaNodeCreateWithConfigChecked: { args: ["ptr", "buffer"], returns: "u32" },
  yogaNodeGetConfig: { args: ["ptr"], returns: "ptr" },
  yogaNodeFreeChecked: { args: ["ptr"], returns: "u32" },
  yogaNodeFreeRecursiveChecked: { args: ["ptr"], returns: "u32" },
  yogaNodeResetChecked: { args: ["ptr"], returns: "u32" },
  yogaNodeCopyStyleChecked: { args: ["ptr", "ptr"], returns: "u32" },
  yogaNodeInsertChildChecked: { args: ["ptr", "ptr", "u32"], returns: "u32" },
  yogaNodeRemoveChildChecked: { args: ["ptr", "ptr"], returns: "u32" },
  yogaNodeRemoveAllChildrenChecked: { args: ["ptr"], returns: "u32" },
  yogaNodeGetChildChecked: { args: ["ptr", "u32", "buffer"], returns: "u32" },
  yogaNodeGetChildCount: { args: ["ptr"], returns: "u32" },
  yogaNodeGetParent: { args: ["ptr"], returns: "ptr" },
  yogaNodeCalculateLayoutChecked: { args: ["ptr", "f32", "f32", "u32"], returns: "u32" },
  yogaNodeIsDirtyChecked: { args: ["ptr", "buffer"], returns: "u32" },
  yogaNodeMarkDirtyChecked: { args: ["ptr"], returns: "u32" },
  yogaNodeGetHasNewLayoutChecked: { args: ["ptr", "buffer"], returns: "u32" },
  yogaNodeSetHasNewLayoutChecked: { args: ["ptr", "u32"], returns: "u32" },
  yogaNodeSetIsReferenceBaselineChecked: { args: ["ptr", "u32"], returns: "u32" },
  yogaNodeIsReferenceBaselineChecked: { args: ["ptr", "buffer"], returns: "u32" },
  yogaNodeSetAlwaysFormsContainingBlockChecked: { args: ["ptr", "u32"], returns: "u32" },
  yogaNodeGetAlwaysFormsContainingBlockChecked: { args: ["ptr", "buffer"], returns: "u32" },
  yogaNodeGetComputedLayoutChecked: { args: ["ptr", "buffer"], returns: "u32" },
  yogaNodeLayoutGetEdgeChecked: { args: ["ptr", "u32", "u32", "buffer"], returns: "u32" },
  yogaNodeStyleSetEnumChecked: { args: ["ptr", "u32", "u32"], returns: "u32" },
  yogaNodeStyleGetEnumChecked: { args: ["ptr", "u32", "buffer"], returns: "u32" },
  yogaNodeStyleSetFloatChecked: { args: ["ptr", "u32", "f32"], returns: "u32" },
  yogaNodeStyleGetFloatChecked: { args: ["ptr", "u32", "buffer"], returns: "u32" },
  yogaNodeStyleSetBorderChecked: { args: ["ptr", "u32", "f32"], returns: "u32" },
  yogaNodeStyleGetBorderChecked: { args: ["ptr", "u32", "buffer"], returns: "u32" },
  yogaNodeStyleSetValueChecked: { args: ["ptr", "u32", "u32", "u32", "f32"], returns: "u32" },
  yogaNodeStyleSetDimensionChecked: { args: ["ptr", "u32", "u32", "f32", "u32"], returns: "u32" },
  yogaNodeStyleSetPositionsChecked: { args: ["ptr", "u32", "buffer", "buffer"], returns: "u32" },
  yogaNodeStyleGetValueChecked: { args: ["ptr", "u32", "u32", "buffer"], returns: "u32" },
  yogaNodeSetMeasureFuncChecked: { args: ["ptr", "u32"], returns: "u32" },
  yogaNodeUnsetMeasureFuncChecked: { args: ["ptr"], returns: "u32" },
  yogaNodeHasMeasureFunc: { args: ["ptr"], returns: "bool" },
  yogaNodeSetDirtiedFuncChecked: { args: ["ptr", "u32"], returns: "u32" },
  yogaNodeUnsetDirtiedFuncChecked: { args: ["ptr"], returns: "u32" },
  yogaStoreMeasureResult: { args: ["ptr", "f32", "f32"], returns: "void" },
} as const

function getOpenTUILib(libPath?: string) {
  const resolvedLibPath = libPath || targetLibPath
  if (!resolvedLibPath) {
    throw (
      targetLibError ??
      new Error(`OpenTUI is not supported on the current platform: ${process.platform}-${process.arch}`)
    )
  }

  const rawSymbols = dlopen(resolvedLibPath, {
    ...nativeSymbols,
    // Logging
    setLogCallback: {
      args: ["ptr"],
      returns: "void",
    },
    clipboardServiceCreate: {
      args: ["u32", "u32", "ptr", "u32"],
      returns: "u32",
    },
    clipboardServiceBeginShutdown: {
      args: ["u32"],
      returns: "u8",
    },
    clipboardServicePollShutdown: {
      args: ["u32"],
      returns: "u8",
    },
    clipboardServiceDestroy: {
      args: ["u32"],
      returns: "u8",
    },
    clipboardServiceDrain: {
      args: ["u32"],
      returns: "u8",
    },
    clipboardReadOperationStart: {
      args: ["u32", "ptr", "u32", "u8", "u32", "u32", "u32", "u32", "ptr"],
      returns: "u8",
    },
    clipboardWriteOperationStart: {
      args: ["u32", "ptr", "u32", "u8", "u32", "ptr"],
      returns: "u8",
    },
    clipboardClearOperationStart: {
      args: ["u32", "u8", "u32", "ptr"],
      returns: "u8",
    },
    clipboardOperationPoll: {
      args: ["u32"],
      returns: "u8",
    },
    clipboardOperationCancel: {
      args: ["u32"],
      returns: "u8",
    },
    clipboardOperationResultMimeLength: {
      args: ["u32", "ptr"],
      returns: "u8",
    },
    clipboardOperationResultMimeCopy: {
      args: ["u32", "ptr", "u32"],
      returns: "u8",
    },
    clipboardOperationResultDataLength: {
      args: ["u32", "ptr"],
      returns: "u8",
    },
    clipboardOperationResultDataCopy: {
      args: ["u32", "ptr", "u32"],
      returns: "u8",
    },
    clipboardOperationResultErrorCode: {
      args: ["u32", "ptr"],
      returns: "u8",
    },
    clipboardOperationResultDiagnosticLength: {
      args: ["u32", "ptr"],
      returns: "u8",
    },
    clipboardOperationResultDiagnosticCopy: {
      args: ["u32", "ptr", "u32"],
      returns: "u8",
    },
    clipboardOperationDestroy: {
      args: ["u32"],
      returns: "u8",
    },

    getArenaAllocatedBytes: {
      args: [],
      returns: "u64",
    },
    getBuildOptions: {
      args: ["ptr"],
      returns: "void",
    },
    getAllocatorStats: {
      args: ["ptr"],
      returns: "void",
    },

    imageInfo: { args: ["ptr", "u32", "ptr"], returns: "u32" },
    imageRetainIccCache: { args: [], returns: "void" },
    imageReleaseIccCache: { args: [], returns: "void" },
    imageDecode: { args: ["ptr", "u32", "buffer"], returns: "u32" },
    imageCreateFromRgba: { args: ["ptr", "u64", "u32", "u32", "u32", "buffer"], returns: "u32" },
    imageCreateFromPixels: { args: ["ptr", "u64", "u32", "u32", "u32", "u32", "u32", "buffer"], returns: "u32" },
    imageUpdatePixels: { args: ["u32", "ptr", "u64", "u32", "u32", "u32"], returns: "u32" },
    imageDestroy: { args: ["u32"], returns: "void" },
    imageRetain: { args: ["u32", "buffer"], returns: "u32" },
    imageGetInfo: { args: ["u32", "ptr"], returns: "u32" },
    imageMaterialize: { args: ["u32"], returns: "u32" },
    imageEnsureEncodedPng: { args: ["u32"], returns: "u32" },
    imageGetPixelsPtr: { args: ["u32"], returns: "ptr" },
    imageClone: { args: ["u32", "buffer"], returns: "u32" },
    imageCopyPixels: { args: ["u32", "ptr", "u64", "u32", "u8"], returns: "u32" },
    imageResize: { args: ["u32", "u32", "u32", "u32", "buffer"], returns: "u32" },
    imageExtract: { args: ["u32", "u32", "u32", "u32", "u32", "buffer"], returns: "u32" },
    imageExtend: { args: ["u32", "u32", "u32", "u32", "u32", "buffer", "buffer"], returns: "u32" },
    imageTransform: { args: ["u32", "u32", "buffer"], returns: "u32" },
    imageComposite: { args: ["u32", "u32", "i32", "i32", "u32", "u8", "buffer"], returns: "u32" },

    ...yogaSymbols,

    // Audio
    createAudioEngine: {
      args: ["ptr"],
      returns: "u32",
    },
    destroyAudioEngine: {
      args: ["u32"],
      returns: "void",
    },
    audioRefreshPlaybackDevices: {
      args: ["u32"],
      returns: "i32",
    },
    audioGetPlaybackDeviceCount: {
      args: ["u32"],
      returns: "u32",
    },
    audioGetPlaybackDeviceName: {
      args: ["u32", "u32", "buffer", "u32"],
      returns: "u32",
    },
    audioIsPlaybackDeviceDefault: {
      args: ["u32", "u32"],
      returns: "bool",
    },
    audioSelectPlaybackDevice: {
      args: ["u32", "u32"],
      returns: "i32",
    },
    audioClearPlaybackDeviceSelection: {
      args: ["u32"],
      returns: "void",
    },
    audioRefreshCaptureDevices: {
      args: ["u32"],
      returns: "i32",
    },
    audioGetCaptureDeviceCount: {
      args: ["u32"],
      returns: "u32",
    },
    audioGetCaptureDeviceName: {
      args: ["u32", "u32", "buffer", "u32"],
      returns: "u32",
    },
    audioIsCaptureDeviceDefault: {
      args: ["u32", "u32"],
      returns: "bool",
    },
    audioSelectCaptureDevice: {
      args: ["u32", "u32"],
      returns: "i32",
    },
    audioClearCaptureDeviceSelection: {
      args: ["u32"],
      returns: "void",
    },
    audioStartCapture: {
      args: ["u32", "ptr", "u32", "u32"],
      returns: "i32",
    },
    audioStopCapture: {
      args: ["u32"],
      returns: "i32",
    },
    audioIsCaptureRunning: {
      args: ["u32"],
      returns: "bool",
    },
    audioReadCapture: {
      args: ["u32", "buffer", "u32", "u32", "ptr"],
      returns: "i32",
    },
    audioGetCaptureStats: {
      args: ["u32", "ptr"],
      returns: "i32",
    },
    audioStart: {
      args: ["u32", "ptr"],
      returns: "i32",
    },
    audioStartMixer: {
      args: ["u32"],
      returns: "i32",
    },
    audioStop: {
      args: ["u32"],
      returns: "i32",
    },
    audioCreateStream: {
      args: ["u32", "ptr", "ptr"],
      returns: "i32",
    },
    audioWriteStream: {
      args: ["u32", "u32", "ptr", "u32"],
      returns: "i32",
    },
    audioEndStream: {
      args: ["u32", "u32"],
      returns: "i32",
    },
    audioRestartStream: {
      args: ["u32", "u32"],
      returns: "i32",
    },
    audioSetStreamVolume: {
      args: ["u32", "u32", "f32"],
      returns: "i32",
    },
    audioSetStreamPan: {
      args: ["u32", "u32", "f32"],
      returns: "i32",
    },
    audioSetStreamGroup: {
      args: ["u32", "u32", "u32"],
      returns: "i32",
    },
    audioGetStreamStats: {
      args: ["u32", "u32", "ptr"],
      returns: "i32",
    },
    audioCloseStream: {
      args: ["u32", "u32", "u32", "ptr"],
      returns: "i32",
    },
    audioLoad: {
      args: ["u32", "buffer", "u32", "ptr"],
      returns: "i32",
    },
    audioUnload: {
      args: ["u32", "u32"],
      returns: "i32",
    },
    audioPlay: {
      args: ["u32", "u32", "ptr", "ptr"],
      returns: "i32",
    },
    audioStopVoice: {
      args: ["u32", "u32"],
      returns: "i32",
    },
    audioSetVoiceGroup: {
      args: ["u32", "u32", "u32"],
      returns: "i32",
    },
    audioCreateGroup: {
      args: ["u32", "buffer", "u32", "ptr"],
      returns: "i32",
    },
    audioSetGroupVolume: {
      args: ["u32", "u32", "f32"],
      returns: "i32",
    },
    audioSetMasterVolume: {
      args: ["u32", "f32"],
      returns: "i32",
    },
    audioMixToBuffer: {
      args: ["u32", "buffer", "u32", "u8"],
      returns: "i32",
    },
    audioEnableTap: {
      args: ["u32", "u8", "u32"],
      returns: "i32",
    },
    audioReadTap: {
      args: ["u32", "buffer", "u32", "u8", "ptr"],
      returns: "i32",
    },
    audioGetStats: {
      args: ["u32", "ptr"],
      returns: "i32",
    },

    // NativeSpanFeed
    createNativeSpanFeed: {
      args: ["ptr"],
      returns: "ptr",
    },
    attachNativeSpanFeed: {
      args: ["ptr"],
      returns: "i32",
    },
    destroyNativeSpanFeed: {
      args: ["ptr"],
      returns: "i32",
    },
    streamWrite: {
      args: ["ptr", "ptr", "u32"],
      returns: "i32",
    },
    streamCommit: {
      args: ["ptr"],
      returns: "i32",
    },
    streamDrainSpans: {
      args: ["ptr", "buffer", "u32"],
      returns: "u32",
    },
    streamReleaseSpan: {
      args: ["ptr", "u32", "u64"],
      returns: "i32",
    },
    streamClose: {
      args: ["ptr"],
      returns: "i32",
    },
    streamReserve: {
      args: ["ptr", "u32", "ptr"],
      returns: "i32",
    },
    streamCommitReserved: {
      args: ["ptr", "u32"],
      returns: "i32",
    },
    streamGetStats: {
      args: ["ptr", "ptr"],
      returns: "i32",
    },
    streamSetCallback: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
  })

  if (env.OTUI_DEBUG_FFI || env.OTUI_TRACE_FFI) {
    return {
      ...rawSymbols,
      symbols: convertToDebugSymbols(rawSymbols.symbols),
    }
  }

  return rawSymbols
}

function convertToDebugSymbols<T extends Record<string, any>>(symbols: T): T {
  // Initialize global state on first call
  if (!globalTraceSymbols) {
    globalTraceSymbols = {}
  }

  // Initialize global debug log path on first call
  if (env.OTUI_DEBUG_FFI && !globalFFILogPath) {
    const now = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, "-").replace(/T/, "_").split("Z")[0]
    globalFFILogPath = `ffi_otui_debug_${timestamp}.log`
  }

  const debugSymbols: Record<string, any> = {}

  Object.entries(symbols).forEach(([key, value]) => {
    debugSymbols[key] = value
  })

  if (env.OTUI_DEBUG_FFI && globalFFILogPath) {
    const logPath = globalFFILogPath
    let loggingDisabled = false
    const writeSync = (msg: string) => {
      if (loggingDisabled) return
      try {
        writeFileSync(logPath, msg + "\n", { flag: "a" })
      } catch {
        // Logging must not hide a committed native result.
        loggingDisabled = true
      }
    }

    Object.entries(symbols).forEach(([key, value]) => {
      if (typeof value === "function") {
        debugSymbols[key] = (...args: any[]) => {
          writeSync(`${key}(${args.map((arg) => String(arg)).join(", ")})`)
          const result = value(...args)
          writeSync(`${key} returned: ${String(result)}`)
          return result
        }
      }
    })
  }

  if (env.OTUI_TRACE_FFI) {
    Object.entries(symbols).forEach(([key, value]) => {
      if (typeof value === "function") {
        // Initialize trace array for this symbol if not exists
        if (!globalTraceSymbols![key]) {
          globalTraceSymbols![key] = []
        }

        const originalFunc = debugSymbols[key]
        debugSymbols[key] = (...args: any[]) => {
          const start = performance.now()
          const result = originalFunc(...args)
          const end = performance.now()
          globalTraceSymbols![key].push(end - start)
          return result
        }
      }
    })
  }

  // Register exit handler only once
  if ((env.OTUI_DEBUG_FFI || env.OTUI_TRACE_FFI) && !exitHandlerRegistered) {
    exitHandlerRegistered = true

    process.on("exit", () => {
      if (globalTraceSymbols) {
        const allStats: Array<{
          name: string
          count: number
          total: number
          average: number
          min: number
          max: number
          median: number
          p90: number
          p99: number
        }> = []

        for (const [key, timings] of Object.entries(globalTraceSymbols)) {
          if (!Array.isArray(timings) || timings.length === 0) {
            continue
          }

          const sortedTimings = [...timings].sort((a, b) => a - b)
          const count = sortedTimings.length

          const total = sortedTimings.reduce((acc, t) => acc + t, 0)
          const average = total / count
          const min = sortedTimings[0]
          const max = sortedTimings[count - 1]

          const medianIndex = Math.floor(count / 2)
          const p90Index = Math.floor(count * 0.9)
          const p99Index = Math.floor(count * 0.99)

          const median = sortedTimings[medianIndex]
          const p90 = sortedTimings[Math.min(p90Index, count - 1)]
          const p99 = sortedTimings[Math.min(p99Index, count - 1)]

          allStats.push({
            name: key,
            count,
            total,
            average,
            min,
            max,
            median,
            p90,
            p99,
          })
        }

        allStats.sort((a, b) => b.total - a.total)

        const lines: string[] = []
        lines.push("\n--- OpenTUI FFI Call Performance ---")
        lines.push("Sorted by total time spent (descending)")
        lines.push(
          "-------------------------------------------------------------------------------------------------------------------------",
        )

        if (allStats.length === 0) {
          lines.push("No trace data collected or all symbols had zero calls.")
        } else {
          const nameHeader = "Symbol"
          const callsHeader = "Calls"
          const totalHeader = "Total (ms)"
          const avgHeader = "Avg (ms)"
          const minHeader = "Min (ms)"
          const maxHeader = "Max (ms)"
          const medHeader = "Med (ms)"
          const p90Header = "P90 (ms)"
          const p99Header = "P99 (ms)"

          const nameWidth = Math.max(nameHeader.length, ...allStats.map((s) => s.name.length))
          const countWidth = Math.max(callsHeader.length, ...allStats.map((s) => String(s.count).length))
          const totalWidth = Math.max(totalHeader.length, ...allStats.map((s) => s.total.toFixed(2).length))
          const avgWidth = Math.max(avgHeader.length, ...allStats.map((s) => s.average.toFixed(2).length))
          const statWidthMin = Math.max(minHeader.length, ...allStats.map((s) => s.min.toFixed(2).length))
          const statWidthMax = Math.max(maxHeader.length, ...allStats.map((s) => s.max.toFixed(2).length))
          const medianWidth = Math.max(medHeader.length, ...allStats.map((s) => s.median.toFixed(2).length))
          const p90Width = Math.max(p90Header.length, ...allStats.map((s) => s.p90.toFixed(2).length))
          const p99Width = Math.max(p99Header.length, ...allStats.map((s) => s.p99.toFixed(2).length))

          lines.push(
            `${nameHeader.padEnd(nameWidth)} | ` +
              `${callsHeader.padStart(countWidth)} | ` +
              `${totalHeader.padStart(totalWidth)} | ` +
              `${avgHeader.padStart(avgWidth)} | ` +
              `${minHeader.padStart(statWidthMin)} | ` +
              `${maxHeader.padStart(statWidthMax)} | ` +
              `${medHeader.padStart(medianWidth)} | ` +
              `${p90Header.padStart(p90Width)} | ` +
              `${p99Header.padStart(p99Width)}`,
          )
          lines.push(
            `${"-".repeat(nameWidth)}-+-${"-".repeat(countWidth)}-+-${"-".repeat(totalWidth)}-+-${"-".repeat(avgWidth)}-+-${"-".repeat(statWidthMin)}-+-${"-".repeat(statWidthMax)}-+-${"-".repeat(medianWidth)}-+-${"-".repeat(p90Width)}-+-${"-".repeat(p99Width)}`,
          )

          allStats.forEach((stat) => {
            lines.push(
              `${stat.name.padEnd(nameWidth)} | ` +
                `${String(stat.count).padStart(countWidth)} | ` +
                `${stat.total.toFixed(2).padStart(totalWidth)} | ` +
                `${stat.average.toFixed(2).padStart(avgWidth)} | ` +
                `${stat.min.toFixed(2).padStart(statWidthMin)} | ` +
                `${stat.max.toFixed(2).padStart(statWidthMax)} | ` +
                `${stat.median.toFixed(2).padStart(medianWidth)} | ` +
                `${stat.p90.toFixed(2).padStart(p90Width)} | ` +
                `${stat.p99.toFixed(2).padStart(p99Width)}`,
            )
          })
        }
        lines.push(
          "-------------------------------------------------------------------------------------------------------------------------",
        )

        const output = lines.join("\n")
        console.log(output)

        try {
          const now = new Date()
          const timestamp = now.toISOString().replace(/[:.]/g, "-").replace(/T/, "_").split("Z")[0]
          const traceFilePath = `ffi_otui_trace_${timestamp}.log`
          void writeFile(traceFilePath, output).catch((error) => {
            console.error("Failed to write FFI trace file:", error)
          })
        } catch (e) {
          console.error("Failed to write FFI trace file:", e)
        }
      }
    })
  }

  return debugSymbols as T
}

// Log levels matching Zig's LogLevel enum
export enum LogLevel {
  Error = 0,
  Warn = 1,
  Info = 2,
  Debug = 3,
}

/**
 * VisualCursor represents a cursor position with both visual and logical coordinates.
 * Visual coordinates (visualRow, visualCol) are VIEWPORT-RELATIVE.
 * This means visualRow=0 is the first visible line in the viewport, not the first line in the document.
 * Logical coordinates (logicalRow, logicalCol) are document-absolute.
 */
export interface VisualCursor {
  visualRow: number // Viewport-relative row (0 = top of viewport)
  visualCol: number // Viewport-relative column (0 = left edge of viewport when not wrapping)
  logicalRow: number // Document-absolute row
  logicalCol: number // Document-absolute column
  offset: number // Global display-width offset from buffer start
}

export interface LogicalCursor {
  row: number
  col: number
  offset: number
}

export interface MeasureResult {
  lineCount: number
  widthColsMax: number
}

export interface CursorState {
  x: number
  y: number
  visible: boolean
  style: CursorStyle
  blinking: boolean
  color: RGBA
}

export type NativeSpanFeedEventHandler = (eventId: number, arg0: Pointer, arg1: number | bigint) => void

export type NativeBufferedOutput = "stdout" | "memory"

export interface NativeYogaLayout {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type NativeYogaMeasureCallback = (
  node: Pointer | null,
  width: number,
  widthMode: number,
  height: number,
  heightMode: number,
) => void

export type NativeYogaDirtiedCallback = (node: Pointer | null) => void

export interface AudioEngineLib extends Pick<
  FFIRenderLib,
  Extract<keyof FFIRenderLib, `audio${string}` | "createAudioEngine" | "destroyAudioEngine">
> {}

export type RenderLib = Pick<FFIRenderLib, keyof FFIRenderLib>

export class FFIRenderLib {
  private bufferDrawRecord: ReturnType<typeof createBufferDrawRecord> | undefined
  private sceneLayoutRecord: ReturnType<typeof createSceneLayoutRecord> | undefined
  private sceneFrameRecord: ReturnType<typeof createSceneFrameRecord> | undefined = createSceneFrameRecord()
  private sceneCreateRecord: ReturnType<typeof createSceneNodeRecord> | undefined = createSceneNodeRecord()
  private sceneDestroyHandle: ReturnType<typeof createContextHandleRecord> | undefined = createContextHandleRecord()
  private sceneMoveRecord: ReturnType<typeof createSceneNodeRecord> | undefined = createSceneNodeRecord()
  private sceneHooksRecord: ReturnType<typeof createSceneHooksRecord> | undefined = createSceneHooksRecord()
  private sceneFlushApplied: Uint32Array | undefined = new Uint32Array(1)
  private opentui: ReturnType<typeof getOpenTUILib>
  private iccCacheClient = false
  // Layout reads are synchronous and non-reentrant. Retain one backing buffer so
  // Node does not allocate and resolve a new output pointer for every node.
  private readonly yogaLayout = new Float32Array(6)
  private readonly yogaU32 = new Uint32Array(1)
  private readonly yogaF32 = new Float32Array(1)
  private readonly yogaU64 = new BigUint64Array(1)
  private yogaHost?: YogaHost
  private readonly ffiStructStorage = {
    audioStreamStats: {
      ...allocStruct(AudioStreamStatsStruct),
      result: {
        bytesReceived: 0n,
        framesDecoded: 0n,
        framesPlayed: 0n,
        state: 0,
        sampleRate: 0,
        channels: 0,
        bufferedFrames: 0,
        capacityFrames: 0,
        underruns: 0,
        errorCode: 0,
        readyGeneration: 0,
      } as NativeAudioStreamStats,
    },
  }
  private disposed = false
  private nativeContexts = new Map<NativeContextHandle, Pointer>()
  private contextEditEvents = new Map<
    NativeContextHandle,
    {
      callback: FFICallbackInstance
      buffers: Map<
        number,
        { handle: ContextEditBufferHandle; listeners: Set<{ handler: (event: NativeEditEventName) => void }> }
      >
    }
  >()
  private sceneMeasures = new Map<
    NativeContextHandle,
    {
      callback: FFICallbackInstance
      nodes: Map<number, { handle: SceneNodeHandle; measure: MeasureFunction }>
    }
  >()
  private clipboardServices = new Set<ClipboardServiceHandle>()
  public readonly encoder: TextEncoder = new TextEncoder()
  private readonly emptyBytes = new Uint8Array(0)
  public readonly decoder: TextDecoder = new TextDecoder()
  private logCallbackWrapper: FFICallbackInstance | null = null
  private nativeSpanFeedCallbackWrapper: FFICallbackInstance | null = null
  private nativeSpanFeedHandlers = new Map<Pointer, NativeSpanFeedEventHandler>()

  public createContext(options: NativeContextOptions): NativeContextHandle {
    const layout = nativeLayouts.ot_context_options
    const record = createContextRecord(layout)
    record[layout.fields.object_capacity.offset / 4] = toSafeFFIU32Length(
      options.objectCapacity,
      "Context objectCapacity",
    )
    record[layout.fields.render_cells_max.offset / 4] = toSafeFFIU32Length(
      options.renderCellsMax,
      "Context renderCellsMax",
    )
    const output = new BigUint64Array(1)
    const context = Object.freeze({}) as NativeContextHandle
    if (this.disposed) throw new Error("OpenTUI native library is disposed")
    nativeResult("ot_context_create", this.opentui.symbols.ot_context_create(record, output))
    const pointer = toPointer(output[0])
    try {
      this.nativeContexts.set(context, pointer)
      return context
    } catch (error) {
      this.opentui.symbols.ot_context_destroy(pointer)
      throw error
    }
  }

  private nativeContextPointer(context: NativeContextHandle, operation: string): Pointer {
    // Resolve after encoding caller records: their getters can destroy the context.
    const pointer = this.nativeContexts.get(context)
    if (pointer === undefined) throw new NativeError(operation, NativeStatus.WrongContext)
    return pointer
  }

  public destroyContext(context: NativeContextHandle): void {
    this.getYogaHost().assertMutable()
    const pointer = this.nativeContextPointer(context, "ot_context_destroy")
    nativeResult("ot_context_destroy", this.opentui.symbols.ot_context_destroy(pointer))
    this.nativeContexts.delete(context)
    this.sceneMeasures.get(context)?.callback.close()
    this.sceneMeasures.delete(context)
    const events = this.contextEditEvents.get(context)
    if (events) {
      events.callback.close()
      for (const entry of events.buffers.values()) entry.listeners.clear()
      events.buffers.clear()
    }
    this.contextEditEvents.delete(context)
  }

  public contextGetLinkUrl(context: NativeContextHandle, linkId: number): string {
    const id = toSafeFFIU32Length(linkId, "Link id")
    const bytes = new Uint8Array(MAX_LINK_URL_BYTES)
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_context_get_link_url")
    nativeResult(
      "ot_context_get_link_url",
      this.opentui.symbols.ot_context_get_link_url(pointer, id, bytes, bytes.length, count),
    )
    if (count[0] > bytes.length) throw new NativeError("ot_context_get_link_url", NativeStatus.InternalError)
    return count[0] === 0 ? "" : this.decoder.decode(bytes.subarray(0, count[0]))
  }

  public createContextTextBuffer(
    context: NativeContextHandle,
    options: NativeContextEditBufferOptions = {},
  ): ContextTextBufferHandle {
    const layout = nativeLayouts.ot_edit_buffer_options
    this.getYogaHost().assertMutable()
    const widthMethod = options.widthMethod ?? "unicode"
    if (!["wcwidth", "unicode", "no-zwj", "unicode-wide"].includes(widthMethod)) {
      throw new TypeError("Unknown Context text width method")
    }
    const record = createContextRecord(layout)
    record[layout.fields.width_method.offset / 4] = widthMethod === "no-zwj" ? 2 : widthMethodCode(widthMethod)
    const output = new BigUint64Array(nativeLayouts.ot_handle.size / 8)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_create")
    nativeResult("ot_text_buffer_create", this.opentui.symbols.ot_text_buffer_create(pointer, record, output))
    try {
      return decodeContextHandle(context, output) as ContextTextBufferHandle
    } catch (error) {
      this.opentui.symbols.ot_text_buffer_destroy(pointer, output)
      throw error
    }
  }

  public createContextUnicode(
    context: NativeContextHandle,
    text: string,
    widthMethod: WidthMethod | "no-zwj",
  ): ContextUnicodeHandle {
    this.getYogaHost().assertMutable()
    if (!["wcwidth", "unicode", "no-zwj", "unicode-wide"].includes(widthMethod)) {
      throw new TypeError("Unknown Context Unicode width method")
    }
    const bytes = this.encoder.encode(text)
    const count = toSafeFFIU32Length(bytes.byteLength, "Unicode input bytes")
    const method = widthMethod === "no-zwj" ? 2 : widthMethodCode(widthMethod)
    const output = new BigUint64Array(nativeLayouts.ot_handle.size / 8)
    const pointer = this.nativeContextPointer(context, "ot_unicode_create")
    nativeResult(
      "ot_unicode_create",
      this.opentui.symbols.ot_unicode_create(pointer, viewOrNull(bytes), count, method, output),
    )
    try {
      return decodeContextHandle(context, output) as ContextUnicodeHandle
    } catch (error) {
      this.opentui.symbols.ot_unicode_destroy(pointer, output)
      throw error
    }
  }

  public sceneMeasureLayout(context: NativeContextHandle, session: SessionHandle, root: SceneNodeHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, session)
    const node = encodeContextHandle(context, root)
    const measures = this.sceneMeasures.get(context)?.nodes.size
    if (measures) this.getYogaHost().flushSceneMutations()
    const pointer = this.nativeContextPointer(context, "ot_scene_measure_layout")
    if (measures) {
      this.getYogaHost().runMutation(() => {
        nativeResult("ot_scene_measure_layout", this.opentui.symbols.ot_scene_measure_layout(pointer, handle, node))
      })
    } else {
      nativeResult("ot_scene_measure_layout", this.opentui.symbols.ot_scene_measure_layout(pointer, handle, node))
    }
  }

  public sceneFrameCopyBuffer(
    context: NativeContextHandle,
    session: SessionHandle,
    frame: NativeSceneFrameRequest,
    target: ContextBufferHandle,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, session)
    const ticket = encodeSceneFrameRequest(context, frame)
    const buffer = encodeContextHandle(context, target)
    const pointer = this.nativeContextPointer(context, "ot_scene_frame_copy_buffer")
    nativeResult(
      "ot_scene_frame_copy_buffer",
      this.opentui.symbols.ot_scene_frame_copy_buffer(pointer, handle, ticket, buffer),
    )
  }

  public sessionRenderSplit(
    context: NativeContextHandle,
    session: SessionHandle,
    frame: NativeSceneFrameRequest | null,
    snapshots: readonly NativeSplitSnapshot[],
    pinnedRenderOffset: number,
    force: boolean,
  ): { status: NativeSessionRenderStatus; renderOffset: number } {
    const layout = nativeLayouts.ot_split_snapshot
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, session)
    const ticket = frame ? encodeSceneFrameRequest(context, frame) : null
    const count = toSafeFFIU32Length(snapshots.length, "Split snapshot count")
    if (count > 64) throw new RangeError("At most 64 split snapshots can be submitted together")
    const records = new BigUint64Array(count * (layout.size / 8))
    const fields = new Uint32Array(records.buffer)
    for (let index = 0; index < count; index++) {
      const snapshot = snapshots[index]
      const offset = index * layout.size
      encodeContextHandle(
        context,
        snapshot.snapshot,
        new BigUint64Array(records.buffer, offset + layout.fields.buffer.offset, nativeLayouts.ot_handle.size / 8),
      )
      fields[(offset + layout.fields.row_columns.offset) / 4] = toSafeFFIU32Length(
        snapshot.rowColumns,
        "Split snapshot row columns",
      )
      fields[(offset + layout.fields.flags.offset) / 4] =
        toFFIBool(snapshot.startOnNewLine, "Split start on new line") |
        (toFFIBool(snapshot.trailingNewline, "Split trailing newline") << 1)
    }
    const offset = toSafeFFIU32Length(pinnedRenderOffset, "Split pinned render offset")
    const forced = toFFIBool(force, "Split force render")
    const output = new Uint32Array(2)
    const pointer = this.nativeContextPointer(context, "ot_session_render_split")
    nativeResult(
      "ot_session_render_split",
      this.opentui.symbols.ot_session_render_split(
        pointer,
        handle,
        ticket,
        count ? records : null,
        count,
        offset,
        forced,
        output.subarray(0, 1),
        output.subarray(1),
      ),
    )
    return { status: output[0], renderOffset: output[1] }
  }

  public sessionSplitControl(
    context: NativeContextHandle,
    session: SessionHandle,
    command: NativeSessionSplitControl,
  ): number {
    const layout = nativeLayouts.ot_split_control
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, session)
    const record = createContextRecord(layout)
    switch (command.kind) {
      case "reset":
        record[layout.fields.command.offset / 4] = 0
        record[layout.fields.arguments.offset / 4] = toSafeFFIU32Length(command.seedRows, "Split seed rows")
        record[(layout.fields.arguments.offset + 4) / 4] = toSafeFFIU32Length(
          command.pinnedRenderOffset,
          "Split pinned render offset",
        )
        break
      case "sync":
        record[layout.fields.command.offset / 4] = 1
        record[layout.fields.arguments.offset / 4] = toSafeFFIU32Length(
          command.pinnedRenderOffset,
          "Split pinned render offset",
        )
        break
      case "output-offset":
        record[layout.fields.command.offset / 4] = 2
        record[layout.fields.arguments.offset / 4] = toSafeFFIU32Length(command.surfaceOffset, "Split surface offset")
        break
      case "render-offset":
        record[layout.fields.command.offset / 4] = 3
        record[layout.fields.arguments.offset / 4] = toSafeFFIU32Length(command.renderOffset, "Split render offset")
        break
      case "transition": {
        const mode = command.mode
        if (mode !== "viewport-scroll" && mode !== "clear-stale-rows")
          throw new TypeError("Unknown split transition mode")
        record[layout.fields.command.offset / 4] = 4
        record[layout.fields.arguments.offset / 4] = mode === "viewport-scroll" ? 1 : 2
        record[(layout.fields.arguments.offset + 4) / 4] = toSafeFFIU32Length(
          command.sourceTopLine,
          "Split source top line",
        )
        record[(layout.fields.arguments.offset + 8) / 4] = toSafeFFIU32Length(
          command.sourceHeight,
          "Split source height",
        )
        record[(layout.fields.arguments.offset + 12) / 4] = toSafeFFIU32Length(
          command.targetTopLine,
          "Split target top line",
        )
        record[(layout.fields.arguments.offset + 16) / 4] = toSafeFFIU32Length(
          command.targetHeight,
          "Split target height",
        )
        record[(layout.fields.arguments.offset + 20) / 4] = toSafeFFIU32Length(
          command.scrollLines ?? 0,
          "Split scroll lines",
        )
        break
      }
      case "clear-transition":
        record[layout.fields.command.offset / 4] = 5
        break
      default:
        throw new TypeError("Unknown split control")
    }
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_session_split_control")
    nativeResult(
      "ot_session_split_control",
      this.opentui.symbols.ot_session_split_control(pointer, handle, record, output),
    )
    return output[0]
  }

  public sessionSetScreen(
    context: NativeContextHandle,
    session: SessionHandle,
    alternate: boolean,
    width: number,
    height: number,
    trailingOutput: Uint8Array = new Uint8Array(),
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, session)
    const value = toFFIBool(alternate, "Session alternate screen")
    const columns = toSafeFFIU32Length(width, "Session screen columns")
    const rows = toSafeFFIU32Length(height, "Session screen rows")
    const input = sessionBytes(trailingOutput, "Session screen output length")
    const pointer = this.nativeContextPointer(context, "ot_session_set_screen")
    nativeResult(
      "ot_session_set_screen",
      this.opentui.symbols.ot_session_set_screen(pointer, handle, value, columns, rows, input, input.byteLength),
    )
  }

  public sessionSyncDetached(context: NativeContextHandle, session: SessionHandle, parent: SessionHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, session)
    const source = encodeContextHandle(context, parent)
    const pointer = this.nativeContextPointer(context, "ot_session_sync_detached")
    nativeResult("ot_session_sync_detached", this.opentui.symbols.ot_session_sync_detached(pointer, handle, source))
  }

  public getContextUnicode(
    context: NativeContextHandle,
    unicode: ContextUnicodeHandle,
  ): Array<{ width: number; char: number }> {
    const layout = nativeLayouts.ot_unicode_char
    const handle = encodeContextHandle(context, unicode)
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_unicode_get")
    nativeResult("ot_unicode_get", this.opentui.symbols.ot_unicode_get(pointer, handle, null, 0, count))
    const records = new Uint32Array(count[0] * (layout.size / 4))
    if (count[0])
      nativeResult("ot_unicode_get", this.opentui.symbols.ot_unicode_get(pointer, handle, records, count[0], count))
    return Array.from({ length: count[0] }, (_, index) => ({
      width: records[(index * layout.size + layout.fields.width.offset) / 4],
      char: records[(index * layout.size + layout.fields.character.offset) / 4],
    }))
  }

  public destroyContextUnicode(context: NativeContextHandle, unicode: ContextUnicodeHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, unicode)
    const pointer = this.nativeContextPointer(context, "ot_unicode_destroy")
    nativeResult("ot_unicode_destroy", this.opentui.symbols.ot_unicode_destroy(pointer, handle))
  }

  public contextBufferDrawUnicode(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    unicode: ContextUnicodeHandle,
    index: number,
    x: number,
    y: number,
    foreground: RGBA,
    background: RGBA,
    attributes: number,
  ): void {
    const handle = encodeContextHandle(context, target)
    const source = encodeContextHandle(context, unicode)
    const ticket = frame ? encodeSceneFrameRequest(context, frame) : null
    const item = toSafeFFIU32Length(index, "Unicode character index")
    const column = embeddedTerminalI32(x, "Unicode x")
    const row = embeddedTerminalI32(y, "Unicode y")
    const fg = contextBufferColor(foreground)
    const bg = contextBufferColor(background)
    const attrs = toSafeFFIU32Length(attributes, "Unicode attributes")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_buffer_draw_unicode")
      nativeResult(
        "ot_buffer_draw_unicode",
        this.opentui.symbols.ot_buffer_draw_unicode(pointer, handle, ticket, source, item, column, row, fg, bg, attrs),
      )
    })
  }

  public createContextEmbeddedTerminal(
    context: NativeContextHandle,
    options: { cols: number; rows: number; maxScrollback?: number },
  ): ContextEmbeddedTerminalHandle {
    const layout = nativeLayouts.ot_embedded_terminal_options
    this.getYogaHost().assertMutable()
    const record = createContextRecord(layout)
    record[layout.fields.cols.offset / 4] = embeddedTerminalDimension(options.cols, "columns")
    record[layout.fields.rows.offset / 4] = embeddedTerminalDimension(options.rows, "rows")
    record[layout.fields.max_scrollback.offset / 4] = toSafeFFIU32Length(
      options.maxScrollback ?? 10_000,
      "Embedded terminal maxScrollback",
    )
    const output = new BigUint64Array(nativeLayouts.ot_handle.size / 8)
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_create")
    nativeResult(
      "ot_embedded_terminal_create",
      this.opentui.symbols.ot_embedded_terminal_create(pointer, record, output),
    )
    try {
      return decodeContextHandle(context, output) as ContextEmbeddedTerminalHandle
    } catch (error) {
      this.opentui.symbols.ot_embedded_terminal_destroy(pointer, output)
      throw error
    }
  }

  public destroyContextEmbeddedTerminal(context: NativeContextHandle, terminal: ContextEmbeddedTerminalHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, terminal)
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_destroy")
    nativeResult("ot_embedded_terminal_destroy", this.opentui.symbols.ot_embedded_terminal_destroy(pointer, handle))
  }

  public contextEmbeddedTerminalWrite(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
    data: string | Uint8Array,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, terminal)
    const bytes = sessionBytes(
      typeof data === "string" ? this.encoder.encode(data) : data,
      "Embedded terminal write bytes",
    )
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_write")
    nativeResult(
      "ot_embedded_terminal_write",
      this.opentui.symbols.ot_embedded_terminal_write(pointer, handle, viewOrNull(bytes), bytes.byteLength),
    )
  }

  public contextEmbeddedTerminalResize(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
    cols: number,
    rows: number,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, terminal)
    const width = embeddedTerminalDimension(cols, "columns")
    const height = embeddedTerminalDimension(rows, "rows")
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_resize")
    nativeResult(
      "ot_embedded_terminal_resize",
      this.opentui.symbols.ot_embedded_terminal_resize(pointer, handle, width, height),
    )
  }

  private contextTerminalCommand(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
    command: number,
    argument = 0,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, terminal)
    const value = embeddedTerminalI32(argument, "Embedded terminal command argument")
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_command")
    nativeResult(
      "ot_embedded_terminal_command",
      this.opentui.symbols.ot_embedded_terminal_command(pointer, handle, command, value),
    )
  }

  public contextEmbeddedTerminalInvalidate(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
  ): void {
    this.contextTerminalCommand(context, terminal, 0)
  }

  public contextEmbeddedTerminalScroll(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
    delta: number,
  ): void {
    this.contextTerminalCommand(context, terminal, 1, delta)
  }

  public contextEmbeddedTerminalClearSelection(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
  ): void {
    this.contextTerminalCommand(context, terminal, 2)
  }

  public contextEmbeddedTerminalSetSelection(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, terminal)
    const sx = toSafeFFIU32Length(start.x, "Selection start x")
    const sy = toSafeFFIU32Length(start.y, "Selection start y")
    const ex = toSafeFFIU32Length(end.x, "Selection end x")
    const ey = toSafeFFIU32Length(end.y, "Selection end y")
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_set_selection")
    nativeResult(
      "ot_embedded_terminal_set_selection",
      this.opentui.symbols.ot_embedded_terminal_set_selection(pointer, handle, sx, sy, ex, ey),
    )
  }

  private contextTerminalBytes(
    operation: string,
    read: (output: Uint8Array | null, count: Uint32Array) => number,
  ): Uint8Array {
    const count = new Uint32Array(1)
    nativeResult(operation, read(null, count))
    const output = new Uint8Array(count[0])
    if (output.length) nativeResult(operation, read(output, count))
    return output.subarray(0, count[0])
  }

  public contextEmbeddedTerminalGetSelectedText(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
  ): Uint8Array {
    const handle = encodeContextHandle(context, terminal)
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_get_selected_text")
    return this.contextTerminalBytes("ot_embedded_terminal_get_selected_text", (output, count) =>
      this.opentui.symbols.ot_embedded_terminal_get_selected_text(pointer, handle, output, output?.length ?? 0, count),
    )
  }

  public contextEmbeddedTerminalCompose(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    x: number,
    y: number,
  ): void {
    const handle = encodeContextHandle(context, terminal)
    const destination = encodeContextHandle(context, target)
    const ticket = frame ? encodeSceneFrameRequest(context, frame) : null
    const column = embeddedTerminalI32(x, "Terminal composition x")
    const row = embeddedTerminalI32(y, "Terminal composition y")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_compose")
      nativeResult(
        "ot_embedded_terminal_compose",
        this.opentui.symbols.ot_embedded_terminal_compose(pointer, handle, destination, ticket, column, row),
      )
    })
  }

  public contextEmbeddedTerminalCursor(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
  ): EmbeddedTerminalCursor {
    const layout = nativeLayouts.ot_embedded_terminal_cursor
    const handle = encodeContextHandle(context, terminal)
    const record = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_cursor_get")
    nativeResult(
      "ot_embedded_terminal_cursor_get",
      this.opentui.symbols.ot_embedded_terminal_cursor_get(pointer, handle, record),
    )
    return {
      x: record[layout.fields.x.offset / 4],
      y: record[layout.fields.y.offset / 4],
      hasValue: record[layout.fields.has_value.offset / 4] !== 0,
      visible: record[layout.fields.visible.offset / 4] !== 0,
      blinking: record[layout.fields.blinking.offset / 4] !== 0,
      wideTail: record[layout.fields.wide_tail.offset / 4] !== 0,
      style:
        (["bar", "block", "underline", "block-hollow"] as const)[record[layout.fields.style.offset / 4]] ?? "block",
      ...(record[layout.fields.color_has_value.offset / 4]
        ? {
            color: {
              r: record[layout.fields.color_r.offset / 4],
              g: record[layout.fields.color_g.offset / 4],
              b: record[layout.fields.color_b.offset / 4],
            },
          }
        : {}),
    }
  }

  public contextEmbeddedTerminalEncodeKey(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
    key: EmbeddedTerminalKey,
  ): Uint8Array {
    const layout = nativeLayouts.ot_embedded_terminal_key
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, terminal)
    const action = key.action ?? "press"
    const actionCode = ["release", "press", "repeat"].indexOf(action)
    if (actionCode < 0) throw new TypeError("Unknown embedded terminal key action")
    const record = createContextRecord(layout)
    record[layout.fields.action.offset / 4] = actionCode
    record[layout.fields.composing.offset / 4] = toFFIBool(key.composing ?? false, "Key composing")
    record[layout.fields.mods.offset / 4] = toSafeFFIU32Length(key.mods ?? 0, "Key modifiers")
    record[layout.fields.consumed_mods.offset / 4] = toSafeFFIU32Length(key.consumedMods ?? 0, "Key consumed modifiers")
    record[layout.fields.unshifted_codepoint.offset / 4] = toSafeFFIU32Length(
      key.unshiftedCodepoint ?? 0,
      "Key codepoint",
    )
    const physical = this.encoder.encode(key.key ?? "")
    const text = this.encoder.encode(key.text ?? "")
    const physicalLength = toSafeFFIU32Length(physical.byteLength, "Key name bytes")
    const textLength = toSafeFFIU32Length(text.byteLength, "Key text bytes")
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_encode_key")
    return this.contextTerminalBytes("ot_embedded_terminal_encode_key", (output, count) =>
      this.opentui.symbols.ot_embedded_terminal_encode_key(
        pointer,
        handle,
        record,
        viewOrNull(physical),
        physicalLength,
        viewOrNull(text),
        textLength,
        output,
        output?.length ?? 0,
        count,
      ),
    )
  }

  public contextEmbeddedTerminalEncodeMouse(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
    mouse: EmbeddedTerminalMouse,
  ): Uint8Array {
    const layout = nativeLayouts.ot_embedded_terminal_mouse
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, terminal)
    const action = ["press", "release", "motion"].indexOf(mouse.action)
    const buttonName = mouse.button
    const button =
      buttonName === undefined
        ? -1
        : ["unknown", "left", "right", "middle", "four", "five", "six", "seven"].indexOf(buttonName)
    if (action < 0 || (buttonName !== undefined && button < 0))
      throw new TypeError("Unknown embedded terminal mouse action or button")
    const record = createContextRecord(layout)
    record[layout.fields.action.offset / 4] = action
    record[layout.fields.button.offset / 4] = button
    record[layout.fields.mods.offset / 4] = toSafeFFIU32Length(mouse.mods ?? 0, "Mouse modifiers")
    record[layout.fields.any_button_pressed.offset / 4] = toFFIBool(
      mouse.anyButtonPressed ?? false,
      "Mouse button pressed",
    )
    const coordinates = new Float32Array(record.buffer)
    coordinates[layout.fields.x.offset / 4] = toFFIF32(mouse.x, "Mouse x")
    coordinates[layout.fields.y.offset / 4] = toFFIF32(mouse.y, "Mouse y")
    const output = new Uint8Array(128)
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_encode_mouse")
    nativeResult(
      "ot_embedded_terminal_encode_mouse",
      this.opentui.symbols.ot_embedded_terminal_encode_mouse(pointer, handle, record, output, output.length, count),
    )
    return output.slice(0, count[0])
  }

  public contextEmbeddedTerminalEncodePaste(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
    input: Uint8Array,
  ): Uint8Array {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, terminal)
    const bytes = sessionBytes(input, "Terminal paste bytes")
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_encode_paste")
    return this.contextTerminalBytes("ot_embedded_terminal_encode_paste", (output, count) =>
      this.opentui.symbols.ot_embedded_terminal_encode_paste(
        pointer,
        handle,
        viewOrNull(bytes),
        bytes.length,
        output,
        output?.length ?? 0,
        count,
      ),
    )
  }

  public contextEmbeddedTerminalEncodeFocus(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
    focused: boolean,
  ): Uint8Array {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, terminal)
    const value = toFFIBool(focused, "Terminal focused")
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_encode_focus")
    return this.contextTerminalBytes("ot_embedded_terminal_encode_focus", (output, count) =>
      this.opentui.symbols.ot_embedded_terminal_encode_focus(
        pointer,
        handle,
        value,
        output,
        output?.length ?? 0,
        count,
      ),
    )
  }

  public contextEmbeddedTerminalDrainResponses(
    context: NativeContextHandle,
    terminal: ContextEmbeddedTerminalHandle,
  ): Uint8Array {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, terminal)
    const output = new Uint8Array(1024 * 1024)
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_embedded_terminal_drain_responses")
    let status = this.opentui.symbols.ot_embedded_terminal_drain_responses(
      pointer,
      handle,
      output,
      output.length,
      count,
    )
    if (status === NativeStatus.OutputBackpressure) {
      status = this.opentui.symbols.ot_embedded_terminal_drain_responses(pointer, handle, output, output.length, count)
    }
    nativeResult("ot_embedded_terminal_drain_responses", status)
    return output.slice(0, count[0])
  }

  public destroyContextTextBuffer(context: NativeContextHandle, text: ContextTextBufferHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, text)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_destroy")
    nativeResult("ot_text_buffer_destroy", this.opentui.symbols.ot_text_buffer_destroy(pointer, handle))
  }

  public createContextTextBufferView(
    context: NativeContextHandle,
    text: ContextTextBufferHandle,
  ): ContextTextBufferViewHandle {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, text)
    const output = new BigUint64Array(nativeLayouts.ot_handle.size / 8)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_view_create")
    nativeResult("ot_text_buffer_view_create", this.opentui.symbols.ot_text_buffer_view_create(pointer, handle, output))
    try {
      return decodeContextHandle(context, output) as ContextTextBufferViewHandle
    } catch (error) {
      this.opentui.symbols.ot_text_buffer_view_destroy(pointer, output)
      throw error
    }
  }

  public destroyContextTextBufferView(context: NativeContextHandle, view: ContextTextBufferViewHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, view)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_view_destroy")
    nativeResult("ot_text_buffer_view_destroy", this.opentui.symbols.ot_text_buffer_view_destroy(pointer, handle))
  }

  public contextTextBufferSetText(
    context: NativeContextHandle,
    text: ContextTextBufferHandle,
    bytes: Uint8Array,
  ): void {
    const handle = encodeContextHandle(context, text)
    const input = sessionBytes(bytes, "Text buffer text length")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_set_text")
      nativeResult(
        "ot_text_buffer_set_text",
        this.opentui.symbols.ot_text_buffer_set_text(pointer, handle, viewOrNull(input), input.length),
      )
    })
  }

  public contextTextBufferAppend(context: NativeContextHandle, text: ContextTextBufferHandle, bytes: Uint8Array): void {
    const handle = encodeContextHandle(context, text)
    const input = sessionBytes(bytes, "Text buffer append length")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_append")
      nativeResult(
        "ot_text_buffer_append",
        this.opentui.symbols.ot_text_buffer_append(pointer, handle, viewOrNull(input), input.length),
      )
    })
  }

  public contextTextBufferClear(context: NativeContextHandle, text: ContextTextBufferHandle, reset = false): void {
    const handle = encodeContextHandle(context, text)
    const value = toFFIBool(reset, "Text buffer reset")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_clear")
      nativeResult("ot_text_buffer_clear", this.opentui.symbols.ot_text_buffer_clear(pointer, handle, value))
    })
  }

  public contextTextBufferSetStyledText(
    context: NativeContextHandle,
    text: ContextTextBufferHandle,
    content: StyledText,
    beforeNative?: () => void,
  ): void {
    this.contextTextBufferSetEncodedStyledText(context, text, this.encodeTextBufferStyledText(content), beforeNative)
  }

  public encodeTextBufferStyledText(content: StyledText): NativeEncodedStyledText {
    return this.encodeSceneStyledText(content, true, true)
  }

  public contextTextBufferSetEncodedStyledText(
    context: NativeContextHandle,
    text: ContextTextBufferHandle,
    encoded: NativeEncodedStyledText,
    beforeNative?: () => void,
  ): void {
    const handle = encodeContextHandle(context, text)
    const { bytes, records, count, urlBytes } = encoded
    this.getYogaHost().runMutation(() => {
      beforeNative?.()
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_set_styled_text")
      nativeResult(
        "ot_text_buffer_set_styled_text",
        this.opentui.symbols.ot_text_buffer_set_styled_text(
          pointer,
          handle,
          viewOrNull(bytes),
          bytes.length,
          count === 0 ? null : records,
          count,
          viewOrNull(urlBytes),
          urlBytes.length,
        ),
      )
    })
  }

  public contextTextBufferReplaceStyledBatch(
    context: NativeContextHandle,
    replacements: {
      buffer: ContextTextBufferHandle
      view: ContextTextBufferViewHandle
      text: NativeEncodedStyledText
    }[],
    beforeNative: () => void,
  ): Uint32Array | null {
    const count = replacements.length
    if (count > nativeConstants.OT_TEXT_REPLACEMENT_COUNT_MAX) return null
    let byteCount = 0
    let chunkCount = 0
    let urlByteCount = 0
    for (const { text } of replacements) {
      byteCount += text.bytes.length
      chunkCount += text.count
      urlByteCount += text.urlBytes.length
    }
    if (
      byteCount > nativeConstants.OT_TEXT_REPLACEMENT_BYTES_MAX ||
      chunkCount > nativeConstants.OT_TEXT_REPLACEMENT_CHUNKS_MAX ||
      urlByteCount > nativeConstants.OT_TEXT_REPLACEMENT_URL_BYTES_MAX
    ) {
      return null
    }
    const layout = nativeLayouts.ot_text_buffer_replacement
    const chunkLayout = nativeLayouts.ot_scene_linked_text_chunk
    const records = new Uint32Array((count * layout.size) / 4)
    const handles = new BigUint64Array(records.buffer)
    const bytes = new Uint8Array(byteCount)
    const chunks = new Uint32Array((chunkCount * chunkLayout.size) / 4)
    const urls = new Uint8Array(urlByteCount)
    const output = new Uint32Array((count * nativeLayouts.ot_text_buffer_replacement_info.size) / 4)
    byteCount = 0
    chunkCount = 0
    urlByteCount = 0
    for (let index = 0; index < count; index++) {
      const { buffer, view, text } = replacements[index]
      const offset = (index * layout.size) / 4
      records[offset + layout.fields.struct_size.offset / 4] = layout.size
      records[offset + layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
      handles.set(encodeContextHandle(context, buffer), offset / 2 + layout.fields.buffer.offset / 8)
      handles.set(encodeContextHandle(context, view), offset / 2 + layout.fields.view.offset / 8)
      records[offset + layout.fields.byte_offset.offset / 4] = byteCount
      records[offset + layout.fields.byte_count.offset / 4] = text.bytes.length
      records[offset + layout.fields.chunk_offset.offset / 4] = chunkCount
      records[offset + layout.fields.chunk_count.offset / 4] = text.count
      bytes.set(text.bytes, byteCount)
      urls.set(text.urlBytes, urlByteCount)
      const chunkOffset = (chunkCount * chunkLayout.size) / 4
      chunks.set(text.records.subarray(0, (text.count * chunkLayout.size) / 4), chunkOffset)
      for (let chunk = 0; chunk < text.count; chunk++) {
        const start = chunkOffset + (chunk * chunkLayout.size) / 4
        if (chunks[start + chunkLayout.fields.flags.offset / 4] & nativeConstants.OT_SCENE_TEXT_LINK) {
          chunks[start + chunkLayout.fields.link_offset.offset / 4] += urlByteCount
        }
      }
      byteCount += text.bytes.length
      chunkCount += text.count
      urlByteCount += text.urlBytes.length
    }
    return this.getYogaHost().runMutation(() => {
      beforeNative()
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_replace_styled_batch")
      nativeResult(
        "ot_text_buffer_replace_styled_batch",
        this.opentui.symbols.ot_text_buffer_replace_styled_batch(
          pointer,
          records,
          count,
          bytes,
          byteCount,
          chunks,
          chunkCount,
          urls,
          urlByteCount,
          output,
        ),
      )
      return output
    })
  }

  public contextTextBufferSetSyntaxStyle(
    context: NativeContextHandle,
    text: ContextTextBufferHandle,
    style: ContextSyntaxStyleHandle | null,
  ): void {
    const handle = encodeContextHandle(context, text)
    const target = style === null ? null : encodeContextHandle(context, style)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_set_syntax_style")
      nativeResult(
        "ot_text_buffer_set_syntax_style",
        this.opentui.symbols.ot_text_buffer_set_syntax_style(pointer, handle, target),
      )
    })
  }

  public contextTextBufferGetInfo(context: NativeContextHandle, text: ContextTextBufferHandle): NativeTextBufferInfo {
    const layout = nativeLayouts.ot_text_buffer_info
    const handle = encodeContextHandle(context, text)
    const output = new BigUint64Array(layout.size / 8)
    const words = new Uint32Array(output.buffer)
    words[layout.fields.struct_size.offset / 4] = layout.size
    words[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_get_info")
    nativeResult("ot_text_buffer_get_info", this.opentui.symbols.ot_text_buffer_get_info(pointer, handle, output))
    return {
      contentEpoch: output[layout.fields.content_epoch.offset / 8],
      byteLength: words[layout.fields.byte_count.offset / 4],
      textLength: words[layout.fields.text_length.offset / 4],
      lineCount: words[layout.fields.line_count.offset / 4],
      highlightCount: words[layout.fields.highlight_count.offset / 4],
      tabWidth: words[layout.fields.tab_width.offset / 4],
    }
  }

  private readText(
    operation: string,
    count: Uint32Array,
    read: (bytes: Uint8Array | null, capacity: number, count: Uint32Array) => number,
    countMode: "exact" | "bounded" = "bounded",
    copyEmpty = false,
  ): string {
    nativeResult(operation, read(null, 0, count))
    if (count[0] === 0 && !copyEmpty) return ""
    const bytes = new Uint8Array(count[0])
    nativeResult(operation, read(viewOrNull(bytes), bytes.length, count))
    if (countMode === "exact" ? count[0] !== bytes.length : count[0] > bytes.length) {
      throw new NativeError(operation, NativeStatus.InternalError)
    }
    return this.decoder.decode(countMode === "exact" ? bytes : bytes.subarray(0, count[0]))
  }

  public contextTextBufferGetText(context: NativeContextHandle, text: ContextTextBufferHandle): string {
    const handle = encodeContextHandle(context, text)
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_get_text")
    return this.readText(
      "ot_text_buffer_get_text",
      count,
      (bytes, capacity, count) => this.opentui.symbols.ot_text_buffer_get_text(pointer, handle, bytes, capacity, count),
      "exact",
    )
  }

  public contextTextBufferGetRange(
    context: NativeContextHandle,
    text: ContextTextBufferHandle,
    start: number,
    end: number,
  ): string {
    const handle = encodeContextHandle(context, text)
    const startOffset = toSafeFFIU32Length(start, "Text range start")
    const endOffset = toSafeFFIU32Length(end, "Text range end")
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_get_range")
    return this.readText("ot_text_buffer_get_range", count, (bytes, capacity, count) =>
      this.opentui.symbols.ot_text_buffer_get_range(pointer, handle, startOffset, endOffset, bytes, capacity, count),
    )
  }

  public contextTextBufferSetDefaults(
    context: NativeContextHandle,
    text: ContextTextBufferHandle,
    mask: NativeEditorStyleMask,
    style: NativeEditorStyle,
  ): void {
    const handle = encodeContextHandle(context, text)
    const fields = toSafeFFIU32Length(mask, "Text default style mask")
    const record = encodeEditorStyle(style)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_set_defaults")
      nativeResult(
        "ot_text_buffer_set_defaults",
        this.opentui.symbols.ot_text_buffer_set_defaults(pointer, handle, fields, record),
      )
    })
  }

  public contextTextBufferSetTabWidth(
    context: NativeContextHandle,
    text: ContextTextBufferHandle,
    width: number,
  ): void {
    const handle = encodeContextHandle(context, text)
    const value = toSafeFFIU32Length(width, "Text tab width")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_set_tab_width")
      nativeResult(
        "ot_text_buffer_set_tab_width",
        this.opentui.symbols.ot_text_buffer_set_tab_width(pointer, handle, value),
      )
    })
  }

  public contextTextBufferHighlight(
    context: NativeContextHandle,
    text: ContextTextBufferHandle,
    operation: NativeEditHighlightOperation,
    argument = 0,
    highlight?: Highlight,
  ): void {
    const handle = encodeContextHandle(context, text)
    const selector = toSafeFFIU32Length(operation, "Text highlight operation")
    const value = toSafeFFIU32Length(argument, "Text highlight argument")
    const record = encodeContextHighlight(highlight)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_highlight")
      nativeResult(
        "ot_text_buffer_highlight",
        this.opentui.symbols.ot_text_buffer_highlight(pointer, handle, selector, value, record),
      )
    })
  }

  public contextTextBufferGetHighlights(
    context: NativeContextHandle,
    text: ContextTextBufferHandle,
    line: number,
  ): Highlight[] {
    const handle = encodeContextHandle(context, text)
    const row = toSafeFFIU32Length(line, "Highlight line")
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_get_highlights")
    nativeResult(
      "ot_text_buffer_get_highlights",
      this.opentui.symbols.ot_text_buffer_get_highlights(pointer, handle, row, null, 0, count),
    )
    if (count[0] === 0) return []
    const capacity = count[0]
    const records = new Uint32Array(capacity * (nativeLayouts.ot_edit_highlight.size / 4))
    nativeResult(
      "ot_text_buffer_get_highlights",
      this.opentui.symbols.ot_text_buffer_get_highlights(pointer, handle, row, records, capacity, count),
    )
    if (count[0] !== capacity) throw new NativeError("ot_text_buffer_get_highlights", NativeStatus.InternalError)
    return decodeContextHighlights(records)
  }

  public contextTextBufferViewSetViewport(
    context: NativeContextHandle,
    view: ContextTextBufferViewHandle,
    viewport: NativeEditorViewport,
    sizeOnly = false,
  ): void {
    const layout = nativeLayouts.ot_editor_viewport
    const handle = encodeContextHandle(context, view)
    const record = createContextRecord(layout)
    record[layout.fields.x.offset / 4] = toSafeFFIU32Length(viewport.x, "Text viewport x")
    record[layout.fields.y.offset / 4] = toSafeFFIU32Length(viewport.y, "Text viewport y")
    record[layout.fields.width.offset / 4] = toSafeFFIU32Length(viewport.width, "Text viewport width")
    record[layout.fields.height.offset / 4] = toSafeFFIU32Length(viewport.height, "Text viewport height")
    const resize = toFFIBool(sizeOnly, "Text viewport sizeOnly")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_view_set_viewport")
      nativeResult(
        "ot_text_buffer_view_set_viewport",
        this.opentui.symbols.ot_text_buffer_view_set_viewport(pointer, handle, record, resize),
      )
    })
  }

  public contextTextBufferViewCommand(
    context: NativeContextHandle,
    view: ContextTextBufferViewHandle,
    command: NativeTextViewCommand,
    argument: number,
  ): void {
    const handle = encodeContextHandle(context, view)
    const operation = toSafeFFIU32Length(command, "Text view command")
    const value = toSafeFFIU32Length(argument, "Text view command argument")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_view_command")
      nativeResult(
        "ot_text_buffer_view_command",
        this.opentui.symbols.ot_text_buffer_view_command(pointer, handle, operation, value),
      )
    })
  }

  public contextTextBufferViewSetTabColor(
    context: NativeContextHandle,
    view: ContextTextBufferViewHandle,
    color: RGBA | null,
  ): void {
    const handle = encodeContextHandle(context, view)
    const record = color === null ? null : contextBufferColor(color)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_view_set_tab_color")
      nativeResult(
        "ot_text_buffer_view_set_tab_color",
        this.opentui.symbols.ot_text_buffer_view_set_tab_color(pointer, handle, record),
      )
    })
  }

  public contextTextBufferViewSelect(
    context: NativeContextHandle,
    view: ContextTextBufferViewHandle,
    selection: NativeEditorSelection,
  ): boolean {
    const handle = encodeContextHandle(context, view)
    const record = encodeEditorSelection(selection)
    const changed = new Uint32Array(1)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_text_buffer_view_select")
      nativeResult(
        "ot_text_buffer_view_select",
        this.opentui.symbols.ot_text_buffer_view_select(pointer, handle, record, changed),
      )
    })
    return changed[0] !== 0
  }

  public contextTextBufferViewGetInfo(
    context: NativeContextHandle,
    view: ContextTextBufferViewHandle,
  ): NativeEditorViewInfo {
    const layout = nativeLayouts.ot_editor_view_info
    const handle = encodeContextHandle(context, view)
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_view_get_info")
    nativeResult(
      "ot_text_buffer_view_get_info",
      this.opentui.symbols.ot_text_buffer_view_get_info(pointer, handle, output),
    )
    return {
      virtualLineCount: output[layout.fields.virtual_line_count.offset / 4],
      totalVirtualLineCount: output[layout.fields.total_virtual_line_count.offset / 4],
      selection:
        output[layout.fields.selection_present.offset / 4] === 0
          ? null
          : {
              start: output[layout.fields.selection_start.offset / 4],
              end: output[layout.fields.selection_end.offset / 4],
            },
      selectionOccupancy: output[layout.fields.selection_occupancy.offset / 4] === 0 ? "cell" : "boundary",
    }
  }

  public contextTextBufferViewGetSelectedText(context: NativeContextHandle, view: ContextTextBufferViewHandle): string {
    const handle = encodeContextHandle(context, view)
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_view_get_selected_text")
    return this.readText("ot_text_buffer_view_get_selected_text", count, (bytes, capacity, count) =>
      this.opentui.symbols.ot_text_buffer_view_get_selected_text(pointer, handle, bytes, capacity, count),
    )
  }

  public contextTextBufferViewGetLines(
    context: NativeContextHandle,
    view: ContextTextBufferViewHandle,
    logical = false,
  ): LineInfo {
    const layout = nativeLayouts.ot_editor_measure
    const handle = encodeContextHandle(context, view)
    const mode = toFFIBool(logical, "Text logical lines")
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_view_get_lines")
    nativeResult(
      "ot_text_buffer_view_get_lines",
      this.opentui.symbols.ot_text_buffer_view_get_lines(pointer, handle, mode, null, 0, output),
    )
    const count = output[layout.fields.line_count.offset / 4]
    const lines = new Uint32Array(count * (nativeLayouts.ot_scene_text_line.size / 4))
    if (count !== 0) {
      nativeResult(
        "ot_text_buffer_view_get_lines",
        this.opentui.symbols.ot_text_buffer_view_get_lines(pointer, handle, mode, lines, count, output),
      )
      if (output[layout.fields.line_count.offset / 4] !== count)
        throw new NativeError("ot_text_buffer_view_get_lines", NativeStatus.InternalError)
    }
    return decodeContextTextLines(lines, output[layout.fields.width_cols_max.offset / 4])
  }

  public contextTextBufferViewMeasure(
    context: NativeContextHandle,
    view: ContextTextBufferViewHandle,
    width: number,
    height: number,
  ): MeasureResult {
    const layout = nativeLayouts.ot_editor_measure
    const handle = encodeContextHandle(context, view)
    const columns = toSafeFFIU32Length(width, "Text measure width")
    const rows = toSafeFFIU32Length(height, "Text measure height")
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_text_buffer_view_measure")
    nativeResult(
      "ot_text_buffer_view_measure",
      this.opentui.symbols.ot_text_buffer_view_measure(pointer, handle, columns, rows, output),
    )
    return {
      lineCount: output[layout.fields.line_count.offset / 4],
      widthColsMax: output[layout.fields.width_cols_max.offset / 4],
    }
  }

  public sceneSetTextView(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    view: ContextTextBufferViewHandle | null,
  ): void {
    const handle = encodeContextHandle(context, node)
    const source = view === null ? null : encodeContextHandle(context, view)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_scene_set_text_view")
      nativeResult("ot_scene_set_text_view", this.opentui.symbols.ot_scene_set_text_view(pointer, handle, source))
    })
  }

  public sceneSetTextViewPaint(context: NativeContextHandle, node: SceneNodeHandle, enabled: boolean): void {
    const handle = encodeContextHandle(context, node)
    const value = toFFIBool(enabled, "Text view paint enabled")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_scene_set_text_view_paint")
      nativeResult(
        "ot_scene_set_text_view_paint",
        this.opentui.symbols.ot_scene_set_text_view_paint(pointer, handle, value),
      )
    })
  }

  public sceneSelectTextViewPaint(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    frame: NativeSceneFrameRequest,
    enabled: boolean,
  ): void {
    const handle = encodeContextHandle(context, node)
    const request = encodeSceneFrameRequest(context, frame)
    const value = toFFIBool(enabled, "Text view native paint selected")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_scene_select_text_view_paint")
      nativeResult(
        "ot_scene_select_text_view_paint",
        this.opentui.symbols.ot_scene_select_text_view_paint(pointer, handle, request, value),
      )
    })
  }

  public contextDrawTextBufferView(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    view: ContextTextBufferViewHandle,
    x: number,
    y: number,
  ): void {
    this.getYogaHost().assertMutable()
    const destination = encodeContextHandle(context, target)
    const request = frame === null ? null : encodeSceneFrameRequest(context, frame)
    const source = encodeContextHandle(context, view)
    // Node FFI rejects negative zero for integer arguments.
    const column = embeddedTerminalI32(x, "text view x") || 0
    const row = embeddedTerminalI32(y, "text view y") || 0
    const pointer = this.nativeContextPointer(context, "ot_buffer_draw_text_view")
    nativeResult(
      "ot_buffer_draw_text_view",
      this.opentui.symbols.ot_buffer_draw_text_view(pointer, destination, request, source, column, row),
    )
  }

  public contextDrawEditorView(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    view: ContextEditorViewHandle,
    x: number,
    y: number,
  ): void {
    this.getYogaHost().assertMutable()
    const destination = encodeContextHandle(context, target)
    const request = frame === null ? null : encodeSceneFrameRequest(context, frame)
    const source = encodeContextHandle(context, view)
    const column = embeddedTerminalI32(x, "editor view x") || 0
    const row = embeddedTerminalI32(y, "editor view y") || 0
    const pointer = this.nativeContextPointer(context, "ot_buffer_draw_editor_view")
    nativeResult(
      "ot_buffer_draw_editor_view",
      this.opentui.symbols.ot_buffer_draw_editor_view(pointer, destination, request, source, column, row),
    )
  }

  public contextDrawSceneText(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    node: SceneNodeHandle,
    x: number,
    y: number,
  ): void {
    this.getYogaHost().assertMutable()
    const destination = encodeContextHandle(context, target)
    const request = frame === null ? null : encodeSceneFrameRequest(context, frame)
    const source = encodeContextHandle(context, node)
    const column = embeddedTerminalI32(x, "scene text x") || 0
    const row = embeddedTerminalI32(y, "scene text y") || 0
    const pointer = this.nativeContextPointer(context, "ot_buffer_draw_scene_text")
    nativeResult(
      "ot_buffer_draw_scene_text",
      this.opentui.symbols.ot_buffer_draw_scene_text(pointer, destination, request, source, column, row),
    )
  }

  public createContextEditBuffer(
    context: NativeContextHandle,
    options: NativeContextEditBufferOptions = {},
  ): ContextEditBufferHandle {
    const layout = nativeLayouts.ot_edit_buffer_options
    this.getYogaHost().assertMutable()
    const widthMethod = options.widthMethod ?? "unicode"
    if (
      widthMethod !== "wcwidth" &&
      widthMethod !== "unicode" &&
      widthMethod !== "no-zwj" &&
      widthMethod !== "unicode-wide"
    ) {
      throw new TypeError("Unknown Context editor width method")
    }
    const record = createContextRecord(layout)
    record[layout.fields.width_method.offset / 4] = widthMethod === "no-zwj" ? 2 : widthMethodCode(widthMethod)
    const output = new BigUint64Array(nativeLayouts.ot_handle.size / 8)
    const pointer = this.nativeContextPointer(context, "ot_edit_buffer_create")
    nativeResult("ot_edit_buffer_create", this.opentui.symbols.ot_edit_buffer_create(pointer, record, output))
    try {
      return decodeContextHandle(context, output) as ContextEditBufferHandle
    } catch (error) {
      this.opentui.symbols.ot_edit_buffer_destroy(pointer, output)
      throw error
    }
  }

  public destroyContextEditBuffer(context: NativeContextHandle, editBuffer: ContextEditBufferHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, editBuffer)
    const slot = new Uint32Array(handle.buffer)[nativeLayouts.ot_handle.fields.slot.offset / 4]
    const pointer = this.nativeContextPointer(context, "ot_edit_buffer_destroy")
    nativeResult("ot_edit_buffer_destroy", this.opentui.symbols.ot_edit_buffer_destroy(pointer, handle))
    const buffers = this.contextEditEvents.get(context)?.buffers
    buffers?.get(slot)?.listeners.clear()
    buffers?.delete(slot)
  }

  public createContextEditorView(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    width: number,
    height: number,
  ): ContextEditorViewHandle {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, editBuffer)
    const columns = toSafeFFIU32Length(width, "Editor view width")
    const rows = toSafeFFIU32Length(height, "Editor view height")
    const output = new BigUint64Array(nativeLayouts.ot_handle.size / 8)
    const pointer = this.nativeContextPointer(context, "ot_editor_view_create")
    nativeResult(
      "ot_editor_view_create",
      this.opentui.symbols.ot_editor_view_create(pointer, handle, columns, rows, output),
    )
    try {
      return decodeContextHandle(context, output) as ContextEditorViewHandle
    } catch (error) {
      this.opentui.symbols.ot_editor_view_destroy(pointer, output)
      throw error
    }
  }

  public destroyContextEditorView(context: NativeContextHandle, view: ContextEditorViewHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, view)
    const pointer = this.nativeContextPointer(context, "ot_editor_view_destroy")
    nativeResult("ot_editor_view_destroy", this.opentui.symbols.ot_editor_view_destroy(pointer, handle))
  }

  public createContextSyntaxStyle(context: NativeContextHandle): ContextSyntaxStyleHandle {
    this.getYogaHost().assertMutable()
    const output = new BigUint64Array(nativeLayouts.ot_handle.size / 8)
    const pointer = this.nativeContextPointer(context, "ot_syntax_style_create")
    nativeResult("ot_syntax_style_create", this.opentui.symbols.ot_syntax_style_create(pointer, output))
    try {
      return decodeContextHandle(context, output) as ContextSyntaxStyleHandle
    } catch (error) {
      this.opentui.symbols.ot_syntax_style_destroy(pointer, output)
      throw error
    }
  }

  public destroyContextSyntaxStyle(context: NativeContextHandle, style: ContextSyntaxStyleHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, style)
    const pointer = this.nativeContextPointer(context, "ot_syntax_style_destroy")
    nativeResult("ot_syntax_style_destroy", this.opentui.symbols.ot_syntax_style_destroy(pointer, handle))
  }

  public contextEditBufferSetSyntaxStyle(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    style: ContextSyntaxStyleHandle | null,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, editBuffer)
    const target = style === null ? null : encodeContextHandle(context, style)
    const pointer = this.nativeContextPointer(context, "ot_edit_buffer_set_syntax_style")
    nativeResult(
      "ot_edit_buffer_set_syntax_style",
      this.opentui.symbols.ot_edit_buffer_set_syntax_style(pointer, handle, target),
    )
  }

  public contextEditBufferSetText(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    bytes: Uint8Array,
    preserveHistory = false,
  ): void {
    const handle = encodeContextHandle(context, editBuffer)
    const input = sessionBytes(bytes, "Edit buffer text length")
    const preserve = toFFIBool(preserveHistory, "Edit buffer preserveHistory")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_edit_buffer_set_text")
      nativeResult(
        "ot_edit_buffer_set_text",
        this.opentui.symbols.ot_edit_buffer_set_text(pointer, handle, viewOrNull(input), input.length, preserve),
      )
    })
  }

  public contextEditBufferInsertText(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    bytes: Uint8Array,
  ): void {
    const handle = encodeContextHandle(context, editBuffer)
    const input = sessionBytes(bytes, "Edit buffer insert length")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_edit_buffer_insert_text")
      nativeResult(
        "ot_edit_buffer_insert_text",
        this.opentui.symbols.ot_edit_buffer_insert_text(pointer, handle, viewOrNull(input), input.length),
      )
    })
  }

  public contextEditBufferDeleteRange(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): void {
    const handle = encodeContextHandle(context, editBuffer)
    const rowStart = toSafeFFIU32Length(startRow, "Edit buffer start row")
    const colStart = toSafeFFIU32Length(startCol, "Edit buffer start column")
    const rowEnd = toSafeFFIU32Length(endRow, "Edit buffer end row")
    const colEnd = toSafeFFIU32Length(endCol, "Edit buffer end column")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_edit_buffer_delete_range")
      nativeResult(
        "ot_edit_buffer_delete_range",
        this.opentui.symbols.ot_edit_buffer_delete_range(pointer, handle, rowStart, colStart, rowEnd, colEnd),
      )
    })
  }

  public contextEditBufferSetCursor(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    row: number,
    col: number,
  ): void {
    const handle = encodeContextHandle(context, editBuffer)
    const cursorRow = toSafeFFIU32Length(row, "Edit buffer cursor row")
    const cursorCol = toSafeFFIU32Length(col, "Edit buffer cursor column")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_edit_buffer_set_cursor")
      nativeResult(
        "ot_edit_buffer_set_cursor",
        this.opentui.symbols.ot_edit_buffer_set_cursor(pointer, handle, cursorRow, cursorCol),
      )
    })
  }

  public contextEditBufferGetText(context: NativeContextHandle, editBuffer: ContextEditBufferHandle): string {
    const handle = encodeContextHandle(context, editBuffer)
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_edit_buffer_get_text")
    return this.readText(
      "ot_edit_buffer_get_text",
      count,
      (bytes, capacity, count) => this.opentui.symbols.ot_edit_buffer_get_text(pointer, handle, bytes, capacity, count),
      "exact",
      true,
    )
  }

  public contextEditBufferGetInfo(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
  ): NativeEditBufferInfo {
    const layout = nativeLayouts.ot_edit_buffer_info
    const handle = encodeContextHandle(context, editBuffer)
    const output = new BigUint64Array(layout.size / 8)
    const words = new Uint32Array(output.buffer)
    words[layout.fields.struct_size.offset / 4] = layout.size
    words[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    const pointer = this.nativeContextPointer(context, "ot_edit_buffer_get_info")
    nativeResult("ot_edit_buffer_get_info", this.opentui.symbols.ot_edit_buffer_get_info(pointer, handle, output))
    return {
      contentEpoch: output[layout.fields.content_epoch.offset / 8],
      byteLength: words[layout.fields.byte_count.offset / 4],
      lineCount: words[layout.fields.line_count.offset / 4],
      cursor: {
        row: words[layout.fields.cursor_row.offset / 4],
        col: words[layout.fields.cursor_col.offset / 4],
        offset: words[layout.fields.cursor_offset.offset / 4],
      },
      canUndo: words[layout.fields.can_undo.offset / 4] !== 0,
      canRedo: words[layout.fields.can_redo.offset / 4] !== 0,
      tabWidth: words[layout.fields.tab_width.offset / 4],
    }
  }

  public contextEditBufferSetTabWidth(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    width: number,
  ): void {
    const handle = encodeContextHandle(context, editBuffer)
    const value = toSafeFFIU32Length(width, "Edit buffer tab width")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_edit_buffer_set_tab_width")
      nativeResult(
        "ot_edit_buffer_set_tab_width",
        this.opentui.symbols.ot_edit_buffer_set_tab_width(pointer, handle, value),
      )
    })
  }

  public contextEditBufferCommand(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    command: NativeEditCommand,
    argument = 0,
  ): void {
    const handle = encodeContextHandle(context, editBuffer)
    const operation = toSafeFFIU32Length(command, "Edit buffer command")
    const value = toSafeFFIU32Length(argument, "Edit buffer command argument")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_edit_buffer_command")
      nativeResult(
        "ot_edit_buffer_command",
        this.opentui.symbols.ot_edit_buffer_command(pointer, handle, operation, value),
      )
    })
  }

  public contextEditBufferHistory(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    redo: boolean,
  ): string | null {
    const handle = encodeContextHandle(context, editBuffer)
    const direction = toFFIBool(redo, "Edit buffer redo")
    // History mutates on each call; the ABI bounds cursor metadata at 64 bytes.
    const bytes = new Uint8Array(64)
    const count = new Uint32Array(1)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_edit_buffer_history")
      nativeResult(
        "ot_edit_buffer_history",
        this.opentui.symbols.ot_edit_buffer_history(pointer, handle, direction, bytes, bytes.length, count),
      )
    })
    if (count[0] > bytes.length) throw new NativeError("ot_edit_buffer_history", NativeStatus.InternalError)
    return count[0] === 0 ? null : this.decoder.decode(bytes.subarray(0, count[0]))
  }

  public contextEditBufferGetPosition(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    query: NativeEditPositionQuery,
    a = 0,
    b = 0,
  ): LogicalCursor | null {
    const layout = nativeLayouts.ot_edit_position
    const handle = encodeContextHandle(context, editBuffer)
    const selector = toSafeFFIU32Length(query, "Edit buffer position query")
    const first = toSafeFFIU32Length(a, "Edit buffer position argument")
    const second = toSafeFFIU32Length(b, "Edit buffer position column")
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_edit_buffer_get_position")
    nativeResult(
      "ot_edit_buffer_get_position",
      this.opentui.symbols.ot_edit_buffer_get_position(pointer, handle, selector, first, second, output),
    )
    return output[layout.fields.valid.offset / 4] === 0
      ? null
      : {
          row: output[layout.fields.row.offset / 4],
          col: output[layout.fields.col.offset / 4],
          offset: output[layout.fields.offset.offset / 4],
        }
  }

  public contextEditBufferGetRange(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    byCoords: boolean,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): string {
    const handle = encodeContextHandle(context, editBuffer)
    const coords = toFFIBool(byCoords, "Edit buffer range byCoords")
    const rowStart = toSafeFFIU32Length(startRow, "Edit buffer range start row")
    const colStart = toSafeFFIU32Length(startCol, "Edit buffer range start column")
    const rowEnd = toSafeFFIU32Length(endRow, "Edit buffer range end row")
    const colEnd = toSafeFFIU32Length(endCol, "Edit buffer range end column")
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_edit_buffer_get_range")
    return this.readText("ot_edit_buffer_get_range", count, (bytes, capacity, count) =>
      this.opentui.symbols.ot_edit_buffer_get_range(
        pointer,
        handle,
        coords,
        rowStart,
        colStart,
        rowEnd,
        colEnd,
        bytes,
        capacity,
        count,
      ),
    )
  }

  public contextEditBufferSetDefaults(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    mask: NativeEditorStyleMask,
    style: NativeEditorStyle,
  ): void {
    const handle = encodeContextHandle(context, editBuffer)
    const fields = toSafeFFIU32Length(mask, "Editor default style mask")
    const record = encodeEditorStyle(style)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_edit_buffer_set_defaults")
      nativeResult(
        "ot_edit_buffer_set_defaults",
        this.opentui.symbols.ot_edit_buffer_set_defaults(pointer, handle, fields, record),
      )
    })
  }

  public contextSyntaxStyleRegister(
    context: NativeContextHandle,
    style: ContextSyntaxStyleHandle,
    name: string,
    definition: NativeEditorStyle,
  ): number {
    const handle = encodeContextHandle(context, style)
    if (typeof name !== "string") throw new TypeError("Syntax style name must be a string")
    const bytes = this.encoder.encode(name)
    const length = toSafeFFIU32Length(bytes.length, "Syntax style name length")
    const record = encodeEditorStyle(definition)
    const output = new Uint32Array(1)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_syntax_style_register")
      nativeResult(
        "ot_syntax_style_register",
        this.opentui.symbols.ot_syntax_style_register(pointer, handle, viewOrNull(bytes), length, record, output),
      )
    })
    return output[0]
  }

  public contextSyntaxStyleResolveByName(
    context: NativeContextHandle,
    style: ContextSyntaxStyleHandle,
    name: string,
  ): number | null {
    const handle = encodeContextHandle(context, style)
    if (typeof name !== "string") throw new TypeError("Syntax style name must be a string")
    const bytes = sessionBytes(this.encoder.encode(name), "Syntax style name length")
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_syntax_style_resolve")
    nativeResult(
      "ot_syntax_style_resolve",
      this.opentui.symbols.ot_syntax_style_resolve(pointer, handle, viewOrNull(bytes), bytes.length, output),
    )
    return output[0] || null
  }

  public contextSyntaxStyleGetStyleCount(context: NativeContextHandle, style: ContextSyntaxStyleHandle): number {
    const handle = encodeContextHandle(context, style)
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_syntax_style_get_count")
    nativeResult("ot_syntax_style_get_count", this.opentui.symbols.ot_syntax_style_get_count(pointer, handle, output))
    return output[0]
  }

  public contextEditBufferHighlight(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    operation: NativeEditHighlightOperation,
    argument = 0,
    highlight?: Highlight,
  ): void {
    const handle = encodeContextHandle(context, editBuffer)
    const selector = toSafeFFIU32Length(operation, "Edit buffer highlight operation")
    const value = toSafeFFIU32Length(argument, "Edit buffer highlight argument")
    const record = encodeContextHighlight(highlight)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_edit_buffer_highlight")
      nativeResult(
        "ot_edit_buffer_highlight",
        this.opentui.symbols.ot_edit_buffer_highlight(pointer, handle, selector, value, record),
      )
    })
  }

  public contextEditBufferGetHighlights(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    line: number,
  ): Highlight[] {
    const handle = encodeContextHandle(context, editBuffer)
    const row = toSafeFFIU32Length(line, "Highlight line")
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_edit_buffer_get_highlights")
    nativeResult(
      "ot_edit_buffer_get_highlights",
      this.opentui.symbols.ot_edit_buffer_get_highlights(pointer, handle, row, null, 0, count),
    )
    if (count[0] === 0) return []
    const capacity = count[0]
    const records = new Uint32Array(capacity * (nativeLayouts.ot_edit_highlight.size / 4))
    nativeResult(
      "ot_edit_buffer_get_highlights",
      this.opentui.symbols.ot_edit_buffer_get_highlights(pointer, handle, row, records, capacity, count),
    )
    if (count[0] !== capacity) throw new NativeError("ot_edit_buffer_get_highlights", NativeStatus.InternalError)
    return decodeContextHighlights(records)
  }

  public contextEditorViewSetViewport(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    viewport: NativeEditorViewport,
    sizeOnly = false,
    moveCursor = false,
  ): void {
    const layout = nativeLayouts.ot_editor_viewport
    const handle = encodeContextHandle(context, view)
    const record = createContextRecord(layout)
    record[layout.fields.x.offset / 4] = toSafeFFIU32Length(viewport.x, "Editor viewport x")
    record[layout.fields.y.offset / 4] = toSafeFFIU32Length(viewport.y, "Editor viewport y")
    record[layout.fields.width.offset / 4] = toSafeFFIU32Length(viewport.width, "Editor viewport width")
    record[layout.fields.height.offset / 4] = toSafeFFIU32Length(viewport.height, "Editor viewport height")
    const resize = toFFIBool(sizeOnly, "Editor viewport sizeOnly")
    const move = toFFIBool(moveCursor, "Editor viewport moveCursor")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_editor_view_set_viewport")
      nativeResult(
        "ot_editor_view_set_viewport",
        this.opentui.symbols.ot_editor_view_set_viewport(pointer, handle, record, resize, move),
      )
    })
  }

  public contextEditorViewGetViewport(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
  ): NativeEditorViewport {
    const layout = nativeLayouts.ot_editor_viewport
    const handle = encodeContextHandle(context, view)
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_editor_view_get_viewport")
    nativeResult(
      "ot_editor_view_get_viewport",
      this.opentui.symbols.ot_editor_view_get_viewport(pointer, handle, output),
    )
    return {
      x: output[layout.fields.x.offset / 4],
      y: output[layout.fields.y.offset / 4],
      width: output[layout.fields.width.offset / 4],
      height: output[layout.fields.height.offset / 4],
    }
  }

  public contextEditorViewSetScrollMargin(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    margin: number,
  ): void {
    const handle = encodeContextHandle(context, view)
    const value = toFFIF32(margin, "Editor scroll margin")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_editor_view_set_scroll_margin")
      nativeResult(
        "ot_editor_view_set_scroll_margin",
        this.opentui.symbols.ot_editor_view_set_scroll_margin(pointer, handle, value),
      )
    })
  }

  public contextEditorViewCommand(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    command: NativeEditorCommand,
    argument = 0,
  ): void {
    const handle = encodeContextHandle(context, view)
    const operation = toSafeFFIU32Length(command, "Editor view command")
    const value = toSafeFFIU32Length(argument, "Editor view command argument")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_editor_view_command")
      nativeResult(
        "ot_editor_view_command",
        this.opentui.symbols.ot_editor_view_command(pointer, handle, operation, value),
      )
    })
  }

  public contextEditorViewReplaceSelection(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    bytes: Uint8Array,
  ): NativeEditorReplacement {
    const handle = encodeContextHandle(context, view)
    const input = sessionBytes(bytes, "Editor replacement length")
    const output = new Uint32Array(1)
    return this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_editor_view_replace_selection")
      nativeResult(
        "ot_editor_view_replace_selection",
        this.opentui.symbols.ot_editor_view_replace_selection(pointer, handle, viewOrNull(input), input.length, output),
      )
      return { deleted: (output[0] & 1) !== 0, inserted: (output[0] & 2) !== 0 }
    })
  }

  public contextEditorViewSetTabColor(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    color: RGBA | null,
  ): void {
    const handle = encodeContextHandle(context, view)
    const record = color === null ? null : contextBufferColor(color)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_editor_view_set_tab_color")
      nativeResult(
        "ot_editor_view_set_tab_color",
        this.opentui.symbols.ot_editor_view_set_tab_color(pointer, handle, record),
      )
    })
  }

  public contextEditorViewSelect(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    selection: NativeEditorSelection,
  ): boolean {
    const handle = encodeContextHandle(context, view)
    const record = encodeEditorSelection(selection)
    const changed = new Uint32Array(1)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_editor_view_select")
      nativeResult(
        "ot_editor_view_select",
        this.opentui.symbols.ot_editor_view_select(pointer, handle, record, changed),
      )
    })
    return changed[0] !== 0
  }

  public contextEditorViewGetInfo(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    followCursor = false,
  ): NativeEditorViewInfo {
    const layout = nativeLayouts.ot_editor_view_info
    const handle = encodeContextHandle(context, view)
    const follow = toFFIBool(followCursor, "Editor followCursor")
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_editor_view_get_info")
    nativeResult(
      "ot_editor_view_get_info",
      this.opentui.symbols.ot_editor_view_get_info(pointer, handle, follow, output),
    )
    return {
      virtualLineCount: output[layout.fields.virtual_line_count.offset / 4],
      totalVirtualLineCount: output[layout.fields.total_virtual_line_count.offset / 4],
      selection:
        output[layout.fields.selection_present.offset / 4] === 0
          ? null
          : {
              start: output[layout.fields.selection_start.offset / 4],
              end: output[layout.fields.selection_end.offset / 4],
            },
      selectionOccupancy: output[layout.fields.selection_occupancy.offset / 4] === 0 ? "cell" : "boundary",
    }
  }

  public contextEditorViewGetSelection(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
  ): Pick<NativeEditorViewInfo, "selection" | "selectionOccupancy"> {
    const layout = nativeLayouts.ot_editor_view_info
    const handle = encodeContextHandle(context, view)
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_editor_view_get_selection")
    nativeResult(
      "ot_editor_view_get_selection",
      this.opentui.symbols.ot_editor_view_get_selection(pointer, handle, output),
    )
    return {
      selection:
        output[layout.fields.selection_present.offset / 4] === 0
          ? null
          : {
              start: output[layout.fields.selection_start.offset / 4],
              end: output[layout.fields.selection_end.offset / 4],
            },
      selectionOccupancy: output[layout.fields.selection_occupancy.offset / 4] === 0 ? "cell" : "boundary",
    }
  }

  public contextEditorViewGetSelectedText(context: NativeContextHandle, view: ContextEditorViewHandle): string {
    const handle = encodeContextHandle(context, view)
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_editor_view_get_selected_text")
    return this.readText("ot_editor_view_get_selected_text", count, (bytes, capacity, count) =>
      this.opentui.symbols.ot_editor_view_get_selected_text(pointer, handle, bytes, capacity, count),
    )
  }

  public contextEditorViewGetPosition(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    query: NativeEditorPositionQuery,
  ): VisualCursor {
    const layout = nativeLayouts.ot_editor_position
    const handle = encodeContextHandle(context, view)
    const selector = toSafeFFIU32Length(query, "Editor position query")
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_editor_view_get_position")
    nativeResult(
      "ot_editor_view_get_position",
      this.opentui.symbols.ot_editor_view_get_position(pointer, handle, selector, output),
    )
    return {
      visualRow: output[layout.fields.visual_row.offset / 4],
      visualCol: output[layout.fields.visual_col.offset / 4],
      logicalRow: output[layout.fields.logical_row.offset / 4],
      logicalCol: output[layout.fields.logical_col.offset / 4],
      offset: output[layout.fields.offset.offset / 4],
    }
  }

  public contextEditorViewGetLines(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    logical = false,
  ): LineInfo {
    const layout = nativeLayouts.ot_editor_measure
    const handle = encodeContextHandle(context, view)
    const mode = toFFIBool(logical, "Editor logical lines")
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_editor_view_get_lines")
    nativeResult(
      "ot_editor_view_get_lines",
      this.opentui.symbols.ot_editor_view_get_lines(pointer, handle, mode, null, 0, output),
    )
    const count = output[layout.fields.line_count.offset / 4]
    const lines = new Uint32Array(count * (nativeLayouts.ot_scene_text_line.size / 4))
    if (count !== 0) {
      nativeResult(
        "ot_editor_view_get_lines",
        this.opentui.symbols.ot_editor_view_get_lines(pointer, handle, mode, lines, count, output),
      )
      if (output[layout.fields.line_count.offset / 4] !== count)
        throw new NativeError("ot_editor_view_get_lines", NativeStatus.InternalError)
    }
    return decodeContextTextLines(lines, output[layout.fields.width_cols_max.offset / 4])
  }

  public contextEditorViewMeasure(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    width: number,
    height: number,
  ): MeasureResult {
    const layout = nativeLayouts.ot_editor_measure
    const handle = encodeContextHandle(context, view)
    const columns = toSafeFFIU32Length(width, "Editor measure width")
    const rows = toSafeFFIU32Length(height, "Editor measure height")
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_editor_view_measure")
    nativeResult(
      "ot_editor_view_measure",
      this.opentui.symbols.ot_editor_view_measure(pointer, handle, columns, rows, output),
    )
    return {
      lineCount: output[layout.fields.line_count.offset / 4],
      widthColsMax: output[layout.fields.width_cols_max.offset / 4],
    }
  }

  public contextEditorViewSetPlaceholder(
    context: NativeContextHandle,
    view: ContextEditorViewHandle,
    content: StyledText,
  ): void {
    const handle = encodeContextHandle(context, view)
    const { bytes, records, count } = this.encodeSceneStyledText(content, false)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_editor_view_set_placeholder")
      nativeResult(
        "ot_editor_view_set_placeholder",
        this.opentui.symbols.ot_editor_view_set_placeholder(
          pointer,
          handle,
          viewOrNull(bytes),
          bytes.length,
          count === 0 ? null : records,
          count,
        ),
      )
    })
  }

  public onContextEditEvent(
    context: NativeContextHandle,
    editBuffer: ContextEditBufferHandle,
    handler: (event: NativeEditEventName) => void,
  ): () => void {
    this.getYogaHost().assertMutable()
    if (typeof handler !== "function") throw new TypeError("Edit event handler must be a function")
    const handle = decodeContextHandle(context, encodeContextHandle(context, editBuffer)) as ContextEditBufferHandle
    this.contextEditBufferGetInfo(context, handle)
    let registration = this.contextEditEvents.get(context)
    if (!registration) {
      const buffers = new Map<
        number,
        { handle: ContextEditBufferHandle; listeners: Set<{ handler: (event: NativeEditEventName) => void }> }
      >()
      const callback = this.opentui.createCallback(
        (contextId: bigint, slot: number, generation: number, event: number) => {
          this.getYogaHost().invokeCallback(() => {
            const entry = buffers.get(slot)
            if (!entry || entry.handle.contextId !== contextId || entry.handle.generation !== generation) return
            const name: NativeEditEventName =
              event === NativeEditEvent.CursorChanged
                ? "cursor-changed"
                : event === NativeEditEvent.ContentChanged
                  ? "content-changed"
                  : "cursorChanged"
            if (
              event !== NativeEditEvent.CursorChanged &&
              event !== NativeEditEvent.ContentChanged &&
              event !== NativeEditEvent.HistoryCursorChanged
            ) {
              throw new Error("Native editor returned an unknown event")
            }
            const listeners = [...entry.listeners]
            // Do not batch events: application microtasks can occur between native edits.
            queueMicrotask(() => {
              for (const listener of listeners) {
                if (!this.nativeContexts.has(context) || buffers.get(slot) !== entry) return
                if (entry.listeners.has(listener)) listener.handler(name)
              }
            })
          })
        },
        nativeCallbacks.ot_edit_event_callback,
      )
      try {
        if (!callback.ptr) throw new Error("Failed to create native edit event callback")
        registration = { callback, buffers }
        this.contextEditEvents.set(context, registration)
        const pointer = this.nativeContextPointer(context, "ot_context_set_edit_event_callback")
        nativeResult(
          "ot_context_set_edit_event_callback",
          this.opentui.symbols.ot_context_set_edit_event_callback(pointer, callback.ptr),
        )
      } catch (error) {
        this.contextEditEvents.delete(context)
        callback.close()
        throw error
      }
    }
    let entry = registration.buffers.get(handle.slot)
    if (!entry || entry.handle.contextId !== handle.contextId || entry.handle.generation !== handle.generation) {
      entry = { handle, listeners: new Set() }
      registration.buffers.set(handle.slot, entry)
    }
    const listener = { handler }
    entry.listeners.add(listener)
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size === 0 && registration.buffers.get(handle.slot) === entry)
        registration.buffers.delete(handle.slot)
    }
  }

  public sceneSetEditorView(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    view: ContextEditorViewHandle | null,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const target = view === null ? null : encodeContextHandle(context, view)
    const pointer = this.nativeContextPointer(context, "ot_scene_set_editor_view")
    nativeResult("ot_scene_set_editor_view", this.opentui.symbols.ot_scene_set_editor_view(pointer, handle, target))
  }

  public sceneSetEditorOptions(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    options: NativeSceneEditorOptions,
  ): void {
    const layout = nativeLayouts.ot_scene_editor_options
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const style = CURSOR_ID_TO_STYLE.indexOf(options.style)
    if (style < 0) throw new TypeError("Unknown scene editor cursor style")
    const record = createContextRecord(layout)
    record[layout.fields.show_cursor.offset / 4] = toFFIBool(options.showCursor, "Editor showCursor")
    record[layout.fields.style.offset / 4] = style
    record[layout.fields.blinking.offset / 4] = toFFIBool(options.blinking, "Editor blinking")
    new Uint16Array(record.buffer, layout.fields.color.offset, layout.fields.color.size / 2).set(
      contextBufferColor(options.color),
    )
    const cursor = options.cursor === undefined ? 6 : MOUSE_STYLE_TO_ID[options.cursor]
    if (typeof cursor !== "number") throw new TypeError("Unknown scene editor mouse pointer style")
    record[layout.fields.mouse_pointer.offset / 4] = cursor
    const pointer = this.nativeContextPointer(context, "ot_scene_set_editor_options")
    nativeResult(
      "ot_scene_set_editor_options",
      this.opentui.symbols.ot_scene_set_editor_options(pointer, handle, record),
    )
  }

  public importContextImage(context: NativeContextHandle, source: ImageHandle): ContextImageHandle {
    const token = toSafeFFIU32Length(toNumber(source), "Compatibility image handle")
    const output = new BigUint64Array(nativeLayouts.ot_handle.size / 8)
    return this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_image_import_compat")
      nativeResult("ot_image_import_compat", this.opentui.symbols.ot_image_import_compat(pointer, token, output))
      try {
        return decodeContextHandle(context, output) as ContextImageHandle
      } catch (error) {
        this.opentui.symbols.ot_image_destroy(pointer, output)
        throw error
      }
    })
  }

  public destroyContextImage(context: NativeContextHandle, image: ContextImageHandle): void {
    const handle = encodeContextHandle(context, image)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_image_destroy")
      nativeResult("ot_image_destroy", this.opentui.symbols.ot_image_destroy(pointer, handle))
    })
  }

  public sceneSetImage(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    image: ContextImageHandle | null,
    fit: "fit" | "cover" | "fill",
    protocol: ImageRenderProtocol,
    buffer: ContextBufferHandle | null,
  ): void {
    const handle = encodeContextHandle(context, node)
    const source = image === null ? null : encodeContextHandle(context, image)
    const storage = buffer === null ? null : encodeContextHandle(context, buffer)
    const fitId = IMAGE_FITS.indexOf(fit)
    const protocolId = IMAGE_PROTOCOL_TO_ID[protocol]
    if (fitId < 0 || !Number.isInteger(protocolId)) throw new TypeError("Unknown image fit or protocol")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_scene_set_image")
      nativeResult(
        "ot_scene_set_image",
        this.opentui.symbols.ot_scene_set_image(pointer, handle, source, fitId, protocolId, storage),
      )
    })
  }

  public contextDrawImage(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    image: ContextImageHandle,
    options: NativeContextImageDraw,
  ): boolean {
    const layout = nativeLayouts.ot_image_draw_options
    const handle = encodeContextHandle(context, target)
    const ticket = frame === null ? null : encodeSceneFrameRequest(context, frame)
    const source = encodeContextHandle(context, image)
    const record = new Uint32Array(layout.size / 4)
    const signed = new Int32Array(record.buffer)
    record[layout.fields.struct_size.offset / 4] = record.byteLength
    record[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    const protocolId = IMAGE_PROTOCOL_TO_ID[options.protocol ?? "auto"]
    if (!Number.isInteger(protocolId)) throw new TypeError("Unknown image protocol")
    record[layout.fields.protocol.offset / 4] = protocolId
    for (const [field, coordinate] of [
      ["x", options.x ?? 0],
      ["y", options.y ?? 0],
    ] as const) {
      if (!Number.isInteger(coordinate) || coordinate < -0x80000000 || coordinate > 0x7fffffff) {
        throw new RangeError("Image coordinates must be signed 32-bit integers")
      }
      signed[layout.fields[field].offset / 4] = coordinate
    }
    const sourceWidth = options.sourceWidth
    const sourceHeight = options.sourceHeight
    record[layout.fields.flags.offset / 4] = (sourceWidth === undefined ? 0 : 1) | (sourceHeight === undefined ? 0 : 2)
    for (const [field, value] of [
      ["width", options.width],
      ["height", options.height],
      ["pixel_width", options.pixelWidth ?? 0],
      ["pixel_height", options.pixelHeight ?? 0],
      ["source_x", options.sourceX ?? 0],
      ["source_y", options.sourceY ?? 0],
      ["source_width", sourceWidth ?? 0],
      ["source_height", sourceHeight ?? 0],
    ] as const) {
      record[layout.fields[field].offset / 4] = toSafeFFIU32Length(value, "Image drawing dimension")
    }
    const output = new Uint32Array(1)
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_buffer_draw_image")
      nativeResult(
        "ot_buffer_draw_image",
        this.opentui.symbols.ot_buffer_draw_image(pointer, handle, ticket, source, record, output),
      )
    })
    return output[0] !== 0
  }

  public sessionSetImageResolution(
    context: NativeContextHandle,
    session: SessionHandle,
    terminalWidth: number,
    terminalHeight: number,
    pixelWidth: number,
    pixelHeight: number,
  ): void {
    const handle = encodeContextHandle(context, session)
    const columns = toSafeFFIU32Length(terminalWidth, "Terminal image columns")
    const rows = toSafeFFIU32Length(terminalHeight, "Terminal image rows")
    const width = toSafeFFIU32Length(pixelWidth, "Terminal image pixel width")
    const height = toSafeFFIU32Length(pixelHeight, "Terminal image pixel height")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_session_set_image_resolution")
      nativeResult(
        "ot_session_set_image_resolution",
        this.opentui.symbols.ot_session_set_image_resolution(pointer, handle, columns, rows, width, height),
      )
    })
  }

  public sessionSetKittyImageTransport(context: NativeContextHandle, session: SessionHandle, mode: number): void {
    const handle = encodeContextHandle(context, session)
    const value = toSafeFFIU32Length(mode, "Session Kitty image transport")
    const pointer = this.nativeContextPointer(context, "ot_session_set_kitty_image_transport")
    nativeResult(
      "ot_session_set_kitty_image_transport",
      this.opentui.symbols.ot_session_set_kitty_image_transport(pointer, handle, value),
    )
  }

  public sessionGetKittyImageTransport(
    context: NativeContextHandle,
    session: SessionHandle,
  ): NativeSessionKittyImageTransportStatus {
    const layout = nativeLayouts.ot_session_kitty_image_transport
    const handle = encodeContextHandle(context, session)
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_session_get_kitty_image_transport")
    nativeResult(
      "ot_session_get_kitty_image_transport",
      this.opentui.symbols.ot_session_get_kitty_image_transport(pointer, handle, output),
    )
    return {
      requested: output[layout.fields.requested.offset / 4],
      effective: output[layout.fields.effective.offset / 4],
      fileState: output[layout.fields.file_state.offset / 4],
      fallback: output[layout.fields.fallback.offset / 4],
      pendingFiles: output[layout.fields.pending_files.offset / 4],
      pendingBytes: output[layout.fields.pending_bytes.offset / 4],
    }
  }

  public sessionPollKittyImageTransport(context: NativeContextHandle, session: SessionHandle): boolean {
    const handle = encodeContextHandle(context, session)
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_session_poll_kitty_image_transport")
    nativeResult(
      "ot_session_poll_kitty_image_transport",
      this.opentui.symbols.ot_session_poll_kitty_image_transport(pointer, handle, output),
    )
    return output[0] !== 0
  }

  public sessionCancelKittyImageTransport(context: NativeContextHandle, session: SessionHandle, failed: boolean): void {
    const handle = encodeContextHandle(context, session)
    const value = toFFIBool(failed, "Session Kitty image transport failed")
    const pointer = this.nativeContextPointer(context, "ot_session_cancel_kitty_image_transport")
    nativeResult(
      "ot_session_cancel_kitty_image_transport",
      this.opentui.symbols.ot_session_cancel_kitty_image_transport(pointer, handle, value),
    )
  }

  public sessionProcessKittyImageReply(
    context: NativeContextHandle,
    session: SessionHandle,
    bytes: Uint8Array,
  ): number {
    const handle = encodeContextHandle(context, session)
    const input = sessionBytes(bytes, "Session Kitty image reply length")
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_session_process_kitty_image_reply")
    nativeResult(
      "ot_session_process_kitty_image_reply",
      this.opentui.symbols.ot_session_process_kitty_image_reply(
        pointer,
        handle,
        viewOrNull(input),
        input.byteLength,
        output,
      ),
    )
    return output[0]
  }

  public sessionStartKittyFileProbe(context: NativeContextHandle, session: SessionHandle): void {
    const handle = encodeContextHandle(context, session)
    const pointer = this.nativeContextPointer(context, "ot_session_start_kitty_file_probe")
    nativeResult(
      "ot_session_start_kitty_file_probe",
      this.opentui.symbols.ot_session_start_kitty_file_probe(pointer, handle),
    )
  }

  public createContextBuffer(context: NativeContextHandle, options: NativeContextBufferOptions): ContextBufferHandle {
    const layout = nativeLayouts.ot_buffer_options
    const widthMethod = options.widthMethod ?? "unicode"
    if (
      widthMethod !== "wcwidth" &&
      widthMethod !== "unicode" &&
      widthMethod !== "no-zwj" &&
      widthMethod !== "unicode-wide"
    ) {
      throw new TypeError("Unknown Context buffer width method")
    }
    const record = createContextRecord(layout)
    record[layout.fields.width.offset / 4] = toSafeFFIU32Length(options.width, "Context buffer width")
    record[layout.fields.height.offset / 4] = toSafeFFIU32Length(options.height, "Context buffer height")
    record[layout.fields.width_method.offset / 4] = widthMethod === "no-zwj" ? 2 : widthMethodCode(widthMethod)
    record[layout.fields.flags.offset / 4] = toFFIBool(options.respectAlpha ?? false, "Context buffer respectAlpha")
    const output = new BigUint64Array(nativeLayouts.ot_handle.size / 8)
    const pointer = this.nativeContextPointer(context, "ot_buffer_create")
    nativeResult("ot_buffer_create", this.opentui.symbols.ot_buffer_create(pointer, record, output))
    try {
      return decodeContextHandle(context, output)
    } catch (error) {
      const live = this.nativeContexts.get(context)
      if (live !== undefined) this.opentui.symbols.ot_buffer_destroy(live, output)
      throw error
    }
  }

  public destroyContextBuffer(context: NativeContextHandle, buffer: ContextBufferHandle): void {
    const handle = encodeContextHandle(context, buffer)
    const pointer = this.nativeContextPointer(context, "ot_buffer_destroy")
    nativeResult("ot_buffer_destroy", this.opentui.symbols.ot_buffer_destroy(pointer, handle))
  }

  public contextResizeBuffer(
    context: NativeContextHandle,
    buffer: ContextBufferHandle,
    width: number,
    height: number,
  ): void {
    const handle = encodeContextHandle(context, buffer)
    const columns = toSafeFFIU32Length(width, "Context buffer width")
    const rows = toSafeFFIU32Length(height, "Context buffer height")
    const pointer = this.nativeContextPointer(context, "ot_buffer_resize")
    nativeResult("ot_buffer_resize", this.opentui.symbols.ot_buffer_resize(pointer, handle, columns, rows))
  }

  public contextDrawBuffer(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    options: NativeBufferDraw,
  ): void {
    const layout = nativeLayouts.ot_buffer_draw_options
    this.getYogaHost().assertMutable()
    const scratch = this.bufferDrawRecord ?? createBufferDrawRecord()
    this.bufferDrawRecord = undefined
    try {
      const handle = encodeContextHandle(context, target, scratch.handle.record, scratch.handle.words)
      const ticket = frame === null ? null : encodeSceneFrameRequest(context, frame, scratch.frame)
      const source =
        options.source === undefined
          ? null
          : encodeContextHandle(context, options.source, scratch.source.record, scratch.source.words)
      const { record, signed, colors } = scratch
      record.fill(0)
      record[layout.fields.struct_size.offset / 4] = record.byteLength
      record[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
      const operation = BUFFER_DRAW_OPERATIONS.indexOf(options.operation)
      if (operation < 0) throw new TypeError("Invalid checked buffer drawing operation")
      record[layout.fields.operation.offset / 4] = operation
      for (const [field, coordinate] of [
        ["x", options.x ?? 0],
        ["y", options.y ?? 0],
      ] as const) {
        if (!Number.isInteger(coordinate) || coordinate < -0x80000000 || coordinate > 0x7fffffff) {
          throw new RangeError("Buffer coordinates must be signed 32-bit integers")
        }
        signed[layout.fields[field].offset / 4] = coordinate
      }
      for (const [field, value] of [
        ["width", options.width ?? 0],
        ["height", options.height ?? 0],
        ["character", options.char ?? 32],
        ["attributes", options.attributes ?? 0],
        ["packed_options", options.packedOptions ?? 0],
      ] as const) {
        record[layout.fields[field].offset / 4] = toSafeFFIU32Length(value, "Buffer drawing option")
      }
      if (options.foreground !== undefined)
        contextBufferColor(options.foreground, colors, layout.fields.foreground.offset / 2)
      if (options.background !== undefined) {
        contextBufferColor(options.background, colors, layout.fields.background.offset / 2)
        record[layout.fields.flags.offset / 4] |= 1
      }
      if (options.titleColor !== undefined)
        contextBufferColor(options.titleColor, colors, layout.fields.title_color.offset / 2)
      if (options.borderChars !== undefined) {
        if (options.borderChars.length !== 11) throw new RangeError("Border characters must contain 11 Unicode scalars")
        record.set(options.borderChars, layout.fields.border_chars.offset / 4)
      }
      for (const [field, value] of [
        ["source_x", options.sourceX ?? 0],
        ["source_y", options.sourceY ?? 0],
        ["source_width", options.sourceWidth ?? 0],
        ["source_height", options.sourceHeight ?? 0],
      ] as const) {
        record[layout.fields[field].offset / 4] = toSafeFFIU32Length(value, "Buffer source rectangle")
      }
      if (options.sourceWidth !== undefined) record[layout.fields.flags.offset / 4] |= 2
      if (options.sourceHeight !== undefined) record[layout.fields.flags.offset / 4] |= 4
      const textValue = options.text ?? ""
      const text = textValue === "" ? this.emptyBytes : this.encoder.encode(textValue)
      const bottomValue = options.bottomTitle ?? ""
      const bottom = bottomValue === "" ? this.emptyBytes : this.encoder.encode(bottomValue)
      if (text.byteLength > NATIVE_BUFFER_TEXT_BYTES_MAX || bottom.byteLength > NATIVE_BUFFER_TEXT_BYTES_MAX) {
        throw new RangeError("Buffer text exceeds the native byte limit")
      }
      const pointer = this.nativeContextPointer(context, "ot_buffer_draw")
      nativeResult(
        "ot_buffer_draw",
        this.opentui.symbols.ot_buffer_draw(
          pointer,
          handle,
          ticket,
          record,
          source,
          text,
          text.byteLength,
          bottom,
          bottom.byteLength,
        ),
      )
    } finally {
      this.bufferDrawRecord ??= scratch
    }
  }

  public contextBufferStack(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    options: NativeBufferStack,
  ): number {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, target)
    const ticket = frame === null ? null : encodeSceneFrameRequest(context, frame)
    const operation = BUFFER_STACK_OPERATIONS.indexOf(options.operation)
    if (operation < 0) throw new TypeError("Invalid checked buffer stack operation")
    const x = options.x ?? 0
    const y = options.y ?? 0
    for (const coordinate of [x, y]) {
      if (!Number.isInteger(coordinate) || coordinate < -0x80000000 || coordinate > 0x7fffffff) {
        throw new RangeError("Buffer scissor coordinates must be signed 32-bit integers")
      }
    }
    const width = toSafeFFIU32Length(options.width ?? 0, "Buffer scissor width")
    const height = toSafeFFIU32Length(options.height ?? 0, "Buffer scissor height")
    const opacity = options.opacity ?? 1
    if (!Number.isFinite(opacity)) throw new RangeError("Buffer opacity must be finite")
    const input = new Float32Array([Math.max(0, Math.min(1, opacity))])
    const output = new Float32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_buffer_stack")
    nativeResult(
      "ot_buffer_stack",
      this.opentui.symbols.ot_buffer_stack(pointer, handle, ticket, operation, x, y, width, height, input, output),
    )
    return output[0]
  }

  public contextDrawGrid(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    options: NativeBufferGrid,
  ): void {
    const layout = nativeLayouts.ot_buffer_grid_options
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, target)
    const ticket = frame === null ? null : encodeSceneFrameRequest(context, frame)
    const { borderChars, borderFg, borderBg, columnOffsets, rowOffsets, drawInner, drawOuter } = options
    if (borderChars.length !== 11) throw new RangeError("Border characters must contain 11 Unicode scalars")
    const [columns, rows] = [columnOffsets, rowOffsets].map(
      (offsets) =>
        new Int32Array(
          typedArrayAccessors.buffer.get!.call(offsets),
          typedArrayAccessors.byteOffset.get!.call(offsets),
          typedArrayAccessors.length.get!.call(offsets),
        ),
    )
    const record = createContextRecord(layout)
    record[layout.fields.flags.offset / 4] =
      toFFIBool(drawInner, "Grid inner borders") | (toFFIBool(drawOuter, "Grid outer borders") << 1)
    const colors = new Uint16Array(record.buffer)
    contextBufferColor(borderFg, colors, layout.fields.foreground.offset / 2)
    contextBufferColor(borderBg, colors, layout.fields.background.offset / 2)
    record.set(borderChars, layout.fields.border_chars.offset / 4)
    const columnCount = toSafeFFIU32Length(columns.length, "Grid column offsets")
    const rowCount = toSafeFFIU32Length(rows.length, "Grid row offsets")
    const pointer = this.nativeContextPointer(context, "ot_buffer_draw_grid")
    nativeResult(
      "ot_buffer_draw_grid",
      this.opentui.symbols.ot_buffer_draw_grid(pointer, handle, ticket, record, columns, columnCount, rows, rowCount),
    )
  }

  public contextDrawPackedBuffer(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    data: Uint8Array | PointerInput,
    byteLength: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, target)
    const ticket = frame === null ? null : encodeSceneFrameRequest(context, frame)
    const length = toSafeFFIU32Length(byteLength, "Packed buffer byte count")
    const input = pixelInput(data, length)
    const dimensions = [x, y, width, height].map((value) => toSafeFFIU32Length(value, "Packed buffer dimension"))
    const pointer = this.nativeContextPointer(context, "ot_buffer_draw_packed")
    nativeResult(
      "ot_buffer_draw_packed",
      this.opentui.symbols.ot_buffer_draw_packed(pointer, handle, ticket, input, length, ...dimensions),
    )
  }

  public contextDrawSuperSampleBuffer(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    data: Uint8Array | PointerInput,
    byteLength: number,
    x: number,
    y: number,
    format: "rgba8unorm" | "bgra8unorm",
    stride: number,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, target)
    const ticket = frame === null ? null : encodeSceneFrameRequest(context, frame)
    if (format !== "rgba8unorm" && format !== "bgra8unorm") throw new TypeError("Unknown pixel format")
    const length = toSafeFFIU32Length(byteLength, "Supersample buffer byte count")
    const input = pixelInput(data, length)
    const dimensions = [x, y, format === "bgra8unorm" ? 0 : 1, stride].map((value) =>
      toSafeFFIU32Length(value, "Supersample buffer dimension"),
    )
    const pointer = this.nativeContextPointer(context, "ot_buffer_draw_supersample")
    nativeResult(
      "ot_buffer_draw_supersample",
      this.opentui.symbols.ot_buffer_draw_supersample(pointer, handle, ticket, input, length, ...dimensions),
    )
  }

  public contextDrawGrayscaleBuffer(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    data: Float32Array,
    x: number,
    y: number,
    width: number,
    height: number,
    foreground: RGBA | null,
    background: RGBA | null,
    supersampled: boolean,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, target)
    const ticket = frame === null ? null : encodeSceneFrameRequest(context, frame)
    if (!(data instanceof Float32Array)) throw new TypeError("Grayscale input must be a Float32Array")
    const input = new Float32Array(
      typedArrayAccessors.buffer.get!.call(data),
      typedArrayAccessors.byteOffset.get!.call(data),
      typedArrayAccessors.length.get!.call(data),
    )
    const count = toSafeFFIU32Length(input.length, "Grayscale sample count")
    for (const coordinate of [x, y]) {
      if (!Number.isInteger(coordinate) || coordinate < -0x80000000 || coordinate > 0x7fffffff) {
        throw new RangeError("Grayscale coordinates must be signed 32-bit integers")
      }
    }
    const sourceWidth = toSafeFFIU32Length(width, "Grayscale source width")
    const sourceHeight = toSafeFFIU32Length(height, "Grayscale source height")
    const fg = foreground === null ? null : contextBufferColor(foreground)
    const bg = background === null ? null : contextBufferColor(background)
    const doubled = toFFIBool(supersampled, "Grayscale supersampling")
    const pointer = this.nativeContextPointer(context, "ot_buffer_draw_grayscale")
    nativeResult(
      "ot_buffer_draw_grayscale",
      this.opentui.symbols.ot_buffer_draw_grayscale(
        pointer,
        handle,
        ticket,
        input,
        count,
        x,
        y,
        sourceWidth,
        sourceHeight,
        fg,
        bg,
        doubled,
      ),
    )
  }

  public contextColorMatrixBuffer(
    context: NativeContextHandle,
    target: ContextBufferHandle | SessionHandle,
    frame: NativeSceneFrameRequest | null,
    matrix: Float32Array,
    mask: Float32Array | null,
    strength: number,
    channel: number,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, target)
    const ticket = frame === null ? null : encodeSceneFrameRequest(context, frame)
    const [transform, cells] = [matrix, mask].map((value) => {
      if (value === null) return null
      if (!(value instanceof Float32Array)) throw new TypeError("Color matrix input must be a Float32Array")
      return new Float32Array(
        typedArrayAccessors.buffer.get!.call(value),
        typedArrayAccessors.byteOffset.get!.call(value),
        typedArrayAccessors.length.get!.call(value),
      )
    })
    if (transform === null || transform.length !== 16) throw new RangeError("Color matrix must contain 16 floats")
    const count = toSafeFFIU32Length(cells?.length ?? 0, "Color matrix mask length")
    if (!Number.isFinite(strength)) throw new RangeError("Color matrix strength must be finite")
    const targetChannel = toSafeFFIU32Length(channel, "Color matrix channel")
    const pointer = this.nativeContextPointer(context, "ot_buffer_color_matrix")
    nativeResult(
      "ot_buffer_color_matrix",
      this.opentui.symbols.ot_buffer_color_matrix(
        pointer,
        handle,
        ticket,
        transform,
        transform.length,
        // An empty mask must remain non-null on runtimes with null empty-array pointers.
        cells?.length === 0 ? transform : cells,
        count,
        new Float32Array([strength]),
        targetChannel,
      ),
    )
  }

  public contextAcquireBufferLease(
    context: NativeContextHandle,
    buffer: ContextBufferHandle,
  ): NativeContextBufferLease {
    return this.acquireBufferLease(context, buffer)
  }

  public createSession(context: NativeContextHandle, options: NativeSessionOptions): SessionHandle {
    const layout = nativeLayouts.ot_session_options
    const record = new BigUint64Array(layout.size / 8)
    const words = new Uint32Array(record.buffer)
    words[layout.fields.struct_size.offset / 4] = layout.size
    words[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    words[layout.fields.chunk_size.offset / 4] = toSafeFFIU32Length(options.chunkSize, "Session chunkSize")
    words[layout.fields.span_capacity.offset / 4] = toSafeFFIU32Length(options.spanCapacity, "Session spanCapacity")
    record[layout.fields.max_bytes.offset / 8] = toFFIU64(options.maxBytes, "Session maxBytes")
    words[layout.fields.control_capacity.offset / 4] = toSafeFFIU32Length(
      options.controlCapacity ?? 0,
      "Session controlCapacity",
    )
    const output = new BigUint64Array(nativeLayouts.ot_handle.size / 8)
    const pointer = this.nativeContextPointer(context, "ot_session_create")
    nativeResult("ot_session_create", this.opentui.symbols.ot_session_create(pointer, record, output))
    return decodeContextHandle(context, output)
  }

  public sessionGetWriteLimit(context: NativeContextHandle, session: SessionHandle): bigint {
    const handle = encodeContextHandle(context, session)
    const output = new BigUint64Array(1)
    const pointer = this.nativeContextPointer(context, "ot_session_get_write_limit")
    nativeResult("ot_session_get_write_limit", this.opentui.symbols.ot_session_get_write_limit(pointer, handle, output))
    return output[0]
  }

  public sessionWrite(context: NativeContextHandle, session: SessionHandle, bytes: Uint8Array): void {
    const handle = encodeContextHandle(context, session)
    const input = sessionBytes(bytes, "Session write length")
    const length = input.byteLength
    const pointer = this.nativeContextPointer(context, "ot_session_write")
    const status = this.opentui.symbols.ot_session_write(pointer, handle, length === 0 ? null : input, length)
    if (status === NativeStatus.OutputBackpressure && length > this.sessionGetWriteLimit(context, session)) {
      throw new RangeError("Session write exceeds the atomic output limit")
    }
    nativeResult("ot_session_write", status)
  }

  public sessionAttachRenderer(
    context: NativeContextHandle,
    session: SessionHandle,
    options: NativeSessionRendererOptions,
  ): void {
    const layout = nativeLayouts.ot_session_renderer_env_options
    const handle = encodeContextHandle(context, session)
    const remote = options.remote
    const record = createContextRecord(layout)
    record[layout.fields.width.offset / 4] = toSafeFFIU32Length(options.width, "Session renderer width")
    record[layout.fields.height.offset / 4] = toSafeFFIU32Length(options.height, "Session renderer height")
    record[layout.fields.remote_mode.offset / 4] =
      remote === undefined ? 0 : toFFIBool(remote, "Session renderer remote") + 1
    const environment = options.environment ?? {}
    const bytes = new Uint8Array(65_536)
    const lengths = new DataView(bytes.buffer)
    let offset = 0
    for (const key of Object.keys(environment)) {
      if (record[layout.fields.entry_count.offset / 4] === 256)
        throw new RangeError("Session environment exceeds 256 entries")
      const value = environment[key]
      if (typeof value !== "string") throw new TypeError("Session environment values must be strings")
      if (key.length + value.length + 8 > bytes.length - offset) {
        throw new RangeError("Session environment exceeds 65536 bytes")
      }
      if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) {
        throw new TypeError(
          "Session environment requires nonempty NUL-free keys without '=' and NUL-free string values",
        )
      }
      const keyBytes = this.encoder.encode(key)
      const valueBytes = this.encoder.encode(value)
      if (keyBytes.length + valueBytes.length + 8 > bytes.length - offset) {
        throw new RangeError("Session environment exceeds 65536 bytes")
      }
      lengths.setUint32(offset, keyBytes.length, true)
      lengths.setUint32(offset + 4, valueBytes.length, true)
      bytes.set(keyBytes, offset + 8)
      bytes.set(valueBytes, offset + 8 + keyBytes.length)
      offset += 8 + keyBytes.length + valueBytes.length
      record[layout.fields.entry_count.offset / 4]++
    }
    record[layout.fields.byte_count.offset / 4] = offset
    const input = bytes.subarray(0, offset)
    const pointer = this.nativeContextPointer(context, "ot_session_attach_renderer_with_env")
    nativeResult(
      "ot_session_attach_renderer_with_env",
      this.opentui.symbols.ot_session_attach_renderer_with_env(pointer, handle, record, input),
    )
  }

  public sessionRender(
    context: NativeContextHandle,
    session: SessionHandle,
    force: boolean,
  ): NativeSessionRenderStatus {
    const forceRender = toFFIBool(force, "Session render force")
    const handle = encodeContextHandle(context, session)
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_session_render")
    nativeResult("ot_session_render", this.opentui.symbols.ot_session_render(pointer, handle, forceRender, output))
    return output[0]
  }

  public sessionResizeRenderer(
    context: NativeContextHandle,
    session: SessionHandle,
    width: number,
    height: number,
  ): void {
    const handle = encodeContextHandle(context, session)
    const columns = toSafeFFIU32Length(width, "Session renderer width")
    const rows = toSafeFFIU32Length(height, "Session renderer height")
    const pointer = this.nativeContextPointer(context, "ot_session_resize_renderer")
    nativeResult(
      "ot_session_resize_renderer",
      this.opentui.symbols.ot_session_resize_renderer(pointer, handle, columns, rows),
    )
  }

  public sessionSetDebugOverlay(
    context: NativeContextHandle,
    session: SessionHandle,
    enabled: boolean,
    corner: DebugOverlayCorner,
  ): void {
    const handle = encodeContextHandle(context, session)
    const active = toFFIBool(enabled, "Session debug overlay enabled")
    const position = toSafeFFIU32Length(corner, "Session debug overlay corner")
    const pointer = this.nativeContextPointer(context, "ot_session_set_debug_overlay")
    nativeResult(
      "ot_session_set_debug_overlay",
      this.opentui.symbols.ot_session_set_debug_overlay(pointer, handle, active, position),
    )
  }

  public sessionUpdateStats(
    context: NativeContextHandle,
    session: SessionHandle,
    overallMs: number,
    fps: number,
    callbackMs: number,
  ): void {
    const handle = encodeContextHandle(context, session)
    const framesPerSecond = toSafeFFIU32Length(fps, "Session frames per second")
    for (const value of [overallMs, callbackMs]) {
      if (!Number.isFinite(value) || value < 0)
        throw new RangeError("Session frame times must be finite nonnegative numbers")
    }
    const pointer = this.nativeContextPointer(context, "ot_session_update_stats")
    nativeResult(
      "ot_session_update_stats",
      this.opentui.symbols.ot_session_update_stats(pointer, handle, overallMs, framesPerSecond, callbackMs),
    )
  }

  public sessionUpdateMemoryStats(
    context: NativeContextHandle,
    session: SessionHandle,
    heapUsed: number,
    heapTotal: number,
    arrayBuffers: number,
  ): void {
    const handle = encodeContextHandle(context, session)
    const used = toSafeFFIU32Length(heapUsed, "Session heap used")
    const total = toSafeFFIU32Length(heapTotal, "Session heap total")
    const buffers = toSafeFFIU32Length(arrayBuffers, "Session array buffers")
    const pointer = this.nativeContextPointer(context, "ot_session_update_memory_stats")
    nativeResult(
      "ot_session_update_memory_stats",
      this.opentui.symbols.ot_session_update_memory_stats(pointer, handle, used, total, buffers),
    )
  }

  public sessionDumpHitGrid(context: NativeContextHandle, session: SessionHandle): void {
    const handle = encodeContextHandle(context, session)
    const pointer = this.nativeContextPointer(context, "ot_session_dump_hit_grid")
    nativeResult("ot_session_dump_hit_grid", this.opentui.symbols.ot_session_dump_hit_grid(pointer, handle))
  }

  public sessionGetRendererState(context: NativeContextHandle, session: SessionHandle): NativeSessionRendererState {
    const layout = nativeLayouts.ot_session_renderer_state
    const handle = encodeContextHandle(context, session)
    const output = new BigUint64Array(layout.size / 8)
    const words = new Uint32Array(output.buffer)
    words[layout.fields.struct_size.offset / 4] = layout.size
    words[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    const pointer = this.nativeContextPointer(context, "ot_session_get_renderer_state")
    nativeResult(
      "ot_session_get_renderer_state",
      this.opentui.symbols.ot_session_get_renderer_state(pointer, handle, output),
    )
    return {
      width: words[layout.fields.width.offset / 4],
      height: words[layout.fields.height.offset / 4],
      frameCount: output[layout.fields.frame_count.offset / 8],
      framePending: words[layout.fields.frame_pending.offset / 4] !== 0,
    }
  }

  public sessionAcquireBufferLease(
    context: NativeContextHandle,
    session: SessionHandle,
    which: SessionBuffer,
  ): NativeSessionBufferLease {
    if (which !== "current" && which !== "next") throw new TypeError("Session buffer must be current or next")
    return this.acquireBufferLease(context, session, which)
  }

  private acquireBufferLease(
    context: NativeContextHandle,
    target: ContextObjectHandle,
    which?: SessionBuffer,
    frame?: NativeSceneFrameRequest,
  ): NativeContextBufferLease {
    const layout = nativeLayouts.ot_buffer_lease_snapshot
    const handle = encodeContextHandle(context, target)
    const ticket = frame === undefined ? null : encodeSceneFrameRequest(context, frame)
    const output = new BigUint64Array(layout.size / 8)
    const words = new Uint32Array(output.buffer)
    const lease = new BigUint64Array(output.buffer, layout.fields.lease.offset, layout.fields.lease.size / 8)
    words[layout.fields.struct_size.offset / 4] = layout.size
    words[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    const operation = ticket
      ? "ot_scene_frame_acquire_buffer_lease"
      : which === undefined
        ? "ot_buffer_acquire_lease"
        : "ot_session_acquire_buffer_lease"
    const pointer = this.nativeContextPointer(context, operation)
    nativeResult(
      operation,
      ticket
        ? this.opentui.symbols.ot_scene_frame_acquire_buffer_lease(
            pointer,
            handle,
            ticket,
            which === "current" ? 0 : 1,
            output,
          )
        : which === undefined
          ? this.opentui.symbols.ot_buffer_acquire_lease(pointer, handle, output)
          : this.opentui.symbols.ot_session_acquire_buffer_lease(pointer, handle, which === "current" ? 0 : 1, output),
    )
    try {
      return {
        handle: decodeContextHandle(context, lease),
        width: words[layout.fields.width.offset / 4],
        height: words[layout.fields.height.offset / 4],
        generation: output[layout.fields.generation.offset / 8],
        char: toPointer(output[layout.fields.char_ptr.offset / 8]),
        fg: toPointer(output[layout.fields.fg_ptr.offset / 8]),
        bg: toPointer(output[layout.fields.bg_ptr.offset / 8]),
        attributes: toPointer(output[layout.fields.attributes_ptr.offset / 8]),
      }
    } catch (error) {
      this.opentui.symbols.ot_buffer_lease_release(pointer, lease)
      throw error
    }
  }

  public contextValidateBufferLease(context: NativeContextHandle, lease: ContextObjectHandle): void {
    const handle = encodeContextHandle(context, lease)
    const pointer = this.nativeContextPointer(context, "ot_buffer_lease_validate")
    nativeResult("ot_buffer_lease_validate", this.opentui.symbols.ot_buffer_lease_validate(pointer, handle))
  }

  public contextReleaseBufferLease(context: NativeContextHandle, lease: ContextObjectHandle): void {
    const handle = encodeContextHandle(context, lease)
    const pointer = this.nativeContextPointer(context, "ot_buffer_lease_release")
    nativeResult("ot_buffer_lease_release", this.opentui.symbols.ot_buffer_lease_release(pointer, handle))
  }

  public contextBufferLeaseGetRealCharSize(
    context: NativeContextHandle,
    lease: ContextObjectHandle,
    addLineBreaks: boolean,
  ): number {
    const handle = encodeContextHandle(context, lease)
    const lineBreaks = toFFIBool(addLineBreaks, "Buffer lease addLineBreaks")
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_buffer_lease_get_real_char_size")
    nativeResult(
      "ot_buffer_lease_get_real_char_size",
      this.opentui.symbols.ot_buffer_lease_get_real_char_size(pointer, handle, lineBreaks, output),
    )
    return output[0]
  }

  public contextBufferLeaseWriteResolvedChars(
    context: NativeContextHandle,
    lease: ContextObjectHandle,
    bytes: Uint8Array,
    addLineBreaks: boolean,
    cellLengths?: Uint8Array,
  ): number {
    const handle = encodeContextHandle(context, lease)
    const target = sessionBytes(bytes, "Buffer lease resolved character capacity")
    const capacity = target.byteLength
    const lineBreaks = toFFIBool(addLineBreaks, "Buffer lease addLineBreaks")
    const lengths = cellLengths === undefined ? null : sessionBytes(cellLengths, "Buffer lease cell length capacity")
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_buffer_lease_write_resolved_chars")
    nativeResult(
      "ot_buffer_lease_write_resolved_chars",
      this.opentui.symbols.ot_buffer_lease_write_resolved_chars(
        pointer,
        handle,
        capacity === 0 ? null : target,
        capacity,
        lineBreaks,
        lengths,
        lengths?.byteLength ?? 0,
        output,
      ),
    )
    return output[0]
  }

  public sessionSetupTerminal(
    context: NativeContextHandle,
    session: SessionHandle,
    options: NativeSessionTerminalOptions = {},
  ): void {
    const layout = nativeLayouts.ot_session_terminal_options
    const handle = encodeContextHandle(context, session)
    const flags =
      toFFIBool(options.useAlternateScreen ?? true, "Session useAlternateScreen") |
      (toFFIBool(options.mouse ?? true, "Session mouse") << 1) |
      (toFFIBool(options.mouseMovement ?? true, "Session mouseMovement") << 2) |
      (toFFIBool(options.clearOnClose ?? true, "Session clearOnClose") << 3)
    const record = createContextRecord(layout)
    record[layout.fields.flags.offset / 4] = flags
    record[layout.fields.kitty_keyboard_flags.offset / 4] = toSafeFFIU32Length(
      options.kittyKeyboardFlags ?? 5,
      "Session kittyKeyboardFlags",
    )
    const pointer = this.nativeContextPointer(context, "ot_session_setup_terminal")
    nativeResult("ot_session_setup_terminal", this.opentui.symbols.ot_session_setup_terminal(pointer, handle, record))
  }

  public sessionSuspend(context: NativeContextHandle, session: SessionHandle): void {
    const handle = encodeContextHandle(context, session)
    const pointer = this.nativeContextPointer(context, "ot_session_suspend")
    nativeResult("ot_session_suspend", this.opentui.symbols.ot_session_suspend(pointer, handle))
  }

  public sessionResume(context: NativeContextHandle, session: SessionHandle): void {
    const handle = encodeContextHandle(context, session)
    const pointer = this.nativeContextPointer(context, "ot_session_resume")
    nativeResult("ot_session_resume", this.opentui.symbols.ot_session_resume(pointer, handle))
  }

  public sessionGetTerminalState(context: NativeContextHandle, session: SessionHandle): NativeSessionTerminalPhase {
    const handle = encodeContextHandle(context, session)
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_session_get_terminal_state")
    nativeResult(
      "ot_session_get_terminal_state",
      this.opentui.symbols.ot_session_get_terminal_state(pointer, handle, output),
    )
    return output[0]
  }

  public sessionPump(
    context: NativeContextHandle,
    session: SessionHandle,
    nowNs: bigint,
    workBudget: number,
  ): NativeSessionPumpResult {
    const layout = nativeLayouts.ot_session_pump_result
    const handle = encodeContextHandle(context, session)
    const now = toFFIU64(nowNs, "Session nowNs")
    const budget = toSafeFFIU32Length(workBudget, "Session workBudget")
    const output = new BigUint64Array(layout.size / 8)
    const words = new Uint32Array(output.buffer)
    words[layout.fields.struct_size.offset / 4] = layout.size
    words[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    const pointer = this.nativeContextPointer(context, "ot_session_pump")
    nativeResult("ot_session_pump", this.opentui.symbols.ot_session_pump(pointer, handle, now, budget, output))
    const status: NativeSessionPumpStatus = words[layout.fields.status.offset / 4]
    return {
      status,
      deadlineNs: status === NativeSessionPumpStatus.WaitUntil ? output[layout.fields.deadline_ns.offset / 8] : null,
    }
  }

  public sessionPumpExit(context: NativeContextHandle, session: SessionHandle): NativeSessionPumpStatus {
    const handle = encodeContextHandle(context, session)
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_session_pump_exit")
    nativeResult("ot_session_pump_exit", this.opentui.symbols.ot_session_pump_exit(pointer, handle, output))
    return output[0]
  }

  public sessionControl(context: NativeContextHandle, session: SessionHandle, command: NativeSessionControl): void {
    const layout = nativeLayouts.ot_session_control_options
    const handle = encodeContextHandle(context, session)
    const record = createContextRecord(layout)
    let bytes: Uint8Array | null = null
    switch (command.kind) {
      case "capability-response":
        record[layout.fields.kind.offset / 4] = 1
        bytes = sessionBytes(command.bytes, "Session capability response length")
        break
      case "palette-query":
        record[layout.fields.kind.offset / 4] = 10
        bytes = sessionBytes(command.bytes, "Session palette query length")
        break
      case "title": {
        record[layout.fields.kind.offset / 4] = 2
        const title = command.title
        if (typeof title !== "string") throw new TypeError("Session title must be a string")
        if (title.length > 4091) throw new NativeError("ot_session_control", NativeStatus.InvalidArgument)
        bytes = this.encoder.encode(title)
        break
      }
      case "mouse": {
        record[layout.fields.kind.offset / 4] = 3
        const mode = command.mode
        if (mode !== "disabled" && mode !== "drag" && mode !== "motion") {
          throw new TypeError("Session mouse mode must be disabled, drag, or motion")
        }
        record[layout.fields.argument.offset / 4] = mode === "disabled" ? 0 : mode === "drag" ? 1 : 2
        break
      }
      case "kitty-keyboard-flags":
        record[layout.fields.kind.offset / 4] = 4
        record[layout.fields.argument.offset / 4] = toSafeFFIU32Length(command.flags, "Session Kitty keyboard flags")
        break
      case "restore-modes":
        record[layout.fields.kind.offset / 4] = 5
        break
      case "query-pixel-resolution":
        record[layout.fields.kind.offset / 4] = 6
        break
      case "query-theme-colors":
        record[layout.fields.kind.offset / 4] = 7
        break
      case "reset-background":
        record[layout.fields.kind.offset / 4] = 9
        break
      default:
        throw new TypeError("Unknown Session control kind")
    }
    const length = bytes?.byteLength ?? 0
    const pointer = this.nativeContextPointer(context, "ot_session_control")
    nativeResult(
      "ot_session_control",
      this.opentui.symbols.ot_session_control(pointer, handle, record, length === 0 ? null : bytes, length),
    )
  }

  public sessionClipboard(
    context: NativeContextHandle,
    session: SessionHandle,
    target: number,
    bytes: Uint8Array,
  ): boolean {
    const handle = encodeContextHandle(context, session)
    const selection = toSafeFFIU32Length(target, "Session clipboard target")
    const input = sessionBytes(bytes, "Session clipboard byte count")
    const out = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_session_clipboard")
    nativeResult(
      "ot_session_clipboard",
      this.opentui.symbols.ot_session_clipboard(pointer, handle, selection, input, input.byteLength, out),
    )
    return out[0] !== 0
  }

  public sessionNotification(
    context: NativeContextHandle,
    session: SessionHandle,
    message: string,
    title?: string,
  ): boolean {
    const handle = encodeContextHandle(context, session)
    if (typeof message !== "string" || (title !== undefined && typeof title !== "string")) {
      throw new TypeError("Notification message and title must be strings")
    }
    // One extra UTF-16 unit preserves native over-limit rejection without an unbounded encoding allocation.
    const limit = NATIVE_SESSION_CONTROL_PACKET_BYTES + 1
    const body = this.encoder.encode(message.slice(0, limit))
    const heading = title === undefined ? null : this.encoder.encode(title.slice(0, limit))
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_session_notification")
    nativeResult(
      "ot_session_notification",
      this.opentui.symbols.ot_session_notification(
        pointer,
        handle,
        body,
        body.byteLength,
        heading,
        heading?.byteLength ?? 0,
        output,
      ),
    )
    return output[0] !== 0
  }

  public sessionSetPaletteState(
    context: NativeContextHandle,
    session: SessionHandle,
    palette: readonly RGBA[],
    foreground: RGBA,
    background: RGBA,
    epoch: number,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, session)
    const count = toSafeFFIU32Length(palette.length, "Session palette length")
    if (count > 256) throw new RangeError("Session palette cannot exceed 256 colors")
    const input = new Uint16Array(count * 4)
    for (let index = 0; index < count; index++) contextBufferColor(palette[index], input, index * 4)
    const fg = contextBufferColor(foreground)
    const bg = contextBufferColor(background)
    const revision = toSafeFFIU32Length(epoch, "Session palette epoch")
    const pointer = this.nativeContextPointer(context, "ot_session_set_palette_state")
    nativeResult(
      "ot_session_set_palette_state",
      this.opentui.symbols.ot_session_set_palette_state(pointer, handle, input, count, fg, bg, revision),
    )
  }

  public sessionSetCursor(
    context: NativeContextHandle,
    session: SessionHandle,
    options: NativeSessionCursorOptions,
  ): void {
    const layout = nativeLayouts.ot_session_cursor_update
    const handle = encodeContextHandle(context, session)
    const { position, style, blinking, color, cursor } = options
    const bytes = new Uint8Array(layout.size)
    const words = new Int32Array(bytes.buffer)
    if (position !== undefined) {
      const { x, y, visible } = position
      for (const coordinate of [x, y]) {
        if (!Number.isFinite(coordinate) || coordinate < -0x8000_0000 || coordinate > 0x7fff_ffff) {
          throw new RangeError("Session cursor coordinates must fit signed 32-bit cells")
        }
      }
      words[layout.fields.fields.offset / 4] |= 1
      words[layout.fields.x.offset / 4] = x
      words[layout.fields.y.offset / 4] = y
      bytes[layout.fields.visible.offset] = toFFIBool(visible, "Session cursor visibility")
    }
    if (style != null) {
      const id = CURSOR_STYLE_TO_ID[style]
      if (typeof id !== "number") throw new TypeError("Unknown cursor style")
      words[layout.fields.fields.offset / 4] |= 2
      bytes[layout.fields.style.offset] = id
    }
    if (blinking != null) {
      words[layout.fields.fields.offset / 4] |= 4
      bytes[layout.fields.blinking.offset] = toFFIBool(blinking, "Session cursor blinking")
    }
    if (color != null) {
      const source = rgbaBuffer(color)
      if (source.length !== 4) throw new RangeError("Session cursor color must have four packed RGBA lanes")
      words[layout.fields.fields.offset / 4] |= 8
      new Uint16Array(bytes.buffer, layout.fields.color.offset, layout.fields.color.size / 2).set(source)
    }
    if (cursor != null) {
      const id = MOUSE_STYLE_TO_ID[cursor]
      if (typeof id !== "number") throw new TypeError("Unknown mouse pointer style")
      words[layout.fields.fields.offset / 4] |= 16
      bytes[layout.fields.mouse_pointer.offset] = id
    }
    const record = new Uint32Array(nativeLayouts.ot_session_control_options.size / 4)
    record[nativeLayouts.ot_session_control_options.fields.struct_size.offset / 4] =
      nativeLayouts.ot_session_control_options.size
    record[nativeLayouts.ot_session_control_options.fields.abi_version.offset / 4] =
      nativeConstants.OT_CONTEXT_ABI_VERSION
    record[nativeLayouts.ot_session_control_options.fields.kind.offset / 4] = 8
    const pointer = this.nativeContextPointer(context, "ot_session_control")
    nativeResult(
      "ot_session_control",
      this.opentui.symbols.ot_session_control(pointer, handle, record, bytes, bytes.byteLength),
    )
  }

  public sessionGetCapabilities(context: NativeContextHandle, session: SessionHandle): NativeSessionCapabilities {
    const layout = nativeLayouts.ot_session_capabilities
    const handle = encodeContextHandle(context, session)
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_session_get_capabilities")
    nativeResult(
      "ot_session_get_capabilities",
      this.opentui.symbols.ot_session_get_capabilities(pointer, handle, output),
    )
    const flags = output[layout.fields.flags.offset / 4]
    const bytes = new Uint8Array(output.buffer)
    return {
      kitty_keyboard: (flags & 1) !== 0,
      kitty_graphics: (flags & 2) !== 0,
      rgb: (flags & 4) !== 0,
      ansi256: (flags & 8) !== 0,
      sgr_pixels: (flags & 16) !== 0,
      color_scheme_updates: (flags & 32) !== 0,
      explicit_width: (flags & 64) !== 0,
      scaled_text: (flags & 128) !== 0,
      sixel: (flags & 256) !== 0,
      focus_tracking: (flags & 512) !== 0,
      sync: (flags & 1024) !== 0,
      bracketed_paste: (flags & 2048) !== 0,
      hyperlinks: (flags & 4096) !== 0,
      osc52: (flags & 8192) !== 0,
      notifications: (flags & 16384) !== 0,
      explicit_cursor_positioning: (flags & 32768) !== 0,
      remote: (flags & 65536) !== 0,
      unicode: widthMethodFromCode(output[layout.fields.width_method.offset / 4]),
      multiplexer: (["none", "tmux", "zellij", "screen", "unknown"] as const)[
        output[layout.fields.multiplexer.offset / 4]
      ],
      image_protocol: (["auto", "kitty", "sixel", "blocks"] as const)[output[layout.fields.image_protocol.offset / 4]],
      osc52_support: (["unknown", "supported", "unsupported"] as const)[output[layout.fields.osc52_support.offset / 4]],
      kittyKeyboardFlags: output[layout.fields.kitty_keyboard_flags.offset / 4],
      terminal: {
        name: this.decoder.decode(
          bytes.subarray(
            layout.fields.term_name.offset,
            layout.fields.term_name.offset + output[layout.fields.term_name_len.offset / 4],
          ),
        ),
        version: this.decoder.decode(
          bytes.subarray(
            layout.fields.term_version.offset,
            layout.fields.term_version.offset + output[layout.fields.term_version_len.offset / 4],
          ),
        ),
        from_xtversion: output[layout.fields.term_from_xtversion.offset / 4] !== 0,
      },
    }
  }

  public sessionReadOutput(
    context: NativeContextHandle,
    session: SessionHandle,
    bytes: Uint8Array,
  ): NativeOutputTicket | null {
    const layout = nativeLayouts.ot_output_ticket
    const handle = encodeContextHandle(context, session)
    const target = sessionBytes(bytes, "Session output capacity")
    const capacity = target.byteLength
    const output = new BigUint64Array(layout.size / 8)
    const pointer = this.nativeContextPointer(context, "ot_session_read_output")
    nativeResult(
      "ot_session_read_output",
      this.opentui.symbols.ot_session_read_output(pointer, handle, capacity === 0 ? null : target, capacity, output),
    )
    const byteCount = new Uint32Array(output.buffer)[layout.fields.byte_count.offset / 4]
    return byteCount === 0
      ? null
      : {
          session: decodeContextHandle(
            context,
            new BigUint64Array(output.buffer, layout.fields.session.offset, nativeLayouts.ot_handle.size / 8),
          ),
          requestId: output[layout.fields.request_id.offset / 8],
          byteCount,
        }
  }

  public sessionCompleteOutput(
    context: NativeContextHandle,
    session: SessionHandle,
    ticket: NativeOutputTicket,
    success: boolean,
  ): void {
    const layout = nativeLayouts.ot_output_ticket
    const written = toFFIBool(success, "Session output success")
    const record = new BigUint64Array(layout.size / 8)
    encodeContextHandle(
      context,
      ticket.session,
      new BigUint64Array(record.buffer, layout.fields.session.offset, nativeLayouts.ot_handle.size / 8),
    )
    record[layout.fields.request_id.offset / 8] = toFFIU64(ticket.requestId, "Output requestId")
    new Uint32Array(record.buffer)[layout.fields.byte_count.offset / 4] = toSafeFFIU32Length(
      ticket.byteCount,
      "Output byteCount",
    )
    const handle = encodeContextHandle(context, session)
    const pointer = this.nativeContextPointer(context, "ot_session_complete_output")
    nativeResult(
      "ot_session_complete_output",
      this.opentui.symbols.ot_session_complete_output(pointer, handle, record, written),
    )
  }

  public sessionClose(context: NativeContextHandle, session: SessionHandle): void {
    const handle = encodeContextHandle(context, session)
    nativeResult(
      "ot_session_close",
      this.opentui.symbols.ot_session_close(this.nativeContextPointer(context, "ot_session_close"), handle),
    )
  }

  public sessionCancel(context: NativeContextHandle, session: SessionHandle): void {
    const handle = encodeContextHandle(context, session)
    nativeResult(
      "ot_session_cancel",
      this.opentui.symbols.ot_session_cancel(this.nativeContextPointer(context, "ot_session_cancel"), handle),
    )
  }

  public sessionGetState(context: NativeContextHandle, session: SessionHandle): NativeSessionState {
    const handle = encodeContextHandle(context, session)
    const output = new Uint32Array(1)
    nativeResult(
      "ot_session_get_state",
      this.opentui.symbols.ot_session_get_state(
        this.nativeContextPointer(context, "ot_session_get_state"),
        handle,
        output,
      ),
    )
    return output[0]
  }

  public destroySession(context: NativeContextHandle, session: SessionHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, session)
    nativeResult(
      "ot_session_destroy",
      this.opentui.symbols.ot_session_destroy(this.nativeContextPointer(context, "ot_session_destroy"), handle),
    )
    // Session teardown also invalidates detached nodes. Ask native ownership only
    // for the sparse custom-provider set, never mirror every scene node in JS.
    const registrations = this.sceneMeasures.get(context)?.nodes
    if (!registrations) return
    for (const [slot, entry] of registrations) {
      try {
        this.sceneHasMeasure(context, entry.handle)
      } catch (error) {
        if (!(error instanceof NativeError) || error.status !== NativeStatus.StaleHandle) throw error
        registrations.delete(slot)
      }
    }
  }

  public sceneCreateNode(
    context: NativeContextHandle,
    session: SessionHandle,
    kind: (typeof SCENE_NODE_KINDS)[number],
    num: number,
  ): SceneNodeHandle {
    this.getYogaHost().assertMutable()
    const scratch = this.sceneCreateRecord ?? createSceneNodeRecord()
    this.sceneCreateRecord = undefined
    try {
      const handle = encodeContextHandle(context, session, scratch.handle.record, scratch.handle.words)
      const tag = SCENE_NODE_KINDS.indexOf(kind)
      if (tag < 0) throw new TypeError("Unknown scene node kind")
      const number = toSafeFFIU32Length(num, "Scene node number")
      const output = scratch.target.record
      const pointer = this.nativeContextPointer(context, "ot_scene_create_node")
      nativeResult(
        "ot_scene_create_node",
        this.opentui.symbols.ot_scene_create_node(pointer, handle, tag, number, output),
      )
      try {
        return decodeContextHandle(context, output, scratch.target.words)
      } catch (error) {
        const live = this.nativeContexts.get(context)
        if (live !== undefined) this.opentui.symbols.ot_scene_destroy_node(live, output)
        throw error
      }
    } finally {
      this.sceneCreateRecord ??= scratch
    }
  }

  public sceneDestroyNode(context: NativeContextHandle, node: SceneNodeHandle): void {
    this.getYogaHost().assertMutable()
    const scratch = this.sceneDestroyHandle ?? createContextHandleRecord()
    this.sceneDestroyHandle = undefined
    try {
      const handle = encodeContextHandle(context, node, scratch.record, scratch.words)
      const slot = scratch.words[nativeLayouts.ot_handle.fields.slot.offset / 4]
      const pointer = this.nativeContextPointer(context, "ot_scene_destroy_node")
      nativeResult("ot_scene_destroy_node", this.opentui.symbols.ot_scene_destroy_node(pointer, handle))
      this.sceneMeasures.get(context)?.nodes.delete(slot)
    } finally {
      this.sceneDestroyHandle ??= scratch
    }
  }

  public sceneSetMeasure(context: NativeContextHandle, node: SceneNodeHandle, measure: MeasureFunction | null): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const identity = decodeContextHandle(context, handle)
    const pointer = this.nativeContextPointer(context, "ot_scene_set_measure")
    let registration = this.sceneMeasures.get(context)
    const existing = registration !== undefined
    if (measure && !registration) {
      const nodes = new Map<number, { handle: SceneNodeHandle; measure: MeasureFunction }>()
      const callback = this.opentui.createCallback(
        (
          contextId: bigint,
          slot: number,
          generation: number,
          width: number,
          widthMode: number,
          height: number,
          heightMode: number,
          output: Pointer,
        ) => {
          this.getYogaHost().invokeCallback(() => {
            const entry = nodes.get(slot)
            if (!entry || entry.handle.contextId !== contextId || entry.handle.generation !== generation) {
              throw new Error("Native scene returned a stale measurement handle")
            }
            const result = entry.measure(width, widthMode, height, heightMode)
            rejectAsyncCallback(result)
            const dimensions = new Float32Array([result?.width ?? NaN, result?.height ?? NaN])
            new Float32Array(toArrayBuffer(output, 0, 8)).set(dimensions)
          })
        },
        nativeCallbacks.ot_scene_measure_callback,
      )
      if (!callback.ptr) {
        callback.close()
        throw new Error("Failed to create native scene measurement callback")
      }
      registration = { callback, nodes }
      this.sceneMeasures.set(context, registration)
    }
    try {
      nativeResult(
        "ot_scene_set_measure",
        this.opentui.symbols.ot_scene_set_measure(pointer, handle, measure ? registration!.callback.ptr : null),
      )
    } catch (error) {
      if (!existing && registration) {
        registration.callback.close()
        this.sceneMeasures.delete(context)
      }
      throw error
    }
    if (measure) {
      registration!.nodes.set(identity.slot, { handle: identity, measure })
    } else registration?.nodes.delete(identity.slot)
  }

  public sceneHasMeasure(context: NativeContextHandle, node: SceneNodeHandle): boolean {
    const handle = encodeContextHandle(context, node)
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_scene_has_measure")
    nativeResult("ot_scene_has_measure", this.opentui.symbols.ot_scene_has_measure(pointer, handle, output))
    return output[0] !== 0
  }

  public sceneMarkDirty(context: NativeContextHandle, node: SceneNodeHandle): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const pointer = this.nativeContextPointer(context, "ot_scene_mark_dirty")
    nativeResult("ot_scene_mark_dirty", this.opentui.symbols.ot_scene_mark_dirty(pointer, handle))
  }

  public sceneMoveNode(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    parent: SceneNodeHandle | null,
    index: number,
  ): void {
    this.getYogaHost().assertMutable()
    const scratch = this.sceneMoveRecord ?? createSceneNodeRecord()
    this.sceneMoveRecord = undefined
    try {
      const handle = encodeContextHandle(context, node, scratch.handle.record, scratch.handle.words)
      const destination =
        parent === null ? null : encodeContextHandle(context, parent, scratch.target.record, scratch.target.words)
      const childIndex = toSafeFFIU32Length(index, "Scene child index")
      const pointer = this.nativeContextPointer(context, "ot_scene_move_node")
      nativeResult(
        "ot_scene_move_node",
        this.opentui.symbols.ot_scene_move_node(pointer, handle, destination, childIndex),
      )
    } finally {
      this.sceneMoveRecord ??= scratch
    }
  }

  public sceneSetViewport(context: NativeContextHandle, node: SceneNodeHandle, viewport: SceneNodeHandle | null): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const target = viewport === null ? null : encodeContextHandle(context, viewport)
    const pointer = this.nativeContextPointer(context, "ot_scene_set_viewport")
    nativeResult("ot_scene_set_viewport", this.opentui.symbols.ot_scene_set_viewport(pointer, handle, target))
  }

  public sceneSetFocus(context: NativeContextHandle, node: SceneNodeHandle, focused: boolean): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const value = toFFIBool(focused, "Scene focused")
    const pointer = this.nativeContextPointer(context, "ot_scene_set_focus")
    nativeResult("ot_scene_set_focus", this.opentui.symbols.ot_scene_set_focus(pointer, handle, value))
  }

  public sceneGetStyle(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    group: number,
    kind: number,
    edge: number,
  ): { unit: number; value: number } {
    const layout = nativeLayouts.ot_scene_style_value
    const handle = encodeContextHandle(context, node)
    const styleGroup = toSafeFFIU32Length(group, "Scene style group")
    const styleKind = toSafeFFIU32Length(kind, "Scene style kind")
    const styleEdge = toSafeFFIU32Length(edge, "Scene style edge")
    const output = createContextRecord(layout)
    const values = new Float32Array(output.buffer)
    const pointer = this.nativeContextPointer(context, "ot_scene_get_style")
    nativeResult(
      "ot_scene_get_style",
      this.opentui.symbols.ot_scene_get_style(pointer, handle, styleGroup, styleKind, styleEdge, output),
    )
    return { unit: output[layout.fields.unit.offset / 4], value: values[layout.fields.value.offset / 4] }
  }

  public sceneSetBoxDetails(context: NativeContextHandle, node: SceneNodeHandle, details: NativeSceneBoxDetails): void {
    const layout = nativeLayouts.ot_scene_box_details
    const handle = encodeContextHandle(context, node)
    const record = createContextRecord(layout)
    const alignments = ["left", "center", "right"]
    const topAlignment = alignments.indexOf(details.titleAlignment)
    const bottomAlignment = alignments.indexOf(details.bottomTitleAlignment)
    if (topAlignment < 0 || bottomAlignment < 0) throw new TypeError("Unknown Box title alignment")
    record[layout.fields.title_alignment.offset / 4] = topAlignment
    record[layout.fields.bottom_title_alignment.offset / 4] = bottomAlignment
    const color = details.titleColor
    if (color !== undefined) {
      record[layout.fields.flags.offset / 4] |= 1
      new Uint16Array(record.buffer, layout.fields.title_color.offset, layout.fields.title_color.size / 2).set(
        contextBufferColor(color),
      )
    }
    const chars = details.customBorderChars
    if (chars !== undefined) {
      if (!(chars instanceof Uint32Array) || chars.length !== 11) throw new TypeError("Box borders require 11 scalars")
      record[layout.fields.flags.offset / 4] |= 2
      record.set(chars, layout.fields.border_characters.offset / 4)
    }
    const title = details.title ?? ""
    const bottomTitle = details.bottomTitle ?? ""
    if (typeof title !== "string" || typeof bottomTitle !== "string") throw new TypeError("Box titles must be strings")
    const topBytes = sessionBytes(this.encoder.encode(title), "Box title length")
    const bottomBytes = sessionBytes(this.encoder.encode(bottomTitle), "Box bottom title length")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_scene_set_box_details")
      nativeResult(
        "ot_scene_set_box_details",
        this.opentui.symbols.ot_scene_set_box_details(
          pointer,
          handle,
          record,
          viewOrNull(topBytes),
          topBytes.length,
          viewOrNull(bottomBytes),
          bottomBytes.length,
        ),
      )
    })
  }

  public sceneSetBoxBorderStyle(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    style: NativeScenePaint["borderStyle"],
    sides: number,
  ): void {
    const handle = encodeContextHandle(context, node)
    const kind = SCENE_BORDER_STYLES.indexOf(style)
    if (kind < 0) throw new TypeError("Unknown native scene border style")
    const mask = toSafeFFIU32Length(sides, "Box border sides")
    this.getYogaHost().runMutation(() => {
      const pointer = this.nativeContextPointer(context, "ot_scene_set_box_border_style")
      nativeResult(
        "ot_scene_set_box_border_style",
        this.opentui.symbols.ot_scene_set_box_border_style(pointer, handle, kind, mask),
      )
    })
  }

  public sceneSetSurface(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    buffer: ContextBufferHandle | null,
  ): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const source = buffer === null ? null : encodeContextHandle(context, buffer)
    const pointer = this.nativeContextPointer(context, "ot_scene_set_surface")
    nativeResult("ot_scene_set_surface", this.opentui.symbols.ot_scene_set_surface(pointer, handle, source))
  }

  /** Consume only native's accepted prefix. Allocation or admission failures leave
   * the suffix staged so a retry cannot lose writes or replay accepted entries. */
  public sceneFlush(context: NativeContextHandle, staging: SceneStaging): void {
    const operation = "ot_scene_flush"
    const styleCount = staging.styleCount
    const backgroundCount = staging.backgroundCount
    const paintCount = staging.paintCount
    if (styleCount === 0 && backgroundCount === 0 && paintCount === 0) return
    const applied = this.sceneFlushApplied ?? new Uint32Array(1)
    // Keep the acknowledgement isolated through callbacks and reentrant error handling.
    this.getYogaHost().runMutation(() => {
      const views = staging._views(context)
      this.sceneFlushApplied = undefined
      applied[0] = 0
      let status: NativeStatus
      try {
        const pointer = this.nativeContextPointer(context, operation)
        status = this.opentui.symbols.ot_scene_flush(
          pointer,
          views.styles,
          styleCount,
          views.backgrounds,
          backgroundCount,
          views.paints,
          paintCount,
          applied,
        )
      } finally {
        this.sceneFlushApplied ??= applied
        staging.consume(applied[0])
      }
      if (status !== NativeStatus.Ok) {
        const error = new NativeError(operation, status)
        error.message += ` after ${applied[0]} of ${styleCount + backgroundCount + paintCount} staged entries`
        throw error
      }
    })
  }

  public sceneSetText(context: NativeContextHandle, node: SceneNodeHandle, bytes: Uint8Array): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const input = sessionBytes(bytes, "Scene text length")
    const length = input.byteLength
    const pointer = this.nativeContextPointer(context, "ot_scene_set_text")
    nativeResult(
      "ot_scene_set_text",
      this.opentui.symbols.ot_scene_set_text(pointer, handle, length === 0 ? null : input, length),
    )
  }

  public sceneSetStyledText(context: NativeContextHandle, node: SceneNodeHandle, content: StyledText): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const { bytes, records, count, urlBytes } = this.encodeSceneStyledText(content)
    const pointer = this.nativeContextPointer(context, "ot_scene_set_styled_text_with_links")
    nativeResult(
      "ot_scene_set_styled_text_with_links",
      this.opentui.symbols.ot_scene_set_styled_text_with_links(
        pointer,
        handle,
        viewOrNull(bytes),
        bytes.length,
        count === 0 ? null : records,
        count,
        viewOrNull(urlBytes),
        urlBytes.length,
      ),
    )
  }

  private encodeSceneStyledText(content: StyledText, allowLinks = true, preserveChunkOrdinals = false) {
    if (typeof content !== "object" || content === null || isStyledText(content) !== true) {
      throw new TypeError("Native scene text requires a string or branded StyledText")
    }
    const chunks = content.chunks
    if (!Array.isArray(chunks)) throw new TypeError("Native scene StyledText requires a chunk array")
    const count = toSafeFFIU32Length(chunks.length, "Scene styled chunk count")
    const layout = allowLinks ? nativeLayouts.ot_scene_linked_text_chunk : nativeLayouts.ot_scene_text_chunk
    const stride = layout.size / 4
    const records = new Uint32Array(count * stride)
    const colors = new Uint16Array(records.buffer)
    const parts: Uint8Array[] = []
    const urls: Uint8Array[] = []
    let byteCount = 0
    let urlByteCount = 0
    for (let index = 0; index < count; index++) {
      const chunk = chunks[index]
      if (typeof chunk !== "object" || chunk === null) throw new TypeError("Invalid native scene StyledText chunk")
      const { __isChunk, text, fg, bg, attributes, link } = chunk
      if (__isChunk !== true || typeof text !== "string") throw new TypeError("Invalid native scene StyledText chunk")
      const foreground = fg === undefined ? undefined : contextBufferColor(fg)
      const background = bg === undefined ? undefined : contextBufferColor(bg)
      const attrs = attributes === undefined ? 0 : toSafeFFIU32Length(attributes, "Scene styled chunk attributes")
      if (attrs > ATTRIBUTE_BASE_MASK) throw new RangeError("Native scene StyledText supports only base attributes")
      let urlBytes: Uint8Array | undefined
      if (link !== undefined) {
        if (!allowLinks) throw new TypeError("Native editor placeholder does not support links")
        if (typeof link !== "object" || link === null) throw new TypeError("Invalid native scene StyledText link")
        const url = link.url
        if (typeof url !== "string") throw new TypeError("Native scene StyledText link requires a URL string")
        urlBytes = this.encoder.encode(url)
      }
      // Encode each chunk separately, preserving legacy replacement of split UTF-16 surrogates.
      const bytes = this.encoder.encode(text)
      if (bytes.length === 0 && !preserveChunkOrdinals) continue
      byteCount = toSafeFFIU32Length(byteCount + bytes.length, "Scene styled text length")
      const offset = parts.length * stride
      records[offset + layout.fields.struct_size.offset / 4] = layout.size
      records[offset + layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
      records[offset + layout.fields.byte_count.offset / 4] = bytes.length
      records[offset + layout.fields.flags.offset / 4] =
        (foreground ? 1 : 0) | (background ? 2 : 0) | (urlBytes ? 4 : 0)
      if (foreground) colors.set(foreground, offset * 2 + layout.fields.foreground.offset / 2)
      if (background) colors.set(background, offset * 2 + layout.fields.background.offset / 2)
      records[offset + layout.fields.attributes.offset / 4] = attrs
      if (urlBytes) {
        records[offset + nativeLayouts.ot_scene_linked_text_chunk.fields.link_offset.offset / 4] = urlByteCount
        records[offset + nativeLayouts.ot_scene_linked_text_chunk.fields.link_byte_count.offset / 4] = urlBytes.length
        urlByteCount = toSafeFFIU32Length(urlByteCount + urlBytes.length, "Scene styled URL length")
        urls.push(urlBytes)
      }
      parts.push(bytes)
    }
    const bytes = new Uint8Array(byteCount)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    const urlBytes = new Uint8Array(urlByteCount)
    offset = 0
    for (const url of urls) {
      urlBytes.set(url, offset)
      offset += url.length
    }
    return { bytes, records, count: parts.length, urlBytes }
  }

  public sceneSetSlider(context: NativeContextHandle, node: SceneNodeHandle, options: NativeSceneSliderOptions): void {
    const layout = nativeLayouts.ot_scene_slider_options
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const record = new Uint32Array(layout.size / 4)
    const values = new Float64Array(record.buffer)
    const colors = new Uint16Array(record.buffer)
    if (options.orientation !== "horizontal" && options.orientation !== "vertical") {
      throw new TypeError("Unknown scene slider orientation")
    }
    record[layout.fields.struct_size.offset / 4] = layout.size
    record[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    record[layout.fields.orientation.offset / 4] = options.orientation === "vertical" ? 1 : 0
    for (const [field, value] of [
      ["min", options.min],
      ["max", options.max],
      ["value", options.value],
      ["viewport_size", options.viewPortSize],
    ] as const) {
      if (!Number.isFinite(value)) throw new RangeError("Scene slider values must be finite numbers")
      values[layout.fields[field].offset / 8] = value
    }
    contextBufferColor(options.foregroundColor, colors, layout.fields.foreground.offset / 2)
    contextBufferColor(options.backgroundColor, colors, layout.fields.background.offset / 2)
    const pointer = this.nativeContextPointer(context, "ot_scene_set_slider")
    nativeResult("ot_scene_set_slider", this.opentui.symbols.ot_scene_set_slider(pointer, handle, record))
  }

  public sceneGetSliderThumb(context: NativeContextHandle, node: SceneNodeHandle): { size: number; start: number } {
    const layout = nativeLayouts.ot_scene_slider_thumb
    const handle = encodeContextHandle(context, node)
    const output = createContextRecord(layout)
    const values = new Float64Array(output.buffer)
    const pointer = this.nativeContextPointer(context, "ot_scene_get_slider_thumb")
    nativeResult("ot_scene_get_slider_thumb", this.opentui.symbols.ot_scene_get_slider_thumb(pointer, handle, output))
    return { size: values[layout.fields.size.offset / 8], start: values[layout.fields.start.offset / 8] }
  }

  public sceneSetArrow(context: NativeContextHandle, node: SceneNodeHandle, options: NativeSceneArrowOptions): void {
    const layout = nativeLayouts.ot_scene_arrow_options
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const direction = SCENE_ARROW_DIRECTIONS.indexOf(options.direction)
    if (direction < 0) throw new TypeError("Unknown scene arrow direction")
    const record = createContextRecord(layout)
    record[layout.fields.direction.offset / 4] = direction
    record[layout.fields.attributes.offset / 4] = toSafeFFIU32Length(options.attributes, "Scene arrow attributes")
    const colors = new Uint16Array(record.buffer)
    contextBufferColor(options.foregroundColor, colors, layout.fields.foreground.offset / 2)
    contextBufferColor(options.backgroundColor, colors, layout.fields.background.offset / 2)
    const text = options.text
    if (text !== undefined && typeof text !== "string") throw new TypeError("Scene arrow text must be a string")
    const bytes = text === undefined ? null : sessionBytes(this.encoder.encode(text), "Scene arrow text length")
    if (bytes && bytes.length > NATIVE_BUFFER_TEXT_BYTES_MAX) throw new RangeError("Scene arrow text is too long")
    const pointer = this.nativeContextPointer(context, "ot_scene_set_arrow")
    nativeResult(
      "ot_scene_set_arrow",
      this.opentui.symbols.ot_scene_set_arrow(
        pointer,
        handle,
        record,
        bytes?.length === 0 ? new Uint8Array(1) : bytes,
        bytes?.length ?? 0,
      ),
    )
  }

  public sceneSetTextOptions(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    options: NativeSceneTextOptions,
  ): void {
    const layout = nativeLayouts.ot_scene_text_options
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const record = new Uint32Array(layout.size / 4)
    const offsets = new Float64Array(record.buffer)
    record[layout.fields.struct_size.offset / 4] = layout.size
    record[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    const colors = new Uint16Array(record.buffer)
    contextBufferColor(options.fg, colors, layout.fields.foreground.offset / 2)
    contextBufferColor(options.bg, colors, layout.fields.background.offset / 2)
    record[layout.fields.attributes.offset / 4] = toSafeFFIU32Length(options.attributes, "Scene text attributes")
    const wrapMode = SCENE_TEXT_WRAP_MODES.indexOf(options.wrapMode)
    if (wrapMode < 0) throw new TypeError("Unknown scene text wrap mode")
    record[layout.fields.wrap_mode.offset / 4] = wrapMode
    record[layout.fields.truncate.offset / 4] = toFFIBool(options.truncate, "Scene text truncate")
    record[layout.fields.first_line_offset.offset / 4] = toSafeFFIU32Length(
      options.firstLineOffset,
      "Scene text firstLineOffset",
    )
    for (const [field, value] of [
      ["scroll_x", options.scrollX],
      ["scroll_y", options.scrollY],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 0x7fffffff) {
        throw new RangeError("Scene text scroll offsets must be finite numbers in 0..2147483647")
      }
      offsets[layout.fields[field].offset / 8] = value
    }
    const indicator = options.tabIndicator
    record[layout.fields.tab_indicator.offset / 4] = toSafeFFIU32Length(
      typeof indicator === "string" ? (indicator.codePointAt(0) ?? 0) : (indicator ?? 0),
      "Scene text tab indicator",
    )
    if (options.tabIndicatorColor !== undefined) {
      record[layout.fields.tab_color_set.offset / 4] = 1
      contextBufferColor(options.tabIndicatorColor, colors, layout.fields.tab_color.offset / 2)
    }
    const pointer = this.nativeContextPointer(context, "ot_scene_set_text_options")
    nativeResult("ot_scene_set_text_options", this.opentui.symbols.ot_scene_set_text_options(pointer, handle, record))
  }

  public sceneSetTextSelection(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    options: NativeSceneTextSelectionOptions,
  ): boolean {
    const layout = nativeLayouts.ot_scene_text_selection_options
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, node)
    const record = createContextRecord(layout)
    const operation = ["reset", "set", "update"].indexOf(options.operation)
    const behavior = ["cell", "word", "line"].indexOf(options.behavior)
    if (operation < 0 || behavior < 0) throw new TypeError("Unknown scene text selection operation or behavior")
    record[layout.fields.operation.offset / 4] = operation
    record[layout.fields.behavior.offset / 4] = behavior
    const coordinates = new Int32Array(record.buffer)
    for (const [field, value] of [
      ["anchor_x", options.anchorX],
      ["anchor_y", options.anchorY],
      ["focus_x", options.focusX],
      ["focus_y", options.focusY],
    ] as const) {
      if (!Number.isFinite(value) || value < -0x80000000 || value > 0x7fffffff) {
        throw new RangeError("Scene selection coordinates must fit signed 32-bit cells")
      }
      coordinates[layout.fields[field].offset / 4] = Math.trunc(value)
    }
    const colors = new Uint16Array(record.buffer)
    const bg = options.bg
    const fg = options.fg
    if (bg !== undefined) {
      record[layout.fields.flags.offset / 4] |= 1
      contextBufferColor(bg, colors, layout.fields.background.offset / 2)
    }
    if (fg !== undefined) {
      record[layout.fields.flags.offset / 4] |= 2
      contextBufferColor(fg, colors, layout.fields.foreground.offset / 2)
    }
    const changed = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_scene_set_text_selection")
    nativeResult(
      "ot_scene_set_text_selection",
      this.opentui.symbols.ot_scene_set_text_selection(pointer, handle, record, changed),
    )
    return changed[0] !== 0
  }

  public sceneGetTextSelection(
    context: NativeContextHandle,
    node: SceneNodeHandle,
  ): { start: number; end: number } | null {
    const handle = encodeContextHandle(context, node)
    const output = new BigUint64Array(1)
    const pointer = this.nativeContextPointer(context, "ot_scene_get_text_selection")
    nativeResult(
      "ot_scene_get_text_selection",
      this.opentui.symbols.ot_scene_get_text_selection(pointer, handle, output),
    )
    const packed = output[0]
    return packed === 0xffff_ffff_ffff_ffffn
      ? null
      : { start: Number(packed >> 32n), end: Number(packed & 0xffff_ffffn) }
  }

  public sceneGetSelectedText(context: NativeContextHandle, node: SceneNodeHandle): string {
    const handle = encodeContextHandle(context, node)
    const count = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_scene_get_selected_text")
    nativeResult(
      "ot_scene_get_selected_text",
      this.opentui.symbols.ot_scene_get_selected_text(pointer, handle, null, 0, count),
    )
    if (count[0] === 0) return ""
    const bytes = new Uint8Array(count[0])
    nativeResult(
      "ot_scene_get_selected_text",
      this.opentui.symbols.ot_scene_get_selected_text(pointer, handle, bytes, bytes.length, count),
    )
    return this.decoder.decode(bytes.subarray(0, count[0]))
  }

  public sceneGetTextMetrics(context: NativeContextHandle, node: SceneNodeHandle): NativeSceneTextMetrics {
    return this.sceneTextMetrics(context, encodeContextHandle(context, node))
  }

  private sceneTextMetrics(context: NativeContextHandle, handle: BigUint64Array): NativeSceneTextMetrics {
    const layout = nativeLayouts.ot_scene_text_info
    const output = createContextRecord(layout)
    const pointer = this.nativeContextPointer(context, "ot_scene_get_text_info")
    nativeResult("ot_scene_get_text_info", this.opentui.symbols.ot_scene_get_text_info(pointer, handle, output))
    return {
      byteLength: output[layout.fields.byte_count.offset / 4],
      textLength: output[layout.fields.text_length.offset / 4],
      lineCount: output[layout.fields.line_count.offset / 4],
      virtualLineCount: output[layout.fields.virtual_line_count.offset / 4],
      widthColsMax: output[layout.fields.width_cols_max.offset / 4],
    }
  }

  public sceneGetText(context: NativeContextHandle, node: SceneNodeHandle): string {
    const handle = encodeContextHandle(context, node)
    const count = new Uint32Array(1)
    return this.readText(
      "ot_scene_get_text",
      count,
      (bytes, capacity, count) =>
        this.opentui.symbols.ot_scene_get_text(
          this.nativeContextPointer(context, "ot_scene_get_text"),
          handle,
          bytes,
          capacity,
          count,
        ),
      "exact",
      true,
    )
  }

  public sceneGetTextLineInfo(context: NativeContextHandle, node: SceneNodeHandle): LineInfo {
    const handle = encodeContextHandle(context, node)
    const metrics = this.sceneTextMetrics(context, handle)
    const lines = new Uint32Array(metrics.virtualLineCount * (nativeLayouts.ot_scene_text_line.size / 4))
    const count = new Uint32Array(1)
    nativeResult(
      "ot_scene_get_text_lines",
      this.opentui.symbols.ot_scene_get_text_lines(
        this.nativeContextPointer(context, "ot_scene_get_text_lines"),
        handle,
        lines.length === 0 ? null : lines,
        metrics.virtualLineCount,
        count,
      ),
    )
    if (count[0] !== metrics.virtualLineCount)
      throw new NativeError("ot_scene_get_text_lines", NativeStatus.InternalError)
    return decodeContextTextLines(lines, metrics.widthColsMax)
  }

  public sceneGetLayout(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    rawYoga: boolean | "paint" = false,
  ): NativeSceneLayout {
    const layout = nativeLayouts.ot_scene_layout
    const scratch = this.sceneLayoutRecord ?? createSceneLayoutRecord()
    this.sceneLayoutRecord = undefined
    try {
      const handle = encodeContextHandle(context, node, scratch.handle.record, scratch.handle.words)
      const raw = rawYoga === "paint" ? 2 : toFFIBool(rawYoga, "Scene raw Yoga layout")
      const { output, values, coordinates } = scratch
      output[layout.fields.struct_size.offset / 4] = layout.size
      output[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
      const pointer = this.nativeContextPointer(context, "ot_scene_get_layout")
      nativeResult("ot_scene_get_layout", this.opentui.symbols.ot_scene_get_layout(pointer, handle, raw, output))
      return decodeSceneLayout(values, coordinates)
    } finally {
      this.sceneLayoutRecord ??= scratch
    }
  }

  public sceneSetHooks(
    context: NativeContextHandle,
    node: SceneNodeHandle,
    flags: number,
    generation: bigint,
    initialWidth: number,
    initialHeight: number,
  ): void {
    const layout = nativeLayouts.ot_scene_hooks
    this.getYogaHost().assertMutable()
    const scratch = this.sceneHooksRecord ?? createSceneHooksRecord()
    this.sceneHooksRecord = undefined
    try {
      const handle = encodeContextHandle(context, node, scratch.handle.record, scratch.handle.words)
      const { record, words, dimensions } = scratch
      words[layout.fields.struct_size.offset / 4] = layout.size
      words[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
      words[layout.fields.flags.offset / 4] = toSafeFFIU32Length(flags, "Scene hook flags")
      record[layout.fields.generation.offset / 8] = toFFIU64(generation, "Scene hook generation")
      for (const [field, value] of [
        ["initial_width", initialWidth],
        ["initial_height", initialHeight],
      ] as const) {
        if (!Number.isFinite(value) || value < 0 || value > 0x7fffffff) {
          throw new RangeError("Scene initial dimensions must be finite numbers in 0..2147483647")
        }
        dimensions[layout.fields[field].offset / 8] = value
      }
      const pointer = this.nativeContextPointer(context, "ot_scene_set_hooks")
      nativeResult("ot_scene_set_hooks", this.opentui.symbols.ot_scene_set_hooks(pointer, handle, record))
    } finally {
      this.sceneHooksRecord ??= scratch
    }
  }

  /** Paint options can change between steps; attempt limits remain fixed. */
  public sceneFrameStep(
    context: NativeContextHandle,
    session: SessionHandle,
    previous: NativeSceneFrameRequest | null,
    options: NativeSceneFrameOptions,
    maxPaintMembers?: number,
    maxWorkItems?: number,
  ): NativeSceneFrameRequest {
    const layout = nativeLayouts.ot_scene_frame_options
    this.getYogaHost().assertMutable()
    // Keep scratch checked out through callbacks, decoding, and failure cancellation.
    const scratch = this.sceneFrameRecord ?? createSceneFrameRecord()
    this.sceneFrameRecord = undefined
    try {
      const handle = encodeContextHandle(context, session, scratch.handle.record, scratch.handle.words)
      const { config, colors, words, geometry } = scratch
      contextBufferColor(options.background, colors, layout.fields.background.offset / 2)
      config[layout.fields.use_mouse.offset / 4] = toFFIBool(options.useMouse, "Scene useMouse")
      config[layout.fields.excluded_hit_num.offset / 4] = toSafeFFIU32Length(
        options.excludedHitNum,
        "Scene excluded hit number",
      )
      config[layout.fields.max_layout_rounds.offset / 4] = toSafeFFIU32Length(
        options.maxLayoutRounds,
        "Scene layout round limit",
      )
      config[layout.fields.max_host_requests.offset / 4] = toSafeFFIU32Length(
        options.maxHostRequests,
        "Scene host request limit",
      )
      config[layout.fields.preserve_unwritten.offset / 4] = toFFIBool(
        options.preserveUnwritten ?? false,
        "Scene preserve unwritten cells",
      )
      const budget =
        maxPaintMembers === undefined ? 0xffffffff : toSafeFFIU32Length(maxPaintMembers, "Scene paint budget")
      const workBudget = maxWorkItems === undefined ? 0xffffffff : toSafeFFIU32Length(maxWorkItems, "Scene work budget")
      if (workBudget === 0) throw new RangeError("Scene work budget must be positive")
      const output = encodeSceneFrameRequest(context, previous, scratch)
      const operation = "ot_scene_frame_step_with_geometry"
      const measures = this.sceneMeasures.get(context)?.nodes.size
      if (measures) this.getYogaHost().flushSceneMutations()
      const pointer = this.nativeContextPointer(context, operation)
      if (measures) {
        this.sceneFrameStepWithMeasures(
          context,
          pointer,
          handle,
          previous === null ? null : output,
          config,
          output,
          budget,
          workBudget,
          geometry,
        )
      } else {
        nativeResult(
          operation,
          this.opentui.symbols.ot_scene_frame_step_with_geometry(
            pointer,
            handle,
            previous === null ? null : output,
            config,
            budget,
            workBudget,
            output,
            geometry,
          ),
        )
      }
      try {
        const fields = nativeLayouts.ot_scene_frame_geometry.fields
        const flags = geometry[fields.flags.offset / 4]
        return {
          session: decodeContextHandle(context, scratch.session.record, scratch.session.words),
          root: decodeContextHandle(context, scratch.root.record, scratch.root.words),
          node: decodeContextHandle(context, scratch.node.record, scratch.node.words),
          frameId: output[nativeLayouts.ot_scene_frame_request.fields.frame_id.offset / 8],
          requestId: output[nativeLayouts.ot_scene_frame_request.fields.request_id.offset / 8],
          layoutEpoch: output[nativeLayouts.ot_scene_frame_request.fields.layout_epoch.offset / 8],
          hookGeneration: output[nativeLayouts.ot_scene_frame_request.fields.hook_generation.offset / 8],
          kind: words[nativeLayouts.ot_scene_frame_request.fields.kind.offset / 4] as NativeSceneFrameRequest["kind"],
          num: words[nativeLayouts.ot_scene_frame_request.fields.num.offset / 4],
          width: words[nativeLayouts.ot_scene_frame_request.fields.width.offset / 4],
          height: words[nativeLayouts.ot_scene_frame_request.fields.height.offset / 4],
          paintLayout:
            flags & nativeConstants.OT_SCENE_GEOMETRY_PAINT
              ? decodeSceneLayout(scratch.geometryValues, scratch.geometryCoordinates, fields.paint.offset)
              : undefined,
          publicLayout:
            flags & nativeConstants.OT_SCENE_GEOMETRY_PUBLIC
              ? decodeSceneLayout(scratch.geometryValues, scratch.geometryCoordinates, fields.public_layout.offset)
              : undefined,
          geometryRevision: undefined,
        }
      } catch (error) {
        const livePointer = this.nativeContexts.get(context)
        if (livePointer !== undefined)
          this.opentui.symbols.ot_scene_frame_cancel(
            livePointer,
            handle,
            output[nativeLayouts.ot_scene_frame_request.fields.frame_id.offset / 8],
          )
        throw error
      }
    } finally {
      this.sceneFrameRecord ??= scratch
    }
  }

  // Keep callback closure allocation and acceptance tracking off provider-free calls.
  private sceneFrameStepWithMeasures(
    context: NativeContextHandle,
    pointer: Pointer,
    handle: BigUint64Array,
    previous: BigUint64Array | null,
    config: Uint32Array,
    output: BigUint64Array,
    budget: number,
    workBudget: number,
    geometry: Uint32Array,
  ): void {
    let accepted = false
    try {
      this.getYogaHost().runMutation(() => {
        nativeResult(
          "ot_scene_frame_step_with_geometry",
          this.opentui.symbols.ot_scene_frame_step_with_geometry(
            pointer,
            handle,
            previous,
            config,
            budget,
            workBudget,
            output,
            geometry,
          ),
        )
        accepted = true
      })
    } catch (error) {
      const livePointer = this.nativeContexts.get(context)
      if (accepted && livePointer !== undefined)
        this.opentui.symbols.ot_scene_frame_cancel(
          livePointer,
          handle,
          output[nativeLayouts.ot_scene_frame_request.fields.frame_id.offset / 8],
        )
      throw error
    }
  }

  public sceneFrameAcquireBufferLease(
    context: NativeContextHandle,
    session: SessionHandle,
    frame: NativeSceneFrameRequest,
    which: SessionBuffer,
  ): NativeContextBufferLease {
    this.getYogaHost().assertMutable()
    if (which !== "current" && which !== "next") throw new TypeError("Session buffer must be current or next")
    if (!frame) throw new TypeError("Scene frame ticket is required")
    return this.acquireBufferLease(context, session, which, frame)
  }

  public sceneFrameCommit(
    context: NativeContextHandle,
    session: SessionHandle,
    frame: NativeSceneFrameRequest,
    force: boolean,
  ): NativeSessionRenderStatus {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, session)
    const ticket = encodeSceneFrameRequest(context, frame)
    const forceRender = toFFIBool(force, "Scene frame commit force")
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_scene_frame_commit")
    nativeResult(
      "ot_scene_frame_commit",
      this.opentui.symbols.ot_scene_frame_commit(pointer, handle, ticket, forceRender, output),
    )
    return output[0]
  }

  public sceneFrameCancel(context: NativeContextHandle, session: SessionHandle, frameId: bigint): void {
    this.getYogaHost().assertMutable()
    const handle = encodeContextHandle(context, session)
    const id = toFFIU64(frameId, "Scene frame ID")
    const pointer = this.nativeContextPointer(context, "ot_scene_frame_cancel")
    nativeResult("ot_scene_frame_cancel", this.opentui.symbols.ot_scene_frame_cancel(pointer, handle, id))
  }

  public sceneHitTest(context: NativeContextHandle, session: SessionHandle, x: number, y: number): number {
    const handle = encodeContextHandle(context, session)
    for (const coordinate of [x, y]) {
      if (!Number.isInteger(coordinate) || coordinate < -0x8000_0000 || coordinate > 0x7fff_ffff) {
        throw new RangeError("Scene hit coordinates must be signed 32-bit integers")
      }
    }
    const output = new Uint32Array(1)
    const pointer = this.nativeContextPointer(context, "ot_scene_hit_test")
    nativeResult("ot_scene_hit_test", this.opentui.symbols.ot_scene_hit_test(pointer, handle, x, y, output))
    return output[0]
  }

  public sceneGetStats(context: NativeContextHandle, session: SessionHandle): NativeRenderStats {
    const layout = nativeLayouts.ot_scene_stats
    const handle = encodeContextHandle(context, session)
    const output = new BigUint64Array(layout.size / 8)
    const words = new Uint32Array(output.buffer)
    const times = new Float64Array(output.buffer)
    words[layout.fields.struct_size.offset / 4] = layout.size
    words[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    const pointer = this.nativeContextPointer(context, "ot_scene_get_stats")
    nativeResult("ot_scene_get_stats", this.opentui.symbols.ot_scene_get_stats(pointer, handle, output))
    return {
      nativeLastFrameTime: times[layout.fields.last_frame_time.offset / 8],
      nativeAverageFrameTime: times[layout.fields.average_frame_time.offset / 8],
      nativeFrameCount: toNumber(output[layout.fields.frame_count.offset / 8]),
      cellsUpdated: words[layout.fields.cells_updated.offset / 4],
      averageCellsUpdated: words[layout.fields.average_cells_updated.offset / 4],
      nativeRenderTime:
        words[layout.fields.render_time_valid.offset / 4] !== 0
          ? times[layout.fields.render_time.offset / 8]
          : undefined,
      nativeStdoutWriteTime:
        words[layout.fields.stdout_write_time_valid.offset / 4] !== 0
          ? times[layout.fields.stdout_write_time.offset / 8]
          : undefined,
    }
  }

  public sceneGetCursorState(context: NativeContextHandle, session: SessionHandle): CursorState {
    const layout = nativeLayouts.ot_scene_cursor_state
    const handle = encodeContextHandle(context, session)
    const output = new Uint32Array(layout.size / 4)
    const colors = new Float32Array(output.buffer)
    output[layout.fields.struct_size.offset / 4] = layout.size
    output[layout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    const pointer = this.nativeContextPointer(context, "ot_scene_get_cursor_state")
    nativeResult("ot_scene_get_cursor_state", this.opentui.symbols.ot_scene_get_cursor_state(pointer, handle, output))
    return {
      x: output[layout.fields.x.offset / 4],
      y: output[layout.fields.y.offset / 4],
      visible: output[layout.fields.visible.offset / 4] !== 0,
      style: CURSOR_ID_TO_STYLE[output[layout.fields.style.offset / 4]] ?? "block",
      blinking: output[layout.fields.blinking.offset / 4] !== 0,
      color: RGBA.fromValues(
        colors[layout.fields.r.offset / 4],
        colors[layout.fields.g.offset / 4],
        colors[layout.fields.b.offset / 4],
        colors[layout.fields.a.offset / 4],
      ),
    }
  }

  constructor(libPath?: string) {
    this.opentui = getOpenTUILib(libPath)
    this.imageRetainIccCache()
    this.iccCacheClient = true
    try {
      this.setupLogging()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  public logContextDiagnostics(context: NativeContextHandle): void {
    const pointer = this.nativeContextPointer(context, "ot_context_drain_diagnostics")
    const layout = nativeLayouts.ot_diagnostic
    const drainLayout = nativeLayouts.ot_diagnostic_drain
    const capacity = 64 // Version 1 C Contexts hold at most 64 diagnostic records.
    // Own each drain's storage: console hooks can reenter or destroy the Context.
    const records = new Uint32Array((capacity * layout.size) / 4)
    const output = new BigUint64Array(drainLayout.size / 8)
    const words = new Uint32Array(output.buffer)
    words[drainLayout.fields.struct_size.offset / 4] = drainLayout.size
    words[drainLayout.fields.abi_version.offset / 4] = nativeConstants.OT_CONTEXT_ABI_VERSION
    nativeResult(
      "ot_context_drain_diagnostics",
      this.opentui.symbols.ot_context_drain_diagnostics(pointer, records, capacity, output),
    )
    const count = words[drainLayout.fields.count.offset / 4]
    if (count > capacity) throw new RangeError("Invalid diagnostic count")
    for (let index = 0; index < count; index++) {
      const offset = index * layout.size
      const level = records[(offset + layout.fields.level.offset) / 4]
      const length = records[(offset + layout.fields.message_len.offset) / 4]
      if (length > layout.fields.message.size) throw new RangeError("Invalid diagnostic message length")
      const bytes = new Uint8Array(records.buffer, offset + layout.fields.message.offset, length)
      this.logMessage(level, this.decoder.decode(bytes))
    }
  }

  private logMessage(level: number, message: string): void {
    switch (level) {
      case LogLevel.Error:
        console.error(message)
        break
      case LogLevel.Warn:
        console.warn(message)
        break
      case LogLevel.Info:
        console.info(message)
        break
      case LogLevel.Debug:
        console.debug(message)
        break
      default:
        console.log(message)
    }
  }

  private setupLogging() {
    if (this.logCallbackWrapper) {
      return
    }

    const logCallback = this.opentui.createCallback(
      (level: number, msgPtr: Pointer, msgLen: number) => {
        try {
          if (msgLen === 0 || !msgPtr) {
            return
          }

          const msgBuffer = toArrayBuffer(msgPtr, 0, msgLen)
          const msgBytes = new Uint8Array(msgBuffer)
          const message = this.decoder.decode(msgBytes)

          this.logMessage(level, message)
        } catch (error) {
          console.error("Error in Zig log callback:", error)
        }
      },
      {
        args: ["u8", "ptr", "u32"],
        returns: "void",
      },
    )

    this.logCallbackWrapper = logCallback

    if (!logCallback.ptr) {
      throw new Error("Failed to create log callback")
    }

    this.setLogCallback(logCallback.ptr)
  }

  private setLogCallback(callbackPtr: Pointer | null) {
    this.opentui.symbols.setLogCallback(callbackPtr)
  }

  public dispose(): void {
    if (this.disposed) return
    if (this.nativeContexts.size) {
      throw new NativeError("dispose", NativeStatus.ContextBusy)
    }
    if (this.clipboardServices.size > 0) {
      throw new Error("Cannot dispose OpenTUI native library while clipboard services are active")
    }
    this.yogaHost?.dispose()
    this.disposed = true
    try {
      this.setLogCallback(null)
    } finally {
      try {
        if (this.iccCacheClient) {
          this.iccCacheClient = false
          this.imageReleaseIccCache()
        }
      } finally {
        try {
          this.opentui.close()
        } finally {
          this.logCallbackWrapper = null
          this.nativeSpanFeedCallbackWrapper = null
          this.nativeSpanFeedHandlers.clear()
        }
      }
    }
  }

  private ensureNativeSpanFeedCallback(): FFICallbackInstance {
    if (this.nativeSpanFeedCallbackWrapper) {
      return this.nativeSpanFeedCallbackWrapper
    }

    const callback = this.opentui.createCallback(
      (streamPtr: Pointer, eventId: number, arg0: Pointer, arg1: number | bigint) => {
        const handler = this.nativeSpanFeedHandlers.get(streamPtr)
        if (handler) {
          handler(eventId, arg0, arg1)
        }
      },
      {
        args: ["ptr", "u32", "ptr", "u64"],
        returns: "void",
      },
    )

    this.nativeSpanFeedCallbackWrapper = callback

    if (!callback.ptr) {
      throw new Error("Failed to create native span feed callback")
    }

    return callback
  }

  public clipboardServiceCreate(
    maxConcurrentOperations: number,
    maxProviderTransfers: number,
    waylandSeat?: string,
  ): ClipboardServiceHandle | null {
    const seat = waylandSeat === undefined ? null : this.encoder.encode(waylandSeat)
    const handle = this.opentui.symbols.clipboardServiceCreate(
      toSafeFFIU32Length(maxConcurrentOperations, "clipboard operation limit"),
      toSafeFFIU32Length(maxProviderTransfers, "clipboard provider transfer limit"),
      seat,
      seat?.byteLength ?? 0,
    )
    if (handle === 0) return null
    const service = handle as ClipboardServiceHandle
    this.clipboardServices.add(service)
    return service
  }

  public clipboardServiceBeginShutdown(service: ClipboardServiceHandle): NativeClipboardShutdownStatus {
    if (!this.clipboardServices.has(service)) return NativeClipboardShutdownStatus.InvalidHandle
    return this.opentui.symbols.clipboardServiceBeginShutdown(service)
  }

  public clipboardServicePollShutdown(service: ClipboardServiceHandle): NativeClipboardShutdownStatus {
    if (!this.clipboardServices.has(service)) return NativeClipboardShutdownStatus.InvalidHandle
    return this.opentui.symbols.clipboardServicePollShutdown(service)
  }

  public clipboardServiceDestroy(service: ClipboardServiceHandle): NativeClipboardDestroyStatus {
    if (!this.clipboardServices.has(service)) return NativeClipboardDestroyStatus.InvalidHandle
    const status = this.opentui.symbols.clipboardServiceDestroy(service)
    if (status === NativeClipboardDestroyStatus.Destroyed) this.clipboardServices.delete(service)
    return status
  }

  public clipboardServiceDrain(service: ClipboardServiceHandle): number {
    if (!this.clipboardServices.has(service)) return 2
    return this.opentui.symbols.clipboardServiceDrain(service)
  }

  private clipboardStartResult(
    status: NativeClipboardStartStatus,
    output: Uint32Array,
  ): { status: NativeClipboardStartStatus; operation: ClipboardOperationHandle | null } {
    return {
      status,
      operation: output[0] === 0 ? null : (output[0] as ClipboardOperationHandle),
    }
  }

  public clipboardReadOperationStart(
    service: ClipboardServiceHandle,
    request: Uint8Array,
    selection: number,
    maxBytes: number,
    maxImagePixels: number,
    maxConversionBytes: number,
    timeoutMs: number,
  ): { status: NativeClipboardStartStatus; operation: ClipboardOperationHandle | null } {
    const output = new Uint32Array(1)
    const status = this.opentui.symbols.clipboardReadOperationStart(
      service,
      request,
      toSafeFFIU32Length(request.byteLength, "clipboard read request"),
      selection,
      toSafeFFIU32Length(maxBytes, "clipboard read byte limit"),
      toSafeFFIU32Length(maxImagePixels, "clipboard image pixel limit"),
      toSafeFFIU32Length(maxConversionBytes, "clipboard conversion byte limit"),
      toSafeFFIU32Length(timeoutMs, "clipboard read timeout"),
      output,
    )
    return this.clipboardStartResult(status, output)
  }

  public clipboardWriteOperationStart(
    service: ClipboardServiceHandle,
    textUtf8: Uint8Array,
    selection: number,
    timeoutMs: number,
  ): { status: NativeClipboardStartStatus; operation: ClipboardOperationHandle | null } {
    const output = new Uint32Array(1)
    const status = this.opentui.symbols.clipboardWriteOperationStart(
      service,
      textUtf8,
      toSafeFFIU32Length(textUtf8.byteLength, "clipboard write text"),
      selection,
      toSafeFFIU32Length(timeoutMs, "clipboard write timeout"),
      output,
    )
    return this.clipboardStartResult(status, output)
  }

  public clipboardClearOperationStart(
    service: ClipboardServiceHandle,
    selection: number,
    timeoutMs: number,
  ): { status: NativeClipboardStartStatus; operation: ClipboardOperationHandle | null } {
    const output = new Uint32Array(1)
    const status = this.opentui.symbols.clipboardClearOperationStart(
      service,
      selection,
      toSafeFFIU32Length(timeoutMs, "clipboard clear timeout"),
      output,
    )
    return this.clipboardStartResult(status, output)
  }

  public clipboardOperationPoll(operation: ClipboardOperationHandle): NativeClipboardOperationStatus {
    return this.opentui.symbols.clipboardOperationPoll(operation)
  }

  public clipboardOperationCancel(operation: ClipboardOperationHandle): NativeClipboardCancelStatus {
    return this.opentui.symbols.clipboardOperationCancel(operation)
  }

  private clipboardResultLength(
    symbol: (operation: ClipboardOperationHandle, output: Uint32Array) => number,
    operation: ClipboardOperationHandle,
  ): { status: NativeClipboardCopyStatus; length: number } {
    const output = new Uint32Array(1)
    const status = symbol(operation, output)
    return { status, length: output[0] }
  }

  public clipboardOperationResultMimeLength(operation: ClipboardOperationHandle): {
    status: NativeClipboardCopyStatus
    length: number
  } {
    return this.clipboardResultLength(this.opentui.symbols.clipboardOperationResultMimeLength, operation)
  }

  public clipboardOperationResultMimeCopy(
    operation: ClipboardOperationHandle,
    output: Uint8Array,
  ): NativeClipboardCopyStatus {
    return this.opentui.symbols.clipboardOperationResultMimeCopy(
      operation,
      output.byteLength === 0 ? null : output,
      toSafeFFIU32Length(output.byteLength, "clipboard MIME output"),
    )
  }

  public clipboardOperationResultDataLength(operation: ClipboardOperationHandle): {
    status: NativeClipboardCopyStatus
    length: number
  } {
    return this.clipboardResultLength(this.opentui.symbols.clipboardOperationResultDataLength, operation)
  }

  public clipboardOperationResultDataCopy(
    operation: ClipboardOperationHandle,
    output: Uint8Array,
  ): NativeClipboardCopyStatus {
    return this.opentui.symbols.clipboardOperationResultDataCopy(
      operation,
      output.byteLength === 0 ? null : output,
      toSafeFFIU32Length(output.byteLength, "clipboard data output"),
    )
  }

  public clipboardOperationResultErrorCode(operation: ClipboardOperationHandle): {
    status: NativeClipboardCopyStatus
    errorCode: number
  } {
    const output = new Uint32Array(1)
    const status = this.opentui.symbols.clipboardOperationResultErrorCode(operation, output)
    return { status, errorCode: output[0] }
  }

  public clipboardOperationResultDiagnosticLength(operation: ClipboardOperationHandle): {
    status: NativeClipboardCopyStatus
    length: number
  } {
    return this.clipboardResultLength(this.opentui.symbols.clipboardOperationResultDiagnosticLength, operation)
  }

  public clipboardOperationResultDiagnosticCopy(
    operation: ClipboardOperationHandle,
    output: Uint8Array,
  ): NativeClipboardCopyStatus {
    return this.opentui.symbols.clipboardOperationResultDiagnosticCopy(
      operation,
      output.byteLength === 0 ? null : output,
      toSafeFFIU32Length(output.byteLength, "clipboard diagnostic output"),
    )
  }

  public clipboardOperationDestroy(operation: ClipboardOperationHandle): NativeClipboardDestroyStatus {
    return this.opentui.symbols.clipboardOperationDestroy(operation)
  }

  public getYogaHost(): YogaHost {
    if (this.disposed) throw new Error("OpenTUI native library is disposed")
    return (this.yogaHost ??= new YogaHost(this))
  }

  private yogaMutation<Args extends unknown[], Result>(call: (...args: Args) => Result, ...args: Args): Result {
    return this.getYogaHost().runMutation(() => call(...args))
  }

  private yogaChecked(
    operation: Extract<keyof typeof yogaSymbols, `${string}Checked`>,
    mutation: boolean,
    ...args: unknown[]
  ): void {
    const call = () => {
      const signature = yogaSymbols[operation].args
      for (let index = 0; index < signature.length; index++) {
        if (signature[index] !== "u32") continue
        const value = args[index]
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
          throw new YogaError(operation, YogaStatus.InvalidArgument)
        }
      }
      const status = this.opentui.symbols[operation](...args)
      if (status !== YogaStatus.Ok) throw new YogaError(operation, status)
    }
    if (mutation) this.getYogaHost().runMutation(call)
    else call()
  }

  public yogaConfigCreate(): Pointer {
    this.yogaChecked("yogaConfigCreateChecked", true, this.yogaU64)
    return toPointer(this.yogaU64[0]!)
  }

  public yogaConfigFree(config: Pointer): void {
    this.yogaChecked("yogaConfigFreeChecked", true, config)
  }

  public yogaConfigSetCallbacks(config: Pointer, measure: Pointer, dirtied: Pointer): boolean {
    return Boolean(this.yogaMutation(this.opentui.symbols.yogaConfigSetCallbacks, config, measure, dirtied))
  }

  public yogaConfigClearCallbacks(config: Pointer, measure: Pointer): boolean {
    return Boolean(this.yogaMutation(this.opentui.symbols.yogaConfigClearCallbacks, config, measure))
  }

  public yogaConfigSetUseWebDefaults(config: Pointer, enabled: boolean): void {
    this.yogaChecked("yogaConfigSetUseWebDefaultsChecked", true, config, ffiBool(enabled))
  }

  public yogaConfigGetUseWebDefaults(config: Pointer): boolean {
    return Boolean(this.opentui.symbols.yogaConfigGetUseWebDefaults(config))
  }

  public yogaConfigSetPointScaleFactor(config: Pointer, pointScaleFactor: number): void {
    this.yogaChecked("yogaConfigSetPointScaleFactorChecked", true, config, pointScaleFactor)
  }

  public yogaConfigGetPointScaleFactor(config: Pointer): number {
    return this.opentui.symbols.yogaConfigGetPointScaleFactor(config)
  }

  public yogaConfigSetErrata(config: Pointer, errata: number): void {
    this.yogaChecked("yogaConfigSetErrataChecked", true, config, errata)
  }

  public yogaConfigGetErrata(config: Pointer): number {
    return this.opentui.symbols.yogaConfigGetErrata(config)
  }

  public yogaConfigSetExperimentalFeatureEnabled(config: Pointer, feature: number, enabled: boolean): void {
    this.yogaChecked("yogaConfigSetExperimentalFeatureEnabledChecked", true, config, feature, ffiBool(enabled))
  }

  public yogaConfigIsExperimentalFeatureEnabled(config: Pointer, feature: number): boolean {
    this.yogaChecked("yogaConfigIsExperimentalFeatureEnabledChecked", false, config, feature, this.yogaU32)
    return this.yogaU32[0] !== 0
  }

  public yogaNodeCreateForOpenTUI(): Pointer {
    this.yogaChecked("yogaNodeCreateForOpenTUIChecked", true, this.yogaU64)
    return toPointer(this.yogaU64[0]!)
  }

  public yogaNodeCreateWithConfig(config: Pointer): Pointer {
    this.yogaChecked("yogaNodeCreateWithConfigChecked", true, config, this.yogaU64)
    return toPointer(this.yogaU64[0]!)
  }

  public yogaNodeGetConfig(node: Pointer): Pointer {
    const config = this.opentui.symbols.yogaNodeGetConfig(node)
    if (!config) throw new Error("Failed to get Yoga node config")
    return config
  }

  public yogaNodeFree(node: Pointer): void {
    this.yogaChecked("yogaNodeFreeChecked", true, node)
  }

  public yogaNodeFreeRecursive(node: Pointer): void {
    this.yogaChecked("yogaNodeFreeRecursiveChecked", true, node)
  }

  public yogaNodeReset(node: Pointer): void {
    this.yogaChecked("yogaNodeResetChecked", true, node)
  }

  public yogaNodeCopyStyle(dstNode: Pointer, srcNode: Pointer): void {
    this.yogaChecked("yogaNodeCopyStyleChecked", true, dstNode, srcNode)
  }

  public yogaNodeInsertChild(node: Pointer, child: Pointer, index: number): void {
    this.yogaChecked("yogaNodeInsertChildChecked", true, node, child, index)
  }

  public yogaNodeRemoveChild(node: Pointer, child: Pointer): void {
    this.yogaChecked("yogaNodeRemoveChildChecked", true, node, child)
  }

  public yogaNodeRemoveAllChildren(node: Pointer): void {
    this.yogaChecked("yogaNodeRemoveAllChildrenChecked", true, node)
  }

  public yogaNodeGetChild(node: Pointer, index: number): Pointer | null {
    this.yogaChecked("yogaNodeGetChildChecked", false, node, index, this.yogaU64)
    return this.yogaU64[0] ? toPointer(this.yogaU64[0]) : null
  }

  public yogaNodeGetChildCount(node: Pointer): number {
    return this.opentui.symbols.yogaNodeGetChildCount(node)
  }

  public yogaNodeGetParent(node: Pointer): Pointer | null {
    return this.opentui.symbols.yogaNodeGetParent(node) || null
  }

  public yogaNodeCalculateLayout(node: Pointer, width: number, height: number, direction: number): void {
    this.getYogaHost().flushSceneMutations()
    this.yogaChecked("yogaNodeCalculateLayoutChecked", true, node, width, height, direction)
  }

  public yogaNodeIsDirty(node: Pointer): boolean {
    this.yogaChecked("yogaNodeIsDirtyChecked", false, node, this.yogaU32)
    return this.yogaU32[0] !== 0
  }

  public yogaNodeMarkDirty(node: Pointer): void {
    this.yogaChecked("yogaNodeMarkDirtyChecked", true, node)
  }

  public yogaNodeGetHasNewLayout(node: Pointer): boolean {
    this.yogaChecked("yogaNodeGetHasNewLayoutChecked", false, node, this.yogaU32)
    return this.yogaU32[0] !== 0
  }

  public yogaNodeSetHasNewLayout(node: Pointer, hasNewLayout: boolean): void {
    this.yogaChecked("yogaNodeSetHasNewLayoutChecked", true, node, ffiBool(hasNewLayout))
  }

  public yogaNodeSetIsReferenceBaseline(node: Pointer, isReferenceBaseline: boolean): void {
    this.yogaChecked("yogaNodeSetIsReferenceBaselineChecked", true, node, ffiBool(isReferenceBaseline))
  }

  public yogaNodeIsReferenceBaseline(node: Pointer): boolean {
    this.yogaChecked("yogaNodeIsReferenceBaselineChecked", false, node, this.yogaU32)
    return this.yogaU32[0] !== 0
  }

  public yogaNodeSetAlwaysFormsContainingBlock(node: Pointer, alwaysFormsContainingBlock: boolean): void {
    this.yogaChecked("yogaNodeSetAlwaysFormsContainingBlockChecked", true, node, ffiBool(alwaysFormsContainingBlock))
  }

  public yogaNodeGetAlwaysFormsContainingBlock(node: Pointer): boolean {
    this.yogaChecked("yogaNodeGetAlwaysFormsContainingBlockChecked", false, node, this.yogaU32)
    return this.yogaU32[0] !== 0
  }

  public yogaNodeGetComputedLayout(node: Pointer): NativeYogaLayout {
    const layout = this.yogaLayout
    this.yogaChecked("yogaNodeGetComputedLayoutChecked", false, node, layout)
    return {
      left: layout[0]!,
      top: layout[1]!,
      right: layout[2]!,
      bottom: layout[3]!,
      width: layout[4]!,
      height: layout[5]!,
    }
  }

  public yogaNodeLayoutGetEdge(node: Pointer, kind: number, edge: number): number {
    this.yogaChecked("yogaNodeLayoutGetEdgeChecked", false, node, kind, edge, this.yogaF32)
    return this.yogaF32[0]!
  }

  public yogaNodeStyleSetEnum(node: Pointer, kind: number, value: number): void {
    this.yogaChecked("yogaNodeStyleSetEnumChecked", true, node, kind, value)
  }

  public yogaNodeStyleGetEnum(node: Pointer, kind: number): number {
    this.yogaChecked("yogaNodeStyleGetEnumChecked", false, node, kind, this.yogaU32)
    return this.yogaU32[0]!
  }

  public yogaNodeStyleSetFloat(node: Pointer, kind: number, value: number): void {
    this.yogaChecked("yogaNodeStyleSetFloatChecked", true, node, kind, value)
  }

  public yogaNodeStyleGetFloat(node: Pointer, kind: number): number {
    this.yogaChecked("yogaNodeStyleGetFloatChecked", false, node, kind, this.yogaF32)
    return this.yogaF32[0]!
  }

  public yogaNodeStyleSetBorder(node: Pointer, edge: number, border: number): void {
    this.yogaChecked("yogaNodeStyleSetBorderChecked", true, node, edge, border)
  }

  public yogaNodeStyleGetBorder(node: Pointer, edge: number): number {
    this.yogaChecked("yogaNodeStyleGetBorderChecked", false, node, edge, this.yogaF32)
    return this.yogaF32[0]!
  }

  public yogaNodeStyleSetValue(node: Pointer, kind: number, edgeOrGutter: number, unit: number, value: number): void {
    this.yogaChecked("yogaNodeStyleSetValueChecked", true, node, kind, edgeOrGutter, unit, value)
  }

  public yogaNodeStyleSetDimension(
    node: Pointer,
    kind: number,
    unit: number,
    value: number,
    disableFlexShrink: boolean,
  ): void {
    this.yogaChecked("yogaNodeStyleSetDimensionChecked", true, node, kind, unit, value, ffiBool(disableFlexShrink))
  }

  public yogaNodeStyleSetPositions(node: Pointer, edgeMask: number, units: Uint32Array, values: Float32Array): void {
    if (units.length !== 4 || values.length !== 4) {
      throw new YogaError("yogaNodeStyleSetPositionsChecked", YogaStatus.InvalidArgument)
    }
    this.yogaChecked("yogaNodeStyleSetPositionsChecked", true, node, edgeMask, units, values)
  }

  public yogaNodeStyleGetValue(node: Pointer, kind: number, edgeOrGutter: number): number | bigint {
    this.yogaChecked("yogaNodeStyleGetValueChecked", false, node, kind, edgeOrGutter, this.yogaU64)
    return this.yogaU64[0]!
  }

  public yogaNodeSetMeasureFunc(node: Pointer, enabled: boolean): void {
    this.yogaChecked("yogaNodeSetMeasureFuncChecked", true, node, ffiBool(enabled))
  }

  public yogaNodeUnsetMeasureFunc(node: Pointer): void {
    this.yogaChecked("yogaNodeUnsetMeasureFuncChecked", true, node)
  }

  public yogaNodeHasMeasureFunc(node: Pointer): boolean {
    // Node's FFI returns bools as 0/1 numbers; normalize so the interface stays truthful.
    return Boolean(this.opentui.symbols.yogaNodeHasMeasureFunc(node))
  }

  public yogaNodeSetDirtiedFunc(node: Pointer, enabled: boolean): void {
    this.yogaChecked("yogaNodeSetDirtiedFuncChecked", true, node, ffiBool(enabled))
  }

  public yogaNodeUnsetDirtiedFunc(node: Pointer): void {
    this.yogaChecked("yogaNodeUnsetDirtiedFuncChecked", true, node)
  }

  public yogaStoreMeasureResult(config: Pointer, width: number, height: number): void {
    this.opentui.symbols.yogaStoreMeasureResult(config, width, height)
  }

  public createYogaMeasureCallback(callback: NativeYogaMeasureCallback): FFICallbackInstance {
    const host = this.getYogaHost()
    return this.opentui.createCallback(
      (...args: Parameters<NativeYogaMeasureCallback>) => {
        host.invokeCallback(() => callback(...args))
      },
      {
        args: ["ptr", "f32", "u32", "f32", "u32"],
        returns: "void",
      },
    )
  }

  public createYogaDirtiedCallback(callback: NativeYogaDirtiedCallback): FFICallbackInstance {
    const host = this.getYogaHost()
    return this.opentui.createCallback(
      (node: Pointer | null) => {
        host.invokeCallback(() => callback(node))
      },
      {
        args: ["ptr"],
        returns: "void",
      },
    )
  }

  public getArenaAllocatedBytes(): number {
    const result = this.opentui.symbols.getArenaAllocatedBytes()
    return toSafeByteCount(result, "Arena allocated bytes")
  }

  public getBuildOptions(): BuildOptions {
    const optionsBuffer = new ArrayBuffer(BuildOptionsStruct.size)
    this.opentui.symbols.getBuildOptions(optionsBuffer)
    const options = BuildOptionsStruct.unpack(optionsBuffer)

    return {
      gpaSafeStats: !!options.gpaSafeStats,
      gpaMemoryLimitTracking: !!options.gpaMemoryLimitTracking,
    }
  }

  public getAllocatorStats(): AllocatorStats {
    const statsBuffer = new ArrayBuffer(AllocatorStatsStruct.size)
    this.opentui.symbols.getAllocatorStats(statsBuffer)
    const stats = AllocatorStatsStruct.unpack(statsBuffer)

    return {
      totalRequestedBytes: toNumber(stats.totalRequestedBytes),
      activeAllocations: toNumber(stats.activeAllocations),
      smallAllocations: toNumber(stats.smallAllocations),
      largeAllocations: toNumber(stats.largeAllocations),
      requestedBytesValid: !!stats.requestedBytesValid,
    }
  }

  public createAudioEngine(options?: AudioCreateOptions | null): AudioEngineHandle | null {
    const optionsBuffer = options == null ? null : AudioCreateOptionsStruct.pack(options)
    const engineHandle = this.opentui.symbols.createAudioEngine(optionsBuffer) as AudioEngineHandle
    return engineHandle ? engineHandle : null
  }

  public destroyAudioEngine(engine: AudioEngineHandle): void {
    this.opentui.symbols.destroyAudioEngine(engine)
  }

  public audioRefreshPlaybackDevices(engine: AudioEngineHandle): number {
    return this.opentui.symbols.audioRefreshPlaybackDevices(engine)
  }

  public audioGetPlaybackDeviceCount(engine: AudioEngineHandle): number {
    return this.opentui.symbols.audioGetPlaybackDeviceCount(engine)
  }

  public audioGetPlaybackDeviceName(engine: AudioEngineHandle, index: number): string {
    const outBuffer = new Uint8Array(512)
    const bytesWritten = toNumber(
      this.opentui.symbols.audioGetPlaybackDeviceName(engine, index, outBuffer, outBuffer.length),
    )
    const safeBytesWritten = Math.max(0, Math.min(outBuffer.length, bytesWritten))
    return this.decoder.decode(outBuffer.subarray(0, safeBytesWritten))
  }

  public audioIsPlaybackDeviceDefault(engine: AudioEngineHandle, index: number): boolean {
    return this.opentui.symbols.audioIsPlaybackDeviceDefault(engine, index)
  }

  public audioSelectPlaybackDevice(engine: AudioEngineHandle, index: number): number {
    return this.opentui.symbols.audioSelectPlaybackDevice(engine, index)
  }

  public audioClearPlaybackDeviceSelection(engine: AudioEngineHandle): void {
    this.opentui.symbols.audioClearPlaybackDeviceSelection(engine)
  }

  public audioRefreshCaptureDevices(engine: AudioEngineHandle): number {
    return this.opentui.symbols.audioRefreshCaptureDevices(engine)
  }

  public audioGetCaptureDeviceCount(engine: AudioEngineHandle): number {
    return this.opentui.symbols.audioGetCaptureDeviceCount(engine)
  }

  public audioGetCaptureDeviceName(engine: AudioEngineHandle, index: number): string {
    const outBuffer = new Uint8Array(512)
    const bytesWritten = toNumber(
      this.opentui.symbols.audioGetCaptureDeviceName(engine, index, outBuffer, outBuffer.length),
    )
    const safeBytesWritten = Math.max(0, Math.min(outBuffer.length, bytesWritten))
    return this.decoder.decode(outBuffer.subarray(0, safeBytesWritten))
  }

  public audioIsCaptureDeviceDefault(engine: AudioEngineHandle, index: number): boolean {
    return Boolean(this.opentui.symbols.audioIsCaptureDeviceDefault(engine, index))
  }

  public audioSelectCaptureDevice(engine: AudioEngineHandle, index: number): number {
    return this.opentui.symbols.audioSelectCaptureDevice(engine, index)
  }

  public audioClearCaptureDeviceSelection(engine: AudioEngineHandle): void {
    this.opentui.symbols.audioClearCaptureDeviceSelection(engine)
  }

  public audioStartCapture(
    engine: AudioEngineHandle,
    options: AudioStartOptions | undefined,
    channels: number,
    capacityFrames: number,
  ): number {
    let optionsBuffer: ArrayBuffer
    try {
      const noFixedSizedCallback = options?.noFixedSizedCallback
      optionsBuffer = AudioStartOptionsStruct.pack(options ?? {})
      if (noFixedSizedCallback === undefined) {
        const field = AudioStartOptionsStruct.layoutByName.get("noFixedSizedCallback")
        if (!field) return -1
        new DataView(optionsBuffer).setUint8(field.offset, 1)
      }
    } catch {
      return -1
    }
    return this.opentui.symbols.audioStartCapture(engine, optionsBuffer, channels, capacityFrames)
  }

  public audioStopCapture(engine: AudioEngineHandle): number {
    return this.opentui.symbols.audioStopCapture(engine)
  }

  public audioIsCaptureRunning(engine: AudioEngineHandle): boolean {
    return Boolean(this.opentui.symbols.audioIsCaptureRunning(engine))
  }

  public audioReadCapture(
    engine: AudioEngineHandle,
    outBuffer: Float32Array,
    frameCount: number,
  ): { status: number; framesRead: number } {
    const outFramesReadBuffer = new ArrayBuffer(4)
    const sampleCapacity = toSafeFFIU32Length(outBuffer.length, "Audio capture output sample capacity")
    const status = this.opentui.symbols.audioReadCapture(
      engine,
      outBuffer,
      sampleCapacity,
      frameCount,
      outFramesReadBuffer,
    )
    if (status !== 0) return { status, framesRead: 0 }
    return { status, framesRead: new Uint32Array(outFramesReadBuffer)[0] ?? 0 }
  }

  public audioGetCaptureStats(engine: AudioEngineHandle): { status: number; stats: NativeAudioCaptureStats | null } {
    const statsBuffer = new ArrayBuffer(AudioCaptureStatsStruct.size)
    const status = this.opentui.symbols.audioGetCaptureStats(engine, statsBuffer)
    if (status !== 0) return { status, stats: null }
    const stats = AudioCaptureStatsStruct.unpack(statsBuffer)
    return {
      status,
      stats: {
        framesReceived: typeof stats.framesReceived === "bigint" ? stats.framesReceived : BigInt(stats.framesReceived),
        framesRead: typeof stats.framesRead === "bigint" ? stats.framesRead : BigInt(stats.framesRead),
        framesDropped: typeof stats.framesDropped === "bigint" ? stats.framesDropped : BigInt(stats.framesDropped),
        sampleRate: stats.sampleRate,
        channels: stats.channels,
        bufferedFrames: stats.bufferedFrames,
        capacityFrames: stats.capacityFrames,
      },
    }
  }

  public audioStart(engine: AudioEngineHandle, options?: AudioStartOptions | null): number {
    let optionsBuffer: ArrayBuffer | null
    try {
      optionsBuffer = options == null ? null : AudioStartOptionsStruct.pack(options)
    } catch {
      return -1
    }
    return this.opentui.symbols.audioStart(engine, optionsBuffer)
  }

  public audioStartMixer(engine: AudioEngineHandle): number {
    return this.opentui.symbols.audioStartMixer(engine)
  }

  public audioStop(engine: AudioEngineHandle): number {
    return this.opentui.symbols.audioStop(engine)
  }

  public audioCreateStream(
    engine: AudioEngineHandle,
    options: AudioStreamCreateOptions,
  ): { status: number; streamId: number | null } {
    if (
      !isFFIU32(options.groupId) ||
      (options.format !== NativeAudioStreamFormat.Mp3 && options.format !== NativeAudioStreamFormat.Flac)
    ) {
      return { status: -1, streamId: null }
    }
    const optionsBuffer = AudioStreamCreateOptionsStruct.pack(options)
    const outBuffer = new ArrayBuffer(4)
    const status = this.opentui.symbols.audioCreateStream(engine, optionsBuffer, outBuffer)
    if (status !== 0) return { status, streamId: null }
    return { status, streamId: new Uint32Array(outBuffer)[0] ?? null }
  }

  public audioWriteStream(engine: AudioEngineHandle, streamId: number, data: Uint8Array): number {
    const dataLength = toSafeFFIU32Length(data.byteLength, "Audio stream data length")
    return this.opentui.symbols.audioWriteStream(engine, streamId, dataLength === 0 ? null : data, dataLength)
  }

  public audioEndStream(engine: AudioEngineHandle, streamId: number): number {
    return this.opentui.symbols.audioEndStream(engine, streamId)
  }

  public audioRestartStream(engine: AudioEngineHandle, streamId: number): number {
    return this.opentui.symbols.audioRestartStream(engine, streamId)
  }

  public audioSetStreamVolume(engine: AudioEngineHandle, streamId: number, volume: number): number {
    return this.opentui.symbols.audioSetStreamVolume(engine, streamId, volume)
  }

  public audioSetStreamPan(engine: AudioEngineHandle, streamId: number, pan: number): number {
    return this.opentui.symbols.audioSetStreamPan(engine, streamId, pan)
  }

  public audioSetStreamGroup(engine: AudioEngineHandle, streamId: number, groupId: number): number {
    if (!isFFIU32(groupId)) return -1
    return this.opentui.symbols.audioSetStreamGroup(engine, streamId, groupId)
  }

  public audioGetStreamStats(engine: AudioEngineHandle, streamId: number): NativeAudioStreamStats | null {
    const storage = this.ffiStructStorage.audioStreamStats
    const status = this.opentui.symbols.audioGetStreamStats(engine, streamId, storage.buffer)
    if (status !== 0) return null
    const stats = AudioStreamStatsStruct.unpackInto(storage.view, storage.result) as NativeAudioStreamStats
    return { ...stats }
  }

  public audioCloseStream(
    engine: AudioEngineHandle,
    streamId: number,
    reason: NativeAudioStreamCloseReason,
  ): { status: number; stats: NativeAudioStreamStats | null } {
    const storage = this.ffiStructStorage.audioStreamStats
    const status = this.opentui.symbols.audioCloseStream(engine, streamId, reason, storage.buffer)
    if (status !== 0) return { status, stats: null }
    const stats = AudioStreamStatsStruct.unpackInto(storage.view, storage.result) as NativeAudioStreamStats
    return { status, stats: { ...stats } }
  }

  public audioLoad(engine: AudioEngineHandle, data: Uint8Array): { status: number; soundId: number | null } {
    const outBuffer = new ArrayBuffer(4)
    const dataLength = toSafeFFIU32Length(data.byteLength, "Audio data length")
    const status = this.opentui.symbols.audioLoad(engine, data, dataLength, outBuffer)
    if (status !== 0) {
      return { status, soundId: null }
    }
    const view = new Uint32Array(outBuffer)
    return { status, soundId: view[0] }
  }

  public audioUnload(engine: AudioEngineHandle, soundId: number): number {
    return this.opentui.symbols.audioUnload(engine, soundId)
  }

  public audioPlay(
    engine: AudioEngineHandle,
    soundId: number,
    options?: AudioVoiceOptions,
  ): { status: number; voiceId: number | null } {
    if (options?.groupId !== undefined && !isFFIU32(options.groupId)) return { status: -1, voiceId: null }
    const outBuffer = new ArrayBuffer(4)
    const optionsBuffer = options ? AudioVoiceOptionsStruct.pack(options) : null
    const status = this.opentui.symbols.audioPlay(engine, soundId, optionsBuffer, outBuffer)
    if (status !== 0) {
      return { status, voiceId: null }
    }
    const view = new Uint32Array(outBuffer)
    return { status, voiceId: view[0] }
  }

  public audioStopVoice(engine: AudioEngineHandle, voiceId: number): number {
    return this.opentui.symbols.audioStopVoice(engine, voiceId)
  }

  public audioSetVoiceGroup(engine: AudioEngineHandle, voiceId: number, groupId: number): number {
    if (!isFFIU32(groupId)) return -1
    return this.opentui.symbols.audioSetVoiceGroup(engine, voiceId, groupId)
  }

  public audioCreateGroup(engine: AudioEngineHandle, name: string): { status: number; groupId: number | null } {
    const outBuffer = new ArrayBuffer(4)
    const nameBytes = this.encoder.encode(name)
    const nameLength = toSafeFFIU32Length(nameBytes.byteLength, "Audio group name length")
    const status = this.opentui.symbols.audioCreateGroup(engine, nameBytes, nameLength, outBuffer)
    if (status !== 0) {
      return { status, groupId: null }
    }
    const view = new Uint32Array(outBuffer)
    return { status, groupId: view[0] }
  }

  public audioSetGroupVolume(engine: AudioEngineHandle, groupId: number, volume: number): number {
    return this.opentui.symbols.audioSetGroupVolume(engine, groupId, volume)
  }

  public audioSetMasterVolume(engine: AudioEngineHandle, volume: number): number {
    return this.opentui.symbols.audioSetMasterVolume(engine, volume)
  }

  public audioMixToBuffer(
    engine: AudioEngineHandle,
    outBuffer: Float32Array,
    frameCount: number,
    channels: number,
  ): number {
    return this.opentui.symbols.audioMixToBuffer(engine, outBuffer, frameCount, channels)
  }

  public audioEnableTap(engine: AudioEngineHandle, enabled: boolean, capacityFrames: number): number {
    return this.opentui.symbols.audioEnableTap(engine, ffiBool(enabled), capacityFrames)
  }

  public audioReadTap(
    engine: AudioEngineHandle,
    outBuffer: Float32Array,
    frameCount: number,
    channels: number,
  ): { status: number; framesRead: number } {
    const outFramesReadBuffer = new ArrayBuffer(4)
    const status = this.opentui.symbols.audioReadTap(engine, outBuffer, frameCount, channels, outFramesReadBuffer)
    if (status !== 0) {
      return { status, framesRead: 0 }
    }
    const view = new Uint32Array(outFramesReadBuffer)
    return { status, framesRead: view[0] ?? 0 }
  }

  public audioGetStats(engine: AudioEngineHandle): AudioStats | null {
    const statsBuffer = new ArrayBuffer(AudioStatsStruct.size)
    const status = this.opentui.symbols.audioGetStats(engine, statsBuffer)
    if (status !== 0) {
      return null
    }
    const stats = AudioStatsStruct.unpack(statsBuffer)
    return {
      soundsLoaded: stats.soundsLoaded,
      voicesActive: stats.voicesActive,
      framesMixed: typeof stats.framesMixed === "bigint" ? stats.framesMixed : BigInt(stats.framesMixed),
      lockMisses: stats.lockMisses,
      lastPeak: stats.lastPeak,
      lastRms: stats.lastRms,
    }
  }

  public registerNativeSpanFeedStream(stream: Pointer, handler: NativeSpanFeedEventHandler): void {
    const callback = this.ensureNativeSpanFeedCallback()
    this.nativeSpanFeedHandlers.set(stream, handler)
    this.opentui.symbols.streamSetCallback(stream, callback.ptr)
  }

  public unregisterNativeSpanFeedStream(stream: Pointer): void {
    this.opentui.symbols.streamSetCallback(stream, null)
    this.nativeSpanFeedHandlers.delete(stream)
  }

  public createNativeSpanFeed(options?: NativeSpanFeedOptions | null): Pointer {
    const optionsBuffer = options == null ? null : NativeSpanFeedOptionsStruct.pack(options)
    const streamPtr = this.opentui.symbols.createNativeSpanFeed(optionsBuffer)
    if (!streamPtr) {
      throw new Error("Failed to create stream")
    }
    return streamPtr
  }

  public attachNativeSpanFeed(stream: Pointer): number {
    return this.opentui.symbols.attachNativeSpanFeed(stream)
  }

  public destroyNativeSpanFeed(stream: Pointer): number {
    const status = this.opentui.symbols.destroyNativeSpanFeed(stream)
    if (status === 0) this.nativeSpanFeedHandlers.delete(stream)
    return status
  }

  public streamWrite(stream: Pointer, data: Uint8Array | string): number {
    const bytes = typeof data === "string" ? this.encoder.encode(data) : data
    return this.opentui.symbols.streamWrite(stream, viewOrNull(bytes), bytes.byteLength)
  }

  public streamCommit(stream: Pointer): number {
    return this.opentui.symbols.streamCommit(stream)
  }

  public streamDrainSpans(stream: Pointer, outBuffer: Uint8Array, maxSpans: number): number {
    if (!Number.isInteger(maxSpans) || maxSpans < 0 || maxSpans > outBuffer.byteLength / SpanInfoStruct.size) {
      throw new RangeError("Span drain buffer is too small")
    }
    const count = this.opentui.symbols.streamDrainSpans(stream, outBuffer, maxSpans)
    return toNumber(count)
  }

  public streamReleaseSpan(stream: Pointer, slotIndex: number, releaseId: bigint): number {
    return this.opentui.symbols.streamReleaseSpan(stream, slotIndex, releaseId)
  }

  public streamClose(stream: Pointer): number {
    return this.opentui.symbols.streamClose(stream)
  }

  public streamGetStats(stream: Pointer): NativeSpanFeedStats | null {
    const statsBuffer = new ArrayBuffer(NativeSpanFeedStatsStruct.size)
    const status = this.opentui.symbols.streamGetStats(stream, statsBuffer)
    if (status !== 0) {
      return null
    }
    const stats = NativeSpanFeedStatsStruct.unpack(statsBuffer)
    return {
      bytesWritten: typeof stats.bytesWritten === "bigint" ? stats.bytesWritten : BigInt(stats.bytesWritten),
      spansCommitted: typeof stats.spansCommitted === "bigint" ? stats.spansCommitted : BigInt(stats.spansCommitted),
      chunks: stats.chunks,
      pendingSpans: stats.pendingSpans,
      outstandingSpans: stats.outstandingSpans,
      outstandingBytes: BigInt(stats.outstandingBytes),
    }
  }

  public streamReserve(stream: Pointer, minLen: number): { status: number; info: ReserveInfo | null } {
    const reserveBuffer = new ArrayBuffer(ReserveInfoStruct.size)
    const status = this.opentui.symbols.streamReserve(stream, minLen, reserveBuffer)
    if (status !== 0) {
      return { status, info: null }
    }
    return { status, info: ReserveInfoStruct.unpack(reserveBuffer) }
  }

  public streamCommitReserved(stream: Pointer, length: number): number {
    return this.opentui.symbols.streamCommitReserved(stream, length)
  }

  private imageHandleResult(status: number, output: Uint32Array): { status: number; handle: ImageHandle | null } {
    return { status, handle: status === 0 && output[0] !== 0 ? (output[0] as ImageHandle) : null }
  }

  public imageInfo(data: Uint8Array): { status: number; info: NativeImageInfo } {
    const length = toSafeFFIU32Length(data.byteLength, "image data")
    const output = new ArrayBuffer(NativeImageInfoStruct.size)
    const status = this.opentui.symbols.imageInfo(data.byteLength === 0 ? null : data, length, output)
    return { status, info: NativeImageInfoStruct.unpack(output) }
  }

  public imageDecode(data: Uint8Array): { status: number; handle: ImageHandle | null } {
    const length = toSafeFFIU32Length(data.byteLength, "image data")
    const output = new Uint32Array(1)
    return this.imageHandleResult(
      this.opentui.symbols.imageDecode(data.byteLength === 0 ? null : data, length, output),
      output,
    )
  }

  public imageCreateFromRgba(
    pixels: Uint8Array,
    width: number,
    height: number,
    stride: number,
  ): { status: number; handle: ImageHandle | null } {
    const output = new Uint32Array(1)
    const status = this.opentui.symbols.imageCreateFromRgba(
      pixels.byteLength === 0 ? null : pixels,
      BigInt(pixels.byteLength),
      width,
      height,
      stride,
      output,
    )
    return this.imageHandleResult(status, output)
  }

  public imageCreateFromPixels(
    pixels: Uint8Array,
    width: number,
    height: number,
    stride: number,
    format: number,
    alpha: number,
  ): { status: number; handle: ImageHandle | null } {
    const output = new Uint32Array(1)
    const status = this.opentui.symbols.imageCreateFromPixels(
      pixels.byteLength === 0 ? null : pixels,
      BigInt(pixels.byteLength),
      width,
      height,
      stride,
      format,
      alpha,
      output,
    )
    return this.imageHandleResult(status, output)
  }

  public imageUpdatePixels(
    image: ImageHandle,
    pixels: Uint8Array,
    stride: number,
    format: number,
    alpha: number,
  ): number {
    return this.opentui.symbols.imageUpdatePixels(
      image,
      pixels.byteLength === 0 ? null : pixels,
      BigInt(pixels.byteLength),
      stride,
      format,
      alpha,
    )
  }

  public imageDestroy(image: ImageHandle): void {
    this.opentui.symbols.imageDestroy(image)
  }

  public imageRetain(image: ImageHandle): { status: number; handle: ImageHandle | null } {
    const output = new Uint32Array(1)
    return this.imageHandleResult(this.opentui.symbols.imageRetain(image, output), output)
  }

  public imageRetainIccCache(): void {
    this.opentui.symbols.imageRetainIccCache()
  }

  public imageReleaseIccCache(): void {
    this.opentui.symbols.imageReleaseIccCache()
  }

  public imageGetInfo(image: ImageHandle): { status: number; info: NativeImageInfo } {
    const output = new ArrayBuffer(NativeImageInfoStruct.size)
    const status = this.opentui.symbols.imageGetInfo(image, output)
    return { status, info: NativeImageInfoStruct.unpack(output) }
  }

  public imageGetPixelsPtr(image: ImageHandle): Pointer | null {
    const pointer = this.opentui.symbols.imageGetPixelsPtr(image)
    return pointer === null || pointer === 0 || pointer === 0n ? null : pointer
  }

  public imageMaterialize(image: ImageHandle): number {
    return this.opentui.symbols.imageMaterialize(image)
  }

  public imageEnsureEncodedPng(image: ImageHandle): number {
    return this.opentui.symbols.imageEnsureEncodedPng(image)
  }

  public imageClone(image: ImageHandle): { status: number; handle: ImageHandle | null } {
    const output = new Uint32Array(1)
    return this.imageHandleResult(this.opentui.symbols.imageClone(image, output), output)
  }

  public imageCopyPixels(image: ImageHandle, destination: Uint8Array, stride: number, bgra: boolean): number {
    return this.opentui.symbols.imageCopyPixels(
      image,
      destination.byteLength === 0 ? null : destination,
      BigInt(destination.byteLength),
      stride,
      bgra ? 1 : 0,
    )
  }

  public imageResize(
    image: ImageHandle,
    width: number,
    height: number,
    filter: number,
  ): { status: number; handle: ImageHandle | null } {
    const output = new Uint32Array(1)
    return this.imageHandleResult(this.opentui.symbols.imageResize(image, width, height, filter, output), output)
  }

  public imageExtract(
    image: ImageHandle,
    left: number,
    top: number,
    width: number,
    height: number,
  ): { status: number; handle: ImageHandle | null } {
    const output = new Uint32Array(1)
    return this.imageHandleResult(this.opentui.symbols.imageExtract(image, left, top, width, height, output), output)
  }

  public imageExtend(
    image: ImageHandle,
    top: number,
    right: number,
    bottom: number,
    left: number,
    background: Uint8Array,
  ): { status: number; handle: ImageHandle | null } {
    if (!(background instanceof Uint8Array) || background.byteLength !== 4) return { status: 7, handle: null }
    const output = new Uint32Array(1)
    return this.imageHandleResult(
      this.opentui.symbols.imageExtend(image, top, right, bottom, left, background, output),
      output,
    )
  }

  public imageTransform(image: ImageHandle, operation: number): { status: number; handle: ImageHandle | null } {
    const output = new Uint32Array(1)
    return this.imageHandleResult(this.opentui.symbols.imageTransform(image, operation, output), output)
  }

  public imageComposite(
    base: ImageHandle,
    overlay: ImageHandle,
    left: number,
    top: number,
    blend: number,
    opacity: number,
  ): { status: number; handle: ImageHandle | null } {
    const output = new Uint32Array(1)
    return this.imageHandleResult(
      this.opentui.symbols.imageComposite(base, overlay, left, top, blend, opacity, output),
      output,
    )
  }
}

let opentuiLibPath: string | undefined
let opentuiLib: RenderLib | undefined
let renderLibResolved = false

export function setRenderLibPath(libPath: string) {
  if (opentuiLibPath !== libPath) {
    if (renderLibResolved) {
      throw new Error("setRenderLibPath() must be called before resolveRenderLib()")
    }
    if (opentuiLib instanceof FFIRenderLib) {
      opentuiLib.dispose()
    }
    opentuiLibPath = libPath
    opentuiLib = undefined
  }
}

export function resolveRenderLib(): RenderLib {
  if (!opentuiLib) {
    try {
      opentuiLib = new FFIRenderLib(opentuiLibPath)
    } catch (error) {
      throw new Error(
        `Failed to initialize OpenTUI render library: ${error instanceof Error ? error.message : "Unknown error"}`,
      )
    }
  }
  renderLibResolved = true
  return opentuiLib
}

// Try eager loading
try {
  opentuiLib = new FFIRenderLib(opentuiLibPath)
} catch (error) {}
