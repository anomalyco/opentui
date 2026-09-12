#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, cpus, loadavg, release, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isSupportedNode26Version } from "../../../../scripts/node26.mjs"
import { getNativeAssetDescriptor, type NodeAssetTarget } from "../node-asset-target.js"
import {
  analyzePairedObservations,
  createPairedSchedule,
  pairGapWithinTarget,
  pairedSampleQualityReasons,
  withinRegressionBudget,
  type PairedObservation,
  type PairedOrder,
  type PairedRuntime,
} from "./ffi-fast-path-paired-analysis.js"

type Role = "baseline" | "candidate"
type SuiteName = "quick" | "default" | "long"

interface ChildPayload {
  schemaVersion: number
  scenario: { name: string; operation: string; description: string }
  sample: {
    runtime: { name: PairedRuntime; version: string; platform: string; arch: string }
    targetMs: number
    warmupMs: number
    elapsedNs: number
    operations: number
    nsPerOp: number
    checksum: number
    startedAtEpochMs: number
    endedAtEpochMs: number
    cpuUserMicros: number
    cpuSystemMicros: number
    voluntaryContextSwitches: number
    involuntaryContextSwitches: number
    calibration: {
      selectedAttempt: number
      calibrationConverged: boolean
      withinTargetWindow: boolean
      warmupBatches: unknown[]
      measurementBatches: unknown[]
    }
  }
}

interface Target {
  role: Role
  root: string
  packageRoot: string
  childSource: string
  buildDir: string
  nodeScript: string
  revision: string
  dirty: boolean
  workingTree: WorkingTreeProvenance
  scenarioHash: string
  calibrationHash: string
  lockHash: string
  packageHash: string
  nativeArtifacts: Record<PairedRuntime, NativeArtifact>
}

interface NativeArtifact {
  path: string
  sha256: string
}

interface WorkingTreeProvenance {
  status: string
  trackedDiff: string
  trackedDiffSha256: string
  untrackedFiles: Array<{ path: string; sha256: string }>
}

type ProcessSample = ChildPayload["sample"] & {
  startedAt: string
  wallMs: number
  pair: number
  sequence: number
  position: "first" | "second"
}

interface RawPair {
  pair: number
  sequence: number
  attempt: number
  order: PairedOrder
  gapMs: number
  gapWithinTarget: boolean
  baseline: ProcessSample
  candidate: ProcessSample
}

interface PreparedChild {
  start(): Promise<ProcessSample>
  cancel(): Promise<void>
}

const SUITES: Record<SuiteName, { targetMs: number; warmupMs: number }> = {
  quick: { targetMs: 15, warmupMs: 10 },
  default: { targetMs: 75, warmupMs: 30 },
  long: { targetMs: 250, warmupMs: 75 },
}
const BOOTSTRAP_SAMPLES = 100_000
const pairedBenchmarkSource = fileURLToPath(import.meta.url)
const benchmarkDir = dirname(pairedBenchmarkSource)
const orchestratorRoot = resolve(benchmarkDir, "../../../..")
const nodePath = process.env.NODE26_PATH ?? "node"
const suite = stringArg("suite", "default") as SuiteName
if (!(suite in SUITES)) throw new Error(`invalid --suite=${suite}; expected quick, default, or long`)
const pairs = integerArg("runs", 10, 2)
if (pairs % 2 !== 0) throw new Error("--runs must be even so every unit has balanced AB/BA order")
const seed = integerArg("seed", 1284, 0)
const pairGapTargetMs = numberArg("pair-gap-target-ms", 10, 0)
const pairRetries = integerArg("pair-retries", 5, 0)
const outputPath = resolve(stringArg("json", "ffi-fast-path-paired.json"))
const quiet = process.argv.includes("--no-output")
const allowDirty = process.argv.includes("--allow-dirty")
const allowNativeDrift = process.argv.includes("--allow-native-drift")
const baselineRoot = requiredAbsoluteRoot("baseline-root")
const candidateRoot = requiredAbsoluteRoot("candidate-root")
if (realpathSync(baselineRoot) === realpathSync(candidateRoot)) {
  throw new Error("baseline and candidate roots must differ")
}
if (candidateRoot !== orchestratorRoot) {
  throw new Error(`paired benchmark must run from the candidate root (${orchestratorRoot})`)
}
if (process.env.OTUI_ASSET_ROOT) {
  throw new Error("unset OTUI_ASSET_ROOT so paired provenance matches the native packages being hashed")
}
const nodeRuntime = readNodeRuntime()
if (!isSupportedNode26Version(nodeRuntime.version)) {
  throw new Error(`Node v26.4.0 or later is required, got ${nodeRuntime.version}`)
}

