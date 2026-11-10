import type { ConditionService } from "./conditions.js"
import type { State } from "./state.js"
import type { NotificationService } from "./notify.js"
import { normalizeBindingCommand } from "./primitives/command-normalization.js"
import type {
  Attributes,
  BindingCommand,
  BindingEvent,
  BindingExpansion,
  BindingExpander,
  BindingExpanderContext,
  Binding,
  BindingParser,
  BindingParserContext,
  EventData,
  ParsedBinding,
  ReactiveMatcher,
  BindingState,
  BindingCompilationResult,
  KeyLike,
  KeyMatch,
  KeymapEvent,
  KeyStrokeInput,
  KeySequencePart,
  ResolvedKeyToken,
  ResolvedSequencePattern,
  RuntimeMatcher,
  StringifyOptions,
} from "../types.js"
import { RESERVED_BINDING_FIELDS } from "../schema.js"
import {
  cloneKeySequence,
  createKeySequencePart,
  createTextKeyMatch,
  normalizeBindingTokenName,
  stringifyKeySequence,
} from "./keys.js"
import { snapshotParsedBinding } from "./primitives/bindings.js"
import { createFieldCompilerContext } from "./primitives/field-invariants.js"
import { getErrorMessage, snapshotDataValue } from "./values.js"

const EMPTY_COMPILE_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_REQUIRES: readonly [name: string, value: unknown][] = []
const EMPTY_MATCHERS: readonly RuntimeMatcher[] = []

function snapshotAttributes(attrs: Attributes): Readonly<Attributes> | undefined {
  if (Object.keys(attrs).length === 0) {
    return undefined
  }

  return snapshotDataValue(attrs, { freeze: true }) as Readonly<Attributes>
}

interface ParsedBindingSequenceResult {
  parts: KeySequencePart[]
  usedTokens: readonly string[]
  unknownTokens: readonly string[]
  hasTokenBindings: boolean
}

interface ExpandedBindingKey {
  key: KeyLike
  displays?: readonly string[]
}

export interface CompilerOptions {
  warnUnknownField: (kind: "binding" | "layer", fieldName: string) => void
  warnUnknownToken: (token: string, sequence: string) => void
}

export interface CompilerService<TTarget extends object, TEvent extends KeymapEvent> {
  parseTokenKey(key: KeyLike): KeySequencePart
  parseKeySequence(key: KeyLike): KeySequencePart[]
  formatKey(key: KeyLike, options?: StringifyOptions): string
  compileBindings(
    bindings: readonly Binding<TTarget, TEvent>[],
    tokens: ReadonlyMap<string, ResolvedKeyToken>,
    sourceTarget: TTarget | undefined,
    sourceLayerOrder: number,
    fields?: Readonly<Record<string, unknown>>,
  ): BindingCompilationResult<TTarget, TEvent>
}

