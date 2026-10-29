import type { ActivationService } from "./activation.js"
import type { CommandCatalogService } from "./command-catalog.js"
import type { ConditionService } from "./conditions.js"
import type { LayerService } from "./layers.js"
import type { State } from "./state.js"
import type { KeymapEvent, KeymapHost, Layer, RegisteredLayer } from "../types.js"

export const KEYMAP_EXTENSION_CONTEXT = Symbol("keymap-extension-context")

export interface KeymapExtensionContext<TTarget extends object, TEvent extends KeymapEvent> {
  state: State<TTarget, TEvent>
  host: KeymapHost<TTarget, TEvent>
  conditions: ConditionService<TTarget, TEvent>
  catalog: CommandCatalogService<TTarget, TEvent>
  activation: ActivationService<TTarget, TEvent>
  layers: Pick<LayerService<TTarget, TEvent>, "createSlot" | "replaceLayer">
}

export interface KeymapExtensionProvider<TTarget extends object, TEvent extends KeymapEvent> {
  [KEYMAP_EXTENSION_CONTEXT](): KeymapExtensionContext<TTarget, TEvent>
}

// Holds one layer registration, in the mount order of the slot's creation, that the adapters' `useBindings`
// replace on every update.
export function createLayerSlot<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: KeymapExtensionProvider<TTarget, TEvent>,
): (layer: Layer<TTarget, TEvent> | undefined) => RegisteredLayer<TTarget, TEvent> | undefined {
  const { layers } = keymap[KEYMAP_EXTENSION_CONTEXT]()
  const slot = layers.createSlot()
  return (layer) => layers.replaceLayer(slot, layer)
}
