import { test } from "bun:test"
import assert from "node:assert/strict"
import { createTestRenderer } from "../testing/test-renderer.js"

test("nativeSceneWorkBudget rejects invalid limits", async () => {
  for (const limit of [0, -1, 0.5, NaN, Infinity, 0x1_0000_0000]) {
    await assert.rejects(createTestRenderer({ nativeSceneWorkBudget: limit }), /positive u32/)
  }
})
