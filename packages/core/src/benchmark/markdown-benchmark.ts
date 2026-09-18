#!/usr/bin/env bun

import { MarkdownRenderable, SyntaxStyle, createCliRenderer, parseColor } from "../index.js"
import { resolveRenderLib } from "../zig.js"
import { Command } from "commander"
import path from "node:path"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"

const realStdoutWrite = process.stdout.write.bind(process.stdout)
const nativeLib = resolveRenderLib()
const nativeBuildOptions = nativeLib.getBuildOptions()

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

const CODE_WORDS = [
  "buffer",
  "column",
  "row",
  "token",
  "state",
  "table",
  "stream",
  "render",
  "result",
  "index",
  "value",
  "output",
  "content",
]

type MemorySample = {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

type MemoryFieldStats = {
  min: number
  max: number
  avg: number
  median: number
}

type MemoryStats = {
  samples: number
  start: MemorySample
  end: MemorySample
  delta: MemorySample
  peak: MemorySample
  fields: {
    rss: MemoryFieldStats
    heapTotal: MemoryFieldStats
    heapUsed: MemoryFieldStats
    external: MemoryFieldStats
    arrayBuffers: MemoryFieldStats
  }
}

type NativeMemorySample = {
  totalRequestedBytes: number
  activeAllocations: number
  smallAllocations: number
  largeAllocations: number
  requestedBytesValid: boolean
}

type NativeMemoryStats = {
  samples: number
  start: NativeMemorySample
  end: NativeMemorySample
  delta: NativeMemorySample
  peak: NativeMemorySample
  requestedBytesReliable: boolean
  fields: {
    totalRequestedBytes: MemoryFieldStats
    activeAllocations: MemoryFieldStats
    smallAllocations: MemoryFieldStats
    largeAllocations: MemoryFieldStats
  }
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
  iterations: number
  warmupIterations: number
  elapsedMs: number
  category: "parse" | "incremental" | "style"
  timingMode: "content-set" | "style-refresh"
  updateStats: TimingStats
  memoryStats?: MemoryStats
  nativeMemoryStats?: NativeMemoryStats
  contentStats: {
    initialChars: number
    finalChars: number
    maxChars: number
    updates: number
    appendedChars: number
  }
  settings: Record<string, unknown>
}

type StaticScenarioPlan = {
  kind: "static"
  name: string
  description: string
  iterations: number
  warmupIterations: number
  content: string
  contentStats: Record<string, number>
}

type StreamingScenarioPlan = {
  kind: "streaming"
  name: string
  description: string
  iterations: number
  warmupIterations: number
  baseContent: string
  chunks: string[]
  repeat: boolean
  contentStats: Record<string, number>
}

type StyleScenarioPlan = {
  kind: "style"
  name: string
  description: string
  iterations: number
  warmupIterations: number
  content: string
  contentStats: Record<string, number>
}

type ScenarioPlan = StaticScenarioPlan | StreamingScenarioPlan | StyleScenarioPlan

type StreamState = {
  content: string
  chunks: string[]
  cursor: number
  repeat: boolean
  maxChars: number
  maxContentChars: number
  done: boolean
}

type RunContext = {
  renderer: Awaited<ReturnType<typeof createCliRenderer>>
  markdown: MarkdownRenderable
  syntaxStyleA: SyntaxStyle
  syntaxStyleB: SyntaxStyle
  streamIntervalMs: number
  chunkLines: number
  maxChars: number
  memInterval: number
  memSampleEvery: number
}

type SuiteConfig = {
  iterations: number
  warmupIterations: number
  longIterations: number
  scale: number
}

type MemorySampler = {
  jsSamples: MemorySample[]
  nativeSamples: NativeMemorySample[]
  recordIteration: (iteration: number) => void
  stop: () => void
}

type StaticScenarioConfig = {
  title: string
  sections: number
  paragraphsPerSection: number
  sentencesPerParagraph: number
  lists: number
  listItems: number
  tables: number
  tableRows: number
  tableCols: number
  codeBlocks: number
  codeLines: number
}

type StreamingScenarioConfig = StaticScenarioConfig & {
  repeat: boolean
}

type OutputMeta = {
  suiteName: string
  targetFps: number
  maxFps: number
  iterations: number
  warmupIterations: number
  longIterations: number
  streamIntervalMs: number
  chunkLines: number
  maxChars: number
  scale: number
  seed: number
  memInterval: number
  memSampleEvery: number
  gpaSafeStats: boolean
  gpaMemoryLimitTracking: boolean
}

const program = new Command()
program
  .name("markdown-benchmark")
  .description("MarkdownRenderable benchmark scenarios (frame-independent)")
  .option("-s, --suite <name>", "benchmark suite: quick, default, long", "default")
  .option("-i, --iterations <count>", "iterations per scenario", "1000")
  .option("--warmup-iterations <count>", "warmup iterations per scenario", "50")
  .option("--long-iterations <count>", "iterations for long streaming scenario", "3000")
  .option("--target-fps <fps>", "renderer target fps", "60")
  .option("--max-fps <fps>", "renderer max fps", "60")
  .option("--mem-interval <ms>", "time-based memory sampling in ms (0 disables)", "0")
  .option("--mem-sample-every <count>", "sample memory every N iterations (0 disables)", "10")
  .option("--stream-interval <ms>", "stream update interval in ms", "0")
  .option("--chunk-lines <count>", "lines appended per stream tick", "4")
  .option("--max-chars <count>", "max streaming content size before stopping growth", "5000000")
  .option("--scale <n>", "scale content size", "1")
  .option("--seed <n>", "seed for deterministic content", "1337")
  .option("--json [path]", "write JSON results to file")
  .option("--no-testing", "use production renderer (outputs to terminal)")
  .option("--scenario <name>", "run a single scenario")
  .option("--no-spawn-per-scenario", "run all scenarios in a single process")
  .option("--no-output", "suppress stdout output")
  .parse(process.argv)

const options = program.opts()

const suiteName = String(options.suite)
const iterations = Math.max(1, Math.floor(toNumber(options.iterations, 1000)))
const warmupIterations = Math.max(0, Math.floor(toNumber(options.warmupIterations, 50)))
const longIterations = Math.max(iterations, Math.floor(toNumber(options.longIterations, 3000)))
const targetFps = toNumber(options.targetFps, 60)
const maxFps = toNumber(options.maxFps, 60)
const memInterval = Math.max(0, Math.floor(toNumber(options.memInterval, 0)))
const memSampleEvery = Math.max(0, Math.floor(toNumber(options.memSampleEvery, 10)))
const streamIntervalMs = Math.max(0, Math.floor(toNumber(options.streamInterval, 0)))
const chunkLines = Math.max(1, Math.floor(toNumber(options.chunkLines, 4)))
const maxChars = Math.max(0, Math.floor(toNumber(options.maxChars, 5000000)))
const scale = Math.max(0.25, toNumber(options.scale, 1))
const seed = Math.max(1, Math.floor(toNumber(options.seed, 1337)))
const testing = options.testing !== false
const outputEnabled = options.output !== false
const scenarioFilter = options.scenario ? String(options.scenario) : null
const spawnPerScenario = options.spawnPerScenario !== false

const jsonArg = options.json
const jsonPath =
  typeof jsonArg === "string"
    ? path.resolve(process.cwd(), jsonArg)
    : jsonArg
      ? path.resolve(process.cwd(), "latest-markdown-bench-run.json")
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

const filteredScenarios = scenarioFilter ? scenarios.filter((scenario) => scenario.name === scenarioFilter) : scenarios

if (scenarioFilter && filteredScenarios.length === 0) {
  writeLine(`Unknown scenario: ${scenarioFilter}`)
  process.exit(1)
}

if (filteredScenarios.length === 0) {
  console.error(`Unknown suite: ${suiteName}`)
  process.exit(1)
}

if (spawnPerScenario && !scenarioFilter) {
  await runSpawnedScenarios(filteredScenarios)
  process.exit(0)
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps,
  maxFps,
  testing,
  screenMode: "main-screen",
  externalOutputMode: "passthrough",
  consoleMode: "disabled",
  useMouse: false,
})

