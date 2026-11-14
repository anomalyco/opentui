import { Buffer } from "node:buffer"

import { CliRenderEvents, type CliRendererFrameEvent } from "../renderer.js"
import type { TestRendererSetup, TestVisualIdleOptions } from "./test-renderer.js"

export const TEST_SESSION_RECORDING_VERSION = 1 as const

export type RecordedTestSessionVersion = typeof TEST_SESSION_RECORDING_VERSION
export type CapturedSessionSpans = ReturnType<TestRendererSetup["captureSpans"]>

export interface RecordedTestSessionMetadata {
  name?: string
  tags?: string[]
  source?: string
  [key: string]: unknown
}

export interface RecordedSessionBaseStep {
  timestamp: number
}

export interface RecordedSessionInputStep extends RecordedSessionBaseStep {
  type: "stdin"
  dataBase64: string
  dataText?: string
}

export interface RecordedSessionResizeStep extends RecordedSessionBaseStep {
  type: "resize"
  width: number
  height: number
}

export interface RecordedSessionWaitStep extends RecordedSessionBaseStep {
  type: "wait"
  kind: "flush" | "visual-idle"
  options?: TestVisualIdleOptions
}

export interface RecordedSessionFrameStep extends RecordedSessionBaseStep {
  type: "frame"
  frame: string
  frameNumber: number
  frameId?: number
  spans?: CapturedSessionSpans
}

export interface RecordedSessionCheckpointStep extends RecordedSessionBaseStep {
  type: "checkpoint"
  name?: string
  frame: string
  frameNumber: number
  spans?: CapturedSessionSpans
}

export interface RecordedSessionNoteStep extends RecordedSessionBaseStep {
  type: "note"
  message: string
}

export type RecordedSessionStep =
  | RecordedSessionInputStep
  | RecordedSessionResizeStep
  | RecordedSessionWaitStep
  | RecordedSessionFrameStep
  | RecordedSessionCheckpointStep
  | RecordedSessionNoteStep

export interface RecordedTestSession {
  version: RecordedTestSessionVersion
  width: number
  height: number
  duration: number
  steps: RecordedSessionStep[]
  metadata?: RecordedTestSessionMetadata
  finalFrame: string
  finalSpans?: CapturedSessionSpans
}

export interface TestSessionRecorderOptions {
  metadata?: RecordedTestSessionMetadata
  recordFrames?: boolean
  recordSpans?: boolean
  frameLimit?: number
  now?: () => number
}

export interface TestSessionRecorderStartOptions {
  clear?: boolean
}

export interface ReplayTestSessionOptions {
  flushAfterInput?: boolean
  flushAfterResize?: boolean
  flushAtEnd?: boolean
  assertCheckpoints?: boolean
  onStep?: (step: RecordedSessionStep, index: number) => void | Promise<void>
}

export interface ReplayTestSessionResult {
  finalFrame: string
  checkedCheckpoints: number
  replayedSteps: number
}

export interface ExportReplayTestOptions {
  testName?: string
  importPath?: string
  setupCode?: string
  assertFinalFrame?: boolean
  assertCheckpoints?: boolean
  flushAfterInput?: boolean
  flushAfterResize?: boolean
}

type RendererStdin = TestRendererSetup["renderer"]["stdin"] & {
  emit(eventName: string | symbol, ...args: unknown[]): boolean
}

type RendererWithEvents = TestRendererSetup["renderer"] & {
  on(eventName: string | symbol, listener: (...args: unknown[]) => void): TestRendererSetup["renderer"]
  off(eventName: string | symbol, listener: (...args: unknown[]) => void): TestRendererSetup["renderer"]
  once(eventName: string | symbol, listener: (...args: unknown[]) => void): TestRendererSetup["renderer"]
}

type ResizeFn = TestRendererSetup["resize"]

const DEFAULT_EXPORT_IMPORT_PATH = "@opentui/core/testing"

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error("frameLimit must be a non-negative finite number")
  }

  return Math.floor(value)
}

function normalizeInputData(data: unknown): Buffer | undefined {
  if (typeof data === "string") {
    return Buffer.from(data)
  }

  if (Buffer.isBuffer(data)) {
    return Buffer.from(data)
  }

  if (data instanceof Uint8Array) {
    return Buffer.from(data)
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data)
  }

  return undefined
}

