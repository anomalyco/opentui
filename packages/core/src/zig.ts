import {
  dlopen,
  ffiBool,
  trimNodeFFIOutputBytes,
  toArrayBuffer,
  ptr,
  toPointer,
  type FFICallbackInstance,
  type Pointer,
  usesBunFFI,
} from "./platform/ffi.js"
import { writeFile } from "./platform/runtime.js"
import { existsSync, writeFileSync } from "fs"
import { EventEmitter } from "events"
import {
  type CursorStyle,
  type CursorStyleOptions,
  type SelectionOccupancy,
  type SelectionBehavior,
  type TargetChannel,
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
import { OptimizedBuffer } from "./buffer.js"
import { TextBuffer } from "./text-buffer.js"
import { env, registerEnvVar } from "./lib/env.js"
import {
  StyledChunkStruct,
  HighlightStruct,
  LogicalCursorStruct,
  VisualCursorStruct,
  TerminalCapabilitiesStruct,
  EncodedCharStruct,
  LineInfoStruct,
  MeasureResultStruct,
  CursorStateStruct,
  EmbeddedTerminalCursorStruct,
  EmbeddedTerminalKeyOptionsStruct,
  CursorStyleOptionsStruct,
  GridDrawOptionsStruct,
  NativeSpanFeedOptionsStruct,
  NativeSpanFeedStatsStruct,
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
  NativeRenderStatsStruct,
  NativeImageInfoStruct,
  ImageDrawOptionsStruct,
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

export const MAX_LINK_URL_BYTES = 512

// Struct outputs use `buffer` instead of `ptr`. A `buffer` call is about 3x cheaper on Bun 1.3 and 2.5x cheaper on
// Bun 1.4. `buffer` rejects an argument that is not a view with a TypeError. `ptr` accepts a number as a raw address.
// `buffer` also skips the Node pointer normalizer. Bun 1.3 rejects ArrayBuffer and DataView for `buffer`, so keep one
// Uint8Array view per reusable struct.
function allocFFIStruct(structDefinition: Parameters<typeof allocStruct>[0]) {
  const storage = allocStruct(structDefinition)
  return { ...storage, ffiView: new Uint8Array(storage.buffer) }
}

registerEnvVar({
  name: "OPENTUI_LIBC",
  description: "Select Linux native libc package. Supported values: glibc, musl.",
  type: "string",
  default: "",
})

export type NativeHandle<T extends string> = Pointer & { readonly __nativeHandle: T }
export type RendererHandle = NativeHandle<"renderer">
export type OptimizedBufferHandle = NativeHandle<"optimized_buffer">
export type TextBufferHandle = NativeHandle<"text_buffer">
export type TextBufferViewHandle = NativeHandle<"text_buffer_view">
export type EditBufferHandle = NativeHandle<"edit_buffer">
export type EditorViewHandle = NativeHandle<"editor_view">
export type SyntaxStyleHandle = NativeHandle<"syntax_style">
export type EventSinkHandle = NativeHandle<"event_sink">
export type AudioEngineHandle = NativeHandle<"audio_engine">
export type NativeRenderableHandle = NativeHandle<"native_renderable">
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

export type EmbeddedTerminalHandle = NativeHandle<"embedded_terminal">

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

function viewOrNull<T extends ArrayBufferView>(value: T): T | null {
  return value.byteLength === 0 ? null : value
}

function retainedPtrOrNull(value: ArrayBufferView): Pointer | null {
  if (value.byteLength === 0) return null
  // Materialize separate storage before native code retains its address.
  void value.buffer
  return ptr(value)
}

const EMBEDDED_TERMINAL_ERRORS: Record<number, string> = {
  [-1]: "invalid value or handle",
  [-2]: "out of memory",
  [-3]: "embedded terminal support is unavailable",
  [-4]: "output buffer is too small",
  [-5]: "processing failed",
}

function embeddedTerminalResult(status: number, operation: string) {
  if (status >= 0) return status
  throw new Error(`Embedded terminal ${operation} failed: ${EMBEDDED_TERMINAL_ERRORS[status] ?? `status ${status}`}`)
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

function embeddedTerminalF32(value: number, name: string) {
  if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) {
    throw new RangeError(`Embedded terminal ${name} must be a finite 32-bit float`)
  }
  return value
}

function rgbaBuffer(value: RGBA): Uint16Array {
  return value.buffer
}

function optionalRgbaBuffer(value: RGBA | null | undefined): Uint16Array | null {
  return value ? rgbaBuffer(value) : null
}

function selectionBehaviorByte(behavior?: SelectionBehavior): number {
  return behavior === "word" ? 1 : behavior === "line" ? 2 : 0
}

function editorLocalSelectionFlags(updateCursor: boolean, followCursor: boolean, behavior?: SelectionBehavior): number {
  return ffiBool(updateCursor) | (ffiBool(followCursor) << 1) | (selectionBehaviorByte(behavior) << 2)
}

function widthMethodCode(widthMethod: WidthMethod): number {
  return widthMethod === "wcwidth" ? 0 : widthMethod === "unicode-wide" ? 3 : 1
}

function widthMethodFromCode(code: number): WidthMethod {
  if (code === 0) return "wcwidth"
  return code === 3 ? "unicode-wide" : "unicode"
}

function getOpenTUILib(libPath?: string) {
  const resolvedLibPath = libPath || targetLibPath
  if (!resolvedLibPath) {
    throw (
      targetLibError ??
      new Error(`OpenTUI is not supported on the current platform: ${process.platform}-${process.arch}`)
    )
  }

  const rawSymbols = dlopen(resolvedLibPath, {
    // Logging
    setLogCallback: {
      args: ["ptr"],
      returns: "void",
    },
    // Event bus
    createEventSink: {
      args: ["ptr"],
      returns: "u32",
    },
    destroyEventSink: {
      args: ["u32"],
      returns: "void",
    },
    createNativeRenderable: {
      args: [],
      returns: "u32",
    },
    destroyNativeRenderable: {
      args: ["u32"],
      returns: "void",
    },
    nativeRenderableAttachYogaNode: {
      args: ["u32", "ptr"],
      returns: "bool",
    },
    nativeRenderableSetMeasureTarget: {
      args: ["u32", "u32", "u32"],
      returns: "bool",
    },
    createEmbeddedTerminal: {
      args: ["u16", "u16", "u32", "ptr"],
      returns: "i32",
    },
    destroyEmbeddedTerminal: {
      args: ["u32"],
      returns: "void",
    },
    embeddedTerminalWrite: {
      args: ["u32", "ptr", "u32"],
      returns: "i32",
    },
    embeddedTerminalResize: {
      args: ["u32", "u16", "u16"],
      returns: "i32",
    },
    embeddedTerminalInvalidate: {
      args: ["u32"],
      returns: "i32",
    },
    embeddedTerminalScroll: {
      args: ["u32", "i32"],
      returns: "i32",
    },
    embeddedTerminalSetSelection: {
      args: ["u32", "u16", "u16", "u16", "u16"],
      returns: "i32",
    },
    embeddedTerminalClearSelection: {
      args: ["u32"],
      returns: "i32",
    },
    embeddedTerminalGetSelectedText: {
      args: ["u32", "buffer", "u32", "buffer"],
      returns: "i32",
    },
    embeddedTerminalCompose: {
      args: ["u32", "u32", "i32", "i32"],
      returns: "i32",
    },
    embeddedTerminalCursor: {
      args: ["u32", "buffer"],
      returns: "i32",
    },
    embeddedTerminalEncodeKey: {
      args: ["u32", "buffer", "ptr", "u32", "ptr", "u32", "ptr", "u32", "ptr"],
      returns: "i32",
    },
    embeddedTerminalEncodeMouse: {
      args: ["u32", "u8", "i8", "u16", "f32", "f32", "u8", "ptr", "u32"],
      returns: "i32",
    },
    embeddedTerminalEncodePaste: {
      args: ["u32", "ptr", "u32", "ptr", "u32"],
      returns: "i32",
    },
    embeddedTerminalEncodeFocus: {
      args: ["u32", "u8", "ptr", "u32"],
      returns: "i32",
    },
    embeddedTerminalDrainResponses: {
      args: ["u32", "ptr", "u32"],
      returns: "i32",
    },
    // Renderer management
    createRenderer: {
      args: ["u32", "u32", "u8", "u8", "ptr"],
      returns: "u32",
    },
    setTerminalEnvVar: {
      args: ["u32", "ptr", "u32", "ptr", "u32"],
      returns: "bool",
    },
    destroyRenderer: {
      args: ["u32", "bool"],
      returns: "void",
    },
    setUseThread: {
      args: ["u32", "bool"],
      returns: "void",
    },
    setClearOnShutdown: {
      args: ["u32", "bool"],
      returns: "void",
    },
    setBackgroundColor: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    setRenderOffset: {
      args: ["u32", "u32"],
      returns: "void",
    },
    resetSplitScrollback: {
      args: ["u32", "u32", "u32"],
      returns: "u32",
    },
    syncSplitScrollback: {
      args: ["u32", "u32"],
      returns: "u32",
    },
    getSplitOutputOffset: {
      args: ["u32", "u32"],
      returns: "u32",
    },
    setPendingSplitFooterTransition: {
      args: ["u32", "u8", "u32", "u32", "u32", "u32", "u32"],
      returns: "void",
    },
    clearPendingSplitFooterTransition: {
      args: ["u32"],
      returns: "void",
    },
    updateStats: {
      args: ["u32", "f64", "u32", "f64"],
      returns: "void",
    },
    updateMemoryStats: {
      args: ["u32", "u32", "u32", "u32"],
      returns: "void",
    },
    getRenderStats: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    render: {
      args: ["u32", "bool"],
      returns: "u8",
    },
    repaintSplitFooter: {
      args: ["u32", "u32", "bool"],
      returns: "u64",
    },
    // Single FFI entrypoint for split commit append. beginFrame/finalizeFrame let
    // native code decide whether this call is a standalone commit or part of a
    // larger batched frame envelope.
    commitSplitFooterSnapshot: {
      args: ["u32", "u32", "u32", "u8", "u32"],
      returns: "u64",
    },
    getNextBuffer: {
      args: ["u32"],
      returns: "u32",
    },
    getCurrentBuffer: {
      args: ["u32"],
      returns: "u32",
    },
    rendererSetPaletteState: {
      args: ["u32", "buffer", "u32", "buffer", "buffer", "u32"],
      returns: "void",
    },

    queryPixelResolution: {
      args: ["u32"],
      returns: "void",
    },
    queryThemeColors: {
      args: ["u32"],
      returns: "void",
    },

    createOptimizedBuffer: {
      args: ["u32", "u32", "u8", "u8", "buffer", "u32"],
      returns: "u32",
    },
    destroyOptimizedBuffer: {
      args: ["u32"],
      returns: "void",
    },

    drawFrameBuffer: {
      args: ["u32", "i32", "i32", "u32", "u32", "u32", "u32", "u32"],
      returns: "void",
    },
    getBufferWidth: {
      args: ["u32"],
      returns: "u32",
    },
    getBufferHeight: {
      args: ["u32"],
      returns: "u32",
    },
    getBufferWidthMethod: {
      args: ["u32"],
      returns: "u8",
    },
    bufferClear: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    bufferGetCharPtr: {
      args: ["u32"],
      returns: "ptr",
    },
    bufferGetFgPtr: {
      args: ["u32"],
      returns: "ptr",
    },
    bufferGetBgPtr: {
      args: ["u32"],
      returns: "ptr",
    },
    bufferGetAttributesPtr: {
      args: ["u32"],
      returns: "ptr",
    },
    bufferGetRespectAlpha: {
      args: ["u32"],
      returns: "bool",
    },
    bufferSetRespectAlpha: {
      args: ["u32", "bool"],
      returns: "void",
    },
    bufferGetId: {
      args: ["u32", "buffer", "u32"],
      returns: "u32",
    },
    bufferGetRealCharSize: {
      args: ["u32"],
      returns: "u32",
    },
    bufferWriteResolvedChars: {
      args: ["u32", "ptr", "u32", "bool"],
      returns: "u32",
    },

    bufferDrawText: {
      args: ["u32", "ptr", "u32", "u32", "u32", "buffer", "ptr", "u32"],
      returns: "void",
    },
    bufferSetCellWithAlphaBlending: {
      args: ["u32", "u32", "u32", "u32", "buffer", "buffer", "u32"],
      returns: "void",
    },
    bufferSetCell: {
      args: ["u32", "u32", "u32", "u32", "buffer", "buffer", "u32"],
      returns: "void",
    },
    bufferFillRect: {
      args: ["u32", "u32", "u32", "u32", "u32", "buffer"],
      returns: "void",
    },
    bufferColorMatrix: {
      args: ["u32", "ptr", "ptr", "u32", "f32", "u8"],
      returns: "void",
    },
    bufferColorMatrixUniform: {
      args: ["u32", "ptr", "f32", "u8"],
      returns: "void",
    },
    bufferResize: {
      args: ["u32", "u32", "u32"],
      returns: "void",
    },

    // Link API
    linkAlloc: {
      args: ["ptr", "u32"],
      returns: "u32",
    },
    linkGetUrl: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },
    attributesWithLink: {
      args: ["u32", "u32"],
      returns: "u32",
    },
    attributesGetLinkId: {
      args: ["u32"],
      returns: "u32",
    },

    resizeRenderer: {
      args: ["u32", "u32", "u32"],
      returns: "void",
    },

    // Cursor functions (now renderer-scoped)
    setCursorPosition: {
      args: ["u32", "i32", "i32", "bool"],
      returns: "void",
    },
    setCursorColor: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    getCursorState: {
      args: ["u32", "ptr"],
      returns: "void",
    },

    // Cursor and mouse pointer style (combined)
    setCursorStyleOptions: {
      args: ["u32", "ptr"],
      returns: "void",
    },

    // Debug overlay
    setDebugOverlay: {
      args: ["u32", "u8", "u8"],
      returns: "void",
    },

    // Terminal control
    clearTerminal: {
      args: ["u32"],
      returns: "void",
    },
    setTerminalTitle: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },
    copyToClipboardOSC52: {
      args: ["u32", "u8", "ptr", "u32"],
      returns: "bool",
    },
    clearClipboardOSC52: {
      args: ["u32", "u8"],
      returns: "bool",
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
    triggerNotification: {
      args: ["u32", "ptr", "u32", "ptr", "u32"],
      returns: "bool",
    },

    bufferDrawSuperSampleBuffer: {
      args: ["u32", "u32", "u32", "ptr", "u32", "u8", "u32"],
      returns: "void",
    },
    bufferDrawImage: {
      args: ["u32", "u32", "buffer"],
      returns: "u8",
    },
    bufferDrawPackedBuffer: {
      args: ["u32", "ptr", "u32", "u32", "u32", "u32", "u32"],
      returns: "void",
    },
    bufferDrawGrayscaleBuffer: {
      args: ["u32", "i32", "i32", "ptr", "u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    bufferDrawGrayscaleBufferSupersampled: {
      args: ["u32", "i32", "i32", "ptr", "u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    bufferDrawGrid: {
      args: ["u32", "buffer", "buffer", "buffer", "buffer", "u32", "buffer", "u32", "buffer"],
      returns: "void",
    },
    bufferDrawBox: {
      args: [
        "u32",
        "i32",
        "i32",
        "u32",
        "u32",
        "buffer",
        "u32",
        "buffer",
        "buffer",
        "buffer",
        "ptr",
        "u32",
        "ptr",
        "u32",
      ],
      returns: "void",
    },
    bufferPushScissorRect: {
      args: ["u32", "i32", "i32", "u32", "u32"],
      returns: "void",
    },
    bufferPopScissorRect: {
      args: ["u32"],
      returns: "void",
    },
    bufferClearScissorRects: {
      args: ["u32"],
      returns: "void",
    },
    bufferPushOpacity: {
      args: ["u32", "f32"],
      returns: "void",
    },
    bufferPopOpacity: {
      args: ["u32"],
      returns: "void",
    },
    bufferGetCurrentOpacity: {
      args: ["u32"],
      returns: "f32",
    },
    bufferClearOpacity: {
      args: ["u32"],
      returns: "void",
    },

    addToHitGrid: {
      args: ["u32", "i32", "i32", "u32", "u32", "u32"],
      returns: "void",
    },
    clearCurrentHitGrid: {
      args: ["u32"],
      returns: "void",
    },
    hitGridPushScissorRect: {
      args: ["u32", "i32", "i32", "u32", "u32"],
      returns: "void",
    },
    hitGridPopScissorRect: {
      args: ["u32"],
      returns: "void",
    },
    hitGridClearScissorRects: {
      args: ["u32"],
      returns: "void",
    },
    addToCurrentHitGridClipped: {
      args: ["u32", "i32", "i32", "u32", "u32", "u32"],
      returns: "void",
    },
    checkHit: {
      args: ["u32", "u32", "u32"],
      returns: "u32",
    },
    getHitGridDirty: {
      args: ["u32"],
      returns: "bool",
    },
    dumpHitGrid: {
      args: ["u32"],
      returns: "void",
    },
    dumpBuffers: {
      args: ["u32", "i64"],
      returns: "void",
    },
    dumpOutputBuffer: {
      args: ["u32", "i64"],
      returns: "void",
    },
    restoreTerminalModes: {
      args: ["u32"],
      returns: "void",
    },
    enableMouse: {
      args: ["u32", "bool"],
      returns: "void",
    },
    disableMouse: {
      args: ["u32"],
      returns: "void",
    },
    enableKittyKeyboard: {
      args: ["u32", "u8"],
      returns: "void",
    },
    disableKittyKeyboard: {
      args: ["u32"],
      returns: "void",
    },
    setKittyKeyboardFlags: {
      args: ["u32", "u8"],
      returns: "void",
    },
    getKittyKeyboardFlags: {
      args: ["u32"],
      returns: "u8",
    },
    setupTerminal: {
      args: ["u32", "bool"],
      returns: "void",
    },
    suspendRenderer: {
      args: ["u32"],
      returns: "void",
    },
    resumeRenderer: {
      args: ["u32"],
      returns: "void",
    },
    writeOut: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },

    // TextBuffer functions
    createTextBuffer: {
      args: ["u8"],
      returns: "u32",
    },
    destroyTextBuffer: {
      args: ["u32"],
      returns: "void",
    },
    textBufferGetLength: {
      args: ["u32"],
      returns: "u32",
    },
    textBufferGetByteSize: {
      args: ["u32"],
      returns: "u32",
    },

    textBufferReset: {
      args: ["u32"],
      returns: "void",
    },
    textBufferClear: {
      args: ["u32"],
      returns: "void",
    },
    textBufferSetDefaultFg: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    textBufferSetDefaultBg: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    textBufferSetDefaultAttributes: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    textBufferResetDefaults: {
      args: ["u32"],
      returns: "void",
    },
    textBufferGetTabWidth: {
      args: ["u32"],
      returns: "u8",
    },
    textBufferSetTabWidth: {
      args: ["u32", "u8"],
      returns: "void",
    },
    textBufferRegisterMemBuffer: {
      args: ["u32", "ptr", "u32", "bool"],
      returns: "u16",
    },
    textBufferReplaceMemBuffer: {
      args: ["u32", "u8", "ptr", "u32", "bool"],
      returns: "bool",
    },
    textBufferClearMemRegistry: {
      args: ["u32"],
      returns: "void",
    },
    textBufferSetTextFromMem: {
      args: ["u32", "u8"],
      returns: "void",
    },
    textBufferAppend: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },
    textBufferAppendFromMemId: {
      args: ["u32", "u8"],
      returns: "void",
    },
    textBufferLoadFile: {
      args: ["u32", "ptr", "u32"],
      returns: "bool",
    },
    textBufferSetStyledText: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },
    textBufferGetLineCount: {
      args: ["u32"],
      returns: "u32",
    },
    textBufferGetPlainText: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },
    textBufferAddHighlightByCharRange: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    textBufferAddHighlight: {
      args: ["u32", "u32", "ptr"],
      returns: "void",
    },
    textBufferRemoveHighlightsByRef: {
      args: ["u32", "u16"],
      returns: "void",
    },
    textBufferClearLineHighlights: {
      args: ["u32", "u32"],
      returns: "void",
    },
    textBufferClearAllHighlights: {
      args: ["u32"],
      returns: "void",
    },
    textBufferSetSyntaxStyle: {
      args: ["u32", "u32"],
      returns: "bool",
    },
    textBufferGetLineHighlightsPtr: {
      args: ["u32", "u32", "ptr"],
      returns: "ptr",
    },
    textBufferFreeLineHighlights: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    textBufferGetHighlightCount: {
      args: ["u32"],
      returns: "u32",
    },
    textBufferGetTextRange: {
      args: ["u32", "u32", "u32", "ptr", "u32"],
      returns: "u32",
    },
    textBufferGetTextRangeByCoords: {
      args: ["u32", "u32", "u32", "u32", "u32", "ptr", "u32"],
      returns: "u32",
    },

    // TextBufferView functions
    createTextBufferView: {
      args: ["u32"],
      returns: "u32",
    },
    destroyTextBufferView: {
      args: ["u32"],
      returns: "void",
    },
    textBufferViewSetSelection: {
      args: ["u32", "u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    textBufferViewResetSelection: {
      args: ["u32"],
      returns: "void",
    },
    textBufferViewGetSelectionInfo: {
      args: ["u32"],
      returns: "u64",
    },
    textBufferViewSetLocalSelection: {
      args: ["u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "u8"],
      returns: "bool",
    },
    textBufferViewUpdateSelection: {
      args: ["u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    textBufferViewUpdateLocalSelection: {
      args: ["u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "u8"],
      returns: "bool",
    },
    textBufferViewResetLocalSelection: {
      args: ["u32"],
      returns: "void",
    },
    textBufferViewSetSelectionOccupancy: {
      args: ["u32", "u8"],
      returns: "void",
    },
    textBufferViewGetSelectionOccupancy: {
      args: ["u32"],
      returns: "u8",
    },
    textBufferViewSetWrapWidth: {
      args: ["u32", "u32"],
      returns: "void",
    },
    textBufferViewSetWrapMode: {
      args: ["u32", "u8"],
      returns: "void",
    },
    textBufferViewSetWrapIndent: {
      args: ["u32", "u8"],
      returns: "void",
    },
    textBufferViewSetFirstLineOffset: {
      args: ["u32", "u32"],
      returns: "void",
    },
    textBufferViewSetViewportSize: {
      args: ["u32", "u32", "u32"],
      returns: "void",
    },
    textBufferViewSetViewport: {
      args: ["u32", "u32", "u32", "u32", "u32"],
      returns: "void",
    },
    textBufferViewGetVirtualLineCount: {
      args: ["u32"],
      returns: "u32",
    },
    textBufferViewGetLineInfoDirect: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    textBufferViewGetLogicalLineInfoDirect: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    textBufferViewGetSelectedText: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },
    textBufferViewGetPlainText: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },
    textBufferViewSetTabIndicator: {
      args: ["u32", "u32"],
      returns: "void",
    },
    textBufferViewSetTabIndicatorColor: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    textBufferViewSetTruncate: {
      args: ["u32", "bool"],
      returns: "void",
    },
    textBufferViewMeasureForDimensions: {
      args: ["u32", "u32", "u32", "buffer"],
      returns: "bool",
    },
    bufferDrawTextBufferView: {
      args: ["u32", "u32", "i32", "i32"],
      returns: "void",
    },
    bufferDrawEditorView: {
      args: ["u32", "u32", "i32", "i32"],
      returns: "void",
    },

    // EditorView functions
    createEditorView: {
      args: ["u32", "u32", "u32"],
      returns: "u32",
    },
    destroyEditorView: {
      args: ["u32"],
      returns: "void",
    },
    editorViewSetViewportSize: {
      args: ["u32", "u32", "u32"],
      returns: "void",
    },
    editorViewSetViewport: {
      args: ["u32", "u32", "u32", "u32", "u32", "bool"],
      returns: "void",
    },
    editorViewGetViewport: {
      args: ["u32", "buffer", "buffer", "buffer", "buffer"],
      returns: "bool",
    },
    editorViewSetScrollMargin: {
      args: ["u32", "f32"],
      returns: "void",
    },
    editorViewSetWrapMode: {
      args: ["u32", "u8"],
      returns: "void",
    },
    editorViewSetWrapIndent: {
      args: ["u32", "u8"],
      returns: "void",
    },
    editorViewGetVirtualLineCount: {
      args: ["u32"],
      returns: "u32",
    },
    editorViewGetTotalVirtualLineCount: {
      args: ["u32"],
      returns: "u32",
    },
    editorViewGetTextBufferView: {
      args: ["u32"],
      returns: "u32",
    },
    editorViewGetLineInfoDirect: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    editorViewGetLogicalLineInfoDirect: {
      args: ["u32", "ptr"],
      returns: "void",
    },

    // EditBuffer functions
    createEditBuffer: {
      args: ["u8", "u32"],
      returns: "u32",
    },
    destroyEditBuffer: {
      args: ["u32"],
      returns: "void",
    },
    editBufferSetText: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },
    editBufferSetTextFromMem: {
      args: ["u32", "u8"],
      returns: "void",
    },
    editBufferReplaceText: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },
    editBufferReplaceTextFromMem: {
      args: ["u32", "u8"],
      returns: "void",
    },
    editBufferGetText: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },
    editBufferInsertChar: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },
    editBufferInsertText: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },
    editBufferDeleteChar: {
      args: ["u32"],
      returns: "void",
    },
    editBufferDeleteCharBackward: {
      args: ["u32"],
      returns: "void",
    },
    editBufferDeleteRange: {
      args: ["u32", "u32", "u32", "u32", "u32"],
      returns: "void",
    },
    editBufferNewLine: {
      args: ["u32"],
      returns: "void",
    },
    editBufferDeleteLine: {
      args: ["u32"],
      returns: "void",
    },
    editBufferMoveCursorLeft: {
      args: ["u32"],
      returns: "void",
    },
    editBufferMoveCursorRight: {
      args: ["u32"],
      returns: "void",
    },
    editBufferMoveCursorUp: {
      args: ["u32"],
      returns: "void",
    },
    editBufferMoveCursorDown: {
      args: ["u32"],
      returns: "void",
    },
    editBufferGotoLine: {
      args: ["u32", "u32"],
      returns: "void",
    },
    editBufferSetCursor: {
      args: ["u32", "u32", "u32"],
      returns: "void",
    },
    editBufferSetCursorToLineCol: {
      args: ["u32", "u32", "u32"],
      returns: "void",
    },
    editBufferSetCursorByOffset: {
      args: ["u32", "u32"],
      returns: "void",
    },
    editBufferGetCursorPosition: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    editBufferGetId: {
      args: ["u32"],
      returns: "u16",
    },
    editBufferGetTextBuffer: {
      args: ["u32"],
      returns: "u32",
    },
    editBufferSetTabWidth: {
      args: ["u32", "u8"],
      returns: "void",
    },
    editBufferDebugLogRope: {
      args: ["u32"],
      returns: "void",
    },
    editBufferUndo: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },
    editBufferRedo: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },
    editBufferCanUndo: {
      args: ["u32"],
      returns: "bool",
    },
    editBufferCanRedo: {
      args: ["u32"],
      returns: "bool",
    },
    editBufferClearHistory: {
      args: ["u32"],
      returns: "void",
    },
    editBufferClear: {
      args: ["u32"],
      returns: "void",
    },
    editBufferGetNextWordBoundary: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    editBufferGetPrevWordBoundary: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    editBufferGetEOL: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    editBufferOffsetToPosition: {
      args: ["u32", "u32", "buffer"],
      returns: "bool",
    },
    editBufferPositionToOffset: {
      args: ["u32", "u32", "u32"],
      returns: "u32",
    },
    editBufferGetLineStartOffset: {
      args: ["u32", "u32"],
      returns: "u32",
    },
    editBufferGetTextRange: {
      args: ["u32", "u32", "u32", "ptr", "u32"],
      returns: "u32",
    },
    editBufferGetTextRangeByCoords: {
      args: ["u32", "u32", "u32", "u32", "u32", "ptr", "u32"],
      returns: "u32",
    },

    // EditorView selection and editing methods
    editorViewSetSelection: {
      args: ["u32", "u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    editorViewResetSelection: {
      args: ["u32"],
      returns: "void",
    },
    editorViewGetSelection: {
      args: ["u32"],
      returns: "u64",
    },
    editorViewSetLocalSelection: {
      args: ["u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "u8"],
      returns: "bool",
    },
    editorViewUpdateSelection: {
      args: ["u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    editorViewUpdateLocalSelection: {
      args: ["u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "u8"],
      returns: "bool",
    },
    editorViewResetLocalSelection: {
      args: ["u32"],
      returns: "void",
    },
    editorViewConvertSelectionToCell: {
      args: ["u32"],
      returns: "bool",
    },
    editorViewSetSelectionOccupancy: {
      args: ["u32", "u8"],
      returns: "void",
    },
    editorViewSetSelectionInclusive: {
      args: ["u32", "u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    editorViewSetSelectionColors: {
      args: ["u32", "ptr", "ptr"],
      returns: "void",
    },
    editorViewGetSelectedTextBytes: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },
    editorViewGetCursor: {
      args: ["u32", "buffer", "buffer"],
      returns: "void",
    },
    editorViewGetText: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },

    // EditorView VisualCursor methods
    editorViewGetVisualCursor: {
      args: ["u32", "buffer"],
      returns: "void",
    },

    editorViewMoveUpVisual: {
      args: ["u32"],
      returns: "void",
    },
    editorViewMoveDownVisual: {
      args: ["u32"],
      returns: "void",
    },
    editorViewDeleteSelectedText: {
      args: ["u32"],
      returns: "void",
    },
    editorViewSetCursorByOffset: {
      args: ["u32", "u32"],
      returns: "void",
    },
    editorViewGetNextWordBoundary: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    editorViewGetPrevWordBoundary: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    editorViewGetEOL: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    editorViewGetVisualSOL: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    editorViewGetVisualEOL: {
      args: ["u32", "buffer"],
      returns: "void",
    },
    editorViewGotoVisualLineEnd: {
      args: ["u32"],
      returns: "void",
    },
    editorViewSetPlaceholderStyledText: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },
    editorViewSetTabIndicator: {
      args: ["u32", "u32"],
      returns: "void",
    },
    editorViewSetTabIndicatorColor: {
      args: ["u32", "buffer"],
      returns: "void",
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

    // SyntaxStyle functions
    createSyntaxStyle: {
      args: [],
      returns: "u32",
    },
    destroySyntaxStyle: {
      args: ["u32"],
      returns: "void",
    },
    syntaxStyleRegister: {
      args: ["u32", "ptr", "u32", "ptr", "ptr", "u32"],
      returns: "u32",
    },
    syntaxStyleResolveByName: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },
    syntaxStyleGetStyleCount: {
      args: ["u32"],
      returns: "u32",
    },

    imageInfo: { args: ["ptr", "u32", "ptr"], returns: "u32" },
    imageRetainIccCache: { args: [], returns: "void" },
    imageReleaseIccCache: { args: [], returns: "void" },
    imageTestFailIccProfileCopyAllocationOnce: { args: [], returns: "void" },
    imageDecode: { args: ["ptr", "u32", "buffer"], returns: "u32" },
    imageCreateFromRgba: { args: ["ptr", "u64", "u32", "u32", "u32", "buffer"], returns: "u32" },
    imageCreateFromPixels: { args: ["buffer", "u64", "u32", "u32", "u32", "u32", "u32", "buffer"], returns: "u32" },
    imageUpdatePixels: { args: ["u32", "buffer", "u64", "u32", "u32", "u32"], returns: "u32" },
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

    // Terminal capability functions
    getTerminalCapabilities: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    processCapabilityResponse: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },
    setKittyImageTransport: { args: ["u32", "u32"], returns: "u32" },
    getKittyImageTransport: { args: ["u32", "buffer"], returns: "void" },
    pollKittyImageTransport: { args: ["u32"], returns: "u32" },
    cancelKittyImageTransport: { args: ["u32", "u32"], returns: "void" },
    processKittyImageReply: { args: ["u32", "buffer", "u32"], returns: "u32" },

    // Unicode encoding API
    encodeUnicode: {
      args: ["ptr", "u32", "ptr", "ptr", "u8"],
      returns: "bool",
    },
    freeUnicode: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    bufferDrawChar: {
      args: ["u32", "u32", "u32", "u32", "buffer", "buffer", "u32"],
      returns: "void",
    },

    // Yoga layout
    yogaConfigCreate: {
      args: [],
      returns: "ptr",
    },
    yogaConfigFree: {
      args: ["ptr"],
      returns: "void",
    },
    yogaConfigSetUseWebDefaults: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    yogaConfigGetUseWebDefaults: {
      args: ["ptr"],
      returns: "bool",
    },
    yogaConfigSetPointScaleFactor: {
      args: ["ptr", "f32"],
      returns: "void",
    },
    yogaConfigGetPointScaleFactor: {
      args: ["ptr"],
      returns: "f32",
    },
    yogaConfigSetErrata: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    yogaConfigGetErrata: {
      args: ["ptr"],
      returns: "u32",
    },
    yogaConfigSetExperimentalFeatureEnabled: {
      args: ["ptr", "u32", "bool"],
      returns: "void",
    },
    yogaConfigIsExperimentalFeatureEnabled: {
      args: ["ptr", "u32"],
      returns: "bool",
    },
    yogaNodeCreate: {
      args: [],
      returns: "ptr",
    },
    yogaNodeCreateForOpenTUI: {
      args: [],
      returns: "ptr",
    },
    yogaNodeCreateWithConfig: {
      args: ["ptr"],
      returns: "ptr",
    },
    yogaNodeFree: {
      args: ["ptr"],
      returns: "void",
    },
    yogaNodeFreeRecursive: {
      args: ["ptr"],
      returns: "void",
    },
    yogaNodeReset: {
      args: ["ptr"],
      returns: "void",
    },
    yogaNodeCopyStyle: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    yogaNodeInsertChild: {
      args: ["ptr", "ptr", "u32"],
      returns: "void",
    },
    yogaNodeRemoveChild: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    yogaNodeRemoveAllChildren: {
      args: ["ptr"],
      returns: "void",
    },
    yogaNodeGetChild: {
      args: ["ptr", "u32"],
      returns: "ptr",
    },
    yogaNodeGetChildCount: {
      args: ["ptr"],
      returns: "u32",
    },
    yogaNodeGetParent: {
      args: ["ptr"],
      returns: "ptr",
    },
    yogaNodeCalculateLayout: {
      args: ["ptr", "f32", "f32", "u32"],
      returns: "void",
    },
    yogaNodeIsDirty: {
      args: ["ptr"],
      returns: "bool",
    },
    yogaNodeMarkDirty: {
      args: ["ptr"],
      returns: "void",
    },
    yogaNodeGetHasNewLayout: {
      args: ["ptr"],
      returns: "bool",
    },
    yogaNodeSetHasNewLayout: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    yogaNodeSetIsReferenceBaseline: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    yogaNodeIsReferenceBaseline: {
      args: ["ptr"],
      returns: "bool",
    },
    yogaNodeSetAlwaysFormsContainingBlock: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    yogaNodeGetAlwaysFormsContainingBlock: {
      args: ["ptr"],
      returns: "bool",
    },
    yogaNodeGetComputedLayout: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    yogaNodeLayoutGetEdge: {
      args: ["ptr", "u32", "u32"],
      returns: "f32",
    },
    yogaNodeStyleSetEnum: {
      args: ["ptr", "u32", "u32"],
      returns: "void",
    },
    yogaNodeStyleGetEnum: {
      args: ["ptr", "u32"],
      returns: "u32",
    },
    yogaNodeStyleSetFloat: {
      args: ["ptr", "u32", "f32"],
      returns: "void",
    },
    yogaNodeStyleGetFloat: {
      args: ["ptr", "u32"],
      returns: "f32",
    },
    yogaNodeStyleSetBorder: {
      args: ["ptr", "u32", "f32"],
      returns: "void",
    },
    yogaNodeStyleGetBorder: {
      args: ["ptr", "u32"],
      returns: "f32",
    },
    yogaNodeStyleSetValue: {
      args: ["ptr", "u32", "u32", "u32", "f32"],
      returns: "void",
    },
    yogaNodeStyleGetValue: {
      args: ["ptr", "u32", "u32"],
      returns: "u64",
    },
    yogaNodeSetMeasureFunc: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    yogaNodeUnsetMeasureFunc: {
      args: ["ptr"],
      returns: "void",
    },
    yogaNodeHasMeasureFunc: {
      args: ["ptr"],
      returns: "bool",
    },
    yogaNodeSetDirtiedFunc: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    yogaNodeUnsetDirtiedFunc: {
      args: ["ptr"],
      returns: "void",
    },
    yogaStoreMeasureResult: {
      args: ["f32", "f32"],
      returns: "void",
    },
    yogaSetMeasureCallback: {
      args: ["ptr"],
      returns: "void",
    },
    yogaSetDirtiedCallback: {
      args: ["ptr"],
      returns: "void",
    },

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
      args: ["u32", "u32", "buffer"],
      returns: "i32",
    },
    audioCloseStream: {
      args: ["u32", "u32", "u32", "buffer"],
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
      returns: "void",
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
    streamSetOptions: {
      args: ["ptr", "ptr"],
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
  let hasTracing = false

  Object.entries(symbols).forEach(([key, value]) => {
    debugSymbols[key] = value
  })

  if (env.OTUI_DEBUG_FFI && globalFFILogPath) {
    const logPath = globalFFILogPath
    const writeSync = (msg: string) => {
      writeFileSync(logPath, msg + "\n", { flag: "a" })
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
    hasTracing = true
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

export interface NativeRendererCreateOptions {
  remote?: boolean
  feedPtr?: Pointer | null
  bufferedOutput?: NativeBufferedOutput
}

export interface NativeRenderOperationResult {
  renderOffset: number
  status: number
}

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

export const NativeMeasureTargetKind = {
  None: 0,
  TextBufferView: 1,
  EditorView: 2,
} as const

export type NativeMeasureTargetKind = (typeof NativeMeasureTargetKind)[keyof typeof NativeMeasureTargetKind]

export type NativeMeasureTargetHandle = TextBufferViewHandle | EditorViewHandle

export interface AudioEngineLib {
  createAudioEngine: (options?: AudioCreateOptions | null) => AudioEngineHandle | null
  destroyAudioEngine: (engine: AudioEngineHandle) => void
  audioRefreshPlaybackDevices: (engine: AudioEngineHandle) => number
  audioGetPlaybackDeviceCount: (engine: AudioEngineHandle) => number
  audioGetPlaybackDeviceName: (engine: AudioEngineHandle, index: number) => string
  audioIsPlaybackDeviceDefault: (engine: AudioEngineHandle, index: number) => boolean
  audioSelectPlaybackDevice: (engine: AudioEngineHandle, index: number) => number
  audioClearPlaybackDeviceSelection: (engine: AudioEngineHandle) => void
  audioRefreshCaptureDevices: (engine: AudioEngineHandle) => number
  audioGetCaptureDeviceCount: (engine: AudioEngineHandle) => number
  audioGetCaptureDeviceName: (engine: AudioEngineHandle, index: number) => string
  audioIsCaptureDeviceDefault: (engine: AudioEngineHandle, index: number) => boolean
  audioSelectCaptureDevice: (engine: AudioEngineHandle, index: number) => number
  audioClearCaptureDeviceSelection: (engine: AudioEngineHandle) => void
  audioStartCapture: (
    engine: AudioEngineHandle,
    options: AudioStartOptions | undefined,
    channels: number,
    capacityFrames: number,
  ) => number
  audioStopCapture: (engine: AudioEngineHandle) => number
  audioIsCaptureRunning: (engine: AudioEngineHandle) => boolean
  audioReadCapture: (
    engine: AudioEngineHandle,
    outBuffer: Float32Array,
    frameCount: number,
  ) => { status: number; framesRead: number }
  audioGetCaptureStats: (engine: AudioEngineHandle) => { status: number; stats: NativeAudioCaptureStats | null }
  audioStart: (engine: AudioEngineHandle, options?: AudioStartOptions | null) => number
  audioStartMixer: (engine: AudioEngineHandle) => number
  audioStop: (engine: AudioEngineHandle) => number
  audioCreateStream: (
    engine: AudioEngineHandle,
    options: AudioStreamCreateOptions,
  ) => { status: number; streamId: number | null }
  audioWriteStream: (engine: AudioEngineHandle, streamId: number, data: Uint8Array) => number
  audioEndStream: (engine: AudioEngineHandle, streamId: number) => number
  audioRestartStream: (engine: AudioEngineHandle, streamId: number) => number
  audioSetStreamVolume: (engine: AudioEngineHandle, streamId: number, volume: number) => number
  audioSetStreamPan: (engine: AudioEngineHandle, streamId: number, pan: number) => number
  audioSetStreamGroup: (engine: AudioEngineHandle, streamId: number, groupId: number) => number
  audioGetStreamStats: (engine: AudioEngineHandle, streamId: number) => NativeAudioStreamStats | null
  audioCloseStream: (
    engine: AudioEngineHandle,
    streamId: number,
    reason: NativeAudioStreamCloseReason,
  ) => { status: number; stats: NativeAudioStreamStats | null }
  audioLoad: (engine: AudioEngineHandle, data: Uint8Array) => { status: number; soundId: number | null }
  audioUnload: (engine: AudioEngineHandle, soundId: number) => number
  audioPlay: (
    engine: AudioEngineHandle,
    soundId: number,
    options?: AudioVoiceOptions,
  ) => { status: number; voiceId: number | null }
  audioStopVoice: (engine: AudioEngineHandle, voiceId: number) => number
  audioSetVoiceGroup: (engine: AudioEngineHandle, voiceId: number, groupId: number) => number
  audioCreateGroup: (engine: AudioEngineHandle, name: string) => { status: number; groupId: number | null }
  audioSetGroupVolume: (engine: AudioEngineHandle, groupId: number, volume: number) => number
  audioSetMasterVolume: (engine: AudioEngineHandle, volume: number) => number
  audioMixToBuffer: (engine: AudioEngineHandle, outBuffer: Float32Array, frameCount: number, channels: number) => number
  audioEnableTap: (engine: AudioEngineHandle, enabled: boolean, capacityFrames: number) => number
  audioReadTap: (
    engine: AudioEngineHandle,
    outBuffer: Float32Array,
    frameCount: number,
    channels: number,
  ) => { status: number; framesRead: number }
  audioGetStats: (engine: AudioEngineHandle) => AudioStats | null
}

export interface RenderLib extends AudioEngineLib {
  createRenderer: (width: number, height: number, options?: NativeRendererCreateOptions) => RendererHandle | null
  setTerminalEnvVar: (renderer: RendererHandle, key: string, value: string) => boolean
  destroyRenderer: (renderer: RendererHandle, flushInput?: boolean) => void
  setUseThread: (renderer: RendererHandle, useThread: boolean) => void
  setClearOnShutdown: (renderer: RendererHandle, clear: boolean) => void
  setBackgroundColor: (renderer: RendererHandle, color: RGBA) => void
  setRenderOffset: (renderer: RendererHandle, offset: number) => void
  resetSplitScrollback: (renderer: RendererHandle, seedRows: number, pinnedRenderOffset: number) => number
  syncSplitScrollback: (renderer: RendererHandle, pinnedRenderOffset: number) => number
  getSplitOutputOffset: (renderer: RendererHandle, surfaceOffset: number) => number
  setPendingSplitFooterTransition: (
    renderer: RendererHandle,
    mode: number,
    sourceTopLine: number,
    sourceHeight: number,
    targetTopLine: number,
    targetHeight: number,
    scrollLines: number,
  ) => void
  clearPendingSplitFooterTransition: (renderer: RendererHandle) => void
  updateStats: (renderer: RendererHandle, time: number, fps: number, frameCallbackTime: number) => void
  updateMemoryStats: (renderer: RendererHandle, heapUsed: number, heapTotal: number, arrayBuffers: number) => void
  getRenderStats: (renderer: RendererHandle) => NativeRenderStats
  render: (renderer: RendererHandle, force: boolean) => number
  repaintSplitFooter: (
    renderer: RendererHandle,
    pinnedRenderOffset: number,
    force: boolean,
  ) => NativeRenderOperationResult
  commitSplitFooterSnapshot: (
    renderer: RendererHandle,
    snapshot: OptimizedBuffer,
    rowColumns: number,
    startOnNewLine: boolean,
    trailingNewline: boolean,
    pinnedRenderOffset: number,
    force: boolean,
    // beginFrame/finalizeFrame mark commit boundaries when one JS flush contains
    // multiple stdout snapshots. Defaults preserve old one-call behavior.
    beginFrame?: boolean,
    finalizeFrame?: boolean,
    controlOutput?: boolean,
  ) => NativeRenderOperationResult
  getNextBuffer: (renderer: RendererHandle) => OptimizedBuffer
  getCurrentBuffer: (renderer: RendererHandle) => OptimizedBuffer
  linkGetUrl: (linkId: number, maxLen?: number) => string
  rendererSetPaletteState: (
    renderer: RendererHandle,
    palette: readonly RGBA[],
    defaultForeground: RGBA,
    defaultBackground: RGBA,
    paletteEpoch: number,
  ) => void
  createOptimizedBuffer: (
    width: number,
    height: number,
    widthMethod: WidthMethod,
    respectAlpha?: boolean,
    id?: string,
  ) => OptimizedBuffer
  destroyOptimizedBuffer: (bufferPtr: OptimizedBufferHandle) => void
  drawFrameBuffer: (
    targetBufferPtr: OptimizedBufferHandle,
    destX: number,
    destY: number,
    bufferPtr: OptimizedBufferHandle,
    sourceX?: number,
    sourceY?: number,
    sourceWidth?: number,
    sourceHeight?: number,
  ) => void
  getBufferWidth: (buffer: OptimizedBufferHandle) => number
  getBufferHeight: (buffer: OptimizedBufferHandle) => number
  bufferClear: (buffer: OptimizedBufferHandle, color: RGBA) => void
  bufferGetCharPtr: (buffer: OptimizedBufferHandle) => Pointer
  bufferGetFgPtr: (buffer: OptimizedBufferHandle) => Pointer
  bufferGetBgPtr: (buffer: OptimizedBufferHandle) => Pointer
  bufferGetAttributesPtr: (buffer: OptimizedBufferHandle) => Pointer
  bufferGetRespectAlpha: (buffer: OptimizedBufferHandle) => boolean
  bufferSetRespectAlpha: (buffer: OptimizedBufferHandle, respectAlpha: boolean) => void
  bufferGetId: (buffer: OptimizedBufferHandle) => string
  bufferGetRealCharSize: (buffer: OptimizedBufferHandle) => number
  bufferWriteResolvedChars: (buffer: OptimizedBufferHandle, outputBuffer: Uint8Array, addLineBreaks: boolean) => number
  bufferDrawText: (
    buffer: OptimizedBufferHandle,
    text: string,
    x: number,
    y: number,
    color: RGBA,
    bgColor?: RGBA,
    attributes?: number,
  ) => void
  bufferSetCellWithAlphaBlending: (
    buffer: OptimizedBufferHandle,
    x: number,
    y: number,
    char: string,
    color: RGBA,
    bgColor: RGBA,
    attributes?: number,
  ) => void
  bufferSetCell: (
    buffer: OptimizedBufferHandle,
    x: number,
    y: number,
    char: string,
    color: RGBA,
    bgColor: RGBA,
    attributes?: number,
  ) => void
  bufferFillRect: (
    buffer: OptimizedBufferHandle,
    x: number,
    y: number,
    width: number,
    height: number,
    color: RGBA,
  ) => void
  bufferColorMatrix: (
    buffer: OptimizedBufferHandle,
    matrix: Pointer | Float32Array,
    cellMask: Pointer | Float32Array,
    cellMaskCount: number,
    strength: number,
    target: TargetChannel,
  ) => void
  bufferColorMatrixUniform: (
    buffer: OptimizedBufferHandle,
    matrix: Pointer | Float32Array,
    strength: number,
    target: TargetChannel,
  ) => void
  bufferDrawSuperSampleBuffer: (
    buffer: OptimizedBufferHandle,
    x: number,
    y: number,
    pixelData: Pointer | Uint8Array,
    pixelDataLength: number,
    format: "bgra8unorm" | "rgba8unorm",
    alignedBytesPerRow: number,
  ) => void
  bufferDrawImage: (
    buffer: OptimizedBufferHandle,
    image: ImageHandle,
    x: number,
    y: number,
    width: number,
    height: number,
    pixelWidth: number,
    pixelHeight: number,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    protocol: ImageRenderProtocol,
  ) => boolean
  bufferDrawPackedBuffer: (
    buffer: OptimizedBufferHandle,
    data: Pointer | Uint8Array,
    dataLen: number,
    posX: number,
    posY: number,
    terminalWidthCells: number,
    terminalHeightCells: number,
  ) => void
  bufferDrawGrayscaleBuffer: (
    buffer: OptimizedBufferHandle,
    posX: number,
    posY: number,
    intensities: Pointer | Float32Array,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null,
    bg: RGBA | null,
  ) => void
  bufferDrawGrayscaleBufferSupersampled: (
    buffer: OptimizedBufferHandle,
    posX: number,
    posY: number,
    intensities: Pointer | Float32Array,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null,
    bg: RGBA | null,
  ) => void
  bufferDrawGrid: (
    buffer: OptimizedBufferHandle,
    borderChars: Uint32Array,
    borderFg: RGBA,
    borderBg: RGBA,
    columnOffsets: Int32Array,
    columnCount: number,
    rowOffsets: Int32Array,
    rowCount: number,
    options: { drawInner: boolean; drawOuter: boolean },
  ) => void
  bufferDrawBox: (
    buffer: OptimizedBufferHandle,
    x: number,
    y: number,
    width: number,
    height: number,
    borderChars: Uint32Array,
    packedOptions: number,
    borderColor: RGBA,
    backgroundColor: RGBA,
    titleColor: RGBA,
    title: string | null,
    bottomTitle: string | null,
  ) => void
  bufferResize: (buffer: OptimizedBufferHandle, width: number, height: number) => void
  resizeRenderer: (renderer: RendererHandle, width: number, height: number) => void
  setCursorPosition: (renderer: RendererHandle, x: number, y: number, visible: boolean) => void
  setCursorColor: (renderer: RendererHandle, color: RGBA) => void
  getCursorState: (renderer: RendererHandle) => CursorState
  setCursorStyleOptions: (renderer: RendererHandle, options: CursorStyleOptions) => void
  setDebugOverlay: (renderer: RendererHandle, enabled: boolean, corner: DebugOverlayCorner) => void
  clearTerminal: (renderer: RendererHandle) => void
  setTerminalTitle: (renderer: RendererHandle, title: string) => void
  copyToClipboardOSC52: (renderer: RendererHandle, target: number, textUtf8: Uint8Array) => boolean
  clearClipboardOSC52: (renderer: RendererHandle, target: number) => boolean
  clipboardServiceCreate: (
    maxConcurrentOperations: number,
    maxProviderTransfers: number,
    waylandSeat?: string,
  ) => ClipboardServiceHandle | null
  clipboardServiceBeginShutdown: (service: ClipboardServiceHandle) => NativeClipboardShutdownStatus
  clipboardServicePollShutdown: (service: ClipboardServiceHandle) => NativeClipboardShutdownStatus
  clipboardServiceDestroy: (service: ClipboardServiceHandle) => NativeClipboardDestroyStatus
  clipboardServiceDrain: (service: ClipboardServiceHandle) => number
  clipboardReadOperationStart: (
    service: ClipboardServiceHandle,
    request: Uint8Array,
    selection: number,
    maxBytes: number,
    maxImagePixels: number,
    maxConversionBytes: number,
    timeoutMs: number,
  ) => { status: NativeClipboardStartStatus; operation: ClipboardOperationHandle | null }
  clipboardWriteOperationStart: (
    service: ClipboardServiceHandle,
    textUtf8: Uint8Array,
    selection: number,
    timeoutMs: number,
  ) => { status: NativeClipboardStartStatus; operation: ClipboardOperationHandle | null }
  clipboardClearOperationStart: (
    service: ClipboardServiceHandle,
    selection: number,
    timeoutMs: number,
  ) => { status: NativeClipboardStartStatus; operation: ClipboardOperationHandle | null }
  clipboardOperationPoll: (operation: ClipboardOperationHandle) => NativeClipboardOperationStatus
  clipboardOperationCancel: (operation: ClipboardOperationHandle) => NativeClipboardCancelStatus
  clipboardOperationResultMimeLength: (operation: ClipboardOperationHandle) => {
    status: NativeClipboardCopyStatus
    length: number
  }
  clipboardOperationResultMimeCopy: (
    operation: ClipboardOperationHandle,
    output: Uint8Array,
  ) => NativeClipboardCopyStatus
  clipboardOperationResultDataLength: (operation: ClipboardOperationHandle) => {
    status: NativeClipboardCopyStatus
    length: number
  }
  clipboardOperationResultDataCopy: (
    operation: ClipboardOperationHandle,
    output: Uint8Array,
  ) => NativeClipboardCopyStatus
  clipboardOperationResultErrorCode: (operation: ClipboardOperationHandle) => {
    status: NativeClipboardCopyStatus
    errorCode: number
  }
  clipboardOperationResultDiagnosticLength: (operation: ClipboardOperationHandle) => {
    status: NativeClipboardCopyStatus
    length: number
  }
  clipboardOperationResultDiagnosticCopy: (
    operation: ClipboardOperationHandle,
    output: Uint8Array,
  ) => NativeClipboardCopyStatus
  clipboardOperationDestroy: (operation: ClipboardOperationHandle) => NativeClipboardDestroyStatus
  triggerNotification: (renderer: RendererHandle, message: string, title?: string) => boolean
  addToHitGrid: (renderer: RendererHandle, x: number, y: number, width: number, height: number, id: number) => void
  clearCurrentHitGrid: (renderer: RendererHandle) => void
  hitGridPushScissorRect: (renderer: RendererHandle, x: number, y: number, width: number, height: number) => void
  hitGridPopScissorRect: (renderer: RendererHandle) => void
  hitGridClearScissorRects: (renderer: RendererHandle) => void
  addToCurrentHitGridClipped: (
    renderer: RendererHandle,
    x: number,
    y: number,
    width: number,
    height: number,
    id: number,
  ) => void
  checkHit: (renderer: RendererHandle, x: number, y: number) => number
  getHitGridDirty: (renderer: RendererHandle) => boolean
  dumpHitGrid: (renderer: RendererHandle) => void
  dumpBuffers: (renderer: RendererHandle, timestamp?: number) => void
  dumpOutputBuffer: (renderer: RendererHandle, timestamp?: number) => void
  restoreTerminalModes: (renderer: RendererHandle) => void
  enableMouse: (renderer: RendererHandle, enableMovement: boolean) => void
  disableMouse: (renderer: RendererHandle) => void
  enableKittyKeyboard: (renderer: RendererHandle, flags: number) => void
  disableKittyKeyboard: (renderer: RendererHandle) => void
  setKittyKeyboardFlags: (renderer: RendererHandle, flags: number) => void
  getKittyKeyboardFlags: (renderer: RendererHandle) => number
  setupTerminal: (renderer: RendererHandle, useAlternateScreen: boolean) => void
  suspendRenderer: (renderer: RendererHandle) => void
  resumeRenderer: (renderer: RendererHandle) => void
  queryPixelResolution: (renderer: RendererHandle) => void
  queryThemeColors: (renderer: RendererHandle) => void
  writeOut: (renderer: RendererHandle, data: string | Uint8Array) => void

  // Yoga layout methods
  yogaConfigCreate: () => Pointer
  yogaConfigFree: (config: Pointer) => void
  yogaConfigSetUseWebDefaults: (config: Pointer, enabled: boolean) => void
  yogaConfigGetUseWebDefaults: (config: Pointer) => boolean
  yogaConfigSetPointScaleFactor: (config: Pointer, pointScaleFactor: number) => void
  yogaConfigGetPointScaleFactor: (config: Pointer) => number
  yogaConfigSetErrata: (config: Pointer, errata: number) => void
  yogaConfigGetErrata: (config: Pointer) => number
  yogaConfigSetExperimentalFeatureEnabled: (config: Pointer, feature: number, enabled: boolean) => void
  yogaConfigIsExperimentalFeatureEnabled: (config: Pointer, feature: number) => boolean
  yogaNodeCreate: () => Pointer
  yogaNodeCreateForOpenTUI: () => Pointer
  yogaNodeCreateWithConfig: (config: Pointer) => Pointer
  yogaNodeFree: (node: Pointer) => void
  yogaNodeFreeRecursive: (node: Pointer) => void
  yogaNodeReset: (node: Pointer) => void
  yogaNodeCopyStyle: (dstNode: Pointer, srcNode: Pointer) => void
  yogaNodeInsertChild: (node: Pointer, child: Pointer, index: number) => void
  yogaNodeRemoveChild: (node: Pointer, child: Pointer) => void
  yogaNodeRemoveAllChildren: (node: Pointer) => void
  yogaNodeGetChild: (node: Pointer, index: number) => Pointer | null
  yogaNodeGetChildCount: (node: Pointer) => number
  yogaNodeGetParent: (node: Pointer) => Pointer | null
  yogaNodeCalculateLayout: (node: Pointer, width: number, height: number, direction: number) => void
  yogaNodeIsDirty: (node: Pointer) => boolean
  yogaNodeMarkDirty: (node: Pointer) => void
  yogaNodeGetHasNewLayout: (node: Pointer) => boolean
  yogaNodeSetHasNewLayout: (node: Pointer, hasNewLayout: boolean) => void
  yogaNodeSetIsReferenceBaseline: (node: Pointer, isReferenceBaseline: boolean) => void
  yogaNodeIsReferenceBaseline: (node: Pointer) => boolean
  yogaNodeSetAlwaysFormsContainingBlock: (node: Pointer, alwaysFormsContainingBlock: boolean) => void
  yogaNodeGetAlwaysFormsContainingBlock: (node: Pointer) => boolean
  yogaNodeGetComputedLayout: (node: Pointer) => NativeYogaLayout
  yogaNodeLayoutGetEdge: (node: Pointer, kind: number, edge: number) => number
  yogaNodeStyleSetEnum: (node: Pointer, kind: number, value: number) => void
  yogaNodeStyleGetEnum: (node: Pointer, kind: number) => number
  yogaNodeStyleSetFloat: (node: Pointer, kind: number, value: number) => void
  yogaNodeStyleGetFloat: (node: Pointer, kind: number) => number
  yogaNodeStyleSetBorder: (node: Pointer, edge: number, border: number) => void
  yogaNodeStyleGetBorder: (node: Pointer, edge: number) => number
  yogaNodeStyleSetValue: (node: Pointer, kind: number, edgeOrGutter: number, unit: number, value: number) => void
  yogaNodeStyleGetValue: (node: Pointer, kind: number, edgeOrGutter: number) => number | bigint
  yogaNodeSetMeasureFunc: (node: Pointer, enabled: boolean) => void
  yogaNodeUnsetMeasureFunc: (node: Pointer) => void
  yogaNodeHasMeasureFunc: (node: Pointer) => boolean
  yogaNodeSetDirtiedFunc: (node: Pointer, enabled: boolean) => void
  yogaNodeUnsetDirtiedFunc: (node: Pointer) => void
  yogaStoreMeasureResult: (width: number, height: number) => void
  yogaSetMeasureCallback: (callback: Pointer | null) => void
  yogaSetDirtiedCallback: (callback: Pointer | null) => void
  createYogaMeasureCallback: (callback: NativeYogaMeasureCallback) => FFICallbackInstance
  createYogaDirtiedCallback: (callback: NativeYogaDirtiedCallback) => FFICallbackInstance

  // TextBuffer methods
  createTextBuffer: (widthMethod: WidthMethod) => TextBuffer
  destroyTextBuffer: (buffer: TextBufferHandle) => void
  textBufferGetLength: (buffer: TextBufferHandle) => number
  textBufferGetByteSize: (buffer: TextBufferHandle) => number

  textBufferReset: (buffer: TextBufferHandle) => void
  textBufferClear: (buffer: TextBufferHandle) => void
  textBufferRegisterMemBuffer: (buffer: TextBufferHandle, bytes: Uint8Array, owned?: boolean) => number
  textBufferReplaceMemBuffer: (buffer: TextBufferHandle, memId: number, bytes: Uint8Array, owned?: boolean) => boolean
  textBufferClearMemRegistry: (buffer: TextBufferHandle) => void
  textBufferSetTextFromMem: (buffer: TextBufferHandle, memId: number) => void
  textBufferAppend: (buffer: TextBufferHandle, bytes: Uint8Array) => void
  textBufferAppendFromMemId: (buffer: TextBufferHandle, memId: number) => void
  textBufferLoadFile: (buffer: TextBufferHandle, path: string) => boolean
  textBufferSetStyledText: (
    buffer: TextBufferHandle,
    chunks: Array<{ text: string; fg?: RGBA | null; bg?: RGBA | null; attributes?: number; link?: { url: string } }>,
  ) => void
  textBufferSetDefaultFg: (buffer: TextBufferHandle, fg: RGBA | null) => void
  textBufferSetDefaultBg: (buffer: TextBufferHandle, bg: RGBA | null) => void
  textBufferSetDefaultAttributes: (buffer: TextBufferHandle, attributes: number | null) => void
  textBufferResetDefaults: (buffer: TextBufferHandle) => void
  textBufferGetTabWidth: (buffer: TextBufferHandle) => number
  textBufferSetTabWidth: (buffer: TextBufferHandle, width: number) => void
  textBufferGetLineCount: (buffer: TextBufferHandle) => number
  getPlainTextBytes: (buffer: TextBufferHandle, maxLength: number) => Uint8Array | null
  textBufferGetTextRange: (
    buffer: TextBufferHandle,
    startOffset: number,
    endOffset: number,
    maxLength: number,
  ) => Uint8Array | null
  textBufferGetTextRangeByCoords: (
    buffer: TextBufferHandle,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    maxLength: number,
  ) => Uint8Array | null

  // TextBufferView methods
  createTextBufferView: (textBuffer: TextBufferHandle) => TextBufferViewHandle
  destroyTextBufferView: (view: TextBufferViewHandle) => void
  textBufferViewSetSelection: (
    view: TextBufferViewHandle,
    start: number,
    end: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ) => void
  textBufferViewResetSelection: (view: TextBufferViewHandle) => void
  textBufferViewGetSelection: (view: TextBufferViewHandle) => { start: number; end: number } | null
  textBufferViewSetLocalSelection: (
    view: TextBufferViewHandle,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
    behavior?: SelectionBehavior,
  ) => boolean
  textBufferViewUpdateSelection: (
    view: TextBufferViewHandle,
    end: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ) => void
  textBufferViewUpdateLocalSelection: (
    view: TextBufferViewHandle,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
    behavior?: SelectionBehavior,
  ) => boolean
  textBufferViewResetLocalSelection: (view: TextBufferViewHandle) => void
  textBufferViewSetSelectionOccupancy: (view: TextBufferViewHandle, occupancy: SelectionOccupancy) => void
  textBufferViewGetSelectionOccupancy: (view: TextBufferViewHandle) => SelectionOccupancy
  textBufferViewSetWrapWidth: (view: TextBufferViewHandle, width: number) => void
  textBufferViewSetWrapMode: (view: TextBufferViewHandle, mode: "none" | "char" | "word") => void
  textBufferViewSetWrapIndent: (view: TextBufferViewHandle, indent: "none" | "same") => void
  textBufferViewSetFirstLineOffset: (view: TextBufferViewHandle, offset: number) => void
  textBufferViewSetViewportSize: (view: TextBufferViewHandle, width: number, height: number) => void
  textBufferViewSetViewport: (view: TextBufferViewHandle, x: number, y: number, width: number, height: number) => void
  textBufferViewGetLineInfo: (view: TextBufferViewHandle) => LineInfo
  textBufferViewGetLogicalLineInfo: (view: TextBufferViewHandle) => LineInfo
  textBufferViewGetLineSources: (view: TextBufferViewHandle, startLine: number, lineCount: number) => number[]
  textBufferViewGetSelectedTextBytes: (view: TextBufferViewHandle, maxLength: number) => Uint8Array | null
  textBufferViewGetPlainTextBytes: (view: TextBufferViewHandle, maxLength: number) => Uint8Array | null
  textBufferViewSetTabIndicator: (view: TextBufferViewHandle, indicator: number) => void
  textBufferViewSetTabIndicatorColor: (view: TextBufferViewHandle, color: RGBA) => void
  textBufferViewSetTruncate: (view: TextBufferViewHandle, truncate: boolean) => void
  textBufferViewMeasureForDimensions: (
    view: TextBufferViewHandle,
    width: number,
    height: number,
  ) => MeasureResult | null
  textBufferViewGetVirtualLineCount: (view: TextBufferViewHandle) => number

  readonly encoder: TextEncoder
  readonly decoder: TextDecoder
  bufferDrawTextBufferView: (buffer: OptimizedBufferHandle, view: TextBufferViewHandle, x: number, y: number) => void
  bufferDrawEditorView: (buffer: OptimizedBufferHandle, view: EditorViewHandle, x: number, y: number) => void

  // EditBuffer methods
  createEditBuffer: (widthMethod: WidthMethod) => EditBufferHandle
  destroyEditBuffer: (buffer: EditBufferHandle) => void
  editBufferSetText: (buffer: EditBufferHandle, textBytes: Uint8Array) => void
  editBufferSetTextFromMem: (buffer: EditBufferHandle, memId: number) => void
  editBufferReplaceText: (buffer: EditBufferHandle, textBytes: Uint8Array) => void
  editBufferReplaceTextFromMem: (buffer: EditBufferHandle, memId: number) => void
  editBufferGetText: (buffer: EditBufferHandle, maxLength: number) => Uint8Array | null
  editBufferInsertChar: (buffer: EditBufferHandle, char: string) => void
  editBufferInsertText: (buffer: EditBufferHandle, text: string) => void
  editBufferDeleteChar: (buffer: EditBufferHandle) => void
  editBufferDeleteCharBackward: (buffer: EditBufferHandle) => void
  editBufferDeleteRange: (
    buffer: EditBufferHandle,
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
  ) => void
  editBufferNewLine: (buffer: EditBufferHandle) => void
  editBufferDeleteLine: (buffer: EditBufferHandle) => void
  editBufferMoveCursorLeft: (buffer: EditBufferHandle) => void
  editBufferMoveCursorRight: (buffer: EditBufferHandle) => void
  editBufferMoveCursorUp: (buffer: EditBufferHandle) => void
  editBufferMoveCursorDown: (buffer: EditBufferHandle) => void
  editBufferGotoLine: (buffer: EditBufferHandle, line: number) => void
  editBufferSetCursor: (buffer: EditBufferHandle, line: number, col: number) => void
  editBufferSetCursorToLineCol: (buffer: EditBufferHandle, line: number, col: number) => void
  editBufferSetCursorByOffset: (buffer: EditBufferHandle, offset: number) => void
  editBufferGetCursorPosition: (buffer: EditBufferHandle) => LogicalCursor
  editBufferGetId: (buffer: EditBufferHandle) => number
  editBufferGetTextBuffer: (buffer: EditBufferHandle) => TextBufferHandle
  editBufferSetTabWidth: (buffer: EditBufferHandle, width: number) => void
  editBufferDebugLogRope: (buffer: EditBufferHandle) => void
  editBufferUndo: (buffer: EditBufferHandle, maxLength: number) => Uint8Array | null
  editBufferRedo: (buffer: EditBufferHandle, maxLength: number) => Uint8Array | null
  editBufferCanUndo: (buffer: EditBufferHandle) => boolean
  editBufferCanRedo: (buffer: EditBufferHandle) => boolean
  editBufferClearHistory: (buffer: EditBufferHandle) => void
  editBufferClear: (buffer: EditBufferHandle) => void
  editBufferGetNextWordBoundary: (buffer: EditBufferHandle) => { row: number; col: number; offset: number }
  editBufferGetPrevWordBoundary: (buffer: EditBufferHandle) => { row: number; col: number; offset: number }
  editBufferGetEOL: (buffer: EditBufferHandle) => { row: number; col: number; offset: number }
  editBufferOffsetToPosition: (
    buffer: EditBufferHandle,
    offset: number,
  ) => { row: number; col: number; offset: number } | null
  editBufferPositionToOffset: (buffer: EditBufferHandle, row: number, col: number) => number
  editBufferGetLineStartOffset: (buffer: EditBufferHandle, row: number) => number
  editBufferGetTextRange: (
    buffer: EditBufferHandle,
    startOffset: number,
    endOffset: number,
    maxLength: number,
  ) => Uint8Array | null
  editBufferGetTextRangeByCoords: (
    buffer: EditBufferHandle,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    maxLength: number,
  ) => Uint8Array | null

  // EditorView methods
  createEditorView: (editBufferPtr: EditBufferHandle, viewportWidth: number, viewportHeight: number) => EditorViewHandle
  destroyEditorView: (view: EditorViewHandle) => void
  editorViewSetViewportSize: (view: EditorViewHandle, width: number, height: number) => void
  editorViewSetViewport: (
    view: EditorViewHandle,
    x: number,
    y: number,
    width: number,
    height: number,
    moveCursor: boolean,
  ) => void
  editorViewGetViewport: (view: EditorViewHandle) => { offsetY: number; offsetX: number; height: number; width: number }
  editorViewSetScrollMargin: (view: EditorViewHandle, margin: number) => void
  editorViewSetWrapMode: (view: EditorViewHandle, mode: "none" | "char" | "word") => void
  editorViewSetWrapIndent: (view: EditorViewHandle, indent: "none" | "same") => void
  editorViewGetVirtualLineCount: (view: EditorViewHandle) => number
  editorViewGetTotalVirtualLineCount: (view: EditorViewHandle) => number
  editorViewGetTextBufferView: (view: EditorViewHandle) => TextBufferViewHandle
  editorViewSetSelection: (
    view: EditorViewHandle,
    start: number,
    end: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ) => void
  editorViewResetSelection: (view: EditorViewHandle) => void
  editorViewGetSelection: (view: EditorViewHandle) => { start: number; end: number } | null
  editorViewSetLocalSelection: (
    view: EditorViewHandle,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
    updateCursor: boolean,
    followCursor: boolean,
    behavior?: SelectionBehavior,
  ) => boolean

  editorViewUpdateSelection: (view: EditorViewHandle, end: number, bgColor: RGBA | null, fgColor: RGBA | null) => void
  editorViewUpdateLocalSelection: (
    view: EditorViewHandle,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
    updateCursor: boolean,
    followCursor: boolean,
    behavior?: SelectionBehavior,
  ) => boolean

  editorViewResetLocalSelection: (view: EditorViewHandle) => void
  editorViewConvertSelectionToCell: (view: EditorViewHandle) => boolean
  editorViewSetSelectionOccupancy: (view: EditorViewHandle, occupancy: SelectionOccupancy) => void
  editorViewSetSelectionInclusive: (
    view: EditorViewHandle,
    start: number,
    end: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ) => void
  editorViewSetSelectionColors: (view: EditorViewHandle, bgColor: RGBA | null, fgColor: RGBA | null) => void
  editorViewGetSelectedTextBytes: (view: EditorViewHandle, maxLength: number) => Uint8Array | null
  editorViewGetCursor: (view: EditorViewHandle) => { row: number; col: number }
  editorViewGetText: (view: EditorViewHandle, maxLength: number) => Uint8Array | null
  editorViewGetVisualCursor: (view: EditorViewHandle) => VisualCursor
  editorViewMoveUpVisual: (view: EditorViewHandle) => void
  editorViewMoveDownVisual: (view: EditorViewHandle) => void
  editorViewDeleteSelectedText: (view: EditorViewHandle) => void
  editorViewSetCursorByOffset: (view: EditorViewHandle, offset: number) => void
  editorViewGetNextWordBoundary: (view: EditorViewHandle) => VisualCursor
  editorViewGetPrevWordBoundary: (view: EditorViewHandle) => VisualCursor
  editorViewGetEOL: (view: EditorViewHandle) => VisualCursor
  editorViewGetVisualSOL: (view: EditorViewHandle) => VisualCursor
  editorViewGetVisualEOL: (view: EditorViewHandle) => VisualCursor
  editorViewGotoVisualLineEnd: (view: EditorViewHandle) => void
  editorViewGetLineInfo: (view: EditorViewHandle) => LineInfo
  editorViewGetLogicalLineInfo: (view: EditorViewHandle) => LineInfo
  editorViewSetPlaceholderStyledText: (
    view: EditorViewHandle,
    chunks: Array<{ text: string; fg?: RGBA | null; bg?: RGBA | null; attributes?: number }>,
  ) => void
  editorViewSetTabIndicator: (view: EditorViewHandle, indicator: number) => void
  editorViewSetTabIndicatorColor: (view: EditorViewHandle, color: RGBA) => void

  bufferPushScissorRect: (buffer: OptimizedBufferHandle, x: number, y: number, width: number, height: number) => void
  bufferPopScissorRect: (buffer: OptimizedBufferHandle) => void
  bufferClearScissorRects: (buffer: OptimizedBufferHandle) => void
  bufferPushOpacity: (buffer: OptimizedBufferHandle, opacity: number) => void
  bufferPopOpacity: (buffer: OptimizedBufferHandle) => void
  bufferGetCurrentOpacity: (buffer: OptimizedBufferHandle) => number
  bufferClearOpacity: (buffer: OptimizedBufferHandle) => void
  textBufferAddHighlightByCharRange: (buffer: TextBufferHandle, highlight: Highlight) => void
  textBufferAddHighlight: (buffer: TextBufferHandle, lineIdx: number, highlight: Highlight) => void
  textBufferRemoveHighlightsByRef: (buffer: TextBufferHandle, hlRef: number) => void
  textBufferClearLineHighlights: (buffer: TextBufferHandle, lineIdx: number) => void
  textBufferClearAllHighlights: (buffer: TextBufferHandle) => void
  textBufferSetSyntaxStyle: (buffer: TextBufferHandle, style: SyntaxStyleHandle | null) => boolean
  textBufferGetLineHighlights: (buffer: TextBufferHandle, lineIdx: number) => Array<Highlight>
  textBufferGetHighlightCount: (buffer: TextBufferHandle) => number

  getArenaAllocatedBytes: () => number
  getBuildOptions: () => BuildOptions
  getAllocatorStats: () => AllocatorStats

  createSyntaxStyle: () => SyntaxStyleHandle
  destroySyntaxStyle: (style: SyntaxStyleHandle) => void
  syntaxStyleRegister: (
    style: SyntaxStyleHandle,
    name: string,
    fg: RGBA | null,
    bg: RGBA | null,
    attributes: number,
  ) => number
  syntaxStyleResolveByName: (style: SyntaxStyleHandle, name: string) => number | null
  syntaxStyleGetStyleCount: (style: SyntaxStyleHandle) => number

  imageInfo: (data: Uint8Array) => { status: number; info: NativeImageInfo }
  imageRetainIccCache: () => void
  imageReleaseIccCache: () => void
  imageTestFailIccProfileCopyAllocationOnce: () => void
  imageDecode: (data: Uint8Array) => { status: number; handle: ImageHandle | null }
  imageCreateFromRgba: (
    pixels: Uint8Array,
    width: number,
    height: number,
    stride: number,
  ) => { status: number; handle: ImageHandle | null }
  imageCreateFromPixels: (
    pixels: Uint8Array,
    width: number,
    height: number,
    stride: number,
    format: number,
    alpha: number,
  ) => { status: number; handle: ImageHandle | null }
  imageUpdatePixels: (image: ImageHandle, pixels: Uint8Array, stride: number, format: number, alpha: number) => number
  imageDestroy: (image: ImageHandle) => void
  imageRetain: (image: ImageHandle) => { status: number; handle: ImageHandle | null }
  imageGetInfo: (image: ImageHandle) => { status: number; info: NativeImageInfo }
  imageMaterialize: (image: ImageHandle) => number
  imageEnsureEncodedPng: (image: ImageHandle) => number
  imageGetPixelsPtr: (image: ImageHandle) => Pointer | null
  imageClone: (image: ImageHandle) => { status: number; handle: ImageHandle | null }
  imageCopyPixels: (image: ImageHandle, destination: Uint8Array, stride: number, bgra: boolean) => number
  imageResize: (
    image: ImageHandle,
    width: number,
    height: number,
    filter: number,
  ) => { status: number; handle: ImageHandle | null }
  imageExtract: (
    image: ImageHandle,
    left: number,
    top: number,
    width: number,
    height: number,
  ) => { status: number; handle: ImageHandle | null }
  imageExtend: (
    image: ImageHandle,
    top: number,
    right: number,
    bottom: number,
    left: number,
    background: Uint8Array,
  ) => { status: number; handle: ImageHandle | null }
  imageTransform: (image: ImageHandle, operation: number) => { status: number; handle: ImageHandle | null }
  imageComposite: (
    base: ImageHandle,
    overlay: ImageHandle,
    left: number,
    top: number,
    blend: number,
    opacity: number,
  ) => { status: number; handle: ImageHandle | null }

  getTerminalCapabilities: (renderer: RendererHandle) => TerminalCapabilities
  processCapabilityResponse: (renderer: RendererHandle, response: string) => void
  setKittyImageTransport: (renderer: RendererHandle, mode: number) => boolean
  getKittyImageTransport: (renderer: RendererHandle) => Uint32Array
  pollKittyImageTransport: (renderer: RendererHandle) => boolean
  cancelKittyImageTransport: (renderer: RendererHandle, failed: boolean) => void
  processKittyImageReply: (renderer: RendererHandle, response: string) => number

  encodeUnicode: (
    text: string,
    widthMethod: WidthMethod,
  ) => { ptr: Pointer; data: Array<{ width: number; char: number }> } | null
  freeUnicode: (encoded: { ptr: Pointer; data: Array<{ width: number; char: number }> }) => void
  bufferDrawChar: (
    buffer: OptimizedBufferHandle,
    char: number,
    x: number,
    y: number,
    fg: RGBA,
    bg: RGBA,
    attributes?: number,
  ) => void

  registerNativeSpanFeedStream: (stream: Pointer, handler: NativeSpanFeedEventHandler) => void
  unregisterNativeSpanFeedStream: (stream: Pointer) => void
  createNativeSpanFeed: (options?: NativeSpanFeedOptions | null) => Pointer
  attachNativeSpanFeed: (stream: Pointer) => number
  destroyNativeSpanFeed: (stream: Pointer) => void
  streamWrite: (stream: Pointer, data: Uint8Array | string) => number
  streamCommit: (stream: Pointer) => number
  streamDrainSpans: (stream: Pointer, outBuffer: Uint8Array, maxSpans: number) => number
  streamClose: (stream: Pointer) => number
  streamSetOptions: (stream: Pointer, options: NativeSpanFeedOptions) => number
  streamGetStats: (stream: Pointer) => NativeSpanFeedStats | null
  streamReserve: (stream: Pointer, minLen: number) => { status: number; info: ReserveInfo | null }
  streamCommitReserved: (stream: Pointer, length: number) => number
  createNativeRenderable: () => NativeRenderableHandle
  destroyNativeRenderable: (handle: NativeRenderableHandle) => void
  nativeRenderableAttachYogaNode: (handle: NativeRenderableHandle, node: Pointer) => boolean
  nativeRenderableSetMeasureTarget: (
    handle: NativeRenderableHandle,
    kind: NativeMeasureTargetKind,
    target: NativeMeasureTargetHandle | 0,
  ) => boolean
  createEmbeddedTerminal: (options: { cols: number; rows: number; maxScrollback?: number }) => EmbeddedTerminalHandle
  destroyEmbeddedTerminal: (handle: EmbeddedTerminalHandle) => void
  embeddedTerminalWrite: (handle: EmbeddedTerminalHandle, data: string | Uint8Array) => void
  embeddedTerminalResize: (handle: EmbeddedTerminalHandle, cols: number, rows: number) => void
  embeddedTerminalInvalidate: (handle: EmbeddedTerminalHandle) => void
  embeddedTerminalScroll: (handle: EmbeddedTerminalHandle, delta: number) => void
  embeddedTerminalSetSelection: (
    handle: EmbeddedTerminalHandle,
    start: { x: number; y: number },
    end: { x: number; y: number },
  ) => void
  embeddedTerminalClearSelection: (handle: EmbeddedTerminalHandle) => void
  embeddedTerminalGetSelectedText: (handle: EmbeddedTerminalHandle) => Uint8Array
  embeddedTerminalCompose: (handle: EmbeddedTerminalHandle, target: OptimizedBufferHandle, x: number, y: number) => void
  embeddedTerminalCursor: (handle: EmbeddedTerminalHandle) => EmbeddedTerminalCursor
  embeddedTerminalEncodeKey: (handle: EmbeddedTerminalHandle, key: EmbeddedTerminalKey) => Uint8Array
  embeddedTerminalEncodeMouse: (handle: EmbeddedTerminalHandle, mouse: EmbeddedTerminalMouse) => Uint8Array
  embeddedTerminalEncodePaste: (handle: EmbeddedTerminalHandle, input: Uint8Array) => Uint8Array
  embeddedTerminalEncodeFocus: (handle: EmbeddedTerminalHandle, focused: boolean) => Uint8Array
  embeddedTerminalDrainResponses: (handle: EmbeddedTerminalHandle) => Uint8Array
  onNativeEvent: (name: string, handler: (data: ArrayBuffer) => void) => void
  onceNativeEvent: (name: string, handler: (data: ArrayBuffer) => void) => void
  offNativeEvent: (name: string, handler: (data: ArrayBuffer) => void) => void
  onAnyNativeEvent: (handler: (name: string, data: ArrayBuffer) => void) => void
}

class FFIRenderLib implements RenderLib {
  private opentui: ReturnType<typeof getOpenTUILib>
  private iccCacheClient = false
  // Layout reads are synchronous and non-reentrant. Retain one backing buffer so
  // Node does not allocate and resolve a new output pointer for every node.
  private readonly yogaLayout = new Float32Array(6)
  private readonly ffiStructStorage = {
    logicalCursor: {
      ...allocFFIStruct(LogicalCursorStruct),
      result: { row: 0, col: 0, offset: 0 } as LogicalCursor,
    },
    visualCursor: {
      ...allocFFIStruct(VisualCursorStruct),
      result: {
        visualRow: 0,
        visualCol: 0,
        logicalRow: 0,
        logicalCol: 0,
        offset: 0,
      } as VisualCursor,
    },
    measureResult: {
      ...allocFFIStruct(MeasureResultStruct),
      result: { lineCount: 0, widthColsMax: 0 } as MeasureResult,
    },
    embeddedTerminalCursor: allocFFIStruct(EmbeddedTerminalCursorStruct),
    embeddedTerminalKeyOptions: allocFFIStruct(EmbeddedTerminalKeyOptionsStruct),
    audioStreamStats: {
      ...allocFFIStruct(AudioStreamStatsStruct),
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
    imageDrawOptions: allocFFIStruct(ImageDrawOptionsStruct),
    gridDrawOptions: allocFFIStruct(GridDrawOptionsStruct),
  }
  private disposed = false
  private clipboardServices = new Set<ClipboardServiceHandle>()
  public readonly encoder: TextEncoder = new TextEncoder()
  public readonly decoder: TextDecoder = new TextDecoder()
  private logCallbackWrapper: FFICallbackInstance | null = null
  private eventCallbackWrapper: FFICallbackInstance | null = null
  private eventSinkPtr: EventSinkHandle | null = null
  private _nativeEvents: EventEmitter = new EventEmitter()
  private _anyEventHandlers: Array<(name: string, data: ArrayBuffer) => void> = []
  private nativeSpanFeedCallbackWrapper: FFICallbackInstance | null = null
  private nativeSpanFeedHandlers = new Map<Pointer, NativeSpanFeedEventHandler>()

  public createNativeRenderable(): NativeRenderableHandle {
    const handle = this.opentui.symbols.createNativeRenderable() as NativeRenderableHandle
    if (!handle) throw new Error("Failed to create native renderable")
    return handle
  }

  public destroyNativeRenderable(handle: NativeRenderableHandle): void {
    this.opentui.symbols.destroyNativeRenderable(handle)
  }

  public nativeRenderableAttachYogaNode(handle: NativeRenderableHandle, node: Pointer): boolean {
    // Node's FFI returns bools as 0/1 numbers; normalize so the interface stays truthful.
    return Boolean(this.opentui.symbols.nativeRenderableAttachYogaNode(handle, node))
  }

  public nativeRenderableSetMeasureTarget(
    handle: NativeRenderableHandle,
    kind: NativeMeasureTargetKind,
    target: NativeMeasureTargetHandle | 0,
  ): boolean {
    return Boolean(this.opentui.symbols.nativeRenderableSetMeasureTarget(handle, kind, target))
  }

  public createEmbeddedTerminal(options: {
    cols: number
    rows: number
    maxScrollback?: number
  }): EmbeddedTerminalHandle {
    const cols = embeddedTerminalDimension(options.cols, "columns")
    const rows = embeddedTerminalDimension(options.rows, "rows")
    const maxScrollback = toSafeFFIU32Length(options.maxScrollback ?? 10_000, "Embedded terminal maxScrollback")
    const out = new Uint32Array(1)
    embeddedTerminalResult(this.opentui.symbols.createEmbeddedTerminal(cols, rows, maxScrollback, out), "creation")
    if (!out[0]) throw new Error("Embedded terminal creation returned an invalid handle")
    return out[0] as EmbeddedTerminalHandle
  }

  public destroyEmbeddedTerminal(handle: EmbeddedTerminalHandle): void {
    this.opentui.symbols.destroyEmbeddedTerminal(handle)
  }

  public embeddedTerminalWrite(handle: EmbeddedTerminalHandle, data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? this.encoder.encode(data) : data
    const length = toSafeFFIU32Length(bytes.byteLength, "Embedded terminal write length")
    embeddedTerminalResult(
      this.opentui.symbols.embeddedTerminalWrite(handle, length === 0 ? null : bytes, length),
      "write",
    )
  }

  public embeddedTerminalResize(handle: EmbeddedTerminalHandle, cols: number, rows: number): void {
    embeddedTerminalResult(
      this.opentui.symbols.embeddedTerminalResize(
        handle,
        embeddedTerminalDimension(cols, "columns"),
        embeddedTerminalDimension(rows, "rows"),
      ),
      "resize",
    )
  }

  public embeddedTerminalInvalidate(handle: EmbeddedTerminalHandle): void {
    embeddedTerminalResult(this.opentui.symbols.embeddedTerminalInvalidate(handle), "invalidation")
  }

  public embeddedTerminalScroll(handle: EmbeddedTerminalHandle, delta: number): void {
    embeddedTerminalResult(
      this.opentui.symbols.embeddedTerminalScroll(handle, embeddedTerminalI32(delta, "scroll delta")),
      "scroll",
    )
  }

  public embeddedTerminalSetSelection(
    handle: EmbeddedTerminalHandle,
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): void {
    embeddedTerminalResult(
      this.opentui.symbols.embeddedTerminalSetSelection(
        handle,
        embeddedTerminalDimension(start.x + 1, "selection start x") - 1,
        embeddedTerminalDimension(start.y + 1, "selection start y") - 1,
        embeddedTerminalDimension(end.x + 1, "selection end x") - 1,
        embeddedTerminalDimension(end.y + 1, "selection end y") - 1,
      ),
      "selection update",
    )
  }

  public embeddedTerminalClearSelection(handle: EmbeddedTerminalHandle): void {
    embeddedTerminalResult(this.opentui.symbols.embeddedTerminalClearSelection(handle), "selection clear")
  }

  public embeddedTerminalGetSelectedText(handle: EmbeddedTerminalHandle): Uint8Array {
    const required = new Uint32Array(1)
    const read = (output: Uint8Array) =>
      this.opentui.symbols.embeddedTerminalGetSelectedText(handle, viewOrNull(output), output.byteLength, required)
    const initial = new Uint8Array(256)
    const status = read(initial)
    if (status >= 0) return initial.slice(0, status)
    if (status !== -4 || required[0] <= initial.byteLength) embeddedTerminalResult(status, "selection query")
    const output = new Uint8Array(required[0])
    const length = embeddedTerminalResult(read(output), "selection query")
    return output.slice(0, length)
  }

  public embeddedTerminalCompose(
    handle: EmbeddedTerminalHandle,
    target: OptimizedBufferHandle,
    x: number,
    y: number,
  ): void {
    embeddedTerminalResult(
      this.opentui.symbols.embeddedTerminalCompose(
        handle,
        target,
        embeddedTerminalI32(x, "composition x"),
        embeddedTerminalI32(y, "composition y"),
      ),
      "compose",
    )
  }

  public embeddedTerminalCursor(handle: EmbeddedTerminalHandle): EmbeddedTerminalCursor {
    const storage = this.ffiStructStorage.embeddedTerminalCursor
    embeddedTerminalResult(this.opentui.symbols.embeddedTerminalCursor(handle, storage.ffiView), "cursor query")
    const result = EmbeddedTerminalCursorStruct.unpack(storage.buffer)
    return {
      x: result.x,
      y: result.y,
      hasValue: result.hasValue,
      visible: result.visible,
      blinking: result.blinking,
      wideTail: result.wideTail,
      style: (["bar", "block", "underline", "block-hollow"] as const)[result.style] ?? "block",
      ...(result.colorHasValue ? { color: { r: result.colorR, g: result.colorG, b: result.colorB } } : {}),
    }
  }

  public embeddedTerminalEncodeKey(handle: EmbeddedTerminalHandle, key: EmbeddedTerminalKey): Uint8Array {
    const options = this.ffiStructStorage.embeddedTerminalKeyOptions
    EmbeddedTerminalKeyOptionsStruct.packInto(
      {
        action: { release: 0, press: 1, repeat: 2 }[key.action ?? "press"],
        composing: key.composing ? 1 : 0,
        mods: key.mods ?? 0,
        consumedMods: key.consumedMods ?? 0,
        padding: 0,
        unshiftedCodepoint: key.unshiftedCodepoint ?? 0,
      },
      options.view,
      0,
    )
    const keyCode = key.key ? this.encoder.encode(key.key) : new Uint8Array()
    const keyCodeLength = toSafeFFIU32Length(keyCode.byteLength, "Embedded terminal physical key length")
    const text = key.text ? this.encoder.encode(key.text) : new Uint8Array()
    const textLength = toSafeFFIU32Length(text.byteLength, "Embedded terminal key text length")
    const required = new Uint32Array(1)
    const encode = (output: Uint8Array) =>
      this.opentui.symbols.embeddedTerminalEncodeKey(
        handle,
        options.ffiView,
        keyCodeLength === 0 ? null : keyCode,
        keyCodeLength,
        textLength === 0 ? null : text,
        textLength,
        output,
        output.byteLength,
        required,
      )
    const initial = new Uint8Array(Math.max(64, textLength))
    const status = encode(initial)
    if (status >= 0) return initial.slice(0, status)
    if (status !== -4 || required[0] <= initial.byteLength) embeddedTerminalResult(status, "key encoding")
    const output = new Uint8Array(required[0])
    const length = embeddedTerminalResult(encode(output), "key encoding")
    return output.slice(0, length)
  }

  public embeddedTerminalEncodeMouse(handle: EmbeddedTerminalHandle, mouse: EmbeddedTerminalMouse): Uint8Array {
    const output = new Uint8Array(128)
    const length = embeddedTerminalResult(
      this.opentui.symbols.embeddedTerminalEncodeMouse(
        handle,
        { press: 0, release: 1, motion: 2 }[mouse.action],
        mouse.button
          ? { unknown: 0, left: 1, right: 2, middle: 3, four: 4, five: 5, six: 6, seven: 7 }[mouse.button]
          : -1,
        mouse.mods ?? 0,
        embeddedTerminalF32(mouse.x, "mouse x"),
        embeddedTerminalF32(mouse.y, "mouse y"),
        mouse.anyButtonPressed ? 1 : 0,
        output,
        output.byteLength,
      ),
      "mouse encoding",
    )
    return output.slice(0, length)
  }

  public embeddedTerminalEncodePaste(handle: EmbeddedTerminalHandle, input: Uint8Array): Uint8Array {
    const inputLength = toSafeFFIU32Length(input.byteLength, "Embedded terminal paste length")
    const outputLength = toSafeFFIU32Length(inputLength + 16, "Embedded terminal paste output length")
    const output = new Uint8Array(outputLength)
    const length = embeddedTerminalResult(
      this.opentui.symbols.embeddedTerminalEncodePaste(
        handle,
        inputLength === 0 ? null : input,
        inputLength,
        output,
        output.byteLength,
      ),
      "paste encoding",
    )
    return output.slice(0, length)
  }

  public embeddedTerminalEncodeFocus(handle: EmbeddedTerminalHandle, focused: boolean): Uint8Array {
    const output = new Uint8Array(16)
    const length = embeddedTerminalResult(
      this.opentui.symbols.embeddedTerminalEncodeFocus(handle, focused ? 1 : 0, output, output.byteLength),
      "focus encoding",
    )
    return output.slice(0, length)
  }

  public embeddedTerminalDrainResponses(handle: EmbeddedTerminalHandle): Uint8Array {
    const chunks: Uint8Array[] = []
    while (true) {
      const output = new Uint8Array(64 * 1024)
      const status = this.opentui.symbols.embeddedTerminalDrainResponses(handle, output, output.byteLength)
      // Native preserves the bounded prefix and reports dropped excess once.
      if (status === -4) continue
      const length = embeddedTerminalResult(status, "response drain")
      if (length > 0) chunks.push(output.slice(0, length))
      if (length < output.byteLength) break
    }
    const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }

  constructor(libPath?: string) {
    this.opentui = getOpenTUILib(libPath)
    this.imageRetainIccCache()
    this.iccCacheClient = true
    try {
      this.setupLogging()
      this.setupEventBus()
    } catch (error) {
      this.dispose()
      throw error
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
    if (this.clipboardServices.size > 0) {
      throw new Error("Cannot dispose OpenTUI native library while clipboard services are active")
    }
    this.disposed = true
    try {
      if (this.eventSinkPtr) {
        this.opentui.symbols.destroyEventSink(this.eventSinkPtr)
        this.eventSinkPtr = null
      }

      this.yogaSetMeasureCallback(null)
      this.yogaSetDirtiedCallback(null)
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
          this.eventCallbackWrapper = null
          this.logCallbackWrapper = null
          this.nativeSpanFeedCallbackWrapper = null
          this.nativeSpanFeedHandlers.clear()
        }
      }
    }
  }

  private setupEventBus() {
    if (this.eventCallbackWrapper) {
      return
    }

    const eventCallback = this.opentui.createCallback(
      (namePtr: Pointer, nameLen: number, dataPtr: Pointer, dataLen: number) => {
        try {
          if (nameLen === 0 || !namePtr) {
            return
          }

          const eventName = this.decoder.decode(toArrayBuffer(namePtr, 0, nameLen))
          const eventData = dataLen > 0 && dataPtr ? toArrayBuffer(dataPtr, 0, dataLen).slice(0) : new ArrayBuffer(0)

          queueMicrotask(() => {
            this._nativeEvents.emit(eventName, eventData)

            for (const handler of this._anyEventHandlers) {
              handler(eventName, eventData)
            }
          })
        } catch (error) {
          console.error("Error in native event callback:", error)
        }
      },
      {
        args: ["ptr", "u32", "ptr", "u32"],
        returns: "void",
      },
    )

    this.eventCallbackWrapper = eventCallback

    if (!eventCallback.ptr) {
      throw new Error("Failed to create event callback")
    }

    this.eventSinkPtr = this.opentui.symbols.createEventSink(eventCallback.ptr)
    if (!this.eventSinkPtr) {
      eventCallback.close()
      this.eventCallbackWrapper = null
      throw new Error("Failed to create native event sink")
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

  public createRenderer(width: number, height: number, options: NativeRendererCreateOptions = {}) {
    const bufferedOutputKind = options.bufferedOutput === "memory" ? 1 : 0
    const remoteMode = options.remote === undefined ? 0 : options.remote ? 2 : 1
    // `feedPtr` is an internal wiring detail: non-null selects the feed backend
    // used for custom Writable output. When null, `bufferedOutput` selects the
    // buffered stdout or memory backend.
    const feedPtr = options.feedPtr ?? null
    const renderer = this.opentui.symbols.createRenderer(
      width,
      height,
      bufferedOutputKind,
      remoteMode,
      feedPtr,
    ) as RendererHandle
    return renderer ? renderer : null
  }

  public setTerminalEnvVar(renderer: Pointer, key: string, value: string): boolean {
    const keyBytes = this.encoder.encode(key)
    const valueBytes = this.encoder.encode(value)
    return this.opentui.symbols.setTerminalEnvVar(
      renderer,
      viewOrNull(keyBytes),
      keyBytes.byteLength,
      viewOrNull(valueBytes),
      valueBytes.byteLength,
    )
  }

  public destroyRenderer(renderer: Pointer, flushInput: boolean = false): void {
    this.opentui.symbols.destroyRenderer(renderer, ffiBool(flushInput))
  }

  public setUseThread(renderer: Pointer, useThread: boolean) {
    this.opentui.symbols.setUseThread(renderer, ffiBool(useThread))
  }

  public setClearOnShutdown(renderer: Pointer, clear: boolean) {
    this.opentui.symbols.setClearOnShutdown(renderer, ffiBool(clear))
  }

  public setBackgroundColor(renderer: Pointer, color: RGBA) {
    this.opentui.symbols.setBackgroundColor(renderer, rgbaBuffer(color))
  }

  public setRenderOffset(renderer: Pointer, offset: number) {
    this.opentui.symbols.setRenderOffset(renderer, offset)
  }

  public resetSplitScrollback(renderer: Pointer, seedRows: number, pinnedRenderOffset: number): number {
    return this.opentui.symbols.resetSplitScrollback(renderer, seedRows, pinnedRenderOffset)
  }

  public syncSplitScrollback(renderer: Pointer, pinnedRenderOffset: number): number {
    return this.opentui.symbols.syncSplitScrollback(renderer, pinnedRenderOffset)
  }

  public getSplitOutputOffset(renderer: Pointer, surfaceOffset: number): number {
    return this.opentui.symbols.getSplitOutputOffset(renderer, surfaceOffset)
  }

  public setPendingSplitFooterTransition(
    renderer: Pointer,
    mode: number,
    sourceTopLine: number,
    sourceHeight: number,
    targetTopLine: number,
    targetHeight: number,
    scrollLines: number,
  ): void {
    this.opentui.symbols.setPendingSplitFooterTransition(
      renderer,
      mode,
      sourceTopLine,
      sourceHeight,
      targetTopLine,
      targetHeight,
      scrollLines,
    )
  }

  public clearPendingSplitFooterTransition(renderer: Pointer): void {
    this.opentui.symbols.clearPendingSplitFooterTransition(renderer)
  }

  public updateStats(renderer: Pointer, time: number, fps: number, frameCallbackTime: number) {
    this.opentui.symbols.updateStats(renderer, time, fps, frameCallbackTime)
  }

  public updateMemoryStats(renderer: Pointer, heapUsed: number, heapTotal: number, arrayBuffers: number) {
    this.opentui.symbols.updateMemoryStats(renderer, heapUsed, heapTotal, arrayBuffers)
  }

  public getRenderStats(renderer: Pointer): NativeRenderStats {
    const statsBuffer = new ArrayBuffer(NativeRenderStatsStruct.size)
    this.opentui.symbols.getRenderStats(renderer, statsBuffer)
    const stats = NativeRenderStatsStruct.unpack(statsBuffer)

    return {
      nativeLastFrameTime: stats.lastFrameTime,
      nativeAverageFrameTime: stats.averageFrameTime,
      nativeFrameCount: toNumber(stats.frameCount),
      cellsUpdated: stats.cellsUpdated,
      averageCellsUpdated: stats.averageCellsUpdated,
      nativeRenderTime: stats.renderTimeValid ? stats.renderTime : undefined,
      nativeStdoutWriteTime: stats.stdoutWriteTimeValid ? stats.stdoutWriteTime : undefined,
    }
  }

  public getNextBuffer(renderer: Pointer): OptimizedBuffer {
    const bufferPtr = this.opentui.symbols.getNextBuffer(renderer)
    if (!bufferPtr) {
      throw new Error("Failed to get next buffer")
    }

    const width = this.opentui.symbols.getBufferWidth(bufferPtr)
    const height = this.opentui.symbols.getBufferHeight(bufferPtr)
    const widthMethod = widthMethodFromCode(this.opentui.symbols.getBufferWidthMethod(bufferPtr))

    return new OptimizedBuffer(this, bufferPtr, width, height, { id: "next buffer", widthMethod })
  }

  public getCurrentBuffer(renderer: Pointer): OptimizedBuffer {
    const bufferPtr = this.opentui.symbols.getCurrentBuffer(renderer)
    if (!bufferPtr) {
      throw new Error("Failed to get current buffer")
    }

    const width = this.opentui.symbols.getBufferWidth(bufferPtr)
    const height = this.opentui.symbols.getBufferHeight(bufferPtr)
    const widthMethod = widthMethodFromCode(this.opentui.symbols.getBufferWidthMethod(bufferPtr))

    return new OptimizedBuffer(this, bufferPtr, width, height, { id: "current buffer", widthMethod })
  }

  public rendererSetPaletteState(
    renderer: Pointer,
    palette: readonly RGBA[],
    defaultForeground: RGBA,
    defaultBackground: RGBA,
    paletteEpoch: number,
  ): void {
    const paletteBuffer = new Uint16Array(palette.length * 4)

    for (let index = 0; index < palette.length; index++) {
      paletteBuffer.set(palette[index].buffer, index * 4)
    }

    this.opentui.symbols.rendererSetPaletteState(
      renderer,
      paletteBuffer,
      palette.length,
      rgbaBuffer(defaultForeground),
      rgbaBuffer(defaultBackground),
      paletteEpoch >>> 0,
    )
  }

  public bufferGetCharPtr(buffer: Pointer): Pointer {
    const ptr = this.opentui.symbols.bufferGetCharPtr(buffer)
    if (!ptr) {
      throw new Error("Failed to get char pointer")
    }
    return ptr
  }

  public bufferGetFgPtr(buffer: Pointer): Pointer {
    const ptr = this.opentui.symbols.bufferGetFgPtr(buffer)
    if (!ptr) {
      throw new Error("Failed to get fg pointer")
    }
    return ptr
  }

  public bufferGetBgPtr(buffer: Pointer): Pointer {
    const ptr = this.opentui.symbols.bufferGetBgPtr(buffer)
    if (!ptr) {
      throw new Error("Failed to get bg pointer")
    }
    return ptr
  }

  public bufferGetAttributesPtr(buffer: Pointer): Pointer {
    const ptr = this.opentui.symbols.bufferGetAttributesPtr(buffer)
    if (!ptr) {
      throw new Error("Failed to get attributes pointer")
    }
    return ptr
  }

  public bufferGetRespectAlpha(buffer: Pointer): boolean {
    return this.opentui.symbols.bufferGetRespectAlpha(buffer)
  }

  public bufferSetRespectAlpha(buffer: Pointer, respectAlpha: boolean): void {
    this.opentui.symbols.bufferSetRespectAlpha(buffer, ffiBool(respectAlpha))
  }

  public bufferGetId(buffer: Pointer): string {
    const maxLen = 256
    const outBuffer = new Uint8Array(maxLen)
    const actualLen = this.opentui.symbols.bufferGetId(buffer, outBuffer, maxLen)
    return this.decoder.decode(outBuffer.slice(0, actualLen))
  }

  public bufferGetRealCharSize(buffer: Pointer): number {
    return this.opentui.symbols.bufferGetRealCharSize(buffer)
  }

  public bufferWriteResolvedChars(buffer: Pointer, outputBuffer: Uint8Array, addLineBreaks: boolean): number {
    return this.opentui.symbols.bufferWriteResolvedChars(
      buffer,
      viewOrNull(outputBuffer),
      outputBuffer.byteLength,
      ffiBool(addLineBreaks),
    )
  }

  public getBufferWidth(buffer: Pointer): number {
    return this.opentui.symbols.getBufferWidth(buffer)
  }

  public getBufferHeight(buffer: Pointer): number {
    return this.opentui.symbols.getBufferHeight(buffer)
  }

  public bufferClear(buffer: Pointer, color: RGBA) {
    this.opentui.symbols.bufferClear(buffer, rgbaBuffer(color))
  }

  public bufferDrawText(
    buffer: Pointer,
    text: string,
    x: number,
    y: number,
    color: RGBA,
    bgColor?: RGBA,
    attributes?: number,
  ) {
    const textBytes = this.encoder.encode(text)
    const bg = optionalRgbaBuffer(bgColor)
    const fg = rgbaBuffer(color)

    this.opentui.symbols.bufferDrawText(
      buffer,
      viewOrNull(textBytes),
      textBytes.byteLength,
      x,
      y,
      fg,
      bg,
      attributes ?? 0,
    )
  }

  public bufferSetCellWithAlphaBlending(
    buffer: Pointer,
    x: number,
    y: number,
    char: string,
    color: RGBA,
    bgColor: RGBA,
    attributes?: number,
  ) {
    const charPtr = char.codePointAt(0) ?? " ".codePointAt(0)!
    const bg = rgbaBuffer(bgColor)
    const fg = rgbaBuffer(color)

    this.opentui.symbols.bufferSetCellWithAlphaBlending(buffer, x, y, charPtr, fg, bg, attributes ?? 0)
  }

  public bufferSetCell(
    buffer: Pointer,
    x: number,
    y: number,
    char: string,
    color: RGBA,
    bgColor: RGBA,
    attributes?: number,
  ) {
    const charPtr = char.codePointAt(0) ?? " ".codePointAt(0)!
    const bg = rgbaBuffer(bgColor)
    const fg = rgbaBuffer(color)

    this.opentui.symbols.bufferSetCell(buffer, x, y, charPtr, fg, bg, attributes ?? 0)
  }

  public bufferFillRect(buffer: Pointer, x: number, y: number, width: number, height: number, color: RGBA) {
    const bg = rgbaBuffer(color)
    this.opentui.symbols.bufferFillRect(buffer, x, y, width, height, bg)
  }

  public bufferColorMatrix(
    buffer: Pointer,
    matrix: Pointer | Float32Array,
    cellMask: Pointer | Float32Array,
    cellMaskCount: number,
    strength: number,
    target: TargetChannel,
  ): void {
    this.opentui.symbols.bufferColorMatrix(buffer, matrix, cellMask, cellMaskCount, strength, target)
  }

  public bufferColorMatrixUniform(
    buffer: Pointer,
    matrix: Pointer | Float32Array,
    strength: number,
    target: TargetChannel,
  ): void {
    this.opentui.symbols.bufferColorMatrixUniform(buffer, matrix, strength, target)
  }

  public bufferDrawSuperSampleBuffer(
    buffer: Pointer,
    x: number,
    y: number,
    pixelData: Pointer | Uint8Array,
    pixelDataLength: number,
    format: "bgra8unorm" | "rgba8unorm",
    alignedBytesPerRow: number,
  ): void {
    const formatId = format === "bgra8unorm" ? 0 : 1
    this.opentui.symbols.bufferDrawSuperSampleBuffer(
      buffer,
      x,
      y,
      pixelData,
      pixelDataLength,
      formatId,
      alignedBytesPerRow,
    )
  }

  public bufferDrawImage(
    buffer: OptimizedBufferHandle,
    image: ImageHandle,
    x: number,
    y: number,
    width: number,
    height: number,
    pixelWidth: number,
    pixelHeight: number,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    protocol: ImageRenderProtocol,
  ): boolean {
    const protocolId = { auto: 0, kitty: 1, sixel: 2, blocks: 3 }[protocol]
    const storage = this.ffiStructStorage.imageDrawOptions
    ImageDrawOptionsStruct.packInto(
      {
        x,
        y,
        width,
        height,
        pixelWidth,
        pixelHeight,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        protocol: protocolId,
      },
      storage.view,
      0,
    )
    return Boolean(this.opentui.symbols.bufferDrawImage(buffer, image, storage.ffiView))
  }

  public bufferDrawPackedBuffer(
    buffer: Pointer,
    data: Pointer | Uint8Array,
    dataLen: number,
    posX: number,
    posY: number,
    terminalWidthCells: number,
    terminalHeightCells: number,
  ): void {
    this.opentui.symbols.bufferDrawPackedBuffer(
      buffer,
      data,
      dataLen,
      posX,
      posY,
      terminalWidthCells,
      terminalHeightCells,
    )
  }

  public bufferDrawGrayscaleBuffer(
    buffer: Pointer,
    posX: number,
    posY: number,
    intensities: Pointer | Float32Array,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null,
    bg: RGBA | null,
  ): void {
    this.opentui.symbols.bufferDrawGrayscaleBuffer(
      buffer,
      posX,
      posY,
      intensities,
      srcWidth,
      srcHeight,
      optionalRgbaBuffer(fg),
      optionalRgbaBuffer(bg),
    )
  }

  public bufferDrawGrayscaleBufferSupersampled(
    buffer: Pointer,
    posX: number,
    posY: number,
    intensities: Pointer | Float32Array,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null,
    bg: RGBA | null,
  ): void {
    this.opentui.symbols.bufferDrawGrayscaleBufferSupersampled(
      buffer,
      posX,
      posY,
      intensities,
      srcWidth,
      srcHeight,
      optionalRgbaBuffer(fg),
      optionalRgbaBuffer(bg),
    )
  }

  public bufferDrawGrid(
    buffer: Pointer,
    borderChars: Uint32Array,
    borderFg: RGBA,
    borderBg: RGBA,
    columnOffsets: Int32Array,
    columnCount: number,
    rowOffsets: Int32Array,
    rowCount: number,
    options: { drawInner: boolean; drawOuter: boolean },
  ): void {
    GridDrawOptionsStruct.packInto(
      { drawInner: options.drawInner, drawOuter: options.drawOuter },
      this.ffiStructStorage.gridDrawOptions.view,
      0,
    )

    this.opentui.symbols.bufferDrawGrid(
      buffer,
      borderChars,
      rgbaBuffer(borderFg),
      rgbaBuffer(borderBg),
      columnOffsets,
      columnCount,
      rowOffsets,
      rowCount,
      this.ffiStructStorage.gridDrawOptions.ffiView,
    )
  }

  public bufferDrawBox(
    buffer: Pointer,
    x: number,
    y: number,
    width: number,
    height: number,
    borderChars: Uint32Array,
    packedOptions: number,
    borderColor: RGBA,
    backgroundColor: RGBA,
    titleColor: RGBA,
    title: string | null,
    bottomTitle: string | null,
  ): void {
    const titleBytes = title ? this.encoder.encode(title) : null
    const titleLen = titleBytes?.byteLength ?? 0
    const titleBuffer = titleBytes ? titleBytes : null

    const bottomTitleBytes = bottomTitle ? this.encoder.encode(bottomTitle) : null
    const bottomTitleLen = bottomTitleBytes?.byteLength ?? 0
    const bottomTitleBuffer = bottomTitleBytes ? bottomTitleBytes : null

    this.opentui.symbols.bufferDrawBox(
      buffer,
      x,
      y,
      width,
      height,
      borderChars,
      packedOptions,
      rgbaBuffer(borderColor),
      rgbaBuffer(backgroundColor),
      rgbaBuffer(titleColor),
      titleBuffer,
      titleLen,
      bottomTitleBuffer,
      bottomTitleLen,
    )
  }

  public bufferResize(buffer: Pointer, width: number, height: number): void {
    this.opentui.symbols.bufferResize(buffer, width, height)
  }

  // Link API
  public linkAlloc(url: string): number {
    const urlBytes = this.encoder.encode(url)
    return this.opentui.symbols.linkAlloc(viewOrNull(urlBytes), urlBytes.byteLength)
  }

  public linkGetUrl(linkId: number, maxLen: number = MAX_LINK_URL_BYTES): string {
    const outBuffer = new Uint8Array(maxLen)
    const actualLen = this.opentui.symbols.linkGetUrl(linkId, viewOrNull(outBuffer), maxLen)
    return this.decoder.decode(outBuffer.slice(0, actualLen))
  }

  public attributesWithLink(baseAttributes: number, linkId: number): number {
    return this.opentui.symbols.attributesWithLink(baseAttributes, linkId)
  }

  public attributesGetLinkId(attributes: number): number {
    return this.opentui.symbols.attributesGetLinkId(attributes)
  }

  public resizeRenderer(renderer: Pointer, width: number, height: number) {
    this.opentui.symbols.resizeRenderer(renderer, width, height)
  }

  public setCursorPosition(renderer: Pointer, x: number, y: number, visible: boolean) {
    this.opentui.symbols.setCursorPosition(renderer, x, y, ffiBool(visible))
  }

  public setCursorColor(renderer: Pointer, color: RGBA) {
    this.opentui.symbols.setCursorColor(renderer, rgbaBuffer(color))
  }

  public getCursorState(renderer: Pointer): CursorState {
    const cursorBuffer = new ArrayBuffer(CursorStateStruct.size)
    this.opentui.symbols.getCursorState(renderer, cursorBuffer)
    const struct = CursorStateStruct.unpack(cursorBuffer)

    return {
      x: struct.x,
      y: struct.y,
      visible: struct.visible,
      style: CURSOR_ID_TO_STYLE[struct.style] ?? "block",
      blinking: struct.blinking,
      color: RGBA.fromValues(struct.r, struct.g, struct.b, struct.a),
    }
  }

  public setCursorStyleOptions(renderer: Pointer, options: CursorStyleOptions): void {
    const style = options.style != null ? CURSOR_STYLE_TO_ID[options.style] : 255
    const blinking = options.blinking != null ? (options.blinking ? 1 : 0) : 255
    const cursor = options.cursor != null ? MOUSE_STYLE_TO_ID[options.cursor] : 255

    const buffer = CursorStyleOptionsStruct.pack({ style, blinking, color: options.color, cursor })
    this.opentui.symbols.setCursorStyleOptions(renderer, buffer)
  }

  public render(renderer: Pointer, force: boolean): number {
    return this.opentui.symbols.render(renderer, ffiBool(force))
  }

  private unpackRenderOperationResult(value: number | bigint): NativeRenderOperationResult {
    const packed = typeof value === "bigint" ? value : BigInt(value)
    return {
      renderOffset: Number(packed & 0xffffffffn),
      status: Number((packed >> 32n) & 0xffn),
    }
  }

  public repaintSplitFooter(
    renderer: Pointer,
    pinnedRenderOffset: number,
    force: boolean,
  ): NativeRenderOperationResult {
    return this.unpackRenderOperationResult(
      this.opentui.symbols.repaintSplitFooter(renderer, pinnedRenderOffset, ffiBool(force)),
    )
  }

  public commitSplitFooterSnapshot(
    renderer: Pointer,
    snapshot: OptimizedBuffer,
    rowColumns: number,
    startOnNewLine: boolean,
    trailingNewline: boolean,
    pinnedRenderOffset: number,
    force: boolean,
    beginFrame: boolean = true,
    finalizeFrame: boolean = true,
    controlOutput: boolean = false,
  ): NativeRenderOperationResult {
    const flags =
      ffiBool(startOnNewLine) |
      (ffiBool(trailingNewline) << 1) |
      (ffiBool(force) << 2) |
      (ffiBool(beginFrame) << 3) |
      (ffiBool(finalizeFrame) << 4) |
      (ffiBool(controlOutput) << 5)

    return this.unpackRenderOperationResult(
      this.opentui.symbols.commitSplitFooterSnapshot(renderer, snapshot.ptr, rowColumns, flags, pinnedRenderOffset),
    )
  }

  public createOptimizedBuffer(
    width: number,
    height: number,
    widthMethod: WidthMethod,
    respectAlpha: boolean = false,
    id?: string,
  ): OptimizedBuffer {
    if (Number.isNaN(width) || Number.isNaN(height)) {
      console.error(new Error(`Invalid dimensions for OptimizedBuffer: ${width}x${height}`).stack)
    }

    const idToUse = id || "unnamed buffer"
    const idBytes = this.encoder.encode(idToUse)
    const bufferPtr = this.opentui.symbols.createOptimizedBuffer(
      width,
      height,
      ffiBool(respectAlpha),
      widthMethodCode(widthMethod),
      idBytes,
      idBytes.byteLength,
    )
    if (!bufferPtr) {
      throw new Error(`Failed to create optimized buffer: ${width}x${height}`)
    }

    return new OptimizedBuffer(this, bufferPtr, width, height, { respectAlpha, id, widthMethod })
  }

  public destroyOptimizedBuffer(bufferPtr: Pointer) {
    this.opentui.symbols.destroyOptimizedBuffer(bufferPtr)
  }

  public drawFrameBuffer(
    targetBufferPtr: Pointer,
    destX: number,
    destY: number,
    bufferPtr: Pointer,
    sourceX?: number,
    sourceY?: number,
    sourceWidth?: number,
    sourceHeight?: number,
  ) {
    const srcX = sourceX ?? 0
    const srcY = sourceY ?? 0
    const srcWidth = sourceWidth ?? 0
    const srcHeight = sourceHeight ?? 0
    this.opentui.symbols.drawFrameBuffer(targetBufferPtr, destX, destY, bufferPtr, srcX, srcY, srcWidth, srcHeight)
  }

  public setDebugOverlay(renderer: Pointer, enabled: boolean, corner: DebugOverlayCorner) {
    this.opentui.symbols.setDebugOverlay(renderer, ffiBool(enabled), corner)
  }

  public clearTerminal(renderer: Pointer) {
    this.opentui.symbols.clearTerminal(renderer)
  }

  public setTerminalTitle(renderer: Pointer, title: string) {
    const titleBytes = this.encoder.encode(title)
    this.opentui.symbols.setTerminalTitle(renderer, viewOrNull(titleBytes), titleBytes.byteLength)
  }

  public copyToClipboardOSC52(renderer: Pointer, target: number, textUtf8: Uint8Array): boolean {
    if (textUtf8.byteLength > 0xffffffff) return false
    return Boolean(
      this.opentui.symbols.copyToClipboardOSC52(renderer, target, viewOrNull(textUtf8), textUtf8.byteLength),
    )
  }

  public clearClipboardOSC52(renderer: Pointer, target: number): boolean {
    return Boolean(this.opentui.symbols.clearClipboardOSC52(renderer, target))
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

  public triggerNotification(renderer: Pointer, message: string, title?: string): boolean {
    const messageBytes = this.encoder.encode(message)
    const titleBytes = title === undefined ? null : this.encoder.encode(title)
    return Boolean(
      this.opentui.symbols.triggerNotification(
        renderer,
        messageBytes,
        messageBytes.length,
        titleBytes,
        titleBytes?.length ?? 0,
      ),
    )
  }

  public addToHitGrid(renderer: Pointer, x: number, y: number, width: number, height: number, id: number) {
    this.opentui.symbols.addToHitGrid(renderer, x, y, width, height, id)
  }

  public clearCurrentHitGrid(renderer: Pointer) {
    this.opentui.symbols.clearCurrentHitGrid(renderer)
  }

  public hitGridPushScissorRect(renderer: Pointer, x: number, y: number, width: number, height: number) {
    this.opentui.symbols.hitGridPushScissorRect(renderer, x, y, width, height)
  }

  public hitGridPopScissorRect(renderer: Pointer) {
    this.opentui.symbols.hitGridPopScissorRect(renderer)
  }

  public hitGridClearScissorRects(renderer: Pointer) {
    this.opentui.symbols.hitGridClearScissorRects(renderer)
  }

  public addToCurrentHitGridClipped(
    renderer: Pointer,
    x: number,
    y: number,
    width: number,
    height: number,
    id: number,
  ) {
    this.opentui.symbols.addToCurrentHitGridClipped(renderer, x, y, width, height, id)
  }

  public checkHit(renderer: Pointer, x: number, y: number): number {
    return this.opentui.symbols.checkHit(renderer, x, y)
  }

  public getHitGridDirty(renderer: Pointer): boolean {
    return this.opentui.symbols.getHitGridDirty(renderer)
  }

  public dumpHitGrid(renderer: Pointer): void {
    this.opentui.symbols.dumpHitGrid(renderer)
  }

  public dumpBuffers(renderer: Pointer, timestamp?: number): void {
    const ts = BigInt(timestamp ?? Date.now())
    this.opentui.symbols.dumpBuffers(renderer, ts)
  }

  public dumpOutputBuffer(renderer: Pointer, timestamp?: number): void {
    const ts = BigInt(timestamp ?? Date.now())
    this.opentui.symbols.dumpOutputBuffer(renderer, ts)
  }

  public restoreTerminalModes(renderer: Pointer): void {
    this.opentui.symbols.restoreTerminalModes(renderer)
  }

  public enableMouse(renderer: Pointer, enableMovement: boolean): void {
    this.opentui.symbols.enableMouse(renderer, ffiBool(enableMovement))
  }

  public disableMouse(renderer: Pointer): void {
    this.opentui.symbols.disableMouse(renderer)
  }

  public enableKittyKeyboard(renderer: Pointer, flags: number): void {
    this.opentui.symbols.enableKittyKeyboard(renderer, flags)
  }

  public disableKittyKeyboard(renderer: Pointer): void {
    this.opentui.symbols.disableKittyKeyboard(renderer)
  }

  public setKittyKeyboardFlags(renderer: Pointer, flags: number): void {
    this.opentui.symbols.setKittyKeyboardFlags(renderer, flags)
  }

  public getKittyKeyboardFlags(renderer: Pointer): number {
    return this.opentui.symbols.getKittyKeyboardFlags(renderer)
  }

  public setupTerminal(renderer: Pointer, useAlternateScreen: boolean): void {
    this.opentui.symbols.setupTerminal(renderer, ffiBool(useAlternateScreen))
  }

  public suspendRenderer(renderer: Pointer): void {
    this.opentui.symbols.suspendRenderer(renderer)
  }

  public resumeRenderer(renderer: Pointer): void {
    this.opentui.symbols.resumeRenderer(renderer)
  }

  public queryPixelResolution(renderer: Pointer): void {
    this.opentui.symbols.queryPixelResolution(renderer)
  }

  public queryThemeColors(renderer: Pointer): void {
    this.opentui.symbols.queryThemeColors(renderer)
  }

  /**
   * Write data to stdout, synchronizing with the render thread if necessary.
   * This should be used for ALL stdout writes to avoid race conditions when
   * the render thread is active.
   */
  public writeOut(renderer: Pointer, data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    if (bytes.length === 0) return
    this.opentui.symbols.writeOut(renderer, viewOrNull(bytes), bytes.byteLength)
  }

  public yogaConfigCreate(): Pointer {
    const config = this.opentui.symbols.yogaConfigCreate()
    if (!config) throw new Error("Failed to create Yoga config")
    return config
  }

  public yogaConfigFree(config: Pointer): void {
    this.opentui.symbols.yogaConfigFree(config)
  }

  public yogaConfigSetUseWebDefaults(config: Pointer, enabled: boolean): void {
    this.opentui.symbols.yogaConfigSetUseWebDefaults(config, ffiBool(enabled))
  }

  public yogaConfigGetUseWebDefaults(config: Pointer): boolean {
    return this.opentui.symbols.yogaConfigGetUseWebDefaults(config)
  }

  public yogaConfigSetPointScaleFactor(config: Pointer, pointScaleFactor: number): void {
    this.opentui.symbols.yogaConfigSetPointScaleFactor(config, pointScaleFactor)
  }

  public yogaConfigGetPointScaleFactor(config: Pointer): number {
    return this.opentui.symbols.yogaConfigGetPointScaleFactor(config)
  }

  public yogaConfigSetErrata(config: Pointer, errata: number): void {
    this.opentui.symbols.yogaConfigSetErrata(config, errata)
  }

  public yogaConfigGetErrata(config: Pointer): number {
    return this.opentui.symbols.yogaConfigGetErrata(config)
  }

  public yogaConfigSetExperimentalFeatureEnabled(config: Pointer, feature: number, enabled: boolean): void {
    this.opentui.symbols.yogaConfigSetExperimentalFeatureEnabled(config, feature, ffiBool(enabled))
  }

  public yogaConfigIsExperimentalFeatureEnabled(config: Pointer, feature: number): boolean {
    return this.opentui.symbols.yogaConfigIsExperimentalFeatureEnabled(config, feature)
  }

  public yogaNodeCreate(): Pointer {
    const node = this.opentui.symbols.yogaNodeCreate()
    if (!node) throw new Error("Failed to create Yoga node")
    return node
  }

  public yogaNodeCreateForOpenTUI(): Pointer {
    const node = this.opentui.symbols.yogaNodeCreateForOpenTUI()
    if (!node) throw new Error("Failed to create OpenTUI Yoga node")
    return node
  }

  public yogaNodeCreateWithConfig(config: Pointer): Pointer {
    const node = this.opentui.symbols.yogaNodeCreateWithConfig(config)
    if (!node) throw new Error("Failed to create Yoga node")
    return node
  }

  public yogaNodeFree(node: Pointer): void {
    this.opentui.symbols.yogaNodeFree(node)
  }

  public yogaNodeFreeRecursive(node: Pointer): void {
    this.opentui.symbols.yogaNodeFreeRecursive(node)
  }

  public yogaNodeReset(node: Pointer): void {
    this.opentui.symbols.yogaNodeReset(node)
  }

  public yogaNodeCopyStyle(dstNode: Pointer, srcNode: Pointer): void {
    this.opentui.symbols.yogaNodeCopyStyle(dstNode, srcNode)
  }

  public yogaNodeInsertChild(node: Pointer, child: Pointer, index: number): void {
    this.opentui.symbols.yogaNodeInsertChild(node, child, index)
  }

  public yogaNodeRemoveChild(node: Pointer, child: Pointer): void {
    this.opentui.symbols.yogaNodeRemoveChild(node, child)
  }

  public yogaNodeRemoveAllChildren(node: Pointer): void {
    this.opentui.symbols.yogaNodeRemoveAllChildren(node)
  }

  public yogaNodeGetChild(node: Pointer, index: number): Pointer | null {
    return this.opentui.symbols.yogaNodeGetChild(node, index) || null
  }

  public yogaNodeGetChildCount(node: Pointer): number {
    return this.opentui.symbols.yogaNodeGetChildCount(node)
  }

  public yogaNodeGetParent(node: Pointer): Pointer | null {
    return this.opentui.symbols.yogaNodeGetParent(node) || null
  }

  public yogaNodeCalculateLayout(node: Pointer, width: number, height: number, direction: number): void {
    this.opentui.symbols.yogaNodeCalculateLayout(node, width, height, direction)
  }

  public yogaNodeIsDirty(node: Pointer): boolean {
    return this.opentui.symbols.yogaNodeIsDirty(node)
  }

  public yogaNodeMarkDirty(node: Pointer): void {
    this.opentui.symbols.yogaNodeMarkDirty(node)
  }

  public yogaNodeGetHasNewLayout(node: Pointer): boolean {
    return this.opentui.symbols.yogaNodeGetHasNewLayout(node)
  }

  public yogaNodeSetHasNewLayout(node: Pointer, hasNewLayout: boolean): void {
    this.opentui.symbols.yogaNodeSetHasNewLayout(node, ffiBool(hasNewLayout))
  }

  public yogaNodeSetIsReferenceBaseline(node: Pointer, isReferenceBaseline: boolean): void {
    this.opentui.symbols.yogaNodeSetIsReferenceBaseline(node, ffiBool(isReferenceBaseline))
  }

  public yogaNodeIsReferenceBaseline(node: Pointer): boolean {
    return this.opentui.symbols.yogaNodeIsReferenceBaseline(node)
  }

  public yogaNodeSetAlwaysFormsContainingBlock(node: Pointer, alwaysFormsContainingBlock: boolean): void {
    this.opentui.symbols.yogaNodeSetAlwaysFormsContainingBlock(node, ffiBool(alwaysFormsContainingBlock))
  }

  public yogaNodeGetAlwaysFormsContainingBlock(node: Pointer): boolean {
    return this.opentui.symbols.yogaNodeGetAlwaysFormsContainingBlock(node)
  }

  public yogaNodeGetComputedLayout(node: Pointer): NativeYogaLayout {
    const layout = this.yogaLayout
    this.opentui.symbols.yogaNodeGetComputedLayout(node, this.yogaLayout)
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
    return this.opentui.symbols.yogaNodeLayoutGetEdge(node, kind, edge)
  }

  public yogaNodeStyleSetEnum(node: Pointer, kind: number, value: number): void {
    this.opentui.symbols.yogaNodeStyleSetEnum(node, kind, value)
  }

  public yogaNodeStyleGetEnum(node: Pointer, kind: number): number {
    return this.opentui.symbols.yogaNodeStyleGetEnum(node, kind)
  }

  public yogaNodeStyleSetFloat(node: Pointer, kind: number, value: number): void {
    this.opentui.symbols.yogaNodeStyleSetFloat(node, kind, value)
  }

  public yogaNodeStyleGetFloat(node: Pointer, kind: number): number {
    return this.opentui.symbols.yogaNodeStyleGetFloat(node, kind)
  }

  public yogaNodeStyleSetBorder(node: Pointer, edge: number, border: number): void {
    this.opentui.symbols.yogaNodeStyleSetBorder(node, edge, border)
  }

  public yogaNodeStyleGetBorder(node: Pointer, edge: number): number {
    return this.opentui.symbols.yogaNodeStyleGetBorder(node, edge)
  }

  public yogaNodeStyleSetValue(node: Pointer, kind: number, edgeOrGutter: number, unit: number, value: number): void {
    this.opentui.symbols.yogaNodeStyleSetValue(node, kind, edgeOrGutter, unit, value)
  }

  public yogaNodeStyleGetValue(node: Pointer, kind: number, edgeOrGutter: number): number | bigint {
    return this.opentui.symbols.yogaNodeStyleGetValue(node, kind, edgeOrGutter)
  }

  public yogaNodeSetMeasureFunc(node: Pointer, enabled: boolean): void {
    this.opentui.symbols.yogaNodeSetMeasureFunc(node, ffiBool(enabled))
  }

  public yogaNodeUnsetMeasureFunc(node: Pointer): void {
    this.opentui.symbols.yogaNodeUnsetMeasureFunc(node)
  }

  public yogaNodeHasMeasureFunc(node: Pointer): boolean {
    // Node's FFI returns bools as 0/1 numbers; normalize so the interface stays truthful.
    return Boolean(this.opentui.symbols.yogaNodeHasMeasureFunc(node))
  }

  public yogaNodeSetDirtiedFunc(node: Pointer, enabled: boolean): void {
    this.opentui.symbols.yogaNodeSetDirtiedFunc(node, ffiBool(enabled))
  }

  public yogaNodeUnsetDirtiedFunc(node: Pointer): void {
    this.opentui.symbols.yogaNodeUnsetDirtiedFunc(node)
  }

  public yogaStoreMeasureResult(width: number, height: number): void {
    this.opentui.symbols.yogaStoreMeasureResult(width, height)
  }

  public yogaSetMeasureCallback(callback: Pointer | null): void {
    this.opentui.symbols.yogaSetMeasureCallback(callback)
  }

  public yogaSetDirtiedCallback(callback: Pointer | null): void {
    this.opentui.symbols.yogaSetDirtiedCallback(callback)
  }

  public createYogaMeasureCallback(callback: NativeYogaMeasureCallback): FFICallbackInstance {
    return this.opentui.createCallback(callback, {
      args: ["ptr", "f32", "u32", "f32", "u32"],
      returns: "void",
    })
  }

  public createYogaDirtiedCallback(callback: NativeYogaDirtiedCallback): FFICallbackInstance {
    return this.opentui.createCallback(callback, {
      args: ["ptr"],
      returns: "void",
    })
  }

  // TextBuffer methods
  public createTextBuffer(widthMethod: WidthMethod): TextBuffer {
    const bufferPtr = this.opentui.symbols.createTextBuffer(widthMethodCode(widthMethod))
    if (!bufferPtr) {
      throw new Error(`Failed to create TextBuffer`)
    }

    return new TextBuffer(this, bufferPtr)
  }

  public destroyTextBuffer(buffer: Pointer): void {
    this.opentui.symbols.destroyTextBuffer(buffer)
  }

  public textBufferGetLength(buffer: Pointer): number {
    return this.opentui.symbols.textBufferGetLength(buffer)
  }

  public textBufferGetByteSize(buffer: Pointer): number {
    return this.opentui.symbols.textBufferGetByteSize(buffer)
  }

  public textBufferReset(buffer: Pointer): void {
    this.opentui.symbols.textBufferReset(buffer)
  }

  public textBufferClear(buffer: Pointer): void {
    this.opentui.symbols.textBufferClear(buffer)
  }

  public textBufferSetDefaultFg(buffer: Pointer, fg: RGBA | null): void {
    const fgBuffer = optionalRgbaBuffer(fg)
    this.opentui.symbols.textBufferSetDefaultFg(buffer, fgBuffer)
  }

  public textBufferSetDefaultBg(buffer: Pointer, bg: RGBA | null): void {
    const bgBuffer = optionalRgbaBuffer(bg)
    this.opentui.symbols.textBufferSetDefaultBg(buffer, bgBuffer)
  }

  public textBufferSetDefaultAttributes(buffer: Pointer, attributes: number | null): void {
    const attrValue = attributes === null ? null : new Uint32Array([attributes])
    this.opentui.symbols.textBufferSetDefaultAttributes(buffer, attrValue)
  }

  public textBufferResetDefaults(buffer: Pointer): void {
    this.opentui.symbols.textBufferResetDefaults(buffer)
  }

  public textBufferGetTabWidth(buffer: Pointer): number {
    return this.opentui.symbols.textBufferGetTabWidth(buffer)
  }

  public textBufferSetTabWidth(buffer: Pointer, width: number): void {
    this.opentui.symbols.textBufferSetTabWidth(buffer, width)
  }

  public textBufferRegisterMemBuffer(buffer: Pointer, bytes: Uint8Array, owned: boolean = false): number {
    const result = this.opentui.symbols.textBufferRegisterMemBuffer(
      buffer,
      retainedPtrOrNull(bytes),
      bytes.byteLength,
      ffiBool(owned),
    )
    if (result === 0xffff) {
      throw new Error("Failed to register memory buffer")
    }
    return result
  }

  public textBufferReplaceMemBuffer(
    buffer: Pointer,
    memId: number,
    bytes: Uint8Array,
    owned: boolean = false,
  ): boolean {
    return this.opentui.symbols.textBufferReplaceMemBuffer(
      buffer,
      memId,
      retainedPtrOrNull(bytes),
      bytes.byteLength,
      ffiBool(owned),
    )
  }

  public textBufferClearMemRegistry(buffer: Pointer): void {
    this.opentui.symbols.textBufferClearMemRegistry(buffer)
  }

  public textBufferSetTextFromMem(buffer: Pointer, memId: number): void {
    this.opentui.symbols.textBufferSetTextFromMem(buffer, memId)
  }

  public textBufferAppend(buffer: Pointer, bytes: Uint8Array): void {
    this.opentui.symbols.textBufferAppend(buffer, retainedPtrOrNull(bytes), bytes.byteLength)
  }

  public textBufferAppendFromMemId(buffer: Pointer, memId: number): void {
    this.opentui.symbols.textBufferAppendFromMemId(buffer, memId)
  }

  public textBufferLoadFile(buffer: Pointer, path: string): boolean {
    const pathBytes = this.encoder.encode(path)
    return this.opentui.symbols.textBufferLoadFile(buffer, viewOrNull(pathBytes), pathBytes.byteLength)
  }

  public textBufferSetStyledText(
    buffer: Pointer,
    chunks: Array<{ text: string; fg?: RGBA | null; bg?: RGBA | null; attributes?: number; link?: { url: string } }>,
  ): void {
    if (chunks.length === 0) {
      this.textBufferClear(buffer)
      return
    }

    const chunksBuffer = StyledChunkStruct.packList(chunks)
    this.opentui.symbols.textBufferSetStyledText(buffer, chunksBuffer, chunks.length)
  }

  public textBufferGetLineCount(buffer: Pointer): number {
    return this.opentui.symbols.textBufferGetLineCount(buffer)
  }

  private textBufferGetPlainText(buffer: Pointer, outBuffer: Uint8Array | null, maxLen: number): number {
    return this.opentui.symbols.textBufferGetPlainText(buffer, outBuffer, maxLen)
  }

  public getPlainTextBytes(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.textBufferGetPlainText(buffer, viewOrNull(outBuffer), maxLength)

    if (actualLen === 0) {
      return null
    }

    return outBuffer.slice(0, actualLen)
  }

  public textBufferGetTextRange(
    buffer: Pointer,
    startOffset: number,
    endOffset: number,
    maxLength: number,
  ): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.opentui.symbols.textBufferGetTextRange(
      buffer,
      startOffset,
      endOffset,
      viewOrNull(outBuffer),
      maxLength,
    )

    const len = actualLen

    if (len === 0) {
      return null
    }

    return outBuffer.slice(0, len)
  }

  public textBufferGetTextRangeByCoords(
    buffer: Pointer,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    maxLength: number,
  ): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.opentui.symbols.textBufferGetTextRangeByCoords(
      buffer,
      startRow,
      startCol,
      endRow,
      endCol,
      viewOrNull(outBuffer),
      maxLength,
    )

    const len = actualLen

    if (len === 0) {
      return null
    }

    return usesBunFFI ? outBuffer.slice(0, len) : trimNodeFFIOutputBytes(outBuffer, len)
  }

  // TextBufferView methods
  public createTextBufferView(textBuffer: TextBufferHandle): TextBufferViewHandle {
    const viewPtr = this.opentui.symbols.createTextBufferView(textBuffer) as TextBufferViewHandle
    if (!viewPtr) {
      throw new Error("Failed to create TextBufferView")
    }
    return viewPtr
  }

  public destroyTextBufferView(view: Pointer): void {
    this.opentui.symbols.destroyTextBufferView(view)
  }

  public textBufferViewSetSelection(
    view: Pointer,
    start: number,
    end: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ): void {
    const bg = optionalRgbaBuffer(bgColor)
    const fg = optionalRgbaBuffer(fgColor)
    this.opentui.symbols.textBufferViewSetSelection(view, start, end, bg, fg)
  }

  public textBufferViewResetSelection(view: Pointer): void {
    this.opentui.symbols.textBufferViewResetSelection(view)
  }

  public textBufferViewGetSelection(view: Pointer): { start: number; end: number } | null {
    const packedInfo = this.textBufferViewGetSelectionInfo(view)

    // Check for no selection marker (0xFFFFFFFF_FFFFFFFF)
    if (packedInfo === 0xffff_ffff_ffff_ffffn) {
      return null
    }

    const start = Number(packedInfo >> 32n)
    const end = Number(packedInfo & 0xffff_ffffn)

    return { start, end }
  }

  private textBufferViewGetSelectionInfo(view: Pointer): bigint {
    return this.opentui.symbols.textBufferViewGetSelectionInfo(view)
  }

  public textBufferViewSetLocalSelection(
    view: Pointer,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
    behavior?: SelectionBehavior,
  ): boolean {
    const bg = optionalRgbaBuffer(bgColor)
    const fg = optionalRgbaBuffer(fgColor)
    return Boolean(
      this.opentui.symbols.textBufferViewSetLocalSelection(
        view,
        anchorX,
        anchorY,
        focusX,
        focusY,
        bg,
        fg,
        selectionBehaviorByte(behavior),
      ),
    )
  }

  public textBufferViewUpdateSelection(view: Pointer, end: number, bgColor: RGBA | null, fgColor: RGBA | null): void {
    const bg = optionalRgbaBuffer(bgColor)
    const fg = optionalRgbaBuffer(fgColor)
    this.opentui.symbols.textBufferViewUpdateSelection(view, end, bg, fg)
  }

  public textBufferViewUpdateLocalSelection(
    view: Pointer,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
    behavior?: SelectionBehavior,
  ): boolean {
    const bg = optionalRgbaBuffer(bgColor)
    const fg = optionalRgbaBuffer(fgColor)
    return Boolean(
      this.opentui.symbols.textBufferViewUpdateLocalSelection(
        view,
        anchorX,
        anchorY,
        focusX,
        focusY,
        bg,
        fg,
        selectionBehaviorByte(behavior),
      ),
    )
  }

  public textBufferViewResetLocalSelection(view: Pointer): void {
    this.opentui.symbols.textBufferViewResetLocalSelection(view)
  }

  public textBufferViewSetSelectionOccupancy(view: Pointer, occupancy: SelectionOccupancy): void {
    this.opentui.symbols.textBufferViewSetSelectionOccupancy(view, occupancy === "boundary" ? 1 : 0)
  }

  public textBufferViewGetSelectionOccupancy(view: Pointer): SelectionOccupancy {
    return this.opentui.symbols.textBufferViewGetSelectionOccupancy(view) === 1 ? "boundary" : "cell"
  }

  public textBufferViewSetWrapWidth(view: Pointer, width: number): void {
    this.opentui.symbols.textBufferViewSetWrapWidth(view, width)
  }

  public textBufferViewSetWrapMode(view: Pointer, mode: "none" | "char" | "word"): void {
    const modeValue = mode === "none" ? 0 : mode === "char" ? 1 : 2
    this.opentui.symbols.textBufferViewSetWrapMode(view, modeValue)
  }

  public textBufferViewSetWrapIndent(view: Pointer, indent: "none" | "same"): void {
    const indentValue = indent === "same" ? 1 : 0
    this.opentui.symbols.textBufferViewSetWrapIndent(view, indentValue)
  }

  public textBufferViewSetFirstLineOffset(view: Pointer, offset: number): void {
    this.opentui.symbols.textBufferViewSetFirstLineOffset(view, offset)
  }

  public textBufferViewSetViewportSize(view: Pointer, width: number, height: number): void {
    this.opentui.symbols.textBufferViewSetViewportSize(view, width, height)
  }

  public textBufferViewSetViewport(view: Pointer, x: number, y: number, width: number, height: number): void {
    this.opentui.symbols.textBufferViewSetViewport(view, x, y, width, height)
  }

  public textBufferViewGetLineInfo(view: Pointer): LineInfo {
    const outBuffer = new ArrayBuffer(LineInfoStruct.size)
    this.textBufferViewGetLineInfoDirect(view, outBuffer)
    const struct = LineInfoStruct.unpack(outBuffer)

    const lineStartCols = struct.startCols as number[]
    const lineWidthCols = struct.widthCols as number[]
    const lineWidthColsMax = struct.widthColsMax

    return {
      lineStartCols,
      lineWidthCols,
      lineWidthColsMax,
      lineSources: struct.sources as number[],
      lineWraps: struct.wraps as number[],
    }
  }

  public textBufferViewGetLogicalLineInfo(view: Pointer): LineInfo {
    const outBuffer = new ArrayBuffer(LineInfoStruct.size)
    this.textBufferViewGetLogicalLineInfoDirect(view, outBuffer)
    const struct = LineInfoStruct.unpack(outBuffer)

    const lineStartCols = struct.startCols as number[]
    const lineWidthCols = struct.widthCols as number[]
    const lineWidthColsMax = struct.widthColsMax

    return {
      lineStartCols,
      lineWidthCols,
      lineWidthColsMax,
      lineSources: struct.sources as number[],
      lineWraps: struct.wraps as number[],
    }
  }

  public textBufferViewGetVirtualLineCount(view: Pointer): number {
    return this.opentui.symbols.textBufferViewGetVirtualLineCount(view)
  }

  public textBufferViewGetLineSources(view: Pointer, startLine: number, lineCount: number): number[] {
    toSafeFFIU32Length(startLine, "visual row start")
    toSafeFFIU32Length(lineCount, "visual row count")
    if (lineCount === 0) return []

    const outBuffer = new ArrayBuffer(LineInfoStruct.size)
    this.textBufferViewGetLogicalLineInfoDirect(view, outBuffer)
    const data = new DataView(outBuffer)
    const sources = LineInfoStruct.arrayFields.get("sources")!
    const count = Math.max(0, Math.min(lineCount, data.getUint32(sources.lengthOffset, true) - startLine))
    if (count === 0) return []

    // The existing ABI returns borrowed native arrays. Copy the requested range synchronously,
    // before any mutation can invalidate those pointers; never move the live text viewport.
    return Array.from(
      new Uint32Array(toArrayBuffer(toPointer(data.getBigUint64(sources.arrayOffset, true)), startLine * 4, count * 4)),
    )
  }

  private textBufferViewGetLineInfoDirect(view: Pointer, outBuffer: ArrayBuffer): void {
    this.opentui.symbols.textBufferViewGetLineInfoDirect(view, outBuffer)
  }

  private textBufferViewGetLogicalLineInfoDirect(view: Pointer, outBuffer: ArrayBuffer): void {
    this.opentui.symbols.textBufferViewGetLogicalLineInfoDirect(view, outBuffer)
  }

  private textBufferViewGetSelectedText(view: Pointer, outBuffer: Uint8Array | null, maxLen: number): number {
    return this.opentui.symbols.textBufferViewGetSelectedText(view, outBuffer, maxLen)
  }

  private textBufferViewGetPlainText(view: Pointer, outBuffer: Uint8Array | null, maxLen: number): number {
    return this.opentui.symbols.textBufferViewGetPlainText(view, outBuffer, maxLen)
  }

  public textBufferViewGetSelectedTextBytes(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.textBufferViewGetSelectedText(view, viewOrNull(outBuffer), maxLength)

    if (actualLen === 0) {
      return null
    }

    return outBuffer.slice(0, actualLen)
  }

  public textBufferViewGetPlainTextBytes(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.textBufferViewGetPlainText(view, viewOrNull(outBuffer), maxLength)

    if (actualLen === 0) {
      return null
    }

    return outBuffer.slice(0, actualLen)
  }

  public textBufferViewSetTabIndicator(view: Pointer, indicator: number): void {
    this.opentui.symbols.textBufferViewSetTabIndicator(view, indicator)
  }

  public textBufferViewSetTabIndicatorColor(view: Pointer, color: RGBA): void {
    this.opentui.symbols.textBufferViewSetTabIndicatorColor(view, rgbaBuffer(color))
  }

  public textBufferViewSetTruncate(view: Pointer, truncate: boolean): void {
    this.opentui.symbols.textBufferViewSetTruncate(view, ffiBool(truncate))
  }

  public textBufferViewMeasureForDimensions(view: Pointer, width: number, height: number): MeasureResult | null {
    const storage = this.ffiStructStorage.measureResult
    const success = this.opentui.symbols.textBufferViewMeasureForDimensions(view, width, height, storage.ffiView)
    if (!success) return null
    const result = MeasureResultStruct.unpackInto(storage.view, storage.result)
    return { lineCount: result.lineCount, widthColsMax: result.widthColsMax }
  }

  public textBufferAddHighlightByCharRange(buffer: Pointer, highlight: Highlight): void {
    const packedHighlight = HighlightStruct.pack(highlight)
    this.opentui.symbols.textBufferAddHighlightByCharRange(buffer, packedHighlight)
  }

  public textBufferAddHighlight(buffer: Pointer, lineIdx: number, highlight: Highlight): void {
    const packedHighlight = HighlightStruct.pack(highlight)
    this.opentui.symbols.textBufferAddHighlight(buffer, lineIdx, packedHighlight)
  }

  public textBufferRemoveHighlightsByRef(buffer: Pointer, hlRef: number): void {
    this.opentui.symbols.textBufferRemoveHighlightsByRef(buffer, hlRef)
  }

  public textBufferClearLineHighlights(buffer: Pointer, lineIdx: number): void {
    this.opentui.symbols.textBufferClearLineHighlights(buffer, lineIdx)
  }

  public textBufferClearAllHighlights(buffer: Pointer): void {
    this.opentui.symbols.textBufferClearAllHighlights(buffer)
  }

  public textBufferSetSyntaxStyle(buffer: Pointer, style: Pointer | null): boolean {
    return this.opentui.symbols.textBufferSetSyntaxStyle(buffer, style ?? 0)
  }

  public textBufferGetLineHighlights(buffer: Pointer, lineIdx: number): Array<Highlight> {
    const outCountBuf = new Uint32Array(1)

    const nativePtr = this.opentui.symbols.textBufferGetLineHighlightsPtr(buffer, lineIdx, outCountBuf)
    if (!nativePtr) return []

    const count = outCountBuf[0]
    const byteLen = count * HighlightStruct.size
    const raw = toArrayBuffer(nativePtr, 0, byteLen)
    const results = HighlightStruct.unpackList(raw, count)

    this.opentui.symbols.textBufferFreeLineHighlights(nativePtr, count)

    return results
  }

  public textBufferGetHighlightCount(buffer: Pointer): number {
    return this.opentui.symbols.textBufferGetHighlightCount(buffer)
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

  public bufferDrawTextBufferView(buffer: Pointer, view: Pointer, x: number, y: number): void {
    this.opentui.symbols.bufferDrawTextBufferView(buffer, view, x, y)
  }

  public bufferDrawEditorView(buffer: Pointer, view: Pointer, x: number, y: number): void {
    this.opentui.symbols.bufferDrawEditorView(buffer, view, x, y)
  }

  // EditorView methods
  public createEditorView(
    editBufferPtr: EditBufferHandle,
    viewportWidth: number,
    viewportHeight: number,
  ): EditorViewHandle {
    const viewPtr = this.opentui.symbols.createEditorView(
      editBufferPtr,
      viewportWidth,
      viewportHeight,
    ) as EditorViewHandle
    if (!viewPtr) {
      throw new Error("Failed to create EditorView")
    }
    return viewPtr
  }

  public destroyEditorView(view: Pointer): void {
    this.opentui.symbols.destroyEditorView(view)
  }

  public editorViewSetViewportSize(view: Pointer, width: number, height: number): void {
    this.opentui.symbols.editorViewSetViewportSize(view, width, height)
  }

  public editorViewSetViewport(
    view: Pointer,
    x: number,
    y: number,
    width: number,
    height: number,
    moveCursor: boolean,
  ): void {
    this.opentui.symbols.editorViewSetViewport(view, x, y, width, height, ffiBool(moveCursor))
  }

  public editorViewGetViewport(view: Pointer): { offsetY: number; offsetX: number; height: number; width: number } {
    const x = new Uint32Array(1)
    const y = new Uint32Array(1)
    const width = new Uint32Array(1)
    const height = new Uint32Array(1)

    this.opentui.symbols.editorViewGetViewport(view, x, y, width, height)

    return {
      offsetX: x[0],
      offsetY: y[0],
      width: width[0],
      height: height[0],
    }
  }

  public editorViewSetScrollMargin(view: Pointer, margin: number): void {
    this.opentui.symbols.editorViewSetScrollMargin(view, margin)
  }

  public editorViewSetWrapMode(view: Pointer, mode: "none" | "char" | "word"): void {
    const modeValue = mode === "none" ? 0 : mode === "char" ? 1 : 2
    this.opentui.symbols.editorViewSetWrapMode(view, modeValue)
  }

  public editorViewSetWrapIndent(view: Pointer, indent: "none" | "same"): void {
    const indentValue = indent === "same" ? 1 : 0
    this.opentui.symbols.editorViewSetWrapIndent(view, indentValue)
  }

  public editorViewGetVirtualLineCount(view: Pointer): number {
    return this.opentui.symbols.editorViewGetVirtualLineCount(view)
  }

  public editorViewGetTotalVirtualLineCount(view: Pointer): number {
    return this.opentui.symbols.editorViewGetTotalVirtualLineCount(view)
  }

  public editorViewGetTextBufferView(view: EditorViewHandle): TextBufferViewHandle {
    const result = this.opentui.symbols.editorViewGetTextBufferView(view) as TextBufferViewHandle
    if (!result) {
      throw new Error("Failed to get TextBufferView from EditorView")
    }
    return result
  }

  public editorViewGetLineInfo(view: Pointer): LineInfo {
    const outBuffer = new ArrayBuffer(LineInfoStruct.size)
    this.opentui.symbols.editorViewGetLineInfoDirect(view, outBuffer)
    const struct = LineInfoStruct.unpack(outBuffer)

    const lineStartCols = struct.startCols as number[]
    const lineWidthCols = struct.widthCols as number[]
    const lineWidthColsMax = struct.widthColsMax

    return {
      lineStartCols,
      lineWidthCols,
      lineWidthColsMax,
      lineSources: struct.sources as number[],
      lineWraps: struct.wraps as number[],
    }
  }

  public editorViewGetLogicalLineInfo(view: Pointer): LineInfo {
    const outBuffer = new ArrayBuffer(LineInfoStruct.size)
    this.opentui.symbols.editorViewGetLogicalLineInfoDirect(view, outBuffer)
    const struct = LineInfoStruct.unpack(outBuffer)

    const lineStartCols = struct.startCols as number[]
    const lineWidthCols = struct.widthCols as number[]
    const lineWidthColsMax = struct.widthColsMax

    return {
      lineStartCols,
      lineWidthCols,
      lineWidthColsMax,
      lineSources: struct.sources as number[],
      lineWraps: struct.wraps as number[],
    }
  }

  // EditBuffer implementations
  public createEditBuffer(widthMethod: WidthMethod): EditBufferHandle {
    const bufferPtr = this.opentui.symbols.createEditBuffer(
      widthMethodCode(widthMethod),
      this.eventSinkPtr ?? 0,
    ) as EditBufferHandle
    if (!bufferPtr) {
      throw new Error("Failed to create EditBuffer")
    }
    return bufferPtr
  }

  public destroyEditBuffer(buffer: Pointer): void {
    this.opentui.symbols.destroyEditBuffer(buffer)
  }

  public editBufferSetText(buffer: Pointer, textBytes: Uint8Array): void {
    this.opentui.symbols.editBufferSetText(buffer, viewOrNull(textBytes), textBytes.byteLength)
  }

  public editBufferSetTextFromMem(buffer: Pointer, memId: number): void {
    this.opentui.symbols.editBufferSetTextFromMem(buffer, memId)
  }

  public editBufferReplaceText(buffer: Pointer, textBytes: Uint8Array): void {
    this.opentui.symbols.editBufferReplaceText(buffer, viewOrNull(textBytes), textBytes.byteLength)
  }

  public editBufferReplaceTextFromMem(buffer: Pointer, memId: number): void {
    this.opentui.symbols.editBufferReplaceTextFromMem(buffer, memId)
  }

  public editBufferGetText(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editBufferGetText(buffer, viewOrNull(outBuffer), maxLength)
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editBufferInsertChar(buffer: Pointer, char: string): void {
    const charBytes = this.encoder.encode(char)
    this.opentui.symbols.editBufferInsertChar(buffer, viewOrNull(charBytes), charBytes.byteLength)
  }

  public editBufferInsertText(buffer: Pointer, text: string): void {
    const textBytes = this.encoder.encode(text)
    this.opentui.symbols.editBufferInsertText(buffer, viewOrNull(textBytes), textBytes.byteLength)
  }

  public editBufferDeleteChar(buffer: Pointer): void {
    this.opentui.symbols.editBufferDeleteChar(buffer)
  }

  public editBufferDeleteCharBackward(buffer: Pointer): void {
    this.opentui.symbols.editBufferDeleteCharBackward(buffer)
  }

  public editBufferDeleteRange(
    buffer: Pointer,
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
  ): void {
    this.opentui.symbols.editBufferDeleteRange(buffer, startLine, startCol, endLine, endCol)
  }

  public editBufferNewLine(buffer: Pointer): void {
    this.opentui.symbols.editBufferNewLine(buffer)
  }

  public editBufferDeleteLine(buffer: Pointer): void {
    this.opentui.symbols.editBufferDeleteLine(buffer)
  }

  public editBufferMoveCursorLeft(buffer: Pointer): void {
    this.opentui.symbols.editBufferMoveCursorLeft(buffer)
  }

  public editBufferMoveCursorRight(buffer: Pointer): void {
    this.opentui.symbols.editBufferMoveCursorRight(buffer)
  }

  public editBufferMoveCursorUp(buffer: Pointer): void {
    this.opentui.symbols.editBufferMoveCursorUp(buffer)
  }

  public editBufferMoveCursorDown(buffer: Pointer): void {
    this.opentui.symbols.editBufferMoveCursorDown(buffer)
  }

  public editBufferGotoLine(buffer: Pointer, line: number): void {
    this.opentui.symbols.editBufferGotoLine(buffer, line)
  }

  public editBufferSetCursor(buffer: Pointer, line: number, byteOffset: number): void {
    this.opentui.symbols.editBufferSetCursor(buffer, line, byteOffset)
  }

  public editBufferSetCursorToLineCol(buffer: Pointer, line: number, col: number): void {
    this.opentui.symbols.editBufferSetCursorToLineCol(buffer, line, col)
  }

  public editBufferSetCursorByOffset(buffer: Pointer, offset: number): void {
    this.opentui.symbols.editBufferSetCursorByOffset(buffer, offset)
  }

  public editBufferGetCursorPosition(buffer: Pointer): LogicalCursor {
    const storage = this.ffiStructStorage.logicalCursor
    this.opentui.symbols.editBufferGetCursorPosition(buffer, storage.ffiView)
    const cursor = LogicalCursorStruct.unpackInto(storage.view, storage.result)
    return { row: cursor.row, col: cursor.col, offset: cursor.offset }
  }

  public editBufferGetId(buffer: Pointer): number {
    return this.opentui.symbols.editBufferGetId(buffer)
  }

  public editBufferGetTextBuffer(buffer: EditBufferHandle): TextBufferHandle {
    const result = this.opentui.symbols.editBufferGetTextBuffer(buffer) as TextBufferHandle
    if (!result) {
      throw new Error("Failed to get TextBuffer from EditBuffer")
    }
    return result
  }

  public editBufferSetTabWidth(buffer: Pointer, width: number): void {
    this.opentui.symbols.editBufferSetTabWidth(buffer, width)
  }

  public editBufferDebugLogRope(buffer: Pointer): void {
    this.opentui.symbols.editBufferDebugLogRope(buffer)
  }

  public editBufferUndo(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editBufferUndo(buffer, viewOrNull(outBuffer), maxLength)
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editBufferRedo(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editBufferRedo(buffer, viewOrNull(outBuffer), maxLength)
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editBufferCanUndo(buffer: Pointer): boolean {
    return Boolean(this.opentui.symbols.editBufferCanUndo(buffer))
  }

  public editBufferCanRedo(buffer: Pointer): boolean {
    return Boolean(this.opentui.symbols.editBufferCanRedo(buffer))
  }

  public editBufferClearHistory(buffer: Pointer): void {
    this.opentui.symbols.editBufferClearHistory(buffer)
  }

  public editBufferClear(buffer: Pointer): void {
    this.opentui.symbols.editBufferClear(buffer)
  }

  public editBufferGetNextWordBoundary(buffer: Pointer): LogicalCursor {
    const storage = this.ffiStructStorage.logicalCursor
    this.opentui.symbols.editBufferGetNextWordBoundary(buffer, storage.ffiView)
    const cursor = LogicalCursorStruct.unpackInto(storage.view, storage.result)
    return { row: cursor.row, col: cursor.col, offset: cursor.offset }
  }

  public editBufferGetPrevWordBoundary(buffer: Pointer): LogicalCursor {
    const storage = this.ffiStructStorage.logicalCursor
    this.opentui.symbols.editBufferGetPrevWordBoundary(buffer, storage.ffiView)
    const cursor = LogicalCursorStruct.unpackInto(storage.view, storage.result)
    return { row: cursor.row, col: cursor.col, offset: cursor.offset }
  }

  public editBufferGetEOL(buffer: Pointer): LogicalCursor {
    const storage = this.ffiStructStorage.logicalCursor
    this.opentui.symbols.editBufferGetEOL(buffer, storage.ffiView)
    const cursor = LogicalCursorStruct.unpackInto(storage.view, storage.result)
    return { row: cursor.row, col: cursor.col, offset: cursor.offset }
  }

  public editBufferOffsetToPosition(buffer: Pointer, offset: number): LogicalCursor | null {
    const storage = this.ffiStructStorage.logicalCursor
    const success = this.opentui.symbols.editBufferOffsetToPosition(buffer, offset, storage.ffiView)
    if (!success) return null
    const cursor = LogicalCursorStruct.unpackInto(storage.view, storage.result)
    return { row: cursor.row, col: cursor.col, offset: cursor.offset }
  }

  public editBufferPositionToOffset(buffer: Pointer, row: number, col: number): number {
    return this.opentui.symbols.editBufferPositionToOffset(buffer, row, col)
  }

  public editBufferGetLineStartOffset(buffer: Pointer, row: number): number {
    return this.opentui.symbols.editBufferGetLineStartOffset(buffer, row)
  }

  public editBufferGetTextRange(
    buffer: Pointer,
    startOffset: number,
    endOffset: number,
    maxLength: number,
  ): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editBufferGetTextRange(
      buffer,
      startOffset,
      endOffset,
      viewOrNull(outBuffer),
      maxLength,
    )
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editBufferGetTextRangeByCoords(
    buffer: Pointer,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    maxLength: number,
  ): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editBufferGetTextRangeByCoords(
      buffer,
      startRow,
      startCol,
      endRow,
      endCol,
      viewOrNull(outBuffer),
      maxLength,
    )
    const len = actualLen
    if (len === 0) return null
    return usesBunFFI ? outBuffer.slice(0, len) : trimNodeFFIOutputBytes(outBuffer, len)
  }

  // EditorView selection and editing implementations
  public editorViewSetSelection(
    view: Pointer,
    start: number,
    end: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ): void {
    const bg = optionalRgbaBuffer(bgColor)
    const fg = optionalRgbaBuffer(fgColor)
    this.opentui.symbols.editorViewSetSelection(view, start, end, bg, fg)
  }

  public editorViewResetSelection(view: Pointer): void {
    this.opentui.symbols.editorViewResetSelection(view)
  }

  public editorViewGetSelection(view: Pointer): { start: number; end: number } | null {
    const packedInfo = this.opentui.symbols.editorViewGetSelection(view)
    if (packedInfo === 0xffff_ffff_ffff_ffffn) {
      return null
    }
    const start = Number(packedInfo >> 32n)
    const end = Number(packedInfo & 0xffff_ffffn)
    return { start, end }
  }

  public editorViewSetLocalSelection(
    view: Pointer,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
    updateCursor: boolean,
    followCursor: boolean,
    behavior?: SelectionBehavior,
  ): boolean {
    const bg = optionalRgbaBuffer(bgColor)
    const fg = optionalRgbaBuffer(fgColor)
    return Boolean(
      this.opentui.symbols.editorViewSetLocalSelection(
        view,
        anchorX,
        anchorY,
        focusX,
        focusY,
        bg,
        fg,
        editorLocalSelectionFlags(updateCursor, followCursor, behavior),
      ),
    )
  }

  public editorViewUpdateSelection(view: Pointer, end: number, bgColor: RGBA | null, fgColor: RGBA | null): void {
    const bg = optionalRgbaBuffer(bgColor)
    const fg = optionalRgbaBuffer(fgColor)
    this.opentui.symbols.editorViewUpdateSelection(view, end, bg, fg)
  }

  public editorViewUpdateLocalSelection(
    view: Pointer,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
    updateCursor: boolean,
    followCursor: boolean,
    behavior?: SelectionBehavior,
  ): boolean {
    const bg = optionalRgbaBuffer(bgColor)
    const fg = optionalRgbaBuffer(fgColor)
    return Boolean(
      this.opentui.symbols.editorViewUpdateLocalSelection(
        view,
        anchorX,
        anchorY,
        focusX,
        focusY,
        bg,
        fg,
        editorLocalSelectionFlags(updateCursor, followCursor, behavior),
      ),
    )
  }

  public editorViewResetLocalSelection(view: Pointer): void {
    this.opentui.symbols.editorViewResetLocalSelection(view)
  }

  public editorViewConvertSelectionToCell(view: Pointer): boolean {
    return Boolean(this.opentui.symbols.editorViewConvertSelectionToCell(view))
  }

  public editorViewSetSelectionOccupancy(view: Pointer, occupancy: SelectionOccupancy): void {
    this.opentui.symbols.editorViewSetSelectionOccupancy(view, occupancy === "boundary" ? 1 : 0)
  }

  public editorViewSetSelectionInclusive(
    view: Pointer,
    start: number,
    end: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ): void {
    const bg = optionalRgbaBuffer(bgColor)
    const fg = optionalRgbaBuffer(fgColor)
    this.opentui.symbols.editorViewSetSelectionInclusive(view, start, end, bg, fg)
  }

  public editorViewSetSelectionColors(view: Pointer, bgColor: RGBA | null, fgColor: RGBA | null): void {
    const bg = optionalRgbaBuffer(bgColor)
    const fg = optionalRgbaBuffer(fgColor)
    this.opentui.symbols.editorViewSetSelectionColors(view, bg, fg)
  }

  public editorViewGetSelectedTextBytes(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editorViewGetSelectedTextBytes(view, viewOrNull(outBuffer), maxLength)
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editorViewGetCursor(view: Pointer): { row: number; col: number } {
    const row = new Uint32Array(1)
    const col = new Uint32Array(1)
    this.opentui.symbols.editorViewGetCursor(view, row, col)
    return { row: row[0], col: col[0] }
  }

  public editorViewGetText(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editorViewGetText(view, viewOrNull(outBuffer), maxLength)
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editorViewGetVisualCursor(view: Pointer): VisualCursor {
    const storage = this.ffiStructStorage.visualCursor
    this.opentui.symbols.editorViewGetVisualCursor(view, storage.ffiView)
    const cursor = VisualCursorStruct.unpackInto(storage.view, storage.result)
    return { ...cursor }
  }

  public editorViewMoveUpVisual(view: Pointer): void {
    this.opentui.symbols.editorViewMoveUpVisual(view)
  }

  public editorViewMoveDownVisual(view: Pointer): void {
    this.opentui.symbols.editorViewMoveDownVisual(view)
  }

  public editorViewDeleteSelectedText(view: Pointer): void {
    this.opentui.symbols.editorViewDeleteSelectedText(view)
  }

  public editorViewSetCursorByOffset(view: Pointer, offset: number): void {
    this.opentui.symbols.editorViewSetCursorByOffset(view, offset)
  }

  public editorViewGetNextWordBoundary(view: Pointer): VisualCursor {
    const storage = this.ffiStructStorage.visualCursor
    this.opentui.symbols.editorViewGetNextWordBoundary(view, storage.ffiView)
    const cursor = VisualCursorStruct.unpackInto(storage.view, storage.result)
    return { ...cursor }
  }

  public editorViewGetPrevWordBoundary(view: Pointer): VisualCursor {
    const storage = this.ffiStructStorage.visualCursor
    this.opentui.symbols.editorViewGetPrevWordBoundary(view, storage.ffiView)
    const cursor = VisualCursorStruct.unpackInto(storage.view, storage.result)
    return { ...cursor }
  }

  public editorViewGetEOL(view: Pointer): VisualCursor {
    const storage = this.ffiStructStorage.visualCursor
    this.opentui.symbols.editorViewGetEOL(view, storage.ffiView)
    const cursor = VisualCursorStruct.unpackInto(storage.view, storage.result)
    return { ...cursor }
  }

  public editorViewGetVisualSOL(view: Pointer): VisualCursor {
    const storage = this.ffiStructStorage.visualCursor
    this.opentui.symbols.editorViewGetVisualSOL(view, storage.ffiView)
    const cursor = VisualCursorStruct.unpackInto(storage.view, storage.result)
    return { ...cursor }
  }

  public editorViewGetVisualEOL(view: Pointer): VisualCursor {
    const storage = this.ffiStructStorage.visualCursor
    this.opentui.symbols.editorViewGetVisualEOL(view, storage.ffiView)
    const cursor = VisualCursorStruct.unpackInto(storage.view, storage.result)
    return { ...cursor }
  }

  public editorViewGotoVisualLineEnd(view: Pointer): void {
    this.opentui.symbols.editorViewGotoVisualLineEnd(view)
  }

  public bufferPushScissorRect(buffer: Pointer, x: number, y: number, width: number, height: number): void {
    this.opentui.symbols.bufferPushScissorRect(buffer, x, y, width, height)
  }

  public bufferPopScissorRect(buffer: Pointer): void {
    this.opentui.symbols.bufferPopScissorRect(buffer)
  }

  public bufferClearScissorRects(buffer: Pointer): void {
    this.opentui.symbols.bufferClearScissorRects(buffer)
  }

  public bufferPushOpacity(buffer: Pointer, opacity: number): void {
    this.opentui.symbols.bufferPushOpacity(buffer, opacity)
  }

  public bufferPopOpacity(buffer: Pointer): void {
    this.opentui.symbols.bufferPopOpacity(buffer)
  }

  public bufferGetCurrentOpacity(buffer: Pointer): number {
    return this.opentui.symbols.bufferGetCurrentOpacity(buffer)
  }

  public bufferClearOpacity(buffer: Pointer): void {
    this.opentui.symbols.bufferClearOpacity(buffer)
  }

  public getTerminalCapabilities(renderer: Pointer): TerminalCapabilities {
    const capsBuffer = new ArrayBuffer(TerminalCapabilitiesStruct.size)
    this.opentui.symbols.getTerminalCapabilities(renderer, capsBuffer)

    const caps = TerminalCapabilitiesStruct.unpack(capsBuffer)

    return {
      kitty_keyboard: caps.kitty_keyboard,
      kitty_graphics: caps.kitty_graphics,
      rgb: caps.rgb,
      ansi256: caps.ansi256,
      unicode: caps.unicode,
      sgr_pixels: caps.sgr_pixels,
      color_scheme_updates: caps.color_scheme_updates,
      explicit_width: caps.explicit_width,
      scaled_text: caps.scaled_text,
      sixel: caps.sixel,
      focus_tracking: caps.focus_tracking,
      sync: caps.sync,
      bracketed_paste: caps.bracketed_paste,
      hyperlinks: caps.hyperlinks,
      osc52: caps.osc52,
      osc52_support: caps.osc52_support,
      notifications: caps.notifications,
      explicit_cursor_positioning: caps.explicit_cursor_positioning,
      remote: caps.remote,
      multiplexer: caps.multiplexer,
      image_protocol: caps.image_protocol,
      terminal: {
        name: caps.term_name ?? "",
        version: caps.term_version ?? "",
        from_xtversion: caps.term_from_xtversion,
      },
    }
  }

  public processCapabilityResponse(renderer: Pointer, response: string): void {
    const responseBytes = this.encoder.encode(response)
    this.opentui.symbols.processCapabilityResponse(renderer, viewOrNull(responseBytes), responseBytes.byteLength)
  }

  public setKittyImageTransport(renderer: RendererHandle, mode: number): boolean {
    return this.opentui.symbols.setKittyImageTransport(renderer, mode) !== 0
  }

  public getKittyImageTransport(renderer: RendererHandle): Uint32Array {
    const status = new Uint32Array(6)
    this.opentui.symbols.getKittyImageTransport(renderer, status)
    return status
  }

  public pollKittyImageTransport(renderer: RendererHandle): boolean {
    return this.opentui.symbols.pollKittyImageTransport(renderer) !== 0
  }

  public cancelKittyImageTransport(renderer: RendererHandle, failed: boolean): void {
    this.opentui.symbols.cancelKittyImageTransport(renderer, failed ? 1 : 0)
  }

  public processKittyImageReply(renderer: RendererHandle, response: string): number {
    const bytes = this.encoder.encode(response)
    return this.opentui.symbols.processKittyImageReply(renderer, bytes, bytes.byteLength)
  }

  public encodeUnicode(
    text: string,
    widthMethod: WidthMethod,
  ): { ptr: Pointer; data: Array<{ width: number; char: number }> } | null {
    const textBytes = this.encoder.encode(text)

    const outPtrBuffer = new ArrayBuffer(8) // Pointer-sized out slot
    const outLenBuffer = new ArrayBuffer(8) // Native length out slot

    const success = this.opentui.symbols.encodeUnicode(
      viewOrNull(textBytes),
      textBytes.byteLength,
      outPtrBuffer,
      outLenBuffer,
      widthMethodCode(widthMethod),
    )

    if (!success) {
      return null
    }

    const outPtrView = new BigUint64Array(outPtrBuffer)
    const outLenView = new BigUint64Array(outLenBuffer)

    const resultLen = Number(outLenView[0])

    if (resultLen === 0) {
      return { ptr: 0 as Pointer, data: [] }
    }

    const resultPtr = toPointer(outPtrView[0])

    // Convert pointer to ArrayBuffer and use EncodedCharStruct to unpack the list
    const byteLen = resultLen * EncodedCharStruct.size
    const raw = toArrayBuffer(resultPtr, 0, byteLen)
    const data = EncodedCharStruct.unpackList(raw, resultLen)

    return { ptr: resultPtr, data }
  }

  public freeUnicode(encoded: { ptr: Pointer; data: Array<{ width: number; char: number }> }): void {
    this.opentui.symbols.freeUnicode(encoded.ptr, encoded.data.length)
  }

  public bufferDrawChar(
    buffer: Pointer,
    char: number,
    x: number,
    y: number,
    fg: RGBA,
    bg: RGBA,
    attributes: number = 0,
  ): void {
    this.opentui.symbols.bufferDrawChar(buffer, char, x, y, rgbaBuffer(fg), rgbaBuffer(bg), attributes)
  }

  public createAudioEngine(options?: AudioCreateOptions | null): AudioEngineHandle | null {
    const optionsBuffer = options == null ? null : AudioCreateOptionsStruct.pack(options)
    const engineHandle = this.opentui.symbols.createAudioEngine(optionsBuffer) as AudioEngineHandle
    return engineHandle ? engineHandle : null
  }

  public destroyAudioEngine(engine: AudioEngineHandle): void {
    this.opentui.symbols.destroyAudioEngine(engine)
  }

  public audioRefreshPlaybackDevices(engine: Pointer): number {
    return this.opentui.symbols.audioRefreshPlaybackDevices(engine)
  }

  public audioGetPlaybackDeviceCount(engine: Pointer): number {
    return this.opentui.symbols.audioGetPlaybackDeviceCount(engine)
  }

  public audioGetPlaybackDeviceName(engine: Pointer, index: number): string {
    const outBuffer = new Uint8Array(512)
    const bytesWritten = toNumber(
      this.opentui.symbols.audioGetPlaybackDeviceName(engine, index, outBuffer, outBuffer.length),
    )
    const safeBytesWritten = Math.max(0, Math.min(outBuffer.length, bytesWritten))
    return this.decoder.decode(outBuffer.subarray(0, safeBytesWritten))
  }

  public audioIsPlaybackDeviceDefault(engine: Pointer, index: number): boolean {
    return this.opentui.symbols.audioIsPlaybackDeviceDefault(engine, index)
  }

  public audioSelectPlaybackDevice(engine: Pointer, index: number): number {
    return this.opentui.symbols.audioSelectPlaybackDevice(engine, index)
  }

  public audioClearPlaybackDeviceSelection(engine: Pointer): void {
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

  public audioStart(engine: Pointer, options?: AudioStartOptions | null): number {
    let optionsBuffer: ArrayBuffer | null
    try {
      optionsBuffer = options == null ? null : AudioStartOptionsStruct.pack(options)
    } catch {
      return -1
    }
    return this.opentui.symbols.audioStart(engine, optionsBuffer)
  }

  public audioStartMixer(engine: Pointer): number {
    return this.opentui.symbols.audioStartMixer(engine)
  }

  public audioStop(engine: Pointer): number {
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
    const status = this.opentui.symbols.audioGetStreamStats(engine, streamId, storage.ffiView)
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
    const status = this.opentui.symbols.audioCloseStream(engine, streamId, reason, storage.ffiView)
    if (status !== 0) return { status, stats: null }
    const stats = AudioStreamStatsStruct.unpackInto(storage.view, storage.result) as NativeAudioStreamStats
    return { status, stats: { ...stats } }
  }

  public audioLoad(engine: Pointer, data: Uint8Array): { status: number; soundId: number | null } {
    const outBuffer = new ArrayBuffer(4)
    const dataLength = toSafeFFIU32Length(data.byteLength, "Audio data length")
    const status = this.opentui.symbols.audioLoad(engine, data, dataLength, outBuffer)
    if (status !== 0) {
      return { status, soundId: null }
    }
    const view = new Uint32Array(outBuffer)
    return { status, soundId: view[0] }
  }

  public audioUnload(engine: Pointer, soundId: number): number {
    return this.opentui.symbols.audioUnload(engine, soundId)
  }

  public audioPlay(
    engine: Pointer,
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

  public audioStopVoice(engine: Pointer, voiceId: number): number {
    return this.opentui.symbols.audioStopVoice(engine, voiceId)
  }

  public audioSetVoiceGroup(engine: Pointer, voiceId: number, groupId: number): number {
    if (!isFFIU32(groupId)) return -1
    return this.opentui.symbols.audioSetVoiceGroup(engine, voiceId, groupId)
  }

  public audioCreateGroup(engine: Pointer, name: string): { status: number; groupId: number | null } {
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

  public audioSetGroupVolume(engine: Pointer, groupId: number, volume: number): number {
    return this.opentui.symbols.audioSetGroupVolume(engine, groupId, volume)
  }

  public audioSetMasterVolume(engine: Pointer, volume: number): number {
    return this.opentui.symbols.audioSetMasterVolume(engine, volume)
  }

  public audioMixToBuffer(engine: Pointer, outBuffer: Float32Array, frameCount: number, channels: number): number {
    return this.opentui.symbols.audioMixToBuffer(engine, outBuffer, frameCount, channels)
  }

  public audioEnableTap(engine: Pointer, enabled: boolean, capacityFrames: number): number {
    return this.opentui.symbols.audioEnableTap(engine, ffiBool(enabled), capacityFrames)
  }

  public audioReadTap(
    engine: Pointer,
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

  public audioGetStats(engine: Pointer): AudioStats | null {
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

  public destroyNativeSpanFeed(stream: Pointer): void {
    this.opentui.symbols.destroyNativeSpanFeed(stream)
    this.nativeSpanFeedHandlers.delete(stream)
  }

  public streamWrite(stream: Pointer, data: Uint8Array | string): number {
    const bytes = typeof data === "string" ? this.encoder.encode(data) : data
    return this.opentui.symbols.streamWrite(stream, viewOrNull(bytes), bytes.byteLength)
  }

  public streamCommit(stream: Pointer): number {
    return this.opentui.symbols.streamCommit(stream)
  }

  public streamDrainSpans(stream: Pointer, outBuffer: Uint8Array, maxSpans: number): number {
    const count = this.opentui.symbols.streamDrainSpans(stream, outBuffer, maxSpans)
    return toNumber(count)
  }

  public streamClose(stream: Pointer): number {
    return this.opentui.symbols.streamClose(stream)
  }

  public streamSetOptions(stream: Pointer, options: NativeSpanFeedOptions): number {
    const optionsBuffer = NativeSpanFeedOptionsStruct.pack(options)
    return this.opentui.symbols.streamSetOptions(stream, optionsBuffer)
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

  public createSyntaxStyle(): SyntaxStyleHandle {
    const styleHandle = this.opentui.symbols.createSyntaxStyle() as SyntaxStyleHandle
    if (!styleHandle) {
      throw new Error("Failed to create SyntaxStyle")
    }
    return styleHandle
  }

  public destroySyntaxStyle(style: SyntaxStyleHandle): void {
    this.opentui.symbols.destroySyntaxStyle(style)
  }

  public syntaxStyleRegister(
    style: SyntaxStyleHandle,
    name: string,
    fg: RGBA | null,
    bg: RGBA | null,
    attributes: number,
  ): number {
    const nameBytes = this.encoder.encode(name)
    const fgBuffer = optionalRgbaBuffer(fg)
    const bgBuffer = optionalRgbaBuffer(bg)
    return this.opentui.symbols.syntaxStyleRegister(
      style,
      viewOrNull(nameBytes),
      nameBytes.byteLength,
      fgBuffer,
      bgBuffer,
      attributes,
    )
  }

  public syntaxStyleResolveByName(style: SyntaxStyleHandle, name: string): number | null {
    const nameBytes = this.encoder.encode(name)
    const id = this.opentui.symbols.syntaxStyleResolveByName(style, viewOrNull(nameBytes), nameBytes.byteLength)
    return id === 0 ? null : id
  }

  public syntaxStyleGetStyleCount(style: SyntaxStyleHandle): number {
    return this.opentui.symbols.syntaxStyleGetStyleCount(style)
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
      pixels,
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

  // Internal pool owners only, not a general image mutation API. Publish with a fresh retained handle.
  public imageUpdatePixels(
    image: ImageHandle,
    pixels: Uint8Array,
    stride: number,
    format: number,
    alpha: number,
  ): number {
    return this.opentui.symbols.imageUpdatePixels(image, pixels, BigInt(pixels.byteLength), stride, format, alpha)
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

  public imageTestFailIccProfileCopyAllocationOnce(): void {
    this.opentui.symbols.imageTestFailIccProfileCopyAllocationOnce()
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

  public editorViewSetPlaceholderStyledText(
    view: EditorViewHandle,
    chunks: Array<{ text: string; fg?: RGBA | null; bg?: RGBA | null; attributes?: number }>,
  ): void {
    const nonEmptyChunks = chunks.filter((c) => c.text.length > 0)
    if (nonEmptyChunks.length === 0) {
      this.opentui.symbols.editorViewSetPlaceholderStyledText(view, null, 0)
      return
    }

    const chunksBuffer = StyledChunkStruct.packList(nonEmptyChunks)
    this.opentui.symbols.editorViewSetPlaceholderStyledText(view, chunksBuffer, nonEmptyChunks.length)
  }

  public editorViewSetTabIndicator(view: EditorViewHandle, indicator: number): void {
    this.opentui.symbols.editorViewSetTabIndicator(view, indicator)
  }

  public editorViewSetTabIndicatorColor(view: EditorViewHandle, color: RGBA): void {
    this.opentui.symbols.editorViewSetTabIndicatorColor(view, rgbaBuffer(color))
  }

  public onNativeEvent(name: string, handler: (data: ArrayBuffer) => void): void {
    this._nativeEvents.on(name, handler)
  }

  public onceNativeEvent(name: string, handler: (data: ArrayBuffer) => void): void {
    this._nativeEvents.once(name, handler)
  }

  public offNativeEvent(name: string, handler: (data: ArrayBuffer) => void): void {
    this._nativeEvents.off(name, handler)
  }

  public onAnyNativeEvent(handler: (name: string, data: ArrayBuffer) => void): void {
    this._anyEventHandlers.push(handler)
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
