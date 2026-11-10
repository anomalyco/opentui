import type { ActivationService } from "../../services/activation.js"
import type { CommandCatalogService } from "../../services/command-catalog.js"
import type { ConditionService } from "../../services/conditions.js"
import type { State } from "../../services/state.js"
import type {
  BindingState,
  CommandState,
  KeymapEvent,
  KeymapHost,
  KeySequencePart,
  RegisteredLayer,
  SequenceNode,
} from "../../types.js"
import type {
  GraphBinding,
  GraphCommand,
  GraphInactiveReason,
  GraphLayer,
  GraphSequenceNode,
  GraphSnapshot,
  GraphSnapshotOptions,
} from "./graph-types.js"
import { cloneKeySequence, cloneKeyStroke } from "../../services/keys.js"
import {
  getActivationPath,
  getFocusedTargetIfAvailable,
  getSortedLayers,
  isLayerActiveForFocused,
} from "../../services/primitives/active-layers.js"
import { childNodes, getCaptureNode, getNodePresentation, getNodeSequence } from "../../services/sequence-index.js"

interface LayerGraphState<TTarget extends object, TEvent extends KeymapEvent> {
  layer: RegisteredLayer<TTarget, TEvent>
  id: string
  focusActive: boolean
  enabled: boolean
  active: boolean
  inactiveReasons: GraphInactiveReason[]
}

interface BindingGraphState<TTarget extends object, TEvent extends KeymapEvent> {
  binding: BindingState<TTarget, TEvent>
  id: string
  layerState: LayerGraphState<TTarget, TEvent>
  commandIds: string[]
  enabled: boolean
  commandResolved: boolean
  active: boolean
  reachable: boolean
  shadowed: boolean
  inactiveReasons: GraphInactiveReason[]
}

interface CommandGraphState<TTarget extends object, TEvent extends KeymapEvent> {
  command: CommandState<TTarget, TEvent>
  id: string
  layerState: LayerGraphState<TTarget, TEvent>
  active: boolean
  reachable: boolean
  enabled: boolean
  inactiveReasons: GraphInactiveReason[]
}

interface SequenceStop {
  event: string
  matches: readonly string[]
}

function hasOwnFocused<TTarget extends object>(
  options: GraphSnapshotOptions<TTarget> | undefined,
): options is GraphSnapshotOptions<TTarget> & { focused: TTarget | null | undefined } {
  return !!options && Object.prototype.hasOwnProperty.call(options, "focused")
}

function layerId<TTarget extends object, TEvent extends KeymapEvent>(layer: RegisteredLayer<TTarget, TEvent>): string {
  return `layer:${layer.order}`
}

function bindingId<TTarget extends object, TEvent extends KeymapEvent>(
  layer: RegisteredLayer<TTarget, TEvent>,
  index: number,
): string {
  return `binding:${layer.order}:${index}`
}

function commandId<TTarget extends object, TEvent extends KeymapEvent>(
  layer: RegisteredLayer<TTarget, TEvent>,
  index: number,
): string {
  return `command:${layer.order}:${index}`
}

function nodeId<TTarget extends object, TEvent extends KeymapEvent>(
  layer: RegisteredLayer<TTarget, TEvent>,
  index: number,
): string {
  return `node:${layer.order}:${index}`
}

function getSequenceMatches(sequence: readonly KeySequencePart[]): string[] {
  return sequence.map((part) => part.match)
}

function isPrefix(left: readonly string[], right: readonly string[]): boolean {
  if (left.length > right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }

  return true
}

