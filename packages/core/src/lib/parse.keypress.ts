// Copied from https://github.com/enquirer/enquirer/blob/36785f3399a41cd61e9d28d1eb9c2fcd73d69b4c/lib/keypress.js
import { Buffer } from "node:buffer"
import { kittyNamedSingleStrokeKeys, parseKittyKeyboard } from "./parse.keypress-kitty.js"

const metaKeyCodeRe = /^(?:\x1b)([a-zA-Z0-9])$/

const fnKeyRe = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/

const keyName: Record<string, string> = {
  /* xterm/gnome ESC O letter */
  OP: "f1",
  OQ: "f2",
  OR: "f3",
  OS: "f4",
  /* xterm/rxvt ESC [ number ~ */
  "[11~": "f1",
  "[12~": "f2",
  "[13~": "f3",
  "[14~": "f4",
  /* from Cygwin and used in libuv */
  "[[A": "f1",
  "[[B": "f2",
  "[[C": "f3",
  "[[D": "f4",
  "[[E": "f5",
  /* common */
  "[15~": "f5",
  "[17~": "f6",
  "[18~": "f7",
  "[19~": "f8",
  "[20~": "f9",
  "[21~": "f10",
  "[23~": "f11",
  "[24~": "f12",
  "[29~": "menu",
  "[57427~": "clear",
  /* xterm ESC [ letter */
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[E": "clear",
  "[F": "end",
  "[H": "home",
  "[P": "f1",
  "[Q": "f2",
  "[S": "f4",
  /* xterm/gnome ESC O letter */
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
  OE: "clear",
  OF: "end",
  OH: "home",
  /* VT100 application keypad (SS3) — sent when terminal enables DECKPAM (ESC =).
   * macOS Terminal.app and other xterm-based terminals emit these when running
   * full-screen apps with the alternate screen. */
  OM: "return",
  Oj: "*",
  Ok: "+",
  Ol: ",",
  Om: "-",
  On: ".",
  Oo: "/",
  Op: "0",
  Oq: "1",
  Or: "2",
  Os: "3",
  Ot: "4",
  Ou: "5",
  Ov: "6",
  Ow: "7",
  Ox: "8",
  Oy: "9",
  OX: "=",
  /* xterm/rxvt ESC [ number ~ */
  "[1~": "home",
  "[2~": "insert",
  "[3~": "delete",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  /* putty */
  "[[5~": "pageup",
  "[[6~": "pagedown",
  /* rxvt */
  "[7~": "home",
  "[8~": "end",
  /* rxvt keys with modifiers */
  "[a": "up",
  "[b": "down",
  "[c": "right",
  "[d": "left",
  "[e": "clear",
  /* option + arrow keys (old style) */
  f: "right",
  b: "left",
  p: "up",
  n: "down",

  "[2$": "insert",
  "[3$": "delete",
  "[5$": "pageup",
  "[6$": "pagedown",
  "[7$": "home",
  "[8$": "end",

  Oa: "up",
  Ob: "down",
  Oc: "right",
  Od: "left",
  Oe: "clear",

  "[2^": "insert",
  "[3^": "delete",
  "[5^": "pageup",
  "[6^": "pagedown",
  "[7^": "home",
  "[8^": "end",
  /* misc. */
  "[Z": "tab",
}

export const nonAlphanumericKeys = [...Object.values(keyName), "backspace"]

export const terminalNamedSingleStrokeKeys = [
  ...new Set(["return", "linefeed", "tab", "escape", "space", ...nonAlphanumericKeys, ...kittyNamedSingleStrokeKeys]),
]

const isShiftKey = (code: string) => {
  return ["[a", "[b", "[c", "[d", "[e", "[2$", "[3$", "[5$", "[6$", "[7$", "[8$", "[Z"].includes(code)
}

const isCtrlKey = (code: string) => {
  return ["Oa", "Ob", "Oc", "Od", "Oe", "[2^", "[3^", "[5^", "[6^", "[7^", "[8^"].includes(code)
}

// Map raw control bytes to the key names that bindings expect. Terminals send
// Ctrl+A..Ctrl+Z as 0x01..0x1a, and they send Ctrl+\\..Ctrl+_ as 0x1c..0x1f.
// The ESC-prefixed meta+ctrl path reuses this mapping, so the raw and meta
// forms stay aligned.
const getCtrlKeyName = (charCode: number): string | undefined => {
  if (charCode === 0) {
    return "space"
  }

  if (charCode >= 1 && charCode <= 26) {
    return String.fromCharCode(charCode + "a".charCodeAt(0) - 1)
  }

  if (charCode >= 28 && charCode <= 31) {
    return String.fromCharCode(charCode + 64)
  }

  return undefined
}

export type KeyEventType = "press" | "repeat" | "release"

export interface ParsedKey {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  sequence: string
  number: boolean
  raw: string
  eventType: KeyEventType
  source: "raw" | "kitty"
  code?: string
  super?: boolean
  hyper?: boolean
  capsLock?: boolean
  numLock?: boolean
  // Kitty's base-layout codepoint as a Unicode number. Example: 99 means "c".
  // This lets shortcut matching recover Ctrl+C from an event whose printed name
  // is something else under the active layout or IME.
  baseCode?: number
  repeated?: boolean
}

export type ParseKeypressOptions = {
  useKittyKeyboard?: boolean
}

// Printable characters for VT100 SS3 application-keypad sequences.
// When the terminal is in application keypad mode (DECKPAM / ESC =), numpad keys
// send these SS3 codes instead of raw ASCII characters. The keys map to the same
// printable output as their regular-keyboard equivalents.
const ss3NumpadPrintable: Record<string, string> = {
  Op: "0",
  Oq: "1",
  Or: "2",
  Os: "3",
  Ot: "4",
  Ou: "5",
  Ov: "6",
  Ow: "7",
  Ox: "8",
  Oy: "9",
  Oj: "*",
  Ok: "+",
  Ol: ",",
  Om: "-",
  On: ".",
  Oo: "/",
  OX: "=",
}

const modifyOtherKeysRe = /^\x1b\[27;(\d+);(\d+)~$/

export const parseKeypress = (s: Buffer | string = "", options: ParseKeypressOptions = {}): ParsedKey | null => {
  let parts

  if (Buffer.isBuffer(s)) {
    if (s[0]! > 127 && s[1] === undefined) {
      ;(s[0] as unknown as number) -= 128
      s = "\x1b" + String(s)
    } else {
      s = String(s)
    }
  } else if (s !== undefined && typeof s !== "string") {
    s = String(s)
  } else if (!s) {
    s = ""
  }

  // Filter out mouse events (SGR and basic)
  // Complete SGR mouse: ESC[<btn;x;yM or ESC[<btn;x;ym
  if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(s)) {
    return null
  }
  // Complete SGR mouse continuation without leading ESC. This can occur when
  // ESC was flushed separately on timeout and the rest of the sequence arrived later.
  if (/^\[<\d+;\d+;\d+[Mm]$/.test(s)) {
    return null
  }
  // Incomplete/partial SGR mouse sequences (flushed by the zig parser when
  // a new ESC arrives before the sequence is complete). These start with
  // ESC[< followed by digits/semicolons but lack the terminal M/m.
  if (/^\x1b\[<[\d;]*$/.test(s)) {
    return null
  }
  // Incomplete/partial SGR mouse continuations without ESC.
  if (/^\[<[\d;]*$/.test(s)) {
    return null
  }
  if (s.startsWith("\x1b[M") && s.length >= 6) {
    return null
  }

  // Filter out terminal response sequences (not keyboard events)
  // These are responses to terminal queries and should not be treated as key presses

  // Window/cell size reports: ESC[4;height;width t or ESC[8;rows;cols t
  if (/^\x1b\[\d+;\d+;\d+t$/.test(s)) {
    return null
  }

  // Cursor position reports (DSR): ESC[row;col R
  if (/^\x1b\[\d+;\d+R$/.test(s)) {
    return null
  }

  // Device Attributes (DA) responses: ESC[?...c
  if (/^\x1b\[\?[\d;]+c$/.test(s)) {
    return null
  }

  // Mode reports: ESC[?...;...$y
  if (/^\x1b\[\?[\d;]+\$y$/.test(s)) {
    return null
  }

  // Focus events: ESC[I (focus in), ESC[O (focus out)
  // Note: ESC[O is also used for SS3 sequences (like arrow keys), but those have a character after O
  if (s === "\x1b[I" || s === "\x1b[O") {
    return null
  }

  // OSC (Operating System Command) responses: ESC]...ESC\ or ESC]...BEL
  if (/^\x1b\][\d;].*(\x1b\\|\x07)$/.test(s)) {
    return null
  }

  // Bracketed paste mode markers: ESC[200~ (start), ESC[201~ (end)
  if (s === "\x1b[200~" || s === "\x1b[201~") {
    return null
  }

  const key: ParsedKey = {
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: s,
    raw: s,
    eventType: "press",
    source: "raw",
  }

  key.sequence = key.sequence || s || key.name

  const ctrlKeyName = s.length === 1 ? getCtrlKeyName(s.charCodeAt(0)) : undefined
  const metaCtrlKeyName = s.length === 2 && s[0] === "\x1b" ? getCtrlKeyName(s.charCodeAt(1)) : undefined

  // Check for Kitty keyboard protocol if enabled
  if (options.useKittyKeyboard) {
    const kittyResult = parseKittyKeyboard(s)
    if (kittyResult) {
      return kittyResult
    }
  }

  // Check for modifyOtherKeys sequences (CSI u protocol variant)
  // Format: CSI 27 ; modifier ; code ~
  // This is sent by terminals (xterm, iTerm2, Ghostty, etc.) with modifyOtherKeys mode enabled
  // to encode modified versions of keys that don't normally have modifier variants
  // Examples: CSI 27;2;13~ (shift+enter), CSI 27;5;13~ (ctrl+enter), CSI 27;5;27~ (ctrl+escape)
  const modifyOtherKeysMatch = modifyOtherKeysRe.exec(s)
  if (modifyOtherKeysMatch) {
    const modifier = parseInt(modifyOtherKeysMatch[1]!, 10) - 1
    const charCode = parseInt(modifyOtherKeysMatch[2]!, 10)

    key.ctrl = !!(modifier & 4)
    key.meta = !!(modifier & 2) // Alt/Option sets meta
    key.shift = !!(modifier & 1)
    key.option = !!(modifier & 2)
    key.super = !!(modifier & 8)
    key.hyper = !!(modifier & 16)

    // Handle common keys by their ASCII codes
    if (charCode === 13) {
      key.name = "return"
    } else if (charCode === 27) {
      key.name = "escape"
    } else if (charCode === 9) {
      key.name = "tab"
    } else if (charCode === 32) {
      key.name = "space"
    } else if (charCode === 127 || charCode === 8) {
      key.name = "backspace"
    } else {
      // For other character codes, use the character itself
      const char = String.fromCharCode(charCode)
      key.name = char
      key.sequence = char
      if (charCode >= 48 && charCode <= 57) {
        key.number = true
      }
    }

    return key
  }

  if (s === "\r" || s === "\x1b\r") {
    // carriage return
    key.name = "return"
    key.meta = s.length === 2
  } else if (s === "\n" || s === "\x1b\n") {
    // linefeed
    key.name = "linefeed"
    key.meta = s.length === 2
  } else if (s === "\t") {
    // tab
    key.name = "tab"
  } else if (s === "\b" || s === "\x1b\b" || s === "\x7f" || s === "\x1b\x7f") {
    // backspace or ctrl+h
    // On OSX, \x7f is also backspace
    key.name = "backspace"
    key.meta = s.charAt(0) === "\x1b"
  } else if (s === "\x1b" || s === "\x1b\x1b") {
    // escape key
    key.name = "escape"
    key.meta = s.length === 2
  } else if (s === " " || s === "\x1b ") {
    key.name = "space"
    key.meta = s.length === 2
  } else if (ctrlKeyName) {
    // ctrl+space, ctrl+letter, ctrl+\\, ctrl+], ctrl+^, ctrl+_
    key.name = ctrlKeyName
    key.ctrl = true
  } else if (s.length === 1 && s >= "0" && s <= "9") {
    // number - keep the actual number character for vim commands
    key.name = s
    key.number = true
  } else if (s.length === 1 && s >= "a" && s <= "z") {
    // lowercase letter
    key.name = s
  } else if (s.length === 1 && s >= "A" && s <= "Z") {
    // shift+letter
    key.name = s.toLowerCase()
    key.shift = true
  } else if (s.length === 1 || (s.length === 2 && s.codePointAt(0)! > 0xffff)) {
    // Single character (including emoji/surrogate pairs above BMP)
    key.name = s
  } else if ((parts = metaKeyCodeRe.exec(s))) {
    // meta+character key
    key.meta = true
    const char = parts[1]!
    const isUpperCase = /^[A-Z]$/.test(char)

    // Check if uppercase F or B map to arrow keys (old terminal style)
    if (char === "F") {
      key.name = "right"
    } else if (char === "B") {
      key.name = "left"
    } else if (isUpperCase) {
      key.shift = true
      key.name = char
    } else {
      key.name = char
    }
  } else if (metaCtrlKeyName) {
    // ESC + control byte is the raw meta+ctrl form. Reuse the same names as
    // the plain ctrl path, so meta+ctrl+\\ and friends resolve consistently.
    key.meta = true
    key.ctrl = true
    key.name = metaCtrlKeyName
  } else if ((parts = fnKeyRe.exec(s))) {
    const segs = [...s]

    if (segs[0] === "\u001b" && segs[1] === "\u001b") {
      key.option = true
      key.meta = true
    }

    // ansi escape sequence
    // reassemble the key code leaving out leading \x1b's,
    // the modifier key bitflag and any meaningless "1;" sequence
    const code = [parts[1], parts[2], parts[4], parts[6]].filter(Boolean).join("")

    const modifier = parseInt(parts[3] || parts[5] || "1", 10) - 1

    // Parse the key modifier
    // Terminal modifier bits: 1=Shift, 2=Alt/Option, 4=Ctrl, 8=Super, 16=Hyper
    // Note: meta flag is set for Alt/Option (bit 2)
    key.ctrl = key.ctrl || !!(modifier & 4)
    key.meta = key.meta || !!(modifier & 2)
    key.shift = key.shift || !!(modifier & 1)
    key.option = key.option || !!(modifier & 2)
    key.super = !!(modifier & 8)
    key.hyper = !!(modifier & 16)
    key.code = code

    const keyNameResult = keyName[code]
    if (keyNameResult) {
      key.name = keyNameResult
      key.shift = isShiftKey(code) || key.shift
      key.ctrl = isCtrlKey(code) || key.ctrl

      // SS3 application-keypad sequences have a raw sequence starting with ESC
      // which the text-insertion branch would filter out (charCode 27 < 32).
      // Override sequence with the printable character so text input works.
      const ss3Char = ss3NumpadPrintable[code]
      if (ss3Char !== undefined) {
        key.sequence = ss3Char
        if (key.name >= "0" && key.name <= "9") {
          key.number = true
        }
      }
    } else {
      // If we matched the regex but didn't find a valid key name,
      // reset the key to default state (unknown sequence)
      key.name = ""
      key.code = undefined
    }
  } else if (s === "\x1b[3~") {
    // delete key
    key.name = "delete"
    key.meta = false
    key.code = "[3~"
  }

  return key
}
