// Kitty Keyboard Protocol parser
// Based on https://sw.kovidgoyal.net/kitty/keyboard-protocol/

import type { ParsedKey } from "./parse.keypress.js"

const kittyKeyMap: Record<number, string> = {
  // Standard keys
  27: "escape",
  9: "tab",
  13: "return",
  127: "backspace",

  // Arrow keys
  57344: "escape",
  57345: "return",
  57346: "tab",
  57347: "backspace",
  57348: "insert",
  57349: "delete",
  57350: "left",
  57351: "right",
  57352: "up",
  57353: "down",
  57354: "pageup",
  57355: "pagedown",
  57356: "home",
  57357: "end",
  57358: "capslock",
  57359: "scrolllock",
  57360: "numlock",
  57361: "printscreen",
  57362: "pause",
  57363: "menu",

  // Function keys
  57364: "f1",
  57365: "f2",
  57366: "f3",
  57367: "f4",
  57368: "f5",
  57369: "f6",
  57370: "f7",
  57371: "f8",
  57372: "f9",
  57373: "f10",
  57374: "f11",
  57375: "f12",
  57376: "f13",
  57377: "f14",
  57378: "f15",
  57379: "f16",
  57380: "f17",
  57381: "f18",
  57382: "f19",
  57383: "f20",
  57384: "f21",
  57385: "f22",
  57386: "f23",
  57387: "f24",
  57388: "f25",
  57389: "f26",
  57390: "f27",
  57391: "f28",
  57392: "f29",
  57393: "f30",
  57394: "f31",
  57395: "f32",
  57396: "f33",
  57397: "f34",
  57398: "f35",

  // Keypad
  57399: "kp0",
  57400: "kp1",
  57401: "kp2",
  57402: "kp3",
  57403: "kp4",
  57404: "kp5",
  57405: "kp6",
  57406: "kp7",
  57407: "kp8",
  57408: "kp9",
  57409: "kpdecimal",
  57410: "kpdivide",
  57411: "kpmultiply",
  57412: "kpminus",
  57413: "kpplus",
  57414: "kpenter",
  57415: "kpequal",
  57416: "kpseparator",
  57417: "kpleft",
  57418: "kpright",
  57419: "kpup",
  57420: "kpdown",
  57421: "kppageup",
  57422: "kppagedown",
  57423: "kphome",
  57424: "kpend",
  57425: "kpinsert",
  57426: "kpdelete",
  57427: "clear",

  // Media keys
  57428: "mediaplay",
  57429: "mediapause",
  57430: "mediaplaypause",
  57431: "mediareverse",
  57432: "mediastop",
  57433: "mediafastforward",
  57434: "mediarewind",
  57435: "medianext",
  57436: "mediaprev",
  57437: "mediarecord",

  // Volume keys
  57438: "volumedown",
  57439: "volumeup",
  57440: "mute",

  // Modifiers
  57441: "leftshift",
  57442: "leftctrl",
  57443: "leftalt",
  57444: "leftsuper",
  57445: "lefthyper",
  57446: "leftmeta",
  57447: "rightshift",
  57448: "rightctrl",
  57449: "rightalt",
  57450: "rightsuper",
  57451: "righthyper",
  57452: "rightmeta",

  // Special
  57453: "iso_level3_shift",
  57454: "iso_level5_shift",
}

export const kittyNamedSingleStrokeKeys = [...new Set(Object.values(kittyKeyMap))]

const printableKeypadText: Record<string, string> = {
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
  kpequal: "=",
  kpseparator: ",",
}

function getPrintableKittyKeyText(key: ParsedKey): string | undefined {
  return printableKeypadText[key.name]
}

function fromKittyMods(mod: number): {
  shift: boolean
  alt: boolean
  ctrl: boolean
  super: boolean
  hyper: boolean
  meta: boolean
  capsLock: boolean
  numLock: boolean
} {
  return {
    shift: !!(mod & 1),
    alt: !!(mod & 2),
    ctrl: !!(mod & 4),
    super: !!(mod & 8),
    hyper: !!(mod & 16),
    meta: !!(mod & 32),
    capsLock: !!(mod & 64),
    numLock: !!(mod & 128),
  }
}

