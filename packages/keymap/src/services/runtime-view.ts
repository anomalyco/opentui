import type { ConditionService } from "./conditions.js"
import type { ActiveCommandView, CommandView, LayerCommandEntry, State } from "./state.js"
import type { KeymapEvent, KeymapHost, RegisteredLayer } from "../types.js"
import { getActiveLayersForFocused } from "./primitives/active-layers.js"

function pushCommandEntry<TTarget extends object, TEvent extends KeymapEvent>(
  target: Map<string, LayerCommandEntry<TTarget, TEvent>[]>,
  name: string,
  entry: LayerCommandEntry<TTarget, TEvent>,
): void {
  const existing = target.get(name)
  if (existing) existing.push(entry)
  else target.set(name, [entry])
}

export function getRegisteredCommandView<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
): CommandView<TTarget, TEvent> {
  const entries: LayerCommandEntry<TTarget, TEvent>[] = []
  const chainsByName = new Map<string, LayerCommandEntry<TTarget, TEvent>[]>()

  for (const layer of state.layers) {
    for (const commandState of layer.commands) {
      const entry: LayerCommandEntry<TTarget, TEvent> = { layer, commandState }
      entries.push(entry)
      pushCommandEntry(chainsByName, commandState.command.name, entry)
    }
  }

  return { entries, chainsByName }
}

function collectActiveCommands<TTarget extends object, TEvent extends KeymapEvent>(
  layers: readonly RegisteredLayer<TTarget, TEvent>[],
  conditions: ConditionService<TTarget, TEvent>,
  checkLayerConditions: boolean,
): ActiveCommandView<TTarget, TEvent> {
  const entries: LayerCommandEntry<TTarget, TEvent>[] = []
  const reachable: LayerCommandEntry<TTarget, TEvent>[] = []
  const reachableByName = new Map<string, LayerCommandEntry<TTarget, TEvent>>()
  const chainsByName = new Map<string, LayerCommandEntry<TTarget, TEvent>[]>()

  for (const layer of layers) {
    if (layer.commands.length === 0) continue
    if (checkLayerConditions && !conditions.matchesConditions(layer)) continue

    for (const commandState of layer.commands) {
      if (!conditions.matchesConditions(commandState)) continue

      const entry: LayerCommandEntry<TTarget, TEvent> = { layer, commandState }
      entries.push(entry)
      pushCommandEntry(chainsByName, commandState.command.name, entry)
      if (!reachableByName.has(commandState.command.name)) {
        reachableByName.set(commandState.command.name, entry)
        reachable.push(entry)
      }
    }
  }

  return { layers, entries, reachable, reachableByName, chainsByName }
}

export function getActiveCommandView<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
  host: KeymapHost<TTarget, TEvent>,
  conditions: ConditionService<TTarget, TEvent>,
  focused: TTarget | null,
): ActiveCommandView<TTarget, TEvent> {
  if (state.activeLayersCacheVersion !== state.cacheVersion || state.activeLayersCacheFocused !== focused) {
    state.activeLayersCacheVersion = state.cacheVersion
    state.activeLayersCacheFocused = focused
    state.activeLayersCache = getActiveLayersForFocused(state.sortedLayers, host, focused) as RegisteredLayer<
      TTarget,
      TEvent
    >[]
  }

  return collectActiveCommands(state.activeLayersCache, conditions, true)
}
