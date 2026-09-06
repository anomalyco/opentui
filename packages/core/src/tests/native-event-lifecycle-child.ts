import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { ResourceContext } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"

if (process.argv[2] === "rejections") EventEmitter.captureRejections = true
const owner = new ResourceContext({ objectCapacity: 2, renderCellsMax: 1 })
const buffer = EditBuffer.create("unicode", owner)
const trace: string[] = []

try {
  switch (process.argv[2]) {
    case "listeners": {
      const receivers: unknown[] = []
      const removed = () => trace.push("removed")
      const added = () => trace.push("added")
      const duplicate = () => trace.push("duplicate")
      let first = true
      buffer.on("content-changed", function (this: EventEmitter) {
        trace.push("named")
        receivers.push(this)
        if (first) {
          first = false
          buffer.off("content-changed", removed)
          buffer.on("content-changed", added)
        }
      })
      buffer.on("content-changed", removed)
      buffer.once("content-changed", function (this: EventEmitter) {
        trace.push("once")
        receivers.push(this)
      })
      const removedOnce = () => trace.push("removed once")
      buffer.once("content-changed", removedOnce)
      buffer.off("content-changed", removedOnce)
      buffer.on("content-changed", duplicate)
      buffer.on("content-changed", duplicate)
      buffer.off("content-changed", duplicate)
      buffer.setText("a")
      buffer.insertText("b")
      assert.equal(trace.length, 0)
      await Promise.resolve()
      assert.deepEqual(trace, ["named", "removed", "once", "duplicate", "named", "duplicate", "added"])
      assert.ok(receivers.every((receiver) => receiver === buffer))
      break
    }
    case "metadata": {
      const added: unknown[] = []
      const removed: unknown[] = []
      buffer.on("newListener", (name, listener) => {
        if (name === "content-changed") added.push(listener)
      })
      buffer.on("removeListener", (name, listener) => {
        if (name === "content-changed") removed.push(listener)
      })
      function handler() {
        trace.push("once")
      }
      buffer.on("content-changed", handler)
      buffer.off("content-changed", handler)
      buffer.once("content-changed", handler)
      buffer.off("content-changed", handler)
      buffer.once("content-changed", handler)
      assert.deepEqual(added, [handler, handler, handler])
      buffer.setText("a")
      buffer.insertText("b")
      await Promise.resolve()
      assert.deepEqual(trace, ["once"])
      assert.deepEqual(removed, [handler, handler, handler])
      break
    }
    case "rejections": {
      const failure = new Error("native listener rejected")
      const errors: unknown[] = []
      buffer.once("error", (error) => errors.push(error))
      buffer.on("content-changed", async () => {
        throw failure
      })
      buffer.setText("a")
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(errors, [failure])
      break
    }
    case "contexts": {
      const other = new ResourceContext({ objectCapacity: 1, renderCellsMax: 1 })
      const otherBuffer = EditBuffer.create("unicode", other)
      try {
        assert.equal(buffer._getSceneHandle(owner).slot, otherBuffer._getSceneHandle(other).slot)
        buffer.on("content-changed", () => trace.push(`first:${buffer.getText()}`))
        otherBuffer.on("content-changed", () => trace.push(`second:${otherBuffer.getText()}`))
        buffer.setText("a")
        otherBuffer.setText("b")
        await Promise.resolve()
        assert.deepEqual(trace, ["first:a", "second:b"])
        buffer.destroy()
        owner.destroy()
        otherBuffer.insertText("c")
        await Promise.resolve()
        assert.deepEqual(trace, ["first:a", "second:b", "second:cb"])
      } finally {
        otherBuffer.destroy()
        other.destroy()
      }
      break
    }
    case "queued": {
      buffer.on("cursor-changed", () => trace.push("cursor"))
      buffer.once("content-changed", () => trace.push("content"))
      buffer.setText("a")
      buffer.insertText("b")
      assert.equal(trace.length, 0)
      owner.destroy()
      await Promise.resolve()
      assert.equal(trace.length, 0)
      break
    }
    default:
      throw new Error(`Unknown native event scenario: ${process.argv[2]}`)
  }
} finally {
  buffer.destroy()
  owner.destroy()
}

console.log("Native event lifecycle passed")
