import { dlopen, FFIType, suffix } from "bun:ffi"
import { setRenderLibPath } from "../zig.js"

if (!process.env.NATIVE_SPAN_FEED_LIB) {
  process.env.NATIVE_SPAN_FEED_LIB = "bench"
}
const { NativeSpanFeed } = await import("../NativeSpanFeed.ts")

const args = process.argv.slice(2)

function getArg(name: string): string | null {
  const prefix = `--${name}=`
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
  }
  return null
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`)
}

const libVariant = process.env.NATIVE_SPAN_FEED_LIB
const libBase = libVariant === "bench" ? "native_span_feed_bench" : (libVariant ?? "native_span_feed")
const libPath = new URL(`../../../native/zig-out/lib/lib${libBase}.${suffix}`, import.meta.url).pathname

setRenderLibPath(libPath)

const benchLib = dlopen(libPath, {
  benchProduce: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u32],
    returns: FFIType.i32,
  },
  benchProduceWrite: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u32],
    returns: FFIType.i32,
  },
})

type MemorySample = {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

function readMemory(): MemorySample {
  const u = process.memoryUsage()
  return {
    rss: u.rss ?? 0,
    heapTotal: u.heapTotal ?? 0,
    heapUsed: u.heapUsed ?? 0,
    external: u.external ?? 0,
    arrayBuffers: u.arrayBuffers ?? 0,
  }
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
}

type AsyncScenario = {
  name: string
  bytesPerIter: bigint
  iters: number
  chunkSize: number
  initialChunks: number
  delayMinMs: number
  delayMaxMs: number
  producerAPI: "reserve" | "write"
  patternSize: number
}

type AsyncScenarioResult = {
  name: string
  producerAPI: string
  bytesPerIter: bigint
  iters: number
  bytesTotal: bigint
  elapsedMs: number
  throughputMBps: number
  avgIterMs: number
  medianIterMs: number
  p95IterMs: number
  minIterMs: number
  maxIterMs: number
  asyncDelay: { minMs: number; maxMs: number }
  peakInFlightSpans: number
  peakChunks: number
  memory: {
    start: MemorySample
    end: MemorySample
    peak: MemorySample
  }
  options: {
    chunkSize: number
    initialChunks: number
  }
}

async function runAsyncScenario(scenario: AsyncScenario): Promise<AsyncScenarioResult> {
  const memStart = readMemory()
  const memPeak = { ...memStart }

  let received = 0n
  let inFlightSpans = 0
  let peakInFlightSpans = 0
  let peakChunks = 0

  const pattern = new Uint8Array(scenario.patternSize)
  for (let i = 0; i < scenario.patternSize; i++) pattern[i] = i & 0xff
  const patternLen = BigInt(pattern.byteLength)

  const durations: number[] = []
  let totalElapsed = 0

  for (let iter = 0; iter < scenario.iters; iter++) {
    const stream = NativeSpanFeed.create({
      chunkSize: scenario.chunkSize,
      initialChunks: scenario.initialChunks,
      autoCommitOnFull: true,
    })

    const pending: Promise<void>[] = []

    stream.onData(async (data) => {
      const len = data.byteLength
      inFlightSpans++
      if (inFlightSpans > peakInFlightSpans) peakInFlightSpans = inFlightSpans

      const delay = scenario.delayMinMs + Math.random() * (scenario.delayMaxMs - scenario.delayMinMs)

      const p = new Promise<void>((resolve) => {
        setTimeout(() => {
          received += BigInt(len)
          inFlightSpans--
          resolve()
        }, delay)
      })
      pending.push(p)
    })

    const iterStart = performance.now()

    const produceFn =
      scenario.producerAPI === "write" ? benchLib.symbols.benchProduceWrite : benchLib.symbols.benchProduce
    const status = produceFn(stream.streamPtr, scenario.bytesPerIter, pattern, patternLen, 0)

    if (status !== 0) {
      console.error(`produce failed: ${status} scenario=${scenario.name} iter=${iter}`)
      process.exit(1)
    }

    await Promise.all(pending)

    const iterElapsed = performance.now() - iterStart
    durations.push(iterElapsed)
    totalElapsed += iterElapsed

    const mem = readMemory()
    memPeak.rss = Math.max(memPeak.rss, mem.rss)
    memPeak.heapTotal = Math.max(memPeak.heapTotal, mem.heapTotal)
    memPeak.heapUsed = Math.max(memPeak.heapUsed, mem.heapUsed)
    memPeak.external = Math.max(memPeak.external, mem.external)
    memPeak.arrayBuffers = Math.max(memPeak.arrayBuffers, mem.arrayBuffers)

    stream.close()
  }

  const memEnd = readMemory()
  memPeak.rss = Math.max(memPeak.rss, memEnd.rss)

  const sorted = [...durations].sort((a, b) => a - b)
  const count = durations.length
  const avg = count > 0 ? totalElapsed / count : 0
  const median = count > 0 ? (sorted[Math.floor(count / 2)] ?? 0) : 0
  const p95 = count > 0 ? (sorted[Math.floor(count * 0.95)] ?? 0) : 0
  const min = count > 0 ? (sorted[0] ?? 0) : 0
  const max = count > 0 ? (sorted[count - 1] ?? 0) : 0

  const totalSec = totalElapsed / 1000
  const totalMB = Number(received) / (1024 * 1024)
  const mbps = totalSec > 0 ? totalMB / totalSec : 0

  return {
    name: scenario.name,
    producerAPI: scenario.producerAPI,
    bytesPerIter: scenario.bytesPerIter,
    iters: scenario.iters,
    bytesTotal: received,
    elapsedMs: totalElapsed,
    throughputMBps: mbps,
    avgIterMs: avg,
    medianIterMs: median,
    p95IterMs: p95,
    minIterMs: min,
    maxIterMs: max,
    asyncDelay: { minMs: scenario.delayMinMs, maxMs: scenario.delayMaxMs },
    peakInFlightSpans,
    peakChunks,
    memory: { start: memStart, end: memEnd, peak: memPeak },
    options: {
      chunkSize: scenario.chunkSize,
      initialChunks: scenario.initialChunks,
    },
  }
}

const KB = 1024n
const kb = (v: number) => BigInt(v) * KB

function makeAsyncScenarios(): AsyncScenario[] {
  const iters = Number(getArg("iters") ?? "50")
  return [
    {
      name: "async/small_64k_fast",
      bytesPerIter: kb(64),
      iters,
      chunkSize: 64 * 1024,
      initialChunks: 2,
      delayMinMs: 1,
      delayMaxMs: 3,
      producerAPI: "reserve",
      patternSize: 64,
    },
    {
      name: "async/small_64k_slow",
      bytesPerIter: kb(64),
      iters,
      chunkSize: 64 * 1024,
      initialChunks: 2,
      delayMinMs: 5,
      delayMaxMs: 10,
      producerAPI: "reserve",
      patternSize: 64,
    },
    {
      name: "async/medium_256k_mixed",
      bytesPerIter: kb(256),
      iters,
      chunkSize: 64 * 1024,
      initialChunks: 2,
      delayMinMs: 1,
      delayMaxMs: 10,
      producerAPI: "reserve",
      patternSize: 1024,
    },
    {
      name: "async/large_1mb_fast",
      bytesPerIter: kb(1024),
      iters: Math.max(10, Math.floor(iters / 5)),
      chunkSize: 64 * 1024,
      initialChunks: 2,
      delayMinMs: 1,
      delayMaxMs: 3,
      producerAPI: "reserve",
      patternSize: 1024,
    },
    {
      name: "async/large_1mb_slow",
      bytesPerIter: kb(1024),
      iters: Math.max(10, Math.floor(iters / 5)),
      chunkSize: 64 * 1024,
      initialChunks: 2,
      delayMinMs: 5,
      delayMaxMs: 10,
      producerAPI: "reserve",
      patternSize: 1024,
    },
    {
      name: "async/write_256k_mixed",
      bytesPerIter: kb(256),
      iters,
      chunkSize: 64 * 1024,
      initialChunks: 2,
      delayMinMs: 1,
      delayMaxMs: 10,
      producerAPI: "write",
      patternSize: 1024,
    },
    {
      name: "async/tiny_chunks_slow",
      bytesPerIter: kb(64),
      iters,
      chunkSize: 4096,
      initialChunks: 1,
      delayMinMs: 5,
      delayMaxMs: 10,
      producerAPI: "reserve",
      patternSize: 64,
    },
  ]
}

const jsonArg = getArg("json")
const jsonDefault = "latest-async-bench-run.json"
const jsonPath = jsonArg ?? (hasFlag("json") ? jsonDefault : null)

console.log("=== Async Handler Benchmark Suite ===")
console.log("Measures throughput, memory growth, and backpressure with async data handlers")
console.log("that resolve after random delays (simulating I/O like file writes, network, etc.)\n")

const scenarios = makeAsyncScenarios()
const results: AsyncScenarioResult[] = []

for (const scenario of scenarios) {
  const result = await runAsyncScenario(scenario)
  results.push(result)

  const memDelta = {
    rss: result.memory.end.rss - result.memory.start.rss,
    external: result.memory.end.external - result.memory.start.external,
    arrayBuffers: result.memory.end.arrayBuffers - result.memory.start.arrayBuffers,
  }

  console.log(
    `scenario=${result.name}` +
      ` api=${result.producerAPI}` +
      ` iters=${result.iters}` +
      ` bytesPerIter=${result.bytesPerIter}` +
      ` bytesTotal=${result.bytesTotal}` +
      ` delay=${result.asyncDelay.minMs}-${result.asyncDelay.maxMs}ms` +
      ` avgIterMs=${result.avgIterMs.toFixed(3)}` +
      ` medianIterMs=${result.medianIterMs.toFixed(3)}` +
      ` p95IterMs=${result.p95IterMs.toFixed(3)}` +
      ` minIterMs=${result.minIterMs.toFixed(3)}` +
      ` maxIterMs=${result.maxIterMs.toFixed(3)}` +
      ` throughputMBps=${result.throughputMBps.toFixed(2)}` +
      ` peakInFlight=${result.peakInFlightSpans}` +
      ` memDeltaRss=${formatMB(memDelta.rss)}` +
      ` memDeltaExt=${formatMB(memDelta.external)}` +
      ` memDeltaAB=${formatMB(memDelta.arrayBuffers)}` +
      ` memPeakRss=${formatMB(result.memory.peak.rss)}`,
  )
}

if (jsonPath) {
  const payload = {
    runId: new Date().toISOString(),
    suite: "async",
    args: args.slice(),
    results,
  }
  const json = JSON.stringify(
    payload,
    (_key, value) => {
      if (typeof value === "bigint") return value.toString()
      return value
    },
    2,
  )
  await Bun.write(jsonPath, json)
  console.log(`\nResults written to ${jsonPath}`)
}
