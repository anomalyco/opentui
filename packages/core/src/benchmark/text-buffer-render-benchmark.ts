#!/usr/bin/env bun

// These scenarios isolate text-buffer/editor rendering from the rest of the UI
// so native text drawing and TextRenderable lifecycle work can be measured on
// wrapped, styled, and selected content with minimal unrelated noise.

import { performance } from "node:perf_hooks"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Command } from "commander"
import {
  bold,
  BoxRenderable,
  dim,
  EditBuffer,
  EditorView,
  fg,
  link,
  OptimizedBuffer,
  RGBA,
  StyledText,
  TextBuffer,
  TextBufferView,
  TextNodeRenderable,
  TextRenderable,
  TextareaRenderable,
  underline,
} from "../index.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"

type ScenarioKind = "direct-buffer" | "render-tree"

type ScenarioRuntime = {
  kind: ScenarioKind
  drawCallsPerIteration: number
  renderablesPerIteration: number
  runIteration: (iteration: number) => Promise<void> | void
  teardown?: () => Promise<void> | void
}

type ScenarioDefinition = {
  name: string
  description: string
  setup: (ctx: BenchmarkContext) => Promise<ScenarioRuntime> | ScenarioRuntime
}

type ScenarioResult = {
  name: string
  description: string
  kind: ScenarioKind
  iterations: number
  warmupIterations: number
  elapsedMs: number
  drawCallsPerIteration: number
  renderablesPerIteration: number
  avgMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
  stdDevMs: number
  avgUsPerDrawCall: number
}

type BenchmarkContext = {
  renderer: TestRenderer
  buffer: OptimizedBuffer
  renderOnce: () => Promise<void>
  width: number
  height: number
}

type TimingStats = {
  avgMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
  stdDevMs: number
}

type TextFeedTreeState = {
  root: BoxRenderable
  textNodes: TextRenderable[]
  drawCallsPerIteration: number
  renderablesPerIteration: number
}

type TextNodeFeedTreeState = {
  root: BoxRenderable
  texts: TextRenderable[]
  mutableLeaves: TextNodeRenderable[]
  drawCallsPerIteration: number
  renderablesPerIteration: number
}

const SUITES = {
  quick: { iterations: 300, warmupIterations: 40 },
  default: { iterations: 1800, warmupIterations: 120 },
  long: { iterations: 5000, warmupIterations: 250 },
} as const

const COLORS = {
  transparent: RGBA.fromInts(0, 0, 0, 0),
  panel: RGBA.fromInts(28, 32, 38),
  element: RGBA.fromInts(40, 46, 56),
  accent: RGBA.fromInts(84, 171, 224),
  success: RGBA.fromInts(143, 188, 143),
  warning: RGBA.fromInts(219, 186, 96),
  selectionBg: RGBA.fromInts(73, 84, 107),
  selectionFg: RGBA.fromInts(236, 239, 244),
} as const

const program = new Command()
program
  .name("text-buffer-render-benchmark")
  .description("Benchmark bufferDrawTextBufferView and related render paths")
  .option("-s, --suite <name>", "benchmark suite: quick, default, long", "default")
  .option("-i, --iterations <count>", "iterations per scenario")
  .option("--warmup-iterations <count>", "warmup iterations per scenario")
  .option("--width <count>", "test renderer width", "140")
  .option("--height <count>", "test renderer height", "44")
  .option("--scenario <name>", "run only one scenario")
  .option("--list-scenarios", "list scenario names and exit")
  .option("--json [path]", "write benchmark results to JSON")
  .option("--no-output", "suppress stdout output")
  .parse(process.argv)

const options = program.opts()
const suiteName = String(options.suite)
const suiteDefaults = SUITES[suiteName as keyof typeof SUITES]

if (!suiteDefaults) {
  console.error(`Unknown suite: ${suiteName}. Valid suites: ${Object.keys(SUITES).join(", ")}`)
  process.exit(1)
}

const iterations = Math.max(1, Math.floor(toNumber(options.iterations, suiteDefaults.iterations)))
const warmupIterations = Math.max(0, Math.floor(toNumber(options.warmupIterations, suiteDefaults.warmupIterations)))
const width = Math.max(40, Math.floor(toNumber(options.width, 140)))
const height = Math.max(20, Math.floor(toNumber(options.height, 44)))
const scenarioFilter = options.scenario ? String(options.scenario) : null
const outputEnabled = options.output !== false

