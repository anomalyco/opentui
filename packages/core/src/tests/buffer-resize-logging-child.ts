import assert from "node:assert/strict"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"

const scenario = process.argv[2]
// Keep the startup cwd for inherited Node preload paths, then isolate log files.
process.chdir(process.argv[3])
const writeFileSync = fs.writeFileSync
const failure = new Error("injected FFI log write failure")
const prefix = scenario === "before" ? "ot_buffer_resize(" : "ot_buffer_resize returned:"
let armed = false
let failed = false
let laterWrites = 0
fs.writeFileSync = (...args) => {
  if (failed) laterWrites++
  if (armed && typeof args[1] === "string" && args[1].startsWith(prefix)) {
    failed = true
    throw failure
  }
  return writeFileSync(...args)
}
if ("bun" in process.versions) {
  const { mock } = await import("bun:test")
  mock.module("fs", () => ({ ...fs }))
} else {
  syncBuiltinESMExports()
}

const { OptimizedBuffer, ResourceContext } = await import("../buffer.js")
const owner = new ResourceContext({ objectCapacity: 4, renderCellsMax: 64 })
const buffer = OptimizedBuffer.create(2, 2, "unicode", { owner })
try {
  const generation = buffer.withBuffers((cells) => cells.generation)
  const rejected = scenario === "rejected"
  armed = true
  let error: unknown
  try {
    buffer.resize(rejected ? 65536 : 4, rejected ? 65536 : 3)
  } catch (caught) {
    error = caught
  }
  // Only compare retired views by identity, never include them in diagnostics.
  assert.deepEqual(
    {
      outcomePreserved: rejected ? error instanceof Error : error === undefined,
      widthPublished: buffer.width === (rejected ? 2 : 4),
      heightPublished: buffer.height === (rejected ? 2 : 3),
      nativeWidth: buffer.withBuffers((cells) => cells.width) === (rejected ? 2 : 4),
      nativeHeight: buffer.withBuffers((cells) => cells.height) === (rejected ? 2 : 3),
      cachePublished: (buffer.withBuffers((cells) => cells.generation) === generation) === rejected,
      logFailed: failed,
    },
    {
      outcomePreserved: true,
      widthPublished: true,
      heightPublished: true,
      nativeWidth: true,
      nativeHeight: true,
      cachePublished: true,
      logFailed: true,
    },
  )

  const accepted = buffer.withBuffers((cells) => cells.generation)
  assert.throws(() => buffer.resize(65536, 65536))
  assert.throws(() => buffer.resize(0, 3))
  assert.equal(buffer.withBuffers((cells) => cells.generation) === accepted, true)
  buffer.resize(5, 4)
  assert.equal(buffer.width === 5 && buffer.height === 4, true)
  assert.equal(
    buffer.withBuffers((cells) => cells.width === 5 && cells.height === 4),
    true,
  )
  assert.equal(buffer.withBuffers((cells) => cells.generation) === accepted, false)
  assert.equal(
    buffer.withBuffers((cells) => cells.char.length),
    20,
  )
  assert.equal(laterWrites, 0)
} finally {
  buffer.destroy()
  owner.destroy()
  fs.writeFileSync = writeFileSync
  syncBuiltinESMExports()
}
