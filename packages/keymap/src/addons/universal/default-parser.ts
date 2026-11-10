import type {
  BindingParser,
  EventMatchResolver,
  KeyMatch,
  Keymap,
  KeymapEvent,
  KeySequencePart,
  KeyStrokeInput,
} from "../../index.js"

const namedSingleStrokeKeys = new Set<string>([
  "up",
  "down",
  "left",
  "right",
  "clear",
  "escape",
  "return",
  "linefeed",
  "enter",
  "tab",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "space",
  "lt",
  "gt",
  "plus",
  "minus",
  "equal",
  "comma",
  "period",
  "slash",
  "backslash",
  "semicolon",
  "quote",
  "backquote",
  "leftbracket",
  "rightbracket",
  "capslock",
  "numlock",
  "scrolllock",
  "printscreen",
  "pause",
  "menu",
  "apps",
  "kp0",
  "kp1",
  "kp2",
  "kp3",
  "kp4",
  "kp5",
  "kp6",
  "kp7",
  "kp8",
  "kp9",
  "kpdecimal",
  "kpdivide",
  "kpmultiply",
  "kpminus",
  "kpplus",
  "kpenter",
  "kpequal",
  "kpseparator",
  "kpleft",
  "kpright",
  "kpup",
  "kpdown",
  "kppageup",
  "kppagedown",
  "kphome",
  "kpend",
  "kpinsert",
  "kpdelete",
  "mediaplay",
  "mediapause",
  "mediaplaypause",
  "mediareverse",
  "mediastop",
  "mediafastforward",
  "mediarewind",
  "medianext",
  "mediaprev",
  "mediarecord",
  "volumedown",
  "volumeup",
  "mute",
  "leftshift",
  "leftctrl",
  "leftalt",
  "leftsuper",
  "lefthyper",
  "leftmeta",
  "rightshift",
  "rightctrl",
  "rightalt",
  "rightsuper",
  "righthyper",
  "rightmeta",
  "iso_level3_shift",
  "iso_level5_shift",
  "option",
  "alt",
  "meta",
  "super",
  "hyper",
  "control",
  "ctrl",
  "shift",
])

const modifierKeyNames = new Set<string>(["ctrl", "control", "shift", "meta", "alt", "option", "super", "hyper"])

const namedSingleStrokeKeyPrefixes = createPrefixBuckets(namedSingleStrokeKeys)
const modifierKeyPrefixes = createPrefixBuckets(modifierKeyNames)

type DefaultParserContext = Parameters<BindingParser>[0]

function createPrefixBuckets(values: Iterable<string>): ReadonlyMap<number, readonly string[]> {
  const buckets = new Map<number, string[]>()

  for (const value of values) {
    const first = value.charCodeAt(0)
    if (Number.isNaN(first)) {
      continue
    }

    let bucket = buckets.get(first)
    if (!bucket) {
      bucket = []
      buckets.set(first, bucket)
    }

    bucket.push(value)
  }

  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => right.length - left.length)
  }

  return buckets
}

function toLowerAsciiCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57
}

function startsWithAsciiInsensitive(input: string, prefix: string, index: number): boolean {
  if (input.startsWith(prefix, index)) {
    return true
  }

  if (index + prefix.length > input.length) {
    return false
  }

  for (let offset = 0; offset < prefix.length; offset += 1) {
    if (toLowerAsciiCode(input.charCodeAt(index + offset)) !== prefix.charCodeAt(offset)) {
      return false
    }
  }

  return true
}

function findBucketedPrefixMatch(
  buckets: ReadonlyMap<number, readonly string[]>,
  input: string,
  index: number,
): string | undefined {
  const first = input.charCodeAt(index)
  if (Number.isNaN(first)) {
    return undefined
  }

  const candidates = buckets.get(toLowerAsciiCode(first))
  if (!candidates) {
    return undefined
  }

  for (const candidate of candidates) {
    if (startsWithAsciiInsensitive(input, candidate, index)) {
      return candidate
    }
  }

  return undefined
}

