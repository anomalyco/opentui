#!/usr/bin/env bun
import { createTestRenderer } from "../src/testing/test-renderer"
import { CodeRenderable } from "../src/renderables/Code"
import { DiffRenderable } from "../src/renderables/Diff"
import { SyntaxStyle } from "../src/syntax-style"
import { RGBA } from "../src/lib/RGBA"
import { getDataPaths } from "../src/lib/data-paths"

type Mode = "renderables" | "renderer-cycle"

const args = parseArgs(process.argv.slice(2))
const mode = getMode(args)
const iterations = getNumber(args, "--iterations", 200)
const chunks = getNumber(args, "--chunks", 12)
const reportEvery = getNumber(args, "--report-every", 10)
const maxGrowthMb = getNumber(args, "--max-growth-mb", 50)
const diffOwnsStyle = getBoolean(args, "--diff-own-style", false)

const syntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromInts(240, 240, 240) },
  comment: { fg: RGBA.fromInts(140, 140, 140), italic: true },
  keyword: { fg: RGBA.fromInts(120, 170, 255), bold: true },
  string: { fg: RGBA.fromInts(180, 220, 120) },
})

const samples: number[] = []
const start = Date.now()
const dataPaths = getDataPaths()

const run = mode === "renderer-cycle" ? runRendererCycles : runRenderableCycles
await run()

const elapsedMs = Date.now() - start
const baseline = samples[0] ?? 0
const last = samples[samples.length - 1] ?? baseline
const peak = samples.reduce((max, value) => Math.max(max, value), baseline)
const growthMb = toMb(last - baseline)
const peakGrowthMb = toMb(peak - baseline)

console.log("")
console.log("Memory leak harness summary")
console.log(`Mode: ${mode}`)
console.log(`Iterations: ${iterations}`)
console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`)
console.log(`Baseline RSS: ${toMb(baseline).toFixed(2)} MB`)
console.log(`Final RSS: ${toMb(last).toFixed(2)} MB`)
console.log(`Peak RSS: ${toMb(peak).toFixed(2)} MB`)
console.log(`Final growth: ${growthMb.toFixed(2)} MB`)
console.log(`Peak growth: ${peakGrowthMb.toFixed(2)} MB`)
console.log(`DataPaths listeners: ${dataPaths.listenerCount("paths:changed")}`)

if (growthMb > maxGrowthMb) {
  console.error(`Memory growth exceeded threshold (${maxGrowthMb} MB)`)
  process.exitCode = 1
}

syntaxStyle.destroy()

async function runRenderableCycles(): Promise<void> {
  const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 24 })
  const root = renderer.root

  try {
    for (let i = 0; i < iterations; i += 1) {
      const code = new CodeRenderable(renderer, {
        width: 80,
        height: 12,
        syntaxStyle,
        filetype: "markdown",
        drawUnstyledText: false,
        streaming: true,
      })
      root.add(code)

      let content = ""
      for (let c = 0; c < chunks; c += 1) {
        content += buildChunk(i, c)
        code.content = content
        await renderOnce()
      }

      const diff = new DiffRenderable(renderer, {
        diff: buildDiff(i),
        syntaxStyle: diffOwnsStyle ? undefined : syntaxStyle,
      })
      root.add(diff)
      await renderOnce()
      diff.diff = buildDiff(i + 1)
      await renderOnce()
      diff.destroyRecursively()

      code.destroy()
      await renderOnce()

      sampleMemory(i)
    }
  } finally {
    renderer.destroy()
  }
}

async function runRendererCycles(): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 24 })
    const root = renderer.root

    const code = new CodeRenderable(renderer, {
      width: 80,
      height: 12,
      syntaxStyle,
      filetype: "markdown",
      drawUnstyledText: false,
      streaming: true,
    })
    root.add(code)
    code.content = buildChunk(i, 0)
    await renderOnce()

    code.destroy()
    renderer.destroy()

    sampleMemory(i)
  }
}

function buildChunk(iteration: number, chunk: number): string {
  const header = `\n### Update ${iteration}.${chunk}\n`
  const body = `- item ${iteration}-${chunk}\n- value: ${iteration * 10 + chunk}\n`
  const codeFence = `\n\`\`\`ts\nconst value = ${iteration * 10 + chunk}\n\`\`\`\n`
  return header + body + codeFence
}

function buildDiff(iteration: number): string {
  const before = `const value = ${iteration}\n`
  const after = `const value = ${iteration + 1}\n`
  return [
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1,1 +1,1 @@",
    `-${before}`.trimEnd(),
    `+${after}`.trimEnd(),
  ].join("\n")
}

function sampleMemory(iteration: number): void {
  if (typeof Bun.gc === "function") {
    Bun.gc(true)
  }

  const rss = process.memoryUsage().rss
  samples.push(rss)

  if (iteration % reportEvery === 0) {
    console.log(
      `iter ${iteration} rss=${toMb(rss).toFixed(2)} MB listeners=${dataPaths.listenerCount("paths:changed")}`,
    )
  }
}

function toMb(bytes: number): number {
  return bytes / 1024 / 1024
}

function parseArgs(argv: string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue
    const [key, rawValue] = arg.split("=")
    values.set(key, rawValue ?? "true")
  }
  return values
}

function getNumber(values: Map<string, string>, key: string, fallback: number): number {
  const raw = values.get(key)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${key}: ${raw}`)
  }
  return parsed
}

function getBoolean(values: Map<string, string>, key: string, fallback: boolean): boolean {
  const raw = values.get(key)
  if (raw === undefined) return fallback
  return raw === "true" || raw === "1"
}

function getMode(values: Map<string, string>): Mode {
  const raw = values.get("--mode")
  if (!raw) return "renderables"
  if (raw === "renderables" || raw === "renderer-cycle") return raw
  throw new Error(`Unsupported mode: ${raw}`)
}