renderer.requestRender = () => {}

const syntaxStyleA = SyntaxStyle.fromStyles(
  {
    default: { fg: parseColor("#E6EDF3") },
    "markup.heading": { fg: parseColor("#88C0D0"), bold: true },
    "markup.heading.1": { fg: parseColor("#8FBCBB"), bold: true },
    "markup.heading.2": { fg: parseColor("#81A1C1"), bold: true },
    "markup.heading.3": { fg: parseColor("#5E81AC"), bold: true },
    "markup.bold": { fg: parseColor("#ECEFF4"), bold: true },
    "markup.strong": { fg: parseColor("#ECEFF4"), bold: true },
    "markup.italic": { fg: parseColor("#E5E9F0"), italic: true },
    "markup.list": { fg: parseColor("#B48EAD") },
    "markup.raw": { fg: parseColor("#A3BE8C") },
    "markup.raw.block": { fg: parseColor("#A3BE8C") },
    "markup.raw.inline": { fg: parseColor("#A3BE8C") },
    "markup.link": { fg: parseColor("#81A1C1"), underline: true },
    "markup.link.label": { fg: parseColor("#88C0D0"), underline: true },
    "markup.link.url": { fg: parseColor("#88C0D0"), underline: true },
    "punctuation.special": { fg: parseColor("#616E88") },
    conceal: { fg: parseColor("#4C566A") },
  },
  renderer.nativeScene,
)

const syntaxStyleB = SyntaxStyle.fromStyles(
  {
    default: { fg: parseColor("#F8F8F2") },
    "markup.heading": { fg: parseColor("#A6E22E"), bold: true },
    "markup.heading.1": { fg: parseColor("#F92672"), bold: true },
    "markup.heading.2": { fg: parseColor("#66D9EF"), bold: true },
    "markup.heading.3": { fg: parseColor("#E6DB74") },
    "markup.bold": { fg: parseColor("#F8F8F2"), bold: true },
    "markup.strong": { fg: parseColor("#F8F8F2"), bold: true },
    "markup.italic": { fg: parseColor("#F8F8F2"), italic: true },
    "markup.list": { fg: parseColor("#F92672") },
    "markup.raw": { fg: parseColor("#E6DB74") },
    "markup.raw.block": { fg: parseColor("#E6DB74") },
    "markup.raw.inline": { fg: parseColor("#E6DB74") },
    "markup.link": { fg: parseColor("#66D9EF"), underline: true },
    "markup.link.label": { fg: parseColor("#E6DB74"), underline: true },
    "markup.link.url": { fg: parseColor("#66D9EF"), underline: true },
    "punctuation.special": { fg: parseColor("#75715E") },
    conceal: { fg: parseColor("#75715E") },
  },
  renderer.nativeScene,
)

const markdown = new MarkdownRenderable(renderer, {
  id: "markdown-bench",
  content: "",
  syntaxStyle: syntaxStyleA,
  conceal: true,
})

const ctx: RunContext = {
  renderer,
  markdown,
  syntaxStyleA,
  syntaxStyleB,
  streamIntervalMs,
  chunkLines,
  maxChars,
  memInterval,
  memSampleEvery,
}

const results: ScenarioResult[] = []
const scenarioLines: string[] = []

try {
  for (let i = 0; i < filteredScenarios.length; i += 1) {
    const plan = filteredScenarios[i]
    const result = await runScenario(plan, ctx)
    scenarioLines.push(formatScenarioResult(result))
    results.push(result)
  }
} finally {
  renderer.destroy()
}

await outputResults(
  {
    suiteName,
    targetFps,
    maxFps,
    iterations,
    warmupIterations,
    longIterations,
    streamIntervalMs,
    chunkLines,
    maxChars,
    scale,
    seed,
    memInterval,
    memSampleEvery,
    gpaSafeStats: nativeBuildOptions.gpaSafeStats,
    gpaMemoryLimitTracking: nativeBuildOptions.gpaMemoryLimitTracking,
  },
  results,
  scenarioLines,
  outputEnabled,
  jsonPath,
)

