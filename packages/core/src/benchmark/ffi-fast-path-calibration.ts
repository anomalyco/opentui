export interface TimedCalibrationBatch {
  elapsedNs: number
}

export interface CalibrationPlan<Batch extends TimedCalibrationBatch> {
  operations: number
  diagnostics: {
    warmupBatches: Batch[]
    measurementBatches: Batch[]
    selectedAttempt: number
    calibrationConverged: boolean
  }
}

export function createCalibrationPlan<Batch extends TimedCalibrationBatch>(
  timeRun: (operations: number) => Batch,
  targetMs: number,
  warmupMs: number,
): CalibrationPlan<Batch> {
  const targetNs = targetMs * 1_000_000
  const warmupNs = warmupMs * 1_000_000
  let batchOperations = 64
  let warmedNs = 0
  let lastElapsedNs = 1
  let lastOperations = batchOperations
  const warmupBatches: Batch[] = []

  while (warmedNs < warmupNs) {
    const warmup = timeRun(batchOperations)
    warmupBatches.push(warmup)
    warmedNs += warmup.elapsedNs
    lastElapsedNs = Math.max(warmup.elapsedNs, 1)
    lastOperations = batchOperations
    const scale = Math.max(0.25, Math.min(64, 5_000_000 / lastElapsedNs))
    batchOperations = clampOperations(Math.round(batchOperations * scale))
  }

  let operations = clampOperations(Math.round((lastOperations * targetNs) / lastElapsedNs))
  const measurementBatches: Batch[] = []
  let selectedAttempt = 0
  let calibrationConverged = false
  for (let attempt = 0; attempt < 5; attempt++) {
    const pilot = timeRun(operations)
    measurementBatches.push(pilot)
    selectedAttempt = attempt
    calibrationConverged = pilot.elapsedNs >= targetNs * 0.9 && pilot.elapsedNs <= targetNs * 1.1
    if (calibrationConverged) break
    const scale = Math.max(0.125, Math.min(16, targetNs / Math.max(pilot.elapsedNs, 1)))
    operations = clampOperations(Math.round(operations * scale))
  }

  return {
    operations,
    diagnostics: {
      warmupBatches,
      measurementBatches,
      selectedAttempt,
      calibrationConverged,
    },
  }
}

function clampOperations(value: number): number {
  return Math.max(1, Math.min(50_000_000, value))
}