const jsonArg = options.json
const jsonPath =
  typeof jsonArg === "string"
    ? path.resolve(process.cwd(), jsonArg)
    : jsonArg
      ? path.resolve(process.cwd(), "latest-text-buffer-render-bench-run.json")
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

const scenarios = createScenarios()

if (options.listScenarios) {
  for (const scenario of scenarios) {
    console.log(`${scenario.name}`)
  }
  process.exit(0)
}

const selectedScenarios = scenarioFilter ? scenarios.filter((scenario) => scenario.name === scenarioFilter) : scenarios
if (selectedScenarios.length === 0) {
  console.error(`Unknown scenario: ${scenarioFilter}`)
  process.exit(1)
}

if (outputEnabled) {
  console.log(`text buffer render benchmark (${suiteName})`)
  console.log(`- renderer: ${width}x${height}`)
  console.log(`- scenarios: ${selectedScenarios.length}`)
  console.log(`- iterations: ${iterations} (+${warmupIterations} warmup)`)
}

const { renderer, renderOnce } = await createTestRenderer({
  width,
  height,
  targetFps: 60,
  maxFps: 60,
  screenMode: "main-screen",
  externalOutputMode: "passthrough",
  consoleMode: "disabled",
  useMouse: false,
})

let buffer: OptimizedBuffer | undefined
const results: ScenarioResult[] = []

try {
  buffer = OptimizedBuffer.create(width, height, "unicode", { owner: renderer.nativeScene })
  const ctx: BenchmarkContext = { renderer, renderOnce, width, height, buffer }
  for (const scenario of selectedScenarios) {
    writeLine(outputEnabled, `Running ${scenario.name}...`)
    const result = await runScenario(scenario, ctx, iterations, warmupIterations)
    results.push(result)
    writeLine(outputEnabled, `  avg=${result.avgMs.toFixed(4)}ms p95=${result.p95Ms.toFixed(4)}ms`)
  }
} finally {
  buffer?.destroy()
  renderer.destroy()
  await renderer.closed
}

if (outputEnabled) {
  console.table(
    results.map((result) => ({
      scenario: result.name,
      kind: result.kind,
      drawCalls: result.drawCallsPerIteration,
      renderables: result.renderablesPerIteration,
      avgMs: result.avgMs,
      p95Ms: result.p95Ms,
      usPerDraw: result.avgUsPerDrawCall,
    })),
  )
}

if (jsonPath) {
  await Bun.write(
    jsonPath,
    JSON.stringify(
      {
        metadata: {
          suite: suiteName,
          width,
          height,
          iterations,
          warmupIterations,
          scenarioFilter,
          timestamp: new Date().toISOString(),
        },
        scenarios: results,
      },
      null,
      2,
    ),
  )
  writeLine(outputEnabled, `Wrote benchmark JSON: ${jsonPath}`)
}

