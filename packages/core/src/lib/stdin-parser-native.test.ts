import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { ManualClock } from "../testing/manual-clock.js"
import { resolveRenderLib } from "../zig.js"
import { kittyKeyMap } from "./parse.keypress-kitty.js"
import { NativeStdinParser, type NativeStdinParserOptions, type StdinEvent } from "./stdin-parser-native.js"

function events(parser: NativeStdinParser): StdinEvent[] {
  const out: StdinEvent[] = []
  parser.drain((event) => out.push(event))
  return out
}

// A null chunk is a pause: the clock passes the Escape timeout. Events drain after every step, as
// the renderer drains them from its timeout callback.
function parse(chunks: Chunk[], options: NativeStdinParserOptions = {}) {
  const clock = new ManualClock()
  const parser = new NativeStdinParser({ armTimeouts: true, clock, ...options })
  const out: StdinEvent[] = []
  try {
    for (const chunk of [...chunks, null]) {
      if (chunk === null) clock.advance(20)
      else parser.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
      parser.drain((event) => out.push(event))
    }
    return out
  } finally {
    parser.destroy()
  }
}

type Chunk = string | Uint8Array | null
const bytes = (text: string) => Buffer.from(text, "latin1")

function summary(event: StdinEvent | undefined): unknown {
  if (!event) return undefined
  switch (event.type) {
    case "key":
      return { key: event.key.name, raw: event.raw, ctrl: event.key.ctrl, meta: event.key.meta, shift: event.key.shift }
    case "mouse":
      return { mouse: event.event.type, button: event.event.button, x: event.event.x, y: event.event.y }
    case "paste":
      return { paste: Buffer.from(event.bytes).toString() }
    case "response":
      return { response: event.protocol, sequence: event.sequence }
  }
}

const key = (name: string, raw = name, mods = "") => ({
  key: name,
  raw,
  ctrl: mods.includes("ctrl"),
  meta: mods.includes("meta"),
  shift: mods.includes("shift"),
})
const typed = (text: string) => [...text].map((char) => key(char))
const reply = (sequence: string, protocol = "csi") => ({ response: protocol, sequence })
const mouse = (type: string, x: number, y: number, button = 0) => ({ mouse: type, button, x, y })
// OpenCode's renderer while a startup query batch waits for its DA1 reply (native parser only).
const SENTINEL = { protocolContext: { privateCapabilityRepliesActive: true, replySentinelActive: true } }

