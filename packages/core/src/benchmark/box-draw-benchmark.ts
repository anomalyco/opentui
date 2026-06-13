#!/usr/bin/env bun

// These scenarios cover common box patterns such as split borders, prompt/toast
// layouts, and full-frame panels so drawBox is measured on realistic trees, not
// only isolated rectangles.

import { performance } from "node:perf_hooks"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Command } from "commander"
import { BoxRenderable, RGBA, borderCharsToArray, type BorderCharacters } from "../index.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"

type ScenarioKind = "direct-buffer" | "render-tree"

type ScenarioRuntime = {
  drawCallsPerIteration: number
  requestedCellsPerIteration: number
  runIteration: (iteration: number) => void | Promise<void>
  teardown?: () => void | Promise<void>
}

type ScenarioDefinition = {
  name: string
  description: string
  kind: ScenarioKind
  setup: (ctx: BenchmarkContext) => ScenarioRuntime | Promise<ScenarioRuntime>
}

type ScenarioResult = {
  name: string
  description: string
  kind: ScenarioKind
  iterations: number
  warmupIterations: number
  elapsedMs: number
  drawCallsPerIteration: number
  requestedCellsPerIteration: number
  avgMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
  stdDevMs: number
  avgUsPerDrawCall: number
  approxNsPerRequestedCell: number
}

type TimingStats = {
  avgMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
  stdDevMs: number
}

type BenchmarkContext = {
  renderer: TestRenderer
  renderOnce: () => Promise<void>
  width: number
  height: number
}

type DrawBoxOptions = {
  x: number
  y: number
  width: number
  height: number
  borderStyle?: "single" | "double" | "rounded" | "heavy"
  customBorderChars?: Uint32Array
  border: boolean | Array<"top" | "right" | "bottom" | "left">
  borderColor: RGBA
  backgroundColor: RGBA
  titleColor?: RGBA
  shouldFill?: boolean
  title?: string
  titleAlignment?: "left" | "center" | "right"
  bottomTitle?: string
  bottomTitleAlignment?: "left" | "center" | "right"
}

type OpencodeScreenTree = {
  root: BoxRenderable
  marker: BoxRenderable
  toast: BoxRenderable
  promptBorder: BoxRenderable
  messageBodies: BoxRenderable[]
  allBoxes: BoxRenderable[]
  drawCallsPerIteration: number
  requestedCellsPerIteration: number
}

const SUITES = {
  quick: { iterations: 300, warmupIterations: 40 },
  default: { iterations: 1400, warmupIterations: 120 },
  long: { iterations: 5000, warmupIterations: 250 },
} as const

const cp = (value: number): string => String.fromCodePoint(value)

const EMPTY_BORDER_CHARS: BorderCharacters = {
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  horizontal: " ",
  vertical: "",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
}

const SPLIT_BORDER_CHARS: BorderCharacters = {
  ...EMPTY_BORDER_CHARS,
  vertical: cp(0x2503),
}

const SPLIT_WITH_BOTTOM_TICK_CHARS: BorderCharacters = {
  ...SPLIT_BORDER_CHARS,
  bottomLeft: cp(0x2579),
}

const PROMPT_BOTTOM_BORDER_CHARS: BorderCharacters = {
  ...EMPTY_BORDER_CHARS,
  horizontal: cp(0x2580),
}

const SPLIT_BORDER_ARRAY = borderCharsToArray(SPLIT_BORDER_CHARS)
const SPLIT_WITH_BOTTOM_TICK_ARRAY = borderCharsToArray(SPLIT_WITH_BOTTOM_TICK_CHARS)
const PROMPT_BOTTOM_BORDER_ARRAY = borderCharsToArray(PROMPT_BOTTOM_BORDER_CHARS)

const BORDER_LEFT: Array<"left"> = ["left"]
const BORDER_LEFT_RIGHT: Array<"left" | "right"> = ["left", "right"]
const BORDER_TOP: Array<"top"> = ["top"]
const BORDER_BOTTOM: Array<"bottom"> = ["bottom"]

