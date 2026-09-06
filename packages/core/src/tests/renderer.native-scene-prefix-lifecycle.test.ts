import { test } from "bun:test"
import assert from "node:assert/strict"
import { BoxRenderable } from "../renderables/Box.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { NativeStatus } from "../zig.js"

async function setup() {
  const result = await createTestRenderer({
    width: 8,
    height: 2,
    useMouse: true,
    clock: new ManualClock(),
  })
  const errors: Error[] = []
  let frames = 0
  result.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
  result.renderer.on(CliRenderEvents.FRAME, () => frames++)
  return { ...result, errors, frames: () => frames }
}

test("native prefix resize inside a lease retains its cells, rejects stale release and permits retry", async () => {
  const { renderer, renderOnce, errors, frames } = await setup()
  const calls: string[] = []
  const box = new BoxRenderable(renderer, {
    width: 1,
    height: 1,
    renderBefore(buffer) {
      buffer.withBuffers(({ char }) => {
        char[0] = 65
        renderer.resize(10, 2)
        assert.equal(char.length, 16)
        assert.equal(char[0], 65)
      })
      calls.push("released")
    },
    renderAfter() {
      calls.push("after")
    },
  })
  renderer.root.add(box)
  renderer.addPostProcessFn(() => calls.push("post"))
  try {
    await renderOnce()
    assert.equal(renderer.width, 10)
    assert.deepEqual(calls, [])
    assert.equal(errors.length, 1)
    assert.equal((errors[0] as { status?: NativeStatus }).status, NativeStatus.StaleLease)
    assert.equal(frames(), 0)
    box.renderBefore = undefined
    await renderOnce()
    assert.equal(frames(), 1)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})

test("native prefix renderer destruction lets active and nested capture finish before closing", async () => {
  const { renderer, renderOnce, errors, frames } = await setup()
  const calls: string[] = []
  renderer.root.add(
    new BoxRenderable(renderer, {
      width: 1,
      height: 1,
      renderBefore(buffer) {
        buffer.withBuffers(({ char }) => {
          char[0] = 65
          renderer.destroy()
          assert.equal(char[0], 65)
          assert.equal(new TextDecoder().decode(buffer.getRealCharBytes()).slice(0, 1), "A")
          buffer.withBuffers(({ char }) => assert.equal(char[0], 65))
        })
        calls.push("released")
      },
      renderAfter() {
        calls.push("after")
      },
    }),
  )
  try {
    await renderOnce()
    await renderer.closed
    assert.deepEqual(errors, [])
    assert.deepEqual(calls, ["released"])
    assert.equal(frames(), 0)
    assert.equal(renderer.nativeScene!.driver.disposed, true)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
