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

// Every exit path restores raw mode, the alternate screen, and bracketed paste before the process ends; a cleanup
// callback that terminates the process runs only after restoration.
const exitCases: Array<[mode: ExitMode, code: number, cleanupExits: boolean]> = [
  ["idle", 0, false],
  ["idle", 1, false],
  ["during-render", 0, false],
  ["destroy-first", 0, false],
  ["on-destroy-exit", 0, true],
  ["destroy-listener-exit", 0, true],
  ["root-destroyed-exit", 0, true],
]

describe("destroy on process exit", () => {
  for (const [mode, code, cleanupExits] of exitCases) {
    it(`restores the terminal for ${mode} exit with code ${code}`, () => {
      const { result, stdout } = runFixture(code, mode)

      expect(result.status).toBe(code)
      expect(stdout).toContain("raw mode disabled")
      for (const sequence of ["\x1b[?1049l", "\x1b[?2004l"]) {
        expect(stdout).toContain(sequence)
        if (cleanupExits) expect(stdout.indexOf(sequence)).toBeLessThan(stdout.indexOf("cleanup terminating"))
      }
      expect(stdout.includes("cleanup terminating")).toBe(cleanupExits)
    })
  }
})