function createScenarios(suite: string, config: SuiteConfig, runSeed: number): ScenarioPlan[] {
  const rng = createRng(runSeed)
  const baseIterations = config.iterations
  const baseWarmup = config.warmupIterations
  const longIterations = config.longIterations

  const staticSmallDoc = buildMarkdownDocument(rng, {
    title: "Markdown Static Small",
    sections: scaled(3, config.scale),
    paragraphsPerSection: scaled(2, config.scale),
    sentencesPerParagraph: 3,
    lists: scaled(2, config.scale),
    listItems: 6,
    tables: scaled(2, config.scale),
    tableRows: scaled(12, config.scale),
    tableCols: 4,
    codeBlocks: scaled(2, config.scale),
    codeLines: 8,
  })

  const staticLargeDoc = buildMarkdownDocument(rng, {
    title: "Markdown Static Large",
    sections: scaled(6, config.scale),
    paragraphsPerSection: scaled(3, config.scale),
    sentencesPerParagraph: 4,
    lists: scaled(3, config.scale),
    listItems: 8,
    tables: scaled(6, config.scale),
    tableRows: scaled(40, config.scale),
    tableCols: 6,
    codeBlocks: scaled(4, config.scale),
    codeLines: 14,
  })

  const tableOnlySmallDoc = buildTableOnlyDocument(rng, {
    title: "Markdown Tables Only Small",
    tables: scaled(3, config.scale),
    rows: scaled(24, config.scale),
    cols: 4,
  })

  const tableOnlyLargeDoc = buildTableOnlyDocument(rng, {
    title: "Markdown Tables Only Large",
    tables: scaled(8, config.scale),
    rows: scaled(60, config.scale),
    cols: 6,
  })

  const codeOnlySmallDoc = buildCodeOnlyDocument(rng, {
    title: "Markdown Code Only Small",
    blocks: scaled(8, config.scale),
    lines: scaled(10, config.scale),
  })

  const codeOnlyLargeDoc = buildCodeOnlyDocument(rng, {
    title: "Markdown Code Only Large",
    blocks: scaled(24, config.scale),
    lines: scaled(16, config.scale),
  })

  const headingsOnlyDoc = buildHeadingsOnlyDocument(rng, {
    title: "Markdown Headings Only",
    headings: scaled(200, config.scale),
    depthMin: 2,
    depthMax: 4,
    wordsPerHeading: 4,
  })

  const streamMixedConfig = {
    title: "Markdown Stream Mixed",
    sections: scaled(5, config.scale),
    paragraphsPerSection: scaled(2, config.scale),
    sentencesPerParagraph: 3,
    lists: scaled(2, config.scale),
    listItems: 6,
    tables: scaled(4, config.scale),
    tableRows: scaled(18, config.scale),
    tableCols: 5,
    codeBlocks: scaled(3, config.scale),
    codeLines: 10,
    repeat: true,
  }

  const streamTablesConfig = {
    title: "Markdown Stream Tables Long",
    sections: scaled(4, config.scale),
    paragraphsPerSection: scaled(1, config.scale),
    sentencesPerParagraph: 2,
    lists: scaled(1, config.scale),
    listItems: 4,
    tables: scaled(8, config.scale),
    tableRows: scaled(50, config.scale),
    tableCols: 6,
    codeBlocks: scaled(2, config.scale),
    codeLines: 8,
    repeat: true,
  }

  const streamMixedBase = buildMarkdownDocument(rng, {
    ...streamMixedConfig,
    tables: Math.max(1, Math.floor(streamMixedConfig.tables / 2)),
    tableRows: Math.max(6, Math.floor(streamMixedConfig.tableRows / 2)),
    codeBlocks: Math.max(1, Math.floor(streamMixedConfig.codeBlocks / 2)),
  })

  const streamTablesBase = buildMarkdownDocument(rng, {
    ...streamTablesConfig,
    tables: Math.max(1, Math.floor(streamTablesConfig.tables / 2)),
    tableRows: Math.max(6, Math.floor(streamTablesConfig.tableRows / 2)),
    codeBlocks: Math.max(1, Math.floor(streamTablesConfig.codeBlocks / 2)),
  })

  const streamMixedChunks = buildStreamingChunks(rng, streamMixedConfig)
  const streamTablesChunks = buildStreamingChunks(rng, streamTablesConfig)

  const tableRowStreamCols = Math.max(3, scaled(6, config.scale))
  const tableRowStreamBaseRows = 1
  const tableRowStreamRows = Math.max(200, scaled(400, config.scale))
  const tableRowStreamBaseLines = makeTableLines(rng, tableRowStreamCols, tableRowStreamBaseRows)
  const tableRowStreamBaseContent = `# Stream Table Rows\n\n${tableRowStreamBaseLines.join("\n")}\n`
  const tableRowStreamChunks = buildTableRowChunks(rng, {
    rows: tableRowStreamRows,
    cols: tableRowStreamCols,
  })

  const codeBlockStreamBlocks = Math.max(40, scaled(80, config.scale))
  const codeBlockStreamLines = Math.max(6, scaled(10, config.scale))
  const codeBlockStreamBaseContent = "# Stream Code Blocks\n\n"
  const codeBlockStreamChunks = buildCodeBlockChunks(rng, {
    blocks: codeBlockStreamBlocks,
    lines: codeBlockStreamLines,
  })

  const headingStreamCount = Math.max(200, scaled(400, config.scale))
  const headingStreamBaseContent = "# Stream Headings\n\n"
  const headingStreamChunks = buildHeadingChunks(rng, {
    headings: headingStreamCount,
    depthMin: 2,
    depthMax: 4,
    wordsPerHeading: 4,
  })

  const staticSmall: StaticScenarioPlan = {
    kind: "static",
    name: "parse_small",
    description: "Full parse/build on a small static document",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    content: staticSmallDoc.content,
    contentStats: staticSmallDoc.stats,
  }

  const staticLarge: StaticScenarioPlan = {
    kind: "static",
    name: "parse_large_tables",
    description: "Full parse/build on a large, table-heavy document",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    content: staticLargeDoc.content,
    contentStats: staticLargeDoc.stats,
  }

  const tableOnlySmall: StaticScenarioPlan = {
    kind: "static",
    name: "parse_tables_only_small",
    description: "Full parse/build on tables-only small document",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    content: tableOnlySmallDoc.content,
    contentStats: tableOnlySmallDoc.stats,
  }

  const tableOnlyLarge: StaticScenarioPlan = {
    kind: "static",
    name: "parse_tables_only_large",
    description: "Full parse/build on tables-only large document",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    content: tableOnlyLargeDoc.content,
    contentStats: tableOnlyLargeDoc.stats,
  }

  const codeOnlySmall: StaticScenarioPlan = {
    kind: "static",
    name: "parse_code_only_small",
    description: "Full parse/build on code-only document",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    content: codeOnlySmallDoc.content,
    contentStats: codeOnlySmallDoc.stats,
  }

  const codeOnlyLarge: StaticScenarioPlan = {
    kind: "static",
    name: "parse_code_only_large",
    description: "Full parse/build on large code-only document",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    content: codeOnlyLargeDoc.content,
    contentStats: codeOnlyLargeDoc.stats,
  }

  const headingsOnly: StaticScenarioPlan = {
    kind: "static",
    name: "parse_headings_only",
    description: "Full parse/build on headings-only document",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    content: headingsOnlyDoc.content,
    contentStats: headingsOnlyDoc.stats,
  }

  const streamMixed: StreamingScenarioPlan = {
    kind: "streaming",
    name: "incremental_mixed",
    description: "Incremental parsing with mixed streamed content",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    baseContent: streamMixedBase.content,
    chunks: streamMixedChunks,
    repeat: true,
    contentStats: {
      ...streamMixedBase.stats,
      streamTables: streamMixedConfig.tables,
      streamTableRows: streamMixedConfig.tableRows,
      streamTableCols: streamMixedConfig.tableCols,
      streamLists: streamMixedConfig.lists,
      streamListItems: streamMixedConfig.listItems,
      streamCodeBlocks: streamMixedConfig.codeBlocks,
      streamCodeLines: streamMixedConfig.codeLines,
    },
  }

  const streamTablesLong: StreamingScenarioPlan = {
    kind: "streaming",
    name: "incremental_tables_long",
    description: "Long incremental run with large tables",
    iterations: longIterations,
    warmupIterations: baseWarmup,
    baseContent: streamTablesBase.content,
    chunks: streamTablesChunks,
    repeat: true,
    contentStats: {
      ...streamTablesBase.stats,
      streamTables: streamTablesConfig.tables,
      streamTableRows: streamTablesConfig.tableRows,
      streamTableCols: streamTablesConfig.tableCols,
      streamLists: streamTablesConfig.lists,
      streamListItems: streamTablesConfig.listItems,
      streamCodeBlocks: streamTablesConfig.codeBlocks,
      streamCodeLines: streamTablesConfig.codeLines,
    },
  }

  const streamTableRows: StreamingScenarioPlan = {
    kind: "streaming",
    name: "incremental_table_rows",
    description: "Incremental parsing on growing single table rows",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    baseContent: tableRowStreamBaseContent,
    chunks: tableRowStreamChunks,
    repeat: true,
    contentStats: {
      tableCols: tableRowStreamCols,
      baseRows: tableRowStreamBaseRows,
      streamRows: tableRowStreamRows,
    },
  }

  const streamCodeBlocks: StreamingScenarioPlan = {
    kind: "streaming",
    name: "incremental_code_blocks",
    description: "Incremental parsing with appended code blocks",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    baseContent: codeBlockStreamBaseContent,
    chunks: codeBlockStreamChunks,
    repeat: true,
    contentStats: {
      codeBlocks: codeBlockStreamBlocks,
      codeLines: codeBlockStreamLines,
    },
  }

  const streamHeadings: StreamingScenarioPlan = {
    kind: "streaming",
    name: "incremental_headings",
    description: "Incremental parsing with appended headings",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    baseContent: headingStreamBaseContent,
    chunks: headingStreamChunks,
    repeat: true,
    contentStats: {
      headings: headingStreamCount,
      depthMin: 2,
      depthMax: 4,
      wordsPerHeading: 4,
    },
  }

  const styleSmall: StyleScenarioPlan = {
    kind: "style",
    name: "style_rerender_small",
    description: "Rerender blocks on style changes (small document)",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    content: staticSmallDoc.content,
    contentStats: staticSmallDoc.stats,
  }

  const styleLarge: StyleScenarioPlan = {
    kind: "style",
    name: "style_rerender_large",
    description: "Rerender blocks on style changes (large document)",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    content: staticLargeDoc.content,
    contentStats: staticLargeDoc.stats,
  }

  const styleTableSmall: StyleScenarioPlan = {
    kind: "style",
    name: "style_rerender_tables_only",
    description: "Rerender blocks on style changes (tables-only)",
    iterations: baseIterations,
    warmupIterations: baseWarmup,
    content: tableOnlySmallDoc.content,
    contentStats: tableOnlySmallDoc.stats,
  }

  if (suite === "quick") return [staticSmall, tableOnlySmall, streamMixed, streamTableRows, styleSmall]
  if (suite === "long")
    return [
      staticLarge,
      tableOnlyLarge,
      codeOnlyLarge,
      streamMixed,
      streamTableRows,
      streamCodeBlocks,
      streamHeadings,
      streamTablesLong,
      styleLarge,
    ]
  if (suite === "default")
    return [
      staticSmall,
      tableOnlySmall,
      codeOnlySmall,
      headingsOnly,
      staticLarge,
      streamMixed,
      streamTableRows,
      streamCodeBlocks,
      streamHeadings,
      styleSmall,
      styleTableSmall,
      styleLarge,
      streamTablesLong,
    ]
  return []
}

