import { describe, expect, it } from "bun:test"
import { join } from "node:path"

describe("solid runtime plugin support with preload", () => {
  it("rewrites external TSX modules even when the preload plugin is already active", () => {
    const fixturePath = join(import.meta.dir, "runtime-plugin-support-preload.fixture.ts")
    const result = Bun.spawnSync([process.execPath, fixturePath], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    const stdout = result.stdout.toString().trim()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("solid=true")
    expect(stdout).toContain("core=true")
    expect(stdout).toContain("coreTesting=true")
    expect(stdout).toContain("solidJs=true")
    expect(stdout).toContain("jsx=true")
  })
})
