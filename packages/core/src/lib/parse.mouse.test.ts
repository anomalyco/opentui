import { describe, test, expect, beforeEach } from "bun:test"
import { MouseParser } from "./parse.mouse.js"

// Encode a basic/X10 mouse event: ESC [ M Cb Cx Cy
// buttonByte is the logical value (before the +32 wire offset), x/y are 0-based.
// Returns a latin1 Buffer so charCodeAt() round-trips correctly even for high
// coordinates (>= 95 i.e. raw byte >= 128).
function encodeBasic(buttonByte: number, x: number, y: number): Buffer {
  const cb = buttonByte + 32
  const cx = x + 33
  const cy = y + 33
  return Buffer.from([0x1b, 0x5b, 0x4d, cb, cx, cy]) // ESC [ M cb cx cy
}

// Encode an SGR mouse event: ESC [ < buttonCode ; x+1 ; y+1 M/m
function encodeSGR(buttonCode: number, x: number, y: number, press: boolean): Buffer {
  const suffix = press ? "M" : "m"
  return Buffer.from(`\x1b[<${buttonCode};${x + 1};${y + 1}${suffix}`)
}

describe("MouseParser basic (X10) mode", () => {
  let parser: MouseParser

  beforeEach(() => {
    parser = new MouseParser()
  })

  describe("press and release", () => {
    test("left button down", () => {
      const e = parser.parseMouseEvent(encodeBasic(0, 10, 5))
      expect(e).toMatchObject({ type: "down", button: 0, x: 10, y: 5 })
    })

    test("middle button down", () => {
      const e = parser.parseMouseEvent(encodeBasic(1, 10, 5))
      expect(e).toMatchObject({ type: "down", button: 1, x: 10, y: 5 })
    })

    test("right button down", () => {
      const e = parser.parseMouseEvent(encodeBasic(2, 10, 5))
      expect(e).toMatchObject({ type: "down", button: 2, x: 10, y: 5 })
    })

    test("button release (button byte 3)", () => {
      // In X10, release always reports button=3 regardless of which was released
      const e = parser.parseMouseEvent(encodeBasic(3, 10, 5))
      expect(e).toMatchObject({ type: "up", x: 10, y: 5 })
    })
  })

  describe("scroll", () => {
    test("scroll up (64)", () => {
      const e = parser.parseMouseEvent(encodeBasic(64, 10, 5))
      expect(e).toMatchObject({ type: "scroll", scroll: { direction: "up", delta: 1 } })
    })

    test("scroll down (65)", () => {
      const e = parser.parseMouseEvent(encodeBasic(65, 10, 5))
      expect(e).toMatchObject({ type: "scroll", scroll: { direction: "down", delta: 1 } })
    })

    test("scroll left (66)", () => {
      const e = parser.parseMouseEvent(encodeBasic(66, 10, 5))
      expect(e).toMatchObject({ type: "scroll", scroll: { direction: "left", delta: 1 } })
    })

    test("scroll right (67)", () => {
      const e = parser.parseMouseEvent(encodeBasic(67, 10, 5))
      expect(e).toMatchObject({ type: "scroll", scroll: { direction: "right", delta: 1 } })
    })

    test("scroll with shift modifier (68 = 64 + 4)", () => {
      const e = parser.parseMouseEvent(encodeBasic(68, 10, 5))
      expect(e).toMatchObject({
        type: "scroll",
        scroll: { direction: "up", delta: 1 },
        modifiers: { shift: true, alt: false, ctrl: false },
      })
    })
  })

  describe("modifiers", () => {
    test("shift (bit 2)", () => {
      const e = parser.parseMouseEvent(encodeBasic(4, 10, 5))!
      expect(e.modifiers).toEqual({ shift: true, alt: false, ctrl: false })
    })

    test("alt / meta (bit 3)", () => {
      const e = parser.parseMouseEvent(encodeBasic(8, 10, 5))!
      expect(e.modifiers).toEqual({ shift: false, alt: true, ctrl: false })
    })

    test("ctrl (bit 4)", () => {
      const e = parser.parseMouseEvent(encodeBasic(16, 10, 5))!
      expect(e.modifiers).toEqual({ shift: false, alt: false, ctrl: true })
    })

    test("all modifiers combined (4+8+16 = 28)", () => {
      const e = parser.parseMouseEvent(encodeBasic(28, 10, 5))!
      expect(e.modifiers).toEqual({ shift: true, alt: true, ctrl: true })
    })

    test("modifiers preserve button identity", () => {
      // right-click + ctrl = 2 + 16 = 18
      const e = parser.parseMouseEvent(encodeBasic(18, 10, 5))!
      expect(e.type).toBe("down")
      expect(e.button).toBe(2)
      expect(e.modifiers.ctrl).toBe(true)
    })
  })

  describe("motion detection", () => {
    test("move without button: byte 35 (32|3) → 'move', not 'up'", () => {
      const e = parser.parseMouseEvent(encodeBasic(35, 10, 5))!
      expect(e.type).toBe("move")
      expect(e.x).toBe(10)
      expect(e.y).toBe(5)
    })

    test("drag with left button: byte 32 (32|0) → not 'down'", () => {
      const e = parser.parseMouseEvent(encodeBasic(32, 10, 5))!
      expect(e.type).toBe("move") // parser says "move"; renderer promotes to "drag"
      expect(e.type).not.toBe("down")
    })

    test("drag with middle button: byte 33 (32|1) → not 'down'", () => {
      const e = parser.parseMouseEvent(encodeBasic(33, 10, 5))!
      expect(e.type).not.toBe("down")
    })

    test("drag with right button: byte 34 (32|2) → not 'down'", () => {
      const e = parser.parseMouseEvent(encodeBasic(34, 10, 5))!
      expect(e.type).not.toBe("down")
    })

    test("motion events are never classified as scroll", () => {
      for (const bb of [32, 33, 34, 35]) {
        const e = parser.parseMouseEvent(encodeBasic(bb, 10, 5))!
        expect(e.type).not.toBe("scroll")
      }
    })

    test("motion + shift modifier: byte 39 (32|3|4) → 'move'", () => {
      const e = parser.parseMouseEvent(encodeBasic(39, 10, 5))!
      expect(e.type).toBe("move")
      expect(e.modifiers.shift).toBe(true)
    })

    test("motion + ctrl: byte 51 (32|3|16) → 'move' with ctrl", () => {
      const e = parser.parseMouseEvent(encodeBasic(51, 10, 5))!
      expect(e.type).toBe("move")
      expect(e.modifiers.ctrl).toBe(true)
    })

    test("motion + all modifiers: byte 63 (32|3|4|8|16) → 'move'", () => {
      const e = parser.parseMouseEvent(encodeBasic(63, 10, 5))!
      expect(e.type).toBe("move")
      expect(e.modifiers).toEqual({ shift: true, alt: true, ctrl: true })
    })

    test("motion bit takes priority over scroll bit: byte 96 (64|32) → 'move'", () => {
      const e = parser.parseMouseEvent(encodeBasic(96, 10, 5))!
      expect(e.type).toBe("move")
    })

    test("release without motion bit is still 'up'", () => {
      const e = parser.parseMouseEvent(encodeBasic(3, 10, 5))!
      expect(e.type).toBe("up")
    })
  })

  describe("coordinates", () => {
    test("origin (0,0)", () => {
      const e = parser.parseMouseEvent(encodeBasic(0, 0, 0))!
      expect(e.x).toBe(0)
      expect(e.y).toBe(0)
    })

    test("typical coordinates", () => {
      const e = parser.parseMouseEvent(encodeBasic(0, 79, 23))!
      expect(e.x).toBe(79)
      expect(e.y).toBe(23)
    })

    test("maximum safe X10 coordinate (94) works correctly", () => {
      // x=94 → raw byte = 94 + 33 = 127 (0x7F), still valid single-byte in UTF-8
      const e = parser.parseMouseEvent(encodeBasic(0, 94, 94))!
      expect(e.x).toBe(94)
      expect(e.y).toBe(94)
    })

    test("coordinates >= 95 break under utf8 toString() (known limitation)", () => {
      // x=95 → raw byte = 95 + 33 = 128 (0x80), invalid as a standalone UTF-8 byte.
      //
      // The parser calls data.toString() which defaults to utf8, so charCodeAt()
      // on the decoded string will not equal the original byte value.
      //
      // This test documents the known limitation: the X10 parser is only reliable
      // for coordinates < 95 when input is decoded as UTF-8. SGR mode (1006)
      // avoids this entirely by using decimal numbers instead of raw bytes.
      const buf = encodeBasic(0, 95, 0)
      const viaUtf8 = buf.toString("utf8")
      const viaLatin1 = buf.toString("latin1")

      // The raw byte 0x80 is NOT valid single-byte UTF-8
      const utf8CharCode = viaUtf8.charCodeAt(4)
      const latin1CharCode = viaLatin1.charCodeAt(4)
      expect(latin1CharCode).toBe(128) // latin1 preserves the byte
      expect(utf8CharCode).not.toBe(128) // utf8 corrupts it
    })
  })

  describe("framing", () => {
    test("returns null for too-short buffer", () => {
      // Only 5 bytes instead of required 6
      const e = parser.parseMouseEvent(Buffer.from("\x1b[M\x20\x21"))
      expect(e).toBeNull()
    })

    test("returns null for unrelated escape sequence", () => {
      expect(parser.parseMouseEvent(Buffer.from("\x1b[A"))).toBeNull() // cursor up
      expect(parser.parseMouseEvent(Buffer.from("\x1b[1;2R"))).toBeNull() // cursor position report
    })

    test("returns null for empty buffer", () => {
      expect(parser.parseMouseEvent(Buffer.from(""))).toBeNull()
    })

    test("accepts Uint8Array input without Buffer conversion at callsite", () => {
      const encoded = encodeSGR(64, 10, 5, true)
      const view = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength)
      const e = parser.parseMouseEvent(view)
      expect(e).toMatchObject({ type: "scroll", scroll: { direction: "up", delta: 1 } })
    })
  })
})

