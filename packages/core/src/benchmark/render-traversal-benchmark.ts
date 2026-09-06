#!/usr/bin/env bun
import { getYogaNode } from "../lib/renderable-layout.js"

// This benchmark targets render/layout bookkeeping in wrapper-heavy trees,
// scrollbox culling, scrollbar-heavy paths, and dense framebuffer output.

import { performance } from "node:perf_hooks"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Command } from "commander"
import {
  BoxRenderable,
  FrameBufferRenderable,
  Renderable,
  RGBA,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  TextRenderable,
} from "../index.js"
import { CliRenderEvents, type CliRendererErrorEvent } from "../renderer.js"
import { createTestRenderer, ManualClock, type TestRenderer } from "../testing.js"
import { sceneGoldens } from "./render-traversal-goldens.js"

type ScenarioRuntime = {
  renderablesPerIteration: number
  layoutOnlyBoxesPerIteration: number
  nodes?: Renderable[]
  log?: { scrollBox: ScrollBoxRenderable; append: () => void; nodeLimit: number }
  grayscale?: { panelWidth: number; panelHeight: number }
  runIteration: (iteration: number) => Promise<void>
  teardown?: () => void | Promise<void>
}

type ScenarioDefinition = {
  name: string
  description: string
  scene?: "steady" | "changed" | "log-unchanged" | "log-append" | "log-scroll" | "grayscale"
  setup: (ctx: BenchmarkContext) => Promise<ScenarioRuntime> | ScenarioRuntime
}

type BenchmarkContext = {
  renderer: TestRenderer
  renderOnce: () => Promise<void>
  width: number
  height: number
}

export type ScenarioResult = {
  name: string
  description: string
  iterations: number
  warmupIterations: number
  elapsedMs: number
  renderablesPerIteration: number
  layoutOnlyBoxesPerIteration: number
  avgMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
  stdDevMs: number
  rsdPercent: number
  rmePercent: number
  approxUsPerRenderable: number
  scene?: TimingStats
  nativeRender?: TimingStats
  sceneNodes?: SceneNodeCounts
}

// Counts include the renderer root and internal ScrollBox/scrollbar nodes.
export type SceneNodeCounts = { initial: number; timedMin: number; timedMax: number; limit: number }

export type ParityEvidence = {
  terminal: { remote: true; widthMethod: "unicode"; rgb: false; ansi256: false }
  workload:
    | {
        boxes: number
        filledBoxes: number
        width: number
        height: number
        useMouse: boolean
        mutation: "none" | "backgroundColor"
      }
    | {
        initialTextEntries: number
        maxTextEntries: number
        width: number
        height: number
        useMouse: boolean
        mutation: "none" | "append" | "scroll"
        wrapMode: "word"
        selectable: false
        showArrows: false
      }
    | {
        frameBuffers: 1
        panelWidth: number
        panelHeight: number
        sampleScales: [1, 2]
        width: number
        height: number
        useMouse: boolean
        mutation: "grayscale"
      }
  golden: boolean
  digestKind: "sha256-cell-planes-geometry-hits" | "sha256-resolved-cell-bytes-planes-geometry-hits"
  frames: { step?: string; digest: string; cellsUpdated: number }[]
}

export type TimingStats = {
  avgMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
  stdDevMs: number
  rsdPercent: number
  rmePercent: number
}

type TreeStats = {
  renderables: number
  layoutOnlyBoxes: number
}

type LayoutTreeOptions = {
  messageCount: number
  includeVisibleBoxes: boolean
  includeText: boolean
}

type LayoutTreeState = {
  root: BoxRenderable
  stats: TreeStats
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
  menu: RGBA.fromInts(35, 40, 48),
  accent: RGBA.fromInts(84, 171, 224),
  warning: RGBA.fromInts(219, 186, 96),
} as const

const BOX_COUNT = 10_000
const FILLED_BOX_COUNT = 100
const LOG_COUNT = 10_000
// Allow at most one more initial log's worth of entries, including warmup appends.
const LOG_APPEND_LIMIT = LOG_COUNT
const LOG_MESSAGES = [
  "INFO request completed: loaded project files and refreshed the conversation. " +
    "The next response is ready for review, with diagnostics collected from the local terminal session.",
  "WARN reconnecting worker after a timeout; queued messages remain available. " +
    "Waiting for the next local retry before marking this conversation as ready for new input.",
  "CHAT user: please summarize the changes and explain which checks still need to run. " +
    "Keep the earlier messages visible while the assistant appends another update to the conversation.",
  "CHAT assistant: the parser found the requested symbols and is checking their callers. " +
    "This message wraps across terminal rows instead of using a fixed one-line placeholder.",
] as const

let benchmarkChecksum = 0

const program = new Command()
program
  .name("render-traversal-benchmark")
  .description("Benchmark render-tree traversal with headless test renderer")
  .option("-s, --suite <name>", "benchmark suite: quick, default, long", "default")
  .option("-i, --iterations <count>", "iterations per scenario")
  .option("--warmup-iterations <count>", "warmup iterations per scenario")
  .option("--width <count>", "test renderer width", "140")
  .option("--height <count>", "test renderer height", "44")
  .option("--scenario <name>", "run only one scenario")
  .option("--list-scenarios", "list scenario names and exit")
  .option("--verify-only", "verify retained scene workloads without timing")
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
      ? path.resolve(process.cwd(), "latest-render-traversal-bench-run.json")
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

const scenarios = createScenarios().filter((scenario) => !options.verifyOnly || scenario.scene)

if (options.listScenarios) {
  for (const scenario of scenarios) {
    console.log(scenario.name)
  }
  process.exit(0)
}

const selectedScenarios = scenarioFilter ? scenarios.filter((scenario) => scenario.name === scenarioFilter) : scenarios
if (selectedScenarios.length === 0) {
  console.error(`Unknown or incompatible scenario: ${scenarioFilter}`)
  process.exit(1)
}
if (
  !options.verifyOnly &&
  selectedScenarios.some((scenario) => scenario.scene === "log-append") &&
  iterations + warmupIterations > LOG_APPEND_LIMIT
) {
  throw new Error(`log append is bounded to ${LOG_APPEND_LIMIT} iterations including warmup per run`)
}

