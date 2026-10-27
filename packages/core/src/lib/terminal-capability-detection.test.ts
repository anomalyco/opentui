import { test, expect, describe } from "bun:test"
import {
  isCapabilityResponse,
  isExplicitWidthReport,
  isPixelResolutionResponse,
  parsePixelResolution,
} from "./terminal-capability-detection.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"

describe("isCapabilityResponse", () => {
  test("detects DECRPM responses", () => {
    expect(isCapabilityResponse("\x1b[?1016;2$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?2027;0$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?2031;2$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?1004;1$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?2026;2$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?2004;2$y")).toBe(true)
  })

  test("detects explicit-width reports only among cursor position reports", () => {
    // Shift, Alt and Ctrl+F3 send the same bytes, so the key path never treats them as replies.
    expect(isCapabilityResponse("\x1b[1;2R")).toBe(false)
    expect(isExplicitWidthReport("\x1b[1;2R")).toBe(true) // explicit width
    expect(isExplicitWidthReport("\x1b[1;3R")).toBe(true) // scaled text
    expect(isExplicitWidthReport("\x1b[1;1R")).toBe(false)
    expect(isExplicitWidthReport("\x1b[10;5R")).toBe(false)
    expect(isCapabilityResponse("\x1b[20;30R")).toBe(false)
  })

  test("detects XTVersion responses", () => {
    expect(isCapabilityResponse("\x1bP>|kitty(0.40.1)\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1bP>|ghostty 1.1.3\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1bP>|tmux 3.5a\x1b\\")).toBe(true)
  })

  test("detects XTGETTCAP Ms responses", () => {
    expect(isCapabilityResponse("\x1bP1+r4d73=2570312573\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1bP1+r4d73\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1bP1+r4d73=\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1bP0+r\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1bP0+r4D73\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1bP1+r544e=787465726d\x1b\\")).toBe(false)
    expect(isCapabilityResponse("\x1bP1+r4d73=abc\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1bP1+r4d73=zz\x1b\\")).toBe(true)
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

  test("detects program status query responses", () => {
    expect(isCapabilityResponse("\x1b]7501;?\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1b]7501;?:states=idle,working:kinds=auth\x07")).toBe(true)
    expect(isCapabilityResponse("\x1b]7501; ? : states=idle\x1b\\")).toBe(true)
    expect(isCapabilityResponse("\x1b]7501;state=idle\x1b\\")).toBe(false)
    expect(isCapabilityResponse("\x1b]75010;?\x1b\\")).toBe(false)
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
    expect(parsePixelResolution("\x1b[4;4294967295;4294967295t")).toBeNull()
    expect(parsePixelResolution(`\x1b[4;${"9".repeat(400)};80t`)).toBeNull()
  })
})

describe("real-world terminal capability sequences", () => {
  test("kitty terminal full response - individual sequences", () => {
    // Should detect multiple capability sequences
    expect(isCapabilityResponse("\x1b[?1016;2$y")).toBe(true)
    expect(isCapabilityResponse("\x1b[?2027;0$y")).toBe(true)
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
  // Replies come whenever the terminal sends them: screen, tmux passthrough and ConPTY forward some after their own
  // DA1, and a slow link after the 5 s startup window. Each one is applied, and an event comes only on a change.
  const replies = [
    "\x1b[?62;22c", // DA1 first, as a hop that answers it itself
    "\x1b[?1016;2$y",
    "\x1b[?2027;0$y",
    "\x1b[?2031;2$y",
    "\x1b[?1004;2$y",
    "\x1b[?2004;2$y",
    "\x1b[?2026;2$y",
    "\x1bP>|kitty(0.42.2)\x1b\\",
    "\x1b[?0u",
    "\x1b_Gi=31337;OK\x1b\\",
  ]

  async function run(experimental_nativeInput: boolean, lateMs: number) {
    const clock = new ManualClock()
    const { renderer } = await createTestRenderer({ clock, experimental_nativeInput })
    const events: string[] = []
    const keys: string[] = []
    let renders = 0
    const requestRender = renderer.requestRender.bind(renderer)
    renderer.requestRender = () => {
      renders++
      requestRender()
    }
    renderer.on("capabilities", (caps) => events.push(JSON.stringify(caps)))
    renderer.keyInput.on("keypress", (key) => keys.push(key.sequence))
    await renderer.setupTerminal()
    renderer.stdin.emit("data", Buffer.from("\x1b[4;600;800t"))
    clock.advance(lateMs)
    // Modified F3 is a key once no explicit-width report is expected (the legacy parser reads it as a report).
    if (lateMs > 0 && experimental_nativeInput) renderer.stdin.emit("data", Buffer.from("\x1b[1;2R\x1b[1;5R"))
    const marks: number[][] = []
    const send = (batch: string[]) => {
      for (const reply of batch) {
        renderer.stdin.emit("data", Buffer.from(`${reply}a`))
        clock.advance(20)
      }
      marks.push([events.length, renders])
    }
    send(replies)
    send(replies)
    // The handler outlives suspension, and a return to an earlier value is a change.
    await renderer.suspend()
    await renderer.resume()
    send([])
    send(["\x1bP>|beta(1)\x1b\\", replies[7]])
    const caps = renderer.capabilities!
    renderer.destroy()
    return { marks, events, keys, caps }
  }

  for (const experimental_nativeInput of [false, true]) {
    test(`replies after the startup window emit what replies inside it emit (native ${experimental_nativeInput})`, async () => {
      const inside = await run(experimental_nativeInput, 0)
      const late = await run(experimental_nativeInput, 5000)

      expect(late.events).toEqual(inside.events)
      for (const { marks, events } of [inside, late]) {
        expect(marks[0][0]).toBeGreaterThan(0)
        expect(marks[1]).toEqual(marks[0])
        expect([marks[3][0] - marks[2][0], marks[3][1] - marks[2][1]]).toEqual([2, 2])
        expect(events.at(-1)).toBe(events.at(-3))
        expect(events.filter((event, index) => event === events[index - 1])).toEqual([])
      }
      expect(late.caps).toMatchObject({ kitty_keyboard: true, kitty_graphics: true, sgr_pixels: true, sync: true })
      expect(late.caps.terminal).toEqual({ name: "kitty", version: "0.42.2", from_xtversion: true })
      const typed = Array(replies.length * 2 + 2).fill("a")
      expect(inside.keys).toEqual(typed)
      expect(late.keys).toEqual(experimental_nativeInput ? ["\x1b[1;2R", "\x1b[1;5R", ...typed] : typed)
    })
  }
})
