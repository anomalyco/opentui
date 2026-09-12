#!/usr/bin/env bun

// This benchmark targets render/layout bookkeeping in wrapper-heavy trees,
// scrollbox culling, and scrollbar-heavy paths that exercise Renderable
// traversal without depending on one specific widget.

import { performance } from "node:perf_hooks"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Command } from "commander"
import { BoxRenderable, RGBA, ScrollBarRenderable, ScrollBoxRenderable, TextRenderable } from "../index.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"

type ScenarioRuntime = {
  renderablesPerIteration: number
  layoutOnlyBoxesPerIteration: number
  runIteration: (iteration: number) => Promise<void>
  teardown?: () => void | Promise<void>
}

type ScenarioDefinition = {
  name: string
  description: string
  setup: (ctx: BenchmarkContext) => Promise<ScenarioRuntime> | ScenarioRuntime
}

type BenchmarkContext = {
  renderer: TestRenderer
  renderOnce: () => Promise<void>
  width: number
  height: number
}

type ScenarioResult = {
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
}

type TimingStats = {
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

const scenarios = createScenarios()

if (options.listScenarios) {
  for (const scenario of scenarios) {
    console.log(scenario.name)
  }
  process.exit(0)
}

const selectedScenarios = scenarioFilter ? scenarios.filter((scenario) => scenario.name === scenarioFilter) : scenarios
if (selectedScenarios.length === 0) {
  console.error(`Unknown scenario: ${scenarioFilter}`)
  process.exit(1)
}

if (outputEnabled) {
  console.log(`render traversal benchmark (${suiteName})`)
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

const ctx: BenchmarkContext = { renderer, renderOnce, width, height }
const results: ScenarioResult[] = []

try {
  for (const scenario of selectedScenarios) {
    writeLine(outputEnabled, `Running ${scenario.name}...`)
    const result = await runScenario(scenario, ctx, iterations, warmupIterations)
    results.push(result)
    writeLine(
      outputEnabled,
      `  avg=${result.avgMs.toFixed(4)}ms p95=${result.p95Ms.toFixed(4)}ms rsd=${result.rsdPercent.toFixed(2)}% rme=${result.rmePercent.toFixed(2)}%`,
    )
  }
} finally {
  renderer.destroy()
}

if (outputEnabled) {
  console.table(
    results.map((result) => ({
      scenario: result.name,
      renderables: result.renderablesPerIteration,
      layoutOnlyBoxes: result.layoutOnlyBoxesPerIteration,
      avgMs: result.avgMs,
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
      name: "render_list_hot_path",
      description: "Repeated render-list traversal over an unchanged OpenCode-like tree",
      setup: async (ctx) => {
        const state = await buildOpencodeLayoutTree(ctx, {
          messageCount: Math.max(48, ctx.height + 12),
          includeVisibleBoxes: false,
          includeText: false,
        })
        const batchSize = 1000

        return {
          renderablesPerIteration: state.stats.renderables * batchSize,
          layoutOnlyBoxesPerIteration: state.stats.layoutOnlyBoxes * batchSize,
          runIteration: async () => {
            for (let index = 0; index < batchSize; index++) {
              ctx.renderer.root.render(ctx.renderer.nextRenderBuffer, 0)
            }
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
        resetBuffers(ctx.renderer)

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
        resetBuffers(ctx.renderer)

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

function createYogaLayoutReadScenario(nodeCount: number): ScenarioDefinition {
  return {
    name: `yoga_layout_reads_${nodeCount}`,
    description: `Read ${nodeCount} computed Yoga layouts through the production FFI path`,
    setup: async (ctx) => {
      clearRoot(ctx.renderer)
      resetBuffers(ctx.renderer)

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
        return node.getLayoutNode()
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

// Frame-time scaling with total child count under viewport culling, at a
// constant visible count (~viewport height). This is the per-frame
// O(total children) layout-refresh path in Renderable.updateLayout for
// _hasVisibleChildFilter parents: before culling can read screen positions,
// every child gets one updateFromLayout (FFI getComputedLayout) per frame,
// so steady-state frame time grows with hidden children. Watch
// approxUsPerRenderable across the scaling scenarios: roughly constant means
// the per-frame cost is linear in total children; if the refresh path ever
// becomes O(visible), it should drop as childCount grows.
function createCullingScalingScenario(childCount: number): ScenarioDefinition {
  return {
    name: `scrollbox_culling_scaling_${childCount}`,
    description: `Scrolling viewport-culled scrollbox with ${childCount} rows, constant visible count`,
    setup: async (ctx) => {
      clearRoot(ctx.renderer)
      resetBuffers(ctx.renderer)

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
  resetBuffers(ctx.renderer)

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
      iterations,
      warmupIterations,
      elapsedMs: round(elapsedMs, 4),
      renderablesPerIteration: runtime.renderablesPerIteration,
      layoutOnlyBoxesPerIteration: runtime.layoutOnlyBoxesPerIteration,
      avgMs: round(stats.avgMs, 4),
      medianMs: round(stats.medianMs, 4),
      p95Ms: round(stats.p95Ms, 4),
      minMs: round(stats.minMs, 4),
      maxMs: round(stats.maxMs, 4),
      stdDevMs: round(stats.stdDevMs, 4),
      rsdPercent: round(stats.rsdPercent, 2),
      rmePercent: round(stats.rmePercent, 2),
      approxUsPerRenderable:
        runtime.renderablesPerIteration > 0 ? round((stats.avgMs * 1000) / runtime.renderablesPerIteration, 3) : 0,
    }
  } finally {
    await runtime.teardown?.()
    clearRoot(ctx.renderer)
    resetBuffers(ctx.renderer)
  }
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
