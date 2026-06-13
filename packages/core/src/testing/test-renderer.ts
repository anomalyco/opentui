import {
  CliRenderer,
  CliRenderEvents,
  type CliRendererConfig,
  type CliRendererExternalOutputEvent,
  type CliRendererFrameEvent,
} from "../renderer.js"
import type { NativeSpanFeed } from "../NativeSpanFeed.js"
import type { NativeRenderStats } from "../zig.js"
import { createMockKeys } from "./mock-keys.js"
import { createMockMouse } from "./mock-mouse.js"
import { createTestStdin, createTestStdout } from "./test-streams.js"
import type { CapturedFrame } from "../types.js"

export interface TestRendererOptions extends CliRendererConfig {
  width?: number
  height?: number
  kittyKeyboard?: boolean
  otherModifiersMode?: boolean
}
export type TestRenderer = CliRenderer
export type MockInput = ReturnType<typeof createMockKeys>
export type MockMouse = ReturnType<typeof createMockMouse>

type RendererFeedAccess = {
  _feed?: NativeSpanFeed | null
}

export interface TestFlushOptions {
  maxPasses?: number
}

export interface TestVisualIdleOptions {
  quietFrames?: number
  maxFrames?: number
}

export interface TestWaitForOptions {
  maxPasses?: number
}

export interface TestExternalOutputCommit {
  text: string
  rows: string[]
  width: number
  height: number
  rowColumns: number
  startOnNewLine: boolean
  trailingNewline: boolean
}

export interface TestExternalOutput {
  take(): TestExternalOutputCommit[]
  takeText(): string
  clear(): void
}

export interface TestRendererSetup {
  renderer: TestRenderer
  mockInput: MockInput
  mockMouse: MockMouse
  renderOnce: () => Promise<void>
  flush: (options?: TestFlushOptions) => Promise<void>
  waitFor: (predicate: () => boolean | Promise<boolean>, options?: TestWaitForOptions) => Promise<void>
  waitForFrame: (
    predicate: (frame: string) => boolean | Promise<boolean>,
    options?: TestWaitForOptions,
  ) => Promise<string>
  waitForVisualIdle: (options?: TestVisualIdleOptions) => Promise<void>
  externalOutput: TestExternalOutput
  getNativeStats: () => NativeRenderStats
  captureCharFrame: () => string
  captureSpans: () => CapturedFrame
  resize: (width: number, height: number) => void
}

const decoder = new TextDecoder()
const DEFAULT_MAX_PASSES = 20
const DEFAULT_MAX_VISUAL_IDLE_FRAMES = 20
const DEFAULT_QUIET_FRAMES = 1

async function drainImmediateWork(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => process.nextTick(resolve))
  await Promise.resolve()
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback
  }

  return Math.floor(value)
}

function createWaitError(renderer: TestRenderer, message: string, frame?: string): Error {
  const stats = renderer.getStats()
  const scheduler = renderer.getSchedulerState()
  const details = [
    message,
    `frameId: ${renderer.frameId}`,
    `nativeFrameCount: ${stats.nativeFrameCount}`,
    `cellsUpdated: ${stats.cellsUpdated}`,
    `isRunning: ${scheduler.isRunning}`,
    `isRendering: ${scheduler.isRendering}`,
    `hasScheduledRender: ${scheduler.hasScheduledRender}`,
  ]

  if (frame !== undefined) {
    details.push(`lastFrame:\n${frame}`)
  }

  return new Error(details.join("\n"))
}

class TestExternalOutputRecorder implements TestExternalOutput {
  private commits: TestExternalOutputCommit[] = []

