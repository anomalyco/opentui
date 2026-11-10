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

const totalBytes = BigInt(getArg("bytes") ?? "100000")
const iterationsArg = getArg("iters")
const iterations = Number(iterationsArg ?? "1000")
const commitEvery = Number(getArg("commit") ?? "0")
const chunkSize = Number(getArg("chunk") ?? String(64 * 1024))
const initialChunks = Number(getArg("initial") ?? "2")
const autoArg = getArg("auto")
const autoCommitOnFull = autoArg ? autoArg !== "0" : true
const writeStdout = hasFlag("stdout")
const patternArg = getArg("pattern")
const patternTypeArg = getArg("pattern-type")
const patternSizeArg = getArg("pattern-size")
const reuseStream = hasFlag("reuse")
const suiteName = getArg("suite")
const suiteIterations = suiteName === "quick" && iterationsArg === null ? 20000 : iterations
const memSampleArg = getArg("mem-sample")
const memEnabled = hasFlag("mem") || memSampleArg !== null
const memSampleEvery = memSampleArg ? Number(memSampleArg) : 1
const jsonArg = getArg("json")
const jsonDefault = suiteName ? `latest-${suiteName}-bench-run.json` : "latest-bench-run.json"
const jsonPath = jsonArg ?? (hasFlag("json") ? jsonDefault : null)

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

const encoder = new TextEncoder()

type PatternSpec =
  | { type: "ansi"; size?: number }
  | { type: "ascii"; size?: number }
  | { type: "binary"; size?: number }
  | { type: "random"; size?: number }
  | { type: "string"; value: string; size?: number }

/**
 * Producer API: "reserve" (zero-copy) or "write" (copy).
 */
type ProducerAPI = "reserve" | "write"

type Scenario = {
  name: string
  bytes: bigint
  iters: number
  chunkSize: number
  initialChunks: number
  autoCommitOnFull: boolean
  commitEvery: number
  pattern?: PatternSpec
  reuseStream: boolean
  producerAPI: ProducerAPI
}

type ScenarioResult = {
  name: string
  producerAPI: ProducerAPI
  bytesPerIter: bigint
  iters: number
  bytesTotal: bigint
  avgMs: number
  medianMs: number
  p95Ms: number
  minMs: number
  maxMs: number
  throughputMBps: number
  elapsedMs: number
  memory?: {
    start: MemorySample
    end: MemorySample
    delta: MemorySample
    peak: MemorySample
    samples: number
  }
  options: {
    chunkSize: number
    initialChunks: number
    autoCommitOnFull: boolean
    commitEvery: number
    reuseStream: boolean
    pattern?: PatternSpec
  }
}

