import type { ScrollInfo } from "./parse.mouse.js"

type Node = { parent: Node | null }

const takers = new WeakMap<object, Node>()

/** The axis direction of a wheel step: Shift turns vertical steps sideways and sideways steps vertical. */
export function wheelDirection(event: {
  scroll?: ScrollInfo
  modifiers?: { shift: boolean }
}): ScrollInfo["direction"] | undefined {
  const direction = event.scroll?.direction
  if (!direction || !event.modifiers?.shift) return direction
  return direction === "up" ? "left" : direction === "down" ? "right" : direction === "right" ? "down" : "up"
}

/** A wheel step belongs to the innermost scroller on its path that can still move that way. Runs `scroll` unless a
 * scroller inside `scroller` already took this event; `scroll` returns whether `scroller` takes it. Listeners further
 * out still see the event; only scrolling stops. */
export function scrollOnce(event: object, scroller: Node, scroll: () => boolean): void {
  for (let node = takers.get(event) ?? null; node; node = node.parent) if (node === scroller) return
  if (scroll()) takers.set(event, scroller)
}
