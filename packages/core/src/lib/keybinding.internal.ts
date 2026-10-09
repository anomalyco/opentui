export interface KeyBindingLike {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
}

export interface KeyBinding<Action extends string = string> extends KeyBindingLike {
  action: Action
}

export interface KeyBindingLookup extends KeyBindingLike {
  // Kitty's base-layout codepoint as a Unicode number. Example: 99 means "c".
  baseCode?: number
}

export type KeyAliasMap = Record<string, string>

export const defaultKeyAliases: KeyAliasMap = {
  enter: "return",
  esc: "escape",
  kp0: "0",
  kp1: "1",
  kp2: "2",
  kp3: "3",
  kp4: "4",
  kp5: "5",
  kp6: "6",
  kp7: "7",
  kp8: "8",
  kp9: "9",
  kpdecimal: ".",
  kpdivide: "/",
  kpmultiply: "*",
  kpminus: "-",
  kpplus: "+",
  kpenter: "enter",
  kpequal: "=",
  kpseparator: ",",
  kpleft: "left",
  kpright: "right",
  kpup: "up",
  kpdown: "down",
  kppageup: "pageup",
  kppagedown: "pagedown",
  kphome: "home",
  kpend: "end",
  kpinsert: "insert",
  kpdelete: "delete",
}

export function mergeKeyAliases(defaults: KeyAliasMap, custom: KeyAliasMap): KeyAliasMap {
  return { ...defaults, ...custom }
}

export function mergeKeyBindings<Action extends string>(
  defaults: KeyBinding<Action>[],
  custom: KeyBinding<Action>[],
): KeyBinding<Action>[] {
  const map = new Map<string, KeyBinding<Action>>()
  for (const binding of defaults) {
    const key = getKeyBindingKey(binding)
    map.set(key, binding)
  }
  for (const binding of custom) {
    const key = getKeyBindingKey(binding)
    map.set(key, binding)
  }
  return Array.from(map.values())
}

export function getKeyBindingKey(binding: KeyBindingLike): string {
  return `${binding.name}:${binding.ctrl ? 1 : 0}:${binding.shift ? 1 : 0}:${binding.meta ? 1 : 0}:${binding.super ? 1 : 0}`
}

// `baseCode` is Kitty's "base layout codepoint": the character for the same
// physical key on the keyboard's base layout. Example: an event may arrive as
// `name: "ㅊ", baseCode: 99`, where `99` is Unicode `c`, so Ctrl+ㅊ matches Ctrl+C.
// Only a typed key that is one non-ASCII character falls back: on a Latin layout,
// Dvorak Ctrl+J (base `c`) must stay Ctrl+J.
function getBaseCodeKeyName({ name: typedName, baseCode }: KeyBindingLookup): string | undefined {
  if (!/^[^\x00-\x7f]$/u.test(typedName) || baseCode === undefined || baseCode < 32 || baseCode === 127) {
    return undefined
  }

  try {
    const name = String.fromCodePoint(baseCode)

    if (name.length === 1 && name >= "A" && name <= "Z") {
      return name.toLowerCase()
    }

    return name
  } catch {
    return undefined
  }
}

// Return every lookup key that can represent this event. We try the parsed
// name first, then the base-layout key of a non-ASCII character. That keeps
// direct character bindings precise, and still lets shortcuts resolve on
// non-Latin layouts.
export function getKeyBindingKeys(binding: KeyBindingLookup): string[] {
  const names = new Set([binding.name])
  const baseCodeName = getBaseCodeKeyName(binding)

  if (baseCodeName) {
    names.add(baseCodeName)
  }

  return [...names].map((name) => getKeyBindingKey({ ...binding, name }))
}

export function getKeyBindingAction<Action extends string>(
  map: Map<string, Action>,
  binding: KeyBindingLookup,
): Action | undefined {
  for (const key of getKeyBindingKeys(binding)) {
    const action = map.get(key)

    if (action !== undefined) {
      return action
    }
  }

  return undefined
}

export function matchesKeyBinding(binding: KeyBindingLookup, match: KeyBindingLike): boolean {
  const matchKey = getKeyBindingKey(match)

  return getKeyBindingKeys(binding).includes(matchKey)
}

export function buildKeyBindingsMap<Action extends string>(
  bindings: KeyBinding<Action>[],
  aliasMap?: KeyAliasMap,
): Map<string, Action> {
  const map = new Map<string, Action>()
  const aliases = aliasMap || {}

  for (const binding of bindings) {
    const key = getKeyBindingKey(binding)
    map.set(key, binding.action)
  }

  // Add aliased versions of all bindings
  for (const binding of bindings) {
    const normalizedName = aliases[binding.name] || binding.name
    if (normalizedName !== binding.name) {
      // Create aliased key with normalized name
      const aliasedKey = getKeyBindingKey({ ...binding, name: normalizedName })
      map.set(aliasedKey, binding.action)
    }
  }

  return map
}

/**
 * Converts a key binding to a human-readable string representation
 * @param binding The key binding to stringify
 * @returns A string like "ctrl+shift+y" or just "escape"
 * @example
 * keyBindingToString({ name: "y", ctrl: true, shift: true }) // "ctrl+shift+y"
 * keyBindingToString({ name: "escape" }) // "escape"
 * keyBindingToString({ name: "c", ctrl: true }) // "ctrl+c"
 * keyBindingToString({ name: "s", super: true }) // "super+s"
 */
export function keyBindingToString<Action extends string>(binding: KeyBinding<Action>): string {
  const parts: string[] = []

  if (binding.ctrl) parts.push("ctrl")
  if (binding.shift) parts.push("shift")
  if (binding.meta) parts.push("meta")
  if (binding.super) parts.push("super")

  parts.push(binding.name)

  return parts.join("+")
}