const COLORS = {
  transparent: RGBA.fromInts(0, 0, 0, 0),
  panel: RGBA.fromInts(28, 32, 38),
  element: RGBA.fromInts(40, 46, 56),
  menu: RGBA.fromInts(35, 40, 48),
  border: RGBA.fromInts(102, 118, 137),
  borderActive: RGBA.fromInts(131, 153, 181),
  accent: RGBA.fromInts(84, 171, 224),
  warning: RGBA.fromInts(219, 186, 96),
  error: RGBA.fromInts(220, 107, 107),
  danger: RGBA.fromInts(226, 95, 95),
  overlay: RGBA.fromInts(0, 0, 0, 150),
}

const MESSAGE_BORDER_COLORS = [COLORS.accent, COLORS.border, COLORS.borderActive, COLORS.warning, COLORS.error]
const TOAST_BORDER_COLORS = [COLORS.warning, COLORS.accent, COLORS.danger]
const FILL_COLORS = [COLORS.panel, COLORS.element, COLORS.menu]

const program = new Command()
program
  .name("box-draw-benchmark")
  .description("Benchmark drawBox scenarios with headless test renderer")
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
      ? path.resolve(process.cwd(), "latest-box-draw-bench-run.json")
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
    console.log(`${scenario.name} (${scenario.kind})`)
  }
  process.exit(0)
}

const selectedScenarios = scenarioFilter ? scenarios.filter((scenario) => scenario.name === scenarioFilter) : scenarios

if (selectedScenarios.length === 0) {
  console.error(`Unknown scenario: ${scenarioFilter}`)
  process.exit(1)
}

