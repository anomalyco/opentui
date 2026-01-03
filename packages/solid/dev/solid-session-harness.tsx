#!/usr/bin/env bun
/** @jsxImportSource @opentui/solid */
import { getDataPaths, RGBA, Renderable, resolveRenderLib, SyntaxStyle, TextBufferRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { For } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import path from "path"
import { appendFile, mkdir, stat } from "node:fs/promises"

type Message = {
  id: number
  content: string
}

type MessageStore = {
  data: Message[]
}

type RenderMode = "code" | "text"
type ContainerMode = "scrollbox" | "box"

type HarnessControls = {
  setMessages: SetStoreFunction<MessageStore>
  getLength: () => number
}

type GraphemePoolClassSnapshot = {
  classId: number
  slots: number
  usedSlots: number
  bytes: number
}

type NativeMetricsSnapshot = {
  globalArenaBytes: number
  graphemePool: {
    totalSlots: number
    usedSlots: number
    totalBytes: number
    classes: GraphemePoolClassSnapshot[]
  }
  renderableTypes: Record<string, number>
  textBuffers: {
    count: number
    arenaBytes: number
    viewArenaBytes: number
    ropeSegments: number
    memRegistryUsedSlots: number
    memRegistryFreeSlots: number
    styledCapacity: number
    highlightLineCount: number
    highlightLineCapacity: number
    highlightCapacityTotal: number
    spanLineCount: number
    spanLineCapacity: number
    spanCapacityTotal: number
    dirtySpanLineCount: number
    highlightCount: number
    maxArenaBytes: number
    maxViewArenaBytes: number
  }
}

type Sample = {
  iteration: number
  rss: number
  heapUsed: number
  heapTotal: number
  arrayBuffers: number
  renderables: number
  native: NativeMetricsSnapshot
}

let controls: HarnessControls | undefined

function App(props: {
  syntaxStyle: SyntaxStyle
  renderMode: RenderMode
  highlight: boolean
  streaming: boolean
  container: ContainerMode
}) {
  const [messages, setMessages] = createStore<MessageStore>({ data: [] })

  controls = {
    setMessages,
    getLength: () => messages.data.length,
  }

  const content = (
    <For each={messages.data}>
      {(message) => (
        <box paddingBottom={1}>
          {props.renderMode === "text" ? (
            <text>{message.content}</text>
          ) : (
            <code
              filetype={props.highlight ? "markdown" : undefined}
              drawUnstyledText={false}
              streaming={props.streaming}
              syntaxStyle={props.syntaxStyle}
              content={message.content}
            />
          )}
        </box>
      )}
    </For>
  )

  if (props.container === "box") {
    return (
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexGrow={1}
        maxHeight="100%"
        flexDirection="column"
      >
        {content}
      </box>
    )
  }

  return (
    <scrollbox
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexGrow={1}
      maxHeight="100%"
      scrollbarOptions={{ visible: true }}
    >
      {content}
    </scrollbox>
  )
}

const args = parseArgs(process.argv.slice(2))
const iterations = getNumber(args, "--iterations", 200)
const chunks = getNumber(args, "--chunks", 12)
const reportEvery = getNumber(args, "--report-every", 10)
const maxGrowthMb = getNumber(args, "--max-growth-mb", 50)
const maxMessages = getNumber(args, "--max-messages", 120)
const renderMode = getString(args, "--renderable", "code")
const container = getString(args, "--container", "scrollbox")
const highlight = getBoolean(args, "--highlight", true)
const streaming = getBoolean(args, "--streaming", true)
const drain = getBoolean(args, "--drain", false)
const metricsEnabled = getBoolean(args, "--metrics", true)
const metricsEvery = getNumber(args, "--metrics-every", reportEvery)
const metricsFile = resolveMetricsFile(args)

if (renderMode !== "code" && renderMode !== "text") {
  throw new Error(`Invalid renderable mode: ${renderMode}`)
}

if (container !== "scrollbox" && container !== "box") {
  throw new Error(`Invalid container mode: ${container}`)
}

const syntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromInts(240, 240, 240) },
  comment: { fg: RGBA.fromInts(140, 140, 140), italic: true },
  keyword: { fg: RGBA.fromInts(120, 170, 255), bold: true },
  string: { fg: RGBA.fromInts(180, 220, 120) },
})

const dataPaths = getDataPaths()
const samples: Sample[] = []
const start = Date.now()
const runId = buildRunId()
const lib = resolveRenderLib()

const { renderer, renderOnce } = await testRender(
  () => (
    <App
      syntaxStyle={syntaxStyle}
      renderMode={renderMode as RenderMode}
      highlight={highlight}
      streaming={streaming}
      container={container as ContainerMode}
    />
  ),
  {
  width: 80,
  height: 24,
  },
)