export function createCompilerService<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
  notify: NotificationService<TTarget, TEvent>,
  conditions: ConditionService<TTarget, TEvent>,
  options: CompilerOptions,
): CompilerService<TTarget, TEvent> {
  const parseTokenKey = (key: KeyLike): KeySequencePart => {
    return parseSingleKeyPartWithParsers(key, state.bindingParsers.values(), {
      tokens: state.tokens,
      patterns: state.patterns,
      layer: EMPTY_COMPILE_FIELDS,
      parseObjectKey: (value, options) => parseObjectKeyPart(value, options),
    })
  }

  const parseKeySequence = (key: KeyLike): KeySequencePart[] => {
    if (typeof key !== "string") {
      return [parseObjectKeyPart(key)]
    }

    const parsed = parseBindingSequenceWithParsers(key, state.bindingParsers.values(), {
      tokens: state.tokens,
      patterns: state.patterns,
      layer: EMPTY_COMPILE_FIELDS,
      parseObjectKey: (value, options) => parseObjectKeyPart(value, options),
    })

    for (const tokenName of parsed.unknownTokens) {
      options.warnUnknownToken(tokenName, key)
    }

    if (parsed.unknownTokens.length > 0) {
      return []
    }

    return parsed.parts
  }

  const formatKey = (key: KeyLike, options?: StringifyOptions): string => {
    return stringifyKeySequence(parseKeySequence(key), options)
  }

  const compileBindings = (
    bindings: readonly Binding<TTarget, TEvent>[],
    tokens: ReadonlyMap<string, ResolvedKeyToken>,
    sourceTarget: TTarget | undefined,
    sourceLayerOrder: number,
    compileFields?: Readonly<Record<string, unknown>>,
  ): BindingCompilationResult<TTarget, TEvent> => {
    const bindingStates: BindingState<TTarget, TEvent>[] = []
    let hasTokenBindings = false
    const bindingExpanders = state.bindingExpanders.values()
    const bindingParsers = state.bindingParsers.values()
    const bindingFieldCompilers = state.bindingFields
    const allowExactPrefixAmbiguity = state.disambiguationResolvers.has()
    const warnUnknownField = options.warnUnknownField
    const warnUnknownToken = options.warnUnknownToken

    for (const [bindingIndex, binding] of bindings.entries()) {
      let expandedBindingKeys: readonly ExpandedBindingKey[]

      try {
        expandedBindingKeys = expandBindingKeyWithExpanders(binding.key, bindingExpanders, {
          layer: compileFields,
        })
      } catch (error) {
        notify.emitError("binding-expand-error", error, getErrorMessage(error, "Failed to expand keymap binding"))
        continue
      }

      for (const expandedBindingKey of expandedBindingKeys) {
        const expandedKey = expandedBindingKey.key
        let parsed: ParsedBindingSequenceResult | undefined

        try {
          parsed =
            typeof expandedKey === "string"
              ? parseBindingSequenceWithParsers(expandedKey, bindingParsers, {
                  tokens,
                  patterns: state.patterns,
                  layer: compileFields,
                  parseObjectKey: (value, options) => parseObjectKeyPart(value, options),
                })
              : {
                  parts: [parseObjectKeyPart(expandedKey)],
                  usedTokens: [] as readonly string[],
                  unknownTokens: [] as readonly string[],
                  hasTokenBindings: false,
                }

          parsed = applyExpansionDisplays(parsed, expandedBindingKey)
        } catch (error) {
          notify.emitError("binding-parse-error", error, getErrorMessage(error, "Failed to parse keymap binding"))
          continue
        }

        const sequence = parsed.parts
        hasTokenBindings ||= parsed.hasTokenBindings

        for (const tokenName of parsed.unknownTokens) {
          warnUnknownToken(tokenName, typeof expandedKey === "string" ? expandedKey : String(expandedKey.name))
        }

        if (parsed.unknownTokens.length > 0) {
          continue
        }

        for (const compiledInput of applyBindingTransformers(
          binding,
          sequence,
          tokens,
          bindingParsers,
          compileFields,
        )) {
          try {
            const event = normalizeBindingEvent(compiledInput.event)
            const compiledSequence = compiledInput.sequence
            const mergedRequires: EventData = {}
            const mergedAttrs: Attributes = {}
            const matchers: RuntimeMatcher[] = []

            for (const fieldName in compiledInput) {
              if (fieldName === "sequence") {
                continue
              }

              if (RESERVED_BINDING_FIELDS.has(fieldName)) {
                continue
              }

              const value = compiledInput[fieldName as keyof ParsedBinding]

              if (value === undefined) {
                continue
              }

              const compiler = bindingFieldCompilers.get(fieldName)
              if (!compiler) {
                warnUnknownField("binding", fieldName)
                continue
              }

              compiler(
                value,
                createFieldCompilerContext({
                  fieldName,
                  conditions,
                  requirements: mergedRequires,
                  matchers,
                  attrs: mergedAttrs,
                }),
              )
            }

            const attrs = Object.keys(mergedAttrs).length > 0 ? snapshotAttributes(mergedAttrs) : undefined
            const command = normalizeBindingCommand(compiledInput.cmd)
            const compiledBinding: BindingState<TTarget, TEvent> = {
              binding,
              sequence: compiledSequence,
              command,
              event,
              parsedBinding: snapshotParsedBinding(compiledInput),
              sourceTarget,
              sourceLayerOrder,
              bindingIndex: bindingIndex,
              requires: Object.keys(mergedRequires).length > 0 ? Object.entries(mergedRequires) : EMPTY_REQUIRES,
              matchers: matchers.length > 0 ? matchers : EMPTY_MATCHERS,
              preventDefault: compiledInput.preventDefault !== false,
              fallthrough: compiledInput.fallthrough ?? false,
            }

            if (attrs) {
              compiledBinding.attrs = attrs
            }

            if (typeof command === "function") {
              compiledBinding.run = command
            }

            if (compiledSequence.length === 0) {
              continue
            }

            if (event === "release" && compiledSequence.length > 1) {
              throw new Error("Keymap release bindings only support a single key stroke")
            }

            const terminalPattern = compiledSequence.at(-1)
            if (terminalPattern?.patternName) {
              const pattern = state.patterns.get(terminalPattern.patternName)
              if (pattern && pattern.max !== pattern.min) {
                throw new Error("Keymap unbounded sequence patterns must be followed by a concrete continuation")
              }
            }

            if (event === "press" && !allowExactPrefixAmbiguity) {
              validateExactPrefixAmbiguity(bindingStates, compiledBinding)
            }

            bindingStates.push(compiledBinding)
          } catch (error) {
            notify.emitError("binding-compile-error", error, getErrorMessage(error, "Failed to compile keymap binding"))
          }
        }
      }
    }

    return {
      bindings: bindingStates,
      hasTokenBindings,
    }
  }

  const parseObjectKeyPart = (
    key: KeyStrokeInput,
    options?: {
      display?: string
      match?: KeyMatch
      tokenName?: string
    },
  ): KeySequencePart => {
    return createKeySequencePart(key, options)
  }

  const normalizeBindingEvent = (event: unknown): BindingEvent => {
    if (event === undefined || event === "press") {
      return "press"
    }

    if (event === "release") {
      return "release"
    }

    throw new Error(`Invalid keymap binding event "${String(event)}": expected "press" or "release"`)
  }

  const applyBindingTransformers = (
    binding: Binding<TTarget, TEvent>,
    sequence: KeySequencePart[],
    tokens: ReadonlyMap<string, ResolvedKeyToken>,
    bindingParsers: readonly BindingParser[],
    compileFields?: Readonly<Record<string, unknown>>,
  ): ParsedBinding<TTarget, TEvent>[] => {
    const bindingTransformers = state.bindingTransformers.values()

    if (bindingTransformers.length === 0) {
      return [{ ...binding, sequence: cloneKeySequence(sequence) }]
    }

    const parsedBinding: ParsedBinding<TTarget, TEvent> = {
      ...binding,
      sequence: cloneKeySequence(sequence),
    }
    const extraBindings: ParsedBinding<TTarget, TEvent>[] = []
    let keepOriginal = true
    const layer = compileFields ?? EMPTY_COMPILE_FIELDS

    for (const transformer of bindingTransformers) {
      try {
        transformer(parsedBinding, {
          layer,
          parseKey: (key) => {
            return parseSingleKeyPartWithParsers(key, bindingParsers, {
              tokens,
              patterns: state.patterns,
              layer,
              parseObjectKey: (value, options) => parseObjectKeyPart(value, options),
            })
          },
          add: (nextBinding) => {
            extraBindings.push(snapshotParsedBinding(nextBinding))
          },
          skipOriginal: () => {
            keepOriginal = false
          },
        })
      } catch (error) {
        notify.emitError("binding-transformer-error", error, "[Keymap] Error in binding transformer:")
      }
    }

    if (!keepOriginal) {
      return extraBindings
    }

    if (extraBindings.length === 0) {
      return [parsedBinding]
    }

    return [parsedBinding, ...extraBindings]
  }

  return { parseTokenKey, parseKeySequence, formatKey, compileBindings }
}

