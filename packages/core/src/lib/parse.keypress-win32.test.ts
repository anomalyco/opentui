import { test, expect } from "bun:test"
import { parseKeypress } from "./parse.keypress.js"

// The sequences below are either captured from Windows Terminal 1.24
// (12741.0) running in win32-input-mode, or taken from the Windows Terminal
// specification #4999 that defines the encoding.
//
//   https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md

test("parseKeypress - win32-input-mode plain key", () => {
  // Captured: the "1" key.
  const result = parseKeypress("\x1b[49;1;49;1;96;1_")!
  expect(result.name).toBe("1")
  expect(result.sequence).toBe("1")
  expect(result.number).toBe(true)
  expect(result.ctrl).toBe(false)
  expect(result.meta).toBe(false)
  expect(result.shift).toBe(false)
  expect(result.eventType).toBe("press")
  expect(result.source).toBe("win32")
})

test("parseKeypress - win32-input-mode ctrl+letter", () => {
  // Captured: Ctrl+B. The produced character is the control character 0x02.
  const result = parseKeypress("\x1b[66;0;2;1;104;1_")!
  expect(result.name).toBe("b")
  expect(result.ctrl).toBe(true)
  expect(result.meta).toBe(false)
  expect(result.shift).toBe(false)
  expect(result.eventType).toBe("press")
  expect(result.source).toBe("win32")
})

test("parseKeypress - win32-input-mode alt+letter", () => {
  // Captured: Alt+D. The produced character is the plain letter.
  const result = parseKeypress("\x1b[68;32;100;1;98;1_")!
  expect(result.name).toBe("d")
  expect(result.ctrl).toBe(false)
  expect(result.meta).toBe(true)
  expect(result.option).toBe(true)
  expect(result.shift).toBe(false)
  expect(result.eventType).toBe("press")
})

test("parseKeypress - win32-input-mode ctrl+shift+tab", () => {
  // Spec #4999 shape, with the control state Windows Terminal sends:
  // 0x78 = left ctrl | shift | numlock | capslock.
  const result = parseKeypress("\x1b[9;15;0;1;120;1_")!
  expect(result.name).toBe("tab")
  expect(result.ctrl).toBe(true)
  expect(result.shift).toBe(true)
  expect(result.meta).toBe(false)
  expect(result.eventType).toBe("press")
  expect(result.source).toBe("win32")
})

test("parseKeypress - win32-input-mode ctrl+tab keeps the modifier apart from tab", () => {
  // The whole point of the encoding: a plain Tab and a Ctrl+Tab are
  // distinguishable, which the legacy encoding cannot express.
  const plain = parseKeypress("\x1b[9;1;9;1;96;1_")!
  const ctrl = parseKeypress("\x1b[9;15;0;1;104;1_")!

  expect(plain.name).toBe("tab")
  expect(plain.ctrl).toBe(false)
  expect(ctrl.name).toBe("tab")
  expect(ctrl.ctrl).toBe(true)
})

test("parseKeypress - win32-input-mode key release", () => {
  // Captured: the release of Ctrl+J.
  const result = parseKeypress("\x1b[74;36;10;0;104;1_")!
  expect(result.name).toBe("j")
  expect(result.ctrl).toBe(true)
  expect(result.eventType).toBe("release")
})

test("parseKeypress - win32-input-mode modifier key on its own", () => {
  // Captured: the Ctrl key going down. A lone modifier stays observable.
  const down = parseKeypress("\x1b[17;1;0;1;104;1_")!
  expect(down.name).toBe("ctrl")
  expect(down.ctrl).toBe(true)
  expect(down.eventType).toBe("press")

  const up = parseKeypress("\x1b[17;29;0;0;96;1_")!
  expect(up.name).toBe("ctrl")
  expect(up.ctrl).toBe(false)
  expect(up.eventType).toBe("release")
})

test("parseKeypress - win32-input-mode shift key on its own", () => {
  const result = parseKeypress("\x1b[16;1;0;1;112;1_")!
  expect(result.name).toBe("shift")
  expect(result.shift).toBe(true)
  expect(result.eventType).toBe("press")
})

test("parseKeypress - win32-input-mode reports the lock keys", () => {
  const result = parseKeypress("\x1b[49;1;49;1;96;1_")!
  expect(result.capsLock).toBe(true)
  expect(result.numLock).toBe(true)
})

test("parseKeypress - win32-input-mode ctrl+alt+a from the specification", () => {
  // Spec #4999: `^[[65;30;0;1;10;1_` with key state 0x0a = left ctrl | left alt.
  const result = parseKeypress("\x1b[65;30;0;1;10;1_")!
  expect(result.name).toBe("a")
  expect(result.ctrl).toBe(true)
  expect(result.meta).toBe(true)
  expect(result.option).toBe(true)
  expect(result.shift).toBe(false)
})

test("parseKeypress - win32-input-mode ctrl+f1 from the specification", () => {
  // Spec #4999: `^[[112;59;0;1;8;1_` with key state 0x08 = left ctrl.
  const result = parseKeypress("\x1b[112;59;0;1;8;1_")!
  expect(result.name).toBe("f1")
  expect(result.ctrl).toBe(true)
  expect(result.shift).toBe(false)
})

test("parseKeypress - win32-input-mode shift+a from the specification", () => {
  // Spec #4999: the press carries the shifted character and the shift bit,
  // the release carries the base character and no shift bit.
  const press = parseKeypress("\x1b[65;30;65;1;16;1_")!
  expect(press.name).toBe("a")
  expect(press.sequence).toBe("A")
  expect(press.shift).toBe(true)

  const release = parseKeypress("\x1b[65;30;97;0;0;1_")!
  expect(release.name).toBe("a")
  expect(release.sequence).toBe("a")
  expect(release.shift).toBe(false)
  expect(release.eventType).toBe("release")
})

test("parseKeypress - win32-input-mode omits trailing default parameters", () => {
  // Spec #4999: `^[[65;30;97;1_` is the shortened form of a plain "a" press.
  const result = parseKeypress("\x1b[65;30;97;1_")!
  expect(result.name).toBe("a")
  expect(result.sequence).toBe("a")
  expect(result.ctrl).toBe(false)
  expect(result.shift).toBe(false)
  expect(result.eventType).toBe("press")
})

test("parseKeypress - win32-input-mode repeat count marks a repeated key", () => {
  const result = parseKeypress("\x1b[65;30;97;1;0;3_")!
  expect(result.name).toBe("a")
  expect(result.repeated).toBe(true)
  expect(result.eventType).toBe("press")
})

test("parseKeypress - win32-input-mode degenerate event", () => {
  // The specification calls `CSI _` a legal degenerate event.
  const result = parseKeypress("\x1b[_")
  expect(result).not.toBeNull()
  expect(result!.name).toBe("")
  expect(result!.eventType).toBe("release")
})

test("parseKeypress - win32-input-mode leaves other sequences alone", () => {
  expect(parseKeypress("\x1b[A")!.name).toBe("up")
  expect(parseKeypress("\t")!.name).toBe("tab")
  expect(parseKeypress("a")!.name).toBe("a")
  expect(parseKeypress("\x1b[9;5u", { useKittyKeyboard: true })!.source).toBe("kitty")
})