describe("MouseParser SGR mode", () => {
  let parser: MouseParser

  beforeEach(() => {
    parser = new MouseParser()
  })

  describe("press and release", () => {
    test("left button press", () => {
      const e = parser.parseMouseEvent(encodeSGR(0, 10, 5, true))!
      expect(e).toMatchObject({ type: "down", button: 0, x: 10, y: 5 })
    })

    test("left button release", () => {
      const e = parser.parseMouseEvent(encodeSGR(0, 10, 5, false))!
      expect(e).toMatchObject({ type: "up", button: 0, x: 10, y: 5 })
    })

    test("middle button press", () => {
      const e = parser.parseMouseEvent(encodeSGR(1, 10, 5, true))!
      expect(e).toMatchObject({ type: "down", button: 1 })
    })

    test("right button press", () => {
      const e = parser.parseMouseEvent(encodeSGR(2, 10, 5, true))!
      expect(e).toMatchObject({ type: "down", button: 2 })
    })

    test("right button release", () => {
      const e = parser.parseMouseEvent(encodeSGR(2, 10, 5, false))!
      expect(e).toMatchObject({ type: "up", button: 2 })
    })
  })

  describe("scroll", () => {
    test("wheel up (64)", () => {
      const e = parser.parseMouseEvent(encodeSGR(64, 10, 5, true))!
      expect(e).toMatchObject({ type: "scroll", scroll: { direction: "up", delta: 1 } })
    })

    test("wheel down (65)", () => {
      const e = parser.parseMouseEvent(encodeSGR(65, 10, 5, true))!
      expect(e).toMatchObject({ type: "scroll", scroll: { direction: "down", delta: 1 } })
    })

    test("wheel left (66)", () => {
      const e = parser.parseMouseEvent(encodeSGR(66, 10, 5, true))!
      expect(e).toMatchObject({ type: "scroll", scroll: { direction: "left", delta: 1 } })
    })

    test("wheel right (67)", () => {
      const e = parser.parseMouseEvent(encodeSGR(67, 10, 5, true))!
      expect(e).toMatchObject({ type: "scroll", scroll: { direction: "right", delta: 1 } })
    })

    test("scroll+motion code 96 (64|32) is treated as move", () => {
      // Seen in URxvt: motion can arrive with both bits set while scrolling.
      const e = parser.parseMouseEvent(encodeSGR(96, 80, 66, true))!
      expect(e).toMatchObject({
        type: "move",
        x: 80,
        y: 66,
        scroll: undefined,
      })
    })

    test("scroll+motion code 97 (65|32) is treated as move", () => {
      const e = parser.parseMouseEvent(encodeSGR(97, 80, 66, true))!
      expect(e).toMatchObject({
        type: "move",
        x: 80,
        y: 66,
        scroll: undefined,
      })
    })

    test("scroll release (m) is not classified as scroll", () => {
      // Some terminals send release for scroll too; the parser should not
      // report that as a scroll event.
      const e = parser.parseMouseEvent(encodeSGR(64, 10, 5, false))!
      expect(e.type).not.toBe("scroll")
    })
  })

  describe("motion and drag", () => {
    test("move with no button: code 35 (32|3) → 'move'", () => {
      const e = parser.parseMouseEvent(encodeSGR(35, 10, 5, false))!
      expect(e.type).toBe("move")
    })

    test("drag with left button held: code 32 (32|0)", () => {
      // First press down to populate mouseButtonsPressed
      parser.parseMouseEvent(encodeSGR(0, 10, 5, true))
      const e = parser.parseMouseEvent(encodeSGR(32, 12, 5, false))!
      expect(e.type).toBe("drag")
    })

    test("motion without prior press is 'move' even when button bits != 3", () => {
      // No prior press → mouseButtonsPressed is empty → should be "move"
      const e = parser.parseMouseEvent(encodeSGR(32, 10, 5, false))!
      expect(e.type).toBe("move")
    })

    test("motion + button 3 is always 'move' even with buttons pressed", () => {
      parser.parseMouseEvent(encodeSGR(0, 10, 5, true))
      const e = parser.parseMouseEvent(encodeSGR(35, 12, 5, false))!
      expect(e.type).toBe("move")
    })
  })

  describe("modifiers", () => {
    test("shift (bit 2)", () => {
      const e = parser.parseMouseEvent(encodeSGR(4, 10, 5, true))!
      expect(e.modifiers).toEqual({ shift: true, alt: false, ctrl: false })
    })

    test("alt (bit 3)", () => {
      const e = parser.parseMouseEvent(encodeSGR(8, 10, 5, true))!
      expect(e.modifiers).toEqual({ shift: false, alt: true, ctrl: false })
    })

    test("ctrl (bit 4)", () => {
      const e = parser.parseMouseEvent(encodeSGR(16, 10, 5, true))!
      expect(e.modifiers).toEqual({ shift: false, alt: false, ctrl: true })
    })

    test("all modifiers (28 = 4+8+16)", () => {
      const e = parser.parseMouseEvent(encodeSGR(28, 10, 5, true))!
      expect(e.modifiers).toEqual({ shift: true, alt: true, ctrl: true })
    })
  })

  describe("button tracking state (mouseButtonsPressed)", () => {
    test("press adds to tracked set, release clears it", () => {
      // Press left → drag should be recognized
      parser.parseMouseEvent(encodeSGR(0, 5, 5, true))
      const drag = parser.parseMouseEvent(encodeSGR(32, 8, 5, false))!
      expect(drag.type).toBe("drag")

      // Release → subsequent motion should be "move"
      parser.parseMouseEvent(encodeSGR(0, 8, 5, false))
      const move = parser.parseMouseEvent(encodeSGR(35, 10, 5, false))!
      expect(move.type).toBe("move")
    })

    test("multiple buttons pressed — any motion is drag", () => {
      parser.parseMouseEvent(encodeSGR(0, 5, 5, true)) // left down
      parser.parseMouseEvent(encodeSGR(2, 5, 5, true)) // right down
      const e = parser.parseMouseEvent(encodeSGR(32, 8, 5, false))!
      expect(e.type).toBe("drag")
    })

    test("release clears ALL tracked buttons", () => {
      parser.parseMouseEvent(encodeSGR(0, 5, 5, true)) // left down
      parser.parseMouseEvent(encodeSGR(2, 5, 5, true)) // right down
      parser.parseMouseEvent(encodeSGR(0, 5, 5, false)) // release (clears all)
      const e = parser.parseMouseEvent(encodeSGR(32, 8, 5, false))!
      expect(e.type).toBe("move") // no buttons tracked → move, not drag
    })

    test("reset() clears button tracking state", () => {
      parser.parseMouseEvent(encodeSGR(0, 5, 5, true)) // left down
      parser.reset()
      const e = parser.parseMouseEvent(encodeSGR(32, 8, 5, false))!
      expect(e.type).toBe("move")
    })
  })

  describe("coordinates", () => {
    test("origin (0,0) from 1-based wire format", () => {
      const e = parser.parseMouseEvent(encodeSGR(0, 0, 0, true))!
      expect(e.x).toBe(0)
      expect(e.y).toBe(0)
    })

    test("large coordinates (SGR uses decimal, no 223 limit)", () => {
      const e = parser.parseMouseEvent(encodeSGR(0, 500, 300, true))!
      expect(e.x).toBe(500)
      expect(e.y).toBe(300)
    })
  })

  describe("framing", () => {
    test("returns null for incomplete SGR sequence", () => {
      expect(parser.parseMouseEvent(Buffer.from("\x1b[<0;1;1"))).toBeNull()
    })

    test("returns null for empty buffer", () => {
      expect(parser.parseMouseEvent(Buffer.from(""))).toBeNull()
    })
  })
})

