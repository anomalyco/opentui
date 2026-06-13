import { test, expect, describe } from "bun:test"
import {
  isCapabilityResponse,
  isPixelResolutionResponse,
  parsePixelResolution,
} from "./terminal-capability-detection.js"

describe("isCapabilityResponse", () => {
  test("detects DECRPM responses", () => {
    expect(isCapabilityResponse("\x1b[?1016;2$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?2027;0$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?2031;2$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?1004;1$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?2026;2$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?2004;2$y")).toBe(true)
  })

  test("detects CPR responses for width detection", () => {
    expect(isCapabilityResponse("\x1b[1;2R")).toBe(true) // explicit width
    expect(isCapabilityResponse("\x1b[1;3R")).toBe(true) // scaled text
  })

  test("does not detect regular CPR responses as capabilities", () => {
    // Regular cursor position reports are NOT capabilities
    expect(isCapabilityResponse("\x1b[10;5R")).toBe(false)
    expect(isCapabilityResponse("\x1b[20;30R")).toBe(false)
  })

  test("detects XTVersion responses", () => {
    expect(isCapabilityResponse("\x1bP>|kitty(0.40.1)\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1bP>|ghostty 1.1.3\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1bP>|tmux 3.5a\x1b\\")).toBe(true)
  })

  test("detects Kitty graphics responses", () => {
    expect(isCapabilityResponse("\x1b_Gi=1;OK\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1b_Gi=1;EINVAL:Zero width/height not allowed\x1b\\")).toBe(true)
  })

  test("detects DA1 (Device Attributes) responses", () => {
    expect(isCapabilityResponse("\x1b[?62;c")).toBe(true)
    expect(isCapabilityResponse("\x1b[?62;22c")).toBe(true)
    expect(isCapabilityResponse("\x1b[?1;2;4c")).toBe(true)
    expect(isCapabilityResponse("\x1b[?6c")).toBe(true)
  })

  test("detects Kitty keyboard query responses", () => {
    expect(isCapabilityResponse("\x1b[?0u")).toBe(true)
    expect(isCapabilityResponse("\x1b[?1u")).toBe(true)
    expect(isCapabilityResponse("\x1b[?31u")).toBe(true)
  })

  test("detects notification capability responses", () => {
    expect(isCapabilityResponse("\x1b]99;i=opentui-notifications:p=?;p=title,body\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1b]99;i=opentui-notifications:p=?;p=title,body\x07")).toBe(true)
    expect(isCapabilityResponse("\x1b]1337;Capabilities=T2NoH\x1b\\")).toBe(true)
  })

  test("does not detect regular keypresses", () => {
    expect(isCapabilityResponse("a")).toBe(false)
    expect(isCapabilityResponse("A")).toBe(false)
    expect(isCapabilityResponse("\x1b")).toBe(false)
    expect(isCapabilityResponse("\x1ba")).toBe(false)
  })

  test("does not detect arrow keys", () => {
    expect(isCapabilityResponse("\x1b[A")).toBe(false)
    expect(isCapabilityResponse("\x1b[B")).toBe(false)
    expect(isCapabilityResponse("\x1b[C")).toBe(false)
    expect(isCapabilityResponse("\x1b[D")).toBe(false)
  })

  test("does not detect function keys", () => {
    expect(isCapabilityResponse("\x1bOP")).toBe(false)
    expect(isCapabilityResponse("\x1b[11~")).toBe(false)
    expect(isCapabilityResponse("\x1b[24~")).toBe(false)
  })

  test("does not detect modified arrow keys", () => {
    expect(isCapabilityResponse("\x1b[1;2A")).toBe(false)
    expect(isCapabilityResponse("\x1b[1;5C")).toBe(false)
  })

  test("does not detect mouse sequences", () => {
    expect(isCapabilityResponse("\x1b[<35;20;5m")).toBe(false)
    expect(isCapabilityResponse("\x1b[<0;10;10M")).toBe(false)
  })

  test("does not detect arbitrary OSC sequences as capabilities", () => {
    expect(isCapabilityResponse("\x1b]9;hello\x1b\\")).toBe(false)
    expect(isCapabilityResponse("\x1b]777;notify;title;body\x1b\\")).toBe(false)
    expect(isCapabilityResponse("\x1b]99;i=other:p=?;p=title\x1b\\")).toBe(false)
  })
})

describe("isPixelResolutionResponse", () => {
  test("detects pixel resolution responses", () => {
    expect(isPixelResolutionResponse("\x1b[4;720;1280t")).toBe(true)
    expect(isPixelResolutionResponse("\x1b[4;1080;1920t")).toBe(true)
    expect(isPixelResolutionResponse("\x1b[4;0;0t")).toBe(true)
  })

  test("does not detect other sequences", () => {
    expect(isPixelResolutionResponse("a")).toBe(false)
    expect(isPixelResolutionResponse("\x1b[A")).toBe(false)
    expect(isPixelResolutionResponse("\x1b[?1016;2$y")).toBe(false)
  })
})

