import { test, expect } from "bun:test"
import { parseKeypress, type ParseKeypressOptions } from "./parse.keypress.js"

test("parseKeypress - Kitty keyboard protocol disabled by default", () => {
  // Kitty sequences should fall back to regular parsing when disabled
  const result = parseKeypress("\x1b[97u")!
  expect(result.name).toBe("")
  expect(result.code).toBeUndefined()
})

test("parseKeypress - Kitty keyboard basic key", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97u", options)!
  expect(result.name).toBe("a")
  expect(result.sequence).toBe("a")
  expect(result.ctrl).toBe(false)
  expect(result.meta).toBe(false)
  expect(result.shift).toBe(false)
  expect(result.option).toBe(false)
})

test("parseKeypress - Kitty keyboard shift+a", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97:65;2u", options)!
  expect(result.name).toBe("a")
  expect(result.sequence).toBe("A")
  expect(result.shift).toBe(true)
  expect(result.ctrl).toBe(false)
  expect(result.meta).toBe(false)
})

test("parseKeypress - Kitty keyboard ctrl+a", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97;5u", options)!
  expect(result.name).toBe("a")
  expect(result.ctrl).toBe(true)
  expect(result.shift).toBe(false)
  expect(result.meta).toBe(false)
})

test("parseKeypress - Kitty keyboard alt+a", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97;3u", options)!
  expect(result.name).toBe("a")
  expect(result.meta).toBe(true)
  expect(result.option).toBe(true)
  expect(result.ctrl).toBe(false)
  expect(result.shift).toBe(false)
})

test("parseKeypress - Kitty keyboard function key", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[57364u", options)!
  expect(result.name).toBe("f1")
  expect(result.code).toBe("[57364u")
})

test("parseKeypress - Kitty keyboard arrow key", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[57352u", options)!
  expect(result.name).toBe("up")
  expect(result.code).toBe("[57352u")
})

test("parseKeypress - Kitty keyboard shift+space", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[32;2u", options)!
  expect(result.name).toBe("space")
  expect(result.sequence).toBe(" ")
  expect(result.shift).toBe(true)
})

test("parseKeypress - Kitty keyboard ctrl+space", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[32;5u", options)!
  expect(result.name).toBe("space")
  expect(result.sequence).toBe(" ")
  expect(result.ctrl).toBe(true)
})

test("parseKeypress - Kitty keyboard event types", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  // Press event (explicit)
  const pressExplicit = parseKeypress("\x1b[97;1:1u", options)!
  expect(pressExplicit.name).toBe("a")
  expect(pressExplicit.eventType).toBe("press")

  // Press event (default when no event type specified)
  const pressDefault = parseKeypress("\x1b[97u", options)!
  expect(pressDefault.name).toBe("a")
  expect(pressDefault.eventType).toBe("press")

  // Press event (modifier without event type)
  const pressWithModifier = parseKeypress("\x1b[97;5u", options)! // Ctrl+a
  expect(pressWithModifier.name).toBe("a")
  expect(pressWithModifier.ctrl).toBe(true)
  expect(pressWithModifier.eventType).toBe("press")

  // Repeat event (emitted as press with repeated=true)
  const repeat = parseKeypress("\x1b[97;1:2u", options)!
  expect(repeat.name).toBe("a")
  expect(repeat.eventType).toBe("press")
  expect(repeat.repeated).toBe(true)

  // Release event
  const release = parseKeypress("\x1b[97;1:3u", options)!
  expect(release.name).toBe("a")
  expect(release.eventType).toBe("release")

  // Repeat event with modifier (emitted as press with repeated=true)
  const repeatWithCtrl = parseKeypress("\x1b[97;5:2u", options)!
  expect(repeatWithCtrl.name).toBe("a")
  expect(repeatWithCtrl.ctrl).toBe(true)
  expect(repeatWithCtrl.eventType).toBe("press")
  expect(repeatWithCtrl.repeated).toBe(true)

  // Release event with modifier
  const releaseWithShift = parseKeypress("\x1b[97;2:3u", options)!
  expect(releaseWithShift.name).toBe("a")
  expect(releaseWithShift.shift).toBe(true)
  expect(releaseWithShift.eventType).toBe("release")
})

test("parseKeypress - Kitty keyboard with text", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97;1;97u", options)!
  expect(result.name).toBe("a")
})