const baseline = createTarget("baseline", baselineRoot)
const candidate = createTarget("candidate", candidateRoot)
if (baseline.scenarioHash !== candidate.scenarioHash) {
  throw new Error("baseline and candidate scenario sources differ; use identical measurement tooling")
}
if (baseline.calibrationHash !== candidate.calibrationHash) {
  throw new Error("baseline and candidate calibration sources differ; use identical measurement tooling")
}
if (!allowDirty && (baseline.dirty || candidate.dirty)) {
  throw new Error("paired benchmark requires clean worktrees; pass --allow-dirty to record and accept dirty inputs")
}
if (!allowNativeDrift) assertMatchingNativeArtifacts(baseline, candidate)

const baselineDefault = listScenarios(baseline, "--list-scenarios")
const candidateDefault = listScenarios(candidate, "--list-scenarios")
const baselineTargeted = listScenarios(baseline, "--list-targeted-scenarios")
const candidateTargeted = listScenarios(candidate, "--list-targeted-scenarios")
if (baselineDefault.join("\n") !== candidateDefault.join("\n")) throw new Error("default scenario catalogs differ")
const selectedNames = selectScenarios(
  optionalArg("scenario"),
  baselineDefault,
  candidateDefault,
  baselineTargeted,
  candidateTargeted,
)
const schedule = createPairedSchedule(selectedNames, ["bun", "node"], pairs, seed)
const raw = new Map<string, RawPair[]>()
const scenarioMetadata = new Map<string, ChildPayload["scenario"]>()
const rejectedPairAttempts: Array<{
  pair: number
  sequence: number
  attempt: number
  scenario: string
  runtime: PairedRuntime
  order: PairedOrder
  gapMs: number
  reasons: string[]
  baseline: ProcessSample
  candidate: ProcessSample
}> = []
const pairGapExceedances: Array<{
  pair: number
  sequence: number
  attempt: number
  scenario: string
  runtime: PairedRuntime
  order: PairedOrder
  gapMs: number
}> = []
for (const name of selectedNames) for (const runtime of ["bun", "node"]) raw.set(`${name}:${runtime}`, [])
const startedAt = new Date().toISOString()

