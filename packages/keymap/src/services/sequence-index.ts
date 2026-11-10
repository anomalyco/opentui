import type {
  BindingState,
  KeymapEvent,
  KeySequencePart,
  KeyMatch,
  PendingSequenceCapture,
  PendingSequencePatternCapture,
  RegisteredLayer,
  ResolvedSequencePattern,
  SequenceNode,
  SequencePatternMatch,
} from "../types.js"
import { cloneKeyStroke, stringifyKeyStroke } from "./keys.js"
import { captureHasMinimum, patternCaptureCount } from "./primitives/pending-captures.js"

export interface SequenceActiveOption<TTarget extends object, TEvent extends KeymapEvent> {
  part: KeySequencePart
  binding: BindingState<TTarget, TEvent>
  index: number
  exact: boolean
  continues: boolean
}

export function createSequenceNode<TTarget extends object, TEvent extends KeymapEvent>(
  parent: SequenceNode<TTarget, TEvent> | null,
  stroke: KeySequencePart["stroke"] | null,
  match: KeySequencePart["match"] | null,
  pattern?: ResolvedSequencePattern<TEvent>,
): SequenceNode<TTarget, TEvent> {
  return {
    parent,
    depth: parent ? parent.depth + 1 : 0,
    stroke,
    match,
    pattern,
    children: new Map(),
    patternChildren: [],
    bindings: [],
    reachableBindings: [],
  }
}

export function buildSequenceTree<TTarget extends object, TEvent extends KeymapEvent>(
  bindings: readonly BindingState<TTarget, TEvent>[],
  patterns: ReadonlyMap<string, ResolvedSequencePattern<TEvent>>,
): SequenceNode<TTarget, TEvent> {
  const root = createSequenceNode<TTarget, TEvent>(null, null, null)
  for (const binding of bindings) {
    if (binding.event !== "press") {
      continue
    }

    let node = root
    for (const part of binding.sequence) {
      let child: SequenceNode<TTarget, TEvent> | undefined
      if (part.patternName) {
        const pattern = patterns.get(part.patternName)
        child = node.patternChildren.find((candidate) => candidate.pattern?.name === part.patternName)
        if (!child) {
          child = createSequenceNode(node, part.stroke, part.match, pattern)
          node.patternChildren.push(child)
        }
      } else {
        child = node.children.get(part.match)
        if (!child) {
          child = createSequenceNode(node, part.stroke, part.match)
          node.children.set(part.match, child)
        }
      }

      child.reachableBindings.push(binding)
      node = child
    }

    node.bindings.push(binding)
  }

  return root
}

export function getCaptureNode<TTarget extends object, TEvent extends KeymapEvent>(
  root: SequenceNode<TTarget, TEvent>,
  capture: import("../types.js").PendingSequenceCapture<TTarget, TEvent>,
): SequenceNode<TTarget, TEvent> | undefined {
  let node: SequenceNode<TTarget, TEvent> | undefined = root
  for (let index = 0; index <= capture.index; index += 1) {
    const part = capture.binding.sequence[index]
    if (!part || !node) {
      return undefined
    }

    node = part.patternName
      ? node.patternChildren.find((candidate) => candidate.pattern?.name === part.patternName)
      : node.children.get(part.match)
  }

  return node
}

export function getNodeSequence<TTarget extends object, TEvent extends KeymapEvent>(
  node: SequenceNode<TTarget, TEvent>,
): KeySequencePart[] {
  const parts: KeySequencePart[] = []
  let current: SequenceNode<TTarget, TEvent> | null = node

  while (current?.stroke && current.match) {
    parts.push({
      stroke: cloneKeyStroke(current.stroke),
      display: "",
      match: current.match,
    })
    current = current.parent
  }

  parts.reverse()
  return parts
}

