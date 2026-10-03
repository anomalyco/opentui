import { test, expect, spyOn } from "bun:test"
import { Readable } from "node:stream"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents, type CliRenderer } from "../renderer.js"
import { assertRendererReleased, processListenerCounts, settle } from "../testing/harness.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { RecordingWriteStream } from "../testing/test-streams.js"

class DestroyingRenderable extends Renderable {
  protected renderSelf(_buffer: OptimizedBuffer, _deltaTime: number): void {}
}

test("destroying renderer during frame callback restores input synchronously and drains terminal shutdown", async () => {
  const rawModeCalls: boolean[] = []
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream & {
    setRawMode: (enabled: boolean) => NodeJS.ReadStream
  }
  stdin.setRawMode = (enabled) => {
    rawModeCalls.push(enabled)
    return stdin
  }

  const stdout = new RecordingWriteStream()
  const { renderer } = await createTestRenderer({
    stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    bufferedOutput: "stdout",
  })
  await renderer.setupTerminal()
  await renderer.idle()
  stdout.clear()
  let cleanupObserved = false

  renderer.setFrameCallback(async () => {
    renderer.destroy()
    cleanupObserved = rawModeCalls.at(-1) === false && stdin.isPaused()
  })

  renderer.start()
  await renderer.closed

  expect(cleanupObserved).toBe(true)
  expect(stdout.text()).toContain("\x1b[?2004l")
  expect(stdout.text()).toContain("\x1b[?1006l")
})

const phases: Record<string, (renderer: CliRenderer, destroy: () => void) => Renderable | void> = {
  "frame callback": (renderer, destroy) => renderer.setFrameCallback(async () => destroy()),
  "post-process": (renderer, destroy) => renderer.addPostProcessFn(destroy),
  requestAnimationFrame: (renderer, destroy) => void renderer.requestAnimationFrame(destroy),
  renderBefore: (renderer, destroy) => new DestroyingRenderable(renderer, { width: 10, height: 1, renderBefore: destroy }),
  renderAfter: (renderer, destroy) => new BoxRenderable(renderer, { width: 10, height: 1, renderAfter: destroy }),
}

for (const [phase, install] of Object.entries(phases)) {
  test(`destroying renderer during ${phase} releases the renderer`, async () => {
    const listeners = processListenerCounts()
    const { renderer } = await createTestRenderer({})
    let calls = 0
    const renderable = install(renderer, () => {
      calls++
      renderer.destroy()
    })
    if (renderable) renderer.root.add(renderable)
    renderer.start()

    await renderer.closed

    expect(calls).toBe(1)
    expect(renderable?.isDestroyed ?? true).toBe(true)
    await assertRendererReleased(renderer, listeners)
  })
}

// Teardown abandons a frame that waits for the terminal. That is not a render failure.
const frameWaits: Record<string, (stdout: RecordingWriteStream, renderer: CliRenderer) => Promise<void> | void> = {
  "terminal setup": (_stdout, renderer) => void renderer.setupTerminal().catch(() => {}),
  "frame presentation": async (stdout, renderer) => {
    await renderer.setupTerminal()
    stdout.hold()
    renderer.setBackgroundColor("#202020")
  },
}

for (const [wait, enter] of Object.entries(frameWaits)) {
  for (const teardown of ["destroy", "Session failure"] as const) {
    test(`${teardown} while a frame waits for ${wait} reports no render error`, async () => {
      const listeners = processListenerCounts()
      const stdout = new RecordingWriteStream()
      const { renderer, renderOnce } = await createTestRenderer({
        stdout: stdout as unknown as NodeJS.WriteStream,
        bufferedOutput: "stdout",
        consoleMode: "disabled",
      })
      const renderErrors: unknown[] = []
      renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => renderErrors.push(error))
      const logged = spyOn(console, "error").mockImplementation(() => {})
      try {
        await enter(stdout, renderer)
        const frame = renderOnce()
        await settle()
        expect(renderer.getSchedulerState().isRendering).toBe(true)
        if (teardown === "destroy") renderer.destroy()
        else stdout.destroy(new Error("ECONNRESET"))
        stdout.release()
        await frame
        await assertRendererReleased(renderer, listeners)

        expect(renderErrors).toEqual([])
        // Only a running renderer reports a Session failure; a pending setup rejects its caller instead.
        expect(logged.mock.calls.length).toBe(teardown === "Session failure" && wait !== "terminal setup" ? 1 : 0)
      } finally {
        logged.mockRestore()
      }
    })
  }
}

test("a Session closed by its owner during setup does not report the interruption", async () => {
  const { renderer } = await createTestRenderer({ consoleMode: "disabled" })
  const logged = spyOn(console, "error").mockImplementation(() => {})
  try {
    const setup = renderer.setupTerminal()
    const closing = renderer.nativeScene.driver.close()
    await expect(setup).rejects.toThrow("interrupted by close")
    await closing
    renderer.destroy()
    await renderer.closed
    expect(logged.mock.calls.flat().map(String).filter((line) => line.includes("interrupted by close"))).toEqual([])
  } finally {
    logged.mockRestore()
  }
})