async function runScenario(plan: ScenarioPlan, ctx: RunContext): Promise<ScenarioResult> {
  if (plan.kind === "static") {
    return runStaticScenario(plan, ctx)
  }
  if (plan.kind === "style") {
    return runStyleScenario(plan, ctx)
  }
  return runStreamingScenario(plan, ctx)
}

async function runStaticScenario(plan: StaticScenarioPlan, ctx: RunContext): Promise<ScenarioResult> {
  ctx.markdown.streaming = false
  ctx.markdown.content = ""
  ctx.markdown.clearCache()

  for (let i = 0; i < plan.warmupIterations; i += 1) {
    ctx.markdown.content = ""
    ctx.markdown.clearCache()
    ctx.markdown.content = plan.content
  }

  const durations: number[] = []
  const measurementStart = Date.now()
  const memStart = shouldSampleMemory(ctx) ? readMemorySample() : null
  const nativeMemStart = shouldSampleMemory(ctx) ? readNativeMemorySample() : null
  const sampler = createMemorySampler(ctx)

  for (let i = 0; i < plan.iterations; i += 1) {
    ctx.markdown.content = ""
    ctx.markdown.clearCache()
    const start = performance.now()
    ctx.markdown.content = plan.content
    const elapsed = performance.now() - start
    durations.push(elapsed)
    sampler.recordIteration(i + 1)
  }

  const elapsedMs = Date.now() - measurementStart
  const memEnd = shouldSampleMemory(ctx) ? readMemorySample() : null
  const nativeMemEnd = shouldSampleMemory(ctx) ? readNativeMemorySample() : null
  sampler.stop()

  return {
    name: plan.name,
    description: plan.description,
    iterations: plan.iterations,
    warmupIterations: plan.warmupIterations,
    elapsedMs,
    category: "parse",
    timingMode: "content-set",
    updateStats: computeTimingStats(durations),
    memoryStats: memStart && memEnd ? computeMemoryStats(sampler.jsSamples, memStart, memEnd) : undefined,
    nativeMemoryStats:
      nativeMemStart && nativeMemEnd
        ? computeNativeMemoryStats(sampler.nativeSamples, nativeMemStart, nativeMemEnd)
        : undefined,
    contentStats: {
      initialChars: plan.content.length,
      finalChars: plan.content.length,
      maxChars: plan.content.length,
      updates: plan.iterations,
      appendedChars: 0,
    },
    settings: {
      ...plan.contentStats,
      mode: "static",
    },
  }
}