if (outputEnabled) {
  console.log(`render traversal benchmark (${suiteName})`)
  console.log(`- renderer: ${width}x${height}`)
  console.log(`- scenarios: ${selectedScenarios.length}`)
  console.log(`- iterations: ${iterations} (+${warmupIterations} warmup)`)
}

const parity: Record<string, ParityEvidence> = {}
for (const scenario of selectedScenarios) {
  if (scenario.scene) {
    writeLine(outputEnabled, `Verifying ${scenario.name}...`)
    parity[scenario.name] = await verifyScene(scenario)
  }
}
const results: ScenarioResult[] = []

if (!options.verifyOnly) {
  for (const scenario of selectedScenarios) {
    writeLine(outputEnabled, `Running ${scenario.name}...`)
    const ctx = await createBenchmarkContext(Boolean(scenario.scene))
    try {
      const result = await runScenario(scenario, ctx, iterations, warmupIterations)
      results.push(result)
      writeLine(
        outputEnabled,
        `  avg=${result.avgMs.toFixed(4)}ms p95=${result.p95Ms.toFixed(4)}ms rsd=${result.rsdPercent.toFixed(2)}% rme=${result.rmePercent.toFixed(2)}%` +
          (result.scene ? ` scene=${result.scene.avgMs.toFixed(4)}ms` : "") +
          (result.nativeRender ? ` nativeRender=${result.nativeRender.avgMs.toFixed(4)}ms` : ""),
      )
    } finally {
      ctx.renderer.destroy()
      await ctx.renderer.closed
    }
  }
}

if (outputEnabled) {
  console.table(
    results.map((result) => ({
      scenario: result.name,
      renderables: result.renderablesPerIteration,
      sceneNodes: result.sceneNodes ? `${result.sceneNodes.timedMin}-${result.sceneNodes.timedMax}` : undefined,
      layoutOnlyBoxes: result.layoutOnlyBoxesPerIteration,
      avgMs: result.avgMs,
      sceneAvgMs: result.scene?.avgMs,
      nativeRenderAvgMs: result.nativeRender?.avgMs,
      p95Ms: result.p95Ms,
      "rsd%": result.rsdPercent,
      "rme%": result.rmePercent,
      usPerRenderable: result.approxUsPerRenderable,
    })),
  )
}

