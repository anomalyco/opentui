/** Used only on a failed model check. The caller replays on a fresh fixture and
 * decides if the first failure is still the one at issue. Keep a confirmed
 * concrete input for CI output; a replay budget is not a minimality proof. */
export function shrinkSameCheck<T>(input: T[], same: (word: T[]) => boolean, maxReplays: number): T[] {
  if (maxReplays < 3 || !same(input)) return input
  let best = input
  let remaining = maxReplays - 2 // confirmation above, and one fresh final replay
  for (let size = Math.max(1, Math.floor(best.length / 2)); size > 0; size = Math.floor(size / 2)) {
    for (let i = 0; i + size <= best.length && remaining > 0; ) {
      const candidate = [...best.slice(0, i), ...best.slice(i + size)]
      remaining--
      if (same(candidate)) best = candidate
      else i += size
    }
  }
  return best !== input && same(best) ? best : input
}
