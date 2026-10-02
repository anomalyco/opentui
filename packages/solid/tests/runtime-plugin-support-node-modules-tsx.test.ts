import { describe, expect, it } from "bun:test"
import { join } from "node:path"

describe("solid runtime plugin support for node_modules TSX", () => {
  it("loads direct and nested TSX against the host runtime", () => {
    const fixturePath = join(import.meta.dir, "runtime-plugin-support-node-modules-tsx.fixture.ts")
    const result = Bun.spawnSync([process.execPath, fixturePath], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    const stdout = result.stdout.toString().trim()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("directSolid=true")
    expect(stdout).toContain("directJsx=true")
    expect(stdout).toContain("nestedSolid=true")
    expect(stdout).toContain("nestedJsx=true")
  })
})