function cloneStep(step: RecordedSessionStep): RecordedSessionStep {
  return structuredClone(step)
}

function cloneMetadata(metadata: RecordedTestSessionMetadata | undefined): RecordedTestSessionMetadata | undefined {
  return metadata ? structuredClone(metadata) : undefined
}

function cloneSpans(spans: CapturedSessionSpans | undefined): CapturedSessionSpans | undefined {
  return spans ? structuredClone(spans) : undefined
}

async function drainImmediateWork(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => process.nextTick(resolve))
  await Promise.resolve()
}

function countActionSteps(steps: RecordedSessionStep[]): number {
  return steps.filter((step) => step.type === "stdin" || step.type === "resize" || step.type === "wait").length
}

function createCheckpointError(name: string | undefined, expected: string, actual: string): Error {
  const label = name ? ` "${name}"` : ""
  return new Error(
    [
      `Recorded checkpoint${label} did not match replayed frame.`,
      "",
      "Expected:",
      expected,
      "",
      "Actual:",
      actual,
    ].join("\n"),
  )
}

export class TestSessionRecorder {
  private readonly setup: TestRendererSetup
  private readonly metadata: RecordedTestSessionMetadata | undefined
  private readonly recordFrames: boolean
  private readonly recordSpans: boolean
  private readonly frameLimit: number | undefined
  private readonly now: () => number
  private readonly stepsInternal: RecordedSessionStep[] = []
  private recording = false
  private startTime: number | undefined
  private duration = 0
  private frameNumber = 0
  private initialWidth: number | undefined
  private initialHeight: number | undefined
  private finalFrame: string | undefined
  private finalSpans: CapturedSessionSpans | undefined
  private originalStdinEmit: RendererStdin["emit"] | undefined
  private originalResize: ResizeFn | undefined
  private patchedStdin: RendererStdin | undefined

  private readonly onFrame = (event: CliRendererFrameEvent): void => {
    if (!this.recording || !this.recordFrames) {
      return
    }

    if (this.frameLimit !== undefined && this.frameNumber >= this.frameLimit) {
      return
    }

    this.stepsInternal.push({
      type: "frame",
      timestamp: this.elapsed(),
      frame: this.setup.captureCharFrame(),
      frameNumber: this.frameNumber++,
      frameId: event.frameId,
      spans: this.recordSpans ? this.setup.captureSpans() : undefined,
    })
  }

  private readonly onDestroy = (): void => {
    this.stop()
  }

  public constructor(setup: TestRendererSetup, options: TestSessionRecorderOptions = {}) {
    this.setup = setup
    this.metadata = cloneMetadata(options.metadata)
    this.recordFrames = options.recordFrames ?? true
    this.recordSpans = options.recordSpans ?? false
    this.frameLimit = normalizePositiveInteger(options.frameLimit)
    this.now = options.now ?? (() => performance.now())
  }

  public start(options: TestSessionRecorderStartOptions = {}): void {
    if (this.recording) {
      return
    }

    if (options.clear ?? true) {
      this.clear()
    }

    this.initialWidth = this.setup.renderer.width
    this.initialHeight = this.setup.renderer.height
    this.startTime = this.now()
    this.duration = 0
    this.recording = true
    this.patchStdin()
    this.patchResize()

    const renderer = this.setup.renderer as RendererWithEvents
    if (this.recordFrames) {
      renderer.on(CliRenderEvents.FRAME, this.onFrame as (...args: unknown[]) => void)
    }
    renderer.once(CliRenderEvents.DESTROY, this.onDestroy)
  }

  public stop(): void {
    if (!this.recording) {
      return
    }

    this.duration = this.elapsed()
    this.recording = false
    this.finalFrame = this.setup.captureCharFrame()
    this.finalSpans = this.recordSpans ? this.setup.captureSpans() : undefined

    const renderer = this.setup.renderer as RendererWithEvents
    renderer.off(CliRenderEvents.FRAME, this.onFrame as (...args: unknown[]) => void)
    renderer.off(CliRenderEvents.DESTROY, this.onDestroy)

    this.restorePatches()
  }

