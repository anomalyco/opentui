import { Duplex } from "node:stream"
import { afterEach, expect, spyOn, test } from "bun:test"
import { CliRenderEvents, TextRenderable } from "@opentui/core"
import type { ServerChannel } from "ssh2"
import { createSessionBridge, DEFAULT_PTY, type PtyInfo, type SessionBridge } from "../../bridge.js"
import { createSafeInvoke } from "../../safe.js"
import type { Session } from "../../types.js"
import { waitFor } from "../support.js"

class Channel extends Duplex {
  chunks: Buffer[] = []
  complete: ((error?: Error | null) => void) | undefined
  automatic = false
  closeCalls = 0
  constructor() {
    super({ highWaterMark: 1 })
  }
  _read() {}
  _write(bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.from(bytes))
    if (this.automatic) callback()
    else this.complete = callback
  }
  release(error?: Error) {
    const callback = this.complete
    this.complete = undefined
    callback?.(error)
  }
  exit() {}
  close() {
    this.closeCalls++
    this.destroy()
  }
}

const bridges: SessionBridge[] = []
const channels: Channel[] = []
afterEach(async () => {
  for (const channel of channels) {
    channel.automatic = true
    channel.release()
  }
  await Promise.all(bridges.splice(0).map((bridge) => bridge.destroy()))
  for (const channel of channels.splice(0)) channel.destroy()
})

function setup(pty: PtyInfo = DEFAULT_PTY, channel = new Channel()) {
  const bridge = createSessionBridge(channel as unknown as ServerChannel, {
    pty,
    identity: { method: "none", username: "native" },
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    safe: createSafeInvoke(() => {}),
  })
  bridges.push(bridge)
  channels.push(channel)
  return { bridge, channel }
}

test("oversized strings reject before encoding or retaining output", async () => {
  const { bridge, channel } = setup()
  for (const value of ["x".repeat(8_323_073), "x".repeat(8_388_608), "\u0800".repeat(2_774_358)]) {
    expect(() => bridge.session.write(value)).toThrow(RangeError)
  }
  await bridge.destroy()
  expect(channel.chunks).toEqual([])
})

test("raw output pressure on a slow channel delays frames until the channel drains", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const { bridge, channel } = setup({ term: "xterm-256color", cols: 500, rows: 200, hasPty: true })
    channel.automatic = true
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
    channel.automatic = false
    for (let write = 0; write < 126; write++) session!.write(Buffer.alloc(65_536, 0x78))
    const rows = Array.from({ length: 200 }, (_, row) => String.fromCharCode(65 + (row % 26)).repeat(500))
    renderer.root.add(new TextRenderable(renderer, { content: rows.join("\n"), fg: "#ff0000", bg: "#0000ff" }))
    renderer.start()
    await waitFor(() => channel.complete !== undefined, 8000, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(frames).toBe(0)

    channel.automatic = true
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
