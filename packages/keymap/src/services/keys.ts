import type {
  KeyMatch,
  KeySequencePart,
  KeyStrokeInput,
  KeyStringifyInput,
  KeymapEvent,
  NormalizedKeyStroke,
  StringifyOptions,
} from "../types.js"

export function normalizeBindingTokenName(token: string): string {
  const normalized = token.trim().toLowerCase()
  if (!normalized) {
    throw new Error("Invalid keymap token: token cannot be empty")
  }

  return normalized
}

export function normalizeKeyName(name: string): string {
  const normalized = name.trim().toLowerCase()
  if (!normalized) {
    throw new Error("Invalid key name: key name cannot be empty")
  }

  return normalized
}

export function normalizeKeyStroke(input: KeyStrokeInput): NormalizedKeyStroke {
  return {
    name: normalizeKeyName(input.name),
    ctrl: input.ctrl ?? false,
    shift: input.shift ?? false,
    meta: input.meta ?? false,
    super: input.super ?? false,
    hyper: input.hyper || undefined,
  }
}

export function normalizeEventKeyStroke(event: KeymapEvent): NormalizedKeyStroke {
  return {
    name: normalizeKeyName(event.name),
    ctrl: event.ctrl,
    shift: event.shift,
    meta: event.meta,
    super: event.super ?? false,
    hyper: event.hyper || undefined,
  }
}

export function cloneKeyStroke(stroke: NormalizedKeyStroke): NormalizedKeyStroke {
  return {
    name: stroke.name,
    ctrl: stroke.ctrl,
    shift: stroke.shift,
    meta: stroke.meta,
    super: stroke.super,
    hyper: stroke.hyper || undefined,
  }
}

export function createKeySequencePart(
  input: KeyStrokeInput,
  options?: {
    display?: string
    match?: KeyMatch
    tokenName?: string
  },
): KeySequencePart {
  const stroke = cloneKeyStroke(normalizeKeyStroke(input))

  return {
    stroke,
    display: options?.display ?? stringifyCanonicalStroke(stroke),
    match: options?.match ?? createKeyMatch(stroke),
    tokenName: options?.tokenName ? normalizeBindingTokenName(options.tokenName) : undefined,
  }
}

export function cloneKeySequencePart(part: KeySequencePart): KeySequencePart {
  return {
    stroke: cloneKeyStroke(part.stroke),
    display: part.display,
    match: part.match,
    tokenName: part.tokenName,
    patternName: part.patternName,
    payloadKey: part.payloadKey,
  }
}

export function cloneKeySequence(parts: readonly KeySequencePart[]): KeySequencePart[] {
  return parts.map((part) => cloneKeySequencePart(part))
}

export function resolveKeyMatch(input: KeyStringifyInput): KeyMatch {
  if ("match" in input) {
    return input.match
  }

  if ("stroke" in input) {
    return createKeyMatch(input.stroke)
  }

  return createKeyMatch(input)
}

export function createKeyMatch(input: KeyStrokeInput): KeyMatch {
  return `key:${buildKeyMatchId(normalizeKeyStroke(input))}`
}

export function createTextKeyMatch(id: string): KeyMatch {
  const normalized = id.trim()
  if (!normalized) {
    throw new Error("Invalid keymap match id: id cannot be empty")
  }

  return `text:${normalized}`
}

export function stringifyKeyStroke(input: KeyStringifyInput, options?: StringifyOptions): string {
  if ("stroke" in input) {
    if (options?.preferDisplay && input.display) {
      return input.display
    }

    return stringifyCanonicalStroke(input.stroke)
  }

  return stringifyCanonicalStroke(normalizeKeyStroke(input))
}

export function stringifyKeySequence(input: readonly KeyStringifyInput[], options?: StringifyOptions): string {
  return input.map((part) => stringifyKeyStroke(part, options)).join(options?.separator ?? "")
}

function stringifyCanonicalStroke(stroke: NormalizedKeyStroke): string {
  const parts: string[] = []
  if (stroke.ctrl) {
    parts.push("ctrl")
  }

  if (stroke.shift) {
    parts.push("shift")
  }

  if (stroke.meta) {
    parts.push("meta")
  }

  if (stroke.super) {
    parts.push("super")
  }

  if (stroke.hyper) {
    parts.push("hyper")
  }

  parts.push(stroke.name === "return" ? "enter" : stroke.name)
  return parts.join("+")
}

function buildKeyMatchId(stroke: NormalizedKeyStroke): string {
  return `${stroke.name}:${stroke.ctrl ? 1 : 0}:${stroke.shift ? 1 : 0}:${stroke.meta ? 1 : 0}:${stroke.super ? 1 : 0}:${stroke.hyper ? 1 : 0}`
}