  public clear(): void {
    this.stepsInternal.length = 0
    this.duration = 0
    this.frameNumber = 0
    this.finalFrame = undefined
    this.finalSpans = undefined
  }

  public get isRecording(): boolean {
    return this.recording
  }

  public get steps(): RecordedSessionStep[] {
    return this.stepsInternal.map(cloneStep)
  }

  public get session(): RecordedTestSession {
    return this.toSession()
  }

  public checkpoint(name?: string): RecordedSessionCheckpointStep {
    const step: RecordedSessionCheckpointStep = {
      type: "checkpoint",
      timestamp: this.elapsed(),
      name,
      frame: this.setup.captureCharFrame(),
      frameNumber: this.frameNumber++,
      spans: this.recordSpans ? this.setup.captureSpans() : undefined,
    }

    if (this.recording) {
      this.stepsInternal.push(step)
    }

    return cloneStep(step) as RecordedSessionCheckpointStep
  }

  public note(message: string): void {
    if (!this.recording) {
      return
    }

    this.stepsInternal.push({
      type: "note",
      timestamp: this.elapsed(),
      message,
    })
  }

  public resize(width: number, height: number): void {
    this.setup.resize(width, height)
  }

  public async flush(): Promise<void> {
    if (this.recording) {
      this.stepsInternal.push({
        type: "wait",
        timestamp: this.elapsed(),
        kind: "flush",
      })
    }

    await this.setup.flush()
  }

  public async waitForVisualIdle(options?: TestVisualIdleOptions): Promise<void> {
    if (this.recording) {
      this.stepsInternal.push({
        type: "wait",
        timestamp: this.elapsed(),
        kind: "visual-idle",
        options: options ? structuredClone(options) : undefined,
      })
    }

    await this.setup.waitForVisualIdle(options)
  }

  public toSession(): RecordedTestSession {
    const finalFrame = this.finalFrame ?? this.setup.captureCharFrame()
    const finalSpans = this.finalSpans ?? (this.recordSpans ? this.setup.captureSpans() : undefined)

    return {
      version: TEST_SESSION_RECORDING_VERSION,
      width: this.initialWidth ?? this.setup.renderer.width,
      height: this.initialHeight ?? this.setup.renderer.height,
      duration: this.recording ? this.elapsed() : this.duration,
      steps: this.stepsInternal.map(cloneStep),
      metadata: cloneMetadata(this.metadata),
      finalFrame,
      finalSpans: cloneSpans(finalSpans),
    }
  }

  public exportReplayTest(options: ExportReplayTestOptions = {}): string {
    return exportReplayTest(this.toSession(), options)
  }

  private patchStdin(): void {
    const stdin = this.setup.renderer.stdin as RendererStdin
    if (this.originalStdinEmit) {
      return
    }

    const recorder = this
    this.patchedStdin = stdin
    this.originalStdinEmit = stdin.emit

    stdin.emit = function patchedEmit(this: RendererStdin, eventName: string | symbol, ...args: unknown[]): boolean {
      if (recorder.recording && eventName === "data") {
        const bytes = normalizeInputData(args[0])
        if (bytes) {
          recorder.stepsInternal.push({
            type: "stdin",
            timestamp: recorder.elapsed(),
            dataBase64: bytes.toString("base64"),
            dataText: bytes.toString("utf8"),
          })
        }
      }

      return recorder.originalStdinEmit!.call(this, eventName, ...args)
    } as RendererStdin["emit"]
  }

  private patchResize(): void {
    if (this.originalResize) {
      return
    }

    const recorder = this
    this.originalResize = this.setup.resize
    this.setup.resize = ((width: number, height: number): void => {
      if (recorder.recording) {
        recorder.stepsInternal.push({
          type: "resize",
          timestamp: recorder.elapsed(),
          width,
          height,
        })
      }

      recorder.originalResize!(width, height)
    }) as ResizeFn
  }