if (outputEnabled) {
  console.log(`drawBox benchmark (${suiteName})`)
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

renderer.requestRender = () => {}

const ctx: BenchmarkContext = {
  renderer,
  renderOnce,
  width,
  height,
}

const results: ScenarioResult[] = []

try {
  for (const scenario of selectedScenarios) {
    writeLine(outputEnabled, `Running ${scenario.name}...`)
    const result = await runScenario(scenario, ctx, iterations, warmupIterations)
    results.push(result)
    writeLine(
      outputEnabled,
      `  avg=${result.avgMs.toFixed(4)}ms p95=${result.p95Ms.toFixed(4)}ms draws=${result.drawCallsPerIteration}`,
    )
  }
} finally {
  renderer.destroy()
}

if (outputEnabled) {
  console.table(results.map(formatTableRow))
}

if (jsonPath) {
  const payload = {
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
  }

  await Bun.write(jsonPath, JSON.stringify(payload, null, 2))
  writeLine(outputEnabled, `Wrote benchmark JSON: ${jsonPath}`)
}

function createScenarios(): ScenarioDefinition[] {
  return [
    {
      name: "buffer_fill_only_panels",
      description: "Fill-only panel grid (common non-border box usage)",
      kind: "direct-buffer",
      setup: (ctx) => {
        clearRoot(ctx.renderer)
        resetBuffers(ctx.renderer)

        const buffer = ctx.renderer.currentRenderBuffer
        const specs = createFillPanelSpecs(ctx.width, ctx.height)

        return {
          drawCallsPerIteration: specs.length,
          requestedCellsPerIteration: sumRequestedCells(specs),
          runIteration: () => {
            for (const spec of specs) {
              buffer.drawBox(spec)
            }
          },
        }
      },
    },
    {
      name: "buffer_full_border_titles",
      description: "Single full panel with top and bottom titles",
      kind: "direct-buffer",
      setup: (ctx) => {
        clearRoot(ctx.renderer)
        resetBuffers(ctx.renderer)

        const buffer = ctx.renderer.currentRenderBuffer
        const variants = createTitleVariants(ctx.width, ctx.height)

        return {
          drawCallsPerIteration: 1,
          requestedCellsPerIteration: ctx.width * ctx.height,
          runIteration: (iteration) => {
            buffer.drawBox(variants[iteration % variants.length])
          },
        }
      },
    },
    {
      name: "buffer_split_left_stack",
      description: "OpenCode-like message stack with split left borders",
      kind: "direct-buffer",
      setup: (ctx) => {
        clearRoot(ctx.renderer)
        resetBuffers(ctx.renderer)

        const buffer = ctx.renderer.currentRenderBuffer
        const specs = createLeftBorderStackSpecs(ctx.width, ctx.height, MESSAGE_BORDER_COLORS, COLORS.transparent)

        return {
          drawCallsPerIteration: specs.length,
          requestedCellsPerIteration: sumRequestedCells(specs),
          runIteration: () => {
            for (const spec of specs) {
              buffer.drawBox(spec)
            }
          },
        }
      },
    },
    {
      name: "buffer_prompt_border_combo",
      description: "OpenCode prompt border combo (left + bottom styles)",
      kind: "direct-buffer",
      setup: (ctx) => {
        clearRoot(ctx.renderer)
        resetBuffers(ctx.renderer)

        const buffer = ctx.renderer.currentRenderBuffer
        const specs = createPromptComboSpecs(ctx.width, ctx.height)

        return {
          drawCallsPerIteration: specs.length,
          requestedCellsPerIteration: sumRequestedCells(specs),
          runIteration: () => {
            for (const spec of specs) {
              buffer.drawBox(spec)
            }
          },
        }
      },
    },
    {
      name: "buffer_toast_split_left_right",
      description: "OpenCode-like stacked toasts with split side borders",
      kind: "direct-buffer",
      setup: (ctx) => {
        clearRoot(ctx.renderer)
        resetBuffers(ctx.renderer)

        const buffer = ctx.renderer.currentRenderBuffer
        const specs = createToastSpecs(ctx.width)

        return {
          drawCallsPerIteration: specs.length,
          requestedCellsPerIteration: sumRequestedCells(specs),
          runIteration: () => {
            for (const spec of specs) {
              buffer.drawBox(spec)
            }
          },
        }
      },
    },
    {
      name: "buffer_scissored_split_stack",
      description: "Clipped split-border stack under a scroll-like scissor rect",
      kind: "direct-buffer",
      setup: (ctx) => {
        clearRoot(ctx.renderer)
        resetBuffers(ctx.renderer)

        const buffer = ctx.renderer.currentRenderBuffer
        const specs = createScrolledLeftBorderSpecs(ctx.width, ctx.height)
        const scissor = {
          x: 2,
          y: 2,
          width: Math.max(1, ctx.width - 4),
          height: Math.max(1, ctx.height - 8),
        }

        return {
          drawCallsPerIteration: specs.length,
          requestedCellsPerIteration: sumRequestedCells(specs),
          runIteration: () => {
            buffer.pushScissorRect(scissor.x, scissor.y, scissor.width, scissor.height)
            for (const spec of specs) {
              buffer.drawBox(spec)
            }
            buffer.popScissorRect()
          },
        }
      },
    },
    {
      name: "buffer_transparent_border_fg",
      description: "Split left borders with transparent border fg (alpha blend path)",
      kind: "direct-buffer",
      setup: (ctx) => {
        clearRoot(ctx.renderer)
        resetBuffers(ctx.renderer)

        const buffer = ctx.renderer.currentRenderBuffer
        const specs = createLeftBorderStackSpecs(ctx.width, ctx.height, [COLORS.transparent], COLORS.panel)

        return {
          drawCallsPerIteration: specs.length,
          requestedCellsPerIteration: sumRequestedCells(specs),
          runIteration: () => {
            for (const spec of specs) {
              buffer.drawBox(spec)
            }
          },
        }
      },
    },
    {
      name: "render_opencode_screen_static",
      description: "Headless render tree matching OpenCode box usage (static frame)",
      kind: "render-tree",
      setup: async (ctx) => {
        const state = await buildOpencodeScreenTree(ctx)
        return {
          drawCallsPerIteration: state.drawCallsPerIteration,
          requestedCellsPerIteration: state.requestedCellsPerIteration,
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
      name: "render_opencode_screen_dynamic",
      description: "Headless OpenCode-like tree with per-frame border/color updates",
      kind: "render-tree",
      setup: async (ctx) => {
        const state = await buildOpencodeScreenTree(ctx)
        const alignments = ["left", "center", "right"] as const

        return {
          drawCallsPerIteration: state.drawCallsPerIteration,
          requestedCellsPerIteration: state.requestedCellsPerIteration,
          runIteration: async (iteration) => {
            const body = state.messageBodies[iteration % state.messageBodies.length]
            const altBodyColor = FILL_COLORS[(iteration + 1) % FILL_COLORS.length]
            body.backgroundColor = altBodyColor
            state.toast.borderColor = TOAST_BORDER_COLORS[iteration % TOAST_BORDER_COLORS.length]
            state.promptBorder.borderColor = MESSAGE_BORDER_COLORS[iteration % MESSAGE_BORDER_COLORS.length]
            state.marker.titleAlignment = alignments[iteration % alignments.length]
            await ctx.renderOnce()
          },
          teardown: () => {
            state.root.destroyRecursively()
          },
        }
      },
    },
  ]
}

async function runScenario(
  scenario: ScenarioDefinition,
  ctx: BenchmarkContext,
  iterations: number,
  warmupIterations: number,
): Promise<ScenarioResult> {
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
      kind: scenario.kind,
      iterations,
      warmupIterations,
      elapsedMs: round(elapsedMs, 4),
      drawCallsPerIteration: runtime.drawCallsPerIteration,
      requestedCellsPerIteration: runtime.requestedCellsPerIteration,
      avgMs: round(stats.avgMs, 4),
      medianMs: round(stats.medianMs, 4),
      p95Ms: round(stats.p95Ms, 4),
      minMs: round(stats.minMs, 4),
      maxMs: round(stats.maxMs, 4),
      stdDevMs: round(stats.stdDevMs, 4),
      avgUsPerDrawCall:
        runtime.drawCallsPerIteration > 0 ? round((stats.avgMs * 1000) / runtime.drawCallsPerIteration, 2) : 0,
      approxNsPerRequestedCell:
        runtime.requestedCellsPerIteration > 0
          ? round((stats.avgMs * 1_000_000) / runtime.requestedCellsPerIteration, 2)
          : 0,
    }
  } finally {
    await runtime.teardown?.()
    clearRoot(ctx.renderer)
    resetBuffers(ctx.renderer)
  }
}

async function buildOpencodeScreenTree(ctx: BenchmarkContext): Promise<OpencodeScreenTree> {
  clearRoot(ctx.renderer)
  resetBuffers(ctx.renderer)

  const allBoxes: BoxRenderable[] = []
  const messageBodies: BoxRenderable[] = []

  const track = (box: BoxRenderable): BoxRenderable => {
    allBoxes.push(box)
    return box
  }

  const root = track(
    new BoxRenderable(ctx.renderer, {
      id: "bench-opencode-root",
      width: "100%",
      height: "100%",
      border: false,
      backgroundColor: COLORS.transparent,
      shouldFill: true,
      flexDirection: "column",
      gap: 0,
    }),
  )
  ctx.renderer.root.add(root)

  const feed = track(
    new BoxRenderable(ctx.renderer, {
      id: "bench-opencode-feed",
      width: "100%",
      flexGrow: 1,
      border: false,
      shouldFill: true,
      backgroundColor: COLORS.transparent,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      overflow: "hidden",
      flexDirection: "column",
      gap: 0,
    }),
  )
  root.add(feed)

  const messageCount = Math.max(10, Math.floor((ctx.height - 10) / 2))

  for (let i = 0; i < messageCount; i += 1) {
    const bodyHeight = i % 5 === 0 ? 3 : i % 3 === 0 ? 2 : 1

    const wrap = track(
      new BoxRenderable(ctx.renderer, {
        id: `bench-msg-wrap-${i}`,
        width: "100%",
        height: bodyHeight + 2,
        border: BORDER_LEFT,
        customBorderChars: SPLIT_BORDER_CHARS,
        borderColor: MESSAGE_BORDER_COLORS[i % MESSAGE_BORDER_COLORS.length],
        backgroundColor: COLORS.transparent,
        shouldFill: true,
        marginTop: i === 0 ? 0 : 1,
        paddingLeft: 2,
        paddingRight: 1,
        paddingTop: 1,
      }),
    )

    const body = track(
      new BoxRenderable(ctx.renderer, {
        id: `bench-msg-body-${i}`,
        width: "100%",
        height: bodyHeight,
        border: false,
        shouldFill: true,
        backgroundColor: i % 2 === 0 ? COLORS.panel : COLORS.element,
      }),
    )
    wrap.add(body)
    messageBodies.push(body)

    const metadata = track(
      new BoxRenderable(ctx.renderer, {
        id: `bench-msg-meta-${i}`,
        width: "100%",
        height: 1,
        border: false,
        shouldFill: true,
        backgroundColor: COLORS.transparent,
      }),
    )
    wrap.add(metadata)
    feed.add(wrap)
  }

  const marker = track(
    new BoxRenderable(ctx.renderer, {
      id: "bench-compaction-marker",
      width: "100%",
      height: 1,
      marginTop: 1,
      border: BORDER_TOP,
      borderColor: COLORS.borderActive,
      title: " Compaction ",
      titleAlignment: "center",
      backgroundColor: COLORS.transparent,
      shouldFill: true,
    }),
  )
  feed.add(marker)

  const promptOuter = track(
    new BoxRenderable(ctx.renderer, {
      id: "bench-prompt-outer",
      width: "100%",
      height: 7,
      border: BORDER_LEFT,
      customBorderChars: SPLIT_WITH_BOTTOM_TICK_CHARS,
      borderColor: COLORS.accent,
      backgroundColor: COLORS.transparent,
      shouldFill: true,
    }),
  )
  root.add(promptOuter)

  const promptMain = track(
    new BoxRenderable(ctx.renderer, {
      id: "bench-prompt-main",
      width: "100%",
      height: 6,
      border: false,
      shouldFill: true,
      backgroundColor: COLORS.element,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
    }),
  )
  promptOuter.add(promptMain)

  const promptTail = track(
    new BoxRenderable(ctx.renderer, {
      id: "bench-prompt-tail",
      width: "100%",
      height: 1,
      border: BORDER_LEFT,
      customBorderChars: SPLIT_WITH_BOTTOM_TICK_CHARS,
      borderColor: COLORS.accent,
      backgroundColor: COLORS.transparent,
      shouldFill: true,
    }),
  )
  root.add(promptTail)

  const promptShadow = track(
    new BoxRenderable(ctx.renderer, {
      id: "bench-prompt-shadow",
      width: "100%",
      height: 1,
      border: BORDER_BOTTOM,
      customBorderChars: PROMPT_BOTTOM_BORDER_CHARS,
      borderColor: COLORS.element,
      backgroundColor: COLORS.transparent,
      shouldFill: true,
    }),
  )
  promptTail.add(promptShadow)

  const toastWidth = Math.max(30, Math.min(50, ctx.width - 6))
  const toast = track(
    new BoxRenderable(ctx.renderer, {
      id: "bench-toast",
      position: "absolute",
      zIndex: 30,
      top: 2,
      left: Math.max(1, ctx.width - toastWidth - 2),
      width: toastWidth,
      height: 4,
      border: BORDER_LEFT_RIGHT,
      customBorderChars: SPLIT_BORDER_CHARS,
      borderColor: COLORS.warning,
      backgroundColor: COLORS.panel,
      shouldFill: true,
    }),
  )
  root.add(toast)

  const autocomplete = track(
    new BoxRenderable(ctx.renderer, {
      id: "bench-autocomplete",
      position: "absolute",
      zIndex: 25,
      top: Math.max(1, ctx.height - 14),
      left: 3,
      width: Math.max(24, Math.min(54, ctx.width - 8)),
      height: 8,
      border: BORDER_LEFT_RIGHT,
      customBorderChars: SPLIT_BORDER_CHARS,
      borderColor: COLORS.border,
      backgroundColor: COLORS.menu,
      shouldFill: true,
      paddingLeft: 1,
      paddingRight: 1,
    }),
  )
  root.add(autocomplete)

  for (let i = 0; i < 6; i += 1) {
    const item = track(
      new BoxRenderable(ctx.renderer, {
        id: `bench-autocomplete-item-${i}`,
        width: "100%",
        height: 1,
        border: false,
        shouldFill: true,
        backgroundColor: i % 2 === 0 ? COLORS.menu : COLORS.element,
      }),
    )
    autocomplete.add(item)
  }

  await ctx.renderOnce()

  const drawCallsPerIteration = allBoxes.length
  const requestedCellsPerIteration = allBoxes.reduce((sum, box) => {
    return sum + Math.max(1, box.width) * Math.max(1, box.height)
  }, 0)

  return {
    root,
    marker,
    toast,
    promptBorder: promptOuter,
    messageBodies,
    allBoxes,
    drawCallsPerIteration,
    requestedCellsPerIteration,
  }
}

function createFillPanelSpecs(width: number, height: number): DrawBoxOptions[] {
  const specs: DrawBoxOptions[] = []
  const columns = 4
  const rows = 3
  const gap = 1
  const panelWidth = Math.max(8, Math.floor((width - gap * (columns + 1)) / columns))
  const panelHeight = Math.max(3, Math.floor((height - 8 - gap * (rows + 1)) / rows))

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const index = row * columns + col
      specs.push({
        x: 1 + col * (panelWidth + gap),
        y: 1 + row * (panelHeight + gap),
        width: panelWidth,
        height: panelHeight,
        border: false,
        borderColor: COLORS.transparent,
        backgroundColor: FILL_COLORS[index % FILL_COLORS.length],
        shouldFill: true,
      })
    }
  }

  return specs
}

