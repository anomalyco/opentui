import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { ManualClock } from "../testing/manual-clock.js"
import { resolveRenderLib } from "../zig.js"
import { kittyKeyMap } from "./parse.keypress-kitty.js"
import { StdinParser, type StdinEvent, type StdinParserOptions } from "./stdin-parser.js"
import { NativeStdinParser, StdinShadowComparator } from "./stdin-parser-native.js"

type Parser = StdinParser | NativeStdinParser

function events(parser: Parser): StdinEvent[] {
  const out: StdinEvent[] = []
  parser.drain((event) => out.push(event))
  return out
}

function parse(create: (options: StdinParserOptions) => Parser, chunks: (string | Uint8Array)[], options = {}) {
  const clock = new ManualClock()
  const parser = create({ armTimeouts: true, clock, timeoutMs: 20, ...options })
  try {
    for (const chunk of chunks) parser.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    clock.advance(20)
    return events(parser)
  } finally {
    parser.destroy()
  }
}

const legacy = (options: StdinParserOptions) => new StdinParser(options)
const native = (options: StdinParserOptions) => new NativeStdinParser(options)

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

describe("native stdin parser: intentional changes (docs §14.3)", () => {
  const cases: Array<
    [label: string, chunks: (string | Uint8Array)[], legacy: unknown[], native: unknown[], options?: StdinParserOptions]
  > = [
    [
      "ESC inside OSC ends the string instead of waiting for the timeout",
      ["\x1b]11;rgb:0/0/0\x1b[A"],
      [{ response: "unknown", sequence: "\x1b]11;rgb:0/0/0\x1b[A" }],
      [
        { response: "unknown", sequence: "\x1b]11;rgb:0/0/0" },
        { key: "up", raw: "\x1b[A", ctrl: false, meta: false, shift: false },
      ],
    ],
    [
      "SGR motion with a held button is a drag without a seen press",
      ["\x1b[<32;2;2M"],
      [{ mouse: "move", button: 0, x: 1, y: 1 }],
      [{ mouse: "drag", button: 0, x: 1, y: 1 }],
    ],
    [
      "unknown sequences are replies, not keys with an empty name",
      ["\x1b[h"],
      [{ key: "", raw: "\x1b[h", ctrl: false, meta: false, shift: false }],
      [{ response: "csi", sequence: "\x1b[h" }],
    ],
    [
      "Alt applies to every printable byte (issue 046)",
      ["\x1b."],
      [{ key: "", raw: "\x1b.", ctrl: false, meta: false, shift: false }],
      [{ key: ".", raw: "\x1b.", ctrl: false, meta: true, shift: false }],
    ],
    [
      "Alt applies to UTF-8 characters (issue 047)",
      ["\x1bé"],
      [
        { key: "", raw: "\x1b\ufffd", ctrl: false, meta: false, shift: false },
        { key: "", raw: "\x1b)", ctrl: false, meta: false, shift: false },
      ],
      [{ key: "é", raw: "\x1bé", ctrl: false, meta: true, shift: false }],
    ],
    [
      "an SGR wheel release is not a button release (issue 048)",
      ["\x1b[<64;5;5m"],
      [{ mouse: "up", button: 0, x: 4, y: 4 }],
      [{ response: "csi", sequence: "\x1b[<64;5;5m" }],
    ],
    [
      "an X10 coordinate past the end is cell 223, not negative (issue 049)",
      [Uint8Array.from([0x1b, 0x5b, 0x4d, 32, 0, 40])],
      [{ mouse: "down", button: 0, x: -33, y: 7 }],
      [{ mouse: "down", button: 0, x: 223, y: 7 }],
    ],
    [
      "Escape then a mouse report in one read keeps both (issue 044)",
      ["\x1b\x1b[<35;10;5M"],
      [{ key: "", raw: "\x1b\x1b[<35;10;5M", ctrl: false, meta: false, shift: false }],
      [
        { key: "escape", raw: "\x1b", ctrl: false, meta: false, shift: false },
        { mouse: "move", button: 0, x: 9, y: 4 },
      ],
    ],
    [
      "zero bytes only resolve timeouts",
      [new Uint8Array(0)],
      [{ key: "", raw: "", ctrl: false, meta: false, shift: false }],
      [],
    ],
    [
      "X10 releases report the button pressed last",
      ['\x1b[M"!!\x1b[M#!!'],
      [
        { mouse: "down", button: 2, x: 0, y: 0 },
        { mouse: "up", button: 0, x: 0, y: 0 },
      ],
      [
        { mouse: "down", button: 2, x: 0, y: 0 },
        { mouse: "up", button: 2, x: 0, y: 0 },
      ],
    ],
    [
      "extra mouse buttons report 8 and up instead of a left click",
      ["\x1b[<128;1;1M\x1b[<129;1;1m"],
      [
        { mouse: "down", button: 0, x: 0, y: 0 },
        { mouse: "up", button: 1, x: 0, y: 0 },
      ],
      [
        { mouse: "down", button: 8, x: 0, y: 0 },
        { mouse: "up", button: 9, x: 0, y: 0 },
      ],
    ],
    [
      "Kitty CSI u decodes without the legacy useKittyKeyboard option",
      ["\x1b[97;5u"],
      [{ key: "", raw: "\x1b[97;5u", ctrl: false, meta: false, shift: false }],
      [{ key: "a", raw: "\x1b[97;5u", ctrl: true, meta: false, shift: false }],
      { useKittyKeyboard: false },
    ],
  ]
  for (const [label, chunks, legacyEvents, nativeEvents, options] of cases) {
    test(label, () => {
      expect(parse(legacy, chunks, options).map(summary)).toEqual(legacyEvents)
      expect(parse(native, chunks, options).map(summary)).toEqual(nativeEvents)
    })
  }
})

