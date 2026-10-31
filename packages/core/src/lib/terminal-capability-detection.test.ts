import { test, expect, describe } from "bun:test"
import {
  isCapabilityResponse,
  isExplicitWidthReport,
  isPixelResolutionResponse,
  parsePixelResolution,
} from "./terminal-capability-detection.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { Writable } from "node:stream"
import { resolveRenderLib, type SynchronizedOutput } from "../zig.js"
import type { CliRendererConfig } from "../renderer.js"

describe("capability reply classification", () => {
  // Shift, Alt and Ctrl+F3 send the same bytes as an explicit-width report, so the key path never treats them as
  // replies. Regular keys, arrows, function keys, mouse reports and other OSC sequences are not replies either.
  const capabilities: [string, boolean][] = [
    ["\x1b[?1016;2$y", true],
    ["\x1b[?2027;0$y", true],
    ["\x1b[?2031;2$y", true],
    ["\x1b[?1004;1$y", true],
    ["\x1b[?2026;2$y", true],
    ["\x1b[?2004;2$y", true],
    ["\x1b[1;2R", false],
    ["\x1b[20;30R", false],
    ["\x1bP>|kitty(0.40.1)\x1b\\", true],
    ["\x1bP>|ghostty 1.1.3\x1b\\", true],
    ["\x1bP>|tmux 3.5a\x1b\\", true],
    ["\x1bP1+r4d73=2570312573\x1b\\", true],
    ["\x1bP1+r4d73\x1b\\", true],
    ["\x1bP1+r4d73=\x1b\\", true],
    ["\x1bP0+r\x1b\\", true],
    ["\x1bP0+r4D73\x1b\\", true],
    ["\x1bP1+r544e=787465726d\x1b\\", false],
    ["\x1bP1+r4d73=abc\x1b\\", true],
    ["\x1bP1+r4d73=zz\x1b\\", true],
    ["\x1b_Gi=1;OK\x1b\\", true],
    ["\x1b_Gi=1;EINVAL:Zero width/height not allowed\x1b\\", true],
    ["\x1b[?62;c", true],
    ["\x1b[?62;22c", true],
    ["\x1b[?1;2;4c", true],
    ["\x1b[?6c", true],
    ["\x1b[?0u", true],
    ["\x1b[?1u", true],
    ["\x1b[?31u", true],
    ["\x1b]99;i=opentui-notifications:p=?;p=title,body\x1b\\", true],
    ["\x1b]99;i=opentui-notifications:p=?;p=title,body\x07", true],
    ["\x1b]1337;Capabilities=T2NoH\x1b\\", true],
    ["\x1b]7501;?\x1b\\", true],
    ["\x1b]7501;?:states=idle,working:kinds=auth\x07", true],
    ["\x1b]7501; ? : states=idle\x1b\\", true],
    ["\x1b]7501;state=idle\x1b\\", false],
    ["\x1b]75010;?\x1b\\", false],
    ["a", false],
    ["A", false],
    ["\x1b", false],
    ["\x1ba", false],
    ["\x1b[A", false],
    ["\x1b[B", false],
    ["\x1b[C", false],
    ["\x1b[D", false],
    ["\x1bOP", false],
    ["\x1b[11~", false],
    ["\x1b[24~", false],
    ["\x1b[1;2A", false],
    ["\x1b[1;5C", false],
    ["\x1b[<35;20;5m", false],
    ["\x1b[<0;10;10M", false],
    ["\x1b]9;hello\x1b\\", false],
    ["\x1b]777;notify;title;body\x1b\\", false],
    ["\x1b]99;i=other:p=?;p=title\x1b\\", false],
    ["\x1b[?1016;0$y", true],
  ]
  const explicitWidth: [string, boolean][] = [
    ["\x1b[1;2R", true],
    ["\x1b[1;3R", true],
    ["\x1b[1;1R", false],
    ["\x1b[10;5R", false],
  ]
  const pixelResolution: [string, boolean][] = [
    ["\x1b[4;720;1280t", true],
    ["\x1b[4;1080;1920t", true],
    ["\x1b[4;0;0t", true],
    ["a", false],
    ["\x1b[A", false],
    ["\x1b[?1016;2$y", false],
  ]
  const parsed: [string, { width: number; height: number } | null][] = [
    ["\x1b[4;720;1280t", { width: 1280, height: 720 }],
    ["\x1b[4;1080;1920t", { width: 1920, height: 1080 }],
    ["\x1b[4;0;0t", { width: 0, height: 0 }],
    ["a", null],
    ["\x1b[A", null],
    ["\x1b[?1016;2$y", null],
    ["\x1b[4;4294967295;4294967295t", null],
    [`\x1b[4;${"9".repeat(400)};80t`, null],
  ]

  test("classifies every sequence", () => {
    expect(capabilities.map(([sequence]) => [sequence, isCapabilityResponse(sequence)])).toEqual(capabilities)
    expect(explicitWidth.map(([sequence]) => [sequence, isExplicitWidthReport(sequence)])).toEqual(explicitWidth)
    expect(pixelResolution.map(([sequence]) => [sequence, isPixelResolutionResponse(sequence)])).toEqual(
      pixelResolution,
    )
    expect(parsed.map(([sequence]) => [sequence, parsePixelResolution(sequence)])).toEqual(parsed)
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

describe("synchronized output", () => {
  // Replies come in query order: the startup cursor report, DECRQM 2026, the width probe's report, then DA1.
  async function frame(config: Partial<CliRendererConfig>, reported: boolean, lateMs = 0, host = false) {
    let output = ""
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += Buffer.from(chunk).toString()
        callback()
      },
    }) as NodeJS.WriteStream
    const clock = new ManualClock()
    const { renderer, renderOnce } = await createTestRenderer({
      width: 4,
      height: 2,
      stdout,
      bufferedOutput: "stdout",
      clock,
      ...config,
    })
    try {
      // A pending setup keeps its first options, so this one carries the host flag through the binding.
      if (host) void renderer.nativeScene!.driver.setupTerminal({ hostMultiplexer: host })
      await renderer.setupTerminal()
      clock.advance(lateMs)
      for (const reply of ["\x1b[3;1R", ...(reported ? ["\x1b[?2026;2$y"] : []), "\x1b[1;1R", "\x1b[?62;22c"]) {
        renderer.stdin.emit("data", Buffer.from(reply))
      }
      await renderer.nativeScene!.driver.idle()
      output = ""
      await renderOnce()
      return output
    } finally {
      renderer.destroy()
    }
  }

  // The native table covers every combination; these rows cover the option, the reply routing, and the host's
  // multiplexer: a custom stdout never passes through the TMUX in process.env, and a client's TMUX never counts.
  const client = { remote: true, environment: { TMUX: "/tmp/laptop,1,0" } }
  // [config, 2026 reported, envelope, lateMs, host multiplexer]
  const rows: [Partial<CliRendererConfig>, boolean, boolean, number?, boolean?][] = [
    [{ remote: true }, false, false],
    [client, true, true],
    [{ remote: true, synchronizedOutput: "always" }, false, true],
    [{ remote: false, synchronizedOutput: "never" }, true, false],
    [{ remote: true, experimental_nativeInput: false }, false, false, 5100],
    [{ remote: true, experimental_nativeInput: true }, false, false, 5100],
    [{ remote: true }, true, false, 0, true],
  ]
  test("frames carry the envelope by option, reply and host", async () => {
    const tmux = process.env.TMUX
    process.env.TMUX = "/tmp/host,1,0"
    try {
      for (const [config, reported, envelope, lateMs, host] of rows) {
        const output = await frame(config, reported, lateMs, host)
        expect(output.length).toBeGreaterThan(0)
        const seen = [output.startsWith("\x1b[?2026h"), output.includes("\x1b[?2026l")]
        expect([JSON.stringify(config), lateMs, seen]).toEqual([JSON.stringify(config), lateMs, [envelope, envelope]])
      }
    } finally {
      if (tmux === undefined) delete process.env.TMUX
      else process.env.TMUX = tmux
    }
  })

  test("process stdout under a host multiplexer tells native, whatever the forwarded keys", async () => {
    const lib = resolveRenderLib()
    const setup = lib.sessionSetupTerminal
    const seen: (boolean | undefined)[] = []
    lib.sessionSetupTerminal = (context, session, options = {}) => {
      seen.push(options.hostMultiplexer)
      return setup.call(lib, context, session, options)
    }
    const sty = process.env.STY
    process.env.STY = "1.pts-0.host"
    try {
      const options = { stdout: process.stdout, remote: true, forwardEnvKeys: ["SSH_CONNECTION"] }
      const { renderer, dispose } = await createTestRenderer({ ...options, clock: new ManualClock() })
      try {
        await renderer.setupTerminal()
      } finally {
        await dispose()
      }
      expect(seen).toEqual([true])
    } finally {
      lib.sessionSetupTerminal = setup
      if (sty === undefined) delete process.env.STY
      else process.env.STY = sty
    }
  })

  test("an unknown mode is rejected", async () => {
    await expect(frame({ synchronizedOutput: "sometimes" as SynchronizedOutput }, false)).rejects.toThrow(TypeError)
  })
})
