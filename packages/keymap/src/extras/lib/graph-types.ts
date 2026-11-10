import type {
  ActiveKey,
  Attributes,
  BindingCommand,
  BindingEvent,
  Command,
  KeymapEvent,
  KeyMatch,
  KeySequencePart,
  NormalizedKeyStroke,
  TargetMode,
} from "../../types.js"

export interface GraphSnapshotOptions<TTarget extends object = object> {
  focused?: TTarget | null
  includeTargets?: boolean
}

export type GraphInactiveReason =
  | "focus"
  | "target-destroyed"
  | "layer-disabled"
  | "binding-disabled"
  | "command-disabled"
  | "command-inactive"
  | "command-unresolved"
  | "shadowed"

export interface GraphLayer<TTarget extends object = object> {
  id: string
  order: number
  priority: number
  target?: TTarget
  targetMode?: TargetMode
  fields: Readonly<Record<string, unknown>>
  attrs?: Readonly<Attributes>
  active: boolean
  focusActive: boolean
  enabled: boolean
  inactiveReasons: readonly GraphInactiveReason[]
  rootNodeId: string
  bindingIds: readonly string[]
  commandIds: readonly string[]
}

export interface GraphCommand<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  id: string
  layerId: string
  name: string
  command: Command<TTarget, TEvent>
  fields: Readonly<Record<string, unknown>>
  attrs?: Readonly<Attributes>
  target?: TTarget
  active: boolean
  reachable: boolean
  enabled: boolean
  inactiveReasons: readonly GraphInactiveReason[]
}

export interface GraphBinding<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  id: string
  layerId: string
  sourceLayerOrder: number
  bindingIndex: number
  nodeId?: string
  commandIds: readonly string[]
  sequence: readonly KeySequencePart[]
  command?: BindingCommand<TTarget, TEvent>
  commandAttrs?: Readonly<Attributes>
  attrs?: Readonly<Attributes>
  event: BindingEvent
  preventDefault: boolean
  fallthrough: boolean
  active: boolean
  reachable: boolean
  enabled: boolean
  commandResolved: boolean
  shadowed: boolean
  inactiveReasons: readonly GraphInactiveReason[]
}

export interface GraphSequenceNode {
  id: string
  layerId: string
  parentId: string | null
  childIds: readonly string[]
  bindingIds: readonly string[]
  reachableBindingIds: readonly string[]
  depth: number
  sequence: readonly KeySequencePart[]
  stroke: NormalizedKeyStroke | null
  match: KeyMatch | null
  display: string
  tokenName?: string
  active: boolean
  reachable: boolean
  pending: boolean
  pendingPath: boolean
}

export interface GraphSnapshot<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  focused?: TTarget | null
  pendingSequence: readonly KeySequencePart[]
  activeKeys: readonly ActiveKey<TTarget, TEvent>[]
  layers: readonly GraphLayer<TTarget>[]
  commands: readonly GraphCommand<TTarget, TEvent>[]
  bindings: readonly GraphBinding<TTarget, TEvent>[]
  sequenceNodes: readonly GraphSequenceNode[]
}
