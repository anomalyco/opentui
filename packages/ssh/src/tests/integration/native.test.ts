import { createRequire } from "node:module"
import type { Duplex } from "node:stream"
import { expect, spyOn, test } from "bun:test"
import { NativeSession } from "@opentui/core"
import type { ClientChannel } from "ssh2"
import { createServer } from "../../index.js"
import { createHarness, deferred, HOST_KEY, waitFor } from "../support.js"

const { track, openShellOn } = createHarness()

test.each(["connection", "shell", "local"] as const)(
  "native close releases a paused shell and capacity (%s)",
  async (close) => {
    const shellOnly = close === "shell"
    const middleware = deferred<void>()
    let end: (() => void) | undefined
    let paused: Duplex | undefined
    let driver: NativeSession | undefined
    let closes = 0
    let handlers = 0
    let arrivals = 0
    const errors: unknown[] = []
    const write = NativeSession.prototype.write
    const capture = spyOn(NativeSession.prototype, "write").mockImplementation(function (this: NativeSession, bytes) {
      if (Buffer.from(bytes).toString() === "before blocked middleware") driver = this
      return write.call(this, bytes)
    })
    const prototype = createRequire(import.meta.url)("ssh2/lib/Channel.js").Channel.prototype as Duplex
    const pause = prototype.pause
    const capturePause = spyOn(prototype, "pause").mockImplementation(function (this: Duplex) {
      if ((this as Duplex & { server?: boolean }).server) paused = this
      return pause.call(this)
    })
    const server = track(
      createServer({
        startupBanner: false,
        hostKey: { pem: HOST_KEY },
        limits: { session: { global: 1 } },
        onError: (error) => errors.push(error),
      })
        .use(async (session, next) => {
          if (++arrivals > 1) session.deny("capacity available")
          end = () => session.end()
          session.write("before blocked middleware")
          // Exhaust ssh2's initial window and its adjustment before unread output fills the peer's buffer.
          if (shellOnly) session.write(Buffer.alloc(3_500_000))
          session.onClose(() => {
            closes++
          })
          await middleware.promise
          return next()
        })
        .serve(() => {
          handlers++
        }),
    )
    try {
      const { port } = await server.listen(0)
      const { conn, stream } = await openShellOn(port, "blocked")
      let clientClosed = false
      conn.on("close", () => {
        clientClosed = true
      })
      if (!shellOnly) stream.resume()
      stream.write(Buffer.alloc(262_144))
      await waitFor(() => driver !== undefined, 1000)
      expect(errors).toEqual([])
      await waitFor(() => paused !== undefined, 1000)
      const channel = paused as Duplex & { outgoing: { window: number } }
      let channelCloses = 0
      channel.on("close", () => {
        channelCloses++
      })
      await waitFor(() => channel.readableLength > 0, 1000)
      if (shellOnly) {
        await waitFor(() => channel.outgoing.window === 0 && channel.writableLength > 0, 1000)
      }
      expect(driver?.usesOutput(channel)).toBe(true)
      expect(driver?.disposed).toBe(false)
      if (close === "local") end!()
      else if (shellOnly) stream.close()
      else conn.destroy()
      await waitFor(() => closes === 1 && driver?.disposed === true)
      expect(channel.listenerCount("data")).toBe(0)
      expect(handlers).toBe(0)
      await waitFor(() => channelCloses === 1, 1000)
      if (close === "local") await driver!.closed
      expect(channel.listenerCount("error")).toBe(0)
      expect(channel.listenerCount("drain")).toBe(0)
      if (shellOnly) {
        expect(clientClosed).toBe(false)
        expect(channel.writableLength).toBeGreaterThan(0)
      }
      const probe =
        close !== "connection"
          ? {
              stream: await new Promise<ClientChannel>((resolve, reject) => {
                conn.shell((error, stream) => (error ? reject(error) : resolve(stream)))
              }),
            }
          : await openShellOn(port, "probe")
      let output = ""
      probe.stream.on("data", (bytes: Buffer) => {
        output += bytes.toString()
      })
      await new Promise<void>((resolve) => probe.stream.on("close", resolve))
      expect(output).toBe("capacity available\r\n")
      if (close !== "connection") expect(clientClosed).toBe(false)
      await server.close()
      expect(closes).toBe(1)
      expect(errors).toEqual([])
    } finally {
      middleware.resolve()
      await server.close()
      capture.mockRestore()
      capturePause.mockRestore()
    }
  },
)
