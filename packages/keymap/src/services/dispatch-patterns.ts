import type {
  KeymapEvent,
  KeySequencePart,
  PendingSequenceCapture,
  ResolvedSequencePattern,
  SequencePatternMatch,
} from "../types.js"
import { createKeySequencePart } from "./keys.js"
import type { NotificationService } from "./notify.js"

export function matchSequencePattern<TTarget extends object, TEvent extends KeymapEvent>(
  patterns: ReadonlyMap<string, ResolvedSequencePattern<TEvent>>,
  notify: NotificationService<TTarget, TEvent>,
  patternName: string,
  event: TEvent,
): SequencePatternMatch | undefined {
  const pattern = patterns.get(patternName)
  if (!pattern) {
    return undefined
  }

  try {
    return pattern.matcher(event)
  } catch (error) {
    notify.emitError(
      "sequence-pattern-match-error",
      error,
      `[Keymap] Error matching sequence pattern "${pattern.name}":`,
    )
    return undefined
  }
}

export function createPatternEventPart<TEvent extends KeymapEvent>(
  patterns: ReadonlyMap<string, ResolvedSequencePattern<TEvent>>,
  event: TEvent,
  patternName: string,
  match: SequencePatternMatch,
): KeySequencePart {
  const pattern = patterns.get(patternName)
  const payloadKey = pattern?.payloadKey ?? patternName
  const part = createKeySequencePart(
    {
      name: event.name,
      ctrl: event.ctrl,
      shift: event.shift,
      meta: event.meta,
      super: event.super ?? false,
      hyper: event.hyper || undefined,
    },
    { display: match.display ?? String(match.value ?? event.name) },
  )

  return { ...part, patternName, payloadKey }
}

export function createSequencePayload<TTarget extends object, TEvent extends KeymapEvent>(
  patterns: ReadonlyMap<string, ResolvedSequencePattern<TEvent>>,
  notify: NotificationService<TTarget, TEvent>,
  capture?: PendingSequenceCapture<TTarget, TEvent>,
): unknown {
  if (!capture?.patterns || capture.patterns.length === 0) {
    return undefined
  }

  const payload: Record<string, unknown> = {}
  let hasPayload = false
  for (const captured of capture.patterns) {
    const pattern = patterns.get(captured.name)
    let value: unknown

    try {
      value = pattern?.finalize
        ? pattern.finalize(captured.values)
        : captured.values.length === 1
          ? captured.values[0]
          : [...captured.values]
    } catch (error) {
      notify.emitError(
        "sequence-pattern-finalize-error",
        error,
        `[Keymap] Error finalizing sequence pattern "${captured.name}":`,
      )
      continue
    }

    const existing = payload[captured.payloadKey]
    if (existing === undefined) {
      payload[captured.payloadKey] = value
      hasPayload = true
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      payload[captured.payloadKey] = [existing, value]
    }
  }

  return hasPayload ? payload : undefined
}
