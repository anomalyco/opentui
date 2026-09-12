#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, cpus, hostname, release } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

interface ChildPayload {
  schemaVersion: number
  scenario: { name: string; operation: string; description: string }
  sample: {
    runtime: { name: string; version: string; platform: string; arch: string }
    targetMs: number
    warmupMs: number
    elapsedNs: number
    operations: number
    nsPerOp: number
    checksum: number
  }
}

interface Attempt {
  attempt: number
  startedAt: string
  wallMs: number
  status: number | null
  signal: NodeJS.Signals | null
  error: { name: string; message: string; code?: string } | null
  classification: "success" | "target-crash" | "other-crash" | "error"
  payloadWritten: boolean
  payloadValid: boolean
  reportWritten: boolean
  operations: number | null
  checksum: number | null
  stdout: string | null
  stderr: string | null
  result: string
  report: string
}

const benchmarkDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(benchmarkDir, "../..")
const childSource = join(benchmarkDir, "ffi-fast-path-scenarios.ts")
const buildDir = join(benchmarkDir, ".runtime-build")
const outputValue = stringArg("output", join(benchmarkDir, "ffi-fast-path-stress-output"))
if (!outputValue) throw new Error("--output must not be empty")
const outputDir = resolve(outputValue)
if (outputDir === packageRoot) throw new Error("--output must not be the package root")
mkdirSync(outputDir, { recursive: true })
if (existsSync(buildDir)) {
  const outputBuildRelative = relative(realpathSync.native(buildDir), realpathSync.native(outputDir))
  if (outputBuildRelative === "" || (!isAbsolute(outputBuildRelative) && outputBuildRelative.split(sep)[0] !== "..")) {
    throw new Error("--output must not be inside the runtime build directory")
  }
}
const attemptsDir = join(outputDir, "attempts")
const reportsDir = join(outputDir, "node-reports")
const nodeScript = join(buildDir, "ffi-fast-path-scenarios.js")
const manifestPath = join(outputDir, "manifest.json")
const summaryPath = join(outputDir, "summary.md")
const nodePath = process.env.NODE26_PATH ?? "node"
const scenario = stringArg("scenario", "reusable_logical_cursor_public")
const runs = integerArg("runs", 600, 1, 1_200)
const targetMs = positiveNumberArg("target-ms", 15, 250)
const warmupMs = positiveNumberArg("warmup-ms", 10, 75)
const timeoutMs = integerArg("timeout-ms", 120_000, 1, 120_000)
const label = stringArg("label", `${process.platform}-${process.arch}`)
const allowCrashes = process.argv.includes("--allow-crashes")
const nodeFlags = [
  "--experimental-ffi",
  "--disable-warning=ExperimentalWarning",
  "--report-on-fatalerror",
  `--report-directory=${reportsDir}`,
]

rmSync(attemptsDir, { recursive: true, force: true })
rmSync(reportsDir, { recursive: true, force: true })
rmSync(manifestPath, { force: true })
rmSync(summaryPath, { force: true })
rmSync(buildDir, { recursive: true, force: true })
mkdirSync(attemptsDir, { recursive: true })
mkdirSync(reportsDir, { recursive: true })

const nodeRuntime = readNodeRuntime()
if (!isSupportedNode26Version(nodeRuntime.version)) {
  throw new Error(`Node v26.4.0 or later is required, got ${nodeRuntime.version}`)
}
if (nodeRuntime.arch !== "x64") throw new Error(`Node x64 is required, got ${nodeRuntime.arch}`)

buildNodeScenario()

const attempts: Attempt[] = []
const manifest = {
  schemaVersion: 1,
  diagnostic: "opentui-node-ffi-teardown-stress",
  startedAt: new Date().toISOString(),
  completedAt: null as string | null,
  label,
  config: { scenario, runs, targetMs, warmupMs, timeoutMs, allowCrashes, nodeFlags },
  environment: {
    host: {
      runtime: process.versions.bun ? "bun" : "node",
      version: process.versions.bun ?? process.version,
      platform: process.platform,
      arch: process.arch,
      release: release(),
      hostname: hostname(),
      cpu: cpus()[0]?.model ?? "unknown",
      availableParallelism: availableParallelism(),
    },
    node: nodeRuntime,
    ci: process.env.CI ?? null,
    github: {
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      sha: process.env.GITHUB_SHA ?? null,
      ref: process.env.GITHUB_REF ?? null,
      runnerName: process.env.RUNNER_NAME ?? null,
      runnerArch: process.env.RUNNER_ARCH ?? null,
      runnerOs: process.env.RUNNER_OS ?? null,
    },
  },
  summary: { completed: 0, successes: 0, targetCrashes: 0, otherCrashes: 0, errors: 0, operations: 0 },
  attempts,
}

