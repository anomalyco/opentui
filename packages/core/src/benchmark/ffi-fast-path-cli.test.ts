import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each(["", "."])("stress output %p does not remove its package directory", (output) => {
  const root = mkdtempSync(join(tmpdir(), "opentui-ffi-stress-test-"))
  temporaryDirectories.push(root)
  const packageRoot = join(root, "packages/core")
  const benchmarkDir = join(packageRoot, "src/benchmark")
  const script = join(benchmarkDir, "ffi-fast-path-stress.ts")
  const sentinel = join(packageRoot, "sentinel.txt")
  mkdirSync(benchmarkDir, { recursive: true })
  cpSync(join(import.meta.dir, "ffi-fast-path-stress.ts"), script)
  writeFileSync(sentinel, "keep")

  const child = spawnSync(process.execPath, [script, `--output=${output}`], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 10_000,
  })

  expect(child.status).not.toBe(0)
  expect(existsSync(sentinel)).toBe(true)
})

test("stress output cannot be nested under its runtime build directory", () => {
  const root = mkdtempSync(join(tmpdir(), "opentui-ffi-stress-test-"))
  temporaryDirectories.push(root)
  const packageRoot = join(root, "packages/core")
  const benchmarkDir = join(packageRoot, "src/benchmark")
  const copiedScript = join(benchmarkDir, "ffi-fast-path-stress.ts")
  mkdirSync(benchmarkDir, { recursive: true })
  cpSync(join(import.meta.dir, "ffi-fast-path-stress.ts"), copiedScript)
  const canonicalBenchmarkDir = realpathSync(benchmarkDir)
  const script = join(canonicalBenchmarkDir, "ffi-fast-path-stress.ts")

  const child = spawnSync(process.execPath, [script, "--output=.runtime-build/results"], {
    cwd: canonicalBenchmarkDir,
    encoding: "utf8",
    timeout: 10_000,
  })

  expect(child.status).not.toBe(0)
  expect(child.stderr).toContain("--output must not be inside the runtime build directory")
})

test("paired comparison rejects a baseline alias of the candidate worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "opentui-ffi-paired-test-"))
  temporaryDirectories.push(root)
  const candidateRoot = resolve(import.meta.dir, "../../../..")
  const baselineRoot = join(root, "baseline")
  symlinkSync(candidateRoot, baselineRoot, process.platform === "win32" ? "junction" : "dir")

  const child = spawnSync(
    process.execPath,
    [
      join(import.meta.dir, "ffi-fast-path-paired-benchmark.ts"),
      `--baseline-root=${baselineRoot}`,
      `--candidate-root=${candidateRoot}`,
      `--json=${join(root, "report.json")}`,
      "--runs=2",
      "--no-output",
    ],
    { cwd: resolve(import.meta.dir, "../.."), encoding: "utf8", timeout: 10_000 },
  )

  expect(child.status).not.toBe(0)
  expect(child.stderr).toContain("roots must differ")
})

test("comparison rejects repeated report files as independent rounds", () => {
  const root = mkdtempSync(join(tmpdir(), "opentui-ffi-compare-test-"))
  temporaryDirectories.push(root)
  const baseline = join(root, "baseline.json")
  const candidate = join(root, "candidate.json")
  writeReport(baseline, 100, 100)
  writeReport(candidate, 100, 80)
  const repeatedBaseline = Array(9).fill(baseline).join(",")
  const repeatedCandidate = Array(9).fill(candidate).join(",")

  const child = spawnSync(
    process.execPath,
    [join(import.meta.dir, "ffi-fast-path-compare.ts"), repeatedBaseline, repeatedCandidate, "--no-output"],
    { encoding: "utf8", timeout: 10_000 },
  )

  expect(child.status).not.toBe(0)
  expect(child.stderr).toContain("duplicate report path")
})

test("comparison rejects repeated run identities as independent rounds", () => {
  const root = mkdtempSync(join(tmpdir(), "opentui-ffi-compare-test-"))
  temporaryDirectories.push(root)
  const baselines = [join(root, "baseline-1.json"), join(root, "baseline-2.json")]
  const candidates = [join(root, "candidate-1.json"), join(root, "candidate-2.json")]
  for (const path of baselines) writeReport(path, 100, 100, 1, "baseline-run")
  for (const path of candidates) writeReport(path, 100, 80, 1, "candidate-run")

  const child = spawnSync(
    process.execPath,
    [join(import.meta.dir, "ffi-fast-path-compare.ts"), baselines.join(","), candidates.join(","), "--no-output"],
    { encoding: "utf8", timeout: 10_000 },
  )

  expect(child.status).not.toBe(0)
  expect(child.stderr).toContain("duplicate report runId")
})

test("comparison exits unsuccessfully when its acceptance gate fails", () => {
  const root = mkdtempSync(join(tmpdir(), "opentui-ffi-compare-test-"))
  temporaryDirectories.push(root)
  const baseline = join(root, "baseline.json")
  const candidate = join(root, "candidate.json")
  writeReport(baseline, 100, 100, 9)
  writeReport(candidate, 100, 95, 9)

  const child = spawnSync(
    process.execPath,
    [join(import.meta.dir, "ffi-fast-path-compare.ts"), baseline, candidate, "--no-output"],
    { encoding: "utf8", timeout: 10_000 },
  )

  expect(child.status).toBe(1)
})

test("comparison accepts exact inclusive performance boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "opentui-ffi-compare-test-"))
  temporaryDirectories.push(root)
  const baseline = join(root, "baseline.json")
  const candidate = join(root, "candidate.json")
  writeReport(baseline, 100, 100, 9)
  writeReport(candidate, 103, 90, 9)

  const child = spawnSync(
    process.execPath,
    [join(import.meta.dir, "ffi-fast-path-compare.ts"), baseline, candidate, "--no-output"],
    { encoding: "utf8", timeout: 10_000 },
  )

  expect(child.status).toBe(0)
})

function writeReport(path: string, bunNsPerOp: number, nodeNsPerOp: number, rounds = 1, runId = path): void {
  const samples = (nsPerOp: number) => Array.from({ length: rounds }, () => ({ nsPerOp }))
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      benchmark: "opentui-ffi-fast-path",
      runId,
      suite: "default",
      environment: {
        bun: { name: "bun", version: "1.3.14", platform: "darwin", arch: "arm64" },
        node: { name: "node", version: "v26.4.0", platform: "darwin", arch: "arm64" },
      },
      results: [
        {
          name: "scenario",
          rawProcessRounds: { bun: samples(bunNsPerOp), node: samples(nodeNsPerOp) },
        },
      ],
    }),
  )
}
