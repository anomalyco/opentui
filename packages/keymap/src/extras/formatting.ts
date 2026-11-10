import type { KeySequencePart } from "../types.js"

export type KeyModifierName = "ctrl" | "shift" | "meta" | "super" | "hyper"

export interface KeySequenceFormatPart {
  stroke: KeySequencePart["stroke"]
  display: string
  match?: KeySequencePart["match"]
  tokenName?: string
  patternName?: string
}

export type TokenDisplayResolver =
  | Readonly<Record<string, string>>
  | ((tokenName: string, part: KeySequenceFormatPart) => string | undefined)

export type PatternDisplayResolver =
  | Readonly<Record<string, string>>
  | ((patternName: string, part: KeySequenceFormatPart) => string | undefined)

export interface FormatKeySequenceOptions {
  tokenDisplay?: TokenDisplayResolver
  patternDisplay?: PatternDisplayResolver
  keyNameAliases?: Readonly<Record<string, string>>
  modifierAliases?: Partial<Record<KeyModifierName, string>>
  separator?: string
}

export interface FormatCommandBindingsOptions extends FormatKeySequenceOptions {
  bindingSeparator?: string
  dedupe?: boolean
}

export interface SequenceBindingLike {
  sequence: readonly KeySequenceFormatPart[]
}

function formatStroke(part: KeySequenceFormatPart, options: FormatKeySequenceOptions): string {
  if (part.tokenName) {
    const tokenDisplay = options.tokenDisplay
    if (!tokenDisplay) return part.display
    if (typeof tokenDisplay === "function") return tokenDisplay(part.tokenName, part) ?? part.display
    return tokenDisplay[part.tokenName] ?? part.display
  }

  if (part.patternName) {
    const patternDisplay = options.patternDisplay
    if (!patternDisplay) return part.display
    if (typeof patternDisplay === "function") return patternDisplay(part.patternName, part) ?? part.display
    return patternDisplay[part.patternName] ?? part.display
  }

  if (!options.keyNameAliases && !options.modifierAliases) return part.display

  // This is on the command-palette hot path; build directly to avoid per-stroke arrays.
  const stroke = part.stroke
  const modifierAliases = options.modifierAliases
  let formatted = ""
  let pieceCount = 0

  if (stroke.ctrl) {
    formatted = modifierAliases?.ctrl ?? "ctrl"
    pieceCount = 1
  }

  if (stroke.shift) {
    const alias = modifierAliases?.shift ?? "shift"
    formatted = pieceCount === 0 ? alias : `${formatted}+${alias}`
    pieceCount += 1
  }

  if (stroke.meta) {
    const alias = modifierAliases?.meta ?? "meta"
    formatted = pieceCount === 0 ? alias : `${formatted}+${alias}`
    pieceCount += 1
  }

  if (stroke.super) {
    const alias = modifierAliases?.super ?? "super"
    formatted = pieceCount === 0 ? alias : `${formatted}+${alias}`
    pieceCount += 1
  }

  if (stroke.hyper) {
    const alias = modifierAliases?.hyper ?? "hyper"
    formatted = pieceCount === 0 ? alias : `${formatted}+${alias}`
    pieceCount += 1
  }

  const name = stroke.name === "return" ? "enter" : stroke.name
  const keyName = options.keyNameAliases?.[name] ?? name
  return pieceCount === 0 ? keyName : `${formatted}+${keyName}`
}

export function formatKeySequence(
  parts: readonly KeySequenceFormatPart[] | undefined,
  options: FormatKeySequenceOptions = {},
): string {
  if (!parts || parts.length === 0) return ""

  // Avoid map/join allocation here; binding-list formatting calls this repeatedly.
  const separator = options.separator ?? " "
  let formatted = formatStroke(parts[0]!, options)
  for (let index = 1; index < parts.length; index += 1) {
    formatted += separator + formatStroke(parts[index]!, options)
  }

  return formatted
}

export function formatCommandBindings(
  bindings: readonly SequenceBindingLike[] | undefined,
  options: FormatCommandBindingsOptions = {},
): string | undefined {
  if (!bindings?.length) return

  const bindingSeparator = options.bindingSeparator ?? ", "
  const dedupe = options.dedupe !== false
  const seen = dedupe ? new Set<string>() : undefined
  let formatted = ""
  let itemCount = 0

  // One pass keeps dedupe, filtering, and joining allocation-light for large binding lists.
  for (const binding of bindings) {
    const item = formatKeySequence(binding.sequence, options)
    if (!item) continue

    if (seen) {
      if (seen.has(item)) continue
      seen.add(item)
    }

    formatted = itemCount === 0 ? item : `${formatted}${bindingSeparator}${item}`
    itemCount += 1
  }

  return formatted
}
