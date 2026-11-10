import type { CompilerService } from "./compiler.js"
import type { LayerService } from "./layers.js"
import type { NotificationService } from "./notify.js"
import type { State } from "./state.js"
import { RESERVED_BINDING_FIELDS, RESERVED_COMMAND_FIELDS, RESERVED_LAYER_FIELDS } from "../schema.js"
import type {
  KeySequencePart,
  KeyToken,
  KeymapEvent,
  ResolvedKeyToken,
  ResolvedSequencePattern,
  SequencePattern,
} from "../types.js"
import { createTextKeyMatch, normalizeBindingTokenName } from "./keys.js"
import { getErrorMessage } from "./values.js"

const NOOP = (): void => {}

type FieldKind = "layer" | "binding" | "command"

function normalizePatternLimit(name: string, field: "min" | "max", value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Keymap sequence pattern "${name}" ${field} must be a non-negative integer`)
  }

  return value
}

function registerFieldCompilers<T>(
  fields: Record<string, T>,
  options: {
    kind: FieldKind
    reservedFields: ReadonlySet<string>
    registeredFields: Map<string, T>
    emitError(code: string, error: unknown, message: string): void
  },
): () => void {
  const { kind, reservedFields, registeredFields, emitError } = options
  const entries = Object.entries(fields)
  const registered: Array<[string, T]> = []

  for (const [name, compiler] of entries) {
    if (reservedFields.has(name)) {
      emitError(`reserved-${kind}-field`, { field: name, kind }, `Keymap ${kind} field "${name}" is reserved`)
      continue
    }

    if (registeredFields.has(name)) {
      emitError(
        `duplicate-${kind}-field`,
        { field: name, kind },
        `Keymap ${kind} field "${name}" is already registered`,
      )
      continue
    }

    registeredFields.set(name, compiler)
    registered.push([name, compiler])
  }

  return () => {
    for (const [name, compiler] of registered) {
      const current = registeredFields.get(name)
      if (current === compiler) {
        registeredFields.delete(name)
      }
    }
  }
}

export function registerToken<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
  notify: NotificationService<TTarget, TEvent>,
  compiler: CompilerService<TTarget, TEvent>,
  layers: LayerService<TTarget, TEvent>,
  token: KeyToken,
): () => void {
  let normalizedToken: string

  try {
    normalizedToken = normalizeBindingTokenName(token.name)
  } catch (error) {
    notify.emitError("token-name-normalize-error", error, getErrorMessage(error, "Failed to register keymap token"))
    return NOOP
  }

  if (state.tokens.has(normalizedToken) || state.patterns.has(normalizedToken)) {
    notify.emitError(
      "duplicate-token",
      { token: normalizedToken },
      `Keymap token "${normalizedToken}" is already registered`,
    )
    return NOOP
  }

  let parsedToken: KeySequencePart

  try {
    parsedToken = compiler.parseTokenKey(token.key)
    if (parsedToken.patternName) {
      throw new Error(`Invalid key "${String(token.key)}": expected a concrete key stroke`)
    }
  } catch (error) {
    notify.emitError(
      "token-parse-error",
      error,
      getErrorMessage(error, `Failed to register keymap token "${normalizedToken}"`),
    )
    return NOOP
  }

  const registeredToken: ResolvedKeyToken = {
    stroke: parsedToken.stroke,
    match: parsedToken.match,
  }
  const nextTokens = new Map(state.tokens)
  nextTokens.set(normalizedToken, registeredToken)

  try {
    layers.applyTokenState(nextTokens)
  } catch (error) {
    notify.emitError(
      "token-register-error",
      error,
      getErrorMessage(error, `Failed to register keymap token "${normalizedToken}"`),
    )
    return NOOP
  }

  return () => {
    const current = state.tokens.get(normalizedToken)
    if (current !== registeredToken) {
      return
    }

    const nextTokens = new Map(state.tokens)
    nextTokens.delete(normalizedToken)

    try {
      layers.applyTokenState(nextTokens)
    } catch (error) {
      notify.emitError(
        "token-unregister-error",
        error,
        getErrorMessage(error, `Failed to unregister keymap token "${normalizedToken}"`),
      )
    }
  }
}

export function registerSequencePattern<TTarget extends object, TEvent extends KeymapEvent>(
  state: State<TTarget, TEvent>,
  notify: NotificationService<TTarget, TEvent>,
  layers: LayerService<TTarget, TEvent>,
  pattern: SequencePattern<TEvent>,
): () => void {
  let normalizedName: string
  let resolvedPattern: ResolvedSequencePattern<TEvent>

  try {
    normalizedName = normalizeBindingTokenName(pattern.name)
    const min = normalizePatternLimit(normalizedName, "min", pattern.min, 1)
    const max = normalizePatternLimit(normalizedName, "max", pattern.max, Number.MAX_SAFE_INTEGER)
    if (max < min) {
      throw new Error(`Keymap sequence pattern "${normalizedName}" max must be greater than or equal to min`)
    }

    resolvedPattern = {
      name: normalizedName,
      display: pattern.display,
      payloadKey: pattern.payloadKey ?? normalizedName,
      match: createTextKeyMatch(`pattern:${normalizedName}`),
      min,
      max,
      matcher: (event) => pattern.match(event),
      finalize: pattern.finalize,
    }
  } catch (error) {
    notify.emitError(
      "sequence-pattern-register-error",
      error,
      getErrorMessage(error, "Failed to register keymap sequence pattern"),
    )
    return NOOP
  }

  if (state.tokens.has(normalizedName) || state.patterns.has(normalizedName)) {
    notify.emitError(
      "duplicate-sequence-pattern",
      { pattern: normalizedName },
      `Keymap sequence pattern "${normalizedName}" is already registered`,
    )
    return NOOP
  }

  state.patterns.set(normalizedName, resolvedPattern)
  layers.recompileBindings()

  return () => {
    const current = state.patterns.get(normalizedName)
    if (current !== resolvedPattern) {
      return
    }

    state.patterns.delete(normalizedName)
    layers.recompileBindings()
  }
}

export function registerFields<TTarget extends object, TEvent extends KeymapEvent, T>(
  state: State<TTarget, TEvent>,
  notify: NotificationService<TTarget, TEvent>,
  kind: FieldKind,
  fields: Record<string, T>,
): () => void {
  const reservedFields =
    kind === "layer" ? RESERVED_LAYER_FIELDS : kind === "binding" ? RESERVED_BINDING_FIELDS : RESERVED_COMMAND_FIELDS
  const registeredFields =
    kind === "layer" ? state.layerFields : kind === "binding" ? state.bindingFields : state.commandFields

  return registerFieldCompilers(fields, {
    kind,
    reservedFields,
    registeredFields: registeredFields as Map<string, T>,
    emitError: (code, error, message) => notify.emitError(code, error, message),
  })
}
