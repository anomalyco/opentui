import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { RecordingWriteStream } from "../testing/test-streams.js"
import type { ProgramResume } from "../types.js"
import { NativeError } from "../zig.js"

// The token, pid, and time of the OSC 7577 specification's examples, whose mac values are the real hashes.
const sender = { token: "dummy-token-replace-me", pid: 74877, time: 1795543200 }
const clear =
  "\x1b]7577;pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93\x1b\\"

let renderer: TestRenderer | null = null

afterEach(async () => {
  setSystemTime()
  renderer?.destroy()
  await renderer?.closed.catch(() => {})
  renderer = null
})

async function setup(): Promise<{ renderer: TestRenderer; stdout: RecordingWriteStream }> {
  const stdout = new RecordingWriteStream(8, 3)
  ;({ renderer } = await createTestRenderer({
    stdout: stdout as unknown as NodeJS.WriteStream,
    bufferedOutput: "stdout",
    remote: true,
    forwardEnvKeys: [],
  }))
  await renderer.setupTerminal()
  await renderer.nativeScene.driver.idle()
  stdout.clear()
  return { renderer, stdout }
}

describe("renderer program resume", () => {
  test("writes OSC 7577 reports in call order", async () => {
    const { renderer, stdout } = await setup()
    // Native tests pin each encoding rule. These rows pin how TypeScript packs and defaults fields.
    const reports: Array<[ProgramResume, string]> = [
      [
        { ...sender, argv: ["lazygit"], cwd: "/home/user/src/project" },
        "\x1b]7577;pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1\x1b\\",
      ],
      [
        { ...sender, pid: 90412, argv: ["resume-wrap", "ssh", "devbox"] },
        "\x1b]7577;pid=90412:time=1795543200:argv=cmVzdW1lLXdyYXA=,c3No,ZGV2Ym94:mac=e76149d0ba54a83570ffab0583867dacdfa23928ba9d18604f0badea88b62b65\x1b\\",
      ],
      [{ ...sender, clear: true }, clear],
      // A command the protocol can't carry clears: a lone surrogate has no UTF-8 encoding, and native code rejects
      // a relative cwd.
      [{ ...sender, argv: ["nvim", "\ud800"] }, clear],
      [{ ...sender, argv: ["nvim"], cwd: "project" }, clear],
      // An empty command clears and leaves out its cwd.
      [{ ...sender, argv: [], cwd: "/home/user/src/project" }, clear],
    ]
    for (const [report] of reports) expect(renderer.setProgramResume(report)).toBe(true)
    await renderer.nativeScene.driver.idle()
    expect(stdout.text()).toBe(reports.map(([, sequence]) => sequence).join(""))

    stdout.clear()
    setSystemTime(new Date(1795543200_500))
    expect(renderer.setProgramResume({ token: sender.token, clear: true })).toBe(true)
    await renderer.nativeScene.driver.idle()
    expect(stdout.text()).toStartWith(`\x1b]7577;pid=${process.pid}:time=1795543200:clear=1:mac=`)
  })

  test("rejects invalid reports without output", async () => {
    const { renderer, stdout } = await setup()
    const invalid: Array<[unknown, ErrorConstructor | typeof NativeError]> = [
      [{ argv: ["nvim"] }, TypeError],
      [{ token: sender.token }, TypeError],
      [{ token: sender.token, clear: false }, TypeError],
      [{ token: sender.token, argv: "nvim" }, TypeError],
      [{ token: sender.token, argv: ["nvim", 1] }, TypeError],
      [{ token: sender.token, argv: ["nvim"], cwd: 1 }, TypeError],
      [{ token: sender.token, clear: true, cwd: "/home" }, TypeError],
      [{ token: sender.token, clear: true, pid: -1 }, RangeError],
      [{ token: sender.token, clear: true, time: 1.5 }, RangeError],
      // Native code owns the protocol rules; TypeScript only bounds the encoding work.
      [{ token: "short", clear: true }, NativeError],
      [{ token: sender.token, clear: true, pid: 0 }, NativeError],
      [{ token: sender.token.repeat(1_000_000), clear: true }, NativeError],
    ]
    for (const [report, error] of invalid) {
      expect(() => renderer.setProgramResume(report as ProgramResume)).toThrow(error)
    }
    await renderer.nativeScene.driver.idle()
    expect(stdout.text()).toBe("")
  })

  test("returns false when the report cannot be queued", async () => {
    ;({ renderer } = await createTestRenderer({ remote: true }))
    const report = { ...sender, clear: true as const }
    expect(renderer.setProgramResume(report)).toBe(false)
    await renderer.setupTerminal()
    expect(renderer.setProgramResume(report)).toBe(true)
    await renderer.suspend()
    expect(renderer.setProgramResume(report)).toBe(false)
    await renderer.resume()
    expect(renderer.setProgramResume(report)).toBe(true)
    renderer.destroy()
    await Promise.resolve()
    expect(renderer.setProgramResume(report)).toBe(false)
  })
})