function createScenarios(): ScenarioDefinition[] {
  return [
    {
      name: "direct_plain_wrapped_view",
      description: "Direct TextBufferView draw with plain wrapped transcript",
      setup: (ctx) => {
        clearRoot(ctx.renderer)

        const buffer = ctx.buffer
        const textBuffer = TextBuffer.create("unicode", ctx.renderer.nativeScene)
        textBuffer.setText(createPlainTranscript(140))

        const view = TextBufferView.create(textBuffer)
        view.setWrapMode("word")
        view.setViewport(0, 0, ctx.width - 2, ctx.height - 2)

        return {
          kind: "direct-buffer",
          drawCallsPerIteration: 1,
          renderablesPerIteration: 0,
          runIteration: () => {
            buffer.drawTextBuffer(view, 1, 1)
          },
          teardown: () => {
            view.destroy()
            textBuffer.destroy()
          },
        }
      },
    },
    {
      name: "direct_styled_wrapped_view",
      description: "Direct styled TextBufferView draw with many spans and links",
      setup: (ctx) => {
        clearRoot(ctx.renderer)

        const buffer = ctx.buffer
        const textBuffer = TextBuffer.create("unicode", ctx.renderer.nativeScene)
        textBuffer.setStyledText(createStyledTranscript(120))

        const view = TextBufferView.create(textBuffer)
        view.setWrapMode("word")
        view.setViewport(0, 0, ctx.width - 2, ctx.height - 2)

        return {
          kind: "direct-buffer",
          drawCallsPerIteration: 1,
          renderablesPerIteration: 0,
          runIteration: () => {
            buffer.drawTextBuffer(view, 1, 1)
          },
          teardown: () => {
            view.destroy()
            textBuffer.destroy()
          },
        }
      },
    },
    {
      name: "direct_selected_styled_view",
      description: "Direct styled TextBufferView draw with active selection",
      setup: (ctx) => {
        clearRoot(ctx.renderer)

        const buffer = ctx.buffer
        const textBuffer = TextBuffer.create("unicode", ctx.renderer.nativeScene)
        const styled = createStyledTranscript(120)
        textBuffer.setStyledText(styled)

        const view = TextBufferView.create(textBuffer)
        view.setWrapMode("word")
        view.setViewport(0, 0, ctx.width - 2, ctx.height - 2)
        view.setSelection(80, 520, COLORS.selectionBg, COLORS.selectionFg)

        return {
          kind: "direct-buffer",
          drawCallsPerIteration: 1,
          renderablesPerIteration: 0,
          runIteration: () => {
            buffer.drawTextBuffer(view, 1, 1)
          },
          teardown: () => {
            view.destroy()
            textBuffer.destroy()
          },
        }
      },
    },
    {
      name: "direct_editor_view_selection",
      description: "Direct EditorView draw with wrapped content and selection",
      setup: (ctx) => {
        clearRoot(ctx.renderer)

        const buffer = ctx.buffer
        const editBuffer = EditBuffer.create("unicode", ctx.renderer.nativeScene)
        editBuffer.setText(createEditorDocument(220))
        const view = EditorView.create(editBuffer, ctx.width - 2, ctx.height - 2)
        view.setWrapMode("word")
        view.setViewport(0, 8, ctx.width - 2, ctx.height - 2, false)
        view.setSelection(120, 720, COLORS.selectionBg, COLORS.selectionFg)

        return {
          kind: "direct-buffer",
          drawCallsPerIteration: 1,
          renderablesPerIteration: 0,
          runIteration: () => {
            buffer.drawEditorView(view, 1, 1)
          },
          teardown: () => {
            view.destroy()
            editBuffer.destroy()
          },
        }
      },
    },
    {
      name: "render_text_feed_wrapped",
      description: "Render-tree feed of wrapped TextRenderables in layout wrappers",
      setup: async (ctx) => {
        const state = await buildTextFeedTree(ctx)
        return {
          kind: "render-tree",
          drawCallsPerIteration: state.textNodes.length,
          renderablesPerIteration: state.renderablesPerIteration,
          runIteration: async () => {
            await ctx.renderOnce()
          },
          teardown: () => {
            state.root.destroyRecursively()
          },
        }
      },
    },
    {
      name: "render_text_nodes_idle",
      description: "Render-tree TextRenderables backed by text nodes with no per-frame changes",
      setup: async (ctx) => {
        const state = await buildTextNodeFeedTree(ctx)
        return {
          kind: "render-tree",
          drawCallsPerIteration: state.drawCallsPerIteration,
          renderablesPerIteration: state.renderablesPerIteration,
          runIteration: async () => {
            await ctx.renderOnce()
          },
          teardown: () => {
            state.root.destroyRecursively()
          },
        }
      },
    },
    {
      name: "render_text_nodes_idle_dense",
      description: "Dense tree of idle text-node-backed TextRenderables",
      setup: async (ctx) => {
        const state = await buildDenseTextNodeTree(ctx)
        return {
          kind: "render-tree",
          drawCallsPerIteration: state.drawCallsPerIteration,
          renderablesPerIteration: state.renderablesPerIteration,
          runIteration: async () => {
            await ctx.renderOnce()
          },
          teardown: () => {
            state.root.destroyRecursively()
          },
        }
      },
    },
    {
      name: "render_text_nodes_mutating",
      description: "Render-tree TextRenderables backed by text nodes with per-frame text updates",
      setup: async (ctx) => {
        const state = await buildTextNodeFeedTree(ctx)
        return {
          kind: "render-tree",
          drawCallsPerIteration: state.drawCallsPerIteration,
          renderablesPerIteration: state.renderablesPerIteration,
          runIteration: async (iteration) => {
            const leaf = state.mutableLeaves[iteration % state.mutableLeaves.length]
            leaf.replace(`status-${iteration % 10}`.padEnd(12, " "), 0)
            await ctx.renderOnce()
          },
          teardown: () => {
            state.root.destroyRecursively()
          },
        }
      },
    },
    {
      name: "render_textarea_editor",
      description: "Render-tree Textarea editor view with selection and wrapping",
      setup: async (ctx) => {
        clearRoot(ctx.renderer)

        const root = new BoxRenderable(ctx.renderer, {
          id: "bench-textarea-root",
          width: "100%",
          height: "100%",
          border: false,
          backgroundColor: COLORS.transparent,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
        })
        ctx.renderer.root.add(root)

        const textarea = new TextareaRenderable(ctx.renderer, {
          id: "bench-textarea",
          width: "100%",
          height: Math.max(10, ctx.height - 2),
          wrapMode: "word",
          initialValue: createEditorDocument(220),
          selectionBg: COLORS.selectionBg,
          selectionFg: COLORS.selectionFg,
          showCursor: false,
          backgroundColor: COLORS.transparent,
          textColor: COLORS.selectionFg,
        })
        textarea.editorView.setSelection(120, 720, COLORS.selectionBg, COLORS.selectionFg)
        root.add(textarea)

        await ctx.renderOnce()

        return {
          kind: "render-tree",
          drawCallsPerIteration: 1,
          renderablesPerIteration: 2,
          runIteration: async () => {
            await ctx.renderOnce()
          },
          teardown: () => {
            root.destroyRecursively()
          },
        }
      },
    },
  ]
}

