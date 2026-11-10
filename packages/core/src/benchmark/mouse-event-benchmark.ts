#!/usr/bin/env bun

import { Renderable } from "../Renderable.js"
import { MouseEvent } from "../renderer.js"
import { createTestRenderer } from "../testing.js"

interface ScenarioResult {
  name: string
  iterations: number
  samples: number[]
  meanNsPerEvent: number
  medianNsPerEvent: number
  rsdPercent: number
}

const depth = integerArg("depth", 8)
const directIterations = integerArg("direct-iterations", 2_000_000)
const stdinIterations = integerArg("stdin-iterations", 100_000)
const sampleCount = integerArg("samples", 25)
const warmupCount = integerArg("warmup", 8)
const json = process.argv.includes("--json")

const scenarios = [await directDispatch(), await stdinDispatch()]
const result = {
  runtime: `bun ${Bun.version}`,
  depth,
  sampleCount,
  warmupCount,
  scenarios,
}

if (json) {
  console.log(JSON.stringify(result))
} else {
  console.log(`mouse event flood (depth=${depth}, samples=${sampleCount})`)
  for (const scenario of scenarios) {
    console.log(
      `${scenario.name}: median=${scenario.medianNsPerEvent.toFixed(1)} ns/event mean=${scenario.meanNsPerEvent.toFixed(1)} ns/event RSD=${scenario.rsdPercent.toFixed(2)}%`,
    )
  }
}

async function directDispatch(): Promise<ScenarioResult> {
  const { renderer } = await createTestRenderer({ width: 10, height: 10 })
  const { leaf, count } = createTree(renderer, depth)
  const event = () =>
    new MouseEvent(leaf, {
      type: "move",
      button: 0,
      x: 1,
      y: 1,
      modifiers: { shift: false, alt: false, ctrl: false },
    })

  try {
    const sharedEvent = event()
    return measure(
      "bubbling-only",
      directIterations,
      warmupCount,
      sampleCount,
      () => {
        leaf.processMouseEvent(sharedEvent)
      },
      count,
    )
  } finally {
    renderer.destroy()
  }
}

async function stdinDispatch(): Promise<ScenarioResult> {
  const { renderer, renderOnce } = await createTestRenderer({ width: 10, height: 10 })
  const { count } = createTree(renderer, depth)
  const sequence = Buffer.from("\x1b[<35;2;2M")

  try {
    await renderOnce()
    renderer.stdin.emit("data", sequence)
    return measure(
      "stdin-sgr-bubble",
      stdinIterations,
      warmupCount,
      sampleCount,
      () => {
        renderer.stdin.emit("data", sequence)
      },
      count,
    )
  } finally {
    renderer.destroy()
  }
}

function createTree(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"], levels: number) {
  let parent: Renderable = renderer.root
  let leaf: Renderable = renderer.root
  let handled = 0

  for (let index = 0; index < levels; index++) {
    const child = new Renderable(renderer, { width: 10, height: 10 })
    child.onMouse = () => handled++
    parent.add(child)
    parent = child
    leaf = child
  }

  return {
    leaf,
    count: () => handled,
  }
}

function measure(
  name: string,
  count: number,
  warmups: number,
  samples: number,
  dispatch: () => void,
  handled: () => number,
): ScenarioResult {
  const run = () => {
    const before = handled()
    const start = Bun.nanoseconds()
    for (let index = 0; index < count; index++) dispatch()
    const elapsed = Bun.nanoseconds() - start
    const handledCount = handled() - before
    if (handledCount !== count * depth) {
      throw new Error(`${name} dispatched ${handledCount} handlers, expected ${count * depth}`)
    }
    return elapsed / count
  }

  for (let index = 0; index < warmups; index++) run()
  const values = Array.from({ length: samples }, run)
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]

  return {
    name,
    iterations: count,
    samples: values,
    meanNsPerEvent: mean,
    medianNsPerEvent: median,
    rsdPercent: (Math.sqrt(variance) / mean) * 100,
  }
}

function integerArg(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid ${name}: ${value}`)
  return parsed
}