async function runStreamingScenario(plan: StreamingScenarioPlan, ctx: RunContext): Promise<ScenarioResult> {
  ctx.markdown.streaming = true
  const state = createStreamState({
    content: plan.baseContent,
    chunks: plan.chunks,
    repeat: plan.repeat,
    maxChars: ctx.maxChars,
  })

  ctx.markdown.content = state.content

  if (plan.warmupIterations > 0) {
    await runStreamingIterations(state, ctx, plan.warmupIterations, false)
  }

  const measurementStart = Date.now()
  const memStart = shouldSampleMemory(ctx) ? readMemorySample() : null
  const nativeMemStart = shouldSampleMemory(ctx) ? readNativeMemorySample() : null
  const sampler = createMemorySampler(ctx)

  const measured = await runStreamingIterations(state, ctx, plan.iterations, true, sampler)
  if (measured.durations.length < plan.iterations) {
    throw new Error(
      `streaming scenario '${plan.name}' ended early (updates=${measured.durations.length}/${plan.iterations}). Increase --max-chars or reduce --iterations.`,
    )
  }

  const elapsedMs = Date.now() - measurementStart
  const memEnd = shouldSampleMemory(ctx) ? readMemorySample() : null
  const nativeMemEnd = shouldSampleMemory(ctx) ? readNativeMemorySample() : null
  sampler.stop()

  return {
    name: plan.name,
    description: plan.description,
    iterations: plan.iterations,
    warmupIterations: plan.warmupIterations,
    elapsedMs,
    category: "incremental",
    timingMode: "content-set",
    updateStats: computeTimingStats(measured.durations),
    memoryStats: memStart && memEnd ? computeMemoryStats(sampler.jsSamples, memStart, memEnd) : undefined,
    nativeMemoryStats:
      nativeMemStart && nativeMemEnd
        ? computeNativeMemoryStats(sampler.nativeSamples, nativeMemStart, nativeMemEnd)
        : undefined,
    contentStats: {
      initialChars: plan.baseContent.length,
      finalChars: state.content.length,
      maxChars: state.maxContentChars,
      updates: measured.durations.length,
      appendedChars: measured.appendedChars,
    },
    settings: {
      ...plan.contentStats,
      mode: "streaming",
      streamIntervalMs: ctx.streamIntervalMs,
      appendLinesPerTick: ctx.chunkLines,
      maxChars: ctx.maxChars,
      repeat: plan.repeat,
    },
  }
}

async function runStyleScenario(plan: StyleScenarioPlan, ctx: RunContext): Promise<ScenarioResult> {
  ctx.markdown.streaming = false
  ctx.markdown.syntaxStyle = ctx.syntaxStyleA
  ctx.markdown.conceal = true
  ctx.markdown.content = plan.content

  for (let i = 0; i < plan.warmupIterations; i += 1) {
    ctx.markdown.conceal = !ctx.markdown.conceal
    ctx.markdown.refreshStyles()
  }

  const durations: number[] = []
  const measurementStart = Date.now()
  const memStart = shouldSampleMemory(ctx) ? readMemorySample() : null
  const nativeMemStart = shouldSampleMemory(ctx) ? readNativeMemorySample() : null
  const sampler = createMemorySampler(ctx)

  for (let i = 0; i < plan.iterations; i += 1) {
    ctx.markdown.conceal = !ctx.markdown.conceal
    ctx.markdown.syntaxStyle = i % 2 === 0 ? ctx.syntaxStyleA : ctx.syntaxStyleB
    const start = performance.now()
    ctx.markdown.refreshStyles()
    const elapsed = performance.now() - start
    durations.push(elapsed)
    sampler.recordIteration(i + 1)
  }

  const elapsedMs = Date.now() - measurementStart
  const memEnd = shouldSampleMemory(ctx) ? readMemorySample() : null
  const nativeMemEnd = shouldSampleMemory(ctx) ? readNativeMemorySample() : null
  sampler.stop()

  return {
    name: plan.name,
    description: plan.description,
    iterations: plan.iterations,
    warmupIterations: plan.warmupIterations,
    elapsedMs,
    category: "style",
    timingMode: "style-refresh",
    updateStats: computeTimingStats(durations),
    memoryStats: memStart && memEnd ? computeMemoryStats(sampler.jsSamples, memStart, memEnd) : undefined,
    nativeMemoryStats:
      nativeMemStart && nativeMemEnd
        ? computeNativeMemoryStats(sampler.nativeSamples, nativeMemStart, nativeMemEnd)
        : undefined,
    contentStats: {
      initialChars: plan.content.length,
      finalChars: plan.content.length,
      maxChars: plan.content.length,
      updates: plan.iterations,
      appendedChars: 0,
    },
    settings: {
      ...plan.contentStats,
      mode: "style",
    },
  }
}

async function runStreamingIterations(
  state: StreamState,
  ctx: RunContext,
  iterations: number,
  record: boolean,
  sampler?: MemorySampler,
): Promise<{ durations: number[]; appendedChars: number }> {
  const durations: number[] = []
  let appendedChars = 0

  for (let i = 0; i < iterations; i += 1) {
    const update = appendStream(state, ctx.chunkLines)
    if (!update.updated) break

    const start = performance.now()
    ctx.markdown.content = state.content
    const elapsed = performance.now() - start

    if (record) {
      durations.push(elapsed)
      appendedChars += update.appendedChars
      sampler?.recordIteration(durations.length)
    }

    if (ctx.streamIntervalMs > 0) {
      await Bun.sleep(ctx.streamIntervalMs)
    }
  }

  return { durations, appendedChars }
}

function createStreamState(input: {
  content: string
  chunks: string[]
  repeat: boolean
  maxChars: number
}): StreamState {
  return {
    content: input.content,
    chunks: input.chunks,
    cursor: 0,
    repeat: input.repeat,
    maxChars: input.maxChars,
    maxContentChars: input.content.length,
    done: false,
  }
}

function appendStream(state: StreamState, linesPerTick: number): { updated: boolean; appendedChars: number } {
  if (state.done) return { updated: false, appendedChars: 0 }
  let appended = ""

  for (let i = 0; i < linesPerTick; i += 1) {
    if (state.cursor >= state.chunks.length) {
      if (state.repeat) {
        state.cursor = 0
      } else {
        state.done = true
        break
      }
    }
    appended += state.chunks[state.cursor]
    state.cursor += 1
  }

  if (!appended) return { updated: false, appendedChars: 0 }

  if (state.maxChars > 0 && state.content.length + appended.length > state.maxChars) {
    state.done = true
    return { updated: false, appendedChars: 0 }
  }

  state.content += appended
  state.maxContentChars = Math.max(state.maxContentChars, state.content.length)

  return { updated: true, appendedChars: appended.length }
}

function buildMarkdownDocument(rng: () => number, config: StaticScenarioConfig): { content: string; stats: any } {
  const parts: string[] = []
  parts.push(`# ${config.title}`)

  for (let section = 0; section < config.sections; section += 1) {
    parts.push(`## Section ${section + 1}`)

    for (let p = 0; p < config.paragraphsPerSection; p += 1) {
      parts.push(makeParagraph(rng, config.sentencesPerParagraph))
    }

    if (config.lists > 0) {
      for (let l = 0; l < config.lists; l += 1) {
        parts.push(makeList(rng, config.listItems))
      }
    }

    if (config.tables > 0) {
      for (let t = 0; t < config.tables; t += 1) {
        const tableLines = makeTableLines(rng, config.tableCols, config.tableRows)
        parts.push(tableLines.join("\n"))
      }
    }

    if (config.codeBlocks > 0) {
      for (let c = 0; c < config.codeBlocks; c += 1) {
        parts.push(makeCodeBlock(rng, config.codeLines))
      }
    }
  }

  return {
    content: parts.join("\n\n") + "\n",
    stats: {
      sections: config.sections,
      paragraphsPerSection: config.paragraphsPerSection,
      sentencesPerParagraph: config.sentencesPerParagraph,
      listsPerSection: config.lists,
      totalLists: config.sections * config.lists,
      listItems: config.listItems,
      tablesPerSection: config.tables,
      totalTables: config.sections * config.tables,
      tableRows: config.tableRows,
      tableCols: config.tableCols,
      codeBlocksPerSection: config.codeBlocks,
      totalCodeBlocks: config.sections * config.codeBlocks,
      codeLines: config.codeLines,
      totalParagraphs: config.sections * config.paragraphsPerSection,
    },
  }
}

