#!/usr/bin/env bun

import { performance } from "node:perf_hooks"
import { OptimizedBuffer, ResourceContext } from "../buffer.js"
import { applyGain } from "../post/filters.js"

type Scenario = { width: number; height: number }
type ScenarioResult = {
  size: string
  cells: number
  avgMs: number
  avgNsPerCell: number
  medianMs: number
  p95Ms: number
}

const ITERATIONS = 5000
const WARMUP_ITERATIONS = 100
const GAIN_FACTOR = 1.3
const baseScenarios: Array<{ width: number; height: number }> = [
  { width: 40, height: 20 },
  { width: 80, height: 24 },
  { width: 120, height: 40 },
  { width: 200, height: 60 },
]
const scenarios: Scenario[] = baseScenarios

function calculateStats(samples: number[]): { avgMs: number; medianMs: number; p95Ms: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)
  const avgMs = total / samples.length
  const mid = Math.floor(sorted.length / 2)
  const medianMs = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  const p95Index = Math.floor(0.95 * (sorted.length - 1))
  const p95Ms = sorted[p95Index]

  return { avgMs, medianMs, p95Ms }
}

function formatMs(value: number): number {
  return Number(value.toFixed(4))
}

function formatNs(value: number): number {
  return Number(value.toFixed(2))
}

function runScenario({ width, height }: Scenario): ScenarioResult {
  const owner = new ResourceContext({ objectCapacity: 4, renderCellsMax: width * height })
  try {
    const buffer = OptimizedBuffer.create(width, height, "unicode", {
      owner,
      id: `gain-bench-${width}x${height}`,
    })
    buffer.withBuffers(({ fg, bg }) => {
      fg.fill(1)
      bg.fill(1)
    })

    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      applyGain(buffer, GAIN_FACTOR)
    }

    const samples = new Array<number>(ITERATIONS)
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now()
      applyGain(buffer, GAIN_FACTOR)
      samples[i] = performance.now() - start
    }

    buffer.destroy()

    const stats = calculateStats(samples)
    return {
      size: `${width}x${height}`,
      cells: width * height,
      avgMs: formatMs(stats.avgMs),
      avgNsPerCell: formatNs((stats.avgMs * 1_000_000) / (width * height)),
      medianMs: formatMs(stats.medianMs),
      p95Ms: formatMs(stats.p95Ms),
    }
  } finally {
    owner.destroy()
  }
}

console.log(`Gain Benchmark (${ITERATIONS} iterations per scenario)`)
const results = scenarios.map(runScenario)
console.table(results)
