import type { KeymapEvent, KeySequencePart, PendingSequenceCapture, PendingSequenceState } from "../types.js"
import { createKeySequencePart, stringifyKeyStroke } from "./keys.js"

export function isSamePendingSequence<TTarget extends object, TEvent extends KeymapEvent>(
  current: PendingSequenceState<TTarget, TEvent> | null,
  next: PendingSequenceState<TTarget, TEvent> | null,
): boolean {
  if (current === next) {
    return true
  }

  if (!current || !next) {
    return false
  }

  if (current.captures.length !== next.captures.length) {
    return false
  }

  for (let index = 0; index < current.captures.length; index += 1) {
    const left = current.captures[index]
    const right = next.captures[index]
    if (
      !left ||
      !right ||
      left.layer !== right.layer ||
      left.binding !== right.binding ||
      left.index !== right.index ||
      left.parts.length !== right.parts.length
    ) {
      return false
    }

    for (let partIndex = 0; partIndex < left.parts.length; partIndex += 1) {
      if (left.parts[partIndex]?.match !== right.parts[partIndex]?.match) {
        return false
      }
    }

    const leftPatterns = left.patterns ?? []
    const rightPatterns = right.patterns ?? []
    if (leftPatterns.length !== rightPatterns.length) {
      return false
    }

    for (let patternIndex = 0; patternIndex < leftPatterns.length; patternIndex += 1) {
      const leftPattern = leftPatterns[patternIndex]
      const rightPattern = rightPatterns[patternIndex]
      if (!leftPattern || !rightPattern || leftPattern.name !== rightPattern.name) {
        return false
      }

      if (leftPattern.values.length !== rightPattern.values.length) {
        return false
      }

      for (let valueIndex = 0; valueIndex < leftPattern.values.length; valueIndex += 1) {
        if (!Object.is(leftPattern.values[valueIndex], rightPattern.values[valueIndex])) {
          return false
        }
      }
    }
  }

  return true
}

export function popCapture<TTarget extends object, TEvent extends KeymapEvent>(
  capture: PendingSequenceCapture<TTarget, TEvent>,
): PendingSequenceCapture<TTarget, TEvent> | undefined {
  const lastPart = capture.parts.at(-1)
  if (!lastPart || capture.parts.length <= 1) {
    return undefined
  }

  let index = capture.index - 1
  let patterns = capture.patterns
  if (lastPart.patternName) {
    const lastPattern = patterns?.at(-1)
    if (lastPattern?.name === lastPart.patternName) {
      if (lastPattern.values.length > 1) {
        index = capture.index
        patterns = [
          ...(patterns ?? []).slice(0, -1),
          {
            ...lastPattern,
            values: lastPattern.values.slice(0, -1),
            parts: lastPattern.parts.slice(0, -1),
          },
        ]
      } else {
        patterns = (patterns ?? []).slice(0, -1)
      }
    }
  }

  return {
    layer: capture.layer,
    binding: capture.binding,
    index,
    parts: capture.parts.slice(0, -1),
    patterns,
  }
}

export function collectSequencePartsFromPending<TTarget extends object, TEvent extends KeymapEvent>(
  pending: PendingSequenceState<TTarget, TEvent>,
): KeySequencePart[] {
  const firstCapture = pending.captures[0]
  if (!firstCapture || firstCapture.parts.length === 0) {
    return []
  }

  const parts: KeySequencePart[] = []
  for (let index = 0; index < firstCapture.parts.length; index += 1) {
    const firstPart = firstCapture.parts[index]
    if (!firstPart) continue
    let display: string | undefined
    let tokenName: string | undefined
    let hasDisplayConflict = false
    let hasTokenConflict = false

    for (const capture of pending.captures) {
      const part = capture.parts[index]
      if (!part) {
        continue
      }

      if (display === undefined) {
        display = part.display
        tokenName = part.tokenName
        continue
      }

      if (!hasDisplayConflict && display !== part.display) {
        hasDisplayConflict = true
      }

      if (!hasTokenConflict && tokenName !== part.tokenName) {
        hasTokenConflict = true
      }
    }

    if (display === undefined || hasDisplayConflict) {
      display = stringifyKeyStroke(firstPart.stroke)
    }

    if (hasTokenConflict) {
      tokenName = undefined
    }

    parts.push(
      createKeySequencePart(firstPart.stroke, {
        display,
        match: firstPart.match,
        tokenName,
      }),
    )
  }

  return parts
}