describe("MouseParser parseAllMouseEvents (multi-event chunks)", () => {
  let parser: MouseParser

  beforeEach(() => {
    parser = new MouseParser()
  })

  test("single event returns array of one", () => {
    const events = parser.parseAllMouseEvents(encodeSGR(0, 10, 5, true))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "down", button: 0, x: 10, y: 5 })
  })

  test("two SGR events concatenated are both parsed", () => {
    const buf = Buffer.concat([encodeSGR(32, 69, 49, true), encodeSGR(32, 68, 49, true)])
    const events = parser.parseAllMouseEvents(buf)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: "move", x: 69, y: 49 })
    expect(events[1]).toMatchObject({ type: "move", x: 68, y: 49 })
  })

  test("four SGR motion events (matching mouse.log line 2)", () => {
    const buf = Buffer.concat([
      encodeSGR(32, 69, 49, true),
      encodeSGR(32, 68, 49, true),
      encodeSGR(32, 68, 48, true),
      encodeSGR(32, 67, 48, true),
    ])
    const events = parser.parseAllMouseEvents(buf)
    expect(events).toHaveLength(4)
    expect(events[0]).toMatchObject({ x: 69, y: 49 })
    expect(events[1]).toMatchObject({ x: 68, y: 49 })
    expect(events[2]).toMatchObject({ x: 68, y: 48 })
    expect(events[3]).toMatchObject({ x: 67, y: 48 })
  })

  test("mixed event types: press + motion + release", () => {
    const buf = Buffer.concat([
      encodeSGR(0, 10, 10, true), // left down
      encodeSGR(32, 12, 10, true), // motion (drag, since button is pressed)
      encodeSGR(0, 12, 10, false), // left up
    ])
    const events = parser.parseAllMouseEvents(buf)
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ type: "down", button: 0 })
    expect(events[1]).toMatchObject({ type: "drag" })
    expect(events[2]).toMatchObject({ type: "up", button: 0 })
  })

  test("scroll events in a chunk", () => {
    const buf = Buffer.concat([encodeSGR(64, 82, 67, true), encodeSGR(64, 82, 67, true), encodeSGR(65, 82, 67, true)])
    const events = parser.parseAllMouseEvents(buf)
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ type: "scroll", scroll: { direction: "up" } })
    expect(events[1]).toMatchObject({ type: "scroll", scroll: { direction: "up" } })
    expect(events[2]).toMatchObject({ type: "scroll", scroll: { direction: "down" } })
  })

  test("chunk with scroll+motion codes (96/97) keeps motion semantics", () => {
    const buf = Buffer.concat([encodeSGR(64, 82, 67, true), encodeSGR(96, 81, 67, true), encodeSGR(97, 80, 67, true)])
    const events = parser.parseAllMouseEvents(buf)
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ type: "scroll", scroll: { direction: "up" } })
    expect(events[1]).toMatchObject({ type: "move", x: 81, y: 67, scroll: undefined })
    expect(events[2]).toMatchObject({ type: "move", x: 80, y: 67, scroll: undefined })
  })

  test("returns empty array for non-mouse data", () => {
    const events = parser.parseAllMouseEvents(Buffer.from("\x1b[A"))
    expect(events).toHaveLength(0)
  })

  test("returns empty array for empty buffer", () => {
    const events = parser.parseAllMouseEvents(Buffer.from(""))
    expect(events).toHaveLength(0)
  })

  test("two X10 basic events concatenated", () => {
    const buf = Buffer.concat([encodeBasic(0, 10, 5), encodeBasic(3, 10, 5)])
    const events = parser.parseAllMouseEvents(buf)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: "down", button: 0, x: 10, y: 5 })
    expect(events[1]).toMatchObject({ type: "up", x: 10, y: 5 })
  })

  test("button tracking state is maintained across events in chunk", () => {
    // down + motion in same chunk: second event should be classified as drag
    const buf = Buffer.concat([
      encodeSGR(0, 5, 5, true), // press
      encodeSGR(32, 8, 5, true), // motion with button 0 bits → drag if button tracked
    ])
    const events = parser.parseAllMouseEvents(buf)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: "down" })
    expect(events[1]).toMatchObject({ type: "drag" })
  })
})

describe("MouseParser protocol precedence", () => {
  let parser: MouseParser

  beforeEach(() => {
    parser = new MouseParser()
  })

  test("SGR is matched before X10 when both could apply", () => {
    // An SGR sequence that starts with ESC[ but has < distinguishes it from X10.
    const sgr = encodeSGR(0, 10, 5, true)
    const e = parser.parseMouseEvent(sgr)!
    expect(e.type).toBe("down")
    expect(e.x).toBe(10)
    expect(e.y).toBe(5)
  })

  test("X10 is used as fallback when data has no < prefix", () => {
    const x10 = encodeBasic(0, 10, 5)
    const e = parser.parseMouseEvent(x10)!
    expect(e.type).toBe("down")
    expect(e.x).toBe(10)
    expect(e.y).toBe(5)
  })
})