test("parseKeypress - Kitty keyboard ctrl+shift+a", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97;6u", options)!
  expect(result.name).toBe("a")
  expect(result.ctrl).toBe(true)
  expect(result.shift).toBe(true)
  expect(result.meta).toBe(false)
})

test("parseKeypress - Kitty keyboard alt+shift+a", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97;4u", options)!
  expect(result.name).toBe("a")
  expect(result.meta).toBe(true)
  expect(result.option).toBe(true)
  expect(result.shift).toBe(true)
  expect(result.ctrl).toBe(false)
})

test("parseKeypress - Kitty keyboard super+a", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97;9u", options)! // modifier 9 - 1 = 8 = super
  expect(result.name).toBe("a")
  expect(result.super).toBe(true)
})

test("parseKeypress - Kitty keyboard hyper+a", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97;17u", options)! // modifier 17 - 1 = 16 = hyper
  expect(result.name).toBe("a")
  expect(result.hyper).toBe(true)
})

test("parseKeypress - Kitty keyboard with shifted codepoint", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97:65u", options)!
  expect(result.name).toBe("a")
  expect(result.sequence).toBe("a") // No shift pressed, so base character
  expect(result.shift).toBe(false)
})

test("parseKeypress - Kitty keyboard with base layout codepoint", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97:65:97u", options)!
  expect(result.name).toBe("a")
  expect(result.sequence).toBe("a") // No shift modifier, so base character
  expect(result.shift).toBe(false)
  expect(result.baseCode).toBe(97) // Base layout codepoint is 'a'
})

test("parseKeypress - Kitty keyboard different layout (QWERTY A key on AZERTY)", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  // On AZERTY, Q key produces 'a', but base layout says it's Q position
  const result = parseKeypress("\x1b[97:65:113u", options)! // 113 = 'q'
  expect(result.name).toBe("a") // Actual character produced
  expect(result.sequence).toBe("a")
  expect(result.baseCode).toBe(113) // Physical key position is Q
})

test("parseKeypress - Kitty keyboard caps lock", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97;65u", options)! // modifier 65 - 1 = 64 = caps lock
  expect(result.name).toBe("a")
  expect(result.capsLock).toBe(true)
})

test("parseKeypress - Kitty keyboard lock keys", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  const cases = [
    ["\x1b[57358u", "capslock", "[57358u"],
    ["\x1b[57359u", "scrolllock", "[57359u"],
    ["\x1b[57360u", "numlock", "[57360u"],
  ] as const

  for (const [sequence, name, code] of cases) {
    const result = parseKeypress(sequence, options)!
    expect(result.name).toBe(name)
    expect(result.code).toBe(code)
    expect(result.source).toBe("kitty")
  }
})

test("parseKeypress - Kitty keyboard num lock", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[97;129u", options)! // modifier 129 - 1 = 128 = num lock
  expect(result.name).toBe("a")
  expect(result.numLock).toBe(true)
})

test("parseKeypress - Kitty keyboard unicode character", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[233u", options)! // é
  expect(result.name).toBe("é")
  expect(result.sequence).toBe("é")
})

test("parseKeypress - Kitty keyboard emoji", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[128512u", options)! // 😀
  expect(result.name).toBe("😀")
  expect(result.sequence).toBe("😀")
})

test("parseKeypress - Kitty keyboard invalid codepoint", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const result = parseKeypress("\x1b[1114112u", options)! // Invalid codepoint > 0x10FFFF
  // Should fall back to regular parsing when Kitty fails
  expect(result.name).toBe("")
  expect(result.ctrl).toBe(true)
  expect(result.meta).toBe(true)
  expect(result.shift).toBe(true)
  expect(result.option).toBe(true)
})

