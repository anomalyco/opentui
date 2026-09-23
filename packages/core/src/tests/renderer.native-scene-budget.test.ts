import { test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderEvents } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"

test("nativeSceneWorkBudget rejects invalid limits", async () => {
  for (const limit of [0, -1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    await assert.rejects(createTestRenderer({ nativeSceneWorkBudget: limit }), /positive u32/)
  }
})

test("native work budget presents frames while every event-loop turn mutates layout", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    nativeSceneWorkBudget: 1,
    width: 12,
    height: 4,
    clock: new ManualClock(),
  })
  const errors: unknown[] = []
  let frames = 0
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  renderer.on(CliRenderEvents.FRAME, () => frames++)
  const log = new BoxRenderable(renderer, { flexDirection: "column" })
  renderer.root.add(log)
  const lines = Array.from({ length: 8 }, (_, index) => {
    const line = new TextRenderable(renderer, { content: `line ${index}` })
    log.add(line)
    return line
  })
  let running = true
  let appended = 0
  const mutate = (async () => {
    while (running) {
      await setImmediate()
      appended++
      lines[appended % lines.length].content = `edit ${appended}`
    }
  })()
  try {
    for (let frame = 0; frame < 4; frame++) await renderOnce()
  } finally {
    running = false
    await mutate
  }
  try {
    assert.deepEqual(errors, [])
    assert.ok(appended > 0)
    assert.equal(frames, 4)
    assert.match(captureCharFrame(), /edit \d+/)
  } finally {
    renderer.destroy()
    await renderer.closed
  }
})
