import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { dirname, extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const testFilePath = fileURLToPath(import.meta.url)
const testDir = dirname(testFilePath)
const fixturePath = join(testDir, `destroy-on-exit.fixture${extname(testFilePath)}`)
const packageRoot = testFilePath.includes(`${sep}.node-test${sep}`)
  ? resolve(testDir, "..", "..", "..")
  : resolve(testDir, "..", "..")
const workspaceRoot = resolve(packageRoot, "..", "..")

const runFixture = (
  code: number,
  mode:
    | "idle"
    | "during-render"
    | "destroy-first"
    | "on-destroy-exit"
    | "destroy-listener-exit"
    | "root-destroyed-exit" = "idle",
) => {
  const result = spawnSync(process.execPath, [...getFixtureRuntimeArgs(), fixturePath, code.toString(), mode], {
    cwd: packageRoot,
    env: process.env,
    timeout: 5000,
  })

  const stdout = result.stdout?.toString() ?? ""

  return { result, stdout }
}

function getFixtureRuntimeArgs(): string[] {
  if (process.versions.bun) {
    return []
  }

  return [
    "--permission",
    `--allow-fs-read=${workspaceRoot}`,
    "--allow-child-process",
    "--allow-worker",
    "--allow-ffi",
    "--experimental-ffi",
  ]
}

describe("destroy on process exit", () => {
  it("it should let applications restore terminal state in an exit handler", () => {
    const { result, stdout } = runFixture(0)

    expect(result.status).toBe(0)
    expect(stdout).toContain("raw mode disabled")
    expect(stdout).toContain("\x1b[?1049l")
  })

  it("it should restore terminal state for non-zero exit codes", () => {
    const { result, stdout } = runFixture(1)

    expect(result.status).toBe(1)
    expect(stdout).toContain("raw mode disabled")
    expect(stdout).toContain("\x1b[?1049l")
  })

  it("it should restore terminal modes when destroy happens during an active frame in an exit handler", () => {
    const { result, stdout } = runFixture(0, "during-render")

    expect(result.status).toBe(0)
    expect(stdout).toContain("raw mode disabled")
    expect(stdout).toContain("\x1b[?1049l")
    expect(stdout).toContain("\x1b[?2004l")
  })

  it("restores terminal modes when destroy is immediately followed by process.exit", () => {
    const { result, stdout } = runFixture(0, "destroy-first")

    expect(result.status).toBe(0)
    expect(stdout).toContain("raw mode disabled")
    expect(stdout).toContain("\x1b[?1049l")
    expect(stdout).toContain("\x1b[?2004l")
  })

  it.each(["on-destroy-exit", "destroy-listener-exit", "root-destroyed-exit"] as const)(
    "restores before a cleanup callback terminates the process: %s",
    (mode) => {
      const { result, stdout } = runFixture(0, mode)

      expect(result.status).toBe(0)
      expect(stdout).toContain("raw mode disabled")
      expect(stdout).toContain("cleanup terminating")
      expect(stdout).toContain("\x1b[?1049l")
      expect(stdout).toContain("\x1b[?2004l")
      expect(stdout.indexOf("\x1b[?1049l")).toBeLessThan(stdout.indexOf("cleanup terminating"))
      expect(stdout.indexOf("\x1b[?2004l")).toBeLessThan(stdout.indexOf("cleanup terminating"))
    },
  )
})
