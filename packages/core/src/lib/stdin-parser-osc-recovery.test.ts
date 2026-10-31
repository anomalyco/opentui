import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { ManualClock } from "../testing/manual-clock.js"
import { StdinParser, type StdinEvent } from "./stdin-parser.js"

function setup(active = true) {
  const clock = new ManualClock()
  const parser = new StdinParser({ clock, protocolContext: { privateCapabilityRepliesActive: active } })
  const drain = () => {
    const events: StdinEvent[] = []
    parser.drain((event) => events.push(event))
    return events
  }
  parser.push(Buffer.from("\x1b"))
  clock.advance(30)
  expect(drain().map((event) => event.type)).toEqual(["key"])
  return { parser, clock, drain }
}

for (const terminator of ["\x07", "\x1b\\"]) {
  test(`recovers delayed startup OSC color reply with ${JSON.stringify(terminator)}`, () => {
    const { parser, drain } = setup()
    const reply = `]11;rgb:ffff/ffff/ffff${terminator}`
    for (const byte of Buffer.from(reply)) parser.push(Uint8Array.of(byte))
    parser.push(Buffer.from("hello"))
    const events = drain()
    expect(events[0]).toEqual({ type: "response", protocol: "osc", sequence: `\x1b${reply}` })
    expect(
      events
        .slice(1)
        .map((event) => (event.type === "key" ? event.raw : "response"))
        .join(""),
    ).toBe("hello")
  })
}

for (const active of [false, true]) {
  test(`preserves ordinary bracket typing with startup queries ${active}`, () => {
    const { parser, clock, drain } = setup(active)
    parser.push(Buffer.from("]hello"))
    clock.advance(30)
    expect(
      drain()
        .map((event) => (event.type === "key" ? event.raw : "response"))
        .join(""),
    ).toBe("]hello")
  })
}

test("preserves an incomplete reply-shaped typed prefix on timeout", () => {
  const { parser, clock, drain } = setup()
  parser.push(Buffer.from("]11;rgb:f"))
  clock.advance(30)
  expect(
    drain()
      .map((event) => (event.type === "key" ? event.raw : "response"))
      .join(""),
  ).toBe("]11;rgb:f")
})

for (const prefix of ["]10;", "]12;", "]4;255;"]) {
  test(`recovers ${prefix} color replies`, () => {
    const { parser, drain } = setup()
    const reply = `${prefix}rgb:f/ff/ffff\x07`
    parser.push(Buffer.from(`${reply}hello`))
    expect(drain()[0]).toEqual({ type: "response", protocol: "osc", sequence: `\x1b${reply}` })
  })
}

test("does not recover a color reply without an active startup query", () => {
  const { parser, drain } = setup(false)
  parser.push(Buffer.from("]11;rgb:ffff/ffff/ffff\x07"))
  expect(drain().every((event) => event.type === "key")).toBe(true)
})

test("releases a candidate when the startup query ends", () => {
  const { parser, clock, drain } = setup()
  parser.push(Buffer.from("]11;rgb:f"))
  parser.updateProtocolContext({ privateCapabilityRepliesActive: false })
  clock.advance(30)
  expect(
    drain()
      .map((event) => (event.type === "key" ? event.raw : "response"))
      .join(""),
  ).toBe("]11;rgb:f")
})