export function getNodePresentation<TTarget extends object, TEvent extends KeymapEvent>(
  node: SequenceNode<TTarget, TEvent>,
): { display: string; tokenName?: string } {
  if (!node.stroke || node.depth === 0) {
    return { display: "" }
  }

  const partIndex = node.depth - 1
  for (const binding of node.reachableBindings) {
    const part = binding.sequence[partIndex]
    if (part) {
      return { display: part.display, tokenName: part.tokenName }
    }
  }

  return { display: stringifyKeyStroke(node.stroke) }
}

export function firstNodeForMatch<TTarget extends object, TEvent extends KeymapEvent>(
  root: SequenceNode<TTarget, TEvent>,
  match: KeyMatch,
): SequenceNode<TTarget, TEvent> | undefined {
  return root.children.get(match) ?? root.patternChildren.find((node) => node.match === match)
}

export function childNodes<TTarget extends object, TEvent extends KeymapEvent>(
  node: SequenceNode<TTarget, TEvent>,
): SequenceNode<TTarget, TEvent>[] {
  return [...node.children.values(), ...node.patternChildren]
}

export function activeOptionsForBindings<TTarget extends object, TEvent extends KeymapEvent>(
  bindings: readonly BindingState<TTarget, TEvent>[],
): SequenceActiveOption<TTarget, TEvent>[] {
  const options: SequenceActiveOption<TTarget, TEvent>[] = []
  for (const binding of bindings) {
    const part = binding.sequence[0]
    if (part) {
      options.push({
        part,
        binding,
        index: 0,
        exact: binding.sequence.length === 1,
        continues: binding.sequence.length > 1,
      })
    }
  }

  return options
}

export function activeOptionsForCaptures<TTarget extends object, TEvent extends KeymapEvent>(
  captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
  patterns: ReadonlyMap<string, ResolvedSequencePattern<TEvent>>,
): SequenceActiveOption<TTarget, TEvent>[] {
  const options: SequenceActiveOption<TTarget, TEvent>[] = []
  for (const capture of captures) {
    if (!captureHasMinimum(capture, patterns)) {
      continue
    }

    const index = capture.index + 1
    const part = capture.binding.sequence[index]
    if (part) {
      options.push({
        part,
        binding: capture.binding,
        index,
        exact: index === capture.binding.sequence.length - 1,
        continues: index < capture.binding.sequence.length - 1,
      })
    }
  }

  return options
}

function appendPatternCapture<TTarget extends object, TEvent extends KeymapEvent>(
  capture: PendingSequenceCapture<TTarget, TEvent>,
  index: number,
  part: KeySequencePart,
  value: unknown,
): PendingSequenceCapture<TTarget, TEvent> {
  const patternName = part.patternName
  if (!patternName) {
    return { ...capture, index }
  }

  const patterns = [...(capture.patterns ?? [])]
  const last = patterns.at(-1)

  if (last?.name === patternName) {
    patterns[patterns.length - 1] = {
      ...last,
      values: [...last.values, value],
      parts: [...last.parts, part],
    }
  } else {
    patterns.push({
      name: patternName,
      payloadKey: part.payloadKey ?? patternName,
      values: [value],
      parts: [part],
    })
  }

  return {
    layer: capture.layer,
    binding: capture.binding,
    index,
    parts: [...capture.parts, part],
    patterns,
  }
}

export function capturePriority<TTarget extends object, TEvent extends KeymapEvent>(
  capture: PendingSequenceCapture<TTarget, TEvent>,
  matchKeys: readonly KeyMatch[],
): number {
  const part = capture.parts.at(-1)
  if (!part || part.patternName) {
    return matchKeys.length
  }

  const index = matchKeys.indexOf(part.match)
  return index === -1 ? matchKeys.length : index
}

