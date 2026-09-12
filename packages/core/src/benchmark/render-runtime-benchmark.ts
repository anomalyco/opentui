#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isSupportedNode26Version } from "../../../../scripts/node26.mjs"

type RuntimeName = "bun" | "node"

interface ScenarioConfig {
  name: string
  iterations: number
  warmupIterations: number
}

interface ScenarioResult {
  name: string
  avgMs: number
  medianMs: number
  p95Ms: number
  rmePercent: number
}

interface ChildPayload {
  metadata: {
    runtime: { name: RuntimeName; version: string; platform: string; arch: string }
    checksum: number
  }
  scenarios: ScenarioResult[]
}

interface Run extends ScenarioResult {
  round: number
  runtime: RuntimeName
  runtimeVersion: string
  wallMs: number
  checksum: number
}

interface Stats {
  count: number
  mean: number
  median: number
  min: number
  max: number
  sampleStdDev: number
  coefficientOfVariation: number
}

const benchmarkDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(benchmarkDir, "../..")
const sourcePath = join(benchmarkDir, "render-traversal-benchmark.ts")
const buildDir = join(benchmarkDir, ".runtime-build")
const nodeScript = join(buildDir, "render-traversal-benchmark.js")
const nodePath = process.env.NODE26_PATH ?? "node"
const runs = integerArg("runs", 7, 1)
const suite = stringArg("suite", "default")
const scenarioFilter = optionalArg("scenario")
const outputPath = optionalArg("json")
const quiet = process.argv.includes("--no-output")

if (suite !== "quick" && suite !== "default" && suite !== "long") {
  throw new Error(`invalid --suite=${suite}`)
}

const nodeVersion = readNodeVersion()
if (!isSupportedNode26Version(nodeVersion)) {
  throw new Error(`Node v26.4.0 or later is required, got ${nodeVersion}`)
}

const listedScenarios = listScenarios()
const scenarios = listedScenarios
  .filter((name) => !scenarioFilter || scenarioFilter.split(",").includes(name))
  .map((name) => configureScenario(name, suite))

if (scenarios.length === 0) throw new Error("no benchmark scenarios selected")

buildNodeBenchmark()

const results = new Map<string, Run[]>()
for (const scenario of scenarios) {
  results.set(`${scenario.name}:bun`, [])
  results.set(`${scenario.name}:node`, [])
}

try {
  for (let round = 0; round < runs; round++) {
    const scenarioOrder = round % 2 === 0 ? scenarios : [...scenarios].reverse()
    const runtimeOrder: RuntimeName[] = round % 2 === 0 ? ["bun", "node"] : ["node", "bun"]

    for (const scenario of scenarioOrder) {
      for (const runtime of runtimeOrder) {
        if (!quiet) process.stdout.write(`round=${round + 1}/${runs} scenario=${scenario.name} runtime=${runtime}\r`)
        results.get(`${scenario.name}:${runtime}`)!.push(runChild(runtime, scenario, round))
      }
    }
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}

if (!quiet) process.stdout.write("\n")

const summaries = scenarios.map((scenario) => {
  const bun = results.get(`${scenario.name}:bun`)!
  const node = results.get(`${scenario.name}:node`)!
  return {
    name: scenario.name,
    config: scenario,
    bun: summarize(bun),
    node: summarize(node),
    nodeToBun: pairedStats(bun, node, (bunRun, nodeRun) => nodeRun.avgMs / bunRun.avgMs),
    rawRuns: { bun, node },
  }
})

const payload = {
  runId: new Date().toISOString(),
  suite,
  environment: {
    bun: Bun.version,
    node: nodeVersion,
    platform: process.platform,
    arch: process.arch,
    availableParallelism: availableParallelism(),
  },
  config: { runs, scenarios: scenarios.length },
  results: summaries,
}

if (!quiet) {
  for (const summary of summaries) {
    console.log(
      `scenario=${summary.name}` +
        ` bun=${summary.bun.avgMs.median.toFixed(4)}ms` +
        ` node=${summary.node.avgMs.median.toFixed(4)}ms` +
        ` nodeToBun=${summary.nodeToBun.median.toFixed(3)}x`,
    )
  }
}

if (outputPath) {
  writeFileSync(resolve(outputPath), JSON.stringify(payload, null, 2))
  if (!quiet) console.log(`results=${resolve(outputPath)}`)
}

function listScenarios(): string[] {
  const child = spawnSync(process.execPath, [sourcePath, "--list-scenarios"], {
    cwd: packageRoot,
    encoding: "utf8",
  })
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
      sourcePath,
      "--target=node",
      `--outdir=${buildDir}`,
      "--external=@opentui/core-*",
      "--external=web-tree-sitter",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  )
  if (child.status !== 0) throw new Error(`failed to build Node benchmark: ${child.stderr || child.stdout}`)
}

