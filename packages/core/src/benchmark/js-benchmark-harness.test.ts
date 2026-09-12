import { describe, expect, test } from "bun:test"

import { OptimizedBuffer } from "../buffer.js"
import { defaultBenchmarkCases } from "./js-benchmark-cases.js"
import {
  calculateInnerRsdPpm,
  canonicalJson,
  createMonotonicClock,
  createManifest,
  manifestHash,
  runBenchmarks,
  validateManifestResults,
  type BenchmarkCase,
  type BenchmarkRuntime,
  type HarnessOptions,
} from "./js-benchmark-harness.js"
import { PROTOCOL, runBenchmarkCli } from "./js-benchmark.js"

const options: HarnessOptions = {
  protocolVersion: 1,
  measurement: { target_batch_ms: 0.000001, warmup_batches: 1, measured_batches: 2, max_rsd_ppm: 1_000_000 },
  minBatchIterations: 1,
  maxBatchIterations: 4,
  maxCaseNs: 15_000_000_000,
  maxProcessNs: 60_000_000_000,
}

function fakeCase(
  runtimeOverrides: Partial<BenchmarkRuntime> = {},
  caseOverrides: Partial<BenchmarkCase> = {},
): BenchmarkCase {
  let completed = 0
  let validated = 0
  return {
    category: "Test",
    name: "case",
    workload_version: 1,
    parameters: { size: 1 },
    setup() {
      return {
        run() {
          completed++
        },
        validateBatch(iterations) {
          if (completed - validated !== iterations) throw new Error("incorrect validated operation count")
          validated = completed
        },
        teardown() {},
        ...runtimeOverrides,
      }
    },
    ...caseOverrides,
  }
}

describe("statistics and manifest", () => {
  test("uses sample standard deviation and integer ppm rounding", () => {
    expect(calculateInnerRsdPpm([10, 10])).toBe(0)
    expect(calculateInnerRsdPpm([1, 2])).toBe(471_405)
  })

  test("canonicalizes and hashes the complete ordered benchmark identity", () => {
    const manifest = createManifest(defaultBenchmarkCases, PROTOCOL)
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}')
    expect(manifest.cases.map(({ category, name }) => `${category}/${name}`)).toEqual([
      "JS Layout/leaf-width-calculate",
      "JS Render/yoga-layout-reads-100",
      "JS Mouse/direct-bubble-depth-8",
      "JS Mouse/stdin-sgr-bubble-depth-8",
      "JS Text Table/proportional-column-widths",
      "JS Text/text-buffer-word-wrap-measure",
      "JS Buffer/draw-box-titled-scissored",
    ])
    expect(manifestHash(manifest)).toBe("sha256:eadd082d755c58b7e8a865bd5873802974881967a4edab1c79d0fb1cba482aa0")
    expect(manifestHash({ ...manifest, protocol_version: 2 })).not.toBe(manifestHash(manifest))
  })

  test("rejects duplicate identities and missing or reordered results", () => {
    expect(() => createManifest([fakeCase(), fakeCase()], options)).toThrow("duplicate benchmark identity")
    const cases = [fakeCase({}, { name: "first" }), fakeCase({}, { name: "second" })]
    const manifest = createManifest(cases, options)
    expect(() => validateManifestResults(manifest, [])).toThrow("manifest/result count mismatch")
    expect(() => validateManifestResults(manifest, [cases[1]!, cases[0]!])).toThrow(
      "manifest/result identity mismatch at index 0",
    )
  })
})