if (jsonPath) {
  await writeFile(
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
          sink: "memory",
          parity,
          timestamp: new Date().toISOString(),
          runtime: {
            name: typeof process.versions.bun === "string" ? "bun" : "node",
            version: process.versions.bun ?? process.version,
            platform: process.platform,
            arch: process.arch,
          },
          checksum: benchmarkChecksum,
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
    createBoxSceneScenario("steady"),
    createBoxSceneScenario("changed"),
    createLogSceneScenario("unchanged"),
    createLogSceneScenario("append"),
    createLogSceneScenario("scroll"),
    createGrayscaleSceneScenario(),
    createYogaLayoutReadScenario(100),
    createYogaLayoutReadScenario(1000),
    createYogaLayoutReadScenario(10000),
    {
      name: "layout_only_opencode_wrappers",
      description: "OpenCode-like nested layout boxes with no visible box output",
      setup: async (ctx) => {
        const state = await buildOpencodeLayoutTree(ctx, {
          messageCount: Math.max(48, ctx.height + 12),
          includeVisibleBoxes: false,
          includeText: false,
        })

        return {
          renderablesPerIteration: state.stats.renderables,
          layoutOnlyBoxesPerIteration: state.stats.layoutOnlyBoxes,
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
      name: "mixed_opencode_wrappers",
      description: "OpenCode-like layout tree with sparse visible panels and text leaves",
      setup: async (ctx) => {
        const state = await buildOpencodeLayoutTree(ctx, {
          messageCount: Math.max(40, ctx.height + 8),
          includeVisibleBoxes: true,
          includeText: true,
        })

        return {
          renderablesPerIteration: state.stats.renderables,
          layoutOnlyBoxesPerIteration: state.stats.layoutOnlyBoxes,
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
      name: "scrollbox_viewport_culling",
      description: "Viewport-culling content tree with many hidden children",
      setup: async (ctx) => {
        clearRoot(ctx.renderer)

        let renderables = 0
        let layoutOnlyBoxes = 0
        const root = new BoxRenderable(ctx.renderer, {
          id: "bench-scroll-root",
          width: "100%",
          height: "100%",
          border: false,
          backgroundColor: COLORS.transparent,
        })
        renderables += 1
        layoutOnlyBoxes += 1
        ctx.renderer.root.add(root)

        const scrollBox = new ScrollBoxRenderable(ctx.renderer, {
          id: "bench-scrollbox",
          width: "100%",
          height: "100%",
          stickyScroll: true,
          stickyStart: "bottom",
          viewportCulling: true,
        })
        renderables += 1
        layoutOnlyBoxes += 1
        root.add(scrollBox)

        const itemCount = Math.max(120, ctx.height * 8)
        for (let i = 0; i < itemCount; i += 1) {
          const item = new BoxRenderable(ctx.renderer, {
            id: `bench-scroll-item-${i}`,
            width: "100%",
            height: i % 3 === 0 ? 3 : 2,
            border: false,
            backgroundColor: COLORS.transparent,
            paddingLeft: 2,
            paddingRight: 1,
            flexDirection: "column",
          })
          renderables += 1
          layoutOnlyBoxes += 1

          const leaf = new BoxRenderable(ctx.renderer, {
            id: `bench-scroll-leaf-${i}`,
            width: "100%",
            height: 1,
            border: false,
            backgroundColor: i % 2 === 0 ? COLORS.panel : COLORS.element,
          })
          renderables += 1

          item.add(leaf)
          scrollBox.add(item)
        }

        await ctx.renderOnce()

        return {
          renderablesPerIteration: renderables,
          layoutOnlyBoxesPerIteration: layoutOnlyBoxes,
          runIteration: async () => {
            await ctx.renderOnce()
          },
          teardown: () => {
            root.destroyRecursively()
          },
        }
      },
    },
    createCullingScalingScenario(100),
    createCullingScalingScenario(1000),
    createCullingScalingScenario(5000),
    createCullingScalingScenario(10000),
    {
      name: "scrollbar_stack",
      description: "Visible scrollbars and slider tracks with arrows",
      setup: async (ctx) => {
        clearRoot(ctx.renderer)

        let renderables = 0
        let layoutOnlyBoxes = 0

        const root = new BoxRenderable(ctx.renderer, {
          id: "bench-scrollbar-root",
          width: "100%",
          height: "100%",
          border: false,
          backgroundColor: COLORS.transparent,
          flexDirection: "column",
          gap: 1,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
        })
        renderables += 1
        layoutOnlyBoxes += 1
        ctx.renderer.root.add(root)

        const verticalRow = new BoxRenderable(ctx.renderer, {
          id: "bench-scrollbar-vertical-row",
          width: "100%",
          height: 14,
          border: false,
          backgroundColor: COLORS.transparent,
          flexDirection: "row",
          gap: 1,
        })
        renderables += 1
        layoutOnlyBoxes += 1
        root.add(verticalRow)

        for (let i = 0; i < 10; i += 1) {
          const bar = new ScrollBarRenderable(ctx.renderer, {
            id: `bench-vertical-scrollbar-${i}`,
            orientation: "vertical",
            showArrows: true,
            width: 2,
            height: 14,
            trackOptions: {
              backgroundColor: COLORS.panel,
              foregroundColor: COLORS.accent,
            },
            arrowOptions: {
              backgroundColor: COLORS.panel,
              foregroundColor: COLORS.warning,
            },
          })
          bar.scrollSize = 400 + i * 30
          bar.viewportSize = 24 + (i % 3)
          bar.scrollPosition = 10 + i * 7
          renderables += 4
          verticalRow.add(bar)
        }

        const horizontalColumn = new BoxRenderable(ctx.renderer, {
          id: "bench-scrollbar-horizontal-column",
          width: "100%",
          flexGrow: 1,
          border: false,
          backgroundColor: COLORS.transparent,
          flexDirection: "column",
          gap: 1,
        })
        renderables += 1
        layoutOnlyBoxes += 1
        root.add(horizontalColumn)

        for (let i = 0; i < 8; i += 1) {
          const bar = new ScrollBarRenderable(ctx.renderer, {
            id: `bench-horizontal-scrollbar-${i}`,
            orientation: "horizontal",
            showArrows: true,
            width: 28,
            height: 1,
            trackOptions: {
              backgroundColor: COLORS.element,
              foregroundColor: COLORS.accent,
            },
            arrowOptions: {
              backgroundColor: COLORS.element,
              foregroundColor: COLORS.warning,
            },
          })
          bar.scrollSize = 520 + i * 50
          bar.viewportSize = 32 + (i % 4)
          bar.scrollPosition = 15 + i * 11
          renderables += 4
          horizontalColumn.add(bar)
        }

        await ctx.renderOnce()

        return {
          renderablesPerIteration: renderables,
          layoutOnlyBoxesPerIteration: layoutOnlyBoxes,
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

async function createBenchmarkContext(scene: boolean, clock?: ManualClock): Promise<BenchmarkContext> {
  const { renderer, renderOnce } = await createTestRenderer({
    width,
    height,
    targetFps: 60,
    maxFps: 60,
    screenMode: "main-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
    bufferedOutput: "memory",
    ...(scene ? { remote: true, forwardEnvKeys: [] } : {}),
    useMouse: scene,
    clock,
  })
  try {
    if (scene) {
      const capabilities = renderer.capabilities
      assert.ok(capabilities)
      assert.equal(renderer.widthMethod, "unicode", "scene benchmark width policy must be host-independent")
      assert.equal(capabilities.remote, true)
      assert.equal(capabilities.rgb, false)
      assert.equal(capabilities.ansi256, false)
      assert.equal(capabilities.unicode, "unicode")
      assert.equal(renderer.currentRenderBuffer.widthMethod, "unicode")
      assert.equal(renderer.nextRenderBuffer.widthMethod, "unicode")
      assert.equal(capabilities.terminal.name, "")
      assert.equal(capabilities.terminal.version, "")
      assert.equal(capabilities.explicit_width, false)
      assert.equal(capabilities.explicit_cursor_positioning, false)
      assert.equal(capabilities.hyperlinks, false)
    }
    return { renderer, renderOnce, width, height }
  } catch (error) {
    renderer.destroy()
    await renderer.closed
    throw error
  }
}

function createBoxSceneScenario(mode: "steady" | "changed"): ScenarioDefinition {
  return {
    name: `boxes_${mode}_${BOX_COUNT}`,
    description: `${BOX_COUNT} ordinary boxes, ${FILLED_BOX_COUNT} visible fills, ${mode} completed frames`,
    scene: mode,
    setup: (ctx) => {
      const boxes = Array.from({ length: BOX_COUNT }, (_, index) => {
        const box = new BoxRenderable(ctx.renderer, {
          id: `bench-box-${index}`,
          position: "absolute",
          left: index % ctx.width,
          top: Math.floor(index / ctx.width),
          width: 1,
          height: 1,
          border: false,
          backgroundColor:
            index < FILLED_BOX_COUNT ? (index % 2 === 0 ? COLORS.panel : COLORS.element) : COLORS.transparent,
        })
        ctx.renderer.root.add(box)
        return box
      })
      return {
        nodes: [ctx.renderer.root, ...boxes],
        renderablesPerIteration: boxes.length,
        layoutOnlyBoxesPerIteration: boxes.length - FILLED_BOX_COUNT,
        runIteration: async (iteration) => {
          if (mode === "changed") boxes[0].backgroundColor = iteration % 2 === 0 ? COLORS.accent : COLORS.panel
          await ctx.renderOnce()
        },
      }
    },
  }
}

function createGrayscaleSceneScenario(): ScenarioDefinition {
  return {
    name: "grayscale_changed",
    description: "Dense changing standard and 2x supersampled grayscale FrameBufferRenderable, completed frames",
    scene: "grayscale",
    setup: (ctx) => {
      const node = new FrameBufferRenderable(ctx.renderer, {
        id: "bench-grayscale",
        width: ctx.width,
        height: ctx.height,
      })
      ctx.renderer.root.add(node)
      const panelWidth = Math.floor(ctx.width / 2)
      const panelHeight = ctx.height
      const background = RGBA.fromInts(0, 0, 0)
      // Precompute two phases so pattern generation does not hide renderer/feed costs.
      const fixtures = [0, 1].map((phase) =>
        [1, 2].map((scale) => {
          const samples = new Float32Array(panelWidth * panelHeight * scale * scale)
          for (let y = 0; y < panelHeight * scale; y++) {
            for (let x = 0; x < panelWidth * scale; x++) {
              const intensity = (Math.floor(x / scale) * 17 + Math.floor(y / scale) * 29 + phase * 97) % 192
              samples[y * panelWidth * scale + x] = (32 + intensity + (x % scale) * 4 + (y % scale) * 8) / 256
            }
          }
          return samples
        }),
      )
      const paint = (phase: number) => {
        node.frameBuffer.clear(background)
        node.frameBuffer.drawGrayscaleBuffer(0, 0, fixtures[phase][0], panelWidth, panelHeight)
        node.frameBuffer.drawGrayscaleBufferSupersampled(
          panelWidth,
          0,
          fixtures[phase][1],
          panelWidth * 2,
          panelHeight * 2,
        )
      }
      paint(0)
      return {
        nodes: [ctx.renderer.root, node],
        grayscale: { panelWidth, panelHeight },
        renderablesPerIteration: 1,
        layoutOnlyBoxesPerIteration: 0,
        runIteration: async (iteration) => {
          paint((iteration + 1) % 2)
          await ctx.renderOnce()
        },
        teardown: () => node.destroyRecursively(),
      }
    },
  }
}

function createLogSceneScenario(mode: "unchanged" | "append" | "scroll"): ScenarioDefinition {
  return {
    name: `log_${mode}_${LOG_COUNT}`,
    description:
      `ScrollBox with ${LOG_COUNT} initial wrapped, colored Unicode TextRenderables, ${mode} completed frames` +
      (mode === "append" ? `, at most ${LOG_APPEND_LIMIT} new entries per run including warmup` : ""),
    scene: `log-${mode}`,
    setup: async (ctx) => {
      const scrollBox = new ScrollBoxRenderable(ctx.renderer, {
        id: "bench-log",
        width: "100%",
        height: "100%",
        stickyScroll: true,
        stickyStart: "bottom",
        viewportCulling: true,
        scrollbarOptions: { showArrows: false },
      })
      ctx.renderer.root.add(scrollBox)

      const nodes: Renderable[] = [ctx.renderer.root]
      for (const node of nodes) {
        // ScrollBox.getChildren() delegates to content, hiding the internal tree.
        nodes.push(
          ...(node instanceof ScrollBoxRenderable ? [node.wrapper, node.verticalScrollBar] : node.getChildren()),
        )
      }
      const internalNodeCount = nodes.length
      const append = () => {
        const index = nodes.length - internalNodeCount
        assert.ok(index < LOG_COUNT + LOG_APPEND_LIMIT, "log entry limit exceeded")
        const entry = new TextRenderable(ctx.renderer, {
          id: `bench-log-entry-${index}`,
          content:
            `log ${String(index).padStart(5, "0")} \u4e16\u754c e\u0301 \ud83d\udc69\u200d\ud83d\udcbb ` +
            LOG_MESSAGES[index % LOG_MESSAGES.length],
          width: "100%",
          flexShrink: 0,
          wrapMode: "word",
          selectable: false,
          fg: index % 3 === 0 ? COLORS.warning : COLORS.accent,
          bg: index % 2 === 0 ? COLORS.panel : COLORS.element,
        })
        try {
          scrollBox.add(entry)
        } catch (error) {
          entry.destroy()
          throw error
        }
        nodes.push(entry)
      }
      for (let index = 0; index < LOG_COUNT; index++) append()

      // Scrollbar visibility can request one follow-up layout before the workload starts.
      await ctx.renderOnce()
      await ctx.renderOnce()
      assert.ok(scrollBox.scrollHeight > scrollBox.viewport.height, "log must overflow the viewport")
      assert.equal(scrollBox.scrollTop, scrollBox.scrollHeight - scrollBox.viewport.height, "log setup lost bottom")
      if (mode === "scroll") {
        scrollBox.scrollTo(Math.floor(scrollBox.scrollHeight / 2))
        await ctx.renderOnce()
      }

      return {
        nodes,
        log: { scrollBox, append, nodeLimit: internalNodeCount + LOG_COUNT + LOG_APPEND_LIMIT },
        get renderablesPerIteration() {
          return nodes.length - 1
        },
        layoutOnlyBoxesPerIteration: nodes.filter((node) => node instanceof BoxRenderable).length,
        runIteration: async (iteration) => {
          if (mode === "append") append()
          if (mode === "scroll") scrollBox.scrollBy(iteration % 2 === 0 ? 1 : -1)
          await ctx.renderOnce()
        },
        teardown: () => scrollBox.destroyRecursively(),
      }
    },
  }
}

async function verifyScene(scenario: ScenarioDefinition): Promise<ParityEvidence> {
  const frames: ParityEvidence["frames"] = []
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const golden = sceneGoldens[`${scenario.name}/${width}x${height}`]
  const ctx = await createBenchmarkContext(true, new ManualClock())
  try {
    const renderOnce = ctx.renderOnce
    ctx.renderOnce = async () => {
      const before = ctx.renderer.getNativeStats().nativeFrameCount
      let completed = 0
      const errors: Error[] = []
      const onFrame = () => completed++
      const onError = ({ error }: CliRendererErrorEvent) => errors.push(error)
      ctx.renderer.on(CliRenderEvents.FRAME, onFrame)
      ctx.renderer.on(CliRenderEvents.RENDER_ERROR, onError)
      try {
        await renderOnce()
        assert.deepEqual(errors, [], `${scenario.name}: render errors`)
        assert.equal(completed, 1, `${scenario.name}: frame event did not complete exactly once`)
        assert.equal(ctx.renderer.getNativeStats().nativeFrameCount, before + 1)
      } finally {
        ctx.renderer.off(CliRenderEvents.FRAME, onFrame)
        ctx.renderer.off(CliRenderEvents.RENDER_ERROR, onError)
      }
    }
    const runtime = await scenario.setup(ctx)
    const isLog = Boolean(runtime.log)
    const grayscale = runtime.grayscale
    if (!isLog) assert.equal(runtime.nodes?.length, grayscale ? 2 : BOX_COUNT + 1)
    if (runtime.log) {
      assert.equal(
        runtime.layoutOnlyBoxesPerIteration,
        4,
        "log layout-only box count must include every internal box, but not the renderer root",
      )
    }
    const iterationSteps = ["iteration-0", "iteration-1", "iteration-2", "iteration-3"]
    const steps = isLog
      ? [
          "prepared",
          ...iterationSteps,
          "unchanged",
          ...(scenario.scene === "log-scroll" ? ["bottom"] : []),
          "append-bottom",
          "read-older",
          "append-older",
          "scroll",
          "scroll-restore",
          "resize",
          "cleanup",
        ]
      : ["initial", "unchanged", "mutation", "restore"]

    for (const [frame, step] of steps.entries()) {
      const before = ctx.renderer.getNativeStats().nativeFrameCount
      if (runtime.log) {
        const { scrollBox, append } = runtime.log
        const scrollTop = scrollBox.scrollTop
        const entryCount = scrollBox.getChildren().length
        const iteration = iterationSteps.indexOf(step)
        if (step === "append-bottom" || step === "append-older") append()
        if (step === "read-older") scrollBox.scrollTo(Math.floor(scrollBox.scrollHeight / 2))
        if (step === "bottom") scrollBox.scrollTo(scrollBox.scrollHeight)
        if (step === "scroll") scrollBox.scrollBy(-1)
        if (step === "scroll-restore") scrollBox.scrollBy(1)
        if (step === "resize") ctx.renderer.resize(width - 13, height - 3)
        if (step === "cleanup") {
          clearRoot(ctx.renderer)
          for (const node of runtime.nodes!.splice(1)) {
            assert.ok(node.isDestroyed, "log cleanup left a live node")
          }
          assert.equal(ctx.renderer.root.getChildrenCount(), 0)
        }
        if (iteration >= 0) await runtime.runIteration(iteration)
        else if (step !== "prepared") await ctx.renderOnce()
        if (
          (step === "prepared" && scenario.scene !== "log-scroll") ||
          step === "bottom" ||
          step === "append-bottom" ||
          (iteration >= 0 && scenario.scene === "log-append")
        ) {
          assert.ok(scrollBox.scrollHeight > scrollBox.viewport.height, "log must overflow the viewport")
          assert.equal(scrollBox.scrollTop, scrollBox.scrollHeight - scrollBox.viewport.height, "log lost bottom")
          const last = runtime.nodes!.at(-1)!
          assert.equal(last.y + last.height, scrollBox.viewport.y + scrollBox.viewport.height)
        }
        if (step === "prepared") assert.equal(scrollBox.getChildren().length, LOG_COUNT)
        if (iteration >= 0) {
          assert.equal(entryCount, LOG_COUNT + (scenario.scene === "log-append" ? iteration : 0))
          assert.equal(scrollBox.getChildren().length, entryCount + (scenario.scene === "log-append" ? 1 : 0))
          if (scenario.scene === "log-scroll") {
            assert.equal(
              scrollBox.scrollTop,
              scrollTop + (iteration % 2 === 0 ? 1 : -1),
              `${scenario.name}/${step}: each workload iteration must scroll exactly one row`,
            )
          } else if (scenario.scene === "log-append") {
            assert.ok(scrollBox.scrollTop > scrollTop, "workload append must move the viewport")
          } else assert.equal(scrollBox.scrollTop, scrollTop)
        }
        if (step === "append-bottom" || step === "append-older") {
          assert.equal(scrollBox.getChildren().length, entryCount + 1)
        }
        if (step === "append-bottom") assert.ok(scrollBox.scrollTop > scrollTop, "append must move the viewport")
        if ((step === "prepared" && scenario.scene === "log-scroll") || step === "read-older") {
          assert.equal(scrollBox.scrollTop, Math.floor(scrollBox.scrollHeight / 2))
          assert.ok(scrollBox.scrollTop > 0 && scrollBox.scrollTop < scrollBox.scrollHeight - scrollBox.viewport.height)
        }
        if (step === "append-older") {
          assert.equal(scrollBox.scrollTop, scrollTop, "append moved the reader away from older entries")
        }
        if (step === "scroll") assert.equal(scrollBox.scrollTop, scrollTop - 1)
        if (step === "scroll-restore") assert.equal(scrollBox.scrollTop, scrollTop + 1)
        if (step !== "cleanup") assert.equal(scrollBox.content.translateY + scrollBox.scrollTop, 0)
        if (step === "resize") {
          assert.equal(ctx.renderer.width, width - 13)
          assert.equal(ctx.renderer.height, height - 3)
        }
      } else if (frame < 2) await ctx.renderOnce()
      else await runtime.runIteration(frame - 2)
      const stats = ctx.renderer.getNativeStats()
      assert.equal(
        stats.nativeFrameCount,
        before + (step === "prepared" ? 0 : 1),
        `${scenario.name}/${step}: preflight frame did not complete`,
      )
      const digest = createHash("sha256")
        .update(JSON.stringify(snapshotScene(ctx, runtime)))
        .digest("hex")
      if (golden) {
        assert.deepEqual([digest, stats.cellsUpdated], golden[frame], `${scenario.name}/${step}: golden mismatch`)
      }
      frames.push({
        ...(isLog ? { step } : {}),
        digest,
        cellsUpdated: stats.cellsUpdated,
      })
    }
    if (golden) assert.equal(frames.length, golden.length, "preflight omitted golden frames")
    const unchangedFrame = steps.indexOf("unchanged")
    assert.equal(frames[unchangedFrame - 1].digest, frames[unchangedFrame].digest)
    assert.equal(frames[unchangedFrame].cellsUpdated, 0)
    if (isLog) {
      const origin = frames[0]
      for (const [iteration, step] of iterationSteps.entries()) {
        const frame = frames[steps.indexOf(step)]
        if (scenario.scene === "log-unchanged") {
          assert.equal(frame.digest, origin.digest)
          assert.equal(frame.cellsUpdated, 0)
        } else {
          assert.ok(frame.cellsUpdated > 0, `${step} must change output`)
          if (scenario.scene === "log-scroll") {
            if (iteration % 2 === 0) assert.notEqual(frame.digest, origin.digest)
            else assert.equal(frame.digest, origin.digest, `${step} did not restore the original midpoint output`)
          }
        }
      }
      for (const step of ["append-bottom", "read-older", "scroll", "scroll-restore"]) {
        assert.ok(frames[steps.indexOf(step)].cellsUpdated > 0, `${step} must change output`)
      }
      assert.equal(frames[steps.indexOf("scroll-restore")].digest, frames[steps.indexOf("append-older")].digest)
    } else if (scenario.scene === "changed" || grayscale) {
      assert.equal(frames[0].digest, frames[3].digest)
      assert.notEqual(frames[0].digest, frames[2].digest, "the paint mutation must change output")
      const changedCells = grayscale ? grayscale.panelWidth * grayscale.panelHeight * 2 : 1
      assert.equal(frames[2].cellsUpdated, changedCells)
      assert.equal(frames[3].cellsUpdated, changedCells)
    } else {
      assert.equal(frames[0].digest, frames[3].digest)
      assert.equal(frames[0].digest, frames[2].digest)
      assert.equal(frames[2].cellsUpdated, 0)
      assert.equal(frames[3].cellsUpdated, 0)
    }
    return {
      terminal: { remote: true, widthMethod: "unicode", rgb: false, ansi256: false },
      workload: isLog
        ? {
            initialTextEntries: LOG_COUNT,
            maxTextEntries: LOG_COUNT + LOG_APPEND_LIMIT,
            width,
            height,
            useMouse: true,
            mutation: scenario.scene === "log-append" ? "append" : scenario.scene === "log-scroll" ? "scroll" : "none",
            wrapMode: "word",
            selectable: false,
            showArrows: false,
          }
        : grayscale
          ? {
              frameBuffers: 1,
              ...grayscale,
              sampleScales: [1, 2],
              width,
              height,
              useMouse: true,
              mutation: "grayscale",
            }
          : {
              boxes: BOX_COUNT,
              filledBoxes: FILLED_BOX_COUNT,
              width,
              height,
              useMouse: true,
              mutation: scenario.scene === "changed" ? "backgroundColor" : "none",
            },
      golden: Boolean(golden),
      digestKind: isLog ? "sha256-resolved-cell-bytes-planes-geometry-hits" : "sha256-cell-planes-geometry-hits",
      frames,
    }
  } finally {
    ctx.renderer.destroy()
    await ctx.renderer.closed
    assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), registered, "scene preflight leaked renderables")
  }
}

function snapshotScene(ctx: BenchmarkContext, runtime: ScenarioRuntime) {
  const nodes = runtime.nodes!
  const buffer = ctx.renderer.currentRenderBuffer
  let text: string | undefined
  const cells = runtime.log
    ? buffer["withResolvedChars"]({ addLineBreaks: false, cellLengths: true }, (bytes, cells, lengths) => {
        assert.ok(lengths)
        assert.equal(lengths.length, cells.width * cells.height)
        assert.equal(
          lengths.reduce((total, length) => total + length, 0),
          bytes.length,
        )
        text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
        return {
          width: cells.width,
          height: cells.height,
          bytes,
          lengths,
          continuations: Array.from(cells.char, (char) => char >>> 30 === 3),
          fg: cells.fg.slice(),
          bg: cells.bg.slice(),
          attributes: cells.attributes.slice(),
        }
      })
    : buffer.withBuffers((cells) => ({
        width: cells.width,
        height: cells.height,
        char: cells.char.slice(),
        fg: cells.fg.slice(),
        bg: cells.bg.slice(),
        attributes: cells.attributes.slice(),
      }))
  assert.equal(cells.width, ctx.renderer.width)
  assert.equal(cells.height, ctx.renderer.height)
  if (!runtime.log && !runtime.grayscale) {
    assert.ok(
      RGBA.fromArray(cells.bg.subarray(0, 4)).equals((nodes[1] as BoxRenderable).backgroundColor),
      "fill is missing",
    )
  }
  const numbers = new Map(nodes.map((node, index) => [node.num, index]))
  const hits = Array.from({ length: cells.width * cells.height }, (_, index) => {
    const hit = ctx.renderer.hitTest(index % cells.width, Math.floor(index / cells.width))
    assert.ok(hit === 0 || numbers.has(hit), "hit grid references an unknown node")
    return numbers.get(hit) ?? -1
  })
  if (!runtime.log) assert.equal(hits[0], 1, "the first visible node must be hittable")
  if (runtime.grayscale) {
    const { panelWidth, panelHeight } = runtime.grayscale
    for (const left of [0, panelWidth]) {
      const shades = new Set<number>()
      for (let y = 0; y < panelHeight; y++) {
        for (let x = left; x < left + panelWidth; x++) shades.add(cells.fg[(y * cells.width + x) * 4])
      }
      assert.ok(shades.size >= 16, "each grayscale panel must contain many foreground colors")
    }
  }
  if (runtime.log) {
    if (nodes.length > 1) {
      assert.match(text!, /log \d{5}/, "visible log text is missing")
      assert.ok(text!.includes("\u4e16\u754c"), "visible Unicode text is missing")
      assert.ok(
        hits.some((hit) => nodes[hit] instanceof TextRenderable),
        "visible log text is not hittable",
      )
    } else {
      assert.equal(text!.trim(), "", "cleanup left visible text")
      assert.ok(
        hits.every((hit) => hit === -1 || hit === 0),
        "cleanup left stale hits",
      )
    }
  }
  return {
    ...cells,
    geometry: nodes.map((node) => [node.x, node.y, node.width, node.height]),
    hits,
  }
}

function createYogaLayoutReadScenario(nodeCount: number): ScenarioDefinition {
  return {
    name: `yoga_layout_reads_${nodeCount}`,
    description: `Read ${nodeCount} computed Yoga layouts through the production FFI path`,
    setup: async (ctx) => {
      clearRoot(ctx.renderer)

      const root = new BoxRenderable(ctx.renderer, {
        id: `bench-yoga-layout-root-${nodeCount}`,
        width: "100%",
        flexDirection: "column",
      })
      ctx.renderer.root.add(root)

      const nodes = Array.from({ length: nodeCount }, (_, index) => {
        const node = new BoxRenderable(ctx.renderer, {
          id: `bench-yoga-layout-node-${nodeCount}-${index}`,
          width: "100%",
          height: 1,
          flexShrink: 0,
        })
        root.add(node)
        return getYogaNode(node)
      })

      await ctx.renderOnce()

      return {
        renderablesPerIteration: nodeCount,
        layoutOnlyBoxesPerIteration: nodeCount,
        runIteration: async () => {
          let checksum = 0
          for (let index = 0; index < nodes.length; index++) {
            const layout = nodes[index]!.getComputedLayout()
            checksum += layout.left + layout.top + layout.width + layout.height + index
          }
          benchmarkChecksum = (benchmarkChecksum + checksum) >>> 0
        },
        teardown: () => root.destroyRecursively(),
      }
    },
  }
}

// Measure frame-time scaling with total children while the visible count stays constant.
function createCullingScalingScenario(childCount: number): ScenarioDefinition {
  return {
    name: `scrollbox_culling_scaling_${childCount}`,
    description: `Scrolling viewport-culled scrollbox with ${childCount} rows, constant visible count`,
    setup: async (ctx) => {
      clearRoot(ctx.renderer)

      let renderables = 0
      let layoutOnlyBoxes = 0

      const root = new BoxRenderable(ctx.renderer, {
        id: `bench-culling-scaling-root-${childCount}`,
        width: "100%",
        height: "100%",
        border: false,
        backgroundColor: COLORS.transparent,
      })
      renderables += 1
      layoutOnlyBoxes += 1
      ctx.renderer.root.add(root)

      const scrollBox = new ScrollBoxRenderable(ctx.renderer, {
        id: `bench-culling-scaling-scrollbox-${childCount}`,
        width: "100%",
        height: "100%",
        viewportCulling: true,
      })
      renderables += 1
      layoutOnlyBoxes += 1
      root.add(scrollBox)

      for (let i = 0; i < childCount; i += 1) {
        const row = new BoxRenderable(ctx.renderer, {
          id: `bench-culling-scaling-row-${i}`,
          width: "100%",
          height: 1,
          flexShrink: 0,
          border: false,
          backgroundColor: i % 2 === 0 ? COLORS.panel : COLORS.element,
        })
        renderables += 1
        scrollBox.add(row)
      }

      await ctx.renderOnce()
      scrollBox.scrollTo(Math.floor(childCount / 2))
      await ctx.renderOnce()

      return {
        renderablesPerIteration: renderables,
        layoutOnlyBoxesPerIteration: layoutOnlyBoxes,
        runIteration: async (iteration) => {
          // Alternate 1-row scrolls: every frame is a real translate change
          // (the steady-state streaming/scrolling workload) while the visible
          // count stays constant and the position returns home every 2 frames.
          scrollBox.scrollBy(iteration % 2 === 0 ? 1 : -1)
          await ctx.renderOnce()
        },
        teardown: () => {
          root.destroyRecursively()
        },
      }
    },
  }
}

async function buildOpencodeLayoutTree(ctx: BenchmarkContext, options: LayoutTreeOptions): Promise<LayoutTreeState> {
  clearRoot(ctx.renderer)

  let renderables = 0
  let layoutOnlyBoxes = 0

  const trackLayoutBox = (box: BoxRenderable): BoxRenderable => {
    renderables += 1
    layoutOnlyBoxes += 1
    return box
  }

  const trackVisualBox = (box: BoxRenderable): BoxRenderable => {
    renderables += 1
    return box
  }

  const trackText = (text: TextRenderable): TextRenderable => {
    renderables += 1
    return text
  }

  const root = trackLayoutBox(
    new BoxRenderable(ctx.renderer, {
      id: "bench-layout-root",
      width: "100%",
      height: "100%",
      border: false,
      backgroundColor: COLORS.transparent,
      flexDirection: "column",
    }),
  )
  ctx.renderer.root.add(root)

  const header = trackLayoutBox(
    new BoxRenderable(ctx.renderer, {
      id: "bench-layout-header",
      width: "100%",
      height: 3,
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      gap: 1,
    }),
  )
  root.add(header)

  for (let i = 0; i < 5; i += 1) {
    header.add(
      trackLayoutBox(
        new BoxRenderable(ctx.renderer, {
          id: `bench-layout-chip-${i}`,
          flexShrink: 0,
          paddingLeft: 1,
          paddingRight: 1,
        }),
      ),
    )
  }

  const body = trackLayoutBox(
    new BoxRenderable(ctx.renderer, {
      id: "bench-layout-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
      paddingLeft: 1,
      paddingRight: 1,
    }),
  )
  root.add(body)

  const sidebar = trackLayoutBox(
    new BoxRenderable(ctx.renderer, {
      id: "bench-layout-sidebar",
      width: 22,
      minWidth: 22,
      maxWidth: 22,
      flexShrink: 0,
      flexDirection: "column",
      gap: 1,
    }),
  )
  body.add(sidebar)

  for (let i = 0; i < 12; i += 1) {
    sidebar.add(
      trackLayoutBox(
        new BoxRenderable(ctx.renderer, {
          id: `bench-layout-sidebar-row-${i}`,
          height: 1,
          paddingLeft: 1,
          paddingRight: 1,
        }),
      ),
    )
  }

  const main = trackLayoutBox(
    new BoxRenderable(ctx.renderer, {
      id: "bench-layout-main",
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
    }),
  )
  body.add(main)

  for (let i = 0; i < options.messageCount; i += 1) {
    const row = trackLayoutBox(
      new BoxRenderable(ctx.renderer, {
        id: `bench-layout-row-${i}`,
        width: "100%",
        flexDirection: "row",
      }),
    )

    const rail = trackLayoutBox(
      new BoxRenderable(ctx.renderer, {
        id: `bench-layout-rail-${i}`,
        width: 3,
        minWidth: 3,
        maxWidth: 3,
        flexShrink: 0,
      }),
    )

    const content = trackLayoutBox(
      new BoxRenderable(ctx.renderer, {
        id: `bench-layout-content-${i}`,
        flexGrow: 1,
        flexDirection: "column",
      }),
    )

    const meta = trackLayoutBox(
      new BoxRenderable(ctx.renderer, {
        id: `bench-layout-meta-${i}`,
        width: "100%",
        height: 1,
        flexDirection: "row",
        justifyContent: "space-between",
      }),
    )

    const badges = trackLayoutBox(
      new BoxRenderable(ctx.renderer, {
        id: `bench-layout-badges-${i}`,
        flexDirection: "row",
        gap: 1,
      }),
    )

    const actions = trackLayoutBox(
      new BoxRenderable(ctx.renderer, {
        id: `bench-layout-actions-${i}`,
        flexDirection: "row",
        gap: 1,
        flexShrink: 0,
      }),
    )

    meta.add(badges)
    meta.add(actions)
    content.add(meta)

    if (options.includeVisibleBoxes) {
      content.add(
        trackVisualBox(
          new BoxRenderable(ctx.renderer, {
            id: `bench-layout-leaf-${i}`,
            width: "100%",
            height: i % 5 === 0 ? 3 : i % 2 === 0 ? 2 : 1,
            border: false,
            backgroundColor: i % 3 === 0 ? COLORS.menu : i % 2 === 0 ? COLORS.panel : COLORS.element,
          }),
        ),
      )
    }

    if (options.includeText && i % 4 === 0) {
      content.add(
        trackText(
          new TextRenderable(ctx.renderer, {
            id: `bench-layout-text-${i}`,
            content: `message-${i}`,
          }),
        ),
      )
    }

    row.add(rail)
    row.add(content)
    main.add(row)
  }

  const footer = trackLayoutBox(
    new BoxRenderable(ctx.renderer, {
      id: "bench-layout-footer",
      width: "100%",
      height: 4,
      flexDirection: "row",
      gap: 1,
      paddingLeft: 1,
      paddingRight: 1,
    }),
  )
  root.add(footer)

  for (let i = 0; i < 6; i += 1) {
    footer.add(
      trackLayoutBox(
        new BoxRenderable(ctx.renderer, {
          id: `bench-layout-footer-item-${i}`,
          flexDirection: "row",
          gap: 1,
        }),
      ),
    )
  }

  await ctx.renderOnce()

  return {
    root,
    stats: {
      renderables,
      layoutOnlyBoxes,
    },
  }
}

async function runScenario(
  scenario: ScenarioDefinition,
  ctx: BenchmarkContext,
  iterations: number,
  warmupIterations: number,
): Promise<ScenarioResult> {
  const runtime = await scenario.setup(ctx)

  try {
    const sceneNodes: SceneNodeCounts | undefined = runtime.log
      ? { initial: runtime.nodes!.length, timedMin: Infinity, timedMax: 0, limit: runtime.log.nodeLimit }
      : undefined
    if (scenario.scene && !runtime.log) await ctx.renderOnce()
    for (let i = 0; i < warmupIterations; i += 1) {
      await runtime.runIteration(i)
    }

    const samples = new Array<number>(iterations)
    const sceneSamples = scenario.scene ? new Array<number>(iterations) : undefined
    const nativeRenderSamples = scenario.scene ? new Array<number>(iterations) : undefined
    let renderableCountTotal = 0
    let nativeFrameCount = sceneSamples ? ctx.renderer.getNativeStats().nativeFrameCount : 0
    if (sceneSamples) {
      assert.ok(Number.isFinite(ctx.renderer.lastSceneTimeMs), "renderer.lastSceneTimeMs is required for scene timing")
    }
    const elapsedStart = performance.now()

    for (let i = 0; i < iterations; i += 1) {
      const start = performance.now()
      await runtime.runIteration(warmupIterations + i)
      samples[i] = performance.now() - start
      renderableCountTotal += runtime.renderablesPerIteration
      if (sceneNodes) {
        const count = runtime.nodes!.length
        assert.ok(count <= sceneNodes.limit, "scene node limit exceeded")
        sceneNodes.timedMin = Math.min(sceneNodes.timedMin, count)
        sceneNodes.timedMax = Math.max(sceneNodes.timedMax, count)
      }
      if (sceneSamples) {
        const sceneTime = ctx.renderer.lastSceneTimeMs
        const stats = ctx.renderer.getNativeStats()
        assert.equal(stats.nativeFrameCount, nativeFrameCount + 1, `${scenario.name}: timed frame did not complete`)
        assert.ok(Number.isFinite(sceneTime) && sceneTime >= 0, "invalid renderer.lastSceneTimeMs")
        assert.ok(
          stats.nativeRenderTime !== undefined &&
            Number.isFinite(stats.nativeRenderTime) &&
            stats.nativeRenderTime >= 0,
          "invalid nativeRenderTime",
        )
        sceneSamples[i] = sceneTime
        // Native diff/encode timing is reported in microseconds, unlike scene timing.
        nativeRenderSamples![i] = stats.nativeRenderTime / 1000
        nativeFrameCount = stats.nativeFrameCount
      }
    }

    const elapsedMs = performance.now() - elapsedStart
    const stats = calculateStats(samples)
    const renderablesPerIteration = renderableCountTotal / iterations

    return {
      name: scenario.name,
      description: scenario.description,
      iterations,
      warmupIterations,
      elapsedMs: round(elapsedMs, 4),
      renderablesPerIteration,
      layoutOnlyBoxesPerIteration: runtime.layoutOnlyBoxesPerIteration,
      avgMs: round(stats.avgMs, 4),
      medianMs: round(stats.medianMs, 4),
      p95Ms: round(stats.p95Ms, 4),
      minMs: round(stats.minMs, 4),
      maxMs: round(stats.maxMs, 4),
      stdDevMs: round(stats.stdDevMs, 4),
      rsdPercent: round(stats.rsdPercent, 2),
      rmePercent: round(stats.rmePercent, 2),
      approxUsPerRenderable: renderablesPerIteration > 0 ? round((stats.avgMs * 1000) / renderablesPerIteration, 3) : 0,
      ...(sceneSamples ? { scene: calculateStats(sceneSamples) } : {}),
      ...(nativeRenderSamples ? { nativeRender: calculateStats(nativeRenderSamples) } : {}),
      ...(sceneNodes ? { sceneNodes } : {}),
    }
  } finally {
    await runtime.teardown?.()
  }
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
      rsdPercent: 0,
      rmePercent: 0,
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
    rsdPercent: avgMs === 0 ? 0 : (Math.sqrt(variance) / avgMs) * 100,
    rmePercent: relativeMarginOfError(samples, avgMs),
  }
}

// 95% confidence relative margin of error via Student-t, matching the
// convention in layout-benchmark.ts.
function relativeMarginOfError(samples: readonly number[], average: number): number {
  if (samples.length <= 1 || average === 0) {
    return 0
  }

  let variance = 0
  for (const value of samples) {
    const diff = value - average
    variance += diff * diff
  }
  variance /= samples.length - 1

  const sem = Math.sqrt(variance) / Math.sqrt(samples.length)
  return Math.abs((sem * tCritical95(samples.length - 1) * 100) / average)
}

function tCritical95(degreesOfFreedom: number): number {
  const table = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228]
  if (degreesOfFreedom <= 0) {
    return 0
  }

  return table[degreesOfFreedom - 1] ?? 1.96
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