test("parseKeypress - Kitty keyboard keypad keys", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  const printableKeys = [
    ["\x1b[57399u", "kp0", "0"],
    ["\x1b[57400u", "kp1", "1"],
    ["\x1b[57401u", "kp2", "2"],
    ["\x1b[57402u", "kp3", "3"],
    ["\x1b[57403u", "kp4", "4"],
    ["\x1b[57404u", "kp5", "5"],
    ["\x1b[57405u", "kp6", "6"],
    ["\x1b[57406u", "kp7", "7"],
    ["\x1b[57407u", "kp8", "8"],
    ["\x1b[57408u", "kp9", "9"],
    ["\x1b[57409u", "kpdecimal", "."],
    ["\x1b[57410u", "kpdivide", "/"],
    ["\x1b[57411u", "kpmultiply", "*"],
    ["\x1b[57412u", "kpminus", "-"],
    ["\x1b[57413u", "kpplus", "+"],
    ["\x1b[57415u", "kpequal", "="],
    ["\x1b[57416u", "kpseparator", ","],
  ] as const

  for (const [sequence, name, text] of printableKeys) {
    const result = parseKeypress(sequence, options)
    expect(result?.name).toBe(name)
    expect(result?.sequence).toBe(text)
  }

  const kpEnter = parseKeypress("\x1b[57414u", options)
  expect(kpEnter?.name).toBe("kpenter")
  expect(kpEnter?.sequence).toBe("\x1b[57414u")
})

test("parseKeypress - Kitty keyboard keypad text preserves names and explicit text", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  const ctrlKp1 = parseKeypress("\x1b[57400;5u", options)!
  expect(ctrlKp1.name).toBe("kp1")
  expect(ctrlKp1.ctrl).toBe(true)
  expect(ctrlKp1.sequence).toBe("1")

  const explicitText = parseKeypress("\x1b[57400;1;120u", options)!
  expect(explicitText.name).toBe("kp1")
  expect(explicitText.sequence).toBe("x")

  const keypadNavigation = parseKeypress("\x1b[57417u", options)!
  expect(keypadNavigation.name).toBe("kpleft")
  expect(keypadNavigation.sequence).toBe("\x1b[57417u")
})

test("parseKeypress - Kitty keyboard media keys", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  const play = parseKeypress("\x1b[57428u", options)
  expect(play?.name).toBe("mediaplay")

  const volumeUp = parseKeypress("\x1b[57439u", options)
  expect(volumeUp?.name).toBe("volumeup")
})

test("parseKeypress - Kitty keyboard modifier keys", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  const leftShift = parseKeypress("\x1b[57441u", options)
  expect(leftShift?.name).toBe("leftshift")
  expect(leftShift?.eventType).toBe("press")

  const rightCtrl = parseKeypress("\x1b[57448u", options)
  expect(rightCtrl?.name).toBe("rightctrl")
  expect(rightCtrl?.eventType).toBe("press")
})

test("parseKeypress - Kitty keyboard function keys with event types", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  // F1 press
  const f1Press = parseKeypress("\x1b[57364u", options)!
  expect(f1Press.name).toBe("f1")
  expect(f1Press.eventType).toBe("press")

  // F1 repeat (emitted as press with repeated=true)
  const f1Repeat = parseKeypress("\x1b[57364;1:2u", options)!
  expect(f1Repeat.name).toBe("f1")
  expect(f1Repeat.eventType).toBe("press")
  expect(f1Repeat.repeated).toBe(true)

  // F1 release
  const f1Release = parseKeypress("\x1b[57364;1:3u", options)!
  expect(f1Release.name).toBe("f1")
  expect(f1Release.eventType).toBe("release")
})

test("parseKeypress - Kitty keyboard arrow keys with event types", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  // Up arrow press
  const upPress = parseKeypress("\x1b[57352u", options)!
  expect(upPress.name).toBe("up")
  expect(upPress.eventType).toBe("press")

  // Up arrow repeat with Ctrl (emitted as press with repeated=true)
  const upRepeatCtrl = parseKeypress("\x1b[57352;5:2u", options)!
  expect(upRepeatCtrl.name).toBe("up")
  expect(upRepeatCtrl.ctrl).toBe(true)
  expect(upRepeatCtrl.eventType).toBe("press")
  expect(upRepeatCtrl.repeated).toBe(true)

  // Down arrow release
  const downRelease = parseKeypress("\x1b[57353;1:3u", options)!
  expect(downRelease.name).toBe("down")
  expect(downRelease.eventType).toBe("release")
})