writeManifest()

for (let attemptIndex = 0; attemptIndex < runs; attemptIndex++) {
  const attemptNumber = attemptIndex + 1
  const attemptName = `attempt-${String(attemptNumber).padStart(4, "0")}`
  const resultPath = join(attemptsDir, `${attemptName}.json`)
  const stdoutPath = join(attemptsDir, `${attemptName}.stdout.txt`)
  const stderrPath = join(attemptsDir, `${attemptName}.stderr.txt`)
  const reportPath = join(reportsDir, `${attemptName}.json`)
  const commandArgs = [
    ...nodeFlags,
    `--report-filename=${attemptName}.json`,
    nodeScript,
    `--scenario=${scenario}`,
    `--target-ms=${targetMs}`,
    `--warmup-ms=${warmupMs}`,
    `--json=${resultPath}`,
    "--no-output",
  ]

  const startedAt = new Date().toISOString()
  const start = performance.now()
  const child = spawnSync(nodePath, commandArgs, {
    cwd: packageRoot,
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs,
  })
  const wallMs = performance.now() - start
  const stdout = child.stdout || ""
  const stderr = child.stderr || ""
  if (stdout) writeFileSync(stdoutPath, stdout)
  if (stderr) writeFileSync(stderrPath, stderr)

  let payload: ChildPayload | null = null
  let payloadValid = false
  let payloadError: Error | null = null
  try {
    payload = JSON.parse(readFileSync(resultPath, "utf8")) as ChildPayload
    payloadValid =
      payload.schemaVersion === 1 &&
      payload.scenario.name === scenario &&
      payload.sample.runtime.name === "node" &&
      isSupportedNode26Version(payload.sample.runtime.version) &&
      payload.sample.runtime.arch === "x64" &&
      payload.sample.operations > 0 &&
      payload.sample.elapsedNs > 0 &&
      payload.sample.checksum !== 0
  } catch (error) {
    payloadError = error instanceof Error ? error : new Error(String(error))
  }

  const processError = child.error
    ? {
        name: child.error.name,
        message: child.error.message,
        ...(typeof (child.error as NodeJS.ErrnoException).code === "string"
          ? { code: (child.error as NodeJS.ErrnoException).code }
          : {}),
      }
    : payloadError && child.status === 0
      ? { name: payloadError.name, message: payloadError.message }
      : null
  const classification = classifyAttempt(child.status, child.signal, processError, payloadValid)
  const error =
    processError ??
    (classification === "error"
      ? {
          name: "ChildProcessExitError",
          message: `child exited with status ${child.status ?? "null"} and signal ${child.signal ?? "none"}`,
        }
      : null)
  const attempt: Attempt = {
    attempt: attemptNumber,
    startedAt,
    wallMs,
    status: child.status,
    signal: child.signal,
    error,
    classification,
    payloadWritten: payload !== null,
    payloadValid,
    reportWritten: existsSync(reportPath),
    operations: payload?.sample.operations ?? null,
    checksum: payload?.sample.checksum ?? null,
    stdout: stdout ? relativeOutputPath(stdoutPath) : null,
    stderr: stderr ? relativeOutputPath(stderrPath) : null,
    result: relativeOutputPath(resultPath),
    report: relativeOutputPath(reportPath),
  }
  attempts.push(attempt)
  manifest.summary.completed = attempts.length
  manifest.summary.successes += classification === "success" ? 1 : 0
  manifest.summary.targetCrashes += classification === "target-crash" ? 1 : 0
  manifest.summary.otherCrashes += classification === "other-crash" ? 1 : 0
  manifest.summary.errors += classification === "error" ? 1 : 0
  manifest.summary.operations += payload?.sample.operations ?? 0
  writeManifest()

  process.stdout.write(
    `attempt=${attemptNumber}/${runs} classification=${classification} status=${child.status ?? "null"}` +
      ` signal=${child.signal ?? "none"} payload=${payloadValid ? "valid" : payload ? "invalid" : "missing"}\n`,
  )
  if (classification === "error") break
}

