import { Buffer } from "node:buffer"
import type { CliRenderer } from "../renderer.js"
import { ANSI } from "../ansi.js"

export function pasteBytes(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text))
}

export const KeyCodes = {
  // Control keys
  RETURN: "\r",
  LINEFEED: "\n",
  TAB: "\t",
  BACKSPACE: "\b",
  // NOTE: This may depend on the platform and terminals
  DELETE: "\x1b[3~",
  HOME: "\x1b[H",
  END: "\x1b[F",
  ESCAPE: "\x1b",

  // Arrow keys
  ARROW_UP: "\x1b[A",
  ARROW_DOWN: "\x1b[B",
  ARROW_RIGHT: "\x1b[C",
  ARROW_LEFT: "\x1b[D",

  // Function keys
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
} as const

export type KeyInput = string | keyof typeof KeyCodes

export interface MockKeysOptions {
  kittyKeyboard?: boolean
  otherModifiersMode?: boolean
}

// Kitty keyboard protocol key mappings
const kittyKeyCodeMap: Record<string, number> = {
  escape: 27,
  tab: 9,
  return: 13,
  backspace: 127,
  insert: 57348,
  delete: 57349,
  left: 57350,
  right: 57351,
  up: 57352,
  down: 57353,
  pageup: 57354,
  pagedown: 57355,
  home: 57356,
  end: 57357,
  f1: 57364,
  f2: 57365,
  f3: 57366,
  f4: 57367,
  f5: 57368,
  f6: 57369,
  f7: 57370,
  f8: 57371,
  f9: 57372,
  f10: 57373,
  f11: 57374,
  f12: 57375,
}

function encodeKittySequence(
  codepoint: number,
  modifiers?: { shift?: boolean; ctrl?: boolean; meta?: boolean; super?: boolean; hyper?: boolean },
): string {
  // Kitty keyboard protocol: CSI unicode-key-code ; modifiers u
  // Modifier encoding: shift=1, alt=2, ctrl=4, super=8, hyper=16, meta=32, caps=64, num=128
  let modMask = 0
  if (modifiers?.shift) modMask |= 1
  if (modifiers?.meta) modMask |= 2 // alt/meta
  if (modifiers?.ctrl) modMask |= 4
  if (modifiers?.super) modMask |= 8
  if (modifiers?.hyper) modMask |= 16

  if (modMask === 0) {
    // No modifiers
    return `\x1b[${codepoint}u`
  } else {
    // With modifiers (kitty uses 1-based, so add 1)
    return `\x1b[${codepoint};${modMask + 1}u`
  }
}

function encodeModifyOtherKeysSequence(
  charCode: number,
  modifiers?: { shift?: boolean; ctrl?: boolean; meta?: boolean; super?: boolean; hyper?: boolean },
): string {
  // modifyOtherKeys protocol: CSI 27 ; modifier ; code ~
  // This is the format used by xterm, iTerm2, Ghostty with modifyOtherKeys enabled
  // Modifier encoding: shift=1, alt/option=2, ctrl=4, super=8, hyper=16 (1-based, so add 1)
  let modMask = 0
  if (modifiers?.shift) modMask |= 1
  if (modifiers?.meta) modMask |= 2 // alt/option/meta
  if (modifiers?.ctrl) modMask |= 4
  if (modifiers?.super) modMask |= 8
  if (modifiers?.hyper) modMask |= 16

  // modifyOtherKeys is only used when modifiers are present
  // Without modifiers, use the standard key sequence
  if (modMask === 0) {
    return String.fromCharCode(charCode)
  }

  // With modifiers, use CSI 27 ; modifier ; code ~
  return `\x1b[27;${modMask + 1};${charCode}~`
}

interface ResolvedKey {
  keyValue: string
  keyName: string | undefined
}

