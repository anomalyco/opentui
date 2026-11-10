// Opinionated config-to-keymap transformation helper. Treat this as one
// practical shape you can copy and adjust for application-specific needs.
import type { Binding, KeyLike, KeymapEvent } from "../types.js"

export type BindingConfigItem<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | KeyLike
  | Binding<TTarget, TEvent>

export type BindingValue<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> =
  | false
  | "none"
  | BindingConfigItem<TTarget, TEvent>
  | readonly BindingConfigItem<TTarget, TEvent>[]

export type BindingConfig<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = Readonly<
  Record<string, BindingValue<TTarget, TEvent>>
>

export type BindingCommandMap = Readonly<Record<string, string>>

const hasOwn = Object.prototype.hasOwnProperty
const EMPTY_BINDINGS: readonly Binding[] = Object.freeze([])

export interface BindingDefaultsContext<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  command: string
  binding: Readonly<Binding<TTarget, TEvent>>
}

export type BindingDefaults<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> = (
  ctx: BindingDefaultsContext<TTarget, TEvent>,
) => Readonly<Record<string, unknown>> | void

export interface CreateBindingLookupOptions<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  commandMap?: BindingCommandMap
  bindingDefaults?: BindingDefaults<TTarget, TEvent>
}

export interface BindingLookup<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent> {
  readonly bindings: readonly Binding<TTarget, TEvent>[]
  get(command: string): readonly Binding<TTarget, TEvent>[]
  has(command: string): boolean
  gather(name: string, commands: readonly string[]): readonly Binding<TTarget, TEvent>[]
  pick(name: string, commands: readonly string[]): Binding<TTarget, TEvent>[]
  omit(name: string, commands: readonly string[]): Binding<TTarget, TEvent>[]
  invalidate(name?: string): void
  update(config?: BindingConfig<TTarget, TEvent>): void
}

interface NormalizedBindings<TTarget extends object, TEvent extends KeymapEvent> {
  bindings: Binding<TTarget, TEvent>[]
  byCommand: Map<string, Binding<TTarget, TEvent>[]>
}

interface GatheredBindings<TTarget extends object, TEvent extends KeymapEvent> {
  bindings: Binding<TTarget, TEvent>[]
  byCommand: Map<string, readonly Binding<TTarget, TEvent>[]>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isKeyLike(value: unknown): value is KeyLike {
  return typeof value === "string" || isObject(value)
}

function cloneKeyLike(key: KeyLike): KeyLike {
  if (typeof key === "string") {
    return key
  }

  return { ...key }
}

function normalizeCommand(command: string): string {
  if (command.length === 0) {
    throw new Error("Invalid binding command: command cannot be empty")
  }

  return command
}

function mapCommand(command: string, commandMap: BindingCommandMap | undefined): string {
  const configCommand = normalizeCommand(command)
  if (!commandMap || !hasOwn.call(commandMap, configCommand)) {
    return configCommand
  }

  const mappedCommand = commandMap[configCommand]
  if (typeof mappedCommand !== "string") {
    throw new Error(`Invalid binding command map entry for "${configCommand}": expected a command string`)
  }

  if (mappedCommand.length === 0) {
    throw new Error(`Invalid binding command map entry for "${configCommand}": command cannot be empty`)
  }

  return mappedCommand
}

function invalidBindingValue(command: string, index?: number): Error {
  const location = index === undefined ? `"${command}"` : `"${command}" at index ${index}`
  return new Error(
    `Invalid binding value for ${location}: expected false, a key, a binding object, or an array of keys/binding objects`,
  )
}

function resolveBindingItem<TTarget extends object, TEvent extends KeymapEvent>(
  command: string,
  item: BindingConfigItem<TTarget, TEvent>,
  index?: number,
): Binding<TTarget, TEvent> {
  if (!isKeyLike(item)) {
    throw invalidBindingValue(command, index)
  }

  if (typeof item === "string" || !("key" in item)) {
    return {
      key: cloneKeyLike(item),
      cmd: command,
    }
  }

  const key = item.key
  if (!isKeyLike(key)) {
    throw invalidBindingValue(command, index)
  }

  return {
    ...item,
    key: cloneKeyLike(key),
    cmd: command,
  }
}

function resolveBindingValue<TTarget extends object, TEvent extends KeymapEvent>(
  command: string,
  value: BindingValue<TTarget, TEvent>,
  bindingDefaults: BindingDefaults<TTarget, TEvent> | undefined,
): Binding<TTarget, TEvent>[] | undefined {
  if (value === false || value === "none") {
    return undefined
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return undefined
    }

    const items = value as readonly BindingConfigItem<TTarget, TEvent>[]
    const bindings = new Array<Binding<TTarget, TEvent>>(items.length)
    for (let index = 0; index < items.length; index += 1) {
      const binding = resolveBindingItem(command, items[index]!, index)
      bindings[index] = bindingDefaults ? withBindingDefaults(command, binding, bindingDefaults) : binding
    }

    return bindings
  }

  const binding = resolveBindingItem(command, value as BindingConfigItem<TTarget, TEvent>)
  return [bindingDefaults ? withBindingDefaults(command, binding, bindingDefaults) : binding]
}

