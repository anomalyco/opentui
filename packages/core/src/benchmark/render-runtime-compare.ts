#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import type { ParityEvidence, SceneNodeCounts } from "./render-traversal-benchmark.js"

interface Stats {
  median: number
}

interface RuntimeSummary {
  avgMs: Stats
  scene?: { avgMs: Stats }
  nativeRender?: { avgMs: Stats }
}

interface ScenarioSummary {
  name: string
  bun: RuntimeSummary
  node: RuntimeSummary
  nodeToBun: Stats
  sceneNodes?: SceneNodeCounts
}

interface BenchmarkReport {
  runId: string
  parity?: Record<string, ParityEvidence>
  results: ScenarioSummary[]
}

const baselinePath = process.argv[2]
const currentPath = process.argv[3]
if (!baselinePath || !currentPath) {
  throw new Error("usage: bun render-runtime-compare.ts <baseline.json> <current.json> [--json=<path>]")
}

const baseline = readReport(baselinePath)
const current = readReport(currentPath)
const baselineByName = new Map(baseline.results.map((result) => [result.name, result]))

const comparisons = current.results.map((result) => {
  const before = baselineByName.get(result.name)
  if (!before) throw new Error(`baseline is missing scenario ${result.name}`)
  assert.deepEqual(before.sceneNodes, result.sceneNodes, `${result.name}: scene node counts differ`)
  if (baseline.parity?.[result.name] && current.parity?.[result.name]) {
    // Historical reports used a live backend comparison instead of a frozen golden.
    for (const key of ["terminal", "workload", "digestKind", "frames"] as const) {
      assert.deepEqual(
        baseline.parity[result.name][key],
        current.parity[result.name][key],
        `${result.name}: ${key} differs`,
      )
    }
  }
  return {
    name: result.name,
    sceneNodes: result.sceneNodes,
    bun: compare(before.bun.avgMs.median, result.bun.avgMs.median),
    node: compare(before.node.avgMs.median, result.node.avgMs.median),
    nodeToBunBefore: before.nodeToBun.median,
    nodeToBunAfter: result.nodeToBun.median,
    scene:
      before.bun.scene && before.node.scene && result.bun.scene && result.node.scene
        ? {
            bun: compare(before.bun.scene.avgMs.median, result.bun.scene.avgMs.median),
            node: compare(before.node.scene.avgMs.median, result.node.scene.avgMs.median),
          }
        : undefined,
    nativeRender:
      before.bun.nativeRender && before.node.nativeRender && result.bun.nativeRender && result.node.nativeRender
        ? {
            bun: compare(before.bun.nativeRender.avgMs.median, result.bun.nativeRender.avgMs.median),
            node: compare(before.node.nativeRender.avgMs.median, result.node.nativeRender.avgMs.median),
          }
        : undefined,
  }
})

console.log("Medians of process means; completed-frame wall time includes the public mutation when present.")
console.log("Scene node ranges include the renderer root and internal ScrollBox/scrollbar nodes.")
console.log(
  "| Scenario | Nodes (timed) | Metric | Bun before | Bun after | Bun change | Node before | Node after | Node change |",
)
console.log("| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
for (const result of comparisons) {
  for (const [metric, timing] of [
    [result.scene ? "completed frame" : "iteration", result],
    ["scene", result.scene],
    ["native diff/encode", result.nativeRender],
  ] as const) {
    if (!timing) continue
    console.log(
      `| ${result.name} | ${result.sceneNodes ? `${result.sceneNodes.timedMin}-${result.sceneNodes.timedMax}` : "-"} | ${metric} | ${formatMs(timing.bun.before)} | ${formatMs(timing.bun.after)} | ${formatChange(timing.bun.change)} | ${formatMs(timing.node.before)} | ${formatMs(timing.node.after)} | ${formatChange(timing.node.change)} |`,
    )
  }
}

const jsonPath = process.argv.find((argument) => argument.startsWith("--json="))?.slice("--json=".length)
if (jsonPath) {
  writeFileSync(
    resolve(jsonPath),
    JSON.stringify({ baselineRunId: baseline.runId, currentRunId: current.runId, results: comparisons }, null, 2),
  )
}

function readReport(path: string): BenchmarkReport {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as BenchmarkReport
}

function compare(before: number, after: number) {
  return { before, after, change: after / before - 1 }
}

function formatMs(value: number): string {
  return `${value.toFixed(4)}ms`
}

function formatChange(value: number): string {
  const percent = value * 100
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`
}
