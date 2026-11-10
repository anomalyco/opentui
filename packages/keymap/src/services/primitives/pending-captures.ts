import type { KeymapEvent, PendingSequenceCapture, ResolvedSequencePattern } from "../../types.js"

export function patternCaptureCount<TTarget extends object, TEvent extends KeymapEvent>(
  capture: PendingSequenceCapture<TTarget, TEvent>,
): number {
  const part = capture.binding.sequence[capture.index]
  if (!part?.patternName) {
    return 0
  }

  const captured = capture.patterns?.at(-1)
  return captured?.name === part.patternName ? captured.values.length : 0
}

export function captureHasMinimum<TTarget extends object, TEvent extends KeymapEvent>(
  capture: PendingSequenceCapture<TTarget, TEvent>,
  patterns: ReadonlyMap<string, ResolvedSequencePattern<TEvent>>,
  missingPatternResult = true,
): boolean {
  const part = capture.binding.sequence[capture.index]
  if (!part?.patternName) {
    return true
  }

  const pattern = patterns.get(part.patternName)
  return pattern ? patternCaptureCount(capture) >= pattern.min : missingPatternResult
}

export function captureHasContinuations<TTarget extends object, TEvent extends KeymapEvent>(
  capture: PendingSequenceCapture<TTarget, TEvent>,
  patterns: ReadonlyMap<string, ResolvedSequencePattern<TEvent>>,
  missingPatternMinimum = true,
): boolean {
  const part = capture.binding.sequence[capture.index]
  if (part?.patternName) {
    const pattern = patterns.get(part.patternName)
    if (pattern && patternCaptureCount(capture) < pattern.max) {
      return true
    }
  }

  return (
    captureHasMinimum(capture, patterns, missingPatternMinimum) && capture.index + 1 < capture.binding.sequence.length
  )
}

export function captureIsExact<TTarget extends object, TEvent extends KeymapEvent>(
  capture: PendingSequenceCapture<TTarget, TEvent>,
  patterns: ReadonlyMap<string, ResolvedSequencePattern<TEvent>>,
): boolean {
  return capture.index === capture.binding.sequence.length - 1 && captureHasMinimum(capture, patterns, false)
}
