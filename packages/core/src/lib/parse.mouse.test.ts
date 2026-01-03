import { describe, expect, it, beforeEach } from "bun:test"
import { MouseParser } from "./parse.mouse"

describe("MouseParser", () => {
  let parser: MouseParser

  beforeEach(() => {
    parser = new MouseParser()
  })

  describe("parseMouseEvent (backward compatibility)", () => {
    it("should parse SGR mouse down event", () => {
      const data = Buffer.from("\x1b[<0;10;20M")
      const event = parser.parseMouseEvent(data)

      expect(event).not.toBeNull()
      expect(event!.type).toBe("down")
      expect(event!.button).toBe(0)
      expect(event!.x).toBe(9)
      expect(event!.y).toBe(19)
    })

    it("should parse SGR mouse up event", () => {
      const data = Buffer.from("\x1b[<0;10;20m")
      const event = parser.parseMouseEvent(data)

      expect(event).not.toBeNull()
      expect(event!.type).toBe("up")
    })

    it("should return null for non-mouse data", () => {
      const data = Buffer.from("hello")
      const event = parser.parseMouseEvent(data)

      expect(event).toBeNull()
    })
  })

  describe("parseMouseEventWithConsumed", () => {
    it("should return consumed byte count for SGR mouse event", () => {
      const data = Buffer.from("\x1b[<0;10;20M")
      const result = parser.parseMouseEventWithConsumed(data)

      expect(result).not.toBeNull()
      expect(result!.event.type).toBe("down")
      expect(result!.consumed).toBe(11) // \x1b[<0;10;20M is 11 bytes
    })

    it("should return consumed byte count for basic mouse event", () => {
      // Basic mouse mode: \x1b[M followed by 3 bytes (button+32, x+33, y+33)
      // Button 0 + 32 = 32 (space), x=1 + 33 = 34 ("), y=1 + 33 = 34 (")
      const data = Buffer.from('\x1b[M ""')
      const result = parser.parseMouseEventWithConsumed(data)

      expect(result).not.toBeNull()
      expect(result!.consumed).toBe(6)
    })

    it("should only match mouse event at start of buffer", () => {
      // Data with non-mouse prefix followed by mouse event
      const data = Buffer.from("prefix\x1b[<0;10;20M")
      const result = parser.parseMouseEventWithConsumed(data)

      // Should NOT match because mouse event is not at the start
      expect(result).toBeNull()
    })

    it("should handle combined mouse event and paste sequence (Alacritty-style)", () => {
      // This simulates Alacritty's drag-drop behavior:
      // Mouse motion event + bracketed paste in a single chunk
      // Button 35 = 32 (motion) + 3 (no button) = move event
      const mouseSeq = "\x1b[<35;37;18M"
      const pasteSeq = "\x1b[200~/home/user/file.jpg \x1b[201~"
      const combined = Buffer.from(mouseSeq + pasteSeq)

      const result = parser.parseMouseEventWithConsumed(combined)

      expect(result).not.toBeNull()
      expect(result!.event.type).toBe("move")
      expect(result!.consumed).toBe(Buffer.byteLength(mouseSeq))

      // Verify remaining data contains the paste sequence
      const remaining = combined.slice(result!.consumed)
      expect(remaining.toString()).toBe(pasteSeq)
    })

    it("should correctly calculate consumed bytes for varying coordinate lengths", () => {
      // Single digit coordinates: \x1b[<0;1;1M = 9 bytes
      const data1 = Buffer.from("\x1b[<0;1;1M")
      const result1 = parser.parseMouseEventWithConsumed(data1)
      expect(result1!.consumed).toBe(9)

      // Double digit coordinates: \x1b[<0;10;20M = 11 bytes
      const data2 = Buffer.from("\x1b[<0;10;20M")
      const result2 = parser.parseMouseEventWithConsumed(data2)
      expect(result2!.consumed).toBe(11)

      // Triple digit coordinates: \x1b[<0;100;200M = 13 bytes
      const data3 = Buffer.from("\x1b[<0;100;200M")
      const result3 = parser.parseMouseEventWithConsumed(data3)
      expect(result3!.consumed).toBe(13)
    })

    it("should parse scroll events correctly", () => {
      // Scroll up: button code 64 (scroll bit) + 0 (up direction) = 64
      const data = Buffer.from("\x1b[<64;10;20M")
      const result = parser.parseMouseEventWithConsumed(data)

      expect(result).not.toBeNull()
      expect(result!.event.type).toBe("scroll")
      expect(result!.event.scroll?.direction).toBe("up")
    })

    it("should parse motion events correctly", () => {
      // Motion: button code 32 (motion bit) + 3 (no button) = 35
      const data = Buffer.from("\x1b[<35;10;20M")
      const result = parser.parseMouseEventWithConsumed(data)

      expect(result).not.toBeNull()
      expect(result!.event.type).toBe("move")
    })

    it("should parse modifier keys correctly", () => {
      // Shift (4) + button 0 = 4
      const shiftClick = Buffer.from("\x1b[<4;10;20M")
      const shiftResult = parser.parseMouseEventWithConsumed(shiftClick)
      expect(shiftResult!.event.modifiers.shift).toBe(true)
      expect(shiftResult!.event.modifiers.alt).toBe(false)
      expect(shiftResult!.event.modifiers.ctrl).toBe(false)

      // Alt (8) + button 0 = 8
      const altClick = Buffer.from("\x1b[<8;10;20M")
      const altResult = parser.parseMouseEventWithConsumed(altClick)
      expect(altResult!.event.modifiers.alt).toBe(true)

      // Ctrl (16) + button 0 = 16
      const ctrlClick = Buffer.from("\x1b[<16;10;20M")
      const ctrlResult = parser.parseMouseEventWithConsumed(ctrlClick)
      expect(ctrlResult!.event.modifiers.ctrl).toBe(true)
    })
  })
})