function runChild(runtime: RuntimeName, scenario: ScenarioConfig, round: number): Run {
  const resultPath = join(tmpdir(), `opentui-render-benchmark-${process.pid}-${runtime}-${round}-${scenario.name}.json`)
  rmSync(resultPath, { force: true })

  const command =
    runtime === "bun"
      ? [process.execPath, sourcePath]
      : [nodePath, "--experimental-ffi", "--disable-warning=ExperimentalWarning", nodeScript]
  command.push(
    `--scenario=${scenario.name}`,
    `--iterations=${scenario.iterations}`,
    `--warmup-iterations=${scenario.warmupIterations}`,
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

  if (child.error) throw child.error
  if (child.status !== 0) {
    throw new Error(`${runtime} ${scenario.name} failed: ${child.stderr || child.stdout}`)
  }

  const payload = JSON.parse(readFileSync(resultPath, "utf8")) as ChildPayload
  rmSync(resultPath, { force: true })
  const result = payload.scenarios[0]
  if (!result || result.name !== scenario.name) throw new Error(`${runtime} returned the wrong scenario`)
  if (payload.metadata.runtime.name !== runtime)
    throw new Error(`expected ${runtime}, got ${payload.metadata.runtime.name}`)

  return {
    ...result,
    round,
    runtime,
    runtimeVersion: payload.metadata.runtime.version,
    wallMs,
    checksum: payload.metadata.checksum,
  }
}

function configureScenario(name: string, selectedSuite: string): ScenarioConfig {
  const scale = selectedSuite === "quick" ? 0.25 : selectedSuite === "long" ? 2 : 1
  const nodeCount = Number(name.match(/_(\d+)$/)?.[1] ?? 0)
  const baseIterations = nodeCount >= 10_000 ? 300 : nodeCount >= 5_000 ? 500 : 1_000
  const baseWarmup = nodeCount >= 5_000 ? 100 : 200
  return {
    name,
    iterations: Math.max(25, Math.round(baseIterations * scale)),
    warmupIterations: Math.max(10, Math.round(baseWarmup * scale)),
  }
}

function summarize(runsForRuntime: Run[]) {
  return {
    avgMs: stats(runsForRuntime.map((run) => run.avgMs)),
    medianMs: stats(runsForRuntime.map((run) => run.medianMs)),
    p95Ms: stats(runsForRuntime.map((run) => run.p95Ms)),
    rmePercent: stats(runsForRuntime.map((run) => run.rmePercent)),
    processWallMs: stats(runsForRuntime.map((run) => run.wallMs)),
  }
}

function pairedStats(left: Run[], right: Run[], select: (left: Run, right: Run) => number): Stats {
  const rightByRound = new Map(right.map((run) => [run.round, run]))
  return stats(left.map((run) => select(run, rightByRound.get(run.round)!)))
}

function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b)
  const count = sorted.length
  const mean = sorted.reduce((sum, value) => sum + value, 0) / count
  const median = count % 2 === 0 ? (sorted[count / 2 - 1]! + sorted[count / 2]!) / 2 : sorted[(count - 1) / 2]!
  const variance = count > 1 ? sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1) : 0
  return {
    count,
    mean,
    median,
    min: sorted[0]!,
    max: sorted[count - 1]!,
    sampleStdDev: Math.sqrt(variance),
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / Math.abs(mean),
  }
}

function integerArg(name: string, fallback: number, minimum: number): number {
  const value = Number(stringArg(name, String(fallback)))
  if (!Number.isInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`)
  return value
}

function stringArg(name: string, fallback: string): string {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

function optionalArg(name: string): string | null {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null
}
