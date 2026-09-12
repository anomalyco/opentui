import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { requireNode26 } from "../../../scripts/node26.mjs"

const benchmarkArguments = process.argv.slice(2)
if (benchmarkArguments.length !== 1 || benchmarkArguments[0] !== "--format=json") {
  process.stderr.write("usage: bench:js --format=json\n")
  process.exit(2)
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outputDirectory = resolve(packageRoot, ".node-benchmark")
const benchmarkEntry = resolve(outputDirectory, "js-benchmark.js")
const nodePath = requireNode26()

rmSync(outputDirectory, { recursive: true, force: true })
mkdirSync(outputDirectory, { recursive: true })

try {
  if (process.env.OTUI_BENCH_NATIVE_PREPARED !== "1") runBuild("bun", ["run", "build:native"])
  runBuild("bun", [
    "build",
    "src/benchmark/js-benchmark.ts",
    "--target=node",
    "--format=esm",
    "--outfile",
    benchmarkEntry,
    "--external",
    "@opentui/core-*",
  ])
  writeFileSync(resolve(outputDirectory, "package.json"), JSON.stringify({ type: "module" }))
  const benchmark = spawnSync(
    nodePath,
    ["--experimental-ffi", "--no-warnings", benchmarkEntry, ...benchmarkArguments],
    { cwd: packageRoot, stdio: "inherit" },
  )
  if (benchmark.error) throw benchmark.error
  process.exitCode = benchmark.status ?? 1
} finally {
  rmSync(outputDirectory, { recursive: true, force: true })
}

function runBuild(command: string, args: string[]): void {
  const child = spawnSync(command, args, { cwd: packageRoot, encoding: "utf8" })
  if (child.stdout) process.stderr.write(child.stdout)
  if (child.stderr) process.stderr.write(child.stderr)
  if (child.error) throw child.error
  if (child.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with status ${child.status ?? "unknown"}`)
}