function buildTableOnlyDocument(
  rng: () => number,
  config: { title: string; tables: number; rows: number; cols: number },
): { content: string; stats: any } {
  const parts: string[] = []
  parts.push(`# ${config.title}`)
  for (let t = 0; t < config.tables; t += 1) {
    const tableLines = makeTableLines(rng, config.cols, config.rows)
    parts.push(tableLines.join("\n"))
  }

  return {
    content: parts.join("\n\n") + "\n",
    stats: {
      tables: config.tables,
      tableRows: config.rows,
      tableCols: config.cols,
    },
  }
}

function buildCodeOnlyDocument(
  rng: () => number,
  config: { title: string; blocks: number; lines: number },
): { content: string; stats: any } {
  const parts: string[] = []
  parts.push(`# ${config.title}`)
  for (let b = 0; b < config.blocks; b += 1) {
    parts.push(makeCodeBlock(rng, config.lines))
  }

  return {
    content: parts.join("\n\n") + "\n",
    stats: {
      codeBlocks: config.blocks,
      codeLines: config.lines,
    },
  }
}

function buildHeadingsOnlyDocument(
  rng: () => number,
  config: { title: string; headings: number; depthMin: number; depthMax: number; wordsPerHeading: number },
): { content: string; stats: any } {
  const parts: string[] = []
  parts.push(`# ${config.title}`)
  for (let i = 0; i < config.headings; i += 1) {
    parts.push(makeHeadingLine(rng, config.depthMin, config.depthMax, config.wordsPerHeading))
  }

  return {
    content: parts.join("\n") + "\n",
    stats: {
      headings: config.headings,
      depthMin: config.depthMin,
      depthMax: config.depthMax,
      wordsPerHeading: config.wordsPerHeading,
    },
  }
}

function buildHeadingChunks(
  rng: () => number,
  config: { headings: number; depthMin: number; depthMax: number; wordsPerHeading: number },
): string[] {
  const chunks: string[] = []
  for (let i = 0; i < config.headings; i += 1) {
    chunks.push(makeHeadingLine(rng, config.depthMin, config.depthMax, config.wordsPerHeading) + "\n")
  }
  return chunks
}

function buildCodeBlockChunks(rng: () => number, config: { blocks: number; lines: number }): string[] {
  const chunks: string[] = []
  for (let b = 0; b < config.blocks; b += 1) {
    const lines = makeCodeBlockLines(rng, config.lines)
    for (const line of lines) {
      chunks.push(`${line}\n`)
    }
    chunks.push("\n")
  }
  return chunks
}

function buildTableRowChunks(rng: () => number, config: { rows: number; cols: number }): string[] {
  const chunks: string[] = []
  for (let r = 0; r < config.rows; r += 1) {
    chunks.push(makeTableRowLine(rng, r, config.cols) + "\n")
  }
  return chunks
}

function buildStreamingChunks(rng: () => number, config: StreamingScenarioConfig): string[] {
  const chunks: string[] = []
  for (let section = 0; section < config.sections; section += 1) {
    pushLine(chunks, `### Stream Section ${section + 1}`)
    pushLine(chunks, "")

    for (let p = 0; p < config.paragraphsPerSection; p += 1) {
      pushLine(chunks, makeParagraph(rng, config.sentencesPerParagraph))
      pushLine(chunks, "")
    }

    for (let l = 0; l < config.lists; l += 1) {
      const listLines = makeListLines(rng, config.listItems)
      for (const line of listLines) {
        pushLine(chunks, line)
      }
      pushLine(chunks, "")
    }

    for (let t = 0; t < config.tables; t += 1) {
      const tableLines = makeTableLines(rng, config.tableCols, config.tableRows)
      for (const line of tableLines) {
        pushLine(chunks, line)
      }
      pushLine(chunks, "")
    }

    for (let c = 0; c < config.codeBlocks; c += 1) {
      const codeLines = makeCodeBlockLines(rng, config.codeLines)
      for (const line of codeLines) {
        pushLine(chunks, line)
      }
      pushLine(chunks, "")
    }
  }

  return chunks
}

function pushLine(chunks: string[], line: string): void {
  chunks.push(`${line}\n`)
}

function makeParagraph(rng: () => number, sentences: number): string {
  const parts: string[] = []
  for (let i = 0; i < sentences; i += 1) {
    parts.push(makeSentence(rng, 6, 12))
  }
  return parts.join(" ")
}

function makeSentence(rng: () => number, minWords: number, maxWords: number): string {
  const count = minWords + Math.floor(rng() * (maxWords - minWords + 1))
  const words: string[] = []
  for (let i = 0; i < count; i += 1) {
    let word = pick(rng, WORDS)
    if (rng() < 0.25) {
      word = wrapInline(rng, word)
    }
    words.push(word)
  }
  const sentence = words.join(" ")
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + "."
}

function wrapInline(rng: () => number, word: string): string {
  const roll = rng()
  if (roll < 0.08) return `**${word}**`
  if (roll < 0.16) return `*${word}*`
  if (roll < 0.22) return `\`${word}\``
  if (roll < 0.26) return `[${word}](https://example.com/${word})`
  return word
}

function makeList(rng: () => number, items: number): string {
  return makeListLines(rng, items).join("\n")
}

function makeListLines(rng: () => number, items: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < items; i += 1) {
    lines.push(`- ${makeSentence(rng, 4, 9)}`)
  }
  return lines
}

function makeCodeBlock(rng: () => number, lines: number): string {
  return makeCodeBlockLines(rng, lines).join("\n")
}

function makeCodeBlockLines(rng: () => number, lines: number): string[] {
  const variable = pick(rng, CODE_WORDS)
  const iterations = Math.max(2, Math.floor(lines / 2))
  const targetLines = Math.max(6, lines)
  const body: string[] = []
  body.push(`const ${variable} = ${Math.floor(rng() * 1000)}`)
  body.push(`let result = ${Math.floor(rng() * 10)}`)
  body.push(`for (let i = 0; i < ${iterations}; i += 1) {`)
  body.push(`  result += (${variable} + i) % 5`)
  body.push("}")
  body.push("return result")

  let fillerIndex = 0
  while (body.length < targetLines) {
    body.splice(body.length - 1, 0, `result += ${Math.floor(rng() * 10)} + ${fillerIndex}`)
    fillerIndex += 1
  }

  return ["```typescript", ...body, "```"]
}