manifest.completedAt = new Date().toISOString()
writeManifest()
writeSummary()
rmSync(buildDir, { recursive: true, force: true })

console.log(
  `stress complete: successes=${manifest.summary.successes} targetCrashes=${manifest.summary.targetCrashes}` +
    ` otherCrashes=${manifest.summary.otherCrashes} errors=${manifest.summary.errors} manifest=${manifestPath}`,
)

if (
  manifest.summary.errors > 0 ||
  (!allowCrashes && (manifest.summary.targetCrashes > 0 || manifest.summary.otherCrashes > 0))
)
  process.exit(1)

function isSupportedNode26Version(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return false

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (major !== 26) return major > 26
  if (minor !== 4) return minor > 4
  return patch >= 0
}

function readNodeRuntime(): {
  version: string
  execPath: string
  platform: string
  arch: string
  versions: NodeJS.ProcessVersions
} {
  const child = spawnSync(
    nodePath,
    [
      "--eval",
      "process.stdout.write(JSON.stringify({ version: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch, versions: process.versions }))",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  )
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`failed to inspect Node: ${child.stderr || child.stdout}`)
  return JSON.parse(child.stdout)
}

function buildNodeScenario(): void {
  const child = spawnSync(
    process.execPath,
    [
      "build",
      childSource,
      "--target=node",
      `--outdir=${buildDir}`,
      "--external=@opentui/core-*",
      "--external=web-tree-sitter",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  )
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`failed to build Node stress scenario: ${child.stderr || child.stdout}`)
}

function classifyAttempt(
  status: number | null,
  signal: NodeJS.Signals | null,
  error: Attempt["error"],
  payloadValid: boolean,
): Attempt["classification"] {
  if (error) return "error"
  if (payloadValid && (signal === "SIGSEGV" || isWindowsAccessViolation(status))) return "target-crash"
  if (signal || isWindowsCrashStatus(status)) return "other-crash"
  if (status === 0 && payloadValid) return "success"
  return "error"
}

function isWindowsCrashStatus(status: number | null): boolean {
  if (process.platform !== "win32" || status === null) return false
  const unsigned = status >>> 0
  return unsigned >= 0xc0000000 && unsigned <= 0xcfffffff
}

function isWindowsAccessViolation(status: number | null): boolean {
  return process.platform === "win32" && status !== null && status >>> 0 === 0xc0000005
}

function writeManifest(): void {
  const temporaryPath = `${manifestPath}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`)
  rmSync(manifestPath, { force: true })
  renameSync(temporaryPath, manifestPath)
}

function writeSummary(): void {
  const lines = [
    `### Node FFI teardown stress: ${label}`,
    "",
    `- Host: \`${manifest.environment.host.platform}-${manifest.environment.host.arch}\` (${manifest.environment.host.cpu})`,
    `- Node: \`${nodeRuntime.version} ${nodeRuntime.platform}-${nodeRuntime.arch}\``,
    `- Scenario: \`${scenario}\``,
    `- Attempts: ${manifest.summary.completed}/${runs}`,
    `- Successful exits: ${manifest.summary.successes}`,
    `- Target teardown crashes: ${manifest.summary.targetCrashes}`,
    `- Other crashes: ${manifest.summary.otherCrashes}`,
    `- Other errors: ${manifest.summary.errors}`,
    `- Timed FFI operations: ${manifest.summary.operations}`,
    "",
  ]
  writeFileSync(summaryPath, `${lines.join("\n")}\n`)
}

function relativeOutputPath(path: string): string {
  return path.slice(outputDir.length + 1).replaceAll("\\", "/")
}

function positiveNumberArg(name: string, fallback: number, maximum: number): number {
  const value = Number(stringArg(name, String(fallback)))
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`--${name} must be a positive number <= ${maximum}`)
  }
  return value
}

function integerArg(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(stringArg(name, String(fallback)))
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function stringArg(name: string, fallback: string): string {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback
}
