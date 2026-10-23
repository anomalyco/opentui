// Testing utilities module exports
export * from "./testing/test-renderer.js"
export * from "./testing/mock-keys.js"
export * from "./testing/mock-mouse.js"
export * from "./testing/mock-tree-sitter-client.js"
export * from "./testing/terminal-capabilities.js"
export * from "./testing/spy.js"
export { ManualClock } from "./testing/manual-clock.js"
export {
  TestRecorder,
  type RecordedBuffers,
  type RecordedFrame,
  type RecordBuffersOptions,
  type TestRecorderOptions,
} from "./testing/test-recorder.js"
export * from "./testing/test-session-recorder.js"
