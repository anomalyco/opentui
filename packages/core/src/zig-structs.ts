import { defineStruct, defineEnum } from "bun-ffi-structs"
import type { Pointer } from "./platform/ffi.js"

export interface NativeImageInfo {
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  format: number
  colorStatus: number
  orientation: number
  hasAlpha: number
}

export const NativeImageInfoStruct = defineStruct([
  ["width", "u32"],
  ["height", "u32"],
  ["sourceWidth", "u32"],
  ["sourceHeight", "u32"],
  ["format", "u32"],
  ["colorStatus", "u32"],
  ["orientation", "u32"],
  ["hasAlpha", "u32"],
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
  outstandingSpans: number
  outstandingBytes: bigint
}

export type SpanInfo = {
  chunkPtr: Pointer
  offset: number
  len: number
  chunkIndex: number
  slotIndex: number
  releaseId: bigint
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
  ["outstandingSpans", "u32"],
  ["reserved", "u32", { default: 0 }],
  ["outstandingBytes", "u64"],
])

export const SpanInfoStruct = defineStruct(
  [
    ["chunkPtr", "pointer"],
    ["offset", "u32"],
    ["len", "u32"],
    ["chunkIndex", "u32"],
    ["slotIndex", "u32", { default: 0 }],
    ["releaseId", "u64", { default: 0n }],
  ],
  {
    reduceValue: (value: SpanInfo) => value,
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

export const NativeAudioStreamFormat = {
  Mp3: 1,
  Flac: 2,
} as const

export type NativeAudioStreamFormat = (typeof NativeAudioStreamFormat)[keyof typeof NativeAudioStreamFormat]

export type AudioStreamCreateOptions = {
  capacityMs: number
  startupMs: number
  resumeMs: number
  volume: number
  pan: number
  groupId: number
  maxProbeBytes: number
  format: NativeAudioStreamFormat
}

export type NativeAudioStreamStats = {
  bytesReceived: bigint
  framesDecoded: bigint
  framesPlayed: bigint
  state: number
  sampleRate: number
  channels: number
  bufferedFrames: number
  capacityFrames: number
  underruns: number
  errorCode: number
  readyGeneration: number
}

export const NativeAudioStreamState = {
  Initializing: 0,
  Buffering: 1,
  Playing: 2,
  Ended: 3,
  Failed: 4,
  Cancelled: 5,
  Reconnecting: 6,
} as const

export type NativeAudioStreamState = (typeof NativeAudioStreamState)[keyof typeof NativeAudioStreamState]

export const NativeAudioStreamStateNames = [
  "initializing",
  "buffering",
  "playing",
  "ended",
  "errored",
  "disposed",
  "reconnecting",
] as const

export const NativeAudioStreamCloseReason = {
  PreserveNativeTerminal: 0,
  TransportError: 1,
  Disposed: 2,
} as const

export type NativeAudioStreamCloseReason =
  (typeof NativeAudioStreamCloseReason)[keyof typeof NativeAudioStreamCloseReason]

export type AudioStats = {
  soundsLoaded: number
  voicesActive: number
  framesMixed: bigint
  lockMisses: number
  lastPeak: number
  lastRms: number
}

export type NativeAudioCaptureStats = {
  framesReceived: bigint
  framesRead: bigint
  framesDropped: bigint
  sampleRate: number
  channels: number
  bufferedFrames: number
  capacityFrames: number
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

export const AudioStreamCreateOptionsStruct = defineStruct([
  ["capacityMs", "u32"],
  ["startupMs", "u32"],
  ["resumeMs", "u32"],
  ["volume", "f32"],
  ["pan", "f32"],
  ["groupId", "u32"],
  // Keep additions at the end so newer JS preserves the previous native prefix during local rebuilds.
  ["maxProbeBytes", "u32"],
  ["format", "u32"],
])

export const AudioStreamStatsStruct = defineStruct([
  ["bytesReceived", "u64"],
  ["framesDecoded", "u64"],
  ["framesPlayed", "u64"],
  ["state", "u32"],
  ["sampleRate", "u32"],
  ["channels", "u32"],
  ["bufferedFrames", "u32"],
  ["capacityFrames", "u32"],
  ["underruns", "u32"],
  ["errorCode", "i32"],
  ["readyGeneration", "u32"],
])

export const AudioCaptureStatsStruct = defineStruct([
  ["framesReceived", "u64"],
  ["framesRead", "u64"],
  ["framesDropped", "u64"],
  ["sampleRate", "u32"],
  ["channels", "u32"],
  ["bufferedFrames", "u32"],
  ["capacityFrames", "u32"],
])

export const AudioStatsStruct = defineStruct([
  ["soundsLoaded", "u32"],
  ["voicesActive", "u32"],
  ["framesMixed", "u64"],
  ["lockMisses", "u32"],
  ["lastPeak", "f32"],
  ["lastRms", "f32"],
])
