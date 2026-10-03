import { test } from "bun:test"
import assert from "node:assert/strict"
import { setImmediate, setTimeout as sleep } from "node:timers/promises"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { CliRenderEvents, type CliRenderer } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { NativeSceneFrame } from "../zig.js"

test("nativeSceneWorkBudget rejects invalid limits", async () => {
  for (const limit of [0, -1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    await assert.rejects(createTestRenderer({ nativeSceneWorkBudget: limit }), /positive u32/)
  }
})

async function budgetRenderer(width: number, clock?: ManualClock) {
  const target = await createTestRenderer({ nativeSceneWorkBudget: 1, width, height: 6, clock })
  const errors: unknown[] = []
  let frames = 0
  target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  target.renderer.on(CliRenderEvents.FRAME, () => frames++)
  const column = new BoxRenderable(target.renderer, { flexDirection: "column" })
  target.renderer.root.add(column)
  const lines = Array.from({ length: 4 }, (_, index) => {
    const line = new TextRenderable(target.renderer, { content: `line ${index}` })
    column.add(line)
    return line
  })
  return { ...target, column, lines, errors, frames: () => frames }
}

// Each turn changes the scene before the yielded continuation runs.
test.each(["edits text", "resizes a node with a resize hook"])(
  "native work budget presents frames while every turn %s",
  async (change) => {
    const target = await budgetRenderer(40, new ManualClock())
    const resized = new BoxRenderable(target.renderer, { width: 1, height: 1 })
    resized.on("resize", () => {})
    target.column.add(resized)
    let running = true
    let turns = 0
    const mutating = (async () => {
      for (; running; turns++) {
        await setImmediate()
        if (change === "edits text") target.lines[turns % target.lines.length].content = `edit ${turns}`
        else resized.width = (turns % 30) + 1
      }
    })()
    try {
      for (let frame = 0; frame < 4; frame++) await target.renderOnce()
    } finally {
      running = false
      await mutating
    }
    try {
      assert.deepEqual(target.errors, [])
      assert.ok(turns > 0)
      assert.equal(target.frames(), 4)
    } finally {
      target.renderer.destroy()
      await target.renderer.closed
    }
  },
)

/** Runs interrupt in a microtask after this renderer's next frame step that yields, while that frame is parked. */
function atNextYield(renderer: CliRenderer, interrupt: () => Promise<void> | void): Promise<void> {
  const { renderLib: lib, session } = renderer.nativeScene.driver
  const step = lib.sceneFrameStep
  const parked = Promise.withResolvers<void>()
  lib.sceneFrameStep = function (...args) {
    const request = step.apply(this, args)
    if (args[1] === session && request.kind === NativeSceneFrame.Yield) {
      lib.sceneFrameStep = step
      queueMicrotask(() => parked.resolve(interrupt()))
    }
    return request
  }
  return parked.promise.finally(() => {
    lib.sceneFrameStep = step
  })
}

// A parked paint holds a native attempt; each interruption must release it without a render error.
const parkedInterruptions: Record<string, (renderer: CliRenderer, change: () => void) => Promise<void> | void> = {
  "suspend, then resume": async (renderer, change) => {
    const suspended = renderer.suspend()
    change()
    await suspended
    assert.equal(renderer.nativeScene.frame, null)
    await renderer.resume()
  },
  resize: (renderer, change) => {
    renderer.resize(24, 6)
    change()
  },
  destroy: (renderer) => renderer.destroy(),
  // A cancel wins over a later restart, which would start a second native attempt beside the parked one.
  "cancel, then restart": (renderer, change) => {
    renderer.nativeScene.cancelFrame()
    renderer.nativeScene.restartPaint()
    change()
  },
}

for (const [interruption, interrupt] of Object.entries(parkedInterruptions)) {
  for (const mode of ["on demand", "running"] as const) {
    // A bare cancel schedules no follow-up frame, so a running loop stops; production cancels only by suspend or destroy.
    if (interruption === "cancel, then restart" && mode === "running") continue
    test(`${interruption} at a parked paint (${mode}) presents the latest scene`, async () => {
      const { renderer, renderOnce, captureCharFrame, lines, errors, frames } = await budgetRenderer(20)
      try {
        await renderer.setupTerminal()
        await renderOnce()
        if (mode === "running") renderer.start()
        const presented = frames()
        const parked = atNextYield(renderer, () => interrupt(renderer, () => (lines[1].content = "while parked")))
        lines[0].content = "requested"
        renderer.requestRender()
        await parked
        if (interruption === "destroy") {
          await renderer.closed
          assert.equal(frames(), presented)
        } else {
          // A running loop presents the next frame by itself; an on-demand renderer needs a request.
          if (mode === "on demand") await renderOnce()
          for (let turn = 0; turn < 500 && frames() === presented; turn++) await sleep(1)
          renderer.stop()
          await renderer.idle()
          assert.equal(renderer.getSchedulerState().isRendering, false)
          assert.match(captureCharFrame(), /requested[^]*while parked/)
          if (interruption === "resize") assert.equal(renderer.width, 24)
        }
        assert.deepEqual(errors, [])
      } finally {
        renderer.destroy()
        await renderer.closed
      }
    })
  }
}
