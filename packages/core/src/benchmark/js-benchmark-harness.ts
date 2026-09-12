import { createHash } from "node:crypto"

export interface MeasurementProtocol {
  target_batch_ms: number
  warmup_batches: number
  measured_batches: number
  max_rsd_ppm: number
}

export interface BenchmarkIdentity {
  category: string
  name: string
  workload_version: number
  parameters: Record<string, string | number | boolean>
}

export interface BenchmarkRuntime {
  run(iteration: number): void
  validateBatch(iterations: number): void
  teardown(): void | Promise<void>
}

export interface BenchmarkCase extends BenchmarkIdentity {
  setup(): BenchmarkRuntime | Promise<BenchmarkRuntime>
}

export interface BenchmarkResult {
  category: string
  name: string
  batch_iterations: number
  batch_elapsed_ns: number[]
  inner_rsd_ppm: number
}

export interface BenchmarkManifest {
  protocol_version: number
  measurement: MeasurementProtocol & {
    min_batch_iterations: number
    max_batch_iterations: number
    max_case_ns: number
    max_process_ns: number
  }
  cases: BenchmarkIdentity[]
}

export interface HarnessOptions {
  protocolVersion: number
  measurement: MeasurementProtocol
  clock?: () => number
  minBatchIterations: number
  maxBatchIterations: number
  maxCaseNs: number
  maxProcessNs: number
}

interface MonotonicClockRuntime {
  bunNanoseconds?: () => number
  nodeNanoseconds(): bigint
}

export function createMonotonicClock(
  runtime: MonotonicClockRuntime = {
    bunNanoseconds: typeof process.versions.bun === "string" ? Bun.nanoseconds : undefined,
    nodeNanoseconds: process.hrtime.bigint,
  },
): () => number {
  if (runtime.bunNanoseconds) return runtime.bunNanoseconds

  const origin = runtime.nodeNanoseconds()
  return () => Number(runtime.nodeNanoseconds() - origin)
}

