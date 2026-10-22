// Core exports without 3D dependencies
export * from "./Renderable.js"
export * from "./types.js"
export * from "./utils.js"
export * from "./buffer.js"
export * from "./session-buffer.js"
export * from "./text-buffer.js"
export * from "./text-buffer-view.js"
export * from "./edit-buffer.js"
export * from "./editor-view.js"
export * from "./syntax-style.js"
export * from "./post/effects.js"
export * from "./post/filters.js"
export * from "./post/matrices.js"
export { Timeline, createTimeline, engine, getTimelineEngine } from "./animation/Timeline.js"
export type { TimelineOptions, AnimationOptions, JSAnimation, EasingFunctions } from "./animation/Timeline.js"
export * from "./lib/index.js"
export * from "./renderer.js"
export * from "./plugins/types.js"
export * from "./plugins/registry.js"
export * from "./plugins/core-slot.js"
export * from "./NativeSpanFeed.js"
export * from "./NativeSession.js"
export * from "./audio.js"
export type { AudioStreamDemuxOutput, AudioStreamDemuxer, AudioStreamDemuxerFactory } from "./audio-stream/demuxer.js"
export { createIcyStreamDemuxer } from "./audio-stream/icy/demuxer.js"
export type { IcyStreamDemuxerOptions } from "./audio-stream/icy/demuxer.js"
export * from "./image.js"
export * from "./renderables/index.js"
// Scene staging and paint recording stay internal: list the public zig.ts names.
export {
  FFIRenderLib,
  LogLevel,
  MAX_LINK_URL_BYTES,
  NATIVE_BUFFER_TEXT_BYTES_MAX,
  NATIVE_EDGE_NONE,
  NATIVE_SESSION_CONTROL_PACKET_BYTES,
  NativeAudioStreamCloseReason,
  NativeAudioStreamFormat,
  NativeAudioStreamState,
  NativeBorder,
  NativeClipboardCancelStatus,
  NativeClipboardCopyStatus,
  NativeClipboardDestroyStatus,
  NativeClipboardOperationStatus,
  NativeClipboardShutdownStatus,
  NativeClipboardStartStatus,
  NativeEditCommand,
  NativeEditEvent,
  NativeEditHighlightOperation,
  NativeEditPositionQuery,
  NativeEditorCommand,
  NativeEditorPositionQuery,
  NativeEditorSelectionOperation,
  NativeEditorStyleMask,
  NativeError,
  NativeSceneFrame,
  NativeSceneHook,
  NativeScenePaintPhase,
  NativeSessionPumpStatus,
  NativeSessionRenderStatus,
  NativeSessionState,
  NativeSessionTerminalPhase,
  NativeStatus,
  NativeTextViewCommand,
  resolveRenderLib,
  setRenderLibPath,
} from "./zig.js"
export type {
  AllocatorStats,
  AudioEngineHandle,
  AudioEngineLib,
  AudioStreamCreateOptions,
  BuildOptions,
  ClipboardOperationHandle,
  ClipboardServiceHandle,
  ContextBufferHandle,
  ContextEditBufferHandle,
  ContextEditorViewHandle,
  ContextEmbeddedTerminalHandle,
  ContextImageHandle,
  ContextImagePixelsHandle,
  ContextObjectHandle,
  ContextSyntaxStyleHandle,
  ContextTextBufferHandle,
  ContextTextBufferViewHandle,
  ContextUnicodeHandle,
  CursorState,
  EmbeddedTerminalCursor,
  EmbeddedTerminalKey,
  EmbeddedTerminalMouse,
  ImageHandle,
  LineInfo,
  LogicalCursor,
  MeasureResult,
  NativeAudioCaptureStats,
  NativeAudioStreamStats,
  NativeBufferDraw,
  NativeBufferGrid,
  NativeBufferStack,
  NativeBufferedOutput,
  NativeContextBufferLease,
  NativeContextBufferOptions,
  NativeContextEditBufferOptions,
  NativeContextHandle,
  NativeContextImageDraw,
  NativeContextOptions,
  NativeDrawingTarget,
  NativeEditBufferInfo,
  NativeEditEventName,
  NativeEditorReplacement,
  NativeEditorSelection,
  NativeEditorStyle,
  NativeEditorViewInfo,
  NativeEditorViewport,
  NativeEncodedStyledText,
  NativeHandle,
  NativeOutputTicket,
  NativeRenderStats,
  NativeSceneArrowOptions,
  NativeSceneBoxDetails,
  NativeSceneEditorOptions,
  NativeSceneFrameOptions,
  NativeSceneFrameRequest,
  NativeSceneLayout,
  NativeScenePaint,
  NativeScenePaintSlot,
  NativeScenePaintUpdate,
  NativeSceneSliderOptions,
  NativeSceneTextMetrics,
  NativeSceneTextOptions,
  NativeSceneTextSelectionOptions,
  NativeSessionBufferLease,
  NativeSessionCapabilities,
  NativeSessionControl,
  NativeSessionCursorOptions,
  NativeSessionKittyImageTransportStatus,
  NativeSessionOptions,
  NativeSessionPumpResult,
  NativeSessionRendererOptions,
  NativeSessionRendererState,
  NativeSessionSplitControl,
  NativeSessionTerminalOptions,
  NativeSpanFeedEventHandler,
  NativeSplitSnapshot,
  NativeTextBufferInfo,
  NativeYogaDirtiedCallback,
  NativeYogaLayout,
  NativeYogaMeasureCallback,
  RenderLib,
  SceneNodeHandle,
  SessionBuffer,
  SessionHandle,
  VisualCursor,
} from "./zig.js"
export * from "./console.js"
export { resolveBundledFilePath } from "./platform/runtime.js"
export * as Yoga from "./yoga.js"