type MemorySample = {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

const KB = 1024n
const MB = 1024n * KB
const kb = (value: number) => BigInt(value) * KB
const mb = (value: number) => BigInt(value) * MB
const patternSizeSmall = 64
const patternSizeMedium = 1024
const patternSizeLarge = 32768

function repeatPattern(base: Uint8Array, size: number): Uint8Array {
  if (size <= base.byteLength) return base.subarray(0, size)
  const out = new Uint8Array(size)
  let offset = 0
  while (offset < size) {
    const slice = base.subarray(0, Math.min(base.byteLength, size - offset))
    out.set(slice, offset)
    offset += slice.byteLength
  }
  return out
}

function buildPattern(spec?: PatternSpec): Uint8Array | null {
  if (!spec) return null
  const size = spec.size ?? 0
  switch (spec.type) {
    case "ansi": {
      const base = encoder.encode("\x1b[32mnative-span-feed\x1b[0m\n")
      return size > 0 ? repeatPattern(base, size) : base
    }
    case "ascii": {
      const base = encoder.encode("native-span-feed\n")
      return size > 0 ? repeatPattern(base, size) : base
    }
    case "string": {
      const base = encoder.encode(spec.value)
      return size > 0 ? repeatPattern(base, size) : base
    }
    case "binary": {
      const len = size > 0 ? size : 4096
      const out = new Uint8Array(len)
      for (let i = 0; i < len; i += 1) out[i] = i & 0xff
      return out
    }
    case "random": {
      const len = size > 0 ? size : 4096
      const out = new Uint8Array(len)
      crypto.getRandomValues(out)
      return out
    }
  }
}

function readMemory(): MemorySample {
  const usage = process.memoryUsage()
  return {
    rss: usage.rss ?? 0,
    heapTotal: usage.heapTotal ?? 0,
    heapUsed: usage.heapUsed ?? 0,
    external: usage.external ?? 0,
    arrayBuffers: usage.arrayBuffers ?? 0,
  }
}

function updatePeak(current: MemorySample, peak: MemorySample): void {
  peak.rss = Math.max(peak.rss, current.rss)
  peak.heapTotal = Math.max(peak.heapTotal, current.heapTotal)
  peak.heapUsed = Math.max(peak.heapUsed, current.heapUsed)
  peak.external = Math.max(peak.external, current.external)
  peak.arrayBuffers = Math.max(peak.arrayBuffers, current.arrayBuffers)
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

function formatBytes(value: number): string {
  const mb = value / (1024 * 1024)
  return `${mb.toFixed(2)}MB`
}

function createStreamForScenario(
  scenario: Scenario,
  onDataBytes: (len: number) => void,
): ReturnType<typeof NativeSpanFeed.create> {
  const stream = NativeSpanFeed.create({
    chunkSize: scenario.chunkSize,
    initialChunks: scenario.initialChunks,
    autoCommitOnFull: scenario.autoCommitOnFull,
  })

  if (writeStdout) {
    stream.onData((data) => {
      process.stdout.write(data)
    })
  }

  stream.onData((data) => {
    onDataBytes(data.byteLength)
  })

  return stream
}

type BaseScenario = Omit<Scenario, "producerAPI">

function withAPIs(bases: BaseScenario[]): Scenario[] {
  const out: Scenario[] = []
  for (const base of bases) {
    out.push({ ...base, producerAPI: "reserve" })
    out.push({ ...base, name: `write/${base.name}`, producerAPI: "write" })
  }
  return out
}

function makeScenarios(baseIters: number, reuse: boolean): Scenario[] {
  const quick: BaseScenario[] = [
    {
      name: "ansi_64k",
      bytes: kb(64),
      iters: Math.max(20000, baseIters),
      chunkSize: 64 * 1024,
      initialChunks: 2,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "ansi", size: patternSizeSmall },
      reuseStream: reuse,
    },
    {
      name: "ascii_64k",
      bytes: kb(64),
      iters: Math.max(20000, baseIters),
      chunkSize: 64 * 1024,
      initialChunks: 2,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "ascii", size: patternSizeSmall },
      reuseStream: reuse,
    },
    {
      name: "binary_64k",
      bytes: kb(64),
      iters: Math.max(20000, baseIters),
      chunkSize: 64 * 1024,
      initialChunks: 2,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "binary", size: patternSizeSmall },
      reuseStream: reuse,
    },
    {
      name: "random_64k",
      bytes: kb(64),
      iters: Math.max(20000, baseIters),
      chunkSize: 64 * 1024,
      initialChunks: 2,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "random", size: patternSizeSmall },
      reuseStream: reuse,
    },
  ]

  const defaultBase: BaseScenario[] = [
    ...quick,
    {
      name: "medium_1mb",
      bytes: mb(1),
      iters: Math.max(500, Math.floor(baseIters / 10)),
      chunkSize: 64 * 1024,
      initialChunks: 2,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "ascii", size: patternSizeMedium },
      reuseStream: reuse,
    },
    {
      name: "binary_1mb",
      bytes: mb(1),
      iters: Math.max(500, Math.floor(baseIters / 10)),
      chunkSize: 64 * 1024,
      initialChunks: 2,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "binary", size: patternSizeMedium },
      reuseStream: reuse,
    },
    {
      name: "random_1mb",
      bytes: mb(1),
      iters: Math.max(500, Math.floor(baseIters / 10)),
      chunkSize: 64 * 1024,
      initialChunks: 2,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "random", size: patternSizeMedium },
      reuseStream: reuse,
    },
    {
      name: "commit_4k",
      bytes: kb(256),
      iters: baseIters,
      chunkSize: 64 * 1024,
      initialChunks: 2,
      autoCommitOnFull: false,
      commitEvery: 4096,
      pattern: { type: "ascii", size: patternSizeMedium },
      reuseStream: reuse,
    },
    {
      name: "large_32mb",
      bytes: mb(32),
      iters: Math.max(100, Math.floor(baseIters / 50)),
      chunkSize: 1024 * 1024,
      initialChunks: 2,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "ascii", size: patternSizeLarge },
      reuseStream: reuse,
    },
    {
      name: "binary_32mb",
      bytes: mb(32),
      iters: Math.max(100, Math.floor(baseIters / 50)),
      chunkSize: 1024 * 1024,
      initialChunks: 2,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "binary", size: patternSizeLarge },
      reuseStream: reuse,
    },
    {
      name: "random_32mb",
      bytes: mb(32),
      iters: Math.max(100, Math.floor(baseIters / 50)),
      chunkSize: 1024 * 1024,
      initialChunks: 2,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "random", size: patternSizeLarge },
      reuseStream: reuse,
    },
    {
      name: "single_chunk_32mb",
      bytes: mb(32),
      iters: Math.max(100, Math.floor(baseIters / 100)),
      chunkSize: 32 * 1024 * 1024,
      initialChunks: 1,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "ascii", size: patternSizeLarge },
      reuseStream: reuse,
    },
    {
      name: "huge_chunk_8mb",
      bytes: mb(64),
      iters: Math.max(100, Math.floor(baseIters / 200)),
      chunkSize: 8 * 1024 * 1024,
      initialChunks: 1,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "ascii", size: patternSizeLarge },
      reuseStream: reuse,
    },
  ]

  const largeBase: BaseScenario[] = [
    ...defaultBase,
    {
      name: "very_large_128mb",
      bytes: mb(128),
      iters: Math.max(100, Math.floor(baseIters / 500)),
      chunkSize: 8 * 1024 * 1024,
      initialChunks: 1,
      autoCommitOnFull: true,
      commitEvery: 0,
      pattern: { type: "ascii", size: patternSizeLarge },
      reuseStream: reuse,
    },
  ]

  if (suiteName === "quick") return withAPIs(quick)
  if (suiteName === "large") return withAPIs(largeBase)
  if (suiteName === "all") return withAPIs(largeBase)
  return withAPIs(defaultBase)
}