if (!controls) {
  renderer.destroy()
  syntaxStyle.destroy()
  throw new Error("Harness controls unavailable")
}

await ensureMetricsFile()

let runError: unknown
try {
  for (let i = 0; i < iterations; i += 1) {
    addMessage(i)
    await renderOnce()

    let content = ""
    for (let c = 0; c < chunks; c += 1) {
      content += buildChunk(i, c)
      updateMessage(i, content)
      await renderOnce()
    }

    trimMessages(maxMessages)
    await renderOnce()
    if (drain) {
      await drainTick()
    }

    await sampleMemory(i)
  }
} catch (error) {
  runError = error
} finally {
  renderer.destroy()
  syntaxStyle.destroy()
}

const elapsedMs = Date.now() - start
const baseline = samples[0]?.rss ?? 0
const last = samples[samples.length - 1]?.rss ?? baseline
const peak = samples.reduce((max, value) => Math.max(max, value.rss), baseline)
const growthMb = toMb(last - baseline)
const peakGrowthMb = toMb(peak - baseline)

console.log("")
console.log("Solid session harness summary")
console.log(`Iterations: ${iterations}`)
console.log(`Chunks per message: ${chunks}`)
console.log(`Max messages: ${maxMessages}`)
console.log(`Renderable: ${renderMode}`)
console.log(`Highlighting: ${highlight}`)
console.log(`Streaming: ${streaming}`)
console.log(`Container: ${container}`)
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

await appendMetricsRecord({
  type: "summary",
  runId,
  timestamp: new Date().toISOString(),
  args: Object.fromEntries(args.entries()),
  summary: {
    iterations,
    chunks,
    maxMessages,
    renderMode,
    highlight,
    streaming,
    container,
    elapsedMs,
    baselineRss: baseline,
    finalRss: last,
    peakRss: peak,
    finalGrowthMb: growthMb,
    peakGrowthMb,
    renderables: samples[samples.length - 1]?.renderables ?? Renderable.renderablesByNumber.size,
    dataPathsListeners: dataPaths.listenerCount("paths:changed"),
  },
  error: runError ? formatError(runError) : null,
})

if (runError) {
  throw runError
}

function addMessage(id: number): void {
  controls?.setMessages(
    "data",
    produce((data) => {
      data.push({ id, content: "" })
    }),
  )
}

function updateMessage(id: number, content: string): void {
  controls?.setMessages("data", (message) => message.id === id, "content", content)
}

function trimMessages(limit: number): void {
  if (!controls || limit <= 0) return
  const length = controls.getLength()
  if (length <= limit) return
  const removeCount = length - limit
  controls.setMessages(
    "data",
    produce((data) => {
      data.splice(0, removeCount)
    }),
  )
}

function buildChunk(iteration: number, chunk: number): string {
  const header = `\n### Update ${iteration}.${chunk}\n`
  const body = `- item ${iteration}-${chunk}\n- value: ${iteration * 10 + chunk}\n`
  const codeFence = `\n\`\`\`ts\nconst value = ${iteration * 10 + chunk}\n\`\`\`\n`
  return header + body + codeFence
}

async function sampleMemory(iteration: number): Promise<void> {
  if (typeof Bun.gc === "function") {
    Bun.gc(true)
  }

  const memory = process.memoryUsage()
  const native = collectNativeMetrics()
  const renderables = Renderable.renderablesByNumber.size
  const sample: Sample = {
    iteration,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    arrayBuffers: memory.arrayBuffers,
    renderables,
    native,
  }

  samples.push(sample)

  if (iteration % reportEvery === 0) {
    console.log(
      `iter ${iteration} rss=${toMb(sample.rss).toFixed(2)} MB renderables=${renderables} listeners=${dataPaths.listenerCount("paths:changed")}`,
    )
  }

  if (metricsEnabled && (iteration % metricsEvery === 0 || iteration === iterations - 1)) {
    await appendMetricsRecord({
      type: "sample",
      runId,
      timestamp: new Date().toISOString(),
      iteration,
      rss: sample.rss,
      heapUsed: sample.heapUsed,
      heapTotal: sample.heapTotal,
      arrayBuffers: sample.arrayBuffers,
      renderables: sample.renderables,
      native: sample.native,
    })
  }
}

function drainTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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

function getString(values: Map<string, string>, key: string, fallback: string): string {
  const raw = values.get(key)
  if (raw === undefined || raw.length === 0) return fallback
  return raw
}

