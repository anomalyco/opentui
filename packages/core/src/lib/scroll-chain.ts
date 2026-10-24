const scrolled = new WeakSet<object>()

/** Runs `scroll` unless a scroller nearer the target already moved for this wheel event. `scroll` returns whether it
 * moved. Ancestors' listeners still see the event; only scrolling stops at the first scroller that moved. */
export function scrollOnce(event: object, scroll: () => boolean): void {
  if (!scrolled.has(event) && scroll()) scrolled.add(event)
}