// Map functional key CSI codes to key names
const functionalKeyMap: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  E: "clear",
  P: "f1",
  Q: "f2",
  S: "f4",
}

// Map tilde key numbers to key names (CSI number ~ format)
const tildeKeyMap: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home", // rxvt
  "8": "end", // rxvt
  "11": "f1",
  "12": "f2",
  "13": "f3",
  "14": "f4",
  "15": "f5",
  "17": "f6",
  "18": "f7",
  "19": "f8",
  "20": "f9",
  "21": "f10",
  "23": "f11",
  "24": "f12",
  "29": "menu",
  "57427": "clear",
}

/**
 * Parse Kitty keyboard protocol special keys (functional and tilde) with event type
 * Formats:
 *   Functional: CSI 1;modifiers:event_type LETTER (e.g., \x1b[1;1:1A = up arrow press)
 *   Tilde: CSI number;modifiers:event_type ~ (e.g., \x1b[5;1:1~ = pageup press)
 */
function parseKittySpecialKey(sequence: string): ParsedKey | null {
  // Combined regex: matches both functional keys (letter) and tilde keys (~)
  const specialKeyRe = /^\x1b\[(\d+);(\d+):(\d+)([A-Z~])$/
  const match = specialKeyRe.exec(sequence)

  if (!match) return null

  const keyNumOrOne = match[1]
  const modifierStr = match[2]
  const eventTypeStr = match[3]
  const terminator = match[4]

  // Determine key name based on terminator
  let keyName: string | undefined
  if (terminator === "~") {
    // Tilde key: lookup by number
    keyName = tildeKeyMap[keyNumOrOne]
  } else {
    // Functional key: must have "1" as first param, lookup by letter
    if (keyNumOrOne !== "1") return null
    keyName = functionalKeyMap[terminator]
  }

  if (!keyName) return null

  const key: ParsedKey = {
    name: keyName,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence,
    raw: sequence,
    eventType: "press",
    source: "kitty",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  }

  // Parse modifiers
  if (modifierStr) {
    const modifierMask = parseInt(modifierStr, 10)
    if (!isNaN(modifierMask) && modifierMask > 1) {
      const mods = fromKittyMods(modifierMask - 1)
      key.shift = mods.shift
      key.ctrl = mods.ctrl
      key.meta = mods.alt || mods.meta
      key.option = mods.alt
      key.super = mods.super
      key.hyper = mods.hyper
      key.capsLock = mods.capsLock
      key.numLock = mods.numLock
    }
  }

  // Parse event type: 1 = press, 2 = repeat, 3 = release
  if (eventTypeStr === "1" || !eventTypeStr) {
    key.eventType = "press"
  } else if (eventTypeStr === "2") {
    key.eventType = "press"
    key.repeated = true
  } else if (eventTypeStr === "3") {
    key.eventType = "release"
  }

  return key
}

export function parseKittyKeyboard(sequence: string): ParsedKey | null {
  // Try special key format (functional letters or tilde keys with event type)
  const specialResult = parseKittySpecialKey(sequence)
  if (specialResult) return specialResult

  // Kitty keyboard protocol: CSI unicode-key-code:alternate-key-codes ; modifiers:event-type ; text-as-codepoints u
  const kittyRe = /^\x1b\[([^\x1b]+)u$/
  const match = kittyRe.exec(sequence)

  if (!match) return null

  const params = match[1]
  const fields = params.split(";")

  if (fields.length < 1) return null

  const key: ParsedKey = {
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence,
    raw: sequence,
    eventType: "press",
    source: "kitty",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  }

  let text = ""

  // Parse field 1: unicode-key-code:shifted_codepoint:base_layout_codepoint.
  // The character this key produced, the shifted variant, and what the same
  // physical key would be on the base layout. Example: a key can produce `ㅊ`
  // but still report base-layout codepoint 99, which is Unicode `c`.
  const field1 = fields[0]?.split(":") || []
  const codepointStr = field1[0]
  if (!codepointStr) return null

  const codepoint = parseInt(codepointStr, 10)
  if (isNaN(codepoint)) return null

  let shiftedCodepoint: number | undefined
  let baseCodepoint: number | undefined

  // Parse shifted and base codepoints
  if (field1[1]) {
    const shifted = parseInt(field1[1], 10)
    if (!isNaN(shifted) && shifted > 0 && shifted <= 0x10ffff) {
      shiftedCodepoint = shifted
    }
  }
  if (field1[2]) {
    const base = parseInt(field1[2], 10)
    if (!isNaN(base) && base > 0 && base <= 0x10ffff) {
      baseCodepoint = base
    }
  }

  const knownKey = kittyKeyMap[codepoint]
  if (knownKey) {
    key.name = knownKey
    key.code = `[${codepoint}u`
  } else if (codepoint === 0) {
    key.name = ""
  } else {
    // It's a Unicode character
    if (codepoint > 0 && codepoint <= 0x10ffff) {
      const char = String.fromCodePoint(codepoint)
      key.name = char === " " ? "space" : char

      // Keep the raw Unicode codepoint from Kitty so higher-level matching can
      // later turn `99` into `c` and use that as a layout-stable fallback.
      if (baseCodepoint) {
        key.baseCode = baseCodepoint
      }
    } else {
      return null // Invalid codepoint
    }
  }

  // Parse field 2: modifier_mask:event_type
  if (fields[1]) {
    const field2 = fields[1].split(":")
    const modifierStr = field2[0]
    const eventTypeStr = field2[1]

    if (modifierStr) {
      const modifierMask = parseInt(modifierStr, 10)
      if (!isNaN(modifierMask) && modifierMask > 1) {
        const mods = fromKittyMods(modifierMask - 1) // Kitty modifiers start from 1
        key.shift = mods.shift
        key.ctrl = mods.ctrl
        key.meta = mods.alt || mods.meta
        key.option = mods.alt
        key.super = mods.super
        key.hyper = mods.hyper
        key.capsLock = mods.capsLock
        key.numLock = mods.numLock
      }
    }

    // Parse event type: 1 = press (default), 2 = repeat, 3 = release
    if (eventTypeStr === "1" || !eventTypeStr) {
      key.eventType = "press"
    } else if (eventTypeStr === "2") {
      key.eventType = "press"
      key.repeated = true
    } else if (eventTypeStr === "3") {
      key.eventType = "release"
    } else {
      key.eventType = "press"
    }
  }

  // Parse field 3: text_as_codepoint[:text_as_codepoint]
  if (fields[2]) {
    const codepoints = fields[2].split(":")
    for (const cpStr of codepoints) {
      const cp = parseInt(cpStr, 10)
      if (!isNaN(cp) && cp > 0 && cp <= 0x10ffff) {
        text += String.fromCodePoint(cp)
      }
    }
  }

  if (text === "") {
    text = getPrintableKittyKeyText(key) ?? ""
  }

  // Handle text generation for printable characters
  if (text === "") {
    // Check if this is a printable character (not a key name like "up", "f1", etc.)
    const isPrintable = key.name.length > 0 && !kittyKeyMap[codepoint]
    if (isPrintable) {
      // Use shifted codepoint if shift is active and we have one
      if (codepoint === 32) {
        text = " "
      } else if (key.shift && shiftedCodepoint) {
        text = String.fromCodePoint(shiftedCodepoint)
      } else if (key.shift && key.name.length === 1) {
        // When shift is pressed but terminal didn't provide shifted codepoint,
        // convert the character to uppercase (works for Unicode including Cyrillic)
        text = key.name.toLocaleUpperCase()
      } else {
        text = key.name
      }
    }
  }

  if (text) {
    if (codepoint === 0) {
      key.name = text
    }
    key.sequence = text
  }

  if (codepoint === 0 && text === "") {
    return null
  }

  return key
}
