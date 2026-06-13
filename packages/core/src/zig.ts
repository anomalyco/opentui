import {
  dlopen,
  ffiBool,
  toArrayBuffer,
  ptr,
  toPointer,
  type FFICallbackInstance,
  type Pointer,
} from "./platform/ffi.js"
import { writeFile } from "./platform/runtime.js"
import { existsSync, writeFileSync } from "fs"
import { EventEmitter } from "events"
import {
  type CursorStyle,
  type CursorStyleOptions,
  type TargetChannel,
  type DebugOverlayCorner,
  type WidthMethod,
  type TerminalCapabilities,
  type Highlight,
  type LineInfo,
  type MousePointerStyle,
} from "./types.js"
export type { LineInfo, AllocatorStats, BuildOptions, NativeRenderStats }

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
  CursorStyleOptionsStruct,
  GridDrawOptionsStruct,
  NativeSpanFeedOptionsStruct,
  NativeSpanFeedStatsStruct,
  ReserveInfoStruct,
  AudioCreateOptionsStruct,
  AudioStartOptionsStruct,
  AudioVoiceOptionsStruct,
  AudioStatsStruct,
  BuildOptionsStruct,
  AllocatorStatsStruct,
  NativeRenderStatsStruct,
} from "./zig-structs.js"
import type {
  NativeSpanFeedOptions,
  NativeSpanFeedStats,
  ReserveInfo,
  AudioCreateOptions,
  AudioStartOptions,
  AudioVoiceOptions,
  AudioStats,
  BuildOptions,
  AllocatorStats,
  NativeRenderStats,
} from "./zig-structs.js"
import { isBunfsPath } from "./lib/bunfs.js"

registerEnvVar({
  name: "OPENTUI_LIBC",
  description: "Select Linux native libc package. Supported values: glibc, musl.",
  type: "string",
  default: "",
})

function validateLinuxLibcOverride(): void {
  const libc = process.env.OPENTUI_LIBC
  if (libc === undefined || libc === "" || libc === "glibc" || libc === "musl") return
  throw new Error(`On Linux, OPENTUI_LIBC must be unset, empty, "glibc", or "musl", got "${libc}"`)
}

async function resolveNativePackage() {
  if (process.platform === "darwin") {
    // @ts-ignore Optional native package may be absent when building on another platform.
    if (process.arch === "x64") return await import("@opentui/core-darwin-x64")
    // @ts-ignore Optional native package may be absent when building on another platform.
    if (process.arch === "arm64") return await import("@opentui/core-darwin-arm64")
  }

  if (process.platform === "linux") {
    validateLinuxLibcOverride()

    if (process.arch === "x64") {
      if (process.env.OPENTUI_LIBC === "musl") {
        // @ts-ignore Optional native package may be absent unless building a musl target.
        return await import("@opentui/core-linux-x64-musl")
      } else {
        // @ts-ignore Optional native package may be absent when building on another platform.
        return await import("@opentui/core-linux-x64")
      }
    }

    if (process.arch === "arm64") {
      if (process.env.OPENTUI_LIBC === "musl") {
        // @ts-ignore Optional native package may be absent unless building a musl target.
        return await import("@opentui/core-linux-arm64-musl")
      } else {
        // @ts-ignore Optional native package may be absent when building on another platform.
        return await import("@opentui/core-linux-arm64")
      }
    }
  }

  if (process.platform === "win32") {
    // @ts-ignore Optional native package may be absent when building on another platform.
    if (process.arch === "x64") return await import("@opentui/core-win32-x64")
    // @ts-ignore Optional native package may be absent when building on another platform.
    if (process.arch === "arm64") return await import("@opentui/core-win32-arm64")
  }

  throw new Error(`opentui is not supported on the current platform: ${process.platform}-${process.arch}`)
}
const nativePackage = await resolveNativePackage()

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
let targetLibPath = nativePackage.default

if (isBunfsPath(targetLibPath)) {
  targetLibPath = targetLibPath.replace("../", "")
}

if (!existsSync(targetLibPath)) {
  throw new Error(`opentui is not supported on the current platform: ${process.platform}-${process.arch}`)
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
  description: "Use wcwidth for character width calculations",
  type: "boolean",
  default: false,
})
registerEnvVar({
  name: "OPENTUI_FORCE_UNICODE",
  description: "Force Mode 2026 Unicode support in terminal capabilities",
  type: "boolean",
  default: false,
})
registerEnvVar({
  name: "OPENTUI_GRAPHICS",
  description: "Enable Kitty graphics protocol detection",
  type: "boolean",
  default: true,
})
registerEnvVar({
  name: "OPENTUI_FORCE_NOZWJ",
  description: "Use no_zwj width method (Unicode without ZWJ joining)",
  type: "boolean",
  default: false,
})

// Cursor & mouse pointer style mappings (avoid recreation on each call)
const CURSOR_STYLE_TO_ID = { block: 0, line: 1, underline: 2, default: 3 } as const
const CURSOR_ID_TO_STYLE = ["block", "line", "underline", "default"] as const
const MOUSE_STYLE_TO_ID = {
  auto: 0,
  default: 1,
  none: 2,
  "context-menu": 3,
  help: 4,
  pointer: 5,
  progress: 6,
  wait: 7,
  cell: 8,
  crosshair: 9,
  text: 10,
  "vertical-text": 11,
  alias: 12,
  copy: 13,
  move: 14,
  "no-drop": 15,
  "not-allowed": 16,
  grab: 17,
  grabbing: 18,
  "all-scroll": 19,
  "col-resize": 20,
  "row-resize": 21,
  "n-resize": 22,
  "e-resize": 23,
  "s-resize": 24,
  "w-resize": 25,
  "ne-resize": 26,
  "nw-resize": 27,
  "se-resize": 28,
  "sw-resize": 29,
  "ew-resize": 30,
  "ns-resize": 31,
  "nesw-resize": 32,
  "nwse-resize": 33,
  "zoom-in": 34,
  "zoom-out": 35,
} as const

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

function ptrOrNull(value: ArrayBufferView): Pointer | null {
  return value.byteLength === 0 ? null : ptr(value)
}

function rgbaPtr(value: RGBA): Pointer {
  return ptr(value.buffer)
}

function optionalRgbaPtr(value: RGBA | null | undefined): Pointer | null {
  return value ? rgbaPtr(value) : null
}

