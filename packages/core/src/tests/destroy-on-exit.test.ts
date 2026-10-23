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

type ExitMode =
  | "idle"
  | "during-render"
  | "destroy-first"
  | "on-destroy-exit"
  | "destroy-listener-exit"
  | "root-destroyed-exit"
  | "session-error-exit"
  | "setup-throw-exit"
  | "signal-during-resume"

const runFixture = (code: number, mode: ExitMode) => {
  const result = spawnSync(process.execPath, [...getFixtureRuntimeArgs(), fixturePath, code.toString(), mode], {
    cwd: packageRoot,
    env: process.env,
    timeout: 5000,
  })

  return { result, stdout: result.stdout?.toString() ?? "" }
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

// Every exit path leaves raw mode. A Session that can still write restores the alternate screen and bracketed paste
// first; a cleanup callback that terminates the process runs only after restoration.
const exitCases: Array<[mode: ExitMode, code: number, cleanupExits: boolean, restores: boolean]> = [
  ["idle", 0, false, true],
  ["idle", 1, false, true],
  ["during-render", 0, false, true],
  ["destroy-first", 0, false, true],
  ["on-destroy-exit", 0, true, true],
  ["destroy-listener-exit", 0, true, true],
  ["root-destroyed-exit", 0, true, true],
  ["session-error-exit", 1, true, false],
  ["setup-throw-exit", 1, false, false],
  // Signal listeners return with raw mode, so a signal during resume() destroys the renderer.
  ["signal-during-resume", 0, false, true],
]

describe("destroy on process exit", () => {
  for (const [mode, code, cleanupExits, restores] of exitCases) {
    // Windows has no POSIX signals: SIGTERM ends the child without running its handlers.
    const signalTest = mode === "signal-during-resume" && process.platform === "win32" ? it.skip : it
    signalTest(`restores the terminal for ${mode} exit with code ${code}`, () => {
      const { result, stdout } = runFixture(code, mode)

      expect(result.status).toBe(code)
      expect(stdout).toContain("raw mode disabled")
      for (const sequence of restores ? ["\x1b[?1049l", "\x1b[?2004l"] : []) {
        expect(stdout).toContain(sequence)
        expect(stdout.indexOf(sequence)).toBeLessThan(stdout.indexOf("raw mode disabled"))
        if (cleanupExits) expect(stdout.indexOf(sequence)).toBeLessThan(stdout.indexOf("cleanup terminating"))
      }
      expect(stdout.includes("cleanup terminating")).toBe(cleanupExits)
    })
  }
})
