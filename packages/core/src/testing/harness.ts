// Shared CliRenderer test helpers. Internal to the repository's tests; not exported from `@opentui/core/testing`.
import assert from "node:assert/strict"
import type { CliRenderer } from "../renderer.js"
import { NativeSessionRenderStatus } from "../zig.js"

/** Runs `turns` host turns, so ready frames, Session pumps, and stream callbacks can run. */
export async function settle(turns = 1): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Runs host turns until `predicate` holds. Throws after `maxTurns`, so a stalled renderer fails fast. */
export async function settleUntil(predicate: () => boolean, maxTurns = 64): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    if (predicate()) return
    await settle()
  }
  if (!predicate()) throw new Error(`Condition not met within ${maxTurns} host turns`)
}

/**
 * Runs host turns until no frame renders, no ready frame is queued, and no output-idle retry waits. Timer-driven
 * frames are not run; advance the clock first. Reads scheduler internals that `getSchedulerState()` merges.
 */
export async function serviceReadyFrames(renderer: CliRenderer, maxTurns = 64): Promise<void> {
  const state = renderer as unknown as {
    rendering: boolean
    cancelReadyFrame: unknown
    outputIdleRenderScheduled: boolean
  }
  await settleUntil(() => !state.rendering && !state.cancelReadyFrame && !state.outputIdleRenderScheduled, maxTurns)
}

/**
 * Replaces the Session frame commit. `next()` picks the status of each commit: Presented commits normally; any other
 * status consumes the frame without output, as the native Session does under pressure. Returns a restore function.
 */
export function forceRenderStatus(renderer: CliRenderer, next: () => NativeSessionRenderStatus): () => void {
  const driver = renderer.nativeScene.driver
  const render = driver.render
  driver.render = (...args) => {
    const status = next()
    if (status === NativeSessionRenderStatus.Presented) return render.apply(driver, args)
    renderer.nativeScene.cancelFrame()
    return status
  }
  return () => {
    driver.render = render
  }
}

export interface HeldOutputIdle {
  /** Resolves the held wait; later `idle()` calls pass through until `hold()`. */
  release(): Promise<void>
  hold(): void
  /** Number of `idle()` calls since the hold started. */
  calls(): number
  restore(): void
}

/** Holds every Session `idle()` wait, so a skipped frame's output-idle retry runs only on `release()`. */
export function holdOutputIdle(renderer: CliRenderer): HeldOutputIdle {
  const driver = renderer.nativeScene.driver
  const idle = driver.idle
  let pending: PromiseWithResolvers<void> | undefined
  let released = false
  let calls = 0
  driver.idle = () => {
    calls++
    if (released) return idle.call(driver)
    pending ??= Promise.withResolvers<void>()
    return pending.promise
  }
  return {
    release: async () => {
      released = true
      pending?.resolve()
      pending = undefined
      await Promise.resolve()
      await Promise.resolve()
    },
    hold: () => {
      released = false
    },
    calls: () => calls,
    restore: () => {
      driver.idle = idle
    },
  }
}

const RENDERER_PROCESS_EVENTS = [
  "SIGWINCH",
  "warning",
  "uncaughtException",
  "unhandledRejection",
  "exit",
  "SIGINT",
  "SIGTERM",
  "SIGQUIT",
  "SIGABRT",
  "SIGHUP",
  "SIGPIPE",
  "SIGBREAK",
  "SIGBUS",
] as const

/** Counts the process listeners that a renderer installs. Take it before construction. */
export function processListenerCounts(): Map<string, number> {
  return new Map(RENDERER_PROCESS_EVENTS.map((event) => [event, process.listenerCount(event)]))
}

/**
 * Waits for `closed` (a Session failure is allowed) and checks that the renderer released everything it acquired:
 * process listeners (against `before`), its stdin listener, the stream lease, the root tree, and the Session.
 */
export async function assertRendererReleased(renderer: CliRenderer, before: Map<string, number>): Promise<void> {
  assert.equal(renderer.isDestroyed, true, "renderer is not destroyed")
  await renderer.closed.catch(() => {})
  assert.deepEqual(processListenerCounts(), before, "process listeners leaked")
  assert.equal(renderer.stdin.listenerCount("data"), 0, "stdin data listener leaked")
  assert.equal((renderer as unknown as { _streamLeaseAcquired: boolean })._streamLeaseAcquired, false)
  assert.equal(renderer.root.isDestroyed, true, "root renderable is not destroyed")
  assert.equal(renderer.nativeScene.driver.disposed, true, "Session is not disposed")
}