function parseObjectKeyInput(
  ctx: DefaultParserContext,
  key: KeyStrokeInput,
  display?: string,
  match?: KeyMatch,
  tokenName?: string,
): KeySequencePart {
  return ctx.parseObjectKey(key, {
    display,
    match,
    tokenName,
  })
}

function parseStringKeyPart(input: string, ctx: DefaultParserContext): KeySequencePart {
  if (input === " ") {
    return ctx.parseObjectKey({ name: "space" }, { display: "space" })
  }

  if (input === "+") {
    return ctx.parseObjectKey({ name: "+" }, { display: "+" })
  }

  const parts = input.split("+")
  let name = ""
  let displayName = ""
  let ctrl = false
  let shift = false
  let meta = false
  let superKey = false
  let hyper = false

  for (const rawPart of parts) {
    const part = rawPart.trim()
    if (!part) {
      continue
    }

    const lowered = part.toLowerCase()
    if (lowered === "ctrl" || lowered === "control") {
      ctrl = true
      continue
    }

    if (lowered === "shift") {
      shift = true
      continue
    }

    if (lowered === "meta" || lowered === "alt" || lowered === "option") {
      meta = true
      continue
    }

    if (lowered === "super") {
      superKey = true
      continue
    }

    if (lowered === "hyper") {
      hyper = true
      continue
    }

    if (name) {
      throw new Error(`Invalid key "${input}": multiple key names are not supported`)
    }

    name = part
    displayName = lowered
  }

  if (!name) {
    throw new Error(`Invalid key "${input}": missing key name`)
  }

  const displayParts: string[] = []
  if (ctrl) displayParts.push("ctrl")
  if (shift) displayParts.push("shift")
  if (meta) displayParts.push("meta")
  if (superKey) displayParts.push("super")
  if (hyper) displayParts.push("hyper")
  displayParts.push(displayName)

  return ctx.parseObjectKey(
    {
      name,
      ctrl,
      shift,
      meta,
      super: superKey,
      hyper: hyper || undefined,
    },
    {
      display: displayParts.join("+"),
    },
  )
}

function parseNamedKeyPart(name: string, ctx: DefaultParserContext): KeySequencePart {
  const normalized = name.trim().toLowerCase()
  return ctx.parseObjectKey({ name: normalized }, { display: normalized })
}

function findNamedSingleStrokeKey(input: string, index: number): string | undefined {
  const namedKey = findBucketedPrefixMatch(namedSingleStrokeKeyPrefixes, input, index)
  if (namedKey) {
    return namedKey
  }

  if (toLowerAsciiCode(input.charCodeAt(index)) !== 102 || !isDigitCode(input.charCodeAt(index + 1))) {
    return undefined
  }

  const end = isDigitCode(input.charCodeAt(index + 2)) ? index + 3 : index + 2
  return input.slice(index, end).toLowerCase()
}

function findModifierKey(input: string, index: number): string | undefined {
  return findBucketedPrefixMatch(modifierKeyPrefixes, input, index)
}

function parseModifiedKeyPart(
  input: string,
  index: number,
  ctx: DefaultParserContext,
):
  | {
      part: KeySequencePart
      nextIndex: number
    }
  | undefined {
  let cursor = index
  let ctrl = false
  let shift = false
  let meta = false
  let superKey = false
  let hyper = false

  while (cursor < input.length) {
    const modifier = findModifierKey(input, cursor)
    if (!modifier) {
      break
    }

    const plusIndex = cursor + modifier.length
    if (input[plusIndex] !== "+") {
      break
    }

    if (modifier === "ctrl" || modifier === "control") {
      ctrl = true
    } else if (modifier === "shift") {
      shift = true
    } else if (modifier === "meta" || modifier === "alt" || modifier === "option") {
      meta = true
    } else if (modifier === "super") {
      superKey = true
    } else if (modifier === "hyper") {
      hyper = true
    }

    cursor = plusIndex + 1
  }

  if (cursor === index) {
    return undefined
  }

  const char = input[cursor]
  if (char === undefined) {
    throw new Error(`Invalid key "${input.slice(index)}": missing key name`)
  }

  const name = findNamedSingleStrokeKey(input, cursor) ?? char
  const displayName = name === " " ? "space" : name === "+" ? "+" : name.toLowerCase()
  const displayParts: string[] = []
  if (ctrl) displayParts.push("ctrl")
  if (shift) displayParts.push("shift")
  if (meta) displayParts.push("meta")
  if (superKey) displayParts.push("super")
  if (hyper) displayParts.push("hyper")
  displayParts.push(displayName)

  return {
    part: ctx.parseObjectKey(
      {
        name: name === " " ? "space" : name,
        ctrl,
        shift,
        meta,
        super: superKey,
        hyper: hyper || undefined,
      },
      {
        display: displayParts.join("+"),
      },
    ),
    nextIndex: cursor + name.length,
  }
}

