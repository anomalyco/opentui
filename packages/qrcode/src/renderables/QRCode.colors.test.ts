import { describe, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable, RGBA } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { QRCodeRenderable } from "./QRCode.js"

describe("native retained QRCode colors", () => {
  test("rejected constructor color capture does not retain a node", async () => {
    const target = await createTestRenderer({ width: 40, height: 20, clock: new ManualClock() })
    try {
      const before = new Set(Renderable.renderablesByNumber.keys())
      const color = RGBA.fromHex("#123456")
      Object.defineProperty(color, "buffer", {
        get() {
          throw new Error("rejected color capture")
        },
      })
      assert.throws(() => new QRCodeRenderable(target.renderer, { foregroundColor: color }), /rejected color capture/)
      assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), before)
    } finally {
      target.renderer.destroy()
      await target.renderer.closed
    }
  })
  test.each(["foregroundColor", "backgroundColor", "fallbackColor"] as const)(
    "QRCode snapshots %s",
    async (property) => {
      const target = await createTestRenderer({ width: 40, height: 20, clock: new ManualClock() })
      try {
        const color = RGBA.fromHex("#123456")
        const qr = new QRCodeRenderable(target.renderer, {
          content: "hello",
          fallbackContent: "Small",
          [property]: color,
          ...(property === "fallbackColor" ? { width: 8, height: 1 } : {}),
        })
        target.renderer.root.add(qr)
        await target.renderOnce()
        const before = target.captureSpans()
        color.buffer.fill(255)
        qr[property].buffer.fill(0)
        qr.quietZone = 5
        qr.quietZone = 4
        await target.renderOnce()
        assert.deepEqual(target.captureSpans(), before)
        qr[property] = color
        await target.renderOnce()
        assert.notDeepEqual(target.captureSpans(), before)
      } finally {
        target.renderer.destroy()
        await target.renderer.closed
      }
    },
  )
})
