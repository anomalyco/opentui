import { test, expect } from "bun:test"
import { Readable } from "node:stream"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { BoxRenderable } from "../renderables/Box.js"
import type { CliRenderer } from "../renderer.js"
import { assertRendererReleased, processListenerCounts } from "../testing/harness.js"
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
