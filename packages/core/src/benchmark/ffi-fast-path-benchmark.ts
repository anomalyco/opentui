#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isSupportedNode26Version } from "../../../../scripts/node26.mjs"

type RuntimeName = "bun" | "node"
type SuiteName = "quick" | "default" | "long"

interface ChildPayload {
  schemaVersion: number
  scenario: { name: string; operation: string; description: string }
  sample: {
    runtime: { name: RuntimeName; version: string; platform: string; arch: string }
    targetMs: number
    warmupMs: number
    elapsedNs: number
    operations: number
    nsPerOp: number
    checksum: number
    cpuUserMicros: number
    cpuSystemMicros: number
    voluntaryContextSwitches: number
    involuntaryContextSwitches: number
    calibration: { calibrationConverged: boolean; withinTargetWindow: boolean }
  }
}

type ProcessRoundSample = ChildPayload["sample"] & {
  round: number
  wallMs: number
}

interface Stats {
  count: number
  mean: number
  median: number
  min: number
  max: number
}

const SUITES: Record<SuiteName, { targetMs: number; warmupMs: number }> = {
  quick: { targetMs: 15, warmupMs: 10 },
  default: { targetMs: 75, warmupMs: 30 },
  long: { targetMs: 250, warmupMs: 75 },
}

const benchmarkDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(benchmarkDir, "../..")
const childSource = join(benchmarkDir, "ffi-fast-path-scenarios.ts")
const buildDir = join(benchmarkDir, ".runtime-build")
const nodeScript = join(buildDir, "ffi-fast-path-scenarios.js")
const nodePath = process.env.NODE26_PATH ?? "node"

const suite = stringArg("suite", "default") as SuiteName
if (!(suite in SUITES)) throw new Error(`invalid --suite=${suite}; expected quick, default, or long`)

const listedScenarios = listScenarios("--list-scenarios")
const targetedScenarios = listScenarios("--list-targeted-scenarios")
const selectableScenarios = [...listedScenarios, ...targetedScenarios]
if (process.argv.includes("--list-scenarios")) {
  process.stdout.write(`${listedScenarios.join("\n")}\n`)
  process.exit(0)
}
if (process.argv.includes("--list-targeted-scenarios")) {
  process.stdout.write(`${targetedScenarios.join("\n")}\n`)
  process.exit(0)
}

const runs = integerArg("runs", 9, 1)
const scenarioFilter = optionalArg("scenario")
const outputPath = optionalArg("json")
const quiet = process.argv.includes("--no-output")
const selectedNames = scenarioFilter
  ? scenarioFilter
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  : listedScenarios
const unknownScenarios = selectedNames.filter((name) => !selectableScenarios.includes(name))
if (unknownScenarios.length > 0) throw new Error(`unknown scenarios: ${unknownScenarios.join(", ")}`)
if (selectedNames.length === 0) throw new Error("no benchmark scenarios selected")

const nodeVersion = readNodeVersion()
if (!isSupportedNode26Version(nodeVersion)) {
  throw new Error(`Node v26.4.0 or later is required, got ${nodeVersion}`)
}

const raw = new Map<string, ProcessRoundSample[]>()
const scenarioMetadata = new Map<string, ChildPayload["scenario"]>()
for (const name of selectedNames) {
  raw.set(`${name}:bun`, [])
  raw.set(`${name}:node`, [])
}

try {
  buildNodeBenchmark()
  for (let round = 0; round < runs; round++) {
    const scenarioOrder = round % 2 === 0 ? selectedNames : [...selectedNames].reverse()
    const runtimeOrder: RuntimeName[] = round % 2 === 0 ? ["bun", "node"] : ["node", "bun"]
    for (const name of scenarioOrder) {
      for (const runtime of runtimeOrder) {
        if (!quiet) process.stdout.write(`round=${round + 1}/${runs} scenario=${name} runtime=${runtime}\r`)
        raw.get(`${name}:${runtime}`)!.push(runChild(runtime, name, round))
      }
    }
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}

if (!quiet) process.stdout.write("\n")

const results = selectedNames.map((name) => {
  const bun = raw.get(`${name}:bun`)!
  const node = raw.get(`${name}:node`)!
  const first = bun[0]!
  const child = scenarioMetadata.get(name)
  if (!child) throw new Error(`missing metadata for ${name}`)
  return {
    name,
    operation: child.operation,
    description: child.description,
    config: { targetMs: first.targetMs, warmupMs: first.warmupMs },
    bun: summarize(bun),
    node: summarize(node),
    rawProcessRounds: { bun, node },
  }
})
const firstResult = results[0]!
const firstBunRound = firstResult.rawProcessRounds.bun[0]!
const firstNodeRound = firstResult.rawProcessRounds.node[0]!

const payload = {
  schemaVersion: 1,
  benchmark: "opentui-ffi-fast-path",
  runId: new Date().toISOString(),
  suite,
  environment: {
    bun: firstBunRound.runtime,
    node: firstNodeRound.runtime,
    availableParallelism: availableParallelism(),
  },
  config: { runs, scenarios: selectedNames.length, ...SUITES[suite] },
  results,
}

if (!quiet) {
  for (const result of results) {
    console.log(
      `scenario=${result.name} bun=${result.bun.nsPerOp.median.toFixed(1)}ns/op` +
        ` node=${result.node.nsPerOp.median.toFixed(1)}ns/op` +
        ` operations=${result.bun.operationCounts.total}/${result.node.operationCounts.total}`,
    )
  }
}

if (outputPath) {
  writeFileSync(resolve(outputPath), JSON.stringify(payload, null, 2))
  if (!quiet) console.log(`results=${resolve(outputPath)}`)
}

function listScenarios(argument: "--list-scenarios" | "--list-targeted-scenarios"): string[] {
  const child = spawnSync(process.execPath, [childSource, argument], {
    cwd: packageRoot,
    encoding: "utf8",
  })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`failed to list scenarios: ${child.stderr || child.stdout}`)
  return child.stdout.trim().split("\n").filter(Boolean)
}