function sequenceMatchesPrefix(left: readonly KeySequencePart[], right: readonly KeySequencePart[]): boolean {
  if (left.length >= right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.match !== right[index]?.match) {
      return false
    }
  }

  return true
}

function validateExactPrefixAmbiguity<TTarget extends object, TEvent extends KeymapEvent>(
  bindings: readonly BindingState<TTarget, TEvent>[],
  next: BindingState<TTarget, TEvent>,
): void {
  for (const existing of bindings) {
    if (existing.event !== "press") {
      continue
    }

    if (
      (existing.command !== undefined && sequenceMatchesPrefix(existing.sequence, next.sequence)) ||
      (next.command !== undefined && sequenceMatchesPrefix(next.sequence, existing.sequence))
    ) {
      throw new Error(
        "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
      )
    }
  }
}

function expandBindingKeyWithExpanders(
  key: KeyLike,
  expanders: readonly BindingExpander[],
  options?: {
    layer?: Readonly<Record<string, unknown>>
  },
): readonly ExpandedBindingKey[] {
  if (typeof key !== "string" || expanders.length === 0) {
    return [{ key }]
  }

  const layer = options?.layer ?? EMPTY_COMPILE_FIELDS
  let candidates: BindingExpansion[] = [{ key }]

  for (const expander of expanders) {
    const nextCandidates: BindingExpansion[] = []

    for (const candidate of candidates) {
      const result = expander({
        input: candidate.key,
        displays: candidate.displays,
        layer,
      } satisfies BindingExpanderContext)
      if (!result) {
        nextCandidates.push(candidate)
        continue
      }

      if (result.length === 0) {
        throw new Error(`Keymap binding expander must return at least one key sequence for "${candidate.key}"`)
      }

      for (const expanded of result) {
        if (!expanded || typeof expanded !== "object" || Array.isArray(expanded) || typeof expanded.key !== "string") {
          throw new Error(
            `Keymap binding expander must return expansion objects with string keys for "${candidate.key}"`,
          )
        }

        if (expanded.displays !== undefined) {
          if (!Array.isArray(expanded.displays)) {
            throw new Error(`Keymap binding expander displays must be an array of strings for "${candidate.key}"`)
          }

          for (const display of expanded.displays) {
            if (typeof display !== "string") {
              throw new Error(`Keymap binding expander displays must be an array of strings for "${candidate.key}"`)
            }
          }
        }

        nextCandidates.push(expanded)
      }
    }

    candidates = nextCandidates
  }

  return candidates
}