function collectPendingNodes<TTarget extends object, TEvent extends KeymapEvent>(
  pending: State<TTarget, TEvent>["pending"],
  layerIds: ReadonlyMap<RegisteredLayer<TTarget, TEvent>, string>,
  nodeIds: ReadonlyMap<SequenceNode<TTarget, TEvent>, string>,
  roots: ReadonlyMap<RegisteredLayer<TTarget, TEvent>, SequenceNode<TTarget, TEvent>>,
): { pending: Set<string>; pendingPath: Set<string> } {
  const pendingIds = new Set<string>()
  const pendingPathIds = new Set<string>()

  if (!pending) {
    return { pending: pendingIds, pendingPath: pendingPathIds }
  }

  for (const capture of pending.captures) {
    const layerGraphId = layerIds.get(capture.layer)
    if (!layerGraphId) {
      continue
    }

    const root = roots.get(capture.layer)
    if (!root) {
      continue
    }

    let current: SequenceNode<TTarget, TEvent> | null = getCaptureNode(root, capture) ?? null
    const capturedNodeId = current ? nodeIds.get(current) : undefined
    if (capturedNodeId) {
      pendingIds.add(capturedNodeId)
    }

    while (current) {
      const currentNodeId = nodeIds.get(current)
      if (currentNodeId) {
        pendingPathIds.add(currentNodeId)
      }
      current = current.parent
    }
  }

  return { pending: pendingIds, pendingPath: pendingPathIds }
}