function readNodeVersion(): string {
  const child = spawnSync(nodePath, ["--version"], { encoding: "utf8" })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`failed to read Node version: ${child.stderr}`)
  return child.stdout.trim()
}

function buildNodeBenchmark(): void {
  rmSync(buildDir, { recursive: true, force: true })
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
  if (child.status !== 0) throw new Error(`failed to build Node benchmark: ${child.stderr || child.stdout}`)
}

function runChild(runtime: RuntimeName, scenario: string, round: number): ProcessRoundSample {
  const resultPath = join(tmpdir(), `opentui-ffi-fast-${process.pid}-${runtime}-${round}-${scenario}.json`)
  rmSync(resultPath, { force: true })
  const command =
    runtime === "bun"
      ? [process.execPath, childSource]
      : [nodePath, "--experimental-ffi", "--disable-warning=ExperimentalWarning", nodeScript]
  command.push(
    `--scenario=${scenario}`,
    `--target-ms=${SUITES[suite].targetMs}`,
    `--warmup-ms=${SUITES[suite].warmupMs}`,
    `--json=${resultPath}`,
    "--no-output",
  )

  const start = performance.now()
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd: packageRoot,
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  })
  const wallMs = performance.now() - start

  try {
    if (child.error) throw child.error
    // Signal-terminated children can have no status or output, so retain all process metadata.
    if (child.status !== 0) {
      throw new Error(
        `${runtime} ${scenario} failed in round ${round + 1}/${runs} (status=${child.status ?? "null"}, signal=${child.signal ?? "none"}): ${child.stderr || child.stdout}`,
      )
    }

    const payload = JSON.parse(readFileSync(resultPath, "utf8")) as ChildPayload
    if (payload.schemaVersion !== 1 || payload.scenario.name !== scenario) {
      throw new Error(`${runtime} returned invalid metadata for ${scenario}`)
    }
    if (payload.sample.runtime.name !== runtime)
      throw new Error(`expected ${runtime}, got ${payload.sample.runtime.name}`)
    if (payload.sample.operations < 1 || payload.sample.elapsedNs <= 0 || payload.sample.checksum === 0) {
      throw new Error(`${runtime} returned an invalid sample for ${scenario}`)
    }
    if (!hasValidDiagnostics(payload.sample)) {
      throw new Error(`${runtime} returned invalid calibration diagnostics for ${scenario}`)
    }
    const existingMetadata = scenarioMetadata.get(scenario)
    if (existingMetadata && existingMetadata.operation !== payload.scenario.operation) {
      throw new Error(`inconsistent metadata for ${scenario}`)
    }
    scenarioMetadata.set(scenario, payload.scenario)
    return { ...payload.sample, round, wallMs }
  } finally {
    rmSync(resultPath, { force: true })
  }
}

function hasValidDiagnostics(sample: ChildPayload["sample"]): boolean {
  return (
    sample.calibration?.calibrationConverged === true &&
    Number.isFinite(sample.cpuUserMicros) &&
    sample.cpuUserMicros >= 0 &&
    Number.isFinite(sample.cpuSystemMicros) &&
    sample.cpuSystemMicros >= 0 &&
    Number.isFinite(sample.voluntaryContextSwitches) &&
    sample.voluntaryContextSwitches >= 0 &&
    Number.isFinite(sample.involuntaryContextSwitches) &&
    sample.involuntaryContextSwitches >= 0
  )
}

function summarize(samples: ProcessRoundSample[]) {
  return {
    nsPerOp: stats(samples.map((sample) => sample.nsPerOp)),
    processWallMs: stats(samples.map((sample) => sample.wallMs)),
    operationCounts: {
      min: Math.min(...samples.map((sample) => sample.operations)),
      max: Math.max(...samples.map((sample) => sample.operations)),
      total: samples.reduce((total, sample) => total + sample.operations, 0),
    },
    checksums: samples.map((sample) => sample.checksum),
  }
}

function stats(values: number[]): Stats {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    median: median(sorted),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  }
}

function median(sortedValues: number[]): number {
  const middle = Math.floor(sortedValues.length / 2)
  return sortedValues.length % 2 === 0 ? (sortedValues[middle - 1]! + sortedValues[middle]!) / 2 : sortedValues[middle]!
}

function integerArg(name: string, fallback: number, minimum: number): number {
  const value = Number(stringArg(name, String(fallback)))
  if (!Number.isInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`)
  return value
}

function stringArg(name: string, fallback: string): string {
  return optionalArg(name) ?? fallback
}

function optionalArg(name: string): string | null {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null
}