export function calculateInnerRsdPpm(values: readonly number[]): number {
  if (values.length < 2) throw new Error("RSD requires at least two measured batches")
  for (const value of values) assertPositiveFinite(value, "batch ns/op")

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  const ppm = Math.round((Math.sqrt(variance) / Math.abs(mean)) * 1_000_000)
  assertSafeNonNegativeInteger(ppm, "inner RSD ppm")
  return ppm
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot contain a non-finite number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`
  }
  throw new Error(`unsupported canonical JSON value: ${typeof value}`)
}

export function manifestHash(manifest: BenchmarkManifest): string {
  return `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`
}

export function createManifest(cases: readonly BenchmarkCase[], options: HarnessOptions): BenchmarkManifest {
  validateOptions(options)
  const identities = cases.map(({ category, name, workload_version, parameters }) => ({
    category,
    name,
    workload_version,
    parameters,
  }))
  const seen = new Set<string>()
  for (const identity of identities) {
    if (!identity.category || !identity.name) throw new Error("benchmark identity must be non-empty")
    if (!Number.isSafeInteger(identity.workload_version) || identity.workload_version <= 0) {
      throw new Error(`${identity.category}/${identity.name}: invalid workload version`)
    }
    const key = `${identity.category}\0${identity.name}`
    if (seen.has(key)) throw new Error(`duplicate benchmark identity: ${identity.category}/${identity.name}`)
    seen.add(key)
  }
  return {
    protocol_version: options.protocolVersion,
    measurement: {
      ...options.measurement,
      min_batch_iterations: options.minBatchIterations,
      max_batch_iterations: options.maxBatchIterations,
      max_case_ns: options.maxCaseNs,
      max_process_ns: options.maxProcessNs,
    },
    cases: identities,
  }
}

export async function runBenchmarks(
  cases: readonly BenchmarkCase[],
  options: HarnessOptions,
): Promise<{ manifest: BenchmarkManifest; results: BenchmarkResult[] }> {
  const clock = options.clock ?? createMonotonicClock()
  const processStartedAt = clock()
  const manifest = createManifest(cases, options)
  const results: BenchmarkResult[] = []

  const checkProcessDuration = () => {
    if (remainingDuration(clock(), processStartedAt, manifest.measurement.max_process_ns, "process") < 0) {
      throw new Error("maximum benchmark process duration exceeded")
    }
  }

  for (const benchmark of cases) {
    checkProcessDuration()
    const caseStartedAt = clock()
    let runtime: BenchmarkRuntime | undefined
    let iteration = 0
    const checkDurations = () => {
      if (remainingDuration(clock(), caseStartedAt, manifest.measurement.max_case_ns, benchmark.name) < 0) {
        throw new Error(`${benchmark.name}: maximum case duration exceeded`)
      }
      checkProcessDuration()
    }
    try {
      runtime = await awaitLifecycle(benchmark.setup(), clock, caseStartedAt, processStartedAt, benchmark.name, options)
      checkDurations()
      const runBatch = (iterations: number): number => {
        assertSafePositiveInteger(iterations, "batch iterations")
        const start = clock()
        for (let index = 0; index < iterations; index++) runtime!.run(iteration++)
        const elapsed = clock() - start
        assertSafePositiveInteger(elapsed, `${benchmark.name} elapsed nanoseconds`)
        runtime!.validateBatch(iterations)
        checkDurations()
        return elapsed
      }

      // One untimed operation proves the workload and validator before calibration.
      runBatch(1)
      const batchIterations = calibrate(runBatch, options)
      for (let index = 0; index < options.measurement.warmup_batches; index++) runBatch(batchIterations)

      const elapsedNs: number[] = []
      for (let index = 0; index < options.measurement.measured_batches; index++) {
        elapsedNs.push(runBatch(batchIterations))
      }
      const nsPerOperation = elapsedNs.map((elapsed) => elapsed / batchIterations)
      const innerRsdPpm = calculateInnerRsdPpm(nsPerOperation)
      if (innerRsdPpm > options.measurement.max_rsd_ppm) {
        throw new Error(
          `${benchmark.category}/${benchmark.name}: inner RSD ${innerRsdPpm} ppm exceeds ${options.measurement.max_rsd_ppm} ppm`,
        )
      }
      results.push({
        category: benchmark.category,
        name: benchmark.name,
        batch_iterations: batchIterations,
        batch_elapsed_ns: elapsedNs,
        inner_rsd_ppm: innerRsdPpm,
      })
    } finally {
      if (runtime) {
        await awaitLifecycle(runtime.teardown(), clock, caseStartedAt, processStartedAt, benchmark.name, options)
      }
      checkDurations()
    }
  }

  checkProcessDuration()
  validateManifestResults(manifest, results)
  return { manifest, results }
}

async function awaitLifecycle<T>(
  operation: T | Promise<T>,
  clock: () => number,
  caseStartedAt: number,
  processStartedAt: number,
  caseName: string,
  options: HarnessOptions,
): Promise<T> {
  if (!operation || typeof (operation as Promise<T>).then !== "function") return operation

  const now = clock()
  const caseRemaining = remainingDuration(now, caseStartedAt, options.maxCaseNs, caseName)
  const processRemaining = remainingDuration(now, processStartedAt, options.maxProcessNs, "process")
  const caseExpiresFirst = caseRemaining <= processRemaining
  const remainingNs = caseExpiresFirst ? caseRemaining : processRemaining
  const message = caseExpiresFirst
    ? `${caseName}: maximum case duration exceeded`
    : "maximum benchmark process duration exceeded"
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(0, Math.ceil(remainingNs / 1_000_000)))
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function remainingDuration(now: number, startedAt: number, maximum: number, label: string): number {
  const elapsed = now - startedAt
  assertSafeNonNegativeInteger(elapsed, `${label} wall-clock elapsed nanoseconds`)
  return maximum - elapsed
}

export function validateManifestResults(
  manifest: BenchmarkManifest,
  results: readonly Pick<BenchmarkResult, "category" | "name">[],
): void {
  if (results.length !== manifest.cases.length) throw new Error("manifest/result count mismatch")
  for (let index = 0; index < results.length; index++) {
    const identity = manifest.cases[index]!
    const result = results[index]!
    if (result.category !== identity.category || result.name !== identity.name) {
      throw new Error(`manifest/result identity mismatch at index ${index}`)
    }
  }
}

function calibrate(runBatch: (iterations: number) => number, options: HarnessOptions): number {
  const targetNs = options.measurement.target_batch_ms * 1_000_000
  const minimum = options.minBatchIterations
  const maximum = options.maxBatchIterations
  let iterations = minimum

  for (;;) {
    const elapsed = runBatch(iterations)
    if (elapsed >= targetNs || iterations === maximum) return iterations
    const scale = Math.max(2, Math.min(10, Math.ceil(targetNs / elapsed)))
    if (iterations > Math.floor(maximum / scale)) {
      iterations = maximum
    } else {
      iterations *= scale
    }
    assertSafePositiveInteger(iterations, "calibrated batch iterations")
  }
}

function validateOptions(options: HarnessOptions): void {
  assertSafePositiveInteger(options.protocolVersion, "protocol version")
  assertPositiveFinite(options.measurement.target_batch_ms, "target batch milliseconds")
  assertSafePositiveInteger(options.measurement.warmup_batches, "warmup batches")
  if (!Number.isSafeInteger(options.measurement.measured_batches) || options.measurement.measured_batches < 2) {
    throw new Error("measured batches must be an integer of at least two")
  }
  assertSafeNonNegativeInteger(options.measurement.max_rsd_ppm, "maximum RSD ppm")
  const minimum = options.minBatchIterations
  const maximum = options.maxBatchIterations
  assertSafePositiveInteger(minimum, "minimum batch iterations")
  assertSafePositiveInteger(maximum, "maximum batch iterations")
  if (minimum > maximum) throw new Error("minimum batch iterations exceeds maximum")
  assertSafePositiveInteger(options.maxCaseNs, "maximum case nanoseconds")
  assertSafePositiveInteger(options.maxProcessNs, "maximum process nanoseconds")
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive and finite`)
}

function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`)
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
}