function collectNativeMetrics(): NativeMetricsSnapshot {
  const renderableTypes: Record<string, number> = {}
  const textBuffers = {
    count: 0,
    arenaBytes: 0,
    viewArenaBytes: 0,
    ropeSegments: 0,
    memRegistryUsedSlots: 0,
    memRegistryFreeSlots: 0,
    styledCapacity: 0,
    highlightLineCount: 0,
    highlightLineCapacity: 0,
    highlightCapacityTotal: 0,
    spanLineCount: 0,
    spanLineCapacity: 0,
    spanCapacityTotal: 0,
    dirtySpanLineCount: 0,
    highlightCount: 0,
    maxArenaBytes: 0,
    maxViewArenaBytes: 0,
  }

  for (const renderable of Renderable.renderablesByNumber.values()) {
    const typeName = renderable?.constructor?.name ?? "Unknown"
    renderableTypes[typeName] = (renderableTypes[typeName] ?? 0) + 1

    if (!(renderable instanceof TextBufferRenderable)) {
      continue
    }

    const textBuffer = (renderable as any).textBuffer
    const textBufferView = (renderable as any).textBufferView
    if (!textBuffer) {
      continue
    }

    const bufferMetrics = textBuffer.getNativeMetrics()
    const viewMetrics = textBufferView?.getNativeMetrics?.() ?? { arenaBytes: 0 }

    textBuffers.count += 1
    textBuffers.arenaBytes += bufferMetrics.arenaBytes
    textBuffers.viewArenaBytes += viewMetrics.arenaBytes
    textBuffers.ropeSegments += bufferMetrics.ropeSegments
    textBuffers.memRegistryUsedSlots += bufferMetrics.memRegistryUsedSlots
    textBuffers.memRegistryFreeSlots += bufferMetrics.memRegistryFreeSlots
    textBuffers.styledCapacity += bufferMetrics.styledCapacity
    textBuffers.highlightLineCount += bufferMetrics.highlightLineCount
    textBuffers.highlightLineCapacity += bufferMetrics.highlightLineCapacity
    textBuffers.highlightCapacityTotal += bufferMetrics.highlightCapacityTotal
    textBuffers.spanLineCount += bufferMetrics.spanLineCount
    textBuffers.spanLineCapacity += bufferMetrics.spanLineCapacity
    textBuffers.spanCapacityTotal += bufferMetrics.spanCapacityTotal
    textBuffers.dirtySpanLineCount += bufferMetrics.dirtySpanLineCount
    textBuffers.highlightCount += bufferMetrics.highlightCount

    textBuffers.maxArenaBytes = Math.max(textBuffers.maxArenaBytes, bufferMetrics.arenaBytes)
    textBuffers.maxViewArenaBytes = Math.max(textBuffers.maxViewArenaBytes, viewMetrics.arenaBytes)
  }

  const classCount = 5
  const graphemeClasses: GraphemePoolClassSnapshot[] = []
  for (let i = 0; i < classCount; i += 1) {
    graphemeClasses.push({
      classId: i,
      slots: lib.graphemePoolGetClassSlots(i),
      usedSlots: lib.graphemePoolGetClassUsedSlots(i),
      bytes: lib.graphemePoolGetClassBytes(i),
    })
  }

  return {
    globalArenaBytes: lib.getArenaAllocatedBytes(),
    graphemePool: {
      totalSlots: lib.graphemePoolGetTotalSlots(),
      usedSlots: lib.graphemePoolGetUsedSlots(),
      totalBytes: lib.graphemePoolGetTotalBytes(),
      classes: graphemeClasses,
    },
    renderableTypes,
    textBuffers,
  }
}

function resolveMetricsFile(values: Map<string, string>): string | null {
  const argValue = values.get("--metrics-file")
  if (argValue && argValue !== "true") {
    return path.resolve(argValue)
  }

  if (process.env.OPENTUI_METRICS_FILE) {
    return path.resolve(process.env.OPENTUI_METRICS_FILE)
  }

  return path.resolve(process.cwd(), "..", "core", "dev", "native-metrics.jsonl")
}

async function ensureMetricsFile(): Promise<void> {
  if (!metricsEnabled || !metricsFile) return
  await mkdir(path.dirname(metricsFile), { recursive: true })

  let size = 0
  try {
    const stats = await stat(metricsFile)
    size = stats.size
  } catch {
    size = 0
  }

  if (size === 0) {
    const header = {
      type: "header",
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    }
    await appendFile(metricsFile, `${JSON.stringify(header)}\n`, "utf8")
  }
}

async function appendMetricsRecord(record: Record<string, unknown>): Promise<void> {
  if (!metricsEnabled || !metricsFile) return
  await appendFile(metricsFile, `${JSON.stringify(record)}\n`, "utf8")
}

function buildRunId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${timestamp}-${random}`
}

function formatError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}
