import { test, expect } from "bun:test"
import { parseKeypress, nonAlphanumericKeys, type ParsedKey, type KeyEventType } from "./parse.keypress.js"
import { Buffer } from "node:buffer"

test("parseKeypress - basic letters", () => {
  expect(parseKeypress("a")).toEqual({
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "a",
    eventType: "press",
    source: "raw",
  })

  expect(parseKeypress("A")).toEqual({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "A",
    raw: "A",
    source: "raw",
  })
})

test("parseKeypress - numbers", () => {
  expect(parseKeypress("1")).toEqual({
    eventType: "press",
    name: "1",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: true,
    sequence: "1",
    raw: "1",
    source: "raw",
  })
})

test("parseKeypress - special keys", () => {
  expect(parseKeypress("\r")).toEqual({
    eventType: "press",
    name: "return",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\r",
    raw: "\r",
    source: "raw",
  })

  expect(parseKeypress("\n")).toEqual({
    eventType: "press",
    name: "linefeed",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\n",
    raw: "\n",
    source: "raw",
  })

  expect(parseKeypress("\x1b\r")).toEqual({
    eventType: "press",
    name: "return",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b\r",
    raw: "\x1b\r",
    source: "raw",
  })

  expect(parseKeypress("\x1b\n")).toEqual({
    eventType: "press",
    name: "linefeed",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b\n",
    raw: "\x1b\n",
    source: "raw",
  })

  expect(parseKeypress("\t")).toEqual({
    eventType: "press",
    name: "tab",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\t",
    raw: "\t",
    source: "raw",
  })

  expect(parseKeypress("\b")).toEqual({
    eventType: "press",
    name: "backspace",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\b",
    raw: "\b",
    source: "raw",
  })

  expect(parseKeypress("\x1b")).toEqual({
    name: "escape",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b",
    raw: "\x1b",
    eventType: "press",
    source: "raw",
  })

  expect(parseKeypress(" ")).toEqual({
    eventType: "press",
    name: "space",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: " ",
    raw: " ",
    source: "raw",
  })
})

test("parseKeypress - ctrl+letter combinations", () => {
  expect(parseKeypress("\x01")).toEqual({
    eventType: "press",
    name: "a",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x01",
    raw: "\x01",
    source: "raw",
  })

  expect(parseKeypress("\x1a")).toEqual({
    eventType: "press",
    name: "z",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1a",
    raw: "\x1a",
    source: "raw",
  })
})

test("parseKeypress - raw ctrl+\\ and related control bytes", () => {
  expect(parseKeypress("\x1c")).toEqual({
    eventType: "press",
    name: "\\",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1c",
    raw: "\x1c",
    source: "raw",
  })

  expect(parseKeypress("\x1d")).toEqual({
    eventType: "press",
    name: "]",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1d",
    raw: "\x1d",
    source: "raw",
  })

  expect(parseKeypress("\x1e")).toEqual({
    eventType: "press",
    name: "^",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1e",
    raw: "\x1e",
    source: "raw",
  })

  expect(parseKeypress("\x1f")).toEqual({
    eventType: "press",
    name: "_",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1f",
    raw: "\x1f",
    source: "raw",
  })
})

test("parseKeypress - meta+raw ctrl+\\ and related control bytes", () => {
  expect(parseKeypress("\x1b\x1c")).toEqual({
    eventType: "press",
    name: "\\",
    ctrl: true,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b\x1c",
    raw: "\x1b\x1c",
    source: "raw",
  })

  expect(parseKeypress("\x1b\x1d")).toEqual({
    eventType: "press",
    name: "]",
    ctrl: true,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b\x1d",
    raw: "\x1b\x1d",
    source: "raw",
  })

  expect(parseKeypress("\x1b\x1e")).toEqual({
    eventType: "press",
    name: "^",
    ctrl: true,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b\x1e",
    raw: "\x1b\x1e",
    source: "raw",
  })

  expect(parseKeypress("\x1b\x1f")).toEqual({
    eventType: "press",
    name: "_",
    ctrl: true,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b\x1f",
    raw: "\x1b\x1f",
    source: "raw",
  })
})

test("parseKeypress - ctrl+space and alt+space", () => {
  // Ctrl+Space sends \x00 (null character)
  expect(parseKeypress("\x00")).toEqual({
    eventType: "press",
    name: "space",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x00",
    raw: "\x00",
    source: "raw",
  })

  // Also test with unicode escape notation
  expect(parseKeypress("\u0000")).toEqual({
    eventType: "press",
    name: "space",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\u0000",
    raw: "\u0000",
    source: "raw",
  })

  // Alt+Space / Option+Space sends ESC + space (\x1b or \u001b followed by space)
  // Note: meta=true indicates Alt/Option was pressed, but option=false because
  // this is a simple ESC-prefix sequence (not an ANSI sequence with modifier bits)
  expect(parseKeypress("\x1b ")).toEqual({
    eventType: "press",
    name: "space",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b ",
    raw: "\x1b ",
    source: "raw",
  })

  // Test with \u001b notation as well
  expect(parseKeypress("\u001b ")).toEqual({
    eventType: "press",
    name: "space",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\u001b ",
    raw: "\u001b ",
    source: "raw",
  })
})

test("parseKeypress - meta+character combinations", () => {
  // Simple ESC+character sequences (like ESC+a) set meta=true but option=false
  // These sequences are typically generated by Alt/Option+key on many terminals
  // but the simple ESC prefix doesn't distinguish between Alt/Option and Meta/Cmd
  // so option flag is NOT set (unlike ANSI sequences with explicit modifier bits)
  expect(parseKeypress("\x1ba")).toEqual({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: true,
    shift: false,
    option: false, // Note: option is NOT set for simple ESC+char sequences
    number: false,
    sequence: "\x1ba",
    raw: "\x1ba",
    source: "raw",
  })

  expect(parseKeypress("\x1bA")).toEqual({
    eventType: "press",
    name: "A",
    ctrl: false,
    meta: true,
    shift: true,
    option: false, // Note: option is NOT set for simple ESC+char sequences
    number: false,
    sequence: "\x1bA",
    raw: "\x1bA",
    source: "raw",
  })
})