describe("runner", () => {
  test("uses Bun nanoseconds unchanged and an origin-relative Node clock", () => {
    const bunClock = () => 123
    expect(createMonotonicClock({ bunNanoseconds: bunClock, nodeNanoseconds: () => 999n })).toBe(bunClock)

    const readings = [9_000_000_000_000_000n, 9_000_000_000_000_007n]
    const nodeClock = createMonotonicClock({ nodeNanoseconds: () => readings.shift()! })
    expect(nodeClock()).toBe(7)
  })

  test("times run synchronously while awaiting setup and teardown", async () => {
    let now = 0
    let thenCalls = 0
    let validations = 0
    let teardown = false
    const benchmark = fakeCase(
      {},
      {
        async setup() {
          await Promise.resolve()
          return {
            run() {
              now++
              return { then: () => thenCalls++ }
            },
            validateBatch() {
              expect(thenCalls).toBe(0)
              validations++
            },
            async teardown() {
              await Promise.resolve()
              teardown = true
            },
          }
        },
      },
    )

    await runBenchmarks([benchmark], { ...options, clock: () => now, maxBatchIterations: 1 })

    expect(thenCalls).toBe(0)
    expect(validations).toBe(5)
    expect(teardown).toBe(true)
  })

  test("calibrates to the target without exceeding the iteration bound", async () => {
    for (const [targetNs, expectedIterations] of [
      [2, 2],
      [100, 4],
    ] as const) {
      let now = 0
      let validations = 0
      const benchmark = fakeCase({
        run() {
          now++
        },
        validateBatch() {
          validations++
        },
      })
      const output = await runBenchmarks([benchmark], {
        ...options,
        clock: () => now,
        measurement: { ...options.measurement, target_batch_ms: targetNs / 1_000_000 },
      })

      expect(output.results[0]!.batch_iterations).toBe(expectedIterations)
      expect(validations).toBe(6)
    }
  })

  test("rejects non-positive and unsafe elapsed times", async () => {
    await expect(runBenchmarks([fakeCase()], { ...options, clock: () => 0 })).rejects.toThrow(
      "must be a positive safe integer",
    )

    let now = 0
    const overflow = fakeCase({
      run() {
        now = Number.MAX_SAFE_INTEGER + 1
      },
    })
    await expect(runBenchmarks([overflow], { ...options, clock: () => now })).rejects.toThrow("safe integer")
  })

  test("rejects measured batches over the RSD limit", async () => {
    let now = 0
    const elapsed = [1, 1, 1, 10, 20]
    const benchmark = fakeCase({
      run(iteration) {
        now += elapsed[iteration]!
      },
      validateBatch() {},
    })

    await expect(
      runBenchmarks([benchmark], {
        ...options,
        clock: () => now,
        maxBatchIterations: 1,
        measurement: { ...options.measurement, max_rsd_ppm: 1 },
      }),
    ).rejects.toThrow("inner RSD")
  })

  test("validates after each batch and tears down after validation failure", async () => {
    let now = 0
    let teardown = 0
    const benchmark = fakeCase({
      run() {
        now++
      },
      validateBatch() {
        throw new Error("work was not observed")
      },
      teardown() {
        teardown++
      },
    })

    await expect(runBenchmarks([benchmark], { ...options, clock: () => now })).rejects.toThrow("work was not observed")
    expect(teardown).toBe(1)
  })

  test("tears down when setup completes after the case deadline", async () => {
    let now = 0
    let teardown = 0
    const benchmark = fakeCase(
      {},
      {
        setup() {
          now = 6
          return { run() {}, validateBatch() {}, teardown: () => teardown++ }
        },
      },
    )

    await expect(runBenchmarks([benchmark], { ...options, clock: () => now, maxCaseNs: 5 })).rejects.toThrow(
      "maximum case duration exceeded",
    )
    expect(teardown).toBe(1)
  })

  test("applies the case duration through validation and teardown", async () => {
    let now = 0
    let teardown = 0
    const benchmark = fakeCase({
      run() {
        now++
      },
      validateBatch() {
        now = 10
      },
      teardown() {
        teardown++
      },
    })

    await expect(runBenchmarks([benchmark], { ...options, clock: () => now, maxCaseNs: 5 })).rejects.toThrow(
      "maximum case duration exceeded",
    )
    expect(teardown).toBe(1)
  })

  test("bounds hanging setup by the remaining process duration", async () => {
    let elapsedBeforeHang = 0
    const benchmark = fakeCase(
      {},
      {
        setup() {
          elapsedBeforeHang = 4_000_000
          return new Promise<BenchmarkRuntime>(() => {})
        },
      },
    )

    await expect(
      runBenchmarks([benchmark], {
        ...options,
        clock: () => Bun.nanoseconds() + elapsedBeforeHang,
        maxCaseNs: 100_000_000,
        maxProcessNs: 5_000_000,
      }),
    ).rejects.toThrow("maximum benchmark process duration exceeded")
  })

  test("bounds hanging teardown by the remaining case duration", async () => {
    let elapsedBeforeHang = 0
    let teardownAttempted = false
    const benchmark = fakeCase({
      validateBatch() {
        throw new Error("validation failed")
      },
      teardown() {
        teardownAttempted = true
        elapsedBeforeHang = 4_000_000
        return new Promise<void>(() => {})
      },
    })

    await expect(
      runBenchmarks([benchmark], {
        ...options,
        clock: () => Bun.nanoseconds() + elapsedBeforeHang,
        maxCaseNs: 5_000_000,
        maxProcessNs: 100_000_000,
      }),
    ).rejects.toThrow("maximum case duration exceeded")
    expect(teardownAttempted).toBe(true)
  })
})