function buildPatternSpec(): PatternSpec | undefined {
  if (patternTypeArg) {
    const size = patternSizeArg ? Number(patternSizeArg) : undefined
    if (patternTypeArg === "ansi") return { type: "ansi", size }
    if (patternTypeArg === "ascii") return { type: "ascii", size }
    if (patternTypeArg === "binary") return { type: "binary", size }
    if (patternTypeArg === "random") return { type: "random", size }
  }
  if (patternArg) {
    const size = patternSizeArg ? Number(patternSizeArg) : undefined
    return { type: "string", value: patternArg, size }
  }
  return undefined
}

function runScenario(scenario: Scenario): ScenarioResult {
  let received = 0n
  const memSamples: MemorySample[] = []
  const memStart = memEnabled ? readMemory() : null
  const memPeak = memStart ? { ...memStart } : null
  const onDataBytes = (len: number) => {
    received += BigInt(len)
  }
  let stream: ReturnType<typeof NativeSpanFeed.create> | null = scenario.reuseStream
    ? createStreamForScenario(scenario, onDataBytes)
    : null
  const pattern = buildPattern(scenario.pattern)
  const patternPtr = pattern ?? null
  const patternLen = pattern ? BigInt(pattern.byteLength) : 0n
  const durations: number[] = []
  let totalElapsed = 0

  for (let i = 0; i < scenario.iters; i += 1) {
    if (!stream) stream = createStreamForScenario(scenario, onDataBytes)
    const before = received
    const start = performance.now()
    const produceFn =
      scenario.producerAPI === "write" ? benchLib.symbols.benchProduceWrite : benchLib.symbols.benchProduce
    const status = produceFn(stream.streamPtr, scenario.bytes, patternPtr, patternLen, scenario.commitEvery)
    const elapsedMs = performance.now() - start
    totalElapsed += elapsedMs
    durations.push(elapsedMs)

    if (status !== 0) {
      console.error(
        `${scenario.producerAPI === "write" ? "benchProduceWrite" : "benchProduce"} failed: ${status} scenario=${scenario.name}`,
      )
      process.exit(1)
    }

    const produced = received - before
    if (produced !== scenario.bytes) {
      console.error(`unexpected byte count scenario=${scenario.name} got=${produced} expected=${scenario.bytes}`)
    }

    if (!scenario.reuseStream && stream) {
      stream.close()
      stream = null
    }

    if (memEnabled && memSampleEvery > 0 && i % memSampleEvery === 0) {
      const sample = readMemory()
      memSamples.push(sample)
      if (memPeak) updatePeak(sample, memPeak)
    }
  }

  if (stream) stream.close()

  const memEnd = memEnabled ? readMemory() : null
  if (memEnd && memPeak) updatePeak(memEnd, memPeak)

  const sorted = [...durations].sort((a, b) => a - b)
  const count = durations.length
  const avg = count > 0 ? totalElapsed / count : 0
  const median = count > 0 ? (sorted[Math.floor(count / 2)] ?? 0) : 0
  const p95 = count > 0 ? (sorted[Math.floor(count * 0.95)] ?? 0) : 0
  const min = count > 0 ? (sorted[0] ?? 0) : 0
  const max = count > 0 ? (sorted[count - 1] ?? 0) : 0

  const totalSeconds = totalElapsed / 1000
  const totalBytesAll = received
  const totalMb = Number(totalBytesAll) / (1024 * 1024)
  const mbps = totalSeconds > 0 ? totalMb / totalSeconds : 0

  let memSummary = ""
  if (memStart && memEnd && memPeak) {
    const delta = diffMemory(memStart, memEnd)
    memSummary =
      ` memDeltaRss=${formatBytes(delta.rss)}` +
      ` memDeltaHeap=${formatBytes(delta.heapUsed)}` +
      ` memDeltaExt=${formatBytes(delta.external)}` +
      ` memDeltaAB=${formatBytes(delta.arrayBuffers)}` +
      ` memPeakRss=${formatBytes(memPeak.rss)}`
  }

  console.log(
    `scenario=${scenario.name} api=${scenario.producerAPI} iters=${scenario.iters} bytesPerIter=${scenario.bytes} bytesTotal=${totalBytesAll} avgMs=${avg.toFixed(3)} medianMs=${median.toFixed(3)} p95Ms=${p95.toFixed(3)} minMs=${min.toFixed(3)} maxMs=${max.toFixed(3)} throughputMBps=${mbps.toFixed(2)}${memSummary}`,
  )

  return {
    name: scenario.name,
    producerAPI: scenario.producerAPI,
    bytesPerIter: scenario.bytes,
    iters: scenario.iters,
    bytesTotal: totalBytesAll,
    avgMs: Number(avg.toFixed(6)),
    medianMs: Number(median.toFixed(6)),
    p95Ms: Number(p95.toFixed(6)),
    minMs: Number(min.toFixed(6)),
    maxMs: Number(max.toFixed(6)),
    throughputMBps: Number(mbps.toFixed(6)),
    elapsedMs: Number(totalElapsed.toFixed(6)),
    memory:
      memStart && memEnd && memPeak
        ? {
            start: memStart,
            end: memEnd,
            delta: diffMemory(memStart, memEnd),
            peak: memPeak,
            samples: memSamples.length,
          }
        : undefined,
    options: {
      chunkSize: scenario.chunkSize,
      initialChunks: scenario.initialChunks,
      autoCommitOnFull: scenario.autoCommitOnFull,
      commitEvery: scenario.commitEvery,
      reuseStream: scenario.reuseStream,
      pattern: scenario.pattern,
    },
  }
}

function createSingleScenario(): Scenario {
  const apiArg = getArg("api")
  return {
    name: "custom",
    bytes: totalBytes,
    iters: iterations,
    chunkSize,
    initialChunks,
    autoCommitOnFull,
    commitEvery,
    pattern: buildPatternSpec(),
    reuseStream,
    producerAPI: apiArg === "write" ? "write" : "reserve",
  }
}

const results: ScenarioResult[] = []
const runId = new Date().toISOString()

if (suiteName) {
  const scenarios = makeScenarios(suiteIterations, reuseStream)
  for (const scenario of scenarios) {
    results.push(runScenario(scenario))
  }
} else {
  results.push(runScenario(createSingleScenario()))
}

if (jsonPath) {
  const payload = {
    runId,
    suite: suiteName ?? "custom",
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
}
