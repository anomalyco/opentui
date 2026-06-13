import { describe, expect, it } from "bun:test"
import { join } from "node:path"

describe("solid runtime plugin support", () => {
  it("loads external TSX modules against host runtime modules", () => {
    const fixturePath = join(import.meta.dir, "runtime-plugin-support.fixture.ts")
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

  it("loads caller-provided runtime modules through the configurable entrypoint", () => {
    const fixturePath = join(import.meta.dir, "runtime-plugin-support-configure.fixture.ts")
    const result = Bun.spawnSync([process.execPath, fixturePath], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    const stdout = result.stdout.toString().trim()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("first=true")
    expect(stdout).toContain("second=false")
    expect(stdout).toContain("keymap=true")
    expect(stdout).toContain("keymapAddons=true")
    expect(stdout).toContain("keymapExtras=true")
    expect(stdout).toContain("keymapSolid=true")
    expect(stdout).toContain("three=true")
    expect(stdout).toContain("jsx=true")
  }, 10_000)

  it("throws when modules are added after side-effect installation", () => {
    const fixturePath = join(import.meta.dir, "runtime-plugin-support-late-addition.fixture.ts")
    const result = Bun.spawnSync([process.execPath, fixturePath], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    const stdout = result.stdout.toString().trim()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("OpenTUI Solid runtime plugin support is already installed without @opentui/keymap")
    expect(stdout).toContain("@opentui/solid/runtime-plugin-support/configure")
  })
})
