import type { BindingCommand, KeymapEvent } from "../../types.js"

export function normalizeBindingCommand<TTarget extends object, TEvent extends KeymapEvent>(
  command: BindingCommand<TTarget, TEvent> | undefined,
): BindingCommand<TTarget, TEvent> | undefined {
  if (command === undefined || typeof command === "function") {
    return command
  }

  const trimmed = command.trim()
  if (!trimmed) {
    throw new Error("Invalid keymap command: command cannot be empty")
  }

  return trimmed
}

export function normalizeCommandName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error("Invalid keymap command name: name cannot be empty")
  }

  if (/\s/.test(trimmed)) {
    throw new Error(`Invalid keymap command name "${name}": command names cannot contain whitespace`)
  }

  return trimmed
}