async function buildTextNodeFeedTree(ctx: BenchmarkContext): Promise<TextNodeFeedTreeState> {
  clearRoot(ctx.renderer)

  let renderablesPerIteration = 0
  const texts: TextRenderable[] = []
  const mutableLeaves: TextNodeRenderable[] = []

  const root = new BoxRenderable(ctx.renderer, {
    id: "bench-text-node-root",
    width: "100%",
    height: "100%",
    border: false,
    backgroundColor: COLORS.transparent,
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
    gap: 1,
  })
  renderablesPerIteration += 1
  ctx.renderer.root.add(root)

  const messageCount = Math.max(12, Math.floor((ctx.height - 2) / 2))
  for (let i = 0; i < messageCount; i += 1) {
    const row = new BoxRenderable(ctx.renderer, {
      id: `bench-text-node-row-${i}`,
      width: "100%",
      border: false,
      backgroundColor: COLORS.transparent,
      flexDirection: "row",
      gap: 1,
    })
    renderablesPerIteration += 1

    const rail = new BoxRenderable(ctx.renderer, {
      id: `bench-text-node-rail-${i}`,
      width: 2,
      minWidth: 2,
      maxWidth: 2,
      border: false,
      backgroundColor: COLORS.transparent,
    })
    renderablesPerIteration += 1

    const text = new TextRenderable(ctx.renderer, {
      id: `bench-text-node-${i}`,
      width: "100%",
      wrapMode: "word",
      bg: COLORS.transparent,
    })
    renderablesPerIteration += 1
    texts.push(text)

    const prefix = new TextNodeRenderable({ fg: COLORS.warning, attributes: 0 })
    prefix.add(`[${String(i).padStart(2, "0")}] `)

    const body = new TextNodeRenderable({ fg: COLORS.selectionFg, attributes: 0 })
    body.add("The renderer should update this text node tree only when it changes, not on every frame. ")

    const linkNode = new TextNodeRenderable({
      fg: COLORS.accent,
      link: { url: `https://example.test/${i}` },
      attributes: 0,
    })
    linkNode.add("documentation")

    const mutable = new TextNodeRenderable({ fg: COLORS.success, attributes: 0 })
    mutable.add(`status-${i % 10}`.padEnd(12, " "))
    mutableLeaves.push(mutable)

    body.add(linkNode)
    body.add(" current state=")
    body.add(mutable)
    body.add(" and wrapped notes about viewport offsets and selection handling.")

    text.add(prefix)
    text.add(body)

    row.add(rail)
    row.add(text)
    root.add(row)
  }

  await ctx.renderOnce()

  return {
    root,
    texts,
    mutableLeaves,
    drawCallsPerIteration: texts.length,
    renderablesPerIteration,
  }
}

