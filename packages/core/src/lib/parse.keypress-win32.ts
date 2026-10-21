// win32-input-mode key event decoder.
//
// Windows Terminal's win32-input-mode (DEC private mode 9001) reports every
// key event as a CSI sequence terminated by `_`:
//
//   CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
//
//   Vk  wVirtualKeyCode
//   Sc  wVirtualScanCode
//   Uc  UnicodeChar the key produced
//   Kd  bKeyDown: 1 for a press, 0 for a release
//   Cs  dwControlKeyState
//   Rc  wRepeatCount
//
// Omitted parameters default to Vk=0, Sc=0, Uc=0, Kd=0, Cs=0, Rc=1, so a
// bare `CSI _` is a legal (degenerate) event.
//
// The control key state uses the Win32 KEY_EVENT_RECORD bits:
// 0x01 right alt, 0x02 left alt, 0x04 right ctrl, 0x08 left ctrl,
// 0x10 shift, 0x20 numlock, 0x40 capslock, 0x80 enhanced.
//
// This encoding is the only one Windows Terminal offers that keeps the
// modifier state of a key. The legacy encoding cannot express Ctrl+Tab at
// all: the byte is identical to Tab, and Windows Terminal additionally binds
// Ctrl+Tab to its own `Terminal.NextTab` action, so the key never reaches the
// application.
//
// See https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md

import type { ParsedKey } from "./parse.keypress.js"

// CSI ... _ with only digits and semicolons in between. `_` is not used as a
// CSI final byte by any other protocol, so this shape is unambiguous.
const WIN32_SEQUENCE_RE = /^\x1b\[([\d;]*)_$/

// Win32 virtual key codes that name a key instead of producing a character.
// Several of these collide with printable ASCII (0x21-0x2e), so the produced
// codepoint decides: a real character wins over the named key.
const win32NamedKeys: Record<number, string> = {
  0x08: "backspace",
  0x09: "tab",
  0x0d: "return",
  0x1b: "escape",
  0x21: "pageup",
  0x22: "pagedown",
  0x23: "end",
  0x24: "home",
  0x25: "left",
  0x26: "up",
  0x27: "right",
  0x28: "down",
  0x2c: "printscreen",
  0x2d: "insert",
  0x2e: "delete",
  0x70: "f1",
  0x71: "f2",
  0x72: "f3",
  0x73: "f4",
  0x74: "f5",
  0x75: "f6",
  0x76: "f7",
  0x77: "f8",
  0x78: "f9",
  0x79: "f10",
  0x7a: "f11",
  0x7b: "f12",
}

// Keys that never produce a character. Windows Terminal reports them as their
// own events, which is how a lone Ctrl or a lone Shift stays observable.
const win32ModifierKeys: Record<number, string> = {
  0x10: "shift",
  0x11: "ctrl",
  0x12: "alt",
  0x14: "capslock",
  0x5b: "leftsuper",
  0x5c: "rightsuper",
  0x90: "numlock",
  0x91: "scrolllock",
  0xa0: "leftshift",
  0xa1: "rightshift",
  0xa2: "leftctrl",
  0xa3: "rightctrl",
  0xa4: "leftalt",
  0xa5: "rightalt",
}

const CONTROL_STATE_RIGHT_ALT = 0x0001
const CONTROL_STATE_LEFT_ALT = 0x0002
const CONTROL_STATE_RIGHT_CTRL = 0x0004
const CONTROL_STATE_LEFT_CTRL = 0x0008
const CONTROL_STATE_SHIFT = 0x0010
const CONTROL_STATE_NUMLOCK = 0x0020
const CONTROL_STATE_CAPSLOCK = 0x0040

function isPrintableCodepoint(codepoint: number): boolean {
  if (codepoint === 0) return false
  if (codepoint < 0x20) return false
  if (codepoint === 0x7f) return false
  return codepoint <= 0x10ffff
}

/**
 * Whether the sequence is a win32-input-mode key event.
 *
 * The shape is unique: no other protocol terminates a CSI with `_`.
 */
export function isWin32KeyboardSequence(sequence: string): boolean {
  return WIN32_SEQUENCE_RE.test(sequence)
}

/**
 * Decode a win32-input-mode key event.
 *
 * Returns null when the sequence is not a win32 key event.
 */
export function parseWin32Keyboard(sequence: string): ParsedKey | null {
  const match = WIN32_SEQUENCE_RE.exec(sequence)
  if (!match) return null

  const params = (match[1] ?? "").split(";").map((value) => (value === "" ? 0 : Number.parseInt(value, 10)))
  const virtualKey = params[0] ?? 0
  const producedCodepoint = params[2] ?? 0
  const keyDown = params[3] ?? 0
  const controlState = params[4] ?? 0
  const repeatCount = params[5] ?? 1

  const ctrl = (controlState & (CONTROL_STATE_LEFT_CTRL | CONTROL_STATE_RIGHT_CTRL)) !== 0
  const alt = (controlState & (CONTROL_STATE_LEFT_ALT | CONTROL_STATE_RIGHT_ALT)) !== 0
  const shift = (controlState & CONTROL_STATE_SHIFT) !== 0

  const key: ParsedKey = {
    name: "",
    ctrl,
    meta: alt,
    shift,
    option: alt,
    number: false,
    sequence,
    raw: sequence,
    eventType: keyDown === 0 ? "release" : "press",
    source: "win32",
    super: false,
    hyper: false,
    capsLock: (controlState & CONTROL_STATE_CAPSLOCK) !== 0,
    numLock: (controlState & CONTROL_STATE_NUMLOCK) !== 0,
  }

  if (keyDown !== 0 && repeatCount > 1) {
    key.repeated = true
  }

  const modifierName = win32ModifierKeys[virtualKey]
  if (modifierName !== undefined) {
    key.name = modifierName
    return key
  }

  const namedKey = win32NamedKeys[virtualKey]
  if (namedKey !== undefined && !isPrintableCodepoint(producedCodepoint)) {
    key.name = namedKey
    return key
  }

  // The virtual key code doubles as the ASCII code for letters, digits and
  // punctuation, which is what the key produces on a Latin layout.
  let character: string | undefined
  if (virtualKey >= 0x20 && virtualKey <= 0x7e) {
    character = String.fromCharCode(virtualKey)
  } else if (isPrintableCodepoint(producedCodepoint)) {
    // OEM keys report a virtual key code outside ASCII but still produce a
    // character, for example the quote key on a US layout.
    character = String.fromCodePoint(producedCodepoint)
  }

  if (character === undefined) {
    return key
  }

  if (character === " ") {
    key.name = "space"
    key.sequence = " "
    return key
  }

  // The virtual key code is the unshifted key, so an uppercase letter means
  // the shift state is carried by the control key state, not by the letter.
  // The name is always the base letter; the shift flag says whether shift was
  // held.
  key.name = character >= "A" && character <= "Z" ? character.toLowerCase() : character

  // The text the key actually produced. Windows Terminal reports the shifted
  // character on a press and the base character on a release, and reports the
  // control character for a Ctrl combination.
  if (isPrintableCodepoint(producedCodepoint)) {
    key.sequence = String.fromCodePoint(producedCodepoint)
  } else {
    key.sequence = key.name
  }

  if (key.name >= "0" && key.name <= "9") {
    key.number = true
  }
  return key
}
