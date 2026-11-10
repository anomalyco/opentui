import { describe, expect, test } from "bun:test"
import {
  analyzePairedObservations,
  createPairedSchedule,
  pairGapWithinTarget,
  pairedSampleQualityReasons,
  withinRegressionBudget,
  type PairedObservation,
} from "./ffi-fast-path-paired-analysis.js"

describe("ffi fast path paired analysis", () => {
  test("creates deterministic adjacent units with balanced revision order", () => {
    const first = createPairedSchedule(["a", "b"], ["bun", "node"], 4, 42)
    const second = createPairedSchedule(["a", "b"], ["bun", "node"], 4, 42)

    expect(first).toEqual(second)
    expect(first).toHaveLength(16)
    for (const scenario of ["a", "b"]) {
      for (const runtime of ["bun", "node"] as const) {
        const orders = first
          .filter((entry) => entry.scenario === scenario && entry.runtime === runtime)
          .map((entry) => entry.order)
        expect(orders.filter((order) => order === "baseline-first")).toHaveLength(2)
        expect(orders.filter((order) => order === "candidate-first")).toHaveLength(2)
      }
    }
  })

  test("rejects schedules that cannot balance order", () => {
    expect(() => createPairedSchedule(["a"], ["node"], 3, 1)).toThrow("even pair count")
  })

  test("separates candidate effect from second-position effect", () => {
    const observations: PairedObservation[] = []
    const candidateRatio = 0.9
    const secondPositionRatio = 1.02
    for (let pair = 0; pair < 20; pair++) {
      const order = pair % 2 === 0 ? "baseline-first" : "candidate-first"
      observations.push({
        pair,
        order,
        gapMs: 1,
        baselineNsPerOp: 100,
        candidateNsPerOp:
          100 * candidateRatio * (order === "baseline-first" ? secondPositionRatio : 1 / secondPositionRatio),
      })
    }

    const result = analyzePairedObservations(observations, 2_000, 0.95, 42)
    expect(result.pairedChange).toBeCloseTo(-0.1, 10)
    expect(result.secondPositionEffect).toBeCloseTo(0.02, 10)
    expect(result.orderCounts).toEqual({ baselineFirst: 10, candidateFirst: 10 })
    expect(result.ci.lower).toBeCloseTo(-0.1, 10)
    expect(result.ci.upper).toBeCloseTo(-0.1, 10)
  })

  test("validates paired observation strata", () => {
    expect(() =>
      analyzePairedObservations([
        {
          pair: 0,
          order: "baseline-first",
          gapMs: 1,
          baselineNsPerOp: 100,
          candidateNsPerOp: 90,
        },
      ]),
    ).toThrow("both baseline-first and candidate-first")
  })

  test("reports pair correlation", () => {
    const observations: PairedObservation[] = Array.from({ length: 10 }, (_, pair) => ({
      pair,
      order: pair % 2 === 0 ? "baseline-first" : "candidate-first",
      gapMs: 1,
      baselineNsPerOp: 100 + pair,
      candidateNsPerOp: (100 + pair) * 0.9,
    }))

    expect(analyzePairedObservations(observations, 100, 0.95, 1).pairCorrelation).toBeCloseTo(1, 10)
  })

  test("widens intervals for multiplicity-adjusted confidence", () => {
    const observations: PairedObservation[] = Array.from({ length: 20 }, (_, pair) => ({
      pair,
      order: pair % 2 === 0 ? "baseline-first" : "candidate-first",
      gapMs: 1,
      baselineNsPerOp: 100,
      candidateNsPerOp: 90 + (pair % 5),
    }))
    const nominal = analyzePairedObservations(observations, 10_000, 0.95, 1)
    const adjusted = analyzePairedObservations(observations, 10_000, 0.995, 1)

    expect(adjusted.ci.lower).toBeLessThanOrEqual(nominal.ci.lower)
    expect(adjusted.ci.upper).toBeGreaterThanOrEqual(nominal.ci.upper)
  })

  test("includes the exact regression budget boundary", () => {
    const observations: PairedObservation[] = Array.from({ length: 10 }, (_, pair) => ({
      pair,
      order: pair % 2 === 0 ? "baseline-first" : "candidate-first",
      gapMs: 1,
      baselineNsPerOp: 100,
      candidateNsPerOp: 103,
    }))
    const result = analyzePairedObservations(observations, 1_000, 0.995, 1)

    expect(withinRegressionBudget(result.ci.upper, 0.03)).toBe(true)
    expect(withinRegressionBudget(0.030_000_000_001, 0.03)).toBe(false)
  })

  test("records retained timing drift without censoring a calibrated sample", () => {
    const diagnostics = {
      cpuUserMicros: 1,
      cpuSystemMicros: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 1,
      calibration: { calibrationConverged: true, withinTargetWindow: false },
    }

    expect(pairedSampleQualityReasons("baseline", diagnostics)).toEqual([])
    expect(
      pairedSampleQualityReasons("candidate", {
        ...diagnostics,
        cpuSystemMicros: Number.NaN,
        calibration: { ...diagnostics.calibration, calibrationConverged: false },
      }),
    ).toEqual(["candidate calibration did not converge", "candidate cpuSystemMicros is invalid"])
  })

  test("classifies pair-gap drift without rejecting the observation", () => {
    expect(pairGapWithinTarget(9.5, 10)).toBe(true)
    expect(pairGapWithinTarget(10.5, 10)).toBe(false)
    expect(() => pairGapWithinTarget(-1, 10)).toThrow("finite non-negative")
  })
})
