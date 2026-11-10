import { describe, expect, it } from "bun:test"
import { join } from "node:path"

const fixturePath = join(import.meta.dir, "destroy-race.fixture.tsx")

type Mode = "external" | "helper" | "external-onmount" | "helper-onmount" | "external-active" | "helper-active"

const runFixture = (mode: Mode) => {
  const result = Bun.spawnSync([process.execPath, fixturePath, mode], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })

  const stdout = result.stdout.toString()

  return { result, stdout }
}

describe("destroy race regressions", () => {
  it("does not crash when renderer is destroyed during initial render (external renderer path)", () => {
    const { result } = runFixture("external")

    expect(result.exitCode).toBe(0)
  })

  it("does not crash when renderer is destroyed during initial render (testRender helper path)", () => {
    const { result } = runFixture("helper")

    expect(result.exitCode).toBe(0)
  })

  it("does not crash when renderer is destroyed from onMount (external renderer path)", () => {
    const { result } = runFixture("external-onmount")

    expect(result.exitCode).toBe(0)
  })

  it("does not crash when renderer is destroyed from onMount (testRender helper path)", () => {
    const { result } = runFixture("helper-onmount")

    expect(result.exitCode).toBe(0)
  })

  it("does not crash when renderer is destroyed in an active render pass (external renderer path)", () => {
    const { result } = runFixture("external-active")

    expect(result.exitCode).toBe(0)
  })

  it("does not crash when renderer is destroyed in an active render pass (testRender helper path)", () => {
    const { result } = runFixture("helper-active")

    expect(result.exitCode).toBe(0)
  })
})
