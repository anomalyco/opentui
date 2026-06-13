import { describe, expect, test } from "bun:test"
import { parseKeypress, type ParseKeypressOptions, type ParsedKey } from "./parse.keypress.js"

// This mirrors the upstream protocol tables and expands them into one test
// per case so missing mappings fail with a name.
//
// https://raw.githubusercontent.com/kovidgoyal/kitty/refs/heads/master/docs/keyboard-protocol.rst

const options: ParseKeypressOptions = { useKittyKeyboard: true }

type ExpectedKey = Partial<ParsedKey> & Pick<ParsedKey, "name">

interface KeyCase {
  title: string
  sequence: string
  expected: ExpectedKey
}

function parse(sequence: string): ParsedKey {
  const result = parseKeypress(sequence, options)
  expect(result).not.toBeNull()
  return result!
}

function expectKey(sequence: string, expected: ExpectedKey): void {
  expect(parse(sequence)).toMatchObject(expected)
}

function defineKeyCases(cases: readonly KeyCase[]): void {
  for (const { title, sequence, expected } of cases) {
    test(title, () => {
      expectKey(sequence, expected)
    })
  }
}

function rangeCases(start: number, names: readonly string[]): Array<[number, string]> {
  return names.map((name, index) => [start + index, name] as [number, string])
}

function functionalCase(code: number, name: string): KeyCase {
  return {
    title: `CSI ${code}u -> ${name}`,
    sequence: `\x1b[${code}u`,
    expected: {
      name,
      code: `[${code}u`,
      eventType: "press",
      source: "kitty",
    },
  }
}

function legacyAliasCase(sequence: string, name: string): KeyCase {
  return {
    title: `legacy ${JSON.stringify(sequence)} -> ${name}`,
    sequence,
    expected: {
      name,
      eventType: "press",
    },
  }
}

function enhancedAliasCase(sequence: string, name: string): KeyCase {
  return {
    title: `enhanced ${JSON.stringify(sequence)} -> ${name}`,
    sequence,
    expected: {
      name,
      eventType: "press",
      source: "kitty",
    },
  }
}

function canonicalAliasCase(sequence: string, expected: ExpectedKey): KeyCase {
  return {
    title: `canonical ${JSON.stringify(sequence)} -> ${expected.name}`,
    sequence,
    expected: {
      eventType: "press",
      ...expected,
    },
  }
}

function modifierCase(modifier: number, expected: ExpectedKey): KeyCase {
  return {
    title: `modifier ${modifier} -> ${expected.name}`,
    sequence: `\x1b[97;${modifier}u`,
    expected: {
      source: "kitty",
      ...expected,
    },
  }
}

const numberedFunctionalEntries: Array<[number, string]> = [
  [27, "escape"],
  [13, "return"],
  [9, "tab"],
  [127, "backspace"],
  ...rangeCases(57348, [
    "insert",
    "delete",
    "left",
    "right",
    "up",
    "down",
    "pageup",
    "pagedown",
    "home",
    "end",
    "capslock",
    "scrolllock",
    "numlock",
    "printscreen",
    "pause",
    "menu",
  ]),
  ...Array.from({ length: 35 }, (_, index) => [57364 + index, `f${index + 1}`] as [number, string]),
  ...rangeCases(57399, [
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
    "clear",
  ]),
  ...rangeCases(57428, [
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
  ]),
  ...rangeCases(57438, ["volumedown", "volumeup", "mute"]),
  ...rangeCases(57441, [
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
  ]),
  ...rangeCases(57453, ["iso_level3_shift", "iso_level5_shift"]),
]

const numberedFunctionalCases: KeyCase[] = numberedFunctionalEntries.map(([code, name]) => functionalCase(code, name))