function withBindingDefaults<TTarget extends object, TEvent extends KeymapEvent>(
  command: string,
  binding: Binding<TTarget, TEvent>,
  bindingDefaults: BindingDefaults<TTarget, TEvent> | undefined,
): Binding<TTarget, TEvent> {
  const defaults = bindingDefaults?.({ command, binding })
  if (!defaults) return binding
  return { ...defaults, ...binding }
}

function flattenBindings<TTarget extends object, TEvent extends KeymapEvent>(
  byCommand: ReadonlyMap<string, readonly Binding<TTarget, TEvent>[]>,
): Binding<TTarget, TEvent>[] {
  let bindingCount = 0
  for (const bindings of byCommand.values()) {
    bindingCount += bindings.length
  }

  const result = new Array<Binding<TTarget, TEvent>>(bindingCount)
  let bindingIndex = 0
  for (const bindings of byCommand.values()) {
    for (let index = 0; index < bindings.length; index += 1) {
      result[bindingIndex] = bindings[index]!
      bindingIndex += 1
    }
  }

  return result
}

function normalizeBindings<TTarget extends object, TEvent extends KeymapEvent>(
  config: BindingConfig<TTarget, TEvent>,
  commandMap: BindingCommandMap | undefined,
  bindingDefaults: BindingDefaults<TTarget, TEvent> | undefined,
): NormalizedBindings<TTarget, TEvent> {
  const byCommand = new Map<string, Binding<TTarget, TEvent>[]>()

  for (const rawCommand in config) {
    if (!hasOwn.call(config, rawCommand)) {
      continue
    }

    const command = mapCommand(rawCommand, commandMap)
    const commandBindings = resolveBindingValue(command, config[rawCommand]!, bindingDefaults)

    if (!commandBindings) {
      byCommand.delete(command)
    } else {
      byCommand.set(command, commandBindings)
    }
  }

  return {
    bindings: flattenBindings(byCommand),
    byCommand,
  }
}

function gatherBindings<TTarget extends object, TEvent extends KeymapEvent>(
  byCommand: ReadonlyMap<string, readonly Binding<TTarget, TEvent>[]>,
  commands: readonly string[],
): GatheredBindings<TTarget, TEvent> {
  const gatheredByCommand = new Map<string, readonly Binding<TTarget, TEvent>[]>()
  const bindings: Binding<TTarget, TEvent>[] = []

  for (const command of commands) {
    const commandBindings = byCommand.get(command)
    if (!commandBindings) continue

    gatheredByCommand.set(command, commandBindings)
    for (let index = 0; index < commandBindings.length; index += 1) {
      bindings.push(commandBindings[index]!)
    }
  }

  return { bindings, byCommand: gatheredByCommand }
}

export function createBindingLookup<TTarget extends object = object, TEvent extends KeymapEvent = KeymapEvent>(
  config: BindingConfig<TTarget, TEvent>,
  options?: CreateBindingLookupOptions<TTarget, TEvent>,
): BindingLookup<TTarget, TEvent> {
  let currentConfig = config
  let normalized = normalizeBindings(currentConfig, options?.commandMap, options?.bindingDefaults)
  const gathered = new Map<string, GatheredBindings<TTarget, TEvent>>()

  return {
    get bindings() {
      return normalized.bindings
    },
    get(command) {
      return normalized.byCommand.get(command) ?? (EMPTY_BINDINGS as readonly Binding<TTarget, TEvent>[])
    },
    has(command) {
      return normalized.byCommand.has(command)
    },
    gather(name, commands) {
      const existing = gathered.get(name)
      if (existing) return existing.bindings

      const next = gatherBindings(normalized.byCommand, commands)
      gathered.set(name, next)
      return next.bindings
    },
    pick(name, commands) {
      const group = gathered.get(name)
      if (!group) return []

      const result: Binding<TTarget, TEvent>[] = []
      for (const command of commands) {
        const bindings = group.byCommand.get(command)
        if (!bindings) continue
        for (let index = 0; index < bindings.length; index += 1) {
          result.push(bindings[index]!)
        }
      }

      return result
    },
    omit(name, commands) {
      const group = gathered.get(name)
      if (!group) return []
      if (commands.length === 0) return group.bindings

      if (commands.length === 1) {
        const omitted = commands[0]
        const result: Binding<TTarget, TEvent>[] = []
        for (let index = 0; index < group.bindings.length; index += 1) {
          const binding = group.bindings[index]!
          if (typeof binding.cmd === "string" && binding.cmd === omitted) continue
          result.push(binding)
        }

        return result
      }

      const omitted = new Set(commands)
      const result: Binding<TTarget, TEvent>[] = []
      for (let index = 0; index < group.bindings.length; index += 1) {
        const binding = group.bindings[index]!
        if (typeof binding.cmd === "string" && omitted.has(binding.cmd)) continue
        result.push(binding)
      }

      return result
    },
    invalidate(name) {
      if (name === undefined) {
        gathered.clear()
        return
      }

      gathered.delete(name)
    },
    update(nextConfig) {
      if (nextConfig) {
        currentConfig = nextConfig
      }

      normalized = normalizeBindings(currentConfig, options?.commandMap, options?.bindingDefaults)
      gathered.clear()
    },
  }
}
