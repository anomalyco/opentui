import { afterEach, describe, expect, test } from "bun:test"
import type { NativeSession } from "../NativeSession.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { RecordingWriteStream } from "../testing/test-streams.js"
import type { ProgramStatus } from "../types.js"
import { NativeError } from "../zig.js"

let renderer: TestRenderer | null = null

afterEach(async () => {
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
  return { renderer, stdout }
}

describe("renderer program status", () => {
  test("writes OSC 7501 reports in call order", async () => {
    const { renderer, stdout } = await setup()
    stdout.clear()
    // Native tests pin each encoding rule. These rows pin how TypeScript packs, encodes, and reads fields.
    const reports: Array<[ProgramStatus, string]> = [
      [
        {
          state: "blocked",
          kind: "permission",
          progress: 10,
          id: "eu-west",
          app: "deploy",
          title: "世界",
          message: "Approve deploy to eu-west (production)?",
        },
        "state=blocked:id=eu-west:kind=permission:progress=10:app=deploy:title=5LiW55WM:msg=QXBwcm92ZSBkZXBsb3kgdG8gZXUtd2VzdCAocHJvZHVjdGlvbik/",
      ],
      [Object.assign(Object.create({ id: "build" }), { state: "working", app: undefined }), "state=working:id=build"],
      [{ state: "clear" }, "state=clear"],
    ]
    for (const [status] of reports) expect(renderer.setProgramStatus(status)).toBe(true)
    await renderer.nativeScene.driver.idle()
    expect(stdout.text()).toBe(reports.map(([, body]) => `\x1b]7501;${body}\x1b\\`).join(""))
    // Reports are accepted until the close starts in the microtask after destroy(), then refused.
    renderer.destroy()
    expect(renderer.setProgramStatus({ state: "done" })).toBe(true)
    await Promise.resolve()
    expect(renderer.setProgramStatus({ state: "done" })).toBe(false)
  })

  test("rejects invalid reports without output", async () => {
    const { renderer, stdout } = await setup()
    stdout.clear()
    const invalid: Array<[unknown, ErrorConstructor | typeof NativeError]> = [
      [{ state: "busy" }, TypeError],
      [{ state: ["idle"] }, TypeError],
      [{ state: "blocked", kind: "login" }, TypeError],
      [{ state: "idle", message: 1 }, TypeError],
      [{ state: "working", progress: "40" }, TypeError],
      [{ state: "clear", id: "" }, RangeError],
      [{ state: "working", progress: 1.5 }, RangeError],
      [{ state: "working", progress: -1 }, RangeError],
      // Native code owns the protocol rules; TypeScript only bounds the encoding work.
      [{ state: "working", progress: 101 }, NativeError],
      [{ state: "error", message: "x".repeat(1_000_000) }, NativeError],
    ]
    for (const [status, error] of invalid) {
      expect(() => renderer.setProgramStatus(status as ProgramStatus)).toThrow(error)
    }
    await renderer.nativeScene.driver.idle()
    expect(stdout.text()).toBe("")
    // A failed session refuses, also before the renderer reacts to the failure.
    stdout.emit("error", new Error("terminal gone"))
    expect(renderer.setProgramStatus({ state: "done" })).toBe(false)
  })

  test("returns false when the report cannot be queued", async () => {
    ;({ renderer } = await createTestRenderer({ remote: true }))
    expect(renderer.setProgramStatus({ state: "working" })).toBe(false)
    expect(() => renderer!.setProgramStatus({ state: "idle", id: "a b" })).toThrow(NativeError)
    await renderer.setupTerminal()
    expect(renderer.setProgramStatus({ state: "working" })).toBe(true)
    await renderer.suspend()
    expect(renderer.setProgramStatus({ state: "idle" })).toBe(false)
    await renderer.resume()
    expect(renderer.setProgramStatus({ state: "idle" })).toBe(true)
    const session = (renderer as unknown as { nativeSession: NativeSession }).nativeSession
    // Nothing drains during this synchronous loop, so every size down to one byte is eventually refused.
    for (let size = 1 << 20; size >= 1; size >>= 1) while (session.write(new Uint8Array(size))) {}
    expect(renderer.setProgramStatus({ state: "done" })).toBe(false)
  })

  test("queries support at startup and detects the reply without key input", async () => {
    const { renderer, stdout } = await setup()
    expect(stdout.text()).toContain("\x1b]7501;?\x1b\\")
    expect(renderer.capabilities?.program_status).toBe(false)
    const keys: string[] = []
    renderer.keyInput.on("keypress", (key) => keys.push(key.sequence))
    let capabilities = 0
    renderer.on("capabilities", () => capabilities++)

    // libghostty-vt's exact reply (`osc.program_status.query_reply`, ghostty 9cd19b4).
    renderer.stdin.emit(
      "data",
      Buffer.from("\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\"),
    )

    expect(renderer.capabilities?.program_status).toBe(true)
    expect(capabilities).toBe(1)
    expect(keys).toEqual([])
  })
})
