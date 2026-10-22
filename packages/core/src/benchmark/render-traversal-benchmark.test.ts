import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

test("render-traversal-benchmark runs a retained workload without out-of-frame buffer writes", () => {
  const child = spawnSync(
    process.execPath,
    [join(import.meta.dir, "render-traversal-benchmark.ts"), "--iterations=1", "--warmup-iterations=1", "--no-output"],
    { encoding: "utf8", timeout: 60_000 },
  )
  expect(child.error).toBeUndefined()
  expect(child.stderr).toBe("")
  expect(child.status).toBe(0)
}, 60_000)
