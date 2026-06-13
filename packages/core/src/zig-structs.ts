import { defineStruct, defineEnum } from "bun-ffi-structs"
import { ptr, toArrayBuffer, type Pointer } from "./platform/ffi.js"
import { RGBA, normalizeColorValue } from "./lib/RGBA.js"

const rgbaPackTransform = (rgba?: RGBA) => (rgba ? ptr(rgba.buffer) : null)
const rgbaUnpackTransform = (ptr?: Pointer) =>
  ptr ? RGBA.fromArray(new Uint16Array(toArrayBuffer(ptr, 0, 8))) : undefined

type StyledChunkInput = {
  text: string
  fg?: RGBA | null
  bg?: RGBA | null
  attributes?: number | null
  link?: { url: string } | string | null
}

export const StyledChunkStruct = defineStruct(
  [
    ["text", "char*"],
    ["text_len", "u64", { lengthOf: "text" }],
    [
      "fg",
      "pointer",
      {
        optional: true,
        packTransform: rgbaPackTransform,
        unpackTransform: rgbaUnpackTransform,
      },
    ],
    [
      "bg",
      "pointer",
      {
        optional: true,
        packTransform: rgbaPackTransform,
        unpackTransform: rgbaUnpackTransform,
      },
    ],
    ["attributes", "u32", { default: 0 }],
    ["link", "char*", { default: "" }],
    ["link_len", "u64", { lengthOf: "link" }],
  ],
  {
    mapValue: (chunk: StyledChunkInput): StyledChunkInput => {
      const normalizedFg = normalizeColorValue(chunk.fg ?? null)
      const normalizedBg = normalizeColorValue(chunk.bg ?? null)

      if (!chunk.link || typeof chunk.link === "string") {
        return {
          ...chunk,
          fg: normalizedFg?.rgba ?? null,
          bg: normalizedBg?.rgba ?? null,
        }
      }

      return {
        ...chunk,
        fg: normalizedFg?.rgba ?? null,
        bg: normalizedBg?.rgba ?? null,
        link: chunk.link.url,
      }
    },
  },
)

export const HighlightStruct = defineStruct([
  ["start", "u32"],
  ["end", "u32"],
  ["styleId", "u32"],
  ["priority", "u8", { default: 0 }],
  ["hlRef", "u16", { default: 0 }],
])

export const LogicalCursorStruct = defineStruct([
  ["row", "u32"],
  ["col", "u32"],
  ["offset", "u32"],
])

export const VisualCursorStruct = defineStruct([
  ["visualRow", "u32"],
  ["visualCol", "u32"],
  ["logicalRow", "u32"],
  ["logicalCol", "u32"],
  ["offset", "u32"],
])

const UnicodeMethodEnum = defineEnum({ wcwidth: 0, unicode: 1 }, "u8")
const TerminalMultiplexerEnum = defineEnum({ none: 0, tmux: 1, zellij: 2, screen: 3, unknown: 4 }, "u8")

export const TerminalCapabilitiesStruct = defineStruct([
  ["kitty_keyboard", "bool_u8"],
  ["kitty_graphics", "bool_u8"],
  ["rgb", "bool_u8"],
  ["ansi256", "bool_u8"],
  ["unicode", UnicodeMethodEnum],
  ["sgr_pixels", "bool_u8"],
  ["color_scheme_updates", "bool_u8"],
  ["explicit_width", "bool_u8"],
  ["scaled_text", "bool_u8"],
  ["sixel", "bool_u8"],
  ["focus_tracking", "bool_u8"],
  ["sync", "bool_u8"],
  ["bracketed_paste", "bool_u8"],
  ["hyperlinks", "bool_u8"],
  ["osc52", "bool_u8"],
  ["notifications", "bool_u8"],
  ["explicit_cursor_positioning", "bool_u8"],
  ["remote", "bool_u8"],
  ["multiplexer", TerminalMultiplexerEnum],
  ["term_name", "char*"],
  ["term_name_len", "u64", { lengthOf: "term_name" }],
  ["term_version", "char*"],
  ["term_version_len", "u64", { lengthOf: "term_version" }],
  ["term_from_xtversion", "bool_u8"],
])