test("parseKeypress - Kitty functional keys with event types", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  // Legacy format: CSI 1;modifiers:event_type LETTER
  // Up arrow press
  const upPress = parseKeypress("\x1b[1;1:1A", options)!
  expect(upPress.name).toBe("up")
  expect(upPress.eventType).toBe("press")
  expect(upPress.source).toBe("kitty")

  // Up arrow release
  const upRelease = parseKeypress("\x1b[1;1:3A", options)!
  expect(upRelease.name).toBe("up")
  expect(upRelease.eventType).toBe("release")
  expect(upRelease.source).toBe("kitty")

  // Down arrow with repeat (emitted as press with repeated=true)
  const downRepeat = parseKeypress("\x1b[1;1:2B", options)!
  expect(downRepeat.name).toBe("down")
  expect(downRepeat.eventType).toBe("press")
  expect(downRepeat.repeated).toBe(true)

  // Left arrow press
  const leftPress = parseKeypress("\x1b[1;1:1D", options)!
  expect(leftPress.name).toBe("left")
  expect(leftPress.eventType).toBe("press")

  // Right arrow release
  const rightRelease = parseKeypress("\x1b[1;1:3C", options)!
  expect(rightRelease.name).toBe("right")
  expect(rightRelease.eventType).toBe("release")

  // Shift+up press
  const shiftUpPress = parseKeypress("\x1b[1;2:1A", options)!
  expect(shiftUpPress.name).toBe("up")
  expect(shiftUpPress.shift).toBe(true)
  expect(shiftUpPress.eventType).toBe("press")

  // Ctrl+down release
  const ctrlDownRelease = parseKeypress("\x1b[1;5:3B", options)!
  expect(ctrlDownRelease.name).toBe("down")
  expect(ctrlDownRelease.ctrl).toBe(true)
  expect(ctrlDownRelease.eventType).toBe("release")
})

test("parseKeypress - Kitty tilde keys with event types", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  // Page Up press
  const pageUpPress = parseKeypress("\x1b[5;1:1~", options)!
  expect(pageUpPress.name).toBe("pageup")
  expect(pageUpPress.eventType).toBe("press")
  expect(pageUpPress.source).toBe("kitty")

  // Page Up repeat
  const pageUpRepeat = parseKeypress("\x1b[5;1:2~", options)!
  expect(pageUpRepeat.name).toBe("pageup")
  expect(pageUpRepeat.eventType).toBe("press")
  expect(pageUpRepeat.repeated).toBe(true)

  // Page Up release
  const pageUpRelease = parseKeypress("\x1b[5;1:3~", options)!
  expect(pageUpRelease.name).toBe("pageup")
  expect(pageUpRelease.eventType).toBe("release")

  // Page Down
  const pageDownRepeat = parseKeypress("\x1b[6;1:2~", options)!
  expect(pageDownRepeat.name).toBe("pagedown")
  expect(pageDownRepeat.repeated).toBe(true)

  // Insert with shift
  const shiftInsert = parseKeypress("\x1b[2;2:1~", options)!
  expect(shiftInsert.name).toBe("insert")
  expect(shiftInsert.shift).toBe(true)
  expect(shiftInsert.eventType).toBe("press")

  // Delete with ctrl
  const ctrlDelete = parseKeypress("\x1b[3;5:1~", options)!
  expect(ctrlDelete.name).toBe("delete")
  expect(ctrlDelete.ctrl).toBe(true)

  // Home/End
  const homePress = parseKeypress("\x1b[1;1:1~", options)!
  expect(homePress.name).toBe("home")

  const endRelease = parseKeypress("\x1b[4;1:3~", options)!
  expect(endRelease.name).toBe("end")
  expect(endRelease.eventType).toBe("release")

  // F5-F12
  const f5Press = parseKeypress("\x1b[15;1:1~", options)!
  expect(f5Press.name).toBe("f5")

  const f12Repeat = parseKeypress("\x1b[24;1:2~", options)!
  expect(f12Repeat.name).toBe("f12")
  expect(f12Repeat.repeated).toBe(true)
})

test("parseKeypress - Kitty keyboard invalid event types", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  // Unknown event type should default to press
  const unknownEvent = parseKeypress("\x1b[97;1:9u", options)!
  expect(unknownEvent.name).toBe("a")
  expect(unknownEvent.eventType).toBe("press")

  // Empty event type should default to press
  const emptyEvent = parseKeypress("\x1b[97;1:u", options)!
  expect(emptyEvent.name).toBe("a")
  expect(emptyEvent.eventType).toBe("press")
})

