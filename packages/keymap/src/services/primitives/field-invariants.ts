import type {
  Attributes,
  BindingFieldContext,
  CommandFieldContext,
  EventData,
  KeymapEvent,
  LayerFieldContext,
  ReactiveMatcher,
  RuntimeMatcher,
} from "../../types.js"
import type { ConditionService } from "../conditions.js"
import { markSupplied } from "../values.js"

export function mergeRequirement(target: EventData, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap requirement for "${name}" from ${source}`)
  }

  target[name] = value
}

export function mergeAttribute(target: Attributes, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap attribute for "${name}" from ${source}`)
  }

  target[name] = value
}

interface FieldCompilerContextOptions<TTarget extends object, TEvent extends KeymapEvent> {
  fieldName: string
  conditions: ConditionService<TTarget, TEvent>
  requirements: EventData
  matchers: RuntimeMatcher[]
  attrs?: Attributes
}

export function createFieldCompilerContext<TTarget extends object, TEvent extends KeymapEvent>(
  options: FieldCompilerContextOptions<TTarget, TEvent> & { attrs: Attributes },
): BindingFieldContext & CommandFieldContext & LayerFieldContext
export function createFieldCompilerContext<TTarget extends object, TEvent extends KeymapEvent>(
  options: FieldCompilerContextOptions<TTarget, TEvent> & { attrs?: undefined },
): LayerFieldContext
export function createFieldCompilerContext<TTarget extends object, TEvent extends KeymapEvent>(
  options: FieldCompilerContextOptions<TTarget, TEvent>,
): BindingFieldContext & CommandFieldContext & LayerFieldContext {
  const source = `field ${options.fieldName}`

  return {
    require(name: string, value: unknown) {
      markSupplied(value)
      mergeRequirement(options.requirements, name, value, source)
    },
    attr(name: string, value: unknown) {
      if (!options.attrs) {
        throw new Error(`Keymap ${source} cannot publish attrs`)
      }

      markSupplied(value)
      mergeAttribute(options.attrs, name, value, source)
    },
    activeWhen(matcher: (() => boolean) | ReactiveMatcher) {
      options.matchers.push(options.conditions.buildRuntimeMatcher(matcher, source))
    },
  }
}