function getOpenTUILib(libPath?: string) {
  const resolvedLibPath = libPath || targetLibPath

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
      args: ["u32"],
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
      args: ["u32", "ptr"],
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
      args: ["u32", "u32", "u32", "bool", "bool", "u32", "bool", "bool", "bool"],
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
      args: ["u32", "ptr", "u32", "ptr", "ptr", "u32"],
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
      args: ["u32", "u32", "bool", "u8", "ptr", "u32"],
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
    bufferClear: {
      args: ["u32", "ptr"],
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
      args: ["u32", "ptr", "u32"],
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
      args: ["u32", "ptr", "u32", "u32", "u32", "ptr", "ptr", "u32"],
      returns: "void",
    },
    bufferSetCellWithAlphaBlending: {
      args: ["u32", "u32", "u32", "u32", "ptr", "ptr", "u32"],
      returns: "void",
    },
    bufferSetCell: {
      args: ["u32", "u32", "u32", "u32", "ptr", "ptr", "u32"],
      returns: "void",
    },
    bufferFillRect: {
      args: ["u32", "u32", "u32", "u32", "u32", "ptr"],
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
      args: ["u32", "ptr"],
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
      args: ["u32", "bool", "u8"],
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
    triggerNotification: {
      args: ["u32", "ptr", "u32", "ptr", "u32"],
      returns: "bool",
    },

    bufferDrawSuperSampleBuffer: {
      args: ["u32", "u32", "u32", "ptr", "u32", "u8", "u32"],
      returns: "void",
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
      args: ["u32", "ptr", "ptr", "ptr", "ptr", "u32", "ptr", "u32", "ptr"],
      returns: "void",
    },
    bufferDrawBox: {
      args: ["u32", "i32", "i32", "u32", "u32", "ptr", "u32", "ptr", "ptr", "ptr", "ptr", "u32", "ptr", "u32"],
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
      args: ["u32", "i32", "i32", "i32", "i32", "ptr", "ptr"],
      returns: "bool",
    },
    textBufferViewUpdateSelection: {
      args: ["u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    textBufferViewUpdateLocalSelection: {
      args: ["u32", "i32", "i32", "i32", "i32", "ptr", "ptr"],
      returns: "bool",
    },
    textBufferViewResetLocalSelection: {
      args: ["u32"],
      returns: "void",
    },
    textBufferViewSetWrapWidth: {
      args: ["u32", "u32"],
      returns: "void",
    },
    textBufferViewSetWrapMode: {
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
      args: ["u32", "ptr"],
      returns: "void",
    },
    textBufferViewSetTruncate: {
      args: ["u32", "bool"],
      returns: "void",
    },
    textBufferViewMeasureForDimensions: {
      args: ["u32", "u32", "u32", "ptr"],
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
      args: ["u32", "ptr", "ptr", "ptr", "ptr"],
      returns: "void",
    },
    editorViewSetScrollMargin: {
      args: ["u32", "f32"],
      returns: "void",
    },
    editorViewSetWrapMode: {
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
      args: ["u32", "ptr"],
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
      args: ["u32", "ptr"],
      returns: "void",
    },
    editBufferGetPrevWordBoundary: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    editBufferGetEOL: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    editBufferOffsetToPosition: {
      args: ["u32", "u32", "ptr"],
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
      args: ["u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "bool", "bool"],
      returns: "bool",
    },
    editorViewUpdateSelection: {
      args: ["u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    editorViewUpdateLocalSelection: {
      args: ["u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "bool", "bool"],
      returns: "bool",
    },
    editorViewResetLocalSelection: {
      args: ["u32"],
      returns: "void",
    },
    editorViewGetSelectedTextBytes: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },
    editorViewGetCursor: {
      args: ["u32", "ptr", "ptr"],
      returns: "void",
    },
    editorViewGetText: {
      args: ["u32", "ptr", "u32"],
      returns: "u32",
    },

    // EditorView VisualCursor methods
    editorViewGetVisualCursor: {
      args: ["u32", "ptr"],
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
      args: ["u32", "ptr"],
      returns: "void",
    },
    editorViewGetPrevWordBoundary: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    editorViewGetEOL: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    editorViewGetVisualSOL: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    editorViewGetVisualEOL: {
      args: ["u32", "ptr"],
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
      args: ["u32", "ptr"],
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

    // Terminal capability functions
    getTerminalCapabilities: {
      args: ["u32", "ptr"],
      returns: "void",
    },
    processCapabilityResponse: {
      args: ["u32", "ptr", "u32"],
      returns: "void",
    },

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
      args: ["u32", "u32", "u32", "u32", "ptr", "ptr", "u32"],
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
      args: ["ptr", "ptr"],
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
      args: ["ptr", "ptr"],
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
      args: ["u32", "u32", "ptr", "u32"],
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
    audioLoad: {
      args: ["u32", "ptr", "u32", "ptr"],
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
      args: ["u32", "ptr", "u32", "ptr"],
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
      args: ["u32", "ptr", "u32", "u8"],
      returns: "i32",
    },
    audioEnableTap: {
      args: ["u32", "bool", "u32"],
      returns: "i32",
    },
    audioReadTap: {
      args: ["u32", "ptr", "u32", "u8", "ptr"],
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
      args: ["ptr", "ptr", "u32"],
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

export type NativeYogaDirtiedCallback = () => void

export interface AudioEngineLib {
  createAudioEngine: (options?: AudioCreateOptions | null) => AudioEngineHandle | null
  destroyAudioEngine: (engine: AudioEngineHandle) => void
  audioRefreshPlaybackDevices: (engine: AudioEngineHandle) => number
  audioGetPlaybackDeviceCount: (engine: AudioEngineHandle) => number
  audioGetPlaybackDeviceName: (engine: AudioEngineHandle, index: number) => string
  audioIsPlaybackDeviceDefault: (engine: AudioEngineHandle, index: number) => boolean
  audioSelectPlaybackDevice: (engine: AudioEngineHandle, index: number) => number
  audioClearPlaybackDeviceSelection: (engine: AudioEngineHandle) => void
  audioStart: (engine: AudioEngineHandle, options?: AudioStartOptions | null) => number
  audioStartMixer: (engine: AudioEngineHandle) => number
  audioStop: (engine: AudioEngineHandle) => number
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
  destroyRenderer: (renderer: RendererHandle) => void
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
  ) => NativeRenderOperationResult
  getNextBuffer: (renderer: RendererHandle) => OptimizedBuffer
  getCurrentBuffer: (renderer: RendererHandle) => OptimizedBuffer
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
    matrixPtr: Pointer,
    cellMaskPtr: Pointer,
    cellMaskCount: number,
    strength: number,
    target: TargetChannel,
  ) => void
  bufferColorMatrixUniform: (
    buffer: OptimizedBufferHandle,
    matrixPtr: Pointer,
    strength: number,
    target: TargetChannel,
  ) => void
  bufferDrawSuperSampleBuffer: (
    buffer: OptimizedBufferHandle,
    x: number,
    y: number,
    pixelDataPtr: Pointer,
    pixelDataLength: number,
    format: "bgra8unorm" | "rgba8unorm",
    alignedBytesPerRow: number,
  ) => void
  bufferDrawPackedBuffer: (
    buffer: OptimizedBufferHandle,
    dataPtr: Pointer,
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
    intensitiesPtr: Pointer,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null,
    bg: RGBA | null,
  ) => void
  bufferDrawGrayscaleBufferSupersampled: (
    buffer: OptimizedBufferHandle,
    posX: number,
    posY: number,
    intensitiesPtr: Pointer,
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
  copyToClipboardOSC52: (renderer: RendererHandle, target: number, payload: Uint8Array) => boolean
  clearClipboardOSC52: (renderer: RendererHandle, target: number) => boolean
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
  yogaNodeSetMeasureFunc: (node: Pointer, callback: Pointer | null) => void
  yogaNodeUnsetMeasureFunc: (node: Pointer) => void
  yogaNodeHasMeasureFunc: (node: Pointer) => boolean
  yogaNodeSetDirtiedFunc: (node: Pointer, callback: Pointer | null) => void
  yogaNodeUnsetDirtiedFunc: (node: Pointer) => void
  yogaStoreMeasureResult: (width: number, height: number) => void
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
  ) => boolean
  textBufferViewResetLocalSelection: (view: TextBufferViewHandle) => void
  textBufferViewSetWrapWidth: (view: TextBufferViewHandle, width: number) => void
  textBufferViewSetWrapMode: (view: TextBufferViewHandle, mode: "none" | "char" | "word") => void
  textBufferViewSetFirstLineOffset: (view: TextBufferViewHandle, offset: number) => void
  textBufferViewSetViewportSize: (view: TextBufferViewHandle, width: number, height: number) => void
  textBufferViewSetViewport: (view: TextBufferViewHandle, x: number, y: number, width: number, height: number) => void
  textBufferViewGetLineInfo: (view: TextBufferViewHandle) => LineInfo
  textBufferViewGetLogicalLineInfo: (view: TextBufferViewHandle) => LineInfo
  textBufferViewGetSelectedTextBytes: (view: TextBufferViewHandle, maxLength: number) => Uint8Array | null
  textBufferViewGetPlainTextBytes: (view: TextBufferViewHandle, maxLength: number) => Uint8Array | null
  textBufferViewSetTabIndicator: (view: TextBufferViewHandle, indicator: number) => void
  textBufferViewSetTabIndicatorColor: (view: TextBufferViewHandle, color: RGBA) => void
  textBufferViewSetTruncate: (view: TextBufferViewHandle, truncate: boolean) => void
  textBufferViewMeasureForDimensions: (
    view: TextBufferViewHandle,
    width: number,
    height: number,
  ) => { lineCount: number; widthColsMax: number } | null
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
  ) => boolean

  editorViewResetLocalSelection: (view: EditorViewHandle) => void
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

  getTerminalCapabilities: (renderer: RendererHandle) => TerminalCapabilities
  processCapabilityResponse: (renderer: RendererHandle, response: string) => void

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
  onNativeEvent: (name: string, handler: (data: ArrayBuffer) => void) => void
  onceNativeEvent: (name: string, handler: (data: ArrayBuffer) => void) => void
  offNativeEvent: (name: string, handler: (data: ArrayBuffer) => void) => void
  onAnyNativeEvent: (handler: (name: string, data: ArrayBuffer) => void) => void
}

class FFIRenderLib implements RenderLib {
  private opentui: ReturnType<typeof getOpenTUILib>
  public readonly encoder: TextEncoder = new TextEncoder()
  public readonly decoder: TextDecoder = new TextDecoder()
  private logCallbackWrapper: FFICallbackInstance | null = null
  private eventCallbackWrapper: FFICallbackInstance | null = null
  private eventSinkPtr: EventSinkHandle | null = null
  private _nativeEvents: EventEmitter = new EventEmitter()
  private _anyEventHandlers: Array<(name: string, data: ArrayBuffer) => void> = []
  private nativeSpanFeedCallbackWrapper: FFICallbackInstance | null = null
  private nativeSpanFeedHandlers = new Map<Pointer, NativeSpanFeedEventHandler>()

  constructor(libPath?: string) {
    this.opentui = getOpenTUILib(libPath)
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
    try {
      if (this.eventSinkPtr) {
        this.opentui.symbols.destroyEventSink(this.eventSinkPtr)
        this.eventSinkPtr = null
      }

      this.setLogCallback(null)
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
      ptrOrNull(keyBytes),
      keyBytes.byteLength,
      ptrOrNull(valueBytes),
      valueBytes.byteLength,
    )
  }

  public destroyRenderer(renderer: Pointer): void {
    this.opentui.symbols.destroyRenderer(renderer)
  }

  public setUseThread(renderer: Pointer, useThread: boolean) {
    this.opentui.symbols.setUseThread(renderer, ffiBool(useThread))
  }

  public setClearOnShutdown(renderer: Pointer, clear: boolean) {
    this.opentui.symbols.setClearOnShutdown(renderer, ffiBool(clear))
  }

  public setBackgroundColor(renderer: Pointer, color: RGBA) {
    this.opentui.symbols.setBackgroundColor(renderer, rgbaPtr(color))
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
    this.opentui.symbols.getRenderStats(renderer, ptr(statsBuffer))
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

    return new OptimizedBuffer(this, bufferPtr, width, height, { id: "next buffer", widthMethod: "unicode" })
  }

  public getCurrentBuffer(renderer: Pointer): OptimizedBuffer {
    const bufferPtr = this.opentui.symbols.getCurrentBuffer(renderer)
    if (!bufferPtr) {
      throw new Error("Failed to get current buffer")
    }

    const width = this.opentui.symbols.getBufferWidth(bufferPtr)
    const height = this.opentui.symbols.getBufferHeight(bufferPtr)

    return new OptimizedBuffer(this, bufferPtr, width, height, { id: "current buffer", widthMethod: "unicode" })
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
      ptr(paletteBuffer),
      palette.length,
      rgbaPtr(defaultForeground),
      rgbaPtr(defaultBackground),
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
    const actualLen = this.opentui.symbols.bufferGetId(buffer, ptr(outBuffer), maxLen)
    return this.decoder.decode(outBuffer.slice(0, actualLen))
  }

  public bufferGetRealCharSize(buffer: Pointer): number {
    return this.opentui.symbols.bufferGetRealCharSize(buffer)
  }

  public bufferWriteResolvedChars(buffer: Pointer, outputBuffer: Uint8Array, addLineBreaks: boolean): number {
    return this.opentui.symbols.bufferWriteResolvedChars(
      buffer,
      ptrOrNull(outputBuffer),
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
    this.opentui.symbols.bufferClear(buffer, rgbaPtr(color))
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
    const bg = optionalRgbaPtr(bgColor)
    const fg = rgbaPtr(color)

    this.opentui.symbols.bufferDrawText(
      buffer,
      ptrOrNull(textBytes),
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
    const bg = rgbaPtr(bgColor)
    const fg = rgbaPtr(color)

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
    const bg = rgbaPtr(bgColor)
    const fg = rgbaPtr(color)

    this.opentui.symbols.bufferSetCell(buffer, x, y, charPtr, fg, bg, attributes ?? 0)
  }

  public bufferFillRect(buffer: Pointer, x: number, y: number, width: number, height: number, color: RGBA) {
    const bg = rgbaPtr(color)
    this.opentui.symbols.bufferFillRect(buffer, x, y, width, height, bg)
  }

  public bufferColorMatrix(
    buffer: Pointer,
    matrixPtr: Pointer,
    cellMaskPtr: Pointer,
    cellMaskCount: number,
    strength: number,
    target: TargetChannel,
  ): void {
    this.opentui.symbols.bufferColorMatrix(buffer, matrixPtr, cellMaskPtr, cellMaskCount, strength, target)
  }

  public bufferColorMatrixUniform(buffer: Pointer, matrixPtr: Pointer, strength: number, target: TargetChannel): void {
    this.opentui.symbols.bufferColorMatrixUniform(buffer, matrixPtr, strength, target)
  }

  public bufferDrawSuperSampleBuffer(
    buffer: Pointer,
    x: number,
    y: number,
    pixelDataPtr: Pointer,
    pixelDataLength: number,
    format: "bgra8unorm" | "rgba8unorm",
    alignedBytesPerRow: number,
  ): void {
    const formatId = format === "bgra8unorm" ? 0 : 1
    this.opentui.symbols.bufferDrawSuperSampleBuffer(
      buffer,
      x,
      y,
      pixelDataPtr,
      pixelDataLength,
      formatId,
      alignedBytesPerRow,
    )
  }

  public bufferDrawPackedBuffer(
    buffer: Pointer,
    dataPtr: Pointer,
    dataLen: number,
    posX: number,
    posY: number,
    terminalWidthCells: number,
    terminalHeightCells: number,
  ): void {
    this.opentui.symbols.bufferDrawPackedBuffer(
      buffer,
      dataPtr,
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
    intensitiesPtr: Pointer,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null,
    bg: RGBA | null,
  ): void {
    this.opentui.symbols.bufferDrawGrayscaleBuffer(
      buffer,
      posX,
      posY,
      intensitiesPtr,
      srcWidth,
      srcHeight,
      optionalRgbaPtr(fg),
      optionalRgbaPtr(bg),
    )
  }

  public bufferDrawGrayscaleBufferSupersampled(
    buffer: Pointer,
    posX: number,
    posY: number,
    intensitiesPtr: Pointer,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null,
    bg: RGBA | null,
  ): void {
    this.opentui.symbols.bufferDrawGrayscaleBufferSupersampled(
      buffer,
      posX,
      posY,
      intensitiesPtr,
      srcWidth,
      srcHeight,
      optionalRgbaPtr(fg),
      optionalRgbaPtr(bg),
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
    const optionsBuffer = GridDrawOptionsStruct.pack({
      drawInner: options.drawInner,
      drawOuter: options.drawOuter,
    })

    this.opentui.symbols.bufferDrawGrid(
      buffer,
      ptr(borderChars),
      rgbaPtr(borderFg),
      rgbaPtr(borderBg),
      ptr(columnOffsets),
      columnCount,
      ptr(rowOffsets),
      rowCount,
      ptr(optionsBuffer),
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
    const titlePtr = titleBytes ? ptr(titleBytes) : null

    const bottomTitleBytes = bottomTitle ? this.encoder.encode(bottomTitle) : null
    const bottomTitleLen = bottomTitleBytes?.byteLength ?? 0
    const bottomTitlePtr = bottomTitleBytes ? ptr(bottomTitleBytes) : null

    this.opentui.symbols.bufferDrawBox(
      buffer,
      x,
      y,
      width,
      height,
      ptr(borderChars),
      packedOptions,
      rgbaPtr(borderColor),
      rgbaPtr(backgroundColor),
      rgbaPtr(titleColor),
      titlePtr,
      titleLen,
      bottomTitlePtr,
      bottomTitleLen,
    )
  }

  public bufferResize(buffer: Pointer, width: number, height: number): void {
    this.opentui.symbols.bufferResize(buffer, width, height)
  }

  // Link API
  public linkAlloc(url: string): number {
    const urlBytes = this.encoder.encode(url)
    return this.opentui.symbols.linkAlloc(ptrOrNull(urlBytes), urlBytes.byteLength)
  }

  public linkGetUrl(linkId: number, maxLen: number = 512): string {
    const outBuffer = new Uint8Array(maxLen)
    const actualLen = this.opentui.symbols.linkGetUrl(linkId, ptrOrNull(outBuffer), maxLen)
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
    this.opentui.symbols.setCursorColor(renderer, rgbaPtr(color))
  }

  public getCursorState(renderer: Pointer): CursorState {
    const cursorBuffer = new ArrayBuffer(CursorStateStruct.size)
    this.opentui.symbols.getCursorState(renderer, ptr(cursorBuffer))
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
    this.opentui.symbols.setCursorStyleOptions(renderer, ptr(buffer))
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
  ): NativeRenderOperationResult {
    return this.unpackRenderOperationResult(
      this.opentui.symbols.commitSplitFooterSnapshot(
        renderer,
        snapshot.ptr,
        rowColumns,
        ffiBool(startOnNewLine),
        ffiBool(trailingNewline),
        pinnedRenderOffset,
        ffiBool(force),
        ffiBool(beginFrame),
        ffiBool(finalizeFrame),
      ),
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

    const widthMethodCode = widthMethod === "wcwidth" ? 0 : 1
    const idToUse = id || "unnamed buffer"
    const idBytes = this.encoder.encode(idToUse)
    const bufferPtr = this.opentui.symbols.createOptimizedBuffer(
      width,
      height,
      ffiBool(respectAlpha),
      widthMethodCode,
      ptr(idBytes),
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
    this.opentui.symbols.setTerminalTitle(renderer, ptrOrNull(titleBytes), titleBytes.byteLength)
  }

  public copyToClipboardOSC52(renderer: Pointer, target: number, payload: Uint8Array): boolean {
    return Boolean(this.opentui.symbols.copyToClipboardOSC52(renderer, target, ptrOrNull(payload), payload.byteLength))
  }

  public clearClipboardOSC52(renderer: Pointer, target: number): boolean {
    return Boolean(this.opentui.symbols.clearClipboardOSC52(renderer, target))
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
    const ts = timestamp ?? Date.now()
    this.opentui.symbols.dumpBuffers(renderer, ts)
  }

  public dumpOutputBuffer(renderer: Pointer, timestamp?: number): void {
    const ts = timestamp ?? Date.now()
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
    this.opentui.symbols.writeOut(renderer, ptrOrNull(bytes), bytes.byteLength)
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
    const layout = new Float32Array(6)
    this.opentui.symbols.yogaNodeGetComputedLayout(node, ptr(layout))
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

  public yogaNodeSetMeasureFunc(node: Pointer, callback: Pointer | null): void {
    this.opentui.symbols.yogaNodeSetMeasureFunc(node, callback)
  }

  public yogaNodeUnsetMeasureFunc(node: Pointer): void {
    this.opentui.symbols.yogaNodeUnsetMeasureFunc(node)
  }

  public yogaNodeHasMeasureFunc(node: Pointer): boolean {
    return this.opentui.symbols.yogaNodeHasMeasureFunc(node)
  }

  public yogaNodeSetDirtiedFunc(node: Pointer, callback: Pointer | null): void {
    this.opentui.symbols.yogaNodeSetDirtiedFunc(node, callback)
  }

  public yogaNodeUnsetDirtiedFunc(node: Pointer): void {
    this.opentui.symbols.yogaNodeUnsetDirtiedFunc(node)
  }

  public yogaStoreMeasureResult(width: number, height: number): void {
    this.opentui.symbols.yogaStoreMeasureResult(width, height)
  }

  public createYogaMeasureCallback(callback: NativeYogaMeasureCallback): FFICallbackInstance {
    return this.opentui.createCallback(callback, {
      args: ["ptr", "f32", "u32", "f32", "u32"],
      returns: "void",
    })
  }

  public createYogaDirtiedCallback(callback: NativeYogaDirtiedCallback): FFICallbackInstance {
    return this.opentui.createCallback(callback, {
      args: [],
      returns: "void",
    })
  }

  // TextBuffer methods
  public createTextBuffer(widthMethod: WidthMethod): TextBuffer {
    const widthMethodCode = widthMethod === "wcwidth" ? 0 : 1
    const bufferPtr = this.opentui.symbols.createTextBuffer(widthMethodCode)
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
    const fgPtr = optionalRgbaPtr(fg)
    this.opentui.symbols.textBufferSetDefaultFg(buffer, fgPtr)
  }

  public textBufferSetDefaultBg(buffer: Pointer, bg: RGBA | null): void {
    const bgPtr = optionalRgbaPtr(bg)
    this.opentui.symbols.textBufferSetDefaultBg(buffer, bgPtr)
  }

  public textBufferSetDefaultAttributes(buffer: Pointer, attributes: number | null): void {
    const attrValue = attributes === null ? null : new Uint32Array([attributes])
    this.opentui.symbols.textBufferSetDefaultAttributes(buffer, attrValue ? ptr(attrValue) : null)
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
      ptrOrNull(bytes),
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
      ptrOrNull(bytes),
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
    this.opentui.symbols.textBufferAppend(buffer, ptrOrNull(bytes), bytes.byteLength)
  }

  public textBufferAppendFromMemId(buffer: Pointer, memId: number): void {
    this.opentui.symbols.textBufferAppendFromMemId(buffer, memId)
  }

  public textBufferLoadFile(buffer: Pointer, path: string): boolean {
    const pathBytes = this.encoder.encode(path)
    return this.opentui.symbols.textBufferLoadFile(buffer, ptrOrNull(pathBytes), pathBytes.byteLength)
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
    this.opentui.symbols.textBufferSetStyledText(buffer, ptr(chunksBuffer), chunks.length)
  }

  public textBufferGetLineCount(buffer: Pointer): number {
    return this.opentui.symbols.textBufferGetLineCount(buffer)
  }

  private textBufferGetPlainText(buffer: Pointer, outPtr: Pointer | null, maxLen: number): number {
    return this.opentui.symbols.textBufferGetPlainText(buffer, outPtr, maxLen)
  }

  public getPlainTextBytes(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.textBufferGetPlainText(buffer, ptrOrNull(outBuffer), maxLength)

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
      ptrOrNull(outBuffer),
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
      ptrOrNull(outBuffer),
      maxLength,
    )

    const len = actualLen

    if (len === 0) {
      return null
    }

    return outBuffer.slice(0, len)
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
    const bg = optionalRgbaPtr(bgColor)
    const fg = optionalRgbaPtr(fgColor)
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
  ): boolean {
    const bg = optionalRgbaPtr(bgColor)
    const fg = optionalRgbaPtr(fgColor)
    return Boolean(this.opentui.symbols.textBufferViewSetLocalSelection(view, anchorX, anchorY, focusX, focusY, bg, fg))
  }

  public textBufferViewUpdateSelection(view: Pointer, end: number, bgColor: RGBA | null, fgColor: RGBA | null): void {
    const bg = optionalRgbaPtr(bgColor)
    const fg = optionalRgbaPtr(fgColor)
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
  ): boolean {
    const bg = optionalRgbaPtr(bgColor)
    const fg = optionalRgbaPtr(fgColor)
    return Boolean(
      this.opentui.symbols.textBufferViewUpdateLocalSelection(view, anchorX, anchorY, focusX, focusY, bg, fg),
    )
  }

  public textBufferViewResetLocalSelection(view: Pointer): void {
    this.opentui.symbols.textBufferViewResetLocalSelection(view)
  }

  public textBufferViewSetWrapWidth(view: Pointer, width: number): void {
    this.opentui.symbols.textBufferViewSetWrapWidth(view, width)
  }

  public textBufferViewSetWrapMode(view: Pointer, mode: "none" | "char" | "word"): void {
    const modeValue = mode === "none" ? 0 : mode === "char" ? 1 : 2
    this.opentui.symbols.textBufferViewSetWrapMode(view, modeValue)
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
    this.textBufferViewGetLineInfoDirect(view, ptr(outBuffer))
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
    this.textBufferViewGetLogicalLineInfoDirect(view, ptr(outBuffer))
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

  private textBufferViewGetLineInfoDirect(view: Pointer, outPtr: Pointer): void {
    this.opentui.symbols.textBufferViewGetLineInfoDirect(view, outPtr)
  }

  private textBufferViewGetLogicalLineInfoDirect(view: Pointer, outPtr: Pointer): void {
    this.opentui.symbols.textBufferViewGetLogicalLineInfoDirect(view, outPtr)
  }

  private textBufferViewGetSelectedText(view: Pointer, outPtr: Pointer | null, maxLen: number): number {
    return this.opentui.symbols.textBufferViewGetSelectedText(view, outPtr, maxLen)
  }

  private textBufferViewGetPlainText(view: Pointer, outPtr: Pointer | null, maxLen: number): number {
    return this.opentui.symbols.textBufferViewGetPlainText(view, outPtr, maxLen)
  }

  public textBufferViewGetSelectedTextBytes(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.textBufferViewGetSelectedText(view, ptrOrNull(outBuffer), maxLength)

    if (actualLen === 0) {
      return null
    }

    return outBuffer.slice(0, actualLen)
  }

  public textBufferViewGetPlainTextBytes(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.textBufferViewGetPlainText(view, ptrOrNull(outBuffer), maxLength)

    if (actualLen === 0) {
      return null
    }

    return outBuffer.slice(0, actualLen)
  }

  public textBufferViewSetTabIndicator(view: Pointer, indicator: number): void {
    this.opentui.symbols.textBufferViewSetTabIndicator(view, indicator)
  }

  public textBufferViewSetTabIndicatorColor(view: Pointer, color: RGBA): void {
    this.opentui.symbols.textBufferViewSetTabIndicatorColor(view, rgbaPtr(color))
  }

  public textBufferViewSetTruncate(view: Pointer, truncate: boolean): void {
    this.opentui.symbols.textBufferViewSetTruncate(view, ffiBool(truncate))
  }

  public textBufferViewMeasureForDimensions(
    view: Pointer,
    width: number,
    height: number,
  ): { lineCount: number; widthColsMax: number } | null {
    const resultBuffer = new ArrayBuffer(MeasureResultStruct.size)
    const resultPtr = ptr(new Uint8Array(resultBuffer))
    const success = this.opentui.symbols.textBufferViewMeasureForDimensions(view, width, height, resultPtr)
    if (!success) {
      return null
    }
    const result = MeasureResultStruct.unpack(resultBuffer)
    return result
  }

  public textBufferAddHighlightByCharRange(buffer: Pointer, highlight: Highlight): void {
    const packedHighlight = HighlightStruct.pack(highlight)
    this.opentui.symbols.textBufferAddHighlightByCharRange(buffer, ptr(packedHighlight))
  }

  public textBufferAddHighlight(buffer: Pointer, lineIdx: number, highlight: Highlight): void {
    const packedHighlight = HighlightStruct.pack(highlight)
    this.opentui.symbols.textBufferAddHighlight(buffer, lineIdx, ptr(packedHighlight))
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

    const nativePtr = this.opentui.symbols.textBufferGetLineHighlightsPtr(buffer, lineIdx, ptr(outCountBuf))
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
    this.opentui.symbols.getBuildOptions(ptr(optionsBuffer))
    const options = BuildOptionsStruct.unpack(optionsBuffer)

    return {
      gpaSafeStats: !!options.gpaSafeStats,
      gpaMemoryLimitTracking: !!options.gpaMemoryLimitTracking,
    }
  }

  public getAllocatorStats(): AllocatorStats {
    const statsBuffer = new ArrayBuffer(AllocatorStatsStruct.size)
    this.opentui.symbols.getAllocatorStats(ptr(statsBuffer))
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

    this.opentui.symbols.editorViewGetViewport(view, ptr(x), ptr(y), ptr(width), ptr(height))

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
    this.opentui.symbols.editorViewGetLineInfoDirect(view, ptr(outBuffer))
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
    this.opentui.symbols.editorViewGetLogicalLineInfoDirect(view, ptr(outBuffer))
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
    const widthMethodCode = widthMethod === "wcwidth" ? 0 : 1
    const bufferPtr = this.opentui.symbols.createEditBuffer(widthMethodCode, this.eventSinkPtr ?? 0) as EditBufferHandle
    if (!bufferPtr) {
      throw new Error("Failed to create EditBuffer")
    }
    return bufferPtr
  }

  public destroyEditBuffer(buffer: Pointer): void {
    this.opentui.symbols.destroyEditBuffer(buffer)
  }

  public editBufferSetText(buffer: Pointer, textBytes: Uint8Array): void {
    this.opentui.symbols.editBufferSetText(buffer, ptrOrNull(textBytes), textBytes.byteLength)
  }

  public editBufferSetTextFromMem(buffer: Pointer, memId: number): void {
    this.opentui.symbols.editBufferSetTextFromMem(buffer, memId)
  }

  public editBufferReplaceText(buffer: Pointer, textBytes: Uint8Array): void {
    this.opentui.symbols.editBufferReplaceText(buffer, ptrOrNull(textBytes), textBytes.byteLength)
  }

  public editBufferReplaceTextFromMem(buffer: Pointer, memId: number): void {
    this.opentui.symbols.editBufferReplaceTextFromMem(buffer, memId)
  }

  public editBufferGetText(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editBufferGetText(buffer, ptrOrNull(outBuffer), maxLength)
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editBufferInsertChar(buffer: Pointer, char: string): void {
    const charBytes = this.encoder.encode(char)
    this.opentui.symbols.editBufferInsertChar(buffer, ptrOrNull(charBytes), charBytes.byteLength)
  }

  public editBufferInsertText(buffer: Pointer, text: string): void {
    const textBytes = this.encoder.encode(text)
    this.opentui.symbols.editBufferInsertText(buffer, ptrOrNull(textBytes), textBytes.byteLength)
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
    const cursorBuffer = new ArrayBuffer(LogicalCursorStruct.size)
    this.opentui.symbols.editBufferGetCursorPosition(buffer, ptr(cursorBuffer))
    return LogicalCursorStruct.unpack(cursorBuffer)
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

  public editBufferDebugLogRope(buffer: Pointer): void {
    this.opentui.symbols.editBufferDebugLogRope(buffer)
  }

  public editBufferUndo(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editBufferUndo(buffer, ptrOrNull(outBuffer), maxLength)
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editBufferRedo(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editBufferRedo(buffer, ptrOrNull(outBuffer), maxLength)
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
    const cursorBuffer = new ArrayBuffer(LogicalCursorStruct.size)
    this.opentui.symbols.editBufferGetNextWordBoundary(buffer, ptr(cursorBuffer))
    return LogicalCursorStruct.unpack(cursorBuffer)
  }

  public editBufferGetPrevWordBoundary(buffer: Pointer): LogicalCursor {
    const cursorBuffer = new ArrayBuffer(LogicalCursorStruct.size)
    this.opentui.symbols.editBufferGetPrevWordBoundary(buffer, ptr(cursorBuffer))
    return LogicalCursorStruct.unpack(cursorBuffer)
  }

  public editBufferGetEOL(buffer: Pointer): LogicalCursor {
    const cursorBuffer = new ArrayBuffer(LogicalCursorStruct.size)
    this.opentui.symbols.editBufferGetEOL(buffer, ptr(cursorBuffer))
    return LogicalCursorStruct.unpack(cursorBuffer)
  }

  public editBufferOffsetToPosition(buffer: Pointer, offset: number): LogicalCursor | null {
    const cursorBuffer = new ArrayBuffer(LogicalCursorStruct.size)
    const success = this.opentui.symbols.editBufferOffsetToPosition(buffer, offset, ptr(cursorBuffer))
    if (!success) return null
    return LogicalCursorStruct.unpack(cursorBuffer)
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
      ptrOrNull(outBuffer),
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
      ptrOrNull(outBuffer),
      maxLength,
    )
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  // EditorView selection and editing implementations
  public editorViewSetSelection(
    view: Pointer,
    start: number,
    end: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ): void {
    const bg = optionalRgbaPtr(bgColor)
    const fg = optionalRgbaPtr(fgColor)
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
  ): boolean {
    const bg = optionalRgbaPtr(bgColor)
    const fg = optionalRgbaPtr(fgColor)
    return Boolean(
      this.opentui.symbols.editorViewSetLocalSelection(
        view,
        anchorX,
        anchorY,
        focusX,
        focusY,
        bg,
        fg,
        ffiBool(updateCursor),
        ffiBool(followCursor),
      ),
    )
  }

  public editorViewUpdateSelection(view: Pointer, end: number, bgColor: RGBA | null, fgColor: RGBA | null): void {
    const bg = optionalRgbaPtr(bgColor)
    const fg = optionalRgbaPtr(fgColor)
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
  ): boolean {
    const bg = optionalRgbaPtr(bgColor)
    const fg = optionalRgbaPtr(fgColor)
    return Boolean(
      this.opentui.symbols.editorViewUpdateLocalSelection(
        view,
        anchorX,
        anchorY,
        focusX,
        focusY,
        bg,
        fg,
        ffiBool(updateCursor),
        ffiBool(followCursor),
      ),
    )
  }

  public editorViewResetLocalSelection(view: Pointer): void {
    this.opentui.symbols.editorViewResetLocalSelection(view)
  }

  public editorViewGetSelectedTextBytes(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editorViewGetSelectedTextBytes(view, ptrOrNull(outBuffer), maxLength)
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editorViewGetCursor(view: Pointer): { row: number; col: number } {
    const row = new Uint32Array(1)
    const col = new Uint32Array(1)
    this.opentui.symbols.editorViewGetCursor(view, ptr(row), ptr(col))
    return { row: row[0], col: col[0] }
  }

  public editorViewGetText(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editorViewGetText(view, ptrOrNull(outBuffer), maxLength)
    const len = actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editorViewGetVisualCursor(view: Pointer): VisualCursor {
    const cursorBuffer = new ArrayBuffer(VisualCursorStruct.size)
    this.opentui.symbols.editorViewGetVisualCursor(view, ptr(cursorBuffer))
    return VisualCursorStruct.unpack(cursorBuffer)
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
    const cursorBuffer = new ArrayBuffer(VisualCursorStruct.size)
    this.opentui.symbols.editorViewGetNextWordBoundary(view, ptr(cursorBuffer))
    return VisualCursorStruct.unpack(cursorBuffer)
  }

  public editorViewGetPrevWordBoundary(view: Pointer): VisualCursor {
    const cursorBuffer = new ArrayBuffer(VisualCursorStruct.size)
    this.opentui.symbols.editorViewGetPrevWordBoundary(view, ptr(cursorBuffer))
    return VisualCursorStruct.unpack(cursorBuffer)
  }

  public editorViewGetEOL(view: Pointer): VisualCursor {
    const cursorBuffer = new ArrayBuffer(VisualCursorStruct.size)
    this.opentui.symbols.editorViewGetEOL(view, ptr(cursorBuffer))
    return VisualCursorStruct.unpack(cursorBuffer)
  }

  public editorViewGetVisualSOL(view: Pointer): VisualCursor {
    const cursorBuffer = new ArrayBuffer(VisualCursorStruct.size)
    this.opentui.symbols.editorViewGetVisualSOL(view, ptr(cursorBuffer))
    return VisualCursorStruct.unpack(cursorBuffer)
  }

  public editorViewGetVisualEOL(view: Pointer): VisualCursor {
    const cursorBuffer = new ArrayBuffer(VisualCursorStruct.size)
    this.opentui.symbols.editorViewGetVisualEOL(view, ptr(cursorBuffer))
    return VisualCursorStruct.unpack(cursorBuffer)
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
    this.opentui.symbols.getTerminalCapabilities(renderer, ptr(capsBuffer))

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
      notifications: caps.notifications,
      explicit_cursor_positioning: caps.explicit_cursor_positioning,
      remote: caps.remote,
      multiplexer: caps.multiplexer,
      terminal: {
        name: caps.term_name ?? "",
        version: caps.term_version ?? "",
        from_xtversion: caps.term_from_xtversion,
      },
    }
  }

  public processCapabilityResponse(renderer: Pointer, response: string): void {
    const responseBytes = this.encoder.encode(response)
    this.opentui.symbols.processCapabilityResponse(renderer, ptrOrNull(responseBytes), responseBytes.byteLength)
  }

  public encodeUnicode(
    text: string,
    widthMethod: WidthMethod,
  ): { ptr: Pointer; data: Array<{ width: number; char: number }> } | null {
    const textBytes = this.encoder.encode(text)
    const widthMethodCode = widthMethod === "wcwidth" ? 0 : 1

    const outPtrBuffer = new ArrayBuffer(8) // Pointer-sized out slot
    const outLenBuffer = new ArrayBuffer(8) // Native length out slot

    const success = this.opentui.symbols.encodeUnicode(
      ptrOrNull(textBytes),
      textBytes.byteLength,
      ptr(outPtrBuffer),
      ptr(outLenBuffer),
      widthMethodCode,
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
    this.opentui.symbols.bufferDrawChar(buffer, char, x, y, rgbaPtr(fg), rgbaPtr(bg), attributes)
  }

  public createAudioEngine(options?: AudioCreateOptions | null): AudioEngineHandle | null {
    const optionsBuffer = options == null ? null : AudioCreateOptionsStruct.pack(options)
    const engineHandle = this.opentui.symbols.createAudioEngine(
      optionsBuffer ? ptr(optionsBuffer) : null,
    ) as AudioEngineHandle
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
      this.opentui.symbols.audioGetPlaybackDeviceName(engine, index, ptr(outBuffer), outBuffer.length),
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

  public audioStart(engine: Pointer, options?: AudioStartOptions | null): number {
    const optionsBuffer = options == null ? null : AudioStartOptionsStruct.pack(options)
    return this.opentui.symbols.audioStart(engine, optionsBuffer ? ptr(optionsBuffer) : null)
  }

  public audioStartMixer(engine: Pointer): number {
    return this.opentui.symbols.audioStartMixer(engine)
  }

  public audioStop(engine: Pointer): number {
    return this.opentui.symbols.audioStop(engine)
  }

  public audioLoad(engine: Pointer, data: Uint8Array): { status: number; soundId: number | null } {
    const outBuffer = new ArrayBuffer(4)
    const dataLength = toSafeFFIU32Length(data.byteLength, "Audio data length")
    const status = this.opentui.symbols.audioLoad(engine, ptr(data), dataLength, ptr(outBuffer))
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
    const outBuffer = new ArrayBuffer(4)
    const optionsBuffer = options ? AudioVoiceOptionsStruct.pack(options) : null
    const status = this.opentui.symbols.audioPlay(
      engine,
      soundId,
      optionsBuffer ? ptr(optionsBuffer) : null,
      ptr(outBuffer),
    )
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
    return this.opentui.symbols.audioSetVoiceGroup(engine, voiceId, groupId)
  }

  public audioCreateGroup(engine: Pointer, name: string): { status: number; groupId: number | null } {
    const outBuffer = new ArrayBuffer(4)
    const nameBytes = this.encoder.encode(name)
    const nameLength = toSafeFFIU32Length(nameBytes.byteLength, "Audio group name length")
    const status = this.opentui.symbols.audioCreateGroup(engine, ptr(nameBytes), nameLength, ptr(outBuffer))
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
    return this.opentui.symbols.audioMixToBuffer(engine, ptr(outBuffer), frameCount, channels)
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
    const status = this.opentui.symbols.audioReadTap(
      engine,
      ptr(outBuffer),
      frameCount,
      channels,
      ptr(outFramesReadBuffer),
    )
    if (status !== 0) {
      return { status, framesRead: 0 }
    }
    const view = new Uint32Array(outFramesReadBuffer)
    return { status, framesRead: view[0] ?? 0 }
  }

  public audioGetStats(engine: Pointer): AudioStats | null {
    const statsBuffer = new ArrayBuffer(AudioStatsStruct.size)
    const status = this.opentui.symbols.audioGetStats(engine, ptr(statsBuffer))
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
    const streamPtr = this.opentui.symbols.createNativeSpanFeed(optionsBuffer ? ptr(optionsBuffer) : null)
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
    return this.opentui.symbols.streamWrite(stream, ptrOrNull(bytes), bytes.byteLength)
  }

  public streamCommit(stream: Pointer): number {
    return this.opentui.symbols.streamCommit(stream)
  }

  public streamDrainSpans(stream: Pointer, outBuffer: Uint8Array, maxSpans: number): number {
    const count = this.opentui.symbols.streamDrainSpans(stream, ptr(outBuffer), maxSpans)
    return toNumber(count)
  }

  public streamClose(stream: Pointer): number {
    return this.opentui.symbols.streamClose(stream)
  }

  public streamSetOptions(stream: Pointer, options: NativeSpanFeedOptions): number {
    const optionsBuffer = NativeSpanFeedOptionsStruct.pack(options)
    return this.opentui.symbols.streamSetOptions(stream, ptr(optionsBuffer))
  }

  public streamGetStats(stream: Pointer): NativeSpanFeedStats | null {
    const statsBuffer = new ArrayBuffer(NativeSpanFeedStatsStruct.size)
    const status = this.opentui.symbols.streamGetStats(stream, ptr(statsBuffer))
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
    const status = this.opentui.symbols.streamReserve(stream, minLen, ptr(reserveBuffer))
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
    const fgPtr = optionalRgbaPtr(fg)
    const bgPtr = optionalRgbaPtr(bg)
    return this.opentui.symbols.syntaxStyleRegister(
      style,
      ptrOrNull(nameBytes),
      nameBytes.byteLength,
      fgPtr,
      bgPtr,
      attributes,
    )
  }

  public syntaxStyleResolveByName(style: SyntaxStyleHandle, name: string): number | null {
    const nameBytes = this.encoder.encode(name)
    const id = this.opentui.symbols.syntaxStyleResolveByName(style, ptrOrNull(nameBytes), nameBytes.byteLength)
    return id === 0 ? null : id
  }

  public syntaxStyleGetStyleCount(style: SyntaxStyleHandle): number {
    return this.opentui.symbols.syntaxStyleGetStyleCount(style)
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
    this.opentui.symbols.editorViewSetPlaceholderStyledText(view, ptr(chunksBuffer), nonEmptyChunks.length)
  }

  public editorViewSetTabIndicator(view: EditorViewHandle, indicator: number): void {
    this.opentui.symbols.editorViewSetTabIndicator(view, indicator)
  }

  public editorViewSetTabIndicatorColor(view: EditorViewHandle, color: RGBA): void {
    this.opentui.symbols.editorViewSetTabIndicatorColor(view, rgbaPtr(color))
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
