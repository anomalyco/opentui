import type { ActiveKey, ActiveKeyOptions, KeymapEvent } from "../types.js"

export interface ActiveKeysCache<TTarget extends object, TEvent extends KeymapEvent> {
  version: number
  notifyVersion: number
  focused: TTarget | null | undefined
  value: readonly ActiveKey<TTarget, TEvent>[]
  targets: WeakMap<TTarget, { version: number; value: readonly ActiveKey<TTarget, TEvent>[] }>
  nullTarget?: { version: number; value: readonly ActiveKey<TTarget, TEvent>[] }
}

export interface ActiveKeysCaches<TTarget extends object, TEvent extends KeymapEvent> {
  plain: ActiveKeysCache<TTarget, TEvent>
  bindings: ActiveKeysCache<TTarget, TEvent>
  metadata: ActiveKeysCache<TTarget, TEvent>
  bindingsAndMetadata: ActiveKeysCache<TTarget, TEvent>
}

export function createActiveKeysCache<TTarget extends object, TEvent extends KeymapEvent>(): ActiveKeysCache<
  TTarget,
  TEvent
> {
  return {
    version: -1,
    notifyVersion: -1,
    focused: undefined,
    value: [],
    targets: new WeakMap<TTarget, { version: number; value: readonly ActiveKey<TTarget, TEvent>[] }>(),
  }
}

export function createActiveKeysCaches<TTarget extends object, TEvent extends KeymapEvent>(): ActiveKeysCaches<
  TTarget,
  TEvent
> {
  return {
    plain: createActiveKeysCache(),
    bindings: createActiveKeysCache(),
    metadata: createActiveKeysCache(),
    bindingsAndMetadata: createActiveKeysCache(),
  }
}

export function getActiveKeysCache<TTarget extends object, TEvent extends KeymapEvent>(
  caches: ActiveKeysCaches<TTarget, TEvent>,
  options?: ActiveKeyOptions,
): ActiveKeysCache<TTarget, TEvent> {
  if (options === undefined) {
    return caches.plain
  }

  const includeBindings = options.includeBindings === true
  const includeMetadata = options.includeMetadata === true
  return includeBindings
    ? includeMetadata
      ? caches.bindingsAndMetadata
      : caches.bindings
    : includeMetadata
      ? caches.metadata
      : caches.plain
}

export function getFocusedActiveKeysCache<TTarget extends object, TEvent extends KeymapEvent>(
  cache: ActiveKeysCache<TTarget, TEvent>,
  cacheVersion: number,
  focused: TTarget | null,
): { version: number; value: readonly ActiveKey<TTarget, TEvent>[] } | undefined {
  const cached = focused ? cache.targets.get(focused) : cache.nullTarget
  return cached?.version === cacheVersion ? cached : undefined
}

export function setFocusedActiveKeysCache<TTarget extends object, TEvent extends KeymapEvent>(
  cache: ActiveKeysCache<TTarget, TEvent>,
  cacheVersion: number,
  focused: TTarget | null,
  value: readonly ActiveKey<TTarget, TEvent>[],
): void {
  const cached = { version: cacheVersion, value }
  if (focused) {
    cache.targets.set(focused, cached)
  } else {
    cache.nullTarget = cached
  }
}