function createTitleVariants(width: number, height: number): DrawBoxOptions[] {
  const alignments = ["left", "center", "right"] as const
  const title = " Session "
  const bottomTitle = " Ctrl+K Commands "

  return alignments.map((alignment, index) => ({
    x: 0,
    y: 0,
    width,
    height,
    borderStyle: "single",
    border: true,
    borderColor: COLORS.borderActive,
    backgroundColor: COLORS.panel,
    shouldFill: true,
    title,
    titleAlignment: alignment,
    bottomTitle,
    bottomTitleAlignment: alignments[(index + 1) % alignments.length],
  }))
}

function createLeftBorderStackSpecs(
  width: number,
  height: number,
  borderColors: RGBA[],
  backgroundColor: RGBA,
): DrawBoxOptions[] {
  const specs: DrawBoxOptions[] = []
  const contentWidth = Math.max(20, width - 4)
  const maxY = Math.max(6, height - 8)

  let y = 1
  let idx = 0
  while (y < maxY) {
    const boxHeight = idx % 5 === 0 ? 4 : idx % 3 === 0 ? 3 : 2
    if (y + boxHeight >= maxY) break

    specs.push({
      x: 1,
      y,
      width: contentWidth,
      height: boxHeight,
      border: BORDER_LEFT,
      customBorderChars: SPLIT_BORDER_ARRAY,
      borderColor: borderColors[idx % borderColors.length],
      backgroundColor,
      shouldFill: true,
    })

    y += boxHeight + 1
    idx += 1
  }

  return specs
}