describe("native stdin parser: differential replay", () => {
  // Representative input streams: typing, editing keys, startup capability replies,
  // mouse selection, scrolling, focus, and pastes, in the forms both parsers share.
  const streams: Array<[label: string, bytes: string]> = [
    ["typing", "Hello, wörld! 日本語 👍\r\x7f\x7f\t"],
    ["editing keys", "\x1b[A\x1b[B\x1b[1;5C\x1b[1;2D\x1b[H\x1b[F\x1b[3~\x1b[5~\x1b[6;5~\x1bOP\x1b[15~\x1b[Z"],
    ["control and Alt keys", "\x01\x03\x1a\x1ba\x1bA\x1b\x01\x1b\r\x1b \x1bB\x1bF"],
    [
      "startup replies",
      "\x1b[?62;22;52c\x1b[?2026;2$y\x1b[?1u\x1bP>|kitty(0.40.1)\x1b\\\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\\x1b_Gi=31337;OK\x1b\\\x1b[4;800;1200t",
    ],
    ["selection drag", "\x1b[<0;10;5M\x1b[<32;11;5M\x1b[<32;14;6M\x1b[<0;14;6m\x1b[<35;20;7M"],
    ["scrolling", "\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<66;10;5M\x1b[<67;10;5M"],
    ["X10 mouse", "\x1b[M !!\x1b[M#!!\x1b[M`$%"],
    ["focus", "\x1b[O\x1b[I"],
    ["pastes", "\x1b[200~line 1\nline 2\x1b[A\x1b[201~x\x1b[200~\x1b[201~"],
    ["Kitty keys", "\x1b[97u\x1b[97;5u\x1b[97;1:3u\x1b[13;2u\x1b[57364u\x1b[1;1:1A\x1b[5;1:3~\x1b[57399u"],
    ["modifyOtherKeys", "\x1b[27;2;13~\x1b[27;5;27~\x1b[27;5;32~\x1b[27;2;53~"],
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
      expect(parse(native, chunks, options).map(summary)).toEqual(parse(legacy, chunks, options).map(summary))
    })
  }

  test("the comparator reports each difference once and bounds a stalled side", () => {
    const lines: string[] = []
    const comparator = new StdinShadowComparator("native", (line) => lines.push(line))
    const key = (name: string): StdinEvent => ({
      type: "key",
      raw: name,
      key: {
        name,
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: name,
        number: false,
        raw: name,
        eventType: "press",
        source: "raw",
      },
    })
    comparator.primary(key("a"))
    comparator.shadow(key("a"))
    comparator.primary(key("b"))
    comparator.shadow(key("c"))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.startsWith('[stdin-shadow] native=["key","b"')).toBe(true)
    expect(lines[0]).toContain('legacy=["key","c"')
    for (let index = 0; index < 300; index++) comparator.primary(key("x"))
    expect(lines).toHaveLength(1 + 300 - 256)
    expect(lines.at(-1)!.endsWith("legacy=none")).toBe(true)
    // The 256 queued events pair up; the next 300 back up on the other side.
    for (let index = 0; index < 256 + 300; index++) comparator.shadow(key("x"))
    expect(lines).toHaveLength(1 + 2 * (300 - 256))
    expect(lines.at(-1)!.startsWith("[stdin-shadow] native=none")).toBe(true)
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
    const [enter, linefeed, altA, kittyA, keypad, repeat, base, f5] = parse(native, [
      "\r\n\x1bA\x1b[97;2u\x1bOp\x1b[97;1:2u\x1b[1089::99;5u\x1b[15;5~",
    ]).map((event) => (event.type === "key" ? event.key : null))
    expect(enter).toMatchObject({ name: "return", sequence: "\r", source: "raw" })
    expect(linefeed).toMatchObject({ name: "linefeed", sequence: "\n" })
    expect(altA).toMatchObject({ name: "A", meta: true, shift: true, option: false, sequence: "\x1bA" })
    expect(kittyA).toMatchObject({ name: "a", shift: true, sequence: "A", source: "kitty" })
    expect(keypad).toMatchObject({ name: "0", sequence: "0", number: true, code: "Op" })
    expect(repeat).toMatchObject({ name: "a", eventType: "press", repeated: true })
    expect(base).toMatchObject({ name: "с", ctrl: true, baseCode: 99 })
    expect(f5).toMatchObject({ name: "f5", ctrl: true, code: "[15~", option: false })
    const [altUp] = parse(native, ["\x1b\x1b[A"]).map((event) => (event.type === "key" ? event.key : null))
    expect(altUp).toMatchObject({ name: "up", meta: true, option: true, raw: "\x1b\x1b[A" })
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
      // A unit still waiting at resume is stale and resolves at once; deferred replies keep waiting.
      parser.push(Buffer.from("\x1b[4;80;"))
      parser.push(Buffer.from("\x1b["))
      parser.suspend()
      parser.resume()
      expect(events(parser).map(summary)).toEqual([
        { response: "unknown", sequence: "\x1b[4;80;" },
        { response: "unknown", sequence: "\x1b[" },
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
