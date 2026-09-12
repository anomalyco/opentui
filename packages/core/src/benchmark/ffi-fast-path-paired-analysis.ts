export type PairedOrder = "baseline-first" | "candidate-first"
export type PairedRuntime = "bun" | "node"

export interface PairedScheduleEntry {
  pair: number
  sequence: number
  scenario: string
  runtime: PairedRuntime
  order: PairedOrder
}

export interface PairedObservation {
  pair: number
  order: PairedOrder
  gapMs: number
  baselineNsPerOp: number
  candidateNsPerOp: number
}

export interface PairedSampleDiagnostics {
  cpuUserMicros: number
  cpuSystemMicros: number
  voluntaryContextSwitches: number
  involuntaryContextSwitches: number
  calibration: {
    calibrationConverged: boolean
    withinTargetWindow: boolean
  }
}

export function pairedSampleQualityReasons(role: string, sample: PairedSampleDiagnostics): string[] {
  const reasons: string[] = []
  if (sample.calibration?.calibrationConverged !== true) reasons.push(`${role} calibration did not converge`)
  for (const [name, value] of [
    ["cpuUserMicros", sample.cpuUserMicros],
    ["cpuSystemMicros", sample.cpuSystemMicros],
    ["voluntaryContextSwitches", sample.voluntaryContextSwitches],
    ["involuntaryContextSwitches", sample.involuntaryContextSwitches],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) reasons.push(`${role} ${name} is invalid`)
  }
  return reasons
}

export function pairGapWithinTarget(gapMs: number, targetMs: number): boolean {
  if (!Number.isFinite(gapMs) || gapMs < 0) throw new Error("pair gap must be a finite non-negative number")
  if (!Number.isFinite(targetMs) || targetMs < 0)
    throw new Error("pair gap target must be a finite non-negative number")
  return gapMs <= targetMs
}

export function withinRegressionBudget(upperBound: number, maximumRegression: number): boolean {
  return upperBound <= maximumRegression + Number.EPSILON
}

export function createPairedSchedule(
  scenarios: readonly string[],
  runtimes: readonly PairedRuntime[],
  pairs: number,
  seed: number,
): PairedScheduleEntry[] {
  if (!Number.isInteger(pairs) || pairs < 2 || pairs % 2 !== 0) {
    throw new Error("paired benchmark requires an even pair count >= 2")
  }
  if (scenarios.length === 0 || runtimes.length === 0)
    throw new Error("paired benchmark requires scenarios and runtimes")

  const random = mulberry32(seed)
  const units = scenarios.flatMap((scenario) => runtimes.map((runtime) => ({ scenario, runtime })))
  const schedule: PairedScheduleEntry[] = []
  let sequence = 0

  for (let pair = 0; pair < pairs; pair++) {
    const shuffled = [...units]
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1))
      ;[shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!]
    }

    for (const unit of shuffled) {
      const unitIndex = units.findIndex(
        (candidate) => candidate.scenario === unit.scenario && candidate.runtime === unit.runtime,
      )
      schedule.push({
        pair,
        sequence: sequence++,
        scenario: unit.scenario,
        runtime: unit.runtime,
        order: (pair + unitIndex) % 2 === 0 ? "baseline-first" : "candidate-first",
      })
    }
  }

  return schedule
}