// Where the parser departs from the TypeScript parser it replaced. Rows from the replay corpus name the issue they pin.
const ROWS: Array<[label: string, chunks: Chunk[], expected: unknown[], options?: NativeStdinParserOptions]> = [
  [
    "ESC inside OSC ends the string instead of waiting for the timeout",
    ["\x1b]11;rgb:0/0/0\x1b[A"],
    [reply("\x1b]11;rgb:0/0/0", "unknown"), key("up", "\x1b[A")],
  ],
  ["SGR motion with a held button is a drag without a seen press", ["\x1b[<32;2;2M"], [mouse("drag", 1, 1)]],
  ["unknown sequences are replies, not keys with an empty name", ["\x1b[h"], [reply("\x1b[h")]],
  ["Alt applies to every printable byte (issue 046)", ["\x1b."], [key(".", "\x1b.", "meta")]],
  ["Alt applies to UTF-8 characters (issue 047)", ["\x1bé"], [key("é", "\x1bé", "meta")]],
  ["an SGR wheel release is not a button release (issue 048)", ["\x1b[<64;5;5m"], [reply("\x1b[<64;5;5m")]],
  [
    "an X10 coordinate past the end is cell 223, not negative (issue 049)",
    [Uint8Array.from([0x1b, 0x5b, 0x4d, 32, 0, 40])],
    [mouse("down", 223, 7)],
  ],
  [
    "Escape then a mouse report in one read keeps both (issue 044)",
    ["\x1b\x1b[<35;10;5M"],
    [key("escape", "\x1b"), mouse("move", 9, 4)],
  ],
  ["zero bytes only resolve timeouts", [new Uint8Array(0)], []],
  [
    "X10 releases report the button pressed last",
    ['\x1b[M"!!\x1b[M#!!'],
    [mouse("down", 0, 0, 2), mouse("up", 0, 0, 2)],
  ],
  [
    "extra mouse buttons report 8 and up instead of a left click",
    ["\x1b[<128;1;1M\x1b[<129;1;1m"],
    [mouse("down", 0, 0, 8), mouse("up", 0, 0, 9)],
  ],
  ["Kitty CSI u decodes without the Kitty context", ["\x1b[97;5u"], [key("a", "\x1b[97;5u", "ctrl")]],
  [
    "a reply that a pause splits stays one reply while a DA1 sentinel is out (issue 342)",
    ["\x1b]11;rgb:0", null, "/0/0\x1b\\\x1bP>|kit", null, "ty\x1b\\\x1b_Gi=1;OK\x1b", null, "\\"],
    [reply("\x1b]11;rgb:0/0/0\x1b\\", "osc"), reply("\x1bP>|kitty\x1b\\", "dcs"), reply("\x1b_Gi=1;OK\x1b\\", "apc")],
    SENTINEL,
  ],
  [
    "a UTF-8 character that a pause splits stays one character (issue 344)",
    [bytes("\xe2\x9c"), null, bytes("\x93")],
    [key("✓")],
  ],
  ["a lone UTF-8 lead byte waits without a deadline (issue 344)", [bytes("\xe1")], []],
  [
    "a second byte that UTF-8 rules out ends the character as eight-bit Alt keys (issue 344)",
    [bytes("\xed\xa0\x80")],
    [key("m", "\x1bm", "meta"), key("space", "\x1b ", "meta"), key("space", "\x1b\x00", "ctrl meta")],
  ],
  [
    "a mouse report that a pause cuts after ESC [ stays a mouse report (issue 348)",
    ["\x1b[", null, "<0;1;1M"],
    [mouse("down", 0, 0)],
  ],
  [
    "SS3 with a modifier, Kitty code 8, F13, rxvt Ctrl+Shift, Alt+Tab",
    ["\x1bO2P\x1b[8;5u\x1b[25~\x1b[2@\x1b\t"],
    [
      key("f1", "\x1bO2P", "shift"),
      key("backspace", "\x1b[8;5u", "ctrl"),
      key("f13", "\x1b[25~"),
      key("insert", "\x1b[2@", "ctrl shift"),
      key("tab", "\x1b\t", "meta"),
    ],
  ],
  ["eight-bit Alt+Shift+B is not Alt+Left", [bytes("\xc2x")], [key("B", "\x1bB", "meta shift"), key("x")]],
  [
    "SGR button 3 is not a press, and coordinate 0 is cell 0",
    ["\x1b[<3;10;5M\x1b[<0;0;0M"],
    [reply("\x1b[<3;10;5M"), mouse("down", 0, 0)],
  ],
  ["a typed byte order mark is a character (issue 368)", [bytes("\xef\xbb\xbf")], [key("﻿")]],
  [
    "URxvt motion after a wheel tick drags the held button, not the wheel's (issue 426)",
    ["\x1b[<0;1;1M\x1b[<65;1;1M\x1b[<97;2;1M\x1b[<99;3;1M"],
    [mouse("down", 0, 0), mouse("scroll", 0, 0, 1), mouse("drag", 1, 0), mouse("drag", 2, 0)],
  ],
  [
    "X10 motion with a held button is a drag, after a wheel tick too (issue 426)",
    [bytes('\x1b[M !!\x1b[M@"!\x1b[M`"!\x1b[M\x80#!')],
    [mouse("down", 0, 0), mouse("drag", 1, 0), mouse("scroll", 1, 0), mouse("drag", 2, 0)],
  ],
]

