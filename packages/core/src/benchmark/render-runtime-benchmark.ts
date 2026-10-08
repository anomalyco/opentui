#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isSupportedNode26Version } from "../../../../scripts/node26.mjs"
import type { ParityEvidence, ScenarioResult } from "./render-traversal-benchmark.js"

type RuntimeName = "bun" | "node"

interface ScenarioConfig {
  name: string
  iterations: number
  warmupIterations: number
}

interface ChildPayload {
  metadata: {
    runtime: { name: RuntimeName; version: string; platform: string; arch: string }
    checksum: number
    sink: "memory"
    parity: Record<string, ParityEvidence>
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
if (optionalArg("scene-backend") !== null) {
  throw new Error("--scene-backend has been removed; the renderer uses native scenes")
}

const nodeVersion = readNodeVersion()
if (!isSupportedNode26Version(nodeVersion)) {
  throw new Error(`Node v26.4.0 or later is required, got ${nodeVersion}`)
}

const verifiedScenarios = new Set(listScenarios(true))
const listedScenarios = listScenarios()
const requestedScenarios = scenarioFilter?.split(",")
for (const name of requestedScenarios ?? []) {
  if (!listedScenarios.includes(name)) throw new Error(`unknown scenario: ${name}`)
}
const scenarios = listedScenarios
  .filter((name) => !requestedScenarios || requestedScenarios.includes(name))
  .map((name) => configureScenario(name, suite))

if (scenarios.length === 0) throw new Error("no benchmark scenarios selected")

const results = new Map<string, Run[]>()
const parity = new Map<string, ParityEvidence>()
for (const scenario of scenarios) {
  results.set(`${scenario.name}:bun`, [])
  results.set(`${scenario.name}:node`, [])
}

try {
  buildNodeBenchmark()
  for (const scenario of scenarios.filter((scenario) => verifiedScenarios.has(scenario.name))) {
    for (const runtime of ["bun", "node"] as const) {
      if (!quiet) console.log(`verifying scenario=${scenario.name} runtime=${runtime}`)
      const child = runChild(runtime, scenario, -1, true)
      const evidence = child.metadata.parity[scenario.name]
      assert.ok(evidence, `${runtime} returned no parity evidence for ${scenario.name}`)
      if (parity.has(scenario.name)) {
        assert.deepEqual(evidence, parity.get(scenario.name), `${scenario.name}: runtime output parity failed`)
      }
      parity.set(scenario.name, evidence)
    }
  }
  for (let round = 0; round < runs; round++) {
    const scenarioOrder = round % 2 === 0 ? scenarios : [...scenarios].reverse()
    const runtimeOrder: RuntimeName[] = round % 2 === 0 ? ["bun", "node"] : ["node", "bun"]

    for (const scenario of scenarioOrder) {
      for (const runtime of runtimeOrder) {
        if (!quiet) process.stdout.write(`round=${round + 1}/${runs} scenario=${scenario.name} runtime=${runtime}\r`)
        const child = runChild(runtime, scenario, round)
        assert.deepEqual(child.metadata.parity[scenario.name], parity.get(scenario.name), "parity evidence changed")
        results.get(`${scenario.name}:${runtime}`)!.push({
          ...child.scenarios[0]!,
          round,
          runtime,
          runtimeVersion: child.metadata.runtime.version,
          wallMs: child.wallMs,
          checksum: child.metadata.checksum,
        })
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
  const sceneNodes = bun[0]!.sceneNodes
  for (const run of [...bun, ...node]) {
    assert.deepEqual(run.sceneNodes, sceneNodes, `${scenario.name}: scene node counts differ between runs`)
  }
  return {
    name: scenario.name,
    config: scenario,
    sceneNodes,
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
  config: { runs, scenarios: scenarios.length, sink: "memory" },
  parity: Object.fromEntries(parity),
  results: summaries,
}

if (!quiet) {
  for (const summary of summaries) {
    console.log(
      `scenario=${summary.name}` +
        ` bun=${summary.bun.avgMs.median.toFixed(4)}ms` +
        ` node=${summary.node.avgMs.median.toFixed(4)}ms` +
        ` nodeToBun=${summary.nodeToBun.median.toFixed(3)}x` +
        (summary.sceneNodes
          ? ` sceneNodes=${summary.sceneNodes.initial}->${summary.sceneNodes.timedMin}-${summary.sceneNodes.timedMax} limit=${summary.sceneNodes.limit}`
          : "") +
        (summary.bun.scene && summary.node.scene
          ? ` sceneBun=${summary.bun.scene.avgMs.median.toFixed(4)}ms sceneNode=${summary.node.scene.avgMs.median.toFixed(4)}ms`
          : "") +
        (summary.bun.nativeRender && summary.node.nativeRender
          ? ` nativeRenderBun=${summary.bun.nativeRender.avgMs.median.toFixed(4)}ms nativeRenderNode=${summary.node.nativeRender.avgMs.median.toFixed(4)}ms`
          : ""),
    )
  }
}

if (outputPath) {
  writeFileSync(resolve(outputPath), JSON.stringify(payload, null, 2))
  if (!quiet) console.log(`results=${resolve(outputPath)}`)
}

function listScenarios(verifyOnly = false): string[] {
  const child = spawnSync(
    process.execPath,
    [sourcePath, "--list-scenarios", ...(verifyOnly ? ["--verify-only"] : [])],
    {
      cwd: packageRoot,
      encoding: "utf8",
    },
  )
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

function runChild(
  runtime: RuntimeName,
  scenario: ScenarioConfig,
  round: number,
  verifyOnly = false,
): ChildPayload & { wallMs: number } {
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
  if (verifyOnly) command.push("--verify-only")

  try {
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
    if (!verifyOnly) {
      const result = payload.scenarios[0]
      if (!result || result.name !== scenario.name) throw new Error(`${runtime} returned the wrong scenario`)
      if (verifiedScenarios.has(scenario.name) && !result.scene) throw new Error(`${runtime} returned no scene timing`)
      if (verifiedScenarios.has(scenario.name) && !result.nativeRender)
        throw new Error(`${runtime} returned no native render timing`)
    }
    assert.equal(payload.metadata.runtime.name, runtime)
    assert.equal(payload.metadata.sink, "memory")

    return { ...payload, wallMs }
  } finally {
    rmSync(resultPath, { force: true })
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
  const scenes = runsForRuntime.flatMap((run) => (run.scene ? [run.scene] : []))
  const nativeRenders = runsForRuntime.flatMap((run) => (run.nativeRender ? [run.nativeRender] : []))
  assert.ok(scenes.length === 0 || scenes.length === runsForRuntime.length, "incomplete scene timing samples")
  assert.equal(nativeRenders.length, scenes.length, "incomplete native render timing samples")
  return {
    avgMs: stats(runsForRuntime.map((run) => run.avgMs)),
    medianMs: stats(runsForRuntime.map((run) => run.medianMs)),
    p95Ms: stats(runsForRuntime.map((run) => run.p95Ms)),
    rmePercent: stats(runsForRuntime.map((run) => run.rmePercent)),
    processWallMs: stats(runsForRuntime.map((run) => run.wallMs)),
    scene:
      scenes.length > 0
        ? {
            avgMs: stats(scenes.map((scene) => scene.avgMs)),
            medianMs: stats(scenes.map((scene) => scene.medianMs)),
            p95Ms: stats(scenes.map((scene) => scene.p95Ms)),
            rmePercent: stats(scenes.map((scene) => scene.rmePercent)),
          }
        : undefined,
    nativeRender:
      nativeRenders.length > 0
        ? {
            avgMs: stats(nativeRenders.map((render) => render.avgMs)),
            medianMs: stats(nativeRenders.map((render) => render.medianMs)),
            p95Ms: stats(nativeRenders.map((render) => render.p95Ms)),
            rmePercent: stats(nativeRenders.map((render) => render.rmePercent)),
          }
        : undefined,
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
  return optionalArg(name) ?? fallback
}

function optionalArg(name: string): string | null {
  const prefix = `--${name}=`
  const index = process.argv.findIndex((argument) => argument === `--${name}` || argument.startsWith(prefix))
  if (index === -1) return null
  const argument = process.argv[index]!
  if (argument.startsWith(prefix)) return argument.slice(prefix.length)
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`)
  return value
}
