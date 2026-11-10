import { describe, expect, it } from "bun:test"
import { join } from "node:path"

describe("react runtime plugin support", () => {
  it("loads external modules against host runtime exports", () => {
    const fixturePath = join(import.meta.dir, "runtime-plugin-support.fixture.ts")
    const result = Bun.spawnSync([process.execPath, fixturePath], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    const stdout = result.stdout.toString().trim()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("core=true")
    expect(stdout).toContain("coreTesting=true")
    expect(stdout).toContain("opentuiReact=true")
    expect(stdout).toContain("opentuiReactJsx=true")
    expect(stdout).toContain("opentuiReactJsxDev=true")
    expect(stdout).toContain("react=true")
    expect(stdout).toContain("reactJsx=true")
    expect(stdout).toContain("reactJsxDev=true")
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
    expect(stdout).toContain(
      "mismatch=OpenTUI React runtime plugin support is already installed with different preserve options.",
    )
    expect(stdout).toContain("extra=ok")
    expect(stdout).toContain("preserved=host")
    expect(stdout).toContain("react=true")
  })

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
    expect(stdout).toContain(
      "OpenTUI React runtime plugin support is already installed without runtime-plugin-support-extra",
    )
    expect(stdout).toContain("@opentui/react/runtime-plugin-support/configure")
  })
})
