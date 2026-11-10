import type { Binding, KeyLike, KeymapEvent } from "../types.js"

export type CommandBindingMap = Record<string, KeyLike>

export interface CommandBindingsOverrideWarning {
  code: "command-binding-override"
  command: string
  previousKey: KeyLike
  nextKey: KeyLike
}

export interface CommandBindingsError {
  code: "invalid-command-binding"
  command: string
  value: unknown
  reason: Error
}

export interface CommandBindingsOptions {
  onWarning?: (warning: CommandBindingsOverrideWarning) => void
  onError?: (error: CommandBindingsError) => void
}

function isCommandBindingKey(value: unknown): value is KeyLike {
  return typeof value === "string" || (!!value && typeof value === "object" && !Array.isArray(value))
}

export function commandBindings<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent>(
  bindings: Readonly<CommandBindingMap>,
  options?: CommandBindingsOptions,
): Binding<TTarget, TEvent>[] {
  const normalized: Binding<TTarget, TEvent>[] = []
  const indexesByCommand = new Map<string, number>()

  for (const [command, key] of Object.entries(bindings)) {
    if (!isCommandBindingKey(key)) {
      const error = new Error(
        `Invalid command binding for "${command}": command bindings must map command strings to key strings or keystroke objects`,
      )

      options?.onError?.({
        code: "invalid-command-binding",
        command,
        value: key,
        reason: error,
      })
      continue
    }

    const normalizedCommand = command.trim()

    const nextBinding = {
      key: typeof key === "string" ? key : { ...key },
      cmd: normalizedCommand,
    } satisfies Binding<TTarget, TEvent>

    const existingIndex = indexesByCommand.get(normalizedCommand)
    if (existingIndex !== undefined) {
      const previousBinding = normalized[existingIndex]!
      options?.onWarning?.({
        code: "command-binding-override",
        command: normalizedCommand,
        previousKey: previousBinding.key,
        nextKey: nextBinding.key,
      })
      normalized[existingIndex] = nextBinding
      continue
    }

    indexesByCommand.set(normalizedCommand, normalized.length)
    normalized.push(nextBinding)
  }

  return normalized
}
