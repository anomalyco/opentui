import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { ManualClock } from "../testing/manual-clock.js"
import type { Clock, TimerHandle } from "./clock.js"
import type { ScrollInfo } from "./parse.mouse.js"
import { StdinParser, type StdinEvent, type StdinParserOptions } from "./stdin-parser.js"

type KeySnap = {
  type: "key"
  raw: string
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  eventType: string
}
type MouseSnap = { type: "mouse"; raw: string; encoding: "sgr" | "x10"; event: Record<string, unknown> }
type PasteSnap = { type: "paste"; bytes: Uint8Array }
type RespSnap = { type: "response"; protocol: string; sequence: string }
type Snap = KeySnap | MouseSnap | PasteSnap | RespSnap

const K_DEFAULTS = { ctrl: false, meta: false, shift: false, eventType: "press" }
const TEST_TIMEOUT_MS = 10
type KOpts = { raw?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; eventType?: string }

function k(name: string, opts: KOpts = {}): KeySnap {
  return { type: "key", raw: opts.raw ?? name, name, ...K_DEFAULTS, ...opts }
}

function resp(protocol: string, sequence: string): RespSnap {
  return { type: "response", protocol, sequence }
}

function paste(text: string): PasteSnap {
  return { type: "paste", bytes: Uint8Array.from(Buffer.from(text)) }
}

const NO_MODS = { shift: false, alt: false, ctrl: false }

function sgr(
  raw: string,
  evType: string,
  x: number,
  y: number,
  opts: { button?: number; mods?: Partial<typeof NO_MODS>; scroll?: ScrollInfo } = {},
): MouseSnap {
  const event: Record<string, unknown> = {
    type: evType,
    button: opts.button ?? 0,
    x,
    y,
    modifiers: { ...NO_MODS, ...opts.mods },
  }
  if (opts.scroll) event.scroll = opts.scroll
  return { type: "mouse", raw, encoding: "sgr", event }
}

function x10m(
  raw: string,
  evType: string,
  x: number,
  y: number,
  opts: { button?: number; mods?: Partial<typeof NO_MODS>; scroll?: ScrollInfo } = {},
): MouseSnap {
  const event: Record<string, unknown> = {
    type: evType,
    button: opts.button ?? 0,
    x,
    y,
    modifiers: { ...NO_MODS, ...opts.mods },
  }
  if (opts.scroll) event.scroll = opts.scroll
  return { type: "mouse", raw, encoding: "x10", event }
}

function createParser(options: StdinParserOptions = {}): StdinParser {
  return new StdinParser({ armTimeouts: false, clock: new ManualClock(), ...options })
}

function createTimedParser(options: StdinParserOptions = {}): { parser: StdinParser; clock: ManualClock } {
  const clock = new ManualClock()
  return { parser: new StdinParser({ armTimeouts: true, clock, timeoutMs: TEST_TIMEOUT_MS, ...options }), clock }
}

function snapshotEvent(event: StdinEvent): Snap {
  switch (event.type) {
    case "key":
      return {
        type: "key",
        raw: event.raw,
        name: event.key.name,
        ctrl: event.key.ctrl,
        meta: event.key.meta,
        shift: event.key.shift,
        eventType: event.key.eventType,
      }
    case "mouse": {
      const ev: Record<string, unknown> = { ...event.event }
      if (!ev.scroll) delete ev.scroll
      return { type: "mouse", raw: event.raw, encoding: event.encoding, event: ev }
    }
    case "paste":
      return { type: "paste", bytes: event.bytes }
    case "response":
      return { type: "response", protocol: event.protocol, sequence: event.sequence }
  }
}

function snap(parser: StdinParser): Snap[] {
  const events: StdinEvent[] = []
  parser.drain((e) => events.push(e))
  return events.map(snapshotEvent)
}

type ChunkInput = string | number[] | Uint8Array

function buf(input: ChunkInput): Uint8Array {
  if (typeof input === "string") return Buffer.from(input)
  return input instanceof Uint8Array ? input : Uint8Array.from(input)
}

function latin1(input: number[] | Uint8Array): string {
  return Buffer.from(buf(input)).toString("latin1")
}

function snapChunks(chunks: ChunkInput[], opts?: StdinParserOptions): Snap[] {
  const p = createParser(opts)
  try {
    for (const chunk of chunks) p.push(buf(chunk))
    return snap(p)
  } finally {
    p.destroy()
  }
}

function concatChunks(chunks: ChunkInput[]): Uint8Array {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(buf(chunk))))
}

function x10bytes(rawButton: number, x: number, y: number): number[] {
  return [0x1b, 0x5b, 0x4d, rawButton + 32, x + 33, y + 33]
}

type Case = [label: string, input: ChunkInput, expected: Snap[]]

function table(cases: Case[], opts?: StdinParserOptions) {
  for (const [label, input, expected] of cases) {
    test(label, () => {
      const p = createParser(opts)
      try {
        p.push(buf(input))
        expect(snap(p)).toEqual(expected)
      } finally {
        p.destroy()
      }
    })
  }
}

/** push each byte individually, assert same result as whole-chunk push */
function assertChunkInvariant(input: Uint8Array, opts?: StdinParserOptions) {
  const whole = createParser(opts)
  const split = createParser(opts)
  try {
    whole.push(input)
    const expected = snap(whole)
    for (let i = 0; i < input.length; i++) split.push(input.subarray(i, i + 1))
    expect(snap(split)).toEqual(expected)
  } finally {
    whole.destroy()
    split.destroy()
  }
}

