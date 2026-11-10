import type { KeymapEvent, KeymapHost, RegisteredLayer } from "../../types.js"

export function getFocusedTargetIfAvailable<TTarget extends object, TEvent extends KeymapEvent>(
  host: KeymapHost<TTarget, TEvent>,
): TTarget | null {
  if (host.isDestroyed) {
    return null
  }

  return host.getFocusedTarget()
}

export function forEachActivationTarget<TTarget extends object, TEvent extends KeymapEvent>(
  host: KeymapHost<TTarget, TEvent>,
  focused: TTarget | null,
  visit: (target: TTarget, isFocusedTarget: boolean) => boolean | void,
): void {
  let current: TTarget | null = focused ?? host.rootTarget
  let isFocusedTarget = focused !== null

  while (current) {
    const shouldContinue = visit(current, isFocusedTarget)
    if (shouldContinue === false) {
      return
    }

    current = host.getParentTarget(current)
    isFocusedTarget = false
  }
}

export function getActivationPath<TTarget extends object, TEvent extends KeymapEvent>(
  host: KeymapHost<TTarget, TEvent>,
  focused: TTarget | null,
): Set<TTarget> {
  const path = new Set<TTarget>()
  forEachActivationTarget(host, focused, (current) => {
    path.add(current)
  })

  return path
}

export function getActiveLayersForFocused<TTarget extends object, TEvent extends KeymapEvent>(
  layers: readonly RegisteredLayer<TTarget, TEvent>[] | ReadonlySet<RegisteredLayer<TTarget, TEvent>>,
  host: KeymapHost<TTarget, TEvent>,
  focused: TTarget | null,
): readonly RegisteredLayer<TTarget, TEvent>[] {
  const activeLayers: RegisteredLayer<TTarget, TEvent>[] = []
  const activationPath = getActivationPath(host, focused)
  const sortedLayers = Array.isArray(layers)
    ? layers
    : getSortedLayers(layers as ReadonlySet<RegisteredLayer<TTarget, TEvent>>)

  for (const layer of sortedLayers) {
    if (isLayerActiveForFocused(host, layer, focused, activationPath)) {
      activeLayers.push(layer)
    }
  }

  return activeLayers
}

export function getSortedLayers<TTarget extends object, TEvent extends KeymapEvent>(
  layers: ReadonlySet<RegisteredLayer<TTarget, TEvent>>,
): RegisteredLayer<TTarget, TEvent>[] {
  return [...layers].sort((left, right) => {
    const priorityDiff = right.priority - left.priority
    return priorityDiff || right.order - left.order
  })
}

export function isLayerActiveForFocused<TTarget extends object, TEvent extends KeymapEvent>(
  host: KeymapHost<TTarget, TEvent>,
  layer: RegisteredLayer<TTarget, TEvent>,
  focused: TTarget | null,
  activationPath: ReadonlySet<TTarget> = getActivationPath(host, focused),
): boolean {
  const target = layer.target
  if (!target) {
    return true
  }

  if (host.isTargetDestroyed(target)) {
    return false
  }

  if (layer.targetMode === "focus") {
    return target === focused
  }

  return activationPath.has(target)
}
