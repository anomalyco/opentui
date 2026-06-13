import type { TestRenderer } from "./test-renderer.js"
import { CliRenderEvents } from "../renderer.js"

export interface RecordBuffersOptions {
  fg?: boolean
  bg?: boolean
  attributes?: boolean
}

export interface RecordedBuffers {
  fg?: Uint16Array
  bg?: Uint16Array
  attributes?: Uint8Array
}

export interface RecordedFrame {
  frame: string
  timestamp: number
  frameNumber: number
  buffers?: RecordedBuffers
}

export interface TestRecorderOptions {
  recordBuffers?: RecordBuffersOptions
  now?: () => number
}

/**
 * TestRecorder records frames from a TestRenderer by listening to rendered frame events.
 * It captures the character frame after each native render pass.
 */
export class TestRecorder {
  private renderer: TestRenderer
  private frames: RecordedFrame[] = []
  private recording: boolean = false
  private frameNumber: number = 0
  private startTime: number = 0
  private decoder = new TextDecoder()
  private recordBuffers: RecordBuffersOptions
  private now: () => number
  private readonly onFrame = () => {
    if (!this.recording) return
    this.captureFrame()
  }

  constructor(renderer: TestRenderer, options?: TestRecorderOptions) {
    this.renderer = renderer
    this.recordBuffers = options?.recordBuffers || {}
    this.now = options?.now ?? (() => performance.now())
  }

  /**
   * Start recording frames.
   */
  public rec(): void {
    if (this.recording) {
      return
    }

    this.recording = true
    this.frames = []
    this.frameNumber = 0
    this.startTime = this.now()
    this.renderer.on(CliRenderEvents.FRAME, this.onFrame)
  }

  /**
   * Stop recording frames.
   */
  public stop(): void {
    if (!this.recording) {
      return
    }

    this.recording = false
    this.renderer.off(CliRenderEvents.FRAME, this.onFrame)
  }

  /**
   * Get the recorded frames.
   */
  public get recordedFrames(): RecordedFrame[] {
    return [...this.frames]
  }

  /**
   * Clear all recorded frames.
   */
  public clear(): void {
    this.frames = []
    this.frameNumber = 0
  }

  /**
   * Check if currently recording.
   */
  public get isRecording(): boolean {
    return this.recording
  }

  /**
   * Capture the current frame from the renderer's buffer.
   */
  private captureFrame(): void {
    const currentBuffer = this.renderer.currentRenderBuffer
    const frameBytes = currentBuffer.getRealCharBytes(true)
    const frame = this.decoder.decode(frameBytes)

    const recordedFrame: RecordedFrame = {
      frame,
      timestamp: this.now() - this.startTime,
      frameNumber: this.frameNumber++,
    }

    // Optionally record buffer data from currentRenderBuffer
    if (this.recordBuffers.fg || this.recordBuffers.bg || this.recordBuffers.attributes) {
      const buffers = currentBuffer.buffers
      recordedFrame.buffers = {}

      if (this.recordBuffers.fg) {
        recordedFrame.buffers.fg = new Uint16Array(buffers.fg)
      }
      if (this.recordBuffers.bg) {
        recordedFrame.buffers.bg = new Uint16Array(buffers.bg)
      }
      if (this.recordBuffers.attributes) {
        recordedFrame.buffers.attributes = new Uint8Array(buffers.attributes)
      }
    }

    this.frames.push(recordedFrame)
  }
}
