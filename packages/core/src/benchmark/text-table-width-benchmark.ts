import { allocateProportionalColumnWidths } from "../renderables/text-table-width.js"

interface Scenario {
  name: string
  inputs: Input[]
  iterations: number
}

interface Input {
  widths: number[]
  targetWidth: number
  minWidth: number
}

const samples = 9
const warmups = 2
let seed = 0x1259
const propertyInputs = Array.from({ length: 40 }, (_, vectorIdx) => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  const minWidth = 1 + (seed % 4)
  const widths = Array.from({ length: 1 + (vectorIdx % 8) }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return minWidth + (seed % 80)
  })
  const minimum = minWidth * widths.length
  const intrinsic = widths.reduce((sum, width) => sum + width, 0)
  return Array.from({ length: intrinsic - minimum }, (_, offset) => ({
    widths,
    targetWidth: minimum + offset + 1,
    minWidth,
  }))
}).flat()
const scenarios: Scenario[] = [
  {
    name: "reported-5-columns",
    inputs: [{ widths: [4, 49, 4, 54, 38], targetWidth: 104, minWidth: 1 }],
    iterations: 1_000_000,
  },
  {
    name: "reviewed-vectors",
    inputs: [
      { widths: [91, 9], targetWidth: 37, minWidth: 1 },
      { widths: [91, 9], targetWidth: 38, minWidth: 1 },
      { widths: [1000, 100], targetWidth: 401, minWidth: 1 },
      { widths: [1000, 100], targetWidth: 402, minWidth: 1 },
      { widths: [7, 7, 7], targetWidth: 13, minWidth: 3 },
    ],
    iterations: 1_000_000,
  },
  {
    name: "typical-8-columns",
    inputs: [{ widths: [6, 42, 9, 75, 4, 28, 13, 61], targetWidth: 120, minWidth: 1 }],
    iterations: 500_000,
  },
  {
    name: "typical-16-columns",
    inputs: [
      {
        widths: [8, 37, 5, 62, 11, 44, 7, 29, 15, 71, 6, 53, 18, 34, 9, 47],
        targetWidth: 240,
        minWidth: 1,
      },
    ],
    iterations: 250_000,
  },
  { name: "property-test-corpus", inputs: propertyInputs, iterations: 500_000 },
  {
    name: "exact-number-comparison",
    inputs: [{ widths: [2_516_760, 2_528_584], targetWidth: 58_886, minWidth: 1 }],
    iterations: 1_000_000,
  },
  {
    name: "exact-bigint-comparison",
    inputs: [{ widths: [4_000_000_001, 1_000_000_001], targetWidth: 300_001, minWidth: 1 }],
    iterations: 500_000,
  },
  {
    name: "uniform-8-near-full",
    inputs: [{ widths: new Array(8).fill(2), targetWidth: 15, minWidth: 1 }],
    iterations: 500_000,
  },
  {
    name: "uniform-16-near-full",
    inputs: [{ widths: new Array(16).fill(2), targetWidth: 31, minWidth: 1 }],
    iterations: 250_000,
  },
  {
    name: "uniform-64-near-full",
    inputs: [{ widths: new Array(64).fill(2), targetWidth: 127, minWidth: 1 }],
    iterations: 50_000,
  },
  {
    name: "uniform-64-half-filled",
    inputs: [{ widths: new Array(64).fill(17), targetWidth: 576, minWidth: 1 }],
    iterations: 50_000,
  },
  {
    name: "uniform-64-remainder-1",
    inputs: [{ widths: new Array(64).fill(17), targetWidth: 577, minWidth: 1 }],
    iterations: 50_000,
  },
  {
    name: "uniform-64-remainder-8",
    inputs: [{ widths: new Array(64).fill(17), targetWidth: 584, minWidth: 1 }],
    iterations: 50_000,
  },
  {
    name: "uniform-64-near-full-cap16",
    inputs: [{ widths: new Array(64).fill(17), targetWidth: 1087, minWidth: 1 }],
    iterations: 50_000,
  },
  {
    name: "uniform-256-near-full",
    inputs: [{ widths: new Array(256).fill(2), targetWidth: 511, minWidth: 1 }],
    iterations: 10_000,
  },
  {
    name: "uniform-1024-near-full",
    inputs: [{ widths: new Array(1024).fill(2), targetWidth: 2047, minWidth: 1 }],
    iterations: 2_000,
  },
  {
    name: "alternating-64-near-full",
    inputs: [{ widths: Array.from({ length: 64 }, (_, idx) => 2 + (idx % 2)), targetWidth: 159, minWidth: 1 }],
    iterations: 20_000,
  },
  {
    name: "alternating-256-near-full",
    inputs: [{ widths: Array.from({ length: 256 }, (_, idx) => 2 + (idx % 2)), targetWidth: 639, minWidth: 1 }],
    iterations: 2_000,
  },
  {
    name: "alternating-1024-near-full",
    inputs: [{ widths: Array.from({ length: 1024 }, (_, idx) => 2 + (idx % 2)), targetWidth: 2559, minWidth: 1 }],
    iterations: 200,
  },
]

let checksum = 0

for (const scenario of scenarios) {
  const iterations = scenario.iterations

  for (let sample = 0; sample < warmups; sample++) runScenario(scenario, iterations)

  const timings = Array.from({ length: samples }, () => runScenario(scenario, iterations)).sort((a, b) => a - b)
  const median = timings[Math.floor(timings.length / 2)]!
  const min = timings[0]!
  console.log(`${scenario.name.padEnd(28)} median=${median.toFixed(1)} ns/op min=${min.toFixed(1)} ns/op`)
}

console.log(`checksum=${checksum}`)

function runScenario(scenario: Scenario, iterations: number): number {
  let localChecksum = 0
  const start = performance.now()

  for (let iteration = 0; iteration < iterations; iteration++) {
    const input = scenario.inputs[iteration % scenario.inputs.length]!
    const result = allocateProportionalColumnWidths(input.widths, input.targetWidth, input.minWidth)
    localChecksum += result[iteration % result.length]!
  }

  const elapsed = performance.now() - start
  checksum = (checksum + localChecksum) >>> 0
  return (elapsed * 1_000_000) / iterations
}