try {
  buildNodeBenchmark(baseline)
  buildNodeBenchmark(candidate)

  for (const entry of schedule) {
    const order: [Target, Target] = entry.order === "baseline-first" ? [baseline, candidate] : [candidate, baseline]
    if (!quiet) {
      process.stdout.write(
        `pair=${entry.pair + 1}/${pairs} scenario=${entry.scenario} runtime=${entry.runtime}` +
          ` order=${entry.order}\r`,
      )
    }
    let accepted = false
    for (let attempt = 0; attempt <= pairRetries; attempt++) {
      const prepared = await Promise.allSettled([
        prepareChild(order[0], entry.runtime, entry.scenario, entry.pair, entry.sequence, "first"),
        prepareChild(order[1], entry.runtime, entry.scenario, entry.pair, entry.sequence, "second"),
      ])
      const firstPrepared = prepared[0]!
      const secondPrepared = prepared[1]!
      if (firstPrepared.status === "rejected") {
        if (secondPrepared.status === "fulfilled") await secondPrepared.value.cancel()
        throw firstPrepared.reason
      }
      if (secondPrepared.status === "rejected") {
        await firstPrepared.value.cancel()
        throw secondPrepared.reason
      }
      const first = firstPrepared.value
      const second = secondPrepared.value
      let firstSample: ProcessSample
      let secondSample: ProcessSample
      try {
        firstSample = await first.start()
        secondSample = await second.start()
      } catch (error) {
        await Promise.all([first.cancel(), second.cancel()])
        throw error
      }
      const gapMs = secondSample.startedAtEpochMs - firstSample.endedAtEpochMs
      const gapWithinTarget = pairGapWithinTarget(gapMs, pairGapTargetMs)
      const byRole = { [order[0].role]: firstSample, [order[1].role]: secondSample } as Record<Role, ProcessSample>
      if (!gapWithinTarget) {
        pairGapExceedances.push({
          pair: entry.pair,
          sequence: entry.sequence,
          attempt,
          scenario: entry.scenario,
          runtime: entry.runtime,
          order: entry.order,
          gapMs,
        })
      }
      const reasons = pairQualityReasons(byRole.baseline, byRole.candidate)
      if (reasons.length === 0) {
        raw.get(`${entry.scenario}:${entry.runtime}`)!.push({
          pair: entry.pair,
          sequence: entry.sequence,
          attempt,
          order: entry.order,
          gapMs,
          gapWithinTarget,
          baseline: byRole.baseline,
          candidate: byRole.candidate,
        })
        accepted = true
        break
      }
      rejectedPairAttempts.push({
        pair: entry.pair,
        sequence: entry.sequence,
        attempt,
        scenario: entry.scenario,
        runtime: entry.runtime,
        order: entry.order,
        gapMs,
        reasons,
        baseline: byRole.baseline,
        candidate: byRole.candidate,
      })
    }
    if (!accepted) {
      const attemptSummary = rejectedPairAttempts
        .filter((rejected) => rejected.sequence === entry.sequence)
        .map((rejected) => `attempt ${rejected.attempt + 1}: ${rejected.reasons.join(", ")}`)
        .join("; ")
      throw new Error(
        `pair quality failed after ${pairRetries + 1} attempts for ${entry.scenario} ${entry.runtime}: ${attemptSummary}`,
      )
    }
  }
} finally {
  rmSync(baseline.buildDir, { recursive: true, force: true })
  rmSync(candidate.buildDir, { recursive: true, force: true })
}

if (!quiet) process.stdout.write("\n")
const familywiseComparisons = selectedNames.length * 2
const familywiseConfidence = 1 - 0.05 / familywiseComparisons
const results = selectedNames.map((name) => {
  const metadata = scenarioMetadata.get(name)
  if (!metadata) throw new Error(`missing metadata for ${name}`)
  return {
    ...metadata,
    config: SUITES[suite],
    bun: analyzeRuntime(name, "bun", familywiseConfidence),
    node: analyzeRuntime(name, "node", familywiseConfidence),
    rawPairedProcessRounds: {
      bun: raw.get(`${name}:bun`),
      node: raw.get(`${name}:node`),
    },
  }
})
const payload = {
  schemaVersion: 1,
  benchmark: "opentui-ffi-fast-path-paired",
  runId: startedAt,
  startedAt,
  completedAt: new Date().toISOString(),
  suite,
  config: {
    pairs,
    scenarios: selectedNames.length,
    seed,
    bootstrapSamples: BOOTSTRAP_SAMPLES,
    nominalConfidence: 0.95,
    familywiseConfidence,
    familywiseComparisons,
    pairGapTargetMs,
    pairRetries,
    ...SUITES[suite],
  },
  tooling: {
    root: orchestratorRoot,
    revision: candidate.revision,
    dirty: candidate.dirty,
    sources: {
      pairedBenchmark: { path: pairedBenchmarkSource, sha256: sha256(pairedBenchmarkSource) },
      pairedAnalysis: sourceMetadata(join(benchmarkDir, "ffi-fast-path-paired-analysis.ts")),
      nodeAssetTarget: sourceMetadata(join(benchmarkDir, "../node-asset-target.ts")),
    },
  },
  environment: {
    bun: { version: process.versions.bun, platform: process.platform, arch: process.arch },
    node: nodeRuntime,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    availableParallelism: availableParallelism(),
    loadAverageAtCompletion: loadavg(),
  },
  targets: {
    baseline: targetMetadata(baseline),
    candidate: targetMetadata(candidate),
  },
  schedule: {
    algorithm:
      "seeded per-pair unit shuffle; exact per-unit AB/BA balance; concurrent preparation; sequential retained batches",
    entries: schedule,
  },
  quality: { rejectedPairAttempts, pairGapExceedances },
  results,
}