describe("parsePixelResolution", () => {
  test("parses valid pixel resolution responses", () => {
    expect(parsePixelResolution("\x1b[4;720;1280t")).toEqual({ width: 1280, height: 720 })
    expect(parsePixelResolution("\x1b[4;1080;1920t")).toEqual({ width: 1920, height: 1080 })
    expect(parsePixelResolution("\x1b[4;0;0t")).toEqual({ width: 0, height: 0 })
  })

  test("returns null for invalid sequences", () => {
    expect(parsePixelResolution("a")).toBeNull()
    expect(parsePixelResolution("\x1b[A")).toBeNull()
    expect(parsePixelResolution("\x1b[?1016;2$y")).toBeNull()
  })
})

describe("real-world terminal capability sequences", () => {
  test("kitty terminal full response - individual sequences", () => {
    // Should detect multiple capability sequences
    expect(isCapabilityResponse("\x1b[?1016;2$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?2027;0$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[1;2R")).toBe(true)
    expect(isCapabilityResponse("\x1b[1;3R")).toBe(true)
    expect(isCapabilityResponse("\x1bP>|kitty(0.40.1)\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1b_Gi=1;EINVAL:Zero width/height not allowed\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1b[?62;c")).toBe(true)
  })

  test("ghostty terminal response - individual sequences", () => {
    expect(isCapabilityResponse("\x1bP>|ghostty 1.1.3\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1b_Gi=1;OK\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1b[?62;22c")).toBe(true)
  })

  test("alacritty terminal response - individual sequences", () => {
    expect(isCapabilityResponse("\x1b[?1016;0$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?6c")).toBe(true)
  })

  test("vscode terminal minimal response", () => {
    expect(isCapabilityResponse("\x1b[?1016;2$y")).toBe(true)
  })
})

describe("renderer capabilities event", () => {
  /**
   * The renderer emits "capabilities" event each time a capability response is processed.
   * This happens multiple times at startup because the terminal responds to multiple queries:
   * - DECRPM queries (sgr_pixels, unicode, color_scheme, focus, bracketed_paste, sync)
   * - CPR queries for width detection (explicit_width, scaled_text)
   * - XTVersion (terminal name/version, kitty detection)
   * - Kitty keyboard query response
   *
   * Each response arrives async and triggers the event, so consumers should expect
   * multiple emissions and handle them reactively.
   */
  test("kitty terminal emits capabilities event for each response", async () => {
    const { createTestRenderer } = await import("../testing/test-renderer.js")
    const { renderer } = await createTestRenderer({})

    const events: any[] = []
    renderer.on("capabilities", (caps) => events.push({ ...caps }))

    // Simulate all 10 Kitty capability responses (as they arrive separately)
    const kittyResponses = [
      "\x1b[?1016;2$y", // 1. sgr_pixels
      "\x1b[?2027;0$y", // 2. unicode query
      "\x1b[?2031;2$y", // 3. color_scheme_updates
      "\x1b[?1004;2$y", // 4. focus_tracking
      "\x1b[?2004;2$y", // 5. bracketed_paste
      "\x1b[?2026;2$y", // 6. sync
      "\x1b[1;2R", // 7. explicit_width (CPR)
      "\x1b[1;3R", // 8. scaled_text (CPR)
      "\x1bP>|kitty(0.42.2)\x1b\\", // 9. xtversion (triggers kitty detection)
      "\x1b[?0u", // 10. kitty keyboard query
    ]

    for (const response of kittyResponses) {
      renderer.stdin.emit("data", Buffer.from(response))
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    // Should have received 10 capability events
    expect(events.length).toBe(10)

    // First event: sgr_pixels detected
    expect(events[0].sgr_pixels).toBe(true)

    // After xtversion (event 9): kitty_keyboard should be true
    expect(events[8].kitty_keyboard).toBe(true)
    expect(events[8].kitty_graphics).toBe(true)
    expect(events[8].notifications).toBe(true)
    expect(events[8].terminal.name).toBe("kitty")
    expect(events[8].terminal.version).toBe("0.42.2")

    // Final state should have all kitty capabilities
    const finalCaps = events[9]
    expect(finalCaps.kitty_keyboard).toBe(true)
    expect(finalCaps.sgr_pixels).toBe(true)
    expect(finalCaps.color_scheme_updates).toBe(true)
    expect(finalCaps.focus_tracking).toBe(true)
    expect(finalCaps.sync).toBe(true)
    expect(finalCaps.explicit_width).toBe(true)
    expect(finalCaps.scaled_text).toBe(true)

    renderer.destroy()
  })
})