  private restorePatches(): void {
    if (this.originalStdinEmit && this.patchedStdin) {
      this.patchedStdin.emit = this.originalStdinEmit
      this.originalStdinEmit = undefined
      this.patchedStdin = undefined
    }

    if (this.originalResize) {
      this.setup.resize = this.originalResize
      this.originalResize = undefined
    }
  }

  private elapsed(): number {
    if (this.startTime === undefined) {
      return 0
    }

    return Math.max(0, this.now() - this.startTime)
  }
}

export async function replayTestSession(
  session: RecordedTestSession,
  setup: TestRendererSetup,
  options: ReplayTestSessionOptions = {},
): Promise<ReplayTestSessionResult> {
  if (session.version !== TEST_SESSION_RECORDING_VERSION) {
    throw new Error(`Unsupported OpenTUI test session recording version: ${session.version}`)
  }

  const flushAfterInput = options.flushAfterInput ?? false
  const flushAfterResize = options.flushAfterResize ?? true
  const flushAtEnd = options.flushAtEnd ?? true
  let checkedCheckpoints = 0

  for (let index = 0; index < session.steps.length; index++) {
    const step = session.steps[index]
    await options.onStep?.(step, index)

    switch (step.type) {
      case "stdin": {
        const bytes = Buffer.from(step.dataBase64, "base64")
        setup.renderer.stdin.emit("data", bytes)
        await drainImmediateWork()
        if (flushAfterInput) {
          await setup.flush()
        }
        break
      }
      case "resize": {
        setup.resize(step.width, step.height)
        await drainImmediateWork()
        if (flushAfterResize) {
          await setup.flush()
        }
        break
      }
      case "wait": {
        if (step.kind === "flush") {
          await setup.flush()
        } else {
          await setup.waitForVisualIdle(step.options)
        }
        break
      }
      case "checkpoint": {
        if (options.assertCheckpoints) {
          await setup.flush()
          const actual = setup.captureCharFrame()
          if (actual !== step.frame) {
            throw createCheckpointError(step.name, step.frame, actual)
          }
          checkedCheckpoints++
        }
        break
      }
      case "frame":
      case "note": {
        break
      }
    }
  }

  if (flushAtEnd) {
    await setup.flush()
  }

  return {
    finalFrame: setup.captureCharFrame(),
    checkedCheckpoints,
    replayedSteps: countActionSteps(session.steps),
  }
}

export function exportReplayTest(session: RecordedTestSession, options: ExportReplayTestOptions = {}): string {
  const testName = options.testName ?? session.metadata?.name ?? "replays recorded OpenTUI session"
  const importPath = options.importPath ?? DEFAULT_EXPORT_IMPORT_PATH
  const assertFinalFrame = options.assertFinalFrame ?? true
  const assertCheckpoints = options.assertCheckpoints ?? false
  const setupCode =
    options.setupCode ?? "  // TODO: mount your app/renderables under test before replaying the session.\n"
  const replayOptions = {
    assertCheckpoints,
    flushAfterInput: options.flushAfterInput,
    flushAfterResize: options.flushAfterResize,
  }
  const definedReplayOptions = Object.fromEntries(
    Object.entries(replayOptions).filter(([, value]) => value !== undefined && value !== false),
  )
  const replayOptionsText = JSON.stringify(definedReplayOptions, null, 2)
  const replayCall =
    replayOptionsText === "{}"
      ? "await replayTestSession(session, setup)"
      : `await replayTestSession(session, setup, ${replayOptionsText.replace(/\n/g, "\n    ")})`
  const finalAssertion = assertFinalFrame ? "    expect(setup.captureCharFrame()).toBe(session.finalFrame)\n" : ""
  const bunImport = assertFinalFrame ? 'import { test, expect } from "bun:test"' : 'import { test } from "bun:test"'

  return `${bunImport}
import { createTestRenderer, replayTestSession, type RecordedTestSession } from "${importPath}"

const session = ${JSON.stringify(session, null, 2)} satisfies RecordedTestSession

test(${JSON.stringify(testName)}, async () => {
  const setup = await createTestRenderer({ width: session.width, height: session.height })
  try {
${setupCode}${setupCode.endsWith("\n") ? "" : "\n"}    ${replayCall}
${finalAssertion}  } finally {
    setup.renderer.destroy()
  }
})
`
}
