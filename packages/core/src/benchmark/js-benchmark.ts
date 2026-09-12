import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Writable } from "node:stream"
import { fileURLToPath } from "node:url"

import { defaultBenchmarkCases } from "./js-benchmark-cases.js"
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

  if (args.length !== 1 || args[0] !== "--format=json") {
    await diagnostic("usage: bench:js --format=json")
    return 2
  }

  try {
    const options = dependencies.options ?? PROTOCOL
    const { manifest, results } = await runBenchmarks(dependencies.cases ?? defaultBenchmarkCases, options)
    const runtime = dependencies.jsRuntime ?? detectRuntime()
    const document = {
      schema_version: 2,
      benchmark_suite: "core-default",
      protocol_version: options.protocolVersion,
      js_runtime: runtime,
      runtime_version: dependencies.runtimeVersion ?? readRuntimeVersion(runtime),
      zig_version: dependencies.zigVersion ?? readZigVersion(),
      manifest: { hash: manifestHash(manifest), ...manifest },
      results,
    }
    dependencies.stdout.write(`${JSON.stringify(document)}\n`)
    await dependencies.stdout.flush()
    return 0
  } catch (error) {
    await diagnostic(error instanceof Error ? error.message : String(error))
    return 1
  }
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