test("parseKeypress - Kitty repeat/release matrix", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }
  const cases = [
    ["\x1b[97;1:2u", "a", "press", true, false, false, false],
    ["\x1b[97;5:3u", "a", "release", false, true, false, false],
    ["\x1b[1;2:2A", "up", "press", true, false, true, false],
    ["\x1b[1;5:3B", "down", "release", false, true, false, false],
    ["\x1b[5;1:2~", "pageup", "press", true, false, false, false],
    ["\x1b[3;5:3~", "delete", "release", false, true, false, false],
  ] as const

  for (const [sequence, name, eventType, repeated, ctrl, shift, meta] of cases) {
    const result = parseKeypress(sequence, options)!
    expect(result.name).toBe(name)
    expect(result.eventType).toBe(eventType)
    expect(result.repeated === true).toBe(repeated)
    expect(result.ctrl).toBe(ctrl)
    expect(result.shift).toBe(shift)
    expect(result.meta).toBe(meta)
    expect(result.source).toBe("kitty")
  }
})

// Test progressive enhancement (non-CSI u sequences)
// Note: We don't implement this yet, but these should fall back to regular parsing
test("parseKeypress - Kitty progressive enhancement fallback", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  // These would normally be handled by progressive enhancement
  // but since we don't implement it, they should fall back
  const result = parseKeypress("\x1b[1;2A", options)! // CSI 1;2A (shift+up with modifiers)
  expect(result.name).toBe("up")
  expect(result.shift).toBe(true)
})