test("parseKeypress - function keys", () => {
  expect(parseKeypress("\x1bOP")).toEqual({
    eventType: "press",
    name: "f1",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1bOP",
    raw: "\x1bOP",
    code: "OP",
    super: false,
    hyper: false,
    source: "raw",
  })

  expect(parseKeypress("\x1b[11~")).toEqual({
    eventType: "press",
    name: "f1",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[11~",
    raw: "\x1b[11~",
    code: "[11~",
    super: false,
    hyper: false,
    source: "raw",
  })

  expect(parseKeypress("\x1b[24~")).toEqual({
    eventType: "press",
    name: "f12",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[24~",
    raw: "\x1b[24~",
    code: "[24~",
    super: false,
    hyper: false,
    source: "raw",
  })
})

test("parseKeypress - arrow keys", () => {
  expect(parseKeypress("\x1b[A")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[A",
    raw: "\x1b[A",
    code: "[A",
    super: false,
    hyper: false,
    source: "raw",
  })

  expect(parseKeypress("\x1b[B")).toEqual({
    eventType: "press",
    name: "down",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[B",
    raw: "\x1b[B",
    code: "[B",
    super: false,
    hyper: false,
    source: "raw",
  })

  expect(parseKeypress("\x1b[C")).toEqual({
    eventType: "press",
    name: "right",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[C",
    raw: "\x1b[C",
    code: "[C",
    super: false,
    hyper: false,
    source: "raw",
  })

  expect(parseKeypress("\x1b[D")).toEqual({
    eventType: "press",
    name: "left",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[D",
    raw: "\x1b[D",
    code: "[D",
    super: false,
    hyper: false,
    source: "raw",
  })
})

test("parseKeypress - navigation keys", () => {
  expect(parseKeypress("\x1b[H")).toEqual({
    eventType: "press",
    name: "home",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[H",
    raw: "\x1b[H",
    code: "[H",
    super: false,
    hyper: false,
    source: "raw",
  })

  expect(parseKeypress("\x1b[F")).toEqual({
    eventType: "press",
    name: "end",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[F",
    raw: "\x1b[F",
    code: "[F",
    super: false,
    hyper: false,
    source: "raw",
  })

  expect(parseKeypress("\x1b[5~")).toEqual({
    eventType: "press",
    name: "pageup",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[5~",
    raw: "\x1b[5~",
    code: "[5~",
    super: false,
    hyper: false,
    source: "raw",
  })

  expect(parseKeypress("\x1b[6~")).toEqual({
    eventType: "press",
    name: "pagedown",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[6~",
    raw: "\x1b[6~",
    code: "[6~",
    super: false,
    hyper: false,
    source: "raw",
  })
})

test("parseKeypress - modifier combinations", () => {
  // Shift only: modifier value 2 = bits 1 (0b0001)
  expect(parseKeypress("\x1b[1;2A")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "\x1b[1;2A",
    raw: "\x1b[1;2A",
    code: "[A",
    super: false,
    hyper: false,
    source: "raw",
  })

  // Alt/Option key: modifier value 3 = bits 2 (0b0010)
  // Note: Alt/Option (same key) sets both meta and option flags
  expect(parseKeypress("\x1b[1;3A")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: true,
    shift: false,
    option: true,
    number: false,
    sequence: "\x1b[1;3A",
    raw: "\x1b[1;3A",
    code: "[A",
    super: false,
    hyper: false,
    source: "raw",
  })

  // Shift+Alt/Option: modifier value 4 = bits 3 (0b0011 = Shift(1) + Alt/Option(2))
  expect(parseKeypress("\x1b[1;4A")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: true,
    shift: true,
    option: true,
    number: false,
    sequence: "\x1b[1;4A",
    raw: "\x1b[1;4A",
    code: "[A",
    super: false,
    hyper: false,
    source: "raw",
  })

  // Ctrl only: modifier value 5 = bits 4 (0b0100)
  expect(parseKeypress("\x1b[1;5A")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[1;5A",
    raw: "\x1b[1;5A",
    code: "[A",
    super: false,
    hyper: false,
    source: "raw",
  })

  // Shift+Alt/Option+Ctrl: modifier value 8 = bits 7 (0b0111 = Shift(1) + Alt/Option(2) + Ctrl(4))
  // Note: meta is true because Alt/Option is pressed, NOT because Meta/Cmd bit is set
  expect(parseKeypress("\x1b[1;8A")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: true,
    meta: true,
    shift: true,
    option: true,
    number: false,
    sequence: "\x1b[1;8A",
    raw: "\x1b[1;8A",
    code: "[A",
    super: false,
    hyper: false,
    source: "raw",
  })

  // Super modifier bit only: modifier value 9 = bits 8 (0b1000)
  // NOTE: This is bit 8 which is the Super key
  expect(parseKeypress("\x1b[1;9A")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[1;9A",
    raw: "\x1b[1;9A",
    code: "[A",
    super: true,
    hyper: false,
    source: "raw",
  })

  // Shift+Super: modifier value 10 = bits 9 (0b1001 = Shift(1) + Super(8))
  expect(parseKeypress("\x1b[1;10A")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "\x1b[1;10A",
    raw: "\x1b[1;10A",
    code: "[A",
    super: true,
    hyper: false,
    source: "raw",
  })

  // Alt/Option+Super: modifier value 11 = bits 10 (0b1010 = Alt/Option(2) + Super(8))
  expect(parseKeypress("\x1b[1;11A")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: true,
    shift: false,
    option: true,
    number: false,
    sequence: "\x1b[1;11A",
    raw: "\x1b[1;11A",
    code: "[A",
    super: true,
    hyper: false,
    source: "raw",
  })

  // All ANSI modifier bits: modifier value 16 = bits 15 (0b1111 = Shift(1) + Alt(2) + Ctrl(4) + Super(8))
  expect(parseKeypress("\x1b[1;16A")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: true,
    meta: true,
    shift: true,
    option: true,
    number: false,
    sequence: "\x1b[1;16A",
    raw: "\x1b[1;16A",
    code: "[A",
    super: true,
    hyper: false,
    source: "raw",
  })
})

test("parseKeypress - delete key", () => {
  expect(parseKeypress("\x1b[3~")).toEqual({
    eventType: "press",
    name: "delete",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[3~",
    raw: "\x1b[3~",
    code: "[3~",
    super: false,
    hyper: false,
    source: "raw",
  })
})

test("parseKeypress - delete key with modifiers (modifyOtherKeys format)", () => {
  // Delete key without modifiers: \x1b[3~
  const plainDelete = parseKeypress("\x1b[3~")!
  expect(plainDelete.name).toBe("delete")
  expect(plainDelete.shift).toBe(false)
  expect(plainDelete.ctrl).toBe(false)
  expect(plainDelete.meta).toBe(false)
  expect(plainDelete.option).toBe(false)

  // Shift+Delete: \x1b[3;2~
  const shiftDelete = parseKeypress("\x1b[3;2~")!
  expect(shiftDelete.name).toBe("delete")
  expect(shiftDelete.shift).toBe(true)
  expect(shiftDelete.ctrl).toBe(false)
  expect(shiftDelete.meta).toBe(false)
  expect(shiftDelete.option).toBe(false)
  expect(shiftDelete.sequence).toBe("\x1b[3;2~")
  expect(shiftDelete.code).toBe("[3~")

  // Option/Meta+Delete: \x1b[3;3~
  const metaDelete = parseKeypress("\x1b[3;3~")!
  expect(metaDelete.name).toBe("delete")
  expect(metaDelete.meta).toBe(true)
  expect(metaDelete.option).toBe(true)
  expect(metaDelete.ctrl).toBe(false)
  expect(metaDelete.shift).toBe(false)
  expect(metaDelete.sequence).toBe("\x1b[3;3~")
  expect(metaDelete.code).toBe("[3~")

  // Ctrl+Delete: \x1b[3;5~
  const ctrlDelete = parseKeypress("\x1b[3;5~")!
  expect(ctrlDelete.name).toBe("delete")
  expect(ctrlDelete.ctrl).toBe(true)
  expect(ctrlDelete.shift).toBe(false)
  expect(ctrlDelete.meta).toBe(false)
  expect(ctrlDelete.option).toBe(false)
  expect(ctrlDelete.sequence).toBe("\x1b[3;5~")
  expect(ctrlDelete.code).toBe("[3~")

  // Shift+Option+Delete: \x1b[3;4~
  const shiftMetaDelete = parseKeypress("\x1b[3;4~")!
  expect(shiftMetaDelete.name).toBe("delete")
  expect(shiftMetaDelete.shift).toBe(true)
  expect(shiftMetaDelete.meta).toBe(true)
  expect(shiftMetaDelete.option).toBe(true)
  expect(shiftMetaDelete.ctrl).toBe(false)
  expect(shiftMetaDelete.sequence).toBe("\x1b[3;4~")
  expect(shiftMetaDelete.code).toBe("[3~")

  // Ctrl+Option+Delete: \x1b[3;7~
  const ctrlMetaDelete = parseKeypress("\x1b[3;7~")!
  expect(ctrlMetaDelete.name).toBe("delete")
  expect(ctrlMetaDelete.ctrl).toBe(true)
  expect(ctrlMetaDelete.meta).toBe(true)
  expect(ctrlMetaDelete.option).toBe(true)
  expect(ctrlMetaDelete.shift).toBe(false)
  expect(ctrlMetaDelete.sequence).toBe("\x1b[3;7~")
  expect(ctrlMetaDelete.code).toBe("[3~")
})

test("parseKeypress - delete key with modifiers (Kitty keyboard protocol)", () => {
  // Delete key in Kitty protocol uses code 57349
  // Without modifiers: \x1b[57349u
  const plainDelete = parseKeypress("\x1b[57349u", { useKittyKeyboard: true })!
  expect(plainDelete.name).toBe("delete")
  expect(plainDelete.shift).toBe(false)
  expect(plainDelete.ctrl).toBe(false)
  expect(plainDelete.meta).toBe(false)
  expect(plainDelete.source).toBe("kitty")

  // Shift+Delete: \x1b[57349;2u
  const shiftDelete = parseKeypress("\x1b[57349;2u", { useKittyKeyboard: true })!
  expect(shiftDelete.name).toBe("delete")
  expect(shiftDelete.shift).toBe(true)
  expect(shiftDelete.ctrl).toBe(false)
  expect(shiftDelete.meta).toBe(false)
  expect(shiftDelete.source).toBe("kitty")

  // Option/Meta+Delete: \x1b[57349;3u
  const metaDelete = parseKeypress("\x1b[57349;3u", { useKittyKeyboard: true })!
  expect(metaDelete.name).toBe("delete")
  expect(metaDelete.meta).toBe(true)
  expect(metaDelete.ctrl).toBe(false)
  expect(metaDelete.shift).toBe(false)
  expect(metaDelete.source).toBe("kitty")

  // Ctrl+Delete: \x1b[57349;5u
  const ctrlDelete = parseKeypress("\x1b[57349;5u", { useKittyKeyboard: true })!
  expect(ctrlDelete.name).toBe("delete")
  expect(ctrlDelete.ctrl).toBe(true)
  expect(ctrlDelete.shift).toBe(false)
  expect(ctrlDelete.meta).toBe(false)
  expect(ctrlDelete.source).toBe("kitty")
})

test("parseKeypress - backspace key with modifiers (modifyOtherKeys format)", () => {
  // Backspace is typically \x7f or \b, but with modifiers uses modifyOtherKeys format

  // Shift+Backspace: \x1b[27;2;127~ (using charcode 127)
  const shiftBackspace = parseKeypress("\x1b[27;2;127~")!
  expect(shiftBackspace.name).toBe("backspace")
  expect(shiftBackspace.shift).toBe(true)
  expect(shiftBackspace.ctrl).toBe(false)
  expect(shiftBackspace.meta).toBe(false)
  expect(shiftBackspace.option).toBe(false)

  // Ctrl+Backspace: \x1b[27;5;127~
  const ctrlBackspace = parseKeypress("\x1b[27;5;127~")!
  expect(ctrlBackspace.name).toBe("backspace")
  expect(ctrlBackspace.ctrl).toBe(true)
  expect(ctrlBackspace.shift).toBe(false)
  expect(ctrlBackspace.meta).toBe(false)
  expect(ctrlBackspace.option).toBe(false)

  // Option/Meta+Backspace: \x1b[27;3;127~
  const metaBackspace = parseKeypress("\x1b[27;3;127~")!
  expect(metaBackspace.name).toBe("backspace")
  expect(metaBackspace.meta).toBe(true)
  expect(metaBackspace.option).toBe(true)
  expect(metaBackspace.ctrl).toBe(false)
  expect(metaBackspace.shift).toBe(false)
})

test("parseKeypress - backspace key with modifiers (Kitty keyboard protocol)", () => {
  // Backspace key in Kitty protocol uses code 127
  // Ctrl+Backspace: \x1b[127;5u
  const ctrlBackspace = parseKeypress("\x1b[127;5u", { useKittyKeyboard: true })!
  expect(ctrlBackspace.name).toBe("backspace")
  expect(ctrlBackspace.ctrl).toBe(true)
  expect(ctrlBackspace.shift).toBe(false)
  expect(ctrlBackspace.meta).toBe(false)
  expect(ctrlBackspace.source).toBe("kitty")

  // Option/Meta+Backspace: \x1b[127;3u
  const metaBackspace = parseKeypress("\x1b[127;3u", { useKittyKeyboard: true })!
  expect(metaBackspace.name).toBe("backspace")
  expect(metaBackspace.meta).toBe(true)
  expect(metaBackspace.ctrl).toBe(false)
  expect(metaBackspace.shift).toBe(false)
  expect(metaBackspace.source).toBe("kitty")

  // Shift+Backspace: \x1b[127;2u
  const shiftBackspace = parseKeypress("\x1b[127;2u", { useKittyKeyboard: true })!
  expect(shiftBackspace.name).toBe("backspace")
  expect(shiftBackspace.shift).toBe(true)
  expect(shiftBackspace.ctrl).toBe(false)
  expect(shiftBackspace.meta).toBe(false)
  expect(shiftBackspace.source).toBe("kitty")
})

test("parseKeypress - Buffer input", () => {
  const buf = Buffer.from("a")
  expect(parseKeypress(buf)).toEqual({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "a",
    source: "raw",
  })
})

test("parseKeypress - high byte buffer handling", () => {
  const buf = Buffer.from([160]) // 128 + 32, should become \x1b + " "
  expect(parseKeypress(buf)).toEqual({
    eventType: "press",
    name: "space",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b ",
    raw: "\x1b ",
    source: "raw",
  })
})

test("parseKeypress - empty input", () => {
  expect(parseKeypress("")).toEqual({
    eventType: "press",
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "",
    raw: "",
    source: "raw",
  })

  expect(parseKeypress()).toEqual({
    eventType: "press",
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "",
    raw: "",
    source: "raw",
  })
})

test("parseKeypress - special characters", () => {
  expect(parseKeypress("!")).toEqual({
    eventType: "press",
    name: "!",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "!",
    raw: "!",
    source: "raw",
  })

  expect(parseKeypress("@")).toEqual({
    eventType: "press",
    name: "@",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "@",
    raw: "@",
    source: "raw",
  })
})

test("parseKeypress - meta space and escape combinations", () => {
  expect(parseKeypress("\x1b ")).toEqual({
    eventType: "press",
    name: "space",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b ",
    raw: "\x1b ",
    source: "raw",
  })

  expect(parseKeypress("\x1b\x1b")).toEqual({
    eventType: "press",
    name: "escape",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b\x1b",
    raw: "\x1b\x1b",
    source: "raw",
  })
})

test("parseKeypress - rxvt style arrow keys with modifiers", () => {
  expect(parseKeypress("\x1b[a")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "\x1b[a",
    raw: "\x1b[a",
    code: "[a",
    super: false,
    hyper: false,
    source: "raw",
  })

  expect(parseKeypress("\x1b[2$")).toEqual({
    eventType: "press",
    name: "insert",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "\x1b[2$",
    raw: "\x1b[2$",
    code: "[2$",
    super: false,
    hyper: false,
    source: "raw",
  })
})

test("parseKeypress - ctrl modifier keys", () => {
  expect(parseKeypress("\x1bOa")).toEqual({
    eventType: "press",
    name: "up",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1bOa",
    raw: "\x1bOa",
    code: "Oa",
    super: false,
    hyper: false,
    source: "raw",
  })

  expect(parseKeypress("\x1b[2^")).toEqual({
    eventType: "press",
    name: "insert",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[2^",
    raw: "\x1b[2^",
    code: "[2^",
    super: false,
    hyper: false,
    source: "raw",
  })
})

test("nonAlphanumericKeys export", () => {
  expect(Array.isArray(nonAlphanumericKeys)).toBe(true)
  expect(nonAlphanumericKeys.length).toBeGreaterThan(0)
  expect(nonAlphanumericKeys).toContain("up")
  expect(nonAlphanumericKeys).toContain("down")
  expect(nonAlphanumericKeys).toContain("f1")
  expect(nonAlphanumericKeys).toContain("backspace")
  expect(nonAlphanumericKeys).toContain("tab")
  expect(nonAlphanumericKeys).toContain("left")
  expect(nonAlphanumericKeys).toContain("right")
})

// Tests for modifier bit calculations and meta/option relationship
// Terminal modifier bits (ANSI standard): Shift=1, Alt/Option=2, Ctrl=4, Meta=8
//
// IMPORTANT REALITY CHECK:
// - Alt and Option are THE SAME PHYSICAL KEY (macOS calls it Option, others call it Alt)
// - Cmd (Mac), Win (Windows), and many Ctrl combos DON'T reach the terminal - OS intercepts them
// - The "Meta" modifier bit (8) exists in ANSI standard but is THEORETICAL
// - In practice, only Alt/Option generates modifier sequences that reach the terminal
//
// The `option` flag: true when ANSI escape sequence has explicit Alt modifier bit (bit 2)
// The `meta` flag: true when ESC prefix is detected OR ANSI Alt/Meta bits are set (legacy naming)
//
// Real terminal behavior on macOS (see key-results file):
// - Alt+letter: sends ESC+char (e.g., "\x1ba") → meta=true, option=false
// - Alt+arrow: sends ANSI sequence (e.g., "\x1b[1;3A") → meta=true, option=true
// - Cmd+anything: NO EVENT reaches terminal (OS intercepts)
// - Ctrl+arrow: NO EVENT reaches terminal on Mac (OS intercepts)
test("parseKeypress - modifier bit calculations and meta/option relationship", () => {
  // Individual modifiers to establish the baseline

  // Shift modifier is bit 0 (value 1), so modifier value 2 = 1 + 1
  const shiftOnly = parseKeypress("\x1b[1;2A")!
  expect(shiftOnly.name).toBe("up")
  expect(shiftOnly.shift).toBe(true)
  expect(shiftOnly.ctrl).toBe(false)
  expect(shiftOnly.meta).toBe(false)
  expect(shiftOnly.option).toBe(false)

  // Alt/Option modifier is bit 1 (value 2), so modifier value 3 = 2 + 1
  // IMPORTANT: Alt/Option (same key, different names) sets BOTH meta and option flags
  const altOnly = parseKeypress("\x1b[1;3A")!
  expect(altOnly.name).toBe("up")
  expect(altOnly.meta).toBe(true) // Alt/Option sets meta flag
  expect(altOnly.option).toBe(true) // Alt/Option sets option flag
  expect(altOnly.ctrl).toBe(false)
  expect(altOnly.shift).toBe(false)

  // Ctrl modifier is bit 2 (value 4), so modifier value 5 = 4 + 1
  const ctrlOnly = parseKeypress("\x1b[1;5A")!
  expect(ctrlOnly.name).toBe("up")
  expect(ctrlOnly.ctrl).toBe(true)
  expect(ctrlOnly.meta).toBe(false)
  expect(ctrlOnly.shift).toBe(false)
  expect(ctrlOnly.option).toBe(false)

  // Super modifier is bit 3 (value 8), so modifier value 9 = 8 + 1
  // Super is the Command/Windows key
  const superOnly = parseKeypress("\x1b[1;9A")!
  expect(superOnly.name).toBe("up")
  expect(superOnly.meta).toBe(false)
  expect(superOnly.option).toBe(false)
  expect(superOnly.ctrl).toBe(false)
  expect(superOnly.shift).toBe(false)
  expect(superOnly.super).toBe(true)
  expect(superOnly.hyper).toBe(false)

  // Combined modifiers to test the relationships

  // Ctrl+Super = 4 + 8 = 12, so modifier value 13 = 12 + 1
  const ctrlSuper = parseKeypress("\x1b[1;13A")!
  expect(ctrlSuper.name).toBe("up")
  expect(ctrlSuper.ctrl).toBe(true)
  expect(ctrlSuper.meta).toBe(false)
  expect(ctrlSuper.shift).toBe(false)
  expect(ctrlSuper.option).toBe(false)
  expect(ctrlSuper.super).toBe(true)
  expect(ctrlSuper.hyper).toBe(false)

  // Shift+Alt/Option = 1 + 2 = 3, so modifier value 4 = 3 + 1
  // Should have meta=true, option=true (Alt/Option key is pressed)
  const shiftAlt = parseKeypress("\x1b[1;4A")!
  expect(shiftAlt.name).toBe("up")
  expect(shiftAlt.shift).toBe(true)
  expect(shiftAlt.option).toBe(true) // Alt/Option sets option
  expect(shiftAlt.meta).toBe(true) // Alt/Option also sets meta
  expect(shiftAlt.ctrl).toBe(false)

  // Alt/Option+Meta/Cmd = 2 + 8 = 10, so modifier value 11 = 10 + 1
  // Both physical keys pressed: Alt/Option key AND Meta/Cmd key
  const altMeta = parseKeypress("\x1b[1;11A")!
  expect(altMeta.name).toBe("up")
  expect(altMeta.meta).toBe(true) // Both Alt/Option and Meta/Cmd set meta flag
  expect(altMeta.option).toBe(true) // Alt/Option sets option flag
  expect(altMeta.ctrl).toBe(false)
  expect(altMeta.shift).toBe(false)

  // Ctrl+Alt/Option = 4 + 2 = 6, so modifier value 7 = 6 + 1
  // Should have meta=true, option=true (Alt/Option key is pressed)
  const ctrlAlt = parseKeypress("\x1b[1;7A")!
  expect(ctrlAlt.name).toBe("up")
  expect(ctrlAlt.ctrl).toBe(true)
  expect(ctrlAlt.meta).toBe(true) // Alt/Option sets meta
  expect(ctrlAlt.option).toBe(true) // Alt/Option sets option
  expect(ctrlAlt.shift).toBe(false)

  // All modifiers: Shift(1) + Alt(2) + Ctrl(4) + Meta(8) = 15, so modifier value 16 = 15 + 1
  const allMods = parseKeypress("\x1b[1;16A")!
  expect(allMods.name).toBe("up")
  expect(allMods.shift).toBe(true)
  expect(allMods.option).toBe(true) // Alt is present
  expect(allMods.ctrl).toBe(true)
  expect(allMods.meta).toBe(true) // Both Alt and Meta are present
})

test("parseKeypress - distinguishing between Alt/Option and theoretical Meta modifier", () => {
  // IMPORTANT REALITY:
  // - Alt and Option are THE SAME PHYSICAL KEY (macOS calls it Option, others call it Alt)
  // - This is the ONLY modifier key that reliably reaches the terminal
  // - Cmd (Mac) and Win (Windows) keys are intercepted by the OS and DON'T reach the terminal
  // - The ANSI "Meta" modifier bit (8) is part of the standard but rarely/never seen in practice
  //
  // Real terminal behavior (see key-results file):
  // - Alt+letter: "\x1ba" → meta=true, option=false (simple ESC prefix)
  // - Alt+arrow: "\x1b[1;3A" → meta=true, option=true (ANSI with Alt bit)
  // - Cmd+anything: NO EVENT (OS intercepts)

  // Alt/Option key with arrow (ANSI sequence with modifier bit 2)
  const altArrow = parseKeypress("\x1b[1;3C")! // Real: Alt/Option+Right
  expect(altArrow.name).toBe("right")
  expect(altArrow.meta).toBe(true)
  expect(altArrow.option).toBe(true)
  expect(altArrow.ctrl).toBe(false)
  expect(altArrow.shift).toBe(false)

  // Super key: bit 8
  const superArrow = parseKeypress("\x1b[1;9C")! // Super bit only
  expect(superArrow.name).toBe("right")
  expect(superArrow.meta).toBe(false)
  expect(superArrow.option).toBe(false)
  expect(superArrow.ctrl).toBe(false)
  expect(superArrow.shift).toBe(false)
  expect(superArrow.super).toBe(true)
  expect(superArrow.hyper).toBe(false)

  // To detect if Alt/Option was pressed in ANSI sequences: check option=true
  expect(altArrow.option).toBe(true)

  // Both Alt and Super bits set
  const altSuperArrow = parseKeypress("\x1b[1;11C")! // Alt+Super bits
  expect(altSuperArrow.meta).toBe(true)
  expect(altSuperArrow.option).toBe(true)
  expect(altSuperArrow.super).toBe(true)
  expect(altSuperArrow.hyper).toBe(false)
})

test("parseKeypress - modifier combinations with function keys", () => {
  // Ctrl+F1 - may work depending on OS/terminal configuration
  const ctrlF1 = parseKeypress("\x1b[11;5~")!
  expect(ctrlF1.name).toBe("f1")
  expect(ctrlF1.ctrl).toBe(true)
  expect(ctrlF1.meta).toBe(false)
  expect(ctrlF1.option).toBe(false)
  expect(ctrlF1.eventType).toBe("press")

  // Alt/Option+F1 - real key combination that reaches terminal
  const altF1 = parseKeypress("\x1b[11;3~")!
  expect(altF1.name).toBe("f1")
  expect(altF1.meta).toBe(true)
  expect(altF1.option).toBe(true)
  expect(altF1.ctrl).toBe(false)
  expect(altF1.eventType).toBe("press")

  // Super key (bit 8)
  const superF1 = parseKeypress("\x1b[11;9~")!
  expect(superF1.name).toBe("f1")
  expect(superF1.meta).toBe(false)
  expect(superF1.option).toBe(false)
  expect(superF1.ctrl).toBe(false)
  expect(superF1.super).toBe(true)
  expect(superF1.hyper).toBe(false)
  expect(superF1.eventType).toBe("press")

  // Shift+Ctrl+F1 - may work depending on OS/terminal configuration
  const shiftCtrlF1 = parseKeypress("\x1b[11;6~")!
  expect(shiftCtrlF1.name).toBe("f1")
  expect(shiftCtrlF1.shift).toBe(true)
  expect(shiftCtrlF1.ctrl).toBe(true)
  expect(shiftCtrlF1.meta).toBe(false)
  expect(shiftCtrlF1.option).toBe(false)
  expect(shiftCtrlF1.eventType).toBe("press")
})

test("parseKeypress - regular parsing always defaults to press event type", () => {
  // Test various regular key sequences to ensure they all default to "press"
  const keys = [
    "a",
    "A",
    "1",
    "!",
    "\t",
    "\r",
    "\n",
    " ",
    "\x1b",
    "\x01", // Ctrl+A
    "\x1ba", // Alt+A
    "\x1b[A", // Up arrow
    "\x1b[11~", // F1
    "\x1b[1;2A", // Shift+Up
    "\x1b[3~", // Delete
  ]

  for (const keySeq of keys) {
    const result = parseKeypress(keySeq)!
    expect(result.eventType).toBe("press")
  }

  // Test with Buffer input too
  const bufResult = parseKeypress(Buffer.from("x"))
  expect(bufResult?.eventType).toBe("press")
})

test("KeyEventType type validation", () => {
  // Test that KeyEventType only allows valid values
  const validEventTypes: KeyEventType[] = ["press", "repeat", "release"]

  for (const eventType of validEventTypes) {
    // This should compile without errors
    const mockKey: ParsedKey = {
      name: "test",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "test",
      raw: "test",
      number: false,
      eventType: eventType,
      source: "raw",
    }
    expect(mockKey.eventType).toBe(eventType)
  }
})

test("parseKeypress - ctrl+option+letter combinations", () => {
  // This is ESC (\x1b) followed by \x15 (which is Ctrl+U)
  const ctrlOptionU = parseKeypress("\u001b\u0015")!

  // The sequence should be parsed as meta+ctrl+u
  expect(ctrlOptionU?.name).toBe("u")
  expect(ctrlOptionU?.ctrl).toBe(true)
  expect(ctrlOptionU?.meta).toBe(true) // ESC prefix indicates meta/alt/option
  expect(ctrlOptionU?.shift).toBe(false)
  expect(ctrlOptionU?.option).toBe(false) // Note: option flag is separate from meta
  expect(ctrlOptionU?.sequence).toBe("\u001b\u0015")
  expect(ctrlOptionU?.raw).toBe("\u001b\u0015")
  expect(ctrlOptionU?.eventType).toBe("press")

  // Test other meta+ctrl combinations
  const metaCtrlA = parseKeypress("\x1b\x01") // ESC + Ctrl+A
  expect(metaCtrlA?.name).toBe("a")
  expect(metaCtrlA?.ctrl).toBe(true)
  expect(metaCtrlA?.meta).toBe(true)
  expect(metaCtrlA?.shift).toBe(false)
  expect(metaCtrlA?.option).toBe(false)

  const metaCtrlZ = parseKeypress("\x1b\x1a") // ESC + Ctrl+Z
  expect(metaCtrlZ?.name).toBe("z")
  expect(metaCtrlZ?.ctrl).toBe(true)
  expect(metaCtrlZ?.meta).toBe(true)
  expect(metaCtrlZ?.shift).toBe(false)
  expect(metaCtrlZ?.option).toBe(false)

  // Test option+shift+u for comparison (this reportedly works)
  // Option+Shift+U generates ESC + U (uppercase)
  const optionShiftU = parseKeypress("\x1bU")!
  expect(optionShiftU?.name).toBe("U")
  expect(optionShiftU?.meta).toBe(true)
  expect(optionShiftU?.shift).toBe(true)
  expect(optionShiftU?.ctrl).toBe(false)
  expect(optionShiftU?.option).toBe(false)

  // Edge case: ensure we don't match beyond \x1a (26, which is Ctrl+Z)
  const invalidCtrlSeq = parseKeypress("\x1b\x1b") // ESC + ESC (not a ctrl char)
  expect(invalidCtrlSeq?.name).toBe("escape")
  expect(invalidCtrlSeq?.meta).toBe(true)
  expect(invalidCtrlSeq?.ctrl).toBe(false)

  // Edge case: test boundary at \x1a
  const metaCtrlAtBoundary = parseKeypress("\x1b\x1a") // ESC + Ctrl+Z
  expect(metaCtrlAtBoundary?.name).toBe("z")
  expect(metaCtrlAtBoundary?.ctrl).toBe(true)
  expect(metaCtrlAtBoundary?.meta).toBe(true)
})

test("parseKeypress - filters out SGR mouse events", () => {
  const mouseDown = parseKeypress("\x1b[<0;10;5M")!
  expect(mouseDown).toBeNull()

  const mouseUp = parseKeypress("\x1b[<0;10;5m")!
  expect(mouseUp).toBeNull()

  const mouseDrag = parseKeypress("\x1b[<32;15;8M")!
  expect(mouseDrag).toBeNull()

  const mouseScroll = parseKeypress("\x1b[<64;20;10M")!
  expect(mouseScroll).toBeNull()
})

test("parseKeypress - filters out incomplete/partial SGR mouse sequences", () => {
  // These are flushed by the zig parser when a new ESC arrives mid-sequence
  expect(parseKeypress("\x1b[<35;")).toBeNull()
  expect(parseKeypress("\x1b[<35;20")).toBeNull()
  expect(parseKeypress("\x1b[<35;20;")).toBeNull()
  expect(parseKeypress("\x1b[<35;20;5")).toBeNull()
  expect(parseKeypress("\x1b[<")).toBeNull()
  expect(parseKeypress("\x1b[<0")).toBeNull()
  expect(parseKeypress("\x1b[<64;20;10")).toBeNull()
})

test("parseKeypress - filters out SGR mouse continuations without ESC", () => {
  // These can occur if ESC is flushed on timeout before the rest of the sequence arrives.
  expect(parseKeypress("[<35;20;5m")).toBeNull()
  expect(parseKeypress("[<0;10;5M")).toBeNull()
  expect(parseKeypress("[<35;")).toBeNull()
  expect(parseKeypress("[<35;20")).toBeNull()
  expect(parseKeypress("[<35;20;")).toBeNull()
  expect(parseKeypress("[<")).toBeNull()
  expect(parseKeypress("[<64;20;10")).toBeNull()
})

test("parseKeypress - filters out basic mouse events", () => {
  const basicMouse = parseKeypress("\x1b[M abc")!
  expect(basicMouse).toBeNull()
})

test("parseKeypress - filters out terminal response sequences", () => {
  // Window/cell size reports - Format: ESC[4;height;width t or ESC[8;rows;cols t
  // Example: resolution query response "\u001b[4;1782;3012t"
  const windowSize1 = parseKeypress("\u001b[4;1782;3012t")
  expect(windowSize1).toBeNull()

  const windowSize2 = parseKeypress("\x1b[4;800;600t")
  expect(windowSize2).toBeNull()

  const cellSize = parseKeypress("\x1b[8;24;80t")
  expect(cellSize).toBeNull()

  // Cursor position reports - Format: ESC[row;col R
  // Response to DSR (Device Status Report) query
  const cursorPos1 = parseKeypress("\x1b[10;25R")
  expect(cursorPos1).toBeNull()

  const cursorPos2 = parseKeypress("\u001b[1;1R")
  expect(cursorPos2).toBeNull()

  // Device Attributes (DA) responses - Format: ESC[?...c
  // Response to terminal identification query
  const deviceAttrs1 = parseKeypress("\x1b[?1;2c")
  expect(deviceAttrs1).toBeNull()

  const deviceAttrs2 = parseKeypress("\x1b[?62;c")
  expect(deviceAttrs2).toBeNull()

  const deviceAttrs3 = parseKeypress("\x1b[?1;0;6;9;15c")
  expect(deviceAttrs3).toBeNull()

  // Mode reports - Format: ESC[?...;...$y
  // Response to DECRQM (Request Mode) query
  const modeReport1 = parseKeypress("\x1b[?1;2$y")
  expect(modeReport1).toBeNull()

  const modeReport2 = parseKeypress("\x1b[?25;1$y")
  expect(modeReport2).toBeNull()

  // Focus events
  const focusIn = parseKeypress("\x1b[I")
  expect(focusIn).toBeNull()

  const focusOut = parseKeypress("\x1b[O")
  expect(focusOut).toBeNull()

  // OSC (Operating System Command) responses - color/style queries
  // Format: ESC]...ESC\ or ESC]...BEL
  // Must be complete sequences with proper terminators to be filtered
  const oscResponse1 = parseKeypress("\x1b]11;rgb:0000/0000/0000\x1b\\")
  expect(oscResponse1).toBeNull()

  const oscResponse2 = parseKeypress("\x1b]10;rgb:ffff/ffff/ffff\x07")
  expect(oscResponse2).toBeNull()

  // Incomplete OSC sequences should NOT be filtered
  // The stdin parser will either complete them or timeout and flush them
  const incompleteOsc = parseKeypress("\x1b]11;rgb:0000")
  expect(incompleteOsc).not.toBeNull()
  expect(incompleteOsc?.name).toBe("") // Unknown sequence, but not filtered
})

test("parseKeypress - does not filter valid key sequences that might look similar", () => {
  // Make sure we don't accidentally filter out valid keys

  // F1-F12 should still work (e.g., [11~, [24~)
  const f1 = parseKeypress("\x1b[11~")
  expect(f1).not.toBeNull()
  expect(f1?.name).toBe("f1")

  const f12 = parseKeypress("\x1b[24~")
  expect(f12).not.toBeNull()
  expect(f12?.name).toBe("f12")

  // Arrow keys with O prefix should still work (SS3 sequences)
  const arrowUp = parseKeypress("\x1bOA")
  expect(arrowUp).not.toBeNull()
  expect(arrowUp?.name).toBe("up")

  // Other SS3 sequences
  const ss3Down = parseKeypress("\x1bOB")
  expect(ss3Down).not.toBeNull()
  expect(ss3Down?.name).toBe("down")

  // Note: ESC[O without a following character is filtered (focus out event)
  const focusOutFiltered = parseKeypress("\x1b[O")
  expect(focusOutFiltered).toBeNull()

  // Standard arrow keys should still work
  const arrowLeft = parseKeypress("\x1b[D")
  expect(arrowLeft).not.toBeNull()
  expect(arrowLeft?.name).toBe("left")

  // Modified keys should still work
  const ctrlUp = parseKeypress("\x1b[1;5A")
  expect(ctrlUp).not.toBeNull()
  expect(ctrlUp?.name).toBe("up")
  expect(ctrlUp?.ctrl).toBe(true)

  // Delete, insert, page up/down should still work
  const deleteKey = parseKeypress("\x1b[3~")
  expect(deleteKey).not.toBeNull()
  expect(deleteKey?.name).toBe("delete")

  const insertKey = parseKeypress("\x1b[2~")
  expect(insertKey).not.toBeNull()
  expect(insertKey?.name).toBe("insert")

  const pageUp = parseKeypress("\x1b[5~")
  expect(pageUp).not.toBeNull()
  expect(pageUp?.name).toBe("pageup")

  // Kitty keyboard protocol sequences should still work
  const kittyA = parseKeypress("\x1b[97u", { useKittyKeyboard: true })
  expect(kittyA).not.toBeNull()
  expect(kittyA?.name).toBe("a")
  expect(kittyA?.source).toBe("kitty")

  const kittyArrow = parseKeypress("\x1b[57352u", { useKittyKeyboard: true })
  expect(kittyArrow).not.toBeNull()
  expect(kittyArrow?.name).toBe("up")
  expect(kittyArrow?.source).toBe("kitty")

  // Bracketed paste markers should be filtered
  // They're handled by KeyHandler before parseKeypress is called,
  // but should return null for defense-in-depth
  const pasteStart = parseKeypress("\x1b[200~")
  expect(pasteStart).toBeNull()

  const pasteEnd = parseKeypress("\x1b[201~")
  expect(pasteEnd).toBeNull()

  // Control characters should still work (including BEL which is Ctrl+G)
  const bel = parseKeypress("\x07")
  expect(bel).not.toBeNull()
  expect(bel?.name).toBe("g")
  expect(bel?.ctrl).toBe(true)

  const backspace = parseKeypress("\b")
  expect(backspace).not.toBeNull()
  expect(backspace?.name).toBe("backspace")

  const backspace2 = parseKeypress("\x7f")
  expect(backspace2).not.toBeNull()
  expect(backspace2?.name).toBe("backspace")
})

test("parseKeypress - source field is always 'raw' for non-Kitty parsing", () => {
  // Test various key types to ensure they all have source: "raw"
  const letter = parseKeypress("a")
  expect(letter?.source).toBe("raw")

  const shiftLetter = parseKeypress("A")
  expect(shiftLetter?.source).toBe("raw")

  const number = parseKeypress("5")
  expect(number?.source).toBe("raw")

  const ctrlKey = parseKeypress("\x01") // Ctrl+A
  expect(ctrlKey?.source).toBe("raw")

  const metaKey = parseKeypress("\x1ba") // Alt+A
  expect(metaKey?.source).toBe("raw")

  const arrowKey = parseKeypress("\x1b[A") // Up arrow
  expect(arrowKey?.source).toBe("raw")

  const functionKey = parseKeypress("\x1bOP") // F1
  expect(functionKey?.source).toBe("raw")

  const modifiedArrow = parseKeypress("\x1b[1;5A") // Ctrl+Up
  expect(modifiedArrow?.source).toBe("raw")

  const deleteKey = parseKeypress("\x1b[3~")
  expect(deleteKey?.source).toBe("raw")

  const returnKey = parseKeypress("\r")
  expect(returnKey?.source).toBe("raw")

  const tabKey = parseKeypress("\t")
  expect(tabKey?.source).toBe("raw")

  const escapeKey = parseKeypress("\x1b")
  expect(escapeKey?.source).toBe("raw")
})

test("parseKeypress - source field is 'kitty' when Kitty keyboard protocol is used", () => {
  // Test Kitty keyboard protocol sequences
  const kittyA = parseKeypress("\x1b[97u", { useKittyKeyboard: true })
  expect(kittyA?.source).toBe("kitty")
  expect(kittyA?.name).toBe("a")

  const kittyArrow = parseKeypress("\x1b[57352u", { useKittyKeyboard: true }) // Up arrow
  expect(kittyArrow?.source).toBe("kitty")
  expect(kittyArrow?.name).toBe("up")

  const kittyF1 = parseKeypress("\x1b[57364u", { useKittyKeyboard: true }) // F1
  expect(kittyF1?.source).toBe("kitty")
  expect(kittyF1?.name).toBe("f1")

  const kittyCtrlA = parseKeypress("\x1b[97;5u", { useKittyKeyboard: true }) // Ctrl+A
  expect(kittyCtrlA?.source).toBe("kitty")
  expect(kittyCtrlA?.name).toBe("a")
  expect(kittyCtrlA?.ctrl).toBe(true)
})

test("parseKeypress - fallback to raw parsing when Kitty option is enabled but sequence is not Kitty", () => {
  // Even with useKittyKeyboard enabled, non-Kitty sequences should use raw parsing
  const normalArrow = parseKeypress("\x1b[A", { useKittyKeyboard: true })
  expect(normalArrow?.source).toBe("raw")
  expect(normalArrow?.name).toBe("up")

  const normalLetter = parseKeypress("a", { useKittyKeyboard: true })
  expect(normalLetter?.source).toBe("raw")
  expect(normalLetter?.name).toBe("a")

  const normalCtrl = parseKeypress("\x01", { useKittyKeyboard: true })
  expect(normalCtrl?.source).toBe("raw")
  expect(normalCtrl?.name).toBe("a")
  expect(normalCtrl?.ctrl).toBe(true)
})

test("parseKeypress - modifyOtherKeys digits", () => {
  const shiftOne = parseKeypress("\x1b[27;2;49~")!
  expect(shiftOne.name).toBe("1")
  expect(shiftOne.shift).toBe(true)
  expect(shiftOne.ctrl).toBe(false)
  expect(shiftOne.meta).toBe(false)
  expect(shiftOne.option).toBe(false)
  expect(shiftOne.number).toBe(true)
  expect(shiftOne.sequence).toBe("1")
  expect(shiftOne.raw).toBe("\x1b[27;2;49~")
  expect(shiftOne.eventType).toBe("press")
  expect(shiftOne.source).toBe("raw")
})

test("parseKeypress - modifyOtherKeys modified enter keys", () => {
  // Terminals with modifyOtherKeys mode enabled send special escape sequences for modified keys
  // Format: CSI 27 ; modifier ; code ~ where code 13 is enter/return
  // This is part of the CSI u protocol and is sent by xterm, iTerm2, Ghostty, etc.

  // Shift+Enter: CSI 27;2;13~ (modifier 2 = shift bit 1)
  const shiftEnter = parseKeypress("\u001b[27;2;13~")!
  expect(shiftEnter.name).toBe("return")
  expect(shiftEnter.shift).toBe(true)
  expect(shiftEnter.ctrl).toBe(false)
  expect(shiftEnter.meta).toBe(false)
  expect(shiftEnter.option).toBe(false)
  expect(shiftEnter.sequence).toBe("\u001b[27;2;13~")
  expect(shiftEnter.raw).toBe("\u001b[27;2;13~")
  expect(shiftEnter.eventType).toBe("press")
  expect(shiftEnter.source).toBe("raw")

  // Test with \x1b notation as well
  const shiftEnter2 = parseKeypress("\x1b[27;2;13~")!
  expect(shiftEnter2.name).toBe("return")
  expect(shiftEnter2.shift).toBe(true)
  expect(shiftEnter2.ctrl).toBe(false)
  expect(shiftEnter2.meta).toBe(false)
  expect(shiftEnter2.option).toBe(false)

  // Ctrl+Enter: CSI 27;5;13~ (modifier 5 = ctrl bit 4)
  const ctrlEnter = parseKeypress("\u001b[27;5;13~")!
  expect(ctrlEnter.name).toBe("return")
  expect(ctrlEnter.ctrl).toBe(true)
  expect(ctrlEnter.shift).toBe(false)
  expect(ctrlEnter.meta).toBe(false)
  expect(ctrlEnter.option).toBe(false)
  expect(ctrlEnter.sequence).toBe("\u001b[27;5;13~")
  expect(ctrlEnter.raw).toBe("\u001b[27;5;13~")
  expect(ctrlEnter.eventType).toBe("press")
  expect(ctrlEnter.source).toBe("raw")

  // Test with \x1b notation
  const ctrlEnter2 = parseKeypress("\x1b[27;5;13~")!
  expect(ctrlEnter2.name).toBe("return")
  expect(ctrlEnter2.ctrl).toBe(true)
  expect(ctrlEnter2.shift).toBe(false)
  expect(ctrlEnter2.meta).toBe(false)
  expect(ctrlEnter2.option).toBe(false)

  // Alt/Option+Enter: CSI 27;3;13~ (modifier 3 = alt/option bit 2)
  const altEnter = parseKeypress("\u001b[27;3;13~")!
  expect(altEnter.name).toBe("return")
  expect(altEnter.meta).toBe(true)
  expect(altEnter.option).toBe(true)
  expect(altEnter.ctrl).toBe(false)
  expect(altEnter.shift).toBe(false)
  expect(altEnter.sequence).toBe("\u001b[27;3;13~")
  expect(altEnter.raw).toBe("\u001b[27;3;13~")
  expect(altEnter.eventType).toBe("press")
  expect(altEnter.source).toBe("raw")

  // Shift+Ctrl+Enter: CSI 27;6;13~ (modifier 6 = shift(1) + ctrl(4) = bits 5)
  const shiftCtrlEnter = parseKeypress("\u001b[27;6;13~")!
  expect(shiftCtrlEnter.name).toBe("return")
  expect(shiftCtrlEnter.shift).toBe(true)
  expect(shiftCtrlEnter.ctrl).toBe(true)
  expect(shiftCtrlEnter.meta).toBe(false)
  expect(shiftCtrlEnter.option).toBe(false)
  expect(shiftCtrlEnter.sequence).toBe("\u001b[27;6;13~")
  expect(shiftCtrlEnter.raw).toBe("\u001b[27;6;13~")
  expect(shiftCtrlEnter.eventType).toBe("press")
  expect(shiftCtrlEnter.source).toBe("raw")

  // Shift+Alt+Enter: CSI 27;4;13~ (modifier 4 = shift(1) + alt(2) = bits 3)
  const shiftAltEnter = parseKeypress("\u001b[27;4;13~")!
  expect(shiftAltEnter.name).toBe("return")
  expect(shiftAltEnter.shift).toBe(true)
  expect(shiftAltEnter.meta).toBe(true)
  expect(shiftAltEnter.option).toBe(true)
  expect(shiftAltEnter.ctrl).toBe(false)
  expect(shiftAltEnter.sequence).toBe("\u001b[27;4;13~")
  expect(shiftAltEnter.raw).toBe("\u001b[27;4;13~")
  expect(shiftAltEnter.eventType).toBe("press")
  expect(shiftAltEnter.source).toBe("raw")

  // Ctrl+Alt+Enter: CSI 27;7;13~ (modifier 7 = alt(2) + ctrl(4) = bits 6)
  const ctrlAltEnter = parseKeypress("\u001b[27;7;13~")!
  expect(ctrlAltEnter.name).toBe("return")
  expect(ctrlAltEnter.ctrl).toBe(true)
  expect(ctrlAltEnter.meta).toBe(true)
  expect(ctrlAltEnter.option).toBe(true)
  expect(ctrlAltEnter.shift).toBe(false)
  expect(ctrlAltEnter.sequence).toBe("\u001b[27;7;13~")
  expect(ctrlAltEnter.raw).toBe("\u001b[27;7;13~")
  expect(ctrlAltEnter.eventType).toBe("press")
  expect(ctrlAltEnter.source).toBe("raw")

  // Shift+Ctrl+Alt+Enter: CSI 27;8;13~ (modifier 8 = shift(1) + alt(2) + ctrl(4) = bits 7)
  const allModsEnter = parseKeypress("\u001b[27;8;13~")!
  expect(allModsEnter.name).toBe("return")
  expect(allModsEnter.shift).toBe(true)
  expect(allModsEnter.ctrl).toBe(true)
  expect(allModsEnter.meta).toBe(true)
  expect(allModsEnter.option).toBe(true)
  expect(allModsEnter.sequence).toBe("\u001b[27;8;13~")
  expect(allModsEnter.raw).toBe("\u001b[27;8;13~")
  expect(allModsEnter.eventType).toBe("press")
  expect(allModsEnter.source).toBe("raw")
})

test("parseKeypress - modifyOtherKeys modified escape keys", () => {
  // Terminals with modifyOtherKeys mode enabled also send modified escape key sequences
  // Format: CSI 27 ; modifier ; 27 ~ where code 27 is escape

  // Ctrl+Escape: CSI 27;5;27~ (modifier 5 = ctrl bit 4)
  const ctrlEscape = parseKeypress("\u001b[27;5;27~")!
  expect(ctrlEscape.name).toBe("escape")
  expect(ctrlEscape.ctrl).toBe(true)
  expect(ctrlEscape.shift).toBe(false)
  expect(ctrlEscape.meta).toBe(false)
  expect(ctrlEscape.option).toBe(false)
  expect(ctrlEscape.sequence).toBe("\u001b[27;5;27~")
  expect(ctrlEscape.raw).toBe("\u001b[27;5;27~")
  expect(ctrlEscape.eventType).toBe("press")
  expect(ctrlEscape.source).toBe("raw")

  // Test with \x1b notation as well
  const ctrlEscape2 = parseKeypress("\x1b[27;5;27~")!
  expect(ctrlEscape2.name).toBe("escape")
  expect(ctrlEscape2.ctrl).toBe(true)
  expect(ctrlEscape2.shift).toBe(false)
  expect(ctrlEscape2.meta).toBe(false)
  expect(ctrlEscape2.option).toBe(false)

  // Shift+Escape: CSI 27;2;27~ (modifier 2 = shift bit 1)
  const shiftEscape = parseKeypress("\u001b[27;2;27~")!
  expect(shiftEscape.name).toBe("escape")
  expect(shiftEscape.shift).toBe(true)
  expect(shiftEscape.ctrl).toBe(false)
  expect(shiftEscape.meta).toBe(false)
  expect(shiftEscape.option).toBe(false)
  expect(shiftEscape.sequence).toBe("\u001b[27;2;27~")
  expect(shiftEscape.raw).toBe("\u001b[27;2;27~")
  expect(shiftEscape.eventType).toBe("press")
  expect(shiftEscape.source).toBe("raw")

  // Alt+Escape: CSI 27;3;27~ (modifier 3 = alt/option bit 2)
  const altEscape = parseKeypress("\u001b[27;3;27~")!
  expect(altEscape.name).toBe("escape")
  expect(altEscape.meta).toBe(true)
  expect(altEscape.option).toBe(true)
  expect(altEscape.ctrl).toBe(false)
  expect(altEscape.shift).toBe(false)
  expect(altEscape.sequence).toBe("\u001b[27;3;27~")
  expect(altEscape.raw).toBe("\u001b[27;3;27~")
  expect(altEscape.eventType).toBe("press")
  expect(altEscape.source).toBe("raw")

  // Shift+Ctrl+Escape: CSI 27;6;27~ (modifier 6 = shift(1) + ctrl(4) = bits 5)
  const shiftCtrlEscape = parseKeypress("\u001b[27;6;27~")!
  expect(shiftCtrlEscape.name).toBe("escape")
  expect(shiftCtrlEscape.shift).toBe(true)
  expect(shiftCtrlEscape.ctrl).toBe(true)
  expect(shiftCtrlEscape.meta).toBe(false)
  expect(shiftCtrlEscape.option).toBe(false)
  expect(shiftCtrlEscape.sequence).toBe("\u001b[27;6;27~")
  expect(shiftCtrlEscape.raw).toBe("\u001b[27;6;27~")
  expect(shiftCtrlEscape.eventType).toBe("press")
  expect(shiftCtrlEscape.source).toBe("raw")
})

test("parseKeypress - modifyOtherKeys modified tab, space, and backspace keys", () => {
  // Tab key: charcode 9
  const ctrlTab = parseKeypress("\u001b[27;5;9~")!
  expect(ctrlTab.name).toBe("tab")
  expect(ctrlTab.ctrl).toBe(true)
  expect(ctrlTab.shift).toBe(false)
  expect(ctrlTab.meta).toBe(false)
  expect(ctrlTab.option).toBe(false)

  const shiftTab = parseKeypress("\u001b[27;2;9~")!
  expect(shiftTab.name).toBe("tab")
  expect(shiftTab.shift).toBe(true)
  expect(shiftTab.ctrl).toBe(false)
  expect(shiftTab.meta).toBe(false)
  expect(shiftTab.option).toBe(false)

  // Space key: charcode 32
  const ctrlSpace = parseKeypress("\u001b[27;5;32~")!
  expect(ctrlSpace.name).toBe("space")
  expect(ctrlSpace.ctrl).toBe(true)
  expect(ctrlSpace.shift).toBe(false)
  expect(ctrlSpace.meta).toBe(false)
  expect(ctrlSpace.option).toBe(false)

  const shiftSpace = parseKeypress("\u001b[27;2;32~")!
  expect(shiftSpace.name).toBe("space")
  expect(shiftSpace.shift).toBe(true)
  expect(shiftSpace.ctrl).toBe(false)
  expect(shiftSpace.meta).toBe(false)
  expect(shiftSpace.option).toBe(false)

  const altSpace = parseKeypress("\u001b[27;3;32~")!
  expect(altSpace.name).toBe("space")
  expect(altSpace.meta).toBe(true)
  expect(altSpace.option).toBe(true)
  expect(altSpace.ctrl).toBe(false)
  expect(altSpace.shift).toBe(false)

  // Backspace key: charcode 127 (or 8)
  const ctrlBackspace = parseKeypress("\u001b[27;5;127~")!
  expect(ctrlBackspace.name).toBe("backspace")
  expect(ctrlBackspace.ctrl).toBe(true)
  expect(ctrlBackspace.shift).toBe(false)
  expect(ctrlBackspace.meta).toBe(false)
  expect(ctrlBackspace.option).toBe(false)

  const shiftBackspace = parseKeypress("\u001b[27;2;127~")!
  expect(shiftBackspace.name).toBe("backspace")
  expect(shiftBackspace.shift).toBe(true)
  expect(shiftBackspace.ctrl).toBe(false)
  expect(shiftBackspace.meta).toBe(false)
  expect(shiftBackspace.option).toBe(false)

  // Test charcode 8 variant
  const ctrlBackspace8 = parseKeypress("\u001b[27;5;8~")!
  expect(ctrlBackspace8.name).toBe("backspace")
  expect(ctrlBackspace8.ctrl).toBe(true)
})

test("parseKeypress - meta+arrow keys with uppercase F and B (old style)", () => {
  // Some terminals send ESC followed by uppercase F/B for meta+arrow keys
  // ONLY uppercase F and B map to arrow keys (not P/N which require actual shift)
  // Lowercase f/b are just regular meta+letter combinations

  // Meta+Right (uppercase F)
  const metaRight = parseKeypress("\u001BF")!
  expect(metaRight.name).toBe("right")
  expect(metaRight.meta).toBe(true)
  expect(metaRight.shift).toBe(false)
  expect(metaRight.ctrl).toBe(false)
  expect(metaRight.option).toBe(false)
  expect(metaRight.sequence).toBe("\u001BF")
  expect(metaRight.raw).toBe("\u001BF")

  // Meta+Left (uppercase B)
  const metaLeft = parseKeypress("\u001BB")!
  expect(metaLeft.name).toBe("left")
  expect(metaLeft.meta).toBe(true)
  expect(metaLeft.shift).toBe(false)
  expect(metaLeft.ctrl).toBe(false)
  expect(metaLeft.option).toBe(false)
  expect(metaLeft.sequence).toBe("\u001BB")
  expect(metaLeft.raw).toBe("\u001BB")

  // Uppercase P should be meta+shift+p (not arrow up)
  const metaShiftP = parseKeypress("\u001BP")!
  expect(metaShiftP.name).toBe("P")
  expect(metaShiftP.meta).toBe(true)
  expect(metaShiftP.shift).toBe(true)
  expect(metaShiftP.ctrl).toBe(false)
  expect(metaShiftP.option).toBe(false)

  // Uppercase N should be meta+shift+n (not arrow down)
  const metaShiftN = parseKeypress("\u001BN")!
  expect(metaShiftN.name).toBe("N")
  expect(metaShiftN.meta).toBe(true)
  expect(metaShiftN.shift).toBe(true)
  expect(metaShiftN.ctrl).toBe(false)
  expect(metaShiftN.option).toBe(false)

  // Lowercase versions should NOT map to arrow keys - they're just meta+letter
  // Meta+f (lowercase f) should be just meta+f, NOT meta+right
  const metaF = parseKeypress("\u001Bf")!
  expect(metaF.name).toBe("f")
  expect(metaF.meta).toBe(true)
  expect(metaF.shift).toBe(false)
  expect(metaF.ctrl).toBe(false)

  // Meta+b (lowercase b) should be just meta+b, NOT meta+left
  const metaB = parseKeypress("\u001Bb")!
  expect(metaB.name).toBe("b")
  expect(metaB.meta).toBe(true)
  expect(metaB.shift).toBe(false)
  expect(metaB.ctrl).toBe(false)
})

test("parseKeypress - double ESC preserves meta state when fn-key modifiers are parsed", () => {
  const metaUp = parseKeypress("\x1b\x1b[A")!
  expect(metaUp.name).toBe("up")
  expect(metaUp.meta).toBe(true)
  expect(metaUp.option).toBe(true)
  expect(metaUp.ctrl).toBe(false)
  expect(metaUp.shift).toBe(false)

  const metaCtrlUp = parseKeypress("\x1b\x1b[1;5A")!
  expect(metaCtrlUp.name).toBe("up")
  expect(metaCtrlUp.meta).toBe(true)
  expect(metaCtrlUp.option).toBe(true)
  expect(metaCtrlUp.ctrl).toBe(true)
  expect(metaCtrlUp.shift).toBe(false)
})

test("parseKeypress - preserves printable Unicode characters including non-BMP", () => {
  for (const char of ["é", "中", "👍"]) {
    const key = parseKeypress(char)!
    expect(key.name).toBe(char)
    expect(key.raw).toBe(char)
    expect(key.sequence).toBe(char)
    expect(key.meta).toBe(false)
    expect(key.ctrl).toBe(false)
    expect(key.shift).toBe(false)
  }
})

test("parseKeypress - SS3 application keypad digits (ESC O p..y)", () => {
  const cases: Array<[string, string]> = [
    ["\x1bOp", "0"],
    ["\x1bOq", "1"],
    ["\x1bOr", "2"],
    ["\x1bOs", "3"],
    ["\x1bOt", "4"],
    ["\x1bOu", "5"],
    ["\x1bOv", "6"],
    ["\x1bOw", "7"],
    ["\x1bOx", "8"],
    ["\x1bOy", "9"],
  ]

  for (const [seq, digit] of cases) {
    const key = parseKeypress(seq)
    expect(key).not.toBeNull()
    expect(key!.name).toBe(digit)
    // sequence must be the printable digit, not the raw ESC sequence,
    // so that text-insertion components can insert it without filtering it
    expect(key!.sequence).toBe(digit)
    expect(key!.number).toBe(true)
    expect(key!.ctrl).toBe(false)
    expect(key!.meta).toBe(false)
    expect(key!.shift).toBe(false)
    expect(key!.source).toBe("raw")
  }
})

test("parseKeypress - SS3 application keypad operators (ESC O j/k/l/m/n/o/X)", () => {
  const cases: Array<[string, string]> = [
    ["\x1bOj", "*"],
    ["\x1bOk", "+"],
    ["\x1bOl", ","],
    ["\x1bOm", "-"],
    ["\x1bOn", "."],
    ["\x1bOo", "/"],
    ["\x1bOX", "="],
  ]

  for (const [seq, char] of cases) {
    const key = parseKeypress(seq)
    expect(key).not.toBeNull()
    expect(key!.name).toBe(char)
    expect(key!.sequence).toBe(char)
    expect(key!.number).toBe(false)
    expect(key!.ctrl).toBe(false)
    expect(key!.meta).toBe(false)
    expect(key!.shift).toBe(false)
    expect(key!.source).toBe("raw")
  }
})

test("parseKeypress - SS3 application keypad Enter (ESC O M)", () => {
  const key = parseKeypress("\x1bOM")
  expect(key).not.toBeNull()
  expect(key!.name).toBe("return")
  expect(key!.ctrl).toBe(false)
  expect(key!.meta).toBe(false)
  expect(key!.shift).toBe(false)
  expect(key!.source).toBe("raw")
})