writeJsonAtomic(outputPath, payload)
if (!quiet) {
  console.log("| Scenario | Bun paired delta (95% CI) | Node paired delta (95% CI) | Median pair gap |")
  console.log("| --- | ---: | ---: | ---: |")
  for (const result of results) {
    console.log(
      `| ${result.name} | ${formatChange(result.bun.nominal)} | ${formatChange(result.node.nominal)}` +
        ` | ${Math.max(result.bun.nominal.pairGapMs.median, result.node.nominal.pairGapMs.median).toFixed(1)} ms |`,
    )
  }
  console.log(`results=${outputPath}`)
}

function createTarget(role: Role, root: string): Target {
  const packageRoot = join(root, "packages/core")
  const childSource = join(packageRoot, "src/benchmark/ffi-fast-path-scenarios.ts")
  for (const path of [
    join(root, "bun.lock"),
    join(packageRoot, "package.json"),
    join(packageRoot, "node_modules"),
    childSource,
    join(packageRoot, "src/benchmark/ffi-fast-path-calibration.ts"),
  ]) {
    if (!existsSync(path)) throw new Error(`${role} is missing required path: ${path}`)
  }
  const buildDir = join(packageRoot, "src/benchmark/.runtime-build", `paired-${process.pid}-${role}`)
  const workingTree = workingTreeProvenance(root)
  return {
    role,
    root,
    packageRoot,
    childSource,
    buildDir,
    nodeScript: join(buildDir, "ffi-fast-path-scenarios.js"),
    revision: git(root, ["rev-parse", "HEAD"]).trim(),
    dirty: workingTree.status.trim().length > 0,
    workingTree,
    scenarioHash: sha256(childSource),
    calibrationHash: sha256(join(packageRoot, "src/benchmark/ffi-fast-path-calibration.ts")),
    lockHash: sha256(join(root, "bun.lock")),
    packageHash: sha256(join(packageRoot, "package.json")),
    nativeArtifacts: {
      bun: selectedNativeArtifact(packageRoot, process.platform, process.arch),
      node: selectedNativeArtifact(packageRoot, nodeRuntime.platform, nodeRuntime.arch),
    },
  }
}

function selectedNativeArtifact(packageRoot: string, platform: string, arch: string): NativeArtifact {
  const descriptor = getNativeAssetDescriptor({
    platform: platform as NodeAssetTarget["platform"],
    arch: arch as NodeAssetTarget["arch"],
    ...(platform === "linux" ? { libc: process.env.OPENTUI_LIBC === "musl" ? "musl" : "glibc" } : {}),
  })
  const packageDir = join(packageRoot, "node_modules", descriptor.packageName)
  if (!existsSync(packageDir)) throw new Error(`missing native package: ${packageDir}`)
  const path = join(packageDir, descriptor.fileName)
  if (!existsSync(path)) throw new Error(`missing native library: ${path}`)
  return { path, sha256: sha256(path) }
}

function assertMatchingNativeArtifacts(baselineTarget: Target, candidateTarget: Target): void {
  for (const runtime of ["bun", "node"] as const) {
    const before = baselineTarget.nativeArtifacts[runtime]
    const after = candidateTarget.nativeArtifacts[runtime]
    if (before.sha256 !== after.sha256) {
      throw new Error(
        `${runtime} native artifacts differ (${before.sha256} vs ${after.sha256}); normalize artifacts or pass --allow-native-drift`,
      )
    }
  }
}

