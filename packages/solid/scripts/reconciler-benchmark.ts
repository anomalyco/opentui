#!/usr/bin/env bun

import { BoxRenderable, ImageRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { setProp } from "../src/reconciler.js"

interface Scenario {
  name: string
  run(operations: number): number
}

const setup = await createTestRenderer({ width: 10, height: 4 })
const box = new BoxRenderable(setup.renderer, { id: "style-benchmark-box" })
const image = new ImageRenderable(setup.renderer, { id: "style-benchmark-image" })

const boxStyles = [
  { visible: true, opacity: 0.75 },
  { visible: false, opacity: 0.5 },
] as const
const imageStyles = [
  { fit: "fill" as const, protocol: "kitty" as const, visible: true, opacity: 0.5 },
  { visible: true, opacity: 0.5 },
] as const

const scenarios: Scenario[] = [
  createStyleScenario("box style update", box, boxStyles),
  createStyleScenario("image style default removal", image, imageStyles),
]

try {
  const samples = new Map(scenarios.map((scenario) => [scenario.name, [] as number[]]))
  const operationCounts = new Map<string, number>()
  for (const scenario of scenarios) {
    scenario.run(10_000)
    operationCounts.set(scenario.name, calibrate(scenario))
  }

  const rounds = 20
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? scenarios : [...scenarios].reverse()
    for (const scenario of order) {
      const operations = operationCounts.get(scenario.name)!
      const start = Bun.nanoseconds()
      const signal = scenario.run(operations)
      const elapsed = Bun.nanoseconds() - start
      if (signal === 0) throw new Error(`invalid benchmark signal for ${scenario.name}`)
      samples.get(scenario.name)!.push(elapsed / operations)
    }
  }

  console.log(
    JSON.stringify({
      benchmark: "solid-reconciler",
      rounds,
      results: scenarios.map((scenario) => ({
        name: scenario.name,
        operationsPerRound: operationCounts.get(scenario.name),
        ...summarize(samples.get(scenario.name)!),
      })),
    }),
  )
} finally {
  box.destroyRecursively()
  image.destroyRecursively()
  setup.renderer.destroy()
}

function createStyleScenario(
  name: string,
  node: BoxRenderable | ImageRenderable,
  styles: readonly [Record<string, unknown>, Record<string, unknown>],
): Scenario {
  let current = 0
  return {
    name,
    run(operations) {
      let signal = 0
      for (let index = 0; index < operations; index++) {
        const next = current ^ 1
        setProp(node, "style", styles[next]!, styles[current]!)
        current = next
        signal += node.visible ? 1 : 2
      }
      return signal
    },
  }
}

function calibrate(scenario: Scenario): number {
  let operations = 1024
  while (operations < 1 << 24) {
    const start = Bun.nanoseconds()
    scenario.run(operations)
    if (Bun.nanoseconds() - start >= 50_000_000) return operations
    operations *= 2
  }
  return operations
}

function summarize(samples: number[]) {
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length
  const sorted = [...samples].sort((a, b) => a - b)
  const median = (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
  const variance = samples.reduce((total, value) => total + (value - mean) ** 2, 0) / (samples.length - 1)
  const standardError = Math.sqrt(variance / samples.length)
  return {
    meanNs: mean,
    medianNs: median,
    minNs: sorted[0],
    maxNs: sorted.at(-1),
    rme95: (2.093 * standardError * 100) / mean,
  }
}