function makeTableLines(rng: () => number, columns: number, rows: number): string[] {
  const header: string[] = []
  const align: string[] = []

  for (let c = 0; c < columns; c += 1) {
    header.push(`Column ${c + 1}`)
    if (c % 3 === 0) align.push(":---")
    else if (c % 3 === 1) align.push(":---:")
    else align.push("---:")
  }

  const lines: string[] = []
  lines.push(`| ${header.join(" | ")} |`)
  lines.push(`| ${align.join(" | ")} |`)

  for (let r = 0; r < rows; r += 1) {
    const cells: string[] = []
    for (let c = 0; c < columns; c += 1) {
      cells.push(makeCellText(rng, r, c))
    }
    lines.push(`| ${cells.join(" | ")} |`)
  }

  return lines
}

function makeTableRowLine(rng: () => number, row: number, columns: number): string {
  const cells: string[] = []
  for (let c = 0; c < columns; c += 1) {
    cells.push(makeCellText(rng, row, c))
  }
  return `| ${cells.join(" | ")} |`
}

function makeHeadingLine(rng: () => number, depthMin: number, depthMax: number, words: number): string {
  const depth = depthMin + Math.floor(rng() * Math.max(1, depthMax - depthMin + 1))
  const tokens: string[] = []
  for (let i = 0; i < words; i += 1) {
    tokens.push(pick(rng, WORDS))
  }
  return `${"#".repeat(depth)} ${tokens.join(" ")}`
}

function makeCellText(rng: () => number, row: number, col: number): string {
  const base = `${pick(rng, WORDS)} ${pick(rng, WORDS)}`
  const roll = rng()
  if (roll < 0.2) return `**${base}**`
  if (roll < 0.35) return `*${base}*`
  if (roll < 0.45) return `\`${base}\``
  if (roll < 0.55) return `${base} ${Math.floor(rng() * 100)}`
  if (roll < 0.6) return `[${base}](https://example.com/r${row}c${col})`
  return base
}

function pick<T>(rng: () => number, list: T[]): T {
  return list[Math.floor(rng() * list.length)]
}

function scaled(value: number, scaleValue: number): number {
  return Math.max(1, Math.round(value * scaleValue))
}