function selectScenarios(
  filter: string | null,
  baselineDefault: string[],
  candidateDefault: string[],
  baselineTargeted: string[],
  candidateTargeted: string[],
): string[] {
  const selected = filter
    ? filter
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : baselineDefault
  if (selected.length === 0) throw new Error("no benchmark scenarios selected")
  for (const [role, available] of [
    ["baseline", new Set([...baselineDefault, ...baselineTargeted])],
    ["candidate", new Set([...candidateDefault, ...candidateTargeted])],
  ] as const) {
    const missing = selected.filter((name) => !available.has(name))
    if (missing.length > 0) throw new Error(`${role} is missing scenarios: ${missing.join(", ")}`)
  }
  return selected
}

function listScenarios(target: Target, argument: "--list-scenarios" | "--list-targeted-scenarios"): string[] {
  const child = spawnSync(process.execPath, [target.childSource, argument], {
    cwd: target.packageRoot,
    encoding: "utf8",
  })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`${target.role} failed to list scenarios: ${child.stderr || child.stdout}`)
  return child.stdout.trim().split("\n").filter(Boolean)
}

function buildNodeBenchmark(target: Target): void {
  rmSync(target.buildDir, { recursive: true, force: true })
  const child = spawnSync(
    process.execPath,
    [
      "build",
      target.childSource,
      "--target=node",
      `--outdir=${target.buildDir}`,
      "--external=@opentui/core-*",
      "--external=web-tree-sitter",
    ],
    { cwd: target.packageRoot, encoding: "utf8" },
  )
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`${target.role} Node build failed: ${child.stderr || child.stdout}`)
}

async function prepareChild(
  target: Target,
  runtime: PairedRuntime,
  scenario: string,
  pair: number,
  sequence: number,
  position: "first" | "second",
): Promise<PreparedChild> {
  const safeScenario = scenario.replaceAll(/[^a-zA-Z0-9_-]/g, "-")
  const resultPath = join(
    tmpdir(),
    `opentui-ffi-paired-${process.pid}-${sequence}-${target.role}-${runtime}-${safeScenario}.json`,
  )
  rmSync(resultPath, { force: true })
  const command =
    runtime === "bun"
      ? [process.execPath, target.childSource]
      : [nodePath, "--experimental-ffi", "--disable-warning=ExperimentalWarning", target.nodeScript]
  command.push(
    `--scenario=${scenario}`,
    `--target-ms=${SUITES[suite].targetMs}`,
    `--warmup-ms=${SUITES[suite].warmupMs}`,
    `--json=${resultPath}`,
    "--no-output",
    "--wait-for-start",
  )

  const childStartedMonotonicMs = performance.now()
  const child = spawn(command[0]!, command.slice(1), {
    cwd: target.packageRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  let spawnError: Error | undefined
  let started = false
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => (stdout += chunk))
  child.stderr.on("data", (chunk: string) => (stderr += chunk))
  child.once("error", (error) => (spawnError = error))
  child.stdin.on("error", (error) => (spawnError ??= error))
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }))
  })

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => finish(new Error(`${target.role} ${runtime} ${scenario} timed out during preparation`)),
        120_000,
      )
      const onData = () => {
        if (stdout.includes("READY\n")) finish()
      }
      const onError = (error: Error) => finish(error)
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(
          new Error(
            `${target.role} ${runtime} ${scenario} exited before preparation completed` +
              ` (status=${code ?? "null"}, signal=${signal ?? "none"}): ${stderr || stdout}`,
          ),
        )
      }
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        child.stdout.off("data", onData)
        child.off("error", onError)
        child.off("close", onClose)
        if (error) rejectReady(error)
        else resolveReady()
      }
      child.stdout.on("data", onData)
      child.once("error", onError)
      child.once("close", onClose)
      onData()
    })
  } catch (error) {
    await terminateChild(child, completion)
    rmSync(resultPath, { force: true })
    throw error
  }

  return {
    async start() {
      if (started) throw new Error(`${target.role} ${runtime} ${scenario} was already started`)
      started = true
      child.stdin.end("\n")
      let childResult: Awaited<typeof completion>
      try {
        childResult = await withTimeout(
          completion,
          120_000,
          `${target.role} ${runtime} ${scenario} timed out after its start signal`,
        )
      } catch (error) {
        await terminateChild(child, completion)
        throw error
      }
      const { code, signal } = childResult
      const childEndedMonotonicMs = performance.now()
      try {
        if (spawnError) throw spawnError
        if (code !== 0) {
          throw new Error(
            `${target.role} ${runtime} ${scenario} failed in pair ${pair + 1}/${pairs}` +
              ` (status=${code ?? "null"}, signal=${signal ?? "none"}): ${stderr || stdout}`,
          )
        }
        const payload = JSON.parse(readFileSync(resultPath, "utf8")) as ChildPayload
        if (
          payload.schemaVersion !== 1 ||
          payload.scenario.name !== scenario ||
          payload.sample.runtime.name !== runtime ||
          payload.sample.operations < 1 ||
          payload.sample.elapsedNs <= 0 ||
          payload.sample.checksum === 0 ||
          !Number.isFinite(payload.sample.startedAtEpochMs) ||
          !Number.isFinite(payload.sample.endedAtEpochMs) ||
          payload.sample.endedAtEpochMs < payload.sample.startedAtEpochMs
        ) {
          throw new Error(`${target.role} returned invalid ${runtime} metadata for ${scenario}`)
        }
        const existing = scenarioMetadata.get(scenario)
        if (
          existing &&
          (existing.operation !== payload.scenario.operation || existing.description !== payload.scenario.description)
        ) {
          throw new Error(`scenario metadata differs between revisions for ${scenario}`)
        }
        scenarioMetadata.set(scenario, payload.scenario)
        return {
          ...payload.sample,
          startedAt: new Date(payload.sample.startedAtEpochMs).toISOString(),
          wallMs: childEndedMonotonicMs - childStartedMonotonicMs,
          pair,
          sequence,
          position,
        }
      } finally {
        rmSync(resultPath, { force: true })
      }
    },
    async cancel() {
      await terminateChild(child, completion)
      rmSync(resultPath, { force: true })
    },
  }
}