function createPromptComboSpecs(width: number, height: number): DrawBoxOptions[] {
  const promptHeight = Math.max(5, Math.min(8, Math.floor(height * 0.2)))
  const promptY = Math.max(0, height - promptHeight - 1)
  const tailY = Math.min(height - 1, promptY + promptHeight)

  return [
    {
      x: 0,
      y: promptY,
      width,
      height: promptHeight,
      border: BORDER_LEFT,
      customBorderChars: SPLIT_WITH_BOTTOM_TICK_ARRAY,
      borderColor: COLORS.accent,
      backgroundColor: COLORS.transparent,
      shouldFill: true,
    },
    {
      x: 0,
      y: tailY,
      width,
      height: 1,
      border: BORDER_LEFT,
      customBorderChars: SPLIT_WITH_BOTTOM_TICK_ARRAY,
      borderColor: COLORS.accent,
      backgroundColor: COLORS.transparent,
      shouldFill: true,
    },
    {
      x: 1,
      y: tailY,
      width: Math.max(1, width - 1),
      height: 1,
      border: BORDER_BOTTOM,
      customBorderChars: PROMPT_BOTTOM_BORDER_ARRAY,
      borderColor: COLORS.element,
      backgroundColor: COLORS.transparent,
      shouldFill: true,
    },
  ]
}