function createRng(initialSeed: number): () => number {
  let state = initialSeed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function shouldSampleMemory(ctx: RunContext): boolean {
  return ctx.memInterval > 0 || ctx.memSampleEvery > 0
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

function readNativeMemorySample(): NativeMemorySample {
  const stats = nativeLib.getAllocatorStats()
  return {
    totalRequestedBytes: stats.totalRequestedBytes,
    activeAllocations: stats.activeAllocations,
    smallAllocations: stats.smallAllocations,
    largeAllocations: stats.largeAllocations,
    requestedBytesValid: stats.requestedBytesValid,
  }
}

function createMemorySampler(ctx: RunContext): MemorySampler {
  const jsSamples: MemorySample[] = []
  const nativeSamples: NativeMemorySample[] = []

  const pushSample = (): void => {
    jsSamples.push(readMemorySample())
    nativeSamples.push(readNativeMemorySample())
  }

  if (ctx.memInterval > 0) {
    const timer = setInterval(() => {
      pushSample()
    }, ctx.memInterval)
    return {
      jsSamples,
      nativeSamples,
      recordIteration: () => {},
      stop: () => clearInterval(timer),
    }
  }

  if (ctx.memSampleEvery > 0) {
    return {
      jsSamples,
      nativeSamples,
      recordIteration: (iteration: number) => {
        if (iteration % ctx.memSampleEvery === 0) {
          pushSample()
        }
      },
      stop: () => {},
    }
  }

  return {
    jsSamples,
    nativeSamples,
    recordIteration: () => {},
    stop: () => {},
  }
}

function computeMemoryStats(samples: MemorySample[], start: MemorySample, end: MemorySample): MemoryStats {
  const all = [start, ...samples, end]
  const peak = { ...start }
  for (const sample of all) {
    updatePeak(sample, peak)
  }

  return {
    samples: all.length,
    start,
    end,
    delta: diffMemory(start, end),
    peak,
    fields: {
      rss: computeFieldStats(all.map((s) => s.rss)),
      heapTotal: computeFieldStats(all.map((s) => s.heapTotal)),
      heapUsed: computeFieldStats(all.map((s) => s.heapUsed)),
      external: computeFieldStats(all.map((s) => s.external)),
      arrayBuffers: computeFieldStats(all.map((s) => s.arrayBuffers)),
    },
  }
}

function computeNativeMemoryStats(
  samples: NativeMemorySample[],
  start: NativeMemorySample,
  end: NativeMemorySample,
): NativeMemoryStats {
  const all = [start, ...samples, end]
  const requestedBytesReliable = all.every((sample) => sample.requestedBytesValid)
  const peak = { ...start }
  for (const sample of all) {
    updateNativePeak(sample, peak)
  }

  return {
    samples: all.length,
    start,
    end,
    delta: diffNativeMemory(start, end),
    peak,
    requestedBytesReliable,
    fields: {
      totalRequestedBytes: computeFieldStats(all.map((s) => s.totalRequestedBytes)),
      activeAllocations: computeFieldStats(all.map((s) => s.activeAllocations)),
      smallAllocations: computeFieldStats(all.map((s) => s.smallAllocations)),
      largeAllocations: computeFieldStats(all.map((s) => s.largeAllocations)),
    },
  }
}

function updatePeak(sample: MemorySample, peak: MemorySample): void {
  peak.rss = Math.max(peak.rss, sample.rss)
  peak.heapTotal = Math.max(peak.heapTotal, sample.heapTotal)
  peak.heapUsed = Math.max(peak.heapUsed, sample.heapUsed)
  peak.external = Math.max(peak.external, sample.external)
  peak.arrayBuffers = Math.max(peak.arrayBuffers, sample.arrayBuffers)
}

function updateNativePeak(sample: NativeMemorySample, peak: NativeMemorySample): void {
  peak.totalRequestedBytes = Math.max(peak.totalRequestedBytes, sample.totalRequestedBytes)
  peak.activeAllocations = Math.max(peak.activeAllocations, sample.activeAllocations)
  peak.smallAllocations = Math.max(peak.smallAllocations, sample.smallAllocations)
  peak.largeAllocations = Math.max(peak.largeAllocations, sample.largeAllocations)
  peak.requestedBytesValid = peak.requestedBytesValid && sample.requestedBytesValid
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

function diffNativeMemory(start: NativeMemorySample, end: NativeMemorySample): NativeMemorySample {
  return {
    totalRequestedBytes: end.totalRequestedBytes - start.totalRequestedBytes,
    activeAllocations: end.activeAllocations - start.activeAllocations,
    smallAllocations: end.smallAllocations - start.smallAllocations,
    largeAllocations: end.largeAllocations - start.largeAllocations,
    requestedBytesValid: start.requestedBytesValid && end.requestedBytesValid,
  }
}

function computeFieldStats(values: number[]): MemoryFieldStats {
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0] ?? 0
  const max = sorted[sorted.length - 1] ?? 0
  const avg = sorted.length > 0 ? sorted.reduce((sum, v) => sum + v, 0) / sorted.length : 0
  const median = sorted.length > 0 ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0
  return { min, max, avg, median }
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
  resultsList: ScenarioResult[],
  scenarioLines: string[],
  outputEnabled: boolean,
  outputPath: string | null,
): Promise<void> {
  const runId = new Date().toISOString()
  const payload = {
    runId,
    suite: meta.suiteName,
    renderer: {
      targetFps: meta.targetFps,
      maxFps: meta.maxFps,
    },
    config: {
      iterations: meta.iterations,
      warmupIterations: meta.warmupIterations,
      longIterations: meta.longIterations,
      streamIntervalMs: meta.streamIntervalMs,
      chunkLines: meta.chunkLines,
      maxChars: meta.maxChars,
      scale: meta.scale,
      seed: meta.seed,
      memInterval: meta.memInterval,
      memSampleEvery: meta.memSampleEvery,
      gpaSafeStats: meta.gpaSafeStats,
      gpaMemoryLimitTracking: meta.gpaMemoryLimitTracking,
    },
    results: resultsList,
  }

  if (outputEnabled) {
    writeLine(
      `markdown-benchmark suite=${meta.suiteName} timing=frame-independent iters=${meta.iterations} warmup=${meta.warmupIterations}`,
    )
    writeLine(`native-build gpaSafeStats=${meta.gpaSafeStats} gpaMemoryLimitTracking=${meta.gpaMemoryLimitTracking}`)
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
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  const abs = Math.abs(value)

  if (abs < 1024) {
    return `${Math.trunc(value)}B`
  }

  let unitIndex = 0
  let scaled = abs
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024
    unitIndex += 1
  }

  const sign = value < 0 ? "-" : ""
  return `${sign}${scaled.toFixed(2)}${units[unitIndex]}`
}

function formatAllocs(value: number): string {
  const intValue = Math.trunc(value)
  const sign = intValue > 0 ? "+" : ""
  return `${sign}${intValue.toLocaleString("en-US")} allocs`
}

function formatScenarioResult(result: ScenarioResult): string {
  const jsMem = result.memoryStats
  const nativeMem = result.nativeMemoryStats

  const jsMemSummary = jsMem
    ? ` jsMemDeltaRss=${formatBytes(jsMem.delta.rss)}` +
      ` jsMemDeltaHeap=${formatBytes(jsMem.delta.heapUsed)}` +
      ` jsMemDeltaExt=${formatBytes(jsMem.delta.external)}` +
      ` jsMemDeltaAB=${formatBytes(jsMem.delta.arrayBuffers)}` +
      ` jsMemPeakRss=${formatBytes(jsMem.peak.rss)}`
    : ""

  const nativeMemSummary = nativeMem
    ? ` nativeMemDeltaReq=${nativeMem.requestedBytesReliable ? formatBytes(nativeMem.delta.totalRequestedBytes) : "invalid"}` +
      ` nativeMemDeltaReqBytes=${nativeMem.requestedBytesReliable ? `${Math.trunc(nativeMem.delta.totalRequestedBytes)}B` : "invalid"}` +
      ` nativeMemDeltaActive=${formatAllocs(nativeMem.delta.activeAllocations)}` +
      ` nativeMemDeltaSmall=${formatAllocs(nativeMem.delta.smallAllocations)}` +
      ` nativeMemDeltaLarge=${formatAllocs(nativeMem.delta.largeAllocations)}` +
      ` nativeMemPeakReq=${nativeMem.requestedBytesReliable ? formatBytes(nativeMem.peak.totalRequestedBytes) : "invalid"}` +
      ` nativeMemPeakReqBytes=${nativeMem.requestedBytesReliable ? `${Math.trunc(nativeMem.peak.totalRequestedBytes)}B` : "invalid"}` +
      ` nativeMemPeakActive=${formatAllocs(nativeMem.peak.activeAllocations)}` +
      ` nativeMemReqReliable=${nativeMem.requestedBytesReliable}`
    : ""

  return `scenario=${result.name} category=${result.category} mode=${result.timingMode} iters=${result.updateStats.count} elapsedMs=${result.elapsedMs} avgMs=${result.updateStats.averageMs.toFixed(3)} medianMs=${result.updateStats.medianMs.toFixed(3)} p95Ms=${result.updateStats.p95Ms.toFixed(3)} minMs=${result.updateStats.minMs.toFixed(3)} maxMs=${result.updateStats.maxMs.toFixed(3)} chars=${result.contentStats.finalChars}${jsMemSummary}${nativeMemSummary}`
}

function writeLine(line: string): void {
  realStdoutWrite(`${line}\n`)
}

async function runSpawnedScenarios(plans: ScenarioPlan[]): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "opentui-markdown-bench-"))
  const scenarioLines: string[] = []
  const results: ScenarioResult[] = []

  for (const plan of plans) {
    const jsonPath = path.join(tempDir, `scenario-${plan.name}.json`)
    const args = buildChildArgs(process.argv.slice(2), plan.name, jsonPath)
    const child = Bun.spawn([process.execPath, new URL(import.meta.url).pathname, ...args], {
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    })
    const exitCode = await child.exited
    if (exitCode !== 0) {
      throw new Error(`Scenario ${plan.name} failed with exit code ${exitCode}`)
    }

    const json = await readFile(jsonPath, "utf8")
    await unlink(jsonPath)
    const payload = JSON.parse(json)
    const result = payload.results?.[0] as ScenarioResult | undefined
    if (!result) {
      throw new Error(`Scenario ${plan.name} did not produce a result`)
    }
    results.push(result)
    scenarioLines.push(formatScenarioResult(result))
  }

  await outputResults(
    {
      suiteName,
      targetFps,
      maxFps,
      iterations,
      warmupIterations,
      longIterations,
      streamIntervalMs,
      chunkLines,
      maxChars,
      scale,
      seed,
      memInterval,
      memSampleEvery,
      gpaSafeStats: nativeBuildOptions.gpaSafeStats,
      gpaMemoryLimitTracking: nativeBuildOptions.gpaMemoryLimitTracking,
    },
    results,
    scenarioLines,
    outputEnabled,
    jsonPath,
  )
}

function buildChildArgs(args: string[], scenarioName: string, jsonPath: string): string[] {
  const filtered: string[] = []
  for (const arg of args) {
    if (arg === "--no-spawn-per-scenario") continue
    if (arg.startsWith("--scenario")) continue
    if (arg === "--json" || arg.startsWith("--json=")) continue
    if (arg === "--output" || arg === "--no-output") continue
    filtered.push(arg)
  }
  filtered.push(`--scenario=${scenarioName}`)
  filtered.push(`--json=${jsonPath}`)
  filtered.push("--no-output")
  filtered.push("--no-spawn-per-scenario")
  return filtered
}