const legacyAliasCases = [
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[C", "right"],
  ["\x1b[D", "left"],
  ["\x1b[E", "clear"],
  ["\x1b[F", "end"],
  ["\x1b[H", "home"],
  ["\x1bOP", "f1"],
  ["\x1bOQ", "f2"],
  ["\x1bOR", "f3"],
  ["\x1bOS", "f4"],
  ["\x1b[2~", "insert"],
  ["\x1b[3~", "delete"],
  ["\x1b[5~", "pageup"],
  ["\x1b[6~", "pagedown"],
  ["\x1b[7~", "home"],
  ["\x1b[8~", "end"],
  ["\x1b[11~", "f1"],
  ["\x1b[12~", "f2"],
  ["\x1b[13~", "f3"],
  ["\x1b[14~", "f4"],
  ["\x1b[15~", "f5"],
  ["\x1b[17~", "f6"],
  ["\x1b[18~", "f7"],
  ["\x1b[19~", "f8"],
  ["\x1b[20~", "f9"],
  ["\x1b[21~", "f10"],
  ["\x1b[23~", "f11"],
  ["\x1b[24~", "f12"],
  ["\x1b[29~", "menu"],
  ["\x1b[57427~", "clear"],
] as const satisfies ReadonlyArray<readonly [string, string]>

const enhancedLetterAliasCases = [
  ["\x1b[1;1:1A", "up"],
  ["\x1b[1;1:1B", "down"],
  ["\x1b[1;1:1C", "right"],
  ["\x1b[1;1:1D", "left"],
  ["\x1b[1;1:1E", "clear"],
  ["\x1b[1;1:1F", "end"],
  ["\x1b[1;1:1H", "home"],
  ["\x1b[1;1:1P", "f1"],
  ["\x1b[1;1:1Q", "f2"],
  ["\x1b[1;1:1S", "f4"],
] as const satisfies ReadonlyArray<readonly [string, string]>

const canonicalLetterAliasCases: KeyCase[] = [
  canonicalAliasCase("\x1b[P", { name: "f1" }),
  canonicalAliasCase("\x1b[Q", { name: "f2" }),
  canonicalAliasCase("\x1b[S", { name: "f4" }),
  canonicalAliasCase("\x1b[1;2P", { name: "f1", shift: true }),
  canonicalAliasCase("\x1b[1;5Q", { name: "f2", ctrl: true }),
  canonicalAliasCase("\x1b[1;3S", { name: "f4", meta: true, option: true }),
]

const enhancedTildeAliasCases = [
  ["\x1b[2;1:1~", "insert"],
  ["\x1b[3;1:1~", "delete"],
  ["\x1b[5;1:1~", "pageup"],
  ["\x1b[6;1:1~", "pagedown"],
  ["\x1b[7;1:1~", "home"],
  ["\x1b[8;1:1~", "end"],
  ["\x1b[11;1:1~", "f1"],
  ["\x1b[12;1:1~", "f2"],
  ["\x1b[13;1:1~", "f3"],
  ["\x1b[14;1:1~", "f4"],
  ["\x1b[15;1:1~", "f5"],
  ["\x1b[17;1:1~", "f6"],
  ["\x1b[18;1:1~", "f7"],
  ["\x1b[19;1:1~", "f8"],
  ["\x1b[20;1:1~", "f9"],
  ["\x1b[21;1:1~", "f10"],
  ["\x1b[23;1:1~", "f11"],
  ["\x1b[24;1:1~", "f12"],
  ["\x1b[29;1:1~", "menu"],
  ["\x1b[57427;1:1~", "clear"],
] as const satisfies ReadonlyArray<readonly [string, string]>

const modifierCases: KeyCase[] = [
  modifierCase(2, { name: "a", shift: true }),
  modifierCase(3, { name: "a", meta: true, option: true }),
  modifierCase(5, { name: "a", ctrl: true }),
  modifierCase(9, { name: "a", super: true }),
  modifierCase(17, { name: "a", hyper: true }),
  modifierCase(33, { name: "a", meta: true, option: false }),
  modifierCase(65, { name: "a", capsLock: true }),
  modifierCase(129, { name: "a", numLock: true }),
  modifierCase(256, {
    name: "a",
    shift: true,
    ctrl: true,
    meta: true,
    option: true,
    super: true,
    hyper: true,
    capsLock: true,
    numLock: true,
  }),
]

const eventAndPayloadCases = [
  ["\x1b[32u", { name: "space", sequence: " " }],
  ["\x1b[32;2u", { name: "space", sequence: " ", shift: true }],
  ["\x1b[32;5u", { name: "space", sequence: " ", ctrl: true }],
  ["\x1b[32:32:32;5u", { name: "space", sequence: " ", ctrl: true, baseCode: 32 }],
  ["\x1b[97;1:1u", { name: "a", eventType: "press" }],
  ["\x1b[97;1:2u", { name: "a", eventType: "press", repeated: true }],
  ["\x1b[97;1:3u", { name: "a", eventType: "release" }],
  ["\x1b[97:65u", { name: "a", sequence: "a" }],
  ["\x1b[97:65;2u", { name: "a", sequence: "A", shift: true }],
  ["\x1b[97::113u", { name: "a", sequence: "a", baseCode: 113 }],
  ["\x1b[97;1;65u", { name: "a", sequence: "A" }],
  ["\x1b[57400u", { name: "kp1", sequence: "1" }],
  ["\x1b[57413u", { name: "kpplus", sequence: "+" }],
  ["\x1b[57400;1;120u", { name: "kp1", sequence: "x" }],
  ["\x1b[0;;229u", { name: "å", sequence: "å" }],
  ["\x1b[0;;104:105u", { name: "hi", sequence: "hi" }],
] as const satisfies ReadonlyArray<readonly [string, ExpectedKey]>

describe("Kitty protocol: functional key definitions", () => {
  defineKeyCases(numberedFunctionalCases)
})

describe("Kitty protocol: legacy aliases", () => {
  defineKeyCases(legacyAliasCases.map(([sequence, name]) => legacyAliasCase(sequence, name)))
})

describe("Kitty protocol: enhanced letter aliases", () => {
  defineKeyCases(enhancedLetterAliasCases.map(([sequence, name]) => enhancedAliasCase(sequence, name)))

  test("CSI 1;1:1R is not an enhanced F3 alias in the current spec", () => {
    expect(parseKeypress("\x1b[1;1:1R", options)?.name).not.toBe("f3")
  })
})

describe("Kitty protocol: canonical CSI letter forms", () => {
  defineKeyCases(canonicalLetterAliasCases)

  test("CSI R is not a canonical F3 alias in the current spec", () => {
    expect(parseKeypress("\x1b[R", options)?.name).not.toBe("f3")
    expect(parseKeypress("\x1b[1;2R", options)?.name).not.toBe("f3")
  })
})

describe("Kitty protocol: enhanced tilde aliases", () => {
  defineKeyCases(enhancedTildeAliasCases.map(([sequence, name]) => enhancedAliasCase(sequence, name)))
})

describe("Kitty protocol: modifier bitfield", () => {
  defineKeyCases(modifierCases)
})

describe("Kitty protocol: event, alternate-key, and text fields", () => {
  defineKeyCases(
    eventAndPayloadCases.map(([sequence, expected]) => ({
      title: `payload ${JSON.stringify(sequence)}`,
      sequence,
      expected: { source: "kitty", ...expected },
    })),
  )
})