describe("native stdin parser: rows", () => {
  for (const [label, chunks, expected, options] of ROWS) {
    test(label, () => {
      expect(parse(chunks, options).map(summary)).toEqual(expected)
    })
  }
})

describe("native stdin parser: replay", () => {
  // Representative input streams: typing, editing keys, startup capability replies,
  // mouse selection, scrolling, focus, and pastes. The snapshots are the events that the
  // TypeScript parser this one replaced reported for them.
  const streams: Array<[label: string, bytes: string]> = [
    ["typing", "Hello, wörld! 日本語 👍\ue000\ue001\ue003\ue06e\r\x7f\x7f\t"],
    ["editing keys", "\x1b[A\x1b[B\x1b[1;5C\x1b[1;2D\x1b[H\x1b[F\x1b[3~\x1b[5~\x1b[6;5~\x1bOP\x1b[15~\x1b[Z"],
    ["control and Alt keys", "\x01\x03\x1a\x1ba\x1bA\x1b\x01\x1b\r\x1b \x1bB\x1bF\x1b[27;5;57344~"],
    [
      "startup replies",
      "\x1b[?62;22;52c\x1b[?2026;2$y\x1b[?1u\x1bP>|kitty(0.40.1)\x1b\\\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\\x1b_Gi=31337;OK\x1b\\\x1b[4;800;1200t",
    ],
    ["selection drag", "\x1b[<0;10;5M\x1b[<32;11;5M\x1b[<32;14;6M\x1b[<0;14;6m\x1b[<35;20;7M"],
    ["URxvt drag across a wheel tick", "\x1b[<0;1;1M\x1b[<32;3;1M\x1b[<64;3;1M\x1b[<96;6;1M\x1b[<0;6;1m\x1b[<96;8;1M"],
    ["scrolling", "\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<66;10;5M\x1b[<67;10;5M"],
    ["X10 mouse", "\x1b[M !!\x1b[M#!!\x1b[M`$%"],
    ["focus", "\x1b[O\x1b[I"],
    ["pastes", "\x1b[200~line 1\nline 2\x1b[A\x1b[201~x\x1b[200~\x1b[201~"],
    ["Kitty keys", "\x1b[97u\x1b[97;5u\x1b[97;1:3u\x1b[13;2u\x1b[57364u\x1b[1;1:1A\x1b[5;1:3~\x1b[57399u\x1b[65279u"],
    ["modifyOtherKeys", "\x1b[27;2;13~\x1b[27;5;27~\x1b[27;5;32~\x1b[27;2;53~\x1b[27;2;65~\x1b[27;5;65~\x1b[27;3;65~"],
  ]

  for (const [label, text] of streams) {
    test(label, () => {
      // Uneven reads, as a terminal delivers them.
      const bytes = Buffer.from(text)
      const chunks: Uint8Array[] = []
      for (let offset = 0, size = 1; offset < bytes.length; offset += size, size = (size % 7) + 1) {
        chunks.push(bytes.subarray(offset, offset + size))
      }
      const options = { protocolContext: { kittyKeyboardEnabled: true } }
      // One ASCII line per event: the Node test shim compares snapshots as text, and Bun escapes some characters.
      const lines = parse(chunks, options).map((event) => JSON.stringify(summary(event)))
      const ascii = lines
        .join("\n")
        .replace(/[^\n\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
      expect(ascii).toMatchSnapshot()
    })
  }

  test("the parser reports the same events however the reads between pauses are split", () => {
    // Seeded streams of the rows' and streams' inputs, with up to two pauses. A read after a
    // pause that ends in `[` keeps its first 4 bytes: a timed-out `ESC [` continues only when the
    // next read holds the rest of a mouse report (issue 348).
    const fragments = [...ROWS.flatMap(([, chunks]) => chunks), ...streams.map(([, text]) => text)]
      .filter((chunk): chunk is string | Uint8Array => chunk !== null && chunk.length > 0)
      .map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk))
    const contexts = [{ protocolContext: { kittyKeyboardEnabled: true } }, {}, SENTINEL]
    let seed = 0x5eed
    let delivered = 0
    const random = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) % n
    for (let run = 0; run < 1000; run++) {
      const input = Buffer.concat(Array.from({ length: 1 + random(5) }, () => fragments[random(fragments.length)]!))
      const pauses = new Set(Array.from({ length: random(3) }, () => 1 + random(input.length)))
      const options = contexts[random(contexts.length)]!
      const whole: Chunk[] = []
      const split: Chunk[] = []
      for (let start = 0; start < input.length; ) {
        let end = start + 1
        while (end < input.length && !pauses.has(end)) end++
        whole.push(input.subarray(start, end))
        for (let at = start; at < end; ) {
          const size = at === start && pauses.has(start) && input[start - 1] === 0x5b ? 4 : 1 + random(6)
          split.push(input.subarray(at, Math.min(end, at + size)))
          at += size
        }
        if (pauses.has(end)) for (const chunks of [whole, split]) chunks.push(null)
        start = end
      }
      const label = `run ${run} ${JSON.stringify(input.toString("latin1"))}`
      const expected = parse(whole, options)
      delivered += expected.length
      expect(`${label} ${JSON.stringify(parse(split, options))}`).toBe(`${label} ${JSON.stringify(expected)}`)
    }
    expect(delivered).toBeGreaterThan(5_000)
  })
})

