import { createRequire } from "node:module"
import type { Duplex } from "node:stream"
import { expect, test } from "bun:test"
import { NativeSession, TextRenderable } from "@opentui/core"
import { Client, type ClientChannel } from "ssh2"
import { createServer } from "../../index.js"
import type { Session } from "../../types.js"
import { createHarness, deferred, HOST_KEY, SHELL_PTY, sleep, waitFor } from "../support.js"

const { mkServer, openShell, openShellOn, conns, track } = createHarness()

test("idleTimeout reaps a session that sends no input", async () => {
  const server = mkServer(
    (s) => {
      s.renderer.root.add(new TextRenderable(s.renderer, { content: "idle" }))
    },
    { idleTimeout: 150 },
  )

  const { stream } = await openShell(server)
  // ssh2's client surfaces a server-reaped shell as 'exit'; it does not emit
  // channel 'close' on its own.
  const reaped = deferred<void>()
  stream.on("exit", () => reaped.resolve())

  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000))
  const result = await Promise.race([reaped.promise.then(() => "reaped" as const), timeout])
  expect(result).toBe("reaped")
})

test("without idleTimeout an idle session stays open", async () => {
  const server = mkServer((s) => {
    s.renderer.root.add(new TextRenderable(s.renderer, { content: "idle" }))
  })

  const { stream } = await openShell(server)
  let reaped = false
  stream.on("exit", () => {
    reaped = true
  })

  await sleep(400)
  expect(reaped).toBe(false)
})

test("idleTimeout reaps only the idle session; active sessions and the listener survive", async () => {
  const server = mkServer(
    (s) => {
      s.renderer.root.add(new TextRenderable(s.renderer, { content: "multi" }))
    },
    { idleTimeout: 250 },
  )
  const { port } = await server.listen(0)

  const idle = await openShellOn(port)
  const active = await openShellOn(port)
  let idleReaped = false
  let activeReaped = false
  idle.stream.on("exit", () => {
    idleReaped = true
  })
  active.stream.on("exit", () => {
    activeReaped = true
  })

  // Keep `active` busy: a keystroke every 80ms re-arms its idle timer (< 250ms).
  const keepalive = setInterval(() => active.stream.write("x"), 80)
  await sleep(700)
  clearInterval(keepalive)

  expect(idleReaped).toBe(true)
  expect(activeReaped).toBe(false)

  // Listener still up: a brand-new client can still connect and get a shell.
  const late = await openShellOn(port)
  expect(late.stream).toBeDefined()
})

test("maxTimeout reaps an active session after its absolute lifetime", async () => {
  const server = mkServer(
    (s) => {
      s.renderer.root.add(new TextRenderable(s.renderer, { content: "max" }))
    },
    { maxTimeout: 250 },
  )

  const { stream } = await openShell(server)
  let reaped = false
  stream.on("exit", () => {
    reaped = true
  })
  const keepalive = setInterval(() => stream.write("x"), 50)
  await sleep(700)
  clearInterval(keepalive)

  expect(reaped).toBe(true)
})

test("close() destroys a live session and fires onClose", async () => {
  const closed = deferred<void>()
  const server = mkServer((s) => {
    s.renderer.root.add(new TextRenderable(s.renderer, { content: "live" }))
    s.onClose(() => {
      closed.resolve()
    })
  })

  await openShell(server)
  // Let the shell finish wiring up server-side before shutting down.
  await sleep(100)
  await server.close()
  await closed.promise // resolves only if onClose fired
  expect(true).toBe(true)
})

test("two shells on one connection have independent lifecycles", async () => {
  // Each shell on a connection gets its own bridge; connection.ts captures it in a
  // `const` so one shell's teardown can't untrack/close the other. Open two on a
  // single connection, close the first, and the second must stay fully live.
  const sessions: Session[] = []
  let closeCount = 0
  const server = mkServer(
    (s) => {
      sessions.push(s)
      s.onClose(() => closeCount++)
    },
    { limits: { session: { perConnection: 2 } } },
  )
  const { port } = await server.listen(0)

  const conn = await new Promise<Client>((resolve, reject) => {
    const c = new Client()
    conns.push(c)
    c.on("ready", () => resolve(c))
      .on("error", reject)
      .connect({ host: "127.0.0.1", port, username: "guest" })
  })
  const openOne = () =>
    new Promise<ClientChannel>((resolve, reject) => {
      conn.shell(SHELL_PTY, (err, stream) => (err ? reject(err) : resolve(stream)))
    })

  const shellA = await openOne()
  const shellB = await openOne()
  await waitFor(() => sessions.length === 2)
  expect(sessions[0]).not.toBe(sessions[1]) // two distinct sessions, not a shared one

  // The survivor's client must receive a server-side write AFTER the other closes.
  const bReceived = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("survivor shell never received the write")), 4000)
    let buf = ""
    shellB.on("data", (d: Buffer) => {
      buf += d.toString("utf8")
      if (buf.includes("B-ALIVE")) {
        clearTimeout(timer)
        resolve(buf)
      }
    })
  })

  // Close the FIRST shell; only its session should tear down.
  shellA.close()
  await waitFor(() => closeCount === 1)
  await sleep(150) // give any erroneous cross-session teardown a chance to fire
  expect(closeCount).toBe(1) // the second shell is untouched

  sessions[1]!.write("B-ALIVE")
  expect(await bReceived).toContain("B-ALIVE")
}, 15000)

