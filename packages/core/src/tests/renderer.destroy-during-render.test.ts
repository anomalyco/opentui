import { test, expect } from "bun:test"
import { Readable } from "node:stream"
import { Renderable } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { createTestStdout } from "../testing/test-streams.js"

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

  let output = ""
  const stdout = createTestStdout()
  stdout._write = (chunk, _encoding, callback) => {
    output += chunk.toString()
    callback()
  }
  const { renderer } = await createTestRenderer({ stdin, stdout, bufferedOutput: "stdout" })
  await renderer.setupTerminal()
  await renderer.idle()
  output = ""
  let cleanupObserved = false

  renderer.setFrameCallback(async () => {
    renderer.destroy()
    cleanupObserved = rawModeCalls.at(-1) === false && stdin.isPaused()
  })

  renderer.start()
  await renderer.closed

  expect(cleanupObserved).toBe(true)
  expect(output).toContain("\x1b[?2004l")
  expect(output).toContain("\x1b[?1006l")
})

test("destroying renderer during post-process should not crash", async () => {
  const { renderer } = await createTestRenderer({})

  let destroyedDuringPostProcess = false

  renderer.addPostProcessFn(() => {
    destroyedDuringPostProcess = true
    renderer.destroy()
  })

  renderer.start()

  await renderer.closed

  expect(destroyedDuringPostProcess).toBe(true)

  // If we got here without a segfault, the test passes
})

test("destroying renderer during requestAnimationFrame should not crash", async () => {
  const { renderer } = await createTestRenderer({})

  let destroyedDuringAnimationFrame = false

  renderer.requestAnimationFrame(() => {
    destroyedDuringAnimationFrame = true
    renderer.destroy()
  })

  await renderer.closed

  expect(destroyedDuringAnimationFrame).toBe(true)
})

test.each(["renderBefore", "renderAfter"] as const)(
  "destroying renderer during %s releases the native scene",
  async (hook) => {
    const { renderer } = await createTestRenderer({})
    const driver = renderer.nativeScene.driver
    let calls = 0
    const Constructor = hook === "renderBefore" ? DestroyingRenderable : BoxRenderable
    const renderable = new Constructor(renderer, {
      width: 10,
      height: 1,
      [hook]() {
        calls++
        renderer.destroy()
      },
    })

    renderer.root.add(renderable)
    renderer.start()

    await renderer.closed

    expect(calls).toBe(1)
    expect(renderable.isDestroyed).toBe(true)
    expect(renderer.root.isDestroyed).toBe(true)
    expect(driver.disposed).toBe(true)
  },
)