describe("native stdin parser: adapter", () => {
  test("names every Kitty functional key like Core", () => {
    const codes = [27, 13, 9, 127, ...Array.from({ length: 57454 - 57348 + 1 }, (_, index) => 57348 + index)]
    const parser = new NativeStdinParser({ armTimeouts: false, clock: new ManualClock() })
    try {
      for (const code of codes) parser.push(Buffer.from(`\x1b[${code}u`))
      const names = events(parser).map((event) => (event.type === "key" ? event.key.name : event.type))
      expect(names).toEqual(codes.map((code) => kittyKeyMap[code]))
      expect(codes).toHaveLength(111)
    } finally {
      parser.destroy()
    }
  })

  test("reports Core's key fields", () => {
    const [enter, linefeed, altA, kittyA, keypad, repeat, base, f5, altUp, altMok, altO, altBracket] = parse([
      Buffer.from(
        "\r\n\x1bA\x1b[97;2u\x1bOp\x1b[97;1:2u\x1b[1089::99;5u\x1b[15;5~\x1b\x1b[A\x1b\x1b[27;5;65~\xcf\xdbx",
        "latin1",
      ),
    ]).map((event) => (event.type === "key" ? event.key : null))
    expect(enter).toMatchObject({ name: "return", sequence: "\r", source: "raw" })
    expect(linefeed).toMatchObject({ name: "linefeed", sequence: "\n" })
    expect(altA).toMatchObject({ name: "A", meta: true, shift: true, option: false, sequence: "\x1bA" })
    expect(kittyA).toMatchObject({ name: "a", shift: true, sequence: "A", source: "kitty" })
    expect(parse(["\x1b"])[0]).toMatchObject({ key: { name: "", meta: true, sequence: "\x1b" } })
    expect(keypad).toMatchObject({ name: "0", sequence: "0", number: true, code: "Op" })
    expect(repeat).toMatchObject({ name: "a", eventType: "press", repeated: true })
    expect(base).toMatchObject({ name: "с", ctrl: true, baseCode: 99 })
    expect(f5).toMatchObject({ name: "f5", ctrl: true, code: "[15~", option: false })
    expect(altUp).toMatchObject({ name: "up", meta: true, option: true, raw: "\x1b\x1b[A" })
    expect(altMok).toMatchObject({ name: "A", ctrl: true, meta: true, shift: false, option: true })
    expect(altO).toMatchObject({ name: "O", meta: true, shift: true, option: false, raw: "\x1bO" })
    expect(altBracket).toMatchObject({ name: "[", meta: true, shift: false, option: false, raw: "\x1b[" })
    const [bom, ...kittyBom] = parse([bytes("\xef\xbb\xbf\x1b[65279u\x1b[65279;1;65279u")])
    expect(bom).toMatchObject({ raw: "\ufeff", key: { name: "\ufeff", sequence: "\ufeff", raw: "\ufeff" } })
    expect(kittyBom[0]).toMatchObject({ key: { name: "\ufeff", sequence: "\ufeff", raw: "\x1b[65279u" } })
    expect(kittyBom[1]).toMatchObject({ key: { name: "﻿", sequence: "﻿", raw: "\x1b[65279;1;65279u" } })
    expect(kittyBom).toHaveLength(2)
    // A reportText commit arrives whole (issue 467): 10 scalars, and 42 in the 256 bytes a sequence may hold
    // before its final byte.
    for (const text of ["本日は晴天なりですね", "漢".repeat(42)]) {
      const commit = `\x1b[0;;${[...text].map((char) => char.codePointAt(0)).join(":")}u`
      const got = parse([commit])
      expect(got).toHaveLength(1)
      expect(got[0]).toMatchObject({ key: { name: text, sequence: text } })
    }
  })

  test("suspension stops input time so a reply split across it still completes", () => {
    const clock = new ManualClock()
    const parser = new NativeStdinParser({ clock, protocolContext: { pixelResolutionQueryActive: true } })
    try {
      parser.push(Buffer.from("\x1b"))
      parser.suspend()
      clock.advance(1000)
      expect(events(parser)).toEqual([])
      parser.push(Buffer.from("[4;80;80t"))
      parser.resume()
      expect(events(parser).map(summary)).toEqual([{ response: "csi", sequence: "\x1b[4;80;80t" }])
      // After the resume drain, an awaited reply's prefix keeps waiting; other units are stale.
      parser.push(Buffer.from("\x1b[4;80"))
      parser.suspend()
      parser.resume()
      clock.advance(1000)
      parser.push(Buffer.from(";80t\x1b[200~half"))
      parser.suspend()
      parser.resume()
      parser.push(Buffer.from("x"))
      expect(events(parser).map(summary)).toEqual([
        { response: "csi", sequence: "\x1b[4;80;80t" },
        { key: "x", raw: "x", ctrl: false, meta: false, shift: false },
      ])
    } finally {
      parser.destroy()
    }
  })

  test("holds input time when the clock steps back", () => {
    const clock = new ManualClock()
    const parser = new NativeStdinParser({ clock })
    try {
      clock.setTime(100)
      parser.push(Buffer.from("\x1b"))
      clock.setTime(5)
      parser.push(Buffer.from("x"))
      expect(events(parser).map(summary)).toEqual([{ key: "x", raw: "\x1bx", ctrl: false, meta: true, shift: false }])
    } finally {
      parser.destroy()
    }
  })

  test("parses through a borrowed Session and stops quietly when it closes", () => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 4, renderCellsMax: 1 })
    try {
      const session = lib.createSession(context, { chunkSize: 4096, spanCapacity: 2, maxBytes: 8192n })
      const clock = new ManualClock()
      const parser = new NativeStdinParser({ clock, session: { lib, context, session } })
      parser.push(Buffer.from("a\x1b"))
      expect(events(parser).map(summary)).toEqual([{ key: "a", raw: "a", ctrl: false, meta: false, shift: false }])
      lib.sessionClose(context, session)
      clock.advance(20)
      parser.push(Buffer.from("b"))
      parser.updateProtocolContext({ privateCapabilityRepliesActive: true })
      parser.reset()
      expect(events(parser)).toEqual([])
      expect(clock.pendingTimerCount).toBe(0)
      parser.destroy()
      expect(() => parser.push(Buffer.from("c"))).toThrow("destroyed")
    } finally {
      lib.getYogaHost().runMutation(() => lib.destroyContext(context))
    }
  })
})
