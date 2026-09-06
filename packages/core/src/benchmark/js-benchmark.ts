import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Writable } from "node:stream"
import { fileURLToPath } from "node:url"

import { allBenchmarkCases, defaultBenchmarkCases } from "./js-benchmark-cases.js"
import { manifestHash, runBenchmarks, type BenchmarkCase, type HarnessOptions } from "./js-benchmark-harness.js"

export const PROTOCOL: HarnessOptions = {
  protocolVersion: 1,
  measurement: {
    target_batch_ms: 200,
    warmup_batches: 5,
    measured_batches: 20,
    max_rsd_ppm: 50_000,
  },
  minBatchIterations: 1,
  maxBatchIterations: 1_000_000_000,
  maxCaseNs: 15_000_000_000,
  maxProcessNs: 75_000_000_000,
}

interface OutputWriter {
  write(data: string): unknown
  flush(): unknown
}

interface CliDependencies {
  cases?: readonly BenchmarkCase[]
  options?: HarnessOptions
  stdout: OutputWriter
  stderr: OutputWriter
  jsRuntime?: "bun" | "node"
  runtimeVersion?: string
  zigVersion?: string
}

export async function runBenchmarkCli(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const diagnostic = async (message: string) => {
    dependencies.stderr.write(`${message}\n`)
    await dependencies.stderr.flush()
  }

  const formatJson = args.includes("--format=json")
  const caseArguments = args.filter((arg) => arg.startsWith("--case="))
  const unknown = args.filter((arg) => arg !== "--format=json" && !arg.startsWith("--case="))
  if (
    args.filter((arg) => arg === "--format=json").length > 1 ||
    caseArguments.length > 1 ||
    unknown.length > 0 ||
    (!formatJson && caseArguments.length === 0)
  ) {
    await diagnostic("usage: bench:js [--format=json] [--case=<name>]")
    return 2
  }

  try {
    const options = dependencies.options ?? PROTOCOL
    const caseName = caseArguments[0]?.slice("--case=".length)
    if (caseName === "") throw new Error("unknown benchmark case: ")
    const available = dependencies.cases ?? (caseName ? allBenchmarkCases : defaultBenchmarkCases)
    const cases = caseName ? available.filter((benchmark) => benchmark.name === caseName) : available
    if (caseName && cases.length === 0) throw new Error(`unknown benchmark case: ${caseName}`)
    const { manifest, results } = await runBenchmarks(cases, options)
    const runtime = dependencies.jsRuntime ?? detectRuntime()
    const document = {
      schema_version: 2,
      benchmark_suite: caseName ? "core-case" : "core-default",
      protocol_version: options.protocolVersion,
      js_runtime: runtime,
      runtime_version: dependencies.runtimeVersion ?? readRuntimeVersion(runtime),
      zig_version: dependencies.zigVersion ?? readZigVersion(),
      manifest: { hash: manifestHash(manifest), ...manifest },
      results,
    }
    dependencies.stdout.write(formatJson ? `${JSON.stringify(document)}\n` : formatResult(document.results[0]!))
    await dependencies.stdout.flush()
    return 0
  } catch (error) {
    await diagnostic(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function formatResult(result: {
  category: string
  name: string
  batch_iterations: number
  batch_elapsed_ns: number[]
}) {
  const samples = result.batch_elapsed_ns
    .map((elapsed) => elapsed / result.batch_iterations / 1_000_000)
    .sort((a, b) => a - b)
  const middle = samples.length >> 1
  const median = samples.length % 2 === 0 ? (samples[middle - 1]! + samples[middle]!) / 2 : samples[middle]!
  return `${result.category}/${result.name}: ${median.toFixed(4)} ms/op\n`
}

function readZigVersion(): string {
  const sourceZigDirectory = fileURLToPath(new URL("../../../native", import.meta.url))
  const zigDirectory = existsSync(sourceZigDirectory) ? sourceZigDirectory : resolve("../native")
  const child = spawnSync("zig", ["version"], {
    cwd: zigDirectory,
    encoding: "utf8",
  })
  if (child.error) throw new Error(`zig version failed: ${child.error.message}`, { cause: child.error })
  if (child.status !== 0) throw new Error(`zig version failed: ${child.stderr.trim()}`)
  const version = child.stdout.trim()
  if (!version) throw new Error("zig version returned an empty version")
  return version
}

function detectRuntime(): "bun" | "node" {
  return typeof process.versions.bun === "string" ? "bun" : "node"
}

function readRuntimeVersion(runtime: "bun" | "node"): string {
  if (runtime === "bun") return process.versions.bun!
  return process.version.startsWith("v") ? process.version.slice(1) : process.version
}

function createOutputWriter(stream: Writable): OutputWriter {
  let pendingDrain: Promise<void> = Promise.resolve()
  return {
    write(data) {
      if (!stream.write(data)) pendingDrain = new Promise((resolve) => stream.once("drain", resolve))
    },
    flush() {
      return pendingDrain
    },
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  // Capture protocol streams before any benchmark initializes a renderer.
  const stdout = createOutputWriter(process.stdout)
  const stderr = createOutputWriter(process.stderr)
  process.exitCode = await runBenchmarkCli(process.argv.slice(2), { stdout, stderr })
}