  constructor(renderer: TestRenderer) {
    renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, this.record)
    renderer.once(CliRenderEvents.DESTROY, () => {
      renderer.off(CliRenderEvents.EXTERNAL_OUTPUT, this.record)
    })
  }

  private record = (event: CliRendererExternalOutputEvent): void => {
    const raw = decoder.decode(event.snapshot.getRealCharBytes(false))
    const rows = Array.from({ length: event.snapshot.height }, (_, index) =>
      raw.slice(index * event.snapshot.width, (index + 1) * event.snapshot.width).trimEnd(),
    )

    this.commits.push({
      text: rows.join("\n"),
      rows,
      width: event.snapshot.width,
      height: event.snapshot.height,
      rowColumns: event.rowColumns,
      startOnNewLine: event.startOnNewLine,
      trailingNewline: event.trailingNewline,
    })
  }

  public take(): TestExternalOutputCommit[] {
    const commits = this.commits
    this.commits = []
    return commits
  }

  public takeText(): string {
    return this.take()
      .flatMap((commit) => commit.rows)
      .join("\n")
  }

  public clear(): void {
    this.commits = []
  }
}

function waitForNextFrameOrIdle(renderer: TestRenderer): Promise<CliRendererFrameEvent | null> {
  const scheduler = renderer.getSchedulerState()
  if (!scheduler.isRunning && !scheduler.isRendering && !scheduler.hasScheduledRender) {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    let settled = false

    const cleanup = () => {
      renderer.off(CliRenderEvents.FRAME, onFrame)
      renderer.off(CliRenderEvents.DESTROY, onDestroy)
    }

    const finish = (event: CliRendererFrameEvent | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(event)
    }

    const onFrame = (event: CliRendererFrameEvent) => {
      finish(event)
    }

    const onDestroy = () => {
      finish(null)
    }

    renderer.on(CliRenderEvents.FRAME, onFrame)
    renderer.once(CliRenderEvents.DESTROY, onDestroy)

    if (!scheduler.isRunning) {
      renderer.idle().then(() => finish(null))
    }
  })
}

