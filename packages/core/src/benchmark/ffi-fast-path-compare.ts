#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type RuntimeName = "bun" | "node"

interface ProcessRoundSample {
  nsPerOp: number
}

interface ScenarioResult {
  name: string
  rawProcessRounds: Record<RuntimeName, ProcessRoundSample[]>
}

interface BenchmarkReport {
  schemaVersion: number
  benchmark: string
  runId: string
  suite: string
  environment: Record<RuntimeName, { name: RuntimeName; version: string; platform: string; arch: string }>
  results: ScenarioResult[]
}

const BOOTSTRAP_SAMPLES = 20_000
const MINIMUM_PROCESS_ROUNDS = 9
const ACCEPTANCE_EPSILON = Number.EPSILON
const baselinePath = process.argv[2]
const candidatePath = process.argv[3]
if (!baselinePath || !candidatePath) {
  throw new Error(
    "usage: bun run bench:ffi-fast-path-compare <baseline.json[,baseline2.json...]> <candidate.json[,candidate2.json...]> [--json=<path>] [--no-output]",
  )
}

const baselineReports = readReports(baselinePath)
const candidateReports = readReports(candidatePath)
const baseline = mergeReports(baselineReports)
const candidate = mergeReports(candidateReports)
validateReports(baseline, candidate)
const baselineByName = new Map(baseline.results.map((result) => [result.name, result]))

const results = candidate.results.map((after) => {
  const before = baselineByName.get(after.name)
  if (!before) throw new Error(`baseline is missing scenario ${after.name}`)
  return {
    name: after.name,
    bun: compareRuntime(before, after, "bun"),
    node: compareRuntime(before, after, "node"),
  }
})

const payload = {
  schemaVersion: 1,
  benchmark: "opentui-ffi-fast-path-comparison",
  baselineRunId: baseline.runId,
  candidateRunId: candidate.runId,
  baselineRunIds: baselineReports.map((report) => report.runId),
  candidateRunIds: candidateReports.map((report) => report.runId),
  bootstrap: { samples: BOOTSTRAP_SAMPLES, confidence: 0.95, samplingUnit: "independent process round" },
  acceptance: {
    minimumProcessRoundsPerRevision: MINIMUM_PROCESS_ROUNDS,
    node: "at least 9 rounds, median improvement >= 10%, and CI upper bound <= -10%",
    bun: "at least 9 rounds, median regression <= 3%, and CI upper bound <= 3%",
    passed: results.every((result) => result.node.accepted && result.bun.accepted),
  },
  results,
}

if (!process.argv.includes("--no-output")) {
  console.log("| Scenario | Bun ratio | Bun 95% CI | Bun | Node ratio | Node 95% CI | Node |")
  console.log("| --- | ---: | ---: | :---: | ---: | ---: | :---: |")
  for (const result of results) {
    console.log(
      `| ${result.name} | ${formatRatio(result.bun.medianRatio)} | ${formatCi(result.bun.ci95)} | ${formatPass(result.bun.accepted)} |` +
        ` ${formatRatio(result.node.medianRatio)} | ${formatCi(result.node.ci95)} | ${formatPass(result.node.accepted)} |`,
    )
  }
}

const jsonPath = optionalArg("json")
if (jsonPath) writeFileSync(resolve(jsonPath), JSON.stringify(payload, null, 2))
if (!payload.acceptance.passed) process.exitCode = 1

function compareRuntime(before: ScenarioResult, after: ScenarioResult, runtime: RuntimeName) {
  const baselineValues = sampleValues(before, runtime)
  const candidateValues = sampleValues(after, runtime)
  const baselineMedianNsPerOp = median(baselineValues)
  const candidateMedianNsPerOp = median(candidateValues)
  const medianRatio = candidateMedianNsPerOp / baselineMedianNsPerOp
  const medianChange = medianRatio - 1
  const ci95 = bootstrapMedianChange(
    baselineValues,
    candidateValues,
    seedFromString(`${before.name}:${runtime}:opentui-ffi-fast-path-v1`),
  )
  const enoughRounds =
    baselineValues.length >= MINIMUM_PROCESS_ROUNDS && candidateValues.length >= MINIMUM_PROCESS_ROUNDS
  const accepted =
    enoughRounds &&
    (runtime === "node"
      ? medianChange <= -0.1 + ACCEPTANCE_EPSILON && ci95.upper <= -0.1 + ACCEPTANCE_EPSILON
      : medianChange <= 0.03 + ACCEPTANCE_EPSILON && ci95.upper <= 0.03 + ACCEPTANCE_EPSILON)
  return {
    baselineMedianNsPerOp,
    candidateMedianNsPerOp,
    medianRatio,
    medianChange,
    ci95,
    baselineRounds: baselineValues.length,
    candidateRounds: candidateValues.length,
    enoughRounds,
    accepted,
  }
}