export const defaultBindingParser: BindingParser = (ctx) => {
  const { input, index, tokens, normalizeTokenName } = ctx

  if (index === 0 && input.includes("+") && /\s/.test(input)) {
    return {
      parts: [parseStringKeyPart(input, ctx)],
      nextIndex: input.length,
    }
  }

  const char = input[index]
  if (char === undefined) {
    return undefined
  }

  if (char === "<") {
    const end = input.indexOf(">", index)
    if (end === -1) {
      return {
        parts: [parseStringKeyPart(char, ctx)],
        nextIndex: index + 1,
      }
    }

    const tokenName = normalizeTokenName(input.slice(index + 1, end))
    const token = tokens.get(tokenName)
    if (!token) {
      return {
        parts: [],
        nextIndex: end + 1,
        unknownTokens: [tokenName],
      }
    }

    return {
      parts: [parseObjectKeyInput(ctx, token.stroke, `<${tokenName}>`, token.match, tokenName)],
      nextIndex: end + 1,
      usedTokens: [tokenName],
    }
  }

  if (char === "{") {
    const end = input.indexOf("}", index)
    if (end === -1) {
      return {
        parts: [parseStringKeyPart(char, ctx)],
        nextIndex: index + 1,
      }
    }

    const patternName = normalizeTokenName(input.slice(index + 1, end))
    const pattern = ctx.patterns.get(patternName)
    if (!pattern) {
      return {
        parts: [],
        nextIndex: end + 1,
        unknownTokens: [patternName],
      }
    }

    const part = ctx.parseObjectKey(
      { name: patternName, ctrl: false, shift: false, meta: false, super: false },
      { display: pattern.display ?? `{${patternName}}`, match: pattern.match },
    )

    return {
      parts: [{ ...part, patternName: pattern.name, payloadKey: pattern.payloadKey }],
      nextIndex: end + 1,
      usedTokens: [patternName],
    }
  }

  const modified = parseModifiedKeyPart(input, index, ctx)
  if (modified) {
    return {
      parts: [modified.part],
      nextIndex: modified.nextIndex,
    }
  }

  const namedKey = findNamedSingleStrokeKey(input, index)
  if (namedKey) {
    return {
      parts: [parseNamedKeyPart(namedKey, ctx)],
      nextIndex: index + namedKey.length,
    }
  }

  return {
    parts: [parseStringKeyPart(char, ctx)],
    nextIndex: index + 1,
  }
}

export const defaultEventMatchResolver: EventMatchResolver<KeymapEvent> = (event, ctx) => {
  return [
    ctx.resolveKey({
      name: event.name,
      ctrl: event.ctrl,
      shift: event.shift,
      meta: event.meta,
      super: event.super ?? false,
      hyper: event.hyper || undefined,
    }),
  ]
}

/**
 * Parses the built-in string binding syntax, including modifiers,
 * `<token>` aliases, and `{pattern}` dynamic sequence segments.
 */
export function registerDefaultBindingParser<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.appendBindingParser((ctx) => defaultBindingParser(ctx))
}

/**
 * Matches incoming key events against their canonical normalized stroke.
 */
export function registerDefaultEventMatchResolver<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.appendEventMatchResolver((event, ctx) => defaultEventMatchResolver(event, ctx))
}

/**
 * Installs the standard parser and event matcher used by most keymaps.
 */
export function registerDefaultKeys<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  const offParser = registerDefaultBindingParser(keymap)
  const offResolver = registerDefaultEventMatchResolver(keymap)

  return () => {
    offResolver()
    offParser()
  }
}