async function buildDenseTextNodeTree(ctx: BenchmarkContext): Promise<TextNodeFeedTreeState> {
  clearRoot(ctx.renderer)

  let renderablesPerIteration = 0
  const texts: TextRenderable[] = []
  const mutableLeaves: TextNodeRenderable[] = []

  const root = new BoxRenderable(ctx.renderer, {
    id: "bench-dense-text-node-root",
    width: "100%",
    height: "100%",
    border: false,
    backgroundColor: COLORS.transparent,
    flexDirection: "column",
  })
  renderablesPerIteration += 1
  ctx.renderer.root.add(root)

  const textCount = Math.max(140, ctx.height * 6)
  for (let i = 0; i < textCount; i += 1) {
    const text = new TextRenderable(ctx.renderer, {
      id: `bench-dense-text-${i}`,
      width: "100%",
      wrapMode: "word",
      bg: COLORS.transparent,
    })
    renderablesPerIteration += 1
    texts.push(text)

    const prefix = new TextNodeRenderable({ fg: COLORS.warning, attributes: 0 })
    prefix.add(`${String(i).padStart(3, "0")}: `)

    const body = new TextNodeRenderable({ fg: COLORS.selectionFg, attributes: 0 })
    body.add("text-node lifecycle bookkeeping should stay idle when nothing changes ")

    const mutable = new TextNodeRenderable({ fg: COLORS.success, attributes: 0 })
    mutable.add(`idle-${i % 10}`)
    mutableLeaves.push(mutable)

    body.add(mutable)
    text.add(prefix)
    text.add(body)
    root.add(text)
  }

  await ctx.renderOnce()

  return {
    root,
    texts,
    mutableLeaves,
    drawCallsPerIteration: texts.length,
    renderablesPerIteration,
  }
}

async function buildTextFeedTree(ctx: BenchmarkContext): Promise<TextFeedTreeState> {
  clearRoot(ctx.renderer)

  let renderablesPerIteration = 0
  const textNodes: TextRenderable[] = []

  const root = new BoxRenderable(ctx.renderer, {
    id: "bench-text-feed-root",
    width: "100%",
    height: "100%",
    border: false,
    backgroundColor: COLORS.transparent,
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
    gap: 1,
  })
  renderablesPerIteration += 1
  ctx.renderer.root.add(root)

  const messageCount = Math.max(12, Math.floor((ctx.height - 2) / 2))
  for (let i = 0; i < messageCount; i += 1) {
    const row = new BoxRenderable(ctx.renderer, {
      id: `bench-text-row-${i}`,
      width: "100%",
      border: false,
      backgroundColor: COLORS.transparent,
      flexDirection: "row",
      gap: 1,
    })
    renderablesPerIteration += 1

    const rail = new BoxRenderable(ctx.renderer, {
      id: `bench-text-rail-${i}`,
      width: 2,
      minWidth: 2,
      maxWidth: 2,
      border: false,
      backgroundColor: COLORS.transparent,
    })
    renderablesPerIteration += 1

    const text = new TextRenderable(ctx.renderer, {
      id: `bench-text-${i}`,
      width: "100%",
      wrapMode: "word",
      content: i % 3 === 0 ? createStyledTranscript(4) : createStyledTranscript(3),
      bg: COLORS.transparent,
    })
    renderablesPerIteration += 1
    textNodes.push(text)

    row.add(rail)
    row.add(text)
    root.add(row)
  }

  await ctx.renderOnce()

  return {
    root,
    textNodes,
    drawCallsPerIteration: textNodes.length,
    renderablesPerIteration,
  }
}

