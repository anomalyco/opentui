import type { CommandContext, Command, CommandResult, Keymap, KeymapEvent, ParsedCommand } from "../../index.js"

const EX_COMMANDS_RESOURCE = Symbol("keymap:ex-commands")

export interface ExCommandPayload {
  raw: string
  args: readonly string[]
  payload?: unknown
}

export interface ExCommand<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  name: string
  aliases?: string[]
  nargs?: "0" | "1" | "?" | "*" | "+"
  run: (ctx: CommandContext<TTarget, TEvent, ExCommandPayload>) => CommandResult<TTarget, TEvent>
  [key: string]: unknown
}

function isExCommandPayload(value: unknown): value is ExCommandPayload {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as { raw?: unknown; args?: unknown }
  return typeof candidate.raw === "string" && Array.isArray(candidate.args)
}

function getExCommandPayload(input: string, payload: unknown): ExCommandPayload {
  if (isExCommandPayload(payload)) {
    return payload
  }

  return { raw: input, args: [], payload }
}

function normalizeExCommandName(name: string): string {
  const normalized = name.trim()
  if (!normalized) {
    throw new Error("Invalid keymap command name: name cannot be empty")
  }

  if (/\s/.test(normalized)) {
    throw new Error(`Invalid keymap command name "${name}": command names cannot contain whitespace`)
  }

  if (normalized.startsWith(":")) {
    return normalized
  }

  return `:${normalized}`
}

function normalizeExCommandAliases(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Keymap ex-command field "aliases" must be an array of command names')
  }

  const aliases: string[] = []
  for (const alias of value) {
    if (typeof alias !== "string") {
      throw new Error('Keymap ex-command field "aliases" must only contain command names')
    }

    aliases.push(alias)
  }

  return aliases
}

function normalizeExCommandNargs(value: unknown): ExCommand["nargs"] {
  if (value === "0" || value === "1" || value === "?" || value === "*" || value === "+") {
    return value
  }

  throw new Error('Keymap ex-command field "nargs" must be "0", "1", "?", "*", or "+"')
}

function getExCommandAliases<TTarget extends object, TEvent extends KeymapEvent>(
  command: Command<TTarget, TEvent>,
): readonly string[] {
  const aliases = command.aliases
  if (aliases === undefined) {
    return []
  }

  return normalizeExCommandAliases(aliases)
}

function isExCommand<TTarget extends object, TEvent extends KeymapEvent>(command: Command<TTarget, TEvent>): boolean {
  return command.name.trim().startsWith(":") || command.namespace === "excommands"
}

function parseCommandInput(input: string): ParsedCommand {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Invalid keymap command: command cannot be empty")
  }

  const parts = trimmed.split(/\s+/)
  const [name, ...args] = parts
  if (!name) {
    throw new Error(`Invalid keymap command "${input}"`)
  }

  return {
    input: trimmed,
    name,
    args,
  }
}

function validateCommandArgs<TTarget extends object, TEvent extends KeymapEvent>(
  command: Command<TTarget, TEvent>,
  args: readonly unknown[],
): boolean {
  if (command.nargs === undefined) {
    return true
  }

  const nargs = normalizeExCommandNargs(command.nargs)
  const count = args.length
  if (nargs === "0") {
    return count === 0
  }

  if (nargs === "1") {
    return count === 1
  }

  if (nargs === "?") {
    return count <= 1
  }

  if (nargs === "*") {
    return true
  }

  if (nargs === "+") {
    return count >= 1
  }

  return true
}

function createExCommandRegistration<TTarget extends object, TEvent extends KeymapEvent>(
  command: Command<TTarget, TEvent>,
  name: string,
): Command<TTarget, TEvent, ExCommandPayload> {
  const run = command.run

  return {
    ...command,
    name,
    namespace: "excommands",
    run(ctx) {
      const payload = getExCommandPayload(ctx.input, ctx.payload)

      if (!validateCommandArgs(command, payload.args)) {
        return { ok: false, reason: "invalid-args" }
      }

      return run({
        ...ctx,
        command: ctx.command!,
        payload,
      })
    },
  }
}

/**
 * Installs Ex command support. Ex commands are registered through normal
 * keymap layers by using a colon-prefixed command name or
 * `namespace: "excommands"`.
 */
export function registerExCommands<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.acquireResource(EX_COMMANDS_RESOURCE, () => {
    const offFields = keymap.registerCommandFields({
      aliases(value) {
        normalizeExCommandAliases(value)
      },
      nargs(value) {
        normalizeExCommandNargs(value)
      },
    })

    const offTransformer = keymap.appendCommandTransformer((command, ctx) => {
      if (!isExCommand(command)) {
        return
      }

      ctx.skipOriginal()

      if (command.nargs !== undefined) {
        normalizeExCommandNargs(command.nargs)
      }

      const names = [command.name, ...getExCommandAliases(command)].map((name) => normalizeExCommandName(name))
      for (const name of names) {
        ctx.add(createExCommandRegistration(command, name))
      }
    })

    const offResolver = keymap.appendCommandResolver((input, ctx) => {
      if (!input.startsWith(":")) {
        return undefined
      }

      const parsed = parseCommandInput(input)
      const normalizedName = normalizeExCommandName(parsed.name)
      const command = ctx.getCommand(normalizedName)

      if (!command) {
        return undefined
      }

      ctx.setInput(parsed.input)
      ctx.setPayload({ raw: parsed.input, args: parsed.args, payload: ctx.payload } satisfies ExCommandPayload)
      return command
    })

    return () => {
      offResolver()
      offTransformer()
      offFields()
    }
  })
}
