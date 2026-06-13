import { test, expect } from "bun:test"
import { resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()

function expectValidAllocatorStats(stats: ReturnType<typeof lib.getAllocatorStats>): void {
  expect(Number.isFinite(stats.totalRequestedBytes)).toBe(true)
  expect(Number.isFinite(stats.activeAllocations)).toBe(true)
  expect(Number.isFinite(stats.smallAllocations)).toBe(true)
  expect(Number.isFinite(stats.largeAllocations)).toBe(true)
  expect(typeof stats.requestedBytesValid).toBe("boolean")

  expect(stats.totalRequestedBytes).toBeGreaterThanOrEqual(0)
  expect(stats.activeAllocations).toBeGreaterThanOrEqual(0)
  expect(stats.smallAllocations).toBeGreaterThanOrEqual(0)
  expect(stats.largeAllocations).toBeGreaterThanOrEqual(0)
  expect(stats.activeAllocations).toBe(stats.smallAllocations + stats.largeAllocations)
}

test("getBuildOptions exposes native build flags", () => {
  const buildOptions = lib.getBuildOptions()
  expect(typeof buildOptions.gpaSafeStats).toBe("boolean")
  expect(typeof buildOptions.gpaMemoryLimitTracking).toBe("boolean")
  expect(buildOptions.gpaMemoryLimitTracking).toBe(buildOptions.gpaSafeStats)
})

test("getAllocatorStats returns allocator stats", () => {
  const before = lib.getAllocatorStats()
  expectValidAllocatorStats(before)

  const textBuffer = lib.createTextBuffer("unicode")
  textBuffer.append("allocator stats smoke test")

  const after = lib.getAllocatorStats()
  expectValidAllocatorStats(after)

  textBuffer.destroy()
})

test("getArenaAllocatedBytes returns a finite byte count", () => {
  const before = lib.getArenaAllocatedBytes()
  expect(Number.isFinite(before)).toBe(true)
  expect(before).toBeGreaterThanOrEqual(0)

  const textBuffer = lib.createTextBuffer("unicode")
  textBuffer.append("x".repeat(256 * 1024))

  const after = lib.getArenaAllocatedBytes()
  expect(Number.isFinite(after)).toBe(true)
  expect(after).toBeGreaterThanOrEqual(before)

  textBuffer.destroy()
})
