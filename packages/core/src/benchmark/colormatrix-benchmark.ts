#!/usr/bin/env bun

import { performance } from "node:perf_hooks"
import { OptimizedBuffer, ResourceContext } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"

type Scenario = { width: number; height: number; mode: "uniform" | "mask25" | "mask100" }
type ScenarioResult = {
  size: string
  cells: number
  mode: "uniform" | "mask25" | "mask100"
  avgMs: number
  avgNsPerCell: number
  medianMs: number
  p95Ms: number
}

const sepiaMatrix = new Float32Array([
  0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 1,
])

const ITERATIONS = 1000
const WARMUP_ITERATIONS = 100
const baseScenarios: Array<{ width: number; height: number }> = [
  { width: 80, height: 24 },
  { width: 120, height: 40 },
  { width: 200, height: 60 },
]
const scenarios: Scenario[] = baseScenarios.flatMap((scenario) => [
  { ...scenario, mode: "uniform" },
  { ...scenario, mode: "mask25" },
  { ...scenario, mode: "mask100" },
])

function generateCellMask(width: number, height: number, density: number): Float32Array {
  const totalCells = width * height
  const numCells = Math.floor(totalCells * density)
  const mask = new Float32Array(numCells * 3)

  for (let i = 0; i < numCells; i++) {
    mask[i * 3] = i % width
    mask[i * 3 + 1] = Math.floor(i / width)
    mask[i * 3 + 2] = 1
  }

  return mask
}

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

function fillBufferColors(buffer: OptimizedBuffer): void {
  buffer.withBuffers(({ fg, bg }) => {
    for (let i = 0; i < fg.length; i += 4) {
      fg.set(RGBA.fromValues(Math.random(), Math.random(), Math.random(), 1).buffer, i)
      bg.set(RGBA.fromValues(Math.random(), Math.random(), Math.random(), 1).buffer, i)
    }
  })
}

function runScenario({ width, height, mode }: Scenario): ScenarioResult {
  const owner = new ResourceContext({ objectCapacity: 4, renderCellsMax: width * height })
  try {
    const buffer = OptimizedBuffer.create(width, height, "unicode", {
      owner,
      id: `colormatrix-bench-${mode}-${width}x${height}`,
    })
    const cellMask = mode === "mask25" ? generateCellMask(width, height, 0.25) : generateCellMask(width, height, 1)
    const cellCount = mode === "uniform" ? width * height : cellMask.length / 3

    fillBufferColors(buffer)

    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      if (mode === "uniform") {
        buffer.colorMatrixUniform(sepiaMatrix, 1.0, 3)
      } else {
        buffer.colorMatrix(sepiaMatrix, cellMask, 1.0, 3)
      }
    }

    const samples = new Array<number>(ITERATIONS)
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now()
      if (mode === "uniform") {
        buffer.colorMatrixUniform(sepiaMatrix, 1.0, 3)
      } else {
        buffer.colorMatrix(sepiaMatrix, cellMask, 1.0, 3)
      }
      samples[i] = performance.now() - start
    }

    buffer.destroy()

    const stats = calculateStats(samples)

    return {
      size: `${width}x${height}`,
      cells: cellCount,
      mode,
      avgMs: formatMs(stats.avgMs),
      avgNsPerCell: formatNs((stats.avgMs * 1_000_000) / cellCount),
      medianMs: formatMs(stats.medianMs),
      p95Ms: formatMs(stats.p95Ms),
    }
  } finally {
    owner.destroy()
  }
}

console.log(`ColorMatrix Benchmark (${ITERATIONS} iterations per scenario)`)
const results = scenarios.map(runScenario)
console.table(results)
