import { afterEach, expect, spyOn, test } from "bun:test"
import { CliRenderEvents, TextRenderable } from "@opentui/core"
import type { ServerChannel } from "ssh2"
import { createSessionBridge, DEFAULT_PTY, type PtyInfo, type SessionBridge } from "../../bridge.js"
import { DenyError, OutputPressureError } from "../../errors.js"
import { createSafeInvoke } from "../../safe.js"
import type { Session } from "../../types.js"
import { TestChannel, waitFor } from "../support.js"

const bridges: SessionBridge[] = []
const channels: TestChannel[] = []
afterEach(async () => {
  for (const channel of channels) channel.release()
  await Promise.all(bridges.splice(0).map((bridge) => bridge.destroy()))
  for (const channel of channels.splice(0)) channel.destroy()
})

function setup(pty: PtyInfo = DEFAULT_PTY) {
  const channel = new TestChannel()
  const reported: unknown[] = []
  const bridge = createSessionBridge(channel as unknown as ServerChannel, {
    pty,
    identity: { method: "none", username: "native" },
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    safe: createSafeInvoke((error) => reported.push(error)),
  })
  bridges.push(bridge)
  channels.push(channel)
  return { bridge, channel, reported }
}

test("oversized strings reject before encoding or retaining output", async () => {
  const { bridge, channel } = setup()
  for (const value of ["x".repeat(8_323_073), "x".repeat(8_388_608), "\u0800".repeat(2_774_358)]) {
    expect(() => bridge.session.write(value)).toThrow(RangeError)
  }
  await bridge.destroy()
  expect(channel.writes).toEqual([])
})

interface CloseCase {
  name: string
  /** Runs instead of `deny(reason)`. */
  act?: (bridge: SessionBridge) => void
  reason?: string
  output: string
  reported: ErrorConstructor[]
}

test.each<CloseCase>([
  {
    name: "a write after close is a no-op",
    act: (bridge) => {
      void bridge.destroy()
      bridge.session.write("late")
    },
    output: "",
    reported: [],
  },
  { name: "deny without a reason closes without output", output: "", reported: [] },
  { name: "deny ends its reason with CRLF", reason: "go away", output: "go away\r\n", reported: [] },
  { name: "deny keeps a reason's own line ending", reason: "bye\n", output: "bye\n", reported: [] },
  {
    name: "deny reports a reason over the output limit and still closes",
    reason: "x".repeat(8_323_072),
    output: "",
    reported: [RangeError],
  },
])("$name", async ({ act, reason, output, reported: expected }) => {
  const { bridge, channel, reported } = setup()
  if (act) act(bridge)
  else expect(() => bridge.session.deny(reason)).toThrow(DenyError)
  expect(bridge.closed).toBe(true)
  await bridge.destroy()
  expect(channel.text()).toBe(output)
  expect(channel.exits).toEqual([0])
  expect(reported.map((error) => (error as Error).constructor)).toEqual(expected)
})

test("queue pressure rejects a whole write with OutputPressureError", async () => {
  const { bridge, channel } = setup()
  const chunk = Buffer.alloc(65_536, 0x61)
  channel.hold()
  let accepted = 0
  let pressure: unknown
  while (pressure === undefined && accepted < 256) {
    try {
      bridge.session.write(chunk)
      accepted++
    } catch (error) {
      pressure = error
    }
  }
  expect(pressure).toBeInstanceOf(OutputPressureError)
  expect((pressure as OutputPressureError).code).toBe("OUTPUT_PRESSURE")
  channel.release()
  await bridge.destroy()
  expect(Buffer.concat(channel.writes).length).toBe(accepted * chunk.length)
})

test("raw output pressure on a slow channel delays frames until the channel drains", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const { bridge, channel } = setup({ term: "xterm-256color", cols: 500, rows: 200, hasPty: true })
    let session: Session | undefined
    const entered = bridge.enterApp((value) => {
      session = value
    })
    await waitFor(() => session !== undefined, 8000, 1)
    const renderer = session!.renderer
    let frames = 0
    renderer.on(CliRenderEvents.FRAME, () => frames++)
    await renderer.idle()

    // Raw writes fill most of the Session queue while the client window is closed.
    channel.hold()
    for (let write = 0; write < 126; write++) session!.write(Buffer.alloc(65_536, 0x78))
    const rows = Array.from({ length: 200 }, (_, row) => String.fromCharCode(65 + (row % 26)).repeat(500))
    renderer.root.add(new TextRenderable(renderer, { content: rows.join("\n"), fg: "#ff0000", bg: "#0000ff" }))
    renderer.start()
    await waitFor(() => channel.pendingWrite, 8000, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(frames).toBe(0)

    channel.release()
    await waitFor(() => frames >= 3)
    expect(renderer.isRunning).toBe(true)
    expect(errors).not.toHaveBeenCalled()
    await bridge.destroy()
    await entered
  } finally {
    errors.mockRestore()
  }
}, 20_000)