function resolveKeyInput(key: KeyInput): ResolvedKey {
  let keyValue: string
  let keyName: string | undefined

  if (typeof key === "string") {
    if (key in KeyCodes) {
      // It's a KeyCode name like "BACKSPACE", "ARROW_UP", etc.
      keyValue = KeyCodes[key as keyof typeof KeyCodes]
      keyName = key.toLowerCase()
    } else {
      // It's a regular character
      keyValue = key
      keyName = undefined
    }
  } else {
    // It's already a keycode enum value
    keyValue = KeyCodes[key]
    if (!keyValue) {
      throw new Error(`Unknown key: ${key}`)
    }
    keyName = String(key).toLowerCase()
  }

  return { keyValue, keyName }
}

export function createMockKeys(renderer: CliRenderer, options?: MockKeysOptions) {
  const useKittyKeyboard = options?.kittyKeyboard ?? false
  const useOtherModifiersMode = options?.otherModifiersMode ?? false

  // Kitty keyboard takes precedence over otherModifiersMode
  const effectiveOtherModifiersMode = useOtherModifiersMode && !useKittyKeyboard

  const pressKeys = async (keys: KeyInput[], delayMs: number = 0): Promise<void> => {
    for (const key of keys) {
      const { keyValue: keyCode } = resolveKeyInput(key)

      renderer.stdin.emit("data", Buffer.from(keyCode))

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }

  const pressKey = (
    key: KeyInput,
    modifiers?: { shift?: boolean; ctrl?: boolean; meta?: boolean; super?: boolean; hyper?: boolean },
  ): void => {
    // Handle Kitty keyboard protocol mode
    if (useKittyKeyboard) {
      // Resolve the key to its string representation or keycode value
      let { keyValue, keyName } = resolveKeyInput(key)

      // Map control characters and escape sequences to their kitty key names
      const valueToKeyNameMap: Record<string, string> = {
        "\b": "backspace",
        "\r": "return",
        "\n": "return",
        "\t": "tab",
        "\x1b": "escape",
        "\x1b[A": "up",
        "\x1b[B": "down",
        "\x1b[C": "right",
        "\x1b[D": "left",
        "\x1b[H": "home",
        "\x1b[F": "end",
        "\x1b[3~": "delete",
      }

      // Check value mapping
      if (keyValue && valueToKeyNameMap[keyValue]) {
        keyName = valueToKeyNameMap[keyValue]
      }

      // Also check for ARROW_ prefix
      if (keyName && keyName.startsWith("arrow_")) {
        keyName = keyName.substring(6) // Remove "arrow_" prefix
      }

      // Check if we have a direct kitty code mapping
      if (keyName && kittyKeyCodeMap[keyName]) {
        const kittyCode = kittyKeyCodeMap[keyName]
        const sequence = encodeKittySequence(kittyCode, modifiers)
        renderer.stdin.emit("data", Buffer.from(sequence))
        return
      }

      // For regular characters, get the codepoint
      if (keyValue && keyValue.length === 1 && !keyValue.startsWith("\x1b")) {
        const codepoint = keyValue.codePointAt(0)
        if (codepoint) {
          const sequence = encodeKittySequence(codepoint, modifiers)
          renderer.stdin.emit("data", Buffer.from(sequence))
          return
        }
      }

      // Fall through to regular mode for unknown keys
    }

    // Handle modifyOtherKeys mode (CSI u protocol variant)
    // Used by xterm, iTerm2, Ghostty with modifyOtherKeys enabled
    if (effectiveOtherModifiersMode && modifiers) {
      // Resolve the key to its string representation or keycode value
      let { keyValue, keyName } = resolveKeyInput(key)

      // Map control characters and escape sequences to their char codes
      const valueToCharCodeMap: Record<string, number> = {
        "\b": 127, // backspace (or 8, but 127 is more common)
        "\r": 13, // return
        "\n": 13, // linefeed -> return
        "\t": 9, // tab
        "\x1b": 27, // escape
        " ": 32, // space
      }

      // Check if we have a control character that needs modifyOtherKeys encoding
      let charCode: number | undefined

      if (keyValue && valueToCharCodeMap[keyValue] !== undefined) {
        charCode = valueToCharCodeMap[keyValue]
      } else if (keyValue && keyValue.length === 1 && !keyValue.startsWith("\x1b")) {
        // For regular single characters
        charCode = keyValue.charCodeAt(0)
      }

      // If we have a char code and modifiers, use modifyOtherKeys format
      if (charCode !== undefined) {
        const sequence = encodeModifyOtherKeysSequence(charCode, modifiers)
        renderer.stdin.emit("data", Buffer.from(sequence))
        return
      }

      // For other keys (like arrow keys with modifiers), fall through to regular mode
    }

    // Regular (non-Kitty, non-modifyOtherKeys) mode
    let keyCode = resolveKeyInput(key).keyValue

    // Apply modifiers if present
    if (modifiers) {
      // For arrow keys and special keys, modify the escape sequence
      if (keyCode.startsWith("\x1b[") && keyCode.length > 2) {
        // Arrow keys: \x1b[A, \x1b[B, \x1b[C, \x1b[D
        // With shift modifier: \x1b[1;2A, \x1b[1;2B, \x1b[1;2C, \x1b[1;2D
        // Special keys like delete: \x1b[3~ becomes \x1b[3;2~ with meta
        const modifier =
          1 +
          (modifiers.shift ? 1 : 0) +
          (modifiers.meta ? 2 : 0) +
          (modifiers.ctrl ? 4 : 0) +
          (modifiers.super ? 8 : 0) +
          (modifiers.hyper ? 16 : 0)
        if (modifier > 1) {
          // Check if it's a sequence like \x1b[3~ (delete, insert, pageup, etc.)
          const tildeMatch = keyCode.match(/^\x1b\[(\d+)~$/)
          if (tildeMatch) {
            // Format: \x1b[number;modifier~
            keyCode = `\x1b[${tildeMatch[1]};${modifier}~`
          } else {
            // Arrow keys and other single-letter endings
            // Insert modifier into sequence
            const ending = keyCode.slice(-1)
            keyCode = `\x1b[1;${modifier}${ending}`
          }
        }
      } else if (keyCode.length === 1) {
        // For regular characters and single-char control codes with modifiers
        let char = keyCode

        // Shift+Tab produces the back-tab escape sequence \x1b[Z in standard ANSI terminals
        if (char === "\t" && modifiers.shift) {
          // Build the base as \x1b[Z, then apply meta prefix if also pressed
          keyCode = modifiers.meta ? "\x1b\x1b[Z" : "\x1b[Z"
          renderer.stdin.emit("data", Buffer.from(keyCode))
          return
        }

        // Special handling for backspace with modifiers - use modifyOtherKeys format
        // Terminals send Ctrl+Backspace as CSI 27;5;127~ (or CSI 27;5;8~)
        // Only use modifyOtherKeys for ctrl, super, or hyper (not shift or meta alone)
        if (char === "\b" && (modifiers.ctrl || modifiers.super || modifiers.hyper)) {
          const modifier =
            1 +
            (modifiers.shift ? 1 : 0) +
            (modifiers.meta ? 2 : 0) +
            (modifiers.ctrl ? 4 : 0) +
            (modifiers.super ? 8 : 0) +
            (modifiers.hyper ? 16 : 0)
          // Use charcode 127 for backspace (DEL)
          keyCode = `\x1b[27;${modifier};127~`
        } else if (modifiers.ctrl) {
          // Handle ctrl modifier for characters
          // Ctrl+letter produces control codes (0x01-0x1a for a-z)
          if (char >= "a" && char <= "z") {
            keyCode = String.fromCharCode(char.charCodeAt(0) - 96)
          } else if (char >= "A" && char <= "Z") {
            keyCode = String.fromCharCode(char.charCodeAt(0) - 64)
          } else {
            // Handle special characters with ctrl modifier
            // These produce ASCII control codes
            const specialCtrlMap: Record<string, string> = {
              "[": "\x1b", // Ctrl+[ = ESC (ASCII 27)
              "\\": "\x1c", // Ctrl+\ = FS (ASCII 28)
              "]": "\x1d", // Ctrl+] = GS (ASCII 29)
              "^": "\x1e", // Ctrl+^ = RS (ASCII 30)
              _: "\x1f", // Ctrl+_ = US (ASCII 31)
              "?": "\x7f", // Ctrl+? = DEL (ASCII 127)
              // Common aliases
              "/": "\x1f", // Ctrl+/ = US (ASCII 31, same as Ctrl+_)
              "-": "\x1f", // Ctrl+- = US (ASCII 31, same as Ctrl+_)
              ".": "\x1e", // Ctrl+. = RS (ASCII 30, same as Ctrl+^)
              ",": "\x1c", // Ctrl+, = FS (ASCII 28, same as Ctrl+\)
              "@": "\x00", // Ctrl+@ = NUL (ASCII 0)
              " ": "\x00", // Ctrl+Space = NUL (ASCII 0)
            }

            if (char in specialCtrlMap) {
              keyCode = specialCtrlMap[char]
            }
            // If no mapping found, keep the original character
          }
          // If meta is also pressed, prefix with escape
          if (modifiers.meta) {
            keyCode = `\x1b${keyCode}`
          }
        } else {
          // Handle shift+meta or just meta
          if (modifiers.shift && char >= "a" && char <= "z") {
            char = char.toUpperCase()
          }
          if (modifiers.meta) {
            // For meta+character (including control codes), prefix with escape
            keyCode = `\x1b${char}`
          } else {
            keyCode = char
          }
        }
      } else if (modifiers.meta && !keyCode.startsWith("\x1b")) {
        // For multi-char sequences that aren't escape sequences (like simple control codes)
        // just prefix with escape for meta
        keyCode = `\x1b${keyCode}`
      }
    }

    renderer.stdin.emit("data", Buffer.from(keyCode))
  }

  const typeText = async (text: string, delayMs: number = 0): Promise<void> => {
    const keys = text.split("")
    await pressKeys(keys, delayMs)
  }

  const pressReturn = (modifiers?: {
    shift?: boolean
    ctrl?: boolean
    meta?: boolean
    super?: boolean
    hyper?: boolean
  }): void => {
    pressKey(KeyCodes.RETURN, modifiers)
  }

  const pressEscape = (modifiers?: {
    shift?: boolean
    ctrl?: boolean
    meta?: boolean
    super?: boolean
    hyper?: boolean
  }): void => {
    pressKey(KeyCodes.ESCAPE, modifiers)
  }

  const pressTab = (modifiers?: {
    shift?: boolean
    ctrl?: boolean
    meta?: boolean
    super?: boolean
    hyper?: boolean
  }): void => {
    pressKey(KeyCodes.TAB, modifiers)
  }

  const pressBackspace = (modifiers?: {
    shift?: boolean
    ctrl?: boolean
    meta?: boolean
    super?: boolean
    hyper?: boolean
  }): void => {
    pressKey(KeyCodes.BACKSPACE, modifiers)
  }

  const pressArrow = (
    direction: "up" | "down" | "left" | "right",
    modifiers?: { shift?: boolean; ctrl?: boolean; meta?: boolean; super?: boolean; hyper?: boolean },
  ): void => {
    const keyMap = {
      up: KeyCodes.ARROW_UP,
      down: KeyCodes.ARROW_DOWN,
      left: KeyCodes.ARROW_LEFT,
      right: KeyCodes.ARROW_RIGHT,
    }
    pressKey(keyMap[direction], modifiers)
  }

  const pressCtrlC = (): void => {
    pressKey("c", { ctrl: true })
  }

  const pasteBracketedText = (text: string): Promise<void> => {
    return pressKeys([ANSI.bracketedPasteStart, text, ANSI.bracketedPasteEnd])
  }

  return {
    pressKeys,
    pressKey,
    typeText,
    pressEnter: pressReturn,
    pressEscape,
    pressTab,
    pressBackspace,
    pressArrow,
    pressCtrlC,
    pasteBracketedText,
  }
}
