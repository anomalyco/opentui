import { test, expect } from "bun:test"
import { resolveRenderLib } from "../zig.js"
import { ResourceContext } from "../buffer.js"
import { TextBuffer } from "../text-buffer.js"

const lib = resolveRenderLib()

test("getBuildOptions exposes native build flags", () => {
  const buildOptions = lib.getBuildOptions()
  expect(typeof buildOptions.gpaSafeStats).toBe("boolean")
  expect(buildOptions.gpaMemoryLimitTracking).toBe(buildOptions.gpaSafeStats)
})

test("process allocator stats count span feeds and exclude Context memory", () => {
  const before = lib.getAllocatorStats()
  const owner = new ResourceContext({ objectCapacity: 1, renderCellsMax: 1 })
  try {
    TextBuffer.create("unicode", owner).append("x".repeat(256 * 1024))
    expect(lib.getAllocatorStats()).toEqual(before)
  } finally {
    owner.destroy()
  }

  const stream = lib.createNativeSpanFeed(null)
  try {
    const during = lib.getAllocatorStats()
    expect(during.activeAllocations).toBeGreaterThan(before.activeAllocations)
    expect(during.activeAllocations).toBe(during.smallAllocations + during.largeAllocations)
  } finally {
    lib.destroyNativeSpanFeed(stream)
  }
  expect(lib.getAllocatorStats()).toEqual(before)
  expect(lib.getArenaAllocatedBytes()).toBe(0)
})
