import { dlopen, toArrayBuffer, JSCallback, ptr, type Pointer } from "bun:ffi"
import { existsSync } from "fs"
import { EventEmitter } from "events"
import { type CursorStyle, type DebugOverlayCorner, type WidthMethod, type Highlight, type LineInfo } from "./types"
export type { LineInfo }

import { RGBA } from "./lib/RGBA"
import { OptimizedBuffer } from "./buffer"
import { TextBuffer } from "./text-buffer"
import { env, registerEnvVar } from "./lib/env"
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
} from "./zig-structs"
import { isBunfsPath } from "./lib/bunfs"
import { attributesWithLink } from "./utils"

const module = await import(`@opentui/core-${process.platform}-${process.arch}/index.ts`)
let targetLibPath = module.default

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

// Global singleton state for FFI tracing to prevent duplicate exit handlers
let globalTraceSymbols: Record<string, number[]> | null = null
let globalFFILogWriter: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null
let exitHandlerRegistered = false

function getOpenTUILib(libPath?: string) {
  const resolvedLibPath = libPath || targetLibPath

  const rawSymbols = dlopen(resolvedLibPath, {
    // Logging
    setLogCallback: {
      args: ["ptr"],
      returns: "void",
    },
    // Event bus
    setEventCallback: {
      args: ["ptr"],
      returns: "void",
    },
    // Renderer management
    createRenderer: {
      args: ["u32", "u32", "bool"],
      returns: "ptr",
    },
    destroyRenderer: {
      args: ["ptr"],
      returns: "void",
    },
    setUseThread: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    setBackgroundColor: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    setRenderOffset: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    updateStats: {
      args: ["ptr", "f64", "u32", "f64"],
      returns: "void",
    },
    updateMemoryStats: {
      args: ["ptr", "u32", "u32", "u32"],
      returns: "void",
    },
    graphemePoolGetTotalSlots: {
      args: [],
      returns: "u32",
    },
    graphemePoolGetUsedSlots: {
      args: [],
      returns: "u32",
    },
    graphemePoolGetTotalBytes: {
      args: [],
      returns: "usize",
    },
    graphemePoolGetClassSlots: {
      args: ["u8"],
      returns: "u32",
    },
    graphemePoolGetClassUsedSlots: {
      args: ["u8"],
      returns: "u32",
    },
    graphemePoolGetClassBytes: {
      args: ["u8"],
      returns: "usize",
    },
    render: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    getNextBuffer: {
      args: ["ptr"],
      returns: "ptr",
    },
    getCurrentBuffer: {
      args: ["ptr"],
      returns: "ptr",
    },

    queryPixelResolution: {
      args: ["ptr"],
      returns: "void",
    },

    createOptimizedBuffer: {
      args: ["u32", "u32", "bool", "u8", "ptr", "usize"],
      returns: "ptr",
    },
    destroyOptimizedBuffer: {
      args: ["ptr"],
      returns: "void",
    },

    drawFrameBuffer: {
      args: ["ptr", "i32", "i32", "ptr", "u32", "u32", "u32", "u32"],
      returns: "void",
    },
    getBufferWidth: {
      args: ["ptr"],
      returns: "u32",
    },
    getBufferHeight: {
      args: ["ptr"],
      returns: "u32",
    },
    bufferClear: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    bufferGetCharPtr: {
      args: ["ptr"],
      returns: "ptr",
    },
    bufferGetFgPtr: {
      args: ["ptr"],
      returns: "ptr",
    },
    bufferGetBgPtr: {
      args: ["ptr"],
      returns: "ptr",
    },
    bufferGetAttributesPtr: {
      args: ["ptr"],
      returns: "ptr",
    },
    bufferGetRespectAlpha: {
      args: ["ptr"],
      returns: "bool",
    },
    bufferSetRespectAlpha: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    bufferGetId: {
      args: ["ptr", "ptr", "usize"],
      returns: "usize",
    },
    bufferGetRealCharSize: {
      args: ["ptr"],
      returns: "u32",
    },
    bufferWriteResolvedChars: {
      args: ["ptr", "ptr", "usize", "bool"],
      returns: "u32",
    },

    bufferDrawText: {
      args: ["ptr", "ptr", "u32", "u32", "u32", "ptr", "ptr", "u32"],
      returns: "void",
    },
    bufferSetCellWithAlphaBlending: {
      args: ["ptr", "u32", "u32", "u32", "ptr", "ptr", "u32"],
      returns: "void",
    },
    bufferSetCell: {
      args: ["ptr", "u32", "u32", "u32", "ptr", "ptr", "u32"],
      returns: "void",
    },
    bufferFillRect: {
      args: ["ptr", "u32", "u32", "u32", "u32", "ptr"],
      returns: "void",
    },
    bufferResize: {
      args: ["ptr", "u32", "u32"],
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
      args: ["ptr", "u32", "u32"],
      returns: "void",
    },

    // Cursor functions (now renderer-scoped)
    setCursorPosition: {
      args: ["ptr", "i32", "i32", "bool"],
      returns: "void",
    },
    setCursorStyle: {
      args: ["ptr", "ptr", "u32", "bool"],
      returns: "void",
    },
    setCursorColor: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    getCursorState: {
      args: ["ptr", "ptr"],
      returns: "void",
    },

    // Debug overlay
    setDebugOverlay: {
      args: ["ptr", "bool", "u8"],
      returns: "void",
    },

    // Terminal control
    clearTerminal: {
      args: ["ptr"],
      returns: "void",
    },
    setTerminalTitle: {
      args: ["ptr", "ptr", "usize"],
      returns: "void",
    },

    bufferDrawSuperSampleBuffer: {
      args: ["ptr", "u32", "u32", "ptr", "usize", "u8", "u32"],
      returns: "void",
    },
    bufferDrawPackedBuffer: {
      args: ["ptr", "ptr", "usize", "u32", "u32", "u32", "u32"],
      returns: "void",
    },
    bufferDrawBox: {
      args: ["ptr", "i32", "i32", "u32", "u32", "ptr", "u32", "ptr", "ptr", "ptr", "u32"],
      returns: "void",
    },
    bufferPushScissorRect: {
      args: ["ptr", "i32", "i32", "u32", "u32"],
      returns: "void",
    },
    bufferPopScissorRect: {
      args: ["ptr"],
      returns: "void",
    },
    bufferClearScissorRects: {
      args: ["ptr"],
      returns: "void",
    },
    bufferPushOpacity: {
      args: ["ptr", "f32"],
      returns: "void",
    },
    bufferPopOpacity: {
      args: ["ptr"],
      returns: "void",
    },
    bufferGetCurrentOpacity: {
      args: ["ptr"],
      returns: "f32",
    },
    bufferClearOpacity: {
      args: ["ptr"],
      returns: "void",
    },

    addToHitGrid: {
      args: ["ptr", "i32", "i32", "u32", "u32", "u32"],
      returns: "void",
    },
    checkHit: {
      args: ["ptr", "u32", "u32"],
      returns: "u32",
    },
    dumpHitGrid: {
      args: ["ptr"],
      returns: "void",
    },
    dumpBuffers: {
      args: ["ptr", "i64"],
      returns: "void",
    },
    dumpStdoutBuffer: {
      args: ["ptr", "i64"],
      returns: "void",
    },
    enableMouse: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    disableMouse: {
      args: ["ptr"],
      returns: "void",
    },
    enableKittyKeyboard: {
      args: ["ptr", "u8"],
      returns: "void",
    },
    disableKittyKeyboard: {
      args: ["ptr"],
      returns: "void",
    },
    setKittyKeyboardFlags: {
      args: ["ptr", "u8"],
      returns: "void",
    },
    getKittyKeyboardFlags: {
      args: ["ptr"],
      returns: "u8",
    },
    setupTerminal: {
      args: ["ptr", "bool"],
      returns: "void",
    },
    suspendRenderer: {
      args: ["ptr"],
      returns: "void",
    },
    resumeRenderer: {
      args: ["ptr"],
      returns: "void",
    },

    // TextBuffer functions
    createTextBuffer: {
      args: ["u8"],
      returns: "ptr",
    },
    destroyTextBuffer: {
      args: ["ptr"],
      returns: "void",
    },
    textBufferGetLength: {
      args: ["ptr"],
      returns: "u32",
    },
    textBufferGetByteSize: {
      args: ["ptr"],
      returns: "u32",
    },
    textBufferGetArenaAllocatedBytes: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetRopeSegmentCount: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetMemRegistryUsedSlots: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetMemRegistryFreeSlots: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetStyledCapacity: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetHighlightLineCount: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetHighlightLineCapacity: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetHighlightCapacityTotal: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetSpanLineCount: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetSpanLineCapacity: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetSpanCapacityTotal: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferGetDirtySpanLineCount: {
      args: ["ptr"],
      returns: "usize",
    },

    textBufferReset: {
      args: ["ptr"],
      returns: "void",
    },
    textBufferClear: {
      args: ["ptr"],
      returns: "void",
    },
    textBufferSetDefaultFg: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    textBufferSetDefaultBg: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    textBufferSetDefaultAttributes: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    textBufferResetDefaults: {
      args: ["ptr"],
      returns: "void",
    },
    textBufferGetTabWidth: {
      args: ["ptr"],
      returns: "u8",
    },
    textBufferSetTabWidth: {
      args: ["ptr", "u8"],
      returns: "void",
    },
    textBufferRegisterMemBuffer: {
      args: ["ptr", "ptr", "usize", "bool"],
      returns: "u16",
    },
    textBufferReplaceMemBuffer: {
      args: ["ptr", "u8", "ptr", "usize", "bool"],
      returns: "bool",
    },
    textBufferClearMemRegistry: {
      args: ["ptr"],
      returns: "void",
    },
    textBufferSetTextFromMem: {
      args: ["ptr", "u8"],
      returns: "void",
    },
    textBufferSetTextFromMemReset: {
      args: ["ptr", "u8"],
      returns: "void",
    },
    textBufferAppend: {
      args: ["ptr", "ptr", "usize"],
      returns: "void",
    },
    textBufferAppendFromMemId: {
      args: ["ptr", "u8"],
      returns: "void",
    },
    textBufferLoadFile: {
      args: ["ptr", "ptr", "usize"],
      returns: "bool",
    },
    textBufferSetStyledText: {
      args: ["ptr", "ptr", "usize"],
      returns: "void",
    },
    textBufferGetLineCount: {
      args: ["ptr"],
      returns: "u32",
    },
    textBufferGetPlainText: {
      args: ["ptr", "ptr", "usize"],
      returns: "usize",
    },
    textBufferAddHighlightByCharRange: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    textBufferAddHighlight: {
      args: ["ptr", "u32", "ptr"],
      returns: "void",
    },
    textBufferRemoveHighlightsByRef: {
      args: ["ptr", "u16"],
      returns: "void",
    },
    textBufferClearLineHighlights: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    textBufferClearAllHighlights: {
      args: ["ptr"],
      returns: "void",
    },
    textBufferSetSyntaxStyle: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    textBufferGetLineHighlightsPtr: {
      args: ["ptr", "u32", "ptr"],
      returns: "ptr",
    },
    textBufferFreeLineHighlights: {
      args: ["ptr", "usize"],
      returns: "void",
    },
    textBufferGetHighlightCount: {
      args: ["ptr"],
      returns: "u32",
    },
    textBufferGetTextRange: {
      args: ["ptr", "u32", "u32", "ptr", "usize"],
      returns: "usize",
    },
    textBufferGetTextRangeByCoords: {
      args: ["ptr", "u32", "u32", "u32", "u32", "ptr", "usize"],
      returns: "usize",
    },

    // TextBufferView functions
    createTextBufferView: {
      args: ["ptr"],
      returns: "ptr",
    },
    destroyTextBufferView: {
      args: ["ptr"],
      returns: "void",
    },
    textBufferViewSetSelection: {
      args: ["ptr", "u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    textBufferViewResetSelection: {
      args: ["ptr"],
      returns: "void",
    },
    textBufferViewGetSelectionInfo: {
      args: ["ptr"],
      returns: "u64",
    },
    textBufferViewSetLocalSelection: {
      args: ["ptr", "i32", "i32", "i32", "i32", "ptr", "ptr"],
      returns: "bool",
    },
    textBufferViewUpdateSelection: {
      args: ["ptr", "u32", "ptr", "ptr"],
      returns: "void",
    },
    textBufferViewUpdateLocalSelection: {
      args: ["ptr", "i32", "i32", "i32", "i32", "ptr", "ptr"],
      returns: "bool",
    },
    textBufferViewResetLocalSelection: {
      args: ["ptr"],
      returns: "void",
    },
    textBufferViewSetWrapWidth: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    textBufferViewSetWrapMode: {
      args: ["ptr", "u8"],
      returns: "void",
    },
    textBufferViewSetViewportSize: {
      args: ["ptr", "u32", "u32"],
      returns: "void",
    },
    textBufferViewSetViewport: {
      args: ["ptr", "u32", "u32", "u32", "u32"],
      returns: "void",
    },
    textBufferViewGetVirtualLineCount: {
      args: ["ptr"],
      returns: "u32",
    },
    textBufferViewGetArenaAllocatedBytes: {
      args: ["ptr"],
      returns: "usize",
    },
    textBufferViewGetLineInfoDirect: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    textBufferViewGetLogicalLineInfoDirect: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    textBufferViewGetSelectedText: {
      args: ["ptr", "ptr", "usize"],
      returns: "usize",
    },
    textBufferViewGetPlainText: {
      args: ["ptr", "ptr", "usize"],
      returns: "usize",
    },
    textBufferViewSetTabIndicator: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    textBufferViewSetTabIndicatorColor: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    textBufferViewMeasureForDimensions: {
      args: ["ptr", "u32", "u32", "ptr"],
      returns: "bool",
    },
    bufferDrawTextBufferView: {
      args: ["ptr", "ptr", "i32", "i32"],
      returns: "void",
    },
    bufferDrawEditorView: {
      args: ["ptr", "ptr", "i32", "i32"],
      returns: "void",
    },

    // EditorView functions
    createEditorView: {
      args: ["ptr", "u32", "u32"],
      returns: "ptr",
    },
    destroyEditorView: {
      args: ["ptr"],
      returns: "void",
    },
    editorViewSetViewportSize: {
      args: ["ptr", "u32", "u32"],
      returns: "void",
    },
    editorViewSetViewport: {
      args: ["ptr", "u32", "u32", "u32", "u32", "bool"],
      returns: "void",
    },
    editorViewGetViewport: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "void",
    },
    editorViewSetScrollMargin: {
      args: ["ptr", "f32"],
      returns: "void",
    },
    editorViewSetWrapMode: {
      args: ["ptr", "u8"],
      returns: "void",
    },
    editorViewGetVirtualLineCount: {
      args: ["ptr"],
      returns: "u32",
    },
    editorViewGetTotalVirtualLineCount: {
      args: ["ptr"],
      returns: "u32",
    },
    editorViewGetTextBufferView: {
      args: ["ptr"],
      returns: "ptr",
    },
    editorViewGetLineInfoDirect: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    editorViewGetLogicalLineInfoDirect: {
      args: ["ptr", "ptr"],
      returns: "void",
    },

    // EditBuffer functions
    createEditBuffer: {
      args: ["u8"],
      returns: "ptr",
    },
    destroyEditBuffer: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferSetText: {
      args: ["ptr", "ptr", "usize"],
      returns: "void",
    },
    editBufferSetTextFromMem: {
      args: ["ptr", "u8"],
      returns: "void",
    },
    editBufferReplaceText: {
      args: ["ptr", "ptr", "usize"],
      returns: "void",
    },
    editBufferReplaceTextFromMem: {
      args: ["ptr", "u8"],
      returns: "void",
    },
    editBufferGetText: {
      args: ["ptr", "ptr", "usize"],
      returns: "usize",
    },
    editBufferInsertChar: {
      args: ["ptr", "ptr", "usize"],
      returns: "void",
    },
    editBufferInsertText: {
      args: ["ptr", "ptr", "usize"],
      returns: "void",
    },
    editBufferDeleteChar: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferDeleteCharBackward: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferDeleteRange: {
      args: ["ptr", "u32", "u32", "u32", "u32"],
      returns: "void",
    },
    editBufferNewLine: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferDeleteLine: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferMoveCursorLeft: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferMoveCursorRight: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferMoveCursorUp: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferMoveCursorDown: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferGotoLine: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    editBufferSetCursor: {
      args: ["ptr", "u32", "u32"],
      returns: "void",
    },
    editBufferSetCursorToLineCol: {
      args: ["ptr", "u32", "u32"],
      returns: "void",
    },
    editBufferSetCursorByOffset: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    editBufferGetCursorPosition: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    editBufferGetId: {
      args: ["ptr"],
      returns: "u16",
    },
    editBufferGetTextBuffer: {
      args: ["ptr"],
      returns: "ptr",
    },
    editBufferDebugLogRope: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferUndo: {
      args: ["ptr", "ptr", "usize"],
      returns: "usize",
    },
    editBufferRedo: {
      args: ["ptr", "ptr", "usize"],
      returns: "usize",
    },
    editBufferCanUndo: {
      args: ["ptr"],
      returns: "bool",
    },
    editBufferCanRedo: {
      args: ["ptr"],
      returns: "bool",
    },
    editBufferClearHistory: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferClear: {
      args: ["ptr"],
      returns: "void",
    },
    editBufferGetNextWordBoundary: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    editBufferGetPrevWordBoundary: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    editBufferGetEOL: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    editBufferOffsetToPosition: {
      args: ["ptr", "u32", "ptr"],
      returns: "bool",
    },
    editBufferPositionToOffset: {
      args: ["ptr", "u32", "u32"],
      returns: "u32",
    },
    editBufferGetLineStartOffset: {
      args: ["ptr", "u32"],
      returns: "u32",
    },
    editBufferGetTextRange: {
      args: ["ptr", "u32", "u32", "ptr", "usize"],
      returns: "usize",
    },
    editBufferGetTextRangeByCoords: {
      args: ["ptr", "u32", "u32", "u32", "u32", "ptr", "usize"],
      returns: "usize",
    },

    // EditorView selection and editing methods
    editorViewSetSelection: {
      args: ["ptr", "u32", "u32", "ptr", "ptr"],
      returns: "void",
    },
    editorViewResetSelection: {
      args: ["ptr"],
      returns: "void",
    },
    editorViewGetSelection: {
      args: ["ptr"],
      returns: "u64",
    },
    editorViewSetLocalSelection: {
      args: ["ptr", "i32", "i32", "i32", "i32", "ptr", "ptr", "bool"],
      returns: "bool",
    },
    editorViewUpdateSelection: {
      args: ["ptr", "u32", "ptr", "ptr"],
      returns: "void",
    },
    editorViewUpdateLocalSelection: {
      args: ["ptr", "i32", "i32", "i32", "i32", "ptr", "ptr", "bool"],
      returns: "bool",
    },
    editorViewResetLocalSelection: {
      args: ["ptr"],
      returns: "void",
    },
    editorViewGetSelectedTextBytes: {
      args: ["ptr", "ptr", "usize"],
      returns: "usize",
    },
    editorViewGetCursor: {
      args: ["ptr", "ptr", "ptr"],
      returns: "void",
    },
    editorViewGetText: {
      args: ["ptr", "ptr", "usize"],
      returns: "usize",
    },

    // EditorView VisualCursor methods
    editorViewGetVisualCursor: {
      args: ["ptr", "ptr"],
      returns: "void",
    },

    editorViewMoveUpVisual: {
      args: ["ptr"],
      returns: "void",
    },
    editorViewMoveDownVisual: {
      args: ["ptr"],
      returns: "void",
    },
    editorViewDeleteSelectedText: {
      args: ["ptr"],
      returns: "void",
    },
    editorViewSetCursorByOffset: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    editorViewGetNextWordBoundary: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    editorViewGetPrevWordBoundary: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    editorViewGetEOL: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    editorViewGetVisualSOL: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    editorViewGetVisualEOL: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    editorViewSetPlaceholderStyledText: {
      args: ["ptr", "ptr", "usize"],
      returns: "void",
    },
    editorViewSetTabIndicator: {
      args: ["ptr", "u32"],
      returns: "void",
    },
    editorViewSetTabIndicatorColor: {
      args: ["ptr", "ptr"],
      returns: "void",
    },

    getArenaAllocatedBytes: {
      args: [],
      returns: "usize",
    },

    // SyntaxStyle functions
    createSyntaxStyle: {
      args: [],
      returns: "ptr",
    },
    destroySyntaxStyle: {
      args: ["ptr"],
      returns: "void",
    },
    syntaxStyleRegister: {
      args: ["ptr", "ptr", "usize", "ptr", "ptr", "u8"],
      returns: "u32",
    },
    syntaxStyleResolveByName: {
      args: ["ptr", "ptr", "usize"],
      returns: "u32",
    },
    syntaxStyleGetStyleCount: {
      args: ["ptr"],
      returns: "usize",
    },

    // Terminal capability functions
    getTerminalCapabilities: {
      args: ["ptr", "ptr"],
      returns: "void",
    },
    processCapabilityResponse: {
      args: ["ptr", "ptr", "usize"],
      returns: "void",
    },

    // Unicode encoding API
    encodeUnicode: {
      args: ["ptr", "usize", "ptr", "ptr", "u8"],
      returns: "bool",
    },
    freeUnicode: {
      args: ["ptr", "usize"],
      returns: "void",
    },
    bufferDrawChar: {
      args: ["ptr", "u32", "u32", "u32", "ptr", "ptr", "u32"],
      returns: "void",
    },
  })

  if (env.OTUI_DEBUG_FFI || env.OTUI_TRACE_FFI) {
    return {
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

  // Initialize global debug log writer on first call
  if (env.OTUI_DEBUG_FFI && !globalFFILogWriter) {
    const now = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, "-").replace(/T/, "_").split("Z")[0]
    const logFilePath = `ffi_otui_debug_${timestamp}.log`
    globalFFILogWriter = Bun.file(logFilePath).writer()
  }

  const debugSymbols: Record<string, any> = {}
  let hasTracing = false

  Object.entries(symbols).forEach(([key, value]) => {
    debugSymbols[key] = value
  })

  if (env.OTUI_DEBUG_FFI && globalFFILogWriter) {
    const writer = globalFFILogWriter
    const writeSync = (msg: string) => {
      const buffer = new TextEncoder().encode(msg + "\n")
      writer.write(buffer)
      writer.flush()
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
      try {
        if (globalFFILogWriter) {
          globalFFILogWriter.end()
        }
      } catch (e) {
        // Ignore errors on exit
      }

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
          const minWidth = Math.max(minHeader.length, ...allStats.map((s) => s.min.toFixed(2).length))
          const maxWidth = Math.max(maxHeader.length, ...allStats.map((s) => s.max.toFixed(2).length))
          const medianWidth = Math.max(medHeader.length, ...allStats.map((s) => s.median.toFixed(2).length))
          const p90Width = Math.max(p90Header.length, ...allStats.map((s) => s.p90.toFixed(2).length))
          const p99Width = Math.max(p99Header.length, ...allStats.map((s) => s.p99.toFixed(2).length))

          lines.push(
            `${nameHeader.padEnd(nameWidth)} | ` +
              `${callsHeader.padStart(countWidth)} | ` +
              `${totalHeader.padStart(totalWidth)} | ` +
              `${avgHeader.padStart(avgWidth)} | ` +
              `${minHeader.padStart(minWidth)} | ` +
              `${maxHeader.padStart(maxWidth)} | ` +
              `${medHeader.padStart(medianWidth)} | ` +
              `${p90Header.padStart(p90Width)} | ` +
              `${p99Header.padStart(p99Width)}`,
          )
          lines.push(
            `${"-".repeat(nameWidth)}-+-${"-".repeat(countWidth)}-+-${"-".repeat(totalWidth)}-+-${"-".repeat(avgWidth)}-+-${"-".repeat(minWidth)}-+-${"-".repeat(maxWidth)}-+-${"-".repeat(medianWidth)}-+-${"-".repeat(p90Width)}-+-${"-".repeat(p99Width)}`,
          )

          allStats.forEach((stat) => {
            lines.push(
              `${stat.name.padEnd(nameWidth)} | ` +
                `${String(stat.count).padStart(countWidth)} | ` +
                `${stat.total.toFixed(2).padStart(totalWidth)} | ` +
                `${stat.average.toFixed(2).padStart(avgWidth)} | ` +
                `${stat.min.toFixed(2).padStart(minWidth)} | ` +
                `${stat.max.toFixed(2).padStart(maxWidth)} | ` +
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
          Bun.write(traceFilePath, output)
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

export interface RenderLib {
  createRenderer: (width: number, height: number, options?: { testing: boolean }) => Pointer | null
  destroyRenderer: (renderer: Pointer) => void
  setUseThread: (renderer: Pointer, useThread: boolean) => void
  setBackgroundColor: (renderer: Pointer, color: RGBA) => void
  setRenderOffset: (renderer: Pointer, offset: number) => void
  updateStats: (renderer: Pointer, time: number, fps: number, frameCallbackTime: number) => void
  updateMemoryStats: (renderer: Pointer, heapUsed: number, heapTotal: number, arrayBuffers: number) => void
  graphemePoolGetTotalSlots: () => number
  graphemePoolGetUsedSlots: () => number
  graphemePoolGetTotalBytes: () => number
  graphemePoolGetClassSlots: (classId: number) => number
  graphemePoolGetClassUsedSlots: (classId: number) => number
  graphemePoolGetClassBytes: (classId: number) => number
  render: (renderer: Pointer, force: boolean) => void
  getNextBuffer: (renderer: Pointer) => OptimizedBuffer
  getCurrentBuffer: (renderer: Pointer) => OptimizedBuffer
  createOptimizedBuffer: (
    width: number,
    height: number,
    widthMethod: WidthMethod,
    respectAlpha?: boolean,
    id?: string,
  ) => OptimizedBuffer
  destroyOptimizedBuffer: (bufferPtr: Pointer) => void
  drawFrameBuffer: (
    targetBufferPtr: Pointer,
    destX: number,
    destY: number,
    bufferPtr: Pointer,
    sourceX?: number,
    sourceY?: number,
    sourceWidth?: number,
    sourceHeight?: number,
  ) => void
  getBufferWidth: (buffer: Pointer) => number
  getBufferHeight: (buffer: Pointer) => number
  bufferClear: (buffer: Pointer, color: RGBA) => void
  bufferGetCharPtr: (buffer: Pointer) => Pointer
  bufferGetFgPtr: (buffer: Pointer) => Pointer
  bufferGetBgPtr: (buffer: Pointer) => Pointer
  bufferGetAttributesPtr: (buffer: Pointer) => Pointer
  bufferGetRespectAlpha: (buffer: Pointer) => boolean
  bufferSetRespectAlpha: (buffer: Pointer, respectAlpha: boolean) => void
  bufferGetId: (buffer: Pointer) => string
  bufferGetRealCharSize: (buffer: Pointer) => number
  bufferWriteResolvedChars: (buffer: Pointer, outputBuffer: Uint8Array, addLineBreaks: boolean) => number
  bufferDrawText: (
    buffer: Pointer,
    text: string,
    x: number,
    y: number,
    color: RGBA,
    bgColor?: RGBA,
    attributes?: number,
  ) => void
  bufferSetCellWithAlphaBlending: (
    buffer: Pointer,
    x: number,
    y: number,
    char: string,
    color: RGBA,
    bgColor: RGBA,
    attributes?: number,
  ) => void
  bufferSetCell: (
    buffer: Pointer,
    x: number,
    y: number,
    char: string,
    color: RGBA,
    bgColor: RGBA,
    attributes?: number,
  ) => void
  bufferFillRect: (buffer: Pointer, x: number, y: number, width: number, height: number, color: RGBA) => void
  bufferDrawSuperSampleBuffer: (
    buffer: Pointer,
    x: number,
    y: number,
    pixelDataPtr: Pointer,
    pixelDataLength: number,
    format: "bgra8unorm" | "rgba8unorm",
    alignedBytesPerRow: number,
  ) => void
  bufferDrawPackedBuffer: (
    buffer: Pointer,
    dataPtr: Pointer,
    dataLen: number,
    posX: number,
    posY: number,
    terminalWidthCells: number,
    terminalHeightCells: number,
  ) => void
  bufferDrawBox: (
    buffer: Pointer,
    x: number,
    y: number,
    width: number,
    height: number,
    borderChars: Uint32Array,
    packedOptions: number,
    borderColor: RGBA,
    backgroundColor: RGBA,
    title: string | null,
  ) => void
  bufferResize: (buffer: Pointer, width: number, height: number) => void
  resizeRenderer: (renderer: Pointer, width: number, height: number) => void
  setCursorPosition: (renderer: Pointer, x: number, y: number, visible: boolean) => void
  setCursorStyle: (renderer: Pointer, style: CursorStyle, blinking: boolean) => void
  setCursorColor: (renderer: Pointer, color: RGBA) => void
  getCursorState: (renderer: Pointer) => CursorState
  setDebugOverlay: (renderer: Pointer, enabled: boolean, corner: DebugOverlayCorner) => void
  clearTerminal: (renderer: Pointer) => void
  setTerminalTitle: (renderer: Pointer, title: string) => void
  addToHitGrid: (renderer: Pointer, x: number, y: number, width: number, height: number, id: number) => void
  checkHit: (renderer: Pointer, x: number, y: number) => number
  dumpHitGrid: (renderer: Pointer) => void
  dumpBuffers: (renderer: Pointer, timestamp?: number) => void
  dumpStdoutBuffer: (renderer: Pointer, timestamp?: number) => void
  enableMouse: (renderer: Pointer, enableMovement: boolean) => void
  disableMouse: (renderer: Pointer) => void
  enableKittyKeyboard: (renderer: Pointer, flags: number) => void
  disableKittyKeyboard: (renderer: Pointer) => void
  setKittyKeyboardFlags: (renderer: Pointer, flags: number) => void
  getKittyKeyboardFlags: (renderer: Pointer) => number
  setupTerminal: (renderer: Pointer, useAlternateScreen: boolean) => void
  suspendRenderer: (renderer: Pointer) => void
  resumeRenderer: (renderer: Pointer) => void
  queryPixelResolution: (renderer: Pointer) => void

  // TextBuffer methods
  createTextBuffer: (widthMethod: WidthMethod) => TextBuffer
  destroyTextBuffer: (buffer: Pointer) => void
  textBufferGetLength: (buffer: Pointer) => number
  textBufferGetByteSize: (buffer: Pointer) => number
  textBufferGetArenaAllocatedBytes: (buffer: Pointer) => number
  textBufferGetRopeSegmentCount: (buffer: Pointer) => number
  textBufferGetMemRegistryUsedSlots: (buffer: Pointer) => number
  textBufferGetMemRegistryFreeSlots: (buffer: Pointer) => number
  textBufferGetStyledCapacity: (buffer: Pointer) => number
  textBufferGetHighlightLineCount: (buffer: Pointer) => number
  textBufferGetHighlightLineCapacity: (buffer: Pointer) => number
  textBufferGetHighlightCapacityTotal: (buffer: Pointer) => number
  textBufferGetSpanLineCount: (buffer: Pointer) => number
  textBufferGetSpanLineCapacity: (buffer: Pointer) => number
  textBufferGetSpanCapacityTotal: (buffer: Pointer) => number
  textBufferGetDirtySpanLineCount: (buffer: Pointer) => number

  textBufferReset: (buffer: Pointer) => void
  textBufferClear: (buffer: Pointer) => void
  textBufferRegisterMemBuffer: (buffer: Pointer, bytes: Uint8Array, owned?: boolean) => number
  textBufferReplaceMemBuffer: (buffer: Pointer, memId: number, bytes: Uint8Array, owned?: boolean) => boolean
  textBufferClearMemRegistry: (buffer: Pointer) => void
  textBufferSetTextFromMem: (buffer: Pointer, memId: number) => void
  textBufferSetTextFromMemReset: (buffer: Pointer, memId: number) => void
  textBufferAppend: (buffer: Pointer, bytes: Uint8Array) => void
  textBufferAppendFromMemId: (buffer: Pointer, memId: number) => void
  textBufferLoadFile: (buffer: Pointer, path: string) => boolean
  textBufferSetStyledText: (
    buffer: Pointer,
    chunks: Array<{ text: string; fg?: RGBA | null; bg?: RGBA | null; attributes?: number; link?: { url: string } }>,
  ) => void
  textBufferSetDefaultFg: (buffer: Pointer, fg: RGBA | null) => void
  textBufferSetDefaultBg: (buffer: Pointer, bg: RGBA | null) => void
  textBufferSetDefaultAttributes: (buffer: Pointer, attributes: number | null) => void
  textBufferResetDefaults: (buffer: Pointer) => void
  textBufferGetTabWidth: (buffer: Pointer) => number
  textBufferSetTabWidth: (buffer: Pointer, width: number) => void
  textBufferGetLineCount: (buffer: Pointer) => number
  getPlainTextBytes: (buffer: Pointer, maxLength: number) => Uint8Array | null
  textBufferGetTextRange: (
    buffer: Pointer,
    startOffset: number,
    endOffset: number,
    maxLength: number,
  ) => Uint8Array | null
  textBufferGetTextRangeByCoords: (
    buffer: Pointer,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    maxLength: number,
  ) => Uint8Array | null

  // TextBufferView methods
  createTextBufferView: (textBuffer: Pointer) => Pointer
  destroyTextBufferView: (view: Pointer) => void
  textBufferViewSetSelection: (
    view: Pointer,
    start: number,
    end: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ) => void
  textBufferViewResetSelection: (view: Pointer) => void
  textBufferViewGetSelection: (view: Pointer) => { start: number; end: number } | null
  textBufferViewSetLocalSelection: (
    view: Pointer,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ) => boolean
  textBufferViewUpdateSelection: (view: Pointer, end: number, bgColor: RGBA | null, fgColor: RGBA | null) => void
  textBufferViewUpdateLocalSelection: (
    view: Pointer,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ) => boolean
  textBufferViewResetLocalSelection: (view: Pointer) => void
  textBufferViewSetWrapWidth: (view: Pointer, width: number) => void
  textBufferViewSetWrapMode: (view: Pointer, mode: "none" | "char" | "word") => void
  textBufferViewSetViewportSize: (view: Pointer, width: number, height: number) => void
  textBufferViewSetViewport: (view: Pointer, x: number, y: number, width: number, height: number) => void
  textBufferViewGetLineInfo: (view: Pointer) => LineInfo
  textBufferViewGetLogicalLineInfo: (view: Pointer) => LineInfo
  textBufferViewGetSelectedTextBytes: (view: Pointer, maxLength: number) => Uint8Array | null
  textBufferViewGetPlainTextBytes: (view: Pointer, maxLength: number) => Uint8Array | null
  textBufferViewSetTabIndicator: (view: Pointer, indicator: number) => void
  textBufferViewSetTabIndicatorColor: (view: Pointer, color: RGBA) => void
  textBufferViewMeasureForDimensions: (
    view: Pointer,
    width: number,
    height: number,
  ) => { lineCount: number; maxWidth: number } | null
  textBufferViewGetVirtualLineCount: (view: Pointer) => number
  textBufferViewGetArenaAllocatedBytes: (view: Pointer) => number

  readonly encoder: TextEncoder
  readonly decoder: TextDecoder
  bufferDrawTextBufferView: (buffer: Pointer, view: Pointer, x: number, y: number) => void
  bufferDrawEditorView: (buffer: Pointer, view: Pointer, x: number, y: number) => void

  // EditBuffer methods
  createEditBuffer: (widthMethod: WidthMethod) => Pointer
  destroyEditBuffer: (buffer: Pointer) => void
  editBufferSetText: (buffer: Pointer, textBytes: Uint8Array) => void
  editBufferSetTextFromMem: (buffer: Pointer, memId: number) => void
  editBufferReplaceText: (buffer: Pointer, textBytes: Uint8Array) => void
  editBufferReplaceTextFromMem: (buffer: Pointer, memId: number) => void
  editBufferGetText: (buffer: Pointer, maxLength: number) => Uint8Array | null
  editBufferInsertChar: (buffer: Pointer, char: string) => void
  editBufferInsertText: (buffer: Pointer, text: string) => void
  editBufferDeleteChar: (buffer: Pointer) => void
  editBufferDeleteCharBackward: (buffer: Pointer) => void
  editBufferDeleteRange: (buffer: Pointer, startLine: number, startCol: number, endLine: number, endCol: number) => void
  editBufferNewLine: (buffer: Pointer) => void
  editBufferDeleteLine: (buffer: Pointer) => void
  editBufferMoveCursorLeft: (buffer: Pointer) => void
  editBufferMoveCursorRight: (buffer: Pointer) => void
  editBufferMoveCursorUp: (buffer: Pointer) => void
  editBufferMoveCursorDown: (buffer: Pointer) => void
  editBufferGotoLine: (buffer: Pointer, line: number) => void
  editBufferSetCursor: (buffer: Pointer, line: number, col: number) => void
  editBufferSetCursorToLineCol: (buffer: Pointer, line: number, col: number) => void
  editBufferSetCursorByOffset: (buffer: Pointer, offset: number) => void
  editBufferGetCursorPosition: (buffer: Pointer) => LogicalCursor
  editBufferGetId: (buffer: Pointer) => number
  editBufferGetTextBuffer: (buffer: Pointer) => Pointer
  editBufferDebugLogRope: (buffer: Pointer) => void
  editBufferUndo: (buffer: Pointer, maxLength: number) => Uint8Array | null
  editBufferRedo: (buffer: Pointer, maxLength: number) => Uint8Array | null
  editBufferCanUndo: (buffer: Pointer) => boolean
  editBufferCanRedo: (buffer: Pointer) => boolean
  editBufferClearHistory: (buffer: Pointer) => void
  editBufferClear: (buffer: Pointer) => void
  editBufferGetNextWordBoundary: (buffer: Pointer) => { row: number; col: number; offset: number }
  editBufferGetPrevWordBoundary: (buffer: Pointer) => { row: number; col: number; offset: number }
  editBufferGetEOL: (buffer: Pointer) => { row: number; col: number; offset: number }
  editBufferOffsetToPosition: (buffer: Pointer, offset: number) => { row: number; col: number; offset: number } | null
  editBufferPositionToOffset: (buffer: Pointer, row: number, col: number) => number
  editBufferGetLineStartOffset: (buffer: Pointer, row: number) => number
  editBufferGetTextRange: (
    buffer: Pointer,
    startOffset: number,
    endOffset: number,
    maxLength: number,
  ) => Uint8Array | null
  editBufferGetTextRangeByCoords: (
    buffer: Pointer,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    maxLength: number,
  ) => Uint8Array | null

  // EditorView methods
  createEditorView: (editBufferPtr: Pointer, viewportWidth: number, viewportHeight: number) => Pointer
  destroyEditorView: (view: Pointer) => void
  editorViewSetViewportSize: (view: Pointer, width: number, height: number) => void
  editorViewSetViewport: (
    view: Pointer,
    x: number,
    y: number,
    width: number,
    height: number,
    moveCursor: boolean,
  ) => void
  editorViewGetViewport: (view: Pointer) => { offsetY: number; offsetX: number; height: number; width: number }
  editorViewSetScrollMargin: (view: Pointer, margin: number) => void
  editorViewSetWrapMode: (view: Pointer, mode: "none" | "char" | "word") => void
  editorViewGetVirtualLineCount: (view: Pointer) => number
  editorViewGetTotalVirtualLineCount: (view: Pointer) => number
  editorViewGetTextBufferView: (view: Pointer) => Pointer
  editorViewSetSelection: (
    view: Pointer,
    start: number,
    end: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
  ) => void
  editorViewResetSelection: (view: Pointer) => void
  editorViewGetSelection: (view: Pointer) => { start: number; end: number } | null
  editorViewSetLocalSelection: (
    view: Pointer,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
    updateCursor: boolean,
  ) => boolean
  editorViewUpdateSelection: (view: Pointer, end: number, bgColor: RGBA | null, fgColor: RGBA | null) => void
  editorViewUpdateLocalSelection: (
    view: Pointer,
    anchorX: number,
    anchorY: number,
    focusX: number,
    focusY: number,
    bgColor: RGBA | null,
    fgColor: RGBA | null,
    updateCursor: boolean,
  ) => boolean
  editorViewResetLocalSelection: (view: Pointer) => void
  editorViewGetSelectedTextBytes: (view: Pointer, maxLength: number) => Uint8Array | null
  editorViewGetCursor: (view: Pointer) => { row: number; col: number }
  editorViewGetText: (view: Pointer, maxLength: number) => Uint8Array | null
  editorViewGetVisualCursor: (view: Pointer) => VisualCursor
  editorViewMoveUpVisual: (view: Pointer) => void
  editorViewMoveDownVisual: (view: Pointer) => void
  editorViewDeleteSelectedText: (view: Pointer) => void
  editorViewSetCursorByOffset: (view: Pointer, offset: number) => void
  editorViewGetNextWordBoundary: (view: Pointer) => VisualCursor
  editorViewGetPrevWordBoundary: (view: Pointer) => VisualCursor
  editorViewGetEOL: (view: Pointer) => VisualCursor
  editorViewGetVisualSOL: (view: Pointer) => VisualCursor
  editorViewGetVisualEOL: (view: Pointer) => VisualCursor
  editorViewGetLineInfo: (view: Pointer) => LineInfo
  editorViewGetLogicalLineInfo: (view: Pointer) => LineInfo
  editorViewSetPlaceholderStyledText: (
    view: Pointer,
    chunks: Array<{ text: string; fg?: RGBA | null; bg?: RGBA | null; attributes?: number }>,
  ) => void
  editorViewSetTabIndicator: (view: Pointer, indicator: number) => void
  editorViewSetTabIndicatorColor: (view: Pointer, color: RGBA) => void

  bufferPushScissorRect: (buffer: Pointer, x: number, y: number, width: number, height: number) => void
  bufferPopScissorRect: (buffer: Pointer) => void
  bufferClearScissorRects: (buffer: Pointer) => void
  bufferPushOpacity: (buffer: Pointer, opacity: number) => void
  bufferPopOpacity: (buffer: Pointer) => void
  bufferGetCurrentOpacity: (buffer: Pointer) => number
  bufferClearOpacity: (buffer: Pointer) => void
  textBufferAddHighlightByCharRange: (buffer: Pointer, highlight: Highlight) => void
  textBufferAddHighlight: (buffer: Pointer, lineIdx: number, highlight: Highlight) => void
  textBufferRemoveHighlightsByRef: (buffer: Pointer, hlRef: number) => void
  textBufferClearLineHighlights: (buffer: Pointer, lineIdx: number) => void
  textBufferClearAllHighlights: (buffer: Pointer) => void
  textBufferSetSyntaxStyle: (buffer: Pointer, style: Pointer | null) => void
  textBufferGetLineHighlights: (buffer: Pointer, lineIdx: number) => Array<Highlight>
  textBufferGetHighlightCount: (buffer: Pointer) => number

  getArenaAllocatedBytes: () => number

  createSyntaxStyle: () => Pointer
  destroySyntaxStyle: (style: Pointer) => void
  syntaxStyleRegister: (style: Pointer, name: string, fg: RGBA | null, bg: RGBA | null, attributes: number) => number
  syntaxStyleResolveByName: (style: Pointer, name: string) => number | null
  syntaxStyleGetStyleCount: (style: Pointer) => number

  getTerminalCapabilities: (renderer: Pointer) => any
  processCapabilityResponse: (renderer: Pointer, response: string) => void

  encodeUnicode: (
    text: string,
    widthMethod: WidthMethod,
  ) => { ptr: Pointer; data: Array<{ width: number; char: number }> } | null
  freeUnicode: (encoded: { ptr: Pointer; data: Array<{ width: number; char: number }> }) => void
  bufferDrawChar: (buffer: Pointer, char: number, x: number, y: number, fg: RGBA, bg: RGBA, attributes?: number) => void

  onNativeEvent: (name: string, handler: (data: ArrayBuffer) => void) => void
  onceNativeEvent: (name: string, handler: (data: ArrayBuffer) => void) => void
  offNativeEvent: (name: string, handler: (data: ArrayBuffer) => void) => void
  onAnyNativeEvent: (handler: (name: string, data: ArrayBuffer) => void) => void
}

class FFIRenderLib implements RenderLib {
  private opentui: ReturnType<typeof getOpenTUILib>
  public readonly encoder: TextEncoder = new TextEncoder()
  public readonly decoder: TextDecoder = new TextDecoder()
  private logCallbackWrapper: any // Store the FFI callback wrapper
  private eventCallbackWrapper: any // Store the FFI event callback wrapper
  private _nativeEvents: EventEmitter = new EventEmitter()
  private _anyEventHandlers: Array<(name: string, data: ArrayBuffer) => void> = []

  constructor(libPath?: string) {
    this.opentui = getOpenTUILib(libPath)
    this.setupLogging()
    this.setupEventBus()
  }

  private toNumber(value: number | bigint): number {
    return typeof value === "bigint" ? Number(value) : value
  }

  private setupLogging() {
    if (this.logCallbackWrapper) {
      return
    }

    const logCallback = new JSCallback(
      (level: number, msgPtr: Pointer, msgLenBigInt: bigint | number) => {
        try {
          const msgLen = typeof msgLenBigInt === "bigint" ? Number(msgLenBigInt) : msgLenBigInt

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
        args: ["u8", "ptr", "usize"],
        returns: "void",
      },
    )

    this.logCallbackWrapper = logCallback

    if (!logCallback.ptr) {
      throw new Error("Failed to create log callback")
    }

    this.setLogCallback(logCallback.ptr)
  }

  private setLogCallback(callbackPtr: Pointer) {
    this.opentui.symbols.setLogCallback(callbackPtr)
  }

  private setupEventBus() {
    if (this.eventCallbackWrapper) {
      return
    }

    const eventCallback = new JSCallback(
      (namePtr: Pointer, nameLenBigInt: bigint | number, dataPtr: Pointer, dataLenBigInt: bigint | number) => {
        try {
          const nameLen = typeof nameLenBigInt === "bigint" ? Number(nameLenBigInt) : nameLenBigInt
          const dataLen = typeof dataLenBigInt === "bigint" ? Number(dataLenBigInt) : dataLenBigInt

          if (nameLen === 0 || !namePtr) {
            return
          }

          const nameBuffer = toArrayBuffer(namePtr, 0, nameLen)
          const nameBytes = new Uint8Array(nameBuffer)
          const eventName = this.decoder.decode(nameBytes)

          let eventData: ArrayBuffer
          if (dataLen > 0 && dataPtr) {
            eventData = toArrayBuffer(dataPtr, 0, dataLen).slice()
          } else {
            eventData = new ArrayBuffer(0)
          }

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
        args: ["ptr", "usize", "ptr", "usize"],
        returns: "void",
      },
    )

    this.eventCallbackWrapper = eventCallback

    if (!eventCallback.ptr) {
      throw new Error("Failed to create event callback")
    }

    this.setEventCallback(eventCallback.ptr)
  }

  private setEventCallback(callbackPtr: Pointer) {
    this.opentui.symbols.setEventCallback(callbackPtr)
  }

  public createRenderer(width: number, height: number, options: { testing: boolean } = { testing: false }) {
    return this.opentui.symbols.createRenderer(width, height, options.testing)
  }

  public destroyRenderer(renderer: Pointer): void {
    this.opentui.symbols.destroyRenderer(renderer)
  }

  public setUseThread(renderer: Pointer, useThread: boolean) {
    this.opentui.symbols.setUseThread(renderer, useThread)
  }

  public setBackgroundColor(renderer: Pointer, color: RGBA) {
    this.opentui.symbols.setBackgroundColor(renderer, color.buffer)
  }

  public setRenderOffset(renderer: Pointer, offset: number) {
    this.opentui.symbols.setRenderOffset(renderer, offset)
  }

  public updateStats(renderer: Pointer, time: number, fps: number, frameCallbackTime: number) {
    this.opentui.symbols.updateStats(renderer, time, fps, frameCallbackTime)
  }

  public updateMemoryStats(renderer: Pointer, heapUsed: number, heapTotal: number, arrayBuffers: number) {
    this.opentui.symbols.updateMemoryStats(renderer, heapUsed, heapTotal, arrayBuffers)
  }

  public graphemePoolGetTotalSlots(): number {
    return this.opentui.symbols.graphemePoolGetTotalSlots()
  }

  public graphemePoolGetUsedSlots(): number {
    return this.opentui.symbols.graphemePoolGetUsedSlots()
  }

  public graphemePoolGetTotalBytes(): number {
    return this.toNumber(this.opentui.symbols.graphemePoolGetTotalBytes())
  }

  public graphemePoolGetClassSlots(classId: number): number {
    return this.opentui.symbols.graphemePoolGetClassSlots(classId)
  }

  public graphemePoolGetClassUsedSlots(classId: number): number {
    return this.opentui.symbols.graphemePoolGetClassUsedSlots(classId)
  }

  public graphemePoolGetClassBytes(classId: number): number {
    return this.toNumber(this.opentui.symbols.graphemePoolGetClassBytes(classId))
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
    this.opentui.symbols.bufferSetRespectAlpha(buffer, respectAlpha)
  }

  public bufferGetId(buffer: Pointer): string {
    const maxLen = 256
    const outBuffer = new Uint8Array(maxLen)
    const actualLen = this.opentui.symbols.bufferGetId(buffer, outBuffer, maxLen)
    const len = typeof actualLen === "bigint" ? Number(actualLen) : actualLen
    return this.decoder.decode(outBuffer.slice(0, len))
  }

  public bufferGetRealCharSize(buffer: Pointer): number {
    return this.opentui.symbols.bufferGetRealCharSize(buffer)
  }

  public bufferWriteResolvedChars(buffer: Pointer, outputBuffer: Uint8Array, addLineBreaks: boolean): number {
    const bytesWritten = this.opentui.symbols.bufferWriteResolvedChars(
      buffer,
      outputBuffer,
      outputBuffer.length,
      addLineBreaks,
    )
    return typeof bytesWritten === "bigint" ? Number(bytesWritten) : bytesWritten
  }

  public getBufferWidth(buffer: Pointer): number {
    return this.opentui.symbols.getBufferWidth(buffer)
  }

  public getBufferHeight(buffer: Pointer): number {
    return this.opentui.symbols.getBufferHeight(buffer)
  }

  public bufferClear(buffer: Pointer, color: RGBA) {
    this.opentui.symbols.bufferClear(buffer, color.buffer)
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
    const textLength = textBytes.byteLength
    const bg = bgColor ? bgColor.buffer : null
    const fg = color.buffer

    this.opentui.symbols.bufferDrawText(buffer, textBytes, textLength, x, y, fg, bg, attributes ?? 0)
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
    const bg = bgColor.buffer
    const fg = color.buffer

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
    const bg = bgColor.buffer
    const fg = color.buffer

    this.opentui.symbols.bufferSetCell(buffer, x, y, charPtr, fg, bg, attributes ?? 0)
  }

  public bufferFillRect(buffer: Pointer, x: number, y: number, width: number, height: number, color: RGBA) {
    const bg = color.buffer
    this.opentui.symbols.bufferFillRect(buffer, x, y, width, height, bg)
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
    title: string | null,
  ): void {
    const titleBytes = title ? this.encoder.encode(title) : null
    const titleLen = title ? titleBytes!.length : 0
    const titlePtr = title ? titleBytes : null

    this.opentui.symbols.bufferDrawBox(
      buffer,
      x,
      y,
      width,
      height,
      borderChars,
      packedOptions,
      borderColor.buffer,
      backgroundColor.buffer,
      titlePtr,
      titleLen,
    )
  }

  public bufferResize(buffer: Pointer, width: number, height: number): void {
    this.opentui.symbols.bufferResize(buffer, width, height)
  }

  // Link API
  public linkAlloc(url: string): number {
    const urlBytes = this.encoder.encode(url)
    return this.opentui.symbols.linkAlloc(urlBytes, urlBytes.length)
  }

  public linkGetUrl(linkId: number, maxLen: number = 512): string {
    const outBuffer = new Uint8Array(maxLen)
    const actualLen = this.opentui.symbols.linkGetUrl(linkId, outBuffer, maxLen)
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
    this.opentui.symbols.setCursorPosition(renderer, x, y, visible)
  }

  public setCursorStyle(renderer: Pointer, style: CursorStyle, blinking: boolean) {
    const stylePtr = this.encoder.encode(style)
    this.opentui.symbols.setCursorStyle(renderer, stylePtr, style.length, blinking)
  }

  public setCursorColor(renderer: Pointer, color: RGBA) {
    this.opentui.symbols.setCursorColor(renderer, color.buffer)
  }

  public getCursorState(renderer: Pointer): CursorState {
    const cursorBuffer = new ArrayBuffer(CursorStateStruct.size)
    this.opentui.symbols.getCursorState(renderer, ptr(cursorBuffer))
    const struct = CursorStateStruct.unpack(cursorBuffer)

    const styleMap: Record<number, CursorStyle> = {
      0: "block",
      1: "line",
      2: "underline",
    }

    return {
      x: struct.x,
      y: struct.y,
      visible: struct.visible,
      style: styleMap[struct.style] || "block",
      blinking: struct.blinking,
      color: RGBA.fromValues(struct.r, struct.g, struct.b, struct.a),
    }
  }

  public render(renderer: Pointer, force: boolean) {
    this.opentui.symbols.render(renderer, force)
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
      respectAlpha,
      widthMethodCode,
      idBytes,
      idBytes.length,
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
    this.opentui.symbols.setDebugOverlay(renderer, enabled, corner)
  }

  public clearTerminal(renderer: Pointer) {
    this.opentui.symbols.clearTerminal(renderer)
  }

  public setTerminalTitle(renderer: Pointer, title: string) {
    const titleBytes = this.encoder.encode(title)
    this.opentui.symbols.setTerminalTitle(renderer, titleBytes, titleBytes.length)
  }

  public addToHitGrid(renderer: Pointer, x: number, y: number, width: number, height: number, id: number) {
    this.opentui.symbols.addToHitGrid(renderer, x, y, width, height, id)
  }

  public checkHit(renderer: Pointer, x: number, y: number): number {
    return this.opentui.symbols.checkHit(renderer, x, y)
  }

  public dumpHitGrid(renderer: Pointer): void {
    this.opentui.symbols.dumpHitGrid(renderer)
  }

  public dumpBuffers(renderer: Pointer, timestamp?: number): void {
    const ts = timestamp ?? Date.now()
    this.opentui.symbols.dumpBuffers(renderer, ts)
  }

  public dumpStdoutBuffer(renderer: Pointer, timestamp?: number): void {
    const ts = timestamp ?? Date.now()
    this.opentui.symbols.dumpStdoutBuffer(renderer, ts)
  }

  public enableMouse(renderer: Pointer, enableMovement: boolean): void {
    this.opentui.symbols.enableMouse(renderer, enableMovement)
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
    this.opentui.symbols.setupTerminal(renderer, useAlternateScreen)
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

  public textBufferGetArenaAllocatedBytes(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetArenaAllocatedBytes(buffer))
  }

  public textBufferGetRopeSegmentCount(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetRopeSegmentCount(buffer))
  }

  public textBufferGetMemRegistryUsedSlots(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetMemRegistryUsedSlots(buffer))
  }

  public textBufferGetMemRegistryFreeSlots(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetMemRegistryFreeSlots(buffer))
  }

  public textBufferGetStyledCapacity(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetStyledCapacity(buffer))
  }

  public textBufferGetHighlightLineCount(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetHighlightLineCount(buffer))
  }

  public textBufferGetHighlightLineCapacity(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetHighlightLineCapacity(buffer))
  }

  public textBufferGetHighlightCapacityTotal(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetHighlightCapacityTotal(buffer))
  }

  public textBufferGetSpanLineCount(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetSpanLineCount(buffer))
  }

  public textBufferGetSpanLineCapacity(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetSpanLineCapacity(buffer))
  }

  public textBufferGetSpanCapacityTotal(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetSpanCapacityTotal(buffer))
  }

  public textBufferGetDirtySpanLineCount(buffer: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferGetDirtySpanLineCount(buffer))
  }

  public textBufferReset(buffer: Pointer): void {
    this.opentui.symbols.textBufferReset(buffer)
  }

  public textBufferClear(buffer: Pointer): void {
    this.opentui.symbols.textBufferClear(buffer)
  }

  public textBufferSetDefaultFg(buffer: Pointer, fg: RGBA | null): void {
    const fgPtr = fg ? fg.buffer : null
    this.opentui.symbols.textBufferSetDefaultFg(buffer, fgPtr)
  }

  public textBufferSetDefaultBg(buffer: Pointer, bg: RGBA | null): void {
    const bgPtr = bg ? bg.buffer : null
    this.opentui.symbols.textBufferSetDefaultBg(buffer, bgPtr)
  }

  public textBufferSetDefaultAttributes(buffer: Pointer, attributes: number | null): void {
    const attrValue = attributes === null ? null : new Uint8Array([attributes])
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
    const result = this.opentui.symbols.textBufferRegisterMemBuffer(buffer, bytes, bytes.length, owned)
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
    return this.opentui.symbols.textBufferReplaceMemBuffer(buffer, memId, bytes, bytes.length, owned)
  }

  public textBufferClearMemRegistry(buffer: Pointer): void {
    this.opentui.symbols.textBufferClearMemRegistry(buffer)
  }

  public textBufferSetTextFromMem(buffer: Pointer, memId: number): void {
    this.opentui.symbols.textBufferSetTextFromMem(buffer, memId)
  }

  public textBufferSetTextFromMemReset(buffer: Pointer, memId: number): void {
    this.opentui.symbols.textBufferSetTextFromMemReset(buffer, memId)
  }

  public textBufferAppend(buffer: Pointer, bytes: Uint8Array): void {
    this.opentui.symbols.textBufferAppend(buffer, bytes, bytes.length)
  }

  public textBufferAppendFromMemId(buffer: Pointer, memId: number): void {
    this.opentui.symbols.textBufferAppendFromMemId(buffer, memId)
  }

  public textBufferLoadFile(buffer: Pointer, path: string): boolean {
    const pathBytes = this.encoder.encode(path)
    return this.opentui.symbols.textBufferLoadFile(buffer, pathBytes, pathBytes.length)
  }

  public textBufferSetStyledText(
    buffer: Pointer,
    chunks: Array<{ text: string; fg?: RGBA | null; bg?: RGBA | null; attributes?: number; link?: { url: string } }>,
  ): void {
    // TODO: This should be a filter on the struct packing to not iterate twice
    const nonEmptyChunks = chunks.filter((c) => c.text.length > 0)
    if (nonEmptyChunks.length === 0) {
      this.textBufferClear(buffer)
      return
    }

    // Allocate link IDs and pack them into attributes
    const processedChunks = nonEmptyChunks.map((chunk) => {
      if (chunk.link) {
        const linkId = this.linkAlloc(chunk.link.url)
        return {
          ...chunk,
          attributes: attributesWithLink(chunk.attributes ?? 0, linkId),
        }
      }
      return chunk
    })

    const chunksBuffer = StyledChunkStruct.packList(processedChunks)

    this.opentui.symbols.textBufferSetStyledText(buffer, ptr(chunksBuffer), processedChunks.length)
  }

  public textBufferGetLineCount(buffer: Pointer): number {
    return this.opentui.symbols.textBufferGetLineCount(buffer)
  }

  private textBufferGetPlainText(buffer: Pointer, outPtr: Pointer, maxLen: number): number {
    const result = this.opentui.symbols.textBufferGetPlainText(buffer, outPtr, maxLen)
    return typeof result === "bigint" ? Number(result) : result
  }

  public getPlainTextBytes(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.textBufferGetPlainText(buffer, ptr(outBuffer), maxLength)

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
      ptr(outBuffer),
      maxLength,
    )

    const len = typeof actualLen === "bigint" ? Number(actualLen) : actualLen

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
      ptr(outBuffer),
      maxLength,
    )

    const len = typeof actualLen === "bigint" ? Number(actualLen) : actualLen

    if (len === 0) {
      return null
    }

    return outBuffer.slice(0, len)
  }

  // TextBufferView methods
  public createTextBufferView(textBuffer: Pointer): Pointer {
    const viewPtr = this.opentui.symbols.createTextBufferView(textBuffer)
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
    const bg = bgColor ? bgColor.buffer : null
    const fg = fgColor ? fgColor.buffer : null
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
    const bg = bgColor ? bgColor.buffer : null
    const fg = fgColor ? fgColor.buffer : null
    return this.opentui.symbols.textBufferViewSetLocalSelection(view, anchorX, anchorY, focusX, focusY, bg, fg)
  }

  public textBufferViewUpdateSelection(view: Pointer, end: number, bgColor: RGBA | null, fgColor: RGBA | null): void {
    const bg = bgColor ? bgColor.buffer : null
    const fg = fgColor ? fgColor.buffer : null
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
    const bg = bgColor ? bgColor.buffer : null
    const fg = fgColor ? fgColor.buffer : null
    return this.opentui.symbols.textBufferViewUpdateLocalSelection(view, anchorX, anchorY, focusX, focusY, bg, fg)
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
    return {
      maxLineWidth: struct.maxWidth,
      lineStarts: struct.starts as number[],
      lineWidths: struct.widths as number[],
      lineSources: struct.sources as number[],
      lineWraps: struct.wraps as number[],
    }
  }

  public textBufferViewGetLogicalLineInfo(view: Pointer): LineInfo {
    const outBuffer = new ArrayBuffer(LineInfoStruct.size)
    this.textBufferViewGetLogicalLineInfoDirect(view, ptr(outBuffer))
    const struct = LineInfoStruct.unpack(outBuffer)
    return {
      maxLineWidth: struct.maxWidth,
      lineStarts: struct.starts as number[],
      lineWidths: struct.widths as number[],
      lineSources: struct.sources as number[],
      lineWraps: struct.wraps as number[],
    }
  }

  public textBufferViewGetVirtualLineCount(view: Pointer): number {
    return this.opentui.symbols.textBufferViewGetVirtualLineCount(view)
  }

  public textBufferViewGetArenaAllocatedBytes(view: Pointer): number {
    return this.toNumber(this.opentui.symbols.textBufferViewGetArenaAllocatedBytes(view))
  }

  private textBufferViewGetLineInfoDirect(view: Pointer, outPtr: Pointer): void {
    this.opentui.symbols.textBufferViewGetLineInfoDirect(view, outPtr)
  }

  private textBufferViewGetLogicalLineInfoDirect(view: Pointer, outPtr: Pointer): void {
    this.opentui.symbols.textBufferViewGetLogicalLineInfoDirect(view, outPtr)
  }

  private textBufferViewGetSelectedText(view: Pointer, outPtr: Pointer, maxLen: number): number {
    const result = this.opentui.symbols.textBufferViewGetSelectedText(view, outPtr, maxLen)
    return typeof result === "bigint" ? Number(result) : result
  }

  private textBufferViewGetPlainText(view: Pointer, outPtr: Pointer, maxLen: number): number {
    const result = this.opentui.symbols.textBufferViewGetPlainText(view, outPtr, maxLen)
    return typeof result === "bigint" ? Number(result) : result
  }

  public textBufferViewGetSelectedTextBytes(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.textBufferViewGetSelectedText(view, ptr(outBuffer), maxLength)

    if (actualLen === 0) {
      return null
    }

    return outBuffer.slice(0, actualLen)
  }

  public textBufferViewGetPlainTextBytes(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)

    const actualLen = this.textBufferViewGetPlainText(view, ptr(outBuffer), maxLength)

    if (actualLen === 0) {
      return null
    }

    return outBuffer.slice(0, actualLen)
  }

  public textBufferViewSetTabIndicator(view: Pointer, indicator: number): void {
    this.opentui.symbols.textBufferViewSetTabIndicator(view, indicator)
  }

  public textBufferViewSetTabIndicatorColor(view: Pointer, color: RGBA): void {
    this.opentui.symbols.textBufferViewSetTabIndicatorColor(view, color.buffer)
  }

  public textBufferViewMeasureForDimensions(
    view: Pointer,
    width: number,
    height: number,
  ): { lineCount: number; maxWidth: number } | null {
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

  public textBufferSetSyntaxStyle(buffer: Pointer, style: Pointer | null): void {
    this.opentui.symbols.textBufferSetSyntaxStyle(buffer, style)
  }

  public textBufferGetLineHighlights(buffer: Pointer, lineIdx: number): Array<Highlight> {
    const outCountBuf = new BigUint64Array(1)

    const nativePtr = this.opentui.symbols.textBufferGetLineHighlightsPtr(buffer, lineIdx, ptr(outCountBuf))
    if (!nativePtr) return []

    const count = Number(outCountBuf[0])
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
    return typeof result === "bigint" ? Number(result) : result
  }

  public bufferDrawTextBufferView(buffer: Pointer, view: Pointer, x: number, y: number): void {
    this.opentui.symbols.bufferDrawTextBufferView(buffer, view, x, y)
  }

  public bufferDrawEditorView(buffer: Pointer, view: Pointer, x: number, y: number): void {
    this.opentui.symbols.bufferDrawEditorView(buffer, view, x, y)
  }

  // EditorView methods
  public createEditorView(editBufferPtr: Pointer, viewportWidth: number, viewportHeight: number): Pointer {
    const viewPtr = this.opentui.symbols.createEditorView(editBufferPtr, viewportWidth, viewportHeight)
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
    this.opentui.symbols.editorViewSetViewport(view, x, y, width, height, moveCursor)
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

  public editorViewGetTextBufferView(view: Pointer): Pointer {
    const result = this.opentui.symbols.editorViewGetTextBufferView(view)
    if (!result) {
      throw new Error("Failed to get TextBufferView from EditorView")
    }
    return result
  }

  public editorViewGetLineInfo(view: Pointer): LineInfo {
    const outBuffer = new ArrayBuffer(LineInfoStruct.size)
    this.opentui.symbols.editorViewGetLineInfoDirect(view, ptr(outBuffer))
    const struct = LineInfoStruct.unpack(outBuffer)
    return {
      maxLineWidth: struct.maxWidth,
      lineStarts: struct.starts as number[],
      lineWidths: struct.widths as number[],
      lineSources: struct.sources as number[],
      lineWraps: struct.wraps as number[],
    }
  }

  public editorViewGetLogicalLineInfo(view: Pointer): LineInfo {
    const outBuffer = new ArrayBuffer(LineInfoStruct.size)
    this.opentui.symbols.editorViewGetLogicalLineInfoDirect(view, ptr(outBuffer))
    const struct = LineInfoStruct.unpack(outBuffer)
    return {
      maxLineWidth: struct.maxWidth,
      lineStarts: struct.starts as number[],
      lineWidths: struct.widths as number[],
      lineSources: struct.sources as number[],
      lineWraps: struct.wraps as number[],
    }
  }

  // EditBuffer implementations
  public createEditBuffer(widthMethod: WidthMethod): Pointer {
    const widthMethodCode = widthMethod === "wcwidth" ? 0 : 1
    const bufferPtr = this.opentui.symbols.createEditBuffer(widthMethodCode)
    if (!bufferPtr) {
      throw new Error("Failed to create EditBuffer")
    }
    return bufferPtr
  }

  public destroyEditBuffer(buffer: Pointer): void {
    this.opentui.symbols.destroyEditBuffer(buffer)
  }

  public editBufferSetText(buffer: Pointer, textBytes: Uint8Array): void {
    this.opentui.symbols.editBufferSetText(buffer, textBytes, textBytes.length)
  }

  public editBufferSetTextFromMem(buffer: Pointer, memId: number): void {
    this.opentui.symbols.editBufferSetTextFromMem(buffer, memId)
  }

  public editBufferReplaceText(buffer: Pointer, textBytes: Uint8Array): void {
    this.opentui.symbols.editBufferReplaceText(buffer, textBytes, textBytes.length)
  }

  public editBufferReplaceTextFromMem(buffer: Pointer, memId: number): void {
    this.opentui.symbols.editBufferReplaceTextFromMem(buffer, memId)
  }

  public editBufferGetText(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editBufferGetText(buffer, ptr(outBuffer), maxLength)
    const len = typeof actualLen === "bigint" ? Number(actualLen) : actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editBufferInsertChar(buffer: Pointer, char: string): void {
    const charBytes = this.encoder.encode(char)
    this.opentui.symbols.editBufferInsertChar(buffer, charBytes, charBytes.length)
  }

  public editBufferInsertText(buffer: Pointer, text: string): void {
    const textBytes = this.encoder.encode(text)
    this.opentui.symbols.editBufferInsertText(buffer, textBytes, textBytes.length)
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

  public editBufferGetTextBuffer(buffer: Pointer): Pointer {
    const result = this.opentui.symbols.editBufferGetTextBuffer(buffer)
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
    const actualLen = this.opentui.symbols.editBufferUndo(buffer, ptr(outBuffer), maxLength)
    const len = typeof actualLen === "bigint" ? Number(actualLen) : actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editBufferRedo(buffer: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editBufferRedo(buffer, ptr(outBuffer), maxLength)
    const len = typeof actualLen === "bigint" ? Number(actualLen) : actualLen
    if (len === 0) return null
    return outBuffer.slice(0, len)
  }

  public editBufferCanUndo(buffer: Pointer): boolean {
    return this.opentui.symbols.editBufferCanUndo(buffer)
  }

  public editBufferCanRedo(buffer: Pointer): boolean {
    return this.opentui.symbols.editBufferCanRedo(buffer)
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
      ptr(outBuffer),
      maxLength,
    )
    const len = typeof actualLen === "bigint" ? Number(actualLen) : actualLen
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
      ptr(outBuffer),
      maxLength,
    )
    const len = typeof actualLen === "bigint" ? Number(actualLen) : actualLen
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
    const bg = bgColor ? bgColor.buffer : null
    const fg = fgColor ? fgColor.buffer : null
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
  ): boolean {
    const bg = bgColor ? bgColor.buffer : null
    const fg = fgColor ? fgColor.buffer : null
    return this.opentui.symbols.editorViewSetLocalSelection(
      view,
      anchorX,
      anchorY,
      focusX,
      focusY,
      bg,
      fg,
      updateCursor,
    )
  }

  public editorViewUpdateSelection(view: Pointer, end: number, bgColor: RGBA | null, fgColor: RGBA | null): void {
    const bg = bgColor ? bgColor.buffer : null
    const fg = fgColor ? fgColor.buffer : null
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
  ): boolean {
    const bg = bgColor ? bgColor.buffer : null
    const fg = fgColor ? fgColor.buffer : null
    return this.opentui.symbols.editorViewUpdateLocalSelection(
      view,
      anchorX,
      anchorY,
      focusX,
      focusY,
      bg,
      fg,
      updateCursor,
    )
  }

  public editorViewResetLocalSelection(view: Pointer): void {
    this.opentui.symbols.editorViewResetLocalSelection(view)
  }

  public editorViewGetSelectedTextBytes(view: Pointer, maxLength: number): Uint8Array | null {
    const outBuffer = new Uint8Array(maxLength)
    const actualLen = this.opentui.symbols.editorViewGetSelectedTextBytes(view, ptr(outBuffer), maxLength)
    const len = typeof actualLen === "bigint" ? Number(actualLen) : actualLen
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
    const actualLen = this.opentui.symbols.editorViewGetText(view, ptr(outBuffer), maxLength)
    const len = typeof actualLen === "bigint" ? Number(actualLen) : actualLen
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

  public getTerminalCapabilities(renderer: Pointer) {
    const capsBuffer = new ArrayBuffer(TerminalCapabilitiesStruct.size)
    this.opentui.symbols.getTerminalCapabilities(renderer, ptr(capsBuffer))

    const caps = TerminalCapabilitiesStruct.unpack(capsBuffer)

    return {
      kitty_keyboard: caps.kitty_keyboard,
      kitty_graphics: caps.kitty_graphics,
      rgb: caps.rgb,
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
      terminal: {
        name: caps.term_name ?? "",
        version: caps.term_version ?? "",
        from_xtversion: caps.term_from_xtversion,
      },
    }
  }

  public processCapabilityResponse(renderer: Pointer, response: string): void {
    const responseBytes = this.encoder.encode(response)
    this.opentui.symbols.processCapabilityResponse(renderer, responseBytes, responseBytes.length)
  }

  public encodeUnicode(
    text: string,
    widthMethod: WidthMethod,
  ): { ptr: Pointer; data: Array<{ width: number; char: number }> } | null {
    const textBytes = this.encoder.encode(text)
    const widthMethodCode = widthMethod === "wcwidth" ? 0 : 1

    const outPtrBuffer = new ArrayBuffer(8) // Pointer size
    const outLenBuffer = new ArrayBuffer(8) // usize

    const success = this.opentui.symbols.encodeUnicode(
      textBytes,
      textBytes.length,
      ptr(outPtrBuffer),
      ptr(outLenBuffer),
      widthMethodCode,
    )

    if (!success) {
      return null
    }

    const outPtrView = new BigUint64Array(outPtrBuffer)
    const outLenView = new BigUint64Array(outLenBuffer)

    const resultPtr = Number(outPtrView[0]) as Pointer
    const resultLen = Number(outLenView[0])

    if (resultLen === 0) {
      return { ptr: resultPtr, data: [] }
    }

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
    this.opentui.symbols.bufferDrawChar(buffer, char, x, y, fg.buffer, bg.buffer, attributes)
  }

  public createSyntaxStyle(): Pointer {
    const stylePtr = this.opentui.symbols.createSyntaxStyle()
    if (!stylePtr) {
      throw new Error("Failed to create SyntaxStyle")
    }
    return stylePtr
  }

  public destroySyntaxStyle(style: Pointer): void {
    this.opentui.symbols.destroySyntaxStyle(style)
  }

  public syntaxStyleRegister(
    style: Pointer,
    name: string,
    fg: RGBA | null,
    bg: RGBA | null,
    attributes: number,
  ): number {
    const nameBytes = this.encoder.encode(name)
    const fgPtr = fg ? fg.buffer : null
    const bgPtr = bg ? bg.buffer : null
    return this.opentui.symbols.syntaxStyleRegister(style, nameBytes, nameBytes.length, fgPtr, bgPtr, attributes)
  }

  public syntaxStyleResolveByName(style: Pointer, name: string): number | null {
    const nameBytes = this.encoder.encode(name)
    const id = this.opentui.symbols.syntaxStyleResolveByName(style, nameBytes, nameBytes.length)
    return id === 0 ? null : id
  }

  public syntaxStyleGetStyleCount(style: Pointer): number {
    const result = this.opentui.symbols.syntaxStyleGetStyleCount(style)
    return typeof result === "bigint" ? Number(result) : result
  }

  public editorViewSetPlaceholderStyledText(
    view: Pointer,
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

  public editorViewSetTabIndicator(view: Pointer, indicator: number): void {
    this.opentui.symbols.editorViewSetTabIndicator(view, indicator)
  }

  public editorViewSetTabIndicatorColor(view: Pointer, color: RGBA): void {
    this.opentui.symbols.editorViewSetTabIndicatorColor(view, color.buffer)
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

export function setRenderLibPath(libPath: string) {
  if (opentuiLibPath !== libPath) {
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
  return opentuiLib
}

// Try eager loading
try {
  opentuiLib = new FFIRenderLib(opentuiLibPath)
} catch (error) {}