async function terminateChild(
  child: ReturnType<typeof spawn>,
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await completion
    return
  }
  child.kill()
  try {
    await withTimeout(completion, 5_000, "child did not exit after SIGTERM")
  } catch {
    child.kill("SIGKILL")
    await withTimeout(completion, 5_000, "child did not exit after SIGKILL")
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function analyzeRuntime(name: string, runtime: PairedRuntime, familywiseConfidence: number) {
  const pairsForRuntime = raw.get(`${name}:${runtime}`)!
  const observations: PairedObservation[] = pairsForRuntime.map((pair) => ({
    pair: pair.pair,
    order: pair.order,
    gapMs: pair.gapMs,
    baselineNsPerOp: pair.baseline.nsPerOp,
    candidateNsPerOp: pair.candidate.nsPerOp,
  }))
  const analysisSeed = seedFromString(`${seed}:${runtime}:${name}:paired-v1`)
  const nominal = analyzePairedObservations(observations, BOOTSTRAP_SAMPLES, 0.95, analysisSeed)
  const familywise = analyzePairedObservations(observations, BOOTSTRAP_SAMPLES, familywiseConfidence, analysisSeed)
  const withinBudget = pairsForRuntime.length >= 10 && withinRegressionBudget(familywise.ci.upper, 0.03)
  return {
    nominal,
    familywise,
    diagnostics: {
      baseline: summarizeSamples(pairsForRuntime.map((pair) => pair.baseline)),
      candidate: summarizeSamples(pairsForRuntime.map((pair) => pair.candidate)),
    },
    safety: {
      criterion: "familywise confidence interval upper bound <= 3%",
      minimumPairs: 10,
      maximumRegression: 0.03,
      enoughPairs: pairsForRuntime.length >= 10,
      significantImprovement: pairsForRuntime.length >= 10 && familywise.ci.upper < 0,
      withinRegressionBudget: withinBudget,
      passed: withinBudget,
    },
  }
}

function summarizeSamples(samples: ProcessSample[]) {
  return {
    elapsedTargetRatio: stats(samples.map((sample) => sample.elapsedNs / (SUITES[suite].targetMs * 1_000_000))),
    wallMs: stats(samples.map((sample) => sample.wallMs)),
    processCpuToElapsedRatio: stats(
      samples.map((sample) => (sample.cpuUserMicros + sample.cpuSystemMicros) / (sample.elapsedNs / 1_000)),
    ),
    voluntaryContextSwitches: stats(samples.map((sample) => sample.voluntaryContextSwitches)),
    involuntaryContextSwitches: stats(samples.map((sample) => sample.involuntaryContextSwitches)),
    selectedCalibrationAttempts: stats(samples.map((sample) => sample.calibration.selectedAttempt)),
    outsideTargetWindow: samples.filter((sample) => !sample.calibration.withinTargetWindow).length,
  }
}

function stats(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return {
    median: sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  }
}

function readNodeRuntime(): { version: string; execPath: string; platform: string; arch: string } {
  const child = spawnSync(
    nodePath,
    [
      "--eval",
      "process.stdout.write(JSON.stringify({ version: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch }))",
    ],
    { encoding: "utf8" },
  )
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`failed to inspect Node: ${child.stderr || child.stdout}`)
  return JSON.parse(child.stdout)
}