function createToastSpecs(width: number): DrawBoxOptions[] {
  const toastWidth = Math.max(24, Math.min(56, width - 4))
  const x = Math.max(1, width - toastWidth - 2)

  return TOAST_BORDER_COLORS.map((color, idx) => ({
    x,
    y: 2 + idx * 4,
    width: toastWidth,
    height: 3,
    border: BORDER_LEFT_RIGHT,
    customBorderChars: SPLIT_BORDER_ARRAY,
    borderColor: color,
    backgroundColor: COLORS.panel,
    shouldFill: true,
  }))
}

function createScrolledLeftBorderSpecs(width: number, height: number): DrawBoxOptions[] {
  const specs: DrawBoxOptions[] = []
  const contentWidth = Math.max(20, width - 10)
  const maxRows = Math.max(24, height + 16)

  for (let i = 0; i < maxRows; i += 1) {
    specs.push({
      x: 3,
      y: -8 + i * 2,
      width: contentWidth,
      height: i % 4 === 0 ? 3 : 2,
      border: BORDER_LEFT,
      customBorderChars: SPLIT_BORDER_ARRAY,
      borderColor: MESSAGE_BORDER_COLORS[i % MESSAGE_BORDER_COLORS.length],
      backgroundColor: COLORS.transparent,
      shouldFill: true,
    })
  }

  return specs
}

function clearRoot(renderer: TestRenderer): void {
  for (const child of renderer.root.getChildren()) {
    child.destroyRecursively()
  }
}

function resetBuffers(renderer: TestRenderer): void {
  const buffers = [renderer.currentRenderBuffer, renderer.nextRenderBuffer]
  for (const buffer of buffers) {
    buffer.clearScissorRects()
    buffer.clearOpacity()
    buffer.clear(COLORS.transparent)
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

function sumRequestedCells(specs: DrawBoxOptions[]): number {
  return specs.reduce((sum, spec) => sum + spec.width * spec.height, 0)
}

function formatTableRow(result: ScenarioResult): Record<string, string | number> {
  return {
    scenario: result.name,
    kind: result.kind,
    draws: result.drawCallsPerIteration,
    cells: result.requestedCellsPerIteration,
    avgMs: result.avgMs,
    p95Ms: result.p95Ms,
    usPerDraw: result.avgUsPerDrawCall,
    nsPerCell: result.approxNsPerRequestedCell,
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