export async function createTestRenderer(options: TestRendererOptions): Promise<TestRendererSetup> {
  // Convert legacy kittyKeyboard boolean to new format
  const useKittyKeyboard = options.kittyKeyboard ? { events: true } : options.useKittyKeyboard

  const renderer = await setupTestRenderer({
    ...options,
    useKittyKeyboard,
    screenMode: options.screenMode ?? "main-screen",
    footerHeight: options.footerHeight ?? 12,
    consoleMode: options.consoleMode ?? "disabled",
    externalOutputMode: options.externalOutputMode ?? "passthrough",
  })
  const externalOutput = new TestExternalOutputRecorder(renderer)

  const mockInput = createMockKeys(renderer, {
    kittyKeyboard: options.kittyKeyboard,
    otherModifiersMode: options.otherModifiersMode,
  })
  const mockMouse = createMockMouse(renderer)

  const renderOnce = async () => {
    const feed = (renderer as unknown as RendererFeedAccess)._feed
    if (feed?.isBackpressured()) {
      await feed.idle()
    }
    //@ts-expect-error - this is a test renderer
    await renderer.loop()
  }

  const captureCharFrame = () => {
    const currentBuffer = renderer.currentRenderBuffer
    const frameBytes = currentBuffer.getRealCharBytes(true)
    return decoder.decode(frameBytes)
  }

  const waitForVisualIdle = async (waitOptions: TestVisualIdleOptions = {}): Promise<void> => {
    const maxFrames = normalizePositiveInteger(waitOptions.maxFrames, DEFAULT_MAX_VISUAL_IDLE_FRAMES)
    const quietFrames = normalizePositiveInteger(waitOptions.quietFrames, DEFAULT_QUIET_FRAMES)
    let consecutiveQuietFrames = 0

    for (let frame = 0; frame < maxFrames; frame++) {
      await drainImmediateWork()

      const scheduler = renderer.getSchedulerState()
      if (!scheduler.isRunning && !scheduler.isRendering && !scheduler.hasScheduledRender) {
        return
      }

      const event = await waitForNextFrameOrIdle(renderer)
      if (!event) {
        return
      }

      if (renderer.getNativeStats().cellsUpdated === 0) {
        consecutiveQuietFrames++
        if (consecutiveQuietFrames >= quietFrames) {
          return
        }
      } else {
        consecutiveQuietFrames = 0
      }
    }

    await drainImmediateWork()
    const scheduler = renderer.getSchedulerState()
    if (!scheduler.isRunning && !scheduler.isRendering && !scheduler.hasScheduledRender) {
      return
    }

    throw createWaitError(renderer, `Timed out waiting for visual idle after ${maxFrames} frames`)
  }

  const flush = async (flushOptions: TestFlushOptions = {}): Promise<void> => {
    await waitForVisualIdle({ maxFrames: normalizePositiveInteger(flushOptions.maxPasses, DEFAULT_MAX_PASSES) })
  }

  const waitFor = async (
    predicate: () => boolean | Promise<boolean>,
    waitOptions: TestWaitForOptions = {},
  ): Promise<void> => {
    const maxPasses = normalizePositiveInteger(waitOptions.maxPasses, DEFAULT_MAX_PASSES)

    for (let pass = 0; pass <= maxPasses; pass++) {
      await drainImmediateWork()
      if (await predicate()) {
        return
      }

      if (pass === maxPasses) {
        break
      }

      const scheduler = renderer.getSchedulerState()
      if (!scheduler.isRunning && !scheduler.isRendering && !scheduler.hasScheduledRender) {
        break
      }

      await waitForNextFrameOrIdle(renderer)
    }

    throw createWaitError(renderer, `Timed out waiting for predicate after ${maxPasses} passes`)
  }

  const waitForFrame = async (
    predicate: (frame: string) => boolean | Promise<boolean>,
    waitOptions: TestWaitForOptions = {},
  ): Promise<string> => {
    const maxPasses = normalizePositiveInteger(waitOptions.maxPasses, DEFAULT_MAX_PASSES)
    let frame = captureCharFrame()

    for (let pass = 0; pass <= maxPasses; pass++) {
      await drainImmediateWork()
      frame = captureCharFrame()
      if (await predicate(frame)) {
        return frame
      }

      if (pass === maxPasses) {
        break
      }

      const scheduler = renderer.getSchedulerState()
      if (!scheduler.isRunning && !scheduler.isRendering && !scheduler.hasScheduledRender) {
        break
      }

      await waitForNextFrameOrIdle(renderer)
    }

    frame = captureCharFrame()
    throw createWaitError(renderer, `Timed out waiting for frame predicate after ${maxPasses} passes`, frame)
  }

  return {
    renderer,
    mockInput,
    mockMouse,
    renderOnce,
    flush,
    waitFor,
    waitForFrame,
    waitForVisualIdle,
    externalOutput,
    getNativeStats: () => renderer.getNativeStats(),
    captureCharFrame,
    captureSpans: () => {
      const currentBuffer = renderer.currentRenderBuffer
      const lines = currentBuffer.getSpanLines()
      const cursorState = renderer.getCursorState()
      return {
        cols: currentBuffer.width,
        rows: currentBuffer.height,
        cursor: [cursorState.x, cursorState.y] as [number, number],
        lines,
      }
    },
    resize: (width: number, height: number) => {
      //@ts-expect-error - this is a test renderer
      renderer.processResize(width, height)
    },
  }
}

async function setupTestRenderer(config: TestRendererOptions) {
  const stdin = config.stdin || createTestStdin()
  const width = config.width || config.stdout?.columns || process.stdout.columns || 80
  const height = config.height || config.stdout?.rows || process.stdout.rows || 24
  const stdout = config.stdout || createTestStdout(width, height)

  // Direct construction skips setupTerminal(); native bytes are routed to an
  // explicit memory destination so tests do not depend on process stdout or feed
  // backpressure behavior. CliRenderer still owns native renderer creation and
  // applies the same useThread defaults as production construction.
  return new CliRenderer(stdin, stdout, width, height, {
    ...config,
    bufferedOutput: config.bufferedOutput ?? "memory",
  })
}
