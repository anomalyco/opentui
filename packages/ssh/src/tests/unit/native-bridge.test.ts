import { Duplex } from "node:stream"
import { afterEach, expect, mock, test } from "bun:test"
import type { ServerChannel } from "ssh2"
import { createSessionBridge, DEFAULT_PTY, type RendererFactory, type SessionBridge } from "../../bridge.js"
import { createSafeInvoke } from "../../safe.js"
import { runSession } from "../../run-session.js"

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

function setup(createRenderer?: RendererFactory, channel = new Channel()) {
  const safe = createSafeInvoke(() => {})
  const bridge = createSessionBridge(channel as unknown as ServerChannel, {
    pty: DEFAULT_PTY,
    identity: { method: "none", username: "native" },
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    safe,
    createRenderer,
  })
  bridges.push(bridge)
  channels.push(channel)
  const handler = mock(() => {})
  return { bridge, channel, handler, start: () => runSession([], handler, bridge, safe) }
}

test("oversized strings reject before encoding or retaining output", async () => {
  const { bridge, channel } = setup()
  for (const value of ["x".repeat(8_323_073), "x".repeat(8_388_608), "\u0800".repeat(2_774_358)]) {
    expect(() => bridge.session.write(value)).toThrow(RangeError)
  }
  await bridge.destroy()
  expect(channel.chunks).toEqual([])
})