function applyExpansionDisplays(
  parsed: ParsedBindingSequenceResult,
  expansion: ExpandedBindingKey,
): ParsedBindingSequenceResult {
  if (!expansion.displays) {
    return parsed
  }

  if (expansion.displays.length !== parsed.parts.length) {
    throw new Error(
      `Keymap binding expansion displays length must match parsed sequence length for "${String(expansion.key)}"`,
    )
  }

  return {
    ...parsed,
    parts: parsed.parts.map((part, index) => ({
      ...part,
      display: expansion.displays![index]!,
    })),
  }
}

function parseBindingSequenceWithParsers(
  key: string,
  parsers: readonly BindingParser[],
  options: {
    tokens?: ReadonlyMap<string, ResolvedKeyToken>
    patterns?: ReadonlyMap<string, ResolvedSequencePattern>
    layer?: Readonly<Record<string, unknown>>
    parseObjectKey: (
      key: KeyStrokeInput,
      options?: { display?: string; match?: KeyMatch; tokenName?: string },
    ) => KeySequencePart
  },
): ParsedBindingSequenceResult {
  if (key.length === 0) {
    throw new Error("Invalid key sequence: sequence cannot be empty")
  }

  if (parsers.length === 0) {
    throw new Error("No keymap binding parsers are registered")
  }

  const tokens = options.tokens ?? new Map<string, ResolvedKeyToken>()
  const patterns = options.patterns ?? new Map<string, ResolvedSequencePattern>()
  const layer = options.layer ?? EMPTY_COMPILE_FIELDS
  const parseObjectKey = options.parseObjectKey
  const parts: KeySequencePart[] = []
  const usedTokens = new Set<string>()
  const unknownTokens = new Set<string>()

  let index = 0
  while (index < key.length) {
    let matched = false

    for (const parser of parsers) {
      const result = parser({
        input: key,
        index,
        layer,
        tokens,
        patterns,
        normalizeTokenName: normalizeBindingTokenName,
        createMatch: createTextKeyMatch,
        parseObjectKey,
      } satisfies BindingParserContext)
      if (!result) {
        continue
      }

      if (result.nextIndex <= index || result.nextIndex > key.length) {
        throw new Error(`Keymap binding parser must advance the input for "${key}" at index ${index}`)
      }

      parts.push(...result.parts)
      for (const tokenName of result.usedTokens ?? []) {
        usedTokens.add(tokenName)
      }
      for (const tokenName of result.unknownTokens ?? []) {
        unknownTokens.add(tokenName)
      }

      index = result.nextIndex
      matched = true
      break
    }

    if (!matched) {
      throw new Error(`No keymap binding parser handled input at index ${index} in "${key}"`)
    }
  }

  return {
    parts,
    usedTokens: [...usedTokens],
    unknownTokens: [...unknownTokens],
    hasTokenBindings: usedTokens.size > 0 || unknownTokens.size > 0,
  }
}

function parseSingleKeyPartWithParsers(
  key: KeyLike,
  parsers: readonly BindingParser[],
  options: {
    tokens?: ReadonlyMap<string, ResolvedKeyToken>
    patterns?: ReadonlyMap<string, ResolvedSequencePattern>
    layer?: Readonly<Record<string, unknown>>
    parseObjectKey: (
      key: KeyStrokeInput,
      options?: { display?: string; match?: KeyMatch; tokenName?: string },
    ) => KeySequencePart
  },
): KeySequencePart {
  if (typeof key !== "string") {
    return options.parseObjectKey(key)
  }

  const { parts } = parseBindingSequenceWithParsers(key, parsers, options)
  const [part] = parts
  if (!part || parts.length !== 1) {
    throw new Error(`Invalid key "${String(key)}": expected a single key stroke`)
  }

  return part
}
