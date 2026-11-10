import type { State } from "./state.js"
import type { NotificationService } from "./notify.js"
import type { KeymapEvent, ReactiveMatcher, RuntimeMatchable, RuntimeMatcher } from "../types.js"

function isReactiveMatcher(value: unknown): value is ReactiveMatcher {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as { get?: unknown; subscribe?: unknown }
  return typeof candidate.get === "function" && typeof candidate.subscribe === "function"
}

export interface ConditionService<TTarget extends object, TEvent extends KeymapEvent> {
  buildRuntimeMatcher(matcher: (() => boolean) | ReactiveMatcher, source: string): RuntimeMatcher
  matchesConditions(target: RuntimeMatchable): boolean
  /** The results of a target with matchers read since the last `state` event: bit 1 false, bit 2 true. */
  seenResults(target: RuntimeMatchable): number
}

export function createConditionService<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
  notify: NotificationService<TTarget, TEvent>,
): ConditionService<TTarget, TEvent> {
  // Per target with matchers, `epoch * 4 + results`; a `state` event starts a new epoch, since its listeners
  // read again.
  const seen = new WeakMap<RuntimeMatchable, number>()
  let epoch = 0
  notify.onStateEvent(() => void (epoch += 1))

  const seenResults = (target: RuntimeMatchable): number => {
    const entry = seen.get(target) ?? 0
    return entry - (entry % 4) === epoch * 4 ? entry % 4 : 0
  }

  const hasNoConditions = (target: RuntimeMatchable): boolean => {
    return target.requires.length === 0 && target.matchers.length === 0
  }

  const matchesRuntimeMatcher = (matcher: RuntimeMatcher): boolean => {
    try {
      return matcher.match()
    } catch (error) {
      notify.emitError(
        "runtime-matcher-error",
        error,
        `[Keymap] Error evaluating runtime matcher from ${matcher.source}:`,
      )
      return false
    }
  }

  const matchesRuntimeMatchers = (target: RuntimeMatchable): boolean => {
    if (target.matchers.length === 0) {
      return true
    }

    if (target.matchers.length === 1) {
      const [matcher] = target.matchers
      return matcher ? matchesRuntimeMatcher(matcher) : true
    }

    for (const matcher of target.matchers) {
      if (!matchesRuntimeMatcher(matcher)) {
        return false
      }
    }

    return true
  }

  const matchRequirements = (requires: readonly [name: string, value: unknown][]): boolean => {
    if (requires.length === 0) {
      return true
    }

    for (const [name, value] of requires) {
      if (!Object.is(state.data[name], value)) {
        return false
      }
    }

    return true
  }

  const matchesConditions = (target: RuntimeMatchable): boolean => {
    if (hasNoConditions(target)) return true
    const result = matchRequirements(target.requires) && matchesRuntimeMatchers(target)
    if (target.matchers.length > 0) seen.set(target, epoch * 4 + (seenResults(target) | (result ? 2 : 1)))
    return result
  }

  return {
    buildRuntimeMatcher(matcher, source) {
      if (typeof matcher === "function") {
        return { source, match: matcher }
      }

      if (isReactiveMatcher(matcher)) {
        return {
          source,
          match: () => matcher.get(),
          subscribe: (onChange) => matcher.subscribe(onChange),
        }
      }

      throw new Error(`Keymap ${source} expected a function or a reactive matcher`)
    },
    matchesConditions,
    seenResults,
  }
}