test("canonical cases perform and validate work across consecutive batches", async () => {
  for (const benchmark of defaultBenchmarkCases) {
    const runtime = await benchmark.setup()
    let iteration = 0
    try {
      for (const batch of [2, 1]) {
        for (let index = 0; index < batch; index++) runtime.run(iteration++)
        runtime.validateBatch(batch)
      }
    } finally {
      await runtime.teardown()
    }
  }
})

test("canonical box drawing validation rejects a no-op", async () => {
  const benchmark = defaultBenchmarkCases.find(({ name }) => name === "draw-box-titled-scissored")!
  const runtime = await benchmark.setup()
  const drawBox = OptimizedBuffer.prototype.drawBox
  OptimizedBuffer.prototype.drawBox = () => {}
  try {
    runtime.run(0)
    expect(() => runtime.validateBatch(1)).toThrow("draw-box-titled-scissored: observation")
  } finally {
    OptimizedBuffer.prototype.drawBox = drawBox
    await runtime.teardown()
  }
})

class MemoryWriter {
  text = ""
  write(data: string) {
    this.text += data
  }
  flush() {}
}

const memoryWriters = () => ({ stdout: new MemoryWriter(), stderr: new MemoryWriter() })

describe("CLI", () => {
  test("accepts only --format=json and keeps usage off stdout", async () => {
    const { stdout, stderr } = memoryWriters()
    expect(await runBenchmarkCli(["--json"], { stdout, stderr, cases: [] })).toBe(2)
    expect(stdout.text).toBe("")
    expect(stderr.text).toContain("usage:")
  })

  test("emits no partial stdout when a later case fails", async () => {
    let now = 0
    const { stdout, stderr } = memoryWriters()
    const exitCode = await runBenchmarkCli(["--format=json"], {
      stdout,
      stderr,
      cases: [
        fakeCase({}, { name: "first" }),
        fakeCase(
          {},
          {
            name: "second",
            setup() {
              throw new Error("failed")
            },
          },
        ),
      ],
      options: { ...options, clock: () => now++, maxBatchIterations: 1 },
      jsRuntime: "bun",
      runtimeVersion: "test-bun",
      zigVersion: "test-zig",
    })

    expect(exitCode).toBe(1)
    expect(stdout.text).toBe("")
    expect(stderr.text).toContain("failed")
  })

  test("writes one JSON document with manifest and results in case order", async () => {
    let now = 0
    const { stdout, stderr } = memoryWriters()
    const exitCode = await runBenchmarkCli(["--format=json"], {
      stdout,
      stderr,
      cases: [fakeCase({}, { name: "first" }), fakeCase({}, { name: "second" })],
      options: { ...options, clock: () => now++, maxBatchIterations: 1 },
      jsRuntime: "node",
      runtimeVersion: "test-node",
      zigVersion: "test-zig",
    })

    expect(exitCode).toBe(0)
    expect(stderr.text).toBe("")
    expect(stdout.text.trim().split("\n")).toHaveLength(1)
    const document = JSON.parse(stdout.text)
    expect(document).toMatchObject({
      schema_version: 2,
      benchmark_suite: "core-default",
      protocol_version: 1,
      js_runtime: "node",
      runtime_version: "test-node",
      zig_version: "test-zig",
    })
    expect(document).not.toHaveProperty("bun_version")
    expect(document.manifest.cases.map(({ name }: BenchmarkCase) => name)).toEqual(["first", "second"])
    expect(document.results.map(({ name }: BenchmarkCase) => name)).toEqual(["first", "second"])
  })
})