function targetMetadata(target: Target) {
  return {
    root: target.root,
    revision: target.revision,
    dirty: target.dirty,
    workingTree: target.workingTree,
    scenarioHash: target.scenarioHash,
    calibrationHash: target.calibrationHash,
    lockHash: target.lockHash,
    packageHash: target.packageHash,
    nativeArtifacts: target.nativeArtifacts,
  }
}

function workingTreeProvenance(root: string): WorkingTreeProvenance {
  const status = git(root, ["status", "--porcelain=v1"])
  const trackedDiff = git(root, ["diff", "HEAD", "--binary", "--no-ext-diff"])
  const untrackedOutput = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  const untrackedFiles = untrackedOutput
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, sha256: sha256(join(root, path)) }))
  return {
    status,
    trackedDiff,
    trackedDiffSha256: createHash("sha256").update(trackedDiff).digest("hex"),
    untrackedFiles,
  }
}

function pairQualityReasons(baselineSample: ProcessSample, candidateSample: ProcessSample): string[] {
  return [
    ...pairedSampleQualityReasons("baseline", baselineSample),
    ...pairedSampleQualityReasons("candidate", candidateSample),
  ]
}

function git(root: string, args: string[]): string {
  const child = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${root}: ${child.stderr}`)
  return child.stdout
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function sourceMetadata(path: string): { path: string; sha256: string } {
  if (!existsSync(path)) throw new Error(`missing benchmark driver source: ${path}`)
  return { path, sha256: sha256(path) }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp-${process.pid}`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  rmSync(path, { force: true })
  renameSync(temporaryPath, path)
}

function formatChange(value: { pairedChange: number; ci: { lower: number; upper: number } }): string {
  return `${formatPercent(value.pairedChange)} [${formatPercent(value.ci.lower)}, ${formatPercent(value.ci.upper)}]`
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`
}

function seedFromString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return hash >>> 0
}

function requiredAbsoluteRoot(name: string): string {
  const value = optionalArg(name)
  if (!value) throw new Error(`--${name} is required`)
  if (!isAbsolute(value)) throw new Error(`--${name} must be absolute`)
  return resolve(value)
}

function integerArg(name: string, fallback: number, minimum: number): number {
  const value = Number(stringArg(name, String(fallback)))
  if (!Number.isInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`)
  return value
}

function numberArg(name: string, fallback: number, minimum: number): number {
  const value = Number(stringArg(name, String(fallback)))
  if (!Number.isFinite(value) || value < minimum) throw new Error(`--${name} must be a number >= ${minimum}`)
  return value
}

function stringArg(name: string, fallback: string): string {
  return optionalArg(name) ?? fallback
}

function optionalArg(name: string): string | null {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null
}