export const EncodedCharStruct = defineStruct([
  ["width", "u8"],
  ["char", "u32"],
])

export const LineInfoStruct = defineStruct([
  ["startCols", ["u32"]],
  ["startColsLen", "u32", { lengthOf: "startCols" }],
  ["widthCols", ["u32"]],
  ["widthColsLen", "u32", { lengthOf: "widthCols" }],
  ["sources", ["u32"]],
  ["sourcesLen", "u32", { lengthOf: "sources" }],
  ["wraps", ["u32"]],
  ["wrapsLen", "u32", { lengthOf: "wraps" }],
  ["widthColsMax", "u32"],
])

export const MeasureResultStruct = defineStruct([
  ["lineCount", "u32"],
  ["widthColsMax", "u32"],
])

export const CursorStateStruct = defineStruct([
  ["x", "u32"],
  ["y", "u32"],
  ["visible", "bool_u8"],
  ["style", "u8"],
  ["blinking", "bool_u8"],
  ["r", "f32"],
  ["g", "f32"],
  ["b", "f32"],
  ["a", "f32"],
])

export const CursorStyleOptionsStruct = defineStruct([
  ["style", "u8", { default: 255 }],
  ["blinking", "u8", { default: 255 }],
  [
    "color",
    "pointer",
    {
      optional: true,
      packTransform: rgbaPackTransform,
      unpackTransform: rgbaUnpackTransform,
    },
  ],
  ["cursor", "u8", { default: 255 }],
])

export const GridDrawOptionsStruct = defineStruct([
  ["drawInner", "bool_u8", { default: true }],
  ["drawOuter", "bool_u8", { default: true }],
])

export type BuildOptions = {
  gpaSafeStats: boolean
  gpaMemoryLimitTracking: boolean
}

export const BuildOptionsStruct = defineStruct([
  ["gpaSafeStats", "bool_u8"],
  ["gpaMemoryLimitTracking", "bool_u8"],
])

export type AllocatorStats = {
  totalRequestedBytes: number
  activeAllocations: number
  smallAllocations: number
  largeAllocations: number
  requestedBytesValid: boolean
}

export const AllocatorStatsStruct = defineStruct([
  ["totalRequestedBytes", "u64"],
  ["activeAllocations", "u64"],
  ["smallAllocations", "u64"],
  ["largeAllocations", "u64"],
  ["requestedBytesValid", "bool_u8"],
])

export type NativeRenderStats = {
  nativeLastFrameTime: number
  nativeAverageFrameTime: number
  nativeFrameCount: number
  cellsUpdated: number
  averageCellsUpdated: number
  nativeRenderTime?: number
  nativeStdoutWriteTime?: number
}

export const NativeRenderStatsStruct = defineStruct([
  ["lastFrameTime", "f64"],
  ["averageFrameTime", "f64"],
  ["renderTime", "f64"],
  ["stdoutWriteTime", "f64"],
  ["frameCount", "u64"],
  ["cellsUpdated", "u32"],
  ["averageCellsUpdated", "u32"],
  ["renderTimeValid", "bool_u8"],
  ["stdoutWriteTimeValid", "bool_u8"],
])

export type GrowthPolicy = "grow" | "block"

export type NativeSpanFeedOptions = {
  chunkSize?: number
  initialChunks?: number
  maxBytes?: bigint
  growthPolicy?: GrowthPolicy
  autoCommitOnFull?: boolean
  spanQueueCapacity?: number
}

export type NativeSpanFeedStats = {
  bytesWritten: bigint
  spansCommitted: bigint
  chunks: number
  pendingSpans: number
}

export type SpanInfo = {
  chunkPtr: Pointer
  offset: number
  len: number
  chunkIndex: number
}

export type ReserveInfo = {
  ptr: Pointer
  len: number
}

const GrowthPolicyEnum = defineEnum({ grow: 0, block: 1 }, "u8")

export const NativeSpanFeedOptionsStruct = defineStruct([
  ["chunkSize", "u32", { default: 64 * 1024 }],
  ["initialChunks", "u32", { default: 2 }],
  ["maxBytes", "u64", { default: 0n }],
  ["growthPolicy", GrowthPolicyEnum, { default: "grow" }],
  ["autoCommitOnFull", "bool_u8", { default: true }],
  ["spanQueueCapacity", "u32", { default: 0 }],
])

