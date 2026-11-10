#!/usr/bin/env bun

import {
  TextTableRenderable,
  type TextTableCellContent,
  type TextTableColumnFitter,
  type TextTableColumnWidthMode,
  type TextTableContent,
  type CliRenderer,
} from "../index.js"
import { createTestRenderer } from "../testing.js"
import { Command } from "commander"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"

const realStdoutWrite = process.stdout.write.bind(process.stdout)

const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mango",
  "nectar",
  "oscar",
  "papa",
  "quartz",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "vector",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
  "matrix",
  "signal",
  "tensor",
  "render",
  "schema",
  "buffer",
  "layout",
  "stream",
  "parser",
  "syntax",
  "viewport",
  "cursor",
]

type MemorySample = {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

type MemoryStats = {
  samples: number
  start: MemorySample
  end: MemorySample
  delta: MemorySample
  peak: MemorySample
}

type TimingStats = {
  count: number
  averageMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
  stdDevMs: number
}

type ScenarioResult = {
  name: string
  description: string
  category: "replace" | "incremental" | "selection"
  timingMode: "content-set-and-render" | "selection-update-and-render"
  iterations: number
  warmupIterations: number
  elapsedMs: number
  updateStats: TimingStats
  memoryStats?: MemoryStats
  tableStats: {
    initialRows: number
    finalRows: number
    maxRows: number
    columns: number
    updates: number
    datasetVariants: number
  }
  settings: Record<string, unknown>
}

type ReplaceScenarioPlan = {
  kind: "replace"
  name: string
  description: string
  iterations: number
  warmupIterations: number
  rows: number
  cols: number
  variants: TextTableContent[]
  tableConfig: BenchmarkTableConfig
}

type IncrementalScenarioPlan = {
  kind: "incremental"
  name: string
  description: string
  iterations: number
  warmupIterations: number
  cols: number
  header: TextTableCellContent[]
  baseRows: TextTableCellContent[][]
  rowPool: TextTableCellContent[][]
  maxRows: number
  tableConfig: BenchmarkTableConfig
}

type SelectionScenarioPlan = {
  kind: "selection"
  name: string
  description: string
  iterations: number
  warmupIterations: number
  rows: number
  cols: number
  content: TextTableContent
  dragSteps: number
  tableConfig: BenchmarkTableConfig
}

type ScenarioPlan = ReplaceScenarioPlan | IncrementalScenarioPlan | SelectionScenarioPlan

type BenchmarkTableConfig = {
  wrapMode: "none" | "char" | "word"
  columnWidthMode: TextTableColumnWidthMode
  columnFitter: TextTableColumnFitter
}

type RunContext = {
  renderer: CliRenderer
  table: TextTableRenderable
  renderOnce: () => Promise<void>
  memSampleEvery: number
}

type SuiteConfig = {
  iterations: number
  warmupIterations: number
  longIterations: number
  scale: number
}

type OutputMeta = {
  suiteName: string
  width: number
  height: number
  iterations: number
  warmupIterations: number
  longIterations: number
  scale: number
  seed: number
  memSampleEvery: number
}

type IncrementalState = {
  rows: TextTableCellContent[][]
  cursor: number
  maxRowsSeen: number
}

const program = new Command()
program
  .name("text-table-benchmark")
  .description("TextTableRenderable benchmark scenarios")
  .option("-s, --suite <name>", "benchmark suite: quick, default, long", "default")
  .option("-i, --iterations <count>", "iterations per scenario", "800")
  .option("--warmup-iterations <count>", "warmup iterations per scenario", "80")
  .option("--long-iterations <count>", "iterations for long suite", "3000")
  .option("--scale <n>", "scale rows and dataset size", "1")
  .option("--seed <n>", "seed for deterministic content", "1337")
  .option("--width <n>", "test renderer width", "140")
  .option("--height <n>", "test renderer height", "48")
  .option("--mem-sample-every <count>", "sample memory every N iterations (0 disables)", "10")
  .option("--scenario <name>", "run a single scenario")
  .option("--json [path]", "write JSON results to file")
  .option("--no-output", "suppress stdout output")
  .parse(process.argv)

const options = program.opts()

const suiteName = String(options.suite)
const iterations = Math.max(1, Math.floor(toNumber(options.iterations, 800)))
const warmupIterations = Math.max(0, Math.floor(toNumber(options.warmupIterations, 80)))
const longIterations = Math.max(iterations, Math.floor(toNumber(options.longIterations, 3000)))
const scale = Math.max(0.25, toNumber(options.scale, 1))
const seed = Math.max(1, Math.floor(toNumber(options.seed, 1337)))
const width = Math.max(40, Math.floor(toNumber(options.width, 140)))
const height = Math.max(12, Math.floor(toNumber(options.height, 48)))
const memSampleEvery = Math.max(0, Math.floor(toNumber(options.memSampleEvery, 10)))
const scenarioFilter = options.scenario ? String(options.scenario) : null
const outputEnabled = options.output !== false

const PROPORTIONAL_TABLE_CONFIG: BenchmarkTableConfig = {
  wrapMode: "word",
  columnWidthMode: "full",
  columnFitter: "proportional",
}

const BALANCED_TABLE_CONFIG: BenchmarkTableConfig = {
  wrapMode: "word",
  columnWidthMode: "full",
  columnFitter: "balanced",
}

const jsonArg = options.json
const jsonPath =
  typeof jsonArg === "string"
    ? path.resolve(process.cwd(), jsonArg)
    : jsonArg
      ? path.resolve(process.cwd(), "latest-text-table-bench-run.json")
      : null

if (jsonPath) {
  const dir = path.dirname(jsonPath)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  if (existsSync(jsonPath)) {
    console.error(`Error: output file already exists: ${jsonPath}`)
    process.exit(1)
  }
}

const scenarios = createScenarios(
  suiteName,
  {
    iterations,
    warmupIterations,
    longIterations,
    scale,
  },
  seed,
)

if (scenarios.length === 0) {
  console.error(`Unknown suite: ${suiteName}`)
  process.exit(1)
}

const filteredScenarios = scenarioFilter ? scenarios.filter((scenario) => scenario.name === scenarioFilter) : scenarios

if (scenarioFilter && filteredScenarios.length === 0) {
  writeLine(`Unknown scenario: ${scenarioFilter}`)
  process.exit(1)
}

const { renderer, renderOnce } = await createTestRenderer({
  width,
  height,
  screenMode: "main-screen",
  externalOutputMode: "passthrough",
  consoleMode: "disabled",
})

renderer.requestRender = () => {}

const table = new TextTableRenderable(renderer, {
  id: "text-table-bench",
  width: "100%",
  wrapMode: PROPORTIONAL_TABLE_CONFIG.wrapMode,
  columnWidthMode: PROPORTIONAL_TABLE_CONFIG.columnWidthMode,
  columnFitter: PROPORTIONAL_TABLE_CONFIG.columnFitter,
  content: [],
})

renderer.root.add(table)
await renderOnce()

const ctx: RunContext = {
  renderer,
  table,
  renderOnce,
  memSampleEvery,
}

const results: ScenarioResult[] = []
const scenarioLines: string[] = []

try {
  for (const plan of filteredScenarios) {
    const result = await runScenario(plan, ctx)
    results.push(result)
    scenarioLines.push(formatScenarioResult(result))
  }
} finally {
  renderer.destroy()
}

await outputResults(
  {
    suiteName,
    width,
    height,
    iterations,
    warmupIterations,
    longIterations,
    scale,
    seed,
    memSampleEvery,
  },
  results,
  scenarioLines,
  outputEnabled,
  jsonPath,
)

function createScenarios(suite: string, config: SuiteConfig, runSeed: number): ScenarioPlan[] {
  const quick = {
    replaceRows: scaled(24, config.scale),
    replaceCols: 4,
    replaceVariants: scaled(6, config.scale),
    incrementalCols: 4,
    incrementalBaseRows: scaled(8, config.scale),
    incrementalPoolRows: scaled(220, config.scale),
    incrementalMaxRows: scaled(120, config.scale),
  }

  const defaultSuite = {
    replaceRows: scaled(72, config.scale),
    replaceCols: 6,
    replaceVariants: scaled(10, config.scale),
    incrementalCols: 6,
    incrementalBaseRows: scaled(16, config.scale),
    incrementalPoolRows: scaled(480, config.scale),
    incrementalMaxRows: scaled(320, config.scale),
  }

  const long = {
    replaceRows: scaled(140, config.scale),
    replaceCols: 8,
    replaceVariants: scaled(14, config.scale),
    incrementalCols: 8,
    incrementalBaseRows: scaled(24, config.scale),
    incrementalPoolRows: scaled(960, config.scale),
    incrementalMaxRows: scaled(720, config.scale),
  }

  let shape: typeof quick
  let runIterations = config.iterations

  if (suite === "quick") {
    shape = quick
  } else if (suite === "default") {
    shape = defaultSuite
  } else if (suite === "long") {
    shape = long
    runIterations = config.longIterations
  } else {
    return []
  }

  const replaceRng = createRng((runSeed ^ 0x9e3779b9) >>> 0)
  const variants: TextTableContent[] = []
  for (let i = 0; i < shape.replaceVariants; i += 1) {
    variants.push(buildTableContent(replaceRng, shape.replaceRows, shape.replaceCols))
  }

  const incrementalRng = createRng((runSeed ^ 0x85ebca6b) >>> 0)
  const header = makeHeader(shape.incrementalCols)
  const baseRows = buildRows(incrementalRng, shape.incrementalBaseRows, shape.incrementalCols, 0)
  const rowPool = buildRows(
    incrementalRng,
    Math.max(shape.incrementalPoolRows, shape.incrementalBaseRows + 1),
    shape.incrementalCols,
    shape.incrementalBaseRows,
  )

  const replaceScenario: ReplaceScenarioPlan = {
    kind: "replace",
    name: "replace_tables",
    description: "Replace full table content with prebuilt variants",
    iterations: runIterations,
    warmupIterations: config.warmupIterations,
    rows: shape.replaceRows,
    cols: shape.replaceCols,
    variants,
    tableConfig: PROPORTIONAL_TABLE_CONFIG,
  }

  const balancedFitterReplaceScenario: ReplaceScenarioPlan = {
    kind: "replace",
    name: "replace_tables_balanced_fitter",
    description: "Replace full table content with prebuilt variants (balanced fitter)",
    iterations: runIterations,
    warmupIterations: config.warmupIterations,
    rows: shape.replaceRows,
    cols: shape.replaceCols,
    variants,
    tableConfig: BALANCED_TABLE_CONFIG,
  }

  const incrementalScenario: IncrementalScenarioPlan = {
    kind: "incremental",
    name: "incremental_table_rows",
    description: "Append table rows and periodically reset to base size",
    iterations: runIterations,
    warmupIterations: config.warmupIterations,
    cols: shape.incrementalCols,
    header,
    baseRows,
    rowPool,
    maxRows: Math.max(shape.incrementalMaxRows, shape.incrementalBaseRows + 1),
    tableConfig: PROPORTIONAL_TABLE_CONFIG,
  }

  const balancedFitterIncrementalScenario: IncrementalScenarioPlan = {
    kind: "incremental",
    name: "incremental_table_rows_balanced_fitter",
    description: "Append table rows and periodically reset to base size (balanced fitter)",
    iterations: runIterations,
    warmupIterations: config.warmupIterations,
    cols: shape.incrementalCols,
    header,
    baseRows,
    rowPool,
    maxRows: Math.max(shape.incrementalMaxRows, shape.incrementalBaseRows + 1),
    tableConfig: BALANCED_TABLE_CONFIG,
  }

  const selectionRng = createRng((runSeed ^ 0xa2f9c6d1) >>> 0)
  const selectionContent = buildTableContent(selectionRng, shape.replaceRows, shape.replaceCols)

  const selectionScenario: SelectionScenarioPlan = {
    kind: "selection",
    name: "selection_update",
    description: "Update selection focus across rows and render",
    iterations: runIterations,
    warmupIterations: config.warmupIterations,
    rows: shape.replaceRows,
    cols: shape.replaceCols,
    content: selectionContent,
    dragSteps: 5,
    tableConfig: PROPORTIONAL_TABLE_CONFIG,
  }

  const balancedFitterSelectionScenario: SelectionScenarioPlan = {
    kind: "selection",
    name: "selection_update_balanced_fitter",
    description: "Update selection focus across rows and render (balanced fitter)",
    iterations: runIterations,
    warmupIterations: config.warmupIterations,
    rows: shape.replaceRows,
    cols: shape.replaceCols,
    content: selectionContent,
    dragSteps: 5,
    tableConfig: BALANCED_TABLE_CONFIG,
  }

  return [
    replaceScenario,
    balancedFitterReplaceScenario,
    incrementalScenario,
    balancedFitterIncrementalScenario,
    selectionScenario,
    balancedFitterSelectionScenario,
  ]
}

async function runScenario(plan: ScenarioPlan, ctx: RunContext): Promise<ScenarioResult> {
  if (plan.kind === "replace") {
    return runReplaceScenario(plan, ctx)
  }
  if (plan.kind === "incremental") {
    return runIncrementalScenario(plan, ctx)
  }
  return runSelectionScenario(plan, ctx)
}

function applyTableConfig(table: TextTableRenderable, config: BenchmarkTableConfig): void {
  table.wrapMode = config.wrapMode
  table.columnWidthMode = config.columnWidthMode
  table.columnFitter = config.columnFitter
}

async function runReplaceScenario(plan: ReplaceScenarioPlan, ctx: RunContext): Promise<ScenarioResult> {
  applyTableConfig(ctx.table, plan.tableConfig)

  for (let i = 0; i < plan.warmupIterations; i += 1) {
    const variant = plan.variants[i % plan.variants.length]
    ctx.table.content = variant
    await ctx.renderOnce()
  }

  const durations: number[] = []
  const measurementStart = Date.now()
  const memStart = shouldSampleMemory(ctx.memSampleEvery) ? readMemorySample() : null
  const memSamples: MemorySample[] = []

  for (let i = 0; i < plan.iterations; i += 1) {
    const variant = plan.variants[i % plan.variants.length]
    const start = performance.now()
    ctx.table.content = variant
    await ctx.renderOnce()
    durations.push(performance.now() - start)

    if (ctx.memSampleEvery > 0 && (i + 1) % ctx.memSampleEvery === 0) {
      memSamples.push(readMemorySample())
    }
  }

  const elapsedMs = Date.now() - measurementStart
  const memEnd = shouldSampleMemory(ctx.memSampleEvery) ? readMemorySample() : null

  return {
    name: plan.name,
    description: plan.description,
    category: "replace",
    timingMode: "content-set-and-render",
    iterations: plan.iterations,
    warmupIterations: plan.warmupIterations,
    elapsedMs,
    updateStats: computeTimingStats(durations),
    memoryStats: memStart && memEnd ? computeMemoryStats(memSamples, memStart, memEnd) : undefined,
    tableStats: {
      initialRows: plan.rows,
      finalRows: plan.rows,
      maxRows: plan.rows,
      columns: plan.cols,
      updates: plan.iterations,
      datasetVariants: plan.variants.length,
    },
    settings: {
      rows: plan.rows,
      cols: plan.cols,
      variants: plan.variants.length,
      mode: "replace",
      wrapMode: plan.tableConfig.wrapMode,
      columnWidthMode: plan.tableConfig.columnWidthMode,
      columnFitter: plan.tableConfig.columnFitter,
    },
  }
}

async function runIncrementalScenario(plan: IncrementalScenarioPlan, ctx: RunContext): Promise<ScenarioResult> {
  applyTableConfig(ctx.table, plan.tableConfig)

  const state: IncrementalState = {
    rows: [...plan.baseRows],
    cursor: 0,
    maxRowsSeen: plan.baseRows.length,
  }

  ctx.table.content = [plan.header, ...state.rows]
  await ctx.renderOnce()

  for (let i = 0; i < plan.warmupIterations; i += 1) {
    const next = nextIncrementalContent(plan, state)
    ctx.table.content = next
    await ctx.renderOnce()
  }

  const durations: number[] = []
  const measurementStart = Date.now()
  const memStart = shouldSampleMemory(ctx.memSampleEvery) ? readMemorySample() : null
  const memSamples: MemorySample[] = []

  for (let i = 0; i < plan.iterations; i += 1) {
    const next = nextIncrementalContent(plan, state)

    const start = performance.now()
    ctx.table.content = next
    await ctx.renderOnce()
    durations.push(performance.now() - start)

    if (ctx.memSampleEvery > 0 && (i + 1) % ctx.memSampleEvery === 0) {
      memSamples.push(readMemorySample())
    }
  }

  const elapsedMs = Date.now() - measurementStart
  const memEnd = shouldSampleMemory(ctx.memSampleEvery) ? readMemorySample() : null

  return {
    name: plan.name,
    description: plan.description,
    category: "incremental",
    timingMode: "content-set-and-render",
    iterations: plan.iterations,
    warmupIterations: plan.warmupIterations,
    elapsedMs,
    updateStats: computeTimingStats(durations),
    memoryStats: memStart && memEnd ? computeMemoryStats(memSamples, memStart, memEnd) : undefined,
    tableStats: {
      initialRows: plan.baseRows.length,
      finalRows: state.rows.length,
      maxRows: state.maxRowsSeen,
      columns: plan.cols,
      updates: plan.iterations,
      datasetVariants: plan.rowPool.length,
    },
    settings: {
      cols: plan.cols,
      baseRows: plan.baseRows.length,
      rowPool: plan.rowPool.length,
      maxRows: plan.maxRows,
      mode: "incremental",
      wrapMode: plan.tableConfig.wrapMode,
      columnWidthMode: plan.tableConfig.columnWidthMode,
      columnFitter: plan.tableConfig.columnFitter,
    },
  }
}

async function runSelectionScenario(plan: SelectionScenarioPlan, ctx: RunContext): Promise<ScenarioResult> {
  applyTableConfig(ctx.table, plan.tableConfig)
  ctx.table.content = plan.content
  await ctx.renderOnce()

  const tableX = ctx.table.x
  const tableY = ctx.table.y
  const tableH = ctx.table.height

  const anchorX = tableX + 2
  const anchorY = tableY + 2

  const maxFocusY = tableY + tableH - 2
  const focusRange = Math.max(1, maxFocusY - anchorY)

  for (let i = 0; i < plan.warmupIterations; i += 1) {
    const focusY = anchorY + (i % focusRange)
    ctx.renderer.startSelection(ctx.table, anchorX, anchorY)
    for (let step = 1; step <= plan.dragSteps; step += 1) {
      const stepY = anchorY + Math.round(((focusY - anchorY) * step) / plan.dragSteps)
      ctx.renderer.updateSelection(ctx.table, anchorX + 4, stepY)
    }
    await ctx.renderOnce()
    ctx.renderer.clearSelection()
    await ctx.renderOnce()
  }

  const durations: number[] = []
  const measurementStart = Date.now()
  const memStart = shouldSampleMemory(ctx.memSampleEvery) ? readMemorySample() : null
  const memSamples: MemorySample[] = []

  for (let i = 0; i < plan.iterations; i += 1) {
    const focusY = anchorY + (i % focusRange)

    const start = performance.now()

    ctx.renderer.startSelection(ctx.table, anchorX, anchorY)
    for (let step = 1; step <= plan.dragSteps; step += 1) {
      const stepY = anchorY + Math.round(((focusY - anchorY) * step) / plan.dragSteps)
      ctx.renderer.updateSelection(ctx.table, anchorX + 4, stepY)
    }
    await ctx.renderOnce()
    ctx.renderer.clearSelection()
    await ctx.renderOnce()

    durations.push(performance.now() - start)

    if (ctx.memSampleEvery > 0 && (i + 1) % ctx.memSampleEvery === 0) {
      memSamples.push(readMemorySample())
    }
  }

  const elapsedMs = Date.now() - measurementStart
  const memEnd = shouldSampleMemory(ctx.memSampleEvery) ? readMemorySample() : null

  return {
    name: plan.name,
    description: plan.description,
    category: "selection",
    timingMode: "selection-update-and-render",
    iterations: plan.iterations,
    warmupIterations: plan.warmupIterations,
    elapsedMs,
    updateStats: computeTimingStats(durations),
    memoryStats: memStart && memEnd ? computeMemoryStats(memSamples, memStart, memEnd) : undefined,
    tableStats: {
      initialRows: plan.rows,
      finalRows: plan.rows,
      maxRows: plan.rows,
      columns: plan.cols,
      updates: plan.iterations * (plan.dragSteps + 1),
      datasetVariants: 1,
    },
    settings: {
      rows: plan.rows,
      cols: plan.cols,
      dragSteps: plan.dragSteps,
      mode: "selection",
      wrapMode: plan.tableConfig.wrapMode,
      columnWidthMode: plan.tableConfig.columnWidthMode,
      columnFitter: plan.tableConfig.columnFitter,
    },
  }
}

function nextIncrementalContent(plan: IncrementalScenarioPlan, state: IncrementalState): TextTableContent {
  if (state.rows.length >= plan.maxRows) {
    state.rows = [...plan.baseRows]
  }

  const fallbackRow = plan.rowPool[0] ?? makeDataRow(createRng(1), 0, plan.cols)
  const nextRow = plan.rowPool[state.cursor] ?? fallbackRow

  state.cursor += 1
  if (state.cursor >= plan.rowPool.length) {
    state.cursor = 0
  }

  state.rows = [...state.rows, nextRow]
  state.maxRowsSeen = Math.max(state.maxRowsSeen, state.rows.length)

  return [plan.header, ...state.rows]
}

function makeHeader(cols: number): TextTableCellContent[] {
  const header: TextTableCellContent[] = []
  for (let c = 0; c < cols; c += 1) {
    header.push(chunkCell(`Column ${c + 1}`))
  }
  return header
}

function buildTableContent(rng: () => number, rows: number, cols: number): TextTableContent {
  return [makeHeader(cols), ...buildRows(rng, rows, cols, 0)]
}

function buildRows(rng: () => number, rows: number, cols: number, rowOffset: number): TextTableCellContent[][] {
  const out: TextTableCellContent[][] = []
  for (let r = 0; r < rows; r += 1) {
    out.push(makeDataRow(rng, rowOffset + r, cols))
  }
  return out
}

function makeDataRow(rng: () => number, rowIndex: number, cols: number): TextTableCellContent[] {
  const row: TextTableCellContent[] = []
  for (let c = 0; c < cols; c += 1) {
    row.push(chunkCell(makeCellText(rng, rowIndex, c)))
  }
  return row
}

function chunkCell(text: string): TextTableCellContent {
  return [
    {
      __isChunk: true,
      text,
    },
  ]
}

function makeCellText(rng: () => number, row: number, col: number): string {
  const a = pick(rng, WORDS)
  const b = pick(rng, WORDS)
  const roll = rng()

  if (roll < 0.2) {
    return `${a}-${b}-${row + col}`
  }
  if (roll < 0.4) {
    return `${a} ${Math.floor(rng() * 1000)}`
  }
  if (roll < 0.6) {
    return `${a} ${b} ${pick(rng, WORDS)}`
  }
  if (roll < 0.8) {
    return `${a}_${b}_${Math.floor(rng() * 100)}`
  }
  return `${a} ${b} r${row}c${col}`
}

function pick<T>(rng: () => number, list: T[]): T {
  return list[Math.floor(rng() * list.length)]
}

function createRng(initialSeed: number): () => number {
  let state = initialSeed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function scaled(value: number, scaleValue: number): number {
  return Math.max(1, Math.round(value * scaleValue))
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function shouldSampleMemory(memSampleEvery: number): boolean {
  return memSampleEvery > 0
}

function readMemorySample(): MemorySample {
  const usage = process.memoryUsage()
  return {
    rss: usage.rss ?? 0,
    heapTotal: usage.heapTotal ?? 0,
    heapUsed: usage.heapUsed ?? 0,
    external: usage.external ?? 0,
    arrayBuffers: usage.arrayBuffers ?? 0,
  }
}

function computeMemoryStats(samples: MemorySample[], start: MemorySample, end: MemorySample): MemoryStats {
  const all = [start, ...samples, end]
  const peak = { ...start }

  for (const sample of all) {
    peak.rss = Math.max(peak.rss, sample.rss)
    peak.heapTotal = Math.max(peak.heapTotal, sample.heapTotal)
    peak.heapUsed = Math.max(peak.heapUsed, sample.heapUsed)
    peak.external = Math.max(peak.external, sample.external)
    peak.arrayBuffers = Math.max(peak.arrayBuffers, sample.arrayBuffers)
  }

  return {
    samples: all.length,
    start,
    end,
    delta: diffMemory(start, end),
    peak,
  }
}

function diffMemory(start: MemorySample, end: MemorySample): MemorySample {
  return {
    rss: end.rss - start.rss,
    heapTotal: end.heapTotal - start.heapTotal,
    heapUsed: end.heapUsed - start.heapUsed,
    external: end.external - start.external,
    arrayBuffers: end.arrayBuffers - start.arrayBuffers,
  }
}

function computeTimingStats(durations: number[]): TimingStats {
  const sorted = [...durations].sort((a, b) => a - b)
  const count = sorted.length
  const sum = sorted.reduce((acc, value) => acc + value, 0)
  const average = count > 0 ? sum / count : 0
  const min = sorted[0] ?? 0
  const max = sorted[count - 1] ?? 0
  const median = count > 0 ? (sorted[Math.floor(count / 2)] ?? 0) : 0
  const p95 = count > 0 ? (sorted[Math.floor(count * 0.95)] ?? 0) : 0
  const stdDev = count > 0 ? Math.sqrt(sorted.reduce((acc, v) => acc + Math.pow(v - average, 2), 0) / count) : 0

  return {
    count,
    averageMs: average,
    medianMs: median,
    p95Ms: p95,
    minMs: min,
    maxMs: max,
    stdDevMs: stdDev,
  }
}

async function outputResults(
  meta: OutputMeta,
  results: ScenarioResult[],
  scenarioLines: string[],
  outputEnabled: boolean,
  outputPath: string | null,
): Promise<void> {
  const runId = new Date().toISOString()
  const payload = {
    runId,
    suite: meta.suiteName,
    config: {
      width: meta.width,
      height: meta.height,
      iterations: meta.iterations,
      warmupIterations: meta.warmupIterations,
      longIterations: meta.longIterations,
      scale: meta.scale,
      seed: meta.seed,
      memSampleEvery: meta.memSampleEvery,
    },
    results,
  }

  if (outputEnabled) {
    writeLine(
      `text-table-benchmark suite=${meta.suiteName} mode=content-set-and-render iters=${meta.iterations} warmup=${meta.warmupIterations}`,
    )
    for (const line of scenarioLines) {
      writeLine(line)
    }
  }

  if (outputPath) {
    try {
      const json = JSON.stringify(payload, null, 2)
      await Bun.write(outputPath, json)
    } catch (error: any) {
      writeLine(`Error writing results to ${outputPath}: ${error.message}`)
    }
  }
}

function formatBytes(value: number): string {
  return `${(value / (1024 * 1024)).toFixed(2)}MB`
}

function formatScenarioResult(result: ScenarioResult): string {
  const mem = result.memoryStats
  const memSummary = mem
    ? ` memDeltaRss=${formatBytes(mem.delta.rss)}` +
      ` memDeltaHeap=${formatBytes(mem.delta.heapUsed)}` +
      ` memDeltaExt=${formatBytes(mem.delta.external)}` +
      ` memDeltaAB=${formatBytes(mem.delta.arrayBuffers)}` +
      ` memPeakRss=${formatBytes(mem.peak.rss)}`
    : ""

  const fitter = typeof result.settings.columnFitter === "string" ? result.settings.columnFitter : "unknown"

  return `scenario=${result.name} category=${result.category} mode=${result.timingMode} fitter=${fitter} iters=${result.updateStats.count} elapsedMs=${result.elapsedMs} avgMs=${result.updateStats.averageMs.toFixed(3)} medianMs=${result.updateStats.medianMs.toFixed(3)} p95Ms=${result.updateStats.p95Ms.toFixed(3)} minMs=${result.updateStats.minMs.toFixed(3)} maxMs=${result.updateStats.maxMs.toFixed(3)} rows=${result.tableStats.finalRows} maxRows=${result.tableStats.maxRows} cols=${result.tableStats.columns}${memSummary}`
}

function writeLine(line: string): void {
  realStdoutWrite(`${line}\n`)
}