// ssh2 keeps a paused channel open until its readable side ends, even after the shell or connection closes.
test.each(["connection", "shell", "local"] as const)(
  "a paused shell with a full window closed by %s releases its Session and input",
  async (close) => {
    const shellOnly = close === "shell"
    const { Channel } = createRequire(import.meta.url)("ssh2/lib/Channel.js")
    const pause = Channel.prototype.pause
    const write = NativeSession.prototype.write
    const paused = deferred<Duplex & { outgoing: { window: number } }>()
    const middleware = deferred<void>()
    let driver: NativeSession | undefined
    let end: (() => void) | undefined
    let handlers = 0
    let closes = 0
    let arrivals = 0
    let clientClosed = false
    const errors: unknown[] = []
    Channel.prototype.pause = function (this: { server?: boolean }) {
      const result = pause.call(this)
      if (this.server) paused.resolve(this as never)
      return result
    }
    NativeSession.prototype.write = function (this: NativeSession, bytes: Uint8Array) {
      driver = this
      return write.call(this, bytes)
    }
    try {
      const server = track(
        createServer({
          auth: "open",
          startupBanner: false,
          hostKey: { pem: HOST_KEY },
          limits: { session: { global: 1 } },
          onError: (error) => errors.push(error),
        })
          .use(async (session, next) => {
            if (++arrivals > 1) session.deny("CAPACITY")
            end = () => session.end()
            session.write("PAUSED")
            if (shellOnly) session.write(Buffer.alloc(3_500_000))
            session.onClose(() => closes++)
            await middleware.promise
            return next()
          })
          .serve(() => {
            handlers++
          }),
      )
      const { port } = await server.listen(0)
      const client = new Client()
      conns.push(client)
      client.on("close", () => {
        clientClosed = true
      })
      const stream = await new Promise<ClientChannel>((resolve, reject) => {
        client.on("ready", () => client.shell((error, channel) => (error ? reject(error) : resolve(channel))))
        client.on("error", reject)
        client.connect({ host: "127.0.0.1", port, username: "paused" })
      })
      if (!shellOnly) stream.resume()
      stream.write(Buffer.alloc(262_144))
      const channel = await paused.promise
      const channelClosed = new Promise((resolve) => channel.once("close", resolve))
      await waitFor(
        () =>
          channel.readableLength > 0 && (!shellOnly || (channel.outgoing.window === 0 && channel.writableLength > 0)),
        1000,
        5,
      )
      expect(driver?.usesOutput(channel as never)).toBe(true)
      expect(driver?.disposed).toBe(false)

      if (close === "local") end!()
      else if (shellOnly) stream.close()
      else client.destroy()
      await Promise.race([channelClosed, sleep(3000).then(() => Promise.reject(new Error("channel did not close")))])
      expect(driver?.disposed).toBe(true)
      if (close === "local") await driver?.closed
      expect(["data", "error", "drain"].map((event) => channel.listenerCount(event))).toEqual([0, 0, 0])
      expect(handlers).toBe(0)
      if (close !== "connection") {
        // The connection survives; capacity is free again only after the closed shell released it.
        const output = await new Promise<string>((resolve, reject) => {
          client.shell((error, probe) => {
            if (error) return reject(error)
            let data = ""
            probe.on("data", (bytes: Buffer) => (data += bytes.toString()))
            probe.on("close", () => resolve(data))
            probe.on("error", reject)
          })
        })
        expect(output).toBe("CAPACITY\r\n")
        expect(clientClosed).toBe(false)
      }
      await server.close()
      expect(closes).toBe(1)
      expect(errors).toEqual([])
    } finally {
      middleware.resolve()
      Channel.prototype.pause = pause
      NativeSession.prototype.write = write
    }
  },
  15_000,
)