export function analyzePairedObservations(
  observations: readonly PairedObservation[],
  bootstrapSamples = 20_000,
  confidence = 0.95,
  seed = 1,
) {
  if (!Number.isInteger(bootstrapSamples) || bootstrapSamples < 1) {
    throw new Error("bootstrapSamples must be a positive integer")
  }
  if (!(confidence > 0 && confidence < 1)) throw new Error("confidence must be between 0 and 1")

  const strata = {
    baselineFirst: logRatios(observations.filter((sample) => sample.order === "baseline-first")),
    candidateFirst: logRatios(observations.filter((sample) => sample.order === "candidate-first")),
  }
  if (strata.baselineFirst.length === 0 || strata.candidateFirst.length === 0) {
    throw new Error("paired analysis requires both baseline-first and candidate-first observations")
  }

  const baselineFirstMean = mean(strata.baselineFirst)
  const candidateFirstMean = mean(strata.candidateFirst)
  const effectLog = (baselineFirstMean + candidateFirstMean) / 2
  const secondPositionEffectLog = (baselineFirstMean - candidateFirstMean) / 2
  const allLogs = [...strata.baselineFirst, ...strata.candidateFirst]
  const random = mulberry32(seed)
  const changes = new Array<number>(bootstrapSamples)

  for (let sample = 0; sample < bootstrapSamples; sample++) {
    const baselineFirst = resampledMean(strata.baselineFirst, random)
    const candidateFirst = resampledMean(strata.candidateFirst, random)
    changes[sample] = Math.exp((baselineFirst + candidateFirst) / 2) - 1
  }
  changes.sort((left, right) => left - right)

  const tail = (1 - confidence) / 2
  return {
    pairs: observations.length,
    orderCounts: {
      baselineFirst: strata.baselineFirst.length,
      candidateFirst: strata.candidateFirst.length,
    },
    medianBaselineNsPerOp: median(observations.map((sample) => sample.baselineNsPerOp)),
    medianCandidateNsPerOp: median(observations.map((sample) => sample.candidateNsPerOp)),
    pairedChange: Math.exp(effectLog) - 1,
    ci: {
      confidence,
      lower: percentile(changes, tail),
      upper: percentile(changes, 1 - tail),
    },
    orderEstimates: {
      baselineFirst: Math.exp(baselineFirstMean) - 1,
      candidateFirst: Math.exp(candidateFirstMean) - 1,
    },
    secondPositionEffect: Math.exp(secondPositionEffectLog) - 1,
    logRatioSd: sampleStandardDeviation(allLogs),
    pairCorrelation: pearsonCorrelation(
      observations.map((sample) => sample.baselineNsPerOp),
      observations.map((sample) => sample.candidateNsPerOp),
    ),
    candidateFasterPairs: allLogs.filter((value) => value < 0).length,
    pairGapMs: summarize(observations.map((sample) => sample.gapMs)),
  }
}

function logRatios(observations: readonly PairedObservation[]): number[] {
  return observations.map((sample) => {
    if (!(sample.baselineNsPerOp > 0) || !(sample.candidateNsPerOp > 0) || !(sample.gapMs >= 0)) {
      throw new Error("paired observations require positive timings and non-negative gaps")
    }
    return Math.log(sample.candidateNsPerOp / sample.baselineNsPerOp)
  })
}

function resampledMean(values: readonly number[], random: () => number): number {
  let total = 0
  for (let index = 0; index < values.length; index++) total += values[Math.floor(random() * values.length)]!
  return total / values.length
}

function summarize(values: number[]) {
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function percentile(sortedValues: readonly number[], probability: number): number {
  const index = (sortedValues.length - 1) * probability
  const lower = Math.floor(index)
  const fraction = index - lower
  return (
    sortedValues[lower]! +
    (sortedValues[Math.min(lower + 1, sortedValues.length - 1)]! - sortedValues[lower]!) * fraction
  )
}

function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0
  const average = mean(values)
  return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1))
}

function pearsonCorrelation(left: readonly number[], right: readonly number[]): number | null {
  const leftMean = mean(left)
  const rightMean = mean(right)
  let covariance = 0
  let leftSquares = 0
  let rightSquares = 0
  for (let index = 0; index < left.length; index++) {
    const leftDelta = left[index]! - leftMean
    const rightDelta = right[index]! - rightMean
    covariance += leftDelta * rightDelta
    leftSquares += leftDelta ** 2
    rightSquares += rightDelta ** 2
  }
  if (leftSquares === 0 || rightSquares === 0) return null
  return covariance / Math.sqrt(leftSquares * rightSquares)
}

function mulberry32(initialSeed: number): () => number {
  let seed = initialSeed >>> 0
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
