import { Buffer } from "node:buffer"
import { SystemClock } from "./clock.js"
import { kittyKeyMap } from "./kitty-keys.js"
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

/** Every multi-character key name the input parser gives a key. */
export const terminalNamedSingleStrokeKeys = [...new Set(["linefeed", "space", ...Object.values(kittyKeyMap)])]

let oneShotMs = 0
let oneShot: NativeStdinParser | null = null

/**
 * Parses `s` as complete input with the renderer's native input parser. Returns the first event when it is a key,
 * and null when the input is empty or starts with a mouse event, a paste, or a terminal reply.
 */
export function parseKeypress(s: Buffer | string = "", options: ParseKeypressOptions = {}): ParsedKey | null {
  // Each call runs past the escape timeout on its own clock, so a lone ESC ends as Escape.
  oneShot ??= new NativeStdinParser({
    armTimeouts: false,
    clock: Object.assign(new SystemClock(), { now: () => oneShotMs }),
  })
  oneShot.reset()
  oneShot.updateProtocolContext({ kittyKeyboardEnabled: options.useKittyKeyboard === true })
  oneShot.push(typeof s === "string" ? Buffer.from(s) : s)
  oneShot.flushTimeout((oneShotMs += 1000))
  const event = oneShot.read()
  return event?.type === "key" ? event.key : null
}
