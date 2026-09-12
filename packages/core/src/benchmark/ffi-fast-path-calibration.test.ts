import { describe, expect, test } from "bun:test"
import { createCalibrationPlan } from "./ffi-fast-path-calibration.js"

describe("ffi fast path calibration", () => {
  test("scales the last completed batch exactly once for the first pilot", () => {
    const calls: number[] = []
    const plan = createCalibrationPlan(
      (operations) => {
        calls.push(operations)
        return { elapsedNs: calls.length === 1 ? 1_000_000 : 10_000_000 }
      },
      10,
      1,
    )

    expect(calls).toEqual([64, 640])
    expect(plan.operations).toBe(640)
    expect(plan.diagnostics.calibrationConverged).toBe(true)
  })

  test("retains the corrected operation count after a failed pilot", () => {
    const calls: number[] = []
    const elapsedNs = [1_000_000, 5_000_000, 10_000_000]
    const plan = createCalibrationPlan(
      (operations) => {
        calls.push(operations)
        return { elapsedNs: elapsedNs[calls.length - 1]! }
      },
      10,
      1,
    )

    expect(calls).toEqual([64, 640, 1_280])
    expect(plan.operations).toBe(1_280)
    expect(plan.diagnostics.selectedAttempt).toBe(1)
    expect(plan.diagnostics.calibrationConverged).toBe(true)
  })
})
