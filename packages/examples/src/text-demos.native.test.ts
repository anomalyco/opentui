import { setSystemTime, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"

test.each([1, 2])(
  "styled-text-demo updates every two frames after Down with %i initial frames",
  async (initialFrames) => {
    const example = await import("./styled-text-demo.js")
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 132,
      height: 64,
      clock: new ManualClock(),
    })
    try {
      example.run(renderer)
      renderer.pause()
      for (let frame = 0; frame < initialFrames; frame++) await renderOnce()
      let previous = captureCharFrame()
      assert.ok(previous.includes("[Update: Every Frame]"))

      mockInput.pressKey("ARROW_DOWN")
      for (let frame = initialFrames + 1; frame <= initialFrames + 4; frame++) {
        await renderOnce()
        const current = captureCharFrame()
        if (frame % 2 === 0) {
          assert.notEqual(current, previous)
          assert.ok(current.includes("[Update: Every 2 frames]"))
          assert.ok(current.includes(`Frame: ${frame} (Total: ${frame})`))
        } else {
          assert.equal(current, previous)
        }
        previous = current
      }
    } finally {
      try {
        example.destroy(renderer)
      } finally {
        renderer.destroy()
        await renderer.closed
      }
    }
  },
)

test("styled-text-demo starts uptime when run, not when imported or last destroyed", async () => {
  const epoch = new Date("2026-08-31T12:00:00Z").getTime()
  setSystemTime(epoch)
  try {
    const example = await import("./styled-text-demo.js")

    for (const startedAt of [epoch - 1000, epoch + 2000]) {
      setSystemTime(startedAt)
      const target = await createTestRenderer({ width: 132, height: 64, clock: new ManualClock() })
      const { renderer } = target
      try {
        example.run(renderer)
        await target.waitFor(() => !renderer.getSchedulerState().isRendering)
        await target.renderOnce()
        assert.match(target.captureCharFrame(), /Uptime: 0\.00s/)
        assert.match(target.captureCharFrame(), /System Stats: \[Update: Every Frame\]/)
        setSystemTime(startedAt + 1000)
        await target.renderOnce()
        assert.match(target.captureCharFrame(), /Uptime: 1\.00s/)
      } finally {
        try {
          example.destroy(renderer)
        } finally {
          renderer.destroy()
          await renderer.closed
        }
      }
    }
  } finally {
    setSystemTime()
  }
})

test.each(["L", "D"])("text-wrap %s displays loaded Unicode content", async (key) => {
  const example = await import("./text-wrap.js")
  const directory = await mkdtemp(join(tmpdir(), "opentui-text-wrap-"))
  const previousTmpdir = process.env.TMPDIR
  const source = "Unicode fixture: 界 café e\u0301 🦊"
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(source))
  process.env.TMPDIR = directory
  try {
    const target = await createTestRenderer({ width: 170, height: 42, clock: new ManualClock() })
    const { renderer, mockInput } = target
    try {
      example.run(renderer)
      await target.renderOnce()
      if (key === "L") {
        const path = join(directory, "unicode.txt")
        await writeFile(path, source)
        mockInput.pressKey("L")
        mockInput.pressKey("u", { ctrl: true })
        await mockInput.typeText(path)
        mockInput.pressKey("RETURN")
      } else {
        mockInput.pressKey("D")
      }
      await once(renderer.root.findDescendantById("instructions-2")!, "line-info-change")
      await target.renderOnce()
      const frame = target.captureCharFrame()
      assert.doesNotMatch(frame, /ERROR:|Error loading file|Download failed:/)
      assert.ok(frame.includes(source))
    } finally {
      try {
        example.destroy(renderer)
      } finally {
        renderer.destroy()
        await renderer.closed
      }
    }
  } finally {
    fetch.mockRestore()
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
    await rm(directory, { recursive: true, force: true })
  }
})
