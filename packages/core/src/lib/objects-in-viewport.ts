import type { ViewportBounds } from "../types.js"

interface ViewportObject {
  screenX: number
  screenY: number
  width: number
  height: number
  zIndex: number
}

/**
 * Returns objects that overlap with the viewport bounds.
 *
 * @param viewport - The viewport bounds to check against
 * @param objects - Array of objects MUST be sorted by screen position (screenY for column, screenX for row direction)
 * @param direction - Primary scroll direction: "column" (vertical) or "row" (horizontal)
 * @param padding - Extra padding around viewport to include nearby objects
 * @param minTriggerSize - Minimum array size to use binary search optimization
 * @returns Array of visible objects sorted by zIndex
 *
 * @remarks
 * Objects must be pre-sorted by their start screen position (screenY for column direction, screenX for row direction).
 * Unsorted input will produce incorrect results.
 */
export function getObjectsInViewport<T extends ViewportObject>(
  viewport: ViewportBounds,
  objects: T[],
  direction: "row" | "column" = "column",
  padding: number = 10,
  minTriggerSize: number = 16,
): T[] {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return []
  }

  if (objects.length === 0) {
    return []
  }

  if (objects.length < minTriggerSize) {
    return objects
  }

  const viewportTop = viewport.y - padding
  const viewportBottom = viewport.y + viewport.height + padding
  const viewportLeft = viewport.x - padding
  const viewportRight = viewport.x + viewport.width + padding

  const isRow = direction === "row"

  const children = objects
  const totalChildren = children.length
  if (totalChildren === 0) return []

  const vpStart = isRow ? viewportLeft : viewportTop
  const vpEnd = isRow ? viewportRight : viewportBottom

  // Binary search to find any child that overlaps along the primary axis
  let lo = 0
  let hi = totalChildren - 1
  let candidate = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = children[mid]
    const start = isRow ? c.screenX : c.screenY
    const end = isRow ? c.screenX + c.width : c.screenY + c.height

    if (end < vpStart) {
      lo = mid + 1
    } else if (start > vpEnd) {
      hi = mid - 1
    } else {
      candidate = mid
      break
    }
  }

  const visibleChildren: T[] = []

  // If binary search found no candidate, the viewport might be in a gap between objects
  // Start from the position where the search ended
  if (candidate === -1) {
    // Binary search failed to find overlap - viewport is in a gap
    // We need to check objects before lo for any that extend into the viewport
    candidate = lo > 0 ? lo - 1 : 0
  }

  // Expand left to find all objects that overlap the viewport
  // To handle large objects that start early but extend far, we continue
  // checking even after finding objects that don't overlap, up to a limit
  // This handles cases where many small objects sit between a large object and the viewport
  // Real-world examples: background panels, large images, or spanning containers
  const maxLookBehind = 50
  let left = candidate
  let gapCount = 0

  while (left - 1 >= 0) {
    const prev = children[left - 1]
    const prevEnd = isRow ? prev.screenX + prev.width : prev.screenY + prev.height

    if (prevEnd <= vpStart) {
      gapCount++
      if (gapCount >= maxLookBehind) {
        break
      }
    } else {
      gapCount = 0
    }

    left--
  }

  // Expand right to find the rightmost overlapping object
  let right = candidate + 1
  while (right < totalChildren) {
    const next = children[right]
    if ((isRow ? next.screenX : next.screenY) >= vpEnd) break
    right++
  }

  // Collect candidates that also overlap on the cross axis
  for (let i = left; i < right; i++) {
    const child = children[i]
    const start = isRow ? child.screenX : child.screenY
    const end = isRow ? child.screenX + child.width : child.screenY + child.height

    // Check primary axis overlap (optimization: skip objects that don't overlap)
    if (end <= vpStart) continue
    if (start >= vpEnd) break

    // Check cross-axis overlap
    if (isRow) {
      const childBottom = child.screenY + child.height
      if (childBottom < viewportTop) continue
      const childTop = child.screenY
      if (childTop > viewportBottom) continue
    } else {
      const childRight = child.screenX + child.width
      if (childRight < viewportLeft) continue
      const childLeft = child.screenX
      if (childLeft > viewportRight) continue
    }

    visibleChildren.push(child)
  }

  // Sort by zIndex
  if (visibleChildren.length > 1) {
    visibleChildren.sort((a, b) => (a.zIndex > b.zIndex ? 1 : a.zIndex < b.zIndex ? -1 : 0))
  }

  return visibleChildren
}
