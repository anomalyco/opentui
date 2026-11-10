import { KEYMAP_EXTENSION_CONTEXT, type KeymapExtensionProvider } from "../services/extension-context.js"
import { createGraphSnapshot } from "./lib/graph-snapshot.js"
import type { KeymapEvent } from "../types.js"
import type { GraphSnapshot, GraphSnapshotOptions } from "./lib/graph-types.js"

export type {
  GraphBinding,
  GraphCommand,
  GraphInactiveReason,
  GraphLayer,
  GraphSequenceNode,
  GraphSnapshot,
  GraphSnapshotOptions,
} from "./lib/graph-types.js"

export interface KeymapGraphExtra<TTarget extends object, TEvent extends KeymapEvent> {
  getGraphSnapshot(options?: GraphSnapshotOptions<TTarget>): GraphSnapshot<TTarget, TEvent>
}

export function getGraphSnapshot<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: KeymapExtensionProvider<TTarget, TEvent>,
  options?: GraphSnapshotOptions<TTarget>,
): GraphSnapshot<TTarget, TEvent> {
  const context = keymap[KEYMAP_EXTENSION_CONTEXT]()
  return createGraphSnapshot({
    state: context.state,
    host: context.host,
    conditions: context.conditions,
    catalog: context.catalog,
    activation: context.activation,
    snapshotOptions: options,
  })
}

export function createGraphExtra<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: KeymapExtensionProvider<TTarget, TEvent>,
): KeymapGraphExtra<TTarget, TEvent> {
  return {
    getGraphSnapshot(options) {
      return getGraphSnapshot(keymap, options)
    },
  }
}