export function advanceSequenceBinding<TTarget extends object, TEvent extends KeymapEvent>(
  layer: RegisteredLayer<TTarget, TEvent>,
  binding: BindingState<TTarget, TEvent>,
  index: number,
  parts: readonly KeySequencePart[],
  patterns: readonly PendingSequencePatternCapture[] | undefined,
  matchKeys: readonly KeyMatch[],
  event: TEvent,
  matchPattern: (patternName: string, event: TEvent) => SequencePatternMatch | undefined,
  createPatternPart: (event: TEvent, patternName: string, match: SequencePatternMatch) => KeySequencePart,
): PendingSequenceCapture<TTarget, TEvent> | undefined {
  const part = binding.sequence[index]
  if (!part) {
    return undefined
  }

  if (part.patternName) {
    const patternMatch = matchPattern(part.patternName, event)
    if (!patternMatch) {
      return undefined
    }

    const eventPart = createPatternPart(event, part.patternName, patternMatch)
    return appendPatternCapture(
      { layer, binding, index, parts, patterns },
      index,
      eventPart,
      patternMatch.value ?? event.name,
    )
  }

  if (!matchKeys.includes(part.match)) {
    return undefined
  }

  return { layer, binding, index, parts: [...parts, part], patterns }
}

export function advanceSequenceCapture<TTarget extends object, TEvent extends KeymapEvent>(
  capture: PendingSequenceCapture<TTarget, TEvent>,
  matchKeys: readonly KeyMatch[],
  event: TEvent,
  patterns: ReadonlyMap<string, ResolvedSequencePattern<TEvent>>,
  matchPattern: (patternName: string, event: TEvent) => SequencePatternMatch | undefined,
  createPatternPart: (event: TEvent, patternName: string, match: SequencePatternMatch) => KeySequencePart,
): PendingSequenceCapture<TTarget, TEvent> | undefined {
  const currentPart = capture.binding.sequence[capture.index]
  if (currentPart?.patternName) {
    const pattern = patterns.get(currentPart.patternName)
    if (pattern && patternCaptureCount(capture) < pattern.max) {
      const patternMatch = matchPattern(pattern.name, event)
      if (patternMatch) {
        const part = createPatternPart(event, pattern.name, patternMatch)
        return appendPatternCapture(capture, capture.index, part, patternMatch.value ?? event.name)
      }
    }

    if (!captureHasMinimum(capture, patterns, false)) {
      return undefined
    }

    return advanceSequenceBinding(
      capture.layer,
      capture.binding,
      capture.index + 1,
      capture.parts,
      capture.patterns,
      matchKeys,
      event,
      matchPattern,
      createPatternPart,
    )
  }

  return advanceSequenceBinding(
    capture.layer,
    capture.binding,
    capture.index + 1,
    capture.parts,
    capture.patterns,
    matchKeys,
    event,
    matchPattern,
    createPatternPart,
  )
}

export function collectRootSequenceCaptures<TTarget extends object, TEvent extends KeymapEvent>(
  layer: RegisteredLayer<TTarget, TEvent>,
  matchKeys: readonly KeyMatch[],
  event: TEvent,
  matchPattern: (patternName: string, event: TEvent) => SequencePatternMatch | undefined,
  createPatternPart: (event: TEvent, patternName: string, match: SequencePatternMatch) => KeySequencePart,
): PendingSequenceCapture<TTarget, TEvent>[] {
  const captures: PendingSequenceCapture<TTarget, TEvent>[] = []
  let bestPriority = Number.POSITIVE_INFINITY
  for (const binding of layer.bindings) {
    if (binding.event !== "press") {
      continue
    }

    const capture = advanceSequenceBinding(
      layer,
      binding,
      0,
      [],
      undefined,
      matchKeys,
      event,
      matchPattern,
      createPatternPart,
    )
    if (!capture) {
      continue
    }

    const priority = capturePriority(capture, matchKeys)
    if (priority < bestPriority) {
      bestPriority = priority
      captures.length = 0
    }

    if (priority === bestPriority) {
      captures.push(capture)
    }
  }

  return captures
}