export const NativeSpanFeedStatsStruct = defineStruct([
  ["bytesWritten", "u64"],
  ["spansCommitted", "u64"],
  ["chunks", "u32"],
  ["pendingSpans", "u32"],
])

export const SpanInfoStruct = defineStruct(
  [
    ["chunkPtr", "pointer"],
    ["offset", "u32"],
    ["len", "u32"],
    ["chunkIndex", "u32"],
    ["reserved", "u32", { default: 0 }],
  ],
  {
    reduceValue: (value: { chunkPtr: Pointer; offset: number; len: number; chunkIndex: number }) => ({
      chunkPtr: value.chunkPtr as Pointer,
      offset: value.offset,
      len: value.len,
      chunkIndex: value.chunkIndex,
    }),
  },
)

export const ReserveInfoStruct = defineStruct(
  [
    ["ptr", "pointer"],
    ["len", "u32"],
    ["reserved", "u32", { default: 0 }],
  ],
  {
    reduceValue: (value: { ptr: Pointer; len: number }) => ({
      ptr: value.ptr as Pointer,
      len: value.len,
    }),
  },
)

export type AudioCreateOptions = {
  sampleRate?: number
  playbackChannels?: number
}

export type AudioStartOptions = {
  periodSizeInFrames?: number
  periodSizeInMilliseconds?: number
  periods?: number
  performanceProfile?: number
  shareMode?: number
  noPreSilencedOutputBuffer?: boolean
  noClip?: boolean
  noDisableDenormals?: boolean
  noFixedSizedCallback?: boolean
  wasapiNoAutoConvertSrc?: boolean
  wasapiNoDefaultQualitySrc?: boolean
  alsaNoMMap?: boolean
  alsaNoAutoFormat?: boolean
  alsaNoAutoChannels?: boolean
  alsaNoAutoResample?: boolean
}

export type AudioVoiceOptions = {
  volume?: number
  pan?: number
  loop?: boolean
  groupId?: number
}

export type AudioStats = {
  soundsLoaded: number
  voicesActive: number
  framesMixed: bigint
  lockMisses: number
  lastPeak: number
  lastRms: number
}

export const AudioCreateOptionsStruct = defineStruct([
  ["sampleRate", "u32", { default: 48_000 }],
  ["playbackChannels", "u32", { default: 2 }],
])

export const AudioStartOptionsStruct = defineStruct([
  ["periodSizeInFrames", "u32", { default: 0 }],
  ["periodSizeInMilliseconds", "u32", { default: 0 }],
  ["periods", "u32", { default: 0 }],
  ["performanceProfile", "u8", { default: 0 }],
  ["shareMode", "u8", { default: 0 }],
  ["noPreSilencedOutputBuffer", "bool_u8", { default: false }],
  ["noClip", "bool_u8", { default: false }],
  ["noDisableDenormals", "bool_u8", { default: false }],
  ["noFixedSizedCallback", "bool_u8", { default: false }],
  ["wasapiNoAutoConvertSrc", "bool_u8", { default: false }],
  ["wasapiNoDefaultQualitySrc", "bool_u8", { default: false }],
  ["alsaNoMMap", "bool_u8", { default: false }],
  ["alsaNoAutoFormat", "bool_u8", { default: false }],
  ["alsaNoAutoChannels", "bool_u8", { default: false }],
  ["alsaNoAutoResample", "bool_u8", { default: false }],
])

export const AudioVoiceOptionsStruct = defineStruct([
  ["volume", "f32", { default: 1 }],
  ["pan", "f32", { default: 0 }],
  ["loop", "bool_u8", { default: false }],
  ["groupId", "u32", { default: 0 }],
])

export const AudioStatsStruct = defineStruct([
  ["soundsLoaded", "u32"],
  ["voicesActive", "u32"],
  ["framesMixed", "u64"],
  ["lockMisses", "u32"],
  ["lastPeak", "f32"],
  ["lastRms", "f32"],
])