export function createGraphSnapshot<TTarget extends object, TEvent extends KeymapEvent>(options: {
  state: State<TTarget, TEvent>
  host: KeymapHost<TTarget, TEvent>
  conditions: ConditionService<TTarget, TEvent>
  catalog: CommandCatalogService<TTarget, TEvent>
  activation: ActivationService<TTarget, TEvent>
  snapshotOptions?: GraphSnapshotOptions<TTarget>
}): GraphSnapshot<TTarget, TEvent> {
  const { state, host, conditions, catalog, activation, snapshotOptions } = options
  const includeTargets = snapshotOptions?.includeTargets !== false
  const currentFocused = getFocusedTargetIfAvailable(host)
  const focused = hasOwnFocused(snapshotOptions) ? (snapshotOptions.focused ?? null) : currentFocused
  const activeView = catalog.getActiveCommandView(focused)
  const activeCommandStates = new Set(activeView.entries.map((entry) => entry.commandState))
  const reachableCommandStates = new Set(activeView.reachable.map((entry) => entry.commandState))
  const activationPath = getActivationPath(host, focused)
  const sortedLayers = getSortedLayers(state.layers)
  const layerStates = new Map<RegisteredLayer<TTarget, TEvent>, LayerGraphState<TTarget, TEvent>>()
  const commandStates = new Map<CommandState<TTarget, TEvent>, CommandGraphState<TTarget, TEvent>>()
  const bindingStates = new Map<BindingState<TTarget, TEvent>, BindingGraphState<TTarget, TEvent>>()
  const commandIdsByCommand = new Map<CommandState<TTarget, TEvent>["command"], string[]>()
  const commandIdsByName = new Map<string, string[]>()
  const nodeIds = new Map<SequenceNode<TTarget, TEvent>, string>()
  const layerIds = new Map<RegisteredLayer<TTarget, TEvent>, string>()
  const layerRoots = new Map<RegisteredLayer<TTarget, TEvent>, SequenceNode<TTarget, TEvent>>()
  const bindingNodeIds = new Map<BindingState<TTarget, TEvent>, string>()
  const sequenceNodes: GraphSequenceNode[] = []

  for (const layer of sortedLayers) {
    layerRoots.set(layer, layer.root)
  }

  for (const layer of sortedLayers) {
    const currentLayerId = layerId(layer)
    const targetDestroyed = layer.target ? host.isTargetDestroyed(layer.target) : false
    const focusActive = isLayerActiveForFocused(host, layer, focused, activationPath)
    const enabled = conditions.matchesConditions(layer)
    const inactiveReasons: GraphInactiveReason[] = []
    if (targetDestroyed) inactiveReasons.push("target-destroyed")
    if (!focusActive) inactiveReasons.push("focus")
    if (!enabled) inactiveReasons.push("layer-disabled")

    layerIds.set(layer, currentLayerId)
    layerStates.set(layer, {
      layer,
      id: currentLayerId,
      focusActive,
      enabled,
      active: !targetDestroyed && focusActive && enabled,
      inactiveReasons,
    })
  }

  for (const layer of sortedLayers) {
    const currentLayerId = layerIds.get(layer)!
    for (const [index, command] of layer.commands.entries()) {
      const currentCommandId = commandId(layer, index)
      const idsByCommand = commandIdsByCommand.get(command.command)
      if (idsByCommand) {
        idsByCommand.push(currentCommandId)
      } else {
        commandIdsByCommand.set(command.command, [currentCommandId])
      }

      const idsByName = commandIdsByName.get(command.command.name)
      if (idsByName) {
        idsByName.push(currentCommandId)
      } else {
        commandIdsByName.set(command.command.name, [currentCommandId])
      }

      const layerState = layerStates.get(layer)!
      const enabled = conditions.matchesConditions(command)
      const active = activeCommandStates.has(command)
      const reachable = reachableCommandStates.has(command)
      const inactiveReasons = [...layerState.inactiveReasons]
      if (!enabled) {
        inactiveReasons.push("command-disabled")
      }
      if (active && !reachable) {
        inactiveReasons.push("shadowed")
      }
      commandStates.set(command, {
        command,
        id: currentCommandId,
        layerState,
        active,
        reachable,
        enabled,
        inactiveReasons,
      })
    }

    let nextNodeIndex = 0
    const visitNode = (node: SequenceNode<TTarget, TEvent>, parentId: string | null): void => {
      const currentNodeId = nodeId(layer, nextNodeIndex)
      nextNodeIndex += 1
      nodeIds.set(node, currentNodeId)

      for (const binding of node.bindings) {
        bindingNodeIds.set(binding, currentNodeId)
      }

      for (const child of childNodes(node)) {
        visitNode(child, currentNodeId)
      }
    }

    const root = layerRoots.get(layer)!
    visitNode(root, null)
    if (!nodeIds.has(root)) {
      nodeIds.set(root, `${currentLayerId}:root`)
    }
  }

  const stoppedSequences: SequenceStop[] = []
  for (const layer of sortedLayers) {
    const layerState = layerStates.get(layer)!
    for (const [index, binding] of layer.bindings.entries()) {
      const enabled = conditions.matchesConditions(binding)
      const commandResolved = catalog.isBindingVisible(binding, focused, activeView)
      const active = layerState.active && enabled && commandResolved
      const matches = getSequenceMatches(binding.sequence)
      const shadowed =
        active && stoppedSequences.some((stop) => stop.event === binding.event && isPrefix(stop.matches, matches))
      const inactiveReasons = [...layerState.inactiveReasons]
      if (!enabled) {
        inactiveReasons.push("binding-disabled")
      }
      if (!commandResolved) {
        const unavailable =
          typeof binding.command === "string"
            ? catalog.getDispatchUnavailableCommandState(binding.command, focused, false)
            : undefined
        if (unavailable?.reason === "disabled") {
          inactiveReasons.push("command-disabled")
        } else if (unavailable?.reason === "inactive") {
          inactiveReasons.push("command-inactive")
        } else {
          inactiveReasons.push("command-unresolved")
        }
      }
      if (shadowed) {
        inactiveReasons.push("shadowed")
      }

      const currentBindingState: BindingGraphState<TTarget, TEvent> = {
        binding,
        id: bindingId(layer, index),
        layerState,
        commandIds: [],
        enabled,
        commandResolved,
        active,
        reachable: active && !shadowed,
        shadowed,
        inactiveReasons,
      }
      bindingStates.set(binding, currentBindingState)

      if (active && binding.command !== undefined && !binding.fallthrough) {
        stoppedSequences.push({ event: binding.event, matches })
      }
    }
  }

  for (const state of bindingStates.values()) {
    if (typeof state.binding.command !== "string") {
      continue
    }

    const ids = new Set(commandIdsByName.get(state.binding.command) ?? [])
    const chain = catalog.getResolvedCommandChain(state.binding.command, focused).entries
    for (const entry of chain ?? []) {
      for (const id of commandIdsByCommand.get(entry.command) ?? []) {
        ids.add(id)
      }
    }
    state.commandIds = [...ids]
  }

  const pending = focused === currentFocused ? activation.ensureValidPendingSequence() : undefined
  const pendingNodes = collectPendingNodes(pending ?? null, layerIds, nodeIds, layerRoots)

  for (const layer of sortedLayers) {
    const currentLayerId = layerIds.get(layer)!
    const visitNode = (node: SequenceNode<TTarget, TEvent>, parentId: string | null): void => {
      const currentNodeId = nodeIds.get(node)!
      const childIds = childNodes(node)
        .map((child) => nodeIds.get(child)!)
        .filter(Boolean)
      const bindingIds = node.bindings
        .map((binding) => bindingStates.get(binding)?.id)
        .filter((id): id is string => !!id)
      const reachableBindingIds = node.reachableBindings
        .map((binding) => bindingStates.get(binding)?.id)
        .filter((id): id is string => !!id)
      const sequence = getNodeSequence(node)
      const presentation = getNodePresentation(node)
      const active = node.reachableBindings.some((binding) => bindingStates.get(binding)?.active === true)
      const reachable = node.reachableBindings.some((binding) => bindingStates.get(binding)?.reachable === true)

      for (let index = 0; index < sequence.length; index += 1) {
        const sourcePart = node.reachableBindings[0]?.sequence[index]
        if (sourcePart) {
          sequence[index] = { ...sourcePart, stroke: cloneKeyStroke(sourcePart.stroke) }
        }
      }

      sequenceNodes.push({
        id: currentNodeId,
        layerId: currentLayerId,
        parentId,
        childIds,
        bindingIds,
        reachableBindingIds,
        depth: node.depth,
        sequence,
        stroke: node.stroke ? cloneKeyStroke(node.stroke) : null,
        match: node.match,
        display: presentation.display,
        tokenName: presentation.tokenName,
        active,
        reachable,
        pending: pendingNodes.pending.has(currentNodeId),
        pendingPath: pendingNodes.pendingPath.has(currentNodeId),
      })

      for (const child of childNodes(node)) {
        visitNode(child, currentNodeId)
      }
    }

    visitNode(layerRoots.get(layer)!, null)
  }

  const layers: GraphLayer<TTarget>[] = sortedLayers.map((layer) => {
    const state = layerStates.get(layer)!
    return {
      id: state.id,
      order: layer.order,
      priority: layer.priority,
      target: includeTargets ? layer.target : undefined,
      targetMode: layer.targetMode,
      fields: layer.fields ?? {},
      attrs: layer.attrs,
      active: state.active,
      focusActive: state.focusActive,
      enabled: state.enabled,
      inactiveReasons: state.inactiveReasons,
      rootNodeId: nodeIds.get(layerRoots.get(layer)!)!,
      bindingIds: layer.bindings.map((binding) => bindingStates.get(binding)!.id),
      commandIds: layer.commands.map((command) => commandStates.get(command)!.id),
    }
  })

  const commands: GraphCommand<TTarget, TEvent>[] = []
  for (const state of commandStates.values()) {
    commands.push({
      id: state.id,
      layerId: state.layerState.id,
      name: state.command.command.name,
      command: state.command.command,
      fields: state.command.fields,
      attrs: state.command.attrs,
      target: includeTargets ? state.layerState.layer.target : undefined,
      active: state.active,
      reachable: state.reachable,
      enabled: state.enabled,
      inactiveReasons: state.inactiveReasons,
    })
  }

  const bindings: GraphBinding<TTarget, TEvent>[] = []
  for (const state of bindingStates.values()) {
    const binding = state.binding
    bindings.push({
      id: state.id,
      layerId: state.layerState.id,
      sourceLayerOrder: binding.sourceLayerOrder,
      bindingIndex: binding.bindingIndex,
      nodeId: bindingNodeIds.get(binding),
      commandIds: state.commandIds,
      sequence: cloneKeySequence(binding.sequence),
      command: binding.command,
      commandAttrs: catalog.getBindingCommandAttrs(binding, focused, activeView),
      attrs: binding.attrs,
      event: binding.event,
      preventDefault: binding.preventDefault,
      fallthrough: binding.fallthrough,
      active: state.active,
      reachable: state.reachable,
      enabled: state.enabled,
      commandResolved: state.commandResolved,
      shadowed: state.shadowed,
      inactiveReasons: state.inactiveReasons,
    })
  }

  const activeKeys = activation.getActiveKeysForFocused(focused, { includeBindings: true, includeMetadata: true })

  return {
    focused: includeTargets ? focused : undefined,
    pendingSequence: focused === currentFocused ? activation.getPendingSequence() : [],
    activeKeys,
    layers,
    commands,
    bindings,
    sequenceNodes,
  }
}