async function runScenario(
  scenario: ScenarioDefinition,
  ctx: BenchmarkContext,
  iterations: number,
  warmupIterations: number,
): Promise<ScenarioResult> {
  ctx.buffer.clearScissorRects()
  ctx.buffer.clearOpacity()
  ctx.buffer.clear(COLORS.transparent)
  const runtime = await scenario.setup(ctx)

  try {
    for (let i = 0; i < warmupIterations; i += 1) {
      await runtime.runIteration(i)
    }

    const samples = new Array<number>(iterations)
    const elapsedStart = performance.now()

    for (let i = 0; i < iterations; i += 1) {
      const start = performance.now()
      await runtime.runIteration(i)
      samples[i] = performance.now() - start
    }

    const elapsedMs = performance.now() - elapsedStart
    const stats = calculateStats(samples)

    return {
      name: scenario.name,
      description: scenario.description,
      kind: runtime.kind,
      iterations,
      warmupIterations,
      elapsedMs: round(elapsedMs, 4),
      drawCallsPerIteration: runtime.drawCallsPerIteration,
      renderablesPerIteration: runtime.renderablesPerIteration,
      avgMs: round(stats.avgMs, 4),
      medianMs: round(stats.medianMs, 4),
      p95Ms: round(stats.p95Ms, 4),
      minMs: round(stats.minMs, 4),
      maxMs: round(stats.maxMs, 4),
      stdDevMs: round(stats.stdDevMs, 4),
      avgUsPerDrawCall:
        runtime.drawCallsPerIteration > 0 ? round((stats.avgMs * 1000) / runtime.drawCallsPerIteration, 3) : 0,
    }
  } finally {
    await runtime.teardown?.()
    clearRoot(ctx.renderer)
  }
}

function createPlainTranscript(lines: number): string {
  const parts: string[] = []
  for (let i = 0; i < lines; i += 1) {
    parts.push(
      `[${String(i).padStart(3, "0")}] The renderer keeps a wrapped transcript of tool output, inline notes, and status lines with occasional\ttabs and emoji like 📦.`,
    )
  }
  return parts.join("\n")
}

function createStyledTranscript(lines: number): StyledText {
  const chunks = []

  const plain = (text: string) => ({ __isChunk: true as const, text, attributes: 0 })

  for (let i = 0; i < lines; i += 1) {
    chunks.push(dim(`[12:${String(i % 60).padStart(2, "0")}] `))
    chunks.push(bold(fg("#88c0d0")(`agent-${i % 4}`)))
    chunks.push(plain(" opened "))
    chunks.push(underline(link(`https://example.test/item/${i}`)(fg("#81a1c1")("documentation"))))
    chunks.push(plain(" and returned "))
    chunks.push(fg(i % 2 === 0 ? "#a3be8c" : "#ebcb8b")("status=ok"))
    chunks.push(plain(" with inline code "))
    chunks.push(bold(fg("#d08770")("buffer.drawTextBuffer(view, x, y)")))
    chunks.push(plain(" plus wrapped notes about viewport offsets, spans, tabs\tand Unicode like café.\n"))
  }

  return new StyledText(chunks)
}

function createEditorDocument(lines: number): string {
  const out: string[] = []
  for (let i = 0; i < lines; i += 1) {
    out.push(
      `function render_line_${i}(view, buffer) { const status = "line-${i}"; return status + " => " + view.getVirtualLineCount(); }`,
    )
  }
  return out.join("\n")
}

function clearRoot(renderer: TestRenderer): void {
  for (const child of renderer.root.getChildren()) {
    child.destroyRecursively()
  }
}

function calculateStats(samples: number[]): TimingStats {
  if (samples.length === 0) {
    return {
      avgMs: 0,
      medianMs: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
      stdDevMs: 0,
    }
  }

  const sorted = [...samples].sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)
  const avgMs = total / samples.length
  const mid = Math.floor(sorted.length / 2)
  const medianMs = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  const p95Index = Math.floor((sorted.length - 1) * 0.95)
  const p95Ms = sorted[p95Index]
  const minMs = sorted[0]
  const maxMs = sorted[sorted.length - 1]

  let variance = 0
  for (const value of samples) {
    const diff = value - avgMs
    variance += diff * diff
  }
  variance /= samples.length

  return {
    avgMs,
    medianMs,
    p95Ms,
    minMs,
    maxMs,
    stdDevMs: Math.sqrt(variance),
  }
}

function round(value: number, places: number): number {
  return Number(value.toFixed(places))
}

function toNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function writeLine(enabled: boolean, line: string): void {
  if (enabled) {
    console.log(line)
  }
}