function bootstrapMedianChange(baseline: number[], candidate: number[], seed: number) {
  const random = mulberry32(seed)
  const changes = new Array<number>(BOOTSTRAP_SAMPLES)
  const baselineResample = new Array<number>(baseline.length)
  const candidateResample = new Array<number>(candidate.length)

  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample++) {
    for (let index = 0; index < baseline.length; index++) {
      baselineResample[index] = baseline[Math.floor(random() * baseline.length)]!
    }
    for (let index = 0; index < candidate.length; index++) {
      candidateResample[index] = candidate[Math.floor(random() * candidate.length)]!
    }
    changes[sample] = median(candidateResample) / median(baselineResample) - 1
  }

  changes.sort((left, right) => left - right)
  return {
    lower: percentile(changes, 0.025),
    upper: percentile(changes, 0.975),
  }
}

function sampleValues(result: ScenarioResult, runtime: RuntimeName): number[] {
  const values = result.rawProcessRounds[runtime]?.map((sample) => sample.nsPerOp)
  if (!values || values.length === 0 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${result.name} has invalid ${runtime} process-round samples`)
  }
  return values
}

function validateReports(baselineReport: BenchmarkReport, candidateReport: BenchmarkReport): void {
  for (const report of [baselineReport, candidateReport]) {
    if (report.schemaVersion !== 1 || report.benchmark !== "opentui-ffi-fast-path") {
      throw new Error("input is not an ffi-fast-path benchmark report")
    }
  }
  if (baselineReport.suite !== candidateReport.suite) throw new Error("suite mismatch")
  if (
    baselineReport.environment.bun.version !== candidateReport.environment.bun.version ||
    baselineReport.environment.node.version !== candidateReport.environment.node.version
  ) {
    throw new Error("Bun or Node version mismatch")
  }
  if (
    baselineReport.environment.bun.platform !== candidateReport.environment.bun.platform ||
    baselineReport.environment.bun.arch !== candidateReport.environment.bun.arch ||
    baselineReport.environment.node.platform !== candidateReport.environment.node.platform ||
    baselineReport.environment.node.arch !== candidateReport.environment.node.arch
  ) {
    throw new Error("platform or architecture mismatch")
  }
  const candidateNames = new Set(candidateReport.results.map((result) => result.name))
  const extraBaselineNames = baselineReport.results.filter((result) => !candidateNames.has(result.name))
  if (extraBaselineNames.length > 0) {
    throw new Error(`candidate is missing scenarios: ${extraBaselineNames.map((result) => result.name).join(", ")}`)
  }
}

function readReport(path: string): BenchmarkReport {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as BenchmarkReport
}

function readReports(paths: string): BenchmarkReport[] {
  const resolvedPaths = paths.split(",").map((path) => resolve(path))
  if (new Set(resolvedPaths).size !== resolvedPaths.length) throw new Error("duplicate report path")
  const reports = resolvedPaths.map((path) => readReport(path))
  if (new Set(reports.map((report) => report.runId)).size !== reports.length) {
    throw new Error("duplicate report runId")
  }
  return reports
}

function mergeReports(reports: BenchmarkReport[]): BenchmarkReport {
  const first = reports[0]
  if (!first) throw new Error("at least one report is required")

  const merged = structuredClone(first)
  const resultsByReport = reports.map((report) => {
    validateReports(first, report)
    validateReports(report, first)
    return new Map(report.results.map((result) => [result.name, result]))
  })
  merged.runId = reports.map((report) => report.runId).join(",")
  for (const result of merged.results) {
    result.rawProcessRounds = {
      bun: resultsByReport.flatMap((results) => results.get(result.name)!.rawProcessRounds.bun),
      node: resultsByReport.flatMap((results) => results.get(result.name)!.rawProcessRounds.node),
    }
  }
  return merged
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function percentile(sortedValues: number[], probability: number): number {
  const index = (sortedValues.length - 1) * probability
  const lower = Math.floor(index)
  const fraction = index - lower
  return (
    sortedValues[lower]! +
    (sortedValues[Math.min(lower + 1, sortedValues.length - 1)]! - sortedValues[lower]!) * fraction
  )
}

function seedFromString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function formatRatio(value: number): string {
  return `${value.toFixed(3)}x (${formatPercent(value - 1)})`
}

function formatCi(ci: { lower: number; upper: number }): string {
  return `[${formatPercent(ci.lower)}, ${formatPercent(ci.upper)}]`
}

function formatPercent(value: number): string {
  const percent = value * 100
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`
}

function formatPass(value: boolean): string {
  return value ? "pass" : "fail"
}

function optionalArg(name: string): string | null {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null
}