test("parseKeypress - Kitty sequences are NOT filtered by terminal response filters", () => {
  // This test ensures that ALL Kitty keyboard protocol sequences bypass
  // the terminal response filters and reach the Kitty parser correctly.
  // Kitty sequences all end with 'u' while filtered sequences end with other characters.
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  // Basic letters (all should have source: "kitty")
  const letters = ["a", "z", "A", "Z", "0", "9"]
  for (const letter of letters) {
    const code = letter.charCodeAt(0)
    const result = parseKeypress(`\x1b[${code}u`, options)
    expect(result).not.toBeNull()
    expect(result?.source).toBe("kitty")
  }

  // All standard keys
  const standardKeys = [
    [27, "escape"],
    [9, "tab"],
    [13, "return"],
    [127, "backspace"],
  ] as const
  for (const [code, expectedName] of standardKeys) {
    const result = parseKeypress(`\x1b[${code}u`, options)
    expect(result).not.toBeNull()
    expect(result?.source).toBe("kitty")
    expect(result?.name).toBe(expectedName)
  }

  // All arrow keys
  const arrowKeys = [
    [57350, "left"],
    [57351, "right"],
    [57352, "up"],
    [57353, "down"],
  ] as const
  for (const [code, expectedName] of arrowKeys) {
    const result = parseKeypress(`\x1b[${code}u`, options)
    expect(result).not.toBeNull()
    expect(result?.source).toBe("kitty")
    expect(result?.name).toBe(expectedName)
  }

  // All navigation keys
  const navKeys = [
    [57348, "insert"],
    [57349, "delete"],
    [57354, "pageup"],
    [57355, "pagedown"],
    [57356, "home"],
    [57357, "end"],
  ] as const
  for (const [code, expectedName] of navKeys) {
    const result = parseKeypress(`\x1b[${code}u`, options)
    expect(result).not.toBeNull()
    expect(result?.source).toBe("kitty")
    expect(result?.name).toBe(expectedName)
  }

  // All function keys (F1-F35)
  for (let i = 1; i <= 35; i++) {
    const code = 57363 + i
    const result = parseKeypress(`\x1b[${code}u`, options)
    expect(result).not.toBeNull()
    expect(result?.source).toBe("kitty")
    expect(result?.name).toBe(`f${i}`)
  }

  // All keypad keys
  const keypadKeys = [
    [57399, "kp0"],
    [57400, "kp1"],
    [57408, "kp9"],
    [57409, "kpdecimal"],
    [57410, "kpdivide"],
    [57411, "kpmultiply"],
    [57412, "kpminus"],
    [57413, "kpplus"],
    [57414, "kpenter"],
    [57415, "kpequal"],
  ] as const
  for (const [code, expectedName] of keypadKeys) {
    const result = parseKeypress(`\x1b[${code}u`, options)
    expect(result).not.toBeNull()
    expect(result?.source).toBe("kitty")
    expect(result?.name).toBe(expectedName)
  }

  // All media keys
  const mediaKeys = [
    [57428, "mediaplay"],
    [57429, "mediapause"],
    [57430, "mediaplaypause"],
    [57431, "mediareverse"],
    [57432, "mediastop"],
    [57433, "mediafastforward"],
    [57434, "mediarewind"],
    [57435, "medianext"],
    [57436, "mediaprev"],
    [57437, "mediarecord"],
  ] as const
  for (const [code, expectedName] of mediaKeys) {
    const result = parseKeypress(`\x1b[${code}u`, options)
    expect(result).not.toBeNull()
    expect(result?.source).toBe("kitty")
    expect(result?.name).toBe(expectedName)
  }

  // Volume keys
  const volumeKeys = [
    [57438, "volumedown"],
    [57439, "volumeup"],
    [57440, "mute"],
  ] as const
  for (const [code, expectedName] of volumeKeys) {
    const result = parseKeypress(`\x1b[${code}u`, options)
    expect(result).not.toBeNull()
    expect(result?.source).toBe("kitty")
    expect(result?.name).toBe(expectedName)
  }

  // All modifier keys
  const modifierKeys = [
    [57441, "leftshift"],
    [57442, "leftctrl"],
    [57443, "leftalt"],
    [57444, "leftsuper"],
    [57445, "lefthyper"],
    [57446, "leftmeta"],
    [57447, "rightshift"],
    [57448, "rightctrl"],
    [57449, "rightalt"],
    [57450, "rightsuper"],
    [57451, "righthyper"],
    [57452, "rightmeta"],
  ] as const
  for (const [code, expectedName] of modifierKeys) {
    const result = parseKeypress(`\x1b[${code}u`, options)
    expect(result).not.toBeNull()
    expect(result?.source).toBe("kitty")
    expect(result?.name).toBe(expectedName)
  }

  // Special ISO keys
  const isoKeys = [
    [57453, "iso_level3_shift"],
    [57454, "iso_level5_shift"],
  ] as const
  for (const [code, expectedName] of isoKeys) {
    const result = parseKeypress(`\x1b[${code}u`, options)
    expect(result).not.toBeNull()
    expect(result?.source).toBe("kitty")
    expect(result?.name).toBe(expectedName)
  }

  // Keys with modifiers
  const withModifiers = parseKeypress("\x1b[97;5u", options) // Ctrl+a
  expect(withModifiers).not.toBeNull()
  expect(withModifiers?.source).toBe("kitty")
  expect(withModifiers?.ctrl).toBe(true)

  // Keys with event types
  const withEventType = parseKeypress("\x1b[97;1:3u", options) // a release
  expect(withEventType).not.toBeNull()
  expect(withEventType?.source).toBe("kitty")
  expect(withEventType?.eventType).toBe("release")

  // Keys with all fields (unicode:shifted:base; modifiers:event; text)
  // repeat events are emitted as press with repeated=true
  const complex = parseKeypress("\x1b[97:65:113;5:2;97u", options)
  expect(complex).not.toBeNull()
  expect(complex?.source).toBe("kitty")
  expect(complex?.ctrl).toBe(true)
  expect(complex?.eventType).toBe("press")
  expect(complex?.repeated).toBe(true)

  // Unicode characters
  const unicode = parseKeypress("\x1b[233u", options) // é
  expect(unicode).not.toBeNull()
  expect(unicode?.source).toBe("kitty")
  expect(unicode?.name).toBe("é")

  // Emoji
  const emoji = parseKeypress("\x1b[128512u", options) // 😀
  expect(emoji).not.toBeNull()
  expect(emoji?.source).toBe("kitty")
  expect(emoji?.name).toBe("😀")
})

test("parseKeypress - Kitty keyboard shift+letter without shifted codepoint", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  const result = parseKeypress("\x1b[97;2u", options)!
  expect(result.name).toBe("a")
  expect(result.shift).toBe(true)
  expect(result.sequence).toBe("A")
})

test("parseKeypress - Kitty keyboard shift+Cyrillic without shifted codepoint", () => {
  const options: ParseKeypressOptions = { useKittyKeyboard: true }

  const result = parseKeypress("\x1b[1072;2u", options)!
  expect(result.name).toBe("а")
  expect(result.shift).toBe(true)
  expect(result.sequence).toBe("А")
})
