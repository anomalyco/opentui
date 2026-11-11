import { Buffer } from "node:buffer"
import { keypadKeyNames, kittyKeyMap } from "./kitty-keys.js"
import { NativeStdinParser } from "./stdin-parser-native.js"

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

/** The input parser's key names: Kitty's functional keys, linefeed, space, and the SS3 keypad keys' names. */
export const terminalNamedSingleStrokeKeys = [
  ...new Set(["linefeed", "space", ...Object.values(kittyKeyMap), ...keypadKeyNames]),
]

/**
 * Decodes `s` as one complete input with the native input parser and returns its first event if that is a key, else
 * null. A live renderer can read the same bytes differently: it delivers keys after a leading mouse, focus or paste
 * event, and while it awaits a terminal reply it takes `CSI 1;2 R` as that reply instead of Shift+F3.
 */
export function parseKeypress(s: Buffer | string = "", options: ParseKeypressOptions = {}): ParsedKey | null {
  const parser = new NativeStdinParser({
    armTimeouts: false,
    protocolContext: { kittyKeyboardEnabled: options.useKittyKeyboard === true },
  })
  try {
    parser.push(typeof s === "string" ? Buffer.from(s) : s)
    // Far past the escape timeout, so a lone ESC ends as Escape.
    parser.flushTimeout(1e12)
    const event = parser.read()
    return event?.type === "key" ? event.key : null
  } finally {
    parser.destroy()
  }
}