describe("StdinParser", () => {
  describe("printable ASCII", () => {
    test("lowercase a-z", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("abcdefghijklmnopqrstuvwxyz"))
        expect(snap(p)).toEqual("abcdefghijklmnopqrstuvwxyz".split("").map((c) => k(c)))
      } finally {
        p.destroy()
      }
    })

    test("uppercase A-Z produce shifted keys", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"))
        expect(snap(p)).toEqual(
          "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => k(c.toLowerCase(), { raw: c, shift: true })),
        )
      } finally {
        p.destroy()
      }
    })

    test("digits 0-9", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("0123456789"))
        expect(snap(p)).toEqual("0123456789".split("").map((c) => k(c)))
      } finally {
        p.destroy()
      }
    })

    test("common symbols", () => {
      const p = createParser()
      try {
        const syms = "!@#$%^&*()-_=+[]{}|;':,./<>?`~"
        p.push(Buffer.from(syms))
        expect(snap(p)).toEqual(syms.split("").map((c) => k(c)))
      } finally {
        p.destroy()
      }
    })

    test("space produces key named space", () => {
      const p = createParser()
      try {
        p.push(Buffer.from(" "))
        expect(snap(p)).toEqual([k("space", { raw: " " })])
      } finally {
        p.destroy()
      }
    })
  })

  describe("control characters", () => {
    // Map of special control bytes that get their own key name instead of ctrl+letter
    const special: Record<number, [string, KOpts]> = {
      0x00: ["space", { ctrl: true }],
      0x08: ["backspace", {}],
      0x09: ["tab", {}],
      0x0a: ["linefeed", {}],
      0x0d: ["return", {}],
    }

    const cases: Case[] = []
    for (let byte = 0; byte <= 0x1a; byte++) {
      if (byte === 0x1b) continue // ESC tested separately
      const raw = String.fromCharCode(byte)
      const sp = special[byte]
      if (sp) {
        cases.push([`0x${byte.toString(16).padStart(2, "0")} → ${sp[0]}`, [byte], [k(sp[0], { raw, ...sp[1] })]])
      } else {
        const letter = String.fromCharCode(byte + 96)
        cases.push([
          `ctrl+${letter} (0x${byte.toString(16).padStart(2, "0")})`,
          [byte],
          [k(letter, { raw, ctrl: true })],
        ])
      }
    }
    cases.push(["0x7f → backspace", [0x7f], [k("backspace", { raw: "\x7f" })]])

    table(cases)
  })

  describe("special keys", () => {
    table([
      ["return", "\r", [k("return", { raw: "\r" })]],
      ["linefeed", "\n", [k("linefeed", { raw: "\n" })]],
      ["tab", "\t", [k("tab", { raw: "\t" })]],
      ["backspace (0x08)", "\b", [k("backspace", { raw: "\b" })]],
      ["backspace (0x7f)", "\x7f", [k("backspace", { raw: "\x7f" })]],
      ["escape (lone, no timeout)", "\x1b", []], // stays pending without timeout
      ["shift-tab", "\x1b[Z", [k("tab", { raw: "\x1b[Z", shift: true })]],
      ["ctrl+space", "\x00", [k("space", { raw: "\x00", ctrl: true })]],
    ])

    test("lone ESC with timeout produces escape key", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])
      } finally {
        parser.destroy()
      }
    })
  })

  describe("arrows and navigation", () => {
    table([
      // CSI arrows
      ["up", "\x1b[A", [k("up", { raw: "\x1b[A" })]],
      ["down", "\x1b[B", [k("down", { raw: "\x1b[B" })]],
      ["right", "\x1b[C", [k("right", { raw: "\x1b[C" })]],
      ["left", "\x1b[D", [k("left", { raw: "\x1b[D" })]],
      ["home", "\x1b[H", [k("home", { raw: "\x1b[H" })]],
      ["end", "\x1b[F", [k("end", { raw: "\x1b[F" })]],
      ["clear", "\x1b[E", [k("clear", { raw: "\x1b[E" })]],
      // tilde navigation
      ["home ~", "\x1b[1~", [k("home", { raw: "\x1b[1~" })]],
      ["insert ~", "\x1b[2~", [k("insert", { raw: "\x1b[2~" })]],
      ["delete ~", "\x1b[3~", [k("delete", { raw: "\x1b[3~" })]],
      ["end ~", "\x1b[4~", [k("end", { raw: "\x1b[4~" })]],
      ["pgup ~", "\x1b[5~", [k("pageup", { raw: "\x1b[5~" })]],
      ["pgdn ~", "\x1b[6~", [k("pagedown", { raw: "\x1b[6~" })]],
      // rxvt
      ["home rxvt", "\x1b[7~", [k("home", { raw: "\x1b[7~" })]],
      ["end rxvt", "\x1b[8~", [k("end", { raw: "\x1b[8~" })]],
    ])
  })

  describe("function keys", () => {
    // ESC [ n ~ form
    const tildeF: [string, string][] = [
      ["f1", "11"],
      ["f2", "12"],
      ["f3", "13"],
      ["f4", "14"],
      ["f5", "15"],
      ["f6", "17"],
      ["f7", "18"],
      ["f8", "19"],
      ["f9", "20"],
      ["f10", "21"],
      ["f11", "23"],
      ["f12", "24"],
    ]
    table(tildeF.map(([name, num]) => [`${name} (CSI ${num}~)`, `\x1b[${num}~`, [k(name, { raw: `\x1b[${num}~` })]]))

    // ESC O letter (SS3) form — F1-F4
    table([
      ["f1 (SS3)", "\x1bOP", [k("f1", { raw: "\x1bOP" })]],
      ["f2 (SS3)", "\x1bOQ", [k("f2", { raw: "\x1bOQ" })]],
      ["f3 (SS3)", "\x1bOR", [k("f3", { raw: "\x1bOR" })]],
      ["f4 (SS3)", "\x1bOS", [k("f4", { raw: "\x1bOS" })]],
    ])
  })

  describe("double-bracket CSI variants", () => {
    table([
      ["f1 ([[A)", "\x1b[[A", [k("f1", { raw: "\x1b[[A" })]],
      ["f2 ([[B)", "\x1b[[B", [k("f2", { raw: "\x1b[[B" })]],
      ["f3 ([[C)", "\x1b[[C", [k("f3", { raw: "\x1b[[C" })]],
      ["f4 ([[D)", "\x1b[[D", [k("f4", { raw: "\x1b[[D" })]],
      ["f5 ([[E)", "\x1b[[E", [k("f5", { raw: "\x1b[[E" })]],
      ["pageup ([[5~)", "\x1b[[5~", [k("pageup", { raw: "\x1b[[5~" })]],
      ["pagedown ([[6~)", "\x1b[[6~", [k("pagedown", { raw: "\x1b[[6~" })]],
    ])
  })

  describe("SS3 sequences", () => {
    table([
      ["up", "\x1bOA", [k("up", { raw: "\x1bOA" })]],
      ["down", "\x1bOB", [k("down", { raw: "\x1bOB" })]],
      ["right", "\x1bOC", [k("right", { raw: "\x1bOC" })]],
      ["left", "\x1bOD", [k("left", { raw: "\x1bOD" })]],
      ["home", "\x1bOH", [k("home", { raw: "\x1bOH" })]],
      ["end", "\x1bOF", [k("end", { raw: "\x1bOF" })]],
      ["clear", "\x1bOE", [k("clear", { raw: "\x1bOE" })]],
    ])

    test("SS3 interrupted by embedded ESC flushes partial then restarts", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1bO\x1bOA"))
        const s = snap(p)
        expect(s).toHaveLength(2)
        expect(s[0]).toEqual(resp("unknown", "\x1bO"))
        expect(s[1]).toEqual(k("up", { raw: "\x1bOA" }))
      } finally {
        p.destroy()
      }
    })

    test("SS3 timeout-flushed as unknown response", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1bO"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1bO")])
      } finally {
        parser.destroy()
      }
    })

    test("SS3 timeout flush does not swallow later text", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1bO"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1bO")])

        parser.push(Buffer.from("a"))
        expect(snap(parser)).toEqual([k("a")])
      } finally {
        parser.destroy()
      }
    })
  })

  describe("modifier combinations", () => {
    // CSI 1;modifier letter format
    const modTable: [string, number, KOpts][] = [
      ["shift", 2, { shift: true }],
      ["alt", 3, { meta: true }],
      ["shift+alt", 4, { shift: true, meta: true }],
      ["ctrl", 5, { ctrl: true }],
      ["shift+ctrl", 6, { shift: true, ctrl: true }],
      ["alt+ctrl", 7, { meta: true, ctrl: true }],
    ]

    const arrows: [string, string][] = [
      ["up", "A"],
      ["down", "B"],
      ["right", "C"],
      ["left", "D"],
    ]

    const cases: Case[] = []
    for (const [modName, modNum, modOpts] of modTable) {
      for (const [keyName, letter] of arrows) {
        const seq = `\x1b[1;${modNum}${letter}`
        cases.push([`${modName}+${keyName}`, seq, [k(keyName, { raw: seq, ...modOpts })]])
      }
    }
    table(cases)

    // rxvt shift variants
    table([
      ["shift+up (rxvt)", "\x1b[a", [k("up", { raw: "\x1b[a", shift: true })]],
      ["shift+down (rxvt)", "\x1b[b", [k("down", { raw: "\x1b[b", shift: true })]],
      ["shift+right (rxvt)", "\x1b[c", [k("right", { raw: "\x1b[c", shift: true })]],
      ["shift+left (rxvt)", "\x1b[d", [k("left", { raw: "\x1b[d", shift: true })]],
    ])

    // rxvt ctrl variants
    table([
      ["ctrl+up (rxvt)", "\x1bOa", [k("up", { raw: "\x1bOa", ctrl: true })]],
      ["ctrl+down (rxvt)", "\x1bOb", [k("down", { raw: "\x1bOb", ctrl: true })]],
      ["ctrl+right (rxvt)", "\x1bOc", [k("right", { raw: "\x1bOc", ctrl: true })]],
      ["ctrl+left (rxvt)", "\x1bOd", [k("left", { raw: "\x1bOd", ctrl: true })]],
    ])

    // rxvt $ (shift) and ^ (ctrl) on tilde keys
    table([
      ["shift+insert (rxvt $)", "\x1b[2$", [k("insert", { raw: "\x1b[2$", shift: true })]],
      ["shift+delete (rxvt $)", "\x1b[3$", [k("delete", { raw: "\x1b[3$", shift: true })]],
      ["shift+pgup (rxvt $)", "\x1b[5$", [k("pageup", { raw: "\x1b[5$", shift: true })]],
      ["shift+pgdn (rxvt $)", "\x1b[6$", [k("pagedown", { raw: "\x1b[6$", shift: true })]],
      ["ctrl+insert (rxvt ^)", "\x1b[2^", [k("insert", { raw: "\x1b[2^", ctrl: true })]],
      ["ctrl+delete (rxvt ^)", "\x1b[3^", [k("delete", { raw: "\x1b[3^", ctrl: true })]],
      ["ctrl+pgup (rxvt ^)", "\x1b[5^", [k("pageup", { raw: "\x1b[5^", ctrl: true })]],
      ["ctrl+pgdn (rxvt ^)", "\x1b[6^", [k("pagedown", { raw: "\x1b[6^", ctrl: true })]],
    ])
  })

  describe("meta key combinations", () => {
    test("meta+lowercase letters", () => {
      const p = createParser()
      try {
        // Push all ESC+letter pairs at once — each should produce meta+key
        for (const ch of "acdeghijklmoqrstuvwxyz".split("")) {
          p.push(Buffer.from(`\x1b${ch}`))
        }
        const s = snap(p)
        for (let i = 0; i < s.length; i++) {
          const ch = "acdeghijklmoqrstuvwxyz"[i]!
          expect(s[i]).toEqual(k(ch, { raw: `\x1b${ch}`, meta: true }))
        }
      } finally {
        p.destroy()
      }
    })

    // Lowercase ESC+b / ESC+f stay literal meta chords, while uppercase ESC+B / ESC+F
    // preserve the old-style meta+arrow behavior from `main`.
    table([
      ["meta+b (literal chord)", "\x1bb", [k("b", { raw: "\x1bb", meta: true })]],
      ["meta+f (literal chord)", "\x1bf", [k("f", { raw: "\x1bf", meta: true })]],
      ["meta+B (old-style left)", "\x1bB", [k("left", { raw: "\x1bB", meta: true })]],
      ["meta+F (old-style right)", "\x1bF", [k("right", { raw: "\x1bF", meta: true })]],
      ["meta+n (plain letter)", "\x1bn", [k("n", { raw: "\x1bn", meta: true })]],
      ["meta+p (plain letter)", "\x1bp", [k("p", { raw: "\x1bp", meta: true })]],
    ])

    table([
      ["meta+return", "\x1b\r", [k("return", { raw: "\x1b\r", meta: true })]],
      ["meta+linefeed", "\x1b\n", [k("linefeed", { raw: "\x1b\n", meta: true })]],
      ["meta+backspace", "\x1b\x7f", [k("backspace", { raw: "\x1b\x7f", meta: true })]],
      ["meta+backspace (0x08)", "\x1b\b", [k("backspace", { raw: "\x1b\b", meta: true })]],
      ["meta+space", "\x1b ", [k("space", { raw: "\x1b ", meta: true })]],
    ])

    test("meta+escape (requires timeout for \\x1b\\x1b)", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b\x1b"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b\x1b", meta: true })])
      } finally {
        parser.destroy()
      }
    })

    table([["double-ESC + [A → meta+up", "\x1b\x1b[A", [k("up", { raw: "\x1b\x1b[A", meta: true })]]])

    test("meta+uppercase sets shift", () => {
      const p = createParser()
      try {
        // ESC + uppercase letter → meta + shift + name (uppercase preserved in parseKeypress)
        // Excluding B and F which map to arrow keys
        p.push(Buffer.from("\x1bA"))
        const s = snap(p)
        expect(s).toEqual([k("A", { raw: "\x1bA", meta: true, shift: true })])
      } finally {
        p.destroy()
      }
    })

    test("meta+ctrl+letter", () => {
      const p = createParser()
      try {
        // ESC + ctrl char (e.g. ESC + 0x01 = meta+ctrl+a)
        p.push(Uint8Array.from([0x1b, 0x01]))
        expect(snap(p)).toEqual([k("a", { raw: "\x1b\x01", meta: true, ctrl: true })])
      } finally {
        p.destroy()
      }
    })

    test("meta+digit", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b5"))
        expect(snap(p)).toEqual([k("5", { raw: "\x1b5", meta: true })])
      } finally {
        p.destroy()
      }
    })
  })

  describe("kitty keyboard protocol", () => {
    // CSI codepoint u format
    table([
      ["a key", "\x1b[97u", [k("a", { raw: "\x1b[97u" })]],
      ["space", "\x1b[32u", [k("space", { raw: "\x1b[32u" })]],
      ["shift+a", "\x1b[97;2u", [k("a", { raw: "\x1b[97;2u", shift: true })]],
      ["shift+space", "\x1b[32;2u", [k("space", { raw: "\x1b[32;2u", shift: true })]],
      ["ctrl+a", "\x1b[97;5u", [k("a", { raw: "\x1b[97;5u", ctrl: true })]],
      ["ctrl+space", "\x1b[32;5u", [k("space", { raw: "\x1b[32;5u", ctrl: true })]],
      ["alt+a", "\x1b[97;3u", [k("a", { raw: "\x1b[97;3u", meta: true })]],
      ["ctrl+shift+a", "\x1b[97;6u", [k("a", { raw: "\x1b[97;6u", ctrl: true, shift: true })]],
      ["a release", "\x1b[97;1:3u", [k("a", { raw: "\x1b[97;1:3u", eventType: "release" })]],
      ["escape", "\x1b[27u", [k("escape", { raw: "\x1b[27u" })]],
      ["return", "\x1b[13u", [k("return", { raw: "\x1b[13u" })]],
      ["tab", "\x1b[9u", [k("tab", { raw: "\x1b[9u" })]],
      ["backspace", "\x1b[127u", [k("backspace", { raw: "\x1b[127u" })]],
      ["delete", "\x1b[57349u", [k("delete", { raw: "\x1b[57349u" })]],
      ["insert", "\x1b[57348u", [k("insert", { raw: "\x1b[57348u" })]],
      ["f1", "\x1b[57364u", [k("f1", { raw: "\x1b[57364u" })]],
      ["f12", "\x1b[57375u", [k("f12", { raw: "\x1b[57375u" })]],
    ])

    // CSI 1;modifier:event letter format (kitty functional keys)
    table([
      ["up press", "\x1b[1;1:1A", [k("up", { raw: "\x1b[1;1:1A" })]],
      ["up release", "\x1b[1;1:3A", [k("up", { raw: "\x1b[1;1:3A", eventType: "release" })]],
      ["ctrl+right", "\x1b[1;5:1C", [k("right", { raw: "\x1b[1;5:1C", ctrl: true })]],
      ["shift+left", "\x1b[1;2:1D", [k("left", { raw: "\x1b[1;2:1D", shift: true })]],
      ["home", "\x1b[1;1:1H", [k("home", { raw: "\x1b[1;1:1H" })]],
      ["end release", "\x1b[1;1:3F", [k("end", { raw: "\x1b[1;1:3F", eventType: "release" })]],
      ["f1 press", "\x1b[1;1:1P", [k("f1", { raw: "\x1b[1;1:1P" })]],
    ])

    // CSI number;modifier:event ~ format (kitty tilde keys)
    table([
      ["pageup press", "\x1b[5;1:1~", [k("pageup", { raw: "\x1b[5;1:1~" })]],
      ["ctrl+delete", "\x1b[3;5:1~", [k("delete", { raw: "\x1b[3;5:1~", ctrl: true })]],
      ["insert release", "\x1b[2;1:3~", [k("insert", { raw: "\x1b[2;1:3~", eventType: "release" })]],
    ])
  })

  describe("modifyOtherKeys", () => {
    table([
      ["shift+return", "\x1b[27;2;13~", [k("return", { raw: "\x1b[27;2;13~", shift: true })]],
      ["ctrl+return", "\x1b[27;5;13~", [k("return", { raw: "\x1b[27;5;13~", ctrl: true })]],
      ["ctrl+escape", "\x1b[27;5;27~", [k("escape", { raw: "\x1b[27;5;27~", ctrl: true })]],
      ["alt+tab", "\x1b[27;3;9~", [k("tab", { raw: "\x1b[27;3;9~", meta: true })]],
      ["shift+space", "\x1b[27;2;32~", [k("space", { raw: "\x1b[27;2;32~", shift: true })]],
      ["ctrl+backspace", "\x1b[27;5;127~", [k("backspace", { raw: "\x1b[27;5;127~", ctrl: true })]],
      ["shift+digit 5", "\x1b[27;2;53~", [k("5", { raw: "\x1b[27;2;53~", shift: true })]],
    ])
  })

  describe("mouse: SGR protocol", () => {
    table([
      // Button press/release
      ["left down", "\x1b[<0;1;1M", [sgr("\x1b[<0;1;1M", "down", 0, 0)]],
      ["left up", "\x1b[<0;1;1m", [sgr("\x1b[<0;1;1m", "up", 0, 0)]],
      ["middle down", "\x1b[<1;1;1M", [sgr("\x1b[<1;1;1M", "down", 0, 0, { button: 1 })]],
      ["middle up", "\x1b[<1;1;1m", [sgr("\x1b[<1;1;1m", "up", 0, 0, { button: 1 })]],
      ["right down", "\x1b[<2;1;1M", [sgr("\x1b[<2;1;1M", "down", 0, 0, { button: 2 })]],
      ["right up", "\x1b[<2;1;1m", [sgr("\x1b[<2;1;1m", "up", 0, 0, { button: 2 })]],
      // Scroll
      [
        "scroll up",
        "\x1b[<64;10;5M",
        [sgr("\x1b[<64;10;5M", "scroll", 9, 4, { scroll: { direction: "up", delta: 1 } })],
      ],
      [
        "scroll down",
        "\x1b[<65;10;5M",
        [sgr("\x1b[<65;10;5M", "scroll", 9, 4, { button: 1, scroll: { direction: "down", delta: 1 } })],
      ],
      [
        "scroll left",
        "\x1b[<66;10;5M",
        [sgr("\x1b[<66;10;5M", "scroll", 9, 4, { button: 2, scroll: { direction: "left", delta: 1 } })],
      ],
      [
        "scroll right",
        "\x1b[<67;10;5M",
        [sgr("\x1b[<67;10;5M", "scroll", 9, 4, { button: 0, scroll: { direction: "right", delta: 1 } })],
      ],
      // Motion (no button)
      ["move", "\x1b[<35;20;10M", [sgr("\x1b[<35;20;10M", "move", 19, 9)]],
      // Large coordinates
      ["large coords", "\x1b[<0;300;200M", [sgr("\x1b[<0;300;200M", "down", 299, 199)]],
      // Modifiers
      ["shift+left down", "\x1b[<4;1;1M", [sgr("\x1b[<4;1;1M", "down", 0, 0, { mods: { shift: true } })]],
      ["alt+left down", "\x1b[<8;1;1M", [sgr("\x1b[<8;1;1M", "down", 0, 0, { mods: { alt: true } })]],
      ["ctrl+left down", "\x1b[<16;1;1M", [sgr("\x1b[<16;1;1M", "down", 0, 0, { mods: { ctrl: true } })]],
    ])

    test("drag detection after button down", () => {
      const p = createParser()
      try {
        // Button 0 down, then motion with button 0 flag
        p.push(Buffer.from("\x1b[<0;5;5M\x1b[<32;6;5M"))
        const s = snap(p)
        expect(s).toHaveLength(2)
        expect(s[0]).toEqual(sgr("\x1b[<0;5;5M", "down", 4, 4))
        expect(s[1]).toEqual(sgr("\x1b[<32;6;5M", "drag", 5, 4))
      } finally {
        p.destroy()
      }
    })

    test("split SGR across two pushes", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[<64;10;"))
        expect(snap(p)).toEqual([])
        p.push(Buffer.from("5M"))
        expect(snap(p)).toEqual([sgr("\x1b[<64;10;5M", "scroll", 9, 4, { scroll: { direction: "up", delta: 1 } })])
      } finally {
        p.destroy()
      }
    })

    test("multiple mouse events in one push", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[<0;1;1M\x1b[<0;2;1M\x1b[<0;2;1m"))
        const s = snap(p)
        expect(s).toHaveLength(3)
        expect(s[0]).toEqual(sgr("\x1b[<0;1;1M", "down", 0, 0))
        expect(s[1]).toEqual(sgr("\x1b[<0;2;1M", "down", 1, 0))
        expect(s[2]).toEqual(sgr("\x1b[<0;2;1m", "up", 1, 0))
      } finally {
        p.destroy()
      }
    })
  })

  describe("mouse: X10 protocol", () => {
    // X10: ESC [ M <button+32> <x+33> <y+33>
    const leftDown = x10bytes(0, 0, 0)
    const middleDown = x10bytes(1, 0, 0)
    const rightDown = x10bytes(2, 0, 0)
    const release = x10bytes(3, 0, 0)
    const at1020 = x10bytes(0, 10, 20)
    const move = x10bytes(35, 4, 5)
    const scrollUp = x10bytes(64, 2, 3)
    const shiftLeftDown = x10bytes(4, 0, 0)
    const ctrlScrollUp = x10bytes(80, 7, 8)

    table([
      ["left down (0,0)", leftDown, [x10m(latin1(leftDown), "down", 0, 0)]],
      ["middle down", middleDown, [x10m(latin1(middleDown), "down", 0, 0, { button: 1 })]],
      ["right down", rightDown, [x10m(latin1(rightDown), "down", 0, 0, { button: 2 })]],
      ["release", release, [x10m(latin1(release), "up", 0, 0)]],
      ["at position 10,20", at1020, [x10m(latin1(at1020), "down", 10, 20)]],
      ["move with no button", move, [x10m(latin1(move), "move", 4, 5, { button: -1 })]],
      ["scroll up", scrollUp, [x10m(latin1(scrollUp), "scroll", 2, 3, { scroll: { direction: "up", delta: 1 } })]],
      ["shift+left down", shiftLeftDown, [x10m(latin1(shiftLeftDown), "down", 0, 0, { mods: { shift: true } })]],
      [
        "ctrl+scroll up",
        ctrlScrollUp,
        [x10m(latin1(ctrlScrollUp), "scroll", 7, 8, { mods: { ctrl: true }, scroll: { direction: "up", delta: 1 } })],
      ],
    ])

    test("X10 mouse followed by key", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[M !!x"))
        const s = snap(p)
        expect(s).toHaveLength(2)
        expect(s[0]).toEqual(x10m("\x1b[M !!", "down", 0, 0))
        expect(s[1]).toEqual(k("x"))
      } finally {
        p.destroy()
      }
    })

    test("split X10 across pushes waits for payload", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[M"))
        expect(snap(p)).toEqual([])
        p.push(Buffer.from(" !!"))
        expect(snap(p)).toEqual([x10m("\x1b[M !!", "down", 0, 0)])
      } finally {
        p.destroy()
      }
    })

    test("delayed X10 continuation after timed-out escape becomes a mouse event", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])

        parser.push(Buffer.from("[M"))
        expect(snap(parser)).toEqual([])
        parser.push(Buffer.from(" !!"))
        expect(snap(parser)).toEqual([x10m("\x1b[M !!", "down", 0, 0)])
      } finally {
        parser.destroy()
      }
    })
  })

  describe("UTF-8 handling", () => {
    table([
      ["2-byte (é)", "\u00e9", [k("\u00e9")]],
      ["3-byte (中)", "\u4e2d", [k("\u4e2d")]],
      ["4-byte (👍)", "👍", [k("👍")]],
      ["multiple utf-8 chars", "日本語", [k("日"), k("本"), k("語")]],
    ])

    test("2-byte split at byte boundary", () => {
      const bytes = Buffer.from("é")
      expect(bytes.length).toBe(2)
      const p = createParser()
      try {
        p.push(bytes.subarray(0, 1))
        expect(snap(p)).toEqual([])
        p.push(bytes.subarray(1))
        expect(snap(p)).toEqual([k("é")])
      } finally {
        p.destroy()
      }
    })

    test("3-byte split at every boundary", () => {
      const bytes = Buffer.from("中")
      expect(bytes.length).toBe(3)
      for (let split = 1; split < bytes.length; split++) {
        const p = createParser()
        try {
          p.push(bytes.subarray(0, split))
          expect(snap(p)).toEqual([])
          p.push(bytes.subarray(split))
          expect(snap(p)).toEqual([k("中")])
        } finally {
          p.destroy()
        }
      }
    })

    test("4-byte split at every boundary", () => {
      const bytes = Buffer.from("👍")
      expect(bytes.length).toBe(4)
      for (let split = 1; split < bytes.length; split++) {
        const p = createParser()
        try {
          p.push(bytes.subarray(0, split))
          expect(snap(p)).toEqual([])
          p.push(bytes.subarray(split))
          expect(snap(p)).toEqual([k("👍")])
        } finally {
          p.destroy()
        }
      }
    })

    test("invalid UTF-8 lead (0xC0) followed by ASCII falls back to legacy high-byte", () => {
      const p = createParser()
      try {
        p.push(Uint8Array.from([0xc0, 0x41]))
        const s = snap(p)
        expect(s).toHaveLength(2)
        // 0xC0 - 128 = 0x40 = '@', treated as ESC + '@' → legacy path
        expect(s[0]!.type).toBe("key")
        expect(s[1]).toEqual(k("a", { raw: "A", shift: true }))
      } finally {
        p.destroy()
      }
    })

    test("invalid continuation byte after valid lead falls back to legacy", () => {
      const p = createParser()
      try {
        p.push(Uint8Array.from([0xe9])) // valid 3-byte lead
        expect(snap(p)).toEqual([]) // waits for continuation
        p.push(Buffer.from("x")) // not a continuation byte
        const s = snap(p)
        expect(s).toEqual([
          k("i", { raw: "\x1bi", meta: true }), // 0xe9 → legacy: 0xe9-128=0x69='i', ESC prefix
          k("x"),
        ])
      } finally {
        p.destroy()
      }
    })

    test("legacy single high-byte on timeout", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Uint8Array.from([0xe9]))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([k("i", { raw: "\x1bi", meta: true })])
      } finally {
        parser.destroy()
      }
    })

    test("high byte 0xFF on timeout → meta+backspace", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Uint8Array.from([0xff]))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        // 0xFF - 128 = 0x7F = DEL, so ESC + DEL = meta+backspace
        expect(snap(parser)).toEqual([k("backspace", { raw: "\x1b\x7f", meta: true })])
      } finally {
        parser.destroy()
      }
    })
  })

  describe("protocol responses", () => {
    table([
      // OSC (BEL-terminated)
      ["OSC (BEL)", "\x1b]4;0;#ffffff\x07", [resp("osc", "\x1b]4;0;#ffffff\x07")]],
      // OSC (ESC \\ terminated)
      ["OSC (ST)", "\x1b]4;0;rgb:ff/ff/ff\x1b\\", [resp("osc", "\x1b]4;0;rgb:ff/ff/ff\x1b\\")]],
      // DCS
      ["DCS", "\x1bP>|kitty(0.40.1)\x1b\\", [resp("dcs", "\x1bP>|kitty(0.40.1)\x1b\\")]],
      // APC
      ["APC", "\x1b_Gi=1;OK\x1b\\", [resp("apc", "\x1b_Gi=1;OK\x1b\\")]],
      // Focus
      ["focus in", "\x1b[I", [resp("csi", "\x1b[I")]],
      ["focus out", "\x1b[O", [resp("csi", "\x1b[O")]],
      // DA (Device Attributes)
      ["DA1", "\x1b[?62;1;2;6;7;8;9;15;22c", [resp("csi", "\x1b[?62;1;2;6;7;8;9;15;22c")]],
      // CPR (Cursor Position Report)
      ["CPR", "\x1b[24;80R", [resp("cpr", "\x1b[24;80R")]],
      // Window/cell size
      ["window size", "\x1b[4;600;800t", [resp("csi", "\x1b[4;600;800t")]],
      // Mode report
      ["mode report", "\x1b[?2004;1$y", [resp("csi", "\x1b[?2004;1$y")]],
    ])

    test("all three protocol responses in one push", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b]4;0;#fff\x07\x1bP>|test\x1b\\\x1b_OK\x1b\\"))
        expect(snap(p)).toEqual([
          resp("osc", "\x1b]4;0;#fff\x07"),
          resp("dcs", "\x1bP>|test\x1b\\"),
          resp("apc", "\x1b_OK\x1b\\"),
        ])
      } finally {
        p.destroy()
      }
    })

    test("split OSC across pushes", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b]4;0;"))
        expect(snap(p)).toEqual([])
        p.push(Buffer.from("#ffffff\x07"))
        expect(snap(p)).toEqual([resp("osc", "\x1b]4;0;#ffffff\x07")])
      } finally {
        p.destroy()
      }
    })

    test("split DCS terminator ESC \\ across pushes", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1bPtest\x1b"))
        expect(snap(p)).toEqual([])
        p.push(Buffer.from("\\"))
        expect(snap(p)).toEqual([resp("dcs", "\x1bPtest\x1b\\")])
      } finally {
        p.destroy()
      }
    })

    test("focus events interleaved with keys", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("a\x1b[Ib\x1b[Oc"))
        expect(snap(p)).toEqual([k("a"), resp("csi", "\x1b[I"), k("b"), resp("csi", "\x1b[O"), k("c")])
      } finally {
        p.destroy()
      }
    })

    test("partial OSC flushes on timeout as unknown", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b]incomplete"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b]incomplete")])
      } finally {
        parser.destroy()
      }
    })

    test("partial DCS flushes on timeout as unknown", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1bPpartial"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1bPpartial")])
      } finally {
        parser.destroy()
      }
    })

    test("partial APC flushes on timeout as unknown", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b_partial"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b_partial")])
      } finally {
        parser.destroy()
      }
    })

    test("partial generic CSI flushes on timeout as unknown", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b[123"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[123")])
      } finally {
        parser.destroy()
      }
    })

    test("partial kitty CSI stays pending after timeout", () => {
      const { parser, clock } = createTimedParser({ protocolContext: { kittyKeyboardEnabled: true } })
      try {
        parser.push(Buffer.from("\x1b[118;5"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])
      } finally {
        parser.destroy()
      }
    })

    test("partial kitty CSI stays pending after timeout when split after first semicolon", () => {
      const { parser, clock } = createTimedParser({ protocolContext: { kittyKeyboardEnabled: true } })
      try {
        parser.push(Buffer.from("\x1b[97;"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("2u"))
        expect(snap(parser)).toEqual([k("a", { shift: true, raw: "\x1b[97;2u" })])
      } finally {
        parser.destroy()
      }
    })

    test("partial kitty alternate-key CSI stays pending after timeout", () => {
      const { parser, clock } = createTimedParser({ protocolContext: { kittyKeyboardEnabled: true } })
      try {
        parser.push(Buffer.from("\x1b[97:65;"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("6:1u"))
        expect(snap(parser)).toEqual([k("a", { raw: "\x1b[97:65;6:1u", ctrl: true, shift: true })])
      } finally {
        parser.destroy()
      }
    })

    test("partial kitty CSI stays pending after timeout for higher modifier bits", () => {
      const { parser, clock } = createTimedParser({ protocolContext: { kittyKeyboardEnabled: true } })
      try {
        parser.push(Buffer.from("\x1b[97;9"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("u"))
        const event = parser.read()
        expect(event?.type).toBe("key")
        if (!event || event.type !== "key") throw new Error("expected key event")
        expect(event.raw).toBe("\x1b[97;9u")
        expect(event.key.name).toBe("a")
        expect(event.key.super).toBe(true)
        expect(parser.read()).toBeNull()
      } finally {
        parser.destroy()
      }
    })

    test("partial kitty special-key CSI stays pending after timeout", () => {
      const { parser, clock } = createTimedParser({ protocolContext: { kittyKeyboardEnabled: true } })
      try {
        parser.push(Buffer.from("\x1b[1;1:"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("3A"))
        expect(snap(parser)).toEqual([k("up", { raw: "\x1b[1;1:3A", eventType: "release" })])
      } finally {
        parser.destroy()
      }
    })

    test("partial SGR mouse CSI stays pending after timeout", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b[<35;20"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from(";5m"))
        expect(snap(parser)).toEqual([sgr("\x1b[<35;20;5m", "move", 19, 4)])
      } finally {
        parser.destroy()
      }
    })

    test("split CSI across reads reassembles after timeout", () => {
      const { parser, clock } = createTimedParser({ protocolContext: { kittyKeyboardEnabled: true } })
      try {
        // Kitty Ctrl+V release split across two reads
        parser.push(Buffer.from("\x1b[118;5"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        // Stays pending — not flushed
        expect(snap(parser)).toEqual([])
        parser.push(Buffer.from(";3u"))
        expect(snap(parser)).toEqual([k("v", { ctrl: true, raw: "\x1b[118;5;3u" })])
      } finally {
        parser.destroy()
      }
    })

    test("split kitty escape CSI across reads reassembles after timeout", () => {
      const { parser, clock } = createTimedParser({ protocolContext: { kittyKeyboardEnabled: true } })
      try {
        parser.push(Buffer.from("\x1b[27;5"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])
        parser.push(Buffer.from("u"))
        expect(snap(parser)).toEqual([k("escape", { ctrl: true, raw: "\x1b[27;5u" })])
      } finally {
        parser.destroy()
      }
    })

    test("timed-out standard one-semicolon CSI key flushes before later text", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b[1;5"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[1;5")])

        parser.push(Buffer.from("A"))
        expect(snap(parser)).toEqual([k("a", { raw: "A", shift: true })])
      } finally {
        parser.destroy()
      }
    })

    test("timed-out one-semicolon CSI response flushes before later text", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b[24;80"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[24;80")])

        parser.push(Buffer.from("R"))
        expect(snap(parser)).toEqual([k("r", { raw: "R", shift: true })])
      } finally {
        parser.destroy()
      }
    })

    test("timed-out partial kitty CSI resyncs on a later ESC", () => {
      const { parser, clock } = createTimedParser({ protocolContext: { kittyKeyboardEnabled: true } })
      try {
        parser.push(Buffer.from("\x1b[118;5"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("\x1b[A"))
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[118;5"), k("up", { raw: "\x1b[A" })])
      } finally {
        parser.destroy()
      }
    })

    test("timed-out partial kitty CSI flushes before unrelated later text", () => {
      const { parser, clock } = createTimedParser({ protocolContext: { kittyKeyboardEnabled: true } })
      try {
        parser.push(Buffer.from("\x1b[118;5"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("a"))
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[118;5"), k("a")])
      } finally {
        parser.destroy()
      }
    })

    test("partial generic CSI timeout flush does not swallow later text", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b[123"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[123")])

        parser.push(Buffer.from("a"))
        expect(snap(parser)).toEqual([k("a")])
      } finally {
        parser.destroy()
      }
    })

    test("partial large-parameter CSI flushes on timeout before later text", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b[80;120"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[80;120")])

        parser.push(Buffer.from("a"))
        expect(snap(parser)).toEqual([k("a")])
      } finally {
        parser.destroy()
      }
    })

    test("partial OSC timeout flush does not swallow later text", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b]52;c;"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b]52;c;")])

        parser.push(Buffer.from("abc"))
        expect(snap(parser)).toEqual([k("a"), k("b"), k("c")])
      } finally {
        parser.destroy()
      }
    })

    test("partial OSC timeout flush does not swallow later escape sequences", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b]52;c;"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b]52;c;")])

        parser.push(Buffer.from("\x1b[A"))
        expect(snap(parser)).toEqual([k("up", { raw: "\x1b[A" })])
      } finally {
        parser.destroy()
      }
    })
  })

  describe("protocol context", () => {
    test("partial explicit-width CPR stays pending after timeout when probe is active", () => {
      const { parser, clock } = createTimedParser({
        protocolContext: { explicitWidthCprActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[1;2"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("R"))
        expect(snap(parser)).toEqual([resp("cpr", "\x1b[1;2R")])
      } finally {
        parser.destroy()
      }
    })

    test("partial explicit-width CPR flushes before later text when probe is inactive", () => {
      const { parser, clock } = createTimedParser()

      try {
        parser.push(Buffer.from("\x1b[1;2"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[1;2")])

        parser.push(Buffer.from("R"))
        expect(snap(parser)).toEqual([k("r", { raw: "R", shift: true })])
      } finally {
        parser.destroy()
      }
    })

    test("partial pixel resolution response stays pending after timeout while query is active", () => {
      const { parser, clock } = createTimedParser({
        protocolContext: { pixelResolutionQueryActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[4;1080;192"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("0t"))
        expect(snap(parser)).toEqual([resp("csi", "\x1b[4;1080;1920t")])
      } finally {
        parser.destroy()
      }
    })

    test("partial DECRPM stays pending after timeout while capability probe is active", () => {
      const { parser, clock } = createTimedParser({
        protocolContext: { privateCapabilityRepliesActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[?1016;2$"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("y"))
        expect(snap(parser)).toEqual([resp("csi", "\x1b[?1016;2$y")])
      } finally {
        parser.destroy()
      }
    })

    test("partial DA1 stays pending after timeout while capability probe is active", () => {
      const { parser, clock } = createTimedParser({
        protocolContext: { privateCapabilityRepliesActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[?62;"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("c"))
        expect(snap(parser)).toEqual([resp("csi", "\x1b[?62;c")])
      } finally {
        parser.destroy()
      }
    })

    test("theme mode replies are emitted as CSI responses", () => {
      const parser = createParser({
        protocolContext: { privateCapabilityRepliesActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[?997;1n"))
        expect(snap(parser)).toEqual([resp("csi", "\x1b[?997;1n")])
      } finally {
        parser.destroy()
      }
    })

    test("partial theme mode reply stays pending after timeout while capability probe is active", () => {
      const { parser, clock } = createTimedParser({
        protocolContext: { privateCapabilityRepliesActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[?997;1"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("n"))
        expect(snap(parser)).toEqual([resp("csi", "\x1b[?997;1n")])
      } finally {
        parser.destroy()
      }
    })

    test("timed-out modified CSI key still flushes before later final byte", () => {
      const { parser, clock } = createTimedParser({
        protocolContext: { explicitWidthCprActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[1;5"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("A"))
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[1;5"), k("a", { raw: "A", shift: true })])
      } finally {
        parser.destroy()
      }
    })

    test("generic row/col CPR does not reassemble during explicit-width probe window", () => {
      const { parser, clock } = createTimedParser({
        protocolContext: { explicitWidthCprActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[24;80"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[24;80")])

        parser.push(Buffer.from("R"))
        expect(snap(parser)).toEqual([k("r", { raw: "R", shift: true })])
      } finally {
        parser.destroy()
      }
    })

    test("generic row/col CPR stays pending after timeout while startup cursor probe is active", () => {
      const { parser, clock } = createTimedParser({
        protocolContext: { startupCursorCprActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[24;80"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("R"))
        expect(snap(parser)).toEqual([resp("cpr", "\x1b[24;80R")])
      } finally {
        parser.destroy()
      }
    })

    test("aborting a pending startup cursor CPR swallows a reply that finishes later", () => {
      const parser = createParser({
        protocolContext: { startupCursorCprActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[24;80"))
        expect(snap(parser)).toEqual([])

        parser.abortPendingStartupCursorCpr()
        parser.updateProtocolContext({ startupCursorCprActive: false })

        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("R"))
        expect(snap(parser)).toEqual([])
      } finally {
        parser.destroy()
      }
    })

    test("aborting a pending startup cursor CPR swallows a reply split after the CSI introducer", () => {
      const parser = createParser({
        protocolContext: { startupCursorCprActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b["))
        expect(snap(parser)).toEqual([])

        parser.abortPendingStartupCursorCpr()
        parser.updateProtocolContext({ startupCursorCprActive: false })

        parser.push(Buffer.from("24;80R"))
        expect(snap(parser)).toEqual([])
      } finally {
        parser.destroy()
      }
    })

    test("aborting a pending startup cursor CPR preserves explicit-width CPR replies", () => {
      const parser = createParser({
        protocolContext: {
          startupCursorCprActive: true,
          explicitWidthCprActive: true,
        },
      })

      try {
        parser.push(Buffer.from("\x1b["))
        expect(snap(parser)).toEqual([])

        parser.abortPendingStartupCursorCpr()
        parser.updateProtocolContext({ startupCursorCprActive: false })

        parser.push(Buffer.from("1;2R"))
        expect(snap(parser)).toEqual([resp("cpr", "\x1b[1;2R")])
      } finally {
        parser.destroy()
      }
    })

    test("aborting a pending startup cursor CPR preserves later non-CPR input", () => {
      const parser = createParser({
        protocolContext: { startupCursorCprActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[24;80"))
        expect(snap(parser)).toEqual([])

        parser.abortPendingStartupCursorCpr()
        parser.updateProtocolContext({ startupCursorCprActive: false })

        parser.push(Buffer.from("a"))
        expect(snap(parser)).toEqual([k("a")])
      } finally {
        parser.destroy()
      }
    })

    test("deferred explicit-width CPR flushes when probe context is cleared", () => {
      const { parser, clock } = createTimedParser({
        protocolContext: { explicitWidthCprActive: true },
      })

      try {
        parser.push(Buffer.from("\x1b[1;2"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([])

        parser.updateProtocolContext({ explicitWidthCprActive: false })
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[1;2")])
      } finally {
        parser.destroy()
      }
    })

    test("timed-out pending explicit-width CPR does not rearm until more bytes arrive", () => {
      const clock = new ManualClock()
      let timeoutFlushes = 0
      let parser!: StdinParser
      parser = new StdinParser({
        armTimeouts: true,
        clock,
        timeoutMs: TEST_TIMEOUT_MS,
        protocolContext: { explicitWidthCprActive: true },
        onTimeoutFlush: () => {
          timeoutFlushes += 1
          parser.drain(() => {})
        },
      })

      try {
        parser.push(Buffer.from("\x1b[1;2"))
        clock.advance(10)
        expect(timeoutFlushes).toBe(1)

        clock.advance(50)
        expect(timeoutFlushes).toBe(1)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from(";"))
        clock.advance(10)
        expect(timeoutFlushes).toBe(2)
      } finally {
        parser.destroy()
      }
    })

    test("timed-out pending private reply does not rearm until more bytes arrive", () => {
      const clock = new ManualClock()
      let timeoutFlushes = 0
      let parser!: StdinParser
      parser = new StdinParser({
        armTimeouts: true,
        clock,
        timeoutMs: TEST_TIMEOUT_MS,
        protocolContext: { privateCapabilityRepliesActive: true },
        onTimeoutFlush: () => {
          timeoutFlushes += 1
          parser.drain(() => {})
        },
      })

      try {
        parser.push(Buffer.from("\x1b[?1016;2$"))
        clock.advance(10)
        expect(timeoutFlushes).toBe(1)

        clock.advance(50)
        expect(timeoutFlushes).toBe(1)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from(";"))
        clock.advance(10)
        expect(timeoutFlushes).toBe(2)
      } finally {
        parser.destroy()
      }
    })
  })

  describe("bracketed paste", () => {
    table([
      ["simple paste", "\x1b[200~hello\x1b[201~", [paste("hello")]],
      ["empty paste", "\x1b[200~\x1b[201~", [paste("")]],
      ["paste with newlines", "\x1b[200~line1\nline2\x1b[201~", [paste("line1\nline2")]],
      ["paste with tabs", "\x1b[200~a\tb\x1b[201~", [paste("a\tb")]],
      ["paste with ESC in body", "\x1b[200~abc\x1bdef\x1b[201~", [paste("abc\x1bdef")]],
    ])

    test("split paste start marker across pushes", () => {
      const start = "\x1b[200~"
      for (let split = 1; split < start.length; split++) {
        const p = createParser()
        try {
          p.push(Buffer.from(start.slice(0, split)))
          p.push(Buffer.from(start.slice(split) + "hi\x1b[201~"))
          expect(snap(p)).toEqual([paste("hi")])
        } finally {
          p.destroy()
        }
      }
    })

    test("split paste end marker at every boundary", () => {
      const end = "\x1b[201~"
      for (let split = 1; split < end.length; split++) {
        const p = createParser()
        try {
          p.push(Buffer.from("\x1b[200~hello"))
          p.push(Buffer.from(end.slice(0, split)))
          expect(snap(p)).toEqual([])
          p.push(Buffer.from(end.slice(split)))
          expect(snap(p)).toEqual([paste("hello")])
        } finally {
          p.destroy()
        }
      }
    })

    test("paste body bytes do not alias caller buffers across pushes", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[200~"))

        const chunk = Buffer.from("hello")
        p.push(chunk)
        chunk.fill(0x78)

        p.push(Buffer.from("\x1b[201~"))
        expect(snap(p)).toEqual([paste("hello")])
      } finally {
        p.destroy()
      }
    })

    test("near-match end markers are part of paste body", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[200~abc\x1b[202~def\x1b[201~"))
        expect(snap(p)).toEqual([paste("abc\x1b[202~def")])
      } finally {
        p.destroy()
      }
    })

    test("doubled ESC before paste end marker", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[200~abc\x1b"))
        expect(snap(p)).toEqual([])
        p.push(Buffer.from("\x1b[201~"))
        expect(snap(p)).toEqual([paste("abc\x1b")])
      } finally {
        p.destroy()
      }
    })

    test("large paste does not grow parser buffer", () => {
      const p = createParser({ maxPendingBytes: 32 })
      const payload = "x".repeat(100_000)
      try {
        p.push(Buffer.from(`\x1b[200~${payload}\x1b[201~z`))
        expect(snap(p)).toEqual([paste(payload), k("z")])
        expect(p.bufferCapacity).toBeLessThanOrEqual(512)
      } finally {
        p.destroy()
      }
    })

    test("large paste across many small chunks", () => {
      const p = createParser({ maxPendingBytes: 32 })
      try {
        p.push(Buffer.from("\x1b[200~"))
        for (let i = 0; i < 1000; i++) p.push(Buffer.from("chunk "))
        p.push(Buffer.from("\x1b[201~"))
        const s = snap(p)
        expect(s).toHaveLength(1)
        expect(s[0]!.type).toBe("paste")
        expect((s[0] as PasteSnap).bytes).toHaveLength(6000)
        expect(p.bufferCapacity).toBeLessThanOrEqual(512)
      } finally {
        p.destroy()
      }
    })

    test("trailing bytes after paste end are parsed normally", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[200~hello\x1b[201~\x1b[A"))
        expect(snap(p)).toEqual([paste("hello"), k("up", { raw: "\x1b[A" })])
      } finally {
        p.destroy()
      }
    })

    test("back-to-back pastes", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[200~first\x1b[201~\x1b[200~second\x1b[201~"))
        expect(snap(p)).toEqual([paste("first"), paste("second")])
      } finally {
        p.destroy()
      }
    })

    test("paste with UTF-8 content", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[200~日本語👍\x1b[201~"))
        expect(snap(p)).toEqual([paste("日本語👍")])
      } finally {
        p.destroy()
      }
    })

    test("paste with UTF-8 split across chunks", () => {
      const p = createParser()
      const emoji = Buffer.from("👍")
      try {
        p.push(Buffer.from("\x1b[200~"))
        p.push(emoji.subarray(0, 2))
        p.push(emoji.subarray(2))
        p.push(Buffer.from("\x1b[201~"))
        expect(snap(p)).toEqual([paste("👍")])
      } finally {
        p.destroy()
      }
    })
  })

  describe("ESC-less SGR continuation recovery", () => {
    test("after timed-out ESC, scroll continuation still becomes a mouse event", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])

        parser.push(Buffer.from("[<64;38;15M"))
        expect(snap(parser)).toEqual([
          sgr("\x1b[<64;38;15M", "scroll", 37, 14, { scroll: { direction: "up", delta: 1 } }),
        ])
      } finally {
        parser.destroy()
      }
    })

    test("after timed-out ESC, continuation is recovered as mouse input", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])

        parser.push(Buffer.from("[<35;20;5m"))
        expect(snap(parser)).toEqual([sgr("\x1b[<35;20;5m", "move", 19, 4)])
      } finally {
        parser.destroy()
      }
    })

    test("after timed-out ESC, split continuation across pushes is recovered as mouse input", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])

        parser.push(Buffer.from("["))
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from("<35;20;5m"))
        expect(snap(parser)).toEqual([sgr("\x1b[<35;20;5m", "move", 19, 4)])
      } finally {
        parser.destroy()
      }
    })

    test("after timed-out ESC, partial [< waits, then timeout flushes as one response", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])

        parser.push(Buffer.from("[<35;20"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "[<35;20")])
      } finally {
        parser.destroy()
      }
    })

    test("after timed-out ESC, [< followed by non-digit aborts immediately", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])

        parser.push(Buffer.from("[<x"))
        const s = snap(parser)
        expect(s).toHaveLength(2)
        expect(s[0]).toEqual(resp("unknown", "[<"))
        expect(s[1]).toEqual(k("x"))
      } finally {
        parser.destroy()
      }
    })

    test("without prior flushed ESC, [< stays literal text", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("[<35;20;5m"))
        expect(snap(p)).toEqual("[<35;20;5m".split("").map((char) => k(char)))
      } finally {
        p.destroy()
      }
    })

    test("without prior flushed ESC, standalone [ then < stay as individual keys", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("["))
        expect(snap(p)).toEqual([k("[")])
        p.push(Buffer.from("<"))
        expect(snap(p)).toEqual([k("<")])
      } finally {
        p.destroy()
      }
    })

    test("after timed-out ESC, bare [ waits for more and then flushes as text", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])

        parser.push(Buffer.from("["))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([k("[")])
      } finally {
        parser.destroy()
      }
    })
  })

  describe("timeout behavior", () => {
    test("default timeout at exact boundary (19ms no fire, 20ms fires)", () => {
      const clock = new ManualClock()
      const parser = new StdinParser({ armTimeouts: true, clock })
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(19)
        expect(snap(parser)).toEqual([])
        clock.advance(1)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])
      } finally {
        parser.destroy()
      }
    })

    test("configured timeout at exact boundary (9ms no fire, 10ms fires)", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(9)
        expect(snap(parser)).toEqual([])
        clock.advance(1)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])
      } finally {
        parser.destroy()
      }
    })

    test("flushTimeout() only flushes when caller reports elapsed timeout", () => {
      const parser = createParser({ timeoutMs: TEST_TIMEOUT_MS })
      try {
        parser.push(Buffer.from("\x1b"))

        parser.flushTimeout(TEST_TIMEOUT_MS - 1)
        expect(snap(parser)).toEqual([])

        parser.flushTimeout(TEST_TIMEOUT_MS)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])
      } finally {
        parser.destroy()
      }
    })

    test("timeout resets when more bytes arrive", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b[<35;20;"))
        clock.advance(9) // almost timeout
        parser.push(Buffer.from("5")) // new byte resets timer
        expect(snap(parser)).toEqual([])
        clock.advance(9) // almost timeout again
        expect(snap(parser)).toEqual([])
        parser.push(Buffer.from("m")) // complete
        expect(snap(parser)).toEqual([sgr("\x1b[<35;20;5m", "move", 19, 4)])
      } finally {
        parser.destroy()
      }
    })

    test("timed-out pending kitty CSI does not rearm until more bytes arrive", () => {
      const clock = new ManualClock()
      let timeoutFlushes = 0
      let parser!: StdinParser
      parser = new StdinParser({
        armTimeouts: true,
        clock,
        timeoutMs: TEST_TIMEOUT_MS,
        protocolContext: { kittyKeyboardEnabled: true },
        onTimeoutFlush: () => {
          timeoutFlushes += 1
          parser.drain(() => {})
        },
      })

      try {
        parser.push(Buffer.from("\x1b[118;5"))
        clock.advance(10)
        expect(timeoutFlushes).toBe(1)

        clock.advance(50)
        expect(timeoutFlushes).toBe(1)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from(";"))
        clock.advance(10)
        expect(timeoutFlushes).toBe(2)
      } finally {
        parser.destroy()
      }
    })

    test("timed-out pending SGR mouse CSI does not rearm until more bytes arrive", () => {
      const clock = new ManualClock()
      let timeoutFlushes = 0
      let parser!: StdinParser
      parser = new StdinParser({
        armTimeouts: true,
        clock,
        timeoutMs: TEST_TIMEOUT_MS,
        onTimeoutFlush: () => {
          timeoutFlushes += 1
          parser.drain(() => {})
        },
      })

      try {
        parser.push(Buffer.from("\x1b[<35;20"))
        clock.advance(10)
        expect(timeoutFlushes).toBe(1)

        clock.advance(50)
        expect(timeoutFlushes).toBe(1)
        expect(snap(parser)).toEqual([])

        parser.push(Buffer.from(";"))
        clock.advance(10)
        expect(timeoutFlushes).toBe(2)
      } finally {
        parser.destroy()
      }
    })

    test("timeout does not fire during paste mode", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b[200~partial"))
        clock.advance(100) // way past timeout
        expect(snap(parser)).toEqual([]) // still collecting paste
        parser.push(Buffer.from("\x1b[201~"))
        expect(snap(parser)).toEqual([paste("partial")])
      } finally {
        parser.destroy()
      }
    })

    test("multiple sequential timeouts", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])

        parser.push(Buffer.from("\x1b"))
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])

        parser.push(Buffer.from("\x1b"))
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])
      } finally {
        parser.destroy()
      }
    })

    test("custom timeout delay", () => {
      const { parser, clock } = createTimedParser({ timeoutMs: 50 })
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(49)
        expect(snap(parser)).toEqual([])
        clock.advance(1)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])
      } finally {
        parser.destroy()
      }
    })

    test("data completing sequence before timeout cancels flush", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b"))
        clock.advance(5) // halfway to timeout
        parser.push(Buffer.from("[A")) // completes arrow sequence
        expect(snap(parser)).toEqual([k("up", { raw: "\x1b[A" })])
        clock.advance(100) // timeout would have fired, but sequence is done
        expect(snap(parser)).toEqual([])
      } finally {
        parser.destroy()
      }
    })
  })

  describe("embedded ESC abort", () => {
    test("ESC inside partial CSI flushes as unknown, restarts", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[<35;\x1b[<35;20;5m"))
        expect(snap(p)).toEqual([resp("unknown", "\x1b[<35;"), sgr("\x1b[<35;20;5m", "move", 19, 4)])
      } finally {
        p.destroy()
      }
    })

    test("ESC inside partial CSI with no following data", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b[123\x1b"))
        const s = snap(parser)
        // first part flushed as unknown response, ESC starts new escape
        expect(s).toEqual([resp("unknown", "\x1b[123")])
        // the trailing ESC is pending
        clock.advance(10)
        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])
      } finally {
        parser.destroy()
      }
    })

    test("ESC inside OSC restarts parsing", () => {
      const p = createParser()
      try {
        // ESC ] ... ESC ESC [ A — the first ESC after OSC body starts ST check,
        // but second ESC byte is not \, so sawEsc resets. Then ESC starts escape.
        // Actually: \x1b]foo has sawEsc=false. Then \x1b sets sawEsc=true.
        // Then [ is not \, so sawEsc resets to false and [ is consumed as content.
        // Then \x1b sets sawEsc=true. Then \ (0x5c = \\) terminates OSC.
        p.push(Buffer.from("\x1b]foo\x1b\\"))
        expect(snap(p)).toEqual([resp("osc", "\x1b]foo\x1b\\")])
      } finally {
        p.destroy()
      }
    })

    test("ESC in SS3 flushes partial as unknown", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1bO\x1b[A"))
        expect(snap(p)).toEqual([resp("unknown", "\x1bO"), k("up", { raw: "\x1b[A" })])
      } finally {
        p.destroy()
      }
    })
  })

  describe("chunk-shape invariance", () => {
    const sequences = [
      "abc", // multiple ASCII
      "\x1b[A", // arrow
      "\x1bOP", // SS3 F1
      "\x1b[[A", // Cygwin F1
      "\x1b[[5~", // putty pageup
      "\x1b[<0;10;20M", // SGR mouse
      "\x1b[M !!", // X10 mouse
      "\x1b]4;0;#ffffff\x07", // OSC
      "\x1bP>|test\x1b\\", // DCS
      "\x1b_OK\x1b\\", // APC
      "\x1b[200~hello\x1b[201~", // paste
      "\x1b[I", // focus in
      "\x1b[1;5A", // ctrl+up
      "\x1b[97u", // kitty key
      "\x1b[27;2;13~", // modifyOtherKeys
    ]

    for (const seq of sequences) {
      test(`byte-at-a-time: ${JSON.stringify(seq).slice(1, -1).slice(0, 30)}`, () => {
        assertChunkInvariant(Buffer.from(seq))
      })
    }

    test("mixed stream byte-at-a-time", () => {
      const stream = Buffer.concat([
        Buffer.from("x"),
        Buffer.from("\x1b[<64;10;5M"),
        Buffer.from("\x1b[I"),
        Buffer.from("\x1b]4;0;#fff\x07"),
        Buffer.from("\x1b[200~paste\x1b[201~"),
        Buffer.from("👍"),
      ])
      assertChunkInvariant(stream)
    })

    test("random two-chunk splits", () => {
      const stream = Buffer.from("x\x1b[<64;10;5M\x1b[I\x1b]4;0;#fff\x07\x1b[200~p\x1b[201~y")
      const whole = createParser()
      try {
        whole.push(stream)
        const expected = snap(whole)
        // Try splitting at every possible position
        for (let split = 1; split < stream.length - 1; split++) {
          const p = createParser()
          try {
            p.push(stream.subarray(0, split))
            p.push(stream.subarray(split))
            expect(snap(p)).toEqual(expected)
          } finally {
            p.destroy()
          }
        }
      } finally {
        whole.destroy()
      }
    })

    const comboAtoms: Array<[label: string, input: ChunkInput]> = [
      ["ascii", "xy"],
      ["utf8", "👍"],
      ["arrow", "\x1b[A"],
      ["sgr", "\x1b[<64;10;5M"],
      ["x10", x10bytes(0, 0, 0)],
      ["osc", "\x1b]4;0;#fff\x07"],
      ["paste", "\x1b[200~p\x1b[201~"],
      ["kitty", "\x1b[97u"],
    ]

    for (const [firstLabel, first] of comboAtoms) {
      for (const [secondLabel, second] of comboAtoms) {
        test(`${firstLabel} + ${secondLabel} across every two-chunk split`, () => {
          const stream = concatChunks([first, second])
          const expected = snapChunks([stream])

          expect(snapChunks([first, second])).toEqual(expected)
          for (let split = 1; split < stream.length; split++) {
            expect(snapChunks([stream.subarray(0, split), stream.subarray(split)])).toEqual(expected)
          }
        })
      }
    }
  })

  describe("state management", () => {
    test("reset clears pending bytes and releases capacity", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b["))
        expect(snap(p)).toEqual([])
        p.push(Buffer.alloc(4096, 0x78)) // 'x' bytes to grow buffer
        p.reset()
        expect(snap(p)).toEqual([])
        expect(p.bufferCapacity).toBeLessThanOrEqual(256)
        // parser works normally after reset
        p.push(Buffer.from("a"))
        expect(snap(p)).toEqual([k("a")])
      } finally {
        p.destroy()
      }
    })

    test("reset during paste mode clears paste state", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[200~partial paste"))
        expect(snap(p)).toEqual([])
        p.reset()
        expect(snap(p)).toEqual([])
        // parser works normally after reset
        p.push(Buffer.from("a"))
        expect(snap(p)).toEqual([k("a")])
      } finally {
        p.destroy()
      }
    })

    test("reset during escape sequence clears state", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b["))
        expect(snap(p)).toEqual([])
        p.reset()
        // After reset, the partial CSI is gone; new input starts fresh
        p.push(Buffer.from("A"))
        expect(snap(p)).toEqual([k("a", { raw: "A", shift: true })]) // 'A' = shift+a
      } finally {
        p.destroy()
      }
    })

    test("double reset is safe", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b["))
        p.reset()
        p.reset()
        p.push(Buffer.from("x"))
        expect(snap(p)).toEqual([k("x")])
      } finally {
        p.destroy()
      }
    })

    test("double destroy is safe", () => {
      const p = createParser()
      p.destroy()
      expect(() => p.destroy()).not.toThrow()
    })

    test("push after destroy throws", () => {
      const p = createParser()
      p.destroy()
      expect(() => p.push(Buffer.from("a"))).toThrow("destroyed")
    })

    test("read after destroy throws", () => {
      const p = createParser()
      p.destroy()
      expect(() => p.read()).toThrow("destroyed")
    })

    test("drain after destroy throws", () => {
      const p = createParser()
      p.destroy()
      expect(() => p.drain(() => {})).toThrow("destroyed")
    })

    test("destroy during drain stops iteration", () => {
      const p = createParser()
      p.push(Buffer.from("abc"))
      let count = 0
      expect(() => {
        p.drain(() => {
          count++
          if (count === 1) p.destroy()
        })
      }).not.toThrow()
      expect(count).toBe(1)
    })

    test("read returns null when queue is empty", () => {
      const p = createParser()
      try {
        expect(p.read()).toBeNull()
      } finally {
        p.destroy()
      }
    })

    test("read pops events one at a time", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("abc"))
        const e1 = p.read()
        const e2 = p.read()
        const e3 = p.read()
        const e4 = p.read()
        expect(e1).not.toBeNull()
        expect(e2).not.toBeNull()
        expect(e3).not.toBeNull()
        expect(e4).toBeNull()
        expect(snapshotEvent(e1!)).toEqual(k("a"))
        expect(snapshotEvent(e2!)).toEqual(k("b"))
        expect(snapshotEvent(e3!)).toEqual(k("c"))
      } finally {
        p.destroy()
      }
    })

    test("overflow flushes incomplete protocols as one unknown response and recovers", () => {
      const longDigits = "1".repeat(40)
      const longOsc = "a".repeat(40)
      const longDcs = "x".repeat(40)
      const cases: Array<[label: string, chunks: ChunkInput[], expected: Snap[]]> = [
        ["CSI", [`\x1b[${longDigits}`], [resp("unknown", `\x1b[${longDigits}`)]],
        ["OSC", [`\x1b]${longOsc}`], [resp("unknown", `\x1b]${longOsc}`)]],
        ["DCS + recovery", [`\x1bP${longDcs}`, "z"], [resp("unknown", `\x1bP${longDcs}`), k("z")]],
      ]

      for (const [label, chunks, expected] of cases) {
        expect(snapChunks(chunks, { maxPendingBytes: 16 })).toEqual(expected)
      }
    })
  })

  describe("multi-event interleaving", () => {
    table([
      [
        "key + mouse",
        "x\x1b[<64;10;5M",
        [k("x"), sgr("\x1b[<64;10;5M", "scroll", 9, 4, { scroll: { direction: "up", delta: 1 } })],
      ],
      [
        "mouse + key",
        "\x1b[<64;10;5Mx",
        [sgr("\x1b[<64;10;5M", "scroll", 9, 4, { scroll: { direction: "up", delta: 1 } }), k("x")],
      ],
      ["key + focus + key", "a\x1b[Ib", [k("a"), resp("csi", "\x1b[I"), k("b")]],
      ["paste + key", "\x1b[200~hi\x1b[201~z", [paste("hi"), k("z")]],
      ["multiple keys", "abc", [k("a"), k("b"), k("c")]],
      [
        "arrow + text + mouse",
        "\x1b[Ax\x1b[<0;1;1M",
        [k("up", { raw: "\x1b[A" }), k("x"), sgr("\x1b[<0;1;1M", "down", 0, 0)],
      ],
    ])

    test("OSC + key + mouse + paste in one push", () => {
      const p = createParser()
      try {
        const input = "\x1b]4;0;#fff\x07a\x1b[<0;1;1M\x1b[200~p\x1b[201~"
        p.push(Buffer.from(input))
        expect(snap(p)).toEqual([
          resp("osc", "\x1b]4;0;#fff\x07"),
          k("a"),
          sgr("\x1b[<0;1;1M", "down", 0, 0),
          paste("p"),
        ])
      } finally {
        p.destroy()
      }
    })
  })

  describe("negative and edge cases", () => {
    test("push with empty buffer emits an empty key event", () => {
      const p = createParser()
      try {
        p.push(new Uint8Array(0))
        expect(snap(p)).toEqual([k("")])
      } finally {
        p.destroy()
      }
    })

    test("drain with no events does not call callback", () => {
      const p = createParser()
      try {
        let called = false
        p.drain(() => {
          called = true
        })
        expect(called).toBe(false)
      } finally {
        p.destroy()
      }
    })

    table([
      ["CSI with unknown final byte produces empty-name key", "\x1b[h", [k("", { raw: "\x1b[h" })]],
      ["ESC followed by punctuation stays one empty-name key", "\x1b!", [k("", { raw: "\x1b!" })]],
      ["ESC followed by N becomes meta+shift+N", "\x1bN", [k("N", { raw: "\x1bN", meta: true, shift: true })]],
      ["malformed SGR mouse falls through as empty-name CSI key", "\x1b[<0M", [k("", { raw: "\x1b[<0M" })]],
      ["bracketed paste end outside paste mode is a CSI response", "\x1b[201~", [resp("csi", "\x1b[201~")]],
    ])

    test("partial X10 times out as one unknown response", () => {
      const { parser, clock } = createTimedParser()
      try {
        parser.push(Buffer.from("\x1b[M !"))
        expect(snap(parser)).toEqual([])
        clock.advance(10)
        expect(snap(parser)).toEqual([resp("unknown", "\x1b[M !")])
      } finally {
        parser.destroy()
      }
    })

    test("very long paste with partial end marker in every chunk", () => {
      const p = createParser()
      try {
        p.push(Buffer.from("\x1b[200~"))
        for (let i = 0; i < 100; i++) p.push(Buffer.from("\x1b[20"))
        p.push(Buffer.from("\x1b[201~"))
        expect(snap(p)).toEqual([paste("\x1b[20".repeat(100))])
      } finally {
        p.destroy()
      }
    })
  })

  describe("timer/clock disagreement race condition", () => {
    test("timeout callback flushes even when now() reports slightly less elapsed time than timeoutMs", () => {
      const inner = new ManualClock()
      let insideTimerCallback = false

      // Wraps ManualClock so that now() returns pendingSinceMs + timeoutMs - 1
      // during the timeout callback, simulating runtime behavior where timer
      // scheduling and now() sampling disagree by a small amount.
      const disagreeingClock: Clock = {
        now(): number {
          if (insideTimerCallback) {
            // Report 1ms less than the timeout requires — this is the
            // race condition that kept bytes stuck before the fix.
            return TEST_TIMEOUT_MS - 1
          }
          return inner.now()
        },
        setTimeout(fn: () => void, delayMs: number): TimerHandle {
          return inner.setTimeout(() => {
            insideTimerCallback = true
            try {
              fn()
            } finally {
              insideTimerCallback = false
            }
          }, delayMs)
        },
        clearTimeout(handle: TimerHandle): void {
          inner.clearTimeout(handle)
        },
        setInterval(fn: () => void, delayMs: number): TimerHandle {
          return inner.setInterval(fn, delayMs)
        },
        clearInterval(handle: TimerHandle): void {
          inner.clearInterval(handle)
        },
      }

      const parser = new StdinParser({ armTimeouts: true, clock: disagreeingClock, timeoutMs: TEST_TIMEOUT_MS })
      try {
        parser.push(Buffer.from("\x1b"))
        expect(snap(parser)).toEqual([])

        // Fire the timer — now() will report timeoutMs - 1 elapsed, but the
        // timeout callback still force-flushes without re-checking elapsed time.
        inner.advance(TEST_TIMEOUT_MS)

        expect(snap(parser)).toEqual([k("escape", { raw: "\x1b" })])
      } finally {
        parser.destroy()
      }
    })
  })
})
